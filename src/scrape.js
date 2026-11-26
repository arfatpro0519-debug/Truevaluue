// Collecte des flux Arbworld : extraction du JSON embarqué, cache,
// stale-while-revalidate, requêtes conditionnelles et back-off.

import { Source } from './model.js';

export function buildUserAgent(contact = null) {
  const base = 'truevalue/0.1.0';
  const trimmed = typeof contact === 'string' ? contact.trim() : '';
  return trimmed
    ? `${base} (+${trimmed})`
    : `${base} (contact: SCRAPER_CONTACT non defini)`;
}

export async function defaultHttpTransport(url, etag, lastModified, userAgent) {
  const headers = {
    'User-Agent': userAgent,
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
  };
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;

  let res;
  try {
    res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(9_000),
    });
  } catch (err) {
    throw new Error(`réseau : ${err.message || err}`, { cause: err });
  }

  const status = res.status;
  const retryHeader = res.headers.get('retry-after');
  let retryAfter = null;
  if (retryHeader) {
    const secs = Number.parseInt(retryHeader.trim(), 10);
    if (Number.isFinite(secs) && secs >= 0) {
      retryAfter = Math.min(secs, 3600);
    }
  }

  const body = status === 304 ? '' : await res.text();
  return {
    status,
    body,
    etag: res.headers.get('etag') || null,
    lastModified: res.headers.get('last-modified') || null,
    retryAfter,
  };
}

export function extractPayload(html) {
  if (typeof html !== 'string') return null;
  const start = html.indexOf('"success"');
  if (start < 0) return null;
  const objStart = html.lastIndexOf('{', start);
  if (objStart < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = objStart; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        const slice = html.slice(objStart, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export class Scraper {
  constructor(baseUrl, policy = {}, transport = defaultHttpTransport) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.policy = {
      ttlMs: (policy.ttlSecs ?? 20) * 1000,
      staleTtlMs: (policy.staleTtlSecs ?? 900) * 1000,
      userAgent: policy.userAgent || buildUserAgent(null),
      backoffBaseSecs: policy.backoffBaseSecs ?? 60,
      backoffMaxSecs: policy.backoffMaxSecs ?? 3600,
    };
    this.transport = transport;
    this.entries = new Map();
    this.inFlight = new Map();
    this.backoff = { failures: 0, untilMs: null, reason: null };
  }

  urlFor(key) {
    return `${this.baseUrl}/football/${key}`;
  }

  backoffRemainingSecs() {
    if (this.backoff.untilMs === null) return null;
    const diff = this.backoff.untilMs - Date.now();
    if (diff <= 0) return null;
    return Math.ceil(diff / 1000);
  }

  registerFailure(retryAfter, reason) {
    this.backoff.failures += 1;
    const shift = Math.min(6, Math.max(0, this.backoff.failures - 1));
    const factor = 1 << shift;
    const exponential = this.policy.backoffBaseSecs * factor;
    const wait = Math.min(
      this.policy.backoffMaxSecs,
      Math.max(retryAfter || 0, exponential)
    );
    this.backoff.untilMs = Date.now() + wait * 1000;
    this.backoff.reason = reason;
    return wait;
  }

  clearBackoff() {
    this.backoff.failures = 0;
    this.backoff.untilMs = null;
    this.backoff.reason = null;
  }

  cached(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    return {
      rows: entry.rows,
      ageMs: Math.max(0, Date.now() - entry.fetchedAtMs),
      ageSeconds: Math.floor(Math.max(0, Date.now() - entry.fetchedAtMs) / 1000),
      dataUpdatedAt: entry.dataUpdatedAt,
      etag: entry.etag,
      lastModified: entry.lastModified,
    };
  }

  fresh(key) {
    const c = this.cached(key);
    if (!c) return null;
    if (c.ageMs < this.policy.ttlMs) {
      return {
        rows: c.rows,
        source: Source.Cache,
        ageSeconds: c.ageSeconds,
        dataUpdatedAt: c.dataUpdatedAt,
        error: null,
      };
    }
    return null;
  }

  degraded(key, error) {
    const c = this.cached(key);
    if (c && c.ageMs < this.policy.staleTtlMs) {
      return {
        rows: c.rows,
        source: Source.Stale,
        ageSeconds: c.ageSeconds,
        dataUpdatedAt: c.dataUpdatedAt,
        error,
      };
    }
    return {
      rows: [],
      source: Source.Stale,
      ageSeconds: 0,
      dataUpdatedAt: null,
      error,
    };
  }

  parsePayload(body, key) {
    const payload = extractPayload(body);
    if (!payload) {
      throw new Error(`JSON embarqué introuvable pour ${key}`);
    }
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const updated =
      typeof payload.data_updated_at === 'string'
        ? payload.data_updated_at
        : null;
    return { rows, updated };
  }

  async fetch(key, force = false) {
    if (!force) {
      const f = this.fresh(key);
      if (f) return f;
    }

    if (this.inFlight.has(key)) {
      return this.inFlight.get(key);
    }

    const promise = (async () => {
      if (!force) {
        const f = this.fresh(key);
        if (f) return f;
      }

      const wait = this.backoffRemainingSecs();
      if (wait !== null) {
        const reason = this.backoff.reason
          ? ` (dernier refus : ${this.backoff.reason})`
          : '';
        return this.degraded(key, `collecte suspendue ${wait} s${reason}`);
      }

      const cached = this.entries.get(key);
      const etag = cached?.etag || null;
      const lastModified = cached?.lastModified || null;
      const url = this.urlFor(key);

      let reply;
      try {
        reply = await this.transport(
          url,
          etag,
          lastModified,
          this.policy.userAgent
        );
      } catch (err) {
        const msg = err.message || String(err);
        const w = this.registerFailure(null, msg);
        return this.degraded(key, `${msg} — prochaine tentative dans ${w} s`);
      }

      if (reply.status === 304) {
        this.clearBackoff();
        const entry = this.entries.get(key);
        if (!entry) {
          return this.degraded(key, 'réponse 304 sans copie locale');
        }
        entry.fetchedAtMs = Date.now();
        if (reply.etag) entry.etag = reply.etag;
        if (reply.lastModified) entry.lastModified = reply.lastModified;
        return {
          rows: entry.rows,
          source: Source.Cache,
          ageSeconds: 0,
          dataUpdatedAt: entry.dataUpdatedAt,
          error: null,
        };
      }

      if (reply.status >= 200 && reply.status < 300) {
        this.clearBackoff();
        try {
          const { rows, updated } = this.parsePayload(reply.body, key);
          if (rows.length === 0) {
            return this.degraded(key, 'réponse vide');
          }
          this.entries.set(key, {
            rows,
            fetchedAtMs: Date.now(),
            dataUpdatedAt: updated,
            etag: reply.etag || null,
            lastModified: reply.lastModified || null,
          });
          return {
            rows,
            source: Source.Live,
            ageSeconds: 0,
            dataUpdatedAt: updated,
            error: null,
          };
        } catch (err) {
          return this.degraded(key, err.message || String(err));
        }
      }

      const w = this.registerFailure(
        reply.retryAfter ?? null,
        `HTTP ${reply.status}`
      );
      return this.degraded(
        key,
        `HTTP ${reply.status} — prochaine tentative dans ${w} s`
      );
    })();

    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }
}
