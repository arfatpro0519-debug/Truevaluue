// Vues principales (Accueil, Signaux, Résultats détaillés, Configurations 72), filtres et tris.

import { state } from './state.js';
import {
  edgeClass,
  esc,
  fmtEur,
  fmtGap,
  fmtMetric4,
  fmtNetEdge,
  fmtOdds,
  fmtPct,
  fmtSignedPct,
  fmtUsd,
  formatKickoffCompact,
  kickoffTs,
} from './utils.js';
import {
  buildMergedMatches,
  renderCmpMarketsHtml,
  resultToneMeta,
  signalHistoryToneMeta,
} from './modals.js';

/* ---- Helpers partagés ---- */
export function signalConfidenceScore(sig) {
  if (sig.category === 'executable') {
    if (typeof sig.recommendation?.confidence_score === 'number') {
      return sig.recommendation.confidence_score;
    }
    if (sig.tier === 'high') return 92;
    if (sig.tier === 'moderate') return 76;
    return 52;
  }
  if (sig.category === 'movement') {
    return Math.min(
      92,
      Math.max(45, Math.round(48 + Math.abs(sig.prob_delta_pp || 0) * 4 + (sig.amplitude_pct || 0) * 0.6))
    );
  }
  if (sig.category === 'contradiction') {
    return Math.min(90, 55 + (sig.contradictions_count || 1) * 15);
  }
  return 52;
}

function renderSearchBarHtml(inputId, placeholder, value, ariaLabel, scope) {
  const hasVal = Boolean(value && String(value).length > 0);
  return `<div class="srch">
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    <input id="${inputId}" type="search" placeholder="${esc(placeholder)}" value="${esc(value)}" aria-label="${esc(ariaLabel)}" />
    <button type="button" class="srch-clear" data-clear-search="${scope}" aria-label="Effacer la recherche"${hasVal ? '' : ' hidden'}>×</button>
  </div>`;
}

function renderEmptyWithResetHtml(message, scope) {
  return `<div class="empty">
    <div>${esc(message)}</div>
    <button type="button" class="tg-btn-sm alt tv-empty-reset" data-reset-scope="${scope}">Réinitialiser recherche et filtres</button>
  </div>`;
}

function signalToneInfo(s) {
  if (s.category === 'contradiction') {
    return { tone: 'bad', ringCls: ' bad', ringSub: 'splits', tag: 'Contradiction' };
  }
  if (s.category === 'movement') {
    const isRev = s.signal_type === 'retournement' || /retournement/i.test(s.category_label || s.title || '');
    return {
      tone: 'warn',
      ringCls: ' warn',
      ringSub: 'impact',
      tag: isRev ? 'Retournement 24h' : 'Mouvement 24h',
    };
  }
  if (s.category === 'flow') {
    return { tone: 'obs', ringCls: ' obs', ringSub: 'flux', tag: 'Flux BF×PM' };
  }
  const edge = typeof s.net_edge_pp === 'number' ? s.net_edge_pp : 0;
  const rank = s.proposal_rank || s.recommendation?.proposal_rank || 1;
  const tierTxt = s.tier_label ? ` · ${s.tier_label}` : '';
  if (edge >= 0) {
    return {
      tone: 'ok',
      ringCls: '',
      ringSub: 'conf.',
      tag: `${rank > 1 ? `${rank}e prop.` : 'Opportunité'}${tierTxt}`,
    };
  }
  return {
    tone: 'info',
    ringCls: ' info',
    ringSub: 'conf.',
    tag: `${rank > 1 ? `${rank}e prop.` : 'Seuil 0'}${tierTxt}`,
  };
}

function signalMoveMagnitude(s) {
  if (typeof s.prob_delta_pp === 'number') return Math.abs(s.prob_delta_pp);
  if (typeof s.amplitude_pct === 'number') return s.amplitude_pct;
  return -1;
}

function sortSignalsList(list, sortKey = state.sigSort, sortDir = state.sigSortDir) {
  const dir = sortDir === 'asc' ? 1 : -1;
  return list.slice().sort((a, b) => {
    if (sortKey === 'edge') {
      const ae = typeof a.net_edge_pp === 'number' ? a.net_edge_pp : null;
      const be = typeof b.net_edge_pp === 'number' ? b.net_edge_pp : null;
      if (ae === null && be !== null) return 1;
      if (ae !== null && be === null) return -1;
      if (ae !== null && be !== null && ae !== be) return (ae - be) * dir;
    } else if (sortKey === 'conf') {
      const ac = signalConfidenceScore(a);
      const bc = signalConfidenceScore(b);
      if (ac !== bc) return (ac - bc) * dir;
    } else if (sortKey === 'vol') {
      const av = a.total_volume_bf || 0;
      const bv = b.total_volume_bf || 0;
      if (av !== bv) return (av - bv) * dir;
    } else if (sortKey === 'move') {
      const am = signalMoveMagnitude(a);
      const bm = signalMoveMagnitude(b);
      if (am === -1 && bm !== -1) return 1;
      if (am !== -1 && bm === -1) return -1;
      if (am !== bm) return (am - bm) * dir;
    } else if (sortKey === 'time') {
      const at = kickoffTs(a.date || a.date_label);
      const bt = kickoffTs(b.date || b.date_label);
      if (at !== bt) return (at - bt) * dir;
    } else {
      const as = a.score_sort || 0;
      const bs = b.score_sort || 0;
      if (as !== bs) return (as - bs) * dir;
    }
    return (b.score_sort || 0) - (a.score_sort || 0) || (b.total_volume_bf || 0) - (a.total_volume_bf || 0);
  });
}

export function getVisibleSignalsList(sigData) {
  const raw = Array.isArray(sigData?.all_signals) ? sigData.all_signals : [];
  return state.showProposals ? raw : raw.filter((s) => s.category !== 'executable');
}

export function getFilteredSortedSignals(sigData) {
  const baseList = getVisibleSignalsList(sigData);
  const activeCat = !state.showProposals && state.sigCat === 'executable' ? 'all' : state.sigCat;
  const q = state.sigQuery.trim().toLowerCase();
  const filtered =
    activeCat === 'compare'
      ? []
      : baseList.filter((s) => {
          if (activeCat !== 'all' && s.category !== activeCat) return false;
          if (
            q &&
            !`${s.home} ${s.away} ${s.league} ${s.title} ${s.detail} ${s.recommendation?.action || ''}`
              .toLowerCase()
              .includes(q)
          ) {
            return false;
          }
          return true;
        });
  return sortSignalsList(filtered, state.sigSort, state.sigSortDir);
}

export function getFilteredSortedSignalResults(sigResData) {
  const all = Array.isArray(sigResData?.results) ? sigResData.results : [];
  const q = state.sigQuery.trim().toLowerCase();
  const filtered = all.filter((r) => {
    if (state.sigResFilter === 'settled' && r.status !== 'settled' && r.status !== 'push') return false;
    if (state.sigResFilter === 'won' && r.match_outcome !== 'win') return false;
    if (state.sigResFilter === 'lost' && r.match_outcome !== 'loss') return false;
    if (state.sigResFilter === 'pending' && (r.status !== 'pending' || r.is_no_score)) return false;
    if (state.sigResFilter === 'no_score' && !r.is_no_score) return false;
    if (state.sigResFilter === 'reco' && !(r.signals || []).some((s) => s.category === 'executable')) {
      return false;
    }
    if (q) {
      const sigTxt = (r.signals || []).map((s) => `${s.title || ''} ${s.action || ''} ${s.market_short || ''}`).join(' ');
      if (!`${r.home} ${r.away} ${r.league} ${sigTxt}`.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const dir = state.sigSortDir === 'asc' ? 1 : -1;
  const sk = state.sigSort;
  return filtered.slice().sort((a, b) => {
    if (sk === 'vol') {
      const av = a.total_volume_bf || 0;
      const bv = b.total_volume_bf || 0;
      if (av !== bv) return (av - bv) * dir;
    } else if (sk === 'edge') {
      const ae = Math.max(...(a.signals || []).map((s) => (typeof s.net_edge_pp === 'number' ? s.net_edge_pp : -999)), -999);
      const be = Math.max(...(b.signals || []).map((s) => (typeof s.net_edge_pp === 'number' ? s.net_edge_pp : -999)), -999);
      if (ae !== be) return (ae - be) * dir;
    } else if (sk === 'time') {
      const at = kickoffTs(a.date || a.settled_at || a.captured_at);
      const bt = kickoffTs(b.date || b.settled_at || b.captured_at);
      if (at !== bt) return (at - bt) * dir;
    } else {
      const statusRank = (r) => (r.status === 'settled' ? 3 : r.status === 'push' ? 2 : r.is_no_score ? 0 : 1);
      const sa = statusRank(a);
      const sb = statusRank(b);
      if (sa !== sb) return (sa - sb) * dir;
      const ta = kickoffTs(a.settled_at || a.date || a.captured_at);
      const tb = kickoffTs(b.settled_at || b.date || b.captured_at);
      if (ta !== tb) return (ta - tb) * dir;
    }
    return kickoffTs(b.date || b.captured_at) - kickoffTs(a.date || a.captured_at);
  });
}

export function getFilteredSortedCategoryResults(sigResData) {
  const all = Array.isArray(sigResData?.results) ? sigResData.results : [];
  const q = state.resQuery.trim().toLowerCase();
  const filtered = all.filter((r) => {
    if (state.resFilter === 'settled' && r.status !== 'settled' && r.status !== 'push') return false;
    if (state.resFilter === 'won' && r.match_outcome !== 'win') return false;
    if (state.resFilter === 'lost' && r.match_outcome !== 'loss') return false;
    if (state.resFilter === 'pending' && (r.status !== 'pending' || r.is_no_score)) return false;
    if (state.resFilter === 'no_score' && !r.is_no_score) return false;
    if (state.resFilter === 'push' && r.status !== 'push') return false;
    if (q) {
      const sigTxt = (r.signals || []).map((s) => `${s.title || ''} ${s.action || ''} ${s.market_short || ''}`).join(' ');
      if (!`${r.home} ${r.away} ${r.league} ${sigTxt}`.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const dir = state.resSortDir === 'asc' ? 1 : -1;
  return filtered.slice().sort((a, b) => {
    if (state.resSort === 'best' || state.resSort === 'outcome') {
      const rank = (r) => {
        if (r.match_outcome === 'win') return 6;
        if (r.match_outcome === 'mixed') return 5;
        if (r.status === 'settled' && r.match_outcome !== 'loss') return 4;
        if (r.status === 'push') return 3;
        if (r.status === 'pending' && !r.is_no_score) return 2;
        if (r.is_no_score) return 1;
        return 0;
      };
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return (ra - rb) * dir;
      const pa = typeof a.reco_pnl_u === 'number' ? a.reco_pnl_u : -999;
      const pb = typeof b.reco_pnl_u === 'number' ? b.reco_pnl_u : -999;
      if (pa !== pb) return (pa - pb) * dir;
    } else if (state.resSort === 'roi') {
      const pa = typeof a.reco_pnl_u === 'number' ? a.reco_pnl_u : -999;
      const pb = typeof b.reco_pnl_u === 'number' ? b.reco_pnl_u : -999;
      if (pa !== pb) return (pa - pb) * dir;
    } else if (state.resSort === 'brier') {
      const ba = typeof a.brier_bf === 'number' ? a.brier_bf : null;
      const bb = typeof b.brier_bf === 'number' ? b.brier_bf : null;
      if (ba === null && bb !== null) return 1;
      if (ba !== null && bb === null) return -1;
      if (ba !== null && bb !== null && ba !== bb) return (ba - bb) * dir;
    } else if (state.resSort === 'vol') {
      const va = a.total_volume_bf || 0;
      const vb = b.total_volume_bf || 0;
      if (va !== vb) return (va - vb) * dir;
    } else {
      const ta = kickoffTs(a.settled_at || a.date || a.captured_at);
      const tb = kickoffTs(b.settled_at || b.date || b.captured_at);
      if (ta !== tb) return (ta - tb) * dir;
    }
    return kickoffTs(b.date || b.captured_at) - kickoffTs(a.date || a.captured_at);
  });
}

export function getFilteredSortedResults(calData) {
  const all = Array.isArray(calData?.observations) ? calData.observations : [];
  const q = state.resQuery.trim().toLowerCase();
  const filtered = all.filter((o) => {
    if (state.resFilter === 'signals' && !o.in_signals) return false;
    if (state.resFilter === 'settled' && o.status !== 'settled' && o.status !== 'push') return false;
    if (state.resFilter === 'won' && o.reco_result !== 'win' && !(o.recommendation == null && o.bf_top_won === true)) {
      return false;
    }
    if (state.resFilter === 'lost' && o.reco_result !== 'loss' && !(o.recommendation == null && o.bf_top_won === false)) {
      return false;
    }
    if (state.resFilter === 'reco' && !o.recommendation) return false;
    if (state.resFilter === 'div' && (o.max_abs_gap_pp || 0) < 3.0) return false;
    if (state.resFilter === 'pending' && (o.status !== 'pending' || o.is_no_score)) return false;
    if (state.resFilter === 'no_score' && !o.is_no_score) return false;
    if (state.resFilter === 'push' && o.status !== 'push') return false;
    if (state.resMarket !== 'all' && o.market !== state.resMarket) return false;
    if (
      q &&
      !`${o.home} ${o.away} ${o.league} ${o.market_short} ${o.market_label || ''} ${o.recommendation?.action || ''}`
        .toLowerCase()
        .includes(q)
    ) {
      return false;
    }
    return true;
  });

  const dir = state.resSortDir === 'asc' ? 1 : -1;
  return filtered.slice().sort((a, b) => {
    if (state.resSort === 'best' || state.resSort === 'outcome') {
      const rank = (o) => {
        if (o.reco_result === 'win') return 6;
        if (o.status === 'settled' && o.bf_top_won === true) return 5;
        if (o.status === 'settled' && o.reco_result !== 'loss') return 4;
        if (o.status === 'push') return 3;
        if (o.status === 'pending' && !o.is_no_score) return 2;
        if (o.is_no_score) return 1;
        return 0;
      };
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return (ra - rb) * dir;
      const pa = typeof a.reco_pnl_u === 'number' ? a.reco_pnl_u : -999;
      const pb = typeof b.reco_pnl_u === 'number' ? b.reco_pnl_u : -999;
      if (pa !== pb) return (pa - pb) * dir;
    } else if (state.resSort === 'roi') {
      const pa = typeof a.reco_pnl_u === 'number' ? a.reco_pnl_u : -999;
      const pb = typeof b.reco_pnl_u === 'number' ? b.reco_pnl_u : -999;
      if (pa !== pb) return (pa - pb) * dir;
    } else if (state.resSort === 'gap') {
      const ga = a.max_abs_gap_pp ?? -1;
      const gb = b.max_abs_gap_pp ?? -1;
      if (ga !== gb) return (ga - gb) * dir;
    } else if (state.resSort === 'brier') {
      const ba = typeof a.brier_bf === 'number' ? a.brier_bf : null;
      const bb = typeof b.brier_bf === 'number' ? b.brier_bf : null;
      if (ba === null && bb !== null) return 1;
      if (ba !== null && bb === null) return -1;
      if (ba !== null && bb !== null && ba !== bb) return (ba - bb) * dir;
    } else if (state.resSort === 'vol') {
      const va = a.bf_volume || 0;
      const vb = b.bf_volume || 0;
      if (va !== vb) return (va - vb) * dir;
    } else {
      const ta = kickoffTs(a.date || a.settled_at || a.captured_at);
      const tb = kickoffTs(b.date || b.settled_at || b.captured_at);
      if (ta !== tb) return (ta - tb) * dir;
    }
    return kickoffTs(b.date || b.captured_at) - kickoffTs(a.date || a.captured_at);
  });
}

/* ---- TAB 1 : ACCUEIL ---- */
export function renderHomeDynamicHtml() {
  const merged = buildMergedMatches();
  const dualCount = merged.filter((m) => Boolean(m.pm_matched)).length;
  const singleCount = merged.length - dualCount;

  const q = state.homeQuery.trim().toLowerCase();
  let list = merged.filter((m) => {
    if (q && !`${m.home} ${m.away} ${m.league} ${m.country}`.toLowerCase().includes(q)) return false;
    if (state.homeFilter === 'dual' && !m.pm_matched) return false;
    if (state.homeFilter === 'single' && m.pm_matched) return false;
    return true;
  });

  list = list.slice().sort((a, b) => {
    if (state.homeSort === 'league') {
      return String(a.league || '').localeCompare(String(b.league || ''), 'fr') || kickoffTs(a.date) - kickoffTs(b.date);
    }
    if (state.homeSort === 'name') {
      return String(a.home || '').localeCompare(String(b.home || ''), 'fr');
    }
    return kickoffTs(a.date) - kickoffTs(b.date) || String(a.home || '').localeCompare(String(b.home || ''), 'fr');
  });

  const visible = list.slice(0, state.homeLimit);
  const hasMore = list.length > state.homeLimit;

  const matchRowsHtml = visible.length
    ? visible
        .map((m) => {
          const ko = formatKickoffCompact(m.date);
          const metaLine = [m.league, m.country].filter(Boolean).join(' · ') || 'Compétition internationale';
          const srcBadge = m.pm_matched
            ? `<span class="home-src-pill dual"><i class="sig-dot ok"></i>Betfair + Polymarket</span>`
            : `<span class="home-src-pill"><i class="sig-dot obs"></i>Betfair</span>`;

          return `<div class="row row-plain tv-row-static">
            <div class="tm">${esc(ko.hm)}<small>${esc(ko.day)}</small></div>
            <div class="mid">
              <div class="t">${esc(m.home)} — ${esc(m.away)}</div>
              <div class="s">${esc(metaLine)}</div>
            </div>
            <div class="r">${srcBadge}</div>
          </div>`;
        })
        .join('')
    : renderEmptyWithResetHtml('Aucun match collecté ne correspond à votre recherche.', 'home');

  return `
    <div class="chips" role="group" aria-label="Filtres matchs collectés">
      <button type="button" class="chip${state.homeFilter === 'all' ? ' on' : ''}" data-hf="all">Tous (${merged.length})</button>
      <button type="button" class="chip${state.homeFilter === 'dual' ? ' on' : ''}" data-hf="dual">2 sources (${dualCount})</button>
      <button type="button" class="chip${state.homeFilter === 'single' ? ' on' : ''}" data-hf="single">Betfair seul (${singleCount})</button>
      <button type="button" class="chip${state.homeSort === 'time' ? ' on' : ''}" data-hs="time">Tri : Heure</button>
      <button type="button" class="chip${state.homeSort === 'league' ? ' on' : ''}" data-hs="league">Tri : Compétition</button>
      <button type="button" class="chip${state.homeSort === 'name' ? ' on' : ''}" data-hs="name">Tri : Nom A→Z</button>
    </div>

    <div class="list">${matchRowsHtml}</div>
    ${
      hasMore
        ? `<button type="button" class="more" id="homeMoreBtn">Afficher plus (${list.length - state.homeLimit})</button>`
        : ''
    }
  `;
}

export function renderHomeView() {
  const calSum = state.calData?.summary || {};
  const merged = buildMergedMatches();

  const settled = calSum.settled ?? 0;
  const settledFixtures = calSum.settled_fixtures ?? 0;
  const pending = calSum.pending ?? 0;
  const totalObs = calSum.total_observations ?? 0;
  const divTotal = calSum.divergence_count ?? 0;
  const bfWins = calSum.divergence_bf_wins ?? 0;
  const pmWins = calSum.divergence_pm_wins ?? 0;
  const recoSettled = calSum.reco_settled ?? 0;
  const recoWon = calSum.reco_won ?? 0;
  const recoRate = calSum.reco_win_rate_pct;

  const accuracyMain =
    recoSettled > 0 && recoRate != null
      ? `${recoRate} %`
      : calSum.bf_fav_hit_pct != null
      ? `${calSum.bf_fav_hit_pct} %`
      : '—';
  const accuracySub =
    recoSettled > 0
      ? `Signaux gagnants (${recoWon}/${recoSettled})`
      : `Favoris validés (BF ${calSum.bf_fav_hit_pct ?? '—'} % · PM ${calSum.pm_fav_hit_pct ?? '—'} %)`;

  return `
    <section class="home-hero">
      <div class="home-kicker">Comparateur pré-match · Betfair × Polymarket</div>
      <h1>Truevalue</h1>
      <p class="home-lead">
        Écarts de probabilités détectés avant coup d’envoi, classés par intérêt et vérifiés publiquement sur les scores finaux.
      </p>
      <div class="home-cta-row">
        <button type="button" class="home-cta-primary" data-go-tab="sig">Voir les signaux en direct →</button>
        <button type="button" class="home-cta-sec" data-go-tab="res">Consulter les résultats</button>
      </div>
    </section>

    <div class="home-steps" aria-label="Méthodologie en 3 étapes">
      <div class="home-step">
        <div class="home-step-num">01 · COLLECTE</div>
        <b>Relevés horodatés</b>
        <span>Enregistrés avant le coup d’envoi, sans tri sélectif.</span>
      </div>
      <div class="home-step">
        <div class="home-step-num">02 · SIGNAUX</div>
        <b>Lecture immédiate</b>
        <span>Écarts nets, mouvements 24h et contradictions en un coup d’œil.</span>
      </div>
      <div class="home-step">
        <div class="home-step-num">03 · PREUVE</div>
        <b>Scores vérifiés</b>
        <span>Chaque signal est contrôlé via ESPN et SportScore.</span>
      </div>
    </div>

    <div class="cap-row">
      <div class="cap">Bilan global des signaux précédents</div>
      <div class="cap-actions">
        <button type="button" class="cap-link" data-go-tab="res">Tableau détaillé ›</button>
      </div>
    </div>
    <div class="list">
      <div class="big big-4 tv-home-big">
        <div class="box"><b>${totalObs}</b><span>Relevés suivis (${pending} en attente)</span></div>
        <div class="box"><b>${settled}</b><span>Marchés réglés (${settledFixtures} matchs)</span></div>
        <div class="box"><b>${esc(accuracyMain)}</b><span>${esc(accuracySub)}</span></div>
        <div class="box"><b>${fmtMetric4(calSum.brier_bf)} / ${fmtMetric4(calSum.brier_pm)}</b><span>Précision Brier BF / PM (plus bas = mieux)</span></div>
      </div>
      <div class="cell"><span>Divergences réglées (≥ 3 pts d’écart)</span><b>${divTotal} cas (BF ${bfWins} · PM ${pmWins})</b></div>
      <div class="cell cell-action" data-go-tab="res" role="button" tabindex="0"><span>Journal détaillé match par match</span><b>Ouvrir Résultats ›</b></div>
    </div>

    <div class="cap">Matchs collectés (${merged.length})</div>
    <div class="sub tv-mb-8">Calendrier neutre des rencontres suivies avant coup d’envoi (aucune donnée premium).</div>

    ${renderSearchBarHtml('homeSearchInput', 'Équipe, ligue ou pays…', state.homeQuery, 'Rechercher un match collecté', 'home')}

    <div id="homeDynamicWrap">${renderHomeDynamicHtml()}</div>
    <div class="foot">Réservé aux majeurs (18+). Outil d’analyse statistique ; aucun gain garanti. Non affilié à Betfair ni Polymarket.</div>
  `;
}

/* ---- TAB 2 : SIGNAUX ---- */
function renderProposalSettingsPanel(activeTh = {}, showPresets = true) {
  const th = activeTh || {};
  const custom = state.propThresholds || {};
  const vEdge = custom.minNetEdgePp ?? th.minNetEdgePp ?? 0;
  const vVol = custom.minBfVolume ?? th.minBfVolume ?? 0;
  const vLiq = custom.minPmLiquidity ?? th.minPmLiquidity ?? 0;
  const vSpr = custom.maxSpreadPts ?? th.maxSpreadPts ?? 25.0;
  const vDrop = custom.maxAdverseDropPct ?? th.maxAdverseDropPct ?? 100.0;

  return `<div class="tg-form-panel" id="propSettingsPanel">
    ${
      showPresets
        ? `<div class="chips tv-mb-8" role="group" aria-label="Profils de seuils des propositions">
            <button type="button" class="chip${state.propPreset === 'zero' && !state.propThresholds ? ' on' : ''}" data-sp="zero">Seuil 0 (défaut)</button>
            <button type="button" class="chip${state.propPreset === 'strict' && !state.propThresholds ? ' on' : ''}" data-sp="strict">Strict ≥ 3 000 €</button>
            <button type="button" class="chip${state.propPreset === 'balanced' && !state.propThresholds ? ' on' : ''}" data-sp="balanced">Élargi ≥ 1 000 €</button>
            <button type="button" class="chip${state.propPreset === 'exploratory' && !state.propThresholds ? ' on' : ''}" data-sp="exploratory">Exploratoire ≥ 300 €</button>
          </div>`
        : ''
    }
    <form id="propThForm" novalidate>
      <div class="tg-form-grid">
        <label class="tg-field"><span>Écart net min (pts)</span><input id="propMinEdge" type="number" step="0.1" min="0" max="30" value="${esc(vEdge)}" /></label>
        <label class="tg-field"><span>Volume BF min (€)</span><input id="propMinVol" type="number" step="100" min="0" max="100000" value="${esc(vVol)}" /></label>
        <label class="tg-field"><span>Liquidité min ($)</span><input id="propMinLiq" type="number" step="50" min="0" max="50000" value="${esc(vLiq)}" /></label>
        <label class="tg-field"><span>Spread max (pts)</span><input id="propMaxSpr" type="number" step="0.5" min="0.5" max="30" value="${esc(vSpr)}" /></label>
        <label class="tg-field"><span>Dérive max (%)</span><input id="propMaxDrop" type="number" step="0.5" min="0" max="100" value="${esc(vDrop)}" /></label>
        <div class="tg-btn-row tv-col-span-all">
          <button type="submit" class="tg-btn-sm">Appliquer les seuils</button>
          <button type="button" class="tg-btn-sm alt" id="propThResetBtn">Défaut (Seuil 0)</button>
          <button type="button" class="tg-btn-sm danger" id="propHideBtn">Masquer les propositions</button>
        </div>
      </div>
      <div id="propFormError" class="tv-inline-err" role="alert" hidden></div>
    </form>
  </div>`;
}

function buildSignalMatchesCompareList(baseList, q) {
  const mergedByKey = new Map(buildMergedMatches().map((m) => [m.fixture_key, m]));
  const byKey = new Map();
  for (const s of baseList) {
    if (
      q &&
      !`${s.home} ${s.away} ${s.league} ${s.title} ${s.detail} ${s.signature_code || ''} ${s.pm_signature_code || ''}`
        .toLowerCase()
        .includes(q)
    ) {
      continue;
    }
    if (!byKey.has(s.fixture_key)) {
      const merged = mergedByKey.get(s.fixture_key) || null;
      byKey.set(s.fixture_key, {
        fixture_key: s.fixture_key,
        home: s.home,
        away: s.away,
        league: s.league,
        date: s.date || merged?.date || null,
        date_label: s.date_label,
        total_volume_bf: s.total_volume_bf,
        pm_liquidity: s.pm_liquidity ?? merged?.pm_liquidity ?? null,
        pm_url: s.pm_url || merged?.pm_url || null,
        signature_code: s.signature_code || merged?.signature?.code || null,
        pm_signature_code: s.pm_signature_code || merged?.signature?.pm_code || null,
        cmp: merged?.cmp || null,
        signals: [],
        top_score: s.score_sort || 0,
        max_edge: typeof s.net_edge_pp === 'number' ? s.net_edge_pp : null,
        max_conf: signalConfidenceScore(s),
        max_move: signalMoveMagnitude(s),
        locked: Boolean(s.locked || merged?.cmp?.locked),
      });
    }
    const entry = byKey.get(s.fixture_key);
    entry.signals.push(s);
    if (s.locked) entry.locked = true;
    if ((s.score_sort || 0) > entry.top_score) entry.top_score = s.score_sort || 0;
    if (typeof s.net_edge_pp === 'number' && (entry.max_edge === null || s.net_edge_pp > entry.max_edge)) {
      entry.max_edge = s.net_edge_pp;
    }
    const sc = signalConfidenceScore(s);
    if (sc > entry.max_conf) entry.max_conf = sc;
    const mv = signalMoveMagnitude(s);
    if (mv > entry.max_move) entry.max_move = mv;
  }

  const dir = state.sigSortDir === 'asc' ? 1 : -1;
  const sk = state.sigSort;
  return [...byKey.values()]
    .filter((e) => e.cmp && Array.isArray(e.cmp.markets) && e.cmp.markets.length > 0)
    .sort((a, b) => {
      if (sk === 'vol') {
        if (a.total_volume_bf !== b.total_volume_bf) return ((a.total_volume_bf || 0) - (b.total_volume_bf || 0)) * dir;
      } else if (sk === 'edge') {
        const ae = a.max_edge ?? a.cmp.max_abs_gap_pp ?? -999;
        const be = b.max_edge ?? b.cmp.max_abs_gap_pp ?? -999;
        if (ae !== be) return (ae - be) * dir;
      } else if (sk === 'conf') {
        if (a.max_conf !== b.max_conf) return (a.max_conf - b.max_conf) * dir;
      } else if (sk === 'move') {
        if (a.max_move !== b.max_move) return (a.max_move - b.max_move) * dir;
      } else if (sk === 'time') {
        const at = kickoffTs(a.date || a.date_label);
        const bt = kickoffTs(b.date || b.date_label);
        if (at !== bt) return (at - bt) * dir;
      } else if (a.top_score !== b.top_score) {
        return (a.top_score - b.top_score) * dir;
      }
      return (
        (b.top_score || 0) - (a.top_score || 0) ||
        (b.max_edge ?? -999) - (a.max_edge ?? -999) ||
        b.signals.length - a.signals.length ||
        (b.total_volume_bf || 0) - (a.total_volume_bf || 0)
      );
    });
}

export function renderSignalsDynamicHtml() {
  const sigData = state.sigData || {};
  const counts = sigData.counts || {};
  const th = sigData.thresholds || {};
  const baseList = getVisibleSignalsList(sigData);
  const activeCat = !state.showProposals && state.sigCat === 'executable' ? 'all' : state.sigCat;
  const q = state.sigQuery.trim().toLowerCase();

  const sigResData = state.sigResData || { summary: {}, results: [] };
  const sigResSum = sigResData.summary || {};
  const sigResCount = sigResSum.total_matches ?? 0;

  const compareFixtures = buildSignalMatchesCompareList(baseList, q);
  const filtered = getFilteredSortedSignals(sigData);

  const legendHtml =
    activeCat === 'compare'
      ? `<div class="sig-legend">
          <span class="sig-leg-item"><i class="sig-dot ok"></i><b>Écart Δ vert</b> Polymarket &gt; Betfair (≥ +3 pts)</span>
          <span class="sig-leg-item"><i class="sig-dot bad"></i><b>Écart Δ rouge</b> Polymarket &lt; Betfair (≤ −3 pts)</span>
          <button type="button" class="cap-link" data-open-help="1">? Comprendre les termes</button>
        </div>`
      : activeCat === 'results'
      ? `<div class="sig-legend">
          <span class="sig-leg-item"><i class="sig-dot ok"></i><b>Vert</b> Gagné / Score publié</span>
          <span class="sig-leg-item"><i class="sig-dot bad"></i><b>Rouge</b> Perdu</span>
          <span class="sig-leg-item"><i class="sig-dot info"></i><b>Bleu</b> Push (DNB nul / annulé)</span>
          <span class="sig-leg-item"><i class="sig-dot obs"></i><b>Gris</b> En attente</span>
          <button type="button" class="cap-link" data-open-help="1">? Glossaire</button>
        </div>`
      : `<div class="sig-legend">
          <span class="sig-leg-item"><i class="sig-dot ok"></i><b>Vert</b> Opportunité (+edge)</span>
          <span class="sig-leg-item"><i class="sig-dot info"></i><b>Bleu</b> Seuil 0 (&lt; 0 pt)</span>
          <span class="sig-leg-item"><i class="sig-dot warn"></i><b>Orange</b> Mouvement 24h</span>
          <span class="sig-leg-item"><i class="sig-dot bad"></i><b>Rouge</b> Contradiction</span>
          ${(counts.flow ?? 0) > 0 ? `<span class="sig-leg-item"><i class="sig-dot obs"></i><b>Gris</b> Flux BF×PM</span>` : ''}
          <button type="button" class="cap-link" data-open-help="1">? Guide couleurs &amp; sigles</button>
        </div>`;

  const sortOptions =
    activeCat === 'results'
      ? [
          { key: 'score', label: 'Pertinence' },
          { key: 'time', label: 'Date' },
          { key: 'edge', label: 'Edge net' },
          { key: 'vol', label: 'Volume BF' },
        ]
      : [
          { key: 'score', label: 'Pertinence' },
          { key: 'edge', label: 'Edge net' },
          { key: 'conf', label: 'Confiance' },
          { key: 'vol', label: 'Volume BF' },
          { key: 'move', label: 'Variation 24h' },
          { key: 'time', label: 'Heure' },
        ];

  const sortBarHtml = `<div class="sig-sort-row" role="group" aria-label="Tri des signaux">
    <span class="sig-sort-lbl">Trier :</span>
    ${sortOptions
      .map((opt) => `<button type="button" class="chip${state.sigSort === opt.key ? ' on' : ''}" data-ss="${opt.key}">${opt.label}</button>`)
      .join('')}
    <button type="button" class="chip sig-sort-dir" id="sigSortDirBtn" title="Inverser l'ordre de tri" aria-label="Inverser l'ordre de tri (${state.sigSortDir === 'asc' ? 'croissant' : 'décroissant'})">${
      state.sigSortDir === 'asc' ? '↑ Croissant' : '↓ Décroissant'
    }</button>
  </div>`;

  let mainContentHtml = '';
  if (activeCat === 'results') {
    const resFiltered = getFilteredSortedSignalResults(sigResData);
    const visibleRes = resFiltered.slice(0, state.sigResLimit);
    const hasMoreRes = resFiltered.length > state.sigResLimit;
    const recoSettled = sigResSum.reco_settled ?? 0;
    const recoWon = sigResSum.reco_won ?? 0;
    const recoRate = sigResSum.reco_win_rate_pct;
    const settledMatches = sigResSum.settled_matches ?? 0;
    const pendingMatches = sigResSum.pending_matches ?? 0;

    const resRowsHtml = visibleRes.length
      ? visibleRes
          .map((r, idx) => {
            const meta = signalHistoryToneMeta(r);
            const ko = formatKickoffCompact(r.date);
            const subStr = [
              r.league,
              ko.hm !== '—' ? `${ko.hm} ${ko.day}` : '',
              r.total_volume_bf ? `BF ${fmtEur(r.total_volume_bf)}` : '',
              `${(r.signals || []).length} signal${(r.signals || []).length > 1 ? 'x' : ''}`,
            ]
              .filter(Boolean)
              .join(' · ');

            const primarySig = (r.signals || [])[0] || null;
            const actionTxt = primarySig
              ? primarySig.action
                ? `Prop. : ${primarySig.action}${primarySig.market_short ? ` (${primarySig.market_short})` : ''}`
                : primarySig.title
              : 'Signal enregistré';

            const extraParts = (r.signals || []).slice(0, 3).map((s) => {
              const lbl = s.action || s.title;
              if (s.signal_result === 'win') return `${lbl} ✓`;
              if (s.signal_result === 'loss') return `${lbl} ✕`;
              if (s.signal_result === 'push') return `${lbl} (Push)`;
              if (Array.isArray(s.winning_labels) && s.winning_labels.length > 0) {
                return `${s.market_short || 'Issue'} : ${s.winning_labels.join('/')}`;
              }
              return lbl;
            });
            const takeaway =
              extraParts.join(' · ') ||
              (r.status === 'pending' ? 'En attente du coup de sifflet final' : 'Score officiel enregistré');

            let rightBlock = '';
            if (r.status === 'settled' && r.reco_pnl_u != null) {
              const cls = r.reco_pnl_u > 0 ? 'pos' : r.reco_pnl_u < 0 ? 'neg' : '';
              const sign = r.reco_pnl_u >= 0 ? '+' : '';
              rightBlock = `<div class="r"><b class="${cls}">${sign}${r.reco_pnl_u.toFixed(2)} u</b><span class="muted">${r.reco_won}G / ${r.reco_lost}P</span></div>`;
            } else if (r.status === 'settled' && r.home_score != null) {
              rightBlock = `<div class="r"><b class="${meta.tone === 'bad' ? 'neg' : 'pos'}">${r.home_score} - ${r.away_score}</b><span class="muted">${esc((r.result_source || 'FT').toUpperCase())}</span></div>`;
            } else if (r.status === 'push') {
              rightBlock = `<div class="r"><b class="info">0.00 u</b><span class="muted">Push</span></div>`;
            } else {
              rightBlock = `<div class="r"><b class="muted">Attente</b><span class="muted">${(r.signals || []).length} signaux</span></div>`;
            }

            return `<div class="row" data-sig-res-idx="${idx}" role="button" tabindex="0">
              <div class="av sig-av${meta.ringCls}" style="--p:${r.status === 'settled' ? 100 : r.status === 'push' ? 50 : 25}"><i></i><b class="res-score-b">${esc(meta.ringMain)}</b><small>${esc(meta.ringSub)}</small></div>
              <div class="mid">
                <div class="t">${esc(r.home)} — ${esc(r.away)}</div>
                <div class="s">${esc(subStr)}</div>
                <div class="sig-badge-row">
                  <span class="sig-type-tag ${meta.tone}">${esc(meta.tag)}</span>
                  <span class="sig-action-txt">${esc(actionTxt)}</span>
                </div>
                <div class="sig-takeaway">${esc(takeaway)}</div>
              </div>
              ${rightBlock}
            </div>`;
          })
          .join('')
      : renderEmptyWithResetHtml('Aucun match passé dans Signaux ne correspond à ces critères.', 'sig');

    mainContentHtml = `
      <div class="res-head-bar tv-mt-4 tv-mb-8">
        <div class="sub">Historique filtré uniquement sur les matchs ayant généré un signal.</div>
        ${state.isAdmin ? '<button type="button" class="tg-btn-sm" id="sigResSyncBtn">Synchroniser scores</button>' : ''}
      </div>
      <div class="big big-4 tv-mb-12">
        <div class="box"><b>${sigResCount}</b><span>Matchs passés dans Signaux</span></div>
        <div class="box"><b>${settledMatches} / ${pendingMatches}</b><span>Réglés / En attente</span></div>
        <div class="box"><b>${recoSettled > 0 ? `${recoWon}/${recoSettled} (${recoRate} %)` : '—'}</b><span>Propositions gagnées</span></div>
        <div class="box"><b>${sigResSum.reco_roi_u != null ? `${sigResSum.reco_roi_u >= 0 ? '+' : ''}${sigResSum.reco_roi_u} u` : '—'}</b><span>Bilan unités (1 u / prop.)</span></div>
      </div>
      <div class="chips" role="group" aria-label="Filtres historique des signaux">
        <button type="button" class="chip${state.sigResFilter === 'all' ? ' on' : ''}" data-srf="all">Tous (${sigResCount})</button>
        <button type="button" class="chip${state.sigResFilter === 'settled' ? ' on' : ''}" data-srf="settled">Réglés (${settledMatches})</button>
        <button type="button" class="chip${state.sigResFilter === 'won' ? ' on' : ''}" data-srf="won">Gagnés</button>
        <button type="button" class="chip${state.sigResFilter === 'lost' ? ' on' : ''}" data-srf="lost">Perdus</button>
        <button type="button" class="chip${state.sigResFilter === 'reco' ? ' on' : ''}" data-srf="reco">Propositions</button>
        <button type="button" class="chip${state.sigResFilter === 'pending' ? ' on' : ''}" data-srf="pending">En attente (${pendingMatches})</button>
      </div>
      <div class="list">${resRowsHtml}</div>
      ${
        hasMoreRes
          ? `<button type="button" class="more" id="sigResMoreBtn">Afficher plus (${resFiltered.length - state.sigResLimit})</button>`
          : ''
      }
    `;
  } else if (activeCat === 'compare') {
    mainContentHtml = compareFixtures.length
      ? `<div class="sig-cmp-stack">${compareFixtures
          .slice(0, 30)
          .map((item) => {
            const topSig = item.signals[0];
            const ko = formatKickoffCompact(item.date || item.date_label);
            const subLine = [
              item.league,
              ko.hm !== '—' ? `${ko.hm}${ko.day ? ` ${ko.day}` : ''}` : '',
              `BF ${fmtEur(item.total_volume_bf)}`,
              item.pm_liquidity != null ? `PM ${fmtUsd(item.pm_liquidity)}` : '',
            ]
              .filter(Boolean)
              .join(' · ');
            const sigPairHtml =
              item.signature_code || item.pm_signature_code
                ? `<div class="sig-cmp-pair"><span class="sig-mono">BF ${esc(
                    item.signature_code || '?'
                  )}</span><span class="sig-cmp-sep">×</span><span class="sig-mono">PM ${esc(
                    item.pm_signature_code || '?'
                  )}</span></div>`
                : '';
            const badgesHtml = `<div class="sig-cmp-badges">
              <span class="sig-cmp-tag">${item.signals.length} signal${item.signals.length > 1 ? 'x' : ''}</span>
              ${
                topSig
                  ? `<span class="sig-cmp-top">${esc(
                      topSig.category === 'executable' && topSig.recommendation
                        ? `Proposition : ${topSig.recommendation.action}`
                        : topSig.title
                    )}</span>`
                  : ''
              }
            </div>`;
            return `<section class="sig-cmp-card">
              <div class="sig-cmp-head" data-match-key="${esc(item.fixture_key)}" role="button" tabindex="0">
                <div class="mid">
                  <div class="t">${esc(item.home)} — ${esc(item.away)}</div>
                  <div class="s">${esc(subLine)}</div>
                  ${sigPairHtml}
                  ${badgesHtml}
                </div>
                <div class="r"><b>${item.cmp.markets.length} marchés</b><span>Fiche ›</span></div>
              </div>
              ${renderCmpMarketsHtml(item.cmp, { showHeader: false })}
            </section>`;
          })
          .join('')}</div>`
      : renderEmptyWithResetHtml('Aucun match avec données Betfair × Polymarket dans les signaux actifs.', 'sig');
  } else {
    const visible = filtered.slice(0, state.sigLimit);
    const hasMore = filtered.length > state.sigLimit;
    const rowsHtml = visible.length
      ? visible
          .map((s, idx) => {
            const locked = s.locked === true || (!state.isPro && idx >= 3);
            const score = signalConfidenceScore(s);
            const meta = signalToneInfo(s);
            const ko = formatKickoffCompact(s.date || s.date_label);

            const subStr = [
              s.league,
              ko.hm !== '—' ? `${ko.hm}${ko.day ? ` ${ko.day}` : ''}` : '',
              `BF ${fmtEur(s.total_volume_bf)}`,
              s.pm_liquidity != null ? `PM ${fmtUsd(s.pm_liquidity)}` : '',
            ]
              .filter(Boolean)
              .join(' · ');

            let rightBlock = '';
            if (locked) {
              rightBlock = `<span class="lk-pill" aria-hidden="true">🔒 Pro</span>`;
            } else if (s.category === 'executable') {
              const edgeVal = typeof s.net_edge_pp === 'number' ? s.net_edge_pp : 0;
              const odds = s.recommendation?.prop_odds ?? s.recommendation?.pm_exec_odds;
              const valCls = edgeVal >= 0 ? 'pos' : 'info';
              const subLbl = `${edgeVal >= 0 ? 'Edge net' : 'Sous pair'}${odds ? ` · @${fmtOdds(odds)}` : ''}`;
              rightBlock = `<div class="r"><b class="${valCls}">${esc(fmtNetEdge(edgeVal))}</b><span class="muted">${esc(subLbl)}</span></div>`;
            } else if (s.category === 'movement') {
              const dirArrow = s.signal_type === 'retournement' ? '⇄' : (s.prob_delta_pp ?? 0) >= 0 ? '↗' : '↘';
              const ampTxt = s.amplitude_pct != null ? `${dirArrow} ${s.amplitude_pct.toFixed(1)} %` : `${dirArrow} Mouv.`;
              const deltaTxt = s.prob_delta_pp != null ? `${s.prob_delta_pp > 0 ? '+' : ''}${s.prob_delta_pp.toFixed(1)} pts` : 'Var. 24h';
              rightBlock = `<div class="r"><b class="warn">${esc(ampTxt)}</b><span class="muted">${esc(deltaTxt)}</span></div>`;
            } else if (s.category === 'contradiction') {
              rightBlock = `<div class="r"><b class="neg">${s.contradictions_count || 1} split(s)</b><span class="muted">Désaccord</span></div>`;
            } else if (s.net_edge_pp != null) {
              rightBlock = `<div class="r"><b class="${s.net_edge_pp >= 0 ? 'pos' : 'info'}">${esc(fmtNetEdge(s.net_edge_pp))}</b><span class="muted">Flux</span></div>`;
            }

            let actionText = s.title;
            let takeawayText = s.detail;
            let liqWarnBadge = '';
            if (!locked && s.category === 'executable' && s.recommendation) {
              const r = s.recommendation;
              actionText = `${r.action}${r.market_short ? ` (${r.market_short})` : ''}`;
              const pmP = r.prop_pct ?? r.pm_exec_pct;
              const bfP = r.bf_prop_pct ?? r.bf_pct;
              const parts = [];
              if (pmP != null && bfP != null) {
                parts.push(`PM ${pmP.toFixed(1)} % vs juste Betfair ${bfP.toFixed(1)} %`);
              }
              if (typeof r.ev_net_pct === 'number') {
                parts.push(`EV nette ${r.ev_net_pct > 0 ? '+' : ''}${r.ev_net_pct.toFixed(1)} %`);
              } else if (typeof r.ev_pct === 'number' && r.ev_pct > 0) {
                parts.push(`EV +${r.ev_pct.toFixed(1)} %`);
              }
              if (s.pm_liquidity != null) {
                parts.push(`Liq. ${fmtUsd(s.pm_liquidity)}`);
              }
              takeawayText = parts.join(' · ') || s.detail;
              if (r.pm_liquidity_warning) {
                liqWarnBadge = ' <span class="tv-liq-warn">Carnet fin</span>';
              }
            }

            const rowAria = locked
              ? ` aria-label="${esc(s.home)} — ${esc(s.away)}, réservé Truevalue Pro"`
              : '';

            return `<div class="row${locked ? ' lk' : ''}" data-sig-idx="${idx}" data-locked="${locked ? '1' : '0'}" role="button" tabindex="0"${rowAria}>
              <div class="av sig-av${meta.ringCls}" style="--p:${score}"><i></i><b>${score}</b><small>${meta.ringSub}</small></div>
              <div class="mid">
                <div class="t">${esc(s.home)} — ${esc(s.away)}</div>
                <div class="s">${esc(subStr)}</div>
                <div class="sig-badge-row">
                  <span class="sig-type-tag ${meta.tone}">${esc(meta.tag)}</span>
                  <span class="sig-action-txt">${esc(actionText)}</span>${liqWarnBadge}
                </div>
                <div class="sig-takeaway">${esc(takeawayText)}</div>
              </div>
              ${rightBlock}
            </div>`;
          })
          .join('')
      : renderEmptyWithResetHtml('Aucun signal actif avec les filtres ou seuils sélectionnés.', 'sig');

    const lockedCount = filtered.filter((s, idx) => s.locked === true || (!state.isPro && idx >= 3)).length;
    mainContentHtml = `
      <div class="list" id="sigListBox">${rowsHtml}</div>
      ${
        hasMore
          ? `<button type="button" class="more" id="sigMoreBtn">Afficher plus (${filtered.length - state.sigLimit})</button>`
          : ''
      }
      ${
        !state.isPro && lockedCount > 0
          ? `<div class="cap">+ ${lockedCount} signaux verrouillés en mode gratuit</div>
             <div class="list"><div class="row" id="sigUnlockRow" role="button" tabindex="0"><div class="av obs"><i></i><b>🔒</b></div><div class="mid"><div class="t">Accès complet Truevalue Pro</div><div class="s">Débloquez les ${filtered.length} signaux et leurs critères</div></div><div class="r"><span>Débloquer ›</span></div></div></div>`
          : ''
      }
    `;
  }

  return `
    <div class="chips" role="group" aria-label="Catégories de signaux">
      <button type="button" class="chip${activeCat === 'all' ? ' on' : ''}" data-sc="all">Tous (${baseList.length})</button>
      <button type="button" class="chip${activeCat === 'compare' ? ' on' : ''}" data-sc="compare">Comparateur BF×PM (${compareFixtures.length})</button>
      ${
        state.showProposals
          ? `<button type="button" class="chip${activeCat === 'executable' ? ' on' : ''}" data-sc="executable">Propositions (${
              counts.executable ?? 0
            })</button>`
          : ''
      }
      <button type="button" class="chip${activeCat === 'flow' ? ' on' : ''}" data-sc="flow">Flux BF×PM (${counts.flow ?? 0})</button>
      <button type="button" class="chip${activeCat === 'movement' ? ' on' : ''}" data-sc="movement">Mouvements (${counts.movement ?? 0})</button>
      <button type="button" class="chip${activeCat === 'contradiction' ? ' on' : ''}" data-sc="contradiction">Contradictions (${counts.contradiction ?? 0})</button>
      <button type="button" class="chip${activeCat === 'results' ? ' on' : ''}" data-sc="results">Historique signaux (${sigResCount})</button>
    </div>

    ${
      !state.showProposals && activeCat !== 'results'
        ? `<div class="tv-banner-muted">
            <span>Module Propositions masqué de la liste.</span>
            <button type="button" class="tg-btn-sm alt" id="propQuickShowBtn">Réactiver les propositions</button>
          </div>`
        : ''
    }

    ${
      state.showProposals && activeCat !== 'results'
        ? `<div class="chips" role="group" aria-label="Profil de seuils">
            <button type="button" class="chip${state.propPreset === 'zero' && !state.propThresholds ? ' on' : ''}" data-sp="zero">Seuil 0 (défaut)</button>
            <button type="button" class="chip${state.propPreset === 'strict' && !state.propThresholds ? ' on' : ''}" data-sp="strict">Strict ≥ 3 000 €</button>
            <button type="button" class="chip${state.propPreset === 'balanced' && !state.propThresholds ? ' on' : ''}" data-sp="balanced">Élargi ≥ 1 000 €</button>
            <button type="button" class="chip${state.propPreset === 'exploratory' && !state.propThresholds ? ' on' : ''}" data-sp="exploratory">Exploratoire ≥ 300 €</button>
            <button type="button" class="chip${state.showPropSettings ? ' on' : ''}" id="sigToggleSettingsBtn">⚙ Seuils${state.propThresholds ? ' (perso)' : ''}</button>
          </div>
          ${state.showPropSettings ? renderProposalSettingsPanel(th, false) : ''}`
        : ''
    }

    ${sortBarHtml}
    ${legendHtml}
    ${mainContentHtml}
  `;
}

export function renderSignalsView() {
  const sigData = state.sigData || {};
  const th = sigData.thresholds || {};
  const baseList = getVisibleSignalsList(sigData);
  const activeCat = !state.showProposals && state.sigCat === 'executable' ? 'all' : state.sigCat;

  const proBanner =
    !state.isPro && activeCat !== 'results'
      ? `<div class="banner" id="sigProBanner" role="button" tabindex="0">
          <span aria-hidden="true">⭐</span>
          <div>
            <b>Débloquez tous les signaux</b>
            <small>Truevalue Pro · ${state.proPriceStars} ★ / 30 jours · Telegram Stars</small>
          </div>
          <span class="go">Voir</span>
        </div>`
      : '';

  return `
    <h1>Signaux</h1>
    <div class="sub">${baseList.length} signaux actifs · ${
      state.propThresholds ? 'Seuils personnalisés' : esc(sigData.preset_label || 'Seuil 0 (défaut)')
    } (BF ≥ ${fmtEur(th.minBfVolume ?? 0)})</div>

    ${proBanner}

    ${renderSearchBarHtml(
      'sigSearchInput',
      activeCat === 'results' ? 'Filtrer un match passé dans Signaux…' : 'Filtrer équipe, marché ou signal…',
      state.sigQuery,
      'Rechercher un signal',
      'sig'
    )}

    <div id="sigDynamicWrap">${renderSignalsDynamicHtml()}</div>
    <div class="foot">Réservé aux majeurs (18+). Outil d’analyse statistique ; aucun gain garanti.</div>
  `;
}

/* ---- TAB 3 : RÉSULTATS DÉTAILLÉS ---- */
function formatRoiSummary(roiU, roiPct, stakedU = 0) {
  if (roiU == null || !stakedU) {
    return { main: '—', sub: 'Sans mise cotée', badge: 'Non cotable', cls: '', pillCls: 'obs' };
  }
  const signPct = roiPct > 0 ? '+' : '';
  const signU = roiU > 0 ? '+' : '';
  const main = `${signPct}${(roiPct ?? 0).toFixed(1)} %`;
  const unitStr = `${signU}${roiU.toFixed(2)} u`;
  if (roiU > 0) {
    return { main, sub: `${unitStr} sur ${stakedU} u misés`, badge: 'En positif', cls: 'pos', pillCls: 'ok' };
  }
  if (roiU < 0) {
    return { main, sub: `${unitStr} sur ${stakedU} u misés`, badge: 'En négatif', cls: 'neg', pillCls: 'bad' };
  }
  return { main: '0.0 %', sub: `0.00 u sur ${stakedU} u misés`, badge: 'Équilibre', cls: '', pillCls: 'info' };
}

function renderCategoryPerformanceGridHtml(cal, sigRes) {
  const byCat =
    (Array.isArray(sigRes?.by_category) && sigRes.by_category.length > 0 ? sigRes.by_category : cal?.by_category) || [];
  const bestCat = sigRes?.best_category || cal?.best_category || 'executable';
  const sum = cal?.summary || {};
  const activeCat = state.resCategory === 'best' ? bestCat : state.resCategory || bestCat;
  const globalRoi = formatRoiSummary(sum.reco_roi_u, sum.reco_roi_pct, sum.reco_staked_u);
  const globalMain =
    sum.reco_settled > 0 && sum.reco_win_rate_pct != null
      ? `${sum.reco_win_rate_pct} %${sum.reco_roi_pct != null ? ` · ROI ${globalRoi.main}` : ''}`
      : sum.bf_fav_hit_pct != null
      ? `${sum.bf_fav_hit_pct} % fav.`
      : '—';
  const globalSub = `${sum.played_matches ?? sum.settled_fixtures ?? 0} joués · ${sum.pending_matches ?? sum.pending ?? 0} en attente · ${sum.no_score_matches ?? sum.no_score ?? 0} sans source`;

  const cards = [
    `<button type="button" class="res-cat-card${activeCat === 'all' ? ' on' : ''}" data-res-cat="all" aria-pressed="${
      activeCat === 'all' ? 'true' : 'false'
    }">
      <div class="res-cat-head"><span>Toutes observations</span><span class="res-cat-count">${sum.total_matches ?? sum.total_observations ?? 0} matchs</span></div>
      <div class="res-cat-kpi ${globalRoi.cls}">${esc(globalMain)}</div>
      <div class="res-cat-sub">${esc(globalSub)}</div>
    </button>`,
    ...byCat.map((c) => {
      const isOn = activeCat === c.category;
      const isBest = c.category === bestCat;
      const cRoi = formatRoiSummary(c.roi_u, c.roi_pct, c.staked_u);
      let mainVal = `${c.settled_matches}/${c.total_matches} réglés`;
      let mainCls = '';
      if (c.decided > 0 && c.win_rate_pct != null) {
        mainVal = `${c.win_rate_pct} % (${c.won}/${c.decided})${c.roi_pct != null ? ` · ${cRoi.main}` : ''}`;
        mainCls = c.roi_pct != null ? cRoi.cls : c.win_rate_pct >= 50 ? 'pos' : 'neg';
      } else if (c.brier_bf != null && c.brier_pm != null) {
        mainVal = `BF ${c.bf_wins} · PM ${c.pm_wins}`;
      }
      const subTxt = `${c.played_matches ?? c.settled_matches} joués · ${c.pending_matches ?? 0} en attente · ${c.no_score_matches ?? 0} sans source`;
      return `<button type="button" class="res-cat-card${isOn ? ' on' : ''}" data-res-cat="${esc(
        c.category
      )}" aria-pressed="${isOn ? 'true' : 'false'}">
        <div class="res-cat-head">
          <span>${esc(c.label)}${isBest ? ' <em class="res-best-tag">★ Meilleure</em>' : ''}</span>
          <span class="res-cat-count">${c.total_matches} matchs</span>
        </div>
        <div class="res-cat-kpi ${mainCls}">${esc(mainVal)}</div>
        <div class="res-cat-sub">${esc(subTxt)}</div>
      </button>`;
    }),
  ];

  return `
    <div class="cap-row">
      <div class="cap">Catégories · Choisir pour charger le tableau</div>
      <div class="cap-actions">
        <button type="button" class="cap-link" data-open-help="1">? Guide</button>
      </div>
    </div>
    <div class="res-cat-grid" role="group" aria-label="Choisir une catégorie de performance">${cards.join('')}</div>
  `;
}

function renderResultsKpiStripHtml({
  winRatePct,
  won,
  lost,
  push,
  roiU,
  roiPct,
  stakedU,
  playedMatches,
  settledMatches,
  pendingMatches,
  noScoreMatches,
  totalMatches,
  brierBf,
  brierPm,
  bfWins,
  pmWins,
}) {
  const roi = formatRoiSummary(roiU, roiPct, stakedU);
  const hasDecided = (won || 0) + (lost || 0) > 0;
  const rateMain =
    hasDecided && winRatePct != null
      ? `${winRatePct} %`
      : brierBf != null && brierPm != null
      ? `BF ${bfWins ?? 0} · PM ${pmWins ?? 0}`
      : '—';
  const rateCls = hasDecided && winRatePct != null ? (winRatePct >= 50 ? 'pos' : 'neg') : '';
  const rateSub = hasDecided
    ? `${won} gagnés · ${lost} perdus${push > 0 ? ` · ${push} push` : ''}`
    : brierBf != null
    ? `Brier BF ${brierBf.toFixed(3)} / PM ${brierPm.toFixed(3)}`
    : 'En attente de matchs réglés';

  return `<div class="big big-4 tv-mb-12">
    <div class="box">
      <b class="${rateCls}">${esc(rateMain)}</b>
      <span>Taux de réussite · ${esc(rateSub)}</span>
    </div>
    <div class="box">
      <b class="${roi.cls}">${esc(roi.main)} <span class="sig-type-tag ${roi.pillCls}">${esc(roi.badge)}</span></b>
      <span>ROI · ${esc(roi.sub)}</span>
    </div>
    <div class="box">
      <b>${playedMatches}</b>
      <span>Matchs joués (${settledMatches} scorés${push > 0 ? ` · ${push} push` : ''})</span>
    </div>
    <div class="box">
      <b>${pendingMatches} <small class="res-kpi-sm">en attente</small> · <span class="${noScoreMatches > 0 ? 'warn' : ''}">${noScoreMatches}</span> <small class="res-kpi-sm">sans source</small></b>
      <span>Suivi total (${totalMatches} matchs)</span>
    </div>
  </div>`;
}

function renderCategoryScoreboardHtml(visibleCat) {
  if (!visibleCat.length) {
    return renderEmptyWithResetHtml('Aucun match ne correspond à ces critères dans cette catégorie.', 'res');
  }
  const rowsHtml = visibleCat
    .map((r, idx) => {
      const meta = signalHistoryToneMeta(r);
      const ko = formatKickoffCompact(r.date);
      const primarySig = (r.signals || [])[0] || null;
      const extraSigsCount = Math.max(0, (r.signals || []).length - 1);
      const sigLabel = primarySig
        ? primarySig.action
          ? `${primarySig.action}${primarySig.market_short ? ` (${primarySig.market_short})` : ''}`
          : primarySig.title
        : 'Signal';
      const sigSubParts = [
        primarySig?.category_label,
        primarySig?.prop_odds ? `@${fmtOdds(primarySig.prop_odds)}` : '',
        typeof primarySig?.net_edge_pp === 'number' ? `Edge ${fmtNetEdge(primarySig.net_edge_pp)}` : '',
        extraSigsCount > 0 ? `+${extraSigsCount} autre${extraSigsCount > 1 ? 's' : ''}` : '',
      ]
        .filter(Boolean)
        .join(' · ');

      const scoreCell =
        r.home_score != null && r.away_score != null
          ? `<strong>${r.home_score} - ${r.away_score}</strong>${
              r.home_ht != null ? `<small>MT ${r.home_ht}-${r.away_ht}</small>` : ''
            }`
          : r.status === 'push'
          ? '<span class="info">Annulé</span>'
          : r.is_no_score
          ? '<span class="warn">Sans source</span>'
          : '<span class="muted">À venir</span>';

      let roiCell = '<span class="muted">—</span>';
      if (r.status === 'settled' && r.reco_pnl_u != null) {
        const cls = r.reco_pnl_u > 0 ? 'pos' : r.reco_pnl_u < 0 ? 'neg' : '';
        const sign = r.reco_pnl_u > 0 ? '+' : '';
        const pctStr = r.reco_roi_pct != null ? `${r.reco_roi_pct > 0 ? '+' : ''}${r.reco_roi_pct.toFixed(0)}%` : '';
        roiCell = `<strong class="${cls}">${sign}${r.reco_pnl_u.toFixed(2)} u</strong>${
          pctStr ? `<small class="${cls}">${pctStr}</small>` : ''
        }`;
      } else if (r.status === 'settled' && r.better_source) {
        roiCell = `<strong class="${r.better_source === 'betfair' ? 'pos' : r.better_source === 'polymarket' ? 'info' : ''}">${
          r.better_source === 'betfair' ? 'BF juste' : r.better_source === 'polymarket' ? 'PM juste' : 'Égalité'
        }</strong><small>${r.brier_bf != null ? `Brier ${r.brier_bf.toFixed(3)}` : ''}</small>`;
      } else if (r.status === 'push') {
        roiCell = '<strong class="info">0.00 u</strong><small>Push</small>';
      } else if (r.is_no_score) {
        roiCell = `<small class="warn">${r.has_score_source ? 'Indisponible' : 'Non couverte'}</small>`;
      }

      return `<tr class="score-row" data-res-sig-idx="${idx}" role="button" tabindex="0">
        <td>
          <div class="st-match">${esc(r.home)} — ${esc(r.away)}</div>
          <div class="st-sub">${esc(r.league || '')}${ko.hm !== '—' ? ` · ${ko.hm} ${ko.day}` : ''}</div>
        </td>
        <td>
          <div class="st-sig">${esc(sigLabel)}</div>
          <div class="st-sub">${esc(sigSubParts)}</div>
        </td>
        <td class="num st-score">${scoreCell}</td>
        <td><span class="sig-type-tag ${meta.tone}">${esc(meta.tag)}</span></td>
        <td class="num st-roi">${roiCell}</td>
      </tr>`;
    })
    .join('');

  return `<div class="scoreboard-card">
    <div class="scoreboard-scroll">
      <table class="score-table">
        <thead>
          <tr>
            <th>Match</th>
            <th>Signal émis</th>
            <th class="num">Score</th>
            <th>Verdict</th>
            <th class="num">ROI / Bilan</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  </div>`;
}

function renderGlobalScoreboardHtml(visible) {
  if (!visible.length) {
    return renderEmptyWithResetHtml('Aucun relevé ne correspond à ces critères.', 'res');
  }
  const rowsHtml = visible
    .map((o, idx) => {
      const meta = resultToneMeta(o);
      const ko = formatKickoffCompact(o.date);
      const firstSig = Array.isArray(o.signals) && o.signals[0] ? o.signals[0] : null;
      const sigLabel = o.recommendation
        ? `${o.recommendation.action || o.recommendation.side_label} (${o.market_short})`
        : firstSig
        ? `${firstSig.title} (${o.market_short})`
        : `${o.market_short}${o.bf_top_label ? ` · Fav. ${o.bf_top_label}` : ''}`;
      const sigSub = o.recommendation
        ? `${o.recommendation.tier_label || 'Prop.'}${o.recommendation.prop_odds ? ` · @${fmtOdds(o.recommendation.prop_odds)}` : ''}`
        : o.in_signals
        ? `${(o.signals || []).length} signal(x)`
        : `Δ max ${o.max_abs_gap_pp?.toFixed(1) ?? '—'} pts`;

      const scoreCell =
        o.home_score != null && o.away_score != null
          ? `<strong>${o.home_score} - ${o.away_score}</strong>${
              o.home_ht != null ? `<small>MT ${o.home_ht}-${o.away_ht}</small>` : ''
            }`
          : o.status === 'push'
          ? '<span class="info">Push</span>'
          : o.is_no_score
          ? '<span class="warn">Sans source</span>'
          : '<span class="muted">À venir</span>';

      let roiCell = '<span class="muted">—</span>';
      if (o.status === 'settled' && o.reco_pnl_u != null) {
        const cls = o.reco_pnl_u > 0 ? 'pos' : o.reco_pnl_u < 0 ? 'neg' : '';
        const sign = o.reco_pnl_u > 0 ? '+' : '';
        roiCell = `<strong class="${cls}">${sign}${o.reco_pnl_u.toFixed(2)} u</strong><small class="${cls}">${
          o.reco_roi_pct != null ? `${o.reco_roi_pct > 0 ? '+' : ''}${o.reco_roi_pct.toFixed(0)}%` : ''
        }</small>`;
      } else if (o.status === 'settled' && o.brier_bf != null) {
        roiCell = `<strong>${o.brier_bf.toFixed(3)}</strong><small class="${o.bf_top_won ? 'pos' : 'neg'}">${
          o.bf_top_won ? 'Fav. ✓' : 'Fav. ✕'
        }</small>`;
      } else if (o.status === 'push') {
        roiCell = '<strong class="info">0.00 u</strong><small>Push</small>';
      } else if (o.is_no_score) {
        roiCell = `<small class="warn">${o.has_score_source ? 'Indisponible' : 'Non couverte'}</small>`;
      }

      return `<tr class="score-row" data-res-idx="${idx}" role="button" tabindex="0">
        <td>
          <div class="st-match">${esc(o.home)} — ${esc(o.away)}</div>
          <div class="st-sub">${esc(o.league || '')}${ko.hm !== '—' ? ` · ${ko.hm} ${ko.day}` : ''}</div>
        </td>
        <td>
          <div class="st-sig">${esc(sigLabel)}</div>
          <div class="st-sub">${esc(sigSub)}</div>
        </td>
        <td class="num st-score">${scoreCell}</td>
        <td><span class="sig-type-tag ${meta.tone}">${esc(meta.tag)}</span></td>
        <td class="num st-roi">${roiCell}</td>
      </tr>`;
    })
    .join('');

  return `<div class="scoreboard-card">
    <div class="scoreboard-scroll">
      <table class="score-table">
        <thead>
          <tr>
            <th>Match</th>
            <th>Marché &amp; Signal</th>
            <th class="num">Score</th>
            <th>Verdict</th>
            <th class="num">ROI / Brier</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  </div>`;
}

export function renderResultsDynamicHtml() {
  const cal = state.calData || {};
  const sigRes = state.sigResData || {};
  const sum = cal.summary || {};
  const bestCat = sigRes.best_category || cal.best_category || 'executable';
  const activeCat = state.resCategory === 'best' ? bestCat : state.resCategory || bestCat;
  const isCatMode = activeCat !== 'all';

  if (isCatMode) {
    const catSummary =
      sigRes.category_summary ||
      (sigRes.by_category || cal.by_category || []).find((c) => c.category === activeCat) ||
      {};
    const allCatRows = Array.isArray(sigRes.results) ? sigRes.results : [];
    const wonCount = allCatRows.filter((r) => r.match_outcome === 'win').length;
    const lostCount = allCatRows.filter((r) => r.match_outcome === 'loss').length;
    const noScoreCount = catSummary.no_score_matches ?? allCatRows.filter((r) => r.is_no_score).length;
    const pendingCount = catSummary.pending_matches ?? allCatRows.filter((r) => r.status === 'pending' && !r.is_no_score).length;
    const scoredCount = (catSummary.settled_matches ?? 0) + (catSummary.push_matches ?? 0);

    const catFiltered = getFilteredSortedCategoryResults(sigRes);
    const visibleCat = catFiltered.slice(0, state.resLimit);
    const hasMoreCat = catFiltered.length > state.resLimit;

    const sortOptions = [
      { key: 'best', label: 'Meilleurs résultats' },
      { key: 'roi', label: 'ROI' },
      { key: 'date', label: 'Date / Score' },
      { key: 'brier', label: 'Précision Brier' },
      { key: 'vol', label: 'Volume BF' },
    ];

    return `
      <div class="chips" role="group" aria-label="Filtres tableau de score">
        <button type="button" class="chip${state.resFilter === 'all' ? ' on' : ''}" data-rf="all">Tous (${allCatRows.length})</button>
        <button type="button" class="chip${state.resFilter === 'settled' ? ' on' : ''}" data-rf="settled">Scorés (${scoredCount})</button>
        <button type="button" class="chip${state.resFilter === 'won' ? ' on' : ''}" data-rf="won">Gagnés (${wonCount})</button>
        <button type="button" class="chip${state.resFilter === 'lost' ? ' on' : ''}" data-rf="lost">Perdus (${lostCount})</button>
        <button type="button" class="chip${state.resFilter === 'pending' ? ' on' : ''}" data-rf="pending">En attente (${pendingCount})</button>
        <button type="button" class="chip${state.resFilter === 'no_score' ? ' on' : ''}" data-rf="no_score">Sans source (${noScoreCount})</button>
      </div>

      <div class="sig-sort-row" role="group" aria-label="Tri du tableau de score">
        <span class="sig-sort-lbl">Trier :</span>
        ${sortOptions
          .map((o) => `<button type="button" class="chip${state.resSort === o.key ? ' on' : ''}" data-rs="${o.key}">${o.label}</button>`)
          .join('')}
        <button type="button" class="chip sig-sort-dir" id="resSortDirBtn" title="Inverser l'ordre de tri" aria-label="Inverser l'ordre de tri (${state.resSortDir === 'asc' ? 'croissant' : 'décroissant'})">${state.resSortDir === 'asc' ? '↑ Croissant' : '↓ Décroissant'}</button>
      </div>

      <div class="cap-row">
        <div class="cap">Tableau de score dynamique (${catFiltered.length} match${catFiltered.length > 1 ? 's' : ''})</div>
      </div>
      ${renderCategoryScoreboardHtml(visibleCat)}
      ${
        hasMoreCat
          ? `<button type="button" class="more" id="resMoreBtn">Afficher plus (${catFiltered.length - state.resLimit})</button>`
          : ''
      }
    `;
  }

  const allObs = Array.isArray(cal.observations) ? cal.observations : [];
  const uniqueMarkets = [...new Set(allObs.map((o) => o.market))].map((m) => ({
    key: m,
    short: allObs.find((o) => o.market === m)?.market_short || m,
  }));
  const filtered = getFilteredSortedResults(cal);
  const visible = filtered.slice(0, state.resLimit);
  const hasMore = filtered.length > state.resLimit;
  const noScoreObsCount = sum.no_score ?? allObs.filter((o) => o.is_no_score).length;
  const pendingObsCount = sum.pending ?? allObs.filter((o) => o.status === 'pending' && !o.is_no_score).length;

  const sortOptions = [
    { key: 'best', label: 'Meilleurs résultats' },
    { key: 'roi', label: 'ROI' },
    { key: 'date', label: 'Date / Score' },
    { key: 'gap', label: 'Écart Δ' },
    { key: 'brier', label: 'Précision Brier' },
    { key: 'vol', label: 'Volume BF' },
  ];

  return `
    <div class="chips" role="group" aria-label="Filtres résultats">
      <button type="button" class="chip${state.resFilter === 'all' ? ' on' : ''}" data-rf="all">Tous (${allObs.length})</button>
      <button type="button" class="chip${state.resFilter === 'signals' ? ' on' : ''}" data-rf="signals">Passés dans Signaux (${sum.signal_observations ?? 0})</button>
      <button type="button" class="chip${state.resFilter === 'settled' ? ' on' : ''}" data-rf="settled">Scorés (${sum.settled ?? 0})</button>
      <button type="button" class="chip${state.resFilter === 'won' ? ' on' : ''}" data-rf="won">Gagnés (${allObs.filter((o) => o.reco_result === 'win' || (o.reco_result == null && o.bf_top_won === true)).length})</button>
      <button type="button" class="chip${state.resFilter === 'lost' ? ' on' : ''}" data-rf="lost">Perdus (${allObs.filter((o) => o.reco_result === 'loss' || (o.reco_result == null && o.bf_top_won === false)).length})</button>
      <button type="button" class="chip${state.resFilter === 'pending' ? ' on' : ''}" data-rf="pending">En attente (${pendingObsCount})</button>
      <button type="button" class="chip${state.resFilter === 'no_score' ? ' on' : ''}" data-rf="no_score">Sans source (${noScoreObsCount})</button>
      <button type="button" class="chip${state.resFilter === 'div' ? ' on' : ''}" data-rf="div">Divergences ≥ 3 pts</button>
      ${(sum.push ?? 0) > 0 ? `<button type="button" class="chip${state.resFilter === 'push' ? ' on' : ''}" data-rf="push">Push (${sum.push})</button>` : ''}
    </div>

    ${
      uniqueMarkets.length > 1
        ? `<div class="chips" role="group" aria-label="Marchés">
            <button type="button" class="chip${state.resMarket === 'all' ? ' on' : ''}" data-rm="all">Tous marchés</button>
            ${uniqueMarkets
              .map((m) => `<button type="button" class="chip${state.resMarket === m.key ? ' on' : ''}" data-rm="${esc(m.key)}">${esc(m.short)}</button>`)
              .join('')}
          </div>`
        : ''
    }

    <div class="sig-sort-row" role="group" aria-label="Tri du tableau de score">
      <span class="sig-sort-lbl">Trier :</span>
      ${sortOptions
        .map((o) => `<button type="button" class="chip${state.resSort === o.key ? ' on' : ''}" data-rs="${o.key}">${o.label}</button>`)
        .join('')}
      <button type="button" class="chip sig-sort-dir" id="resSortDirBtn" title="Inverser l'ordre de tri" aria-label="Inverser l'ordre de tri (${state.resSortDir === 'asc' ? 'croissant' : 'décroissant'})">${state.resSortDir === 'asc' ? '↑ Croissant' : '↓ Décroissant'}</button>
    </div>

    <div class="cap-row">
      <div class="cap">Tableau de score dynamique (${filtered.length} relevé${filtered.length > 1 ? 's' : ''})</div>
    </div>
    ${renderGlobalScoreboardHtml(visible)}
    ${
      hasMore
        ? `<button type="button" class="more" id="resMoreBtn">Afficher plus (${filtered.length - state.resLimit})</button>`
        : ''
    }
  `;
}

export function renderResultsView() {
  const cal = state.calData || {};
  const sigRes = state.sigResData || {};
  const sum = cal.summary || {};
  const byMarket = cal.by_market || [];
  const byConf = (cal.by_confidence || []).filter((c) => c.count > 0);
  const bestCat = sigRes.best_category || cal.best_category || 'executable';
  const activeCat = state.resCategory === 'best' ? bestCat : state.resCategory || bestCat;
  const isCatMode = activeCat !== 'all';

  const catGridHtml = renderCategoryPerformanceGridHtml(cal, sigRes);
  const syncBtnHtml = state.isAdmin
    ? '<button type="button" class="tg-btn-sm" id="resSyncCalBtn">Synchroniser scores</button>'
    : '';

  if (state.resCatLoading) {
    const skelRows = Array.from({ length: 4 })
      .map(() => '<div class="skel-row"><div class="skel-line"></div><div class="skel-line short"></div></div>')
      .join('');
    return `
      <div class="res-head-bar">
        <div>
          <h1>Résultats des signaux</h1>
          <div class="sub tv-mb-0">Chargement dynamique du tableau de score…</div>
        </div>
        ${syncBtnHtml}
      </div>
      ${catGridHtml}
      <div class="skel">${skelRows}</div>
    `;
  }

  if (isCatMode) {
    const catSummary =
      sigRes.category_summary ||
      (sigRes.by_category || cal.by_category || []).find((c) => c.category === activeCat) ||
      {};
    const allCatRows = Array.isArray(sigRes.results) ? sigRes.results : [];
    const noScoreCount = catSummary.no_score_matches ?? allCatRows.filter((r) => r.is_no_score).length;
    const pendingCount = catSummary.pending_matches ?? allCatRows.filter((r) => r.status === 'pending' && !r.is_no_score).length;
    const scoredCount = (catSummary.settled_matches ?? 0) + (catSummary.push_matches ?? 0);

    const kpiHtml = renderResultsKpiStripHtml({
      winRatePct: catSummary.win_rate_pct,
      won: catSummary.won ?? 0,
      lost: catSummary.lost ?? 0,
      push: catSummary.push ?? 0,
      roiU: catSummary.roi_u,
      roiPct: catSummary.roi_pct,
      stakedU: catSummary.staked_u ?? 0,
      playedMatches: catSummary.played_matches ?? scoredCount + noScoreCount,
      settledMatches: catSummary.settled_matches ?? 0,
      pendingMatches: pendingCount,
      noScoreMatches: noScoreCount,
      totalMatches: catSummary.total_matches ?? allCatRows.length,
      brierBf: catSummary.brier_bf,
      brierPm: catSummary.brier_pm,
      bfWins: catSummary.bf_wins ?? 0,
      pmWins: catSummary.pm_wins ?? 0,
    });

    return `
      <div class="res-head-bar">
        <div>
          <h1>Résultats · ${esc(catSummary.label || activeCat)}${activeCat === bestCat ? ' ★' : ''}</h1>
          <div class="sub">${esc(catSummary.description || '')}${
            activeCat === bestCat ? ' · Meilleure catégorie par défaut' : ''
          }</div>
        </div>
        ${syncBtnHtml}
      </div>

      ${catGridHtml}
      ${kpiHtml}

      ${renderSearchBarHtml('resSearchInput', 'Filtrer équipe, ligue ou signal…', state.resQuery, 'Rechercher dans la catégorie', 'res')}

      <div id="resDynamicWrap">${renderResultsDynamicHtml()}</div>
      <div class="foot">Appuyez sur une ligne du tableau de score pour voir le signal donné avant coup d’envoi et le score officiel.</div>
    `;
  }

  const allObs = Array.isArray(cal.observations) ? cal.observations : [];
  const recoSettled = sum.reco_settled ?? 0;
  const recoWon = sum.reco_won ?? 0;
  const recoLost = sum.reco_lost ?? 0;
  const recoRate = sum.reco_win_rate_pct;
  const noScoreObsCount = sum.no_score ?? allObs.filter((o) => o.is_no_score).length;
  const pendingObsCount = sum.pending ?? allObs.filter((o) => o.status === 'pending' && !o.is_no_score).length;
  const playedMatches = sum.played_matches ?? sum.settled_fixtures ?? 0;

  const globalKpiHtml = renderResultsKpiStripHtml({
    winRatePct: recoRate ?? sum.bf_fav_hit_pct,
    won: recoSettled > 0 ? recoWon : sum.bf_fav_won ?? 0,
    lost: recoSettled > 0 ? recoLost : Math.max(0, (sum.fav_settled ?? 0) - (sum.bf_fav_won ?? 0)),
    push: sum.push ?? 0,
    roiU: sum.reco_roi_u,
    roiPct: sum.reco_roi_pct,
    stakedU: sum.reco_staked_u ?? 0,
    playedMatches,
    settledMatches: sum.settled_matches ?? sum.settled_fixtures ?? 0,
    pendingMatches: sum.pending_matches ?? pendingObsCount,
    noScoreMatches: sum.no_score_matches ?? noScoreObsCount,
    totalMatches: sum.total_matches ?? allObs.length,
    brierBf: sum.brier_bf,
    brierPm: sum.brier_pm,
    bfWins: sum.divergence_bf_wins ?? 0,
    pmWins: sum.divergence_pm_wins ?? 0,
  });

  return `
    <div class="res-head-bar">
      <div>
        <h1>Résultats · Toutes observations</h1>
        <div class="sub">${sum.settled ?? 0} marchés réglés (${sum.settled_fixtures ?? 0} matchs) · ${sum.total_observations ?? 0} relevés</div>
      </div>
      ${syncBtnHtml}
    </div>

    ${catGridHtml}
    ${globalKpiHtml}

    ${
      byMarket.length > 0
        ? `<div class="grid-2 tv-mb-12">
            <div>
              <div class="cap">Performance par marché</div>
              <div class="list">
                ${byMarket
                  .map(
                    (m) => `<div class="cell">
                      <span>${esc(m.label || m.short)} (${m.count})</span>
                      <b>BF ${fmtMetric4(m.brier_bf)} · PM ${fmtMetric4(m.brier_pm)}${m.bf_fav_hit_pct != null ? ` · ${m.bf_fav_hit_pct}%` : ''}</b>
                    </div>`
                  )
                  .join('')}
              </div>
            </div>
            <div>
              <div class="cap">Par niveau de confiance</div>
              <div class="list">
                ${
                  byConf.length
                    ? byConf
                        .map(
                          (c) => `<div class="cell">
                            <span>Palier ${esc(c.tier)} (${c.count})</span>
                            <b>${
                              c.reco_settled > 0 ? `${c.reco_won}/${c.reco_settled} (${c.reco_win_rate_pct} %)` : `Brier ${fmtMetric4(c.brier_bf)}`
                            }</b>
                          </div>`
                        )
                        .join('')
                    : `<div class="cell"><span>Propositions réglées</span><b>${recoWon} gagnées / ${recoLost} perdues</b></div>`
                }
              </div>
            </div>
          </div>`
        : ''
    }

    ${renderSearchBarHtml('resSearchInput', 'Filtrer équipe, ligue ou marché…', state.resQuery, 'Rechercher dans les résultats', 'res')}

    <div id="resDynamicWrap">${renderResultsDynamicHtml()}</div>
    <div class="foot">Journal horodaté avant coup d’envoi. Appuyez sur une ligne pour voir le signal émis et le relevé complet.</div>
  `;
}

/* ---- TAB 4 : CONFIGURATIONS 72 ---- */
function renderLabBars(items, total) {
  return items
    .map((it) => {
      const pct = total > 0 ? Math.round((it.count / total) * 100) : 0;
      return `<div class="bar-item">
        <div class="bar-head"><span>${esc(it.label)}</span><b>${it.count} / ${total} (${pct} %)</b></div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, pct)}%"></div></div>
      </div>`;
    })
    .join('');
}

export function renderLabMatchesDynamicHtml() {
  const cfg = state.cfgData || {};
  const rows = cfg.rows || [];
  const q = state.labQuery.trim().toLowerCase();

  let subRows = rows.filter((r) => {
    if (
      q &&
      !`${r.home} ${r.away} ${r.league} ${r.signature?.code || ''} ${r.signature?.pm_code || ''}`
        .toLowerCase()
        .includes(q)
    ) {
      return false;
    }
    if (state.labConcFilter === 'complete' && !r.signature?.is_complete) return false;
    if (state.labConcFilter === 'contradiction' && (r.axes?.concordance?.contradictions || 0) === 0) return false;
    if (state.labConcFilter === 'reversal' && !r.axes?.variation?.has_reversal) return false;
    return true;
  });

  if (state.labView === 'concordance') {
    subRows = subRows.filter(
      (r) => (r.axes?.concordance?.contradictions || 0) > 0 || (r.axes?.concordance?.convergences || 0) >= 2
    );
  } else if (state.labView === 'movements') {
    subRows = subRows.filter(
      (r) =>
        (r.axes?.variation?.amplitude_pct || 0) >= 1.5 ||
        Math.abs(r.axes?.variation?.pm_change_1d_pts ?? 0) >= 1.5
    );
  }

  subRows = subRows.slice().sort((a, b) => {
    const dir = state.labSortDir === 'asc' ? 1 : -1;
    if (state.labSort === 'contra') {
      const ac = a.axes?.concordance?.contradictions || 0;
      const bc = b.axes?.concordance?.contradictions || 0;
      if (ac !== bc) return (ac - bc) * dir;
    } else if (state.labSort === 'move') {
      const am = Math.max(a.axes?.variation?.amplitude_pct || 0, Math.abs(a.axes?.variation?.pm_change_1d_pts ?? 0));
      const bm = Math.max(b.axes?.variation?.amplitude_pct || 0, Math.abs(b.axes?.variation?.pm_change_1d_pts ?? 0));
      if (am !== bm) return (am - bm) * dir;
    } else if (state.labSort === 'vol') {
      const av = a.total_volume_bf || 0;
      const bv = b.total_volume_bf || 0;
      if (av !== bv) return (av - bv) * dir;
    } else if (state.labSort === 'time') {
      const at = kickoffTs(a.date || a.date_label);
      const bt = kickoffTs(b.date || b.date_label);
      if (at !== bt) return (at - bt) * dir;
    } else {
      if (state.labView === 'concordance') {
        const ac = a.axes?.concordance?.contradictions || 0;
        const bc = b.axes?.concordance?.contradictions || 0;
        if (ac !== bc) return (ac - bc) * dir;
      } else if (state.labView === 'movements') {
        const ar = a.axes?.variation?.has_reversal ? 1 : 0;
        const br = b.axes?.variation?.has_reversal ? 1 : 0;
        if (ar !== br) return (ar - br) * dir;
      }
      const ai = a.interest_score || 0;
      const bi = b.interest_score || 0;
      if (ai !== bi) return (ai - bi) * dir;
    }
    return (b.interest_score || 0) - (a.interest_score || 0) || (b.total_volume_bf || 0) - (a.total_volume_bf || 0);
  });

  const labSortOptions = [
    { key: 'interest', label: 'Pertinence' },
    { key: 'contra', label: 'Contradictions' },
    { key: 'move', label: 'Variation 24h' },
    { key: 'vol', label: 'Volume BF' },
    { key: 'time', label: 'Heure' },
  ];

  const vis = subRows.slice(0, state.labLimit);
  return `
    <div class="chips">
      <button type="button" class="chip${state.labConcFilter === 'all' ? ' on' : ''}" data-lcf="all">Toutes</button>
      <button type="button" class="chip${state.labConcFilter === 'complete' ? ' on' : ''}" data-lcf="complete">Complètes (72)</button>
      <button type="button" class="chip${state.labConcFilter === 'contradiction' ? ' on' : ''}" data-lcf="contradiction">Contradictions</button>
      <button type="button" class="chip${state.labConcFilter === 'reversal' ? ' on' : ''}" data-lcf="reversal">Retournements</button>
    </div>
    <div class="sig-sort-row" role="group" aria-label="Tri des configurations">
      <span class="sig-sort-lbl">Trier :</span>
      ${labSortOptions
        .map((o) => `<button type="button" class="chip${state.labSort === o.key ? ' on' : ''}" data-ls="${o.key}">${o.label}</button>`)
        .join('')}
      <button type="button" class="chip sig-sort-dir" id="labSortDirBtn" title="Inverser l'ordre de tri" aria-label="Inverser l'ordre de tri (${state.labSortDir === 'asc' ? 'croissant' : 'décroissant'})">${state.labSortDir === 'asc' ? '↑ Croissant' : '↓ Décroissant'}</button>
    </div>
    <div class="sig-legend">
      <span class="sig-leg-item"><i class="sig-dot ok"></i><b>Vert</b> Convergence</span>
      <span class="sig-leg-item"><i class="sig-dot warn"></i><b>Orange</b> Retournement / Mouv.</span>
      <span class="sig-leg-item"><i class="sig-dot bad"></i><b>Rouge</b> Contradiction</span>
      <span class="sig-leg-item"><i class="sig-dot obs"></i><b>Gris</b> Neutre</span>
      <button type="button" class="cap-link" data-open-help="1">? Lire un code</button>
    </div>
    <div class="list">
      ${
        vis.length
          ? vis
              .map((r) => {
                const locked = r.locked === true;
                const c = r.axes?.concordance || {};
                const v = r.axes?.variation || {};
                const i = r.axes?.intensity || {};
                const ko = formatKickoffCompact(r.date || r.date_label);
                const tone =
                  c.contradictions > 0 ? 'bad' : v.has_reversal || v.has_strong_move ? 'warn' : c.convergences > 0 ? 'ok' : 'obs';
                const tagTxt = locked
                  ? 'Réservé Pro'
                  : c.contradictions > 0
                  ? `${c.contradictions} contradiction(s)`
                  : v.has_reversal
                  ? 'Retournement 24h'
                  : c.convergences > 0
                  ? `${c.convergences} convergence(s)`
                  : i.label || 'Neutre';
                const rightTop = locked
                  ? 'Verrouillé'
                  : c.contradictions > 0
                  ? `${c.contradictions} contra.`
                  : v.has_reversal
                  ? 'Retournement'
                  : i.label || '—';
                const rowAria = locked
                  ? ` aria-label="${esc(r.home)} — ${esc(r.away)}, réservé Truevalue Pro"`
                  : '';
                return `<div class="row row-plain${locked ? ' lk' : ''}" data-match-key="${esc(r.fixture_key)}" data-locked="${locked ? '1' : '0'}" role="button" tabindex="0"${rowAria}>
                  <div class="mid">
                    <div class="t">${esc(r.home)} — ${esc(r.away)}</div>
                    <div class="s">${esc(r.league || '')}${ko.hm !== '—' ? ` · ${ko.hm} ${ko.day}` : ''} · <span class="sig-mono">${esc(r.signature?.code)}</span>${
                  r.signature?.pm_code ? ` × <span class="sig-mono">PM ${esc(r.signature.pm_code)}</span>` : ''
                }</div>
                    <div class="sig-badge-row">
                      <span class="sig-type-tag ${tone}">${esc(tagTxt)}</span>
                      <span class="sig-action-txt">${esc(v.label || 'Stable')}${v.drop_pct != null ? ` (${fmtSignedPct(v.drop_pct)})` : ''}</span>
                    </div>
                    <div class="sig-takeaway">${r.markets_count} marchés · Intensité ${esc(i.label || '—')}</div>
                  </div>
                  ${
                    locked
                      ? `<span class="lk-pill" aria-hidden="true">🔒 Pro</span>`
                      : `<div class="r"><b class="${tone === 'ok' ? 'pos' : tone === 'warn' ? 'warn' : tone === 'bad' ? 'neg' : ''}">${esc(rightTop)}</b><span class="muted">${fmtEur(r.total_volume_bf)}</span></div>`
                  }
                </div>`;
              })
              .join('')
          : renderEmptyWithResetHtml('Aucun match ne correspond à ces critères.', 'lab')
      }
    </div>
    ${
      subRows.length > state.labLimit
        ? `<button type="button" class="more" id="labMoreBtn">Afficher plus (${subRows.length - state.labLimit})</button>`
        : ''
    }
  `;
}

export function renderLabBodyHtml() {
  const cfg = state.cfgData || {};
  const sum = cfg.summary || {};
  const total = sum.total_fixtures || 0;
  const th = cfg.thresholds || {};
  const rows = cfg.rows || [];

  const thPanel = state.labShowThresholds
    ? `<form class="tg-form-panel" id="labThForm" novalidate>
        <div class="tg-form-grid">
          <label class="tg-field"><span>Équilibre max (pts)</span><input id="thEquil" type="number" step="0.5" min="1" max="20" value="${esc(th.equilibreMaxPp ?? 4)}" /></label>
          <label class="tg-field"><span>Modérée max (pts)</span><input id="thMod" type="number" step="1" min="5" max="60" value="${esc(th.modereeMaxPp ?? 24)}" /></label>
          <label class="tg-field"><span>Forte max (pts)</span><input id="thForte" type="number" step="1" min="10" max="80" value="${esc(th.forteMaxPp ?? 40)}" /></label>
          <label class="tg-field"><span>Stable max (%)</span><input id="thStable" type="number" step="0.5" min="0.5" max="10" value="${esc(th.stableMaxPct ?? 1.5)}" /></label>
          <label class="tg-field"><span>Forte var. (%)</span><input id="thStrong" type="number" step="0.5" min="1" max="25" value="${esc(th.strongMovePct ?? 5)}" /></label>
          <div class="tg-btn-row tv-col-span-all">
            <button type="submit" class="tg-btn-sm">Appliquer</button>
            <button type="button" class="tg-btn-sm alt" id="labThResetBtn">Défaut</button>
          </div>
        </div>
        <div id="labFormError" class="tv-inline-err" role="alert" hidden></div>
      </form>`
    : '';

  let bodyHtml = '';

  if (state.labView === 'overview') {
    const cov = sum.block_coverage || {};
    const gd = sum.goals_distribution || {};
    const top72 = (cfg.catalog_72 || []).filter((s) => s.count > 0).slice(0, 10);
    const topRows = rows
      .slice()
      .sort((a, b) => (b.interest_score || 0) - (a.interest_score || 0) || (b.total_volume_bf || 0) - (a.total_volume_bf || 0))
      .slice(0, 5);

    bodyHtml = `
      <div class="big big-4">
        <div class="box"><b>${total}</b><span>Matchs analysés (${sum.pm_matched_fixtures ?? 0} sur Polymarket)</span></div>
        <div class="box"><b>${sum.complete_signatures ?? 0} / ${sum.partial_signatures ?? 0}</b><span>Complètes (72) / Partielles (?)</span></div>
        <div class="box"><b>${sum.axes_counts?.convergences ?? 0} / ${sum.axes_counts?.contradictions ?? 0}</b><span>Convergences / Contradictions</span></div>
        <div class="box"><b>${sum.axes_counts?.strong_moves ?? 0} / ${sum.axes_counts?.reversals ?? 0}</b><span>Mouvements forts / Retournements</span></div>
      </div>

      <div class="cap-row">
        <div class="cap">Matchs les plus intéressants (classés par pertinence)</div>
        <div class="cap-actions">
          <button type="button" class="cap-link" data-lv="matches">Tout voir (${rows.length}) ›</button>
        </div>
      </div>
      <div class="list">
        ${
          topRows.length
            ? topRows
                .map((r) => {
                  const locked = r.locked === true;
                  const c = r.axes?.concordance || {};
                  const v = r.axes?.variation || {};
                  const ko = formatKickoffCompact(r.date || r.date_label);
                  const tone =
                    c.contradictions > 0 ? 'bad' : v.has_reversal || v.has_strong_move ? 'warn' : c.convergences > 0 ? 'ok' : 'obs';
                  const tagTxt = locked
                    ? 'Réservé Pro'
                    : c.contradictions > 0
                    ? `${c.contradictions} contradiction(s)`
                    : v.has_reversal
                    ? 'Retournement 24h'
                    : c.convergences > 0
                    ? `${c.convergences} convergence(s)`
                    : r.pm_matched
                    ? 'Betfair × Polymarket'
                    : r.axes?.intensity?.label || 'Neutre';
                  const rightTop = locked
                    ? 'Verrouillé'
                    : c.contradictions > 0
                    ? `${c.contradictions} contra.`
                    : v.has_reversal
                    ? 'Retournement'
                    : r.max_exec_edge_pp != null && r.max_exec_edge_pp > 0
                    ? `+${r.max_exec_edge_pp.toFixed(1)} pts`
                    : r.axes?.intensity?.label || '—';
                  const rowAria = locked
                    ? ` aria-label="${esc(r.home)} — ${esc(r.away)}, réservé Truevalue Pro"`
                    : '';
                  return `<div class="row row-plain${locked ? ' lk' : ''}" data-match-key="${esc(r.fixture_key)}" data-locked="${locked ? '1' : '0'}" role="button" tabindex="0"${rowAria}>
                    <div class="mid">
                      <div class="t">${esc(r.home)} — ${esc(r.away)}</div>
                      <div class="s">${esc(r.league || '')}${ko.hm !== '—' ? ` · ${ko.hm} ${ko.day}` : ''} · <span class="sig-mono">${esc(r.signature?.code)}</span>${
                    r.signature?.pm_code ? ` × <span class="sig-mono">PM ${esc(r.signature.pm_code)}</span>` : ''
                  }</div>
                      <div class="sig-badge-row">
                        <span class="sig-type-tag ${tone}">${esc(tagTxt)}</span>
                        <span class="sig-action-txt">${esc(v.label || 'Stable')}${v.drop_pct != null ? ` (${fmtSignedPct(v.drop_pct)})` : ''}</span>
                      </div>
                    </div>
                    ${
                      locked
                        ? `<span class="lk-pill" aria-hidden="true">🔒 Pro</span>`
                        : `<div class="r"><b class="${tone === 'ok' ? 'pos' : tone === 'warn' ? 'warn' : tone === 'bad' ? 'neg' : ''}">${esc(rightTop)}</b><span class="muted">${fmtEur(r.total_volume_bf)}</span></div>`
                    }
                  </div>`;
                })
                .join('')
            : `<div class="empty">Aucun match analysé pour le moment.</div>`
        }
      </div>

      <div class="grid-2">
        <div>
          <div class="cap">Couverture des 4 blocs (sans valeurs inventées)</div>
          <div class="list">
            ${renderLabBars(
              [
                { label: '1X2 Temps réglementaire (FT)', count: cov.one_x_two || 0 },
                { label: 'BTTS (Les 2 équipes marquent)', count: cov.btts || 0 },
                { label: 'Résultat Mi-temps (HT 1X2)', count: cov.half_time || 0 },
                { label: 'Profil buts complet (G1–G4)', count: cov.goals_profile || 0 },
              ],
              total
            )}
          </div>
        </div>
        <div>
          <div class="cap">Profils de buts (G1–G4)</div>
          <div class="list">
            ${renderLabBars(
              [
                { label: 'G1 · Très faible (U1.5 / U2.5 / U3.5)', count: gd.G1 || 0 },
                { label: 'G2 · Modéré faible (O1.5 / U2.5 / U3.5)', count: gd.G2 || 0 },
                { label: 'G3 · Ouvert actif (O1.5 / O2.5 / U3.5)', count: gd.G3 || 0 },
                { label: 'G4 · Très offensif (O1.5 / O2.5 / O3.5)', count: gd.G4 || 0 },
                { label: 'Incomplet (< 3 lignes O/U) ou atypique', count: (gd.incomplet || 0) + (gd.atypique || 0) },
              ],
              total
            )}
          </div>
        </div>
      </div>

      <div class="cap">Signatures actives les plus informatives (cliquer pour filtrer)</div>
      <div class="list">
        ${
          top72.length
            ? top72
                .map(
                  (s) => `<div class="row row-plain" data-pick-sig="${esc(s.code)}" role="button" tabindex="0">
                    <div class="mid">
                      <div class="t sig-mono">${esc(s.code)}</div>
                      <div class="s">Intensité ${esc(s.dominant_intensity)} · PM ${s.pm_matched} · Vol. moy. ${fmtEur(s.avg_volume_bf)} · ${s.contradictions} contradiction(s)</div>
                    </div>
                    <div class="r"><b>n=${s.count}</b><span class="muted">${s.share_pct} %</span></div>
                  </div>`
                )
                .join('')
            : `<div class="empty">Aucune signature complète (4 blocs) sur cet instantané ; consultez les partielles (?) dans « 72 signatures ».</div>`
        }
      </div>
    `;
  } else if (state.labView === 'catalog') {
    const list72 = state.labShowAll72 ? cfg.catalog_72 || [] : (cfg.catalog_72 || []).filter((s) => s.count > 0);
    const partials = cfg.partial_signatures || [];

    bodyHtml = `
      <div class="chips">
        <button type="button" class="chip${!state.labShowAll72 ? ' on' : ''}" id="lab72ActiveBtn">Actives (${sum.unique_complete_signatures ?? 0} / 72)</button>
        <button type="button" class="chip${state.labShowAll72 ? ' on' : ''}" id="lab72AllBtn">Catalogue complet (72)</button>
      </div>
      <div class="list">
        ${
          list72.length
            ? list72
                .map(
                  (s) => `<div class="row row-plain" data-pick-sig="${esc(s.code)}" role="button" tabindex="0">
                    <div class="mid">
                      <div class="t sig-mono">${esc(s.code)}</div>
                      <div class="s">${esc(s.dominant_intensity)} · PM ${s.pm_matched} · ${esc(
                        s.sample_warning || (s.count === 0 ? 'Non observée' : 'Échantillon OK')
                      )}</div>
                    </div>
                    <div class="r"><b>n=${s.count}</b><span class="muted">${s.share_pct} %</span></div>
                  </div>`
                )
                .join('')
            : `<div class="empty">Aucune signature complète active.</div>`
        }
      </div>
      <div class="cap">Signatures partielles (blocs manquants marqués ?)</div>
      <div class="list">
        ${partials
          .slice(0, 30)
          .map(
            (p) => `<div class="row row-plain" data-pick-sig="${esc(p.code)}" role="button" tabindex="0">
              <div class="mid">
                <div class="t sig-mono">${esc(p.code)}</div>
                <div class="s">${p.blocks_present}/4 blocs · PM ${p.pm_matched} · Vol. moy. ${fmtEur(p.avg_volume_bf)}</div>
              </div>
              <div class="r"><b>n=${p.count}</b><span class="muted">${p.share_pct} %</span></div>
            </div>`
          )
          .join('')}
      </div>
    `;
  } else if (state.labView === 'compare_sigs') {
    const buckets = [
      ...(cfg.catalog_72 || []).filter((s) => s.count > 0),
      ...(cfg.partial_signatures || []).slice(0, 20).map((p) => ({ ...p, dominant_intensity: 'Partiel' })),
    ];
    if (!state.labSigA && buckets[0]) state.labSigA = buckets[0].code;
    if (!state.labSigB && (buckets[1] || buckets[0])) state.labSigB = (buckets[1] || buckets[0]).code;
    const sigA = buckets.find((b) => b.code === state.labSigA) || buckets[0];
    const sigB = buckets.find((b) => b.code === state.labSigB) || buckets[0];

    const opts = (sel) =>
      buckets
        .map((b) => `<option value="${esc(b.code)}" ${b.code === sel ? 'selected' : ''}>${esc(b.code)} (n=${b.count})</option>`)
        .join('');

    bodyHtml =
      sigA && sigB
        ? `<div class="tg-form-panel">
            <div class="tg-form-grid">
              <label class="tg-field"><span>Signature A</span><select id="labSelectA" class="tg-select">${opts(sigA.code)}</select></label>
              <label class="tg-field"><span>Signature B</span><select id="labSelectB" class="tg-select">${opts(sigB.code)}</select></label>
            </div>
          </div>
          <div class="list">
            <div class="cell"><span>Effectif observé (A / B)</span><b>${sigA.count} (${sigA.share_pct}%) / ${sigB.count} (${sigB.share_pct}%)</b></div>
            <div class="cell"><span>Matchs appariés Polymarket</span><b>${sigA.pm_matched} / ${sigB.pm_matched}</b></div>
            <div class="cell"><span>Volume BF moyen</span><b>${fmtEur(sigA.avg_volume_bf)} / ${fmtEur(sigB.avg_volume_bf)}</b></div>
            <div class="cell"><span>Contradictions détectées</span><b>${sigA.contradictions} / ${sigB.contradictions}</b></div>
            <div class="cell"><span>Intensité dominante</span><b>${esc(sigA.dominant_intensity)} / ${esc(sigB.dominant_intensity)}</b></div>
            <div class="cell"><span>Échantillon</span><b>${sigA.count < 30 ? 'n < 30' : '≥ 30'} / ${sigB.count < 30 ? 'n < 30' : '≥ 30'}</b></div>
          </div>`
        : `<div class="empty">Pas assez de données pour comparer.</div>`;
  } else {
    bodyHtml = `<div id="labMatchesDynamicWrap">${renderLabMatchesDynamicHtml()}</div>`;
  }

  return `
    <div class="chips" role="group" aria-label="Sous-vues Configs 72">
      <button type="button" class="chip${state.labView === 'overview' ? ' on' : ''}" data-lv="overview">Vue générale</button>
      <button type="button" class="chip${state.labView === 'matches' ? ' on' : ''}" data-lv="matches">Matchs &amp; 4 axes</button>
      <button type="button" class="chip${state.labView === 'catalog' ? ' on' : ''}" data-lv="catalog">72 signatures</button>
      <button type="button" class="chip${state.labView === 'concordance' ? ' on' : ''}" data-lv="concordance">Contradictions</button>
      <button type="button" class="chip${state.labView === 'movements' ? ' on' : ''}" data-lv="movements">Mouvements</button>
      <button type="button" class="chip${state.labView === 'compare_sigs' ? ' on' : ''}" data-lv="compare_sigs">Comparateur</button>
      <button type="button" class="chip${state.labShowThresholds ? ' on' : ''}" id="labToggleThBtn">⚙ Seuils</button>
    </div>

    ${thPanel}
    ${bodyHtml}
  `;
}

export function renderLabView() {
  const cfg = state.cfgData || {};
  const sum = cfg.summary || {};
  const total = sum.total_fixtures || 0;

  return `
    <h1>Configs 72</h1>
    <div class="sub">${total} matchs · ${sum.unique_complete_signatures ?? 0} / 72 signatures complètes actives · 4 axes</div>

    <div class="tv-decode-bar">
      <span>Lecture code : <b>1X2 | BTTS | Mi-temps | Buts (G1–G4)</b></span>
      <span>« <b>?</b> » = marché non coté</span>
      <button type="button" class="cap-link" data-open-help="1">? Aide</button>
    </div>

    ${renderSearchBarHtml('labSearchInput', 'Filtrer équipe ou signature (ex. 1 | Oui)…', state.labQuery, 'Filtrer les configurations', 'lab')}
    <div id="labBodyWrap">${renderLabBodyHtml()}</div>
    <div class="foot">Retrait de marge multiplicatif, blocs manquants marqués « ? », variations mesurées ouverture → actuel (+24h Polymarket).</div>
  `;
}
