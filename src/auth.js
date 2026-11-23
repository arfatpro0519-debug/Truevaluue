// Authentification serveur (Telegram initData HMAC, session Bearer, admin scrypt)
// et filtrage serveur du contenu Pro.

import crypto from 'node:crypto';

export const FREE_PREVIEW_LIMIT = 3;

const EPHEMERAL_SESSION_SECRET = crypto.randomBytes(32).toString('hex');

function getSessionSecret() {
  const envSecret = process.env.SESSION_SECRET;
  if (typeof envSecret === 'string' && envSecret.trim().length >= 16) {
    return envSecret.trim();
  }
  return EPHEMERAL_SESSION_SECRET;
}

function b64urlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

function b64urlDecode(input) {
  return Buffer.from(String(input || ''), 'base64url').toString('utf8');
}

export function signSessionToken(claims, ttlSecs = 7 * 24 * 3600) {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'TV' }));
  const payload = b64urlEncode(
    JSON.stringify({
      ...claims,
      iat: nowSec,
      exp: nowSec + ttlSecs,
    })
  );
  const signingInput = `${header}.${payload}`;
  const sig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${sig}`;
}

export function verifySessionToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  if (!header || !payload || !sig) return null;

  const expectedSig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(`${header}.${payload}`)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(b64urlDecode(payload));
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.exp !== 'number' || parsed.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function extractBearerToken(req) {
  const h = req?.headers?.authorization;
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export function verifyTelegramInitData(initData, botToken, maxAgeSecs = 86400) {
  if (typeof initData !== 'string' || !initData.trim()) {
    return { ok: false, error: 'initData Telegram manquant.' };
  }
  if (typeof botToken !== 'string' || !botToken.trim()) {
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN non configuré sur le serveur.' };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) {
    return { ok: false, error: 'Signature Telegram invalide.' };
  }

  const authDate = Number.parseInt(params.get('auth_date') || '', 10);
  if (!Number.isFinite(authDate)) {
    return { ok: false, error: 'Horodatage Telegram manquant.' };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - authDate > maxAgeSecs || authDate - nowSec > 300) {
    return { ok: false, error: 'Session Telegram expirée, veuillez rouvrir la Mini App.' };
  }

  const entries = [];
  for (const [k, v] of params.entries()) {
    if (k === 'hash') continue;
    entries.push([k, v]);
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken.trim())
    .digest();
  const computedHex = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  const hashBuf = Buffer.from(hash.toLowerCase(), 'hex');
  const compBuf = Buffer.from(computedHex.toLowerCase(), 'hex');
  if (hashBuf.length !== compBuf.length || !crypto.timingSafeEqual(hashBuf, compBuf)) {
    return { ok: false, error: 'Authentification Telegram refusée.' };
  }

  let user = null;
  const rawUser = params.get('user');
  if (rawUser) {
    try {
      const parsed = JSON.parse(rawUser);
      if (parsed && (typeof parsed.id === 'number' || typeof parsed.id === 'string')) {
        user = {
          id: String(parsed.id),
          username: typeof parsed.username === 'string' ? parsed.username : null,
          first_name: typeof parsed.first_name === 'string' ? parsed.first_name : null,
        };
      }
    } catch {
      return { ok: false, error: 'Profil utilisateur Telegram illisible.' };
    }
  }
  if (!user) {
    return { ok: false, error: 'Utilisateur Telegram introuvable dans initData.' };
  }

  return { ok: true, user, authDate };
}

export function hashPasscode(passcode) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(passcode), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPasscodeHash(passcode, storedHash) {
  if (typeof passcode !== 'string' || typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hexDigest] = parts;
  if (!salt || !hexDigest) return false;
  try {
    const derived = crypto.scryptSync(passcode, salt, 64);
    const expected = Buffer.from(hexDigest, 'hex');
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function verifyEnvPasscode(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function redactSignalItem(s, idx) {
  if (idx < FREE_PREVIEW_LIMIT) {
    return { ...s, locked: false };
  }
  return {
    id: s.id,
    locked: true,
    category: s.category,
    category_label: s.category_label,
    fixture_key: s.fixture_key,
    home: s.home,
    away: s.away,
    league: s.league,
    country: s.country,
    date: s.date,
    date_label: s.date_label,
    tier: s.tier || null,
    tier_rank: s.tier_rank ?? null,
    tier_label: s.tier_label || null,
    market_short: s.market_short || null,
    proposal_rank: s.proposal_rank ?? null,
    total_volume_bf: s.total_volume_bf ?? null,
    pm_liquidity: s.pm_liquidity ?? null,
    score_sort: s.score_sort ?? 0,
    title: 'Signal verrouillé · Truevalue Pro',
    detail: 'Débloquez Truevalue Pro pour accéder au sens du pari, à l’edge net et au comparateur complet.',
    pm_url: null,
    net_edge_pp: null,
    prob_delta_pp: null,
    amplitude_pct: null,
    drop_pct: null,
    recommendation: null,
    market_data: null,
    config_summary: null,
    items: undefined,
  };
}

export function redactSignalsPayload(payload, auth) {
  if ((auth?.isPro || auth?.isAdmin) && !auth?.proPreviewOff) {
    return {
      ...payload,
      access: { is_pro: true, redacted: false, preview_limit: FREE_PREVIEW_LIMIT },
    };
  }
  const redactArr = (arr) => (Array.isArray(arr) ? arr.map((s, i) => redactSignalItem(s, i)) : []);
  const allSignals = redactArr(payload.all_signals);
  const lockedIds = new Set(allSignals.filter((s) => s.locked).map((s) => s.id));
  const redactById = (arr) =>
    Array.isArray(arr)
      ? arr.map((s, i) => (lockedIds.has(s.id) || i >= FREE_PREVIEW_LIMIT ? redactSignalItem(s, FREE_PREVIEW_LIMIT + i) : { ...s, locked: false }))
      : [];

  return {
    ...payload,
    access: {
      is_pro: false,
      redacted: allSignals.length > FREE_PREVIEW_LIMIT,
      preview_limit: FREE_PREVIEW_LIMIT,
    },
    executable_signals: redactById(payload.executable_signals),
    flow_signals: redactById(payload.flow_signals),
    configuration_signals: redactById(payload.configuration_signals),
    all_signals: allSignals,
  };
}

export function redactComparePayload(payload, auth) {
  if ((auth?.isPro || auth?.isAdmin) && !auth?.proPreviewOff) {
    return {
      ...payload,
      access: { is_pro: true, redacted: false, preview_limit: FREE_PREVIEW_LIMIT },
    };
  }
  const rows = Array.isArray(payload.rows)
    ? payload.rows.map((r, idx) => {
        if (idx < FREE_PREVIEW_LIMIT) return { ...r, locked: false };
        return {
          fixture_key: r.fixture_key,
          home: r.home,
          away: r.away,
          league: r.league,
          country: r.country,
          date: r.date,
          date_label: r.date_label,
          pm_matched: r.pm_matched,
          total_volume_bf: r.total_volume_bf,
          pm_liquidity: r.pm_liquidity,
          matched_markets_count: r.matched_markets_count,
          total_markets_count: r.total_markets_count,
          locked: true,
          pm_url: null,
          max_abs_gap_pp: null,
          max_exec_edge_pp: null,
          recommendations: [],
          observations: [],
          cross_checks: [],
          markets: [],
          rejection_summary: null,
        };
      })
    : [];

  return {
    ...payload,
    access: {
      is_pro: false,
      redacted: rows.length > FREE_PREVIEW_LIMIT,
      preview_limit: FREE_PREVIEW_LIMIT,
    },
    rows,
  };
}

export function redactConfigurationsPayload(payload, auth) {
  if ((auth?.isPro || auth?.isAdmin) && !auth?.proPreviewOff) {
    return {
      ...payload,
      access: { is_pro: true, redacted: false, preview_limit: FREE_PREVIEW_LIMIT },
    };
  }
  const rows = Array.isArray(payload.rows)
    ? payload.rows.map((r, idx) => {
        if (idx < FREE_PREVIEW_LIMIT) return { ...r, locked: false };
        return {
          fixture_key: r.fixture_key,
          home: r.home,
          away: r.away,
          league: r.league,
          country: r.country,
          date: r.date,
          date_label: r.date_label,
          pm_matched: r.pm_matched,
          total_volume_bf: r.total_volume_bf,
          pm_liquidity: r.pm_liquidity,
          markets_count: r.markets_count,
          interest_score: r.interest_score,
          locked: true,
          pm_url: null,
          signature: { code: '? | ? | ? | ?', is_complete: false, blocks_present: 0, pm_code: null },
          axes: {
            intensity: r.axes?.intensity || { level: 'Neutre', label: 'Pro requis' },
            variation: { label: 'Réservé Pro', class: 'locked', drop_pct: null, amplitude_pct: null },
            concordance: { contradictions: 0, convergences: 0, items: [] },
          },
          markets: [],
        };
      })
    : [];

  return {
    ...payload,
    access: {
      is_pro: false,
      redacted: rows.length > FREE_PREVIEW_LIMIT,
      preview_limit: FREE_PREVIEW_LIMIT,
    },
    rows,
  };
}
