import { state, markOnboardingDone } from '../state.js';
import { esc, f1, int, tag, bar, fresh, sourceBanner, FOOT, skeleton, errorState, emptyState, time } from '../ui/format.js';

function sourceStrip(sources) {
  if (!Array.isArray(sources)) return '';
  return `<div class="sm" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:10px">${sources
    .map((s) => {
      const cls = s.etat === 'ok' ? 'ok' : s.etat === 'retard' ? 'wa' : 'ng';
      const label = s.etat === 'ok' ? 'à jour' : s.etat === 'retard' ? 'retard' : 'panne';
      return `<span><span class="tag ${cls}" style="padding:0 6px">●</span> ${esc(s.nom)} · ${label}${
        Number.isFinite(s.age_s) ? ` ${Math.round(s.age_s / 60)} min` : ''
      }</span>`;
    })
    .join('')}</div>`;
}

function onboarding() {
  if (state.onboardingDone) return '';
  return `<div class="cd" style="background:var(--ab);border-color:transparent"><div class="mt">Comment lire cet écran</div>
  <p class="sm" style="color:var(--tx);margin:4px 0 10px">Truevalue compare les probabilités de Betfair (marge retirée) et de Polymarket. L’écart moins le spread donne la valeur nette, en points. Ouvre une carte pour voir le détail, puis vérifie les résultats passés dans Bilan.</p>
  <button type="button" class="btn" data-ob="1" style="margin:0">Compris</button></div>`;
}

function card(c) {
  const star = state.followed.has(c.id) ? '★ ' : '';
  const mv = c.type === 'mv';
  const ct = c.type === 'ct';
  const badge = mv
    ? '<span class="tag wa">Mouvement Betfair</span>'
    : ct
    ? '<span class="tag ng">Contradiction</span>'
    : c.type === 'conv'
    ? '<span class="tag ok">Convergence</span>'
    : c.type === 'flow'
    ? '<span class="tag ac">Flux / retards</span>'
    : tag(c.niveau);
  const detail = mv
    ? esc(c.variation?.classe || 'mouvement') + ' · ouverture → actuel'
    : ct
    ? `${(c.causes || []).length} cause(s) de désaccord`
    : c.type === 'conv'
    ? `${c.nombre_convergences ?? 0} accord(s) entre Betfair et Polymarket`
    : c.type === 'flow'
    ? `${esc(c.flux?.type || 'flux')} · ${esc(c.flux?.detail || c.issue || '')}`
    : esc(c.issue || c.marche || '');
  const age = Math.max(
    Number.isFinite(c.fraicheur?.betfair_age_s) ? c.fraicheur.betfair_age_s : 0,
    Number.isFinite(c.fraicheur?.polymarket_age_s) ? c.fraicheur.polymarket_age_s : 0
  );
  return `<button type="button" class="cd" data-id="${esc(c.id)}" aria-label="Détail : ${esc(c.match?.home)} contre ${esc(c.match?.away)}">
    <div class="r"><span class="sm">${star}${esc(c.match?.league || 'Football')} · ${time(c.match?.kickoff)}</span>${badge}</div>
    <div class="mt">${esc(c.match?.home)} – ${esc(c.match?.away)}</div>
    <div class="sm" style="margin-bottom:6px">${detail}${!mv && !ct ? ` · ${esc(c.marche || '')}` : ''}</div>
    ${mv || ct || c.type === 'conv' || c.type === 'flow' ? '' : bar('Betfair', c.betfair_pct) + bar('Polymarket', c.polymarket_pct, 'var(--pm)')}
    <div class="ft">
      <span>Écart <b>${c.type === 'conv' || c.type === 'flow' ? '—' : `${f1(c.ecart_pts)} pts`}</b></span>
      <span>Valeur nette <b>${c.type === 'conv' || c.type === 'flow' ? '—' : `${f1(c.valeur_nette_pts)} pts`}</b></span>
      <span>Liquidité <b>${int(c.liquidite_polymarket_usd)} $</b></span>
      ${fresh(age, state.data.sources?.seuil_retard_s ?? 600)}
    </div></button>`;
}

function alertCard() {
  if (!state.isTelegram) return '';
  return `<div class="cd"><div class="mt">Alertes Telegram</div>
    <p class="sm" style="margin:2px 0 8px">Reçois une alerte quand la valeur nette dépasse 4 pts avec une liquidité suffisante. Aucun gain garanti.</p>
    <button type="button" class="btn sc" data-alertes="1" style="margin:0">Gérer mes alertes</button></div>`;
}

export function renderEcarts() {
  const s = state;
  if (s.loading) return skeleton();
  if (s.error) return errorState(s.error);
  const sources = s.data.sources;
  const data = s.data.ec;
  const all = Array.isArray(data?.ecarts) ? [...data.ecarts] : [];
  const filtered = s.type === 'all' ? all : all.filter((c) => c.type === s.type);
  filtered.sort((a, b) =>
    s.sort === 't'
      ? String(a.match?.kickoff || '').localeCompare(String(b.match?.kickoff || ''))
      : (b.valeur_nette_pts ?? -Infinity) - (a.valeur_nette_pts ?? -Infinity) ||
        (b.liquidite_polymarket_usd ?? 0) - (a.liquidite_polymarket_usd ?? 0)
  );
  const chips = [
    ['all', 'Tous'], ['net', 'Écarts nets'], ['mv', 'Mouvements Betfair'], ['ct', 'Contradictions'], ['conv', 'Convergences'], ['flow', 'Flux & retards'],
  ];
  return (
    onboarding() +
    sourceBanner(sources?.sources) +
    sourceStrip(sources?.sources) +
    `<div class="seg" role="group" aria-label="Filtrer les écarts">${chips
      .map(([v, l]) => `<button type="button" class="ch${s.type === v ? ' on' : ''}" data-type="${v}">${l}</button>`)
      .join('')}</div>
     <div class="r" style="margin-bottom:10px"><span class="sm">${filtered.length} écart(s) avant coup d’envoi</span>
       <span class="seg" style="padding:0"><button type="button" class="ch${s.sort === 'net' ? ' on' : ''}" data-sort="net">Valeur nette</button><button type="button" class="ch${s.sort === 't' ? ' on' : ''}" data-sort="t">Heure</button></span></div>
     <div id="ls">${filtered.length ? filtered.map(card).join('') : emptyState('Aucun écart pour ce filtre.')}</div>` +
    alertCard() +
    FOOT
  );
}

function spark(points) {
  const valid = (Array.isArray(points) ? points : []).filter((p) => Number.isFinite(p.ecart_pts));
  if (valid.length < 2) return '<p class="sm">Historique insuffisant pour tracer une courbe.</p>';
  const values = valid.map((p) => p.ecart_pts);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${Math.round((i * 280) / (values.length - 1))},${Math.round(44 - ((v - min) / span) * 38)}`)
    .join(' ');
  return `<div class="sm" style="margin-top:12px">Évolution réelle de l’écart (${valid.length} relevés)</div>
    <svg class="spark" viewBox="0 0 280 48" role="img" aria-label="Évolution réelle de l'écart"><polyline points="${pts}" fill="none" stroke="var(--ac)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export function renderDetail(d) {
  const mv = d.type === 'mv';
  const ct = d.type === 'ct';
  const phrase = d.type === 'conv'
    ? `Betfair et Polymarket désignent la même issue comme favorite sur ${d.nombre_convergences ?? (d.convergences || []).length} axe(s). C’est un accord d’analyse, pas un écart exploitable.`
    : d.type === 'flow'
    ? `${esc(d.flux?.detail || 'Flux Betfair × Polymarket')} · direction : ${esc(d.flux?.direction || '—')}. Ce signal n’a pas de cote : aucun rendement en unités n’est calculé.`
    : mv
    ? `Variation Betfair depuis l’ouverture : ${f1(d.variation?.delta_prob_pts)} pts. Le libellé « 24 h » ne s’applique qu’à Polymarket.`
    : ct
    ? `${(d.causes || []).map((c) => esc(c.cause)).join(', ')} : les marchés concernés sont listés ci-dessous.`
    : `Polymarket cote « ${esc(d.issue)} » à ${f1(d.polymarket_pct)} %, alors que Betfair, marge retirée, l’estime à ${f1(d.betfair_pct)} %. Après ${f1(d.spread_pts)} pts de spread, il reste <b>${f1(d.valeur_nette_pts)} pts</b> de valeur nette.`;
  const issues = (d.toutes_issues || [])
    .map((m) => `<div class="sm" style="margin-top:8px;font-weight:600">${esc(m.issue || m.marche)}</div>` + bar('Betfair', m.betfair_pct) + bar('Polymarket', m.polymarket_pct, 'var(--pm)'))
    .join('');
  const causes = ct
    ? `<div class="cd"><div class="mt">Causes dédoublonnées</div>${(d.causes || [])
        .map((c) => `<div class="rw"><div><b>${esc(c.cause)}</b><div class="sm">${(c.markets || []).map(esc).join(', ')}</div></div></div>`)
        .join('')}</div>`
    : d.type === 'conv'
    ? `<div class="cd"><div class="mt">Accords Betfair × Polymarket</div>${(d.convergences || [])
        .map((c) => `<div class="rw" style="display:block"><b>${esc(c.cause)}</b><div class="sm">${esc(c.detail)}</div></div>`)
        .join('')}</div>`
    : '';
  const followed = state.followed.has(d.id);
  return `<div class="r"><div><div class="mt">${esc(d.match?.home)} – ${esc(d.match?.away)}</div>
    <div class="sm">${esc(d.match?.league || '')} · ${time(d.match?.kickoff)} · ${esc(d.marche || '')}</div></div>${tag(d.niveau)}</div>
    <p style="margin:12px 0">${phrase}</p>
    ${issues}
    <div class="gr">
      <div><span class="sm">Écart</span><b>${f1(d.ecart_pts)} pts</b></div>
      <div><span class="sm">Valeur nette</span><b>${f1(d.valeur_nette_pts)} pts</b></div>
      <div><span class="sm">Liquidité Polymarket</span><b>${int(d.liquidite_polymarket_usd)} $</b></div>
      <div><span class="sm">Volume Betfair</span><b>${int(d.volume_betfair_eur)} €</b></div>
    </div>
    ${causes}
    ${spark(d.historique_ecart)}
    <div class="sm">Mouvement Betfair depuis l’ouverture · Polymarket 24 h : ${f1(d.polymarket_change_24h_pts)} pts</div>
    ${d.pm_url ? `<a class="btn" href="${esc(d.pm_url)}" target="_blank" rel="noopener noreferrer">Voir le marché sur Polymarket</a>` : ''}
    <button type="button" class="btn sc" data-follow="${esc(d.id)}">${followed ? '★ Suivi · alerte activée' : '☆ Suivre ce match'}</button>
    <button type="button" class="btn sc" data-share="${esc(d.id)}">Partager cet écart</button>
    ${FOOT}`;
}

export function ecartById(id) {
  return (state.data.ec?.ecarts || []).find((c) => c.id === id) || null;
}

export function markOnboard() {
  markOnboardingDone();
}
