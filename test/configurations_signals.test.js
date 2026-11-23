import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server.js';
import { CalibrationStore } from '../src/calibration.js';
import {
  ALL_72_SIGNATURES,
  analyzeFixtureConfiguration,
  buildConfigurationsFromData,
  buildSignalsFromData,
  deriveGoalsProfile,
  IntensityLevel,
  VariationClass,
} from '../src/configurations.js';
import { MarketKey } from '../src/market.js';

function makeTempObsPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cfg-'));
  return { dir, file: path.join(dir, 'observations.json') };
}

function makeOuSnap(fav, pmFav = null) {
  return {
    source_bf: true,
    favorite: fav,
    pm_favorite: pmFav,
  };
}

test('ALL_72_SIGNATURES has 72 unique directional signatures and deriveGoalsProfile classifies G1..G4, Incomplet, and Atypique honestly', () => {
  assert.equal(ALL_72_SIGNATURES.length, 72);
  assert.equal(new Set(ALL_72_SIGNATURES.map((s) => s.code)).size, 72);

  assert.equal(
    deriveGoalsProfile(makeOuSnap('Under'), makeOuSnap('Under'), makeOuSnap('Under')).profile,
    'G1'
  );
  assert.equal(
    deriveGoalsProfile(makeOuSnap('Over'), makeOuSnap('Under'), makeOuSnap('Under')).profile,
    'G2'
  );
  assert.equal(
    deriveGoalsProfile(makeOuSnap('Over'), makeOuSnap('Over'), makeOuSnap('Under')).profile,
    'G3'
  );
  assert.equal(
    deriveGoalsProfile(makeOuSnap('Over'), makeOuSnap('Over'), makeOuSnap('Over')).profile,
    'G4'
  );

  const incomp = deriveGoalsProfile(makeOuSnap('Over'), makeOuSnap('Under'), null);
  assert.equal(incomp.profile, null);
  assert.equal(incomp.status, 'incomplet');
  assert.equal(incomp.lines_present, 2);

  const atyp = deriveGoalsProfile(makeOuSnap('Under'), makeOuSnap('Over'), makeOuSnap('Under'));
  assert.equal(atyp.profile, 'Atypique');
  assert.equal(atyp.status, 'atypique');
});

test('analyzeFixtureConfiguration keeps missing blocks as ? and computes 4 axes with configurable thresholds', () => {
  const nowMs = Date.parse('2026-11-22T12:00:00Z');
  const futureDate = '2026-11-25T19:00:00Z';

  // Complete fixture with a Betfair favorite flip (Retournement) + BTTS vs G1 contradiction + BFxPM split
  const fixture = {
    fixture_key: 'team_a_vs_team_b',
    home: 'Team A',
    away: 'Team B',
    league: 'Ligue 1',
    country: 'fra',
    date: futureDate,
    date_label: '25 nov. 19:00',
    total_volume_bf: 18500,
    bf_markets: {
      [MarketKey.OneXTwo]: {
        market: MarketKey.OneXTwo,
        total_volume: 10000,
        implied: [42.0, 26.0, 32.0],
        coef: [2.05, 3.6, 3.3], // Open fav was '1' (48.8% vs 30.3%)
        coef_new: [2.35, 3.6, 2.9], // Now '1' dropped? Let's test explicit favorite flip: open fav 2 -> curr fav 1
        drop: [14.6, 0.0, -12.1],
        volume: [5000, 2000, 3000],
        share: [50, 20, 30],
      },
      [MarketKey.Btts]: {
        market: MarketKey.Btts,
        total_volume: 2500,
        implied: [60.0, 0, 40.0],
        coef: [1.68, 0, 2.5],
        coef_new: [1.66, 0, 2.52],
        drop: [-1.2, 0, 0.8],
        volume: [1800, 0, 700],
        share: [72, 0, 28],
      },
      [MarketKey.HalfTime]: {
        market: MarketKey.HalfTime,
        total_volume: 2000,
        implied: [20.0, 34.0, 46.0], // HT favors 2 while FT favors 1 -> contradiction
        coef: [4.8, 2.8, 2.1],
        coef_new: [4.8, 2.8, 2.1],
        drop: [0, 0, 0],
        volume: [400, 600, 1000],
        share: [20, 30, 50],
      },
      [MarketKey.OverUnder15]: {
        market: MarketKey.OverUnder15,
        total_volume: 1500,
        implied: [62.0, 0, 38.0], // Under 1.5 favored
        coef: [1.6, 0, 2.6],
        coef_new: [1.6, 0, 2.6],
        drop: [0, 0, 0],
        volume: [1000, 0, 500],
        share: [66.7, 0, 33.3],
      },
      [MarketKey.OverUnder25]: {
        market: MarketKey.OverUnder25,
        total_volume: 1500,
        implied: [65.0, 0, 35.0], // Under 2.5
        coef: [1.52, 0, 2.8],
        coef_new: [1.52, 0, 2.8],
        drop: [0, 0, 0],
        volume: [1100, 0, 400],
        share: [73.3, 0, 26.7],
      },
      [MarketKey.OverUnder35]: {
        market: MarketKey.OverUnder35,
        total_volume: 1000,
        implied: [78.0, 0, 22.0], // Under 3.5 -> G1
        coef: [1.27, 0, 4.4],
        coef_new: [1.27, 0, 4.4],
        drop: [0, 0, 0],
        volume: [800, 0, 200],
        share: [80, 0, 20],
      },
    },
  };
  // Set clean favorite flip in 1X2: open coef [3.1, 3.5, 2.1] -> curr coef_new [2.1, 3.5, 3.1]
  fixture.bf_markets[MarketKey.OneXTwo].coef = [3.1, 3.5, 2.1];
  fixture.bf_markets[MarketKey.OneXTwo].coef_new = [2.1, 3.5, 3.1];
  fixture.bf_markets[MarketKey.OneXTwo].implied = [46.0, 27.0, 27.0];
  fixture.bf_markets[MarketKey.OneXTwo].drop = [-32.3, 0, 47.6];

  const quote = {
    slug: 'team-a-vs-team-b',
    url: 'https://polymarket.com/event/team-a-vs-team-b',
    liquidity: 6000,
    volume: 20000,
    markets: {
      [MarketKey.OneXTwo]: {
        liquidity: 4000,
        spread: 0.02,
        usable: true,
        outcomes: [
          { label: '1', novig_pct: 28.0, price: 0.28, bid: 0.27, ask: 0.29, change_1d: -0.05 },
          { label: 'N', novig_pct: 27.0, price: 0.27, bid: 0.26, ask: 0.28, change_1d: 0.0 },
          { label: '2', novig_pct: 45.0, price: 0.45, bid: 0.44, ask: 0.46, change_1d: 0.05 },
        ],
      },
    },
  };

  const res = analyzeFixtureConfiguration(fixture, quote, { nowMs });
  assert.equal(res.signature.is_complete, true);
  assert.equal(res.signature.code, '1 | Oui | 2 | G1');
  assert.equal(res.signature.pm_code, '2 | ? | ? | ?');
  assert.equal(res.axes.intensity.level, IntensityLevel.Moderee); // margin 19 pp < 24
  assert.equal(res.axes.variation.class, VariationClass.Retournement);
  assert.equal(res.axes.variation.has_reversal, true);
  assert.ok(res.axes.concordance.contradictions >= 3); // 1X2 vs HT, BTTS Oui vs G1, BFxPM 1X2
  assert.ok(res.markets[0].overround_pct !== null);

  // Configurable thresholds: lowering modereeMaxPp to 15 makes 19 pp become Forte
  const customRes = analyzeFixtureConfiguration(fixture, quote, {
    nowMs,
    thresholds: { modereeMaxPp: 15 },
  });
  assert.equal(customRes.axes.intensity.level, IntensityLevel.Forte);

  // Partial fixture stays explicitly marked with '?'
  const partialFixture = {
    fixture_key: 'partial_match',
    home: 'Nice',
    away: 'Lens',
    league: 'Ligue 1',
    country: 'fra',
    date: futureDate,
    total_volume_bf: 1200,
    bf_markets: {
      [MarketKey.OneXTwo]: {
        market: MarketKey.OneXTwo,
        total_volume: 1200,
        implied: [36.0, 33.0, 31.0],
        coef: [2.75, 3.0, 3.2],
        coef_new: [2.75, 3.0, 3.2],
        drop: [0, 0, 0],
        volume: [500, 400, 300],
        share: [41.7, 33.3, 25.0],
      },
    },
  };
  const partialRes = analyzeFixtureConfiguration(partialFixture, null, { nowMs });
  assert.equal(partialRes.signature.is_complete, false);
  assert.equal(partialRes.signature.blocks_present, 1);
  assert.equal(partialRes.signature.code, '1 | ? | ? | ?');
  assert.equal(partialRes.axes.intensity.level, IntensityLevel.Equilibre); // margin 3 pp < 4
});

test('buildConfigurationsFromData and buildSignalsFromData aggregate 72 catalog and respect signal presets (strict vs exploratory)', () => {
  const nowMs = Date.parse('2026-11-22T12:00:00Z');
  const futureDate = '2026-11-25T19:00:00Z';

  // Fixture with moderate BF volume (800 EUR) & PM liquidity ($200) -> rejected by Strict, accepted by Exploratory
  const lowVolFixture = {
    fixture_key: 'auxerre_vs_angers',
    home: 'Auxerre',
    away: 'Angers',
    league: 'Ligue 1',
    country: 'fra',
    date: futureDate,
    date_label: '25 nov. 19:00',
    total_volume_bf: 800,
    bf_markets: {
      [MarketKey.OneXTwo]: {
        market: MarketKey.OneXTwo,
        total_volume: 800,
        implied: [55.0, 25.0, 20.0],
        coef: [1.85, 3.9, 4.9],
        coef_new: [1.8, 3.9, 4.9],
        drop: [-2.7, 0, 0],
        volume: [600, 100, 100],
        share: [75, 12.5, 12.5],
      },
    },
  };

  const lowVolQuote = {
    slug: 'auxerre-vs-angers',
    url: 'https://polymarket.com/event/auxerre-vs-angers',
    liquidity: 200,
    volume: 1000,
    markets: {
      [MarketKey.OneXTwo]: {
        liquidity: 200,
        spread: 0.03,
        usable: true,
        outcomes: [
          { label: '1', novig_pct: 48.0, price: 0.48, bid: 0.46, ask: 0.49, spread: 0.03, change_1d: -0.04 },
          { label: 'N', novig_pct: 27.0, price: 0.27, bid: 0.26, ask: 0.28, spread: 0.02 },
          { label: '2', novig_pct: 25.0, price: 0.25, bid: 0.24, ask: 0.26, spread: 0.02 },
        ],
      },
    },
  };

  const quotes = new Map([[lowVolFixture.fixture_key, lowVolQuote]]);
  const cfgReport = buildConfigurationsFromData([lowVolFixture], quotes, { nowMs });
  assert.equal(cfgReport.catalog_72.length, 72);
  assert.equal(cfgReport.summary.total_fixtures, 1);
  assert.equal(cfgReport.summary.partial_signatures, 1);
  assert.equal(cfgReport.partial_signatures[0].code, '1 | ? | ? | ?');

  const strictSignals = buildSignalsFromData([lowVolFixture], quotes, {
    preset: 'strict',
    nowMs,
  });
  assert.equal(strictSignals.counts.executable, 0);
  assert.ok(strictSignals.counts.flow >= 1);

  const exploratorySignals = buildSignalsFromData([lowVolFixture], quotes, {
    preset: 'exploratory',
    nowMs,
  });
  assert.equal(exploratorySignals.counts.executable, 1);
  assert.equal(exploratorySignals.executable_signals[0].home, 'Auxerre');
});

test('HTTP endpoints /api/configurations and /api/signals expose 72 catalog, custom thresholds, and presets', async () => {
  const { dir, file } = makeTempObsPath();
  const futureDate = new Date(Date.now() + 5 * 3_600_000).toISOString();

  const scraper = {
    fetch: async (key) => ({
      source: 'live',
      ageSeconds: 0,
      error: null,
      rows:
        key === MarketKey.OneXTwo
          ? [
              {
                home: 'Lens',
                away: 'Lille',
                league: 'Ligue 1',
                country: 'fra',
                date: futureDate,
                coef_1: 2.3,
                coef_1_new: 2.0,
                coef_x: 3.4,
                coef_2: 3.6,
                volume_1: 700,
                volume_x: 150,
                volume_2: 100,
              },
            ]
          : [],
    }),
  };

  const polymarket = {
    quote: async () => ({
      slug: 'lens-vs-lille',
      url: 'https://polymarket.com/event/lens-vs-lille',
      title: 'Lens vs. Lille',
      volume: 4000,
      liquidity: 300,
      markets: {
        [MarketKey.OneXTwo]: {
          liquidity: 300,
          spread: 0.02,
          usable: true,
          outcomes: [
            { label: '1', novig_pct: 42.0, price: 0.42, bid: 0.41, ask: 0.43, spread: 0.02 },
            { label: 'N', novig_pct: 29.0, price: 0.29, bid: 0.28, ask: 0.30, spread: 0.02 },
            { label: '2', novig_pct: 29.0, price: 0.29, bid: 0.28, ask: 0.30, spread: 0.02 },
          ],
        },
      },
    }),
  };

  const espn = { many: async () => ({ events: [], errors: [] }) };
  const sportscore = { many: async () => ({ events: [], warnings: [] }) };
  const calibration = new CalibrationStore(file);
  const cfg = { port: 0, polymarketEnabled: true, espnEnabled: true, sportscoreDisabled: true };

  const app = createApp({ cfg, scraper, polymarket, espn, sportscore, calibration });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cfgRes = await fetch(
      `${baseUrl}/api/configurations?equilibreMaxPp=2&strongMovePct=10`
    ).then((r) => r.json());
    assert.equal(cfgRes.ok, true);
    assert.equal(cfgRes.catalog_72.length, 72);
    assert.equal(cfgRes.thresholds.equilibreMaxPp, 2);
    assert.equal(cfgRes.thresholds.strongMovePct, 10);
    assert.equal(cfgRes.rows.length, 1);

    const sigStrict = await fetch(`${baseUrl}/api/signals?preset=strict`).then((r) => r.json());
    assert.equal(sigStrict.ok, true);
    assert.equal(sigStrict.preset, 'strict');
    assert.equal(sigStrict.counts.executable, 0);

    const sigExp = await fetch(`${baseUrl}/api/signals?preset=exploratory`).then((r) => r.json());
    assert.equal(sigExp.ok, true);
    assert.equal(sigExp.preset, 'exploratory');
    assert.equal(sigExp.counts.executable, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildSignalsFromData orders full-time 1X2 proposition #1 ahead of aligned half-time 2e proposition', () => {
  const nowMs = Date.parse('2026-11-22T12:00:00Z');
  const futureDate = '2026-11-25T19:00:00Z';

  const fixture = {
    fixture_key: 'lyon_vs_nantes',
    home: 'Lyon',
    away: 'Nantes',
    league: 'Ligue 1',
    country: 'fra',
    date: futureDate,
    date_label: '25 nov. 19:00',
    total_volume_bf: 15000,
    bf_markets: {
      [MarketKey.OneXTwo]: {
        market: MarketKey.OneXTwo,
        total_volume: 10000,
        implied: [60.0, 22.0, 18.0],
        coef: [1.66, 4.5, 5.5],
        coef_new: [1.66, 4.5, 5.5],
        drop: [0, 0, 0],
        volume: [7000, 1500, 1500],
        share: [70, 15, 15],
      },
      [MarketKey.HalfTime]: {
        market: MarketKey.HalfTime,
        total_volume: 5000,
        implied: [50.0, 32.0, 18.0],
        coef: [2.05, 3.1, 5.5],
        coef_new: [1.98, 3.1, 5.5],
        drop: [-3.4, 0, 0],
        volume: [3000, 1200, 800],
        share: [60, 24, 16],
      },
    },
  };

  const quote = {
    slug: 'lyon-vs-nantes',
    url: 'https://polymarket.com/event/lyon-vs-nantes',
    liquidity: 4000,
    volume: 15000,
    markets: {
      [MarketKey.OneXTwo]: {
        liquidity: 2000,
        spread: 0.02,
        usable: true,
        outcomes: [
          { label: '1', novig_pct: 58.0, price: 0.58, bid: 0.57, ask: 0.59, spread: 0.02 },
          { label: 'N', novig_pct: 23.0, price: 0.23, bid: 0.22, ask: 0.24, spread: 0.02 },
          { label: '2', novig_pct: 19.0, price: 0.19, bid: 0.18, ask: 0.20, spread: 0.02 },
        ],
      },
      [MarketKey.HalfTime]: {
        liquidity: 2000,
        spread: 0.02,
        usable: true,
        outcomes: [
          { label: '1', novig_pct: 42.0, price: 0.42, bid: 0.41, ask: 0.43, spread: 0.02 },
          { label: 'N', novig_pct: 36.0, price: 0.36, bid: 0.35, ask: 0.37, spread: 0.02 },
          { label: '2', novig_pct: 22.0, price: 0.22, bid: 0.21, ask: 0.23, spread: 0.02 },
        ],
      },
    },
  };

  const signals = buildSignalsFromData([fixture], new Map([[fixture.fixture_key, quote]]), {
    preset: 'zero',
    nowMs,
  });

  assert.equal(signals.executable_signals.length, 2);
  assert.equal(signals.executable_signals[0].market, MarketKey.OneXTwo);
  assert.equal(signals.executable_signals[0].proposal_rank, 1);
  assert.equal(signals.executable_signals[0].title, 'Proposition : 1 (Domicile)');
  assert.equal(signals.executable_signals[0].signature_code, '1 | ? | 1 | ?');
  assert.equal(signals.executable_signals[0].pm_signature_code, '1 | ? | 1 | ?');
  assert.equal(signals.executable_signals[1].market, MarketKey.HalfTime);
  assert.equal(signals.executable_signals[1].proposal_rank, 2);
  assert.equal(signals.executable_signals[1].title, '2e proposition : 1 Mi-temps (Domicile)');
});

test('audit fixes: minor probability drifts are not Retournement/Forte and heavy favorite BTTS Non + Over 2.5 is not a false contradiction', () => {
  const nowMs = Date.parse('2026-11-22T12:00:00Z');
  const futureDate = '2026-11-25T19:00:00Z';

  // Heavy favorite (85% home) where outsider drifts 20 -> 26 (+30% odds, only -1.1 pts prob) and favorite shifts -1.3 pts,
  // with Over 2.5 favored and BTTS Non favored (expected 3-0 scoreline, not a contradiction!)
  const heavyFavFixture = {
    fixture_key: 'heavy_fav_test',
    home: 'HeavyFav',
    away: 'Underdog',
    league: 'Cup',
    country: 'int',
    date: futureDate,
    date_label: '25 nov. 19:00',
    total_volume_bf: 35000,
    bf_markets: {
      [MarketKey.OneXTwo]: {
        market: MarketKey.OneXTwo,
        total_volume: 25000,
        implied: [84.0, 12.2, 3.8],
        coef: [1.18, 8.0, 20.0],
        coef_new: [1.19, 8.2, 26.0],
        drop: [0.8, 2.5, 30.0],
        volume: [23000, 1200, 800],
        share: [92, 4.8, 3.2],
      },
      [MarketKey.OverUnder25]: {
        market: MarketKey.OverUnder25,
        total_volume: 5000,
        implied: [32.0, 0, 68.0],
        coef: [3.1, 0, 1.46],
        coef_new: [3.1, 0, 1.46],
        drop: [0, 0, 0],
        volume: [1500, 0, 3500],
        share: [30, 0, 70],
      },
      [MarketKey.Btts]: {
        market: MarketKey.Btts,
        total_volume: 5000,
        implied: [42.0, 0, 58.0],
        coef: [2.35, 0, 1.72],
        coef_new: [2.35, 0, 1.72],
        drop: [0, 0, 0],
        volume: [2000, 0, 3000],
        share: [40, 0, 60],
      },
    },
  };

  const cfg = analyzeFixtureConfiguration(heavyFavFixture, null, { nowMs });
  assert.notEqual(cfg.axes.variation.class, VariationClass.Retournement);
  assert.notEqual(cfg.axes.variation.class, VariationClass.HausseForte);
  assert.equal(cfg.axes.variation.has_reversal, false);
  assert.equal(cfg.axes.variation.has_strong_move, false);
  assert.equal(cfg.axes.concordance.contradictions, 0);

  const signals = buildSignalsFromData([heavyFavFixture], new Map(), { nowMs });
  assert.equal(signals.counts.movement, 0);
  assert.equal(signals.counts.contradiction, 0);
});

test('ranks Signals and Configs 72 strictly from most interesting to least interesting', () => {
  const nowMs = Date.parse('2026-11-22T12:00:00Z');
  const futureDate = '2026-11-25T20:00:00Z';

  // 1) High-value positive-edge liquid match (but only 2 BF blocks)
  const fixturePosEdge = {
    fixture_key: 'pos_edge_liquid',
    home: 'Arsenal',
    away: 'Chelsea',
    league: 'Premier League',
    country: 'England',
    date: futureDate,
    date_label: '25 nov. 20:00',
    total_volume_bf: 120000,
    bf_markets: {
      [MarketKey.OneXTwo]: {
        market: MarketKey.OneXTwo,
        total_volume: 100000,
        implied: [60.0, 22.0, 18.0],
        coef: [1.66, 4.5, 5.5],
        coef_new: [1.66, 4.5, 5.5],
        drop: [0, 0, 0],
        volume: [70000, 15000, 15000],
        share: [70, 15, 15],
      },
      [MarketKey.Btts]: {
        market: MarketKey.Btts,
        total_volume: 20000,
        implied: [56.0, 0, 44.0],
        coef: [1.78, 0, 2.27],
        coef_new: [1.78, 0, 2.27],
        drop: [0, 0, 0],
        volume: [12000, 0, 8000],
        share: [60, 0, 40],
      },
    },
  };
  const quotePosEdge = {
    slug: 'arsenal-vs-chelsea',
    url: 'https://polymarket.com/event/arsenal-vs-chelsea',
    liquidity: 18000,
    volume: 55000,
    markets: {
      [MarketKey.OneXTwo]: {
        liquidity: 12000,
        spread: 0.01,
        usable: true,
        outcomes: [
          { label: '1', novig_pct: 53.0, price: 0.53, bid: 0.525, ask: 0.535, spread: 0.01 },
          { label: 'N', novig_pct: 25.0, price: 0.25, bid: 0.24, ask: 0.26, spread: 0.02 },
          { label: '2', novig_pct: 22.0, price: 0.22, bid: 0.21, ask: 0.23, spread: 0.02 },
        ],
      },
    },
  };

  // 2) Negative-edge Seuil 0 match (1X2 promoted alongside aligned HT, with 1X2 net_edge_pp < 0)
  const fixtureNegEdge = {
    fixture_key: 'neg_edge_seuil0',
    home: 'Nice',
    away: 'Rennes',
    league: 'Ligue 1',
    country: 'France',
    date: futureDate,
    date_label: '25 nov. 20:00',
    total_volume_bf: 40000,
    bf_markets: {
      [MarketKey.OneXTwo]: {
        market: MarketKey.OneXTwo,
        total_volume: 30000,
        implied: [60.0, 22.0, 18.0],
        coef: [1.66, 4.5, 5.5],
        coef_new: [1.66, 4.5, 5.5],
        drop: [0, 0, 0],
        volume: [20000, 5000, 5000],
        share: [66.7, 16.7, 16.6],
      },
      [MarketKey.HalfTime]: {
        market: MarketKey.HalfTime,
        total_volume: 10000,
        implied: [50.0, 32.0, 18.0],
        coef: [2.0, 3.1, 5.5],
        coef_new: [2.0, 3.1, 5.5],
        drop: [0, 0, 0],
        volume: [6000, 2500, 1500],
        share: [60, 25, 15],
      },
    },
  };
  const quoteNegEdge = {
    slug: 'nice-vs-rennes',
    url: 'https://polymarket.com/event/nice-vs-rennes',
    liquidity: 5000,
    volume: 12000,
    markets: {
      [MarketKey.OneXTwo]: {
        liquidity: 4000,
        spread: 0.02,
        usable: true,
        outcomes: [
          { label: '1', novig_pct: 60.0, price: 0.60, bid: 0.59, ask: 0.61, spread: 0.02 },
          { label: 'N', novig_pct: 22.0, price: 0.22, bid: 0.21, ask: 0.23, spread: 0.02 },
          { label: '2', novig_pct: 18.0, price: 0.18, bid: 0.17, ask: 0.19, spread: 0.02 },
        ],
      },
      [MarketKey.HalfTime]: {
        liquidity: 3000,
        spread: 0.02,
        usable: true,
        outcomes: [
          { label: '1', novig_pct: 44.0, price: 0.44, bid: 0.43, ask: 0.45, spread: 0.02 },
          { label: 'N', novig_pct: 35.0, price: 0.35, bid: 0.34, ask: 0.36, spread: 0.02 },
          { label: '2', novig_pct: 21.0, price: 0.21, bid: 0.20, ask: 0.22, spread: 0.02 },
        ],
      },
    },
  };

  // 3) Low-volume 4-block quiet match (no anomalies, no PM)
  const fixtureQuiet4 = {
    fixture_key: 'quiet_4blocks',
    home: 'QuietA',
    away: 'QuietB',
    league: 'Reserve Cup',
    country: 'Other',
    date: futureDate,
    date_label: '25 nov. 20:00',
    total_volume_bf: 220,
    bf_markets: {
      [MarketKey.OneXTwo]: { market: MarketKey.OneXTwo, total_volume: 100, implied: [50, 25, 25], coef: [2.0, 4.0, 4.0], coef_new: [2.0, 4.0, 4.0], drop: [0, 0, 0] },
      [MarketKey.Btts]: { market: MarketKey.Btts, total_volume: 40, implied: [55, 0, 45], coef: [1.8, 0, 2.2], coef_new: [1.8, 0, 2.2], drop: [0, 0, 0] },
      [MarketKey.HalfTime]: { market: MarketKey.HalfTime, total_volume: 40, implied: [46, 32, 22], coef: [2.15, 3.1, 4.5], coef_new: [2.15, 3.1, 4.5], drop: [0, 0, 0] },
      [MarketKey.OverUnder15]: { market: MarketKey.OverUnder15, total_volume: 15, implied: [25, 0, 75], coef: [4.0, 0, 1.33], coef_new: [4.0, 0, 1.33], drop: [0, 0, 0] },
      [MarketKey.OverUnder25]: { market: MarketKey.OverUnder25, total_volume: 15, implied: [45, 0, 55], coef: [2.2, 0, 1.8], coef_new: [2.2, 0, 1.8], drop: [0, 0, 0] },
      [MarketKey.OverUnder35]: { market: MarketKey.OverUnder35, total_volume: 10, implied: [65, 0, 35], coef: [1.53, 0, 2.85], coef_new: [1.53, 0, 2.85], drop: [0, 0, 0] },
    },
  };

  // 4) Low-volume strong BF movement (no PM, €700 BF)
  const fixtureSmallMove = {
    fixture_key: 'small_move',
    home: 'MoveA',
    away: 'MoveB',
    league: 'Cup 2',
    country: 'Other',
    date: futureDate,
    date_label: '25 nov. 20:00',
    total_volume_bf: 700,
    bf_markets: {
      [MarketKey.OneXTwo]: {
        market: MarketKey.OneXTwo,
        total_volume: 700,
        implied: [54, 24, 22],
        coef: [2.15, 3.8, 3.8],
        coef_new: [1.85, 4.1, 4.5],
        drop: [-14.0, 7.9, 18.4],
      },
    },
  };

  const quotes = new Map([
    [fixturePosEdge.fixture_key, quotePosEdge],
    [fixtureNegEdge.fixture_key, quoteNegEdge],
  ]);
  const fixtures = [fixtureQuiet4, fixtureSmallMove, fixtureNegEdge, fixturePosEdge];

  const signals = buildSignalsFromData(fixtures, quotes, { preset: 'zero', nowMs });
  const posSig = signals.all_signals.find((s) => s.fixture_key === 'pos_edge_liquid' && s.category === 'executable');
  const negSig = signals.all_signals.find(
    (s) => s.fixture_key === 'neg_edge_seuil0' && s.category === 'executable' && s.market === MarketKey.OneXTwo
  );
  const moveSig = signals.all_signals.find((s) => s.fixture_key === 'small_move' && s.category === 'movement');

  assert.ok(posSig && negSig && moveSig);
  assert.ok(posSig.net_edge_pp > 0);
  assert.ok(negSig.net_edge_pp < 0);
  // Positive-edge opportunity MUST outrank minor movement and negative-edge Seuil 0 proposition
  assert.ok(posSig.score_sort > moveSig.score_sort);
  assert.ok(moveSig.score_sort > negSig.score_sort);
  assert.equal(signals.all_signals[0].fixture_key, 'pos_edge_liquid');

  const cfg = buildConfigurationsFromData(fixtures, quotes, { nowMs });
  assert.equal(cfg.rows[0].fixture_key, 'pos_edge_liquid');
  assert.ok(cfg.rows[0].interest_score > cfg.rows[cfg.rows.length - 1].interest_score);
  assert.equal(cfg.rows[cfg.rows.length - 1].fixture_key, 'quiet_4blocks');
});



