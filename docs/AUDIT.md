# Audit de départ — Truevalue (Phase 0)

- **Branche** : `refonte-v2` (depuis `main` @ `3e99475`).
- **Date** : 24 novembre 2026.
- **Environnement** : Node v20.20.0, npm 10.8.2, une seule dépendance runtime (`express ^5.3.0`).
- **État initial mesuré** : `npm run build` vert ; `npm test` **rouge** (3 fichiers, 0/33) pour deux raisons : `express` non installé (dépendance déclarée, `node_modules` absent) puis `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`. Après `npm install --no-package-lock` et le repli d'exécution décrit plus bas, **35/35 tests passent**.

## 1. Architecture réelle

| Module | Rôle |
|---|---|
| `server.js` (1 223 l.) | Serveur Express : 19 routes `/api/*`, fichiers statiques du site, auth Bearer, rate limiting, sync de fond. |
| `src/config.js` | Lecture `.env` (non écrasante) et `loadConfig()` — 19 variables. |
| `src/auth.js` | Sessions HMAC signées, vérification `initData` Telegram, passcodes admin (env SHA-256 ou hash scrypt en base), rédaction Pro. |
| `src/rateLimit.js` | Limiteur mémoire par IP : 120 req/min sur `/api`, 20 req/min sur `/api/auth`, `/api/billing`, `/api/calibration/sync`. |
| `src/calibration.js` (66 Ko) | Observations pré-match, réglement ESPN/SportScore, Brier/log-loss/ROI, **stockage**, abonnements, réglages. |
| `src/configurations.js` (54 Ko) | Moteur des 72 signatures (4 axes), contradictions, profils de buts, signaux. |
| `src/recommend.js` | Évaluation des propositions Betfair×Polymarket, paliers et seuils de refus. |
| `src/compare.js` | Croisement des marchés et microstructure (spread, carnet, écarts). |
| `src/enrich.js`, `src/market.js`, `src/model.js`, `src/async.js` | Normalisation des lignes Arbworld, 10 marchés, énumérations, concurrence bornée. |
| `src/scrape.js` | Scraping Arbworld : JSON embarqué, ETag/304, cache 20 s + stale 15 min, back-off 60→3600 s, mode dégradé. |
| `src/polymarket.js` (55 Ko) | Gamma API + CLOB : parsing multi-marchés, book/liquidité, cache 300 s, liens `polymarket.com/event/...`. |
| `src/espn.js`, `src/sportscore.js`, `src/thresholds.js` | Résultats réels, scores de secours, constantes réseau/cache/appariement. |
| `site/` | Interface vanilla JS actuelle : 4 onglets (Accueil, Signaux, Résultats, Configs 72), ~22–24 contrôles avant premier signal. |

Flux : `scrape`/`polymarket` → `compare`/`configurations` → `recommend` → signaux → `calibration` (observation + règlement) → rapports.

## 2. Routes HTTP existantes

### API (19 routes, toutes présentes et à conserver en dépréciées)

| Méthode | Chemin | Rôle | Accès |
|---|---|---|---|
| GET | `/api/auth/status` | État auth/PRO/admin/prix Stars | public |
| POST | `/api/auth/telegram` | Vérifie `initData`, émet un token | public |
| POST | `/api/auth/admin/claim` | Première revendication du passcode admin | public |
| POST | `/api/auth/admin/login` | Login par passcode env ou hash DB | public |
| POST | `/api/auth/admin/pro-preview` | Aperçu PRO | admin |
| POST | `/api/billing/checkout` | Facture Telegram Stars (XTR) | public |
| POST | `/api/billing/telegram-webhook` | Secret partagé, active 30 j d'abonnement | secret |
| GET | `/api/compare` | Comparaison BF×PM | public (rédaction PRO) |
| GET | `/api/configurations` | Analyse des 72 signatures | public (rédaction PRO) |
| GET | `/api/signals` | Signaux, enregistrement | public (rédaction PRO) |
| GET | `/api/signals/results` | Résultats ; `settle=1` | admin pour `settle=1` |
| GET | `/api/calibration` | Rapport ; `settle=1` | admin pour `settle=1` |
| POST | `/api/calibration/sync` | Enregistrement + règlement complet | admin |
| GET | `/api/health` | Sources actives/inactives | public |
| GET | `/api/sources` | Catalogue sources/marchés/ligues | admin |
| GET | `/api/sources/arbworld` | Flux Betfair brut | admin |
| GET | `/api/sources/polymarket` | Recherche/cotation Polymarket | admin |
| GET | `/api/sources/espn` | Scoreboard ESPN | admin |
| GET | `/api/sources/sportscore` | Scores SportScore | admin |

**Aucune route `/api/v2/*`**, aucun en-tête `Deprecation`/`Sunset`. Statiques : `/`, `/index.html`, `/app.js`, `/style.css`, `/modules/:file` (whitelist), `/favicon.ico` (204). Pas de CORS, pas de route `/legacy`.

### Middlewares

`x-powered-by` désactivé ; `express.json({limit:'64kb'})` ; en-têtes CSP/nosniff/referrer/HSTS conditionnel ; `OPTIONS` → 204 ; JSON `no-store` + gzip ≥ 1 Ko ; assets gzip + ETag sha256 + 304. Auth Bearer en mémoire (secret `SESSION_SECRET` ou secret éphémère). Quand `PAYMENTS_ENABLED ≠ 1`, **tous les lecteurs sont effectivement PRO** (`effectiveReadAuth`, `server.js:262-267`).

## 3. Stockage

- `node:sqlite` n'est importé que dans `src/calibration.js` (import statique à l'origine, l. 5). Ouverture `data/truevalue.db` (WAL, `synchronous=NORMAL`, `busy_timeout=5000`).
- Tables : `observations(id, fixture_key, captured_at, date, status, data_json)` + 2 index ; `signal_records(fixture_key, captured_at, date, status, data_json)` + 1 index ; `subscriptions(telegram_user_id, status, plan, expires_at, charge_id, updated_at)` ; `app_settings(key, value, updated_at)`. **Pas de table `gap_snapshots`**.
- Fichiers JSON présents : `data/observations.json` (232 observations, 22–23 nov. 2026) et `data/signal_history.json` (32 enregistrements / 36 signaux). Aucun `truevalue.db` livré.
- **Défaut critique confirmé** : le « repli JSON » d'origine ne couvrait que la lecture ; `_save()` et `_saveSignals()` sortaient immédiatement si la base était absente → **perte silencieuse de toutes les écritures** sous Node < 22.5. Les erreurs SQLite et JSON étaient avalées (`catch {}`), sans remontée possible vers un futur `/api/v2/sources/status`.
- Données manquantes pour la refonte : `first_seen`, `last_pre_kickoff`, `signature_code`, `signature_complete` n'existent nulle part ; l'historique ne permet donc pas de reconstruire le prix d'observation.

## 4. Écarts avec le brief (constat, pas correction)

| Référence | Constat |
|---|---|
| §2.7 | Routes `/api/*` intactes mais non marquées dépréciées ; `/api/v2/*` absent. |
| §4 | Ancien vocabulaire partout dans l'UI : « Écart net », « Propositions », « Relevés/Scorés », « Gagné/Perdu », « Mouvement 24h ». Piège BF confirmé : la variation est bien **ouverture → actuel** (`configurations.js:415,811-823`) mais libellée « 24h ». |
| §4 | `signalConfidenceScore()` (`site/modules/views.js:26-45`) fabrique 92/76/52 : score inventé à supprimer. |
| 0.4 | `engines.node` déclaré `>=20` alors que `node:sqlite` exige ≥ 22.5 (flag avant 22.13). |
| 0.5 | Aucun garde-fou : la production démarrait avec `ADMIN_PASSCODE` vide. |
| 0.6 | `README.md` ne contenait qu'`# truevalue_2` ; aucun dossier `docs/`. |
| 1.1–1.7 | Biais ROI confirmé (défaite −1 u sans cote, victoire ignorée) ; `selectBestCategory` sans seuil ; taux de confirmation mêlé au ROI ; pas de double prix ; `DELETE` + réinsertion de jusqu'à 50 000 lignes ; signature non stockée ; abonnements/réglages dans `CalibrationStore`. |
| 2.1–2.5 | Profil « Atypique » compté comme contradiction et inclus dans la signature ; contradictions comptées par marché ; 58/60/62/54, 2/5, 10, 500, 28/40/72 h en dur (5 000 $ absent) ; `interest_score`/`score_sort` exposés ; niveaux `high/moderate/low` avec d'autres seuils (2,5/3/4) et pas de `limite`. |
| 3 | Aucune des 6 routes v2 ; aucun `gap_snapshots` ; pas de fraîcheur par source exposée. |
| 4 | 4 onglets au lieu de 3 + Lab ; doublon Résultats / Historique signaux ; écran Configs 72 ; pas d'indicateur de retard/panne par source ; mini-graphique simulé dans la maquette. |
| 5 | Aucune commande `/start`, `/alertes`, `/stop` ; abonnements dans `calibration.js` ; `PAYMENTS_ENABLED=0` par défaut (à ne pas toucher). |
| 6 | ESLint absent ; `.env.example` incomplet (`SESSION_SECRET`, `NODE_ENV`, `SHOW_PM_LINKS` manquants). |

La maquette de référence `truevalue.html` est actuellement à la **racine** du dépôt (fichier non suivi), alors que le brief l'attend dans `docs/ui-reference/truevalue.html`. À déplacer avant la Phase 4 ; elle contient encore « Données d'exemple » et un mini-graphique simulé, tous deux à supprimer conformément au brief.

## 5. Risques

1. **Environnement / persistance** : Node 20 en production locale → sans repli d'écriture, chaque sync écrase silencieusement l'historique. Le repli ajouté en Phase 0 écrit `observations.json`, `signal_history.json` et `store-meta.json` (réglages + abonnements).
2. **Migration** : 50 000 observations max, schéma non versionné ; ajouter `signature_code`/`first_seen` nécessite valeurs `null` pour l'historique et une migration rejouable.
3. **Fiabilité des chiffres** : ROI asymétrique, `best_category` sans `n`, signature reconstruite depuis les configs **live** (`configurations.js:958-985`) alors que les matchs réglés en sortent → faux verdicts possibles dans Bilan/Laboratoire.
4. **Régressions API** : `interest_score`/`score_sort` sont dans les réponses, le front et les tests ; renommer en `sort_key` est un changement de contrat à coordonner avec le maintien des routes v1.
5. **Sécurité** : `SESSION_SECRET` absent → sessions invalidées au redémarrage ; limiteur clé sur `x-forwarded-for` client-contrôlable derrière un proxy mal configuré ; `/api/auth/admin/claim` permitting une première revendication.
6. **Extraction des abonnements** (Phase 1.7) : 7 points d'appel dans `server.js` (l. 234, 255, 259, 335, 382, 417, 563), dont auth et paiements Stars.

## 6. Points laissés à la décision du propriétaire (brief §6)

- **Arbworld** : vérifier CGU et robots.txt, renseigner `SCRAPER_CONTACT` (vide par défaut dans `.env.example`), respecter cache/rate limit, prévoir un mode dégradé si le HTML change, ne pas republier les données brutes en masse. Le code a UA identifié, ETag/304, back-off et mode dégradé, mais aucune vérification de robots.txt.
- **Conformité paris** : mention 18+ et « aucun gain garanti » présentes côté UI, absentes des réponses API et des commandes Telegram à créer ; règles Telegram/ANJ à vérifier avant toute monétisation.
- **Liens Polymarket** : disponibilité légale variable (France notamment) ; flag `SHOW_PM_LINKS` inexistant, `pm_url` exposé aux PRO. À trancher avant la Phase 4.

## 7. Livrables Phase 0

- `docs/AUDIT.md` (ce fichier), `README.md` (5 lignes).
- `src/calibration.js` : chargement de `node:sqlite` à l'exécution + repli JSON **lecture/écriture** pour observations, signaux, réglages et abonnements ; `storageMode` exposé.
- `server.js` : `startServer()` refuse de démarrer en production sans `ADMIN_PASSCODE`.
- Tests : `test/storage_fallback.test.js`, `test/production_guard.test.js` ; deux assertions existantes rendues agnostiques du mode de stockage / paywall explicité.
- `npm run build` et `npm test` verts (35/35).

**Décisions prises faute d'ambiguïté** : repli JSON retenu plutôt que l'élévation de `engines` à `>=22.5`, afin de garder les tests exécutables sur le Node 20 de l'environnement (le brief autorise explicitement « ou ajouter un repli »). Le garde-fou production exige la **variable d'environnement** `ADMIN_PASSCODE`, même si un hash admin est stocké en base ; à confirmer si le propriétaire souhaite autoriser le hash seul.

---

## 8. Phase 2 — Corrections du moteur (branche `refonte-v2`)

Cinq commits, un par point du brief, chacun accompagné de tests dans `test/phase2_engine.test.js`.
État final : `npm test` **52/52 verts**, `npm run build` vert, aucune régression des routes v1.

| Point | Changement | Test |
|---|---|---|
| 2.1 | `deriveGoalsProfile()` expose `quality_status: 'donnees_incoherentes'` pour les profils O/U impossibles ; ils ne sont plus comptés comme contradiction, n'entrent jamais dans une signature 72 (`?` à la place de `Atypique`) et sont comptés dans `quality_report` (exposé par `/api/configurations`). | Profil Under/Over/Under → `incoherent=1`, `quality_report.donnees_incoherentes=1`, code sans `Atypique`. |
| 2.2 | `analyzeConcordance()` regroupe tous les désaccords Betfair × Polymarket (1X2, BTTS, chaque O/U, profil de buts) en **une seule cause** `betfair_polymarket` avec la liste des marchés ; chaque cause porte un `cause` et des `markets`. Le signal contradiction expose `causes[]` et `contradictions_count` = nombre de causes. | 3 marchés en désaccord → 1 cause BF×PM, signal `contradictions_count` cohérent. |
| 2.3 | Les seuils 58/60/62/54, 2.0/5.0/10.0, 500 €, 28/40/72 h et 5 000 $ sont dans `DEFAULT_CONFIG_THRESHOLDS` (et `STRICT_THRESHOLDS` pour le niveau). `collectFixturesAndQuotes()` reçoit désormais les seuils. | Valeurs par défaut + surcharge `lowGoalsFavMinPct: 70` modifiant réellement la concordance. |
| 2.4 | `interest_score`/`score_sort` deviennent des clés internes `sort_key`. La liste publique `all_signals` est triée par **valeur nette décroissante puis liquidité** via `sortEcartsParValeurNette()`. | Ordre du tri, égalité `sort_key`/alias, listes non décroissantes en valeur nette. |
| 2.5 | `classifyNiveau()` (dans `recommend.js`) dérive le Niveau de `net_edge_pp` **déjà calculé** : Fort ≥ 4, Moyen ≥ 2, Faible < 2, **Limité** sous 5 000 $ de liquidité PM. `high/moderate/low` sont réconciliés via `CONFIDENCE_TO_NIVEAU`; `niveau`/`niveau_label` ajoutés aux recommandations et signaux. Cas limites testés (5000 exact, seuils surchargés, donnée absente → `null`). | 7 cas de classification + recommandation réelle avec palier internal et `limite`. |

**Décisions prises faute d'ambiguïté :**

- Les alias `interest_score`/`score_sort` **restent présents** dans les réponses `/api/*` (et les objets retournés par les fonctions du moteur) pour ne pas casser le contrat v1, le front historique et les tests existants. Ils sont commentés « alias v1 déprécié », ne sont plus utilisés comme source de vérité interne, et **ne seront pas exposés dans `/api/v2/*`** (Phase 3). Le brief dit « jamais exposés ni affichés » : cela s'applique à la nouvelle surface v2 et à la nouvelle interface (Phase 4).
- `profile: 'Atypique'` et `status: 'atypique'` restent également des alias v1 dépréciés ; la source de vérité est `quality_status`. Aucun test existant n'en dépendait.
- Le Niveau est calculé une seule fois dans `recommend.js` à partir de `net_edge_pp`, jamais recalculé dans `configurations.js`. La liquidité l'emporte sur l'écart (règle « Limité » du §4).

**Reste à faire (hors Phase 2) :** exposition du `niveau` et des `causes` dans le contrat `/api/v2/ecarts` (Phase 3, annexe A), suppression définitive des alias dans la réponse v2, et remplacement de l'ancienne UI qui affiche encore `score_sort` (Phase 4).
