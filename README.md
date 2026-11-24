# Truevalue

- **But** : collecter et comparer les cotes football de 4 sources (Arbworld/Betfair, Polymarket, ESPN, SportScore), explorer 72 signatures de marché et publier une calibration empirique — outil d’analyse statistique, 18+, aucun gain garanti.
- **Prérequis** : Node.js ≥ 20 et npm ; `node:sqlite` est utilisé à partir de Node 22.5, avec repli JSON sur les versions antérieures.
- **Configuration** : copier `.env.example` vers `.env` et renseigner les variables ; `ADMIN_PASSCODE` est obligatoire en production.
- **Lancement** : `npm install` puis `npm start` (ou `npm run dev`) ; écoute sur `PORT` (3000 par défaut).
- **Tests** : `npm run build` et `npm test` avant chaque commit.
