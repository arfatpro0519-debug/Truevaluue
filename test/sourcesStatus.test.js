import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSourcesStatus } from '../src/apiV2.js';

function calibrationWith(heartbeats) {
  return {
    getSourceHeartbeats: () => heartbeats,
    getPersistenceStatus: () => ({ etat: 'ok', erreur_persistance: null }),
  };
}

function statusWith(heartbeats) {
  return buildSourcesStatus({
    cfg: { sourceStaleSecs: 600, storageBackend: 'cloudflare', syncMode: 'external' },
    scraper: { cached: () => null },
    polymarket: { cache: new Map() },
    espn: { cache: new Map() },
    sportscore: { cache: new Map() },
    calibration: calibrationWith(heartbeats),
    gapStore: { status: () => ({ points: 0 }) },
  });
}

test('les sources sans cache utilisent la dernière collecte persistée', () => {
  const now = Date.now();
  const status = statusWith({
    espn: now - 5_000,
    sportscore: now - 900_000,
  });
  const byName = Object.fromEntries(status.sources.map((s) => [s.nom, s]));

  assert.equal(byName.espn.etat, 'ok');
  assert.ok(byName.espn.age_s >= 4 && byName.espn.age_s <= 6);
  assert.equal(byName.sportscore.etat, 'retard');
  assert.equal(byName.betfair.etat, 'panne');
  assert.equal(byName.polymarket.etat, 'panne');
});

test('le cache en mémoire reste prioritaire sur la collecte persistée', () => {
  const now = Date.now();
  const status = buildSourcesStatus({
    cfg: { sourceStaleSecs: 600 },
    scraper: { cached: () => ({ ageSeconds: 12 }) },
    polymarket: { cache: new Map() },
    espn: { cache: new Map([['k', { at: now - 3_000 }]]) },
    sportscore: { cache: new Map() },
    calibration: calibrationWith({ betfair: now - 500_000, espn: now - 500_000 }),
    gapStore: null,
  });
  const byName = Object.fromEntries(status.sources.map((s) => [s.nom, s]));

  assert.equal(byName.betfair.etat, 'ok');
  assert.equal(byName.betfair.age_s, 12);
  assert.equal(byName.espn.etat, 'ok');
  assert.ok(byName.espn.age_s <= 4);
});
