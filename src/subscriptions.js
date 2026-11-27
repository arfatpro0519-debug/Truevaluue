// Réglages et abonnements Telegram : extraits de CalibrationStore sans changer
// leur comportement (mêmes signatures, mêmes valeurs de retour).

import fs from 'node:fs';

export class SubscriptionStore {
  constructor({ db = null, metaFilePath, writeJson, reportError = () => {} }) {
    this.db = db;
    this.metaFilePath = metaFilePath;
    this._writeJson = writeJson;
    this._reportError = reportError;
    this._metaCache = null;
  }

  _readMeta() {
    if (this._metaCache) return this._metaCache;
    let meta = null;
    try {
      if (fs.existsSync(this.metaFilePath)) {
        meta = JSON.parse(fs.readFileSync(this.metaFilePath, 'utf8'));
      }
    } catch (err) {
      console.error('Lecture du stockage JSON impossible:', err?.message || err);
      this._reportError(false, 'read_meta', err);
    }
    this._metaCache = {
      settings: meta?.settings && typeof meta.settings === 'object' ? meta.settings : {},
      subscriptions:
        meta?.subscriptions && typeof meta.subscriptions === 'object' ? meta.subscriptions : {},
      source_heartbeats:
        meta?.source_heartbeats && typeof meta.source_heartbeats === 'object'
          ? meta.source_heartbeats
          : {},
    };
    return this._metaCache;
  }

  _writeMeta() {
    return this._writeJson(this.metaFilePath, this._readMeta(), 'write_meta');
  }

  getSourceHeartbeats() {
    return { ...this._readMeta().source_heartbeats };
  }

  setSourceHeartbeats(heartbeats) {
    const clean = {};
    for (const [name, at] of Object.entries(heartbeats || {})) {
      if (Number.isFinite(at)) clean[String(name)] = Number(at);
    }
    this._readMeta().source_heartbeats = clean;
    return this._writeMeta();
  }

  getSetting(key) {
    if (!key) return null;
    if (!this.db) {
      const value = this._readMeta().settings[String(key)];
      return value === undefined ? null : value;
    }
    try {
      const row = this.db
        .prepare('SELECT value FROM app_settings WHERE key = ?')
        .get(String(key));
      return row ? row.value : null;
    } catch {
      return null;
    }
  }

  setSetting(key, value) {
    if (!key) return false;
    if (!this.db) {
      this._readMeta().settings[String(key)] = String(value);
      return this._writeMeta();
    }
    try {
      this.db
        .prepare(
          'INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)'
        )
        .run(String(key), String(value), new Date().toISOString());
      return true;
    } catch {
      return false;
    }
  }

  claimSettingOnce(key, value) {
    if (!key) return false;
    if (!this.db) {
      const store = this._readMeta().settings;
      const id = String(key);
      if (Object.prototype.hasOwnProperty.call(store, id)) return false;
      store[id] = String(value);
      return this._writeMeta();
    }
    try {
      const res = this.db
        .prepare(
          'INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)'
        )
        .run(String(key), String(value), new Date().toISOString());
      return Number(res?.changes || 0) === 1;
    } catch {
      return false;
    }
  }

  getSubscription(telegramUserId) {
    if (!telegramUserId) return null;
    if (!this.db) {
      const row = this._readMeta().subscriptions[String(telegramUserId)];
      if (!row) return null;
      const active =
        row.status === 'active' &&
        (!row.expires_at || Date.parse(row.expires_at) > Date.now());
      return { ...row, active };
    }
    try {
      const row = this.db
        .prepare(
          'SELECT telegram_user_id, status, plan, expires_at, charge_id, updated_at FROM subscriptions WHERE telegram_user_id = ?'
        )
        .get(String(telegramUserId));
      if (!row) return null;
      const active =
        row.status === 'active' &&
        (!row.expires_at || Date.parse(row.expires_at) > Date.now());
      return { ...row, active };
    } catch {
      return null;
    }
  }

  upsertSubscription({
    telegramUserId,
    status = 'active',
    plan = 'pro_monthly',
    expiresAt = null,
    chargeId = null,
  }) {
    if (!telegramUserId) return null;
    const nowIso = new Date().toISOString();
    if (!this.db) {
      const store = this._readMeta().subscriptions;
      const id = String(telegramUserId);
      const previous = store[id] || {};
      store[id] = {
        telegram_user_id: id,
        status: String(status),
        plan: plan ? String(plan) : null,
        expires_at: expiresAt ? String(expiresAt) : null,
        charge_id: chargeId ? String(chargeId) : previous.charge_id || null,
        updated_at: nowIso,
      };
      if (!this._writeMeta()) return null;
      return this.getSubscription(id);
    }
    this.db
      .prepare(
        `INSERT INTO subscriptions (telegram_user_id, status, plan, expires_at, charge_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(telegram_user_id) DO UPDATE SET
           status = excluded.status,
           plan = excluded.plan,
           expires_at = excluded.expires_at,
           charge_id = COALESCE(excluded.charge_id, subscriptions.charge_id),
           updated_at = excluded.updated_at`
      )
      .run(
        String(telegramUserId),
        String(status),
        plan ? String(plan) : null,
        expiresAt ? String(expiresAt) : null,
        chargeId ? String(chargeId) : null,
        nowIso
      );
    return this.getSubscription(telegramUserId);
  }
}
