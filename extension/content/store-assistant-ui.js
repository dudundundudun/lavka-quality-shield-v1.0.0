/**
 * Lavka Quality Shield — Universal Store Product Assistant UI (content/store-assistant-ui.js)
 * Full-featured Shadow DOM product panel mounted inline inside product cards (with Floating Fallback) on:
 *   - Магнит (magnit.ru)
 *   - Пятёрочка (5ka.ru)
 *   - Перекрёсток / Впрок (perekrestok.ru, vprok.ru)
 *   - ВкусВилл (vkusvill.ru)
 *   - Ашан (auchan.ru)
 *   - Лента (lenta.com)
 *   - Купер (kuper.ru)
 *
 * Features:
 *   - Unit prices (₽/кг, ₽/л, ₽/шт, ₽/100г белка) & expandable "Светофор состава"
 *   - Exact vs Similar price comparisons with "✕ Не тот товар" (LQS_REJECT_COMPETITOR_MATCH)
 *   - Live multi-store radar button ("🔍 Проверить в других магазинах" via LQS_SCAN_STORES_LIVE + excludeStore)
 *   - AI verdict & source links (LQS_GET_CACHED_AI_VERDICT / LQS_ANALYZE_PRODUCT)
 *   - Price history chart (LQS_GET_PRICE_HISTORY + LQS_PRICE_CHART) & Watchlist (LQS_TOGGLE_WATCHLIST)
 *   - Personal 5-star rating, ban button, and short note saved in lqs_reviews_v1
 */
(function (root) {
  'use strict';

  const HOST_ID = 'lqs-store-assistant-host';
  const COLLAPSE_STORAGE_KEY = 'lqs_store_assistant_collapsed';
  const REVIEWS_STORAGE_KEY = (root.LQS_CONFIG && root.LQS_CONFIG.STORAGE_KEYS && root.LQS_CONFIG.STORAGE_KEYS.REVIEWS) || 'lqs_reviews_v1';

  const ASSISTANT_STORES = Object.freeze([
    {
      id: 'magnit',
      store: 'Магнит',
      hostPattern: /(^|\.)magnit\.ru$/i,
      productPathPattern: /\/product\/[^/?#]+/i
    },
    {
      id: 'pyaterochka',
      store: 'Пятёрочка',
      hostPattern: /(^|\.)5ka\.ru$/i,
      productPathPattern: /\/(?:product|goods|item)\/[^/?#]+|\/catalog\/[^?#]*\d{4,}/i
    },
    {
      id: 'perekrestok',
      store: 'Перекрёсток',
      hostPattern: /(^|\.)(perekrestok\.ru|vprok\.ru)$/i,
      productPathPattern: /\/cat\/[^?#]*\/p\/[^/?#]+|\/product\/[^/?#]+/i
    },
    {
      id: 'vkusvill',
      store: 'ВкусВилл',
      hostPattern: /(^|\.)vkusvill\.ru$/i,
      productPathPattern: /\/goods\/[^/?#]+/i
    },
    {
      id: 'auchan',
      store: 'Ашан',
      hostPattern: /(^|\.)auchan\.ru$/i,
      productPathPattern: /\/product\/[^/?#]+/i
    },
    {
      id: 'lenta',
      store: 'Лента',
      hostPattern: /(^|\.)lenta\.com$/i,
      productPathPattern: /\/product\/[^/?#]+/i
    },
    {
      id: 'kuper',
      store: 'Купер',
      hostPattern: /(^|\.)kuper\.ru$/i,
      productPathPattern: /\/products?\/[^/?#]+/i
    }
  ]);

  const STORE_ANCHOR_SELECTORS = Object.freeze({
    magnit: [
      'section.product-details-offer',
      '[class*="product-details-offer" i]',
      '[data-testid*="add-to-cart" i]',
      '[class*="product-buy" i]',
      '[class*="ProductBuy" i]',
      'section.product-details-nutrition-facts',
      '[class*="product-card-price" i]',
      '[class*="product-price" i]',
      '[class*="ProductPrice" i]',
      'button[data-testid="VStepper-button"]'
    ],
    pyaterochka: [
      '[data-testid*="nutrition" i]',
      '[class*="nutrition" i]',
      '[class*="kbju" i]',
      '[class*="EnergyValue" i]',
      'button[data-qa="product-detail-add-to-cart-button"]',
      '[data-qa*="add-to-cart" i]',
      '[data-testid*="add-to-cart" i]',
      '[class*="product-price" i]',
      '[class*="ProductPrice" i]'
    ],
    perekrestok: [
      '[data-testid*="add-to-cart" i]',
      '[class*="product-buy" i]',
      '[class*="ProductBuy" i]',
      '[class*="product-price" i]',
      '[class*="ProductPrice" i]'
    ],
    vkusvill: [
      '[class*="Product__buy" i]',
      '[class*="ProductCard__buy" i]',
      '[class*="Product__price" i]',
      '[data-testid*="add-to-cart" i]',
      '[class*="product-price" i]'
    ],
    auchan: [
      '[data-testid*="add-to-cart" i]',
      '[class*="product-buy" i]',
      '[class*="ProductBuy" i]',
      '[class*="product-price" i]',
      '[class*="ProductPrice" i]'
    ],
    lenta: [
      '[data-testid*="add-to-cart" i]',
      '[class*="sku-price" i]',
      '[class*="product-buy" i]',
      '[class*="product-price" i]',
      '[class*="ProductPrice" i]'
    ],
    kuper: [
      'button[data-qa="add_to_cart_button"]',
      '[data-qa*="add_to_cart" i]',
      '[data-qa*="add-to-cart" i]',
      '[data-testid*="add-to-cart" i]',
      'aside[class*="stickySidebar" i]',
      '[class*="ProductBuy" i]',
      '[class*="product-buy" i]',
      '[class*="ProductPrice" i]',
      '[class*="product-price" i]'
    ]
  });

  function normalizeSpace(text) {
    return String(text || '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function safeUrl(raw) {
    if (root.LQS_UTILS && typeof root.LQS_UTILS.safeHttpUrl === 'function') {
      return root.LQS_UTILS.safeHttpUrl(raw);
    }
    try {
      const u = new URL(String(raw || ''));
      return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null;
    } catch (err) {
      void err;
      return null;
    }
  }

  function detectAssistantStorePage(winLoc) {
    if (!winLoc) return null;
    const hostname = String(winLoc.hostname || '').toLowerCase().trim();
    const pathname = String(winLoc.pathname || '').trim();
    if (!hostname || !pathname) return null;
    for (const entry of ASSISTANT_STORES) {
      if (entry.hostPattern.test(hostname) && entry.productPathPattern.test(pathname)) {
        return { id: entry.id, store: entry.store };
      }
    }
    return null;
  }

  function buildStoreProductKey(product, lavkaSlug = '') {
    if (lavkaSlug && String(lavkaSlug).trim()) {
      return String(lavkaSlug).trim().toLowerCase();
    }
    const rawTitle = normalizeSpace(product?.title || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[^a-zа-я0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80);
    const storeId = String(product?.storeId || product?.store || 'ext').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    return `ext_${storeId}_${rawTitle || 'item'}`;
  }

  function extractPriceFallback(text) {
    if (root.LQS_STORE_HARVESTER && typeof root.LQS_STORE_HARVESTER.extractPricePairFromText === 'function') {
      return root.LQS_STORE_HARVESTER.extractPricePairFromText(text);
    }
    const normalized = normalizeSpace(text)
      .replace(/(\d)\s+([.,]\d{1,2})\s*(?=(?:₽|рубл(?:ей|я|ь)|руб\.?))/gi, '$1$2 ')
      .replace(/(^|[^\d.,])(\d{1,5}(?:\s\d{3})?)\s+(\d{2})\s*(?=(?:₽|рубл(?:ей|я|ь)|руб\.?))/gi, '$1$2.$3 ');
    const clean = normalized.replace(
      /\d+(?:[.,]\d{1,2})?\s*(?:₽|рубл(?:ей|я|ь)|руб\.?)\s*(?:\/\s*(?:кг|л|шт|100\s*г)|за\s*(?:кг|л|шт|100\s*г))/gi,
      ' '
    );
    const matchObjs = Array.from(clean.matchAll(/(\d{1,5}(?:\s?\d{3})?(?:[.,]\d{1,2})?)\s*(?:₽|рубл(?:ей|я|ь)|руб\.?)/gi))
      .map((m) => ({
        val: parseFloat(m[1].replace(/\s+/g, '').replace(',', '.')),
        idx: m.index || 0
      }))
      .filter((o) => Number.isFinite(o.val) && o.val >= 10 && o.val <= 25000);
    if (matchObjs.length === 0) return null;
    const first = matchObjs[0].val;
    const second = matchObjs.length > 1 ? matchObjs[1].val : null;
    if (second !== null && first > second && first <= second * 3.5) {
      const prefixBeforeFirst = clean.slice(Math.max(0, matchObjs[0].idx - 24), matchObjs[0].idx);
      if (/(?:старая\s+цена|без\s+скидки|было)/i.test(prefixBeforeFirst)) {
        return { price: Math.round(second), oldPrice: Math.round(first) };
      }
    }
    const price = Math.round(first);
    const oldPrice = second !== null && second > first && second <= first * 3.5
      ? Math.round(second)
      : null;
    return { price, oldPrice };
  }

  function extractWeightFallback(text) {
    if (root.LQS_STORE_HARVESTER && typeof root.LQS_STORE_HARVESTER.extractWeightFromText === 'function') {
      return root.LQS_STORE_HARVESTER.extractWeightFromText(text);
    }
    const m = String(text || '').match(/(\d+(?:[.,]\d+)?\s*(?:г|гр|кг|мл|л|шт)(?![а-яёa-z]))/i);
    return m ? m[1].trim() : '';
  }

  function readJsonLdProduct(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    for (let i = 0; i < scripts.length; i++) {
      const raw = scripts[i]?.textContent || '';
      if (!raw || raw.length > 200000) continue;
      try {
        const parsed = JSON.parse(raw);
        const nodes = Array.isArray(parsed) ? parsed : [parsed];
        for (const node of nodes) {
          if (!node || typeof node !== 'object') continue;
          const t = String(node['@type'] || '').toLowerCase();
          if (!t.includes('product')) continue;
          const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
          const priceNum = Number(offer?.price || offer?.lowPrice || 0);
          const brandName = typeof node.brand === 'string'
            ? normalizeSpace(node.brand)
            : normalizeSpace(node.brand?.name || '');
          return {
            title: normalizeSpace(node.name || ''),
            brand: brandName,
            price: Number.isFinite(priceNum) && priceNum >= 10 && priceNum <= 25000 ? Math.round(priceNum) : null,
            description: normalizeSpace(node.description || '')
          };
        }
      } catch (err) {
        void err;
      }
    }
    return null;
  }

  function extractIngredientsFromStoreDoc(doc) {
    if (!doc) return '';

    if (typeof doc.querySelectorAll === 'function') {
      const selectors = [
        '[data-testid*="composition" i]',
        '[data-testid*="ingredient" i]',
        '[data-qa*="composition" i]',
        '[data-qa*="ingredient" i]',
        '[itemprop="ingredients"]',
        '[class*="composition" i]',
        '[class*="ingredient" i]'
      ];
      for (const sel of selectors) {
        const nodes = doc.querySelectorAll(sel);
        for (let i = 0; i < nodes.length; i++) {
          const txt = normalizeSpace(nodes[i]?.textContent || '');
          const cleaned = txt.replace(/^состав\s*[:\-–—]?\s*/i, '').trim();
          if (cleaned.length >= 10 && cleaned.length <= 2000 && !/^(показать|скрыть|подробнее)/i.test(cleaned)) {
            return cleaned;
          }
        }
      }

      const labelNodes = doc.querySelectorAll('h2, h3, h4, dt, th, span, div, p');
      const maxScan = Math.min(labelNodes.length, 300);
      for (let i = 0; i < maxScan; i++) {
        const el = labelNodes[i];
        const label = normalizeSpace(el?.textContent || '');
        if (!/^состав:?$/i.test(label)) continue;
        const sib = el.nextElementSibling;
        if (sib) {
          const sibText = normalizeSpace(sib.textContent || '');
          if (sibText.length >= 10 && sibText.length <= 2000) {
            return sibText;
          }
        }
      }
    }

    const mainScope = (typeof doc.querySelector === 'function' ? doc.querySelector('main') : null) || doc.body;
    const rawBody = String(mainScope?.innerText || mainScope?.textContent || '');
    const m = rawBody.match(/(?:^|\n|\s)Состав\s*[:\-–—]?\s*\n?\s*([^\n]{10,1200})/i);
    if (m && m[1]) {
      const candidate = normalizeSpace(m[1])
        .split(/\b(?:Условия хранения|Пищевая ценность|Энергетическая ценность|Срок годности|Бренд|Страна|Производитель)\b/i)[0]
        .trim();
      if (candidate.length >= 10) return candidate;
    }

    return '';
  }

  function extractProteinFromStoreDoc(doc) {
    const mainScope = (doc && typeof doc.querySelector === 'function' ? doc.querySelector('main') : null) || doc?.body;
    const text = normalizeSpace((mainScope?.innerText || mainScope?.textContent || '').slice(0, 6000));
    const m = text.match(/белк[иа]\s*[:\-–—]?\s*(\d+(?:[.,]\d+)?)\s*(?:г(?![а-яёa-z])|(?=\s|$|[,;|]))/i)
      || text.match(/(?:^|[^\d.,])(\d+(?:[.,]\d+)?)\s*г\s+белк[иа](?![а-яёa-z])/i);
    if (!m) return null;
    const val = parseFloat(m[1].replace(',', '.'));
    return Number.isFinite(val) && val >= 0 && val <= 100 ? val : null;
  }

  function extractStoreProductFromDoc(doc, winLoc, storeInfo) {
    if (!doc || !winLoc || !storeInfo) return null;
    const ld = readJsonLdProduct(doc);
    const h1 = typeof doc.querySelector === 'function' ? doc.querySelector('h1') : null;
    const titleFromH1 = normalizeSpace(h1?.textContent || '');
    const rawDocTitle = normalizeSpace(String(doc.title || '').split(/[—|–]/)[0] || '');
    const titleFromDoc = /^доставка\s+продуктов\s+на\s+дом/i.test(rawDocTitle) ? '' : rawDocTitle;
    const title = (titleFromH1.length >= 3 ? titleFromH1 : '') || (ld?.title || '') || titleFromDoc;

    if (!title || title.length < 3) return null;

    let pricePair = null;
    if (typeof doc.querySelectorAll === 'function') {
      const priceSelectors = [
        '[data-testid*="price" i]',
        '[data-qa*="price" i]',
        '[itemprop="price"]',
        '[class*="product-price" i]',
        '[class*="ProductPrice" i]',
        '[class*="price-new" i]',
        '[class*="current-price" i]'
      ];
      for (const sel of priceSelectors) {
        const nodes = doc.querySelectorAll(sel);
        for (let i = 0; i < Math.min(nodes.length, 10); i++) {
          const txt = normalizeSpace(nodes[i]?.textContent || nodes[i]?.getAttribute?.('content') || '');
          const pr = extractPriceFallback(txt);
          if (pr) {
            pricePair = pr;
            break;
          }
        }
        if (pricePair) break;
      }
    }

    if (!pricePair && ld?.price) {
      pricePair = { price: ld.price, oldPrice: null };
    }

    const mainScope = (typeof doc.querySelector === 'function' ? doc.querySelector('main') : null) || doc.body;
    const mainSnippet = normalizeSpace((mainScope?.innerText || mainScope?.textContent || '').slice(0, 2200));

    if (!pricePair) {
      pricePair = extractPriceFallback(mainSnippet);
    }

    if (!pricePair || !pricePair.price) return null;

    let amount = extractWeightFallback(title);
    if (!amount && typeof doc.querySelectorAll === 'function') {
      const weightNodes = doc.querySelectorAll('[class*="weight" i], [class*="volume" i], [data-testid*="weight" i]');
      for (let i = 0; i < Math.min(weightNodes.length, 8); i++) {
        const w = extractWeightFallback(weightNodes[i]?.textContent || '');
        if (w) {
          amount = w;
          break;
        }
      }
    }
    if (!amount) {
      const weightSpec = mainSnippet.match(/(?:вес|масса(?:\s+нетто)?|объ[её]м|фасовка)\s*[:\-–—]?\s*(\d+(?:[.,]\d+)?\s*(?:г|гр|кг|мл|л|шт)(?![а-яёa-z]))/i);
      if (weightSpec) amount = weightSpec[1].trim();
    }

    let brand = ld?.brand || '';
    if (!brand && typeof doc.querySelector === 'function') {
      const brandNode = doc.querySelector('[itemprop="brand"], [data-testid*="brand" i]');
      if (brandNode) {
        brand = normalizeSpace(brandNode.getAttribute?.('content') || brandNode.textContent || '');
      }
    }

    const ingredients = extractIngredientsFromStoreDoc(doc);
    const proteinPer100g = extractProteinFromStoreDoc(doc);

    return {
      storeId: storeInfo.id,
      store: storeInfo.store,
      title,
      brand,
      amount,
      price: pricePair.price,
      oldPrice: pricePair.oldPrice || null,
      ingredients,
      proteinPer100g,
      url: String(winLoc.href || '')
    };
  }

  /**
   * Ищет оптимальный якорь внутри карточки товара для встроенного рендера (Inline Mount).
   * Если якорь не найден (или у него нет parentElement) — возвращает null (включается Floating Fallback).
   */
  function findInlineMountAnchor(doc, storeId) {
    if (!doc) return null;

    // 1. Для Пятёрочки приоритет — секция «Пищевая ценность на 100 г» (перед «Описанием»)
    if (storeId === 'pyaterochka' && typeof doc.querySelectorAll === 'function') {
      const headings = doc.querySelectorAll('h2, h3, h4, section, div');
      const limit = Math.min(headings.length, 800);
      for (let i = 0; i < limit; i++) {
        const node = headings[i];
        const txt = normalizeSpace(node?.textContent || '');
        if (txt.length >= 12 && txt.length <= 260 && /пищевая\s+ценность/i.test(txt)) {
          const target = (typeof node.closest === 'function' ? node.closest('section, article, div[class]') : null) || node;
          if (target && target.parentElement && target.parentElement !== doc.documentElement) {
            return { element: target, position: 'after', mode: 'inline', strategy: 'pyaterochka_nutrition' };
          }
        }
      }
    }

    // 2. Магазин-специфичные селекторы (блок цены / кнопки «В корзину» / КБЖУ)
    const selectors = STORE_ANCHOR_SELECTORS[storeId] || STORE_ANCHOR_SELECTORS.perekrestok;
    if (typeof doc.querySelector === 'function') {
      for (const sel of selectors) {
        let el = null;
        try {
          el = doc.querySelector(sel);
        } catch (err) {
          void err;
          el = null;
        }
        if (el && el.parentElement && el.parentElement !== doc.documentElement) {
          return { element: el, position: 'after', mode: 'inline', strategy: sel };
        }
      }

      // 3. Универсальный резервный якорь карточки — заголовок <h1>
      const h1 = doc.querySelector('h1');
      if (h1 && h1.parentElement && h1.parentElement !== doc.documentElement) {
        return { element: h1, position: 'after', mode: 'inline', strategy: 'h1' };
      }
    }

    return null;
  }

  function buildStoreAssistantModel(product, comparisonData = null) {
    if (!product || !product.title || !product.price) return null;

    const parser = root.LQS_PRICE_PARSER;
    const unitInfo = parser && typeof parser.computeUnitPrices === 'function'
      ? parser.computeUnitPrices({
          price: product.price,
          amountText: product.amount || '',
          title: product.title,
          proteinPer100g: product.proteinPer100g
        })
      : { pricePerKg: null, unitLabel: 'кг', pricePerPiece: null, pieceUnitLabel: 'шт', pricePer100gProtein: null };

    const unitBadges = [];
    if (unitInfo.pricePerKg) {
      unitBadges.push(`${unitInfo.pricePerKg} ₽/${unitInfo.unitLabel || 'кг'}`);
    }
    if (unitInfo.pricePerPiece) {
      unitBadges.push(`${unitInfo.pricePerPiece} ₽/${unitInfo.pieceUnitLabel || 'шт'}`);
    }
    if (unitInfo.pricePer100gProtein) {
      unitBadges.push(`${unitInfo.pricePer100gProtein} ₽/100г белка`);
    }

    const guard = root.LQS_INGREDIENTS_GUARD;
    const trafficLight = guard && typeof guard.analyzeIngredientsTrafficLight === 'function'
      ? guard.analyzeIngredientsTrafficLight(product.ingredients || '', product.title)
      : { level: 'none', emoji: '⚪', badgeText: '', summary: 'Состав на карточке не указан', redFlags: [], yellowFlags: [], allFlags: [] };

    const lavkaMatch = comparisonData && comparisonData.lavka ? comparisonData.lavka : null;
    const otherStores = Array.isArray(comparisonData?.otherStores) ? comparisonData.otherStores.slice(0, 6) : [];
    const rawSimilar = Array.isArray(comparisonData?.similarStores) ? comparisonData.similarStores.slice(0, 4) : [];

    const allCompared = [];
    if (lavkaMatch && lavkaMatch.price > 0) {
      allCompared.push({
        store: 'Яндекс Лавка',
        price: Math.round(lavkaMatch.price),
        url: safeUrl(lavkaMatch.url),
        title: lavkaMatch.title || product.title,
        slug: lavkaMatch.slug || '',
        titleHint: lavkaMatch.minPrice && lavkaMatch.minPrice < lavkaMatch.price
          ? `Мин. цена в Лавке: ${Math.round(lavkaMatch.minPrice)} ₽`
          : 'Цена из локальной базы Яндекс Лавки'
      });
    }
    for (const o of otherStores) {
      if (!o || !o.store || !o.price) continue;
      const hint = o.store === 'Купер' && o.sourceRetailer
        ? `Через Купер (магазин: ${o.sourceRetailer})`
        : `${o.store} — из локальной базы`;
      allCompared.push({
        store: o.store,
        price: Math.round(o.price),
        url: safeUrl(o.url),
        title: o.title || '',
        titleHint: hint
      });
    }
    allCompared.sort((a, b) => a.price - b.price);

    const similarOffers = [];
    for (const s of rawSimilar) {
      if (!s || !s.store || !s.price) continue;
      const hintParts = [];
      if (s.title) hintParts.push(s.title);
      if (s.warning) hintParts.push(s.warning);
      similarOffers.push({
        store: s.store,
        price: Math.round(s.price),
        pricePerKgOrL: s.pricePerKgOrL ? Math.round(s.pricePerKgOrL) : null,
        url: safeUrl(s.url),
        title: s.title || '',
        warning: s.warning || null,
        mismatchReason: s.mismatchReason || 'similar',
        titleHint: hintParts.join(' · ') || 'Похожий вариант (другой сорт/фасовка)'
      });
    }

    let comparisonStatus = 'empty';
    let comparisonHeadline = 'Пока нет в базе — нажмите «Проверить в других магазинах»';

    if (allCompared.length > 0) {
      const best = allCompared[0];
      const diff = product.price - best.price;
      if (diff > 2) {
        comparisonStatus = 'cheaper_elsewhere';
        comparisonHeadline = `Дешевле в ${best.store}: ${best.price} ₽ (на ${diff} ₽ ниже)`;
      } else if (diff < -2) {
        comparisonStatus = 'best_here';
        comparisonHeadline = `Выгоднее, чем в ${best.store} на ${Math.abs(diff)} ₽`;
      } else {
        comparisonStatus = 'same_price';
        comparisonHeadline = `Цена как в ${best.store} (${best.price} ₽)`;
      }
    }

    const reviewKey = buildStoreProductKey(product, lavkaMatch?.slug || '');

    return {
      storeId: product.storeId || '',
      store: product.store,
      title: product.title,
      brand: product.brand || '',
      price: product.price,
      oldPrice: product.oldPrice,
      amount: product.amount || '',
      ingredients: product.ingredients || '',
      url: product.url || '',
      slug: lavkaMatch?.slug || reviewKey,
      reviewKey,
      unitInfo,
      unitBadges,
      trafficLight,
      comparedOffers: allCompared,
      similarOffers,
      comparisonStatus,
      comparisonHeadline
    };
  }

  const WIDGET_STYLES = `
    :host {
      --lqs-bg: #ffffff;
      --lqs-surface: #f5f4f2;
      --lqs-border: #e5e2dc;
      --lqs-text: #21201f;
      --lqs-muted: #6e6b66;
      --lqs-accent: #fce000;
      --lqs-accent-text: #21201f;
      --lqs-green-bg: #e9f7ef;
      --lqs-green-text: #146c43;
      --lqs-yellow-bg: #fff8dc;
      --lqs-yellow-text: #856404;
      --lqs-red-bg: #fdecec;
      --lqs-red-text: #b42318;
      --lqs-radius: 14px;
      --lqs-shadow: 0 10px 28px rgba(33, 32, 31, 0.16);
      all: initial;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: var(--lqs-text);
    }
    :host([data-lqs-mount-mode="floating"]) {
      position: fixed;
      left: 16px;
      bottom: 16px;
      z-index: 2147483000;
      width: 344px;
      max-width: calc(100vw - 32px);
    }
    :host([data-lqs-mount-mode="inline"]) {
      display: block;
      position: static;
      width: 100%;
      max-width: 540px;
      margin: 12px 0;
    }
    .card {
      width: 100%;
      background: var(--lqs-bg);
      border: 1px solid var(--lqs-border);
      border-radius: var(--lqs-radius);
      box-shadow: var(--lqs-shadow);
      overflow: hidden;
      font-size: 12.5px;
      line-height: 1.42;
      box-sizing: border-box;
    }
    :host([data-lqs-mount-mode="inline"]) .card {
      box-shadow: 0 4px 16px rgba(33, 32, 31, 0.08);
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 12px;
      background: var(--lqs-accent);
      color: var(--lqs-accent-text);
      font-weight: 700;
      font-size: 12.5px;
    }
    .header-title {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .toggle-btn {
      appearance: none;
      border: none;
      background: rgba(33, 32, 31, 0.1);
      color: var(--lqs-accent-text);
      border-radius: 8px;
      padding: 2px 8px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
    }
    .toggle-btn:hover { background: rgba(33, 32, 31, 0.18); }
    .body {
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .body.is-collapsed { display: none; }
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      background: var(--lqs-surface);
      color: var(--lqs-text);
    }
    .pill-unit { background: #21201f; color: #fce000; }
    .pill-green { background: var(--lqs-green-bg); color: var(--lqs-green-text); }
    .pill-yellow { background: var(--lqs-yellow-bg); color: var(--lqs-yellow-text); }
    .pill-red { background: var(--lqs-red-bg); color: var(--lqs-red-text); }
    .pill-muted { background: var(--lqs-surface); color: var(--lqs-muted); font-weight: 500; }
    .pill-btn { border: none; cursor: pointer; font-family: inherit; }
    .flags-box {
      background: var(--lqs-surface);
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 11.5px;
      color: var(--lqs-text);
      display: none;
    }
    .flags-box.is-open { display: block; }
    .section-box {
      background: var(--lqs-surface);
      border-radius: 10px;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .section-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--lqs-muted);
    }
    .compare-headline {
      font-weight: 700;
      font-size: 12.5px;
      color: var(--lqs-text);
    }
    .compare-headline.is-best { color: var(--lqs-green-text); }
    .compare-headline.is-cheaper { color: var(--lqs-red-text); }
    .compare-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .compare-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-size: 12px;
    }
    .compare-left {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      overflow: hidden;
    }
    .compare-right {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .compare-link {
      color: var(--lqs-text);
      text-decoration: underline;
      text-underline-offset: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .compare-price { font-weight: 700; white-space: nowrap; }
    .compare-meta { font-size: 11px; color: var(--lqs-muted); white-space: nowrap; }
    .reject-btn {
      appearance: none;
      border: 1px solid var(--lqs-border);
      background: #fff;
      color: var(--lqs-muted);
      border-radius: 6px;
      padding: 1px 5px;
      font-size: 10.5px;
      font-weight: 700;
      cursor: pointer;
      line-height: 1.3;
    }
    .reject-btn:hover { background: var(--lqs-red-bg); color: var(--lqs-red-text); border-color: #f3c1be; }
    .action-btn {
      appearance: none;
      border: 1px solid var(--lqs-border);
      background: #ffffff;
      color: var(--lqs-text);
      border-radius: 8px;
      padding: 5px 9px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    .action-btn:hover { background: #efede8; }
    .action-btn.is-primary { background: #21201f; color: #fce000; border-color: #21201f; }
    .action-btn.is-primary:hover { background: #363432; }
    .action-btn.is-active { background: var(--lqs-red-bg); color: var(--lqs-red-text); border-color: #f3c1be; }
    .action-btn:disabled { opacity: 0.6; cursor: default; }
    .ai-verdict {
      font-size: 12px;
      white-space: pre-wrap;
      color: var(--lqs-text);
      max-height: 180px;
      overflow-y: auto;
    }
    .ai-sources {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      font-size: 11px;
    }
    .chart-box {
      display: none;
      background: #fff;
      border: 1px solid var(--lqs-border);
      border-radius: 8px;
      padding: 6px 8px;
    }
    .chart-box.is-open { display: block; }
    .personal-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      flex-wrap: wrap;
    }
    .stars { display: inline-flex; gap: 2px; }
    .star-btn {
      appearance: none;
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 15px;
      padding: 0 2px;
      color: #c7c3bc;
    }
    .star-btn.is-on { color: #f59e0b; }
    .note-row {
      display: flex;
      gap: 6px;
      width: 100%;
    }
    .note-input {
      flex: 1;
      min-width: 0;
      border: 1px solid var(--lqs-border);
      border-radius: 7px;
      padding: 4px 8px;
      font-size: 12px;
      font-family: inherit;
      background: #fff;
      color: var(--lqs-text);
    }
    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; animation: none !important; }
    }
  `;

  function applyShadowStyles(shadowRoot, doc) {
    try {
      if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in shadowRoot) {
        const sheet = new CSSStyleSheet();
        if (typeof sheet.replaceSync === 'function') {
          sheet.replaceSync(WIDGET_STYLES);
          shadowRoot.adoptedStyleSheets = [sheet];
          return;
        }
      }
    } catch (err) {
      void err;
    }
    const styleEl = doc.createElement('style');
    styleEl.textContent = WIDGET_STYLES;
    shadowRoot.appendChild(styleEl);
  }

  function removeStoreAssistantWidget(doc) {
    if (!doc || typeof doc.getElementById !== 'function') return;
    const existing = doc.getElementById(HOST_ID);
    if (existing && typeof existing.remove === 'function') {
      existing.remove();
    }
  }

  function mountHostElement(doc, host, storeId) {
    const anchor = findInlineMountAnchor(doc, storeId);
    if (anchor && anchor.element && anchor.element.parentElement) {
      host.setAttribute('data-lqs-mount-mode', 'inline');
      host.setAttribute('data-lqs-anchor-strategy', anchor.strategy || 'inline');
      const parent = anchor.element.parentElement;
      if (typeof parent.insertBefore === 'function') {
        const refNode = anchor.position === 'before' ? anchor.element : (anchor.element.nextElementSibling || null);
        parent.insertBefore(host, refNode);
        return 'inline';
      }
      if (typeof parent.appendChild === 'function') {
        parent.appendChild(host);
        return 'inline';
      }
    }
    host.setAttribute('data-lqs-mount-mode', 'floating');
    host.setAttribute('data-lqs-anchor-strategy', 'floating_fallback');
    doc.body.appendChild(host);
    return 'floating';
  }

  function loadPersonalReview(reviewKey, cb) {
    if (!reviewKey || typeof chrome === 'undefined' || !chrome.storage?.local) {
      cb(null);
      return;
    }
    try {
      chrome.storage.local.get([REVIEWS_STORAGE_KEY], (res) => {
        const db = res && res[REVIEWS_STORAGE_KEY] && typeof res[REVIEWS_STORAGE_KEY] === 'object'
          ? res[REVIEWS_STORAGE_KEY]
          : {};
        cb(db[reviewKey] || null);
      });
    } catch (err) {
      void err;
      cb(null);
    }
  }

  function savePersonalReview(reviewKey, title, patch, cb) {
    if (!reviewKey || typeof chrome === 'undefined' || !chrome.storage?.local) {
      if (cb) cb(null);
      return;
    }
    try {
      chrome.storage.local.get([REVIEWS_STORAGE_KEY], (res) => {
        const db = res && res[REVIEWS_STORAGE_KEY] && typeof res[REVIEWS_STORAGE_KEY] === 'object'
          ? { ...res[REVIEWS_STORAGE_KEY] }
          : {};
        const prev = db[reviewKey] || {};
        const merged = {
          ...prev,
          ...patch,
          slug: reviewKey,
          title: title || prev.title || '',
          updatedAt: new Date().toISOString()
        };
        const isEmpty = !merged.rating && !merged.banned && (!merged.note || !String(merged.note).trim());
        if (isEmpty) {
          delete db[reviewKey];
        } else {
          db[reviewKey] = merged;
        }
        chrome.storage.local.set({ [REVIEWS_STORAGE_KEY]: db }, () => {
          if (cb) cb(isEmpty ? null : merged);
        });
      });
    } catch (err) {
      void err;
      if (cb) cb(null);
    }
  }

  function renderOfferRow(doc, offer, isSimilar, onReject) {
    const item = doc.createElement('div');
    item.className = 'compare-item';
    if (offer.titleHint) item.title = offer.titleHint;

    const left = doc.createElement('div');
    left.className = 'compare-left';

    if (offer.url) {
      const link = doc.createElement('a');
      link.className = 'compare-link';
      link.href = offer.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = offer.store;
      left.appendChild(link);
    } else {
      const nameSpan = doc.createElement('span');
      nameSpan.textContent = offer.store;
      left.appendChild(nameSpan);
    }

    if (isSimilar && offer.warning) {
      const warnSpan = doc.createElement('span');
      warnSpan.className = 'compare-meta';
      warnSpan.textContent = `(${offer.warning})`;
      left.appendChild(warnSpan);
    }

    const right = doc.createElement('div');
    right.className = 'compare-right';

    const priceSpan = doc.createElement('span');
    priceSpan.className = 'compare-price';
    priceSpan.textContent = isSimilar && offer.pricePerKgOrL
      ? `${offer.price} ₽ (~${offer.pricePerKgOrL} ₽/кг)`
      : `${offer.price} ₽`;
    right.appendChild(priceSpan);

    const rejectBtn = doc.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'reject-btn';
    rejectBtn.setAttribute('data-action', 'reject-match');
    rejectBtn.setAttribute('aria-label', `Не тот товар: ${offer.store}`);
    rejectBtn.title = 'Не тот товар — скрыть навсегда';
    rejectBtn.textContent = '✕';
    rejectBtn.addEventListener('click', () => {
      if (typeof onReject === 'function') {
        onReject(offer, item);
      }
    });
    right.appendChild(rejectBtn);

    item.appendChild(left);
    item.appendChild(right);
    return item;
  }

  function renderStoreAssistantWidget(doc, model, options = {}) {
    if (!doc || !doc.body || !model) return null;

    let host = typeof doc.getElementById === 'function' ? doc.getElementById(HOST_ID) : null;
    let shadow = host ? host.shadowRoot : null;

    if (!host) {
      host = doc.createElement('div');
      host.id = HOST_ID;
      host.setAttribute('data-lqs-store', model.store || '');
      if (typeof host.attachShadow === 'function') {
        shadow = host.attachShadow({ mode: 'open' });
        applyShadowStyles(shadow, doc);
      } else {
        shadow = host;
      }
      mountHostElement(doc, host, model.storeId || '');
    } else {
      host.setAttribute('data-lqs-store', model.store || '');
    }

    while (shadow.firstChild) {
      if (shadow.firstChild.tagName === 'STYLE') {
        const next = shadow.firstChild.nextSibling;
        if (!next) break;
        shadow.removeChild(next);
      } else {
        shadow.removeChild(shadow.firstChild);
      }
    }

    let isCollapsed = false;
    try {
      isCollapsed = typeof sessionStorage !== 'undefined' && sessionStorage.getItem(COLLAPSE_STORAGE_KEY) === '1';
    } catch (err) {
      void err;
    }

    const card = doc.createElement('section');
    card.className = 'card';
    card.setAttribute('aria-label', 'Помощник Lavka Quality Shield');

    // Header
    const header = doc.createElement('div');
    header.className = 'header';

    const headerTitle = doc.createElement('span');
    headerTitle.className = 'header-title';
    headerTitle.textContent = `🛡️ Lavka Shield · ${model.store}`;

    const toggleBtn = doc.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'toggle-btn';
    toggleBtn.setAttribute('aria-expanded', String(!isCollapsed));
    toggleBtn.textContent = isCollapsed ? 'Показать' : 'Свернуть';

    header.appendChild(headerTitle);
    header.appendChild(toggleBtn);
    card.appendChild(header);

    // Body
    const body = doc.createElement('div');
    body.className = isCollapsed ? 'body is-collapsed' : 'body';

    // 1. Metrics & expandable traffic light
    const unitRow = doc.createElement('div');
    unitRow.className = 'row';
    if (model.unitBadges.length > 0) {
      for (const badgeText of model.unitBadges) {
        const pill = doc.createElement('span');
        pill.className = 'pill pill-unit';
        pill.textContent = badgeText;
        unitRow.appendChild(pill);
      }
    } else {
      const pill = doc.createElement('span');
      pill.className = 'pill pill-muted';
      pill.textContent = `${model.price} ₽ · вес не указан`;
      unitRow.appendChild(pill);
    }

    const tl = model.trafficLight;
    let flagsBox = null;
    if (tl && tl.level && tl.level !== 'none') {
      const hasFlags = Array.isArray(tl.allFlags) && tl.allFlags.length > 0;
      const tlEl = doc.createElement(hasFlags ? 'button' : 'span');
      if (hasFlags) tlEl.type = 'button';
      tlEl.className = `pill pill-${tl.level}${hasFlags ? ' pill-btn' : ''}`;
      tlEl.textContent = tl.badgeText || `${tl.emoji} Состав проверен`;
      tlEl.title = tl.summary || '';
      unitRow.appendChild(tlEl);

      if (hasFlags) {
        flagsBox = doc.createElement('div');
        flagsBox.className = 'flags-box';
        const labels = tl.allFlags.map((f) => (typeof f === 'string' ? f : (f.label || f.name || ''))).filter(Boolean);
        flagsBox.textContent = `Найдено в составе: ${labels.join(', ')}`;
        tlEl.addEventListener('click', () => {
          flagsBox.classList.toggle('is-open');
        });
      }
    }
    body.appendChild(unitRow);
    if (flagsBox) body.appendChild(flagsBox);

    // 2. Price comparison section (Exact + Similar + Live Radar button)
    const compareBox = doc.createElement('div');
    compareBox.className = 'section-box';

    const headline = doc.createElement('div');
    headline.className = 'compare-headline';
    if (model.comparisonStatus === 'best_here') headline.className += ' is-best';
    if (model.comparisonStatus === 'cheaper_elsewhere') headline.className += ' is-cheaper';
    headline.textContent = model.comparisonHeadline;
    compareBox.appendChild(headline);

    const handleReject = (offer, rowEl) => {
      if (rowEl && typeof rowEl.remove === 'function') rowEl.remove();
      if (typeof options.onRejectMatch === 'function') {
        options.onRejectMatch(offer, model);
        return;
      }
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        chrome.runtime.sendMessage({
          type: 'LQS_REJECT_COMPETITOR_MATCH',
          payload: {
            sourceTitle: model.title,
            sourceSlug: model.slug,
            rejectedUrl: offer.url || '',
            rejectedTitle: offer.title || offer.store || ''
          }
        });
      }
    };

    if (model.comparedOffers.length > 0) {
      const exactLabel = doc.createElement('div');
      exactLabel.className = 'section-label';
      exactLabel.textContent = 'Точные совпадения';
      compareBox.appendChild(exactLabel);

      const list = doc.createElement('div');
      list.className = 'compare-list';
      for (const offer of model.comparedOffers) {
        list.appendChild(renderOfferRow(doc, offer, false, handleReject));
      }
      compareBox.appendChild(list);
    }

    if (Array.isArray(model.similarOffers) && model.similarOffers.length > 0) {
      const simLabel = doc.createElement('div');
      simLabel.className = 'section-label';
      simLabel.textContent = 'Похожие (другой сорт/фасовка)';
      compareBox.appendChild(simLabel);

      const simList = doc.createElement('div');
      simList.className = 'compare-list';
      for (const sim of model.similarOffers) {
        simList.appendChild(renderOfferRow(doc, sim, true, handleReject));
      }
      compareBox.appendChild(simList);
    }

    const scanBtn = doc.createElement('button');
    scanBtn.type = 'button';
    scanBtn.className = 'action-btn is-primary';
    scanBtn.setAttribute('data-action', 'scan-stores');
    scanBtn.textContent = '🔍 Проверить в других магазинах';
    scanBtn.addEventListener('click', () => {
      if (typeof options.onScanStores === 'function') {
        options.onScanStores(model, scanBtn);
        return;
      }
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        scanBtn.disabled = true;
        scanBtn.textContent = '⏳ Ищем цены в других сетях...';
        chrome.runtime.sendMessage(
          {
            type: 'LQS_SCAN_STORES_LIVE',
            payload: {
              slug: model.slug,
              title: model.title,
              brand: model.brand,
              amount: model.amount,
              price: model.price,
              excludeStore: model.store,
              forceRefresh: true
            }
          },
          (resp) => {
            scanBtn.disabled = false;
            scanBtn.textContent = '🔍 Проверить в других магазинах';
            if (chrome.runtime.lastError || !resp || !resp.ok) return;
            if (resp.comparisons) {
              const updated = buildStoreAssistantModel(model, resp.comparisons);
              if (updated) renderStoreAssistantWidget(doc, updated, options);
            }
          }
        );
      }
    });
    compareBox.appendChild(scanBtn);
    body.appendChild(compareBox);

    // 3. AI analysis section
    const aiBox = doc.createElement('div');
    aiBox.className = 'section-box';

    const aiHeader = doc.createElement('div');
    aiHeader.className = 'section-label';
    aiHeader.textContent = '🤖 ИИ-разбор состава и отзывов';
    aiBox.appendChild(aiHeader);

    const aiVerdictEl = doc.createElement('div');
    aiVerdictEl.className = 'ai-verdict';
    aiVerdictEl.textContent = options.aiVerdict || '';

    const aiSourcesEl = doc.createElement('div');
    aiSourcesEl.className = 'ai-sources';

    const renderAiResult = (verdictText, sources = []) => {
      aiVerdictEl.textContent = verdictText || '';
      while (aiSourcesEl.firstChild) aiSourcesEl.removeChild(aiSourcesEl.firstChild);
      if (Array.isArray(sources)) {
        for (const src of sources.slice(0, 5)) {
          const href = safeUrl(src?.url || src);
          if (!href) continue;
          const a = doc.createElement('a');
          a.className = 'compare-link';
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = src?.source || src?.title || 'Источник';
          aiSourcesEl.appendChild(a);
        }
      }
    };

    if (options.aiVerdict) {
      renderAiResult(options.aiVerdict, options.aiSources || []);
    }

    const aiBtn = doc.createElement('button');
    aiBtn.type = 'button';
    aiBtn.className = 'action-btn';
    aiBtn.setAttribute('data-action', 'run-ai');
    aiBtn.textContent = options.aiVerdict ? '🔄 Обновить ИИ-разбор' : '🤖 Запустить ИИ-разбор';
    aiBtn.addEventListener('click', () => {
      if (typeof options.onRunAi === 'function') {
        options.onRunAi(model, aiBtn, renderAiResult);
        return;
      }
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        aiBtn.disabled = true;
        aiBtn.textContent = '⏳ ИИ анализирует товар...';
        chrome.runtime.sendMessage(
          {
            type: 'LQS_ANALYZE_PRODUCT',
            payload: {
              slug: model.slug,
              title: model.title,
              brand: model.brand,
              amount: model.amount,
              price: model.price,
              ingredients: model.ingredients,
              store: model.store
            }
          },
          (resp) => {
            aiBtn.disabled = false;
            aiBtn.textContent = '🔄 Обновить ИИ-разбор';
            if (chrome.runtime.lastError || !resp) {
              renderAiResult('⚠️ Не удалось выполнить ИИ-разбор.', []);
              return;
            }
            if (resp.ok && (resp.verdict || resp.text)) {
              renderAiResult(resp.verdict || resp.text, resp.sources || []);
            } else {
              renderAiResult(`⚠️ ${resp.error || 'ИИ не вернул ответ'}`, []);
            }
          }
        );
      }
    });

    aiBox.appendChild(aiBtn);
    aiBox.appendChild(aiVerdictEl);
    aiBox.appendChild(aiSourcesEl);
    body.appendChild(aiBox);

    // 4. Price Chart & Watchlist row
    const toolsRow = doc.createElement('div');
    toolsRow.className = 'row';

    const chartBtn = doc.createElement('button');
    chartBtn.type = 'button';
    chartBtn.className = 'action-btn';
    chartBtn.setAttribute('data-action', 'toggle-chart');
    chartBtn.textContent = '📈 График цены';

    const watchBtn = doc.createElement('button');
    watchBtn.type = 'button';
    watchBtn.className = 'action-btn';
    watchBtn.setAttribute('data-action', 'toggle-watch');
    watchBtn.textContent = options.isWatched ? '❤️ В отслеживании' : '❤️ Следить';
    if (options.isWatched) watchBtn.classList.toggle('is-active', true);

    const chartBox = doc.createElement('div');
    chartBox.className = 'chart-box';

    chartBtn.addEventListener('click', () => {
      const opening = !chartBox.classList.contains('is-open');
      chartBox.classList.toggle('is-open', opening);
      if (!opening) return;
      if (typeof options.onToggleChart === 'function') {
        options.onToggleChart(model, chartBox);
        return;
      }
      chartBox.textContent = '⏳ Загружаем историю цен...';
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        chrome.runtime.sendMessage(
          { type: 'LQS_GET_PRICE_HISTORY', slug: model.slug, title: model.title, days: 90 },
          (resp) => {
            if (chrome.runtime.lastError || !resp || !resp.ok || !resp.data) {
              chartBox.textContent = 'История цен пока накапливается — посетите товар ещё раз позже.';
              return;
            }
            const chartApi = root.LQS_PRICE_CHART;
            if (chartApi && typeof chartApi.buildPriceChartSvg === 'function') {
              const pts = Array.isArray(resp.data.points) ? resp.data.points : [];
              const stats = resp.data.stats || {};
              const info = stats.minPrice
                ? `Мин: ${Math.round(stats.minPrice)} ₽ · Сред: ${Math.round(stats.avgPrice || stats.lastPrice || model.price)} ₽ · Точек: ${pts.length}`
                : `Текущая цена: ${model.price} ₽`;
              chartBox.textContent = info;
            } else {
              chartBox.textContent = `Точек в истории: ${(resp.data.points || []).length}`;
            }
          }
        );
      }
    });

    watchBtn.addEventListener('click', () => {
      if (typeof options.onToggleWatch === 'function') {
        options.onToggleWatch(model, watchBtn);
        return;
      }
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        chrome.runtime.sendMessage(
          {
            type: 'LQS_TOGGLE_WATCHLIST',
            slug: model.slug,
            title: model.title,
            amount: model.amount,
            price: model.price
          },
          (resp) => {
            if (chrome.runtime.lastError || !resp || !resp.ok) return;
            const watched = Boolean(resp.watched);
            watchBtn.classList.toggle('is-active', watched);
            watchBtn.textContent = watched ? '❤️ В отслеживании' : '❤️ Следить';
          }
        );
      }
    });

    toolsRow.appendChild(chartBtn);
    toolsRow.appendChild(watchBtn);
    body.appendChild(toolsRow);
    body.appendChild(chartBox);

    // 5. Personal rating (5 stars), ban button, and short note (lqs_reviews_v1)
    const personalBox = doc.createElement('div');
    personalBox.className = 'section-box';

    const personalTop = doc.createElement('div');
    personalTop.className = 'personal-row';

    const starsWrap = doc.createElement('div');
    starsWrap.className = 'stars';
    const starBtns = [];
    let currentRating = Number(options.review?.rating || 0);
    let currentBanned = Boolean(options.review?.banned);

    const syncStarsUi = () => {
      starBtns.forEach((btn, idx) => {
        btn.classList.toggle('is-on', idx + 1 <= currentRating);
      });
    };

    for (let i = 1; i <= 5; i++) {
      const sb = doc.createElement('button');
      sb.type = 'button';
      sb.className = 'star-btn';
      sb.setAttribute('data-star', String(i));
      sb.setAttribute('aria-label', `Оценка ${i} из 5`);
      sb.textContent = '★';
      sb.addEventListener('click', () => {
        currentRating = currentRating === i ? 0 : i;
        syncStarsUi();
        savePersonalReview(model.reviewKey, model.title, { rating: currentRating });
      });
      starBtns.push(sb);
      starsWrap.appendChild(sb);
    }
    syncStarsUi();

    const banBtn = doc.createElement('button');
    banBtn.type = 'button';
    banBtn.className = `action-btn${currentBanned ? ' is-active' : ''}`;
    banBtn.setAttribute('data-action', 'toggle-ban');
    banBtn.textContent = currentBanned ? '🚫 В бане' : '🚫 В бан';
    banBtn.addEventListener('click', () => {
      currentBanned = !currentBanned;
      banBtn.classList.toggle('is-active', currentBanned);
      banBtn.textContent = currentBanned ? '🚫 В бане' : '🚫 В бан';
      savePersonalReview(model.reviewKey, model.title, { banned: currentBanned });
    });

    personalTop.appendChild(starsWrap);
    personalTop.appendChild(banBtn);
    personalBox.appendChild(personalTop);

    const noteRow = doc.createElement('div');
    noteRow.className = 'note-row';

    const noteInput = doc.createElement('input');
    noteInput.type = 'text';
    noteInput.className = 'note-input';
    noteInput.placeholder = 'Короткая заметка о товаре...';
    noteInput.value = String(options.review?.note || '');

    const saveNoteBtn = doc.createElement('button');
    saveNoteBtn.type = 'button';
    saveNoteBtn.className = 'action-btn';
    saveNoteBtn.setAttribute('data-action', 'save-note');
    saveNoteBtn.textContent = '💾';
    saveNoteBtn.title = 'Сохранить заметку';
    saveNoteBtn.addEventListener('click', () => {
      savePersonalReview(model.reviewKey, model.title, { note: String(noteInput.value || '').trim() });
    });

    noteRow.appendChild(noteInput);
    noteRow.appendChild(saveNoteBtn);
    personalBox.appendChild(noteRow);
    body.appendChild(personalBox);

    card.appendChild(body);
    shadow.appendChild(card);

    toggleBtn.addEventListener('click', () => {
      const collapsedNow = !body.classList.contains('is-collapsed');
      body.classList.toggle('is-collapsed', collapsedNow);
      toggleBtn.setAttribute('aria-expanded', String(!collapsedNow));
      toggleBtn.textContent = collapsedNow ? 'Показать' : 'Свернуть';
      try {
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem(COLLAPSE_STORAGE_KEY, collapsedNow ? '1' : '0');
        }
      } catch (err) {
        void err;
      }
    });

    return host;
  }

  function initStoreAssistantIfNeeded() {
    if (typeof window === 'undefined' || !window.location) return false;
    const hostMatched = ASSISTANT_STORES.some((s) => s.hostPattern.test(String(window.location.hostname || '').toLowerCase()));
    if (!hostMatched) return false;

    let lastRenderKey = '';
    let lastCheckedHref = '';
    let lastRecordedOfferKey = '';
    let syncTimer = null;
    let liveRefreshTimer = null;
    let activeProductRef = null;
    let activeStateRef = null;
    let activeRerenderRef = null;

    const syncWidget = (forceRefreshComparisons = false) => {
      const storeInfo = detectAssistantStorePage(window.location);
      if (!storeInfo) {
        removeStoreAssistantWidget(document);
        lastRenderKey = '';
        activeProductRef = null;
        return;
      }

      const product = extractStoreProductFromDoc(document, window.location, storeInfo);
      if (!product) return;

      const baseKey = `${window.location.href}|${product.title}|${product.price}|${product.amount}|${product.ingredients.length}`;
      if (!forceRefreshComparisons && baseKey === lastRenderKey) return;
      lastRenderKey = baseKey;

      const state = {
        comparisonData: null,
        aiVerdict: '',
        aiSources: [],
        review: null
      };

      const rerender = () => {
        const model = buildStoreAssistantModel(product, state.comparisonData);
        if (model) {
          renderStoreAssistantWidget(document, model, {
            aiVerdict: state.aiVerdict,
            aiSources: state.aiSources,
            review: state.review
          });
        }
      };

      activeProductRef = product;
      activeStateRef = state;
      activeRerenderRef = rerender;

      // Render immediately with local unit price + traffic light
      rerender();

      // Автоматически сохраняем точную цену открытой карточки в общую базу (браузер + SQLite + Лавка)
      const recordKey = `${product.store}|${product.url}|${product.title}|${product.price}|${product.oldPrice || ''}`;
      if (
        recordKey !== lastRecordedOfferKey &&
        product.price > 0 &&
        typeof chrome !== 'undefined' &&
        chrome.runtime &&
        typeof chrome.runtime.sendMessage === 'function'
      ) {
        lastRecordedOfferKey = recordKey;
        chrome.runtime.sendMessage(
          {
            type: 'LQS_RECORD_EXTERNAL_STORE_OFFERS',
            store: product.store,
            offers: [
              {
                store: product.store,
                title: product.title,
                brand: product.brand || '',
                amount: product.amount || '',
                price: product.price,
                oldPrice: product.oldPrice || null,
                url: product.url,
                isPrimaryProductPage: true
              }
            ]
          },
          () => {
            void chrome.runtime?.lastError;
          }
        );
      }

      // Load personal review from lqs_reviews_v1
      const initKey = buildStoreProductKey(product);
      loadPersonalReview(initKey, (rev) => {
        if (rev) {
          state.review = rev;
          rerender();
        }
      });

      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        // 1. Local + SQLite price comparisons
        chrome.runtime.sendMessage(
          {
            type: 'LQS_COMPARE_STORE_PRODUCT',
            payload: {
              store: product.store,
              title: product.title,
              brand: product.brand,
              amount: product.amount,
              price: product.price
            }
          },
          (resp) => {
            if (chrome.runtime.lastError || !resp || !resp.ok) return;
            state.comparisonData = resp;
            rerender();
          }
        );

        // 2. Check cached AI verdict
        chrome.runtime.sendMessage(
          {
            type: 'LQS_GET_CACHED_AI_VERDICT',
            slug: initKey,
            title: product.title
          },
          (resp) => {
            if (chrome.runtime.lastError || !resp || !resp.ok || !resp.entry) return;
            state.aiVerdict = resp.entry.verdict || '';
            state.aiSources = resp.entry.sources || [];
            if (state.aiVerdict) rerender();
          }
        );
      }
    };

    const scheduleSync = (delay = 350) => {
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        if (!document.hidden) syncWidget();
      }, delay);
    };

    [400, 1200, 2600].forEach((ms) => setTimeout(() => {
      if (!document.hidden) syncWidget();
    }, ms));

    setInterval(() => {
      if (document.hidden) return;
      if (window.location.href !== lastCheckedHref) {
        lastCheckedHref = window.location.href;
        scheduleSync(450);
      }
    }, 900);

    window.addEventListener('popstate', () => scheduleSync(350));

    // Умный дебаггер на всех 7 внешних магазинах (LQS_GET_DIAGNOSTICS)
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || msg.type !== 'LQS_GET_DIAGNOSTICS') return false;
        const pageStore = detectAssistantStorePage(window.location);
        const hostStore = ASSISTANT_STORES.find((s) => s.hostPattern.test(String(window.location.hostname || '').toLowerCase()));
        const storeLabel = pageStore?.store || hostStore?.store || window.location.hostname;
        const prod = activeProductRef || (pageStore ? extractStoreProductFromDoc(document, window.location, pageStore) : null);
        const harvestSnap = root.LQS_STORE_HARVESTER && typeof root.LQS_STORE_HARVESTER.parseOffersFromDocument === 'function'
          ? root.LQS_STORE_HARVESTER.parseOffersFromDocument(document, window.location)
          : { offers: [], diagnostic: null };
        const hostEl = document.getElementById(HOST_ID);
        const mountMode = hostEl?.dataset?.lqsMountMode || (hostEl ? 'mounted' : 'not_mounted');
        const cmp = activeStateRef?.comparisonData || null;
        const lines = [
          `# 🛠️ LAVKA QUALITY SHIELD v${root.LQS_CONFIG?.VERSION || '2.10.0'} — STORE DIAGNOSTIC LOG (${storeLabel})`,
          `- **Timestamp**: ${new Date().toISOString()}`,
          `- **URL**: ${window.location.href}`,
          `- **Магазин**: ${storeLabel} | **Карточка товара**: ${pageStore ? '✅ ДА' : '⚪ Каталог/Поиск'} | **Виджет**: ${mountMode}`,
          ``,
          `## 1. ИЗВЛЕЧЁННЫЙ ТОВАР СО СТРАНИЦЫ`,
          prod
            ? `- **Название**: "${prod.title}" | **Бренд**: "${prod.brand || '—'}" | **Вес/объём**: "${prod.amount || '—'}" | **Цена**: ${prod.price} ₽${prod.oldPrice ? ` (старая ${prod.oldPrice} ₽)` : ''} | **Состав**: ${prod.ingredients ? prod.ingredients.length + ' симв.' : 'не найден'} | **Белок**: ${prod.proteinPer100g ?? '—'} г/100г`
            : `- Товар не извлечён (не карточка товара или цена не найдена).`,
          ``,
          `## 2. СБОРЩИК ЦЕН (STORE HARVESTER)`,
          `- **Найдено офферов на странице**: ${(harvestSnap.offers || []).length} | **Диагностика**: ${harvestSnap.diagnostic?.status || 'ok'} (${harvestSnap.diagnostic?.reason || 'ok'})`,
          ...(harvestSnap.offers || []).slice(0, 6).map((o, i) => `  ${i + 1}. **${o.store}**${o.sourceRetailer ? ` (${o.sourceRetailer})` : ''}: ${o.price} ₽${o.oldPrice ? ` (старая ${o.oldPrice} ₽)` : ''} — "${String(o.title || '').slice(0, 80)}" [${o.amount || 'без веса'}] | ${o.url || ''}`),
          ``,
          `## 3. СРАВНЕНИЕ ЦЕН ИЗ БАЗЫ (LQS_COMPARE_STORE_PRODUCT)`,
          cmp
            ? [
                `- **Яндекс Лавка**: ${cmp.lavka ? `${cmp.lavka.price} ₽ ("${cmp.lavka.title}")` : 'нет совпадения'}`,
                `- **Точные совпадения в других сетях (${(cmp.otherStores || []).length})**: ${(cmp.otherStores || []).map((x) => `${x.store} ${x.price} ₽ ("${String(x.title || '').slice(0, 50)}")`).join('; ') || 'нет'}`,
                `- **Похожие товары (${(cmp.similarStores || []).length})**: ${(cmp.similarStores || []).map((x) => `${x.store} ${x.price} ₽ [${x.mismatchReason || 'similar'}]`).join('; ') || 'нет'}`
              ].join('\n')
            : `- Сравнение ещё не загружено.`
        ];
        if (msg.backendDiag) {
          lines.push(``, `- **Пинг серверов из Popup**: ${msg.backendDiag}`);
        }
        sendResponse({
          ok: true,
          reportText: lines.join('\n'),
          modules: {
            router: { status: 'OK', summary: `${storeLabel} (${pageStore ? 'PDP' : 'Catalog'})` },
            parser: { status: prod ? 'OK' : 'IDLE', summary: prod ? `${prod.title.slice(0, 35)} (${prod.price} ₽)` : 'Не карточка товара' },
            calculator: { status: prod ? 'OK' : 'IDLE', summary: prod ? `Вес: ${prod.amount || '—'}, белок: ${prod.proteinPer100g ?? '—'}` : 'Ожидание' },
            widget: { status: hostEl ? 'OK' : 'IDLE', summary: `Режим: ${mountMode}` },
            catalog: { status: 'OK', summary: `Собрано на странице: ${(harvestSnap.offers || []).length}` },
            cartGuard: { status: 'IDLE', summary: 'Только на Лавке' },
            storage: { status: 'OK', summary: 'Автосинхронизация активна' },
            aiReviewer: { status: activeStateRef?.aiVerdict ? 'OK' : 'IDLE', summary: activeStateRef?.aiVerdict ? 'Вердикт загружен' : 'Готов' }
          }
        });
        return true;
      });
    }

    // Живое автообновление открытой вкладки магазина при изменении цен/отзывов в Лавке или других магазинах
    const cfgKeys = (root.LQS_CONFIG && root.LQS_CONFIG.STORAGE_KEYS) || {};
    const watchedKeys = new Set([
      cfgKeys.PRICE_DB || 'lqs_price_db_v1',
      cfgKeys.EXT_STORE_DB || 'lqs_ext_store_prices_v1',
      cfgKeys.REJECTED_MATCHES || 'lqs_rejected_matches_v1',
      REVIEWS_STORAGE_KEY
    ]);
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !activeProductRef || !activeStateRef || !activeRerenderRef) return;
        const touched = Object.keys(changes || {}).some((k) => watchedKeys.has(k));
        if (!touched) return;
        if (liveRefreshTimer) clearTimeout(liveRefreshTimer);
        liveRefreshTimer = setTimeout(() => {
          liveRefreshTimer = null;
          if (!activeProductRef || !activeStateRef || !activeRerenderRef) return;
          const prod = activeProductRef;
          const st = activeStateRef;
          const rerenderFn = activeRerenderRef;
          if (changes[REVIEWS_STORAGE_KEY]) {
            loadPersonalReview(buildStoreProductKey(prod, st.comparisonData?.lavka?.slug || ''), (rev) => {
              st.review = rev || null;
              rerenderFn();
            });
          }
          if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
            chrome.runtime.sendMessage(
              {
                type: 'LQS_COMPARE_STORE_PRODUCT',
                payload: {
                  store: prod.store,
                  title: prod.title,
                  brand: prod.brand,
                  amount: prod.amount,
                  price: prod.price
                }
              },
              (resp) => {
                if (chrome.runtime.lastError || !resp || !resp.ok) return;
                st.comparisonData = resp;
                rerenderFn();
              }
            );
          }
        }, 450);
      });
    }

    return true;
  }

  const api = {
    HOST_ID,
    ASSISTANT_STORES,
    STORE_ANCHOR_SELECTORS,
    detectAssistantStorePage,
    buildStoreProductKey,
    findInlineMountAnchor,
    extractIngredientsFromStoreDoc,
    extractProteinFromStoreDoc,
    extractStoreProductFromDoc,
    buildStoreAssistantModel,
    renderStoreAssistantWidget,
    removeStoreAssistantWidget,
    initStoreAssistantIfNeeded
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LQS_STORE_ASSISTANT_UI = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
