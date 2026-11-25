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
