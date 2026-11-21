const { STORAGE_KEYS } = globalThis.LQS_CONFIG;
const { escapeHtml, fetchWithTimeout, saveSettingsPatch } = globalThis.LQS_UTILS;
const STORAGE_KEY = STORAGE_KEYS.REVIEWS;
const SETTINGS_KEY = STORAGE_KEYS.SETTINGS;
const FLIGHT_LOG_KEY = STORAGE_KEYS.FLIGHT_LOG;
const BACKEND_TOKEN_KEY = STORAGE_KEYS.BACKEND_TOKEN || 'lqs_backend_token_v1';
const TOKEN_HEADER_NAME = globalThis.LQS_CONFIG.TOKEN_HEADER_NAME || 'X-LQS-Token';

async function getPopupBackendHeaders() {
  const token = await new Promise((resolve) => {
    chrome.storage.local.get([BACKEND_TOKEN_KEY], (res) => {
      resolve(typeof res?.[BACKEND_TOKEN_KEY] === 'string' ? res[BACKEND_TOKEN_KEY].trim() : '');
    });
  });
  const headers = { 'X-LQS-Client': 'lavka-quality-shield' };
  if (token) headers[TOKEN_HEADER_NAME] = token;
  return headers;
}
const PRICE_DB_KEY = STORAGE_KEYS.PRICE_DB;
const WATCHLIST_KEY = STORAGE_KEYS.WATCHLIST;

const DEFAULT_SETTINGS = { ...globalThis.LQS_CONFIG.DEFAULT_SETTINGS };
const POPUP_AI_SETTINGS = globalThis.LQS_POPUP_AI_SETTINGS;

let currentFilter = 'all';
let searchQuery = '';
let currentPriceFilter = 'all';
let priceSearchQuery = '';
let lastBackendPingSummary = null;
let vaultAccountsCache = [];

// ==========================================================================
// ВКЛАДКА 1: ОТЗЫВЫ
// ==========================================================================
function loadReviews() {
  chrome.storage.local.get([STORAGE_KEY], (res) => {
    const db = res[STORAGE_KEY] || {};
    const items = Object.values(db).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    const godCount = items.filter((item) => item.rating >= 4 && !item.banned).length;
    const trashCount = items.filter((item) => item.banned || (item.rating > 0 && item.rating <= 2)).length;

    document.getElementById('count-all').textContent = items.length;
    document.getElementById('count-god').textContent = godCount;
    document.getElementById('count-trash').textContent = trashCount;

    const listEl = document.getElementById('reviews-list');
    listEl.innerHTML = '';

    const q = searchQuery.trim().toLowerCase();
    const filtered = items.filter((item) => {
      if (currentFilter === 'god' && !(item.rating >= 4 && !item.banned)) return false;
      if (currentFilter === 'trash' && !(item.banned || (item.rating > 0 && item.rating <= 2))) return false;
      if (q) {
        const hay = `${item.title || ''} ${item.slug || ''} ${item.note || ''} ${(item.tags || []).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      listEl.innerHTML = '<div style="color:#7a7875;text-align:center;padding:18px;font-size:12px;">Список пуст. Поставь оценку любому товару в Лавке!</div>';
      return;
    }

    filtered.forEach((item) => {
      const div = document.createElement('div');
      div.className = 'item';
      const badge = item.banned || item.rating <= 2 ? `💀 ${item.rating || 1}★` : `⭐ ${item.rating}★`;
      const safeSlug = encodeURIComponent(item.slug || '');
      const safeTitle = escapeHtml(item.title || item.slug || 'Товар');
      const noteOrTags = item.note || (item.tags || []).join(', ') || 'Без комментария';

      div.innerHTML = `
        <div class="item-header">
          <a href="https://lavka.yandex.ru/good/${safeSlug}" target="_blank" rel="noopener noreferrer">${item.isWatched ? '❤️ ' : ''}${safeTitle}</a>
          <span class="item-right">
            <span>${escapeHtml(badge)}</span>
            <button type="button" class="item-del-btn" data-slug="${escapeHtml(item.slug || '')}" title="Удалить запись">×</button>
          </span>
        </div>
        <div class="item-note">${escapeHtml(noteOrTags)}</div>
      `;

      const delBtn = div.querySelector('.item-del-btn');
      if (delBtn) {
        delBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const targetSlug = delBtn.getAttribute('data-slug');
          if (!targetSlug) return;
          delete db[targetSlug];
          chrome.storage.local.set({ [STORAGE_KEY]: db }, loadReviews);
        });
      }

      listEl.appendChild(div);
    });
  });
}

// ==========================================================================
// ВКЛАДКА 2: МЕНЕДЖЕР АККАУНТОВ (КУКИ + ПАРОЛИ), КЛОНЕР КОРЗИНЫ И БАЗА ЦЕН
// ==========================================================================
function showAccountStatusMsg(html, isError = false) {
  const box = document.getElementById('account-status-msg');
  if (!box) return;
  box.style.display = 'block';
  box.style.color = isError ? '#b91c1c' : '#15803d';
  box.innerHTML = html;
}

function getSelectedVaultAccountObj() {
  const sel = document.getElementById('lavka-account-select');
  const val = sel ? sel.value : '';
  return vaultAccountsCache.find((a) => a.label === val || a.accountId === val) || null;
}

function syncSelectedAccountFields() {
  const acc = getSelectedVaultAccountObj();
  const metaEl = document.getElementById('selected-account-meta');
  if (!acc) {
    if (metaEl) metaEl.textContent = 'Профиль ещё не сохранён в сейфе.';
    return;
  }

  document.getElementById('acc-label-input').value = acc.label || '';
  document.getElementById('acc-login-input').value = acc.login || acc.yandexLogin || '';
  const passInp = document.getElementById('acc-password-input');
  passInp.value = '';
  passInp.placeholder = acc.hasPassword
    ? '🔒 Пароль в DPAPI-сейфе (введите новый для замены)'
    : 'Пароль от аккаунта';
  document.getElementById('acc-note-input').value = acc.note || '';

  const cookieInfo = acc.cookieCount > 0 ? `🍪 Сохранено куки: <b>${acc.cookieCount}</b>` : '⚪ Куки ещё не сохранены';
  const loginInfo = acc.login || acc.yandexLogin ? ` • 🔑 Логин: <b>${escapeHtml(acc.login || acc.yandexLogin)}</b>` : '';
  const passInfo = acc.hasPassword ? ' • 🔒 Пароль в DPAPI-сейфе' : '';
  if (metaEl) {
    metaEl.innerHTML = `${cookieInfo}${loginInfo}${passInfo}`;
  }
}

function renderAccountsVaultUI(vaultResp) {
  if (!vaultResp || !vaultResp.ok) return;
  vaultAccountsCache = Array.isArray(vaultResp.accounts) ? vaultResp.accounts : [];

  const liveBadge = document.getElementById('live-cookie-badge');
  if (liveBadge && vaultResp.liveSession) {
    const ls = vaultResp.liveSession;
    liveBadge.textContent = ls.isLoggedIn
      ? `🟢 Вход: ${ls.yandexLogin || 'активен'} (${ls.cookieCount} куки)`
      : `⚪ Гость (${ls.cookieCount} куки)`;
  }

  const sel = document.getElementById('lavka-account-select');
  if (sel && vaultAccountsCache.length > 0) {
    const prevVal = vaultResp.activeAccountLabel || sel.value;
    sel.innerHTML = '';
    vaultAccountsCache.forEach((a) => {
      const opt = document.createElement('option');
      opt.value = a.label;
      opt.dataset.accountId = a.accountId;
      const cTag = a.cookieCount > 0 ? ` [🍪${a.cookieCount}]` : '';
      const lTag = a.login || a.yandexLogin ? ` (${a.login || a.yandexLogin})` : '';
      opt.textContent = `${a.label}${cTag}${lTag}`;
      sel.appendChild(opt);
    });
    if (Array.from(sel.options).some((o) => o.value === prevVal)) {
      sel.value = prevVal;
    }
  }

  syncSelectedAccountFields();
}

function loadAccountsVault() {
  chrome.runtime.sendMessage({ type: 'LQS_GET_ACCOUNTS_VAULT' }, (resp) => {
    if (!chrome.runtime.lastError && resp && resp.ok) {
      renderAccountsVaultUI(resp);
    }
  });
}

document.getElementById('lavka-account-select').addEventListener('change', (e) => {
  const newLabel = e.target.value;
  saveSettingsPatch({ lavkaAccountLabel: newLabel }, () => {
    syncSelectedAccountFields();
  });
});

document.getElementById('toggle-creds-btn').addEventListener('click', () => {
  const box = document.getElementById('account-creds-box');
  box.classList.toggle('open');
  syncSelectedAccountFields();
});

document.getElementById('add-account-btn').addEventListener('click', () => {
  const nextNum = vaultAccountsCache.length + 1;
  const newLabel = `Аккаунт #${nextNum} (Новый)`;
  chrome.runtime.sendMessage(
    {
      type: 'LQS_SAVE_ACCOUNT_TO_VAULT',
      payload: {
        accountId: `acc_${Date.now()}`,
        label: newLabel,
        login: '',
        password: '',
        note: '',
        captureCookies: false
      }
    },
    (resp) => {
      if (resp && resp.vaultStatus) {
        renderAccountsVaultUI(resp.vaultStatus);
        document.getElementById('account-creds-box').classList.add('open');
        showAccountStatusMsg(`✅ Создан профиль «${escapeHtml(newLabel)}». Заполни логин/пароль или сохрани куки!`);
      }
    }
  );
});

document.getElementById('save-cookies-btn').addEventListener('click', () => {
  const acc = getSelectedVaultAccountObj();
  const label = document.getElementById('lavka-account-select').value;
  const btn = document.getElementById('save-cookies-btn');
  btn.textContent = '⏳...';

  chrome.runtime.sendMessage(
    {
      type: 'LQS_SAVE_ACCOUNT_TO_VAULT',
      payload: {
        accountId: acc ? acc.accountId : undefined,
        label,
        captureCookies: true
      }
    },
    (resp) => {
      btn.textContent = '💾 Запомнить куки';
      if (resp && resp.ok) {
        renderAccountsVaultUI(resp.vaultStatus);
        showAccountStatusMsg(`✅ Куки и сессия сохранены в «${escapeHtml(label)}»!`);
      }
    }
  );
});

document.getElementById('switch-account-btn').addEventListener('click', () => {
  const acc = getSelectedVaultAccountObj();
  const label = document.getElementById('lavka-account-select').value;
  const btn = document.getElementById('switch-account-btn');
  btn.textContent = '⏳ Переключаю...';

  chrome.runtime.sendMessage(
    {
      type: 'LQS_SWITCH_LAVKA_ACCOUNT',
      payload: {
        accountId: acc ? acc.accountId : undefined,
        label,
        autoBackupCurrent: true,
        buildCartAfterSwitch: false
      }
    },
    (resp) => {
      btn.textContent = '⚡ Переключить вход (1 клик)';
      if (!resp || !resp.ok) {
        showAccountStatusMsg(`⚠️ ${escapeHtml(resp?.error || 'Не удалось переключить профиль')}`, true);
        return;
      }
      if (resp.vaultStatus) renderAccountsVaultUI(resp.vaultStatus);
      if (resp.switchedCookies) {
        showAccountStatusMsg(`✅ Сессия переключена на «${escapeHtml(resp.switchedTo)}» (восстановлено ${resp.restoredCount} куки)!`);
      } else if (resp.autofillTriggered) {
        showAccountStatusMsg(`🔑 Куки ещё не сохранялись — открыт Яндекс Паспорт и введён логин/пароль для «${escapeHtml(resp.switchedTo)}»!`);
      } else {
        showAccountStatusMsg(`ℹ️ Выбран профиль «${escapeHtml(resp.switchedTo)}». Войди на сайте и нажми «💾 Запомнить куки»!`);
      }
    }
  );
});

document.getElementById('clean-logout-btn').addEventListener('click', () => {
  const btn = document.getElementById('clean-logout-btn');
  btn.textContent = '⏳...';
  chrome.runtime.sendMessage({ type: 'LQS_LOGOUT_CLEAN_LAVKA_SESSION' }, (resp) => {
    btn.textContent = '🧹 Выйти';
    if (resp && resp.vaultStatus) renderAccountsVaultUI(resp.vaultStatus);
    showAccountStatusMsg('✅ Текущие куки сохранены в сейф, сессия в браузере очищена (чистый Гость / вход в новый акк)!');
  });
});

document.getElementById('save-creds-btn').addEventListener('click', () => {
  const acc = getSelectedVaultAccountObj();
  const label = document.getElementById('acc-label-input').value.trim() || document.getElementById('lavka-account-select').value;
  const login = document.getElementById('acc-login-input').value.trim();
  const rawPassword = document.getElementById('acc-password-input').value;
  const note = document.getElementById('acc-note-input').value.trim();

  chrome.runtime.sendMessage(
    {
      type: 'LQS_SAVE_ACCOUNT_TO_VAULT',
      payload: {
        accountId: acc ? acc.accountId : undefined,
        label,
        login,
        password: rawPassword ? rawPassword : undefined,
        note,
        captureCookies: true
      }
    },
    (resp) => {
      if (resp && resp.vaultStatus) renderAccountsVaultUI(resp.vaultStatus);
      if (resp && resp.ok) {
        document.getElementById('acc-password-input').value = '';
        showAccountStatusMsg(`✅ Профиль «${escapeHtml(label)}» сохранён в DPAPI-сейф!`);
      } else {
        showAccountStatusMsg(`⚠️ ${escapeHtml(resp?.error || 'Не удалось сохранить профиль')}`, true);
      }
    }
  );
});

document.getElementById('autofill-passport-btn').addEventListener('click', () => {
  const acc = getSelectedVaultAccountObj();
  if (!acc) return;
  // Сначала сохраним введённые поля, если пользователь их только что вписал
  const login = document.getElementById('acc-login-input').value.trim();
  const rawPassword = document.getElementById('acc-password-input').value;
  chrome.runtime.sendMessage(
    {
      type: 'LQS_SAVE_ACCOUNT_TO_VAULT',
      payload: {
        accountId: acc.accountId,
        label: document.getElementById('acc-label-input').value.trim() || acc.label,
        login,
        password: rawPassword ? rawPassword : undefined,
        note: document.getElementById('acc-note-input').value.trim(),
        captureCookies: false
      }
    },
    () => {
      chrome.runtime.sendMessage({ type: 'LQS_AUTOFILL_YANDEX_LOGIN', accountId: acc.accountId }, (r) => {
        if (r && r.ok) {
          showAccountStatusMsg(`🔑 Открыт Яндекс ID и введены данные для «${escapeHtml(acc.label)}»!`);
        } else {
          showAccountStatusMsg(`⚠️ ${escapeHtml(r?.error || 'Укажи логин и пароль')}`, true);
        }
      });
    }
  );
});

document.getElementById('delete-acc-btn').addEventListener('click', () => {
  const acc = getSelectedVaultAccountObj();
  if (!acc) return;
  if (vaultAccountsCache.length <= 1) {
    showAccountStatusMsg('⚠️ Нельзя удалить единственный профиль.', true);
    return;
  }
  chrome.runtime.sendMessage({ type: 'LQS_DELETE_ACCOUNT_FROM_VAULT', accountId: acc.accountId }, (resp) => {
    if (resp && resp.ok) {
      renderAccountsVaultUI(resp);
      showAccountStatusMsg(`🗑️ Профиль «${escapeHtml(acc.label)}» удалён.`);
    }
  });
});

document.getElementById('toggle-pass-vis-btn').addEventListener('click', () => {
  const inp = document.getElementById('acc-password-input');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});

document.getElementById('copy-login-btn').addEventListener('click', async () => {
  const val = document.getElementById('acc-login-input').value;
  if (val) {
    await navigator.clipboard.writeText(val);
    showAccountStatusMsg('📋 Логин скопирован в буфер обмена!');
  }
});

document.getElementById('copy-pass-btn').addEventListener('click', async () => {
  const typedVal = document.getElementById('acc-password-input').value;
  if (typedVal) {
    await navigator.clipboard.writeText(typedVal);
    showAccountStatusMsg('📋 Пароль скопирован в буфер обмена!');
    return;
  }
  const acc = getSelectedVaultAccountObj();
  if (!acc || !acc.hasPassword) {
    showAccountStatusMsg('⚠️ Пароль для этого профиля не задан.', true);
    return;
  }
  chrome.runtime.sendMessage({ type: 'LQS_GET_ACCOUNT_SECRET_FOR_POPUP', accountId: acc.accountId }, async (resp) => {
    if (resp && resp.ok && resp.password) {
      await navigator.clipboard.writeText(resp.password);
      showAccountStatusMsg('📋 Пароль из DPAPI-сейфа скопирован в буфер обмена!');
    } else {
      showAccountStatusMsg(`⚠️ ${escapeHtml(resp?.error || 'Не удалось получить пароль с сервера :8765')}`, true);
    }
  });
});

function hasPriceDiscrepancy(entry) {
  if (!entry) return false;
  if (entry.minPrice && entry.maxPrice && entry.maxPrice - entry.minPrice >= 3) return true;
  return false;
}

function loadPricesAndCartTab() {
  loadAccountsVault();

  // 1. Загружаем сохранённый слепок корзины
  chrome.runtime.sendMessage({ type: 'LQS_GET_SAVED_CARTS' }, (resp) => {
    const badgeEl = document.getElementById('saved-cart-badge');
    const sumEl = document.getElementById('saved-cart-summary');
    if (resp && resp.latest && Array.isArray(resp.latest.items) && resp.latest.items.length > 0) {
      const lat = resp.latest;
      const totalUnits = lat.totalUnits || lat.items.reduce((s, i) => s + (Number(i.qty) || 1), 0);
      badgeEl.textContent = `✅ ${lat.items.length} поз. / ${totalUnits} шт. (${lat.totalPrice} ₽)`;
      const names = lat.items.slice(0, 4).map((i) => `${escapeHtml(i.title.slice(0, 22))} (${i.qty} шт × ${i.price}₽)`).join(', ');
      sumEl.innerHTML =
        `Сохранена с профиля <b>${escapeHtml(lat.accountId)}</b> (позиций: <b>${lat.items.length}</b>, штук: <b>${totalUnits}</b>, сумма: <b>${lat.totalPrice} ₽</b>):<br>` +
        `<span style="color:#57534e;">${names}${lat.items.length > 4 ? ` и ещё ${lat.items.length - 4}...` : ''}</span>`;
    } else {
      badgeEl.textContent = 'Пока пусто';
      sumEl.textContent = 'Открой корзину в Лавке или нажми «📸 Снять слепок корзины», чтобы сравнить или перенести её на другой аккаунт.';
    }
  });

  // 2. Загружаем базу цен (из локального хранилища + синхронизируем с :8765 если запущен)
  chrome.storage.local.get([PRICE_DB_KEY, WATCHLIST_KEY, SETTINGS_KEY], async (res) => {
    const localDb = { ...(res[PRICE_DB_KEY] || {}) };
    const watchlistMap = { ...(res[WATCHLIST_KEY] || {}) };
    const cfg = { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}) };

    try {
      const r = await fetchWithTimeout(`${cfg.backendUrl.replace(/\/$/, '')}/api/price/list?limit=300`, { method: 'GET', headers: await getPopupBackendHeaders() }, 1200);
      if (r.ok) {
        const j = await r.json();
        if (j && Array.isArray(j.items)) {
          j.items.forEach((it) => {
            if (it && it.slug) localDb[it.slug] = { ...(localDb[it.slug] || {}), ...it };
          });
        }
      }
    } catch {
      // backend offline
    }

    const allItems = Object.values(localDb).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    const diffCount = allItems.filter(hasPriceDiscrepancy).length;

    document.getElementById('price-count-total').textContent = allItems.length;
    document.getElementById('price-count-over').textContent = diffCount;

    const listEl = document.getElementById('prices-list');
    listEl.innerHTML = '';

    const q = priceSearchQuery.trim().toLowerCase();
    const filtered = allItems.filter((item) => {
      const isWatched = Boolean(item.isWatched || watchlistMap[item.slug]);
      if (currentPriceFilter === 'watched' && !isWatched) return false;
      if (currentPriceFilter === 'diff' && !hasPriceDiscrepancy(item)) return false;
      if (q) {
        const hay = `${item.title || ''} ${item.slug || ''} ${item.competitorSummary || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      listEl.innerHTML = '<div style="color:#7a7875;text-align:center;padding:14px;font-size:11.5px;">База цен наполняется автоматически, когда ты листаешь каталог или открываешь товары Лавки.</div>';
      return;
    }

    filtered.slice(0, 80).forEach((item) => {
      const div = document.createElement('div');
      div.className = 'item';
      const safeSlug = encodeURIComponent(item.slug || '');
      const safeTitle = escapeHtml(item.title || item.slug);
      const isWatched = Boolean(item.isWatched || watchlistMap[item.slug]);
      const accEntries = item.accounts ? Object.entries(item.accounts).filter(([k]) => k !== 'Гость (без куки)') : [];
      const accSummary = accEntries.map(([k, v]) => `${escapeHtml(k)}: <b>${v.price} ₽</b>`).join(' | ');
      const spread = (item.maxPrice && item.minPrice && item.maxPrice > item.minPrice)
        ? `<span style="color:#b91c1c;font-weight:700;">Δ ${Math.round(item.maxPrice - item.minPrice)} ₽</span>`
        : `<span style="color:#15803d;">${item.lastPrice || item.minPrice || '?'} ₽</span>`;

      div.innerHTML = `
        <div class="item-header">
          <a href="https://lavka.yandex.ru/good/${safeSlug}" target="_blank" rel="noopener noreferrer">${safeTitle}</a>
          <span class="item-right">${spread}</span>
        </div>
        <div class="item-note">
          Мин: <b>${item.minPrice ?? '?'} ₽</b> • Макс: <b>${item.maxPrice ?? '?'} ₽</b>
          ${accSummary ? `<br>${accSummary}` : ''}
          ${item.competitorSummary ? `<br>🏪 Сети: ${escapeHtml(item.competitorSummary)}` : ''}
        </div>
      `;
      listEl.appendChild(div);
    });
  });
}

document.getElementById('capture-cart-btn').addEventListener('click', () => {
  const btn = document.getElementById('capture-cart-btn');
  const acc = document.getElementById('lavka-account-select').value;
  btn.textContent = '⏳ Снимаю...';

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs && tabs[0];
    if (!activeTab || !activeTab.url || !activeTab.url.includes('lavka.yandex.ru')) {
      btn.textContent = '⚠️ Открой Лавку';
      setTimeout(() => { btn.textContent = '📸 Снять слепок корзины'; }, 2000);
      return;
    }
    chrome.tabs.sendMessage(activeTab.id, { type: 'LQS_EXTRACT_CURRENT_CART_FROM_PAGE' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !Array.isArray(resp.items) || resp.items.length === 0) {
        btn.textContent = '⚠️ Открой /cart';
        setTimeout(() => { btn.textContent = '📸 Снять слепок корзины'; }, 2200);
        return;
      }
      chrome.runtime.sendMessage(
        {
          type: 'LQS_SAVE_CART_SNAPSHOT',
          accountId: acc,
          items: resp.items,
          totalPrice: resp.totalPrice
        },
        () => {
          const units = resp.totalUnits || resp.items.reduce((s, i) => s + (Number(i.qty) || 1), 0);
          btn.textContent = `✅ Снято (${resp.items.length} поз. / ${units} шт.)`;
          loadPricesAndCartTab();
          setTimeout(() => { btn.textContent = '📸 Снять слепок корзины'; }, 2200);
        }
      );
    });
  });
});

document.getElementById('compare-cart-btn').addEventListener('click', () => {
  const btn = document.getElementById('compare-cart-btn');
  const out = document.getElementById('cart-compare-output');
  const acc = document.getElementById('lavka-account-select').value;
  btn.textContent = '⏳ Сверяю...';
  out.style.display = 'block';
  out.textContent = 'Запрашиваю живые цены всех товаров корзины на текущем аккаунте и без куки...';

  chrome.runtime.sendMessage({ type: 'LQS_COMPARE_CART_PRICES', accountId: acc }, (resp) => {
    btn.textContent = '⚖️ Сверить цены здесь';
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      out.innerHTML = `⚠️ ${escapeHtml(resp?.error || 'Не удалось сверить корзину')}`;
      return;
    }

    const diff = resp.diffTotal;
    const diffBadge =
      diff < 0
        ? `<span style="color:#15803d;font-weight:800;">🎉 Здесь ВЫГОДНЕЕ на ${Math.abs(diff)} ₽!</span>`
        : diff > 0
        ? `<span style="color:#dc2626;font-weight:800;">⚠️ Здесь ДОРОЖЕ на +${diff} ₽!</span>`
        : `<span style="color:#475569;font-weight:700;">Цены одинаковые (0 ₽ разницы)</span>`;

    const rowsHtml = resp.items
      .map((it) => {
        const d = it.diffTotal;
        const dStr = d < 0 ? `<b style="color:#15803d;">${d}₽</b>` : d > 0 ? `<b style="color:#dc2626;">+${d}₽</b>` : '0₽';
        return `<div style="border-bottom:1px solid #f0eee9;padding:3px 0;">
          <b>${escapeHtml(it.title.slice(0, 32))}</b> (${it.qty} шт):
          было ${it.sourcePrice}₽ -> тут <b>${it.currentPrice}₽</b> (${dStr})
        </div>`;
      })
      .join('');

    out.innerHTML = `
      <div style="margin-bottom:5px;">
        • <b>${escapeHtml(resp.sourceAccount)}:</b> ${resp.sourceTotal} ₽<br>
        • <b>${escapeHtml(resp.currentAccount)}:</b> ${resp.currentTotal} ₽<br>
        • Итог: ${diffBadge}
      </div>
      ${rowsHtml}
    `;
    loadPricesAndCartTab();
  });
});

document.getElementById('autobuild-cart-btn').addEventListener('click', () => {
  const btn = document.getElementById('autobuild-cart-btn');
  const out = document.getElementById('cart-compare-output');
  btn.textContent = '⏳ Собираю все позиции и штуки...';
  out.style.display = 'block';
  out.textContent = 'Авто-сборщик открывает товары из слепка, нажимает «В корзину» и выставляет точное количество штук («+»)...';

  chrome.runtime.sendMessage({ type: 'LQS_AUTO_BUILD_CART' }, (resp) => {
    btn.textContent = '🚀 Авто-собрать сохранённую корзину на этом аккаунте (1 клик)';
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      out.innerHTML = `⚠️ ${escapeHtml(resp?.error || 'Ошибка авто-сборки корзины')}`;
      return;
    }

    const detailsHtml = Array.isArray(resp.results)
      ? resp.results
          .map((r) => {
            const st = r.ok
              ? `<span style="color:#15803d;font-weight:700;">✅ ${r.addedUnits || r.qty}/${r.qty} шт.</span>`
              : `<span style="color:#dc2626;font-weight:700;">❌ ${escapeHtml(r.reason || 'Ошибка')}</span>`;
            return `<div style="border-bottom:1px solid #f0eee9;padding:2px 0;">${escapeHtml((r.title || r.slug).slice(0, 34))}: ${st}</div>`;
          })
          .join('')
      : '';

    out.innerHTML = `
      <div style="margin-bottom:5px;">
        ✅ <b>Готово!</b> Позиций: <b>${resp.addedCount} из ${resp.totalRequested}</b> |
        Всего единиц (штук): <b>${resp.totalAddedUnits ?? resp.addedCount} из ${resp.totalRequestedUnits ?? resp.totalRequested} шт.</b>
      </div>
      ${detailsHtml}
    `;
  });
});

document.getElementById('price-search-input').addEventListener('input', (e) => {
  priceSearchQuery = e.target.value || '';
  loadPricesAndCartTab();
});

document.querySelectorAll('[data-pfilter]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-pfilter]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentPriceFilter = btn.dataset.pfilter;
    loadPricesAndCartTab();
  });
});

// ==========================================================================
// ВКЛАДКА 3: НАСТРОЙКИ И АВТОПИЛОТ ИИ
// ==========================================================================
function loadSettings() {
  chrome.storage.local.get([SETTINGS_KEY, BACKEND_TOKEN_KEY], (res) => {
    const cfg = { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}) };

    document.getElementById('inp-backend').value = cfg.backendUrl;
    const tokEl = document.getElementById('inp-backend-token');
    if (tokEl) tokEl.value = typeof res?.[BACKEND_TOKEN_KEY] === 'string' ? res[BACKEND_TOKEN_KEY] : '';

    document.getElementById('chk-auto-run-ai').checked = cfg.autoRunAiOnProductPage !== false;
    document.getElementById('chk-auto-open-drawer').checked = cfg.autoOpenDrawerOnAi !== false;
    document.getElementById('chk-auto-warmup').checked = cfg.autoWarmupGeminiTab === true;
    const popChk = document.getElementById('chk-price-chart-popover');
    if (popChk) popChk.checked = Boolean(cfg.priceChartWindowMode);
    const wlSel = document.getElementById('sel-watchlist-interval');
    if (wlSel) wlSel.value = String(cfg.watchlistCheckIntervalHours ?? 6);
    const liveStores = Array.isArray(cfg.liveRadarStores) && cfg.liveRadarStores.length > 0 ? cfg.liveRadarStores : DEFAULT_SETTINGS.liveRadarStores;
    document.querySelectorAll('.chk-live-radar-store').forEach((chk) => {
      chk.checked = liveStores.includes(chk.value);
    });
    if (cfg.lavkaAccountLabel) {
      const sel = document.getElementById('lavka-account-select');
      if (sel && Array.from(sel.options).some((o) => o.value === cfg.lavkaAccountLabel)) {
        sel.value = cfg.lavkaAccountLabel;
      }
    }

    POPUP_AI_SETTINGS.applyLoadedAiSettings(cfg);
  });
}

['chk-auto-run-ai', 'chk-auto-open-drawer', 'chk-auto-warmup', 'chk-price-chart-popover', 'sel-watchlist-interval'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('change', () => {
      saveSettingsPatch({
        autoRunAiOnProductPage: document.getElementById('chk-auto-run-ai').checked,
        autoOpenDrawerOnAi: document.getElementById('chk-auto-open-drawer').checked,
        autoWarmupGeminiTab: document.getElementById('chk-auto-warmup').checked,
        priceChartWindowMode: Boolean(document.getElementById('chk-price-chart-popover')?.checked),
        watchlistCheckIntervalHours: Number(document.getElementById('sel-watchlist-interval')?.value ?? 6)
      });
    });
  }
});


function readSelectedLiveRadarStores() {
  const checked = Array.from(document.querySelectorAll('.chk-live-radar-store'))
    .filter((c) => c.checked)
    .map((c) => c.value);
  return checked.length > 0 ? checked.slice(0, 3) : ['kuper'];
}

document.querySelectorAll('.chk-live-radar-store').forEach((chk) => {
  chk.addEventListener('change', () => {
    const allChecked = Array.from(document.querySelectorAll('.chk-live-radar-store')).filter((c) => c.checked);
    if (allChecked.length > 3) {
      chk.checked = false;
      return;
    }
    saveSettingsPatch({ liveRadarStores: readSelectedLiveRadarStores() });
  });
});

const checkWatchlistNowBtn = document.getElementById('check-watchlist-now-btn');
if (checkWatchlistNowBtn) {
  checkWatchlistNowBtn.addEventListener('click', () => {
    checkWatchlistNowBtn.disabled = true;
    checkWatchlistNowBtn.textContent = '⏳...';
    chrome.runtime.sendMessage({ type: 'LQS_CHECK_WATCHLIST_NOW', maxItems: 15 }, (resp) => {
      checkWatchlistNowBtn.disabled = false;
      const upd = resp && resp.ok ? resp.updated : 0;
      checkWatchlistNowBtn.textContent = `✅ ${upd}`;
      loadPricesAndCartTab();
      setTimeout(() => {
        checkWatchlistNowBtn.textContent = '🔄 Проверить';
      }, 2200);
    });
  });
}

document.getElementById('clear-ai-cache-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'LQS_CLEAR_AI_CACHE' }, () => {
    refreshAiRadar();
  });
});

function setRadarPill(pillId, valId, isOk, isWarn, text, title = '') {
  const pill = document.getElementById(pillId);
  const val = document.getElementById(valId);
  if (!pill || !val) return;
  pill.className = 'radar-pill' + (isOk ? ' ok' : (isWarn ? ' warn' : ''));
  if (title) pill.title = title;
  val.textContent = text;
}

function populateAccountSelector(resp) {
  const sel = document.getElementById('gemini-account-select');
  if (!sel || !resp) return;
  const cfg = resp.settings || {};
  const openTabs = Array.isArray(resp.openGeminiTabs) ? resp.openGeminiTabs : [];

  Array.from(sel.querySelectorAll('option[data-dynamic-tab="true"]')).forEach((o) => o.remove());

  openTabs.forEach((t, idx) => {
    const opt = document.createElement('option');
    opt.value = `tab:${t.tabId}:${t.accountIndex}`;
    opt.dataset.dynamicTab = 'true';
    const labelEmail = t.email ? `${t.email} (/u/${t.accountIndex})` : `Вкладка /u/${t.accountIndex} (id:${t.tabId})`;
    opt.textContent = `🟢 Открыта #${idx + 1}: ${labelEmail}`;
    sel.insertBefore(opt, sel.firstChild);
  });

  if (cfg.preferredGeminiTabId) {
    const dynMatch = sel.querySelector(`option[value^="tab:${cfg.preferredGeminiTabId}:"]`);
    if (dynMatch) {
      sel.value = dynMatch.value;
      return;
    }
  }
  const targetVal = String(cfg.geminiAccountIndex ?? 'auto');
  if (sel.querySelector(`option[value="${targetVal}"]`)) {
    sel.value = targetVal;
  }
}

function getSelectedAccountChoice() {
  const sel = document.getElementById('gemini-account-select');
  const raw = sel ? sel.value : 'auto';
  if (raw.startsWith('tab:')) {
    const parts = raw.split(':');
    return {
      preferredTabId: Number(parts[1]) || null,
      accountIndex: parts[2] || '0'
    };
  }
  return {
    preferredTabId: null,
    accountIndex: raw
  };
}

function applyRadarResponse(resp) {
  if (!resp || !resp.ok) return;
  populateAccountSelector(resp);

  const cacheBadge = document.getElementById('ai-cache-badge');
  if (cacheBadge) {
    cacheBadge.textContent = `Кэш ИИ: ${resp.localAiCacheCount ?? 0} | Цен: ${resp.trackedPricesCount ?? 0}`;
  }

  const tabFound = Boolean(resp.geminiTab && resp.geminiTab.found);
  const accTag = resp.geminiTab && resp.geminiTab.email
    ? resp.geminiTab.email.split('@')[0]
    : (resp.geminiTab && resp.geminiTab.accountIndex !== null ? `/u/${resp.geminiTab.accountIndex}` : '');
  setRadarPill(
    'pill-gemini-tab',
    'val-gemini-tab',
    tabFound,
    !tabFound,
    tabFound ? `✅ ${accTag || 'Открыта'}` : '⚪ Авто-старт',
    tabFound ? `Подключена вкладка Gemini` : 'Откроется автоматически при заходе в Лавку'
  );

  const cookiesOk = Boolean(resp.cookies && resp.cookies.ok);
  setRadarPill(
    'pill-cookies',
    'val-cookies',
    cookiesOk,
    !cookiesOk,
    cookiesOk ? `✅ Активны (${resp.cookies.count})` : '⚠️ Не вошёл'
  );

  const bridgeOk = Boolean(resp.bridge && resp.bridge.ok);
  setRadarPill('pill-bridge', 'val-bridge', bridgeOk, false, bridgeOk ? '✅ Подключён' : '⚪ Выкл');

  const backendOk = Boolean(resp.backend && resp.backend.ok);
  setRadarPill(
    'pill-backend',
    'val-backend',
    backendOk,
    false,
    backendOk ? `✅ ОК (${resp.backend.trackedPrices || 0})` : '⚪ Локально'
  );
}

function refreshAiRadar() {
  if (!chrome.runtime || !chrome.runtime.sendMessage) return;
  chrome.runtime.sendMessage({ type: 'LQS_CHECK_AI_STATUS' }, (resp) => {
    if (!chrome.runtime.lastError && resp && resp.ok) {
      applyRadarResponse(resp);
    }
  });
}

document.getElementById('refresh-radar-btn').addEventListener('click', refreshAiRadar);

document.getElementById('gemini-account-select').addEventListener('change', () => {
  const choice = getSelectedAccountChoice();
  chrome.runtime.sendMessage(
    {
      type: 'LQS_SELECT_GEMINI_ACCOUNT',
      accountIndex: choice.accountIndex,
      preferredTabId: choice.preferredTabId,
      openOrFocusTab: false
    },
    (resp) => {
      if (resp && resp.status) applyRadarResponse(resp.status);
    }
  );
});

document.getElementById('open-selected-gemini-btn').addEventListener('click', () => {
  const choice = getSelectedAccountChoice();
  chrome.runtime.sendMessage(
    {
      type: 'LQS_SELECT_GEMINI_ACCOUNT',
      accountIndex: choice.accountIndex,
      preferredTabId: choice.preferredTabId,
      openOrFocusTab: true,
      makeActive: true
    },
    (resp) => {
      if (resp && resp.status) applyRadarResponse(resp.status);
    }
  );
});

document.getElementById('auto-connect-gemini-btn').addEventListener('click', () => {
  const btn = document.getElementById('auto-connect-gemini-btn');
  const statusBox = document.getElementById('autopilot-status-box');
  const choice = getSelectedAccountChoice();
  btn.textContent = '⏳ Прогреваю выбранный аккаунт Gemini...';
  statusBox.style.display = 'block';

  chrome.runtime.sendMessage(
    {
      type: 'LQS_AUTO_CONNECT_GEMINI_TAB',
      accountIndex: choice.accountIndex,
      preferredTabId: choice.preferredTabId
    },
    (resp) => {
      btn.textContent = '⚡ Проверить / прогреть выбранный Gemini сейчас';
      if (!resp) return;
      if (resp.status) applyRadarResponse(resp.status);
      if ((resp.cookiesOk || resp.email) && resp.tabOpened) {
        statusBox.innerHTML = `✅ <b>Zero-Click Автопилот готов!</b> Подключён аккаунт <b>${escapeHtml(resp.email || ('/u/' + (resp.accountIndex ?? '0')))}</b>.`;
      } else {
        statusBox.innerHTML = '⚠️ Войди в аккаунт на <code>gemini.google.com</code>!';
      }
    }
  );
});

document.getElementById('copy-gemini-cookies-btn').addEventListener('click', () => {
  const btn = document.getElementById('copy-gemini-cookies-btn');
  chrome.runtime.sendMessage({ type: 'LQS_GET_GEMINI_COOKIE_HEADER' }, async (resp) => {
    if (!resp || !resp.ok || !resp.headerString) return;
    await navigator.clipboard.writeText(resp.headerString);
    btn.textContent = `✅ Скопировано (${resp.cookiesCount} куки)!`;
    setTimeout(() => {
      btn.textContent = '🍪 Скопировать куки Gemini (Header String) без F12';
    }, 2500);
  });
});

function switchTab(activeId) {
  const map = {
    'tab-reviews-btn': 'panel-reviews',
    'tab-prices-btn': 'panel-prices',
    'tab-settings-btn': 'panel-settings'
  };
  Object.keys(map).forEach((btnId) => {
    document.getElementById(btnId).classList.toggle('active', btnId === activeId);
    document.getElementById(map[btnId]).style.display = btnId === activeId ? 'block' : 'none';
  });
  if (activeId === 'tab-prices-btn') {
    loadPricesAndCartTab();
  } else if (activeId === 'tab-settings-btn') {
    refreshAiRadar();
    POPUP_AI_SETTINGS.refreshAiUsageStats();
    POPUP_AI_SETTINGS.refreshAiKeyVaultStatus();
    refreshRadar16StoresStatus();
  }
}

document.getElementById('tab-reviews-btn').addEventListener('click', () => switchTab('tab-reviews-btn'));
document.getElementById('tab-prices-btn').addEventListener('click', () => switchTab('tab-prices-btn'));
document.getElementById('tab-settings-btn').addEventListener('click', () => switchTab('tab-settings-btn'));

document.getElementById('search-input').addEventListener('input', (e) => {
  searchQuery = e.target.value || '';
  loadReviews();
});

POPUP_AI_SETTINGS.bindAiSettingsEvents({
  readSelectedLiveRadarStores,
  refreshAiRadar
});

document.querySelectorAll('[data-filter]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-filter]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    loadReviews();
  });
});

document.getElementById('export-btn').addEventListener('click', () => {
  chrome.storage.local.get([STORAGE_KEY], (res) => {
    const blob = new Blob([JSON.stringify(res[STORAGE_KEY] || {}, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lavka-quality-shield-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  });
});

document.getElementById('import-btn').addEventListener('click', () => {
  document.getElementById('import-file').click();
});

document.getElementById('import-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      chrome.storage.local.set({ [STORAGE_KEY]: data }, loadReviews);
    } catch {
      alert('Ошибка чтения JSON файла');
    }
  };
  reader.readAsText(file);
});

// ==========================================================================
// БОРТОВОЙ ЖУРНАЛ ДЛЯ ИИ
// ==========================================================================
function renderModulePills(modules) {
  const container = document.getElementById('diag-module-pills');
  if (!container || !modules) return;
  const labels = {
    router: 'Роутер',
    parser: 'Парсер',
    calculator: 'КБЖУ/Цена',
    widget: 'Виджет',
    catalog: 'Каталог',
    cartGuard: 'Корзина',
    storage: 'База',
    aiReviewer: 'ИИ'
  };
  container.innerHTML = Object.keys(labels).map((key) => {
    const m = modules[key] || { status: 'IDLE', summary: '' };
    const st = m.status || 'IDLE';
    const cls = st === 'OK' ? 'ok' : (st === 'WARN' ? 'warn' : (st === 'ERROR' ? 'err' : ''));
    return `<span class="mod-pill ${cls}" title="${escapeHtml(m.summary || '')}">${labels[key]}: ${escapeHtml(st)}</span>`;
  }).join('');
}

async function fetchBackendLogsTail() {
  return new Promise((resolve) => {
    chrome.storage.local.get([SETTINGS_KEY], async (res) => {
      const cfg = { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}) };
      const backendUrl = cfg.backendUrl.replace(/\/$/, '');
      try {
        const r = await fetchWithTimeout(`${backendUrl}/api/logs`, { method: 'GET', headers: await getPopupBackendHeaders() }, 1500);
        if (r.ok) {
          const data = await r.json();
          if (data && Array.isArray(data.logs) && data.logs.length > 0) {
            resolve(['', '## 7. ЛОГ FASTAPI (:8765)', ...data.logs.slice(0, 25).map((l) => `${l.ts} [${l.level}] ${l.msg}`)].join('\n'));
            return;
          }
          resolve(['', '## 7. ЛОГ FASTAPI (:8765)', '- Сервер ONLINE, событий пока нет.'].join('\n'));
          return;
        }
        resolve(['', '## 7. ЛОГ FASTAPI (:8765)', `- ⚠️ Сервер вернул HTTP ${r.status}`].join('\n'));
        return;
      } catch {
        resolve(['', '## 7. ЛОГ FASTAPI (:8765)', '- ⚠️ Локальный сервер :8765 OFFLINE / не отвечает (работает только браузерный кэш chrome.storage.local)'].join('\n'));
      }
    });
  });
}

function sanitizeDiagnosticsText(text, aiApiKey = '') {
  let out = String(text || '');
  out = out
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[REDACTED]')
    .replace(/("?(?:aiApiKey|apiKey|api_key|backendToken|X-LQS-Token)"?\s*[:=]\s*"?)([^",\s}\]]+)/gi, '$1[REDACTED]');
  const key = String(aiApiKey || '').trim();
  if (key.length >= 4) {
    out = out.split(key).join('[REDACTED]');
  }
  return out;
}

function formatBgDiagnosticsSection(bgDiag) {
  if (!bgDiag || !bgDiag.ok) return '';
  const storeBreakdown = Object.entries(bgDiag.extByStore || {})
    .sort((a, b) => b[1] - a[1])
    .map(([st, cnt]) => `${st}: ${cnt}`)
    .join(', ') || 'пока пусто';
  const provLine = (bgDiag.providers || [])
    .map((p) => `${p.label}: ${p.status}${p.pausedMin ? ` (пауза ${p.pausedMin} мин)` : ''}${p.failures ? ` [ошибок: ${p.failures}]` : ''}`)
    .join(' | ') || '—';
  return [
    '',
    '## 6b. ТЕЛЕМЕТРИЯ SERVICE WORKER, БАЗЫ ЦЕН И CIRCUIT BREAKER',
    `- **Локальный сервер :8765**: ${bgDiag.backendHealth?.statusText || 'неизвестно'}`,
    `- **Браузерная база**: ${bgDiag.localPriceDbCount} товаров Лавки | ${bgDiag.localExtOffersCount} живых офферов сетей (+${bgDiag.seedOffersCount} seed) | ${bgDiag.rememberedLinksProductsCount} прямых ссылок | ${bgDiag.rejectedProductsCount} товаров с отклонёнными матчами`,
    `- **Офферы по магазинам**: ${storeBreakdown}`,
    `- **Провайдеры радара**: ${provLine}`
  ].join('\n');
}

function isSupportedDiagnosticTabUrl(url) {
  return /(?:lavka\.yandex\.ru|kuper\.ru|magnit\.ru|perekrestok\.ru|vprok\.ru|5ka\.ru|vkusvill\.ru|auchan\.ru|lenta\.com)/i.test(String(url || ''));
}

async function fetchBgDiagnosticsSummary() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'LQS_GET_BG_DIAGNOSTICS' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        resolve('');
        return;
      }
      resolve(formatBgDiagnosticsSection(resp));
    });
  });
}

async function refreshDiagnosticsView() {
  const box = document.getElementById('diag-report-box');
  box.textContent = 'Собираю бортовой журнал...';
  const [backendTail, bgSection] = await Promise.all([fetchBackendLogsTail(), fetchBgDiagnosticsSummary()]);
  const fullTail = bgSection + backendTail;
  const currentAiKey = (document.getElementById('inp-ai-key')?.value || '').trim();

  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs && tabs[0];
      if (activeTab && activeTab.id && isSupportedDiagnosticTabUrl(activeTab.url)) {
        chrome.tabs.sendMessage(
          activeTab.id,
          { type: 'LQS_GET_DIAGNOSTICS', backendDiag: lastBackendPingSummary },
          (resp) => {
            if (!chrome.runtime.lastError && resp && resp.reportText) {
              renderModulePills(resp.modules);
              box.textContent = sanitizeDiagnosticsText(resp.reportText + fullTail, currentAiKey);
              resolve(box.textContent);
              return;
            }
            chrome.storage.local.get([FLIGHT_LOG_KEY], (res) => {
              const snap = res && res[FLIGHT_LOG_KEY];
              const raw = (snap && snap.reportText ? snap.reportText : 'Нажми F5 на вкладке Лавки или магазина') + fullTail;
              box.textContent = sanitizeDiagnosticsText(raw, currentAiKey);
              resolve(box.textContent);
            });
          }
        );
      } else {
        chrome.storage.local.get([FLIGHT_LOG_KEY], (res) => {
          const snap = res && res[FLIGHT_LOG_KEY];
          const raw = (snap && snap.reportText ? snap.reportText : 'Открой вкладку Лавки или любого из 7 магазинов') + fullTail;
          box.textContent = sanitizeDiagnosticsText(raw, currentAiKey);
          resolve(box.textContent);
        });
      }
    });
  });
}

document.getElementById('debug-spoiler').addEventListener('toggle', (e) => {
  if (e.target.open) refreshDiagnosticsView();
});

document.getElementById('diag-ping-btn').addEventListener('click', () => {
  const statusEl = document.getElementById('diag-ping-status');
  statusEl.style.display = 'block';
  chrome.runtime.sendMessage({ type: 'LQS_CHECK_AI_STATUS' }, async (resp) => {
    if (!resp || !resp.ok) return;
    const lines = [
      `Вкладка Gemini: ${resp.geminiTab.found ? 'Открыта' : 'Нет'}`,
      `Кэш ИИ: ${resp.localAiCacheCount ?? 0} | База цен: ${resp.trackedPricesCount ?? 0}`,
      `Сервер :8765: ${resp.backend.msg}`
    ];
    lastBackendPingSummary = lines.join(' | ');
    statusEl.innerHTML = lines.map(escapeHtml).join('<br>');
    applyRadarResponse(resp);
    await refreshDiagnosticsView();
  });
});

document.getElementById('diag-copy-btn').addEventListener('click', async () => {
  const btn = document.getElementById('diag-copy-btn');
  const text = await refreshDiagnosticsView();
  await navigator.clipboard.writeText(text);
  btn.textContent = '✅ Скопировано!';
  setTimeout(() => { btn.textContent = '📋 Скопировать полный лог для ИИ (Markdown)'; }, 1800);
});

document.getElementById('diag-download-btn').addEventListener('click', async () => {
  const text = await refreshDiagnosticsView();
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lavka-quality-shield-v${globalThis.LQS_CONFIG.VERSION}-debug.log`;
  a.click();
});

document.getElementById('diag-clear-btn').addEventListener('click', () => {
  chrome.storage.local.remove([FLIGHT_LOG_KEY], refreshDiagnosticsView);
});

loadReviews();
loadSettings();
loadAccountsVault();
refreshAiRadar();


function renderRadar16StoresStatus(resp) {
  if (!resp || !resp.ok) return;
  const badge = document.getElementById('radar-stores-summary-badge');
  const provBox = document.getElementById('radar-providers-pills');
  const storesBox = document.getElementById('radar-16-stores-pills');
  if (!provBox || !storesBox) return;

  const providers = Array.isArray(resp.providers) ? resp.providers : [];
  const stores = Array.isArray(resp.stores) ? resp.stores : [];
  const pausedCount = providers.filter((p) => p.status === 'PAUSED').length;

  if (badge) {
    badge.textContent = pausedCount > 0 ? `⏸ Пауза (${pausedCount}) ▾` : '🟢 16 сетей ОК ▾';
    badge.style.color = pausedCount > 0 ? '#b91c1c' : '#15803d';
  }

  provBox.innerHTML = providers
    .map((p) => {
      const cls = p.status === 'PAUSED' ? 'err' : (p.status === 'WARN' ? 'warn' : 'ok');
      const label = p.status === 'PAUSED'
        ? `${escapeHtml(p.label)}: ⏸ ${p.pausedMin} мин`
        : (p.status === 'WARN' ? `${escapeHtml(p.label)}: ⚠️ ${p.failures}/3` : `${escapeHtml(p.label)}: ОК`);
      return `<span class="mod-pill ${cls}" title="${escapeHtml(p.lastReason || 'Работает штатно')}">${label}</span>`;
    })
    .join('');

  storesBox.innerHTML = stores
    .map((s) => {
      const cls = s.status === 'PAUSED' ? 'err' : (s.cachedOffers > 0 ? 'ok' : '');
      const suffix = s.status === 'PAUSED' ? ' ⏸' : (s.cachedOffers > 0 ? ` (${s.cachedOffers})` : '');
      return `<span class="mod-pill ${cls}" title="${escapeHtml(s.mode)}">${escapeHtml(s.name)}${suffix}</span>`;
    })
    .join('');
}

function refreshRadar16StoresStatus() {
  chrome.runtime.sendMessage({ type: 'LQS_GET_RADAR_STATUS' }, (resp) => {
    if (!chrome.runtime.lastError && resp && resp.ok) {
      renderRadar16StoresStatus(resp);
    }
  });
}

const resetCbBtn = document.getElementById('reset-cb-btn');
if (resetCbBtn) {
  resetCbBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'LQS_RESET_CIRCUIT_BREAKER' }, (resp) => {
      if (!chrome.runtime.lastError && resp && resp.ok) {
        renderRadar16StoresStatus(resp);
      }
    });
  });
}
