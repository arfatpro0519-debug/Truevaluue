// Utilitaires UI, formatage local, requêtes API Bearer, traduction d'erreurs et accessibilité des modales.

import { saveStored, state, STORAGE_KEYS } from './state.js';

export const $ = (id) => document.getElementById(id);

export function getTg() {
  return window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
}

export function esc(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function safeHttpsUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol === 'https:') {
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}

export function hap(kind = 'light') {
  try {
    const tg = getTg();
    if (
      tg &&
      tg.initData &&
      tg.HapticFeedback &&
      (!tg.isVersionAtLeast || tg.isVersionAtLeast('6.1'))
    ) {
      tg.HapticFeedback.impactOccurred(kind);
    }
  } catch {
    // Ignore outside Telegram
  }
}

export function toast(msg, opts = {}) {
  const el = $('toast');
  if (!el) return;
  el.textContent = '';

  const span = document.createElement('span');
  span.textContent = String(msg ?? '');
  el.appendChild(span);

  if (opts.actionLabel && typeof opts.onAction === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tv-undo-btn';
    btn.textContent = opts.actionLabel;
    btn.addEventListener('click', () => {
      clearTimeout(toast._t);
      el.classList.remove('on');
      el.textContent = '';
      opts.onAction();
    });
    el.appendChild(btn);
  }

  el.classList.add('on');
  clearTimeout(toast._t);
  const duration = opts.duration ?? (opts.actionLabel ? 5500 : 3400);
  toast._t = setTimeout(() => {
    el.classList.remove('on');
  }, duration);
}

export function translateApiError(err, fallbackTitle = 'Chargement impossible') {
  const raw = String(err?.message || err || '').trim();
  if (!raw || /Failed to fetch|NetworkError|Load failed|fetch/i.test(raw)) {
    return {
      title: fallbackTitle,
      detail: 'La connexion au serveur est interrompue. Vérifiez votre réseau et réessayez.',
    };
  }
  if (/401|403|Accès administrateur|Authentification|expir/i.test(raw)) {
    return {
      title: 'Accès restreint',
      detail: 'Votre session administrateur a expiré ou n’est pas ouverte. Connectez-vous depuis Menu.',
    };
  }
  if (/429|Trop de requêtes|rate/i.test(raw)) {
    return {
      title: 'Trop de demandes',
      detail: 'Veuillez patienter quelques secondes avant de relancer l’action.',
    };
  }
  if (/HTTP 5\d\d|interne|indisponible|timeout/i.test(raw)) {
    return {
      title: 'Service momentanément indisponible',
      detail: 'Les sources de marché répondent lentement. Réessayez dans un instant.',
    };
  }
  return {
    title: fallbackTitle,
    detail: raw,
  };
}

export function applyTheme(mode) {
  state.theme = mode;
  saveStored(STORAGE_KEYS.THEME, mode);
  const root = document.documentElement;
  if (mode === 'light' || mode === 'dark') {
    root.setAttribute('data-theme', mode);
  } else {
    root.removeAttribute('data-theme');
  }
  const icons = { auto: '◐', light: '☀', dark: '☾' };
  const labels = {
    auto: 'Changer de thème (actuel : Système / Telegram)',
    light: 'Changer de thème (actuel : Clair)',
    dark: 'Changer de thème (actuel : Sombre)',
  };
  const iconEl = $('themeIcon');
  if (iconEl) iconEl.textContent = icons[mode] || '◐';
  const btn = $('themeToggleBtn');
  if (btn) btn.setAttribute('aria-label', labels[mode] || labels.auto);
}

export function initTelegram() {
  const tg = getTg();
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    const tp = tg.themeParams || {};
    const r = document.documentElement.style;
    if (tp.bg_color) {
      r.setProperty('--bg', tp.secondary_bg_color || tp.bg_color);
      r.setProperty('--sec', tp.bg_color);
      if (tp.text_color) r.setProperty('--tx', tp.text_color);
      if (tp.hint_color) r.setProperty('--hint', tp.hint_color);
      if (tp.link_color) r.setProperty('--link', tp.link_color);
      if (tp.button_color) r.setProperty('--btn', tp.button_color);
    }
    if (tg.colorScheme === 'dark' && state.theme === 'auto') {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  } catch {
    // Ignore outside Telegram WebView
  }
}

export function fmtEur(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace('.', ',')} M€`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace('.0', '').replace('.', ',')} k€`;
  return `${Math.round(n)} €`;
}

export function fmtUsd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `$${(n / 1000).toFixed(1).replace('.0', '')}k`;
  return `$${Math.round(n)}`;
}

export function fmtOdds(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '—';
  return n.toFixed(2);
}

export function fmtPct(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return `${n.toFixed(1)} %`;
}

export function fmtGap(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(1)} pts`;
}

export function fmtSignedPct(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n === 0) return '0.0 %';
  return `${n > 0 ? '+' : ''}${n.toFixed(1)} %`;
}

export function fmtMetric4(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n.toFixed(4);
}

export function fmtNetEdge(val) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return '—';
  return `${val >= 0 ? '+' : ''}${val.toFixed(1)} pts`;
}

export function edgeClass(val) {
  return typeof val === 'number' && val >= 0 ? 'pos' : 'warn';
}

export function kickoffTs(dateStr) {
  if (!dateStr) return Number.MAX_SAFE_INTEGER;
  const iso = String(dateStr).replace(' ', 'T');
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso);
  const t = Date.parse(hasTz ? iso : `${iso}Z`);
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

function localDayKey(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function formatKickoffCompact(dateStr) {
  if (!dateStr) return { hm: '—', day: '' };
  const iso = String(dateStr).replace(' ', 'T');
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso);
  const dt = new Date(hasTz ? iso : `${iso}Z`);
  if (Number.isNaN(dt.getTime())) {
    const m = String(dateStr).match(/(\d{2}:\d{2})/);
    return { hm: m ? m[1] : '—', day: String(dateStr).slice(5, 10) };
  }
  const hm = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  const now = new Date();
  if (localDayKey(dt) === localDayKey(now)) return { hm, day: 'auj.' };
  const days = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
  return { hm, day: `${days[dt.getDay()]} ${dt.getDate()}` };
}

function authHeaders(extra = {}) {
  const headers = { Accept: 'application/json', ...extra };
  if (state.authToken) {
    headers.Authorization = `Bearer ${state.authToken}`;
  }
  return headers;
}

export async function apiGet(url) {
  const res = await fetch(url, { headers: authHeaders() });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.ok === false) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

export async function apiPost(url, body = null) {
  const headers = authHeaders(
    body !== null ? { 'Content-Type': 'application/json' } : {}
  );
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.ok === false) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

/* ---- Bottom Sheets avec accessibilité clavier, inert/aria-hidden et pile Retour ---- */
let lastFocusEl = null;
let sheetBackStack = [];
let currentSheetEntry = null;

function getFocusableElements(container) {
  if (!container) return [];
  return [...container.querySelectorAll(
    'a[href], button:not([disabled]):not([hidden]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]'
  )].filter((el) => el.offsetParent !== null);
}

function setSheetVisibility(sheetEl, visible) {
  if (!sheetEl) return;
  if (visible) {
    sheetEl.classList.add('on');
    sheetEl.setAttribute('aria-hidden', 'false');
    sheetEl.removeAttribute('inert');
  } else {
    sheetEl.classList.remove('on');
    sheetEl.setAttribute('aria-hidden', 'true');
    sheetEl.setAttribute('inert', '');
  }
}

export function isAnySheetOpen() {
  return Boolean(
    $('proSheet')?.classList.contains('on') || $('detailSheet')?.classList.contains('on')
  );
}

export function closeAllSheets(restoreFocus = true) {
  $('ov')?.classList.remove('on');
  setSheetVisibility($('proSheet'), false);
  setSheetVisibility($('detailSheet'), false);
  sheetBackStack = [];
  currentSheetEntry = null;
  if (restoreFocus && lastFocusEl && typeof lastFocusEl.focus === 'function') {
    const target = lastFocusEl;
    lastFocusEl = null;
    try {
      target.focus();
    } catch {
      // Ignore if removed from DOM
    }
  } else if (!restoreFocus) {
    lastFocusEl = null;
  }
}

export function openProSheet() {
  const prev = isAnySheetOpen() ? lastFocusEl : document.activeElement;
  closeAllSheets(false);
  lastFocusEl = prev;
  hap('light');
  const priceEl = $('proSheetPrice');
  if (priceEl) {
    priceEl.textContent = `${Number(state.proPriceStars || 1500).toLocaleString('fr-FR')} ★`;
  }
  $('ov')?.classList.add('on');
  const sheet = $('proSheet');
  setSheetVisibility(sheet, true);
  const focusables = getFocusableElements(sheet);
  if (focusables[0]) focusables[0].focus();
}

function renderDetailEntry(entry) {
  const titleEl = $('detailTitle');
  const subEl = $('detailSub');
  const bodyEl = $('detailBody');
  const backBtn = $('detailBackBtn');
  if (titleEl) titleEl.textContent = entry.title || 'Détail';
  if (subEl) subEl.textContent = entry.sub || '';
  if (bodyEl) bodyEl.innerHTML = entry.bodyHtml;
  if (backBtn) {
    backBtn.hidden = sheetBackStack.length === 0;
  }
}

export function openDetailSheet(title, sub, bodyHtml, options = {}) {
  const { pushHistory = false, keepStack = false } = options;
  const alreadyOpen = $('detailSheet')?.classList.contains('on');
  if (pushHistory && alreadyOpen && currentSheetEntry) {
    sheetBackStack.push(currentSheetEntry);
  } else if (!(keepStack && alreadyOpen)) {
    const prev = isAnySheetOpen() ? lastFocusEl : document.activeElement;
    closeAllSheets(false);
    lastFocusEl = prev;
    sheetBackStack = [];
  }

  currentSheetEntry = { title, sub, bodyHtml };
  hap('light');
  renderDetailEntry(currentSheetEntry);
  $('ov')?.classList.add('on');
  const sheet = $('detailSheet');
  setSheetVisibility($('proSheet'), false);
  setSheetVisibility(sheet, true);
  const focusables = getFocusableElements(sheet);
  if (focusables[0]) focusables[0].focus();
}

export function goBackDetailSheet() {
  if (sheetBackStack.length === 0) {
    closeAllSheets();
    return;
  }
  const prevEntry = sheetBackStack.pop();
  currentSheetEntry = prevEntry;
  hap('light');
  renderDetailEntry(prevEntry);
  const sheet = $('detailSheet');
  const focusables = getFocusableElements(sheet);
  if (focusables[0]) focusables[0].focus();
}

export function handleSheetKeydown(e) {
  const activeSheet = [$('proSheet'), $('detailSheet')].find((el) => el?.classList.contains('on'));
  if (!activeSheet) return false;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (sheetBackStack.length > 0 && activeSheet === $('detailSheet')) {
      goBackDetailSheet();
    } else {
      closeAllSheets();
    }
    return true;
  }
  if (e.key === 'Tab') {
    const focusables = getFocusableElements(activeSheet);
    if (focusables.length === 0) return false;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
      return true;
    }
    if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
      return true;
    }
  }
  return false;
}
