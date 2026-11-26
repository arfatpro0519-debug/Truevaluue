import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server.js';
import { CalibrationStore } from '../src/calibration.js';
import { createCloudflareStorage } from '../src/cloudflareStorage.js';

test('Cloudflare KV : hydratation et sauvegarde des 4 fichiers sans dépendance', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cf-'));
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === 'PUT') return { ok: true, status: 200 };
    if (url.includes('gap_snapshots.json')) return { ok: false, status: 404 };
    return { ok: true, status: 200, text: async () => '[]\n' };
  };
  const cfg = {
    storageBackend: 'cloudflare',
    cloudflareAccountId: 'acc',
    cloudflareKvNamespaceId: 'ns',
    cloudflareApiToken: 'token',
  };
  const store = createCloudflareStorage({ cfg, fetchImpl });
  assert.equal(store.enabled, true);
  assert.equal(store.backend, 'cloudflare_kv');
  assert.deepEqual(store.missing, []);

  const hydrated = await store.hydrate(dir);
  assert.equal(hydrated.loaded.length, 3);
  assert.ok(fs.existsSync(path.join(dir, 'observations.json')));
  assert.equal(fs.existsSync(path.join(dir, 'gap_snapshots.json')), false);

  const flushed = await store.flush(dir);
  assert.deepEqual(flushed.saved, ['observations.json', 'signal_history.json', 'store-meta.json'].filter((f) => fs.existsSync(path.join(dir, f))));
  assert.ok(calls.every((c) => c.url.includes('/accounts/acc/storage/kv/namespaces/ns/values/')));
  assert.ok(calls.every((c) => c.options.headers.Authorization === 'Bearer token'));
});

test('Cloudflare KV : backend local et variables manquantes', async () => {
  const disabled = createCloudflareStorage({ cfg: { storageBackend: 'local' } });
  assert.equal(disabled.enabled, false);
  assert.deepEqual(disabled.missing, []);
  const incomplete = createCloudflareStorage({ cfg: { storageBackend: 'cloudflare' } });
  assert.equal(incomplete.enabled, false);
  assert.ok(incomplete.missing.includes('CLOUDFLARE_API_TOKEN'));
  assert.equal((await incomplete.flush('/tmp')).saved.length, 0);
});

test('Cron Render : secret X-Cron-Secret, sync puis flush KV', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cron-'));
  const cfg = {
    port: 0,
    adminPasscode: 'test-admin-secret-123',
    cronSecret: 'cron-secret-test',
    storageBackend: 'cloudflare',
    syncMode: 'external',
  };
  const flushed = [];
  const cloudflare = {
    enabled: true,
    flush: async (dataDir) => {
      flushed.push(dataDir);
      return { saved: ['observations.json'] };
    },
  };
  const app = createApp({
    cfg,
    calibration: new CalibrationStore(path.join(dir, 'observations.json')),
    cloudflare,
    scraper: {
      fetch: async () => ({ rows: [], error: null, ageSeconds: 0 }),
      cached: () => null,
    },
    polymarket: { quote: async () => null, cache: new Map() },
    espn: { many: async () => ({ events: [] }) },
    sportscore: { many: async () => ({ events: [] }) },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const noSecret = await fetch(`${base}/api/cron/sync`, { method: 'POST' });
    assert.equal(noSecret.status, 401);
    const bad = await fetch(`${base}/api/cron/sync`, {
      method: 'POST',
      headers: { 'X-Cron-Secret': 'mauvais' },
    });
    assert.equal(bad.status, 401);
    const ok = await fetch(`${base}/api/cron/sync`, {
      method: 'POST',
      headers: { 'X-Cron-Secret': 'cron-secret-test', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.stockage, { saved: ['observations.json'] });
    assert.equal(flushed.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
