import assert from 'node:assert/strict';
import test from 'node:test';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CalibrationStore } from '../src/calibration.js';
import { DEFAULT_CALIBRATION_MIN_N, loadConfig } from '../src/config.js';
import { MarketKey } from '../src/market.js';

function withStore(observations, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-phase1-'));
  const file = path.join(dir, 'observations.json');
  try {
    fs.writeFileSync(file, JSON.stringify(observations), 'utf8');
    return fn(new CalibrationStore(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function observation(id, { score, odds = null }) {
  const recommendation = { side_label: '1', action: '1 (Domicile)' };
  if (odds !== null) recommendation.prop_odds = odds;
  return {
    id,
    fixture_key: id,
    home: 'Alpha',
    away: 'Beta',
    market: MarketKey.OneXTwo,
    status: 'settled',
    captured_at: '2026-11-20T19:00:00Z',
    home_score: score[0],
    away_score: score[1],
    recommendation,
    sides: [
      // pm_pct sous 1 : aucune cote exploitable, même en cas de défaite.
      { label: '1', bf_pct: 55, pm_pct: 0.55, gap_pp: 0 },
      { label: 'N', bf_pct: 25, pm_pct: 0.25, gap_pp: 0 },
      { label: '2', bf_pct: 20, pm_pct: 0.2, gap_pp: 0 },
    ],
  };
}

test('1.1 un pari sans cote est exclu du ROI, en gain comme en perte', () => {
  withStore(
    [observation('win_no_odds', { score: [2, 0] }), observation('loss_no_odds', { score: [0, 1] })],
    (store) => {
      const rep = store.report();
      assert.equal(rep.summary.reco_settled, 2);
      assert.equal(rep.summary.reco_roi_u, null);
      assert.equal(rep.summary.reco_roi_pct, null);
      assert.equal(rep.summary.reco_staked_u, 0);
      assert.equal(rep.summary.reco_roi_n, 0);
      for (const o of rep.observations) {
        assert.equal(o.reco_pnl_u, null);
        assert.equal(o.reco_staked_u, 0);
      }
      assert.equal(rep.by_category[0].roi_n, 0);
      store.close();
    }
  );
});

function withSignalStore(records, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-phase1-sig-'));
  const file = path.join(dir, 'observations.json');
  try {
    fs.writeFileSync(
      path.join(dir, 'signal_history.json'),
      JSON.stringify(records),
      'utf8'
    );
    return fn(new CalibrationStore(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function signalRecord(fixture, category, score, extra = {}) {
  return {
    fixture_key: fixture,
    home: 'Alpha',
    away: 'Beta',
    league: 'Ligue 1',
    date: '2026-11-20T20:00:00Z',
    captured_at: '2026-11-20T19:00:00Z',
    status: 'settled',
    home_score: score[0],
    away_score: score[1],
    signals: [
      {
        id: `${category}::${fixture}`,
        category,
        side_label: '1',
        market: '1x2',
        score_sort: 0,
        ...extra,
      },
    ],
  };
}

function comparisonRows(bfPct) {
  return [
    {
      fixture_key: 'match_next',
      home: 'Alpha',
      away: 'Beta',
      league: 'Ligue 1',
      date: '2026-11-25T20:00:00Z',
      markets: [
        {
          market: MarketKey.OneXTwo,
          short: '1X2',
          pm_usable: true,
          sides: [
            { label: '1', bf_pct: bfPct, pm_pct: bfPct - 4, gap_pp: -4 },
            { label: 'N', bf_pct: 25, pm_pct: 27, gap_pp: 2 },
            { label: '2', bf_pct: 20, pm_pct: 22, gap_pp: 2 },
          ],
        },
      ],
    },
  ];
}

test('1.4 le premier prix est conservé, le dernier relevé avant coup d’envoi est séparé', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-phase1-prices-'));
  const file = path.join(dir, 'observations.json');
  const first = Date.parse('2026-11-24T12:00:00Z');
  const last = Date.parse('2026-11-24T13:00:00Z');
  try {
    const store = new CalibrationStore(file);
    assert.equal(store.recordFromComparison(comparisonRows(60), first).added, 1);
    assert.equal(store.recordFromComparison(comparisonRows(70), last).updated, 1);
    const obs = store.observations[0];
    assert.equal(obs.first_seen, new Date(first).toISOString());
    assert.equal(obs.sides[0].bf_pct, 60);
    assert.equal(obs.last_pre_kickoff, new Date(last).toISOString());
    assert.equal(obs.last_pre_kickoff_sides[0].bf_pct, 70);
    store.close();

    const reopened = new CalibrationStore(file);
    assert.equal(reopened.observations[0].sides[0].bf_pct, 60);
    assert.equal(reopened.observations[0].last_pre_kickoff_sides[0].bf_pct, 70);
    reopened.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('1.4 migration rejouable des observations historiques', () => {
  const legacy = observation('legacy', { score: [1, 0], odds: 2 });
  delete legacy.first_seen;
  delete legacy.last_pre_kickoff;
  delete legacy.last_pre_kickoff_sides;
  withStore([legacy], (store) => {
    const obs = store.observations[0];
    assert.equal(obs.first_seen, legacy.captured_at || null);
    assert.equal(obs.last_pre_kickoff, null);
    assert.equal(obs.last_pre_kickoff_sides, null);
    store.close();
  });
});

test('1.3 mouvement et flux : taux de confirmation avec n, jamais de ROI', () => {
  withSignalStore(
    [
      signalRecord('move_ok', 'movement', [2, 0]),
      signalRecord('flow_ko', 'flow', [0, 2], { direction: 'buy_pm' }),
    ],
    (store) => {
      const rep = store.signalResultsReport();
      const byCat = Object.fromEntries(rep.by_category.map((c) => [c.category, c]));
      assert.equal(byCat.movement.confirmation_n, 1);
      assert.equal(byCat.movement.confirmation_rate_pct, 100);
      assert.equal(byCat.movement.roi_n, 0);
      assert.equal(byCat.movement.roi_u, null);
      assert.equal(byCat.flow.confirmation_n, 1);
      assert.equal(byCat.flow.confirmation_rate_pct, 0);
      assert.equal(byCat.flow.roi_u, null);
      assert.equal(rep.summary.signal_confirmation_n, 2);
      assert.equal(rep.summary.signal_confirmation_rate_pct, 50);
      store.close();
    }
  );
});

test('1.2 aucune meilleure catégorie sous le seuil d’échantillon', () => {
  withStore([observation('win_odds', { score: [2, 0], odds: 2 })], (store) => {
    const rep = store.report({ category: 'best' });
    assert.equal(rep.best_category, null);
    assert.equal(rep.category, 'all');
    const small = store.report({ category: 'best', minN: 1 });
    assert.equal(small.best_category, 'executable');
    assert.equal(small.category, 'executable');
    store.close();
  });
});

test('1.2 CALIBRATION_MIN_N est configurable via l’environnement', () => {
  assert.equal(DEFAULT_CALIBRATION_MIN_N, 30);
  assert.equal(loadConfig().calibrationMinN, 30);
  process.env.CALIBRATION_MIN_N = '7';
  try {
    assert.equal(loadConfig().calibrationMinN, 7);
  } finally {
    delete process.env.CALIBRATION_MIN_N;
  }
});

test('1.1 un pari avec cote reste valorisé dans les deux sens', () => {
  withStore(
    [
      observation('win_odds', { score: [2, 0], odds: 2 }),
      observation('loss_odds', { score: [0, 1], odds: 2 }),
    ],
    (store) => {
      const rep = store.report();
      assert.equal(rep.summary.reco_roi_u, 0);
      assert.notEqual(rep.summary.reco_roi_u, null);
      assert.equal(rep.summary.reco_roi_n, 2);
      assert.equal(rep.by_category[0].roi_n, 2);
      store.close();
    }
  );
});
