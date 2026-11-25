// État minimal de l'interface : préférences locales protégées par try/catch.

const FOLLOW_KEY = 'truevalue.followed';
const ONBOARD_KEY = 'truevalue.onboarding';

function readList(key) {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Navigation privée ou quota plein : on continue sans persistance.
  }
}

export const state = {
  tab: 'ec',
  type: 'all',
  sort: 'net',
  query: '',
  intensity: 'all',
  data: { ec: null, bi: null, ma: null, lb: null, sources: null },
  loading: false,
  error: null,
  isTelegram: false,
  theme: null,
  followed: new Set(readList(FOLLOW_KEY)),
  onboardingDone: (() => {
    try {
      return localStorage.getItem(ONBOARD_KEY) === '1';
    } catch {
      return false;
    }
  })(),
};

export function toggleFollow(id) {
  if (state.followed.has(id)) state.followed.delete(id);
  else state.followed.add(id);
  write(FOLLOW_KEY, [...state.followed]);
  return state.followed.has(id);
}

export function markOnboardingDone() {
  state.onboardingDone = true;
  try {
    localStorage.setItem(ONBOARD_KEY, '1');
  } catch {
    // Sans stockage, la carte reste visible pendant cette session seulement.
  }
}
