// Consiglio Zero: chi entra con Zero Dark Ops chiede l'accesso; chi è dentro vede solo le azioni che il master gli ha aperto.
import { h, mount, api, toast, dialog, fmtTime, store, STATUS_LABELS } from './lib.js';
import { createFoodOrder, createFoodAdmin } from './food-ui.js';

const $root = document.getElementById('root');
const C = { me: null, status: null, games: [], gameId: store.get('zdg_consiglio_game'), gifts: null, busy: false };
const LIVE = ['truce', 'hunt', 'last_half_hour', 'paused', 'circle', 'ready', 'draft'];

// Le azioni: dove portano (pagina) o la scheda qui dentro (#doni, #annunci).
const ACTIONS = [
  { key: 'regia', label: 'Regia', hint: 'La regia completa', ico: '◉', href: () => '/regia' },
  { key: 'accettazione', label: 'Accettazione', hint: 'Iscritti e squadre all\'arrivo', ico: '✓', href: () => `/accettazione${C.gameId ? `?g=${C.gameId}` : ''}` },
  { key: 'armi', label: 'Test repliche', hint: 'Cronografo e spunte', ico: '⌁', href: () => `/armi${C.gameId ? `?g=${C.gameId}` : ''}` },
  { key: 'soglia', label: 'Soglia', hint: 'Validazione all\'uscita', ico: '⛩', href: () => '/soglia' },
  { key: 'campo', label: 'Campo', hint: 'Piazza Altari, punti e doni', ico: '⛰', href: () => '/campo' },
  { key: 'doni', label: 'Lancio doni', hint: 'Fai comparire i doni', ico: '✦', href: () => '#doni' },
  { key: 'comunicazioni', label: 'Annunci', hint: 'Un annuncio a tutte le coppie', ico: '✉', href: () => '#annunci' },
];
const allowed = () => (C.me?.role === 'master' ? ACTIONS : ACTIONS.filter((a) => C.me?.perms?.includes(a.key)));
// Ristoro: tutti nel Consiglio ordinano per sé; l'addetto (permesso «Ristoro») gestisce menù, ordini e richieste.
const canFood = () => C.me?.role === 'master' || C.me?.perms?.includes('ristoro');
const foodOrder = createFoodOrder({ base: '/api/v/food', query: () => `?g=${C.gameId}`, rerender: () => render() });
const foodAdmin = createFoodAdmin({ gameId: () => C.gameId, rerender: () => render(), methodsHref: '#ristoro-pagamenti', otherHref: '#ristoro-altri' });
setInterval(() => { if (document.hidden || !C.me) return; if (tab() === 'ristoro') foodOrder.load(); if (['ristoro-gestione', 'ristoro-menu', 'ristoro-consegna', 'ristoro-pagamenti', 'ristoro-altri'].includes(tab()) || (!tab() && canFood())) foodAdmin.load(); }, 20000);
const tab = () => location.hash.slice(1);
window.addEventListener('hashchange', () => { C.gifts = null; render(); loadTab(); window.scrollTo(0, 0); });

(async function boot() {
  try { C.me = (await api('GET', '/api/auth/me')).user; } catch { /* offline */ }
  if (C.me) {
    C.games = await api('GET', '/api/v/games').catch(() => []);
    const live = C.games.find((g) => LIVE.includes(g.status));
    if (!C.games.some((g) => g.id === C.gameId)) C.gameId = (live || C.games[0])?.id || null;
  } else {
    try { C.status = await api('GET', '/api/council'); } catch { C.status = null; }
  }
  render();
  loadTab();
})();

async function loadTab() {
  if (!C.me || tab() !== 'doni' || !C.gameId) return;
  try { C.gifts = (await api('GET', `/api/v/games/${C.gameId}/gifts`)).gifts; } catch (e) { toast(e.message, 'error'); C.gifts = []; }
  render();
}

const logout = async () => { await api('POST', '/api/auth/logout').catch(() => {}); location.href = '/'; };
// Testata come nelle app: emblema, chi sei e l'avatar con il suo menu (Esci compreso).
function meInfo() {
  const name = C.me?.displayName || C.me?.username || 'Consiglio';
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
  return { name, initials, picture: C.me?.picture || null };
}
const avatarFace = (me, cls = '') => h('span', { class: `avatar ${cls}`, 'aria-hidden': 'true' },
  me.picture ? h('img', { src: me.picture, alt: '', referrerpolicy: 'no-referrer', onerror: (e) => { e.target.replaceWith(document.createTextNode(me.initials)); } }) : me.initials);
function openAvatarMenu(anchor) {
  const old = document.querySelector('.avatar-menu');
  if (old) { old.remove(); return; }
  const me = meInfo();
  const item = (href, icon, label, attrs = {}) => h(href ? 'a' : 'button', { class: 'am-item', role: 'menuitem', ...(href ? { href } : { type: 'button' }), ...attrs }, h('span', { class: 'am-ico', 'aria-hidden': 'true' }, icon), h('span', null, label));
  const menu = h('div', { class: 'avatar-menu', role: 'menu' },
    h('div', { class: 'am-head' }, avatarFace(me, 'lg'), h('div', null, h('strong', null, me.name), h('div', { class: 'tiny muted' }, [C.me?.username ? `@${C.me.username}` : null, C.me?.role === 'master' ? 'Regia' : 'Consiglio Zero'].filter(Boolean).join(' · ')))),
    item('#', '⌂', 'Home'),
    item('#ristoro', '🥪', 'Ristoro: ordina'),
    C.me?.role === 'master' ? item('/regia', '◉', 'Regia') : null,
    item(null, '⏻', 'Esci', { class: 'am-item am-out', onclick: logout }));
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.round(r.bottom + 6)}px`;
  menu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  const close = (ev) => { if (ev && ((menu.contains(ev.target) && !ev.target.closest('a, button')) || ev.target.closest?.('.avatar-btn'))) return; menu.remove(); document.removeEventListener('click', close, true); window.removeEventListener('hashchange', close); };
  setTimeout(() => { document.addEventListener('click', close, true); window.addEventListener('hashchange', close); }, 0);
  document.body.append(menu);
}
const header = (sub) => h('header', { class: 'topbar council-top' },
  tab() ? h('a', { class: 'council-back', href: '#', 'aria-label': 'Torna alla home' }, '‹') : h('div', { class: 'emblem sm' }, h('span', null, '0')),
  h('div', { class: 'council-id' }, h('div', { class: 'brand-t' }, 'Consiglio Zero'), h('div', { class: 'eyebrow' }, sub)),
  C.me ? h('button', { type: 'button', class: 'avatar-btn', 'aria-label': `Menu di ${meInfo().name}`, 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); openAvatarMenu(e.currentTarget); } }, avatarFace(meInfo()))
    : C.status ? h('button', { class: 'btn btn-sm btn-ghost', onclick: logout }, 'Esci') : null);

// Nuova versione: si controlla all'avvio, ogni minuto e quando si torna sull'app; la barra verde resta sotto la testata.
async function checkVersion() {
  try {
    const v = (await api('GET', '/api/version')).version;
    if (!v) return;
    if (!C.bootVersion) C.bootVersion = v;
    else if (v !== C.bootVersion && !C.newVersion) { C.newVersion = true; render(); }
  } catch { /* senza rete */ }
}
checkVersion();
setInterval(() => { if (!document.hidden) checkVersion(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });
const updateBar = () => (C.newVersion ? h('button', { type: 'button', class: 'update-banner', onclick: () => location.reload() }, h('strong', null, '⟳ Nuova versione dell\'app'), h('span', null, ' · tocca qui per aggiornare')) : null);
function fitTop() { const tb = $root.querySelector('.topbar'); if (tb) document.documentElement.style.setProperty('--top-h', `${tb.offsetHeight}px`); }

// Ridisegnare (aggiornamento ogni 20 s, nuova versione…) non deve cancellare quello che si sta scrivendo:
// i campi con data-keep tengono valore, focus e cursore.
function render() {
  const keep = {};
  for (const el of $root.querySelectorAll('[data-keep]')) keep[el.dataset.keep] = el.value;
  const a = document.activeElement;
  const focus = a?.dataset?.keep || null;
  let sel = null;
  try { sel = focus ? [a.selectionStart, a.selectionEnd] : null; } catch { /* select */ }
  const page = location.hash;
  const same = render.page === page;
  render.page = page;
  _render();
  if (same) {
    for (const el of $root.querySelectorAll('[data-keep]')) if (keep[el.dataset.keep] != null && !el.dataset.fresh) el.value = keep[el.dataset.keep];
    const el = focus && $root.querySelector(`[data-keep="${focus}"]`);
    if (el) { el.focus({ preventScroll: true }); try { if (sel) el.setSelectionRange(...sel); } catch { /* select */ } }
  }
  fitTop();
}
function _render() {
  if (!C.me) return mount($root, header('Organizzazione dei Giochi'), updateBar(), h('main', { class: 'content council' }, outside()));
  const t = tab();
  const body = t === 'doni' && C.me && allowed().some((a) => a.key === 'doni') ? viewGifts()
    : t === 'annunci' && allowed().some((a) => a.key === 'comunicazioni') ? viewAnnounce()
    : t === 'ristoro' ? [C.games.length > 1 ? gameSelect() : null, foodOrder.view()]
    : t === 'ristoro-gestione' && canFood() ? [C.games.length > 1 ? gameSelect() : null, foodAdmin.view('orders')]
    : t === 'ristoro-menu' && canFood() ? [C.games.length > 1 ? gameSelect() : null, foodAdmin.view('menu')]
    : t === 'ristoro-consegna' && canFood() ? [C.games.length > 1 ? gameSelect() : null, foodAdmin.view('delivery')]
    : t === 'ristoro-pagamenti' && canFood() ? [C.games.length > 1 ? gameSelect() : null, foodAdmin.view('methods')]
    : t === 'ristoro-altri' && canFood() ? [C.games.length > 1 ? gameSelect() : null, foodAdmin.view('other')] : viewHome();
  const sub = { doni: 'Lancio doni', annunci: 'Annunci', ristoro: 'Ristoro · ordina', 'ristoro-gestione': 'Ristoro · ordini e richieste', 'ristoro-menu': 'Ristoro · menù', 'ristoro-consegna': 'Ristoro · ritiro', 'ristoro-pagamenti': 'Ristoro · metodi di pagamento' }[t] || (C.me.displayName || C.me.username);
  mount($root, header(sub), updateBar(), h('main', { class: 'content council' }, body));
}

// Fuori dall'organizzazione: la richiesta (solo per chi è entrato con Zero Dark Ops).
function outside() {
  const s = C.status;
  if (!s) {
    return h('div', { class: 'card stack' }, h('h2', null, 'Accedi'), h('p', null, 'Entra con il tuo account (o con Zero Dark Ops) e torna qui per chiedere l\'accesso al Consiglio.'),
      h('a', { class: 'btn btn-primary btn-block', href: '/' }, 'Vai all\'accesso'));
  }
  const send = async (method) => {
    try { C.status = await api(method, '/api/council/request'); toast(method === 'POST' ? 'Richiesta inviata al Consiglio' : 'Richiesta ritirata', 'ok'); render(); } catch (e) { toast(e.message, 'error'); }
  };
  if (!s.canRequest) {
    return h('div', { class: 'card stack' }, h('h2', null, 'Consiglio Zero'),
      h('p', null, 'L\'accesso al Consiglio si chiede entrando con ', h('strong', null, 'Zero Dark Ops'), '. Collega il gestionale dal tuo profilo, poi torna qui.'),
      h('a', { class: 'btn btn-block', href: '/iscrizione#profilo' }, 'Il mio profilo'));
  }
  if (s.requestedAt) {
    return h('div', { class: 'card stack' }, h('h2', null, 'Richiesta inviata'),
      h('p', null, `Dal ${new Date(s.requestedAt).toLocaleDateString('it-IT')} alle ${fmtTime(s.requestedAt)} la tua richiesta aspetta il master: sceglierà le azioni che potrai fare (Accettazione, Test repliche, Soglia, Campo, Doni, Annunci).`),
      h('p', { class: 'muted small' }, 'Quando ti accetta, riapri questa pagina: vedrai le tue azioni.'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => location.reload() }, 'Controlla'), h('button', { class: 'btn btn-ghost', onclick: () => send('DELETE') }, 'Ritira la richiesta')));
  }
  return h('div', { class: 'card stack' }, h('h2', null, 'Entra nel Consiglio Zero'),
    h('p', null, 'Fai parte del club e dai una mano all\'evento? Chiedi l\'accesso: il master sceglierà cosa potrai fare (accettazione, test repliche, soglia, campo, lancio dei doni, annunci).'),
    h('button', { class: 'btn btn-primary btn-block', onclick: () => send('POST') }, 'Chiedi di entrare'));
}

// Home come nelle app: le azioni aperte dal master (oro) e, a parte, il Ristoro (arancio).
const ctile = (a) => h('a', { class: 'tile', href: a.href() }, h('span', { class: 'tile-ico', 'aria-hidden': 'true' }, a.ico), h('span', null, a.label), h('span', { class: 'tiny muted' }, a.hint));
function viewHome() {
  const acts = allowed();
  const food = [
    { label: 'Panini e bevande', hint: 'Ordina per te', ico: '🥪', href: () => '#ristoro' },
    canFood() ? { label: 'Ordina per altri', hint: 'Al banco, anche già pagato', ico: '🧾', href: () => '#ristoro-altri' } : null,
    canFood() ? { label: 'Menù', hint: 'Voci e prezzi indicativi', ico: '📋', href: () => '#ristoro-menu' } : null,
    canFood() ? { label: 'Ordini e richieste', hint: 'Ora limite e da preparare', ico: '🧾', href: () => '#ristoro-gestione' } : null,
    canFood() ? { label: 'Ritiro', hint: 'Chi ha ordinato, consegna e paga', ico: '💶', href: () => '#ristoro-consegna' } : null,
    canFood() ? { label: 'Metodi di pagamento', hint: 'Contanti, Satispay, PayPal', ico: '💳', href: () => '#ristoro-pagamenti' } : null,
  ].filter(Boolean);
  return h('div', { class: 'tile-groups' },
    C.games.length > 1 ? gameSelect() : null,
    // Chi gestisce la cucina vede prima il Ristoro, con il cruscotto; le azioni di gioco solo se il master le ha aperte.
    canFood() ? h('section', { class: 'tile-group g-food' }, h('div', { class: 'eyebrow' }, 'Ristoro'),
      foodAdmin.dashboard((page) => (page === 'orders' ? '#ristoro-gestione' : '#ristoro-consegna')), h('nav', { class: 'grid' }, food.map(ctile))) : null,
    acts.length ? h('section', { class: 'tile-group g-game' }, h('div', { class: 'eyebrow' }, 'Le tue azioni'), h('nav', { class: 'grid' }, acts.map(ctile)))
      : canFood() ? null : h('div', { class: 'card stack-sm' }, h('strong', null, 'Sei nel Consiglio Zero'), h('p', { class: 'small muted' }, 'Il master non ti ha ancora aperto azioni di gioco: quando lo farà le troverai qui.')),
    canFood() ? null : h('section', { class: 'tile-group g-food' }, h('div', { class: 'eyebrow' }, 'Ristoro'), h('nav', { class: 'grid' }, food.map(ctile))));
}

function gameSelect() {
  return h('select', { class: 'input', onchange: (e) => { C.gameId = Number(e.target.value); store.set('zdg_consiglio_game', C.gameId); C.gifts = null; foodOrder.load(); foodAdmin.load(); render(); loadTab(); } },
    C.games.map((g) => h('option', { value: g.id, selected: g.id === C.gameId }, `${g.name} · ${STATUS_LABELS[g.status] || g.status}`)));
}
const back = () => null;

const GIFT_STATE = { draft: 'da piazzare', placed: 'piazzato · pronto', revealed: 'comparso', claimed: 'preso', expired: 'svanito' };
function viewGifts() {
  const list = C.gifts;
  const reveal = async (g) => {
    if (!await dialog({ title: `Far comparire ${g.label}?`, text: 'Le coppie lo vedranno sulla mappa e arriverà l\'annuncio.', okLabel: 'Fai comparire' })) return;
    try { await api('POST', `/api/v/gifts/${g.id}/reveal`); toast('Dono comparso', 'ok'); loadTab(); } catch (e) { toast(e.message, 'error'); }
  };
  return [back(), h('h2', null, 'Lancio doni'), gameSelect(),
    !list ? h('p', { class: 'empty' }, 'Caricamento…') : !list.length ? h('p', { class: 'empty' }, 'Nessun dono in questa partita.')
      : h('div', { class: 'gift-list' }, list.map((g) => h('div', { class: 'gift-row' },
        h('span', { class: 'g-ico', style: g.color ? `color:${g.color}` : null, 'aria-hidden': 'true' }, g.icon || '✦'),
        h('div', { class: 'g-main' }, h('strong', null, g.label), h('span', { class: 'tiny muted' }, [g.name, GIFT_STATE[g.status] || g.status, g.revealedAt ? `alle ${fmtTime(g.revealedAt)}` : null].filter(Boolean).join(' · '))),
        g.status === 'placed' ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => reveal(g) }, 'Fai comparire') : null))),
    h('button', { class: 'btn btn-ghost', onclick: () => loadTab() }, 'Aggiorna')];
}

function viewAnnounce() {
  const text = h('textarea', { class: 'input', rows: 5, maxlength: 500, placeholder: 'Il testo arriva a tutte le coppie della partita', 'data-keep': 'announce', value: C.announce || '', oninput: (e) => { C.announce = e.target.value; } });
  const send = async () => {
    if (!text.value.trim()) return toast('Scrivi il testo', 'error');
    if (!await dialog({ title: 'Mandare l\'annuncio?', text: text.value.trim(), okLabel: 'Manda' })) return;
    try { await api('POST', `/api/v/games/${C.gameId}/announce`, { text: text.value }); toast('Annuncio mandato', 'ok'); text.value = ''; C.announce = ''; } catch (e) { toast(e.message, 'error'); }
  };
  return [back(), h('h2', null, 'Annunci'), gameSelect(), text, h('button', { class: 'btn btn-primary btn-block', onclick: send }, 'Manda a tutti')];
}
