# Déploiement — Render (gratuit) + Cloudflare (KV + cron gratuits)

> État : **préparé, non déployé**. Aucun push GitHub n'a été effectué et aucun secret n'est renseigné.

## Architecture cible

```
Cloudflare Cron Trigger (toutes les 10 min)
        │ POST /api/cron/sync  (X-Cron-Secret)
        ▼
Render Web Service (plan gratuit, Node >= 20)
        │  JSON local éphémère  ──flush──▶  Cloudflare Workers KV
        │  hydrate au démarrage ◀───────────  (4 fichiers)
        └──> alertes Telegram (bot token)
```

Le plan gratuit Render n'a **pas de disque persistant** : les fichiers `data/*.json` sont donc hydratés depuis Workers KV au démarrage, puis réécrits dans KV à chaque synchronisation. Le timer intégré au process est désactivé (`SYNC_MODE=external`) : c'est le cron Cloudflare qui déclenche les synchronisations.

## Fichiers ajoutés

| Fichier | Rôle |
|---|---|
| `render.yaml` | Blueprint Render : service web gratuit, `npm install` / `npm start`, healthcheck `/api/health`, variables `sync: false` pour les secrets |
| `cloudflare/cron-worker.js` | Worker appelant `POST /api/cron/sync` avec `X-Cron-Secret` |
| `cloudflare/wrangler.toml` | Déclencheur `*/10 * * * *` |
| `src/cloudflareStorage.js` | Hydratation/sauvegarde des 4 fichiers JSON via l'API REST KV (fetch + `node:crypto` non requis, aucune dépendance) |

## Secrets à fournir (plus tard)

À placer dans `.env` en local (fichier gitignoré) **et** dans le dashboard Render / `wrangler secret` en production :

- `ADMIN_PASSCODE` — obligatoire en production (garde-fou au démarrage) et protection de `/legacy`
- `SESSION_SECRET` — sessions signées stables
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` — alertes et validation `initData`
- `CRON_SECRET` — secret partagé avec le Worker
- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_KV_NAMESPACE_ID`, `CLOUDFLARE_API_TOKEN` — KV
- Optionnels : `SPORTSCORE_API_KEY`, `SCRAPER_CONTACT`

`PAYMENTS_ENABLED=0` reste la valeur par défaut. `SHOW_PM_LINKS` doit être validé par le propriétaire (disponibilité légale de Polymarket selon le pays).

## Étapes de déploiement (une fois les secrets fournis et le code poussé)

1. **Cloudflare KV** : créer un namespace, puis noter l'account ID et le namespace ID :
   ```bash
   npx wrangler kv namespace create TRUEVALUE
   npx wrangler secret put CLOUDFLARE_API_TOKEN     # pas dans wrangler.toml
   ```
2. **Render** : créer le Web Service depuis `render.yaml` (Blueprint), renseigner les variables `sync: false` dans le dashboard. Vérifier `/api/health`.
3. **Worker cron** :
   ```bash
   cd cloudflare
   npx wrangler secret put RENDER_BASE_URL   # https://<service>.onrender.com
   npx wrangler secret put CRON_SECRET        # identique à Render
   npx wrangler deploy
   ```
4. **Vérification** : `curl -X POST https://<service>.onrender.com/api/cron/sync -H "X-Cron-Secret: …"` doit répondre `{ok:true, stockage:{saved:[...]}}`.

## Limites à connaître

- Le plan gratuit Render met le service en veille après inactivité : le premier appel du cron peut être lent (démarrage à froid). Le Worker a sa propre limite de temps ; si elle est atteinte, augmenter l'intervalle ou passer à un plan payant.
- Workers KV est éventuellement cohérent (propagation en dizaines de secondes) : sans conséquence pour une sync toutes les 10 min.
- Tant qu'il n'y a pas de push GitHub, Render ne peut pas récupérer le code : le déploiement reste bloqué à cette étape (conformément à la consigne « pas de push pour l'instant »).
- Le scraping Arbworld et la disponibilité de Polymarket restent des décisions du propriétaire (voir `docs/AUDIT.md` §6).
