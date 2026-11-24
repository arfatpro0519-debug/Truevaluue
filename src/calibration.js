// Journal d'observations pré-match et calibration empirique via ESPN et SportScore.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { mapWithConcurrency } from './async.js';
import { DEFAULT_CALIBRATION_MIN_N } from './config.js';
import { formatDate, parseKickoff } from './enrich.js';
import { findEspnMatch, slugForCompetition } from './espn.js';
import { MarketKey, MarketShape, marketDef } from './market.js';
import { MatchState } from './model.js';
import { competitionSlugs, findSportScoreMatch } from './sportscore.js';

const MAX_OBSERVATIONS = 50_000;
const SETTLE_GRACE_MS = 125 * 60 * 1000;
const PROB_EPS = 1e-4;

// `node:sqlite` n'existe qu'à partir de Node 22.5 (et demande un flag avant 22.13).
// On le charge donc à l'exécution : sans lui, le stockage bascule en JSON.
const requireModule = createRequire(import.meta.url);
function loadDatabaseSync() {
  try {
    return requireModule('node:sqlite').DatabaseSync || null;
  } catch {
    return null;
  }
}
const DatabaseSync = loadDatabaseSync();

function clampProb(p) {
  return Math.min(1 - PROB_EPS, Math.max(PROB_EPS, p));
}

function brierBinary(p, y) {
  const diff = p - y;
  return diff * diff;
}

function logLossBinary(p, y) {
  const q = clampProb(p);
  return y === 1 ? -Math.log(q) : -Math.log(1 - q);
}

function resolveOutcomeVector(marketKey, ev) {
  const hs = ev?.home_score;
  const as = ev?.away_score;
  if (typeof hs !== 'number' || typeof as !== 'number') {
    return { status: 'unresolved' };
  }

  const total = hs + as;
  switch (marketKey) {
    case MarketKey.OneXTwo:
      return {
        status: 'settled',
        targets: {
          '1': hs > as ? 1 : 0,
          N: hs === as ? 1 : 0,
          '2': hs < as ? 1 : 0,
        },
        multiclass: true,
      };
    case MarketKey.DoubleChance:
      return {
        status: 'settled',
        targets: {
          '1X': hs >= as ? 1 : 0,
          X2: hs <= as ? 1 : 0,
          '12': hs !== as ? 1 : 0,
        },
        multiclass: false,
      };
    case MarketKey.DrawNoBet:
      if (hs === as) return { status: 'push' };
      return {
        status: 'settled',
        targets: {
          '1': hs > as ? 1 : 0,
          '2': hs < as ? 1 : 0,
        },
        multiclass: true,
      };
    case MarketKey.OverUnder15:
      return {
        status: 'settled',
        targets: { Under: total < 2 ? 1 : 0, Over: total >= 2 ? 1 : 0 },
        multiclass: true,
      };
    case MarketKey.OverUnder25:
      return {
        status: 'settled',
        targets: { Under: total < 3 ? 1 : 0, Over: total >= 3 ? 1 : 0 },
        multiclass: true,
      };
    case MarketKey.OverUnder35:
      return {
        status: 'settled',
        targets: { Under: total < 4 ? 1 : 0, Over: total >= 4 ? 1 : 0 },
        multiclass: true,
      };
    case MarketKey.Btts: {
      const yes = hs > 0 && as > 0 ? 1 : 0;
      return {
        status: 'settled',
        targets: { Oui: yes, Non: yes === 1 ? 0 : 1 },
        multiclass: true,
      };
    }
    case MarketKey.HalfTime: {
      const hht = ev?.home_ht;
      const aht = ev?.away_ht;
      if (typeof hht !== 'number' || typeof aht !== 'number') {
        return { status: 'unresolved' };
      }
      return {
        status: 'settled',
        targets: {
          '1': hht > aht ? 1 : 0,
          N: hht === aht ? 1 : 0,
          '2': hht < aht ? 1 : 0,
        },
        multiclass: true,
      };
    }
    default:
      return { status: 'unsupported' };
  }
}

export function scoreObservationAgainstEvent(obs, ev, sourceName) {
  if (!ev || ev.state !== MatchState.Finished) {
    if (
      ev?.state === MatchState.Cancelled ||
      ev?.state === MatchState.Postponed
    ) {
      return {
        ...obs,
        status: 'push',
        settled_at: new Date().toISOString(),
        result_source: sourceName,
      };
    }
    return null;
  }

  const resolved = resolveOutcomeVector(obs.market, ev);
  if (resolved.status === 'push') {
    return {
      ...obs,
      status: 'push',
      home_score: ev.home_score,
      away_score: ev.away_score,
      home_ht: ev.home_ht ?? null,
      away_ht: ev.away_ht ?? null,
      settled_at: new Date().toISOString(),
      result_source: sourceName,
    };
  }
  if (resolved.status !== 'settled') return null;

  const targets = resolved.targets;
  const sideEntries = (obs.sides || []).filter(
    (s) =>
      typeof s.bf_pct === 'number' &&
      typeof s.pm_pct === 'number' &&
      targets[s.label] !== undefined
  );
  if (sideEntries.length === 0) return null;

  let brierBfSum = 0;
  let brierPmSum = 0;
  let logBfSum = 0;
  let logPmSum = 0;
  let maxGapSide = null;

  for (const s of sideEntries) {
    const y = targets[s.label];
    const pBf = clampProb(s.bf_pct / 100.0);
    const pPm = clampProb(s.pm_pct / 100.0);
    brierBfSum += brierBinary(pBf, y);
    brierPmSum += brierBinary(pPm, y);

    if (resolved.multiclass) {
      if (y === 1) {
        logBfSum += -Math.log(pBf);
        logPmSum += -Math.log(pPm);
      }
    } else {
      logBfSum += logLossBinary(pBf, y);
      logPmSum += logLossBinary(pPm, y);
    }

    if (!maxGapSide || Math.abs(s.gap_pp) > Math.abs(maxGapSide.gap_pp)) {
      maxGapSide = s;
    }
  }

  const n = sideEntries.length;
  const brierBf = Number((brierBfSum / n).toFixed(4));
  const brierPm = Number((brierPmSum / n).toFixed(4));
  const logBf = Number(
    (resolved.multiclass ? logBfSum : logBfSum / n).toFixed(4)
  );
  const logPm = Number(
    (resolved.multiclass ? logPmSum : logPmSum / n).toFixed(4)
  );

  let gapWinner = 'tie';
  if (maxGapSide && Math.abs(maxGapSide.gap_pp) >= 3.0) {
    const y = targets[maxGapSide.label];
    const errBf = Math.abs(maxGapSide.bf_pct / 100.0 - y);
    const errPm = Math.abs(maxGapSide.pm_pct / 100.0 - y);
    if (errBf + 1e-6 < errPm) gapWinner = 'betfair';
    else if (errPm + 1e-6 < errBf) gapWinner = 'polymarket';
  }

  return {
    ...obs,
    status: 'settled',
    home_score: ev.home_score,
    away_score: ev.away_score,
    home_ht: ev.home_ht ?? null,
    away_ht: ev.away_ht ?? null,
    brier_bf: brierBf,
    brier_pm: brierPm,
    logloss_bf: logBf,
    logloss_pm: logPm,
    gap_winner: gapWinner,
    settled_at: new Date().toISOString(),
    result_source: sourceName,
  };
}

function dayStringsAround(isoDate) {
  const dt = parseKickoff(isoDate);
  if (!dt) return [];
  const toDay = (ms) => new Date(ms).toISOString().slice(0, 10);
  const base = dt.getTime();
  return [...new Set([toDay(base - 86_400_000), toDay(base), toDay(base + 86_400_000)])];
}

function isValidObservation(obs) {
  if (!obs || typeof obs !== 'object' || !obs.market || !Array.isArray(obs.sides)) {
    return false;
  }
  const expectedMinSides =
    obs.market === MarketKey.OneXTwo ||
    obs.market === MarketKey.HalfTime ||
    obs.market === MarketKey.DoubleChance
      ? 3
      : 2;
  const validSides = obs.sides.filter(
    (s) =>
      typeof s?.bf_pct === 'number' &&
      typeof s?.pm_pct === 'number' &&
      typeof s?.gap_pp === 'number'
  );
  return validSides.length >= expectedMinSides;
}

function classifyMatchTiming(item, nowMs = Date.now()) {
  const hasScoreSource = Boolean(
    slugForCompetition(item?.league) || competitionSlugs(item?.league).length > 0
  );
  if (item?.status === 'settled') {
    return {
      match_stage: 'settled',
      has_score_source: hasScoreSource,
      is_played: true,
      is_no_score: false,
      no_score_reason: null,
    };
  }
  if (item?.status === 'push') {
    return {
      match_stage: 'push',
      has_score_source: hasScoreSource,
      is_played: true,
      is_no_score: false,
      no_score_reason: null,
    };
  }
  const dt = parseKickoff(item?.date);
  const pastDue = Boolean(dt && nowMs - dt.getTime() >= SETTLE_GRACE_MS);
  const kickedOff = Boolean(dt && nowMs >= dt.getTime());
  if (pastDue) {
    return {
      match_stage: 'no_score',
      has_score_source: hasScoreSource,
      is_played: true,
      is_no_score: true,
      no_score_reason: hasScoreSource
        ? 'Score indisponible sur la source'
        : 'Compétition sans source de score (ESPN / SportScore)',
    };
  }
  return {
    match_stage: kickedOff ? 'live' : 'pending',
    has_score_source: hasScoreSource,
    is_played: kickedOff,
    is_no_score: false,
    no_score_reason: null,
  };
}

function enrichObservationResult(obs, nowMs = Date.now()) {
  if (!obs || typeof obs !== 'object') return obs;
  const timing = classifyMatchTiming(obs, nowMs);
  if (obs.status === 'push') {
    return {
      ...obs,
      ...timing,
      winning_labels: [],
      bf_top_label: null,
      pm_top_label: null,
      bf_top_won: null,
      pm_top_won: null,
      reco_won: null,
      reco_result: obs.recommendation ? 'push' : null,
      reco_pnl_u: obs.recommendation ? 0 : null,
      reco_staked_u: 0,
      reco_roi_pct: null,
    };
  }
  if (obs.status !== 'settled' || typeof obs.home_score !== 'number' || typeof obs.away_score !== 'number') {
    return {
      ...obs,
      ...timing,
      reco_staked_u: 0,
      reco_roi_pct: null,
    };
  }

  const resolved = resolveOutcomeVector(obs.market, {
    home_score: obs.home_score,
    away_score: obs.away_score,
    home_ht: obs.home_ht ?? null,
    away_ht: obs.away_ht ?? null,
  });
  if (resolved.status !== 'settled') return obs;

  const targets = resolved.targets || {};
  const winningLabels = Object.entries(targets)
    .filter(([, y]) => y === 1)
    .map(([lbl]) => lbl);

  const sides = Array.isArray(obs.sides) ? obs.sides : [];
  const bfTop = sides
    .filter((s) => typeof s.bf_pct === 'number')
    .sort((a, b) => b.bf_pct - a.bf_pct)[0] || null;
  const pmTop = sides
    .filter((s) => typeof s.pm_pct === 'number')
    .sort((a, b) => b.pm_pct - a.pm_pct)[0] || null;

  const bfTopWon = bfTop && targets[bfTop.label] !== undefined ? targets[bfTop.label] === 1 : null;
  const pmTopWon = pmTop && targets[pmTop.label] !== undefined ? targets[pmTop.label] === 1 : null;

  let recoWon = null;
  let recoResult = null;
  let recoPnlU = null;
  if (obs.recommendation && obs.recommendation.side_label) {
    const lbl = obs.recommendation.side_label;
    if (targets[lbl] !== undefined) {
      recoWon = targets[lbl] === 1;
      recoResult = recoWon ? 'win' : 'loss';
      const matchingSide = sides.find((s) => s.label === lbl);
      const odds =
        typeof obs.recommendation.prop_odds === 'number' && obs.recommendation.prop_odds > 1
          ? obs.recommendation.prop_odds
          : matchingSide && typeof matchingSide.pm_pct === 'number' && matchingSide.pm_pct > 1
          ? Number((100 / matchingSide.pm_pct).toFixed(2))
          : null;
      // Sans cote exploitable, le pari est exclu du ROI dans les deux sens.
      if (odds && odds > 1) {
        recoPnlU = recoWon ? Number((odds - 1).toFixed(2)) : -1;
      }
    }
  }

  const recoStakedU =
    (recoResult === 'win' || recoResult === 'loss') && typeof recoPnlU === 'number' ? 1 : 0;
  const recoRoiPct =
    recoStakedU > 0 && typeof recoPnlU === 'number'
      ? Number((recoPnlU * 100).toFixed(1))
      : null;

  return {
    ...obs,
    ...timing,
    winning_labels: winningLabels,
    bf_top_label: bfTop?.label || null,
    pm_top_label: pmTop?.label || null,
    bf_top_won: bfTopWon,
    pm_top_won: pmTopWon,
    reco_won: recoWon,
    reco_result: recoResult,
    reco_pnl_u: recoPnlU,
    reco_staked_u: recoStakedU,
    reco_roi_pct: recoRoiPct,
  };
}

function extractSideFromAction(action) {
  if (!action || typeof action !== 'string') return null;
  const trimmed = action.trim();
  if (/^1\s*\(/.test(trimmed) || trimmed === '1') return '1';
  if (/^2\s*\(/.test(trimmed) || trimmed === '2') return '2';
  if (/^Nul\s*\(X\)/i.test(trimmed) || trimmed === 'N' || trimmed === 'X') return 'N';
  if (/^1X\b/i.test(trimmed)) return '1X';
  if (/^X2\b/i.test(trimmed)) return 'X2';
  if (/^12\b/i.test(trimmed)) return '12';
  if (/^Plus de/i.test(trimmed)) return 'Over';
  if (/^Moins de/i.test(trimmed)) return 'Under';
  if (/:\s*Oui$/i.test(trimmed)) return 'Oui';
  if (/:\s*Non$/i.test(trimmed)) return 'Non';
  return null;
}

const SIGNAL_CATEGORY_META = [
  {
    category: 'executable',
    label: 'Propositions BF×PM',
    description: 'Écarts nets Betfair × Polymarket tradables',
  },
  {
    category: 'movement',
    label: 'Mouvements 24h',
    description: 'Baisses/hausses marquées et retournements Betfair',
  },
  {
    category: 'flow',
    label: 'Flux & Retards BF×PM',
    description: 'Retards PM, flux concentrés et divergences',
  },
  {
    category: 'contradiction',
    label: 'Contradictions',
    description: 'Désaccords multi-marchés ou BF × PM',
  },
];

function normalizeMarketKey(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  const low = s.toLowerCase();
  if (
    s === MarketKey.OneXTwo ||
    s === MarketKey.DoubleChance ||
    s === MarketKey.DrawNoBet ||
    s === MarketKey.OverUnder15 ||
    s === MarketKey.OverUnder25 ||
    s === MarketKey.OverUnder35 ||
    s === MarketKey.Btts ||
    s === MarketKey.HalfTime
  ) {
    return s;
  }
  if (low === '1x2') return MarketKey.OneXTwo;
  if (low === 'double chance') return MarketKey.DoubleChance;
  if (low === 'dnb') return MarketKey.DrawNoBet;
  if (low.includes('1.5')) return MarketKey.OverUnder15;
  if (low.includes('2.5')) return MarketKey.OverUnder25;
  if (low.includes('3.5')) return MarketKey.OverUnder35;
  if (low === 'btts') return MarketKey.Btts;
  if (low.includes('mi-temps') || low === 'ht') return MarketKey.HalfTime;
  return null;
}

function normalizeOutcomeSide(lbl) {
  if (!lbl || typeof lbl !== 'string') return null;
  const t = lbl.trim();
  if (t === 'X') return 'N';
  return t;
}

function extractSideFromSignal(sig) {
  if (!sig || typeof sig !== 'object') return null;
  if (sig.side_label) return normalizeOutcomeSide(sig.side_label);
  if (sig.category === 'executable') {
    return extractSideFromAction(sig.action || sig.title);
  }
  if (sig.category === 'flow' && typeof sig.title === 'string') {
    const m = sig.title.match(/\((1|N|X|2|1X|X2|12|Over|Under|Oui|Non)\)/);
    if (m) return normalizeOutcomeSide(m[1]);
  }
  if (sig.category === 'movement' && typeof sig.title === 'string') {
    const m = sig.title.match(/\((1|N|X|2|1X|X2|12|Over|Under|Oui|Non)\)\s*$/);
    if (m) return normalizeOutcomeSide(m[1]);
  }
  return null;
}

function buildScoreOutcomesSummary(ev) {
  if (typeof ev?.home_score !== 'number' || typeof ev?.away_score !== 'number') return [];
  const res = ev.home_score > ev.away_score ? '1' : ev.home_score < ev.away_score ? '2' : 'N';
  const ou25 = ev.home_score + ev.away_score >= 3 ? 'Over 2.5' : 'Under 2.5';
  const btts = ev.home_score > 0 && ev.away_score > 0 ? 'BTTS Oui' : 'BTTS Non';
  return [res, ou25, btts];
}

function enrichSignalRecord(rec, obsByFixture = null, nowMs = Date.now()) {
  if (!rec || typeof rec !== 'object') return rec;
  const timing = classifyMatchTiming(rec, nowMs);
  const sigList = Array.isArray(rec.signals) ? rec.signals : [];
  const fixtureObs = (obsByFixture && obsByFixture.get(rec.fixture_key)) || [];
  const settledObs = fixtureObs.filter((o) => o.status === 'settled');

  const avgNum = (arr, key) => {
    const valid = arr.filter((x) => typeof x[key] === 'number');
    return valid.length > 0
      ? Number((valid.reduce((acc, x) => acc + x[key], 0) / valid.length).toFixed(4))
      : null;
  };
  const brierBfAvg = avgNum(settledObs, 'brier_bf');
  const brierPmAvg = avgNum(settledObs, 'brier_pm');
  let obsBetterSource = null;
  if (brierBfAvg !== null && brierPmAvg !== null) {
    if (brierBfAvg + 1e-4 < brierPmAvg) obsBetterSource = 'betfair';
    else if (brierPmAvg + 1e-4 < brierBfAvg) obsBetterSource = 'polymarket';
    else obsBetterSource = 'tie';
  }
  const marketSnapshots = fixtureObs.map((o) => ({
    id: o.id,
    market: o.market,
    market_short: o.market_short,
    market_label: o.market_label || o.market_short,
    status: o.status,
    brier_bf: o.brier_bf ?? null,
    brier_pm: o.brier_pm ?? null,
    max_abs_gap_pp: o.max_abs_gap_pp ?? null,
    winning_labels: o.winning_labels || [],
    sides: o.sides || [],
  }));

  if (rec.status === 'pending') {
    return {
      ...rec,
      ...timing,
      signals: sigList.map((s) => ({
        ...s,
        market: normalizeMarketKey(s.market || s.market_short) || s.market || null,
        side_label: extractSideFromSignal(s),
        signal_result: timing.is_no_score ? 'no_score' : 'pending',
        pnl_u: null,
        winning_labels: [],
      })),
      match_outcome: timing.is_no_score ? 'no_score' : 'pending',
      reco_won: 0,
      reco_lost: 0,
      reco_push: 0,
      reco_staked_u: 0,
      reco_pnl_u: null,
      reco_roi_pct: null,
      brier_bf: null,
      brier_pm: null,
      better_source: null,
      market_snapshots: marketSnapshots,
    };
  }

  if (rec.status === 'push') {
    return {
      ...rec,
      ...timing,
      signals: sigList.map((s) => ({
        ...s,
        market: normalizeMarketKey(s.market || s.market_short) || s.market || null,
        side_label: extractSideFromSignal(s),
        signal_result: 'push',
        pnl_u: s.category === 'executable' ? 0 : null,
        winning_labels: [],
      })),
      match_outcome: 'push',
      reco_won: 0,
      reco_lost: 0,
      reco_push: sigList.filter((s) => s.category === 'executable').length,
      reco_staked_u: 0,
      reco_pnl_u: sigList.some((s) => s.category === 'executable') ? 0 : null,
      reco_roi_pct: null,
      brier_bf: brierBfAvg,
      brier_pm: brierPmAvg,
      better_source: obsBetterSource,
      market_snapshots: marketSnapshots,
    };
  }

  const ev = {
    home_score: rec.home_score,
    away_score: rec.away_score,
    home_ht: rec.home_ht ?? null,
    away_ht: rec.away_ht ?? null,
  };

  let recoWon = 0;
  let recoLost = 0;
  let recoPush = 0;
  let recoStakedU = 0;
  let pnlSum = 0;
  let hasPnl = false;

  const enrichedSignals = sigList.map((s) => {
    const mktKey = normalizeMarketKey(s.market || s.market_short);
    const sideLbl = extractSideFromSignal(s);
    const resolved = mktKey ? resolveOutcomeVector(mktKey, ev) : { status: 'unsupported' };
    if (resolved.status === 'push') {
      if (s.category === 'executable') {
        recoPush += 1;
        hasPnl = true;
      }
      return {
        ...s,
        market: mktKey || s.market || null,
        side_label: sideLbl,
        signal_result: 'push',
        pnl_u: s.category === 'executable' ? 0 : null,
        winning_labels: [],
      };
    }

    if (resolved.status === 'settled') {
      const targets = resolved.targets || {};
      const winningLabels = Object.entries(targets)
        .filter(([, y]) => y === 1)
        .map(([lbl]) => lbl);

      if (s.category === 'executable' && sideLbl && targets[sideLbl] !== undefined) {
        const won = targets[sideLbl] === 1;
        if (won) recoWon += 1;
        else recoLost += 1;
        const odds =
          typeof s.prop_odds === 'number' && s.prop_odds > 1
            ? s.prop_odds
            : typeof s.prop_pct === 'number' && s.prop_pct > 1
            ? Number((100 / s.prop_pct).toFixed(2))
            : null;
        let pnlU = null;
        // Une cote manquante exclut le pari du ROI, gagnant comme perdant.
        if (odds && odds > 1) {
          pnlU = won ? Number((odds - 1).toFixed(2)) : -1;
          pnlSum += pnlU;
          recoStakedU += 1;
          hasPnl = true;
        }
        return {
          ...s,
          market: mktKey,
          side_label: sideLbl,
          signal_result: won ? 'win' : 'loss',
          pnl_u: pnlU,
          winning_labels: winningLabels,
        };
      }

      if (s.category === 'movement' && sideLbl && targets[sideLbl] !== undefined) {
        const isFade = typeof s.drop_pct === 'number' && s.drop_pct > 0;
        const won = isFade ? targets[sideLbl] === 0 : targets[sideLbl] === 1;
        return {
          ...s,
          market: mktKey,
          side_label: sideLbl,
          side_hit: targets[sideLbl] === 1,
          direction_hint: isFade ? 'fade' : 'back',
          signal_result: won ? 'win' : 'loss',
          pnl_u: null,
          winning_labels: winningLabels,
        };
      }

      if (s.category === 'flow' && sideLbl && targets[sideLbl] !== undefined) {
        const isSell = s.direction === 'sell_pm';
        const won = isSell ? targets[sideLbl] === 0 : targets[sideLbl] === 1;
        return {
          ...s,
          market: mktKey,
          side_label: sideLbl,
          side_hit: targets[sideLbl] === 1,
          signal_result: won ? 'win' : 'loss',
          pnl_u: null,
          winning_labels: winningLabels,
        };
      }

      return {
        ...s,
        market: mktKey || s.market || null,
        side_label: sideLbl,
        signal_result: 'settled',
        pnl_u: null,
        winning_labels: winningLabels,
        better_source: obsBetterSource,
      };
    }

    const fallbackWin = buildScoreOutcomesSummary(ev);
    return {
      ...s,
      market: mktKey || s.market || null,
      side_label: sideLbl,
      signal_result: 'settled',
      pnl_u: null,
      winning_labels: fallbackWin,
      better_source: obsBetterSource,
    };
  });

  const anyWon = enrichedSignals.filter((s) => s.signal_result === 'win').length;
  const anyLost = enrichedSignals.filter((s) => s.signal_result === 'loss').length;
  const anyPush = enrichedSignals.filter((s) => s.signal_result === 'push').length;

  let matchOutcome = 'settled';
  if (recoWon > 0 && recoLost === 0) matchOutcome = 'win';
  else if (recoLost > 0 && recoWon === 0) matchOutcome = 'loss';
  else if (recoWon > 0 && recoLost > 0) matchOutcome = 'mixed';
  else if (recoPush > 0 && recoWon === 0 && recoLost === 0) matchOutcome = 'push';
  else if (anyWon > 0 && anyLost === 0) matchOutcome = 'win';
  else if (anyLost > 0 && anyWon === 0) matchOutcome = 'loss';
  else if (anyWon > 0 && anyLost > 0) matchOutcome = 'mixed';
  else if (anyPush > 0) matchOutcome = 'push';

  const recoPnl = hasPnl ? Number(pnlSum.toFixed(2)) : null;
  const recoRoiPct =
    recoStakedU > 0 && hasPnl ? Number(((pnlSum / recoStakedU) * 100).toFixed(1)) : null;

  return {
    ...rec,
    ...timing,
    signals: enrichedSignals,
    match_outcome: matchOutcome,
    reco_won: recoWon,
    reco_lost: recoLost,
    reco_push: recoPush,
    reco_staked_u: recoStakedU,
    reco_pnl_u: recoPnl,
    reco_roi_pct: recoRoiPct,
    brier_bf: brierBfAvg,
    brier_pm: brierPmAvg,
    better_source: obsBetterSource,
    market_snapshots: marketSnapshots,
  };
}

function summarizeCategoryRecords(records, catMeta) {
  const cat = catMeta.category;
  const matching = records.filter((r) => (r.signals || []).some((s) => s.category === cat));
  const settledMatches = matching.filter((r) => r.status === 'settled');
  const pushMatches = matching.filter((r) => r.status === 'push');
  const noScoreMatches = matching.filter((r) => r.is_no_score === true);
  const pendingMatches = matching.filter((r) => r.status === 'pending' && !r.is_no_score);
  const playedMatches = settledMatches.length + pushMatches.length + noScoreMatches.length;
  const scoredMatches = settledMatches.length + pushMatches.length;

  let totalSignals = 0;
  let settledSignals = 0;
  let won = 0;
  let lost = 0;
  let push = 0;
  let stakedU = 0;
  let pnlSum = 0;
  let hasPnl = false;

  for (const r of matching) {
    for (const s of r.signals || []) {
      if (s.category !== cat) continue;
      totalSignals += 1;
      if (r.status === 'settled' || r.status === 'push') settledSignals += 1;
      if (s.signal_result === 'win') won += 1;
      else if (s.signal_result === 'loss') lost += 1;
      else if (s.signal_result === 'push') push += 1;
      if (typeof s.pnl_u === 'number') {
        pnlSum += s.pnl_u;
        hasPnl = true;
        if (s.signal_result === 'win' || s.signal_result === 'loss') {
          stakedU += 1;
        }
      }
    }
  }

  const withBrier = settledMatches.filter(
    (r) => typeof r.brier_bf === 'number' && typeof r.brier_pm === 'number'
  );
  const brierBf =
    withBrier.length > 0
      ? Number((withBrier.reduce((a, r) => a + r.brier_bf, 0) / withBrier.length).toFixed(4))
      : null;
  const brierPm =
    withBrier.length > 0
      ? Number((withBrier.reduce((a, r) => a + r.brier_pm, 0) / withBrier.length).toFixed(4))
      : null;
  const bfWins = withBrier.filter((r) => r.better_source === 'betfair').length;
  const pmWins = withBrier.filter((r) => r.better_source === 'polymarket').length;

  const decided = won + lost;
  const roiU = hasPnl ? Number(pnlSum.toFixed(2)) : null;
  const roiPct = stakedU > 0 && hasPnl ? Number(((pnlSum / stakedU) * 100).toFixed(1)) : null;
  const roiState =
    !hasPnl || stakedU === 0
      ? 'na'
      : pnlSum > 0
      ? 'positive'
      : pnlSum < 0
      ? 'negative'
      : 'neutral';

  return {
    category: cat,
    label: catMeta.label,
    description: catMeta.description,
    total_matches: matching.length,
    played_matches: playedMatches,
    scored_matches: scoredMatches,
    settled_matches: settledMatches.length,
    pending_matches: pendingMatches.length,
    no_score_matches: noScoreMatches.length,
    push_matches: pushMatches.length,
    total_signals: totalSignals,
    settled_signals: settledSignals,
    won,
    lost,
    push,
    decided,
    win_rate_pct: decided > 0 ? Number(((won / decided) * 100).toFixed(1)) : null,
    staked_u: stakedU,
    roi_n: stakedU,
    roi_u: roiU,
    roi_pct: roiPct,
    roi_state: roiState,
    brier_bf: brierBf,
    brier_pm: brierPm,
    bf_wins: bfWins,
    pm_wins: pmWins,
  };
}

function selectBestCategory(byCategory, minN = DEFAULT_CALIBRATION_MIN_N) {
  if (!Array.isArray(byCategory) || byCategory.length === 0) return null;
  const minimum = Math.max(1, Number.parseInt(String(minN), 10) || DEFAULT_CALIBRATION_MIN_N);
  const eligible = byCategory.filter((c) => (c.decided || 0) >= minimum);
  if (eligible.length === 0) return null;
  const tierOf = (c) => {
    const hasDecided = (c.decided || 0) > 0;
    const hasRoi = typeof c.roi_pct === 'number';
    if (hasRoi && c.roi_pct > 0) return 4;
    if (hasDecided && !hasRoi && (c.win_rate_pct ?? 0) >= 50) return 3;
    if (hasDecided) return 2;
    if ((c.settled_matches || 0) > 0) return 1;
    if ((c.total_matches || 0) > 0) return 0.5;
    return 0;
  };
  const ranked = [...eligible].sort((a, b) => {
    const ta = tierOf(a);
    const tb = tierOf(b);
    if (ta !== tb) return tb - ta;
    const ra = typeof a.roi_pct === 'number' ? a.roi_pct : -9999;
    const rb = typeof b.roi_pct === 'number' ? b.roi_pct : -9999;
    if (ra !== rb) return rb - ra;
    const wa = a.win_rate_pct ?? -1;
    const wb = b.win_rate_pct ?? -1;
    if (wa !== wb) return wb - wa;
    if ((a.decided || 0) !== (b.decided || 0)) return (b.decided || 0) - (a.decided || 0);
    if ((a.settled_matches || 0) !== (b.settled_matches || 0)) {
      return (b.settled_matches || 0) - (a.settled_matches || 0);
    }
    return (b.total_matches || 0) - (a.total_matches || 0);
  });
  return ranked[0]?.category || 'executable';
}

export class CalibrationStore {
  constructor(filePath = path.resolve(process.cwd(), 'data', 'observations.json')) {
    this.filePath = filePath;
    this.signalFilePath = path.join(path.dirname(filePath), 'signal_history.json');
    this.metaFilePath = path.join(path.dirname(filePath), 'store-meta.json');
    this.dbPath = filePath.endsWith('.db')
      ? filePath
      : path.join(path.dirname(filePath), 'truevalue.db');
    this.db = this._openDb();
    this.storageMode = this.db ? 'sqlite' : 'json';
    this._metaCache = null;
    this._settleInFlight = null;
    this.observations = this._load();
    this.signalRecords = this._loadSignals();
    this._backfillSignalsFromObservations();
  }

  _openDb() {
    if (!DatabaseSync) return null;
    try {
      const dir = path.dirname(this.dbPath);
      fs.mkdirSync(dir, { recursive: true });
      const db = new DatabaseSync(this.dbPath);
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS observations (
          id TEXT PRIMARY KEY,
          fixture_key TEXT NOT NULL,
          captured_at TEXT,
          date TEXT,
          status TEXT NOT NULL,
          data_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_obs_status_date ON observations(status, date);
        CREATE INDEX IF NOT EXISTS idx_obs_fixture ON observations(fixture_key);
        CREATE TABLE IF NOT EXISTS signal_records (
          fixture_key TEXT PRIMARY KEY,
          captured_at TEXT,
          date TEXT,
          status TEXT NOT NULL,
          data_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sig_status_date ON signal_records(status, date);
        CREATE TABLE IF NOT EXISTS subscriptions (
          telegram_user_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          plan TEXT,
          expires_at TEXT,
          charge_id TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      return db;
    } catch (err) {
      console.error('SQLite indisponible, repli JSON :', err?.message || err);
      return null;
    }
  }

  _writeJson(targetPath, value) {
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      return true;
    } catch (err) {
      console.error('Écriture JSON impossible:', err?.message || err);
      return false;
    }
  }

  _readMeta() {
    if (this._metaCache) return this._metaCache;
    let meta = null;
    try {
      if (fs.existsSync(this.metaFilePath)) {
        meta = JSON.parse(fs.readFileSync(this.metaFilePath, 'utf8'));
      }
    } catch (err) {
      console.error('Lecture du stockage JSON impossible:', err?.message || err);
    }
    this._metaCache = {
      settings: meta?.settings && typeof meta.settings === 'object' ? meta.settings : {},
      subscriptions:
        meta?.subscriptions && typeof meta.subscriptions === 'object' ? meta.subscriptions : {},
    };
    return this._metaCache;
  }

  _writeMeta() {
    return this._writeJson(this.metaFilePath, this._readMeta());
  }

  _readLegacyJson(targetPath) {
    try {
      if (!fs.existsSync(targetPath)) return [];
      const raw = fs.readFileSync(targetPath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  _load() {
    if (this.db) {
      try {
        const rows = this.db
          .prepare('SELECT data_json FROM observations ORDER BY captured_at DESC')
          .all();
        if (rows.length > 0) {
          return rows
            .map((r) => {
              try {
                return JSON.parse(r.data_json);
              } catch {
                return null;
              }
            })
            .filter(isValidObservation);
        }
        const legacy = this._readLegacyJson(this.filePath).filter(isValidObservation);
        if (legacy.length > 0) {
          this.observations = legacy;
          this._save();
        }
        return legacy;
      } catch {
        // Fallback below if SQLite read fails
      }
    }
    return this._readLegacyJson(this.filePath).filter(isValidObservation);
  }

  _save() {
    if (!this.db) {
      this._writeJson(this.filePath, this.observations);
      return;
    }
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.exec('DELETE FROM observations');
      const stmt = this.db.prepare(
        'INSERT OR REPLACE INTO observations (id, fixture_key, captured_at, date, status, data_json) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (const obs of this.observations) {
        stmt.run(
          String(obs.id),
          String(obs.fixture_key || ''),
          obs.captured_at || null,
          obs.date || null,
          String(obs.status || 'pending'),
          JSON.stringify(obs)
        );
      }
      this.db.exec('COMMIT');
    } catch {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failure
      }
    }
  }

  _loadSignals() {
    const validSigRec = (r) =>
      r && typeof r === 'object' && r.fixture_key && Array.isArray(r.signals);
    if (this.db) {
      try {
        const rows = this.db
          .prepare('SELECT data_json FROM signal_records ORDER BY captured_at DESC')
          .all();
        if (rows.length > 0) {
          return rows
            .map((r) => {
              try {
                return JSON.parse(r.data_json);
              } catch {
                return null;
              }
            })
            .filter(validSigRec);
        }
        const legacy = this._readLegacyJson(this.signalFilePath).filter(validSigRec);
        if (legacy.length > 0) {
          this.signalRecords = legacy;
          this._saveSignals();
        }
        return legacy;
      } catch {
        // Fallback below
      }
    }
    return this._readLegacyJson(this.signalFilePath).filter(validSigRec);
  }

  _saveSignals() {
    if (!this.db) {
      this._writeJson(this.signalFilePath, this.signalRecords);
      return;
    }
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.exec('DELETE FROM signal_records');
      const stmt = this.db.prepare(
        'INSERT OR REPLACE INTO signal_records (fixture_key, captured_at, date, status, data_json) VALUES (?, ?, ?, ?, ?)'
      );
      for (const rec of this.signalRecords) {
        stmt.run(
          String(rec.fixture_key),
          rec.captured_at || null,
          rec.date || null,
          String(rec.status || 'pending'),
          JSON.stringify(rec)
        );
      }
      this.db.exec('COMMIT');
    } catch {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failure
      }
    }
  }

  getSetting(key) {
    if (!key) return null;
    if (!this.db) {
      const value = this._readMeta().settings[String(key)];
      return value === undefined ? null : value;
    }
    try {
      const row = this.db
        .prepare('SELECT value FROM app_settings WHERE key = ?')
        .get(String(key));
      return row ? row.value : null;
    } catch {
      return null;
    }
  }

  setSetting(key, value) {
    if (!key) return false;
    if (!this.db) {
      this._readMeta().settings[String(key)] = String(value);
      return this._writeMeta();
    }
    try {
      this.db
        .prepare(
          'INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)'
        )
        .run(String(key), String(value), new Date().toISOString());
      return true;
    } catch {
      return false;
    }
  }

  claimSettingOnce(key, value) {
    if (!key) return false;
    if (!this.db) {
      const store = this._readMeta().settings;
      const id = String(key);
      if (Object.prototype.hasOwnProperty.call(store, id)) return false;
      store[id] = String(value);
      return this._writeMeta();
    }
    try {
      const res = this.db
        .prepare(
          'INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)'
        )
        .run(String(key), String(value), new Date().toISOString());
      return Number(res?.changes || 0) === 1;
    } catch {
      return false;
    }
  }

  getSubscription(telegramUserId) {
    if (!telegramUserId) return null;
    if (!this.db) {
      const row = this._readMeta().subscriptions[String(telegramUserId)];
      if (!row) return null;
      const active =
        row.status === 'active' &&
        (!row.expires_at || Date.parse(row.expires_at) > Date.now());
      return { ...row, active };
    }
    try {
      const row = this.db
        .prepare(
          'SELECT telegram_user_id, status, plan, expires_at, charge_id, updated_at FROM subscriptions WHERE telegram_user_id = ?'
        )
        .get(String(telegramUserId));
      if (!row) return null;
      const active =
        row.status === 'active' &&
        (!row.expires_at || Date.parse(row.expires_at) > Date.now());
      return { ...row, active };
    } catch {
      return null;
    }
  }

  upsertSubscription({
    telegramUserId,
    status = 'active',
    plan = 'pro_monthly',
    expiresAt = null,
    chargeId = null,
  }) {
    if (!telegramUserId) return null;
    const nowIso = new Date().toISOString();
    if (!this.db) {
      const store = this._readMeta().subscriptions;
      const id = String(telegramUserId);
      const previous = store[id] || {};
      store[id] = {
        telegram_user_id: id,
        status: String(status),
        plan: plan ? String(plan) : null,
        expires_at: expiresAt ? String(expiresAt) : null,
        charge_id: chargeId ? String(chargeId) : previous.charge_id || null,
        updated_at: nowIso,
      };
      if (!this._writeMeta()) return null;
      return this.getSubscription(id);
    }
    this.db
      .prepare(
        `INSERT INTO subscriptions (telegram_user_id, status, plan, expires_at, charge_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(telegram_user_id) DO UPDATE SET
           status = excluded.status,
           plan = excluded.plan,
           expires_at = excluded.expires_at,
           charge_id = COALESCE(excluded.charge_id, subscriptions.charge_id),
           updated_at = excluded.updated_at`
      )
      .run(
        String(telegramUserId),
        String(status),
        plan ? String(plan) : null,
        expiresAt ? String(expiresAt) : null,
        chargeId ? String(chargeId) : null,
        nowIso
      );
    return this.getSubscription(telegramUserId);
  }

  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // Ignore close failure
      }
      this.db = null;
    }
  }

  _backfillSignalsFromObservations() {
    const byKey = new Map(this.signalRecords.map((r) => [r.fixture_key, r]));
    let changed = false;

    for (const obs of this.observations) {
      if (!obs.recommendation) continue;
      const existing = byKey.get(obs.fixture_key);
      const sigEntry = {
        id: `exec::${obs.fixture_key}::${obs.market}::${obs.recommendation.side_label || ''}`,
        category: 'executable',
        category_label: 'Proposition BF×PM',
        signal_type: null,
        market: obs.market,
        market_short: obs.market_short,
        title: `Proposition : ${obs.recommendation.action || obs.recommendation.side_label}`,
        detail: '',
        tier: obs.recommendation.tier || null,
        tier_label: obs.recommendation.tier_label || null,
        direction: obs.recommendation.direction || null,
        side_label: obs.recommendation.side_label || null,
        action: obs.recommendation.action || obs.recommendation.side_label || null,
        net_edge_pp: obs.recommendation.net_edge_pp ?? null,
        prop_odds: obs.recommendation.prop_odds ?? null,
        prop_pct: obs.recommendation.prop_pct ?? null,
        bf_prop_pct: obs.recommendation.bf_prop_pct ?? null,
        score_sort: 80,
      };

      if (!existing) {
        byKey.set(obs.fixture_key, {
          fixture_key: obs.fixture_key,
          home: obs.home,
          away: obs.away,
          league: obs.league,
          country: null,
          date: obs.date,
          date_label: obs.date_label,
          total_volume_bf: obs.bf_volume || 0,
          pm_liquidity: obs.pm_liquidity ?? null,
          signature_code: null,
          pm_signature_code: null,
          pm_url: null,
          status: obs.status || 'pending',
          home_score: obs.home_score ?? null,
          away_score: obs.away_score ?? null,
          home_ht: obs.home_ht ?? null,
          away_ht: obs.away_ht ?? null,
          result_source: obs.result_source ?? null,
          settled_at: obs.settled_at ?? null,
          captured_at: obs.captured_at,
          updated_at: obs.captured_at,
          signals: [sigEntry],
        });
        changed = true;
      } else {
        const hasSig = existing.signals.some((s) => s.id === sigEntry.id || (s.category === 'executable' && s.market === sigEntry.market));
        if (!hasSig && existing.status === 'pending') {
          existing.signals.push(sigEntry);
          changed = true;
        }
        if (existing.status === 'pending' && (obs.status === 'settled' || obs.status === 'push')) {
          existing.status = obs.status;
          existing.home_score = obs.home_score ?? existing.home_score ?? null;
          existing.away_score = obs.away_score ?? existing.away_score ?? null;
          existing.home_ht = obs.home_ht ?? existing.home_ht ?? null;
          existing.away_ht = obs.away_ht ?? existing.away_ht ?? null;
          existing.result_source = obs.result_source ?? existing.result_source ?? null;
          existing.settled_at = obs.settled_at ?? existing.settled_at ?? null;
          changed = true;
        }
      }
    }

    if (changed) {
      this.signalRecords = [...byKey.values()]
        .sort((a, b) => String(b.captured_at || '').localeCompare(String(a.captured_at || '')))
        .slice(0, MAX_OBSERVATIONS);
    }
  }

  recordFromComparison(comparisonRows, nowMs = Date.now()) {
    let added = 0;
    let updated = 0;
    const byId = new Map(this.observations.map((o) => [o.id, o]));

    for (const fixture of comparisonRows || []) {
      const kickoff = parseKickoff(fixture.date);
      if (kickoff && kickoff.getTime() <= nowMs) {
        continue;
      }

      for (const mkt of fixture.markets || []) {
        if (marketDef(mkt.market).shape === MarketShape.Multi) continue;
        if (!mkt.pm_usable) continue;

        const validSides = (mkt.sides || []).filter(
          (s) =>
            typeof s.bf_pct === 'number' &&
            typeof s.pm_pct === 'number' &&
            typeof s.gap_pp === 'number'
        );
        const minSides = marketDef(mkt.market).shape === MarketShape.ThreeWay ? 3 : 2;
        if (validSides.length < minSides) continue;

        const id = `${fixture.fixture_key}::${mkt.market}`;
        const existing = byId.get(id);
        if (existing && existing.status !== 'pending') continue;

        const reco =
          (fixture.recommendations || []).find((r) => r.market === mkt.market) ||
          null;
        const keptReco = reco
          ? {
              tier: reco.tier,
              tier_label: reco.tier_label,
              direction: reco.direction,
              side_label: reco.side_label,
              action: reco.action || reco.side_label,
              net_edge_pp: reco.net_edge_pp,
              prop_odds: reco.prop_odds ?? reco.pm_exec_odds ?? null,
              prop_pct: reco.prop_pct ?? reco.pm_exec_pct ?? null,
              bf_prop_pct: reco.bf_prop_pct ?? reco.bf_pct ?? null,
            }
          : existing?.recommendation || null;

        const record = {
          id,
          fixture_key: fixture.fixture_key,
          home: fixture.home,
          away: fixture.away,
          league: fixture.league,
          date: fixture.date,
          date_label: fixture.date_label || formatDate(fixture.date),
          market: mkt.market,
          market_short: mkt.short,
          market_label: mkt.label || mkt.short,
          bf_volume: mkt.bf_volume,
          pm_liquidity: mkt.pm_liquidity,
          pm_spread_pts: mkt.pm_spread_pts,
          max_abs_gap_pp: mkt.max_abs_gap_pp,
          recommendation: keptReco,
          sides: validSides.map((s) => ({
            label: s.label,
            bf_pct: s.bf_pct,
            pm_pct: s.pm_pct,
            gap_pp: s.gap_pp,
          })),
          status: 'pending',
          captured_at: new Date(nowMs).toISOString(),
        };

        if (existing) {
          updated += 1;
        } else {
          added += 1;
        }
        byId.set(id, record);
      }
    }

    const list = [...byId.values()]
      .sort((a, b) => String(b.captured_at).localeCompare(String(a.captured_at)))
      .slice(0, MAX_OBSERVATIONS);
    this.observations = list;
    if (added > 0 || updated > 0) {
      this._save();
      this._backfillSignalsFromObservations();
      this._saveSignals();
    }
    return { added, updated, total: this.observations.length };
  }

  recordFromSignals(signalsReport, nowMs = Date.now()) {
    const allSigs = Array.isArray(signalsReport?.all_signals) ? signalsReport.all_signals : [];
    if (allSigs.length === 0) return { added: 0, updated: 0, total: this.signalRecords.length };

    const grouped = new Map();
    for (const s of allSigs) {
      if (!s || !s.fixture_key) continue;
      const dt = parseKickoff(s.date);
      if (dt && dt.getTime() <= nowMs) continue;
      if (!grouped.has(s.fixture_key)) {
        grouped.set(s.fixture_key, { meta: s, sigs: [] });
      }
      grouped.get(s.fixture_key).sigs.push(s);
    }

    const byKey = new Map(this.signalRecords.map((r) => [r.fixture_key, r]));
    let added = 0;
    let updated = 0;

    for (const [fKey, bundle] of grouped.entries()) {
      const existing = byKey.get(fKey);
      if (existing && existing.status !== 'pending') continue;

      const meta = bundle.meta;
      const sigMap = new Map(
        (existing?.signals || []).map((prev) => [prev.id, prev])
      );
      for (const s of bundle.sigs) {
        const normMkt = normalizeMarketKey(s.market || s.market_short) || s.market || null;
        const sideLbl = extractSideFromSignal(s);
        for (const [prevId, prevSig] of sigMap.entries()) {
          if (
            prevId !== s.id &&
            prevSig.category === s.category &&
            normalizeMarketKey(prevSig.market || prevSig.market_short) === normMkt &&
            (s.category === 'executable' || (prevSig.side_label || null) === (sideLbl || null))
          ) {
            sigMap.delete(prevId);
          }
        }
        sigMap.set(s.id, {
          id: s.id,
          category: s.category,
          category_label: s.category_label,
          signal_type: s.signal_type || null,
          market: normMkt,
          market_short: s.market_short || s.market || null,
          title: s.title,
          detail: s.detail,
          tier: s.tier || s.recommendation?.tier || null,
          tier_label: s.tier_label || s.recommendation?.tier_label || null,
          direction: s.direction || s.recommendation?.direction || null,
          side_label: sideLbl,
          action: s.recommendation?.action || null,
          net_edge_pp: typeof s.net_edge_pp === 'number' ? s.net_edge_pp : null,
          prop_odds: s.recommendation?.prop_odds ?? s.recommendation?.pm_exec_odds ?? null,
          prop_pct: s.recommendation?.prop_pct ?? s.recommendation?.pm_exec_pct ?? null,
          bf_prop_pct: s.recommendation?.bf_prop_pct ?? s.recommendation?.bf_pct ?? null,
          drop_pct: typeof s.drop_pct === 'number' ? s.drop_pct : s.config_summary?.axes?.variation?.drop_pct ?? null,
          amplitude_pct: typeof s.amplitude_pct === 'number' ? s.amplitude_pct : null,
          prob_delta_pp: typeof s.prob_delta_pp === 'number' ? s.prob_delta_pp : null,
          items: Array.isArray(s.items) ? s.items.slice(0, 5) : undefined,
          score_sort: s.score_sort || 0,
        });
      }

      const mergedSigs = [...sigMap.values()]
        .sort((a, b) => (b.score_sort || 0) - (a.score_sort || 0))
        .slice(0, 12);

      const rec = {
        fixture_key: fKey,
        home: meta.home,
        away: meta.away,
        league: meta.league,
        country: meta.country || existing?.country || null,
        date: meta.date || existing?.date || null,
        date_label: meta.date_label || existing?.date_label || formatDate(meta.date),
        total_volume_bf: Math.max(meta.total_volume_bf || 0, existing?.total_volume_bf || 0),
        pm_liquidity: meta.pm_liquidity ?? existing?.pm_liquidity ?? null,
        signature_code: meta.signature_code || existing?.signature_code || null,
        pm_signature_code: meta.pm_signature_code || existing?.pm_signature_code || null,
        pm_url: meta.pm_url || existing?.pm_url || null,
        status: 'pending',
        captured_at: existing?.captured_at || new Date(nowMs).toISOString(),
        updated_at: new Date(nowMs).toISOString(),
        signals: mergedSigs,
      };

      if (existing) updated += 1;
      else added += 1;
      byKey.set(fKey, rec);
    }

    if (added > 0 || updated > 0) {
      this.signalRecords = [...byKey.values()]
        .sort((a, b) => String(b.captured_at || '').localeCompare(String(a.captured_at || '')))
        .slice(0, MAX_OBSERVATIONS);
      this._saveSignals();
    }
    return { added, updated, total: this.signalRecords.length };
  }

  async settle({ espn, sportscore, cfg = {} } = {}, nowMs = Date.now()) {
    if (this._settleInFlight) {
      return this._settleInFlight;
    }
    const run = this._settleInternal({ espn, sportscore, cfg }, nowMs).finally(() => {
      if (this._settleInFlight === run) {
        this._settleInFlight = null;
      }
    });
    this._settleInFlight = run;
    return run;
  }

  async _settleInternal({ espn, sportscore, cfg = {} } = {}, nowMs = Date.now()) {
    const dueObs = this.observations.filter((o) => {
      if (o.status !== 'pending') return false;
      const dt = parseKickoff(o.date);
      if (!dt) return false;
      return nowMs - dt.getTime() >= SETTLE_GRACE_MS;
    });

    const dueSigs = this.signalRecords.filter((r) => {
      if (r.status !== 'pending') return false;
      const dt = parseKickoff(r.date);
      if (!dt) return false;
      return nowMs - dt.getTime() >= SETTLE_GRACE_MS;
    });

    if (dueObs.length === 0 && dueSigs.length === 0) {
      return { checked: 0, settled: 0, signal_settled: 0, errors: [] };
    }

    const espnReqs = new Map();
    const ssReqs = [];

    for (const item of [...dueObs, ...dueSigs]) {
      const slug = slugForCompetition(item.league);
      if (slug && cfg.espnEnabled !== false && espn) {
        for (const d of dayStringsAround(item.date)) {
          const espnDay = d.replace(/-/g, '');
          espnReqs.set(`${slug}|${espnDay}`, [slug, espnDay]);
        }
      }
      const ssSlugs = competitionSlugs(item.league);
      if (ssSlugs.length > 0 && !cfg.sportscoreDisabled && sportscore) {
        for (const d of dayStringsAround(item.date)) {
          for (const s of ssSlugs) ssReqs.push([d, s]);
        }
      }
    }

    const espnEvents = [];
    const errors = [];
    if (espn && espnReqs.size > 0) {
      const byDay = new Map();
      for (const [slug, day] of espnReqs.values()) {
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(slug);
      }
      await mapWithConcurrency([...byDay.entries()], 3, async ([day, slugs]) => {
        const res = await espn.many(slugs, day, 4);
        espnEvents.push(...res.events);
        errors.push(...res.errors);
      });
    }

    const ssEvents = [];
    if (sportscore && ssReqs.length > 0) {
      const res = await sportscore.many(ssReqs, 4);
      ssEvents.push(...res.events);
      errors.push(...res.warnings);
    }

    const findMatch = (item) => {
      const slug = slugForCompetition(item.league);
      const espnMatch = slug
        ? findEspnMatch(item.home, item.away, item.date, slug, espnEvents)
        : null;
      if (espnMatch) return { match: espnMatch, source: 'espn' };

      const ssMatch = findSportScoreMatch(
        item.home,
        item.away,
        item.date,
        item.league,
        ssEvents
      );
      if (ssMatch) return { match: ssMatch, source: 'sportscore' };
      return null;
    };

    let settledCount = 0;
    this.observations = this.observations.map((obs) => {
      if (obs.status !== 'pending') return obs;
      const dt = parseKickoff(obs.date);
      if (!dt || nowMs - dt.getTime() < SETTLE_GRACE_MS) return obs;

      const found = findMatch(obs);
      if (!found) return obs;
      const updated = scoreObservationAgainstEvent(obs, found.match, found.source);
      if (updated) {
        settledCount += 1;
        return updated;
      }
      return obs;
    });

    let signalSettledCount = 0;
    this.signalRecords = this.signalRecords.map((rec) => {
      if (rec.status !== 'pending') return rec;
      const dt = parseKickoff(rec.date);
      if (!dt || nowMs - dt.getTime() < SETTLE_GRACE_MS) return rec;

      const found = findMatch(rec);
      if (!found) return rec;
      const ev = found.match;
      if (ev.state === MatchState.Cancelled || ev.state === MatchState.Postponed) {
        signalSettledCount += 1;
        return {
          ...rec,
          status: 'push',
          settled_at: new Date().toISOString(),
          result_source: found.source,
        };
      }
      if (ev.state === MatchState.Finished && typeof ev.home_score === 'number' && typeof ev.away_score === 'number') {
        signalSettledCount += 1;
        return {
          ...rec,
          status: 'settled',
          home_score: ev.home_score,
          away_score: ev.away_score,
          home_ht: ev.home_ht ?? null,
          away_ht: ev.away_ht ?? null,
          settled_at: new Date().toISOString(),
          result_source: found.source,
        };
      }
      return rec;
    });

    if (settledCount > 0) {
      this._save();
      this._backfillSignalsFromObservations();
      this._saveSignals();
    } else if (signalSettledCount > 0) {
      this._saveSignals();
    }
    return {
      checked: dueObs.length + dueSigs.length,
      settled: settledCount,
      signal_settled: signalSettledCount,
      errors,
    };
  }

  _obsByFixtureMap(enrichedObs = null, nowMs = Date.now()) {
    const list = enrichedObs || this.observations.map((o) => enrichObservationResult(o, nowMs));
    const map = new Map();
    for (const o of list) {
      if (!o || !o.fixture_key) continue;
      if (!map.has(o.fixture_key)) map.set(o.fixture_key, []);
      map.get(o.fixture_key).push(o);
    }
    return map;
  }

  signalResultsReport({
    category = 'all',
    limit = 200,
    offset = 0,
    nowMs = Date.now(),
    minN = DEFAULT_CALIBRATION_MIN_N,
  } = {}) {
    const safeLimit = Math.min(500, Math.max(1, Number.parseInt(String(limit), 10) || 200));
    const safeOffset = Math.max(0, Number.parseInt(String(offset), 10) || 0);
    const obsByFixture = this._obsByFixtureMap(null, nowMs);
    const enrichedAll = this.signalRecords.map((r) => enrichSignalRecord(r, obsByFixture, nowMs));
    const byCategory = SIGNAL_CATEGORY_META.map((cat) => summarizeCategoryRecords(enrichedAll, cat));
    const bestCategory = selectBestCategory(byCategory, minN);

    const validCats = new Set(['executable', 'movement', 'flow', 'contradiction']);
    const requestedCat = category === 'best' ? bestCategory : category;
    const selectedCategory = validCats.has(requestedCat) ? requestedCat : 'all';

    const filteredResults =
      selectedCategory === 'all'
        ? enrichedAll
        : enrichedAll
            .filter((r) => (r.signals || []).some((s) => s.category === selectedCategory))
            .map((r) => {
              const catSigs = (r.signals || []).filter((s) => s.category === selectedCategory);
              const catWon = catSigs.filter((s) => s.signal_result === 'win').length;
              const catLost = catSigs.filter((s) => s.signal_result === 'loss').length;
              const catPush = catSigs.filter((s) => s.signal_result === 'push').length;
              const catPnlList = catSigs.filter((s) => typeof s.pnl_u === 'number');
              const catStakedU = catPnlList.filter(
                (s) => s.signal_result === 'win' || s.signal_result === 'loss'
              ).length;
              const catPnl =
                catPnlList.length > 0
                  ? Number(catPnlList.reduce((acc, s) => acc + s.pnl_u, 0).toFixed(2))
                  : null;
              const catRoiPct =
                catStakedU > 0 && catPnl !== null
                  ? Number(((catPnl / catStakedU) * 100).toFixed(1))
                  : null;
              let outcome = r.match_outcome;
              if (r.status === 'settled') {
                if (catWon > 0 && catLost === 0) outcome = 'win';
                else if (catLost > 0 && catWon === 0) outcome = 'loss';
                else if (catWon > 0 && catLost > 0) outcome = 'mixed';
                else if (catPush > 0) outcome = 'push';
                else outcome = 'settled';
              }
              return {
                ...r,
                signals: catSigs,
                all_signals: r.signals,
                match_outcome: outcome,
                reco_won: catWon,
                reco_lost: catLost,
                reco_push: catPush,
                reco_staked_u: catStakedU,
                reco_roi_n: catStakedU,
                reco_pnl_u: catPnl,
                reco_roi_pct: catRoiPct,
              };
            });

    const settledMatches = enrichedAll.filter((r) => r.status === 'settled');
    const pushMatches = enrichedAll.filter((r) => r.status === 'push');
    const noScoreMatches = enrichedAll.filter((r) => r.is_no_score === true);
    const pendingMatches = enrichedAll.filter((r) => r.status === 'pending' && !r.is_no_score);
    const playedMatches = settledMatches.length + pushMatches.length + noScoreMatches.length;
    const scoredMatches = settledMatches.length + pushMatches.length;

    let totalSignals = 0;
    let settledSignals = 0;
    let recoTotal = 0;
    let recoSettled = 0;
    let recoWon = 0;
    let recoLost = 0;
    let recoPush = 0;
    let recoStakedU = 0;
    let pnlSum = 0;
    let hasPnl = false;

    for (const r of enrichedAll) {
      for (const s of r.signals || []) {
        totalSignals += 1;
        if (r.status === 'settled' || r.status === 'push') settledSignals += 1;
        if (s.category === 'executable') {
          recoTotal += 1;
          if (s.signal_result === 'win') {
            recoSettled += 1;
            recoWon += 1;
          } else if (s.signal_result === 'loss') {
            recoSettled += 1;
            recoLost += 1;
          } else if (s.signal_result === 'push') {
            recoPush += 1;
          }
          if (typeof s.pnl_u === 'number') {
            pnlSum += s.pnl_u;
            hasPnl = true;
            if (s.signal_result === 'win' || s.signal_result === 'loss') {
              recoStakedU += 1;
            }
          }
        }
      }
    }

    const recoRoiU = hasPnl ? Number(pnlSum.toFixed(2)) : null;
    const recoRoiPct =
      recoStakedU > 0 && hasPnl ? Number(((pnlSum / recoStakedU) * 100).toFixed(1)) : null;
    const recoRoiState =
      !hasPnl || recoStakedU === 0
        ? 'na'
        : pnlSum > 0
        ? 'positive'
        : pnlSum < 0
        ? 'negative'
        : 'neutral';

    const catStats =
      selectedCategory === 'all'
        ? null
        : byCategory.find((c) => c.category === selectedCategory) || null;

    return {
      category: selectedCategory,
      best_category: bestCategory,
      summary: {
        total_matches: enrichedAll.length,
        played_matches: playedMatches,
        scored_matches: scoredMatches,
        settled_matches: settledMatches.length,
        pending_matches: pendingMatches.length,
        no_score_matches: noScoreMatches.length,
        push_matches: pushMatches.length,
        total_signals: totalSignals,
        settled_signals: settledSignals,
        reco_total: recoTotal,
        reco_settled: recoSettled,
        reco_won: recoWon,
        reco_lost: recoLost,
        reco_push: recoPush,
        reco_win_rate_pct:
          recoSettled > 0 ? Number(((recoWon / recoSettled) * 100).toFixed(1)) : null,
        reco_staked_u: recoStakedU,
        reco_roi_n: recoStakedU,
        reco_roi_u: recoRoiU,
        reco_roi_pct: recoRoiPct,
        reco_roi_state: recoRoiState,
      },
      category_summary: catStats,
      by_category: byCategory,
      total_filtered: filteredResults.length,
      limit: safeLimit,
      offset: safeOffset,
      has_more: safeOffset + safeLimit < filteredResults.length,
      results: filteredResults.slice(safeOffset, safeOffset + safeLimit),
    };
  }

  report({
    category = 'all',
    limit = 200,
    offset = 0,
    nowMs = Date.now(),
    minN = DEFAULT_CALIBRATION_MIN_N,
  } = {}) {
    const safeLimit = Math.min(500, Math.max(1, Number.parseInt(String(limit), 10) || 200));
    const safeOffset = Math.max(0, Number.parseInt(String(offset), 10) || 0);
    const baseEnrichedObs = this.observations.map((o) => enrichObservationResult(o, nowMs));
    const obsByFixture = this._obsByFixtureMap(baseEnrichedObs, nowMs);
    const enrichedSignalRecs = this.signalRecords.map((r) => enrichSignalRecord(r, obsByFixture, nowMs));
    const sigRecByFixture = new Map(enrichedSignalRecs.map((r) => [r.fixture_key, r]));
    const byCategory = SIGNAL_CATEGORY_META.map((cat) =>
      summarizeCategoryRecords(enrichedSignalRecs, cat)
    );
    const bestCategory = selectBestCategory(byCategory, minN);

    const enrichedAll = baseEnrichedObs.map((o) => {
      const sigRec = sigRecByFixture.get(o.fixture_key) || null;
      const sigList = sigRec?.signals || [];
      const cats = [...new Set(sigList.map((s) => s.category).filter(Boolean))];
      if (o.recommendation && !cats.includes('executable')) cats.push('executable');
      return {
        ...o,
        in_signals: Boolean(sigRec) || Boolean(o.recommendation),
        signal_categories: cats,
        signals: sigList,
        signal_match_outcome: sigRec?.match_outcome || null,
      };
    });

    const settled = enrichedAll.filter((o) => o.status === 'settled');
    const push = enrichedAll.filter((o) => o.status === 'push');
    const noScore = enrichedAll.filter((o) => o.is_no_score === true);
    const pending = enrichedAll.filter((o) => o.status === 'pending' && !o.is_no_score);
    const played = settled.length + push.length + noScore.length;

    const avg = (arr, key) =>
      arr.length > 0
        ? Number(
            (arr.reduce((acc, item) => acc + (item[key] || 0), 0) / arr.length).toFixed(4)
          )
        : null;

    const divRows = settled.filter((o) => (o.max_abs_gap_pp || 0) >= 3.0);
    const divBfWins = divRows.filter((o) => o.gap_winner === 'betfair').length;
    const divPmWins = divRows.filter((o) => o.gap_winner === 'polymarket').length;

    const recoSettledList = settled.filter((o) => o.reco_result === 'win' || o.reco_result === 'loss');
    const recoWonList = recoSettledList.filter((o) => o.reco_result === 'win');
    const recoLostList = recoSettledList.filter((o) => o.reco_result === 'loss');
    const recoWithPnl = recoSettledList.filter((o) => typeof o.reco_pnl_u === 'number');
    const recoRoiU =
      recoWithPnl.length > 0
        ? Number(recoWithPnl.reduce((acc, o) => acc + o.reco_pnl_u, 0).toFixed(2))
        : null;
    const recoStakedU = recoWithPnl.length;
    const recoRoiPct =
      recoStakedU > 0 && recoRoiU !== null
        ? Number(((recoRoiU / recoStakedU) * 100).toFixed(1))
        : null;
    const recoRoiState =
      recoRoiU === null || recoStakedU === 0
        ? 'na'
        : recoRoiU > 0
        ? 'positive'
        : recoRoiU < 0
        ? 'negative'
        : 'neutral';

    const favSettledList = settled.filter((o) => typeof o.bf_top_won === 'boolean');
    const bfFavWon = favSettledList.filter((o) => o.bf_top_won === true).length;
    const pmFavWon = favSettledList.filter((o) => o.pm_top_won === true).length;

    const byMarketMap = new Map();
    for (const o of settled) {
      if (!byMarketMap.has(o.market)) byMarketMap.set(o.market, []);
      byMarketMap.get(o.market).push(o);
    }

    const byMarket = [...byMarketMap.entries()].map(([market, list]) => {
      const mFav = list.filter((o) => typeof o.bf_top_won === 'boolean');
      const mBfWon = mFav.filter((o) => o.bf_top_won === true).length;
      const mPmWon = mFav.filter((o) => o.pm_top_won === true).length;
      const mReco = list.filter((o) => o.reco_result === 'win' || o.reco_result === 'loss');
      const mRecoWon = mReco.filter((o) => o.reco_result === 'win').length;
      return {
        market,
        short: list[0]?.market_short || market,
        label: list[0]?.market_label || list[0]?.market_short || market,
        count: list.length,
        brier_bf: avg(list, 'brier_bf'),
        brier_pm: avg(list, 'brier_pm'),
        logloss_bf: avg(list, 'logloss_bf'),
        logloss_pm: avg(list, 'logloss_pm'),
        bf_fav_hit_pct: mFav.length > 0 ? Number(((mBfWon / mFav.length) * 100).toFixed(1)) : null,
        pm_fav_hit_pct: mFav.length > 0 ? Number(((mPmWon / mFav.length) * 100).toFixed(1)) : null,
        reco_settled: mReco.length,
        reco_won: mRecoWon,
      };
    });

    const byConfidence = ['high', 'moderate', 'low'].map((tier) => {
      const list = settled.filter((o) => o.recommendation?.tier === tier);
      const rSettled = list.filter((o) => o.reco_result === 'win' || o.reco_result === 'loss');
      const rWon = rSettled.filter((o) => o.reco_result === 'win').length;
      return {
        tier,
        count: list.length,
        brier_bf: avg(list, 'brier_bf'),
        brier_pm: avg(list, 'brier_pm'),
        bf_wins: list.filter((o) => o.gap_winner === 'betfair').length,
        pm_wins: list.filter((o) => o.gap_winner === 'polymarket').length,
        reco_settled: rSettled.length,
        reco_won: rWon,
        reco_win_rate_pct: rSettled.length > 0 ? Number(((rWon / rSettled.length) * 100).toFixed(1)) : null,
      };
    });

    const uniqueStageByFixture = new Map();
    for (const o of enrichedAll) {
      const prev = uniqueStageByFixture.get(o.fixture_key);
      if (!prev || o.status === 'settled' || (o.status === 'push' && prev === 'pending') || (o.is_no_score && prev === 'pending')) {
        uniqueStageByFixture.set(o.fixture_key, o.status === 'settled' ? 'settled' : o.status === 'push' ? 'push' : o.is_no_score ? 'no_score' : 'pending');
      }
    }
    const fixtureStages = [...uniqueStageByFixture.values()];
    const totalMatches = fixtureStages.length;
    const settledMatchesCount = fixtureStages.filter((s) => s === 'settled').length;
    const pushMatchesCount = fixtureStages.filter((s) => s === 'push').length;
    const noScoreMatchesCount = fixtureStages.filter((s) => s === 'no_score').length;
    const pendingMatchesCount = fixtureStages.filter((s) => s === 'pending').length;
    const playedMatchesCount = settledMatchesCount + pushMatchesCount + noScoreMatchesCount;

    const settledFixtures = new Set(settled.map((o) => o.fixture_key)).size;
    const signalMatchesCount = new Set(
      enrichedAll.filter((o) => o.in_signals).map((o) => o.fixture_key)
    ).size;

    const validCats = new Set(['signals', 'executable', 'movement', 'flow', 'contradiction', 'baseline']);
    const requestedCat = category === 'best' ? bestCategory : category;
    const selectedCategory = validCats.has(requestedCat) ? requestedCat : 'all';
    const filteredObs =
      selectedCategory === 'all'
        ? enrichedAll
        : selectedCategory === 'signals'
        ? enrichedAll.filter((o) => o.in_signals)
        : selectedCategory === 'baseline'
        ? enrichedAll.filter((o) => !o.in_signals)
        : enrichedAll.filter((o) => (o.signal_categories || []).includes(selectedCategory));

    const categoryStats =
      ['executable', 'movement', 'flow', 'contradiction'].includes(selectedCategory)
        ? byCategory.find((c) => c.category === selectedCategory) || null
        : null;

    return {
      category: selectedCategory,
      best_category: bestCategory,
      summary: {
        total_observations: enrichedAll.length,
        played,
        pending: pending.length,
        no_score: noScore.length,
        settled: settled.length,
        settled_fixtures: settledFixtures,
        total_matches: totalMatches,
        played_matches: playedMatchesCount,
        settled_matches: settledMatchesCount,
        push_matches: pushMatchesCount,
        no_score_matches: noScoreMatchesCount,
        pending_matches: pendingMatchesCount,
        signal_observations: enrichedAll.filter((o) => o.in_signals).length,
        signal_matches: signalMatchesCount,
        push: push.length,
        brier_bf: avg(settled, 'brier_bf'),
        brier_pm: avg(settled, 'brier_pm'),
        logloss_bf: avg(settled, 'logloss_bf'),
        logloss_pm: avg(settled, 'logloss_pm'),
        divergence_count: divRows.length,
        divergence_bf_wins: divBfWins,
        divergence_pm_wins: divPmWins,
        reco_total: enrichedAll.filter((o) => Boolean(o.recommendation)).length,
        reco_settled: recoSettledList.length,
        reco_won: recoWonList.length,
        reco_lost: recoLostList.length,
        reco_win_rate_pct:
          recoSettledList.length > 0
            ? Number(((recoWonList.length / recoSettledList.length) * 100).toFixed(1))
            : null,
        reco_staked_u: recoStakedU,
        reco_roi_n: recoStakedU,
        reco_roi_u: recoRoiU,
        reco_roi_pct: recoRoiPct,
        reco_roi_state: recoRoiState,
        fav_settled: favSettledList.length,
        bf_fav_won: bfFavWon,
        pm_fav_won: pmFavWon,
        bf_fav_hit_pct:
          favSettledList.length > 0 ? Number(((bfFavWon / favSettledList.length) * 100).toFixed(1)) : null,
        pm_fav_hit_pct:
          favSettledList.length > 0 ? Number(((pmFavWon / favSettledList.length) * 100).toFixed(1)) : null,
      },
      category_summary: categoryStats,
      by_category: byCategory,
      by_market: byMarket,
      by_confidence: byConfidence,
      total_filtered: filteredObs.length,
      limit: safeLimit,
      offset: safeOffset,
      has_more: safeOffset + safeLimit < filteredObs.length,
      observations: filteredObs.slice(safeOffset, safeOffset + safeLimit),
    };
  }
}
