// Source de données Polymarket Gamma API & CLOB (événements et sous-marchés bruts).

import { round1 } from './enrich.js';
import { MarketKey } from './market.js';
import * as th from './thresholds.js';

const DEFAULT_BASE_URL = 'https://gamma-api.polymarket.com';
const EVENT_BASE = 'https://polymarket.com/event/';
const MAX_CACHE_ENTRIES = 500;

const STOPWORDS = new Set([
  'fc',
  'cf',
  'club',
  'sc',
  'ac',
  'as',
  'afc',
  'cd',
  'the',
  'sv',
  'fk',
  'nk',
  'bk',
  'if',
  'rb',
  'de',
  'la',
  'el',
  'al',
]);

const TOKEN_ALIASES = {
  utd: 'united',
  ath: 'athletic',
  int: 'internazionale',
  st: 'saint',
};

const SPECIAL_FOLD = {
  ı: 'i',
  ł: 'l',
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  ß: 'ss',
  đ: 'd',
  ð: 'd',
  þ: 'th',
};

const EXCLUDED_CATEGORY_TOKENS = [
  'women',
  'ladies',
  'feminina',
  'femminile',
  'frauen',
  'u19',
  'u20',
  'u21',
  'u23',
  'youth',
  'reserves',
  'corners',
  'cards',
  'bookings',
];

const NON_1X2_MARKET_MARKERS = [
  'over',
  'under',
  'o u',
  'ou',
  '0 5',
  '1 5',
  '2 5',
  '3 5',
  '4 5',
  '5 5',
  '6 5',
  '7 5',
  '8 5',
  'odd',
  'even',
  'both teams',
  'btts',
  'spread',
  'handicap',
  'clean sheet',
  'win to nil',
  'to score',
  'winning margin',
  'first to',
  'last to',
  'anytime',
  'penalty',
  'penalties',
  'red card',
  'own goal',
  'first half',
  '1st half',
  'second half',
  '2nd half',
  'half time',
  'halftime',
  '1h',
  'ht ft',
  'corner',
  'card',
  'booking',
  'scorer',
  'goalscorer',
  'exact score',
  'correct score',
  'to qualify',
  'to advance',
  'draw no bet',
  'dnb',
  'double chance',
  'or draw',
  'draw or',
  'win or draw',
];

const DISALLOWED_SUBMARKET_MARKERS = [
  'first half',
  '1st half',
  'second half',
  '2nd half',
  '1h',
  'corner',
  'corners',
  'card',
  'cards',
  'booking',
  'bookings',
  'scorer',
  'goalscorer',
  'team total',
  'home goals',
  'away goals',
  'odd',
  'even',
  'clean sheet',
  'win to nil',
  'winning margin',
  'penalty',
  'penalties',
  'red card',
  'own goal',
  'spread',
  'handicap',
  'asian handicap',
];

function compileMarkerRegexes(markers) {
  return markers.map((marker) => {
    const escaped = marker
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+');
    return new RegExp(`\\b${escaped}\\b`);
  });
}

const NON_1X2_MARKER_REGEXES = compileMarkerRegexes(NON_1X2_MARKET_MARKERS);
const DISALLOWED_SUBMARKET_REGEXES = compileMarkerRegexes(DISALLOWED_SUBMARKET_MARKERS);

function isAlnumAscii(ch) {
  const code = ch.charCodeAt(0);
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}

export function normalizePolymarketText(raw) {
  const decomposed = String(raw || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  let out = '';
  for (let i = 0; i < decomposed.length; i++) {
    const ch = decomposed[i];
    const folded = SPECIAL_FOLD[ch] || ch;
    let added = false;
    for (let j = 0; j < folded.length; j++) {
      if (isAlnumAscii(folded[j])) {
        out += folded[j];
        added = true;
      }
    }
    if (!added && out.length > 0 && !out.endsWith(' ')) {
      out += ' ';
    }
  }
  return out.trim();
}

function foldRawLower(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

const COUNTRY_PAREN_RE =
  /\(\s*(?:chile|chi|uae|ksa|egy|egypt|brazil|bra|argentina|arg|ecuador|ecu|peru|per|paraguay|par|colombia|col|uruguay|uru|bolivia|bol|mexico|mex|usa|eng|esp|ita|ger|fra|por|ned|tur|gre|sco|bel|sui|aut|den|nor|swe|pol|cro|cze|rou|bul|hun|srb|ukr|rus|isr|qat|jpn|kor|aus|chn|ind|jam|slv|nic|crc|pan)\s*\)/gi;

export function tokens(name) {
  const cleaned = String(name || '').replace(COUNTRY_PAREN_RE, ' ');
  return normalizePolymarketText(cleaned)
    .split(' ')
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    .map((t) => TOKEN_ALIASES[t] || t);
}

function wordsSet(normalizedText) {
  return new Set(normalizedText ? normalizedText.split(' ') : []);
}

function teamMatchesBlob(teamTokens, blob, blobWords) {
  return teamTokens.every(
    (t) => blobWords.has(t) || (t.length >= 5 && blob.includes(t))
  );
}

export function eventMatches(home, away, kickoffAt, title, slug, end) {
  const homeTokens = tokens(home);
  const awayTokens = tokens(away);
  if (homeTokens.length === 0 || awayTokens.length === 0) return false;

  const normTitle = normalizePolymarketText(title);
  const normSlug = normalizePolymarketText(slug);
  const blob = `${normTitle} ${normSlug}`.trim();
  const blobWords = wordsSet(blob);

  if (!teamMatchesBlob(homeTokens, blob, blobWords)) return false;
  if (!teamMatchesBlob(awayTokens, blob, blobWords)) return false;

  const inputWords = new Set([...tokens(home), ...tokens(away)]);
  for (const excluded of EXCLUDED_CATEGORY_TOKENS) {
    if (blobWords.has(excluded) && !inputWords.has(excluded)) {
      return false;
    }
  }

  const endAt = end ? Date.parse(end) : NaN;
  if (kickoffAt && Number.isFinite(endAt)) {
    const hours = Math.abs(Math.trunc((endAt - kickoffAt.getTime()) / 3_600_000));
    return hours <= th.EXCHANGE_MATCH_MAX_HOURS;
  }
  return true;
}

function numVal(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const parsed = Number(v.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function probVal(v) {
  const n = numVal(v);
  if (n === null || n < 0.0 || n > 1.0) return null;
  return n;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function firstPrice(value) {
  const arr = parseJsonArray(value);
  return arr ? probVal(arr[0]) : null;
}

function secondPrice(value) {
  const arr = parseJsonArray(value);
  return arr && arr.length > 1 ? probVal(arr[1]) : null;
}

function firstString(value) {
  const arr = parseJsonArray(value);
  if (!arr || arr.length === 0) return null;
  const v = arr[0];
  return typeof v === 'string' && v.trim() ? v.trim() : v != null ? String(v) : null;
}

function outcomeQuote(market, label, overridePrice = undefined) {
  const rawBid = probVal(market?.bestBid);
  const rawAsk = probVal(market?.bestAsk);
  const isCrossed = rawBid !== null && rawAsk !== null && rawBid > rawAsk;
  const bid = isCrossed ? null : rawBid;
  const ask = isCrossed ? null : rawAsk;
  const bookSpread =
    bid !== null && ask !== null && ask >= bid ? ask - bid : null;
  const spread = numVal(market?.spread) ?? bookSpread;
  const last = probVal(market?.lastTradePrice);
  const listed =
    overridePrice !== undefined ? overridePrice : firstPrice(market?.outcomePrices);

  let price = null;
  if (bid !== null && ask !== null && ask >= bid) {
    const bookGap = ask - bid;
    if (bookGap <= th.EXCHANGE_TIGHT_SPREAD) {
      price = (ask + bid) / 2.0;
    } else if (last !== null) {
      price = last;
    } else if (bookGap <= th.EXCHANGE_MAX_SPREAD) {
      if (listed !== null) {
        price = listed;
      } else if (bid > 0.01 && ask < 0.99) {
        price = (ask + bid) / 2.0;
      }
    }
  } else if (bid === null && ask !== null) {
    // Carnet unilatéral sans acheteur (bestBid absent) : Gamma synthétise souvent ask/2 dans outcomePrices.
    if (last !== null) {
      price = last;
    } else if (ask <= th.EXCHANGE_TIGHT_SPREAD) {
      price = listed;
    }
  } else {
    const rawWideSpread = spread !== null && spread > th.EXCHANGE_MAX_SPREAD;
    price = last ?? (rawWideSpread ? null : listed) ?? null;
  }

  return {
    label,
    price,
    novig_pct: price !== null ? round1(price * 100.0) : null,
    bid,
    ask,
    spread,
    clob_token_id: firstString(market?.clobTokenIds),
    volume: numVal(market?.volume),
    volume_24h: numVal(market?.volume24hr),
    liquidity: numVal(market?.liquidity),
    change_1d: numVal(market?.oneDayPriceChange),
  };
}

function complementaryQuote(primary, label, fallbackPrice = null) {
  const p =
    primary.price !== null
      ? Math.max(0.0, Math.min(1.0, 1.0 - primary.price))
      : fallbackPrice;
  const bid =
    primary.ask !== null ? Math.max(0.0, Math.min(1.0, 1.0 - primary.ask)) : null;
  const ask =
    primary.bid !== null ? Math.max(0.0, Math.min(1.0, 1.0 - primary.bid)) : null;
  const spread =
    primary.spread ?? (bid !== null && ask !== null && ask >= bid ? ask - bid : null);
  return {
    label,
    price: p,
    novig_pct: p !== null ? round1(p * 100.0) : null,
    bid,
    ask,
    spread,
    volume: primary.volume,
    volume_24h: primary.volume_24h,
    liquidity: primary.liquidity,
    change_1d: primary.change_1d !== null ? -primary.change_1d : null,
  };
}

function hasNon1X2Marker(normalizedQuestion) {
  return NON_1X2_MARKER_REGEXES.some((re) => re.test(normalizedQuestion));
}

function hasDisallowedSubmarketMarker(normalizedText) {
  return DISALLOWED_SUBMARKET_REGEXES.some((re) => re.test(normalizedText));
}

function hasNonTeamOutcomes(market) {
  const labels = parseJsonArray(market?.outcomes);
  if (!labels || labels.length === 0) return false;
  const norm = labels.map((l) => normalizePolymarketText(l));
  return norm.some(
    (l) => l === 'over' || l === 'under' || l === 'odd' || l === 'even'
  );
}

function scoreTeamText(text, distinctiveTokens, allTokens) {
  if (!text) return 0;
  const words = wordsSet(text);
  let score = 0;
  for (const t of distinctiveTokens) {
    if (words.has(t) || (t.length >= 5 && text.includes(t))) {
      score += 10;
    }
  }
  for (const t of allTokens) {
    if (words.has(t) || (t.length >= 5 && text.includes(t))) {
      score += 1;
    }
  }
  return score;
}

function classifyTeamLabel(
  normText,
  homeTokens,
  awayTokens,
  homeDistinct,
  awayDistinct
) {
  if (!normText) return null;
  const normWords = wordsSet(normText);
  if (
    normWords.has('draw') ||
    normWords.has('tie') ||
    normWords.has('nul') ||
    normWords.has('x')
  ) {
    return 'N';
  }
  if (normWords.has('home') || normWords.has('1')) return '1';
  if (normWords.has('away') || normWords.has('2')) return '2';
  const homeScore = scoreTeamText(normText, homeDistinct, homeTokens);
  const awayScore = scoreTeamText(normText, awayDistinct, awayTokens);
  if (homeScore > 0 && homeScore > awayScore) return '1';
  if (awayScore > 0 && awayScore > homeScore) return '2';
  return null;
}

function eventSide(
  marketOrQuestion,
  homeTokens,
  awayTokens,
  homeDistinct,
  awayDistinct,
  normHome = '',
  normAway = ''
) {
  const question =
    typeof marketOrQuestion === 'string'
      ? marketOrQuestion
      : typeof marketOrQuestion?.question === 'string'
      ? marketOrQuestion.question
      : '';
  const groupTitle =
    typeof marketOrQuestion === 'object' &&
    typeof marketOrQuestion?.groupItemTitle === 'string'
      ? marketOrQuestion.groupItemTitle
      : '';

  const q = normalizePolymarketText(question);
  if (q && hasNon1X2Marker(q)) return null;

  const gt = normalizePolymarketText(groupTitle);
  if (gt && hasNon1X2Marker(gt)) return null;

  if (gt) {
    if (normHome && gt === normHome && gt !== normAway) return '1';
    if (normAway && gt === normAway && gt !== normHome) return '2';
    const byGroup = classifyTeamLabel(
      gt,
      homeTokens,
      awayTokens,
      homeDistinct,
      awayDistinct
    );
    if (byGroup) return byGroup;
  }

  return classifyTeamLabel(
    q,
    homeTokens,
    awayTokens,
    homeDistinct,
    awayDistinct
  );
}

const OU_KEYWORD_RE = /\b(?:over|under|o\s*\/\s*u|total|goals|buts)\b/;

function isOuLineText(rawLower, lineStr) {
  if (!rawLower || !lineStr) return false;
  if (/\b(?:spread|handicap)\b/.test(rawLower)) return false;
  const escaped = lineStr.replace('.', '[.,]');
  const lineRe = new RegExp(`\\b${escaped}\\b`);
  if (!lineRe.test(rawLower)) return false;
  const otherLines = ['0.5', '1.5', '2.5', '3.5', '4.5', '5.5']
    .filter((l) => l !== lineStr)
    .map((l) => l.replace('.', '[.,]'));
  const otherRe = new RegExp(`\\b(?:${otherLines.join('|')})\\b`);
  if (otherRe.test(rawLower)) return false;
  return OU_KEYWORD_RE.test(rawLower);
}

function hasTeamTokenMention(normText, ctx) {
  if (!normText || !ctx) return false;
  const words = wordsSet(normText);
  const allTeamTokens = [...(ctx.homeTokens || []), ...(ctx.awayTokens || [])];
  return allTeamTokens.some((t) => words.has(t) || (t.length >= 5 && normText.includes(t)));
}

function isBttsText(rawLower) {
  if (!rawLower) return false;
  return (
    rawLower.includes('both teams to score') ||
    rawLower.includes('btts') ||
    rawLower.includes('les deux equipes marquent')
  );
}

function isDoubleChanceText(rawLower) {
  if (!rawLower) return false;
  return (
    rawLower.includes('double chance') ||
    rawLower.includes('win or draw') ||
    rawLower.includes('or draw') ||
    rawLower.includes('draw or') ||
    /\b(?:1x|x2)\b/.test(rawLower)
  );
}

function isDrawNoBetText(rawLower) {
  if (!rawLower) return false;
  return (
    rawLower.includes('draw no bet') ||
    rawLower.includes('tie no bet') ||
    rawLower.includes('rembourse si nul') ||
    /\bdnb\b/.test(rawLower)
  );
}

function isFirstHalfText(rawLower) {
  if (!rawLower) return false;
  return (
    rawLower.includes('first half') ||
    rawLower.includes('1st half') ||
    rawLower.includes('half time result') ||
    rawLower.includes('halftime result') ||
    rawLower.includes('1st half winner') ||
    rawLower.includes('first half winner') ||
    rawLower.includes('1ere mi temps') ||
    rawLower.includes('1ere mi-temps') ||
    rawLower.includes('mi-temps') ||
    /\b1h\s+(?:result|winner|moneyline|1x2)\b/.test(rawLower)
  );
}

const FIRST_HALF_EXCLUDED_REGEXES = compileMarkerRegexes([
  'over',
  'under',
  'o u',
  'ou',
  '0 5',
  '1 5',
  '2 5',
  '3 5',
  '4 5',
  '5 5',
  '6 5',
  '7 5',
  '8 5',
  'odd',
  'even',
  'total',
  'goals',
  'buts',
  'btts',
  'both teams',
  'clean sheet',
  'win to nil',
  'to score',
  'winning margin',
  'first to',
  'last to',
  'anytime',
  'penalty',
  'penalties',
  'red card',
  'own goal',
  'spread',
  'handicap',
  'corner',
  'corners',
  'card',
  'cards',
  'booking',
  'bookings',
  'scorer',
  'goalscorer',
  'double chance',
  'draw no bet',
  'dnb',
  'ht ft',
  'half time full time',
  'halftime fulltime',
  'exact score',
  'correct score',
  'second half',
  '2nd half',
]);

function hasFirstHalfExcludedMarker(normText) {
  if (!normText) return false;
  return FIRST_HALF_EXCLUDED_REGEXES.some((re) => re.test(normText));
}

function isHtFtText(rawLower) {
  if (!rawLower) return false;
  return (
    rawLower.includes('ht/ft') ||
    rawLower.includes('ht / ft') ||
    rawLower.includes('half time/full time') ||
    rawLower.includes('halftime/fulltime') ||
    rawLower.includes('half-time/full-time') ||
    rawLower.includes('half time full time') ||
    rawLower.includes('halftime fulltime') ||
    rawLower.includes('mi-temps / fin')
  );
}

function isCorrectScoreText(rawLower) {
  if (!rawLower) return false;
  return (
    rawLower.includes('correct score') ||
    rawLower.includes('exact score') ||
    rawLower.includes('score exact')
  );
}

function parseHtFtCombo(raw, ctx) {
  const folded = foldRawLower(raw);
  const slashIdx = folded.indexOf('/');
  let leftRaw = '';
  let rightRaw = '';
  if (slashIdx > 0) {
    leftRaw = folded.slice(0, slashIdx);
    rightRaw = folded.slice(slashIdx + 1);
  } else {
    const dashMatch = folded.match(/([a-z0-9 ]+?)\s*[-–]\s*([a-z0-9 ]+)/);
    if (dashMatch) {
      leftRaw = dashMatch[1];
      rightRaw = dashMatch[2];
    }
  }
  if (!leftRaw || !rightRaw) return null;

  const mapSide = (part) => {
    const norm = normalizePolymarketText(part);
    const side = classifyTeamLabel(
      norm,
      ctx.homeTokens,
      ctx.awayTokens,
      ctx.homeDistinct,
      ctx.awayDistinct
    );
    if (!side) return null;
    return side === 'N' ? 'X' : side;
  };

  const l = mapSide(leftRaw);
  const r = mapSide(rightRaw);
  if (!l || !r) return null;
  return `${l}/${r}`;
}

function parseExactScoreLabel(raw, ctx) {
  const folded = foldRawLower(raw);
  const m = folded.match(/(?:^|[^0-9.])(\d{1,2})\s*[-:]\s*(\d{1,2})(?:$|[^0-9.])/);
  if (!m) return null;
  let h = Number.parseInt(m[1], 10);
  let a = Number.parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(a) || h > 9 || a > 9) return null;

  // Si un libellé mentionne uniquement l'équipe extérieure avant le score (ex: "Chelsea 2-1"),
  // on remet dans l'ordre Domicile-Extérieur.
  const prefix = normalizePolymarketText(folded.slice(0, m.index));
  if (prefix) {
    const hScore = scoreTeamText(prefix, ctx.homeDistinct, ctx.homeTokens);
    const aScore = scoreTeamText(prefix, ctx.awayDistinct, ctx.awayTokens);
    if (aScore > 0 && hScore === 0) {
      [h, a] = [a, h];
    }
  }
  return `${h}-${a}`;
}

function applyNoVig(outcomes, isCompleteSet, targetSum = 1.0) {
  if (!outcomes || outcomes.length === 0) return null;
  const prices = outcomes.map((o) => o.price);
  const validAll = prices.every(
    (p) => typeof p === 'number' && Number.isFinite(p) && p > 0.0
  );
  const sum = prices.reduce(
    (acc, p) => acc + (typeof p === 'number' && Number.isFinite(p) ? p : 0.0),
    0.0
  );
  for (const o of outcomes) {
    if (typeof o.price !== 'number' || !Number.isFinite(o.price)) {
      o.novig_pct = null;
    } else if (isCompleteSet && validAll && sum > 0.0) {
      o.novig_pct = round1((o.price / sum) * 100.0 * targetSum);
    } else {
      o.novig_pct = round1(o.price * 100.0);
    }
  }
  if (isCompleteSet && validAll) {
    return round1((sum - targetSum) * 100.0);
  }
  return null;
}

export function assessMarketBookQuality(outcomes, eventVolume = 0, eventLiquidity = 0) {
  const list = Array.isArray(outcomes) ? outcomes : [];
  if (list.length === 0) {
    return { usable: false, reason: 'aucune issue cotée', spread: null, liquidity: 0 };
  }
  const priced = list.filter(
    (o) => typeof o.price === 'number' && Number.isFinite(o.price)
  );
  if (priced.length === 0) {
    return { usable: false, reason: 'prix absent', spread: null, liquidity: 0 };
  }

  let maxLiq = 0;
  let maxVol24 = 0;
  let maxVol = 0;
  let worstSpread = null;
  let hasSpread = false;

  for (const o of priced) {
    if (typeof o.liquidity === 'number') maxLiq = Math.max(maxLiq, o.liquidity);
    if (typeof o.volume_24h === 'number') maxVol24 = Math.max(maxVol24, o.volume_24h);
    if (typeof o.volume === 'number') maxVol = Math.max(maxVol, o.volume);
    if (typeof o.spread === 'number' && Number.isFinite(o.spread)) {
      hasSpread = true;
      worstSpread = worstSpread === null ? o.spread : Math.max(worstSpread, o.spread);
    }
  }

  const effectiveLiq = Math.max(maxLiq, maxVol24, eventLiquidity || 0);
  const activityOk =
    maxLiq >= th.EXCHANGE_ENGINE_MIN_LIQUIDITY ||
    maxVol24 >= th.EXCHANGE_ENGINE_MIN_LIQUIDITY ||
    maxVol >= th.EXCHANGE_ENGINE_MIN_LIQUIDITY * 2 ||
    (eventVolume || 0) >= th.EXCHANGE_ENGINE_MIN_LIQUIDITY * 2;

  if (!activityOk) {
    return {
      usable: false,
      reason: 'liquidité insuffisante',
      spread: worstSpread,
      liquidity: effectiveLiq,
    };
  }
  if (hasSpread && worstSpread > th.EXCHANGE_TIGHT_SPREAD) {
    return {
      usable: false,
      reason: `spread trop large (${(worstSpread * 100).toFixed(0)} pts)`,
      spread: worstSpread,
      liquidity: effectiveLiq,
    };
  }

  return {
    usable: true,
    reason: null,
    spread: worstSpread,
    liquidity: effectiveLiq,
  };
}

function buildSubMarket(
  key,
  label,
  outcomes,
  completeSet,
  eventVolume,
  eventLiquidity,
  targetSum = 1.0
) {
  const overroundPct = applyNoVig(outcomes, completeSet, targetSum);
  const quality = assessMarketBookQuality(outcomes, eventVolume, eventLiquidity);
  const volume = outcomes.reduce(
    (acc, o) => Math.max(acc, typeof o.volume === 'number' ? o.volume : 0),
    0
  );
  const volume24h = outcomes.reduce(
    (acc, o) => Math.max(acc, typeof o.volume_24h === 'number' ? o.volume_24h : 0),
    0
  );
  return {
    key,
    label,
    outcomes,
    overround_pct: overroundPct,
    volume: volume > 0 ? volume : null,
    volume_24h: volume24h > 0 ? volume24h : null,
    liquidity: quality.liquidity > 0 ? quality.liquidity : null,
    spread: quality.spread,
    usable: quality.usable,
    quality_reason: quality.reason,
  };
}

function parseBinaryOverUnderLine(
  markets,
  lineStr,
  marketKey,
  marketLabel,
  eventVolume,
  eventLiquidity,
  ctx = null
) {
  let under = null;
  let over = null;
  const lineEsc = lineStr.replace('.', '[.,]');
  const underLineRe = new RegExp(`\\bunder\\s+${lineEsc}\\b`);
  const overLineRe = new RegExp(`\\bover\\s+${lineEsc}\\b`);

  for (const market of markets) {
    const qRaw = foldRawLower(market?.question || '');
    const gtRaw = foldRawLower(market?.groupItemTitle || '');
    const combinedNorm = `${normalizePolymarketText(qRaw)} ${normalizePolymarketText(gtRaw)}`.trim();
    if (hasDisallowedSubmarketMarker(combinedNorm)) continue;
    if (!isOuLineText(qRaw, lineStr) && !isOuLineText(gtRaw, lineStr)) continue;
    if (ctx) {
      const gtNorm = normalizePolymarketText(gtRaw);
      if (gtNorm && hasTeamTokenMention(gtNorm, ctx)) continue;
      if (!gtNorm && qRaw.includes(':')) {
        const afterColon = normalizePolymarketText(qRaw.slice(qRaw.indexOf(':') + 1));
        if (hasTeamTokenMention(afterColon, ctx)) continue;
      }
    }

    const labels = parseJsonArray(market?.outcomes);
    const prices = parseJsonArray(market?.outcomePrices);
    if (labels && prices && labels.length === 2 && prices.length === 2) {
      const l0 = foldRawLower(labels[0]);
      const l1 = foldRawLower(labels[1]);
      if (l0.includes('over') && l1.includes('under')) {
        const qOver = outcomeQuote(market, 'Over', probVal(prices[0]));
        const qUnder = complementaryQuote(qOver, 'Under', probVal(prices[1]));
        over = over || qOver;
        under = under || qUnder;
        break;
      }
      if (l0.includes('under') && l1.includes('over')) {
        const qUnder = outcomeQuote(market, 'Under', probVal(prices[0]));
        const qOver = complementaryQuote(qUnder, 'Over', probVal(prices[1]));
        under = under || qUnder;
        over = over || qOver;
        break;
      }
    }

    const q = outcomeQuote(market, 'Over');
    const isUnderQuestion =
      (gtRaw.includes('under') && !gtRaw.includes('over')) ||
      (underLineRe.test(qRaw) && !overLineRe.test(qRaw));
    if (isUnderQuestion) {
      under = under || { ...q, label: 'Under' };
      if (!over && (!labels || labels.some((l) => foldRawLower(l) === 'no'))) {
        over = complementaryQuote(under, 'Over', secondPrice(market?.outcomePrices));
      }
    } else {
      over = over || q;
      if (!under && (!labels || labels.some((l) => foldRawLower(l) === 'no'))) {
        under = complementaryQuote(over, 'Under', secondPrice(market?.outcomePrices));
      }
    }
  }

  if (!under && !over) return null;
  const list = [under, over].filter(Boolean);
  return buildSubMarket(
    marketKey,
    marketLabel,
    list,
    list.length === 2,
    eventVolume,
    eventLiquidity
  );
}

function classifyDoubleChanceLabel(raw, ctx) {
  const norm = normalizePolymarketText(raw);
  if (!norm) return null;
  const words = wordsSet(norm);
  if (words.has('1x') || norm === 'home or draw' || norm === 'draw or home') return '1X';
  if (words.has('x2') || norm === 'draw or away' || norm === 'away or draw') return 'X2';
  if (
    words.has('12') ||
    norm === 'home or away' ||
    norm === 'away or home' ||
    norm.includes('either team') ||
    norm.includes('no draw')
  ) {
    return '12';
  }
  const hasDraw = words.has('draw') || words.has('tie') || words.has('nul') || words.has('x');
  const hScore = scoreTeamText(norm, ctx.homeDistinct, ctx.homeTokens);
  const aScore = scoreTeamText(norm, ctx.awayDistinct, ctx.awayTokens);
  if (hasDraw && hScore > 0 && aScore === 0) return '1X';
  if (hasDraw && aScore > 0 && hScore === 0) return 'X2';
  if (!hasDraw && hScore > 0 && aScore > 0) return '12';
  return null;
}

function parseDoubleChanceMarket(
  markets,
  ctx,
  eventTitleLower,
  eventVolume,
  eventLiquidity
) {
  const outcomes = [];
  const seen = new Set();
  const eventIsDc = isDoubleChanceText(eventTitleLower);

  for (const market of markets) {
    const qRaw = foldRawLower(market?.question || '');
    const gtRaw = foldRawLower(market?.groupItemTitle || '');
    const combinedNorm = `${normalizePolymarketText(qRaw)} ${normalizePolymarketText(gtRaw)}`.trim();
    if (hasDisallowedSubmarketMarker(combinedNorm) || hasNonTeamOutcomes(market)) continue;
    if (!eventIsDc && !isDoubleChanceText(qRaw) && !isDoubleChanceText(gtRaw)) {
      continue;
    }

    const labels = parseJsonArray(market?.outcomes);
    const prices = parseJsonArray(market?.outcomePrices);
    if (labels && prices && labels.length > 2 && labels.length === prices.length) {
      for (let i = 0; i < labels.length; i++) {
        const code = classifyDoubleChanceLabel(labels[i], ctx);
        const p = probVal(prices[i]);
        if (!code || p === null || seen.has(code)) continue;
        seen.add(code);
        outcomes.push({
          label: code,
          price: p,
          novig_pct: round1(p * 100.0),
          bid: null,
          ask: null,
          spread: null,
          volume: numVal(market?.volume),
          volume_24h: numVal(market?.volume24hr),
          liquidity: numVal(market?.liquidity),
          change_1d: numVal(market?.oneDayPriceChange),
        });
      }
      continue;
    }

    const code =
      classifyDoubleChanceLabel(gtRaw, ctx) ||
      classifyDoubleChanceLabel(qRaw, ctx);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    outcomes.push(outcomeQuote(market, code));
  }

  if (outcomes.length === 0) return null;
  const order = { '1X': 0, X2: 1, '12': 2 };
  outcomes.sort((a, b) => (order[a.label] ?? 9) - (order[b.label] ?? 9));
  return buildSubMarket(
    MarketKey.DoubleChance,
    'Double chance',
    outcomes,
    outcomes.length === 3,
    eventVolume,
    eventLiquidity,
    2.0
  );
}

function parseDrawNoBetMarket(
  markets,
  ctx,
  eventTitleLower,
  eventVolume,
  eventLiquidity
) {
  let homeQ = null;
  let awayQ = null;
  const eventIsDnb = isDrawNoBetText(eventTitleLower);

  for (const market of markets) {
    const qRaw = foldRawLower(market?.question || '');
    const gtRaw = foldRawLower(market?.groupItemTitle || '');
    const combinedNorm = `${normalizePolymarketText(qRaw)} ${normalizePolymarketText(gtRaw)}`.trim();
    if (hasDisallowedSubmarketMarker(combinedNorm) || hasNonTeamOutcomes(market)) continue;
    if (!eventIsDnb && !isDrawNoBetText(qRaw) && !isDrawNoBetText(gtRaw)) {
      continue;
    }

    const labels = parseJsonArray(market?.outcomes);
    const prices = parseJsonArray(market?.outcomePrices);
    if (labels && prices && labels.length === 2 && prices.length === 2) {
      const s0 = classifyTeamLabel(
        normalizePolymarketText(labels[0]),
        ctx.homeTokens,
        ctx.awayTokens,
        ctx.homeDistinct,
        ctx.awayDistinct
      );
      const s1 = classifyTeamLabel(
        normalizePolymarketText(labels[1]),
        ctx.homeTokens,
        ctx.awayTokens,
        ctx.homeDistinct,
        ctx.awayDistinct
      );
      if ((s0 === '1' && s1 === '2') || (s0 === '2' && s1 === '1')) {
        const p0 = probVal(prices[0]);
        const p1 = probVal(prices[1]);
        const firstSide = s0 === '1' ? '1' : '2';
        const secondSide = s1 === '1' ? '1' : '2';
        const q0 = outcomeQuote(market, firstSide, p0);
        const q1 = complementaryQuote(q0, secondSide, p1);
        homeQ = s0 === '1' ? q0 : q1;
        awayQ = s0 === '1' ? q1 : q0;
        break;
      }
    }

    const side =
      classifyTeamLabel(
        normalizePolymarketText(gtRaw),
        ctx.homeTokens,
        ctx.awayTokens,
        ctx.homeDistinct,
        ctx.awayDistinct
      ) ||
      classifyTeamLabel(
        normalizePolymarketText(qRaw),
        ctx.homeTokens,
        ctx.awayTokens,
        ctx.homeDistinct,
        ctx.awayDistinct
      );
    if (side === '1' && !homeQ) {
      homeQ = outcomeQuote(market, '1');
      if (!awayQ && labels && labels.some((l) => foldRawLower(l) === 'no')) {
        awayQ = complementaryQuote(homeQ, '2', secondPrice(market?.outcomePrices));
      }
    } else if (side === '2' && !awayQ) {
      awayQ = outcomeQuote(market, '2');
      if (!homeQ && labels && labels.some((l) => foldRawLower(l) === 'no')) {
        homeQ = complementaryQuote(awayQ, '1', secondPrice(market?.outcomePrices));
      }
    }
  }

  const list = [homeQ, awayQ].filter(Boolean);
  if (list.length === 0) return null;
  return buildSubMarket(
    MarketKey.DrawNoBet,
    'DNB',
    list,
    list.length === 2,
    eventVolume,
    eventLiquidity
  );
}

function parseHalfTime1X2Market(
  markets,
  ctx,
  eventTitleLower,
  eventVolume,
  eventLiquidity
) {
  const outcomes = [];
  const seen = new Set();
  const eventIsHalf =
    isFirstHalfText(eventTitleLower) && !isHtFtText(eventTitleLower);

  for (const market of markets) {
    if (hasNonTeamOutcomes(market)) continue;
    const qRaw = foldRawLower(market?.question || '');
    const gtRaw = foldRawLower(market?.groupItemTitle || '');
    if (isHtFtText(qRaw) || isHtFtText(gtRaw)) continue;
    const isHalf = eventIsHalf || isFirstHalfText(qRaw) || isFirstHalfText(gtRaw);
    if (!isHalf) continue;
    const combinedNorm = `${normalizePolymarketText(qRaw)} ${normalizePolymarketText(gtRaw)}`.trim();
    if (hasFirstHalfExcludedMarker(combinedNorm)) continue;

    const labels = parseJsonArray(market?.outcomes);
    const prices = parseJsonArray(market?.outcomePrices);
    if (labels && prices && labels.length === 3 && prices.length === 3) {
      for (let i = 0; i < 3; i++) {
        const side = classifyTeamLabel(
          normalizePolymarketText(labels[i]),
          ctx.homeTokens,
          ctx.awayTokens,
          ctx.homeDistinct,
          ctx.awayDistinct
        );
        const p = probVal(prices[i]);
        if (!side || p === null || seen.has(side)) continue;
        seen.add(side);
        outcomes.push({
          label: side,
          price: p,
          novig_pct: round1(p * 100.0),
          bid: null,
          ask: null,
          spread: null,
          volume: numVal(market?.volume),
          volume_24h: numVal(market?.volume24hr),
          liquidity: numVal(market?.liquidity),
          change_1d: numVal(market?.oneDayPriceChange),
        });
      }
      if (outcomes.length === 3) break;
    }

    const side =
      classifyTeamLabel(
        normalizePolymarketText(gtRaw),
        ctx.homeTokens,
        ctx.awayTokens,
        ctx.homeDistinct,
        ctx.awayDistinct
      ) ||
      classifyTeamLabel(
        normalizePolymarketText(qRaw),
        ctx.homeTokens,
        ctx.awayTokens,
        ctx.homeDistinct,
        ctx.awayDistinct
      );
    if (!side || seen.has(side)) continue;
    seen.add(side);
    outcomes.push(outcomeQuote(market, side));
  }

  // Un marché 1X2 mi-temps incomplet (< 3 issues : 1, N, 2) est exclu pour éviter les faux écarts
  if (outcomes.length < 3) return null;
  const order = { '1': 0, N: 1, '2': 2 };
  outcomes.sort((a, b) => (order[a.label] ?? 9) - (order[b.label] ?? 9));
  return buildSubMarket(
    MarketKey.HalfTime,
    'Mi-temps',
    outcomes,
    outcomes.length === 3,
    eventVolume,
    eventLiquidity
  );
}

function parseBinaryBtts(markets, eventVolume, eventLiquidity) {
  let yesQ = null;
  let noQ = null;

  for (const market of markets) {
    const qRaw = foldRawLower(market?.question || '');
    const gtRaw = foldRawLower(market?.groupItemTitle || '');
    const combinedNorm = `${normalizePolymarketText(qRaw)} ${normalizePolymarketText(gtRaw)}`.trim();
    if (hasDisallowedSubmarketMarker(combinedNorm)) continue;
    if (!isBttsText(qRaw) && !isBttsText(gtRaw)) continue;

    const labels = parseJsonArray(market?.outcomes);
    const prices = parseJsonArray(market?.outcomePrices);
    const l0 = labels && labels[0] ? foldRawLower(labels[0]) : 'yes';
    const isNoFirst = l0 === 'no' || l0 === 'non';

    if (isNoFirst) {
      noQ = outcomeQuote(market, 'Non', prices ? probVal(prices[0]) : undefined);
      yesQ = complementaryQuote(noQ, 'Oui', prices ? probVal(prices[1]) : null);
    } else {
      yesQ = outcomeQuote(market, 'Oui', prices ? probVal(prices[0]) : undefined);
      noQ = complementaryQuote(yesQ, 'Non', prices ? probVal(prices[1]) : null);
    }
    break;
  }

  if (!yesQ && !noQ) return null;
  const list = [yesQ, noQ].filter(Boolean);
  return buildSubMarket(
    MarketKey.Btts,
    'BTTS',
    list,
    list.length === 2,
    eventVolume,
    eventLiquidity
  );
}

function parseHtFtMarket(markets, ctx, eventTitleLower, eventVolume, eventLiquidity) {
  const outcomes = [];
  const seen = new Set();
  const eventIsHtFt = isHtFtText(eventTitleLower);

  for (const market of markets) {
    const qRaw = foldRawLower(market?.question || '');
    const gtRaw = foldRawLower(market?.groupItemTitle || '');
    if (!eventIsHtFt && !isHtFtText(qRaw) && !isHtFtText(gtRaw)) continue;

    const labels = parseJsonArray(market?.outcomes);
    const prices = parseJsonArray(market?.outcomePrices);
    if (labels && prices && labels.length > 2 && labels.length === prices.length) {
      for (let i = 0; i < labels.length; i++) {
        const combo = parseHtFtCombo(labels[i], ctx);
        const p = probVal(prices[i]);
        if (!combo || p === null || seen.has(combo)) continue;
        seen.add(combo);
        outcomes.push({
          label: combo,
          price: p,
          novig_pct: round1(p * 100.0),
          bid: null,
          ask: null,
          spread: null,
          volume: numVal(market?.volume),
          volume_24h: numVal(market?.volume24hr),
          liquidity: numVal(market?.liquidity),
          change_1d: numVal(market?.oneDayPriceChange),
        });
      }
      continue;
    }

    const combo =
      parseHtFtCombo(gtRaw, ctx) || parseHtFtCombo(qRaw, ctx);
    if (!combo || seen.has(combo)) continue;
    seen.add(combo);
    outcomes.push(outcomeQuote(market, combo));
  }

  const quoted = outcomes.filter(
    (o) => typeof o.price === 'number' && Number.isFinite(o.price)
  );
  if (quoted.length === 0) return null;
  quoted.sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
  return buildSubMarket(
    MarketKey.HalfTimeFullTime,
    'MT / FM',
    quoted,
    quoted.length >= 9,
    eventVolume,
    eventLiquidity
  );
}

function parseCorrectScoreMarket(
  markets,
  ctx,
  eventTitleLower,
  eventVolume,
  eventLiquidity
) {
  const outcomes = [];
  const seen = new Set();
  const eventIsCs = isCorrectScoreText(eventTitleLower);

  for (const market of markets) {
    const qRaw = foldRawLower(market?.question || '');
    const gtRaw = foldRawLower(market?.groupItemTitle || '');
    const combinedNorm = `${normalizePolymarketText(qRaw)} ${normalizePolymarketText(gtRaw)}`.trim();
    if (hasDisallowedSubmarketMarker(combinedNorm)) continue;
    if (!eventIsCs && !isCorrectScoreText(qRaw) && !isCorrectScoreText(gtRaw)) {
      continue;
    }

    const labels = parseJsonArray(market?.outcomes);
    const prices = parseJsonArray(market?.outcomePrices);
    if (labels && prices && labels.length > 2 && labels.length === prices.length) {
      for (let i = 0; i < labels.length; i++) {
        const scoreLabel = parseExactScoreLabel(labels[i], ctx);
        const p = probVal(prices[i]);
        if (!scoreLabel || p === null || seen.has(scoreLabel)) continue;
        seen.add(scoreLabel);
        outcomes.push({
          label: scoreLabel,
          price: p,
          novig_pct: round1(p * 100.0),
          bid: null,
          ask: null,
          spread: null,
          volume: numVal(market?.volume),
          volume_24h: numVal(market?.volume24hr),
          liquidity: numVal(market?.liquidity),
          change_1d: numVal(market?.oneDayPriceChange),
        });
      }
      continue;
    }

    const scoreLabel =
      parseExactScoreLabel(gtRaw, ctx) || parseExactScoreLabel(qRaw, ctx);
    if (!scoreLabel || seen.has(scoreLabel)) continue;
    seen.add(scoreLabel);
    outcomes.push(outcomeQuote(market, scoreLabel));
  }

  const quoted = outcomes.filter(
    (o) => typeof o.price === 'number' && Number.isFinite(o.price)
  );
  if (quoted.length === 0) return null;
  quoted.sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
  return buildSubMarket(
    MarketKey.CorrectScore,
    'Score exact',
    quoted.slice(0, 12),
    false,
    eventVolume,
    eventLiquidity
  );
}

export function parsePolymarketEvent(event, home, away) {
  const normHome = normalizePolymarketText(home);
  const normAway = normalizePolymarketText(away);
  const homeTokens = tokens(home);
  const awayTokens = tokens(away);
  const homeSet = new Set(homeTokens);
  const awaySet = new Set(awayTokens);
  const homeDistinct = homeTokens.filter((t) => !awaySet.has(t));
  const awayDistinct = awayTokens.filter((t) => !homeSet.has(t));
  const ctx = { homeTokens, awayTokens, homeDistinct, awayDistinct };

  const outcomes = [];
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  for (const market of markets) {
    if (hasNonTeamOutcomes(market)) continue;
    const label = eventSide(
      market,
      homeTokens,
      awayTokens,
      homeDistinct,
      awayDistinct,
      normHome,
      normAway
    );
    if (!label) continue;
    if (outcomes.some((o) => o.label === label)) continue;
    outcomes.push(outcomeQuote(market, label));
  }

  // Secours : marché unique multi-issues (ex. outcomes = ["Home", "Draw", "Away"])
  if (outcomes.length === 0) {
    for (const market of markets) {
      const q = normalizePolymarketText(market?.question || '');
      if (q && hasNon1X2Marker(q)) continue;
      const labels = parseJsonArray(market?.outcomes);
      const prices = parseJsonArray(market?.outcomePrices);
      if (!labels || !prices || labels.length !== 3 || prices.length !== 3) continue;
      const extracted = [];
      for (let i = 0; i < 3; i++) {
        const label = classifyTeamLabel(
          normalizePolymarketText(labels[i]),
          homeTokens,
          awayTokens,
          homeDistinct,
          awayDistinct
        );
        const p = probVal(prices[i]);
        if (!label || p === null || extracted.some((o) => o.label === label)) continue;
        extracted.push({
          label,
          price: p,
          novig_pct: round1(p * 100.0),
          bid: null,
          ask: null,
          spread: null,
          volume: numVal(market?.volume),
          volume_24h: numVal(market?.volume24hr),
          liquidity: numVal(market?.liquidity),
          change_1d: numVal(market?.oneDayPriceChange),
        });
      }
      if (extracted.length === 3) {
        outcomes.push(...extracted);
        break;
      }
    }
  }

  const order = { '1': 0, N: 1, '2': 2 };
  outcomes.sort((a, b) => (order[a.label] ?? 2) - (order[b.label] ?? 2));

  const evVolume = numVal(event?.volume);
  const evLiquidity = numVal(event?.liquidity);
  const overroundPct = applyNoVig(outcomes, outcomes.length === 3);

  const eventTitleLower = foldRawLower(event?.title || '');
  const subMarkets = {};
  if (outcomes.length > 0) {
    subMarkets[MarketKey.OneXTwo] = buildSubMarket(
      MarketKey.OneXTwo,
      '1X2',
      outcomes,
      outcomes.length === 3,
      evVolume,
      evLiquidity
    );
  }
  const ou15 = parseBinaryOverUnderLine(
    markets,
    '1.5',
    MarketKey.OverUnder15,
    '+/- 1.5',
    evVolume,
    evLiquidity,
    ctx
  );
  if (ou15) subMarkets[MarketKey.OverUnder15] = ou15;

  const ou25 = parseBinaryOverUnderLine(
    markets,
    '2.5',
    MarketKey.OverUnder25,
    '+/- 2.5',
    evVolume,
    evLiquidity,
    ctx
  );
  if (ou25) subMarkets[MarketKey.OverUnder25] = ou25;

  const ou35 = parseBinaryOverUnderLine(
    markets,
    '3.5',
    MarketKey.OverUnder35,
    '+/- 3.5',
    evVolume,
    evLiquidity,
    ctx
  );
  if (ou35) subMarkets[MarketKey.OverUnder35] = ou35;

  const dc = parseDoubleChanceMarket(
    markets,
    ctx,
    eventTitleLower,
    evVolume,
    evLiquidity
  );
  if (dc) subMarkets[MarketKey.DoubleChance] = dc;

  const dnb = parseDrawNoBetMarket(
    markets,
    ctx,
    eventTitleLower,
    evVolume,
    evLiquidity
  );
  if (dnb) subMarkets[MarketKey.DrawNoBet] = dnb;

  const btts = parseBinaryBtts(markets, evVolume, evLiquidity);
  if (btts) subMarkets[MarketKey.Btts] = btts;

  const ht = parseHalfTime1X2Market(
    markets,
    ctx,
    eventTitleLower,
    evVolume,
    evLiquidity
  );
  if (ht) subMarkets[MarketKey.HalfTime] = ht;

  const htFt = parseHtFtMarket(markets, ctx, eventTitleLower, evVolume, evLiquidity);
  if (htFt) subMarkets[MarketKey.HalfTimeFullTime] = htFt;

  const cs = parseCorrectScoreMarket(
    markets,
    ctx,
    eventTitleLower,
    evVolume,
    evLiquidity
  );
  if (cs) subMarkets[MarketKey.CorrectScore] = cs;

  const slug = typeof event?.slug === 'string' ? event.slug : '';
  const safeSlug = slug
    ? slug
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/')
    : '';
  return {
    slug,
    url: `${EVENT_BASE}${safeSlug}`,
    title: typeof event?.title === 'string' ? event.title : '',
    volume: evVolume,
    volume_24h: numVal(event?.volume24hr),
    volume_1wk: numVal(event?.volume1wk),
    liquidity: evLiquidity,
    open_interest: numVal(event?.openInterest),
    overround_pct: overroundPct,
    outcomes,
    markets: subMarkets,
  };
}

function eventTimestampStr(event) {
  for (const field of ['gameStartTime', 'startTime', 'eventDate', 'endDate']) {
    if (typeof event?.[field] === 'string' && event[field].trim()) {
      return event[field].trim();
    }
  }
  return '';
}

function searchQueryFor(home, away) {
  const clean = [...tokens(home), ...tokens(away)].join(' ').trim();
  return clean || `${home} ${away}`;
}

function summarizeRawMarket(market) {
  const labels = parseJsonArray(market?.outcomes) || [];
  const prices = parseJsonArray(market?.outcomePrices) || [];
  const bid = probVal(market?.bestBid);
  const ask = probVal(market?.bestAsk);
  const spread =
    numVal(market?.spread) ??
    (bid !== null && ask !== null && ask >= bid ? ask - bid : null);
  const outcomes = labels.map((label, idx) => {
    const p = probVal(prices[idx]);
    return {
      label: String(label),
      price: p,
      pct: p !== null ? round1(p * 100.0) : null,
    };
  });
  return {
    id: market?.id ?? null,
    question: typeof market?.question === 'string' ? market.question : '',
    group_item_title:
      typeof market?.groupItemTitle === 'string' ? market.groupItemTitle : '',
    outcomes,
    best_bid: bid,
    best_ask: ask,
    spread,
    last_trade_price: probVal(market?.lastTradePrice),
    volume: numVal(market?.volume),
    volume_24h: numVal(market?.volume24hr),
    liquidity: numVal(market?.liquidity),
    change_1d: numVal(market?.oneDayPriceChange),
  };
}

function extractTeamsFromTitle(title) {
  const clean = String(title || '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .trim();
  const vsMatch = clean.match(/^(.+?)\s+(?:vs\.?|v\.?|@|-)\s+(.+?)$/i);
  if (!vsMatch) return null;
  const home = vsMatch[1].trim();
  const away = vsMatch[2].trim();
  if (!home || !away) return null;
  return { home, away };
}

export function summarizeRawEvent(event) {
  const title = typeof event?.title === 'string' ? event.title : '';
  const slug = typeof event?.slug === 'string' ? event.slug : '';
  const safeSlug = slug
    ? slug
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/')
    : '';
  const teams = extractTeamsFromTitle(title);
  const rawMarkets = Array.isArray(event?.markets) ? event.markets : [];
  const parsed = teams ? parsePolymarketEvent(event, teams.home, teams.away) : null;

  return {
    id: event?.id ?? null,
    slug,
    url: safeSlug ? `${EVENT_BASE}${safeSlug}` : '',
    title,
    start_time: eventTimestampStr(event),
    closed: Boolean(event?.closed),
    volume: numVal(event?.volume),
    volume_24h: numVal(event?.volume24hr),
    volume_1wk: numVal(event?.volume1wk),
    liquidity: numVal(event?.liquidity),
    open_interest: numVal(event?.openInterest),
    raw_markets: rawMarkets.map(summarizeRawMarket),
    parsed_markets: parsed?.markets || null,
  };
}

export class PolymarketBook {
  constructor(
    ttlMs = th.EXCHANGE_CACHE_TTL_SECS * 1000,
    baseUrl = DEFAULT_BASE_URL,
    missTtlMs = th.EXCHANGE_MISS_CACHE_TTL_SECS * 1000
  ) {
    this.ttlMs = ttlMs;
    this.missTtlMs = Math.min(ttlMs, missTtlMs);
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.cache = new Map();
    this.inFlight = new Map();
  }

  _pruneCache(now = Date.now()) {
    for (const [k, entry] of this.cache.entries()) {
      const ttl = entry.quote ? this.ttlMs : this.missTtlMs;
      if (now - entry.at >= ttl) {
        this.cache.delete(k);
      }
    }
    while (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
  }

  async _fetchEventBySlug(slug) {
    if (!slug) return null;
    try {
      const url = `${this.baseUrl}/events?slug=${encodeURIComponent(slug)}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'truevalue/0.1',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(Math.min(4000, th.EXCHANGE_TIMEOUT_SECS * 1000)),
      });
      if (!res.ok) return null;
      const list = await res.json();
      if (!Array.isArray(list) || list.length === 0) return null;
      const ev = list[0];
      return ev && ev.closed !== true ? ev : null;
    } catch {
      return null;
    }
  }

  async _fetchQuoteResult(home, away, kickoffAt) {
    const query = searchQueryFor(home, away);
    const url = `${this.baseUrl}/public-search?q=${encodeURIComponent(query)}&limit_per_type=12`;
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'truevalue/0.1',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(th.EXCHANGE_TIMEOUT_SECS * 1000),
      });
      if (!res.ok) {
        return { ok: false, quote: null, error: `HTTP ${res.status}` };
      }
      const payload = await res.json();
      const candidates = [];
      const seenSlugs = new Set();
      for (const event of Array.isArray(payload?.events) ? payload.events : []) {
        if (event?.closed === true) continue;
        const title = typeof event?.title === 'string' ? event.title : '';
        const slug = typeof event?.slug === 'string' ? event.slug : '';
        const whenStr = eventTimestampStr(event);
        if (!eventMatches(home, away, kickoffAt, title, slug, whenStr)) continue;
        const parsed = parsePolymarketEvent(event, home, away);
        const dt = whenStr ? Date.parse(whenStr) : NaN;
        const timeDiff =
          kickoffAt && Number.isFinite(dt)
            ? Math.abs(dt - kickoffAt.getTime())
            : Number.MAX_SAFE_INTEGER;
        if (slug) seenSlugs.add(slug);
        candidates.push({
          parsed,
          dt,
          outcomeCount: parsed.outcomes.length,
          marketCount: Object.keys(parsed.markets || {}).length,
          timeDiff,
          liquidity: parsed.volume ?? parsed.liquidity ?? 0,
        });
      }
      if (candidates.length === 0) {
        return { ok: true, quote: null, error: null };
      }
      candidates.sort(
        (a, b) =>
          b.outcomeCount - a.outcomeCount ||
          b.marketCount - a.marketCount ||
          a.timeDiff - b.timeDiff ||
          b.liquidity - a.liquidity
      );
      const primary = candidates[0];
      const baseSlug = primary.parsed.slug || '';
      if (
        baseSlug &&
        !baseSlug.endsWith('-more-markets') &&
        !baseSlug.endsWith('-exact-score')
      ) {
        const siblingSlugs = [`${baseSlug}-more-markets`, `${baseSlug}-exact-score`].filter(
          (s) => !seenSlugs.has(s)
        );
        if (siblingSlugs.length > 0) {
          const siblingEvents = await Promise.all(
            siblingSlugs.map((s) => this._fetchEventBySlug(s))
          );
          for (const ev of siblingEvents) {
            if (!ev) continue;
            const parsedSib = parsePolymarketEvent(ev, home, away);
            const whenStr = eventTimestampStr(ev);
            const dt = whenStr ? Date.parse(whenStr) : NaN;
            candidates.push({
              parsed: parsedSib,
              dt,
              outcomeCount: parsedSib.outcomes.length,
              marketCount: Object.keys(parsedSib.markets || {}).length,
              timeDiff: primary.timeDiff,
              liquidity: parsedSib.volume ?? parsedSib.liquidity ?? 0,
            });
          }
        }
      }

      const merged = {
        ...primary.parsed,
        outcomes: [...(primary.parsed.outcomes || [])],
        markets: { ...(primary.parsed.markets || {}) },
      };
      const maxWindowMs = th.EXCHANGE_MATCH_MAX_HOURS * 3_600_000;
      for (const extra of candidates.slice(1)) {
        if (
          Number.isFinite(primary.dt) &&
          Number.isFinite(extra.dt) &&
          Math.abs(extra.dt - primary.dt) > maxWindowMs
        ) {
          continue;
        }
        const extraMarkets = extra.parsed.markets || {};
        for (const [k, m] of Object.entries(extraMarkets)) {
          if (!merged.markets[k] || (!merged.markets[k].usable && m?.usable)) {
            merged.markets[k] = m;
          }
        }
        if (
          merged.outcomes.length === 0 &&
          (extra.parsed.outcomes || []).length > 0
        ) {
          merged.outcomes = [...extra.parsed.outcomes];
          merged.overround_pct = extra.parsed.overround_pct;
        }
        if (merged.volume === null && extra.parsed.volume !== null) {
          merged.volume = extra.parsed.volume;
        }
        if (merged.liquidity === null && extra.parsed.liquidity !== null) {
          merged.liquidity = extra.parsed.liquidity;
        }
      }
      return { ok: true, quote: merged, error: null };
    } catch (err) {
      return { ok: false, quote: null, error: err?.message || 'erreur réseau' };
    }
  }

  async fetchQuote(home, away, kickoffAt) {
    const res = await this._fetchQuoteResult(home, away, kickoffAt);
    return res.quote;
  }

  async quote(key, home, away, kickoffAt, { force = false, meta = null } = {}) {
    const now = Date.now();
    if (!force) {
      const cached = this.cache.get(key);
      if (cached) {
        const ttl = cached.quote ? this.ttlMs : this.missTtlMs;
        if (now - cached.at < ttl) {
          return cached.quote;
        }
      }
    }

    const flightKey = force ? `${key}:force` : key;
    if (this.inFlight.has(flightKey)) {
      const result = await this.inFlight.get(flightKey);
      if (meta && !result.ok) meta.error = result.error;
      return result.quote;
    }

    const promise = (async () => {
      const res = await this._fetchQuoteResult(home, away, kickoffAt);
      if (res.ok) {
        const ts = Date.now();
        this._pruneCache(ts);
        const quote = res.quote && typeof res.quote === 'object' && !Array.isArray(res.quote)
          ? { ...res.quote, fetched_at: ts }
          : res.quote;
        this.cache.set(key, { at: ts, quote });
      }
      return res;
    })();

    this.inFlight.set(flightKey, promise);
    try {
      const res = await promise;
      if (meta && !res.ok) meta.error = res.error;
      return res.quote;
    } finally {
      this.inFlight.delete(flightKey);
    }
  }
  async search(query, { limit = 12, force = false } = {}) {
    const q = String(query || '').trim();
    const capped = Math.min(30, Math.max(1, limit));
    const cacheKey = `search:${q || '__soccer__'}:${capped}`;
    const now = Date.now();
    if (!force) {
      const cached = this.cache.get(cacheKey);
      if (cached && now - cached.at < this.ttlMs) {
        return cached.quote;
      }
    }

    const url = q
      ? `${this.baseUrl}/public-search?q=${encodeURIComponent(q)}&limit_per_type=${capped}`
      : `${this.baseUrl}/events?active=true&closed=false&tag_slug=soccer&order=volume24hr&ascending=false&limit=${capped}`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'truevalue/0.1',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(th.EXCHANGE_TIMEOUT_SECS * 1000),
    });
    if (!res.ok) {
      throw new Error(`Polymarket HTTP ${res.status}`);
    }
    const payload = await res.json();
    const rawEvents = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.events)
      ? payload.events
      : [];
    const events = rawEvents
      .filter((ev) => ev && ev.closed !== true)
      .slice(0, capped)
      .map(summarizeRawEvent);

    const ts = Date.now();
    this._pruneCache(ts);
    this.cache.set(cacheKey, { at: ts, quote: events });
    return events;
  }

  async clobBookDepth(tokenId, band = 0.02) {
    if (typeof tokenId !== 'string' || !/^[0-9a-zA-Z_-]+$/.test(tokenId)) {
      return null;
    }
    const cacheKey = `clob:${tokenId}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && now - cached.at < 30_000) {
      return cached.quote;
    }
    try {
      const url = `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'truevalue/0.1', Accept: 'application/json' },
        signal: AbortSignal.timeout(2_500),
      });
      if (!res.ok) return null;
      const book = await res.json();
      const asks = Array.isArray(book?.asks) ? book.asks : [];
      const bids = Array.isArray(book?.bids) ? book.bids : [];
      const parsedAsks = asks
        .map((lvl) => ({ p: Number(lvl?.price), s: Number(lvl?.size) }))
        .filter((x) => Number.isFinite(x.p) && Number.isFinite(x.s) && x.p > 0 && x.s > 0)
        .sort((a, b) => a.p - b.p);
      const parsedBids = bids
        .map((lvl) => ({ p: Number(lvl?.price), s: Number(lvl?.size) }))
        .filter((x) => Number.isFinite(x.p) && Number.isFinite(x.s) && x.p > 0 && x.s > 0)
        .sort((a, b) => b.p - a.p);

      const bestAsk = parsedAsks[0]?.p ?? null;
      const bestBid = parsedBids[0]?.p ?? null;
      const askDepthUsd =
        bestAsk !== null
          ? round1(
              parsedAsks
                .filter((lvl) => lvl.p <= bestAsk + band)
                .reduce((acc, lvl) => acc + lvl.p * lvl.s, 0)
            )
          : null;
      const bidDepthUsd =
        bestBid !== null
          ? round1(
              parsedBids
                .filter((lvl) => lvl.p >= Math.max(0.01, bestBid - band))
                .reduce((acc, lvl) => acc + lvl.p * lvl.s, 0)
            )
          : null;
      const depth = { best_ask: bestAsk, best_bid: bestBid, ask_depth_usd: askDepthUsd, bid_depth_usd: bidDepthUsd };
      this._pruneCache(now);
      this.cache.set(cacheKey, { at: now, quote: depth });
      return depth;
    } catch {
      return null;
    }
  }
}
