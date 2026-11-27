import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GapSnapshotsStore } from '../src/gapSnapshots.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-gap-'));
  return { dir, file: path.join(dir, 'gap_snapshots.json') };
}

test('gap_snapshots enregistre de vrais points et purge au-delà de 7 jours', () => {
  const { file } = tmpStore();
  const store = new GapSnapshotsStore({ filePath: file });
  const now = Date.parse('2026-11-25T12:00:00Z');

  assert.equal(
    store.recordCompared(
      {
        fixture_key: 'a-b',
        markets: [
          {
            market: '1x2',
            sides: [
              { label: '1', bf_pct: 62, pm_norm_prob_pct: 55 },
              { label: '2', bf_pct: 30, pm_norm_prob_pct: null },
            ],
          },
        ],
      },
      new Date(now)
    ),
    1
  );
  store.append({
    fixture_key: 'a-b',
    market: '1x2',
    side: '1',
    ts: new Date(now - 8 * 24 * 3600 * 1000).toISOString(),
    bf_pct: 60,
    pm_pct: 54,
  });
  assert.equal(store.purge(now), 1);

  const series = store.series('a-b', '1x2', '1');
  assert.equal(series.length, 1);
  assert.equal(series[0].bf_pct, 62);
  assert.equal(series[0].pm_pct, 55);
  assert.equal(series[0].ecart_pts, 7);
  assert.equal(store.status().storage_mode, 'json');

  const reopened = new GapSnapshotsStore({ filePath: file });
  assert.equal(reopened.series('a-b', '1x2', '1').length, 1);
});

test('gap_snapshots ignore les valeurs inchangées et n’écrit qu’une fois par lot', () => {
  const { file } = tmpStore();
  const store = new GapSnapshotsStore({ filePath: file });
  const now = Date.parse('2026-11-25T12:00:00Z');
  const compared = {
    fixture_key: 'a-b',
    markets: [
      {
        market: '1x2',
        sides: [
          { label: '1', bf_pct: 62, pm_norm_prob_pct: 55 },
          { label: 'X', bf_pct: 24, pm_norm_prob_pct: 22 },
          { label: '2', bf_pct: 14, pm_norm_prob_pct: 23 },
        ],
      },
    ],
  };

  assert.equal(store.recordCompared(compared, new Date(now)), 3);
  assert.equal(store.recordCompared(compared, new Date(now + 60_000)), 0);
  assert.equal(store.rows.length, 3);

  const changed = {
    fixture_key: 'a-b',
    markets: [
      {
        market: '1x2',
        sides: [{ label: '1', bf_pct: 63, pm_norm_prob_pct: 55 }],
      },
    ],
  };
  assert.equal(store.recordCompared(changed, new Date(now + 120_000)), 1);
  assert.equal(store.rows.length, 4);
  assert.equal(store.series('a-b', '1x2', '1').length, 2);

  // Le fichier reste compact (pas d'indentation) et se recharge à l'identique.
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('\n  {'));
  const reopened = new GapSnapshotsStore({ filePath: file });
  assert.equal(reopened.rows.length, 4);
});

test('recordBatch n’écrit le fichier qu’une seule fois pour tout un lot', () => {
  const { file } = tmpStore();
  const store = new GapSnapshotsStore({ filePath: file });
  let writes = 0;
  const original = store._writeJson.bind(store);
  store._writeJson = () => {
    writes += 1;
    original();
  };
  const list = [
    {
      fixture_key: 'a-b',
      markets: [{ market: '1x2', sides: [{ label: '1', bf_pct: 60, pm_norm_prob_pct: 55 }] }],
    },
    {
      fixture_key: 'c-d',
      markets: [{ market: '1x2', sides: [{ label: '1', bf_pct: 40, pm_norm_prob_pct: 45 }] }],
    },
  ];
  assert.equal(store.recordBatch(list), 2);
  assert.equal(writes, 1);
  assert.equal(store.rows.length, 2);
});
