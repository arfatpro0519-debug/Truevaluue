import { api, authenticateTelegram } from './modules/api.js';
import { state, toggleFollow } from './modules/state.js';
import { initSheet, openSheet } from './modules/ui/sheet.js';
import { toast } from './modules/ui/toast.js';
import { esc, FOOT } from './modules/ui/format.js';
import { renderEcarts, renderDetail, markOnboard } from './modules/views/ecarts.js';
import { renderMatchs, matchList } from './modules/views/matchs.js';
import { renderBilan } from './modules/views/bilan.js';
import { renderLaboratoire } from './modules/views/laboratoire.js';

let currentDetail = null;
let searchTimer = null;

function applyTheme(tg) {
  const root = document.documentElement;
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  if (tg?.themeParams?.bg_color) {
    root.style.setProperty('--bg', tg.themeParams.bg_color);
  }
  if (tg?.themeParams?.text_color) {
    root.style.setProperty('--tx', tg.themeParams.text_color);
  }
  if (tg?.colorScheme) root.dataset.theme = tg.colorScheme;
  else if (dark) root.dataset.theme = 'dark';
}

async function initTelegram() {
  const tg = window.Telegram?.WebApp;
  if (!tg) return;
  state.isTelegram = true;
  try {
    tg.ready();
    tg.expand();
    applyTheme(tg);
    await authenticateTelegram(tg.initData);
  } catch {
    // Mini App indisponible : l'interface reste utilisable dans le navigateur.
  }
}

function view() {
  if (state.tab === 'ma') return renderMatchs();
  if (state.tab === 'bi') return renderBilan();
  if (state.tab === 'lb') return renderLaboratoire();
  return renderEcarts();
}

function render() {
  document.getElementById('app').innerHTML = view();
  document.querySelectorAll('#nv button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === (state.tab === 'lb' ? 'ec' : state.tab));
  });
}

async function load() {
  state.loading = true;
  state.error = null;
  render();
  try {
    const common = api.sources().then((s) => {
      state.data.sources = s;
    });
    if (state.tab === 'ec') {
      await Promise.all([common, api.ecarts(state.type).then((d) => { state.data.ec = d; })]);
    } else if (state.tab === 'ma') {
      await Promise.all([common, api.matchs(state.query).then((d) => { state.data.ma = d; })]);
    } else if (state.tab === 'bi') {
      await Promise.all([common, api.bilan().then((d) => { state.data.bi = d; })]);
    } else {
      await Promise.all([common, api.laboratoire(state.intensity).then((d) => { state.data.lb = d; })]);
    }
  } catch (err) {
    state.error = err?.message || 'Erreur réseau.';
  } finally {
    state.loading = false;
    render();
  }
}

function go(tab) {
  state.tab = tab;
  window.scrollTo(0, 0);
  load();
}

async function openDetail(id) {
  openSheet('<p class="sm">Chargement du détail…</p>');
  try {
    currentDetail = await api.ecart(id);
    openSheet(renderDetail(currentDetail));
  } catch (err) {
    openSheet(`<div class="bn down" role="alert">${esc(err?.message || 'Détail indisponible.')}</div><button type="button" class="btn" data-retry-detail="1">Réessayer</button>`);
  }
}

function share(id) {
  const d = currentDetail;
  if (!d || (id && d.id !== id)) return;
  const text = `${d.match?.home} – ${d.match?.away} · ${d.issue} : Betfair ${d.betfair_pct ?? '—'} % contre Polymarket ${d.polymarket_pct ?? '—'} % (valeur nette ${d.valeur_nette_pts ?? '—'} pts). 18+ · aucun gain garanti.`;
  const url = new URL('https://t.me/share/url');
  url.searchParams.set('text', text);
  window.open(url.toString(), '_blank', 'noopener,noreferrer');
  if (navigator.share) {
    navigator.share({ text }).catch(() => {});
    return;
  }
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => toast('Texte copié.'), () => toast('Partage indisponible.'));
    return;
  }
  toast('Partage indisponible.');
}

function glossary() {
  const rows = [
    ['Probabilité Betfair', 'Cote convertie en probabilité, marge du bookmaker retirée (méthode proportionnelle).'],
    ['Prix Polymarket', 'Prix de l’issue : 55 ¢ équivaut à 55 %.'],
    ['Écart', 'Probabilité Betfair sans marge moins prix Polymarket, en points.'],
    ['Valeur nette', 'Écart moins le spread Polymarket (coût d’achat et de vente), en points.'],
    ['Niveau', 'Fort ≥ 4 pts nets, Moyen ≥ 2, Faible < 2. Limité si la liquidité Polymarket est sous 5 000 $. Ce n’est pas une probabilité de gain.'],
    ['Mouvement Betfair', 'Variation depuis l’ouverture, jamais sur 24 h. Seul Polymarket expose un changement 24 h.'],
    ['Intensité', 'Écart entre le favori et le second d’un marché : équilibre, faible, modérée, forte, extrême.'],
    ['Signature', 'Combinaison des favoris de 4 blocs : résultat, BTTS, mi-temps, profil de buts. 72 combinaisons.'],
    ['Confirmé / Infirmé / Remboursé', 'Issue du signal après le score final. Les signaux ne sont pas des paris.'],
    ['Score de Brier', 'Mesure de précision d’une probabilité après le match. Plus bas = plus précis.'],
  ];
  openSheet(`<div class="mt">Glossaire</div>${rows.map(([t, d]) => `<div class="rw" style="display:block"><b>${esc(t)}</b><div class="sm">${esc(d)}</div></div>`).join('')}${FOOT}`);
}

async function alertSheet() {
  openSheet('<p class="sm">Chargement des alertes…</p>');
  try {
    const a = await api.alertes();
    const tg = window.Telegram?.WebApp;
    openSheet(`<div class="mt">Alertes Telegram</div>
      <div class="sm">État : ${a.actif ? 'activées' : 'désactivées'} · valeur nette ≥ ${a.regles?.netMinPp ?? 4} pts · liquidité ≥ ${a.regles?.pmMinLiquidityUsd ?? 5000} $ · plafond ${a.regles?.dailyCap ?? 10}/jour.</div>
      <button type="button" class="btn" data-alertes-set="1">${a.actif ? 'Désactiver' : 'Activer'}</button>
      <p class="sm">${esc(tg ? ' Les alertes sont liées à votre compte Telegram.' : ' Ouvrez cette page depuis Telegram pour gérer les alertes.')}</p>${FOOT}`);
    alertSheetState = a.actif;
  } catch (err) {
    openSheet(`<div class="bn down" role="alert">${esc(err?.message || 'Alertes indisponibles.')}</div>${FOOT}`);
  }
}
let alertSheetState = false;

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.tab) return go(b.dataset.tab);
  if (b.dataset.type) {
    state.type = b.dataset.type;
    return load();
  }
  if (b.dataset.sort) {
    state.sort = b.dataset.sort;
    return render();
  }
  if (b.dataset.intensity) {
    state.intensity = b.dataset.intensity;
    return load();
  }
  if (b.dataset.lab) return go('lb');
  if (b.dataset.ob) {
    markOnboard();
    return render();
  }
  if (b.dataset.retry) return load();
  if (b.dataset.retryDetail && currentDetail) return openDetail(currentDetail.id);
  if (b.dataset.id) return openDetail(b.dataset.id);
  if (b.dataset.follow) {
    const on = toggleFollow(b.dataset.follow);
    if (state.isTelegram) {
      try {
        await api.setAlertes(on);
      } catch (err) {
        toast(err.message);
      }
    }
    toast(on ? 'Suivi activé.' : 'Suivi désactivé.');
    if (currentDetail) openSheet(renderDetail(currentDetail));
    return render();
  }
  if (b.dataset.share) return share(b.dataset.share);
  if (b.dataset.alertes) return alertSheet();
  if (b.dataset.alertesSet) {
    try {
      const r = await api.setAlertes(!alertSheetState);
      toast(r.actif ? 'Alertes activées.' : 'Alertes désactivées.');
      await alertSheet();
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  if (b.id === 'bh') return glossary();
  if (b.id === 'br') {
    await load();
    toast('Données actualisées.');
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id !== 'q') return;
  state.query = e.target.value;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    try {
      state.data.ma = await api.matchs(state.query);
      document.getElementById('ml').innerHTML = matchList(state.data.ma.matchs);
    } catch (err) {
      toast(err.message);
    }
  }, 180);
});

initSheet();
initTelegram().finally(load);
