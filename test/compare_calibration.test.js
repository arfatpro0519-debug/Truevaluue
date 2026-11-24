import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server.js';
import { CalibrationStore, scoreObservationAgainstEvent } from '../src/calibration.js';
import { buildComparison, compareFixture } from '../src/compare.js';
import { MarketKey } from '../src/market.js';
import { MatchState } from '../src/model.js';
import { ConfidenceLevel, evaluateFixtureRecommendations, formatProposalAction, ZERO_THRESHOLDS } from '../src/recommend.js';

function makeTempObsPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cal-'));
  return { dir, file: path.join(dir, 'observations.json') };
}

test('compareFixture computes raw discrepancies, exec edges, derived markets, observations, and cross-checks', () => {
  const fixture = {
    fixture_key: 'arsenal_vs_chelsea',
    home: 'Arsenal',
    away: 'Chelsea',
    league: 'Premier League',
    country: 'eng',
    date: '2026-11-25T19:00:00Z',
    date_label: '25 nov. 19:00',
    total_volume_bf: 25000,
    bf_markets: {
      [MarketKey.OneXTwo]: {
        market: MarketKey.OneXTwo,
        total_volume: 15000,
        implied: [55.0, 25.0, 20.0],
        coef: [1.95, 3.9, 4.8],
        coef_new: [1.8, 3.9, 4.9],
        drop: [-7.7, 0.0, 2.1],
        volume: [10000, 2500, 2500],
        share: [66.7, 16.7, 16.7],
      },
      [MarketKey.OverUnder25]: {
        market: MarketKey.OverUnder25,
        total_volume: 10000,
        implied: [45.0, 0, 55.0],
        coef: [2.2, 0, 1.8],
        coef_new: [2.2, 0, 1.82],
        drop: [0.0, 0, 1.1],
        volume: [2000, 0, 8000],
        share: [20.0, 0, 80.0],
      },
      [MarketKey.Btts]: {
        market: MarketKey.Btts,
        total_volume: 4200,
        implied: [58.0, 0, 42.0],
        coef: [1.72, 0, 2.38],
        coef_new: [1.7, 0, 2.4],
        drop: [-1.2, 0, 0.8],
        volume: [3000, 0, 1200],
        share: [71.4, 0, 28.6],
      },
    },
  };

  const quote = {
    slug: 'arsenal-vs-chelsea',
    url: 'https://polymarket.com/event/arsenal-vs-chelsea',
    title: 'Arsenal vs. Chelsea',
    volume: 60000,
    volume_24h: 12000,
    liquidity: 15000,
    markets: {
      [MarketKey.OneXTwo]: {
        liquidity: 8000,
        volume: 30000,
        volume_24h: 7000,
        spread: 0.02,
        usable: true,
        outcomes: [
          { label: '1', novig_pct: 50.0, price: 0.5, bid: 0.49, ask: 0.51, spread: 0.02, change_1d: -0.04 },
          { label: 'N', novig_pct: 26.0, price: 0.26, bid: 0.25, ask: 0.27, spread: 0.02, change_1d: 0.01 },
          { label: '2', novig_pct: 24.0, price: 0.24, bid: 0.23, ask: 0.25, spread: 0.02, change_1d: 0.03 },
        ],
      },
      [MarketKey.DoubleChance]: {
        liquidity: 2000,
        volume: 5000,
        spread: 0.03,
        usable: true,
        outcomes: [
          { label: '1X', novig_pct: 74.0, price: 0.74, bid: 0.72, ask: 0.75, spread: 0.03 },
          { label: 'X2', novig_pct: 50.0, price: 0.5, bid: 0.48, ask: 0.51, spread: 0.03 },
          { label: '12', novig_pct: 76.0, price: 0.76, bid: 0.74, ask: 0.77, spread: 0.03 },
        ],
      },
      [MarketKey.OverUnder25]: {
        liquidity: 4000,
        volume: 10000,
        spread: 0.02,
        usable: true,
        outcomes: [
          { label: 'Under', novig_pct: 49.0, price: 0.49, bid: 0.48, ask: 0.5, spread: 0.02 },
          { label: 'Over', novig_pct: 51.0, price: 0.51, bid: 0.5, ask: 0.52, spread: 0.02 },
        ],
      },
    },
  };

  const res = compareFixture(fixture, quote);
  assert.equal(res.matched_markets_count, 3);
  assert.equal(res.total_markets_count, 4);
  assert.equal(res.is_multi_market, true);
  assert.equal(res.bf_only_markets.length, 1);
  assert.equal(res.bf_only_markets[0].market, MarketKey.Btts);
  assert.equal(res.available_markets.length, 4);
  assert.equal(res.max_abs_gap_pp, 6.0); // Double chance 1X: 80 vs 74 => -6.0 pts

  const m1x2 = res.markets.find((m) => m.market === MarketKey.OneXTwo);
  assert.equal(m1x2.bf_source, 'native');
  const side1 = m1x2.sides.find((s) => s.label === '1');
  assert.equal(side1.gap_pp, -5.0);
  assert.equal(side1.buy_edge_pp, 4.0); // bf 55 - ask 51 = +4.0 pts
  assert.equal(side1.sell_edge_pp, -6.0);

  const obsTypes = new Set(res.observations.map((o) => o.type));
  assert.ok(obsTypes.has('lag_pm'));
  assert.ok(obsTypes.has('pm_move'));
  assert.ok(obsTypes.has('net_discrepancy'));
  assert.ok(obsTypes.has('flow_divergence')); // O/U 2.5 Over has 80% vol, drop +1.1%, gap -4.0

  const mdc = res.markets.find((m) => m.market === MarketKey.DoubleChance);
  assert.equal(mdc.bf_source, 'derived_1x2');
  assert.equal(mdc.sides.find((s) => s.label === '1X').bf_pct, 80.0);

  assert.ok(res.cross_checks.some((c) => c.pair.includes('Double chance 1X') && c.gap_pp === -6.0));
});

test('scoreObservationAgainstEvent settles 1X2, O/U 2.5, BTTS, DoubleChance, and DNB push accurately', () => {
  const obs1x2 = {
    id: 'a_vs_b::1x2',
    market: MarketKey.OneXTwo,
    max_abs_gap_pp: 5.0,
    sides: [
      { label: '1', bf_pct: 60, pm_pct: 52, gap_pp: -8 },
      { label: 'N', bf_pct: 22, pm_pct: 26, gap_pp: 4 },
      { label: '2', bf_pct: 18, pm_pct: 22, gap_pp: 4 },
    ],
  };

  const settledHome = scoreObservationAgainstEvent(
    obs1x2,
    { state: MatchState.Finished, home_score: 2, away_score: 1, home_ht: 1, away_ht: 0 },
    'espn'
  );
  assert.equal(settledHome.status, 'settled');
  assert.equal(settledHome.gap_winner, 'betfair');
  assert.ok(settledHome.brier_bf < settledHome.brier_pm);
  assert.ok(settledHome.logloss_bf < settledHome.logloss_pm);

  const obsDnb = {
    id: 'a_vs_b::dnb',
    market: MarketKey.DrawNoBet,
    max_abs_gap_pp: 4.0,
    sides: [
      { label: '1', bf_pct: 60, pm_pct: 56, gap_pp: -4 },
      { label: '2', bf_pct: 40, pm_pct: 44, gap_pp: 4 },
    ],
  };
  const settledPush = scoreObservationAgainstEvent(
    obsDnb,
    { state: MatchState.Finished, home_score: 1, away_score: 1 },
    'espn'
  );
  assert.equal(settledPush.status, 'push');

  const obsBtts = {
    id: 'a_vs_b::btts',
    market: MarketKey.Btts,
    max_abs_gap_pp: 6.0,
    sides: [
      { label: 'Oui', bf_pct: 52, pm_pct: 58, gap_pp: 6 },
      { label: 'Non', bf_pct: 48, pm_pct: 42, gap_pp: -6 },
    ],
  };
  const settledBtts = scoreObservationAgainstEvent(
    obsBtts,
    { state: MatchState.Finished, home_score: 2, away_score: 1 },
    'sportscore'
  );
  assert.equal(settledBtts.gap_winner, 'polymarket');
  assert.equal(settledBtts.result_source, 'sportscore');
});

test('CalibrationStore records pre-kickoff only, settles via ESPN/SportScore, and builds report', async () => {
  const { dir, file } = makeTempObsPath();
  try {
    const store = new CalibrationStore(file);
    const nowMs = Date.parse('2026-11-22T12:00:00Z');

    const rows = [
      {
        fixture_key: 'live_match',
        home: 'Team A',
        away: 'Team B',
        league: 'Premier League',
        date: '2026-11-22T11:30:00Z', // already kicked off -> ignored
        markets: [
          {
            market: MarketKey.OneXTwo,
            short: '1X2',
            pm_usable: true,
            max_abs_gap_pp: 4.0,
            sides: [
              { label: '1', bf_pct: 50, pm_pct: 46, gap_pp: -4 },
              { label: 'N', bf_pct: 25, pm_pct: 27, gap_pp: 2 },
              { label: '2', bf_pct: 25, pm_pct: 27, gap_pp: 2 },
            ],
          },
        ],
      },
      {
        fixture_key: 'future_match',
        home: 'Arsenal',
        away: 'Chelsea',
        league: 'Premier League',
        date: '2026-11-22T15:00:00Z', // 3h ahead -> recorded
        markets: [
          {
            market: MarketKey.OneXTwo,
            short: '1X2',
            pm_usable: true,
            bf_volume: 10000,
            pm_liquidity: 5000,
            pm_spread_pts: 2.0,
            max_abs_gap_pp: 5.0,
            sides: [
              { label: '1', bf_pct: 60, pm_pct: 55, gap_pp: -5 },
              { label: 'N', bf_pct: 22, pm_pct: 25, gap_pp: 3 },
              { label: '2', bf_pct: 18, pm_pct: 20, gap_pp: 2 },
            ],
          },
        ],
      },
    ];

    const rec = store.recordFromComparison(rows, nowMs);
    assert.equal(rec.added, 1);
    assert.equal(rec.total, 1);
    assert.ok(
      store.storageMode === 'sqlite'
        ? fs.existsSync(store.dbPath)
        : fs.existsSync(store.filePath)
    );

    const espnMock = {
      many: async () => ({
        events: [
          {
            id: 'e1',
            date: '2026-11-22T15:00:00Z',
            league_slug: 'eng.1',
            home_team: 'Arsenal',
            away_team: 'Chelsea',
            home_score: 3,
            away_score: 0,
            home_ht: 2,
            away_ht: 0,
            state: MatchState.Finished,
          },
        ],
        errors: [],
      }),
    };

    const settleAfterMs = Date.parse('2026-11-22T17:30:00Z');
    const settled = await store.settle({ espn: espnMock, sportscore: null, cfg: { espnEnabled: true } }, settleAfterMs);
    assert.equal(settled.checked, 1);
    assert.equal(settled.settled, 1);

    const report = store.report();
    assert.equal(report.summary.settled, 1);
    assert.equal(report.summary.pending, 0);
    assert.equal(report.summary.divergence_count, 1);
    assert.equal(report.summary.divergence_bf_wins, 1);
    assert.equal(report.by_market.length, 1);
    assert.equal(report.by_market[0].market, MarketKey.OneXTwo);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP endpoints /api/compare, /api/calibration, and /api/calibration/sync respond cleanly', async () => {
  const { dir, file } = makeTempObsPath();
  const futureDate = new Date(Date.now() + 4 * 3_600_000).toISOString();
  const scraper = {
    fetch: async (key) => ({
      source: 'live',
      ageSeconds: 0,
      error: null,
      rows:
        key === MarketKey.OneXTwo
          ? [
              {
                home: 'PSG',
                away: 'Lyon',
                league: 'Ligue 1',
                country: 'fra',
                date: futureDate,
                coef_1: 1.7,
                coef_1_new: 1.6,
                coef_x: 4.0,
                coef_2: 5.5,
                volume_1: 12000,
                volume_x: 2000,
                volume_2: 1000,
              },
            ]
          : [],
    }),
  };

  const polymarket = {
    quote: async () => ({
      slug: 'psg-vs-lyon',
      url: 'https://polymarket.com/event/psg-vs-lyon',
      title: 'PSG vs. Lyon',
      volume: 30000,
      volume_24h: 5000,
      liquidity: 8000,
      markets: {
        [MarketKey.OneXTwo]: {
          liquidity: 8000,
          volume: 30000,
          spread: 0.02,
          usable: true,
          outcomes: [
            { label: '1', novig_pct: 55.0, price: 0.55, bid: 0.54, ask: 0.56, spread: 0.02 },
            { label: 'N', novig_pct: 25.0, price: 0.25, bid: 0.24, ask: 0.26, spread: 0.02 },
            { label: '2', novig_pct: 20.0, price: 0.2, bid: 0.19, ask: 0.21, spread: 0.02 },
          ],
        },
      },
    }),
  };

  const espn = { many: async () => ({ events: [], errors: [] }) };
  const sportscore = { many: async () => ({ events: [], warnings: [] }) };
  const calibration = new CalibrationStore(file);
  const cfg = {
    port: 0,
    polymarketEnabled: true,
    espnEnabled: true,
    sportscoreDisabled: true,
    adminPasscode: 'test-admin-secret-123',
  };

  const app = createApp({ cfg, scraper, polymarket, espn, sportscore, calibration });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cmp = await fetch(`${baseUrl}/api/compare`).then((r) => r.json());
    assert.equal(cmp.ok, true);
    assert.equal(cmp.count_matched, 1);
    assert.equal(cmp.rows[0].home, 'PSG');
    assert.equal(cmp.recorded.added, 1);
    assert.ok(cmp.recommendations_summary);

    const cal = await fetch(`${baseUrl}/api/calibration`).then((r) => r.json());
    assert.equal(cal.ok, true);
    assert.equal(cal.summary.total_observations, 1);
    assert.equal(cal.summary.pending, 1);
    assert.ok(Array.isArray(cal.by_confidence));

    const unauthSync = await fetch(`${baseUrl}/api/calibration/sync`, { method: 'POST' });
    assert.equal(unauthSync.status, 401);

    const login = await fetch(`${baseUrl}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'test-admin-secret-123' }),
    }).then((r) => r.json());
    assert.equal(login.ok, true);

    const sync = await fetch(`${baseUrl}/api/calibration/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}` },
    }).then((r) => r.json());
    assert.equal(sync.ok, true);
    assert.equal(sync.summary.total_observations, 1);

    const directCmp = await buildComparison({ scraper, polymarket });
    assert.equal(directCmp.count_matched, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    calibration.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('evaluateFixtureRecommendations enforces strict gates and assigns High, Moderate, Low tiers accurately', () => {
  const futureDate = '2026-11-25T19:00:00Z';
  const nowMs = Date.parse('2026-11-25T15:00:00Z');

  // High confidence: native, net_edge >= 4, bfVol >= 15000, pmLiq >= 2500, spread <= 3, flow confirmed
  const highFixture = {
    date: futureDate,
    markets: [
      {
        market: MarketKey.OneXTwo,
        short: '1X2',
        label: 'Résultat du match (1X2)',
        shape: 'three_way',
        bf_source: 'native',
        bf_volume: 20000,
        pm_liquidity: 5000,
        pm_spread_pts: 2.0,
        pm_usable: true,
        observations: [{ type: 'lag_pm' }],
        sides: [
          {
            label: '1',
            bf_pct: 58.0,
            bf_odds: 1.72,
            bf_drop_pct: -6.0,
            bf_share_pct: 65.0,
            pm_pct: 52.0,
            pm_bid: 0.51,
            pm_ask: 0.53,
            buy_edge_pp: 5.0,
            sell_edge_pp: -7.0,
          },
        ],
      },
    ],
  };
  const highRes = evaluateFixtureRecommendations(highFixture, nowMs);
  assert.equal(highRes.recommendations.length, 1);
  assert.equal(highRes.max_confidence, ConfidenceLevel.High);
  assert.equal(highRes.top_recommendation.net_edge_pp, 5.0);

  // Moderate confidence: lower liquidity ($1200) and spread 3.5 pts, native, net_edge 3.2 pts
  const modFixture = {
    date: futureDate,
    markets: [
      {
        market: MarketKey.OverUnder25,
        short: '+/- 2.5',
        label: 'Plus / Moins 2.5 buts',
        shape: 'two_way',
        bf_source: 'native',
        bf_volume: 9000,
        pm_liquidity: 1200,
        pm_spread_pts: 3.5,
        pm_usable: true,
        observations: [],
        sides: [
          {
            label: 'Over',
            bf_pct: 55.0,
            bf_odds: 1.82,
            bf_drop_pct: 0.0,
            bf_share_pct: 55.0,
            pm_pct: 50.0,
            pm_bid: 0.483,
            pm_ask: 0.518,
            buy_edge_pp: 3.2,
            sell_edge_pp: -6.7,
          },
        ],
      },
    ],
  };
  const modRes = evaluateFixtureRecommendations(modFixture, nowMs);
  assert.equal(modRes.max_confidence, ConfidenceLevel.Moderate);

  // Low confidence: derived_1x2, minimal volume & liquidity, wide spread 5.0 pts, net edge 2.6 pts
  const lowFixture = {
    date: futureDate,
    markets: [
      {
        market: MarketKey.DoubleChance,
        short: 'Double chance',
        label: 'Double chance',
        shape: 'three_way',
        bf_source: 'derived_1x2',
        bf_volume: 3500,
        pm_liquidity: 600,
        pm_spread_pts: 5.0,
        pm_usable: true,
        observations: [],
        sides: [
          {
            label: '1X',
            bf_pct: 72.0,
            bf_odds: null,
            bf_drop_pct: null,
            bf_share_pct: null,
            pm_pct: 67.0,
            pm_bid: 0.644,
            pm_ask: 0.694,
            buy_edge_pp: 2.6,
            sell_edge_pp: -7.6,
          },
        ],
      },
    ],
  };
  const lowRes = evaluateFixtureRecommendations(lowFixture, nowMs);
  assert.equal(lowRes.max_confidence, ConfidenceLevel.Low);

  // Rejections: adverse Betfair odds drift (+5% when buying PM) or match started
  const adverseFixture = {
    date: futureDate,
    markets: [
      {
        market: MarketKey.OneXTwo,
        short: '1X2',
        shape: 'three_way',
        bf_source: 'native',
        bf_volume: 20000,
        pm_liquidity: 5000,
        pm_spread_pts: 2.0,
        pm_usable: true,
        observations: [],
        sides: [
          {
            label: '1',
            bf_pct: 58.0,
            bf_drop_pct: 5.2,
            pm_pct: 52.0,
            pm_bid: 0.51,
            pm_ask: 0.53,
            buy_edge_pp: 5.0,
            sell_edge_pp: -7.0,
          },
        ],
      },
    ],
  };
  const adverseRes = evaluateFixtureRecommendations(adverseFixture, nowMs);
  assert.equal(adverseRes.recommendations.length, 0);
  assert.ok(adverseRes.rejection_summary.includes('hausse contraire'));

  const startedRes = evaluateFixtureRecommendations(highFixture, Date.parse('2026-11-25T19:05:00Z'));
  assert.equal(startedRes.recommendations.length, 0);
  assert.ok(startedRes.rejection_summary.includes('commencé'));
});

test('HTTP endpoints /api/compare and /api/signals allow custom proposal thresholds including zero gates', async () => {
  const { dir, file } = makeTempObsPath();
  const futureDate = new Date(Date.now() + 4 * 3_600_000).toISOString();

  const scraper = {
    fetch: async (key) => ({
      source: 'live',
      ageSeconds: 0,
      error: null,
      rows:
        key === MarketKey.OneXTwo
          ? [
              {
                home: 'Nice',
                away: 'Rennes',
                league: 'Ligue 1',
                country: 'fra',
                date: futureDate,
                coef_1: 2.3,
                coef_1_new: 2.0,
                coef_x: 3.4,
                coef_2: 3.6,
                volume_1: 120,
                volume_x: 40,
                volume_2: 30,
              },
            ]
          : [],
    }),
  };

  const polymarket = {
    quote: async () => ({
      slug: 'nice-vs-rennes',
      url: 'https://polymarket.com/event/nice-vs-rennes',
      title: 'Nice vs. Rennes',
      volume: 1000,
      liquidity: 80,
      markets: {
        [MarketKey.OneXTwo]: {
          liquidity: 80,
          volume: 1000,
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
    const defaultCmp = await fetch(`${baseUrl}/api/compare?record=0`).then((r) => r.json());
    assert.equal(defaultCmp.ok, true);
    assert.equal(defaultCmp.preset, 'zero');
    assert.equal(defaultCmp.thresholds.minBfVolume, 0);
    assert.equal(defaultCmp.thresholds.minPmLiquidity, 0);
    assert.equal(defaultCmp.thresholds.minNetEdgePp, 0);
    assert.equal(defaultCmp.recommendations_summary.total, 1);
    assert.equal(defaultCmp.rows[0].recommendations[0].action, '1 (Domicile)');
    assert.ok(!/polymarket/i.test(defaultCmp.rows[0].recommendations[0].action));

    const strictCmp = await fetch(`${baseUrl}/api/compare?record=0&preset=strict`).then((r) => r.json());
    assert.equal(strictCmp.ok, true);
    assert.equal(strictCmp.preset, 'strict');
    assert.equal(strictCmp.recommendations_summary.total, 0);

    const openCmp = await fetch(
      `${baseUrl}/api/compare?record=0&preset=strict&minBfVolume=0&minPmLiquidity=0&minNetEdgePp=2.0`
    ).then((r) => r.json());
    assert.equal(openCmp.ok, true);
    assert.equal(openCmp.thresholds.minBfVolume, 0);
    assert.equal(openCmp.thresholds.minPmLiquidity, 0);
    assert.equal(openCmp.recommendations_summary.total, 1);

    const openSig = await fetch(
      `${baseUrl}/api/signals?minBfVolume=0&minPmLiquidity=0&minNetEdgePp=2.0`
    ).then((r) => r.json());
    assert.equal(openSig.ok, true);
    assert.equal(openSig.preset, 'zero');
    assert.equal(openSig.counts.executable, 1);
    assert.equal(openSig.executable_signals[0].category_label, 'Proposition BF×PM');
    assert.equal(openSig.executable_signals[0].title, 'Proposition : 1 (Domicile)');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('formatProposalAction outputs concise French labels without mentioning Polymarket', () => {
  assert.equal(formatProposalAction(MarketKey.OneXTwo, '1', 'buy_pm'), '1 (Domicile)');
  assert.equal(formatProposalAction(MarketKey.OneXTwo, '2', 'buy_pm'), '2 (Extérieur)');
  assert.equal(formatProposalAction(MarketKey.OneXTwo, 'N', 'buy_pm'), 'Nul (X)');
  assert.equal(formatProposalAction(MarketKey.OneXTwo, '1', 'sell_pm'), 'X2 (Nul ou extérieur)');
  assert.equal(formatProposalAction(MarketKey.OverUnder25, 'Over', 'buy_pm'), 'Plus de 2.5 buts');
  assert.equal(formatProposalAction(MarketKey.OverUnder25, 'Under', 'buy_pm'), 'Moins de 2.5 buts');
  assert.equal(formatProposalAction(MarketKey.OverUnder25, 'Over', 'sell_pm'), 'Moins de 2.5 buts');
  assert.equal(formatProposalAction(MarketKey.OverUnder15, 'Over', 'buy_pm'), 'Plus de 1.5 buts');
  assert.equal(formatProposalAction(MarketKey.OverUnder35, 'Under', 'buy_pm'), 'Moins de 3.5 buts');
  assert.equal(formatProposalAction(MarketKey.Btts, 'Oui', 'buy_pm'), 'Les 2 équipes marquent : Oui');
  assert.equal(formatProposalAction(MarketKey.DoubleChance, '1X', 'buy_pm'), '1X (Domicile ou nul)');
  assert.equal(formatProposalAction(MarketKey.DrawNoBet, '2', 'buy_pm'), '2 (Extérieur, remboursé si nul)');
});

test('evaluateFixtureRecommendations prioritizes full-time 1X2 over aligned half-time and adapts goals/derivative market ranks', () => {
  const futureDate = '2026-11-25T19:00:00Z';
  const nowMs = Date.parse('2026-11-25T15:00:00Z');

  // 1) Aligned FT + HT favorite: HT has higher edge & High confidence, yet 1X2 must be Proposition #1 and HT #2
  const alignedFixture = {
    date: futureDate,
    markets: [
      {
        market: MarketKey.HalfTime,
        short: 'Mi-temps',
        label: 'Résultat mi-temps',
        shape: 'three_way',
        bf_source: 'native',
        bf_volume: 20000,
        pm_liquidity: 5000,
        pm_spread_pts: 2.0,
        pm_usable: true,
        observations: [{ type: 'lag_pm' }],
        sides: [
          {
            label: '1',
            bf_pct: 52.0,
            bf_odds: 1.92,
            bf_drop_pct: -4.0,
            bf_share_pct: 60.0,
            pm_pct: 45.0,
            pm_bid: 0.44,
            pm_ask: 0.46,
            buy_edge_pp: 6.0,
            sell_edge_pp: -8.0,
          },
          {
            label: 'N',
            bf_pct: 32.0,
            bf_odds: 3.1,
            bf_drop_pct: 0,
            bf_share_pct: 25.0,
            pm_pct: 35.0,
            pm_bid: 0.34,
            pm_ask: 0.36,
            buy_edge_pp: -4.0,
            sell_edge_pp: 2.0,
          },
        ],
      },
      {
        market: MarketKey.OneXTwo,
        short: '1X2',
        label: 'Résultat du match (1X2)',
        shape: 'three_way',
        bf_source: 'native',
        bf_volume: 5000,
        pm_liquidity: 600,
        pm_spread_pts: 3.0,
        pm_usable: true,
        observations: [],
        sides: [
          {
            label: '1',
            bf_pct: 64.0,
            bf_odds: 1.56,
            bf_drop_pct: 0.0,
            bf_share_pct: 70.0,
            pm_pct: 61.0,
            pm_bid: 0.595,
            pm_ask: 0.625,
            buy_edge_pp: 1.5,
            sell_edge_pp: -4.5,
          },
          {
            label: 'N',
            bf_pct: 21.0,
            bf_odds: 4.7,
            bf_drop_pct: 0,
            bf_share_pct: 15.0,
            pm_pct: 22.0,
            pm_bid: 0.21,
            pm_ask: 0.23,
            buy_edge_pp: -2.0,
            sell_edge_pp: -1.0,
          },
        ],
      },
      {
        market: MarketKey.DoubleChance,
        short: 'Double chance',
        label: 'Double chance',
        shape: 'three_way',
        bf_source: 'derived_1x2',
        bf_volume: 5000,
        pm_liquidity: 1000,
        pm_spread_pts: 2.0,
        pm_usable: true,
        observations: [],
        sides: [
          {
            label: '1X',
            bf_pct: 85.0,
            bf_odds: 1.18,
            bf_drop_pct: null,
            bf_share_pct: null,
            pm_pct: 80.0,
            pm_bid: 0.79,
            pm_ask: 0.81,
            buy_edge_pp: 4.0,
            sell_edge_pp: -6.0,
          },
        ],
      },
    ],
  };

  const res1 = evaluateFixtureRecommendations(alignedFixture, nowMs, ZERO_THRESHOLDS);
  assert.equal(res1.recommendations.length, 3);
  assert.equal(res1.top_recommendation.market, MarketKey.OneXTwo);
  assert.equal(res1.top_recommendation.action, '1 (Domicile)');
  assert.equal(res1.top_recommendation.proposal_rank, 1);
  assert.equal(res1.recommendations[1].market, MarketKey.DoubleChance);
  assert.equal(res1.recommendations[1].proposal_rank, 2);
  assert.equal(res1.recommendations[2].market, MarketKey.HalfTime);
  assert.equal(res1.recommendations[2].secondary_of, MarketKey.OneXTwo);
  assert.equal(res1.recommendations[2].proposal_rank, 3);

  // 2) Promotion in zero-threshold mode: HT triggers for away favorite '2' while 1X2 has slight negative spread (-1.0)
  const promoFixture = {
    date: futureDate,
    markets: [
      {
        market: MarketKey.OneXTwo,
        short: '1X2',
        label: 'Résultat du match (1X2)',
        shape: 'three_way',
        bf_source: 'native',
        bf_volume: 12000,
        pm_liquidity: 2000,
        pm_spread_pts: 2.0,
        pm_usable: true,
        observations: [],
        sides: [
          {
            label: '1',
            bf_pct: 20.0,
            bf_odds: 5.0,
            bf_drop_pct: 0,
            bf_share_pct: 15,
            pm_pct: 20.0,
            pm_bid: 0.19,
            pm_ask: 0.21,
            buy_edge_pp: -1.0,
            sell_edge_pp: -1.0,
          },
          {
            label: '2',
            bf_pct: 58.0,
            bf_odds: 1.72,
            bf_drop_pct: 0,
            bf_share_pct: 65,
            pm_pct: 58.0,
            pm_bid: 0.57,
            pm_ask: 0.59,
            buy_edge_pp: -1.0,
            sell_edge_pp: -0.5, // higher than buy_edge_pp, must still promote buy_pm ('2 (Extérieur)')
          },
        ],
      },
      {
        market: MarketKey.HalfTime,
        short: 'Mi-temps',
        label: 'Résultat mi-temps',
        shape: 'three_way',
        bf_source: 'native',
        bf_volume: 4000,
        pm_liquidity: 800,
        pm_spread_pts: 2.0,
        pm_usable: true,
        observations: [],
        sides: [
          {
            label: '2',
            bf_pct: 48.0,
            bf_odds: 2.08,
            bf_drop_pct: -2.0,
            bf_share_pct: 55,
            pm_pct: 44.0,
            pm_bid: 0.43,
            pm_ask: 0.45,
            buy_edge_pp: 3.0,
            sell_edge_pp: -5.0,
          },
          {
            label: 'N',
            bf_pct: 32.0,
            bf_odds: 3.1,
            bf_drop_pct: 0,
            bf_share_pct: 25,
            pm_pct: 34.0,
            pm_bid: 0.33,
            pm_ask: 0.35,
            buy_edge_pp: -3.0,
            sell_edge_pp: -1.0,
          },
        ],
      },
    ],
  };

  const promoRes = evaluateFixtureRecommendations(promoFixture, nowMs, ZERO_THRESHOLDS);
  assert.equal(promoRes.recommendations.length, 2);
  assert.equal(promoRes.recommendations[0].market, MarketKey.OneXTwo);
  assert.equal(promoRes.recommendations[0].direction, 'buy_pm');
  assert.equal(promoRes.recommendations[0].action, '2 (Extérieur)');
  assert.equal(promoRes.recommendations[0].proposal_rank, 1);
  assert.ok(!promoRes.recommendations[0].criteria[0].detail.includes('+-'));
  assert.equal(promoRes.recommendations[1].market, MarketKey.HalfTime);
  assert.equal(promoRes.recommendations[1].action, '2 Mi-temps (Extérieur)');
  assert.equal(promoRes.recommendations[1].proposal_rank, 2);
  assert.equal(promoRes.recommendations[1].secondary_of, MarketKey.OneXTwo);

  // 3) Goals markets adaptation: Over 2.5 beats Over 3.5 even if Over 3.5 has higher net edge
  const goalsFixture = {
    date: futureDate,
    markets: [
      {
        market: MarketKey.OverUnder35,
        short: '+/- 3.5',
        label: 'Plus / Moins 3.5 buts',
        shape: 'two_way',
        bf_source: 'native',
        bf_volume: 6000,
        pm_liquidity: 1500,
        pm_spread_pts: 2.0,
        pm_usable: true,
        observations: [],
        sides: [
          {
            label: 'Over',
            bf_pct: 36.0,
            bf_odds: 2.78,
            bf_drop_pct: -2.0,
            bf_share_pct: 50,
            pm_pct: 31.0,
            pm_bid: 0.30,
            pm_ask: 0.32,
            buy_edge_pp: 4.0,
            sell_edge_pp: -6.0,
          },
        ],
      },
      {
        market: MarketKey.OverUnder25,
        short: '+/- 2.5',
        label: 'Plus / Moins 2.5 buts',
        shape: 'two_way',
        bf_source: 'native',
        bf_volume: 9000,
        pm_liquidity: 2000,
        pm_spread_pts: 2.0,
        pm_usable: true,
        observations: [],
        sides: [
          {
            label: 'Over',
            bf_pct: 60.0,
            bf_odds: 1.67,
            bf_drop_pct: 0,
            bf_share_pct: 60,
            pm_pct: 58.0,
            pm_bid: 0.57,
            pm_ask: 0.59,
            buy_edge_pp: 1.0,
            sell_edge_pp: -3.0,
          },
        ],
      },
    ],
  };

  const goalsRes = evaluateFixtureRecommendations(goalsFixture, nowMs, ZERO_THRESHOLDS);
  assert.equal(goalsRes.recommendations.length, 2);
  assert.equal(goalsRes.recommendations[0].market, MarketKey.OverUnder25);
  assert.equal(goalsRes.recommendations[0].action, 'Plus de 2.5 buts');
  assert.equal(goalsRes.recommendations[0].proposal_rank, 1);
  assert.equal(goalsRes.recommendations[1].market, MarketKey.OverUnder35);
  assert.equal(goalsRes.recommendations[1].action, 'Plus de 3.5 buts');
  assert.equal(goalsRes.recommendations[1].proposal_rank, 2);
  assert.equal(goalsRes.recommendations[1].secondary_of, MarketKey.OverUnder25);
});

test('audit fixes: zero-threshold mode rejects rounding-noise longshots, 0.0-edge contrarians, and avoids Moderate tier inflation', () => {
  const futureDate = '2026-11-25T19:00:00Z';
  const nowMs = Date.parse('2026-11-25T15:00:00Z');

  // Extreme longshot 3.8% (+0.2 pt noise) + heavy favorite negative spread -> must NOT recommend the 3.8% underdog!
  const lopsidedNoise = {
    date: futureDate,
    markets: [
      {
        market: MarketKey.OneXTwo,
        short: '1X2',
        label: 'Résultat du match (1X2)',
        shape: 'three_way',
        bf_source: 'native',
        bf_volume: 120000,
        pm_liquidity: 25000,
        pm_spread_pts: 1.0,
        pm_usable: true,
        observations: [],
        sides: [
          {
            label: '1',
            bf_pct: 3.8,
            bf_odds: 26.0,
            bf_drop_pct: 0,
            bf_share_pct: 2,
            pm_pct: 3.6,
            pm_bid: 0.035,
            pm_ask: 0.036,
            buy_edge_pp: 0.2,
            sell_edge_pp: -0.3,
          },
          {
            label: 'N',
            bf_pct: 5.2,
            bf_odds: 19.0,
            bf_drop_pct: 0,
            bf_share_pct: 3,
            pm_pct: 5.4,
            pm_bid: 0.052,
            pm_ask: 0.056,
            buy_edge_pp: -0.4,
            sell_edge_pp: 0.0,
          },
          {
            label: '2',
            bf_pct: 91.0,
            bf_odds: 1.1,
            bf_drop_pct: 0,
            bf_share_pct: 95,
            pm_pct: 91.0,
            pm_bid: 0.905,
            pm_ask: 0.915,
            buy_edge_pp: -0.5,
            sell_edge_pp: 0.0, // zero-edge sell_pm against 91% favorite must not trigger!
          },
        ],
      },
      // Over 3.5 tiny +0.5 pt noise must NOT promote Over 2.5 with -0.7 pt negative edge
      {
        market: MarketKey.OverUnder35,
        short: '+/- 3.5',
        label: 'Plus / Moins 3.5 buts',
        shape: 'two_way',
        bf_source: 'native',
        bf_volume: 15000,
        pm_liquidity: 4000,
        pm_spread_pts: 1.0,
        pm_usable: true,
        observations: [],
        sides: [
          {
            label: 'Over',
            bf_pct: 49.5,
            bf_odds: 2.02,
            bf_drop_pct: 0,
            bf_share_pct: 55,
            pm_pct: 49.0,
            pm_bid: 0.48,
            pm_ask: 0.49,
            buy_edge_pp: 0.5,
            sell_edge_pp: -1.5,
          },
        ],
      },
      {
        market: MarketKey.OverUnder25,
        short: '+/- 2.5',
        label: 'Plus / Moins 2.5 buts',
        shape: 'two_way',
        bf_source: 'native',
        bf_volume: 25000,
        pm_liquidity: 8000,
        pm_spread_pts: 1.0,
        pm_usable: true,
        observations: [],
        sides: [
          {
            label: 'Over',
            bf_pct: 71.3,
            bf_odds: 1.4,
            bf_drop_pct: 0,
            bf_share_pct: 75,
            pm_pct: 72.0,
            pm_bid: 0.71,
            pm_ask: 0.72,
            buy_edge_pp: -0.7,
            sell_edge_pp: -0.3,
          },
        ],
      },
    ],
  };

  const resNoise = evaluateFixtureRecommendations(lopsidedNoise, nowMs, ZERO_THRESHOLDS);
  assert.ok(!resNoise.recommendations.some((r) => r.market === MarketKey.OneXTwo));
  assert.ok(!resNoise.recommendations.some((r) => r.market === MarketKey.OverUnder25));
  // Over 3.5 with only +0.5 pt edge and high volume/liquidity must stay Low confidence (never Moderate)
  assert.equal(resNoise.recommendations.length, 1);
  assert.equal(resNoise.recommendations[0].market, MarketKey.OverUnder35);
  assert.equal(resNoise.recommendations[0].tier, ConfidenceLevel.Low);
});

test('CalibrationStore filters out corrupted incomplete 3-way observations on load and recording', () => {
  const { dir, file } = makeTempObsPath();
  try {
    fs.writeFileSync(
      file,
      JSON.stringify([
        {
          id: 'bad_ht::half-time',
          fixture_key: 'bad_ht',
          market: MarketKey.HalfTime,
          sides: [
            { label: '1', bf_pct: 40, pm_pct: 80, gap_pp: 40 },
            { label: '2', bf_pct: 30, pm_pct: 20, gap_pp: -10 },
          ],
          status: 'pending',
        },
        {
          id: 'ok_1x2::1x2',
          fixture_key: 'ok_1x2',
          market: MarketKey.OneXTwo,
          sides: [
            { label: '1', bf_pct: 50, pm_pct: 50, gap_pp: 0 },
            { label: '2', bf_pct: 25, pm_pct: 25, gap_pp: 0 },
            { label: 'N', bf_pct: 25, pm_pct: 25, gap_pp: 0 },
          ],
          status: 'pending',
        },
      ]),
      'utf8'
    );
    const store = new CalibrationStore(file);
    assert.equal(store.observations.length, 1);
    assert.equal(store.observations[0].id, 'ok_1x2::1x2');

    const futureDate = new Date(Date.now() + 4 * 3_600_000).toISOString();
    const rec = store.recordFromComparison([
      {
        fixture_key: 'bad_ht_new',
        home: 'A',
        away: 'B',
        league: 'Ligue 1',
        date: futureDate,
        markets: [
          {
            market: MarketKey.HalfTime,
            short: 'Mi-temps',
            pm_usable: true,
            sides: [
              { label: '1', bf_pct: 40, pm_pct: 40, gap_pp: 0 },
              { label: '2', bf_pct: 30, pm_pct: 30, gap_pp: 0 },
            ],
          },
        ],
      },
    ]);
    assert.equal(rec.added, 0);
    assert.equal(store.observations.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CalibrationStore.report enriches settled observations with winning labels, favorite hit rates, and recommendation PnL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-report-'));
  const file = path.join(dir, 'obs.json');
  try {
    fs.writeFileSync(
      file,
      JSON.stringify([
        {
          id: 'win_match::1x2',
          fixture_key: 'win_match',
          home: 'Alpha',
          away: 'Beta',
          league: 'Ligue 1',
          market: MarketKey.OneXTwo,
          market_short: '1X2',
          status: 'settled',
          home_score: 2,
          away_score: 0,
          brier_bf: 0.12,
          brier_pm: 0.14,
          logloss_bf: 0.4,
          logloss_pm: 0.45,
          gap_winner: 'tie',
          max_abs_gap_pp: 1.5,
          recommendation: {
            tier: 'moderate',
            tier_label: 'Modérée',
            direction: 'buy_pm',
            side_label: '1',
            action: '1 (Domicile)',
            net_edge_pp: 1.5,
            prop_odds: 1.8,
          },
          sides: [
            { label: '1', bf_pct: 60, pm_pct: 55.5, gap_pp: -4.5 },
            { label: 'N', bf_pct: 22, pm_pct: 24.5, gap_pp: 2.5 },
            { label: '2', bf_pct: 18, pm_pct: 20, gap_pp: 2.0 },
          ],
        },
        {
          id: 'loss_match::over-under-2-5',
          fixture_key: 'loss_match',
          home: 'Gamma',
          away: 'Delta',
          league: 'Serie A',
          market: MarketKey.OverUnder25,
          market_short: '+/- 2.5',
          status: 'settled',
          home_score: 1,
          away_score: 0,
          brier_bf: 0.3,
          brier_pm: 0.32,
          logloss_bf: 0.8,
          logloss_pm: 0.85,
          gap_winner: 'tie',
          max_abs_gap_pp: 1.0,
          recommendation: {
            tier: 'low',
            tier_label: 'Faible',
            direction: 'buy_pm',
            side_label: 'Over',
            action: 'Plus de 2,5 buts',
            net_edge_pp: 0.4,
            prop_odds: 2.0,
          },
          sides: [
            { label: 'Over', bf_pct: 52, pm_pct: 50, gap_pp: -2.0 },
            { label: 'Under', bf_pct: 48, pm_pct: 50, gap_pp: 2.0 },
          ],
        },
      ]),
      'utf8'
    );
    const store = new CalibrationStore(file);
    const rep = store.report();
    assert.equal(rep.summary.settled, 2);
    assert.equal(rep.summary.settled_fixtures, 2);
    assert.equal(rep.summary.reco_settled, 2);
    assert.equal(rep.summary.reco_won, 1);
    assert.equal(rep.summary.reco_lost, 1);
    assert.equal(rep.summary.reco_win_rate_pct, 50);
    assert.equal(rep.summary.reco_roi_u, -0.2);
    assert.equal(rep.summary.bf_fav_hit_pct, 50);

    const w = rep.observations.find((o) => o.id === 'win_match::1x2');
    assert.deepEqual(w.winning_labels, ['1']);
    assert.equal(w.reco_result, 'win');
    assert.equal(w.reco_pnl_u, 0.8);

    const l = rep.observations.find((o) => o.id === 'loss_match::over-under-2-5');
    assert.deepEqual(l.winning_labels, ['Under']);
    assert.equal(l.reco_result, 'loss');
    assert.equal(l.reco_pnl_u, -1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CalibrationStore tracks signal-only matches, settles DNB push and win/loss, and excludes non-signal matches', async () => {
  const { dir, file } = makeTempObsPath();
  try {
    const store = new CalibrationStore(file);
    const nowMs = Date.parse('2026-11-22T12:00:00Z');

    // Record 2 baseline comparison matches: only one will have a signal emitted
    store.recordFromComparison(
      [
        {
          fixture_key: 'baseline_only',
          home: 'Lille',
          away: 'Metz',
          league: 'Ligue 1',
          date: '2026-11-22T15:00:00Z',
          markets: [
            {
              market: MarketKey.OneXTwo,
              short: '1X2',
              pm_usable: true,
              max_abs_gap_pp: 1.5,
              sides: [
                { label: '1', bf_pct: 60, pm_pct: 58.5, gap_pp: -1.5 },
                { label: 'N', bf_pct: 22, pm_pct: 23, gap_pp: 1.0 },
                { label: '2', bf_pct: 18, pm_pct: 18.5, gap_pp: 0.5 },
              ],
            },
          ],
        },
        {
          fixture_key: 'signal_win_match',
          home: 'Arsenal',
          away: 'Chelsea',
          league: 'Premier League',
          date: '2026-11-22T15:00:00Z',
          markets: [
            {
              market: MarketKey.OneXTwo,
              short: '1X2',
              pm_usable: true,
              max_abs_gap_pp: 5.0,
              sides: [
                { label: '1', bf_pct: 60, pm_pct: 55, gap_pp: -5.0 },
                { label: 'N', bf_pct: 22, pm_pct: 25, gap_pp: 3.0 },
                { label: '2', bf_pct: 18, pm_pct: 20, gap_pp: 2.0 },
              ],
            },
          ],
        },
      ],
      nowMs
    );

    // Emit signals for 'signal_win_match' (1X2 win), 'signal_dnb_push' (DNB draw -> push), plus an already-kicked-off match (ignored)
    const sigRec = store.recordFromSignals(
      {
        all_signals: [
          {
            id: 'exec::signal_win_match::1x2::1',
            category: 'executable',
            category_label: 'Proposition BF×PM',
            fixture_key: 'signal_win_match',
            home: 'Arsenal',
            away: 'Chelsea',
            league: 'Premier League',
            date: '2026-11-22T15:00:00Z',
            date_label: '22 nov. 15:00',
            market: MarketKey.OneXTwo,
            market_short: '1X2',
            title: 'Proposition : 1 (Domicile)',
            detail: 'Edge +4.0 pts',
            net_edge_pp: 4.0,
            score_sort: 112,
            recommendation: {
              tier: 'high',
              tier_label: 'Forte',
              direction: 'buy_pm',
              side_label: '1',
              action: '1 (Domicile)',
              prop_odds: 1.82,
              prop_pct: 55,
            },
          },
          {
            id: 'exec::signal_dnb_push::dnb::1',
            category: 'executable',
            category_label: 'Proposition BF×PM',
            fixture_key: 'signal_dnb_push',
            home: 'Lyon',
            away: 'Rennes',
            league: 'Ligue 1',
            date: '2026-11-22T15:00:00Z',
            date_label: '22 nov. 15:00',
            market: MarketKey.DrawNoBet,
            market_short: 'DNB',
            title: 'Proposition : 1 (Domicile, remboursé si nul)',
            detail: 'Edge +2.5 pts',
            net_edge_pp: 2.5,
            score_sort: 95,
            recommendation: {
              tier: 'moderate',
              tier_label: 'Modérée',
              direction: 'buy_pm',
              side_label: '1',
              action: '1 (Domicile, remboursé si nul)',
              prop_odds: 1.65,
              prop_pct: 60.6,
            },
          },
          {
            id: 'mov::kicked_off::1x2',
            category: 'movement',
            category_label: 'Mouvement BF',
            fixture_key: 'kicked_off',
            home: 'Old',
            away: 'Team',
            league: 'Ligue 1',
            date: '2026-11-22T11:00:00Z', // already kicked off -> ignored
            score_sort: 70,
          },
        ],
      },
      nowMs
    );

    assert.equal(sigRec.added, 2);
    assert.equal(sigRec.total, 2);

    const espnMock = {
      many: async (slugs) => {
        const events = [];
        if (slugs.includes('eng.1')) {
          events.push({
            id: 'e-ars',
            date: '2026-11-22T15:00:00Z',
            league_slug: 'eng.1',
            home_team: 'Arsenal',
            away_team: 'Chelsea',
            home_score: 2,
            away_score: 0,
            state: MatchState.Finished,
          });
        }
        if (slugs.includes('fra.1')) {
          events.push(
            {
              id: 'e-lil',
              date: '2026-11-22T15:00:00Z',
              league_slug: 'fra.1',
              home_team: 'Lille',
              away_team: 'Metz',
              home_score: 1,
              away_score: 0,
              state: MatchState.Finished,
            },
            {
              id: 'e-lyo',
              date: '2026-11-22T15:00:00Z',
              league_slug: 'fra.1',
              home_team: 'Lyon',
              away_team: 'Rennes',
              home_score: 1,
              away_score: 1, // Draw -> DNB settles as Push (0 u)
              state: MatchState.Finished,
            }
          );
        }
        return { events, errors: [] };
      },
    };

    const settleMs = Date.parse('2026-11-22T17:30:00Z');
    const settleRes = await store.settle({ espn: espnMock, sportscore: null, cfg: { espnEnabled: true } }, settleMs);
    assert.equal(settleRes.settled, 2);
    assert.equal(settleRes.signal_settled, 2);

    const sigRep = store.signalResultsReport();
    assert.equal(sigRep.summary.total_matches, 2); // baseline_only excluded!
    assert.equal(sigRep.summary.settled_matches, 2);
    assert.equal(sigRep.summary.reco_won, 1);
    assert.equal(sigRep.summary.reco_lost, 0);
    assert.equal(sigRep.summary.reco_push, 1);
    assert.equal(sigRep.summary.reco_win_rate_pct, 100);
    assert.equal(sigRep.summary.reco_roi_u, 0.82);

    const ars = sigRep.results.find((r) => r.fixture_key === 'signal_win_match');
    assert.equal(ars.match_outcome, 'win');
    assert.equal(ars.reco_pnl_u, 0.82);

    const lyo = sigRep.results.find((r) => r.fixture_key === 'signal_dnb_push');
    assert.equal(lyo.match_outcome, 'push');
    assert.equal(lyo.reco_push, 1);
    assert.equal(lyo.reco_pnl_u, 0);

    const calRep = store.report();
    assert.equal(calRep.summary.signal_matches, 1); // only signal_win_match in observations
    const obsBaseline = calRep.observations.find((o) => o.fixture_key === 'baseline_only');
    const obsSignal = calRep.observations.find((o) => o.fixture_key === 'signal_win_match');
    assert.equal(obsBaseline.in_signals, false);
    assert.equal(obsSignal.in_signals, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP /api/signals records signal matches and /api/signals/results returns only signal-emitted matches', async () => {
  const { dir, file } = makeTempObsPath();
  const futureDate = new Date(Date.now() + 4 * 3_600_000).toISOString();

  const scraper = {
    fetch: async (key) => ({
      source: 'live',
      ageSeconds: 0,
      error: null,
      rows:
        key === MarketKey.OneXTwo
          ? [
              {
                home: 'PSG',
                away: 'Monaco',
                league: 'Ligue 1',
                country: 'fra',
                date: futureDate,
                coef_1: 1.75,
                coef_1_new: 1.62,
                coef_x: 4.0,
                coef_2: 5.2,
                volume_1: 15000,
                volume_x: 2000,
                volume_2: 1500,
              },
              {
                home: 'Nantes',
                away: 'Brest',
                league: 'Ligue 1',
                country: 'fra',
                date: futureDate,
                coef_1: 2.5,
                coef_1_new: 2.5,
                coef_x: 3.33,
                coef_2: 3.33,
                volume_1: 1000,
                volume_x: 1000,
                volume_2: 1000,
              },
            ]
          : [],
    }),
  };

  const polymarket = {
    quote: async (fx) => {
      if (fx.home === 'PSG') {
        return {
          slug: 'psg-vs-monaco',
          url: 'https://polymarket.com/event/psg-vs-monaco',
          title: 'PSG vs. Monaco',
          volume: 40000,
          liquidity: 9000,
          markets: {
            [MarketKey.OneXTwo]: {
              liquidity: 9000,
              volume: 40000,
              spread: 0.02,
              usable: true,
              outcomes: [
                { label: '1', novig_pct: 55.0, price: 0.55, bid: 0.54, ask: 0.56, spread: 0.02 },
                { label: 'N', novig_pct: 25.0, price: 0.25, bid: 0.24, ask: 0.26, spread: 0.02 },
                { label: '2', novig_pct: 20.0, price: 0.2, bid: 0.19, ask: 0.21, spread: 0.02 },
              ],
            },
          },
        };
      }
      return {
        slug: 'nantes-vs-brest',
        url: 'https://polymarket.com/event/nantes-vs-brest',
        title: 'Nantes vs. Brest',
        volume: 5000,
        liquidity: 1500,
        markets: {
          [MarketKey.OneXTwo]: {
            liquidity: 1500,
            volume: 5000,
            spread: 0.04,
            usable: true,
            outcomes: [
              { label: '1', novig_pct: 40.0, price: 0.40, bid: 0.38, ask: 0.42, spread: 0.04 },
              { label: 'N', novig_pct: 30.0, price: 0.30, bid: 0.28, ask: 0.32, spread: 0.04 },
              { label: '2', novig_pct: 30.0, price: 0.30, bid: 0.28, ask: 0.32, spread: 0.04 },
            ],
          },
        },
      };
    },
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
    const sig = await fetch(`${baseUrl}/api/signals`).then((r) => r.json());
    assert.equal(sig.ok, true);
    assert.ok(sig.all_signals.some((s) => s.home === 'PSG'));

    const res = await fetch(`${baseUrl}/api/signals/results`).then((r) => r.json());
    assert.equal(res.ok, true);
    assert.equal(res.summary.total_matches, 1);
    assert.equal(res.results[0].home, 'PSG');
    assert.ok(!res.results.some((r) => r.home === 'Nantes'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CalibrationStore computes by_category breakdown across executable, movement, flow and contradiction and filters dynamically', async () => {
  const { dir, file } = makeTempObsPath();
  try {
    const store = new CalibrationStore(file);
    const futureDate = '2026-11-24T19:00:00Z';
    const captureMs = Date.parse('2026-11-24T12:00:00Z');

    // Match 1: Inter vs Milan -> 2-1 (side '1' & '+2.5' win)
    // Signals: executable (1 wins @2.0 -> +1u) + movement (drop_pct +20 on 1X2 side '1' -> fade loses)
    // Match 2: Napoli vs Roma -> 0-2 (side '2' wins, BF more accurate than PM)
    // Signals: flow (sell_pm on '1' -> '1' loses so sell_pm wins) + contradiction (1X2)
    store.recordFromComparison(
      [
        {
          fixture_key: 'inter_milan',
          home: 'Inter',
          away: 'Milan',
          league: 'Serie A',
          date: futureDate,
          date_label: '24/11 19:00',
          markets: [
            {
              market: MarketKey.OneXTwo,
              short: '1X2',
              label: 'Résultat (1X2)',
              bf_volume: 42000,
              pm_liquidity: 8500,
              pm_spread_pts: 1.5,
              pm_usable: true,
              max_abs_gap_pp: 8.0,
              sides: [
                { label: '1', bf_pct: 58.0, pm_pct: 50.0, gap_pp: 8.0 },
                { label: 'N', bf_pct: 24.0, pm_pct: 26.0, gap_pp: -2.0 },
                { label: '2', bf_pct: 18.0, pm_pct: 24.0, gap_pp: -6.0 },
              ],
            },
          ],
          recommendations: [
            {
              market: MarketKey.OneXTwo,
              tier: 'high',
              tier_label: 'Fort',
              direction: 'buy_pm',
              side_label: '1',
              action: 'Inter (1) @2.00',
              net_edge_pp: 6.5,
              prop_odds: 2.0,
              prop_pct: 50.0,
              bf_prop_pct: 58.0,
            },
          ],
        },
        {
          fixture_key: 'napoli_roma',
          home: 'Napoli',
          away: 'Roma',
          league: 'Serie A',
          date: futureDate,
          date_label: '24/11 19:00',
          markets: [
            {
              market: MarketKey.OneXTwo,
              short: '1X2',
              label: 'Résultat (1X2)',
              bf_volume: 30000,
              pm_liquidity: 6000,
              pm_spread_pts: 2.0,
              pm_usable: true,
              max_abs_gap_pp: 12.0,
              sides: [
                { label: '1', bf_pct: 32.0, pm_pct: 44.0, gap_pp: -12.0 },
                { label: 'N', bf_pct: 28.0, pm_pct: 26.0, gap_pp: 2.0 },
                { label: '2', bf_pct: 40.0, pm_pct: 30.0, gap_pp: 10.0 },
              ],
            },
          ],
          recommendations: [],
        },
      ],
      captureMs
    );

    store.recordFromSignals(
      {
        all_signals: [
          {
            id: 'sig-exec-inter',
            fixture_key: 'inter_milan',
            home: 'Inter',
            away: 'Milan',
            league: 'Serie A',
            date: futureDate,
            category: 'executable',
            category_label: 'Propositions BF×PM',
            market: MarketKey.OneXTwo,
            market_short: '1X2',
            title: 'Inter @ 2.00',
            detail: 'Edge +6.5 pts',
            direction: 'buy_pm',
            side_label: '1',
            net_edge_pp: 6.5,
            recommendation: {
              tier: 'high',
              tier_label: 'Fort',
              direction: 'buy_pm',
              side_label: '1',
              action: 'Inter (1) @2.00',
              prop_odds: 2.0,
              prop_pct: 50.0,
              bf_prop_pct: 58.0,
            },
            score_sort: 90,
          },
          {
            id: 'sig-mov-inter',
            fixture_key: 'inter_milan',
            home: 'Inter',
            away: 'Milan',
            league: 'Serie A',
            date: futureDate,
            category: 'movement',
            category_label: 'Mouvements 24h',
            market: '1X2',
            market_short: '1X2',
            side_label: '1',
            drop_pct: 20.0,
            title: 'Baisse marquée sur 1 (1X2)',
            detail: 'Cote en baisse de 20%',
            score_sort: 55,
          },
          {
            id: 'sig-flow-napoli',
            fixture_key: 'napoli_roma',
            home: 'Napoli',
            away: 'Roma',
            league: 'Serie A',
            date: futureDate,
            category: 'flow',
            category_label: 'Flux & Retards BF×PM',
            market: MarketKey.OneXTwo,
            market_short: '1X2',
            side_label: '1',
            direction: 'sell_pm',
            title: 'PM trop haut sur 1 (1X2)',
            detail: 'PM 44% vs BF 32%',
            score_sort: 65,
          },
          {
            id: 'sig-contra-napoli',
            fixture_key: 'napoli_roma',
            home: 'Napoli',
            away: 'Roma',
            league: 'Serie A',
            date: futureDate,
            category: 'contradiction',
            category_label: 'Contradictions',
            market: MarketKey.OneXTwo,
            market_short: '1X2',
            title: 'Désaccord fort BF vs PM',
            detail: '12 pts d’écart',
            items: [{ market: MarketKey.OneXTwo, short: '1X2', side: '2', bf_pct: 40, pm_pct: 30, gap_pp: 10 }],
            score_sort: 60,
          },
        ],
      },
      captureMs
    );

    const espnMock = {
      many: async (slugs) => {
        if (!slugs.includes('ita.1')) return { events: [], errors: [] };
        return {
          events: [
            {
              id: 'e-int',
              date: futureDate,
              league_slug: 'ita.1',
              home_team: 'Inter',
              away_team: 'Milan',
              home_score: 2,
              away_score: 1,
              state: MatchState.Finished,
            },
            {
              id: 'e-nap',
              date: futureDate,
              league_slug: 'ita.1',
              home_team: 'Napoli',
              away_team: 'Roma',
              home_score: 0,
              away_score: 2,
              state: MatchState.Finished,
            },
          ],
          errors: [],
        };
      },
    };

    const settleMs = Date.parse('2026-11-24T22:00:00Z');
    const settled = await store.settle({ espn: espnMock, sportscore: null, cfg: { espnEnabled: true } }, settleMs);
    assert.equal(settled.settled, 2);
    assert.equal(settled.signal_settled, 2);

    const allSigRep = store.signalResultsReport();
    assert.equal(allSigRep.category, 'all');
    assert.equal(allSigRep.by_category.length, 4);

    const byCat = Object.fromEntries(allSigRep.by_category.map((c) => [c.category, c]));
    assert.equal(byCat.executable.won, 1);
    assert.equal(byCat.executable.lost, 0);
    assert.equal(byCat.executable.win_rate_pct, 100);
    assert.equal(byCat.executable.roi_u, 1);

    // movement had drop_pct +20% on side '1' -> fade strategy predicts '1' loses -> Inter won 2-1 so fade LOST
    assert.equal(byCat.movement.settled_signals, 1);
    assert.equal(byCat.movement.lost, 1);
    assert.equal(byCat.movement.win_rate_pct, 0);

    // flow had sell_pm on Napoli ('1') -> Napoli lost 0-2 -> sell_pm WON
    assert.equal(byCat.flow.settled_signals, 1);
    assert.equal(byCat.flow.won, 1);
    assert.equal(byCat.flow.win_rate_pct, 100);

    // contradiction on Napoli vs Roma: side '2' won (40% BF vs 30% PM) -> BF had lower Brier -> bf_wins = 1
    assert.equal(byCat.contradiction.settled_signals, 1);
    assert.equal(byCat.contradiction.bf_wins, 1);
    assert.equal(byCat.contradiction.pm_wins, 0);

    // Dynamic filter on 'movement'
    const movRep = store.signalResultsReport({ category: 'movement' });
    assert.equal(movRep.category, 'movement');
    assert.equal(movRep.category_summary.category, 'movement');
    assert.equal(movRep.results.length, 1);
    assert.equal(movRep.results[0].fixture_key, 'inter_milan');
    assert.equal(movRep.results[0].signals[0].category, 'movement');
    assert.equal(movRep.results[0].signals[0].signal_result, 'loss');
    assert.ok(Array.isArray(movRep.results[0].market_snapshots) && movRep.results[0].market_snapshots.length > 0);

    // Dynamic filter on /calibration report
    const calContra = store.report({ category: 'contradiction' });
    assert.equal(calContra.category, 'contradiction');
    assert.equal(calContra.category_summary.category, 'contradiction');
    assert.equal(calContra.observations.length, 1);
    assert.equal(calContra.observations[0].fixture_key, 'napoli_roma');
    assert.ok(calContra.observations[0].signals.some((s) => s.category === 'contradiction'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP /api/signals/results?category= and /api/calibration?category= filter dynamically by signal category', async () => {
  const { dir, file } = makeTempObsPath();
  const futureDate = '2026-11-25T20:00:00Z';
  const captureMs = Date.parse('2026-11-25T12:00:00Z');

  const calibration = new CalibrationStore(file);
  calibration.recordFromSignals(
    {
      all_signals: [
        {
          id: 's1',
          fixture_key: 'm_exec',
          home: 'Arsenal',
          away: 'Everton',
          league: 'Premier League',
          date: futureDate,
          category: 'executable',
          category_label: 'Propositions BF×PM',
          market: MarketKey.OneXTwo,
          market_short: '1X2',
          side_label: '1',
          direction: 'buy_pm',
          title: 'Arsenal (1) @ 1.80',
          detail: 'Edge +5 pts',
          recommendation: { prop_odds: 1.8, prop_pct: 55.6, bf_prop_pct: 61, side_label: '1', direction: 'buy_pm' },
          score_sort: 85,
        },
        {
          id: 's2',
          fixture_key: 'm_flow',
          home: 'Nice',
          away: 'Lens',
          league: 'Ligue 1',
          date: futureDate,
          category: 'flow',
          category_label: 'Flux & Retards BF×PM',
          market: MarketKey.OneXTwo,
          market_short: '1X2',
          side_label: '1',
          direction: 'buy_pm',
          title: 'Retard PM sur Nice',
          detail: 'Flux BF actif',
          score_sort: 60,
        },
      ],
    },
    captureMs
  );

  const scraper = { fetch: async () => ({ source: 'live', ageSeconds: 0, error: null, rows: [] }) };
  const polymarket = { quote: async () => null };
  const espn = { many: async () => ({ events: [], errors: [] }) };
  const sportscore = { many: async () => ({ events: [], warnings: [] }) };
  const cfg = { port: 0, polymarketEnabled: false, espnEnabled: true, sportscoreDisabled: true };

  const app = createApp({ cfg, scraper, polymarket, espn, sportscore, calibration });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const flowRes = await fetch(`${baseUrl}/api/signals/results?category=flow`).then((r) => r.json());
    assert.equal(flowRes.ok, true);
    assert.equal(flowRes.category, 'flow');
    assert.equal(flowRes.category_summary.category, 'flow');
    assert.equal(flowRes.by_category.length, 4);
    assert.equal(flowRes.results.length, 1);
    assert.equal(flowRes.results[0].home, 'Nice');

    const calExec = await fetch(`${baseUrl}/api/calibration?category=executable`).then((r) => r.json());
    assert.equal(calExec.ok, true);
    assert.equal(calExec.category, 'executable');
    assert.equal(calExec.category_summary.category, 'executable');
    assert.equal(calExec.by_category.length, 4);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CalibrationStore distinguishes played, pending, no_score matches, computes ROI positive/negative state, and selects best_category by default', async () => {
  const { dir, file } = makeTempObsPath();
  const store = new CalibrationStore(file);
  try {
    const nowMs = Date.parse('2026-11-26T18:00:00Z');
    const pastKo = '2026-11-26T12:00:00Z'; // > 2h30 before nowMs -> past due if still pending
    const futureKo = '2026-11-26T21:00:00Z'; // upcoming -> pending

    // Record comparison rows: 1 settled executable win, 1 settled flow loss, 1 past uncovered league without score source, 1 future upcoming
    store.recordFromComparison(
      [
        {
          fixture_key: 'm_win_exec',
          home: 'Real Madrid',
          away: 'Getafe',
          league: 'LaLiga',
          date: pastKo,
          markets: [
            {
              market: MarketKey.OneXTwo,
              short: '1X2',
              bf_volume: 50000,
              pm_liquidity: 9000,
              pm_usable: true,
              max_abs_gap_pp: 6.0,
              sides: [
                { label: '1', bf_pct: 68, pm_pct: 60, gap_pp: 8.0 },
                { label: 'N', bf_pct: 20, pm_pct: 23, gap_pp: -3.0 },
                { label: '2', bf_pct: 12, pm_pct: 17, gap_pp: -5.0 },
              ],
            },
          ],
          recommendations: [
            {
              market: MarketKey.OneXTwo,
              tier: 'high',
              tier_label: 'Fort',
              direction: 'buy_pm',
              side_label: '1',
              action: 'Real Madrid (1)',
              net_edge_pp: 6.0,
              prop_odds: 1.67,
              prop_pct: 60,
            },
          ],
        },
        {
          fixture_key: 'm_loss_exec',
          home: 'Valencia',
          away: 'Sevilla',
          league: 'LaLiga',
          date: pastKo,
          markets: [
            {
              market: MarketKey.OneXTwo,
              short: '1X2',
              bf_volume: 12000,
              pm_liquidity: 3000,
              pm_usable: true,
              max_abs_gap_pp: 5.0,
              sides: [
                { label: '1', bf_pct: 48, pm_pct: 43, gap_pp: 5.0 },
                { label: 'N', bf_pct: 27, pm_pct: 29, gap_pp: -2.0 },
                { label: '2', bf_pct: 25, pm_pct: 28, gap_pp: -3.0 },
              ],
            },
          ],
        },
      ],
      Date.parse('2026-11-26T09:00:00Z')
    );

    store.recordFromSignals(
      {
        all_signals: [
          {
            id: 'sig-exec-real',
            fixture_key: 'm_win_exec',
            home: 'Real Madrid',
            away: 'Getafe',
            league: 'LaLiga',
            date: pastKo,
            category: 'executable',
            category_label: 'Propositions BF×PM',
            market: MarketKey.OneXTwo,
            market_short: '1X2',
            direction: 'buy_pm',
            side_label: '1',
            title: 'Real Madrid (1) @ 1.67',
            recommendation: { prop_odds: 1.67, prop_pct: 60, bf_prop_pct: 68, side_label: '1', direction: 'buy_pm' },
            score_sort: 95,
          },
          {
            id: 'sig-mov-valencia',
            fixture_key: 'm_loss_exec',
            home: 'Valencia',
            away: 'Sevilla',
            league: 'LaLiga',
            date: pastKo,
            category: 'movement',
            category_label: 'Mouvements 24h',
            market: '1X2',
            market_short: '1X2',
            side_label: '1',
            drop_pct: 12.0,
            title: 'Baisse marquée sur 1 (1X2)',
            score_sort: 60,
          },
          {
            id: 'sig-exec-nosrc',
            fixture_key: 'm_mls_nosrc',
            home: 'Portmore Utd',
            away: 'Mount Pleasant',
            league: 'Jamaican Premier League', // not mapped to ESPN or SportScore -> Sans source (no_score)
            date: pastKo,
            category: 'executable',
            category_label: 'Propositions BF×PM',
            market: MarketKey.OneXTwo,
            market_short: '1X2',
            direction: 'buy_pm',
            side_label: '1',
            title: 'LA Galaxy (1) @ 2.10',
            recommendation: { prop_odds: 2.1, prop_pct: 47.6, bf_prop_pct: 52, side_label: '1', direction: 'buy_pm' },
            score_sort: 75,
          },
          {
            id: 'sig-exec-pending',
            fixture_key: 'm_future_pending',
            home: 'Atletico',
            away: 'Betis',
            league: 'LaLiga',
            date: futureKo,
            category: 'executable',
            category_label: 'Propositions BF×PM',
            market: MarketKey.OneXTwo,
            market_short: '1X2',
            direction: 'buy_pm',
            side_label: '1',
            title: 'Atletico (1) @ 1.75',
            recommendation: { prop_odds: 1.75, prop_pct: 57, bf_prop_pct: 62, side_label: '1', direction: 'buy_pm' },
            score_sort: 80,
          },
        ],
      },
      Date.parse('2026-11-26T09:00:00Z')
    );

    const espnMock = {
      many: async (slugs) => {
        if (!slugs.includes('esp.1')) return { events: [], errors: [] };
        return {
          events: [
            {
              id: 'e-real',
              date: pastKo,
              league_slug: 'esp.1',
              home_team: 'Real Madrid',
              away_team: 'Getafe',
              home_score: 2,
              away_score: 0,
              state: MatchState.Finished,
            },
            {
              id: 'e-val',
              date: pastKo,
              league_slug: 'esp.1',
              home_team: 'Valencia',
              away_team: 'Sevilla',
              home_score: 1, // side '1' won -> fade movement LOST
              away_score: 0,
              state: MatchState.Finished,
            },
          ],
          errors: [],
        };
      },
    };

    await store.settle({ espn: espnMock, sportscore: null, cfg: { espnEnabled: true } }, nowMs);

    const bestRep = store.signalResultsReport({ category: 'best', nowMs });
    assert.equal(bestRep.best_category, 'executable');
    assert.equal(bestRep.category, 'executable');
    assert.equal(bestRep.category_summary.roi_state, 'positive');
    assert.equal(bestRep.category_summary.roi_pct, 67);
    assert.equal(bestRep.category_summary.roi_u, 0.67);
    assert.equal(bestRep.category_summary.settled_matches, 1);
    assert.equal(bestRep.category_summary.played_matches, 2); // 1 settled + 1 past-due no_score
    assert.equal(bestRep.category_summary.pending_matches, 1); // 1 future
    assert.equal(bestRep.category_summary.no_score_matches, 1); // 1 US MLS uncovered

    const noSrcRow = bestRep.results.find((r) => r.fixture_key === 'm_mls_nosrc');
    assert.equal(noSrcRow.is_no_score, true);
    assert.equal(noSrcRow.has_score_source, false);

    const pendingRow = bestRep.results.find((r) => r.fixture_key === 'm_future_pending');
    assert.equal(pendingRow.is_no_score, false);
    assert.equal(pendingRow.match_stage, 'pending');

    const calBest = store.report({ category: 'best', nowMs });
    assert.equal(calBest.best_category, 'executable');
    assert.equal(calBest.category, 'executable');
    assert.equal(calBest.summary.reco_roi_state, 'positive');
    assert.equal(calBest.summary.reco_roi_pct, 67);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Server-side Pro redaction, admin claim/login/pro-preview, Telegram initData + Stars webhook, threshold isolation and pagination', async () => {
  const crypto = await import('node:crypto');
  const { dir, file } = makeTempObsPath();
  const futureDate = new Date(Date.now() + 5 * 3_600_000).toISOString();
  const botToken = '123456:ABC-DEF-test-bot-token';
  const webhookSecret = 'wh-secret-xyz';

  const makeRow = (i) => ({
    home: `TeamH${i}`,
    away: `TeamA${i}`,
    league: 'Ligue 1',
    country: 'fra',
    date: futureDate,
    coef_1: 1.8,
    coef_1_new: 1.75,
    coef_x: 3.7,
    coef_2: 4.5,
    volume_1: 12000,
    volume_x: 2000,
    volume_2: 1500,
  });

  const scraper = {
    fetch: async (key) => ({
      source: 'live',
      ageSeconds: 0,
      error: null,
      rows: key === MarketKey.OneXTwo ? [1, 2, 3, 4, 5].map(makeRow) : [],
    }),
  };

  const polymarket = {
    quote: async (home) => ({
      slug: `${home.toLowerCase()}-match`,
      url: `https://polymarket.com/event/${home.toLowerCase()}`,
      title: `${home} match`,
      volume: 15000,
      volume_24h: 3000,
      liquidity: 350, // < 500 -> triggers pm_liquidity_warning
      markets: {
        [MarketKey.OneXTwo]: {
          liquidity: 350,
          volume: 15000,
          spread: 0.02,
          usable: true,
          outcomes: [
            { label: '1', novig_pct: 50.0, price: 0.50, bid: 0.49, ask: 0.51, spread: 0.02 },
            { label: 'N', novig_pct: 27.0, price: 0.27, bid: 0.26, ask: 0.28, spread: 0.02 },
            { label: '2', novig_pct: 23.0, price: 0.23, bid: 0.22, ask: 0.24, spread: 0.02 },
          ],
        },
      },
    }),
  };

  const espn = { many: async () => ({ events: [], errors: [] }) };
  const sportscore = { many: async () => ({ events: [], warnings: [] }) };
  const calibration = new CalibrationStore(file);
  const cfg = {
    port: 0,
    polymarketEnabled: true,
    espnEnabled: true,
    sportscoreDisabled: true,
    paymentsEnabled: true,
    telegramBotToken: botToken,
    telegramWebhookSecret: webhookSecret,
    telegramProStarsPrice: 1500,
  };

  const app = createApp({ cfg, scraper, polymarket, espn, sportscore, calibration });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Custom thresholds do not pollute shared calibration DB
    const customSig = await fetch(`${baseUrl}/api/signals?preset=strict&minBfVolume=5000`).then((r) => r.json());
    assert.equal(customSig.ok, true);
    assert.equal(calibration.observations.length, 0);

    // 2. Guest receives only 3 unredacted signals & rows >= 3 are redacted
    const guestSig = await fetch(`${baseUrl}/api/signals`).then((r) => r.json());
    assert.equal(guestSig.ok, true);
    assert.equal(guestSig.access.is_pro, false);
    assert.equal(guestSig.access.redacted, true);
    assert.ok(guestSig.all_signals.length >= 5);
    assert.equal(guestSig.all_signals[0].locked, false);
    const firstExec = guestSig.executable_signals[0];
    assert.ok(firstExec.recommendation);
    assert.equal(firstExec.recommendation.pm_liquidity_warning, true);
    assert.equal(
      firstExec.recommendation.ev_net_pct,
      Math.round((firstExec.recommendation.ev_pct - 2.0) * 10) / 10
    );
    assert.equal(guestSig.all_signals[3].locked, true);
    assert.equal(guestSig.all_signals[3].recommendation, null);
    assert.equal(guestSig.all_signals[3].pm_url, null);

    const guestCfg = await fetch(`${baseUrl}/api/configurations`).then((r) => r.json());
    assert.equal(guestCfg.access.redacted, true);
    assert.equal(guestCfg.rows[3].locked, true);
    assert.equal(guestCfg.rows[3].markets.length, 0);

    // 3. First-run admin claim + duplicate claim blocked + pro-preview toggle
    const weakClaim = await fetch(`${baseUrl}/api/auth/admin/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'short' }),
    });
    assert.equal(weakClaim.status, 400);

    const claim = await fetch(`${baseUrl}/api/auth/admin/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'SuperAdminPass2026' }),
    }).then((r) => r.json());
    assert.equal(claim.ok, true);
    assert.ok(claim.token);

    const dupClaim = await fetch(`${baseUrl}/api/auth/admin/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'AnotherAdminPass' }),
    });
    assert.equal(dupClaim.status, 409);

    const adminSig = await fetch(`${baseUrl}/api/signals`, {
      headers: { Authorization: `Bearer ${claim.token}` },
    }).then((r) => r.json());
    assert.equal(adminSig.access.is_pro, true);
    assert.equal(adminSig.access.redacted, false);
    assert.ok(adminSig.all_signals[3].recommendation);

    const previewOff = await fetch(`${baseUrl}/api/auth/admin/pro-preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${claim.token}`,
      },
      body: JSON.stringify({ enabled: false }),
    }).then((r) => r.json());
    assert.equal(previewOff.ok, true);
    assert.equal(previewOff.is_pro, false);

    const previewSig = await fetch(`${baseUrl}/api/signals`, {
      headers: { Authorization: `Bearer ${previewOff.token}` },
    }).then((r) => r.json());
    assert.equal(previewSig.access.is_pro, false);
    assert.equal(previewSig.access.redacted, true);
    assert.equal(previewSig.all_signals[3].locked, true);

    // 4. Telegram initData HMAC login + Telegram Stars webhook subscription unlock
    const authDate = Math.floor(Date.now() / 1000);
    const tgUser = JSON.stringify({ id: 987654321, username: 'alice_tg', first_name: 'Alice' });
    const params = new URLSearchParams({ auth_date: String(authDate), user: tgUser });
    const dcs = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const hash = crypto.createHmac('sha256', secretKey).update(dcs).digest('hex');
    params.set('hash', hash);

    const tgAuth = await fetch(`${baseUrl}/api/auth/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: params.toString() }),
    }).then((r) => r.json());
    assert.equal(tgAuth.ok, true);
    assert.equal(tgAuth.auth.is_pro, false);

    // Bad webhook secret rejected
    const badWh = await fetch(`${baseUrl}/api/billing/telegram-webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret',
      },
      body: JSON.stringify({}),
    });
    assert.equal(badWh.status, 401);

    // Successful payment activates Pro in SQLite
    const payWh = await fetch(`${baseUrl}/api/billing/telegram-webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': webhookSecret,
      },
      body: JSON.stringify({
        message: {
          from: { id: 987654321 },
          successful_payment: {
            currency: 'XTR',
            total_amount: 1500,
            invoice_payload: 'tv_pro:987654321:nonce',
            telegram_payment_charge_id: 'tg_charge_1',
          },
        },
      }),
    }).then((r) => r.json());
    assert.equal(payWh.ok, true);

    const proStatus = await fetch(`${baseUrl}/api/auth/status`, {
      headers: { Authorization: `Bearer ${tgAuth.token}` },
    }).then((r) => r.json());
    assert.equal(proStatus.is_pro, true);

    const proSig = await fetch(`${baseUrl}/api/signals`, {
      headers: { Authorization: `Bearer ${tgAuth.token}` },
    }).then((r) => r.json());
    assert.equal(proSig.access.is_pro, true);
    assert.equal(proSig.access.redacted, false);
    assert.ok(proSig.all_signals[4].recommendation);

    // 5. Pagination on /api/signals/results & /api/calibration
    const sigResPage1 = await fetch(`${baseUrl}/api/signals/results?limit=2&offset=0`).then((r) => r.json());
    assert.equal(sigResPage1.results.length, 2);
    assert.equal(sigResPage1.total_filtered, 5);
    assert.equal(sigResPage1.has_more, true);

    await fetch(`${baseUrl}/api/compare`, {
      headers: { Authorization: `Bearer ${tgAuth.token}` },
    }).then((r) => r.json());

    const page1 = await fetch(`${baseUrl}/api/calibration?limit=2&offset=0`).then((r) => r.json());
    assert.equal(page1.observations.length, 2);
    assert.equal(page1.total_filtered, 5);
    assert.equal(page1.has_more, true);

    const page3 = await fetch(`${baseUrl}/api/calibration?limit=2&offset=4`).then((r) => r.json());
    assert.equal(page3.observations.length, 1);
    assert.equal(page3.has_more, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    calibration.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CalibrationStore settle() mutex prevents concurrent duplicate external provider runs', async () => {
  const { dir, file } = makeTempObsPath();
  const store = new CalibrationStore(file);
  try {
    const pastKo = '2026-11-22T12:00:00Z';
    const captureMs = Date.parse('2026-11-22T10:00:00Z');
    const settleMs = Date.parse('2026-11-22T15:00:00Z');
    store.recordFromComparison(
      [
        {
          fixture_key: 'arsenal_chelsea_mutex',
          home: 'Arsenal',
          away: 'Chelsea',
          league: 'Premier League',
          date: pastKo,
          markets: [
            {
              market: MarketKey.OneXTwo,
              short: '1X2',
              bf_volume: 10000,
              pm_liquidity: 3000,
              pm_usable: true,
              pm_spread_pts: 1.5,
              max_abs_gap_pp: 4.0,
              sides: [
                { label: '1', bf_pct: 60, pm_pct: 56, gap_pp: -4 },
                { label: 'N', bf_pct: 22, pm_pct: 24, gap_pp: 2 },
                { label: '2', bf_pct: 18, pm_pct: 20, gap_pp: 2 },
              ],
            },
          ],
        },
      ],
      captureMs
    );

    let espnCalls = 0;
    const espnMock = {
      many: async () => {
        espnCalls += 1;
        await new Promise((r) => setTimeout(r, 25));
        return {
          events: [
            {
              id: 'e-mutex',
              date: pastKo,
              league_slug: 'eng.1',
              home_team: 'Arsenal',
              away_team: 'Chelsea',
              home_score: 2,
              away_score: 1,
              state: MatchState.Finished,
            },
          ],
          errors: [],
        };
      },
    };

    const [r1, r2] = await Promise.all([
      store.settle({ espn: espnMock, sportscore: null, cfg: { espnEnabled: true } }, settleMs),
      store.settle({ espn: espnMock, sportscore: null, cfg: { espnEnabled: true } }, settleMs),
    ]);
    assert.equal(espnCalls, 3); // 3 day-windows for 1 shared settle run, NOT 6
    assert.equal(r1.settled, 1);
    assert.equal(r2.settled, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


