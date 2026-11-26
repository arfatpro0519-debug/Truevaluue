# Truevalue

- **But** : collecter et comparer les cotes football de 4 sources (Arbworld/Betfair, Polymarket, ESPN, SportScore), explorer les 72 signatures de marché et publier une calibration empirique. **Outil d’analyse statistique, 18+, aucun gain garanti. Non affilié à Betfair ni Polymarket.**
- **Prérequis** : Node.js ≥ 20 et npm. `node:sqlite` est utilisé à partir de Node 22.5 ; un repli JSON lecture/écriture couvre les versions antérieures.
- **Configuration** : copier `.env.example` vers `.env`. `ADMIN_PASSCODE` est obligatoire en production et protège l’ancienne interface sous `/legacy`. Voir la section conformité ci-dessous avant toute monétisation.
- **Lancement** : `npm install` puis `npm start` (ou `npm run dev`) ; écoute sur `PORT` (3000 par défaut).
- **Tests** : `npm run build`, `npm run lint` et `npm test` avant chaque commit.

## Surface HTTP

- **Nouvelle interface** : `/` (Écarts · Bilan · Matchs + Laboratoire), modules ES servis depuis `/modules/`.
- **API v2** (snake_case, sans clé interne) : `/api/v2/ecarts`, `/api/v2/ecarts/:id`, `/api/v2/matchs`, `/api/v2/bilan`, `/api/v2/laboratoire`, `/api/v2/sources/status`, `/api/v2/alertes`.
- **Anciennes routes `/api/*`** : toujours fonctionnelles, marquées `Deprecation`. Ancienne interface : `/legacy` (authentification Basic avec `ADMIN_PASSCODE` ou session admin).
- Bot Telegram : `/start`, `/alertes`, `/stop` via `POST /api/billing/telegram-webhook` avec le secret `X-Telegram-Bot-Api-Secret-Token`.

## Conformité (décisions du propriétaire)

- **Scraping Arbworld** : vérifier CGU/robots.txt, renseigner `SCRAPER_CONTACT`, respecter cache et rate limit ; un mode dégradé existe si le HTML change.
- **Contenu lié aux paris** : mention 18+ et absence de promesse de gain dans l’UI et les messages Telegram ; vérifier les règles Telegram/ANJ avant toute monétisation.
- **Liens Polymarket** : disponibilité légale variable selon le pays (France notamment). `SHOW_PM_LINKS=0` retire tous les liens et garde `pm_url: null` dans l’API v2.

Déploiement prévu : Render (plan gratuit) + cron Cloudflare + stockage Cloudflare Workers KV — guide complet dans [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Rien n'est poussé sur GitHub pour l'instant.

Architecture, tables et flux de données : [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Audit initial et décisions de refonte : [`docs/AUDIT.md`](docs/AUDIT.md).
