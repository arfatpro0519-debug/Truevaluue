import assert from 'node:assert/strict';
import test from 'node:test';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CalibrationStore } from '../src/calibration.js';
import { MarketKey } from '../src/market.js';

test('les observations, réglages et abonnements survivent à une réouverture du stockage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-store-'));
  const file = path.join(dir, 'observations.json');
  try {
    const first = new CalibrationStore(file);
    first.observations = [
      {
        id: 'match::1x2',
        fixture_key: 'match',
        market: MarketKey.OneXTwo,
        status: 'pending',
        captured_at: new Date().toISOString(),
        sides: [
          { label: '1', bf_pct: 50, pm_pct: 47, gap_pp: -3 },
          { label: 'N', bf_pct: 25, pm_pct: 27, gap_pp: 2 },
          { label: '2', bf_pct: 25, pm_pct: 26, gap_pp: 1 },
        ],
      },
    ];
    first._save();
    assert.equal(first.setSetting('cle_test', 'valeur'), true);
    assert.ok(first.upsertSubscription({ telegramUserId: '42' }));
    first.close();

    const second = new CalibrationStore(file);
    assert.equal(second.observations.length, 1);
    assert.equal(second.getSetting('cle_test'), 'valeur');
    assert.equal(second.getSubscription('42')?.status, 'active');
    second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
