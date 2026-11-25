# Architecture — Truevalue (après refonte v2)

## Flux des données

```
Arbworld (scrape.js) ─┐
Polymarket (polymarket.js) ─┼─> compare.js ─> configurations.js ─> recommend.js ─> signaux
ESPN / SportScore ─────────┘                         │                              │
                                                     │                              v
                                              calibration.js (observation, règlement, Brier)
                                                     │
                                                     v
                                       API v2 ─> interface site/ ─> alertes Telegram
```

1. `collectFixturesAndQuotes()` (dans `configurations.js`) interroge Arbworld par marché et recherche les cotations Polymarket dans une fenêtre configurable (`pmSearchFutureHours`, `pmSearchPastHours`, `pmLookupMax`).
2. `analyzeFixtureConfiguration()` produit 4 axes (orientation, intensité, variation **ouverture → actuel**, concordance) et une signature parmi 72.
3. `evaluateFixtureRecommendations()` (`recommend.js`) calcule une seule fois `net_edge_pp` (valeur nette = écart − spread) et dérive le **Niveau** : Fort ≥ 4, Moyen ≥ 2, Faible < 2, **Limité** sous 5 000 $ de liquidité Polymarket. `high/moderate/low` ne sont que des paliers internes (`CONFIDENCE_TO_NIVEAU`).
4. `buildSignalsFromData()` produit quatre familles de signaux : écarts nets (`executable`), flux/retards (`flow`), mouvements Betfair (`movement`) et contradictions (`contradiction`). Les **convergences** (accord Betfair × Polymarket sur le même favori d’un marché) sont calculées par `analyzeConcordance()` et exposées comme cartes `conv` sans valeur nette. La liste publique est triée par valeur nette décroissante puis liquidité. Les clés `sort_key`/alias v1 `interest_score`/`score_sort` ne sortent jamais de l’API v2.
5. À chaque synchronisation (`POST /api/calibration/sync` et tâche de fond), `recordGapSnapshots()` écrit un point réel par issue dans `gap_snapshots` (purge à 7 jours) ; le mini-graphique de la fiche détail lit cette table, sans courbe simulée.
6. `calibration.js` enregistre les observations, règle les matchs via ESPN/SportScore et calcule Brier, taux de confirmation (avec n) et rendement théorique (avec `roi_n`).

## Stockage

| Support | Mode | Données |
|---|---|---|
| `node:sqlite` (`data/truevalue.db`) | `sqlite` (Node ≥ 22.5) | `observations`, `signal_records`, `subscriptions`, `app_settings`, `gap_snapshots` |
| Fichiers JSON | `json` (repli Node < 22.5) | `observations.json`, `signal_history.json`, `store-meta.json`, `gap_snapshots.json` |

Le mode est détecté à l’exécution. Toute erreur de persistance est remontée par `getPersistenceStatus()` dans `/api/v2/sources/status` (`erreur_persistance`, `derniere_reussite_at`). Les écritures d’observations utilisent des upserts par ligne (plus de `DELETE` + réinsertion massive).

Migration rejouable : `_migrateObservations()` ajoute `first_seen`, `last_pre_kickoff`, `signature_code`, `signature_complete` avec des `null` pour l’historique existant. Un profil de buts impossible est `quality_status = donnees_incoherentes`, exclu des contradictions et des 72 signatures, compté dans `quality_report`.

## Routes v2 (contrat)

| Route | Contenu |
|---|---|
| `GET /api/v2/ecarts?type=all\|net\|mv\|ct\|conv\|flow` | Cartes : match, marché, issue, probabilités, écart, spread, valeur nette, niveau, liquidité, volume, fraîcheur, `pm_url` (si `SHOW_PM_LINKS`). Types d'analyse : `net` écarts nets, `mv` mouvements Betfair, `ct` contradictions, `conv` accords Betfair × Polymarket sur un même marché, `flow` retards/flux sans cote (aucun rendement en unités). |
| `GET /api/v2/ecarts/:id` | Détail : toutes les issues, causes dédoublonnées, 4 mesures, historique réel `gap_snapshots` |
| `GET /api/v2/matchs?q=` | Matchs avec `has_betfair` / `has_polymarket` |
| `GET /api/v2/bilan` | Brier + n, fiabilité par type (n, taux de confirmation, `sample_warning` sous 30), rendement théorique + `roi_n`, derniers résultats Confirmé/Infirmé/Remboursé |
| `GET /api/v2/laboratoire?intensity=` | Par signature : n réglés, n règles, k favori gagnant, IC Wilson 95 % calculé côté serveur, probabilité marché, intensité, contradictions, convergences, période ; couverture, seuils, avertissement sous 30. L’union des signatures live complètes, live partielles et historiques réglées est affichée : une signature partielle (ex. `2 \| Oui \| ? \| G4`) n’est plus masquée. |
| `GET /api/v2/laboratoire/configuration?code=` | Fiche d'une configuration : 4 paramètres, explication, seuils d'intensité, KPI (n réglés, taux, IC 95 %, probabilité marché, contradictions, convergences) et matchs associés (live + historique) |
| `GET /api/v2/sources/status` | Fraîcheur par source (`age_s`, `etat` ok/retard/panne), état de persistance, snapshots |
| `GET/POST /api/v2/alertes` | État et activation/désactivation des alertes pour l’utilisateur Telegram authentifié |

Toutes les routes v2 passent par les middlewares `rateLimit.js` et `auth.js`. Aucun champ interne (`sort_key`, `tier`, `confidence_score`, `score_sort`, `interest_score`) n’est exposé.

## Interface

- `site/` : ES modules sans framework ni build. `api.js` (appels v2 + session Telegram), `state.js`, `views/{ecarts,matchs,bilan,laboratoire}.js`, `ui/{sheet,toast,format}.js`, `app.js`.
- `site-legacy/` : ancienne interface servie sous `/legacy` derrière `ADMIN_PASSCODE` (Basic auth ou session admin). Les routes `/api/*` historiques restent disponibles et marquées dépréciées.
- États obligatoires sur chaque écran : chargement (squelette), erreur réseau (bouton Réessayer), aucun résultat, source en retard (⚠ > 10 min), source en panne (bandeau).
- Thème clair/sombre via `prefers-color-scheme` et `themeParams` Telegram, jetons CSS, cibles tactiles natives, `aria-label`, focus visible, `safe-area-inset-*`.

## Alertes Telegram

Règle configurable : valeur nette ≥ `ALERT_NET_MIN_PP`, liquidité ≥ `ALERT_PM_MIN_LIQUIDITY_USD`, données âgées de moins de `ALERT_MAX_AGE_S`, coup d’envoi à venir. Anti-spam : un message par couple match + issue et par jour, plafond `ALERT_DAILY_CAP` par utilisateur, désabonnement immédiat via `/stop` ou `POST /api/v2/alertes {actif:false}`. `PAYMENTS_ENABLED=0` reste la valeur par défaut ; les paiements Stars ne sont pas modifiés.
