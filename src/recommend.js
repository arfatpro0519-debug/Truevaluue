// Moteur de propositions (Betfair × Polymarket) après analyse, avec 3 niveaux de confiance et seuils configurables.

import { parseKickoff, round1, round2 } from './enrich.js';
import { MarketShape } from './market.js';

export const ConfidenceLevel = Object.freeze({
  High: 'high',
  Moderate: 'moderate',
  Low: 'low',
});

export const CONFIDENCE_RANK = Object.freeze({
  high: 3,
  moderate: 2,
  low: 1,
});

export const CONFIDENCE_LABELS = Object.freeze({
  high: 'Confiance élevée',
  moderate: 'Confiance modérée',
  low: 'Confiance faible',
});

export const DEFAULT_PROPOSAL_PRESET = 'zero';

export const STRICT_THRESHOLDS = Object.freeze({
  minNetEdgePp: 2.5,
  moderateNetEdgePp: 3.0,
  highNetEdgePp: 4.0,
  minBfVolume: 3000,
  moderateBfVolume: 8000,
  highBfVolume: 15000,
  minPmLiquidity: 500,
  moderatePmLiquidity: 1000,
  highPmLiquidity: 2500,
  maxSpreadPts: 6.0,
  moderateMaxSpreadPts: 4.0,
  highMaxSpreadPts: 3.0,
  minProbPct: 10.0,
  maxProbPct: 90.0,
  highMinProbPct: 15.0,
  highMaxProbPct: 85.0,
  maxAdverseDropPct: 3.0,
});

export const ZERO_THRESHOLDS = Object.freeze({
  ...STRICT_THRESHOLDS,
  minNetEdgePp: 0,
  minBfVolume: 0,
  minPmLiquidity: 0,
  maxSpreadPts: 25.0,
  minProbPct: 0.0,
  maxProbPct: 100.0,
  maxAdverseDropPct: 100.0,
});

export const PROPOSAL_PRESETS = Object.freeze({
  zero: Object.freeze({
    key: 'zero',
    label: 'Seuil 0 (défaut)',
    ...ZERO_THRESHOLDS,
  }),
  strict: Object.freeze({
    key: 'strict',
    label: 'Strict (vol. BF ≥ 3 000 €)',
    ...STRICT_THRESHOLDS,
  }),
  balanced: Object.freeze({
    key: 'balanced',
    label: 'Élargi (vol. BF ≥ 1 000 €)',
    ...STRICT_THRESHOLDS,
    minNetEdgePp: 2.0,
    moderateNetEdgePp: 2.5,
    minBfVolume: 1000,
    moderateBfVolume: 4000,
    minPmLiquidity: 250,
    moderatePmLiquidity: 750,
    maxSpreadPts: 7.0,
  }),
  exploratory: Object.freeze({
    key: 'exploratory',
    label: 'Exploratoire (vol. BF ≥ 300 €)',
    ...STRICT_THRESHOLDS,
    minNetEdgePp: 1.5,
    moderateNetEdgePp: 2.2,
    minBfVolume: 300,
    moderateBfVolume: 1500,
    minPmLiquidity: 100,
    moderatePmLiquidity: 400,
    maxSpreadPts: 8.0,
  }),
});

export function resolveProposalThresholds(preset = DEFAULT_PROPOSAL_PRESET, overrides = null) {
  const base = PROPOSAL_PRESETS[preset] || PROPOSAL_PRESETS[DEFAULT_PROPOSAL_PRESET];
  const resolved = { ...STRICT_THRESHOLDS, ...base };
  delete resolved.key;
  delete resolved.label;
  if (overrides && typeof overrides === 'object') {
    for (const k of Object.keys(STRICT_THRESHOLDS)) {
      if (overrides[k] === undefined || overrides[k] === null || overrides[k] === '') continue;
      const val = Number(overrides[k]);
      if (Number.isFinite(val) && val >= 0) {
        resolved[k] = val;
      }
    }
  }
  return resolved;
}

export function formatProposalAction(marketKey, sideLabel, direction = 'buy_pm') {
  const lbl = String(sideLabel || '').trim();
  const isSell = direction === 'sell_pm';

  if (marketKey === '1x2') {
    if (!isSell) {
      if (lbl === '1') return '1 (Domicile)';
      if (lbl === '2') return '2 (Extérieur)';
      if (lbl === 'N' || lbl === 'X') return 'Nul (X)';
    } else {
      if (lbl === '1') return 'X2 (Nul ou extérieur)';
      if (lbl === '2') return '1X (Domicile ou nul)';
      if (lbl === 'N' || lbl === 'X') return '12 (Domicile ou extérieur)';
    }
  }

  if (
    marketKey === 'over-under-1-5' ||
    marketKey === 'over-under-2-5' ||
    marketKey === 'over-under-3-5'
  ) {
    const line = marketKey === 'over-under-1-5' ? '1.5' : marketKey === 'over-under-3-5' ? '3.5' : '2.5';
    const wantOver = (!isSell && lbl === 'Over') || (isSell && lbl === 'Under');
    return wantOver ? `Plus de ${line} buts` : `Moins de ${line} buts`;
  }

  if (marketKey === 'btts') {
    const wantYes = (!isSell && lbl === 'Oui') || (isSell && lbl === 'Non');
    return wantYes ? 'Les 2 équipes marquent : Oui' : 'Les 2 équipes marquent : Non';
  }

  if (marketKey === 'double-chance') {
    if (!isSell) {
      if (lbl === '1X') return '1X (Domicile ou nul)';
      if (lbl === 'X2') return 'X2 (Nul ou extérieur)';
      if (lbl === '12') return '12 (Domicile ou extérieur)';
    } else {
      if (lbl === '1X') return '2 (Extérieur)';
      if (lbl === 'X2') return '1 (Domicile)';
      if (lbl === '12') return 'Nul (X)';
    }
  }

  if (marketKey === 'dnb') {
    const wantHome = (!isSell && lbl === '1') || (isSell && lbl === '2');
    return wantHome ? '1 (Domicile, remboursé si nul)' : '2 (Extérieur, remboursé si nul)';
  }

  if (marketKey === 'half-time') {
    if (!isSell) {
      if (lbl === '1') return '1 Mi-temps (Domicile)';
      if (lbl === '2') return '2 Mi-temps (Extérieur)';
      if (lbl === 'N' || lbl === 'X') return 'Nul Mi-temps (X)';
    } else {
      if (lbl === '1') return 'X2 Mi-temps (Nul ou extérieur)';
      if (lbl === '2') return '1X Mi-temps (Domicile ou nul)';
      if (lbl === 'N' || lbl === 'X') return '12 Mi-temps (Domicile ou extérieur)';
    }
  }

  return isSell ? `Opposé à ${lbl}` : lbl;
}

function hasFlowConfirmation(direction, side, mkt, thresholds = STRICT_THRESHOLDS) {
  const drop = side.bf_drop_pct;
  const share = side.bf_share_pct;
  const obsTypes = new Set((mkt.observations || []).map((o) => o.type));

  if (direction === 'buy_pm') {
    if (drop !== null && drop <= -2.0) return true;
    if (share !== null && share >= 45.0 && (drop === null || drop <= 0.5)) return true;
    if (obsTypes.has('lag_pm') || obsTypes.has('pm_move')) return true;
    return false;
  }

  if (drop !== null && drop >= 0.5) return true;
  if (share !== null && share <= 30.0 && (mkt.bf_volume || 0) >= thresholds.moderateBfVolume) {
    return true;
  }
  return false;
}

function evaluateSideCandidate(
  side,
  mkt,
  thresholds = STRICT_THRESHOLDS,
  forceDirection = null,
  opts = {}
) {
  if (typeof side.bf_pct !== 'number' || typeof side.pm_pct !== 'number') {
    return { candidate: null, reason: null };
  }
  if (side.bf_pct < thresholds.minProbPct || side.bf_pct > thresholds.maxProbPct) {
    return { candidate: null, reason: 'Probabilité extrême (< seuil ou > plafond)' };
  }

  const promoted = Boolean(opts?.promoted);
  const buyEdge = typeof side.buy_edge_pp === 'number' ? side.buy_edge_pp : null;
  const sellEdge = typeof side.sell_edge_pp === 'number' ? side.sell_edge_pp : null;

  let direction = null;
  let netEdge = null;
  let pmExecPct = null;
  let pmExecOdds = null;
  let propPct = null;
  let propOdds = null;
  let bfPropPct = null;
  let bfPropOdds = null;
  let action = null;

  const canBuy =
    buyEdge !== null &&
    buyEdge >= thresholds.minNetEdgePp &&
    (forceDirection === 'buy_pm' || sellEdge === null || buyEdge >= sellEdge);

  if (forceDirection !== 'sell_pm' && canBuy) {
    if (side.bf_drop_pct !== null && side.bf_drop_pct > thresholds.maxAdverseDropPct) {
      return { candidate: null, reason: `Cote Betfair en hausse contraire (+${side.bf_drop_pct.toFixed(1)} %)` };
    }
    direction = 'buy_pm';
    netEdge = buyEdge;
    pmExecPct = side.pm_ask !== null ? round1(side.pm_ask * 100.0) : null;
    pmExecOdds = side.pm_ask && side.pm_ask > 0 ? round2(1.0 / side.pm_ask) : null;
    propPct = pmExecPct;
    propOdds = pmExecOdds;
    bfPropPct = side.bf_pct;
    bfPropOdds = side.bf_odds;
    action = formatProposalAction(mkt.market, side.label, 'buy_pm');
  } else if (forceDirection !== 'buy_pm' && sellEdge !== null && sellEdge >= thresholds.minNetEdgePp) {
    if (side.bf_drop_pct !== null && side.bf_drop_pct < -thresholds.maxAdverseDropPct) {
      return { candidate: null, reason: `Cote Betfair en baisse vers l’autre côté (${side.bf_drop_pct.toFixed(1)} %)` };
    }
    direction = 'sell_pm';
    netEdge = sellEdge;
    pmExecPct = side.pm_bid !== null ? round1(side.pm_bid * 100.0) : null;
    pmExecOdds = side.pm_bid && side.pm_bid > 0 ? round2(1.0 / side.pm_bid) : null;
    propPct = side.pm_bid !== null ? round1((1.0 - side.pm_bid) * 100.0) : null;
    propOdds = side.pm_bid !== null && side.pm_bid < 1.0 ? round2(1.0 / (1.0 - side.pm_bid)) : null;
    bfPropPct = round1(100.0 - side.bf_pct);
    bfPropOdds = bfPropPct > 0 ? round2(100.0 / bfPropPct) : null;
    action = formatProposalAction(mkt.market, side.label, 'sell_pm');
  } else {
    return { candidate: null, reason: null };
  }

  // Filtrer le bruit d'arrondi (0.0–0.2 pt) et les grosses cotes / paris contrariants sans réel écart
  if (!promoted) {
    const baseFloor = Math.max(thresholds.minNetEdgePp, 0.3);
    if (netEdge < baseFloor) {
      return { candidate: null, reason: `Écart net trop faible (${netEdge.toFixed(1)} pts < ${baseFloor.toFixed(1)} pt)` };
    }
    if (bfPropPct < 15.0 && netEdge < Math.max(thresholds.minNetEdgePp, 2.0)) {
      return { candidate: null, reason: `Grosse cote (${bfPropPct.toFixed(1)} %) exige écart net ≥ 2.0 pts` };
    }
    if (bfPropPct < 35.0 && netEdge < Math.max(thresholds.minNetEdgePp, 1.0)) {
      return { candidate: null, reason: `Outsider (${bfPropPct.toFixed(1)} %) exige écart net ≥ 1.0 pt` };
    }
    if (bfPropPct < 45.0 && netEdge < Math.max(thresholds.minNetEdgePp, 0.5)) {
      return { candidate: null, reason: `Issue non favorite (${bfPropPct.toFixed(1)} %) exige écart net ≥ 0.5 pt` };
    }
    if (direction === 'sell_pm') {
      const sellFloor = Math.max(thresholds.minNetEdgePp, bfPropPct < 50.0 ? 1.5 : 0.5);
      if (netEdge < sellFloor) {
        return { candidate: null, reason: `Position opposée exige écart net ≥ ${sellFloor.toFixed(1)} pts` };
      }
    }
  }

  const flowConfirmed = hasFlowConfirmation(direction, side, mkt, thresholds);
  const bfVol = mkt.bf_volume || 0;
  const pmLiq = mkt.pm_liquidity ?? 0;
  const spreadPts = mkt.pm_spread_pts;
  const isNative = mkt.bf_source === 'native';
  const probCentered =
    side.bf_pct >= thresholds.highMinProbPct &&
    side.bf_pct <= thresholds.highMaxProbPct;

  const isHigh =
    isNative &&
    netEdge >= thresholds.highNetEdgePp &&
    bfVol >= thresholds.highBfVolume &&
    pmLiq >= thresholds.highPmLiquidity &&
    spreadPts !== null &&
    spreadPts <= thresholds.highMaxSpreadPts &&
    probCentered &&
    flowConfirmed;

  let tier = ConfidenceLevel.Low;
  const minModEdge = Math.min(thresholds.moderateNetEdgePp, 2.0);
  if (isHigh) {
    tier = ConfidenceLevel.High;
  } else if (netEdge >= minModEdge) {
    let modChecks = 0;
    if (netEdge >= thresholds.moderateNetEdgePp) modChecks += 1;
    if (bfVol >= thresholds.moderateBfVolume && pmLiq >= thresholds.moderatePmLiquidity) {
      modChecks += 1;
    }
    if (spreadPts !== null && spreadPts <= thresholds.moderateMaxSpreadPts) modChecks += 1;
    if (isNative) modChecks += 1;
    if (flowConfirmed) modChecks += 1;
    if (modChecks >= 3) {
      tier = ConfidenceLevel.Moderate;
    }
  }

  const confidenceScore =
    tier === ConfidenceLevel.High
      ? Math.min(97, Math.round(88 + Math.min(9, Math.max(0, netEdge - 3.5) * 2)))
      : tier === ConfidenceLevel.Moderate
      ? Math.min(84, Math.round(70 + Math.min(14, Math.max(0, netEdge) * 2.5)))
      : Math.max(38, Math.min(64, Math.round(45 + Math.max(0, netEdge) * 7 + (flowConfirmed ? 5 : 0))));

  const criteria = [
    {
      label: 'Écart net après spread',
      ok: netEdge >= 0,
      detail: `${netEdge >= 0 ? '+' : ''}${netEdge.toFixed(1)} pts (seuil ≥ ${thresholds.minNetEdgePp} pts)`,
    },
    {
      label: 'Volume Betfair',
      ok: bfVol >= thresholds.highBfVolume,
      detail: `${Math.round(bfVol).toLocaleString('fr-FR')} € (seuil ≥ ${Math.round(thresholds.minBfVolume).toLocaleString('fr-FR')} €, élevé ≥ ${Math.round(thresholds.highBfVolume).toLocaleString('fr-FR')} €)`,
    },
    {
      label: 'Liquidité carnet',
      ok: pmLiq >= thresholds.highPmLiquidity,
      detail: `$${Math.round(pmLiq).toLocaleString('en-US')} (seuil ≥ $${Math.round(thresholds.minPmLiquidity).toLocaleString('en-US')}, élevé ≥ $${Math.round(thresholds.highPmLiquidity).toLocaleString('en-US')})`,
    },
    {
      label: 'Spread carnet',
      ok: spreadPts !== null && spreadPts <= thresholds.highMaxSpreadPts,
      detail: `${spreadPts?.toFixed(1) ?? '—'} pts (seuil ≤ ${thresholds.maxSpreadPts.toFixed(1)} pts, élevé ≤ ${thresholds.highMaxSpreadPts.toFixed(1)} pts)`,
    },
    {
      label: 'Source Betfair',
      ok: isNative,
      detail: isNative ? 'Marché natif Arbworld' : 'Dérivé 1X2',
    },
    {
      label: 'Confirmation flux / cote',
      ok: flowConfirmed,
      detail: flowConfirmed
        ? `Confirmé (${side.bf_drop_pct != null ? `var. ${side.bf_drop_pct > 0 ? '+' : ''}${side.bf_drop_pct.toFixed(1)} %` : 'flux'})`
        : 'Pas de confirmation flux ou mouvement',
    },
  ];

  const evPct =
    direction === 'buy_pm' && pmExecPct && pmExecPct > 0
      ? round1(((side.bf_pct / pmExecPct) - 1.0) * 100.0)
      : direction === 'sell_pm' && pmExecPct !== null && 100 - pmExecPct > 0
      ? round1((((100 - side.bf_pct) / (100 - pmExecPct)) - 1.0) * 100.0)
      : null;

  // Estimation prudente de l'EV nette après friction d'exécution (commission/slippage ~2 %)
  const evNetPct = evPct !== null ? round1(evPct - 2.0) : null;
  const pmLiquidityWarning = pmLiq !== null && pmLiq < 500;

  const marketPriority = computeMarketPriority(mkt.market, side.label, direction);

  return {
    candidate: {
      market: mkt.market,
      market_short: mkt.short,
      market_label: mkt.label,
      market_priority: marketPriority,
      side_label: side.label,
      direction,
      action,
      tier,
      tier_rank: CONFIDENCE_RANK[tier],
      tier_label: CONFIDENCE_LABELS[tier],
      confidence_score: confidenceScore,
      bf_pct: side.bf_pct,
      bf_odds: side.bf_odds,
      bf_prop_pct: bfPropPct,
      bf_prop_odds: bfPropOdds,
      bf_drop_pct: side.bf_drop_pct,
      bf_volume: bfVol,
      bf_source: mkt.bf_source,
      pm_pct: side.pm_pct,
      pm_exec_pct: pmExecPct,
      pm_exec_odds: pmExecOdds,
      prop_pct: propPct,
      prop_odds: propOdds,
      pm_spread_pts: spreadPts,
      pm_liquidity: pmLiq,
      pm_liquidity_warning: pmLiquidityWarning,
      net_edge_pp: round1(netEdge),
      ev_pct: evPct,
      ev_net_pct: evNetPct,
      flow_confirmed: flowConfirmed,
      criteria,
    },
    reason: null,
  };
}

function normOutcomeCode(label) {
  const s = String(label || '').trim();
  return s === 'X' ? 'N' : s;
}

function computeMarketPriority(marketKey, sideLabel, direction) {
  const lbl = String(sideLabel || '').trim();
  const isSell = direction === 'sell_pm';

  if (
    marketKey === '1x2' ||
    marketKey === 'over-under-2-5' ||
    marketKey === 'btts'
  ) {
    return 3;
  }

  if (marketKey === 'dnb' || marketKey === 'double-chance') {
    return 2;
  }

  if (marketKey === 'over-under-1-5') {
    const wantOver = (!isSell && lbl === 'Over') || (isSell && lbl === 'Under');
    return wantOver ? 2 : 1;
  }

  if (marketKey === 'over-under-3-5') {
    const wantUnder = (!isSell && lbl === 'Under') || (isSell && lbl === 'Over');
    return wantUnder ? 2 : 1;
  }

  if (marketKey === 'half-time') {
    return 1;
  }

  return 2;
}

function getMarketFavorite(mkt) {
  const sides = Array.isArray(mkt?.sides) ? mkt.sides : [];
  let best = null;
  for (const s of sides) {
    if (typeof s.bf_pct !== 'number' || !Number.isFinite(s.bf_pct)) continue;
    if (!best || s.bf_pct > best.bf_pct) {
      best = s;
    }
  }
  if (!best) return null;
  return {
    label: best.label,
    normLabel: normOutcomeCode(best.label),
    bf_pct: best.bf_pct,
  };
}

function passesMarketGates(mkt, thresholds) {
  if (!mkt || mkt.shape === MarketShape.Multi) return false;
  if (!mkt.pm_usable) return false;
  if ((mkt.bf_volume || 0) < thresholds.minBfVolume) return false;
  if ((mkt.pm_liquidity ?? 0) < thresholds.minPmLiquidity) return false;
  if (mkt.pm_spread_pts === null || mkt.pm_spread_pts > thresholds.maxSpreadPts) return false;
  return true;
}

function tryPromoteMarketSide(mkt, targetNormLabel, thresholds, triggerEdgePp = 0) {
  if (!passesMarketGates(mkt, thresholds)) return null;
  const side = (mkt.sides || []).find(
    (s) => normOutcomeCode(s.label) === targetNormLabel
  );
  if (!side) return null;
  if (typeof side.bf_pct !== 'number' || typeof side.pm_pct !== 'number') return null;
  if (side.bf_pct < thresholds.minProbPct || side.bf_pct > thresholds.maxProbPct) return null;
  if (side.buy_edge_pp === null) return null;
  const minAcceptedBuyEdge = triggerEdgePp >= 1.5 ? -1.5 : 0.0;
  if (side.buy_edge_pp < minAcceptedBuyEdge) return null;
  if (side.bf_drop_pct !== null && side.bf_drop_pct > thresholds.maxAdverseDropPct) return null;

  const promotedThresholds = {
    ...thresholds,
    minNetEdgePp: Math.min(thresholds.minNetEdgePp, side.buy_edge_pp),
  };
  const { candidate } = evaluateSideCandidate(side, mkt, promotedThresholds, 'buy_pm', {
    promoted: true,
  });
  return candidate || null;
}

export function evaluateFixtureRecommendations(comparedFixture, nowMs = Date.now(), thresholdOverrides = null) {
  const thresholds = thresholdOverrides ? { ...STRICT_THRESHOLDS, ...thresholdOverrides } : STRICT_THRESHOLDS;
  const dt = parseKickoff(comparedFixture?.date);
  if (dt && dt.getTime() <= nowMs) {
    return {
      recommendations: [],
      top_recommendation: null,
      max_confidence: null,
      rejection_summary: 'Match déjà commencé (pré-match requis).',
    };
  }

  const recommendations = [];
  const rejections = [];
  let bestSeenNet = -999;

  for (const mkt of comparedFixture?.markets || []) {
    if (mkt.shape === MarketShape.Multi) {
      rejections.push(`${mkt.short} : marché multi-issues exclu`);
      continue;
    }
    if (!mkt.pm_usable) {
      rejections.push(`${mkt.short} : ${mkt.pm_quality_reason || 'carnet PM inutilisable'}`);
      continue;
    }
    if ((mkt.bf_volume || 0) < thresholds.minBfVolume) {
      rejections.push(
        `${mkt.short} : volume BF ${Math.round(mkt.bf_volume || 0)} € < ${thresholds.minBfVolume} €`
      );
      continue;
    }
    if ((mkt.pm_liquidity ?? 0) < thresholds.minPmLiquidity) {
      rejections.push(
        `${mkt.short} : liquidité PM $${Math.round(mkt.pm_liquidity ?? 0)} < $${thresholds.minPmLiquidity}`
      );
      continue;
    }
    if (mkt.pm_spread_pts === null || mkt.pm_spread_pts > thresholds.maxSpreadPts) {
      rejections.push(
        `${mkt.short} : spread PM ${mkt.pm_spread_pts?.toFixed(1) ?? '—'} pts > ${thresholds.maxSpreadPts} pts`
      );
      continue;
    }

    let bestForMarket = null;
    let sideRejection = null;

    for (const side of mkt.sides || []) {
      const sideMaxNet = Math.max(side.buy_edge_pp ?? -999, side.sell_edge_pp ?? -999);
      if (sideMaxNet > bestSeenNet) bestSeenNet = sideMaxNet;

      const { candidate, reason } = evaluateSideCandidate(side, mkt, thresholds);
      if (candidate) {
        if (
          !bestForMarket ||
          candidate.tier_rank > bestForMarket.tier_rank ||
          (candidate.tier_rank === bestForMarket.tier_rank &&
            candidate.net_edge_pp > bestForMarket.net_edge_pp)
        ) {
          bestForMarket = candidate;
        }
      } else if (reason) {
        sideRejection = `${mkt.short} (${side.label}) : ${reason}`;
      }
    }

    if (bestForMarket) {
      recommendations.push(bestForMarket);
    } else if (sideRejection) {
      rejections.push(sideRejection);
    }
  }

  // Adapter l'ordre et la priorité quand un favori fin de match est aussi favori mi-temps
  // (ainsi que pour les lignes standards de buts vs lignes extrêmes).
  const byMarket = new Map((comparedFixture?.markets || []).map((m) => [m.market, m]));
  const allByMarket = new Map([
    ...(comparedFixture?.bf_only_markets || []).map((m) => [m.market, m]),
    ...(comparedFixture?.markets || []).map((m) => [m.market, m]),
  ]);

  const fav1x2 = getMarketFavorite(allByMarket.get('1x2'));
  const favHt = getMarketFavorite(allByMarket.get('half-time'));
  const htReco = recommendations.find((r) => r.market === 'half-time');

  if (
    htReco &&
    htReco.direction === 'buy_pm' &&
    fav1x2 &&
    favHt &&
    fav1x2.normLabel === favHt.normLabel &&
    normOutcomeCode(htReco.side_label) === fav1x2.normLabel
  ) {
    htReco.secondary_of = '1x2';
    const has1x2 = recommendations.some((r) => r.market === '1x2');
    if (!has1x2 && thresholds.minNetEdgePp <= 0.5) {
      const promoted = tryPromoteMarketSide(
        byMarket.get('1x2'),
        fav1x2.normLabel,
        thresholds,
        htReco.net_edge_pp ?? 0
      );
      if (promoted) {
        recommendations.push(promoted);
      }
    }
  }

  // Adapter les lignes de buts : Plus/Moins 2.5 buts avant les lignes extrêmes (+3.5 / -1.5)
  const fav25 = getMarketFavorite(allByMarket.get('over-under-2-5'));
  const ou35Reco = recommendations.find((r) => r.market === 'over-under-3-5');
  if (
    ou35Reco &&
    ((ou35Reco.direction === 'buy_pm' && ou35Reco.side_label === 'Over') ||
      (ou35Reco.direction === 'sell_pm' && ou35Reco.side_label === 'Under')) &&
    fav25 &&
    fav25.normLabel === 'Over'
  ) {
    ou35Reco.secondary_of = 'over-under-2-5';
    if (!recommendations.some((r) => r.market === 'over-under-2-5') && thresholds.minNetEdgePp <= 0.5) {
      const promoted = tryPromoteMarketSide(
        byMarket.get('over-under-2-5'),
        'Over',
        thresholds,
        ou35Reco.net_edge_pp ?? 0
      );
      if (promoted) recommendations.push(promoted);
    }
  }

  const ou15Reco = recommendations.find((r) => r.market === 'over-under-1-5');
  if (
    ou15Reco &&
    ((ou15Reco.direction === 'buy_pm' && ou15Reco.side_label === 'Under') ||
      (ou15Reco.direction === 'sell_pm' && ou15Reco.side_label === 'Over')) &&
    fav25 &&
    fav25.normLabel === 'Under'
  ) {
    ou15Reco.secondary_of = 'over-under-2-5';
    if (!recommendations.some((r) => r.market === 'over-under-2-5') && thresholds.minNetEdgePp <= 0.5) {
      const promoted = tryPromoteMarketSide(
        byMarket.get('over-under-2-5'),
        'Under',
        thresholds,
        ou15Reco.net_edge_pp ?? 0
      );
      if (promoted) recommendations.push(promoted);
    }
  }

  recommendations.sort(
    (a, b) =>
      (b.market_priority || 1) - (a.market_priority || 1) ||
      b.tier_rank - a.tier_rank ||
      b.net_edge_pp - a.net_edge_pp ||
      b.bf_volume - a.bf_volume
  );

  recommendations.forEach((rec, idx) => {
    rec.proposal_rank = idx + 1;
  });

  let rejectionSummary = null;
  if (recommendations.length === 0) {
    if (rejections.length > 0) {
      rejectionSummary = rejections[0];
    } else if (bestSeenNet > -999) {
      rejectionSummary = `Écart net max ${bestSeenNet >= 0 ? '+' : ''}${bestSeenNet.toFixed(
        1
      )} pts (< ${thresholds.minNetEdgePp} pts requis).`;
    } else {
      rejectionSummary = 'Aucun côté éligible sur carnet Polymarket.';
    }
  }

  return {
    recommendations,
    top_recommendation: recommendations[0] || null,
    max_confidence: recommendations[0]?.tier || null,
    rejection_summary: rejectionSummary,
    thresholds,
  };
}
