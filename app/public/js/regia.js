// Dashboard della regia (utente MASTER): preparazione, motore di gioco, comunicazioni.
import { h, mount, api, makeClock, fmtDuration, fmtTime, fmtMin, ghost, toast, dialog, stream, enablePush, store, STATUS_LABELS, voiceSupported, startRecording, uploadAudio, voicePlayer, fmtSec } from './lib.js';
import { createMapView } from './map.js';

const $root = document.getElementById('root');
const clock = makeClock();
const R = {
  me: null,
  games: [],
  gameId: store.get('zdg_regia_game'),
  ms: null,
  baseUrl: location.origin,
  users: [],
  msgTeam: null,
  showAll: false,
  seenRevealed: null,
};

const TABS = [
  ['live', 'Regia'],
  ['coppie', 'Iscrizioni e coppie'],
  ['settori', 'Settori e Altari'],
  ['altari', 'Altari e Parola'],
  ['sigilli', 'Sigilli e tradimenti'],
  ['mappa', 'Mappa e campo'],
  ['doniqr', 'Doni QR'],
  ['doni', 'Armamenti'],
  ['comunicazioni', 'Annunci e messaggi'],
  ['avvisi', 'Avvisi'],
  ['classifica', 'Classifica'],
  ['registro', 'Registro'],
  ['impostazioni', 'Impostazioni'],
];
const ACTIVE = ['truce', 'hunt', 'last_half_hour'];
const PRE = ['draft', 'ready', 'circle'];

const tab = () => (location.hash.slice(1) || 'live');

// ---------------------------------------------------------------- avvio

(async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.addEventListener('hashchange', () => { render(); if (FIELD_TABS.includes(tab())) loadField(); });
  setInterval(tick, 1000);
  try {
    const me = await api('GET', '/api/auth/me');
    R.me = me.user;
  } catch { /* offline */ }
  if (R.me?.role === 'master') await start();
  else render();
})();

async function start() {
  try { R.baseUrl = (await api('GET', '/api/m/base-url')).baseUrl; } catch { /* default */ }
  await loadGames();
  stream('/api/stream?as=staff', {
    open: () => load(),
    refresh: (d) => { if (d.gameId === R.gameId || d.gameId == null) load(); },
  });
  await load();
}

async function loadGames() {
  R.games = await api('GET', '/api/m/games');
  if (!R.games.some((g) => g.id === R.gameId)) R.gameId = R.games[0]?.id || null;
  store.set('zdg_regia_game', R.gameId);
}

let loading = null;
async function load() {
  if (!R.gameId) { R.ms = null; render(); return; }
  if (loading) { loading.again = true; return; }
  loading = {};
  try {
    const ms = await api('GET', `/api/m/games/${R.gameId}/state`);
    R.ms = ms;
    if (FIELD_TABS.includes(tab())) await loadField(false);
    clock.set(ms.clock);
    const g = R.games.find((x) => x.id === R.gameId);
    if (g) g.status = ms.game.status;
  } catch (e) {
    if (e.status === 401) { R.me = null; }
    else if (e.status === 404) { await loadGames(); }
    else toast(e.message, 'error');
  }
  const again = loading.again;
  loading = null;
  render();
  if (again) load();
}

async function call(method, url, body, okMsg) {
  try {
    const r = await api(method, url, body);
    if (okMsg) toast(okMsg, 'ok');
    await load();
    return r ?? true;
  } catch (e) {
    toast(e.message, 'error', 7000);
    return null;
  }
}
const G = (path) => `/api/m/games/${R.gameId}${path}`;

async function confirmCall(title, text, method, url, body, okMsg, danger = false) {
  if (!(await dialog({ title, text, okLabel: 'Conferma', danger }))) return null;
  return call(method, url, body, okMsg);
}

// ---------------------------------------------------------------- render

function preserve(fn) {
  const keep = {};
  for (const el of $root.querySelectorAll('[data-keep]')) keep[el.dataset.keep] = el.type === 'checkbox' ? el.checked : el.value;
  const a = document.activeElement;
  const focus = a?.dataset?.keep;
  let sel = null;
  try { sel = focus ? [a.selectionStart, a.selectionEnd] : null; } catch { /* select */ }
  const scroll = document.querySelector('.content')?.scrollTop;
  fn();
  for (const el of $root.querySelectorAll('[data-keep]')) {
    const v = keep[el.dataset.keep];
    if (v === undefined || el.dataset.fresh) continue;
    if (el.type === 'checkbox') el.checked = v; else el.value = v;
  }
  if (focus) {
    const el = $root.querySelector(`[data-keep="${CSS.escape(focus)}"]`);
    if (el) { el.focus(); try { if (sel) el.setSelectionRange(...sel); } catch { /* select */ } }
  }
  const c = document.querySelector('.content');
  if (c && scroll) c.scrollTop = scroll;
}

function render() {
  if (!R.me || R.me.role !== 'master') return mount($root, viewLogin());
  preserve(() => {
    const ms = R.ms;
    const body = tab() === 'settori' ? viewSectors() : !R.gameId ? viewNewGame(true) : !ms ? h('p', { class: 'empty' }, 'Caricamento…') : ({
      live: viewLive, coppie: viewTeams, altari: viewAltars, sigilli: viewCodes, doni: viewSupply, mappa: viewFieldMap, doniqr: viewGiftsQR,
      comunicazioni: viewComms, avvisi: viewNotices, classifica: viewStandings, registro: viewLog, impostazioni: viewSettings,
    }[tab()] || viewLive)();
    mount($root, topbar(), h('div', { class: 'shell' }, sidebar(), h('section', { class: 'content' }, body)));
  });
  tick();
}

function topbar() {
  const ms = R.ms;
  const st = ms?.clock.status;
  return h('header', { class: 'topbar' },
    h('div', { class: 'brand' }, h('div', { class: 'emblem sm' }, h('span', null, '0')), h('div', null, h('div', { class: 'brand-t' }, 'Consiglio Zero'), h('div', { class: 'eyebrow' }, 'Regia · Zero Dark Games'))),
    h('select', { class: 'input game-select', 'aria-label': 'Partita', onchange: (e) => { if (e.target.value === 'new') { location.hash = 'impostazioni'; R.gameId = null; render(); return; } R.gameId = Number(e.target.value); store.set('zdg_regia_game', R.gameId); R.ms = null; R.seenRevealed = null; load(); } },
      R.games.map((g) => h('option', { value: g.id, selected: g.id === R.gameId }, `${g.name} · ${STATUS_LABELS[g.status]}`)),
      h('option', { value: 'new' }, '+ Nuova partita')),
    ms ? h('div', { class: 'top-clock' },
      h('span', { class: `chip status-${st}` }, STATUS_LABELS[st]),
      h('div', null, h('div', { class: 'mono clock-big', 'data-clock': 'remaining' }, '—'), h('div', { class: 'mono muted tiny' }, 'trascorso ', h('span', { 'data-clock': 'elapsed' }, '—')))) : null,
    h('div', { class: 'top-actions' },
      R.gameId ? h('a', { class: 'btn btn-sm', href: `/tabellone?g=${R.gameId}`, target: '_blank' }, 'Tabellone') : null,
      h('a', { class: 'btn btn-sm', href: '/soglia', target: '_blank' }, 'Soglia'),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: async () => { await api('POST', '/api/auth/logout'); location.reload(); } }, 'Esci')));
}

function sidebar() {
  const unread = (R.ms?.teams.reduce((a, t) => a + t.unread, 0) || 0) + (R.ms?.elect?.unread || 0);
  const pending = R.ms?.players.filter((p) => p.status === 'pending').length || 0;
  const errors = R.ms?.readiness.issues.filter((i) => i.level === 'error').length || 0;
  return h('nav', { class: 'sidebar' }, TABS.map(([id, label]) => h('a', { href: `#${id}`, class: tab() === id ? 'on' : '' }, label,
    id === 'comunicazioni' && unread ? h('span', { class: 'badge badge-alert' }, unread) : null,
    id === 'coppie' && pending ? h('span', { class: 'badge badge-alert', title: 'Iscrizioni da approvare' }, pending) : null,
    id === 'live' && errors && PRE.includes(R.ms?.clock.status) ? h('span', { class: 'badge' }, errors) : null)));
}

function tick() {
  const recEl = document.getElementById('rec-time-regia');
  if (recEl && R.rec) recEl.textContent = fmtSec(Date.now() - R.rec.startedAt);
  const c = clock.snap;
  for (const el of document.querySelectorAll('[data-clock]')) {
    const k = el.dataset.clock;
    let t = '—';
    if (c) {
      if (k === 'remaining') t = c.startedAt ? fmtDuration(clock.remaining()) : fmtDuration(c.durationMs);
      else if (k === 'elapsed') t = fmtDuration(clock.elapsed());
      else if (k.startsWith('until:')) {
        const at = Number(k.slice(6));
        t = c.startedAt ? fmtDuration(Math.max(0, at - clock.elapsed())) : fmtMin(at / 60000);
      }
    }
    if (el.textContent !== t) el.textContent = t;
  }
}

// ---------------------------------------------------------------- login

function viewLogin() {
  const u = h('input', { class: 'input', autocomplete: 'username', placeholder: 'utente', required: true });
  const p = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'password', required: true });
  return h('main', { class: 'login-page' },
    h('form', { class: 'card login-card', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const me = await api('POST', '/api/auth/login', { username: u.value, password: p.value });
        if (me.role !== 'master') { toast('Questo account è un validatore: usa la pagina Soglia', 'error'); setTimeout(() => (location.href = '/soglia'), 1200); return; }
        R.me = me;
        await start();
      } catch (err) { toast(err.message, 'error'); }
    } },
    h('div', { class: 'emblem' }, h('span', null, '0')),
    h('h1', null, 'Regia'),
    h('p', { class: 'muted' }, 'Accesso riservato al Consiglio Zero.'),
    h('label', { class: 'field' }, h('span', null, 'Utente'), u),
    h('label', { class: 'field' }, h('span', null, 'Password'), p),
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Entra')));
}

// ---------------------------------------------------------------- componenti

const section = (title, ...children) => h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, title)), ...children);
const sectionActions = (title, actions, ...children) => h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, title), h('div', { class: 'row-actions' }, actions)), ...children);

// Sigillo reale sfocato: visibile solo tenendo premuto (o con "mostra tutti").
function secret(code, revealedNow = false) {
  const el = h('span', { class: `secret mono ${R.showAll ? 'peek' : ''} ${revealedNow ? 'unveil' : ''}`, title: 'Tieni premuto per vedere' }, code);
  const on = () => el.classList.add('peek');
  const off = () => { if (!R.showAll) el.classList.remove('peek'); };
  el.addEventListener('pointerdown', on);
  el.addEventListener('pointerup', off);
  el.addEventListener('pointerleave', off);
  el.addEventListener('pointercancel', off);
  return el;
}

function bar(n, total) {
  return h('div', { class: 'fbar', title: `${n}/${total}` }, Array.from({ length: total || 0 }, (_, i) => h('i', { class: i < n ? 'on' : '' })));
}

function teamLabel(t) {
  return t ? `${t.roman || ''} ${t.sectorName || 'senza Settore'}${t.displayName ? ' · ' + t.displayName : ''}` : '';
}

// ---------------------------------------------------------------- REGIA LIVE

function controlButtons() {
  const st = R.ms.clock.status;
  const b = [];
  const act = (action, label, cls = '', title, text, danger) => h('button', { class: `btn ${cls}`, onclick: () => confirmCall(title, text, 'POST', G('/action'), { action }, null, danger) }, label);
  if (st === 'draft') b.push(act('ready', 'Segna pronta', 'btn-primary', 'Partita pronta?', 'Le coppie potranno accedere e leggere il regolamento. Le iscrizioni si chiudono.'));
  if (st === 'ready') b.push(act('circle', 'Apri il cerchio', 'btn-primary', 'Aprire il cerchio?', 'Ogni coppia vedrà il proprio Sigillo.'), act('draft', 'Torna in preparazione', '', 'Tornare in preparazione?', 'La partita torna modificabile.'));
  if (st === 'circle') b.push(act('start', 'VIA!', 'btn-primary btn-go', 'Dare il VIA?', 'Parte l\'orologio di partita: tregua di ' + R.ms.game.truceMin + ' minuti, poi la caccia. Tutte le coppie ricevono l\'annuncio.'), act('draft', 'Torna in preparazione', '', 'Tornare in preparazione?', 'Le coppie non vedranno più il Sigillo fino al prossimo cerchio.'));
  if (ACTIVE.includes(st)) b.push(act('pause', 'Sospendi', 'btn-danger', 'Sospendere la partita?', 'Tutti gli orologi e il calendario si fermano. Banner rosso su tutti i dispositivi.', true), act('end', 'Termina', '', 'Terminare la partita?', 'Gli Altari si chiudono e si calcola la classifica finale.', true));
  if (st === 'paused') b.push(act('resume', 'Riprendi', 'btn-primary', 'Riprendere la partita?', 'Gli orologi ripartono da dove si erano fermati.'), act('end', 'Termina', '', 'Terminare la partita?', 'Gli Altari si chiudono e si calcola la classifica finale.', true));
  return b;
}

function viewLive() {
  const ms = R.ms;
  const c = ms.clock;
  const st = c.status;
  const n = ms.next;
  const revealed = new Set(ms.codes.filter((x) => x.state === 'revealed').map((x) => x.sectorId));
  const fresh = R.seenRevealed ? [...revealed].filter((s) => !R.seenRevealed.has(s)) : [];
  R.seenRevealed = revealed;

  return h('div', { class: 'live' },
    h('div', { class: `control status-bg-${st}` },
      h('div', null, h('div', { class: 'eyebrow' }, ms.game.name), h('div', { class: 'control-status' }, STATUS_LABELS[st]),
        c.startedAt ? h('div', { class: 'muted mono' }, ms.game.isDemo ? `Tempo simulato · durata ${ms.game.durationMin} min` : `Via alle ${fmtTime(c.startedAt)} · durata ${ms.game.durationMin} min`) : h('div', { class: 'muted mono' }, `Durata ${ms.game.durationMin} min · ${ms.teams.length} coppie`)),
      h('div', { class: 'control-clock' }, h('div', { class: 'eyebrow' }, 'Rimanente'), h('div', { class: 'mono huge', 'data-clock': 'remaining' }, '—')),
      h('div', { class: 'control-actions' }, controlButtons())),

    ms.game.isDemo ? demoPanel() : null,

    PRE.includes(st) ? readinessPanel() : null,

    h('div', { class: 'cols-3' },
      nextCard('Prossimo tradimento', n.revelation
        ? [h('div', { class: 'next-sector' }, `Settore ${n.revelation.sectorName}`),
          h('div', { class: 'next-ghost mono' }, ghost(`next:${n.revelation.sectorId}`, ms.game.codeLength, 'ghost-strong')),
          h('div', { class: 'mono big', 'data-clock': `until:${n.revelation.atMs}` }, '—'),
          h('div', { class: 'muted tiny' }, `a ${fmtMin(n.revelation.atMs / 60000)} dal via`),
          ACTIVE.includes(st) ? h('div', { class: 'row-actions' },
            h('button', { class: 'btn btn-sm btn-primary', onclick: () => confirmCall('Rivelare adesso?', `Il Sigillo del Settore ${n.revelation.sectorName} sarà annunciato a tutte le coppie.`, 'POST', `/api/m/revelations/${n.revelation.id}/reveal`, {}, 'Sigillo rivelato') }, 'Rivela ora'),
            h('button', { class: 'btn btn-sm', onclick: () => call('POST', `/api/m/revelations/${n.revelation.id}/postpone`, { minutes: 5 }, 'Posticipata di 5 minuti') }, '+5 min'),
            h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Saltare questa rivelazione?', 'Il Settore uscirà dal calendario.', 'POST', `/api/m/revelations/${n.revelation.id}/skip`, {}, 'Rivelazione saltata') }, 'Salta')) : null]
        : h('p', { class: 'empty' }, 'Nessuna rivelazione in calendario.')),
      nextCard('Prossimi doni', n.supply
        ? [h('div', { class: 'mono big', 'data-clock': `until:${n.supply.atMs}` }, '—'), h('div', { class: 'muted tiny' }, `a ${fmtMin(n.supply.atMs / 60000)} · ${n.supply.description || ''}`),
          ACTIVE.includes(st) ? h('button', { class: 'btn btn-sm', onclick: () => confirmCall('Lanciare i doni adesso?', 'Parte l\'annuncio a tutte le coppie.', 'POST', `/api/m/supply/${n.supply.id}/fire`, {}, 'Doni lanciati') }, 'Lancia ora') : null]
        : [h('p', { class: 'empty' }, 'Nessuna finestra a orario.'), h('a', { class: 'btn btn-sm', href: '#doni' }, 'Gestisci doni')]),
      nextCard('Tappe', [
        h('div', { class: 'milestone' }, h('span', null, 'Apertura caccia'), h('span', { class: 'mono', 'data-clock': `until:${n.huntAtMs}` }, '—')),
        h('div', { class: 'milestone' }, h('span', null, 'Ultima mezz\'ora'), h('span', { class: 'mono', 'data-clock': `until:${n.lastPhaseAtMs}` }, '—')),
        h('div', { class: 'milestone' }, h('span', null, 'Fine'), h('span', { class: 'mono', 'data-clock': `until:${n.endAtMs}` }, '—'))])),

    sectionActions('Coppie in gioco', [h('a', { class: 'btn btn-sm', href: '#coppie' }, 'Gestisci')],
      ms.teams.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Settore', 'Legati', 'Frammenti', 'Ultimo sblocco', 'Stato', 'Online', ''].map((x) => h('th', null, x)))),
        h('tbody', null, ms.teams.map((t) => h('tr', { class: t.status !== 'active' ? `row-${t.status}` : '' },
          h('td', null, h('strong', null, `${t.roman || ''} ${t.sectorName || '—'}`), t.displayName ? h('div', { class: 'tiny muted' }, t.displayName) : null),
          h('td', { class: 'tiny' }, t.members.map((m) => m.nickname || m.name).join(' · ')),
          h('td', null, h('div', { class: 'mono' }, `${t.fragments}/${t.fragmentsTotal}`), bar(t.fragments, t.fragmentsTotal)),
          h('td', { class: 'tiny' }, t.lastUnlock ? `${t.lastUnlock.label} · ${fmtTime(t.lastUnlock.acquiredAt)}` : '—'),
          h('td', null, t.status === 'won' ? h('span', { class: 'chip chip-ok' }, `${t.finishPosition}° posto`) : t.status === 'withdrawn' ? h('span', { class: 'chip' }, 'ritirata') : h('span', { class: 'chip chip-brass' }, 'in gioco')),
          h('td', null, h('span', { class: `dot ${t.online ? 'dot-ok' : ''}` }), ' ', t.online || ''),
          h('td', { class: 'row-actions' },
            h('button', { class: 'btn btn-sm', onclick: () => { R.msgTeam = t.id; location.hash = 'comunicazioni'; } }, t.unread ? `Messaggi (${t.unread})` : 'Messaggio'),
            h('button', { class: 'btn btn-sm btn-ghost', onclick: () => fragmentsDialog(t) }, 'Frammenti'))))))) : h('p', { class: 'empty' }, 'Nessuna coppia formata.')),

    h('div', { class: 'cols-2' },
      sectionActions('Sigilli', [h('button', { class: 'btn btn-sm btn-ghost', onclick: toggleShowAll }, R.showAll ? 'Nascondi' : 'Mostra tutti')], codesGrid(fresh)),
      section('Annuncio libero', quickAnnounce(), h('h3', { class: 'sub' }, 'Feed eventi'), eventFeed(25))));
}

function demoPanel() {
  const st = R.ms.clock.status;
  const active = ACTIVE.includes(st);
  const adv = (m) => h('button', { class: 'btn btn-sm', disabled: !active, onclick: () => call('POST', G('/advance'), { minutes: m }, `Tempo avanzato di ${m} minuti`) }, `+${m} min`);
  return h('div', { class: 'panel demo' },
    h('div', { class: 'panel-head' }, h('h2', null, 'Partita di prova'), h('span', { class: 'chip chip-brass' }, 'solo test')),
    h('p', { class: 'muted tiny' }, active
      ? "Fai passare il tempo di gioco per vedere subito tregua → caccia, tradimenti, doni, ultima mezz'ora e fine. Le coppie ricevono tutto come in una partita vera."
      : "I pulsanti si attivano dopo il VIA (non in pausa). Per entrare come coppia usa \"Apri app\" nella scheda Iscrizioni e coppie, oppure il codice d'accesso da un altro telefono o da una finestra in incognito."),
    h('div', { class: 'row-actions' }, adv(1), adv(5), adv(15), adv(30), adv(60)));
}

async function createDemo() {
  const n = await dialog({ title: 'Nuova partita di prova', text: 'Quante coppie? (2-12) Giocatori finti già accoppiati, Sigilli, Parola e un dono a 60 minuti. Nelle partite di prova puoi far avanzare il tempo.', input: { type: 'number', value: '6' }, okLabel: 'Crea' });
  if (!n) return;
  try {
    const r = await api('POST', '/api/m/demo', { teams: Number(n) });
    await loadGames();
    R.gameId = r.id;
    store.set('zdg_regia_game', r.id);
    R.ms = null;
    R.seenRevealed = null;
    location.hash = 'live';
    toast('Partita di prova pronta: segna pronta, apri il cerchio e dai il VIA', 'ok', 7000);
    load();
  } catch (e) { toast(e.message, 'error', 7000); }
}

function nextCard(title, content) {
  return h('div', { class: 'panel next' }, h('div', { class: 'eyebrow' }, title), content);
}

// SVG con la stessa sintassi di h().
function svg(tag, attrs, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) el.setAttribute(k, v);
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

// Sigillo del setup: una ciambella in 4 spicchi (I Coppie, II Sigilli, III Altari e Parola, IV Doni).
function setupSeal(r) {
  const C = 110;
  const R = 78;
  const GAP = 7;
  const pt = (deg, rad = R) => {
    const a = (deg * Math.PI) / 180;
    return `${(C + rad * Math.cos(a)).toFixed(2)} ${(C + rad * Math.sin(a)).toFixed(2)}`;
  };
  const done = r.parts.filter((x) => x.done).length;
  return svg('svg', { class: 'setup-seal', viewBox: '0 0 220 220', role: 'img', 'aria-label': `Setup: ${done} parti su 4 completate${r.ok ? ', pronto per il cerchio' : ''}` },
    svg('circle', { class: 'seal-outer', cx: C, cy: C, r: 104 }),
    svg('circle', { class: 'seal-track', cx: C, cy: C, r: R }),
    r.parts.map((part, i) => {
      const a0 = -90 + i * 90 + GAP / 2;
      const a1 = a0 + 90 - GAP;
      const mid = (a0 + a1) / 2;
      const state = part.done ? 'done' : part.optional ? 'optional' : 'todo';
      return svg('a', { href: part.href, class: `seal-part seal-${state}` },
        svg('title', null, `${part.roman} · ${part.label}: ${part.done ? 'completo' : part.optional ? 'facoltativo' : 'da completare'} — ${part.detail}`),
        svg('path', { d: `M ${pt(a0)} A ${R} ${R} 0 0 1 ${pt(a1)}` }),
        svg('text', { x: pt(mid).split(' ')[0], y: pt(mid).split(' ')[1], 'dominant-baseline': 'central', 'text-anchor': 'middle' }, part.roman));
    }),
    svg('circle', { class: 'seal-inner', cx: C, cy: C, r: 54 }),
    svg('text', { class: 'seal-count', x: C, y: C - 4, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, `${done}/4`),
    svg('text', { class: 'seal-caption', x: C, y: C + 24, 'text-anchor': 'middle' }, r.ok ? 'PRONTO' : 'AL CERCHIO'));
}

function readinessPanel() {
  const r = R.ms.readiness;
  const warns = r.issues.filter((i) => i.level === 'warn');
  return h('div', { class: `panel readiness ${r.ok ? 'ok' : ''}` },
    h('div', { class: 'panel-head' }, h('h2', null, r.ok ? 'Setup completo: si può aprire il cerchio' : 'Setup da completare')),
    h('div', { class: 'setup-grid' },
      setupSeal(r),
      h('ol', { class: 'setup-parts' }, r.parts.map((part) => {
        const errs = r.issues.filter((i) => i.part === part.key && i.level === 'error');
        const state = part.done ? 'done' : part.optional ? 'optional' : 'todo';
        return h('li', { class: `setup-part sp-${state}` },
          h('a', { href: part.href },
            h('span', { class: 'sp-roman' }, part.roman),
            h('span', { class: 'sp-body' },
              h('strong', null, part.label, part.optional ? h('span', { class: 'tiny muted' }, ' · facoltativo') : null),
              errs.length > 1 ? h('span', { class: 'tiny' }, errs.map((e) => e.text).join(' · ')) : h('span', { class: 'tiny' }, part.detail)),
            h('span', { class: 'sp-mark', 'aria-hidden': 'true' }, part.done ? '✓' : part.optional ? '○' : '✗')));
      }))),
    warns.length ? h('ul', { class: 'issues' }, warns.map((i) => h('li', { class: 'warn' }, i.text))) : null);
}

async function toggleShowAll() {
  if (!R.showAll && !(await dialog({ title: 'Mostrare tutti i Sigilli?', text: 'Assicurati che nessun giocatore veda lo schermo.', okLabel: 'Mostra' }))) return;
  R.showAll = !R.showAll;
  render();
}

function codesGrid(fresh = []) {
  const ms = R.ms;
  if (!ms.codes.length) return h('p', { class: 'empty' }, 'Sigilli non ancora generati.');
  return h('div', { class: 'codes' }, ms.codes.map((c) => h('div', { class: `code-card code-${c.state}` },
    h('div', { class: 'code-sector' }, h('span', { class: 'mono muted' }, c.roman), ' ', c.sectorName),
    secret(c.code, fresh.includes(c.sectorId)),
    h('div', { class: 'tiny' }, c.state === 'revealed' ? h('span', { class: 'chip chip-blood' }, `rivelato ${fmtTime(c.revelation?.firedAt)}`)
      : c.state === 'never' ? h('span', { class: 'chip chip-brass' }, 'mai rivelato')
        : c.revelation?.status === 'skipped' ? h('span', { class: 'chip' }, 'saltato')
          : h('span', { class: 'chip' }, `in calendario ${fmtMin(c.revelation?.scheduledMin)}`)))));
}

function quickAnnounce() {
  const ta = h('textarea', { class: 'input', rows: 2, 'data-keep': 'quick-ann', placeholder: 'Testo a tutte le coppie…', maxlength: 500 });
  return h('form', { class: 'stack-sm', onsubmit: async (e) => {
    e.preventDefault();
    if (!ta.value.trim()) return;
    if (!(await dialog({ title: 'Inviare l\'annuncio?', text: ta.value, okLabel: 'Invia a tutti' }))) return;
    if (await call('POST', G('/announce'), { text: ta.value }, 'Annuncio inviato')) { ta.value = ''; ta.dataset.fresh = '1'; }
  } }, ta, h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Invia a tutte le coppie'));
}

const EVENT_LABELS = {
  unlock: 'Sblocco', unlock_failed: 'Tentativo fallito', manual_fragment: 'Frammento a mano', manual_fragment_failed: 'Frammento a mano non valido',
  code_note_ok: 'Sigillo annotato ✓', code_note_wrong: 'Sigillo annotato ✗', validation: 'Validazione', revelation: 'Rivelazione', announcement: 'Annuncio',
  team_login: 'Accesso coppia', message: 'Messaggio', supply_fired: 'Doni', game_started: 'VIA', game_paused: 'Sospensione', game_resumed: 'Ripresa', game_ended: 'Fine',
  fragment_correction: 'Correzione frammenti', team_withdrawn: 'Coppia ritirata', team_restored: 'Coppia ripristinata', player_added: 'Iscrizione',
  status_ready: 'Partita pronta', status_circle: 'Cerchio aperto', status_draft: 'In preparazione', codes_generated: 'Sigilli generati',
  never_revealed_extracted: 'Estrazione mai rivelati', calendar_built: 'Calendario', points_synced: 'Altari', phrase_set: 'Parola divisa',
  supply_saved: 'Doni', supply_deleted: 'Doni eliminati', team_created: 'Coppia formata', team_dissolved: 'Coppia sciolta', game_created: 'Partita creata',
  game_updated: 'Parametri', revelation_postponed: 'Rivelazione spostata', revelation_skipped: 'Rivelazione saltata', revelation_restored: 'Rivelazione ripristinata',
  revelation_edited: 'Calendario modificato', revelations_skipped_last_phase: 'Rivelazioni annullate', point_edited: 'Altare modificato',
  point_token_regenerated: 'QR rigenerato', fragment_edited: 'Frammento modificato', team_token_regenerated: 'Accesso rigenerato',
  team_sector_changed: 'Settore cambiato', team_members_changed: 'Membri cambiati', player_updated: 'Giocatore modificato', player_deleted: 'Giocatore eliminato',
  free_announcement: 'Annuncio libero', demo_created: 'Partita di prova', demo_advance: 'Tempo avanzato',
  registration_accepted: 'Iscrizione accettata', registration_rejected: 'Iscrizione rifiutata', elect_added: 'Eletti', elect_removed: 'Tolto dagli Eletti',
  notice: 'Avviso', notice_deleted: 'Avviso eliminato',
  sector_created: 'Settore creato', sector_updated: 'Settore modificato', sector_deleted: 'Settore eliminato', sector_archived: 'Settore archiviato', sector_restored: 'Settore ripristinato',
};

function eventText(e) {
  const d = e.data ? JSON.parse(e.data) : {};
  const t = d.teamId ? R.ms.teams.find((x) => x.id === d.teamId) : null;
  const who = t ? `${t.sectorName}` : '';
  switch (e.type) {
    case 'unlock': return `${who} ha sbloccato ${d.point}`;
    case 'unlock_failed': return `${who} ha sbagliato Sigillo a ${d.point} («${d.attempt}»)`;
    case 'manual_fragment': return `${who} ha aggiunto il frammento di ${d.point}`;
    case 'code_note_ok': case 'code_note_wrong': return `${who} → Sigillo ${d.sector}`;
    case 'validation': return `${who}: ${d.result === 'valid' ? `VALIDATA (${d.position}°)` : d.result}`;
    case 'revelation': return `Settore ${d.sector}${d.manual ? ' (a mano)' : ''}`;
    case 'announcement': return d.text;
    case 'message': return `${d.fromRole === 'team' ? who + ' → regia' : 'regia → ' + who}`;
    case 'fragment_correction': return `${who}: ${d.action === 'add' ? 'aggiunto' : 'tolto'} frammento ${d.position} — ${d.reason}`;
    case 'player_added': return d.pending ? `${d.name} (da approvare)` : d.name;
    case 'team_created': return `Settore ${d.sector}: ${(d.members || []).join(' e ')}`;
    case 'calendar_built': return (d.offsets || []).map((m) => `${m}′`).join(' · ');
    case 'codes_generated': case 'points_synced': case 'never_revealed_extracted': return d.count != null ? String(d.count) : '';
    case 'phrase_set': return `${d.fragments} frammenti`;
    case 'supply_saved': return d.scheduledMin != null ? `a ${d.scheduledMin}′` : 'a mano';
    case 'revelation_postponed': return `${d.minutes > 0 ? '+' : ''}${d.minutes}′`;
    case 'team_sector_changed': return `→ ${d.sector}`;
    case 'demo_advance': return `+${d.minutes}′`;
    case 'registration_accepted': case 'registration_rejected': return (d.names || []).join(' e ');
    case 'elect_added': return `${d.count} ${d.count === 1 ? 'persona' : 'persone'}`;
    case 'elect_removed': return d.name;
    case 'notice': return `${d.title} → ${R.ms.noticeTargets[d.target] || d.target}`;
    case 'notice_deleted': return d.title;
    default: return who;
  }
}

function eventFeed(limit = 150) {
  const ev = R.ms.events.slice(0, limit);
  return ev.length ? h('ul', { class: 'feed' }, ev.map((e) => h('li', { class: `ev ev-${e.type}` },
    h('span', { class: 'mono tiny muted' }, fmtTime(e.at, true)),
    h('span', { class: 'ev-type' }, EVENT_LABELS[e.type] || e.type.replace(/_/g, ' ')),
    h('span', { class: 'ev-text' }, eventText(e)),
    h('span', { class: 'tiny muted' }, e.actor?.startsWith('coppia:') ? '' : e.actor)))) : h('p', { class: 'empty' }, 'Nessun evento.');
}

function fragmentsDialog(t) {
  const frs = R.ms.points.filter((p) => p.fragmentId).sort((a, b) => a.position - b.position);
  const owned = Object.fromEntries((t.owned || []).map((o) => [o.fragmentId, o.source]));
  const boxes = frs.map((f) => h('input', { type: 'checkbox', checked: !!owned[f.fragmentId], 'data-id': f.fragmentId }));
  const reason = h('input', { class: 'input', placeholder: 'Motivazione (obbligatoria, finisce nel registro)' });
  const close = () => { dlg.close(); dlg.remove(); };
  const dlg = h('dialog', { class: 'dlg dlg-wide' },
    h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const changes = boxes.map((b) => ({ id: Number(b.dataset.id), want: b.checked })).filter((c) => c.want !== !!owned[c.id]);
      if (!changes.length) return close();
      if (!reason.value.trim()) return toast('Scrivi la motivazione', 'error');
      for (const c of changes) {
        try { await api('POST', `/api/m/teams/${t.id}/fragments`, { action: c.want ? 'add' : 'remove', fragmentId: c.id, reason: reason.value }); }
        catch (err) { toast(err.message, 'error'); break; }
      }
      toast(`${changes.length} correzioni registrate`, 'ok');
      close();
      load();
    } },
    h('h3', null, `Frammenti · Settore ${t.sectorName}`),
    h('p', null, 'Spunta i frammenti che la coppia deve avere. Le modifiche finiscono nel registro con la motivazione.'),
    h('div', { class: 'frag-checks' }, frs.map((f, i) => h('label', { class: 'frag-check' }, boxes[i],
      h('span', { class: 'mono pos' }, `#${f.position}`), h('strong', null, f.fragmentText), h('span', { class: 'tiny muted' }, f.label),
      owned[f.fragmentId] ? h('span', { class: 'chip' }, owned[f.fragmentId] === 'manual' ? 'a mano' : 'sbloccato') : h('span')))),
    reason,
    h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Annulla'), h('button', { type: 'submit', class: 'btn btn-primary' }, 'Salva'))));
  dlg.addEventListener('cancel', close);
  document.body.append(dlg);
  dlg.showModal();
}

// ---------------------------------------------------------------- ISCRIZIONI E COPPIE

const pairSel = new Set();

const ROLE_LABELS = { pair: 'Coppia', single: 'Temerario solitario', elect: 'Candidato agli Eletti' };

function personLine(p) {
  return [h('strong', null, p.name), p.nickname ? h('span', { class: 'muted' }, ` «${p.nickname}»`) : null];
}

function viewTeams() {
  const ms = R.ms;
  const st = ms.clock.status;
  const editable = ['draft', 'ready'].includes(st);
  const pending = ms.players.filter((p) => p.status === 'pending');
  const free = ms.players.filter((p) => !p.teamId && p.status === 'accepted');
  const usedSectors = new Set(ms.teams.map((t) => t.sectorId));
  const freeSectors = ms.sectors.filter((s) => !usedSectors.has(s.id) && !s.archived);
  for (const id of [...pairSel]) if (!free.some((p) => p.id === id)) pairSel.delete(id);
  const regUrl = `${R.baseUrl}/iscrizione`;

  // Chi si è iscritto insieme si decide e si accoppia insieme.
  const groupsOf = (list) => {
    const out = {};
    for (const p of list) (out[p.regGroup || `solo-${p.id}`] ||= []).push(p);
    return out;
  };
  const freeGroups = groupsOf(free);
  const pendingGroups = Object.values(groupsOf(pending));

  const name = h('input', { class: 'input', 'data-keep': 'pl-name', placeholder: 'Nome e cognome' });
  const nick = h('input', { class: 'input', 'data-keep': 'pl-nick', placeholder: 'Nome di battaglia' });
  const phone = h('input', { class: 'input', 'data-keep': 'pl-phone', placeholder: 'Telefono (facoltativo)' });
  const sectorSel = h('select', { class: 'input', 'data-keep': 'pair-sector' }, freeSectors.map((s) => h('option', { value: s.id }, `${s.roman} · ${s.name}`)));
  const teamName = h('input', { class: 'input', 'data-keep': 'pair-name', placeholder: 'Nome della coppia (facoltativo)' });

  return h('div', { class: 'stack' },
    pendingGroups.length ? h('div', { class: 'panel pending-panel' },
      h('div', { class: 'panel-head' }, h('h2', null, `Iscrizioni da approvare (${pending.length})`)),
      h('p', { class: 'muted tiny' }, 'Arrivate dal modulo online. Accetta chi vuoi far giocare: solo dopo potrai accoppiarli o metterli tra gli Eletti. Rifiutando, l\'iscrizione viene cancellata.'),
      h('div', { class: 'players' }, pendingGroups.map((grp) => h('div', { class: `player ${grp.length === 2 ? 'grouped' : ''}` },
        h('div', { class: 'player-main' },
          grp.map((p) => h('div', null, personLine(p), p.phone ? h('span', { class: 'tiny muted' }, ` · ${p.phone}`) : null)),
          h('div', null, h('span', { class: `chip ${grp[0].requestedRole === 'elect' ? 'chip-blood' : grp[0].requestedRole === 'single' ? 'chip-brass' : 'chip-ok'}` }, ROLE_LABELS[grp[0].requestedRole] || (grp.length === 2 ? 'Coppia' : 'Singolo'))),
          grp[0].note ? h('div', { class: 'tiny' }, `«${grp[0].note}»`) : null,
          h('div', { class: 'tiny muted' }, [grp[0].requestedTeamName ? `coppia «${grp[0].requestedTeamName}»` : null, fmtTime(grp[0].createdAt)].filter(Boolean).join(' · '))),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn btn-sm btn-primary', onclick: () => call('POST', `/api/m/players/${grp[0].id}/review`, { decision: 'accept' }, grp[0].requestedRole === 'elect' ? `${grp[0].name} è tra gli Eletti` : 'Iscrizione accettata') },
            grp.length === 2 ? 'Accetta entrambi' : grp[0].requestedRole === 'elect' ? 'Accetta tra gli Eletti' : 'Accetta'),
          h('button', { class: 'btn btn-sm btn-danger', onclick: () => confirmCall('Rifiutare l\'iscrizione?', `${grp.map((p) => p.name).join(' e ')}: l'iscrizione verrà cancellata.`, 'POST', `/api/m/players/${grp[0].id}/review`, { decision: 'reject' }, 'Iscrizione rifiutata', true) }, 'Rifiuta')))))) : null,

    h('div', { class: 'cols-2' },
      section('Iscrizioni',
        h('div', { class: 'toggle-row' },
          h('div', null, h('strong', null, ms.game.registrationOpen ? 'Iscrizioni aperte' : 'Iscrizioni chiuse'), h('div', { class: 'tiny muted' }, 'I giocatori si iscrivono online, da soli o in coppia; tu li approvi e assegni il Settore.')),
          h('button', { class: `btn btn-sm ${ms.game.registrationOpen ? '' : 'btn-primary'}`, disabled: st !== 'draft', onclick: () => call('PATCH', `/api/m/games/${R.gameId}`, { registrationOpen: !ms.game.registrationOpen }) }, ms.game.registrationOpen ? 'Chiudi' : 'Apri')),
        ms.game.registrationOpen ? h('div', { class: 'reg-link' }, h('img', { src: `/api/m/qr.svg?text=${encodeURIComponent(regUrl)}`, alt: 'QR iscrizione', width: 96, height: 96 }), h('div', null, h('div', { class: 'mono' }, regUrl), h('a', { href: regUrl, target: '_blank', class: 'tiny' }, 'Apri il modulo'))) : null,
        h('h3', { class: 'sub' }, 'Aggiungi giocatore a mano (già accettato)'),
        h('form', { class: 'form-grid', onsubmit: async (e) => {
          e.preventDefault();
          if (!name.value.trim()) return;
          if (await call('POST', G('/players'), { name: name.value, nickname: nick.value, phone: phone.value }, 'Giocatore aggiunto')) { [name, nick, phone].forEach((x) => { x.value = ''; }); }
        } }, name, nick, phone, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Aggiungi'))),

      section('Accoppiamento',
        editable ? [
          h('p', { class: 'muted tiny' }, 'Seleziona due giocatori accettati, scegli il Settore (il suo Altare) e forma la coppia.'),
          h('div', { class: 'pair-preview' },
            [0, 1].map((i) => {
              const p = free.find((x) => x.id === [...pairSel][i]);
              return h('div', { class: `pair-slot ${p ? 'full' : ''}` }, p ? personLine(p) : h('span', { class: 'muted' }, `Legato ${i + 1}`));
            })),
          h('div', { class: 'form-grid' }, sectorSel, teamName,
            h('button', { class: 'btn btn-primary', disabled: pairSel.size !== 2 || !freeSectors.length, onclick: async () => {
              if (await call('POST', G('/teams'), { playerIds: [...pairSel], sectorId: Number(sectorSel.value), displayName: teamName.value }, 'Coppia formata')) { pairSel.clear(); teamName.value = ''; render(); }
            } }, 'Forma la coppia')),
          freeSectors.length ? null : h('p', { class: 'tiny bad' }, 'Nessun Settore libero: aggiungine uno in "Settori e Altari".'),
          h('div', { class: 'row-actions' },
            h('button', { class: 'btn btn-sm', disabled: free.length < 2, onclick: () => confirmCall('Accoppiare automaticamente?', 'Solo i giocatori accettati: prima chi si è iscritto insieme, poi gli altri a caso. I Settori si assegnano in ordine.', 'POST', G('/auto-pair'), {}, 'Accoppiamento completato') }, 'Accoppia automaticamente'),
            pairSel.size ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { pairSel.clear(); render(); } }, 'Annulla selezione') : null),
        ] : h('p', { class: 'muted' }, 'Le coppie si formano prima di aprire il cerchio.'))),

    section(`Giocatori accettati senza coppia (${free.length})`,
      free.length ? h('div', { class: 'players' }, free.map((p) => {
        const grp = p.regGroup ? freeGroups[p.regGroup] : null;
        const sel = pairSel.has(p.id);
        return h('div', { class: `player ${sel ? 'sel' : ''} ${grp?.length === 2 ? 'grouped' : ''}` },
          h('button', { class: 'player-main', disabled: !editable, onclick: () => { if (sel) pairSel.delete(p.id); else { if (pairSel.size >= 2) pairSel.delete([...pairSel][0]); pairSel.add(p.id); } render(); } },
            personLine(p),
            h('div', { class: 'tiny muted' }, [p.phone, p.requestedRole === 'single' ? 'temerario solitario: da accoppiare a caso' : p.selfRegistered ? 'iscritto online' : 'aggiunto dalla regia', p.requestedTeamName ? `coppia «${p.requestedTeamName}»` : null].filter(Boolean).join(' · ')),
            grp?.length === 2 ? h('div', { class: 'tiny brass' }, `Iscritto con ${grp.find((x) => x.id !== p.id).name}`) : null),
          h('div', { class: 'row-actions' },
            grp?.length === 2 && editable && grp[0].id === p.id ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => call('POST', G('/teams'), { playerIds: grp.map((x) => x.id) }, 'Coppia formata') }, 'Accoppia come richiesto') : null,
            h('button', { class: 'btn btn-sm', onclick: () => call('POST', G('/elect'), { playerIds: [p.id] }, `${p.name} è tra gli Eletti`) }, 'Agli Eletti'),
            h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Eliminare il giocatore?', p.name, 'DELETE', `/api/m/players/${p.id}`, undefined, 'Eliminato', true) }, 'Elimina')));
      })) : h('p', { class: 'empty' }, pending.length ? 'Nessun giocatore accettato libero: approva le iscrizioni qui sopra.' : 'Tutti i giocatori accettati sono in coppia o tra gli Eletti.')),

    electSection(),

    sectionActions(`Coppie (${ms.teams.length}/${ms.sectors.filter((x) => !x.archived).length})`, [h('a', { class: 'btn btn-sm', href: `/regia/stampa/credenziali/${R.gameId}`, target: '_blank' }, 'Stampa credenziali')],
      ms.teams.length ? h('div', { class: 'teams' }, ms.teams.map((t) => teamCard(t, editable))) : h('p', { class: 'empty' }, 'Nessuna coppia.')));
}

function electSection() {
  const ms = R.ms;
  const e = ms.elect;
  const loginUrl = `${R.baseUrl}/login/${e.loginToken}`;
  const en = h('input', { class: 'input', 'data-keep': 'el-name', placeholder: 'Nome e cognome' });
  const ek = h('input', { class: 'input', 'data-keep': 'el-nick', placeholder: 'Nome di battaglia' });
  return h('div', { class: 'panel elect-panel' },
    h('div', { class: 'panel-head' }, h('h2', null, `Eletti del Consiglio (${e.members.length})`),
      h('div', { class: 'row-actions' }, h('span', { class: 'chip' }, `${e.online} online · ${e.pushDevices} con notifiche`))),
    h('p', { class: 'muted tiny' }, 'Un gruppo con un numero qualsiasi di persone e un solo accesso all\'app (QR o codice, su tutti i loro telefoni). Ricevono annunci, avvisi e messaggi della regia; non hanno Sigillo, non usano gli Altari e non sono in classifica.'),
    h('div', { class: 'elect-grid' },
      h('div', { class: 'stack-sm' },
        e.members.length ? h('ul', { class: 'elect-list' }, e.members.map((m) => h('li', null,
          h('span', null, personLine(m), m.phone ? h('span', { class: 'tiny muted' }, ` · ${m.phone}`) : null),
          h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Togliere dagli Eletti?', `${m.name} torna tra i giocatori senza coppia.`, 'DELETE', `/api/m/elect/members/${m.id}`, undefined, 'Tolto dagli Eletti') }, 'Togli')))) : h('p', { class: 'empty' }, 'Nessun Eletto. Aggiungili qui sotto o con "Agli Eletti" sui giocatori accettati.'),
        h('form', { class: 'form-grid', onsubmit: async (ev) => {
          ev.preventDefault();
          if (!en.value.trim()) return;
          if (await call('POST', G('/elect/person'), { name: en.value, nickname: ek.value }, 'Aggiunto agli Eletti')) { en.value = ''; ek.value = ''; }
        } }, en, ek, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Aggiungi agli Eletti'))),
      h('div', { class: 'team-access' },
        h('img', { src: `/api/m/qr.svg?text=${encodeURIComponent(loginUrl)}`, alt: 'QR di accesso degli Eletti', width: 96, height: 96, loading: 'lazy' }),
        h('div', null, h('div', { class: 'eyebrow' }, 'Codice d\'accesso degli Eletti'), h('div', { class: 'mono access' }, e.accessCode),
          h('div', { class: 'row-actions' },
            h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { navigator.clipboard?.writeText(loginUrl); toast('Link di accesso copiato', 'ok'); } }, 'Copia link'),
            ms.game.isDemo ? h('a', { class: 'btn btn-sm', href: loginUrl, target: '_blank' }, 'Apri app') : null,
            h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Rigenerare l\'accesso degli Eletti?', 'Il vecchio QR e il vecchio codice smettono di funzionare.', 'POST', `/api/m/teams/${e.id}/regen-token`, {}, 'Accesso rigenerato', true) }, 'Rigenera'))))));
}

function teamCard(t, editable) {
  const ms = R.ms;
  const loginUrl = `${R.baseUrl}/login/${t.loginToken}`;
  const used = new Set(ms.teams.map((x) => x.sectorId));
  return h('div', { class: `team-card ${t.status}` },
    h('div', { class: 'team-head' },
      h('span', { class: 'team-roman' }, t.roman || '?'),
      h('div', { class: 'grow' },
        editable ? h('select', { class: 'input input-sm', onchange: (e) => call('PATCH', `/api/m/teams/${t.id}`, { sectorId: Number(e.target.value) }, 'Settore aggiornato') },
          ms.sectors.filter((s) => !s.archived || s.id === t.sectorId).map((s) => h('option', { value: s.id, selected: s.id === t.sectorId }, `${s.roman} · ${s.name}${used.has(s.id) && s.id !== t.sectorId ? ' (scambia)' : ''}`)))
          : h('strong', { class: 'team-sector' }, `Settore ${t.sectorName}`),
        h('input', { class: 'input input-sm', 'data-keep': `tname-${t.id}`, value: t.displayName || '', placeholder: 'Nome della coppia', onchange: (e) => call('PATCH', `/api/m/teams/${t.id}`, { displayName: e.target.value }) })),
      t.status === 'won' ? h('span', { class: 'chip chip-ok' }, `${t.finishPosition}°`) : t.status === 'withdrawn' ? h('span', { class: 'chip' }, 'ritirata') : null),
    h('div', { class: 'team-members' }, t.members.map((m) => h('div', null, h('strong', null, m.name), m.nickname ? ` «${m.nickname}»` : '', m.phone ? h('span', { class: 'tiny muted' }, ` · ${m.phone}`) : null))),
    h('div', { class: 'team-access' },
      h('img', { src: `/api/m/qr.svg?text=${encodeURIComponent(loginUrl)}`, alt: 'QR di accesso', width: 84, height: 84, loading: 'lazy' }),
      h('div', null, h('div', { class: 'eyebrow' }, 'Codice d\'accesso'), h('div', { class: 'mono access' }, t.accessCode),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { navigator.clipboard?.writeText(loginUrl); toast('Link di accesso copiato', 'ok'); } }, 'Copia link'),
          ms.game.isDemo ? h('a', { class: 'btn btn-sm', href: loginUrl, target: '_blank', title: "Questo browser diventa la coppia (tutte le schede dell'app coppie)" }, 'Apri app') : null))),
    h('div', { class: 'row-actions' },
      editable ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Sciogliere la coppia?', 'I giocatori tornano nella lista senza coppia.', 'DELETE', `/api/m/teams/${t.id}`, undefined, 'Coppia sciolta', true) }, 'Sciogli') : null,
      h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Rigenerare l\'accesso?', 'Il vecchio QR e il vecchio codice smettono di funzionare e i dispositivi collegati escono.', 'POST', `/api/m/teams/${t.id}/regen-token`, {}, 'Accesso rigenerato', true) }, 'Rigenera accesso'),
      !editable && t.status !== 'won' ? h('button', { class: 'btn btn-sm btn-danger', onclick: () => confirmCall(t.status === 'withdrawn' ? 'Rimettere in gioco?' : 'Ritirare la coppia?', teamLabel(t), 'POST', `/api/m/teams/${t.id}/withdraw`, { restore: t.status === 'withdrawn' }, 'Fatto', t.status !== 'withdrawn') }, t.status === 'withdrawn' ? 'Rimetti in gioco' : 'Ritira') : null));
}

// ---------------------------------------------------------------- SETTORI E ALTARI (anagrafica)

const ARTICLES = ['del', 'dello', 'della', "dell'", 'dei', 'degli', 'delle'];
let sectorsList = null;

async function loadSectors() {
  try { sectorsList = await api('GET', '/api/m/sectors'); } catch (e) { toast(e.message, 'error'); sectorsList = []; }
  if (tab() === 'settori') render();
}

async function sectorCall(method, url, body, okMsg) {
  try {
    const r = await api(method, url, body);
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok');
    await loadSectors();
    if (R.gameId) load();
    return r || true;
  } catch (e) { toast(e.message, 'error', 7000); return null; }
}

function sectorFields(s, prefix) {
  const k = (f) => `${prefix}-${f}`;
  return {
    ord: h('input', { class: 'input input-sm mono', type: 'number', min: 1, max: 999, value: s?.ord ?? '', 'data-keep': k('ord'), placeholder: 'auto', title: 'Ordine (numero romano automatico)' }),
    name: h('input', { class: 'input input-sm', value: s?.name || '', 'data-keep': k('name'), placeholder: 'es. Vento', maxlength: 40, required: true }),
    article: h('select', { class: 'input input-sm', 'data-keep': k('article') }, h('option', { value: '' }, 'auto'), ARTICLES.map((a) => h('option', { value: a, selected: s?.article === a }, a))),
    element: h('input', { class: 'input input-sm', value: s?.element || '', 'data-keep': k('element'), placeholder: 'es. i mulini', maxlength: 60 }),
    motto: h('input', { class: 'input input-sm', value: s?.motto || '', 'data-keep': k('motto'), placeholder: 'Motto', maxlength: 80 }),
    altarLabel: h('input', { class: 'input input-sm', value: s?.altarLabel || '', 'data-keep': k('altar'), placeholder: s ? s.defaultAltar : 'Altare … (automatico)', maxlength: 60 }),
  };
}
const fieldValues = (f) => Object.fromEntries(Object.entries(f).map(([key, el]) => [key, el.value]));

function viewSectors() {
  if (!sectorsList) { loadSectors(); return h('p', { class: 'empty' }, 'Caricamento…'); }
  const active = sectorsList.filter((s) => !s.archived);
  const archived = sectorsList.filter((s) => s.archived);
  const add = sectorFields(null, 'new');
  return h('div', { class: 'stack' },
    section('Settori e Altari',
      h('p', { class: 'muted tiny' }, 'Ogni coppia rappresenta un Settore e il suo Altare nel bosco. L\'elenco vale per tutte le partite: le coppie lo vedono all\'iscrizione per scegliere il proprio Altare, la regia lo usa per formare le coppie. Il nome dell\'Altare è automatico ("Altare del Fuoco"), ma puoi sceglierne uno diverso.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'sectors-table' },
        h('thead', null, h('tr', null, ['#', 'Settore', 'Articolo', 'Elemento', 'Motto', 'Nome dell\'Altare', 'Uso', ''].map((x) => h('th', null, x)))),
        h('tbody', null, active.map((s) => {
          const f = sectorFields(s, `s${s.id}`);
          const u = s.usage || {};
          return h('tr', null,
            h('td', { class: 'w-70' }, h('div', { class: 'mono roman' }, s.roman), f.ord),
            h('td', null, f.name), h('td', { class: 'w-90' }, f.article), h('td', null, f.element), h('td', null, f.motto), h('td', null, f.altarLabel),
            h('td', { class: 'tiny muted' }, [u.liveTeams ? `${u.liveTeams} in gioco` : null, u.requests ? `${u.requests} richieste` : null, u.teams && !u.liveTeams ? 'storico' : null].filter(Boolean).join(' · ') || 'libero'),
            h('td', { class: 'row-actions' },
              h('button', { class: 'btn btn-sm btn-primary', onclick: () => sectorCall('PATCH', `/api/m/sectors/${s.id}`, { ...fieldValues(f), articleTouched: f.article.value !== s.article }, `Settore ${f.name.value} salvato`) }, 'Salva'),
              h('button', { class: 'btn btn-sm btn-ghost', disabled: !!u.liveTeams, title: u.liveTeams ? 'Assegnato a una coppia in una partita non terminata' : '', onclick: async () => {
                if (!(await dialog({ title: `Eliminare il Settore ${s.name}?`, text: u.teams ? 'È stato usato in partite passate: verrà archiviato (sparisce dalle scelte, resta nello storico).' : 'Verrà eliminato definitivamente.' + (u.requests ? ' Le richieste di iscrizione per questo Altare verranno annullate.' : ''), okLabel: u.teams ? 'Archivia' : 'Elimina', danger: true }))) return;
                sectorCall('DELETE', `/api/m/sectors/${s.id}`, undefined, (r) => (r.archived ? `${s.name} archiviato` : `${s.name} eliminato`));
              } }, 'Elimina')));
        })))),
      h('h3', { class: 'sub' }, 'Nuovo Settore'),
      h('form', { class: 'sector-add', onsubmit: async (e) => {
        e.preventDefault();
        if (await sectorCall('POST', '/api/m/sectors', fieldValues(add), `Settore ${add.name.value} creato`)) Object.values(add).forEach((el) => { el.value = ''; });
      } },
      h('label', { class: 'field' }, h('span', null, 'Nome'), add.name),
      h('label', { class: 'field' }, h('span', null, 'Articolo'), add.article),
      h('label', { class: 'field' }, h('span', null, 'Elemento'), add.element),
      h('label', { class: 'field' }, h('span', null, 'Motto'), add.motto),
      h('label', { class: 'field' }, h('span', null, 'Nome dell\'Altare'), add.altarLabel),
      h('label', { class: 'field' }, h('span', null, 'Ordine'), add.ord),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Aggiungi'))),
    archived.length ? section('Archiviati',
      h('p', { class: 'muted tiny' }, 'Settori usati in partite passate e poi eliminati: non compaiono nelle scelte.'),
      h('ul', { class: 'users' }, archived.map((s) => h('li', null, h('span', { class: 'mono' }, s.roman), h('strong', null, s.name), h('span', { class: 'tiny muted' }, s.altar),
        h('button', { class: 'btn btn-sm', onclick: () => sectorCall('POST', `/api/m/sectors/${s.id}/restore`, {}, `${s.name} ripristinato`) }, 'Ripristina'))))) : null);
}

// ---------------------------------------------------------------- ALTARI E PAROLA

function viewAltars() {
  const ms = R.ms;
  const pre = PRE.includes(ms.clock.status);
  const phrase = h('textarea', { class: 'input', rows: 3, 'data-keep': 'phrase', placeholder: `Una frase di almeno ${ms.teams.length} parole`, value: ms.game.phrase || '' });
  return h('div', { class: 'stack' },
    section('La Parola',
      h('p', { class: 'muted tiny' }, 'La frase viene divisa in tanti frammenti quanti sono gli Altari (uno per coppia) e i pezzi vengono assegnati agli Altari in ordine casuale. Puoi poi correggere ogni frammento.'),
      phrase,
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn btn-primary', disabled: !pre, onclick: () => confirmCall('Dividere la Parola?', 'I frammenti attuali vengono sostituiti (e tolti a chi li aveva).', 'POST', G('/phrase'), { phrase: phrase.value }, 'Parola divisa tra gli Altari') }, 'Dividi tra gli Altari'),
        ms.game.phrase ? h('span', { class: 'muted tiny' }, `Attuale: «${ms.game.phrase}»`) : null)),

    sectionActions(`Altari (${ms.points.length})`, [
      h('button', { class: 'btn btn-sm', disabled: !pre, onclick: () => call('POST', G('/points'), {}, 'Altari sincronizzati con le coppie') }, 'Sincronizza con le coppie'),
      h('a', { class: 'btn btn-sm btn-primary', href: `/regia/stampa/altari/${R.gameId}`, target: '_blank' }, 'Stampa cartelli A4')],
    ms.points.length ? h('div', { class: 'altars' }, ms.points.map((p) => {
      const url = `${R.baseUrl}/a/${p.qrToken}`;
      return h('div', { class: 'altar-card' },
        h('img', { class: 'altar-qr', src: `/api/m/qr.svg?text=${encodeURIComponent(url)}`, alt: `QR ${p.label}`, width: 120, height: 120, loading: 'lazy' }),
        h('div', { class: 'stack-sm grow' },
          h('div', { class: 'eyebrow' }, `${p.roman} · Settore ${p.sectorName}`),
          h('input', { class: 'input input-sm', 'data-keep': `pl-${p.id}`, value: p.label, onchange: (e) => call('PATCH', `/api/m/points/${p.id}`, { label: e.target.value }, 'Nome aggiornato') }),
          h('input', { class: 'input input-sm', 'data-keep': `pn-${p.id}`, value: p.locationNote || '', placeholder: 'Posizione nel bosco (solo regia)', onchange: (e) => call('PATCH', `/api/m/points/${p.id}`, { locationNote: e.target.value }, 'Posizione salvata') }),
          p.fragmentId ? h('div', { class: 'frag-edit' },
            h('span', { class: 'mono pos' }, `#${p.position}`),
            h('input', { class: 'input input-sm', 'data-keep': `pf-${p.fragmentId}`, value: p.fragmentText, disabled: !pre, onchange: (e) => call('PATCH', `/api/m/fragments/${p.fragmentId}`, { text: e.target.value }, 'Frammento aggiornato') }))
            : h('div', { class: 'tiny bad' }, 'Nessun frammento: dividi la Parola'),
          h('div', { class: 'row-actions' },
            h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { navigator.clipboard?.writeText(url); toast('Link dell\'Altare copiato', 'ok'); } }, 'Copia link'),
            pre ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Rigenerare il QR?', 'Il cartello già stampato non funzionerà più: andrà ristampato.', 'POST', `/api/m/points/${p.id}/regen`, {}, 'QR rigenerato', true) }, 'Rigenera QR') : null)));
    })) : h('p', { class: 'empty' }, 'Nessun Altare: forma le coppie e premi "Sincronizza".')));
}

// ---------------------------------------------------------------- SIGILLI E TRADIMENTI

function viewCodes() {
  const ms = R.ms;
  const g = ms.game;
  const pre = PRE.includes(ms.clock.status);
  const active = ACTIVE.includes(ms.clock.status);
  const nonRevealed = ms.codes.filter((c) => c.state !== 'revealed');
  const manualSel = h('select', { class: 'input input-sm', 'data-keep': 'manual-reveal' }, nonRevealed.map((c) => h('option', { value: c.sectorId }, `${c.roman} · ${c.sectorName}${c.state === 'never' ? ' (mai rivelato!)' : ''}`)));
  const N = ms.codes.length;
  const H = g.truceMin;
  const F = H + g.firstRevelationDelayMin;
  const L = g.durationMin - g.lastRevelationBeforeEndMin;
  const Rn = N - g.neverRevealedCount;

  return h('div', { class: 'stack' },
    sectionActions('Sigilli dei Settori', [
      h('button', { class: 'btn btn-sm btn-primary', disabled: !pre, onclick: () => confirmCall(N ? 'Rigenerare i Sigilli?' : 'Generare i Sigilli?', N ? 'Tutti i Sigilli cambiano. Se le coppie li hanno già visti nel cerchio, vedranno quelli nuovi.' : 'Un Sigillo per Settore, 6 caratteri senza caratteri ambigui.', 'POST', G('/codes'), {}, 'Sigilli generati', !!N) }, N ? 'Rigenera Sigilli' : 'Genera Sigilli'),
      h('button', { class: 'btn btn-sm', disabled: !pre || !N, onclick: () => confirmCall('Nuova estrazione?', `Si estraggono a caso ${g.neverRevealedCount} Sigilli che il Consiglio non rivelerà mai. Il calendario viene ricalcolato.`, 'POST', G('/never'), {}, 'Estrazione fatta') }, 'Estrai i mai rivelati'),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: toggleShowAll }, R.showAll ? 'Nascondi' : 'Mostra tutti')],
    h('p', { class: 'muted tiny' }, 'I Sigilli sono sfocati: tieni premuto per leggerne uno. Nelle app delle coppie appaiono come simulacri sfocati finché non vengono svelati: il proprio all\'apertura del cerchio, gli altri al momento del tradimento.'),
    codesGrid()),

    sectionActions('Calendario dei tradimenti', [
      pre ? h('button', { class: 'btn btn-sm', disabled: !N, onclick: () => confirmCall('Ricalcolare il calendario?', 'Orari ricalcolati e ordine dei Settori di nuovo casuale.', 'POST', G('/calendar'), {}, 'Calendario ricalcolato') }, 'Ricalcola (ordine casuale)') : null],
    h('p', { class: 'mono tiny muted' }, `Caccia a ${H}′ · prima rivelazione F = ${F}′ · ultima L = ${L}′ · coppie N = ${N} · rivelazioni R = ${Math.max(0, Rn)}${Rn > 1 ? ` · intervallo ${((L - F) / (Rn - 1)).toFixed(1)}′` : ''}`),
    ms.revelations.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['#', 'Orario dal via', 'Settore', 'Stato', 'Tra', ''].map((x) => h('th', null, x)))),
      h('tbody', null, ms.revelations.map((r) => h('tr', { class: `rev-${r.status}` },
        h('td', { class: 'mono' }, r.ord === 999 ? '—' : r.ord),
        h('td', null, pre && r.status === 'scheduled'
          ? h('input', { class: 'input input-sm mono w-90', type: 'number', step: '0.5', min: 0, value: r.scheduledMin, 'data-keep': `rv-${r.id}`, onchange: (e) => call('PATCH', `/api/m/revelations/${r.id}`, { scheduledMin: e.target.value }, 'Orario aggiornato') })
          : h('span', { class: 'mono' }, r.scheduledMin != null ? fmtMin(r.scheduledMin) : 'a mano')),
        h('td', null, pre && r.status === 'scheduled'
          ? h('select', { class: 'input input-sm', onchange: (e) => call('PATCH', `/api/m/revelations/${r.id}`, { sectorId: Number(e.target.value) }, 'Settore aggiornato') },
            ms.codes.filter((c) => !c.neverRevealed).map((c) => h('option', { value: c.sectorId, selected: c.sectorId === r.sectorId }, `${c.roman} · ${c.sectorName}`)))
          : h('strong', null, `${r.roman} ${r.sectorName}`)),
        h('td', null, h('span', { class: `chip ${r.status === 'fired' || r.status === 'manual' ? 'chip-blood' : r.status === 'skipped' ? '' : 'chip-brass'}` },
          { scheduled: 'in attesa', fired: `rivelato ${fmtTime(r.firedAt)}`, manual: `a mano ${fmtTime(r.firedAt)}`, skipped: 'saltato' }[r.status])),
        h('td', { class: 'mono' }, r.status === 'scheduled' && r.scheduledMin != null ? h('span', { 'data-clock': `until:${r.scheduledMin * 60000}` }, '—') : '—'),
        h('td', { class: 'row-actions' },
          r.status === 'scheduled' && active ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => confirmCall('Rivelare adesso?', `Settore ${r.sectorName}: il Sigillo va a tutte le coppie.`, 'POST', `/api/m/revelations/${r.id}/reveal`, {}, 'Rivelato') }, 'Rivela ora') : null,
          r.status === 'scheduled' && !pre ? h('button', { class: 'btn btn-sm', onclick: () => call('POST', `/api/m/revelations/${r.id}/postpone`, { minutes: 5 }, '+5 minuti') }, '+5′') : null,
          r.status === 'scheduled' && !pre ? h('button', { class: 'btn btn-sm', onclick: () => call('POST', `/api/m/revelations/${r.id}/postpone`, { minutes: -5 }, '−5 minuti') }, '−5′') : null,
          r.status === 'scheduled' ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Saltare?', `Settore ${r.sectorName}`, 'POST', `/api/m/revelations/${r.id}/skip`, {}, 'Saltata') }, 'Salta') : null,
          r.status === 'skipped' && !['ended'].includes(ms.clock.status) ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => call('POST', `/api/m/revelations/${r.id}/skip`, { restore: true }, 'Ripristinata') }, 'Ripristina') : null)))))) : h('p', { class: 'empty' }, 'Genera i Sigilli per creare il calendario.'),
    active && nonRevealed.length ? h('div', { class: 'manual-reveal' }, h('strong', null, 'Tradimento fuori calendario'), manualSel,
      h('button', { class: 'btn btn-sm btn-danger', onclick: () => {
        const c = ms.codes.find((x) => x.sectorId === Number(manualSel.value));
        confirmCall('Rivelare questo Sigillo?', `Settore ${c.sectorName}${c.state === 'never' ? ' — ATTENZIONE: è tra i mai rivelati' : ''}. Gli orari successivi non cambiano.`, 'POST', G('/reveal-sector'), { sectorId: c.sectorId }, 'Rivelato', true);
      } }, 'Rivela')) : null));
}

// ---------------------------------------------------------------- MAPPA E CAMPO

const FIELD_TABS = ['mappa', 'doniqr'];
const fieldMap = createMapView({ className: 'regia-map' });
let fieldData = null;
let giftTypesDraft = null;

async function loadField(doRender = true) {
  if (!R.gameId) return;
  try {
    fieldData = await api('GET', `/api/field/state?gameId=${R.gameId}`);
    if (fieldData.game.id !== R.gameId) fieldData = null;
  } catch (e) { toast(e.message, 'error'); }
  if (doRender) render();
}

const GIFT_STATE = { draft: 'Da piazzare', placed: 'Piazzato · non comparso', revealed: 'Comparso', claimed: 'Preso', expired: 'Svanito (scaduto)' };
const REVEAL_MODE = { manual: 'A mano dalla regia', onplace: 'Appena piazzato', time: 'A un minuto dal via' };

function giftPopup(g) {
  return `<strong>${g.label} · ${g.icon} ${g.name}</strong><br>${GIFT_STATE[g.status]}${g.claimedBy ? ` da ${g.claimedBy}` : ''}<br><small>Piazzato ${fmtTime(g.placedAt)} da ${g.placedBy || '?'}${g.accuracy ? ` · ±${g.accuracy} m` : ''}</small>${g.hasPhoto ? `<img src="/api/media/gift/${g.id}?v=${g.placedAt}" alt="">` : ''}`;
}

function viewFieldMap() {
  const d = fieldData;
  if (!d) { loadField(); return h('p', { class: 'empty' }, 'Caricamento del campo…'); }
  const campoUrl = `${R.baseUrl}/campo`;
  fieldMap.setItems([
    ...d.points.map((p) => ({ key: `p${p.id}`, kind: 'altar', lat: p.lat, lng: p.lng, text: p.roman, title: p.label,
      popup: `<strong>${p.label}</strong><br><small>Piazzato ${fmtTime(p.placedAt)} da ${p.placedBy || '?'}${p.accuracy ? ` · ±${p.accuracy} m` : ''}${p.placeSource === 'manual' ? ' · punto manuale' : ''}</small>${p.hasPhoto ? `<img src="/api/media/point/${p.id}?v=${p.placedAt}" alt="">` : ''}` })),
    // Doni: grigi finché non compaiono, colorati quando compaiono, barrati quando presi.
    ...d.gifts.map((g) => ({ key: `g${g.id}`, kind: 'gift', lat: g.lat, lng: g.lng, text: g.icon, color: g.color, state: g.status === 'placed' ? 'hidden' : g.status, title: g.label, popup: giftPopup(g) })),
  ]);
  fieldMap.refresh();
  const placed = d.points.filter((p) => p.lat != null).length;
  return h('div', { class: 'stack' },
    sectionActions('Mappa del campo', [
      h('button', { class: 'btn btn-sm', onclick: () => fieldMap.fit() }, 'Centra'),
      h('a', { class: 'btn btn-sm btn-primary', href: '/campo', target: '_blank' }, 'Apri strumento di campo')],
    fieldMap.el,
    h('div', { class: 'map-legend' },
      h('span', null, h('span', { class: 'pin pin-altar' }, 'I'), ' Altare piazzato'),
      h('span', null, h('span', { class: 'pin pin-gift pin-hidden' }, '✦'), ' Dono piazzato, non ancora comparso'),
      h('span', null, h('span', { class: 'pin pin-gift pin-revealed', style: { '--c': '#d1ad62' } }, '✦'), ' Dono comparso'),
      h('span', null, h('span', { class: 'pin pin-gift pin-claimed' }, '✦'), ' Dono preso'))),
    h('div', { class: 'cols-2' },
      section(`Altari piazzati ${placed}/${d.points.length}`,
        h('p', { class: 'muted tiny' }, 'Gli Eletti (o tu dal telefono) piazzano gli Altari con lo strumento di campo: foto e coordinate arrivano qui.'),
        d.points.length ? h('ul', { class: 'field-list' }, d.points.map((p) => h('li', { class: p.lat != null ? 'ok' : '' },
          p.hasPhoto ? h('a', { href: `/api/media/point/${p.id}?v=${p.placedAt}`, target: '_blank' }, h('img', { src: `/api/media/point/${p.id}?v=${p.placedAt}`, alt: `Foto ${p.label}`, loading: 'lazy' })) : h('span', { class: 'thumb-empty' }, p.roman),
          h('div', { class: 'grow' }, h('strong', null, p.label),
            h('div', { class: 'tiny muted' }, p.lat != null ? `${fmtTime(p.placedAt)} · ${p.placedBy || '?'}${p.accuracy ? ` · ±${p.accuracy} m` : ''} · ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : 'Da piazzare')),
          p.lat != null ? h('span', { class: 'chip chip-ok' }, '✓') : h('span', { class: 'chip chip-warn' }, 'manca')))) : h('p', { class: 'empty' }, 'Nessun Altare.')),
      section('Strumento di campo sul telefono',
        h('div', { class: 'reg-link' }, h('img', { src: `/api/m/qr.svg?text=${encodeURIComponent(campoUrl)}`, alt: 'QR strumento di campo', width: 110, height: 110 }),
          h('div', null, h('div', { class: 'mono' }, campoUrl), h('div', { class: 'tiny' }, 'Inquadralo dal telefono: entra con la regia o con l\'accesso degli Eletti.'))),
        h('ol', { class: 'tiny muted hints' },
          h('li', null, 'Scansiona il cartello dell\'Altare o del Dono (o sceglilo dall\'elenco).'),
          h('li', null, 'L\'app prende la posizione GPS del telefono (o tocchi il punto sulla mappa).'),
          h('li', null, 'Scatta la foto del piazzamento e conferma.')),
        h('p', { class: 'tiny muted' }, 'GPS, fotocamera interna e scanner richiedono https; la foto funziona sempre.'))));
}

// ---------------------------------------------------------------- DONI QR

function viewGiftsQR() {
  const d = fieldData;
  if (!d) { loadField(); return h('p', { class: 'empty' }, 'Caricamento dei doni…'); }
  const types = giftTypesDraft || d.giftTypes;
  const typeSel = h('select', { class: 'input', 'data-keep': 'gq-type' }, d.giftTypes.map((t) => h('option', { value: t.id }, `${t.icon} ${t.name}`)));
  const count = h('input', { class: 'input', type: 'number', min: 1, max: 50, value: 1, 'data-keep': 'gq-count' });
  const at = h('input', { class: 'input', type: 'number', min: 0, step: 1, placeholder: 'minuto dal via', 'data-keep': 'gq-at' });
  const exp = h('input', { class: 'input', type: 'number', min: 1, step: 1, placeholder: 'mai', 'data-keep': 'gq-exp' });
  const mode = h('select', { class: 'input', 'data-keep': 'gq-mode', onchange: () => at.classList.toggle('hidden', mode.value !== 'time') }, Object.entries(REVEAL_MODE).map(([k, v]) => h('option', { value: k }, v)));
  queueMicrotask(() => at.classList.toggle('hidden', mode.value !== 'time'));

  const typeRow = (t, i) => h('div', { class: 'gt-row' },
    h('input', { class: 'input input-sm gt-icon', value: t.icon, maxlength: 2, 'aria-label': 'Icona', oninput: (e) => { types[i].icon = e.target.value; } }),
    h('input', { class: 'input input-sm', value: t.name, 'aria-label': 'Nome', oninput: (e) => { types[i].name = e.target.value; } }),
    h('input', { class: 'gt-color', type: 'color', value: t.color, 'aria-label': 'Colore', oninput: (e) => { types[i].color = e.target.value; } }),
    h('textarea', { class: 'input input-sm gt-desc', rows: 2, value: t.description, 'aria-label': 'Effetto', oninput: (e) => { types[i].description = e.target.value; } }),
    h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { types.splice(i, 1); render(); } }, '✕'));

  return h('div', { class: 'stack' },
    h('div', { class: 'cols-2' },
      section('Nuovi doni',
        h('p', { class: 'muted tiny' }, 'Crea i doni, stampane i cartelli e falli piazzare agli Eletti: piazzandolo, l\'Eletto lo attiva con la posizione del suo telefono. La prima coppia che lo scansiona lo prende. Il tipo non è stampato sul cartello.'),
        h('form', { class: 'form-grid', onsubmit: async (e) => {
          e.preventDefault();
          try {
            const r = await api('POST', G('/gifts'), { typeId: typeSel.value, count: count.value, revealMode: mode.value, revealAtMin: at.value, expiresAfterMin: exp.value });
            toast(`${r.ids.length} doni creati`, 'ok');
            loadField();
          } catch (err) { toast(err.message, 'error', 6000); }
        } },
        h('label', { class: 'field' }, h('span', null, 'Tipo'), typeSel),
        h('label', { class: 'field' }, h('span', null, 'Quanti'), count),
        h('label', { class: 'field' }, h('span', null, 'Comparsa'), mode),
        at,
        h('label', { class: 'field' }, h('span', null, 'Scadenza: minuti dopo la comparsa'), exp),
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Crea'))),
      section('Tipi di dono',
        h('p', { class: 'muted tiny' }, 'Icona, nome, colore in mappa ed effetto (lo legge la coppia quando prende il dono). Le modifiche valgono per i doni creati dopo.'),
        h('div', { class: 'gt-list' }, types.map(typeRow)),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { giftTypesDraft = [...types, { icon: '✦', name: 'Nuovo dono', color: '#d1ad62', description: '' }]; render(); } }, '+ Tipo'),
          h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: async () => {
            try { await api('PUT', '/api/m/gift-types', { types }); giftTypesDraft = null; toast('Tipi di dono salvati', 'ok'); loadField(); } catch (err) { toast(err.message, 'error', 6000); }
          } }, 'Salva tipi')))),
    sectionActions(`Doni (${d.gifts.length})`, [h('a', { class: 'btn btn-sm', href: `/regia/stampa/doni/${R.gameId}`, target: '_blank' }, 'Stampa cartelli')],
      d.gifts.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Dono', 'Tipo', 'Stato', 'Comparsa', 'Scadenza', 'Piazzamento', ''].map((x) => h('th', null, x)))),
        h('tbody', null, d.gifts.map((g) => h('tr', { class: `gift-row-${g.status}` },
          h('td', null, h('strong', null, g.label)),
          h('td', null, h('span', { style: { color: g.color } }, `${g.icon} ${g.name}`)),
          h('td', null, h('span', { class: `chip ${g.status === 'revealed' ? 'chip-blood' : g.status === 'placed' ? 'chip-ok' : g.status === 'draft' ? 'chip-warn' : g.status === 'claimed' ? 'chip-brass' : ''}` },
            g.status === 'claimed' ? `Preso da ${g.claimedBy} alle ${fmtTime(g.claimedAt)}${g.usedAt ? ' · usato' : ''}` : g.status === 'expired' ? `Svanito alle ${fmtTime(g.expiredAt)}` : GIFT_STATE[g.status])),
          h('td', { class: 'tiny' }, g.revealMode === 'time' ? `a ${g.revealAtMin}′` : REVEAL_MODE[g.revealMode]),
          h('td', { class: 'tiny' }, !g.expiresAfterMin ? 'mai' : g.status === 'revealed' && g.expiresAtElapsedMs != null ? h('span', null, 'tra ', h('span', { class: 'mono', 'data-clock': `until:${g.expiresAtElapsedMs}` }, '—')) : `${g.expiresAfterMin}′ dopo la comparsa`),
          h('td', { class: 'tiny' }, g.lat != null ? `${fmtTime(g.placedAt)} · ${g.placedBy || '?'}${g.accuracy ? ` · ±${g.accuracy} m` : ''}` : '—'),
          h('td', { class: 'row-actions' },
            g.status === 'placed' ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => confirmCall('Far comparire il dono?', `${g.label} apparirà sulla mappa di tutte le coppie, con un annuncio.`, 'POST', `/api/m/gifts/${g.id}/reveal`, {}, 'Dono comparso').then(() => loadField()) }, 'Fai comparire') : null,
            ['placed', 'revealed', 'expired'].includes(g.status) ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Riportare da piazzare?', 'Posizione e foto vengono cancellate e il dono sparisce dalle mappe.', 'POST', `/api/m/gifts/${g.id}/reset`, {}, 'Dono da ripiazzare', true).then(() => loadField()) }, 'Da ripiazzare') : null,
            h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Eliminare il dono?', g.label, 'DELETE', `/api/m/gifts/${g.id}`, undefined, 'Dono eliminato', true).then(() => loadField()) }, 'Elimina'))))))) : h('p', { class: 'empty' }, 'Nessun dono creato.')));
}

// ---------------------------------------------------------------- DONI

function viewSupply() {
  const ms = R.ms;
  const active = ACTIVE.includes(ms.clock.status);
  const when = h('input', { class: 'input', type: 'number', step: '1', min: 0, max: ms.game.durationMin, 'data-keep': 'sup-when', placeholder: 'Minuti dal via (vuoto = a mano)' });
  const desc = h('input', { class: 'input', 'data-keep': 'sup-desc', placeholder: 'Cosa viene lasciato al Cuore (solo regia)' });
  const msg = h('textarea', { class: 'input', rows: 2, 'data-keep': 'sup-msg', placeholder: `Annuncio (vuoto = testo predefinito)` });
  return h('div', { class: 'stack' },
    section('Nuova finestra armamenti',
      h('p', { class: 'muted tiny' }, `Testo predefinito: «${ms.game.templates.supply}»`),
      h('form', { class: 'form-grid', onsubmit: async (e) => {
        e.preventDefault();
        if (await call('POST', G('/supply'), { scheduledMin: when.value, description: desc.value, message: msg.value }, 'Finestra salvata')) [when, desc, msg].forEach((x) => { x.value = ''; x.dataset.fresh = '1'; });
      } }, when, desc, msg, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Aggiungi'))),
    section('Doni del Consiglio',
      ms.supply.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Quando', 'Descrizione', 'Annuncio', 'Stato', ''].map((x) => h('th', null, x)))),
        h('tbody', null, ms.supply.map((s) => h('tr', null,
          h('td', { class: 'mono' }, s.scheduledMin != null ? fmtMin(s.scheduledMin) : 'a mano'),
          h('td', null, s.description || '—'),
          h('td', { class: 'tiny' }, s.message || h('span', { class: 'muted' }, 'predefinito')),
          h('td', null, s.status === 'fired' ? h('span', { class: 'chip chip-blood' }, `lanciato ${fmtTime(s.firedAt)}`) : h('span', { class: 'chip chip-brass' }, 'in attesa')),
          h('td', { class: 'row-actions' },
            s.status !== 'fired' && active ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => confirmCall('Lanciare ora?', 'Annuncio a tutte le coppie.', 'POST', `/api/m/supply/${s.id}/fire`, {}, 'Doni lanciati') }, 'Lancia ora') : null,
            s.status !== 'fired' ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Eliminare la finestra?', '', 'DELETE', `/api/m/supply/${s.id}`, undefined, 'Eliminata', true) }, 'Elimina') : null)))))) : h('p', { class: 'empty' }, 'Nessuna finestra armamenti.')));
}

// ---------------------------------------------------------------- ANNUNCI E MESSAGGI

function viewComms() {
  const ms = R.ms;
  const teams = [...ms.teams, { ...ms.elect, roman: '0', sectorName: 'Eletti del Consiglio' }];
  if (!R.msgTeam && teams.length) R.msgTeam = (teams.find((t) => t.unread) || teams[0]).id;
  const t = teams.find((x) => x.id === R.msgTeam);
  const thread = ms.messages.filter((m) => m.teamId === R.msgTeam);
  if (t?.unread) api('POST', `/api/m/teams/${t.id}/read`).catch(() => {});
  const reply = h('textarea', { class: 'input', rows: 2, 'data-keep': `reply-${R.msgTeam}`, placeholder: 'Rispondi alla coppia…', maxlength: 1000 });
  return h('div', { class: 'stack' },
    h('div', { class: 'cols-2' },
      section('Annuncio a tutte le coppie', quickAnnounce(),
        h('h3', { class: 'sub' }, 'Storico annunci'),
        ms.announcements.length ? h('ul', { class: 'feed' }, ms.announcements.map((a) => h('li', { class: 'ev' },
          h('span', { class: 'mono tiny muted' }, fmtTime(a.createdAt, true)), h('span', { class: 'ev-type' }, ms.templateLabels[a.type] || 'Libero'), h('span', { class: 'ev-text' }, a.text)))) : h('p', { class: 'empty' }, 'Nessun annuncio.')),
      section('Messaggi con le coppie',
        teams.length ? h('div', { class: 'inbox' },
          h('div', { class: 'inbox-list' }, teams.map((x) => h('button', { class: `inbox-item ${x.id === R.msgTeam ? 'on' : ''}`, onclick: () => { R.msgTeam = x.id; render(); } },
            h('span', null, `${x.roman || ''} ${x.sectorName}`), x.unread ? h('span', { class: 'badge badge-alert' }, x.unread) : null))),
          h('div', { class: 'inbox-thread' },
            h('div', { class: 'thread' }, thread.length ? thread.map((m) => h('div', { class: `bubble ${m.fromRole === 'master' ? 'mine' : 'theirs'}` },
              h('div', { class: 'tiny muted mono' }, `${m.fromRole === 'master' ? m.author || 'regia' : 'coppia'} · ${fmtTime(m.createdAt)}`),
              m.audioMime ? voicePlayer(`/api/media/message/${m.id}`, m.audioMs) : h('div', null, m.text))) : h('p', { class: 'empty' }, 'Nessun messaggio.')),
            R.rec ? h('div', { class: 'regia-rec' },
              h('span', { class: 'rec-dot', 'aria-hidden': 'true' }), h('span', { class: 'mono', id: 'rec-time-regia' }, fmtSec(Date.now() - R.rec.startedAt)),
              h('span', { class: 'tiny muted grow' }, `Vocale per ${t ? t.sectorName : ''}…`),
              h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { R.rec.cancel(); R.rec = null; render(); } }, 'Annulla'),
              h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => sendRegiaVoice() }, 'Invia vocale'))
              : h('form', { class: 'stack-sm', onsubmit: async (e) => {
                e.preventDefault();
                if (!reply.value.trim()) return;
                if (await call('POST', `/api/m/teams/${R.msgTeam}/message`, { text: reply.value }, 'Messaggio inviato')) { reply.value = ''; reply.dataset.fresh = '1'; }
              } }, reply, h('div', { class: 'row-actions' },
                h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, `Invia a ${t ? t.sectorName : ''}`),
                voiceSupported() ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => startRegiaVoice() }, '🎤 Vocale') : null)))) : h('p', { class: 'empty' }, 'Nessuna coppia.'))));
}

// Vocali dalla regia (microfono del PC).
async function startRegiaVoice() {
  try {
    R.rec = await startRecording({ onLimit: () => sendRegiaVoice() });
    render();
  } catch { toast('Microfono non disponibile: consenti l\'accesso al microfono', 'error', 6000); }
}

async function sendRegiaVoice() {
  const rec = R.rec;
  if (!rec) return;
  R.rec = null;
  render();
  const voice = await rec.stop();
  if (voice.ms < 700) return toast('Vocale troppo breve', 'info');
  try {
    await uploadAudio(`/api/m/teams/${R.msgTeam}/message/audio`, voice);
    toast('Vocale inviato', 'ok');
    load();
  } catch (e) { toast(e.message, 'error', 6000); }
}

// ---------------------------------------------------------------- AVVISI

function noticeTargetLabel(n) {
  const ms = R.ms;
  if (n.target === 'team') {
    const t = ms.teams.find((x) => x.id === n.teamId);
    return t ? `Settore ${t.sectorName}` : 'una coppia';
  }
  return ms.noticeTargets[n.target] || n.target;
}

function viewNotices() {
  const ms = R.ms;
  const title = h('input', { class: 'input', 'data-keep': 'nt-title', placeholder: 'Titolo (es. Ritrovo anticipato)', maxlength: 80 });
  const body = h('textarea', { class: 'input', rows: 4, 'data-keep': 'nt-body', placeholder: 'Testo dell\'avviso', maxlength: 1000 });
  const teamSel = h('select', { class: 'input', 'data-keep': 'nt-team' }, ms.teams.map((t) => h('option', { value: t.id }, `${t.roman} · Settore ${t.sectorName}${t.displayName ? ` (${t.displayName})` : ''}`)));
  const teamWrap = h('label', { class: 'field hidden' }, h('span', null, 'Coppia'), teamSel);
  const target = h('select', { class: 'input', 'data-keep': 'nt-target', onchange: () => teamWrap.classList.toggle('hidden', target.value !== 'team') },
    Object.entries(ms.noticeTargets).map(([k, v]) => h('option', { value: k }, v)));
  queueMicrotask(() => teamWrap.classList.toggle('hidden', target.value !== 'team'));
  const devices = ms.teams.reduce((a, t) => a + t.pushDevices, 0) + ms.elect.pushDevices;
  const withPush = ms.teams.filter((t) => t.pushDevices).length + (ms.elect.pushDevices ? 1 : 0);

  return h('div', { class: 'stack' },
    h('div', { class: 'cols-2' },
      section('Nuovo avviso',
        h('p', { class: 'muted tiny' }, 'L\'avviso arriva sul telefono come notifica (Android: anche a schermo spento, se le notifiche sono attive). Toccandola si apre la pagina Avvisi dell\'app. Chi ha l\'app aperta lo vede subito, con vibrazione.'),
        h('form', { class: 'stack-sm', onsubmit: async (e) => {
          e.preventDefault();
          if (!title.value.trim()) return toast('Scrivi il titolo', 'error');
          const dest = target.value === 'team' ? `Settore ${ms.teams.find((t) => String(t.id) === teamSel.value)?.sectorName}` : ms.noticeTargets[target.value];
          if (!(await dialog({ title: 'Inviare l\'avviso?', text: `«${title.value}» a: ${dest}.`, okLabel: 'Invia' }))) return;
          try {
            const r = await api('POST', G('/notices'), { title: title.value, body: body.value, target: target.value, teamId: Number(teamSel.value) || null });
            toast(`Avviso inviato · notifica a ${r.devices} dispositivi`, 'ok', 6000);
            title.value = '';
            body.value = '';
            load();
          } catch (err) { toast(err.message, 'error', 6000); }
        } },
        h('label', { class: 'field' }, h('span', null, 'Titolo'), title),
        h('label', { class: 'field' }, h('span', null, 'Testo'), body),
        h('label', { class: 'field' }, h('span', null, 'Destinatari'), target),
        teamWrap,
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Invia avviso'))),
      section('Notifiche sui telefoni',
        h('div', { class: 'big' }, `${devices} dispositivi`),
        h('p', { class: 'muted tiny' }, `Accessi con notifiche attive: ${withPush} su ${ms.teams.length + 1} (coppie + Eletti). Ogni giocatore le attiva dall'app: c'è un invito in home e il pulsante in Impostazioni. Servono HTTPS e, su Android, Chrome; meglio con l'app installata nella schermata home.`),
        h('ul', { class: 'users' }, [...ms.teams, { ...ms.elect, roman: '0', sectorName: 'Eletti del Consiglio' }].map((t) => h('li', null,
          h('strong', null, `${t.roman || ''} ${t.sectorName}`), h('span', { class: `chip ${t.pushDevices ? 'chip-ok' : ''}` }, t.pushDevices ? `${t.pushDevices} con notifiche` : 'nessuna notifica'),
          h('span', { class: 'tiny muted' }, `${t.online} online`)))))),
    section(`Avvisi inviati (${ms.notices.length})`,
      ms.notices.length ? h('ul', { class: 'notice-list' }, ms.notices.map((n) => h('li', null,
        h('div', { class: 'grow' },
          h('div', { class: 'notice-head' }, h('strong', null, n.title), h('span', { class: 'chip' }, noticeTargetLabel(n)), h('span', { class: 'mono tiny muted' }, `${fmtTime(n.createdAt)} · ${n.author || 'regia'}`)),
          n.body ? h('p', null, n.body) : null),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Eliminare l\'avviso?', 'Sparisce dalla pagina Avvisi dei telefoni (le notifiche già arrivate restano).', 'DELETE', `/api/m/notices/${n.id}`, undefined, 'Avviso eliminato', true) }, 'Elimina')))) : h('p', { class: 'empty' }, 'Nessun avviso inviato.')));
}

// ---------------------------------------------------------------- CLASSIFICA

function viewStandings() {
  const ms = R.ms;
  return h('div', { class: 'stack' },
    sectionActions('Classifica', [h('a', { class: 'btn btn-sm btn-primary', href: '/soglia', target: '_blank' }, 'Apri la Soglia (validazione)')],
      h('p', { class: 'muted tiny' }, 'Prima le coppie validate in ordine di arrivo, poi le altre per frammenti posseduti; a parità vince chi ha ottenuto l\'ultimo frammento prima. Le ritirate sono escluse. I frammenti ricevuti a mano contano come quelli sbloccati.'),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['#', 'Settore', 'Frammenti', 'Ultimo frammento', 'Stato'].map((x) => h('th', null, x)))),
        h('tbody', null, ms.standings.map((s) => h('tr', { class: s.status === 'won' ? 'row-won' : '' },
          h('td', { class: 'mono big' }, s.rank),
          h('td', null, h('strong', null, `${s.roman} ${s.sectorName}`), s.displayName ? h('div', { class: 'tiny muted' }, s.displayName) : null),
          h('td', { class: 'mono' }, s.fragments),
          h('td', { class: 'mono tiny' }, s.lastAt ? fmtTime(s.lastAt, true) : '—'),
          h('td', null, s.status === 'won' ? h('span', { class: 'chip chip-ok' }, `validata · ${s.finishPosition}°`) : h('span', { class: 'chip' }, 'in gioco')))))))),
    section('Validazioni alla Soglia',
      ms.validations.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Ora', 'Coppia', 'Esito', 'Mancanti', 'Validatore', 'Note'].map((x) => h('th', null, x)))),
        h('tbody', null, ms.validations.map((v) => {
          const t = ms.teams.find((x) => x.id === v.teamId);
          const miss = v.missing ? JSON.parse(v.missing) : [];
          return h('tr', null, h('td', { class: 'mono' }, fmtTime(v.at, true)), h('td', null, teamLabel(t)),
            h('td', null, h('span', { class: `chip ${v.result === 'valid' ? 'chip-ok' : 'chip-blood'}` }, { valid: 'valida', incomplete: 'incompleta', wrong: 'errata' }[v.result])),
            h('td', { class: 'tiny' }, miss.map((m) => `#${m.position}${m.status === 'wrong' ? ' ✗' : ''}`).join(', ') || '—'),
            h('td', null, v.username || '—'), h('td', { class: 'tiny' }, v.notes || ''));
        })))) : h('p', { class: 'empty' }, 'Nessuna validazione.')));
}

// ---------------------------------------------------------------- REGISTRO

function viewLog() {
  return section('Registro eventi', h('p', { class: 'muted tiny' }, 'Ultimi 150 eventi della partita con ora del server: sblocchi, tentativi, annunci, validazioni e azioni di regia.'), eventFeed(150));
}

// ---------------------------------------------------------------- IMPOSTAZIONI

function gameForm(g, isNew) {
  const locked = !isNew && !PRE.includes(g.status);
  const f = (key, label, type = 'text', extra = {}) => h('label', { class: 'field' }, h('span', null, label),
    h('input', { class: 'input', name: key, type, value: g?.[key] ?? extra.def ?? '', disabled: locked && extra.lock, 'data-keep': `gf-${key}`, ...extra.attrs }));
  return h('form', { class: 'form-grid wide', onsubmit: async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    if (isNew) {
      const r = await call('POST', '/api/m/games', data, 'Partita creata');
      if (r) { await loadGames(); R.gameId = r.id; store.set('zdg_regia_game', r.id); location.hash = 'coppie'; load(); }
    } else {
      await call('PATCH', `/api/m/games/${g.id}`, data, 'Parametri salvati');
      loadGames();
    }
  } },
  f('name', 'Nome della partita', 'text', { attrs: { required: true, placeholder: 'Zero Dark Games – ottobre 2026' } }),
  f('scheduledStart', 'Data e ora previste', 'datetime-local'),
  f('emergencyRadioChannel', 'Canale radio d\'emergenza', 'text', { attrs: { placeholder: 'es. PMR 8 · 446.09375' } }),
  f('bookUrl', 'Link al regolamento', 'text', { def: '/regolamento.html' }),
  f('durationMin', 'Durata (min)', 'number', { def: 240, lock: true }),
  f('truceMin', 'Tregua iniziale (min)', 'number', { def: 5, lock: true }),
  f('firstRevelationDelayMin', 'Prima rivelazione dopo la caccia (min)', 'number', { def: 30, lock: true }),
  f('lastRevelationBeforeEndMin', 'Nessuna rivelazione negli ultimi (min)', 'number', { def: 30, lock: true }),
  f('neverRevealedCount', 'Sigilli mai rivelati', 'number', { def: 2, lock: true }),
  f('codeLength', 'Lunghezza Sigillo', 'number', { def: 6, lock: true }),
  h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, isNew ? 'Crea partita' : 'Salva parametri'),
    locked ? h('span', { class: 'tiny muted' }, 'Tempi e Sigilli non sono più modificabili dopo il via.') : null));
}

// ---- indirizzo usato in link e QR (localhost funziona solo sul PC: per i telefoni in Wi-Fi serve l'IP del PC)
let publicUrlInfo = null;

function publicUrlSection() {
  if (!publicUrlInfo) {
    api('GET', '/api/m/settings/public-url').then((r) => { publicUrlInfo = r; render(); }).catch((e) => toast(e.message, 'error'));
    return section('Indirizzo per link e QR', h('p', { class: 'empty' }, 'Caricamento…'));
  }
  const info = publicUrlInfo;
  const input = h('input', { class: 'input mono', 'data-keep': 'public-url', value: info.publicUrl, placeholder: 'http://192.168.1.50:8090', inputmode: 'url', autocomplete: 'off', spellcheck: 'false' });
  const result = h('div', { class: 'tiny', 'aria-live': 'polite' });
  const isLocal = (u) => /\/\/(localhost|127\.|\[::1\])/i.test(u);

  // Prova dal browser della regia se l'indirizzo risponde.
  const test = async (url) => {
    const target = (url || '').trim().replace(/\/$/, '');
    if (!target) return;
    const full = /^https?:\/\//i.test(target) ? target : `http://${target}`;
    result.className = 'tiny';
    result.textContent = `Prova di ${full}…`;
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(`${full}/api/health`, { cache: 'no-store', signal: ctrl.signal });
      result.className = r.ok ? 'tiny ok-text' : 'tiny bad';
      result.textContent = r.ok ? `✓ ${full} risponde da questo PC.` : `✗ ${full} ha risposto con errore ${r.status}.`;
    } catch {
      result.className = 'tiny bad';
      result.textContent = `✗ ${full} non risponde da questo PC: controlla indirizzo e porta.`;
    }
  };
  const save = async (value) => {
    try {
      const r = await api('PUT', '/api/m/settings/public-url', { publicUrl: value });
      R.baseUrl = r.current;
      publicUrlInfo = null;
      toast(value ? `Link e QR useranno ${r.current}` : `Ripristinato: ${r.current}`, 'ok', 6000);
      render();
    } catch (e) { toast(e.message, 'error', 7000); }
  };

  return section('Indirizzo per link e QR',
    h('p', { class: 'muted tiny' }, 'È l\'indirizzo che finisce nei QR (cartelli degli Altari, credenziali, iscrizione) e nei link di accesso. "localhost" funziona solo su questo PC: per i telefoni collegati allo stesso Wi-Fi usa l\'IP del PC, ad esempio http://192.168.1.50:8090. In produzione metti l\'indirizzo https del dominio.'),
    h('div', { class: 'url-now' }, h('span', { class: 'eyebrow' }, 'In uso adesso'), h('strong', { class: 'mono' }, info.current),
      isLocal(info.current) ? h('span', { class: 'chip chip-warn' }, 'solo questo PC') : h('span', { class: 'chip chip-ok' }, 'raggiungibile in rete')),
    h('form', { class: 'url-form', onsubmit: (e) => { e.preventDefault(); save(input.value); } },
      input,
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Salva'),
      h('button', { class: 'btn', type: 'button', onclick: () => test(input.value || info.current) }, 'Prova')),
    result,
    h('div', { class: 'row-actions' },
      !isLocal(location.origin) && location.origin !== info.current ? h('button', { class: 'btn btn-sm', onclick: () => save(location.origin) }, `Usa ${location.origin}`) : null,
      info.publicUrl ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => save('') }, info.envPublicUrl ? `Torna a ${info.envPublicUrl} (file .env)` : 'Torna all\'indirizzo della pagina') : null),
    h('ul', { class: 'tiny muted hints' },
      h('li', null, 'IP del PC: tasto Windows → "cmd" → ipconfig → "Indirizzo IPv4" della scheda Wi-Fi. Telefoni e PC devono essere sullo stesso Wi-Fi.'),
      h('li', null, 'Se dal telefono la pagina non si apre, il firewall di Windows sta bloccando la porta: va consentita una volta (vedi README).'),
      h('li', null, 'Dopo il cambio, ristampa cartelli degli Altari e credenziali: i QR già stampati contengono il vecchio indirizzo.'),
      h('li', null, 'In Wi-Fi (http) il gioco funziona, ma notifiche push, installazione dell\'app e fotocamera interna richiedono https: per provarle usa il tunnel.')));
}

function viewNewGame(first) {
  return h('div', { class: 'stack' },
    section(first ? 'Benvenuto, Consiglio' : 'Nuova partita',
      first ? h('p', { class: 'muted' }, 'Crea la prima partita. Poi: iscrizioni e coppie → Sigilli → Altari e Parola → cerchio → VIA.') : null,
      gameForm({ name: '', bookUrl: '/regolamento.html' }, true)),
    section('Vuoi solo provare?',
      h('p', { class: 'muted' }, 'Crea una partita di prova già preparata, con giocatori finti, e fai avanzare il tempo per vedere tutto il gioco in pochi minuti.'),
      h('button', { class: 'btn btn-primary', onclick: createDemo }, 'Crea partita di prova')));
}

function viewSettings() {
  const ms = R.ms;
  const g = ms.game;
  if (!R.users.length) api('GET', '/api/m/users').then((u) => { R.users = u; if (tab() === 'impostazioni') render(); }).catch(() => {});
  const tpl = Object.keys(ms.templateLabels).map((k) => h('label', { class: 'field' }, h('span', null, ms.templateLabels[k]),
    h('textarea', { class: 'input', rows: 2, name: k, 'data-keep': `tpl-${k}`, value: g.templates[k] })));
  const timers = g.timers.map((t) => h('label', { class: 'field' }, h('span', null, `${t.label} (min)`), h('input', { class: 'input', type: 'number', step: '0.5', min: 0.5, name: t.id, value: t.minutes, 'data-keep': `tm-${t.id}` })));
  const uName = h('input', { class: 'input', placeholder: 'username', 'data-keep': 'u-name' });
  const uPass = h('input', { class: 'input', type: 'password', placeholder: 'password (min 6)', 'data-keep': 'u-pass', autocomplete: 'new-password' });
  const uRole = h('select', { class: 'input', 'data-keep': 'u-role' }, h('option', { value: 'validator' }, 'Validatore (Soglia)'), h('option', { value: 'master' }, 'Master (regia)'));
  return h('div', { class: 'stack' },
    publicUrlSection(),
    section('Parametri della partita', gameForm(g, false)),
    h('div', { class: 'cols-2' },
      section('Testi degli annunci',
        h('p', { class: 'muted tiny' }, '[settore], [codice] e [posizione] si compilano in automatico.'),
        h('form', { class: 'stack-sm', onsubmit: (e) => { e.preventDefault(); call('PATCH', `/api/m/games/${g.id}`, { templates: Object.fromEntries(new FormData(e.target).entries()) }, 'Testi salvati'); } },
          tpl, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Salva testi'))),
      h('div', { class: 'stack' },
        section('Timer delle coppie',
          h('form', { class: 'form-grid', onsubmit: (e) => { e.preventDefault(); call('PATCH', `/api/m/games/${g.id}`, { timers: Object.fromEntries(new FormData(e.target).entries()) }, 'Timer salvati'); } },
            timers, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Salva timer'))),
        section('Organizzazione',
          h('ul', { class: 'users' }, R.users.map((u) => h('li', null, h('strong', null, u.username), h('span', { class: 'chip' }, u.role === 'master' ? 'master' : 'validatore'),
            u.id !== R.me.id ? h('button', { class: 'btn btn-sm btn-ghost', onclick: async () => { if (await confirmCall('Eliminare l\'utente?', u.username, 'DELETE', `/api/m/users/${u.id}`, undefined, 'Utente eliminato', true)) { R.users = []; render(); } } }, 'Elimina') : h('span', { class: 'tiny muted' }, 'tu'),
            h('button', { class: 'btn btn-sm btn-ghost', onclick: async () => { const p = await dialog({ title: `Nuova password per ${u.username}`, input: { type: 'password', placeholder: 'min 6 caratteri' }, okLabel: 'Salva' }); if (p) call('PATCH', `/api/m/users/${u.id}`, { password: p }, 'Password aggiornata'); } }, 'Password')))),
          h('form', { class: 'form-grid', onsubmit: async (e) => {
            e.preventDefault();
            if (await call('POST', '/api/m/users', { username: uName.value, password: uPass.value, role: uRole.value }, 'Utente creato')) { R.users = []; uName.value = ''; uPass.value = ''; uName.dataset.fresh = uPass.dataset.fresh = '1'; render(); }
          } }, uName, uPass, uRole, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Aggiungi'))),
        section('Notifiche alla regia',
          h('p', { class: 'muted tiny' }, 'Ricevi push per iscrizioni e messaggi delle coppie (serve HTTPS).'),
          h('button', { class: 'btn', onclick: async () => { try { await enablePush('staff'); toast('Notifiche attive', 'ok'); } catch (e) { toast(e.message, 'error', 6000); } } }, 'Attiva notifiche')),
        section('Partita di prova',
          h('p', { class: 'muted tiny' }, 'Crea una nuova partita già preparata con giocatori finti, per provare il gioco.'),
          h('button', { class: 'btn', onclick: createDemo }, 'Crea partita di prova')),
        section('Zona pericolosa',
          h('button', { class: 'btn btn-danger', disabled: ACTIVE.includes(g.status) || g.status === 'paused', onclick: async () => {
            if (await confirmCall('Eliminare la partita?', `«${g.name}» e tutti i suoi dati (coppie, Sigilli, registro) verranno cancellati definitivamente.`, 'DELETE', `/api/m/games/${g.id}`, undefined, 'Partita eliminata', true)) { await loadGames(); load(); }
          } }, 'Elimina partita')))));
}
