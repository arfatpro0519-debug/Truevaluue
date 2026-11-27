// Résultats réels via l'API publique ESPN.

import { mapWithConcurrency } from './async.js';
import { formatDate, normalizeTeam, parseKickoff } from './enrich.js';
import { MatchState } from './model.js';
import * as th from './thresholds.js';

const MAX_CACHE_ENTRIES = 500;

export const LEAGUES = [
  { slug: 'uefa.champions', name: 'Ligue des champions', flag: '🇪🇺', category: 'EUROPE' },
  { slug: 'uefa.europa', name: 'Ligue Europa', flag: '🇪🇺', category: 'EUROPE' },
  { slug: 'uefa.nations', name: 'Ligue des nations', flag: '🇪🇺', category: 'EUROPE' },
  { slug: 'uefa.europa.conf', name: 'Ligue Conférence', flag: '🇪🇺', category: 'EUROPE' },
  { slug: 'eng.1', name: 'Premier League', flag: '🏴', category: 'ENGLAND' },
  { slug: 'eng.2', name: 'Championship', flag: '🏴', category: 'ENGLAND' },
  { slug: 'eng.3', name: 'League One', flag: '🏴', category: 'ENGLAND' },
  { slug: 'eng.fa', name: 'FA Cup', flag: '🏴', category: 'ENGLAND' },
  { slug: 'esp.1', name: 'La Liga', flag: '🇪🇸', category: 'SPAIN' },
  { slug: 'esp.2', name: 'Segunda División', flag: '🇪🇸', category: 'SPAIN' },
  { slug: 'esp.copa_del_rey', name: 'Coupe du Roi', flag: '🇪🇸', category: 'SPAIN' },
  { slug: 'ita.1', name: 'Serie A', flag: '🇮🇹', category: 'ITALY' },
  { slug: 'ita.2', name: 'Serie B', flag: '🇮🇹', category: 'ITALY' },
  { slug: 'ger.1', name: 'Bundesliga', flag: '🇩🇪', category: 'GERMANY' },
  { slug: 'ger.2', name: '2. Bundesliga', flag: '🇩🇪', category: 'GERMANY' },
  { slug: 'fra.1', name: 'Ligue 1', flag: '🇫🇷', category: 'FRANCE' },
  { slug: 'fra.2', name: 'Ligue 2', flag: '🇫🇷', category: 'FRANCE' },
  { slug: 'ned.1', name: 'Eredivisie', flag: '🇳🇱', category: 'OTHER' },
  { slug: 'por.1', name: 'Liga Portugal', flag: '🇵🇹', category: 'OTHER' },
  { slug: 'tur.1', name: 'Süper Lig', flag: '🇹🇷', category: 'OTHER' },
  { slug: 'bel.1', name: 'Pro League', flag: '🇧🇪', category: 'OTHER' },
  { slug: 'fifa.friendly', name: 'Matchs amicaux', flag: '🌍', category: 'OTHER' },
  { slug: 'fifa.friendly_u21', name: 'Amicaux internationaux U21', flag: '🌍', category: 'OTHER' },
  { slug: 'uefa.wchampions', name: 'Ligue des champions féminine', flag: '🇪🇺', category: 'EUROPE' },
  { slug: 'uefa.w.europa', name: 'Europa League féminine', flag: '🇪🇺', category: 'EUROPE' },
  { slug: 'caf.nations_qual', name: 'Qualifications CAN', flag: '🌍', category: 'AFRICA' },
  { slug: 'concacaf.nations.league', name: 'Ligue des nations CONCACAF', flag: '🌎', category: 'OTHER' },
  { slug: 'uru.1', name: 'Liga AUF Uruguaya', flag: '🇺🇾', category: 'OTHER' },
  { slug: 'uru.2', name: 'Segunda División Uruguay', flag: '🇺🇾', category: 'OTHER' },
  { slug: 'col.1', name: 'Primera A colombienne', flag: '🇨🇴', category: 'OTHER' },
  { slug: 'col.2', name: 'Primera B colombienne', flag: '🇨🇴', category: 'OTHER' },
  { slug: 'bra.1', name: 'Brasileirão Serie A', flag: '🇧🇷', category: 'OTHER' },
  { slug: 'bra.2', name: 'Brasileirão Serie B', flag: '🇧🇷', category: 'OTHER' },
  { slug: 'arg.1', name: 'Liga Profesional argentine', flag: '🇦🇷', category: 'OTHER' },
  { slug: 'arg.2', name: 'Primera Nacional argentine', flag: '🇦🇷', category: 'OTHER' },
  { slug: 'mex.1', name: 'Liga MX', flag: '🇲🇽', category: 'OTHER' },
  { slug: 'mex.2', name: 'Liga de Expansión MX', flag: '🇲🇽', category: 'OTHER' },
  { slug: 'slv.1', name: 'Primera División salvadorienne', flag: '🇸🇻', category: 'OTHER' },
  { slug: 'bol.copa', name: 'Coupe de Bolivie', flag: '🇧🇴', category: 'OTHER' },
  { slug: 'afc.champions', name: 'AFC Champions League', flag: '🌏', category: 'OTHER' },
  { slug: 'den.1', name: 'Superliga danoise', flag: '🇩🇰', category: 'OTHER' },
  { slug: 'chi.1', name: 'Primera División chilienne', flag: '🇨🇱', category: 'OTHER' },
  { slug: 'par.1', name: 'Primera División paraguayenne', flag: '🇵🇾', category: 'OTHER' },
  { slug: 'ecu.1', name: 'Serie A équatorienne', flag: '🇪🇨', category: 'OTHER' },
  { slug: 'sco.1', name: 'Scottish Premiership', flag: '🏴', category: 'OTHER' },
  { slug: 'sco.2', name: 'Scottish Championship', flag: '🏴', category: 'OTHER' },
  { slug: 'eng.4', name: 'League Two', flag: '🏴', category: 'ENGLAND' },
  { slug: 'eng.trophy', name: 'EFL Trophy', flag: '🏴', category: 'ENGLAND' },
  { slug: 'fra.w.1', name: 'Première Ligue féminine', flag: '🇫🇷', category: 'FRANCE' },
  { slug: 'eng.w.league_cup', name: 'League Cup féminine', flag: '🏴', category: 'ENGLAND' },
  { slug: 'usa.1', name: 'Major League Soccer (MLS)', flag: '🇺🇸', category: 'OTHER' },
  { slug: 'aus.1', name: 'A-League Men', flag: '🇦🇺', category: 'OTHER' },
  { slug: 'jpn.1', name: 'J1 League', flag: '🇯🇵', category: 'OTHER' },

  { slug: 'swe.1', name: 'Allsvenskan', flag: '🇸🇪', category: 'OTHER' },
  { slug: 'nor.1', name: 'Eliteserien', flag: '🇳🇴', category: 'OTHER' },
  { slug: 'sui.1', name: 'Super League suisse', flag: '🇨🇭', category: 'OTHER' },
  { slug: 'aut.1', name: 'Bundesliga autrichienne', flag: '🇦🇹', category: 'OTHER' },

  { slug: 'rou.1', name: 'Liga I roumaine', flag: '🇷🇴', category: 'OTHER' },
  { slug: 'ksa.1', name: 'Saudi Pro League', flag: '🇸🇦', category: 'OTHER' },
  { slug: 'chn.1', name: 'Chinese Super League', flag: '🇨🇳', category: 'OTHER' },
  { slug: 'gre.1', name: 'Super League grecque', flag: '🇬🇷', category: 'OTHER' },
  { slug: 'bol.1', name: 'Liga de Fútbol Profesional bolivienne', flag: '🇧🇴', category: 'OTHER' },
  { slug: 'por.taca.portugal', name: 'Coupe du Portugal', flag: '🇵🇹', category: 'OTHER' },
];

export const VALID_LEAGUE_SLUGS = new Set(LEAGUES.map((l) => l.slug));

const LEAGUE_NAME_BY_SLUG = new Map(LEAGUES.map((l) => [l.slug, l.name]));

const COMPETITION_SLUGS = [
  ['greek super league', 'gre.1'],
  ['bolivian liga de futbol profesional', 'bol.1'],
  ['bolivian primera', 'bol.1'],
  ['portuguese cup', 'por.taca.portugal'],
  ['taca de portugal', 'por.taca.portugal'],
  ['concacaf nations league', 'concacaf.nations.league'],
  ['cup of nations qualif', 'caf.nations_qual'],
  ["women's champions league", 'uefa.wchampions'],
  ['ladies europa', 'uefa.w.europa'],
  ['ladies league cup', 'eng.w.league_cup'],
  ['premiere ligue', 'fra.w.1'],
  ['afc champions league', 'afc.champions'],
  ['danish superliga', 'den.1'],
  ['chilean primera', 'chi.1'],
  ['paraguayan primera', 'par.1'],
  ['ecuadorian serie a', 'ecu.1'],
  ['brazilian serie b', 'bra.2'],
  ['brazilian serie a', 'bra.1'],
  ['colombian primera a', 'col.1'],
  ['colombian primera b', 'col.2'],
  ['uruguayan primera', 'uru.1'],
  ['uruguayan segunda', 'uru.2'],
  ['salvadoran primera', 'slv.1'],
  ['bolivian cup', 'bol.copa'],
  ['efl trophy', 'eng.trophy'],
  ['sky bet league 2', 'eng.4'],
  ['english league two', 'eng.4'],
  ['league two', 'eng.4'],
  ['liga de ascenso', 'mex.2'],
  ['liga mx', 'mex.1'],
  ['argentinian primera division', 'arg.1'],
  ['primera nacional', 'arg.2'],
  ['scottish premiership', 'sco.1'],
  ['scottish championship', 'sco.2'],
  ['friendlies international u21', 'fifa.friendly_u21'],
  ['us mls', 'usa.1'],
  ['major league soccer', 'usa.1'],
  ['australian a-league', 'aus.1'],
  ['a-league', 'aus.1'],
  ['japanese j league', 'jpn.1'],
  ['j1 league', 'jpn.1'],

  ['swedish allsvenskan', 'swe.1'],
  ['allsvenskan', 'swe.1'],
  ['norwegian eliteserien', 'nor.1'],
  ['eliteserien', 'nor.1'],
  ['swiss super league', 'sui.1'],
  ['austrian bundesliga', 'aut.1'],

  ['romanian liga', 'rou.1'],
  ['saudi pro league', 'ksa.1'],
  ['saudi premier league', 'ksa.1'],
  ['chinese super league', 'chn.1'],
];

const FOREIGN_COMPETITION_QUALIFIERS = [
  'algerian',
  'bulgarian',
  'caf ',
  'concacaf',
  'costa rican',
  'croatian',
  'czech',
  'egyptian',
  'ghanaian',
  'greek',
  'guatemalan',
  'hungarian',
  'indian',
  'irish',
  'israeli',
  'jamaican',
  'kenyan',
  'malaysian',
  'moroccan',
  'nicaraguan',
  'nigerian',
  'northern ireland',
  'panamanian',
  'peruvian',
  'russian',
  'serbian',
  'slovenian',
  'south african',
  'thai',
  'tunisian',
  'ukrainian',
  'usl ',
  'venezuelan',
  'welsh',
];

export function slugForCompetition(name) {
  const n = String(name || '').toLowerCase().trim();
  // « Greek Super League 2 » est couverte par SportScore, pas par ESPN.
  if (n.includes('greek super league 2')) return null;

  for (const [needle, slug] of COMPETITION_SLUGS) {
    if (n.includes(needle)) return slug;
  }

  if (n.includes('women') || n.includes('ladies') || n.includes('(w)')) {
    return null;
  }
  if (
    n.includes('u19') ||
    n.includes('u20') ||
    n.includes('u21') ||
    n.includes('u23') ||
    n.includes('youth')
  ) {
    return null;
  }

  if (n.includes('uefa nations league') || n === 'nations league') return 'uefa.nations';
  if (n.includes('uefa champions league') || n === 'champions league') return 'uefa.champions';
  if (n.includes('uefa conference league') || n === 'conference league') return 'uefa.europa.conf';
  if (n.includes('uefa europa league') || n === 'europa league' || n === 'europa cup') {
    return 'uefa.europa';
  }
  if (n.includes('copa del rey')) return 'esp.copa_del_rey';
  if (n.includes('fa cup') && (n.includes('english') || n === 'fa cup')) return 'eng.fa';
  if (n.includes('friendly') || n.includes('friendlies')) return 'fifa.friendly';

  if (FOREIGN_COMPETITION_QUALIFIERS.some((q) => n.includes(q))) {
    return null;
  }

  if (n.includes('2. bundesliga') || n.includes('bundesliga 2')) return 'ger.2';
  if (n.includes('bundesliga')) return 'ger.1';
  if (n.includes('premier league')) return 'eng.1';
  if (n.includes('championship')) return 'eng.2';
  if (n.includes('league one')) return 'eng.3';
  if (n.includes('la liga') || n.includes('laliga') || n.includes('spanish primera') || n === 'primera division') {
    return 'esp.1';
  }
  if (n.includes('spanish segunda') || n === 'segunda division') return 'esp.2';
  if (n.includes('serie b')) return 'ita.2';
  if (n.includes('serie a')) return 'ita.1';
  if (n.includes('ligue 2')) return 'fra.2';
  if (n.includes('ligue 1')) return 'fra.1';
  if (n.includes('eredivisie')) return 'ned.1';
  if (n.includes('liga portugal') || n.includes('primeira liga')) return 'por.1';
  if (/\bs[uü]per\s*lig\b/.test(n) || n.includes('turkish super')) {
    return 'tur.1';
  }
  if (n.includes('pro league') || n.includes('jupiler')) return 'bel.1';
  return null;
}

export function leagueName(slug) {
  return LEAGUE_NAME_BY_SLUG.get(slug) || 'Compétition';
}

export const DEFAULT_LEAGUES = [
  'uefa.champions',
  'uefa.europa',
  'eng.1',
  'esp.1',
  'ita.1',
  'ger.1',
  'fra.1',
  'eng.2',
];

function parseIntScore(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return Math.trunc(val);
  if (typeof val === 'string') {
    const n = Number.parseInt(val.trim(), 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseLineScore(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return Math.round(val);
  if (typeof val === 'string') {
    const n = Number.parseInt(val.trim(), 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function parseEspnEvent(event, slug) {
  const comp = Array.isArray(event?.competitions) ? event.competitions[0] : null;
  const competitors = Array.isArray(comp?.competitors) ? comp.competitors : null;
  if (!competitors || competitors.length < 2) return null;

  const home =
    competitors.find((c) => c.homeAway === 'home') || competitors[0];
  const away =
    competitors.find((c) => c.homeAway === 'away') || competitors[1];

  const statusType = event?.status?.type || {};
  const state = typeof statusType.state === 'string' ? statusType.state : 'pre';
  const statusName = typeof statusType.name === 'string' ? statusType.name : '';
  const completed = statusType.completed === true || state === 'post';

  let matchState;
  if (statusName.includes('POSTPONED')) {
    matchState = MatchState.Postponed;
  } else if (
    statusName.includes('CANCELED') ||
    statusName.includes('CANCELLED')
  ) {
    matchState = MatchState.Cancelled;
  } else if (completed) {
    matchState = MatchState.Finished;
  } else if (state === 'in') {
    matchState = MatchState.InProgress;
  } else {
    matchState = MatchState.Scheduled;
  }

  const started =
    matchState === MatchState.InProgress || matchState === MatchState.Finished;

  const scoreOf = (c) => parseIntScore(c?.score);
  const halfOf = (c) => {
    const first = Array.isArray(c?.linescores) ? c.linescores[0] : null;
    return parseLineScore(first?.value);
  };

  const homeScore = started ? scoreOf(home) : null;
  const awayScore = started ? scoreOf(away) : null;
  const totalGoals =
    homeScore !== null && awayScore !== null ? homeScore + awayScore : null;
  const btts =
    homeScore !== null && awayScore !== null
      ? homeScore > 0 && awayScore > 0
      : null;

  const date = typeof event?.date === 'string' ? event.date : '';
  const statusDetail =
    typeof statusType.detail === 'string' ? statusType.detail : '';
  const teamName = (c) =>
    c?.team?.displayName || c?.team?.shortDisplayName || c?.team?.name || '';

  return {
    id: typeof event?.id === 'string' ? event.id : String(event?.id || ''),
    name: typeof event?.name === 'string' ? event.name : '',
    date,
    date_label: formatDate(date),
    league_slug: slug,
    league_name: leagueName(slug),
    home_team: teamName(home),
    away_team: teamName(away),
    home_logo: typeof home?.team?.logo === 'string' ? home.team.logo : '',
    away_logo: typeof away?.team?.logo === 'string' ? away.team.logo : '',
    home_score: homeScore,
    away_score: awayScore,
    home_ht: started ? halfOf(home) : null,
    away_ht: started ? halfOf(away) : null,
    state: matchState,
    status_detail: statusDetail,
    completed: matchState === MatchState.Finished,
    total_goals: totalGoals,
    btts,
  };
}

export function similarity(a, b) {
  const na = normalizeTeam(a);
  const nb = normalizeTeam(b);
  if (!na || !nb) return 0.0;
  if (na === nb) return 1.0;

  if (na.includes(nb) || nb.includes(na)) {
    const short = na.length <= nb.length ? na : nb;
    const long = na.length <= nb.length ? nb : na;
    if (short.length >= 5 && long.length - short.length <= 6) {
      return 0.92;
    }
  }

  const lenA = na.length - 1;
  const lenB = nb.length - 1;
  if (lenA <= 0 || lenB <= 0) return 0.0;
  const bbSet = new Set();
  for (let i = 0; i < lenB; i++) {
    bbSet.add(nb.slice(i, i + 2));
  }
  let hits = 0;
  for (let i = 0; i < lenA; i++) {
    if (bbSet.has(na.slice(i, i + 2))) hits += 1;
  }
  return (2.0 * hits) / (lenA + lenB);
}

export function findEspnMatch(home, away, date, leagueSlug, events) {
  let best = null;
  const expected = date ? parseKickoff(date) : null;
  for (const ev of events || []) {
    if (leagueSlug && ev.league_slug !== leagueSlug) {
      continue;
    }
    const homeSim = similarity(home, ev.home_team);
    if (homeSim < th.ESPN_MATCH_MIN_SIMILARITY) continue;
    const awaySim = similarity(away, ev.away_team);
    if (awaySim < th.ESPN_MATCH_MIN_SIMILARITY) continue;

    let scored = (homeSim + awaySim) / 2.0;
    if (date) {
      const at = parseKickoff(ev.date);
      if (!expected || !at) continue;
      const seconds = Math.abs(Math.trunc((expected.getTime() - at.getTime()) / 1000));
      if (seconds > th.ESPN_MATCH_MAX_HOURS * 3600) continue;
      scored -= Math.min(1.0, seconds / 86_400.0) * 0.02;
    }
    if (!best || scored > best.score) {
      best = { ev, score: scored };
    }
  }
  if (best && best.score >= th.ESPN_MATCH_MIN_SIMILARITY) {
    return best.ev;
  }
  return null;
}

export class EspnResultsClient {
  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
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

  async scoreboard(slug, date = null) {
    if (typeof slug !== 'string' || !/^[a-z0-9._-]+$/i.test(slug)) {
      throw new Error(`Ligue ESPN invalide : ${slug}`);
    }
    const cacheKey = `${slug}_${date || 'current'}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.ttlMs) {
      return cached.events;
    }
    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey);
    }

    const promise = (async () => {
      let url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${encodeURIComponent(slug)}/scoreboard`;
      if (date) url += `?dates=${encodeURIComponent(date)}`;

      const res = await fetch(url, {
        headers: { 'User-Agent': 'truevalue/0.1' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        throw new Error(`ESPN ${slug} : HTTP ${res.status}`);
      }
      const payload = await res.json();
      const events = Array.isArray(payload?.events)
        ? payload.events.map((ev) => parseEspnEvent(ev, slug)).filter(Boolean)
        : [];
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

  async many(slugs, date = null, concurrency = 4) {
    const out = [];
    const errors = [];
    const settled = await mapWithConcurrency(slugs || [], concurrency, async (slug) => {
      try {
        return { events: await this.scoreboard(slug, date), error: null };
      } catch (err) {
        return { events: [], error: `ESPN ${slug} : ${err.message || err}` };
      }
    });
    for (const item of settled) {
      if (item.error) {
        errors.push(item.error);
      } else {
        out.push(...item.events);
      }
    }
    return { events: out, errors };
  }
}
