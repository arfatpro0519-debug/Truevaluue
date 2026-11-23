// État global en mémoire et persistance non sensible des préférences d'interface.

export const STORAGE_KEYS = {
  THEME: 'truevalue_theme',
  PROP_SHOW: 'truevalue_show_proposals',
  PROP_PRESET: 'truevalue_prop_preset_v2',
  PROP_TH: 'truevalue_prop_thresholds_v2',
  SIG_SORT: 'truevalue_sig_sort_v2',
  SIG_SORT_DIR: 'truevalue_sig_sort_dir_v2',
  RES_SORT: 'truevalue_res_sort_v2',
  RES_SORT_DIR: 'truevalue_res_sort_dir_v2',
  LAB_SORT: 'truevalue_lab_sort_v2',
  LAB_SORT_DIR: 'truevalue_lab_sort_dir_v2',
};

export const TABS = [
  {
    id: 'home',
    label: 'Accueil',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/></svg>',
  },
  {
    id: 'sig',
    label: 'Signaux',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"/></svg>',
  },
  {
    id: 'res',
    label: 'Résultats',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m7 14 4-4 4 3 5-6"/></svg>',
  },
  {
    id: 'lab',
    label: 'Configs 72',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  },
];

export function loadStored(k, fallback) {
  try {
    const v = localStorage.getItem(k);
    return v !== null ? v : fallback;
  } catch {
    return fallback;
  }
}

export function loadJsonStored(k, fallback) {
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function saveStored(k, v) {
  try {
    if (v === null || v === undefined) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    // Ignore storage quota or sandbox restrictions
  }
}

export const state = {
  tab: 'home',
  theme: loadStored(STORAGE_KEYS.THEME, 'auto'),

  // Authentification & droits uniquement en mémoire JS (jamais stockés dans localStorage)
  authToken: null,
  adminToken: null,
  authLoaded: false,
  authenticated: false,
  isPro: false,
  isAdmin: false,
  telegramUser: null,
  subscriptionExpiresAt: null,
  adminConfigured: false,
  adminClaimed: false,
  billingConfigured: false,
  proPriceStars: 1500,

  // Propositions
  showProposals: loadStored(STORAGE_KEYS.PROP_SHOW, '1') !== '0',
  propPreset: loadStored(STORAGE_KEYS.PROP_PRESET, 'zero'),
  propThresholds: loadJsonStored(STORAGE_KEYS.PROP_TH, null),
  showPropSettings: false,
  propLimit: 20,

  // Accueil
  homeFilter: 'all',
  homeSort: 'time',
  homeQuery: '',
  homeLimit: 25,

  // Signaux
  sigCat: 'all',
  sigResFilter: 'all',
  sigResLimit: 40,
  sigSort: loadStored(STORAGE_KEYS.SIG_SORT, 'score'),
  sigSortDir: loadStored(STORAGE_KEYS.SIG_SORT_DIR, 'desc'),
  sigQuery: '',
  sigLimit: 40,

  // Résultats détaillés
  resCategory: 'best',
  resLoadedCategory: null,
  resCatLoading: false,
  resFilter: 'all',
  resMarket: 'all',
  resSort: loadStored(STORAGE_KEYS.RES_SORT, 'best'),
  resSortDir: loadStored(STORAGE_KEYS.RES_SORT_DIR, 'desc'),
  resQuery: '',
  resLimit: 40,

  // Lab 72 / Configurations
  labView: 'overview',
  labQuery: '',
  labConcFilter: 'all',
  labSort: loadStored(STORAGE_KEYS.LAB_SORT, 'interest'),
  labSortDir: loadStored(STORAGE_KEYS.LAB_SORT_DIR, 'desc'),
  labShowAll72: false,
  labShowThresholds: false,
  labThresholds: {},
  labSigA: '',
  labSigB: '',
  labLimit: 30,

  // Cache API
  cmpData: null,
  cfgData: null,
  sigData: null,
  sigResData: null,
  calData: null,
  sourceInspectorKey: 'arbworld',
  sourceArbMarket: '1x2',
  loading: false,
  error: null,
};
