// Stockage distant gratuit (Cloudflare Workers KV) pour un déploiement Render sans disque persistant.
// Aucune dépendance runtime : uniquement fetch + node:fs. Les secrets ne sont jamais loggés.

import fs from 'node:fs';
import path from 'node:path';

export const CLOUDFLARE_FILES = Object.freeze([
  'observations.json',
  'signal_history.json',
  'store-meta.json',
  'gap_snapshots.json',
]);

export function createCloudflareStorage({ cfg = {}, fetchImpl = fetch } = {}) {
  const account = cfg.cloudflareAccountId || null;
  const namespace = cfg.cloudflareKvNamespaceId || null;
  const token = cfg.cloudflareApiToken || null;
  const enabled = cfg.storageBackend === 'cloudflare' && Boolean(account && namespace && token);
  // Lecture/écriture de valeurs : /values/:key (le chemin /keys/ sert à lister les clés).
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}/values`;
  const headers = () => ({ Authorization: `Bearer ${token}` });

  const missing = [];
  if (cfg.storageBackend === 'cloudflare') {
    if (!account) missing.push('CLOUDFLARE_ACCOUNT_ID');
    if (!namespace) missing.push('CLOUDFLARE_KV_NAMESPACE_ID');
    if (!token) missing.push('CLOUDFLARE_API_TOKEN');
  }

  const check = (res, operation, key) => {
    if (res.ok) return true;
    if (res.status === 404 && operation === 'get') return false;
    throw new Error(`Cloudflare KV ${operation} ${key}: HTTP ${res.status}`);
  };

  return {
    enabled,
    missing,
    backend: enabled ? 'cloudflare_kv' : 'local',
    async hydrate(dataDir) {
      const loaded = [];
      if (!enabled) return { loaded, reason: missing.length ? `config manquante: ${missing.join(', ')}` : 'backend local' };
      for (const key of CLOUDFLARE_FILES) {
        const res = await fetchImpl(`${base}/${encodeURIComponent(key)}`, { headers: headers() });
        if (!check(res, 'get', key)) continue;
        const text = await res.text();
        const target = path.join(dataDir, key);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text, 'utf8');
        loaded.push(key);
      }
      return { loaded };
    },
    async flush(dataDir) {
      const saved = [];
      if (!enabled) return { saved, reason: missing.length ? `config manquante: ${missing.join(', ')}` : 'backend local' };
      for (const key of CLOUDFLARE_FILES) {
        const target = path.join(dataDir, key);
        if (!fs.existsSync(target)) continue;
        const body = fs.readFileSync(target, 'utf8');
        const res = await fetchImpl(`${base}/${encodeURIComponent(key)}`, {
          method: 'PUT',
          headers: { ...headers(), 'Content-Type': 'application/json' },
          body,
        });
        check(res, 'put', key);
        saved.push(key);
      }
      return { saved };
    },
  };
}
