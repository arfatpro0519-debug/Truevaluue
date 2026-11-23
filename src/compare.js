// Croisement factuel Arbworld (Betfair) × Polymarket : écarts bruts, carnet et microstructure.

import { mapWithConcurrency } from './async.js';
import { enrich, fixtureKey, parseKickoff, round1, round2 } from './enrich.js';
import { ALL_MARKETS, MarketKey, MarketShape, marketDef } from './market.js';
import {
  CONFIDENCE_RANK,
  DEFAULT_PROPOSAL_PRESET,
  evaluateFixtureRecommendations,
  PROPOSAL_PRESETS,
  resolveProposalThresholds,
} from './recommend.js';

const DEFAULT_MAX_FIXTURES = 28;
const HORIZON_PAST_HOURS = 2;
const HORIZON_FUTURE_HOURS = 72;

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function probToPts(p) {
  return p !== null ? round1(p * 100.0) : null;
}

function computeExecEdges(bfPct, pmBid, pmAsk) {
  if (bfPct === null) {
    return { buy_edge_pp: null, sell_edge_pp: null };
  }
  const askPts = pmAsk !== null ? round1(pmAsk * 100.0) : null;
  const bidPts = pmBid !== null ? round1(pmBid * 100.0) : null;
  return {
    buy_edge_pp: askPts !== null ? round1(bfPct - askPts) : null,
    sell_edge_pp: bidPts !== null ? round1(bidPts - bfPct) : null,
  };
}

function derivedDoubleChanceFrom1x2(row1x2) {
  if (!row1x2) return null;
  const p1 = numOrNull(row1x2.implied?.[0]);
  const pN = numOrNull(row1x2.implied?.[1]);
  const p2 = numOrNull(row1x2.implied?.[2]);
  if (p1 === null || pN === null || p2 === null) return null;
  return {
    source: 'derived_1x2',
    total_volume: row1x2.total_volume || 0,
    sides: {
      '1X': { bf_pct: round1(p1 + pN), bf_odds: null, bf_open_odds: null, bf_drop_pct: null, bf_volume: null, bf_share_pct: null },
      X2: { bf_pct: round1(pN + p2), bf_odds: null, bf_open_odds: null, bf_drop_pct: null, bf_volume: null, bf_share_pct: null },
      '12': { bf_pct: round1(p1 + p2), bf_odds: null, bf_open_odds: null, bf_drop_pct: null, bf_volume: null, bf_share_pct: null },
    },
  };
}

function derivedDnbFrom1x2(row1x2) {
  if (!row1x2) return null;
  const p1 = numOrNull(row1x2.implied?.[0]);
  const p2 = numOrNull(row1x2.implied?.[2]);
  if (p1 === null || p2 === null || p1 + p2 <= 0) return null;
  const sum = p1 + p2;
  return {
    source: 'derived_1x2',
    total_volume: row1x2.total_volume || 0,
    sides: {
      '1': { bf_pct: round1((p1 / sum) * 100.0), bf_odds: null, bf_open_odds: null, bf_drop_pct: null, bf_volume: null, bf_share_pct: null },
      '2': { bf_pct: round1((p2 / sum) * 100.0), bf_odds: null, bf_open_odds: null, bf_drop_pct: null, bf_volume: null, bf_share_pct: null },
    },
  };
}

function nativeSidesMap(marketKey, bfRow) {
  if (!bfRow) return null;
  const map = {};
  if (marketKey === MarketKey.OneXTwo || marketKey === MarketKey.HalfTime) {
    const codes = ['1', 'N', '2'];
    for (let i = 0; i < 3; i++) {
      map[codes[i]] = {
        bf_pct: numOrNull(bfRow.implied?.[i]),
        bf_odds: numOrNull(bfRow.coef_new?.[i]) || null,
        bf_open_odds: numOrNull(bfRow.coef?.[i]) || null,
        bf_drop_pct: numOrNull(bfRow.drop?.[i]),
        bf_volume: numOrNull(bfRow.volume?.[i]),
        bf_share_pct: numOrNull(bfRow.share?.[i]),
      };
    }
  } else if (marketKey === MarketKey.DoubleChance) {
    const codes = ['1X', 'X2', '12'];
    for (let i = 0; i < 3; i++) {
      map[codes[i]] = {
        bf_pct: numOrNull(bfRow.implied?.[i]),
        bf_odds: numOrNull(bfRow.coef_new?.[i]) || null,
        bf_open_odds: numOrNull(bfRow.coef?.[i]) || null,
        bf_drop_pct: numOrNull(bfRow.drop?.[i]),
        bf_volume: numOrNull(bfRow.volume?.[i]),
        bf_share_pct: numOrNull(bfRow.share?.[i]),
      };
    }
  } else if (marketKey === MarketKey.DrawNoBet) {
    const slots = [
      ['1', 0],
      ['2', 2],
    ];
    for (const [code, i] of slots) {
      map[code] = {
        bf_pct: numOrNull(bfRow.implied?.[i]),
        bf_odds: numOrNull(bfRow.coef_new?.[i]) || null,
        bf_open_odds: numOrNull(bfRow.coef?.[i]) || null,
        bf_drop_pct: numOrNull(bfRow.drop?.[i]),
        bf_volume: numOrNull(bfRow.volume?.[i]),
        bf_share_pct: numOrNull(bfRow.share?.[i]),
      };
    }
  } else if (
    marketKey === MarketKey.OverUnder15 ||
    marketKey === MarketKey.OverUnder25 ||
    marketKey === MarketKey.OverUnder35
  ) {
    const slots = [
      ['Under', 0],
      ['Over', 2],
    ];
    for (const [code, i] of slots) {
      map[code] = {
        bf_pct: numOrNull(bfRow.implied?.[i]),
        bf_odds: numOrNull(bfRow.coef_new?.[i]) || null,
        bf_open_odds: numOrNull(bfRow.coef?.[i]) || null,
        bf_drop_pct: numOrNull(bfRow.drop?.[i]),
        bf_volume: numOrNull(bfRow.volume?.[i]),
        bf_share_pct: numOrNull(bfRow.share?.[i]),
      };
    }
  } else if (marketKey === MarketKey.Btts) {
    const slots = [
      ['Oui', 0],
      ['Non', 2],
    ];
    for (const [code, i] of slots) {
      map[code] = {
        bf_pct: numOrNull(bfRow.implied?.[i]),
        bf_odds: numOrNull(bfRow.coef_new?.[i]) || null,
        bf_open_odds: numOrNull(bfRow.coef?.[i]) || null,
        bf_drop_pct: numOrNull(bfRow.drop?.[i]),
        bf_volume: numOrNull(bfRow.volume?.[i]),
        bf_share_pct: numOrNull(bfRow.share?.[i]),
      };
    }
  }
  return {
    source: 'native',
    total_volume: bfRow.total_volume || 0,
    sides: map,
  };
}

function buildMultiComparison(marketKey, bfRow, pmMarket) {
  const def = marketDef(marketKey);
  const bfOutcomes = Array.isArray(bfRow?.outcomes) ? bfRow.outcomes : [];
  const pmOutcomes = Array.isArray(pmMarket?.outcomes) ? pmMarket.outcomes : [];

  const byLabel = new Map();
  for (const o of bfOutcomes) {
    const norm = o.label.replace(/\s+/g, '');
    byLabel.set(norm, {
      label: o.label,
      bf_odds: o.coef_new ?? o.coef ?? null,
      bf_open_odds: o.coef ?? null,
      bf_drop_pct:
        o.coef && o.coef_new
          ? round1(((o.coef_new - o.coef) / o.coef) * 100.0)
          : null,
      bf_volume: o.volume ?? null,
      bf_share_pct: o.pct ?? null,
      bf_pct: o.coef_new ? round1(100.0 / o.coef_new) : null,
      bf_source: 'native',
      pm_pct: null,
      pm_raw_pct: null,
      pm_bid: null,
      pm_ask: null,
      pm_spread_pts: null,
      pm_volume: null,
      pm_liquidity: null,
      pm_change_1d: null,
      gap_pp: null,
      abs_gap_pp: null,
      buy_edge_pp: null,
      sell_edge_pp: null,
    });
  }

  for (const o of pmOutcomes) {
    const norm = String(o.label || '').replace(/\s+/g, '');
    const existing = byLabel.get(norm) || {
      label: o.label,
      bf_odds: null,
      bf_open_odds: null,
      bf_drop_pct: null,
      bf_volume: null,
      bf_share_pct: null,
      bf_pct: null,
      bf_source: null,
    };
    const pmBid = numOrNull(o.bid);
    const pmAsk = numOrNull(o.ask);
    const pmSpreadPts =
      numOrNull(o.spread) !== null
        ? probToPts(o.spread)
        : pmBid !== null && pmAsk !== null && pmAsk >= pmBid
        ? round1((pmAsk - pmBid) * 100.0)
        : null;
    const pmPct = numOrNull(o.novig_pct) ?? probToPts(numOrNull(o.price));
    const gap =
      existing.bf_pct !== null && pmPct !== null
        ? round1(pmPct - existing.bf_pct)
        : null;
    const edges = computeExecEdges(existing.bf_pct, pmBid, pmAsk);

    byLabel.set(norm, {
      ...existing,
      pm_pct: pmPct,
      pm_raw_pct: probToPts(numOrNull(o.price)),
      pm_bid: pmBid,
      pm_ask: pmAsk,
      pm_spread_pts: pmSpreadPts,
      pm_volume: numOrNull(o.volume),
      pm_liquidity: numOrNull(o.liquidity),
      pm_change_1d: numOrNull(o.change_1d),
      gap_pp: gap,
      abs_gap_pp: gap !== null ? round1(Math.abs(gap)) : null,
      buy_edge_pp: edges.buy_edge_pp,
      sell_edge_pp: edges.sell_edge_pp,
    });
  }

  const sides = [...byLabel.values()]
    .sort(
      (a, b) =>
        (b.pm_pct ?? 0) - (a.pm_pct ?? 0) ||
        (b.bf_pct ?? 0) - (a.bf_pct ?? 0) ||
        (b.bf_share_pct ?? 0) - (a.bf_share_pct ?? 0)
    )
    .slice(0, 8);

  const maxGap = sides.reduce(
    (acc, s) => (s.abs_gap_pp !== null && s.abs_gap_pp > acc ? s.abs_gap_pp : acc),
    0
  );
  const maxExecEdge = pmMarket?.usable
    ? sides.reduce((acc, s) => {
        const net = Math.max(s.buy_edge_pp ?? -99, s.sell_edge_pp ?? -99);
        return net > acc ? net : acc;
      }, 0)
    : 0;

  return {
    market: marketKey,
    label: def.label,
    short: def.short,
    shape: def.shape,
    bf_source: bfRow ? 'native' : null,
    bf_volume: bfRow?.total_volume ?? 0,
    pm_liquidity: numOrNull(pmMarket?.liquidity),
    pm_volume: numOrNull(pmMarket?.volume),
    pm_volume_24h: numOrNull(pmMarket?.volume_24h),
    pm_spread_pts: probToPts(numOrNull(pmMarket?.spread)),
    pm_usable: Boolean(pmMarket?.usable),
    pm_quality_reason: pmMarket?.quality_reason || null,
    max_abs_gap_pp: round1(maxGap),
    max_exec_edge_pp: round1(maxExecEdge),
    observations: [],
    sides,
  };
}

function buildStructuredComparison(marketKey, bfInfo, pmMarket) {
  const def = marketDef(marketKey);
  const pmOutcomes = Array.isArray(pmMarket?.outcomes) ? pmMarket.outcomes : [];
  const labelOrder = Object.keys(bfInfo?.sides || {});
  for (const o of pmOutcomes) {
    if (!labelOrder.includes(o.label)) labelOrder.push(o.label);
  }

  const sides = [];
  for (const label of labelOrder) {
    const bf = bfInfo?.sides?.[label] || null;
    const pm = pmOutcomes.find((o) => o.label === label) || null;
    const bfPct = bf?.bf_pct ?? null;
    const pmPct = numOrNull(pm?.novig_pct) ?? probToPts(numOrNull(pm?.price));
    const pmBid = numOrNull(pm?.bid);
    const pmAsk = numOrNull(pm?.ask);
    const pmSpreadPts =
      numOrNull(pm?.spread) !== null
        ? probToPts(pm.spread)
        : pmBid !== null && pmAsk !== null && pmAsk >= pmBid
        ? round1((pmAsk - pmBid) * 100.0)
        : probToPts(numOrNull(pmMarket?.spread));
    const gap = bfPct !== null && pmPct !== null ? round1(pmPct - bfPct) : null;
    const edges = computeExecEdges(bfPct, pmBid, pmAsk);

    sides.push({
      label,
      bf_odds: bf?.bf_odds ?? null,
      bf_open_odds: bf?.bf_open_odds ?? null,
      bf_drop_pct: bf?.bf_drop_pct ?? null,
      bf_volume: bf?.bf_volume ?? null,
      bf_share_pct: bf?.bf_share_pct ?? null,
      bf_pct: bfPct,
      bf_source: bf ? bfInfo.source : null,
      pm_pct: pmPct,
      pm_raw_pct: probToPts(numOrNull(pm?.price)),
      pm_bid: pmBid,
      pm_ask: pmAsk,
      pm_spread_pts: pmSpreadPts,
      pm_volume: numOrNull(pm?.volume),
      pm_liquidity: numOrNull(pm?.liquidity),
      pm_change_1d: numOrNull(pm?.change_1d),
      gap_pp: gap,
      abs_gap_pp: gap !== null ? round1(Math.abs(gap)) : null,
      buy_edge_pp: edges.buy_edge_pp,
      sell_edge_pp: edges.sell_edge_pp,
    });
  }

  const observations = [];
  const seenObs = new Set();
  const addObs = (type, label, detail) => {
    if (seenObs.has(type)) return;
    seenObs.add(type);
    observations.push({ type, label, detail });
  };

  const bfTotalVol = bfInfo?.total_volume ?? 0;
  const pmLiq = numOrNull(pmMarket?.liquidity) ?? numOrNull(pmMarket?.volume) ?? 0;
  const mktSpreadPts = probToPts(numOrNull(pmMarket?.spread));

  for (const s of sides) {
    if (
      s.bf_drop_pct !== null &&
      s.bf_drop_pct <= -4.0 &&
      (s.bf_share_pct ?? 0) >= 45.0 &&
      s.gap_pp !== null &&
      s.gap_pp <= -2.5
    ) {
      addObs(
        'lag_pm',
        `Retard PM (${s.label})`,
        `Cote Betfair ${s.bf_drop_pct.toFixed(1)} % avec ${s.bf_share_pct?.toFixed(0) ?? '—'} % du volume, PM encore ${Math.abs(s.gap_pp).toFixed(1)} pts en dessous.`
      );
    }

    if (
      (s.bf_share_pct ?? 0) >= 65.0 &&
      bfTotalVol >= 3000 &&
      s.bf_drop_pct !== null &&
      s.bf_drop_pct >= 0.0 &&
      s.gap_pp !== null &&
      s.gap_pp <= -3.0
    ) {
      addObs(
        'flow_divergence',
        `Flux concentré sans baisse (${s.label})`,
        `${s.bf_share_pct.toFixed(0)} % du volume Betfair sur ${s.label} sans baisse de cote, PM cote ${Math.abs(s.gap_pp).toFixed(1)} pts plus bas.`
      );
    }

    if (
      s.pm_change_1d !== null &&
      Math.abs(s.pm_change_1d) >= 0.03 &&
      s.abs_gap_pp !== null &&
      s.abs_gap_pp >= 3.0
    ) {
      addObs(
        'pm_move',
        `Mouvement PM 24h (${s.label})`,
        `Variation PM ${(s.pm_change_1d * 100).toFixed(1)} pts sur 24h, écart actuel ${s.gap_pp > 0 ? '+' : ''}${s.gap_pp.toFixed(1)} pts vs BF.`
      );
    }

    const bestNet = Math.max(s.buy_edge_pp ?? -99, s.sell_edge_pp ?? -99);
    if (pmMarket?.usable && bestNet >= 2.0 && pmLiq >= 250 && bfTotalVol >= 500) {
      addObs(
        'net_discrepancy',
        `Écart net après spread (${s.label})`,
        `Écart exécutable de ${bestNet.toFixed(1)} pts sur carnet Polymarket (${s.pm_bid?.toFixed(2) ?? '—'} / ${s.pm_ask?.toFixed(2) ?? '—'}).`
      );
    }
  }

  const maxAbsGap = sides.reduce(
    (acc, s) => (s.abs_gap_pp !== null && s.abs_gap_pp > acc ? s.abs_gap_pp : acc),
    0
  );
  const maxExecEdge = sides.reduce((acc, s) => {
    const net = Math.max(s.buy_edge_pp ?? -99, s.sell_edge_pp ?? -99);
    return net > acc ? net : acc;
  }, 0);

  return {
    market: marketKey,
    label: def.label,
    short: def.short,
    shape: def.shape,
    bf_source: bfInfo?.source || null,
    bf_volume: bfTotalVol,
    pm_liquidity: numOrNull(pmMarket?.liquidity),
    pm_volume: numOrNull(pmMarket?.volume),
    pm_volume_24h: numOrNull(pmMarket?.volume_24h),
    pm_spread_pts: mktSpreadPts,
    pm_usable: Boolean(pmMarket?.usable),
    pm_quality_reason: pmMarket?.quality_reason || null,
    max_abs_gap_pp: round1(maxAbsGap),
    max_exec_edge_pp: round1(maxExecEdge),
    observations,
    sides,
  };
}

function buildCrossChecks(bfMarkets, pmMarkets) {
  const checks = [];
  const bf1x2 = bfMarkets[MarketKey.OneXTwo];
  const pmDc = pmMarkets?.[MarketKey.DoubleChance];
  if (bf1x2 && pmDc?.outcomes?.length) {
    const p1 = numOrNull(bf1x2.implied?.[0]);
    const pN = numOrNull(bf1x2.implied?.[1]);
    const p2 = numOrNull(bf1x2.implied?.[2]);
    if (p1 !== null && pN !== null && p2 !== null) {
      const bfDc = {
        '1X': round1(p1 + pN),
        X2: round1(pN + p2),
        '12': round1(p1 + p2),
      };
      for (const code of ['1X', 'X2', '12']) {
        const pmOut = pmDc.outcomes.find((o) => o.label === code);
        const pmPct = numOrNull(pmOut?.novig_pct);
        if (pmPct !== null) {
          const gap = round1(pmPct - bfDc[code]);
          if (Math.abs(gap) >= 2.5) {
            checks.push({
              pair: `1X2 (BF) vs Double chance ${code} (PM)`,
              bf_pct: bfDc[code],
              pm_pct: pmPct,
              gap_pp: gap,
            });
          }
        }
      }
    }
  }
  return checks;
}

function buildBfOnlyMarketSummary(marketKey, bfRow) {
  const def = marketDef(marketKey);
  if (def.shape === MarketShape.Multi) {
    const sides = (Array.isArray(bfRow.outcomes) ? bfRow.outcomes : [])
      .slice(0, 6)
      .map((o) => ({
        label: o.label,
        bf_odds: o.coef_new ?? o.coef ?? null,
        bf_open_odds: o.coef ?? null,
        bf_drop_pct:
          o.coef && o.coef_new
            ? round1(((o.coef_new - o.coef) / o.coef) * 100.0)
            : null,
        bf_volume: o.volume ?? null,
        bf_share_pct: o.pct ?? null,
        bf_pct: o.coef_new ? round1(100.0 / o.coef_new) : null,
      }));
    return {
      market: marketKey,
      label: def.label,
      short: def.short,
      shape: def.shape,
      bf_volume: bfRow.total_volume || 0,
      sides,
    };
  }
  const info = nativeSidesMap(marketKey, bfRow);
  const sides = Object.entries(info?.sides || {}).map(([label, s]) => ({
    label,
    ...s,
  }));
  return {
    market: marketKey,
    label: def.label,
    short: def.short,
    shape: def.shape,
    bf_volume: bfRow.total_volume || 0,
    sides,
  };
}

export function compareFixture(
  fixture,
  quote,
  { nowMs = Date.now(), thresholdOverrides = null } = {}
) {
  const pmMarkets = quote?.markets || {};
  const bf1x2 = fixture.bf_markets[MarketKey.OneXTwo] || null;
  const comparisons = [];

  for (const marketKey of ALL_MARKETS) {
    const bfRow = fixture.bf_markets[marketKey] || null;
    const pmMkt = pmMarkets[marketKey] || null;
    if (!pmMkt) continue;

    if (marketDef(marketKey).shape === MarketShape.Multi) {
      comparisons.push(buildMultiComparison(marketKey, bfRow, pmMkt));
      continue;
    }

    let bfInfo = bfRow ? nativeSidesMap(marketKey, bfRow) : null;
    if (!bfInfo && marketKey === MarketKey.DoubleChance) {
      bfInfo = derivedDoubleChanceFrom1x2(bf1x2);
    } else if (!bfInfo && marketKey === MarketKey.DrawNoBet) {
      bfInfo = derivedDnbFrom1x2(bf1x2);
    }
    if (!bfInfo) continue;

    comparisons.push(buildStructuredComparison(marketKey, bfInfo, pmMkt));
  }

  const matchedSet = new Set(comparisons.map((c) => c.market));
  const bfOnlyMarkets = [];
  const availableMarkets = [];

  for (const marketKey of ALL_MARKETS) {
    const def = marketDef(marketKey);
    const bfRow = fixture.bf_markets[marketKey] || null;
    const isMatched = matchedSet.has(marketKey);
    if (bfRow && !isMatched) {
      bfOnlyMarkets.push(buildBfOnlyMarketSummary(marketKey, bfRow));
    }
    if (isMatched || bfRow) {
      availableMarkets.push({
        market: marketKey,
        short: def.short,
        label: def.label,
        compared: isMatched,
      });
    }
  }

  const maxAbsGap = comparisons.reduce(
    (acc, c) => (c.max_abs_gap_pp > acc ? c.max_abs_gap_pp : acc),
    0
  );
  const maxExecEdge = comparisons.reduce(
    (acc, c) => (c.max_exec_edge_pp > acc ? c.max_exec_edge_pp : acc),
    0
  );
  const allObservations = comparisons.flatMap((c) => c.observations);
  const crossChecks = buildCrossChecks(fixture.bf_markets, pmMarkets);

  const base = {
    fixture_key: fixture.fixture_key,
    home: fixture.home,
    away: fixture.away,
    league: fixture.league,
    country: fixture.country,
    date: fixture.date,
    date_label: fixture.date_label,
    total_volume_bf: round2(fixture.total_volume_bf),
    pm_slug: quote?.slug || null,
    pm_url: quote?.url || null,
    pm_title: quote?.title || null,
    pm_volume: numOrNull(quote?.volume),
    pm_volume_24h: numOrNull(quote?.volume_24h),
    pm_liquidity: numOrNull(quote?.liquidity),
    matched_markets_count: comparisons.length,
    total_markets_count: availableMarkets.length,
    is_multi_market: availableMarkets.length > 1,
    available_markets: availableMarkets,
    max_abs_gap_pp: round1(maxAbsGap),
    max_exec_edge_pp: round1(maxExecEdge),
    observations: allObservations,
    cross_checks: crossChecks,
    markets: comparisons,
    bf_only_markets: bfOnlyMarkets,
  };

  const recoInfo = evaluateFixtureRecommendations(base, nowMs, thresholdOverrides);
  return {
    ...base,
    ...recoInfo,
  };
}

export async function buildComparison({
  scraper,
  polymarket,
  force = false,
  maxFixtures = DEFAULT_MAX_FIXTURES,
  markets = ALL_MARKETS,
  preset = DEFAULT_PROPOSAL_PRESET,
  thresholdOverrides = null,
} = {}) {
  const basePreset = PROPOSAL_PRESETS[preset] || PROPOSAL_PRESETS[DEFAULT_PROPOSAL_PRESET];
  const resolvedThresholds = resolveProposalThresholds(basePreset.key, thresholdOverrides);
  const warnings = [];
  const settledArb = await mapWithConcurrency(markets, 3, async (key) => {
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

  const nowMs = Date.now();
  const allFixtures = [...byFixture.values()];
  const activeFixtures = allFixtures.filter((f) => {
    const dt = parseKickoff(f.date);
    if (!dt) return true;
    const diffHours = (dt.getTime() - nowMs) / 3_600_000;
    return diffHours >= -HORIZON_PAST_HOURS && diffHours <= HORIZON_FUTURE_HOURS;
  });

  const candidates = (activeFixtures.length > 0 ? activeFixtures : allFixtures)
    .sort((a, b) => b.total_volume_bf - a.total_volume_bf)
    .slice(0, Math.min(40, Math.max(1, maxFixtures)));

  const matchedRows = [];
  let pmErrors = 0;

  await mapWithConcurrency(candidates, 4, async (fixture) => {
    const kickoffAt = parseKickoff(fixture.date);
    const meta = { error: null };
    const quote = await polymarket.quote(
      fixture.fixture_key,
      fixture.home,
      fixture.away,
      kickoffAt,
      { force, meta }
    );
    if (meta.error) pmErrors += 1;
    if (!quote || Object.keys(quote.markets || {}).length === 0) return;

    const compared = compareFixture(fixture, quote, {
      thresholdOverrides: resolvedThresholds,
    });
    if (compared.markets.length > 0) {
      matchedRows.push(compared);
    }
  });

  if (pmErrors > 0) {
    warnings.push(`${pmErrors} requête(s) Polymarket en erreur.`);
  }

  matchedRows.sort(
    (a, b) =>
      (CONFIDENCE_RANK[b.max_confidence] || 0) - (CONFIDENCE_RANK[a.max_confidence] || 0) ||
      b.max_exec_edge_pp - a.max_exec_edge_pp ||
      b.max_abs_gap_pp - a.max_abs_gap_pp ||
      b.total_volume_bf - a.total_volume_bf
  );

  const recommendationsSummary = {
    total: 0,
    high: 0,
    moderate: 0,
    low: 0,
  };
  for (const r of matchedRows) {
    for (const reco of r.recommendations || []) {
      recommendationsSummary.total += 1;
      if (reco.tier === 'high') recommendationsSummary.high += 1;
      else if (reco.tier === 'moderate') recommendationsSummary.moderate += 1;
      else if (reco.tier === 'low') recommendationsSummary.low += 1;
    }
  }

  return {
    generated_at: new Date().toISOString(),
    preset: basePreset.key,
    preset_label: basePreset.label,
    thresholds: resolvedThresholds,
    count_arbworld: allFixtures.length,
    count_candidates: candidates.length,
    count_matched: matchedRows.length,
    recommendations_summary: recommendationsSummary,
    warnings,
    rows: matchedRows,
  };
}
