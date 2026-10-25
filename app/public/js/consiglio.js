// Consiglio Zero: chi entra con Zero Dark Ops chiede l'accesso; chi è dentro vede solo le azioni che il master gli ha aperto.
import { h, mount, api, toast, dialog, fmtTime, store, STATUS_LABELS } from './lib.js';

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
const tab = () => location.hash.slice(1);
window.addEventListener('hashchange', () => { C.gifts = null; render(); loadTab(); });

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
const header = (sub) => h('header', { class: 'topbar soglia-top' },
  h('div', { class: 'brand' }, h('div', { class: 'emblem sm' }, h('span', null, '0')), h('div', null, h('div', { class: 'brand-t' }, 'Consiglio Zero'), h('div', { class: 'eyebrow' }, sub))),
  h('div', { class: 'top-actions' }, C.me || C.status ? h('button', { class: 'btn btn-sm btn-ghost', onclick: logout }, 'Esci') : null));

function render() {
  if (!C.me) return mount($root, header('Organizzazione dei Giochi'), h('main', { class: 'content council' }, outside()));
  const t = tab();
  const body = t === 'doni' && C.me && allowed().some((a) => a.key === 'doni') ? viewGifts()
    : t === 'annunci' && allowed().some((a) => a.key === 'comunicazioni') ? viewAnnounce() : viewHome();
  mount($root, header(`${C.me.displayName || C.me.username}${C.me.role === 'master' ? ' · regia' : ''}`), h('main', { class: 'content council' }, body));
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

function viewHome() {
  const acts = allowed();
  return [
    acts.length ? h('div', { class: 'council-grid' }, acts.map((a) => h('a', { class: 'council-tile', href: a.href() },
      h('span', { class: 'ico', 'aria-hidden': 'true' }, a.ico), h('span', null, a.label), h('span', { class: 'tiny muted' }, a.hint))))
      : h('div', { class: 'card stack' }, h('h2', null, 'Sei nel Consiglio Zero'), h('p', null, 'Il master non ti ha ancora aperto nessuna azione: quando lo farà le troverai qui.'),
        h('button', { class: 'btn', onclick: () => location.reload() }, 'Aggiorna')),
    h('p', { class: 'muted small' }, h('a', { href: '/#/home' }, 'Vai all\'app dei Giochi')),
  ];
}

function gameSelect() {
  return h('select', { class: 'input', onchange: (e) => { C.gameId = Number(e.target.value); store.set('zdg_consiglio_game', C.gameId); C.gifts = null; render(); loadTab(); } },
    C.games.map((g) => h('option', { value: g.id, selected: g.id === C.gameId }, `${g.name} · ${STATUS_LABELS[g.status] || g.status}`)));
}
const back = () => h('a', { class: 'btn btn-sm btn-ghost', href: '#' }, '‹ Le mie azioni');

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
  const text = h('textarea', { class: 'input', rows: 5, maxlength: 500, placeholder: 'Il testo arriva a tutte le coppie della partita' });
  const send = async () => {
    if (!text.value.trim()) return toast('Scrivi il testo', 'error');
    if (!await dialog({ title: 'Mandare l\'annuncio?', text: text.value.trim(), okLabel: 'Manda' })) return;
    try { await api('POST', `/api/v/games/${C.gameId}/announce`, { text: text.value }); toast('Annuncio mandato', 'ok'); text.value = ''; } catch (e) { toast(e.message, 'error'); }
  };
  return [back(), h('h2', null, 'Annunci'), gameSelect(), text, h('button', { class: 'btn btn-primary btn-block', onclick: send }, 'Manda a tutti')];
}
