/**
 * Lavka Quality Shield v2.7.0 — Background Service Worker
 * Что нового и исправлено в v2.7.0:
 * 1. МАТРИЦА ЦЕН 16 КРУПНЕЙШИХ МАГАЗИНОВ + НАТИВНЫЙ ПАРСЕР МАГНИТА (`magnit.ru` по Site Recon):
 *    - Подключены 16 торговых сетей: Магнит, Пятёрочка, Перекрёсток, ВкусВилл, Магнолия, Дикси, Чижик,
 *      Ашан, МЕТРО, Глобус, Лента, О’КЕЙ, Азбука Вкуса, Самокат, Ozon Fresh, Купер / Яндекс Маркет.
 *    - Внедрена база внешних цен сетей (`lqs_ext_store_prices_v1`) + нативный сборщик цен с `magnit.ru`
 *      (`article.unit-catalog-product-preview`, `a.pl-hover-base`, `/ecom/cart`, `#__NUXT_DATA__`, `/webgate/v2/goods/...`)
 *      и живой парсер карточек ВкусВилл (`vkusvill.ru/search/?q=...`) + DuckDuckGo Multi-Store Search.
 * 2. НАДЁЖНОЕ ЧТЕНИЕ ОТВЕТА ИЗ ФОНОВОЙ ВКЛАДКИ GEMINI (`executePromptInsideGeminiTab` v2.6.0):
 *    - Устранён баг, когда ИИ-обзор уже виден во вкладке Gemini, но не появляется на странице товара Лавки.
 *    - Поллинг вынесен из засыпающей фоновой вкладки в Service Worker (короткими импульсами по 800 мс),
 *      а чтение текста переведено с зависящего от вьюпорта `.innerText` на layout-независимый DOM-обходчик
 *      (`extractCleanResponseText`), который читает ответ даже из неактивной/свёрнутой вкладки!
 *    - Добавлен мгновенный перехват уже готового ответа со страницы Gemini (за 0.1 сек без повторного ввода промпта!).
 * 3. ИСПРАВЛЕНО СВОРАЧИВАНИЕ РАЗВЁРНУТОГО ОПИСАНИЯ (СПОЙЛЕРА) НА СТРАНИЦЕ ТОВАРА:
 *    - Ручное закрытие спойлера (`▴ Скрыть`) теперь запоминается в `userManualDrawerStateBySlug` и никогда
 *      самопроизвольно не раскрывается обратно при фоновых синхронизациях DOM.
 */

'use strict';

importScripts('shared/config.js', 'shared/price-parser.js', 'shared/utils.js', 'shared/product-matcher.js');
importScripts('bg/accounts-vault.js');
importScripts('bg/gemini-tab.js');
importScripts('bg/price-radar.js');
importScripts('bg/ai-providers.js');
importScripts('bg/cart-sync.js');

const {
  fetchWithTimeout,
  getSettings,
  saveSettingsPatch,
  buildFullProductSearchQuery,
  buildDirectStoreSearchLinks
} = globalThis.LQS_UTILS;

const {
  SUGAR_FREE_REGEX,
  FLAVOR_AND_TYPE_MODIFIERS,
  GENERIC_STOP_WORDS,
  normalizeTitleKey,
  parseVolumeOrWeightGrams,
  normalizeSynonymTokens,
  isSearchResultMatchingProduct,
  decodeHtmlEntities
} = globalThis.LQS_MATCHER;


const {
  fetchBackendAccountSecrets,
  getAccountsVaultMap,
  getAccountsVaultStatus,
  saveAccountToVault,
  deleteAccountFromVault,
  autofillYandexPassportTab,
  switchLavkaAccountInOneClick,
  logoutToCleanLavkaSession
} = globalThis.LQS_ACCOUNTS_VAULT;

const {
  GEMINI_IDLE_ALARM_NAME,
  normalizeGeminiTabMode,
  scheduleGeminiIdleCloseTimer,
  cancelGeminiIdleCloseTimer,
  closeManagedGeminiSession,
  isGeminiLoginRequired,
  inspectGeminiCookies,
  detectTabAccountEmail,
  extractAccountIndexFromUrl,
  buildGeminiUrlForAccount,
  listOpenGeminiTabsWithAccounts,
  findOpenGeminiTab,
  createGeminiTab,
  ensureAutopilotWarmup,
  executePromptInsideGeminiTab,
  enqueueGeminiTabExecution
} = globalThis.LQS_GEMINI_TAB;

const {
  isCaptchaOrBlockHtml,
  isCircuitOpen,
  recordCircuitSuccess,
  recordCircuitFailure,
  resetCircuitBreakers,
  getRadar16StoresStatus,
  getLocalPriceDb,
  findPriceEntryInDb,
  recordPricesBatch,
  parseFullProductCardFromLavkaHtml,
  getProductPriceIntelligence,
  getExternalStoreOffersList,
  recordExternalStoreOffers,
  findMatchingExternalStoreOffersFromList,
  mergeUniqueStoreOffers,
  auditCartCompetitorsAndAccounts,
  rejectCompetitorMatch,
  findLocalComparisonsForStoreProduct,
  scanStoresInBackgroundTabs
} = globalThis.LQS_PRICE_RADAR;

const {
  AI_DIRECT_TIMEOUT_MS,
  normalizeUsageLedger,
  checkPaidAiDailyLimit,
  recordPaidAiUsage,
  resolveProviderConfig,
  maskApiKey,
  isMaskedApiKey,
  formatCostUsd,
  fetchProviderModelsList,
  testProviderConnection,
  callAiProvider
} = globalThis.LQS_AI_PROVIDERS;

const {
  getSavedCartsState,
  saveCartSnapshot,
  compareSavedCartOnCurrentAccount,
  waitForTabCompleteSafe,
  addSingleItemOnTab,
  autoBuildCartInBrowser
} = globalThis.LQS_CART_SYNC;

const { STORAGE_KEYS, LIMITS, CLIENT_HEADER: LQS_CLIENT_HEADER, TOKEN_HEADER_NAME = 'X-LQS-Token' } = globalThis.LQS_CONFIG;
const AI_CACHE_KEY = STORAGE_KEYS.AI_CACHE;
const AI_USAGE_KEY = STORAGE_KEYS.AI_USAGE || 'lqs_ai_usage_v1';
const SAVED_CARTS_KEY = STORAGE_KEYS.SAVED_CARTS;
const BACKEND_TOKEN_KEY = STORAGE_KEYS.BACKEND_TOKEN || 'lqs_backend_token_v1';

const MAX_LOCAL_AI_CACHE_ITEMS = LIMITS.MAX_LOCAL_AI_CACHE_ITEMS;

const REVIEW_SEARCH_SITES = [
  { domain: 'otzovik.com', name: 'Отзовик' },
  { domain: 'irecommend.ru', name: 'IRecommend' },
  { domain: 'rskrf.ru', name: 'Роскачество' },
  { domain: 'roscontrol.com', name: 'Росконтроль' },
  { domain: 'magnit.ru', name: 'Магнит' },
  { domain: '5ka.ru', name: 'Пятёрочка' },
  { domain: 'perekrestok.ru', name: 'Перекрёсток' },
  { domain: 'vprok.ru', name: 'Перекрёсток Впрок' },
  { domain: 'vkusvill.ru', name: 'ВкусВилл' },
  { domain: 'auchan.ru', name: 'Ашан' },
  { domain: 'metro-cc.ru', name: 'МЕТРО' },
  { domain: 'globus.ru', name: 'Глобус' },
  { domain: 'lenta.com', name: 'Лента' },
  { domain: 'mgnl.ru', name: 'Магнолия' },
  { domain: 'dixy.ru', name: 'Дикси' },
  { domain: 'chizhik.club', name: 'Чижик' },
  { domain: 'okeydostavka.ru', name: 'О’КЕЙ' },
  { domain: 'av.ru', name: 'Азбука Вкуса' },
  { domain: 'samokat.ru', name: 'Самокат' },
  { domain: 'ozon.ru', name: 'Ozon' },
  { domain: 'market.yandex.ru', name: 'Яндекс Маркет' },
  { domain: 'wildberries.ru', name: 'Wildberries' },
  { domain: 'kuper.ru', name: 'Купер' },
  { domain: 'sbermarket.ru', name: 'СберМаркет' },
  { domain: 'eda.yandex.ru', name: 'Яндекс Лавка / Еда' }
];

const inFlightRequests = new Map();
let latestRequestedProductKey = '';

let backendOfflineUntilTs = 0;
let bridgeOfflineUntilTs = 0;

let swKeepAliveActiveTasks = 0;
let swKeepAliveTimer = null;

function startSwKeepAlive() {
  swKeepAliveActiveTasks += 1;
  if (!swKeepAliveTimer) {
    swKeepAliveTimer = setInterval(() => {
      if (swKeepAliveActiveTasks <= 0 && inFlightRequests.size === 0) {
        clearInterval(swKeepAliveTimer);
        swKeepAliveTimer = null;
        return;
      }
      try {
        chrome.runtime.getPlatformInfo(() => {
          if (chrome.runtime.lastError) {
            // ignore
          }
        });
      } catch {
        // ignore
      }
    }, 20000);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    swKeepAliveActiveTasks = Math.max(0, swKeepAliveActiveTasks - 1);
    if (swKeepAliveActiveTasks === 0 && inFlightRequests.size === 0 && swKeepAliveTimer) {
      clearInterval(swKeepAliveTimer);
      swKeepAliveTimer = null;
    }
  };
}

async function getStoredBackendToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get([BACKEND_TOKEN_KEY], (res) => {
      resolve(typeof res?.[BACKEND_TOKEN_KEY] === 'string' ? res[BACKEND_TOKEN_KEY].trim() : '');
    });
  });
}

async function saveStoredBackendToken(token) {
  const clean = String(token || '').trim();
  return new Promise((resolve) => {
    chrome.storage.local.set({ [BACKEND_TOKEN_KEY]: clean }, () => resolve(clean));
  });
}

let pairingInFlightPromise = null;

async function ensureBackendPairedToken(backendUrl) {
  const existing = await getStoredBackendToken();
  if (existing) return existing;
  const cleanUrl = (backendUrl || '').replace(/\/$/, '');
  if (!cleanUrl || Date.now() < backendOfflineUntilTs) return '';
  if (pairingInFlightPromise) return pairingInFlightPromise;

  pairingInFlightPromise = (async () => {
    try {
      const r = await fetchWithTimeout(
        `${cleanUrl}/api/auth/pair`,
        { method: 'POST', headers: { ...LQS_CLIENT_HEADER } },
        1500
      );
      if (r.ok) {
        const data = await r.json();
        if (data && data.token) {
          return await saveStoredBackendToken(data.token);
        }
      }
    } catch {
      backendOfflineUntilTs = Date.now() + 10000;
    } finally {
      pairingInFlightPromise = null;
    }
    return '';
  })();
  return pairingInFlightPromise;
}

async function getBackendAuthHeaders(backendUrl, extraHeaders = {}) {
  const token = await ensureBackendPairedToken(backendUrl);
  const headers = { ...LQS_CLIENT_HEADER, ...extraHeaders };
  if (token) {
    headers[TOKEN_HEADER_NAME] = token;
  }
  return headers;
}

const NATIVE_HOST_NAME = 'com.lavka.quality_shield';
let localServerStartPromise = null;
let lastAutoServerStartAttemptTs = 0;

async function startLocalServerViaNativeHost({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastAutoServerStartAttemptTs < 15000) {
    return { ok: false, throttled: true, error: 'Повторная автопопытка запуска временно отложена' };
  }
  if (localServerStartPromise) {
    return localServerStartPromise;
  }

  localServerStartPromise = (async () => {
    lastAutoServerStartAttemptTs = Date.now();
    const settings = await getSettings();
    const backendUrl = (settings.backendUrl || 'http://127.0.0.1:8765').replace(/\/$/, '');

    // Сначала проверяем, не запущен ли сервер уже
    try {
      const health = await fetchWithTimeout(`${backendUrl}/api/health`, { method: 'GET' }, 1200);
      if (health && health.ok) {
        backendOfflineUntilTs = 0;
        const migratedKey = await migrateLocalFallbackKeyIfPresent(settings);
        return { ok: true, running: true, alreadyRunning: true, started: false, migratedKey };
      }
    } catch {
      // Сервер выключен — пробуем запустить через Native Messaging Host
    }

    if (!chrome.runtime || typeof chrome.runtime.sendNativeMessage !== 'function') {
      return {
        ok: false,
        running: false,
        hostMissing: true,
        extensionId: chrome.runtime?.id || '',
        error: 'Native Messaging недоступен в текущей среде браузера'
      };
    }

    const nativeResp = await new Promise((resolve) => {
      try {
        chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action: 'start_server' }, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) {
            const msg = String(err.message || err);
            const hostMissing = /not found|forbidden|access/i.test(msg);
            resolve({
              ok: false,
              running: false,
              hostMissing,
              extensionId: chrome.runtime?.id || '',
              error: msg
            });
            return;
          }
          resolve(resp || { ok: false, running: false, error: 'Пустой ответ от Native Messaging Host' });
        });
      } catch (e) {
        resolve({
          ok: false,
          running: false,
          hostMissing: true,
          extensionId: chrome.runtime?.id || '',
          error: e.message || String(e)
        });
      }
    });

    if (nativeResp && nativeResp.ok && nativeResp.running) {
      backendOfflineUntilTs = 0;
      const migratedKey = await migrateLocalFallbackKeyIfPresent(settings);
      return { ...nativeResp, migratedKey };
    }
    return nativeResp;
  })().finally(() => {
    localServerStartPromise = null;
  });

  return localServerStartPromise;
}

async function migrateLocalFallbackKeyIfPresent(settingsInput = null) {
  try {
    const settings = settingsInput || await getSettings();
    const rawLocalKey = String(settings.aiApiKey || '').trim();
    if (!rawLocalKey || isMaskedApiKey(rawLocalKey) || settings.aiKeyStoredOnServer) {
      return false;
    }
    const prov = settings.aiProvider || 'moduleapi';
    if (prov === 'gemini_tab') return false;
    const res = await saveAiKeySecurely(prov, rawLocalKey, { allowAutoStart: false });
    return Boolean(res && res.ok && res.storedOnServer);
  } catch {
    return false;
  }
}

async function saveAiKeySecurely(providerId, rawApiKey, { allowAutoStart = true } = {}) {
  const settings = await getSettings();
  const resolved = resolveProviderConfig({ ...settings, aiProvider: providerId || settings.aiProvider });
  const provider = resolved.providerId;
  const cleanKey = String(rawApiKey || '').trim();

  if (!cleanKey) {
    return {
      ok: true,
      unchanged: true,
      provider,
      storedOnServer: Boolean(settings.aiKeyStoredOnServer),
      mask: settings.aiKeyMask || (settings.aiApiKey ? maskApiKey(settings.aiApiKey) : '')
    };
  }
  if (isMaskedApiKey(cleanKey)) {
    return {
      ok: true,
      unchanged: true,
      provider,
      storedOnServer: Boolean(settings.aiKeyStoredOnServer),
      mask: settings.aiKeyMask || cleanKey
    };
  }

  const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
  let fallbackReason = '';

  if (backendUrl) {
    try {
      const resp = await fetchWithTimeout(
        `${backendUrl}/api/ai-keys/save`,
        {
          method: 'POST',
          headers: await getBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ provider, apiKey: cleanKey })
        },
        2500
      );
      if (resp.ok) {
        backendOfflineUntilTs = 0;
        const data = await resp.json();
        const mask = data.mask || maskApiKey(cleanKey);
        await saveSettingsPatch({
          aiProvider: provider,
          aiApiKey: '',
          aiKeyMask: mask,
          aiKeyStoredOnServer: true
        });
        return {
          ok: true,
          storedOnServer: true,
          provider,
          mask,
          updatedAt: data.updatedAt || null
        };
      }
      const errData = await resp.json().catch(() => ({}));
      fallbackReason = errData.detail || `HTTP ${resp.status}`;
    } catch {
      if (allowAutoStart) {
        const wake = await startLocalServerViaNativeHost({ force: false });
        if (wake && wake.ok && wake.running) {
          try {
            const retryResp = await fetchWithTimeout(
              `${backendUrl}/api/ai-keys/save`,
              {
                method: 'POST',
                headers: await getBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' }),
                body: JSON.stringify({ provider, apiKey: cleanKey })
              },
              2500
            );
            if (retryResp.ok) {
              backendOfflineUntilTs = 0;
              const data = await retryResp.json();
              const mask = data.mask || maskApiKey(cleanKey);
              await saveSettingsPatch({
                aiProvider: provider,
                aiApiKey: '',
                aiKeyMask: mask,
                aiKeyStoredOnServer: true
              });
              return {
                ok: true,
                storedOnServer: true,
                provider,
                mask,
                autoStartedServer: true,
                updatedAt: data.updatedAt || null
              };
            }
          } catch {
            // fall through to browser fallback
          }
        }
      }
      backendOfflineUntilTs = Date.now() + 10000;
      fallbackReason = 'Локальный сервер :8765 не запущен';
    }
  } else {
    fallbackReason = 'Адрес локального сервера не задан';
  }

  // Резервное хранение в chrome.storage.local (если локальный сервер выключен)
  const mask = maskApiKey(cleanKey);
  await saveSettingsPatch({
    aiProvider: provider,
    aiApiKey: cleanKey,
    aiKeyMask: mask,
    aiKeyStoredOnServer: false
  });
  return {
    ok: true,
    storedOnServer: false,
    provider,
    mask,
    fallbackReason
  };
}

async function getAiKeyVaultStatus(providerId = '') {
  const settings = await getSettings();
  const resolved = resolveProviderConfig({ ...settings, aiProvider: providerId || settings.aiProvider });
  const provider = resolved.providerId;
  const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');

  let serverOnline = false;
  let serverEntry = null;
  let keysMap = {};

  if (backendUrl) {
    try {
      const resp = await fetchWithTimeout(
        `${backendUrl}/api/ai-keys/status?provider=${encodeURIComponent(provider)}`,
        { method: 'GET', headers: await getBackendAuthHeaders(backendUrl) },
        1500
      );
      if (resp.ok) {
        serverOnline = true;
        backendOfflineUntilTs = 0;
        const data = await resp.json();
        keysMap = data && typeof data.keys === 'object' && data.keys ? data.keys : {};
        if (data && data.hasKey) {
          serverEntry = {
            hasKey: true,
            mask: data.mask || '',
            updatedAt: data.updatedAt || null
          };
        }
      }
    } catch {
      // backend offline
    }
  }

  if (serverEntry) {
    return {
      ok: true,
      provider,
      serverOnline,
      storedOnServer: true,
      hasKey: true,
      mask: serverEntry.mask,
      updatedAt: serverEntry.updatedAt,
      keysMap
    };
  }

  const localKey = String(settings.aiApiKey || '').trim();
  const hasLocalKey = Boolean(localKey && !isMaskedApiKey(localKey));
  return {
    ok: true,
    provider,
    serverOnline,
    storedOnServer: false,
    hasKey: hasLocalKey,
    mask: hasLocalKey ? maskApiKey(localKey) : '',
    updatedAt: null,
    keysMap
  };
}

async function deleteAiKeySecurely(providerId = '') {
  const settings = await getSettings();
  const resolved = resolveProviderConfig({ ...settings, aiProvider: providerId || settings.aiProvider });
  const provider = resolved.providerId;
  const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');

  let serverDeleted = false;
  if (backendUrl) {
    try {
      const resp = await fetchWithTimeout(
        `${backendUrl}/api/ai-keys/${encodeURIComponent(provider)}`,
        { method: 'DELETE', headers: await getBackendAuthHeaders(backendUrl) },
        2000
      );
      if (resp.ok) {
        serverDeleted = true;
      }
    } catch {
      // backend offline
    }
  }

  await saveSettingsPatch({
    aiApiKey: '',
    aiKeyMask: '',
    aiKeyStoredOnServer: false
  });
  return { ok: true, provider, serverDeleted, deleted: true };
}

async function testAiProviderWithVault(options = {}) {
  const settings = await getSettings();
  const providerCfg = resolveProviderConfig({
    ...settings,
    aiProvider: options.aiProvider || settings.aiProvider,
    aiBaseUrl: options.aiBaseUrl || settings.aiBaseUrl
  });
  if (providerCfg.protocol === 'gemini_tab') {
    return await testProviderConnection({ aiProvider: 'gemini_tab' });
  }

  const rawInputKey = String(options.aiApiKey || '').trim();
  const hasDirectInputKey = Boolean(rawInputKey && !isMaskedApiKey(rawInputKey));
  const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');

  // Если пользователь не ввёл новый ключ, а ключ лежит зашифрованным на сервере — тестируем через локальный сервер
  if (!hasDirectInputKey && backendUrl) {
    try {
      const resp = await fetchWithTimeout(
        `${backendUrl}/api/ai-keys/test`,
        {
          method: 'POST',
          headers: await getBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            aiProvider: providerCfg.providerId,
            aiBaseUrl: providerCfg.baseUrl,
            aiApiKey: ''
          })
        },
        options.timeoutMs || 12000
      );
      if (resp.ok) {
        const data = await resp.json();
        if (data && (data.ok || data.usedServerKey)) {
          return {
            ok: Boolean(data.ok),
            providerId: data.providerId || providerCfg.providerId,
            label: providerCfg.label,
            baseUrl: data.baseUrl || providerCfg.baseUrl,
            models: Array.isArray(data.models) ? data.models : [],
            error: data.error || null,
            status: data.status || (data.ok ? 200 : 0),
            usedServerKey: Boolean(data.usedServerKey)
          };
        }
      }
    } catch {
      // fallback to direct browser check
    }
  }

  const effectiveKey = hasDirectInputKey
    ? rawInputKey
    : (settings.aiApiKey && !isMaskedApiKey(settings.aiApiKey) ? settings.aiApiKey : '');

  if (!effectiveKey && providerCfg.requiresKey && settings.aiKeyStoredOnServer) {
    return {
      ok: false,
      providerId: providerCfg.providerId,
      label: providerCfg.label,
      baseUrl: providerCfg.baseUrl,
      models: [],
      error: 'Ключ зашифрован на локальном сервере (:8765), но сервер сейчас выключен. Запустите start_server.bat или введите ключ заново.',
      status: 0
    };
  }

  return await testProviderConnection({
    aiProvider: providerCfg.providerId,
    aiBaseUrl: providerCfg.baseUrl,
    aiApiKey: effectiveKey,
    timeoutMs: options.timeoutMs
  });
}

async function fetchAiModelsList(aiBaseUrl, aiApiKey = '', aiProvider = '') {
  const cleanUrl = String(aiBaseUrl || '').trim().replace(/\/$/, '');
  if (!cleanUrl && !aiProvider) return [];
  const provider = aiProvider || (cleanUrl ? 'custom_openai' : 'gemini_tab');
  const res = await testAiProviderWithVault({ aiProvider: provider, aiBaseUrl: cleanUrl, aiApiKey });
  if (!res.ok) {
    throw new Error(res.error || 'Не удалось загрузить список моделей.');
  }
  return Array.isArray(res.models) ? res.models : [];
}

function normalizeCacheKey(slug, title) {
  return String(slug || title || '')
    .trim()
    .toLowerCase();
}


function extractImageKeyFromUrl(src) {
  if (!src) return null;
  const m = String(src).match(/get-grocery-goods\/(\d+\/[a-f0-9-]+)/i);
  return m ? m[1].toLowerCase() : null;
}


// ============================================================================
// 1. ВСТРОЕННЫЙ КЭШ ИИ-ОБЗОРОВ (lqs_ai_cache_v1)
// ============================================================================
async function getAiUsageLedger() {
  return new Promise((resolve) => {
    chrome.storage.local.get([AI_USAGE_KEY], (res) => {
      resolve(normalizeUsageLedger(res?.[AI_USAGE_KEY] || {}));
    });
  });
}

async function saveAiUsageLedger(ledger) {
  const normalized = normalizeUsageLedger(ledger);
  return new Promise((resolve) => {
    chrome.storage.local.set({ [AI_USAGE_KEY]: normalized }, () => resolve(normalized));
  });
}

async function getAiUsageStatsWithLimit() {
  const [settings, ledger] = await Promise.all([getSettings(), getAiUsageLedger()]);
  const dailyLimit = Number.isFinite(Number(settings.paidAiDailyLimit))
    ? Math.max(0, Math.floor(Number(settings.paidAiDailyLimit)))
    : (LIMITS.DEFAULT_PAID_AI_DAILY_LIMIT || 25);
  return { ok: true, ...ledger, dailyLimit };
}

async function getLocalAiCacheMap() {
  return new Promise((resolve) => {
    chrome.storage.local.get([AI_CACHE_KEY], (res) => {
      resolve(res && res[AI_CACHE_KEY] && typeof res[AI_CACHE_KEY] === 'object' ? res[AI_CACHE_KEY] : {});
    });
  });
}

async function getLocalAiCacheEntry(slug, title, imageKey = null) {
  const key = normalizeCacheKey(slug, title);
  const normTitle = normalizeTitleKey(title);
  const map = await getLocalAiCacheMap();

  let entry = key ? map[key] : null;
  if (!entry && imageKey) {
    entry = Object.values(map).find(
      (e) => e && e.verdict && !String(e.verdict).startsWith('⚠️') && e.imageKey === imageKey
    );
  }
  if (!entry && normTitle && normTitle.length >= 4) {
    entry = Object.values(map).find(
      (e) => e && e.verdict && !String(e.verdict).startsWith('⚠️') && normalizeTitleKey(e.title) === normTitle
    );
  }

  if (entry && entry.verdict && !String(entry.verdict).startsWith('⚠️')) {
    const refTitle = entry.title || title || '';
    const filteredSources = Array.isArray(entry.sources) && refTitle
      ? entry.sources.filter((s) => isSearchResultMatchingProduct(s.title, s.snippet, refTitle, '').isSameProduct)
      : (entry.sources || []);
    return {
      ...entry,
      sources: filteredSources
    };
  }
  return null;
}

async function saveLocalAiCacheEntry(slug, title, verdict, sources, mode, imageKey = null) {
  const key = normalizeCacheKey(slug, title);
  if (!key || !verdict || String(verdict).startsWith('⚠️')) return null;
  const normTitle = normalizeTitleKey(title);
  const map = await getLocalAiCacheMap();
  const nowIso = new Date().toISOString();

  const record = {
    slug: key,
    title: title || key,
    cleanTitle: normTitle,
    imageKey: imageKey || null,
    verdict: String(verdict).trim(),
    sources: Array.isArray(sources) ? sources : [],
    mode: mode || 'Автопилот ИИ',
    updatedAt: nowIso
  };

  map[key] = record;

  if (normTitle && normTitle.length >= 4) {
    for (const [k, v] of Object.entries(map)) {
      if (k !== key && v && (normalizeTitleKey(v.title) === normTitle || (imageKey && v.imageKey === imageKey))) {
        map[k] = { ...record, slug: k };
      }
    }
  }

  const keys = Object.keys(map);
  if (keys.length > MAX_LOCAL_AI_CACHE_ITEMS) {
    keys
      .sort((a, b) => String(map[a]?.updatedAt || '').localeCompare(String(map[b]?.updatedAt || '')))
      .slice(0, keys.length - MAX_LOCAL_AI_CACHE_ITEMS)
      .forEach((oldKey) => delete map[oldKey]);
  }

  return new Promise((resolve) => {
    chrome.storage.local.set({ [AI_CACHE_KEY]: map }, () => resolve(record));
  });
}

async function clearLocalAiCache() {
  return new Promise((resolve) => {
    chrome.storage.local.remove([AI_CACHE_KEY], () => resolve(true));
  });
}

async function broadcastAiVerdictToLavkaTabs(slug, title, resultObj) {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://lavka.yandex.ru/*'] });
    for (const t of tabs || []) {
      if (!t.id) continue;
      chrome.tabs.sendMessage(
        t.id,
        {
          type: 'LQS_AI_VERDICT_READY',
          slug: normalizeCacheKey(slug, title),
          cleanTitle: normalizeTitleKey(title),
          result: resultObj
        },
        () => {
          if (chrome.runtime.lastError) {
            // ignore
          }
        }
      );
    }
  } catch {
    // ignore
  }
}

// ============================================================================
// 2. МЕНЕДЖЕР АККАУНТОВ ЛАВКИ (вынесен в extension/bg/accounts-vault.js)
// ============================================================================

// ============================================================================
// 3. МУЛЬТИ-АККАУНТ БАЗА ИСТОРИИ ЦЕН И РАДАР 16 СЕТЕЙ (вынесены в extension/bg/price-radar.js)
// ============================================================================

// ============================================================================
// 4. КЛОНИРОВАНИЕ, СВЕРКА И АВТО-СБОРКА КОРЗИНЫ (вынесено в extension/bg/cart-sync.js)
// ============================================================================

// ============================================================================
// 5. ПОИСК ОТЗЫВОВ И ЦЕН КОНКУРЕНТОВ В DUCKDUCKGO (ТОЧНОЕ СОВПАДЕНИЕ ТОВАРА)
// ============================================================================
function detectSourceSite(urlStr) {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    for (const s of REVIEW_SEARCH_SITES) {
      if (host === s.domain || host.endsWith('.' + s.domain)) {
        return { name: s.name, trusted: true };
      }
    }
    return { name: host.replace(/^www\./, '') || 'Веб', trusted: false };
  } catch {
    return { name: 'Веб', trusted: false };
  }
}


function unwrapDdgUrl(rawHref) {
  let href = String(rawHref || '').trim();
  if (!href) return '';
  if (href.includes('uddg=')) {
    try {
      const u = new URL(href, 'https://html.duckduckgo.com');
      href = u.searchParams.get('uddg') || href;
    } catch {
      // ignore
    }
  }
  return /^https?:\/\//i.test(href) ? href : '';
}

function isCategoryOrSearchListingUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(String(rawUrl));
    const path = (parsed.pathname || '').toLowerCase();
    const search = (parsed.search || '').toLowerCase();
    // Явные товарные карточки (например /product/..., /good/..., /p/..., /item/..., /tovar/...) пропускаем
    if (/(?:^|\/)(?:product|products|good|goods|p|item|tovar|card)(?:\/|$)/.test(path)) {
      return false;
    }
    if (/(?:^|\/)(?:catalog|category|categories|brand|brands|search|collection|collections|tag|tags|filter)(?:\/|$)/.test(path)) {
      return true;
    }
    if (/[?&](?:q|term|search|query)=/.test(search)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function extractCompetitorPricesFromSources(sources, lavkaPrice = null, productTitle = '', productAmount = '') {
  if (!Array.isArray(sources) || sources.length === 0) {
    return { competitorMinPrice: null, competitorSummary: '', competitorOffers: [] };
  }
  const found = [];
  const priceRegex = /(\d{2,4}(?:[.,]\d{1,2})?)\s*(?:₽|руб\.?|р\.)(?![а-яa-z])/gi;
  const targetGrams =
    (typeof parseVolumeOrWeightGrams === 'function'
      ? (parseVolumeOrWeightGrams(productAmount) || parseVolumeOrWeightGrams(productTitle))
      : null);

  for (const s of sources) {
    const rawTitle = s.title || '';
    const snippet = s.snippet || '';
    const url = s.url || '';

    // 1. Не извлекаем цены со страниц категорий, брендов, подборок и поиска
    if (isCategoryOrSearchListingUrl(url)) {
      continue;
    }

    if (productTitle) {
      const matchCheck = isSearchResultMatchingProduct(rawTitle, snippet, productTitle, productAmount);
      if (!matchCheck.isSameProduct || !matchCheck.isSameVolume) {
        continue;
      }
    }

    // 2. Если у целевого товара указан вес/объём, а в DDG-сниппете он не найден — не присваиваем цену
    if (targetGrams && typeof parseVolumeOrWeightGrams === 'function') {
      const resGrams = parseVolumeOrWeightGrams(rawTitle) || parseVolumeOrWeightGrams(snippet);
      if (!resGrams) {
        continue;
      }
    }

    const text = `${rawTitle} ${snippet}`;
    const storeName = s.source || 'Магазин';
    for (const m of text.matchAll(priceRegex)) {
      // 3. Игнорируем цены с предлогом «от » («от 99 ₽» — обычно минимальная цена категории за мелкую фасовку)
      const beforeChunk = text.slice(Math.max(0, (m.index || 0) - 10), m.index || 0).toLowerCase();
      if (/(?:^|[^а-яёa-z0-9])от\s+$/.test(beforeChunk)) {
        continue;
      }
      const val = parseFloat(m[1].replace(',', '.'));
      if (val >= 20 && val <= 9500) {
        if (lavkaPrice && (val < lavkaPrice * 0.35 || val > lavkaPrice * 3.0)) continue;
        found.push({
          store: storeName,
          price: Math.round(val),
          url,
          title: (rawTitle || storeName).slice(0, 90),
          origin: 'ddg'
        });
      }
    }
  }
  if (found.length === 0) return { competitorMinPrice: null, competitorSummary: '', competitorOffers: [] };
  found.sort((a, b) => a.price - b.price);
  const minP = found[0].price;
  const seen = new Set();
  const parts = [];
  const uniqueOffers = [];
  for (const item of found) {
    if (!seen.has(item.store)) {
      seen.add(item.store);
      parts.push(`${item.store}: ~${item.price} ₽`);
      uniqueOffers.push(item);
    }
    if (uniqueOffers.length >= 5) break;
  }
  return {
    competitorMinPrice: minP,
    competitorSummary: parts.slice(0, 3).join(', '),
    competitorOffers: uniqueOffers
  };
}

async function parseDdgHtmlSearch(query) {
  if (await isCircuitOpen('duckduckgo')) return [];
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const resp = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: {
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.7'
        }
      },
      5500
    );
    if (resp.status === 429 || resp.status === 403) {
      await recordCircuitFailure('duckduckgo', `HTTP ${resp.status}`, true);
      return [];
    }
    if (resp.ok) {
      const html = await resp.text();
      if (isCaptchaOrBlockHtml(html)) {
        await recordCircuitFailure('duckduckgo', 'captcha', true);
        return [];
      }
      const results = [];
      const chunks = html.split(/<h2[^>]+class="[^"]*result__title[^"]*"[^>]*>/i).slice(1, 11);
      for (const chunk of chunks) {
        const aMatch = chunk.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!aMatch) continue;
        const cleanUrl = unwrapDdgUrl(aMatch[1]);
        if (!cleanUrl) continue;

        const rawTitle = decodeHtmlEntities(aMatch[2]);
        const snipMatch =
          chunk.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
          chunk.match(/<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        const snippet = snipMatch ? decodeHtmlEntities(snipMatch[1]) : '';
        const siteInfo = detectSourceSite(cleanUrl);

        results.push({
          title: `[${siteInfo.name}] ${rawTitle.slice(0, 95)}`,
          source: siteInfo.name,
          trusted: siteInfo.trusted,
          snippet,
          url: cleanUrl
        });
      }
      if (results.length > 0) {
        await recordCircuitSuccess('duckduckgo');
        return results;
      }
    }
  } catch {
    // fallback to lite below
  }

  try {
    const liteUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const respLite = await fetchWithTimeout(
      liteUrl,
      {
        method: 'GET',
        headers: {
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.7'
        }
      },
      5500
    );
    if (!respLite.ok) {
      await recordCircuitFailure('duckduckgo', `Lite HTTP ${respLite.status}`, respLite.status === 429 || respLite.status === 403);
      return [];
    }
    const htmlLite = await respLite.text();
    if (isCaptchaOrBlockHtml(htmlLite)) {
      await recordCircuitFailure('duckduckgo', 'lite captcha', true);
      return [];
    }
    const results = [];
    const linkRegex = /<a[^>]+class="[^"]*result-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippets = Array.from(
      htmlLite.matchAll(/<td[^>]+class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/gi)
    ).map((m) => decodeHtmlEntities(m[1]));

    let idx = 0;
    for (const match of htmlLite.matchAll(linkRegex)) {
      if (results.length >= 9) break;
      const cleanUrl = unwrapDdgUrl(match[1]);
      const rawTitle = decodeHtmlEntities(match[2]);
      const snippet = snippets[idx] || '';
      idx += 1;
      if (!cleanUrl) continue;
      const siteInfo = detectSourceSite(cleanUrl);
      results.push({
        title: `[${siteInfo.name}] ${rawTitle.slice(0, 95)}`,
        source: siteInfo.name,
        trusted: siteInfo.trusted,
        snippet,
        url: cleanUrl
      });
    }
    if (results.length > 0) await recordCircuitSuccess('duckduckgo');
    return results;
  } catch (err) {
    await recordCircuitFailure('duckduckgo', err?.message || 'network error');
    return [];
  }
}

async function probeVkusVillSearchDirect(fullQuery, productTitle, productAmount = '', lavkaPrice = null) {
  if (!fullQuery) return [];
  if (await isCircuitOpen('vkusvill')) return [];
  try {
    const url = `https://vkusvill.ru/search/?q=${encodeURIComponent(fullQuery)}`;
    const resp = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        credentials: 'omit',
        headers: { 'Accept-Language': 'ru-RU,ru;q=0.9' }
      },
      3200
    );
    if (!resp.ok) {
      await recordCircuitFailure('vkusvill', `HTTP ${resp.status}`, resp.status === 429 || resp.status === 403);
      return [];
    }
    const html = await resp.text();
    if (isCaptchaOrBlockHtml(html)) {
      await recordCircuitFailure('vkusvill', 'captcha', true);
      return [];
    }
    const offers = [];
    const cardChunks = html.split(/class="[^"]*ProductCard[^"]*"/i).slice(1, 8);
    for (const chunk of cardChunks) {
      const titleMatch =
        chunk.match(/class="[^"]*ProductCard__link[^"]*"[^>]*title="([^"]+)"/i) ||
        chunk.match(/class="[^"]*ProductCard__link[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
      const hrefMatch = chunk.match(/href="(\/goods\/[^"]+)"/i);
      const priceMatch =
        chunk.match(/class="[^"]*Price--label[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ||
        chunk.match(/(\d{2,4})\s*(?:₽|руб)/i);
      if (!titleMatch || !priceMatch) continue;
      const itemTitle = decodeHtmlEntities(titleMatch[1]);
      const priceVal = parseFloat(decodeHtmlEntities(priceMatch[1]).replace(/[^\d.,]/g, '').replace(',', '.'));
      if (!priceVal || priceVal < 15 || priceVal > 9500) continue;
      if (lavkaPrice && (priceVal < lavkaPrice * 0.35 || priceVal > lavkaPrice * 3.0)) continue;

      const weightMatch = chunk.match(/class="[^"]*ProductCard__weight[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      const weightStr = weightMatch ? decodeHtmlEntities(weightMatch[1]) : '';
      const check = isSearchResultMatchingProduct(`${itemTitle} ${weightStr}`, '', productTitle, productAmount);
      if (check.isSameProduct && check.isSameVolume) {
        offers.push({
          store: 'ВкусВилл',
          price: Math.round(priceVal),
          url: hrefMatch ? `https://vkusvill.ru${hrefMatch[1]}` : url,
          title: `${itemTitle} ${weightStr}`.trim(),
          isVerifiedStoreOffer: true
        });
      }
    }
    await recordCircuitSuccess('vkusvill');
    return offers;
  } catch (err) {
    await recordCircuitFailure('vkusvill', err?.message || 'network error');
    return [];
  }
}

async function probeDirectRetailStoresForProduct(productTitle, brand = '', amount = '', lavkaPrice = null) {
  const fullQ = buildFullProductSearchQuery(productTitle, brand, amount);
  if (!fullQ) return [];

  const extList = await getExternalStoreOffersList();
  const matchedSeedOrHarvested = findMatchingExternalStoreOffersFromList(extList, fullQ, amount);

  const vvOffers = await probeVkusVillSearchDirect(fullQ, fullQ, amount, lavkaPrice);

  let strictQ = fullQ;
  if (/без\s+сахара/i.test(strictQ)) {
    strictQ = strictQ.replace(/без\s+сахара/i, '"без сахара"');
  }
  const qStores = `${strictQ} цена ₽ (site:magnit.ru OR site:perekrestok.ru OR site:5ka.ru OR site:lenta.com OR site:auchan.ru OR site:online.metro-cc.ru OR site:globus.ru OR site:ozon.ru OR site:kuper.ru OR site:vprok.ru)`;
  const ddgHits = await parseDdgHtmlSearch(qStores);
  const extractedDdg = extractCompetitorPricesFromSources(ddgHits, lavkaPrice, fullQ, amount);

  return mergeUniqueStoreOffers(
    [...matchedSeedOrHarvested, ...vvOffers],
    extractedDdg.competitorOffers || []
  );
}

async function searchWebReviewsDirect(title, brand = '', amount = '') {
  const fullQ = buildFullProductSearchQuery(title, brand, amount);
  if (!fullQ) return [];

  let strictQ = fullQ;
  if (/без\s+сахара/i.test(strictQ)) {
    strictQ = strictQ.replace(/без\s+сахара/i, '"без сахара"');
  }

  const qPrimary = `${strictQ} цена отзывы (site:otzovik.com OR site:irecommend.ru OR site:magnit.ru OR site:5ka.ru OR site:perekrestok.ru OR site:vkusvill.ru OR site:auchan.ru OR site:online.metro-cc.ru OR site:globus.ru OR site:lenta.com OR site:ozon.ru OR site:kuper.ru OR site:rskrf.ru)`;
  const qFallback = `${strictQ} купить цена отзывы`;

  const collected = [];
  const seen = new Set();

  try {
    const primaryHits = await parseDdgHtmlSearch(qPrimary);
    for (const item of primaryHits) {
      if (seen.has(item.url)) continue;
      const matchCheck = isSearchResultMatchingProduct(item.title, item.snippet, title, amount);
      if (!matchCheck.isSameProduct) continue;
      item.sameVolume = matchCheck.isSameVolume;
      seen.add(item.url);
      collected.push(item);
    }
    if (collected.length < 3) {
      const fallbackHits = await parseDdgHtmlSearch(qFallback);
      fallbackHits.sort((a, b) => (a.trusted === b.trusted ? 0 : a.trusted ? -1 : 1));
      for (const item of fallbackHits) {
        if (seen.has(item.url)) continue;
        const matchCheck = isSearchResultMatchingProduct(item.title, item.snippet, title, amount);
        if (!matchCheck.isSameProduct) continue;
        item.sameVolume = matchCheck.isSameVolume;
        seen.add(item.url);
        collected.push(item);
        if (collected.length >= 6) break;
      }
    }
  } catch {
    // ignore network errors
  }

  return collected.slice(0, 6);
}

function buildPricingContext(payload, priceIntel = null) {
  let pricePerKg = payload.pricePerKg || null;
  let unitLabel = payload.unitLabel || 'кг';
  let pricePerPiece = payload.pricePerPiece || null;
  let pieceUnitLabel = payload.pieceUnitLabel || 'шт';
  let piecesCount = payload.piecesCount || null;
  const protein = payload.proteinPer100g ?? null;
  const proteinCost = payload.pricePer100gProtein ?? null;
  const price = payload.price ? Number(payload.price) : null;
  const amount = String(payload.amount || '').trim();

  if (!pricePerKg && !pricePerPiece && amount && price) {
    const multiMatch = amount.match(
      /(\d+)\s*(?:[×xх*]|шт\.?\s*по|пакет[а-я]*\s*по)\s*([\d.,]+)\s*(г|гр|грамм|кг|мл|л)(?![а-яёa-z])/i
    );
    if (multiMatch) {
      const cnt = parseInt(multiMatch[1], 10) || 1;
      const val = parseFloat(multiMatch[2].replace(',', '.'));
      const u = multiMatch[3].toLowerCase();
      unitLabel = u === 'мл' || u === 'л' ? 'л' : 'кг';
      const grams = cnt * (u === 'кг' || u === 'л' ? val * 1000 : val);
      if (grams > 0) pricePerKg = Math.round((price / grams) * 1000);
    } else {
      const singleMatch = amount.match(/([\d.,]+)\s*(г|гр|грамм|кг|мл|л|литр[а-я]*)(?![а-яёa-z])/i);
      if (singleMatch) {
        const val = parseFloat(singleMatch[1].replace(',', '.'));
        const u = singleMatch[2].toLowerCase();
        unitLabel = u.startsWith('мл') || u.startsWith('л') ? 'л' : 'кг';
        const grams = u.startsWith('кг') || u.startsWith('л') ? val * 1000 : val;
        if (grams > 0) pricePerKg = Math.round((price / grams) * 1000);
      } else {
        const pieceMatch = amount.match(
          /(\d+)\s*(шт|штук[а-я]*|пакет[а-я]*|капс[а-я]*|табл[а-я]*|рулон[а-я]*|порц[а-я]*|пар[а-я]*|уп[а-я]*)(?![а-яёa-z])/i
        );
        if (pieceMatch) {
          piecesCount = parseInt(pieceMatch[1], 10) || 1;
          if (piecesCount > 0) pricePerPiece = Math.round(price / piecesCount);
        }
      }
    }
  }

  const radarNotes = [];
  if (priceIntel) {
    if (priceIntel.minPrice && price && priceIntel.minPrice < price - 2) {
      radarNotes.push(`минимальная цена в твоей базе была ${priceIntel.minPrice} ₽`);
    }
    if (priceIntel.competitorSummary) {
      radarNotes.push(`цены у конкурентов: ${priceIntel.competitorSummary}`);
    }
  }
  const radarSuffix = radarNotes.length ? ` | Радар цен: ${radarNotes.join('; ')}` : '';

  if (pricePerKg) {
    if (proteinCost && protein !== null && protein >= 3) {
      return {
        calcLine: `в пересчёте ~${pricePerKg} ₽/${unitLabel}; стоимость 100 г белка ~${proteinCost} ₽ (белка ${protein} г на 100 г)${radarSuffix}`,
        evalHint: `в пересчёте на 1 ${unitLabel} (~${pricePerKg} ₽/${unitLabel}), с учётом цены белка (~${proteinCost} ₽ за 100 г) и данных радара цен`,
        ruleLine: `Для этого товара рассчитана точная цена за 1 ${unitLabel} (~${pricePerKg} ₽/${unitLabel}) и за 100 г белка (~${proteinCost} ₽) — опирайся на эти цифры.`
      };
    }
    return {
      calcLine: `в пересчёте ~${pricePerKg} ₽/${unitLabel}${radarSuffix}`,
      evalHint: `в пересчёте на 1 ${unitLabel} (~${pricePerKg} ₽/${unitLabel}) и по данным радара цен`,
      ruleLine: `Для этого товара рассчитана точная цена за 1 ${unitLabel} (~${pricePerKg} ₽/${unitLabel}). Стоимость белка отдельно не оценивай, если это не белковый продукт.`
    };
  }

  if (pricePerPiece && piecesCount && piecesCount > 1) {
    return {
      calcLine: `поштучная фасовка (${piecesCount} ${pieceUnitLabel}) — ~${pricePerPiece} ₽ за 1 ${pieceUnitLabel}, вес в граммах не указан${radarSuffix}`,
      evalHint: `за 1 ${pieceUnitLabel} (~${pricePerPiece} ₽/${pieceUnitLabel}) и за упаковку`,
      ruleLine: `Товар продаётся поштучно (${piecesCount} ${pieceUnitLabel}, ~${pricePerPiece} ₽/${pieceUnitLabel}) без указания веса в граммах — НЕ пытайся считать цену за килограмм, оценивай выгоду за штуку/упаковку.`
    };
  }

  return {
    calcLine: `вес в граммах не указан (оценка за упаковку / 1 шт.)${radarSuffix}`,
    evalHint: 'за саму упаковку / штуку (без пересчёта за килограмм)',
    ruleLine: 'На карточке этого товара не указан вес в граммах или миллилитрах — НЕ пытайся выдумывать или требовать цену за килограмм, оценивай адекватность цены за саму штуку/упаковку.'
  };
}

function buildProductReviewPrompt(payload, webSources, isBrowserGeminiTab = false, priceIntel = null) {
  const sitesListStr = REVIEW_SEARCH_SITES.slice(0, 12)
    .map((s) => `${s.name} (${s.domain})`)
    .join(', ');

  let snippetsText = '';
  if (Array.isArray(webSources) && webSources.length > 0) {
    snippetsText = webSources
      .map((s) => `- ${s.title || 'Отзыв'} (${s.url || ''}): ${s.snippet || ''}`)
      .join('\n');
  } else if (isBrowserGeminiTab) {
    snippetsText =
      'Предварительный парсер не нашёл прямых сниппетов — пожалуйста, проверь наличие реальных отзывов и цен ИМЕННО об этой модификации товара через поиск Google по площадкам выше. Если отзывов именно на этот товар нет — честно напиши об этом и оценивай строго по составу, КБЖУ и цене.';
  } else {
    snippetsText =
      'Прямых отзывов именно на эту модификацию товара в поисковой выдаче не найдено — честно сообщи об этом в 1-м пункте и оценивай товар строго по составу, КБЖУ и цене.';
  }

  const pricing = buildPricingContext(payload, priceIntel);
  const brandSuffix = payload.brand ? ` (Бренд: ${payload.brand})` : '';

  return [
    `Ты — опытный, внимательный и объективный продуктовый эксперт. Сделай короткий и понятный разбор товара из Яндекс Лавки (ровно 3 пункта, без воды, без молодёжного сленга и без выдумок — нормальным разговорным русским языком).`,
    ``,
    `Данные карточки товара:`,
    `• Точное название: ${payload.title}${brandSuffix}`,
    `• Фасовка и цена: ${payload.amount || 'не указана'}, Цена: ${payload.price || '?'} ₽ (${pricing.calcLine})`,
    `• Состав: ${payload.ingredients || 'не указан на странице'}`,
    `• КБЖУ на 100 г: ${payload.traits || 'не указано на странице'}`,
    ``,
    `Площадки для проверки отзывов и цен: ${sitesListStr}.`,
    `Найденные отзывы и цены в интернете (проверены на совпадение модификации):\n${snippetsText}`,
    ``,
    `СТРОГИЕ ПРАВИЛА ЧЕСТНОСТИ (ТОЛЬКО ФАКТЫ, БЕЗ ПРИДУМОК):`,
    `- Оценивай СТРОГО ИМЕННО ЭТОТ ТОВАР и его модификацию («${payload.title} ${payload.amount || ''}»). Не путай товары «без сахара» / «Zero» с обычными сахарными версиями!`,
    `- Пиши ТОЛЬКО подтверждённые факты из реальных отзывов, состава, КБЖУ и цены.`,
    `- Если реальных отзывов именно об этом продукте нет — ЧЕСТНО напиши в 1-м пункте: «Отзывов именно на этот товар в сети не нашлось, поэтому оцениваю по составу и характеристикам». Категорически запрещено придумывать вкус, консистенцию или несуществующие мнения покупателей.`,
    `- ${pricing.ruleLine}`,
    ``,
    `Ответь ровно в 3 коротких пунктах (по 1–2 предложения в каждом), обычным живым русским языком без сленга:`,
    `1. **Отзывы и репутация**: что реально пишут покупатели на отзовиках и в магазинах именно про этот товар (укажи площадки, если отзывы найдены), либо честно отметь, что отзывов в сети не найдено, и скажи, что сразу видно по характеристикам продукта.`,
    `2. **Состав, КБЖУ и честность цены**: фактический разбор состава (подсластители/сахар, крахмал, ММО, заменители молочного жира, добавки или чистый состав) и насколько адекватна цена (${pricing.evalHint}).`,
    `3. **Вердикт**: выбери ОДНУ оценку на нормальном русском языке и кратко поясни вывод:`,
    `   • ✅ **Отличный выбор — стоит брать**`,
    `   • 👍 **Хороший вариант на каждый день (есть мелкие нюансы)**`,
    `   • ⚠️ **С оговорками: <короткая причина в 2–4 словах, например «много сахара», «дорого за 1 кг», «пальмовое масло»>**`,
    `   • ❌ **Не рекомендую к покупке**`
  ].join('\n');
}

async function isProductStillRelevantForUser(slug, title, forceRefresh = false, isManualUserClick = false) {
  if (forceRefresh || isManualUserClick) return true;
  const reqKey = normalizeCacheKey(slug, title);
  if (reqKey && reqKey === latestRequestedProductKey) return true;
  try {
    const lavkaTabs = await chrome.tabs.query({ url: ['https://lavka.yandex.ru/*'] });
    for (const t of lavkaTabs || []) {
      const u = decodeURIComponent(t.url || '').toLowerCase();
      if (slug && u.includes(String(slug).toLowerCase())) return true;
    }
  } catch {
    return true;
  }
  return false;
}

async function checkAllConnections() {
  const settings = await getSettings();
  const cookieInfo = await inspectGeminiCookies();
  const openGeminiTabs = await listOpenGeminiTabsWithAccounts();
  const selectedTab = await findOpenGeminiTab(false, false);
  const localCacheMap = await getLocalAiCacheMap();
  const localCacheCount = Object.keys(localCacheMap).length;
  const priceDb = await getLocalPriceDb();
  const trackedPricesCount = Object.keys(priceDb).length;

  const backendUrl = settings.backendUrl.replace(/\/$/, '');
  const providerCfg = resolveProviderConfig(settings);
  const aiBaseUrl = (providerCfg.protocol === 'gemini_tab' ? settings.aiBaseUrl : providerCfg.baseUrl || settings.aiBaseUrl).replace(/\/$/, '');

  let backendStatus = { ok: false, cachedItems: 0, trackedPrices: trackedPricesCount, msg: 'Выкл (локальная БД)' };
  try {
    const r1 = await fetchWithTimeout(`${backendUrl}/api/health`, { method: 'GET', headers: await getBackendAuthHeaders(backendUrl) }, 1000);
    if (r1.ok) {
      backendOfflineUntilTs = 0;
      const j = await r1.json().catch(() => ({}));
      backendStatus = {
        ok: true,
        cachedItems: j.cachedItems ?? 0,
        trackedPrices: j.trackedPrices ?? trackedPricesCount,
        msg: `ОК (кэш: ${j.cachedItems ?? 0}, цен: ${j.trackedPrices ?? 0})`
      };
    } else {
      backendStatus = { ok: false, cachedItems: 0, trackedPrices: trackedPricesCount, msg: `HTTP ${r1.status}` };
    }
  } catch {
    backendOfflineUntilTs = Date.now() + 10000;
  }

  let bridgeStatus = { ok: false, msg: providerCfg.protocol === 'gemini_tab' ? 'Режим вкладки Gemini' : `${providerCfg.label}: не проверен` };
  if (providerCfg.protocol === 'gemini_tab') {
    bridgeStatus = {
      ok: Boolean(selectedTab || cookieInfo.ok),
      msg: selectedTab
        ? 'Вкладка Gemini подключена'
        : cookieInfo.ok
          ? 'Готов (режим вкладки Gemini)'
          : 'Нужен вход в аккаунт Google'
    };
  } else {
    const connTest = await testAiProviderWithVault({
      aiProvider: providerCfg.providerId,
      aiBaseUrl: providerCfg.baseUrl,
      aiApiKey: settings.aiApiKey,
      timeoutMs: 3500
    });
    if (connTest.ok) {
      bridgeOfflineUntilTs = 0;
      const activeModelLabel = settings.aiModel || connTest.models[0] || providerCfg.model || 'авто';
      bridgeStatus = { ok: true, msg: `ОК (${providerCfg.label}: ${activeModelLabel})` };
    } else {
      bridgeStatus = { ok: false, msg: connTest.error || `Ошибка подключения (${providerCfg.label})` };
    }
  }

  const matchedTabInfo = selectedTab
    ? openGeminiTabs.find((t) => t.tabId === selectedTab.id) || {
        tabId: selectedTab.id,
        url: selectedTab.url,
        accountIndex: extractAccountIndexFromUrl(selectedTab.url),
        email: null
      }
    : null;

  return {
    ok: true,
    geminiTab: {
      found: Boolean(selectedTab),
      tabId: selectedTab ? selectedTab.id : null,
      url: selectedTab ? selectedTab.url : null,
      accountIndex: matchedTabInfo ? matchedTabInfo.accountIndex : null,
      email: matchedTabInfo ? matchedTabInfo.email : null
    },
    openGeminiTabs,
    cookies: {
      ok: cookieInfo.ok,
      count: cookieInfo.cookiesCount,
      hasSecure1PSID: cookieInfo.hasSecure1PSID,
    },
    backend: backendStatus,
    bridge: bridgeStatus,
    localAiCacheCount: localCacheCount,
    trackedPricesCount,
    settings
  };
}

async function saveVerdictToBackendCache(backendUrl, slug, title, verdict, sources) {
  if (!backendUrl || Date.now() < backendOfflineUntilTs) return;
  try {
    await fetchWithTimeout(
      `${backendUrl}/api/save-cache`,
      {
        method: 'POST',
        headers: await getBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          slug: slug || title,
          title,
          verdict,
          sources: Array.isArray(sources) ? sources : []
        })
      },
      2000
    );
  } catch {
    backendOfflineUntilTs = Date.now() + 10000;
  }
}

async function orchestrateProductAnalysisInternal(payload) {
  const stopKeepAlive = startSwKeepAlive();
  try {
    const settings = await getSettings();
    const backendUrl = settings.backendUrl.replace(/\/$/, '');
    const providerCfg = resolveProviderConfig(settings);
    const aiBaseUrl = (providerCfg.baseUrl || settings.aiBaseUrl || '').replace(/\/$/, '');
    const backendAnalyzeTimeoutMs = LIMITS.BACKEND_ANALYZE_TIMEOUT_MS || 35000;
    const directAiTimeoutMs = LIMITS.AI_DIRECT_TIMEOUT_MS || AI_DIRECT_TIMEOUT_MS || 28000;
    const acc = payload.accountId || settings.lavkaAccountLabel || 'Аккаунт #1';

    let priceIntel = await getProductPriceIntelligence(
      payload.slug,
      payload.title,
      payload.price,
      payload.oldPrice,
      payload.amount,
      acc,
      true, // вызов со страницы оригинальной карточки товара!
      payload.imageKey || null,
      payload.brand || ''
    );

    const authoritativeTitle = buildFullProductSearchQuery(payload.title, payload.brand, payload.amount);

    if (!payload.forceRefresh) {
      const localCached = await getLocalAiCacheEntry(payload.slug, authoritativeTitle, payload.imageKey);
      if (localCached && localCached.verdict) {
        const resObj = {
          ok: true,
          cached: true,
          mode: `Кэш браузера (${localCached.mode || 'ИИ'})`,
          verdict: localCached.verdict,
          sources: localCached.sources || [],
          priceSummary: priceIntel
        };
        broadcastAiVerdictToLavkaTabs(payload.slug, authoritativeTitle, resObj);
        return resObj;
      }
    }

    let webSources = [];
    let backendOnline = false;
    const paidDailyLimit = Number.isFinite(Number(settings.paidAiDailyLimit))
      ? Math.max(0, Math.floor(Number(settings.paidAiDailyLimit)))
      : (LIMITS.DEFAULT_PAID_AI_DAILY_LIMIT || 25);

    if (providerCfg.isPaid) {
      const currentLedger = await getAiUsageLedger();
      const limitCheck = checkPaidAiDailyLimit(currentLedger, paidDailyLimit);
      if (!limitCheck.allowed) {
        return {
          ok: false,
          limitReached: true,
          mode: providerCfg.label,
          error: limitCheck.error,
          sources: webSources,
          priceSummary: priceIntel,
          usageStats: { ...currentLedger, dailyLimit: paidDailyLimit }
        };
      }
    }

    if (backendUrl && Date.now() > backendOfflineUntilTs) {
      try {
        const healthResp = await fetchWithTimeout(
          `${backendUrl}/api/health`,
          { method: 'GET', headers: await getBackendAuthHeaders(backendUrl) },
          800
        );
        if (healthResp.ok) {
          backendOnline = true;
          const resp = await fetchWithTimeout(
            `${backendUrl}/api/analyze-product`,
            {
              method: 'POST',
              headers: await getBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' }),
              body: JSON.stringify({
                ...payload,
                title: authoritativeTitle,
                accountId: acc,
                aiProvider: providerCfg.providerId,
                aiBaseUrl: providerCfg.baseUrl || settings.aiBaseUrl,
                aiApiKey: settings.aiKeyStoredOnServer ? (settings.aiKeyMask || '') : (settings.aiApiKey || ''),
                aiModel: settings.aiModel || providerCfg.model
              })
            },
            backendAnalyzeTimeoutMs
          );

          if (resp.ok) {
            const data = await resp.json();
            if (Array.isArray(data.sources)) {
              webSources = data.sources;
            }
            if (data.priceSummary) {
              priceIntel = { ...(priceIntel || {}), ...data.priceSummary };
            }
            if (data.verdict && data.aiOk !== false && !data.verdict.startsWith('⚠️')) {
              const costUsd = typeof data.costUsd === 'number' ? data.costUsd : null;
              const costSuffix = costUsd !== null ? ` · ${formatCostUsd(costUsd)}` : '';
              const modelTag = data.aiModel || settings.aiModel || providerCfg.model || providerCfg.label;
              const modeLabel = data.cached
                ? 'FastAPI SQLite Cache (:8765)'
                : `FastAPI (:8765) + ${modelTag}${costSuffix}`;
              await saveLocalAiCacheEntry(payload.slug, authoritativeTitle, data.verdict, webSources, modeLabel, payload.imageKey);
              let updatedUsage = null;
              if (providerCfg.isPaid && !data.cached) {
                const prevLedger = await getAiUsageLedger();
                updatedUsage = await saveAiUsageLedger(
                  recordPaidAiUsage(prevLedger, {
                    costUsd,
                    providerId: providerCfg.providerId,
                    model: modelTag
                  })
                );
              }
              const resObj = {
                ok: true,
                cached: Boolean(data.cached),
                mode: modeLabel,
                verdict: data.verdict,
                sources: webSources,
                priceSummary: priceIntel,
                costUsd,
                usageStats: updatedUsage ? { ...updatedUsage, dailyLimit: paidDailyLimit } : null
              };
              broadcastAiVerdictToLavkaTabs(payload.slug, authoritativeTitle, resObj);
              return resObj;
            }
          }
        }
      } catch {
        backendOfflineUntilTs = Date.now() + 12000;
      }
    }

    if (!webSources || webSources.length === 0) {
      webSources = await searchWebReviewsDirect(authoritativeTitle, payload.brand, payload.amount);
    }

    const comp = extractCompetitorPricesFromSources(webSources, payload.price, authoritativeTitle, payload.amount);
    if (comp.competitorMinPrice || comp.competitorSummary || comp.competitorOffers.length > 0) {
      const updatedMap = await recordPricesBatch(acc, [
        {
          slug: payload.slug,
          title: authoritativeTitle,
          isCanonicalCardTitle: true,
          brand: payload.brand || '',
          imageKey: payload.imageKey || null,
          price: payload.price || 0,
          oldPrice: payload.oldPrice || null,
          amount: payload.amount || '',
          competitorMinPrice: comp.competitorMinPrice,
          competitorSummary: comp.competitorSummary,
          competitorOffers: comp.competitorOffers
        }
      ]);
      const cleanSlug = String(payload.slug || '').trim().toLowerCase();
      if (updatedMap[cleanSlug]) {
        priceIntel = updatedMap[cleanSlug];
      }
    }

    if (providerCfg.protocol !== 'gemini_tab' && aiBaseUrl && (providerCfg.isPaid || Date.now() > bridgeOfflineUntilTs)) {
      try {
        const directKey = settings.aiApiKey && !isMaskedApiKey(settings.aiApiKey) ? settings.aiApiKey : '';
        if (providerCfg.requiresKey && !directKey && settings.aiKeyStoredOnServer) {
          throw new Error('API-ключ зашифрован на локальном сервере (:8765), но сервер сейчас выключен. Запустите start_server.bat или пересохраните ключ в настройках.');
        }
        const promptForBridge = buildProductReviewPrompt({ ...payload, title: authoritativeTitle }, webSources, false, priceIntel);
        const aiResult = await callAiProvider(
          {
            aiProvider: providerCfg.providerId,
            aiBaseUrl: providerCfg.baseUrl,
            aiApiKey: directKey,
            aiModel: settings.aiModel,
            timeoutMs: directAiTimeoutMs
          },
          promptForBridge
        );
        if (aiResult && aiResult.ok && aiResult.text) {
          bridgeOfflineUntilTs = 0;
          const cleanReply = aiResult.text.trim();
          const costUsd = typeof aiResult.costUsd === 'number' ? aiResult.costUsd : null;
          const costSuffix = costUsd !== null ? ` · ${formatCostUsd(costUsd)}` : '';
          const modeLabel = `${aiResult.providerLabel} · ${aiResult.model}${costSuffix}`;
          await saveLocalAiCacheEntry(payload.slug, authoritativeTitle, cleanReply, webSources, modeLabel, payload.imageKey);
          if (backendOnline) {
            saveVerdictToBackendCache(backendUrl, payload.slug, authoritativeTitle, cleanReply, webSources);
          }
          let updatedUsage = null;
          if (providerCfg.isPaid) {
            const prevLedger = await getAiUsageLedger();
            updatedUsage = await saveAiUsageLedger(
              recordPaidAiUsage(prevLedger, {
                costUsd,
                usage: aiResult.usage || null,
                providerId: providerCfg.providerId,
                model: aiResult.model
              })
            );
          }
          const resObj = {
            ok: true,
            cached: false,
            mode: modeLabel,
            verdict: cleanReply,
            sources: webSources,
            priceSummary: priceIntel,
            costUsd,
            usage: aiResult.usage || null,
            usageStats: updatedUsage ? { ...updatedUsage, dailyLimit: paidDailyLimit } : null
          };
          broadcastAiVerdictToLavkaTabs(payload.slug, authoritativeTitle, resObj);
          return resObj;
        }
      } catch (err) {
        if (providerCfg.isPaid) {
          return {
            ok: false,
            mode: providerCfg.label,
            error: err && err.message ? err.message : String(err),
            sources: webSources,
            priceSummary: priceIntel
          };
        }
        bridgeOfflineUntilTs = Date.now() + 15000;
      }
    }

    return await enqueueGeminiTabExecution(async () => {
      if (!payload.forceRefresh) {
        const alreadyCached = await getLocalAiCacheEntry(payload.slug, authoritativeTitle, payload.imageKey);
        if (alreadyCached && alreadyCached.verdict) {
          const resObj = {
            ok: true,
            cached: true,
            mode: `Кэш браузера (${alreadyCached.mode || 'ИИ'})`,
            verdict: alreadyCached.verdict,
            sources: alreadyCached.sources || [],
            priceSummary: priceIntel
          };
          broadcastAiVerdictToLavkaTabs(payload.slug, authoritativeTitle, resObj);
          return resObj;
        }
      }

      const stillRelevant = await isProductStillRelevantForUser(
        payload.slug,
        authoritativeTitle,
        payload.forceRefresh,
        Boolean(payload.isManualUserClick)
      );
      if (!stillRelevant) {
        return {
          ok: false,
          skippedStale: true,
          error: 'Запрос отменён, так как открыт другой товар.',
          sources: webSources,
          priceSummary: priceIntel
        };
      }

      const geminiMode = normalizeGeminiTabMode(settings.geminiTabMode);
      const loginUrl = buildGeminiUrlForAccount(settings.geminiAccountIndex);
      const existingGeminiTab = await findOpenGeminiTab(false, false);
      const hasReadyOpenTab = Boolean(
        existingGeminiTab && existingGeminiTab.id && !isGeminiLoginRequired(existingGeminiTab, null)
      );
      const cookieCheck = await inspectGeminiCookies();
      if (!hasReadyOpenTab && isGeminiLoginRequired(null, cookieCheck)) {
        return {
          ok: false,
          needsGeminiLogin: true,
          loginUrl,
          mode: 'Gemini Web (Hydrogen)',
          error: 'Вы не вошли в аккаунт Google. Откройте Gemini один раз для входа, после чего режим «Невидимка» заработает автоматически.',
          sources: webSources,
          priceSummary: priceIntel
        };
      }

      await cancelGeminiIdleCloseTimer();
      let geminiTab = null;
      try {
        geminiTab = hasReadyOpenTab ? existingGeminiTab : await findOpenGeminiTab(true, false);
        if (geminiTab && isGeminiLoginRequired(geminiTab, hasReadyOpenTab ? null : cookieCheck)) {
          await closeManagedGeminiSession('login-required');
          return {
            ok: false,
            needsGeminiLogin: true,
            loginUrl,
            mode: 'Gemini Web (Hydrogen)',
            error: 'Gemini запросил вход в аккаунт Google. Нажмите «Открыть Gemini для входа», авторизуйтесь и повторите разбор.',
            sources: webSources,
            priceSummary: priceIntel
          };
        }

        if (geminiTab && geminiTab.id) {
          const email = await detectTabAccountEmail(geminiTab.id);
          const accIdx = extractAccountIndexFromUrl(geminiTab.url);
          const promptForTab = buildProductReviewPrompt({ ...payload, title: authoritativeTitle }, webSources, true, priceIntel);
          const tabResult = await executePromptInsideGeminiTab(
            geminiTab.id,
            promptForTab,
            authoritativeTitle,
            Boolean(payload.forceRefresh)
          );
          if (tabResult && tabResult.ok && tabResult.text) {
            const accLabel = email ? `${email} (/u/${accIdx})` : `/u/${accIdx}`;
            const modePrefix = geminiMode === 'stealth_window' ? 'Gemini Невидимка' : 'Вкладка Gemini';
            const modeLabel = `${modePrefix} [${accLabel}]`;
            await saveLocalAiCacheEntry(payload.slug, authoritativeTitle, tabResult.text, webSources, modeLabel, payload.imageKey);
            if (backendOnline) {
              saveVerdictToBackendCache(backendUrl, payload.slug, authoritativeTitle, tabResult.text, webSources);
            }
            const resObj = {
              ok: true,
              cached: false,
              mode: modeLabel,
              verdict: tabResult.text,
              sources: webSources,
              priceSummary: priceIntel
            };
            broadcastAiVerdictToLavkaTabs(payload.slug, authoritativeTitle, resObj);
            return resObj;
          }
          return {
            ok: false,
            mode: 'Gemini Tab Error',
            error:
              tabResult && tabResult.error
                ? tabResult.error
                : 'Не удалось получить ответ от вкладки gemini.google.com.',
            sources: webSources,
            priceSummary: priceIntel
          };
        }
      } finally {
        if (geminiTab && geminiTab.id) {
          await scheduleGeminiIdleCloseTimer(settings);
        }
      }

      return {
        ok: false,
        mode: 'All AI methods unreachable',
        error: 'Не удалось найти или открыть вкладку gemini.google.com. Откройте Gemini, убедитесь во входе в аккаунт и повторите попытку.',
        sources: webSources,
        priceSummary: priceIntel
      };
    });
  } finally {
    stopKeepAlive();
  }
}

async function orchestrateProductAnalysis(payload) {
  const key = normalizeCacheKey(payload.slug, payload.title);
  if (key) {
    latestRequestedProductKey = key;
  }
  if (key && !payload.forceRefresh && !payload.isManualUserClick && inFlightRequests.has(key)) {
    const existingEntry = inFlightRequests.get(key);
    if (existingEntry && Date.now() - existingEntry.startedAt < 35000) {
      return existingEntry.promise;
    }
    inFlightRequests.delete(key);
  }
  const promise = orchestrateProductAnalysisInternal(payload).finally(() => {
    if (key) inFlightRequests.delete(key);
  });
  if (key) {
    inFlightRequests.set(key, { promise, startedAt: Date.now() });
  }
  return promise;
}

// ============================================================================
// 7. СОБЫТИЯ ЖИЗНЕННОГО ЦИКЛА И ОБРАБОТЧИК СООБЩЕНИЙ
// ============================================================================

// Единый явный мост зависимостей background.js для вынесенных модулей bg/*.js
globalThis.LQS_BG_DEPS = {
  getBackendOfflineUntilTs: () => backendOfflineUntilTs,
  setBackendOfflineUntilTs: (ts) => {
    backendOfflineUntilTs = ts;
  },
  getBridgeOfflineUntilTs: () => bridgeOfflineUntilTs,
  setBridgeOfflineUntilTs: (ts) => {
    bridgeOfflineUntilTs = ts;
  },
  getSwKeepAliveActiveTasks: () => swKeepAliveActiveTasks,
  getBackendAuthHeaders,
  startSwKeepAlive,
  waitForTabCompleteSafe,
  autoBuildCartInBrowser,
  getLocalAiCacheEntry,
  searchWebReviewsDirect,
  extractCompetitorPricesFromSources,
  probeDirectRetailStoresForProduct
};

const WATCHLIST_ALARM_NAME = 'lqs_watchlist_price_check';

async function syncWatchlistAlarm() {
  try {
    if (!chrome.alarms) return;
    const settings = await getSettings();
    const hours = Number(settings.watchlistCheckIntervalHours ?? 6);
    if (!hours || hours <= 0) {
      chrome.alarms.clear(WATCHLIST_ALARM_NAME);
      return;
    }
    chrome.alarms.create(WATCHLIST_ALARM_NAME, {
      delayInMinutes: Math.max(15, Math.round(hours * 60)),
      periodInMinutes: Math.max(60, Math.round(hours * 60))
    });
  } catch {
    // ignore
  }
}

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === WATCHLIST_ALARM_NAME) {
      checkWatchlistPricesBatch({ maxItems: 12 }).catch(() => {});
    }
    if (alarm && alarm.name === GEMINI_IDLE_ALARM_NAME) {
      closeManagedGeminiSession('idle-alarm').catch(() => {});
    }
  });
}

if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes && changes[LQS_CONFIG.STORAGE_KEYS.SETTINGS]) {
      syncWatchlistAlarm();
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAutopilotWarmup('onInstalled');
  getAccountsVaultMap();
  syncWatchlistAlarm();
  startLocalServerViaNativeHost({ force: false }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureAutopilotWarmup('onStartup');
  syncWatchlistAlarm();
  startLocalServerViaNativeHost({ force: false }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab && tab.url && tab.url.startsWith('https://lavka.yandex.ru/')) {
    ensureAutopilotWarmup('lavka-tab-opened');
  }
});

function isPopupSender(sender) {
  const popupPrefix = chrome.runtime.getURL('popup.html');
  return Boolean(sender && typeof sender.url === 'string' && sender.url.startsWith(popupPrefix));
}

function isTrustedLavkaOrPopupSender(sender) {
  if (isPopupSender(sender)) return true;
  const u = sender && typeof sender.url === 'string' ? sender.url : '';
  return (
    u.startsWith('https://lavka.yandex.ru/') ||
    u.startsWith('https://passport.yandex.ru/') ||
    u.startsWith('https://id.yandex.ru/')
  );
}

function isPassportOrPopupSender(sender) {
  if (isPopupSender(sender)) return true;
  const u = sender && typeof sender.url === 'string' ? sender.url : '';
  return u.startsWith('https://passport.yandex.ru/') || u.startsWith('https://id.yandex.ru/');
}

const TRUSTED_EXTERNAL_STORE_DOMAINS = [
  'magnit.ru',
  'kuper.ru',
  'perekrestok.ru',
  'vprok.ru',
  '5ka.ru',
  'vkusvill.ru',
  'auchan.ru',
  'lenta.com'
];

function isTrustedRetailStoreSender(sender) {
  const u = sender && typeof sender.url === 'string' ? sender.url : '';
  if (!u) return false;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'https:') return false;
    const h = parsed.hostname.toLowerCase();
    return TRUSTED_EXTERNAL_STORE_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

function isTrustedExternalStoreSender(sender) {
  return isTrustedLavkaOrPopupSender(sender) || isTrustedRetailStoreSender(sender);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'LQS_ANALYZE_PRODUCT') {
    if (!isTrustedExternalStoreSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    orchestrateProductAnalysis(msg.payload || {})
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_RECORD_PRICES') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    recordPricesBatch(msg.accountId, msg.items || [])
      .then((summaries) => sendResponse({ ok: true, summaries }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_SCAN_STORES_LIVE') {
    if (!isTrustedExternalStoreSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    scanStoresInBackgroundTabs(msg.payload || {})
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_COMPARE_STORE_PRODUCT') {
    if (!isTrustedExternalStoreSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    findLocalComparisonsForStoreProduct(msg.payload || {})
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_RECORD_EXTERNAL_STORE_OFFERS') {
    if (!isTrustedExternalStoreSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    recordExternalStoreOffers(msg.store || 'Магнит', msg.offers || [])
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_REJECT_COMPETITOR_MATCH') {
    if (!isTrustedExternalStoreSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    rejectCompetitorMatch(msg.payload || msg)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_PRICE_INTEL') {
    if (!isTrustedExternalStoreSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    getProductPriceIntelligence(
      msg.slug,
      msg.title,
      msg.price,
      msg.oldPrice,
      msg.amount,
      msg.accountId,
      Boolean(msg.isFromProductCard),
      msg.imageKey || null,
      msg.brand || ''
    )
      .then((summary) => sendResponse({ ok: Boolean(summary), summary }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_AUDIT_CART_COMPETITORS') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    auditCartCompetitorsAndAccounts(msg.accountId, msg.items || [], Boolean(msg.forceNetworkSearch))
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_SAVE_CART_SNAPSHOT') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    saveCartSnapshot(msg.accountId, msg.items || [], msg.totalPrice || 0)
      .then((snapshot) => sendResponse({ ok: true, snapshot }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_SAVED_CARTS') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    getSavedCartsState()
      .then((state) => sendResponse({ ok: true, ...state }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_COMPARE_CART_PRICES') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    compareSavedCartOnCurrentAccount(msg.accountId)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_AUTO_BUILD_CART') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    autoBuildCartInBrowser(msg.items || null)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_ACCOUNT_SECRET_FOR_POPUP') {
    if (!isPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Доступ к секретам сейфа разрешён только из popup расширения.' });
      return true;
    }
    (async () => {
      const settings = await getSettings();
      const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
      const secrets = await fetchBackendAccountSecrets(backendUrl, msg.accountId);
      if (!secrets) {
        return { ok: false, error: 'Не удалось получить секрет с локального сервера (:8765).' };
      }
      return { ok: true, password: secrets.password || '' };
    })()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_RADAR_STATUS') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    getRadar16StoresStatus()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_RESET_CIRCUIT_BREAKER') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    resetCircuitBreakers()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_FETCH_AI_MODELS') {
    if (!isPopupSender(sender)) {
      sendResponse({ ok: false, models: [], error: 'Forbidden' });
      return true;
    }
    fetchAiModelsList(msg.aiBaseUrl, msg.aiApiKey, msg.aiProvider || '')
      .then((models) => sendResponse({ ok: true, models }))
      .catch((err) => sendResponse({ ok: false, models: [], error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_TEST_AI_PROVIDER') {
    if (!isPopupSender(sender)) {
      sendResponse({ ok: false, models: [], error: 'Forbidden' });
      return true;
    }
    testAiProviderWithVault({
      aiProvider: msg.aiProvider || '',
      aiBaseUrl: msg.aiBaseUrl || '',
      aiApiKey: msg.aiApiKey || ''
    })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, models: [], error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_SAVE_AI_KEY') {
    if (!isPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    saveAiKeySecurely(msg.aiProvider || '', msg.aiApiKey || '')
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_START_LOCAL_SERVER') {
    if (!isPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    startLocalServerViaNativeHost({ force: Boolean(msg.force) })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_AI_KEY_STATUS') {
    if (!isPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    getAiKeyVaultStatus(msg.aiProvider || '')
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_DELETE_AI_KEY') {
    if (!isPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    deleteAiKeySecurely(msg.aiProvider || '')
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_AI_USAGE_STATS') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    getAiUsageStatsWithLimit()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_SET_BACKEND_TOKEN') {
    if (!isPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    saveStoredBackendToken(msg.token || '')
      .then((tok) => sendResponse({ ok: true, hasToken: Boolean(tok) }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_ACCOUNTS_VAULT') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    getAccountsVaultStatus()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_SAVE_ACCOUNT_TO_VAULT') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    saveAccountToVault(msg.payload || {})
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_DELETE_ACCOUNT_FROM_VAULT') {
    if (!isPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    deleteAccountFromVault(msg.accountId)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_SWITCH_LAVKA_ACCOUNT') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    switchLavkaAccountInOneClick(msg.payload || {})
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_LOGOUT_CLEAN_LAVKA_SESSION') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    logoutToCleanLavkaSession()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_AUTOFILL_YANDEX_LOGIN') {
    if (!isPassportOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    autofillYandexPassportTab(msg.accountId)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_CACHED_AI_VERDICT') {
    if (!isTrustedExternalStoreSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    getLocalAiCacheEntry(msg.slug, msg.title, msg.imageKey || null)
      .then((entry) => sendResponse({ ok: Boolean(entry), entry: entry || null }))
      .catch(() => sendResponse({ ok: false, entry: null }));
    return true;
  }

  if (msg.type === 'LQS_CLEAR_AI_CACHE') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    clearLocalAiCache()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_WARMUP_AUTOPILOT') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    ensureAutopilotWarmup('content-script-boot')
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'LQS_CHECK_AI_STATUS') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    checkAllConnections()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_SELECT_GEMINI_ACCOUNT') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    (async () => {
      try {
        const patch = {
          geminiAccountIndex: msg.accountIndex ?? 'auto',
          preferredGeminiTabId: msg.preferredTabId ? Number(msg.preferredTabId) : null
        };
        await saveSettingsPatch(patch);
        let tab = null;
        if (msg.openOrFocusTab) {
          if (patch.preferredGeminiTabId) {
            tab = await chrome.tabs
              .update(patch.preferredGeminiTabId, { active: Boolean(msg.makeActive) })
              .catch(() => null);
          } else {
            const targetUrl = buildGeminiUrlForAccount(patch.geminiAccountIndex);
            const existing = await findOpenGeminiTab(false, Boolean(msg.makeActive));
            tab = existing || (await createGeminiTab(targetUrl, Boolean(msg.makeActive)));
          }
        }
        const status = await checkAllConnections();
        sendResponse({ ok: true, tab, status });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (msg.type === 'LQS_AUTO_CONNECT_GEMINI_TAB') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    (async () => {
      try {
        if (msg.accountIndex !== undefined || msg.preferredTabId !== undefined) {
          await saveSettingsPatch({
            geminiAccountIndex: msg.accountIndex ?? 'auto',
            preferredGeminiTabId: msg.preferredTabId ? Number(msg.preferredTabId) : null
          });
        }
        const existingTab = await findOpenGeminiTab(false, false);
        const tab = existingTab || (await findOpenGeminiTab(true, false));
        const email = tab && tab.id ? await detectTabAccountEmail(tab.id) : null;
        const cookies = await inspectGeminiCookies();
        const status = await checkAllConnections();
        sendResponse({
          ok: Boolean(tab),
          wasAlreadyOpen: Boolean(existingTab),
          tabOpened: Boolean(tab),
          tabId: tab ? tab.id : null,
          accountIndex: tab ? extractAccountIndexFromUrl(tab.url) : '0',
          email: email || null,
          cookiesOk: cookies.ok,
          cookiesCount: cookies.cookiesCount,
          status
        });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err.message || String(err)
        });
      }
    })();
    return true;
  }

  if (msg.type === 'LQS_GET_GEMINI_COOKIE_HEADER') {
    if (!isPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Доступ к куки Google разрешён только из popup расширения.' });
      return true;
    }
    inspectGeminiCookies()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_PRICE_HISTORY') {
    if (!isTrustedExternalStoreSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    getProductPriceHistory(msg.slug, msg.title || '', msg.days ?? 90, msg.accountId || null)
      .then((data) => sendResponse({ ok: Boolean(data), data }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_TOGGLE_WATCHLIST') {
    if (!isTrustedExternalStoreSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    toggleWatchlistItem({
      slug: msg.slug,
      title: msg.title || '',
      amount: msg.amount || '',
      price: msg.price || null,
      targetPrice: msg.targetPrice || null,
      watch: msg.watch
    })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_WATCHLIST') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    getWatchlistItems()
      .then((items) => sendResponse({ ok: true, items }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_CHECK_WATCHLIST_NOW') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    checkWatchlistPricesBatch({ maxItems: msg.maxItems || 15 })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_BG_DIAGNOSTICS') {
    if (!isPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    (async () => {
      const [settings, priceDb, extOffers, radarStatus, rawExtra] = await Promise.all([
        getSettings(),
        getLocalPriceDb(),
        getExternalStoreOffersList(),
        getRadar16StoresStatus(),
        new Promise((resolve) => {
          chrome.storage.local.get(
            [STORAGE_KEYS.REJECTED_MATCHES || 'lqs_rejected_matches_v1', STORAGE_KEYS.PRODUCT_LINKS || 'lqs_product_links_v1'],
            (res) => resolve(res || {})
          );
        })
      ]);
      const liveExtOffers = extOffers.filter((o) => o && !o.isSeedFallback);
      const extByStore = {};
      for (const o of liveExtOffers) {
        const st = o.store || 'Unknown';
        extByStore[st] = (extByStore[st] || 0) + 1;
      }
      const rejectedMap = rawExtra[STORAGE_KEYS.REJECTED_MATCHES || 'lqs_rejected_matches_v1'] || {};
      const linksMap = rawExtra[STORAGE_KEYS.PRODUCT_LINKS || 'lqs_product_links_v1'] || {};

      let backendHealth = { online: false, statusText: 'OFFLINE (не отвечает)' };
      const backendUrl = (settings.backendUrl || 'http://127.0.0.1:8765').replace(/\/$/, '');
      try {
        const r = await fetchWithTimeout(`${backendUrl}/api/health`, { method: 'GET' }, 1200);
        if (r && r.ok) {
          const j = await r.json();
          backendHealth = {
            online: true,
            statusText: `ONLINE v${j.version || '?'} (schema v${j.schemaVersion || '?'})`
          };
        } else {
          backendHealth = { online: false, statusText: `HTTP ${r?.status || 'ERR'}` };
        }
      } catch (err) {
        backendHealth = { online: false, statusText: `OFFLINE (${err?.message || 'timeout'})` };
      }

      return {
        ok: true,
        localPriceDbCount: Object.keys(priceDb || {}).length,
        localExtOffersCount: liveExtOffers.length,
        seedOffersCount: extOffers.length - liveExtOffers.length,
        extByStore,
        rejectedProductsCount: Object.keys(rejectedMap || {}).length,
        rememberedLinksProductsCount: Object.keys(linksMap || {}).length,
        providers: radarStatus?.providers || [],
        backendHealth
      };
    })()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  return false;
});
