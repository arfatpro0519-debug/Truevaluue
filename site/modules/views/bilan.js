import { state } from '../state.js';
import { esc, f1, int, bar, FOOT, skeleton, errorState } from '../ui/format.js';

export function renderBilan() {
  if (state.loading) return skeleton();
  if (state.error) return errorState(state.error);
  const b = state.data.bi;
  if (!b) return errorState('Bilan indisponible.');
  const p = b.precision || {};
  const bf = Number.isFinite(p.betfair_brier) ? p.betfair_brier : null;
  const pm = Number.isFinite(p.polymarket_brier) ? p.polymarket_brier : null;
  const verdict = bf === null || pm === null ? 'Précision non mesurée' : Math.abs(bf - pm) < 0.005 ? 'Précision similaire' : bf < pm ? 'Betfair devance Polymarket' : 'Polymarket devance Betfair';
  const roi = b.rendement_theorique || {};
  return `<div class="cd"><div class="sm">Qui est le plus précis ?</div>
    <div class="mt" style="font-size:17px">${verdict}</div>
    <div class="sm" style="margin-bottom:8px">${int(p.n)} marchés réglés · Brier (plus bas = plus précis)${p.sample_warning ? ' · échantillon trop faible' : ''}</div>
    ${bar('Betfair', bf === null ? null : bf * 100 / Math.max(bf, pm, 0.001) * 50, 'var(--ac)', f1(bf))}
    ${bar('Polymarket', pm === null ? null : pm * 100 / Math.max(bf, pm, 0.001) * 50, 'var(--pm)', f1(pm))}</div>
  <div class="cd"><div class="mt">Fiabilité par type de signal</div>
    <div class="sm">Taux de confirmation après le match (pas une probabilité de gain)</div>
    ${(b.fiabilite || []).map((t) => `<div class="rw"><div><b>${esc(t.libelle)}</b><div class="sm">n = ${int(t.n)}${t.sample_warning ? ' · échantillon trop faible' : ''}</div></div><span class="tag ${t.sample_warning ? 'wa' : 'ac'}">${f1(t.taux_confirmation_pct)} %</span></div>`).join('')}</div>
  <div class="cd"><div class="mt">Rendement théorique : ${roi.unites === null || roi.unites === undefined ? '—' : f1(roi.unites)} u</div>
    <div class="sm">Sur ${int(roi.roi_n)} écarts nets valorisés, mise fixe 1 u, hors frais. ${esc(roi.avertissement || '')}</div></div>
  <div class="cd" style="padding:4px 14px"><div class="mt" style="padding-top:10px">Derniers résultats</div>
    ${(b.derniers_resultats || []).map((r) => `<div class="rw"><div><b>${esc(r.match)}</b><div class="sm">${esc(r.issue)} · ${esc(r.score || '—')}</div></div><span class="tag ${r.resultat === 'Confirmé' ? 'ok' : r.resultat === 'Infirmé' ? 'ng' : 'ac'}">${esc(r.resultat || '—')}</span></div>`).join('') || '<p class="sm">Aucun résultat réglé.</p>'}</div>
  <div class="cd"><div class="mt">Laboratoire</div><div class="sm" style="margin:2px 0 8px">Étudie les 72 signatures avec leur effectif et leur incertitude.</div><button type="button" class="btn sc" data-lab="1">Ouvrir le Laboratoire</button></div>
  ${FOOT}`;
}
