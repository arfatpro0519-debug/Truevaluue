// Normalisation des lignes brutes Arbworld / Betfair sans scoring ni recommandation.

import { marketDef, MarketShape } from './market.js';

const MONTHS_FR = [
  'janv.',
  'févr.',
  'mars',
  'avr.',
  'mai',
  'juin',
  'juil.',
  'août',
  'sept.',
  'oct.',
  'nov.',
  'déc.',
];

function roundAway(value) {
  return Math.sign(value) * Math.round(Math.abs(value));
}

export function round1(value) {
  return roundAway(value * 10.0) / 10.0;
}

export function round2(value) {
  return roundAway(value * 100.0) / 100.0;
}

/**
 * Lit une date de coup d'envoi : RFC 3339 ou « AAAA-MM-JJ HH:MM:SS » en UTC.
 */
export function parseKickoff(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s) && s.includes('T')) {
    const ms = Date.parse(s);
    if (Number.isFinite(ms)) return new Date(ms);
  }

  const match = s.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?Z?$/
  );
  if (match) {
    const [, y, mo, d, h, mi, sec] = match;
    const ms = Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(sec || '0')
    );
    if (Number.isFinite(ms)) return new Date(ms);
  }

  return null;
}

/**
 * Formate une date RFC 3339 en « 9 nov. 20:00 » (heure UTC).
 */
export function formatDate(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s) && s.includes('T')) {
    const ms = Date.parse(s);
    if (Number.isFinite(ms)) {
      const dt = new Date(ms);
      const day = dt.getUTCDate();
      const month = MONTHS_FR[dt.getUTCMonth()] || MONTHS_FR[0];
      const hh = String(dt.getUTCHours()).padStart(2, '0');
      const mm = String(dt.getUTCMinutes()).padStart(2, '0');
      return `${day} ${month} ${hh}:${mm}`;
    }
  }
  return raw;
}

function num(obj, key) {
  if (!obj || typeof obj !== 'object') return 0.0;
  const x = obj[key];
  if (typeof x === 'number') return Number.isFinite(x) ? x : 0.0;
  if (typeof x === 'string') {
    const parsed = Number(x.trim());
    return Number.isFinite(parsed) ? parsed : 0.0;
  }
  return 0.0;
}

function text(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of keys) {
    const x = obj[key];
    if (typeof x === 'string' && x.trim().length > 0) {
      return x.trim();
    }
  }
  return '';
}

function intId(obj, key) {
  if (!obj || typeof obj !== 'object') return 0;
  const x = obj[key];
  if (typeof x === 'number' && Number.isFinite(x)) return Math.trunc(x);
  if (typeof x === 'string') {
    const n = Number.parseInt(x.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function optPositive(obj, key) {
  const n = num(obj, key);
  return n > 0.0 ? n : null;
}

function fillMulti(row, m) {
  const raw = Array.isArray(row.outcomes) ? row.outcomes : [];
  const outcomes = [];
  for (const o of raw) {
    const label = text(o, ['label']);
    if (!label) continue;
    outcomes.push({
      label,
      coef: optPositive(o, 'coef'),
      coef_new: optPositive(o, 'coef_new'),
      volume: Math.max(0.0, num(o, 'volume')),
      pct: 0.0,
    });
  }

  const total = outcomes.reduce((acc, o) => acc + o.volume, 0.0);
  m.total_volume = round2(total);

  for (const o of outcomes) {
    o.pct = total > 0.0 ? round1((o.volume / total) * 100.0) : 0.0;
  }
  outcomes.sort((a, b) => b.volume - a.volume);

  for (let i = 0; i < Math.min(3, outcomes.length); i++) {
    const o = outcomes[i];
    m.labels[i] = o.label;
    m.coef[i] = o.coef !== null ? o.coef : 0.0;
    m.coef_new[i] = o.coef_new !== null ? o.coef_new : o.coef !== null ? o.coef : 0.0;
    m.volume[i] = o.volume;
    m.share[i] = o.pct;
    m.implied[i] = m.coef_new[i] > 0.0 ? round1(100.0 / m.coef_new[i]) : 0.0;
    m.drop[i] =
      m.coef[i] > 0.0 ? round1(((m.coef_new[i] - m.coef[i]) / m.coef[i]) * 100.0) : 0.0;
  }

  m.outcomes = outcomes;
  const marketIdStr = m.market_id > 0 ? String(m.market_id) : '';
  m.betfair_chart_url = marketIdStr
    ? `https://graphs.betfair.com/1.${marketIdStr}/${m.selection_id}/0`
    : '';
  m.betfair_market_url = marketIdStr
    ? `https://www.betfair.com/exchange/plus/football/market/1.${marketIdStr}`
    : '';
}

function fillStructured(row, m, def) {
  const twoWay = def.shape === MarketShape.TwoWay;
  const coef = [num(row, 'coef_1'), num(row, 'coef_x'), num(row, 'coef_2')];
  const coefNewRaw = [
    num(row, 'coef_1_new'),
    num(row, 'coef_x_new'),
    num(row, 'coef_2_new'),
  ];
  const volumeRaw = [num(row, 'volume_1'), num(row, 'volume_x'), num(row, 'volume_2')];
  const active = [true, !twoWay, true];

  for (let i = 0; i < 3; i++) {
    if (!active[i]) continue;
    m.volume[i] = Math.max(0.0, volumeRaw[i]);
    m.coef[i] = coef[i] > 0.0 ? coef[i] : 0.0;
    m.coef_new[i] = coefNewRaw[i] > 0.0 ? coefNewRaw[i] : m.coef[i];
  }
  if (twoWay) {
    m.volume[1] = 0.0;
    m.coef[1] = 0.0;
    m.coef_new[1] = 0.0;
  }

  const total = m.volume[0] + m.volume[1] + m.volume[2];
  m.total_volume = round2(total);

  for (let i = 0; i < 3; i++) {
    m.share[i] = total > 0.0 && active[i] ? round1((m.volume[i] / total) * 100.0) : 0.0;
    m.drop[i] =
      m.coef[i] > 0.0 && m.coef_new[i] > 0.0
        ? round1(((m.coef_new[i] - m.coef[i]) / m.coef[i]) * 100.0)
        : 0.0;
  }

  const inv = [0, 1, 2].map((i) =>
    active[i] && m.coef_new[i] > 0.0 ? 1.0 / m.coef_new[i] : 0.0
  );
  const invSum = inv[0] + inv[1] + inv[2];
  for (let i = 0; i < 3; i++) {
    m.implied[i] = invSum > 0.0 ? round1((inv[i] / invSum) * 100.0) : 0.0;
  }

  const marketIdStr = m.market_id > 0 ? String(m.market_id) : '';
  m.betfair_chart_url = marketIdStr
    ? `https://graphs.betfair.com/1.${marketIdStr}/${m.selection_id}/0`
    : '';
  m.betfair_market_url = marketIdStr
    ? `https://www.betfair.com/exchange/plus/football/market/1.${marketIdStr}`
    : '';
}

export function enrich(rows, key, source, ageSeconds) {
  if (!Array.isArray(rows)) return [];
  const def = marketDef(key);
  const out = [];
  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    const home = text(row, ['home']);
    const away = text(row, ['away']);
    if (!home || !away) continue;

    const date = text(row, ['date']);
    const countryRaw = text(row, ['country']);
    const match = {
      id: `${intId(row, 'market_id')}_${intId(row, 'selection_id')}_${idx}`,
      market: def.key,
      shape: def.shape,
      date,
      date_label: formatDate(date),
      country: countryRaw.toUpperCase(),
      league: text(row, ['leage', 'league']) || 'Football',
      home,
      away,
      market_id: intId(row, 'market_id'),
      selection_id: intId(row, 'selection_id'),
      last_update: text(row, ['last_update']),
      labels: [def.slot_labels[0], def.slot_labels[1] || '', def.slot_labels[2]],
      coef: [0.0, 0.0, 0.0],
      coef_new: [0.0, 0.0, 0.0],
      volume: [0.0, 0.0, 0.0],
      total_volume: 0.0,
      share: [0.0, 0.0, 0.0],
      implied: [0.0, 0.0, 0.0],
      drop: [0.0, 0.0, 0.0],
      outcomes: [],
      source,
      age_seconds: ageSeconds,
      betfair_chart_url: '',
      betfair_market_url: '',
    };

    if (def.shape === MarketShape.Multi) {
      fillMulti(row, match);
    } else {
      fillStructured(row, match, def);
    }
    out.push(match);
  }
  return out;
}

const ACCENT_MAP = {
  à: 'a',
  â: 'a',
  ä: 'a',
  á: 'a',
  ã: 'a',
  å: 'a',
  é: 'e',
  è: 'e',
  ê: 'e',
  ë: 'e',
  í: 'i',
  ì: 'i',
  î: 'i',
  ï: 'i',
  ó: 'o',
  ò: 'o',
  ô: 'o',
  ö: 'o',
  õ: 'o',
  ú: 'u',
  ù: 'u',
  û: 'u',
  ü: 'u',
  ç: 'c',
  ñ: 'n',
  ß: 's',
};

const STOP_TOKENS = new Set([
  'fc',
  'cf',
  'sc',
  'ac',
  'as',
  'afc',
  'cd',
  'club',
  'de',
  'the',
]);

const ALIAS_TOKENS = {
  utd: 'united',
  co: 'county',
  ath: 'athletic',
  int: 'internazionale',
};

function isAlnumAscii(ch) {
  const code = ch.charCodeAt(0);
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}

const COUNTRY_PAREN_RE =
  /\(\s*(?:chile|chi|uae|ksa|egy|egypt|brazil|bra|argentina|arg|ecuador|ecu|peru|per|paraguay|par|colombia|col|uruguay|uru|bolivia|bol|mexico|mex|usa|eng|esp|ita|ger|fra|por|ned|tur|gre|sco|bel|sui|aut|den|nor|swe|pol|cro|cze|rou|bul|hun|srb|ukr|rus|isr|qat|jpn|kor|aus|chn|ind|jam|slv|nic|crc|pan)\s*\)/gi;

export function normalizeTeam(name) {
  const lower = String(name || '')
    .toLowerCase()
    .replace(COUNTRY_PAREN_RE, ' ');
  let out = '';
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    const folded = ACCENT_MAP[ch] || ch;
    out += isAlnumAscii(folded) ? folded : ' ';
  }
  const cleaned = out
    .trim()
    .split(/\s+/)
    .filter((tok) => tok && !STOP_TOKENS.has(tok))
    .map((tok) => ALIAS_TOKENS[tok] || tok)
    .join('');

  return cleaned || out.replace(/[^a-z0-9]/g, '');
}

export function fixtureKey(home, away) {
  return `${normalizeTeam(home)}_vs_${normalizeTeam(away)}`;
}
