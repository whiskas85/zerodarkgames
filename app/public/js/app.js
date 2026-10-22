// PWA delle coppie (i Legati). Mobile first, offline first.
import { createMapView, watchPosition, landmarkItem, accuracyHint, SEND_MAX_ACC } from './map.js';
import { mdi, mdiSvg } from './mdi.js';
import { createField } from './field-ui.js';
import { h, mount, md, eventStatusCard, api, ApiError, makeClock, fmtDuration, fmtTime, ghost, ghostWord, toast, dialog, modal, stream, vibrate, enablePush, store, STATUS_LABELS, voiceSupported, startRecording, uploadAudio, voicePlayer, fmtSec, scanQR, cameraSupported, wordCeremony } from './lib.js';

const ACTIVE = ['truce', 'hunt', 'last_half_hour'];
const clock = makeClock();
const S = {
  state: null,
  ops: [], // gestionali per «Accedi con Zero Dark Ops»
  auth: 'unknown', // unknown | team | none
  online: navigator.onLine,
  connected: false,
  queue: store.get('zdg_queue', []),
  visits: store.get('zdg_visits', {}), // qrToken -> { label, sectorName, at }
  altarResults: store.get('zdg_altar_results', {}), // qrToken -> { ok, message, fragment }
  settings: store.get('zdg_settings', { sound: false, sun: false }),
  timers: store.get('zdg_timers', []).filter((t) => !t.done),
  seenAnn: store.get('zdg_seen_ann', 0),
  // Annunci tolti con uno swipe: spariscono dall'elenco e contano come letti.
  annHidden: store.get('zdg_ann_hidden', []),
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
  if (dm) { giftRescan(dm[1]); history.replaceState(null, '', `/#/dono/${dm[1]}`); }
  const um = location.pathname.match(/^\/u\/([\w-]+)/);
  if (um) history.replaceState(null, '', `/#/uscita/${um[1]}`);
  if (new URLSearchParams(location.search).get('login') === 'invalid') {
    toast('Link di accesso non valido o rigenerato dalla regia', 'error', 7000);
    history.replaceState(null, '', '/' + location.hash);
  }
  // Invito del Consiglio: si entra (anche con Zero Dark Ops) e l'invito si accetta da solo.
  const invite = new URLSearchParams(location.search).get('invito');
  if (invite === 'invalido') toast('Invito scaduto o già usato: chiedine uno nuovo al Consiglio', 'error', 8000);
  if (invite === '1') S.invite = true;
  if (invite) history.replaceState(null, '', '/' + location.hash);
  const opsError = new URLSearchParams(location.search).get('ops_errore');
  if (opsError) {
    toast(opsError, 'error', 8000);
    history.replaceState(null, '', '/' + location.hash);
  }
  api('GET', '/api/public/ops').then((list) => { S.ops = list || []; if (S.auth === 'none') render(); }).catch(() => {});
  api('GET', '/api/public/event').then((ev) => { S.event = ev; if (S.auth === 'none') render(); }).catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.addEventListener('hashchange', render);
  window.addEventListener('online', () => { S.online = true; refresh(); flushQueue(); render(); });
  window.addEventListener('offline', () => { S.online = false; render(); });
  document.addEventListener('visibilitychange', () => {
    // In secondo piano si spegne il GPS dell'app (Traccar continua); al ritorno si riaccende se serve.
    updateTracking(S.state);
    if (!document.hidden) { refresh(); flushQueue(); clearNotifications(route().view); }
  });
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
    const t0 = Date.now();
    const st = await api('GET', '/api/team/state');
    // Ora del server corretta per il tempo di andata e ritorno: ricariche e conti alla rovescia seguono il server,
    // non l'orologio del telefono.
    const offset = st.clock ? st.clock.serverNow - Math.round((t0 + Date.now()) / 2) : undefined;
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
    setState(st, offset);
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

// Le chiavi includono l'istante: dopo un azzeramento della giocata gli id ripartono e non vanno scambiati per già visti.
const seenVictories = new Set(store.get('zdg_seen_victories2', []));
const victoryKey = (v) => `${v.id}@${v.resolvedAt}`;
const seenAlliances = new Set(store.get('zdg_seen_alliances', []));

function setState(st, offset) {
  const prev = S.state;
  // La versione con cui l'app è stata aperta (dal primo stato arrivato dal server, non da quello salvato).
  if (!S.bootVersion && st.appVersion && offset !== undefined) S.bootVersion = st.appVersion;
  S.state = st;
  clock.set(st.clock, offset);
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
      ...st.combat.toConfirm.map((e) => [`e${e.id}`, (e.result === 'lost' ? `${e.reporter.sectorName} dichiara di aver perso contro di voi: confermate?` : `${e.reporter.sectorName} dichiara di avervi sconfitto: confermate?`)])].filter(([k]) => !seen.has(k));
    if (fresh.length) { vibrate([200, 100, 200, 100, 400]); beep(); for (const [, t] of fresh) toast(t, 'blood', 9000); }
  }
  // Scontro vinto (anche da un alleato): Vittoria con i Sigilli di tutta la parte sconfitta, una volta per scontro.
  const victories = (st.combat?.victories || []).filter((v) => !seenVictories.has(victoryKey(v)));
  if (victories.length) {
    for (const v of victories) seenVictories.add(victoryKey(v));
    store.set('zdg_seen_victories2', [...seenVictories].slice(-50));
    const v = victories[victories.length - 1];
    // Nessun Sigillo nuovo: la Vittoria propone quale rubare.
    const steal = (st.combat.steals || []).find((x) => victories.some((y) => y.id === x.engagementId));
    if (steal) setTimeout(() => showSteal(steal), 300);
    else setTimeout(() => showVictory(victories.flatMap((x) => x.seals).filter((n, i, all) => all.findIndex((y) => y.sectorId === n.sectorId) === i), v.against, v.skill === 'maestria' && v.skillBy?.teamId === st.team.id), 300);
  }
  // Alleanza appena stretta: schermata con i Sigilli ricevuti, una volta (dopo un'eventuale Vittoria).
  const news = st.combat?.allianceNews;
  if (news && !seenAlliances.has(news.key)) {
    seenAlliances.add(news.key);
    store.set('zdg_seen_alliances', [...seenAlliances].slice(-50));
    const later = () => (document.querySelector('.battle-overlay:not(.hound)') ? setTimeout(later, 1500) : showAlliance(news));
    setTimeout(later, victories.length ? 1500 : 300);
  }
  store.set('zdg_state', { state: st, offset: clock.offset });
  // Partita in preparazione (o rifatta ripartire): anche gli Altari visitati salvati sul telefono si azzerano.
  if (Object.keys(S.visits).length && (st.clock.status === 'draft' || (prev?.clock.status === 'ended' && st.clock.status !== 'ended'))) {
    S.visits = {};
    store.set('zdg_visits', S.visits);
  }
  // Allinea gli Altari visitati del server con quelli locali.
  for (const v of st.visited) {
    rememberVisit(v.qrToken, { label: v.label, sectorName: v.sectorName });
    // Scansione rinnovata dal server (Memoria): la nuova scadenza vale anche qui.
    const loc = S.visits[v.qrToken];
    if (v.visitedAt && loc && (!loc.scannedAt || v.visitedAt > loc.scannedAt)) { loc.scannedAt = v.visitedAt; loc.expiresAt = v.expiresAt || null; store.set('zdg_visits', S.visits); }
  }
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
  // Alla regia: app installata (schermata Home) e versione caricata.
  const installed = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  sse = stream(`/api/stream?v=${encodeURIComponent(S.bootVersion || '')}&inst=${installed ? 1 : 0}`, {
    open: () => { S.connected = true; S.online = true; refresh(); flushQueue(); },
    error: () => { S.connected = false; render(); },
    state: () => refresh(),
    // Allarme di Prossimità (Skill passiva): solo una vibrazione e un avviso, senza chi né dove.
    proximity: () => { vibrate([80]); toast('Presenza rilevata nelle vicinanze', 'info', 6000); refresh(); },
    // Segugio: la coppia seguita ha conquistato un Altare. Avviso a tutto schermo.
    hound: (x) => { showHound(x); refresh(); },
    announcement: (a) => {
      vibrate([220, 100, 220, 100, 220]);
      beep();
      toast(a.text, 'blood', 9000);
      if (document.hidden) localNotify('Consiglio Zero', a.text, `ann-${a.id}`);
      else closeTag(`ann-${a.id}`);
      refresh();
    },
    notice: (n) => {
      const st = S.state;
      if (!st || !noticeForMe(n, st.team)) return;
      vibrate([300, 120, 300, 120, 300]);
      beep();
      toast(`Avviso del Consiglio: ${n.title}`, 'blood', 9000);
      if (!document.hidden) closeTag(`notice-${n.id}`);
      if (document.hidden) localNotify(`Avviso · ${n.title}`, n.body || 'Toccate per leggere l\'avviso.', `notice-${n.id}`, '/#/avvisi');
      refresh();
    },
    message: (m) => {
      const me = S.state?.player ? S.state.player.nickname || S.state.player.name : null;
      if (m.fromRole === 'team' && m.author === me) { refresh(); return; }
      vibrate([150, 80, 150]);
      const preview = m.audioMime ? '🎤 Messaggio vocale' : m.text;
      const from = m.fromRole === 'master' ? 'Consiglio' : m.author || 'Eletto';
      const where = isElect() ? (m.squadId ? ' · squadra' : ' · Tutti gli Eletti') : '';
      if (route().view !== 'messaggi') toast(`${from}${where}: ${preview}`, 'info', 8000);
      if (document.hidden) localNotify(`${from}${where}`, preview, `msg-${m.id}`, '/#/messaggi');
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
    case 'visit': return api('GET', `/api/team/point/${encodeURIComponent(p.qrToken)}?at=${p.at || ''}${posQuery(p.pos)}`);
    case 'claim': return api('POST', '/api/team/gift/claim', p);
    default: return Promise.resolve({ ok: true });
  }
}

function handleResult(item, res, fromQueue) {
  const prefix = fromQueue ? 'Inviato: ' : '';
  if (item.kind === 'visit') {
    if (res.ok === false) { scanRejected(item.payload.qrToken, res.message); return; }
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
// Se la regia ha fissato un raggio, si manda anche la posizione del telefono: lontani dall'Altare la lettura non vale.
// Con il controllo di posizione acceso l'Altare non risulta letto finché il server non conferma la posizione.
const checkingScan = new Set();
async function registerScan(token) {
  if (checkingScan.has(token)) return;
  const at = Math.round(clock.serverNow());
  const win = S.state?.game.altarScanMin || 0;
  const geo = S.state?.game.altarRadiusM > 0 && navigator.onLine;
  if (geo) { checkingScan.add(token); delete S.visits[token]; store.set('zdg_visits', S.visits); render(); }
  else rememberVisit(token, { scannedAt: at, expiresAt: win > 0 ? at + win * 60000 : null, at: Date.now() });
  delete S.altarResults[token];
  const pos = await scanPosition();
  if (navigator.onLine) {
    api('GET', `/api/team/point/${encodeURIComponent(token)}?at=${at}${posQuery(pos)}`)
      .then((r) => { checkingScan.delete(token); rememberVisit(token, { scannedAt: at, at: Date.now(), label: r.label, sectorName: r.sectorName, sectorId: r.sectorId, expiresAt: r.expiresAt }); refresh(); render(); })
      .catch((e) => {
        checkingScan.delete(token);
        if (e.offline) enqueue('visit', { qrToken: token, at, pos }, 'riconoscimento Altare');
        else if (e.status === 403 || e.status === 428) scanRejected(token, e.message);
        else { toast(e.message, 'error'); delete S.visits[token]; store.set('zdg_visits', S.visits); location.hash = '#/altari'; }
      });
  } else enqueue('visit', { qrToken: token, at, pos }, 'riconoscimento Altare');
}

// Posizione al momento della lettura: solo se la regia ha fissato il raggio degli Altari.
function scanPosition() {
  if (!(S.state?.game.altarRadiusM > 0) || !navigator.geolocation || !window.isSecureContext) return Promise.resolve(null);
  if (myPos && Date.now() - (myPos.at || 0) < 15000) return Promise.resolve(myPos);
  return new Promise((resolve) => navigator.geolocation.getCurrentPosition(
    (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) }),
    () => resolve(null), { enableHighAccuracy: true, maximumAge: 10000, timeout: 12000 }));
}
const posQuery = (pos) => (pos ? `&lat=${pos.lat.toFixed(6)}&lng=${pos.lng.toFixed(6)}&acc=${Math.round(pos.acc || 0)}` : '');

// Lettura rifiutata (troppo lontani o senza GPS): l'Altare non risulta inquadrato e si spiega perché.
function scanRejected(token, message) {
  delete S.visits[token];
  store.set('zdg_visits', S.visits);
  vibrate(300);
  if (location.hash.startsWith('#/altare/')) location.hash = '#/altari';
  dialog({ title: 'Lettura rifiutata', text: String(message || 'Lettura dell\'Altare non valida.').replace(/^Lettura rifiutata:\s*/, ''), okLabel: 'Ho capito', cancelLabel: null });
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
  if (isElect() && ['skill', 'uscita', 'sigillo', 'altari', 'altare', 'frammenti', 'codici', 'dono', 'doni'].includes(view)) view = 'home';
  if (isLobby() && ['skill', 'uscita', 'altari', 'altare', 'frammenti', 'codici', 'messaggi', 'mappa', 'dono', 'doni', 'scontri', 'alleanze'].includes(view)) view = 'home';
  if (isElect() && ['scontri', 'alleanze'].includes(view)) view = 'home';
  if (!isElect() && ['campo', 'incarichi'].includes(view)) view = 'home';
  if ((view === 'mappa' && !isElect()) || view === 'indicazioni') startMapGps(); else stopMapGps();
  if (isElect() && FIELD_VIEWS.includes(view)) { field.startGps(); if (!FE.data) field.load(); } else field.stopGps();
  if (view !== 'mappa') field.leaveMap();
  if (view === 'sigillo') openSeal(); else closeSeal();
  preserveInputs(() => {
    const bodyFn = ({
      home: viewHome, altari: viewAltars, altare: () => viewAltar(arg, query), frammenti: viewFragments, codici: viewNotebook,
      timer: viewTimers, annunci: viewAnnouncements, messaggi: viewMessages, regolamento: viewRules, impostazioni: viewSettings, traccar: viewTraccar,
      avvisi: viewNotices, ice: viewIce, profilo: viewProfile, statoarmi: viewTestArmi, indicazioni: viewGuide, testarmi: viewTestArmi, accettazione: viewAcceptance, mappa: isElect() ? viewElectMap : () => viewMap(arg), campo: viewElectField, incarichi: viewElectTasks, dono: () => viewGift(arg), doni: viewMyGifts, uscita: () => viewExit(arg), skill: viewSkills, scontri: viewCombat, alleanze: viewAlliances,
    }[view] || viewHome);
    // Gioco iniziato senza essere stati accettati all'arrivo: non si partecipa (restano regolamento, ICE, profilo).
    const body = S.state?.notAccepted && !['regolamento', 'impostazioni', 'ice', 'profilo', 'accettazione', 'avvisi', 'annunci'].includes(view) ? viewNotAccepted() : bodyFn();
    const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120;
    mount($app, header(view), banners(), h('main', { class: view === 'messaggi' ? 'main main-chat' : 'main' }, body), radioBar());
    document.body.dataset.view = view;
    if (view === 'mappa' && !isElect()) requestAnimationFrame(fitMap);
    document.body.classList.toggle('chat-open', view === 'messaggi');
    if (view === 'messaggi' && (nearBottom || S.chatScroll)) { S.chatScroll = false; requestAnimationFrame(() => window.scrollTo(0, document.documentElement.scrollHeight)); }
  });
  if (view === 'annunci') markSeen('ann');
  if (view === 'messaggi') markSeen('msg');
  if (view !== 'messaggi') S.chatScroll = true;
  if (view === 'avvisi') markSeen('notice');
  clearNotifications(view);
  updateClocks();
}

// Letta nell'app (avviso a schermo con l'app aperta): la stessa notifica non resta nella tendina.
// La notifica push può arrivare qualche secondo dopo: si riprova per una decina di secondi.
function closeTag(tag) {
  if (!('serviceWorker' in navigator)) return;
  let tries = 0;
  const run = async () => {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      for (const n of (await reg?.getNotifications?.({ tag })) || []) n.close();
    } catch { /* non disponibile */ }
    if (++tries < 5) setTimeout(run, 2500);
  };
  run();
}

// Notifiche del telefono già lette nell'app: quando apri la pagina a cui portano (annunci, avvisi, messaggi,
// scontri…), spariscono dalla tendina. Sulla home spariscono anche quelle degli annunci già visti.
let clearingFor = null;
async function clearNotifications(view) {
  if (document.hidden || !('serviceWorker' in navigator) || clearingFor === view) return;
  clearingFor = view;
  setTimeout(() => { clearingFor = null; }, 3000);
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg?.getNotifications) return;
    for (const n of await reg.getNotifications()) {
      const hash = new URL(n.data?.url || '/', location.origin).hash || '#/home';
      const target = hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'home';
      const annSeen = /^ann-(\d+)$/.exec(n.tag || '');
      if (target === view || (annSeen && Number(annSeen[1]) <= S.seenAnn)) n.close();
    }
  } catch { /* notifiche non disponibili */ }
}

const fxGradient = (fx) => `linear-gradient(120deg, ${[...fx.map((x) => x.color), fx[0].color, ...(fx.length === 1 ? ['transparent', fx[0].color] : [])].join(', ')})`;

// Tocco sulle icone accanto all'orologio: cosa significa ogni effetto attivo e quanto dura ancora.
function perksModal(fx) {
  return modal({ title: 'Effetti attivi', okLabel: 'Ho capito', cancelLabel: null,
    body: h('div', { class: 'perk-list' }, fx.map((x) => h('div', { class: 'perk-row', style: { '--c': x.color } },
      h('span', { class: 'perk-ico', 'aria-hidden': 'true' }, x.icon, x.covered ? h('i', { class: 'fx-conf' }, '🌀') : null),
      h('div', null,
        h('strong', null, x.label),
        x.desc ? h('p', { class: 'small' }, x.desc) : null,
        x.until ? h('p', { class: 'tiny muted' }, 'Ancora ', h('span', { class: 'mono', 'data-abs': x.until }, '—'), ` (fino alle ${fmtTime(x.until)})`) : null)))),
    onOpen: () => updateClocks() });
}

function header(view) {
  const st = S.state;
  const sec = st?.team.sector;
  const net = !S.online ? ['off', 'Senza rete'] : !S.connected ? ['wait', 'Riconnessione…'] : ['on', 'Collegati'];
  // Effetti su di voi (chi vi osserva, i vostri effetti, l'Allarme di Prossimità): icone e alone dei loro colori, sommati.
  const fx = st?.skills?.indicators || [];
  // Con Confusione attiva chi vi osserva resta tra le icone, ma senza alone: l'alone è solo per i pericoli scoperti.
  const glow = fx.filter((x) => !x.covered && !x.quiet);
  // Veglia dopo una sconfitta: piccolo conto alla rovescia nella barra in alto, al posto della fase.
  const veglia = (S.timers || []).find((t) => t.id === 'veglia' && !t.done && t.endsAt > Date.now());
  return h('header', { class: `top ${isElect() ? 'top-elect' : ''} ${fx.length ? 'top-fx' : ''}` },
    view !== 'home' ? h('a', { class: 'back', href: '#/home', 'aria-label': 'Torna alla home' }, '‹') : h('div', { class: 'stamp' }, h('span', null, sec?.roman || '0')),
    h('div', { class: 'top-id' },
      h('div', { class: 'top-sector' }, isElect() ? 'Eletti del Consiglio' : isLobby() ? (st.player?.nickname || st.player?.name || 'Anteprima') : sec ? sec.name : 'Legati'),
      h('div', { class: 'top-sub' }, isElect() ? [st.player?.nickname || st.player?.name, st.field?.squad ? `Squadra ${st.field.squad.name}` : null].filter(Boolean).join(' · ')
        : st?.team.displayName || st?.team.members.map((m) => m.nickname || (m.me ? 'Tu' : m.name) || 'Legato').join(' · ') || '')),
    h('div', { class: `top-clock ${glow.length ? 'fx-on' : ''}`, style: glow.length ? { '--fx-grad': fxGradient(glow), '--fx-a': glow[0].color, '--fx-b': (glow[1] || glow[0]).color } : null },
      fx.length ? h('button', { type: 'button', class: 'fx-icons', 'aria-label': 'Effetti attivi: cosa significano', onclick: () => perksModal(fx) },
        fx.map((x) => h('span', { class: `fx-ico ${x.covered ? 'covered' : ''} ${x.quiet ? 'quiet' : ''}`, 'aria-hidden': 'true', title: x.label, style: { '--c': x.color } }, x.icon,
          x.covered ? h('i', { class: 'fx-conf' }, '🌀') : null))) : null,
      h('div', { class: 'top-time' },
        h('span', { class: `net-dot net-${net[0]}`, role: 'img', 'aria-label': net[1], title: net[1] }),
        h('span', { class: 'mono big', 'data-clock': startAt() ? 'start' : 'remaining' }, '—')),
      startAt() && !veglia ? h('div', { class: 'top-phase' }, 'al via') : veglia ? h('a', { class: 'top-veglia', href: '#/timer', title: veglia.reason || 'Veglia' }, '⛓ Veglia ', h('span', { class: 'mono', 'data-timer': veglia.uid }, '—'))
        : h('div', { class: `top-phase ${st?.clock.status === 'paused' ? 'paused' : ''}` }, STATUS_LABELS[st?.clock.status] || '')),
    avatarButton());
}

// Avatar in alto a destra: la foto di Zero Dark Ops se c'è, altrimenti le iniziali. Toccandolo si apre il menu
// della persona (profilo, ICE, test armi, impostazioni, Consiglio, esci).
function meInfo() {
  const st = S.state;
  const acc = st?.account;
  const me = st?.team?.members?.find((m) => m.me) || st?.player;
  const name = acc?.nickname || acc?.name || me?.nickname || me?.name || 'Legato';
  const words = String(acc?.name || me?.name || name).trim().split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
  return { acc, name, initials, picture: acc?.picture || null };
}
function avatarFace(me, cls = '') {
  return h('span', { class: `avatar ${cls}`, 'aria-hidden': 'true' },
    me.picture ? h('img', { src: me.picture, alt: '', referrerpolicy: 'no-referrer', onerror: (e) => { e.target.replaceWith(document.createTextNode(me.initials)); } }) : me.initials);
}
function avatarButton() {
  if (!S.state) return null;
  const me = meInfo();
  return h('button', { type: 'button', class: 'avatar-btn', 'aria-label': `Menu di ${me.name}`, 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); openAvatarMenu(e.currentTarget); } }, avatarFace(me));
}
function openAvatarMenu(anchor) {
  const old = document.querySelector('.avatar-menu');
  if (old) { old.remove(); return; }
  const me = meInfo();
  const acc = me.acc;
  const item = (href, icon, label, attrs = {}) => h(href ? 'a' : 'button', { class: 'am-item', role: 'menuitem', ...(href ? { href } : { type: 'button' }), ...attrs },
    h('span', { class: 'am-ico', 'aria-hidden': 'true' }, icon), h('span', null, label));
  const menu = h('div', { class: 'avatar-menu', role: 'menu' },
    h('div', { class: 'am-head' }, avatarFace(me, 'lg'), h('div', null, h('strong', null, me.name), acc ? h('div', { class: 'tiny muted' }, `@${acc.username}${acc.ops?.length ? ` · ${acc.ops[0].providerName}` : ''}`) : h('div', { class: 'tiny muted' }, 'Entrato con QR o codice'))),
    acc ? item('#/profilo', '👤', 'Profilo') : null,
    acc ? item('#/ice', '✚', 'ICE · In Case of Emergency') : null,
    item('#/accettazione', '✓', 'La mia accettazione'),
    item('#/testarmi', '⌁', 'Il mio test armi'),
    // Modalità sole (chiara) o notte (scura): interruttore, cambia subito.
    h('div', { class: 'am-item am-theme', role: 'menuitemcheckbox', 'aria-checked': S.settings.sun ? 'true' : 'false' },
      h('span', { class: 'am-ico', 'aria-hidden': 'true' }, S.settings.sun ? '☀' : '☾'), h('span', { class: 'grow' }, S.settings.sun ? 'Modalità sole' : 'Modalità notte'),
      h('button', { type: 'button', class: `theme-switch ${S.settings.sun ? 'on' : ''}`, role: 'switch', 'aria-checked': S.settings.sun ? 'true' : 'false', 'aria-label': 'Modalità sole',
        onclick: (e) => {
          e.stopPropagation();
          S.settings.sun = !S.settings.sun; store.set('zdg_settings', S.settings); applyTheme();
          const row = e.currentTarget.closest('.am-theme');
          e.currentTarget.classList.toggle('on', S.settings.sun);
          e.currentTarget.setAttribute('aria-checked', S.settings.sun ? 'true' : 'false');
          row.querySelector('.am-ico').textContent = S.settings.sun ? '☀' : '☾';
          row.querySelector('.grow').textContent = S.settings.sun ? 'Modalità sole' : 'Modalità notte';
          render();
        } }, h('span', { class: 'theme-knob', 'aria-hidden': 'true' }))),
    item('#/impostazioni', '⚙', 'Impostazioni'),

    item('#/regolamento', '§', 'Regolamento'),
    S.state?.council ? item('/consiglio', '◈', 'Consiglio Zero') : null,
    acc?.staff === 'master' ? item('/regia', '◉', 'Regia') : null,
    item(null, '⏻', 'Esci', { class: 'am-item am-out', onclick: () => logout() }));
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.round(r.bottom + 6)}px`;
  menu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  menu.style.maxHeight = `${Math.max(160, Math.round(window.innerHeight - r.bottom - 14))}px`;
  // Il tocco sull'avatar lo gestisce il suo pulsante (apre/chiude); un tocco fuori chiude.
  const close = (ev) => { if (ev && ((menu.contains(ev.target) && (!ev.target.closest('a, button') || ev.target.closest('.theme-switch'))) || ev.target.closest?.('.avatar-btn'))) return; menu.remove(); document.removeEventListener('click', close, true); window.removeEventListener('hashchange', close); };
  setTimeout(() => { document.addEventListener('click', close, true); window.addEventListener('hashchange', close); }, 0);
  document.body.append(menu);
}

function banners() {
  const st = S.state;
  if (!st) return null;
  const c = st.clock;
  const out = [];
  if (c.status === 'paused') out.push(h('div', { class: 'banner banner-pause', role: 'alert' }, h('strong', null, 'PARTITA SOSPESA'), h('span', null, `Fermatevi e ascoltate il canale radio d'emergenza${st.game.emergencyRadioChannel ? ': ' + st.game.emergencyRadioChannel : ''}`)));
  if (c.status === 'truce') out.push(h('div', { class: 'banner banner-truce' }, h('strong', null, 'Tregua: nessun ingaggio'), h('span', null, 'La caccia si apre tra ', h('b', { class: 'mono', 'data-clock': 'hunt' }, '—'))));
  if (c.status === 'last_half_hour') out.push(h('div', { class: 'banner banner-last' }, h('strong', null, 'Ultima mezz\'ora'), h('span', null, 'Il Consiglio non tradirà più nessuno.')));
  // Il server è stato aggiornato mentre l'app era aperta: questa versione può non capire le novità.
  if (S.bootVersion && st.appVersion && st.appVersion !== S.bootVersion) out.push(h('button', { type: 'button', class: 'banner banner-action banner-update', onclick: () => location.reload() },
    h('strong', null, 'Nuova versione dell\'app'), h('span', null, 'Tocca qui per aggiornare')));
  // Prima della gara: avviso ROSSO di sicurezza (EMERGENZA e ICE) finché non viene letto e compreso.
  if (['draft', 'ready', 'circle'].includes(c.status) && !safetyAcked()) out.push(h('button', { type: 'button', class: 'banner banner-safety', onclick: safetyModal },
    h('strong', null, '⚠ SICUREZZA · OFF GAME'), h('span', null, 'Prima della gara: leggete come funziona il pulsante EMERGENZA e compilate i dati ICE. Toccate qui.')));
  const trkOn = traccarPrompt(st);
  if (trkOn) out.push(trkOn);
  if (!S.online) out.push(h('div', { class: 'banner banner-offline' }, h('span', null, 'Senza rete: l\'app funziona, i dati si aggiornano al ritorno del segnale.')));
  if (S.queue.length) out.push(h('div', { class: 'banner banner-queue' }, h('strong', null, `${S.queue.length} in attesa di rete`), h('span', null, S.queue.map((q) => q.label).join(' · '))));
  if (st.openNew) out.push(h('a', { class: 'banner banner-action', href: '/iscrizione#scelta' }, h('strong', null, 'Nuova partita aperta'), h('span', null, 'Iscriviti ai prossimi Giochi del Buio')));
  if (alliancePending(st) && route().view !== 'alleanze') out.push(h('a', { class: 'banner banner-action', href: '#/alleanze' }, h('strong', null, 'Risposta richiesta'), h('span', null, st.combat.incoming.map((r) => r.kind === 'break' ? `${r.team.sectorName}: rottura dell'alleanza` : `${r.team.sectorName} propone un'alleanza`).join(' · '))));
  if (fightPending(st) && route().view !== 'scontri') out.push(h('a', { class: 'banner banner-action', href: '#/scontri' }, h('strong', null, 'Risposta richiesta'), h('span', null, st.combat.toConfirm.map((e) => `${e.reporter.sectorName}: confermate la sconfitta?`).join(' · '))));
  return out.length ? h('div', { class: 'banners' }, out) : null;
}

// In verticale è la barra in fondo; in orizzontale diventa la colonna a destra (con il menu).
function radioBar() {
  const ch = S.state?.game.emergencyRadioChannel;
  return h('footer', { class: 'radio' },
    S.state ? h('button', { class: 'rail-menu', type: 'button', 'aria-label': 'Menu', onclick: openMenu }, '☰') : null,
    h('span', { class: 'eyebrow' }, 'Radio SOS'), h('strong', { class: 'mono', title: ch || '' }, ch || 'chiedete alla regia'),
    S.state ? h('button', { class: 'btn-sos', type: 'button', onclick: emergencyModal }, 'EMERGENZA') : null);
}

// La mappa occupa tutto lo spazio libero sotto i banner (sopra la barra radio, se è in fondo).
function fitMap() {
  const el = teamMapView.el;
  if (!document.body.contains(el)) return;
  const radio = document.querySelector('.radio');
  const bottom = radio && radio.getBoundingClientRect().top > window.innerHeight / 2 ? radio.offsetHeight : 0;
  const top = el.getBoundingClientRect().top + window.scrollY;
  const height = Math.max(240, Math.round(window.innerHeight - top - bottom));
  if (el.style.height !== `${height}px`) { el.style.height = `${height}px`; teamMapView.resize(); }
}
window.addEventListener('resize', () => { if (document.body.dataset.view === 'mappa') requestAnimationFrame(fitMap); });

// Menu laterale (in orizzontale): le stesse voci della home, che si apre da destra.
function openMenu() {
  document.querySelector('.side-menu')?.remove();
  const grid = viewHome().querySelector?.('nav.grid');
  const close = () => { ov.classList.remove('open'); setTimeout(() => ov.remove(), 200); };
  const ov = h('div', { class: 'side-menu', onclick: (e) => { if (e.target === ov || e.target.closest('a, button')) close(); } },
    h('nav', { class: 'side-menu-panel' },
      h('div', { class: 'side-menu-head' }, h('strong', null, 'Menu'), h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': 'Chiudi' }, '✕')),
      h('a', { class: 'tile', href: '#/home' }, h('span', { class: 'tile-ico', 'aria-hidden': 'true' }, '⌂'), h('span', null, 'Home')),
      grid ? [...grid.children] : null));
  document.body.append(ov);
  requestAnimationFrame(() => ov.classList.add('open'));
}

// Avviso di sicurezza pre-gara: come funziona EMERGENZA (con un simulacro, che non chiama nessuno) e i dati ICE.
// Si toglie solo con la spunta «Ho letto e ho compreso».
const safetyKey = () => `zdg_safety_${S.state?.game.id}`;
const safetyAcked = () => !!(S.state?.player?.safetyAckAt || store.get(safetyKey(), false));
function safetyModal() {
  const ov = h('div', { class: 'sos-overlay safety', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Sicurezza OFF GAME' });
  const close = () => ov.remove();
  const box = h('div', { class: 'sos-box safety-box' });
  const ch = S.state?.game.emergencyRadioChannel;
  const showMain = () => {
    const acc = S.state?.account;
    const filled = iceFilled();
    const check = h('input', { type: 'checkbox', onchange: () => { ok.disabled = !check.checked; } });
    const ok = h('button', { class: 'btn btn-primary btn-block', type: 'button', disabled: true, onclick: async () => {
      store.set(safetyKey(), true);
      try { await api('POST', '/api/team/safety-ack', {}); } catch { /* resta sul telefono */ }
      toast('Grazie: ora sapete cosa fare in caso di emergenza', 'ok');
      close(); refresh(); render();
    } }, 'Conferma');
    box.replaceChildren(
      offGameStripe(),
      h('div', { class: 'eyebrow' }, 'Prima della gara · OFF GAME'),
      h('h2', null, 'In Case of Emergency'),
      h('p', null, 'Questa parte è ', h('strong', null, 'fuori dal gioco ed è una cosa seria'), ': serve solo per infortuni, malori o pericoli reali.'),
      h('h3', { class: 'safety-h' }, '1 · Il pulsante EMERGENZA'),
      h('p', { class: 'small' }, 'In fondo all\'app, sempre visibile, c\'è questo pulsante:'),
      h('div', { class: 'safety-sim', 'aria-hidden': 'true' },
        h('div', { class: 'radio sim-bar' }, h('span', { class: 'eyebrow' }, 'Radio SOS'), h('strong', { class: 'mono' }, ch || '…'), h('span', { class: 'btn-sos' }, 'EMERGENZA')),
        h('div', { class: 'sim-arrow' }, '↓ si apre la schermata di emergenza ↓'),
        h('div', { class: 'sim-screen' }, h('div', { class: 'sim-stripe' }), h('div', { class: 'sim-title' }, 'Emergenza reale'), h('div', { class: 'sim-big' }, 'EMERGENZA'), h('div', { class: 'sim-note' }, 'conferma: «Sì, invia»')),
        h('div', { class: 'sim-tag' }, 'SIMULACRO · non chiama nessuno')),
      h('ul', { class: 'small safety-list' },
        h('li', null, 'Premere EMERGENZA in fondo all\'app ', h('strong', null, 'non fa partire l\'emergenza'), ': apre la schermata di emergenza.'),
        h('li', null, 'Lì premete il pulsante rosso grande e confermate: solo allora la Direzione riceve chi siete, la vostra posizione e i vostri dati ICE.'),
        h('li', null, 'Lo stesso fa il pulsante SOS di Traccar Client.'),
        ch ? h('li', null, 'Se potete, chiamate anche via radio: ', h('strong', { class: 'mono' }, ch), '.') : null),
      h('h3', { class: 'safety-h' }, '2 · I vostri dati ICE'),
      h('p', { class: 'small' }, 'Gruppo sanguigno, patologie da conoscere, contatto di emergenza. Facoltativi, ', h('strong', null, 'non visibili in regia'), ': arrivano alla Direzione solo con l\'emergenza.'),
      acc ? h('button', { class: `btn btn-block ${filled ? '' : 'btn-ice'}`, type: 'button', onclick: showIce }, filled ? '✓ Dati ICE compilati · rivedili' : '✚ Compila i dati ICE')
        : h('p', { class: 'tiny muted' }, 'I dati ICE si salvano nell\'account personale: entrate con il vostro account per compilarli.'),
      h('label', { class: 'safety-check' }, check, ' Ho letto e ho compreso'),
      ok,
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: close }, 'Più tardi'),
      offGameStripe());
  };
  // Compilazione ICE nella stessa finestra: freccia per tornare indietro, oppure Salva.
  const showIce = () => {
    box.replaceChildren(
      offGameStripe(),
      h('button', { class: 'btn btn-ghost btn-sm safety-back', type: 'button', onclick: showMain }, '‹ Indietro'),
      h('h2', null, 'Dati ICE'),
      h('p', { class: 'small' }, h('strong', null, 'Non visibili in regia.'), ' Arrivano alla Direzione solo se premete EMERGENZA e confermate.'),
      iceForm(showMain),
      offGameStripe());
  };
  showMain();
  ov.append(box);
  document.body.append(ov);
}

// EMERGENZA reale (OFF GAME): manda alla Direzione (DE) chi siete e dove siete. Non è un'emergenza di gioco.
function emergencyModal() {
  const ch = S.state?.game.emergencyRadioChannel;
  const ov = h('div', { class: 'sos-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Emergenza' });
  const close = () => ov.remove();
  const status = h('p', { class: 'sos-status', 'aria-live': 'polite' });
  const send = async () => {
    if (!(await dialog({ title: 'Confermi l\'EMERGENZA?', text: 'La Direzione riceve subito la tua posizione e chi sei. Usalo solo per un\'emergenza reale.', okLabel: 'Sì, invia', danger: true }))) return;
    status.textContent = 'Invio…';
    big.disabled = true;
    // Parte subito (con l'ultima posizione nota); appena il GPS dà la posizione del momento, la si manda di nuovo
    // (la regia aggiorna la stessa emergenza).
    const gpsLine = h('span');
    navigator.geolocation?.getCurrentPosition((p) => {
      api('POST', '/api/team/emergency', { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy })
        .then(() => { gpsLine.textContent = ` Posizione GPS inviata (±${Math.round(p.coords.accuracy)} m).`; }).catch(() => {});
    }, () => { gpsLine.textContent = ' GPS non disponibile: comunica la posizione via radio.'; }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    try {
      const r = await api('POST', '/api/team/emergency', myPos || {});
      vibrate([300, 100, 300]);
      status.replaceChildren(h('strong', null, 'Emergenza inviata alla Direzione.'), h('br'),
        `Resta dove sei${ch ? ` e chiama sul canale ${ch}` : ' e tieni la radio accesa'}.`,
        r.located ? ' L\'ultima posizione nota è arrivata.' : ' Ricerca della posizione GPS…', gpsLine);
      big.textContent = 'INVIATA';
    } catch (e) {
      status.textContent = e.offline ? 'Senza rete: chiama subito via radio' + (ch ? ` sul canale ${ch}` : '') + ' o al telefono.' : e.message;
      big.disabled = false;
    }
  };
  const big = h('button', { class: 'sos-big', type: 'button', onclick: send }, 'EMERGENZA');
  ov.append(h('div', { class: 'sos-box' },
    offGameStripe(),
    h('div', { class: 'eyebrow' }, 'Evento OFF GAME'),
    h('h2', null, 'Emergenza reale'),
    h('p', null, 'Questo pulsante manda la tua posizione in DE (Direzione). È un evento ', h('strong', null, 'OFF GAME'), ': non è un\'emergenza di gioco, ma una cosa seria — infortunio, malore, pericolo reale.'),
    h('p', { class: 'small' }, S.state?.account?.ice && Object.values(S.state.account.ice).some(Boolean)
      ? 'Con la chiamata arrivano alla Direzione anche i tuoi dati ICE (gruppo sanguigno, patologie, contatto di emergenza).'
      : ['Puoi aggiungere i tuoi dati ICE (gruppo sanguigno, patologie, contatto di emergenza) nella ', h('a', { href: '#/ice', onclick: () => close() }, 'pagina ICE'), ': arrivano alla Direzione solo se premi questo pulsante.']),
    big,
    status,
    ch ? h('p', { class: 'small' }, 'Se puoi, chiama anche via radio: ', h('strong', { class: 'mono' }, ch)) : null,
    h('button', { class: 'btn btn-block', type: 'button', onclick: close }, 'Chiudi'),
    offGameStripe()));
  document.body.append(ov);
}

const dueDone = new Set();
// Conto alla rovescia al via (partita in preparazione con data e ora previste).
const PRE = ['created', 'draft', 'ready', 'circle'];
function startAt() {
  const st = S.state;
  if (!st || !PRE.includes(st.clock?.status) || !st.game?.scheduledStart) return null;
  const t = new Date(st.game.scheduledStart).getTime();
  return Number.isFinite(t) ? t : null;
}
const pad = (n) => String(n).padStart(2, '0');
function startParts(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return { d: Math.floor(sec / 86400), h: Math.floor(sec / 3600) % 24, m: Math.floor(sec / 60) % 60, s: sec % 60 };
}
// Compatto per la barra in alto: «2g 03:14:05», senza secondi se non c'è spazio.
function fmtStart(ms, noSec) {
  const p = startParts(ms);
  const hms = noSec ? `${pad(p.h)}:${pad(p.m)}` : `${pad(p.h)}:${pad(p.m)}:${pad(p.s)}`;
  return p.d ? `${p.d}g ${hms}` : hms;
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
    if (kind === 'start') { const at = startAt(); txt = at ? fmtStart(at - clock.serverNow(), el.classList.contains('no-sec')) : '—'; }
    if (el.textContent !== txt) el.textContent = txt;
  }
  // Riquadro grande in home: giorni, ore, minuti, secondi.
  const at = startAt();
  for (const el of document.querySelectorAll('[data-cd]')) {
    const v = at ? pad(startParts(at - clock.serverNow())[el.dataset.cd]) : '--';
    if (el.textContent !== v) el.textContent = v;
  }
  for (const row of document.querySelectorAll('.cd-row:not(.no-sec)')) if (row.scrollWidth > row.clientWidth + 1) row.classList.add('no-sec');
  // Barra in alto: se il conto alla rovescia non ci sta, via i secondi.
  const top = document.querySelector('.top');
  const sc = top?.querySelector('[data-clock="start"]');
  if (sc && !sc.classList.contains('no-sec') && top.scrollWidth > top.clientWidth + 1) { sc.classList.add('no-sec'); sc.textContent = fmtStart(at - clock.serverNow(), true); }
  let due = false;
  for (const el of document.querySelectorAll('[data-abs]')) {
    const left = Number(el.dataset.abs) - clock.serverNow();
    const t = fmtDuration(Math.max(0, left), false);
    if (el.textContent !== t) el.textContent = t;
    // Ogni scadenza fa ricaricare una volta sola (niente richieste a raffica se il conto resta a zero).
    if (left <= 0 && !dueDone.has(el.dataset.abs)) { dueDone.add(el.dataset.abs); due = true; }
  }
  // Una scansione è appena scaduta: ridisegna la pagina (sparisce il pulsante di sblocco).
  // (Ricarica di una Skill finita, effetto scaduto…): si chiede lo stato al server, che decide se è davvero pronta.
  if (due && !updateClocks.redrawn) { updateClocks.redrawn = true; setTimeout(() => { updateClocks.redrawn = false; refresh(); }, 300); }
  for (const el of document.querySelectorAll('.cd-bar[data-to]')) {
    const from = Number(el.dataset.from);
    const to = Number(el.dataset.to);
    let f = to > from ? (clock.serverNow() - from) / (to - from) : 1;
    f = Math.min(1, Math.max(0, f));
    el.firstChild.style.width = `${(el.dataset.drain ? 1 - f : f) * 100}%`;
  }
  for (const el of document.querySelectorAll('[data-timer]')) {
    const t = S.timers.find((x) => x.uid === el.dataset.timer);
    el.textContent = !t || t.done ? '00:00' : fmtDuration(Math.max(0, t.endsAt - Date.now()), false);
  }
}

function tickSecond() {
  // App in secondo piano: niente aggiornamenti dello schermo (si ridisegna tutto al ritorno), solo i timer.
  if (document.hidden) { checkTimers(); return; }
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

// Solo la data (senza ora), es. «sabato 15 novembre 2026»; dalla stringa AAAA-MM-GG, senza fusi orari.
function eventDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

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
      if (r.inviteError) toast(r.inviteError, 'error', 8000);
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
    S.event ? h('p', { class: 'event-date' }, eventDate(S.event.date)) : null,
    pendingAltar ? h('p', { class: 'note' }, 'Avete inquadrato un Altare. Entrate: l\'Altare resterà nella vostra lista.') : null,
    S.invite ? h('p', { class: 'note' }, 'Hai un invito del Consiglio. Entra con il tuo account (anche con Zero Dark Ops) oppure registrati: l\'invito si accetta da solo.') : null,
    h('form', { class: 'login-form', onsubmit: login },
      h('label', { class: 'field', for: 'login-user' }, h('span', null, 'Username')), user,
      h('label', { class: 'field', for: 'login-pass' }, h('span', null, 'Password')), pass,
      h('button', { class: 'btn btn-primary btn-xl btn-block', type: 'submit' }, 'Entra')),
    S.ops.length ? h('div', { class: 'login-ops' },
      h('span', { class: 'login-or' }, 'oppure'),
      S.ops.map((o) => h('a', { class: 'btn btn-block btn-ops', href: `/auth/ops/${encodeURIComponent(o.id)}?ritorno=app` }, `Accedi con ${o.name}`))) : null,
    h('a', { class: 'btn btn-block', href: '/iscrizione' }, 'Non hai un account? Registrati'),
    h('a', { class: 'btn btn-block btn-ghost', href: '/regolamento.html', target: '_blank', rel: 'noopener' }, '📖 Leggi il regolamento'),
    h('details', { class: 'login-alt' },
      h('summary', null, 'Hai un QR o un codice d\'accesso del Consiglio?'),
      h('form', { class: 'login-form', onsubmit: byCode },
        h('label', { class: 'field', for: 'access' }, h('span', null, 'Codice d\'accesso')), code,
        h('button', { class: 'btn btn-block', type: 'submit' }, 'Entra con il codice')),
      h('button', { class: 'btn btn-block', type: 'button', onclick: scanLogin }, '⌖ Scansiona il QR di accesso')),
    poweredBy());
}

// Firma in fondo al login: chi c'è dietro i Giochi.
const poweredBy = () => h('div', { class: 'powered-by' },
  h('img', { src: '/img/zdt-logo.jpg', alt: 'Logo Zero Dark Team', width: 56, height: 56 }),
  h('span', null, h('small', null, 'Powered by'), h('strong', null, 'Zero Dark Team')));

// Account senza iscrizione alla partita aperta: si sceglie la sfida dalla pagina di iscrizione.
function viewNoEnrollment() {
  const a = S.account || {};
  return h('main', { class: 'login' },
    h('div', { class: 'emblem big' }, h('span', null, '0')),
    h('p', { class: 'eyebrow' }, `Account · ${a.username || ''}`),
    h('h1', null, a.nickname || a.name || 'Benvenuto'),
    h('p', { class: 'muted' }, 'Non sei ancora iscritto a una partita. Scegli come entrare nel buio: Legati, Temerario Solitario o Eletti del Consiglio.'),
    staffLink(a, 'btn btn-primary btn-xl btn-block'),
    h('a', { class: `btn ${a.staff ? '' : 'btn-primary btn-xl '}btn-block`, href: '/iscrizione#scelta' }, a.staff ? 'Iscriviti a una partita' : 'Scegli la tua sfida'),
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
  // Il testo è in markdown (con pulsanti): la scheda non è un link unico, il tocco fuori dai pulsanti apre gli Avvisi.
  return h('div', { class: 'last-ann new notice-card', role: 'link', tabindex: 0, onclick: (e) => { if (!e.target.closest('a, button')) location.hash = '#/avvisi'; } },
    h('div', { class: 'eyebrow' }, `${n.poll ? 'Sondaggio' : 'Avviso'} · ${fmtTime(n.createdAt)}`), h('strong', null, n.title), n.body ? h('div', { class: 'md' }, md(n.body)) : null,
    n.poll && !n.myVote ? h('p', { class: 'tiny' }, 'Rispondete nella pagina Avvisi.') : null);
}

const ROLE_TEXT = {
  pair: 'Candidati come Legati',
  single: 'Candidato come Temerario Solitario',
  elect: 'Candidato agli Eletti del Consiglio',
};

// Codice della coppia (iscrizione come coppia, compagno non ancora unito): toccandolo si copia.
function pairCodeCard(code) {
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); toast('Codice della coppia copiato', 'ok'); }
    catch {
      const t = h('textarea', { style: { position: 'fixed', opacity: '0' } }, code);
      document.body.append(t); t.select();
      try { document.execCommand('copy'); toast('Codice della coppia copiato', 'ok'); } catch { toast(`Codice: ${code}`, 'ok', 8000); }
      t.remove();
    }
    vibrate(40);
  };
  return h('div', { class: 'card pair-code-card' },
    h('div', { class: 'eyebrow' }, 'Il codice della vostra coppia'),
    h('button', { type: 'button', class: 'pair-code mono', onclick: copy, 'aria-label': `Copia il codice ${code}` }, code),
    h('span', { class: 'tiny muted' }, 'Tocca per copiare'),
    h('p', { class: 'small' }, 'Dallo al tuo compagno: lo inserisce nell\'iscrizione («Ho il codice del compagno») per unirsi alla coppia.'));
}

// Il compagno di squadra: solo soprannome (e squadra softair), mai nome e cognome.
// «Letto» lo nasconde; se il compagno cambia, il riquadro torna (fino al prossimo «Letto»).
const partnerKey = (m) => `${m.id ?? ''}|${m.nickname ?? ''}|${m.softairTeam ?? ''}`;
function partnerCard(m) {
  if (store.get('zdg_partner_seen') === partnerKey(m)) return null;
  return h('div', { class: 'card partner-card' },
    h('div', { class: 'eyebrow' }, 'Il tuo compagno di squadra'),
    h('div', { class: 'partner-name' }, m.nickname ? `«${m.nickname}»` : 'Legato senza soprannome'),
    m.softairTeam ? h('p', { class: 'small muted' }, `Squadra softair: ${m.softairTeam}`) : null,
    h('p', { class: 'tiny muted' }, 'Cercatevi al ritrovo: da qui in poi giocate in coppia.'),
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { store.set('zdg_partner_seen', partnerKey(m)); render(); } }, 'Letto'));
}

// Prima della gara: le cose da fare (test armi, partenza…), scritte dalla regia in markdown.
function prepCard(st) {
  const text = st.game?.prepInfo;
  if (!text || !PRE.includes(st.clock?.status)) return null;
  return h('div', { class: 'card prep-card' }, h('div', { class: 'eyebrow' }, 'Prima della gara · cosa fare'), h('div', { class: 'md' }, md(text)));
}

// In preparazione: conto alla rovescia al via, grande, con giorni, ore, minuti e secondi.
function startCountdown(st) {
  const box = (k, label) => h('div', { class: 'cd-box' }, h('span', { class: 'cd-num mono', 'data-cd': k }, '--'), h('span', { class: 'cd-lbl' }, label));
  return h('div', { class: 'phase start-cd' },
    h('div', { class: 'eyebrow' }, 'Si parte tra'),
    h('div', { class: 'cd-row' }, box('d', 'giorni'), box('h', 'ore'), box('m', 'minuti'), box('s', 'secondi')),
    h('p', { class: 'muted' }, `Inizio previsto: ${new Date(st.game.scheduledStart).toLocaleString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}. `,
      st.clock.status === 'circle' ? 'Siete nel cerchio: memorizzate il vostro Sigillo.' : 'Leggete il regolamento. Il vostro Sigillo apparirà nel cerchio.'));
}

function viewNotAccepted() {
  return h('div', { class: 'stack' },
    h('div', { class: 'card not-accepted' },
      h('div', { class: 'eyebrow' }, 'Partita in corso'),
      h('h2', null, 'Non sei stato accettato'),
      h('p', null, 'All\'arrivo al campo non sei passato dall\'accettazione del Consiglio: senza accettazione non puoi partecipare ai Giochi.'),
      h('p', { class: 'small muted' }, 'Presentati al Consiglio: appena ti accetta, l\'app si sblocca da sola.'),
      h('a', { class: 'btn btn-block', href: '#/accettazione' }, 'La mia accettazione')));
}

// Prima della gara: accettazione e test armi si aprono dai pulsanti azzurri del menu.
const CHECK_FIX = { notifiche: ['#/impostazioni', 'Attivale'], traccar: ['#/traccar', 'Provalo'], iceLetto: [null, 'Leggilo'], iceCompilato: ['#/ice', 'Compila'], app: ['#/impostazioni', 'Come installarla'] };
const nJ = (j) => `${Number(j).toFixed(2).replace('.', ',')} J`;
// Pulsanti azzurri del menu prima della gara: accettazione e test armi (in tempo reale).
function prepTiles() {
  const st = S.state;
  const ev = st?.player?.event;
  // Indicazioni campo (parcheggio, accettazione…): per tutti, finché la partita non passa al Cerchio.
  const guide = st?.guide?.length ? [h('a', { class: 'tile tile-blue', href: '#/indicazioni' }, h('span', { class: 'tile-ico', 'aria-hidden': 'true' }, mdi('signDirection', 26)), h('span', null, 'Indicazioni campo'),
    h('span', { class: 'tiny' }, st.guide.slice(0, 3).map((g) => g.label).join(' · ')))] : [];
  if (!ev || st.player.status !== 'accepted' || !PRE.includes(st.clock?.status)) return guide;
  const live = ev.live?.open;
  return [
    ...guide,
    h('a', { class: 'tile tile-azure', href: '#/accettazione' }, h('span', { class: 'tile-ico', 'aria-hidden': 'true' }, ev.checkinAt ? '✓' : '☐'), h('span', null, 'Accettazione'),
      h('span', { class: 'tiny' }, ev.checkinAt ? `fatta alle ${fmtTime(ev.checkinAt)}` : 'da fare all\'arrivo')),
    h('a', { class: `tile tile-azure ${live ? 'tile-live' : ''}`, href: '#/testarmi' }, h('span', { class: 'tile-ico', 'aria-hidden': 'true' }, '⌁'), h('span', null, 'Test armi'),
      h('span', { class: 'tiny' }, live ? '● in prova adesso' : ev.chronoDoneAt ? 'chiuso' : 'al cronografo')),
  ];
}

// La mia accettazione, in tempo reale: cosa controlla il Consiglio all'arrivo e cosa risulta già a posto.
function viewAcceptance() {
  const st = S.state;
  const ev = st?.player?.event;
  if (!ev) return h('div', { class: 'stack' }, h('h2', null, 'Accettazione'), h('p', { class: 'empty' }, 'Nessuna iscrizione a una partita in corso.'));
  const rows = [{ key: 'presente', label: 'Presentato al campo', on: !!ev.checkinAt, note: ev.checkinAt ? `accettato alle ${fmtTime(ev.checkinAt)}` : 'quando il Consiglio vi accetta' }, ...(ev.checks || [])];
  return h('div', { class: 'stack' },
    h('h2', null, 'La mia accettazione'),
    h('div', { class: `card arrival-card ${ev.checkinAt ? 'done' : ''}` },
      h('strong', null, ev.checkinAt ? '✓ Siete stati accettati' : 'All\'arrivo al campo il Consiglio controlla con voi:'),
      h('ul', { class: 'arrival-list' }, rows.map((c) => {
        const [href, label] = CHECK_FIX[c.key] || [];
        return h('li', { class: c.on ? 'ok' : '' }, h('span', { class: 'ab', 'aria-hidden': 'true' }, c.on ? '✓' : ''),
          h('span', { class: 'grow' }, c.label, c.note ? h('div', { class: 'tiny muted' }, c.note) : c.optional ? h('div', { class: 'tiny muted' }, 'facoltativo') : null),
          c.on || c.key === 'presente' ? null : href ? h('a', { class: 'btn btn-sm btn-ghost', href }, label) : c.key === 'iceLetto' ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: safetyModal }, label) : null);
      })),
      h('p', { class: 'tiny muted' }, 'Si aggiorna da solo: quando sistemate qualcosa o il Consiglio spunta una voce, lo vedete qui. Nessuna voce è obbligatoria: decide il Consiglio.')));
}

// Il mio test armi, in tempo reale: quello che vede l'arbitro al cronografo (pallino, letture, media, massimo, over).
function viewTestArmi() {
  const st = S.state;
  const ev = st?.player?.event;
  if (!ev) return h('div', { class: 'stack' }, h('h2', null, 'Test armi'), h('p', { class: 'empty' }, 'Nessuna iscrizione a una partita in corso.'));
  const lv = ev.live?.open ? ev.live : null;
  const r = lv?.readings || [];
  const avgOf = (a) => (a.length ? a.reduce((x, y) => x + y.j, 0) / a.length : null);
  const mj = avgOf(r);
  const mv = r.length ? r.reduce((x, y) => x + (y.v || 0), 0) / r.length : null;
  const max = r.length ? Math.max(...r.map((x) => x.j)) : null;
  const last = r[r.length - 1];
  const over = r.filter((x) => x.j >= 1).length;
  const g = last?.g || lv?.g;
  const W = (ev.weaponList || []).map((w) => [w.key, w.label]);
  const fmtV = (v) => (v ? `${v.toFixed(1).replace('.', ',')} m/s` : '');
  // La persona sistema la sua lista di armi finché il test non è chiuso (serve il suo accesso personale).
  const canEdit = !ev.chronoDoneAt && !!st.player?.id && !lv;
  const editWeapon = async (body, confirmTitle, confirmText) => {
    if (confirmTitle && !(await dialog({ title: confirmTitle, text: confirmText, okLabel: 'Togli' }))) return;
    try { await api('POST', '/api/team/weapons', body); await refresh(); render(); } catch (e) { toast(e.offline ? 'Serve la rete' : e.message, 'error', 6000); }
  };
  return h('div', { class: 'stack' },
    h('h2', null, 'Il mio test armi'),
    lv ? h('div', { class: `card live-panel ${!r.length ? 'wait' : mj >= 1 ? 'bad' : 'ok'}` },
      h('div', { class: 'eyebrow live-dot' }, `● In prova adesso · ${lv.label}`),
      h('div', { class: 'live-top' },
        h('div', { class: 'live-big' }, h('span', { class: 'eyebrow' }, 'Pallino'), h('strong', { class: 'mono' }, g ? `${g.toFixed(2).replace('.', ',')} g` : '—')),
        h('div', { class: `live-big ${last && last.j >= 1 ? 'over' : ''}` }, h('span', { class: 'eyebrow' }, 'Ultima lettura'), h('strong', { class: 'mono' }, last ? nJ(last.j) : '—'), last ? h('span', { class: 'tiny mono' }, fmtV(last.v)) : null),
        h('div', { class: 'live-big' }, h('span', { class: 'eyebrow' }, 'Tiro'), h('strong', { class: 'mono' }, `${r.length}/3`),
          h('span', { class: 'shot-dots', 'aria-hidden': 'true' }, Array.from({ length: Math.max(3, r.length) }, (_, i) => h('i', { class: i < r.length ? (r[i].j >= 1 ? 'bad' : 'ok') : '' }))))),
      h('div', { class: 'live-stats' },
        h('div', null, h('span', { class: 'eyebrow' }, r.length ? `Media di ${r.length}` : 'Media'), h('strong', { class: 'mono' }, mj != null ? nJ(mj) : '—')),
        h('div', null, h('span', { class: 'eyebrow' }, 'Vel. media'), h('strong', { class: 'mono' }, mv ? fmtV(mv) : '—')),
        h('div', null, h('span', { class: 'eyebrow' }, 'Massimo'), h('strong', { class: 'mono' }, max != null ? nJ(max) : '—'))),
      h('strong', { class: 'live-verdict' }, !r.length ? 'In attesa del primo tiro…' : mj < 1 ? '✓ Media minore di 1 joule' : '✗ Media da 1 joule in su: OVER'),
      over ? h('strong', { class: 'bad-text' }, `⚠ ${over === 1 ? '1 colpo' : `${over} colpi`} sopra 1 joule (max ${nJ(max)})`) : null,
      r.length ? h('div', { class: 'live-reads' }, r.map((x, i) => h('span', { class: `cs-read ${x.j >= 1 ? 'bad' : 'ok'}` }, `#${i + 1} ${nJ(x.j)}${x.v ? ` · ${fmtV(x.v)}` : ''}`))) : null,
      h('p', { class: 'tiny muted' }, 'Al terzo tiro il test di quest\'arma si chiude da solo con il risultato.'))
      : h('p', { class: 'muted small' }, ev.chronoDoneAt ? `Test armi chiuso alle ${fmtTime(ev.chronoDoneAt)}.` : 'Nessuna arma in prova adesso: quando l\'arbitro la mette al cronografo, qui vedete le letture in tempo reale.'),
    W.map(([k, label]) => {
      const w = ev.weapons?.[k] || {};
      const reads = w.readings || [];
      return h('div', { class: `card weapon-card ${w.ok ? 'ok' : w.failed ? 'bad' : ''}` },
        // Prima riga: esito, nome e (a destra) matita e cestino; seconda riga: lo stato del test e i dettagli.
        h('div', { class: 'weapon-head' }, h('span', { class: 'ab', 'aria-hidden': 'true' }, w.ok ? '✓' : w.failed ? '✕' : ''), h('strong', { class: 'grow' }, label),
          canEdit ? h('div', { class: 'row-actions' },
            h('button', { class: 'btn btn-sm btn-icon', type: 'button', title: `Rinomina ${label}`, 'aria-label': `Rinomina ${label}`, onclick: async () => {
              const nn = await dialog({ title: 'Rinomina l\'arma', input: { value: label, placeholder: 'es. M4, Pistola Glock' }, okLabel: 'Salva' });
              if (nn && nn.trim() && nn.trim() !== label) editWeapon({ action: 'rename', key: k, label: nn.trim() });
            } }, '✎'),
            !w.ok && !w.failed && w.j == null ? h('button', { class: 'btn btn-sm btn-trash', type: 'button', title: `Togli ${label}`, 'aria-label': `Togli ${label}`, onclick: () => editWeapon({ action: 'remove', key: k }, `Togliere «${label}»?`, 'Non ce l\'hai: non va provata al cronografo.') }, '🗑') : null) : null),
        h('div', { class: 'weapon-sub' }, h('span', { class: 'small mono' }, w.ok ? (w.manual ? 'passa (a mano)' : `${nJ(w.j)}`) : w.failed ? (w.j == null ? 'non passa (a mano)' : `${nJ(w.j)} · non passa`) : 'da provare'),
          w.j != null ? h('span', { class: 'tiny muted' }, [w.n > 1 ? `media di ${w.n} tiri` : null, w.v ? fmtV(w.v) : null, w.g ? `pallino ${w.g.toFixed(2).replace('.', ',')} g` : null, w.max != null ? `max ${nJ(w.max)}` : null, w.testedAt ? `alle ${fmtTime(w.testedAt)}` : null].filter(Boolean).join(' · ')) : null),
        reads.length ? h('div', { class: 'live-reads' }, reads.map((x, i) => h('span', { class: `cs-read ${x.j >= 1 ? 'bad' : 'ok'}` }, `#${i + 1} ${nJ(x.j)}${x.v ? ` · ${fmtV(x.v)}` : ''}`))) : null);
    }),
    canEdit ? h('button', { class: 'btn btn-block', type: 'button', onclick: async () => {
      const name = await dialog({ title: 'Aggiungi un\'arma', text: 'Ogni replica che porti va provata al cronografo.', input: { placeholder: 'es. Pistola, Secondo fucile' }, okLabel: 'Aggiungi' });
      if (name && name.trim()) editWeapon({ action: 'add', label: name.trim() });
    } }, '＋ Aggiungi un\'arma') : null,
    canEdit ? h('p', { class: 'tiny muted' }, 'Rinomina le tue armi, togli quelle che non hai e aggiungi quelle in più: l\'arbitro vedrà la tua lista.') : null);
}

function viewLobbyHome(st) {
  const pl = st.player || {};
  const pending = pl.status === 'pending';
  const unreadNot = (st.notices || []).filter((n) => n.id > S.seenNotice || (n.poll && !n.myVote)).length;
  const unreadAnn = st.announcements.filter((a) => a.id > S.seenAnn).length;
  const partner = st.team.members.find((m) => !m.me);
  return h('div', { class: 'home' },
    startAt() > clock.serverNow() ? startCountdown(st) : null,
    h('div', { class: 'phase' },
      h('div', { class: 'eyebrow' }, 'Anteprima · ', ROLE_TEXT[pl.role] || 'Iscritto'),
      h('div', { class: 'phase-big' }, pending ? 'Candidatura in attesa' : 'Il Consiglio vi ha accettati'),
      h('p', { class: 'muted' }, pending
        ? 'Il Consiglio sta valutando la vostra candidatura. Intanto esplorate l\'app: quando sarete accettati e avrete il vostro Settore, questo telefono si aggiornerà da solo.'
        : pl.role === 'single' ? 'Il Consiglio sta estraendo il vostro compagno e il Settore. L\'app si aggiornerà da sola.' : 'Il Consiglio sta formando le coppie e assegnando i Settori. L\'app si aggiornerà da sola.'),
      null),
    st.pairCode ? pairCodeCard(st.pairCode) : null,
    partner ? partnerCard(partner) : null,
    prepCard(st),
    trackFlag(st),
    locationInvite(st),
    pushInvite(),
    latestNotice(st),
    h('a', { class: 'btn btn-primary btn-seal', href: '#/sigillo' }, h('span', { class: 'seal-ico' }, '?'), 'Il vostro Sigillo'),
    h('nav', { class: 'grid' },
      ...prepTiles(),
      h('button', { class: 'tile', onclick: () => openTour() }, h('span', { class: 'tile-ico', 'aria-hidden': 'true' }, '▶'), h('span', null, 'Il tour dell\'app')),
      tile('#/avvisi', 'Avvisi', '!', unreadNot || null, unreadNot),
      tile('#/annunci', 'Annunci', '✉', unreadAnn || null, unreadAnn),
      tile('#/timer', 'Timer', '◷', S.timers.filter((t) => !t.done).length || null),
      tile('#/regolamento', 'Regolamento', '§'),
      tile('#/impostazioni', 'Impostazioni', '⚙'),
      S.state?.council ? tile('/consiglio', 'Consiglio Zero', '◈') : null,
      iceTile()),
    pl.accessCode ? h('div', { class: 'card' }, h('div', { class: 'eyebrow' }, 'Il tuo codice personale'), h('div', { class: 'mono big-text' }, pl.accessCode),
      h('p', { class: 'muted small' }, 'Serve per entrare da un altro telefono. Tenetelo per voi.')) : null);
}

function viewElectHome(st) {
  const c = st.clock;
  const unreadAnn = st.announcements.filter((a) => a.id > S.seenAnn).length;
  const unreadMsg = st.messages.filter((m) => m.fromRole === 'master' && m.id > S.seenMsg).length;
  const unreadNot = (st.notices || []).filter((n) => n.id > S.seenNotice || (n.poll && !n.myVote)).length;
  const lastAnn = st.announcements.find((a) => !S.annHidden.includes(a.id));
  return h('div', { class: 'home' },
    prepCard(st),
    h('div', { class: 'phase' },
      h('div', { class: 'eyebrow' }, STATUS_LABELS[c.status]),
      c.running || c.status === 'paused' ? h('div', { class: 'phase-clock mono', 'data-clock': 'remaining' }, '—') : h('div', { class: 'phase-big' }, c.status === 'ended' ? 'I Giochi sono finiti' : 'Al servizio del Consiglio'),
      h('p', { class: 'muted' }, 'Gli Eletti tengono in piedi i Giochi e ne difendono i luoghi. Seguite gli avvisi e i messaggi della regia.')),
    supplyCard(st),
    trackFlag(st),
    locationInvite(st),
    traccarOffCard(st),
    trackingNote(st),
    st.field?.squad ? h('a', { class: 'squad-home', href: '#/incarichi', style: { '--c': st.field.squad.color } },
      h('span', { class: 'eyebrow' }, 'La tua squadra'), h('strong', null, st.field.squad.name),
      h('span', { class: st.field.todo ? 'bad-text small' : 'ok-text small' }, st.field.todo ? `${st.field.todo} incarichi da fare` : 'Nessun incarico in sospeso')) : null,
    pushInvite(),
    latestNotice(st),
    st.standings ? h('div', { class: 'card final' }, h('div', { class: 'eyebrow' }, 'Classifica finale'),
      h('ol', { class: 'final-list' }, st.standings.map((r) => h('li', { class: r.status === 'won' ? 'won-row' : '' }, h('span', { class: 'mono' }, r.rank), h('strong', null, `${r.roman} ${r.sectorName}`), h('span', { class: 'mono' }, r.status === 'won' ? 'Soglia' : r.fragments))))) : null,
    lastAnn ? swipeAway(h('a', { class: `last-ann ${lastAnn.id > S.seenAnn ? 'new' : ''}`, href: '#/annunci' }, h('div', { class: 'eyebrow' }, `Consiglio Zero · ${fmtTime(lastAnn.createdAt)}`), h('p', null, lastAnn.text)), () => hideAnn(lastAnn.id)) : null,
    h('a', { class: 'btn btn-primary btn-seal', href: '#/campo' }, h('span', { class: 'seal-ico' }, '⌖'), 'Piazza Altari e Doni'),
    h('nav', { class: 'grid' },
      ...prepTiles(),
      h('button', { class: 'tile tile-scan', type: 'button', onclick: () => field.scanSign() }, h('span', { class: 'tile-ico', 'aria-hidden': 'true' }, '⌖'), h('span', null, 'Scansiona'), h('span', { class: 'tiny muted' }, 'Altare o dono')),
      tile('#/incarichi', 'Incarichi', '☰', st.field?.todo || null, st.field?.todo),
      tile('#/mappa', 'Mappa del campo', '⛰'),
      tile('#/avvisi', 'Avvisi', '!', unreadNot || null, unreadNot),
      tile('#/annunci', 'Annunci', '✉', unreadAnn || null, unreadAnn),
      tile('#/messaggi', 'Regia', '☏', unreadMsg || null, unreadMsg),
      tile('#/timer', 'Timer', '◷', S.timers.filter((t) => !t.done).length || null),
      tile('#/regolamento', 'Regolamento', '§'),
      tile('#/impostazioni', 'Impostazioni', '⚙'),
      S.state?.council ? tile('/consiglio', 'Consiglio Zero', '◈') : null,
      iceTile()),
    h('div', { class: 'card' }, h('div', { class: 'eyebrow' }, `Gli Eletti (${st.team.members.length})`),
      h('ul', { class: 'elect-members' }, st.team.members.map((m) => h('li', null, m.name, m.nickname ? h('span', { class: 'muted' }, ` «${m.nickname}»`) : null)))));
}

function viewHome() {
  const st = S.state;
  if (!st) return h('p', { class: 'empty' }, 'Caricamento…');
  if (isElect()) return viewElectHome(st);
  if (isLobby()) return viewLobbyHome(st);
  const unreadNot = (st.notices || []).filter((n) => n.id > S.seenNotice || (n.poll && !n.myVote)).length;
  const c = st.clock;
  const total = st.fragments.length;
  const owned = st.fragments.filter((f) => f.text).length;
  const lastAnn = st.announcements.find((a) => !S.annHidden.includes(a.id));
  const unreadAnn = st.announcements.filter((a) => a.id > S.seenAnn).length;
  const unreadMsg = st.messages.filter((m) => m.fromRole === 'master' && m.id > S.seenMsg).length;

  let phase;
  if (startAt() && startAt() > clock.serverNow()) phase = startCountdown(st);
  else if (c.status === 'draft' || c.status === 'ready') phase = h('div', { class: 'phase' }, h('div', { class: 'eyebrow' }, 'In attesa'), h('div', { class: 'phase-big' }, 'Il cerchio non è ancora aperto'), h('p', { class: 'muted' }, st.game.scheduledStart ? `Inizio previsto: ${new Date(st.game.scheduledStart).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' })}. ` : '', 'Leggete il regolamento. Il vostro Sigillo apparirà nel cerchio.'));
  else if (c.status === 'circle') phase = h('div', { class: 'phase' }, h('div', { class: 'eyebrow' }, 'Nel cerchio'), h('div', { class: 'phase-big' }, 'In attesa del via'), h('p', { class: 'muted' }, 'Il vostro Sigillo è svelato. Memorizzatelo e non mostratelo a nessuno.'));
  else if (c.status === 'ended') phase = h('div', { class: 'phase' }, h('div', { class: 'eyebrow' }, 'Fine'), h('div', { class: 'phase-big' }, st.team.finishPosition ? `Siete arrivati ${['', 'primi', 'secondi', 'terzi'][st.team.finishPosition] || st.team.finishPosition + '°'}` : 'I Giochi del Buio sono finiti'), h('p', { class: 'muted' }, 'Abbassate le armi e tornate al Cuore.'));
  else phase = h('div', { class: 'phase' }, h('div', { class: 'eyebrow' }, 'Tempo rimanente'), h('div', { class: 'phase-clock mono', 'data-clock': 'remaining' }, '—'), h('div', { class: 'muted mono small' }, 'trascorso ', h('span', { 'data-clock': 'elapsed' }, '—')));

  return h('div', { class: 'home' },
    st.team.status === 'won' ? h('div', { class: 'won' }, h('strong', null, `Avete pronunciato la Parola alla Soglia${st.team.finishPosition ? ` · ${st.team.finishPosition}° posto` : ''}`), h('span', null, 'Il vostro Settore è libero.')) : null,
    st.team.status === 'withdrawn' ? h('div', { class: 'banner banner-pause' }, h('strong', null, 'Coppia ritirata dalla regia')) : null,
    phase,
    prepCard(st),
    PRE.includes(c.status) && st.team.members.find((m) => !m.me) ? partnerCard(st.team.members.find((m) => !m.me)) : null,
    supplyCard(st),
    trackFlag(st),
    locationInvite(st),
    traccarOffCard(st),
    trackingNote(st),
    st.combat?.alliance ? h('a', { class: 'ally-strip', href: '#/alleanze' }, h('span', { class: 'eyebrow' }, 'Alleati'), h('strong', null, st.combat.alliance.members.filter((m) => m.teamId !== st.team.id).map((m) => `${m.roman} ${m.sectorName}`).join(' · '))) : null,
    pushInvite(),
    latestNotice(st),
    st.standings ? h('div', { class: 'card final' },
      h('div', { class: 'eyebrow' }, 'Classifica finale'),
      h('ol', { class: 'final-list' }, st.standings.map((r) => h('li', { class: `${r.mine ? 'mine' : ''} ${r.status === 'won' ? 'won-row' : ''}` },
        h('span', { class: 'mono' }, r.rank), h('strong', null, `${r.roman} ${r.sectorName}`),
        h('span', { class: 'mono' }, r.status === 'won' ? 'Soglia' : `${r.fragments}/${total}`))))) : null,
    // I Sigilli (codici) presi: il vostro, i rivelati, quelli conquistati; un tocco apre il taccuino.
    st.notebook?.length ? h('a', { class: 'progress', href: '#/codici' },
      h('div', { class: 'progress-head' }, h('span', { class: 'eyebrow' }, 'I Sigilli'), h('strong', { class: 'mono' }, `Codici: ${st.notebook.filter((n) => n.code).length} / ${st.notebook.length}`)),
      h('div', { class: 'segments' }, st.notebook.map((n) => h('i', { class: n.code ? 'on' : '' })))) : null,
    h('a', { class: 'progress', href: '#/frammenti' },
      h('div', { class: 'progress-head' }, h('span', { class: 'eyebrow' }, 'La Parola'), h('strong', { class: 'mono' }, `Frammenti: ${owned} / ${total || '?'}`)),
      h('div', { class: 'segments' }, st.fragments.map((f) => h('i', { class: f.text ? 'on' : '' })))),
    owned && owned === total ? wonBanner() : null,
    houndCards(st),
    presageCards(st),
    trackingCards(st),
    st.skills?.dirty ? h('a', { class: 'supply-card', href: '#/mappa' }, h('span', { class: 'eyebrow' }, 'Alleanze sporche'), dirtyLine(st.skills.dirty)) : null,
    lastAnn ? swipeAway(h('a', { class: `last-ann ${lastAnn.id > S.seenAnn ? 'new' : ''}`, href: '#/annunci' }, h('div', { class: 'eyebrow' }, `Consiglio Zero · ${fmtTime(lastAnn.createdAt)}`), h('p', null, lastAnn.text)), () => hideAnn(lastAnn.id)) : null,
    h('a', { class: 'btn btn-primary btn-seal', href: '#/sigillo' }, h('span', { class: 'seal-ico' }, st.team.sector?.roman || '0'), 'Il mio Sigillo'),
    h('nav', { class: 'grid' },
      ...prepTiles(),
      h('button', { class: 'tile tile-scan', type: 'button', onclick: openScanner }, h('span', { class: 'tile-ico', 'aria-hidden': 'true' }, '⌖'), h('span', null, 'Scansiona'), h('span', { class: 'tiny muted' }, 'Altare o dono')),
      tile('#/mappa', 'Mappa', '⛰', (st.map?.gifts.length || null), st.map?.gifts.length),
      tile('#/altari', 'Altari visitati', '⛬', allVisited().length || null),
      tile('#/skill', 'Skill', '✧', skillBadge(st), st.skills?.canChoose && skillBadge(st)),
      tile('#/doni', 'I vostri doni', '✦', (st.gifts || []).filter((g) => !g.usedAt).length || null),
      tile('#/alleanze', 'Alleanze', '⚑', alliancePending(st) || null, alliancePending(st)),
      tile('#/scontri', 'Scontri', '⚔', fightPending(st) || null, fightPending(st)),
      // Sigilli conosciuti (il proprio, i rivelati, quelli conquistati) sul totale dei Settori in gioco: apre il taccuino.
      tile('#/codici', 'Codici', '✱', st.notebook?.length ? `${st.notebook.filter((n) => n.code).length}/${st.notebook.length}` : null),
      tile('#/frammenti', 'Frammenti', '❖', `${owned}/${total || '?'}`),
      tile('#/avvisi', 'Avvisi', '!', unreadNot || null, unreadNot),
      tile('#/annunci', 'Annunci', '✉', unreadAnn || null, unreadAnn),
      tile('#/messaggi', 'Regia', '☏', unreadMsg || null, unreadMsg),
      tile('#/timer', 'Timer', '◷', S.timers.filter((t) => !t.done).length || null),
      tile('#/regolamento', 'Regolamento', '§'),
      tile('#/impostazioni', 'Impostazioni', '⚙'),
      S.state?.council ? tile('/consiglio', 'Consiglio Zero', '◈') : null,
      iceTile()));
}

function supplyCard(st) {
  const open = (st.supplyOpen || []).filter((x) => x.closesAt > clock.serverNow());
  return [privilegeCard(st), ...open.map((x) => h('a', { class: 'supply-card', href: '#/annunci' },
    h('span', { class: 'eyebrow' }, 'Armamenti al Cuore · aperti'),
    h('strong', null, 'Chiude tra ', h('span', { class: 'mono', 'data-abs': x.closesAt }, '—')),
    x.text ? h('span', { class: 'small muted' }, x.text) : null))];
}

function tile(href, label, icon, badge, alert) {
  return h('a', { class: 'tile', href }, h('span', { class: 'tile-ico', 'aria-hidden': 'true' }, icon), h('span', null, label), badge ? h('span', { class: `badge ${alert ? 'badge-alert' : ''}` }, badge) : null);
}

// ---------------------------------------------------------------- Alleanze e scontri

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

// Alleanze e scontri sono due pagine. Le alleanze degli altri sono segrete: negli scontri si vede solo la coppia.
const alliancePending = (st) => (st?.combat ? st.combat.incoming.length : 0);
const fightPending = (st) => (st?.combat ? st.combat.toConfirm.length + (st.combat.steals || []).length : 0);

function viewAlliances() {
  const st = S.state;
  const c = st?.combat;
  if (!c) return h('p', { class: 'empty' }, 'Disponibile per le coppie in gioco.');
  const playing = ACTIVE.includes(st.clock.status);
  const mySize = c.alliance ? c.alliance.members.length : 1;
  const others = c.teams.filter((t) => !t.allied);

  return h('div', { class: 'stack' },
    h('h2', null, 'Alleanze'),

    c.incoming.length ? h('div', { class: 'stack-sm' }, c.incoming.map((r) => h('div', { class: 'combat-card ask' },
      h('div', { class: 'eyebrow' }, r.kind === 'break' ? 'Rottura dell\'alleanza' : 'Proposta di alleanza'),
      h('strong', null, r.kind === 'break' ? `${teamName(r.team)} vuole lasciare l'alleanza` : `${teamName(r.team)} vi propone un'alleanza`),
      r.kind === 'join' ? h('p', { class: 'small muted' }, 'Accettando vi scambiate i Sigilli: li ricevete in automatico nel taccuino.') : h('p', { class: 'small muted' }, 'Accettando l\'alleanza è rotta: blocco ingaggio di 5 minuti.'),
      h('p', { class: 'small' }, 'Scade tra ', h('span', { class: 'mono', 'data-abs': r.expiresAt }, '—')),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-primary', onclick: () => combatCall(`/api/team/alliance/${r.id}/respond`, { accept: true }, r.kind === 'join' ? 'Alleanza stretta' : 'Alleanza rotta') }, 'Accetta'),
        h('button', { class: 'btn btn-danger', onclick: () => combatCall(`/api/team/alliance/${r.id}/respond`, { accept: false }, 'Rifiutata') }, 'Rifiuta')),
      r.kind === 'join' && skillReady('diplomatico') ? h('button', { class: 'btn btn-sm', onclick: () => combatCall(`/api/team/alliance/${r.id}/respond`, { accept: true, diplomat: true }, 'Alleanza stretta con Diplomatico: il vostro Sigillo resta vostro') }, '🤝 Accetta con Diplomatico (non mostrate il vostro Sigillo)') : null))) : null,

    h('section', { class: 'card stack-sm' },
      h('div', { class: 'eyebrow' }, c.alliance ? `La vostra alleanza (${c.alliance.members.length}/${c.maxAlliance})` : 'Nessuna alleanza'),
      c.alliance ? h('ul', { class: 'ally-list' }, c.alliance.members.filter((m) => m.teamId !== st.team.id).map((m) => {
        const asked = c.outgoing.find((r) => r.kind === 'break' && r.team.teamId === m.teamId);
        return h('li', null, h('strong', null, teamName(m)),
          asked ? h('span', { class: 'chip chip-brass' }, 'rottura proposta')
            : h('button', { class: 'btn btn-sm btn-danger', disabled: !playing, onclick: async () => {
              if (await dialog({ title: 'Rompere l\'alleanza?', text: `${m.sectorName} dovrà accettare, ma se siete a più di 50 m l'alleanza si rompe subito (anche se vi allontanate dopo). Poi blocco ingaggio di 5 minuti.`, okLabel: 'Rompi l\'alleanza', danger: true })) {
                const r = await combatCall('/api/team/alliance/break', { teamId: m.teamId });
                if (r) toast(r.broken ? `Alleanza rotta: siete a più di 50 m da ${m.sectorName}` : `Rottura proposta a ${m.sectorName}`, 'ok', 6000);
              }
            } }, 'Rompi'));
      })) : h('p', { class: 'small muted' }, 'Proponete un\'alleanza a un\'altra coppia: dovrà accettarla dal suo telefono.'),
      c.outgoing.filter((r) => r.kind === 'join').map((r) => h('div', { class: 'pending-row' },
        h('span', null, `In attesa di ${r.team.sectorName} · scade tra `, h('span', { class: 'mono', 'data-abs': r.expiresAt }, '—')),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: () => combatCall(`/api/team/alliance/${r.id}/cancel`, {}, 'Proposta ritirata') }, 'Ritira'))),
      !playing ? h('p', { class: 'small muted' }, 'Le alleanze si stringono a partita in corso.')
        : mySize >= c.maxAlliance ? h('p', { class: 'small muted' }, `Alleanza al completo: al massimo ${c.maxAlliance} coppie.`) : [
          h('p', { class: 'small muted' }, 'Proponi un\'alleanza a:'),
          h('div', { class: 'opp-grid' }, others.map((t) => {
            const waiting = t.retryAt && t.retryAt > clock.serverNow();
            const pending = c.outgoing.some((r) => r.kind === 'join' && r.team.teamId === t.teamId);
            return h('button', { type: 'button', class: 'opp', disabled: waiting || pending, onclick: async () => {
              const dip = skillReady('diplomatico') ? h('input', { type: 'checkbox' }) : null;
              if (dip) {
                const ok = await modal({ title: `Alleanza con ${t.sectorName}?`, okLabel: 'Proponi', body: h('div', { class: 'stack-sm' },
                  h('p', null, `${t.sectorName} riceverà la proposta e dovrà accettarla entro pochi minuti. Accettando vi scambiate i Sigilli.`),
                  h('label', { class: 'pick-item' }, dip, h('span', { class: 'pick-text' }, h('strong', null, '🤝 Usa Diplomatico'), h('span', { class: 'tiny muted' }, 'Gli alleati non ricevono il vostro Sigillo (voi ricevete i loro).')))) });
                if (ok) combatCall('/api/team/alliance/request', { teamId: t.teamId, diplomat: dip.checked }, `Proposta inviata a ${t.sectorName}`);
              } else if (await dialog({ title: `Alleanza con ${t.sectorName}?`, text: `${t.sectorName} riceverà la proposta e dovrà accettarla entro pochi minuti. Accettando vi scambiate i Sigilli.`, okLabel: 'Proponi' })) combatCall('/api/team/alliance/request', { teamId: t.teamId }, `Proposta inviata a ${t.sectorName}`);
            } }, h('strong', null, teamName(t)),
            waiting ? h('span', { class: 'tiny muted' }, 'riproponi tra ', h('span', { class: 'mono', 'data-abs': t.retryAt }, '—')) : pending ? h('span', { class: 'tiny muted' }, 'in attesa') : null);
          })),
          h('p', { class: 'tiny muted' }, `Le alleanze degli altri sono segrete: se insieme superate le ${c.maxAlliance} coppie, l'alleanza non si può stringere.`),
        ]));
}

function viewCombat() {
  const st = S.state;
  const c = st?.combat;
  if (!c) return h('p', { class: 'empty' }, 'Disponibile per le coppie in gioco.');
  const status = st.clock.status;
  const fighting = ['hunt', 'last_half_hour'].includes(status);
  const opponents = c.teams.filter((t) => !t.allied);
  if (combatOpp && !opponents.some((t) => t.teamId === combatOpp)) combatOpp = null;
  const opp = opponents.find((t) => t.teamId === combatOpp);

  const report = async (result) => {
    if (!opp) return toast('Scegliete prima la coppia avversaria', 'error');
    const allies = c.alliance ? c.alliance.members.filter((m) => m.teamId !== st.team.id).map(teamName) : [];
    const text = {
      lost: `Dichiarate di aver perso contro ${teamName(opp)}? ${opp.sectorName} dovrà confermare la vittoria: poi il vostro Sigillo${allies.length ? ' e quelli dei vostri alleati' : ''} andranno a ${opp.sectorName} (e ai suoi alleati, se ne ha) e parte la Veglia.`,
      won: `Dichiarate di aver vinto contro ${teamName(opp)}? ${opp.sectorName} dovrà confermare: poi riceverete i Sigilli della parte sconfitta${allies.length ? ' (anche i vostri alleati)' : ''}.`,
      draw: `Pareggio con ${teamName(opp)}? Blocco ingaggio di 5 minuti per tutti.`,
    }[result];
    if (!(await dialog({ title: { lost: 'Scontro perso', won: 'Scontro vinto', draw: 'Pareggio' }[result], text, okLabel: 'Registra', danger: result === 'lost' }))) return;
    const r = await combatCall('/api/team/engagement', { opponentTeamId: opp.teamId, result }, result === 'draw' ? 'Scontro registrato' : `In attesa della conferma di ${opp.sectorName}`);
    if (r) combatOpp = null;
  };
  const other = (e) => (e.mine === 'won' ? e.losers : e.mine === 'lost' ? e.winners : [...e.winners, ...e.losers].filter((x) => !c.alliance?.members.some((m) => m.teamId === x.teamId) && x.teamId !== st.team.id));
  // Skill da scontro: Maestria delle armi e Immunità (sulla sconfitta), Velenoso (dopo lo scontro).
  const maestria = skillReady('maestria');
  const immunita = skillReady('immunita');
  const lostWith = (skill) => {
    if (!opp) return toast('Scegliete prima la coppia avversaria', 'error');
    combatCall('/api/team/engagement', { opponentTeamId: opp.teamId, result: 'lost', skill }, skill === 'maestria' ? `Perso con Maestria delle armi: quando ${opp.sectorName} conferma, lo scontro è vostro` : `Sconfitta con Immunità: il vostro Sigillo resterà coperto. In attesa della conferma di ${opp.sectorName}`).then((r) => { if (r) combatOpp = null; });
  };
  const outcome = (e) => {
    const vs = other(e).map((x) => x.sectorName).join(', ');
    if (e.skill === 'maestria' && e.skillBy?.teamId === st.team.id && e.status === 'pending') return `Perso con Maestria delle armi contro ${vs}: quando confermano, vincete voi`;
    if (e.skill === 'maestria' && e.skillBy?.teamId === st.team.id) return `Perso contro ${vs} → vinto con Maestria delle armi`;
    if (e.skill === 'maestria' && e.mine === 'lost') return `Perso contro ${vs}: vittoria ribaltata dalla Maestria delle armi`;
    return `${e.mine === 'draw' ? 'Pareggio con' : e.mine === 'won' ? 'Vinto contro' : 'Perso contro'} ${vs}${e.hidden?.[st.team.id] ? ` · Sigillo coperto (${e.hidden[st.team.id] === 'reliquia' ? 'Reliquia Antica' : 'Immunità'})` : ''}`;
  };

  return h('div', { class: 'stack' },
    h('h2', null, 'Scontri'),

    (c.steals || []).map((x) => h('div', { class: 'combat-card ask' },
      h('div', { class: 'eyebrow' }, 'Sigillo da rubare'),
      h('strong', null, `Vittoria contro ${x.against ? teamName(x.against) : 'la parte sconfitta'}`),
      h('p', { class: 'small muted' }, 'I loro Sigilli li conoscete già: scegliete quale rubare dal loro taccuino.'),
      h('button', { class: 'btn btn-primary', onclick: () => showSteal(x) }, 'Scegli il Sigillo'))),

    c.toConfirm.length ? h('div', { class: 'stack-sm' }, c.toConfirm.map((e) => (e.result === 'lost' ? h('div', { class: 'combat-card ask' },
      // Chi ha perso lo ha dichiarato: la vittoria va confermata da chi ha vinto.
      h('div', { class: 'eyebrow' }, 'Vittoria da confermare'),
      h('strong', null, `${teamName(e.reporter)} dichiara di aver perso contro di voi`),
      h('p', { class: 'small muted' }, 'Confermando ricevete i Sigilli della parte sconfitta e per loro parte la Veglia. Se non è vero, contestate: decide la regia.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-primary', onclick: async () => { const r = await combatCall(`/api/team/engagement/${e.id}/respond`, { confirm: true }); if (r && !r.flipped) toast('Vittoria confermata', 'ok', 6000); } }, 'Confermo, abbiamo vinto'),
        h('button', { class: 'btn btn-danger', onclick: () => combatCall(`/api/team/engagement/${e.id}/respond`, { confirm: false }, 'Contestato: decide la regia') }, 'Contesto')))
      : h('div', { class: 'combat-card ask' },
      h('div', { class: 'eyebrow' }, 'Esito da confermare'),
      h('strong', null, `${teamName(e.reporter)} dichiara di avervi sconfitto`),
      h('p', { class: 'small muted' }, `Confermando, i Sigilli di ${e.losers.map((x) => x.sectorName).join(', ')} vanno a ${e.winners.map((x) => x.sectorName).join(', ')} (e ai suoi alleati, se ne ha). Se non è vero, contestate: decide la regia.`),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-primary', onclick: () => combatCall(`/api/team/engagement/${e.id}/respond`, { confirm: true }, 'Sconfitta confermata: Veglia') }, 'Confermo, abbiamo perso'),
        h('button', { class: 'btn btn-danger', onclick: () => combatCall(`/api/team/engagement/${e.id}/respond`, { confirm: false }, 'Contestato: decide la regia') }, 'Contesto')),
      maestria || immunita ? h('div', { class: 'skill-holds' },
        maestria ? holdButton('⚔️ Maestria delle armi: vinciamo noi', () => combatCall(`/api/team/engagement/${e.id}/respond`, { confirm: true, skill: 'maestria' }, 'Maestria delle armi: lo scontro è vostro')) : null,
        immunita ? holdButton('🧿 Confermo con Immunità', () => combatCall(`/api/team/engagement/${e.id}/respond`, { confirm: true, skill: 'immunita' }, 'Sconfitta con Immunità: il vostro Sigillo resta coperto')) : null,
        h('p', { class: 'tiny muted' }, 'Tenete premuto finché la barra si riempie.')) : null)))) : null,

    h('section', { class: 'card stack-sm' },
      h('div', { class: 'eyebrow' }, 'Esito di uno scontro'),
      !fighting ? h('p', { class: 'muted small' }, status === 'truce' ? 'Tregua: nessun ingaggio.' : 'Gli scontri si registrano a caccia aperta.') : [
        h('p', { class: 'small muted' }, 'Contro chi avete combattuto?'),
        h('div', { class: 'opp-grid' }, opponents.map((t) => h('button', { type: 'button', class: `opp ${combatOpp === t.teamId ? 'on' : ''}`, onclick: () => { combatOpp = t.teamId; render(); } },
          h('strong', null, teamName(t))))),
        h('div', { class: 'result-btns' },
          h('button', { class: 'btn btn-xl res-won', disabled: !opp, onclick: () => report('won') }, 'VINTO'),
          h('button', { class: 'btn btn-xl res-lost', disabled: !opp, onclick: () => report('lost') }, 'PERSO'),
          h('button', { class: 'btn res-draw', disabled: !opp, onclick: () => report('draw') }, 'Pareggio')),
        maestria || immunita ? h('div', { class: 'skill-holds' },
          maestria ? holdButton('⚔️ Perso, ma Maestria delle armi', () => lostWith('maestria'), !opp) : null,
          immunita ? holdButton('🧿 Perso con Immunità', () => lostWith('immunita'), !opp) : null,
          h('p', { class: 'tiny muted' }, 'Skill: tenete premuto finché la barra si riempie.')) : null,
        h('p', { class: 'tiny muted' }, 'Niente scambio di Sigilli a mano: l\'esito vale quando l\'altra coppia lo conferma, poi chi vince riceve i Sigilli nel taccuino (anche i suoi alleati) e chi perde fa la Veglia.'),
      ]),

    c.history.length ? h('section', { class: 'stack-sm' },
      h('div', { class: 'eyebrow' }, 'Ultimi scontri'),
      h('ul', { class: 'list' }, c.history.map((e) => h('li', { class: `hist hist-${e.mine}` },
        h('span', { class: 'mono small muted' }, fmtTime(e.createdAt)),
        h('span', null, outcome(e)),
        h('span', { class: `chip ${e.status === 'confirmed' ? (e.mine === 'won' ? 'chip-ok' : e.mine === 'lost' ? 'chip-blood' : '') : 'chip-brass'}` },
          { pending: 'da confermare', confirmed: 'registrato', contested: 'contestato', cancelled: 'annullato' }[e.status]),
        e.poisonBy ? h('span', { class: 'tiny muted hist-wide' }, `☠️ Alleanza avversaria rotta dal Velenoso del Settore ${e.poisonBy.sectorName}`) : null,
        e.canPoison && skillReady('velenoso') ? h('div', { class: 'hist-wide' }, holdButton('☠️ Velenoso: rompi la loro alleanza', async () => { const r = await combatCall(`/api/team/engagement/${e.id}/poison`, {}); if (r?.broken) showPoisonCast(r.broken); })) : null)))) : null);
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

// Batteria: il GPS dell'app serve solo se Traccar Client non sta già mandando la posizione, e solo con l'app in primo
// piano (con lo schermo spento ci pensa Traccar). Sulla mappa il GPS resta acceso a parte (startMapGps).
function updateTracking(st) {
  const on = trackingOn(st) && !document.hidden && !st?.tracking?.on;
  if (on && !trackStop) {
    trackStop = watchPosition((pos) => {
      const hint = pos.acc > SEND_MAX_ACC ? accuracyHint(pos.acc) : null;
      if (hint !== trackMsg) { const had = !!trackMsg; trackMsg = hint; const el = document.getElementById('track-msg'); if (el && hint) el.textContent = hint; else if (had !== !!hint) render(); }
      sendPosition(pos);
    }, (msg) => { trackMsg = msg; });
  } else if (!on && trackStop) {
    trackStop();
    trackStop = null;
  }
}

// Solo se c'è un problema con la posizione (GPS negato o assente): il messaggio e il link a Traccar.
function trackingNote(st) {
  if (!trackingOn(st) || !trackMsg) return null;
  return h('p', { class: 'track-note small' }, '📍 ', h('span', { class: 'bad-text', id: 'track-msg' }, trackMsg),
    st.player ? [' ', h('a', { href: '#/traccar' }, 'Traccar →')] : null);
}

// A partita finita: ricordare di spegnere Traccar Client (si toglie con «Fatto»).
function traccarOffCard(st) {
  const key = `zdg_trk_off_${st?.game?.id}`;
  if (st?.clock?.status !== 'ended' || store.get(key, false)) return null;
  return h('div', { class: 'card traccar-off' },
    h('strong', null, '📍 Spegnete Traccar Client'),
    h('p', { class: 'small' }, 'La partita è finita: aprite Traccar Client e fermate il tracciamento, così il telefono smette di mandare la posizione e risparmia batteria.'),
    h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => { store.set(key, true); render(); } }, 'Fatto, l\'ho spento'));
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
    guideMapView.setMe(p);
    const el = document.getElementById('map-gps');
    if (el) el.hidden = true;
  }, (msg) => { gpsMsg = msg; const el = document.getElementById('map-gps'); if (el) { el.textContent = msg; el.hidden = false; } });
}
function stopMapGps() { stopGps?.(); stopGps = null; }

// Parola intera: il riquadro porta alla mappa inquadrata sulla Soglia.
function wonBanner() {
  if (S.state?.team?.status === 'won') return null;
  return h('a', { class: 'won', href: '#/mappa/soglia' }, h('strong', null, 'Avete la Parola intera.'), h('span', null, 'Esfiltrate: alla Soglia leggete il codice di uscita →'));
}

// Parola intera a partita in corso: si può tentare l'uscita alla Soglia.
function canExit(st = S.state) {
  if (!st || isElect() || isLobby() || st.team?.status !== 'active' || !ACTIVE.includes(st.clock?.status)) return false;
  const frs = st.fragments || [];
  return frs.length > 0 && frs.every((f) => f.text);
}

async function scanExit() {
  const text = await scanQR({
    title: 'Codice di uscita',
    hint: 'Inquadrate il QR di uscita appeso alla Soglia.',
    accept: (t) => (/\/u\/[\w-]+/.test(t) ? true : /\/(a|d)\//.test(t) ? 'Questo è un Altare o un Dono, non il codice di uscita' : 'Questo non è il codice di uscita della Soglia'),
  });
  if (text) tryExit(text.match(/\/u\/([\w-]+)/)[1]);
}

const exitTried = new Set();
function viewExit(token) {
  if (token && !exitTried.has(token)) { exitTried.add(token); setTimeout(() => tryExit(token)); }
  return h('div', { class: 'stack' },
    h('h2', null, 'Uscita dalla Soglia'),
    h('p', { class: 'muted' }, 'Verifica del codice di uscita…'),
    h('a', { class: 'btn', href: '#/mappa/soglia' }, 'Torna alla mappa'));
}

function exitVictory(r) {
  let el;
  const close = () => el.remove();
  vibrate([120, 60, 120, 60, 400]);
  beep();
  el = battleOverlay('victory',
    h('div', { class: 'battle-burst', 'aria-hidden': 'true' }),
    h('div', { class: 'eyebrow' }, 'La Soglia'),
    h('h2', { class: 'battle-title' }, 'Esfiltrati'),
    h('p', null, `Avete portato la Parola oltre la Soglia${r.position ? `: ${r.position}° posto` : ''}. Il vostro Settore è libero.`),
    r.already ? null : h('p', { class: 'muted' }, 'Il vostro Sigillo ora è rivelato a tutte le coppie, come in un tradimento.'),
    h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: close }, 'Chiudi'));
}

async function tryExit(token) {
  let r;
  try { r = await api('POST', '/api/team/exit', { token }); } catch (e) {
    toast(e.offline ? 'Serve la rete per esfiltrare: riprovate dove c\'è segnale' : e.message, 'error', 8000);
    if (location.hash.startsWith('#/uscita/')) location.hash = '#/mappa/soglia';
    return;
  }
  if (location.hash.startsWith('#/uscita/')) location.hash = r.exfiltrated ? '#/home' : '#/mappa/soglia';
  refresh();
  const close = () => el.remove();
  let el;
  if (r.exfiltrated) {
    // Prima la Parola che si compone dai frammenti (~10 s), poi l'esito.
    const word = r.word?.length ? r.word : (S.state?.fragments || []).map((f) => f.text);
    if (word.length && !r.already) {
      wordCeremony(word, { eyebrow: 'La Soglia si apre', title: 'La Parola', done: () => exitVictory(r) });
      return;
    }
    exitVictory(r);
    return;
  }
  vibrate([600, 200, 600]);
  beep();
  el = r.reason === 'alliance'
    ? battleOverlay('defeat',
      h('div', { class: 'eyebrow' }, 'La Soglia'),
      h('h2', { class: 'battle-title' }, 'Uscita negata'),
      h('p', null, `Siete ancora alleati${r.allies?.length ? ` con ${r.allies.map((n) => `il Settore ${n}`).join(', ')}` : ''}: alla Soglia non si presenta un'alleanza.`),
      h('p', { class: 'muted' }, 'Rompete l\'alleanza e riprovate. Il Consiglio è stato avvisato.'),
      h('a', { class: 'btn btn-primary btn-block', href: '#/alleanze', onclick: close }, 'Vai alle alleanze'),
      h('button', { class: 'btn btn-block', type: 'button', onclick: close }, 'Chiudi'))
    : battleOverlay('defeat',
      h('div', { class: 'eyebrow' }, 'La Soglia'),
      h('h2', { class: 'battle-title' }, 'Uscita negata'),
      h('p', null, `Non è possibile esfiltrare: mancano ${r.missing === 1 ? '1 frammento' : `${r.missing} frammenti`} della Parola${r.total ? ` (${r.total - r.missing} / ${r.total})` : ''}.`),
      h('p', { class: 'muted' }, 'Tornate agli Altari e completate la Parola.'),
      h('a', { class: 'btn btn-primary btn-block', href: '#/frammenti', onclick: close }, 'Vai alla Parola'),
      h('button', { class: 'btn btn-block', type: 'button', onclick: close }, 'Chiudi'));
}

// Indicazioni campo: mappa con i punti utili (parcheggio, accettazione…) e «Naviga» per aprirli in Google Maps.
const guideMapView = createMapView({ className: 'team-map guide-map' });
const navUrl = (g) => `https://www.google.com/maps/dir/?api=1&destination=${g.lat},${g.lng}`;
const guideItem = (g) => ({ key: `gd${g.id}`, kind: 'guide', icon: g.icon, lat: g.lat, lng: g.lng, title: g.label,
  popup: `<strong>${escHtml(g.label)}</strong>${g.description ? `<br>${escHtml(g.description)}` : ''}<br><a class="btn btn-sm btn-blue" href="${navUrl(g)}" target="_blank" rel="noopener">${mdiSvg('navigation', 16)} Naviga</a>` });
function viewGuide() {
  const list = S.state?.guide || [];
  guideMapView.setItems(list.map(guideItem));
  if (myPos) guideMapView.setMe(myPos);
  guideMapView.refresh();
  return h('div', { class: 'stack' },
    h('h2', null, 'Indicazioni campo'),
    list.length ? null : h('p', { class: 'empty' }, 'Nessuna indicazione: il Consiglio non ne ha ancora segnate, oppure la partita è già al Cerchio.'),
    list.length ? h('div', { class: 'map-wrap guide-wrap' }, guideMapView.el) : null,
    h('ul', { class: 'guide-list' }, list.map((g) => h('li', { class: 'card guide-card' },
      h('button', { class: 'guide-ico', type: 'button', title: 'Mostra sulla mappa', onclick: () => guideMapView.focus([`gd${g.id}`]) }, mdi(g.icon, 26)),
      h('div', { class: 'grow' }, h('strong', null, g.label), g.description ? h('div', { class: 'small muted' }, g.description) : null),
      h('a', { class: 'btn btn-blue', href: navUrl(g), target: '_blank', rel: 'noopener' }, mdi('navigation', 18), ' Naviga')))));
}

function viewMap(focus = null) {
  const m = S.state?.map || { points: [], gifts: [] };
  teamMapView.setItems([
    ...(m.landmarks || []).map((l) => landmarkItem(l)),
    ...(m.guide || []).map(guideItem),
    ...m.points.map((p) => ({ key: `p${p.id}`, kind: 'altar', lat: p.lat, lng: p.lng, text: p.roman, mine: p.mine, title: p.label, popup: `<strong>${p.label}</strong>${p.mine ? '<br>Il vostro Altare' : ''}` })),
    ...(S.state?.skills?.sightings || []).filter((x) => x.radius == null).map((x) => ({ key: `s${x.key}`, kind: x.kind || 'team', lat: x.lat, lng: x.lng, color: x.color, text: x.kind === 'elect' ? null : x.roman, title: `${x.roman} · Settore ${x.sectorName}`, popup: x.kind === 'elect' ? `<strong>Squadra ${escHtml(x.sectorName)}</strong><br>${escHtml(x.displayName || 'Eletto')} · ${escHtml(x.source)}` : `<strong>${escHtml(x.roman)} · Settore ${escHtml(x.sectorName)}</strong>${x.displayName ? `<br>${escHtml(x.displayName)}` : ''}<br><small>${escHtml(x.source)} · posizione delle ${fmtTime(x.at)}</small>` })),
    ...m.gifts.map((g) => ({ key: `g${g.id}`, kind: 'gift', lat: g.lat, lng: g.lng, text: '✦', color: '#d1ad62', state: 'revealed', title: 'Dono del Consiglio', popup: '<strong>Dono del Consiglio</strong><br>Chi arriva primo lo prende: scansionatelo con l\'app.' })),
  ]);
  // Intorno a ogni Altare la linea di copertura: la lettura del QR vale entro questo raggio (30 m se non scelto).
  const cover = S.state?.game?.altarRadiusM || 30;
  teamMapView.setCircles([
    ...m.points.filter((p) => p.lat != null).map((p) => ({ key: `c${p.id}`, lat: p.lat, lng: p.lng, radius: cover, color: '#d1ad62', fill: 0.06, weight: 1.5, dash: '5 6', interactive: false })),
    ...(S.state?.skills?.sightings || []).filter((x) => x.radius != null).map((x) => ({ key: `s${x.key}`, lat: x.lat, lng: x.lng, radius: x.radius, color: x.color || '#ff4fa3', title: `${x.roman} ${x.sectorName} · ${x.source} (area di 100 m)` })),
    ...(S.state?.skills?.giftHints || []).map((x) => ({ key: `h${x.id}`, lat: x.lat, lng: x.lng, radius: x.radius, color: '#d1ad62', title: 'Presagio del Dono: il dono è qui dentro' })),
  ]);
  if (myPos) teamMapView.setMe(myPos);
  teamMapView.refresh();
  // Dalla Parola intera: la mappa si apre sulla Soglia (e su di voi, se il GPS c'è).
  const soglia = focus === 'soglia' ? (m.landmarks || []).find((l) => l.kind === 'soglia' && l.lat != null) : null;
  if (soglia && S.focusedSoglia !== location.hash) { S.focusedSoglia = location.hash; setTimeout(() => teamMapView.focus([`l${soglia.id}`]), 120); }
  if (focus !== 'soglia') S.focusedSoglia = null;
  // Dalla scheda del Presagio: la mappa si centra sul cerchio del dono.
  const hints = S.state?.skills?.giftHints || [];
  if (focus === 'presagio' && hints.length && S.focusedHint !== location.hash) { S.focusedHint = location.hash; setTimeout(() => teamMapView.focus(hints.map((x) => `h${x.id}`)), 120); }
  if (focus !== 'presagio') S.focusedHint = null;
  // La mappa prende quasi tutto lo schermo: niente titolo, legenda né note (il cerchio blu dice già dove siete).
  return h('div', { class: 'stack map-page' },
    sightingsNote(),
    canExit() ? h('button', { class: 'btn btn-primary btn-xl btn-exit', type: 'button', onclick: scanExit }, '⌖ Leggi il codice di uscita') : null,
    focus === 'soglia' ? h('p', { class: 'note' }, soglia ? 'La Soglia è il segnaposto ⛩. Portateci la Parola intera e, senza alleati, leggete il codice di uscita appeso lì.' : 'La Soglia non è ancora sulla mappa: chiedete al Consiglio dove si trova.') : null,
    h('p', { class: 'mono small bad-text', id: 'map-gps', hidden: !!myPos || !gpsMsg }, myPos ? '' : gpsMsg || ''),
    h('div', { class: 'map-wrap' },
      teamMapView.el,
      h('div', { class: 'map-tools' },
        // In orizzontale restano solo le icone, in colonna sotto lo zoom.
        h('button', { class: 'btn btn-sm', title: 'Dove siamo', 'aria-label': 'Dove siamo', onclick: () => teamMapView.centerMe() }, h('span', { class: 'mt-ico', 'aria-hidden': 'true' }, '◎'), h('span', { class: 'mt-label' }, 'Dove siamo')),
        h('button', { class: 'btn btn-sm', title: 'Tutto il campo', 'aria-label': 'Tutto il campo', onclick: () => teamMapView.autoCenter() }, h('span', { class: 'mt-ico', 'aria-hidden': 'true' }, '⛶'), h('span', { class: 'mt-label' }, 'Tutto il campo')),
        h('a', { class: 'btn btn-sm', href: '/api/team/map.kmz', download: '', title: 'Scarica KMZ: i punti della vostra mappa per ATAK o Google Earth', 'aria-label': 'Scarica KMZ' }, h('span', { class: 'mt-ico', 'aria-hidden': 'true' }, '⇩'), h('span', { class: 'mt-label' }, 'KMZ')))));
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
  const v = route().query?.get?.('v') || S.fieldTab;
  const which = ['doni', 'punti'].includes(v) ? v : 'altari';
  const placedA = d ? d.points.filter((p) => p.lat != null).length : 0;
  const placedG = d ? d.gifts.filter((g) => g.status !== 'draft').length : 0;
  const seg = (id, label) => h('button', { type: 'button', class: which === id ? 'on' : '', onclick: () => { S.fieldTab = id; render(); } }, label);
  return h('div', { class: 'stack campo' },
    h('h2', null, 'Piazza Altari e Doni'),
    electFieldHead(),
    h('nav', { class: 'seg-tabs' }, seg('altari', `Altari ${placedA}/${d?.points.length ?? '…'}`), seg('doni', `Doni ${placedG}/${d?.gifts.length ?? '…'}`), seg('punti', `Punti ${d?.pois?.length ?? '…'}`)),
    which === 'doni' ? field.viewGifts() : which === 'punti' ? field.viewPois() : field.viewAltars());
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
// Dono già preso su questo telefono e inquadrato di nuovo: non si riprende, risulta scaduto.
function giftRescan(token) {
  if (S.giftResults?.[token]?.ok) S.giftResults[token] = { ok: false, message: 'Dono scaduto: l\'avete già preso. Lo trovate tra i vostri doni.' };
}

function viewGift(token) {
  const res = S.giftResults[token];
  const owned = (S.state?.gifts || []).find((g) => res?.gift && g.id === res.gift.id);
  const pending = S.queue.find((q) => q.kind === 'claim' && q.payload.token === token);
  const claim = async () => {
    claimRequested.add(token);
    // Errore del server (dono scaduto, già preso, non ancora comparso…): si mostra qui, non resta «sta verificando».
    if (!navigator.onLine) await enqueue('claim', { token }, 'Dono da prendere');
    else {
      try {
        const r = await sendItem({ kind: 'claim', payload: { token } });
        handleResult({ kind: 'claim', payload: { token } }, r, false);
        refresh();
      } catch (e) {
        if (e.offline) await enqueue('claim', { token }, 'Dono da prendere');
        else S.giftResults[token] = { ok: false, message: e.message || 'Dono non disponibile' };
      }
    }
    render();
  };
  if (!res && !pending && !claimRequested.has(token)) setTimeout(claim);
  const g = owned || res?.gift;
  return h('div', { class: 'stack' },
    h('h2', null, 'Dono del Consiglio'),
    g ? [giftCard(g, true), h('p', { class: 'muted small' }, 'Il dono è vostro: lo trovate in «I vostri doni». Mostratelo quando lo usate.'), h('a', { class: 'btn btn-primary btn-block', href: '#/doni' }, 'I vostri doni')]
      : pending ? h('div', { class: 'banner banner-queue' }, h('strong', null, 'In attesa di rete'), h('span', null, 'Il dono verrà preso appena torna il segnale (se nessuno arriva prima).'))
        : res && !res.ok && /^Dono scaduto/.test(res.message || '') ? [
          // Un dono letto non si riprende: chi lo rilegge lo trova scaduto.
          h('div', { class: 'gift-expired' }, h('div', { class: 'eyebrow' }, 'Dono del Consiglio'), h('strong', null, 'Dono scaduto'), h('p', null, res.message.replace(/^Dono scaduto: ?/, ''))),
          h('a', { class: 'btn btn-block', href: '#/doni' }, 'I vostri doni')]
        : res && !res.ok ? [h('div', { class: 'result result-bad' }, res.message || 'Dono non disponibile'), h('button', { class: 'btn btn-block', onclick: () => { delete S.giftResults[token]; claimRequested.delete(token); claim(); } }, 'Riprova')]
          : h('p', { class: 'empty' }, 'Il Consiglio sta verificando il dono…'));
}

function viewMyGifts() {
  const list = S.state?.gifts || [];
  return h('div', { class: 'stack' },
    h('h2', null, 'I vostri doni'),
    h('p', { class: 'muted small' }, 'Doni presi scansionando i loro QR nel bosco (o ricevuti con una Skill). Ognuno si usa una volta sola: l\'effetto parte appena lo usate.'),
    list.length ? list.map((g) => h('div', { class: 'stack-sm' }, giftCard(g),
      g.usedAt ? h('p', { class: 'muted small' }, `Usato alle ${fmtTime(g.usedAt)}`) : giftType(g) ? h('div', { class: 'row' },
        h('button', { class: 'btn btn-primary', disabled: !ACTIVE.includes(S.state?.clock.status), onclick: () => useGiftFlow(g) }, 'Usa il dono')) : h('div', { class: 'row' },
        h('button', { class: 'btn btn-primary', onclick: () => showGift(g) }, 'Mostra'),
        h('button', { class: 'btn', onclick: async () => {
          if (!(await dialog({ title: `Usare ${g.name}?`, text: 'Il dono verrà segnato come usato.', okLabel: 'Usato' }))) return;
          try { await api('POST', `/api/team/gift/${g.id}/use`); toast('Dono segnato come usato', 'ok'); refresh(); } catch (e) { toast(e.message, 'error'); }
        } }, 'Segna come usato'))))
      : h('p', { class: 'empty' }, 'Nessun dono, per ora. Guardate la mappa: quando ne compare uno, correte.'));
}

// ---------------------------------------------------------------- Skill e Doni con effetto

const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SKILL_KIND = { active: 'Attiva', ultimate: 'Ultimate', passive: 'Passiva' };
const giftType = (g) => (S.state?.skills?.giftCatalog || []).find((t) => t.id === g.typeId && t.available);

// Skill della coppia pronta all'uso (posseduta e non in ricarica).
const skillReady = (id) => !!(S.state?.skills?.mine || []).find((s) => s.id === id && !s.readyAt);

// Pulsante da tenere premuto (Skill degli scontri): la barra si riempie in 1,2 secondi, poi parte l'azione.
function holdButton(label, onDone, disabled = false) {
  let timer = null;
  const bar = h('span', { class: 'hold-bar' });
  const stop = () => { clearTimeout(timer); timer = null; btn.classList.remove('holding'); };
  const btn = h('button', { type: 'button', class: 'btn btn-hold', disabled,
    onpointerdown: (ev) => { ev.preventDefault(); btn.classList.add('holding'); vibrate(20); timer = setTimeout(() => { stop(); vibrate([60, 40, 60]); onDone(); }, 1200); },
    onpointerup: stop, onpointerleave: stop, onpointercancel: stop, oncontextmenu: (ev) => ev.preventDefault() }, bar, h('span', { class: 'hold-label' }, label));
  return btn;
}

function skillBadge(st) {
  const sk = st.skills;
  if (!sk) return null;
  if (sk.canChoose) {
    const chosen = sk.mine.filter((s) => s.source === 'chosen');
    const missing = Math.max(0, sk.limits.active - chosen.filter((s) => s.kind !== 'passive').length) + Math.max(0, sk.limits.passive - chosen.filter((s) => s.kind === 'passive').length);
    return missing || null;
  }
  return sk.mine.filter((s) => s.kind !== 'passive' && !s.auto && !s.where && !s.readyAt && !s.active).length || null;
}

// Privilegio del Cuore: scheda luminosa (come il Tracker) al posto della finestra degli armamenti,
// con la barra dei 5 minuti in cui siete i primi a entrare o gli ultimi a restare.
function privilegeCard(st) {
  const sp = st.skills?.supply;
  if (!sp) return null;
  const card = (cls, tag, title, sub, from, to) => h('a', { class: `track-card heart ${cls}`, href: '#/annunci' },
    h('span', { class: 'track-ico', 'aria-hidden': 'true' }, '❤️'),
    h('span', { class: 'track-body' },
      h('span', { class: 'eyebrow' }, `Privilegio del Cuore · ${tag}`),
      h('strong', null, title),
      h('span', { class: 'small' }, ...sub),
      h('div', { class: 'cd-bar fx', 'data-from': from, 'data-to': to, 'data-drain': '1' }, h('i'))),
    h('span', { class: 'track-go', 'aria-hidden': 'true' }, '›'));
  return [
    ...sp.early.map((x) => card('first', 'i primi', 'Entrate per primi: gli armamenti sono già aperti per voi',
      ['Per gli altri aprono tra ', h('span', { class: 'mono', 'data-abs': x.opensAt }, '—')], x.opensAt - 5 * 60000, x.opensAt)),
    ...sp.late.map((x) => card('last', 'gli ultimi', 'Siete gli ultimi: per voi gli armamenti sono ancora aperti',
      ['Chiusi per tutti gli altri · per voi ancora ', h('span', { class: 'mono', 'data-abs': x.until }, '—')], x.until - 5 * 60000, x.until)),
  ];
}

function sightingsNote() {
  const list = (S.state?.skills?.sightings || []).filter((x) => x.kind !== 'elect');
  const hints = S.state?.skills?.giftHints || [];
  const dirty = S.state?.skills?.dirty;
  if (!list.length && !hints.length && !dirty) return null;
  const n = new Set(list.map((x) => x.teamId)).size;
  const until = Math.max(0, ...list.map((x) => x.until || 0));
  return h('div', { class: 'note' },
    list.length ? h('div', null, `Vedete ${n === 1 ? '1 coppia' : `${n} coppie`} (${[...new Set(list.map((x) => x.source))].join(', ')})`, until ? [' ancora ', h('span', { class: 'mono', 'data-abs': until }, '—')] : null) : null,
    hints.length ? h('div', null, 'Presagio del Dono: il cerchio dorato contiene un dono appena comparso.') : null,
    dirty ? dirtyLine(dirty) : null);
}

// Custode: Sigillo protetto da un'altra coppia. Riquadro grande e colorato con il perché e il conto alla rovescia.
function guardedBox(sectorName, until, compact = false) {
  return h('div', { class: `guarded-box ${compact ? 'compact' : ''}` },
    h('div', { class: 'guarded-head' }, h('span', { class: 'guarded-ico', 'aria-hidden': 'true' }, '🛡️'), h('strong', null, `Sigillo custodito${sectorName ? ` · Settore ${sectorName}` : ''}`)),
    h('div', { class: 'guarded-time' }, 'Ancora ', h('span', { class: 'mono', 'data-abs': until }, '—'), ` (fino alle ${fmtTime(until)})`),
    h('p', { class: 'small' }, 'Un\'altra coppia ha protetto questo Sigillo con la Skill Custode: finché dura non potete leggerlo né usarlo per aprire il suo Altare. Tornate quando la protezione finisce.'));
}

// Segugio: avviso a tutto schermo (una volta per conquista) e scheda grande in home per 30 minuti.
const seenHounds = new Set(store.get('zdg_seen_hounds2', []));
const houndKey = (x) => `${x.id}@${x.at}`;
function showHound(x) {
  if (seenHounds.has(houndKey(x))) return;
  // Non copre una Vittoria o una Sconfitta ancora aperta: aspetta che venga chiusa.
  if (document.querySelector('.battle-overlay:not(.hound)')) { setTimeout(() => showHound(x), 2000); return; }
  seenHounds.add(houndKey(x));
  store.set('zdg_seen_hounds2', [...seenHounds].slice(-50));
  vibrate([200, 80, 200, 80, 400]);
  beep();
  const el = battleOverlay('hound',
    h('div', { class: 'hound-ico', 'aria-hidden': 'true' }, '🦅'),
    h('div', { class: 'eyebrow' }, 'Segugio'),
    h('h2', { class: 'battle-title' }, `${x.roman ? `${x.roman} · ` : ''}Settore ${x.sectorName}`),
    h('p', null, `Ha appena conquistato ${x.point}${x.at ? ` alle ${fmtTime(x.at)}` : ''}.`),
    h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => el.remove() }, 'Ricevuto'));
}
function houndCards(st) {
  const sk = st.skills;
  if (!sk) return null;
  // Arrivata mentre l'app era chiusa: l'avviso grande compare alla prima apertura.
  for (const x of sk.hounds || []) if (!seenHounds.has(houndKey(x))) setTimeout(() => showHound(x), 400);
  return [
    ...(sk.hounds || []).map((x) => h('a', { class: 'hound-card', href: '#/skill' },
      h('span', { class: 'hound-ico', 'aria-hidden': 'true' }, '🦅'),
      h('span', null, h('span', { class: 'eyebrow' }, `Segugio · ${fmtTime(x.at)}`), h('strong', null, `${x.roman ? `${x.roman} ` : ''}${x.sectorName} ha conquistato ${x.point}`)))),
    ...(sk.houndWatching || []).map((n) => h('a', { class: 'hound-card watching', href: '#/skill' },
      h('span', { class: 'hound-ico', 'aria-hidden': 'true' }, '🦅'),
      h('span', null, h('span', { class: 'eyebrow' }, 'Segugio in ascolto'), h('strong', null, `Settore ${n}: vi avvisiamo alla prossima conquista`)))),
  ];
}

// Presagio del Dono: un dono è comparso e lo sapete per primi. La barra si esaurisce quando lo vedono anche gli altri.
function presageCards(st) {
  return (st.skills?.giftHints || []).map((x) => h('a', { class: 'track-card presage', href: '#/mappa/presagio' },
    h('span', { class: 'track-ico', 'aria-hidden': 'true' }, '✨'),
    h('span', { class: 'track-body' },
      h('span', { class: 'eyebrow' }, 'Presagio del Dono · lo sapete per primi'),
      h('strong', null, 'Un Dono è appena comparso: guardate il cerchio sulla mappa'),
      h('span', { class: 'small' }, 'Gli altri lo vedranno tra ', h('span', { class: 'mono', 'data-abs': x.until }, '—')),
      h('div', { class: 'cd-bar fx', 'data-from': x.until - 5 * 60000, 'data-to': x.until, 'data-drain': '1' }, h('i'))),
    h('span', { class: 'track-go', 'aria-hidden': 'true' }, '›')));
}

// Tracker e Tracciamento lanciati da voi: chi state seguendo, quanto manca, e un tocco porta alla mappa.
function trackingCards(st) {
  return (st.skills?.effects || []).filter((e) => ['tracker', 'tracciamento'].includes(e.code) && e.targetName && e.until)
    .map((e) => h('a', { class: 'track-card', href: '#/mappa' },
      h('span', { class: 'track-ico', 'aria-hidden': 'true' }, e.code === 'tracker' ? '⚡' : '📍'),
      h('span', { class: 'track-body' },
        h('span', { class: 'eyebrow' }, `${e.name || 'Tracker'} · ancora `, h('span', { class: 'mono', 'data-abs': e.until }, '—')),
        h('strong', null, `Stai tracciando ${e.targetRoman ? `${e.targetRoman} ` : ''}${e.targetName}`),
        e.from ? h('div', { class: 'cd-bar fx', 'data-from': e.from, 'data-to': e.until, 'data-drain': '1' }, h('i')) : null),
      h('span', { class: 'track-go', 'aria-hidden': 'true' }, '›')));
}

// Alleanze sporche: la squadra di Eletti in arrivo, poi alleata per 30 minuti.
function dirtyLine(d) {
  if (!d.squadName) return h('div', null, '🤝 Alleanze sporche: il Consiglio sta scegliendo la squadra di Eletti.');
  if (!d.startedAt) return h('div', null, `🤝 La squadra ${d.squadName} vi raggiunge (pallini sulla mappa): l'alleanza parte quando siete vicini.`);
  return h('div', null, `🤝 Alleati con la squadra ${d.squadName} ancora `, h('span', { class: 'mono', 'data-abs': d.endsAt }, '—'));
}

function skillMeta(s) {
  return [s.cooldownMin ? `ricarica ${s.cooldownMin}′` : null, s.durationMin ? `effetto ${s.durationMin}′` : null, s.auto ? 'automatica' : null].filter(Boolean).join(' · ');
}

function skillCard(s, ...actions) {
  const acts = actions.filter(Boolean);
  return h('div', { class: `skill-card skill-${s.kind} ${s.available === false ? 'is-soon' : ''}` },
    h('div', { class: 'skill-ico', 'aria-hidden': 'true' }, s.icon),
    h('div', { class: 'skill-body' },
      h('div', { class: 'skill-head' }, h('strong', null, s.name), h('span', { class: 'chip' }, SKILL_KIND[s.kind]), s.available === false ? h('span', { class: 'chip chip-warn' }, 'in arrivo') : null),
      h('p', { class: 'small' }, s.description),
      skillMeta(s) ? h('div', { class: 'tiny muted mono' }, skillMeta(s)) : null,
      acts.length ? h('div', { class: 'row-actions' }, ...acts) : null));
}

// Cosa sono i tre tipi di Skill (spiegato ai concorrenti). Ricarica delle Ultimate dal catalogo della partita.
function kindInfo(kind, catalog = []) {
  const cds = [...new Set(catalog.filter((s) => s.kind === 'ultimate' && s.cooldownMin).map((s) => s.cooldownMin))];
  const ult = cds.length === 1 ? ` (${cds[0]} minuti)` : '';
  return {
    active: 'Le usate voi, quando volete, con il pulsante «Usa». Dopo l\'uso vanno in ricarica e tornano pronte dopo qualche minuto.',
    ultimate: `Skill attive più forti: cambiano la partita, ma dopo l'uso ci mettono molto più tempo a ricaricarsi${ult}. Sceglietele con cura e usatele al momento giusto.`,
    passive: 'Non si usano: sono sempre attive e lavorano da sole per tutta la partita.',
  }[kind];
}
const KIND_TITLE = { active: 'Skill attive', ultimate: 'Skill Ultimate', passive: 'Skill passive' };

function viewSkills() {
  const st = S.state;
  const sk = st?.skills;
  if (!sk) return h('p', { class: 'empty' }, 'Caricamento…');
  const mineIds = new Set(sk.mine.map((s) => s.id));
  if (sk.canChoose) {
    const chosen = sk.mine.filter((s) => s.source === 'chosen');
    const nAct = chosen.filter((s) => s.kind !== 'passive').length;
    const nPas = chosen.filter((s) => s.kind === 'passive').length;
    const toggle = async (s, on) => {
      try { await api('POST', `/api/team/skill/${s.id}/choose`, { on }); refresh(); } catch (e) { toast(e.offline ? 'Serve la rete per scegliere le Skill' : e.message, 'error', 6000); }
    };
    const group = (title, list, full, kind) => [h('h3', null, title), h('p', { class: 'small muted kind-info' }, kindInfo(kind, sk.catalog)), ...list.map((s) => skillCard(s,
      mineIds.has(s.id) ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => toggle(s, false) }, '✓ Scelta · togli')
        : h('button', { class: 'btn btn-sm', disabled: !s.available || full, onclick: () => toggle(s, true) }, 'Scegli')))];
    const many = (n, one, more) => (n === 1 ? one : `${n} ${more}`);
    return h('div', { class: 'stack' },
      h('h2', null, 'Le vostre Skill'),
      h('p', { class: 'muted' }, `Scegliete insieme ${many(sk.limits.active, '1 Skill attiva o Ultimate', 'Skill attive o Ultimate')} e ${many(sk.limits.passive, '1 Skill passiva', 'Skill passive')}. I telefoni della coppia vedono e cambiano la stessa scelta, fino al via. Altre Skill si vincono con i Doni.`),
      h('div', { class: 'skill-count' },
        h('span', { class: `chip ${nAct >= sk.limits.active ? 'chip-ok' : 'chip-brass'}` }, `Attive/Ultimate ${nAct}/${sk.limits.active}`),
        h('span', { class: `chip ${nPas >= sk.limits.passive ? 'chip-ok' : 'chip-brass'}` }, `Passive ${nPas}/${sk.limits.passive}`)),
      group('Skill attive', sk.catalog.filter((s) => s.kind === 'active'), nAct >= sk.limits.active, 'active'),
      group('Skill Ultimate', sk.catalog.filter((s) => s.kind === 'ultimate'), nAct >= sk.limits.active, 'ultimate'),
      group('Skill passive · sempre attive', sk.catalog.filter((s) => s.kind === 'passive'), nPas >= sk.limits.passive, 'passive'));
  }
  const playing = ACTIVE.includes(st.clock.status) && st.team.status === 'active';
  const left = (until) => h('span', { class: 'mono', 'data-abs': until }, '—');
  // Barra della ricarica (si riempie fino a «pronta») e dell'effetto in corso (si svuota fino alla fine).
  const cdBar = (s) => (s.readyAt ? h('div', { class: 'cd-bar', title: 'Ricarica', 'data-from': s.readyAt - s.cooldownMin * 60000, 'data-to': s.readyAt }, h('i')) : null);
  const fxBar = (s) => (s.active && s.activeUntil && s.durationMin ? h('div', { class: 'cd-bar fx', title: 'Effetto in corso', 'data-from': s.activeUntil - s.durationMin * 60000, 'data-to': s.activeUntil, 'data-drain': '1' }, h('i')) : null);
  const card = (s) => {
    if (s.kind === 'passive') return skillCard(s, h('span', { class: 'chip chip-ok' }, 'Sempre attiva'));
    if (s.auto) return skillCard(s, fxBar(s), cdBar(s), s.active ? h('span', { class: 'chip chip-blood' }, 'Attiva · ', left(s.activeUntil)) : s.readyAt ? h('span', { class: 'chip' }, 'Ricarica ', left(s.readyAt)) : h('span', { class: 'chip chip-ok' }, 'Pronta: si attiva da sola'));
    if (s.where) return skillCard(s, cdBar(s), s.readyAt ? h('span', { class: 'chip' }, 'Ricarica ', left(s.readyAt)) : h('a', { class: 'btn btn-sm', href: `#/${s.where}` }, `Pronta: si usa da ${s.where === 'alleanze' ? 'Alleanze' : 'Scontri'}`));
    return skillCard(s, fxBar(s), cdBar(s),
      s.active && s.activeUntil ? h('span', { class: 'chip chip-blood' }, `In corso${s.targetName ? ` su ${s.targetName}` : ''} · `, left(s.activeUntil)) : null,
      s.active && !s.activeUntil && s.targetName ? h('span', { class: 'chip chip-blood' }, `In ascolto su ${s.targetName}`) : null,
      s.readyAt ? h('span', { class: 'chip' }, 'Ricarica ', left(s.readyAt))
        : h('button', { class: 'btn btn-sm btn-primary', disabled: !playing || s.available === false, onclick: () => useSkillFlow(s) }, `Usa ${s.name}`));
  };
  const timed = sk.effects.filter((e) => e.until);
  const others = sk.catalog.filter((s) => !mineIds.has(s.id));
  return h('div', { class: 'stack' },
    h('h2', null, 'Le vostre Skill'),
    timed.length || sk.dirty ? h('div', { class: 'note' }, timed.map((e) => h('div', null, `${e.name}${e.targetName ? ` · ${e.targetName}` : ''}: ancora `, left(e.until))), sk.dirty ? dirtyLine(sk.dirty) : null) : null,
    sk.mine.length ? ['active', 'ultimate', 'passive'].map((kind) => {
      const list = sk.mine.filter((s) => s.kind === kind);
      return list.length ? [h('h3', null, KIND_TITLE[kind]), h('p', { class: 'small muted kind-info' }, kindInfo(kind, sk.catalog)), ...list.map(card)] : null;
    }) : h('p', { class: 'empty' }, 'Nessuna Skill: si scelgono prima del via o si vincono con i Doni.'),
    sk.results.length ? [h('h3', null, 'Ultimi risultati'), ...sk.results.map(resultCard)] : null,
    others.length ? h('details', { class: 'card' }, h('summary', null, 'Tutte le altre Skill'), h('div', { class: 'stack-sm' }, others.map((s) => skillCard(s)))) : null);
}

function resultCard(r) {
  if (r.code === 'segugio') return h('div', { class: 'card small' }, `🦅 Segugio · ${r.targetName}: ${r.data.point ? `ha conquistato ${r.data.point} alle ${fmtTime(r.at)}` : 'in ascolto'}`);
  if (r.code === 'intercettazione') return h('div', { class: 'card stack-sm' }, h('strong', null, `📡 Intercettazione · ${r.targetName} (${fmtTime(r.at)})`), sealTypes(r.data.sectors));
  if (r.code === 'dossier') return h('div', { class: 'card stack-sm' }, h('strong', null, `🕵️ Dossier · ${r.targetName} (${fmtTime(r.at)})`), sealCodes(r.data.codes));
  return null;
}

// Intercettazione: solo il tipo (Settore) dei Sigilli, il codice resta sfocato. Dossier e furti: il codice vero.
const sealTypes = (list) => (list.length
  ? h('div', { class: 'battle-seals' }, list.map((x) => h('div', { class: 'battle-seal' }, h('div', { class: 'eyebrow' }, `${x.roman} · Settore ${x.sectorName}`), h('div', { class: 'battle-code mono' }, ghost(`int-${x.sectorId}`, S.state.game.codeLength, 'ghost-strong')))))
  : h('p', { class: 'muted' }, 'Nessun Sigillo.'));
const sealCodes = (list) => (list.length
  ? h('div', { class: 'battle-seals' }, list.map((x) => h('div', { class: 'battle-seal' }, h('div', { class: 'eyebrow' }, `${x.roman} · Settore ${x.sectorName}`), h('div', { class: 'battle-code mono' }, x.code))))
  : h('p', { class: 'muted' }, 'Nessun Sigillo.'));

// Scelta da un elenco (coppia, Altare, Sigillo, Skill) in una finestra.
function pick(title, options, { text = null, okLabel = 'Conferma' } = {}) {
  if (!options.length) { toast('Niente da scegliere, per ora', 'error'); return Promise.resolve(null); }
  let val = null;
  const list = h('div', { class: 'pick-list' }, options.map((o) => h('label', { class: 'pick-item' },
    h('input', { type: 'radio', name: 'pick', onchange: () => { val = o.value; } }),
    h('span', { class: 'pick-text' }, h('strong', null, o.label), o.sub ? h('span', { class: 'tiny muted' }, o.sub) : null))));
  return modal({ title, body: h('div', { class: 'stack-sm' }, text ? h('p', { class: 'small muted' }, text) : null, list), okLabel,
    onOk: () => { if (val == null) { toast('Scegliete prima un\'opzione', 'error'); return false; } return { val }; } })
    .then((r) => (r && typeof r === 'object' ? r.val : null));
}

const teamOptions = () => (S.state?.combat?.teams || []).map((t) => ({ value: t.teamId, label: `${t.roman} · Settore ${t.sectorName}`, sub: t.allied ? 'alleati' : t.displayName || null }));
const ownedLabels = () => new Set((S.state?.fragments || []).filter((f) => f.text).map((f) => f.pointLabel));
// Altari di cui non avete ancora il frammento (Veggenza: solo quelli conosciuti, già inquadrati, che ne custodiscono uno).
const altarOptions = (known = false) => (S.state?.skills?.altars || S.state?.map?.points || [])
  .filter((p) => (p.owned ?? ownedLabels().has(p.label)) === false && (!known || (p.fragment && p.known)))
  .map((p) => ({ value: p.id, label: p.label, sub: `${p.roman} · Settore ${p.sectorName}` }));
// Altari inquadrati: scaduti (Memoria) o ancora validi (Chiave Maestra). In ordine di nome, non di Sigillo posseduto.
const visitedOptions = (expired) => (S.state?.visited || []).filter((v) => !v.unlocked && (expired ? v.expiresAt && v.expiresAt < clock.serverNow() : !v.expiresAt || v.expiresAt >= clock.serverNow()))
  .sort((a, b) => a.label.localeCompare(b.label)).map((v) => ({ value: v.pointId, label: v.label, sub: `Settore ${v.sectorName}` }));
const sealOptions = () => (S.state?.notebook || []).filter((n) => n.code).map((n) => ({ value: n.sectorId, label: `${n.roman} · Settore ${n.sectorName}`, sub: n.source === 'own' ? 'il vostro' : null }));
const skillOptions = (list) => list.map((s) => ({ value: s.id, label: `${s.icon} ${s.name}`, sub: `${SKILL_KIND[s.kind]} · ${s.description}` }));

async function askParams(target, name, text, id = null) {
  const sk = S.state.skills;
  const mine = new Set(sk.mine.map((s) => s.id));
  const one = async (key, title, options, note) => { const v = await pick(`${name}: ${title}`, options, { text: note }); return v == null ? null : { [key]: v }; };
  switch (target) {
    case 'team': return one('teamId', 'scegliete una coppia', teamOptions(), text);
    // Veggenza: solo gli Altari conosciuti (già inquadrati) con un frammento che non avete.
    case 'altar': return id === 'veggenza'
      ? one('pointId', 'scegliete un Altare che conoscete', altarOptions(true), 'Solo gli Altari che avete già inquadrato e di cui non avete il frammento.')
      : one('pointId', 'scegliete un Altare', altarOptions(), text);
    case 'expiredAltar': return one('pointId', 'Altare da riaprire', visitedOptions(true), 'Altari già inquadrati con la scansione scaduta.');
    case 'scannedAltar': return one('pointId', 'Altare da aprire', visitedOptions(false), 'Solo gli Altari appena inquadrati (scansione ancora valida).');
    case 'seal': return one('sectorId', 'Sigillo da proteggere', sealOptions(), text);
    case 'newSkill': return one('skillId', 'nuova Skill', skillOptions(sk.catalog.filter((s) => s.available && !mine.has(s.id))), text);
    case 'cooldownSkill': return one('skillId', 'Skill da ricaricare', skillOptions(sk.mine.filter((s) => s.readyAt)), text);
    case 'swap': {
      const from = await pick(`${name}: Skill da sostituire`, skillOptions(sk.mine));
      if (from == null) return null;
      const to = await pick(`${name}: nuova Skill`, skillOptions(sk.catalog.filter((s) => s.available && !mine.has(s.id))));
      return to == null ? null : { fromSkillId: from, skillId: to };
    }
    default:
      // Una scelta che questa versione dell'app non conosce: meglio aggiornare che mandare una richiesta vuota.
      if (target) { toast('Aggiornate l\'app (chiudetela e riapritela) per usare questa Skill', 'error', 8000); return null; }
      return (await dialog({ title: `Usare ${name}?`, text, okLabel: 'Usa' })) ? {} : null;
  }
}

async function useSkillFlow(s) {
  const params = await askParams(s.target, s.name, s.description, s.id);
  if (!params) return;
  try { showEffectResult(s.name, await api('POST', `/api/team/skill/${s.id}/use`, params)); } catch (e) { toast(e.offline ? 'Serve la rete per usare una Skill' : e.message, 'error', 7000); }
  refresh();
}

async function useGiftFlow(g) {
  const t = giftType(g);
  const params = await askParams(t.target, t.name, t.description);
  if (!params) return;
  try { showEffectResult(t.name, await api('POST', `/api/team/gift/${g.id}/use`, params)); } catch (e) { toast(e.offline ? 'Serve la rete per usare un dono' : e.message, 'error', 7000); }
  refresh();
}

function showEffectResult(name, r) {
  vibrate([60, 40, 60]);
  let el = null;
  const close = () => el?.remove();
  const head = (title) => [h('div', { class: 'eyebrow' }, name), h('h2', { class: 'battle-title' }, title)];
  if (r.intercept) el = battleOverlay('victory', ...head(r.intercept.sectorName), h('p', { class: 'muted' }, 'Conosce i Sigilli di questi Settori:'), sealTypes(r.intercept.sectors), h('button', { class: 'btn btn-block', onclick: close }, 'Chiudi'));
  else if (r.dossier) el = battleOverlay('victory', ...head(r.dossier.sectorName), h('p', { class: 'muted' }, 'I Sigilli che conosce:'), sealCodes(r.dossier.codes), h('p', { class: 'small muted' }, 'Annotateli nel taccuino se vi servono.'), h('button', { class: 'btn btn-block', onclick: close }, 'Chiudi'));
  else if (r.stolen) el = battleOverlay('victory', ...head(`Settore ${r.stolen.sectorName}`), sealCodes([r.stolen]), h('p', { class: 'small muted' }, 'Lo trovate nel taccuino dei Codici.'), h('a', { class: 'btn btn-primary btn-block', href: '#/codici', onclick: close }, 'Vai al taccuino'));
  else if (r.fragment) el = battleOverlay('victory', ...head(r.fragment.text), h('p', { class: 'muted' }, `Frammento di ${r.fragment.pointLabel}`), h('a', { class: 'btn btn-primary btn-block', href: '#/frammenti', onclick: close }, 'Vai alla Parola'));
  else if (r.gift) el = battleOverlay('victory', h('div', { class: 'eyebrow' }, name), giftCard({ ...r.gift, label: 'Nuovo dono' }, true), h('a', { class: 'btn btn-primary btn-block', href: '#/doni', onclick: close }, 'I vostri doni'));
  else if (r.message) toast(r.message, 'ok', 6000);
  if (r.qrToken) location.hash = `#/altare/${r.qrToken}`;
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
    hint: 'Inquadrate il QR di un Altare, di un Dono del Consiglio o il codice di uscita della Soglia.',
    accept: (t) => (/\/(a|d|u)\/[\w-]+/.test(t) ? true : /\/login\//.test(t) ? 'Questo è un QR di accesso, non un Altare' : 'Questo QR non è dei Giochi'),
  });
  if (!text) return;
  const gift = text.match(/\/d\/([\w-]+)/);
  if (gift) { giftRescan(gift[1]); location.hash = `#/dono/${gift[1]}`; return; }
  const exit = text.match(/\/u\/([\w-]+)/);
  if (exit) { tryExit(exit[1]); return; }
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

// Memoria (Skill attiva, pronta): riapre da qui l'Altare scaduto, senza tornare a inquadrarlo.
function memoryBtn(v, token) {
  const st = S.state;
  const mem = (st?.skills?.mine || []).find((s) => s.id === 'memoria');
  const pointId = v.pointId || (st?.visited || []).find((x) => x.qrToken === token)?.pointId;
  if (!mem || !pointId || !ACTIVE.includes(st.clock.status)) return null;
  if (mem.readyAt) return h('p', { class: 'small muted' }, '🧩 Memoria in ricarica: pronta tra ', h('span', { class: 'mono', 'data-abs': mem.readyAt }, '—'));
  return h('button', { class: 'btn btn-key btn-xl btn-block', type: 'button', onclick: async () => {
    if (!(await dialog({ title: 'Usare Memoria?', text: `Riaprite ${v.label || 'questo Altare'} senza tornare a inquadrarlo: potrete di nuovo pronunciarne il Sigillo. Memoria va in ricarica.`, okLabel: 'Usa Memoria' }))) return;
    try {
      const r = await api('POST', '/api/team/skill/memoria/use', { pointId });
      delete S.altarResults[token];
      await refresh();
      showEffectResult('Memoria', r);
    } catch (e) { toast(e.offline ? 'Serve la rete per usare una Skill' : e.message, 'error', 7000); refresh(); }
  } }, '🧩 Usa Memoria');
}

function viewAltar(token, query) {
  if (!token) return h('p', { class: 'empty' }, 'Altare non valido');
  const st = S.state;
  // Aperto da un link senza scansione registrata: la registra ora.
  if (checkingScan.has(token)) {
    return h('div', { class: 'stack' }, h('h2', null, 'Altare'), h('div', { class: 'card stack-sm' }, h('strong', null, '⌖ Verifico la posizione…'),
      h('p', { class: 'small muted' }, 'Il Consiglio controlla che siate davanti all\'Altare. Restate fermi qualche secondo con il GPS acceso.')));
  }
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
  // Sigillo protetto da Custode di un'altra coppia: l'Altare non si apre finché dura.
  const guardedUntil = (st?.visited || []).find((x) => x.qrToken === token)?.guardedUntil || (sectorId ? st?.notebook.find((n) => n.sectorId === sectorId)?.guardedUntil : null);
  const guarded = guardedUntil && guardedUntil > clock.serverNow() ? guardedUntil : null;

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
  else if (guarded) action = guardedBox(v.sectorName, guarded);
  else if (expired) {
    action = h('div', { class: 'scan-expired' },
      h('strong', null, 'Scansione scaduta'),
      h('p', null, `La scansione vale ${st?.game.altarScanMin || '?'} minuti${v.expiresAt ? ` ed è scaduta alle ${fmtTime(v.expiresAt)}` : ''}. Tornate all'Altare e inquadratelo di nuovo.`),
      h('button', { class: 'btn btn-primary btn-xl btn-block', onclick: openScanner }, '⌖ Riscansiona l\'Altare'),
      memoryBtn(v, token));
  } else if (known && !manualAltar.has(token) && !query.get('code')) {
    // Sigillo già nel taccuino: niente da scrivere, basta confermarlo.
    action = h('div', { class: 'known-seal' },
      h('div', { class: 'eyebrow' }, 'Dal vostro taccuino'),
      h('p', null, `Avete già il Sigillo del Settore ${known.sectorName} (${CODE_SOURCE[known.source] || 'nel taccuino'}):`),
      h('div', { class: 'known-code mono' }, known.code),
      h('button', { class: 'btn btn-primary btn-xl btn-block', onclick: () => unlockWith(known.code) }, 'Usa questo Sigillo'),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { manualAltar.add(token); render(); } }, 'Inserisci un altro Sigillo'));
  } else action = manualForm;
  // Chiave Maestra nei doni: si apre l'Altare appena inquadrato anche senza Sigillo.
  const key = (st?.gifts || []).find((g) => g.typeId === 'chiave' && !g.usedAt);
  const pointId = v.pointId || (st?.visited || []).find((x) => x.qrToken === token)?.pointId;
  const keyBtn = key && pointId && !fragment && !guarded && !expired && !closed ? h('button', { class: 'btn btn-key btn-xl btn-block', type: 'button', onclick: async () => {
    if (!(await dialog({ title: 'Usare la Chiave Maestra?', text: `Aprite ${v.label || 'questo Altare'} senza il Sigillo. La Chiave si consuma.`, okLabel: 'Usa la Chiave' }))) return;
    try { showEffectResult('Chiave Maestra', await api('POST', `/api/team/gift/${key.id}/use`, { pointId })); } catch (e) { toast(e.offline ? 'Serve la rete per usare un dono' : e.message, 'error', 7000); }
    refresh();
  } }, '🗝️ Usa Chiave Maestra') : null;

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
      : h('div', { class: 'fragment-reveal locked' }, h('div', { class: 'eyebrow' }, 'Frammento ancora sigillato'), h('div', { class: 'fragment-text' }, ghostWord(`altar:${token}`, 'ghost-strong'))),
    action,
    keyBtn,
    !fragment && closed ? h('p', { class: 'muted small' }, status === 'ended' ? 'I Giochi sono finiti: gli Altari sono chiusi.' : status === 'paused' ? 'Partita sospesa.' : 'Gli Altari si aprono al via.') : null,
    pending ? h('div', { class: 'banner banner-queue' }, h('strong', null, 'In attesa di rete'), h('span', null, `Sigillo «${pending.payload.code}» verrà inviato appena c'è segnale.`)) : null,
    last && !last.ok && !fragment && !last.expired && !guarded ? h('div', { class: 'result result-bad' }, last.message) : null,
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
    owned && owned === frs.length ? wonBanner() : null,
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
  const srcLabel = { own: 'vostro', revealed: 'rivelato', note: 'annotato ✓', won: 'vinto', alliance: 'alleato', stolen: 'rubato', archive: 'archivio' };
  return h('div', { class: 'stack' },
    h('h2', null, 'Taccuino dei Sigilli'),
    h('p', { class: 'muted' }, 'Il vostro, quelli traditi dal Consiglio e quelli che vi hanno mostrato. Toccate un Sigillo per aprire il suo Altare.'),
    h('ul', { class: 'notebook' }, nb.map((n) => {
      if (n.guardedUntil && n.guardedUntil > clock.serverNow()) {
        return h('li', null, h('div', { class: 'nb-row nb-guarded' },
          h('span', { class: 'nb-roman mono' }, n.roman),
          h('div', { class: 'nb-main' }, h('div', { class: 'nb-name' }, n.sectorName), guardedBox(null, n.guardedUntil, true))));
      }
      const go = n.code && n.visitedToken && !n.unlocked;
      const content = [
        h('span', { class: 'nb-roman mono' }, n.roman),
        h('div', { class: 'nb-main' },
          h('div', { class: 'nb-name' }, n.sectorName),
          n.free && !n.code ? h('div', { class: 'small muted' }, 'Altare senza coppia: il Sigillo arriva solo dal tradimento') : null,

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
const syncedTimers = new Set(store.get('zdg_synced_timers2', []));
// ---------------------------------------------------------------- esito degli scontri: vittoria e sconfitta

function battleOverlay(cls, ...children) {
  document.querySelector('.battle-overlay')?.remove();
  const el = h('div', { class: `battle-overlay ${cls}`, role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'battle-box' }, ...children));
  document.body.append(el);
  return el;
}

// I Sigilli ricevuti (vittoria o alleanza): sfocati, poi svelati uno dopo l'altro; quelli protetti restano sfocati col motivo.
function battleSeals(list, prefix) {
  return h('div', { class: 'battle-seals' }, list.map((n, i) => {
    if (!n.code) return h('div', { class: 'battle-seal' }, h('div', { class: 'eyebrow' }, `${n.roman} · Settore ${n.sectorName}`),
      h('div', { class: 'battle-code mono' }, ghost(`${prefix}-${n.sectorId}`, n.length || 6, 'ghost-strong')),
      h('p', { class: 'small bad-text' }, n.hiddenBy === 'Diplomatico'
        ? `Per via del Diplomatico il Sigillo del Settore ${n.sectorName} non vi verrà svelato.`
        : `Il Sigillo è rimasto nascosto grazie a ${n.hiddenBy}.`));
    const code = h('div', { class: 'battle-code mono' }, ghost(`${prefix}-${n.sectorId}`, n.code.length, 'ghost-strong'));
    setTimeout(() => { code.replaceChildren(h('span', { class: 'unveil' }, n.code)); vibrate(60); }, 1100 + i * 900);
    return h('div', { class: 'battle-seal' }, h('div', { class: 'eyebrow' }, `${n.roman} · Settore ${n.sectorName}`), code);
  }));
}

// Alleanza rotta (richiesta accettata, a distanza, Velenoso): la schermata come quella dell'alleanza stretta.
// Il motivo del blocco dice come: «Alleanza rotta (X) · ex alleati», «… per distanza (X) · …», «… dal Velenoso del Settore X · …».
function showBroken(timerUid, reason) {
  vibrate([300, 100, 300, 100, 600]);
  beep();
  const [head, allies] = String(reason || '').split(' · ');
  const poison = /dal Velenoso/.test(head);
  const far = /per distanza/.test(head);
  const who = poison ? head.replace('Alleanza rotta dal Velenoso del Settore ', '') : (/\(([^)]+)\)/.exec(head) || [])[1] || '';
  const me = S.state?.team.sector?.name;
  const why = poison ? ['Il Settore ', h('strong', null, who), ' ha usato ', h('strong', null, 'Velenoso'), ' e ha rotto la vostra alleanza.']
    : far ? [who === me ? 'Siete rimasti' : ['Il Settore ', h('strong', null, who), ' è rimasto'], ` per più di 5 minuti a più di 50 m dagli alleati: l'alleanza si è rotta.`]
    : who === me ? ['Avete lasciato l\'alleanza.'] : ['Il Settore ', h('strong', null, who), ' ha lasciato l\'alleanza.'];
  const el = battleOverlay(`alliance broken ${poison ? 'poisoned' : ''}`,
    h('div', { class: 'battle-burst', 'aria-hidden': 'true' }),
    h('div', { class: 'alliance-ico', 'aria-hidden': 'true' }, poison ? '☠️' : '⚑'),
    h('div', { class: 'eyebrow' }, poison ? 'Velenoso' : far ? 'Troppo lontani' : 'Fine dell\'alleanza'),
    h('h2', { class: 'battle-title' }, 'Alleanza rotta'),
    h('p', { class: 'poison-by' }, ...why),
    allies ? h('p', { class: 'muted' }, `Non siete più alleati con ${allies}.`) : null,
    h('p', { class: 'battle-note' }, 'Blocco ingaggio tra voi per'),
    h('div', { class: 'battle-count mono', 'data-timer': timerUid }, '—'),
    h('button', { class: 'btn btn-block', type: 'button', onclick: () => el.remove() }, 'Ho capito'));
  updateClocks();
}

// Chi usa Velenoso: conferma a tutto schermo dell'alleanza rotta.
function showPoisonCast(broken) {
  vibrate([120, 60, 120, 60, 400]);
  const el = battleOverlay('alliance poisoned',
    h('div', { class: 'battle-burst', 'aria-hidden': 'true' }),
    h('div', { class: 'alliance-ico', 'aria-hidden': 'true' }, '☠️'),
    h('div', { class: 'eyebrow' }, 'Velenoso'),
    h('h2', { class: 'battle-title' }, 'Alleanza rotta'),
    h('p', null, `Avete rotto l'alleanza di ${broken.join(', ')}. Sanno che è stato il vostro Settore.`),
    h('button', { class: 'btn btn-block', type: 'button', onclick: () => el.remove() }, 'Chiudi'));
}

function showAlliance(news) {
  vibrate([120, 60, 120, 60, 400]);
  beep();
  const shown = news.allies.filter((n) => n.code).length;
  const el = battleOverlay('alliance',
    h('div', { class: 'battle-burst', 'aria-hidden': 'true' }),
    h('div', { class: 'alliance-ico', 'aria-hidden': 'true' }, '⚑'),
    h('div', { class: 'eyebrow' }, 'Alleanza stretta'),
    h('h2', { class: 'battle-title' }, 'Alleati'),
    h('p', null, `Ora siete alleati con ${news.allies.map((n) => `${n.roman} ${n.sectorName}`).join(', ')}.`),
    h('p', { class: 'muted' }, shown ? (news.allies.length > 1 ? 'I Sigilli dei vostri alleati:' : 'Il Sigillo del vostro alleato:') : 'Nessun Sigillo vi viene svelato:'),
    battleSeals(news.allies, 'ally'),
    shown ? h('p', { class: 'small muted' }, 'Li trovate anche nel taccuino dei Codici.') : null,
    h('div', { class: 'row' },
      h('a', { class: 'btn btn-primary btn-block', href: shown ? '#/codici' : '#/alleanze', onclick: () => el.remove() }, shown ? 'Vai al taccuino' : 'Alleanze'),
      h('button', { class: 'btn btn-block', type: 'button', onclick: () => el.remove() }, 'Chiudi')));
}

function showVictory(won, against, maestria = false) {
  vibrate([120, 60, 120, 60, 400]);
  beep();
  const el = battleOverlay('victory',
    h('div', { class: 'battle-burst', 'aria-hidden': 'true' }),
    h('div', { class: 'eyebrow' }, maestria ? 'Maestria delle armi' : 'Scontro vinto'),
    h('h2', { class: 'battle-title' }, 'Vittoria'),
    against ? h('p', null, maestria ? `Avevate perso contro il Settore ${against.sectorName}: la Maestria delle armi ha ribaltato lo scontro.` : `Avete battuto il Settore ${against.sectorName}.`) : null,
    h('p', { class: 'muted' }, won.length > 1 ? 'Il Consiglio vi consegna i Sigilli della parte sconfitta:' : 'Il Consiglio vi consegna il Sigillo dello sconfitto:'),
    battleSeals(won, 'won'),
    h('p', { class: 'small muted' }, 'Lo trovate anche nel taccuino dei Codici.'),
    h('div', { class: 'row' },
      h('a', { class: 'btn btn-primary btn-block', href: '#/codici', onclick: () => el.remove() }, 'Vai al taccuino'),
      h('button', { class: 'btn btn-block', type: 'button', onclick: () => el.remove() }, 'Chiudi')));
}

// Vittoria senza Sigilli nuovi: si sceglie quale rubare tra quelli che la parte sconfitta conosce e voi no.
function showSteal(steal) {
  vibrate([120, 60, 120, 60, 400]);
  beep();
  const box = h('div', { class: 'battle-seals' });
  const actions = h('div', { class: 'row' });
  const close = () => el.remove();
  const choose = async (c, btn) => {
    box.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    btn.classList.add('on');
    try {
      const r = await api('POST', `/api/team/engagement/${steal.engagementId}/steal`, { sectorId: c.sectorId });
      const code = h('div', { class: 'battle-code mono' }, ghost(`steal-${r.sectorId}`, r.code.length, 'ghost-strong'));
      box.replaceChildren(h('div', { class: 'battle-seal' }, h('div', { class: 'eyebrow' }, `${r.roman} · Settore ${r.sectorName}`), code));
      intro.textContent = 'Sigillo rubato:';
      // Il simulacro sfocato si svela nel Sigillo vero, come negli ingaggi.
      setTimeout(() => { code.replaceChildren(h('span', { class: 'unveil' }, r.code)); vibrate(60); }, 1100);
      actions.replaceChildren(
        h('a', { class: 'btn btn-primary btn-block', href: '#/codici', onclick: close }, 'Vai al taccuino'),
        h('button', { class: 'btn btn-block', type: 'button', onclick: close }, 'Chiudi'));
      refresh();
    } catch (e) {
      toast(e.offline ? 'Serve la rete per rubare il Sigillo' : e.message, 'error', 7000);
      box.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      btn.classList.remove('on');
    }
  };
  box.append(h('div', { class: 'opp-grid' }, steal.candidates.map((c) => {
    const btn = h('button', { type: 'button', class: 'opp', onclick: () => choose(c, btn) }, h('strong', null, `${c.roman} ${c.sectorName}`));
    return btn;
  })));
  actions.append(h('button', { class: 'btn btn-block', type: 'button', onclick: close }, 'Scelgo dopo'));
  const intro = h('p', { class: 'muted' }, 'I loro Sigilli li conoscete già. Scegliete quale rubare dal taccuino della parte sconfitta:');
  const el = battleOverlay('victory',
    h('div', { class: 'battle-burst', 'aria-hidden': 'true' }),
    h('div', { class: 'eyebrow' }, 'Scontro vinto'),
    h('h2', { class: 'battle-title' }, 'Vittoria'),
    steal.against ? h('p', null, `Avete battuto il Settore ${steal.against.sectorName}.`) : null,
    intro, box,
    h('p', { class: 'small muted' }, 'Lo trovate anche nel taccuino dei Codici.'),
    actions);
}

function showDefeat(timerUid, reason) {
  vibrate([600, 200, 600]);
  beep();
  const left = h('div', { class: 'battle-count mono', 'data-timer': timerUid }, '—');
  const note = h('p', { class: 'battle-note' }, 'Tornate in battaglia tra');
  // «Sconfitta contro X ⚔ Maestria delle armi · Veglia 2 minuti + 2 minuti …»: chi, se con la Maestria, la durata in chiaro.
  const [head, extra] = String(reason || '').split(' · ');
  const mastery = head.includes('⚔ Maestria delle armi');
  const who = head.replace(' ⚔ Maestria delle armi', '');
  const foe = who.replace('Sconfitta contro ', '');
  const el = battleOverlay(`defeat ${mastery ? 'mastery' : ''}`,
    // Maestria delle armi dell'avversario: lo scontro che credevate vinto si è ribaltato. Deve saltare all'occhio.
    mastery ? h('div', { class: 'mastery-banner' },
      h('div', { class: 'mastery-swords', 'aria-hidden': 'true' }, h('span', null, '🗡️'), h('span', null, '🗡️')),
      h('div', { class: 'mastery-kicker' }, 'Scontro ribaltato'),
      h('div', { class: 'mastery-name' }, 'Maestria delle armi'),
      h('p', { class: 'mastery-text' }, 'Credevate di aver vinto, ma il Settore ', h('strong', null, foe), ' ha usato la ', h('strong', null, 'Maestria delle armi'), ': la vittoria è sua, i vostri Sigilli vanno a loro.')) : null,
    h('div', { class: 'eyebrow' }, 'Scontro perso'),
    h('h2', { class: 'battle-title' }, 'Sconfitta'),
    ...(() => {
      const t = S.timers.find((x) => x.uid === timerUid);
      return [
        h('p', { class: 'muted' }, `${who}${mastery ? ' (Maestria delle armi)' : ''}. Cappellino in testa: Veglia, poi rientrate in gioco.`),
        extra ? h('p', { class: 'battle-forced' }, `⛓️ ${extra}${t?.minutes ? ` — in tutto ${t.minutes} minuti` : ''}.`) : null,
      ];
    })(),
    note, left,
    h('button', { class: 'btn btn-block', type: 'button', onclick: () => { clearInterval(watch); el.remove(); } }, 'Ho capito'),
    h('a', { class: 'small', href: '#/timer', onclick: () => { clearInterval(watch); el.remove(); } }, 'Il timer resta nella pagina Timer'));
  updateClocks();
  const watch = setInterval(() => {
    if (!document.body.contains(el)) return clearInterval(watch);
    const t = S.timers.find((x) => x.uid === timerUid);
    if (!t || t.done || Date.now() >= t.endsAt) { note.textContent = 'La Veglia è finita'; left.textContent = 'Potete tornare in battaglia'; left.classList.add('battle-free'); left.removeAttribute('data-timer'); clearInterval(watch); }
  }, 500);
}

function syncServerTimers(st) {
  for (const t of st.serverTimers || []) {
    const key = `srv-${t.id}@${t.startedAt}`;
    if (syncedTimers.has(key)) continue;
    syncedTimers.add(key);
    const preset = (st.game.timers || []).find((x) => x.id === t.timerId);
    if (!preset) continue;
    const endsAt = t.startedAt + (t.minutes || preset.minutes) * 60000 - clock.offset;
    if (endsAt <= Date.now()) continue;
    S.timers.push({ uid: key, id: preset.id, label: preset.label, endText: preset.endText, endsAt, done: false, reason: t.reason, minutes: t.minutes || preset.minutes });
    if (t.timerId === 'veglia' && /^Sconfitta/.test(t.reason || '')) setTimeout(() => showDefeat(key, t.reason), 300);
    else if (t.timerId === 'blocco' && /^Alleanza rotta/.test(t.reason || '')) setTimeout(() => showBroken(key, t.reason), 300);
    else toast(`Timer ${preset.label} avviato: ${t.reason}`, 'blood', 7000);
  }
  store.set('zdg_synced_timers2', [...syncedTimers].slice(-200));
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
  // Timer arrivati a zero: avvisato, si cancellano da soli (sparisce anche la Veglia dalla barra in alto).
  if (changed) { S.timers = S.timers.filter((t) => !t.done); saveTimers(); render(); }
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


// ICE: pagina OFF GAME con i dati per i soccorritori (solo per chi è entrato con il proprio account).
const iceFilled = () => { const ice = S.state?.account?.ice; return !!ice && Object.values(ice).some(Boolean); };
function iceTile() {
  if (!S.state?.account) return null;
  const empty = !iceFilled();
  return h('a', { class: 'tile tile-ice', href: '#/ice' }, h('span', { class: 'tile-ico', 'aria-hidden': 'true' }, '✚'), h('span', null, 'ICE'),
    h('span', { class: 'tiny muted' }, 'In Case of Emergency'), empty ? h('span', { class: 'badge badge-alert' }, '!') : null);
}
// Gruppo sanguigno: scelta da elenco (un valore scritto a mano in passato resta tra le opzioni).
const BLOOD_GROUPS = ['0 Rh+', '0 Rh-', 'A Rh+', 'A Rh-', 'B Rh+', 'B Rh-', 'AB Rh+', 'AB Rh-'];
function bloodSelect(value) {
  const opts = value && !BLOOD_GROUPS.includes(value) ? [...BLOOD_GROUPS, value] : BLOOD_GROUPS;
  return h('select', { class: 'input', name: 'iceBlood' }, h('option', { value: '' }, 'Non indicato'), opts.map((g) => h('option', { value: g, selected: g === value }, g)));
}
const offGameStripe = () => h('div', { class: 'offgame-stripe', 'aria-hidden': 'true' }, h('span', null, 'OFF GAME'));
// Modulo ICE: nella pagina ICE e dentro l'avviso di sicurezza pre-gara. onSaved: cosa fare dopo il salvataggio.
function iceForm(onSaved = null) {
  const ice = S.state?.account?.ice || {};
  const field = (label, name, value, attrs = {}) => h('label', { class: 'field' }, h('span', null, label), h('input', { class: 'input', name, value: value || '', ...attrs }));
  const cond = h('textarea', { class: 'input', name: 'iceConditions', rows: 3, maxlength: 600, placeholder: 'es. asma, allergia alle punture d\'ape, diabete…' });
  cond.value = ice.conditions || '';
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form).entries());
    try { await api('PATCH', '/api/account', fd); toast('Dati ICE salvati', 'ok'); await refresh(); onSaved?.(); } catch (err) { toast(err.offline ? 'Serve la rete per salvare' : err.message, 'error', 6000); }
  } },
  h('label', { class: 'field' }, h('span', null, 'Gruppo sanguigno'), bloodSelect(ice.blood)),
  h('label', { class: 'field' }, h('span', null, 'Patologie, allergie o farmaci che i soccorritori devono conoscere'), cond),
  field('Nome del contatto di emergenza', 'iceContactName', ice.contactName, { maxlength: 80, placeholder: 'es. Laura (moglie)' }),
  field('Telefono del contatto di emergenza', 'iceContactPhone', ice.contactPhone, { type: 'tel', maxlength: 30 }),
  h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Salva'));
  return form;
}

// Profilo dentro l'app (senza uscire verso la pagina d'iscrizione): dati, password, gestionale collegato.
function viewProfile() {
  const a = S.state?.account;
  if (!a) return h('div', { class: 'stack' }, h('h2', null, 'Profilo'), h('p', { class: 'empty' }, 'Sei entrato con il QR o il codice della coppia: il profilo è legato al tuo account personale.'));
  const field = (label, attrs) => h('label', { class: 'field' }, h('span', null, label), h('input', { class: 'input', ...attrs }));
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form).entries());
    if (fd.password && fd.password !== fd.password2) return toast('Le due password nuove non coincidono', 'error');
    if (!fd.password) { delete fd.password; delete fd.currentPassword; }
    delete fd.password2;
    try { await api('PATCH', '/api/account', fd); toast('Profilo aggiornato', 'ok'); form.reset(); await refresh(); render(); } catch (err) { toast(err.offline ? 'Serve la rete per salvare' : err.message, 'error', 6000); }
  } },
  h('div', { class: 'card stack-sm' }, h('div', { class: 'eyebrow' }, 'I tuoi dati'),
    field('Nome e cognome', { name: 'name', required: true, value: a.name }),
    field('Nome di battaglia', { name: 'nickname', value: a.nickname || '' }),
    field('Team di softair di appartenenza', { name: 'softairTeam', required: true, value: a.softairTeam || '' }),
    field('Telefono', { name: 'phone', type: 'tel', value: a.phone || '' })),
  h('div', { class: 'card stack-sm' }, h('div', { class: 'eyebrow' }, a.hasPassword ? 'Cambia password (facoltativo)' : 'Imposta una password (facoltativo)'),
    a.hasPassword ? field('Password attuale', { name: 'currentPassword', type: 'password', autocomplete: 'current-password' })
      : h('p', { class: 'muted small' }, `Entri con il gestionale. Con una password potrai entrare anche come @${a.username}.`),
    field('Nuova password', { name: 'password', type: 'password', minlength: 8, autocomplete: 'new-password' }),
    field('Ripeti la nuova password', { name: 'password2', type: 'password', minlength: 8, autocomplete: 'new-password' })),
  h('button', { class: 'btn btn-primary btn-xl btn-block', type: 'submit' }, 'Salva'));
  const me = meInfo();
  return h('div', { class: 'stack' },
    h('div', { class: 'profile-head' }, avatarFace(me, 'xl'), h('div', null, h('h2', null, me.name), h('div', { class: 'muted small' }, `@${a.username}`))),
    form,
    a.ops?.length ? h('div', { class: 'card stack-sm' }, h('div', { class: 'eyebrow' }, 'Gestionale collegato'),
      a.ops.map((o) => h('div', null, h('strong', null, o.providerName), h('div', { class: 'muted small' }, [o.opsName, o.squadra].filter(Boolean).join(' · '))))) : null,
    h('nav', { class: 'grid' }, tile('#/ice', 'ICE', '✚'), tile('#/statoarmi', 'Il mio test armi', '⌁')));
}

// Stato all'evento (iscrizione, accettazione, test armi con i joule) dentro l'app.
function viewEventStatus() {
  const st = S.state;
  return h('div', { class: 'stack' },
    h('h2', null, 'Il mio test armi'),
    h('p', { class: 'muted small' }, 'Iscrizione, accettazione all\'arrivo e test armi al cronografo: per ogni arma i joule misurati e il pallino usato.'),
    st?.player?.event ? eventStatusCard(st.player.event, { gameName: st.game?.name }) : h('p', { class: 'empty' }, 'Nessuna iscrizione a una partita in corso.'));
}

function viewIce() {
  const acc = S.state?.account;
  const form = iceForm();
  return h('div', { class: 'stack ice-page' },
    offGameStripe(),
    h('h2', null, 'ICE · In Case of Emergency'),
    h('p', null, 'Per la tua sicurezza, facoltativo. Questa è una sezione ', h('strong', null, 'OFF GAME'), ', fuori dal gioco.'),
    h('div', { class: 'callout-off' }, h('strong', null, 'Questi dati non sono visibili in regia.'),
      ' Arrivano alla Direzione solo ed esclusivamente se premi il pulsante EMERGENZA (o l\'SOS di Traccar Client), insieme alla tua posizione, perché i soccorritori sappiano cosa fare.'),
    acc ? form : h('p', { class: 'empty' }, 'I dati ICE si salvano nel tuo account personale: entra con il tuo account (non con il codice della coppia) per compilarli.'),
    offGameStripe());
}

// Mini sondaggio dell'avviso: Sì / No / Forse. La risposta si può cambiare; la regia vede chi ha risposto cosa.
const POLL = [['si', 'Sì'], ['no', 'No'], ['forse', 'Forse']];
function pollButtons(n) {
  const vote = async (choice) => {
    try { await api('POST', `/api/team/notices/${n.id}/vote`, { choice }); n.myVote = choice; vibrate(40); toast('Risposta inviata al Consiglio', 'ok'); render(); refresh(); }
    catch (e) { toast(e.offline ? 'Serve la rete per rispondere' : e.message, 'error'); }
  };
  return h('div', { class: 'poll' },
    h('div', { class: 'poll-btns' }, POLL.map(([k, label]) => h('button', { type: 'button', class: `btn poll-${k} ${n.myVote === k ? 'on' : ''}`, 'aria-pressed': n.myVote === k ? 'true' : 'false', onclick: () => vote(k) }, label))),
    h('p', { class: 'tiny muted' }, n.myVote ? `Avete risposto «${POLL.find(([k]) => k === n.myVote)[1]}». Potete cambiare idea.` : 'Rispondete: il Consiglio vede le risposte.'));
}

function viewNotices() {
  const list = S.state?.notices || [];
  const forLabel = (n) => (n.target === 'team' ? 'Solo per voi' : n.target === 'elect' ? 'Per gli Eletti' : n.target === 'couples' ? 'Per le coppie' : 'Per tutti');
  return h('div', { class: 'stack' },
    h('h2', null, 'Avvisi'),
    h('p', { class: 'muted small' }, 'Comunicazioni del Consiglio: ritrovi, cambi di programma, istruzioni.'),
    pushInvite(),
    list.length ? h('ul', { class: 'feed' }, list.map((n) => h('li', { class: `ann notice ${n.id > S.seenNotice ? 'new' : ''}` },
      h('div', { class: 'ann-head' }, h('span', { class: `chip ${n.target === 'team' ? 'chip-blood' : 'chip-brass'}` }, forLabel(n)), h('span', { class: 'mono muted small' }, `${new Date(n.createdAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} · ${fmtTime(n.createdAt)}`)),
      h('h3', { class: 'notice-title' }, n.poll ? '📊 ' : '', n.title),
      n.body ? h('div', { class: 'md' }, md(n.body)) : null,
      n.poll ? pollButtons(n) : null)))
      : h('p', { class: 'empty' }, 'Nessun avviso, per ora.'));
}

// Toglie un annuncio con uno swipe: sparisce e conta come letto.
function hideAnn(id) {
  if (!S.annHidden.includes(id)) S.annHidden = [...S.annHidden, id].slice(-500);
  store.set('zdg_ann_hidden', S.annHidden);
  if (id > S.seenAnn) { S.seenAnn = id; store.set('zdg_seen_ann', id); }
  render();
}

// Scorrere di lato un elemento lo toglie (con un tocco normale funziona come sempre).
function swipeAway(el, onDismiss) {
  let x0 = null; let y0 = 0; let dx = 0; let moved = false;
  el.classList.add('swipeable');
  el.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && e.button !== 0) return; x0 = e.clientX; y0 = e.clientY; dx = 0; moved = false; });
  el.addEventListener('pointermove', (e) => {
    if (x0 == null) return;
    dx = e.clientX - x0;
    if (!moved && Math.abs(e.clientY - y0) > Math.abs(dx)) { x0 = null; return; }
    if (Math.abs(dx) > 8) { moved = true; el.style.transform = `translateX(${dx}px)`; el.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / el.offsetWidth)); }
  });
  const end = () => {
    if (x0 == null) return;
    x0 = null;
    if (moved && Math.abs(dx) > el.offsetWidth * 0.35) {
      el.style.transition = 'transform .2s, opacity .2s';
      el.style.transform = `translateX(${dx > 0 ? '' : '-'}110%)`; el.style.opacity = '0';
      setTimeout(onDismiss, 200);
    } else { el.style.transition = 'transform .15s, opacity .15s'; el.style.transform = ''; el.style.opacity = ''; setTimeout(() => { el.style.transition = ''; }, 160); }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  // Dopo uno swipe il tocco non apre il link.
  el.addEventListener('click', (e) => { if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; } }, true);
  return el;
}

function viewAnnouncements() {
  const all = S.state?.announcements || [];
  const list = all.filter((a) => !S.annHidden.includes(a.id));
  const hidden = all.length - list.length;
  return h('div', { class: 'stack' },
    h('h2', null, 'Annunci del Consiglio'),
    list.length ? h('p', { class: 'tiny muted' }, 'Scorrete un annuncio di lato per toglierlo.') : null,
    list.length ? h('ul', { class: 'feed' }, list.map((a) => swipeAway(h('li', { class: `ann ann-${a.type} ${a.id > S.seenAnn ? 'new' : ''}` },
      h('div', { class: 'ann-head' }, h('span', { class: `chip ${a.type === 'revelation' || a.type === 'pause' ? 'chip-blood' : ''}` }, ANN_LABEL[a.type] || a.type), h('span', { class: 'mono muted small' }, fmtTime(a.createdAt, true))),
      h('p', null, a.text),
      a.type === 'revelation' && a.payload ? h('div', { class: 'ann-code mono' }, `${a.payload.sectorName}: `, h('strong', null, a.payload.code)) : null), () => hideAnn(a.id))))
      : h('p', { class: 'empty' }, hidden ? 'Nessun annuncio da leggere.' : 'Il Consiglio tace, per ora.'),
    hidden ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { S.annHidden = []; store.set('zdg_ann_hidden', []); render(); } }, hidden === 1 ? 'Mostra l\'annuncio tolto' : `Mostra i ${hidden} annunci tolti`) : null);
}

// Chat con la regia, stile WhatsApp: fumetti, composer fisso in fondo, vocali.
function viewMessages() {
  // Eletti con una squadra: due canali di gruppo, ognuno con i suoi messaggi.
  const sq = mySquad();
  const channel = sq && S.chatChannel === 'squad' ? 'squad' : 'all';
  const all = S.state?.messages || [];
  const msgs = !isElect() ? all : all.filter((m) => (channel === 'squad' ? m.squadId === sq.id : !m.squadId));
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
      who ? h('div', { class: 'bubble-who' }, who) : null,
      m.audioMime ? voicePlayer(`/api/media/message/${m.id}`, m.audioMs) : h('div', { class: 'bubble-text' }, m.text),
      h('div', { class: 'bubble-time mono' }, fmtTime(m.createdAt))));
  }
  return h('div', { class: 'chat-wrap' },
    h('div', { class: 'chat-head' },
      h('strong', null, !isElect() ? 'Consiglio Zero' : channel === 'squad' ? `Squadra ${sq.name}` : 'Tutti gli Eletti'),
      h('span', { class: 'muted small' }, !isElect() ? 'Messaggi con la regia · emergenze sempre via radio'
        : channel === 'squad' ? 'Canale della squadra: lo leggono i membri e la regia' : 'Canale di tutti gli Eletti: lo leggono tutti gli Eletti e la regia')),
    channelTabs(all),
    msgs.length ? h('ul', { class: 'chat' }, items) : h('p', { class: 'empty chat-empty' }, isElect() ? 'Nessun messaggio in questo canale.' : 'Nessun messaggio. Scrivete o registrate un vocale alla regia.'),
    composer());
}

// Canali degli Eletti: "Tutti gli Eletti" e, per chi è in una squadra, il canale della squadra.
const mySquad = () => (isElect() ? S.state?.field?.squad || null : null);
const msgSquadId = () => (mySquad() && S.chatChannel === 'squad' ? mySquad().id : null);
function channelTabs(all) {
  const sq = mySquad();
  if (!sq) return null;
  const me = S.state.player ? S.state.player.nickname || S.state.player.name : null;
  const unread = (inSquad) => all.filter((m) => (inSquad ? m.squadId === sq.id : !m.squadId) && m.id > S.seenMsg && !(m.fromRole === 'team' && m.author === me)).length;
  const tab = (key, label, n) => h('button', { type: 'button', class: (S.chatChannel === 'squad') === (key === 'squad') ? 'on' : '', onclick: () => { S.chatChannel = key; S.chatScroll = true; render(); } },
    label, n ? h('span', { class: 'badge badge-alert' }, n) : null);
  const current = S.chatChannel === 'squad';
  return h('div', { class: 'chat-target', role: 'tablist', 'aria-label': 'Canali' },
    tab('all', 'Tutti gli Eletti', current ? unread(false) : 0), tab('squad', `Squadra ${sq.name}`, current ? 0 : unread(true)));
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
  const again = !acc ? 'Per rientrare servirà di nuovo il QR o il codice d\'accesso.'
    : !acc.hasPassword && acc.ops?.length ? `Per rientrare usa «Accedi con ${acc.ops[0].providerName}».`
      : `Per rientrare ti serviranno username (${acc.username}) e password${acc.ops?.length ? `, oppure «Accedi con ${acc.ops[0].providerName}»` : ''}.`;
  if (!(await dialog({ title: 'Uscire?', text: again, okLabel: 'Esci', danger: true }))) return;
  try { await api('POST', '/api/team/logout'); } catch { /* offline */ }
  ['zdg_state', 'zdg_queue', 'zdg_visits', 'zdg_altar_results', 'zdg_unveiled'].forEach(store.del);
  location.href = '/';
}

// In fondo a ogni home: con chi sei entrato, profilo ed Esci.
// Account che fa parte dell'organizzazione: scorciatoia per la regia o la Soglia.
function staffLink(acc, cls) {
  if (!acc?.staff) return null;
  return h('a', { class: cls, href: acc.staff === 'master' ? '/regia' : '/consiglio' }, acc.staff === 'master' ? 'Vai in regia' : 'Consiglio Zero');
}

// ---------------------------------------------------------------- Posizione dell'app
// Il permesso si chiede subito (tour, home, pagina Traccar) e non al via, quando non c'è tempo per le impostazioni.
// S.geoPerm: 'granted' | 'prompt' | 'denied' | 'unknown' (browser senza Permissions API).
S.geoPerm = 'unknown';
async function checkGeoPerm() {
  try {
    const p = await navigator.permissions.query({ name: 'geolocation' });
    S.geoPerm = p.state;
    p.onchange = () => { S.geoPerm = p.state; render(); };
  } catch { S.geoPerm = 'unknown'; }
  render();
}
function askLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { toast('Posizione non disponibile su questo dispositivo', 'error'); resolve(false); return; }
    navigator.geolocation.getCurrentPosition(
      () => { S.geoPerm = 'granted'; toast('Posizione consentita', 'ok'); render(); resolve(true); },
      (e) => { if (e.code === 1) S.geoPerm = 'denied'; toast(e.code === 1 ? 'Posizione negata: consentila dalle impostazioni del sito' : 'Posizione non trovata ora (al chiuso?), ma il permesso è dato', e.code === 1 ? 'error' : 'info', 7000); if (e.code !== 1) S.geoPerm = 'granted'; render(); resolve(e.code !== 1); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });
}
const GEO_DENIED_HELP = /iPhone|iPad|iPod/i.test(navigator.userAgent)
  ? 'Su iPhone: Impostazioni → Privacy → Localizzazione → Safari (o l\'app) → «Mentre usi l\'app», poi ricarica.'
  : 'Su Android: tocca il lucchetto accanto all\'indirizzo → Autorizzazioni → Posizione → Consenti, poi ricarica.';
// Riquadro con lo stato del permesso e il pulsante per darlo.
function locationBox(onChange) {
  if (S.geoPerm === 'granted') return h('p', { class: 'ok-text' }, '✓ Posizione consentita per questa app.');
  if (S.geoPerm === 'denied') return h('div', { class: 'stack-sm' }, h('p', { class: 'bad-text small' }, 'La posizione è bloccata per questa app.'), h('p', { class: 'small muted' }, GEO_DENIED_HELP));
  return h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => askLocation().then(() => onChange?.()) }, '📍 Consenti la posizione');
}
// Invito nelle home finché il permesso non c'è.
function locationInvite(st) {
  if (!st || S.geoPerm === 'granted' || S.geoPerm === 'unknown' || ['ended'].includes(st.clock?.status)) return null;
  return h('div', { class: 'card push-invite' },
    h('strong', null, 'Consenti la posizione adesso'),
    h('p', { class: 'muted small' }, 'Durante la partita il Consiglio vede dove siete e la mappa vi mostra Altari e doni. Datelo ora: al via non c\'è tempo per le impostazioni.'),
    locationBox());
}

// ---------------------------------------------------------------- Traccar Client
// Manda la posizione anche con l'app chiusa o lo schermo spento (il browser non può). Una procedura guidata
// porta a installarlo, configurarlo e provarlo a schermo spento: solo quando la prova riesce sparisce l'avviso.
let trackInfo = null;
let trackPoll = null;
let trackInfoSince;
const TRK_KEY = 'zdg_traccar';
const trk = () => store.get(TRK_KEY, { step: 0, since: null });
const setTrk = (v) => { store.set(TRK_KEY, { ...trk(), ...v }); render(); };
const PLATFORM = /iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'ios' : /Android/i.test(navigator.userAgent) ? 'android' : 'other';
const STORE = {
  android: 'https://play.google.com/store/apps/details?id=org.traccar.client',
  ios: 'https://apps.apple.com/app/traccar-client/id843156974',
};

async function loadTracking(since = trk().since) {
  try { trackInfo = await api('GET', `/api/team/tracking${since ? `?since=${since}` : ''}`); } catch (e) { trackInfo = { error: e.message }; }
  render();
}

// Apre Traccar Client: su Android con un link «intent» (se non è installata si apre il Play Store);
// su iPhone non c'è un modo per aprirla da qui, si va alla sua pagina dell'App Store (pulsante «Apri»).
const traccarOpenUrl = () => (PLATFORM === 'android'
  ? `intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=org.traccar.client;S.browser_fallback_url=${encodeURIComponent(STORE.android)};end`
  : STORE.ios);

// Si parte a breve (partita pronta o cerchio aperto) o si sta giocando, e da Traccar non arriva niente:
// avviso su tutte le pagine, finché non arrivano due segnali.
function traccarPrompt(st) {
  const t = st?.tracking;
  if (!st?.player || !t?.prompt) return null;
  const setup = t.state === 'none' && !t.everSeen;
  return h('div', { class: 'banner banner-traccar', role: 'alert' },
    h('strong', null, t.soon ? '📍 Si parte a breve: accendi Traccar' : '📍 Traccar non manda la posizione'),
    h('span', null, setup ? 'Traccar Client non è ancora configurato su questo telefono: fallo adesso, servono tre minuti.' : t.everSeen && t.pings === 1 ? 'Primo segnale ricevuto: ne serve ancora uno, lascia Traccar acceso.' : 'Apri Traccar Client e accendi il tracciamento. Questo avviso sparisce quando il Consiglio riceve due segnali.'),
    h('span', { class: 'trk-actions' },
      setup ? h('a', { class: 'btn btn-sm btn-primary', href: '#/traccar' }, 'Configura Traccar →')
        : h('a', { class: 'btn btn-sm btn-primary', href: traccarOpenUrl(), rel: 'noopener' }, PLATFORM === 'android' ? 'Apri Traccar' : 'Apri Traccar (App Store)'),
      setup ? null : h('a', { class: 'btn btn-sm btn-ghost', href: '#/traccar' }, 'Aiuto')),
    // Cosa riceve il server, per capire subito se Traccar manda (e con l'identificativo giusto).
    t.deviceId ? h('span', { class: 'tiny mono' }, `Identificativo: ${t.deviceId} · segnali ultima mezz'ora: ${t.pings || 0}${t.lastAt ? ` · ultimo alle ${fmtTime(t.lastAt)}` : ' · nessun segnale'}`) : null);
}

// Mentre una Skill o un Dono vi mostra altre coppie, le posizioni si aggiornano ogni 8 secondi (e spariscono subito
// se il bersaglio entra nell'Ombra, anche se l'aggiornamento in tempo reale si fosse perso).
setInterval(() => { const sk = S.state?.skills; if (!document.hidden && (sk?.sightings?.length || sk?.giftHints?.length || sk?.indicators?.length)) refresh(); }, 20000);

// Con l'avviso Traccar aperto l'app ricontrolla da sola ogni 20 secondi: sparisce appena arrivano i segnali.
setInterval(() => { if (!document.hidden && S.state?.tracking?.prompt) refresh(); }, 30000);

// L'avviso nelle schermate principali: resta finché Traccar non è verificato (o se smette di mandare durante la partita).
function trackFlag(st) {
  const t = st?.tracking;
  if (!st?.player || !t || t.state === 'ok' || t.prompt) return null;
  return h('a', { class: `card track-flag ${t.state === 'stale' ? 'stale' : ''}`, href: '#/traccar' },
    h('strong', null, t.state === 'stale' ? '⚠ Traccar non manda la posizione' : '⚠ Traccar da attivare'),
    h('span', { class: 'small' }, t.state === 'stale'
      ? 'Da più di 10 minuti il Consiglio non riceve la tua posizione da Traccar Client: aprilo e controlla che il tracciamento sia acceso.'
      : 'Senza Traccar Client il Consiglio perde la tua posizione appena chiudi l\'app. Installalo e fai la prova: 3 minuti.'),
    h('span', { class: 'btn btn-sm btn-primary' }, t.state === 'stale' ? 'Controlla' : 'Attiva Traccar →'));
}

function viewTraccar() {
  const st = S.state;
  if (!st?.player) {
    return h('div', { class: 'stack' }, h('h2', null, 'Traccar Client'),
      h('p', { class: 'muted' }, 'Per configurare Traccar entra con il tuo account o con il tuo codice personale: l\'identificativo è legato a te, non al telefono della coppia.'));
  }
  if (!trackInfo || trackInfoSince !== trk().since) { trackInfoSince = trk().since; trackInfo = { loading: true }; loadTracking(trackInfoSince); }
  const t = trackInfo || {};
  const { step, since } = trk();
  // Durante la prova si controlla ogni 5 secondi quanti segnali sono arrivati.
  clearInterval(trackPoll);
  if (since && step === 4) trackPoll = setInterval(() => { if (location.hash !== '#/traccar') { clearInterval(trackPoll); return; } loadTracking(since); }, 5000);
  const verified = t.verifiedAt && step !== 4;
  const copyRow = (label, value) => h('div', { class: 'track-row' },
    h('div', { class: 'eyebrow' }, label),
    h('div', { class: 'row' }, h('code', { class: 'mono track-val' }, value || '…'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => navigator.clipboard?.writeText(value).then(() => toast(`${label}: copiato`, 'ok')) }, 'Copia')));
  const steps = ['Posizione', 'Installa', 'Configura', 'Permessi', 'Prova'];
  const nav = (back, next, nextLabel = 'Avanti →') => h('div', { class: 'row wiz-nav' },
    back != null ? h('button', { class: 'btn', type: 'button', onclick: () => setTrk({ step: back }) }, '‹ Indietro') : h('span'),
    next != null ? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => setTrk({ step: next }) }, nextLabel) : null);
  const head = h('div', { class: 'wiz-steps', 'aria-label': 'Passi' }, steps.map((x, i) => h('button', { type: 'button', class: `wiz-step ${i === step ? 'on' : i < step ? 'done' : ''}`, onclick: () => setTrk({ step: i }) }, h('span', { class: 'mono' }, i + 1), x)));

  if (verified) {
    const stale = t.state === 'stale';
    return h('div', { class: 'stack' },
      h('h2', null, 'Traccar Client'),
      h('div', { class: `card stack-sm ${stale ? 'track-flag stale' : 'track-ok'}` },
        h('strong', null, stale ? '⚠ Verificato, ma non manda la posizione' : '✓ Traccar funziona'),
        h('p', { class: 'small' }, stale ? 'Durante la partita non arriva niente da più di 10 minuti: apri Traccar Client e controlla che il tracciamento sia acceso e che ci sia rete.' : 'Il Consiglio riceve la tua posizione anche a schermo spento. Prima della partita accendi Traccar Client e lascialo acceso fino alla fine.'),
        h('p', { class: 'small muted' }, `Verificato ${fmtTime(t.verifiedAt)}${t.lastAt ? ` · ultimo segnale ${fmtTime(t.lastAt)}${t.lastAcc ? ` (±${t.lastAcc} m)` : ''}` : ''}`)),
      h('div', { class: 'card stack-sm' }, h('strong', null, 'Posizione di questa app'), locationBox()),
      copyRow('Indirizzo del server (Server URL)', t.serverUrl),
      copyRow('Identificativo del dispositivo (Device identifier)', t.deviceId),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: () => loadTracking(null) }, '↻ Aggiorna'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => setTrk({ step: 4, since: null }) }, 'Rifai la prova')),
      h('p', { class: 'small muted' }, 'L\'identificativo è solo tuo: non condividerlo. Il Consiglio vede la posizione solo a partita iniziata.'));
  }

  let body;
  if (step === 0) {
    body = [
      h('p', null, 'Prima di tutto questa app deve poter usare la posizione del telefono: serve per la mappa e, a partita iniziata, per far sapere al Consiglio dove sei quando l\'app è aperta.'),
      locationBox(),
      h('p', { class: 'small muted' }, 'Traccar Client (il passo dopo) fa lo stesso quando l\'app è chiusa o lo schermo è spento.'),
      nav(null, 1, S.geoPerm === 'granted' ? 'Avanti →' : 'Salta per ora →'),
    ];
  } else if (step === 1) {
    body = [
      h('p', null, 'Con l\'app chiusa o lo schermo spento il telefono smette di mandare la posizione: è un limite del browser. ', h('strong', null, 'Traccar Client'), ', gratuita, la manda al Consiglio sempre, anche in tasca.'),
      h('div', { class: 'stack-sm' },
        PLATFORM !== 'ios' ? h('a', { class: `btn btn-block ${PLATFORM === 'android' ? 'btn-primary' : ''}`, href: STORE.android, target: '_blank', rel: 'noopener' }, '⤓ Traccar Client per Android (Play Store)') : null,
        PLATFORM !== 'android' ? h('a', { class: `btn btn-block ${PLATFORM === 'ios' ? 'btn-primary' : ''}`, href: STORE.ios, target: '_blank', rel: 'noopener' }, '⤓ Traccar Client per iPhone (App Store)') : null),
      h('p', { class: 'small muted' }, 'Cerca «Traccar Client» (l\'icona blu con il segnaposto bianco). Non serve creare account.'),
      nav(0, 2, 'L\'ho installata →'),
    ];
  } else if (step === 2) {
    body = [
      h('p', null, 'Apri Traccar Client e, nelle impostazioni, copia questi due valori (tieni premuto per incollare):'),
      t.loading ? h('p', { class: 'muted' }, 'Caricamento…') : t.error ? h('p', { class: 'bad-text' }, t.error) : [
        copyRow('Identificativo del dispositivo (Device identifier)', t.deviceId),
        copyRow('Indirizzo del server (Server URL)', t.serverUrl)],
      h('ul', { class: 'track-steps small' },
        h('li', null, h('strong', null, 'Precisione (Location accuracy)'), ': alta / High'),
        h('li', null, h('strong', null, 'Intervallo (Interval)'), ': 30 secondi'),
        h('li', null, h('strong', null, 'Distanza (Distance)'), ': 0'),
        h('li', null, h('strong', null, 'Invio da fermo (Heartbeat / Stationary interval)'), ': 60 secondi'),
        h('li', null, 'Se c\'è, ', h('strong', null, 'Offline buffering'), ': acceso')),
      h('p', { class: 'small muted' }, 'L\'identificativo è solo tuo: non condividerlo.'),
      nav(1, 3, 'Fatto →'),
    ];
  } else if (step === 3) {
    body = [
      h('p', null, 'Perché la posizione parta anche in tasca, il telefono deve permetterlo:'),
      PLATFORM === 'ios' ? h('ol', { class: 'track-steps' },
        h('li', null, 'Impostazioni → Traccar Client → Posizione: ', h('strong', null, 'Sempre'), ' e ', h('strong', null, 'Posizione esatta'), ' attiva.'),
        h('li', null, 'Impostazioni → Traccar Client: ', h('strong', null, 'Aggiornamento app in background'), ' attivo.'),
        h('li', null, 'Non chiudere Traccar dal multitasking (scorrendolo via).'))
        : h('ol', { class: 'track-steps' },
          h('li', null, 'Quando Traccar chiede la posizione scegli ', h('strong', null, '«Consenti sempre»'), ' (o da Impostazioni → App → Traccar Client → Autorizzazioni → Posizione).'),
          h('li', null, 'Impostazioni → App → Traccar Client → Batteria: ', h('strong', null, '«Senza restrizioni»'), ' (togli l\'ottimizzazione).'),
          h('li', null, 'Su Xiaomi, Huawei, Samsung: consenti anche l\'avvio automatico / l\'attività in background.')),
      nav(2, 4, 'Fatto →'),
    ];
  } else {
    const test = t.test;
    const elapsed = since ? Math.floor((Date.now() - since) / 1000) : 0;
    const pings = test?.pings || 0;
    const ready = since && pings >= 2 && elapsed >= 45;
    body = [
      h('ol', { class: 'track-steps' },
        h('li', null, 'In Traccar Client ', h('strong', null, 'accendi il tracciamento'), ' (l\'interruttore in alto).'),
        h('li', null, 'Torna qui e premi ', h('strong', null, '«Inizia la prova»'), '.'),
        h('li', null, h('strong', null, 'Blocca lo schermo'), ' e metti il telefono in tasca per ', h('strong', null, 'un minuto'), '.'),
        h('li', null, 'Riapri questa pagina: se sono arrivati almeno 2 segnali, Traccar è verificato.')),
      since ? h('div', { class: `card stack-sm track-test ${ready ? 'ok' : ''}` },
        h('div', { class: 'eyebrow' }, `Prova iniziata alle ${fmtTime(since)} · ${elapsed >= 60 ? `${Math.floor(elapsed / 60)}′ ` : ''}${elapsed % 60}″`),
        h('div', { class: 'track-count' }, h('span', { class: 'mono' }, pings), ` ${pings === 1 ? 'segnale ricevuto' : 'segnali ricevuti'}`),
        pings ? h('p', { class: 'small muted' }, `Ultimo alle ${fmtTime(test.lastAt)}${t.lastAcc ? ` · ±${t.lastAcc} m` : ''}`) : null,
        !pings && elapsed > 90 ? h('div', { class: 'small bad-text' }, 'Ancora niente da Traccar. Controlla: ',
          h('ul', null, h('li', null, 'indirizzo del server e identificativo copiati senza spazi;'), h('li', null, 'il tracciamento acceso in Traccar Client;'), h('li', null, 'la rete dati attiva e la posizione «Sempre».'))) : null,
        ready ? h('button', { class: 'btn btn-primary btn-xl btn-block', type: 'button', onclick: async () => {
          try { trackInfo = await api('POST', '/api/team/tracking/verify', { since }); setTrk({ step: 0, since: null }); vibrate([60, 40, 160]); toast('Traccar verificato: funziona anche a schermo spento', 'ok', 6000); refresh(); } catch (e) { toast(e.message, 'error', 7000); }
        } }, '✓ Conferma: Traccar funziona')
          : h('p', { class: 'small muted' }, pings >= 2 ? 'Ancora qualche secondo…' : 'Blocca lo schermo e aspetta in tasca: i segnali arrivano ogni 30 secondi.'),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => setTrk({ since: Date.now() }) }, 'Ricomincia la prova'))
        : h('button', { class: 'btn btn-primary btn-xl btn-block', type: 'button', onclick: () => setTrk({ since: Date.now() }) }, '▶ Inizia la prova'),
      nav(3, null),
    ];
  }
  return h('div', { class: 'stack' },
    h('h2', null, 'Attiva Traccar Client'),
    h('p', { class: 'muted small' }, 'La tua posizione arriva al Consiglio anche con lo schermo spento. Cinque passi, circa tre minuti.'),
    head,
    h('div', { class: 'card stack' }, body));
}

function viewSettings() {
  const set = (k, v) => { S.settings[k] = v; store.set('zdg_settings', S.settings); applyTheme(); render(); };
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const st = S.state;
  return h('div', { class: 'stack' },
    h('h2', null, 'Impostazioni'),
    eventStatusCard(st?.player?.event, { gameName: st?.game?.name }),
    h('div', { class: 'card stack' },
      h('strong', null, 'Notifiche del Consiglio'),
      h('p', { class: 'muted small' }, perm === 'granted' ? 'Attive. Riceverete gli annunci anche a schermo spento.' : 'Attivatele per ricevere annunci e rivelazioni con vibrazione anche a schermo spento.'),
      h('button', { class: 'btn btn-primary btn-block', onclick: async () => { try { await enablePush(); toast('Notifiche attive', 'ok'); render(); } catch (e) { toast(e.message, 'error', 7000); } } }, perm === 'granted' ? 'Riattiva notifiche' : 'Attiva notifiche')),
    h('div', { class: 'card toggle-row' }, h('div', null, h('strong', null, 'Suono'), h('div', { class: 'muted small' }, 'Spento di default: nel softair il rumore tradisce la posizione.')),
      h('button', { class: `btn ${S.settings.sound ? 'btn-primary' : ''}`, onclick: () => { set('sound', !S.settings.sound); if (S.settings.sound) beep(true); } }, S.settings.sound ? 'Attivo' : 'Spento')),
    h('div', { class: 'card toggle-row' }, h('div', null, h('strong', null, 'Modalità sole'), h('div', { class: 'muted small' }, 'Tema chiaro ad alto contrasto per la luce diretta.')),
      h('button', { class: `btn ${S.settings.sun ? 'btn-primary' : ''}`, onclick: () => set('sun', !S.settings.sun) }, S.settings.sun ? 'Attiva' : 'Spenta')),
    st ? h('div', { class: 'card' }, h('div', { class: 'eyebrow' }, isElect() ? 'Eletti del Consiglio' : isLobby() ? 'Iscrizione' : 'Coppia'), h('p', null, st.team.members.map((m) => (m.name ? m.name + (m.nickname ? ` «${m.nickname}»` : '') : m.nickname ? `«${m.nickname}»` : m.me ? 'Tu' : 'Legato')).join(isElect() ? ', ' : ' e ')), h('p', { class: 'muted small' }, st.game.name)) : null,
    st?.account ? h('div', { class: 'card' }, h('div', { class: 'eyebrow' }, 'Il tuo account'), h('p', null, h('strong', null, st.account.username), ` · ${st.account.name}`),
      h('a', { class: 'btn btn-sm', href: '/iscrizione#profilo' }, 'Profilo e password')) : null,
    st?.player?.accessCode ? h('div', { class: 'card' }, h('div', { class: 'eyebrow' }, 'Il tuo codice personale'), h('div', { class: 'mono big-text' }, st.player.accessCode), h('p', { class: 'muted small' }, 'Con questo codice entri da qualsiasi telefono e segui sempre la tua coppia.')) : null,
    st?.player ? h('a', { class: `card toggle-row track-link ${st.tracking?.state === 'ok' ? '' : 'warn'}`, href: '#/traccar' }, h('div', null, h('strong', null, 'Traccar Client'), h('div', { class: 'muted small' }, st.tracking?.state === 'ok' ? 'Verificato: la posizione arriva anche a schermo spento.' : st.tracking?.state === 'stale' ? 'Verificato, ma non manda la posizione.' : 'Da attivare: posizione anche a schermo spento.')), h('span', { class: `chip ${st.tracking?.state === 'ok' ? 'chip-ok' : 'chip-warn'}` }, st.tracking?.state === 'ok' ? 'attivo' : 'da fare')) : null,
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
  const position = {
    icon: h('div', { class: 'tour-ico' }, '📍'),
    title: 'La vostra posizione',
    text: [elect ? 'Durante i Giochi la regia e gli altri Eletti vedono dove siete: servono per piazzare Altari e doni e per coordinarvi.' : 'Durante la partita il Consiglio vede dove siete (per la vostra sicurezza e per arbitrare) e la mappa vi mostra Altari, doni e la Soglia.',
      'Il telefono chiederà il permesso: consentitelo adesso, al via non ci sarà tempo. La posizione arriva al Consiglio solo a partita iniziata.'],
    // Il tour non si ridisegna con l'app: il riquadro si aggiorna da solo dopo la risposta.
    extra: () => { const box = h('div'); const draw = () => mount(box, locationBox(draw)); draw(); return box; },
  };
  const traccar = st?.player ? {
    icon: h('div', { class: 'tour-ico' }, '⌁'),
    title: 'Traccar Client',
    text: ['Con lo schermo spento o l\'app chiusa il telefono smette di mandare la posizione: è un limite del browser. L\'app gratuita Traccar Client la manda sempre, anche in tasca.',
      'Una procedura guidata vi porta a installarla e a provarla a schermo spento: tre minuti. Finché non è verificata, l\'app ve lo ricorda.'],
    extra: () => h('a', { class: 'btn btn-primary btn-block', href: '#/traccar', onclick: () => document.querySelector('.tour .tour-top .btn')?.click() }, 'Configura Traccar adesso →'),
  } : null;
  const install = {
    icon: h('div', { class: 'tour-ico' }, '⇩'),
    title: 'Portatela con voi',
    text: ['Installate l\'app sulla schermata home: si apre come un\'app vera, funziona senza rete e riceve le notifiche.'],
    extra: installBox,
  };
  if (elect) {
    return [welcome,
      { icon: h('div', { class: 'tour-ico' }, '⛨'), title: 'Il vostro compito', text: ['Gli Eletti tengono in piedi i Giochi e ne difendono i luoghi: logistica, Altari, il Cuore, i doni. Non hanno Sigillo e non cercano la Parola: obbediscono al Consiglio.'] },
      position, traccar, notices, timers, radio, install].filter(Boolean);
  }
  return [welcome,
    { icon: sealDemo, title: 'Il Sigillo', text: ['Ogni coppia custodisce un Sigillo segreto. Prima del cerchio vedete solo un simulacro sfocato: si svela quando il Consiglio apre il cerchio. Toccate quello qui sopra.', 'Se perdete un ingaggio lo mostrate a tutto schermo, con l\'orologio che prova che non è uno screenshot.'] },
    { icon: h('div', { class: 'tour-ico' }, '⌖'), title: 'Gli Altari', text: ['Nel bosco ci sono gli Altari, uno per Settore, con un QR.'], extra: () => h('ol', { class: 'tour-steps' }, h('li', null, 'Toccate «Scansiona Altare» e inquadrate il QR: lo scanner è dentro l\'app.'), h('li', null, 'Allontanatevi: vicino all\'Altare si combatte.'), h('li', null, 'Inserite il Sigillo di quel Settore e ottenete un frammento.'), h('li', { class: 'muted' }, 'Senza rete? L\'Altare resta in lista e il Sigillo parte appena torna il segnale.')) },
    { icon: h('div', { class: 'tour-parola' }, h('strong', { class: 'mono' }, 'Frammenti: 4 / 8'), demoSegments), title: 'La Parola', text: ['Ogni Altare custodisce un frammento della Parola. Potete anche aggiungere quelli ricevuti da altre coppie: l\'app verifica che siano veri. Con la Parola intera, correte alla Soglia: vince chi arriva primo.'] },
    { icon: h('div', { class: 'tour-notebook' }, h('div', null, h('span', { class: 'mono muted' }, 'I'), ' Fuoco ', ghost('tour-nb1', 6)), h('div', null, h('span', { class: 'mono muted' }, 'III'), ' Terra ', h('strong', { class: 'mono' }, '7D2Q9K'), ' ', h('span', { class: 'chip chip-blood' }, 'rivelato'))), title: 'Il taccuino', text: ['Ogni tanto il Consiglio tradisce: rivela a tutti il Sigillo di un Settore, che finisce nel vostro taccuino. Lì potete anche verificare un Sigillo che vi hanno mostrato: l\'app vi dice se è vero.'] },
    position, traccar, notices, timers, radio, install].filter(Boolean);
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
checkGeoPerm();

export { ApiError };
