'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT_DIR = path.resolve(__dirname, '..');
const harvester = require(path.join(EXT_DIR, 'content', 'store-harvester.js'));
const matcher = require(path.join(EXT_DIR, 'shared', 'product-matcher.js'));

function loadPriceRadar() {
  const storageData = {};
  const sandbox = {
    chrome: {
      storage: {
        local: {
          get: (keys, cb) => {
            const out = {};
            const list = Array.isArray(keys) ? keys : [keys];
            for (const k of list) {
              if (k in storageData) out[k] = storageData[k];
            }
            cb(out);
          },
          set: (obj, cb) => {
            Object.assign(storageData, obj || {});
            if (cb) cb();
          },
        },
      },
      runtime: {
        getURL: (p) => `chrome-extension://test/${p}`,
      },
    },
    console,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Promise,
    RegExp,
    Array,
    Object,
    Number,
    String,
    Boolean,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const ctx = vm.createContext(sandbox);
  for (const rel of ['shared/config.js', 'shared/price-parser.js', 'shared/utils.js', 'shared/product-matcher.js', 'bg/price-radar.js']) {
    const fp = path.join(EXT_DIR, rel);
    vm.runInContext(fs.readFileSync(fp, 'utf8'), ctx, { filename: fp });
  }
  return { radar: sandbox.LQS_PRICE_RADAR, storageData };
}

test('Block 1: extractPricePairFromText ignores delivery, cashback, "от" and per-100g noise prices', () => {
  assert.equal(harvester.extractPricePairFromText('Доставка 25 ₽ · Старая доставка 41 ₽'), null);
  assert.equal(harvester.extractPricePairFromText('Кешбэк 25 ₽ · Бонусы 41 ₽ · от 25 ₽'), null);
  assert.deepEqual(
    harvester.extractPricePairFromText('Доставка 25 ₽ · 45 ₽/100г · Цена 189 ₽ · 229 ₽'),
    { price: 189, oldPrice: 229 }
  );
});

test('Block 1: parseKuperOffers uses targeted price selector instead of grabbing 25 ₽ delivery from main text', () => {
  const priceNode = {
    innerText: '189 ₽ 229 ₽',
    textContent: '189 ₽ 229 ₽',
    getAttribute: (a) => (a === 'data-qa' ? 'product_price_current' : ''),
    closest: () => null,
  };
  const h1Node = { textContent: 'Горошек зелёный молодой Бондюэль 400 г' };
  const mainNode = {
    innerText: 'Доставка 25 ₽ при заказе от 41 ₽ Горошек зелёный молодой Бондюэль 400 г 189 ₽ 229 ₽',
  };
  const doc = {
    querySelector: (sel) => {
      if (sel === 'h1') return h1Node;
      if (sel === 'main') return mainNode;
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel.includes('product_price')) return [priceNode];
      return [];
    },
    body: mainNode,
  };
  const winLoc = {
    hostname: 'kuper.ru',
    origin: 'https://kuper.ru',
    pathname: '/products/goroshek-bonduelle-400g',
    href: 'https://kuper.ru/products/goroshek-bonduelle-400g',
  };
  const offers = harvester.parseKuperOffers(doc, winLoc);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].price, 189);
  assert.equal(offers[0].oldPrice, 229);
  assert.equal(offers[0].isPrimaryProductPage, true);
});

test('Block 1: sanitizeCompetitorOffersForProduct & findMatchingExternalStoreOffersFromList reject >2.2x anomaly and missing volume', () => {
  const { radar } = loadPriceRadar();

  const offers = [
    { store: 'Купер', title: 'Горошек зелёный молодой Бондюэль 400 г', price: 25, url: 'https://kuper.ru/products/bonduelle-400' },
    { store: 'Магнит', title: 'Горошек зелёный молодой Бондюэль', price: 185, url: 'https://magnit.ru/product/bonduelle-no-weight' },
    { store: 'Пятёрочка', title: 'Горошек зелёный молодой Бондюэль 400 г', price: 189, url: 'https://5ka.ru/product/bonduelle-400' },
  ];

  const sanitized = radar.sanitizeCompetitorOffersForProduct(
    offers,
    'Горошек зелёный молодой «Бондюэль» 400 г',
    '400 г',
    255
  );
  assert.equal(sanitized.length, 1);
  assert.equal(sanitized[0].store, 'Пятёрочка');
  assert.equal(sanitized[0].price, 189);

  const matched = radar.findMatchingExternalStoreOffersFromList(
    offers,
    'Горошек зелёный молодой «Бондюэль» 400 г',
    '400 г',
    255
  );
  assert.equal(matched.length, 1);
  assert.equal(matched[0].store, 'Пятёрочка');

  // Direct matcher check with requireVolume
  const noVol = matcher.isSearchResultMatchingProduct(
    'Горошек зелёный молодой Бондюэль',
    '',
    'Горошек зелёный молодой Бондюэль',
    '400 г',
    { requireVolume: true }
  );
  assert.equal(noVol.isSameVolume, false);
  assert.equal(noVol.mismatchReason, 'volume_missing');
});

test('Block 1 & 2: mergeUniqueStoreOffers replaces stale price on same store|url instead of keeping cheaper stale price', () => {
  const { radar } = loadPriceRadar();

  const existing = [
    { store: 'Купер', price: 149, url: 'https://kuper.ru/products/bonduelle-400' },
  ];
  const incoming = [
    { store: 'Купер', price: 189, url: 'https://kuper.ru/products/bonduelle-400' },
  ];

  const merged = radar.mergeUniqueStoreOffers(existing, incoming);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].price, 189);
});

test('Block 2 & 3: live sync hooks and upgraded debugger sections are wired across content.js, store-assistant-ui.js, background.js, and popup.js', () => {
  const contentSrc = fs.readFileSync(path.join(EXT_DIR, 'content.js'), 'utf8');
  const storeUiSrc = fs.readFileSync(path.join(EXT_DIR, 'content', 'store-assistant-ui.js'), 'utf8');
  const bgSrc = fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8');
  const popupSrc = fs.readFileSync(path.join(EXT_DIR, 'popup.js'), 'utf8');

  // Block 2: Lavka clears priceSummaryBySlug on storage update; store-assistant-ui subscribes to storage.onChanged & records primary offer
  assert.match(contentSrc, /priceSummaryBySlug\.clear\(\)/);
  assert.match(storeUiSrc, /LQS_RECORD_EXTERNAL_STORE_OFFERS/);
  assert.match(storeUiSrc, /chrome\.storage\.onChanged\.addListener/);

  // Block 3: Upgraded debugger sections & multi-store diagnostic support & no DOM write spam
  assert.match(contentSrc, /## 4\. АУДИТ ЦЕН КОНКУРЕНТОВ И МАТЧЕРА/);
  assert.equal(contentSrc.includes('DOM write executed for ${tagKey}'), false);
  assert.match(storeUiSrc, /msg\.type !== 'LQS_GET_DIAGNOSTICS'/);
  assert.match(bgSrc, /msg\.type === 'LQS_GET_BG_DIAGNOSTICS'/);
  assert.match(popupSrc, /## 6b\. ТЕЛЕМЕТРИЯ SERVICE WORKER/);
  assert.match(popupSrc, /isSupportedDiagnosticTabUrl/);
  assert.match(popupSrc, /Локальный сервер :8765 OFFLINE/);
});
