import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server.js';
import { CalibrationStore } from '../src/calibration.js';
import { TelegramAlerts } from '../src/telegramAlerts.js';

const NOW = Date.parse('2026-11-25T12:00:00Z');

function makeCalibration() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-alerts-'));
  return { dir, calibration: new CalibrationStore(path.join(dir, 'observations.json')) };
}

function card(overrides = {}) {
  return {
    id: 'a-b::1x2::1',
    type: 'net',
    match: { home: 'A', away: 'B', kickoff: '2026-11-25T19:00:00Z' },
    marche: '1X2',
    issue: 'Victoire A',
    betfair_pct: 62,
    polymarket_pct: 55,
    valeur_nette_pts: 5,
    liquidite_polymarket_usd: 9000,
    fraicheur: { betfair_age_s: 120, polymarket_age_s: 240 },
    ...overrides,
  };
}

const sourcesOk = { sources: [{ nom: 'betfair', etat: 'ok' }, { nom: 'polymarket', etat: 'ok' }] };

test('5.1 la règle exige écart net, liquidité, fraîcheur et coup d’envoi à venir', () => {
  const { dir, calibration } = makeCalibration();
  try {
    const a = new TelegramAlerts({ cfg: {}, calibration });
    assert.equal(a.isEligible(card(), sourcesOk, NOW), true);
    assert.equal(a.isEligible(card({ valeur_nette_pts: 3.9 }), sourcesOk, NOW), false);
    assert.equal(a.isEligible(card({ liquidite_polymarket_usd: 4999 }), sourcesOk, NOW), false);
    assert.equal(a.isEligible(card({ fraicheur: { betfair_age_s: 120, polymarket_age_s: 900 } }), sourcesOk, NOW), false);
    assert.equal(
      a.isEligible(card({ match: { home: 'A', away: 'B', kickoff: '2026-11-25T11:00:00Z' } }), sourcesOk, NOW),
      false
    );
    assert.equal(
      a.isEligible(card(), { sources: [{ nom: 'betfair', etat: 'panne' }] }, NOW),
      false
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('5.2 anti-spam : un envoi par couple match+issue et plafond quotidien', async () => {
  const { dir, calibration } = makeCalibration();
  try {
    const sent = [];
    const a = new TelegramAlerts({
      cfg: { alertDailyCap: 2 },
      calibration,
      sendMessage: async (m) => sent.push(m),
    });
    a.subscribe('u1', 'chat1');
    const first = await a.evaluateAndSend({ ecarts: [card(), card()], sourcesStatus: sourcesOk, nowMs: NOW });
    assert.equal(first.envoyees, 1);
    const second = await a.evaluateAndSend({ ecarts: [card()], sourcesStatus: sourcesOk, nowMs: NOW });
    assert.equal(second.envoyees, 0);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes('18+'));
    assert.ok(!sent[0].text.includes('garanti de gain'));

    const more = await a.evaluateAndSend({
      ecarts: [card({ id: 'x', issue: 'Autre issue' }), card({ id: 'y', issue: 'Troisième' })],
      sourcesStatus: sourcesOk,
      nowMs: NOW,
    });
    assert.equal(more.envoyees, 1); // plafond quotidien de 2 atteint
    assert.equal(sent.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('5.3 et 5.4 commandes webhook avec secret, désabonnement immédiat', async (t) => {
  const { dir, calibration } = makeCalibration();
  const messages = [];
  const cfg = {
    port: 0,
    adminPasscode: 'test-admin-secret-123',
    paymentsEnabled: 0,
    telegramWebhookSecret: 'secret-test',
    telegramBotToken: '',
  };
  const alerts = new TelegramAlerts({ cfg, calibration, sendMessage: async (m) => messages.push(m) });
  const app = createApp({
    cfg,
    calibration,
    alerts,
    scraper: { fetch: async () => ({ rows: [], error: null, ageSeconds: 0 }), cached: () => null },
    polymarket: { quote: async () => null, cache: new Map() },
    espn: { many: async () => ({ events: [] }) },
    sportscore: { many: async () => ({ events: [] }) },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (text, secret = 'secret-test') =>
    fetch(`${base}/api/billing/telegram-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify({ message: { text, from: { id: 42 }, chat: { id: 99 } } }),
    });

  try {
    const bad = await post('/start', 'mauvais-secret');
    assert.equal(bad.status, 401);
    const start = await post('/start');
    assert.equal(start.status, 200);
    assert.equal((await start.json()).command, '/start');
    assert.ok(messages[0].text.includes('18+'));

    const on = await post('/alertes');
    assert.equal((await on.json()).command, '/alertes');
    assert.equal(alerts.getSubscription('42').actif, true);
    assert.ok(messages.at(-1).text.includes('aucun gain garanti'));

    const off = await post('/stop');
    assert.equal((await off.json()).command, '/stop');
    assert.equal(alerts.getSubscription('42'), null);

    const unauthorized = await fetch(`${base}/api/v2/alertes`).then((r) => r.json());
    assert.equal(unauthorized.ok, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
