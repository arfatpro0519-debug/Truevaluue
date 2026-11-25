import { state } from '../state.js';
import { esc, time, sourceBanner, FOOT, skeleton, errorState, emptyState } from '../ui/format.js';

export function renderMatchs() {
  if (state.loading) return skeleton();
  if (state.error) return errorState(state.error);
  const matchs = Array.isArray(state.data.ma?.matchs) ? state.data.ma.matchs : [];
  return sourceBanner(state.data.sources?.sources) +
    `<input id="q" type="search" placeholder="Équipe ou compétition" aria-label="Rechercher un match" value="${esc(state.query)}">
    <div class="cd" id="ml" style="padding:4px 14px">${matchList(matchs)}</div>${FOOT}`;
}

export function matchList(matchs) {
  if (!matchs.length) return emptyState('Aucun match trouvé.');
  return matchs
    .map(
      (m) => `<div class="rw"><div><b>${esc(m.home)} – ${esc(m.away)}</b>
      <div class="sm">${esc(m.league || 'Football')} · ${time(m.kickoff)}</div></div>
      <span class="tag ${m.has_betfair && m.has_polymarket ? 'ok' : 'ac'}">${
        m.has_betfair && m.has_polymarket ? 'Betfair + Polymarket' : m.has_betfair ? 'Betfair seul' : 'Polymarket seul'
      }</span></div>`
    )
    .join('');
}
