// PWA delle coppie (i Legati). Mobile first, offline first.
import { createMapView, watchPosition, landmarkItem, accuracyHint, SEND_MAX_ACC } from './map.js';
import { createField } from './field-ui.js';
import { h, mount, api, ApiError, makeClock, fmtDuration, fmtTime, ghost, ghostWord, toast, dialog, stream, vibrate, enablePush, store, STATUS_LABELS, voiceSupported, startRecording, uploadAudio, voicePlayer, fmtSec, scanQR, cameraSupported } from './lib.js';

const ACTIVE = ['truce', 'hunt', 'last_half_hour'];
const clock = makeClock();
const S = {
  state: null,
  auth: 'unknown', // unknown | team | none
  online: navigator.onLine,
  connected: false,
  queue: store.get('zdg_queue', []),
  visits: store.get('zdg_visits', {}), // qrToken -> { label, sectorName, at }
  altarResults: store.get('zdg_altar_results', {}), // qrToken -> { ok, message, fragment }
  settings: store.get('zdg_settings', { sound: false, sun: false }),
  timers: store.get('zdg_timers', []),
  seenAnn: store.get('zdg_seen_ann', 0),
  seenMsg: store.get('zdg_seen_msg', 0),
  seenNotice: store.get('zdg_seen_notice', 0),
  giftResults: {},
  unveiled: new Set(store.get('zdg_unveiled', [])),
};

const cached = store.get('zdg_state');
if (cached?.state) {
  S.state = cached.state;
  clock.set(cached.state.clock, cached.offset);
}

// Lavoro sul campo degli Eletti (incarichi, piazzamenti, mappa del campo), dentro la loro app.
const FE = { who: { role: 'elect', squad: null }, gameId: null, squadId: store.get('zdg_campo_squad'), data: null, me: null, geoError: null };
const field = createField(FE, { rerender: (tab) => { if (tab === 'mappa') location.hash = '#/mappa'; else render(); } });
const FIELD_VIEWS = ['campo', 'incarichi', 'mappa'];

const $app = document.getElementById('app');
const $overlay = document.getElementById('overlay');
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });

applyTheme();

// ---------------------------------------------------------------- avvio

function boot() {
  const m = location.pathname.match(/^\/a\/([\w-]+)/);
  if (m) {
    history.replaceState(null, '', `/#/altare/${m[1]}`);
    setTimeout(() => registerScan(m[1]));
  }
  const dm = location.pathname.match(/^\/d\/([\w-]+)/);
  if (dm) history.replaceState(null, '', `/#/dono/${dm[1]}`);
  if (new URLSearchParams(location.search).get('login') === 'invalid') {
    toast('Link di accesso non valido o rigenerato dalla regia', 'error', 7000);
    history.replaceState(null, '', '/' + location.hash);
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.addEventListener('hashchange', render);
  window.addEventListener('online', () => { S.online = true; refresh(); flushQueue(); render(); });
  window.addEventListener('offline', () => { S.online = false; render(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); flushQueue(); } });
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'refresh') refresh();
    if (e.data?.type === 'navigate' && e.data.hash) location.hash = e.data.hash;
  });
  setInterval(tickSecond, 1000);
  setInterval(() => { if (S.queue.length) flushQueue(); }, 15000);
  setInterval(() => { if (!S.connected && S.auth === 'team') refresh(); }, 30000);
  render();
  refresh().then(() => { if (S.auth === 'team') { connect(); flushQueue(); } });
}

async function refresh() {
  try {
    const st = await api('GET', '/api/team/state');
    S.online = true;
    // Account senza iscrizione a una partita: si sceglie come partecipare.
    if (st.noEnrollment) {
      S.account = st.account;
      S.state = null;
      S.auth = 'account';
      store.del('zdg_state');
      render();
      return;
    }
    const first = S.auth !== 'team';
    setState(st);
    S.auth = 'team';
    if (first) {
      connect();
      if ('Notification' in window && Notification.permission === 'granted') enablePush().catch(() => {});
    }
  } catch (e) {
    if (e.status === 401) {
      S.auth = 'none';
      S.state = null;
      store.del('zdg_state');
    } else if (e.offline) {
      S.online = false;
      S.auth = S.state ? 'team' : 'none';
    }
  }
  render();
}

function setState(st) {
  const prev = S.state;
  S.state = st;
  clock.set(st.clock);
  syncServerTimers(st);
  updateTracking(st);
  if (st.team.kind === 'elect') {
    const squad = st.field?.squad || null;
    const changed = FE.gameId !== st.game.id;
    FE.gameId = st.game.id;
    FE.who.squad = squad;
    if (squad) FE.squadId = squad.id;
    if (changed || FIELD_VIEWS.includes(route().view)) field.load();
  }
  if (prev?.combat && st.combat) {
    const seen = new Set([...prev.combat.incoming.map((r) => `r${r.id}`), ...prev.combat.toConfirm.map((e) => `e${e.id}`)]);
    const fresh = [...st.combat.incoming.map((r) => [`r${r.id}`, r.kind === 'break' ? `${r.team.sectorName} vuole rompere l'alleanza` : `${r.team.sectorName} vi propone un'alleanza`]),
      ...st.combat.toConfirm.map((e) => [`e${e.id}`, `${e.reporter.sectorName} dichiara di avervi sconfitto: confermate?`])].filter(([k]) => !seen.has(k));
    if (fresh.length) { vibrate([200, 100, 200, 100, 400]); beep(); for (const [, t] of fresh) toast(t, 'blood', 9000); }
  }
  store.set('zdg_state', { state: st, offset: clock.offset });
  // Allinea gli Altari visitati del server con quelli locali.
  for (const v of st.visited) rememberVisit(v.qrToken, { label: v.label, sectorName: v.sectorName });
  if (prev && prev.clock.status !== st.clock.status && st.clock.status === 'paused') vibrate([600, 200, 600]);
  if (prev && (prev.team.id !== st.team.id || prev.team.kind !== st.team.kind)) {
    if (sse) { sse.close(); sse = null; connect(); }
    if (prev.team.kind === 'lobby' && st.team.kind === 'couple') { vibrate([200, 100, 200, 100, 600]); toast(`Il Consiglio vi ha assegnato il Settore ${st.team.sector?.name || ''}`, 'blood', 9000); }
    if (prev.team.kind === 'lobby' && st.team.kind === 'elect') { vibrate([200, 100, 600]); toast('Siete tra gli Eletti del Consiglio', 'blood', 9000); }
  }
  // Eletti: un incarico nuovo per la propria squadra si fa sentire anche con l'app aperta.
  if (prev?.team.kind === 'elect' && st.team.kind === 'elect' && st.field?.items) {
    const seen = new Set((prev.field?.items || []).map((x) => x.key));
    const fresh = st.field.items.filter((x) => !seen.has(x.key));
    if (fresh.length && prev.field) {
      vibrate([200, 100, 200, 100, 400]);
      beep();
      for (const x of fresh.slice(0, 3)) toast(`Nuovo incarico: ${x.label}`, 'blood', 9000);
      if (document.hidden) localNotify(`Incarico per la squadra ${st.field.squad.name}`, fresh.map((x) => x.label).join(' · '), `task-${fresh[0].key}`, '/#/incarichi');
    }
  }
  if (prev?.team.kind === 'lobby' && st.team.kind === 'lobby' && prev.player?.status === 'pending' && st.player?.status === 'accepted') toast('Il Consiglio ha accettato la vostra candidatura', 'ok', 8000);
  // Primo accesso da questo dispositivo: parte il tour dell'app.
  if (!store.get('zdg_tour_done') && !S.tourShown) { S.tourShown = true; setTimeout(() => openTour(), 400); }
}

let sse = null;
function connect() {
  if (sse) return;
  sse = stream('/api/stream', {
    open: () => { S.connected = true; S.online = true; refresh(); flushQueue(); },
    error: () => { S.connected = false; render(); },
    state: () => refresh(),
    announcement: (a) => {
      vibrate([220, 100, 220, 100, 220]);
      beep();
      toast(a.text, 'blood', 9000);
      if (document.hidden) localNotify('Consiglio Zero', a.text, `ann-${a.id}`);
      refresh();
    },
    notice: (n) => {
      const st = S.state;
      if (!st || !noticeForMe(n, st.team)) return;
      vibrate([300, 120, 300, 120, 300]);
      beep();
      toast(`Avviso del Consiglio: ${n.title}`, 'blood', 9000);
      if (document.hidden) localNotify(`Avviso · ${n.title}`, n.body || 'Toccate per leggere l\'avviso.', `notice-${n.id}`, '/#/avvisi');
      refresh();
    },
    message: (m) => {
      vibrate([150, 80, 150]);
      const preview = m.audioMime ? '🎤 Messaggio vocale' : m.text;
      if (route().view !== 'messaggi') toast(`Messaggio dal Consiglio: ${preview}`, 'info', 8000);
      if (document.hidden) localNotify('Messaggio dal Consiglio', preview, `msg-${m.id}`, '/#/messaggi');
      S.chatScroll = true;
      refresh();
    },
  });
}

function noticeForMe(n, team) {
  if (team.kind === 'lobby') return n.target === 'all';
  return n.target === 'all' || (n.target === 'couples' && team.kind !== 'elect') || (n.target === 'elect' && team.kind === 'elect') || (n.target === 'team' && n.teamId === team.id);
}

async function localNotify(title, body, tag, url = '/') {
  try {
    if (Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    reg.showNotification(title, { body, tag, vibrate: [200, 100, 200], icon: '/icons/icon-192.png', badge: '/icons/badge.png', data: { url } });
  } catch { /* non disponibile */ }
}

let audioCtx;
function beep(force = false) {
  if (!S.settings.sound && !force) return;
  try {
    audioCtx ||= new AudioContext();
    const o = audioCtx.createOscillator();
    const gn = audioCtx.createGain();
    o.frequency.value = 880;
    gn.gain.setValueAtTime(0.25, audioCtx.currentTime);
    gn.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.6);
    o.connect(gn).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.6);
  } catch { /* audio non disponibile */ }
}

// ---------------------------------------------------------------- coda offline

function saveQueue() { store.set('zdg_queue', S.queue); }

function enqueue(kind, payload, label) {
  S.queue.push({ id: Date.now() + Math.random(), kind, payload, label, at: Date.now() });
  saveQueue();
  toast('Nessuna rete: salvato, verrà inviato appena torna il segnale', 'info', 5000);
  render();
}

let flushing = false;
async function flushQueue() {
  if (flushing || !S.queue.length || S.auth !== 'team') return;
  flushing = true;
  let changed = false;
  try {
    while (S.queue.length) {
      const item = S.queue[0];
      try {
        const res = await sendItem(item);
        handleResult(item, res, true);
      } catch (e) {
        if (e.offline) break;
        if (e.status === 429) break;
        handleResult(item, { ok: false, message: e.message }, true);
      }
      S.queue.shift();
      saveQueue();
      changed = true;
    }
  } finally {
    flushing = false;
    if (changed) { await refresh(); }
  }
}

function sendItem(item) {
  const p = item.payload;
  switch (item.kind) {
    case 'unlock': return api('POST', '/api/team/unlock', p);
    case 'fragment': return api('POST', '/api/team/fragment', p);
    case 'note': return api('POST', '/api/team/note', p);
    case 'visit': return api('GET', `/api/team/point/${encodeURIComponent(p.qrToken)}?at=${p.at || ''}`);
    case 'claim': return api('POST', '/api/team/gift/claim', p);
    default: return Promise.resolve({ ok: true });
  }
}

function handleResult(item, res, fromQueue) {
  const prefix = fromQueue ? 'Inviato: ' : '';
  if (item.kind === 'visit') {
    rememberVisit(item.payload.qrToken, { label: res.label, sectorName: res.sectorName, sectorId: res.sectorId, expiresAt: res.expiresAt });
    return;
  }
  if (item.kind === 'unlock') {
    S.altarResults[item.payload.qrToken] = { ok: res.ok, message: res.message, fragment: res.fragment, expired: res.expired, at: Date.now() };
    store.set('zdg_altar_results', S.altarResults);
    if (res.label) rememberVisit(item.payload.qrToken, { label: res.label });
    if (res.ok) {
      vibrate([90, 60, 90, 60, 300]);
      toast(`${prefix}${res.label || 'Altare'}: frammento «${res.fragment.text}»`, 'ok', 7000);
    } else {
      vibrate(300);
      toast(`${prefix}${res.label || 'Altare'}: ${res.message}`, 'error', 7000);
    }
  } else if (item.kind === 'fragment') {
    if (res.ok) { vibrate([90, 60, 300]); toast(`${prefix}frammento «${res.fragment.text}» aggiunto (${res.fragment.pointLabel})`, 'ok', 6000); }
    else toast(`${prefix}${res.message}`, 'error', 6000);
  } else if (item.kind === 'claim') {
    S.giftResults[item.payload.token] = { ok: res.ok !== false, gift: res.gift, message: res.message };
    if (res.gift) { vibrate([100, 60, 100, 60, 400]); toast(`${prefix}Dono preso: ${res.gift.icon} ${res.gift.name}`, 'ok', 8000); }
  } else if (item.kind === 'note') {
    if (res.correct) { vibrate([90, 60, 300]); toast(`${prefix}Sigillo ${res.sectorName}: CORRETTO`, 'ok', 6000); }
    else toast(`${prefix}${res.message || `Sigillo ${res.sectorName}: SBAGLIATO`}`, 'error', 6000);
  }
}

// Esegue subito se c'è rete, altrimenti mette in coda.
async function act(kind, payload, label) {
  if (!navigator.onLine) return enqueue(kind, payload, label);
  try {
    const res = await sendItem({ kind, payload });
    handleResult({ kind, payload }, res, false);
    refresh();
    return res;
  } catch (e) {
    if (e.offline) return enqueue(kind, payload, label);
    toast(e.message, 'error');
    return null;
  }
}

// Inquadrato un Altare: vale dall'ora di inquadratura (ora del server) per i minuti stabiliti dalla regia.
function registerScan(token) {
  const at = Math.round(clock.serverNow());
  const win = S.state?.game.altarScanMin || 0;
  rememberVisit(token, { scannedAt: at, expiresAt: win > 0 ? at + win * 60000 : null, at: Date.now() });
  delete S.altarResults[token];
  if (navigator.onLine) {
    api('GET', `/api/team/point/${encodeURIComponent(token)}?at=${at}`)
      .then((r) => { rememberVisit(token, { label: r.label, sectorName: r.sectorName, sectorId: r.sectorId, expiresAt: r.expiresAt }); refresh(); })
      .catch((e) => {
        if (e.offline) enqueue('visit', { qrToken: token, at }, 'riconoscimento Altare');
        else { toast(e.message, 'error'); delete S.visits[token]; store.set('zdg_visits', S.visits); location.hash = '#/altari'; }
      });
  } else enqueue('visit', { qrToken: token, at }, 'riconoscimento Altare');
}

function rememberVisit(token, info) {
  const prev = S.visits[token] || { at: Date.now() };
  S.visits[token] = { ...prev, ...Object.fromEntries(Object.entries(info).filter(([, v]) => v)) };
  store.set('zdg_visits', S.visits);
}

// ---------------------------------------------------------------- render

function route() {
  const [, view = 'home', arg] = (location.hash || '#/home').split('/');
  return { view, arg: arg ? decodeURIComponent(arg.split('?')[0]) : null, query: new URLSearchParams((location.hash.split('?')[1]) || '') };
}

// Conserva valori e focus dei campi durante i ridisegni.
function preserveInputs(fn) {
  const keep = {};
  let focusId = null;
  let sel = null;
  for (const el of $app.querySelectorAll('[data-keep]')) keep[el.dataset.keep] = el.value;
  const a = document.activeElement;
  if (a?.dataset?.keep) { focusId = a.dataset.keep; try { sel = [a.selectionStart, a.selectionEnd]; } catch { /* select */ } }
  fn();
  for (const el of $app.querySelectorAll('[data-keep]')) if (keep[el.dataset.keep] != null) el.value = keep[el.dataset.keep];
  if (focusId) {
    const el = $app.querySelector(`[data-keep="${focusId}"]`);
    if (el) { el.focus(); try { if (sel) el.setSelectionRange(...sel); } catch { /* select */ } }
  }
}

function render() {
  if (S.auth === 'unknown' && !S.state) return mount($app, h('div', { class: 'boot' }, h('div', { class: 'emblem' }, h('span', null, '0')), h('p', { class: 'eyebrow' }, 'Il Consiglio vi osserva…')));
  if (S.auth === 'none') return mount($app, viewLogin());
  if (S.auth === 'account') return mount($app, viewNoEnrollment());
  let { view, arg, query } = route();
  if (isElect() && ['sigillo', 'altari', 'altare', 'frammenti', 'codici', 'dono', 'doni'].includes(view)) view = 'home';
  if (isLobby() && ['altari', 'altare', 'frammenti', 'codici', 'messaggi', 'mappa', 'dono', 'doni', 'scontri'].includes(view)) view = 'home';
  if (isElect() && view === 'scontri') view = 'home';
  if (!isElect() && ['campo', 'incarichi'].includes(view)) view = 'home';
  if (view === 'mappa' && !isElect()) startMapGps(); else stopMapGps();
  if (isElect() && FIELD_VIEWS.includes(view)) { field.startGps(); if (!FE.data) field.load(); } else field.stopGps();
  if (view !== 'mappa') field.leaveMap();
  if (view === 'sigillo') openSeal(); else closeSeal();
  preserveInputs(() => {
    const body = ({
      home: viewHome, altari: viewAltars, altare: () => viewAltar(arg, query), frammenti: viewFragments, codici: viewNotebook,
      timer: viewTimers, annunci: viewAnnouncements, messaggi: viewMessages, regolamento: viewRules, impostazioni: viewSettings,
      avvisi: viewNotices, mappa: isElect() ? viewElectMap : viewMap, campo: viewElectField, incarichi: viewElectTasks, dono: () => viewGift(arg), doni: viewMyGifts, scontri: viewCombat,
    }[view] || viewHome)();
    const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120;
    mount($app, header(view), banners(), h('main', { class: view === 'messaggi' ? 'main main-chat' : 'main' }, body), radioBar());
    document.body.classList.toggle('chat-open', view === 'messaggi');
    if (view === 'messaggi' && (nearBottom || S.chatScroll)) { S.chatScroll = false; requestAnimationFrame(() => window.scrollTo(0, document.documentElement.scrollHeight)); }
  });
  if (view === 'annunci') markSeen('ann');
  if (view === 'messaggi') markSeen('msg');
  if (view !== 'messaggi') S.chatScroll = true;
  if (view === 'avvisi') markSeen('notice');
  updateClocks();
}

function header(view) {
  const st = S.state;
  const sec = st?.team.sector;
  const net = !S.online ? ['off', 'Senza rete'] : !S.connected ? ['wait', 'Riconnessione…'] : ['on', 'Collegati'];
  return h('header', { class: `top ${isElect() ? 'top-elect' : ''}` },
    view !== 'home' ? h('a', { class: 'back', href: '#/home', 'aria-label': 'Torna alla home' }, '‹') : h('div', { class: 'stamp' }, h('span', null, sec?.roman || '0')),
    h('div', { class: 'top-id' },
      h('div', { class: 'top-sector' }, isElect() ? 'Eletti del Consiglio' : isLobby() ? (st.player?.nickname || st.player?.name || 'Anteprima') : sec ? `Settore ${sec.name}` : 'Legati'),
      h('div', { class: 'top-sub' }, isElect() ? [st.player?.nickname || st.player?.name, st.field?.squad ? `Squadra ${st.field.squad.name}` : null].filter(Boolean).join(' · ')
        : st?.team.displayName || st?.team.members.map((m) => m.nickname || m.name).join(' · ') || '')),
    h('div', { class: 'top-clock' },
      h('div', { class: 'top-time' },
        h('span', { class: `net-dot net-${net[0]}`, role: 'img', 'aria-label': net[1], title: net[1] }),
        h('span', { class: 'mono big', 'data-clock': 'remaining' }, '—')),
      h('div', { class: `top-phase ${st?.clock.status === 'paused' ? 'paused' : ''}` }, STATUS_LABELS[st?.clock.status] || '')));
}

function banners() {
  const st = S.state;
  if (!st) return null;
  const c = st.clock;
  const out = [];
  if (c.status === 'paused') out.push(h('div', { class: 'banner banner-pause', role: 'alert' }, h('strong', null, 'PARTITA SOSPESA'), h('span', null, `Fermatevi e ascoltate il canale radio d'emergenza${st.game.emergencyRadioChannel ? ': ' + st.game.emergencyRadioChannel : ''}`)));
  if (c.status === 'truce') out.push(h('div', { class: 'banner banner-truce' }, h('strong', null, 'Tregua: nessun ingaggio'), h('span', null, 'La caccia si apre tra ', h('b', { class: 'mono', 'data-clock': 'hunt' }, '—'))));
  if (c.status === 'last_half_hour') out.push(h('div', { class: 'banner banner-last' }, h('strong', null, 'Ultima mezz\'ora'), h('span', null, 'Il Consiglio non tradirà più nessuno.')));
  if (!S.online) out.push(h('div', { class: 'banner banner-offline' }, h('span', null, 'Senza rete: l\'app funziona, i dati si aggiornano al ritorno del segnale.')));
  if (S.queue.length) out.push(h('div', { class: 'banner banner-queue' }, h('strong', null, `${S.queue.length} in attesa di rete`), h('span', null, S.queue.map((q) => q.label).join(' · '))));
  if (st.openNew) out.push(h('a', { class: 'banner banner-action', href: '/iscrizione#scelta' }, h('strong', null, 'Nuova partita aperta'), h('span', null, 'Iscriviti ai prossimi Giochi del Buio')));
  if (combatPending(st) && route().view !== 'scontri') out.push(h('a', { class: 'banner banner-action', href: '#/scontri' }, h('strong', null, 'Risposta richiesta'), h('span', null, [...st.combat.incoming.map((r) => r.kind === 'break' ? `${r.team.sectorName}: rottura dell'alleanza` : `${r.team.sectorName} propone un'alleanza`), ...st.combat.toConfirm.map((e) => `${e.reporter.sectorName}: confermate la sconfitta?`)].join(' · '))));
  return out.length ? h('div', { class: 'banners' }, out) : null;
}

function radioBar() {
  const ch = S.state?.game.emergencyRadioChannel;
  return h('footer', { class: 'radio' }, h('span', { class: 'eyebrow' }, 'Radio SOS'), h('strong', { class: 'mono', title: ch || '' }, ch || 'chiedete alla regia'));
}

function updateClocks() {
  const c = clock.snap;
  for (const el of document.querySelectorAll('[data-clock]')) {
    const kind = el.dataset.clock;
    let txt = '—';
    if (kind === 'wall') txt = fmtTime(clock.serverNow(), true);
    else if (c) {
      if (kind === 'remaining') txt = c.startedAt ? fmtDuration(clock.remaining()) : fmtDuration(c.durationMs);
      else if (kind === 'elapsed') txt = fmtDuration(clock.elapsed());
      else if (kind === 'hunt') txt = fmtDuration(Math.max(0, c.huntAtMs - clock.elapsed()), false);
    }
    if (el.textContent !== txt) el.textContent = txt;
  }
  let due = false;
  for (const el of document.querySelectorAll('[data-abs]')) {
    const left = Number(el.dataset.abs) - clock.serverNow();
    const t = fmtDuration(Math.max(0, left), false);
    if (el.textContent !== t) el.textContent = t;
    if (left <= 0) due = true;
  }
  // Una scansione è appena scaduta: ridisegna la pagina (sparisce il pulsante di sblocco).
  if (due && !updateClocks.redrawn) { updateClocks.redrawn = true; setTimeout(() => { updateClocks.redrawn = false; render(); }, 300); }
  for (const el of document.querySelectorAll('[data-timer]')) {
    const t = S.timers.find((x) => x.uid === el.dataset.timer);
    if (t) el.textContent = t.done ? '00:00' : fmtDuration(Math.max(0, t.endsAt - Date.now()), false);
  }
}

function tickSecond() {
  updateClocks();
  const rt = document.getElementById('rec-time');
  if (rt && S.rec) rt.textContent = fmtSec(Date.now() - S.rec.startedAt);
  checkTimers();
  // Passaggi di stato previsti (tregua → caccia, fine): ricarica dal server al momento giusto.
  const c = clock.snap;
  if (c?.running) {
    const e = clock.elapsed();
    if ((c.status === 'truce' && e >= c.huntAtMs) || (c.status === 'hunt' && e >= c.lastPhaseAtMs) || e >= c.durationMs) {
      if (!tickSecond.pending) { tickSecond.pending = true; setTimeout(() => { tickSecond.pending = false; refresh(); }, 1500); }
    }
  }
}

function markSeen(kind) {
  const st = S.state;
  if (!st) return;
  if (kind === 'ann') { const id = st.announcements[0]?.id || 0; if (id > S.seenAnn) { S.seenAnn = id; store.set('zdg_seen_ann', id); } }
  if (kind === 'msg') { const id = st.messages.at(-1)?.id || 0; if (id > S.seenMsg) { S.seenMsg = id; store.set('zdg_seen_msg', id); } }
  if (kind === 'notice') { const id = st.notices?.[0]?.id || 0; if (id > S.seenNotice) { S.seenNotice = id; store.set('zdg_seen_notice', id); } }
}

// Animazione di svelamento una sola volta per segreto.
function unveilOnce(key) {
  if (S.unveiled.has(key)) return '';
  S.unveiled.add(key);
  store.set('zdg_unveiled', [...S.unveiled]);
  return 'unveil';
}

// ---------------------------------------------------------------- login

function viewLogin() {
  const pendingAltar = Object.keys(S.visits).length && location.hash.startsWith('#/altare/');
  const user = h('input', { class: 'input', id: 'login-user', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
  const pass = h('input', { class: 'input', id: 'login-pass', type: 'password', autocomplete: 'current-password', required: true });
  const code = h('input', { class: 'input input-code', id: 'access', autocomplete: 'one-time-code', autocapitalize: 'characters', spellcheck: 'false', maxlength: 12, placeholder: '········', 'aria-label': 'Codice d\'accesso' });
  // Username e password: la regia va in regia (o alla Soglia), i giocatori restano nell'app.
  const login = async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/api/auth/login', { username: user.value, password: pass.value });
      vibrate(80);
      if (r.role !== 'player') { location.href = r.home; return; }
      await refresh();
    } catch (err) { toast(err.offline ? 'Serve la rete per accedere' : err.message, 'error'); }
  };
  const byCode = async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/team/login', { accessCode: code.value });
      vibrate(80);
      await refresh();
    } catch (err) { toast(err.offline ? 'Serve la rete per il primo accesso' : err.message, 'error'); }
  };
  return h('main', { class: 'login' },
    h('div', { class: 'emblem big' }, h('span', null, '0')),
    h('p', { class: 'eyebrow' }, 'Consiglio Zero · Zero Dark Games'),
    h('h1', null, 'I Giochi', h('br'), 'del ', h('em', null, 'Buio')),
    pendingAltar ? h('p', { class: 'note' }, 'Avete inquadrato un Altare. Entrate: l\'Altare resterà nella vostra lista.') : null,
    h('form', { class: 'login-form', onsubmit: login },
      h('label', { class: 'field', for: 'login-user' }, h('span', null, 'Username')), user,
      h('label', { class: 'field', for: 'login-pass' }, h('span', null, 'Password')), pass,
      h('button', { class: 'btn btn-primary btn-xl btn-block', type: 'submit' }, 'Entra')),
    h('a', { class: 'btn btn-block', href: '/iscrizione' }, 'Non hai un account? Registrati'),
    h('details', { class: 'login-alt' },
      h('summary', null, 'Hai un QR o un codice d\'accesso del Consiglio?'),
      h('form', { class: 'login-form', onsubmit: byCode },
        h('label', { class: 'field', for: 'access' }, h('span', null, 'Codice d\'accesso')), code,
        h('button', { class: 'btn btn-block', type: 'submit' }, 'Entra con il codice')),
      h('button', { class: 'btn btn-block', type: 'button', onclick: scanLogin }, '⌖ Scansiona il QR di accesso')));
}

// Account senza iscrizione alla partita aperta: si sceglie la sfida dalla pagina di iscrizione.
function viewNoEnrollment() {
  const a = S.account || {};
  return h('main', { class: 'login' },
    h('div', { class: 'emblem big' }, h('span', null, '0')),
    h('p', { class: 'eyebrow' }, `Account · ${a.username || ''}`),
    h('h1', null, a.nickname || a.name || 'Benvenuto'),
    h('p', { class: 'muted' }, 'Non sei ancora iscritto a una partita. Scegli come entrare nel buio: Legati, Temerario Solitario o Eletti del Consiglio.'),
    h('a', { class: 'btn btn-primary btn-xl btn-block', href: '/iscrizione#scelta' }, 'Scegli la tua sfida'),
    h('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: async () => {
      try { await api('POST', '/api/team/logout'); } catch { /* offline */ }
      location.href = '/';
    } }, 'Esci'));
}

// ---------------------------------------------------------------- home

const isElect = () => S.state?.team.kind === 'elect';
const isLobby = () => S.state?.team.kind === 'lobby';

// Invito ad attivare le notifiche (Android: arrivano anche a schermo spento).
function pushInvite() {
  if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) {
    return isSecureContext ? null : h('div', { class: 'card push-invite' }, h('strong', null, 'Notifiche non disponibili'), h('p', { class: 'muted small' }, 'Aprite l\'app dall\'indirizzo https del Consiglio per ricevere gli avvisi sul telefono.'));
  }
  if (Notification.permission === 'granted' || S.settings.pushDismissed) return null;
  if (Notification.permission === 'denied') {
    return h('div', { class: 'card push-invite' }, h('strong', null, 'Notifiche bloccate'), h('p', { class: 'muted small' }, 'Per ricevere gli avvisi: impostazioni del browser → Notifiche → consenti per questo sito.'));
  }
  return h('div', { class: 'card push-invite' },
    h('strong', null, 'Ricevete gli avvisi del Consiglio'),
    h('p', { class: 'muted small' }, 'Attivate le notifiche: avvisi e annunci arriveranno sul telefono anche a schermo spento. Toccandoli si apre la pagina giusta.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn btn-primary', onclick: async () => { try { await enablePush(); toast('Notifiche attive', 'ok'); render(); } catch (e) { toast(e.message, 'error', 7000); render(); } } }, 'Attiva le notifiche'),
      h('button', { class: 'btn btn-ghost', onclick: () => { S.settings.pushDismissed = true; store.set('zdg_settings', S.settings); render(); } }, 'Non ora')));
}

function latestNotice(st) {
  const n = st.notices?.[0];
  if (!n || n.id <= S.seenNotice) return null;
  return h('a', { class: 'last-ann new notice-card', href: '#/avvisi' }, h('div', { class: 'eyebrow' }, `Avviso · ${fmtTime(n.createdAt)}`), h('strong', null, n.title), n.body ? h('p', null, n.body) : null);
}

const ROLE_TEXT = {
  pair: 'Candidati come Legati',
  single: 'Candidato come Temerario Solitario',
  elect: 'Candidato agli Eletti del Consiglio',
};

function viewLobbyHome(st) {
  const pl = st.player || {};
  const pending = pl.status === 'pending';
  const unreadNot = (st.notices || []).filter((n) => n.id > S.seenNotice).length;
  const unreadAnn = st.announcements.filter((a) => a.id > S.seenAnn).length;
  const partner = st.team.members.find((m) => m.name !== pl.name);
  return h('div', { class: 'home' },
    h('div', { class: 'phase' },
      h('div', { class: 'eyebrow' }, 'Anteprima · ', ROLE_TEXT[pl.role] || 'Iscritto'),
      h('div', { class: 'phase-big' }, pending ? 'Candidatura in attesa' : 'Il Consiglio vi ha accettati'),
      h('p', { class: 'muted' }, pending
        ? 'Il Consiglio sta valutando la vostra candidatura. Intanto esplorate l\'app: quando sarete accettati e avrete il vostro Settore, questo telefono si aggiornerà da solo.'
        : pl.role === 'single' ? 'Il Consiglio sta estraendo il vostro compagno e il Settore. L\'app si aggiornerà da sola.' : 'Il Consiglio sta formando le coppie e assegnando i Settori. L\'app si aggiornerà da sola.'),
      partner ? h('p', { class: 'small' }, 'Il vostro Legato: ', h('strong', null, partner.name), partner.nickname ? ` «${partner.nickname}»` : '') : null),
    pushInvite(),
    latestNotice(st),
    h('a', { class: 'btn btn-primary btn-seal', href: '#/sigillo' }, h('span', { class: 'seal-ico' }, '?'), 'Il vostro Sigillo'),
    h('nav', { class: 'grid' },
      h('button', { class: 'tile', onclick: () => openTour() }, h('span', { class: 'tile-ico', 'aria-hidden': 'true' }, '▶'), h('span', null, 'Il tour dell\'app')),
      tile('#/avvisi', 'Avvisi', '!', unreadNot || null, unreadNot),
      tile('#/annunci', 'Annunci', '✉', unreadAnn || null, unreadAnn),
      tile('#/timer', 'Timer', '◷', S.timers.filter((t) => !t.done).length || null),
      tile('#/regolamento', 'Regolamento', '§'),
      tile('#/impostazioni', 'Impostazioni', '⚙')),
    accountBar(st),
    pl.accessCode ? h('div', { class: 'card' }, h('div', { class: 'eyebrow' }, 'Il tuo codice personale'), h('div', { class: 'mono big-text' }, pl.accessCode),
      h('p', { class: 'muted small' }, 'Serve per entrare da un altro telefono. Tenetelo per voi.')) : null);
}

function viewElectHome(st) {
  const c = st.clock;
  const unreadAnn = st.announcements.filter((a) => a.id > S.seenAnn).length;
  const unreadMsg = st.messages.filter((m) => m.fromRole === 'master' && m.id > S.seenMsg).length;
  const unreadNot = (st.notices || []).filter((n) => n.id > S.seenNotice).length;
  const lastAnn = st.announcements[0];
  return h('div', { class: 'home' },
    h('div', { class: 'phase' },
      h('div', { class: 'eyebrow' }, STATUS_LABELS[c.status]),
      c.running || c.status === 'paused' ? h('div', { class: 'phase-clock mono', 'data-clock': 'remaining' }, '—') : h('div', { class: 'phase-big' }, c.status === 'ended' ? 'I Giochi sono finiti' : 'Al servizio del Consiglio'),
      h('p', { class: 'muted' }, 'Gli Eletti tengono in piedi i Giochi e ne difendono i luoghi. Seguite gli avvisi e i messaggi della regia.')),
    supplyCard(st),
    trackingNote(st),
    st.field?.squad ? h('a', { class: 'squad-home', href: '#/incarichi', style: { '--c': st.field.squad.color } },
      h('span', { class: 'eyebrow' }, 'La tua squadra'), h('strong', null, st.field.squad.name),
      h('span', { class: st.field.todo ? 'bad-text small' : 'ok-text small' }, st.field.todo ? `${st.field.todo} incarichi da fare` : 'Nessun incarico in sospeso')) : null,
    pushInvite(),
    latestNotice(st),
    st.standings ? h('div', { class: 'card final' }, h('div', { class: 'eyebrow' }, 'Classifica finale'),
      h('ol', { class: 'final-list' }, st.standings.map((r) => h('li', { class: r.status === 'won' ? 'won-row' : '' }, h('span', { class: 'mono' }, r.rank), h('strong', null, `${r.roman} ${r.sectorName}`), h('span', { class: 'mono' }, r.status === 'won' ? 'Soglia' : r.fragments))))) : null,
    lastAnn ? h('a', { class: `last-ann ${lastAnn.id > S.seenAnn ? 'new' : ''}`, href: '#/annunci' }, h('div', { class: 'eyebrow' }, `Consiglio Zero · ${fmtTime(lastAnn.createdAt)}`), h('p', null, lastAnn.text)) : null,
    h('a', { class: 'btn btn-primary btn-seal', href: '#/campo' }, h('span', { class: 'seal-ico' }, '⌖'), 'Piazza Altari e Doni'),
    h('nav', { class: 'grid' },
      h('button', { class: 'tile tile-scan', type: 'button', onclick: () => field.scanSign() }, h('span', { class: 'tile-ico', 'aria-hidden': 'true' }, '⌖'), h('span', null, 'Scansiona'), h('span', { class: 'tiny muted' }, 'Altare o dono')),
      tile('#/incarichi', 'Incarichi', '☰', st.field?.todo || null, st.field?.todo),
      tile('#/mappa', 'Mappa del campo', '⛰'),
      tile('#/avvisi', 'Avvisi', '!', unreadNot || null, unreadNot),
      tile('#/annunci', 'Annunci', '✉', unreadAnn || null, unreadAnn),
      tile('#/messaggi', 'Regia', '☏', unreadMsg || null, unreadMsg),
      tile('#/timer', 'Timer', '◷', S.timers.filter((t) => !t.done).length || null),
      tile('#/regolamento', 'Regolamento', '§'),
      tile('#/impostazioni', 'Impostazioni', '⚙')),
    accountBar(st),
    h('div', { class: 'card' }, h('div', { class: 'eyebrow' }, `Gli Eletti (${st.team.members.length})`),
      h('ul', { class: 'elect-members' }, st.team.members.map((m) => h('li', null, m.name, m.nickname ? h('span', { class: 'muted' }, ` «${m.nickname}»`) : null)))));
}

function viewHome() {
  const st = S.state;
  if (!st) return h('p', { class: 'empty' }, 'Caricamento…');
  if (isElect()) return viewElectHome(st);
  if (isLobby()) return viewLobbyHome(st);
  const unreadNot = (st.notices || []).filter((n) => n.id > S.seenNotice).length;
  const c = st.clock;
  const total = st.fragments.length;
  const owned = st.fragments.filter((f) => f.text).length;
  const lastAnn = st.announcements[0];
  const unreadAnn = st.announcements.filter((a) => a.id > S.seenAnn).length;
  const unreadMsg = st.messages.filter((m) => m.fromRole === 'master' && m.id > S.seenMsg).length;

  let phase;
  if (c.status === 'draft' || c.status === 'ready') phase = h('div', { class: 'phase' }, h('div', { class: 'eyebrow' }, 'In attesa'), h('div', { class: 'phase-big' }, 'Il cerchio non è ancora aperto'), h('p', { class: 'muted' }, st.game.scheduledStart ? `Inizio previsto: ${new Date(st.game.scheduledStart).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' })}. ` : '', 'Leggete il regolamento. Il vostro Sigillo apparirà nel cerchio.'));
  else if (c.status === 'circle') phase = h('div', { class: 'phase' }, h('div', { class: 'eyebrow' }, 'Nel cerchio'), h('div', { class: 'phase-big' }, 'In attesa del via'), h('p', { class: 'muted' }, 'Il vostro Sigillo è svelato. Memorizzatelo e non mostratelo a nessuno.'));
  else if (c.status === 'ended') phase = h('div', { class: 'phase' }, h('div', { class: 'eyebrow' }, 'Fine'), h('div', { class: 'phase-big' }, st.team.finishPosition ? `Siete arrivati ${['', 'primi', 'secondi', 'terzi'][st.team.finishPosition] || st.team.finishPosition + '°'}` : 'I Giochi del Buio sono finiti'), h('p', { class: 'muted' }, 'Abbassate le armi e tornate al Cuore.'));
  else phase = h('div', { class: 'phase' }, h('div', { class: 'eyebrow' }, 'Tempo rimanente'), h('div', { class: 'phase-clock mono', 'data-clock': 'remaining' }, '—'), h('div', { class: 'muted mono small' }, 'trascorso ', h('span', { 'data-clock': 'elapsed' }, '—')));

  return h('div', { class: 'home' },
    st.team.status === 'won' ? h('div', { class: 'won' }, h('strong', null, `Avete pronunciato la Parola alla Soglia${st.team.finishPosition ? ` · ${st.team.finishPosition}° posto` : ''}`), h('span', null, 'Il vostro Settore è libero.')) : null,
    st.team.status === 'withdrawn' ? h('div', { class: 'banner banner-pause' }, h('strong', null, 'Coppia ritirata dalla regia')) : null,
    phase,
    supplyCard(st),
    trackingNote(st),
    st.combat?.alliance ? h('a', { class: 'ally-strip', href: '#/scontri' }, h('span', { class: 'eyebrow' }, 'Alleati'), h('strong', null, st.combat.alliance.members.filter((m) => m.teamId !== st.team.id).map((m) => `${m.roman} ${m.sectorName}`).join(' · '))) : null,
    pushInvite(),
    latestNotice(st),
    st.standings ? h('div', { class: 'card final' },
      h('div', { class: 'eyebrow' }, 'Classifica finale'),
      h('ol', { class: 'final-list' }, st.standings.map((r) => h('li', { class: `${r.mine ? 'mine' : ''} ${r.status === 'won' ? 'won-row' : ''}` },
        h('span', { class: 'mono' }, r.rank), h('strong', null, `${r.roman} ${r.sectorName}`),
        h('span', { class: 'mono' }, r.status === 'won' ? 'Soglia' : `${r.fragments}/${total}`))))) : null,
    h('a', { class: 'progress', href: '#/frammenti' },
      h('div', { class: 'progress-head' }, h('span', { class: 'eyebrow' }, 'La Parola'), h('strong', { class: 'mono' }, `Frammenti: ${owned} / ${total || '?'}`)),
      h('div', { class: 'segments' }, st.fragments.map((f) => h('i', { class: f.text ? 'on' : '' })))),
    owned && owned === total ? h('div', { class: 'won' }, h('strong', null, 'Avete la Parola intera.'), h('span', null, 'Portatela alla Soglia.')) : null,
    lastAnn ? h('a', { class: `last-ann ${lastAnn.id > S.seenAnn ? 'new' : ''}`, href: '#/annunci' }, h('div', { class: 'eyebrow' }, `Consiglio Zero · ${fmtTime(lastAnn.createdAt)}`), h('p', null, lastAnn.text)) : null,
    h('a', { class: 'btn btn-primary btn-seal', href: '#/sigillo' }, h('span', { class: 'seal-ico' }, st.team.sector?.roman || '0'), 'Il mio Sigillo'),
    h('nav', { class: 'grid' },
      h('button', { class: 'tile tile-scan', type: 'button', onclick: openScanner }, h('span', { class: 'tile-ico', 'aria-hidden': 'true' }, '⌖'), h('span', null, 'Scansiona'), h('span', { class: 'tiny muted' }, 'Altare o dono')),
      tile('#/mappa', 'Mappa', '⛰', (st.map?.gifts.length || null), st.map?.gifts.length),
      tile('#/altari', 'Altari visitati', '⛬', allVisited().length || null),
      tile('#/doni', 'I vostri doni', '✦', (st.gifts || []).filter((g) => !g.usedAt).length || null),
      tile('#/scontri', 'Alleanze e scontri', '⚔', combatPending(st) || null, combatPending(st)),
      tile('#/frammenti', 'Frammenti', '❖', `${owned}/${total || '?'}`),
      tile('#/codici', 'Codici', '✱'),
      tile('#/avvisi', 'Avvisi', '!', unreadNot || null, unreadNot),
      tile('#/annunci', 'Annunci', '✉', unreadAnn || null, unreadAnn),
      tile('#/messaggi', 'Regia', '☏', unreadMsg || null, unreadMsg),
      tile('#/timer', 'Timer', '◷', S.timers.filter((t) => !t.done).length || null),
      tile('#/regolamento', 'Regolamento', '§'),
      tile('#/impostazioni', 'Impostazioni', '⚙')),
    accountBar(st));
}

function supplyCard(st) {
  const open = (st.supplyOpen || []).filter((x) => x.closesAt > clock.serverNow());
  if (!open.length) return null;
  return open.map((x) => h('a', { class: 'supply-card', href: '#/annunci' },
    h('span', { class: 'eyebrow' }, 'Armamenti al Cuore · aperti'),
    h('strong', null, 'Chiude tra ', h('span', { class: 'mono', 'data-abs': x.closesAt }, '—')),
    x.text ? h('span', { class: 'small muted' }, x.text) : null));
}

function tile(href, label, icon, badge, alert) {
  return h('a', { class: 'tile', href }, h('span', { class: 'tile-ico', 'aria-hidden': 'true' }, icon), h('span', null, label), badge ? h('span', { class: `badge ${alert ? 'badge-alert' : ''}` }, badge) : null);
}

// ---------------------------------------------------------------- Alleanze e scontri

const combatPending = (st) => (st?.combat ? st.combat.incoming.length + st.combat.toConfirm.length : 0);
let combatOpp = null;

async function combatCall(url, body, okMsg) {
  try {
    const r = await api('POST', url, body);
    if (okMsg) toast(okMsg, 'ok', 6000);
    vibrate(60);
    await refresh();
    return r;
  } catch (e) {
    toast(e.offline ? 'Serve la rete: riprovate appena c\'è segnale' : e.message, 'error', 7000);
    return null;
  }
}

const teamName = (t) => `${t.roman} ${t.sectorName}`;

function viewCombat() {
  const st = S.state;
  const c = st?.combat;
  if (!c) return h('p', { class: 'empty' }, 'Disponibile per le coppie in gioco.');
  const status = st.clock.status;
  const playing = ACTIVE.includes(status);
  const fighting = ['hunt', 'last_half_hour'].includes(status);
  const mySize = c.alliance ? c.alliance.members.length : 1;
  const opponents = c.teams.filter((t) => !t.allied);
  if (combatOpp && !opponents.some((t) => t.teamId === combatOpp)) combatOpp = null;
  const opp = opponents.find((t) => t.teamId === combatOpp);

  const report = async (result) => {
    if (!opp) return toast('Scegliete prima la coppia avversaria', 'error');
    const allies = c.alliance ? c.alliance.members.filter((m) => m.teamId !== st.team.id).map(teamName) : [];
    const text = {
      lost: `Confermate di aver perso contro ${teamName(opp)}? Il vostro Sigillo${allies.length ? ' e quelli dei vostri alleati' : ''} andranno a ${opp.sectorName}${opp.allianceSize > 1 ? ' e ai suoi alleati' : ''}. Parte la Veglia: cappellino per 2 minuti.`,
      won: `Dichiarate di aver vinto contro ${teamName(opp)}? ${opp.sectorName} dovrà confermare: poi riceverete i Sigilli della parte sconfitta${allies.length ? ' (anche i vostri alleati)' : ''}.`,
      draw: `Pareggio con ${teamName(opp)}? Blocco ingaggio di 5 minuti per tutti.`,
    }[result];
    if (!(await dialog({ title: { lost: 'Scontro perso', won: 'Scontro vinto', draw: 'Pareggio' }[result], text, okLabel: 'Registra', danger: result === 'lost' }))) return;
    const r = await combatCall('/api/team/engagement', { opponentTeamId: opp.teamId, result }, result === 'won' ? `In attesa della conferma di ${opp.sectorName}` : 'Scontro registrato');
    if (r) combatOpp = null;
  };

  return h('div', { class: 'stack' },
    h('h2', null, 'Alleanze e scontri'),

    c.incoming.length ? h('div', { class: 'stack-sm' }, c.incoming.map((r) => h('div', { class: 'combat-card ask' },
      h('div', { class: 'eyebrow' }, r.kind === 'break' ? 'Rottura dell\'alleanza' : 'Proposta di alleanza'),
      h('strong', null, r.kind === 'break' ? `${teamName(r.team)} vuole lasciare l'alleanza` : `${teamName(r.team)} vi propone un'alleanza`),
      r.kind === 'join' ? h('p', { class: 'small muted' }, 'Accettando vi scambiate i Sigilli: li ricevete in automatico nel taccuino.') : h('p', { class: 'small muted' }, 'Accettando l\'alleanza è rotta: blocco ingaggio di 5 minuti.'),
      h('p', { class: 'small' }, 'Scade tra ', h('span', { class: 'mono', 'data-abs': r.expiresAt }, '—')),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-primary', onclick: () => combatCall(`/api/team/alliance/${r.id}/respond`, { accept: true }, r.kind === 'join' ? 'Alleanza stretta' : 'Alleanza rotta') }, 'Accetta'),
        h('button', { class: 'btn btn-danger', onclick: () => combatCall(`/api/team/alliance/${r.id}/respond`, { accept: false }, 'Rifiutata') }, 'Rifiuta'))))) : null,

    c.toConfirm.length ? h('div', { class: 'stack-sm' }, c.toConfirm.map((e) => h('div', { class: 'combat-card ask' },
      h('div', { class: 'eyebrow' }, 'Esito da confermare'),
      h('strong', null, `${teamName(e.reporter)} dichiara di avervi sconfitto`),
      h('p', { class: 'small muted' }, `Confermando, i Sigilli di ${e.losers.map((x) => x.sectorName).join(', ')} vanno a ${e.winners.map((x) => x.sectorName).join(', ')}. Se non è vero, contestate: decide la regia.`),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-primary', onclick: () => combatCall(`/api/team/engagement/${e.id}/respond`, { confirm: true }, 'Sconfitta confermata: Veglia') }, 'Confermo, abbiamo perso'),
        h('button', { class: 'btn btn-danger', onclick: () => combatCall(`/api/team/engagement/${e.id}/respond`, { confirm: false }, 'Contestato: decide la regia') }, 'Contesto'))))) : null,

    h('section', { class: 'card stack-sm' },
      h('div', { class: 'eyebrow' }, 'Esito di uno scontro'),
      !fighting ? h('p', { class: 'muted small' }, status === 'truce' ? 'Tregua: nessun ingaggio.' : 'Gli scontri si registrano a caccia aperta.') : [
        h('p', { class: 'small muted' }, 'Contro chi avete combattuto?'),
        h('div', { class: 'opp-grid' }, opponents.map((t) => h('button', { type: 'button', class: `opp ${combatOpp === t.teamId ? 'on' : ''}`, onclick: () => { combatOpp = t.teamId; render(); } },
          h('strong', null, teamName(t)), t.allianceSize > 1 ? h('span', { class: 'tiny muted' }, `alleanza di ${t.allianceSize}`) : null))),
        h('div', { class: 'result-btns' },
          h('button', { class: 'btn btn-xl res-won', disabled: !opp, onclick: () => report('won') }, 'VINTO'),
          h('button', { class: 'btn btn-xl res-lost', disabled: !opp, onclick: () => report('lost') }, 'PERSO'),
          h('button', { class: 'btn res-draw', disabled: !opp, onclick: () => report('draw') }, 'Pareggio')),
        h('p', { class: 'tiny muted' }, 'Niente scambio di Sigilli a mano: chi vince li riceve nel taccuino (anche i suoi alleati), chi perde fa la Veglia.'),
      ]),

    h('section', { class: 'card stack-sm' },
      h('div', { class: 'eyebrow' }, c.alliance ? `La vostra alleanza (${c.alliance.members.length}/${c.maxAlliance})` : 'Nessuna alleanza'),
      c.alliance ? h('ul', { class: 'ally-list' }, c.alliance.members.filter((m) => m.teamId !== st.team.id).map((m) => {
        const asked = c.outgoing.find((r) => r.kind === 'break' && r.team.teamId === m.teamId);
        return h('li', null, h('strong', null, teamName(m)),
          asked ? h('span', { class: 'chip chip-brass' }, 'rottura proposta')
            : h('button', { class: 'btn btn-sm btn-danger', disabled: !playing, onclick: async () => {
              if (await dialog({ title: 'Rompere l\'alleanza?', text: `${m.sectorName} dovrà accettare. Poi blocco ingaggio di 5 minuti.`, okLabel: 'Proponi la rottura', danger: true })) combatCall('/api/team/alliance/break', { teamId: m.teamId }, `Rottura proposta a ${m.sectorName}`);
            } }, 'Rompi'));
      })) : h('p', { class: 'small muted' }, 'Proponete un\'alleanza a un\'altra coppia: dovrà accettarla dal suo telefono.'),
      c.outgoing.filter((r) => r.kind === 'join').map((r) => h('div', { class: 'pending-row' },
        h('span', null, `In attesa di ${r.team.sectorName} · scade tra `, h('span', { class: 'mono', 'data-abs': r.expiresAt }, '—')),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: () => combatCall(`/api/team/alliance/${r.id}/cancel`, {}, 'Proposta ritirata') }, 'Ritira'))),
      mySize < c.maxAlliance && playing ? [
        h('p', { class: 'small muted' }, 'Proponi un\'alleanza a:'),
        h('div', { class: 'opp-grid' }, opponents.map((t) => {
          const full = mySize + t.allianceSize > c.maxAlliance;
          const waiting = t.retryAt && t.retryAt > clock.serverNow();
          const pending = c.outgoing.some((r) => r.kind === 'join' && r.team.teamId === t.teamId);
          return h('button', { type: 'button', class: 'opp', disabled: full || waiting || pending, onclick: async () => {
            if (await dialog({ title: `Alleanza con ${t.sectorName}?`, text: `${t.sectorName} riceverà la proposta e dovrà accettarla entro pochi minuti. Accettando vi scambiate i Sigilli.`, okLabel: 'Proponi' })) combatCall('/api/team/alliance/request', { teamId: t.teamId }, `Proposta inviata a ${t.sectorName}`);
          } }, h('strong', null, teamName(t)),
          full ? h('span', { class: 'tiny muted' }, 'troppo grande') : waiting ? h('span', { class: 'tiny muted' }, 'riproponi tra ', h('span', { class: 'mono', 'data-abs': t.retryAt }, '—')) : pending ? h('span', { class: 'tiny muted' }, 'in attesa') : null);
        })),
      ] : null),

    c.history.length ? h('section', { class: 'stack-sm' },
      h('div', { class: 'eyebrow' }, 'Ultimi scontri'),
      h('ul', { class: 'list' }, c.history.map((e) => h('li', { class: `hist hist-${e.mine}` },
        h('span', { class: 'mono small muted' }, fmtTime(e.createdAt)),
        h('span', null, e.result === 'draw' ? `Pareggio con ${(e.mine === 'draw' ? [...e.winners, ...e.losers] : e.losers).filter((x) => x.teamId !== st.team.id).map((x) => x.sectorName).join(', ')}`
          : e.mine === 'won' ? `Vinto contro ${e.losers.map((x) => x.sectorName).join(', ')}` : `Perso contro ${e.winners.map((x) => x.sectorName).join(', ')}`),
        h('span', { class: `chip ${e.status === 'confirmed' ? (e.mine === 'won' ? 'chip-ok' : e.mine === 'lost' ? 'chip-blood' : '') : 'chip-brass'}` },
          { pending: 'da confermare', confirmed: 'registrato', contested: 'contestato', cancelled: 'annullato' }[e.status]))))) : null);
}

// ---------------------------------------------------------------- Posizione condivisa con il Consiglio
// Coppie: solo a partita iniziata. Eletti: da quando la partita è pronta. Funziona con l'app aperta (limite dei browser).

const ACTIVE_OR_PAUSED = ['truce', 'hunt', 'last_half_hour', 'paused'];
const deviceId = (() => {
  let id = store.get('zdg_device');
  if (!id) { id = `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`; store.set('zdg_device', id); }
  return id;
})();
let trackStop = null;
let lastSent = { at: 0, lat: 0, lng: 0 };
let trackMsg = null;

function trackingOn(st) {
  if (!st) return false;
  if (st.team.kind === 'elect') return !['draft', 'ended'].includes(st.clock.status);
  if (st.team.kind === 'couple') return ACTIVE_OR_PAUSED.includes(st.clock.status) && st.team.status !== 'withdrawn';
  return false;
}

// Distanza approssimata in metri (basta per decidere se inviare).
const meters = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180));

function sendPosition(pos) {
  // Posizione di rete (centinaia di metri o chilometri): meglio niente che un punto sbagliato in mappa.
  if (pos.acc > SEND_MAX_ACC) return;
  const now = Date.now();
  if (now - lastSent.at < 20000 && meters(pos, lastSent) < 15) return;
  lastSent = { at: now, lat: pos.lat, lng: pos.lng };
  api('POST', '/api/team/position', { deviceId, lat: pos.lat, lng: pos.lng, acc: pos.acc }).catch(() => { lastSent.at = 0; });
}

function updateTracking(st) {
  const on = trackingOn(st);
  if (on && !trackStop) {
    trackStop = watchPosition((pos) => {
      const hint = pos.acc > SEND_MAX_ACC ? accuracyHint(pos.acc) : null;
      if (hint !== trackMsg) { trackMsg = hint; const el = document.getElementById('track-msg'); if (el) el.textContent = hint ? ` ${hint}` : ''; }
      sendPosition(pos);
    }, (msg) => { trackMsg = msg; });
  } else if (!on && trackStop) {
    trackStop();
    trackStop = null;
  }
}

function trackingNote(st) {
  if (!trackingOn(st)) return null;
  return h('p', { class: 'track-note small' }, '📍 ', st.team.kind === 'elect' ? 'La posizione di questo telefono è visibile alla regia e agli altri Eletti.' : 'Durante la partita la posizione di questo telefono è visibile al Consiglio.',
    h('span', { class: 'bad-text', id: 'track-msg' }, trackMsg ? ` ${trackMsg}` : ''));
}

// ---------------------------------------------------------------- Mappa

const teamMapView = createMapView({ className: 'team-map' });
let stopGps = null;
let myPos = null;
let gpsMsg = null;

function startMapGps() {
  if (stopGps) return;
  stopGps = watchPosition((p) => {
    myPos = p;
    gpsMsg = null;
    teamMapView.setMe(p);
    const el = document.getElementById('map-gps');
    if (el) el.textContent = gpsLine(p);
  }, (msg) => { gpsMsg = msg; const el = document.getElementById('map-gps'); if (el) el.textContent = msg; });
}
const gpsLine = (p) => `La vostra posizione: ± ${p.acc} m${accuracyHint(p.acc) ? ` · ${accuracyHint(p.acc)}` : ''}`;
function stopMapGps() { stopGps?.(); stopGps = null; }

function viewMap() {
  const m = S.state?.map || { points: [], gifts: [] };
  teamMapView.setItems([
    ...(m.landmarks || []).map((l) => landmarkItem(l)),
    ...m.points.map((p) => ({ key: `p${p.id}`, kind: 'altar', lat: p.lat, lng: p.lng, text: p.roman, mine: p.mine, title: p.label, popup: `<strong>${p.label}</strong>${p.mine ? '<br>Il vostro Altare' : ''}` })),
    ...m.gifts.map((g) => ({ key: `g${g.id}`, kind: 'gift', lat: g.lat, lng: g.lng, text: '✦', color: '#d1ad62', state: 'revealed', title: 'Dono del Consiglio', popup: '<strong>Dono del Consiglio</strong><br>Chi arriva primo lo prende: scansionatelo con l\'app.' })),
  ]);
  if (myPos) teamMapView.setMe(myPos);
  teamMapView.refresh();
  return h('div', { class: 'stack map-page' },
    h('h2', null, 'Mappa'),
    h('p', { class: 'mono small', id: 'map-gps' }, myPos ? gpsLine(myPos) : gpsMsg || 'Ricerca della posizione…'),
    teamMapView.el,
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn btn-sm', onclick: () => teamMapView.centerMe() }, '◎ Dove siamo'),
      h('button', { class: 'btn btn-sm', onclick: () => teamMapView.fit() }, 'Tutto il campo')),
    h('div', { class: 'map-legend' },
      h('span', null, h('span', { class: 'pin pin-altar' }, 'I'), ' Altare'),
      h('span', null, h('span', { class: 'pin pin-altar pin-mine' }, 'I'), ' Il vostro'),
      h('span', null, h('span', { class: 'pin pin-place pin-soglia' }, '⛩'), ' Soglia'),
      h('span', null, h('span', { class: 'pin pin-place' }, '◯'), ' Cerchio'),
      h('span', null, h('span', { class: 'pin pin-gift pin-revealed', style: { '--c': '#d1ad62' } }, '✦'), ' Dono'),
      h('span', null, h('span', { class: 'pin pin-me' }), ' Voi')),
    trackingNote(S.state) || h('p', { class: 'muted small' }, 'Prima del via la vostra posizione resta su questo telefono.'),
    h('p', { class: 'muted small' }, 'La mappa già vista funziona anche con poco segnale.'));
}

// ---------------------------------------------------------------- Campo degli Eletti

function electFieldHead() {
  return h('div', { class: 'campo-head' },
    h('div', { class: 'mono small', id: 'gps-now' }, field.gpsText()),
    h('button', { class: 'btn btn-primary btn-block btn-xl', onclick: () => field.scanSign() }, '⌖ Scansiona un cartello'),
    cameraSupported() ? null : h('p', { class: 'muted small' }, 'Scanner e GPS richiedono l\'indirizzo https: scegli dall\'elenco e indica il punto toccando la mappa.'));
}

function viewElectTasks() {
  return h('div', { class: 'stack campo' }, h('h2', null, 'Incarichi della squadra'), electFieldHead(), field.viewTasks());
}

function viewElectField() {
  const d = FE.data;
  const which = route().query?.get?.('v') === 'doni' || S.fieldTab === 'doni' ? 'doni' : 'altari';
  const placedA = d ? d.points.filter((p) => p.lat != null).length : 0;
  const placedG = d ? d.gifts.filter((g) => g.status !== 'draft').length : 0;
  const seg = (id, label) => h('button', { type: 'button', class: which === id ? 'on' : '', onclick: () => { S.fieldTab = id; render(); } }, label);
  return h('div', { class: 'stack campo' },
    h('h2', null, 'Piazza Altari e Doni'),
    electFieldHead(),
    h('nav', { class: 'seg-tabs' }, seg('altari', `Altari ${placedA}/${d?.points.length ?? '…'}`), seg('doni', `Doni ${placedG}/${d?.gifts.length ?? '…'}`)),
    which === 'doni' ? field.viewGifts() : field.viewAltars());
}

function viewElectMap() {
  return h('div', { class: 'stack campo' },
    h('h2', null, 'Mappa del campo'),
    h('p', { class: 'mono small', id: 'gps-now' }, field.gpsText()),
    field.viewMap(),
    trackingNote(S.state));
}

// ---------------------------------------------------------------- Doni del Consiglio (QR)

function giftCard(g, big = false) {
  return h('div', { class: `gift-card ${big ? 'big' : ''} ${g.usedAt ? 'used' : ''}`, style: { '--c': g.color } },
    h('div', { class: 'gift-icon' }, g.icon),
    h('div', { class: 'gift-body' },
      h('div', { class: 'eyebrow' }, `${g.label}${g.usedAt ? ' · usato' : ''}`),
      h('div', { class: 'gift-name' }, g.name),
      h('p', null, g.description)));
}

const claimRequested = new Set();
function viewGift(token) {
  const res = S.giftResults[token];
  const owned = (S.state?.gifts || []).find((g) => res?.gift && g.id === res.gift.id);
  const pending = S.queue.find((q) => q.kind === 'claim' && q.payload.token === token);
  const claim = async () => {
    claimRequested.add(token);
    const r = await act('claim', { token }, 'Dono da prendere');
    if (r && r.ok === false) S.giftResults[token] = r;
    render();
  };
  if (!res && !pending && !claimRequested.has(token)) setTimeout(claim);
  const g = owned || res?.gift;
  return h('div', { class: 'stack' },
    h('h2', null, 'Dono del Consiglio'),
    g ? [giftCard(g, true), h('p', { class: 'muted small' }, 'Il dono è vostro: lo trovate in «I vostri doni». Mostratelo quando lo usate.'), h('a', { class: 'btn btn-primary btn-block', href: '#/doni' }, 'I vostri doni')]
      : pending ? h('div', { class: 'banner banner-queue' }, h('strong', null, 'In attesa di rete'), h('span', null, 'Il dono verrà preso appena torna il segnale (se nessuno arriva prima).'))
        : res && !res.ok ? [h('div', { class: 'result result-bad' }, res.message || 'Dono non disponibile'), h('button', { class: 'btn btn-block', onclick: () => { delete S.giftResults[token]; claimRequested.delete(token); claim(); } }, 'Riprova')]
          : h('p', { class: 'empty' }, 'Il Consiglio sta verificando il dono…'));
}

function viewMyGifts() {
  const list = S.state?.gifts || [];
  return h('div', { class: 'stack' },
    h('h2', null, 'I vostri doni'),
    h('p', { class: 'muted small' }, 'Doni presi scansionando i loro QR nel bosco. Mostrate la carta quando lo usate, poi segnatelo come usato.'),
    list.length ? list.map((g) => h('div', { class: 'stack-sm' }, giftCard(g),
      g.usedAt ? h('p', { class: 'muted small' }, `Usato alle ${fmtTime(g.usedAt)}`) : h('div', { class: 'row' },
        h('button', { class: 'btn btn-primary', onclick: () => showGift(g) }, 'Mostra'),
        h('button', { class: 'btn', onclick: async () => {
          if (!(await dialog({ title: `Usare ${g.name}?`, text: 'Il dono verrà segnato come usato.', okLabel: 'Usato' }))) return;
          try { await api('POST', `/api/team/gift/${g.id}/use`); toast('Dono segnato come usato', 'ok'); refresh(); } catch (e) { toast(e.message, 'error'); }
        } }, 'Segna come usato'))))
      : h('p', { class: 'empty' }, 'Nessun dono, per ora. Guardate la mappa: quando ne compare uno, correte.'));
}

// A tutto schermo, con l'orologio vivo (come il Sigillo): prova che non è uno screenshot.
function showGift(g) {
  const ov = h('div', { class: 'gift-show', role: 'dialog', 'aria-modal': 'true', 'aria-label': g.name, onclick: () => { ov.remove(); document.body.classList.remove('no-scroll'); } },
    giftCard(g, true),
    h('div', { class: 'seal-clock mono', 'data-clock': 'wall' }, fmtTime(clock.serverNow(), true)),
    h('p', { class: 'muted small' }, 'Toccate per chiudere'));
  document.body.append(ov);
  document.body.classList.add('no-scroll');
}

// ---------------------------------------------------------------- Sigillo (schermo da mostrare)

let wakeLock = null;
async function requestWake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* non supportato */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$overlay.classList.contains('hidden')) requestWake(); });

function openSeal() {
  const st = S.state;
  const sec = st?.team.sector;
  const len = st?.game.codeLength || 6;
  const code = st?.seal;
  const anim = code ? unveilOnce(`seal:${code}`) : '';
  mount($overlay,
    h('div', { class: 'seal' },
      h('div', { class: 'seal-head' },
        h('div', { class: 'stamp' }, h('span', null, sec?.roman || '0')),
        h('div', null, h('div', { class: 'eyebrow' }, 'Sigillo del Settore'), h('div', { class: 'seal-sector' }, sec?.name || '—'))),
      h('div', { class: 'seal-code mono', 'aria-live': 'polite' },
        code ? h('span', { class: anim }, code) : ghost('seal', len, 'ghost-strong')),
      code ? null : h('p', { class: 'seal-note' }, 'Il Sigillo sarà svelato quando il Consiglio aprirà il cerchio.'),
      h('div', { class: 'seal-clock mono', 'data-clock': 'wall' }, fmtTime(clock.serverNow(), true)),
      h('div', { class: 'seal-motto' }, sec?.motto ? `«${sec.motto}»` : ''),
      h('a', { class: 'btn btn-xl seal-close', href: '#/home' }, 'Chiudi')));
  $overlay.classList.remove('hidden');
  document.body.classList.add('no-scroll');
  if (!wakeLock) requestWake();
}

function closeSeal() {
  if ($overlay.classList.contains('hidden')) return;
  $overlay.classList.add('hidden');
  document.body.classList.remove('no-scroll');
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
}

// ---------------------------------------------------------------- Altari

function allVisited() {
  const map = {};
  for (const [token, v] of Object.entries(S.visits)) map[token] = { qrToken: token, label: v.label, sectorName: v.sectorName, sectorId: v.sectorId, unlocked: false, at: v.at, expiresAt: v.expiresAt };
  for (const v of S.state?.visited || []) {
    const local = map[v.qrToken];
    // Vale la scansione più recente tra quella del server e quella ancora in coda su questo telefono.
    map[v.qrToken] = { ...local, ...v, expiresAt: local?.expiresAt && v.expiresAt ? Math.max(local.expiresAt, v.expiresAt) : v.expiresAt ?? local?.expiresAt ?? null };
  }
  return Object.values(map).sort((a, b) => (b.at || 0) - (a.at || 0));
}

function viewAltars() {
  const list = allVisited();
  return h('div', { class: 'stack' },
    h('h2', null, 'Altari'),
    h('p', { class: 'muted' }, 'Scansionate il QR dell\'Altare con l\'app, allontanatevi, poi inserite il Sigillo del suo Settore. Potete farlo anche più tardi.'),
    h('button', { class: 'btn btn-primary btn-xl btn-block', onclick: openScanner }, '⌖ Scansiona Altare'),
    cameraSupported() ? null : h('p', { class: 'muted small' }, 'Lo scanner usa la fotocamera, che il browser concede solo con l\'indirizzo https del Consiglio.'),
    h('h3', { class: 'section-title' }, `Altari visitati (${list.length})`),
    list.length ? h('ul', { class: 'list' }, list.map((v) => {
      const pending = S.queue.some((q) => q.kind === 'unlock' && q.payload.qrToken === v.qrToken);
      return h('li', null, h('a', { class: 'row', href: `#/altare/${encodeURIComponent(v.qrToken)}` },
        h('div', null, h('strong', null, v.label || 'Altare da riconoscere'), h('div', { class: 'muted small' }, v.sectorName ? `Settore ${v.sectorName}` : 'in attesa di rete')),
        v.unlocked ? h('span', { class: 'chip chip-ok' }, 'Sbloccato') : pending ? h('span', { class: 'chip chip-brass' }, 'In attesa di rete')
          : scanExpired(v) ? h('span', { class: 'chip chip-warn' }, 'Scansione scaduta')
            : v.expiresAt ? h('span', { class: 'chip' }, 'valida ', h('span', { class: 'mono', 'data-abs': v.expiresAt }, '—')) : h('span', { class: 'chip' }, 'Da sbloccare')));
    })) : h('p', { class: 'empty' }, 'Nessun Altare ancora inquadrato.'));
}

// Scansione sempre dentro l'app: riconosce gli Altari (…/a/<token>) di qualsiasi indirizzo del Consiglio.
async function openScanner() {
  const text = await scanQR({
    title: 'Scansiona',
    hint: 'Inquadrate il QR di un Altare o di un Dono del Consiglio.',
    accept: (t) => (/\/(a|d)\/[\w-]+/.test(t) ? true : /\/login\//.test(t) ? 'Questo è un QR di accesso, non un Altare' : 'Questo QR non è dei Giochi'),
  });
  if (!text) return;
  const gift = text.match(/\/d\/([\w-]+)/);
  if (gift) { location.hash = `#/dono/${gift[1]}`; return; }
  const token = text.match(/\/a\/([\w-]+)/)[1];
  registerScan(token);
  location.hash = `#/altare/${token}`;
}

// Accesso con il QR della coppia/Eletti o personale, letto dall'app.
async function scanLogin() {
  const text = await scanQR({
    title: 'QR di accesso',
    hint: 'Inquadrate il QR che vi ha dato il Consiglio.',
    accept: (t) => (/\/login\/[\w-]+/.test(t) ? true : /\/a\//.test(t) ? 'Questo è un Altare: prima entrate con il QR di accesso' : 'Questo QR non è un accesso ai Giochi'),
  });
  if (!text) return;
  // Restiamo sull'indirizzo attuale: dal QR serve solo il token.
  location.href = `/login/${text.match(/\/login\/([\w-]+)/)[1]}`;
}

const scanExpired = (v) => !!(v?.expiresAt && v.expiresAt < clock.serverNow());
const CODE_SOURCE = { own: 'è il vostro', revealed: 'rivelato dal Consiglio', note: 'annotato da voi', won: 'vinto in uno scontro', alliance: 'ricevuto dall\'alleanza' };
const manualAltar = new Set();

function viewAltar(token, query) {
  if (!token) return h('p', { class: 'empty' }, 'Altare non valido');
  const st = S.state;
  // Aperto da un link senza scansione registrata: la registra ora.
  if (!S.visits[token] && !(st?.visited || []).some((x) => x.qrToken === token)) setTimeout(() => registerScan(token));
  const v = allVisited().find((x) => x.qrToken === token) || {};
  const sectorId = v.sectorId || (st?.visited || []).find((x) => x.qrToken === token)?.sectorId;
  const last = S.altarResults[token];
  const fragment = (v.unlocked ? (st?.fragments || []).find((f) => f.pointLabel === v.label && f.text) : null) || (last?.ok ? last.fragment : null);
  const pending = S.queue.find((q) => q.kind === 'unlock' && q.payload.qrToken === token);
  const known = sectorId ? st?.notebook.find((n) => n.sectorId === sectorId && n.code) : null;
  const expired = scanExpired(v) || (last?.expired && !pending);
  const status = st?.clock.status;
  const closed = status && !ACTIVE.includes(status);

  const unlockWith = async (code) => {
    const res = await act('unlock', { qrToken: token, code }, `Sigillo per ${v.label || 'Altare'}`);
    if (res?.ok) manualAltar.delete(token);
    render();
  };
  const input = h('input', { class: 'input input-code', 'data-keep': `altar-${token}`, value: query.get('code') || '', maxlength: 12, autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', placeholder: '······', 'aria-label': 'Sigillo' });
  const manualForm = h('form', { class: 'stack', onsubmit: (e) => {
    e.preventDefault();
    const code = input.value.trim().toUpperCase();
    if (!code) return toast('Scrivete il Sigillo', 'error');
    unlockWith(code);
  } },
  h('label', { class: 'field' }, h('span', null, `Inserite il Sigillo del Settore ${v.sectorName || '…'}`), input),
  h('button', { class: 'btn btn-primary btn-xl btn-block', type: 'submit' }, 'Pronuncia il Sigillo'));

  let action;
  if (fragment) action = null;
  else if (expired) {
    action = h('div', { class: 'scan-expired' },
      h('strong', null, 'Scansione scaduta'),
      h('p', null, `La scansione vale ${st?.game.altarScanMin || '?'} minuti${v.expiresAt ? ` ed è scaduta alle ${fmtTime(v.expiresAt)}` : ''}. Tornate all'Altare e inquadratelo di nuovo.`),
      h('button', { class: 'btn btn-primary btn-xl btn-block', onclick: openScanner }, '⌖ Riscansiona l\'Altare'));
  } else if (known && !manualAltar.has(token) && !query.get('code')) {
    // Sigillo già nel taccuino: niente da scrivere, basta confermarlo.
    action = h('div', { class: 'known-seal' },
      h('div', { class: 'eyebrow' }, 'Dal vostro taccuino'),
      h('p', null, `Avete già il Sigillo del Settore ${known.sectorName} (${CODE_SOURCE[known.source] || 'nel taccuino'}):`),
      h('div', { class: 'known-code mono' }, known.code),
      h('button', { class: 'btn btn-primary btn-xl btn-block', onclick: () => unlockWith(known.code) }, 'Usa questo Sigillo'),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { manualAltar.add(token); render(); } }, 'Inserisci un altro Sigillo'));
  } else action = manualForm;

  return h('div', { class: 'stack' },
    h('div', { class: 'altar-head' },
      h('div', { class: 'eyebrow' }, v.sectorName ? `Settore ${v.sectorName}` : 'Altare'),
      h('h2', { class: 'altar-title' }, v.label || 'Altare da riconoscere'),
      !v.label ? h('p', { class: 'muted small' }, 'Il nome apparirà appena torna la rete. Potete già inserire il Sigillo.') : null,
      !fragment && !expired && v.expiresAt ? h('p', { class: 'scan-valid small' }, 'Scansione valida ancora ', h('strong', { class: 'mono', 'data-abs': v.expiresAt }, '—'), ` (fino alle ${fmtTime(v.expiresAt, true)})`) : null),
    fragment
      ? h('div', { class: 'fragment-reveal' },
        h('div', { class: 'eyebrow' }, `Frammento n. ${fragment.position} della Parola`),
        h('div', { class: `fragment-text ${unveilOnce(`frag:${fragment.position}`)}` }, fragment.text),
        h('p', { class: 'muted small' }, fragment.source === 'manual' ? 'Ricevuto da altri e verificato.' : 'Sbloccato con il Sigillo.'))
      : h('div', { class: 'fragment-reveal locked' }, h('div', { class: 'eyebrow' }, 'Frammento custodito'), h('div', { class: 'fragment-text' }, ghostWord(`altar:${token}`, 'ghost-strong'))),
    action,
    !fragment && closed ? h('p', { class: 'muted small' }, status === 'ended' ? 'I Giochi sono finiti: gli Altari sono chiusi.' : status === 'paused' ? 'Partita sospesa.' : 'Gli Altari si aprono al via.') : null,
    pending ? h('div', { class: 'banner banner-queue' }, h('strong', null, 'In attesa di rete'), h('span', null, `Sigillo «${pending.payload.code}» verrà inviato appena c'è segnale.`)) : null,
    last && !last.ok && !fragment && !last.expired ? h('div', { class: 'result result-bad' }, last.message) : null,
    h('a', { class: 'btn btn-block', href: '#/altari' }, 'Tutti gli Altari'));
}

// ---------------------------------------------------------------- Frammenti

function viewFragments() {
  const st = S.state;
  const frs = st?.fragments || [];
  const owned = frs.filter((f) => f.text).length;
  const input = h('input', { class: 'input', 'data-keep': 'frag-manual', placeholder: 'Testo del frammento', autocomplete: 'off' });
  const submit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const res = await act('fragment', { text }, `Frammento «${text}»`);
    if (res?.ok) input.value = '';
  };
  return h('div', { class: 'stack' },
    h('h2', null, 'La Parola'),
    h('p', { class: 'mono' }, `Frammenti: ${owned} / ${frs.length || '?'}`),
    owned && owned === frs.length ? h('div', { class: 'won' }, h('strong', null, 'Avete la Parola intera.'), h('span', null, 'Portatela alla Soglia.')) : null,
    frs.length ? h('ol', { class: 'fragments' }, frs.map((f) => h('li', { class: f.text ? 'have' : '' },
      h('span', { class: 'pos mono' }, f.position),
      h('div', null,
        h('div', { class: 'frag-word' }, f.text ? h('span', { class: unveilOnce(`frag:${f.position}`) }, f.text) : ghostWord(`frag:${f.position}`)),
        h('div', { class: 'muted small' }, `${f.pointLabel}${f.text ? '' : ': ?'}`)),
      f.source ? h('span', { class: `chip ${f.source === 'manual' ? 'chip-brass' : 'chip-ok'}` }, f.source === 'manual' ? 'ricevuto' : 'sbloccato') : null)))
      : h('p', { class: 'empty' }, 'La Parola non è ancora stata scritta dal Consiglio.'),
    h('form', { class: 'card stack', onsubmit: submit },
      h('strong', null, 'Aggiungi un frammento ricevuto'),
      h('p', { class: 'muted small' }, 'Se un\'altra coppia vi ha dato un frammento, scrivetelo: l\'app verifica che sia vero e lo mette al suo posto.'),
      input,
      h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Verifica e aggiungi')));
}

// ---------------------------------------------------------------- Codici (taccuino)

function viewNotebook() {
  const st = S.state;
  const nb = st?.notebook || [];
  const status = st?.clock.status;
  const notReady = ['draft', 'ready'].includes(status);
  const unknown = nb.filter((n) => !n.code);
  const sel = h('select', { class: 'input', 'data-keep': 'nb-sector' }, h('option', { value: '' }, 'Settore…'), unknown.map((n) => h('option', { value: n.sectorId }, `${n.roman} · ${n.sectorName}`)));
  const input = h('input', { class: 'input input-code', 'data-keep': 'nb-code', maxlength: 12, autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', placeholder: '······' });
  const submit = async (e) => {
    e.preventDefault();
    if (!sel.value || !input.value.trim()) return toast('Scegliete il Settore e scrivete il Sigillo', 'error');
    const name = nb.find((n) => String(n.sectorId) === sel.value)?.sectorName;
    const res = await act('note', { sectorId: Number(sel.value), code: input.value.trim().toUpperCase() }, `Sigillo ${name}`);
    if (res) input.value = '';
  };
  const srcLabel = { own: 'vostro', revealed: 'rivelato', note: 'annotato ✓', won: 'vinto', alliance: 'alleato' };
  return h('div', { class: 'stack' },
    h('h2', null, 'Taccuino dei Sigilli'),
    h('p', { class: 'muted' }, 'Il vostro, quelli traditi dal Consiglio e quelli che vi hanno mostrato. Toccate un Sigillo per aprire il suo Altare.'),
    h('ul', { class: 'notebook' }, nb.map((n) => {
      const go = n.code && n.visitedToken && !n.unlocked;
      const content = [
        h('span', { class: 'nb-roman mono' }, n.roman),
        h('div', { class: 'nb-main' },
          h('div', { class: 'nb-name' }, n.sectorName),
          n.wrongAttempt && !n.code ? h('div', { class: 'small bad-text' }, `«${n.wrongAttempt}» non è valido`) : null,
          n.unlocked ? h('div', { class: 'small ok-text' }, 'Altare sbloccato') : go ? h('div', { class: 'small' }, 'Altare visitato: tocca per sbloccare') : null),
        h('div', { class: 'nb-code mono' }, n.code ? h('span', { class: unveilOnce(`code:${n.sectorId}:${n.code}`) }, n.code) : ghost(`nb:${n.sectorId}`, st.game.codeLength)),
        n.source ? h('span', { class: `chip ${n.source === 'revealed' ? 'chip-blood' : n.source === 'own' ? 'chip-brass' : 'chip-ok'}` }, srcLabel[n.source]) : null,
      ];
      return h('li', null, go ? h('a', { class: 'nb-row link', href: `#/altare/${encodeURIComponent(n.visitedToken)}?code=${n.code}` }, content) : h('div', { class: 'nb-row' }, content));
    })),
    notReady ? h('p', { class: 'muted small' }, 'Il taccuino si apre nel cerchio.') : unknown.length ? h('form', { class: 'card stack', onsubmit: submit },
      h('strong', null, 'Annota un Sigillo che vi hanno mostrato'),
      h('p', { class: 'muted small' }, 'L\'app vi dice subito se è quello vero.'),
      sel, input,
      h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Verifica')) : null);
}

// ---------------------------------------------------------------- Timer (funzionano offline)

function saveTimers() { store.set('zdg_timers', S.timers); }

// Timer avviati dal server (Veglia dopo una sconfitta, blocchi dopo pareggi o alleanze rotte): partono da soli.
const syncedTimers = new Set(store.get('zdg_synced_timers', []));
function syncServerTimers(st) {
  for (const t of st.serverTimers || []) {
    const key = `srv-${t.id}`;
    if (syncedTimers.has(key)) continue;
    syncedTimers.add(key);
    const preset = (st.game.timers || []).find((x) => x.id === t.timerId);
    if (!preset) continue;
    const endsAt = t.startedAt + preset.minutes * 60000 - clock.offset;
    if (endsAt <= Date.now()) continue;
    S.timers.push({ uid: key, id: preset.id, label: preset.label, endText: preset.endText, endsAt, done: false, reason: t.reason });
    toast(`Timer ${preset.label} avviato: ${t.reason}`, 'blood', 7000);
  }
  store.set('zdg_synced_timers', [...syncedTimers].slice(-200));
  saveTimers();
}

function startTimer(preset) {
  S.timers.push({ uid: `${preset.id}-${Date.now()}`, id: preset.id, label: preset.label, endText: preset.endText, endsAt: Date.now() + preset.minutes * 60000, done: false });
  saveTimers();
  vibrate(60);
  render();
}

function checkTimers() {
  let changed = false;
  for (const t of S.timers) {
    if (!t.done && Date.now() >= t.endsAt) {
      t.done = true;
      changed = true;
      vibrate([500, 150, 500, 150, 500]);
      beep();
      toast(`${t.label}: ${t.endText}`, 'blood', 10000);
      localNotify(`Timer ${t.label}`, t.endText, `timer-${t.uid}`);
    }
  }
  if (changed) { saveTimers(); if (route().view === 'timer' || route().view === 'home') render(); }
}

function viewTimers() {
  const presets = S.state?.game.timers || [];
  return h('div', { class: 'stack' },
    h('h2', null, 'Timer'),
    h('p', { class: 'muted small' }, 'Strumenti di comodo: l\'app non impone niente. Vibrano a fine tempo; il suono solo se lo attivate.'),
    h('div', { class: 'timer-presets' }, presets.map((p) => h('button', { class: 'tile timer-tile', onclick: () => startTimer(p) },
      h('strong', null, p.label), h('span', { class: 'mono' }, `${p.minutes} min`), h('span', { class: 'muted small' }, p.use)))),
    h('h3', { class: 'section-title' }, 'In corso'),
    S.timers.length ? h('ul', { class: 'list' }, S.timers.slice().reverse().map((t) => h('li', { class: `timer-row ${t.done ? 'done' : ''}` },
      h('div', null, h('strong', null, t.label), h('div', { class: 'muted small' }, t.done ? t.endText : `fine alle ${fmtTime(t.endsAt, true)}`)),
      h('span', { class: 'mono timer-left', 'data-timer': t.uid }, fmtDuration(Math.max(0, t.endsAt - Date.now()), false)),
      h('button', { class: 'btn btn-sm', onclick: () => { S.timers = S.timers.filter((x) => x.uid !== t.uid); saveTimers(); render(); } }, t.done ? 'Ok' : 'Ferma'))))
      : h('p', { class: 'empty' }, 'Nessun timer attivo.'));
}

// ---------------------------------------------------------------- Annunci e messaggi

const ANN_LABEL = { gift: 'Dono', gift_taken: 'Dono preso', gift_expired: 'Dono svanito', start: 'Via', hunt_open: 'Caccia', revelation: 'Tradimento', supply: 'Armamenti', supply_end: 'Armamenti chiusi', last_half_hour: 'Ultima mezz\'ora', victory: 'Vittoria', podium: 'Podio', pause: 'Sospensione', resume: 'Ripresa', end: 'Fine', free: 'Consiglio' };

function viewNotices() {
  const list = S.state?.notices || [];
  const forLabel = (n) => (n.target === 'team' ? 'Solo per voi' : n.target === 'elect' ? 'Per gli Eletti' : n.target === 'couples' ? 'Per le coppie' : 'Per tutti');
  return h('div', { class: 'stack' },
    h('h2', null, 'Avvisi'),
    h('p', { class: 'muted small' }, 'Comunicazioni del Consiglio: ritrovi, cambi di programma, istruzioni.'),
    pushInvite(),
    list.length ? h('ul', { class: 'feed' }, list.map((n) => h('li', { class: `ann notice ${n.id > S.seenNotice ? 'new' : ''}` },
      h('div', { class: 'ann-head' }, h('span', { class: `chip ${n.target === 'team' ? 'chip-blood' : 'chip-brass'}` }, forLabel(n)), h('span', { class: 'mono muted small' }, `${new Date(n.createdAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} · ${fmtTime(n.createdAt)}`)),
      h('h3', { class: 'notice-title' }, n.title),
      n.body ? h('p', null, n.body) : null)))
      : h('p', { class: 'empty' }, 'Nessun avviso, per ora.'));
}

function viewAnnouncements() {
  const list = S.state?.announcements || [];
  return h('div', { class: 'stack' },
    h('h2', null, 'Annunci del Consiglio'),
    list.length ? h('ul', { class: 'feed' }, list.map((a) => h('li', { class: `ann ann-${a.type} ${a.id > S.seenAnn ? 'new' : ''}` },
      h('div', { class: 'ann-head' }, h('span', { class: `chip ${a.type === 'revelation' || a.type === 'pause' ? 'chip-blood' : ''}` }, ANN_LABEL[a.type] || a.type), h('span', { class: 'mono muted small' }, fmtTime(a.createdAt, true))),
      h('p', null, a.text),
      a.type === 'revelation' && a.payload ? h('div', { class: 'ann-code mono' }, `${a.payload.sectorName}: `, h('strong', null, a.payload.code)) : null)))
      : h('p', { class: 'empty' }, 'Il Consiglio tace, per ora.'));
}

// Chat con la regia, stile WhatsApp: fumetti, composer fisso in fondo, vocali.
function viewMessages() {
  const msgs = S.state?.messages || [];
  let lastDay = '';
  const items = [];
  for (const m of msgs) {
    const day = new Date(m.createdAt).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
    if (day !== lastDay) { items.push(h('li', { class: 'chat-day' }, h('span', null, day))); lastDay = day; }
    // Eletti: la chat è condivisa, "miei" sono solo i messaggi scritti da me; gli altri mostrano chi scrive.
    const me = S.state.player ? S.state.player.nickname || S.state.player.name : null;
    const mine = m.fromRole === 'team' && (!isElect() || !m.author || m.author === me);
    const who = m.fromRole === 'master' ? 'Consiglio' : mine ? null : m.author;
    items.push(h('li', { class: `bubble ${mine ? 'mine' : 'theirs'} ${m.audioMime ? 'voice' : ''}` },
      who || m.squadName ? h('div', { class: 'bubble-who' }, who || '', m.squadName ? h('span', { class: 'bubble-tag' }, `${who ? ' · ' : ''}squadra ${m.squadName}`) : null) : null,
      m.audioMime ? voicePlayer(`/api/media/message/${m.id}`, m.audioMs) : h('div', { class: 'bubble-text' }, m.text),
      h('div', { class: 'bubble-time mono' }, fmtTime(m.createdAt))));
  }
  return h('div', { class: 'chat-wrap' },
    h('div', { class: 'chat-head' }, h('strong', null, 'Consiglio Zero'), h('span', { class: 'muted small' }, isElect() ? 'Con la regia e gli altri Eletti · emergenze sempre via radio' : 'Messaggi con la regia · emergenze sempre via radio')),
    chatTargetBar(),
    msgs.length ? h('ul', { class: 'chat' }, items) : h('p', { class: 'empty chat-empty' }, 'Nessun messaggio. Scrivete o registrate un vocale alla regia.'),
    composer());
}

// Eletti con una squadra: scrivono a tutti gli Eletti oppure solo alla propria squadra (sempre con la regia).
const mySquad = () => (isElect() ? S.state?.field?.squad || null : null);
const msgSquadId = () => (mySquad() && S.msgTarget !== 'all' ? mySquad().id : null);
function chatTargetBar() {
  const sq = mySquad();
  if (!sq) return null;
  const btn = (key, label) => h('button', { type: 'button', class: (S.msgTarget === 'all') === (key === 'all') ? 'on' : '', onclick: () => { S.msgTarget = key; render(); } }, label);
  return h('div', { class: 'chat-target', role: 'group', 'aria-label': 'A chi scrivi' }, h('span', { class: 'small muted' }, 'Scrivi a:'), btn('squad', `Squadra ${sq.name}`), btn('all', 'Tutti gli Eletti'));
}

function composer() {
  if (S.rec) {
    return h('div', { class: 'composer recording' },
      h('button', { class: 'cmp-btn cmp-ghost', type: 'button', 'aria-label': 'Annulla la registrazione', onclick: cancelVoice }, '🗑'),
      h('div', { class: 'rec-info' }, h('span', { class: 'rec-dot', 'aria-hidden': 'true' }), h('span', { class: 'mono', id: 'rec-time' }, fmtSec(Date.now() - S.rec.startedAt)), h('span', { class: 'muted small' }, 'Registrazione…')),
      h('button', { class: 'cmp-btn cmp-send', type: 'button', 'aria-label': 'Invia il vocale', onclick: sendVoice }, '➤'));
  }
  const canVoice = voiceSupported();
  const ta = h('textarea', { class: 'cmp-input', 'data-keep': 'msg', rows: 1, maxlength: 1000, placeholder: 'Messaggio', 'aria-label': 'Messaggio alla regia' });
  const btn = h('button', { class: 'cmp-btn cmp-send', type: 'submit' });
  const sync = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 132)}px`;
    const voice = canVoice && !ta.value.trim();
    btn.textContent = voice ? '🎤' : '➤';
    btn.setAttribute('aria-label', voice ? 'Registra un vocale' : 'Invia');
    btn.dataset.mode = voice ? 'voice' : 'text';
  };
  ta.addEventListener('input', sync);
  ta.addEventListener('focus', () => document.body.classList.add('typing'));
  ta.addEventListener('blur', () => setTimeout(() => document.body.classList.remove('typing'), 150));
  const form = h('form', { class: 'composer', onsubmit: async (e) => {
    e.preventDefault();
    if (btn.dataset.mode === 'voice') return startVoice();
    const text = ta.value.trim();
    if (!text) return;
    btn.disabled = true;
    try {
      await api('POST', '/api/team/message', { text, squadId: msgSquadId() });
      ta.value = '';
      S.chatScroll = true;
      await refresh();
    } catch (err) { toast(err.offline ? 'Serve la rete per scrivere alla regia. In emergenza usate la radio.' : err.message, 'error', 6000); }
    btn.disabled = false;
  } }, ta, btn);
  queueMicrotask(sync);
  return form;
}

async function startVoice() {
  try {
    S.rec = await startRecording({ onLimit: () => sendVoice() });
    vibrate(40);
    render();
  } catch {
    S.rec = null;
    toast('Microfono non disponibile: consentite l\'accesso al microfono al browser', 'error', 6000);
  }
}

function cancelVoice() {
  S.rec?.cancel();
  S.rec = null;
  render();
}

async function sendVoice() {
  const rec = S.rec;
  if (!rec) return;
  S.rec = null;
  render();
  const voice = await rec.stop();
  if (voice.ms < 700) return toast('Vocale troppo breve', 'info');
  try {
    await uploadAudio(msgSquadId() ? `/api/team/message/audio?squadId=${msgSquadId()}` : '/api/team/message/audio', voice);
    vibrate(40);
    S.chatScroll = true;
    await refresh();
  } catch (err) { toast(err.message, 'error', 6000); }
}

// ---------------------------------------------------------------- Regolamento

function viewRules() {
  const st = S.state;
  return h('div', { class: 'stack rules' },
    h('h2', null, 'Il gioco in un minuto'),
    h('ol', { class: 'quick' },
      h('li', null, h('b', null, 'Obiettivo: '), 'raccogliete tutti i frammenti della Parola e fateli validare per primi alla Soglia.'),
      h('li', null, 'La coppia non si separa mai: sempre a vista o a portata di voce.'),
      h('li', null, 'Il vostro Sigillo è segreto. Lo mostrate solo se perdete un ingaggio o stringete un\'alleanza.'),
      h('li', null, h('b', null, 'Altari: '), 'inquadrate il QR, allontanatevi, poi inserite il Sigillo di quel Settore. Ottenete un frammento.'),
      h('li', null, h('b', null, 'Ingaggio: '), 'senza colpiti potete scappare; dal primo colpito si va fino all\'eliminazione di una coppia. Dopo 10 minuti è pareggio.'),
      h('li', null, 'Mai entrare in uno scontro altrui.'),
      h('li', null, h('b', null, 'Colpito: '), 'dichiaratelo, cappellino, fermi e zitti.'),
      h('li', null, h('b', null, 'Sconfitta: '), 'mostrate il Sigillo, cappellino almeno 2 minuti (timer Veglia).'),
      h('li', null, h('b', null, 'Alleanza: '), 'braccio alzato per proporla, braccia incrociate per rifiutarla.'),
      h('li', null, 'Alla Soglia si arriva come coppia singola: l\'alleanza va sciolta prima.')),
    h('a', { class: 'btn btn-primary btn-block', href: st?.game.bookUrl || '/regolamento.html', target: '_blank', rel: 'noopener' }, 'Leggi il regolamento completo'),
    h('div', { class: 'card' }, h('div', { class: 'eyebrow' }, 'Canale radio d\'emergenza'), h('div', { class: 'mono big-text' }, st?.game.emergencyRadioChannel || 'chiedete alla regia')));
}

// ---------------------------------------------------------------- Impostazioni

function applyTheme() {
  document.documentElement.dataset.theme = S.settings.sun ? 'light' : 'dark';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', S.settings.sun ? '#f4f2ea' : '#0f1310');
}

async function logout() {
  const acc = S.state?.account;
  if (!(await dialog({ title: 'Uscire?', text: acc ? `Per rientrare ti serviranno username (${acc.username}) e password.` : 'Per rientrare servirà di nuovo il QR o il codice d\'accesso.', okLabel: 'Esci', danger: true }))) return;
  try { await api('POST', '/api/team/logout'); } catch { /* offline */ }
  ['zdg_state', 'zdg_queue', 'zdg_visits', 'zdg_altar_results', 'zdg_unveiled'].forEach(store.del);
  location.href = '/';
}

// In fondo a ogni home: con chi sei entrato, profilo ed Esci.
function accountBar(st) {
  const acc = st?.account;
  return h('div', { class: 'account-bar' },
    h('span', { class: 'small muted' }, acc ? ['Entrato come ', h('strong', null, `@${acc.username}`)] : 'Entrato con QR o codice d\'accesso'),
    acc ? h('a', { class: 'btn btn-sm btn-ghost', href: '/iscrizione#profilo' }, 'Profilo') : null,
    h('button', { class: 'btn btn-sm', type: 'button', onclick: logout }, 'Esci'));
}

function viewSettings() {
  const set = (k, v) => { S.settings[k] = v; store.set('zdg_settings', S.settings); applyTheme(); render(); };
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const st = S.state;
  return h('div', { class: 'stack' },
    h('h2', null, 'Impostazioni'),
    h('div', { class: 'card stack' },
      h('strong', null, 'Notifiche del Consiglio'),
      h('p', { class: 'muted small' }, perm === 'granted' ? 'Attive. Riceverete gli annunci anche a schermo spento.' : 'Attivatele per ricevere annunci e rivelazioni con vibrazione anche a schermo spento.'),
      h('button', { class: 'btn btn-primary btn-block', onclick: async () => { try { await enablePush(); toast('Notifiche attive', 'ok'); render(); } catch (e) { toast(e.message, 'error', 7000); } } }, perm === 'granted' ? 'Riattiva notifiche' : 'Attiva notifiche')),
    h('div', { class: 'card toggle-row' }, h('div', null, h('strong', null, 'Suono'), h('div', { class: 'muted small' }, 'Spento di default: nel softair il rumore tradisce la posizione.')),
      h('button', { class: `btn ${S.settings.sound ? 'btn-primary' : ''}`, onclick: () => { set('sound', !S.settings.sound); if (S.settings.sound) beep(true); } }, S.settings.sound ? 'Attivo' : 'Spento')),
    h('div', { class: 'card toggle-row' }, h('div', null, h('strong', null, 'Modalità sole'), h('div', { class: 'muted small' }, 'Tema chiaro ad alto contrasto per la luce diretta.')),
      h('button', { class: `btn ${S.settings.sun ? 'btn-primary' : ''}`, onclick: () => set('sun', !S.settings.sun) }, S.settings.sun ? 'Attiva' : 'Spenta')),
    st ? h('div', { class: 'card' }, h('div', { class: 'eyebrow' }, isElect() ? 'Eletti del Consiglio' : isLobby() ? 'Iscrizione' : 'Coppia'), h('p', null, st.team.members.map((m) => m.name + (m.nickname ? ` «${m.nickname}»` : '')).join(isElect() ? ', ' : ' e ')), h('p', { class: 'muted small' }, st.game.name)) : null,
    st?.account ? h('div', { class: 'card' }, h('div', { class: 'eyebrow' }, 'Il tuo account'), h('p', null, h('strong', null, st.account.username), ` · ${st.account.name}`),
      h('a', { class: 'btn btn-sm', href: '/iscrizione#profilo' }, 'Profilo e password')) : null,
    st?.player?.accessCode ? h('div', { class: 'card' }, h('div', { class: 'eyebrow' }, 'Il tuo codice personale'), h('div', { class: 'mono big-text' }, st.player.accessCode), h('p', { class: 'muted small' }, 'Con questo codice entri da qualsiasi telefono e segui sempre la tua coppia.')) : null,
    h('button', { class: 'btn btn-block', onclick: () => openTour() }, '▶ Rivedi il tour dell\'app'),
    h('button', { class: 'btn btn-danger btn-block', onclick: logout }, 'Esci da questo dispositivo'));
}

// ---------------------------------------------------------------- tour guidato (primo accesso)

function tourSlides() {
  const st = S.state;
  const elect = isElect() || (isLobby() && st?.player?.role === 'elect');
  const demoSegments = h('div', { class: 'segments tour-segments' }, [1, 1, 0, 1, 0, 1, 0, 0].map((on) => h('i', { class: on ? 'on' : '' })));
  const sealDemo = h('button', { class: 'tour-seal mono', type: 'button', 'aria-label': 'Svela il Sigillo di esempio', onclick: (e) => {
    const b = e.currentTarget;
    if (b.dataset.done) return;
    b.dataset.done = '1';
    b.replaceChildren(h('span', { class: 'unveil' }, 'K7P4QX'));
    vibrate(80);
  } }, ghost('tour-seal', 6, 'ghost-strong'));
  const notifyBtn = () => {
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    if (perm === 'granted') return h('p', { class: 'ok-text' }, '✓ Notifiche attive su questo telefono.');
    if (perm === 'unsupported' || !('PushManager' in window)) return h('p', { class: 'muted small' }, 'Su questo dispositivo o collegamento le notifiche non sono disponibili: aprite l\'app dall\'indirizzo https del Consiglio.');
    if (perm === 'denied') return h('p', { class: 'muted small' }, 'Le notifiche sono bloccate: riattivatele dalle impostazioni del browser.');
    return h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: async (e) => {
      const box = e.currentTarget.parentElement;
      try { await enablePush(); box.replaceChildren(h('p', { class: 'ok-text' }, '✓ Notifiche attive su questo telefono.')); } catch (err) { toast(err.message, 'error', 6000); }
    } }, 'Attiva le notifiche');
  };
  const installBox = () => {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return h('p', { class: 'ok-text' }, '✓ L\'app è già installata.');
    if (installPrompt) return h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: async () => { installPrompt.prompt(); await installPrompt.userChoice.catch(() => {}); installPrompt = null; } }, 'Installa l\'app');
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    return h('p', { class: 'muted small' }, ios ? 'Su iPhone: tasto Condividi → "Aggiungi alla schermata Home".' : 'Su Android: menu ⋮ di Chrome → "Installa app" (o "Aggiungi a schermata Home").');
  };

  const welcome = {
    icon: h('div', { class: 'emblem big' }, h('span', null, '0')),
    title: elect ? 'Benvenuti, Eletti' : 'Benvenuti nel buio',
    text: [
      elect ? 'Questa è l\'app con cui il Consiglio guida i suoi Eletti: avvisi, ordini, messaggi e timer, tutto in tasca.' : 'Questa è l\'app dei Giochi del Buio. Nel bosco sarà la vostra unica alleata: Sigillo, Altari, frammenti e voce del Consiglio.',
      isLobby() ? (st.player?.status === 'pending' ? 'La vostra candidatura è in attesa: intanto, un giro di un minuto per conoscerla.' : 'Siete stati accettati: ecco un giro di un minuto per conoscerla.') : 'Un giro di un minuto per conoscerla.',
    ],
  };
  const notices = {
    icon: h('div', { class: 'tour-ico' }, '!'),
    title: 'La voce del Consiglio',
    text: ['Annunci di gioco (tradimenti, tregua, ultima mezz\'ora) e avvisi (ritrovi, cambi di programma, ordini). Arrivano come notifiche sul telefono, anche a schermo spento: toccandole si apre la pagina giusta.'],
    extra: () => h('div', null, notifyBtn()),
  };
  const timers = {
    icon: h('div', { class: 'tour-chips' }, ['Veglia 2′', 'Stallo 10′', 'Trattativa 2′', 'Blocco 5′'].map((t) => h('span', { class: 'chip chip-brass' }, t))),
    title: 'I timer',
    text: ['Un tocco e partono: Veglia, Stallo, Trattativa, Blocchi. Vibrano a fine tempo e funzionano anche senza rete. Il suono è spento: nel bosco il rumore tradisce.'],
  };
  const radio = {
    icon: h('div', { class: 'tour-radio' }, h('span', { class: 'eyebrow' }, 'Radio d\'emergenza'), h('strong', { class: 'mono' }, st?.game.emergencyRadioChannel || 'PMR 8')),
    title: 'Regia e radio',
    text: ['In fondo allo schermo c\'è sempre il canale radio d\'emergenza. Per tutto il resto scrivete alla regia dall\'app. Se la partita viene sospesa, lo schermo diventa rosso: fermatevi e ascoltate la radio.'],
  };
  const install = {
    icon: h('div', { class: 'tour-ico' }, '⇩'),
    title: 'Portatela con voi',
    text: ['Installate l\'app sulla schermata home: si apre come un\'app vera, funziona senza rete e riceve le notifiche.'],
    extra: installBox,
  };
  if (elect) {
    return [welcome,
      { icon: h('div', { class: 'tour-ico' }, '⛨'), title: 'Il vostro compito', text: ['Gli Eletti tengono in piedi i Giochi e ne difendono i luoghi: logistica, Altari, il Cuore, i doni. Non hanno Sigillo e non cercano la Parola: obbediscono al Consiglio.'] },
      notices, timers, radio, install];
  }
  return [welcome,
    { icon: sealDemo, title: 'Il Sigillo', text: ['Ogni coppia custodisce un Sigillo segreto. Prima del cerchio vedete solo un simulacro sfocato: si svela quando il Consiglio apre il cerchio. Toccate quello qui sopra.', 'Se perdete un ingaggio lo mostrate a tutto schermo, con l\'orologio che prova che non è uno screenshot.'] },
    { icon: h('div', { class: 'tour-ico' }, '⌖'), title: 'Gli Altari', text: ['Nel bosco ci sono gli Altari, uno per Settore, con un QR.'], extra: () => h('ol', { class: 'tour-steps' }, h('li', null, 'Toccate «Scansiona Altare» e inquadrate il QR: lo scanner è dentro l\'app.'), h('li', null, 'Allontanatevi: vicino all\'Altare si combatte.'), h('li', null, 'Inserite il Sigillo di quel Settore e ottenete un frammento.'), h('li', { class: 'muted' }, 'Senza rete? L\'Altare resta in lista e il Sigillo parte appena torna il segnale.')) },
    { icon: h('div', { class: 'tour-parola' }, h('strong', { class: 'mono' }, 'Frammenti: 4 / 8'), demoSegments), title: 'La Parola', text: ['Ogni Altare custodisce un frammento della Parola. Potete anche aggiungere quelli ricevuti da altre coppie: l\'app verifica che siano veri. Con la Parola intera, correte alla Soglia: vince chi arriva primo.'] },
    { icon: h('div', { class: 'tour-notebook' }, h('div', null, h('span', { class: 'mono muted' }, 'I'), ' Fuoco ', ghost('tour-nb1', 6)), h('div', null, h('span', { class: 'mono muted' }, 'III'), ' Terra ', h('strong', { class: 'mono' }, '7D2Q9K'), ' ', h('span', { class: 'chip chip-blood' }, 'rivelato'))), title: 'Il taccuino', text: ['Ogni tanto il Consiglio tradisce: rivela a tutti il Sigillo di un Settore, che finisce nel vostro taccuino. Lì potete anche verificare un Sigillo che vi hanno mostrato: l\'app vi dice se è vero.'] },
    notices, timers, radio, install];
}

function openTour() {
  const slides = tourSlides();
  let i = 0;
  const box = h('div', { class: 'tour', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Tour dell\'app' });
  const close = () => {
    store.set('zdg_tour_done', true);
    box.remove();
    document.body.classList.remove('no-scroll');
  };
  const show = () => {
    const sl = slides[i];
    const last = i === slides.length - 1;
    mount(box,
      h('div', { class: 'tour-top' },
        h('div', { class: 'tour-dots' }, slides.map((_, k) => h('i', { class: k === i ? 'on' : k < i ? 'past' : '' }))),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: close }, 'Salta')),
      h('div', { class: 'tour-body' },
        h('div', { class: 'tour-visual' }, sl.icon),
        h('div', { class: 'eyebrow' }, `${i + 1} di ${slides.length}`),
        h('h2', null, sl.title),
        sl.text.map((t) => h('p', null, t)),
        sl.extra ? sl.extra() : null),
      h('div', { class: 'tour-nav' },
        h('button', { class: 'btn', type: 'button', disabled: i === 0, onclick: () => { i--; show(); } }, '‹ Indietro'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { if (last) close(); else { i++; show(); } } }, last ? 'Iniziamo' : 'Avanti ›')));
  };
  // Scorrimento col dito tra le schede.
  let x0 = null;
  box.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  box.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0;
    x0 = null;
    if (dx < -60 && i < slides.length - 1) { i++; show(); } else if (dx > 60 && i > 0) { i--; show(); }
  });
  document.body.append(box);
  document.body.classList.add('no-scroll');
  show();
}

// Avvio dopo l'inizializzazione di tutto il modulo.
boot();

export { ApiError };
