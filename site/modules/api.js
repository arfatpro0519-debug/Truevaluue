// Client API v2 :aucun accès direct aux routes dépréciées, erreurs réseau explicites.

const TOKEN_KEY = 'truevalue.session';

export function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Stockage indisponible : la session reste valable pour cette page.
  }
}

async function request(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`/api/v2${path}`, { ...options, headers });
  } catch {
    throw new Error('Erreur réseau : vérifiez la connexion puis réessayez.');
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Réponse non JSON : on remonte une erreur lisible.
  }
  if (!res.ok || body?.ok === false) {
    throw new Error(body?.error || `Erreur réseau (${res.status}).`);
  }
  return body;
}

// initData est validé côté serveur par auth.js ; le front ne fait que le transmettre.
export async function authenticateTelegram(initData) {
  if (!initData) return null;
  const res = await fetch('/api/auth/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData }),
  });
  if (!res.ok) return null;
  const body = await res.json();
  if (body?.token) setToken(body.token);
  return body?.auth || null;
}

export const api = {
  ecarts: (type = 'all') => request(`/ecarts?type=${encodeURIComponent(type)}`),
  ecart: (id) => request(`/ecarts/${encodeURIComponent(id)}`),
  matchs: (q = '') => request(`/matchs?q=${encodeURIComponent(q)}`),
  bilan: () => request('/bilan'),
  laboratoire: (intensity = 'all') => request(`/laboratoire?intensity=${encodeURIComponent(intensity)}`),
  sources: () => request('/sources/status'),
  alertes: () => request('/alertes'),
  setAlertes: (actif, chatId = null) =>
    request('/alertes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actif, chat_id: chatId }),
    }),
};
