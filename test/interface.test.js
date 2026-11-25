import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server.js';
import { CalibrationStore } from '../src/calibration.js';

const ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');

function makeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ui-'));
  const cfg = {
    port: 0,
    adminPasscode: 'test-admin-secret-123',
    paymentsEnabled: 0,
    telegramWebhookSecret: 'secret',
  };
  const calibration = new CalibrationStore(path.join(dir, 'observations.json'));
  return {
    dir,
    app: createApp({
    cfg,
    calibration,
    scraper: { fetch: async () => ({ rows: [], error: null, ageSeconds: 0 }), cached: () => null },
    polymarket: { quote: async () => null, cache: new Map() },
    espn: { many: async () => ({ events: [] }) },
    sportscore: { many: async () => ({ events: [] }) },
    }),
  };
}

test('Phase 4 : la nouvelle interface est servie sans données d’exemple', async () => {
  const { app, dir } = makeApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await fetch(`${base}/`).then((r) => r.text());
    assert.ok(html.includes('Analyse statistique'));
    assert.ok(html.includes('18+'));
    assert.ok(!html.includes('Données d’exemple'));
    assert.ok(html.includes('aria-label'));
    assert.ok(html.includes('viewport-fit=cover'));

    for (const p of ['/app.js', '/style.css', '/modules/api.js', '/modules/state.js', '/modules/views/ecarts.js', '/modules/ui/toast.js', '/modules/ui/sheet.js']) {
      const r = await fetch(`${base}${p}`);
      assert.equal(r.status, 200, `${p} introuvable`);
    }
    const traversal = await fetch(`${base}/modules/views/..%2F..%2Fserver.js`);
    assert.ok([400, 404].includes(traversal.status));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Phase 4 : /legacy est protégé par ADMIN_PASSCODE', async () => {
  const { app, dir } = makeApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const denied = await fetch(`${base}/legacy`);
    assert.equal(denied.status, 401);
    assert.ok(denied.headers.get('www-authenticate')?.includes('Basic'));

    const basic = `Basic ${Buffer.from('admin:test-admin-secret-123').toString('base64')}`;
    const allowed = await fetch(`${base}/legacy`, { headers: { Authorization: basic } });
    assert.equal(allowed.status, 200);
    const html = await allowed.text();
    assert.ok(html.includes('/legacy/app.js'));
    assert.ok(html.includes('/legacy/style.css'));

    const js = await fetch(`${base}/legacy/modules/state.js`, { headers: { Authorization: basic } });
    assert.equal(js.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Phase 4 : vocabulaire corrigé et appels v2 réels dans le code source', () => {
  const files = [
    'site/index.html', 'site/app.js', 'site/modules/api.js', 'site/modules/state.js',
    'site/modules/views/ecarts.js', 'site/modules/views/matchs.js',
    'site/modules/views/bilan.js', 'site/modules/views/laboratoire.js', 'site/modules/views/configuration.js',
    'site/modules/ui/format.js', 'site/modules/ui/sheet.js', 'site/modules/ui/toast.js',
    'site/style.css',
  ];
  const all = files.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  assert.ok(!all.includes('Données d’exemple'));
  assert.ok(!all.includes('Mouvements 24 h'));
  assert.ok(!all.includes('Mouvement 24 h'));
  assert.ok(!all.includes('score de confiance'));
  assert.ok(!all.includes('Confiance élevée'));
  assert.ok(all.includes('/api/v2'));
  assert.ok(all.includes('data-share'));
  assert.ok(all.includes('gap') === false || all.includes('historique_ecart'));
  const ecarts = fs.readFileSync(path.join(ROOT, 'site/modules/views/ecarts.js'), 'utf8');
  assert.ok(ecarts.includes('Mouvement Betfair depuis l’ouverture'));
  assert.ok(ecarts.includes('histogramme') === false);
  const api = fs.readFileSync(path.join(ROOT, 'site/modules/api.js'), 'utf8');
  assert.ok(api.includes("request('/alertes'"));
  const lab = fs.readFileSync(path.join(ROOT, 'site/modules/views/laboratoire.js'), 'utf8');
  assert.ok(lab.includes('config-select'));
  const cfgView = fs.readFileSync(path.join(ROOT, 'site/modules/views/configuration.js'), 'utf8');
  assert.ok(cfgView.includes('Paramètres de la configuration'));
  assert.ok(cfgView.includes('Matchs associés'));
  assert.ok(cfgView.includes('n_matchs_regles'));
  for (const view of ['ecarts', 'matchs', 'bilan', 'laboratoire']) {
    const src = fs.readFileSync(path.join(ROOT, `site/modules/views/${view}.js`), 'utf8');
    assert.ok(src.includes('sourceBanner'), `${view} n'affiche pas l'état des sources`);
  }
});
