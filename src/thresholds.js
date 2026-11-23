// Seuils réseau, cache et appariement des 4 sources de données.

// ESPN & SportScore
export const ESPN_MATCH_MIN_SIMILARITY = 0.62;
export const ESPN_MATCH_MAX_HOURS = 24;
export const SPORTSCORE_MATCH_MIN_SIMILARITY = 0.55;
export const SPORTSCORE_MATCH_MAX_HOURS = 24;
export const SPORTSCORE_TIMEOUT_SECS = 8;
export const SPORTSCORE_CACHE_TTL_SECS = 60;

// Polymarket (Gamma API / CLOB)
export const EXCHANGE_MATCH_MAX_HOURS = 6;
export const EXCHANGE_CACHE_TTL_SECS = 300;
export const EXCHANGE_MISS_CACHE_TTL_SECS = 60;
export const EXCHANGE_MAX_SPREAD = 0.25;
export const EXCHANGE_TIGHT_SPREAD = 0.08;
export const EXCHANGE_ENGINE_MIN_LIQUIDITY = 250.0;
export const EXCHANGE_TIMEOUT_SECS = 8;
