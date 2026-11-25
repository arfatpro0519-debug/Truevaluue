export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function f1(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(Math.round(value * 10) / 10).replace('.', ',')
    : '—';
}

export function int(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value).toLocaleString('fr-FR')
    : '—';
}

export function time(raw) {
  const dt = typeof raw === 'string' ? new Date(raw) : null;
  if (!dt || Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export function tag(level) {
  const map = {
    fort: ['Fort', 'ok'],
    moyen: ['Moyen', 'wa'],
    faible: ['Faible', 'ac'],
    limite: ['Limité', 'ng'],
  };
  const [label, cls] = map[level] || ['Indisponible', 'ac'];
  return `<span class="tag ${cls}">Niveau ${label}</span>`;
}

export function bar(label, value, color = 'var(--ac)', width = null) {
  const w = typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  const right = width === null ? `${f1(value)} %` : String(width).replace('.', ',');
  return `<div class="br"><span>${esc(label)}</span><div class="tr"><i style="width:${w}%;background:${color}"></i></div><b>${esc(right)}</b></div>`;
}

export function fresh(ageS, seuilS = 600) {
  if (!Number.isFinite(ageS)) return '<span>fraîcheur inconnue</span>';
  const cls = ageS > seuilS ? ' class="wa"' : '';
  return `<span${cls}>${ageS > seuilS ? '⚠ ' : ''}il y a ${Math.round(ageS / 60)} min</span>`;
}

// État des sources affiché sur CHAQUE écran (brief 4.4).
export function sourceBanner(sources) {
  if (!Array.isArray(sources)) return '';
  const down = sources.filter((s) => s.etat === 'panne');
  const late = sources.filter((s) => s.etat === 'retard');
  let html = '';
  if (down.length) {
    html += `<div class="bn down" role="alert">Source en panne : ${down.map((s) => esc(s.nom)).join(', ')}. Les chiffres peuvent être incomplets.</div>`;
  }
  if (late.length) {
    html += `<div class="bn warn">⚠ Source en retard : ${late.map((s) => esc(s.nom)).join(', ')}.</div>`;
  }
  return html;
}

export const FOOT = '<p class="ft2">18+ · Outil d’analyse statistique, aucun gain garanti. Non affilié à Betfair ni Polymarket.</p>';

export function skeleton() {
  return '<div class="st" aria-hidden="true"></div><div class="st" aria-hidden="true"></div><div class="st" aria-hidden="true"></div><p class="sm">Chargement…</p>';
}

export function errorState(message) {
  return `<div class="cd bn down" role="alert"><div class="mt">Impossible de charger</div><div class="sm">${esc(message || 'Erreur réseau.')}</div><button type="button" class="btn sc" data-retry="1">Réessayer</button></div>${FOOT}`;
}

export function emptyState(message = 'Aucun résultat pour ce filtre.') {
  return `<div class="empty">${esc(message)}</div>${FOOT}`;
}
