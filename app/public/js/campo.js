// Strumento di campo della regia (dal telefono): piazza Altari e Doni con foto e posizione.
// Gli Eletti hanno le stesse funzioni dentro la loro app: se arrivano qui vengono rimandati lì.
import { h, mount, api, stream, store, cameraSupported, STATUS_LABELS } from './lib.js';
import { createField } from './field-ui.js';

const $root = document.getElementById('root');
const F = {
  who: null,
  gameId: store.get('zdg_campo_game'),
  data: null,
  tab: location.hash.slice(1) || 'altari',
  squadId: null,
  me: null,
  geoError: null,
};
const field = createField(F, { rerender: (tab) => { if (tab) location.hash = tab; else render(); } });

window.addEventListener('hashchange', () => { F.tab = location.hash.slice(1) || 'altari'; render(); });

(async function boot() {
  // Service worker: serve anche per installare la pagina come app (telefono, tablet, computer).
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    F.who = await api('GET', '/api/field/whoami');
  } catch {
    return mount($root, viewLogin());
  }
  if (F.who.role === 'elect') { location.replace('/#/campo'); return; }
  if (!F.who.games.some((g) => g.id === F.gameId)) F.gameId = F.who.games[0]?.id || null;
  store.set('zdg_campo_game', F.gameId);
  stream('/api/stream?as=staff', {
    refresh: (d) => { if (d.gameId === F.gameId) field.load(); },
    open: () => field.load(),
  });
  field.startGps();
  await field.load();
})();

function render() {
  if (!F.who) return;
  const d = F.data;
  const placedA = d ? d.points.filter((p) => p.lat != null).length : 0;
  const placedG = d ? d.gifts.filter((g) => g.status !== 'draft').length : 0;
  if (F.tab !== 'mappa') field.leaveMap();
  mount($root,
    h('header', { class: 'top campo-top' },
      h('a', { class: 'back', href: '/regia', 'aria-label': 'Torna alla regia' }, '‹'),
      h('div', { class: 'top-id' },
        h('div', { class: 'top-sector' }, 'Campo'),
        h('div', { class: 'top-sub' }, `Regia · ${F.who.name}`)),
      F.who.games.length > 1 ? h('select', { class: 'input campo-game', 'aria-label': 'Partita', onchange: (e) => { F.gameId = Number(e.target.value); store.set('zdg_campo_game', F.gameId); F.data = null; field.load(); } },
        F.who.games.map((g) => h('option', { value: g.id, selected: g.id === F.gameId }, g.name))) : null),
    h('main', { class: 'main campo' },
      !F.gameId ? h('p', { class: 'empty' }, 'Nessuna partita aperta.') : !d ? h('p', { class: 'empty' }, 'Caricamento…') : [
        h('div', { class: 'campo-head' },
          h('div', null, h('div', { class: 'eyebrow' }, `${d.game.name} · ${STATUS_LABELS[d.game.status]}`), h('div', { class: 'mono small', id: 'gps-now' }, field.gpsText())),
          h('button', { class: 'btn btn-primary btn-block btn-xl', onclick: field.scanSign }, '⌖ Scansiona un cartello'),
          cameraSupported() ? null : h('p', { class: 'muted small' }, 'Scanner e GPS richiedono l\'indirizzo https: scegli dall\'elenco e indica il punto toccando la mappa.')),
        h('nav', { class: 'seg-tabs' },
          tabLink('altari', `Altari ${placedA}/${d.points.length}`),
          tabLink('doni', `Doni ${placedG}/${d.gifts.length}`),
          tabLink('mappa', 'Mappa')),
        F.tab === 'doni' ? field.viewGifts() : F.tab === 'mappa' ? field.viewMap() : field.viewAltars(),
      ]));
}

const tabLink = (id, label) => h('a', { href: `#${id}`, class: F.tab === id ? 'on' : '' }, label);

function viewLogin() {
  return h('main', { class: 'login' },
    h('div', { class: 'emblem big' }, h('span', null, '0')),
    h('h1', null, 'Campo'),
    h('p', { class: 'muted' }, 'Strumento di piazzamento della regia. Gli Eletti trovano le stesse funzioni nella loro app.'),
    h('a', { class: 'btn btn-primary btn-xl btn-block', href: '/regia' }, 'Accedi come regia'),
    h('a', { class: 'btn btn-block', href: '/' }, 'Sono un Eletto: apri la mia app'),
    h('p', { class: 'muted small' }, 'Dopo l\'accesso alla regia torna su questa pagina.'));
}
