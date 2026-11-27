// Surface /api/v2 : constructions de réponses contractuelles, sans clé interne ni score inventé.
// Toutes les valeurs absentes restent null ; aucun chiffre n'est affiché sans son effectif.

import { MarketKey, marketDef } from './market.js';

const MIN_SAMPLE = 30;
const round1 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

// Codes de signature : le séparateur peut être « | » ou « | » selon la source.
// On normalise à l'entrée pour ne jamais créer deux signatures équivalentes.
function normalizeCode(code) {
  return String(code || '')
    .split('|')
    .map((part) => part.trim())
    .join(' | ');
}

function normalizeIntensity(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr');
}

const INTENSITY_LABELS = {
  equilibre: 'Équilibre',
  faible: 'Faible',
  moderee: 'Modérée',
  forte: 'Forte',
  extreme: 'Extrême',
};

function intensityFromObservation(obs, thresholds = {}) {
  const sides = (Array.isArray(obs?.sides) ? obs.sides : [])
    .filter((s) => Number.isFinite(s.bf_pct))
    .sort((a, b) => b.bf_pct - a.bf_pct);
  if (sides.length < 2) return null;
  const margin = round1(sides[0].bf_pct - sides[1].bf_pct);
  if (margin === null) return null;
  // Mêmes seuils stricts que classifyIntensity() dans configurations.js.
  if (margin < (Number(thresholds.equilibreMaxPp) || 4)) return 'equilibre';
  if (margin < (Number(thresholds.faibleMaxPp) || 12)) return 'faible';
  if (margin < (Number(thresholds.modereeMaxPp) || 24)) return 'moderee';
  if (margin < (Number(thresholds.forteMaxPp) || 40)) return 'forte';
  return 'extreme';
}

export function wilsonInterval(k, n, z = 1.96) {
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(k)) return [null, null];
  const p = Math.min(1, Math.max(0, k / n));
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [round1(100 * ((center - margin) / denom)), round1(100 * ((center + margin) / denom))];
}

function matchInfo(row) {
  return {
    home: row?.home ?? null,
    away: row?.away ?? null,
    league: row?.league ?? null,
    kickoff: row?.date ?? null,
  };
}

function freshness(row, heartbeats = null) {
  const markets = Array.isArray(row?.markets) ? row.markets : [];
  const bf = markets
    .filter((m) => Number.isFinite(m.bf_age_seconds ?? m.age_seconds))
    .map((m) => m.bf_age_seconds ?? m.age_seconds);
  const pm = markets.filter((m) => Number.isFinite(m.pm_age_seconds)).map((m) => m.pm_age_seconds);
  const heartbeatAge = (name) =>
    Number.isFinite(heartbeats?.[name])
      ? Math.max(0, Math.floor((Date.now() - heartbeats[name]) / 1000))
      : null;
  return {
    betfair_age_s: bf.length ? Math.min(...bf) : heartbeatAge('betfair'),
    polymarket_age_s: pm.length ? Math.min(...pm) : heartbeatAge('polymarket'),
  };
}

function cardFromSignal(s, row, showPmLinks = true, heartbeats = null) {
  const reco = s?.recommendation || {};
  const spread = Number.isFinite(reco.pm_spread_pts) ? reco.pm_spread_pts : null;
  const net = Number.isFinite(s.net_edge_pp) ? s.net_edge_pp : null;
  const ecart = net !== null && spread !== null ? round1(net + spread) : null;
  const type =
    s.category === 'movement'
      ? 'mv'
      : s.category === 'contradiction'
      ? 'ct'
      : s.category === 'flow'
      ? 'flow'
      : 'net';
  const card = {
    id: s.id,
    type,
    match: matchInfo(row),
    marche: s.market_short || s.market || null,
    issue: s.side_label || s.title || null,
    betfair_pct: Number.isFinite(reco.bf_pct) ? round1(reco.bf_pct) : null,
    polymarket_pct: Number.isFinite(reco.pm_exec_pct) ? round1(reco.pm_exec_pct) : Number.isFinite(reco.pm_pct) ? round1(reco.pm_pct) : null,
    ecart_pts: ecart,
    spread_pts: spread,
    valeur_nette_pts: net,
    niveau: s.niveau ?? null,
    niveau_label: s.niveau_label || 'Indisponible',
    liquidite_polymarket_usd: Number.isFinite(s.pm_liquidity) ? s.pm_liquidity : null,
    volume_betfair_eur: Number.isFinite(s.total_volume_bf) ? s.total_volume_bf : null,
    fixture_key: s.fixture_key || row?.fixture_key || null,
    fraicheur: freshness(row, heartbeats),
    pm_url: showPmLinks ? s.pm_url || null : null,
  };
  if (type === 'mv') {
    card.variation = {
      classe: s.signal_type ?? null,
      cote_ouverture: null,
      cote_actuelle: null,
      delta_prob_pts: Number.isFinite(s.prob_delta_pp) ? s.prob_delta_pp : null,
      base: 'ouverture_actuel',
    };
    card.polymarket_change_24h_pts = Number.isFinite(s.config_summary?.axes?.variation?.pm_change_1d_pts)
      ? s.config_summary.axes.variation.pm_change_1d_pts
      : null;
  }
  if (type === 'ct') {
    card.causes = Array.isArray(s.causes) ? s.causes : [];
  }
  if (type === 'flow') {
    card.flux = {
      type: s.signal_type ?? null,
      direction: s.direction ?? null,
      detail: s.detail ?? null,
    };
  }
  return card;
}

function indexRows(configurations) {
  return new Map(
    (Array.isArray(configurations?.rows) ? configurations.rows : []).map((r) => [r.fixture_key, r])
  );
}

// Les convergences sont calculées par le moteur (axes.concordance) mais n'étaient
// pas exposées : ce sont des accords Betfair × Polymarket sur un même marché,
// pas des écarts. Elles redeviennent visibles comme carte d'analyse (type `conv`).
export function buildConvergenceCards(configurations, heartbeats = null) {
  const rows = Array.isArray(configurations?.rows) ? configurations.rows : [];
  const cards = [];
  for (const row of rows) {
    const items = (row.axes?.concordance?.items || []).filter((i) => i.status === 'convergence');
    if (items.length === 0) continue;
    const agree = (row.markets || []).filter(
      (m) => m.source_bf && m.source_pm && m.favorite && m.favorite === m.pm_favorite
    );
    const m = agree[0] || null;
    cards.push({
      id: `conv::${row.fixture_key}`,
      type: 'conv',
      fixture_key: row.fixture_key,
      match: matchInfo(row),
      marche: m?.short || null,
      issue: m?.favorite || null,
      betfair_pct: Number.isFinite(m?.favorite_pct) ? round1(m.favorite_pct) : null,
      polymarket_pct: Number.isFinite(m?.pm_favorite_pct) ? round1(m.pm_favorite_pct) : null,
      ecart_pts: null,
      spread_pts: null,
      valeur_nette_pts: null,
      niveau: null,
      niveau_label: 'Non applicable',
      liquidite_polymarket_usd: Number.isFinite(row.pm_liquidity) ? row.pm_liquidity : null,
      volume_betfair_eur: Number.isFinite(row.total_volume_bf) ? row.total_volume_bf : null,
      fraicheur: freshness(row, heartbeats),
      pm_url: null,
      convergences: items.map((i) => ({ cause: i.cause || i.pair, detail: i.detail })),
      nombre_convergences: items.length,
    });
  }
  return cards;
}

export function buildEcarts({ signals, configurations, type = 'all', showPmLinks = true, heartbeats = null } = {}) {
  const byKey = indexRows(configurations);
  const all = Array.isArray(signals?.all_signals) ? signals.all_signals : [];
  const wanted = ['all', 'net', 'mv', 'ct', 'conv', 'flow'].includes(type) ? type : 'all';
  const cards = [
    ...all.map((s) => cardFromSignal(s, byKey.get(s.fixture_key), showPmLinks, heartbeats)),
    ...buildConvergenceCards(configurations, heartbeats),
  ].filter((c) => wanted === 'all' || c.type === wanted);
  // Tri public : valeur nette décroissante puis liquidité (brief 2.4).
  cards.sort(
    (a, b) =>
      (b.valeur_nette_pts ?? -Infinity) - (a.valeur_nette_pts ?? -Infinity) ||
      (b.liquidite_polymarket_usd ?? 0) - (a.liquidite_polymarket_usd ?? 0)
  );
  return {
    ok: true,
    type: wanted,
    total: cards.length,
    ecarts: cards,
  };
}

export function buildEcartDetail({ id, signals, configurations, gapStore, showPmLinks = true, heartbeats = null } = {}) {
  const byKey = indexRows(configurations);
  const all = Array.isArray(signals?.all_signals) ? signals.all_signals : [];
  const signal = all.find((item) => item.id === id) || null;
  const convergence = signal
    ? null
    : buildConvergenceCards(configurations, heartbeats).find((c) => c.id === id) || null;
  if (!signal && !convergence) return null;
  const card = convergence || cardFromSignal(signal, byKey.get(signal.fixture_key), showPmLinks, heartbeats);
  const row = byKey.get(card.fixture_key || signal?.fixture_key) || null;
  const markets = (row?.markets || []).map((m) => ({
    marche: m.short || m.market,
    issue: m.favorite || null,
    betfair_pct: Number.isFinite(m.favorite_pct) ? round1(m.favorite_pct) : null,
    polymarket_pct: Number.isFinite(m.pm_favorite_pct) ? round1(m.pm_favorite_pct) : null,
    volume_betfair_eur: Number.isFinite(m.volume_bf) ? m.volume_bf : null,
    liquidite_polymarket_usd: Number.isFinite(m.liquidity_pm) ? m.liquidity_pm : null,
  }));
  const market = signal?.market || signal?.market_short || card.marche || '1x2';
  const side = signal?.side_label || card.issue || null;
  const historique = gapStore
    ? gapStore.series(signal?.fixture_key || card.fixture_key, market, side, { limit: 40 })
    : [];
  return {
    ok: true,
    ...card,
    toutes_issues: markets,
    historique_ecart: historique,
    source_historique: historique.length ? 'gap_snapshots' : 'aucune donnée',
  };
}

export function buildMatchs({ configurations, q = '' } = {}) {
  const needle = String(q || '').trim().toLocaleLowerCase('fr');
  const rows = (Array.isArray(configurations?.rows) ? configurations.rows : []).filter((r) => {
    if (!needle) return true;
    return [r.home, r.away, r.league].some((v) =>
      String(v || '').toLocaleLowerCase('fr').includes(needle)
    );
  });
  return {
    ok: true,
    total: rows.length,
    matchs: rows.map((r) => ({
      fixture_key: r.fixture_key,
      home: r.home ?? null,
      away: r.away ?? null,
      league: r.league ?? null,
      kickoff: r.date ?? null,
      has_betfair: (r.markets || []).some((m) => m.source_bf),
      has_polymarket: Boolean(r.pm_matched) || (r.markets || []).some((m) => m.source_pm),
    })),
  };
}

export function buildBilan({ calibrationReport, signals } = {}) {
  const summary = calibrationReport?.summary || {};
  const nBrier = summary.settled_matches ?? summary.settled ?? 0;
  const types = (Array.isArray(calibrationReport?.by_category) ? calibrationReport.by_category : [])
    .filter((c) => ['executable', 'movement', 'flow', 'contradiction'].includes(c.category))
    .map((c) => {
      const n = c.confirmation_n ?? c.decided ?? 0;
      const hasOdds = (c.roi_n ?? 0) > 0;
      const libelles = {
        executable: 'Écarts nets',
        movement: 'Mouvements Betfair depuis l’ouverture',
        flow: 'Flux & retards Betfair × Polymarket',
        contradiction: 'Contradictions',
      };
      return {
        type: c.category,
        libelle: libelles[c.category] || c.category,
        n,
        taux_confirmation_pct: c.confirmation_rate_pct ?? null,
        sample_warning: n < MIN_SAMPLE ? 'échantillon trop faible' : null,
        // Les types sans cote n'ont pas de rendement : valeur null, jamais 0.
        rendement_theorique_u: hasOdds ? c.roi_u ?? null : null,
        roi_n: hasOdds ? c.roi_n : 0,
      };
    });
  const roiN = summary.reco_roi_n ?? 0;
  const results = (Array.isArray(calibrationReport?.results) ? calibrationReport.results : []).slice(0, 20).map((o) => ({
    match: [o.home, o.away].filter(Boolean).join(' – ') || o.fixture_key || null,
    issue: o.market_short || o.market || null,
    score: o.score || o.final_score || null,
    resultat:
      o.signal_result === 'push' || o.reco_result === 'push'
        ? 'Remboursé'
        : o.signal_result === 'loss' || o.reco_result === 'loss'
        ? 'Infirmé'
        : o.signal_result === 'win' || o.reco_result === 'win'
        ? 'Confirmé'
        : null,
  }));
  return {
    ok: true,
    precision: {
      betfair_brier: summary.brier_bf ?? null,
      polymarket_brier: summary.brier_pm ?? null,
      n: nBrier,
      sample_warning: nBrier < MIN_SAMPLE ? 'échantillon trop faible' : null,
    },
    fiabilite: types,
    rendement_theorique: {
      unites: summary.reco_roi_u ?? null,
      roi_n: roiN,
      avertissement: 'Mise fixe 1 u, hors frais. Échantillon limité, aucune garantie de gain.',
      sample_warning: roiN < MIN_SAMPLE ? 'échantillon trop faible' : null,
    },
    derniers_resultats: results,
    niveaux: (signals?.counts || {}),
  };
}

function observationKey(o) {
  if (o?.fixture_key) return String(o.fixture_key);
  return [o?.home, o?.away, o?.date].filter(Boolean).join('|') || String(o?.id || '');
}

function favoriteProb(o) {
  const sides = Array.isArray(o?.sides) ? o.sides : [];
  const values = sides
    .filter((s) => Number.isFinite(s.bf_pct))
    .map((s) => s.bf_pct)
    .sort((a, b) => b - a);
  if (values.length) return values[0];
  return Number.isFinite(o?.bf_pct) ? o.bf_pct : null;
}

// Une observation = un marché. Le Laboratoire compte des MATCHS : on déduplique
// par fixture et on choisit le marché 1X2 comme référence du favori final.
function signatureStats(observations = [], thresholds = {}) {
  const byFixture = new Map();
  for (const o of observations) {
    const key = observationKey(o);
    const date = String(o?.date || o?.settled_at || o?.captured_at || '').slice(0, 10);
    let entry = byFixture.get(key);
    if (!entry) {
      entry = { primary: null, any: null, min: null, max: null, nObservations: 0, withSignature: false };
      byFixture.set(key, entry);
    }
    if (date) {
      if (!entry.min || date < entry.min) entry.min = date;
      if (!entry.max || date > entry.max) entry.max = date;
    }
    if (entry.withSignature || o?.signature_code) entry.withSignature = true;
    if (o?.status !== 'settled') continue;
    entry.nObservations += 1;
    const candidate = {
      won: o.bf_top_won === true,
      prob: favoriteProb(o),
      intensity: intensityFromObservation(o, thresholds),
    };
    if (o.market === MarketKey.OneXTwo || o.market === '1x2') entry.primary = candidate;
    else if (!entry.any) entry.any = candidate;
  }
  let n = 0;
  let k = 0;
  let probSum = 0;
  let probN = 0;
  let min = null;
  let max = null;
  let nObservations = 0;
  let matchsAvecSignature = 0;
  const intensityCounts = new Map();
  for (const entry of byFixture.values()) {
    nObservations += entry.nObservations;
    if (entry.withSignature) matchsAvecSignature += 1;
    if (entry.min) {
      if (!min || entry.min < min) min = entry.min;
      if (!max || entry.max > max) max = entry.max;
    }
    const chosen = entry.primary || entry.any;
    if (!chosen) continue;
    n += 1;
    if (chosen.won) k += 1;
    if (chosen.prob !== null) {
      probSum += chosen.prob;
      probN += 1;
    }
    if (chosen.intensity) {
      intensityCounts.set(chosen.intensity, (intensityCounts.get(chosen.intensity) || 0) + 1);
    }
  }
  const intensiteDominante =
    [...intensityCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return {
    n,
    k,
    probSum,
    probN,
    min,
    max,
    nObservations,
    matchsAvecSignature,
    totalMatchs: byFixture.size,
    intensiteDominante,
  };
}

function verdictFor(n, taux, probMarche, ic) {
  if (n < MIN_SAMPLE) return null;
  if (!Number.isFinite(taux) || !Number.isFinite(probMarche)) {
    return 'Échantillon suffisant, mais probabilité de marché indisponible : aucune conclusion.';
  }
  const [lo, hi] = ic || [null, null];
  if (Number.isFinite(lo) && Number.isFinite(hi)) {
    if (lo > probMarche) return 'Taux observé supérieur à la probabilité de marché sur cet échantillon ; à confirmer.';
    if (hi < probMarche) return 'Taux observé inférieur à la probabilité de marché sur cet échantillon ; à confirmer.';
  }
  return 'Aucun écart probant entre taux observé et probabilité de marché.';
}

export function buildLaboratoire({
  configurations,
  calibrationReport,
  intensity = 'all',
  minSample = MIN_SAMPLE,
  observations_tronquees = false,
} = {}) {
  const observations = (Array.isArray(calibrationReport?.observations) ? calibrationReport.observations : []);
  const bySig = new Map();
  for (const o of observations) {
    if (!o.signature_code) continue;
    const code = normalizeCode(o.signature_code);
    if (!bySig.has(code)) bySig.set(code, []);
    bySig.get(code).push(o);
  }
  const thresholds = configurations?.thresholds || {};
  const statsBySig = new Map([...bySig].map(([code, obs]) => [code, signatureStats(obs, thresholds)]));
  const allStats = signatureStats(observations, thresholds);

  // Union des signatures : live complètes, live partielles ET historique réglé.
  // Une signature historique partielle (ex. « 2 | Oui | ? | G4 ») reste observable.
  const live = new Map();
  const catalog = Array.isArray(configurations?.catalog_72) ? configurations.catalog_72 : [];
  for (const s of catalog) {
    if ((s.count || 0) === 0) continue;
    live.set(normalizeCode(s.code), {
      n_regles: s.count || 0,
      dominant_intensity: s.dominant_intensity || null,
      contradictions: s.contradictions || 0,
      convergences: s.convergences || 0,
      complet: true,
    });
  }
  for (const p of Array.isArray(configurations?.partial_signatures) ? configurations.partial_signatures : []) {
    const code = normalizeCode(p.code);
    if (live.has(code)) continue;
    live.set(code, {
      n_regles: p.count || 0,
      dominant_intensity: null,
      contradictions: p.contradictions || 0,
      convergences: 0,
      complet: false,
    });
  }
  for (const code of bySig.keys()) {
    if (!live.has(code)) {
      live.set(code, { n_regles: 0, dominant_intensity: null, contradictions: 0, convergences: 0, complet: false });
    }
  }

  const intensityFilter = ['all', 'equilibre', 'faible', 'moderee', 'forte', 'extreme'].includes(intensity)
    ? intensity
    : 'all';
  const signatures = [...live.entries()]
    .map(([code, info]) => {
      const cal = statsBySig.get(code) || signatureStats([], thresholds);
      const [icLower, icUpper] = wilsonInterval(cal.k, cal.n);
      const taux = cal.n > 0 ? round1((cal.k / cal.n) * 100) : null;
      const probMarche = cal.probN > 0 ? round1(cal.probSum / cal.probN) : null;
      return {
        code,
        n_matchs: cal.n,
        n_observations: cal.nObservations,
        n_regles: info.n_regles,
        k_favori_gagnant: cal.k,
        taux_confirmation_pct: taux,
        ic95_pct: [icLower, icUpper],
        probabilite_marche_pct: probMarche,
        intensite_dominante: info.dominant_intensity || INTENSITY_LABELS[cal.intensiteDominante] || null,
        contradictions: info.contradictions,
        convergences: info.convergences,
        periode: cal.min ? { min_date: cal.min, max_date: cal.max } : configurations?.period || null,
        complet: !code.split('|').some((part) => part.trim() === '?'),
        sample_warning: cal.n < minSample ? 'échantillon trop faible' : null,
        verdict: verdictFor(cal.n, taux, probMarche, [icLower, icUpper]),
      };
    })
    .filter((s) => s.n_matchs > 0 || s.n_regles > 0)
    .filter((s) => intensityFilter === 'all' || normalizeIntensity(s.intensite_dominante).includes(intensityFilter))
    .sort((a, b) => b.n_matchs - a.n_matchs || b.n_regles - a.n_regles || a.code.localeCompare(b.code));

  const quality = configurations?.quality_report || {};
  const catalogue = catalog.map((s) => ({
    code: normalizeCode(s.code),
    complet: !String(s.code).split('|').some((part) => part.trim() === '?'),
    count: s.count || 0,
    intensite_dominante: s.dominant_intensity || null,
  }));
  return {
    ok: true,
    bandeau: 'Outil d’étude, pas de pronostics.',
    periode: configurations?.period || null,
    couverture: configurations?.summary?.block_coverage || {},
    total_fixtures: configurations?.summary?.total_fixtures ?? allStats.totalMatchs,
    seuils_intensite: configurations?.thresholds || {},
    intense_filtre: intensityFilter,
    signatures_observees: signatures.length,
    signatures_possibles: 72,
    matchs_incomplets: configurations?.summary?.partial_signatures ?? 0,
    matchs_regles_avec_signature: allStats.matchsAvecSignature,
    matchs_regles_sans_signature: Math.max(0, allStats.totalMatchs - allStats.matchsAvecSignature),
    matchs_incoherents: quality.donnees_incoherentes ?? 0,
    observations_tronquees,
    catalogue,
    signatures,
  };
}

const FT_LABELS = { 1: 'Victoire domicile', X: 'Match nul', 2: 'Victoire extérieur', '?': 'Inconnu' };
const BTTS_LABELS = { Oui: 'Les deux équipes marquent', Non: 'Au moins une équipe ne marque pas', '?': 'Inconnu' };
const GOALS_LABELS = {
  G1: 'Très faible (Under 1.5 / 2.5 / 3.5)',
  G2: 'Modéré faible (Over 1.5 / Under 2.5 / 3.5)',
  G3: 'Ouvert actif (Over 1.5 / 2.5 / Under 3.5)',
  G4: 'Très offensif (Over 1.5 / 2.5 / 3.5)',
  '?': 'Inconnu',
};

// Issue réelle d'une observation, déduite du score (jamais inventée).
function issueReelle(marketKey, obs) {
  const hs = obs?.home_score;
  const as = obs?.away_score;
  if (!Number.isFinite(hs) || !Number.isFinite(as)) return null;
  if (marketKey === MarketKey.OneXTwo) return hs > as ? '1' : hs < as ? '2' : 'N';
  if (marketKey === MarketKey.Btts) return hs > 0 && as > 0 ? 'Oui' : 'Non';
  if (marketKey === MarketKey.HalfTime) {
    const hht = obs?.home_ht;
    const aht = obs?.away_ht;
    if (!Number.isFinite(hht) || !Number.isFinite(aht)) return null;
    return hht > aht ? '1' : hht < aht ? '2' : 'N';
  }
  if (marketKey === MarketKey.DrawNoBet) return hs === as ? 'Remboursé' : hs > as ? '1' : '2';
  const line = {
    [MarketKey.OverUnder15]: 1.5,
    [MarketKey.OverUnder25]: 2.5,
    [MarketKey.OverUnder35]: 3.5,
  }[marketKey];
  if (line !== undefined) return hs + as > line ? 'Over' : 'Under';
  return null;
}

function favoriteObservation(obs) {
  const sides = Array.isArray(obs?.sides) ? obs.sides : [];
  const ranked = sides.filter((s) => Number.isFinite(s.bf_pct)).sort((a, b) => b.bf_pct - a.bf_pct);
  return ranked[0]?.label ?? null;
}

function libelleIssue(marketKey, issue) {
  if (issue === '1') return marketKey === MarketKey.HalfTime ? 'Domicile (MT)' : 'Domicile';
  if (issue === '2') return marketKey === MarketKey.HalfTime ? 'Extérieur (MT)' : 'Extérieur';
  if (issue === 'X' || issue === 'N') return 'Nul';
  if (issue === 'Oui' || issue === 'Non') return issue === 'Oui' ? 'BTTS Oui' : 'BTTS Non';
  if (issue === 'Under' || issue === 'Over') {
    const line = {
      [MarketKey.OverUnder15]: '1,5',
      [MarketKey.OverUnder25]: '2,5',
      [MarketKey.OverUnder35]: '3,5',
    }[marketKey];
    return issue === 'Under' ? `Moins de ${line || ''} buts` : `Plus de ${line || ''} buts`;
  }
  return issue;
}

function performanceParMarche(observations) {
  const byMarket = new Map();
  for (const o of observations) {
    const key = o.market || '?';
    let bucket = byMarket.get(key);
    if (!bucket) {
      bucket = { n: 0, k: 0, probs: [], issues: new Map() };
      byMarket.set(key, bucket);
    }
    bucket.n += 1;
    if (o.bf_top_won === true) bucket.k += 1;
    const fav = favoriteObservation(o);
    const probs = (o.sides || []).filter((s) => Number.isFinite(s.bf_pct)).map((s) => s.bf_pct);
    const p = probs.length ? Math.max(...probs) : null;
    if (Number.isFinite(p)) bucket.probs.push(p);
    const outcome = issueReelle(key, o);
    for (const label of new Set([fav, outcome].filter(Boolean))) {
      if (!bucket.issues.has(label)) {
        bucket.issues.set(label, { issue: label, n_observations: 0, n_favori: 0, k_favori_gagnant: 0 });
      }
      const row = bucket.issues.get(label);
      if (outcome === label) row.n_observations += 1;
      if (fav === label) {
        row.n_favori += 1;
        if (outcome === label) row.k_favori_gagnant += 1;
      }
    }
  }
  return [...byMarket.entries()]
    .map(([key, b]) => {
      const [lo, hi] = wilsonInterval(b.k, b.n);
      return {
        marche: key,
        libelle: marketDef(key)?.label || key,
        n: b.n,
        k_favori_gagnant: b.k,
        taux_confirmation_pct: b.n > 0 ? round1((b.k / b.n) * 100) : null,
        ic95_pct: [lo, hi],
        probabilite_marche_pct: b.probs.length ? round1(b.probs.reduce((a, c) => a + c, 0) / b.probs.length) : null,
        sample_warning: b.n < MIN_SAMPLE ? 'échantillon trop faible' : null,
        issues: [...b.issues.values()]
          .map((i) => ({
            issue: i.issue,
            libelle: libelleIssue(key, i.issue),
            n_observations: i.n_observations,
            n_favori: i.n_favori,
            k_favori_gagnant: i.k_favori_gagnant,
            taux_favori_pct: i.n_favori > 0 ? round1((i.k_favori_gagnant / i.n_favori) * 100) : null,
          }))
          .sort((a, b2) => b2.n_observations - a.n_observations || a.issue.localeCompare(b2.issue)),
      };
    })
    .sort((a, b) => b.n - a.n || a.marche.localeCompare(b.marche));
}

// Fiche complète d'une configuration (Phase 4 — exploration du Laboratoire).
export function buildConfigurationDetail({ code, configurations, calibrationReport, minSample = MIN_SAMPLE } = {}) {
  const target = normalizeCode(code);
  if (!target || target === '| | |') return null;
  const catalog = Array.isArray(configurations?.catalog_72) ? configurations.catalog_72 : [];
  const partial = Array.isArray(configurations?.partial_signatures) ? configurations.partial_signatures : [];
  const live =
    catalog.find((s) => normalizeCode(s.code) === target) ||
    partial.find((s) => normalizeCode(s.code) === target) ||
    null;
  const observations = (Array.isArray(calibrationReport?.observations) ? calibrationReport.observations : []).filter(
    (o) => normalizeCode(o.signature_code) === target
  );
  if (!live && observations.length === 0) return null;

  const settled = observations.filter((o) => o.status === 'settled');
  const stats = signatureStats(observations);
  const k = stats.k;
  const n = stats.n;
  const [icLower, icUpper] = wilsonInterval(k, n);
  const probMarche = stats.probN > 0 ? round1(stats.probSum / stats.probN) : null;
  const taux = n > 0 ? round1((k / n) * 100) : null;
  const dates = settled
    .map((o) => String(o.date || o.settled_at || o.captured_at || '').slice(0, 10))
    .filter(Boolean)
    .sort();
  const parties = target.split('|').map((p) => p.trim());
  const complet = parties.length === 4 && parties.every((p) => p && p !== '?');

  const matchsLive = (Array.isArray(configurations?.rows) ? configurations.rows : [])
    .filter((r) => normalizeCode(r.signature?.code) === target)
    .map((r) => ({
      fixture_key: r.fixture_key || null,
      home: r.home ?? null,
      away: r.away ?? null,
      league: r.league ?? null,
      kickoff: r.date ?? null,
      source: 'live',
      statut: r.kickoff_passed ? 'coup d’envoi passé' : 'avant coup d’envoi',
      has_betfair: (r.markets || []).some((m) => m.source_bf),
      has_polymarket: Boolean(r.pm_matched) || (r.markets || []).some((m) => m.source_pm),
    }));
  const byMatch = new Map();
  const addMatch = (m) => {
    const key = m.fixture_key || [m.home, m.away, m.kickoff].filter(Boolean).join('|') || String(byMatch.size);
    if (!byMatch.has(key)) byMatch.set(key, { ...m, fixture_key: key });
  };
  for (const m of matchsLive) addMatch(m);
  for (const o of observations) {
    const sides = Array.isArray(o.sides) ? o.sides : [];
    addMatch({
      fixture_key: o.fixture_key || null,
      home: o.home ?? null,
      away: o.away ?? null,
      league: o.league ?? null,
      kickoff: o.date ?? null,
      source: 'historique',
      statut:
        o.status === 'settled'
          ? o.bf_top_won === true
            ? 'Confirmé'
            : o.bf_top_won === false
            ? 'Infirmé'
            : 'Remboursé ou non évalué'
          : o.status === 'push'
          ? 'Remboursé'
          : 'En attente',
      has_betfair: Number(o.bf_volume) > 0 || sides.some((s) => Number.isFinite(s.bf_pct)),
      has_polymarket:
        (Number.isFinite(o.pm_liquidity) && o.pm_liquidity > 0) || sides.some((s) => Number.isFinite(s.pm_pct)),
    });
  }
  const matchs = [...byMatch.values()]
    .sort((a, b) => String(b.kickoff || '').localeCompare(String(a.kickoff || '')))
    .slice(0, 40);

  const explication =
    `Configuration ${target} : le favori du résultat final est ${FT_LABELS[parties[0]] || parties[0] || 'inconnu'}, ` +
    `BTTS est ${BTTS_LABELS[parties[1]] || parties[1] || 'inconnu'}, ` +
    `le favori de la mi-temps est ${FT_LABELS[parties[2]] || parties[2] || 'inconnu'} ` +
    `et le profil de buts est ${parties[3] || 'inconnu'}${GOALS_LABELS[parties[3]] ? ` (${GOALS_LABELS[parties[3]]})` : ''}. ` +
    (complet
      ? 'Les quatre blocs sont renseignés : cette configuration appartient au catalogue des 72 signatures.'
      : 'Signature incomplète : les blocs manquants restent marqués « ? », aucune valeur n’est inventée.');

  const parametres = [
    { axe: 'Résultat final (1X2)', valeur: parties[0] ?? '?', definition: 'Favori du marché 1X2.' },
    { axe: 'BTTS', valeur: parties[1] ?? '?', definition: 'Les deux équipes marquent : Oui ou Non.' },
    { axe: 'Mi-temps', valeur: parties[2] ?? '?', definition: 'Favori du marché Résultat mi-temps.' },
    { axe: 'Profil de buts', valeur: parties[3] ?? '?', definition: GOALS_LABELS[parties[3]] || 'Profil non connu.' },
  ];

  return {
    ok: true,
    code: target,
    complet,
    configuration: {
      code: target,
      parties,
      ft: parties[0] ?? null,
      btts: parties[1] ?? null,
      ht: parties[2] ?? null,
      goals_profile: parties[3] ?? null,
      periode: dates.length ? { min_date: dates[0], max_date: dates[dates.length - 1] } : configurations?.period || null,
    },
    explication,
    parametres,
    seuils_intensite: configurations?.thresholds || {},
    kpi: {
      n_matchs_regles: n,
      n_observations: stats.nObservations,
      n_regles_live: live?.count || 0,
      k_favori_gagnant: k,
      taux_confirmation_pct: taux,
      ic95_pct: [icLower, icUpper],
      probabilite_marche_pct: probMarche,
      contradictions: live?.contradictions || 0,
      convergences: live?.convergences || 0,
      sample_warning: n < minSample ? 'échantillon trop faible' : null,
    },
    matchs,
    marches: performanceParMarche(settled),
    verdict: verdictFor(n, taux, probMarche, [icLower, icUpper]),
  };
}

function newestCacheAge(cache) {
  let newest = null;
  if (cache && typeof cache.values === 'function') {
    for (const entry of cache.values()) {
      const at = entry?.at ?? entry?.fetchedAtMs ?? null;
      if (!Number.isFinite(at)) continue;
      const age = Math.max(0, Math.floor((Date.now() - at) / 1000));
      if (newest === null || age < newest) newest = age;
    }
  }
  return newest;
}

// Repli après redémarrage : le cache HTTP est en mémoire, mais la dernière
// collecte réussie est conservée dans store-meta.json (Cloudflare KV).
function heartbeatAge(calibration, name) {
  const beats = calibration?.getSourceHeartbeats?.() || {};
  const at = beats?.[name];
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((Date.now() - at) / 1000));
}

export function buildSourcesStatus({ cfg, scraper, polymarket, espn, sportscore, calibration, gapStore } = {}) {
  const staleSecs = Number.isFinite(cfg?.sourceStaleSecs) ? cfg.sourceStaleSecs : 600;
  const mk = (nom, age, detail = null) => ({
    nom,
    age_s: age,
    etat: age === null ? 'panne' : age > staleSecs ? 'retard' : 'ok',
    detail,
  });
  const bfAges = [];
  for (const key of ['1x2', 'over-under-2-5', 'btts', 'half-time']) {
    const c = typeof scraper?.cached === 'function' ? scraper.cached(key) : null;
    if (c && Number.isFinite(c.ageSeconds)) bfAges.push(c.ageSeconds);
  }
  const bfAge = bfAges.length ? Math.min(...bfAges) : heartbeatAge(calibration, 'betfair');
  const pmAge = newestCacheAge(polymarket?.cache) ?? heartbeatAge(calibration, 'polymarket');
  const espnAge = newestCacheAge(espn?.cache) ?? heartbeatAge(calibration, 'espn');
  const ssAge = newestCacheAge(sportscore?.cache) ?? heartbeatAge(calibration, 'sportscore');
  const sources = [
    mk('betfair', bfAge, bfAge === null ? 'aucune donnée en cache' : null),
    mk('polymarket', pmAge, cfg?.polymarketEnabled === false ? 'source désactivée' : null),
    mk('espn', espnAge, cfg?.espnEnabled === false ? 'source désactivée' : null),
    mk('sportscore', ssAge, cfg?.sportscoreDisabled ? 'source désactivée' : null),
  ];
  return {
    ok: true,
    sources,
    seuil_retard_s: staleSecs,
    persistance: calibration?.getPersistenceStatus?.() || { etat: 'indisponible', erreur_persistance: null },
    stockage: {
      backend: cfg?.storageBackend || 'local',
      mode_cron: cfg?.syncMode || 'internal',
      cloudflare_kv: cfg?.storageBackend === 'cloudflare'
        ? {
            actif: Boolean(cfg?.cloudflareAccountId && cfg?.cloudflareKvNamespaceId && cfg?.cloudflareApiToken),
          }
        : null,
    },
    snapshots: gapStore?.status?.() || null,
  };
}

// Écrit un instantané réel à chaque synchronisation (jamais de courbe simulée).
export function recordGapSnapshots(sources, rows) {
  const store = sources?.gapStore;
  if (!store) return 0;
  const list = Array.isArray(rows) ? rows : [];
  const comparedList = list.map((row) => ({ fixture_key: row?.fixture_key, markets: row?.markets || [] }));
  const count =
    typeof store.recordBatch === 'function'
      ? store.recordBatch(comparedList)
      : comparedList.reduce((n, compared) => n + store.recordCompared(compared), 0);
  store.purge();
  return count;
}
