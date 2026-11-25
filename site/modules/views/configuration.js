import { state } from '../state.js';
import { esc, f1, int, FOOT, skeleton, errorState, emptyState, time } from '../ui/format.js';

export function renderConfiguration() {
  if (state.loading) return skeleton();
  if (state.error) return errorState(state.error);
  const c = state.data.cf;
  if (!c) return errorState('Configuration indisponible.');
  const k = c.kpi || {};
  const ic = k.ic95_pct || [null, null];
  return `<div class="r" style="margin-bottom:10px"><div class="mt" style="font-size:18px">Configuration</div>
    <button type="button" class="ch" data-tab="lb">← Laboratoire</button></div>
  <div class="cd"><div class="sm">Signature</div><div class="mt" style="font-size:17px">${esc(c.code)}</div>
    <div class="sm">${c.complet ? '4 blocs renseignés' : 'Signature incomplète'} · ${esc(c.configuration?.periode?.min_date || '—')} → ${esc(c.configuration?.periode?.max_date || '—')}</div></div>
  <div class="gr">
    <div><span class="sm">Matchs réglés</span><b>${int(k.n_matchs_regles)}</b></div>
    <div><span class="sm">Règles live</span><b>${int(k.n_regles_live)}</b></div>
    <div><span class="sm">Favori confirmé</span><b>${int(k.k_favori_gagnant)}</b></div>
    <div><span class="sm">Taux confirmation</span><b>${f1(k.taux_confirmation_pct)} %</b></div>
    <div><span class="sm">IC 95 %</span><b style="font-size:14px">[${f1(ic[0])} ; ${f1(ic[1])}]</b></div>
    <div><span class="sm">Prob. marché</span><b>${f1(k.probabilite_marche_pct)} %</b></div>
    <div><span class="sm">Contradictions</span><b>${int(k.contradictions)}</b></div>
    <div><span class="sm">Convergences</span><b>${int(k.convergences)}</b></div>
  </div>
  ${k.sample_warning ? '<div class="bn warn" role="status">Échantillon trop faible : aucune conclusion.</div>' : ''}
  <div class="cd"><div class="mt">Paramètres de la configuration</div>
    ${(c.parametres || []).map((p) => `<div class="rw" style="display:block"><b>${esc(p.axe)}</b><div class="sm">Valeur : ${esc(p.valeur)} · ${esc(p.definition)}</div></div>`).join('')}
    <div class="sm" style="margin-top:8px">Seuils d’intensité : Équilibre &lt; ${f1(c.seuils_intensite?.equilibreMaxPp)} pts · Faible &lt; ${f1(c.seuils_intensite?.faibleMaxPp)} · Modérée &lt; ${f1(c.seuils_intensite?.modereeMaxPp)} · Forte &lt; ${f1(c.seuils_intensite?.forteMaxPp)}.</div>
  </div>
  <div class="cd"><div class="mt">Explication</div><p class="sm" style="color:var(--tx);margin:6px 0">${esc(c.explication)}</p>
    ${c.verdict ? `<div class="sm">${esc(c.verdict)}</div>` : '<div class="sm">Aucun verdict tant que l’échantillon reste sous 30 matchs réglés.</div>'}</div>
  <div class="cd"><div class="mt">Matchs associés</div>
    ${(c.matchs || []).length ? c.matchs.map((m) => `<div class="rw"><div><b>${esc(m.home)} – ${esc(m.away)}</b><div class="sm">${esc(m.league || '')} · ${time(m.kickoff)} · ${esc(m.source)}</div></div><span class="tag ${m.statut === 'Confirmé' ? 'ok' : m.statut === 'Infirmé' ? 'ng' : 'ac'}">${esc(m.statut)}</span></div>`).join('') : emptyState('Aucun match associé à cette configuration.')}
  </div>
  ${FOOT}`;
}
