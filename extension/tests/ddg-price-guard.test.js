'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT_DIR = path.resolve(__dirname, '..');
const matcher = require(path.join(EXT_DIR, 'shared', 'product-matcher.js'));

function loadDdgHelpersFromBackground() {
  const bgSrc = fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8');
  const startIdx = bgSrc.indexOf('function isCategoryOrSearchListingUrl(');
  const endIdx = bgSrc.indexOf('async function parseDdgHtmlSearch(');
  assert.ok(startIdx > 0 && endIdx > startIdx, 'DDG helper functions must exist in background.js');

  const snippet = bgSrc.slice(startIdx, endIdx);
  const sandbox = {
    URL,
    isSearchResultMatchingProduct: matcher.isSearchResultMatchingProduct,
    parseVolumeOrWeightGrams: matcher.parseVolumeOrWeightGrams
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${snippet}\nthis._exports = { isCategoryOrSearchListingUrl, extractCompetitorPricesFromSources };`,
    sandbox
  );
  return sandbox._exports;
}

const { isCategoryOrSearchListingUrl, extractCompetitorPricesFromSources } = loadDdgHelpersFromBackground();

test('DDG guard rejects "от 99 ₽" snippet without volume for Сливки 10% Село Зелёное 500 г', () => {
  const res = extractCompetitorPricesFromSources(
    [
      {
        source: 'Пятёрочка',
        title: 'Сливки 10% Село Зелёное стерилизованные купить в Пятёрочке',
        snippet: 'Сливки Село Зелёное 10% стерилизованные в наличии, цены от 99 ₽ в магазинах Пятёрочка.',
        url: 'https://5ka.ru/catalog/moloko-syr-yaytsa/slivki/'
      }
    ],
    188,
    'Сливки 10% «Село Зелёное» стерилизованные 500 г',
    '500 г'
  );
  assert.equal(res.competitorMinPrice, null);
  assert.equal(res.competitorOffers.length, 0);
});

test('DDG guard rejects "от 149 ₽" even when volume 500 г is present on product URL', () => {
  const res = extractCompetitorPricesFromSources(
    [
      {
        source: 'Пятёрочка',
        title: 'Сливки 10% Село Зелёное стерилизованные 500 г',
        snippet: 'Купить с доставкой, цена от 149 ₽ за упаковку 500 г.',
        url: 'https://5ka.ru/product/slivki-selo-zelenoe-10-500g/'
      }
    ],
    188,
    'Сливки 10% «Село Зелёное» стерилизованные 500 г',
    '500 г'
  );
  assert.equal(res.competitorMinPrice, null);
  assert.equal(res.competitorOffers.length, 0);
});

test('DDG guard rejects snippet without volume when target product specifies 500 г', () => {
  const res = extractCompetitorPricesFromSources(
    [
      {
        source: 'Пятёрочка',
        title: 'Сливки 10% Село Зелёное стерилизованные',
        snippet: 'Цена 99 ₽ в наличии в Пятёрочке.',
        url: 'https://5ka.ru/product/slivki-selo-zelenoe-10/'
      }
    ],
    188,
    'Сливки 10% «Село Зелёное» стерилизованные 500 г',
    '500 г'
  );
  assert.equal(res.competitorMinPrice, null);
  assert.equal(res.competitorOffers.length, 0);
});

test('DDG guard rejects category/search/brand URLs even with matching volume and exact price', () => {
  assert.equal(isCategoryOrSearchListingUrl('https://5ka.ru/catalog/slivki/'), true);
  assert.equal(isCategoryOrSearchListingUrl('https://magnit.ru/search?term=slivki'), true);
  assert.equal(isCategoryOrSearchListingUrl('https://perekrestok.ru/brand/selo-zelenoe'), true);
  assert.equal(isCategoryOrSearchListingUrl('https://magnit.ru/product/12345-slivki-500g'), false);
  assert.equal(isCategoryOrSearchListingUrl('https://perekrestok.ru/cat/123/p/slivki-500g-999'), false);

  const res = extractCompetitorPricesFromSources(
    [
      {
        source: 'Пятёрочка',
        title: 'Сливки 10% Село Зелёное стерилизованные 500 г',
        snippet: 'Цена 159 ₽ за 500 г.',
        url: 'https://5ka.ru/category/slivki/'
      }
    ],
    188,
    'Сливки 10% «Село Зелёное» стерилизованные 500 г',
    '500 г'
  );
  assert.equal(res.competitorMinPrice, null);
  assert.equal(res.competitorOffers.length, 0);
});

test('DDG guard accepts genuine product URL with exact volume and non-"от" price and tags origin=ddg', () => {
  const res = extractCompetitorPricesFromSources(
    [
      {
        source: 'Магнит',
        title: 'Сливки 10% Село Зелёное стерилизованные 500 г',
        snippet: 'Сливки стерилизованные 10% 500 г — 159 ₽ с картой Магнит.',
        url: 'https://magnit.ru/product/1000123-slivki-selo-zelenoe-10-500g'
      }
    ],
    188,
    'Сливки 10% «Село Зелёное» стерилизованные 500 г',
    '500 г'
  );
  assert.equal(res.competitorMinPrice, 159);
  assert.equal(res.competitorOffers.length, 1);
  assert.equal(res.competitorOffers[0].store, 'Магнит');
  assert.equal(res.competitorOffers[0].price, 159);
  assert.equal(res.competitorOffers[0].origin, 'ddg');
});

test('content.js renders reject ✕ button wired to LQS_REJECT_COMPETITOR_MATCH and origin tooltips', () => {
  const contentSrc = fs.readFileSync(path.join(EXT_DIR, 'content.js'), 'utf8');
  assert.match(contentSrc, /lqs-reject-match-btn/);
  assert.match(contentSrc, /LQS_REJECT_COMPETITOR_MATCH/);
  assert.match(contentSrc, /поиск DDG/);
  assert.match(contentSrc, /DOM-скан/);
  assert.match(contentSrc, /локальная база/);
});
