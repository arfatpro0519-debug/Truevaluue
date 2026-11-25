// Historique réel de l'écart (Phase 3.1) : table gap_snapshots, purge à 7 jours.
// Aucune courbe simulée : chaque point provient d'une synchronisation réelle.
// Repli JSON quand node:sqlite est indisponible (Node < 22.5), comme CalibrationStore.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_RETENTION_DAYS = 7;

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export class GapSnapshotsStore {
  constructor({
    db = null,
    filePath = path.resolve(process.cwd(), 'data', 'gap_snapshots.json'),
    retentionDays = DEFAULT_RETENTION_DAYS,
    reportError = null,
  } = {}) {
    this.db = db || null;
    this.storageMode = this.db ? 'sqlite' : 'json';
    this.filePath = filePath;
    this.retentionDays = retentionDays;
    this.reportError = typeof reportError === 'function' ? reportError : () => {};
    this.rows = [];

    if (this.db) {
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS gap_snapshots (
            fixture_key TEXT NOT NULL,
            market TEXT NOT NULL,
            side TEXT NOT NULL,
            ts TEXT NOT NULL,
            bf_pct REAL,
            pm_pct REAL
          );
          CREATE INDEX IF NOT EXISTS idx_gap_fixture ON gap_snapshots(fixture_key, market, side, ts);
        `);
      } catch (err) {
        this.reportError(false, 'gap_create_table', err);
        this.db = null;
        this.storageMode = 'json';
      }
    }
    this.rows = this._load();
    this.purge();
  }

  _load() {
    if (this.db) {
      try {
        const stmt = this.db.prepare(
          'SELECT fixture_key, market, side, ts, bf_pct, pm_pct FROM gap_snapshots ORDER BY ts ASC'
        );
        const rows = stmt.all();
        this.reportError(true, 'gap_read');
        return Array.isArray(rows) ? rows : [];
      } catch (err) {
        this.reportError(false, 'gap_read', err);
        return [];
      }
    }
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      this.reportError(false, 'gap_read_json', err);
      return [];
    }
  }

  _writeJson() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, `${JSON.stringify(this.rows, null, 2)}\n`, 'utf8');
      this.reportError(true, 'gap_write_json');
    } catch (err) {
      this.reportError(false, 'gap_write_json', err);
      console.error('Écriture gap_snapshots impossible:', err?.message || err);
    }
  }

  append({ fixture_key, market, side, ts = new Date().toISOString(), bf_pct = null, pm_pct = null }) {
    const row = {
      fixture_key: String(fixture_key || ''),
      market: String(market || ''),
      side: String(side || ''),
      ts: String(ts),
      bf_pct: numOrNull(bf_pct),
      pm_pct: numOrNull(pm_pct),
    };
    if (!row.fixture_key || !row.market || !row.side) return null;

    if (this.db) {
      try {
        this.db
          .prepare(
            'INSERT INTO gap_snapshots (fixture_key, market, side, ts, bf_pct, pm_pct) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(row.fixture_key, row.market, row.side, row.ts, row.bf_pct, row.pm_pct);
        this.reportError(true, 'gap_write');
      } catch (err) {
        this.reportError(false, 'gap_write', err);
        return null;
      }
    }
    this.rows.push(row);
    if (!this.db) this._writeJson();
    return row;
  }

  // Enregistre un instantané pour chaque issue ayant deux probabilités réelles.
  recordCompared(compared, now = new Date()) {
    const fixtureKey = compared?.fixture_key;
    if (!fixtureKey) return 0;
    const ts = (now instanceof Date ? now : new Date(now)).toISOString();
    let count = 0;
    for (const mkt of compared?.markets || []) {
      for (const side of mkt?.sides || []) {
        const bf = numOrNull(side.bf_pct);
        const pm = numOrNull(side.pm_norm_prob_pct ?? side.pm_pct);
        if (bf === null || pm === null) continue;
        if (this.append({ fixture_key: fixtureKey, market: mkt.market, side: side.label, ts, bf_pct: bf, pm_pct: pm })) {
          count += 1;
        }
      }
    }
    return count;
  }

  series(fixtureKey, market, side, { limit = 40 } = {}) {
    const rows = this.rows.filter(
      (r) => r.fixture_key === fixtureKey && r.market === market && (side === null || r.side === side)
    );
    const deduped = new Map();
    for (const r of rows) deduped.set(`${r.ts}|${r.side}`, r);
    return [...deduped.values()]
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
      .slice(-limit)
      .map((r) => ({
        ts: r.ts,
        bf_pct: r.bf_pct,
        pm_pct: r.pm_pct,
        ecart_pts: r.bf_pct !== null && r.pm_pct !== null ? Math.round((r.bf_pct - r.pm_pct) * 10) / 10 : null,
      }));
  }

  purge(now = Date.now()) {
    const cutoff = now - this.retentionDays * 24 * 60 * 60 * 1000;
    const kept = this.rows.filter((r) => {
      const t = Date.parse(r.ts);
      return Number.isFinite(t) && t >= cutoff;
    });
    const removed = this.rows.length - kept.length;
    if (removed === 0) return 0;
    if (this.db) {
      try {
        this.db
          .prepare('DELETE FROM gap_snapshots WHERE ts < ?')
          .run(new Date(cutoff).toISOString());
        this.reportError(true, 'gap_purge');
      } catch (err) {
        this.reportError(false, 'gap_purge', err);
      }
    }
    this.rows = kept;
    if (!this.db) this._writeJson();
    return removed;
  }

  status() {
    return {
      points: this.rows.length,
      retention_days: this.retentionDays,
      storage_mode: this.storageMode,
      oldest_ts: this.rows[0]?.ts ?? null,
      newest_ts: this.rows[this.rows.length - 1]?.ts ?? null,
    };
  }
}
