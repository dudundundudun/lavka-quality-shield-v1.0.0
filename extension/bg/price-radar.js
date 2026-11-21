/**
 * Lavka Quality Shield — Price Radar, 16-Store Matrix, Lavka Card Parser & Circuit Breaker
 * Модуль радара цен, истории цен, парсера карточки Лавки, внешних цен 16 сетей и circuit breaker.
 */
(function (root) {
  'use strict';

  function getBgDeps() {
    return root.LQS_BG_DEPS || {};
  }

  const {
    normalizeTitleKey,
    parseVolumeOrWeightGrams,
    computePricePerKgOrLiter,
    isSearchResultMatchingProduct,
    decodeHtmlEntities
  } = root.LQS_MATCHER;

  const { STORAGE_KEYS, LIMITS } = root.LQS_CONFIG;
  const {
    fetchWithTimeout,
    getSettings,
    buildFullProductSearchQuery,
    buildDirectStoreSearchLinks
  } = root.LQS_UTILS;

  const PRICE_DB_KEY = STORAGE_KEYS.PRICE_DB;
  const WATCHLIST_KEY = STORAGE_KEYS.WATCHLIST;
  const EXT_STORE_DB_KEY = STORAGE_KEYS.EXT_STORE_DB;
  const CIRCUIT_BREAKER_KEY = STORAGE_KEYS.CIRCUIT_BREAKER || 'lqs_circuit_breaker_v1';
  const RADAR_SCAN_LOG_KEY = STORAGE_KEYS.RADAR_SCAN_LOG || 'lqs_radar_scan_log_v1';
  const PRODUCT_LINKS_KEY = STORAGE_KEYS.PRODUCT_LINKS || 'lqs_product_links_v1';
  const REJECTED_MATCHES_KEY = STORAGE_KEYS.REJECTED_MATCHES || 'lqs_rejected_matches_v1';
  const MAX_LOCAL_PRICE_DB_ITEMS = LIMITS.MAX_LOCAL_PRICE_DB_ITEMS;
  const MAX_LOCAL_EXT_STORE_OFFERS = LIMITS.MAX_LOCAL_EXT_STORE_OFFERS || 3000;
  const AUTO_RADAR_TTL_MS = LIMITS.AUTO_RADAR_TTL_MS || (24 * 60 * 60 * 1000);
  const AUTO_RADAR_COOLDOWN_MS = LIMITS.AUTO_RADAR_COOLDOWN_MS || (15 * 1000);

  // Ленивая подгрузка эталонных seed-офферов Магнита из extension/data/seed-magnit.json
  let magnitSeedCache = null;

  async function getMagnitSeedOffers() {
    if (Array.isArray(magnitSeedCache)) return magnitSeedCache;
    try {
      const url = chrome.runtime.getURL('data/seed-magnit.json');
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        const seededAt = data?.seededAt || '';
        const raw = Array.isArray(data?.offers) ? data.offers : [];
        magnitSeedCache = raw.map((o) => ({ ...o, isSeedFallback: true, seededAt }));
        return magnitSeedCache;
      }
    } catch (err) {
      console.warn('[LQS PriceRadar] Failed to load Magnit seed offers:', err?.message || err);
    }
    magnitSeedCache = [];
    return magnitSeedCache;
  }

  // Per-provider / per-store Circuit Breaker (3 подряд ошибки или капча -> пауза 15 минут)
  const CIRCUIT_BREAKER_THRESHOLD = 3;
  const CIRCUIT_BREAKER_COOLDOWN_MS = 15 * 60 * 1000;
  const RADAR_16_STORES_CATALOG = [
    { name: 'Магнит', provider: 'magnit_dom', mode: 'DOM + Seed' },
    { name: 'ВкусВилл', provider: 'vkusvill', mode: 'Прямой + DDG' },
    { name: 'Пятёрочка', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Перекрёсток', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Ашан', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'МЕТРО', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Глобус', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Лента', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Магнолия', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Дикси', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Чижик', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'О’КЕЙ', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Азбука Вкуса', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Самокат', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Ozon', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Купер', provider: 'duckduckgo', mode: 'DDG Радар' }
  ];

  async function getCircuitBreakerState() {
    return new Promise((resolve) => {
      chrome.storage.local.get([CIRCUIT_BREAKER_KEY], (res) => {
        resolve(res && res[CIRCUIT_BREAKER_KEY] && typeof res[CIRCUIT_BREAKER_KEY] === 'object' ? { ...res[CIRCUIT_BREAKER_KEY] } : {});
      });
    });
  }

  async function saveCircuitBreakerState(state) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [CIRCUIT_BREAKER_KEY]: state }, () => resolve(state));
    });
  }

  function isCaptchaOrBlockHtml(html) {
    if (!html || typeof html !== 'string') return false;
    return /(captcha|showcaptcha|smartcaptcha|ddos-guard|cloudflare|anomaly-modal|are you a robot|вы не робот|подозрительный трафик)/i.test(
      html.slice(0, 6000)
    );
  }

  async function isCircuitOpen(providerKey) {
    const state = await getCircuitBreakerState();
    const entry = state[providerKey];
    if (!entry || !entry.openUntil) return false;
    if (Date.now() < entry.openUntil) return true;
    // Cooldown expired -> half-open reset
    entry.openUntil = 0;
    entry.failures = 0;
    state[providerKey] = entry;
    await saveCircuitBreakerState(state);
    return false;
  }

  async function recordCircuitSuccess(providerKey) {
    const state = await getCircuitBreakerState();
    state[providerKey] = {
      failures: 0,
      openUntil: 0,
      lastReason: '',
      lastOkAt: new Date().toISOString()
    };
    await saveCircuitBreakerState(state);
  }

  async function recordCircuitFailure(providerKey, reason = 'error', immediateOpen = false) {
    const state = await getCircuitBreakerState();
    const prev = state[providerKey] || { failures: 0, openUntil: 0, lastOkAt: null };
    const failures = immediateOpen ? CIRCUIT_BREAKER_THRESHOLD : (Number(prev.failures || 0) + 1);
    const openUntil = failures >= CIRCUIT_BREAKER_THRESHOLD ? Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS : 0;
    state[providerKey] = {
      ...prev,
      failures,
      openUntil,
      lastReason: String(reason || 'error').slice(0, 80),
      lastFailAt: new Date().toISOString()
    };
    await saveCircuitBreakerState(state);
  }

  async function resetCircuitBreakers() {
    await saveCircuitBreakerState({});
    return await getRadar16StoresStatus();
  }

  async function getRadar16StoresStatus() {
    const cb = await getCircuitBreakerState();
    const extOffers = await getExternalStoreOffersList();
    const now = Date.now();

    const liveCountsByStore = {};
    for (const o of extOffers) {
      if (!o || !o.store || o.isSeedFallback) continue;
      liveCountsByStore[o.store] = (liveCountsByStore[o.store] || 0) + 1;
    }

    const formatProvider = (key, label) => {
      const e = cb[key] || { failures: 0, openUntil: 0, lastOkAt: null, lastReason: '' };
      const pausedMs = e.openUntil && e.openUntil > now ? e.openUntil - now : 0;
      return {
        key,
        label,
        status: pausedMs > 0 ? 'PAUSED' : (e.failures > 0 ? 'WARN' : 'OK'),
        failures: Number(e.failures || 0),
        pausedMin: pausedMs > 0 ? Math.ceil(pausedMs / 60000) : 0,
        lastReason: e.lastReason || '',
        lastOkAt: e.lastOkAt || null
      };
    };

    const providers = [
      formatProvider('duckduckgo', 'DuckDuckGo (14 сетей)'),
      formatProvider('vkusvill', 'ВкусВилл (прямой)'),
      formatProvider('magnit_dom', 'Магнит (DOM-парсер)')
    ];
    const provMap = Object.fromEntries(providers.map((p) => [p.key, p]));

    const stores = RADAR_16_STORES_CATALOG.map((s) => {
      const p = provMap[s.provider] || { status: 'OK', pausedMin: 0 };
      return {
        name: s.name,
        mode: s.mode,
        provider: s.provider,
        status: p.status,
        pausedMin: p.pausedMin,
        cachedOffers: liveCountsByStore[s.name] || 0
      };
    });

    return {
      ok: true,
      activeKeepAliveTasks: getBgDeps().getSwKeepAliveActiveTasks ? getBgDeps().getSwKeepAliveActiveTasks() : 0,
      providers,
      stores
    };
  }

  async function getLocalPriceDb() {
    return new Promise((resolve) => {
      chrome.storage.local.get([PRICE_DB_KEY], (res) => {
        resolve(res && res[PRICE_DB_KEY] && typeof res[PRICE_DB_KEY] === 'object' ? res[PRICE_DB_KEY] : {});
      });
    });
  }

  function findPriceEntryInDb(db, slug, title, imageKey = null) {
    if (!db) return null;
    const cleanSlug = String(slug || '').trim().toLowerCase();
    if (cleanSlug && db[cleanSlug]) return db[cleanSlug];
    if (imageKey) {
      const byImg = Object.values(db).find((e) => e && e.imageKey && e.imageKey === imageKey);
      if (byImg) return byImg;
    }
    const normTitle = normalizeTitleKey(title);
    if (normTitle && normTitle.length >= 4) {
      return Object.values(db).find((e) => e && normalizeTitleKey(e.title) === normTitle) || null;
    }
    return null;
  }

  function sanitizeCompetitorOffersForProduct(offers, productTitle, productAmount = '', targetPrice = null) {
    if (!Array.isArray(offers) || offers.length === 0) return [];
    if (!productTitle) return offers;
    const tPrice = Number(targetPrice) > 0 ? Number(targetPrice) : null;
    return offers.filter((o) => {
      if (!o) return false;
      const cPrice = Number(o.price) > 0 ? Number(o.price) : null;
      const opts = { requireVolume: true };
      if (tPrice && cPrice) {
        opts.targetPrice = tPrice;
        opts.candidatePrice = cPrice;
      }
      const check = isSearchResultMatchingProduct(o.title || '', o.amount || '', productTitle, productAmount, opts);
      return check.isSameProduct && check.isSameVolume;
    });
  }

  function mergePriceRecordIntoEntry(existing, item, accountId, nowIso) {
    const slug = String(item.slug || '').trim().toLowerCase();
    const acc = String(accountId || 'Аккаунт #1').trim();
    const price = Number(item.price) || 0;
    const oldPrice = item.oldPrice ? Number(item.oldPrice) : null;
    const imageKey = item.imageKey || existing?.imageKey || null;

    // ЗАЩИТА ОТ УРЕЗАННЫХ НАЗВАНИЙ ИЗ КОРЗИНЫ:
    // Если в базе уже сохранено эталонное полное название из оригинальной карточки товара (`isCanonicalCardTitle: true`),
    // то короткое название из корзины (`isCanonicalCardTitle !== true`) НИКОГДА не перезаписывает его!
    let effectiveTitle = existing?.title || item.title || slug;
    let isCanonicalCardTitle = Boolean(existing?.isCanonicalCardTitle || item.isCanonicalCardTitle);

    if (item.title) {
      if (item.isCanonicalCardTitle) {
        effectiveTitle = item.title;
        isCanonicalCardTitle = true;
      } else if (!existing?.title) {
        effectiveTitle = item.title;
      } else if (!existing?.isCanonicalCardTitle && String(item.title).length > String(existing.title).length) {
        effectiveTitle = item.title;
      }
    }

    const effectiveAmount =
      (item.isCanonicalCardTitle && item.amount) ? item.amount : (existing?.amount || item.amount || '');
    const effectiveBrand = item.brand || existing?.brand || '';

    const rawOffers =
      Array.isArray(item.competitorOffers) && item.competitorOffers.length > 0
        ? item.competitorOffers
        : (Array.isArray(existing?.competitorOffers) ? existing.competitorOffers : []);
    const compOffers = sanitizeCompetitorOffersForProduct(rawOffers, effectiveTitle, effectiveAmount, price || existing?.lastPrice || null);

    let compMin = item.competitorMinPrice ? Number(item.competitorMinPrice) : null;
    let compSum = item.competitorSummary || null;
    if (!compMin && compOffers.length > 0) {
      const priced = compOffers.filter((o) => o.price && o.price > 0);
      if (priced.length > 0) {
        compMin = Math.min(...priced.map((o) => o.price));
        compSum = priced.slice(0, 3).map((o) => `${o.store}: ~${o.price} ₽`).join(', ');
      }
    }

    const entry = existing || {
      slug,
      title: effectiveTitle,
      cleanTitle: normalizeTitleKey(effectiveTitle),
      isCanonicalCardTitle,
      brand: effectiveBrand,
      imageKey,
      amount: effectiveAmount,
      minPrice: price,
      maxPrice: price,
      avgPrice: price,
      lastPrice: price,
      competitorMinPrice: null,
      competitorSummary: null,
      competitorOffers: [],
      accounts: {},
      history: [],
      updatedAt: nowIso
    };

    entry.title = effectiveTitle;
    entry.cleanTitle = normalizeTitleKey(effectiveTitle);
    entry.isCanonicalCardTitle = isCanonicalCardTitle;
    if (effectiveBrand) entry.brand = effectiveBrand;
    if (imageKey) entry.imageKey = imageKey;
    if (effectiveAmount) entry.amount = effectiveAmount;

    if (entry.accounts && entry.accounts['Гость (без куки)']) {
      delete entry.accounts['Гость (без куки)'];
    }
    if ('guestPrice' in entry) delete entry.guestPrice;
    entry.competitorMinPrice = compMin && compMin > 0 ? Math.round(compMin) : null;
    entry.competitorSummary = compSum || null;
    entry.competitorOffers = compOffers;

    if (price > 0) {
      const rounded = Math.round(price);
      entry.lastPrice = rounded;
      entry.accounts[acc] = {
        price: rounded,
        oldPrice: oldPrice ? Math.round(oldPrice) : null,
        updatedAt: nowIso
      };
      const lastHist = entry.history[0];
      const nowDay = String(nowIso || '').slice(0, 10);
      const lastDay = lastHist && lastHist.ts ? String(lastHist.ts).slice(0, 10) : '';
      if (!lastHist || lastHist.price !== rounded || lastHist.accountId !== acc || lastDay !== nowDay) {
        entry.history.unshift({
          price: rounded,
          oldPrice: oldPrice ? Math.round(oldPrice) : null,
          accountId: acc,
          ts: nowIso
        });
        if (entry.history.length > 120) entry.history.length = 120;
      }
    }

    const allPrices = [];
    entry.history.forEach((h) => {
      if (h && h.price > 0) allPrices.push(Number(h.price));
    });
    Object.values(entry.accounts || {}).forEach((a) => {
      if (a && a.price > 0) allPrices.push(Number(a.price));
    });

    if (allPrices.length > 0) {
      entry.minPrice = Math.round(Math.min(...allPrices));
      entry.maxPrice = Math.round(Math.max(...allPrices));
      entry.avgPrice = Math.round(allPrices.reduce((s, v) => s + v, 0) / allPrices.length);
    }
    entry.updatedAt = nowIso;
    return entry;
  }

  async function recordPricesBatch(accountId, items) {
    if (!Array.isArray(items) || items.length === 0) return {};
    const settings = await getSettings();
    const acc = accountId || settings.lavkaAccountLabel || 'Аккаунт #1';
    const db = await getLocalPriceDb();
    const nowIso = new Date().toISOString();
    const updatedSummaries = {};

    for (const rawItem of items) {
      if (!rawItem || !rawItem.slug) continue;
      const slug = String(rawItem.slug).trim().toLowerCase();
      const existing = findPriceEntryInDb(db, slug, rawItem.title, rawItem.imageKey);
      const merged = mergePriceRecordIntoEntry(existing, rawItem, acc, nowIso);
      merged.slug = slug;
      db[slug] = merged;
      updatedSummaries[slug] = merged;

      // Синхронизируем парные записи (SEO-slug <-> HEX-ID) по imageKey или по полному совпадению названия
      const normTitle = normalizeTitleKey(merged.title);
      for (const [k, v] of Object.entries(db)) {
        if (k === slug || !v) continue;
        const sameImg = merged.imageKey && v.imageKey && merged.imageKey === v.imageKey;
        const sameTitle = normTitle && normTitle.length >= 4 && normalizeTitleKey(v.title) === normTitle;
        if (sameImg || sameTitle) {
          db[k] = { ...merged, slug: k };
        }
      }
    }

    const keys = Object.keys(db);
    if (keys.length > MAX_LOCAL_PRICE_DB_ITEMS) {
      keys
        .sort((a, b) => String(db[a]?.updatedAt || '').localeCompare(String(db[b]?.updatedAt || '')))
        .slice(0, keys.length - MAX_LOCAL_PRICE_DB_ITEMS)
        .forEach((k) => delete db[k]);
    }

    await new Promise((resolve) => {
      chrome.storage.local.set({ [PRICE_DB_KEY]: db }, resolve);
    });

    const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
    if (backendUrl && Date.now() > (getBgDeps().getBackendOfflineUntilTs?.() || 0)) {
      try {
        const resp = await fetchWithTimeout(
          `${backendUrl}/api/price/record`,
          {
            method: 'POST',
            headers: await getBgDeps().getBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ accountId: acc, items })
          },
          1800
        );
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.summaries) {
            for (const [sKey, sVal] of Object.entries(data.summaries)) {
              const cur = db[sKey];
              // Сохраняем эталонное название из карточки товара!
              const bestTitle = cur?.isCanonicalCardTitle ? cur.title : (sVal.title || cur?.title);
              db[sKey] = {
                ...cur,
                ...sVal,
                title: bestTitle,
                isCanonicalCardTitle: Boolean(cur?.isCanonicalCardTitle)
              };
              updatedSummaries[sKey] = db[sKey];
            }
            chrome.storage.local.set({ [PRICE_DB_KEY]: db });
          }
        }
      } catch (err) {
        console.warn('[LQS PriceRadar] Backend /api/price/record failed:', err?.message || err);
        getBgDeps().setBackendOfflineUntilTs?.(Date.now() + 10000);
      }
    }

    return updatedSummaries;
  }

  function parsePriceFromLavkaHtml(html) {
    if (!html) return null;
    const mTestId = html.match(/data-testid="price-text"[^>]*>([\d\s,.]+)</i);
    if (mTestId) {
      const val = parseFloat(mTestId[1].replace(/[^\d.,]/g, '').replace(',', '.'));
      if (val > 0) return Math.round(val);
    }
    const mLd = html.match(/"@type"\s*:\s*"Offer"[\s\S]{0,250}?"price"\s*:\s*"?([\d.]+)"?/i);
    if (mLd) {
      const val = parseFloat(mLd[1]);
      if (val > 0) return Math.round(val);
    }
    const mState = html.match(/"pricing"\s*:\s*\{[^}]*"price"\s*:\s*(\d+(?:\.\d+)?)/i);
    if (mState) {
      const val = parseFloat(mState[1]);
      if (val > 0) return Math.round(val);
    }
    return null;
  }

  /**
   * Извлекает ПОЛНОЕ ОРИГИНАЛЬНОЕ НАЗВАНИЕ, фасовку, бренд, картинку и цену
   * напрямую из HTML оригинальной карточки товара (`https://lavka.yandex.ru/good/<slug>`).
   */
  function parseFullProductCardFromLavkaHtml(html) {
    if (!html) return null;
    const price = parsePriceFromLavkaHtml(html);

    let cardTitle = '';
    let cardAmount = '';
    let cardBrand = '';
    let imageKey = null;

    // 1. Заголовок <h1 data-testid="product-title">...</h1>
    const h1Match = html.match(/<h1[^>]*data-testid="product-title"[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match) {
      cardTitle = decodeHtmlEntities(h1Match[1]).replace(/[\u00ad\u200b]/g, '').trim();
    }

    // 2. Фасовка <span data-testid="product-amount">...</span>
    const amtMatch = html.match(/<span[^>]*data-testid="product-amount"[^>]*>([\s\S]*?)<\/span>/i);
    if (amtMatch) {
      cardAmount = decodeHtmlEntities(amtMatch[1]).replace(/[\u00ad\u200b\u00a0]/g, ' ').trim();
    }

    // 3. JSON-LD схема Product (содержит полное название, бренд и описание)
    const ldMatches = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
    for (const m of ldMatches) {
      try {
        const parsed = JSON.parse(m[1]);
        const graph = parsed['@graph'] || [parsed];
        const prod = graph.find((it) => it && it['@type'] === 'Product');
        if (prod) {
          if (!cardTitle && prod.name) {
            cardTitle = String(prod.name).replace(/[\u00ad\u200b]/g, '').trim();
          }
          if (prod.brand) {
            cardBrand = typeof prod.brand === 'string' ? prod.brand : (prod.brand.name || '');
          }
        }
      } catch {
        // ignore
      }
    }

    // 4. Fallback на <title>, если h1 и JSON-LD не сработали
    if (!cardTitle) {
      const titleTagMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (titleTagMatch) {
        const rawT = decodeHtmlEntities(titleTagMatch[1]);
        const splitT = rawT.split(/\s*[—–|]\s*купить|\s*[—–|]\s*Яндекс/i)[0].trim();
        if (splitT && splitT.length > 3) {
          cardTitle = splitT;
        }
      }
    }

    // 5. Ключ изображения (get-grocery-goods/...)
    const imgMatch = html.match(/get-grocery-goods\/(\d+\/[a-f0-9-]+)/i);
    if (imgMatch) {
      imageKey = imgMatch[1].toLowerCase();
    }

    return {
      price,
      cardTitle,
      cardAmount,
      cardBrand,
      imageKey
    };
  }

  /**
   * Запрашивает оригинальную карточку товара `https://lavka.yandex.ru/good/<slug>`
   * строго с реальной сессией пользователя (`credentials: 'include'`) и возвращает
   * актуальную цену, ПОЛНОЕ название и характеристики из карточки товара.
   */
  async function probeProductCardMeta(slug, fallbackTitle = '', currentPrice = null, accountId = null, fallbackAmount = '', fallbackImageKey = null) {
    if (!slug) return null;
    const cleanSlug = String(slug).trim().toLowerCase();
    const url = `https://lavka.yandex.ru/good/${encodeURIComponent(cleanSlug)}`;

    let parsedCard = null;
    try {
      const respAuth = await fetchWithTimeout(
        url,
        {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          headers: {
            'Accept-Language': 'ru-RU,ru;q=0.9'
          }
        },
        4200
      );
      if (respAuth.ok) {
        const htmlAuth = await respAuth.text();
        if (!isCaptchaOrBlockHtml(htmlAuth)) {
          parsedCard = parseFullProductCardFromLavkaHtml(htmlAuth);
        }
      }
    } catch (err) {
      console.warn('[LQS PriceRadar] Lavka card fetch failed:', cleanSlug, err?.message || err);
    }

    const canonicalTitle = parsedCard?.cardTitle
      ? buildFullProductSearchQuery(parsedCard.cardTitle, parsedCard.cardBrand || '', parsedCard.cardAmount || fallbackAmount)
      : fallbackTitle;
    const canonicalAmount = parsedCard?.cardAmount || fallbackAmount || '';
    const canonicalBrand = parsedCard?.cardBrand || '';
    const canonicalImageKey = parsedCard?.imageKey || fallbackImageKey || null;
    const hasCanonicalTitle = Boolean(parsedCard?.cardTitle);
    const effectivePrice = currentPrice || (parsedCard && parsedCard.price > 0 ? parsedCard.price : 0);

    if (hasCanonicalTitle || effectivePrice > 0) {
      const summaries = await recordPricesBatch(accountId, [
        {
          slug: cleanSlug,
          title: canonicalTitle || cleanSlug,
          isCanonicalCardTitle: hasCanonicalTitle,
          brand: canonicalBrand,
          imageKey: canonicalImageKey,
          amount: canonicalAmount,
          price: effectivePrice
        }
      ]);
      return summaries[cleanSlug] || {
        slug: cleanSlug,
        title: canonicalTitle,
        isCanonicalCardTitle: hasCanonicalTitle,
        brand: canonicalBrand,
        imageKey: canonicalImageKey,
        amount: canonicalAmount,
        lastPrice: effectivePrice || null
      };
    }
    return null;
  }

  async function getProductPriceIntelligence(slug, title = '', currentPrice = null, oldPrice = null, amount = '', accountId = null, isFromProductCard = false, imageKey = null, brand = '') {
    const cleanSlug = String(slug || '').trim().toLowerCase();
    if (!cleanSlug) return null;
    const settings = await getSettings();
    const acc = accountId || settings.lavkaAccountLabel || 'Аккаунт #1';

    const fullCardTitle = isFromProductCard ? buildFullProductSearchQuery(title, brand, amount) : title;

    if (currentPrice && currentPrice > 0) {
      await recordPricesBatch(acc, [
        {
          slug: cleanSlug,
          title: fullCardTitle,
          isCanonicalCardTitle: Boolean(isFromProductCard && title),
          brand: brand || '',
          imageKey: imageKey || null,
          price: currentPrice,
          oldPrice,
          amount
        }
      ]);
    }

    const db = await getLocalPriceDb();
    let summary = findPriceEntryInDb(db, cleanSlug, fullCardTitle, imageKey);

    const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
    if (backendUrl && Date.now() > (getBgDeps().getBackendOfflineUntilTs?.() || 0)) {
      try {
        const qTitle = fullCardTitle ? `?title=${encodeURIComponent(fullCardTitle)}` : '';
        const r = await fetchWithTimeout(
          `${backendUrl}/api/price/product/${encodeURIComponent(cleanSlug)}${qTitle}`,
          { method: 'GET', headers: await getBgDeps().getBackendAuthHeaders(backendUrl) },
          1000
        );
        if (r.ok) {
          const j = await r.json();
          if (j && j.status === 'ok' && j.summary) {
            const keepCanonicalTitle = summary?.isCanonicalCardTitle ? summary.title : (fullCardTitle || j.summary.title);
            summary = {
              ...(summary || {}),
              ...j.summary,
              title: keepCanonicalTitle,
              isCanonicalCardTitle: Boolean(summary?.isCanonicalCardTitle || isFromProductCard),
              accounts: { ...(summary?.accounts || {}), ...(j.summary.accounts || {}) }
            };
            db[cleanSlug] = summary;
            chrome.storage.local.set({ [PRICE_DB_KEY]: db });
          }
        }
      } catch (err) {
        console.warn('[LQS PriceRadar] Backend /api/price/product failed:', cleanSlug, err?.message || err);
        getBgDeps().setBackendOfflineUntilTs?.(Date.now() + 10000);
      }
    }

    if (!summary || !summary.isCanonicalCardTitle) {
      const probed = await probeProductCardMeta(
        cleanSlug,
        fullCardTitle,
        currentPrice,
        acc,
        amount,
        imageKey
      );
      if (probed) {
        summary = { ...(summary || {}), ...probed };
      }
    }

    if (summary) {
      const authoritativeTitle = summary.title || fullCardTitle || '';
      const authoritativeAmount = summary.amount || amount || '';
      const authoritativeBrand = summary.brand || brand || '';
      const effectiveTargetPrice = (Number(currentPrice) > 0 ? Number(currentPrice) : (Number(summary.lastPrice) > 0 ? Number(summary.lastPrice) : null));
      const [extList, backendMatchedExt] = await Promise.all([
        getExternalStoreOffersList(),
        fetchExternalOffersMatchFromBackend({
          title: authoritativeTitle,
          brand: authoritativeBrand,
          amount: authoritativeAmount,
          excludeStore: 'Яндекс Лавка',
          targetPrice: effectiveTargetPrice
        })
      ]);
      const localMatchedExt = findMatchingExternalStoreOffersFromList(extList, authoritativeTitle, authoritativeAmount, effectiveTargetPrice);
      const matchedExt = mergeUniqueStoreOffers(localMatchedExt, backendMatchedExt);

      let combinedOffers = mergeUniqueStoreOffers(summary.competitorOffers || [], matchedExt);
      combinedOffers = sanitizeCompetitorOffersForProduct(
        combinedOffers,
        authoritativeTitle,
        authoritativeAmount,
        effectiveTargetPrice
      );

      // Если в базе ещё нет цен других магазинов для этого товара, запускаем прямой экспресс-парсинг ВкусВилла и мульти-поиска сетей
      if (combinedOffers.filter((o) => o.price && o.price > 0).length < 2 && authoritativeTitle) {
        try {
          const directStoreOffers = await getBgDeps().probeDirectRetailStoresForProduct(authoritativeTitle, authoritativeBrand, authoritativeAmount, effectiveTargetPrice);
          if (directStoreOffers.length > 0) {
            combinedOffers = mergeUniqueStoreOffers(combinedOffers, directStoreOffers);
            combinedOffers = sanitizeCompetitorOffersForProduct(combinedOffers, authoritativeTitle, authoritativeAmount, effectiveTargetPrice);
          }
        } catch (err) {
          console.warn('[LQS PriceRadar] Direct retail stores probe failed:', authoritativeTitle, err?.message || err);
        }
      }

      const rejectedSet = await getRejectedMatchesForProduct(authoritativeTitle);
      combinedOffers = filterRejectedOffers(combinedOffers, rejectedSet);

      summary.competitorOffers = combinedOffers;
      const priced = combinedOffers.filter((o) => o.price && o.price > 0);
      if (priced.length > 0) {
        summary.competitorMinPrice = Math.min(...priced.map((o) => o.price));
        summary.competitorSummary = priced.slice(0, 4).map((o) => `${o.store}: ${o.price} ₽`).join(', ');
      } else {
        summary.competitorMinPrice = null;
        summary.competitorSummary = null;
      }
      summary.storeSearchLinks = buildDirectStoreSearchLinks(
        authoritativeTitle,
        authoritativeAmount,
        authoritativeBrand
      );

      // Сохраняем обогащённую сводку в локальную БД
      const latestDb = await getLocalPriceDb();
      latestDb[cleanSlug] = summary;
      chrome.storage.local.set({ [PRICE_DB_KEY]: latestDb });
    }

    return summary;
  }

  async function getExternalStoreOffersList() {
    const seedOffers = await getMagnitSeedOffers();
    return new Promise((resolve) => {
      chrome.storage.local.get([EXT_STORE_DB_KEY], (res) => {
        const saved = res && Array.isArray(res[EXT_STORE_DB_KEY]) ? res[EXT_STORE_DB_KEY] : [];
        const combined = [...saved];
        const seenUrls = new Set(combined.map((o) => o.url));
        for (const seed of seedOffers) {
          if (!seenUrls.has(seed.url)) {
            combined.push(seed);
            seenUrls.add(seed.url);
          }
        }
        resolve(combined);
      });
    });
  }

  function normalizeStoreIdForRadar(rawStore) {
    const s = String(rawStore || '').trim().toLowerCase().replace(/ё/g, 'е');
    if (!s) return '';
    if (s.includes('магнит') || s.includes('magnit')) return 'magnit';
    if (s.includes('пятероч') || s.includes('5ka') || s.includes('pyaterochka')) return 'pyaterochka';
    if (s.includes('перекрест') || s.includes('perekrestok') || s.includes('впрок') || s.includes('vprok')) return 'perekrestok';
    if (s.includes('вкусвилл') || s.includes('vkusvill')) return 'vkusvill';
    if (s.includes('ашан') || s.includes('auchan')) return 'auchan';
    if (s.includes('лента') || s.includes('lenta')) return 'lenta';
    if (s.includes('купер') || s.includes('kuper') || s.includes('сбермаркет')) return 'kuper';
    if (s.includes('лавка') || s.includes('lavka')) return 'lavka';
    return s;
  }

  function cleanOfferUrlForKey(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    return raw.split('#')[0];
  }

  async function getLocalRejectedMatchesMap() {
    return new Promise((resolve) => {
      chrome.storage.local.get([REJECTED_MATCHES_KEY], (res) => {
        const raw = res && res[REJECTED_MATCHES_KEY];
        resolve(raw && typeof raw === 'object' ? { ...raw } : {});
      });
    });
  }

  async function getRejectedMatchesForProduct(sourceTitle) {
    const sourceKey = normalizeTitleKey(sourceTitle);
    const out = new Set();
    if (!sourceKey) return out;

    const localMap = await getLocalRejectedMatchesMap();
    const localList = Array.isArray(localMap[sourceKey]) ? localMap[sourceKey] : [];
    for (const item of localList) {
      if (item) out.add(String(item));
    }

    if (Date.now() > (getBgDeps().getBackendOfflineUntilTs?.() || 0) && typeof getBgDeps().getBackendAuthHeaders === 'function') {
      try {
        const settings = await getSettings();
        const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
        if (backendUrl) {
          const resp = await fetchWithTimeout(
            `${backendUrl}/api/external-offers/rejected?title=${encodeURIComponent(sourceTitle)}`,
            { method: 'GET', headers: await getBgDeps().getBackendAuthHeaders(backendUrl) },
            1000
          );
          if (resp && resp.ok) {
            const data = await resp.json();
            if (data && Array.isArray(data.items)) {
              for (const item of data.items) {
                if (item) out.add(String(item));
              }
            }
          }
        }
      } catch {
        // ignore offline backend
      }
    }
    return out;
  }

  function filterRejectedOffers(offers, rejectedSet) {
    if (!Array.isArray(offers) || offers.length === 0) return [];
    if (!rejectedSet || rejectedSet.size === 0) return offers;
    return offers.filter((o) => {
      if (!o) return false;
      const u = cleanOfferUrlForKey(o.url);
      const nt = normalizeTitleKey(o.title || '');
      if (u && rejectedSet.has(u)) return false;
      if (nt && rejectedSet.has(nt)) return false;
      return true;
    });
  }

  async function rejectCompetitorMatch({ sourceTitle = '', sourceSlug = '', rejectedUrl = '', rejectedTitle = '' } = {}) {
    const cleanSourceTitle = String(sourceTitle || '').trim();
    const sourceKey = normalizeTitleKey(cleanSourceTitle);
    const cleanUrl = cleanOfferUrlForKey(rejectedUrl);
    const normRejTitle = normalizeTitleKey(rejectedTitle);
    if (!sourceKey || (!cleanUrl && !normRejTitle)) {
      return { ok: false, error: 'Недостаточно данных для отклонения совпадения' };
    }

    const localMap = await getLocalRejectedMatchesMap();
    const existing = Array.isArray(localMap[sourceKey]) ? [...localMap[sourceKey]] : [];
    if (cleanUrl && !existing.includes(cleanUrl)) existing.push(cleanUrl);
    if (normRejTitle && !existing.includes(normRejTitle)) existing.push(normRejTitle);
    localMap[sourceKey] = existing.slice(-100);
    await new Promise((resolve) => {
      chrome.storage.local.set({ [REJECTED_MATCHES_KEY]: localMap }, resolve);
    });

    // Сразу удаляем отклонённый оффер из кэшированной сводки товара Лавки, если он там есть
    if (sourceSlug) {
      const cleanSlug = String(sourceSlug).trim().toLowerCase();
      const priceDb = await getLocalPriceDb();
      if (priceDb[cleanSlug] && Array.isArray(priceDb[cleanSlug].competitorOffers)) {
        const rejSet = new Set(existing);
        priceDb[cleanSlug].competitorOffers = filterRejectedOffers(priceDb[cleanSlug].competitorOffers, rejSet);
        const priced = priceDb[cleanSlug].competitorOffers.filter((o) => o && o.price > 0);
        priceDb[cleanSlug].competitorMinPrice = priced.length > 0 ? Math.min(...priced.map((o) => o.price)) : null;
        priceDb[cleanSlug].competitorSummary = priced.length > 0
          ? priced.slice(0, 4).map((o) => `${o.store}: ${o.price} ₽`).join(', ')
          : null;
        await new Promise((resolve) => chrome.storage.local.set({ [PRICE_DB_KEY]: priceDb }, resolve));
      }
    }

    let syncedToSqlite = false;
    if (Date.now() > (getBgDeps().getBackendOfflineUntilTs?.() || 0) && typeof getBgDeps().getBackendAuthHeaders === 'function') {
      try {
        const settings = await getSettings();
        const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
        if (backendUrl) {
          const resp = await fetchWithTimeout(
            `${backendUrl}/api/external-offers/reject-match`,
            {
              method: 'POST',
              headers: await getBgDeps().getBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' }),
              body: JSON.stringify({
                sourceTitle: cleanSourceTitle,
                rejectedUrl: cleanUrl,
                rejectedTitle: String(rejectedTitle || '').trim()
              })
            },
            1800
          );
          syncedToSqlite = Boolean(resp && resp.ok);
        }
      } catch (err) {
        console.warn('[LQS PriceRadar] Backend /api/external-offers/reject-match failed:', err?.message || err);
      }
    }

    return { ok: true, sourceKey, rejectedCount: existing.length, syncedToSqlite };
  }

  async function syncExternalOffersToBackend(storeName, cleanOffers = []) {
    if (!Array.isArray(cleanOffers) || cleanOffers.length === 0) return null;
    if (Date.now() <= (getBgDeps().getBackendOfflineUntilTs?.() || 0)) return null;
    if (typeof getBgDeps().getBackendAuthHeaders !== 'function') return null;
    try {
      const settings = await getSettings();
      const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
      if (!backendUrl) return null;
      const resp = await fetchWithTimeout(
        `${backendUrl}/api/external-offers/batch`,
        {
          method: 'POST',
          headers: await getBgDeps().getBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ store: storeName || '', offers: cleanOffers.slice(0, 500) })
        },
        2200
      );
      if (resp && resp.ok) {
        const data = await resp.json();
        if (data && data.status === 'ok') {
          return {
            savedCount: Number(data.savedCount || 0),
            totalInSqlite: Number(data.totalInSqlite || 0)
          };
        }
      }
    } catch (err) {
      console.warn('[LQS PriceRadar] Backend /api/external-offers/batch failed:', err?.message || err);
      getBgDeps().setBackendOfflineUntilTs?.(Date.now() + 10000);
    }
    return null;
  }

  async function fetchExternalOffersMatchFromBackend({ title = '', brand = '', amount = '', excludeStore = '', targetPrice = null } = {}) {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle || cleanTitle.length < 3) return [];
    if (Date.now() <= (getBgDeps().getBackendOfflineUntilTs?.() || 0)) return [];
    if (typeof getBgDeps().getBackendAuthHeaders !== 'function') return [];
    try {
      const settings = await getSettings();
      const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
      if (!backendUrl) return [];
      const bodyPayload = {
        title: cleanTitle,
        brand: String(brand || '').trim(),
        amount: String(amount || '').trim(),
        excludeStore: String(excludeStore || '').trim()
      };
      if (Number(targetPrice) > 0) {
        bodyPayload.targetPrice = Number(targetPrice);
      }
      const resp = await fetchWithTimeout(
        `${backendUrl}/api/external-offers/match`,
        {
          method: 'POST',
          headers: await getBgDeps().getBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' }),
          body: JSON.stringify(bodyPayload)
        },
        1500
      );
      if (resp && resp.ok) {
        const data = await resp.json();
        if (data && data.status === 'ok' && Array.isArray(data.offers)) {
          return data.offers;
        }
      }
    } catch (err) {
      console.warn('[LQS PriceRadar] Backend /api/external-offers/match failed:', err?.message || err);
      getBgDeps().setBackendOfflineUntilTs?.(Date.now() + 10000);
    }
    return [];
  }

  async function recordExternalStoreOffers(storeName, offers = []) {
    if (!Array.isArray(offers) || offers.length === 0) return { savedCount: 0 };
    const current = await getExternalStoreOffersList();
    const byKey = new Map();
    for (const item of current) {
      if (!item || !item.title || !item.price) continue;
      const k = `${item.store || storeName}|${item.url || normalizeTitleKey(item.title)}`;
      byKey.set(k, item);
    }
    const nowIso = new Date().toISOString();
    let addedOrUpdated = 0;
    const cleanBatch = [];
    for (const raw of offers) {
      if (!raw || !raw.title || !raw.price || Number(raw.price) <= 0) continue;
      const cleanOffer = {
        store: raw.store || storeName || 'Магнит',
        sourceRetailer: raw.sourceRetailer || null,
        goodId: raw.goodId || null,
        title: String(raw.title).trim(),
        brand: raw.brand ? String(raw.brand).trim() : '',
        amount: raw.amount || '',
        price: Math.round(Number(raw.price)),
        oldPrice: raw.oldPrice ? Math.round(Number(raw.oldPrice)) : null,
        url: raw.url || `https://magnit.ru/search?term=${encodeURIComponent(raw.title)}`,
        updatedAt: nowIso
      };
      const k = `${cleanOffer.store}|${cleanOffer.url || normalizeTitleKey(cleanOffer.title)}`;
      byKey.set(k, cleanOffer);
      cleanBatch.push(cleanOffer);
      addedOrUpdated += 1;
    }
    const finalArr = Array.from(byKey.values()).slice(-MAX_LOCAL_EXT_STORE_OFFERS);
    await new Promise((resolve) => {
      chrome.storage.local.set({ [EXT_STORE_DB_KEY]: finalArr }, resolve);
    });

    // Долгосрочная запись всех собранных офферов в SQLite на локальный сервер (без лимита 800)
    const backendSync = await syncExternalOffersToBackend(storeName, cleanBatch);

    // Сразу обогащаем совпадающие товары в базе цен Лавки (lqs_price_db_v1)
    const priceDb = await getLocalPriceDb();
    let dbChanged = false;
    for (const entry of Object.values(priceDb)) {
      if (!entry || !entry.title) continue;
      const entryTargetPrice = Number(entry.lastPrice) > 0 ? Number(entry.lastPrice) : null;
      const matchedOffers = findMatchingExternalStoreOffersFromList(finalArr, entry.title, entry.amount || '', entryTargetPrice);
      const prevJson = JSON.stringify(entry.competitorOffers || []);
      const mergedOffers = mergeUniqueStoreOffers(entry.competitorOffers || [], matchedOffers);
      const sanitizedOffers = sanitizeCompetitorOffersForProduct(mergedOffers, entry.title, entry.amount || '', entryTargetPrice);
      if (JSON.stringify(sanitizedOffers) !== prevJson) {
        entry.competitorOffers = sanitizedOffers;
        const priced = sanitizedOffers.filter((o) => o.price && o.price > 0);
        entry.competitorMinPrice = priced.length > 0 ? Math.min(...priced.map((o) => o.price)) : null;
        entry.competitorSummary = priced.length > 0
          ? priced.slice(0, 4).map((o) => `${o.store}: ${o.price} ₽`).join(', ')
          : null;
        dbChanged = true;
      }
    }
    if (dbChanged) {
      await new Promise((resolve) => chrome.storage.local.set({ [PRICE_DB_KEY]: priceDb }, resolve));
    }
    const totalExternalOffers = backendSync && Number.isFinite(backendSync.totalInSqlite) && backendSync.totalInSqlite > 0
      ? backendSync.totalInSqlite
      : finalArr.length;
    return {
      ok: true,
      savedCount: addedOrUpdated,
      totalExternalOffers,
      storedInSqlite: Boolean(backendSync)
    };
  }

  function findMatchingExternalStoreOffersFromList(extList, productTitle, productAmount = '', targetPrice = null) {
    if (!productTitle || !Array.isArray(extList)) return [];
    const tPrice = Number(targetPrice) > 0 ? Number(targetPrice) : null;
    const matches = [];
    for (const ext of extList) {
      if (!ext || !ext.title || !ext.price) continue;
      const cPrice = Number(ext.price) > 0 ? Number(ext.price) : null;
      const opts = { requireVolume: true };
      if (tPrice && cPrice) {
        opts.targetPrice = tPrice;
        opts.candidatePrice = cPrice;
      }
      const check = isSearchResultMatchingProduct(ext.title, ext.amount || '', productTitle, productAmount, opts);
      if (check.isSameProduct && check.isSameVolume) {
        matches.push({
          store: ext.store || 'Магнит',
          sourceRetailer: ext.sourceRetailer || null,
          price: Math.round(Number(ext.price)),
          oldPrice: ext.oldPrice ? Math.round(Number(ext.oldPrice)) : null,
          url: ext.url,
          title: ext.title,
          amount: ext.amount || '',
          updatedAt: ext.updatedAt || null,
          isVerifiedStoreOffer: true
        });
      }
    }
    return matches;
  }

  function mergeUniqueStoreOffers(existingOffers = [], newOffers = []) {
    const seenByUrl = new Set();
    const seenByStorePrice = new Set();
    const arr = Array.from([]);
    // Новые офферы идут первыми: свежая цена по тому же store|url всегда заменяет устаревшую
    for (const o of [...newOffers, ...existingOffers]) {
      if (!o || !o.store) continue;
      const cleanUrl = cleanOfferUrlForKey(o.url);
      const isSearchUrl = Boolean(cleanUrl && /(?:\/search|\/multisearch|\?(?:q|term|search)=)/i.test(cleanUrl));
      const urlKey = cleanUrl && !isSearchUrl ? `${o.store}|${cleanUrl}` : '';
      const priceKey = `${o.store}|${o.price || 'noprice'}`;
      if (urlKey && seenByUrl.has(urlKey)) continue;
      if (seenByStorePrice.has(priceKey)) continue;
      if (urlKey) seenByUrl.add(urlKey);
      seenByStorePrice.add(priceKey);
      arr.push(o);
    }
    arr.sort((a, b) => {
      if (a.price && b.price) return a.price - b.price;
      if (a.price) return -1;
      if (b.price) return 1;
      return 0;
    });
    return arr;
  }

  /**
   * Пакетный аудит корзины по конкурентам и гостевым ценам:
   * ГАРАНТИРУЕТ, что для каждого товара корзины название и характеристики берутся
   * СТРОГО ИЗ ОРИГИНАЛЬНОЙ КАРТОЧКИ ТОВАРА (`/good/<slug>`), а не из сокращённого текста в корзине!
   */
  async function auditCartCompetitorsAndAccounts(accountId, items = [], forceNetworkSearch = false) {
    const stopKeepAlive = getBgDeps().startSwKeepAlive ? getBgDeps().startSwKeepAlive() : () => {};
    try {
      const settings = await getSettings();
      const acc = accountId || settings.lavkaAccountLabel || 'Аккаунт #1 (Основной)';
      let priceDb = await getLocalPriceDb();

      // Шаг 1: Для всех позиций корзины, у которых ещё нет полного названия из оригинальной карточки товара (`isCanonicalCardTitle`),
      // параллельно подтягиваем оригинальную карточку `https://lavka.yandex.ru/good/<slug>`!
      const itemsNeedingCardResolution = items.filter((item) => {
        if (!item || !item.slug) return false;
        const existing = findPriceEntryInDb(priceDb, item.slug, item.title, item.imageKey);
        return !existing || !existing.isCanonicalCardTitle;
      });

      for (let i = 0; i < itemsNeedingCardResolution.length; i += 4) {
        const chunk = itemsNeedingCardResolution.slice(i, i + 4);
        await Promise.all(
          chunk.map((it) =>
            probeProductCardMeta(
              it.slug,
              it.title || it.slug,
              it.price,
              acc,
              it.amount || '',
              it.imageKey || null
            )
          )
        );
      }

      // Перечитываем обновлённую БД после резолва оригинальных карточек
      priceDb = await getLocalPriceDb();

      const enrichedItems = [];
      let totalLavkaPrice = 0;
      let totalOverpayVsCompetitors = 0;
      let totalOverpayVsAltAccount = 0;
      let cheaperAtCompetitorsCount = 0;
      let cheaperOnAltAccountCount = 0;

      const batchUpdates = [];
      let ddgNetworkCallsMade = 0;
      const maxDdgCallsPerPass = forceNetworkSearch ? 10 : 5;

      for (const item of items) {
        if (!item || !item.slug) continue;
        const slug = String(item.slug).trim().toLowerCase();
        const qty = Math.max(1, Number(item.qty) || 1);
        const price = Number(item.price) || 0;

        totalLavkaPrice += price * qty;

        const pEntry = findPriceEntryInDb(priceDb, slug, item.title, item.imageKey);

        // БЕРЁМ НАЗВАНИЕ, ФАСОВКУ И БРЕНД СТРОГО ИЗ ОРИГИНАЛЬНОЙ КАРТОЧКИ ТОВАРА!
        const cardTitle = (pEntry && pEntry.title) ? pEntry.title : (item.title || slug);
        const cardAmount = (pEntry && pEntry.amount) ? pEntry.amount : (item.amount || '');
        const cardBrand = (pEntry && pEntry.brand) ? pEntry.brand : '';
        const cardImageKey = (pEntry && pEntry.imageKey) ? pEntry.imageKey : (item.imageKey || null);
        const fullAuthoritativeTitle = buildFullProductSearchQuery(cardTitle, cardBrand, cardAmount);

        const aiEntry = await getBgDeps().getLocalAiCacheEntry(slug, fullAuthoritativeTitle, cardImageKey);

        const extStoreList = await getExternalStoreOffersList();
        const matchedExtOffers = findMatchingExternalStoreOffersFromList(extStoreList, fullAuthoritativeTitle, cardAmount, price || null);
        let compOffers = sanitizeCompetitorOffersForProduct(
          mergeUniqueStoreOffers(pEntry?.competitorOffers || [], matchedExtOffers),
          fullAuthoritativeTitle,
          cardAmount,
          price || null
        );
        let compMin = null;
        let compSum = '';

        if (compOffers.length > 0) {
          const pricedOffers = compOffers.filter((o) => o.price && o.price > 0);
          if (pricedOffers.length > 0) {
            compMin = Math.min(...pricedOffers.map((o) => o.price));
            compSum = pricedOffers.slice(0, 3).map((o) => `${o.store}: ~${o.price} ₽`).join(', ');
          }
        }

        if (compOffers.length === 0 && aiEntry && Array.isArray(aiEntry.sources) && aiEntry.sources.length > 0) {
          const extracted = getBgDeps().extractCompetitorPricesFromSources(
            aiEntry.sources,
            price,
            fullAuthoritativeTitle,
            cardAmount
          );
          if (extracted.competitorMinPrice) compMin = extracted.competitorMinPrice;
          if (extracted.competitorSummary) compSum = extracted.competitorSummary;
          if (extracted.competitorOffers.length > 0) compOffers = extracted.competitorOffers;
        }

        if (
          (forceNetworkSearch || (!compMin && compOffers.length === 0)) &&
          fullAuthoritativeTitle &&
          ddgNetworkCallsMade < maxDdgCallsPerPass
        ) {
          ddgNetworkCallsMade += 1;
          const foundSources = await getBgDeps().searchWebReviewsDirect(fullAuthoritativeTitle, cardBrand, cardAmount);
          const extracted = getBgDeps().extractCompetitorPricesFromSources(
            foundSources,
            price,
            fullAuthoritativeTitle,
            cardAmount
          );
          if (extracted.competitorMinPrice) compMin = extracted.competitorMinPrice;
          if (extracted.competitorSummary) compSum = extracted.competitorSummary;
          if (extracted.competitorOffers.length > 0) {
            compOffers = extracted.competitorOffers;
          } else if (foundSources.length > 0) {
            compOffers = foundSources
              .filter((s) => s.url && !s.url.includes('otzovik.com') && !s.url.includes('irecommend.ru'))
              .filter((s) => isSearchResultMatchingProduct(s.title, s.snippet, fullAuthoritativeTitle, cardAmount).isSameProduct)
              .slice(0, 4)
              .map((s) => ({
                store: s.source || 'Магазин',
                price: null,
                url: s.url,
                title: s.title || s.source
              }));
          }

          batchUpdates.push({
            slug,
            title: fullAuthoritativeTitle,
            isCanonicalCardTitle: Boolean(pEntry?.isCanonicalCardTitle),
            brand: cardBrand,
            imageKey: cardImageKey,
            price,
            oldPrice: item.oldPrice || null,
            amount: cardAmount,
            competitorMinPrice: compMin || null,
            competitorSummary: compSum || null,
            competitorOffers: compOffers
          });
        }

        let bestAltPrice = null;
        let bestAltLabel = '';
        const accountsMap = pEntry?.accounts || {};
        for (const [accName, accVal] of Object.entries(accountsMap)) {
          if (accName !== acc && accVal && accVal.price && accVal.price < price - 2) {
            if (!bestAltPrice || accVal.price < bestAltPrice) {
              bestAltPrice = accVal.price;
              bestAltLabel = accName;
            }
          }
        }
        if (pEntry?.minPrice && pEntry.minPrice < price - 2 && (!bestAltPrice || pEntry.minPrice < bestAltPrice)) {
          bestAltPrice = pEntry.minPrice;
          bestAltLabel = 'Мин. в БД';
        }

        const overpayVsCompetitorPerUnit = compMin && compMin < price - 3 ? Math.round(price - compMin) : 0;
        const overpayVsCompetitorTotal = overpayVsCompetitorPerUnit * qty;
        if (overpayVsCompetitorTotal > 0) {
          totalOverpayVsCompetitors += overpayVsCompetitorTotal;
          cheaperAtCompetitorsCount += 1;
        }

        const overpayVsAltPerUnit = bestAltPrice && bestAltPrice < price - 2 ? Math.round(price - bestAltPrice) : 0;
        const overpayVsAltTotal = overpayVsAltPerUnit * qty;
        if (overpayVsAltTotal > 0) {
          totalOverpayVsAltAccount += overpayVsAltTotal;
          cheaperOnAltAccountCount += 1;
        }

        enrichedItems.push({
          slug,
          title: fullAuthoritativeTitle,
          amount: cardAmount,
          brand: cardBrand,
          imageKey: cardImageKey,
          qty,
          price,
          rowTotal: Math.round(price * qty),
          bestAltPrice: bestAltPrice || null,
          bestAltLabel: bestAltLabel || '',
          overpayVsAltPerUnit,
          overpayVsAltTotal,
          competitorMinPrice: compMin || null,
          competitorSummary: compSum || '',
          competitorOffers: compOffers,
          overpayVsCompetitorPerUnit,
          overpayVsCompetitorTotal,
          storeSearchLinks: buildDirectStoreSearchLinks(fullAuthoritativeTitle, cardAmount, cardBrand)
        });
      }

      if (batchUpdates.length > 0) {
        await recordPricesBatch(acc, batchUpdates);
      }

      return {
        ok: true,
        accountId: acc,
        totalLavkaPrice: Math.round(totalLavkaPrice),
        totalOverpayVsCompetitors: Math.round(totalOverpayVsCompetitors),
        totalOverpayVsAltAccount: Math.round(totalOverpayVsAltAccount),
        cheaperAtCompetitorsCount,
        cheaperOnAltAccountCount,
        items: enrichedItems,
        updatedAt: new Date().toISOString()
      };
    } finally {
      stopKeepAlive();
    }
  }


  async function getLocalWatchlist() {
    return new Promise((resolve) => {
      chrome.storage.local.get([WATCHLIST_KEY], (res) => {
        const map = res[WATCHLIST_KEY];
        resolve(map && typeof map === 'object' ? map : {});
      });
    });
  }

  async function saveLocalWatchlist(map) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [WATCHLIST_KEY]: map || {} }, () => resolve());
    });
  }

  function buildLocalDailyAvg(points) {
    const buckets = new Map();
    for (const pt of Array.isArray(points) ? points : []) {
      if (!pt || !(Number(pt.price) > 0)) continue;
      const dayKey = String(pt.ts || '').slice(0, 10);
      if (!dayKey) continue;
      if (!buckets.has(dayKey)) buckets.set(dayKey, []);
      buckets.get(dayKey).push(Number(pt.price));
    }
    return Array.from(buckets.keys())
      .sort()
      .map((dayKey) => {
        const vals = buckets.get(dayKey);
        const avg = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
        return {
          date: dayKey,
          ts: `${dayKey}T12:00:00.000Z`,
          price: avg,
          minPrice: Math.min(...vals),
          maxPrice: Math.max(...vals),
          count: vals.length
        };
      });
  }

  async function getProductPriceHistory(slug, title = '', days = 90, accountId = null) {
    const cleanSlug = String(slug || '').trim().toLowerCase();
    if (!cleanSlug) return null;
    const settings = await getSettings();
    const backendUrl = (settings.backendUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');
    const daysNum = Number.isFinite(Number(days)) ? Number(days) : 90;

    if (Date.now() > (getBgDeps().getBackendOfflineUntilTs?.() || 0)) {
      try {
        const qs = new URLSearchParams({ days: String(daysNum) });
        if (title) qs.set('title', title);
        if (accountId) qs.set('accountId', accountId);
        const resp = await fetchWithTimeout(
          `${backendUrl}/api/price/history/${encodeURIComponent(cleanSlug)}?${qs.toString()}`,
          { headers: await getBgDeps().buildBackendAuthHeaders(backendUrl) },
          3000
        );
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.status === 'ok') {
            return data;
          }
        }
      } catch (err) {
        console.warn('[LQS PriceRadar] Backend /api/price/history failed:', cleanSlug, err?.message || err);
        getBgDeps().setBackendOfflineUntilTs?.(Date.now() + 10000);
      }
    }

    // Fallback к локальной базе PRICE_DB + WATCHLIST
    const db = await getLocalPriceDb();
    const wl = await getLocalWatchlist();
    const entry = findPriceEntryInDb(db, cleanSlug, title);
    const canonicalSlug = entry?.slug || cleanSlug;
    const rawHistory = Array.isArray(entry?.history) ? [...entry.history].reverse() : [];
    const cutoff = daysNum > 0 ? Date.now() - daysNum * 24 * 60 * 60 * 1000 : 0;

    const points = rawHistory
      .filter((h) => h && Number(h.price) > 0 && h.accountId !== 'Гость (без куки)')
      .filter((h) => !accountId || h.accountId === accountId)
      .filter((h) => !cutoff || !h.ts || Date.parse(h.ts) >= cutoff)
      .map((h) => ({
        price: Number(h.price),
        oldPrice: h.oldPrice ? Number(h.oldPrice) : null,
        accountId: h.accountId || 'Аккаунт #1',
        ts: h.ts || entry.updatedAt || new Date().toISOString()
      }));

    if (points.length === 0 && entry && entry.lastPrice > 0) {
      points.push({
        price: Number(entry.lastPrice),
        oldPrice: null,
        accountId: settings.lavkaAccountLabel || 'Аккаунт #1',
        ts: entry.updatedAt || new Date().toISOString()
      });
    }

    const prices = points.map((p) => p.price);
    const stats = prices.length > 0
      ? {
          minPrice: Math.min(...prices),
          maxPrice: Math.max(...prices),
          avgPrice: Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100,
          lastPrice: prices[prices.length - 1],
          count: prices.length
        }
      : { minPrice: null, maxPrice: null, avgPrice: null, lastPrice: null, count: 0 };

    const wItem = wl[canonicalSlug] || wl[cleanSlug] || null;
    const accounts = Array.from(new Set(points.map((p) => p.accountId).filter(Boolean)));

    return {
      status: 'ok',
      slug: canonicalSlug,
      title: entry?.title || title || canonicalSlug,
      amount: entry?.amount || '',
      days: daysNum,
      points,
      dailyAvg: buildLocalDailyAvg(points),
      stats,
      accounts,
      isWatched: Boolean(wItem),
      targetPrice: wItem?.targetPrice || null
    };
  }

  async function toggleWatchlistItem({ slug, title = '', amount = '', price = null, targetPrice = null, watch = null } = {}) {
    const cleanSlug = String(slug || '').trim().toLowerCase();
    if (!cleanSlug) return { ok: false, error: 'slug is required' };
    const settings = await getSettings();
    const backendUrl = (settings.backendUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');
    const wl = await getLocalWatchlist();
    const nowIso = new Date().toISOString();

    let watched = watch === null || watch === undefined ? !Boolean(wl[cleanSlug]) : Boolean(watch);
    let item = null;

    if (Date.now() > (getBgDeps().getBackendOfflineUntilTs?.() || 0)) {
      try {
        const resp = await fetchWithTimeout(
          `${backendUrl}/api/watchlist/toggle`,
          {
            method: 'POST',
            headers: await getBgDeps().buildBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ slug: cleanSlug, title, amount, price, targetPrice, watch })
          },
          3000
        );
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.status === 'ok') {
            watched = Boolean(data.watched);
            item = data.item || null;
          }
        }
      } catch (err) {
        console.warn('[LQS PriceRadar] Backend /api/watchlist/toggle failed:', cleanSlug, err?.message || err);
        getBgDeps().setBackendOfflineUntilTs?.(Date.now() + 10000);
      }
    }

    if (watched) {
      const existing = wl[cleanSlug] || {};
      const effPrice = price && Number(price) > 0 ? Math.round(Number(price)) : (existing.lastPrice || null);
      wl[cleanSlug] = item || {
        slug: cleanSlug,
        title: title || existing.title || cleanSlug,
        amount: amount || existing.amount || '',
        targetPrice: targetPrice && Number(targetPrice) > 0 ? Math.round(Number(targetPrice)) : (existing.targetPrice || null),
        lastPrice: effPrice,
        baselinePrice: existing.baselinePrice || effPrice,
        lastCheckedAt: nowIso,
        createdAt: existing.createdAt || nowIso,
        updatedAt: nowIso
      };
      item = wl[cleanSlug];
    } else {
      delete wl[cleanSlug];
    }

    await saveLocalWatchlist(wl);
    return { ok: true, watched, slug: cleanSlug, item };
  }

  async function getWatchlistItems() {
    const settings = await getSettings();
    const backendUrl = (settings.backendUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');

    if (Date.now() > (getBgDeps().getBackendOfflineUntilTs?.() || 0)) {
      try {
        const resp = await fetchWithTimeout(
          `${backendUrl}/api/watchlist?limit=200`,
          { headers: await getBgDeps().buildBackendAuthHeaders(backendUrl) },
          3000
        );
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.status === 'ok' && Array.isArray(data.items)) {
            const syncMap = {};
            data.items.forEach((it) => {
              if (it && it.slug) syncMap[it.slug] = it;
            });
            await saveLocalWatchlist(syncMap);
            return data.items;
          }
        }
      } catch (err) {
        console.warn('[LQS PriceRadar] Backend /api/watchlist failed:', err?.message || err);
        getBgDeps().setBackendOfflineUntilTs?.(Date.now() + 10000);
      }
    }

    const wl = await getLocalWatchlist();
    const db = await getLocalPriceDb();
    return Object.values(wl)
      .map((it) => {
        const pEntry = findPriceEntryInDb(db, it.slug, it.title);
        const lastP = pEntry?.lastPrice ?? it.lastPrice ?? null;
        const baseP = it.baselinePrice ?? lastP;
        return {
          ...it,
          lastPrice: lastP,
          baselinePrice: baseP,
          priceDiff: (lastP != null && baseP != null) ? Math.round((lastP - baseP) * 100) / 100 : 0,
          minPrice: pEntry?.minPrice ?? it.minPrice ?? lastP,
          maxPrice: pEntry?.maxPrice ?? it.maxPrice ?? lastP,
          avgPrice: pEntry?.avgPrice ?? it.avgPrice ?? lastP
        };
      })
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  async function checkWatchlistPricesBatch({ maxItems = 12 } = {}) {
    const stopKeepAlive = getBgDeps().startSwKeepAlive ? getBgDeps().startSwKeepAlive() : () => {};
    try {
      const settings = await getSettings();
      const acc = settings.lavkaAccountLabel || 'Аккаунт #1 (Основной)';
      const items = await getWatchlistItems();
      if (!items || items.length === 0) {
        return { ok: true, checked: 0, updated: 0, drops: [] };
      }

      const slice = items.slice(0, Math.max(1, Number(maxItems) || 12));
      const wl = await getLocalWatchlist();
      const drops = [];
      let checked = 0;
      let updated = 0;

      for (const item of slice) {
        if (!item || !item.slug) continue;
        checked += 1;
        try {
          const prevPrice = Number(item.lastPrice) || 0;
          const probed = await probeProductCardMeta(
            item.slug,
            item.title || item.slug,
            null,
            acc,
            item.amount || '',
            null
          );
          const newPrice = probed && Number(probed.lastPrice) > 0 ? Number(probed.lastPrice) : 0;
          if (newPrice > 0) {
            updated += 1;
            if (wl[item.slug]) {
              wl[item.slug].lastPrice = newPrice;
              wl[item.slug].lastCheckedAt = new Date().toISOString();
              wl[item.slug].updatedAt = new Date().toISOString();
            }
            if (prevPrice > 0 && newPrice < prevPrice - 1) {
              drops.push({
                slug: item.slug,
                title: item.title || item.slug,
                oldPrice: prevPrice,
                newPrice,
                diff: Math.round(prevPrice - newPrice)
              });
            }
          }
        } catch (err) {
          console.warn('[LQS PriceRadar] Watchlist price check failed:', item.slug, err?.message || err);
        }
        await new Promise((r) => setTimeout(r, 450));
      }

      await saveLocalWatchlist(wl);
      return { ok: true, checked, updated, drops };
    } finally {
      stopKeepAlive();
    }
  }


  const LIVE_RADAR_STORE_URLS = {
    kuper: {
      name: 'Купер',
      buildUrl: (q) => `https://kuper.ru/multisearch?q=${encodeURIComponent(q)}`
    },
    magnit: {
      name: 'Магнит',
      buildUrl: (q) => `https://magnit.ru/search?term=${encodeURIComponent(q)}`
    },
    perekrestok: {
      name: 'Перекрёсток',
      buildUrl: (q) => `https://www.perekrestok.ru/cat/search?search=${encodeURIComponent(q)}`
    },
    pyaterochka: {
      name: 'Пятёрочка',
      buildUrl: (q) => `https://5ka.ru/search/?q=${encodeURIComponent(q)}`
    },
    vkusvill: {
      name: 'ВкусВилл',
      buildUrl: (q) => `https://vkusvill.ru/search/?q=${encodeURIComponent(q)}`
    },
    auchan: {
      name: 'Ашан',
      buildUrl: (q) => `https://www.auchan.ru/search/?q=${encodeURIComponent(q)}`
    },
    lenta: {
      name: 'Лента',
      buildUrl: (q) => `https://lenta.com/search/?searchText=${encodeURIComponent(q)}`
    }
  };

  function waitForTabComplete(tabId, timeoutMs = 8000) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const done = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (chrome.tabs?.onUpdated?.removeListener) {
          chrome.tabs.onUpdated.removeListener(onUpdated);
        }
        resolve();
      };
      const onUpdated = (updatedId, changeInfo) => {
        if (updatedId === tabId && changeInfo && changeInfo.status === 'complete') {
          done();
        }
      };
      timer = setTimeout(done, timeoutMs);
      if (chrome.tabs?.onUpdated?.addListener) {
        chrome.tabs.onUpdated.addListener(onUpdated);
      }
      if (chrome.tabs?.get) {
        chrome.tabs.get(tabId, (tab) => {
          if (!chrome.runtime.lastError && tab && tab.status === 'complete') {
            done();
          }
        });
      }
    });
  }

  function requestHarvestFromTab(tabId) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'LQS_HARVEST_STORE_PAGE_NOW' }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          const errMsg = chrome.runtime.lastError?.message || 'Вкладка магазина не ответила';
          resolve({
            store: '',
            offers: [],
            diagnostic: { status: 'error', reason: 'tab_error', message: errMsg }
          });
          return;
        }
        const offers = Array.isArray(resp.offers) ? resp.offers : [];
        const diagnostic = resp.diagnostic || {
          status: offers.length > 0 ? 'ok' : 'not_found',
          reason: offers.length > 0 ? 'ok' : 'not_found',
          message: offers.length > 0 ? '' : 'Товар не найден в выдаче магазина'
        };
        resolve({ store: resp.store || '', offers, diagnostic });
      });
    });
  }

  function isDirectProductUrl(url, storeId = '') {
    if (!url || typeof url !== 'string') return false;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const pathLower = parsed.pathname.toLowerCase();
    const searchLower = parsed.search.toLowerCase();
    if (
      pathLower.includes('/search') ||
      pathLower.includes('/multisearch') ||
      /[?&](?:q|term|search|searchtext)=/i.test(searchLower)
    ) {
      return false;
    }
    const sid = String(storeId || '').toLowerCase();
    if (sid === 'kuper') return /\/products?\//.test(pathLower);
    if (sid === 'magnit') return /\/product\//.test(pathLower);
    if (sid === 'pyaterochka') return /\/(product|catalog)\/[^/]+/.test(pathLower);
    if (sid === 'perekrestok') return /\/(cat\/[^/]+\/p\/|product\/)/.test(pathLower);
    if (sid === 'vkusvill') return /\/goods\//.test(pathLower);
    if (sid === 'auchan' || sid === 'lenta') return /\/product\//.test(pathLower);
    return /\/(products?|goods|cat\/[^/]+\/p)\//.test(pathLower);
  }

  async function getLocalProductLinksMap() {
    return new Promise((resolve) => {
      chrome.storage.local.get([PRODUCT_LINKS_KEY], (res) => {
        const raw = res && res[PRODUCT_LINKS_KEY];
        resolve(raw && typeof raw === 'object' ? { ...raw } : {});
      });
    });
  }

  async function saveLocalProductLinksMap(mapObj) {
    const entries = Object.entries(mapObj || {});
    if (entries.length > MAX_LOCAL_PRICE_DB_ITEMS) {
      mapObj = Object.fromEntries(entries.slice(-MAX_LOCAL_PRICE_DB_ITEMS));
    }
    return new Promise((resolve) => {
      chrome.storage.local.set({ [PRODUCT_LINKS_KEY]: mapObj }, () => resolve(mapObj));
    });
  }

  async function getRememberedProductLinks(slug) {
    const cleanSlug = String(slug || '').trim().toLowerCase();
    if (!cleanSlug) return {};
    const allLocal = await getLocalProductLinksMap();
    const merged = allLocal[cleanSlug] && typeof allLocal[cleanSlug] === 'object'
      ? { ...allLocal[cleanSlug] }
      : {};

    const settings = await getSettings();
    const backendUrl = (settings.backendUrl || '').replace(/\/+$/, '');
    if (backendUrl && Date.now() > (getBgDeps().getBackendOfflineUntilTs?.() || 0) && getBgDeps().getBackendAuthHeaders) {
      try {
        const resp = await fetchWithTimeout(
          `${backendUrl}/api/price/links/${encodeURIComponent(cleanSlug)}`,
          { method: 'GET', headers: await getBgDeps().getBackendAuthHeaders(backendUrl) },
          1800
        );
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.links && typeof data.links === 'object') {
            let changed = false;
            for (const [sid, linkObj] of Object.entries(data.links)) {
              if (!linkObj || !linkObj.url) continue;
              const localItem = merged[sid];
              if (!localItem || String(linkObj.updatedAt || '') > String(localItem.updatedAt || '')) {
                merged[sid] = linkObj;
                changed = true;
              }
            }
            if (changed) {
              allLocal[cleanSlug] = merged;
              await saveLocalProductLinksMap(allLocal);
            }
          }
        }
      } catch (err) {
        console.warn('[LQS] Backend links fetch failed:', err?.message || err);
        getBgDeps().setBackendOfflineUntilTs?.(Date.now() + 10000);
      }
    }
    return merged;
  }

  async function saveRememberedProductLinks(slug, linksList = []) {
    const cleanSlug = String(slug || '').trim().toLowerCase();
    if (!cleanSlug || !Array.isArray(linksList) || linksList.length === 0) return {};
    const nowIso = new Date().toISOString();
    const allLocal = await getLocalProductLinksMap();
    const current = allLocal[cleanSlug] && typeof allLocal[cleanSlug] === 'object'
      ? { ...allLocal[cleanSlug] }
      : {};

    const validToSync = [];
    for (const item of linksList) {
      if (!item || !item.storeId || !isDirectProductUrl(item.url, item.storeId)) continue;
      const sid = String(item.storeId).trim().toLowerCase();
      const entry = {
        storeId: sid,
        storeName: item.storeName || LIVE_RADAR_STORE_URLS[sid]?.name || sid,
        url: item.url,
        title: item.title || '',
        sourceRetailer: item.sourceRetailer || null,
        lastPrice: item.lastPrice ? Math.round(Number(item.lastPrice)) : null,
        lastCheckedAt: nowIso,
        updatedAt: nowIso
      };
      current[sid] = entry;
      validToSync.push(entry);
    }

    if (validToSync.length === 0) return current;
    allLocal[cleanSlug] = current;
    await saveLocalProductLinksMap(allLocal);

    const settings = await getSettings();
    const backendUrl = (settings.backendUrl || '').replace(/\/+$/, '');
    if (backendUrl && Date.now() > (getBgDeps().getBackendOfflineUntilTs?.() || 0) && getBgDeps().getBackendAuthHeaders) {
      try {
        await fetchWithTimeout(
          `${backendUrl}/api/price/links`,
          {
            method: 'POST',
            headers: await getBgDeps().getBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ slug: cleanSlug, links: validToSync })
          },
          2000
        );
      } catch (err) {
        console.warn('[LQS] Backend links save failed:', err?.message || err);
        getBgDeps().setBackendOfflineUntilTs?.(Date.now() + 10000);
      }
    }
    return current;
  }

  async function removeRememberedProductLink(slug, storeId) {
    const cleanSlug = String(slug || '').trim().toLowerCase();
    const cleanStore = String(storeId || '').trim().toLowerCase();
    if (!cleanSlug || !cleanStore) return;
    const allLocal = await getLocalProductLinksMap();
    if (allLocal[cleanSlug] && allLocal[cleanSlug][cleanStore]) {
      delete allLocal[cleanSlug][cleanStore];
      await saveLocalProductLinksMap(allLocal);
    }
    const settings = await getSettings();
    const backendUrl = (settings.backendUrl || '').replace(/\/+$/, '');
    if (backendUrl && Date.now() > (getBgDeps().getBackendOfflineUntilTs?.() || 0) && getBgDeps().getBackendAuthHeaders) {
      try {
        await fetchWithTimeout(
          `${backendUrl}/api/price/links/${encodeURIComponent(cleanSlug)}/${encodeURIComponent(cleanStore)}`,
          { method: 'DELETE', headers: await getBgDeps().getBackendAuthHeaders(backendUrl) },
          1800
        );
      } catch (err) {
        console.warn('[LQS] Backend link delete failed:', err?.message || err);
      }
    }
  }

  async function harvestSingleStoreInBackgroundTab(storeId, query, directUrl = null) {
    const cfg = LIVE_RADAR_STORE_URLS[storeId];
    if (!cfg || (!query && !directUrl)) {
      return {
        storeId,
        store: cfg?.name || storeId,
        offers: [],
        usedDirectLink: false,
        diagnostic: { status: 'not_found', reason: 'invalid_query', message: 'Не задан магазин или запрос' }
      };
    }

    const useDirect = Boolean(directUrl && isDirectProductUrl(directUrl, storeId));
    const targetUrl = useDirect ? directUrl : cfg.buildUrl(query);
    let tabId = null;
    try {
      const createdTab = await new Promise((resolve) => {
        chrome.tabs.create({ url: targetUrl, active: false }, (tab) => {
          resolve(chrome.runtime.lastError ? null : tab);
        });
      });
      if (!createdTab || typeof createdTab.id !== 'number') {
        return {
          storeId,
          store: cfg.name,
          offers: [],
          diagnostic: { status: 'error', reason: 'tab_create_failed', message: 'Не удалось открыть фоновую вкладку магазина' }
        };
      }
      tabId = createdTab.id;
      await waitForTabComplete(tabId, 7500);

      // Give SPA stores (Kuper, Perekrestok, Magnit, 5ka, Lenta) time to render search results
      let bestOffers = [];
      let detectedStore = cfg.name;
      let lastDiagnostic = { status: 'not_found', reason: 'not_found', message: 'Товар не найден в выдаче магазина' };
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((r) => setTimeout(r, attempt === 0 ? 1100 : 1000));
        const res = await requestHarvestFromTab(tabId);
        if (res.store) detectedStore = res.store;
        if (res.diagnostic) lastDiagnostic = res.diagnostic;
        if (res.offers.length > bestOffers.length) {
          bestOffers = res.offers;
        }
        if (bestOffers.length >= 6 || (attempt >= 2 && bestOffers.length > 0)) {
          break;
        }
        if (bestOffers.length === 0 && lastDiagnostic.reason === 'captcha') {
          break;
        }
        if (bestOffers.length === 0 && attempt >= 1 && lastDiagnostic.reason === 'needs_address') {
          break;
        }
      }
      const finalDiagnostic = bestOffers.length > 0
        ? { status: 'ok', reason: 'ok', message: '' }
        : lastDiagnostic;
      return { storeId, store: detectedStore, offers: bestOffers, usedDirectLink: useDirect, targetUrl, diagnostic: finalDiagnostic };
    } catch (err) {
      return {
        storeId,
        store: cfg.name,
        offers: [],
        diagnostic: {
          status: 'error',
          reason: 'scan_error',
          message: err?.message || String(err) || 'Ошибка фонового сканирования'
        }
      };
    } finally {
      if (tabId !== null) {
        try {
          chrome.tabs.remove(tabId, () => {
            void chrome.runtime.lastError;
          });
        } catch (closeErr) {
          console.warn('[LQS] Failed to close radar tab:', closeErr?.message || closeErr);
        }
      }
    }
  }

  async function getRadarScanLog() {
    return new Promise((resolve) => {
      chrome.storage.local.get([RADAR_SCAN_LOG_KEY], (res) => {
        const raw = res && res[RADAR_SCAN_LOG_KEY];
        resolve(raw && typeof raw === 'object' ? { ...raw } : {});
      });
    });
  }

  async function saveRadarScanLog(logMap) {
    const entries = Object.entries(logMap || {});
    if (entries.length > MAX_LOCAL_PRICE_DB_ITEMS) {
      entries.sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0));
      logMap = Object.fromEntries(entries.slice(0, MAX_LOCAL_PRICE_DB_ITEMS));
    }
    return new Promise((resolve) => {
      chrome.storage.local.set({ [RADAR_SCAN_LOG_KEY]: logMap }, () => resolve(logMap));
    });
  }

  async function isRadarCacheFresh(slug, nowMs = Date.now(), ttlMs = AUTO_RADAR_TTL_MS) {
    const cleanSlug = String(slug || '').trim().toLowerCase();
    if (!cleanSlug) return { fresh: false, lastRadarScanAt: null, ageMs: null };
    const logMap = await getRadarScanLog();
    const lastTs = Number(logMap[cleanSlug] || 0);
    if (!lastTs || !Number.isFinite(lastTs)) {
      return { fresh: false, lastRadarScanAt: null, ageMs: null };
    }
    const ageMs = Math.max(0, nowMs - lastTs);
    return {
      fresh: ageMs < ttlMs,
      lastRadarScanAt: lastTs,
      ageMs
    };
  }

  async function markRadarScanned(slug, nowMs = Date.now()) {
    const cleanSlug = String(slug || '').trim().toLowerCase();
    if (!cleanSlug) return;
    const logMap = await getRadarScanLog();
    logMap[cleanSlug] = nowMs;
    await saveRadarScanLog(logMap);

    const db = await getLocalPriceDb();
    if (db[cleanSlug]) {
      db[cleanSlug].lastRadarScanAt = new Date(nowMs).toISOString();
      await new Promise((resolve) => chrome.storage.local.set({ [PRICE_DB_KEY]: db }, resolve));
    }
  }

  // Serialized 1-active-scan queue with 15s cooldown between automatic product scans
  let radarActiveScanCount = 0;
  let lastRadarAutoFinishTs = 0;
  let radarQueueChain = Promise.resolve();

  function resetRadarRuntimeState() {
    radarActiveScanCount = 0;
    lastRadarAutoFinishTs = 0;
    radarQueueChain = Promise.resolve();
  }

  async function runSingleBackgroundScanNow(payload = {}) {
    const stopKeepAlive = getBgDeps().startSwKeepAlive ? getBgDeps().startSwKeepAlive() : () => {};
    radarActiveScanCount += 1;
    try {
      const settings = await getSettings();
      const slug = String(payload.slug || '').trim().toLowerCase();
      const title = String(payload.title || '').trim();
      const brand = String(payload.brand || '').trim();
      const amount = String(payload.amount || '').trim();
      const price = payload.price ? Number(payload.price) : null;
      const oldPrice = payload.oldPrice ? Number(payload.oldPrice) : null;
      const accountId = payload.accountId || settings.lavkaAccountLabel || 'Аккаунт #1';
      const imageKey = payload.imageKey || null;
      const isAuto = Boolean(payload.isAuto);
      const forceRefresh = Boolean(payload.forceRefresh);
      const ttlMs = Number(payload.ttlMs) > 0 ? Number(payload.ttlMs) : AUTO_RADAR_TTL_MS;
      const cooldownMs = Number.isFinite(Number(payload.cooldownMs)) ? Number(payload.cooldownMs) : AUTO_RADAR_COOLDOWN_MS;

      if (isAuto && !forceRefresh) {
        if (settings.autoRadarOnProductPage === false) {
          return { ok: true, skipped: true, reason: 'disabled', storesChecked: [], storeDiagnostics: [] };
        }
        const cacheState = await isRadarCacheFresh(slug, Date.now(), ttlMs);
        if (cacheState.fresh) {
          return {
            ok: true,
            skipped: true,
            reason: 'cached_24h',
            lastRadarScanAt: new Date(cacheState.lastRadarScanAt).toISOString(),
            storesChecked: [],
            storeDiagnostics: []
          };
        }
        if (lastRadarAutoFinishTs > 0 && cooldownMs > 0) {
          const waitMs = cooldownMs - (Date.now() - lastRadarAutoFinishTs);
          if (waitMs > 0) {
            await new Promise((r) => setTimeout(r, waitMs));
          }
        }
      }

      const fullQuery = buildFullProductSearchQuery(title, brand, amount);
      if (!fullQuery) {
        return { ok: false, error: 'Не удалось определить название товара для поиска', storeDiagnostics: [] };
      }

      const excludeStoreId = normalizeStoreIdForRadar(payload.excludeStore || '');
      const rawStores = Array.isArray(payload.stores) && payload.stores.length > 0
        ? payload.stores
        : (Array.isArray(settings.liveRadarStores) && settings.liveRadarStores.length > 0
            ? settings.liveRadarStores
            : ['magnit', 'pyaterochka', 'kuper']);
      const selectedStores = rawStores
        .map((s) => normalizeStoreIdForRadar(s) || s)
        .filter((s) => Boolean(LIVE_RADAR_STORE_URLS[s]) && (!excludeStoreId || s !== excludeStoreId))
        .filter((s, idx, arr) => arr.indexOf(s) === idx)
        .slice(0, 3);
      if (selectedStores.length === 0) {
        const fallbackStore = Object.keys(LIVE_RADAR_STORE_URLS).find((id) => id !== excludeStoreId) || 'kuper';
        selectedStores.push(fallbackStore);
      }

      const rememberedLinks = slug ? await getRememberedProductLinks(slug) : {};
      const results = [];
      // Strictly 1 background tab at a time; prefer remembered direct product URLs over search
      for (const storeId of selectedStores) {
        const savedLink = rememberedLinks[storeId]?.url || null;
        let oneRes;
        if (savedLink && isDirectProductUrl(savedLink, storeId)) {
          oneRes = await harvestSingleStoreInBackgroundTab(storeId, fullQuery, savedLink);
          if (oneRes.offers.length === 0 && oneRes.diagnostic?.reason === 'not_found') {
            // Direct product link became stale -> drop it and fall back to search once
            if (slug) await removeRememberedProductLink(slug, storeId);
            oneRes = await harvestSingleStoreInBackgroundTab(storeId, fullQuery, null);
          }
        } else {
          oneRes = await harvestSingleStoreInBackgroundTab(storeId, fullQuery, null);
        }
        results.push(oneRes);
      }

      let harvestedCount = 0;
      let directLinksUsedCount = 0;
      const storesChecked = [];
      const storeDiagnostics = [];
      const newlyMatchedDirectLinks = [];
      let hadNonFatalCheck = false;

      for (const r of results) {
        storesChecked.push(r.store);
        if (r.usedDirectLink) directLinksUsedCount += 1;
        const diag = r.diagnostic || {
          status: r.offers.length > 0 ? 'ok' : 'not_found',
          reason: r.offers.length > 0 ? 'ok' : 'not_found',
          message: ''
        };
        if (diag.reason !== 'tab_error' && diag.reason !== 'tab_create_failed') {
          hadNonFatalCheck = true;
        }
        storeDiagnostics.push({
          storeId: r.storeId,
          store: r.store,
          status: diag.status,
          reason: diag.reason,
          message: diag.message || '',
          offersCount: r.offers.length,
          usedDirectLink: Boolean(r.usedDirectLink)
        });
        if (r.offers.length > 0) {
          harvestedCount += r.offers.length;
          await recordExternalStoreOffers(r.store, r.offers);

          // Remember best matching direct product URL for future 24h refreshes without search
          if (slug && title) {
            const matchingDirect = r.offers
              .filter((o) => o && o.price > 0 && isDirectProductUrl(o.url, r.storeId))
              .filter((o) => {
                const opts = { requireVolume: true };
                if (price && o.price > 0) {
                  opts.targetPrice = price;
                  opts.candidatePrice = o.price;
                }
                const chk = isSearchResultMatchingProduct(o.title || '', o.amount || '', title, amount, opts);
                return chk.isSameProduct && chk.isSameVolume;
              })
              .sort((a, b) => a.price - b.price);
            if (matchingDirect.length > 0) {
              const best = matchingDirect[0];
              newlyMatchedDirectLinks.push({
                storeId: r.storeId,
                storeName: best.store || r.store,
                url: best.url,
                title: best.title || '',
                sourceRetailer: best.sourceRetailer || null,
                lastPrice: best.price
              });
            }
          }
        }
      }

      if (slug && newlyMatchedDirectLinks.length > 0) {
        await saveRememberedProductLinks(slug, newlyMatchedDirectLinks);
      }

      const nowMs = Date.now();
      if (slug && hadNonFatalCheck) {
        await markRadarScanned(slug, nowMs);
      }
      lastRadarAutoFinishTs = nowMs;

      const summary = slug && !excludeStoreId
        ? await getProductPriceIntelligence(slug, title, price, oldPrice, amount, accountId, true, imageKey, brand)
        : null;
      if (summary && slug && hadNonFatalCheck) {
        summary.lastRadarScanAt = new Date(nowMs).toISOString();
      }

      // При запуске радара с внешней сети ищем также лучшую цену в Яндекс Лавке и других сетях
      const comparisons = excludeStoreId
        ? await findLocalComparisonsForStoreProduct({
            store: payload.excludeStore || excludeStoreId,
            title,
            brand,
            amount,
            price
          })
        : null;

      const matchedCount = comparisons
        ? ((comparisons.lavka ? 1 : 0) + (comparisons.otherStores ? comparisons.otherStores.length : 0))
        : (summary && Array.isArray(summary.competitorOffers)
            ? summary.competitorOffers.filter((o) => o && o.price > 0).length
            : 0);

      return {
        ok: true,
        skipped: false,
        isAuto,
        excludeStore: excludeStoreId || null,
        query: fullQuery,
        storesChecked,
        storeDiagnostics,
        directLinksUsedCount,
        harvestedCount,
        matchedCount,
        lastRadarScanAt: slug && hadNonFatalCheck ? new Date(nowMs).toISOString() : null,
        summary,
        comparisons
      };
    } finally {
      radarActiveScanCount = Math.max(0, radarActiveScanCount - 1);
      stopKeepAlive();
    }
  }

  function scanStoresInBackgroundTabs(payload = {}) {
    const task = radarQueueChain.then(
      () => runSingleBackgroundScanNow(payload),
      () => runSingleBackgroundScanNow(payload)
    );
    radarQueueChain = task.catch(() => {});
    return task;
  }


  async function findLocalComparisonsForStoreProduct({ store = '', title = '', brand = '', amount = '', price = null } = {}) {
    const cleanTitle = String(title || '').trim();
    const cleanStore = String(store || '').trim().toLowerCase();
    if (!cleanTitle || cleanTitle.length < 3) {
      return { ok: true, lavka: null, otherStores: [] };
    }

    const numTargetPrice = Number.isFinite(Number(price)) && Number(price) > 0 ? Number(price) : null;
    const [priceDb, extList, backendMatchedExt] = await Promise.all([
      getLocalPriceDb(),
      getExternalStoreOffersList(),
      fetchExternalOffersMatchFromBackend({
        title: cleanTitle,
        brand: brand || '',
        amount: amount || '',
        excludeStore: store || '',
        targetPrice: numTargetPrice
      })
    ]);

    // 1. Find best matching Yandex Lavka entry in local price DB
    let bestLavka = null;
    for (const entry of Object.values(priceDb || {})) {
      if (!entry || !entry.title) continue;
      const candidatePrice = Number(entry.lastPrice || entry.minPrice || 0);
      if (!Number.isFinite(candidatePrice) || candidatePrice <= 0) continue;
      const lavkaMatchOpts = { requireVolume: true };
      if (numTargetPrice) {
        lavkaMatchOpts.targetPrice = numTargetPrice;
        lavkaMatchOpts.candidatePrice = candidatePrice;
      }
      const check = isSearchResultMatchingProduct(entry.title, entry.amount || '', cleanTitle, amount || '', lavkaMatchOpts);
      if (check.isSameProduct && check.isSameVolume) {
        if (!bestLavka || candidatePrice < bestLavka.price) {
          const slug = String(entry.slug || '').trim();
          bestLavka = {
            store: 'Яндекс Лавка',
            slug,
            title: entry.title,
            price: Math.round(candidatePrice),
            minPrice: entry.minPrice ? Math.round(Number(entry.minPrice)) : null,
            url: slug ? `https://lavka.yandex.ru/good/${encodeURIComponent(slug)}` : 'https://lavka.yandex.ru/'
          };
        }
      }
    }

    // 1b. If Lavka not found in local storage, check SQLite /api/price/list when backend is online
    if (!bestLavka && Date.now() > (getBgDeps().getBackendOfflineUntilTs?.() || 0) && typeof getBgDeps().getBackendAuthHeaders === 'function') {
      try {
        const settings = await getSettings();
        const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
        if (backendUrl) {
          const rList = await fetchWithTimeout(
            `${backendUrl}/api/price/list?limit=500`,
            { method: 'GET', headers: await getBgDeps().getBackendAuthHeaders(backendUrl) },
            1200
          );
          if (rList && rList.ok) {
            const jList = await rList.json();
            for (const entry of (jList && Array.isArray(jList.items) ? jList.items : [])) {
              if (!entry || !entry.title) continue;
              const candidatePrice = Number(entry.lastPrice || entry.minPrice || 0);
              if (!Number.isFinite(candidatePrice) || candidatePrice <= 0) continue;
              const check = isSearchResultMatchingProduct(entry.title, entry.amount || '', cleanTitle, amount || '');
              if (check.isSameProduct && check.isSameVolume) {
                if (!bestLavka || candidatePrice < bestLavka.price) {
                  const s = String(entry.slug || '').trim();
                  bestLavka = {
                    store: 'Яндекс Лавка',
                    slug: s,
                    title: entry.title,
                    price: Math.round(candidatePrice),
                    minPrice: entry.minPrice ? Math.round(Number(entry.minPrice)) : null,
                    url: s ? `https://lavka.yandex.ru/good/${encodeURIComponent(s)}` : 'https://lavka.yandex.ru/'
                  };
                }
              }
            }
          }
        }
      } catch {
        // ignore offline backend
      }
    }

    // 2. Find matching external store offers (excluding current store), combining local cache + SQLite + filtering rejected
    const rejectedSet = await getRejectedMatchesForProduct(cleanTitle);
    const localMatchedExt = findMatchingExternalStoreOffersFromList(extList, cleanTitle, amount || '', numTargetPrice);
    const matchedExt = filterRejectedOffers(mergeUniqueStoreOffers(localMatchedExt, backendMatchedExt), rejectedSet);
    const bestByStore = new Map();
    for (const offer of matchedExt) {
      if (!offer || !offer.store || !offer.price) continue;
      const storeKey = String(offer.store).trim().toLowerCase();
      if (cleanStore && storeKey === cleanStore) continue;
      const existing = bestByStore.get(storeKey);
      if (!existing || offer.price < existing.price) {
        bestByStore.set(storeKey, {
          store: offer.store,
          sourceRetailer: offer.sourceRetailer || null,
          price: Math.round(Number(offer.price)),
          oldPrice: offer.oldPrice ? Math.round(Number(offer.oldPrice)) : null,
          url: offer.url || null,
          title: offer.title || ''
        });
      }
    }

    const otherStores = Array.from(bestByStore.values()).sort((a, b) => a.price - b.price);

    // 3. Collect similar offers (different grade/line or different weight/volume) with price per kg/L
    const similarByStore = new Map();
    const numPrice = Number.isFinite(Number(price)) && Number(price) > 0 ? Number(price) : null;
    for (const ext of filterRejectedOffers(extList, rejectedSet)) {
      if (!ext || !ext.title || !ext.price || !ext.store) continue;
      const storeKey = String(ext.store).trim().toLowerCase();
      if (cleanStore && storeKey === cleanStore) continue;
      if (bestByStore.has(storeKey)) continue;
      const chk = isSearchResultMatchingProduct(
        ext.title,
        ext.amount || '',
        cleanTitle,
        amount || '',
        numPrice ? { targetPrice: numPrice, candidatePrice: ext.price } : null
      );
      if (chk && chk.matchQuality === 'similar') {
        const grams = parseVolumeOrWeightGrams(ext.amount || '') || parseVolumeOrWeightGrams(ext.title || '');
        const perUnit = chk.pricePerKgOrL || (computePricePerKgOrLiter ? computePricePerKgOrLiter(ext.price, grams) : null);
        const existingSim = similarByStore.get(storeKey);
        const scoreNew = perUnit || Math.round(Number(ext.price));
        const scoreOld = existingSim ? (existingSim.pricePerKgOrL || existingSim.price) : Infinity;
        if (!existingSim || scoreNew < scoreOld) {
          similarByStore.set(storeKey, {
            store: ext.store,
            sourceRetailer: ext.sourceRetailer || null,
            price: Math.round(Number(ext.price)),
            oldPrice: ext.oldPrice ? Math.round(Number(ext.oldPrice)) : null,
            url: ext.url || null,
            title: ext.title || '',
            amount: ext.amount || '',
            matchQuality: 'similar',
            mismatchReason: chk.mismatchReason || 'similar',
            warning: chk.warning || null,
            pricePerKgOrL: perUnit || null
          });
        }
      }
    }
    const similarStores = Array.from(similarByStore.values())
      .sort((a, b) => (a.pricePerKgOrL || a.price) - (b.pricePerKgOrL || b.price))
      .slice(0, 4);

    return {
      ok: true,
      lavka: bestLavka,
      otherStores,
      similarStores,
      currentPrice: Number.isFinite(Number(price)) ? Math.round(Number(price)) : null
    };
  }

  const api = {
    getMagnitSeedOffers,
    RADAR_16_STORES_CATALOG,
    getCircuitBreakerState,
    saveCircuitBreakerState,
    isCaptchaOrBlockHtml,
    isCircuitOpen,
    recordCircuitSuccess,
    recordCircuitFailure,
    resetCircuitBreakers,
    getRadar16StoresStatus,
    getLocalPriceDb,
    findPriceEntryInDb,
    sanitizeCompetitorOffersForProduct,
    mergePriceRecordIntoEntry,
    recordPricesBatch,
    parsePriceFromLavkaHtml,
    parseFullProductCardFromLavkaHtml,
    probeProductCardMeta,
    getLocalWatchlist,
    getProductPriceHistory,
    toggleWatchlistItem,
    getWatchlistItems,
    checkWatchlistPricesBatch,
    getProductPriceIntelligence,
    getExternalStoreOffersList,
    recordExternalStoreOffers,
    findMatchingExternalStoreOffersFromList,
    mergeUniqueStoreOffers,
    auditCartCompetitorsAndAccounts,
    LIVE_RADAR_STORE_URLS,
    isDirectProductUrl,
    getRememberedProductLinks,
    saveRememberedProductLinks,
    removeRememberedProductLink,
    getRadarScanLog,
    isRadarCacheFresh,
    resetRadarRuntimeState,
    normalizeStoreIdForRadar,
    getRejectedMatchesForProduct,
    rejectCompetitorMatch,
    findLocalComparisonsForStoreProduct,
    scanStoresInBackgroundTabs
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LQS_PRICE_RADAR = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
