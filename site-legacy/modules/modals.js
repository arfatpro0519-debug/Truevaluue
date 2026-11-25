// Modales, fiches détaillées, menu compte/admin, facturation Telegram Stars et inspecteur sources.

import { state, TABS } from './state.js';
import {
  $,
  apiGet,
  apiPost,
  closeAllSheets,
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
  getTg,
  hap,
  openDetailSheet,
  openProSheet,
  safeHttpsUrl,
  toast,
  translateApiError,
} from './utils.js';

export function buildMergedMatches() {
  const cfgRows = state.cfgData?.rows || [];
  const cmpByKey = new Map();
  for (const c of state.cmpData?.rows || []) {
    cmpByKey.set(c.fixture_key, c);
  }
  return cfgRows.map((cfg) => {
    const cmp = cmpByKey.get(cfg.fixture_key) || null;
    const m1x2 = (cfg.markets || []).find((m) => m.market === '1x2') || cfg.markets?.[0] || null;
    const sides = m1x2?.sides || [];
    const o1 = sides.find((s) => s.label === '1')?.odds;
    const ox = sides.find((s) => s.label === 'X' || s.label === 'N')?.odds;
    const o2 = sides.find((s) => s.label === '2')?.odds;
    return {
      ...cfg,
      cmp,
      odds_1x2: [o1, ox, o2],
      max_abs_gap_pp: cmp?.max_abs_gap_pp ?? cfg.max_abs_gap_pp ?? null,
      max_exec_edge_pp: cmp?.max_exec_edge_pp ?? cfg.max_exec_edge_pp ?? null,
    };
  });
}

export function collectCompareProposalGroups() {
  const rows = state.cmpData?.rows || [];
  const groups = [];
  for (const r of rows) {
    const recs = Array.isArray(r.recommendations) ? r.recommendations : [];
    if (recs.length === 0) continue;
    groups.push({
      fixture_key: r.fixture_key,
      home: r.home,
      away: r.away,
      league: r.league,
      country: r.country,
      date: r.date,
      date_label: r.date_label,
      pm_url: r.pm_url,
      total_volume_bf: r.total_volume_bf,
      primary: recs[0],
      secondary: recs[1] || null,
      recommendations: recs,
    });
  }
  groups.sort(
    (a, b) =>
      b.primary.tier_rank - a.primary.tier_rank ||
      (b.primary.market_priority || 1) - (a.primary.market_priority || 1) ||
      b.primary.net_edge_pp - a.primary.net_edge_pp ||
      b.primary.bf_volume - a.primary.bf_volume
  );
  return groups;
}

export function renderCmpMarketsHtml(cmp, options = {}) {
  if (!cmp || !Array.isArray(cmp.markets) || cmp.markets.length === 0) return '';
  const { showHeader = true, maxMarkets = 99 } = options;
  const mkts = cmp.markets.slice(0, maxMarkets);
  let html = showHeader
    ? `<div class="cap">Comparateur Betfair × Polymarket (${cmp.markets.length} marché(s))</div>`
    : '';
  for (const m of mkts) {
    const rowsHtml = (m.sides || [])
      .slice(0, 8)
      .map((s) => {
        const gapCls = s.abs_gap_pp >= 3 ? (s.gap_pp > 0 ? 'pos' : 'neg') : '';
        const bfStr =
          s.bf_pct != null ? `${s.bf_pct.toFixed(1)}%${s.bf_odds ? ` (${s.bf_odds.toFixed(2)})` : ''}` : '—';
        const pmStr =
          s.pm_pct != null
            ? `${s.pm_pct.toFixed(1)}%${
                s.pm_bid != null && s.pm_ask != null ? ` ${s.pm_bid.toFixed(2)}/${s.pm_ask.toFixed(2)}` : ''
              }`
            : '—';
        return `<tr>
          <td><strong>${esc(s.label)}</strong></td>
          <td class="num">${esc(bfStr)}</td>
          <td class="num">${esc(pmStr)}</td>
          <td class="num ${gapCls}">${esc(fmtGap(s.gap_pp))}</td>
        </tr>`;
      })
      .join('');
    html += `<div class="list">
      <div class="cell"><span>${esc(m.label)}</span><b>${esc(fmtEur(m.bf_volume))}${
        m.pm_spread_pts != null ? ` · spread ${m.pm_spread_pts.toFixed(1)}` : ''
      }</b></div>
      <div class="tv-scroll-x">
        <table class="sheet-table">
          <thead><tr><th>Issue</th><th>Betfair</th><th>Polymarket</th><th>Écart Δ</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </div>`;
  }
  return html;
}

export function signalHistoryToneMeta(rec) {
  if (rec.status === 'pending' && rec.is_no_score) {
    return {
      tone: 'warn',
      ringCls: ' warn',
      ringMain: '—',
      ringSub: 'SANS SRC',
      tag: 'Sans source score',
    };
  }
  if (rec.status === 'pending') {
    return {
      tone: 'obs',
      ringCls: ' obs',
      ringMain: '⏳',
      ringSub: 'ATT.',
      tag: 'En attente',
    };
  }
  const scoreTxt = rec.home_score != null && rec.away_score != null ? `${rec.home_score}-${rec.away_score}` : 'FT';
  const srcShort = rec.result_source === 'espn' ? 'ESPN' : rec.result_source === 'sportscore' ? 'SS' : 'FIN';
  if (rec.status === 'push' || rec.match_outcome === 'push') {
    return {
      tone: 'info',
      ringCls: ' info',
      ringMain: rec.home_score != null ? scoreTxt : 'PUSH',
      ringSub: 'PUSH',
      tag: 'Remboursé (Push)',
    };
  }
  if (rec.match_outcome === 'win') {
    return { tone: 'ok', ringCls: '', ringMain: scoreTxt, ringSub: srcShort, tag: 'Signal gagné' };
  }
  if (rec.match_outcome === 'loss') {
    return { tone: 'bad', ringCls: ' bad', ringMain: scoreTxt, ringSub: srcShort, tag: 'Signal perdu' };
  }
  if (rec.match_outcome === 'mixed') {
    return { tone: 'warn', ringCls: ' warn', ringMain: scoreTxt, ringSub: srcShort, tag: 'Partiel (G/P)' };
  }
  return { tone: 'ok', ringCls: '', ringMain: scoreTxt, ringSub: srcShort, tag: 'Score publié' };
}

export function resultToneMeta(obs) {
  if (obs.status === 'pending' && obs.is_no_score) {
    return {
      tone: 'warn',
      ringCls: ' warn',
      ringMain: '—',
      ringSub: 'SANS SRC',
      tag: 'Sans source score',
    };
  }
  if (obs.status === 'pending') {
    return {
      tone: 'obs',
      ringCls: ' obs',
      ringMain: '⏳',
      ringSub: 'ATT.',
      tag: 'En attente',
    };
  }
  if (obs.status === 'push') {
    return {
      tone: 'info',
      ringCls: ' info',
      ringMain: obs.home_score != null ? `${obs.home_score}-${obs.away_score}` : 'PUSH',
      ringSub: 'PUSH',
      tag: 'Remboursé (Push)',
    };
  }
  const scoreTxt = obs.home_score != null && obs.away_score != null ? `${obs.home_score}-${obs.away_score}` : 'FT';
  const srcShort = obs.result_source === 'espn' ? 'ESPN' : obs.result_source === 'sportscore' ? 'SS' : 'FIN';
  if (obs.reco_result === 'win') {
    return { tone: 'ok', ringCls: '', ringMain: scoreTxt, ringSub: srcShort, tag: 'Signal gagné' };
  }
  if (obs.reco_result === 'loss') {
    return { tone: 'bad', ringCls: ' bad', ringMain: scoreTxt, ringSub: srcShort, tag: 'Signal perdu' };
  }
  if (obs.bf_top_won === true) {
    return { tone: 'ok', ringCls: '', ringMain: scoreTxt, ringSub: srcShort, tag: 'Favori validé' };
  }
  if (obs.bf_top_won === false) {
    return { tone: 'bad', ringCls: ' bad', ringMain: scoreTxt, ringSub: srcShort, tag: 'Surprise / Perdu' };
  }
  return { tone: 'obs', ringCls: ' obs', ringMain: scoreTxt, ringSub: srcShort, tag: 'Réglé' };
}

function formatSignalOutcomeBadgeHtml(s, matchStatus) {
  if (s.signal_result === 'no_score') {
    return '<b class="warn">Sans source</b>';
  }
  if (matchStatus === 'pending' || s.signal_result === 'pending') {
    return '<b class="muted">En attente</b>';
  }
  if (s.signal_result === 'win') {
    return `<b class="pos">Gagné${s.pnl_u != null ? ` (+${s.pnl_u.toFixed(2)} u)` : ''}</b>`;
  }
  if (s.signal_result === 'loss') {
    return `<b class="neg">Perdu${s.pnl_u != null ? ` (${s.pnl_u.toFixed(2)} u)` : ''}</b>`;
  }
  if (s.signal_result === 'push') {
    return `<b class="info">Remboursé${s.pnl_u != null ? ' (0.00 u)' : ''}</b>`;
  }
  if (s.better_source) {
    const srcWin =
      s.better_source === 'betfair'
        ? '<span class="pos">BF plus juste</span>'
        : s.better_source === 'polymarket'
        ? '<span class="info">PM plus juste</span>'
        : '<span>Égalité BF/PM</span>';
    const issueTxt =
      Array.isArray(s.winning_labels) && s.winning_labels.length > 0
        ? `<span class="muted">${esc(s.winning_labels.join(' · '))}</span>`
        : '';
    return `<b>${srcWin}</b>${issueTxt}`;
  }
  if (Array.isArray(s.winning_labels) && s.winning_labels.length > 0) {
    return `<b>Issue : ${esc(s.winning_labels.join(' / '))}</b>`;
  }
  return '<b class="muted">Réglé</b>';
}

function renderEmittedSignalsSectionHtml(signals, fallbackRec = null, matchStatus = 'pending', fallbackResult = null) {
  let list = Array.isArray(signals) ? signals : [];
  if (list.length === 0 && fallbackRec) {
    list = [
      {
        category: 'executable',
        category_label: 'Proposition BF×PM',
        title: `Proposition : ${fallbackRec.action || fallbackRec.side_label}`,
        action: fallbackRec.action || fallbackRec.side_label,
        tier_label: fallbackRec.tier_label,
        prop_odds: fallbackRec.prop_odds ?? null,
        net_edge_pp: fallbackRec.net_edge_pp ?? null,
        signal_result:
          matchStatus === 'pending'
            ? 'pending'
            : matchStatus === 'push'
            ? 'push'
            : fallbackResult?.reco_result || 'settled',
        pnl_u: fallbackResult?.reco_pnl_u ?? null,
        winning_labels: fallbackResult?.winning_labels || [],
      },
    ];
  }

  if (list.length === 0) {
    return `<div class="cap">Signal émis avant coup d’envoi</div>
      <div class="list"><div class="note tv-no-border">Aucun signal émis avant coup d’envoi — match suivi en référence Betfair × Polymarket.</div></div>`;
  }

  const rowsHtml = list
    .map((s) => {
      const subParts = [
        s.category_label,
        s.market_short,
        s.tier_label,
        s.prop_odds ? `@${fmtOdds(s.prop_odds)}` : '',
        typeof s.net_edge_pp === 'number' ? `Edge ${fmtNetEdge(s.net_edge_pp)}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const winLine =
        matchStatus === 'settled' && Array.isArray(s.winning_labels) && s.winning_labels.length > 0
          ? ` · Issue constatée : ${s.winning_labels.join(' / ')}`
          : '';

      return `<div class="row row-plain tv-row-static">
        <div class="mid">
          <div class="t">${esc(s.action ? `Proposition : ${s.action}` : s.title)}</div>
          <div class="s tv-sub-wrap">${esc(subParts)}${s.detail ? ` — ${esc(s.detail)}` : ''}${esc(winLine)}</div>
        </div>
        <div class="r">${formatSignalOutcomeBadgeHtml(s, matchStatus)}</div>
      </div>`;
    })
    .join('');

  return `<div class="cap">Signal(s) donné(s) avant coup d’envoi &amp; Résultat (${list.length})</div>
    <div class="list">${rowsHtml}</div>`;
}

function renderFrozenSnapshotsHtml(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) return '';
  let html = `<div class="cap">Relevé pré-match figé Betfair × Polymarket (${snapshots.length} marché${snapshots.length > 1 ? 's' : ''})</div>`;
  for (const m of snapshots) {
    if (!Array.isArray(m.sides) || m.sides.length === 0) continue;
    const rowsHtml = m.sides
      .map((s) => {
        const isWin = Array.isArray(m.winning_labels) && m.winning_labels.includes(s.label);
        const gapCls = Math.abs(s.gap_pp || 0) >= 3 ? (s.gap_pp > 0 ? 'pos' : 'neg') : '';
        return `<tr>
          <td><strong>${esc(s.label)}</strong>${isWin ? ' <span class="pos">✓</span>' : ''}</td>
          <td class="num">${fmtPct(s.bf_pct)}</td>
          <td class="num">${fmtPct(s.pm_pct)}</td>
          <td class="num ${gapCls}">${fmtGap(s.gap_pp)}</td>
        </tr>`;
      })
      .join('');
    const brierStr =
      typeof m.brier_bf === 'number' && typeof m.brier_pm === 'number'
        ? `Brier BF ${m.brier_bf.toFixed(3)} / PM ${m.brier_pm.toFixed(3)}`
        : 'En attente';
    html += `<div class="list">
      <div class="cell"><span>${esc(m.market_label || m.market_short)}</span><b>${esc(brierStr)}</b></div>
      <div class="tv-scroll-x"><table class="sheet-table">
        <thead><tr><th>Issue</th><th>Betfair</th><th>Polymarket</th><th>Écart Δ</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table></div>
    </div>`;
  }
  return html;
}

export function openProposalDetailSheet(group) {
  if (!group || !group.primary) return;
  const rec = group.primary;
  const dispProb = rec.prop_pct ?? rec.pm_exec_pct;
  const dispBfProb = rec.bf_prop_pct ?? rec.bf_pct;
  const dispOdds = rec.prop_odds ?? rec.pm_exec_odds;
  const dispBfOdds = rec.bf_prop_odds ?? rec.bf_odds;
  const evDisplay = rec.ev_net_pct != null
    ? ` · EV nette ${rec.ev_net_pct > 0 ? '+' : ''}${rec.ev_net_pct.toFixed(1)} % (brute ${rec.ev_pct > 0 ? '+' : ''}${rec.ev_pct.toFixed(1)} %)`
    : rec.ev_pct != null
    ? ` · EV ${rec.ev_pct > 0 ? '+' : ''}${rec.ev_pct.toFixed(1)} %`
    : '';
  const safePm = safeHttpsUrl(group.pm_url);

  let html = `<div class="list">
    <div class="cell"><span>Proposition</span><b class="prop-detail-val">${esc(rec.action)}</b></div>
    <div class="cell"><span>Marché</span><b>${esc(rec.market_label || rec.market_short)}</b></div>
    <div class="cell"><span>Niveau de confiance</span><b class="${rec.tier === 'high' ? 'pos' : rec.tier === 'moderate' ? '' : 'warn'}">${esc(rec.tier_label)}</b></div>
    <div class="cell"><span>Probabilité Betfair / Carnet</span><b>${fmtPct(dispBfProb)} / ${fmtPct(dispProb)}</b></div>
    <div class="cell"><span>Cote estimée</span><b>${fmtOdds(dispOdds)} (BF ${fmtOdds(dispBfOdds)})</b></div>
    <div class="cell"><span>Écart net / EV estimée</span><b class="${edgeClass(rec.net_edge_pp)}">${esc(fmtNetEdge(rec.net_edge_pp))}${esc(evDisplay)}</b></div>
    <div class="cell"><span>Volume BF / Liquidité</span><b>${esc(fmtEur(rec.bf_volume))} / ${esc(fmtUsd(rec.pm_liquidity))}${rec.pm_liquidity_warning ? ' <span class="tv-liq-warn">(Carnet fin)</span>' : ''}</b></div>
  </div>`;

  const extraRecs = (group.recommendations || []).slice(1);
  if (extraRecs.length > 0) {
    html += `<div class="cap">Propositions secondaires (${extraRecs.length})</div><div class="list">`;
    extraRecs.forEach((sec, idx) => {
      const rank = sec.proposal_rank || idx + 2;
      const secOdds = sec.prop_odds ?? sec.pm_exec_odds;
      const secEv = sec.ev_net_pct ?? sec.ev_pct;
      html += `<div class="row row-plain tv-row-static">
        <div class="mid">
          <div class="t prop-call-text">${rank}e proposition : ${esc(sec.action)}</div>
          <div class="s">${esc(sec.market_label || sec.market_short)} · ${esc(sec.tier_label)} · Cote ${fmtOdds(secOdds)}</div>
        </div>
        <div class="r"><b class="${edgeClass(sec.net_edge_pp)}">${esc(fmtNetEdge(sec.net_edge_pp))}</b><span>${
          secEv != null ? `EV ${secEv > 0 ? '+' : ''}${secEv.toFixed(1)}%` : ''
        }</span></div>
      </div>`;
    });
    html += `</div>`;
  }

  if (Array.isArray(rec.criteria) && rec.criteria.length > 0) {
    html += `<div class="cap">Audit des 6 critères (Proposition 1)</div><div class="list">`;
    for (const cr of rec.criteria) {
      html += `<div class="cell">
        <span>${esc(cr.label)}</span>
        <b class="${cr.ok ? 'pos' : 'warn'}">${cr.ok ? 'Élevé' : 'Minimal'} · ${esc(cr.detail)}</b>
      </div>`;
    }
    html += `</div>`;
  }

  html += `<div class="tv-btn-stack">`;
  if (safePm) {
    html += `<a class="main tv-full-link" href="${esc(
      safePm
    )}" target="_blank" rel="noopener noreferrer">Voir le marché sur Polymarket ↗</a>`;
  }
  html += `<button type="button" class="sec-btn" data-match-key="${esc(group.fixture_key)}" data-push-sheet="1">Ouvrir la fiche complète du match</button></div>`;

  openDetailSheet(
    `${group.home} — ${group.away}`,
    `${group.league || ''} · ${group.date_label || ''}`,
    html
  );
}

export function openMatchDetailSheet(fixtureKey, pushHistory = false) {
  const merged = buildMergedMatches();
  const item = merged.find((m) => m.fixture_key === fixtureKey);
  if (!item) return;

  const cmp = item.cmp;
  const sig = item.signature || {};
  const axes = item.axes || {};
  const conc = axes.concordance || {};
  const vari = axes.variation || {};
  const safePm = safeHttpsUrl(item.pm_url);

  let html = `<div class="list">
    <div class="cell"><span>Compétition</span><b>${esc(item.league || '—')}</b></div>
    <div class="cell"><span>Coup d’envoi</span><b>${esc(item.date_label || item.date || '—')}</b></div>
    <div class="cell"><span>Volume Betfair</span><b>${esc(fmtEur(item.total_volume_bf))}</b></div>
    <div class="cell"><span>Liquidité Polymarket</span><b>${item.pm_matched ? esc(fmtUsd(item.pm_liquidity)) : 'Non apparié'}</b></div>
    <div class="cell"><span>Signature (72)</span><b class="sig-mono">${esc(sig.code || '?')}</b></div>
    ${
      sig.pm_code
        ? `<div class="cell"><span>Signature Polymarket</span><b class="sig-mono">${esc(sig.pm_code)}</b></div>`
        : ''
    }
    <div class="cell"><span>Intensité · Variation</span><b>${esc(axes.intensity?.label || '—')} · ${esc(vari.label || 'Stable')}</b></div>
  </div>`;

  if (state.showProposals && cmp) {
    if (Array.isArray(cmp.recommendations) && cmp.recommendations.length > 0) {
      html += `<div class="cap">Propositions retenues (${cmp.recommendations.length})</div><div class="list">`;
      cmp.recommendations.forEach((rec, idx) => {
        const rank = rec.proposal_rank || idx + 1;
        const prefix = rank > 1 ? `${rank}e proposition` : 'Proposition';
        const evVal = rec.ev_net_pct ?? rec.ev_pct;
        html += `<div class="row row-plain tv-row-static">
          <div class="mid">
            <div class="t prop-call-text">${prefix} : ${esc(rec.action)}</div>
            <div class="s">${esc(rec.tier_label)} · Cote ${fmtOdds(rec.prop_odds ?? rec.pm_exec_odds)} · ${esc(fmtEur(rec.bf_volume))}</div>
          </div>
          <div class="r"><b class="${edgeClass(rec.net_edge_pp)}">${esc(fmtNetEdge(rec.net_edge_pp))}</b><span>${
            evVal != null ? `EV nette ${evVal > 0 ? '+' : ''}${evVal.toFixed(1)}%` : ''
          }</span></div>
        </div>`;
      });
      html += `</div>`;
    } else if (cmp.rejection_summary) {
      html += `<div class="cap">Proposition</div><div class="list"><div class="note tv-no-border">${esc(
        cmp.rejection_summary
      )}</div></div>`;
    }
  }

  if (safePm) {
    html += `<a class="main tv-full-link tv-mt-8" href="${esc(
      safePm
    )}" target="_blank" rel="noopener noreferrer">Ouvrir le marché sur Polymarket ↗</a>`;
  }

  html += renderCmpMarketsHtml(cmp);

  const bfOnly = (item.markets || []).filter(
    (m) => !cmp || !(cmp.markets || []).some((cm) => cm.market === m.market)
  );
  if (bfOnly.length > 0) {
    html += `<div class="cap">Marchés Betfair additionnels (${bfOnly.length})</div><div class="list">`;
    for (const m of bfOnly) {
      const favStr = m.favorite ? `${m.favorite} (${fmtPct(m.favorite_pct)})` : 'Multi-issues';
      const varStr =
        m.variation_drop_pct != null
          ? `${m.variation_label} (${fmtSignedPct(m.variation_drop_pct)})`
          : m.variation_label || 'Stable';
      html += `<div class="cell"><span>${esc(m.label)} · ${esc(fmtEur(m.volume_bf))}</span><b>${esc(favStr)} · ${esc(varStr)}</b></div>`;
    }
    html += `</div>`;
  }

  if (Array.isArray(conc.items) && conc.items.length > 0) {
    html += `<div class="cap">Concordance &amp; Contradictions</div><div class="list">`;
    for (const c of conc.items) {
      const cls = c.status === 'contradiction' ? 'neg' : c.status === 'convergence' ? 'pos' : '';
      html += `<div class="row row-plain tv-row-static">
        <div class="mid">
          <div class="t ${cls}">${esc(c.pair)} · ${esc(c.status)}</div>
          <div class="s tv-sub-wrap">${esc(c.detail)}</div>
        </div>
      </div>`;
    }
    html += `</div>`;
  }

  openDetailSheet(
    `${item.home} — ${item.away}`,
    `${item.league || ''} · ${item.markets_count} marché(s) identifiés`,
    html,
    { pushHistory }
  );
}

export function openSignalDetailSheet(sig) {
  if (!sig) return;
  const matchItem = buildMergedMatches().find((m) => m.fixture_key === sig.fixture_key) || null;
  const cmp = matchItem?.cmp || null;
  const pmSig = sig.pm_signature_code || matchItem?.signature?.pm_code || null;
  const bfSig = sig.signature_code || matchItem?.signature?.code || null;
  const safePm = safeHttpsUrl(sig.pm_url);
  const evNet = sig.recommendation?.ev_net_pct;
  const evBrut = sig.recommendation?.ev_pct;
  const liqWarn = sig.recommendation?.pm_liquidity_warning;

  let html = `<div class="list">
    <div class="cell"><span>Catégorie</span><b>${esc(sig.category_label)}</b></div>
    <div class="cell"><span>Signal</span><b>${esc(sig.title)}</b></div>
    <div class="cell"><span>Volume Betfair</span><b>${esc(fmtEur(sig.total_volume_bf))}</b></div>
    <div class="cell"><span>Liquidité Polymarket</span><b>${sig.pm_liquidity != null ? esc(fmtUsd(sig.pm_liquidity)) : '—'}${liqWarn ? ' <span class="tv-liq-warn">(Carnet fin)</span>' : ''}</b></div>
    ${
      evNet != null || evBrut != null
        ? `<div class="cell"><span>Valeur espérée (EV)</span><b>${evNet != null ? `Nette ${evNet > 0 ? '+' : ''}${evNet.toFixed(1)} %` : ''}${evBrut != null ? ` · Brute ${evBrut > 0 ? '+' : ''}${evBrut.toFixed(1)} %` : ''}</b></div>`
        : ''
    }
    ${
      bfSig
        ? `<div class="cell"><span>Signature (72) Betfair</span><b class="sig-mono">${esc(bfSig)}</b></div>`
        : ''
    }
    ${
      pmSig
        ? `<div class="cell"><span>Signature Polymarket</span><b class="sig-mono">${esc(pmSig)}</b></div>`
        : ''
    }
  </div>
  <div class="list"><div class="note tv-no-border">${esc(sig.detail)}</div></div>`;

  if (safePm) {
    html += `<a class="main tv-full-link tv-mt-4" href="${esc(
      safePm
    )}" target="_blank" rel="noopener noreferrer">Voir sur Polymarket ↗</a>`;
  }

  if (cmp && Array.isArray(cmp.markets) && cmp.markets.length > 0) {
    html += renderCmpMarketsHtml(cmp);
  } else if (sig.market_data?.sides) {
    const rowsHtml = sig.market_data.sides
      .map((s) => {
        const gapCls = s.abs_gap_pp >= 3 ? (s.gap_pp > 0 ? 'pos' : 'neg') : '';
        return `<tr>
          <td><strong>${esc(s.label)}</strong></td>
          <td class="num">${fmtPct(s.bf_pct)}</td>
          <td class="num">${fmtPct(s.pm_pct)}</td>
          <td class="num ${gapCls}">${fmtGap(s.gap_pp)}</td>
        </tr>`;
      })
      .join('');
    html += `<div class="cap">Carnet BF × PM</div><div class="list tv-scroll-x"><table class="sheet-table">
      <thead><tr><th>Issue</th><th>Betfair</th><th>Polymarket</th><th>Écart</th></tr></thead>
      <tbody>${rowsHtml}</tbody></table></div>`;
  }

  if (sig.recommendation?.criteria) {
    html += `<div class="cap">Audit des 6 critères d’exécution</div><div class="list">`;
    for (const cr of sig.recommendation.criteria) {
      html += `<div class="cell">
        <span>${esc(cr.label)}</span>
        <b class="${cr.ok ? 'pos' : 'warn'}">${cr.ok ? 'Élevé' : 'Minimal'} · ${esc(cr.detail)}</b>
      </div>`;
    }
    html += `</div>`;
  } else if (Array.isArray(sig.items) && sig.items.length > 0) {
    html += `<div class="cap">Contradictions détectées</div><div class="list">`;
    for (const it of sig.items) {
      html += `<div class="row row-plain tv-row-static"><div class="mid"><div class="t neg">${esc(
        it.pair
      )}</div><div class="s tv-sub-wrap">${esc(it.detail)}</div></div></div>`;
    }
    html += `</div>`;
  }

  const concItems = matchItem?.axes?.concordance?.items || [];
  if (concItems.length > 0) {
    html += `<div class="cap">Concordance &amp; Contradictions</div><div class="list">`;
    for (const c of concItems) {
      const cls = c.status === 'contradiction' ? 'neg' : c.status === 'convergence' ? 'pos' : '';
      html += `<div class="row row-plain tv-row-static">
        <div class="mid">
          <div class="t ${cls}">${esc(c.pair)} · ${esc(c.status)}</div>
          <div class="s tv-sub-wrap">${esc(c.detail)}</div>
        </div>
      </div>`;
    }
    html += `</div>`;
  }

  if (matchItem) {
    html += `<button type="button" class="sec-btn" data-match-key="${esc(sig.fixture_key)}" data-push-sheet="1">Ouvrir la fiche complète du match</button>`;
  }

  openDetailSheet(`${sig.home} — ${sig.away}`, `${sig.league || ''} · ${sig.date_label || ''}`, html);
}

export function openSignalHistoryDetailSheet(rec) {
  if (!rec) return;
  const meta = signalHistoryToneMeta(rec);
  const sigList = Array.isArray(rec.all_signals) && rec.all_signals.length > 0 ? rec.all_signals : rec.signals || [];

  const html = `
    <div class="list">
      <div class="cell"><span>Statut du match</span><b>${esc(meta.tag)}</b></div>
      <div class="cell"><span>Score officiel</span><b>${
        rec.home_score != null && rec.away_score != null
          ? `${rec.home_score} - ${rec.away_score}${rec.home_ht != null ? ` (MT ${rec.home_ht}-${rec.away_ht})` : ''}`
          : rec.is_no_score
          ? 'Score non trouvé'
          : 'En attente de publication'
      }</b></div>
      <div class="cell"><span>Source résultat</span><b>${esc(
        rec.result_source
          ? rec.result_source.toUpperCase()
          : rec.is_no_score
          ? rec.no_score_reason || 'Sans source'
          : '—'
      )}</b></div>
      <div class="cell"><span>Volume Betfair pré-match</span><b>${fmtEur(rec.total_volume_bf)}</b></div>
      ${rec.pm_liquidity != null ? `<div class="cell"><span>Liquidité Polymarket</span><b>${fmtUsd(rec.pm_liquidity)}</b></div>` : ''}
      ${
        typeof rec.brier_bf === 'number' && typeof rec.brier_pm === 'number'
          ? `<div class="cell"><span>Brier Score (BF / PM)</span><b>${fmtMetric4(rec.brier_bf)} / ${fmtMetric4(rec.brier_pm)}</b></div>`
          : ''
      }
      ${rec.signature_code ? `<div class="cell"><span>Signature (72)</span><b class="sig-mono">${esc(rec.signature_code)}</b></div>` : ''}
    </div>
    ${renderEmittedSignalsSectionHtml(sigList, null, rec.status)}
    ${renderFrozenSnapshotsHtml(rec.market_snapshots)}
  `;

  openDetailSheet(
    `${rec.home} — ${rec.away}`,
    `${rec.league || ''} · ${rec.date_label || ''}`,
    html
  );
}

export function openResultDetailSheet(obs) {
  if (!obs) return;
  const meta = resultToneMeta(obs);
  const sidesHtml = (obs.sides || [])
    .map((s) => {
      const isWin = Array.isArray(obs.winning_labels) && obs.winning_labels.includes(s.label);
      const gapCls = Math.abs(s.gap_pp || 0) >= 3 ? (s.gap_pp > 0 ? 'pos' : 'neg') : '';
      return `<tr>
        <td><strong>${esc(s.label)}</strong>${isWin ? ' <span class="pos">✓</span>' : ''}</td>
        <td class="num">${fmtPct(s.bf_pct)}</td>
        <td class="num">${fmtPct(s.pm_pct)}</td>
        <td class="num ${gapCls}">${fmtGap(s.gap_pp)}</td>
      </tr>`;
    })
    .join('');

  let html = `<div class="list">
    <div class="cell"><span>Statut</span><b>${esc(meta.tag)}</b></div>
    <div class="cell"><span>Score final</span><b>${
      obs.home_score != null && obs.away_score != null
        ? `${obs.home_score} - ${obs.away_score}${obs.home_ht != null ? ` (MT ${obs.home_ht}-${obs.away_ht})` : ''}`
        : obs.is_no_score
        ? 'Score non trouvé'
        : 'En attente'
    }</b></div>
    <div class="cell"><span>Source officielle</span><b>${esc(
      obs.result_source
        ? obs.result_source.toUpperCase()
        : obs.is_no_score
        ? obs.no_score_reason || 'Sans source'
        : '—'
    )}</b></div>
    <div class="cell"><span>Volume Betfair pré-match</span><b>${fmtEur(obs.bf_volume)}</b></div>
    <div class="cell"><span>Liquidité Polymarket</span><b>${fmtUsd(obs.pm_liquidity)}</b></div>
    ${
      obs.status === 'settled'
        ? `<div class="cell"><span>Brier Score (BF / PM)</span><b>${fmtMetric4(obs.brier_bf)} / ${fmtMetric4(obs.brier_pm)}</b></div>
           <div class="cell"><span>Log-Loss (BF / PM)</span><b>${fmtMetric4(obs.logloss_bf)} / ${fmtMetric4(obs.logloss_pm)}</b></div>`
        : ''
    }
  </div>`;

  html += renderEmittedSignalsSectionHtml(obs.signals, obs.recommendation, obs.status, obs);

  if (sidesHtml) {
    html += `<div class="cap">Relevé pré-match figé avant coup d’envoi (${esc(obs.market_label || obs.market_short)})</div>
      <div class="list"><div class="tv-scroll-x"><table class="sheet-table">
        <thead><tr><th>Issue</th><th>Betfair</th><th>Polymarket</th><th>Écart Δ</th></tr></thead>
        <tbody>${sidesHtml}</tbody>
      </table></div></div>`;
  }

  openDetailSheet(
    `${obs.home} — ${obs.away}`,
    `${obs.league || ''} · ${obs.market_label || obs.market_short} · ${obs.date_label || ''}`,
    html
  );
}

export async function inspectSource(sourceKey, arbMarket = state.sourceArbMarket, pushHistory = true) {
  state.sourceInspectorKey = sourceKey;
  state.sourceArbMarket = arbMarket || state.sourceArbMarket || '1x2';
  openDetailSheet(
    `Source : ${sourceKey.toUpperCase()}`,
    'Chargement du flux brut…',
    '<div class="empty">Chargement en cours…</div>',
    { pushHistory, keepStack: !pushHistory }
  );
  try {
    let url = `/api/sources/arbworld?market=${encodeURIComponent(arbMarket)}`;
    if (sourceKey === 'polymarket') url = '/api/sources/polymarket?limit=15';
    else if (sourceKey === 'espn') url = '/api/sources/espn';
    else if (sourceKey === 'sportscore') url = '/api/sources/sportscore';

    const payload = await apiGet(url);
    let summaryHtml = '';
    if (sourceKey === 'arbworld') {
      const mkts = ['1x2', 'over-under-2-5', 'btts', 'double-chance', 'dnb', 'over-under-1-5', 'over-under-3-5', 'half-time', 'correct-score', 'ht-ft'];
      summaryHtml += `<div class="chips tv-mb-8">${mkts
        .map((m) => `<button type="button" class="chip${m === arbMarket ? ' on' : ''}" data-src-mkt="${m}">${m}</button>`)
        .join('')}</div>`;
      summaryHtml += `<div class="list">${(payload.rows || [])
        .slice(0, 15)
        .map((r) => `<div class="cell"><span>${esc(r.home)} — ${esc(r.away)} (${esc(r.league)})</span><b>${fmtEur(r.total_volume)}</b></div>`)
        .join('')}</div>`;
    } else if (sourceKey === 'polymarket') {
      summaryHtml += `<div class="list">${(payload.events || [])
        .slice(0, 15)
        .map((ev) => `<div class="cell"><span>${esc(ev.title || ev.slug)}</span><b>Liq. ${fmtUsd(ev.liquidity)}</b></div>`)
        .join('')}</div>`;
    } else {
      summaryHtml += `<div class="list">${(payload.events || [])
        .slice(0, 20)
        .map((ev) => {
          const sc = ev.home_score !== null && ev.away_score !== null ? `${ev.home_score} - ${ev.away_score}` : ev.state;
          return `<div class="cell"><span>${esc(ev.home_team)} — ${esc(ev.away_team)}</span><b>${esc(sc)}</b></div>`;
        })
        .join('')}</div>`;
    }

    summaryHtml += `<div class="cap">Extrait JSON API (${esc(url)})</div><pre class="json-pre">${esc(
      JSON.stringify(payload, null, 2).slice(0, 6000)
    )}</pre>`;

    $('detailTitle').textContent = `Source brute : ${sourceKey.toUpperCase()}`;
    $('detailSub').textContent = `Réponse live · ${payload.count ?? payload.events?.length ?? 0} entrées`;
    $('detailBody').innerHTML = summaryHtml;
  } catch (err) {
    const info = translateApiError(err, 'Lecture de la source impossible');
    $('detailBody').innerHTML = `<div class="tv-err-box"><h2>${esc(info.title)}</h2><p>${esc(info.detail)}</p><button type="button" class="tg-btn-sm" data-src-inspect="${esc(sourceKey)}">Réessayer</button></div>`;
  }
}

export function renderAccountContentHtml() {
  const calSum = state.calData?.summary || {};
  const bannerHtml = !state.isPro
    ? `<div class="banner" id="accProBanner" role="button" tabindex="0">
        <span aria-hidden="true">⭐</span>
        <div><b>Truevalue Pro</b><small>${state.proPriceStars} ★ / 30 jours · Telegram Stars</small></div>
        <span class="go">S’abonner</span>
      </div>`
    : `<div class="banner ok" id="accProActiveBtn">
        <span aria-hidden="true">✓</span>
        <div><b>Truevalue Pro actif</b><small>${state.isAdmin ? 'Accès administrateur' : 'Tous les signaux et critères sont débloqués'}</small></div>
        <span class="go">Actif</span>
      </div>`;

  const identityText = state.telegramUser
    ? `@${state.telegramUser.username || state.telegramUser.first_name || state.telegramUser.id}`
    : state.isAdmin
    ? 'Administrateur vérifié'
    : 'Session visiteur';

  const expStr = state.subscriptionExpiresAt
    ? new Date(state.subscriptionExpiresAt).toLocaleDateString('fr-FR')
    : null;

  let adminSectionHtml = '';
  if (!state.adminConfigured) {
    adminSectionHtml = `
      <div class="cap">Initialisation Administrateur (premier lancement)</div>
      <form class="tv-admin-box" id="adminClaimForm" novalidate>
        <p class="st-sub tv-mb-8">Définissez le mot de passe administrateur (8 caractères minimum) pour gérer la calibration et les sources.</p>
        <div class="tv-admin-row">
          <input id="adminClaimInput" type="password" minlength="8" autocomplete="new-password" placeholder="Nouveau code administrateur…" aria-label="Nouveau code administrateur" required />
          <button type="submit" class="tg-btn-sm" id="adminClaimBtn">Initialiser</button>
        </div>
        <div id="adminFormError" class="tv-inline-err" role="alert" hidden></div>
      </form>`;
  } else if (!state.isAdmin) {
    adminSectionHtml = `
      <div class="cap">Accès Administrateur</div>
      <form class="tv-admin-box" id="adminLoginForm" novalidate>
        <div class="tv-admin-row">
          <input id="adminLoginInput" type="password" autocomplete="current-password" placeholder="Code administrateur…" aria-label="Code administrateur" required />
          <button type="submit" class="tg-btn-sm" id="adminLoginBtn">Connexion</button>
        </div>
        <div id="adminFormError" class="tv-inline-err" role="alert" hidden></div>
      </form>`;
  } else {
    adminSectionHtml = `
      <div class="cap">Outils Administrateur</div>
      <div class="list">
        <div class="cell"><span>Session</span><b class="pos">Administrateur authentifié</b></div>
        <div class="cell cell-action" id="toggleProPreviewCell" role="button" tabindex="0">
          <span>Aperçu mode ${state.isPro ? 'Gratuit (limité à 3)' : 'Pro (complet)'}</span>
          <b>Basculer ›</b>
        </div>
        <div class="cell cell-action" id="accSyncCalCell" role="button" tabindex="0"><span>Synchroniser les scores finaux</span><b>Exécuter ›</b></div>
        <div class="cell cell-action" data-src-inspect="arbworld" role="button" tabindex="0"><span>Arbworld / Betfair (10 marchés)</span><b>Inspecter ›</b></div>
        <div class="cell cell-action" data-src-inspect="polymarket" role="button" tabindex="0"><span>Polymarket (Gamma / CLOB)</span><b>Inspecter ›</b></div>
        <div class="cell cell-action" data-src-inspect="espn" role="button" tabindex="0"><span>ESPN Soccer Scoreboard</span><b>Inspecter ›</b></div>
        <div class="cell cell-action" data-src-inspect="sportscore" role="button" tabindex="0"><span>SportScore</span><b>Inspecter ›</b></div>
        <div class="cell cell-action" id="adminLogoutCell" role="button" tabindex="0"><span>Déconnexion administrateur</span><b class="warn">Fermer ›</b></div>
      </div>`;
  }

  return `
    <div class="cap">Navigation rapide</div>
    <div class="menu-nav-grid">
      ${TABS.map(
        (t) => `<button type="button" class="menu-nav-btn${state.tab === t.id ? ' on' : ''}" data-go-tab="${t.id}"><span>${esc(t.label)}</span><span>›</span></button>`
      ).join('')}
    </div>

    ${bannerHtml}

    <div class="cap">Compte &amp; Formule</div>
    <div class="list">
      <div class="cell"><span>Identité</span><b>${esc(identityText)}</b></div>
      <div class="cell"><span>Statut</span><b>${state.isPro ? (expStr ? `Pro jusqu’au ${esc(expStr)}` : 'Pro · Actif') : 'Gratuit'}</b></div>
      <div class="cell"><span>Signaux &amp; Propositions</span><b>${state.isPro ? '✓ Débloqués' : '🔒 Limités (3 aperçus)'}</b></div>
      <div class="cell cell-action" id="toggleProposalsCell" role="button" tabindex="0">
        <span>Module Propositions (Signaux)</span>
        <b>${state.showProposals ? 'Activé ›' : 'Masqué ›'}</b>
      </div>
      <div class="cell cell-action" id="openHelpFromMenuCell" role="button" tabindex="0">
        <span>Guide de lecture &amp; Glossaire (DNB, BTTS, Edge…)</span>
        <b>Ouvrir ›</b>
      </div>
    </div>

    <div class="cap">Apparence</div>
    <div class="chips tv-mb-12">
      <button type="button" class="chip${state.theme === 'auto' ? ' on' : ''}" data-th-mode="auto">Système / Telegram</button>
      <button type="button" class="chip${state.theme === 'light' ? ' on' : ''}" data-th-mode="light">Clair</button>
      <button type="button" class="chip${state.theme === 'dark' ? ' on' : ''}" data-th-mode="dark">Sombre</button>
    </div>

    <div class="cap">Calibration publique</div>
    <div class="list">
      <div class="cell"><span>Relevés réglés / Total</span><b>${calSum.settled ?? 0} / ${calSum.total_observations ?? 0}</b></div>
    </div>

    ${adminSectionHtml}

    <div class="cap">Mentions légales, CGU &amp; Support</div>
    <div class="tv-legal-box">
      <p><strong>Nature du service :</strong> Truevalue est un outil d’analyse statistique et de comparaison de probabilités de marché. Aucune recommandation ne constitue un conseil financier ou une incitation à parier ; aucun gain n’est garanti.</p>
      <p><strong>Conditions &amp; Âge légal :</strong> Service réservé aux personnes majeures (18+). Vérifiez la législation applicable dans votre juridiction. Jeu responsable : ne misez jamais plus que ce que vous pouvez perdre.</p>
      <p><strong>Indépendance &amp; Support :</strong> Truevalue n’est affilié ni à Betfair, ni à Arbworld, ni à Polymarket, ni à ESPN. Abonnement facturé via Telegram Stars (${state.proPriceStars} ★ / 30 j, non renouvelé automatiquement).</p>
    </div>
  `;
}

export function openHelpGuideSheet(pushHistory = false) {
  const html = `
    <div class="tv-help-card">
      <h3>Code couleur des signaux et résultats</h3>
      <p><span class="sig-type-tag ok">Vert</span> <b>Opportunité positive / Signal gagné</b> — l’écart après marge est positif ou le score final valide le signal.</p>
      <p><span class="sig-type-tag info">Bleu</span> <b>Seuil 0 / Push (remboursé)</b> — opportunité sous la barre des 0 pt ou match annulé / nul sur un DNB.</p>
      <p><span class="sig-type-tag warn">Orange</span> <b>Mouvement 24h / Attention</b> — forte variation ou retournement récent des probabilités, ou source de score manquante.</p>
      <p><span class="sig-type-tag bad">Rouge</span> <b>Contradiction / Signal perdu</b> — désaccord logique entre deux marchés du même match, ou signal perdant.</p>
    </div>

    <div class="tv-help-card">
      <h3>Abréviations des marchés</h3>
      <p><b>1X2</b> : Victoire domicile (1), Match nul (X) ou Victoire extérieur (2) à la fin du temps réglementaire.</p>
      <p><b>DNB (Draw No Bet)</b> : Remboursé si match nul — seul le vainqueur compte ; en cas de nul (0-0, 1-1…), la mise est rendue (Push).</p>
      <p><b>BTTS</b> : Les deux équipes marquent (Oui / Non) durant le match.</p>
      <p><b>O/U 2.5</b> : Plus ou moins de 2,5 buts inscrits dans la rencontre.</p>
      <p><b>HT / FT</b> : Résultat à la mi-temps (Half-Time) et/ou fin de match (Full-Time).</p>
    </div>

    <div class="tv-help-card">
      <h3>Indicateurs de valeur et de précision</h3>
      <p><b>Edge net (pts)</b> : Écart de probabilité entre Polymarket et la juste cote Betfair, après déduction du spread et des frais.</p>
      <p><b>EV nette (%)</b> : Valeur espérée estimée après 2 % de friction d’exécution. Positive (&gt; 0 %) = prix favorable à long terme.</p>
      <p><b>Carnet fin</b> : Liquidité inférieure à 500 $ sur Polymarket — attention au glissement de prix.</p>
      <p><b>Unités (u) &amp; ROI</b> : Performance simulée à mise fixe de 1 unité par proposition (+1.20 u = +120 % sur ce pari).</p>
      <p><b>Brier Score</b> : Erreur quadratique des probabilités avant match. <b>Plus bas = marché plus précis</b> (0 = parfait).</p>
    </div>

    <div class="tv-help-card">
      <h3>Lire une signature (Configs 72)</h3>
      <p>Chaque code réunit 4 blocs séparés par « | » : <b>1X2 | BTTS | Mi-temps | Profil buts (G1 à G4)</b>. Exemple : <code>1 | Oui | 1 | G3</code> = Domicile favori, 2 équipes marquent, Domicile mène à la pause, match ouvert (G3).</p>
      <p>Le symbole <b>?</b> signifie que le marché correspondant est absent avant le coup d’envoi (aucune donnée inventée).</p>
    </div>
  `;
  openDetailSheet('Guide & Glossaire Truevalue', 'Comprendre les signaux, cotes et indicateurs en 1 minute', html, { pushHistory });
}

export function openMenuSheet() {
  openDetailSheet('Menu & Compte', state.isPro ? 'Truevalue Pro actif' : 'Version gratuite', renderAccountContentHtml());
}

export async function startProCheckout(onUnlocked) {
  const btn = $('buyBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Ouverture du paiement…';
  }
  try {
    const res = await apiPost('/api/billing/checkout', {});
    const tg = getTg();
    if (tg && typeof tg.openInvoice === 'function') {
      tg.openInvoice(res.invoice_url, async (status) => {
        if (status === 'paid') {
          toast('Paiement confirmé ! Actualisation de votre accès Pro…');
          closeAllSheets();
          if (typeof onUnlocked === 'function') await onUnlocked();
        } else if (status === 'cancelled') {
          toast('Paiement annulé. Vous restez en version gratuite.');
        } else if (status === 'failed') {
          toast('Le paiement Telegram Stars a échoué. Réessayez dans un instant.');
        }
      });
    } else {
      toast('Paiement disponible uniquement dans l’application Telegram.');
    }
  } catch (err) {
    const info = translateApiError(err, 'Paiement indisponible');
    toast(info.detail);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Souscrire avec Telegram Stars';
    }
  }
}

export { openProSheet };
