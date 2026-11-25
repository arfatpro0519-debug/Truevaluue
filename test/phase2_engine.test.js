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
