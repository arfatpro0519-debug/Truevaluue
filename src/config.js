// Configuration lue depuis l'environnement pour les 4 sources de données et la sécurité.

import fs from 'node:fs';
import path from 'node:path';

function loadDotEnvIfPresent() {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {
    // Ignore .env read errors
  }
}

loadDotEnvIfPresent();

// Taille d'échantillon minimale avant de désigner une « meilleure catégorie ».
export const DEFAULT_CALIBRATION_MIN_N = 30;

function env(key) {
  const v = process.env[key];
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function envInt(key, fallback) {
  const v = env(key);
  if (v === null) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadConfig() {
  return {
    port: envInt('PORT', 3000),
    dataDir: env('DATA_DIR') || 'data',
    syncIntervalSecs: envInt('SYNC_INTERVAL_SECS', 600),
    calibrationMinN: envInt('CALIBRATION_MIN_N', DEFAULT_CALIBRATION_MIN_N),
    adminPasscode: env('ADMIN_PASSCODE'),
    paymentsEnabled: env('PAYMENTS_ENABLED') === '1',
    telegramBotToken: env('TELEGRAM_BOT_TOKEN'),
    telegramWebhookSecret: env('TELEGRAM_WEBHOOK_SECRET'),
    telegramProStarsPrice: envInt('TELEGRAM_PRO_STARS_PRICE', 1500),
  alertNetMinPp: envInt('ALERT_NET_MIN_PP', 4),
  alertPmMinLiquidityUsd: envInt('ALERT_PM_MIN_LIQUIDITY_USD', 5000),
  alertMaxAgeS: envInt('ALERT_MAX_AGE_S', 600),
  alertDailyCap: envInt('ALERT_DAILY_CAP', 10),
  sourceStaleSecs: envInt('SOURCE_STALE_SECS', 600),
    arbworldBase: env('ARBWORLD_BASE') || 'https://arbworld.net/fr/moneyway',
    cacheTtlSecs: envInt('CACHE_TTL_SECS', 20),
    staleTtlSecs: envInt('STALE_TTL_SECS', 900),
    scraperContact: env('SCRAPER_CONTACT'),
    espnEnabled: env('ESPN_ENABLED') !== '0',
    sportscoreUrl: env('SPORTSCORE_URL') || 'https://sportscore.com',
    sportscoreApiKey: env('SPORTSCORE_API_KEY'),
    sportscoreHost: env('SPORTSCORE_HOST'),
    sportscoreDisabled: env('SPORTSCORE_DISABLED') === '1',
    polymarketEnabled: env('POLYMARKET_ENABLED') !== '0',
    polymarketUrl: env('POLYMARKET_URL') || 'https://gamma-api.polymarket.com',
  // Disponibilité légale variable selon les pays : permet de retirer les liens PM.
  showPmLinks: env('SHOW_PM_LINKS') !== '0',
  };
}
