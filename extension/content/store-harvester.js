/**
 * Lavka Quality Shield — Universal Multi-Store Price Harvester (content/store-harvester.js)
 * Supports passive harvesting (when user visits store pages) and on-demand background-tab
 * radar scanning (via LQS_HARVEST_STORE_PAGE_NOW) across:
 *   - Купер (kuper.ru — multi-retailer aggregator: Пятёрочка, Магнит, Перекрёсток, Ашан, Лента, МЕТРО, Дикси, ВкусВилл, О’КЕЙ, Глобус, Азбука Вкуса, Чижик)
 *   - Магнит (magnit.ru)
 *   - Перекрёсток / Впрок (perekrestok.ru, vprok.ru)
 *   - Пятёрочка (5ka.ru)
 *   - ВкусВилл (vkusvill.ru)
 *   - Ашан (auchan.ru)
 *   - Лента (lenta.com)
 */
(function (root) {
  'use strict';

  const SUPPORTED_STORES = [
    { id: 'kuper', store: 'Купер', hostPattern: /(^|\.)kuper\.ru$/i },
    { id: 'magnit', store: 'Магнит', hostPattern: /(^|\.)magnit\.ru$/i },
    { id: 'perekrestok', store: 'Перекрёсток', hostPattern: /(^|\.)(perekrestok\.ru|vprok\.ru)$/i },
    { id: 'pyaterochka', store: 'Пятёрочка', hostPattern: /(^|\.)5ka\.ru$/i },
    { id: 'vkusvill', store: 'ВкусВилл', hostPattern: /(^|\.)vkusvill\.ru$/i },
    { id: 'auchan', store: 'Ашан', hostPattern: /(^|\.)auchan\.ru$/i },
    { id: 'lenta', store: 'Лента', hostPattern: /(^|\.)lenta\.com$/i }
  ];

  const KUPER_RETAILER_MAP = [
    { re: /(pyaterochka|5ka|пят[её]рочк)/i, name: 'Пятёрочка' },
    { re: /(magnit|магнит)/i, name: 'Магнит' },
    { re: /(perekrestok|перекр[её]сток|vprok|впрок)/i, name: 'Перекрёсток' },
    { re: /(auchan|ашан)/i, name: 'Ашан' },
    { re: /(lenta|лента)/i, name: 'Лента' },
    { re: /(metro|метро)/i, name: 'МЕТРО' },
    { re: /(dixy|дикси)/i, name: 'Дикси' },
    { re: /(vkusvill|вкусвилл)/i, name: 'ВкусВилл' },
    { re: /(okey|о['’`]?кей)/i, name: 'О’КЕЙ' },
    { re: /(globus|глобус)/i, name: 'Глобус' },
    { re: /(azbukavkusa|azbuka|азбука\s+вкуса)/i, name: 'Азбука Вкуса' },
    { re: /(chizhik|чижик)/i, name: 'Чижик' },
    { re: /(samokat|самокат)/i, name: 'Самокат' },
    { re: /(magnoliya|магнолия)/i, name: 'Магнолия' }
  ];

  function detectStoreFromHost(hostname) {
    const h = String(hostname || '').toLowerCase().trim();
    for (const entry of SUPPORTED_STORES) {
      if (entry.hostPattern.test(h)) return entry;
    }
    return null;
  }

  function detectKuperRetailer(urlOrSlug, contextText = '') {
    const combined = `${urlOrSlug || ''} ${contextText || ''}`;
    for (const r of KUPER_RETAILER_MAP) {
      if (r.re.test(combined)) return r.name;
    }
    return 'Купер';
  }

  function normalizeSpace(text) {
    return String(text || '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function extractWeightFromText(text) {
    const m = String(text || '').match(/(\d+(?:[.,]\d+)?\s*(?:г|гр|кг|мл|л|шт)(?![а-яёa-z]))/i);
    return m ? m[1].trim() : '';
  }

  const NOISE_PRICE_PREFIX_RE = /(?:доставк[а-яё]*|кешбэк|кэшбэк|бонус[а-яё]*|спасибо|мин\.?\s*заказ[а-яё]*|бесплатн[а-яё]*|при\s+заказе\s+от|сборк[а-яё]*|сервисн[а-яё]*\s+сбор|пакет|от)\s*:?\s*$/i;
  const NOISE_PRICE_ATTR_RE = /(delivery|shipping|cashback|bonus|spasibo|min[-_]?order|promo|banner|basket|cart[-_]?total|per[-_]?kg|unit[-_]?price)/i;
  const RECOMMENDATION_CONTAINER_SELECTOR = '[data-qa*="recommendation" i], [data-testid*="recommendation" i], [class*="recommend" i], [class*="similar" i], [class*="carousel" i]';

  function extractPricePairFromText(text) {
    const clean = normalizeSpace(text);
    // Normalize Kuper ("144 ,00 ₽") and 5ka ("279 99 ₽") split-kopeck formats before matching
    const normalized = clean
      .replace(/(\d)\s+([.,]\d{1,2})\s*(?=(?:₽|рубл(?:ей|я|ь)|руб\.?))/gi, '$1$2 ')
      .replace(/(^|[^\d.,])(\d{1,5}(?:\s\d{3})?)\s+(\d{2})\s*(?=(?:₽|рубл(?:ей|я|ь)|руб\.?))/gi, '$1$2.$3 ');
    // Avoid matching unit prices like "478 ₽/кг", "25 ₽/100г", "120 ₽ за кг", "41 ₽ за 100 г"
    const withoutUnit = normalized.replace(
      /\d+(?:[.,]\d{1,2})?\s*(?:₽|рубл(?:ей|я|ь)|руб\.?)\s*(?:\/\s*(?:кг|л|шт|100\s*г(?:р)?|г)|за\s*(?:\d+\s*)?(?:кг|л|шт|г(?:р)?))/gi,
      ' '
    );
    const matchObjs = Array.from(withoutUnit.matchAll(/(\d{1,5}(?:\s?\d{3})?(?:[.,]\d{1,2})?)\s*(?:₽|рубл(?:ей|я|ь)|руб\.?)/gi))
      .map((m) => ({
        val: parseFloat(m[1].replace(/\s+/g, '').replace(',', '.')),
        idx: m.index || 0
      }))
      .filter((o) => {
        if (!Number.isFinite(o.val) || o.val < 10 || o.val > 25000) return false;
        const prefix = withoutUnit.slice(Math.max(0, o.idx - 28), o.idx);
        if (NOISE_PRICE_PREFIX_RE.test(prefix)) return false;
        return true;
      });

    if (matchObjs.length === 0) return null;
    let first = matchObjs[0].val;
    let second = matchObjs.length > 1 ? matchObjs[1].val : null;

    // On 5ka.ru, "Старая цена 349 99 ₽" often precedes "Цена 264 99 ₽"
    if (second !== null && first > second && first <= second * 3.5) {
      const prefixBeforeFirst = withoutUnit.slice(Math.max(0, matchObjs[0].idx - 24), matchObjs[0].idx);
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

  function cleanCardTitle(rawTitle, fallbackText) {
    let t = normalizeSpace(rawTitle);
    const stripNoise = (str) => normalizeSpace(str)
      .replace(/\s*(?:Цена\s+за\s+\d+\s*(?:кг|л|шт|г)|Старая\s+цена|Полная\s+цена|Цена\s+\d).*$/i, '')
      .replace(/\d+(?:\s+\d{2}|[.,]\d{1,2})?\s*(?:₽|рубл(?:ей|я|ь)|руб\.?).*$/i, '')
      .replace(/^(?:(?:В корзину|Купить|Скидка|Акция|Хит|Новинка|Нет оценок|Финальная цена|Только у нас|\+\d+%\s+с\s+Магнит\s+Пэй|\-\d+%|\d[.,]\d{1,2})\s*)+/gi, '')
      .replace(/[.\s\-–—]+$/, '')
      .trim();

    t = stripNoise(t);
    if (!t || t.length < 3) {
      t = stripNoise(fallbackText);
    }
    if (t.length > 140) t = t.slice(0, 140).trim();
    return t;
  }

  function extractPrimaryProductPrice(doc, mainText = '') {
    if (doc && typeof doc.querySelectorAll === 'function') {
      const priceSelectors = [
        '[data-qa*="product_price" i]',
        '[data-qa*="price" i]',
        '[data-testid*="price" i]',
        '[itemprop="price"]',
        '[class*="ProductPrice" i]',
        '[class*="product-price" i]',
        '[class*="price-new" i]',
        '[class*="current-price" i]'
      ];
      for (const sel of priceSelectors) {
        let nodes = [];
        try {
          nodes = doc.querySelectorAll(sel);
        } catch {
          nodes = [];
        }
        for (let i = 0; i < Math.min(nodes.length, 12); i++) {
          const el = nodes[i];
          if (!el) continue;
          const tag = String(el.tagName || '').toUpperCase();
          if (tag === 'A' || tag === 'ARTICLE') continue;
          if (typeof el.closest === 'function' && el.closest(RECOMMENDATION_CONTAINER_SELECTOR)) continue;
          const attrHint = `${el.getAttribute?.('data-qa') || ''} ${el.getAttribute?.('data-testid') || ''} ${el.getAttribute?.('class') || ''}`;
          if (NOISE_PRICE_ATTR_RE.test(attrHint)) continue;
          const contentAttr = el.getAttribute?.('content');
          if (contentAttr && /^\d+(?:[.,]\d{1,2})?$/.test(String(contentAttr).trim())) {
            const v = parseFloat(String(contentAttr).replace(',', '.'));
            if (Number.isFinite(v) && v >= 10 && v <= 25000) {
              return { price: Math.round(v), oldPrice: null };
            }
          }
          const txt = normalizeSpace(el.innerText || el.textContent || '');
          if (!txt || txt.length > 160) continue;
          const pr = extractPricePairFromText(txt);
          if (pr) return pr;
        }
      }
    }
    return mainText ? extractPricePairFromText(mainText) : null;
  }

  function parseJsonLdOffers(doc, storeName, originHref) {
    const offers = [];
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    scripts.forEach((sc) => {
      try {
        const parsed = JSON.parse(sc.textContent || '');
        const nodes = Array.isArray(parsed)
          ? parsed
          : (Array.isArray(parsed?.itemListElement)
              ? parsed.itemListElement.map((x) => x?.item || x)
              : [parsed]);
        for (const node of nodes) {
          if (!node || typeof node !== 'object') continue;
          const typeStr = String(node['@type'] || '').toLowerCase();
          if (!typeStr.includes('product')) continue;
          const title = normalizeSpace(node.name || '');
          const offerObj = Array.isArray(node.offers) ? node.offers[0] : node.offers;
          const priceVal = Number(offerObj?.price || offerObj?.lowPrice || 0);
          if (!title || title.length < 3 || !Number.isFinite(priceVal) || priceVal < 10 || priceVal > 25000) continue;
          const url = typeof node.url === 'string' && node.url.startsWith('http') ? node.url : originHref;
          const brandName = typeof node.brand === 'string'
            ? normalizeSpace(node.brand)
            : normalizeSpace(node.brand?.name || '');
          const weightText = node.weight && typeof node.weight === 'object'
            ? `${node.weight.value || ''} ${node.weight.unitText || node.weight.unitCode || ''}`
            : String(node.weight || '');
          offers.push({
            store: storeName,
            goodId: node.sku ? String(node.sku) : null,
            title,
            brand: brandName,
            amount: extractWeightFromText(title) || extractWeightFromText(weightText),
            price: Math.round(priceVal),
            oldPrice: null,
            url
          });
        }
      } catch {
        // ignore invalid JSON-LD
      }
    });
    return offers;
  }

  function parseMagnitOffers(doc, winLoc) {
    const offers = [];
    const seen = new Set();

    const catalogCards = doc.querySelectorAll('article.unit-catalog-product-preview, a.pl-hover-base[href*="/product/"]');
    catalogCards.forEach((node) => {
      const card = node.tagName === 'ARTICLE' ? node : (node.closest('article.unit-catalog-product-preview') || node);
      const linkEl = card.tagName === 'A' ? card : card.querySelector('a.pl-hover-base[href*="/product/"], a[href*="/product/"]');
      if (!linkEl) return;
      const href = linkEl.getAttribute('href') || '';
      if (!href.includes('/product/')) return;
      const fullUrl = new URL(href, winLoc.origin).href;
      if (seen.has(fullUrl)) return;

      const imgEl = card.querySelector('div.unit-catalog-product-preview-image img[alt], img[alt]');
      const imgAlt = imgEl ? (imgEl.getAttribute('alt') || '').trim() : '';
      const rawText = normalizeSpace(card.innerText || linkEl.innerText || '');
      const pr = extractPricePairFromText(rawText);
      if (!pr) return;

      const title = imgAlt && imgAlt.length > 4
        ? imgAlt
        : rawText.replace(/^.*?₽\s*(?:-\d+%\s*\d+(?:[.,]\d+)?\s*₽\s*)?/i, '').trim();
      if (!title || title.length < 3) return;

      const idMatch = href.match(/\/product\/(\d+)/);
      seen.add(fullUrl);
      offers.push({
        store: 'Магнит',
        goodId: idMatch ? idMatch[1] : null,
        title,
        amount: extractWeightFromText(title),
        price: pr.price,
        oldPrice: pr.oldPrice,
        url: fullUrl
      });
    });

    const cartLinks = doc.querySelectorAll('a.cart-product-list-item-wrap-content[href*="/product/"]');
    cartLinks.forEach((linkEl) => {
      const href = linkEl.getAttribute('href') || '';
      const fullUrl = new URL(href, winLoc.origin).href;
      if (seen.has(fullUrl)) return;

      const row = linkEl.closest('div.cart-product-item') || linkEl.parentElement;
      const imgEl = row ? row.querySelector('div.cart-product-item__left img[alt], img[alt]') : null;
      const imgAlt = imgEl ? (imgEl.getAttribute('alt') || '').trim() : '';
      const rawText = normalizeSpace((row || linkEl).innerText || '');
      const pr = extractPricePairFromText(rawText);
      if (!pr) return;

      const title = imgAlt && imgAlt.length > 4 ? imgAlt : rawText.split(/Финальная цена|\d+\s*₽/)[0].trim();
      if (!title || title.length < 3) return;

      const idMatch = href.match(/\/product\/(\d+)/);
      seen.add(fullUrl);
      offers.push({
        store: 'Магнит',
        goodId: idMatch ? idMatch[1] : null,
        title,
        amount: extractWeightFromText(title),
        price: pr.price,
        oldPrice: pr.oldPrice,
        url: fullUrl
      });
    });

    if (winLoc.pathname.includes('/product/')) {
      const h1 = doc.querySelector('h1');
      const pageTitle = h1 ? normalizeSpace(h1.textContent || '') : doc.title.split('—')[0].trim();
      const mainScope = doc.querySelector('main') || doc.body;
      const pr = extractPrimaryProductPrice(doc, (mainScope?.innerText || '').slice(0, 2000));
      if (pageTitle && pr && !seen.has(winLoc.href)) {
        const idMatch = winLoc.pathname.match(/\/product\/(\d+)/);
        offers.unshift({
          store: 'Магнит',
          goodId: idMatch ? idMatch[1] : null,
          title: pageTitle,
          amount: extractWeightFromText(pageTitle),
          price: pr.price,
          oldPrice: pr.oldPrice,
          url: winLoc.href,
          isPrimaryProductPage: true
        });
      }
    }

    return offers;
  }

  function parseKuperOffers(doc, winLoc) {
    const offers = [];
    const seen = new Set();

    // Detect page-level retailer from Kuper breadcrumb (e.g. a[data-qa="product_breadcrumb_link_0"] -> "Пятёрочка")
    const crumbEl = typeof doc.querySelector === 'function'
      ? doc.querySelector('a[data-qa="product_breadcrumb_link_0"]')
      : null;
    const pageRetailerContext = crumbEl
      ? `${crumbEl.getAttribute?.('href') || ''} ${crumbEl.textContent || ''}`
      : '';
    const pageDetectedRetailer = detectKuperRetailer(winLoc.href || '', `${pageRetailerContext} ${winLoc.pathname || ''}`);
    const pageSourceRetailer = pageDetectedRetailer && pageDetectedRetailer !== 'Купер' ? pageDetectedRetailer : null;

    // 1. Always harvest the currently open Kuper product page (/product/... or /products/...) first
    if (/\/products?\//i.test(winLoc.pathname || '')) {
      const ldOffers = parseJsonLdOffers(doc, 'Купер', winLoc.href);
      for (const o of ldOffers) {
        o.sourceRetailer = pageSourceRetailer;
        o.isPrimaryProductPage = true;
        const dedupKey = `Купер|${pageSourceRetailer || ''}|${o.title.toLowerCase()}|${o.price}`;
        if (!seen.has(dedupKey)) {
          seen.add(dedupKey);
          offers.push(o);
        }
      }
      const h1 = typeof doc.querySelector === 'function' ? doc.querySelector('h1') : null;
      const pageTitle = h1 ? normalizeSpace(h1.textContent || '') : '';
      const mainScope = (typeof doc.querySelector === 'function' ? doc.querySelector('main') : null) || doc.body;
      const mainText = String(mainScope?.innerText || mainScope?.textContent || '').slice(0, 2200);
      const pr = extractPrimaryProductPrice(doc, mainText);
      if (offers.length === 0 && pageTitle && pageTitle.length >= 4 && pr) {
        const dedupKey = `Купер|${pageSourceRetailer || ''}|${pageTitle.toLowerCase()}|${pr.price}`;
        seen.add(dedupKey);
        offers.push({
          store: 'Купер',
          sourceRetailer: pageSourceRetailer,
          goodId: null,
          title: pageTitle,
          amount: extractWeightFromText(pageTitle) || extractWeightFromText(mainText.slice(0, 600)),
          price: pr.price,
          oldPrice: pr.oldPrice,
          url: winLoc.href,
          isPrimaryProductPage: true
        });
      }
    }

    // 2. Kuper multisearch & recommendations cards (avoid broad [data-qa*="product"] that hits breadcrumbs/delivery/bonus blocks)
    const cardNodes = doc.querySelectorAll(
      '[data-qa*="product_card"], [data-qa*="product-card"], [data-qa*="recommendations_product_card"], [data-qa*="products_grid_item"], [class*="ProductCard"], [class*="product-card"], article, a[href*="/products/"], a[href*="/product/"]'
    );

    cardNodes.forEach((node) => {
      if (node.querySelector?.('h1')) return;
      const card = node.tagName === 'A'
        ? (node.closest?.('article, [data-qa*="product"], [class*="ProductCard"], [class*="product-card"], li') || node.parentElement || node)
        : node;
      const linkEl = node.tagName === 'A'
        ? node
        : card.querySelector?.('a[href*="/products/"], a[href*="/product/"], a[href]');
      if (!linkEl) return;

      const href = linkEl.getAttribute('href') || '';
      if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.includes('/product/legal-info')) return;
      let fullUrl;
      try {
        fullUrl = new URL(href, winLoc.origin).href;
      } catch (err) {
        void err;
        return;
      }

      const ariaLabel = normalizeSpace(linkEl.getAttribute?.('aria-label') || card.getAttribute?.('aria-label') || '');
      const cardText = normalizeSpace(card.innerText || card.textContent || '');
      const rawText = cardText.length >= 6 && cardText.length <= 600 ? cardText : ariaLabel;
      if (!rawText || rawText.length < 6 || rawText.length > 600) return;

      const pr = extractPricePairFromText(rawText) || (ariaLabel ? extractPricePairFromText(ariaLabel) : null);
      if (!pr) return;

      // Kuper is always stored as an independent store ('Купер') because Kuper can add markups;
      // original retailer inside Kuper is preserved in sourceRetailer for tooltip only.
      const section = card.closest?.('section, [data-qa*="retailer"], [class*="Retailer"], [class*="StoreGroup"], [class*="SearchGroup"]');
      const sectionHeader = section
        ? normalizeSpace((section.querySelector?.('h1, h2, h3, [class*="Title"], [class*="Retailer"], img[alt]')?.textContent ||
            section.querySelector?.('img[alt]')?.getAttribute?.('alt') || ''))
        : '';
      const detectedRetailer = detectKuperRetailer(fullUrl, `${sectionHeader} ${pageRetailerContext} ${winLoc.pathname || ''}`);
      const sourceRetailer = detectedRetailer && detectedRetailer !== 'Купер' ? detectedRetailer : pageSourceRetailer;

      const titleEl = card.querySelector?.('[data-qa*="title"], [class*="Title"], [class*="Name"], h3, h4, img[alt]');
      const rawTitle = titleEl
        ? (titleEl.tagName === 'IMG' ? titleEl.getAttribute('alt') : titleEl.textContent)
        : (ariaLabel || linkEl.getAttribute?.('title') || linkEl.textContent || '');
      const title = cleanCardTitle(rawTitle, rawText);
      if (!title || title.length < 4) return;

      const dedupKey = `Купер|${sourceRetailer || ''}|${title.toLowerCase()}|${pr.price}`;
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);

      offers.push({
        store: 'Купер',
        sourceRetailer,
        goodId: null,
        title,
        amount: extractWeightFromText(`${title} ${rawText}`),
        price: pr.price,
        oldPrice: pr.oldPrice,
        url: fullUrl
      });
    });

    return offers;
  }

  function parseGenericRetailerOffers(doc, winLoc, storeInfo) {
    const offers = [];
    const seen = new Set();
    const seenPrimaryUrls = new Set();
    const storeName = storeInfo.store;

    // 1. Всегда сначала извлекаем сам открытый товар карточки (JSON-LD и <h1>),
    // чтобы блок «Похожие товары» никогда не вытеснял и не пропускал открытую карточку.
    const ldOffers = parseJsonLdOffers(doc, storeName, winLoc.href);
    for (const o of ldOffers) {
      const k = `${o.store}|${o.title.toLowerCase()}|${o.price}`;
      if (!seen.has(k)) {
        seen.add(k);
        if (o.url) seenPrimaryUrls.add(o.url);
        offers.push(o);
      }
    }

    if (/\/(product|goods|cat)\//i.test(winLoc.pathname || '')) {
      const h1 = doc.querySelector('h1');
      const pageTitle = h1 ? normalizeSpace(h1.textContent || '') : '';
      const mainScope = doc.querySelector('main') || doc.body;
      const mainText = String(mainScope?.innerText || mainScope?.textContent || '').slice(0, 2200);
      const pr = extractPrimaryProductPrice(doc, mainText);
      const brandEl = doc.querySelector('[itemprop="brand"], [data-testid*="brand"], [class*="Brand"]');
      const pageBrand = brandEl ? normalizeSpace(brandEl.getAttribute?.('content') || brandEl.textContent || '') : '';
      if (pageTitle && pageTitle.length >= 4 && pr) {
        const k = `${storeName}|${pageTitle.toLowerCase()}|${pr.price}`;
        if (!seen.has(k) && !seenPrimaryUrls.has(winLoc.href)) {
          seen.add(k);
          seenPrimaryUrls.add(winLoc.href);
          offers.push({
            store: storeName,
            goodId: null,
            title: pageTitle,
            brand: pageBrand,
            amount: extractWeightFromText(pageTitle) || extractWeightFromText(mainText.slice(0, 600)),
            price: pr.price,
            oldPrice: pr.oldPrice,
            url: winLoc.href,
            isPrimaryProductPage: true
          });
        }
      }
    }

    // 2. Затем собираем карточки товаров на странице (каталог, поиск, блок «Похожие»)
    const cardSelectors = [
      'article',
      'lu-product-card',
      '[data-testid*="product"]',
      '[data-qa*="product"]',
      '[class*="ProductCard"]',
      '[class*="product-card"]',
      '[class*="product_card"]',
      'a[href*="/goods/"]',
      'a[href*="/product/"]',
      'a[href*="/cat/"]'
    ].join(', ');

    const nodes = doc.querySelectorAll(cardSelectors);
    nodes.forEach((node) => {
      const card = node.tagName === 'A'
        ? (node.closest('article, li, [class*="ProductCard"], [class*="product-card"], [data-testid*="product"]') || node.parentElement || node)
        : node;
      const linkEl = node.tagName === 'A'
        ? node
        : card.querySelector('a[href*="/goods/"], a[href*="/product/"], a[href*="/cat/"], a[href]');
      if (!linkEl) return;

      const href = linkEl.getAttribute('href') || '';
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      let fullUrl;
      try {
        fullUrl = new URL(href, winLoc.origin).href;
      } catch {
        return;
      }

      const rawText = normalizeSpace(card.innerText || card.textContent || '');
      if (!rawText || rawText.length < 6 || rawText.length > 650) return;

      const pr = extractPricePairFromText(rawText);
      if (!pr) return;

      const titleEl = card.querySelector(
        '.ProductCard__link, [class*="ProductCard__title"], [class*="product-card__title"], [data-testid*="title"], [class*="Title"], [class*="Name"], h2, h3, h4, img[alt]'
      );
      const rawTitle = titleEl
        ? (titleEl.tagName === 'IMG'
            ? titleEl.getAttribute('alt')
            : (titleEl.getAttribute('title') || titleEl.textContent))
        : (linkEl.getAttribute('title') || linkEl.textContent || '');
      const title = cleanCardTitle(rawTitle, rawText);
      if (!title || title.length < 4) return;

      const dedupKey = `${storeName}|${title.toLowerCase()}|${pr.price}`;
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);

      offers.push({
        store: storeName,
        goodId: null,
        title,
        amount: extractWeightFromText(`${title} ${rawText}`),
        price: pr.price,
        oldPrice: pr.oldPrice,
        url: fullUrl
      });
    });

    return offers;
  }

  function diagnoseStorePage(doc, winLoc, offersCount = 0) {
    if (offersCount > 0) {
      return { status: 'ok', reason: 'ok', message: '' };
    }
    const bodyText = normalizeSpace((doc?.body?.innerText || doc?.body?.textContent || '').slice(0, 4500));
    const titleText = normalizeSpace(doc?.title || '');
    const hrefText = String(winLoc?.href || '');
    const sample = `${titleText} ${bodyText} ${hrefText}`;

    if (/(captcha|showcaptcha|smartcaptcha|ddos-guard|cloudflare|are you a robot|вы не робот|подозрительный трафик|подтвердите,?\s+что вы не робот|проверка браузера|доступ ограничен)/i.test(sample)) {
      return {
        status: 'captcha',
        reason: 'captcha',
        message: 'Сайт показал проверку от роботов (капчу)'
      };
    }

    if (/(укажите\s+адрес|выберите\s+адрес|введите\s+адрес|куда\s+доставить|адрес\s+доставки|выберите\s+магазин|выберите\s+город|укажите\s+ваш\s+адрес|введите\s+город)/i.test(sample)) {
      return {
        status: 'needs_address',
        reason: 'needs_address',
        message: 'Нужно 1 раз выбрать адрес доставки на сайте магазина'
      };
    }

    return {
      status: 'not_found',
      reason: 'not_found',
      message: 'Товар не найден в выдаче магазина'
    };
  }

  function parseOffersFromDocument(doc, winLoc) {
    const storeInfo = detectStoreFromHost(winLoc.hostname);
    if (!storeInfo) return { store: null, offers: [], diagnostic: { status: 'not_found', reason: 'unsupported_host', message: 'Неподдерживаемый сайт' } };

    let offers = [];
    if (storeInfo.id === 'magnit') {
      offers = parseMagnitOffers(doc, winLoc);
    } else if (storeInfo.id === 'kuper') {
      offers = parseKuperOffers(doc, winLoc);
    } else {
      offers = parseGenericRetailerOffers(doc, winLoc, storeInfo);
    }

    const sliced = offers.slice(0, 80);
    const diagnostic = diagnoseStorePage(doc, winLoc, sliced.length);
    return { store: storeInfo.store, offers: sliced, diagnostic };
  }

  function showHarvesterToast(storeLabel, count, totalInDb) {
    try {
      let badge = document.querySelector('#lqs-store-harvester-pill');
      if (!badge) {
        badge = document.createElement('div');
        badge.id = 'lqs-store-harvester-pill';
        badge.style.cssText =
          'position:fixed;bottom:14px;right:14px;z-index:999999;background:#21201f;color:#fce000;border:1px solid #3a3835;padding:7px 12px;border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:12px;font-weight:700;box-shadow:0 6px 18px rgba(0,0,0,0.22);pointer-events:none;';
        document.body.appendChild(badge);
      }
      badge.textContent = `🛡️ Lavka Shield: собрано ${count} цен (${storeLabel}, всего в базе: ${totalInDb || count})`;
    } catch {
      // ignore DOM errors
    }
  }

  function initStoreHarvesterIfNeeded() {
    if (typeof window === 'undefined' || !window.location) return false;
    const storeInfo = detectStoreFromHost(window.location.hostname);
    if (!storeInfo) return false;

    let lastHarvestHash = '';

    const runHarvest = (silent = false) => {
      const { store, offers, diagnostic } = parseOffersFromDocument(document, window.location);
      if (!offers || offers.length === 0) {
        return { store: store || storeInfo.store, offers: [], diagnostic };
      }

      const hash = offers.map((o) => `${o.store}:${o.title}:${o.price}`).join('|');
      if (!silent && hash === lastHarvestHash) {
        return { store: store || storeInfo.store, offers, diagnostic };
      }
      lastHarvestHash = hash;

      if (!silent && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage(
          { type: 'LQS_RECORD_EXTERNAL_STORE_OFFERS', store: store || storeInfo.store, offers },
          (resp) => {
            if (chrome.runtime.lastError || !resp) return;
            const uniqueStores = Array.from(new Set(offers.map((o) => o.store).filter(Boolean)));
            const label = uniqueStores.length > 2
              ? `${uniqueStores.slice(0, 2).join(', ')} +${uniqueStores.length - 2}`
              : (uniqueStores.join(', ') || storeInfo.store);
            showHarvesterToast(label, offers.length, resp.totalExternalOffers);
          }
        );
      }
      return { store: store || storeInfo.store, offers, diagnostic };
    };

    // On-demand harvesting for 1-click background tab radar (works even when tab is hidden)
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || msg.type !== 'LQS_HARVEST_STORE_PAGE_NOW') return false;
        const result = runHarvest(true);
        sendResponse({ ok: true, store: result.store, offers: result.offers, diagnostic: result.diagnostic || { status: result.offers.length > 0 ? 'ok' : 'not_found', reason: result.offers.length > 0 ? 'ok' : 'not_found', message: '' } });
        return true;
      });
    }

    // Passive harvesting when user actively browses the store
    setTimeout(() => {
      if (!document.hidden) runHarvest(false);
    }, 1000);

    setInterval(() => {
      if (document.hidden) return;
      runHarvest(false);
    }, 3000);

    return true;
  }

  const api = {
    SUPPORTED_STORES,
    detectStoreFromHost,
    detectKuperRetailer,
    extractWeightFromText,
    extractPricePairFromText,
    diagnoseStorePage,
    parseKuperOffers,
    parseOffersFromDocument,
    initStoreHarvesterIfNeeded,
    initMagnitStoreHarvesterIfNeeded: initStoreHarvesterIfNeeded
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LQS_STORE_HARVESTER = api;
  root.LQS_MAGNIT_PARSER = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
