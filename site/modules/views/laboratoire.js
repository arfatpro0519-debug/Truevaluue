import { state } from '../state.js';
import { esc, f1, int, bar, FOOT, skeleton, errorState } from '../ui/format.js';

function interval(s) {
  const [lo, hi] = s.ic95_pct || [null, null];
  const p = s.taux_confirmation_pct;
  if (!Number.isFinite(p) || !Number.isFinite(lo) || !Number.isFinite(hi)) return '';
  return `<div class="rg" role="img" aria-label="Intervalle de confiance 95 % de ${f1(lo)} à ${f1(hi)} percent">
    <i style="left:${Math.max(0, lo)}%;width:${Math.min(100, hi) - Math.max(0, lo)}%"></i>
    <u style="left:${Math.max(0, Math.min(100, p))}%"></u>
    ${Number.isFinite(s.probabilite_marche_pct) ? `<b style="left:${Math.max(0, Math.min(100, s.probabilite_marche_pct))}%"></b>` : ''}
  </div><div class="sm">${f1(p)} % · IC 95 % [${f1(lo)} ; ${f1(hi)}] · prob. marché ${f1(s.probabilite_marche_pct)} %</div>`;
}

export function renderLaboratoire() {
  if (state.loading) return skeleton();
  if (state.error) return errorState(state.error);
  const l = state.data.lb;
  if (!l) return errorState('Laboratoire indisponible.');
  const coverage = l.couverture || {};
  const intensities = ['all', 'equilibre', 'faible', 'moderee', 'forte', 'extreme'];
  const labels = { all: 'Toutes', equilibre: 'Équilibre', faible: 'Faible', moderee: 'Modérée', forte: 'Forte', extreme: 'Extrême' };
  return `<div class="r" style="margin-bottom:10px"><div class="mt" style="font-size:18px">Laboratoire</div><button type="button" class="ch" data-tab="ec">← Retour</button></div>
  <div class="cd" style="background:var(--wb);border-color:transparent"><div class="mt" style="color:var(--wa)">Outil d’étude, pas de pronostics</div>
    <div class="sm" style="margin-top:2px">Chaque résultat affiche le nombre de matchs réglés et la période. Sous 30 matchs, aucune conclusion.</div></div>
  <div class="gr">
    <div><span class="sm">Signatures observées</span><b>${int(l.signatures_observees)} / ${int(l.signatures_possibles)}</b></div>
    <div><span class="sm">Matchs incomplets</span><b>${int(l.matchs_incomplets)}</b></div>
    <div><span class="sm">Données incohérentes</span><b>${int(l.matchs_incoherents)}</b></div>
    <div><span class="sm">Période</span><b style="font-size:13px">${esc(l.periode?.min_date || '—')} → ${esc(l.periode?.max_date || '—')}</b></div>
  </div>
  <div class="cd"><div class="mt">Couverture des marchés</div>
    ${bar('1X2 FT', (coverage.one_x_two || 0) / Math.max(1, coverage.one_x_two || 0) * 100, 'var(--ac)', int(coverage.one_x_two))}
    ${bar('BTTS', (coverage.btts || 0) / Math.max(1, coverage.btts || 0) * 100, 'var(--ac)', int(coverage.btts))}
    ${bar('Mi-temps', (coverage.half_time || 0) / Math.max(1, coverage.half_time || 0) * 100, 'var(--ac)', int(coverage.half_time))}
    ${bar('Buts O/U', (coverage.goals_profile || 0) / Math.max(1, coverage.goals_profile || 0) * 100, 'var(--ac)', int(coverage.goals_profile))}</div>
  <div class="cd"><div class="mt">Seuils d’intensité actifs</div><div class="sm">Équilibre &lt; ${f1(l.seuils_intensite?.equilibreMaxPp)} pts · Faible &lt; ${f1(l.seuils_intensite?.faibleMaxPp)} · Modérée &lt; ${f1(l.seuils_intensite?.modereeMaxPp)} · Forte &lt; ${f1(l.seuils_intensite?.forteMaxPp)} · Extrême au-delà.</div></div>
  <div class="mt" style="margin:14px 0 6px">Signatures observées</div>
  <div class="seg">${intensities.map((v) => `<button type="button" class="ch${l.intense_filtre === v ? ' on' : ''}" data-intensity="${v}">${labels[v]}</button>`).join('')}</div>
  <div class="sm" style="margin-bottom:10px">● taux observé · barre = IC 95 % · | = probabilité moyenne du marché. Tri par nombre de matchs uniquement.</div>
  ${l.signatures.length ? l.signatures.map((s) => `<div class="cd"${s.sample_warning ? ' style="opacity:.62"' : ''}>
    <div class="r"><b>${esc(s.code)}</b><span class="sm">n = ${int(s.n_matchs)} réglés</span></div>
    <div class="sm">${esc(s.intensite_dominante || '—')} · ${int(s.n_regles)} règle(s) · ${int(s.contradictions)} contradiction(s) · ${esc(s.periode?.min_date || '')} → ${esc(s.periode?.max_date || '')}</div>
    ${interval(s)}
    ${s.verdict ? `<div class="sm" style="margin-top:6px">${esc(s.verdict)}</div>` : '<div class="sm" style="margin-top:6px">Échantillon trop faible : aucune conclusion.</div>'}
  </div>`).join('') : '<div class="empty">Aucune signature observée pour ce filtre.</div>'}
  ${FOOT}`;
}
