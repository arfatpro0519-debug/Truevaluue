// Serveur HTTP Express : API JSON, authentification Telegram/Admin, facturation Stars,
// calibration SQLite et interface WebApp (/site).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import express from 'express';

import { mapWithConcurrency } from './src/async.js';
import {
  extractBearerToken,
  hashPasscode,
  redactComparePayload,
  redactConfigurationsPayload,
  redactSignalsPayload,
  signSessionToken,
  verifyEnvPasscode,
  verifyPasscodeHash,
  verifySessionToken,
  verifyTelegramInitData,
} from './src/auth.js';
import { CalibrationStore } from './src/calibration.js';
import { createCloudflareStorage } from './src/cloudflareStorage.js';
import { buildComparison } from './src/compare.js';
import { buildConfigurations, buildSignals, SIGNAL_PRESETS } from './src/configurations.js';
import { loadConfig } from './src/config.js';
import { enrich, fixtureKey, parseKickoff, round2 } from './src/enrich.js';
import { DEFAULT_LEAGUES, EspnResultsClient, LEAGUES, VALID_LEAGUE_SLUGS } from './src/espn.js';
import { ALL_MARKETS, marketDef, parseMarketKey } from './src/market.js';
import { PolymarketBook } from './src/polymarket.js';
import { createRateLimiter } from './src/rateLimit.js';
import { DEFAULT_PROPOSAL_PRESET } from './src/recommend.js';
import { buildUserAgent, Scraper } from './src/scrape.js';
import { competitionSlugs, SportScoreClient } from './src/sportscore.js';
import * as th from './src/thresholds.js';

import {
  buildBilan,
  buildConfigurationDetail,
  buildEcarts,
  buildEcartDetail,
  buildLaboratoire,
  buildMatchs,
  buildSourcesStatus,
  recordGapSnapshots,
} from './src/apiV2.js';
import { GapSnapshotsStore } from './src/gapSnapshots.js';
import { TelegramAlerts } from './src/telegramAlerts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.join(__dirname, 'site');
const MODULES_DIR = path.join(SITE_DIR, 'modules');
const LEGACY_DIR = path.join(__dirname, 'site-legacy');
const GZIP_JSON_MIN_BYTES = 1024;
const DEFAULT_SPORTSCORE_SLUGS = ['italian-serie-c', 'greek-super-league-2'];
const IS_PROD = process.env.NODE_ENV === 'production';

function loadStaticAsset(filePath) {
  const raw = fs.readFileSync(filePath);
  const gzip = zlib.gzipSync(raw, { level: 6 });
  const etag = `"${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24)}"`;
  return { raw, gzip, etag };
}

const staticAssetCache = new Map();

function getStaticAsset(filePath) {
  if (IS_PROD && staticAssetCache.has(filePath)) {
    return staticAssetCache.get(filePath);
  }
  const asset = loadStaticAsset(filePath);
  if (IS_PROD) {
    staticAssetCache.set(filePath, asset);
  }
  return asset;
}

function acceptsGzip(req) {
  const header = req.headers?.['accept-encoding'];
  return typeof header === 'string' && /\bgzip\b/i.test(header);
}

function todayIsoUtc() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeIsoDate(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return null;
}

function toEspnDateParam(raw) {
  const iso = normalizeIsoDate(raw);
  return iso ? iso.replace(/-/g, '') : null;
}

function parsePaginationQuery(query) {
  const rawLimit = Number.parseInt(String(query?.limit || '200'), 10);
  const rawOffset = Number.parseInt(String(query?.offset || '0'), 10);
  return {
    limit: Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, rawLimit)) : 200,
    offset: Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0,
  };
}

function sendJson(req, res, status, payload) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Vary', 'Accept-Encoding');

  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (body.length >= GZIP_JSON_MIN_BYTES && acceptsGzip(req)) {
    const zipped = zlib.gzipSync(body, { level: 6 });
    res.setHeader('Content-Encoding', 'gzip');
    res.status(status).send(zipped);
    return;
  }
  res.status(status).send(body);
}

function sendError(req, res, status, message) {
  sendJson(req, res, status, { ok: false, error: message });
}

function sendAsset(req, res, contentType, asset) {
  res.setHeader('Cache-Control', IS_PROD ? 'public, max-age=300' : 'no-cache');
  res.setHeader('ETag', asset.etag);
  res.setHeader('Vary', 'Accept-Encoding');

  const ifNoneMatch = req.headers?.['if-none-match'];
  if (
    typeof ifNoneMatch === 'string' &&
    ifNoneMatch.split(',').some((tag) => tag.trim() === asset.etag)
  ) {
    res.status(304).end();
    return;
  }

  res.setHeader('Content-Type', contentType);
  if (acceptsGzip(req)) {
    res.setHeader('Content-Encoding', 'gzip');
    res.status(200).send(asset.gzip);
    return;
  }
  res.status(200).send(asset.raw);
}

function constantTimeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createSources(cfg = loadConfig()) {
  const dataDir = path.resolve(process.cwd(), cfg.dataDir || 'data');
  return {
    cfg,
    scraper: new Scraper(cfg.arbworldBase, {
      ttlSecs: cfg.cacheTtlSecs,
      staleTtlSecs: cfg.staleTtlSecs,
      userAgent: buildUserAgent(cfg.scraperContact),
    }),
    polymarket: new PolymarketBook(
      th.EXCHANGE_CACHE_TTL_SECS * 1000,
      cfg.polymarketUrl,
      th.EXCHANGE_MISS_CACHE_TTL_SECS * 1000
    ),
    espn: new EspnResultsClient(60_000),
    sportscore: new SportScoreClient(
      th.SPORTSCORE_CACHE_TTL_SECS * 1000,
      cfg.sportscoreUrl,
      {
        apiKey: cfg.sportscoreApiKey,
        host: cfg.sportscoreHost,
      }
    ),
    calibration: new CalibrationStore(path.join(dataDir, 'observations.json'), {
      forceJson: cfg.storageBackend === 'cloudflare',
    }),
  };
}

export function createApp(sourcesOrCfg = null) {
  const sources =
    sourcesOrCfg && sourcesOrCfg.scraper && sourcesOrCfg.polymarket
      ? sourcesOrCfg
      : createSources(sourcesOrCfg || loadConfig());

  const { cfg, scraper, polymarket, espn, sportscore } = sources;
  const calibration =
    sources.calibration ||
    new CalibrationStore(
      path.resolve(process.cwd(), cfg.dataDir || 'data', 'observations.json')
    );
  // Historique réel de l'écart (Phase 3.1) : partagé avec la sync de fond via `sources`.
  const gapStore =
    sources.gapStore ||
    new GapSnapshotsStore({
      db: calibration.db || null,
      filePath: path.join(path.dirname(calibration.filePath), 'gap_snapshots.json'),
      reportError: (ok, operation, err) => calibration._recordPersistence?.(ok, operation, err),
    });
  sources.gapStore = gapStore;
  // Stockage distant (Render n'a pas de disque persistant en plan gratuit).
  const cloudflare = sources.cloudflare || createCloudflareStorage({ cfg });
  sources.cloudflare = cloudflare;
  // Alertes Telegram : mêmes réglages et abonnements que le reste de l'application.
  const alerts = sources.alerts || new TelegramAlerts({ cfg, calibration });
  sources.alerts = alerts;

  // Déclenchement des alertes après chaque synchronisation (5.1), sans jamais
  // exposer de promesse de gain. Sans bot token ou sans abonné, aucun appel réseau.
  const runAlertTick = async () => {
    try {
      const [signals, configurations] = await Promise.all([
        buildSignals({ scraper, polymarket, force: false, maxPmLookup: 28 }),
        buildConfigurations({ scraper, polymarket, force: false, maxPmLookup: 28 }),
      ]);
      const ecarts = buildEcarts({ signals, configurations, showPmLinks: cfg.showPmLinks !== false }).ecarts;
      const sourcesStatus = buildSourcesStatus({ cfg, scraper, polymarket, espn, sportscore, calibration, gapStore });
      return await alerts.evaluateAndSend({ ecarts, sourcesStatus });
    } catch (err) {
      console.error('Tick alertes Telegram impossible:', err?.message || err);
      return { envoyees: 0, erreur: err?.message || String(err) };
    }
  };
  sources.runAlertTick = runAlertTick;

  // Synchronisation complète + sauvegarde Cloudflare, utilisée par le cron externe.
  const runSyncAndFlush = async () => {
    const [cmpResult, sigResult] = await Promise.all([
      buildComparison({ scraper, polymarket, force: false, maxFixtures: 28 }),
      buildSignals({ scraper, polymarket, force: false, maxPmLookup: 28 }),
    ]);
    const snapshots = recordGapSnapshots(sources, cmpResult.rows);
    const recorded = calibration.recordFromComparison(cmpResult.rows);
    const recordedSignals = calibration.recordFromSignals(sigResult);
    const settlement = await calibration.settle({ espn, sportscore, cfg });
    const alertes = await runAlertTick();
    const stockage = await cloudflare.flush(path.dirname(calibration.filePath));
    return {
      recorded,
      recorded_signals: recordedSignals,
      settlement,
      gap_snapshots: snapshots,
      alertes,
      stockage,
    };
  };
  sources.runSyncAndFlush = runSyncAndFlush;

  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'self';"
    );
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Allow', 'GET, POST, OPTIONS');
      return res.status(204).end();
    }
    return next();
  });

  const apiLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 120 });
  const sensitiveLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 20 });

  app.use('/api', apiLimiter);
  app.use(['/api/auth', '/api/billing', '/api/v2', '/api/calibration/sync', '/api/cron/sync'], sensitiveLimiter);

  // Les routes /api/* historiques restent intactes mais sont marquées dépréciées (§2.7).
  app.use('/api', (req, res, next) => {
    const sub = req.path || '';
    if (!sub.startsWith('/v2/') && !sub.startsWith('/auth/') && !sub.startsWith('/billing/')) {
      res.setHeader('Deprecation', 'true');
      res.setHeader('Sunset', 'Wed, 31 Dec 2027 23:59:59 GMT');
      res.setHeader('Link', '</api/v2/ecarts>; rel="successor-version"');
    }
    return next();
  });

  // Auth middleware: vérifie le jeton Bearer uniquement en mémoire côté serveur
  app.use((req, _res, next) => {
    const token = extractBearerToken(req);
    const claims = token ? verifySessionToken(token) : null;
    if (!claims) {
      req.auth = {
        authenticated: false,
        role: 'guest',
        isAdmin: false,
        isPro: false,
        telegramUserId: null,
        username: null,
        firstName: null,
      };
      return next();
    }

    const isAdmin = claims.role === 'admin';
    const liveSub = claims.telegramUserId
      ? calibration.getSubscription(claims.telegramUserId)
      : null;
    const isPro =
      claims.proPreviewOff === true
        ? false
        : isAdmin || Boolean(claims.isPro) || Boolean(liveSub?.active);

    req.auth = {
      authenticated: true,
      role: claims.role || 'user',
      isAdmin,
      isPro,
      proPreviewOff: claims.proPreviewOff === true,
      telegramUserId: claims.telegramUserId || null,
      username: claims.username || null,
      firstName: claims.firstName || null,
    };
    return next();
  });

  function isAdminConfigured() {
    return Boolean(cfg.adminPasscode) || Boolean(calibration.getSetting('admin_passcode_hash'));
  }

  function isAdminClaimed() {
    return Boolean(calibration.getSetting('admin_passcode_hash'));
  }

  function effectiveReadAuth(req) {
    if (!cfg.paymentsEnabled) {
      return { ...req.auth, isPro: true, proPreviewOff: false };
    }
    return req.auth;
  }

  function requireAdmin(req, res, next) {
    if (!req.auth?.authenticated) {
      return sendError(req, res, 401, 'Authentification administrateur requise.');
    }
    if (!req.auth.isAdmin) {
      return sendError(req, res, 403, 'Accès réservé à l’administrateur.');
    }
    return next();
  }

  function parseProposalQuery(query) {
    const rawPreset =
      typeof query?.preset === 'string' ? query.preset.trim() : DEFAULT_PROPOSAL_PRESET;
    const preset = SIGNAL_PRESETS[rawPreset] ? rawPreset : DEFAULT_PROPOSAL_PRESET;
    const overrides = {};
    for (const key of [
      'minNetEdgePp',
      'minBfVolume',
      'minPmLiquidity',
      'maxSpreadPts',
      'maxAdverseDropPct',
    ]) {
      const raw = query?.[key];
      if (raw === undefined || raw === null || raw === '') continue;
      const v = Number(raw);
      if (Number.isFinite(v) && v >= 0) overrides[key] = v;
    }
    return {
      preset,
      thresholdOverrides: Object.keys(overrides).length > 0 ? overrides : null,
    };
  }

  /* ---- AUTH & MONÉTISATION ---- */
  app.get('/api/auth/status', (req, res) => {
    const paymentsEnabled = Boolean(cfg.paymentsEnabled);
    const sub =
      paymentsEnabled && req.auth.telegramUserId
        ? calibration.getSubscription(req.auth.telegramUserId)
        : null;
    return sendJson(req, res, 200, {
      ok: true,
      authenticated: req.auth.authenticated,
      role: req.auth.role,
      is_admin: req.auth.isAdmin,
      is_pro: paymentsEnabled ? req.auth.isPro : true,
      payments_enabled: paymentsEnabled,
      telegram_user_id: req.auth.telegramUserId,
      username: req.auth.username,
      first_name: req.auth.firstName,
      subscription_expires_at: sub?.expires_at || null,
      admin_configured: isAdminConfigured(),
      admin_claimed: isAdminClaimed(),
      billing_configured: paymentsEnabled ? Boolean(cfg.telegramBotToken) : false,
      pro_price_stars: cfg.telegramProStarsPrice ?? 1500,
    });
  });

  app.post('/api/auth/telegram', (req, res) => {
    const initData = req.body?.initData;
    const verified = verifyTelegramInitData(initData, cfg.telegramBotToken);
    if (!verified.ok) {
      return sendError(req, res, 401, verified.error);
    }

    const paymentsEnabled = Boolean(cfg.paymentsEnabled);
    const sub = paymentsEnabled ? calibration.getSubscription(verified.user.id) : null;
    const isPro = paymentsEnabled ? Boolean(sub?.active) : true;
    const token = signSessionToken({
      role: 'user',
      isPro,
      telegramUserId: verified.user.id,
      username: verified.user.username,
      firstName: verified.user.first_name,
    });

    return sendJson(req, res, 200, {
      ok: true,
      token,
      auth: {
        authenticated: true,
        role: 'user',
        is_admin: false,
        is_pro: isPro,
        payments_enabled: paymentsEnabled,
        telegram_user_id: verified.user.id,
        username: verified.user.username,
        first_name: verified.user.first_name,
        subscription_expires_at: sub?.expires_at || null,
      },
    });
  });

  app.post('/api/auth/admin/claim', (req, res) => {
    if (isAdminConfigured()) {
      return sendError(
        req,
        res,
        409,
        'Un accès administrateur est déjà configuré. Utilisez la connexion admin.'
      );
    }
    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode : '';
    if (passcode.length < 8) {
      return sendError(
        req,
        res,
        400,
        'Le code administrateur doit contenir au moins 8 caractères.'
      );
    }

    const hash = hashPasscode(passcode);
    const claimed = calibration.claimSettingOnce('admin_passcode_hash', hash);
    if (!claimed) {
      return sendError(req, res, 409, 'L’accès administrateur vient déjà d’être initialisé.');
    }

    const token = signSessionToken({ role: 'admin', isPro: true });
    return sendJson(req, res, 201, {
      ok: true,
      token,
      auth: {
        authenticated: true,
        role: 'admin',
        is_admin: true,
        is_pro: true,
        admin_configured: true,
        admin_claimed: true,
      },
    });
  });

  app.post('/api/auth/admin/login', (req, res) => {
    if (!isAdminConfigured()) {
      return sendError(
        req,
        res,
        403,
        'Aucun accès administrateur configuré. Initialisez-le d’abord.'
      );
    }
    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode : '';
    if (!passcode) {
      return sendError(req, res, 400, 'Code administrateur requis.');
    }

    const envValid = cfg.adminPasscode ? verifyEnvPasscode(passcode, cfg.adminPasscode) : false;
    const storedHash = calibration.getSetting('admin_passcode_hash');
    const hashValid = storedHash ? verifyPasscodeHash(passcode, storedHash) : false;

    if (!envValid && !hashValid) {
      return sendError(req, res, 401, 'Code administrateur invalide.');
    }

    const token = signSessionToken({ role: 'admin', isPro: true });
    return sendJson(req, res, 200, {
      ok: true,
      token,
      auth: {
        authenticated: true,
        role: 'admin',
        is_admin: true,
        is_pro: true,
        admin_configured: true,
        admin_claimed: isAdminClaimed(),
      },
    });
  });

  app.post('/api/auth/admin/pro-preview', requireAdmin, (req, res) => {
    if (!cfg.paymentsEnabled) {
      return sendError(req, res, 410, 'Le paiement est actuellement désactivé.');
    }
    const enabled = req.body?.enabled !== false;
    const token = signSessionToken({
      role: 'admin',
      isPro: enabled,
      proPreviewOff: !enabled,
    });
    return sendJson(req, res, 200, {
      ok: true,
      token,
      is_pro: enabled,
      is_admin: true,
    });
  });

  app.post('/api/billing/checkout', async (req, res) => {
    if (!cfg.paymentsEnabled) {
      return sendError(req, res, 410, 'Le paiement est actuellement désactivé.');
    }
    if (!cfg.telegramBotToken) {
      return sendError(
        req,
        res,
        503,
        'Paiement Telegram Stars non configuré sur ce serveur (TELEGRAM_BOT_TOKEN requis).'
      );
    }
    if (!req.auth?.authenticated || !req.auth.telegramUserId) {
      return sendError(
        req,
        res,
        401,
        'Ouvrez Truevalue depuis Telegram et authentifiez votre session avant de souscrire.'
      );
    }

    const amountStars = Math.max(1, Number(cfg.telegramProStarsPrice || 1500));
    const invoicePayload = JSON.stringify({
      telegramUserId: req.auth.telegramUserId,
      plan: 'pro_monthly',
      nonce: crypto.randomUUID(),
    });

    try {
      const tgResp = await fetch(
        `https://api.telegram.org/bot${cfg.telegramBotToken}/createInvoiceLink`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Truevalue Pro · 30 jours',
            description:
              'Accès complet aux signaux BF×PM, seuils ajustables et 72 signatures sans limite.',
            payload: invoicePayload,
            currency: 'XTR',
            prices: [{ label: 'Abonnement Truevalue Pro (30 jours)', amount: amountStars }],
          }),
          signal: AbortSignal.timeout(8_000),
        }
      );
      const body = await tgResp.json().catch(() => null);
      if (!tgResp.ok || !body?.ok || !body?.result) {
        console.error('Erreur createInvoiceLink Telegram:', body);
        return sendError(req, res, 502, 'Impossible de générer la facture Telegram Stars.');
      }
      return sendJson(req, res, 200, {
        ok: true,
        invoice_url: body.result,
        currency: 'XTR',
        amount_stars: amountStars,
      });
    } catch (err) {
      console.error('Erreur billing checkout:', err);
      return sendError(req, res, 502, 'Service de paiement Telegram temporairement indisponible.');
    }
  });

  app.post('/api/billing/telegram-webhook', async (req, res) => {
    if (!cfg.telegramWebhookSecret) {
      return sendError(req, res, 503, 'Webhook Telegram non configuré sur ce serveur.');
    }
    const headerSecret = req.headers?.['x-telegram-bot-api-secret-token'];
    if (
      typeof headerSecret !== 'string' ||
      !constantTimeStringEqual(headerSecret, cfg.telegramWebhookSecret)
    ) {
      return sendError(req, res, 401, 'Signature webhook invalide.');
    }
    const update = req.body || {};
    // Les commandes /start, /alertes et /stop fonctionnent même si les paiements sont
    // désactivés (PAYMENTS_ENABLED=0 par défaut).
    const command = await alerts.handleUpdate(update);
    if (command.handled) {
      return sendJson(req, res, 200, { ok: true, command: command.command || null, error: command.error || null });
    }
    if (!cfg.paymentsEnabled) {
      return sendError(req, res, 410, 'Le paiement est actuellement désactivé.');
    }

    if (update.pre_checkout_query && cfg.telegramBotToken) {
      try {
        await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/answerPreCheckoutQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pre_checkout_query_id: update.pre_checkout_query.id,
            ok: true,
          }),
          signal: AbortSignal.timeout(5_000),
        });
      } catch (err) {
        console.error('Erreur answerPreCheckoutQuery:', err);
      }
    }

    const sp = update.message?.successful_payment;
    if (sp) {
      let parsedPayload = {};
      try {
        parsedPayload = JSON.parse(sp.invoice_payload || '{}');
      } catch {
        parsedPayload = {};
      }
      const userId = parsedPayload.telegramUserId || update.message?.from?.id;
      const minStars = Math.max(1, Number(cfg.telegramProStarsPrice || 1500));
      if (userId && sp.currency === 'XTR' && Number(sp.total_amount || 0) >= minStars) {
        const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
        calibration.upsertSubscription({
          telegramUserId: String(userId),
          status: 'active',
          plan: parsedPayload.plan || 'pro_monthly',
          expiresAt,
          chargeId: sp.telegram_payment_charge_id || null,
        });
      }
    }

    return sendJson(req, res, 200, { ok: true });
  });

  /* ---- API ANALYSE & DONNÉES ---- */
  app.get('/api/compare', async (req, res) => {
    const force = req.query?.force === '1' && Boolean(req.auth?.isAdmin);
    const maxParam = Number.parseInt(String(req.query?.max || '28'), 10);
    const maxFixtures = Number.isFinite(maxParam) ? Math.min(40, Math.max(1, maxParam)) : 28;
    const shouldRecord = req.query?.record !== '0';
    const { preset, thresholdOverrides } = parseProposalQuery(req.query);
    const isDefaultSnapshot = preset === DEFAULT_PROPOSAL_PRESET && !thresholdOverrides;

    try {
      const result = await buildComparison({
        scraper,
        polymarket,
        force,
        maxFixtures,
        preset,
        thresholdOverrides,
      });
      let recorded = null;
      if (shouldRecord && isDefaultSnapshot && result.rows.length > 0) {
        recorded = calibration.recordFromComparison(result.rows);
      }
      return sendJson(
        req,
        res,
        200,
        redactComparePayload(
          {
            ok: true,
            ...result,
            recorded,
          },
          effectiveReadAuth(req)
        )
      );
    } catch (err) {
      console.error('Erreur /api/compare:', err);
      return sendError(req, res, 502, 'Comparaison des marchés momentanément indisponible.');
    }
  });

  app.get('/api/configurations', async (req, res) => {
    const force = req.query?.force === '1' && Boolean(req.auth?.isAdmin);
    const maxParam = Number.parseInt(String(req.query?.max || '28'), 10);
    const maxPmLookup = Number.isFinite(maxParam) ? Math.min(40, Math.max(1, maxParam)) : 28;

    const thresholds = {};
    for (const key of [
      'equilibreMaxPp',
      'faibleMaxPp',
      'modereeMaxPp',
      'forteMaxPp',
      'stableMaxPct',
      'strongMovePct',
    ]) {
      const v = Number(req.query?.[key]);
      if (Number.isFinite(v) && v > 0) thresholds[key] = v;
    }

    try {
      const report = await buildConfigurations({
        scraper,
        polymarket,
        calibration,
        force,
        maxPmLookup,
        thresholds,
      });
      return sendJson(
        req,
        res,
        200,
        redactConfigurationsPayload(
          {
            ok: true,
            ...report,
          },
          effectiveReadAuth(req)
        )
      );
    } catch (err) {
      console.error('Erreur /api/configurations:', err);
      return sendError(req, res, 502, 'Analyse des configurations momentanément indisponible.');
    }
  });

  app.get('/api/signals', async (req, res) => {
    const force = req.query?.force === '1' && Boolean(req.auth?.isAdmin);
    const maxParam = Number.parseInt(String(req.query?.max || '28'), 10);
    const maxPmLookup = Number.isFinite(maxParam) ? Math.min(40, Math.max(1, maxParam)) : 28;
    const shouldRecord = req.query?.record !== '0';
    const { preset, thresholdOverrides } = parseProposalQuery(req.query);
    const isDefaultSnapshot = preset === DEFAULT_PROPOSAL_PRESET && !thresholdOverrides;

    try {
      const result = await buildSignals({
        scraper,
        polymarket,
        force,
        maxPmLookup,
        preset,
        thresholdOverrides,
      });
      let recorded = null;
      if (
        shouldRecord &&
        isDefaultSnapshot &&
        Array.isArray(result.all_signals) &&
        result.all_signals.length > 0
      ) {
        recorded = calibration.recordFromSignals(result);
      }
      return sendJson(
        req,
        res,
        200,
        redactSignalsPayload(
          {
            ok: true,
            ...result,
            recorded,
          },
          effectiveReadAuth(req)
        )
      );
    } catch (err) {
      console.error('Erreur /api/signals:', err);
      return sendError(req, res, 502, 'Calcul des signaux momentanément indisponible.');
    }
  });

  app.get('/api/signals/results', async (req, res) => {
    const doSettle = req.query?.settle === '1';
    if (doSettle) {
      if (!req.auth?.authenticated) {
        return sendError(req, res, 401, 'Authentification administrateur requise pour régler.');
      }
      if (!req.auth.isAdmin) {
        return sendError(req, res, 403, 'Accès administrateur requis pour régler les scores.');
      }
    }
    const category = typeof req.query?.category === 'string' ? req.query.category.trim() : 'all';
    const { limit, offset } = parsePaginationQuery(req.query);

    try {
      let settlement = null;
      if (doSettle) {
        settlement = await calibration.settle({ espn, sportscore, cfg });
      }
      return sendJson(req, res, 200, {
        ok: true,
        settlement,
        ...calibration.signalResultsReport({ category, limit, offset, minN: cfg.calibrationMinN }),
      });
    } catch (err) {
      console.error('Erreur /api/signals/results:', err);
      return sendError(req, res, 502, 'Résultats des signaux momentanément indisponibles.');
    }
  });

  app.get('/api/calibration', async (req, res) => {
    const doSettle = req.query?.settle === '1';
    if (doSettle) {
      if (!req.auth?.authenticated) {
        return sendError(req, res, 401, 'Authentification administrateur requise pour régler.');
      }
      if (!req.auth.isAdmin) {
        return sendError(req, res, 403, 'Accès administrateur requis pour régler les scores.');
      }
    }
    const category = typeof req.query?.category === 'string' ? req.query.category.trim() : 'all';
    const { limit, offset } = parsePaginationQuery(req.query);

    try {
      let settlement = null;
      if (doSettle) {
        settlement = await calibration.settle({ espn, sportscore, cfg });
      }
      return sendJson(req, res, 200, {
        ok: true,
        settlement,
        ...calibration.report({ category, limit, offset, minN: cfg.calibrationMinN }),
      });
    } catch (err) {
      console.error('Erreur /api/calibration:', err);
      return sendError(req, res, 502, 'Rapport de calibration momentanément indisponible.');
    }
  });

  app.post('/api/calibration/sync', requireAdmin, async (req, res) => {
    try {
      const force = req.query?.force === '1';
      const [cmpResult, sigResult] = await Promise.all([
        buildComparison({
          scraper,
          polymarket,
          force,
          maxFixtures: 28,
        }),
        buildSignals({
          scraper,
          polymarket,
          force,
          maxPmLookup: 28,
        }),
      ]);
      const snapshots = recordGapSnapshots(sources, cmpResult.rows);
      const recorded = calibration.recordFromComparison(cmpResult.rows);
      const recordedSignals = calibration.recordFromSignals(sigResult);
      const settlement = await calibration.settle({ espn, sportscore, cfg });
      return sendJson(req, res, 200, {
        ok: true,
        recorded,
        recorded_signals: recordedSignals,
        settlement,
        gap_snapshots: snapshots,
        alertes: await runAlertTick(),
        signal_results: calibration.signalResultsReport({ minN: cfg.calibrationMinN }),
        ...calibration.report({ minN: cfg.calibrationMinN }),
      });
    } catch (err) {
      console.error('Erreur POST /api/calibration/sync:', err);
      return sendError(req, res, 502, 'Synchronisation des scores momentanément impossible.');
    }
  });

  app.get('/api/health', (req, res) => {
    return sendJson(req, res, 200, {
      ok: true,
      sources: ['arbworld', 'polymarket', 'espn', 'sportscore'],
      enabled: {
        arbworld: true,
        polymarket: cfg.polymarketEnabled !== false,
        espn: cfg.espnEnabled !== false,
        sportscore: !cfg.sportscoreDisabled,
      },
    });
  });

  /* ---- INSPECTEUR SOURCES (ADMIN STRICT) ---- */
  app.get('/api/sources', requireAdmin, (req, res) => {
    return sendJson(req, res, 200, {
      ok: true,
      sources: [
        {
          id: 'arbworld',
          name: 'Arbworld / Betfair',
          endpoint: '/api/sources/arbworld',
          enabled: true,
        },
        {
          id: 'polymarket',
          name: 'Polymarket (Gamma / CLOB)',
          endpoint: '/api/sources/polymarket',
          enabled: cfg.polymarketEnabled !== false,
        },
        {
          id: 'espn',
          name: 'ESPN Soccer Scoreboard',
          endpoint: '/api/sources/espn',
          enabled: cfg.espnEnabled !== false,
        },
        {
          id: 'sportscore',
          name: 'SportScore',
          endpoint: '/api/sources/sportscore',
          enabled: !cfg.sportscoreDisabled,
        },
      ],
      arbworld_markets: ALL_MARKETS.map((key) => {
        const def = marketDef(key);
        return {
          key: def.key,
          label: def.label,
          short: def.short,
          shape: def.shape,
          slot_labels: def.slot_labels,
          help: def.help,
        };
      }),
      espn_leagues: LEAGUES,
      espn_default_leagues: DEFAULT_LEAGUES,
      sportscore_slugs: [
        { slug: 'italian-serie-c', name: 'Serie C (Italie)' },
        { slug: 'greek-super-league-2', name: 'Super League 2 (Grèce)' },
        { slug: 'elite-league-u20', name: 'Elite League U20' },
        { slug: 'international-friendly', name: 'Amicaux internationaux' },
      ],
    });
  });

  app.get('/api/sources/arbworld', requireAdmin, async (req, res) => {
    const rawMarket =
      typeof req.query?.market === 'string' ? req.query.market.trim() : '1x2';
    const force = req.query?.force === '1';

    try {
      if (rawMarket === 'all') {
        const markets = await mapWithConcurrency(ALL_MARKETS, 3, async (key) => {
          const def = marketDef(key);
          const reply = await scraper.fetch(key, force);
          const rows = enrich(reply.rows, key, reply.source, reply.ageSeconds);
          const totalVolume = round2(rows.reduce((acc, r) => acc + (r.total_volume || 0), 0));
          return {
            key: def.key,
            label: def.label,
            short: def.short,
            shape: def.shape,
            fetch_source: reply.source,
            age_seconds: reply.ageSeconds,
            updated_at: reply.dataUpdatedAt,
            error: reply.error,
            total_volume: totalVolume,
            count: rows.length,
            rows,
          };
        });
        return sendJson(req, res, 200, {
          ok: true,
          source: 'arbworld',
          market: 'all',
          markets,
        });
      }

      const key = parseMarketKey(rawMarket);
      if (!key) {
        return sendError(req, res, 400, `Marché Arbworld inconnu : ${rawMarket}`);
      }

      const def = marketDef(key);
      const reply = await scraper.fetch(key, force);
      const rows = enrich(reply.rows, key, reply.source, reply.ageSeconds);
      const totalVolume = round2(rows.reduce((acc, r) => acc + (r.total_volume || 0), 0));

      return sendJson(req, res, 200, {
        ok: true,
        source: 'arbworld',
        market: def.key,
        label: def.label,
        short: def.short,
        shape: def.shape,
        slot_labels: def.slot_labels,
        fetch_source: reply.source,
        age_seconds: reply.ageSeconds,
        updated_at: reply.dataUpdatedAt,
        error: reply.error,
        total_volume: totalVolume,
        count: rows.length,
        rows,
      });
    } catch (err) {
      console.error('Erreur /api/sources/arbworld:', err);
      return sendError(req, res, 502, 'Source Arbworld momentanément indisponible.');
    }
  });

  app.get('/api/sources/polymarket', requireAdmin, async (req, res) => {
    if (cfg.polymarketEnabled === false) {
      return sendJson(req, res, 200, {
        ok: true,
        source: 'polymarket',
        enabled: false,
        count: 0,
        events: [],
      });
    }

    const force = req.query?.force === '1';
    const home = typeof req.query?.home === 'string' ? req.query.home.trim() : '';
    const away = typeof req.query?.away === 'string' ? req.query.away.trim() : '';

    if (home && away) {
      const rawDate = typeof req.query?.date === 'string' ? req.query.date.trim() : '';
      const kickoffAt = rawDate ? parseKickoff(rawDate) : null;
      const meta = { error: null };
      const quote = await polymarket.quote(
        fixtureKey(home, away),
        home,
        away,
        kickoffAt,
        { force, meta }
      );
      if (meta.error && !quote) {
        console.error('Erreur quote Polymarket:', meta.error);
        return sendError(req, res, 502, 'Source Polymarket momentanément indisponible.');
      }
      return sendJson(req, res, 200, {
        ok: true,
        source: 'polymarket',
        enabled: true,
        mode: 'match',
        home,
        away,
        quote,
      });
    }

    const q = typeof req.query?.q === 'string' ? req.query.q.trim() : '';
    const parsedLimit = Number.parseInt(String(req.query?.limit || '15'), 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(30, Math.max(1, parsedLimit)) : 15;

    try {
      const events = await polymarket.search(q, { limit, force });
      return sendJson(req, res, 200, {
        ok: true,
        source: 'polymarket',
        enabled: true,
        mode: q ? 'search' : 'active',
        query: q,
        count: events.length,
        events,
      });
    } catch (err) {
      console.error('Erreur /api/sources/polymarket:', err);
      return sendError(req, res, 502, 'Source Polymarket momentanément indisponible.');
    }
  });

  app.get('/api/sources/espn', requireAdmin, async (req, res) => {
    if (cfg.espnEnabled === false) {
      return sendJson(req, res, 200, {
        ok: true,
        source: 'espn',
        enabled: false,
        count: 0,
        errors: [],
        events: [],
      });
    }

    const rawLeague = typeof req.query?.league === 'string' ? req.query.league.trim() : '';
    const slugs = rawLeague
      ? rawLeague
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 12)
      : DEFAULT_LEAGUES;

    const invalidSlug = slugs.find((s) => !VALID_LEAGUE_SLUGS.has(s));
    if (invalidSlug) {
      return sendError(req, res, 400, `Ligue ESPN invalide : ${invalidSlug}`);
    }

    const rawDate = typeof req.query?.date === 'string' ? req.query.date.trim() : '';
    if (rawDate && !normalizeIsoDate(rawDate)) {
      return sendError(req, res, 400, 'Format de date invalide (attendu : YYYY-MM-DD).');
    }
    const espnDate = rawDate ? toEspnDateParam(rawDate) : null;

    const { events, errors } = await espn.many(slugs, espnDate, 4);
    return sendJson(req, res, 200, {
      ok: true,
      source: 'espn',
      enabled: true,
      leagues: slugs,
      date: rawDate ? normalizeIsoDate(rawDate) : null,
      count: events.length,
      errors,
      events,
    });
  });

  app.get('/api/sources/sportscore', requireAdmin, async (req, res) => {
    if (cfg.sportscoreDisabled) {
      return sendJson(req, res, 200, {
        ok: true,
        source: 'sportscore',
        enabled: false,
        count: 0,
        warnings: [],
        events: [],
      });
    }

    const rawDate = typeof req.query?.date === 'string' ? req.query.date.trim() : '';
    const day = rawDate ? normalizeIsoDate(rawDate) : todayIsoUtc();
    if (!day) {
      return sendError(req, res, 400, 'Format de date invalide (attendu : YYYY-MM-DD).');
    }

    const rawSlug = typeof req.query?.slug === 'string' ? req.query.slug.trim() : '';
    const rawLeague = typeof req.query?.league === 'string' ? req.query.league.trim() : '';

    let slugs;
    if (rawSlug) {
      slugs = rawSlug
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8);
    } else if (rawLeague) {
      slugs = competitionSlugs(rawLeague);
      if (slugs.length === 0) slugs = [rawLeague];
    } else {
      slugs = DEFAULT_SPORTSCORE_SLUGS;
    }

    const invalidSlug = slugs.find((s) => !/^[a-z0-9-]+$/i.test(s));
    if (invalidSlug) {
      return sendError(req, res, 400, `Slug SportScore invalide : ${invalidSlug}`);
    }

    const requests = slugs.map((slug) => [day, slug]);
    const { events, warnings } = await sportscore.many(requests, 4);
    return sendJson(req, res, 200, {
      ok: true,
      source: 'sportscore',
      enabled: true,
      slugs,
      date: day,
      count: events.length,
      warnings,
      events,
    });
  });

  // Cron Cloudflare -> Render : sync + flush KV, protégé par un secret partagé.
  app.post('/api/cron/sync', async (req, res) => {
    if (!cfg.cronSecret) {
      return sendError(req, res, 503, 'CRON_SECRET non configuré sur ce serveur.');
    }
    const provided = String(req.headers?.['x-cron-secret'] || '');
    if (!provided || !constantTimeStringEqual(provided, cfg.cronSecret)) {
      return sendError(req, res, 401, 'Secret cron invalide.');
    }
    try {
      return sendJson(req, res, 200, { ok: true, ...(await runSyncAndFlush()) });
    } catch (err) {
      console.error('Erreur /api/cron/sync:', err);
      return sendError(req, res, 502, 'Synchronisation momentanément indisponible.');
    }
  });

  /* ---- API v2 : surface publique, snake_case, aucune clé interne ---- */
  const v2Configurations = () =>
    buildConfigurations({ scraper, polymarket, force: false, maxPmLookup: 28 });
  const v2Signals = () =>
    buildSignals({ scraper, polymarket, force: false, maxPmLookup: 28 });

  app.get('/api/v2/ecarts', async (req, res) => {
    try {
      const [signals, configurations] = await Promise.all([v2Signals(), v2Configurations()]);
      return sendJson(
        req,
        res,
        200,
        buildEcarts({ signals, configurations, type: String(req.query?.type || 'all'), showPmLinks: cfg.showPmLinks !== false })
      );
    } catch (err) {
      console.error('Erreur /api/v2/ecarts:', err);
      return sendError(req, res, 502, 'Écarts momentanément indisponibles.');
    }
  });

  app.get('/api/v2/ecarts/:id', async (req, res) => {
    try {
      const [signals, configurations] = await Promise.all([v2Signals(), v2Configurations()]);
      const detail = buildEcartDetail({
        id: req.params.id,
        signals,
        configurations,
        gapStore,
        showPmLinks: cfg.showPmLinks !== false,
      });
      if (!detail) return sendError(req, res, 404, 'Écart introuvable.');
      return sendJson(req, res, 200, detail);
    } catch (err) {
      console.error('Erreur /api/v2/ecarts/:id:', err);
      return sendError(req, res, 502, 'Détail de l’écart momentanément indisponible.');
    }
  });

  app.get('/api/v2/matchs', async (req, res) => {
    try {
      const configurations = await v2Configurations();
      return sendJson(req, res, 200, buildMatchs({ configurations, q: req.query?.q || '' }));
    } catch (err) {
      console.error('Erreur /api/v2/matchs:', err);
      return sendError(req, res, 502, 'Matchs momentanément indisponibles.');
    }
  });

  app.get('/api/v2/bilan', (req, res) => {
    try {
      const report = calibration.report({ limit: 500, minN: cfg.calibrationMinN });
      return sendJson(req, res, 200, buildBilan({ calibrationReport: report }));
    } catch (err) {
      console.error('Erreur /api/v2/bilan:', err);
      return sendError(req, res, 502, 'Bilan momentanément indisponible.');
    }
  });

  app.get('/api/v2/laboratoire', async (req, res) => {
    try {
      const configurations = await v2Configurations();
      const report = calibration.report({ limit: 500, minN: cfg.calibrationMinN });
      return sendJson(
        req,
        res,
        200,
        buildLaboratoire({ configurations, calibrationReport: report, intensity: req.query?.intensity })
      );
    } catch (err) {
      console.error('Erreur /api/v2/laboratoire:', err);
      return sendError(req, res, 502, 'Laboratoire momentanément indisponible.');
    }
  });

  // Fiche d'une configuration, ouverte depuis le sélecteur du Laboratoire.
  app.get('/api/v2/laboratoire/configuration', async (req, res) => {
    try {
      const configurations = await v2Configurations();
      const report = calibration.report({ limit: 500, minN: cfg.calibrationMinN });
      const detail = buildConfigurationDetail({
        code: req.query?.code,
        configurations,
        calibrationReport: report,
      });
      if (!detail) return sendError(req, res, 404, 'Configuration introuvable.');
      return sendJson(req, res, 200, detail);
    } catch (err) {
      console.error('Erreur /api/v2/laboratoire/configuration:', err);
      return sendError(req, res, 502, 'Configuration momentanément indisponible.');
    }
  });

  app.get('/api/v2/sources/status', (req, res) => {
    return sendJson(
      req,
      res,
      200,
      buildSourcesStatus({
        cfg,
        scraper,
        polymarket,
        espn,
        sportscore,
        calibration,
        gapStore,
      })
    );
  });

  // Alertes Telegram : l'identité vient du token signé émis après validation
  // serveur de initData (auth.js), jamais d'un paramètre client de confiance.
  app.get('/api/v2/alertes', (req, res) => {
    const userId = req.auth?.telegramUserId;
    if (!userId) return sendError(req, res, 401, 'Authentification Telegram requise.');
    const sub = alerts.getSubscription(userId);
    return sendJson(req, res, 200, {
      ok: true,
      actif: Boolean(sub?.actif),
      regles: sub?.rules || alerts.rules,
      abonnement_souscrit: Boolean(calibration.getSubscription?.(userId)?.active),
    });
  });

  app.post('/api/v2/alertes', (req, res) => {
    const userId = req.auth?.telegramUserId;
    if (!userId) return sendError(req, res, 401, 'Authentification Telegram requise.');
    const actif = req.body?.actif === true || req.body?.actif === '1';
    if (actif) {
      const sub = alerts.subscribe(userId, req.body?.chat_id ?? null, req.body?.regles || {});
      return sendJson(req, res, 200, { ok: true, actif: true, regles: sub?.rules || alerts.rules });
    }
    const removed = alerts.unsubscribe(userId);
    return sendJson(req, res, 200, { ok: true, actif: false, desabonne: removed });
  });

  /* ---- ASSETS STATIQUES & SPA ---- */
  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });

  app.get(['/', '/index.html'], (req, res) => {
    return sendAsset(req, res, 'text/html; charset=utf-8', getStaticAsset(path.join(SITE_DIR, 'index.html')));
  });

  app.get('/app.js', (req, res) => {
    return sendAsset(req, res, 'application/javascript; charset=utf-8', getStaticAsset(path.join(SITE_DIR, 'app.js')));
  });

  app.get('/style.css', (req, res) => {
    return sendAsset(req, res, 'text/css; charset=utf-8', getStaticAsset(path.join(SITE_DIR, 'style.css')));
  });

  const serveJsModule = (dir, file, req, res) => {
    const name = String(file || '');
    if (!/^[a-z0-9_-]+\.js$/i.test(name)) return sendError(req, res, 404, 'Module introuvable.');
    const resolved = path.resolve(dir, name);
    if (!resolved.startsWith(dir + path.sep) || !fs.existsSync(resolved)) {
      return sendError(req, res, 404, 'Module introuvable.');
    }
    return sendAsset(req, res, 'application/javascript; charset=utf-8', getStaticAsset(resolved));
  };

  app.get('/modules/:file', (req, res) => serveJsModule(MODULES_DIR, req.params.file, req, res));
  app.get('/modules/views/:file', (req, res) => serveJsModule(path.join(MODULES_DIR, 'views'), req.params.file, req, res));
  app.get('/modules/ui/:file', (req, res) => serveJsModule(path.join(MODULES_DIR, 'ui'), req.params.file, req, res));

  /* ---- INTERFACE HISTORIQUE /legacy (derrière ADMIN_PASSCODE) ---- */
  const requireLegacyAccess = (req, res, next) => {
    if (req.auth?.isAdmin) return next();
    const header = String(req.headers?.authorization || '');
    if (header.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const sep = decoded.indexOf(':');
        const passcode = sep >= 0 ? decoded.slice(sep + 1) : '';
        if (cfg.adminPasscode && verifyEnvPasscode(passcode, cfg.adminPasscode)) return next();
        const stored = calibration.getSetting?.('admin_passcode_hash');
        if (stored && verifyPasscodeHash(passcode, stored)) return next();
      } catch {
        // Identifiants invalides : on refuse ci-dessous.
      }
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="Truevalue Legacy", charset="UTF-8"');
    return sendError(req, res, 401, 'Accès legacy réservé à l’administrateur.');
  };

  app.get(['/legacy', '/legacy/'], requireLegacyAccess, (req, res) =>
    sendAsset(req, res, 'text/html; charset=utf-8', getStaticAsset(path.join(LEGACY_DIR, 'index.html')))
  );
  app.get('/legacy/index.html', requireLegacyAccess, (req, res) =>
    sendAsset(req, res, 'text/html; charset=utf-8', getStaticAsset(path.join(LEGACY_DIR, 'index.html')))
  );
  app.get('/legacy/app.js', requireLegacyAccess, (req, res) =>
    sendAsset(req, res, 'application/javascript; charset=utf-8', getStaticAsset(path.join(LEGACY_DIR, 'app.js')))
  );
  app.get('/legacy/style.css', requireLegacyAccess, (req, res) =>
    sendAsset(req, res, 'text/css; charset=utf-8', getStaticAsset(path.join(LEGACY_DIR, 'style.css')))
  );
  app.get('/legacy/modules/:file', requireLegacyAccess, (req, res) =>
    serveJsModule(path.join(LEGACY_DIR, 'modules'), req.params.file, req, res)
  );

  app.use((req, res) => {
    return sendError(req, res, 404, 'Route inconnue.');
  });

  app.use((err, req, res, _next) => {
    if (err?.type === 'entity.parse.failed') {
      return sendError(req, res, 400, 'Corps JSON invalide.');
    }
    console.error('Erreur serveur non gérée:', err);
    return sendError(req, res, 500, 'Erreur interne du serveur.');
  });

  return app;
}

export async function startServer(
  cfgOrSources = null,
  { host = '0.0.0.0', port = null } = {}
) {
  const sources =
    cfgOrSources && cfgOrSources.scraper && cfgOrSources.polymarket
      ? cfgOrSources
      : createSources(cfgOrSources || loadConfig());
  if (IS_PROD && !sources.cfg?.adminPasscode) {
    throw new Error('ADMIN_PASSCODE doit être défini pour démarrer en production.');
  }

  // Render gratuit : pas de disque persistant. On hydrate depuis Cloudflare KV
  // avant de construire les stores, puis on-force le mode JSON.
  if (sources.cfg?.storageBackend === 'cloudflare') {
    const cloudflare = createCloudflareStorage({ cfg: sources.cfg });
    sources.cloudflare = cloudflare;
    if (cloudflare.enabled) {
      const dataDir = path.dirname(sources.calibration.filePath);
      const hydrated = await cloudflare.hydrate(dataDir);
      console.log(`Cloudflare KV : ${hydrated.loaded.length} fichier(s) hydraté(s).`);
      sources.calibration = new CalibrationStore(path.join(dataDir, 'observations.json'), {
        forceJson: true,
      });
      sources.gapStore = new GapSnapshotsStore({
        db: null,
        filePath: path.join(dataDir, 'gap_snapshots.json'),
        reportError: (ok, operation, err) => sources.calibration._recordPersistence?.(ok, operation, err),
      });
    } else {
      console.warn(`Cloudflare KV inactif — variables manquantes : ${cloudflare.missing.join(', ')}`);
    }
  }

  const app = createApp(sources);
  const listenPort = port ?? sources.cfg?.port ?? 3000;

  return new Promise((resolve, reject) => {
    const server = app.listen(listenPort, host, () => {
      const intervalSecs =
        sources.cfg?.syncMode === 'external' ? 0 : Number(sources.cfg?.syncIntervalSecs ?? 0);
      let syncTimer = null;
      if (Number.isFinite(intervalSecs) && intervalSecs > 0) {
        const runBackgroundSync = async () => {
          try {
            const [cmpResult, sigResult] = await Promise.all([
              buildComparison({
                scraper: sources.scraper,
                polymarket: sources.polymarket,
                force: false,
                maxFixtures: 28,
              }),
              buildSignals({
                scraper: sources.scraper,
                polymarket: sources.polymarket,
                force: false,
                maxPmLookup: 28,
              }),
            ]);
            if (cmpResult.rows.length > 0) {
              recordGapSnapshots(sources, cmpResult.rows);
              sources.calibration.recordFromComparison(cmpResult.rows);
            }
            if (Array.isArray(sigResult.all_signals) && sigResult.all_signals.length > 0) {
              sources.calibration.recordFromSignals(sigResult);
            }
            await sources.runAlertTick?.();
            await sources.calibration.settle({
              espn: sources.espn,
              sportscore: sources.sportscore,
              cfg: sources.cfg,
            });
            if (sources.cloudflare?.enabled) {
              await sources.cloudflare.flush(path.dirname(sources.calibration.filePath));
            }
          } catch (err) {
            console.error('Erreur synchronisation automatique:', err);
          }
        };
        syncTimer = setInterval(runBackgroundSync, intervalSecs * 1000);
        syncTimer.unref();
      }

      server.on('close', () => {
        if (syncTimer) {
          clearInterval(syncTimer);
          syncTimer = null;
        }
      });

      resolve({ app, server, sources });
    });
    server.on('error', reject);
  });
}

const isEntrypoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  const cfg = loadConfig();
  const sources = createSources(cfg);
  console.log(`Truevalue — port ${cfg.port} (Arbworld, Polymarket, ESPN, SportScore)`);
  startServer(sources, { host: '0.0.0.0', port: cfg.port })
    .then(({ server }) => {
      const shutdown = () => {
        server.close(() => {
          sources.calibration.close();
          process.exit(0);
        });
        setTimeout(() => process.exit(0), 5000).unref();
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    })
    .catch((err) => {
      console.error(`Serveur arrêté : ${err.message || err}`);
      process.exit(1);
    });
}
