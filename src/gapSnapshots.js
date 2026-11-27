// Historique réel de l'écart (Phase 3.1) : table gap_snapshots, purge à 7 jours.
// Aucune courbe simulée : chaque point provient d'une synchronisation réelle.
// Repli JSON quand node:sqlite est indisponible (Node < 22.5), comme CalibrationStore.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_RETENTION_DAYS = 7;
// Garde-fou mémoire : au-delà, on ne conserve que les points les plus récents.
const MAX_ROWS = 120_000;

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
    this.lastByKey = new Map();
    this.purge();
    this._rebuildIndex();
  }

  _keyOf(row) {
    return `${row.fixture_key}\u0000${row.market}\u0000${row.side}`;
  }

  _rebuildIndex() {
    this.lastByKey = new Map();
    for (const row of this.rows) this._remember(row);
  }

  _remember(row) {
    const key = this._keyOf(row);
    const prev = this.lastByKey.get(key);
    if (!prev || String(prev.ts) <= String(row.ts)) {
      this.lastByKey.set(key, { ts: row.ts, bf_pct: row.bf_pct, pm_pct: row.pm_pct });
    }
  }

  // Ajout en mémoire uniquement : l'écriture disque est faite une seule fois
  // par lot (sinon chaque point réécrit tout le fichier et fait exploser la mémoire).
  _appendRow(row) {
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
        return false;
      }
    }
    this.rows.push(row);
    this._remember(row);
    return true;
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
      fs.writeFileSync(this.filePath, `${JSON.stringify(this.rows)}\n`, 'utf8');
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

    if (!this._appendRow(row)) return null;
    if (!this.db) this._writeJson();
    return row;
  }

  // Enregistre un instantané pour chaque issue ayant deux probabilités réelles.
  // Les valeurs inchangées depuis le dernier point sont ignorées (le flux reste
  // lisible sans gonfler le fichier), et l'écriture disque est faite une seule fois.
  _recordOne(compared, ts) {
    const fixtureKey = compared?.fixture_key;
    if (!fixtureKey) return 0;
    let count = 0;
    for (const mkt of compared?.markets || []) {
      for (const side of mkt?.sides || []) {
        const bf = numOrNull(side.bf_pct);
        const pm = numOrNull(side.pm_norm_prob_pct ?? side.pm_pct);
        if (bf === null || pm === null) continue;
        const row = {
          fixture_key: String(fixtureKey),
          market: String(mkt.market || ''),
          side: String(side.label || ''),
          ts,
          bf_pct: bf,
          pm_pct: pm,
        };
        if (!row.market || !row.side) continue;
        const prev = this.lastByKey.get(this._keyOf(row));
        if (prev && prev.bf_pct === bf && prev.pm_pct === pm) continue;
        if (this._appendRow(row)) count += 1;
      }
    }
    return count;
  }

  recordCompared(compared, now = new Date()) {
    const ts = (now instanceof Date ? now : new Date(now)).toISOString();
    const count = this._recordOne(compared, ts);
    if (count > 0 && !this.db) this._writeJson();
    return count;
  }

  // Lot complet d'une synchronisation : une seule écriture disque à la fin.
  recordBatch(comparedList, now = new Date()) {
    const ts = (now instanceof Date ? now : new Date(now)).toISOString();
    let count = 0;
    for (const compared of Array.isArray(comparedList) ? comparedList : []) {
      count += this._recordOne(compared, ts);
    }
    if (count > 0 && !this.db) this._writeJson();
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
    let kept = this.rows.filter((r) => {
      const t = Date.parse(r.ts);
      return Number.isFinite(t) && t >= cutoff;
    });
    if (kept.length > MAX_ROWS) {
      kept = kept
        .slice()
        .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
        .slice(-MAX_ROWS);
    }
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
    this._rebuildIndex();
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
