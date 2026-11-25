import assert from 'node:assert/strict';
import test from 'node:test';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { CalibrationStore } from '../src/calibration.js';
import { enrich, fixtureKey, normalizeTeam, parseKickoff } from '../src/enrich.js';
import {
  EspnResultsClient,
  findEspnMatch,
  parseEspnEvent,
  similarity,
  slugForCompetition,
} from '../src/espn.js';
import { ALL_MARKETS, MarketKey, MarketShape, marketDef } from '../src/market.js';
import { MatchState, Source } from '../src/model.js';
import {
  eventMatches,
  parsePolymarketEvent,
  PolymarketBook,
  summarizeRawEvent,
} from '../src/polymarket.js';
import { extractPayload, Scraper } from '../src/scrape.js';
import {
  competitionSlugs,
  findSportScoreMatch,
  parseSportScoreFixture,
  SportScoreClient,
} from '../src/sportscore.js';

async function withServer(sources, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-src-'));
  const calibration = sources.calibration || new CalibrationStore(path.join(dir, 'observations.json'));
  const cfg = { adminPasscode: 'test-admin-secret-123', ...(sources.cfg || {}) };
  const app = createApp({ ...sources, cfg, calibration });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    calibration.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('extractPayload parses embedded Arbworld JSON payload', () => {
  const html = `<html><script>window.__DATA = {"success":true,"data_updated_at":"2026-11-22 10:00","data":[{"home":"Arsenal","away":"Chelsea"}]};</script></html>`;
  const parsed = extractPayload(html);
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.length, 1);
  assert.equal(parsed.data[0].home, 'Arsenal');
  assert.equal(extractPayload('<html>no json</html>'), null);
});

test('Scraper handles live fetch, fresh cache, and 304 revalidation', async () => {
  let calls = 0;
  const transport = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        status: 200,
        body: `{"success":true,"data_updated_at":"2026-11-22","data":[{"home":"PSG","away":"Lyon","coef_1":1.5,"coef_x":4.2,"coef_2":6.0,"volume_1":8000,"volume_x":1200,"volume_2":800}]}`,
        etag: '"abc"',
        lastModified: null,
        retryAfter: null,
      };
    }
    return { status: 304, body: '', etag: '"abc"', lastModified: null, retryAfter: null };
  };

  const scraper = new Scraper('https://arbworld.net/fr/moneyway', { ttlSecs: 20 }, transport);
  const first = await scraper.fetch('1x2');
  assert.equal(first.source, Source.Live);
  assert.equal(first.rows.length, 1);

  const cached = await scraper.fetch('1x2');
  assert.equal(cached.source, Source.Cache);
  assert.equal(calls, 1);

  const forced = await scraper.fetch('1x2', true);
  assert.equal(forced.source, Source.Cache);
  assert.equal(calls, 2);
});

test('enrich normalizes 1X2, two-way, and multi Arbworld rows without signal scoring', () => {
  assert.equal(ALL_MARKETS.length, 10);
  assert.equal(marketDef(MarketKey.OneXTwo).shape, MarketShape.ThreeWay);

  const rows1x2 = enrich(
    [
      {
        home: 'Arsenal',
        away: 'Chelsea',
        league: 'Premier League',
        country: 'eng',
        date: '2026-11-22T16:30:00Z',
        market_id: 12345,
        selection_id: 67890,
        coef_1: 2.0,
        coef_1_new: 1.85,
        coef_x: 3.5,
        coef_2: 4.0,
        volume_1: 6000,
        volume_x: 2000,
        volume_2: 2000,
      },
    ],
    MarketKey.OneXTwo,
    Source.Live,
    0
  );
  assert.equal(rows1x2.length, 1);
  assert.equal(rows1x2[0].total_volume, 10000);
  assert.deepEqual(rows1x2[0].share, [60, 20, 20]);
  assert.equal(rows1x2[0].coef_new[0], 1.85);
  assert.equal(rows1x2[0].signal_type, undefined);
  assert.equal(rows1x2[0].smart_money_score, undefined);

  const rowsCs = enrich(
    [
      {
        home: 'Arsenal',
        away: 'Chelsea',
        date: '2026-11-22T16:30:00Z',
        outcomes: [
          { label: '1 - 0', coef: 7.0, coef_new: 6.8, volume: 400 },
          { label: '1 - 1', coef: 6.5, coef_new: 6.5, volume: 600 },
        ],
      },
    ],
    MarketKey.CorrectScore,
    Source.Live,
    0
  );
  assert.equal(rowsCs[0].total_volume, 1000);
  assert.equal(rowsCs[0].outcomes[0].label, '1 - 1');
  assert.equal(rowsCs[0].outcomes[0].pct, 60);
});

test('team normalization and kickoff parsing work cleanly', () => {
  assert.equal(normalizeTeam('FC Bayern München'), 'bayernmunchen');
  assert.equal(normalizeTeam('Univ Catolica (Chile)'), 'univcatolica');
  assert.equal(fixtureKey('Man Utd', 'AS Monaco'), 'manunited_vs_monaco');
  assert.equal(parseKickoff('2026-11-22T15:00:00Z').toISOString(), '2026-11-22T15:00:00.000Z');
  assert.equal(similarity('FC Barcelona', 'Barcelona'), 1.0);
  assert.ok(similarity('Manchester United', 'Man Utd') > 0.55);
});

test('Polymarket multi-market parsing and event matching', () => {
  const kickoff = parseKickoff('2026-11-22T19:00:00Z');
  assert.equal(
    eventMatches('Arsenal', 'Chelsea', kickoff, 'Arsenal vs. Chelsea', 'arsenal-vs-chelsea', '2026-11-22T19:00:00Z'),
    true
  );
  assert.equal(
    eventMatches('Arsenal', 'Chelsea', kickoff, 'Arsenal (W) vs. Chelsea (W)', 'arsenal-women-chelsea', '2026-11-22T19:00:00Z'),
    false
  );
  assert.equal(
    eventMatches('Colo Colo', 'Catolica (Chile)', kickoff, 'Colo-Colo vs. Universidad Catolica', 'colo-cat-2026', '2026-11-22T19:00:00Z'),
    true
  );

  const event = {
    slug: 'arsenal-vs-chelsea',
    title: 'Arsenal vs. Chelsea',
    volume: 50000,
    liquidity: 12000,
    markets: [
      { question: 'Will Arsenal win?', groupItemTitle: 'Arsenal', bestBid: 0.54, bestAsk: 0.56, liquidity: 5000, volume: 20000 },
      { question: 'Will it be a draw?', groupItemTitle: 'Draw', bestBid: 0.24, bestAsk: 0.26, liquidity: 3000, volume: 10000 },
      { question: 'Will Chelsea win?', groupItemTitle: 'Chelsea', bestBid: 0.19, bestAsk: 0.21, liquidity: 4000, volume: 15000 },
      { question: 'Total goals Over/Under 2.5', outcomes: ['Over', 'Under'], outcomePrices: ['0.52', '0.48'], bestBid: 0.51, bestAsk: 0.53, liquidity: 3000 },
      { question: 'Both teams to score?', outcomes: ['Yes', 'No'], outcomePrices: ['0.58', '0.42'], bestBid: 0.57, bestAsk: 0.59, liquidity: 2500 },
    ],
  };

  const parsed = parsePolymarketEvent(event, 'Arsenal', 'Chelsea');
  assert.equal(parsed.outcomes.length, 3);
  assert.ok(parsed.markets[MarketKey.OneXTwo]);
  assert.ok(parsed.markets[MarketKey.OverUnder25]);
  assert.ok(parsed.markets[MarketKey.Btts]);

  const rawSummary = summarizeRawEvent(event);
  assert.equal(rawSummary.raw_markets.length, 5);
  assert.ok(rawSummary.parsed_markets[MarketKey.OneXTwo]);

  const roversEvent = {
    slug: 'elc-bur-bbr-2026-11-22',
    title: 'Burnley FC vs. Blackburn Rovers FC',
    volume: 10000,
    liquidity: 400000,
    markets: [
      { question: 'Will Burnley FC win on 2026-11-22?', groupItemTitle: 'Burnley FC', bestBid: 0.52, bestAsk: 0.53, liquidity: 150000 },
      { question: 'Will Burnley FC vs. Blackburn Rovers FC end in a draw?', groupItemTitle: 'Draw (Burnley FC vs. Blackburn Rovers FC)', bestBid: 0.25, bestAsk: 0.26, liquidity: 120000 },
      { question: 'Will Blackburn Rovers FC win on 2026-11-22?', groupItemTitle: 'Blackburn Rovers FC', bestBid: 0.22, bestAsk: 0.23, liquidity: 130000 },
      { question: 'Spread: Blackburn Rovers FC (-1.5)', groupItemTitle: 'Blackburn Rovers FC (-1.5)', outcomes: ['Blackburn Rovers FC', 'Burnley FC'], outcomePrices: ['0.08', '0.92'], bestBid: 0.07, bestAsk: 0.09, liquidity: 20000 },
      { question: 'Burnley FC vs. Blackburn Rovers FC: Blackburn Rovers FC O/U 1.5', groupItemTitle: 'Blackburn Rovers FC O/U 1.5', outcomes: ['Over', 'Under'], outcomePrices: ['0.30', '0.70'], bestBid: 0.29, bestAsk: 0.31, liquidity: 15000 },
      { question: 'Burnley FC vs. Blackburn Rovers FC: O/U 1.5', groupItemTitle: 'O/U 1.5', outcomes: ['Over', 'Under'], outcomePrices: ['0.785', '0.215'], bestBid: 0.78, bestAsk: 0.79, liquidity: 70000 },
    ],
  };
  const roversParsed = parsePolymarketEvent(roversEvent, 'Burnley', 'Blackburn');
  assert.equal(roversParsed.outcomes.length, 3);
  assert.equal(roversParsed.markets[MarketKey.OneXTwo].outcomes.find((o) => o.label === 'N').bid, 0.25);
  assert.equal(roversParsed.markets[MarketKey.OneXTwo].outcomes.find((o) => o.label === '2').bid, 0.22);
  const ou15 = roversParsed.markets[MarketKey.OverUnder15];
  assert.ok(ou15);
  assert.equal(ou15.outcomes.find((o) => o.label === 'Over').bid, 0.78);
  assert.equal(Math.round(ou15.outcomes.find((o) => o.label === 'Under').bid * 100) / 100, 0.21);

  const htOuPollutedEvent = {
    slug: 'epl-bre-eve-more-markets',
    title: 'Brentford FC vs. Everton FC - More Markets',
    volume: 12000,
    liquidity: 4000,
    markets: [
      {
        question: 'Brentford FC vs. Everton FC: 1st Half O/U 1.5',
        groupItemTitle: '1st Half O/U 1.5',
        outcomes: '["Over", "Under"]',
        outcomePrices: '["0.355", "0.645"]',
        bestBid: 0.35,
        bestAsk: 0.36,
        liquidity: 1500,
      },
      {
        question: 'Brentford FC vs. Everton FC: 1st Half O/U 2.5',
        groupItemTitle: '1st Half O/U 2.5',
        outcomes: '["Over", "Under"]',
        outcomePrices: '["0.125", "0.875"]',
        bestBid: 0.12,
        bestAsk: 0.13,
        liquidity: 1200,
      },
      {
        question: 'Brentford FC vs. Everton FC: 1st Half Odd/Even',
        groupItemTitle: '1st Half Odd/Even',
        outcomes: '["Odd", "Even"]',
        outcomePrices: '["0.49", "0.51"]',
        bestBid: 0.48,
        bestAsk: 0.50,
        liquidity: 1000,
      },
    ],
  };
  const htClean = parsePolymarketEvent(htOuPollutedEvent, 'Brentford', 'Everton');
  assert.equal(htClean.outcomes.length, 0);
  assert.equal(htClean.markets[MarketKey.OneXTwo], undefined);
  assert.equal(htClean.markets[MarketKey.HalfTime], undefined);

  // Exact Score with phantom unbid asks (bid=undefined, ask=0.766 -> outcomePrices=0.383) must be excluded in favor of liquid scores
  const csPhantomEvent = {
    slug: 'ucl-psg-rom-2026-11-25-exact-score',
    title: 'Paris Saint-Germain FC vs. AS Roma - Exact Score',
    volume: 2000,
    liquidity: 80000,
    markets: [
      {
        question: 'Exact Score: Paris Saint-Germain FC 5 - 3 AS Roma?',
        groupItemTitle: 'Paris Saint-Germain FC 5 - 3 AS Roma',
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0.25", "0.75"]',
        bestAsk: 0.50,
        spread: 0.50,
        liquidity: 1000,
      },
      {
        question: 'Exact Score: Paris Saint-Germain FC 0 - 0 AS Roma?',
        groupItemTitle: 'Paris Saint-Germain FC 0 - 0 AS Roma',
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0.383", "0.617"]',
        bestAsk: 0.766,
        spread: 0.766,
        liquidity: 1000,
      },
      {
        question: 'Exact Score: Paris Saint-Germain FC 1 - 0 AS Roma?',
        groupItemTitle: 'Paris Saint-Germain FC 1 - 0 AS Roma',
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0.065", "0.935"]',
        bestBid: 0.06,
        bestAsk: 0.07,
        spread: 0.01,
        liquidity: 5000,
      },
    ],
  };
  const csClean = parsePolymarketEvent(csPhantomEvent, 'Paris St-G', 'Roma');
  const csMkt = csClean.markets[MarketKey.CorrectScore];
  assert.ok(csMkt);
  assert.equal(csMkt.outcomes.length, 1);
  assert.equal(csMkt.outcomes[0].label, '1-0');
  assert.equal(csMkt.outcomes[0].novig_pct, 6.5);
  assert.equal(csMkt.usable, true);
});

test('ESPN and SportScore parsing and matching', () => {
  assert.equal(slugForCompetition('Premier League'), 'eng.1');
  assert.equal(slugForCompetition('UEFA Champions League'), 'uefa.champions');
  assert.equal(slugForCompetition('AFC Champions League'), 'afc.champions');
  assert.equal(slugForCompetition('Danish Superliga'), 'den.1');
  assert.equal(slugForCompetition('Chilean Primera Division'), 'chi.1');
  assert.equal(slugForCompetition('Paraguayan Primera Division'), 'par.1');
  assert.equal(slugForCompetition('Ecuadorian Serie A'), 'ecu.1');
  assert.equal(slugForCompetition('Scottish Premiership'), 'sco.1');
  assert.equal(slugForCompetition('Jamaican Premier League'), null);
  assert.equal(slugForCompetition('Algerian Ligue 1'), null);
  assert.equal(slugForCompetition('Peruvian Segunda Division'), null);
  assert.equal(slugForCompetition('Venezuelan Primera Division'), null);
  assert.deepEqual(competitionSlugs('Italian Serie C'), ['italian-serie-c']);

  const espnEv = parseEspnEvent(
    {
      id: '9001',
      date: '2026-11-22T15:00:00Z',
      status: { type: { state: 'post', completed: true, detail: 'FT' } },
      competitions: [
        {
          competitors: [
            { homeAway: 'home', score: '2', linescores: [{ value: 1 }], team: { displayName: 'Arsenal' } },
            { homeAway: 'away', score: '1', linescores: [{ value: 0 }], team: { displayName: 'Chelsea' } },
          ],
        },
      ],
    },
    'eng.1'
  );
  assert.equal(espnEv.state, MatchState.Finished);
  assert.equal(espnEv.home_score, 2);
  assert.equal(espnEv.away_score, 1);
  assert.equal(espnEv.home_ht, 1);
  assert.ok(findEspnMatch('Arsenal', 'Chelsea', '2026-11-22T15:00:00Z', 'eng.1', [espnEv]));

  const ssEv = parseSportScoreFixture(
    {
      home: 'Padova',
      away: 'Vicenza',
      time: '2026-11-22T14:00:00Z',
      status: 'finished',
      home_score: 1,
      away_score: 0,
      competition: 'Serie C',
    },
    'italian-serie-c'
  );
  assert.equal(ssEv.state, MatchState.Finished);
  assert.equal(ssEv.home_score, 1);
  assert.ok(findSportScoreMatch('Padova', 'Vicenza', '2026-11-22T14:00:00Z', 'Italian Serie C', [ssEv]));
});

test('HTTP server exposes the 4 raw data source endpoints and static UI cleanly', async () => {
  const scraper = new Scraper('https://arbworld.net/fr/moneyway', { ttlSecs: 60 }, async () => ({
    status: 200,
    body: `{"success":true,"data_updated_at":"2026-11-22","data":[{"home":"Arsenal","away":"Chelsea","league":"Premier League","country":"eng","date":"2026-11-22T16:30:00Z","coef_1":2.0,"coef_x":3.4,"coef_2":3.8,"volume_1":3000,"volume_x":1000,"volume_2":1000}]}`,
    etag: null,
    lastModified: null,
    retryAfter: null,
  }));

  const polymarket = new PolymarketBook();
  polymarket.search = async (q) => [
    {
      id: 'pm-1',
      slug: 'arsenal-vs-chelsea',
      url: 'https://polymarket.com/event/arsenal-vs-chelsea',
      title: q ? `Result for ${q}` : 'Arsenal vs. Chelsea',
      start_time: '2026-11-22T16:30:00Z',
      closed: false,
      volume: 42000,
      volume_24h: 8000,
      liquidity: 9000,
      open_interest: 12000,
      raw_markets: [],
      parsed_markets: null,
    },
  ];
  polymarket.quote = async () => ({
    slug: 'arsenal-vs-chelsea',
    title: 'Arsenal vs. Chelsea',
    outcomes: [{ label: '1', price: 0.55, novig_pct: 55 }],
    markets: {},
  });

  const espn = new EspnResultsClient();
  espn.many = async (slugs) => ({
    events: [
      {
        id: 'e1',
        name: 'Arsenal at Chelsea',
        date: '2026-11-22T16:30:00Z',
        date_label: '22 nov. 16:30',
        league_slug: slugs[0] || 'eng.1',
        league_name: 'Premier League',
        home_team: 'Chelsea',
        away_team: 'Arsenal',
        home_score: 1,
        away_score: 2,
        home_ht: 0,
        away_ht: 1,
        state: MatchState.Finished,
        status_detail: 'FT',
      },
    ],
    errors: [],
  });

  const sportscore = new SportScoreClient();
  sportscore.many = async () => ({
    events: [
      {
        id: 'ss-1',
        name: 'Padova vs Vicenza',
        date: '2026-11-22T14:00:00Z',
        date_label: '22 nov. 14:00',
        league_slug: 'italian-serie-c',
        league_name: 'Serie C',
        home_team: 'Padova',
        away_team: 'Vicenza',
        home_score: 1,
        away_score: 0,
        home_ht: null,
        away_ht: null,
        state: MatchState.Finished,
        status_detail: 'FT',
      },
    ],
    warnings: [],
  });

  const cfg = {
    port: 0,
    polymarketEnabled: true,
    espnEnabled: true,
    sportscoreDisabled: false,
  };

  await withServer({ cfg, scraper, polymarket, espn, sportscore }, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.deepEqual(health.sources, ['arbworld', 'polymarket', 'espn', 'sportscore']);

    // Unauthenticated source inspection must be rejected
    const unauthArb = await fetch(`${baseUrl}/api/sources/arbworld?market=1x2`);
    assert.equal(unauthArb.status, 401);

    const loginRes = await fetch(`${baseUrl}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'test-admin-secret-123' }),
    }).then((r) => r.json());
    assert.equal(loginRes.ok, true);
    const adminHeaders = { Authorization: `Bearer ${loginRes.token}` };

    const arb = await fetch(`${baseUrl}/api/sources/arbworld?market=1x2`, { headers: adminHeaders }).then((r) => r.json());
    assert.equal(arb.ok, true);
    assert.equal(arb.count, 1);
    assert.equal(arb.rows[0].home, 'Arsenal');

    const badArb = await fetch(`${baseUrl}/api/sources/arbworld?market=invalid`, { headers: adminHeaders });
    assert.equal(badArb.status, 400);

    const pm = await fetch(`${baseUrl}/api/sources/polymarket?q=Arsenal`, { headers: adminHeaders }).then((r) => r.json());
    assert.equal(pm.ok, true);
    assert.equal(pm.events.length, 1);

    const espnRes = await fetch(`${baseUrl}/api/sources/espn?league=eng.1&date=2026-11-22`, { headers: adminHeaders }).then((r) => r.json());
    assert.equal(espnRes.ok, true);
    assert.equal(espnRes.count, 1);

    const badEspn = await fetch(`${baseUrl}/api/sources/espn?league=../../etc/passwd`, { headers: adminHeaders });
    assert.equal(badEspn.status, 400);

    const ssRes = await fetch(`${baseUrl}/api/sources/sportscore?slug=italian-serie-c&date=2026-11-22`, { headers: adminHeaders }).then((r) => r.json());
    assert.equal(ssRes.ok, true);
    assert.equal(ssRes.count, 1);

    const badSs = await fetch(`${baseUrl}/api/sources/sportscore?slug=bad/slug!`, { headers: adminHeaders });
    assert.equal(badSs.status, 400);

    const htmlRes = await fetch(`${baseUrl}/`).then((r) => r.text());
    assert.ok(htmlRes.includes('Truevalue'));
    assert.ok(htmlRes.includes('Analyse statistique'));
    assert.ok(htmlRes.includes('18+'));
    assert.ok(htmlRes.includes('Écarts'));
    assert.ok(htmlRes.includes('Bilan'));
    assert.ok(htmlRes.includes('Matchs'));
    assert.ok(htmlRes.includes('type="module" src="/app.js"'));

    // Safe module asset serving + path traversal blocked
    const modJs = await fetch(`${baseUrl}/modules/state.js`);
    assert.equal(modJs.status, 200);
    const badMod = await fetch(`${baseUrl}/modules/..%2Fserver.js`);
    assert.ok(badMod.status === 400 || badMod.status === 404);
  });
});

test('parsePolymarketEvent guards against crossed bestBid > bestAsk and exposes clob_token_id', () => {
  const parsed = parsePolymarketEvent({
    id: 'ev-cross',
    slug: 'arsenal-vs-chelsea',
    title: 'Arsenal vs Chelsea',
    markets: [
      {
        id: 'm1',
        question: 'Will Arsenal win?',
        groupItemTitle: 'Arsenal',
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.55","0.45"]',
        clobTokenIds: '["tok-yes-1","tok-no-1"]',
        bestBid: 0.72,
        bestAsk: 0.50,
        liquidity: 1200,
        volume: 5000,
        acceptingOrders: true,
        active: true,
        closed: false,
      },
      {
        id: 'm2',
        question: 'Draw?',
        groupItemTitle: 'Draw',
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.25","0.75"]',
        clobTokenIds: '["tok-draw-1","tok-draw-n"]',
        bestBid: 0.24,
        bestAsk: 0.26,
        liquidity: 1200,
        volume: 3000,
        acceptingOrders: true,
        active: true,
        closed: false,
      },
      {
        id: 'm3',
        question: 'Will Chelsea win?',
        groupItemTitle: 'Chelsea',
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.20","0.80"]',
        clobTokenIds: '["tok-away-1","tok-away-n"]',
        bestBid: 0.19,
        bestAsk: 0.21,
        liquidity: 1200,
        volume: 2000,
        acceptingOrders: true,
        active: true,
        closed: false,
      },
    ],
  }, 'Arsenal', 'Chelsea');

  const mkt = parsed.markets[MarketKey.OneXTwo];
  assert.ok(mkt);
  const home = mkt.outcomes.find((o) => o.label === '1');
  assert.ok(home);
  assert.equal(home.clob_token_id, 'tok-yes-1');
  assert.ok(home.bid <= home.ask, `Expected bid (${home.bid}) <= ask (${home.ask})`);
  assert.ok(home.spread >= 0);
});
