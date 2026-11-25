// Surface /api/v2 : constructions de réponses contractuelles, sans clé interne ni score inventé.
// Toutes les valeurs absentes restent null ; aucun chiffre n'est affiché sans son effectif.

const MIN_SAMPLE = 30;
const round1 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

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

function freshness(row) {
  const markets = Array.isArray(row?.markets) ? row.markets : [];
  const bf = markets.filter((m) => m?.source_bf && Number.isFinite(m.age_seconds)).map((m) => m.age_seconds);
  const pm = markets.filter((m) => m?.source_pm && Number.isFinite(m.age_seconds)).map((m) => m.age_seconds);
  return {
    betfair_age_s: bf.length ? Math.min(...bf) : null,
    polymarket_age_s: pm.length ? Math.min(...pm) : null,
  };
}

function cardFromSignal(s, row, showPmLinks = true) {
  const reco = s?.recommendation || {};
  const spread = Number.isFinite(reco.pm_spread_pts) ? reco.pm_spread_pts : null;
  const net = Number.isFinite(s.net_edge_pp) ? s.net_edge_pp : null;
  const ecart = net !== null && spread !== null ? round1(net + spread) : null;
  const type = s.category === 'movement' ? 'mv' : s.category === 'contradiction' ? 'ct' : 'net';
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
    fraicheur: freshness(row),
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
  return card;
}

function indexRows(configurations) {
  return new Map(
    (Array.isArray(configurations?.rows) ? configurations.rows : []).map((r) => [r.fixture_key, r])
  );
}

export function buildEcarts({ signals, configurations, type = 'all', showPmLinks = true } = {}) {
  const byKey = indexRows(configurations);
  const all = Array.isArray(signals?.all_signals) ? signals.all_signals : [];
  const wanted = ['all', 'net', 'mv', 'ct'].includes(type) ? type : 'all';
  const cards = all
    .map((s) => cardFromSignal(s, byKey.get(s.fixture_key), showPmLinks))
    .filter((c) => wanted === 'all' || c.type === wanted);
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

export function buildEcartDetail({ id, signals, configurations, gapStore, showPmLinks = true } = {}) {
  const byKey = indexRows(configurations);
  const all = Array.isArray(signals?.all_signals) ? signals.all_signals : [];
  const s = all.find((item) => item.id === id) || null;
  if (!s) return null;
  const row = byKey.get(s.fixture_key) || null;
  const card = cardFromSignal(s, row, showPmLinks);
  const markets = (row?.markets || []).map((m) => ({
    marche: m.short || m.market,
    issue: m.favorite || null,
    betfair_pct: Number.isFinite(m.favorite_pct) ? round1(m.favorite_pct) : null,
    polymarket_pct: Number.isFinite(m.pm_favorite_pct) ? round1(m.pm_favorite_pct) : null,
    volume_betfair_eur: Number.isFinite(m.volume_bf) ? m.volume_bf : null,
    liquidite_polymarket_usd: Number.isFinite(m.liquidity_pm) ? m.liquidity_pm : null,
  }));
  const market = s.market || s.market_short || '1x2';
  const side = s.side_label || null;
  const historique = gapStore
    ? gapStore.series(s.fixture_key, market, side, { limit: 40 })
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

export function buildLaboratoire({ configurations, calibrationReport, intensity = 'all' } = {}) {
  const observations = (Array.isArray(calibrationReport?.observations) ? calibrationReport.observations : []);
  const bySig = new Map();
  for (const o of observations) {
    if (!o.signature_code) continue;
    let bucket = bySig.get(o.signature_code);
    if (!bucket) {
      bucket = { n: 0, k: 0, probSum: 0, probN: 0 };
      bySig.set(o.signature_code, bucket);
    }
    if (o.status === 'settled') {
      bucket.n += 1;
      if (o.bf_top_won === true) bucket.k += 1;
    }
    const p = Number.isFinite(o.bf_pct) ? o.bf_pct : Number.isFinite(o.bf_top_pct) ? o.bf_top_pct : null;
    if (p !== null) {
      bucket.probSum += p;
      bucket.probN += 1;
    }
  }

  const catalog = Array.isArray(configurations?.catalog_72) ? configurations.catalog_72 : [];
  const intensityFilter = ['all', 'equilibre', 'faible', 'moderee', 'forte', 'extreme'].includes(intensity)
    ? intensity
    : 'all';
  const signatures = catalog
    .filter((s) => (s.count || 0) > 0)
    .filter((s) => intensityFilter === 'all' || String(s.dominant_intensity || '').toLocaleLowerCase('fr').includes(intensityFilter))
    .map((s) => {
      const cal = bySig.get(s.code) || { n: 0, k: 0, probSum: 0, probN: 0 };
      const [icLower, icUpper] = wilsonInterval(cal.k, cal.n);
      return {
        code: s.code,
        n_matchs: cal.n,
        n_regles: s.count ?? 0,
        k_favori_gagnant: cal.k ?? 0,
        taux_confirmation_pct: cal.n > 0 ? round1((cal.k / cal.n) * 100) : null,
        ic95_pct: [icLower, icUpper],
        probabilite_marche_pct: cal.probN > 0 ? round1(cal.probSum / cal.probN) : null,
        intensite_dominante: s.dominant_intensity ?? null,
        contradictions: s.contradictions ?? 0,
        periode: configurations?.period || null,
        sample_warning: cal.n < MIN_SAMPLE ? 'échantillon trop faible' : null,
        verdict: cal.n < MIN_SAMPLE ? null : 'À étudier : la règle reste à valider sur plus de matchs.',
      };
    })
    .sort((a, b) => b.n_matchs - a.n_matchs || a.code.localeCompare(b.code));

  const quality = configurations?.quality_report || {};
  return {
    ok: true,
    bandeau: 'Outil d’étude, pas de pronostics.',
    periode: configurations?.period || null,
    couverture: configurations?.summary?.block_coverage || {},
    seuils_intensite: configurations?.thresholds || {},
    intense_filtre: intensityFilter,
    signatures_observees: signatures.filter((s) => s.n_regles > 0).length,
    signatures_possibles: 72,
    matchs_incomplets: configurations?.summary?.partial_signatures ?? 0,
    matchs_incoherents: quality.donnees_incoherentes ?? 0,
    signatures,
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
  const sources = [
    mk('betfair', bfAges.length ? Math.min(...bfAges) : null, bfAges.length ? null : 'aucune donnée en cache'),
    mk('polymarket', newestCacheAge(polymarket?.cache), cfg?.polymarketEnabled === false ? 'source désactivée' : null),
    mk('espn', newestCacheAge(espn?.cache), cfg?.espnEnabled === false ? 'source désactivée' : null),
    mk('sportscore', newestCacheAge(sportscore?.cache), cfg?.sportscoreDisabled ? 'source désactivée' : null),
  ];
  return {
    ok: true,
    sources,
    seuil_retard_s: staleSecs,
    persistance: calibration?.getPersistenceStatus?.() || { etat: 'indisponible', erreur_persistance: null },
    snapshots: gapStore?.status?.() || null,
  };
}

// Écrit un instantané réel à chaque synchronisation (jamais de courbe simulée).
export function recordGapSnapshots(sources, rows) {
  const store = sources?.gapStore;
  if (!store) return 0;
  let count = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const compared = { fixture_key: row?.fixture_key, markets: row?.markets || [] };
    count += store.recordCompared(compared);
  }
  store.purge();
  return count;
}
