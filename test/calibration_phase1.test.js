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
