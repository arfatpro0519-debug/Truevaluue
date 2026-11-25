import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildConfigurationsFromData,
  buildSignalsFromData,
  deriveGoalsProfile,
  GOALS_QUALITY,
} from '../src/configurations.js';
import { MarketKey } from '../src/market.js';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const FUTURE = '2026-11-27T19:00:00Z';

function ouRow(market, favorite) {
  const under = favorite === 'Under';
  return {
    market,
    total_volume: 1000,
    implied: under ? [65, 0, 35] : [35, 0, 65],
    coef: under ? [1.54, 0, 2.86] : [2.86, 0, 1.54],
    coef_new: under ? [1.54, 0, 2.86] : [2.86, 0, 1.54],
    drop: [0, 0, 0],
    volume: [600, 0, 400],
    share: [60, 0, 40],
  };
}

function goalsFixture({ ou15 = 'Under', ou25 = 'Over', ou35 = 'Under' } = {}) {
  return {
    fixture_key: 'goals_quality_fixture',
    home: 'Team A',
    away: 'Team B',
    league: 'Ligue 1',
    country: 'fra',
    date: FUTURE,
    total_volume_bf: 3000,
    bf_markets: {
      [MarketKey.OverUnder15]: ouRow(MarketKey.OverUnder15, ou15),
      [MarketKey.OverUnder25]: ouRow(MarketKey.OverUnder25, ou25),
      [MarketKey.OverUnder35]: ouRow(MarketKey.OverUnder35, ou35),
    },
  };
}

test('2.1 un profil de buts impossible est donnees_incoherentes, hors contradictions et hors 72 signatures', () => {
  const incoherent = deriveGoalsProfile(
    { source_bf: true, favorite: 'Under' },
    { source_bf: true, favorite: 'Over' },
    { source_bf: true, favorite: 'Under' }
  );
  assert.equal(incoherent.quality_status, GOALS_QUALITY.Incoherent);
  assert.equal(incoherent.status, 'atypique'); // alias v1 conservé

  const cfg = buildConfigurationsFromData([goalsFixture()], new Map(), { nowMs: NOW });
  const row = cfg.rows[0];
  assert.equal(row.signature.is_complete, false);
  assert.equal(row.signature.donnees_incoherentes, true);
  assert.ok(!row.signature.code.includes('Atypique'));
  assert.equal(row.axes.concordance.incoherent, 1);
  assert.equal(row.axes.concordance.items.some((i) => i.status === 'donnees_incoherentes'), true);
  // La cause « profil incohérent » n'est PAS une contradiction.
  assert.equal(
    row.axes.concordance.items.filter(
      (i) => i.status === 'contradiction' && i.cause === 'donnees_incoherentes'
    ).length,
    0
  );
  assert.equal(cfg.quality_report.donnees_incoherentes, 1);
  assert.equal(cfg.quality_report.exclues_des_72, 1);
  assert.equal(row.signature.goals_profile, null);

  // Un profil cohérent G1 n'est pas compté comme incohérent.
  const coherent = buildConfigurationsFromData(
    [goalsFixture({ ou15: 'Under', ou25: 'Under', ou35: 'Under' })],
    new Map(),
    { nowMs: NOW }
  );
  assert.equal(coherent.quality_report.donnees_incoherentes, 0);
  assert.equal(coherent.rows[0].signature.goals_profile, 'G1');
});

function pmOutcome(label, pct) {
  return { label, novig_pct: pct, price: pct / 100, bid: (pct - 2) / 100, ask: (pct + 2) / 100, change_1d: 0 };
}

test('2.2 les désaccords Betfair × Polymarket sur plusieurs marchés ne comptent qu’une cause', () => {
  const fixture = {
    fixture_key: 'dedup_fixture',
    home: 'Team A',
    away: 'Team B',
    league: 'Ligue 1',
    country: 'fra',
    date: FUTURE,
    total_volume_bf: 20000,
    bf_markets: {
      [MarketKey.OneXTwo]: {
        market: MarketKey.OneXTwo,
        total_volume: 10000,
        implied: [50, 20, 30],
        coef: [2.0, 5.0, 3.33],
        coef_new: [2.0, 5.0, 3.33],
        drop: [0, 0, 0],
      },
      [MarketKey.Btts]: ouBf('btts', [70, 0, 30]),
      [MarketKey.OverUnder15]: ouBf(MarketKey.OverUnder15, [62, 0, 38]),
      [MarketKey.OverUnder25]: ouBf(MarketKey.OverUnder25, [65, 0, 35]),
      [MarketKey.OverUnder35]: ouBf(MarketKey.OverUnder35, [78, 0, 22]),
    },
  };
  const quote = {
    slug: 'dedup_fixture',
    url: 'https://polymarket.com/event/dedup-fixture',
    liquidity: 12000,
    volume: 20000,
    markets: {
      [MarketKey.OneXTwo]: pmMarket([pmOutcome('1', 30), pmOutcome('N', 20), pmOutcome('2', 50)]),
      [MarketKey.Btts]: pmMarket([pmOutcome('Oui', 35), pmOutcome('Non', 65)]),
      [MarketKey.OverUnder25]: pmMarket([pmOutcome('Under', 40), pmOutcome('Over', 60)]),
    },
  };

  const cfg = buildConfigurationsFromData([fixture], new Map([[fixture.fixture_key, quote]]), {
    nowMs: NOW,
  });
  const conc = cfg.rows[0].axes.concordance;
  // Deux causes distinctes au total : BTTS/profil ET le désaccord BF×PM regroupé.
  assert.equal(conc.causes.length, 2);
  assert.ok(conc.causes.includes('betfair_polymarket'));
  const bfPmItems = conc.items.filter((i) => i.cause === 'betfair_polymarket');
  assert.equal(bfPmItems.length, 1);
  assert.ok(bfPmItems[0].markets.length >= 3);
  assert.equal(conc.contradictions, conc.causes.length);

  const signals = buildSignalsFromData([fixture], new Map([[fixture.fixture_key, quote]]), {
    preset: 'zero',
    nowMs: NOW,
  });
  const contra = signals.configuration_signals.find((s) => s.category === 'contradiction');
  assert.ok(contra);
  assert.equal(contra.contradictions_count, 2);
  assert.equal(contra.causes.length, 2);
  const pmCause = contra.causes.find((c) => c.cause === 'betfair_polymarket');
  assert.ok(pmCause);
  assert.ok(pmCause.markets.length >= 3);
});

function ouBf(market, implied) {
  const underFav = implied[0] > implied[2];
  return {
    market,
    total_volume: 1000,
    implied,
    coef: [underFav ? 1.5 : 2.9, 0, underFav ? 2.9 : 1.5],
    coef_new: [underFav ? 1.5 : 2.9, 0, underFav ? 2.9 : 1.5],
    drop: [0, 0, 0],
    volume: underFav ? [600, 0, 400] : [400, 0, 600],
    share: underFav ? [60, 0, 40] : [40, 0, 60],
  };
}

function pmMarket(outcomes) {
  return { liquidity: 4000, spread: 0.02, usable: true, outcomes };
}
