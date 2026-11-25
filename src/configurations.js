// Moteur de configurations multi-marchés : 72 signatures directionnelles, 4 axes (Orientation, Intensité,
// Variation ouverture→actuel, Concordance/Divergence) et détection de signaux sur données live Arbworld × Polymarket.

import { mapWithConcurrency } from './async.js';
import { compareFixture } from './compare.js';
import { enrich, fixtureKey, parseKickoff, round1, round2 } from './enrich.js';
import { ALL_MARKETS, MarketKey, MarketShape, marketDef } from './market.js';
import {
  DEFAULT_PROPOSAL_PRESET,
  evaluateFixtureRecommendations,
  PROPOSAL_PRESETS,
  resolveProposalThresholds,
  STRICT_THRESHOLDS,
} from './recommend.js';

export const ONE_X_TWO_STATES = Object.freeze(['1', 'X', '2']);
export const BTTS_STATES = Object.freeze(['Oui', 'Non']);
export const HALF_TIME_STATES = Object.freeze(['1', 'X', '2']);
export const GOALS_PROFILES = Object.freeze([
  { code: 'G1', label: 'G1 · Très faible (U1.5 / U2.5 / U3.5)' },
  { code: 'G2', label: 'G2 · Modéré faible (O1.5 / U2.5 / U3.5)' },
  { code: 'G3', label: 'G3 · Ouvert actif (O1.5 / O2.5 / U3.5)' },
  { code: 'G4', label: 'G4 · Très offensif (O1.5 / O2.5 / O3.5)' },
]);

// Qualité des lignes O/U : un profil « Atypique » viole P(O3.5) ≤ P(O2.5) ≤ P(O1.5).
// Il est classé donnees_incoherentes, jamais compté comme contradiction ni comme signature 72.
// Les champs `profile`/`status` historiques sont conservés pour les routes /api/* dépréciées.
export const GOALS_QUALITY = Object.freeze({
  Ok: 'donnees_valides',
  Incomplet: 'incomplet',
  Incoherent: 'donnees_incoherentes',
});

export const IntensityLevel = Object.freeze({
  Equilibre: 'equilibre',
  Faible: 'faible',
  Moderee: 'moderee',
  Forte: 'forte',
  Extreme: 'extreme',
});

export const INTENSITY_LABELS = Object.freeze({
  equilibre: 'Équilibre',
  faible: 'Faible',
  moderee: 'Modérée',
  forte: 'Forte',
  extreme: 'Extrême',
});

export const VariationClass = Object.freeze({
  Stable: 'stable',
  BaisseFaible: 'baisse_faible',
  BaisseForte: 'baisse_forte',
  HausseFaible: 'hausse_faible',
  HausseForte: 'hausse_forte',
  Retournement: 'retournement',
});

export const VARIATION_LABELS = Object.freeze({
  stable: 'Stable',
  baisse_faible: 'Baisse faible',
  baisse_forte: 'Baisse forte',
  hausse_faible: 'Hausse faible',
  hausse_forte: 'Hausse forte',
  retournement: 'Retournement',
});

// Toutes les constantes métier du moteur (brief §2.3). Aucune valeur en dur dans les fonctions.
export const DEFAULT_CONFIG_THRESHOLDS = Object.freeze({
  // Axes
  equilibreMaxPp: 4.0,
  faibleMaxPp: 12.0,
  modereeMaxPp: 24.0,
  forteMaxPp: 40.0,
  stableMaxPct: 1.5,
  strongMovePct: 5.0,
  reversalDropPct: 3.0,
  pmMoveMinPts: 3.0,
  pmSplitMinGapPp: 3.0,
  // Concordance (anciens seuils 58 / 60 / 62 / 54)
  lowGoalsFavMinPct: 58.0,
  highGoalsFavMinPct: 60.0,
  heavyFavoriteMinPct: 62.0,
  bttsNoFavMinPct: 54.0,
  // Variation : deltas de probabilité (2.0 / 5.0) et split (10.0)
  favFlipMinProbDeltaPp: 2.0,
  splitMinProbDeltaPp: 5.0,
  splitMinDropPct: 10.0,
  strongMoveMinProbDeltaPp: 2.0,
  // Signaux mouvement : volume Betfair 500 € et delta prob. 2.0 pt
  movementMinVolumeEur: 500,
  movementMinProbDeltaPp: 2.0,
  // Recherche Polymarket : fenêtre 72 h / 2 h passées, 28 candidats par défaut, 40 max
  pmSearchFutureHours: 72,
  pmSearchPastHours: 2,
  pmLookupDefault: 28,
  pmLookupMax: 40,
  // Niveau « Limité » (brief §4) — sourcing unique depuis recommend.js
  minPmLiquidityForNiveauUsd: STRICT_THRESHOLDS.minPmLiquidityForNiveauUsd,
});

export const SIGNAL_PRESETS = PROPOSAL_PRESETS;

export const ALL_72_SIGNATURES = (() => {
  const list = [];
  for (const ft of ONE_X_TWO_STATES) {
    for (const btts of BTTS_STATES) {
      for (const ht of HALF_TIME_STATES) {
        for (const gp of GOALS_PROFILES) {
          list.push({
            code: `${ft} | ${btts} | ${ht} | ${gp.code}`,
            ft,
            btts,
            ht,
            goals_profile: gp.code,
          });
        }
      }
    }
  }
  return Object.freeze(list);
})();

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function resolveConfigThresholds(overrides = null) {
  if (!overrides || typeof overrides !== 'object') {
    return { ...DEFAULT_CONFIG_THRESHOLDS };
  }
  const clean = { ...DEFAULT_CONFIG_THRESHOLDS };
  for (const key of Object.keys(DEFAULT_CONFIG_THRESHOLDS)) {
    const val = Number(overrides[key]);
    if (Number.isFinite(val) && val > 0) {
      clean[key] = val;
    }
  }
  return clean;
}

function classifyIntensity(marginPp, thresholds) {
  if (marginPp === null || !Number.isFinite(marginPp)) {
    return { level: null, label: 'Indisponible' };
  }
  if (marginPp < thresholds.equilibreMaxPp) {
    return { level: IntensityLevel.Equilibre, label: INTENSITY_LABELS.equilibre };
  }
  if (marginPp < thresholds.faibleMaxPp) {
    return { level: IntensityLevel.Faible, label: INTENSITY_LABELS.faible };
  }
  if (marginPp < thresholds.modereeMaxPp) {
    return { level: IntensityLevel.Moderee, label: INTENSITY_LABELS.moderee };
  }
  if (marginPp < thresholds.forteMaxPp) {
    return { level: IntensityLevel.Forte, label: INTENSITY_LABELS.forte };
  }
  return { level: IntensityLevel.Extreme, label: INTENSITY_LABELS.extreme };
}

function computeNormalizedFromOdds(oddsArr) {
  const raw = oddsArr.map((c) => (c > 0 ? 100.0 / c : 0.0));
  const sum = raw.reduce((a, b) => a + b, 0.0);
  if (sum <= 0) return null;
  return {
    raw: raw.map((v) => round1(v)),
    normalized: raw.map((v) => round1((v / sum) * 100.0)),
    overround_pct: round1(sum - 100.0),
  };
}

function extractBfStructuredSides(marketKey, bfRow) {
  if (!bfRow) return null;
  let slots = [];
  if (marketKey === MarketKey.OneXTwo || marketKey === MarketKey.HalfTime) {
    slots = [
      { label: '1', idx: 0 },
      { label: 'X', idx: 1 },
      { label: '2', idx: 2 },
    ];
  } else if (marketKey === MarketKey.DoubleChance) {
    slots = [
      { label: '1X', idx: 0 },
      { label: 'X2', idx: 1 },
      { label: '12', idx: 2 },
    ];
  } else if (marketKey === MarketKey.DrawNoBet) {
    slots = [
      { label: '1', idx: 0 },
      { label: '2', idx: 2 },
    ];
  } else if (
    marketKey === MarketKey.OverUnder15 ||
    marketKey === MarketKey.OverUnder25 ||
    marketKey === MarketKey.OverUnder35
  ) {
    slots = [
      { label: 'Under', idx: 0 },
      { label: 'Over', idx: 2 },
    ];
  } else if (marketKey === MarketKey.Btts) {
    slots = [
      { label: 'Oui', idx: 0 },
      { label: 'Non', idx: 2 },
    ];
  } else {
    return null;
  }

  const openOdds = slots.map((s) => numOrNull(bfRow.coef?.[s.idx]) || 0);
  const currOdds = slots.map((s) => numOrNull(bfRow.coef_new?.[s.idx]) || 0);
  const openNorm = computeNormalizedFromOdds(openOdds);
  const currNorm = computeNormalizedFromOdds(currOdds);

  const sides = slots.map((s, pos) => {
    const impliedPct = numOrNull(bfRow.implied?.[s.idx]) ?? currNorm?.normalized[pos] ?? null;
    const rawPct = currNorm?.raw[pos] ?? (currOdds[pos] > 0 ? round1(100.0 / currOdds[pos]) : null);
    const openImpliedPct = openNorm?.normalized[pos] ?? null;
    const probDeltaPp =
      impliedPct !== null && openImpliedPct !== null ? round1(impliedPct - openImpliedPct) : null;
    const dropPct = numOrNull(bfRow.drop?.[s.idx]);
    return {
      label: s.label,
      odds_open: openOdds[pos] > 0 ? openOdds[pos] : null,
      odds: currOdds[pos] > 0 ? currOdds[pos] : null,
      raw_prob_pct: rawPct,
      norm_prob_pct: impliedPct,
      open_norm_prob_pct: openImpliedPct,
      prob_delta_pp: probDeltaPp,
      drop_pct: dropPct,
      volume: numOrNull(bfRow.volume?.[s.idx]),
      share_pct: numOrNull(bfRow.share?.[s.idx]),
    };
  });

  return {
    overround_pct: currNorm?.overround_pct ?? null,
    overround_method: 'multiplicative_proportional',
    sides,
  };
}

function extractPmSidesMap(marketKey, pmMarket) {
  if (!pmMarket || !Array.isArray(pmMarket.outcomes) || pmMarket.outcomes.length === 0) {
    return null;
  }
  const map = new Map();
  for (const o of pmMarket.outcomes) {
    const normLabel =
      (marketKey === MarketKey.OneXTwo || marketKey === MarketKey.HalfTime) && o.label === 'N'
        ? 'X'
        : String(o.label || '');
    const pct = numOrNull(o.novig_pct) ?? (numOrNull(o.price) !== null ? round1(o.price * 100.0) : null);
    if (pct === null) continue;
    map.set(normLabel, {
      label: normLabel,
      norm_prob_pct: pct,
      raw_prob_pct: numOrNull(o.price) !== null ? round1(o.price * 100.0) : null,
      bid: numOrNull(o.bid),
      ask: numOrNull(o.ask),
      spread_pts:
        numOrNull(o.spread) !== null
          ? round1(o.spread * 100.0)
          : numOrNull(o.bid) !== null && numOrNull(o.ask) !== null
          ? round1((o.ask - o.bid) * 100.0)
          : null,
      change_1d_pts: numOrNull(o.change_1d) !== null ? round1(o.change_1d * 100.0) : null,
      liquidity: numOrNull(o.liquidity),
    });
  }
  return map.size > 0 ? map : null;
}

function summarizeMarketAxis(marketKey, bfRow, pmMarket, thresholds) {
  const def = marketDef(marketKey);
  if (def.shape === MarketShape.Multi) {
    const bfOuts = Array.isArray(bfRow?.outcomes) ? bfRow.outcomes : [];
    const pmOuts = Array.isArray(pmMarket?.outcomes)
      ? pmMarket.outcomes.filter((o) => numOrNull(o.novig_pct) !== null)
      : [];
    const topBf = bfOuts[0] || null;
    const topPm = [...pmOuts].sort((a, b) => (b.novig_pct ?? 0) - (a.novig_pct ?? 0))[0] || null;
    const topBfProb = topBf?.coef_new ? round1(100.0 / topBf.coef_new) : null;
    return {
      market: marketKey,
      short: def.short,
      label: def.label,
      shape: def.shape,
      source_bf: Boolean(bfRow),
      source_pm: pmOuts.length > 0,
      volume_bf: bfRow?.total_volume ?? 0,
      liquidity_pm: numOrNull(pmMarket?.liquidity),
      overround_pct: null,
      favorite: topBf?.label || topPm?.label || null,
      favorite_pct: topBfProb ?? numOrNull(topPm?.novig_pct),
      runner_up: bfOuts[1]?.label || null,
      runner_up_pct: bfOuts[1]?.coef_new ? round1(100.0 / bfOuts[1].coef_new) : null,
      margin_pp: null,
      intensity: null,
      intensity_label: 'Multi-issues',
      variation_class: VariationClass.Stable,
      variation_label: 'Multi-issues',
      variation_amplitude_pct: 0,
      variation_prob_delta_pp: null,
      variation_side: null,
      pm_favorite: topPm?.label || null,
      pm_favorite_pct: numOrNull(topPm?.novig_pct),
      pm_change_1d_pts: null,
      bf_pm_disagree:
        Boolean(pmMarket?.usable) &&
        Boolean(
          topBf &&
            topPm &&
            topBf.label.replace(/\s+/g, '') !== String(topPm.label || '').replace(/\s+/g, '')
        ),
      sides: [],
    };
  }

  const bfStruct = extractBfStructuredSides(marketKey, bfRow);
  const pmMap = extractPmSidesMap(marketKey, pmMarket);
  if (!bfStruct && !pmMap) return null;

  const sides = bfStruct ? bfStruct.sides : [...pmMap.values()];
  const rankedCurr = [...sides]
    .filter((s) => s.norm_prob_pct !== null)
    .sort((a, b) => b.norm_prob_pct - a.norm_prob_pct);
  const top = rankedCurr[0] || null;
  const second = rankedCurr[1] || null;
  const marginPp =
    top && second ? round1(top.norm_prob_pct - second.norm_prob_pct) : null;
  const intensity = classifyIntensity(marginPp, thresholds);

  // Variation Betfair ouverture -> actuel (uniquement si les cotes d'ouverture existent)
  let variationClass = VariationClass.Stable;
  let variationLabel = VARIATION_LABELS.stable;
  let maxAbsDrop = 0;
  let movedSide = null;
  let maxProbDeltaPp = null;
  let maxOddsAmplitude = null;

  if (bfStruct) {
    const rankedOpen = [...bfStruct.sides]
      .filter((s) => s.open_norm_prob_pct !== null)
      .sort((a, b) => b.open_norm_prob_pct - a.open_norm_prob_pct);
    const openFav = rankedOpen[0]?.label || null;
    const currFav = top?.label || null;

    let strongestDrop = 0;
    let strongestRise = 0;
    let maxAbsProbDelta = 0;
    for (const s of bfStruct.sides) {
      if (s.prob_delta_pp !== null && Math.abs(s.prob_delta_pp) > maxAbsProbDelta) {
        maxAbsProbDelta = Math.abs(s.prob_delta_pp);
      }
      if (s.drop_pct === null) continue;
      if (Math.abs(s.drop_pct) > maxAbsDrop) {
        maxAbsDrop = Math.abs(s.drop_pct);
        movedSide = s;
      }
      if (s.drop_pct < strongestDrop) strongestDrop = s.drop_pct;
      if (s.drop_pct > strongestRise) strongestRise = s.drop_pct;
    }

    if (movedSide && movedSide.odds && movedSide.odds_open) {
      maxOddsAmplitude = round2(Math.abs(movedSide.odds - movedSide.odds_open));
      maxProbDeltaPp = movedSide.prob_delta_pp;
    }

    const movedSideAbsProb =
      movedSide && movedSide.prob_delta_pp !== null
        ? Math.abs(movedSide.prob_delta_pp)
        : maxAbsProbDelta;

    const favFlipped =
      openFav &&
      currFav &&
      openFav !== currFav &&
      maxAbsDrop >= thresholds.stableMaxPct &&
      maxAbsProbDelta >= thresholds.favFlipMinProbDeltaPp;
    const minSplitDropPct = Math.max(
      thresholds.reversalDropPct * 3.0,
      thresholds.splitMinDropPct
    );
    const splitReversal =
      strongestDrop <= -minSplitDropPct &&
      strongestRise >= minSplitDropPct &&
      maxAbsProbDelta >= thresholds.splitMinProbDeltaPp;

    if (favFlipped || splitReversal) {
      variationClass = VariationClass.Retournement;
      variationLabel = VARIATION_LABELS.retournement;
    } else if (movedSide && movedSide.drop_pct !== null && maxAbsDrop >= thresholds.stableMaxPct) {
      const d = movedSide.drop_pct;
      if (d <= -thresholds.strongMovePct && movedSideAbsProb >= thresholds.strongMoveMinProbDeltaPp) {
        variationClass = VariationClass.BaisseForte;
        variationLabel = VARIATION_LABELS.baisse_forte;
      } else if (d < 0) {
        variationClass = VariationClass.BaisseFaible;
        variationLabel = VARIATION_LABELS.baisse_faible;
      } else if (d >= thresholds.strongMovePct && movedSideAbsProb >= thresholds.strongMoveMinProbDeltaPp) {
        variationClass = VariationClass.HausseForte;
        variationLabel = VARIATION_LABELS.hausse_forte;
      } else {
        variationClass = VariationClass.HausseFaible;
        variationLabel = VARIATION_LABELS.hausse_faible;
      }
    }
  }

  let pmFav = null;
  let pmFavPct = null;
  let pmMarginPp = null;
  let pmChangeMaxPts = null;
  if (pmMap) {
    const pmRanked = [...pmMap.values()].sort((a, b) => b.norm_prob_pct - a.norm_prob_pct);
    pmFav = pmRanked[0]?.label || null;
    pmFavPct = pmRanked[0]?.norm_prob_pct ?? null;
    pmMarginPp =
      pmRanked[0] && pmRanked[1]
        ? round1(pmRanked[0].norm_prob_pct - pmRanked[1].norm_prob_pct)
        : null;
    for (const s of pmMap.values()) {
      if (
        s.change_1d_pts !== null &&
        (pmChangeMaxPts === null || Math.abs(s.change_1d_pts) > Math.abs(pmChangeMaxPts))
      ) {
        pmChangeMaxPts = s.change_1d_pts;
      }
    }
  }

  // Désaccord directionnel Betfair × Polymarket si favoris différents avec marge réelle
  const bfPmDisagree =
    Boolean(bfStruct && pmMap && top && pmFav && top.label !== pmFav) &&
    (marginPp ?? 0) >= thresholds.pmSplitMinGapPp &&
    (pmMarginPp ?? 0) >= thresholds.pmSplitMinGapPp;

  return {
    market: marketKey,
    short: def.short,
    label: def.label,
    shape: def.shape,
    source_bf: Boolean(bfStruct),
    source_pm: Boolean(pmMap),
    volume_bf: bfRow?.total_volume ?? 0,
    liquidity_pm: numOrNull(pmMarket?.liquidity),
    pm_spread_pts: numOrNull(pmMarket?.spread) !== null ? round1(pmMarket.spread * 100.0) : null,
    pm_usable: Boolean(pmMarket?.usable),
    overround_pct: bfStruct?.overround_pct ?? null,
    overround_method: bfStruct?.overround_method ?? (pmMap ? 'polymarket_novig' : null),
    favorite: top?.label || null,
    favorite_pct: top?.norm_prob_pct ?? null,
    runner_up: second?.label || null,
    runner_up_pct: second?.norm_prob_pct ?? null,
    margin_pp: marginPp,
    intensity: intensity.level,
    intensity_label: intensity.label,
    variation_class: variationClass,
    variation_label: variationLabel,
    variation_amplitude_pct: round1(maxAbsDrop),
    variation_odds_amplitude: maxOddsAmplitude,
    variation_prob_delta_pp: maxProbDeltaPp,
    variation_side: movedSide?.label || null,
    variation_drop_pct: movedSide?.drop_pct ?? null,
    pm_favorite: pmFav,
    pm_favorite_pct: pmFavPct,
    pm_margin_pp: pmMarginPp,
    pm_change_1d_pts: pmChangeMaxPts,
    bf_pm_disagree: bfPmDisagree,
    sides: sides.map((s) => ({
      ...s,
      pm_norm_prob_pct: pmMap?.get(s.label)?.norm_prob_pct ?? null,
      pm_bid: pmMap?.get(s.label)?.bid ?? null,
      pm_ask: pmMap?.get(s.label)?.ask ?? null,
      pm_change_1d_pts: pmMap?.get(s.label)?.change_1d_pts ?? null,
    })),
  };
}

export function deriveGoalsProfile(ou15Snap, ou25Snap, ou35Snap, usePm = false) {
  const getFav = (snap) => {
    if (!snap) return null;
    if (usePm) return snap.pm_favorite || null;
    return snap.source_bf ? snap.favorite : null;
  };
  const f15 = getFav(ou15Snap);
  const f25 = getFav(ou25Snap);
  const f35 = getFav(ou35Snap);
  const presentCount = [f15, f25, f35].filter(Boolean).length;

  if (presentCount < 3) {
    return {
      profile: null,
      status: presentCount === 0 ? 'indisponible' : 'incomplet',
      quality_status: GOALS_QUALITY.Incomplet,
      lines_present: presentCount,
      lines: { ou15: f15, ou25: f25, ou35: f35 },
    };
  }

  if (f15 === 'Under' && f25 === 'Under' && f35 === 'Under') {
    return { profile: 'G1', status: 'complet', quality_status: GOALS_QUALITY.Ok, lines_present: 3, lines: { ou15: f15, ou25: f25, ou35: f35 } };
  }
  if (f15 === 'Over' && f25 === 'Under' && f35 === 'Under') {
    return { profile: 'G2', status: 'complet', quality_status: GOALS_QUALITY.Ok, lines_present: 3, lines: { ou15: f15, ou25: f25, ou35: f35 } };
  }
  if (f15 === 'Over' && f25 === 'Over' && f35 === 'Under') {
    return { profile: 'G3', status: 'complet', quality_status: GOALS_QUALITY.Ok, lines_present: 3, lines: { ou15: f15, ou25: f25, ou35: f35 } };
  }
  if (f15 === 'Over' && f25 === 'Over' && f35 === 'Over') {
    return { profile: 'G4', status: 'complet', quality_status: GOALS_QUALITY.Ok, lines_present: 3, lines: { ou15: f15, ou25: f25, ou35: f35 } };
  }
  return {
    profile: 'Atypique', // alias v1 déprécié
    status: 'atypique', // alias v1 déprécié
    quality_status: GOALS_QUALITY.Incoherent,
    lines_present: 3,
    lines: { ou15: f15, ou25: f25, ou35: f35 },
  };
}

export function isIncoherentGoalsProfile(goals) {
  return goals?.quality_status === GOALS_QUALITY.Incoherent || goals?.status === 'atypique';
}

function analyzeConcordance(marketSnaps, bfGoals, pmGoals, thresholds = DEFAULT_CONFIG_THRESHOLDS) {
  const items = [];
  let convergences = 0;
  let neutrals = 0;
  let contradictions = 0;
  let unavailable = 0;
  let incoherent = 0;

  // 2.2 Un même désaccord Betfair × Polymarket est une seule cause, peu importe le
  // nombre de marchés (1X2, BTTS, chaque O/U, profil de buts) où il se manifeste.
  const bfPmCauses = [];

  const snap = (k) => marketSnaps[k] || null;
  const s1x2 = snap(MarketKey.OneXTwo);
  const sBtts = snap(MarketKey.Btts);
  const sHt = snap(MarketKey.HalfTime);
  const sOu25 = snap(MarketKey.OverUnder25);
  const sDnb = snap(MarketKey.DrawNoBet);

  // 1. 1X2 FT vs Mi-temps
  if (s1x2?.favorite && sHt?.favorite) {
    if (
      (s1x2.favorite === '1' && sHt.favorite === '2') ||
      (s1x2.favorite === '2' && sHt.favorite === '1')
    ) {
      contradictions += 1;
      items.push({
        status: 'contradiction',
        cause: 'orientation_ft_ht',
        markets: ['1x2', 'half-time'],
        pair: '1X2 FT vs Mi-temps',
        detail: `1X2 FT favorise ${s1x2.favorite} (${s1x2.favorite_pct?.toFixed(1) ?? '—'} %) tandis que Mi-temps favorise ${sHt.favorite} (${sHt.favorite_pct?.toFixed(1) ?? '—'} %).`,
      });
    } else if (s1x2.favorite === sHt.favorite) {
      convergences += 1;
      items.push({
        status: 'convergence',
        pair: '1X2 FT vs Mi-temps',
        detail: `Convergence sur ${s1x2.favorite} en FT (${s1x2.favorite_pct?.toFixed(1) ?? '—'} %) et Mi-temps (${sHt.favorite_pct?.toFixed(1) ?? '—'} %).`,
      });
    } else {
      neutrals += 1;
      items.push({
        status: 'neutre',
        pair: '1X2 FT vs Mi-temps',
        detail: `FT favorise ${s1x2.favorite} avec mi-temps ${sHt.favorite}.`,
      });
    }
  } else {
    unavailable += 1;
  }

  // 2. BTTS vs Profil de buts (G1..G4 ou O/U 2.5)
  // Un profil incohérent n'est pas une contradiction : c'est une donnée à écarter (2.1).
  if (sBtts?.favorite && (bfGoals.profile || sOu25?.favorite) && !isIncoherentGoalsProfile(bfGoals)) {
    const isLowGoals =
      bfGoals.profile === 'G1' ||
      (sOu25?.favorite === 'Under' && (sOu25?.favorite_pct ?? 0) >= thresholds.lowGoalsFavMinPct);
    const isHighGoals =
      bfGoals.profile === 'G4' ||
      (sOu25?.favorite === 'Over' && (sOu25?.favorite_pct ?? 0) >= thresholds.highGoalsFavMinPct);
    const hasHeavySideFav = Boolean(
      s1x2?.favorite &&
        s1x2.favorite !== 'X' &&
        (s1x2.favorite_pct ?? 0) >= thresholds.heavyFavoriteMinPct
    );
    if (isLowGoals && sBtts.favorite === 'Oui') {
      contradictions += 1;
      items.push({
        status: 'contradiction',
        cause: 'btts_profil_buts',
        markets: ['btts', 'profil_buts'],
        pair: 'BTTS vs Profil buts',
        detail: `BTTS Oui favorisé (${sBtts.favorite_pct?.toFixed(1) ?? '—'} %) malgré un profil faible en buts (${bfGoals.profile || 'Under 2.5'}).`,
      });
    } else if (
      !hasHeavySideFav &&
      isHighGoals &&
      sBtts.favorite === 'Non' &&
      (sBtts.favorite_pct ?? 0) >= thresholds.bttsNoFavMinPct
    ) {
      contradictions += 1;
      items.push({
        status: 'contradiction',
        cause: 'btts_profil_buts',
        markets: ['btts', 'profil_buts'],
        pair: 'BTTS vs Profil buts',
        detail: `BTTS Non favorisé (${sBtts.favorite_pct?.toFixed(1) ?? '—'} %) malgré un profil offensif (${bfGoals.profile || 'Over 2.5'}).`,
      });
    } else if (
      ((bfGoals.profile === 'G3' || bfGoals.profile === 'G4') && sBtts.favorite === 'Oui') ||
      (bfGoals.profile === 'G1' && sBtts.favorite === 'Non')
    ) {
      convergences += 1;
      items.push({
        status: 'convergence',
        pair: 'BTTS vs Profil buts',
        detail: `Alignement BTTS ${sBtts.favorite} avec profil ${bfGoals.profile}.`,
      });
    } else {
      neutrals += 1;
    }
  } else {
    unavailable += 1;
  }

  // 3. Cohérence des lignes O/U 1.5 / 2.5 / 3.5
  // Incohérent = qualité de données, PAS une contradiction et PAS une signature 72.
  if (isIncoherentGoalsProfile(bfGoals)) {
    incoherent += 1;
    items.push({
      status: GOALS_QUALITY.Incoherent,
      cause: 'donnees_incoherentes',
      pair: 'Lignes O/U 1.5 / 2.5 / 3.5',
      detail: `Profil de buts incohérent (données non exploitables) : O/U 1.5=${bfGoals.lines.ou15}, 2.5=${bfGoals.lines.ou25}, 3.5=${bfGoals.lines.ou35}.`,
    });
  } else if (bfGoals.status === 'complet') {
    convergences += 1;
    items.push({
      status: 'convergence',
      pair: 'Lignes O/U 1.5 / 2.5 / 3.5',
      detail: `Lignes monotones cohérentes (${bfGoals.profile}).`,
    });
  } else {
    unavailable += 1;
  }

  // 4. 1X2 vs DNB / Nul vs G4
  if (s1x2?.favorite && sDnb?.favorite) {
    if (
      (s1x2.favorite === '1' && sDnb.favorite === '2') ||
      (s1x2.favorite === '2' && sDnb.favorite === '1')
    ) {
      contradictions += 1;
      items.push({
        status: 'contradiction',
        cause: 'orientation_1x2_dnb',
        markets: ['1x2', 'dnb'],
        pair: '1X2 vs DNB',
        detail: `1X2 favorise ${s1x2.favorite} mais DNB favorise ${sDnb.favorite}.`,
      });
    } else if (s1x2.favorite === sDnb.favorite) {
      convergences += 1;
    }
  } else {
    unavailable += 1;
  }

  if (s1x2?.favorite === 'X' && bfGoals.profile === 'G4') {
    contradictions += 1;
    items.push({
      status: 'contradiction',
      cause: 'nul_profil_g4',
      markets: ['1x2', 'profil_buts'],
      pair: '1X2 Nul vs G4',
      detail: 'Match nul favorisé en 1X2 avec profil très offensif G4 (Over 3.5 favorisé).',
    });
  }

  // 5. Betfair × Polymarket (orientation et profil buts)
  for (const mKey of [
    MarketKey.OneXTwo,
    MarketKey.Btts,
    MarketKey.OverUnder15,
    MarketKey.OverUnder25,
    MarketKey.OverUnder35,
    MarketKey.HalfTime,
  ]) {
    const m = snap(mKey);
    if (!m || !m.source_bf || !m.source_pm) continue;
    if (m.bf_pm_disagree) {
      bfPmCauses.push({
        market: mKey,
        short: m.short,
        detail: `Betfair favorise ${m.favorite} (${m.favorite_pct?.toFixed(1)} %) vs Polymarket ${m.pm_favorite} (${m.pm_favorite_pct?.toFixed(1)} %).`,
      });
    } else if (m.favorite && m.pm_favorite && m.favorite === m.pm_favorite) {
      convergences += 1;
    }
  }

  if (
    bfGoals.profile &&
    pmGoals.profile &&
    !isIncoherentGoalsProfile(bfGoals) &&
    !isIncoherentGoalsProfile(pmGoals)
  ) {
    if (bfGoals.profile !== pmGoals.profile) {
      bfPmCauses.push({
        market: 'profil_buts',
        short: 'Profil buts',
        detail: `Betfair classe ${bfGoals.profile} tandis que Polymarket classe ${pmGoals.profile}.`,
      });
    } else {
      convergences += 1;
      items.push({
        status: 'convergence',
        pair: 'Profil buts Betfair × Polymarket',
        detail: `Accord Betfair et Polymarket sur le profil ${bfGoals.profile}.`,
      });
    }
  }

  // Une seule cause « Betfair × Polymarket » quelle que soit la largeur des désaccords.
  if (bfPmCauses.length > 0) {
    contradictions += 1;
    items.push({
      status: 'contradiction',
      cause: 'betfair_polymarket',
      markets: bfPmCauses.map((c) => c.market),
      pair: 'Betfair × Polymarket',
      detail: bfPmCauses.map((c) => `${c.short} : ${c.detail}`).join(' | '),
      details: bfPmCauses.map((c) => c.detail),
    });
  }

  const causes = [...new Set(items.filter((i) => i.status === 'contradiction').map((i) => i.cause))];

  let overallStatus = 'partiel';
  if (contradictions > 0 && convergences === 0) overallStatus = 'contradiction';
  else if (contradictions > 0) overallStatus = 'mixte';
  else if (convergences >= 2) overallStatus = 'convergence';
  else if (convergences === 1) overallStatus = 'neutre';

  return {
    status: overallStatus,
    convergences,
    neutrals,
    contradictions,
    causes,
    unavailable,
    incoherent,
    items,
  };
}

export function analyzeFixtureConfiguration(
  fixture,
  quote = null,
  { thresholds = DEFAULT_CONFIG_THRESHOLDS, compared = null, nowMs = Date.now() } = {}
) {
  const th = resolveConfigThresholds(thresholds);
  const bfMarkets = fixture?.bf_markets || {};
  const pmMarkets = quote?.markets || {};

  const marketSnaps = {};
  const availableMarkets = [];
  for (const mKey of ALL_MARKETS) {
    const bfRow = bfMarkets[mKey] || null;
    const pmMkt = pmMarkets[mKey] || null;
    if (!bfRow && !pmMkt) continue;
    const snap = summarizeMarketAxis(mKey, bfRow, pmMkt, th);
    if (snap) {
      marketSnaps[mKey] = snap;
      availableMarkets.push(snap);
    }
  }

  const s1x2 = marketSnaps[MarketKey.OneXTwo] || null;
  const sBtts = marketSnaps[MarketKey.Btts] || null;
  const sHt = marketSnaps[MarketKey.HalfTime] || null;
  const sOu15 = marketSnaps[MarketKey.OverUnder15] || null;
  const sOu25 = marketSnaps[MarketKey.OverUnder25] || null;
  const sOu35 = marketSnaps[MarketKey.OverUnder35] || null;

  const bfGoals = deriveGoalsProfile(sOu15, sOu25, sOu35, false);
  const pmGoals = deriveGoalsProfile(sOu15, sOu25, sOu35, true);

  const ftBlock = s1x2?.source_bf ? s1x2.favorite : null;
  const bttsBlock = sBtts?.source_bf ? sBtts.favorite : null;
  const htBlock = sHt?.source_bf ? sHt.favorite : null;
  const goalsIncoherent = isIncoherentGoalsProfile(bfGoals);
  const goalsBlock =
    bfGoals.profile && !goalsIncoherent ? bfGoals.profile : null;

  const blocksPresent = [ftBlock, bttsBlock, htBlock, goalsBlock].filter(Boolean).length;
  const isComplete72 = blocksPresent === 4;
  // Un profil incohérent est exclu des 72 signatures : jamais de code « Atypique » ici.
  const signatureCode = [
    ftBlock || '?',
    bttsBlock || '?',
    htBlock || '?',
    goalsBlock || '?',
  ].join(' | ');

  // Signature côté Polymarket (sans inventer de valeurs manquantes)
  const pmFt = s1x2?.source_pm ? s1x2.pm_favorite : null;
  const pmBtts = sBtts?.source_pm ? sBtts.pm_favorite : null;
  const pmHt = sHt?.source_pm ? sHt.pm_favorite : null;
  const pmGoalsCode = pmGoals.profile || null;
  const pmHasAny = Boolean(pmFt || pmBtts || pmHt || pmGoalsCode);
  const pmSignatureCode = pmHasAny
    ? [pmFt || '?', pmBtts || '?', pmHt || '?', pmGoalsCode || '?'].join(' | ')
    : null;

  // Intensité globale (priorité 1X2 puis plus forte marge structurée)
  const structuredSnaps = availableMarkets.filter((m) => m.intensity !== null);
  const primarySnap = s1x2?.intensity ? s1x2 : structuredSnaps[0] || null;
  const intensityRank = { equilibre: 1, faible: 2, moderee: 3, forte: 4, extreme: 5 };
  const peakIntensitySnap = [...structuredSnaps].sort(
    (a, b) => (intensityRank[b.intensity] || 0) - (intensityRank[a.intensity] || 0)
  )[0] || null;

  // Variation globale ouverture -> actuel + PM 24h
  const varRank = {
    stable: 0,
    baisse_faible: 1,
    hausse_faible: 1,
    baisse_forte: 2,
    hausse_forte: 2,
    retournement: 3,
  };
  const topVariationSnap = [...availableMarkets]
    .filter((m) => m.source_bf)
    .sort(
      (a, b) =>
        (varRank[b.variation_class] || 0) - (varRank[a.variation_class] || 0) ||
        (b.variation_amplitude_pct || 0) - (a.variation_amplitude_pct || 0)
    )[0] || null;

  const topPmMoveSnap = [...availableMarkets]
    .filter((m) => m.pm_change_1d_pts !== null)
    .sort((a, b) => Math.abs(b.pm_change_1d_pts) - Math.abs(a.pm_change_1d_pts))[0] || null;

  const concordance = analyzeConcordance(marketSnaps, bfGoals, pmGoals, th);

  const dt = parseKickoff(fixture?.date);
  const kickoffPassed = Boolean(dt && dt.getTime() <= nowMs);

  const cfgRow = {
    fixture_key: fixture.fixture_key,
    home: fixture.home,
    away: fixture.away,
    league: fixture.league,
    country: fixture.country,
    date: fixture.date,
    date_label: fixture.date_label,
    kickoff_passed: kickoffPassed,
    total_volume_bf: round2(fixture.total_volume_bf || 0),
    pm_matched: Boolean(quote && Object.keys(pmMarkets).length > 0),
    pm_slug: quote?.slug || null,
    pm_url: quote?.url || null,
    pm_liquidity: numOrNull(quote?.liquidity),
    pm_volume: numOrNull(quote?.volume),
    markets_count: availableMarkets.length,
    quality_status: goalsIncoherent
      ? GOALS_QUALITY.Incoherent
      : bfGoals.status === 'complet'
      ? GOALS_QUALITY.Ok
      : GOALS_QUALITY.Incomplet,
    signature: {
      code: signatureCode,
      is_complete: isComplete72,
      blocks_present: blocksPresent,
      ft: ftBlock,
      btts: bttsBlock,
      ht: htBlock,
      goals_profile: goalsBlock,
      goals_status: bfGoals.status, // alias v1 déprécié
      goals_quality: bfGoals.quality_status,
      donnees_incoherentes: goalsIncoherent,
      goals_lines_present: bfGoals.lines_present,
      pm_code: pmSignatureCode,
      pm_goals_profile: pmGoals.profile,
      pm_goals_quality: pmGoals.quality_status,
    },
    axes: {
      orientation: {
        primary_market: primarySnap?.short || null,
        favorite: primarySnap?.favorite || null,
        favorite_pct: primarySnap?.favorite_pct ?? null,
        margin_pp: primarySnap?.margin_pp ?? null,
      },
      intensity: {
        level: primarySnap?.intensity || null,
        label: primarySnap?.intensity_label || 'Indisponible',
        peak_level: peakIntensitySnap?.intensity || null,
        peak_label: peakIntensitySnap?.intensity_label || 'Indisponible',
        peak_market: peakIntensitySnap?.short || null,
      },
      variation: {
        basis: 'ouverture_actuel_bf_et_pm_24h',
        class: topVariationSnap?.variation_class || VariationClass.Stable,
        label: topVariationSnap?.variation_label || VARIATION_LABELS.stable,
        market: topVariationSnap?.short || null,
        market_key: topVariationSnap?.market || null,
        side: topVariationSnap?.variation_side || null,
        drop_pct: topVariationSnap?.variation_drop_pct ?? null,
        amplitude_pct: topVariationSnap?.variation_amplitude_pct ?? 0,
        odds_amplitude: topVariationSnap?.variation_odds_amplitude ?? null,
        prob_delta_pp: topVariationSnap?.variation_prob_delta_pp ?? null,
        pm_market: topPmMoveSnap?.short || null,
        pm_change_1d_pts: topPmMoveSnap?.pm_change_1d_pts ?? null,
        has_reversal: availableMarkets.some((m) => m.variation_class === VariationClass.Retournement),
        has_strong_move: availableMarkets.some(
          (m) =>
            m.variation_class === VariationClass.BaisseForte ||
            m.variation_class === VariationClass.HausseForte
        ),
      },
      concordance,
    },
    markets: availableMarkets,
    compared_markets_count: compared?.markets?.length ?? 0,
    max_abs_gap_pp: compared?.max_abs_gap_pp ?? null,
    max_exec_edge_pp: compared?.max_exec_edge_pp ?? null,
  };

  // Clé de tri INTERNE (2.4) : jamais affichée dans l'interface v2 ni exposée en /api/v2.
  // L'alias interest_score est conservé uniquement pour les routes /api/* dépréciées.
  cfgRow.sort_key = computeConfigSortKey(cfgRow);
  cfgRow.interest_score = cfgRow.sort_key;
  return cfgRow;
}

export function computeConfigSortKey(row) {
  if (!row) return 0;
  const conc = row.axes?.concordance || {};
  const vari = row.axes?.variation || {};
  const sig = row.signature || {};

  const contraCount = conc.contradictions || 0;
  const convCount = conc.convergences || 0;
  const contraScore = Math.min(56, contraCount * 28);
  const moveScore =
    (vari.has_reversal ? 24 : vari.has_strong_move ? 14 : 0) +
    Math.min(8, (vari.amplitude_pct || 0) * 0.4 + Math.abs(vari.pm_change_1d_pts || 0) * 0.4);

  const pmScore = row.pm_matched ? 14 : 0;
  let edgeGapScore = 0;
  if (typeof row.max_exec_edge_pp === 'number' && row.max_exec_edge_pp > 0) {
    edgeGapScore = Math.min(18, row.max_exec_edge_pp * 3);
  } else if (typeof row.max_abs_gap_pp === 'number' && row.max_abs_gap_pp >= 2) {
    edgeGapScore = Math.min(10, row.max_abs_gap_pp * 1.2);
  }

  const convBonus = contraCount === 0 && convCount >= 2 ? 4 : 0;
  const structScore = (sig.blocks_present || 0) * 3.5 + (sig.is_complete ? 6 : 0);
  const bfVol = Math.max(0, row.total_volume_bf || 0);
  const volScore = bfVol > 0 ? Math.min(18, Math.log10(Math.max(50, bfVol)) * 3.4) : 0;
  const stalePenalty = row.kickoff_passed ? -25 : 0;

  return round2(
    contraScore + moveScore + pmScore + edgeGapScore + convBonus + structScore + volScore + stalePenalty
  );
}

// Alias v1 déprécié — ne pas utiliser dans le nouveau code.
export const computeConfigInterestScore = computeConfigSortKey;

// Tri PUBLIC des Écarts (2.4) : valeur nette décroissante, puis liquidité Polymarket.
// Aucune clé de tri interne n'intervient dans l'ordre affiché.
export function sortEcartsParValeurNette(list = []) {
  return [...list].sort((a, b) => {
    const ea = Number.isFinite(a?.net_edge_pp) ? a.net_edge_pp : -Infinity;
    const eb = Number.isFinite(b?.net_edge_pp) ? b.net_edge_pp : -Infinity;
    if (ea !== eb) return eb - ea;
    return (b?.pm_liquidity ?? 0) - (a?.pm_liquidity ?? 0);
  });
}

export async function collectFixturesAndQuotes({
  scraper,
  polymarket,
  force = false,
  maxPmLookup = DEFAULT_CONFIG_THRESHOLDS.pmLookupDefault,
  thresholds = DEFAULT_CONFIG_THRESHOLDS,
} = {}) {
  const th = resolveConfigThresholds(thresholds);
  const warnings = [];
  const settledArb = await mapWithConcurrency(ALL_MARKETS, 3, async (key) => {
    const reply = await scraper.fetch(key, force);
    if (reply.error) {
      warnings.push(`Arbworld ${key} : ${reply.error}`);
    }
    return enrich(reply.rows, key, reply.source, reply.ageSeconds);
  });

  const byFixture = new Map();
  for (const rows of settledArb) {
    for (const row of rows) {
      const key = fixtureKey(row.home, row.away);
      let entry = byFixture.get(key);
      if (!entry) {
        entry = {
          fixture_key: key,
          home: row.home,
          away: row.away,
          league: row.league,
          country: row.country,
          date: row.date,
          date_label: row.date_label,
          total_volume_bf: 0,
          bf_markets: {},
        };
        byFixture.set(key, entry);
      }
      entry.bf_markets[row.market] = row;
      entry.total_volume_bf += row.total_volume || 0;
      if (!entry.date && row.date) {
        entry.date = row.date;
        entry.date_label = row.date_label;
      }
    }
  }

  const allFixtures = [...byFixture.values()].sort(
    (a, b) => b.total_volume_bf - a.total_volume_bf
  );
  const quotesByKey = new Map();
  let pmErrors = 0;

  if (polymarket && typeof polymarket.quote === 'function') {
    const nowMs = Date.now();
    const candidates = allFixtures
      .filter((f) => {
        const dt = parseKickoff(f.date);
        if (!dt) return true;
        const diffHours = (dt.getTime() - nowMs) / 3_600_000;
        return diffHours >= -th.pmSearchPastHours && diffHours <= th.pmSearchFutureHours;
      })
      .slice(0, Math.min(th.pmLookupMax, Math.max(1, maxPmLookup)));

    await mapWithConcurrency(candidates, 4, async (f) => {
      const meta = { error: null };
      const quote = await polymarket.quote(
        f.fixture_key,
        f.home,
        f.away,
        parseKickoff(f.date),
        { force, meta }
      );
      if (meta.error) pmErrors += 1;
      if (quote && Object.keys(quote.markets || {}).length > 0) {
        quotesByKey.set(f.fixture_key, quote);
      }
    });
  }

  if (pmErrors > 0) {
    warnings.push(`${pmErrors} requête(s) Polymarket en erreur.`);
  }

  return { fixtures: allFixtures, quotesByKey, warnings };
}

function calibrationStatsBySignature(calibrationReport) {
  const obsList = Array.isArray(calibrationReport?.observations)
    ? calibrationReport.observations
    : [];
  if (obsList.length === 0) return new Map();

  // La signature est stockée sur l'observation : un match réglé n'est plus dans
  // les configurations live, donc plus besoin de jointure dessus.
  const map = new Map();
  for (const o of obsList) {
    if (o.status !== 'settled') continue;
    const sig = o.signature_code;
    if (!sig) continue;
    let bucket = map.get(sig);
    if (!bucket) {
      bucket = { settled_n: 0, brier_bf_sum: 0, brier_pm_sum: 0 };
      map.set(sig, bucket);
    }
    if (typeof o.brier_bf === 'number' && typeof o.brier_pm === 'number') {
      bucket.settled_n += 1;
      bucket.brier_bf_sum += o.brier_bf;
      bucket.brier_pm_sum += o.brier_pm;
    }
  }
  return map;
}

export function buildConfigurationsFromData(
  fixtures,
  quotesByKey = new Map(),
  { thresholds = null, calibrationReport = null, nowMs = Date.now(), warnings = [] } = {}
) {
  const resolvedTh = resolveConfigThresholds(thresholds);
  const rows = fixtures.map((f) => {
    const quote = quotesByKey.get(f.fixture_key) || null;
    const compared = quote ? compareFixture(f, quote, { nowMs }) : null;
    return analyzeFixtureConfiguration(f, quote, { thresholds: resolvedTh, compared, nowMs });
  });

  rows.sort(
    (a, b) =>
      (b.interest_score ?? 0) - (a.interest_score ?? 0) ||
      (b.total_volume_bf || 0) - (a.total_volume_bf || 0)
  );

  const calBySig = calibrationStatsBySignature(calibrationReport);

  const completeCounts = new Map();
  const partialCounts = new Map();

  for (const s of ALL_72_SIGNATURES) {
    completeCounts.set(s.code, {
      ...s,
      count: 0,
      pm_matched: 0,
      contradictions: 0,
      convergences: 0,
      reversals: 0,
      volume_sum: 0,
      intensity_counts: {},
    });
  }

  const blockCoverage = { one_x_two: 0, btts: 0, half_time: 0, goals_profile: 0 };
  const goalsDist = { G1: 0, G2: 0, G3: 0, G4: 0, atypique: 0, incomplet: 0 };
  let incoherentGoalsCount = 0;
  let completeCount = 0;
  let partialCount = 0;
  let pmMatchedCount = 0;
  let convergentFixtures = 0;
  let contradictionFixtures = 0;
  let strongMoveFixtures = 0;
  let reversalFixtures = 0;
  let minDate = null;
  let maxDate = null;

  for (const r of rows) {
    if (r.quality_status === GOALS_QUALITY.Incoherent) incoherentGoalsCount += 1;
    if (r.pm_matched) pmMatchedCount += 1;
    if (r.signature.ft) blockCoverage.one_x_two += 1;
    if (r.signature.btts) blockCoverage.btts += 1;
    if (r.signature.ht) blockCoverage.half_time += 1;
    if (r.signature.goals_profile && r.signature.goals_profile !== 'Atypique') {
      blockCoverage.goals_profile += 1;
    }

    if (r.signature.goals_profile === 'G1') goalsDist.G1 += 1;
    else if (r.signature.goals_profile === 'G2') goalsDist.G2 += 1;
    else if (r.signature.goals_profile === 'G3') goalsDist.G3 += 1;
    else if (r.signature.goals_profile === 'G4') goalsDist.G4 += 1;
    else if (r.signature.goals_profile === 'Atypique') goalsDist.atypique += 1;
    else goalsDist.incomplet += 1;

    if (r.axes.concordance.contradictions > 0) contradictionFixtures += 1;
    else if (r.axes.concordance.convergences > 0) convergentFixtures += 1;
    if (r.axes.variation.has_strong_move) strongMoveFixtures += 1;
    if (r.axes.variation.has_reversal) reversalFixtures += 1;

    if (r.date) {
      if (!minDate || r.date < minDate) minDate = r.date;
      if (!maxDate || r.date > maxDate) maxDate = r.date;
    }

    if (r.signature.is_complete) {
      completeCount += 1;
      const bucket = completeCounts.get(r.signature.code);
      if (bucket) {
        bucket.count += 1;
        if (r.pm_matched) bucket.pm_matched += 1;
        if (r.axes.concordance.contradictions > 0) bucket.contradictions += 1;
        if (r.axes.concordance.convergences > 0 && r.axes.concordance.contradictions === 0) {
          bucket.convergences += 1;
        }
        if (r.axes.variation.has_reversal) bucket.reversals += 1;
        bucket.volume_sum += r.total_volume_bf || 0;
        const intLbl = r.axes.intensity.label || 'Indisponible';
        bucket.intensity_counts[intLbl] = (bucket.intensity_counts[intLbl] || 0) + 1;
      }
    } else {
      partialCount += 1;
      let pBucket = partialCounts.get(r.signature.code);
      if (!pBucket) {
        pBucket = {
          code: r.signature.code,
          blocks_present: r.signature.blocks_present,
          count: 0,
          pm_matched: 0,
          contradictions: 0,
          volume_sum: 0,
        };
        partialCounts.set(r.signature.code, pBucket);
      }
      pBucket.count += 1;
      if (r.pm_matched) pBucket.pm_matched += 1;
      if (r.axes.concordance.contradictions > 0) pBucket.contradictions += 1;
      pBucket.volume_sum += r.total_volume_bf || 0;
    }
  }

  const catalog72 = [...completeCounts.values()]
    .map((b) => {
      const topInt = Object.entries(b.intensity_counts).sort((x, y) => y[1] - x[1])[0]?.[0] || '—';
      const cal = calBySig.get(b.code);
      const avgVol = b.count > 0 ? Math.round(b.volume_sum / b.count) : 0;
      const sortKey =
        b.count === 0
          ? 0
          : round2(
              Math.min(24, Math.log2(b.count + 1) * 6) +
                Math.min(20, b.contradictions * 8) +
                Math.min(12, b.reversals * 6) +
                Math.min(15, b.pm_matched * 3) +
                (avgVol > 0 ? Math.min(15, Math.log10(Math.max(100, avgVol)) * 2.8) : 0)
            );
      return {
        code: b.code,
        ft: b.ft,
        btts: b.btts,
        ht: b.ht,
        goals_profile: b.goals_profile,
        count: b.count,
        share_pct: completeCount > 0 ? round1((b.count / completeCount) * 100.0) : 0,
        pm_matched: b.pm_matched,
        contradictions: b.contradictions,
        convergences: b.convergences,
        reversals: b.reversals,
        avg_volume_bf: avgVol,
        sort_key: sortKey,
        interest_score: sortKey, // alias v1 déprécié
        dominant_intensity: topInt,
        sample_warning: b.count > 0 && b.count < 30 ? 'Échantillon faible (n < 30)' : null,
        calibration: cal
          ? {
              settled_n: cal.settled_n,
              brier_bf: cal.settled_n > 0 ? Number((cal.brier_bf_sum / cal.settled_n).toFixed(4)) : null,
              brier_pm: cal.settled_n > 0 ? Number((cal.brier_pm_sum / cal.settled_n).toFixed(4)) : null,
            }
          : null,
      };
    })
    .sort(
      (a, b) =>
        (b.count > 0 ? 1 : 0) - (a.count > 0 ? 1 : 0) ||
        (b.sort_key || 0) - (a.sort_key || 0) ||
        b.count - a.count ||
        a.code.localeCompare(b.code)
    );

  const partialSignatures = [...partialCounts.values()]
    .map((p) => {
      const avgVol = p.count > 0 ? Math.round(p.volume_sum / p.count) : 0;
      const sortKey = round2(
        p.blocks_present * 4 +
          Math.min(20, Math.log2(p.count + 1) * 5) +
          Math.min(16, p.contradictions * 7) +
          Math.min(14, p.pm_matched * 3) +
          (avgVol > 0 ? Math.min(14, Math.log10(Math.max(100, avgVol)) * 2.6) : 0)
      );
      return {
        code: p.code,
        blocks_present: p.blocks_present,
        count: p.count,
        share_pct: rows.length > 0 ? round1((p.count / rows.length) * 100.0) : 0,
        pm_matched: p.pm_matched,
        contradictions: p.contradictions,
        avg_volume_bf: avgVol,
        sort_key: sortKey,
        interest_score: sortKey, // alias v1 déprécié
      };
    })
    .sort(
      (a, b) =>
        (b.sort_key || 0) - (a.sort_key || 0) ||
        b.count - a.count ||
        b.blocks_present - a.blocks_present
    );

  const uniqueObserved72 = catalog72.filter((s) => s.count > 0).length;

  return {
    generated_at: new Date().toISOString(),
    period: {
      min_date: minDate,
      max_date: maxDate,
    },
    thresholds: resolvedTh,
    // Rapport qualité (2.1) : les profils de buts impossibles sont comptés ici,
    // jamais comme contradiction ni comme l'une des 72 signatures.
    quality_report: {
      donnees_incoherentes: incoherentGoalsCount,
      exclues_des_72: incoherentGoalsCount,
      incomplet: goalsDist.incomplet,
      signatures_possibles: 72,
    },
    summary: {
      total_fixtures: rows.length,
      pm_matched_fixtures: pmMatchedCount,
      complete_signatures: completeCount,
      partial_signatures: partialCount,
      unique_complete_signatures: uniqueObserved72,
      total_possible_signatures: 72,
      block_coverage: blockCoverage,
      goals_distribution: goalsDist,
      axes_counts: {
        convergences: convergentFixtures,
        contradictions: contradictionFixtures,
        strong_moves: strongMoveFixtures,
        reversals: reversalFixtures,
      },
    },
    catalog_72: catalog72,
    partial_signatures: partialSignatures,
    rows,
    warnings,
  };
}

export async function buildConfigurations({
  scraper,
  polymarket,
  calibration = null,
  force = false,
  maxPmLookup = DEFAULT_CONFIG_THRESHOLDS.pmLookupDefault,
  thresholds = null,
} = {}) {
  const { fixtures, quotesByKey, warnings } = await collectFixturesAndQuotes({
    scraper,
    polymarket,
    force,
    maxPmLookup,
    thresholds,
  });
  const calibrationReport = calibration ? calibration.report({ limit: 500 }) : null;
  return buildConfigurationsFromData(fixtures, quotesByKey, {
    thresholds,
    calibrationReport,
    warnings,
  });
}

export function buildSignalsFromData(
  fixtures,
  quotesByKey = new Map(),
  {
    preset = DEFAULT_PROPOSAL_PRESET,
    thresholdOverrides = null,
    configThresholds = null,
    nowMs = Date.now(),
    warnings = [],
  } = {}
) {
  const basePreset = SIGNAL_PRESETS[preset] || SIGNAL_PRESETS[DEFAULT_PROPOSAL_PRESET];
  const recoThresholds = resolveProposalThresholds(basePreset.key, thresholdOverrides);
  const resolvedCfgTh = resolveConfigThresholds(configThresholds);

  const executableSignals = [];
  const flowSignals = [];
  const configurationSignals = [];

  for (const f of fixtures) {
    const quote = quotesByKey.get(f.fixture_key) || null;
    const compared = quote ? compareFixture(f, quote, { nowMs }) : null;
    const config = analyzeFixtureConfiguration(f, quote, {
      thresholds: resolvedCfgTh,
      compared,
      nowMs,
    });
    if (config.kickoff_passed) continue;

    const bfVol = Math.max(0, compared?.total_volume_bf ?? config.total_volume_bf ?? 0);
    const pmLiq = Math.max(0, quote?.liquidity ?? config.pm_liquidity ?? 0);
    const volBoost =
      (bfVol > 0 ? Math.min(6, Math.log10(Math.max(100, bfVol)) * 1.1) : 0) +
      (pmLiq > 0 ? Math.min(2, Math.log10(Math.max(100, pmLiq)) * 0.4) : 0);

    if (compared) {
      const recoInfo = evaluateFixtureRecommendations(compared, nowMs, recoThresholds);
      for (const reco of recoInfo.recommendations) {
        const rank = reco.proposal_rank || 1;
        const prio = reco.market_priority || 1;
        const edgeVal = typeof reco.net_edge_pp === 'number' ? reco.net_edge_pp : 0;
        const edgeSign = edgeVal >= 0 ? '+' : '';
        const execScore =
          edgeVal >= 0
            ? (reco.tier === 'high'
                ? 105 + Math.min(18, edgeVal * 2.2)
                : reco.tier === 'moderate'
                ? 88 + Math.min(15, edgeVal * 2.0)
                : 74 + Math.min(12, edgeVal * 2.5)) +
              (rank === 1 ? 5 : 0) +
              (prio - 1) * 1.5 +
              volBoost * 0.8
            : 24 +
              Math.max(-15, edgeVal * 3.5) +
              (rank === 1 ? 3 : 0) +
              (prio - 1) * 0.5 +
              volBoost * 0.6;
        executableSignals.push({
          id: `exec::${f.fixture_key}::${reco.market}::${reco.side_label}`,
          category: 'executable',
          category_label: 'Proposition BF×PM',
          fixture_key: f.fixture_key,
          home: f.home,
          away: f.away,
          league: f.league,
          country: f.country,
          date: f.date,
          date_label: f.date_label,
          signature_code: config.signature.code,
          signature_complete: config.signature.is_complete,
          pm_signature_code: config.signature.pm_code || null,
          pm_url: compared.pm_url,
          total_volume_bf: compared.total_volume_bf,
          pm_liquidity: reco.pm_liquidity,
          tier: reco.tier,
          tier_rank: reco.tier_rank,
          tier_label: reco.tier_label,
          market: reco.market,
          market_short: reco.market_short,
          market_priority: prio,
          proposal_rank: rank,
          secondary_of: reco.secondary_of || null,
          title: rank > 1 ? `${rank}e proposition : ${reco.action}` : `Proposition : ${reco.action}`,
          detail: `Prob. ${reco.prop_pct?.toFixed(1) ?? reco.pm_exec_pct?.toFixed(1) ?? '—'} % (BF ${reco.bf_prop_pct?.toFixed(1) ?? reco.bf_pct?.toFixed(1) ?? '—'} %) · Écart net ${edgeSign}${edgeVal.toFixed(1)} pts${reco.ev_pct > 0 ? ` · EV +${reco.ev_pct.toFixed(1)} %` : ''}`,
          net_edge_pp: reco.net_edge_pp,
          sort_key: round2(execScore),
          score_sort: round2(execScore), // alias v1 déprécié
          recommendation: reco,
          config_summary: {
            signature: config.signature.code,
            intensity: config.axes.intensity.label,
            variation: config.axes.variation.label,
            contradictions: config.axes.concordance.contradictions,
          },
        });
      }

      for (const mkt of compared.markets || []) {
        for (const obs of mkt.observations || []) {
          const sideMatch = typeof obs.label === 'string' ? obs.label.match(/\(([^)]+)\)\s*$/) : null;
          const obsSideLbl = sideMatch ? sideMatch[1].trim() : null;
          const matchedSide = obsSideLbl ? (mkt.sides || []).find((s) => s.label === obsSideLbl) : null;
          const obsDir =
            obs.type === 'net_discrepancy' && matchedSide
              ? (matchedSide.sell_edge_pp ?? -99) > (matchedSide.buy_edge_pp ?? -99)
                ? 'sell_pm'
                : 'buy_pm'
              : obs.type === 'pm_move' && matchedSide && (matchedSide.gap_pp ?? 0) > 0
              ? 'sell_pm'
              : 'buy_pm';
          const flowScore =
            obs.type === 'lag_pm'
              ? 46 + Math.min(14, Math.max(0, mkt.max_exec_edge_pp || 0) * 2.0) + volBoost
              : obs.type === 'pm_move'
              ? 40 + Math.min(10, Math.abs(mkt.max_abs_gap_pp || 0) * 1.2) + volBoost
              : 36 + Math.min(8, Math.max(0, mkt.max_exec_edge_pp || 0) * 1.5) + volBoost;
          flowSignals.push({
            id: `flow::${f.fixture_key}::${mkt.market}::${obs.type}`,
            category: 'flow',
            category_label: 'Retards & Flux BF×PM',
            signal_type: obs.type,
            fixture_key: f.fixture_key,
            home: f.home,
            away: f.away,
            league: f.league,
            country: f.country,
            date: f.date,
            date_label: f.date_label,
            signature_code: config.signature.code,
            signature_complete: config.signature.is_complete,
            pm_signature_code: config.signature.pm_code || null,
            pm_url: compared.pm_url,
            total_volume_bf: compared.total_volume_bf,
            pm_liquidity: mkt.pm_liquidity,
            market: mkt.market,
            market_short: mkt.short,
            side_label: obsSideLbl,
            direction: obsDir,
            title: `${obs.label} (${mkt.short})`,
            detail: obs.detail,
            net_edge_pp: mkt.max_exec_edge_pp,
            sort_key: round2(flowScore),
            score_sort: round2(flowScore), // alias v1 déprécié
            market_data: mkt,
          });
        }
      }
    }

    // Mouvements & retournements Betfair (ouverture -> actuel) sur variations de probabilité significatives
    if (
      (config.axes.variation.has_reversal || config.axes.variation.has_strong_move) &&
      (config.total_volume_bf || 0) >= resolvedCfgTh.movementMinVolumeEur &&
      Math.abs(config.axes.variation.prob_delta_pp ?? 0) >= resolvedCfgTh.movementMinProbDeltaPp
    ) {
      const v = config.axes.variation;
      const moveScore =
        (v.has_reversal
          ? 46 + Math.min(14, Math.abs(v.prob_delta_pp || 0) * 1.6)
          : 36 + Math.min(11, Math.abs(v.prob_delta_pp || 0) * 1.4)) +
        Math.min(4, (v.amplitude_pct || 0) * 0.1) +
        (config.pm_matched ? (v.has_reversal ? 4 : 3) : 0) +
        volBoost * 0.8;
      flowSignals.push({
        id: `move::${f.fixture_key}::${v.market || 'mkt'}`,
        category: 'movement',
        category_label: v.has_reversal ? 'Retournement Betfair' : 'Mouvement fort Betfair',
        signal_type: v.class,
        fixture_key: f.fixture_key,
        home: f.home,
        away: f.away,
        league: f.league,
        country: f.country,
        date: f.date,
        date_label: f.date_label,
        signature_code: config.signature.code,
        signature_complete: config.signature.is_complete,
        pm_signature_code: config.signature.pm_code || null,
        pm_url: config.pm_url,
        total_volume_bf: config.total_volume_bf,
        pm_liquidity: config.pm_liquidity,
        market: v.market_key || v.market,
        market_short: v.market,
        side_label: v.side || null,
        drop_pct: v.drop_pct ?? null,
        title: `${v.label} · ${v.market || '—'}${v.side ? ` (${v.side})` : ''}`,
        detail: `Ouverture → actuel : ${v.drop_pct !== null ? `${v.drop_pct > 0 ? '+' : ''}${v.drop_pct.toFixed(1)} %` : `${v.amplitude_pct.toFixed(1)} %`}${v.prob_delta_pp !== null ? ` (${v.prob_delta_pp > 0 ? '+' : ''}${v.prob_delta_pp.toFixed(1)} pts prob.)` : ''}${v.pm_change_1d_pts !== null ? ` · PM 24h ${v.pm_change_1d_pts > 0 ? '+' : ''}${v.pm_change_1d_pts.toFixed(1)} pts` : ''}`,
        amplitude_pct: v.amplitude_pct,
        prob_delta_pp: v.prob_delta_pp,
        sort_key: round2(moveScore),
        score_sort: round2(moveScore), // alias v1 déprécié
        config_summary: config,
      });
    }

    // Contradictions multi-marchés & désaccords Betfair × Polymarket
    if (config.axes.concordance.contradictions > 0) {
      const contras = config.axes.concordance.items.filter((i) => i.status === 'contradiction');
      // 2.2 : une entrée = une cause distincte, avec la liste des marchés concernés.
      const causes = contras.map((c) => ({
        cause: c.cause,
        markets: c.markets || [],
        detail: c.detail,
      }));
      const contraScore =
        52 +
        Math.min(20, contras.length * 8) +
        (config.pm_matched ? 6 : 0) +
        (typeof config.max_abs_gap_pp === 'number' ? Math.min(6, config.max_abs_gap_pp * 0.5) : 0) +
        volBoost;
      configurationSignals.push({
        id: `contra::${f.fixture_key}`,
        category: 'contradiction',
        category_label: 'Contradiction multi-marchés',
        fixture_key: f.fixture_key,
        home: f.home,
        away: f.away,
        league: f.league,
        country: f.country,
        date: f.date,
        date_label: f.date_label,
        signature_code: config.signature.code,
        signature_complete: config.signature.is_complete,
        pm_signature_code: config.signature.pm_code || null,
        pm_url: config.pm_url,
        total_volume_bf: config.total_volume_bf,
        pm_liquidity: config.pm_liquidity,
        contradictions_count: causes.length,
        title: `${causes.length} cause(s) de désaccord : ${contras.map((c) => c.pair).join(' · ')}`,
        detail: contras.map((c) => c.detail).join(' | '),
        causes,
        items: contras,
        sort_key: round2(contraScore),
        score_sort: round2(contraScore), // alias v1 déprécié
        config_summary: config,
      });
    }
  }

  executableSignals.sort(
    (a, b) =>
      (a.proposal_rank || 9) - (b.proposal_rank || 9) ||
      ((b.net_edge_pp ?? -999) >= 0 ? 1 : 0) - ((a.net_edge_pp ?? -999) >= 0 ? 1 : 0) ||
      b.tier_rank - a.tier_rank ||
      (b.sort_key || 0) - (a.sort_key || 0) ||
      (b.market_priority || 1) - (a.market_priority || 1) ||
      (b.net_edge_pp ?? -999) - (a.net_edge_pp ?? -999) ||
      b.total_volume_bf - a.total_volume_bf
  );
  flowSignals.sort((a, b) => b.sort_key - a.sort_key || b.total_volume_bf - a.total_volume_bf);
  configurationSignals.sort((a, b) => b.sort_key - a.sort_key || b.total_volume_bf - a.total_volume_bf);

  const allSignals = [
    ...executableSignals,
    ...flowSignals,
    ...configurationSignals,
  ].sort((a, b) => b.sort_key - a.sort_key || b.total_volume_bf - a.total_volume_bf);
  // La liste plate est la surface publique : tri valeur nette puis liquidité (2.4).
  const publicEcarts = sortEcartsParValeurNette(allSignals);

  return {
    generated_at: new Date().toISOString(),
    preset: basePreset.key,
    preset_label: basePreset.label,
    thresholds: recoThresholds,
    counts: {
      total: allSignals.length,
      executable: executableSignals.length,
      flow: flowSignals.filter((s) => s.category === 'flow').length,
      movement: flowSignals.filter((s) => s.category === 'movement').length,
      contradiction: configurationSignals.length,
      high: executableSignals.filter((s) => s.tier === 'high').length,
      moderate: executableSignals.filter((s) => s.tier === 'moderate').length,
      low: executableSignals.filter((s) => s.tier === 'low').length,
    },
    executable_signals: executableSignals,
    flow_signals: flowSignals,
    configuration_signals: configurationSignals,
    all_signals: publicEcarts,
    warnings,
  };
}

export async function buildSignals({
  scraper,
  polymarket,
  force = false,
  maxPmLookup = DEFAULT_CONFIG_THRESHOLDS.pmLookupDefault,
  preset = DEFAULT_PROPOSAL_PRESET,
  thresholdOverrides = null,
  configThresholds = null,
} = {}) {
  const { fixtures, quotesByKey, warnings } = await collectFixturesAndQuotes({
    scraper,
    polymarket,
    force,
    maxPmLookup,
    thresholds: configThresholds,
  });
  return buildSignalsFromData(fixtures, quotesByKey, {
    preset,
    thresholdOverrides,
    configThresholds,
    warnings,
  });
}
