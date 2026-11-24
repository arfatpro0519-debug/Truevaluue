import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'production';
const { startServer } = await import('../server.js');

test('la production refuse de démarrer sans ADMIN_PASSCODE', async () => {
  const sources = {
    cfg: { port: 0, adminPasscode: null },
    scraper: {},
    polymarket: {},
  };
  await assert.rejects(() => startServer(sources), /ADMIN_PASSCODE/);
});
