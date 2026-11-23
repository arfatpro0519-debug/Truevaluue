// Définition des marchés football suivis sur Arbworld / Betfair.

export const MarketShape = Object.freeze({
  ThreeWay: 'three_way',
  TwoWay: 'two_way',
  Multi: 'multi',
});

export const MarketKey = Object.freeze({
  OneXTwo: '1x2',
  OverUnder25: 'over-under-2-5',
  Btts: 'btts',
  DoubleChance: 'double-chance',
  DrawNoBet: 'dnb',
  OverUnder15: 'over-under-1-5',
  OverUnder35: 'over-under-3-5',
  HalfTime: 'half-time',
  CorrectScore: 'correct-score',
  HalfTimeFullTime: 'ht-ft',
});

export const ALL_MARKETS = Object.freeze([
  MarketKey.OneXTwo,
  MarketKey.OverUnder25,
  MarketKey.Btts,
  MarketKey.DoubleChance,
  MarketKey.DrawNoBet,
  MarketKey.OverUnder15,
  MarketKey.OverUnder35,
  MarketKey.HalfTime,
  MarketKey.CorrectScore,
  MarketKey.HalfTimeFullTime,
]);

const MARKET_DEFS = {
  [MarketKey.OneXTwo]: {
    key: MarketKey.OneXTwo,
    label: 'Résultat du match (1X2)',
    short: '1X2',
    category: 'core',
    shape: MarketShape.ThreeWay,
    arbworld: 'MATCH_ODDS',
    slot_labels: ['1 (Domicile)', 'X (Nul)', '2 (Extérieur)'],
    help: 'Volume sur victoire domicile, nul ou victoire extérieur.',
  },
  [MarketKey.OverUnder25]: {
    key: MarketKey.OverUnder25,
    label: 'Plus / Moins 2.5 buts',
    short: '+/- 2.5',
    category: 'goals',
    shape: MarketShape.TwoWay,
    arbworld: 'OVER_UNDER_25',
    slot_labels: ['Moins 2.5 (Under)', null, 'Plus 2.5 (Over)'],
    help: 'Moins de 2.5 buts (0 à 2) contre plus de 2.5 buts (3 et +).',
  },
  [MarketKey.Btts]: {
    key: MarketKey.Btts,
    label: 'Les 2 équipes marquent',
    short: 'BTTS',
    category: 'goals',
    shape: MarketShape.TwoWay,
    arbworld: 'BOTH_TEAMS_TO_SCORE',
    slot_labels: ['Oui', null, 'Non'],
    help: 'Les deux équipes marquent-elles au moins un but ?',
  },
  [MarketKey.DoubleChance]: {
    key: MarketKey.DoubleChance,
    label: 'Double chance',
    short: 'Double chance',
    category: 'core',
    shape: MarketShape.ThreeWay,
    arbworld: 'DOUBLE_CHANCE',
    slot_labels: [
      '1X (Dom ou nul)',
      'X2 (Nul ou extérieur)',
      '12 (Dom ou extérieur)',
    ],
    help: 'Deux issues couvertes en un seul pari.',
  },
  [MarketKey.DrawNoBet]: {
    key: MarketKey.DrawNoBet,
    label: 'Remboursé si nul (DNB)',
    short: 'DNB',
    category: 'core',
    shape: MarketShape.TwoWay,
    arbworld: 'DRAW_NO_BET',
    slot_labels: ['1 (DNB domicile)', null, '2 (DNB extérieur)'],
    help: 'Mise remboursée en cas de match nul.',
  },
  [MarketKey.OverUnder15]: {
    key: MarketKey.OverUnder15,
    label: 'Plus / Moins 1.5 buts',
    short: '+/- 1.5',
    category: 'goals',
    shape: MarketShape.TwoWay,
    arbworld: 'OVER_UNDER_15',
    slot_labels: ['Moins 1.5 (Under)', null, 'Plus 1.5 (Over)'],
    help: 'Moins de 1.5 buts (0 ou 1) contre plus de 1.5 buts (2 et +).',
  },
  [MarketKey.OverUnder35]: {
    key: MarketKey.OverUnder35,
    label: 'Plus / Moins 3.5 buts',
    short: '+/- 3.5',
    category: 'goals',
    shape: MarketShape.TwoWay,
    arbworld: 'OVER_UNDER_35',
    slot_labels: ['Moins 3.5 (Under)', null, 'Plus 3.5 (Over)'],
    help: 'Moins de 3.5 buts (0 à 3) contre plus de 3.5 buts (4 et +).',
  },
  [MarketKey.HalfTime]: {
    key: MarketKey.HalfTime,
    label: 'Mi-temps (1X2 MT)',
    short: 'Mi-temps',
    category: 'combo',
    shape: MarketShape.ThreeWay,
    arbworld: 'HALF_TIME',
    slot_labels: ['1 (MT domicile)', 'X (MT nul)', '2 (MT extérieur)'],
    help: 'Résultat à la fin de la première mi-temps.',
  },
  [MarketKey.CorrectScore]: {
    key: MarketKey.CorrectScore,
    label: 'Score exact',
    short: 'Score exact',
    category: 'scores',
    shape: MarketShape.Multi,
    arbworld: 'CORRECT_SCORE',
    slot_labels: ['Top score 1', 'Top score 2', 'Top score 3'],
    help: 'Répartition des volumes sur les scores exacts.',
  },
  [MarketKey.HalfTimeFullTime]: {
    key: MarketKey.HalfTimeFullTime,
    label: 'Mi-temps / fin de match',
    short: 'MT / FM',
    category: 'combo',
    shape: MarketShape.Multi,
    arbworld: 'HALF_TIME_FULL_TIME',
    slot_labels: ['1/1', 'X/1', 'X/X'],
    help: 'Combinaison du score à la mi-temps et au coup de sifflet final.',
  },
};

export function parseMarketKey(slug) {
  return ALL_MARKETS.find((m) => m === slug) || null;
}

export function marketDef(key) {
  return MARKET_DEFS[key];
}

export function neutralShare(def) {
  switch (def.shape) {
    case MarketShape.ThreeWay:
      return 100.0 / 3.0;
    case MarketShape.TwoWay:
      return 50.0;
    case MarketShape.Multi:
    default:
      return 15.0;
  }
}

export function isGoalsTotals(key) {
  return (
    key === MarketKey.OverUnder15 ||
    key === MarketKey.OverUnder25 ||
    key === MarketKey.OverUnder35
  );
}
