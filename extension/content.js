/**
 * Lavka Quality Shield v2.7.0 — Content Script
 * Что нового и исправлено в v2.7.0:
 * 1. ИСПРАВЛЕНО СВОРАЧИВАНИЕ РАЗВЁРНУТОГО ОПИСАНИЯ (СПОЙЛЕРА) НА СТРАНИЦЕ ТОВАРА:
 *    - Ручной клик по кнопке «▴ Скрыть» фиксируется в `userManualDrawerStateBySlug`, поэтому фоновые синхронизации
 *      DOM и наличие готового кэша ИИ больше никогда не раскрывают спойлер обратно против воли пользователя.
 * 2. МГНОВЕННЫЙ ВЫВОД ИИ-ОБЗОРА ИЗ ВКЛАДКИ GEMINI НА СТРАНИЦУ ТОВАРА:
 *    - Кнопка «🤖 ИИ-обзор» передаёт `isManualUserClick: true`, обходит ложные пропуски и за 0.1 сек забирает
 *      уже сгенерированный ответ прямо из вкладки `gemini.google.com` (даже если вкладка в фоне).
 * 3. ОКНО СРАВНЕНИЯ ЦЕН 16 МАГАЗИНОВ + НАТИВНЫЙ СБОРЩИК ЦЕН МАГНИТА (`magnit.ru`):
 *    - В карточке товара и в корзине выводится наглядная матрица сравнения цен (Лавка Текущий акк vs другие аккаунты
 *      vs Магнит, Пятёрочка, Перекрёсток, ВкусВилл, Магнолия, Дикси, Чижик, Ашан, МЕТРО, Глобус, Лента, О’КЕЙ,
 *      Азбука Вкуса, Ozon, Купер, Я.Маркет) с подсветкой самой выгодной цены.
 */

(function () {
  'use strict';

  const { VERSION, STORAGE_KEYS } = globalThis.LQS_CONFIG;
  const {
    escapeHtml,
    safeHttpUrl,
    getSettings,
    buildFullProductSearchQuery,
    buildDirectStoreSearchLinks
  } = globalThis.LQS_UTILS;
  const STORAGE_KEY = STORAGE_KEYS.REVIEWS;
  const SETTINGS_KEY = STORAGE_KEYS.SETTINGS;
  const FLIGHT_LOG_KEY = STORAGE_KEYS.FLIGHT_LOG;
  const AI_CACHE_KEY = STORAGE_KEYS.AI_CACHE;
  const PRICE_DB_KEY = STORAGE_KEYS.PRICE_DB;
  const EXT_STORE_DB_KEY = STORAGE_KEYS.EXT_STORE_DB || 'lqs_ext_store_prices_v1';
  const REJECTED_MATCHES_KEY = STORAGE_KEYS.REJECTED_MATCHES || 'lqs_rejected_matches_v1';
  const CART_LOCKS_KEY = STORAGE_KEYS.CART_LOCKS;

  const DEFAULT_SETTINGS = { ...globalThis.LQS_CONFIG.DEFAULT_SETTINGS };

  const PRESET_TAGS = [
    '🔥 Топ',
    '🥩 В аэрогриль / су-вид',
    '🥑 Кето',
    '🧂 Пересолено',
    '💧 Водянистое',
    '🤢 Химоза',
    '💀 Не брать'
  ];

  const drawerOpenBySlug = new Map();
  const userManualDrawerStateBySlug = new Map();
  const autoAiTriggeredSlugs = new Set();
  const priceIntelRequestedSlugs = new Set();
  const autoRadarTriggeredSlugs = new Set();
  const lastAiResultBySlug = new Map();
  const priceSummaryBySlug = new Map();
  let autoAiDebounceTimer = null;

  let reviewsDbCache = null;
  let aiCacheMemory = null;
  let priceDbMemory = null;
  let cartLocksMemory = {};
  let cachedSettings = { ...DEFAULT_SETTINGS };
  let isRenderingProduct = false;
  let pendingProductRender = false;
  let currentReviewCache = null;
  let lastObservedUrl = window.location.href;
  let lastCatalogHarvestTs = 0;


  function normalizeTitle(raw) {
    if (!raw) return '';
    return String(raw)
      .replace(/<[^>]*>/g, ' ')
      .replace(/&laquo;|&raquo;|&quot;|&nbsp;/gi, ' ')
      .replace(/[\u00ad\u200b\u00a0«»"'„“”]/g, ' ')
      .replace(/(?:,\s*|\s+)(?:\d+\s*[×xх*]\s*)?\d+(?:[.,]\d+)?\s*(?:г|гр|грамм|кг|мл|л|шт|уп|пак|рул|капс)\.?$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/ё/g, 'е');
  }

  function findAiCacheInMemory(slug, title = '', imageKey = null) {
    if (slug && lastAiResultBySlug.has(slug)) {
      return lastAiResultBySlug.get(slug);
    }
    if (slug && aiCacheMemory && aiCacheMemory[slug] && aiCacheMemory[slug].verdict) {
      return aiCacheMemory[slug];
    }
    if (imageKey && aiCacheMemory) {
      for (const entry of Object.values(aiCacheMemory)) {
        if (entry && entry.verdict && !String(entry.verdict).startsWith('⚠️') && entry.imageKey === imageKey) {
          return entry;
        }
      }
    }
    const norm = normalizeTitle(title);
    if (norm && norm.length >= 4 && aiCacheMemory) {
      for (const entry of Object.values(aiCacheMemory)) {
        if (entry && entry.verdict && !String(entry.verdict).startsWith('⚠️') && normalizeTitle(entry.title) === norm) {
          return entry;
        }
      }
    }
    return null;
  }

  function findPriceIntelInMemory(slug, title = '', imageKey = null) {
    if (slug && priceSummaryBySlug.has(slug)) {
      return priceSummaryBySlug.get(slug);
    }
    if (slug && priceDbMemory && priceDbMemory[slug]) {
      return priceDbMemory[slug];
    }
    if (imageKey && priceDbMemory) {
      for (const entry of Object.values(priceDbMemory)) {
        if (entry && entry.imageKey && entry.imageKey === imageKey) {
          return entry;
        }
      }
    }
    const norm = normalizeTitle(title);
    if (norm && norm.length >= 4 && priceDbMemory) {
      for (const entry of Object.values(priceDbMemory)) {
        if (entry && normalizeTitle(entry.title) === norm) {
          return entry;
        }
      }
    }
    return null;
  }

  function findCartLockInMemory(slug, title = '', imageKey = null) {
    if (slug && cartLocksMemory && cartLocksMemory[slug]) {
      return cartLocksMemory[slug];
    }
    if (imageKey && cartLocksMemory) {
      for (const lock of Object.values(cartLocksMemory)) {
        if (lock && lock.imageKey && lock.imageKey === imageKey) {
          return lock;
        }
      }
    }
    const norm = normalizeTitle(title);
    if (norm && norm.length >= 4 && cartLocksMemory) {
      for (const lock of Object.values(cartLocksMemory)) {
        if (lock && normalizeTitle(lock.title) === norm) {
          return lock;
        }
      }
    }
    return null;
  }

  /**
   * Находит эталонное полное название товара из оригинальной карточки товара, если оно уже встречалось
   * в базе цен (`priceDbMemory`), базе оценок (`reviewsDbCache`), кэше ИИ (`aiCacheMemory`) или `cartLocksMemory`.
   */
  function resolveBestKnownCanonicalTitle(slug, rawCartTitle, amount = '', imageKey = null) {
    const candidates = [];

    const pEntry = findPriceIntelInMemory(slug, rawCartTitle, imageKey);
    if (pEntry && pEntry.title) {
      if (pEntry.isCanonicalCardTitle) {
        return buildFullProductSearchQuery(pEntry.title, pEntry.brand || '', pEntry.amount || amount);
      }
      candidates.push(pEntry.title);
    }

    if (reviewsDbCache) {
      const revMatch = findReviewInDB(reviewsDbCache, {
        slug,
        imageKey,
        cleanTitle: normalizeTitle(rawCartTitle)
      });
      if (revMatch && revMatch.item && revMatch.item.title) {
        candidates.push(revMatch.item.title);
      }
    }

    const lockEntry = findCartLockInMemory(slug, rawCartTitle, imageKey);
    if (lockEntry && lockEntry.title) {
      candidates.push(lockEntry.title);
    }

    const aiEntry = findAiCacheInMemory(slug, rawCartTitle, imageKey);
    if (aiEntry && aiEntry.title) {
      candidates.push(aiEntry.title);
    }

    let bestTitle = rawCartTitle || '';
    for (const c of candidates) {
      if (c && c.length > bestTitle.length) {
        bestTitle = c;
      }
    }
    return buildFullProductSearchQuery(bestTitle, '', amount);
  }

  const { extractVerdictBadgeFromText } = globalThis.LQS_VERDICT_BADGE;

  function detectCurrentAccountLabel() {
    try {
      const avatarEl =
        document.querySelector('[data-testid="user-profile"] img[alt]') ||
        document.querySelector('header img[alt*="@"]') ||
        document.querySelector('header [aria-label*="Аккаунт"]');
      if (avatarEl) {
        const alt = (avatarEl.getAttribute('alt') || avatarEl.getAttribute('aria-label') || '').trim();
        if (alt && alt.length > 1 && alt.length < 35 && !/аватар|профиль|user/i.test(alt)) {
          return alt;
        }
      }
    } catch {
      // ignore
    }
    return cachedSettings.lavkaAccountLabel || 'Аккаунт #1 (Основной)';
  }

  // ==========================================================================
  // АВТОНОМНЫЕ МОДУЛИ PASSPORT.YANDEX.RU И MAGNIT.RU (content/*.js)
  // ==========================================================================
  if (globalThis.LQS_PASSPORT_HELPER && globalThis.LQS_PASSPORT_HELPER.initYandexPassportHelperIfNeeded()) {
    return;
  }

  if (globalThis.LQS_STORE_HARVESTER && globalThis.LQS_STORE_HARVESTER.initStoreHarvesterIfNeeded()) {
    if (globalThis.LQS_STORE_ASSISTANT_UI && typeof globalThis.LQS_STORE_ASSISTANT_UI.initStoreAssistantIfNeeded === 'function') {
      globalThis.LQS_STORE_ASSISTANT_UI.initStoreAssistantIfNeeded();
    }
    return;
  }

  // ==========================================================================
  // БОРТОВОЙ САМОПИСЕЦ (LQS FLIGHT RECORDER)
  // ==========================================================================
  const LQS_RECORDER = {
    version: VERSION,
    sessionStartedAt: new Date().toISOString(),
    counters: {
      spaTransitions: 0,
      extMutations: 0,
      selfMutationsIgnored: 0,
      scheduleCalls: 0,
      panelMounts: 0,
      panelSyncs: 0,
      domWritesExecuted: 0,
      domWritesSkipped: 0,
      catalogPasses: 0,
      catalogBadgesUpdated: 0,
      catalogBadgesSkipped: 0,
      pricesHarvested: 0,
      clicksTotal: 0,
      drawerToggles: 0,
      missedClicksRecovered: 0,
      autoAiRuns: 0,
      errors: 0
    },
    lastClickLatencyMs: null,
    modules: {
      router: { status: 'INIT', lastRun: null, summary: 'Ожидание инициализации роутера' },
      parser: { status: 'IDLE', lastRun: null, summary: 'Страница товара ещё не открывалась', data: null },
      calculator: { status: 'IDLE', lastRun: null, summary: 'Расчёт КБЖУ и цены ещё не выполнялся', data: null },
      widget: { status: 'IDLE', lastRun: null, summary: 'Виджет не смонтирован' },
      catalog: { status: 'IDLE', lastRun: null, summary: 'Каталог ещё не сканировался' },
      cartGuard: { status: 'IDLE', lastRun: null, summary: 'Аудитор корзины и защита от бана готовы' },
      storage: { status: 'INIT', lastRun: null, summary: 'Загрузка базы отзывов и цен...' },
      aiReviewer: { status: 'IDLE', lastRun: null, summary: 'Готов к Zero-Click Автопилоту', lastCall: null }
    },
    events: [],
    _initialized: false,
    _saveTimer: null,

    init() {
      if (this._initialized) return;
      this._initialized = true;
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([FLIGHT_LOG_KEY], (res) => {
          const saved = res && res[FLIGHT_LOG_KEY];
          if (saved && Array.isArray(saved.events)) {
            const combined = [...this.events, ...saved.events];
            this.events = combined.slice(0, 120);
          }
          this.record('INIT', 'Session started on ' + window.location.pathname, {
            ua: navigator.userAgent.slice(0, 90),
            viewport: `${window.innerWidth}x${window.innerHeight}`
          });
        });
      }
    },

    updateModule(moduleName, status, summary, data = undefined) {
      if (!this.modules[moduleName]) return;
      const now = new Date();
      const ts = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
      this.modules[moduleName].status = status;
      this.modules[moduleName].lastRun = ts;
      this.modules[moduleName].summary = summary;
      if (data !== undefined) {
        this.modules[moduleName].data = data;
      }
      this.persistThrottled();
    },

    redactSecrets(text) {
      if (typeof text !== 'string' || !text) return text;
      return text
        .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[REDACTED]')
        .replace(/("?(?:aiApiKey|apiKey|api_key|backendToken|X-LQS-Token)"?\s*[:=]\s*"?)([^",\s}\]]+)/gi, '$1[REDACTED]');
    },

    record(category, message, payload = null) {
      const now = new Date();
      const ts = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
      const safeMessage = this.redactSecrets(String(message || ''));
      let cleanPayload = '';
      if (payload !== null && payload !== undefined) {
        if (typeof payload === 'string') {
          cleanPayload = payload;
        } else {
          try {
            cleanPayload = JSON.stringify(payload);
          } catch {
            cleanPayload = String(payload);
          }
        }
      }
      cleanPayload = this.redactSecrets(cleanPayload);
      if (cleanPayload.length > 360) {
        cleanPayload = cleanPayload.slice(0, 360) + '…';
      }

      this.events.unshift({
        ts,
        url: window.location.pathname,
        cat: category,
        msg: safeMessage,
        data: cleanPayload
      });

      if (this.events.length > 120) {
        this.events.length = 120;
      }
      this.persistThrottled();
    },

    error(where, err, extraContext = null) {
      this.counters.errors += 1;
      const errMsg = err && err.stack ? err.stack.split('\n').slice(0, 2).join(' | ') : (err && err.message ? err.message : String(err));
      this.record('ERROR', `[${where}] ${errMsg}`, extraContext);
    },

    clearLogs() {
      this.events = [];
      this.counters.errors = 0;
      this.record('INIT', 'Лог очищен пользователем вручную');
      this.persistNow();
    },

    auditDomSelectors() {
      const slug = extractSlugFromUrl(window.location.href);
      const mainPage = document.querySelector('main[data-testid="good-page-desktop"]');
      const infoBlock = mainPage
        ? (mainPage.querySelector('div[data-testid="product-info"]') || mainPage.querySelector('div[data-testid="product-card-header"]'))
        : null;
      const barContainer = infoBlock ? infoBlock.querySelector('div[data-testid="bar-container"]') : null;
      const titleEl = document.querySelector('h1[data-testid="product-title"]');
      const priceEl = document.querySelector('span[data-testid="price-text"]');
      const amountEl = document.querySelector('span[data-testid="product-amount"]');
      const ingredientsEl = document.querySelector('section[data-testid="ingredients-block"]');
      const traitsEl = document.querySelector('section[data-testid="traits-block"]');
      const addBtnEl = document.querySelector('main[data-testid="good-page-desktop"] button[data-testid="snippet-control"]');
      const panelEl = document.querySelector('.lqs-product-panel');
      const drawerEl = panelEl ? panelEl.querySelector('#lqs-drawer') : null;
      const catalogCardsCount = document.querySelectorAll('div[data-testid="product-card"]').length;

      let discoveredTestIds = [];
      if (slug && (!mainPage || !infoBlock || !titleEl || !priceEl)) {
        const allTestIdNodes = document.querySelectorAll('[data-testid]');
        const set = new Set();
        allTestIdNodes.forEach((n) => {
          const tid = n.getAttribute('data-testid');
          if (tid && !tid.startsWith('product-id-') && set.size < 35) {
            set.add(`${n.tagName.toLowerCase()}[data-testid="${tid}"]`);
          }
        });
        discoveredTestIds = Array.from(set);
      }

      return {
        url: window.location.href,
        pathname: window.location.pathname,
        slug: slug || null,
        pageType: slug ? 'PRODUCT_PAGE' : (window.location.pathname.includes('/cart') ? 'CART_PAGE' : 'CATALOG_OR_HOME'),
        selectors: {
          mainPage: Boolean(mainPage),
          infoBlock: Boolean(infoBlock),
          barContainer: Boolean(barContainer),
          titleEl: Boolean(titleEl),
          priceEl: Boolean(priceEl),
          amountEl: Boolean(amountEl),
          ingredientsEl: Boolean(ingredientsEl),
          traitsEl: Boolean(traitsEl),
          addBtnEl: Boolean(addBtnEl),
          panelMounted: Boolean(panelEl),
          drawerOpen: Boolean(drawerEl && drawerEl.classList.contains('open'))
        },
        catalogCardsCount,
        discoveredTestIds
      };
    },

    buildAiDebugReport(backendDiag = null) {
      const dom = this.auditDomSelectors();
      const s = dom.selectors;
      const c = this.counters;
      const m = this.modules;
      const flag = (v) => (v ? '✅ OK' : '❌ MISS');

      const lines = [
        `# 🛠️ LAVKA QUALITY SHIELD v${this.version} — AI DIAGNOSTIC & FLIGHT RECORDER LOG`,
        `> **Инструкция для ИИ-ассистента**: Ниже представлена полная телеметрия работы расширения Lavka Quality Shield (Manifest V3) на сайте Яндекс Лавки.`,
        ``,
        `## 1. СВОДКА ОКРУЖЕНИЯ И СТРАНИЦЫ`,
        `- **Timestamp**: ${new Date().toISOString()} (сессия с ${this.sessionStartedAt})`,
        `- **URL**: ${dom.url} | **Аккаунт**: ${detectCurrentAccountLabel()}`,
        `- **Тип страницы**: ${dom.pageType} (Slug: \`${dom.slug || 'нет'}\`, Карточек в каталоге: ${dom.catalogCardsCount})`,
        `- **База в памяти**: ${reviewsDbCache ? Object.keys(reviewsDbCache).length : 0} оценок | ${aiCacheMemory ? Object.keys(aiCacheMemory).length : 0} ИИ-обзоров | ${priceDbMemory ? Object.keys(priceDbMemory).length : 0} цен`,
        ``,
        `## 2. МАТРИЦА ФУНКЦИОНИРОВАНИЯ МОДУЛЕЙ (FUNCTION HEALTH MATRIX)`,
        `1. **[ROUTER] SPA-навигация и гидратация**: \`${m.router.status}\` (${m.router.lastRun || '—'}) — ${m.router.summary}`,
        `2. **[PARSER] Парсер метаданных и JSON-LD**: \`${m.parser.status}\` (${m.parser.lastRun || '—'}) — ${m.parser.summary}`,
        `3. **[CALCULATOR] Расчёт цены/кг, белка и КБЖУ**: \`${m.calculator.status}\` (${m.calculator.lastRun || '—'}) — ${m.calculator.summary}`,
        `4. **[WIDGET] Панель товара и Анти-Шулер Радар**: \`${m.widget.status}\` (${m.widget.lastRun || '—'}) — ${m.widget.summary}`,
        `5. **[CATALOG] Разметка карточек и сбор цен**: \`${m.catalog.status}\` (${m.catalog.lastRun || '—'}) — ${m.catalog.summary}`,
        `6. **[CART_GUARD] Аудитор корзины, конкуренты и свитчер**: \`${m.cartGuard.status}\` (${m.cartGuard.lastRun || '—'}) — ${m.cartGuard.summary}`,
        `7. **[STORAGE] Хранилище chrome.storage.local**: \`${m.storage.status}\` (${m.storage.lastRun || '—'}) — ${m.storage.summary}`,
        `8. **[AI_REVIEWER] Zero-Click ИИ Автопилот**: \`${m.aiReviewer.status}\` (${m.aiReviewer.lastRun || '—'}) — ${m.aiReviewer.summary}`
      ];

      if (backendDiag) {
        lines.push(`   - **Пинг серверов из Popup**: ${backendDiag}`);
      }

      const compAuditLines = [];
      if (dom.slug) {
        const metaSnap = typeof extractProductPageMetadata === 'function' ? extractProductPageMetadata() : null;
        const pIntelSnap = findPriceIntelInMemory(dom.slug, metaSnap?.title || '', metaSnap?.imageKey || null);
        const offersSnap = Array.isArray(pIntelSnap?.competitorOffers) ? pIntelSnap.competitorOffers : [];
        compAuditLines.push(
          `- **Текущий товар**: "${metaSnap?.title || pIntelSnap?.title || dom.slug}" | Фасовка: "${metaSnap?.amountText || pIntelSnap?.amount || '—'}" | Цена Лавки: ${metaSnap?.price || pIntelSnap?.lastPrice || '—'} ₽`,
          `- **Сопоставленных офферов сетей**: ${offersSnap.length} (Мин. цена конкурентов: ${pIntelSnap?.competitorMinPrice ? pIntelSnap.competitorMinPrice + ' ₽' : 'нет'})`
        );
        if (offersSnap.length > 0) {
          offersSnap.slice(0, 12).forEach((o, idx) => {
            const oldPart = o.oldPrice ? ` (старая ${o.oldPrice} ₽)` : '';
            const originPart = o.origin === 'ddg' ? 'DDG' : (o.sourceRetailer ? `Купер/${o.sourceRetailer}` : (o.isVerifiedStoreOffer ? 'DOM/БД' : 'кэш'));
            const updPart = o.updatedAt ? ` | ${String(o.updatedAt).slice(0, 19)}` : '';
            compAuditLines.push(
              `  ${idx + 1}. **${o.store || '?'}**: ${o.price || '?'} ₽${oldPart} [${originPart}] — "${String(o.title || '').slice(0, 90)}" | URL: ${o.url || '—'}${updPart}`
            );
          });
        } else {
          compAuditLines.push(`  - Совпадений по другим сетям для этого товара сейчас нет.`);
        }
      } else {
        compAuditLines.push(`- Не страница товара (аудит конкурентов доступен на /good/<slug>).`);
      }

      lines.push(
        ``,
        `## 3. АУДИТ DOM-СЕЛЕКТОРОВ ЯНДЕКС ЛАВКИ`,
        `- \`main[data-testid="good-page-desktop"]\`: ${flag(s.mainPage)}`,
        `- \`div[data-testid="product-info" | "product-card-header"]\`: ${flag(s.infoBlock)}`,
        `- \`div[data-testid="bar-container"]\`: ${flag(s.barContainer)}`,
        `- \`h1[data-testid="product-title"]\`: ${flag(s.titleEl)}`,
        `- \`span[data-testid="price-text"]\`: ${flag(s.priceEl)}`,
        `- \`span[data-testid="product-amount"]\`: ${flag(s.amountEl)}`,
        `- \`section[data-testid="ingredients-block"]\`: ${flag(s.ingredientsEl)}`,
        `- \`section[data-testid="traits-block"]\`: ${flag(s.traitsEl)}`,
        `- \`button[data-testid="snippet-control"]\`: ${flag(s.addBtnEl)}`,
        `- **Статус нашего виджета (.lqs-product-panel)**: ${s.panelMounted ? '✅ Смонтирован' : '⚪ Не смонтирован'} (Спойлер: ${s.drawerOpen ? 'ОТКРЫТ' : 'ЗАКРЫТ'})`,
        ``,
        `## 4. АУДИТ ЦЕН КОНКУРЕНТОВ И МАТЧЕРА (ТЕКУЩИЙ ТОВАР)`,
        ...compAuditLines,
        ``,
        `## 5. СЧЁТЧИКИ ПРОИЗВОДИТЕЛЬНОСТИ И СТАБИЛЬНОСТИ DOM`,
        `- **SPA переходов**: ${c.spaTransitions} | **Маунтов панели**: ${c.panelMounts} | **Синхронизаций UI**: ${c.panelSyncs} | **Zero-Click ИИ-запусков**: ${c.autoAiRuns} | **Цен собрано**: ${c.pricesHarvested}`,
        `- **Записей в DOM выполнено**: ${c.domWritesExecuted} | **Пропущено дублей (кэш хеша)**: ${c.domWritesSkipped}`,
        `- **Перехвачено ошибок (Errors)**: ${c.errors}`,
        ``,
        `## 6. ХРОНОЛОГИЧЕСКИЙ БОРТОВОЙ ЖУРНАЛ (ПОСЛЕДНИЕ ${Math.min(this.events.length, 60)} СОБЫТИЙ)`,
        ...(this.events.slice(0, 60).map((e) => `${e.ts} [${e.cat}] (${e.url}) ${e.msg}${e.data ? ' -> ' + e.data : ''}`))
      );

      return lines.join('\n');
    },

    persistNow() {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const payload = {
          updatedAt: new Date().toISOString(),
          version: this.version,
          counters: this.counters,
          modules: this.modules,
          events: this.events.slice(0, 120),
          reportText: this.buildAiDebugReport()
        };
        chrome.storage.local.set({ [FLIGHT_LOG_KEY]: payload });
      }
    },

    persistThrottled() {
      if (this._saveTimer) return;
      this._saveTimer = setTimeout(() => {
        this._saveTimer = null;
        this.persistNow();
      }, 500);
    }
  };

  LQS_RECORDER.init();

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    chrome.runtime.sendMessage({ type: 'LQS_WARMUP_AUTOPILOT' }, () => {
      if (chrome.runtime.lastError) {
        // ignore
      }
    });
  }

  window.addEventListener('error', (ev) => {
    if (ev && ev.error) LQS_RECORDER.error('window.onerror', ev.error);
  });

  window.addEventListener('unhandledrejection', (ev) => {
    if (ev && ev.reason) LQS_RECORDER.error('unhandledrejection', ev.reason);
  });

  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!target || !target.closest) return;

    const lqsBtn = target.closest('.lqs-product-panel button, .lqs-product-panel .lqs-tag-chip, .lqs-cart-audit-banner button');
    if (lqsBtn) {
      LQS_RECORDER.counters.clicksTotal += 1;
      return;
    }

    const snippetBtn = target.closest('button[data-testid="snippet-control"], button[aria-label*="В корзину"], button[aria-label*="Увеличить"]');
    if (snippetBtn) {
      setTimeout(() => {
        lockProductPriceOnCartAdd(snippetBtn);
        setTimeout(scanAndSnapshotCurrentCartDOM, 450);
      }, 60);
    }
  }, true);

  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && (e.code === 'KeyD' || e.key === 'D' || e.key === 'd' || e.key === 'в' || e.key === 'В')) {
      e.preventDefault();
      LQS_RECORDER.record('USER_ACTION', 'Triggered Alt+Shift+D AI log copy');
      const report = LQS_RECORDER.buildAiDebugReport();
      navigator.clipboard.writeText(report).catch(() => {});
    }
  });

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg) return false;
      if (msg.type === 'LQS_GET_DIAGNOSTICS') {
        sendResponse({
          ok: true,
          reportText: LQS_RECORDER.buildAiDebugReport(msg.backendDiag || null),
          counters: LQS_RECORDER.counters,
          modules: LQS_RECORDER.modules,
          audit: LQS_RECORDER.auditDomSelectors()
        });
        return true;
      }
      if (msg.type === 'LQS_CLEAR_DIAGNOSTICS') {
        LQS_RECORDER.clearLogs();
        sendResponse({
          ok: true,
          reportText: LQS_RECORDER.buildAiDebugReport()
        });
        return true;
      }
      if (msg.type === 'LQS_EXTRACT_CURRENT_CART_FROM_PAGE') {
        const snap = extractCartItemsFromDOM();
        sendResponse({
          ok: true,
          accountId: detectCurrentAccountLabel(),
          items: snap.items,
          totalUnits: snap.totalUnits,
          totalPrice: snap.totalPrice
        });
        return true;
      }
      if (msg.type === 'LQS_AI_VERDICT_READY' && msg.result && msg.result.verdict) {
        const currentSlug = extractSlugFromUrl(window.location.href);
        const panel = document.querySelector('.lqs-product-panel');
        if (panel && currentSlug) {
          const meta = extractProductPageMetadata();
          const currentCleanTitle = normalizeTitle(meta.title);
          if (msg.slug === currentSlug || (msg.cleanTitle && currentCleanTitle && msg.cleanTitle === currentCleanTitle)) {
            LQS_RECORDER.updateModule(
              'aiReviewer',
              'OK',
              `Ответ получен через Push [${msg.result.mode || 'ИИ'}]`
            );
            renderAiVerdictIntoPanel(panel, currentSlug, meta, msg.result, cachedSettings.autoOpenDrawerOnAi !== false);
          }
        }
        sendResponse({ ok: true });
        return true;
      }
      return false;
    });
  }

  // ==========================================================================
  // УТИЛИТЫ И РАБОТА С БАЗОЙ ОТЗЫВОВ, ИИ И ЦЕН
  // ==========================================================================
  function setHtmlIfChanged(el, nextHtml, tagKey = '') {
    if (!el) return false;
    if (el.dataset.lqsHtmlCache === nextHtml) {
      LQS_RECORDER.counters.domWritesSkipped += 1;
      return false;
    }
    el.dataset.lqsHtmlCache = nextHtml;
    el.innerHTML = nextHtml;
    LQS_RECORDER.counters.domWritesExecuted += 1;
    return true;
  }

  function extractImageKey(src) {
    if (!src) return null;
    const m = src.match(/get-grocery-goods\/(\d+\/[a-f0-9-]+)/i);
    return m ? m[1].toLowerCase() : null;
  }

  function extractSlugFromUrl(urlStr) {
    if (!urlStr) return null;
    try {
      const u = new URL(urlStr, window.location.origin);
      const match = u.pathname.replace(/\/+$/, '').match(/\/good\/([^/?#]+)/i);
      return match ? decodeURIComponent(match[1]).toLowerCase().trim() : null;
    } catch {
      return null;
    }
  }

  function formatAiTextToHtml(rawText) {
    if (!rawText) return '';
    const escaped = escapeHtml(rawText);
    return escaped
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }

  async function getReviewsDB(forceReload = false) {
    if (reviewsDbCache && !forceReload) {
      return reviewsDbCache;
    }
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([STORAGE_KEY, AI_CACHE_KEY, PRICE_DB_KEY, CART_LOCKS_KEY, SETTINGS_KEY], (res) => {
          reviewsDbCache = (res && res[STORAGE_KEY]) ? res[STORAGE_KEY] : {};
          aiCacheMemory = (res && res[AI_CACHE_KEY]) ? res[AI_CACHE_KEY] : {};
          priceDbMemory = (res && res[PRICE_DB_KEY]) ? res[PRICE_DB_KEY] : {};
          cartLocksMemory = (res && res[CART_LOCKS_KEY]) ? res[CART_LOCKS_KEY] : {};
          if (res && res[SETTINGS_KEY]) {
            cachedSettings = { ...DEFAULT_SETTINGS, ...res[SETTINGS_KEY] };
          }
          const count = Object.keys(reviewsDbCache).length;
          LQS_RECORDER.updateModule(
            'storage',
            'OK',
            `База в памяти: ${count} оценок, ${Object.keys(aiCacheMemory).length} ИИ, ${Object.keys(priceDbMemory).length} цен`
          );
          resolve(reviewsDbCache);
        });
      } else {
        reviewsDbCache = {};
        resolve(reviewsDbCache);
      }
    });
  }

  function findReviewInDB(db, keys) {
    if (!db) return null;
    const { slug, productId, imageKey, cleanTitle } = keys;
    if (slug && db[slug]) {
      return { item: db[slug], matchedBy: 'slug_exact' };
    }

    for (const item of Object.values(db)) {
      if (!item) continue;
      if (slug && item.slug && item.slug.toLowerCase() === slug) return { item, matchedBy: 'slug_case' };
      if (productId && item.productId && item.productId === productId) return { item, matchedBy: 'productId' };
      if (imageKey && item.imageKey && item.imageKey === imageKey) return { item, matchedBy: 'imageKey' };
      if (cleanTitle && item.cleanTitle && normalizeTitle(item.cleanTitle) === cleanTitle) return { item, matchedBy: 'cleanTitle' };
    }
    return null;
  }

  async function saveProductReview(slug, data) {
    const db = await getReviewsDB();
    const match = findReviewInDB(db, {
      slug,
      productId: data.productId,
      imageKey: data.imageKey,
      cleanTitle: data.cleanTitle
    });
    const existing = match ? match.item : null;
    const canonicalKey = (existing && existing.slug) ? existing.slug : slug;

    const isEmpty = !data.rating && !data.banned && (!data.tags || data.tags.length === 0) && (!data.note || !data.note.trim());

    if (isEmpty) {
      delete db[canonicalKey];
      reviewsDbCache = db;
      return new Promise((resolve) => {
        chrome.storage.local.set({ [STORAGE_KEY]: db }, () => resolve(null));
      });
    }

    db[canonicalKey] = {
      ...(existing || {}),
      ...data,
      slug: canonicalKey,
      updatedAt: new Date().toISOString()
    };
    reviewsDbCache = db;

    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: db }, () => resolve(db[canonicalKey]));
    });
  }

  // ==========================================================================
  // ФИКСАТОР ЦЕН КОРЗИНЫ И АУДИТ КОРЗИНЫ (вынесено в content/cart-audit.js)
  // ==========================================================================
  const {
    lockProductPriceOnCartAdd,
    extractCartItemsFromDOM,
    scanAndSnapshotCurrentCartDOM,
    renderCartAuditBanner
  } = globalThis.LQS_CART_AUDIT.createCartAudit({
    getCartLocksMemory: () => cartLocksMemory,
    normalizeTitle,
    detectCurrentAccountLabel,
    extractSlugFromUrl,
    extractImageKey,
    extractProductPageMetadata,
    extractPriceFromCardDOM,
    resolveBestKnownCanonicalTitle,
    findCartLockInMemory,
    findPriceIntelInMemory,
    recorder: LQS_RECORDER
  });

  // ==========================================================================
  // ПАРСЕР СТРАНИЦЫ ТОВАРА И КАЛЬКУЛЯТОР КБЖУ (вынесено в content/product-parser.js)
  // ==========================================================================
  function extractProductPageMetadata() {
    return globalThis.LQS_PRODUCT_PARSER.extractProductPageMetadata({
      normalizeTitle,
      extractImageKey,
      recorder: LQS_RECORDER
    });
  }

  function analyzeProductQuality(meta) {
    return globalThis.LQS_PRODUCT_PARSER.analyzeProductQuality(meta, {
      recorder: LQS_RECORDER
    });
  }

  function buildPriceShieldAlertPill(slug, currentPrice, title = '', imageKey = null) {
    if (!slug || !currentPrice) return '';
    const pIntel = findPriceIntelInMemory(slug, title, imageKey);
    if (!pIntel) return '';

    const curAcc = detectCurrentAccountLabel();

    let cheapestAltPrice = null;
    let cheapestAltLabel = '';

    if (pIntel.accounts && typeof pIntel.accounts === 'object') {
      for (const [accName, accObj] of Object.entries(pIntel.accounts)) {
        if (accName !== curAcc && accObj && accObj.price && accObj.price < currentPrice - 2) {
          if (!cheapestAltPrice || accObj.price < cheapestAltPrice) {
            cheapestAltPrice = accObj.price;
            cheapestAltLabel = accName;
          }
        }
      }
    }

    if (cheapestAltPrice && cheapestAltPrice < currentPrice - 2) {
      const diff = Math.round(currentPrice - cheapestAltPrice);
      return `<span class="lqs-metric-pill verdict-bad" title="Штраф за лояльность! На профиле «${escapeHtml(cheapestAltLabel)}» этот же товар стоит ${cheapestAltPrice} ₽">🕵️ Тебе +${diff} ₽ (${escapeHtml(cheapestAltLabel)}: ${cheapestAltPrice} ₽)</span>`;
    }

    if (pIntel.competitorMinPrice && pIntel.competitorMinPrice < currentPrice - 5) {
      const diffPct = Math.round(((currentPrice - pIntel.competitorMinPrice) / pIntel.competitorMinPrice) * 100);
      if (diffPct >= 8) {
        return `<span class="lqs-metric-pill verdict-warn" title="Цены в других сетях: ${escapeHtml(pIntel.competitorSummary || '')}">🏪 В сетях от ~${pIntel.competitorMinPrice} ₽ (тут +${diffPct}%)</span>`;
      }
    }

    if (pIntel.minPrice && currentPrice > pIntel.minPrice + 4) {
      const diff = Math.round(currentPrice - pIntel.minPrice);
      return `<span class="lqs-metric-pill verdict-warn" title="В твоей базе цен этот товар стоил ${pIntel.minPrice} ₽ (средняя: ${pIntel.avgPrice || pIntel.minPrice} ₽)">📈 +${diff} ₽ к мин. (${pIntel.minPrice} ₽)</span>`;
    }

    if (pIntel.maxPrice && currentPrice < pIntel.maxPrice - 4) {
      const saved = Math.round(pIntel.maxPrice - currentPrice);
      return `<span class="lqs-metric-pill verdict-good" title="Выгодная цена! Раньше стоил до ${pIntel.maxPrice} ₽">📉 Выгодно (-${saved} ₽)</span>`;
    }

    return '';
  }

  function buildPriceRadarDrawerBarHtml(slug, currentPrice, meta = null) {
    const title = meta ? meta.title : '';
    const amount = meta ? meta.amountText : '';
    const brand = meta ? meta.brand : '';
    const imageKey = meta ? meta.imageKey : null;
    const pIntel = findPriceIntelInMemory(slug, title, imageKey);

    const storeLinks = buildDirectStoreSearchLinks(title, amount, brand);

    // Собираем единую матрицу всех известных цен на этот товар (Лавка акк + другие аккаунты + Магнит / ВкусВилл / Перекрёсток / Ozon и др.)
    const comparisonRows = [];
    const curAccLabel = detectCurrentAccountLabel();
    const lavkaNow = currentPrice ? Math.round(currentPrice) : (pIntel?.lastPrice ? Math.round(pIntel.lastPrice) : null);

    if (lavkaNow) {
      comparisonRows.push({
        source: `Яндекс Лавка (${curAccLabel})`,
        price: lavkaNow,
        url: null,
        isCurrent: true,
        badge: 'Текущая цена'
      });
    }

    if (pIntel && pIntel.accounts && typeof pIntel.accounts === 'object') {
      for (const [accName, accObj] of Object.entries(pIntel.accounts)) {
        if (accName === curAccLabel || accName === 'Гость (без куки)') continue;
        if (accObj && accObj.price > 0) {
          const aPrice = Math.round(accObj.price);
          const diff = lavkaNow ? lavkaNow - aPrice : 0;
          comparisonRows.push({
            source: `Лавка (${accName})`,
            price: aPrice,
            url: null,
            badge: diff > 2 ? `Выгоднее на -${diff} ₽` : (diff < -2 ? `Дороже на +${Math.abs(diff)} ₽` : 'Та же цена')
          });
        }
      }
    }

    // Строим карту лучших известных цен по каждой сети (для Топ-3 и для отображения цены прямо на кнопках 16 сетей)
    const bestOfferByStoreKey = new Map();
    const normStoreKey = (name) => String(name || '').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '');
    const pricedCompetitorOffers = [];
    if (pIntel && Array.isArray(pIntel.competitorOffers)) {
      for (const offer of pIntel.competitorOffers) {
        if (!offer || !offer.store) continue;
        const oPrice = offer.price && offer.price > 0 ? Math.round(offer.price) : null;
        if (!oPrice) continue;
        const sKey = normStoreKey(offer.store);
        const prev = bestOfferByStoreKey.get(sKey);
        if (!prev || oPrice < prev.price) {
          bestOfferByStoreKey.set(sKey, { ...offer, price: oPrice });
        }
      }
      bestOfferByStoreKey.forEach((val) => pricedCompetitorOffers.push(val));
      pricedCompetitorOffers.sort((a, b) => a.price - b.price);
    }

    // Топ-3 лучшие цены в других магазинах
    const top3Competitors = pricedCompetitorOffers.slice(0, 3);
    top3Competitors.forEach((offer, idx) => {
      const oPrice = offer.price;
      const diff = lavkaNow ? lavkaNow - oPrice : 0;
      const medal = idx === 0 ? '🥇 ' : idx === 1 ? '🥈 ' : '🥉 ';
      const originLabel = offer.origin === 'ddg'
        ? 'поиск DDG'
        : ((offer.viaDomRadar || offer.sourceType === 'dom') ? 'DOM-скан' : 'локальная база');
      comparisonRows.push({
        source: `${medal}${offer.store}`,
        price: oPrice,
        oldPrice: offer.oldPrice || null,
        url: offer.url || null,
        offerTitle: offer.title || '',
        sourceRetailer: offer.sourceRetailer || null,
        sourceOriginLabel: originLabel,
        isCompetitor: true,
        badge: diff > 2
          ? `✅ Выгоднее на -${diff} ₽`
          : (diff < -2 ? `В Лавке дешевле на ${Math.abs(diff)} ₽` : 'Такая же цена')
      });
    });

    const pricedRows = comparisonRows.filter((r) => r.price && r.price > 0);
    const absoluteMinPrice = pricedRows.length > 0 ? Math.min(...pricedRows.map((r) => r.price)) : null;

    const matrixTableHtml = comparisonRows.length > 0
      ? `<div class="lqs-price-matrix-box">
          <div class="lqs-price-matrix-title">
            <span>📊 <b>Сравнение цен: Лавка и Топ-3 лучших в сетях</b></span>
            <div class="lqs-price-matrix-actions">
              ${
                pIntel && pIntel.minPrice && pIntel.maxPrice
                  ? `<span style="font-size:10.5px;color:#6e6a66;">Мин <b>${pIntel.minPrice} ₽</b> / макс <b>${pIntel.maxPrice} ₽</b></span>`
                  : ''
              }
              <button type="button" class="lqs-scan-stores-btn" data-slug="${escapeHtml(slug)}" title="Тихо проверить актуальные цены в Купере / выбранных сетях в фоновой вкладке">🔄 Найти цены в сетях</button>
            </div>
          </div>
          <div class="lqs-price-matrix-grid">
            ${comparisonRows
              .map((row) => {
                const isBest = Boolean(row.price && absoluteMinPrice && row.price === absoluteMinPrice && pricedRows.length > 1);
                const priceStr = row.price ? `<b>${row.price} ₽</b>` : '<span style="color:#64748b;">по ссылке</span>';
                const oldStr = row.oldPrice && row.oldPrice > (row.price || 0)
                  ? ` <s style="color:#94a3b8;font-size:10.5px;">${row.oldPrice} ₽</s>`
                  : '';
                const safeRowUrl = safeHttpUrl(row.url);
                const retailerTooltipSuffix = row.sourceRetailer ? ` (через Купер — ${row.sourceRetailer})` : '';
                const originTooltipSuffix = row.isCompetitor && row.sourceOriginLabel ? ` • Источник: ${row.sourceOriginLabel}` : '';
                const rowTooltip = `${row.offerTitle || row.source}${retailerTooltipSuffix}${originTooltipSuffix}`;
                const nameHtml = safeRowUrl
                  ? `<a href="${escapeHtml(safeRowUrl)}" target="_blank" rel="noopener noreferrer" style="color:#0f172a;font-weight:700;text-decoration:underline;" title="${escapeHtml(rowTooltip)}">${escapeHtml(row.source)} ↗</a>`
                  : `<span style="font-weight:600;" title="${escapeHtml(rowTooltip)}">${escapeHtml(row.source)}</span>`;
                const rejectBtnHtml = row.isCompetitor
                  ? `<button type="button" class="lqs-reject-match-btn" data-slug="${escapeHtml(slug)}" data-source-title="${escapeHtml(title || '')}" data-rejected-url="${escapeHtml(row.url || '')}" data-rejected-title="${escapeHtml(row.offerTitle || row.source || '')}" title="Не тот товар? Навсегда скрыть это совпадение">✕</button>`
                  : '';
                return `
                  <div class="lqs-price-matrix-row ${isBest ? 'is-best-price' : ''}" title="${escapeHtml(rowTooltip)}">
                    <div class="lqs-price-matrix-cell-name">
                      ${isBest ? '🏆 ' : ''}${nameHtml}
                    </div>
                    <div class="lqs-price-matrix-cell-val">
                      ${priceStr}${oldStr}
                      <span class="lqs-price-matrix-badge ${isBest ? 'best' : ''}">${escapeHtml(isBest ? 'ЛУЧШАЯ ЦЕНА' : row.badge)}</span>
                      ${rejectBtnHtml}
                    </div>
                  </div>
                `;
              })
              .join('')}
          </div>
        </div>`
      : `<div>💰 <b>Радар цен:</b> собираю данные по истории цены и другим магазинам...</div>`;

    const top3EmptyHint = top3Competitors.length === 0
      ? `<div class="lqs-top3-empty-hint">🔎 Цены в других сетях ещё не собраны — нажмите «🔄 Найти цены в сетях» или откройте любой магазин ниже</div>`
      : '';

    const storeButtonsHtml = title
      ? `<div class="lqs-stores-strip">
          <span class="lqs-stores-strip-label">🔍 Сети:</span>
          ${storeLinks
            .map((s) => {
              const sKey = normStoreKey(s.store);
              let matchedOffer = bestOfferByStoreKey.get(sKey) || null;
              if (!matchedOffer) {
                for (const [k, v] of bestOfferByStoreKey.entries()) {
                  if (k && sKey && (k.includes(sKey) || sKey.includes(k))) {
                    matchedOffer = v;
                    break;
                  }
                }
              }
              const offerPrice = matchedOffer && matchedOffer.price > 0 ? Math.round(matchedOffer.price) : null;
              const isCheaper = Boolean(offerPrice && lavkaNow && offerPrice < lavkaNow - 2);
              const safeOfferUrl = matchedOffer && matchedOffer.url ? safeHttpUrl(matchedOffer.url) : null;
              const hrefUrl = safeOfferUrl || s.url;
              const pillCls = offerPrice ? (isCheaper ? 'lqs-store-link has-price is-cheaper' : 'lqs-store-link has-price') : 'lqs-store-link is-search';
              const priceSuffix = offerPrice ? ` <span class="lqs-store-pill-price">${offerPrice}₽</span>` : '';
              const kuperRetailerNote = matchedOffer && matchedOffer.sourceRetailer ? ` (витрина: ${matchedOffer.sourceRetailer})` : '';
              return `<a href="${escapeHtml(hrefUrl)}" target="_blank" rel="noopener noreferrer" class="${pillCls}" title="[${escapeHtml(s.category || 'Магазин')}] ${offerPrice ? `Найдена цена ${offerPrice} ₽${escapeHtml(kuperRetailerNote)} — ` : ''}Искать «${escapeHtml(s.query)}» в ${escapeHtml(s.store)}">${escapeHtml(s.store)}${priceSuffix} ↗</a>`;
            })
            .join('')}
        </div>`
      : '';

    return `<div>
      ${matrixTableHtml}
      ${top3EmptyHint}
      ${storeButtonsHtml}
    </div>`;
  }

  const PAID_AI_PROVIDER_LABELS = Object.freeze({
    moduleapi: 'ModuleAPI',
    openai: 'OpenAI',
    anthropic: 'Claude',
    gemini_api: 'Gemini API',
    deepseek: 'DeepSeek',
    openrouter: 'OpenRouter'
  });

  function getPaidProviderUiInfo(settings) {
    const id = String((settings && settings.aiProvider) || 'gemini_tab').trim().toLowerCase();
    const shortName = PAID_AI_PROVIDER_LABELS[id] || '';
    return {
      isPaid: Boolean(shortName),
      providerId: id,
      shortName: shortName || 'ИИ'
    };
  }

  function buildIngredientsGuardPillHtml(meta) {
    const guardApi = globalThis.LQS_INGREDIENTS_GUARD;
    if (!guardApi || typeof guardApi.analyzeIngredientsTrafficLight !== 'function' || !meta) {
      return '';
    }
    const res = guardApi.analyzeIngredientsTrafficLight(meta.ingredients || '', meta.title || '');
    if (!res || res.level === 'none' || !res.badgeText) return '';
    return `<span class="lqs-metric-pill lqs-ing-pill is-${escapeHtml(res.level)}" title="${escapeHtml(res.summary)}">${escapeHtml(res.badgeText)}</span>`;
  }

  function buildMetricsInlineHtml(smart, meta, slug) {
    if (!smart) return '';
    let primaryPill = '';
    if (smart.pricePerKg) {
      const pieceHint = (smart.pricePerPiece && smart.piecesCount > 1)
        ? ` (~${smart.pricePerPiece} ₽/${smart.pieceUnitLabel})`
        : '';
      primaryPill = `<span class="lqs-metric-pill" title="Честная цена за 1 ${smart.unitLabel}${pieceHint}">⚖️ ${smart.pricePerKg}₽/${smart.unitLabel}</span>`;
    } else if (smart.pricePerPiece && smart.piecesCount && smart.piecesCount > 1) {
      primaryPill = `<span class="lqs-metric-pill" title="Товар продаётся поштучно (${smart.piecesCount} ${smart.pieceUnitLabel} в упаковке)">🔢 ${smart.pricePerPiece}₽/${smart.pieceUnitLabel}</span>`;
    } else if (meta && meta.price) {
      primaryPill = `<span class="lqs-metric-pill" title="Товар продаётся поштучно (вес в граммах не указан)">🔢 ${Math.round(meta.price)}₽/шт</span>`;
    } else {
      primaryPill = `<span class="lqs-metric-pill" title="Вес или объём не указан на карточке">⚖️ Поштучно</span>`;
    }

    const proteinPill = smart.pricePer100gProtein
      ? `<span class="lqs-metric-pill protein-pill" title="Стоимость 100 г чистого белка (${smart.proteinPer100g}г белка на 100г)">🥩 ${smart.pricePer100gProtein}₽/100г</span>`
      : '';

    const priceShieldPill = buildPriceShieldAlertPill(slug, meta ? meta.price : null, meta ? meta.title : '', meta ? meta.imageKey : null);

    const ingGuardPill = buildIngredientsGuardPillHtml(meta);

    let aiVerdictPill = '';
    const cachedAi = findAiCacheInMemory(slug, meta ? meta.title : '', meta ? meta.imageKey : null);
    const paidInfo = getPaidProviderUiInfo(cachedSettings);
    if (cachedAi && cachedAi.loading) {
      aiVerdictPill = `<span class="lqs-metric-pill ai-pill-loading" title="ИИ анализирует товар...">🤖 ⏳ ИИ...</span>`;
    } else if (cachedAi && cachedAi.verdict) {
      const vBadge = extractVerdictBadgeFromText(cachedAi.verdict);
      if (vBadge) {
        const badgeTitle = vBadge.title || 'Вердикт ИИ-ревизора';
        aiVerdictPill = `<span class="lqs-metric-pill ${vBadge.cls}" title="${escapeHtml(badgeTitle)}">${escapeHtml(vBadge.text)}</span>`;
      }
    } else if (paidInfo.isPaid) {
      aiVerdictPill = `<button type="button" class="lqs-metric-pill lqs-paid-ai-btn" data-action="run-paid-ai" title="Автозапуск отключён для защиты баланса — нажмите для разбора">🤖 Разобрать через ${escapeHtml(paidInfo.shortName)}</button>`;
    }

    return `${primaryPill} ${proteinPill} ${ingGuardPill} ${priceShieldPill} ${aiVerdictPill}`.trim();
  }

  // ==========================================================================
  // ОТРИСОВКА И СИНХРОНИЗАЦИЯ ВИДЖЕТА НА СТРАНИЦЕ ТОВАРА
  // ==========================================================================
  function updateDrawerToggleButton(panel, isOpen, review, smart) {
    if (!panel) return;
    const dotEl = panel.querySelector('#lqs-drawer-dot');
    const labelEl = panel.querySelector('#lqs-drawer-label');
    if (!dotEl || !labelEl) return;

    const hasBadFlags = smart && Array.isArray(smart.flags) && smart.flags.some((f) => f.type === 'bad');
    const hasNoteOrTags = Boolean(
      review && ((review.note && review.note.trim()) || (Array.isArray(review.tags) && review.tags.length > 0))
    );

    let nextDotClass = 'lqs-dot-indicator is-hidden';
    let nextDotTitle = '';
    if (hasBadFlags) {
      nextDotClass = 'lqs-dot-indicator has-warn';
      nextDotTitle = 'Есть замечания к составу';
    } else if (hasNoteOrTags) {
      nextDotClass = 'lqs-dot-indicator has-note';
      nextDotTitle = 'Есть сохранённая заметка';
    }

    if (dotEl.className !== nextDotClass) {
      dotEl.className = nextDotClass;
      LQS_RECORDER.counters.domWritesExecuted += 1;
    } else {
      LQS_RECORDER.counters.domWritesSkipped += 1;
    }
    if (dotEl.title !== nextDotTitle) {
      dotEl.title = nextDotTitle;
    }

    const nextText = isOpen ? '▴ Скрыть' : '▾ Подробнее';
    if (labelEl.textContent !== nextText) {
      labelEl.textContent = nextText;
      LQS_RECORDER.counters.domWritesExecuted += 1;
    } else {
      LQS_RECORDER.counters.domWritesSkipped += 1;
    }
  }

  function toggleDrawerState(panel, source = 'click') {
    if (!panel) return false;
    const drawer = panel.querySelector('#lqs-drawer');
    const radarBarRoot = panel.querySelector('#lqs-price-radar-bar');
    if (radarBarRoot && !radarBarRoot.dataset.lqsScanBound) {
      radarBarRoot.dataset.lqsScanBound = '1';
      radarBarRoot.addEventListener('click', (ev) => {
        const rejectBtn = ev.target && ev.target.closest ? ev.target.closest('.lqs-reject-match-btn') : null;
        if (rejectBtn && !rejectBtn.disabled) {
          ev.preventDefault();
          ev.stopPropagation();
          const targetSlug = rejectBtn.getAttribute('data-slug') || slug;
          const latestMeta = extractProductPageMetadata() || meta;
          const sourceTitle = rejectBtn.getAttribute('data-source-title') || (latestMeta ? latestMeta.title : '');
          const rejectedUrl = rejectBtn.getAttribute('data-rejected-url') || '';
          const rejectedTitle = rejectBtn.getAttribute('data-rejected-title') || '';
          rejectBtn.disabled = true;
          rejectBtn.textContent = '…';
          chrome.runtime.sendMessage(
            {
              type: 'LQS_REJECT_COMPETITOR_MATCH',
              payload: {
                sourceTitle,
                sourceSlug: targetSlug,
                rejectedUrl,
                rejectedTitle
              }
            },
            (resp) => {
              if (chrome.runtime.lastError || !resp || !resp.ok) {
                rejectBtn.disabled = false;
                rejectBtn.textContent = '✕';
                return;
              }
              const cleanRejUrl = String(rejectedUrl || '').trim();
              const cleanRejTitle = String(rejectedTitle || '').trim().toLowerCase();
              const pruneOffers = (summaryObj) => {
                if (!summaryObj || !Array.isArray(summaryObj.competitorOffers)) return;
                summaryObj.competitorOffers = summaryObj.competitorOffers.filter((o) => {
                  if (!o) return false;
                  if (cleanRejUrl && String(o.url || '').trim() === cleanRejUrl) return false;
                  if (cleanRejTitle && String(o.title || o.store || '').trim().toLowerCase() === cleanRejTitle) return false;
                  return true;
                });
                const priced = summaryObj.competitorOffers.filter((o) => o && o.price > 0);
                summaryObj.competitorMinPrice = priced.length > 0 ? Math.min(...priced.map((o) => o.price)) : null;
              };
              const cachedSum = priceSummaryBySlug.get(targetSlug);
              if (cachedSum) pruneOffers(cachedSum);
              if (priceDbMemory && priceDbMemory[targetSlug]) pruneOffers(priceDbMemory[targetSlug]);
              const activePanel = document.querySelector(`.lqs-product-panel[data-slug="${CSS.escape(targetSlug)}"]`) || panel;
              if (activePanel) {
                syncExistingPanelUI(activePanel, currentReviewCache, extractProductPageMetadata() || latestMeta || meta);
              } else {
                const rowEl = rejectBtn.closest('.lqs-price-matrix-row');
                if (rowEl) rowEl.remove();
              }
            }
          );
          return;
        }
        const scanBtn = ev.target && ev.target.closest ? ev.target.closest('.lqs-scan-stores-btn') : null;
        if (!scanBtn || scanBtn.disabled) return;
        const targetSlug = scanBtn.getAttribute('data-slug') || slug;
        const latestMeta = extractProductPageMetadata() || meta;
        scanBtn.disabled = true;
        scanBtn.textContent = '⏳ Ищу в сетях...';
        chrome.runtime.sendMessage(
          {
            type: 'LQS_SCAN_STORES_LIVE',
            payload: {
              slug: targetSlug,
              title: latestMeta ? latestMeta.title : '',
              brand: latestMeta ? latestMeta.brand : '',
              amount: latestMeta ? latestMeta.amountText : '',
              price: latestMeta ? latestMeta.price : null,
              imageKey: latestMeta ? latestMeta.imageKey : null,
              isAuto: false,
              forceRefresh: true
            }
          },
          (resp) => {
            if (chrome.runtime.lastError || !resp || !resp.ok) {
              scanBtn.disabled = false;
              scanBtn.textContent = '🔄 Найти цены в сетях';
              return;
            }
            if (resp.summary) {
              priceSummaryBySlug.set(targetSlug, resp.summary);
              if (priceDbMemory) priceDbMemory[targetSlug] = resp.summary;
            }
            const activePanel = document.querySelector(`.lqs-product-panel[data-slug="${CSS.escape(targetSlug)}"]`) || panel;
            if (activePanel) {
              syncExistingPanelUI(activePanel, currentReviewCache, extractProductPageMetadata() || latestMeta);
              showRadarDiagnosticNote(activePanel, resp, false);
            }
          }
        );
      });
    }
    if (!drawer) return false;

    const isOpen = drawer.classList.toggle('open');
    const slug = panel.dataset.slug || extractSlugFromUrl(window.location.href);
    if (slug) {
      drawerOpenBySlug.set(slug, isOpen);
      // ЗАПОМИНАЕМ РУЧНОЙ ВЫБОР ПОЛЬЗОВАТЕЛЯ! Если пользователь сам нажал «▴ Скрыть»,
      // фоновые ререндеры и кэш ИИ больше НЕ имеют права сами открывать спойлер обратно!
      userManualDrawerStateBySlug.set(slug, isOpen);
    }

    const latestMeta = extractProductPageMetadata();
    const latestSmart = analyzeProductQuality(latestMeta);
    updateDrawerToggleButton(panel, isOpen, currentReviewCache, latestSmart);

    LQS_RECORDER.counters.drawerToggles += 1;
    LQS_RECORDER.record('USER_ACTION', `Spoiler drawer ${isOpen ? 'OPENED' : 'CLOSED'} (${source})`, { slug });
    return isOpen;
  }

  function renderAiVerdictIntoPanel(panel, slug, meta, resultObj, shouldOpenDrawer = true, isExplicitUserAiClick = false) {
    if (!panel || !resultObj || !resultObj.verdict) return;
    const drawer = panel.querySelector('#lqs-drawer');
    const aiBox = panel.querySelector('#lqs-ai-box');
    const aiContent = panel.querySelector('#lqs-ai-content');
    const aiSources = panel.querySelector('#lqs-ai-sources');
    const refreshBtn = panel.querySelector('#lqs-ai-refresh');
    if (!aiBox || !aiContent || !aiSources) return;

    if (refreshBtn) {
      refreshBtn.textContent = '🔄 Обновить';
      refreshBtn.disabled = false;
    }

    if (resultObj.priceSummary && slug) {
      priceSummaryBySlug.set(slug, resultObj.priceSummary);
    }

    lastAiResultBySlug.set(slug, {
      verdict: resultObj.verdict,
      sources: resultObj.sources || [],
      mode: resultObj.mode || 'Автопилот ИИ',
      loading: false
    });

    panel.dataset.lqsRenderedAiSlug = slug || '';
    panel.dataset.lqsRenderedAiVerdictLen = String(resultObj.verdict.length);

    // Если пользователь вручную закрыл спойлер («▴ Скрыть»), НЕ открываем его повторно при фоновых мутациях!
    const userManuallyClosed = Boolean(slug && userManualDrawerStateBySlug.get(slug) === false);
    if (shouldOpenDrawer && (!userManuallyClosed || isExplicitUserAiClick) && drawer && !drawer.classList.contains('open')) {
      drawer.classList.add('open');
      if (slug) drawerOpenBySlug.set(slug, true);
      if (isExplicitUserAiClick && slug) userManualDrawerStateBySlug.set(slug, true);
    }

    const smart = analyzeProductQuality(meta);
    updateDrawerToggleButton(panel, Boolean(drawer && drawer.classList.contains('open')), currentReviewCache, smart);

    const metricsBox = panel.querySelector('#lqs-metrics-inline');
    if (metricsBox) {
      setHtmlIfChanged(metricsBox, buildMetricsInlineHtml(smart, meta, slug), 'metrics-inline-ai');
    }

    const radarBar = panel.querySelector('#lqs-price-radar-bar');
    if (radarBar) {
      setHtmlIfChanged(radarBar, buildPriceRadarDrawerBarHtml(slug, meta ? meta.price : null, meta), 'price-radar-bar');
    }

    aiBox.classList.add('visible');
    const nextAiHtml = formatAiTextToHtml(resultObj.verdict);
    if (aiContent.innerHTML !== nextAiHtml) {
      aiContent.innerHTML = nextAiHtml;
    }
    const sourceLinks = Array.isArray(resultObj.sources)
      ? resultObj.sources
          .filter((s) => s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url))
          .map((s) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">🔗 ${escapeHtml(s.title || 'Источник')}</a>`)
          .join('')
      : '';

    const modeBadge = `<span style="color:#0369a1;font-size:11px;font-weight:600;">⚡ ${escapeHtml(resultObj.mode || 'Автопилот ИИ')}</span>`;
    const nextSourcesHtml = sourceLinks ? `${modeBadge} ${sourceLinks}` : modeBadge;
    if (aiSources.innerHTML !== nextSourcesHtml) {
      aiSources.innerHTML = nextSourcesHtml;
    }
  }

  function syncExistingPanelUI(panel, review, meta) {
    LQS_RECORDER.counters.panelSyncs += 1;
    currentReviewCache = review;
    const slug = panel.dataset.slug || extractSlugFromUrl(window.location.href);

    const r = (review && review.rating) ? Number(review.rating) : 0;
    const banned = Boolean(review && review.banned);
    const tags = (review && Array.isArray(review.tags)) ? review.tags : [];
    const note = (review && review.note) ? String(review.note) : '';
    const hasAnyReviewData = Boolean(r > 0 || banned || tags.length > 0 || note.trim());

    const shouldBeBanned = banned || (r > 0 && r <= 2);
    const shouldBeGod = !banned && r >= 4;

    if (panel.classList.contains('is-banned') !== shouldBeBanned) {
      panel.classList.toggle('is-banned', shouldBeBanned);
    }
    if (panel.classList.contains('is-god') !== shouldBeGod) {
      panel.classList.toggle('is-god', shouldBeGod);
    }

    panel.querySelectorAll('.lqs-star-btn').forEach((b) => {
      const s = parseInt(b.dataset.star, 10);
      const isActive = r >= s;
      if (b.classList.contains('active') !== isActive) {
        b.classList.toggle('active', isActive);
      }
    });

    const smart = meta ? analyzeProductQuality(meta) : null;

    const metricsBox = panel.querySelector('#lqs-metrics-inline');
    if (metricsBox && smart) {
      const nextMetricsHtml = buildMetricsInlineHtml(smart, meta, slug);
      setHtmlIfChanged(metricsBox, nextMetricsHtml, 'metrics-inline');
    }

    const radarBar = panel.querySelector('#lqs-price-radar-bar');
    if (radarBar) {
      setHtmlIfChanged(radarBar, buildPriceRadarDrawerBarHtml(slug, meta ? meta.price : null, meta), 'price-radar-bar');
    }

    const flagsBox = panel.querySelector('#lqs-drawer-flags');
    if (flagsBox && smart) {
      const nextFlagsHtml = smart.flags.map((f) => `<span class="lqs-flag-${f.type}">${escapeHtml(f.text)}</span>`).join('');
      setHtmlIfChanged(flagsBox, nextFlagsHtml, 'drawer-flags');
    }

    const banBtn = panel.querySelector('#lqs-ban-toggle');
    if (banBtn) {
      if (banBtn.classList.contains('ban-active') !== banned) {
        banBtn.classList.toggle('ban-active', banned);
      }
      const nextBanText = banned ? '💀 В бане' : '🚫 В бан';
      if (banBtn.textContent !== nextBanText) {
        banBtn.textContent = nextBanText;
      }
    }

    const resetBtn = panel.querySelector('#lqs-reset-review');
    if (resetBtn) {
      resetBtn.classList.toggle('is-hidden', !hasAnyReviewData);
    }

    const drawer = panel.querySelector('#lqs-drawer');
    if (drawer) {
      const isOpen = drawer.classList.contains('open');
      updateDrawerToggleButton(panel, isOpen, review, smart);
    }

    panel.querySelectorAll('.lqs-tag-chip').forEach((chip) => {
      const isSelected = tags.includes(chip.dataset.tag);
      if (chip.classList.contains('selected') !== isSelected) {
        chip.classList.toggle('selected', isSelected);
      }
    });

    const noteArea = panel.querySelector('#lqs-note-area');
    if (noteArea && document.activeElement !== noteArea && noteArea.value !== note) {
      noteArea.value = note;
    }
  }

  function showRadarDiagnosticNote(activePanel, resp, isAuto = false) {
    if (!activePanel || !resp) return;
    const rb = activePanel.querySelector('#lqs-price-radar-bar');
    if (!rb) return;
    const diags = Array.isArray(resp.storeDiagnostics) ? resp.storeDiagnostics : [];
    const needAddr = diags.filter((d) => d && d.reason === 'needs_address').map((d) => d.store);
    const captchas = diags.filter((d) => d && d.reason === 'captcha').map((d) => d.store);
    const checkedList = Array.isArray(resp.storesChecked) && resp.storesChecked.length > 0
      ? resp.storesChecked.join(', ')
      : 'сети';

    let text = '';
    if (resp.matchedCount > 0) {
      text = isAuto
        ? `✅ Авто-радар (${checkedList}): найдено цен — ${resp.matchedCount}`
        : `✅ Проверено (${checkedList}): найдено совпадений — ${resp.matchedCount}`;
      if (needAddr.length > 0) {
        text += ` • Укажите адрес 1 раз на сайте: ${needAddr.join(', ')}`;
      }
    } else if (needAddr.length > 0) {
      text = `📍 ${needAddr.join(', ')}: выберите адрес доставки на сайте 1 раз в Chrome — после этого цены будут подтягиваться автоматически`;
    } else if (captchas.length > 0) {
      text = `🛡️ ${captchas.join(', ')}: сайт показал проверку от роботов (капчу) — откройте магазин вручную по кнопке ниже`;
    } else if (!isAuto) {
      text = `ℹ️ Проверено (${checkedList}), просмотрено ${resp.harvestedCount || 0} карточек — точных совпадений по весу не нашлось`;
    }
    if (!text) return;

    let note = rb.querySelector('.lqs-scan-status-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'lqs-scan-status-note';
      rb.prepend(note);
    }
    note.textContent = text;
    setTimeout(() => { if (note && note.parentElement) note.remove(); }, needAddr.length > 0 ? 11000 : 7000);
  }

  function triggerAutoRadarIfNeeded(slug, meta, summary, panel) {
    if (!slug || !meta || !meta.title) return;
    if (cachedSettings.autoRadarOnProductPage === false) return;
    if (autoRadarTriggeredSlugs.has(slug)) return;
    if (!window.location.pathname.includes('/good/')) return;

    const ttlMs = (globalThis.LQS_CONFIG?.LIMITS?.AUTO_RADAR_TTL_MS) || (24 * 60 * 60 * 1000);
    const lastScanMs = summary && summary.lastRadarScanAt ? Date.parse(summary.lastRadarScanAt) : 0;
    if (lastScanMs && Number.isFinite(lastScanMs) && (Date.now() - lastScanMs) < ttlMs) {
      return;
    }

    autoRadarTriggeredSlugs.add(slug);
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage(
        {
          type: 'LQS_SCAN_STORES_LIVE',
          payload: {
            slug,
            title: meta.title || '',
            brand: meta.brand || '',
            amount: meta.amountText || '',
            price: meta.price || null,
            imageKey: meta.imageKey || null,
            isAuto: true,
            forceRefresh: false
          }
        },
        (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.ok || resp.skipped) return;
          if (resp.summary) {
            priceSummaryBySlug.set(slug, resp.summary);
            if (priceDbMemory) priceDbMemory[slug] = resp.summary;
          }
          const activePanel = document.querySelector(`.lqs-product-panel[data-slug="${CSS.escape(slug)}"]`) || panel;
          if (activePanel) {
            syncExistingPanelUI(activePanel, currentReviewCache, extractProductPageMetadata() || meta);
            showRadarDiagnosticNote(activePanel, resp, true);
          }
        }
      );
    }
  }

  function triggerPriceIntelForProduct(slug, meta, panel) {
    if (!slug || !meta || !meta.price) return;
    if (priceIntelRequestedSlugs.has(slug)) return;
    priceIntelRequestedSlugs.add(slug);

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage(
        {
          type: 'LQS_GET_PRICE_INTEL',
          slug,
          title: meta.title,
          price: meta.price,
          oldPrice: meta.oldPrice,
          amount: meta.amountText,
          accountId: detectCurrentAccountLabel(),
          isFromProductCard: true,
          imageKey: meta.imageKey || null,
          brand: meta.brand || ''
        },
        (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.summary) return;
          priceSummaryBySlug.set(slug, resp.summary);
          if (priceDbMemory) priceDbMemory[slug] = resp.summary;
          const activePanel = document.querySelector(`.lqs-product-panel[data-slug="${CSS.escape(slug)}"]`) || panel;
          if (activePanel) {
            const latestMeta = extractProductPageMetadata();
            syncExistingPanelUI(activePanel, currentReviewCache, latestMeta);
            triggerAutoRadarIfNeeded(slug, latestMeta || meta, resp.summary, activePanel);
          }
        }
      );
    }
  }

  async function requestAiProductReview(meta, panel, forceRefresh = false, isZeroClickAuto = false, retryCount = 0, isManualUserClick = false) {
    const drawer = panel.querySelector('#lqs-drawer');
    const aiBox = panel.querySelector('#lqs-ai-box');
    const aiContent = panel.querySelector('#lqs-ai-content');
    const aiSources = panel.querySelector('#lqs-ai-sources');
    const refreshBtn = panel.querySelector('#lqs-ai-refresh');

    const slug = panel.dataset.slug || extractSlugFromUrl(window.location.href);
    const settings = await getSettings();

    if (isManualUserClick && slug) {
      userManualDrawerStateBySlug.set(slug, true);
    }
    const userManuallyClosed = Boolean(slug && userManualDrawerStateBySlug.get(slug) === false);

    if (isManualUserClick || (!isZeroClickAuto && !userManuallyClosed) || (settings.autoOpenDrawerOnAi !== false && !userManuallyClosed)) {
      drawer.classList.add('open');
      if (slug) drawerOpenBySlug.set(slug, true);
    }

    if (refreshBtn && forceRefresh) {
      refreshBtn.textContent = '⏳ Обновляю...';
    }

    lastAiResultBySlug.set(slug, { loading: true });
    const smart = analyzeProductQuality(meta);
    updateDrawerToggleButton(panel, drawer.classList.contains('open'), currentReviewCache, smart);

    const metricsBox = panel.querySelector('#lqs-metrics-inline');
    if (metricsBox) {
      setHtmlIfChanged(metricsBox, buildMetricsInlineHtml(smart, meta, slug), 'metrics-inline-loading');
    }

    aiBox.classList.add('visible');
    aiContent.innerHTML = isZeroClickAuto
      ? '⏳ <b>Zero-Click Автопилот:</b> сверяю историю цены, предложения в других сетях, отзывы и состав...'
      : '⏳ Ищу отзывы, цены конкурентов именно на этот товар и спрашиваю ИИ-ревизора...';
    aiSources.innerHTML = '';

    const t0 = performance.now();
    if (isZeroClickAuto && retryCount === 0) {
      LQS_RECORDER.counters.autoAiRuns += 1;
    }
    LQS_RECORDER.record('AI', `Started AI review for "${meta.title}" (force=${forceRefresh}, auto=${isZeroClickAuto}, retry=${retryCount})`);
    LQS_RECORDER.updateModule('aiReviewer', 'RUNNING', `Запрос ИИ-ревизора для "${meta.title.slice(0, 30)}"...`);

    let resolvedViaCachePoll = false;
    const pollTimer = !forceRefresh
      ? setInterval(() => {
          chrome.storage.local.get([AI_CACHE_KEY], (res) => {
            const map = res && res[AI_CACHE_KEY] ? res[AI_CACHE_KEY] : {};
            aiCacheMemory = map;
            const found = findAiCacheInMemory(slug, meta.title, meta.imageKey);
            if (found && found.verdict && !found.loading) {
              resolvedViaCachePoll = true;
              clearInterval(pollTimer);
              renderAiVerdictIntoPanel(panel, slug, meta, found, !isZeroClickAuto || settings.autoOpenDrawerOnAi !== false);
            }
          });
        }, 1200)
      : null;

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        const bgResult = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            {
              type: 'LQS_ANALYZE_PRODUCT',
              payload: {
                slug,
                title: meta.title,
                brand: meta.brand,
                imageKey: meta.imageKey || null,
                amount: meta.amountText,
                price: meta.price,
                oldPrice: meta.oldPrice,
                accountId: detectCurrentAccountLabel(),
                ingredients: meta.ingredientsText,
                traits: meta.traitsText,
                pricePerKg: smart.pricePerKg,
                unitLabel: smart.unitLabel,
                pricePerPiece: smart.pricePerPiece,
                pieceUnitLabel: smart.pieceUnitLabel,
                piecesCount: smart.piecesCount,
                proteinPer100g: smart.proteinPer100g,
                pricePer100gProtein: smart.pricePer100gProtein,
                forceRefresh: Boolean(forceRefresh),
                isManualUserClick: Boolean(isManualUserClick)
              }
            },
            (resp) => {
              if (chrome.runtime.lastError) {
                resolve({ ok: false, channelClosed: true, error: chrome.runtime.lastError.message });
              } else {
                resolve(resp || { ok: false, channelClosed: true, error: 'Empty response from background service worker' });
              }
            }
          );
        });

        if (pollTimer) clearInterval(pollTimer);
        if (resolvedViaCachePoll) return;

        if (refreshBtn) {
          refreshBtn.textContent = '🔄 Обновить';
        }

        if (bgResult && bgResult.ok && bgResult.verdict) {
          const dt = Math.round(performance.now() - t0);
          const modeLabel = bgResult.mode || 'Автопилот Gemini';
          LQS_RECORDER.updateModule(
            'aiReviewer',
            'OK',
            `Ответ через [${modeLabel}] за ${dt} мс (источников: ${(bgResult.sources || []).length})`
          );
          renderAiVerdictIntoPanel(
            panel,
            slug,
            meta,
            bgResult,
            !isZeroClickAuto || settings.autoOpenDrawerOnAi !== false,
            Boolean(isManualUserClick)
          );
          return;
        }

        const isChannelClosedErr =
          bgResult &&
          (bgResult.channelClosed ||
            /message channel closed|receiving end does not exist/i.test(String(bgResult.error || '')));

        if (isChannelClosedErr) {
          const cachedNow = await new Promise((r) => {
            chrome.runtime.sendMessage(
              { type: 'LQS_GET_CACHED_AI_VERDICT', slug, title: meta.title, imageKey: meta.imageKey || null },
              (cResp) => {
                if (chrome.runtime.lastError || !cResp || !cResp.entry) r(null);
                else r(cResp.entry);
              }
            );
          });
          if (cachedNow && cachedNow.verdict) {
            renderAiVerdictIntoPanel(panel, slug, meta, cachedNow, !isZeroClickAuto || settings.autoOpenDrawerOnAi !== false);
            return;
          }
          if (retryCount < 1) {
            aiContent.innerHTML = '⏳ <b>Дожимаю ответ от ИИ-ревизора</b> (вкладка Gemini заканчивает разбор)...';
            await new Promise((r) => setTimeout(r, 900));
            return await requestAiProductReview(meta, panel, false, isZeroClickAuto, retryCount + 1);
          }
          bgResult.error = 'Вкладка Gemini ещё формирует ответ. Нажми «🔄 Обновить» через пару секунд (или проверь открытую вкладку gemini.google.com).';
        }

        if (bgResult && bgResult.error && !bgResult.skippedStale) {
          lastAiResultBySlug.delete(slug);
          if (metricsBox) {
            setHtmlIfChanged(metricsBox, buildMetricsInlineHtml(smart, meta, slug), 'metrics-inline-err');
          }
          const dt = Math.round(performance.now() - t0);
          LQS_RECORDER.updateModule('aiReviewer', 'WARN', `Ответ оркестратора (${dt} мс): ${bgResult.error}`);
          if (bgResult.needsGeminiLogin) {
            const safeLoginUrl = safeHttpUrl(bgResult.loginUrl) || 'https://gemini.google.com/app';
            aiContent.innerHTML = `⚠️ <b>${escapeHtml(bgResult.error)}</b><div style="margin-top:8px;"><a class="lqs-mini-btn lqs-paid-ai-btn" href="${escapeHtml(safeLoginUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;text-decoration:none;">🔑 Открыть Gemini для входа</a></div>`;
          } else {
            aiContent.innerHTML = `⚠️ <b>${escapeHtml(bgResult.error)}</b>`;
          }
          if (Array.isArray(bgResult.sources) && bgResult.sources.length > 0) {
            aiSources.innerHTML = bgResult.sources
              .filter((s) => s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url))
              .map((s) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">🔗 ${escapeHtml(s.title || 'Отзыв в сети')}</a>`)
              .join('');
          }
          return;
        }
      } catch (bgErr) {
        if (pollTimer) clearInterval(pollTimer);
        LQS_RECORDER.record('AI', `Background orchestrator exception: ${bgErr.message || bgErr}`);
      }
    }

    if (pollTimer) clearInterval(pollTimer);
    if (refreshBtn) refreshBtn.textContent = '🔄 Обновить';

    lastAiResultBySlug.delete(slug);
    if (metricsBox) {
      setHtmlIfChanged(metricsBox, buildMetricsInlineHtml(smart, meta, slug), 'metrics-inline-fallback');
    }

    aiContent.innerHTML =
      `⚠️ <b>Для запуска Автопилота ИИ нужно один раз войти в аккаунт Google на <a href="https://gemini.google.com/" target="_blank" rel="noopener noreferrer">gemini.google.com</a>!</b>`;
  }

  function scheduleZeroClickAiForProduct(slug, panel) {
    if (!slug || !panel) return;

    const latestMeta = extractProductPageMetadata();
    const cachedEntry = findAiCacheInMemory(slug, latestMeta.title, latestMeta.imageKey);
    if (cachedEntry && cachedEntry.verdict) {
      const aiBox = panel.querySelector('#lqs-ai-box');
      if (
        panel.dataset.lqsRenderedAiSlug === slug &&
        panel.dataset.lqsRenderedAiVerdictLen === String(cachedEntry.verdict.length) &&
        aiBox &&
        aiBox.classList.contains('visible')
      ) {
        return;
      }
      getSettings().then((settings) => {
        renderAiVerdictIntoPanel(panel, slug, latestMeta, cachedEntry, settings.autoOpenDrawerOnAi !== false, false);
      });
      return;
    }

    if (autoAiTriggeredSlugs.has(slug)) return;

    clearTimeout(autoAiDebounceTimer);
    autoAiDebounceTimer = setTimeout(async () => {
      const currentSlug = extractSlugFromUrl(window.location.href);
      if (currentSlug !== slug) return;

      const settings = await getSettings();
      cachedSettings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
      const paidInfo = getPaidProviderUiInfo(cachedSettings);
      const aiBtnEl = panel.querySelector('#lqs-ai-btn');
      if (aiBtnEl) {
        aiBtnEl.textContent = paidInfo.isPaid
          ? `🤖 Разобрать через ${paidInfo.shortName}`
          : '🤖 ИИ-обзор';
      }
      if (paidInfo.isPaid) {
        // Защита кошелька: никогда не тратим платный API автоматически при просмотре карточки
        const mBox = panel.querySelector('#lqs-metrics-inline');
        const mNow = extractProductPageMetadata();
        if (mBox && mNow) {
          setHtmlIfChanged(mBox, buildMetricsInlineHtml(analyzeProductQuality(mNow), mNow, slug), 'metrics-paid-guard');
        }
        return;
      }
      if (settings.autoRunAiOnProductPage === false) return;

      const activePanel = document.querySelector(`.lqs-product-panel[data-slug="${CSS.escape(slug)}"]`) || panel;
      const metaNow = extractProductPageMetadata();
      if (!metaNow || !metaNow.title) return;

      const cachedNow = findAiCacheInMemory(slug, metaNow.title, metaNow.imageKey);
      if (cachedNow && cachedNow.verdict) {
        renderAiVerdictIntoPanel(activePanel, slug, metaNow, cachedNow, settings.autoOpenDrawerOnAi !== false);
        return;
      }

      autoAiTriggeredSlugs.add(slug);
      requestAiProductReview(metaNow, activePanel, false, true, 0);
    }, 550);
  }

  async function renderProductPageWidget() {
    if (isRenderingProduct) {
      pendingProductRender = true;
      return;
    }

    const slug = extractSlugFromUrl(window.location.href);
    const mainPage = document.querySelector('main[data-testid="good-page-desktop"]');
    if (!slug || !mainPage) {
      return;
    }

    const infoBlock = mainPage.querySelector('div[data-testid="product-info"]') ||
                      mainPage.querySelector('div[data-testid="product-card-header"]');
    if (!infoBlock) {
      return;
    }

    isRenderingProduct = true;
    try {
      const db = await getReviewsDB();
      const meta = extractProductPageMetadata();
      const match = findReviewInDB(db, {
        slug,
        productId: meta.productId,
        imageKey: meta.imageKey,
        cleanTitle: meta.cleanTitle
      });
      const savedReview = match ? match.item : null;

      const current = {
        rating: (savedReview && savedReview.rating) ? Number(savedReview.rating) : 0,
        note: (savedReview && savedReview.note) ? String(savedReview.note) : '',
        tags: (savedReview && Array.isArray(savedReview.tags)) ? [...savedReview.tags] : [],
        banned: Boolean(savedReview && savedReview.banned)
      };
      currentReviewCache = current;

      guardAddToCartButton(current);

      let existing = mainPage.querySelector('.lqs-product-panel');
      if (existing && existing.dataset.slug === slug) {
        syncExistingPanelUI(existing, current, meta);
        triggerPriceIntelForProduct(slug, meta, existing);
        scheduleZeroClickAiForProduct(slug, existing);
        return;
      }
      if (existing) existing.remove();

      const smart = analyzeProductQuality(meta);
      const isDrawerInitiallyOpen = Boolean(drawerOpenBySlug.get(slug));
      const hasAnyReviewData = Boolean(current.rating > 0 || current.banned || current.tags.length > 0 || current.note.trim());

      const panel = document.createElement('div');
      panel.className = `lqs-product-panel ${current.banned || (current.rating > 0 && current.rating <= 2) ? 'is-banned' : (current.rating >= 4 ? 'is-god' : '')}`;
      panel.dataset.slug = slug;

      const initialMetricsHtml = buildMetricsInlineHtml(smart, meta, slug);
      const initialFlagsHtml = smart.flags.map((f) => `<span class="lqs-flag-${f.type}">${escapeHtml(f.text)}</span>`).join('');
      const initialRadarHtml = buildPriceRadarDrawerBarHtml(slug, meta.price, meta);

      panel.innerHTML = `
        <div class="lqs-main-bar">
          <div class="lqs-core-left">
            <div class="lqs-stars-inline" id="lqs-stars-box">
              ${[1, 2, 3, 4, 5].map((n) => `
                <button type="button" class="lqs-star-btn ${current.rating >= n ? 'active' : ''}" data-star="${n}" title="Оценить на ${n}">★</button>
              `).join('')}
            </div>

            <div class="lqs-metrics-inline" id="lqs-metrics-inline">${initialMetricsHtml}</div>
          </div>

          <button type="button" class="lqs-drawer-toggle-btn" id="lqs-drawer-toggle" title="Открыть заметку, радар цен, состав и ИИ-обзор">
            <span class="lqs-dot-indicator is-hidden" id="lqs-drawer-dot"></span>
            <span class="lqs-toggle-label" id="lqs-drawer-label">${isDrawerInitiallyOpen ? '▴ Скрыть' : '▾ Подробнее'}</span>
          </button>
        </div>

        <div class="lqs-drawer ${isDrawerInitiallyOpen ? 'open' : ''}" id="lqs-drawer">
          <div class="lqs-price-radar-bar" id="lqs-price-radar-bar">${initialRadarHtml}</div>
          <div class="lqs-price-chart-section" id="lqs-price-chart-section"></div>

          <div class="lqs-drawer-toolbar">
            <div class="lqs-drawer-actions">
              <button type="button" class="lqs-mini-btn ai-btn" id="lqs-ai-btn" title="Найти отзывы в сети и спросить ИИ">
                ${getPaidProviderUiInfo(cachedSettings).isPaid ? `🤖 Разобрать через ${escapeHtml(getPaidProviderUiInfo(cachedSettings).shortName)}` : '🤖 ИИ-обзор'}
              </button>
              <button type="button" class="lqs-mini-btn ${current.banned ? 'ban-active' : ''}" id="lqs-ban-toggle" title="В чёрный список">
                ${current.banned ? '💀 В бане' : '🚫 В бан'}
              </button>
              <button type="button" class="lqs-mini-btn reset-btn ${hasAnyReviewData ? '' : 'is-hidden'}" id="lqs-reset-review" title="Очистить оценку и заметку для этого товара">
                🗑️ Сброс
              </button>
            </div>

            <div class="lqs-drawer-flags" id="lqs-drawer-flags">${initialFlagsHtml}</div>
          </div>

          <div class="lqs-note-wrap">
            <textarea class="lqs-note-input" id="lqs-note-area" rows="2" placeholder="Короткая заметка о товаре..."></textarea>
            <button type="button" class="lqs-save-btn" id="lqs-save-btn">💾 Ок</button>
          </div>

          <div class="lqs-ai-box" id="lqs-ai-box">
            <div class="lqs-ai-header">
              <span class="lqs-ai-header-title">🤖 ИИ-разбор состава, отзывов и цен</span>
              <button type="button" class="lqs-ai-refresh-btn" id="lqs-ai-refresh" title="Принудительно переспросить ИИ-ревизора">🔄 Обновить</button>
            </div>
            <div class="lqs-ai-content" id="lqs-ai-content"></div>
            <div class="lqs-ai-sources" id="lqs-ai-sources"></div>
          </div>
        </div>
      `;

      const metricsEl = panel.querySelector('#lqs-metrics-inline');
      if (metricsEl) metricsEl.dataset.lqsHtmlCache = initialMetricsHtml;
      const flagsEl = panel.querySelector('#lqs-drawer-flags');
      if (flagsEl) flagsEl.dataset.lqsHtmlCache = initialFlagsHtml;

      updateDrawerToggleButton(panel, isDrawerInitiallyOpen, current, smart);

      // Гидратация интерактивного графика истории цены (встроенный блок по умолчанию + опциональное окно как в Alitools)
      (function initProductPriceChart() {
        const chartApi = globalThis.LQS_PRICE_CHART;
        if (!chartApi || typeof chartApi.mountPriceChartWidget !== 'function') return;
        const chartHost = panel.querySelector('#lqs-price-chart-section');
        if (!chartHost) return;

        function getOrCreatePopoverEl() {
          let pop = document.getElementById('lqs-price-chart-popover');
          if (!pop) {
            pop = document.createElement('div');
            pop.id = 'lqs-price-chart-popover';
            pop.className = 'lqs-price-chart-popover';
            if (Object.prototype.hasOwnProperty.call(HTMLElement.prototype, 'popover')) {
              pop.setAttribute('popover', 'auto');
            }
            document.body.appendChild(pop);
          }
          return pop;
        }

        function showPopoverEl(pop) {
          if (typeof pop.showPopover === 'function') {
            try {
              if (!pop.matches(':popover-open')) pop.showPopover();
            } catch {
              pop.classList.add('lqs-popover-fallback-open');
            }
          } else {
            pop.classList.add('lqs-popover-fallback-open');
          }
        }

        function hidePopoverEl(pop) {
          if (typeof pop.hidePopover === 'function') {
            try {
              if (pop.matches(':popover-open')) pop.hidePopover();
            } catch {
              pop.classList.remove('lqs-popover-fallback-open');
            }
          } else {
            pop.classList.remove('lqs-popover-fallback-open');
          }
        }

        function fetchHistory(days) {
          return new Promise((resolve) => {
            try {
              chrome.runtime.sendMessage(
                {
                  type: 'LQS_GET_PRICE_HISTORY',
                  slug,
                  title: meta.title || '',
                  days
                },
                (resp) => {
                  if (chrome.runtime.lastError || !resp || !resp.ok || !resp.data) {
                    resolve(null);
                  } else {
                    resolve(resp.data);
                  }
                }
              );
            } catch {
              resolve(null);
            }
          });
        }

        function toggleWatch(nextWatch) {
          return new Promise((resolve) => {
            try {
              chrome.runtime.sendMessage(
                {
                  type: 'LQS_TOGGLE_WATCHLIST',
                  slug,
                  title: meta.title || '',
                  amount: meta.amountText || '',
                  price: meta.price || null,
                  watch: nextWatch
                },
                (resp) => {
                  if (chrome.runtime.lastError || !resp) {
                    resolve({ ok: false });
                  } else {
                    resolve(resp);
                  }
                }
              );
            } catch {
              resolve({ ok: false });
            }
          });
        }

        function openChartPopover(seedData, initState = {}) {
          const pop = getOrCreatePopoverEl();
          chartApi.mountPriceChartWidget(pop, seedData, {
            isPopover: true,
            initialMode: initState.mode || 'exact',
            initialDays: initState.days ?? 90,
            onPeriodChange: (d) => fetchHistory(d),
            onToggleWatch: (w) => toggleWatch(w),
            onClose: () => hidePopoverEl(pop)
          });
          showPopoverEl(pop);
        }

        function removeAlitoolsDock() {
          const oldDock = document.getElementById('lqs-alitools-dock');
          if (oldDock) oldDock.remove();
        }

        function mountAlitoolsDock(historyData) {
          removeAlitoolsDock();
          const dock = document.createElement('div');
          dock.id = 'lqs-alitools-dock';
          dock.className = 'lqs-alitools-dock';
          dock.dataset.slug = slug;
          const isW = Boolean(historyData && historyData.isWatched);
          dock.innerHTML = `
            <button type="button" class="lqs-alitools-dock-btn is-price" title="Открыть график истории цены">
              <span class="lqs-alitools-icon">📈</span>
              <span>цена</span>
            </button>
            <button type="button" class="lqs-alitools-dock-btn is-watch ${isW ? 'is-watched' : ''}" title="${isW ? 'Убрать из отслеживания' : 'Следить за ценой товара'}">
              <span>${isW ? '❤️' : '🤍'}</span>
            </button>
          `;
          document.body.appendChild(dock);

          let latestData = historyData;
          const priceBtn = dock.querySelector('.is-price');
          const watchBtn = dock.querySelector('.is-watch');
          if (priceBtn) {
            priceBtn.addEventListener('click', async () => {
              const fresh = (await fetchHistory(90)) || latestData;
              latestData = fresh;
              openChartPopover(fresh, { mode: 'exact', days: 90 });
            });
          }
          if (watchBtn) {
            watchBtn.addEventListener('click', async () => {
              watchBtn.disabled = true;
              const res = await toggleWatch(!(latestData && latestData.isWatched));
              watchBtn.disabled = false;
              if (res && typeof res.watched === 'boolean') {
                latestData = { ...(latestData || {}), isWatched: res.watched };
                watchBtn.classList.toggle('is-watched', res.watched);
                watchBtn.innerHTML = `<span>${res.watched ? '❤️' : '🤍'}</span>`;
                watchBtn.title = res.watched ? 'Убрать из отслеживания' : 'Следить за ценой товара';
              }
            });
          }
        }

        const storageKey = (globalThis.LQS_CONFIG && globalThis.LQS_CONFIG.STORAGE_KEYS.SETTINGS) || 'lqs_settings_v2';
        chrome.storage.local.get([storageKey], async (res) => {
          const cfg = (res && res[storageKey]) || {};
          const useWindowMode = Boolean(cfg.priceChartWindowMode);

          const fallbackPoints = meta.price > 0
            ? [{ price: meta.price, oldPrice: meta.oldPrice || null, accountId: detectCurrentAccountLabel(), ts: new Date().toISOString() }]
            : [];
          const fetched = await fetchHistory(90);
          const historyData = (fetched && fetched.points && fetched.points.length > 0)
            ? fetched
            : {
                slug,
                title: meta.title || slug,
                days: 90,
                points: fallbackPoints,
                dailyAvg: chartApi.aggregateDailyAverages(fallbackPoints),
                stats: {
                  minPrice: meta.price || null,
                  maxPrice: meta.price || null,
                  avgPrice: meta.price || null,
                  lastPrice: meta.price || null,
                  count: fallbackPoints.length
                },
                isWatched: Boolean(fetched && fetched.isWatched)
              };

          if (useWindowMode) {
            chartHost.innerHTML = `
              <div class="lqs-ph-window-banner">
                <span>📈 <b>История цены</b> включена в режиме отдельного окна (кнопка «цена» внизу слева)</span>
                <button type="button" class="lqs-ph-open-win-btn">Открыть график ↗</button>
              </div>
            `;
            const openBtn = chartHost.querySelector('.lqs-ph-open-win-btn');
            if (openBtn) {
              openBtn.addEventListener('click', () => openChartPopover(historyData, { mode: 'exact', days: 90 }));
            }
            mountAlitoolsDock(historyData);
          } else {
            removeAlitoolsDock();
            chartApi.mountPriceChartWidget(chartHost, historyData, {
              isPopover: false,
              initialMode: 'exact',
              initialDays: 90,
              onPeriodChange: (d) => fetchHistory(d),
              onToggleWatch: (w) => toggleWatch(w),
              onPopout: (curData, curState) => openChartPopover(curData, curState)
            });
          }
        });
      })();

      const barContainer = infoBlock.querySelector('div[data-testid="bar-container"]');
      if (barContainer && barContainer.parentNode) {
        barContainer.parentNode.insertBefore(panel, barContainer.nextSibling);
      } else {
        infoBlock.prepend(panel);
      }

      LQS_RECORDER.counters.panelMounts += 1;
      LQS_RECORDER.updateModule('widget', 'OK', `Смонтирован для ${slug}`);

      const noteArea = panel.querySelector('#lqs-note-area');
      noteArea.value = current.note;

      const persistState = async () => {
        const latestMeta = extractProductPageMetadata();
        current.note = noteArea.value;
        currentReviewCache = current;
        const fullCardTitle = buildFullProductSearchQuery(
          latestMeta.title || meta.title,
          latestMeta.brand || meta.brand,
          latestMeta.amountText || meta.amountText
        );
        const updated = await saveProductReview(slug, {
          title: fullCardTitle,
          cleanTitle: latestMeta.cleanTitle || meta.cleanTitle,
          brand: latestMeta.brand || meta.brand,
          productId: latestMeta.productId || meta.productId,
          imageKey: latestMeta.imageKey || meta.imageKey,
          price: latestMeta.price || meta.price,
          rating: current.rating,
          banned: current.banned,
          tags: current.tags,
          note: current.note
        });
        syncExistingPanelUI(panel, updated || current, latestMeta);
        guardAddToCartButton(updated || current);
        decorateCatalogCards();
      };

      panel.querySelectorAll('.lqs-star-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const val = parseInt(btn.dataset.star, 10);
          current.rating = current.rating === val ? 0 : val;
          if (current.rating > 0 && current.rating <= 2) {
            current.banned = true;
          } else if (current.rating >= 4) {
            current.banned = false;
          }
          persistState();
        });
      });

      panel.querySelector('#lqs-ban-toggle').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        current.banned = !current.banned;
        if (current.banned && current.rating === 0) current.rating = 1;
        persistState();
      });

      panel.querySelector('#lqs-reset-review').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        current.rating = 0;
        current.banned = false;
        current.tags = [];
        current.note = '';
        noteArea.value = '';
        persistState();
      });

      panel.querySelector('#lqs-drawer-toggle').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleDrawerState(panel, 'button-click');
      });

      panel.querySelector('#lqs-ai-btn').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const latestMeta = extractProductPageMetadata();
        requestAiProductReview(latestMeta, panel, false, false, 0, true);
      });

      panel.addEventListener('click', (e) => {
        const paidTrigger = e.target && e.target.closest ? e.target.closest('.lqs-paid-ai-btn') : null;
        if (!paidTrigger) return;
        e.preventDefault();
        e.stopPropagation();
        const latestMeta = extractProductPageMetadata();
        requestAiProductReview(latestMeta, panel, false, false, 0, true);
      });

      panel.querySelector('#lqs-ai-refresh').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const latestMeta = extractProductPageMetadata();
        requestAiProductReview(latestMeta, panel, true, false, 0, true);
      });

      panel.querySelectorAll('.lqs-tag-chip').forEach((chip) => {
        chip.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const tag = chip.dataset.tag;
          if (current.tags.includes(tag)) {
            current.tags = current.tags.filter((t) => t !== tag);
          } else {
            current.tags.push(tag);
          }
          persistState();
        });
      });

      let noteTimeout = null;
      noteArea.addEventListener('input', () => {
        current.note = noteArea.value;
        clearTimeout(noteTimeout);
        noteTimeout = setTimeout(persistState, 400);
      });

      panel.querySelector('#lqs-save-btn').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(noteTimeout);
        persistState();
        const saveBtn = e.currentTarget;
        saveBtn.textContent = '✅ Ок';
        setTimeout(() => { saveBtn.textContent = '💾 Ок'; }, 1200);
      });

      triggerPriceIntelForProduct(slug, meta, panel);
      scheduleZeroClickAiForProduct(slug, panel);
    } catch (err) {
      LQS_RECORDER.updateModule('widget', 'ERROR', `Ошибка рендера: ${err.message || err}`);
      LQS_RECORDER.error('renderProductPageWidget', err);
    } finally {
      isRenderingProduct = false;
      if (pendingProductRender) {
        pendingProductRender = false;
        setTimeout(renderProductPageWidget, 50);
      }
    }
  }

  // ==========================================================================
  // ЗАЩИТА КНОПКИ «В КОРЗИНУ» ОТ СЛУЧАЙНОЙ ПОКУПКИ ЗАБАНЕННОГО ТОВАРА
  // ==========================================================================
  function guardAddToCartButton(review) {
    const addBtn = document.querySelector('main[data-testid="good-page-desktop"] button[data-testid="snippet-control"]');
    if (!addBtn) return;

    const isBad = Boolean(review && (review.banned || (review.rating > 0 && review.rating <= 2)));
    const nextBadStr = isBad ? 'true' : 'false';
    const nextNoteStr = (review && review.note) ? review.note : '';
    const nextRatingStr = (review && review.rating) ? String(review.rating) : '1';

    if (
      addBtn.dataset.lqsBad === nextBadStr &&
      addBtn.dataset.lqsNote === nextNoteStr &&
      addBtn.dataset.lqsRating === nextRatingStr
    ) {
      return;
    }

    addBtn.dataset.lqsBad = nextBadStr;
    addBtn.dataset.lqsNote = nextNoteStr;
    addBtn.dataset.lqsRating = nextRatingStr;

    if (isBad) {
      addBtn.style.background = '#fee2e2';
      addBtn.style.color = '#991b1b';
      if (!addBtn.dataset.lqsGuarded) {
        addBtn.dataset.lqsGuarded = 'true';
        addBtn.addEventListener('click', (e) => {
          if (window.__lqsAutoBuilding) return;
          if (addBtn.dataset.lqsBad === 'true') {
            const ok = window.confirm(
              `⚠️ Этот товар у тебя в чёрном списке (${addBtn.dataset.lqsRating}★).\nЗаметка: "${addBtn.dataset.lqsNote || 'Не брать'}"\n\nВсё равно добавить в корзину?`
            );
            if (!ok) {
              e.stopPropagation();
              e.preventDefault();
            }
          }
        }, true);
      }
    } else {
      addBtn.style.background = '';
      addBtn.style.color = '';
    }
  }

  // ==========================================================================
  // РАЗМЕТКА КАРТОЧЕК В КАТАЛОГЕ + АВТО-СБОР ЦЕН СО ВСЕХ КАРТОЧЕК В БАЗУ
  // ==========================================================================
  function extractCardIdentifiers(card) {
    const linkEl = card.querySelector('a[href*="/good/"]') || card.closest('a[href*="/good/"]');
    const slug = linkEl ? extractSlugFromUrl(linkEl.getAttribute('href')) : null;

    let productId = null;
    const idHolder = card.closest('[data-testid^="product-id-"], [data-testid^="cart_item_"]') ||
                     card.querySelector('[data-testid^="product-id-"], [data-testid^="cart_item_"]');
    if (idHolder) {
      const tid = idHolder.getAttribute('data-testid') || '';
      productId = tid.replace(/^(product-id-|cart_item_)/, '').trim() || null;
    }

    const imgEl = card.querySelector('img[data-testid="product-snippet-thumb-image"], img[data-testid="snippet-image"], img');
    const imageKey = imgEl ? extractImageKey(imgEl.getAttribute('src')) : null;
    const imgAlt = imgEl ? imgEl.getAttribute('alt') : '';
    const cleanTitle = normalizeTitle(imgAlt);

    return { slug, productId, imageKey, cleanTitle, rawTitle: imgAlt || '' };
  }

  function extractPriceFromCardDOM(card) {
    const priceEl = card.querySelector('[data-testid="price-text"]');
    let price = null;
    if (priceEl) {
      price = parseFloat(priceEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.')) || null;
    } else {
      const m = (card.innerText || '').match(/(\d[\d\s]*)\s*₽/);
      if (m) price = parseFloat(m[1].replace(/\s/g, '')) || null;
    }
    const oldEl = card.querySelector('[data-testid="price-old-text"]');
    const oldPrice = oldEl ? (parseFloat(oldEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.')) || null) : null;
    const amtEl = card.querySelector('[data-testid="product-amount"]');
    const amount = amtEl ? amtEl.textContent.trim() : '';
    return { price, oldPrice, amount };
  }

  async function decorateCatalogCards() {
    LQS_RECORDER.counters.catalogPasses += 1;
    const db = await getReviewsDB();
    const cards = document.querySelectorAll('div[data-testid="product-card"]');

    let badgedCount = 0;
    let bannedCount = 0;
    const harvestedPrices = [];

    cards.forEach((card) => {
      const ids = extractCardIdentifiers(card);
      const pInfo = extractPriceFromCardDOM(card);

      if (ids.slug && pInfo.price && pInfo.price > 0) {
        if (card.dataset.lqsHarvestedPrice !== String(pInfo.price)) {
          card.dataset.lqsHarvestedPrice = String(pInfo.price);
          harvestedPrices.push({
            slug: ids.slug,
            title: buildFullProductSearchQuery(ids.rawTitle || ids.slug, '', pInfo.amount),
            isCanonicalCardTitle: false,
            imageKey: ids.imageKey || null,
            price: pInfo.price,
            oldPrice: pInfo.oldPrice,
            amount: pInfo.amount
          });
        }
      }

      const match = findReviewInDB(db, ids);
      const review = match ? match.item : null;
      const aiCached = findAiCacheInMemory(ids.slug, ids.rawTitle, ids.imageKey);
      const priceEntry = findPriceIntelInMemory(ids.slug, ids.rawTitle, ids.imageKey);

      let priceDiffTag = '';
      if (priceEntry && pInfo.price) {
        if (priceEntry.minPrice && pInfo.price > priceEntry.minPrice + 4) {
          priceDiffTag = ` 📈+${Math.round(pInfo.price - priceEntry.minPrice)}₽`;
        } else if (priceEntry.maxPrice && pInfo.price < priceEntry.maxPrice - 4) {
          priceDiffTag = ` 📉-${Math.round(priceEntry.maxPrice - pInfo.price)}₽`;
        }
      }

      const hasReview = Boolean(review && (review.rating > 0 || review.banned));
      const hasAiVerdict = Boolean(!hasReview && aiCached && aiCached.verdict);
      const hasPriceSignal = Boolean(!hasReview && !hasAiVerdict && priceDiffTag);

      if (!hasReview && !hasAiVerdict && !hasPriceSignal) {
        if (card.dataset.lqsBadgeKey) {
          delete card.dataset.lqsBadgeKey;
          const oldBadge = card.querySelector('.lqs-card-badge');
          if (oldBadge) oldBadge.remove();
          card.classList.remove('lqs-card-dimmed');
          LQS_RECORDER.counters.catalogBadgesUpdated += 1;
        } else {
          LQS_RECORDER.counters.catalogBadgesSkipped += 1;
        }
        return;
      }

      badgedCount += 1;
      let tier = 'ok';
      let text = '';
      let titleText = '';
      let isBad = false;

      if (hasReview) {
        isBad = Boolean(review.banned || (review.rating > 0 && review.rating <= 2));
        if (isBad) bannedCount += 1;
        tier = isBad ? 'trash' : (review.rating >= 4 ? 'god' : 'ok');
        text = (isBad ? `💀 ${review.rating ? review.rating + '★' : 'БАН'}` : `★ ${review.rating}`) + priceDiffTag;
        titleText = (review.note && review.note.trim())
          ? review.note.trim()
          : ((review.tags && review.tags.length) ? review.tags.join(', ') : '');
      } else if (hasAiVerdict) {
        const vBadge = extractVerdictBadgeFromText(aiCached.verdict);
        text = (vBadge ? vBadge.shortCatalog : '🤖') + priceDiffTag;
        tier = vBadge && vBadge.cls === 'verdict-good' ? 'god' : (vBadge && vBadge.cls === 'verdict-bad' ? 'trash' : 'ok');
        titleText = aiCached.verdict.replace(/\*\*/g, '').slice(0, 220);
      } else if (hasPriceSignal) {
        text = priceDiffTag.trim();
        tier = priceDiffTag.includes('📉') ? 'god' : 'ok';
        titleText = `По базе цен: мин ${priceEntry.minPrice} ₽ / макс ${priceEntry.maxPrice} ₽`;
      }

      const badgeKey = `${tier}|${text}|${titleText}`;

      let badge = card.querySelector('.lqs-card-badge');
      if (card.dataset.lqsBadgeKey === badgeKey && badge) {
        LQS_RECORDER.counters.catalogBadgesSkipped += 1;
        return;
      }

      card.dataset.lqsBadgeKey = badgeKey;
      if (card.style.position !== 'relative') {
        card.style.position = 'relative';
      }
      if (card.classList.contains('lqs-card-dimmed') !== isBad) {
        card.classList.toggle('lqs-card-dimmed', isBad);
      }

      if (!badge) {
        badge = document.createElement('div');
        card.appendChild(badge);
      }
      badge.className = `lqs-card-badge ${tier}`;
      badge.textContent = text;
      badge.title = titleText;
      LQS_RECORDER.counters.catalogBadgesUpdated += 1;
    });

    const now = Date.now();
    if (harvestedPrices.length > 0 && now - lastCatalogHarvestTs > 1800) {
      lastCatalogHarvestTs = now;
      LQS_RECORDER.counters.pricesHarvested += harvestedPrices.length;
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          type: 'LQS_RECORD_PRICES',
          accountId: detectCurrentAccountLabel(),
          items: harvestedPrices
        });
      }
    }

    LQS_RECORDER.updateModule(
      'catalog',
      'OK',
      `Карточек: ${cards.length} (с бейджем: ${badgedCount}, в бане: ${bannedCount}, цен собрано: ${LQS_RECORDER.counters.pricesHarvested})`
    );
  }

  // ==========================================================================
  // НАБЛЮДАТЕЛЬ DOM И НАДЁЖНЫЙ ДЕТЕКТОР SPA-ПЕРЕХОДОВ
  // ==========================================================================
  let debounceTimer = null;
  function scheduleUpdate() {
    LQS_RECORDER.counters.scheduleCalls += 1;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      checkUrlTransition();
      renderProductPageWidget();
      decorateCatalogCards();
      scanAndSnapshotCurrentCartDOM();
    }, 120);
  }

  function checkUrlTransition() {
    const currentUrl = window.location.href;
    if (currentUrl !== lastObservedUrl) {
      lastObservedUrl = currentUrl;
      LQS_RECORDER.counters.spaTransitions += 1;
      runHydrationResyncWave('spa-url-change');
    }
  }

  setInterval(() => {
    if (document.hidden) return;
    checkUrlTransition();
  }, 350);

  function runHydrationResyncWave(reason = 'init') {
    const slug = extractSlugFromUrl(window.location.href);
    LQS_RECORDER.updateModule(
      'router',
      'OK',
      `Маршрут: ${window.location.pathname} (${slug ? 'Товар: ' + slug : 'Каталог'}), причина: ${reason}`
    );
    [0, 180, 500, 1200, 2500].forEach((delay) => {
      setTimeout(() => {
        renderProductPageWidget();
        decorateCatalogCards();
        scanAndSnapshotCurrentCartDOM();
      }, delay);
    });
  }

  function isOwnLqsNode(node) {
    if (!node) return false;
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (
        node.classList &&
        (node.classList.contains('lqs-product-panel') ||
         node.classList.contains('lqs-card-badge') ||
         node.classList.contains('lqs-cart-audit-banner') ||
         node.classList.contains('lqs-passport-helper'))
      ) {
        return true;
      }
      if (node.closest && node.closest('.lqs-product-panel, .lqs-card-badge, .lqs-cart-audit-banner, .lqs-passport-helper')) {
        return true;
      }
    } else if (node.parentElement && node.parentElement.closest('.lqs-product-panel, .lqs-card-badge, .lqs-cart-audit-banner, .lqs-passport-helper')) {
      return true;
    }
    return false;
  }

  function hasExternalMutation(mutations) {
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      if (isOwnLqsNode(m.target)) continue;
      let hasNonLqsChild = false;
      for (let j = 0; j < m.addedNodes.length; j++) {
        if (!isOwnLqsNode(m.addedNodes[j])) {
          hasNonLqsChild = true;
          break;
        }
      }
      if (!hasNonLqsChild) {
        for (let j = 0; j < m.removedNodes.length; j++) {
          if (!isOwnLqsNode(m.removedNodes[j])) {
            hasNonLqsChild = true;
            break;
          }
        }
      }
      if (hasNonLqsChild) return true;
    }
    return false;
  }

  const observer = new MutationObserver((mutations) => {
    if (hasExternalMutation(mutations)) {
      LQS_RECORDER.counters.extMutations += 1;
      scheduleUpdate();
    } else {
      LQS_RECORDER.counters.selfMutationsIgnored += 1;
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        if (changes[STORAGE_KEY]) {
          reviewsDbCache = changes[STORAGE_KEY].newValue || {};
          renderProductPageWidget();
          decorateCatalogCards();
        }
        if (changes[AI_CACHE_KEY]) {
          aiCacheMemory = changes[AI_CACHE_KEY].newValue || {};
          const slug = extractSlugFromUrl(window.location.href);
          const panel = document.querySelector('.lqs-product-panel');
          if (slug && panel) {
            const meta = extractProductPageMetadata();
            const foundAi = findAiCacheInMemory(slug, meta.title, meta.imageKey);
            if (foundAi && foundAi.verdict && !foundAi.loading) {
              renderAiVerdictIntoPanel(panel, slug, meta, foundAi, cachedSettings.autoOpenDrawerOnAi !== false);
            }
          }
          decorateCatalogCards();
        }
        if (changes[PRICE_DB_KEY]) {
          priceDbMemory = changes[PRICE_DB_KEY].newValue || {};
          // Сбрасываем кэш сводок в памяти вкладки, чтобы открытая карточка Лавки сразу получила свежие цены из других магазинов
          priceSummaryBySlug.clear();
          renderProductPageWidget();
          decorateCatalogCards();
          if (window.location.pathname.includes('/cart')) {
            const snap = extractCartItemsFromDOM();
            if (snap.items.length > 0) renderCartAuditBanner(snap);
          }
        }
        if (changes[EXT_STORE_DB_KEY] || changes[REJECTED_MATCHES_KEY]) {
          const slug = extractSlugFromUrl(window.location.href);
          if (slug) {
            priceSummaryBySlug.delete(slug);
            priceIntelRequestedSlugs.delete(slug);
            renderProductPageWidget();
          }
        }
        if (changes[SETTINGS_KEY]) {
          cachedSettings = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) };
          renderProductPageWidget();
          scanAndSnapshotCurrentCartDOM();
        }
      }
    });
  }

  window.addEventListener('popstate', () => runHydrationResyncWave('popstate'));
  window.addEventListener('load', () => runHydrationResyncWave('window-load'));
  runHydrationResyncWave('script-boot');
})();
