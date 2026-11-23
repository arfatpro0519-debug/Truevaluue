// Scores de secours via l'API publique SportScore.

import { mapWithConcurrency } from './async.js';
import { formatDate, parseKickoff } from './enrich.js';
import { similarity } from './espn.js';
import { MatchState } from './model.js';
import * as th from './thresholds.js';

const DEFAULT_BASE_URL = 'https://sportscore.com';
const FIXTURES_LIMIT = 200;
const MAX_CACHE_ENTRIES = 500;

export function competitionSlugs(name) {
  const n = String(name || '').toLowerCase();
  if ((n.includes('italian') || n.includes('italy')) && n.includes('serie c')) {
    return ['italian-serie-c'];
  }
  if ((n.includes('greek') || n.includes('greece')) && n.includes('super league 2')) {
    return ['greek-super-league-2'];
  }
  if (n.includes('elite league') && n.includes('u20')) {
    return ['elite-league-u20'];
  }
  if ((n.includes('friendly') || n.includes('friendlies')) && n.includes('u20')) {
    return ['elite-league-u20', 'international-friendly'];
  }
  return [];
}

export function coversCompetition(name) {
  return competitionSlugs(name).length > 0;
}

function text(row, key) {
  const v = row?.[key];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function parseScoreVal(row, key) {
  const v = row?.[key];
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number.parseInt(v.trim(), 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function stateOf(row) {
  const status = (text(row, 'status') || '').toLowerCase();
  const detail = (text(row, 'status_text') || '').toLowerCase();
  const all = `${status} ${detail}`;

  if (all.includes('postpon') || all.includes('suspend')) {
    return MatchState.Postponed;
  }
  if (all.includes('cancel') || all.includes('abandon')) {
    return MatchState.Cancelled;
  }
  if (
    ['finished', 'ft', 'full-time', 'full time', 'aet', 'pens'].includes(status) ||
    detail === 'ft' ||
    detail.includes('finished')
  ) {
    return MatchState.Finished;
  }
  if (
    status.includes('live') ||
    status.includes('in_progress') ||
    status.includes('inprogress') ||
    ['1h', '2h', 'ht', 'halftime'].includes(status) ||
    detail.includes('live') ||
    detail.includes('half')
  ) {
    return MatchState.InProgress;
  }
  return MatchState.Scheduled;
}

function statusDetailOf(state) {
  switch (state) {
    case MatchState.Scheduled:
      return 'NS';
    case MatchState.InProgress:
      return 'LIVE';
    case MatchState.Finished:
      return 'FT';
    case MatchState.Postponed:
      return 'POSTP';
    case MatchState.Cancelled:
      return 'CANC';
    default:
      return 'NS';
  }
}

export function parseSportScoreFixture(row, competition) {
  const home = text(row, 'home');
  const away = text(row, 'away');
  const date = text(row, 'time');
  if (!home || !away || !date) return null;

  const homeScore = parseScoreVal(row, 'home_score');
  const awayScore = parseScoreVal(row, 'away_score');

  const rawState = stateOf(row);
  const state =
    rawState === MatchState.Finished && (homeScore === null || awayScore === null)
      ? MatchState.InProgress
      : rawState;

  const totalGoals =
    homeScore !== null && awayScore !== null ? homeScore + awayScore : null;
  const btts =
    homeScore !== null && awayScore !== null
      ? homeScore > 0 && awayScore > 0
      : null;

  const url = text(row, 'url') || '';
  const id = url ? `sportscore:${url}` : `sportscore:${home}:${away}:${date}`;

  return {
    id,
    name: `${home} vs ${away}`,
    date,
    date_label: formatDate(date),
    league_slug: competition,
    league_name: text(row, 'competition') || competition,
    home_team: home,
    away_team: away,
    home_logo: text(row, 'home_logo') || '',
    away_logo: text(row, 'away_logo') || '',
    home_score: homeScore,
    away_score: awayScore,
    home_ht: null,
    away_ht: null,
    state,
    status_detail: statusDetailOf(state),
    completed: state === MatchState.Finished,
    total_goals: totalGoals,
    btts,
  };
}

export function findSportScoreMatch(home, away, date, league, events) {
  const slugs = competitionSlugs(league);
  if (slugs.length === 0) return null;
  const expected = parseKickoff(date);
  if (!expected) return null;

  let best = null;
  for (const event of events || []) {
    if (!slugs.includes(event.league_slug)) continue;
    const homeSim = similarity(home, event.home_team);
    if (homeSim < th.SPORTSCORE_MATCH_MIN_SIMILARITY) continue;
    const awaySim = similarity(away, event.away_team);
    if (awaySim < th.SPORTSCORE_MATCH_MIN_SIMILARITY) continue;
    const at = parseKickoff(event.date);
    if (!at) continue;
    const seconds = Math.abs(Math.trunc((expected.getTime() - at.getTime()) / 1000));
    if (seconds > th.SPORTSCORE_MATCH_MAX_HOURS * 3600) continue;
    const scored =
      (homeSim + awaySim) / 2.0 - Math.min(1.0, seconds / 86_400.0) * 0.02;
    if (!best || scored > best.score) {
      best = { event, score: scored };
    }
  }
  if (best && best.score >= th.SPORTSCORE_MATCH_MIN_SIMILARITY) {
    return best.event;
  }
  return null;
}

export class SportScoreClient {
  constructor(
    ttlMs = th.SPORTSCORE_CACHE_TTL_SECS * 1000,
    baseUrl = DEFAULT_BASE_URL,
    { apiKey = null, host = null } = {}
  ) {
    this.ttlMs = ttlMs;
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = apiKey || null;
    this.host = host || null;
    this.cache = new Map();
    this.inFlight = new Map();
  }

  _pruneCache(now = Date.now()) {
    for (const [k, entry] of this.cache.entries()) {
      if (now - entry.at >= this.ttlMs) {
        this.cache.delete(k);
      }
    }
    while (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
  }

  async fixtures(day, competition) {
    if (typeof competition !== 'string' || !/^[a-z0-9-]+$/i.test(competition)) {
      throw new Error(`Compétition SportScore invalide : ${competition}`);
    }
    const cacheKey = `${day}_${competition}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.ttlMs) {
      return cached.events;
    }
    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey);
    }

    const promise = (async () => {
      const headers = { 'User-Agent': 'truevalue/0.1' };
      if (this.apiKey) headers['x-rapidapi-key'] = this.apiKey;
      if (this.host) headers['x-rapidapi-host'] = this.host;

      const url = `${this.baseUrl}/api/v1/fixtures/?sport=football&date=${encodeURIComponent(day)}&competition=${encodeURIComponent(competition)}&limit=${FIXTURES_LIMIT}`;
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(th.SPORTSCORE_TIMEOUT_SECS * 1000),
      });
      if (!res.ok) {
        throw new Error(`SportScore ${competition} ${day} : HTTP ${res.status}`);
      }
      const payload = await res.json();
      if (!Array.isArray(payload?.matches)) {
        throw new Error(`SportScore ${competition} ${day} : réponse inattendue`);
      }
      const events = payload.matches
        .map((row) => parseSportScoreFixture(row, competition))
        .filter(Boolean);
      const ts = Date.now();
      this._pruneCache(ts);
      this.cache.set(cacheKey, { at: ts, events });
      return events;
    })();

    this.inFlight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  async many(requests, concurrency = 4) {
    const seenReq = new Set();
    const dedupedReqs = [];
    for (const [day, competition] of requests || []) {
      const reqKey = `${day}|${competition}`;
      if (seenReq.has(reqKey)) continue;
      seenReq.add(reqKey);
      dedupedReqs.push([day, competition]);
    }

    const settled = await mapWithConcurrency(
      dedupedReqs,
      concurrency,
      async ([day, competition]) => {
        try {
          return { rows: await this.fixtures(day, competition), error: null };
        } catch (err) {
          return { rows: [], error: err.message || String(err) };
        }
      }
    );

    const seenEvents = new Set();
    const seenWarnings = new Set();
    const events = [];
    const warnings = [];

    for (const item of settled) {
      if (item.error) {
        if (!seenWarnings.has(item.error)) {
          seenWarnings.add(item.error);
          warnings.push(item.error);
        }
        continue;
      }
      for (const row of item.rows) {
        if (!seenEvents.has(row.id)) {
          seenEvents.add(row.id);
          events.push(row);
        }
      }
    }
    return { events, warnings };
  }
}
