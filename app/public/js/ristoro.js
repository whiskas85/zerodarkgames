// Ristoro per il Consiglio: «Ordina» (chiunque sia nel Consiglio o in regia ordina per sé) e «Gestione»
// (addetto con il permesso «Ristoro», o il master): menù, ora limite, ordini e richieste ben separati.
import { h, mount, api, store, STATUS_LABELS } from './lib.js';
import { createFoodOrder, createFoodAdmin } from './food-ui.js';

const $root = document.getElementById('root');
const R = { me: null, games: [], gameId: Number(new URLSearchParams(location.search).get('g')) || store.get('zdg_ristoro_game') };
const LIVE = ['truce', 'hunt', 'last_half_hour', 'paused', 'circle', 'ready', 'draft'];
const canManage = () => R.me?.role === 'master' || R.me?.perms?.includes('ristoro');
const tab = () => (location.hash.slice(1) === 'gestione' && canManage() ? 'gestione' : 'ordina');
const order = createFoodOrder({ base: '/api/v/food', query: () => `?g=${R.gameId}`, rerender: () => render() });
const admin = createFoodAdmin({ gameId: () => R.gameId, rerender: () => render() });

window.addEventListener('hashchange', () => render());
// Aggiornamento ogni 20 secondi (ordini e richieste che arrivano).
setInterval(() => { if (!document.hidden && R.me) { if (tab() === 'gestione') admin.load(); else order.load(); } }, 20000);

(async function boot() {
  try { R.me = (await api('GET', '/api/auth/me')).user; } catch { /* non entrato */ }
  if (R.me) {
    R.games = await api('GET', '/api/v/games').catch(() => []);
    const live = R.games.find((g) => LIVE.includes(g.status));
    if (!R.games.some((g) => g.id === R.gameId)) R.gameId = (live || R.games[0])?.id || null;
  }
  render();
})();

function render() {
  const header = h('header', { class: 'topbar soglia-top' },
    h('div', { class: 'brand' }, h('div', { class: 'emblem sm' }, h('span', null, '0')), h('div', null, h('div', { class: 'brand-t' }, 'Ristoro'), h('div', { class: 'eyebrow' }, R.me ? (R.me.displayName || R.me.username) : 'Consiglio Zero'))),
    h('div', { class: 'top-actions' }, h('a', { class: 'btn btn-sm btn-ghost', href: R.me?.role === 'master' ? '/regia' : '/consiglio' }, '‹ Indietro')));
  if (!R.me) {
    return mount($root, header, h('main', { class: 'content ristoro' }, h('div', { class: 'card stack' }, h('h2', null, 'Accedi'),
      h('p', null, 'Questa pagina è per il Consiglio. Coppie ed Eletti ordinano dalla loro app (Ristoro).'), h('a', { class: 'btn btn-primary btn-block', href: '/' }, 'Vai all\'accesso'))));
  }
  const t = tab();
  const select = h('select', { class: 'input', 'aria-label': 'Partita', onchange: (e) => { R.gameId = Number(e.target.value); store.set('zdg_ristoro_game', R.gameId); order.load(); admin.load(); render(); } },
    R.games.map((g) => h('option', { value: g.id, selected: g.id === R.gameId }, `${g.name} · ${STATUS_LABELS[g.status] || g.status}`)));
  mount($root, header, h('main', { class: 'content ristoro' },
    R.games.length > 1 ? select : null,
    canManage() ? h('nav', { class: 'settings-nav' },
      h('a', { href: '#ordina', class: t === 'ordina' ? 'on' : '' }, '🥪 Ordina per te'),
      h('a', { href: '#gestione', class: t === 'gestione' ? 'on' : '' }, '🧾 Gestione: menù, ordini e richieste')) : null,
    !R.gameId ? h('p', { class: 'empty' }, 'Nessuna partita.') : t === 'gestione' ? admin.view() : order.view()));
}
