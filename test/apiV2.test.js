import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server.js';
import { CalibrationStore } from '../src/calibration.js';
import { MarketKey } from '../src/market.js';

function makeSources() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-v2-'));
  const file = path.join(dir, 'observations.json');
  const futureDate = new Date(Date.now() + 4 * 3_600_000).toISOString();
  const scraper = {
    fetch: async (key) => ({
      source: 'live',
      ageSeconds: 12,
      error: null,
      rows:
        key === MarketKey.OneXTwo
          ? [
              {
                home: 'PSG',
                away: 'Lyon',
                league: 'Ligue 1',
                country: 'fra',
                date: futureDate,
                coef_1: 1.7,
                coef_1_new: 1.7,
                coef_x: 4,
                coef_2: 5.5,
                volume_1: 12000,
                volume_x: 2000,
                volume_2: 1000,
              },
            ]
          : [],
    }),
    cached: () => ({ ageSeconds: 12, rows: [] }),
  };
  const polymarket = {
    cache: new Map([['k', { at: Date.now() - 30_000 }]]),
    quote: async () => ({
      slug: 'psg-vs-lyon',
      url: 'https://polymarket.com/event/psg-vs-lyon',
      title: 'PSG vs. Lyon',
      volume: 30000,
      liquidity: 8000,
      markets: {
        [MarketKey.OneXTwo]: {
          liquidity: 8000,
          spread: 0.02,
          usable: true,
          outcomes: [
            { label: '1', novig_pct: 55, price: 0.55, bid: 0.54, ask: 0.56 },
            { label: 'N', novig_pct: 25, price: 0.25, bid: 0.24, ask: 0.26 },
            { label: '2', novig_pct: 20, price: 0.2, bid: 0.19, ask: 0.21 },
          ],
        },
      },
    }),
  };
  const cfg = {
    port: 0,
    polymarketEnabled: true,
    espnEnabled: true,
    sportscoreDisabled: true,
    adminPasscode: 'test-admin-secret-123',
  };
  return {
    dir,
    sources: {
      cfg,
      scraper,
      polymarket,
      espn: { many: async () => ({ events: [], errors: [] }), cache: new Map() },
      sportscore: { many: async () => ({ events: [], warnings: [] }), cache: new Map() },
      calibration: new CalibrationStore(file),
    },
  };
}

async function withServer(t, fn) {
  const { dir, sources } = makeSources();
  const app = createApp(sources);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, sources);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Phase 3 : les 6 routes v2 répondent au contrat sans clé interne', async (t) => {
  await withServer(t, async (base) => {
    const ecarts = await fetch(`${base}/api/v2/ecarts`).then((r) => r.json());
    assert.equal(ecarts.ok, true);
    assert.ok(Array.isArray(ecarts.ecarts));
    assert.equal(ecarts.total, ecarts.ecarts.length);
    for (const c of ecarts.ecarts) {
      for (const forbidden of ['sort_key', 'score_sort', 'interest_score', 'confidence_score', 'recommendation', 'score']) {
        assert.equal(Object.hasOwn(c, forbidden), false, `${forbidden} exposé`);
      }
      assert.ok(['net', 'mv', 'ct'].includes(c.type));
      assert.ok(Object.hasOwn(c, 'valeur_nette_pts'));
      assert.ok(Object.hasOwn(c, 'niveau'));
      assert.ok(Object.hasOwn(c, 'fraicheur'));
    }

    for (const type of ['net', 'mv', 'ct', 'inconnu']) {
      const r = await fetch(`${base}/api/v2/ecarts?type=${type}`).then((x) => x.json());
      assert.equal(r.ok, true);
      assert.equal(r.type, type === 'inconnu' ? 'all' : type);
    }

    if (ecarts.ecarts.length > 0) {
      const id = encodeURIComponent(ecarts.ecarts[0].id);
      const detail = await fetch(`${base}/api/v2/ecarts/${id}`).then((r) => r.json());
      assert.equal(detail.ok, true);
      assert.ok(Array.isArray(detail.toutes_issues));
      assert.ok(Array.isArray(detail.historique_ecart));
      assert.equal(detail.source_historique, 'aucune donnée');
    }
    const missing = await fetch(`${base}/api/v2/ecarts/nope`).then((r) => r.json());
    assert.equal(missing.ok, false);

    const matchs = await fetch(`${base}/api/v2/matchs?q=PSG`).then((r) => r.json());
    assert.equal(matchs.ok, true);
    assert.ok(matchs.matchs.length >= 1);
    assert.equal(typeof matchs.matchs[0].has_betfair, 'boolean');
    assert.equal(typeof matchs.matchs[0].has_polymarket, 'boolean');

    const bilan = await fetch(`${base}/api/v2/bilan`).then((r) => r.json());
    assert.equal(bilan.ok, true);
    assert.ok(Object.hasOwn(bilan.precision, 'n'));
    assert.ok(Array.isArray(bilan.fiabilite));
    for (const f of bilan.fiabilite) assert.ok(Object.hasOwn(f, 'n'));
    assert.ok(Object.hasOwn(bilan.rendement_theorique, 'roi_n'));
    assert.ok(bilan.rendement_theorique.avertissement.includes('garantie'));

    const lab = await fetch(`${base}/api/v2/laboratoire?intensity=all`).then((r) => r.json());
    assert.equal(lab.ok, true);
    assert.equal(lab.bandeau.includes('pas de pronostics'), true);
    assert.ok(Array.isArray(lab.signatures));
    assert.equal(lab.signatures_possibles, 72);
    for (const s of lab.signatures) {
      assert.ok(Object.hasOwn(s, 'n_matchs'));
      assert.equal(s.ic95_pct.length, 2);
      if (s.n_matchs < 30) assert.equal(s.verdict, null);
    }

    const status = await fetch(`${base}/api/v2/sources/status`).then((r) => r.json());
    assert.equal(status.ok, true);
    assert.equal(status.sources.length, 4);
    for (const s of status.sources) {
      assert.ok(['ok', 'retard', 'panne'].includes(s.etat));
      assert.ok(Object.hasOwn(s, 'age_s'));
    }
    assert.ok(status.persistance);
    assert.ok(status.snapshots);
  });
});

test('Phase 3 : cas dégradés — source en panne et aucun écart', async (t) => {
  await withServer(t, async (base, sources) => {
    sources.scraper.fetch = async () => ({ source: 'live', ageSeconds: 0, error: 'source down', rows: [] });
    sources.scraper.cached = () => null;
    const status = await fetch(`${base}/api/v2/sources/status`).then((r) => r.json());
    assert.equal(status.sources[0].etat, 'panne');
    assert.equal(status.sources[0].age_s, null);

    const ecarts = await fetch(`${base}/api/v2/ecarts`).then((r) => r.json());
    assert.equal(ecarts.ok, true);
    assert.equal(ecarts.total, 0);
    assert.deepEqual(ecarts.ecarts, []);
  });
});

test('Phase 3.1 : la synchronisation écrit de vrais points gap_snapshots', async (t) => {
  await withServer(t, async (base) => {
    const login = await fetch(`${base}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'test-admin-secret-123' }),
    }).then((r) => r.json());
    assert.equal(login.ok, true);
    const sync = await fetch(`${base}/api/calibration/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}` },
    }).then((r) => r.json());
    assert.equal(sync.ok, true);
    assert.ok(sync.gap_snapshots >= 1);

    const ecarts = await fetch(`${base}/api/v2/ecarts`).then((r) => r.json());
    const net = ecarts.ecarts.find((c) => c.type === 'net');
    assert.ok(net);
    const detail = await fetch(`${base}/api/v2/ecarts/${encodeURIComponent(net.id)}`).then((r) => r.json());
    assert.equal(detail.source_historique, 'gap_snapshots');
    assert.ok(detail.historique_ecart.length >= 1);
    assert.ok(detail.historique_ecart.every((p) => typeof p.ts === 'string'));
  });
});

test('Phase 3 : les anciennes routes restent vivantes et marquées dépréciées', async (t) => {
  await withServer(t, async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const cmp = await fetch(`${base}/api/compare`);
    assert.equal(cmp.status, 200);
    assert.equal(cmp.headers.get('deprecation'), 'true');
    const v2 = await fetch(`${base}/api/v2/sources/status`);
    assert.equal(v2.headers.get('deprecation'), null);
  });
});
