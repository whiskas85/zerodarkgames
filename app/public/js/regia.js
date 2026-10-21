// Dashboard della regia (utente MASTER): preparazione, motore di gioco, comunicazioni.
import * as CKUI from './checkin-ui.js';
import { h, mount, md, mdEditor, api, makeClock, fmtDuration, fmtTime, fmtMin, ghost, toast, dialog, modal, stream, enablePush, store, STATUS_LABELS, voiceSupported, startRecording, uploadAudio, voicePlayer, fmtSec } from './lib.js';
import { createMapView, positionItem, landmarkItem, groupPositions, loadLeaflet } from './map.js';

const $root = document.getElementById('root');
const clock = makeClock();
const R = {
  me: null,
  games: [],
  gameId: store.get('zdg_regia_game'),
  ms: null,
  baseUrl: location.origin,
  users: [],
  chat: null, // conversazione aperta in Annunci e messaggi: { kind: 'all'|'team'|'elect'|'squad', id }
  showAll: false,
  seenRevealed: null,
};

const TABS = [
  ['live', 'Regia'],
  ['emergenze', '🚨 Emergenze'],
  ['coppie', 'Iscrizioni e coppie'],
  ['accettazione', 'Accettazione'],
  ['squadre', 'Squadre Eletti'],
  ['settori', 'Settori e Altari'],
  ['altari', 'Altari e Parola'],
  ['sigilli', 'Sigilli e tradimenti'],
  ['mappa', 'Mappa e campo'],
  ['doniqr', 'Doni QR'],
  ['catalogo', 'Skill e Doni'],
  ['doni', 'Armamenti'],
  ['comunicazioni', 'Annunci e messaggi'],
  ['avvisi', 'Avvisi'],
  ['notifiche', 'Notifiche, Traccar e ICE'],
  ['classifica', 'Classifica'],
  ['registro', 'Registro'],
  ['regolamento', 'Regolamento'],
  ['consiglio', 'Consiglio Zero'],
  ['impostazioni', 'Impostazioni'],
];
// Nei testi markdown: pulsante che porta alla pagina ICE dell'app.
const ICE_TOOL = [{ label: '✚ ICE', title: 'Pulsante per compilare i dati ICE', before: '[', after: '](#/ice)', sample: 'Compila i dati ICE' }];
const ACTIVE = ['truce', 'hunt', 'last_half_hour'];
const PRE = ['created', 'draft', 'ready', 'circle'];

const tab = () => (location.hash.slice(1) || 'live');

// ---------------------------------------------------------------- avvio

// Installazione come app (computer, tablet, Android): il browser la propone, noi mostriamo il pulsante.
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); R.install = e; render(); });
window.addEventListener('appinstalled', () => { R.install = null; toast('Regia installata come app', 'ok'); render(); });

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
    refresh: (d) => { if (d.reason === 'council' && tab() === 'consiglio') loadCouncil(); if (d.gameId === R.gameId || d.gameId == null) { load(); if (tab() === 'notifiche' && !R.pushLoading) { R.pushLoading = true; loadPushReport().finally(() => { R.pushLoading = false; }); } } },
    // EMERGENZA reale: la regia passa subito alla partita e alla pagina Emergenze, con allarme sonoro.
    emergency: async (d) => {
      if (d.gameId && d.gameId !== R.gameId) { R.gameId = d.gameId; store.set('zdg_regia_game', R.gameId); R.ms = null; }
      location.hash = 'emergenze';
      await load();
      emergencyAlarm();
    },
    // Maestro della caccia: incarico da assegnare. Allarme e salto alla pagina Squadre.
    task_pending: async (d) => {
      if (d.gameId && d.gameId !== R.gameId) return;
      location.hash = 'squadre';
      await load();
      toast(h('a', { href: '#squadre' }, h('strong', null, `🎯 ${d.title}`), h('div', { class: 'small' }, d.body)), 'info', 15000);
      emergencyAlarm();
    },
    // Con la regia aperta l'avviso arriva anche qui (iscrizioni, messaggi, scontri contestati…).
    notify: (n) => {
      toast(h('a', { href: n.url?.startsWith('/regia') ? n.url.replace('/regia', '') || '#' : '#' }, h('strong', null, n.title), n.body ? h('div', { class: 'small' }, n.body) : null), 'info', 9000);
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
    },
  });
  await load();
  checkPush(true);
}

// ---------------------------------------------------------------- notifiche della regia

// Stato su questo dispositivo: 'on' | 'off' | 'denied' | 'unsupported'.
async function checkPush(renew = false) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { R.push = 'unsupported'; render(); return; }
  if (Notification.permission === 'denied') { R.push = 'denied'; render(); return; }
  try {
    // Permesso già dato: si riregistra in silenzio (le iscrizioni push del browser a volte scadono).
    if (renew && Notification.permission === 'granted') await enablePush('staff');
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    const st = sub ? await api('GET', `/api/m/push/status?endpoint=${encodeURIComponent(sub.endpoint)}`) : null;
    R.push = Notification.permission === 'granted' && st?.thisDevice ? 'on' : 'off';
  } catch { R.push = 'off'; }
  render();
}

async function pushDialog() {
  const iphone = /iPhone|iPad/.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches;
  const text = {
    on: 'Le notifiche della regia arrivano su questo dispositivo: nuove iscrizioni e candidature agli Eletti, messaggi delle coppie, scontri contestati, doni presi.',
    off: 'Attivale per ricevere un avviso a ogni nuova iscrizione (coppie, temerari, candidature agli Eletti), ai messaggi delle coppie, agli scontri contestati e ai doni presi, anche con la regia chiusa.',
    denied: 'Il browser ha bloccato le notifiche per questo sito: riattivale dalle impostazioni del sito (lucchetto nella barra dell\'indirizzo), poi ricarica la pagina.',
    unsupported: 'Questo browser non supporta le notifiche push (serve HTTPS).',
  }[R.push || 'off'];
  let dlg = null;
  const off = async () => {
    try {
      const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (sub) await api('POST', '/api/m/push/off', { endpoint: sub.endpoint });
      toast('Notifiche disattivate su questo dispositivo', 'ok');
    } catch (e) { toast(e.message, 'error', 7000); }
    dlg?.querySelector('.dlg-actions .btn-ghost')?.click();
  };
  const ok = await modal({
    title: 'Notifiche della regia', okLabel: R.push === 'on' ? 'Invia una prova' : R.push === 'off' ? 'Attiva notifiche' : 'Ho capito', cancelLabel: 'Chiudi',
    // Niente da fare (bloccate o non supportate): un solo pulsante.
    onOpen: (d) => { dlg = d; if (!['on', 'off'].includes(R.push)) d.querySelector('.dlg-actions .btn-ghost')?.remove(); },
    body: h('div', { class: 'stack-sm' }, h('p', null, text),
      iphone ? h('p', { class: 'tiny muted' }, 'Su iPhone le notifiche arrivano solo se l\'app è aggiunta alla schermata Home (Condividi → Aggiungi a Home) e aperta da lì.') : null,
      R.push === 'on' ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: off }, 'Disattiva su questo dispositivo') : null),
  });
  try {
    if (ok && R.push === 'off') { await enablePush('staff'); toast('Notifiche attive su questo dispositivo', 'ok'); }
    else if (ok && R.push === 'on') { const r = await api('POST', '/api/m/push/test'); toast(`Prova inviata a ${r.devices} ${r.devices === 1 ? 'dispositivo' : 'dispositivi'}`, 'ok'); }
  } catch (e) { toast(e.message, 'error', 7000); }
  checkPush();
}

const pushButton = (cls = 'btn btn-sm') => h('button', { class: `${cls} ${R.push === 'off' ? 'btn-primary' : ''}`, type: 'button', onclick: pushDialog, title: 'Notifiche della regia' },
  R.push === 'on' ? '🔔 Notifiche attive' : R.push === 'off' ? '🔔 Attiva notifiche' : '🔕 Notifiche');

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
// Numeri di telefono: chiamata e chat WhatsApp (wa.me). Senza prefisso internazionale si assume l'Italia (+39).
function waNumber(phone) {
  let d = String(phone || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (/^3\d{8,9}$/.test(d) || /^0\d{5,10}$/.test(d)) d = `39${d}`;
  return d.replace(/\D/g, '');
}
const waUrl = (phone) => `https://wa.me/${waNumber(phone)}`;
function phoneLinks(phone, { cls = 'tiny' } = {}) {
  if (!phone) return null;
  return h('span', { class: `phone-links ${cls}` },
    h('a', { href: `tel:${String(phone).replace(/\s/g, '')}`, title: 'Chiama' }, `☎ ${phone}`),
    h('a', { class: 'wa-link', href: waUrl(phone), target: '_blank', rel: 'noopener', title: 'Scrivi su WhatsApp' }, 'WhatsApp'));
}
const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  // Regolamento già aperto: non si ridisegna (l'iframe ripartirebbe dall'inizio).
  const frame = document.querySelector('.rules-frame');
  if (tab() === 'regolamento' && frame && frame.getAttribute('src') === (R.ms?.game?.bookUrl || '/regolamento.html')) return tick();
  preserve(() => {
    const ms = R.ms;
    const body = tab() === 'settori' ? viewSectors() : tab() === 'consiglio' ? viewCouncil() : tab() === 'regolamento' ? viewRules() : !R.gameId ? viewNewGame(true) : !ms ? h('p', { class: 'empty' }, 'Caricamento…') : ({
      live: viewLive, coppie: viewTeams, altari: viewAltars, sigilli: viewCodes, doni: viewSupply, mappa: viewFieldMap, doniqr: viewGiftsQR, catalogo: viewCatalog, accettazione: viewCheckin, armi: viewChrono, squadre: viewSquads,
      comunicazioni: viewComms, avvisi: viewNotices, notifiche: viewPushReport, emergenze: viewEmergencies, classifica: viewStandings, registro: viewLog, impostazioni: viewSettings,
    }[tab()] || viewLive)();
    mount($root, topbar(), emergencyBanner(), taskBanner(), h('div', { class: 'shell' }, sidebar(), h('section', { class: 'content' }, body)));
  });
  labelTables($root);
  tick();
}

// Sul telefono le tabelle diventano schede: ogni cella porta il nome della sua colonna (vedi regia.css).
function labelTables(root) {
  for (const t of root.querySelectorAll('.table-wrap table')) {
    const heads = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    for (const tr of t.querySelectorAll('tbody tr')) [...tr.children].forEach((td, i) => { td.dataset.label = heads[i] || ''; });
  }
}

// ---------------------------------------------------------------- EMERGENZE (reali, OFF GAME)

const openEmergencies = () => (R.ms?.emergencies || []).filter((e) => !e.closedAt);

// Allarme: sirena breve e vibrazione (ripetuta finché c'è un'emergenza non presa in carico e la pagina è aperta).
let alarmTimer = null;
function emergencyAlarm() {
  const beepOnce = () => {
    try {
      const ctx = emergencyAlarm.ctx || (emergencyAlarm.ctx = new (window.AudioContext || window.webkitAudioContext)());
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'square'; o.connect(g); g.connect(ctx.destination); g.gain.value = 0.08;
      o.frequency.setValueAtTime(880, ctx.currentTime); o.frequency.setValueAtTime(660, ctx.currentTime + 0.25); o.frequency.setValueAtTime(880, ctx.currentTime + 0.5);
      o.start(); o.stop(ctx.currentTime + 0.75);
    } catch { /* audio non disponibile */ }
    if (navigator.vibrate) navigator.vibrate([400, 150, 400]);
  };
  beepOnce();
  clearInterval(alarmTimer);
  alarmTimer = setInterval(() => { if (openEmergencies().some((e) => !e.ackAt)) beepOnce(); else clearInterval(alarmTimer); }, 4000);
}

// Fascia rossa in cima a ogni pagina finché ci sono emergenze aperte.
// Incarichi chiesti dalle coppie (Maestro della caccia…) ancora da assegnare: banner in ogni pagina finché restano aperti.
function taskBanner() {
  const list = R.ms?.pendingTasks || [];
  if (!list.length || tab() === 'squadre') return null;
  return h('a', { class: 'task-banner', href: '#squadre' },
    h('strong', null, `🎯 ${list.length === 1 ? 'Incarico da assegnare' : `${list.length} incarichi da assegnare`}`),
    h('span', null, ' — ', list.map((t) => `${t.text || t.targetLabel || 'Incarico'} (chiesto alle ${fmtTime(t.createdAt)})`).join(' · ')));
}

function emergencyBanner() {
  const open = openEmergencies();
  if (!open.length) return null;
  const waiting = open.filter((e) => !e.ackAt).length;
  return h('a', { class: `sos-banner ${waiting ? 'waiting' : ''}`, href: '#emergenze' },
    h('strong', null, `🚨 ${open.length === 1 ? 'Emergenza aperta' : `${open.length} emergenze aperte`}`),
    h('span', null, waiting ? ` · ${waiting} da prendere in carico` : ' · in carico', ' — ', open.map((e) => e.who).join(', ')));
}

const sosMap = createMapView({ className: 'regia-map sos-map' });
function emergencyItems() {
  return (R.ms?.emergencies || []).flatMap((e) => {
    const open = !e.closedAt;
    const label = `<strong>🚨 ${escHtml(e.who)}</strong><br>${fmtTime(e.createdAt)} · ${e.source === 'traccar' ? 'SOS da Traccar' : 'pulsante dell\'app'}${e.phone ? `<br>☎ <a href="tel:${escHtml(e.phone.replace(/\s/g, ''))}">${escHtml(e.phone)}</a> · <a href="${escHtml(waUrl(e.phone))}" target="_blank" rel="noopener">WhatsApp</a>` : ''}`;
    const out = [];
    if (e.lat != null) out.push({ key: `sos${e.id}`, kind: 'emergency', lat: e.lat, lng: e.lng, text: '!', state: open ? '' : 'closed', title: e.who, popup: `${label}<br><small>Posizione della chiamata${e.acc ? ` · ±${e.acc} m` : ''}</small>` });
    if (open && e.live) out.push({ key: `sosl${e.id}`, kind: 'emergency', lat: e.live.lat, lng: e.live.lng, text: '◉', state: 'live', title: `${e.who} adesso`, popup: `${label}<br><small>Ultima posizione ${fmtTime(e.live.at)}</small>` });
    return out;
  });
}

function viewEmergencies() {
  const list = R.ms.emergencies || [];
  if (!fieldData) loadField(false);
  startPositions();
  sosMap.setItems([...(fieldData ? fieldMapItems(fieldData) : []), ...emergencyItems()]);
  sosMap.refresh();
  const open = list.filter((e) => !e.closedAt);
  const focus = open.filter((e) => e.lat != null || e.live).map((e) => (e.live ? `sosl${e.id}` : `sos${e.id}`));
  if (focus.length && R.sosFocused !== focus.join()) { R.sosFocused = focus.join(); setTimeout(() => sosMap.focus?.(focus), 200); }
  const gmaps = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  const card = (e) => h('div', { class: `sos-card ${e.closedAt ? 'closed' : e.ackAt ? 'ack' : 'new'}` },
    h('div', { class: 'sos-card-head' },
      h('strong', null, `🚨 ${e.who}`),
      h('span', { class: 'chip' }, e.source === 'traccar' ? 'SOS Traccar' : 'pulsante app'),
      h('span', { class: `chip ${e.closedAt ? '' : e.ackAt ? 'chip-warn' : 'chip-blood'}` }, e.closedAt ? `chiusa ${fmtTime(e.closedAt)}` : e.ackAt ? `in carico (${e.ackBy})` : 'DA PRENDERE IN CARICO')),
    h('div', { class: 'small' }, `Chiamata alle ${fmtTime(e.createdAt)}`, e.phone ? [' · ', phoneLinks(e.phone, { cls: '' })] : null),
    e.lat != null ? h('div', { class: 'small mono' }, `Posizione: ${e.lat.toFixed(5)}, ${e.lng.toFixed(5)}${e.acc ? ` (±${e.acc} m)` : ''} · `, h('a', { href: gmaps(e.lat, e.lng), target: '_blank', rel: 'noopener' }, 'Apri in Google Maps'))
      : h('div', { class: 'small bad' }, 'Posizione sconosciuta: chiedetela via radio.'),
    // ICE: i dati sanitari arrivano solo con l'emergenza che la persona ha chiamato.
    e.ice ? h('div', { class: 'ice-box' },
      h('div', { class: 'eyebrow' }, 'ICE · In Case of Emergency'),
      e.ice.blood ? h('div', null, h('span', { class: 'muted small' }, 'Gruppo sanguigno: '), h('strong', null, e.ice.blood)) : null,
      e.ice.conditions ? h('div', null, h('span', { class: 'muted small' }, 'Per i soccorritori: '), h('strong', null, e.ice.conditions)) : null,
      e.ice.contactName || e.ice.contactPhone ? h('div', null, h('span', { class: 'muted small' }, 'Contatto di emergenza: '), h('strong', null, e.ice.contactName || ''),
        e.ice.contactPhone ? [' · ', phoneLinks(e.ice.contactPhone, { cls: '' })] : null) : null)
      : h('div', { class: 'tiny muted' }, 'Nessun dato ICE nel profilo di chi ha chiamato.'),
    e.live && !e.closedAt ? h('div', { class: 'small mono' }, `Ultima posizione ${fmtTime(e.live.at)}: ${e.live.lat.toFixed(5)}, ${e.live.lng.toFixed(5)} · `, h('a', { href: gmaps(e.live.lat, e.live.lng), target: '_blank', rel: 'noopener' }, 'Maps')) : null,
    e.note ? h('div', { class: 'small' }, `Nota: ${e.note}`) : null,
    e.closedAt ? null : h('div', { class: 'row-actions' },
      e.ackAt ? null : h('button', { class: 'btn btn-primary', onclick: () => call('POST', `/api/m/emergencies/${e.id}/ack`, {}, 'Presa in carico: chi ha chiamato è stato avvisato') }, 'Prendo in carico'),
      h('button', { class: 'btn', onclick: async () => {
        const note = await dialog({ title: 'Chiudere l\'emergenza?', text: `${e.who}: scrivi com'è finita (facoltativo).`, input: { placeholder: 'es. raggiunto, tutto a posto' }, okLabel: 'Chiudi emergenza' });
        if (note === null) return;
        call('POST', `/api/m/emergencies/${e.id}/close`, { note }, 'Emergenza chiusa');
      } }, 'Chiudi')));
  return h('div', { class: 'stack' },
    section(`Emergenze (${open.length} aperte)`,
      h('p', { class: 'muted tiny' }, 'Emergenze reali (OFF GAME), non di gioco: arrivano dal pulsante EMERGENZA dell\'app o dal pulsante SOS di Traccar Client, con la posizione di chi chiama. Quando ne arriva una la regia salta qui con un allarme sonoro. Il segnaposto rosso è dove ha chiamato, quello arancione la sua ultima posizione.'),
      list.length ? h('div', { class: 'stack-sm' }, list.map(card)) : h('p', { class: 'empty' }, 'Nessuna emergenza.')),
    section('Mappa', sosMap.el));
}

function topbar() {
  const ms = R.ms;
  const st = ms?.clock.status;
  const alerts = navAlerts();
  return h('header', { class: 'topbar' },
    // Telefono: il menu delle sezioni si apre con l'hamburger.
    h('button', { class: 'nav-toggle', type: 'button', 'aria-label': 'Menu', onclick: () => document.body.classList.toggle('nav-open') }, '☰',
      alerts ? h('span', { class: 'badge badge-alert' }, alerts) : null),
    h('div', { class: 'brand' }, h('div', { class: 'emblem sm' }, h('span', null, '0')), h('div', null, h('div', { class: 'brand-t' }, 'Consiglio Zero'), h('div', { class: 'eyebrow' }, 'Regia · Zero Dark Games'))),
    h('select', { class: 'input game-select', 'aria-label': 'Partita', onchange: (e) => { if (e.target.value === 'new') { location.hash = 'impostazioni'; R.gameId = null; render(); return; } R.gameId = Number(e.target.value); store.set('zdg_regia_game', R.gameId); R.ms = null; R.seenRevealed = null; load(); } },
      R.games.map((g) => h('option', { value: g.id, selected: g.id === R.gameId }, `${g.name} · ${STATUS_LABELS[g.status]}`)),
      h('option', { value: 'new' }, '+ Nuova partita')),
    ms ? h('div', { class: 'top-clock' },
      h('span', { class: `chip status-${st}` }, STATUS_LABELS[st]),
      h('div', null, h('div', { class: 'mono clock-big', 'data-clock': 'remaining' }, '—'), h('div', { class: 'mono muted tiny' }, 'trascorso ', h('span', { 'data-clock': 'elapsed' }, '—')))) : null,
    h('div', { class: 'top-actions' },
      // Installa app: solo se la regia non è già installata. Notifiche: solo se non sono attive su questo dispositivo.
      R.install && !installedApp() ? h('button', { class: 'btn btn-sm', type: 'button', title: 'Installa la regia come app su questo dispositivo', onclick: async () => { const ev = R.install; R.install = null; ev.prompt(); await ev.userChoice.catch(() => null); render(); } }, '⤓ Installa app') : null,
      R.push && R.push !== 'on' ? pushButton() : null,
      h('button', { class: 'btn btn-sm btn-ghost', onclick: async () => { await api('POST', '/api/auth/logout').catch(() => {}); location.href = '/'; } }, 'Esci')));
}

// Avvisi da guardare (messaggi, emergenze, iscrizioni, incarichi): il numero sull'hamburger.
function navAlerts() {
  const ms = R.ms;
  if (!ms) return 0;
  const unread = ms.teams.reduce((a, t) => a + t.unread, 0) + (ms.elect?.unread || 0) + (ms.squads?.reduce((a, s) => a + s.unread, 0) || 0);
  const pending = ms.players.filter((p) => p.status === 'pending').length;
  return unread + openEmergencies().length + pending + (ms.pendingTasks?.length || 0);
}

function sidebar() {
  const unread = (R.ms?.teams.reduce((a, t) => a + t.unread, 0) || 0) + (R.ms?.elect?.unread || 0) + (R.ms?.squads?.reduce((a, s) => a + s.unread, 0) || 0);
  const pending = R.ms?.players.filter((p) => p.status === 'pending' && p.requestedRole !== 'elect').length || 0;
  // Candidature agli Eletti: contano solo prima del via (a partita iniziata non si aggiungono più Eletti).
  const pendingElect = PRE.includes(R.ms?.clock.status) ? R.ms?.players.filter((p) => p.status === 'pending' && p.requestedRole === 'elect').length || 0 : 0;
  const pendingTasks = R.ms?.pendingTasks?.length || 0;
  const errors = R.ms?.readiness.issues.filter((i) => i.level === 'error').length || 0;
  // Senza partite le sezioni della partita non hanno contenuto: le mostriamo spente.
  const noGame = !R.gameId;
  const always = ['settori', 'regolamento', 'consiglio', 'impostazioni'];
  return [h('div', { class: 'nav-backdrop', onclick: () => document.body.classList.remove('nav-open') }),
    h('nav', { class: 'sidebar', onclick: (e) => { if (e.target.closest('a')) document.body.classList.remove('nav-open'); } }, TABS.map(([id, label]) => (noGame && !always.includes(id)
    ? h('span', { class: 'off', title: 'Prima crea una partita' }, label)
    : h('a', { href: `#${id}`, class: tab() === id || (noGame && id === 'impostazioni' && !always.includes(tab())) ? 'on' : '' }, label,
    id === 'comunicazioni' && unread ? h('span', { class: 'badge badge-alert' }, unread) : null,
    id === 'consiglio' && R.ms?.councilPending ? h('span', { class: 'badge badge-alert', title: 'Richieste d\'accesso al Consiglio Zero' }, R.ms.councilPending) : null,
    id === 'emergenze' && openEmergencies().length ? h('span', { class: 'badge badge-alert' }, openEmergencies().length) : null,
    id === 'coppie' && pending ? h('span', { class: 'badge badge-alert', title: 'Iscrizioni da approvare' }, pending) : null,
    id === 'squadre' && pendingTasks ? h('span', { class: 'badge badge-alert badge-task', title: 'Incarichi da assegnare (Maestro della caccia…)' }, `🎯 ${pendingTasks}`) : null,
    id === 'squadre' && pendingElect ? h('span', { class: 'badge badge-alert', title: 'Candidature agli Eletti da approvare' }, pendingElect) : null,
    id === 'live' && errors && PRE.includes(R.ms?.clock.status) ? h('span', { class: 'badge' }, errors) : null,
    id === 'notifiche' && R.ms?.pushOff ? h('span', { class: 'badge', title: 'Coppie ed Eletti con qualcosa da sistemare (notifiche, Traccar, ICE, avviso di sicurezza)' }, R.ms.pushOff) : null))),
  // Pagine a parte (si aprono in una nuova scheda).
  h('div', { class: 'sidebar-ext' },
    R.gameId ? h('a', { href: `/tabellone?g=${R.gameId}`, target: '_blank', rel: 'noopener' }, 'Tabellone ↗') : h('span', { class: 'off' }, 'Tabellone ↗'),
    h('a', { href: '/soglia', target: '_blank', rel: 'noopener' }, 'Soglia ↗'),
    h('a', { href: '/campo', target: '_blank', rel: 'noopener', title: 'Strumento di campo: piazzare Altari e Doni dal telefono' }, 'Campo ↗'),
    R.gameId ? h('a', { href: `/armi?g=${R.gameId}`, target: '_blank', rel: 'noopener', title: 'Test armi col cronografo' }, 'Test armi ↗') : h('span', { class: 'off' }, 'Test armi ↗')))];
}
const installedApp = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

function tick() {
  tickTimeline();
  const recEl = document.getElementById('rec-time-regia');
  if (recEl && R.rec) recEl.textContent = fmtSec(Date.now() - R.rec.startedAt);
  const c = clock.snap;
  for (const el of document.querySelectorAll('[data-clock]')) {
    const k = el.dataset.clock;
    let t = '—';
    if (c) {
      if (k === 'remaining') t = c.startedAt ? fmtDuration(clock.remaining()) : fmtDuration(c.durationMs);
      else if (k === 'elapsed') t = fmtDuration(clock.elapsed());
      else if (k.startsWith('abs:')) t = fmtDuration(Math.max(0, Number(k.slice(4)) - clock.serverNow()));
      else if (k.startsWith('until:')) {
        const at = Number(k.slice(6));
        t = c.startedAt ? fmtDuration(Math.max(0, at - clock.elapsed())) : fmtMin(at / 60000);
      }
    }
    if (el.textContent !== t) el.textContent = t;
  }
  // «x min fa» che avanza da solo (ultimo ping di Traccar…).
  for (const el of document.querySelectorAll('[data-ago]')) {
    const t = agoText(Number(el.dataset.ago));
    if (el.textContent !== t) el.textContent = t;
  }
}

function agoText(at) {
  const s = Math.max(0, Math.round((clock.serverNow() - at) / 1000));
  if (s < 60) return `${s} s fa`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min fa`;
  const hh = Math.floor(m / 60);
  return hh < 24 ? `${hh} h ${m % 60} min fa` : `${Math.floor(hh / 24)} g fa`;
}

// ---------------------------------------------------------------- login

// Niente login proprio: tutto passa dal login principale (username e password o Zero Dark Ops).
function viewLogin() {
  location.replace(R.me?.role === 'validator' ? '/soglia' : '/');
  return h('main', { class: 'login-page' }, h('p', { class: 'muted' }, 'Accesso…'));
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
  if (st === 'created') b.push(act('prepare', 'Porta in preparazione', 'btn-primary', 'Portare in preparazione?', 'La partita diventa visibile alle app di campo (Campo, Soglia, Test armi, Consiglio) e si possono aprire le iscrizioni.'));
  if (st === 'draft') b.push(act('ready', 'Segna pronta', 'btn-primary', 'Partita pronta?', 'Le coppie potranno accedere e leggere il regolamento. Le iscrizioni si chiudono.'),
    act('created', 'Torna a «Creata»', '', 'Tornare a «Creata»?', 'La partita sparisce dalle app di campo e le iscrizioni si chiudono. Resta tutto in regia.'));
  if (st === 'ready') b.push(act('circle', 'Apri il cerchio', 'btn-primary', 'Aprire il cerchio?', 'Ogni coppia vedrà il proprio Sigillo.'), act('draft', 'Torna in preparazione', '', 'Tornare in preparazione?', 'La partita torna modificabile.'));
  if (st === 'circle') b.push(act('start', 'VIA!', 'btn-primary btn-go', 'Dare il VIA?', 'Parte l\'orologio di partita: tregua di ' + R.ms.game.truceMin + ' minuti, poi la caccia. Tutte le coppie ricevono l\'annuncio.'), act('draft', 'Torna in preparazione', '', 'Tornare in preparazione?', 'Le coppie non vedranno più il Sigillo fino al prossimo cerchio.'));
  if (ACTIVE.includes(st)) b.push(act('pause', 'Sospendi', 'btn-danger', 'Sospendere la partita?', 'Tutti gli orologi e il calendario si fermano. Banner rosso su tutti i dispositivi.', true), act('end', 'Termina', '', 'Terminare la partita?', 'Gli Altari si chiudono e si calcola la classifica finale.', true));
  if (st === 'paused') b.push(act('resume', 'Riprendi', 'btn-primary', 'Riprendere la partita?', 'Gli orologi ripartono da dove si erano fermati.'), act('end', 'Termina', '', 'Terminare la partita?', 'Gli Altari si chiudono e si calcola la classifica finale.', true));
  // Solo nell'ambiente di test: una partita finita si rigioca senza rifare il setup.
  if (st === 'ended' && R.ms?.env === 'test') b.push(act('restart', '↺ Riparti da capo (test)', 'btn-primary', 'Far ripartire la partita?',
    'La partita torna «pronta»: frammenti, Sigilli trovati, Altari visitati, scontri, alleanze, annunci, messaggi, validazioni e classifica vengono azzerati; tradimenti e armamenti tornano in calendario e i doni piazzati tornano non comparsi. Coppie, Settori, Sigilli, Altari, Parola e piazzamenti restano. Solo in ambiente di test.', true));
  return b;
}

// Timeline degli stati della gara: fatti (con l'ora), quello attuale, i prossimi (con l'ora prevista).
const PHASES = [
  ['created', 'Creata', 'status_created'], ['draft', 'In preparazione', 'status_draft'], ['ready', 'Pronta', 'status_ready'], ['circle', 'Cerchio', 'status_circle'],
  ['truce', 'Tregua', 'game_started'], ['hunt', 'Caccia', 'phase_hunt'], ['last_half_hour', 'Ultima mezz\'ora', 'phase_last_half_hour'], ['ended', 'Fine', 'game_ended'],
];
function phaseSteps() {
  const ms = R.ms;
  const c = ms.clock;
  const cur = c.status === 'paused' ? c.pausedFrom : c.status;
  const idx = PHASES.findIndex((p) => p[0] === cur);
  const log = ms.phaseLog || [];
  const lastAt = (type) => [...log].reverse().find((e) => e.type === type)?.at;
  // Minuti di gioco in cui partono le fasi dopo il via.
  const atMs = { truce: 0, hunt: c.huntAtMs, last_half_hour: c.lastPhaseAtMs, ended: c.durationMs };
  const pauses = log.filter((e) => e.type === 'game_paused').length;
  const when = (p, i) => {
    if (i <= idx) {
      // Ora del passaggio dal registro; per le fasi di gioco, se manca, dal tempo di gioco trascorso.
      let at = lastAt(p[2]) || (p[0] === 'truce' ? c.startedAt : null);
      if (!at && atMs[p[0]] != null && c.startedAt && clock.snap) at = clock.serverNow() - (clock.elapsed() - atMs[p[0]]);
      if (!at) return i === idx ? 'ora' : '';
      return i === idx ? `dalle ${fmtTime(at)}` : fmtTime(at);
    }
    if (atMs[p[0]] != null && c.startedAt) {
      const left = atMs[p[0]] - (clock.snap ? clock.elapsed() : 0);
      return `~${fmtTime(clock.serverNow() + left)}${c.status === 'paused' ? ' (in pausa)' : ''}`;
    }
    if (p[0] === 'truce' && ms.game.scheduledStart) return `prev. ${fmtTime(new Date(ms.game.scheduledStart).getTime())}`;
    if (atMs[p[0]] != null) return `+${Math.round(atMs[p[0]] / 60000)}′`;
    return '';
  };
  return h('ol', { class: 'phase-steps', 'aria-label': 'Stati della gara' }, PHASES.map((p, i) => h('li', { class: `${i < idx ? 'done' : i === idx ? 'now' : 'next'} ${i === idx && c.status === 'paused' ? 'paused' : ''}` },
    h('span', { class: 'ps-dot', 'aria-hidden': 'true' }, i < idx ? '✓' : i + 1),
    h('span', { class: 'ps-label' }, p[1]),
    h('span', { class: 'ps-time mono' }, i === idx && c.status === 'paused' ? 'SOSPESA' : when(p, i)),
    i === idx && pauses && c.status !== 'paused' ? h('span', { class: 'ps-time mono' }, `${pauses} ${pauses === 1 ? 'pausa' : 'pause'}`) : null)));
}

// Anti «furbetto del QR», a portata di mano in Regia: interruttore del controllo di distanza sulla lettura degli Altari.
// Il raggio si sceglie nelle impostazioni della partita; qui si accende o si spegne al volo.
function altarRadiusPanel() {
  const g = R.ms.game;
  const on = !!g.altarCheckOn;
  const radius = Number(g.altarRadiusM) > 0 ? Number(g.altarRadiusM) : 30;
  const ap = R.ms.altarsPlaced || {};
  const toggle = () => call('PATCH', `/api/m/games/${g.id}`, { altarCheckOn: !on }, on ? 'Controllo di distanza SPENTO: gli Altari si leggono da ovunque' : `Controllo di distanza ACCESO: lettura valida entro ${radius} m`);
  return h('div', { class: `panel radius-panel ${on ? 'on' : 'off'}` },
    h('div', null,
      h('div', { class: 'eyebrow' }, 'Controllo distanza sulla lettura degli Altari'),
      h('strong', null, on ? `Acceso · lettura valida entro ${radius} m dall'Altare` : 'Spento · gli Altari si leggono da ovunque'),
      h('div', { class: 'tiny muted' }, `${ap.placed || 0} Altari piazzati su ${ap.total || 0} (il controllo vale solo per quelli piazzati). Raggio: `, h('a', { href: '#impostazioni' }, `${radius} m, si cambia in Impostazioni`), '.')),
    h('button', { type: 'button', class: `switch ${on ? 'on' : ''}`, role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': 'Controllo distanza sulla lettura degli Altari', onclick: toggle },
      h('span', { class: 'switch-knob', 'aria-hidden': 'true' }), h('span', { class: 'switch-label' }, on ? 'ACCESO' : 'SPENTO')));
}

// Registro delle letture degli Altari rifiutate: l'ultima in vista, le altre in una scheda che si apre e si chiude.
// Ogni riga si apre su una mini mappa: Altare e coppia, la linea che li unisce e la distanza.
const rejOpen = new Set();
let rejOthersOpen = false;
const rejMaps = new Map();
const teamName = (r) => `${r.roman ? `${r.roman} · ` : ''}Settore ${r.sectorName || '?'}${r.displayName ? ` (${r.displayName})` : ''}`;
const fmtDay = (ts) => `${new Date(ts).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })} ${fmtTime(ts, true)}`;
function rejectionMap(r) {
  if (rejMaps.has(r.id)) { const el = rejMaps.get(r.id); requestAnimationFrame(() => el._map?.invalidateSize()); return el; }
  const el = h('div', { class: 'rej-map' });
  rejMaps.set(r.id, el);
  loadLeaflet().then((L) => {
    const a = [r.altarLat, r.altarLng];
    const t = [r.lat, r.lng];
    const map = L.map(el, { zoomControl: true, attributionControl: false, scrollWheelZoom: false });
    el._map = map;
    L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, subdomains: 'abc' }).addTo(map);
    L.circle(a, { radius: r.radiusM || 0, color: '#46c46a', weight: 1, fillOpacity: 0.08 }).addTo(map);
    L.polyline([a, t], { color: '#e5484d', weight: 3, dashArray: '6 6' }).addTo(map)
      .bindTooltip(`${r.distM} m`, { permanent: true, direction: 'center', className: 'rej-dist' });
    L.circleMarker(a, { radius: 8, color: '#fff', weight: 2, fillColor: '#d1ad62', fillOpacity: 1 }).addTo(map)
      .bindTooltip(r.altar, { permanent: true, direction: 'top', offset: [0, -8], className: 'rej-label' });
    if (r.acc) L.circle(t, { radius: r.acc, color: r.sectorColor || '#ff4fa3', weight: 1, fillOpacity: 0.1 }).addTo(map);
    L.circleMarker(t, { radius: 8, color: '#fff', weight: 2, fillColor: r.sectorColor || '#ff4fa3', fillOpacity: 1 }).addTo(map)
      .bindTooltip(teamName(r), { permanent: true, direction: 'top', offset: [0, -8], className: 'rej-label' });
    const fit = () => { map.invalidateSize(); map.fitBounds(L.latLngBounds([a, t]), { padding: [40, 40], maxZoom: 17 }); };
    fit();
    setTimeout(fit, 80);
    setTimeout(fit, 400);
  }).catch(() => { el.textContent = 'Mappa non disponibile'; });
  return el;
}
function rejectionRow(r) {
  const far = r.reason === 'too_far';
  const where = far ? `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}${r.acc ? ` (GPS ±${Math.round(r.acc)} m)` : ''}` : 'posizione non disponibile (GPS spento o negato)';
  const mapBox = h('div', { class: 'rej-map-box' }, far && r.altarLat != null && rejOpen.has(r.id) ? rejectionMap(r) : null);
  const toggle = (e) => {
    if (!e.target.open) { rejOpen.delete(r.id); return; }
    rejOpen.add(r.id);
    if (far && r.altarLat != null && !mapBox.firstChild) mapBox.append(rejectionMap(r));
  };
  return h('details', { class: 'rej-row', open: rejOpen.has(r.id), ontoggle: toggle },
    h('summary', null,
      h('span', { class: 'rej-dot', style: { background: r.sectorColor || 'var(--blood)' }, 'aria-hidden': 'true' }),
      h('span', { class: 'rej-main' }, h('strong', null, teamName(r)), h('span', { class: 'tiny muted' }, ` · ${fmtDay(r.at)}`),
        h('div', { class: 'small' }, `${r.altar} · `, far ? h('strong', { class: 'bad-text' }, `${r.distM} m`) : h('strong', { class: 'bad-text' }, 'senza GPS'), far ? ` (raggio ${r.radiusM} m)` : '')),
      h('span', { class: 'rej-chev', 'aria-hidden': 'true' }, '▾')),
    h('div', { class: 'rej-body' },
      h('div', { class: 'rej-facts small' },
        h('div', null, h('span', { class: 'muted' }, 'Coppia: '), teamName(r)),
        h('div', null, h('span', { class: 'muted' }, 'Quando: '), fmtDay(r.at)),
        h('div', null, h('span', { class: 'muted' }, 'Altare letto: '), r.altar),
        h('div', null, h('span', { class: 'muted' }, 'Posizione della coppia: '), far ? h('a', { href: `https://www.google.com/maps?q=${r.lat},${r.lng}`, target: '_blank', rel: 'noopener' }, where) : where),
        far ? h('div', null, h('span', { class: 'muted' }, 'Distanza dall\'Altare: '), h('strong', null, `${r.distM} m`), ` · raggio ${r.radiusM} m`) : null),
      mapBox));
}
function altarRejectionsPanel() {
  const list = R.ms.altarRejections || [];
  if (!list.length && !R.ms.game.altarCheckOn) return null;
  const [last, ...others] = list;
  return h('div', { class: 'panel rej-panel' },
    h('div', { class: 'panel-head' }, h('h2', null, `Letture rifiutate${list.length ? ` · ${list.length}` : ''}`)),
    !last ? h('p', { class: 'empty' }, 'Nessuna lettura rifiutata.') : [
      h('div', { class: 'eyebrow' }, 'Ultima'), rejectionRow(last),
      others.length ? h('details', { class: 'rej-others', open: rejOthersOpen, ontoggle: (e) => { rejOthersOpen = e.target.open; } },
        h('summary', null, `Le altre ${others.length}`), h('div', { class: 'rej-list' }, others.map(rejectionRow))) : null]);
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
      h('div', { class: 'control-actions' }, controlButtons()),
      phaseSteps()),

    ms.game.isDemo || ms.canWarp ? demoPanel() : null,

    PRE.includes(st) ? readinessPanel() : null,

    liveTimeline(),

    altarRadiusPanel(),
    altarRejectionsPanel(),

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
      nextCard('Prossimi armamenti', n.supply
        ? [h('div', { class: 'mono big', 'data-clock': `until:${n.supply.atMs}` }, '—'), h('div', { class: 'muted tiny' }, `a ${fmtMin(n.supply.atMs / 60000)} · ${n.supply.description || ''}`),
          ACTIVE.includes(st) ? h('button', { class: 'btn btn-sm', onclick: () => confirmCall('Lanciare i doni adesso?', 'Parte l\'annuncio a tutte le coppie.', 'POST', `/api/m/supply/${n.supply.id}/fire`, {}, 'Doni lanciati') }, 'Lancia ora') : null]
        : [h('p', { class: 'empty' }, 'Nessuna finestra a orario.'), h('a', { class: 'btn btn-sm', href: '#doni' }, 'Gestisci armamenti')]),
      nextCard('Tappe', [
        h('div', { class: 'milestone' }, h('span', null, 'Apertura caccia'), h('span', { class: 'mono', 'data-clock': `until:${n.huntAtMs}` }, '—')),
        h('div', { class: 'milestone' }, h('span', null, 'Ultima mezz\'ora'), h('span', { class: 'mono', 'data-clock': `until:${n.lastPhaseAtMs}` }, '—')),
        h('div', { class: 'milestone' }, h('span', null, 'Fine'), h('span', { class: 'mono', 'data-clock': `until:${n.endAtMs}` }, '—'))])),

    sectionActions('Coppie in gioco', [h('a', { class: 'btn btn-sm', href: '#coppie' }, 'Gestisci')],
      ms.teams.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Settore', 'Legati', 'Frammenti', 'Codici', 'Ultimo sblocco', 'Stato', 'Online', ''].map((x) => h('th', null, x)))),
        h('tbody', null, ms.teams.map((t) => h('tr', { class: t.status !== 'active' ? `row-${t.status}` : '' },
          h('td', null, h('strong', null, `${t.roman || ''} ${t.sectorName || '—'}`), t.displayName ? h('div', { class: 'tiny muted' }, t.displayName) : null),
          h('td', { class: 'tiny' }, t.members.map((m) => m.nickname || m.name).join(' · ')),
          h('td', null, h('div', { class: 'mono' }, `${t.fragments}/${t.fragmentsTotal}`), bar(t.fragments, t.fragmentsTotal)),
          h('td', null, t.codes == null ? '—' : [h('div', { class: 'mono' }, `${t.codes}/${t.codesTotal}`), bar(t.codes, t.codesTotal)]),
          h('td', { class: 'tiny' }, t.lastUnlock ? `${t.lastUnlock.label} · ${fmtTime(t.lastUnlock.acquiredAt)}` : '—'),
          h('td', null, t.status === 'won' ? h('span', { class: 'chip chip-ok' }, `${t.finishPosition}° posto`) : t.status === 'withdrawn' ? h('span', { class: 'chip' }, 'ritirata') : h('span', { class: 'chip chip-brass' }, 'in gioco')),
          h('td', null, h('span', { class: `dot ${t.online ? 'dot-ok' : ''}` }), ' ', t.online || ''),
          h('td', { class: 'row-actions' },
            h('button', { class: 'btn btn-sm', onclick: () => { R.chat = { kind: 'team', id: t.id }; R.chatOpen = true; location.hash = 'comunicazioni'; } }, t.unread ? `Messaggi (${t.unread})` : 'Messaggio'),
            h('button', { class: 'btn btn-sm btn-ghost', onclick: () => fragmentsDialog(t) }, 'Frammenti'))))))) : h('p', { class: 'empty' }, 'Nessuna coppia formata.')),

    combatPanel(),

    h('div', { class: 'cols-2' },
      sectionActions('Sigilli', [h('button', { class: 'btn btn-sm btn-ghost', onclick: toggleShowAll }, R.showAll ? 'Nascondi' : 'Mostra tutti')], codesGrid(fresh)),
      section('Annuncio libero', quickAnnounce(), h('h3', { class: 'sub' }, 'Feed eventi'), eventFeed(25))));
}

function demoPanel() {
  const st = R.ms.clock.status;
  const active = ACTIVE.includes(st);
  const adv = (m) => h('button', { class: `btn btn-sm ${m < 0 ? 'btn-ghost' : ''}`, disabled: !active, onclick: () => call('POST', G('/advance'), { minutes: m }, m > 0 ? `Tempo avanzato di ${m} minuti` : `Tempo riportato indietro di ${-m} minuti`) }, `${m > 0 ? '+' : '−'}${Math.abs(m)} min`);
  return h('div', { class: 'panel demo' },
    h('div', { class: 'panel-head' }, h('h2', null, R.ms.game.isDemo ? 'Partita di prova' : 'Tempo di gioco'), h('span', { class: 'chip chip-brass' }, 'solo test')),
    h('p', { class: 'muted tiny' }, active
      ? "Fai passare il tempo di gioco per vedere subito tregua → caccia, tradimenti, doni, ultima mezz'ora e fine. Le coppie ricevono tutto come in una partita vera."
      : "I pulsanti si attivano dopo il VIA (non in pausa). Per entrare come coppia usa \"Apri app\" nella scheda Iscrizioni e coppie, oppure il codice d'accesso da un altro telefono o da una finestra in incognito."),
    h('div', { class: 'row-actions' }, adv(-60), adv(-30), adv(-15), adv(-5), adv(-1), h('span', { class: 'demo-sep', 'aria-hidden': 'true' }, '·'), adv(1), adv(5), adv(15), adv(30), adv(60)),
    active ? h('p', { class: 'tiny muted' }, 'Tornando indietro ciò che è già successo (tradimenti, armamenti aperti, scontri) resta com\'è; la fase torna a quella del momento.') : null);
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

// Alleanze in corso, scontri da decidere (contestati o in attesa) ed esiti recenti.
function combatPanel() {
  const c = R.ms.combat;
  if (!c) return null;
  const tn = (t) => (t ? `${t.roman} ${t.sectorName}` : '?');
  const outcome = (e) => (e.result === 'draw' ? `Pareggio: ${[...e.winners, ...e.losers].map(tn).join(' · ')}` : `${e.winners.map(tn).join(' + ')} vince su ${e.losers.map(tn).join(' + ')}`);
  return h('div', { class: 'cols-2' },
    sectionActions(`Alleanze (${c.alliances.length})`, [h('a', { class: 'btn btn-sm', href: '#mappa', onclick: () => { R.mapAllies = true; } }, 'In mappa')],
      alliancesList(),
      c.requests.length ? [h('h3', { class: 'sub' }, 'Proposte in attesa'), h('ul', { class: 'field-list' }, c.requests.map((r) => h('li', null, h('span', { class: 'grow' }, `${tn(r.from)} → ${tn(r.to)}`), h('span', { class: 'chip' }, r.kind === 'break' ? 'rottura' : 'alleanza'))))] : null),
    section('Scontri',
      c.open.length ? h('ul', { class: 'field-list' }, c.open.map((e) => h('li', { class: e.status === 'contested' ? 'contested' : '' },
        h('div', { class: 'grow' }, h('strong', null, outcome(e)), h('div', { class: 'tiny muted' }, `${fmtTime(e.createdAt)} · dichiarato da ${tn(e.reporter)} · ${e.status === 'contested' ? 'CONTESTATO' : 'in attesa di conferma'}`)),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn btn-sm btn-primary', onclick: () => confirmCall('Confermare l\'esito?', `${outcome(e)}. I vincitori ricevono i Sigilli degli sconfitti, gli sconfitti fanno la Veglia.`, 'POST', `/api/m/engagements/${e.id}/resolve`, { decision: 'confirm' }, 'Esito confermato') }, 'Conferma'),
          h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Annullare lo scontro?', 'Nessun Sigillo passa di mano.', 'POST', `/api/m/engagements/${e.id}/resolve`, { decision: 'cancel' }, 'Scontro annullato', true) }, 'Annulla'))))) : h('p', { class: 'empty' }, 'Nessuno scontro da decidere.'),
      c.recent.length ? [h('h3', { class: 'sub' }, 'Ultimi esiti'), h('ul', { class: 'feed' }, c.recent.map((e) => h('li', { class: 'ev' }, h('span', { class: 'mono tiny muted' }, fmtTime(e.resolvedAt || e.createdAt)), h('span', { class: 'ev-type' }, e.status === 'cancelled' ? 'Annullato' : e.result === 'draw' ? 'Pareggio' : 'Scontro'), h('span', { class: 'ev-text' }, outcome(e)))))] : null));
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
    c.free ? h('div', { class: 'tiny' }, h('span', { class: 'chip chip-warn' }, 'Altare senza coppia')) : null,
    h('div', { class: 'tiny' }, c.state === 'revealed' ? h('span', { class: 'chip chip-blood' }, `rivelato ${fmtTime(c.revelation?.firedAt)}`)
      : c.state === 'never' ? h('span', { class: 'chip chip-brass' }, 'mai rivelato')
        : c.revelation?.status === 'skipped' ? h('span', { class: 'chip' }, 'saltato')
          : h('span', { class: 'chip' }, `in calendario ${fmtMin(c.revelation?.scheduledMin)}`)))));
}

// Svuota il campo prima di inviare (la pagina si ridisegna durante l'invio); se l'invio fallisce il testo torna al suo posto.
async function sendClearing(field, send) {
  const text = field.value;
  const key = field.dataset.keep;
  field.value = '';
  const ok = await send(text);
  if (!ok) { const el = key ? $root.querySelector(`[data-keep="${CSS.escape(key)}"]`) : field; if (el) el.value = text; }
  return ok;
}

function quickAnnounce() {
  const ta = h('textarea', { class: 'input', rows: 2, 'data-keep': 'quick-ann', placeholder: 'Testo a tutte le coppie…', maxlength: 500 });
  return h('form', { class: 'stack-sm', onsubmit: async (e) => {
    e.preventDefault();
    if (!ta.value.trim()) return;
    if (!(await dialog({ title: 'Inviare l\'annuncio?', text: ta.value, okLabel: 'Invia a tutti' }))) return;
    await sendClearing(ta, (text) => call('POST', G('/announce'), { text }, 'Annuncio inviato'));
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
  free_announcement: 'Annuncio libero', squad_created: 'Squadra creata', squad_updated: 'Squadra modificata', squad_deleted: 'Squadra eliminata',
  squad_member: 'Squadra', squad_assigned: 'Incarico di piazzamento', squad_move: 'Spostamento richiesto', squad_unassigned: 'Incarico annullato',
  point_moved: 'Altare spostato', checkin_player: 'Presente all\'accettazione', checkin_player_undo: 'Presenza annullata', checkin_team: 'Coppia confermata', checkin_team_undo: 'Conferma coppia annullata', chrono_ok: 'Arma sotto 1 joule', chrono_undo: 'Prova arma annullata', chrono_fail: 'Arma sopra 1 joule: non passa', chrono_closed: 'Test armi: persona chiusa', chrono_reopened: 'Test armi: persona riaperta', catalog_edited: 'Skill o Dono modificato', gift_scheduled: 'Annuncio dono programmato', gift_schedule_cancelled: 'Annuncio dono annullato',
  supply_closed: 'Armamenti chiusi', supply_shifted: 'Armamenti spostati', squad_task: 'Incarico', squad_task_done: 'Incarico fatto', squad_task_reopened: 'Incarico riaperto', squad_task_deleted: 'Incarico eliminato', demo_created: 'Partita di prova', demo_advance: 'Tempo avanzato',
  registration_accepted: 'Iscrizione accettata', registration_rejected: 'Iscrizione rifiutata', elect_added: 'Eletti', elect_removed: 'Tolto dagli Eletti',
  notice: 'Avviso', notice_deleted: 'Avviso eliminato',
  alliance_proposed: 'Proposta di alleanza', alliance_formed: 'Alleanza stretta', alliance_rejected: 'Alleanza rifiutata', alliance_break_proposed: 'Proposta di rottura',
  alliance_broken: 'Alleanza rotta', alliance_break_rejected: 'Rottura rifiutata', engagement_reported: 'Scontro dichiarato', engagement_confirmed: 'Scontro registrato',
  engagement_contested: 'Scontro contestato', engagement_cancelled: 'Scontro annullato', unlock_scan_expired: 'Scansione scaduta',
  point_placed: 'Altare piazzato', gift_placed: 'Dono piazzato', gift_revealed: 'Dono comparso', gift_claimed: 'Dono preso', gift_used: 'Dono usato', gift_expired: 'Dono svanito',
  gifts_created: 'Doni creati', gift_deleted: 'Dono eliminato', gift_reset: 'Dono da ripiazzare',
  squad_task_assigned: 'Incarico assegnato', squad_task_cancelled: 'Incarico annullato', dirty_alliance: 'Alleanza sporca', alliance_poisoned: 'Velenoso',
  skill_chosen: 'Skill scelta', skill_removed: 'Skill tolta', skill_used: 'Skill usata', skill_auto: 'Skill automatica',
  exfiltration: 'Esfiltrazione', exit_denied: 'Uscita negata', alliance_broken_distance: 'Alleanza rotta per distanza',
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
    case 'skill_chosen': case 'skill_removed': case 'skill_auto': return `${who}: ${d.skill}`;
    case 'skill_used': return `${who}: ${d.skill}${d.target ? ` su ${d.target}` : ''}`;
    case 'exfiltration': return `${d.settore} esce dalla Soglia (${d.position}°)`;
    case 'exit_denied': return `${d.settore}: ${d.reason === 'alleanza' ? `ancora alleato con ${(d.allies || []).join(', ')}` : `mancano ${d.missing} frammenti`}`;
    case 'alliance_broken_distance': return `${d.settore} a ${d.metri} m dagli alleati (${(d.teams || []).join(', ')})`;
    case 'demo_advance': return `+${d.minutes}′`;
    case 'registration_accepted': case 'registration_rejected': return (d.names || []).join(' e ');
    case 'elect_added': return `${d.count} ${d.count === 1 ? 'persona' : 'persone'}`;
    case 'elect_removed': return d.name;
    case 'notice': return `${d.title} → ${R.ms.noticeTargets[d.target] || d.target}`;
    case 'notice_deleted': return d.title;
    case 'alliance_proposed': case 'alliance_break_proposed': case 'alliance_rejected': case 'alliance_break_rejected': return `${d.from} → ${d.to}`;
    case 'alliance_formed': case 'alliance_broken': return (d.teams || []).join(' + ');
    case 'engagement_reported': return `${d.reporter} dichiara ${({ won: 'vittoria', lost: 'sconfitta', draw: 'pareggio' })[d.result]} contro ${d.opponent}`;
    case 'engagement_confirmed': return d.result === 'draw' ? `Pareggio: ${[...(d.winners || []), ...(d.losers || [])].join(', ')}` : `${(d.winners || []).join(' + ')} su ${(d.losers || []).join(' + ')}`;
    case 'engagement_contested': return `${d.by} contesta ${d.reporter}`;
    case 'unlock_scan_expired': return `${who} a ${d.point}`;
    case 'point_placed': return `${d.label}${d.accuracy ? ` · ±${d.accuracy} m` : ''}${d.source === 'manual' ? ' · punto manuale' : ''}`;
    case 'gift_placed': case 'gift_revealed': case 'gift_expired': case 'gift_deleted': case 'gift_reset': return `${d.label}${d.type ? ` · ${d.type}` : ''}`;
    case 'gift_claimed': case 'gift_used': return `${who}: ${d.label} · ${d.type}${d.target ? ` su ${d.target}` : ''}`;
    case 'gifts_created': return `${d.count} × ${d.type}`;
    case 'squad_created': case 'squad_updated': case 'squad_deleted': return d.name;
    case 'squad_member': return `${d.name} → ${d.squad || 'nessuna squadra'}`;
    case 'squad_assigned': return `${d.item} → ${d.squad || 'nessuna squadra'}`;
    case 'squad_task': return `${d.squad}: ${d.text}`;
    case 'squad_task_done': case 'squad_task_reopened': case 'squad_task_deleted': return d.text;
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

// Spostamenti Eletti <-> Settori: da soli o in scambio con una persona dell'altra parte.
const shortName = (p) => p.nickname || p.name;
async function moveToCoupleDialog(m) {
  const couples = R.ms.teams.filter((t) => t.kind !== 'elect' && t.status !== 'withdrawn');
  if (!couples.length) return toast('Non ci sono ancora coppie', 'error');
  const opts = couples.flatMap((t) => (t.members.length < 2
    ? [{ teamId: t.id, label: `${teamLabel(t)} — entra nella coppia${t.members[0] ? ` con ${shortName(t.members[0])}` : ''}` }]
    : t.members.map((x) => ({ teamId: t.id, swapWithId: x.id, label: `${teamLabel(t)} — al posto di ${shortName(x)} (che diventa Eletto)` }))));
  const radios = opts.map((o, i) => h('input', { type: 'radio', name: 'mv', value: i, checked: i === 0 }));
  const pick = await modal({
    title: `${shortName(m)}: dagli Eletti a un Settore`, okLabel: 'Sposta',
    body: h('div', { class: 'stack-sm move-list' },
      h('p', { class: 'muted tiny' }, 'Chi esce da una coppia completa diventa Eletto nella stessa squadra. L\'accesso personale segue la persona: al prossimo aggiornamento il telefono passa alla nuova app.'),
      opts.map((o, i) => h('label', { class: 'radio-line' }, radios[i], h('span', null, o.label)))),
    onOk: () => opts[radios.findIndex((r) => r.checked)],
  });
  if (pick) call('POST', `/api/m/players/${m.id}/move`, { toTeamId: pick.teamId, swapWithId: pick.swapWithId }, pick.swapWithId ? 'Scambio fatto' : 'Spostato nella coppia');
}
async function moveToElectDialog(m, t) {
  const elect = R.ms.elect;
  const opts = [{ label: `Solo ${shortName(m)} tra gli Eletti (la coppia resta con ${t.members.length - 1} giocatore)` },
    ...elect.members.map((x) => { const sq = (R.ms.squads || []).find((y) => y.id === x.squadId); return { swapWithId: x.id, label: `Scambio con ${shortName(x)}${sq ? ` (squadra ${sq.name})` : ''}, che entra nella coppia` }; })];
  const radios = opts.map((o, i) => h('input', { type: 'radio', name: 'mv', value: i, checked: i === 0 }));
  const pick = await modal({
    title: `${shortName(m)}: dal Settore ${t.sectorName} agli Eletti`, okLabel: 'Sposta',
    body: h('div', { class: 'stack-sm move-list' },
      h('p', { class: 'muted tiny' }, 'In uno scambio chi diventa Eletto prende la squadra di chi entra nella coppia.'),
      opts.map((o, i) => h('label', { class: 'radio-line' }, radios[i], h('span', null, o.label)))),
    onOk: () => opts[radios.findIndex((r) => r.checked)],
  });
  if (pick) call('POST', `/api/m/players/${m.id}/move`, { toTeamId: elect.id, swapWithId: pick.swapWithId }, pick.swapWithId ? 'Scambio fatto' : 'Spostato tra gli Eletti');
}

function personLine(p) {
  const acc = p.username || R.ms?.players.find((x) => x.id === p.id)?.username;
  return [h('strong', null, p.name), p.nickname ? h('span', { class: 'muted' }, ` «${p.nickname}»`) : null, acc ? h('span', { class: 'tiny brass' }, ` @${acc}`) : null];
}

// Il giocatore ha dimenticato la password: la regia ne imposta una nuova e gliela comunica.
async function resetPassword(p) {
  const pl = R.ms.players.find((x) => x.id === p.id) || p;
  if (!pl.accountId) return;
  const pwd = await dialog({ title: `Nuova password per @${pl.username}`, text: `${pl.name}: scrivi la nuova password (almeno 8 caratteri) e comunicagliela.`, okLabel: 'Imposta', input: { placeholder: 'nuova password' } });
  if (!pwd) return;
  await call('POST', `/api/m/accounts/${pl.accountId}/password`, { password: pwd }, 'Password reimpostata');
}
const resetBtn = (p) => ((R.ms.players.find((x) => x.id === p.id) || p).accountId ? h('button', { class: 'btn btn-sm btn-ghost', title: "Reimposta la password dell'account", onclick: () => resetPassword(p) }, 'Password') : null);

function viewTeams() {
  const ms = R.ms;
  const st = ms.clock.status;
  const editable = ['created', 'draft', 'ready'].includes(st);
  const pending = ms.players.filter((p) => p.status === 'pending' && p.requestedRole !== 'elect');
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
  const sTeam = h('input', { class: 'input', 'data-keep': 'pl-team', placeholder: 'Team di softair' });
  const sectorSel = h('select', { class: 'input', 'data-keep': 'pair-sector' }, freeSectors.map((s) => h('option', { value: s.id }, `${s.roman} · ${s.name}`)));
  const teamName = h('input', { class: 'input', 'data-keep': 'pair-name', placeholder: 'Nome della coppia (facoltativo)' });

  return h('div', { class: 'stack' },
    pendingGroups.length ? h('div', { class: 'panel pending-panel' },
      h('div', { class: 'panel-head' }, h('h2', null, `Iscrizioni da approvare (${pending.length})`)),
      h('p', { class: 'muted tiny' }, 'Arrivate dal modulo online. Accetta chi vuoi far giocare: solo dopo potrai accoppiarli. Le candidature agli Eletti si gestiscono in Squadre Eletti. Rifiutando, l\'iscrizione viene cancellata.'),
      h('div', { class: 'players' }, pendingGroups.map((grp) => h('div', { class: `player ${grp.length === 2 ? 'grouped' : ''}` },
        h('div', { class: 'player-main' },
          grp.map((p) => h('div', null, personLine(p), p.softairTeam ? h('span', { class: 'tiny brass' }, ` · ${p.softairTeam}`) : null, p.phone ? [' · ', phoneLinks(p.phone)] : null)),
          h('div', null, h('span', { class: `chip ${grp[0].requestedRole === 'elect' ? 'chip-blood' : grp[0].requestedRole === 'single' ? 'chip-brass' : 'chip-ok'}` }, ROLE_LABELS[grp[0].requestedRole] || (grp.length === 2 ? 'Coppia' : 'Singolo'))),
          grp[0].note ? h('div', { class: 'tiny' }, `«${grp[0].note}»`) : null,
          grp[0].requestedRole === 'pair' && grp.length < 2 ? h('div', { class: 'tiny bad' }, `In attesa del compagno (codice coppia ${grp[0].regGroup})`) : null,
          h('div', { class: 'tiny muted' }, [grp[0].requestedTeamName ? `coppia «${grp[0].requestedTeamName}»` : null, fmtTime(grp[0].createdAt)].filter(Boolean).join(' · '))),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn btn-sm btn-primary', onclick: () => call('POST', `/api/m/players/${grp[0].id}/review`, { decision: 'accept' }, grp[0].requestedRole === 'elect' ? `${grp[0].name} è tra gli Eletti` : 'Iscrizione accettata') },
            grp.length === 2 ? 'Accetta entrambi' : grp[0].requestedRole === 'elect' ? 'Accetta tra gli Eletti' : 'Accetta'),
          h('button', { class: 'btn btn-sm btn-danger', onclick: () => confirmCall('Rifiutare l\'iscrizione?', `${grp.map((p) => p.name).join(' e ')}: l'iscrizione verrà cancellata.`, 'POST', `/api/m/players/${grp[0].id}/review`, { decision: 'reject' }, 'Iscrizione rifiutata', true) }, 'Rifiuta')))))) : null,

    h('div', { class: 'cols-2' },
      section('Iscrizioni',
        h('div', { class: 'toggle-row' },
          h('div', null, h('strong', null, ms.game.registrationOpen ? 'Iscrizioni aperte' : 'Iscrizioni chiuse'), h('div', { class: 'tiny muted' }, 'I giocatori creano il loro account (username e password) e si candidano online; tu li approvi e assegni il Settore. Chi ha dimenticato la password: pulsante "Password" accanto al nome.')),
          h('button', { class: `btn btn-sm ${ms.game.registrationOpen ? '' : 'btn-primary'}`, disabled: st !== 'draft', onclick: () => call('PATCH', `/api/m/games/${R.gameId}`, { registrationOpen: !ms.game.registrationOpen }) }, ms.game.registrationOpen ? 'Chiudi' : 'Apri')),
        ms.spots ? h('div', { class: 'tiny' }, h('strong', null, 'Posti liberi: '),
          `${ms.spots.couples} ${ms.spots.couples === 1 ? 'Settore' : 'Settori'} per le coppie · ${ms.spots.singles} ${ms.spots.singles === 1 ? 'posto' : 'posti'} per i temerari`,
          h('span', { class: 'muted' }, ` · ${ms.spots.capacity} Settori aperti = ${ms.spots.places} posti; iscritti ${ms.spots.taken.pairs} ${ms.spots.taken.pairs === 1 ? 'coppia' : 'coppie'} e ${ms.spots.taken.singles} ${ms.spots.taken.singles === 1 ? 'temerario' : 'temerari'}${ms.spots.taken.others ? ` (+${ms.spots.taken.others} aggiunti a mano)` : ''}`),
          ms.spots.maxSingles != null ? ` · temerari al massimo ${ms.spots.maxSingles}` : '') : null,
        // Quante coppie (e quanti temerari) accettare: vuoto = una coppia per Settore, temerari senza tetto a parte.
        ms.spots ? h('form', { class: 'form-grid seats-form', onsubmit: (e) => {
          e.preventDefault();
          const fd = Object.fromEntries(new FormData(e.target).entries());
          call('PATCH', `/api/m/games/${R.gameId}`, { maxCouples: fd.maxCouples, maxSingles: fd.maxSingles }, 'Posti aggiornati');
        } },
          h('label', { class: 'field' }, h('span', null, 'Settori da aprire'), h('input', { class: 'input', type: 'number', min: 0, name: 'maxCouples', 'data-keep': 'seat-c', value: ms.game.maxCouples ?? '', placeholder: `${(R.ms.sectors || []).filter((x) => !x.archived).length} (tutti i Settori)` })),
          h('label', { class: 'field' }, h('span', null, 'Temerari solitari al massimo (persone)'), h('input', { class: 'input', type: 'number', min: 0, name: 'maxSingles', 'data-keep': 'seat-s', value: ms.game.maxSingles ?? '', placeholder: 'senza limite a parte' })),
          h('button', { class: 'btn btn-primary', type: 'submit' }, 'Salva posti')) : null,
        ms.game.registrationOpen ? h('div', { class: 'reg-link' }, h('img', { src: `/api/m/qr.svg?text=${encodeURIComponent(regUrl)}`, alt: 'QR iscrizione', width: 96, height: 96 }), h('div', null, h('div', { class: 'mono' }, regUrl), h('a', { href: regUrl, target: '_blank', class: 'tiny' }, 'Apri il modulo'))) : null,
        h('h3', { class: 'sub' }, 'Aggiungi giocatore a mano (già accettato)'),
        h('form', { class: 'form-grid', onsubmit: async (e) => {
          e.preventDefault();
          if (!name.value.trim()) return;
          if (await call('POST', G('/players'), { name: name.value, nickname: nick.value, phone: phone.value, softairTeam: sTeam.value }, 'Giocatore aggiunto')) { [name, nick, phone, sTeam].forEach((x) => { x.value = ''; }); }
        } }, name, nick, sTeam, phone, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Aggiungi'))),

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
            p.phone ? phoneLinks(p.phone) : null,
            h('div', { class: 'tiny muted' }, [p.softairTeam, p.requestedRole === 'single' ? 'temerario solitario: da accoppiare a caso' : p.selfRegistered ? 'iscritto online' : 'aggiunto dalla regia', p.requestedTeamName ? `coppia «${p.requestedTeamName}»` : null].filter(Boolean).join(' · ')),
            grp?.length === 2 ? h('div', { class: 'tiny brass' }, `Iscritto con ${grp.find((x) => x.id !== p.id).name}`) : null),
          h('div', { class: 'row-actions' },
            grp?.length === 2 && editable && grp[0].id === p.id ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => call('POST', G('/teams'), { playerIds: grp.map((x) => x.id) }, 'Coppia formata') }, 'Accoppia come richiesto') : null,
            resetBtn(p),
            h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Eliminare il giocatore?', p.name, 'DELETE', `/api/m/players/${p.id}`, undefined, 'Eliminato', true) }, 'Elimina')));
      })) : h('p', { class: 'empty' }, pending.length ? 'Nessun giocatore accettato libero: approva le iscrizioni qui sopra.' : 'Tutti i giocatori accettati sono in coppia o tra gli Eletti.')),


    sectionActions(`Coppie (${ms.teams.length}/${ms.sectors.filter((x) => !x.archived).length})`, [h('a', { class: 'btn btn-sm', href: `/regia/stampa/credenziali/${R.gameId}`, target: '_blank' }, 'Stampa credenziali')],
      ms.teams.length ? h('div', { class: 'teams' }, ms.teams.map((t) => teamCard(t, editable))) : h('p', { class: 'empty' }, 'Nessuna coppia.')));
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
    h('div', { class: 'team-members' }, t.members.map((m) => h('div', null, personLine(m), m.softairTeam ? h('span', { class: 'tiny muted' }, ` · ${m.softairTeam}`) : null, m.phone ? [' · ', phoneLinks(m.phone)] : null, resetBtn(m),
      R.ms.game.status !== 'ended' ? h('button', { class: 'btn btn-sm btn-ghost', title: 'Sposta tra gli Eletti, da solo o in scambio', onclick: () => moveToElectDialog(m, t) }, '→ Eletti…') : null))),
    teamSkills(t),
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

// Skill della coppia (scelte prima del via o vinte con i Doni) ed effetti in corso.
function teamSkills(t) {
  const sk = R.ms.skills;
  const list = sk?.byTeam?.[t.id] || [];
  const effects = (sk?.effects || []).filter((e) => e.teamId === t.id || e.targetTeamId === t.id);
  if (!list.length && !effects.length) return h('div', { class: 'tiny muted' }, 'Nessuna Skill scelta');
  return h('div', { class: 'stack-sm' },
    h('div', { class: 'row-actions' }, list.map((x) => h('span', { class: `chip ${x.kind === 'passive' ? 'chip-ok' : x.kind === 'ultimate' ? 'chip-brass' : ''}`, title: x.source === 'gift' ? 'Vinta con un dono' : 'Scelta prima del via' },
      `${x.icon} ${x.name}${x.source === 'gift' ? ' ✦' : ''}`, x.readyAt ? h('span', { class: 'mono' }, ` · ${fmtTime(x.readyAt)}`) : null))),
    effects.map((e) => h('div', { class: 'tiny' }, e.teamId === t.id ? `▶ ${e.name}${e.targetName ? ` su ${e.targetName}` : ''}` : `◀ ${e.name} di ${e.teamName}`, e.until ? ` fino alle ${fmtTime(e.until)}` : '')));
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
    color: h('input', { class: 'gt-color', type: 'color', value: s?.color || '#e5484d', 'data-keep': k('color'), title: 'Colore del Settore in mappa', 'aria-label': 'Colore' }),
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
        h('thead', null, h('tr', null, ['#', 'Colore', 'Settore', 'Articolo', 'Elemento', 'Motto', 'Nome dell\'Altare', 'Uso', ''].map((x) => h('th', null, x)))),
        h('tbody', null, active.map((s) => {
          const f = sectorFields(s, `s${s.id}`);
          const u = s.usage || {};
          return h('tr', null,
            h('td', { class: 'w-70' }, h('div', { class: 'mono roman' }, s.roman), f.ord),
            h('td', null, f.color),
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
      h('label', { class: 'field' }, h('span', null, 'Colore'), add.color),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Aggiungi'))),
    archived.length ? section('Archiviati',
      h('p', { class: 'muted tiny' }, 'Settori usati in partite passate e poi eliminati: non compaiono nelle scelte.'),
      h('ul', { class: 'users' }, archived.map((s) => h('li', null, h('span', { class: 'mono' }, s.roman), h('strong', null, s.name), h('span', { class: 'tiny muted' }, s.altar),
        h('button', { class: 'btn btn-sm', onclick: () => sectorCall('POST', `/api/m/sectors/${s.id}/restore`, {}, `${s.name} ripristinato`) }, 'Ripristina'))))) : null);
}

// ---------------------------------------------------------------- ALTARI E PAROLA

const squadById = (id) => R.ms.squads.find((s) => s.id === id) || null;

// Stato di piazzamento di un Altare o di un Dono: piazzato da chi, incarico a quale squadra, spostamento richiesto.
function placementChips(x, placed) {
  const sq = squadById(x.squadId);
  const by = squadById(x.placedSquadId);
  return h('div', { class: 'place-chips' },
    placed ? h('span', { class: 'chip chip-ok' }, `Piazzato ${fmtTime(x.placedAt)}${by ? ` · squadra ${by.name}` : x.placedBy ? ` · ${String(x.placedBy).replace('eletti:', '')}` : ''}`)
      : h('span', { class: 'chip chip-warn' }, 'Da piazzare'),
    x.moveRequestedAt ? h('span', { class: 'chip chip-blood' }, 'Da spostare') : null,
    sq ? h('span', { class: 'chip squad-chip', style: { '--c': sq.color } }, `Incarico: ${sq.name}${x.targetLat != null ? ' · ⌖ punto indicato' : ' · punto libero'}`)
      : !placed ? h('span', { class: 'chip' }, 'Nessuna squadra incaricata') : null);
}

function placementButtons(kind, x, placed) {
  const pending = !placed || x.moveRequestedAt;
  return [
    !placed ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => assignDialog(kind, x, false) }, x.squadId ? 'Cambia incarico' : 'Assegna a una squadra') : null,
    placed ? h('button', { class: 'btn btn-sm', onclick: () => assignDialog(kind, x, true) }, x.moveRequestedAt ? 'Cambia spostamento' : 'Fai spostare') : null,
    x.squadId && pending ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Annullare l\'incarico?', `${x.label}: la squadra non dovrà più ${placed ? 'spostarlo' : 'piazzarlo'}.`, 'POST', '/api/m/assign', { kind, id: x.id, squadId: null }, 'Incarico annullato').then(() => loadField(false)) }, 'Annulla incarico') : null,
  ];
}

// Modale: squadra (di default quella che lo ha piazzato, per gli spostamenti), punto sulla mappa o libero, nota.
async function assignDialog(kind, item, move) {
  const squads = R.ms.squads;
  if (!squads.length) { toast('Crea prima una squadra in "Squadre Eletti"', 'error', 6000); location.hash = 'squadre'; return; }
  if (!fieldData) await loadField(false);
  const def = move ? (item.placedSquadId || item.squadId) : item.squadId;
  const sel = h('select', { class: 'input' }, squads.map((s) => h('option', { value: s.id, selected: s.id === def }, `${s.name} · ${s.members.length} Eletti`)));
  let target = item.targetLat != null && !move ? { lat: item.targetLat, lng: item.targetLng } : null;
  const free = h('input', { type: 'radio', name: 'where', value: 'free', checked: !target });
  const pick = h('input', { type: 'radio', name: 'where', value: 'pick', checked: !!target });
  const info = h('p', { class: 'tiny muted' });
  const note = h('textarea', { class: 'input', rows: 2, maxlength: 300, placeholder: 'Nota per la squadra (facoltativa): es. dietro la quercia caduta' });
  note.value = move ? '' : item.taskNote || '';
  const pickMap = createMapView({ className: 'pick-map' });
  // Punti di interesse: si può scegliere uno di questi invece di toccare la mappa.
  const pois = (fieldData?.pois || []).filter((x) => x.lat != null && !x.occupied);
  const poiSel = pois.length ? h('select', { class: 'input', onchange: () => {
    const x = pois.find((p) => String(p.id) === poiSel.value);
    if (!x) return;
    target = { lat: x.lat, lng: x.lng };
    pick.checked = true;
    if (!note.value.trim()) note.value = `Presso: ${x.label}`;
    draw();
    pickMap.focus?.(['target']);
  } }, h('option', { value: '' }, 'Scegli un punto di interesse…'), pois.map((x) => h('option', { value: x.id }, x.label))) : null;
  const draw = () => {
    const items = [
      ...pois.map((x) => ({ key: `poi${x.id}`, kind: 'poi', lat: x.lat, lng: x.lng, title: x.label })),
      ...R.ms.landmarks.filter((l) => l.lat != null).map((l) => landmarkItem(l)),
      ...R.ms.points.filter((p) => p.lat != null).map((p) => ({ key: `p${p.id}`, kind: 'altar', lat: p.lat, lng: p.lng, text: p.roman, title: p.label, mine: kind === 'point' && p.id === item.id })),
      ...(fieldData?.gifts || []).filter((g) => g.lat != null && !['claimed', 'expired'].includes(g.status)).map((g) => ({ key: `g${g.id}`, kind: 'gift', lat: g.lat, lng: g.lng, text: g.icon, color: g.color, state: g.status === 'placed' ? 'hidden' : g.status, title: g.label })),
    ];
    if (target && pick.checked) items.push({ key: 'target', kind: 'target', lat: target.lat, lng: target.lng, title: 'Punto indicato' });
    pickMap.setItems(items);
    info.textContent = pick.checked ? (target ? `Punto indicato: ${target.lat.toFixed(5)}, ${target.lng.toFixed(5)} (tocca di nuovo per cambiarlo)` : 'Tocca la mappa nel punto in cui va piazzato.') : 'La squadra decide dove piazzarlo.';
  };
  free.addEventListener('change', draw);
  pick.addEventListener('change', draw);
  pickMap.ready.then(() => {
    pickMap.onTap((ll) => { target = { lat: ll.lat, lng: ll.lng }; pick.checked = true; if (poiSel) poiSel.value = ''; draw(); });
    draw();
    setTimeout(() => { pickMap.refresh(); pickMap.fit(); }, 60);
    setTimeout(() => pickMap.refresh(), 400);
  });
  const what = kind === 'gift' ? `${item.label} · ${item.icon || ''} ${item.name || ''}` : item.label;
  const ok = await modal({
    title: move ? `Fai spostare: ${what}` : `Assegna: ${what}`,
    wide: true,
    okLabel: move ? 'Manda a spostare' : 'Assegna l\'incarico',
    body: h('div', { class: 'stack-sm' },
      move ? h('p', { class: 'muted tiny' }, 'Proposta la squadra che lo ha piazzato. Riceve una notifica e trova l\'incarico nella sua app; quando lo ripiazzano, foto e posizione si aggiornano qui.') : h('p', { class: 'muted tiny' }, 'La squadra riceve una notifica e trova l\'incarico nella sua app, con il punto sulla mappa se lo indichi.'),
      h('label', { class: 'field' }, h('span', null, 'Squadra'), sel),
      h('div', { class: 'radio-row' }, h('label', null, free, ' Lasciali liberi di decidere'), h('label', null, pick, ' Indico io il punto sulla mappa')),
      poiSel ? h('label', { class: 'field' }, h('span', null, 'Oppure un punto di interesse'), poiSel) : null,
      pickMap.el, info,
      h('label', { class: 'field' }, h('span', null, 'Nota'), note)),
    onOk: async () => {
      if (pick.checked && !target) { toast('Tocca la mappa per indicare il punto', 'error'); return false; }
      await api('POST', '/api/m/assign', { kind, id: item.id, squadId: Number(sel.value), targetLat: pick.checked ? target.lat : null, targetLng: pick.checked ? target.lng : null, note: note.value, move });
      return true;
    },
  });
  if (ok) { toast(move ? 'Spostamento assegnato: la squadra è stata avvisata' : 'Incarico assegnato: la squadra è stata avvisata', 'ok'); load(); loadField(false); }
}

function viewAltars() {
  const ms = R.ms;
  const pre = PRE.includes(ms.clock.status);
  const phrase = h('textarea', { class: 'input', rows: 3, 'data-keep': 'phrase', placeholder: `Una frase di almeno ${ms.points.length || ms.teams.length} parole`, value: ms.game.phrase || '' });
  const placed = ms.points.filter((p) => p.lat != null).length;
  const withAltar = new Set(ms.points.map((p) => p.sectorId));
  const freeSectors = (ms.sectors || []).filter((x) => !x.archived && !withAltar.has(x.id));
  const addSel = h('select', { class: 'input input-sm', 'data-keep': 'free-altar' }, freeSectors.map((x) => h('option', { value: x.id }, `${x.roman} · ${x.name}`)));
  return h('div', { class: 'stack' },
    section('La Parola',
      h('p', { class: 'muted tiny' }, 'La frase viene divisa in tanti frammenti quanti sono gli Altari (uno per coppia, più quelli senza coppia) e i pezzi vengono assegnati agli Altari in ordine casuale. Puoi poi correggere ogni frammento.'),
      phrase,
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn btn-primary', disabled: !pre, onclick: () => confirmCall('Dividere la Parola?', 'I frammenti attuali vengono sostituiti (e tolti a chi li aveva).', 'POST', G('/phrase'), { phrase: phrase.value }, 'Parola divisa tra gli Altari') }, 'Dividi tra gli Altari'),
        ms.game.phrase ? h('span', { class: 'muted tiny' }, `Attuale: «${ms.game.phrase}»`) : null)),

    section('Luoghi del gioco',
      h('p', { class: 'muted tiny' }, 'Il Cerchio di inizio e la Soglia si piazzano sul campo come gli Altari (la foto è facoltativa) e compaiono sulla mappa di regia, Eletti e coppie.'),
      h('div', { class: 'places' }, ms.landmarks.map((l) => h('div', { class: `place-card ${l.lat != null ? 'is-placed' : ''}` },
        h('div', { class: 'place-ico' }, l.kind === 'soglia' ? '⛩' : '◯'),
        h('div', { class: 'stack-sm grow' },
          h('strong', null, l.label),
          placementChips(l, l.lat != null),
          l.lat != null ? h('div', { class: 'tiny muted mono' }, `${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}${l.accuracy ? ` · ±${l.accuracy} m` : ''}`) : null,
          h('div', { class: 'row-actions' }, ...placementButtons('landmark', l, l.lat != null),
            l.photoFile ? h('a', { class: 'btn btn-sm btn-ghost', href: `/api/media/landmark/${l.id}?v=${l.placedAt}`, target: '_blank' }, 'Foto') : null,
            h('a', { class: 'btn btn-sm btn-ghost', href: '/campo', target: '_blank' }, 'Piazzalo io'),
            l.kind === 'soglia' ? h('a', { class: 'btn btn-sm btn-primary', href: `/regia/stampa/uscita/${R.gameId}`, target: '_blank' }, 'Stampa QR di uscita') : null),
          l.kind === 'soglia' ? h('p', { class: 'tiny muted' }, 'Il QR di uscita va appeso alla Soglia: una coppia con la Parola intera e senza alleati lo inquadra ed esfiltra da sola (il suo Sigillo viene rivelato a tutti). Resta valida anche la verifica dell\'Ufficiale.') : null))))),

    sectionActions(`Altari (${ms.points.length}) · piazzati ${placed}/${ms.points.length}`, [
      h('button', { class: 'btn btn-sm', disabled: !pre, onclick: () => call('POST', G('/points'), {}, 'Altari allineati alle coppie') }, 'Allinea alle coppie'),
      h('a', { class: 'btn btn-sm', href: '#mappa' }, 'Vedi in mappa'),
      h('a', { class: 'btn btn-sm', href: `/api/field/export.kmz?gameId=${R.gameId}`, download: '' }, 'Esporta KMZ (ATAK)'),
      h('a', { class: 'btn btn-sm btn-primary', href: `/regia/stampa/altari/${R.gameId}`, target: '_blank' }, 'Stampa cartelli A4')],
    h('p', { class: 'muted tiny' }, 'L\'Altare di una coppia nasce appena la coppia è formata e lo vedi subito qui e sulla mappa del campo; le coppie lo vedono in mappa solo dal via. Puoi creare Altari anche prima delle iscrizioni, per piazzarli nel bosco: restano «senza coppia» finché una coppia non prende quel Settore.'),
    pre && freeSectors.length ? h('div', { class: 'row-actions' },
      h('strong', { class: 'small' }, 'Nuovo Altare senza coppia'), addSel,
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => call('POST', G('/points/free'), { sectorId: Number(addSel.value) }, 'Altare creato') }, 'Crea'),
      h('button', { class: 'btn btn-sm', onclick: () => confirmCall('Un Altare per ogni Settore?', `Si creano ${freeSectors.length} Altari, uno per ogni Settore che non ne ha ancora uno. Quelli che resteranno senza coppia daranno il loro Sigillo solo con il tradimento.`, 'POST', G('/points/free'), { all: true }, 'Altari creati') }, `Tutti i Settori (${freeSectors.length})`)) : null,
    ms.points.length ? h('div', { class: 'altars' }, ms.points.map((p) => {
      const url = `${R.baseUrl}/a/${p.qrToken}`;
      const isPlaced = p.lat != null;
      return h('div', { class: `altar-card ${isPlaced ? 'is-placed' : ''}` },
        h('img', { class: 'altar-qr', src: `/api/m/qr.svg?text=${encodeURIComponent(url)}`, alt: `QR ${p.label}`, width: 120, height: 120, loading: 'lazy' }),
        h('div', { class: 'stack-sm grow' },
          h('div', { class: 'eyebrow' }, `${p.roman} · Settore ${p.sectorName}`),
          p.free ? h('span', { class: 'chip chip-warn', title: 'Nessuna coppia custodisce questo Sigillo: arriva solo dal tradimento' }, 'Senza coppia') : null,
          placementChips(p, isPlaced),
          h('input', { class: 'input input-sm', 'data-keep': `pl-${p.id}`, value: p.label, onchange: (e) => call('PATCH', `/api/m/points/${p.id}`, { label: e.target.value }, 'Nome aggiornato') }),
          h('input', { class: 'input input-sm', 'data-keep': `pn-${p.id}`, value: p.locationNote || '', placeholder: 'Posizione nel bosco (solo regia)', onchange: (e) => call('PATCH', `/api/m/points/${p.id}`, { locationNote: e.target.value }, 'Posizione salvata') }),
          p.fragmentId ? h('div', { class: 'frag-edit' },
            h('span', { class: 'mono pos' }, `#${p.position}`),
            h('input', { class: 'input input-sm', 'data-keep': `pf-${p.fragmentId}`, value: p.fragmentText, disabled: !pre, onchange: (e) => call('PATCH', `/api/m/fragments/${p.fragmentId}`, { text: e.target.value }, 'Frammento aggiornato') }))
            : h('div', { class: 'tiny bad' }, 'Nessun frammento: dividi la Parola'),
          h('div', { class: 'row-actions' },
            ...placementButtons('point', p, isPlaced),
            isPlaced && p.photoFile ? h('a', { class: 'btn btn-sm btn-ghost', href: `/api/media/point/${p.id}?v=${p.placedAt}`, target: '_blank' }, 'Foto') : null,
            h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { navigator.clipboard?.writeText(url); toast('Link dell\'Altare copiato', 'ok'); } }, 'Copia link'),
            pre ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Rigenerare il QR?', 'Il cartello già stampato non funzionerà più: andrà ristampato.', 'POST', `/api/m/points/${p.id}/regen`, {}, 'QR rigenerato', true) }, 'Rigenera QR') : null,
            pre && p.free ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Eliminare l\'Altare?', `${p.label}: il cartello stampato non funzionerà più. Ricordati di rigenerare i Sigilli e di dividere di nuovo la Parola.`, 'DELETE', `/api/m/points/${p.id}`, null, 'Altare eliminato', true) }, 'Elimina') : null)));
    })) : h('p', { class: 'empty' }, 'Nessun Altare: forma le coppie oppure crea gli Altari dei Settori qui sopra.')));
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
  const Rn = N - ms.codes.filter((c) => c.neverRevealed).length;

  return h('div', { class: 'stack' },
    sectionActions('Sigilli dei Settori', [
      h('button', { class: 'btn btn-sm btn-primary', disabled: !pre, onclick: () => confirmCall(N ? 'Rigenerare i Sigilli?' : 'Generare i Sigilli?', N ? 'Tutti i Sigilli cambiano. Se le coppie li hanno già visti nel cerchio, vedranno quelli nuovi.' : 'Un Sigillo per Settore, 6 caratteri senza caratteri ambigui.', 'POST', G('/codes'), {}, 'Sigilli generati', !!N) }, N ? 'Rigenera Sigilli' : 'Genera Sigilli'),
      h('button', { class: 'btn btn-sm', disabled: !pre || !N, onclick: () => confirmCall('Nuova estrazione?', `Si estraggono a caso ${g.neverRevealedCount} Sigilli che il Consiglio non rivelerà mai. Il calendario viene ricalcolato.`, 'POST', G('/never'), {}, 'Estrazione fatta') }, 'Estrai i mai rivelati'),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: toggleShowAll }, R.showAll ? 'Nascondi' : 'Mostra tutti')],
    h('p', { class: 'muted tiny' }, 'I Sigilli sono sfocati: tieni premuto per leggerne uno. Nelle app delle coppie appaiono come simulacri sfocati finché non vengono svelati: il proprio all\'apertura del cerchio, gli altri al momento del tradimento.'),
    ms.codes.some((c) => c.free) ? h('p', { class: 'muted tiny' }, 'I Sigilli degli Altari senza coppia non li custodisce nessuno: non si vincono né si rubano, arrivano solo dal tradimento. Uno di loro è sempre l\'ultimo in calendario (il «lucchetto»): nessuno può finire prima di quell\'orario.') : null,
    codesGrid()),

    sectionActions('Calendario dei tradimenti', [
      pre ? h('button', { class: 'btn btn-sm', disabled: !N, onclick: () => confirmCall('Ricalcolare il calendario?', 'Orari ricalcolati e ordine dei Settori di nuovo casuale.', 'POST', G('/calendar'), {}, 'Calendario ricalcolato') }, 'Ricalcola (ordine casuale)') : null],
    h('p', { class: 'mono tiny muted' }, `Caccia a ${H}′ · prima rivelazione F = ${F}′ · ultima L = ${L}′ · Sigilli N = ${N} · rivelazioni R = ${Math.max(0, Rn)}${Rn > 1 ? ` · intervallo ${((L - F) / (Rn - 1)).toFixed(1)}′` : ''}`),
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

const FIELD_TABS = ['mappa', 'doniqr', 'squadre', 'altari', 'live'];
const fieldMap = createMapView({ className: 'regia-map' });
let fieldData = null;

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

// Posizioni GPS di coppie (a partita iniziata) ed Eletti (da partita pronta): aggiornate ogni 10 s sulla mappa.
let fieldPositions = [];
let positionsTimer = null;
async function pollPositions() {
  if (tab() !== 'mappa' || !R.gameId) { clearInterval(positionsTimer); positionsTimer = null; return; }
  try {
    fieldPositions = await api('GET', `/api/field/positions?gameId=${R.gameId}`);
    const el = document.getElementById('pos-count');
    if (el) el.textContent = positionsSummary();
    if (fieldData) viewFieldMapItems();
  } catch { /* senza rete */ }
}
function startPositions() {
  if (positionsTimer) return;
  positionsTimer = setInterval(pollPositions, 10000);
  pollPositions();
}
const positionsSummary = () => {
  const teams = fieldPositions.filter((p) => p.kind === 'team').length;
  const elect = fieldPositions.filter((p) => p.kind === 'elect').length;
  return `In mappa: ${teams} telefoni delle coppie · ${elect} degli Eletti`;
};
// Punti indicati alle squadre per i piazzamenti ancora da fare.
function targetItems(d) {
  const todo = (x, k) => x.targetLat != null && (k === 'gift' ? x.status === 'draft' || x.moveRequestedAt : x.lat == null || x.moveRequestedAt);
  return [...d.points.map((p) => ['point', p]), ...d.gifts.map((g) => ['gift', g]), ...(d.landmarks || []).map((l) => ['landmark', l])]
    .filter(([k, x]) => todo(x, k))
    .map(([k, x]) => ({ key: `t${k}${x.id}`, kind: 'target', lat: x.targetLat, lng: x.targetLng, title: `Da piazzare qui: ${x.label}`, popup: `<strong>Da piazzare qui</strong><br>${x.label}${squadById(x.squadId) ? `<br>Squadra ${squadById(x.squadId).name}` : ''}` }));
}

// Segnaposto della mappa della regia, con le azioni nei popup (pulsanti data-act gestiti qui sotto).
const actBtn = (act, kind, id, label) => `<button type="button" class="btn btn-sm" data-act="${act}" data-kind="${kind}" data-id="${id}">${label}</button>`;
const placedInfo = (x) => `<small>${x.provisional ? '⚠ Provvisorio · ' : ''}Piazzato ${fmtTime(x.placedAt)} da ${String(x.placedBy || '?').replace('eletti:', '')}${x.accuracy ? ` · ±${x.accuracy} m` : ''}${x.placeSource === 'manual' ? ' · punto manuale' : ''}</small>`;
function fieldMapItems(d) {
  return [
    ...groupPositions(fieldPositions).map(positionItem),
    ...(d.landmarks || []).map((l) => landmarkItem(l, `<br>${placedInfo(l)}${l.hasPhoto ? `<img src="/api/media/landmark/${l.id}?v=${l.placedAt}" alt="">` : ''}
      <div class="popup-actions">${actBtn('pick', 'landmark', l.id, 'Sposta: clicca sulla mappa')}${actBtn('move', 'landmark', l.id, 'Fai spostare a una squadra')}</div>`)),
    ...targetItems(d),
    // Punti di interesse segnati dal campo (regia ed Eletti).
    ...(d.pois || []).filter((x) => !x.occupied).map((x) => ({ key: `poi${x.id}`, kind: 'poi', lat: x.lat, lng: x.lng, title: x.label,
      popup: `<strong>◆ ${escHtml(x.label)}</strong>${x.description ? `<br>${escHtml(x.description)}` : ''}<br><small>${escHtml(String(x.createdBy || '').replace('eletti:', ''))} · ${fmtTime(x.createdAt)}</small>` })),
    ...d.points.map((p) => ({ key: `p${p.id}`, kind: 'altar', lat: p.lat, lng: p.lng, text: p.roman, color: p.color, title: p.label, provisional: p.provisional,
      popup: `<strong>${p.label}</strong><br>${placedInfo(p)}${p.hasPhoto ? `<img src="/api/media/point/${p.id}?v=${p.placedAt}" alt="">` : ''}
        <div class="popup-actions">${actBtn('pick', 'point', p.id, 'Sposta: clicca sulla mappa')}${actBtn('move', 'point', p.id, p.moveRequestedAt ? 'Cambia spostamento' : 'Fai spostare a una squadra')}</div>` })),
    // Doni: grigi finché non compaiono, colorati quando compaiono, barrati quando presi.
    ...d.gifts.map((g) => ({ key: `g${g.id}`, kind: 'gift', lat: g.lat, lng: g.lng, text: g.icon, color: g.color, state: g.status === 'placed' ? 'hidden' : g.status, title: g.label, provisional: g.provisional,
      popup: giftPopup(g) + (['placed', 'revealed'].includes(g.status) ? `<div class="popup-actions">${actBtn('pick', 'gift', g.id, 'Sposta: clicca sulla mappa')}${actBtn('move', 'gift', g.id, 'Fai spostare a una squadra')}</div>` : '') })),
  ];
}

// Alleanze in mappa: linee tratteggiate tra le coppie alleate (dalla posizione del loro pallino).
const ALLY_COLORS = ['#d1ad62', '#ff4fa3', '#22c3e6', '#a3e635', '#f97316', '#9b6cf0'];
function allianceLines() {
  const alliances = R.ms?.combat?.alliances || [];
  const where = {};
  for (const p of groupPositions(fieldPositions)) if (p.kind === 'team' && !where[p.teamId]) where[p.teamId] = [p.lat, p.lng];
  const out = [];
  alliances.forEach((a, i) => {
    const pts = a.members.map((m) => where[m.teamId]).filter(Boolean);
    for (let x = 0; x < pts.length; x++) for (let y = x + 1; y < pts.length; y++) {
      out.push({ key: `ally-${a.id}-${x}-${y}`, points: [pts[x], pts[y]], color: ALLY_COLORS[i % ALLY_COLORS.length], title: `Alleanza: ${a.members.map((m) => m.sectorName).join(' + ')}` });
    }
  });
  return out;
}

// Aggiorna solo i segnaposto, senza ridisegnare la pagina.
function viewFieldMapItems() {
  if (fieldData) { fieldMap.setItems(fieldMapItems(fieldData)); fieldMap.setLines(allianceLines()); }
}

const findFieldItem = (kind, id) => {
  const d = fieldData;
  if (!d) return null;
  return (kind === 'landmark' ? d.landmarks : kind === 'gift' ? d.gifts : d.points).find((x) => x.id === Number(id)) || null;
};

// Pulsanti dentro i popup della mappa (in cattura: Leaflet ferma i clic nei popup prima che risalgano).
fieldMap.el.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  e.stopPropagation();
  const x = findFieldItem(b.dataset.kind, b.dataset.id);
  if (!x) return;
  fieldMap.map?.closePopup();
  if (b.dataset.act === 'move') assignDialog(b.dataset.kind, x, true);
  if (b.dataset.act === 'pick') startPick(x, b.dataset.kind);
}, true);

// Soglia e Cerchio si possono segnare direttamente dalla regia: un clic sulla mappa (foto facoltativa, si aggiunge dal telefono).
function startPick(x, kind = 'landmark') {
  R.mapPick = { id: x.id, kind, label: kind === 'gift' ? `${x.label} · ${x.name}` : x.label };
  render();
}
// Spostando un oggetto si può toccare un punto di interesse: l'oggetto prende il suo posto (e il punto non si vede più).
fieldMap.onMarkerTap((key) => {
  if (!R.mapPick || !key.startsWith('poi')) return false;
  const x = (fieldData?.pois || []).find((p) => `poi${p.id}` === key);
  if (!x) return false;
  placePicked({ lat: x.lat, lng: x.lng }, x.label);
  return true;
});
fieldMap.onTap((ll) => placePicked(ll));
async function placePicked(ll, poiLabel = null) {
  const pick = R.mapPick;
  if (!pick) return;
  R.mapPick = null;
  const qs = new URLSearchParams({ gameId: R.gameId, lat: ll.lat, lng: ll.lng, source: 'manual' });
  try {
    const path = { landmark: 'landmarks', point: 'points', gift: 'gifts' }[pick.kind || 'landmark'];
    const res = await fetch(`/api/field/${path}/${pick.id}/place?${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Errore ${res.status}`);
    toast(poiLabel ? `${pick.label} messo al posto di «${poiLabel}»` : `${pick.label} segnato sulla mappa`, 'ok');
  } catch (err) { toast(err.message, 'error', 6000); }
  await loadField();
}

function campoPhoneDialog() {
  const campoUrl = `${R.baseUrl}/campo`;
  modal({
    title: 'Campo sul telefono', okLabel: 'Chiudi', cancelLabel: 'Apri qui',
    body: h('div', { class: 'stack-sm' },
      h('div', { class: 'reg-link' }, h('img', { src: `/api/m/qr.svg?text=${encodeURIComponent(campoUrl)}`, alt: 'QR strumento di campo', width: 130, height: 130 }),
        h('div', null, h('div', { class: 'mono' }, campoUrl), h('div', { class: 'tiny' }, 'Inquadralo dal tuo telefono ed entra con l\'account della regia. Gli Eletti hanno le stesse funzioni nella loro app.'))),
      h('ol', { class: 'tiny muted hints' },
        h('li', null, 'Scansiona il cartello dell\'Altare o del Dono (o sceglilo dall\'elenco).'),
        h('li', null, 'L\'app prende la posizione GPS del telefono (o tocchi il punto sulla mappa).'),
        h('li', null, 'Scatta la foto del piazzamento e conferma (per Soglia e Cerchio è facoltativa).')),
      h('p', { class: 'tiny muted' }, 'GPS, fotocamera interna e scanner richiedono https.')),
  }).then((r) => { if (r === null) window.open('/campo', '_blank'); });
}

function viewFieldMap() {
  const d = fieldData;
  if (!d) { loadField(); return h('p', { class: 'empty' }, 'Caricamento del campo…'); }
  startPositions();
  fieldMap.setItems(fieldMapItems(d));
  queueMicrotask(() => fieldMap.setLines(allianceLines()));
  fieldMap.refresh();
  const sqName = (id) => squadById(id)?.name;
  const toPlace = [
    ...(d.landmarks || []).filter((l) => l.lat == null).map((l) => ({ kind: 'landmark', x: l, icon: l.kind === 'soglia' ? '⛩' : '◯' })),
    ...d.points.filter((p) => p.lat == null).map((p) => ({ kind: 'point', x: p, icon: p.roman })),
    ...d.gifts.filter((g) => g.status === 'draft').map((g) => ({ kind: 'gift', x: g, icon: g.icon })),
  ];
  const placedA = d.points.filter((p) => p.lat != null).length;
  const legend = h('div', { class: 'map-legend' },
    h('span', null, h('span', { class: 'pin pin-altar' }, 'I'), ' Altare'),
    h('span', null, h('span', { class: 'pin pin-place pin-soglia' }, '⛩'), ' Soglia'),
    h('span', null, h('span', { class: 'pin pin-place' }, '◯'), ' Cerchio'),
    h('span', null, h('span', { class: 'pin pin-target' }, '⌖'), ' Punto indicato'),
    h('span', null, h('span', { class: 'pin pin-poi' }), ' Punto di interesse (si aggiunge dal campo)'),
    h('span', null, h('span', { class: 'pin pin-gift pin-hidden' }, '✦'), ' Dono non annunciato'),
    h('span', null, h('span', { class: 'pin pin-gift pin-revealed', style: { '--c': '#d1ad62' } }, '✦'), ' Dono annunciato'),
    h('span', null, h('span', { class: 'pin pin-gift pin-claimed' }, '✦'), ' Dono preso'),
    h('span', null, h('span', { class: 'pin-dot', style: { '--c': '#e5484d' } }), ' Coppia (colore del Settore; un pallino se i due sono entro 30 m)'),
    h('span', null, h('span', { class: 'ally-line' }), ' Alleanza'),
    h('span', null, h('span', { class: 'pin-dot', style: { '--c': '#d1ad62' } }), ' Eletto'));

  return h('div', { class: 'map-full' },
    fieldMap.el,
    h('div', { class: 'map-tools' },
      h('button', { class: 'btn btn-sm', onclick: () => fieldMap.autoCenter() }, '◎ Centra'),
      // Quando è tutto piazzato il pannello e il suo pulsante spariscono.
      toPlace.length ? h('button', { class: `btn btn-sm ${R.mapSide === false ? '' : 'on'}`, onclick: () => { R.mapSide = R.mapSide === false; render(); } }, `Da piazzare (${toPlace.length})`) : null,
      h('button', { class: `btn btn-sm ${R.mapAllies ? 'on' : ''}`, onclick: () => { R.mapAllies = !R.mapAllies; render(); } }, `Alleanze (${R.ms.combat?.alliances.length || 0})`),
      h('button', { class: `btn btn-sm ${R.mapLegend ? 'on' : ''}`, onclick: () => { R.mapLegend = !R.mapLegend; render(); } }, 'Legenda'),
      h('a', { class: 'btn btn-sm', href: `/api/field/export.kmz?gameId=${R.gameId}`, download: '', title: 'Tutti i punti (luoghi, Altari, Doni, punti indicati) per ATAK o Google Earth' }, '⇩ KMZ (ATAK)'),
      h('button', { class: 'btn btn-sm btn-primary', onclick: campoPhoneDialog }, '📱 Campo sul telefono')),
    R.mapPick ? h('div', { class: 'map-pick' }, h('strong', null, `Clicca sulla mappa (o su un punto di interesse ◆) dove si trova: ${R.mapPick.label}`),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { R.mapPick = null; render(); } }, 'Annulla')) : null,
    R.mapSide === false || !toPlace.length ? null : h('aside', { class: 'map-side' },
      h('div', { class: 'eyebrow' }, `Da piazzare · Altari ${placedA}/${d.points.length}`),
      toPlace.length ? h('ul', { class: 'map-side-list' }, toPlace.map(({ kind, x, icon }) => h('li', null,
        h('span', { class: `side-ico ${kind}` }, icon),
        h('div', { class: 'grow' }, h('strong', null, kind === 'gift' ? `${x.label} · ${x.name}` : x.label),
          h('div', { class: 'tiny muted' }, x.squadId ? `Squadra ${sqName(x.squadId) || '?'}${x.targetLat != null ? ' · punto indicato' : ''}` : 'Nessuna squadra')),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn btn-sm btn-primary', title: 'Piazzalo tu con un clic sulla mappa (foto facoltativa)', onclick: () => startPick(x, kind) }, 'Segna'),
          h('button', { class: 'btn btn-sm', onclick: () => assignDialog(kind, x, false) }, x.squadId ? 'Cambia' : 'Assegna'))))) : null,
      h('p', { class: 'tiny muted' }, 'Tocca un segnaposto per vederne foto e dettagli e per farlo spostare.')),
    R.mapLegend ? h('div', { class: 'map-legend-box' }, legend,
      h('p', { class: 'tiny muted', id: 'pos-count' }, positionsSummary()),
      h('p', { class: 'tiny muted' }, 'Tocca un segnaposto per foto e dettagli e per spostarlo. Coppie in mappa dal VIA, Eletti da partita pronta.')) : null,
    R.mapAllies ? h('div', { class: 'map-allies-box' }, alliancesList(true)) : null);
}

// Elenco delle alleanze in corso, con i colori dei Settori (mappa e pagina Regia).
function alliancesList(withLines = false) {
  const al = R.ms?.combat?.alliances || [];
  const chip = (m) => h('span', { class: 'ally-chip' }, h('span', { class: 'pin-dot', style: { '--c': m.color || '#ff4fa3' } }), `${m.roman} ${m.sectorName}`);
  return h('div', { class: 'stack-sm' },
    h('div', { class: 'eyebrow' }, `Alleanze in corso (${al.length})`),
    al.length ? h('ul', { class: 'ally-list' }, al.map((a, i) => h('li', { style: { '--c': ALLY_COLORS[i % ALLY_COLORS.length] } },
      h('div', { class: 'ally-members' }, a.members.map((m, k) => [k ? h('span', { class: 'ally-link', 'aria-hidden': 'true' }, '⛓') : null, chip(m)])),
      h('span', { class: 'tiny muted' }, `dalle ${fmtTime(a.createdAt)}`)))) : h('p', { class: 'tiny muted' }, 'Nessuna alleanza in corso.'),
    withLines && al.length ? h('p', { class: 'tiny muted' }, 'In mappa le coppie alleate sono unite da una linea tratteggiata dello stesso colore (se i loro telefoni sono in mappa).') : null);
}

// ---------------------------------------------------------------- SQUADRE ELETTI

async function squadCall(method, url, body, okMsg) {
  try {
    const r = await api(method, url, body);
    if (okMsg) toast(okMsg, 'ok');
    await Promise.all([load(), loadField(false)]);
    render();
    return r || true;
  } catch (e) { toast(e.message, 'error', 6000); return null; }
}

const squadOptions = (value, none = '— nessuna —') => [h('option', { value: '' }, none), ...R.ms.squads.map((sq) => h('option', { value: sq.id, selected: sq.id === value }, sq.name))];

// Bersaglio di un incarico: una coppia o un punto già piazzato (Altare, luogo, punto di interesse, dono).
function targetSelect(keep) {
  const d = fieldData;
  const placed = (list) => (list || []).filter((x) => x.lat != null);
  return h('select', { class: 'input input-sm', 'data-keep': keep, 'aria-label': 'Bersaglio' },
    h('option', { value: '' }, 'Nessun bersaglio (incarico libero)'),
    h('optgroup', { label: 'Raggiungere una coppia (la vedono in mappa)' }, R.ms.teams.filter((t) => t.status === 'active').map((t) => h('option', { value: `team:${t.id}` }, `${t.roman} · Settore ${t.sectorName}`))),
    h('optgroup', { label: 'Luoghi' }, placed(d.landmarks).map((x) => h('option', { value: `landmark:${x.id}` }, x.label))),
    h('optgroup', { label: 'Altari' }, placed(d.points).map((x) => h('option', { value: `point:${x.id}` }, x.label))),
    h('optgroup', { label: 'Punti di interesse' }, placed(d.pois).map((x) => h('option', { value: `poi:${x.id}` }, x.label))));
}

const TASK_KIND = { text: '', goto: '⌖ ', hunt: '🎯 ', meet: '🤝 ' };
const TASK_SOURCE = { skill: 'da una Skill', gift: 'da un Dono', regia: 'dalla regia' };

function taskLine(t, { assign = false } = {}) {
  const closed = t.doneAt || t.cancelledAt;
  const sel = assign ? h('select', { class: 'input input-sm', 'aria-label': 'Squadra' }, squadOptions(t.squadId, 'Scegli la squadra…')) : null;
  return h('li', { class: closed ? 'done' : '' },
    assign ? h('span', null, `${TASK_KIND[t.kind] || ''}${t.text}`) : h('label', null, h('input', { type: 'checkbox', checked: !!t.doneAt, disabled: !!t.cancelledAt, onchange: (e) => squadCall('POST', `/api/m/tasks/${t.id}/done`, { done: e.target.checked }) }), h('span', null, `${TASK_KIND[t.kind] || ''}${t.text}`)),
    // Da assegnare: quando è stato chiesto (e da chi), così si vede da quanto aspetta.
    assign ? h('span', { class: 'tiny task-asked' }, `Chiesto alle ${fmtTime(t.createdAt)}${t.sourceTeamId ? ` dal Settore ${R.ms?.teams.find((x) => x.id === t.sourceTeamId)?.sectorName || '?'}` : ''} · `,
      h('span', { 'data-ago': t.createdAt }, agoText(t.createdAt))) : null,
    h('span', { class: 'tiny muted' }, [t.source !== 'regia' ? TASK_SOURCE[t.source] : null, t.kind === 'meet' && t.endsAt ? `alleanza fino alle ${fmtTime(t.endsAt)}` : null,
      t.cancelledAt ? `annullato ${fmtTime(t.cancelledAt)}` : t.doneAt ? `${fmtTime(t.doneAt)} · ${(t.doneBy || '').replace('eletti:', '')}` : null].filter(Boolean).join(' · ')),
    sel, assign ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => { if (!Number(sel.value)) return toast('Scegli la squadra', 'error'); squadCall('POST', `/api/m/tasks/${t.id}/assign`, { squadId: Number(sel.value) }, 'Incarico assegnato'); } }, 'Assegna') : null,
    !closed ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => squadCall('POST', `/api/m/tasks/${t.id}/cancel`, {}, 'Incarico annullato') }, 'Annulla') : null,
    h('button', { class: 'btn btn-sm btn-ghost', 'aria-label': 'Elimina incarico', onclick: () => squadCall('DELETE', `/api/m/tasks/${t.id}`, undefined, 'Incarico eliminato') }, '✕'));
}

async function newSquadDialog() {
  const name = h('input', { class: 'input', placeholder: 'es. Squadra Nord', maxlength: 40, required: true });
  const color = h('input', { class: 'gt-color', type: 'color', value: '#e0603f', 'aria-label': 'Colore' });
  await modal({ title: 'Nuova squadra di Eletti', okLabel: 'Crea squadra', body: h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', null, 'Nome'), name), h('label', { class: 'field' }, h('span', null, 'Colore'), color)),
    onOk: async () => { if (!name.value.trim()) { toast('Scrivi il nome', 'error'); return false; } return !!(await squadCall('POST', G('/squads'), { name: name.value, color: color.value }, 'Squadra creata')); } });
}

async function newElectDialog() {
  const en = h('input', { class: 'input', placeholder: 'Nome e cognome', required: true });
  const ek = h('input', { class: 'input', placeholder: 'Nome di battaglia' });
  const et = h('input', { class: 'input', placeholder: 'Team di softair' });
  const es = h('select', { class: 'input', 'aria-label': 'Squadra' }, squadOptions(null, 'Squadra: nessuna'));
  await modal({ title: 'Aggiungi un Eletto', okLabel: 'Aggiungi', body: h('div', { class: 'form-grid' }, en, ek, et, es),
    onOk: async () => {
      if (!en.value.trim()) { toast('Scrivi il nome', 'error'); return false; }
      const r = await squadCall('POST', G('/elect/person'), { name: en.value, nickname: ek.value, softairTeam: et.value }, 'Aggiunto agli Eletti');
      if (r?.id && Number(es.value)) await squadCall('POST', `/api/m/players/${r.id}/squad`, { squadId: Number(es.value) });
      return !!r;
    } });
}

function viewSquads() {
  const d = fieldData;
  if (!d) { loadField(); return h('p', { class: 'empty' }, 'Caricamento delle squadre…'); }
  const ms = R.ms;
  const members = ms.elect.members;
  const byId = Object.fromEntries(ms.players.map((p) => [p.id, p]));
  // A partita iniziata non si aggiungono più Eletti: le candidature in sospeso non si mostrano.
  const candidates = PRE.includes(ms.clock.status) ? ms.players.filter((p) => p.status === 'pending' && p.requestedRole === 'elect') : [];
  const progress = (sq) => {
    const pts = [...(d.landmarks || []), ...d.points].filter((p) => p.squadId === sq.id);
    const gifts = d.gifts.filter((g) => g.squadId === sq.id && !['claimed', 'expired'].includes(g.status));
    const todo = pts.filter((p) => p.lat == null || p.moveRequestedAt).length + gifts.filter((g) => g.status === 'draft' || g.moveRequestedAt).length;
    return { pts, gifts, todo, tasksDone: sq.tasks.filter((t) => t.doneAt).length, tasksLive: sq.tasks.filter((t) => !t.cancelledAt).length };
  };
  const openTasks = d.openTasks || [];

  return h('div', { class: 'stack' },
    candidates.length ? h('div', { class: 'panel pending-panel' },
      h('div', { class: 'panel-head' }, h('h2', null, `Candidature agli Eletti da approvare (${candidates.length})`)),
      h('p', { class: 'muted tiny' }, 'Arrivano dal modulo di iscrizione. Accettando, la persona entra tra gli Eletti (nella squadra scelta) e il suo telefono passa subito all\'app degli Eletti con il suo accesso personale.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'elect-table' },
        h('thead', null, h('tr', null, ['Candidato', 'Team softair', 'Come vuole servire', 'Squadra', ''].map((x) => h('th', null, x)))),
        h('tbody', null, candidates.map((p) => {
          const sel = h('select', { class: 'input input-sm', 'aria-label': `Squadra per ${p.name}` }, squadOptions(null));
          return h('tr', null,
            h('td', null, personLine(p), phoneLinks(p.phone), h('div', { class: 'tiny muted' }, fmtTime(p.createdAt))),
            h('td', null, p.softairTeam || h('span', { class: 'muted' }, '—')),
            h('td', { class: 'tiny' }, p.note ? `«${p.note}»` : h('span', { class: 'muted' }, '—')),
            h('td', null, sel),
            h('td', { class: 'row-actions' },
              h('button', { class: 'btn btn-sm btn-primary', onclick: () => squadCall('POST', `/api/m/players/${p.id}/review`, { decision: 'accept', squadId: Number(sel.value) || null }, `${p.name} è tra gli Eletti`) }, 'Accetta'),
              h('button', { class: 'btn btn-sm btn-danger', onclick: () => confirmCall('Rifiutare la candidatura?', `${p.name}: la candidatura verrà cancellata.`, 'POST', `/api/m/players/${p.id}/review`, { decision: 'reject' }, 'Candidatura rifiutata', true) }, 'Rifiuta')));
        }))))) : null,

    openTasks.length ? h('div', { class: 'panel pending-panel' },
      h('div', { class: 'panel-head' }, h('h2', null, `Incarichi da assegnare (${openTasks.length})`)),
      h('p', { class: 'muted tiny' }, 'Generati dalle Skill e dai Doni delle coppie (Maestro della caccia, Alleanze sporche) o creati senza squadra. La squadra scelta vede il bersaglio sulla sua mappa finché l\'incarico è aperto; la coppia bersaglio lo scopre 1 minuto dopo l\'assegnazione.'),
      d.squads.length ? h('ul', { class: 'squad-tasks' }, openTasks.map((t) => taskLine(t, { assign: true }))) : h('p', { class: 'empty' }, 'Crea prima una squadra di Eletti.')) : null,

    sectionActions(`Squadre degli Eletti (${d.squads.length})`, [h('button', { class: 'btn btn-sm btn-primary', onclick: newSquadDialog }, '+ Nuova squadra')],
      h('p', { class: 'muted tiny' }, 'Dividi gli Eletti in squadre e manda ogni squadra a piazzare o spostare Altari e Doni (dalle sezioni Altari e Doni) o a svolgere incarichi: liberi, raggiungere un punto o raggiungere una coppia (che la squadra vede in mappa finché l\'incarico è aperto). I membri ricevono una notifica e trovano tutto nella loro app, nella voce Incarichi.'),
      d.squads.length ? h('div', { class: 'squads' }, d.squads.map((sq) => {
      const pr = progress(sq);
      const taskIn = h('input', { class: 'input input-sm', 'data-keep': `sq-task-${sq.id}`, placeholder: 'Nuovo incarico (es. presidiate il Cuore dalle 10)', maxlength: 300 });
      const taskTarget = targetSelect(`sq-target-${sq.id}`);
      return h('div', { class: 'squad-card', style: { '--c': sq.color } },
        h('div', { class: 'squad-head' },
          h('input', { class: 'gt-color', type: 'color', value: sq.color, 'aria-label': 'Colore', onchange: (e) => squadCall('PATCH', `/api/m/squads/${sq.id}`, { color: e.target.value }) }),
          h('input', { class: 'input input-sm squad-name', value: sq.name, 'data-keep': `sq-n-${sq.id}`, onchange: (e) => squadCall('PATCH', `/api/m/squads/${sq.id}`, { name: e.target.value }, 'Nome aggiornato') }),
          h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { R.chat = { kind: 'squad', id: sq.id }; R.chatOpen = true; location.hash = 'comunicazioni'; } }, 'Scrivi'),
          h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Eliminare la squadra?', `${sq.name}: membri e incarichi di piazzamento tornano liberi, gli incarichi liberi vengono cancellati.`, 'DELETE', `/api/m/squads/${sq.id}`, undefined, 'Squadra eliminata', true).then(() => loadField()) }, 'Elimina')),
        h('div', { class: `tiny ${pr.todo ? 'bad' : 'muted'}` }, `${pr.todo} piazzamenti da fare · Incarichi fatti ${pr.tasksDone}/${pr.tasksLive}`),
        h('div', { class: 'squad-members' }, sq.members.length ? sq.members.map((m) => h('span', { class: 'chip' }, m.nickname || m.name)) : h('span', { class: 'tiny muted' }, 'Nessun membro: assegnali qui sotto')),
        pr.pts.length || pr.gifts.length ? h('ul', { class: 'squad-items' },
          pr.pts.map((p) => { const todo = p.lat == null || p.moveRequestedAt; return h('li', { class: todo ? '' : 'done' }, todo ? '○ ' : '✓ ', p.label, p.moveRequestedAt ? ' (da spostare)' : '', p.targetLat != null && todo ? ' ⌖' : ''); }),
          pr.gifts.map((g) => { const todo = g.status === 'draft' || g.moveRequestedAt; return h('li', { class: todo ? '' : 'done' }, todo ? '○ ' : '✓ ', `${g.label} · ${g.icon} ${g.name}`, g.moveRequestedAt ? ' (da spostare)' : '', g.targetLat != null && todo ? ' ⌖' : ''); })) : null,
        sq.tasks.length ? h('ul', { class: 'squad-tasks' }, sq.tasks.map((t) => taskLine(t))) : null,
        h('form', { class: 'stack-sm', onsubmit: async (e) => {
          e.preventDefault();
          if (!taskIn.value.trim() && !taskTarget.value) return;
          if (await squadCall('POST', G('/tasks'), { squadId: sq.id, text: taskIn.value, target: taskTarget.value || null }, `Incarico inviato a ${sq.name}`)) { taskIn.value = ''; taskTarget.value = ''; }
        } }, taskIn, h('div', { class: 'row-actions' }, taskTarget, h('button', { class: 'btn btn-sm btn-primary', type: 'submit' }, 'Invia'))));
    })) : h('p', { class: 'empty' }, 'Nessuna squadra: crea la prima con «+ Nuova squadra».')),


    sectionActions(`Eletti del Consiglio (${members.length})`, [
      h('button', { class: 'btn btn-sm btn-primary', onclick: newElectDialog }, '+ Aggiungi Eletto'),
      members.length ? h('span', { class: 'chip' }, `${ms.elect.online} online · ${ms.elect.pushDevices} con notifiche`) : null,
      h('a', { class: 'btn btn-sm', href: `/regia/stampa/credenziali/${R.gameId}`, target: '_blank' }, 'Stampa accessi')],
      h('p', { class: 'muted tiny' }, 'Ogni Eletto entra con il proprio accesso personale (QR o codice): vede la sua squadra, i suoi incarichi e i messaggi della sua squadra. Non hanno Sigillo, non usano gli Altari e non sono in classifica.'),
      members.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'elect-table' },
        h('thead', null, h('tr', null, ['Eletto', 'Team softair', 'Squadra', 'Notifiche', 'Accesso personale', ''].map((x) => h('th', null, x)))),
        h('tbody', null, members.map((m) => {
          const p = byId[m.id] || m;
          const loginUrl = `${R.baseUrl}/login/${p.loginToken}`;
          return h('tr', null,
            h('td', null, personLine(m), m.phone ? h('div', null, phoneLinks(m.phone)) : null),
            h('td', null, m.softairTeam || h('span', { class: 'muted' }, '—')),
            h('td', null, d.squads.length ? h('select', { class: 'input input-sm', 'aria-label': `Squadra di ${m.name}`, onchange: (e) => squadCall('POST', `/api/m/players/${m.id}/squad`, { squadId: Number(e.target.value) || null }, Number(e.target.value) ? 'Eletto assegnato' : 'Tolto dalla squadra') }, squadOptions(m.squadId))
              : h('span', { class: 'tiny muted' }, 'crea una squadra')),
            h('td', null, m.pushDevices ? h('span', { class: 'chip chip-ok' }, `attive (${m.pushDevices})`) : h('span', { class: 'chip chip-warn', title: 'Deve aprire l\'app e premere "Attiva le notifiche"' }, 'non attive')),
            h('td', null, h('div', { class: 'elect-access' },
              p.loginToken ? h('img', { src: `/api/m/qr.svg?text=${encodeURIComponent(loginUrl)}`, alt: `QR di accesso di ${m.name}`, width: 84, height: 84, loading: 'lazy' }) : null,
              h('div', null, h('div', { class: 'mono access' }, p.accessCode || '—'),
                h('div', { class: 'row-actions' },
                  h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { navigator.clipboard?.writeText(loginUrl); toast('Link di accesso copiato', 'ok'); } }, 'Copia link'),
                  ms.game.isDemo ? h('a', { class: 'btn btn-sm', href: loginUrl, target: '_blank', title: 'Questo browser diventa questo Eletto' }, 'Apri app') : null)))),
            h('td', { class: 'row-actions' }, resetBtn(m), ms.game.status !== 'ended' ? h('button', { class: 'btn btn-sm', title: 'Sposta in una coppia, da solo o in scambio', onclick: () => moveToCoupleDialog(m) }, '↔ Settore…') : null, h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Togliere dagli Eletti?', `${m.name} torna tra i giocatori senza coppia.`, 'DELETE', `/api/m/elect/members/${m.id}`, undefined, 'Tolto dagli Eletti') }, 'Togli')));
        })))) : h('p', { class: 'empty' }, candidates.length ? 'Nessun Eletto: accetta le candidature qui sopra o aggiungili con «+ Aggiungi Eletto».' : 'Nessun Eletto: aggiungili con «+ Aggiungi Eletto».')),

    section('Chi piazza cosa',
      h('p', { class: 'muted tiny' }, 'Assegna Altari e Doni alle squadre, con un punto preciso sulla mappa o lasciandoli liberi. Per i punti già piazzati puoi chiedere uno spostamento.'),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Punto', 'Stato e incarico', ''].map((x) => h('th', null, x)))),
        h('tbody', null,
          (d.landmarks || []).map((l) => h('tr', null, h('td', null, h('strong', null, l.label)), h('td', null, placementChips(l, l.lat != null)), h('td', { class: 'row-actions' }, ...placementButtons('landmark', l, l.lat != null)))),
          d.points.map((p) => h('tr', null, h('td', null, h('strong', null, p.label)), h('td', null, placementChips(p, p.lat != null)), h('td', { class: 'row-actions' }, ...placementButtons('point', p, p.lat != null)))),
          d.gifts.filter((g) => !['claimed', 'expired'].includes(g.status)).map((g) => h('tr', null,
            h('td', null, h('strong', null, g.label), h('span', { class: 'tiny muted' }, ` ${g.icon} ${g.name}`)),
            h('td', null, placementChips(g, g.status !== 'draft')),
            h('td', { class: 'row-actions' }, ...placementButtons('gift', g, g.status !== 'draft')))))))));
}

// ---------------------------------------------------------------- TIMELINE DEL TORNEO

// Conversione tra minuti dal via e orari reali. Partita iniziata: si parte da adesso; non iniziata: dall'inizio previsto.
function timeBase() {
  const ms = R.ms;
  const c = clock.snap;
  const now = clock.serverNow();
  if (c?.startedAt) {
    const el = clock.elapsed() / 60000;
    return { known: true, started: true, nowMin: el, toWall: (m) => now + (m - el) * 60000, toMin: (ts) => el + (ts - now) / 60000 };
  }
  const start = ms.game.scheduledStart ? new Date(ms.game.scheduledStart).getTime() : null;
  if (start) return { known: true, started: false, nowMin: (now - start) / 60000, toWall: (m) => start + m * 60000, toMin: (ts) => (ts - start) / 60000 };
  return { known: false, started: false, nowMin: null, toWall: () => null, toMin: () => null };
}

// Tutti gli avvenimenti del torneo, in minuti dal via: punti (at) e finestre (at → to).
function timelineEvents(exclude = null) {
  const ms = R.ms;
  const g = ms.game;
  const tb = timeBase();
  const ev = [
    { at: 0, label: 'VIA', kind: 'phase' },
    { at: g.truceMin, label: 'Fine tregua: si apre la caccia', kind: 'phase' },
    { at: g.durationMin - 30, label: 'Ultima mezz\'ora', kind: 'phase' },
    { at: g.durationMin, label: 'Fine dei Giochi', kind: 'phase' },
  ];
  for (const r of ms.revelations) {
    if (r.status === 'skipped') continue;
    const at = r.firedAt ? tb.toMin(r.firedAt) : r.scheduledMin;
    if (at != null) ev.push({ at, label: `Tradimento: ${r.sectorName}${r.firedAt ? ' (fatto)' : ''}`, kind: 'revelation', done: !!r.firedAt, ref: { type: 'revelation', id: r.id } });
  }
  for (const s of ms.supply) {
    if (exclude?.kind === 'supply' && exclude.id === s.id) continue;
    const at = s.firedAt ? tb.toMin(s.firedAt) : s.scheduledMin ?? (s.scheduledAt ? tb.toMin(s.scheduledAt) : null);
    if (at == null) continue;
    let end = s.closedAt ? tb.toMin(s.closedAt) : s.closesAt ? tb.toMin(s.closesAt) : s.durationMin ? at + s.durationMin : null;
    // Aperta senza durata (fino a chiusura): la barra va dall'apertura ad adesso e cresce col tempo.
    const open = end == null && s.status === 'fired' && tb.nowMin != null;
    if (open) end = Math.max(tb.nowMin, at);
    ev.push({ at, to: end, open, label: `Armamenti${s.description ? `: ${s.description}` : ''}${s.status === 'closed' ? ' (chiusa)' : open ? ' (aperta fino a chiusura)' : s.status === 'fired' ? ' (aperta)' : !end ? ' (fino a chiusura)' : ''}`, kind: 'supply', done: s.status === 'closed', ref: { type: 'supply', id: s.id } });
  }
  for (const gf of fieldData?.gifts || []) {
    if (exclude?.kind === 'gift' && exclude.id === gf.id) continue;
    const at = gf.revealedAt ? tb.toMin(gf.revealedAt) : gf.revealMode === 'at' && gf.revealAt ? tb.toMin(gf.revealAt) : gf.revealMode === 'time' ? gf.revealAtMin : null;
    if (at == null) continue;
    const end = gf.expiresAfterMin ? at + gf.expiresAfterMin : null;
    ev.push({ at, to: end, label: `Dono ${gf.label} (${gf.name})${gf.status === 'claimed' ? ' · preso' : gf.status === 'expired' ? ' · svanito' : gf.revealedAt ? ' · in mappa' : ''}`, kind: 'gift', done: ['claimed', 'expired'].includes(gf.status), ref: { type: 'gift', id: gf.id } });
  }
  // Uscite dalla Soglia: ogni coppia che si presenta con la Parola, con l'esito della validazione.
  for (const v of ms.validations || []) {
    const t = ms.teams.find((x) => x.id === v.teamId);
    const miss = v.missing ? JSON.parse(v.missing) : [];
    const what = v.result === 'valid' ? `Parola valida${t?.finishPosition ? ` · ${t.finishPosition}° posto` : ''}`
      : `respinta: ${v.result === 'wrong' ? 'Parola errata' : 'Parola incompleta'}${miss.length ? ` (${miss.map((m) => `#${m.position}${m.status === 'wrong' ? ' ✗' : ''}`).join(', ')})` : ''}`;
    ev.push({ at: tb.toMin(v.at), label: `Soglia: ${t ? teamLabel(t) : 'coppia'} — ${what}`, kind: `soglia tl-soglia-${v.result === 'valid' ? 'ok' : 'ko'}`, done: true, ref: { type: 'validation', id: v.id } });
  }
  // Scontri (ingaggi) registrati dalle coppie, con l'esito.
  for (const e of ms.combat?.timeline || []) {
    if (!e.createdAt) continue;
    ev.push({ at: tb.toMin(e.createdAt), label: `Scontro: ${engagementText(e)}`, kind: `engagement tl-eng-${e.status}`, done: e.status !== 'pending' && e.status !== 'contested', ref: { type: 'engagement', id: e.id } });
  }
  return ev.filter((e) => Number.isFinite(e.at)).sort((a, b) => a.at - b.at);
}

const sideNames = (side) => side.map((t) => t.sectorName).join(' + ');
function engagementText(e) {
  const what = e.result === 'draw' ? `pareggio ${sideNames(e.winners)} – ${sideNames(e.losers)}` : `${sideNames(e.winners)} batte ${sideNames(e.losers)}`;
  const state = { pending: ' (da confermare)', contested: ' (contestato)', cancelled: ' (annullato)' }[e.status] || '';
  const stolen = (e.steals || []).map((x) => (x.chosen ? `${x.team.sectorName} ruba ${x.sectorName}` : `${x.team.sectorName} deve scegliere il furto`));
  return `${what}${state}${stolen.length ? ` · ${stolen.join(' · ')}` : ''}`;
}

// Una riga fissa per tipo di avvenimento: l'altezza sulla timeline dice cos'è.
const TL_LANES = ['phase', 'revelation', 'supply', 'gift', 'engagement', 'soglia'];
const laneOf = (e) => Math.max(0, TL_LANES.indexOf(String(e.kind).split(' ')[0]));

const fmtClockMin = (m) => `${m < 0 ? '−' : ''}${fmtMin(Math.abs(m))}`;

/**
 * Finestra "quando (e per quanto)": timeline del torneo con tutti gli avvenimenti; il momento si sceglie
 * toccando la timeline, oppure Ora / Tra X minuti / Alle HH:MM / Al minuto M dal via.
 * Restituisce { mode: 'now' } | { mode: 'min', min } | { mode: 'at', at } più durationMin (se richiesto), o null.
 */
async function timelineModal({ title, intro, okLabel = 'Conferma', withDuration = false, durationLabel = 'Per quanti minuti', defaultDuration = 15, allowDurationEmpty = true, nowLabel = 'Ora', exclude = null, initial = null, extra = null }) {
  const g = R.ms.game;
  const tb = timeBase();
  const events = timelineEvents(exclude);
  const span = Math.max(g.durationMin, ...events.map((e) => e.to ?? e.at)) + 5;
  const lo = Math.min(-5, tb.nowMin != null && tb.nowMin < 0 ? Math.max(tb.nowMin, -120) : -5);
  const pct = (m) => `${((Math.min(Math.max(m, lo), span) - lo) / (span - lo)) * 100}%`;
  const soon = new Date(Date.now() + 15 * 60000);

  const radios = ['now', 'in', 'at', 'min'].map((v) => h('input', { type: 'radio', name: 'tl-when', value: v }));
  const minutes = h('input', { class: 'input input-sm w-90', type: 'number', min: 1, max: 600, value: 10, 'aria-label': 'Tra quanti minuti' });
  const time = h('input', { class: 'input input-sm w-120', type: 'time', value: `${pad2(soon.getHours())}:${pad2(soon.getMinutes())}`, 'aria-label': 'Orario' });
  const minAt = h('input', { class: 'input input-sm w-90', type: 'number', min: 0, max: g.durationMin, step: 1, value: Math.max(0, Math.round(tb.nowMin ?? 0) + 15), 'aria-label': 'Minuto dal via' });
  const dur = withDuration ? h('input', { class: 'input input-sm w-90', type: 'number', min: 1, max: 600, step: 1, value: defaultDuration ?? '', placeholder: allowDurationEmpty ? 'nessuna' : '' }) : null;
  const sel = h('div', { class: 'tl-sel', hidden: true });
  const selLabel = h('p', { class: 'tl-sel-label mono' });
  const tip = h('div', { class: 'tl-tip', hidden: true });

  // Minuto dal via della scelta attuale (null = non rappresentabile).
  const chosenMin = () => {
    const m = radios.find((r) => r.checked)?.value;
    if (m === 'now') return tb.nowMin ?? 0;
    if (m === 'in') return tb.nowMin != null ? tb.nowMin + Number(minutes.value || 0) : null;
    if (m === 'min') return Number(minAt.value);
    if (m === 'at') {
      const [hh, mm] = time.value.split(':').map(Number);
      const d = new Date(); d.setHours(hh, mm, 0, 0);
      return tb.toMin(d.getTime() + clock.offset);
    }
    return null;
  };
  const update = () => {
    const m = chosenMin();
    const d = withDuration ? Number(dur.value) || 0 : 0;
    if (m == null || !Number.isFinite(m)) { sel.hidden = true; selLabel.textContent = tb.known ? '' : 'Partita senza orario di inizio: la timeline è in minuti dal via.'; return; }
    sel.hidden = false;
    sel.style.left = pct(m);
    sel.style.width = d ? `calc(${pct(m + d)} - ${pct(m)})` : '0';
    sel.classList.toggle('tl-point', !d);
    const wall = tb.toWall(m);
    selLabel.textContent = `Scelto: ${fmtClockMin(m)} dal via${wall ? ` · alle ${fmtTime(wall)}` : ''}${d ? ` → fino a ${fmtClockMin(m + d)}${wall ? ` (${fmtTime(tb.toWall(m + d))})` : ''}` : ''}`;
  };
  for (const r of radios) r.addEventListener('change', update);
  [[minutes, 1], [time, 2], [minAt, 3]].forEach(([el, i]) => { el.addEventListener('focus', () => { radios[i].checked = true; update(); }); el.addEventListener('input', update); });
  dur?.addEventListener('input', update);

  // Riga della timeline: tacche ogni 15′, fasi, avvenimenti (punti o finestre), adesso.
  const track = h('div', { class: 'tl-track', title: 'Tocca per scegliere il minuto' },
    Array.from({ length: Math.floor(span / 15) + 1 }, (_, i) => i * 15).map((m) => h('span', { class: `tl-tick ${m % 60 ? '' : 'tl-hour'}`, style: { left: pct(m) } }, h('i', null, fmtMin(m)))),
    h('div', { class: 'tl-game', style: { left: pct(0), width: `calc(${pct(g.durationMin)} - ${pct(0)})` } }),
    h('div', { class: 'tl-truce', style: { left: pct(0), width: `calc(${pct(g.truceMin)} - ${pct(0)})` } }),
    h('div', { class: 'tl-last', style: { left: pct(g.durationMin - 30), width: `calc(${pct(g.durationMin)} - ${pct(g.durationMin - 30)})` } }),
    events.map((e, i) => h('span', {
      class: `tl-ev tl-${e.kind} ${e.to != null ? 'tl-range' : ''} ${e.done ? 'tl-done' : ''}`,
      style: { left: pct(e.at), width: e.to != null ? `calc(${pct(e.to)} - ${pct(e.at)})` : null, top: `${18 + laneOf(e) * 9}px` },
      title: `${fmtClockMin(e.at)} · ${e.label}`,
    })),
    tb.nowMin != null ? h('span', { class: 'tl-now', style: { left: pct(tb.nowMin) } }, h('i', null, 'adesso')) : null,
    sel, tip);
  setPastCuts(track, tb.nowMin);
  track.addEventListener('click', (e) => {
    const r = track.getBoundingClientRect();
    const m = Math.round(lo + ((e.clientX - r.left) / r.width) * (span - lo));
    minAt.value = Math.max(0, m);
    radios[3].checked = true;
    update();
  });

  const list = h('ol', { class: 'tl-list' }, events.map((e) => h('li', { class: `tl-row tl-${e.kind} ${e.done ? 'tl-done' : ''} ${tb.nowMin != null && e.at < tb.nowMin ? 'past' : ''}` },
    h('span', { class: 'mono' }, fmtClockMin(e.at), e.to != null ? `–${fmtClockMin(e.to)}` : ''),
    h('span', { class: 'mono muted' }, tb.toWall(e.at) ? fmtTime(tb.toWall(e.at)) : ''),
    h('span', null, e.label))));

  if (initial?.mode === 'min') { radios[3].checked = true; minAt.value = Math.round(initial.min); }
  else if (initial?.mode === 'at' && initial.at) { radios[2].checked = true; const d = new Date(initial.at - clock.offset); time.value = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
  else radios[0].checked = true;

  const result = await modal({
    title, okLabel, wide: true,
    onOpen: () => update(),
    body: h('div', { class: 'stack-sm timeline-modal' },
      intro ? h('p', { class: 'muted tiny' }, intro) : null,
      extra,
      h('div', { class: 'tl-legend tiny' },
        h('span', null, h('i', { class: 'tl-key tl-truce-k' }), 'tregua'), h('span', null, h('i', { class: 'tl-key tl-last-k' }), 'ultima mezz\'ora'),
        h('span', null, h('i', { class: 'tl-key tl-revelation' }), 'tradimenti'), h('span', null, h('i', { class: 'tl-key tl-supply' }), 'armamenti'),
        h('span', null, h('i', { class: 'tl-key tl-gift' }), 'doni'), h('span', null, h('i', { class: 'tl-key tl-sel-k' }), 'la tua scelta')),
      track, selLabel,
      h('div', { class: 'tl-choices' },
        h('label', { class: 'radio-line' }, radios[0], ` ${nowLabel}`),
        h('label', { class: 'radio-line' }, radios[1], ' Tra ', minutes, ' minuti'),
        h('label', { class: 'radio-line' }, radios[2], ' Alle ', time),
        h('label', { class: 'radio-line' }, radios[3], ' Al minuto ', minAt, ' dal via')),
      withDuration ? h('label', { class: 'radio-line' }, `${durationLabel}: `, dur, allowDurationEmpty ? h('span', { class: 'tiny muted' }, ' (vuoto = nessun limite)') : null) : null,
      h('details', { class: 'tl-details' }, h('summary', null, `Tutti gli avvenimenti (${events.length})`), list)),
    onOk: () => {
      const mode = radios.find((r) => r.checked).value;
      const out = {};
      if (withDuration) {
        const d = dur.value === '' ? null : Number(dur.value);
        if (d != null && !(d > 0)) { toast('Durata non valida', 'error'); return false; }
        if (d == null && !allowDurationEmpty) { toast('Indica la durata', 'error'); return false; }
        out.durationMin = d;
      }
      if (mode === 'now') return { ...out, mode: 'now' };
      if (mode === 'min') {
        const m = Number(minAt.value);
        if (!(m >= 0)) { toast('Minuto non valido', 'error'); return false; }
        return { ...out, mode: 'min', min: m };
      }
      if (mode === 'in') {
        const m = Number(minutes.value);
        if (!(m > 0)) { toast('Indica i minuti', 'error'); return false; }
        return { ...out, mode: 'at', at: clock.serverNow() + m * 60000 };
      }
      const [hh, mm] = time.value.split(':').map(Number);
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) { toast('Indica l\'orario', 'error'); return false; }
      const d = new Date(); d.setHours(hh, mm, 0, 0);
      if (d.getTime() < Date.now() - 60000) { toast('Quell\'orario è già passato', 'error'); return false; }
      return { ...out, mode: 'at', at: d.getTime() + clock.offset };
    },
  });
  return result || null;
}

// ---------------------------------------------------------------- TIMELINE IN REGIA (avanza in tempo reale)

// Scala della timeline: dal via (qualche minuto prima) alla fine dei Giochi.
function timelineScale(events) {
  const g = R.ms.game;
  const tb = timeBase();
  const span = Math.max(g.durationMin, ...events.map((e) => e.to ?? e.at)) + 5;
  const lo = Math.min(-5, tb.nowMin != null && tb.nowMin < 0 ? Math.max(tb.nowMin, -120) : -5);
  return { lo, span, pct: (m) => `${((Math.min(Math.max(m, lo), span) - lo) / (span - lo)) * 100}%` };
}

function liveTimeline() {
  const g = R.ms.game;
  const events = timelineEvents();
  const { lo, span, pct } = timelineScale(events);
  const tb = timeBase();
  const track = h('div', { class: 'tl-track tl-live', title: 'Clicca un punto vuoto per programmare qualcosa in quel momento', 'data-lo': lo, 'data-span': span },
    Array.from({ length: Math.floor(span / 15) + 1 }, (_, i) => i * 15).map((m) => h('span', { class: `tl-tick ${m % 60 ? '' : 'tl-hour'}`, style: { left: pct(m) } }, h('i', null, fmtMin(m)))),
    h('div', { class: 'tl-game', style: { left: pct(0), width: `calc(${pct(g.durationMin)} - ${pct(0)})` } }),
    h('div', { class: 'tl-truce', style: { left: pct(0), width: `calc(${pct(g.truceMin)} - ${pct(0)})` } }),
    h('div', { class: 'tl-last', style: { left: pct(g.durationMin - 30), width: `calc(${pct(g.durationMin)} - ${pct(g.durationMin - 30)})` } }),
    h('div', { class: 'tl-past', id: 'tl-live-past', style: { left: pct(lo), width: tb.nowMin != null ? `calc(${pct(tb.nowMin)} - ${pct(lo)})` : '0' } }),
    events.map((e, i) => h('button', {
      type: 'button',
      class: `tl-ev tl-${e.kind} ${e.to != null ? 'tl-range' : ''} ${e.open ? 'tl-open' : ''} ${e.done ? 'tl-done' : ''}`,
      'data-at': e.at, 'data-to': e.to ?? '',
      style: { left: pct(e.at), width: e.to != null ? `calc(${pct(e.to)} - ${pct(e.at)})` : null, top: `${16 + laneOf(e) * 14}px` },
      title: `${fmtClockMin(e.at)} · ${e.label}`,
      'aria-label': `${fmtClockMin(e.at)} ${e.label}`,
      onclick: (ev) => { ev.stopPropagation(); eventDialog(e); },
    })),
    h('span', { class: 'tl-now', id: 'tl-live-now', style: { left: pct(tb.nowMin ?? 0), display: tb.nowMin == null ? 'none' : null } }, h('i', { id: 'tl-live-now-label' }, 'adesso')));
  track.addEventListener('click', (e) => {
    const r = track.getBoundingClientRect();
    const m = Math.max(0, Math.round(lo + ((e.clientX - r.left) / r.width) * (span - lo)));
    planDialog(m);
  });
  const nextEv = tb.nowMin != null ? events.find((e) => e.at > tb.nowMin && !e.done) : null;
  return sectionActions('Timeline del torneo', [
    h('button', { class: 'btn btn-sm', onclick: () => planDialog(Math.max(0, Math.round((tb.nowMin ?? 0) + 15))) }, '+ Programma'),
    h('button', { class: 'btn btn-sm btn-ghost', onclick: () => timelineModal({ title: 'Timeline del torneo', intro: 'Tutti gli avvenimenti programmati e passati.', okLabel: 'Chiudi' }) }, 'Elenco')],
    h('div', { class: 'tl-legend tiny' },
      h('span', null, h('i', { class: 'tl-key tl-truce-k' }), 'tregua'), h('span', null, h('i', { class: 'tl-key tl-last-k' }), 'ultima mezz\'ora'),
      h('span', null, h('i', { class: 'tl-key tl-revelation' }), 'tradimenti'), h('span', null, h('i', { class: 'tl-key tl-supply' }), 'armamenti'),
      h('span', null, h('i', { class: 'tl-key tl-gift' }), 'doni'), h('span', null, h('i', { class: 'tl-key tl-engagement' }), 'scontri'), h('span', null, h('i', { class: 'tl-key tl-soglia tl-soglia-ok' }), 'Soglia'), h('span', null, h('i', { class: 'tl-key tl-now-k' }), 'adesso')),
    track,
    h('p', { class: 'tiny muted' }, tb.known ? '' : 'La partita non ha un orario di inizio: la timeline è in minuti dal via. ',
      nextEv ? ['Prossimo: ', h('strong', null, nextEv.label), ` a ${fmtClockMin(nextEv.at)}`, tb.toWall(nextEv.at) ? ` (alle ${fmtTime(tb.toWall(nextEv.at))})` : ''] : 'Clicca un punto vuoto per programmare armamenti o l\'annuncio di un dono; clicca un avvenimento per spostarlo o farlo partire.'));
}

// Barre (armamenti, doni): la parte già trascorsa diventa semitrasparente, il resto della finestra resta pieno.
function setPastCuts(track, nowMin) {
  for (const el of track.querySelectorAll('.tl-range')) {
    const at = Number(el.dataset.at);
    const to = el.dataset.to === '' ? NaN : Number(el.dataset.to);
    const cut = nowMin == null || !Number.isFinite(to) ? 0 : to <= at ? (nowMin >= at ? 100 : 0) : Math.min(100, Math.max(0, ((nowMin - at) / (to - at)) * 100));
    el.style.setProperty('--cut', `${cut}%`);
  }
}

// Ogni secondo: l'indicatore "adesso" e la parte già trascorsa avanzano.
function tickTimeline() {
  const track = document.querySelector('.tl-live');
  const now = document.getElementById('tl-live-now');
  if (!track || !now || !R.ms) return;
  const tb = timeBase();
  if (tb.nowMin == null) return;
  const lo = Number(track.dataset.lo);
  const span = Number(track.dataset.span);
  const p = ((Math.min(Math.max(tb.nowMin, lo), span) - lo) / (span - lo)) * 100;
  now.style.left = `${p}%`;
  const past = document.getElementById('tl-live-past');
  if (past) past.style.width = `${p}%`;
  const label = document.getElementById('tl-live-now-label');
  if (label) label.textContent = `adesso · ${fmtClockMin(tb.nowMin)}`;
  // Finestre aperte fino a chiusura: la barra arriva sempre ad adesso.
  for (const el of track.querySelectorAll('.tl-open')) {
    const at = Number(el.dataset.at);
    const pa = ((Math.min(Math.max(at, lo), span) - lo) / (span - lo)) * 100;
    el.style.width = `${Math.max(p - pa, 0)}%`;
    el.dataset.to = tb.nowMin;
  }
  setPastCuts(track, tb.nowMin);
}

// Punto vuoto della timeline: cosa programmare in quel momento.
async function planDialog(min) {
  const tb = timeBase();
  const gifts = (fieldData?.gifts || []).filter((g) => ['draft', 'placed'].includes(g.status));
  const opts = [
    ['supply', 'Una finestra armamenti', 'apertura in quel momento, poi scegli la durata'],
    ...(gifts.length ? [['gift', 'L\'annuncio di un dono', 'il dono compare sulle mappe delle coppie']] : []),
  ];
  const radios = opts.map(([v], i) => h('input', { type: 'radio', name: 'plan', value: v, checked: i === 0 }));
  const giftSel = gifts.length ? h('select', { class: 'input', 'aria-label': 'Dono' }, gifts.map((g) => h('option', { value: g.id }, `${g.label} · ${g.icon} ${g.name}${g.status === 'draft' ? ' (non ancora piazzato)' : ''}`))) : null;
  const wall = tb.toWall(min);
  const choice = await modal({
    title: `Al minuto ${fmtMin(min)} dal via${wall ? ` · alle ${fmtTime(wall)}` : ''}`,
    okLabel: 'Avanti',
    body: h('div', { class: 'stack-sm' },
      h('p', { class: 'muted tiny' }, 'Cosa vuoi programmare in questo momento? Nel passo successivo puoi ancora ritoccare l\'orario sulla timeline.'),
      opts.map(([v, label, sub], i) => h('label', { class: 'radio-line plan-opt' }, radios[i], h('span', null, h('strong', null, label), h('span', { class: 'tiny muted' }, ` · ${sub}`)))),
      giftSel ? h('label', { class: 'field' }, h('span', null, 'Quale dono'), giftSel) : h('p', { class: 'tiny muted' }, 'Per annunciare un dono, crealo prima in Doni QR.')),
    onOk: () => ({ kind: radios.find((r) => r.checked).value, giftId: giftSel ? Number(giftSel.value) : null }),
  });
  if (!choice) return;
  const preset = { mode: 'min', min };
  if (choice.kind === 'supply') return supplyDialog(null, preset);
  const g = gifts.find((x) => x.id === choice.giftId);
  if (g) return scheduleGiftDialog(g, preset);
}

// Avvenimento sulla timeline: cosa è e cosa se ne può fare.
async function eventDialog(e) {
  const ms = R.ms;
  if (e.ref?.type === 'validation') {
    const v = (ms.validations || []).find((y) => y.id === e.ref.id);
    if (!v) return;
    return modal({ title: e.label, okLabel: 'Chiudi', body: h('div', { class: 'stack-sm' },
      h('p', null, `Alle ${fmtTime(v.at, true)} (${fmtClockMin(e.at)} dal via), validatore ${v.username || '—'}.`),
      v.notes ? h('p', { class: 'muted' }, `Note: ${v.notes}`) : null) });
  }
  if (e.ref?.type === 'engagement') {
    const x = (ms.combat?.timeline || []).find((y) => y.id === e.ref.id);
    if (!x) return;
    const by = `Registrato da ${x.reporter?.sectorName || '—'} alle ${fmtTime(x.createdAt)} (${fmtClockMin(e.at)} dal via)${x.resolvedAt ? `, chiuso alle ${fmtTime(x.resolvedAt)}` : ''}.`;
    if (['pending', 'contested'].includes(x.status)) {
      const act = await actionDialog(e.label, by, [['confirm', 'Conferma l\'esito'], ['cancel', 'Annulla lo scontro']]);
      if (act) call('POST', `/api/m/engagements/${x.id}/resolve`, { decision: act }, act === 'confirm' ? 'Esito confermato' : 'Scontro annullato');
      return;
    }
    return modal({ title: e.label, okLabel: 'Chiudi', body: h('p', null, by) });
  }
  const active = ACTIVE.includes(ms.clock.status);
  const pre = PRE.includes(ms.clock.status);
  if (e.ref?.type === 'gift') {
    const g = fieldData?.gifts.find((x) => x.id === e.ref.id);
    if (g && ['draft', 'placed'].includes(g.status)) return scheduleGiftDialog(g);
    return modal({ title: e.label, okLabel: 'Chiudi', cancelLabel: 'Doni QR', body: h('p', null, `${fmtClockMin(e.at)} dal via.`) }).then((r) => { if (r === null) location.hash = 'doniqr'; });
  }
  if (e.ref?.type === 'supply') {
    const s = ms.supply.find((x) => x.id === e.ref.id);
    if (!s) return;
    if (s.status === 'scheduled') {
      const act = await actionDialog(e.label, `${supplyWhen(s)}${s.durationMin ? ` · per ${s.durationMin}′` : ''}`, [
        ['move', 'Modifica (orario, durata, contenuto)…'], active ? ['fire', 'Apri adesso'] : null, ['early', '−5′ (anticipa)'], ['late', '+5′ (posticipa)'], ['delete', 'Elimina'],
      ]);
      if (act === 'move') return supplyDialog(s);
      if (act === 'fire') return call('POST', `/api/m/supply/${s.id}/fire`, {}, 'Armamenti aperti');
      if (act === 'early') return call('POST', `/api/m/supply/${s.id}/shift`, { minutes: -5 }, 'Anticipata di 5 minuti');
      if (act === 'late') return call('POST', `/api/m/supply/${s.id}/shift`, { minutes: 5 }, 'Posticipata di 5 minuti');
      if (act === 'delete') return confirmCall('Eliminare la finestra?', '', 'DELETE', `/api/m/supply/${s.id}`, undefined, 'Eliminata', true);
      return;
    }
    if (s.status === 'fired') {
      const act = await actionDialog(e.label, s.closesAt ? `La finestra è aperta, si chiude alle ${fmtTime(s.closesAt)}.` : 'La finestra è aperta fino a chiusura.', [
        s.closesAt ? ['shorter', '−5′ (accorcia)'] : null, s.closesAt ? ['longer', '+5′ (prolunga)'] : ['in15', 'Chiudi tra 15′'], ['edit', 'Modifica…'], ['close', 'Chiudi adesso']]);
      if (act === 'shorter') return call('POST', `/api/m/supply/${s.id}/shift`, { minutes: -5 }, 'Accorciata di 5 minuti');
      if (act === 'longer') return call('POST', `/api/m/supply/${s.id}/shift`, { minutes: 5 }, 'Prolungata di 5 minuti');
      if (act === 'in15') return call('POST', `/api/m/supply/${s.id}/shift`, { minutes: 15 }, 'Si chiude tra 15 minuti');
      if (act === 'edit') return supplyEditDialog(s);
      if (act === 'close') return confirmCall('Chiudere la finestra?', 'Parte l\'annuncio di chiusura a tutte le coppie.', 'POST', `/api/m/supply/${s.id}/close`, {}, 'Finestra chiusa', true);
      return;
    }
    const act = await actionDialog(e.label, 'Finestra già conclusa.', [['edit', 'Modifica il contenuto…']]);
    if (act === 'edit') return supplyEditDialog(s);
  }
  if (e.ref?.type === 'revelation') {
    const r = ms.revelations.find((x) => x.id === e.ref.id);
    if (!r || r.status !== 'scheduled') return actionDialog(e.label, 'Tradimento già avvenuto o saltato.', []);
    const act = await actionDialog(`Tradimento: Settore ${r.sectorName}`, `In calendario a ${fmtMin(r.scheduledMin)} dal via.`, [
      active ? ['reveal', 'Rivela adesso'] : null, !pre ? ['early', '−5′ (anticipa)'] : null, !pre ? ['late', '+5′ (posticipa)'] : null, pre ? ['edit', 'Modifica in Sigilli e tradimenti'] : null, ['skip', 'Salta'],
    ]);
    if (act === 'reveal') return confirmCall('Rivelare adesso?', `Il Sigillo del Settore ${r.sectorName} sarà annunciato a tutte le coppie.`, 'POST', `/api/m/revelations/${r.id}/reveal`, {}, 'Sigillo rivelato');
    if (act === 'early') return call('POST', `/api/m/revelations/${r.id}/postpone`, { minutes: -5 }, 'Anticipata di 5 minuti');
    if (act === 'late') return call('POST', `/api/m/revelations/${r.id}/postpone`, { minutes: 5 }, 'Posticipata di 5 minuti');
    if (act === 'edit') { location.hash = 'sigilli'; return; }
    if (act === 'skip') return confirmCall('Saltare questa rivelazione?', 'Il Settore uscirà dal calendario.', 'POST', `/api/m/revelations/${r.id}/skip`, {}, 'Rivelazione saltata');
    return;
  }
  return actionDialog(e.label, `${fmtClockMin(e.at)} dal via.`, []);
}

// Piccola finestra con un elenco di azioni: restituisce la chiave scelta (o null).
function actionDialog(title, text, actions) {
  return new Promise((resolve) => {
    let picked = null;
    const list = actions.filter(Boolean);
    modal({
      title, okLabel: 'Chiudi', cancelLabel: list.length ? 'Annulla' : 'Chiudi',
      body: h('div', { class: 'stack-sm' }, text ? h('p', null, text) : null,
        list.length ? h('div', { class: 'action-list' }, list.map(([k, label]) => h('button', { type: 'button', class: `btn ${k === 'delete' || k === 'skip' || k === 'close' ? 'btn-ghost' : ''}`, onclick: (ev) => { picked = k; ev.target.closest('dialog').querySelector('.btn-primary').click(); } }, label))) : null),
    }).then(() => resolve(picked));
  });
}

// ---------------------------------------------------------------- SKILL E DONI: testi e tempi della partita

let catalogData = null;
async function loadCatalog() {
  try { catalogData = { gameId: R.gameId, status: R.ms?.clock.status, ...(await api('GET', G('/catalog'))) }; } catch (e) { toast(e.message, 'error'); }
  render();
}
const SKILL_TYPE = { active: 'Attiva', ultimate: 'Ultimate', passive: 'Passiva' };

async function editCatalogDialog(x) {
  const name = h('input', { class: 'input', maxlength: 40, value: x.current.name });
  const desc = h('textarea', { class: 'input', rows: 4, maxlength: 400 });
  desc.value = x.current.description || '';
  const dur = x.base.durationMin != null && !x.durationFromParams ? h('input', { class: 'input', type: 'number', min: 1, step: 1, value: x.current.durationMin }) : null;
  const cd = x.base.cooldownMin != null ? h('input', { class: 'input', type: 'number', min: 1, step: 1, value: x.current.cooldownMin }) : null;
  const save = (body, msg) => api('PUT', G(`/catalog/${x.kind}/${x.id}`), body).then((c) => { catalogData = { gameId: R.gameId, status: R.ms?.clock.status, ...c }; toast(msg, 'ok'); render(); return true; });
  // Tag al posto dei numeri configurabili: si inseriscono con un tocco, l'anteprima mostra il testo per le coppie.
  const values = () => Object.fromEntries((x.tags || []).map((t) => [t.tag, t.tag === '{durata}' && dur ? dur.value : t.tag === '{ricarica}' && cd ? cd.value : t.value]));
  const preview = h('p', { class: 'small cat-preview' });
  const update = () => { const v = values(); preview.textContent = desc.value.replace(/\{\w+\}/g, (m) => (v[m] != null && v[m] !== '' ? String(v[m]) : m)); };
  const insert = (tag) => {
    const a = desc.selectionStart ?? desc.value.length;
    const b = desc.selectionEnd ?? a;
    desc.value = desc.value.slice(0, a) + tag + desc.value.slice(b);
    desc.focus();
    desc.selectionStart = desc.selectionEnd = a + tag.length;
    update();
  };
  for (const el of [desc, dur, cd]) el?.addEventListener('input', update);
  update();
  const r = await modal({ title: `${x.icon} ${x.current.name}`, okLabel: 'Salva', cancelLabel: x.edited ? 'Ripristina originale' : 'Annulla',
    body: h('div', { class: 'stack-sm' },
      h('label', { class: 'field' }, h('span', null, 'Nome'), name),
      h('label', { class: 'field' }, h('span', null, 'Descrizione (quella che leggono le coppie)'), desc),
      x.tags?.length ? h('div', { class: 'tag-row' }, h('span', { class: 'tiny muted' }, 'Inserisci:'),
        x.tags.map((t) => h('button', { class: 'btn btn-sm tag-chip', type: 'button', title: t.label, onclick: () => insert(t.tag) }, t.tag, h('span', { class: 'tiny muted' }, ` ${t.label}`)))) : null,
      h('div', { class: 'cat-preview-box' }, h('div', { class: 'eyebrow' }, 'Anteprima per le coppie'), preview),
      dur || cd ? h('div', { class: 'form-grid' },
        dur ? h('label', { class: 'field' }, h('span', null, 'Durata dell\'effetto (minuti)'), dur) : null,
        cd ? h('label', { class: 'field' }, h('span', null, 'Ricarica (minuti)'), cd) : null) : null,
      x.durationFromParams ? h('p', { class: 'tiny muted' }, 'Durata e raggio dell\'Occhio si cambiano nei parametri della partita (Impostazioni).') : null,
      h('p', { class: 'tiny muted' }, `Originale: ${x.base.name}${x.base.durationMin ? ` · durata ${x.base.durationMin}′` : ''}${x.base.cooldownMin ? ` · ricarica ${x.base.cooldownMin}′` : ''}. Con i tag (es. {durata}) il testo segue da solo i tempi impostati.`)),
    onOk: () => save({ name: name.value, description: desc.value, durationMin: dur?.value ?? '', cooldownMin: cd?.value ?? '' }, 'Salvato') });
  if (r === null && x.edited && await dialog({ title: 'Ripristinare l\'originale?', text: `${x.base.name}: testi e tempi tornano quelli di partenza.`, okLabel: 'Ripristina' })) {
    try { await save({ reset: true }, 'Ripristinato'); } catch (e) { toast(e.message, 'error'); }
  }
}

function viewCatalog() {
  // Cambia lo stato della partita (preparazione ↔ pronta): si ricarica per sapere se è ancora modificabile.
  if (!catalogData || catalogData.gameId !== R.gameId || catalogData.status !== R.ms?.clock.status) { if (!loadCatalog.busy) { loadCatalog.busy = true; loadCatalog().finally(() => { loadCatalog.busy = false; }); } return h('p', { class: 'empty' }, 'Caricamento…'); }
  const c = catalogData;
  const card = (x) => h('div', { class: `cat-card ${x.edited ? 'edited' : ''}`, style: { '--c': x.color || 'var(--brass, #d1ad62)' } },
    h('div', { class: 'cat-head' }, h('span', { class: 'cat-ico', 'aria-hidden': 'true' }, x.icon), h('strong', null, x.current.name),
      x.type ? h('span', { class: 'chip' }, SKILL_TYPE[x.type] || x.type) : null, x.edited ? h('span', { class: 'chip chip-brass' }, 'modificato') : null),
    h('p', { class: 'small' }, x.preview ?? x.current.description),
    h('div', { class: 'tiny muted' }, [x.current.durationMin ? `Durata ${x.current.durationMin}′` : null, x.current.cooldownMin ? `Ricarica ${x.current.cooldownMin}′` : null].filter(Boolean).join(' · ') || ' '),
    c.editable ? h('button', { class: 'btn btn-sm', onclick: () => editCatalogDialog(x) }, 'Modifica') : null);
  return h('div', { class: 'stack' },
    h('div', { class: `panel ${c.editable ? '' : 'pending-panel'}` }, h('p', { class: 'small', style: { margin: 0 } }, c.editable
      ? 'Partita in preparazione: puoi cambiare nome, descrizione, durata e ricarica di ogni Skill e Dono. Alle coppie arrivano i testi e i tempi di questa pagina.'
      : '🔒 Testi e tempi sono bloccati: si cambiano solo con la partita in preparazione.')),
    ...[['active', 'Skill attive'], ['ultimate', 'Ultimate'], ['passive', 'Skill passive']].map(([type, title]) => {
      const list = c.skills.filter((x) => x.type === type);
      return list.length ? section(`${title} (${list.length})`, h('div', { class: 'cat-grid' }, list.map(card))) : null;
    }),
    section(`Doni (${c.gifts.length})`, h('div', { class: 'cat-grid' }, c.gifts.map(card))));
}

// ---------------------------------------------------------------- ACCETTAZIONE E TEST ARMI (modulo condiviso con lo staff, in Soglia)

const ckCtx = () => ({ data: R.ms, base: `/api/m/games/${R.gameId}`, call: (method, path, body, msg) => call(method, G(path), body, msg), render });
const viewCheckin = () => CKUI.viewCheckin(ckCtx());
const viewChrono = () => CKUI.viewChrono(ckCtx());

// ---------------------------------------------------------------- DONI QR

const pad2 = (n) => String(n).padStart(2, '0');

// Quando annunciare il dono alle coppie (e dopo quanto svanisce), scelto sulla timeline del torneo.
async function scheduleGiftDialog(g, preset = null) {
  const placed = g.status === 'placed';
  const initial = preset || (g.revealMode === 'at' && g.revealAt ? { mode: 'at', at: g.revealAt } : g.revealMode === 'time' ? { mode: 'min', min: g.revealAtMin } : null);
  const r = await timelineModal({
    title: `Annuncia ${g.label} · ${g.icon} ${g.name}`,
    intro: placed
      ? 'Al momento scelto il dono compare sulla mappa di tutte le coppie, con annuncio e notifica. La prima coppia che lo scansiona lo prende e sparisce dalle mappe di tutti. L\'annuncio parte solo a partita in corso.'
      : 'Il dono non è ancora piazzato: verrà annunciato al momento scelto, o appena viene piazzato se quel momento è già passato. L\'annuncio parte solo a partita in corso.',
    nowLabel: g.revealDelayMin ? `Ora (compare tra ${g.revealDelayMin} minuti)` : placed ? 'Ora' : 'Appena viene piazzato',
    withDuration: true, durationLabel: 'Svanisce dopo (minuti)', defaultDuration: g.expiresAfterMin ?? '', allowDurationEmpty: true,
    exclude: { kind: 'gift', id: g.id }, initial, okLabel: 'Programma',
  });
  if (!r) return;
  try {
    await api('PATCH', `/api/m/gifts/${g.id}`, { expiresAfterMin: r.durationMin ?? '' });
    let revealed = false;
    if (r.mode === 'min') await api('PATCH', `/api/m/gifts/${g.id}`, { revealMode: 'time', revealAtMin: r.min });
    else revealed = (await api('POST', `/api/m/gifts/${g.id}/schedule`, r.mode === 'now' ? { mode: 'now' } : { mode: 'at', at: r.at })).revealed;
    toast(revealed ? 'Dono annunciato a tutte le coppie' : 'Annuncio programmato', 'ok');
    loadField();
  } catch (e) { toast(e.message, 'error', 6000); }
}

function giftRevealCell(g) {
  if (g.status === 'revealed') return h('span', null, `Annunciato ${fmtTime(g.revealedAt)}`);
  if (['claimed', 'expired'].includes(g.status)) return g.revealedAt ? h('span', { class: 'muted' }, `Annunciato ${fmtTime(g.revealedAt)}`) : '—';
  if (g.revealMode === 'at' && g.revealAt) return h('span', null, `alle ${fmtTime(g.revealAt)} · tra `, h('span', { class: 'mono', 'data-clock': `abs:${g.revealAt}` }, '—'));
  if (g.revealMode === 'onplace') return 'appena piazzato';
  if (g.revealDelayMin) return h('span', { class: 'muted' }, `quando decidi tu · compare ${g.revealDelayMin}′ dopo l'annuncio`);
  if (g.revealMode === 'time') return `a ${g.revealAtMin}′ dal via`;
  return h('span', { class: 'muted' }, 'quando decidi tu');
}

// Crea dono: una card per tipo (titolo e descrizione); scelto il tipo, squadra, annuncio, ritardo, scadenza e cartello.
async function createGiftDialog() {
  const d = fieldData;
  let type = null;
  const count = h('input', { class: 'input', type: 'number', min: 1, max: 50, value: 1 });
  const title = h('input', { class: 'input', maxlength: 36, placeholder: 'es. Cassa del bosco (vuoto: Dono N)' });
  const squadSel = h('select', { class: 'input' }, squadOptions(null, 'Nessuna (la assegno dopo)'));
  const mode = h('select', { class: 'input' },
    h('option', { value: 'manual' }, 'Lo annuncio io (dalla tabella: ora, tra X minuti o a un orario)'),
    h('option', { value: 'onplace' }, 'Appena viene piazzato'));
  const delay = h('input', { class: 'input', type: 'number', min: 0, step: 1, placeholder: 'nessuno' });
  const exp = h('input', { class: 'input', type: 'number', min: 1, step: 1, placeholder: 'mai' });
  // Dopo la lettura: scade (una sola coppia) o resta attivo per le altre (ognuna lo prende una volta).
  const after = h('select', { class: 'input', onchange: () => { if (after.value === '1') sign.value = '0'; } },
    h('option', { value: '0' }, 'Scade: lo prende una sola coppia'),
    h('option', { value: '1' }, 'Resta attivo per le altre coppie'));
  const sign = h('select', { class: 'input' },
    h('option', { value: '1' }, 'Cartello da rimuovere (dopo la scansione)'),
    h('option', { value: '0' }, 'Non rimuovere il cartello'));
  const opts = h('div', { class: 'form-grid gift-opts', hidden: true },
    h('label', { class: 'field' }, h('span', null, 'Titolo (sul cartello)'), title),
    h('label', { class: 'field' }, h('span', null, 'Quanti'), count),
    h('label', { class: 'field' }, h('span', null, 'Squadra che li piazza'), squadSel),
    h('label', { class: 'field' }, h('span', null, 'Annuncio'), mode),
    h('label', { class: 'field' }, h('span', null, 'Ritardo all\'annuncio (min)'), delay),
    h('label', { class: 'field' }, h('span', null, 'Scadenza: minuti dopo la comparsa'), exp),
    h('label', { class: 'field' }, h('span', null, 'Dopo la lettura'), after),
    h('label', { class: 'field' }, h('span', null, 'Cartello stampato'), sign),
    h('p', { class: 'tiny muted gift-opts-note' }, 'Ritardo all\'annuncio: quando annunci il dono, compare sulla mappa delle coppie N minuti dopo il tuo annuncio (non al piazzamento). Resta attivo: ogni coppia lo prende una volta sola, e chi lo rilegge lo trova scaduto.'));
  const chosen = h('p', { class: 'gift-chosen', hidden: true });
  const cards = h('div', { class: 'gift-cards' }, d.giftTypes.map((t) => {
    const card = h('button', { type: 'button', class: 'gift-card', style: { '--c': t.color }, onclick: () => {
      type = t;
      for (const c of cards.children) c.classList.toggle('on', c === card);
      chosen.hidden = false; chosen.textContent = `${t.icon} ${t.name}`;
      opts.hidden = false;
    } },
    h('span', { class: 'gift-card-ico', 'aria-hidden': 'true' }, t.icon),
    h('strong', null, t.name),
    h('span', { class: 'tiny' }, t.description));
    return card;
  }));
  return modal({ title: 'Crea dono', wide: true, okLabel: 'Crea',
    body: h('div', { class: 'stack' }, h('p', { class: 'muted tiny' }, 'Scegli il dono: il tipo non è stampato sul cartello, è una sorpresa.'), cards, chosen, opts),
    onOk: async () => {
      if (!type) { toast('Scegli prima il dono', 'error'); return false; }
      const r = await api('POST', G('/gifts'), { typeId: type.id, label: title.value, count: count.value, revealMode: mode.value, revealDelayMin: delay.value, expiresAfterMin: exp.value,
        squadId: Number(squadSel.value) || null, removeSign: sign.value === '1', multi: after.value === '1' });
      toast(`${r.ids.length === 1 ? 'Dono creato' : `${r.ids.length} doni creati`}${Number(squadSel.value) ? ': la squadra è stata avvisata' : ''}`, 'ok');
      loadField();
      return true;
    } });
}

function viewGiftsQR() {
  const d = fieldData;
  if (!d) { loadField(); return h('p', { class: 'empty' }, 'Caricamento dei doni…'); }
  const live = d.gifts.filter((g) => !['claimed', 'expired'].includes(g.status));
  const gone = d.gifts.filter((g) => ['claimed', 'expired'].includes(g.status));
  const giftQr = (g) => {
    if (!g.qrToken) return null;
    const url = `${R.baseUrl}/d/${g.qrToken}`;
    return h('a', { href: `/api/m/qr.svg?text=${encodeURIComponent(url)}`, target: '_blank', title: url },
      h('img', { class: 'gift-qr', src: `/api/m/qr.svg?text=${encodeURIComponent(url)}`, alt: `QR ${g.label}`, width: 84, height: 84, loading: 'lazy' }));
  };
  const row = (g) => h('tr', { class: `gift-row-${g.status}` },
    h('td', null, giftQr(g)),
    h('td', null, h('div', { class: 'gift-title' }, h('strong', null, g.label),
      !['claimed', 'expired'].includes(g.status) ? h('button', { class: 'btn btn-xs btn-ghost', title: 'Cambia titolo', 'aria-label': `Cambia il titolo di ${g.label}`, onclick: async () => {
        const v = await dialog({ title: 'Titolo del dono', text: 'È il nome stampato sul cartello (il tipo resta segreto). Se il cartello è già stampato, ristampalo.', input: { value: g.label }, okLabel: 'Salva' });
        if (v == null || !v.trim() || v.trim() === g.label) return;
        try { await api('PATCH', `/api/m/gifts/${g.id}`, { label: v.trim() }); toast('Titolo cambiato', 'ok'); loadField(); } catch (e) { toast(e.message, 'error', 6000); }
      } }, '✎') : null),
      h('div', { style: { color: g.color } }, `${g.icon} ${g.name}`),
      h('div', { class: 'tiny muted' }, g.removeSign ? 'Cartello da rimuovere' : 'Non rimuovere il cartello'),
      g.multi ? h('div', { class: 'tiny gift-multi' }, `♾ Resta attivo${g.takenBy?.length ? ` · preso da ${g.takenBy.join(', ')}` : ''}`) : null),
    h('td', null, g.status === 'claimed' ? h('span', { class: 'chip chip-brass' }, `Preso da ${g.claimedBy} alle ${fmtTime(g.claimedAt)}${g.usedAt ? ' · usato' : ''}`)
      : g.status === 'expired' ? h('span', { class: 'chip' }, `Svanito alle ${fmtTime(g.expiredAt)}`)
        : g.status === 'revealed' ? h('span', { class: 'chip chip-blood' }, 'In mappa alle coppie') : placementChips(g, g.status !== 'draft')),
    h('td', { class: 'tiny' }, giftRevealCell(g)),
    h('td', { class: 'tiny' }, !g.expiresAfterMin ? 'mai' : g.status === 'revealed' && g.expiresAtElapsedMs != null ? h('span', null, 'tra ', h('span', { class: 'mono', 'data-clock': `until:${g.expiresAtElapsedMs}` }, '—')) : `${g.expiresAfterMin}′ dopo l'annuncio`),
    h('td', { class: 'row-actions' },
      ['draft', 'placed'].includes(g.status) ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => scheduleGiftDialog(g) }, ['at', 'onplace', 'time'].includes(g.revealMode) ? '◷ Cambia annuncio' : '◷ Annuncia…') : null,
      ['draft', 'placed'].includes(g.status) && ['at', 'onplace', 'time'].includes(g.revealMode) ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => call('POST', `/api/m/gifts/${g.id}/schedule`, { mode: 'cancel' }, 'Annuncio annullato').then(() => loadField()) }, 'Annulla annuncio') : null,
      ['draft', 'placed', 'revealed'].includes(g.status) ? placementButtons('gift', g, g.status !== 'draft') : null,
      g.hasPhoto ? h('a', { class: 'btn btn-sm btn-ghost', href: `/api/media/gift/${g.id}?v=${g.placedAt}`, target: '_blank' }, 'Foto') : null,
      ['placed', 'revealed', 'expired'].includes(g.status) ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Riportare da piazzare?', 'Posizione e foto vengono cancellate e il dono sparisce dalle mappe.', 'POST', `/api/m/gifts/${g.id}/reset`, {}, 'Dono da ripiazzare', true).then(() => loadField()) }, 'Da ripiazzare') : null,
      h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Eliminare il dono?', g.label, 'DELETE', `/api/m/gifts/${g.id}`, undefined, 'Dono eliminato', true).then(() => loadField()) }, 'Elimina')));
  const table = (list) => h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, ['QR', 'Dono', 'Stato e incarico', 'Annuncio', 'Scadenza', ''].map((x) => h('th', null, x)))),
    h('tbody', null, list.map(row))));

  return h('div', { class: 'stack' },
    sectionActions(`Doni in gioco (${live.length})`, [
      h('button', { class: 'btn btn-sm btn-primary', onclick: createGiftDialog }, '+ Crea dono'),
      h('a', { class: 'btn btn-sm', href: `/regia/stampa/doni/${R.gameId}`, target: '_blank' }, 'Stampa cartelli')],
    live.length ? table(live) : h('p', { class: 'empty' }, 'Nessun dono in gioco: crealo con «+ Crea dono».')),
    gone.length ? section(`Doni presi o svaniti (${gone.length})`, table(gone)) : null,
    h('details', { class: 'panel how-gifts' }, h('summary', null, 'Come funzionano i doni'),
      h('ol', { class: 'how-steps' },
        h('li', null, h('strong', null, 'Crea'), ' il dono e stampa il suo cartello QR (il tipo non è stampato: è una sorpresa). Sul cartello c\'è scritto se va rimosso dopo la scansione.'),
        h('li', null, h('strong', null, 'Fallo piazzare'), ' a una squadra di Eletti: indichi tu il punto sulla mappa o li lasci liberi. Piazzandolo, l\'Eletto scatta la foto e il dono prende la posizione del suo telefono.'),
        h('li', null, h('strong', null, 'Annuncialo'), ': ora, tra X minuti o a un orario (con il ritardo all\'annuncio compare N minuti dopo). Compare sulla mappa di tutte le coppie, con notifica.'),
        h('li', null, h('strong', null, 'La prima coppia'), ' che lo scansiona lo prende: notifica a tutti, sparisce dalle mappe di coppie ed Eletti. Se ha una scadenza e nessuno lo prende, svanisce.'))));
}

// ---------------------------------------------------------------- ARMAMENTI

function supplyWhen(s) {
  if (s.scheduledMin != null) return `a ${fmtMin(s.scheduledMin)} dal via`;
  if (s.scheduledAt) return `alle ${fmtTime(s.scheduledAt)}`;
  return 'a mano';
}

function supplyState(s) {
  if (s.status === 'closed') return h('span', { class: 'chip' }, `chiusa alle ${fmtTime(s.closedAt)}`);
  if (s.status === 'fired' && s.closesAt) return h('span', { class: 'chip chip-blood' }, 'APERTA · chiude tra ', h('span', { class: 'mono', 'data-clock': `abs:${s.closesAt}` }, '—'));
  if (s.status === 'fired') return h('span', { class: 'chip chip-blood' }, `annunciata alle ${fmtTime(s.firedAt)}`);
  const cd = s.scheduledMin != null ? `until:${s.scheduledMin * 60000}` : s.scheduledAt ? `abs:${s.scheduledAt}` : null;
  return h('span', { class: 'chip chip-brass' }, 'in attesa', cd ? [' · tra ', h('span', { class: 'mono', 'data-clock': cd }, '—')] : null);
}

// Quando aprire la finestra e per quanto: scelto sulla timeline del torneo.
async function supplyDialog(s = null, preset = null) {
  const ms = R.ms;
  const initial = preset || (s ? (s.scheduledMin != null ? { mode: 'min', min: s.scheduledMin } : s.scheduledAt ? { mode: 'at', at: s.scheduledAt } : null) : null);
  // Cosa contiene la finestra e l'annuncio: si scrivono qui, anche quando la si programma dalla timeline.
  const desc = h('input', { class: 'input', maxlength: 200, placeholder: 'es. 2 casse di BB, 1 caricatore extra (solo regia)', value: s ? s.description || '' : supplyDraft.desc });
  const msg = h('textarea', { class: 'input', rows: 2, maxlength: 500, placeholder: 'Annuncio alle coppie (vuoto = testo predefinito)' });
  msg.value = s ? s.message || '' : supplyDraft.msg;
  const extra = h('div', { class: 'stack-sm' },
    h('label', { class: 'field' }, h('span', null, 'Cosa contiene'), desc),
    h('label', { class: 'field' }, h('span', null, 'Messaggio alle coppie'), msg));
  setTimeout(() => desc.focus(), 50);
  const r = await timelineModal({
    extra,
    title: s ? 'Modifica la finestra armamenti' : 'Nuova finestra armamenti',
    intro: 'All\'apertura parte l\'annuncio a tutte le coppie e nelle app compare il conto alla rovescia della chiusura; allo scadere della durata la finestra si chiude con un secondo annuncio. Si apre solo a partita in corso.',
    nowLabel: 'Apri adesso', withDuration: true, durationLabel: 'Resta aperta per (minuti)', defaultDuration: s?.durationMin ?? 15, allowDurationEmpty: true,
    exclude: s ? { kind: 'supply', id: s.id } : null, initial, okLabel: s ? 'Salva' : 'Programma',
  });
  if (!r) return;
  const body = { description: desc.value.trim(), message: msg.value.trim(), durationMin: r.durationMin ?? '' };
  if (r.mode === 'min') body.scheduledMin = r.min;
  if (r.mode === 'at') body.scheduledAt = r.at;
  try {
    const res = s ? await api('PATCH', `/api/m/supply/${s.id}`, body) : await api('POST', G('/supply'), body);
    const id = s ? s.id : res.id;
    if (r.mode === 'now') await api('POST', `/api/m/supply/${id}/fire`, {});
    toast(r.mode === 'now' ? 'Armamenti aperti' : 'Finestra programmata', 'ok');
    if (!s) { supplyDraft.desc = ''; supplyDraft.msg = ''; }
  } catch (e) { toast(e.message, 'error', 7000); }
  load();
}
const supplyDraft = { desc: '', msg: '' };

// Finestra già aperta o chiusa: contenuto, messaggio e (se aperta) durata.
async function supplyEditDialog(s) {
  const fired = s.status === 'fired';
  const desc = h('input', { class: 'input', maxlength: 200, value: s.description || '', placeholder: 'es. 2 casse di BB (solo regia)' });
  const msg = h('textarea', { class: 'input', rows: 2, maxlength: 500 });
  msg.value = s.message || '';
  const dur = h('input', { class: 'input input-sm w-90', type: 'number', min: 1, max: 600, value: s.durationMin ?? '', placeholder: 'nessuna' });
  const ok = await modal({
    title: fired ? 'Finestra armamenti aperta' : 'Finestra armamenti chiusa',
    okLabel: 'Salva',
    body: h('div', { class: 'stack-sm' },
      h('label', { class: 'field' }, h('span', null, 'Cosa contiene'), desc),
      h('label', { class: 'field' }, h('span', null, 'Messaggio alle coppie'), msg),
      h('p', { class: 'tiny muted' }, 'L\'annuncio di apertura è già partito: il messaggio cambiato resta nella scheda della finestra.'),
      fired ? h('label', { class: 'field' }, h('span', null, `Durata totale dall'apertura delle ${fmtTime(s.firedAt)} (minuti, vuoto = fino a chiusura)`), dur) : null),
    onOk: () => true,
  });
  if (!ok) return;
  const body = { description: desc.value.trim(), message: msg.value.trim() };
  if (fired) body.durationMin = dur.value;
  call('PATCH', `/api/m/supply/${s.id}`, body, 'Finestra aggiornata');
}

function viewSupply() {
  const ms = R.ms;
  const active = ACTIVE.includes(ms.clock.status);
  const desc = h('input', { class: 'input', placeholder: 'Cosa viene lasciato al Cuore (solo regia)', value: supplyDraft.desc, oninput: (e) => { supplyDraft.desc = e.target.value; } });
  const msg = h('textarea', { class: 'input', rows: 2, placeholder: 'Annuncio (vuoto = testo predefinito)', oninput: (e) => { supplyDraft.msg = e.target.value; } });
  msg.value = supplyDraft.msg;
  const shift = (s, m, label) => h('button', { class: 'btn btn-sm', title: label, onclick: () => call('POST', `/api/m/supply/${s.id}/shift`, { minutes: m }, label) }, `${m > 0 ? '+' : '−'}${Math.abs(m)}′`);

  return h('div', { class: 'stack' },
    section('Nuova finestra armamenti',
      h('p', { class: 'muted tiny' }, `Testo predefinito dell'annuncio: «${ms.game.templates.supply}». Il momento e la durata si scelgono sulla timeline del torneo, accanto a tradimenti, doni e fasi.`),
      h('div', { class: 'form-grid' }, desc, msg,
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => supplyDialog() }, '◷ Scegli quando e per quanto…'))),
    sectionActions('Finestre armamenti', [h('button', { class: 'btn btn-sm', onclick: () => timelineModal({ title: 'Timeline del torneo', intro: 'Tutti gli avvenimenti programmati e passati.', okLabel: 'Chiudi' }) }, 'Vedi la timeline')],
      ms.supply.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Apertura', 'Durata', 'Stato', 'Descrizione', ''].map((x) => h('th', null, x)))),
        h('tbody', null, ms.supply.map((s) => {
          const open = s.status === 'fired' && s.closesAt;
          const openEnded = s.status === 'fired' && !s.closesAt;
          return h('tr', { class: open ? 'row-open' : '' },
            h('td', { class: 'mono' }, s.status === 'scheduled' ? supplyWhen(s) : `aperta ${fmtTime(s.firedAt)}`),
            h('td', { class: 'mono' }, s.durationMin ? `${s.durationMin}′` : '—'),
            h('td', null, supplyState(s)),
            h('td', { class: 'tiny' }, s.description || '—', s.message ? h('div', { class: 'muted' }, `«${s.message}»`) : null),
            h('td', { class: 'row-actions' },
              s.status === 'scheduled' ? h('button', { class: 'btn btn-sm btn-primary', disabled: !active, title: active ? '' : 'Si apre solo a partita in corso', onclick: () => confirmCall('Aprire adesso?', 'Parte subito l\'annuncio a tutte le coppie.', 'POST', `/api/m/supply/${s.id}/fire`, {}, 'Armamenti aperti') }, 'Apri ora') : null,
              h('button', { class: 'btn btn-sm', onclick: () => (s.status === 'scheduled' ? supplyDialog(s) : supplyEditDialog(s)) }, 'Modifica…'),
              s.status === 'scheduled' && (s.scheduledMin != null || s.scheduledAt) ? [shift(s, -5, 'Anticipata di 5 minuti'), shift(s, 5, 'Posticipata di 5 minuti')] : null,
              open ? [shift(s, -5, 'Accorciata di 5 minuti'), shift(s, 5, 'Prolungata di 5 minuti')] : null,
              openEnded ? h('button', { class: 'btn btn-sm', onclick: () => call('POST', `/api/m/supply/${s.id}/shift`, { minutes: 15 }, 'Si chiude tra 15 minuti') }, 'Chiudi tra 15′') : null,
              s.status === 'fired' ? h('button', { class: 'btn btn-sm btn-danger', onclick: () => confirmCall('Chiudere la finestra?', 'Parte l\'annuncio di chiusura a tutte le coppie.', 'POST', `/api/m/supply/${s.id}/close`, {}, 'Finestra chiusa', true) }, 'Chiudi ora') : null,
              s.status === 'scheduled' ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmCall('Eliminare la finestra?', '', 'DELETE', `/api/m/supply/${s.id}`, undefined, 'Eliminata', true) }, 'Elimina') : null));
        })))) : h('p', { class: 'empty' }, 'Nessuna finestra armamenti.')));
}

// ---------------------------------------------------------------- ANNUNCI E MESSAGGI

// Vista gerarchica: tutte le coppie (annunci) → ogni coppia; tutti gli Eletti → ogni squadra. A destra la conversazione.
function chatTarget() {
  const ms = R.ms;
  const c = R.chat || { kind: 'all' };
  if (c.kind === 'team') { const t = ms.teams.find((x) => x.id === c.id); if (t) return { ...c, title: `${t.roman} Settore ${t.sectorName}`, sub: t.members.map((m) => m.nickname || m.name).join(' · '), unread: t.unread, url: `/api/m/teams/${t.id}`, msgs: ms.messages.filter((m) => m.teamId === t.id), who: 'coppia' }; }
  if (c.kind === 'elect') return { ...c, id: ms.elect.id, title: 'Tutti gli Eletti', sub: `${ms.elect.members.length} Eletti · ogni messaggio arriva a tutti`, unread: ms.elect.unread, url: `/api/m/teams/${ms.elect.id}`, msgs: ms.messages.filter((m) => m.teamId === ms.elect.id && !m.squadId), who: 'Eletto' };
  if (c.kind === 'squad') { const s = ms.squads.find((x) => x.id === c.id); if (s) return { ...c, title: `Squadra ${s.name}`, sub: s.members.map((m) => m.nickname || m.name).join(' · ') || 'nessun membro', unread: s.unread, url: `/api/m/squads/${s.id}`, msgs: ms.messages.filter((m) => m.squadId === s.id), who: 'Eletto', color: s.color }; }
  return { kind: 'all', title: 'Tutte le coppie', sub: 'Annunci a tutte le coppie (notifica sui telefoni)' };
}

function viewComms() {
  const ms = R.ms;
  const cur = chatTarget();
  const key = `${cur.kind}-${cur.id ?? ''}`;
  if (R.chatKey !== key) { R.chatKey = key; R.chatStick = true; }
  R.chat = { kind: cur.kind, id: cur.id };
  if (cur.unread) api('POST', `${cur.url}/read`).catch(() => {});
  const on = (kind, id) => cur.kind === kind && (id == null || cur.id === id);
  const node = (kind, id, label, sub, unread, opts = {}) => h('button', { class: `tree-item ${opts.child ? 'child' : 'root'} ${on(kind, id) ? 'on' : ''}`, style: opts.color ? { '--c': opts.color } : null, onclick: () => { R.chat = { kind, id }; R.chatOpen = true; render(); } },
    h('span', { class: 'tree-label' }, label, sub ? h('span', { class: 'tiny muted' }, sub) : null), unread ? h('span', { class: 'badge badge-alert' }, unread) : null);

  // Tutte le coppie: broadcast (annunci). Coppie: chat privata. Eletti e squadre: canali di gruppo.
  const list = cur.kind === 'all'
    ? [...ms.announcements].reverse().map((a) => ({ id: `a${a.id}`, mine: true, who: null, tag: ms.templateLabels[a.type] || 'Annuncio', text: a.text, createdAt: a.createdAt }))
    : cur.msgs.map((m) => ({ id: m.id, mine: m.fromRole === 'master', who: m.fromRole === 'master' ? m.author || 'regia' : m.author || cur.who, text: m.text, audioMime: m.audioMime, audioMs: m.audioMs, createdAt: m.createdAt }));
  const thread = chatThread(list, cur.kind === 'all' ? 'Nessun annuncio: quello che scrivi qui arriva a tutte le coppie.' : 'Nessun messaggio.');
  queueMicrotask(() => { if (R.chatStick !== false) thread.scrollTop = thread.scrollHeight; });
  thread.addEventListener('scroll', () => { R.chatStick = thread.scrollTop + thread.clientHeight >= thread.scrollHeight - 40; });

  // Sul telefono: elenco delle conversazioni oppure la conversazione aperta, come nelle app di messaggi.
  return h('div', { class: `comms ${R.chatOpen ? 'chat-open' : ''}` },
    h('nav', { class: 'comms-tree', 'aria-label': 'Destinatari' },
      node('all', null, '📣 Tutte le coppie', 'annuncio a tutti'),
      ms.teams.map((t) => node('team', t.id, `${t.roman} ${t.sectorName}`, t.displayName || 'chat privata', t.unread, { child: true })),
      node('elect', ms.elect.id, '⛨ Tutti gli Eletti', `canale · ${ms.elect.members.length} persone`, ms.elect.unread),
      ms.squads.map((s) => node('squad', s.id, `Squadra ${s.name}`, `canale · ${s.members.length} Eletti`, s.unread, { child: true, color: s.color })),
      ms.squads.length ? null : h('p', { class: 'tiny muted tree-hint' }, 'Le squadre degli Eletti compaiono qui quando le crei.')),
    h('section', { class: 'wa-pane', style: cur.color ? { '--c': cur.color } : null },
      h('header', { class: 'wa-head' }, h('button', { class: 'btn btn-sm btn-ghost wa-back', type: 'button', onclick: () => { R.chatOpen = false; render(); } }, '‹ Conversazioni'), h('strong', null, cur.title), h('span', { class: 'tiny muted' }, cur.sub)),
      thread,
      waComposer(cur)));
}

function chatThread(list, empty) {
  const box = h('div', { class: 'wa-thread' });
  if (!list.length) { box.append(h('p', { class: 'empty' }, empty)); return box; }
  let lastDay = '';
  for (const m of list) {
    const day = new Date(m.createdAt).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
    if (day !== lastDay) { box.append(h('div', { class: 'wa-day' }, h('span', null, day))); lastDay = day; }
    box.append(h('div', { class: `wa-bubble ${m.mine ? 'mine' : 'theirs'}` },
      m.who && !m.mine ? h('div', { class: 'wa-who' }, m.who) : null,
      m.tag ? h('div', { class: 'wa-who' }, m.tag) : null,
      m.audioMime ? voicePlayer(`/api/media/message/${m.id}`, m.audioMs) : h('div', { class: 'wa-text' }, m.text),
      h('div', { class: 'wa-time mono' }, m.mine && m.who ? `${m.who} · ${fmtTime(m.createdAt)}` : fmtTime(m.createdAt))));
  }
  return box;
}

// Casella in fondo stile WhatsApp: si allunga mentre scrivi, Invio manda (Maiusc+Invio va a capo),
// pulsante tondo: microfono quando è vuota, freccia quando c'è testo.
function waComposer(cur) {
  const broadcast = cur.kind === 'all';
  if (R.rec) {
    return h('div', { class: 'wa-composer recording' },
      h('button', { class: 'wa-btn wa-ghost', type: 'button', title: 'Annulla', 'aria-label': 'Annulla il vocale', onclick: () => { R.rec.cancel(); R.rec = null; render(); } }, '🗑'),
      h('div', { class: 'wa-rec' }, h('span', { class: 'rec-dot', 'aria-hidden': 'true' }), h('span', { class: 'mono', id: 'rec-time-regia' }, fmtSec(Date.now() - R.rec.startedAt)), h('span', { class: 'tiny muted' }, `Vocale per ${cur.title}…`)),
      h('button', { class: 'wa-btn wa-send', type: 'button', title: 'Invia il vocale', 'aria-label': 'Invia il vocale', onclick: () => sendRegiaVoice() }, '➤'));
  }
  const canVoice = !broadcast && voiceSupported();
  const ta = h('textarea', { class: 'wa-input', rows: 1, maxlength: broadcast ? 500 : 1000, 'data-keep': `reply-${cur.kind}-${cur.id ?? ''}`, placeholder: broadcast ? 'Annuncio a tutte le coppie…' : `Scrivi a ${cur.title}…`, 'aria-label': 'Messaggio' });
  const btn = h('button', { class: 'wa-btn wa-send', type: 'submit' });
  const sync = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    const voice = canVoice && !ta.value.trim();
    btn.textContent = voice ? '🎤' : '➤';
    btn.title = voice ? 'Registra un vocale' : broadcast ? 'Invia a tutte le coppie' : 'Invia';
    btn.setAttribute('aria-label', btn.title);
    btn.dataset.mode = voice ? 'voice' : 'text';
  };
  ta.addEventListener('input', sync);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  const form = h('form', { class: 'wa-composer', onsubmit: async (e) => {
    e.preventDefault();
    if (btn.dataset.mode === 'voice') return startRegiaVoice();
    if (!ta.value.trim()) return;
    R.chatStick = true;
    if (broadcast) {
      if (!(await dialog({ title: 'Inviare l\'annuncio a tutte le coppie?', text: ta.value, okLabel: 'Invia a tutti' }))) return;
      await sendClearing(ta, (text) => call('POST', G('/announce'), { text }, 'Annuncio inviato'));
    } else {
      await sendClearing(ta, (text) => call('POST', `${cur.url}/message`, { text }));
    }
  } }, ta, btn);
  queueMicrotask(sync);
  return form;
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
  const cur = chatTarget();
  R.rec = null;
  render();
  const voice = await rec.stop();
  if (voice.ms < 700) return toast('Vocale troppo breve', 'info');
  if (!cur.url) return;
  try {
    await uploadAudio(`${cur.url}/message/audio`, voice);
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

// ---------------------------------------------------------------- NOTIFICHE: chi non le riceve

async function loadPushReport() {
  try { R.pushRep = { gameId: R.gameId, at: Date.now(), ...(await api('GET', G('/push-report'))) }; } catch (e) { toast(e.message, 'error'); }
  render();
}

const PUSH_STATE = {
  on: (x) => h('span', { class: 'chip chip-ok' }, `attive${x.devices > 1 ? ` · ${x.devices} dispositivi` : ''}`),
  shared: () => h('span', { class: 'chip chip-warn', title: 'Le riceve solo il telefono entrato con il codice della coppia, non il suo' }, 'solo telefono della coppia'),
  off: () => h('span', { class: 'chip chip-blood' }, 'non attive'),
};
const TRACCAR_STATE = {
  ok: (x) => h('span', { class: 'chip chip-ok', title: x.trackSeenAt ? `Ultimo segnale ${fmtTime(x.trackSeenAt)}` : '' }, 'verificato'),
  stale: (x) => h('span', { class: 'chip chip-blood', title: x.trackSeenAt ? `Ultimo segnale ${fmtTime(x.trackSeenAt)}` : 'Nessun segnale' }, 'non manda'),
  none: () => h('span', { class: 'chip chip-warn' }, 'da attivare'),
};

// App: installata o dal browser, e versione (in giallo se non è l'ultima).
function appCell(app, current) {
  if (!app) return h('span', { class: 'tiny muted', title: 'Non ha ancora aperto l\'app con il suo accesso personale' }, '—');
  const old = current && app.version && app.version !== current;
  const OS = { ios: ['🍎 iPhone', 'iPhone o iPad (Safari): niente cronografo Bluetooth, le notifiche solo con l\'app installata'], android: ['🤖 Android', 'Android'], desktop: ['💻 computer', 'Computer'] };
  const os = OS[app.os];
  return h('div', { class: 'app-cell' },
    os ? h('span', { class: `os-tag os-${app.os}`, title: os[1] }, os[0]) : null,
    h('span', { class: `chip ${app.installed ? 'chip-ok' : ''}`, title: app.installed ? 'Installata nella schermata Home' : 'Aperta dal browser, non installata' }, app.installed ? 'installata' : 'browser'),
    h('div', { class: `mono tiny ${old ? 'warn-text' : 'muted'}`, title: old ? `Versione vecchia: l'ultima è ${current}. Deve chiudere e riaprire l'app.` : `Vista ${fmtTime(app.at)}` },
      (app.version || '?').replace('zdg-', ''), old ? ' · vecchia' : ''));
}

// Pallino: app aperta adesso (verde), aperta solo sul telefono della coppia (giallo), chiusa (grigio).
const onlineDot = (o) => h('span', { class: `online-dot ${o || 'off'}`, title: o === 'on' ? 'Online adesso' : o === 'team' ? 'Online dal telefono della coppia' : 'Non online' });
// La tabella si aggiorna da sola mentre la pagina è aperta (e a ogni cambiamento che arriva dal server).
setInterval(() => { if (tab() === 'notifiche' && !document.hidden && R.gameId && !R.pushLoading) { R.pushLoading = true; loadPushReport().finally(() => { R.pushLoading = false; }); } }, 15000);

function viewPushReport() {
  const rep = R.pushRep;
  if (!rep || rep.gameId !== R.gameId || Date.now() - rep.at > 15000) { if (!R.pushLoading) { R.pushLoading = true; loadPushReport().finally(() => { R.pushLoading = false; }); } }
  if (!rep || rep.gameId !== R.gameId) return h('p', { class: 'empty' }, 'Caricamento…');
  // Sempre tutti: in alto chi è a posto, poi chi ha meno cose da sistemare.
  const todo = (x) => !x.ready;
  const show = (list) => list;
  const groups = [
    ['couple', 'Coppie'], ['elect', 'Eletti del Consiglio'], ['free', 'Accettati senza coppia'], ['pending', 'Iscrizioni in attesa'],
  ].map(([key, label]) => ({ key, label, all: rep.people.filter((p) => p.group === key) }));
  const missing = rep.people.filter((p) => p.state !== 'on');
  const noTrk = rep.people.filter((p) => ['couple', 'elect'].includes(p.group) && p.traccar !== 'ok');
  const off = rep.people.filter((p) => p.state === 'off');
  const copyList = () => {
    const lines = missing.map((p) => `${p.name}${p.nickname ? ` «${p.nickname}»` : ''}${p.where ? ` (${p.where})` : ''}${p.phone ? ` · ${p.phone}` : ''}`);
    const text = `Notifiche dei Giochi del Buio da attivare:\n${lines.join('\n')}\n\nApri l'app (${R.baseUrl || location.origin}), entra con il tuo account e premi «Attiva le notifiche». Su iPhone prima aggiungi l'app alla schermata Home.`;
    navigator.clipboard?.writeText(text).then(() => toast('Elenco copiato: incollalo nel gruppo WhatsApp', 'ok'), () => toast('Copia non riuscita', 'error'));
  };
  const table = (list, staff = false) => h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, (staff ? ['Persona', 'Ruolo', 'Notifiche'] : ['', 'Persona', 'Dove', 'Telefono', 'App', 'Notifiche', 'Traccar', 'Ultimo ping', 'ICE', 'Sicurezza']).map((x) => h('th', null, x)))),
    h('tbody', null, list.map((p) => (staff
      ? h('tr', null, h('td', null, onlineDot(p.online), ' ', h('strong', null, p.displayName || p.username), h('span', { class: 'tiny muted' }, ` @${p.username}`)), h('td', null, p.role === 'master' ? 'master' : 'validatore'), h('td', null, PUSH_STATE[p.state](p)))
      : h('tr', { class: p.ready ? 'row-ready' : '' },
        h('td', null, p.ready ? h('span', { class: 'chip chip-ok', title: 'Tutto a posto' }, '✓') : h('span', { class: 'chip chip-warn', title: `Da sistemare: ${p.todo.join(', ')}` }, p.todo.length)),
        h('td', null, h('div', { class: 'who-online' }, onlineDot(p.online), personLine(p))),
        h('td', null, p.where || h('span', { class: 'muted' }, p.status === 'pending' ? 'in attesa' : '—')),
        h('td', null, p.phone ? phoneLinks(p.phone, { cls: '' }) : h('span', { class: 'muted' }, '—')),
        h('td', null, appCell(p.app, rep.currentVersion)),
        h('td', null, PUSH_STATE[p.state](p)),
        h('td', null, TRACCAR_STATE[p.traccar](p)),
        h('td', { class: 'mono tiny' }, p.trackSeenAt
          ? [h('span', { 'data-ago': p.trackSeenAt, class: clock.serverNow() - p.trackSeenAt > 10 * 60000 ? 'bad' : '' }, agoText(p.trackSeenAt)), h('div', { class: 'muted' }, fmtTime(p.trackSeenAt))]
          : h('span', { class: 'muted' }, 'mai')),
        h('td', null, p.ice == null ? h('span', { class: 'tiny muted', title: 'Entra senza account personale: niente ICE' }, 'senza account') : p.ice ? h('span', { class: 'chip chip-ok' }, 'compilato') : h('span', { class: 'chip chip-warn' }, 'non compilato')),
        h('td', null, p.safetyAckAt ? h('span', { class: 'chip chip-ok', title: `Letto e compreso alle ${fmtTime(p.safetyAckAt)}` }, 'letto') : h('span', { class: 'chip chip-blood' }, 'non letto'))))))));
  return h('div', { class: 'stack' },
    sectionActions('Pronti per la gara: notifiche, Traccar, ICE e sicurezza', [
      missing.length ? h('button', { class: 'btn btn-sm btn-primary', onclick: copyList }, `Copia l'elenco (${missing.length})`) : null],
      h('p', { class: 'muted tiny' }, 'Traccar: «verificato» = ha fatto la prova a schermo spento nell\'app (pagina Traccar); «non manda» = a partita in corso non arriva niente da 10 minuti. Senza Traccar la posizione si perde appena chiude l\'app.'),
      h('p', { class: 'muted tiny' }, 'In alto chi è a posto (✓), poi chi ha meno cose da sistemare (il numero dice quante). ICE: solo se è compilato, il contenuto la regia non lo vede mai (arriva solo con un\'emergenza). Sicurezza: ha letto e compreso l\'avviso pre-gara su EMERGENZA e ICE.'),
      h('p', { class: 'muted tiny' }, 'Senza notifiche una persona non riceve tradimenti, annunci, messaggi e avvisi quando l\'app è chiusa. Si attivano dall\'app con «Attiva le notifiche», su ogni telefono. «Solo telefono della coppia»: le riceve il telefono entrato con il codice della coppia, non quello personale.'),
      h('div', { class: 'row-actions' },
        h('span', { class: `chip ${off.length ? 'chip-blood' : 'chip-ok'}` }, `${off.length} senza notifiche`),
        h('span', { class: 'chip chip-warn' }, `${missing.length - off.length} solo sul telefono della coppia`),
        h('span', { class: 'chip chip-ok' }, `${rep.people.length - missing.length} con notifiche`),
        h('span', { class: `chip ${noTrk.length ? 'chip-warn' : 'chip-ok'}` }, `${noTrk.length} senza Traccar verificato`),
        h('span', { class: 'chip chip-ok' }, `${rep.people.filter((p) => p.ready).length} su ${rep.people.length} a posto`),
        h('span', { class: `chip ${rep.people.some((p) => p.ice === false) ? 'chip-warn' : 'chip-ok'}` }, `${rep.people.filter((p) => p.ice).length} ICE compilati`),
        h('span', { class: `chip ${rep.people.some((p) => !p.safetyAckAt) ? 'chip-blood' : 'chip-ok'}` }, `${rep.people.filter((p) => !p.safetyAckAt).length} senza avviso letto`),
        h('span', { class: 'tiny muted' }, `aggiornato ${fmtTime(rep.at)}`))),
    ...groups.filter((g) => g.all.length).map((g) => {
      const list = show(g.all);
      const n = g.all.filter(todo).length;
      return section(`${g.label} · ${n ? `${g.all.length - n} su ${g.all.length} a posto` : 'tutti a posto'}`, table(list));
    }),
    section(`Organizzazione · ${rep.staff.filter((u) => u.state === 'off').length} senza`,
      h('p', { class: 'muted tiny' }, 'Master e validatori: si attivano dalla regia con il pulsante 🔔 in alto.'),
      show(rep.staff).length ? table(show(rep.staff), true) : h('p', { class: 'empty' }, 'Tutti hanno le notifiche attive.')));
}

// Risultati di un sondaggio: conteggi e, aprendo, chi ha risposto cosa.
const POLL_LABEL = { si: 'Sì', no: 'No', forse: 'Forse' };
function pollResultsView(res) {
  const total = res.votes.length;
  return h('div', { class: 'poll-res' },
    h('div', { class: 'poll-counts' }, Object.entries(POLL_LABEL).map(([k, l]) => h('span', { class: `chip poll-chip-${k}` }, `${l}: ${res.counts[k] || 0}`)),
      h('span', { class: 'tiny muted' }, `${total} ${total === 1 ? 'risposta' : 'risposte'}`)),
    total ? h('details', null, h('summary', { class: 'tiny' }, 'Chi ha risposto'),
      h('ul', { class: 'poll-voters' }, Object.keys(POLL_LABEL).map((k) => {
        const list = res.votes.filter((v) => v.choice === k);
        return list.length ? h('li', null, h('strong', null, `${POLL_LABEL[k]}: `), list.map((v) => v.name).join(', ')) : null;
      }))) : null);
}

function viewNotices() {
  const ms = R.ms;
  const title = h('input', { class: 'input', 'data-keep': 'nt-title', placeholder: 'Titolo (es. Ritrovo anticipato)', maxlength: 80 });
  const editor = mdEditor({ rows: 6, maxlength: 4000, keep: 'nt-body', placeholder: 'Testo dell\'avviso', extra: ICE_TOOL });
  const body = editor.textarea;
  const teamSel = h('select', { class: 'input', 'data-keep': 'nt-team' }, ms.teams.map((t) => h('option', { value: t.id }, `${t.roman} · Settore ${t.sectorName}${t.displayName ? ` (${t.displayName})` : ''}`)));
  const teamWrap = h('label', { class: 'field hidden' }, h('span', null, 'Coppia'), teamSel);
  const poll = h('input', { type: 'checkbox', 'data-keep': 'nt-poll' });
  const target = h('select', { class: 'input', 'data-keep': 'nt-target', onchange: () => teamWrap.classList.toggle('hidden', target.value !== 'team') },
    Object.entries(ms.noticeTargets).map(([k, v]) => h('option', { value: k }, v)));
  queueMicrotask(() => teamWrap.classList.toggle('hidden', target.value !== 'team'));
  // Anteprima: stessa resa dell'app (markdown ridotto), aggiornata a ogni tasto.
  const preview = h('div', { class: 'notice-preview' });
  const drawPreview = () => {
    preview.replaceChildren(h('div', { class: 'np-card' },
      h('div', { class: 'np-head' }, h('span', { class: 'chip' }, ms.noticeTargets[target.value] || 'Per tutti'), h('span', { class: 'mono tiny muted' }, 'adesso')),
      h('h3', { class: 'np-title' }, poll.checked ? '📊 ' : '', title.value.trim() || 'Titolo dell\'avviso'),
      body.value.trim() ? h('div', { class: 'md' }, md(body.value)) : h('p', { class: 'muted tiny' }, 'Il testo comparirà qui.'),
      poll.checked ? h('div', { class: 'np-poll' }, ['Sì', 'No', 'Forse'].map((x) => h('span', { class: 'btn btn-sm' }, x))) : null));
  };
  for (const el of [title, body]) el.addEventListener('input', drawPreview);
  target.addEventListener('change', drawPreview);
  poll.addEventListener('change', drawPreview);
  queueMicrotask(drawPreview);

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
            const r = await api('POST', G('/notices'), { title: title.value, body: body.value, target: target.value, teamId: Number(teamSel.value) || null, poll: poll.checked });
            toast(`Avviso inviato · notifica a ${r.devices} dispositivi`, 'ok', 6000);
            title.value = '';
            body.value = '';
            load();
          } catch (err) { toast(err.message, 'error', 6000); }
        } },
        h('label', { class: 'field' }, h('span', null, 'Titolo'), title),
        h('div', { class: 'field' }, h('span', null, 'Testo'), editor.el),
        h('p', { class: 'tiny muted' }, 'Markdown: # titolo, **grassetto**, *corsivo*, - elenco, > citazione, riga vuota per un nuovo paragrafo. Un link come [Compila i dati ICE](#/ice) diventa un pulsante. Pagine dell\'app utili: #/ice, #/skill, #/mappa, #/doni, #/regolamento. «Schermo intero» apre l\'editor grande con l\'anteprima.'),
        h('label', { class: 'field' }, h('span', null, 'Destinatari'), target),
        teamWrap,
        h('label', { class: 'check' }, poll, ' 📊 Sondaggio: chi lo riceve risponde Sì / No / Forse'),
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Invia avviso'))),
      // Anteprima di come appare l'avviso nell'app, aggiornata mentre scrivi.
      section('Anteprima nell\'app', preview)),
    section(`Avvisi inviati (${ms.notices.length})`,
      ms.notices.length ? h('ul', { class: 'notice-list' }, ms.notices.map((n) => h('li', null,
        h('div', { class: 'grow' },
          h('div', { class: 'notice-head' }, h('strong', null, n.title), h('span', { class: 'chip' }, noticeTargetLabel(n)), h('span', { class: 'mono tiny muted' }, `${fmtTime(n.createdAt)} · ${n.author || 'regia'}`)),
          n.body ? h('p', null, n.body) : null,
          n.results ? pollResultsView(n.results) : null),
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
  f('altarScanMin', 'Validità scansione Altare (min, 0 = sempre)', 'number', { def: 15 }),
  // Anti «furbetto del QR»: raggio entro cui vale la lettura di un Altare piazzato (il controllo si accende in Regia).
  h('label', { class: 'field' }, h('span', null, 'Raggio di lettura degli Altari (controllo da accendere in Regia)'),
    h('select', { class: 'input', name: 'altarRadiusM', 'data-keep': 'gf-altarRadiusM' },
      (() => { const cur = Number(g?.altarRadiusM) > 0 ? Number(g.altarRadiusM) : 30; const o = [15, 25, 30, 50, 75, 100, 150, 200, 300]; return (o.includes(cur) ? o : [...o, cur].sort((a, b) => a - b))
        .map((v) => h('option', { value: v, selected: v === cur }, `${v} m${v === 30 ? ' (consigliato)' : ''}`)); })()),
    h('span', { class: 'tiny muted' }, 'La lettura vale quando il cerchio dell\'Altare (questo raggio) e il cerchio di incertezza del GPS del telefono (al massimo 50 m) si toccano; altrimenti viene rifiutata con la distanza. Gli Altari senza coordinate non si controllano.')),
  f('nodeScanMin', 'Validità scansione con Memoria del Nodo (min)', 'number', { def: 30, attrs: { min: 0 } }),
  f('eyeMin', 'Occhio del Consiglio: durata (min)', 'number', { def: 10, attrs: { min: 1 } }),
  f('eyeRadiusM', 'Occhio del Consiglio: raggio (m)', 'number', { def: 500, attrs: { min: 50 } }),
  f('maxCouples', 'Settori da aprire (vuoto = tutti)', 'number', { attrs: { min: 0, placeholder: 'tutti i Settori' } }),
  f('maxSingles', 'Posti temerari solitari (vuoto = nei posti coppie)', 'number', { attrs: { min: 0, placeholder: 'senza limite a parte' } }),
  f('maxActiveSkills', 'Skill attive o Ultimate per coppia', 'number', { def: 1, lock: true, attrs: { min: 0 } }),
  f('maxPassiveSkills', 'Skill passive per coppia', 'number', { def: 1, lock: true, attrs: { min: 0 } }),
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

// ---- inviti del Consiglio: un link monouso (24 ore) per entrare in regia o alla Soglia con il proprio account
let invites = null;
let lastInvite = null;
function invitesBlock() {
  if (!invites) {
    invites = [];
    api('GET', '/api/m/invites').then((r) => { invites = r; if (tab() === 'impostazioni') render(); }).catch(() => {});
  }
  const role = h('select', { class: 'input', 'data-keep': 'inv-role' }, h('option', { value: 'validator' }, 'Validatore (Soglia)'), h('option', { value: 'master' }, 'Master (regia)'));
  const create = async () => {
    if (role.value === 'master' && !(await dialog({ title: 'Invito da master?', text: 'Chi apre il link diventa master: vede tutto e comanda la partita. Mandalo solo alla persona giusta: vale una volta sola e per 24 ore.', okLabel: 'Crea il link', danger: true }))) return;
    try {
      lastInvite = await api('POST', '/api/m/invites', { role: role.value });
      invites = null;
      render();
    } catch (e) { toast(e.message, 'error'); }
  };
  const copy = (url) => navigator.clipboard?.writeText(url).then(() => toast('Link copiato', 'ok'));
  const until = (t) => new Date(t).toLocaleString('it-IT', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return h('div', { class: 'stack-sm' },
    h('strong', null, 'Invita con il suo account'),
    h('p', { class: 'muted tiny' }, 'Chi apre il link entra dal login principale, con username e password o con Zero Dark Ops, e diventa master o validatore. Il link vale una volta sola e per 24 ore.'),
    h('div', { class: 'row-actions' }, role, h('button', { class: 'btn btn-primary', onclick: create }, 'Crea link d\'invito')),
    lastInvite && invites?.some((i) => i.token === lastInvite.token) ? h('div', { class: 'card stack-sm' },
      h('span', { class: 'eyebrow' }, `Invito da ${lastInvite.role === 'master' ? 'master' : 'validatore'} · fino a ${until(lastInvite.expiresAt)}`),
      h('img', { src: `/api/m/qr.svg?text=${encodeURIComponent(lastInvite.url)}`, alt: 'QR dell\'invito', width: 160, height: 160 }),
      h('code', { class: 'mono tiny', style: 'word-break: break-all' }, lastInvite.url),
      h('button', { class: 'btn btn-sm', onclick: () => copy(lastInvite.url) }, 'Copia link')) : null,
    invites?.length ? h('ul', { class: 'users' }, invites.map((i) => h('li', null,
      h('span', { class: 'chip' }, i.role === 'master' ? 'master' : 'validatore'), h('span', { class: 'tiny muted' }, `in attesa · fino a ${until(i.expiresAt)}`),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: () => copy(i.url) }, 'Copia'),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: async () => { try { await api('DELETE', `/api/m/invites/${encodeURIComponent(i.token)}`); invites = null; render(); } catch (e) { toast(e.message, 'error'); } } }, 'Annulla')))) : null);
}

// ---- «Accedi con Zero Dark Ops»: gestionali delle squadre da cui i giocatori entrano (OpenID Connect).
let opsInfo = null;
let opsEdit = null; // null | 'new' | id del gestionale in modifica

function opsSection() {
  if (!opsInfo) {
    api('GET', '/api/m/settings/ops').then((r) => { opsInfo = r; render(); }).catch((e) => toast(e.message, 'error'));
    return section('Accesso con il gestionale', h('p', { class: 'empty' }, 'Caricamento…'));
  }
  const reload = () => { opsInfo = null; opsEdit = null; render(); };
  const editing = opsEdit === 'new' ? {} : opsInfo.providers.find((p) => p.id === opsEdit);
  const field = (label, attrs) => h('label', { class: 'field' }, h('span', null, label), h('input', { class: 'input', ...attrs }));
  const form = editing ? h('form', { class: 'form-grid', onsubmit: async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      await api(editing.id ? 'PUT' : 'POST', `/api/m/settings/ops${editing.id ? `/${editing.id}` : ''}`, body);
      toast('Gestionale salvato', 'ok');
      reload();
    } catch (err) { toast(err.message, 'error', 7000); }
  } },
  field('Nome sul pulsante', { name: 'name', value: editing.name || 'Zero Dark Ops', required: true, maxlength: 40, 'data-keep': 'ops-name' }),
  field('Indirizzo (issuer)', { name: 'issuer', value: editing.issuer || '', placeholder: 'https://ops.zerodarkteam.it', required: true, class: 'input mono', 'data-keep': 'ops-iss', inputmode: 'url', spellcheck: 'false' }),
  field('client_id', { name: 'clientId', value: editing.clientId || '', required: true, class: 'input mono', 'data-keep': 'ops-cid', spellcheck: 'false', autocomplete: 'off' }),
  field(editing.hasSecret ? 'client_secret (vuoto = invariato, "-" per toglierlo)' : 'client_secret (vuoto per le app senza segreto)', { name: 'clientSecret', type: 'password', class: 'input mono', 'data-keep': 'ops-sec', autocomplete: 'new-password' }),
  h('div', { class: 'row-actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Salva'), h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { opsEdit = null; render(); } }, 'Annulla'))) : null;
  const del = async (p) => {
    if (!(await dialog({ title: `Togliere ${p.name}?`, text: 'Il pulsante sparisce e da lì non si entra più. I collegamenti degli account restano: se lo riaggiungi con lo stesso indirizzo tornano a funzionare.', okLabel: 'Togli', danger: true }))) return;
    try { await api('DELETE', `/api/m/settings/ops/${p.id}`); toast('Gestionale tolto', 'ok'); reload(); } catch (e) { toast(e.message, 'error', 7000); }
  };
  return section('Accesso con il gestionale',
    h('p', { class: 'muted tiny' }, 'I giocatori entrano con l\'account del gestionale della loro squadra (Zero Dark Ops): niente password nuove, nome, callsign e squadra arrivano da lì. Nel gestionale, da admin: Sistema → App collegate → Nuova app, con questo indirizzo di ritorno:'),
    h('div', { class: 'url-now' }, h('span', { class: 'eyebrow' }, 'Indirizzo di ritorno'), h('strong', { class: 'mono' }, opsInfo.redirectUri),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: () => navigator.clipboard?.writeText(opsInfo.redirectUri).then(() => toast('Copiato', 'ok')) }, 'Copia')),
    /^http:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/.test(opsInfo.redirectUri) ? h('p', { class: 'tiny bad' }, 'Il gestionale accetta solo indirizzi https (o localhost per le prove): imposta prima l\'indirizzo pubblico https.') : null,
    opsInfo.providers.length ? h('ul', { class: 'users' }, opsInfo.providers.map((p) => h('li', null,
      h('strong', null, p.name), h('span', { class: 'mono tiny' }, p.issuer),
      h('span', { class: 'chip' }, p.hasSecret ? 'con segreto' : 'solo PKCE'),
      p.fromEnv ? h('span', { class: 'chip', title: 'OPS_ISSUER, OPS_CLIENT_ID, OPS_CLIENT_SECRET' }, 'dal file .env')
        : [h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { opsEdit = p.id; render(); } }, 'Modifica'), h('button', { class: 'btn btn-sm btn-ghost', onclick: () => del(p) }, 'Togli')]))) : h('p', { class: 'empty' }, 'Nessun gestionale collegato: si entra solo con username e password.'),
    form || h('button', { class: 'btn', onclick: () => { opsEdit = 'new'; render(); } }, '+ Aggiungi gestionale'),
    h('p', { class: 'muted tiny' }, 'Più squadre con il loro gestionale? Aggiungine uno per ciascuna: ognuno ha il suo pulsante.'));
}

// Account dei giocatori: restano tra una partita e l'altra; qui si cercano, si eliminano, si reimposta la password.
let accountsCache = null;
let accountsFilter = '';
async function loadAccounts() {
  try { accountsCache = await api('GET', '/api/m/accounts'); } catch (e) { toast(e.message, 'error'); accountsCache = []; }
  if (tab() === 'impostazioni') render();
}
function accountsSection() {
  if (!accountsCache) { loadAccounts(); return section('Account dei giocatori', h('p', { class: 'muted' }, 'Caricamento…')); }
  const f = accountsFilter.trim().toLowerCase();
  const list = accountsCache.filter((a) => !f || [a.username, a.name, a.nickname, a.softairTeam].some((x) => (x || '').toLowerCase().includes(f)));
  const orphans = accountsCache.filter((a) => !a.enrollments && !a.staff).length;
  const reset = async (a) => {
    const pwd = await dialog({ title: `Nuova password per @${a.username}`, text: `${a.name}: scrivi la nuova password (almeno 8 caratteri) e comunicagliela.`, okLabel: 'Imposta', input: { placeholder: 'nuova password' } });
    if (pwd) call('POST', `/api/m/accounts/${a.id}/password`, { password: pwd }, 'Password reimpostata');
  };
  const del = async (a) => {
    if (!(await dialog({ title: `Eliminare @${a.username}?`, text: `${a.name} non potrà più entrare con questo account.${a.active ? ' Le sue iscrizioni in attesa vengono cancellate.' : ''}`, okLabel: 'Elimina', danger: true }))) return;
    try { await api('DELETE', `/api/m/accounts/${a.id}`); toast('Account eliminato', 'ok'); loadAccounts(); load(); } catch (e) { toast(e.message, 'error', 7000); }
  };
  return sectionActions(`Account dei giocatori (${accountsCache.length})`, [
    h('button', { class: 'btn btn-sm', disabled: !orphans, title: 'Account che non sono iscritti a nessuna partita (es. di partite eliminate)', onclick: async () => {
      if (!(await dialog({ title: `Eliminare ${orphans} account senza iscrizioni?`, text: 'Sono account non iscritti a nessuna partita, per esempio di partite eliminate. Chi vorrà giocare dovrà registrarsi di nuovo.', okLabel: 'Elimina', danger: true }))) return;
      try { const r = await api('POST', '/api/m/accounts/cleanup'); toast(`${r.deleted} account eliminati`, 'ok'); loadAccounts(); } catch (e) { toast(e.message, 'error'); }
    } }, `Elimina senza iscrizioni (${orphans})`)],
    h('p', { class: 'muted tiny' }, 'Ogni giocatore si registra una volta e usa lo stesso account per tutte le partite: eliminando una partita si cancellano le iscrizioni, non gli account.'),
    h('input', { class: 'input input-sm', type: 'search', placeholder: 'Cerca per username, nome, team…', value: accountsFilter, 'data-keep': 'acc-filter', oninput: (e) => { accountsFilter = e.target.value; render(); } }),
    list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'elect-table' },
      h('thead', null, h('tr', null, ['Account', 'Team softair', 'Iscrizioni', ''].map((x) => h('th', null, x)))),
      h('tbody', null, list.map((a) => h('tr', null,
        h('td', null, h('strong', null, a.name), a.nickname ? h('span', { class: 'muted' }, ` «${a.nickname}»`) : null, h('div', { class: 'tiny brass' }, `@${a.username}`),
          a.ops ? h('span', { class: 'chip', title: a.hasPassword ? 'Entra anche con username e password' : 'Entra solo dal gestionale' }, a.hasPassword ? a.ops : `solo ${a.ops}`) : null,
          a.staff ? h('span', { class: 'chip chip-warn' }, a.staff === 'master' ? 'master' : 'validatore') : null),
        h('td', null, a.softairTeam || '—'),
        h('td', { class: 'tiny' }, a.enrollments ? a.games : h('span', { class: 'chip' }, 'nessuna')),
        h('td', { class: 'row-actions' },
          h('button', { class: 'btn btn-sm btn-ghost', onclick: () => reset(a) }, 'Password'),
          h('button', { class: 'btn btn-sm btn-ghost', onclick: () => del(a) }, 'Elimina'))))))) : h('p', { class: 'empty' }, f ? 'Nessun account trovato.' : 'Nessun account registrato.'));
}

// ---------------------------------------------------------------- CONSIGLIO ZERO
// Chi entra con Zero Dark Ops chiede l'accesso; qui il master lo accetta e sceglie le azioni che può fare.
let council = null;
const loadCouncil = () => api('GET', '/api/m/council').then((c) => { council = c; if (tab() === 'consiglio') render(); }).catch((e) => toast(e.message, 'error'));
const opsLine = (ops) => (ops || []).map((o) => [o.providerName, o.opsName, o.squadra].filter(Boolean).join(' · ')).join(' — ');
async function councilCall(method, url, body, okMsg) {
  try { await api(method, url, body); if (okMsg) toast(okMsg, 'ok'); } catch (e) { toast(e.message, 'error', 7000); }
  R.users = [];
  await loadCouncil();
  load();
}

function viewCouncil() {
  if (!council) { loadCouncil(); return h('p', { class: 'empty' }, 'Caricamento…'); }
  const { perms, requests, members } = council;
  const permBoxes = (on, onchange, disabled = false) => h('div', { class: 'council-perms' }, perms.map((p) => h('label', { class: 'council-perm', title: p.hint },
    h('input', { type: 'checkbox', value: p.key, checked: on.includes(p.key), disabled, onchange }), h('span', null, p.label))));
  const who = (x) => [h('strong', null, x.name || x.displayName || x.username), x.nickname ? h('span', { class: 'muted' }, ` «${x.nickname}»`) : null,
    h('div', { class: 'tiny muted' }, [x.accountUsername || x.username ? `@${x.accountUsername || x.username}` : null, x.softairTeam, opsLine(x.ops)].filter(Boolean).join(' · ')),
    phoneLinks(x.phone)];
  const reqCard = (r) => {
    const box = permBoxes(['accettazione', 'armi'], null);
    const chosen = () => [...box.querySelectorAll('input:checked')].map((i) => i.value);
    return h('li', { class: 'council-card' }, h('div', null, ...who(r), h('div', { class: 'tiny muted' }, `Chiesto il ${new Date(r.createdAt).toLocaleDateString('it-IT')} alle ${fmtTime(r.createdAt)}`)),
      h('div', { class: 'eyebrow' }, 'Cosa può fare'), box,
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-sm btn-primary', onclick: () => councilCall('POST', `/api/m/council/requests/${r.accountId}/accept`, { perms: chosen() }, `${r.name} è nel Consiglio Zero`) }, 'Accetta'),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: async () => { if (await dialog({ title: 'Rifiutare la richiesta?', text: r.name, okLabel: 'Rifiuta', danger: true })) councilCall('DELETE', `/api/m/council/requests/${r.accountId}`, undefined, 'Richiesta rifiutata'); } }, 'Rifiuta')));
  };
  const memberCard = (u) => {
    const me = u.id === R.me.id;
    const master = u.role === 'master';
    const box = permBoxes(u.perms, () => councilCall('PATCH', `/api/m/council/${u.id}`, { perms: [...box.querySelectorAll('input:checked')].map((i) => i.value) }, 'Azioni aggiornate'), master);
    const name = u.displayName || u.username;
    return h('li', { class: 'council-card' }, h('div', null, ...who(u), master ? h('span', { class: 'chip chip-warn' }, 'regia completa') : null, me ? h('span', { class: 'tiny muted' }, ' · tu') : null),
      master ? h('p', { class: 'tiny muted' }, 'Il master vede e fa tutto.') : box,
      me ? null : h('div', { class: 'row' },
        master ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => councilCall('PATCH', `/api/m/council/${u.id}`, { master: false }, `${name} non è più master`) }, 'Togli la regia')
          : h('button', { class: 'btn btn-sm', onclick: async () => { if (await dialog({ title: `Dare la regia completa a ${name}?`, text: 'Potrà fare tutto, anche cambiare le azioni degli altri.', okLabel: 'Dai la regia' })) councilCall('PATCH', `/api/m/council/${u.id}`, { master: true }, `${name} è master`); } }, 'Dai la regia completa'),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: async () => { if (await dialog({ title: 'Togliere dal Consiglio?', text: u.accountId ? `${name} non avrà più azioni; il suo account dei Giochi resta.` : `L'utente ${u.username} viene eliminato.`, okLabel: 'Togli', danger: true })) councilCall('DELETE', `/api/m/users/${u.id}`, undefined, 'Tolto dal Consiglio'); } }, 'Togli')));
  };
  const url = `${R.baseUrl || location.origin}/consiglio`;
  return h('div', { class: 'stack' },
    section(`Richieste d'accesso${requests.length ? ` · ${requests.length}` : ''}`,
      h('p', { class: 'muted small' }, 'Chi entra con Zero Dark Ops trova «Consiglio Zero» nell\'app e nel profilo (o apre ', h('a', { href: '/consiglio', target: '_blank', rel: 'noopener' }, url), ') e chiede di entrare. Scegli le azioni e accetta.'),
      requests.length ? h('ul', { class: 'council-list' }, requests.map(reqCard)) : h('p', { class: 'empty' }, 'Nessuna richiesta in attesa.')),
    section(`Membri · ${members.length}`,
      h('p', { class: 'muted small' }, 'Le spunte valgono subito, per tutte le partite. ', ...perms.map((p, i) => [i ? ' · ' : '', h('strong', null, p.label), `: ${p.hint.toLowerCase()}`])),
      h('ul', { class: 'council-list' }, members.map(memberCard))));
}

// Organizzazione: master e validatori (con password o entrati con un invito dal loro account).
function orgSection() {
  if (!R.users.length) api('GET', '/api/m/users').then((u) => { R.users = u; if (tab() === 'impostazioni') render(); }).catch(() => {});
  const uName = h('input', { class: 'input', placeholder: 'username', 'data-keep': 'u-name' });
  const uPass = h('input', { class: 'input', type: 'password', placeholder: 'password (min 6)', 'data-keep': 'u-pass', autocomplete: 'new-password' });
  const uRole = h('select', { class: 'input', 'data-keep': 'u-role' }, h('option', { value: 'validator' }, 'Validatore (Soglia)'), h('option', { value: 'master' }, 'Master (regia)'));
  return section('Organizzazione',
          h('ul', { class: 'users' }, R.users.map((u) => h('li', null, h('strong', null, u.displayName && u.accountId ? u.displayName : u.username), h('span', { class: 'chip' }, u.role === 'master' ? 'master' : 'validatore'),
            u.accountId ? h('span', { class: 'tiny brass', title: 'Entra con il suo account dei Giochi' }, `@${u.accountUsername}${u.ops ? ` · ${u.ops}` : ''}`) : null,
            u.id !== R.me.id ? h('button', { class: 'btn btn-sm btn-ghost', onclick: async () => { if (await confirmCall(u.accountId ? 'Togliere dall\'organizzazione?' : 'Eliminare l\'utente?', u.accountId ? `${u.displayName || u.username} non entrerà più in regia né alla Soglia; il suo account dei Giochi resta.` : u.username, 'DELETE', `/api/m/users/${u.id}`, undefined, u.accountId ? 'Tolto dall\'organizzazione' : 'Utente eliminato', true)) { R.users = []; render(); } } }, u.accountId ? 'Togli' : 'Elimina') : h('span', { class: 'tiny muted' }, 'tu'),
            u.accountId ? null : h('button', { class: 'btn btn-sm btn-ghost', onclick: async () => { const p = await dialog({ title: `Nuova password per ${u.username}`, input: { type: 'password', placeholder: 'min 6 caratteri' }, okLabel: 'Salva' }); if (p) call('PATCH', `/api/m/users/${u.id}`, { password: p }, 'Password aggiornata'); } }, 'Password')))),
          invitesBlock(),
          h('form', { class: 'form-grid', onsubmit: async (e) => {
            e.preventDefault();
            if (await call('POST', '/api/m/users', { username: uName.value, password: uPass.value, role: uRole.value }, 'Utente creato')) { R.users = []; uName.value = ''; uPass.value = ''; uName.dataset.fresh = uPass.dataset.fresh = '1'; render(); }
          } }, uName, uPass, uRole, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Aggiungi')));
}

// Il regolamento della partita (il link impostato nella partita, altrimenti il book dei Giochi) dentro la regia.
function viewRules() {
  const url = R.ms?.game?.bookUrl || '/regolamento.html';
  const local = url.startsWith('/');
  return h('div', { class: 'stack rules-view' },
    sectionActions('Regolamento', [
      // Stampa del solo regolamento: dalla finestra di stampa si sceglie «Salva come PDF».
      local ? h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => { try { document.querySelector('.rules-frame').contentWindow.print(); } catch { window.open(url, '_blank'); } } }, 'Stampa o salva PDF') : null,
      local ? h('a', { class: 'btn btn-sm', href: url, download: 'regolamento-giochi-del-buio.html' }, 'Scarica') : null,
      h('a', { class: 'btn btn-sm btn-ghost', href: url, target: '_blank', rel: 'noopener' }, 'Apri in una nuova scheda')],
      local ? null : h('p', { class: 'muted tiny' }, `Regolamento esterno (${url}): se qui sotto non si vede, aprilo in una nuova scheda.`),
      h('iframe', { class: 'rules-frame', src: url, title: 'Regolamento' })));
}

function viewNewGame(first) {
  return h('div', { class: 'stack' },
    section(first ? 'Benvenuto, Consiglio' : 'Nuova partita',
      first ? h('div', { class: 'first-steps' },
        h('strong', null, 'Non c\'è ancora nessuna partita.'),
        h('p', { class: 'muted' }, 'Il primo passo è crearne una (qui sotto) oppure una partita di prova: le altre voci del menu si attivano appena esiste una partita. Poi: iscrizioni e coppie → Sigilli → Altari e Parola → cerchio → VIA.')) : null,
      gameForm({ name: '', bookUrl: '/regolamento.html' }, true)),
    first ? opsSection() : null,
    first ? orgSection() : null,
    first ? accountsSection() : null,
    section('Vuoi solo provare?',
      h('p', { class: 'muted' }, 'Crea una partita di prova già preparata, con giocatori finti, e fai avanzare il tempo per vedere tutto il gioco in pochi minuti.'),
      h('button', { class: 'btn btn-primary', onclick: createDemo }, 'Crea partita di prova')));
}

// Prima della gara: testo in markdown (test armi, partenza…) che le coppie vedono nell'app finché la partita è in preparazione.
function prepSection(g) {
  const editor = mdEditor({ value: g.prepInfo || '', rows: 12, maxlength: 8000, keep: 'prep-info', placeholder: '## Test armi\nAlle 8:30 al cronografo…', extra: ICE_TOOL });
  const preview = h('div', { class: 'np-card' });
  const draw = () => mount(preview, editor.value.trim() ? h('div', { class: 'md' }, md(editor.value)) : h('p', { class: 'muted tiny' }, 'Il testo comparirà qui, come nell\'app.'));
  editor.textarea.addEventListener('input', draw);
  queueMicrotask(draw);
  return h('div', { class: 'cols-2' },
    section('Prima della gara · cosa fare',
      h('p', { class: 'muted tiny' }, 'Le coppie (e gli Eletti) lo vedono in home finché la partita è in preparazione: test armi, ritrovo, partenza, cosa portare. Al via sparisce.'),
      h('form', { class: 'stack-sm', onsubmit: (e) => { e.preventDefault(); call('PATCH', `/api/m/games/${g.id}`, { prepInfo: editor.value }, 'Testo salvato'); } },
        editor.el,
        h('p', { class: 'tiny muted' }, 'Markdown: # titolo, **grassetto**, *corsivo*, - elenco, 1. elenco numerato, > citazione, --- linea; [testo](https://…) diventa un pulsante. «Schermo intero» apre l\'editor grande con l\'anteprima.'),
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Salva'))),
    section('Anteprima nell\'app', h('div', { class: 'eyebrow' }, 'Prima della gara · cosa fare'), preview));
}

function viewSettings() {
  const ms = R.ms;
  const g = ms.game;
  const tpl = Object.keys(ms.templateLabels).map((k) => h('label', { class: 'field' }, h('span', null, ms.templateLabels[k]),
    h('textarea', { class: 'input', rows: 2, name: k, 'data-keep': `tpl-${k}`, value: g.templates[k] })));
  const timers = g.timers.map((t) => h('label', { class: 'field' }, h('span', null, `${t.label} (min)`), h('input', { class: 'input', type: 'number', step: '0.5', min: 0.5, name: t.id, value: t.minutes, 'data-keep': `tm-${t.id}` })));
  return h('div', { class: 'stack' },
    publicUrlSection(),
    opsSection(),
    section('Parametri della partita', gameForm(g, false)),
    prepSection(g),
    accountsSection(),
    h('div', { class: 'cols-2' },
      section('Testi degli annunci',
        h('p', { class: 'muted tiny' }, '[settore], [codice] e [posizione] si compilano in automatico.'),
        h('form', { class: 'stack-sm', onsubmit: (e) => { e.preventDefault(); call('PATCH', `/api/m/games/${g.id}`, { templates: Object.fromEntries(new FormData(e.target).entries()) }, 'Testi salvati'); } },
          tpl, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Salva testi'))),
      h('div', { class: 'stack' },
        section('Timer delle coppie',
          h('form', { class: 'form-grid', onsubmit: (e) => { e.preventDefault(); call('PATCH', `/api/m/games/${g.id}`, { timers: Object.fromEntries(new FormData(e.target).entries()) }, 'Timer salvati'); } },
            timers, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Salva timer'))),
        orgSection(),
        section('Notifiche alla regia',
          h('p', { class: 'muted tiny' }, 'Un avviso a ogni nuova iscrizione (coppie, temerari, candidature agli Eletti), ai messaggi delle coppie, agli scontri contestati e ai doni presi. Si attiva su ogni dispositivo (telefono, computer) dove vuoi riceverle.'),
          pushButton('btn')),
        section('Partita di prova',
          h('p', { class: 'muted tiny' }, 'Crea una nuova partita già preparata con giocatori finti, per provare il gioco.'),
          h('button', { class: 'btn', onclick: createDemo }, 'Crea partita di prova')),
        section('Zona pericolosa',
          h('button', { class: 'btn btn-danger', disabled: ACTIVE.includes(g.status) || g.status === 'paused', onclick: async () => {
            if (await confirmCall('Eliminare la partita?', `«${g.name}» e tutti i suoi dati (coppie, Sigilli, iscrizioni, registro) verranno cancellati definitivamente. Gli account dei giocatori restano: puoi eliminarli in "Account dei giocatori".`, 'DELETE', `/api/m/games/${g.id}`, undefined, 'Partita eliminata', true)) { accountsCache = null; await loadGames(); load(); }
          } }, 'Elimina partita')))));
}
