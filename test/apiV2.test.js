import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server.js';
import { buildConfigurationDetail, buildEcarts, buildLaboratoire } from '../src/apiV2.js';
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
      assert.ok(['net', 'mv', 'ct', 'conv', 'flow'].includes(c.type));
      assert.ok(Object.hasOwn(c, 'valeur_nette_pts'));
      assert.ok(Object.hasOwn(c, 'niveau'));
      assert.ok(Object.hasOwn(c, 'fraicheur'));
    }

    for (const type of ['net', 'mv', 'ct', 'conv', 'flow', 'inconnu']) {
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
    for (const f of bilan.fiabilite) {
      assert.ok(Object.hasOwn(f, 'n'));
      assert.ok(!/Mouvements 24 h|Propositions|Gagné|Perdu|confiance/i.test(f.libelle));
    }
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

    if (lab.catalogue.length > 0) {
      const code = encodeURIComponent(lab.catalogue[0].code);
      const fiche = await fetch(`${base}/api/v2/laboratoire/configuration?code=${code}`).then((r) => r.json());
      assert.equal(fiche.ok, true);
      assert.equal(fiche.parametres.length, 4);
      assert.ok(Object.hasOwn(fiche.kpi, 'n_matchs_regles'));
      assert.ok(Array.isArray(fiche.matchs));
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

test('Convergences : accord Betfair × Polymarket exposé comme carte d’analyse', () => {
  const configurations = {
    rows: [
      {
        fixture_key: 'a-b',
        home: 'A',
        away: 'B',
        league: 'L',
        date: '2026-11-27T19:00:00Z',
        pm_liquidity: 6000,
        total_volume_bf: 10000,
        markets: [
          {
            market: '1x2',
            short: '1X2',
            source_bf: true,
            source_pm: true,
            favorite: '1',
            pm_favorite: '1',
            favorite_pct: 55,
            pm_favorite_pct: 54,
            age_seconds: 10,
          },
        ],
        axes: {
          concordance: {
            items: [{ status: 'convergence', pair: 'Betfair × Polymarket (1X2)', detail: 'Même favori 1' }],
          },
        },
      },
    ],
  };
  const cards = buildEcarts({ signals: { all_signals: [] }, configurations });
  assert.ok(cards.ecarts.some((c) => c.type === 'conv'));
  const conv = cards.ecarts.find((c) => c.type === 'conv');
  assert.equal(conv.betfair_pct, 55);
  assert.equal(conv.polymarket_pct, 54);
  assert.equal(conv.valeur_nette_pts, null);
  assert.equal(conv.niveau_label, 'Non applicable');
  assert.equal(buildEcarts({ signals: { all_signals: [] }, configurations, type: 'conv' }).total, 1);
  assert.equal(buildEcarts({ signals: { all_signals: [] }, configurations, type: 'net' }).total, 0);
});

test('Flux & retards : les signaux sans cote restent distincts des écarts nets', () => {
  const signals = {
    all_signals: [
      {
        id: 'flow::a-b::1x2::lag_pm',
        category: 'flow',
        signal_type: 'lag_pm',
        fixture_key: 'a-b',
        home: 'A',
        away: 'B',
        league: 'L',
        date: '2026-11-27T19:00:00Z',
        market_short: '1X2',
        side_label: '1',
        direction: 'buy_pm',
        detail: 'Retard Polymarket sur 1X2',
        net_edge_pp: 3,
        pm_liquidity: 6000,
        total_volume_bf: 9000,
        niveau: 'moyen',
        niveau_label: 'Moyen',
      },
    ],
  };
  const cards = buildEcarts({ signals }).ecarts;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].type, 'flow');
  assert.equal(cards[0].flux.type, 'lag_pm');
  assert.equal(cards[0].flux.direction, 'buy_pm');
  assert.equal(cards[0].niveau, 'moyen');
  assert.equal(buildEcarts({ signals, type: 'flow' }).total, 1);
  assert.equal(buildEcarts({ signals, type: 'net' }).total, 0);
});

test('Laboratoire : les signatures réglées historiques apparaissent même si elles sont partielles', () => {
  const report = {
    observations: [
      { signature_code: '2 | Oui | ? | G4', status: 'settled', date: '2026-11-24 17:45:00', bf_top_won: true, sides: [{ label: '2', bf_pct: 42.7 }] },
      { signature_code: '2 | Oui | ? | G4', status: 'settled', date: '2026-11-25 17:45:00', bf_top_won: false, sides: [{ label: '2', bf_pct: 44.1 }] },
    ],
  };
  const lab = buildLaboratoire({ configurations: { catalog_72: [], partial_signatures: [] }, calibrationReport: report });
  assert.equal(lab.signatures.length, 1);
  assert.equal(lab.signatures[0].code, '2 | Oui | ? | G4');
  assert.equal(lab.signatures[0].n_matchs, 2);
  assert.equal(lab.signatures[0].k_favori_gagnant, 1);
  assert.equal(lab.signatures[0].taux_confirmation_pct, 50);
  assert.equal(lab.signatures[0].probabilite_marche_pct, 43.4);
  assert.deepEqual(lab.signatures[0].ic95_pct[0] < 50, true);
});

test('Configuration : fiche avec paramètres, explication, matchs et KPI', () => {
  const code = '1 | Oui | X | G2';
  const configurations = {
    catalog_72: [{ code, ft: '1', btts: 'Oui', ht: 'X', goals_profile: 'G2', count: 2, contradictions: 0, convergences: 1, dominant_intensity: 'Faible' }],
    partial_signatures: [],
    rows: [
      {
        fixture_key: 'a-b', home: 'A', away: 'B', league: 'L', date: '2026-11-27T19:00:00Z',
        kickoff_passed: false, pm_matched: true, signature: { code }, markets: [{ source_bf: true, source_pm: true }],
      },
    ],
    thresholds: { equilibreMaxPp: 4, faibleMaxPp: 12, modereeMaxPp: 24, forteMaxPp: 40 },
    period: { min_date: '2026-11-20', max_date: '2026-11-27' },
  };
  const report = {
    observations: [
      { signature_code: code, status: 'settled', date: '2026-11-24', home: 'C', away: 'D', league: 'L1', market: '1x2', home_score: 2, away_score: 0, bf_top_won: true, sides: [{ label: '1', bf_pct: 55 }, { label: 'X', bf_pct: 25 }] },
      { signature_code: code, status: 'settled', date: '2026-11-25', home: 'E', away: 'F', league: 'L1', market: '1x2', home_score: 0, away_score: 1, bf_top_won: false, sides: [{ label: '1', bf_pct: 57 }, { label: '2', bf_pct: 20 }] },
      { signature_code: code, status: 'settled', date: '2026-11-26', home: 'G', away: 'H', league: 'L1', market: 'btts', home_score: 1, away_score: 1, bf_top_won: true, sides: [{ label: 'Oui', bf_pct: 60 }, { label: 'Non', bf_pct: 40 }] },
    ],
  };
  const d = buildConfigurationDetail({ code, configurations, calibrationReport: report });
  assert.equal(d.ok, true);
  assert.equal(d.parametres.length, 4);
  assert.equal(d.parametres[3].valeur, 'G2');
  assert.ok(d.explication.includes('Victoire domicile'));
  assert.equal(d.kpi.n_matchs_regles, 3);
  assert.equal(d.kpi.k_favori_gagnant, 2);
  assert.equal(d.kpi.taux_confirmation_pct, 66.7);
  assert.equal(d.kpi.convergences, 1);
  assert.equal(d.matchs.length, 4);
  assert.equal(d.marches.length, 2);
  const oneXTwo = d.marches.find((m) => m.marche === '1x2');
  assert.equal(oneXTwo.n, 2);
  assert.equal(oneXTwo.k_favori_gagnant, 1);
  const domicile = oneXTwo.issues.find((i) => i.issue === '1');
  assert.equal(domicile.libelle, 'Domicile');
  assert.equal(domicile.n_observations, 1);
  assert.equal(domicile.n_favori, 2);
  assert.equal(domicile.k_favori_gagnant, 1);
  const btts = d.marches.find((m) => m.marche === 'btts');
  assert.equal(btts.issues.find((i) => i.issue === 'Oui').n_observations, 1);
  assert.equal(btts.issues.find((i) => i.issue === 'Oui').taux_favori_pct, 100);
  assert.ok(d.matchs.some((m) => m.source === 'live'));
  assert.ok(d.matchs.some((m) => m.statut === 'Confirmé'));
  assert.equal(buildConfigurationDetail({ code: 'inconnu', configurations, calibrationReport: report }), null);

  const lab = buildLaboratoire({ configurations, calibrationReport: report });
  assert.equal(lab.catalogue.length, 1);
  assert.equal(lab.catalogue[0].code, code);
});

test('Phase 6 : SHOW_PM_LINKS=0 retire les liens Polymarket de l’API v2', () => {
  const signals = {
    all_signals: [
      {
        id: 'x', category: 'executable', fixture_key: 'a-b', home: 'A', away: 'B', league: 'L',
        date: '2026-11-27T19:00:00Z', market_short: '1X2', side_label: '1', net_edge_pp: 5,
        pm_liquidity: 9000, total_volume_bf: 10000, niveau: 'fort', pm_url: 'https://polymarket.com/e',
        recommendation: { bf_pct: 62, pm_exec_pct: 55, pm_spread_pts: 2 },
      },
    ],
  };
  assert.equal(buildEcarts({ signals }).ecarts[0].pm_url, 'https://polymarket.com/e');
  assert.equal(buildEcarts({ signals, showPmLinks: false }).ecarts[0].pm_url, null);
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
