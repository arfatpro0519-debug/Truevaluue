// Truevalue — Point d'entrée ES module : authentification Telegram / Admin,
// synchronisation des données serveur, routage par hash, modales accessibles et contrôles réactifs.

import { saveStored, state, STORAGE_KEYS, TABS } from './modules/state.js';
import {
  $,
  apiGet,
  apiPost,
  applyTheme,
  closeAllSheets,
  esc,
  getTg,
  goBackDetailSheet,
  handleSheetKeydown,
  hap,
  initTelegram,
  openProSheet,
  toast,
  translateApiError,
} from './modules/utils.js';
import {
  collectCompareProposalGroups,
  inspectSource,
  openHelpGuideSheet,
  openMatchDetailSheet,
  openMenuSheet,
  openProposalDetailSheet,
  openResultDetailSheet,
  openSignalDetailSheet,
  openSignalHistoryDetailSheet,
  startProCheckout,
} from './modules/modals.js';
import {
  getFilteredSortedCategoryResults,
  getFilteredSortedResults,
  getFilteredSortedSignalResults,
  getFilteredSortedSignals,
  renderHomeDynamicHtml,
  renderHomeView,
  renderLabBodyHtml,
  renderLabMatchesDynamicHtml,
  renderLabView,
  renderResultsDynamicHtml,
  renderResultsView,
  renderSignalsDynamicHtml,
  renderSignalsView,
} from './modules/views.js';

const TAB_HASHES = {
  home: '#accueil',
  sig: '#signaux',
  res: '#resultats',
  lab: '#configs-72',
};

const HASH_TO_TAB = {
  '#accueil': 'home',
  '#signaux': 'sig',
  '#resultats': 'res',
  '#configs-72': 'lab',
};

let syncInFlight = false;

function syncLocationHash(tab, replace = false) {
  const hash = TAB_HASHES[tab] || TAB_HASHES.home;
  if (window.location.hash === hash) return;
  try {
    if (replace) {
      window.history.replaceState(null, '', hash);
    } else {
      window.history.pushState(null, '', hash);
    }
  } catch {
    window.location.hash = hash;
  }
}

function setInlineError(errId, message) {
  const box = $(errId);
  if (!box) return;
  if (message) {
    box.textContent = message;
    box.hidden = false;
  } else {
    box.textContent = '';
    box.hidden = true;
  }
}

function applyServerAuthStatus(statusPayload) {
  if (!statusPayload) return;
  state.authLoaded = true;
  state.authenticated = Boolean(statusPayload.authenticated);
  state.isPro = Boolean(statusPayload.is_pro);
  state.isAdmin = Boolean(statusPayload.is_admin);
  state.telegramUser = statusPayload.telegram_user_id
    ? {
        id: statusPayload.telegram_user_id,
        username: statusPayload.username || null,
        first_name: statusPayload.first_name || null,
      }
    : null;
  state.subscriptionExpiresAt = statusPayload.subscription_expires_at || null;
  if (typeof statusPayload.admin_configured === 'boolean') {
    state.adminConfigured = statusPayload.admin_configured;
  }
  if (typeof statusPayload.admin_claimed === 'boolean') {
    state.adminClaimed = statusPayload.admin_claimed;
  }
  if (typeof statusPayload.billing_configured === 'boolean') {
    state.billingConfigured = statusPayload.billing_configured;
  }
  if (typeof statusPayload.pro_price_stars === 'number') {
    state.proPriceStars = statusPayload.pro_price_stars;
  }
}

async function syncAuthStatus() {
  try {
    const status = await apiGet('/api/auth/status');
    applyServerAuthStatus(status);
  } catch {
    state.authLoaded = true;
  }
}

async function initAuth() {
  // Nettoyage d'éventuelles anciennes clés de démonstration client
  saveStored('truevalue_pro_unlocked', null);

  const tg = getTg();
  const initData = tg?.initData ? String(tg.initData).trim() : '';
  if (initData) {
    try {
      const authRes = await apiPost('/api/auth/telegram', { initData });
      if (authRes?.token) {
        state.authToken = authRes.token;
      }
    } catch {
      // Hôte web classique ou signature absente : poursuit en session visiteur
    }
  }
  await syncAuthStatus();
}

function buildPropQueryParams(force = false) {
  const qs = new URLSearchParams({ preset: state.propPreset || 'zero' });
  if (force && state.isAdmin) qs.set('force', '1');
  if (state.propThresholds && typeof state.propThresholds === 'object') {
    for (const k of ['minNetEdgePp', 'minBfVolume', 'minPmLiquidity', 'maxSpreadPts', 'maxAdverseDropPct']) {
      const raw = state.propThresholds[k];
      if (raw === undefined || raw === null || raw === '') continue;
      const v = Number(raw);
      if (Number.isFinite(v) && v >= 0) qs.set(k, String(v));
    }
  }
  return qs;
}

async function ensureCompareAndConfig(force = false) {
  const cmpQs = buildPropQueryParams(force);
  const thQs = new URLSearchParams();
  if (force && state.isAdmin) thQs.set('force', '1');
  for (const [k, v] of Object.entries(state.labThresholds || {})) {
    if (v) thQs.set(k, String(v));
  }
  const cfgUrl = `/api/configurations${thQs.toString() ? `?${thQs.toString()}` : ''}`;

  const [cmp, cfg, cal] = await Promise.all([
    state.cmpData && !force ? state.cmpData : apiGet(`/api/compare?${cmpQs.toString()}`),
    state.cfgData && !force ? state.cfgData : apiGet(cfgUrl),
    state.calData && !force ? state.calData : apiGet('/api/calibration').catch(() => null),
  ]);
  state.cmpData = cmp;
  state.cfgData = cfg;
  if (cal) state.calData = cal;
}

async function ensureSignals(force = false) {
  const qs = buildPropQueryParams(force);
  const [sigData, sigResData] = await Promise.all([
    apiGet(`/api/signals?${qs.toString()}`),
    apiGet('/api/signals/results?category=all').catch(() => null),
  ]);
  state.sigData = sigData;
  if (sigResData) {
    state.sigResData = sigResData;
    state.resLoadedCategory = null;
  }
}

async function fetchResultsForCategory(category = state.resCategory) {
  const reqCat = category || 'best';
  const cat = encodeURIComponent(reqCat);
  const [cal, sigRes] = await Promise.all([
    apiGet(`/api/calibration?category=${cat}`),
    apiGet(`/api/signals/results?category=${cat}`),
  ]);
  state.calData = cal;
  state.sigResData = sigRes;
  const resolvedCat = sigRes?.category || cal?.category || reqCat;
  state.resCategory = resolvedCat;
  state.resLoadedCategory = resolvedCat;
}

async function loadResultsCategory(cat) {
  const nextCat = cat || 'best';
  state.resCategory = nextCat;
  state.resFilter = 'all';
  state.resMarket = 'all';
  state.resLimit = 40;
  state.resCatLoading = true;
  hap('light');
  renderView();
  try {
    await fetchResultsForCategory(nextCat);
  } catch (err) {
    const info = translateApiError(err, 'Chargement impossible');
    toast(`${info.title} : ${info.detail}`);
  } finally {
    state.resCatLoading = false;
    renderView();
  }
}

async function loadCurrentTab(force = false) {
  state.loading = true;
  state.error = null;
  const refreshBtn = $('refreshBtn');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Actualisation…';
  }
  renderNav();
  renderLoadingSkeleton();

  try {
    if (state.tab === 'home' || state.tab === 'lab') {
      await ensureCompareAndConfig(force);
    } else if (state.tab === 'sig') {
      await Promise.all([
        !state.sigData || force ? ensureSignals(force) : null,
        ensureCompareAndConfig(force),
      ]);
    } else if (state.tab === 'res') {
      const targetCat = state.resCategory || 'best';
      if (force || state.resLoadedCategory !== targetCat || !state.calData || !state.sigResData) {
        await fetchResultsForCategory(targetCat);
      }
    }
  } catch (err) {
    state.error = err;
  } finally {
    state.loading = false;
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Actualiser';
    }
    renderView();
  }
}

function renderLoadingSkeleton() {
  const rows = Array.from({ length: 5 })
    .map(() => '<div class="skel-row"><div class="skel-line"></div><div class="skel-line short"></div></div>')
    .join('');
  const appEl = $('app');
  if (appEl) {
    appEl.innerHTML = `<div class="sub">Actualisation des marchés en direct…</div><div class="skel">${rows}</div>`;
  }
}

function renderNav() {
  const tabsEl = $('tabs');
  if (tabsEl) {
    tabsEl.innerHTML = TABS.map(
      (t) =>
        `<button type="button" class="tab${state.tab === t.id ? ' on' : ''}" data-tab="${t.id}">${t.icon}<span>${esc(
          t.label
        )}</span></button>`
    ).join('');
  }

  const deskNavEl = $('deskNav');
  if (deskNavEl) {
    deskNavEl.innerHTML = TABS.map(
      (t) =>
        `<button type="button" class="tg-desk-link" data-tab="${t.id}" aria-current="${
          state.tab === t.id ? 'page' : 'false'
        }">${esc(t.label)}</button>`
    ).join('');
  }
}

function renderView() {
  renderNav();
  const appEl = $('app');
  if (!appEl) return;

  if (state.error) {
    const info = translateApiError(state.error);
    appEl.innerHTML = `<div class="tv-err-box">
      <h2>${esc(info.title)}</h2>
      <p>${esc(info.detail)}</p>
      <button type="button" class="tg-btn-sm" id="retryBtn">Réessayer</button>
    </div>`;
    return;
  }

  if (state.tab === 'home') appEl.innerHTML = renderHomeView();
  else if (state.tab === 'sig') appEl.innerHTML = renderSignalsView();
  else if (state.tab === 'res') appEl.innerHTML = renderResultsView();
  else if (state.tab === 'lab') appEl.innerHTML = renderLabView();
}

function updateDynamicPartial(wrapId, htmlBuilder) {
  const wrap = $(wrapId);
  if (!wrap) {
    renderView();
    return;
  }
  wrap.innerHTML = htmlBuilder();
}

function setSyncButtonsLoading(busy) {
  for (const id of ['resSyncCalBtn', 'sigResSyncBtn']) {
    const btn = $(id);
    if (!btn) continue;
    btn.disabled = busy;
    btn.textContent = busy ? 'Synchronisation…' : 'Synchroniser';
  }
  const menuCell = $('accSyncCalCell');
  if (menuCell) {
    const label = menuCell.querySelector('b');
    if (label) label.textContent = busy ? 'En cours…' : 'Exécuter ›';
  }
}

async function runCalibrationSync() {
  if (syncInFlight) return;
  if (!state.isAdmin) {
    toast('Connexion administrateur requise dans Menu.');
    openMenuSheet();
    return;
  }
  syncInFlight = true;
  setSyncButtonsLoading(true);
  hap('medium');
  toast('Synchronisation ESPN & SportScore…');
  try {
    const res = await apiPost('/api/calibration/sync');
    await fetchResultsForCategory(state.resCategory || 'best');
    const sigSettled = state.sigResData?.summary?.settled_matches ?? res.signal_results?.summary?.settled_matches ?? 0;
    toast(`Résultats mis à jour (${res.summary?.settled ?? 0} réglés · ${sigSettled} matchs Signaux)`);
    renderView();
    if ($('detailSheet')?.classList.contains('on') && $('detailTitle')?.textContent.includes('Menu')) {
      openMenuSheet();
    }
  } catch (err) {
    const info = translateApiError(err, 'Synchronisation impossible');
    toast(`${info.title} : ${info.detail}`);
  } finally {
    syncInFlight = false;
    setSyncButtonsLoading(false);
  }
}

function switchTab(next, { fromHistory = false } = {}) {
  if (!next || !TAB_HASHES[next]) return;
  closeAllSheets(false);
  if (!fromHistory) {
    syncLocationHash(next, false);
  }
  if (next !== state.tab) {
    state.tab = next;
    hap('light');
    window.scrollTo(0, 0);
    loadCurrentTab(false);
  }
}

async function refreshDataAfterAuthChange() {
  state.cmpData = null;
  state.cfgData = null;
  state.sigData = null;
  await loadCurrentTab(false);
}

/* ---- Événements globaux délégués ---- */
document.addEventListener('input', (e) => {
  const id = e.target?.id;
  if (id === 'homeSearchInput') {
    state.homeQuery = e.target.value;
    state.homeLimit = 25;
    const clr = document.querySelector('[data-clear-search="home"]');
    if (clr) clr.hidden = !e.target.value;
    updateDynamicPartial('homeDynamicWrap', renderHomeDynamicHtml);
  } else if (id === 'sigSearchInput') {
    state.sigQuery = e.target.value;
    state.sigLimit = 40;
    const clr = document.querySelector('[data-clear-search="sig"]');
    if (clr) clr.hidden = !e.target.value;
    updateDynamicPartial('sigDynamicWrap', renderSignalsDynamicHtml);
  } else if (id === 'resSearchInput') {
    state.resQuery = e.target.value;
    state.resLimit = 40;
    const clr = document.querySelector('[data-clear-search="res"]');
    if (clr) clr.hidden = !e.target.value;
    updateDynamicPartial('resDynamicWrap', renderResultsDynamicHtml);
  } else if (id === 'labSearchInput') {
    state.labQuery = e.target.value;
    state.labLimit = 30;
    const clr = document.querySelector('[data-clear-search="lab"]');
    if (clr) clr.hidden = !e.target.value;
    if (state.labView === 'overview' || state.labView === 'catalog' || state.labView === 'compare_sigs') {
      state.labView = 'matches';
      updateDynamicPartial('labBodyWrap', renderLabBodyHtml);
    } else {
      updateDynamicPartial('labMatchesDynamicWrap', renderLabMatchesDynamicHtml);
    }
  }
});

document.addEventListener('change', (e) => {
  if (e.target?.id === 'labSelectA') {
    state.labSigA = e.target.value;
    updateDynamicPartial('labBodyWrap', renderLabBodyHtml);
  } else if (e.target?.id === 'labSelectB') {
    state.labSigB = e.target.value;
    updateDynamicPartial('labBodyWrap', renderLabBodyHtml);
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (!form || !form.id) return;

  if (form.id === 'labThForm') {
    e.preventDefault();
    const equil = Number($('thEquil')?.value);
    const mod = Number($('thMod')?.value);
    const forte = Number($('thForte')?.value);
    const stable = Number($('thStable')?.value);
    const strong = Number($('thStrong')?.value);

    if (![equil, mod, forte, stable, strong].every((n) => Number.isFinite(n) && n > 0)) {
      setInlineError('labFormError', 'Veuillez saisir des valeurs numériques strictement positives.');
      return;
    }
    if (!(equil < mod && mod < forte)) {
      setInlineError('labFormError', 'Ordre attendu : Équilibre max < Modérée max < Forte max (en points).');
      return;
    }
    if (stable >= strong) {
      setInlineError('labFormError', 'Le seuil « Stable max (%) » doit rester inférieur à « Forte var. (%) ».');
      return;
    }
    setInlineError('labFormError', '');
    state.labThresholds = {
      equilibreMaxPp: equil,
      modereeMaxPp: mod,
      forteMaxPp: forte,
      stableMaxPct: stable,
      strongMovePct: strong,
    };
    state.cfgData = null;
    hap('medium');
    toast('Seuils 4 axes appliqués.');
    await loadCurrentTab(false);
    return;
  }

  if (form.id === 'propThForm') {
    e.preventDefault();
    const readVal = (id) => {
      const raw = $(id)?.value;
      if (raw === undefined || raw === null || String(raw).trim() === '') return NaN;
      return Number(raw);
    };
    const minNetEdgePp = readVal('propMinEdge');
    const minBfVolume = readVal('propMinVol');
    const minPmLiquidity = readVal('propMinLiq');
    const maxSpreadPts = readVal('propMaxSpr');
    const maxAdverseDropPct = readVal('propMaxDrop');

    if (
      ![minNetEdgePp, minBfVolume, minPmLiquidity, maxSpreadPts, maxAdverseDropPct].every(
        (n) => Number.isFinite(n) && n >= 0
      )
    ) {
      setInlineError('propFormError', 'Chaque seuil doit être un nombre positif ou nul.');
      return;
    }
    if (maxSpreadPts < 0.5) {
      setInlineError('propFormError', 'Le spread max doit être d’au moins 0,5 pt.');
      return;
    }
    if (maxAdverseDropPct > 100) {
      setInlineError('propFormError', 'La baisse adverse max ne peut pas dépasser 100 %.');
      return;
    }

    setInlineError('propFormError', '');
    state.propThresholds = {
      minNetEdgePp,
      minBfVolume,
      minPmLiquidity,
      maxSpreadPts,
      maxAdverseDropPct,
    };
    saveStored(STORAGE_KEYS.PROP_TH, JSON.stringify(state.propThresholds));
    state.cmpData = null;
    state.sigData = null;
    state.propLimit = 20;
    hap('medium');
    toast('Seuils des propositions appliqués.');
    await loadCurrentTab(false);
    return;
  }

  if (form.id === 'adminClaimForm') {
    e.preventDefault();
    const input = $('adminClaimInput');
    const btn = $('adminClaimBtn');
    const passcode = input ? input.value.trim() : '';
    if (passcode.length < 8) {
      setInlineError('adminFormError', 'Le code administrateur doit contenir au moins 8 caractères.');
      input?.focus();
      return;
    }
    setInlineError('adminFormError', '');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Initialisation…';
    }
    try {
      const res = await apiPost('/api/auth/admin/claim', { passcode });
      if (input) input.value = '';
      if (res?.token) {
        state.authToken = res.token;
        state.adminToken = res.token;
      }
      await syncAuthStatus();
      hap('medium');
      toast('Accès administrateur initialisé.');
      await refreshDataAfterAuthChange();
      openMenuSheet();
    } catch (err) {
      const info = translateApiError(err, 'Initialisation impossible');
      setInlineError('adminFormError', info.detail);
      input?.focus();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Initialiser';
      }
    }
    return;
  }

  if (form.id === 'adminLoginForm') {
    e.preventDefault();
    const input = $('adminLoginInput');
    const btn = $('adminLoginBtn');
    const passcode = input ? input.value.trim() : '';
    if (!passcode) {
      setInlineError('adminFormError', 'Veuillez saisir votre code administrateur.');
      input?.focus();
      return;
    }
    setInlineError('adminFormError', '');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Connexion…';
    }
    try {
      const res = await apiPost('/api/auth/admin/login', { passcode });
      if (input) input.value = '';
      if (res?.token) {
        state.authToken = res.token;
        state.adminToken = res.token;
      }
      await syncAuthStatus();
      hap('medium');
      toast('Session administrateur active.');
      await refreshDataAfterAuthChange();
      openMenuSheet();
    } catch (err) {
      const info = translateApiError(err, 'Connexion refusée');
      setInlineError('adminFormError', info.detail);
      input?.focus();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Connexion';
      }
    }
  }
});

document.addEventListener('click', async (e) => {
  if (e.target === $('ov')) {
    closeAllSheets();
    return;
  }

  if (e.target.closest('#retryBtn')) {
    loadCurrentTab(false);
    return;
  }

  if (e.target.closest('#openHelpFromMenuCell')) {
    openHelpGuideSheet(true);
    return;
  }

  if (e.target.closest('[data-open-help]')) {
    openHelpGuideSheet(false);
    return;
  }

  const clearBtn = e.target.closest('[data-clear-search]');
  if (clearBtn) {
    const scope = clearBtn.dataset.clearSearch;
    clearBtn.hidden = true;
    hap('light');
    if (scope === 'home') {
      state.homeQuery = '';
      state.homeLimit = 25;
      const inp = $('homeSearchInput');
      if (inp) {
        inp.value = '';
        inp.focus();
      }
      updateDynamicPartial('homeDynamicWrap', renderHomeDynamicHtml);
    } else if (scope === 'sig') {
      state.sigQuery = '';
      state.sigLimit = 40;
      const inp = $('sigSearchInput');
      if (inp) {
        inp.value = '';
        inp.focus();
      }
      updateDynamicPartial('sigDynamicWrap', renderSignalsDynamicHtml);
    } else if (scope === 'res') {
      state.resQuery = '';
      state.resLimit = 40;
      const inp = $('resSearchInput');
      if (inp) {
        inp.value = '';
        inp.focus();
      }
      updateDynamicPartial('resDynamicWrap', renderResultsDynamicHtml);
    } else if (scope === 'lab') {
      state.labQuery = '';
      state.labLimit = 30;
      const inp = $('labSearchInput');
      if (inp) {
        inp.value = '';
        inp.focus();
      }
      updateDynamicPartial('labBodyWrap', renderLabBodyHtml);
    }
    return;
  }

  const resetBtn = e.target.closest('[data-reset-scope]');
  if (resetBtn) {
    const scope = resetBtn.dataset.resetScope;
    hap('light');
    if (scope === 'home') {
      state.homeQuery = '';
      state.homeFilter = 'all';
      state.homeSort = 'pertinence';
      state.homeLimit = 25;
    } else if (scope === 'sig') {
      state.sigQuery = '';
      state.sigCat = 'all';
      state.sigResFilter = 'all';
      state.sigLimit = 40;
      state.sigResLimit = 40;
    } else if (scope === 'res') {
      state.resQuery = '';
      state.resFilter = 'all';
      state.resMarket = 'all';
      state.resLimit = 40;
    } else if (scope === 'lab') {
      state.labQuery = '';
      state.labConcFilter = 'all';
      state.labView = 'matches';
      state.labLimit = 30;
    }
    renderView();
    return;
  }

  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) {
    switchTab(tabBtn.dataset.tab);
    return;
  }

  const goTabBtn = e.target.closest('[data-go-tab]');
  if (goTabBtn) {
    switchTab(goTabBtn.dataset.goTab);
    return;
  }

  const hfBtn = e.target.closest('[data-hf]');
  if (hfBtn) {
    state.homeFilter = hfBtn.dataset.hf;
    state.homeLimit = 25;
    hap('light');
    updateDynamicPartial('homeDynamicWrap', renderHomeDynamicHtml);
    return;
  }

  const hsBtn = e.target.closest('[data-hs]');
  if (hsBtn) {
    state.homeSort = hsBtn.dataset.hs;
    state.homeLimit = 25;
    hap('light');
    updateDynamicPartial('homeDynamicWrap', renderHomeDynamicHtml);
    return;
  }

  if (e.target.closest('#homeMoreBtn')) {
    state.homeLimit += 25;
    hap('light');
    updateDynamicPartial('homeDynamicWrap', renderHomeDynamicHtml);
    return;
  }

  if (e.target.closest('#resSyncCalBtn') || e.target.closest('#accSyncCalCell') || e.target.closest('#sigResSyncBtn')) {
    runCalibrationSync();
    return;
  }

  if (e.target.closest('#propToggleSettingsBtn') || e.target.closest('#sigToggleSettingsBtn') || e.target.closest('#propEmptyEditBtn')) {
    state.showPropSettings = !state.showPropSettings;
    hap('light');
    updateDynamicPartial('sigDynamicWrap', renderSignalsDynamicHtml);
    return;
  }

  if (e.target.closest('#propQuickZeroBtn') || e.target.closest('#propThResetBtn')) {
    state.propPreset = 'zero';
    state.propThresholds = null;
    saveStored(STORAGE_KEYS.PROP_PRESET, 'zero');
    saveStored(STORAGE_KEYS.PROP_TH, null);
    state.cmpData = null;
    state.sigData = null;
    hap('medium');
    toast('Seuils réinitialisés sur 0 (défaut).');
    loadCurrentTab(false);
    return;
  }

  if (e.target.closest('#propHideBtn') || e.target.closest('#propQuickHideBtn')) {
    const prevCat = state.sigCat;
    state.showProposals = false;
    state.showPropSettings = false;
    if (state.sigCat === 'executable') state.sigCat = 'all';
    saveStored(STORAGE_KEYS.PROP_SHOW, '0');
    hap('medium');
    renderView();
    toast('Module Propositions masqué.', {
      actionLabel: 'Annuler',
      onAction: () => {
        state.showProposals = true;
        if (prevCat === 'executable') state.sigCat = 'executable';
        saveStored(STORAGE_KEYS.PROP_SHOW, '1');
        hap('light');
        renderView();
      },
    });
    return;
  }

  if (e.target.closest('#propQuickShowBtn')) {
    state.showProposals = true;
    saveStored(STORAGE_KEYS.PROP_SHOW, '1');
    hap('medium');
    toast('Module Propositions réactivé.');
    renderView();
    return;
  }

  if (e.target.closest('#toggleProposalsCell')) {
    state.showProposals = !state.showProposals;
    if (!state.showProposals && state.sigCat === 'executable') state.sigCat = 'all';
    saveStored(STORAGE_KEYS.PROP_SHOW, state.showProposals ? '1' : '0');
    hap('medium');
    toast(state.showProposals ? 'Module Propositions activé.' : 'Module Propositions masqué.');
    renderView();
    openMenuSheet();
    return;
  }

  const propEl = e.target.closest('[data-prop-key]');
  if (propEl) {
    const groups = collectCompareProposalGroups();
    openProposalDetailSheet(groups.find((g) => g.fixture_key === propEl.dataset.propKey));
    return;
  }

  const matchEl = e.target.closest('[data-match-key]');
  if (matchEl) {
    if (matchEl.dataset.locked === '1') {
      openProSheet();
      return;
    }
    openMatchDetailSheet(matchEl.dataset.matchKey, matchEl.dataset.pushSheet === '1');
    return;
  }

  const scBtn = e.target.closest('[data-sc]');
  if (scBtn) {
    state.sigCat = scBtn.dataset.sc;
    state.sigLimit = 40;
    state.sigResLimit = 40;
    hap('light');
    if (state.sigCat === 'results' && !state.sigResData) {
      apiGet('/api/signals/results?category=all')
        .then((d) => {
          state.sigResData = d;
          renderView();
        })
        .catch(() => renderView());
    } else {
      renderView();
    }
    return;
  }

  const srfBtn = e.target.closest('[data-srf]');
  if (srfBtn) {
    state.sigResFilter = srfBtn.dataset.srf;
    state.sigResLimit = 40;
    hap('light');
    updateDynamicPartial('sigDynamicWrap', renderSignalsDynamicHtml);
    return;
  }

  if (e.target.closest('#sigResMoreBtn')) {
    state.sigResLimit += 40;
    hap('light');
    updateDynamicPartial('sigDynamicWrap', renderSignalsDynamicHtml);
    return;
  }

  const sigResEl = e.target.closest('[data-sig-res-idx]');
  if (sigResEl) {
    const sorted = getFilteredSortedSignalResults(state.sigResData);
    openSignalHistoryDetailSheet(sorted[Number(sigResEl.dataset.sigResIdx)]);
    return;
  }

  const ssBtn = e.target.closest('[data-ss]');
  if (ssBtn) {
    const nextSort = ssBtn.dataset.ss;
    if (state.sigSort === nextSort) {
      state.sigSortDir = state.sigSortDir === 'desc' ? 'asc' : 'desc';
    } else {
      state.sigSort = nextSort;
      state.sigSortDir = nextSort === 'time' ? 'asc' : 'desc';
    }
    state.sigLimit = 40;
    saveStored(STORAGE_KEYS.SIG_SORT, state.sigSort);
    saveStored(STORAGE_KEYS.SIG_SORT_DIR, state.sigSortDir);
    hap('light');
    updateDynamicPartial('sigDynamicWrap', renderSignalsDynamicHtml);
    return;
  }

  if (e.target.closest('#sigSortDirBtn')) {
    state.sigSortDir = state.sigSortDir === 'desc' ? 'asc' : 'desc';
    state.sigLimit = 40;
    saveStored(STORAGE_KEYS.SIG_SORT_DIR, state.sigSortDir);
    hap('light');
    updateDynamicPartial('sigDynamicWrap', renderSignalsDynamicHtml);
    return;
  }

  if (e.target.closest('#sigMoreBtn')) {
    state.sigLimit += 40;
    hap('light');
    updateDynamicPartial('sigDynamicWrap', renderSignalsDynamicHtml);
    return;
  }

  const spBtn = e.target.closest('[data-sp]');
  if (spBtn) {
    state.propPreset = spBtn.dataset.sp;
    state.propThresholds = null;
    state.sigLimit = 40;
    saveStored(STORAGE_KEYS.PROP_PRESET, state.propPreset);
    saveStored(STORAGE_KEYS.PROP_TH, null);
    state.cmpData = null;
    state.sigData = null;
    hap('light');
    loadCurrentTab(false);
    return;
  }

  if (e.target.closest('#sigProBanner') || e.target.closest('#accProBanner') || e.target.closest('#sigUnlockRow')) {
    openProSheet();
    return;
  }

  const sigEl = e.target.closest('[data-sig-idx]');
  if (sigEl) {
    if (sigEl.dataset.locked === '1') {
      openProSheet();
      return;
    }
    const sorted = getFilteredSortedSignals(state.sigData);
    openSignalDetailSheet(sorted[Number(sigEl.dataset.sigIdx)]);
    return;
  }

  const resCatBtn = e.target.closest('[data-res-cat]');
  if (resCatBtn) {
    loadResultsCategory(resCatBtn.dataset.resCat);
    return;
  }

  const rfBtn = e.target.closest('[data-rf]');
  if (rfBtn) {
    state.resFilter = rfBtn.dataset.rf;
    state.resLimit = 40;
    hap('light');
    updateDynamicPartial('resDynamicWrap', renderResultsDynamicHtml);
    return;
  }

  const rmBtn = e.target.closest('[data-rm]');
  if (rmBtn) {
    state.resMarket = rmBtn.dataset.rm;
    state.resLimit = 40;
    hap('light');
    updateDynamicPartial('resDynamicWrap', renderResultsDynamicHtml);
    return;
  }

  const rsBtn = e.target.closest('[data-rs]');
  if (rsBtn) {
    const nextSort = rsBtn.dataset.rs;
    if (state.resSort === nextSort) {
      state.resSortDir = state.resSortDir === 'desc' ? 'asc' : 'desc';
    } else {
      state.resSort = nextSort;
      state.resSortDir = nextSort === 'brier' ? 'asc' : 'desc';
    }
    state.resLimit = 40;
    saveStored(STORAGE_KEYS.RES_SORT, state.resSort);
    saveStored(STORAGE_KEYS.RES_SORT_DIR, state.resSortDir);
    hap('light');
    updateDynamicPartial('resDynamicWrap', renderResultsDynamicHtml);
    return;
  }

  if (e.target.closest('#resSortDirBtn')) {
    state.resSortDir = state.resSortDir === 'desc' ? 'asc' : 'desc';
    state.resLimit = 40;
    saveStored(STORAGE_KEYS.RES_SORT_DIR, state.resSortDir);
    hap('light');
    updateDynamicPartial('resDynamicWrap', renderResultsDynamicHtml);
    return;
  }

  if (e.target.closest('#resMoreBtn')) {
    state.resLimit += 40;
    hap('light');
    updateDynamicPartial('resDynamicWrap', renderResultsDynamicHtml);
    return;
  }

  const resSigEl = e.target.closest('[data-res-sig-idx]');
  if (resSigEl) {
    const sorted = getFilteredSortedCategoryResults(state.sigResData);
    openSignalHistoryDetailSheet(sorted[Number(resSigEl.dataset.resSigIdx)]);
    return;
  }

  const resEl = e.target.closest('[data-res-idx]');
  if (resEl) {
    const sorted = getFilteredSortedResults(state.calData);
    openResultDetailSheet(sorted[Number(resEl.dataset.resIdx)]);
    return;
  }

  const lvBtn = e.target.closest('[data-lv]');
  if (lvBtn) {
    state.labView = lvBtn.dataset.lv;
    hap('light');
    updateDynamicPartial('labBodyWrap', renderLabBodyHtml);
    return;
  }

  const lsBtn = e.target.closest('[data-ls]');
  if (lsBtn) {
    const nextSort = lsBtn.dataset.ls;
    if (state.labSort === nextSort) {
      state.labSortDir = state.labSortDir === 'desc' ? 'asc' : 'desc';
    } else {
      state.labSort = nextSort;
      state.labSortDir = nextSort === 'time' ? 'asc' : 'desc';
    }
    state.labLimit = 30;
    saveStored(STORAGE_KEYS.LAB_SORT, state.labSort);
    saveStored(STORAGE_KEYS.LAB_SORT_DIR, state.labSortDir);
    hap('light');
    updateDynamicPartial('labMatchesDynamicWrap', renderLabMatchesDynamicHtml);
    return;
  }

  if (e.target.closest('#labSortDirBtn')) {
    state.labSortDir = state.labSortDir === 'desc' ? 'asc' : 'desc';
    state.labLimit = 30;
    saveStored(STORAGE_KEYS.LAB_SORT_DIR, state.labSortDir);
    hap('light');
    updateDynamicPartial('labMatchesDynamicWrap', renderLabMatchesDynamicHtml);
    return;
  }

  if (e.target.closest('#labToggleThBtn')) {
    state.labShowThresholds = !state.labShowThresholds;
    hap('light');
    updateDynamicPartial('labBodyWrap', renderLabBodyHtml);
    return;
  }

  if (e.target.closest('#labThResetBtn')) {
    state.labThresholds = {};
    hap('light');
    toast('Seuils 4 axes réinitialisés.');
    loadCurrentTab(false);
    return;
  }

  if (e.target.closest('#lab72ActiveBtn')) {
    state.labShowAll72 = false;
    hap('light');
    updateDynamicPartial('labBodyWrap', renderLabBodyHtml);
    return;
  }

  if (e.target.closest('#lab72AllBtn')) {
    state.labShowAll72 = true;
    hap('light');
    updateDynamicPartial('labBodyWrap', renderLabBodyHtml);
    return;
  }

  const lcfBtn = e.target.closest('[data-lcf]');
  if (lcfBtn) {
    state.labConcFilter = lcfBtn.dataset.lcf;
    state.labLimit = 30;
    hap('light');
    updateDynamicPartial('labMatchesDynamicWrap', renderLabMatchesDynamicHtml);
    return;
  }

  if (e.target.closest('#labMoreBtn')) {
    state.labLimit += 30;
    hap('light');
    updateDynamicPartial('labMatchesDynamicWrap', renderLabMatchesDynamicHtml);
    return;
  }

  const pickSig = e.target.closest('[data-pick-sig]');
  if (pickSig) {
    state.labQuery = pickSig.dataset.pickSig;
    state.labView = 'matches';
    hap('light');
    renderView();
    return;
  }

  if (e.target.closest('#toggleProPreviewCell')) {
    try {
      const nextEnabled = !state.isPro;
      const res = await apiPost('/api/auth/admin/pro-preview', { enabled: nextEnabled });
      if (res?.token) {
        state.authToken = res.token;
      }
      await syncAuthStatus();
      hap('medium');
      toast(state.isPro ? 'Aperçu mode Pro complet activé.' : 'Aperçu mode Gratuit (limité à 3) activé.');
      await refreshDataAfterAuthChange();
      openMenuSheet();
    } catch (err) {
      const info = translateApiError(err, 'Aperçu indisponible');
      toast(info.detail);
    }
    return;
  }

  if (e.target.closest('#adminLogoutCell')) {
    state.authToken = null;
    state.adminToken = null;
    await initAuth();
    hap('medium');
    toast('Session administrateur fermée.');
    await refreshDataAfterAuthChange();
    openMenuSheet();
    return;
  }

  const srcEl = e.target.closest('[data-src-inspect]');
  if (srcEl) {
    inspectSource(srcEl.dataset.srcInspect, undefined, true);
    return;
  }

  const srcMktBtn = e.target.closest('[data-src-mkt]');
  if (srcMktBtn) {
    inspectSource('arbworld', srcMktBtn.dataset.srcMkt, false);
    return;
  }

  const thModeBtn = e.target.closest('[data-th-mode]');
  if (thModeBtn) {
    applyTheme(thModeBtn.dataset.thMode);
    hap('light');
    renderView();
    if ($('detailSheet')?.classList.contains('on') && $('detailTitle')?.textContent.includes('Menu')) {
      openMenuSheet();
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (handleSheetKeydown(e)) return;
  if (e.key !== 'Enter' && e.key !== ' ') return;

  const target = e.target;
  if (!target) return;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A') {
    return;
  }
  const interactive = target.closest('[role="button"][tabindex="0"]');
  if (interactive) {
    e.preventDefault();
    interactive.click();
  }
});

window.addEventListener('hashchange', () => {
  const hashTab = HASH_TO_TAB[window.location.hash];
  if (hashTab && hashTab !== state.tab) {
    switchTab(hashTab, { fromHistory: true });
  }
});

$('brandHomeLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  switchTab('home');
});

$('helpGuideBtn')?.addEventListener('click', () => {
  openHelpGuideSheet(false);
});

$('menuToggleBtn')?.addEventListener('click', () => {
  openMenuSheet();
});

$('refreshBtn')?.addEventListener('click', () => {
  hap('light');
  loadCurrentTab(state.isAdmin);
});

$('themeToggleBtn')?.addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(state.theme) + 1) % order.length];
  applyTheme(next);
  hap('light');
  const names = { auto: 'Thème système / Telegram', light: 'Thème clair', dark: 'Thème sombre' };
  toast(names[next]);
});

$('buyBtn')?.addEventListener('click', () => {
  startProCheckout(async () => {
    await syncAuthStatus();
    await refreshDataAfterAuthChange();
  });
});

$('detailBackBtn')?.addEventListener('click', () => {
  goBackDetailSheet();
});

$('closeProBtn')?.addEventListener('click', () => closeAllSheets());
$('detailCloseBtn')?.addEventListener('click', () => closeAllSheets());

async function bootstrap() {
  initTelegram();
  applyTheme(state.theme);
  const initialTab = HASH_TO_TAB[window.location.hash];
  if (initialTab) {
    state.tab = initialTab;
  }
  syncLocationHash(state.tab, true);
  await initAuth();
  await loadCurrentTab(false);
}

bootstrap();
