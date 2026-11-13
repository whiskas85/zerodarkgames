// Utility condivise tra PWA coppie, regia, soglia e tabellone.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  let value;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'value') value = v;
      else if (k === 'class') el.className = v;
      // Le variabili CSS (--c ecc.) vanno impostate con setProperty: Object.assign le ignora.
      else if (k === 'style' && typeof v === 'object') for (const [p, x] of Object.entries(v)) { if (x == null) continue; if (p.startsWith('--')) el.style.setProperty(p, x); else el.style[p] = x; }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  if (value !== undefined) {
    el.value = value;
    if (tag === 'input') el.defaultValue = String(value);
  }
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(target, ...children) {
  target.replaceChildren();
  append(target, children);
}

export class ApiError extends Error {
  constructor(message, status, offline = false) {
    super(message);
    this.status = status;
    this.offline = offline;
  }
}

// Intestazioni in più per tutte le chiamate (l'app dei giocatori si presenta come tale: vedi X-Zdg-App).
export const API_HEADERS = {};
export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...API_HEADERS, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('Nessuna rete', 0, true);
  }
  let data = null;
  try { data = await res.json(); } catch { /* risposta vuota */ }
  if (!res.ok) throw new ApiError(data?.error || `Errore ${res.status}`, res.status);
  return data;
}

// ---- tempo
const pad = (n) => String(n).padStart(2, '0');

export function fmtDuration(ms, withHours = true) {
  const neg = ms < 0;
  const s = Math.floor(Math.abs(ms) / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const out = withHours || hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
  return neg ? '-' + out : out;
}

// Ora del server (Italia): gli orari si mostrano e si scrivono sempre in quest'ora, qualunque sia il fuso del
// telefono o del computer («ore 12» vuol dire le 12 in Italia).
export const ZONE = 'Europe/Rome';
const zoneFmt = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export function zoneParts(ms) {
  const o = {};
  for (const p of zoneFmt.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, mo: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, mi: o.minute, s: o.second };
}
// Istante di un orario «da muro» in Italia (anche a cavallo dell'ora legale).
export function zoneTime(y, mo, d, h = 0, mi = 0) {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 3; i++) { const p = zoneParts(t); t += want - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s); }
  return t;
}
// «2026-11-14T12:00» (come lo scrivono i campi data/ora) → istante, letto in ora italiana. Con fuso esplicito vale quello.
export function parseWall(str) {
  const v = String(str || '').trim();
  if (!v) return null;
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(v)) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(v);
  return m ? zoneTime(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0)) : null;
}
// Istante → «2026-11-14T12:00» in ora italiana (per i campi data/ora).
export function wallInput(ms) {
  if (!ms) return '';
  const p = zoneParts(ms);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}
// Tutte le date mostrate con toLocale…String usano l'ora italiana, se non è indicato altro.
for (const k of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
  const orig = Date.prototype[k];
  if (orig._zdg) continue;
  const fn = function (locale, opts) { return orig.call(this, locale, { timeZone: ZONE, ...(opts || {}) }); };
  fn._zdg = true;
  Date.prototype[k] = fn;
}

export function fmtTime(ts, seconds = false) {
  if (!ts) return '—';
  const p = zoneParts(ts);
  return `${pad(p.h)}:${pad(p.mi)}${seconds ? ':' + pad(p.s) : ''}`;
}

export function fmtMin(min) {
  if (min == null) return '—';
  const m = Math.round(min * 60) / 60;
  const hh = Math.floor(m / 60);
  const mm = Math.floor(m % 60);
  const ss = Math.round((m - Math.floor(m)) * 60);
  return `+${hh}:${pad(mm)}${ss ? ':' + pad(ss) : ''}`;
}

// Orologio di partita lato client, sincronizzato con l'ora del server.
export function makeClock() {
  let snap = null;
  let offset = 0;
  return {
    set(clock, knownOffset) {
      if (!clock) return;
      snap = clock;
      offset = knownOffset ?? clock.serverNow - Date.now();
    },
    get snap() { return snap; },
    get offset() { return offset; },
    serverNow: () => Date.now() + offset,
    elapsed() {
      if (!snap) return 0;
      return snap.running ? snap.elapsedMs + (Date.now() + offset - snap.serverNow) : snap.elapsedMs;
    },
    remaining() { return snap ? Math.max(0, snap.durationMs - this.elapsed()) : 0; },
  };
}

// ---- simulacri: caratteri casuali e sfocati che "occupano il posto" di un segreto non ancora svelato.
// Generati solo nel client, non hanno alcun legame con i codici veri.
const GHOST_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ghostCache = new Map();
export function ghostText(key, len = 6, words = false) {
  const k = `${key}:${len}:${words}`;
  if (!ghostCache.has(k)) {
    let s = '';
    if (words) {
      const wl = 4 + Math.floor(Math.random() * 6);
      for (let i = 0; i < wl; i++) s += 'abcdefghilmnoprstuvz'[Math.floor(Math.random() * 20)];
    } else {
      for (let i = 0; i < len; i++) s += GHOST_ALPHA[Math.floor(Math.random() * GHOST_ALPHA.length)];
    }
    ghostCache.set(k, s);
  }
  return ghostCache.get(k);
}

export function ghost(key, len = 6, cls = '') {
  return h('span', { class: `ghost ${cls}`, 'aria-hidden': 'true', title: 'Ancora sigillato' }, ghostText(key, len));
}

export function ghostWord(key, cls = '') {
  return h('span', { class: `ghost ${cls}`, 'aria-hidden': 'true' }, ghostText(key, 0, true));
}

// ---- notifiche in pagina
let toastBox;
export function toast(msg, kind = 'info', ms = 4000) {
  if (!toastBox) {
    toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  const t = h('div', { class: `toast toast-${kind}` }, msg);
  toastBox.append(t);
  setTimeout(() => t.remove(), ms);
}

// Dialogo di conferma (sostituisce confirm/prompt nativi).
export function dialog({ title, text, okLabel = 'Conferma', cancelLabel = 'Annulla', danger = false, input = null, textarea = false }) {
  return new Promise((resolve) => {
    const field = input ? h(textarea ? 'textarea' : 'input', { class: 'input', placeholder: input.placeholder || '', value: input.value || '', type: input.type || 'text', rows: 3 }) : null;
    const close = (val) => { dlg.close(); dlg.remove(); resolve(val); };
    const dlg = h('dialog', { class: 'dlg' },
      h('form', { method: 'dialog', onsubmit: (e) => { e.preventDefault(); close(field ? field.value : true); } },
        title && h('h3', null, title),
        text && h('p', null, text),
        field,
        h('div', { class: 'dlg-actions' },
          cancelLabel ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close(null) }, cancelLabel) : null,
          h('button', { type: 'submit', class: `btn ${danger ? 'btn-danger' : 'btn-primary'}` }, okLabel))));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    document.body.append(dlg);
    dlg.showModal();
    (field || dlg.querySelector('.btn-primary, .btn-danger')).focus();
  });
}

// Finestra modale con contenuto libero. onOk() restituisce false per restare aperta (es. dati mancanti).
// La finestra non cambia misura mentre è aperta: titolo e pulsanti restano fermi e il contenuto scorre all'interno.
// tall: finestra già alta il giusto dall'inizio (schede, ricerche, tipi diversi con contenuti di altezza diversa);
// le altre prendono l'altezza che hanno all'apertura e la tengono.
export function modal({ title, body, okLabel = 'Conferma', cancelLabel = 'Annulla', onOk, wide = false, tall = false, onOpen }) {
  return new Promise((resolve) => {
    const close = (val) => { dlg.close(); dlg.remove(); resolve(val); };
    const ok = h('button', { type: 'submit', class: 'btn btn-primary' }, okLabel);
    const dlg = h('dialog', { class: `dlg dlg-fixed ${wide ? 'dlg-wide' : ''} ${tall ? 'dlg-tall' : ''}` },
      h('form', { method: 'dialog', onsubmit: async (e) => {
        e.preventDefault();
        ok.disabled = true;
        try {
          const r = onOk ? await onOk() : true;
          if (r !== false) close(r ?? true);
        } catch (err) { toast(err.message, 'error', 6000); }
        ok.disabled = false;
      } },
      title && h('h3', null, title),
      h('div', { class: 'dlg-body' }, body),
      h('div', { class: 'dlg-actions' },
        cancelLabel ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close(null) }, cancelLabel) : null,
        ok)));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    document.body.append(dlg);
    dlg.showModal();
    onOpen?.(dlg);
    // Altezza bloccata a quella dell'apertura (al massimo quella dello schermo): da qui in poi scorre il contenuto.
    if (!tall) requestAnimationFrame(() => { if (dlg.isConnected) dlg.style.height = `${Math.ceil(dlg.getBoundingClientRect().height)}px`; });
  });
}

// ---- ritaglio quadrato di un'immagine (logo della coppia)
// Si sposta la foto trascinandola e la si ingrandisce con il cursore (o due dita); torna un Blob quadrato
// (600×600, PNG se l'originale è PNG per tenere la trasparenza, altrimenti JPEG), oppure null se si annulla.
export async function cropSquare(file, { size = 600, title = 'Ritaglia il logo' } = {}) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Immagine non leggibile')); i.src = url; });
    const V = 280; // lato del riquadro di anteprima
    const base = Math.max(V / img.naturalWidth, V / img.naturalHeight); // la foto copre sempre il riquadro
    // Zoom 1 = la foto riempie il quadrato; sotto 1 la si vede tutta (con bordi), fino a stare interamente dentro.
    const minZ = Math.min(img.naturalWidth, img.naturalHeight) / Math.max(img.naturalWidth, img.naturalHeight);
    const st = { zoom: 1, x: 0, y: 0 }; // x, y: spostamento del centro della foto (px dell'anteprima)
    const canvas = h('canvas', { class: 'crop-canvas', width: V * 2, height: V * 2, style: { width: `${V}px`, height: `${V}px` } });
    const ctx = canvas.getContext('2d');
    const clamp = () => {
      const k = base * st.zoom;
      const mx = Math.abs(img.naturalWidth * k - V) / 2; const my = Math.abs(img.naturalHeight * k - V) / 2;
      st.x = Math.max(-mx, Math.min(mx, st.x)); st.y = Math.max(-my, Math.min(my, st.y));
    };
    const draw = (c = ctx, out = V * 2) => {
      const k = base * st.zoom * (out / V);
      const w = img.naturalWidth * k; const hh = img.naturalHeight * k;
      c.clearRect(0, 0, out, out);
      c.drawImage(img, out / 2 - w / 2 + st.x * (out / V), out / 2 - hh / 2 + st.y * (out / V), w, hh);
    };
    const zoom = h('input', { type: 'range', class: 'crop-zoom', min: minZ.toFixed(3), max: 4, step: 0.01, value: 1, 'aria-label': 'Ingrandimento',
      oninput: () => { st.zoom = Number(zoom.value); clamp(); draw(); } });
    // Trascinamento (un dito o il mouse) e pizzico (due dita) per ingrandire.
    const pts = new Map();
    let last = null; let pinch = null;
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); last = { x: e.clientX, y: e.clientY }; if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: st.zoom }; } });
    canvas.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && pinch) { const [a, b] = [...pts.values()]; st.zoom = Math.max(minZ, Math.min(4, pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d)); zoom.value = st.zoom; }
      else if (last) { st.x += e.clientX - last.x; st.y += e.clientY - last.y; last = { x: e.clientX, y: e.clientY }; }
      clamp(); draw();
    });
    const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; last = pts.size ? [...pts.values()][0] : null; };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); st.zoom = Math.max(minZ, Math.min(4, st.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))); zoom.value = st.zoom; clamp(); draw(); }, { passive: false });
    const body = h('div', { class: 'crop' },
      h('p', { class: 'small muted' }, 'Trascina la foto per scegliere cosa tenere nel quadrato; ingrandisci con il cursore (o con due dita).'),
      h('div', { class: 'crop-frame' }, canvas),
      h('label', { class: 'crop-zoom-row' }, h('span', { 'aria-hidden': 'true' }, '−'), zoom, h('span', { 'aria-hidden': 'true' }, '+')));
    const png = /png|gif|webp/i.test(file.type);
    return await modal({ title, body, okLabel: 'Usa questo ritaglio', onOpen: () => draw(),
      onOk: () => new Promise((res) => {
        const out = h('canvas', { width: size, height: size });
        const c = out.getContext('2d');
        if (!png) { c.fillStyle = '#000'; c.fillRect(0, 0, size, size); }
        draw(c, size);
        out.toBlob((b) => res(b), png ? 'image/png' : 'image/jpeg', 0.9);
      }) });
  } finally { URL.revokeObjectURL(url); }
}

// ---- stream SSE con riconnessione
export function stream(url, handlers) {
  let es;
  let retry = 1000;
  const open = () => {
    es = new EventSource(url, { withCredentials: true });
    es.addEventListener('hello', (e) => { retry = 1000; handlers.open?.(JSON.parse(e.data)); });
    for (const [ev, fn] of Object.entries(handlers)) {
      if (ev !== 'open' && ev !== 'error') es.addEventListener(ev, (e) => fn(JSON.parse(e.data || '{}')));
    }
    es.onerror = () => {
      handlers.error?.();
      if (es.readyState === EventSource.CLOSED) {
        setTimeout(open, retry);
        retry = Math.min(retry * 2, 30000);
      }
    };
  };
  open();
  return { close: () => es?.close() };
}

export function vibrate(pattern = [180, 90, 180]) {
  try { navigator.vibrate?.(pattern); } catch { /* non supportato */ }
}

export function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// Identificativo di questo dispositivo (lo tiene il browser): serve a distinguere i telefoni della stessa persona.
export function deviceIdOf() {
  let id = null;
  try { id = JSON.parse(localStorage.getItem('zdg_device') || 'null'); } catch { /* niente */ }
  if (!id) { id = `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`; try { localStorage.setItem('zdg_device', JSON.stringify(id)); } catch { /* niente */ } }
  return id;
}

export async function enablePush(as = 'team') {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Notifiche push non supportate su questo dispositivo/connessione (serve HTTPS)');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Permesso notifiche negato');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('GET', '/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  // Il dispositivo (lo stesso identificativo dell'app): la regia vede su quale telefono sono attive.
  await api('POST', `/api/push/subscribe${as === 'staff' ? '?as=staff' : ''}`, { subscription: sub.toJSON(), deviceId: as === 'staff' ? null : deviceIdOf() });
  return true;
}

export const store = {
  get(k, def = null) {
    try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* spazio pieno o bloccato */ }
  },
  del(k) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  },
};

// Schermo sempre acceso (Screen Wake Lock): una scelta di questo dispositivo, vale su tutte le pagine
// (app di coppie ed Eletti, regia, campo). Il lock cade quando la pagina va in secondo piano: si riprende al ritorno.
const KEEP_AWAKE = 'zdg_keep_awake';
let keepLock = null;
export const keepAwakeSupported = () => typeof navigator !== 'undefined' && 'wakeLock' in navigator;
export const keepAwakeOn = () => !!store.get(KEEP_AWAKE, false);
async function keepAwakeAcquire() {
  if (!keepAwakeOn() || !keepAwakeSupported() || document.hidden || keepLock) return;
  try {
    keepLock = await navigator.wakeLock.request('screen');
    keepLock.addEventListener('release', () => { keepLock = null; });
  } catch { keepLock = null; }
}
export function setKeepAwake(on) {
  store.set(KEEP_AWAKE, !!on);
  if (on) keepAwakeAcquire();
  else { try { keepLock?.release(); } catch { /* già rilasciato */ } keepLock = null; }
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', keepAwakeAcquire);
  // Alcuni browser lo concedono solo dopo un tocco: si riprova al primo.
  document.addEventListener('pointerdown', keepAwakeAcquire, { passive: true });
  keepAwakeAcquire();
}
// Luminosità dell'app (scelta del dispositivo): un velo scuro sopra tutta la pagina, che non ferma i tocchi.
// Il browser non può cambiare la luminosità del telefono: così si scurisce l'app (batteria e meno luce nel bosco).
const DIM = 'zdg_dim';
export const dimLevel = () => Math.max(0, Math.min(70, Number(store.get(DIM, 0)) || 0));
export function applyDim() {
  if (typeof document === 'undefined' || !document.body) return;
  let el = document.getElementById('zdg-dim');
  const v = dimLevel();
  if (!v) { el?.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'zdg-dim'; el.setAttribute('aria-hidden', 'true'); document.body.append(el); }
  el.style.cssText = `position:fixed;inset:0;background:#000;opacity:${v / 100};pointer-events:none;z-index:2147483000;`;
}
export function setDim(v) { store.set(DIM, Math.max(0, Math.min(70, Math.round(Number(v) || 0)))); applyDim(); }
if (typeof document !== 'undefined') {
  if (document.body) applyDim(); else document.addEventListener('DOMContentLoaded', applyDim);
}
export function dimRow() {
  const val = h('strong', { class: 'mono' }, `${100 - dimLevel()}%`);
  const range = h('input', { type: 'range', min: 30, max: 100, step: 5, value: 100 - dimLevel(), 'aria-label': 'Luminosità dell\'app',
    oninput: (e) => { setDim(100 - Number(e.target.value)); val.textContent = `${e.target.value}%`; } });
  return h('div', { class: 'card dim-row' },
    h('div', { class: 'dim-head' }, h('strong', null, 'Luminosità dell\'app'), val),
    h('div', { class: 'muted small' }, 'Scurisce tutta l\'app su questo dispositivo: meno luce nel bosco e meno batteria. Al 100% è normale.'),
    range);
}

// Riga con l'interruttore, uguale in app e regia.
export function keepAwakeRow(onChange) {
  const on = keepAwakeOn();
  const ok = keepAwakeSupported();
  return h('div', { class: 'card toggle-row keep-awake' },
    h('div', null, h('strong', null, 'Schermo sempre acceso'),
      h('div', { class: 'muted small' }, ok ? (on ? 'Attivo: con l\'app aperta lo schermo non si spegne (consuma più batteria).' : 'Spento: lo schermo si spegne come al solito. Attivalo per non far andare il telefono in standby.')
        : 'Questo browser non permette di tenere acceso lo schermo.')),
    h('button', { type: 'button', class: `switch ${on ? 'on' : ''}`, role: 'switch', 'aria-checked': on ? 'true' : 'false', disabled: !ok, onclick: () => { setKeepAwake(!on); onChange?.(); } },
      h('span', { class: 'switch-knob', 'aria-hidden': 'true' }), on ? 'ATTIVO' : 'SPENTO'));
}

export const STATUS_LABELS = {
  created: 'Creata', draft: 'In preparazione', ready: 'Pronta', circle: 'Nel cerchio', truce: 'Tregua', hunt: 'Caccia aperta',
  last_half_hour: 'Ultima mezz\'ora', exfil: 'Esfiltrazione', paused: 'SOSPESA', ended: 'Terminata',
};

// ---- messaggi vocali (stile WhatsApp): registrazione e lettore

// Il microfono è disponibile solo in contesto sicuro (https o localhost).
export function voiceSupported() {
  return !!(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

function pickAudioMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']) {
    if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
  }
  return '';
}

export const VOICE_MAX_MS = 120000;

// Avvia la registrazione; restituisce stop() → { blob, mime, ms } e cancel().
export async function startRecording({ onLimit } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mime = pickAudioMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  const startedAt = Date.now();
  const limit = setTimeout(() => onLimit?.(), VOICE_MAX_MS);
  rec.start(250);
  const finish = () => new Promise((resolve) => {
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const type = (rec.mimeType || mime || 'audio/webm').split(';')[0];
      resolve({ blob: new Blob(chunks, { type }), mime: type, ms: Math.min(VOICE_MAX_MS, Date.now() - startedAt) });
    };
    if (rec.state !== 'inactive') rec.stop(); else rec.onstop();
  });
  return {
    startedAt,
    stop: () => { clearTimeout(limit); return finish(); },
    cancel: () => { clearTimeout(limit); finish(); },
  };
}

export async function uploadAudio(url, { blob, mime, ms }) {
  let res;
  try {
    res = await fetch(`${url}${url.includes('?') ? '&' : '?'}ms=${Math.round(ms)}`, { method: 'POST', headers: { 'Content-Type': mime }, body: blob, credentials: 'same-origin' });
  } catch {
    throw new ApiError('Nessuna rete: il vocale non è stato inviato', 0, true);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error || `Errore ${res.status}`, res.status);
  return data;
}

export const fmtSec = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Lettore a fumetto: play/pausa, barra di avanzamento toccabile, durata. Un solo vocale alla volta.
let playingAudio = null;
export function voicePlayer(src, ms) {
  const audio = new Audio();
  audio.preload = 'none';
  audio.src = src;
  const btn = h('button', { class: 'vp-btn', type: 'button', 'aria-label': 'Ascolta il messaggio vocale' }, '▶');
  const fill = h('i', { class: 'vp-fill' });
  const bar = h('div', { class: 'vp-bar', role: 'slider', 'aria-label': 'Posizione', 'aria-valuemin': 0, 'aria-valuemax': 100 }, fill);
  const time = h('span', { class: 'vp-time mono' }, fmtSec(ms || 0));
  const total = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration * 1000 : ms || 0);
  const update = () => {
    const pct = total() ? Math.min(100, (audio.currentTime * 1000 / total()) * 100) : 0;
    fill.style.width = `${pct}%`;
    time.textContent = fmtSec(audio.paused && !audio.currentTime ? total() : audio.currentTime * 1000);
  };
  btn.addEventListener('click', () => {
    if (audio.paused) {
      if (playingAudio && playingAudio !== audio) playingAudio.pause();
      playingAudio = audio;
      audio.play().catch(() => {});
    } else audio.pause();
  });
  bar.addEventListener('click', (e) => {
    const r = bar.getBoundingClientRect();
    if (total()) audio.currentTime = ((e.clientX - r.left) / r.width) * (total() / 1000);
  });
  audio.addEventListener('play', () => { btn.textContent = '❚❚'; });
  audio.addEventListener('pause', () => { btn.textContent = '▶'; });
  audio.addEventListener('ended', () => { btn.textContent = '▶'; audio.currentTime = 0; update(); });
  audio.addEventListener('timeupdate', update);
  audio.addEventListener('loadedmetadata', update);
  return h('div', { class: 'voice-player' }, btn, bar, time);
}

// ---- scanner QR interno all'app (fotocamera + BarcodeDetector o jsQR)

let jsqrLoading = null;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  jsqrLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/jsQR.js';
    s.onload = () => resolve(window.jsQR);
    s.onerror = () => { jsqrLoading = null; reject(new Error('Lettore QR non disponibile: riprova con la rete')); };
    document.head.append(s);
  });
  return jsqrLoading;
}

// Fotocamere posteriori: su molti telefoni (es. Samsung) la prima offerta dal browser è la grandangolare,
// che non mette a fuoco da vicino. Preferiamo la principale ("camera2 0", oppure la prima posteriore non "wide").
async function backCameras() {
  try {
    const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const back = all.filter((d) => /back|rear|environment|posterior|retro/i.test(d.label));
    const list = back.length ? back : all;
    const score = (d) => (/camera2 0\b|camera 0\b/i.test(d.label) ? 0 : /ultra|wide|grandang|macro|tele|depth/i.test(d.label) ? 2 : 1);
    return [...list].sort((a, b) => score(a) - score(b));
  } catch { return []; }
}

// La fotocamera è concessa dal browser solo in contesto sicuro (https o localhost).
export function cameraSupported() {
  return !!(window.isSecureContext && navigator.mediaDevices?.getUserMedia);
}

// ---- NFC (Web NFC: Chrome su Android). I tag contengono lo stesso link del QR (record URL).
export const nfcSupported = () => typeof window !== 'undefined' && 'NDEFReader' in window;
const nfcText = (rec) => {
  try {
    if (rec.recordType === 'url' || rec.recordType === 'absolute-url' || rec.recordType === 'text') return new TextDecoder(rec.encoding || 'utf-8').decode(rec.data);
  } catch { /* record illeggibile */ }
  return null;
};
// Ascolta i tag finché signal non viene interrotto: onText(testo) per ogni link o testo letto.
export async function nfcListen(signal, onText, onError = () => {}) {
  if (!nfcSupported()) return false;
  const r = new window.NDEFReader();
  r.onreading = (e) => { for (const rec of e.message.records) { const t = nfcText(rec); if (t) { onText(t); return; } } onError('Tag NFC vuoto o non dei Giochi'); };
  r.onreadingerror = () => onError('Tag NFC illeggibile: riprovate tenendolo fermo sul retro del telefono');
  await r.scan({ signal });
  return true;
}
// Cancella un tag NFC: prima lo legge (per sapere cosa conteneva), poi ci scrive un messaggio vuoto.
// Restituisce il testo che c'era (o null se era già vuoto o illeggibile).
export async function nfcErase(signal) {
  const r = new window.NDEFReader();
  const before = await new Promise((resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('Annullato', 'AbortError')));
    r.onreading = (e) => { let t = null; for (const rec of e.message.records) { t = nfcText(rec); if (t) break; } resolve(t); };
    r.onreadingerror = () => resolve(null);
    r.scan({ signal }).catch(reject);
  });
  await r.write({ records: [{ recordType: 'empty' }] }, { signal, overwrite: true });
  return before;
}
// Scrive un link su un tag NFC (sovrascrive quello che c'era).
export async function nfcWriteUrl(url, signal) {
  const w = new window.NDEFReader();
  await w.write({ records: [{ recordType: 'url', data: url }] }, { signal, overwrite: true });
}

// Apre lo scanner a tutto schermo. accept(testo) → true per accettare, una stringa per mostrare un avviso e continuare.
// Restituisce il testo letto, oppure null se chiuso.
export function scanQR({ title = 'Inquadra il QR', hint = '', accept = () => true } = {}) {
  return new Promise((resolve) => {
    let stream = null;
    let track = null;
    let timer = null;
    let done = false;
    let torchOn = false;
    let zoom2 = false;
    let cams = [];
    let open = () => {};
    const video = h('video', { class: 'scanner-video', playsinline: true, muted: true, autoplay: true });
    const status = h('div', { class: 'scanner-status', role: 'status', 'aria-live': 'polite' }, 'Avvio della fotocamera…');
    const torchBtn = h('button', { class: 'scanner-btn hidden', type: 'button', 'aria-label': 'Torcia', onclick: async () => {
      try {
        torchOn = !torchOn;
        await track.applyConstraints({ advanced: [{ torch: torchOn }] });
        torchBtn.classList.toggle('on', torchOn);
      } catch { /* torcia non disponibile */ }
    } }, '🔦');
    // Zoom: inquadrare il QR da più lontano, dove la messa a fuoco funziona meglio.
    const zoomBtn = h('button', { class: 'scanner-btn hidden', type: 'button', 'aria-label': 'Zoom', onclick: async () => {
      try {
        const c = track.getCapabilities();
        zoom2 = !zoom2;
        await track.applyConstraints({ advanced: [{ zoom: zoom2 ? Math.min(c.zoom.max, Math.max(c.zoom.min, 2)) : Math.max(c.zoom.min, 1) }] });
        zoomBtn.textContent = zoom2 ? '1×' : '2×';
      } catch { /* zoom non disponibile */ }
    } }, '2×');
    // Scelta della fotocamera: la scelta resta su questo telefono per le prossime scansioni.
    const camSel = h('select', { class: 'scanner-cam hidden', 'aria-label': 'Fotocamera', onchange: (e) => { store.set('zdg_camera', e.target.value); open(e.target.value); } });
    const fillCams = () => {
      const cur = track?.getSettings?.().deviceId;
      const name = (d, i) => {
        const main = /camera2 0\b|camera 0\b/i.test(d.label);
        const wide = /ultra|wide|grandang/i.test(d.label);
        return `Fotocamera ${i + 1}${main ? ' · principale (consigliata)' : wide ? ' · grandangolare' : ''}`;
      };
      camSel.replaceChildren(...cams.map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === cur }, name(d, i))));
      camSel.classList.toggle('hidden', cams.length < 2);
    };
    // NFC (Android): mentre lo scanner è aperto si può anche avvicinare un tag con lo stesso link del QR.
    const nfcAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const finish = (val) => {
      if (done) return;
      done = true;
      try { nfcAbort?.abort(); } catch { /* già fermo */ }
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      overlay.remove();
      document.body.classList.remove('no-scroll');
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };
    const overlay = h('div', { class: 'scanner', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      video,
      h('div', { class: 'scanner-frame', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')),
      h('div', { class: 'scanner-top' }, h('strong', null, title), h('button', { class: 'scanner-btn', type: 'button', 'aria-label': 'Chiudi', onclick: () => finish(null) }, '✕')),
      h('div', { class: 'scanner-bottom' }, status, hint ? h('p', null, hint) : null,
        h('div', { class: 'scanner-tools' }, torchBtn, zoomBtn),
        camSel,
        nfcSupported() ? h('p', { class: 'scanner-tip' }, '📶 Oppure avvicinate un tag NFC al retro del telefono.') : null,
        h('p', { class: 'scanner-tip' }, 'Non mette a fuoco? Scegli un\'altra fotocamera qui sopra, tocca l\'immagine o usa lo zoom 2×.')));
    // Tocco sull'immagine: rifà la messa a fuoco (dove il telefono lo consente).
    video.addEventListener('click', async (e) => {
      if (!track) return;
      try {
        const c = track.getCapabilities?.() || {};
        const r = video.getBoundingClientRect();
        const poi = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
        if (c.focusMode?.includes('single-shot')) await track.applyConstraints({ advanced: [{ focusMode: 'single-shot', pointsOfInterest: [poi] }] });
        if (c.focusMode?.includes('continuous')) setTimeout(() => track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}), 1200);
        status.textContent = 'Messa a fuoco…';
        setTimeout(() => { if (!done) status.textContent = 'Inquadra il QR nel riquadro'; }, 1200);
      } catch { /* messa a fuoco manuale non disponibile */ }
    });
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    if (nfcSupported() && nfcAbort) {
      nfcListen(nfcAbort.signal, (t) => {
        if (done) return;
        const ok = accept(t);
        if (ok === true) { navigator.vibrate?.(80); finish(t); } else { status.textContent = typeof ok === 'string' ? ok : 'Tag NFC non valido'; status.classList.add('bad'); }
      }, (msg) => { if (!done) { status.textContent = msg; status.classList.add('bad'); } }).catch(() => { /* NFC spento o permesso negato: resta la fotocamera */ });
    }
    document.body.classList.add('no-scroll');

    const fail = (msg) => { status.textContent = msg; status.classList.add('bad'); };
    (async () => {
      if (!cameraSupported()) {
        return fail(window.isSecureContext ? 'Fotocamera non disponibile su questo dispositivo.' : 'Lo scanner usa la fotocamera, che il browser concede solo con l\'indirizzo https del Consiglio.');
      }
      // Apre una fotocamera (deviceId) oppure la posteriore predefinita; poi messa a fuoco continua.
      async function openCamera(deviceId) {
        stream?.getTracks().forEach((t) => t.stop());
        const base = { width: { ideal: 1920 }, height: { ideal: 1080 } };
        stream = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { ...base, deviceId: { exact: deviceId } } : { ...base, facingMode: { ideal: 'environment' } }, audio: false });
        if (done) { stream.getTracks().forEach((t) => t.stop()); return; }
        video.srcObject = stream;
        track = stream.getVideoTracks()[0];
        zoom2 = false;
        zoomBtn.textContent = '2×';
        try {
          const c = track.getCapabilities?.() || {};
          torchBtn.classList.toggle('hidden', !c.torch);
          zoomBtn.classList.toggle('hidden', !(c.zoom && c.zoom.max >= 1.5));
          if (c.focusMode?.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        } catch { /* capacità non leggibili */ }
        await video.play().catch(() => {});
      }
      open = (id) => openCamera(id).then(() => { fillCams(); status.classList.remove('bad'); status.textContent = 'Inquadra il QR nel riquadro'; }).catch(() => fail('Questa fotocamera non si apre: scegline un\'altra.'));
      try {
        const saved = store.get('zdg_camera');
        try { await openCamera(saved || null); } catch { if (saved) { store.del('zdg_camera'); await openCamera(null); } else throw new Error(); }
        // Ora che il permesso c'è, i nomi delle fotocamere sono leggibili: se ne abbiamo aperta una secondaria, passiamo alla principale.
        cams = await backCameras();
        const cur = track?.getSettings?.().deviceId;
        if (!saved && cams[0] && cur && cams[0].deviceId !== cur && /ultra|wide|grandang|macro|tele|depth/i.test(cams.find((d) => d.deviceId === cur)?.label || '')) await openCamera(cams[0].deviceId);
        else if (!saved && cams[0] && cur && cams[0].deviceId !== cur && /camera2 0\b/i.test(cams[0].label)) await openCamera(cams[0].deviceId);
      } catch {
        return fail('Permesso fotocamera negato: consentilo dalle impostazioni del browser e riprova.');
      }
      if (done) return;
      fillCams();
      status.textContent = 'Inquadra il QR nel riquadro';

      // Lettore nativo se c'è (Chrome Android), altrimenti jsQR sui fotogrammi.
      let detector = null;
      if ('BarcodeDetector' in window) {
        try {
          const formats = await window.BarcodeDetector.getSupportedFormats();
          if (formats.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        } catch { /* non disponibile */ }
      }
      let jsQR = null;
      if (!detector) {
        try { jsQR = await loadJsQR(); } catch (e) { return fail(e.message); }
      }
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const handle = (text) => {
        if (!text || done) return false;
        const verdict = accept(text);
        if (verdict === true) { vibrate(120); finish(text); return true; }
        if (typeof verdict === 'string') status.textContent = verdict;
        return false;
      };
      const loop = async () => {
        if (done) return;
        if (video.readyState >= 2 && video.videoWidth) {
          try {
            if (detector) {
              for (const c of await detector.detect(video)) if (handle(c.rawValue)) return;
            } else {
              const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
              canvas.width = Math.round(video.videoWidth * scale);
              canvas.height = Math.round(video.videoHeight * scale);
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
              if (r && handle(r.data)) return;
            }
          } catch { /* fotogramma non pronto */ }
        }
        timer = setTimeout(loop, 150);
      };
      loop();
    })();
  });
}

// Ambiente di test (testgames): una striscia in cima a ogni pagina, per non confonderlo con la produzione.
try {
  fetch('/api/health', { cache: 'no-store' }).then((r) => r.json()).then((d) => {
    if (d?.env !== 'test' || document.querySelector('.env-ribbon')) return;
    document.documentElement.classList.add('env-test');
    const el = document.createElement('div');
    el.className = 'env-ribbon';
    const label = document.createElement('span');
    label.textContent = 'Ambiente di test';
    el.append(label);
    document.body.prepend(el);
    window.dispatchEvent(new Event('resize'));
  }).catch(() => {});
} catch { /* niente rete */ }

// Markdown per avvisi e testi della regia: titoli (#, ##, ###), elenchi (- e 1.), citazioni (>), linea (---),
// **grassetto**, *corsivo*, ~~barrato~~, `codice`, [testo](link) come pulsante, link nudi, paragrafi e a capo.
// Si costruiscono nodi DOM (niente HTML dal testo): i link ammessi sono http(s), pagine del sito (/…) e pagine dell'app (#/…).
export function md(text) {
  const safeUrl = (u) => (/^(https?:\/\/|\/|#\/)/i.test(u) ? u : null);
  const inline = (line) => {
    const out = [];
    const re = /\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s)]+)|\*\*([^*]+)\*\*|\*([^*]+)\*|~~([^~]+)~~|`([^`]+)`/g;
    let last = 0;
    let m;
    while ((m = re.exec(line))) {
      if (m.index > last) out.push(line.slice(last, m.index));
      if (m[1]) {
        const url = safeUrl(m[2]);
        out.push(url ? h('a', { class: 'btn btn-sm md-btn', href: url, ...(/^https?:/i.test(url) ? { target: '_blank', rel: 'noopener' } : {}) }, m[1]) : m[0]);
      } else if (m[3]) out.push(h('a', { href: m[3], target: '_blank', rel: 'noopener' }, m[3]));
      else if (m[4]) out.push(h('strong', null, ...inline(m[4])));
      else if (m[5]) out.push(h('em', null, ...inline(m[5])));
      else if (m[6]) out.push(h('s', null, ...inline(m[6])));
      else if (m[7]) out.push(h('code', null, m[7]));
      last = re.lastIndex;
    }
    if (last < line.length) out.push(line.slice(last));
    return out;
  };
  const lines = (arr) => arr.flatMap((l, i) => (i ? [h('br'), ...inline(l)] : inline(l)));
  const out = [];
  let para = [];
  let list = null;
  let quote = [];
  const flush = () => {
    if (para.length) out.push(h('p', null, lines(para)));
    if (quote.length) out.push(h('blockquote', null, lines(quote)));
    if (list) out.push(h(list.tag, null, list.items.map((x) => h('li', null, inline(x)))));
    para = []; quote = []; list = null;
  };
  for (const raw of String(text ?? '').replace(/\r/g, '').split('\n')) {
    const l = raw.trimEnd();
    let m;
    if (!l.trim()) { flush(); continue; }
    if ((m = /^(#{1,3})\s+(.*)$/.exec(l))) { flush(); out.push(h(`h${m[1].length + 2}`, { class: 'md-h' }, inline(m[2]))); continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { flush(); out.push(h('hr')); continue; }
    if ((m = /^\s*>\s?(.*)$/.exec(l))) { if (para.length || list) flush(); quote.push(m[1]); continue; }
    if ((m = /^\s*[-*•]\s+(.*)$/.exec(l))) { if (list?.tag !== 'ul') flush(); list = list || { tag: 'ul', items: [] }; list.items.push(m[1]); continue; }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(l))) { if (list?.tag !== 'ol') flush(); list = list || { tag: 'ol', items: [] }; list.items.push(m[1]); continue; }
    if (list || quote.length) flush();
    para.push(l);
  }
  flush();
  return out;
}

// Editor markdown completo: barra (titoli, grassetto, corsivo, barrato, elenchi, citazione, linea, link come
// pulsante, strumenti extra) e «Schermo intero» con l'anteprima di fianco (sotto, se lo schermo è stretto).
// Pagine dell'app (coppie ed Eletti) da collegare nei testi: [testo](#/pagina) diventa un pulsante che la apre.
// who: chi la vede (tutti, coppie, eletti).
export const APP_PAGES = [
  { route: 'home', label: 'Home', icon: '🏠', who: 'tutti', hint: 'La pagina iniziale, con il tempo e gli avvisi' },
  { route: 'mappa', label: 'Mappa', icon: '🗺️', who: 'tutti', hint: 'Altari, doni, zone, la vostra posizione' },
  { route: 'mappa/soglia', label: 'Mappa sulla Soglia', icon: '⛩', who: 'coppie', hint: 'La mappa centrata sulla Soglia, per uscire' },
  { route: 'altari', label: 'Altari', icon: '🏛️', who: 'coppie', hint: 'Gli Altari inquadrati e da aprire' },
  { route: 'frammenti', label: 'La Parola (frammenti)', icon: '🧩', who: 'coppie', hint: 'I frammenti raccolti' },
  { route: 'codici', label: 'Taccuino dei Sigilli', icon: '🔑', who: 'coppie', hint: 'I Sigilli conosciuti' },
  { route: 'sigillo', label: 'Il vostro Sigillo', icon: '🔐', who: 'coppie', hint: 'Mostra il Sigillo della coppia' },
  { route: 'skill', label: 'Skill', icon: '✦', who: 'coppie', hint: 'Scelta e uso delle Skill' },
  { route: 'doni', label: 'I vostri doni', icon: '🎁', who: 'coppie', hint: 'I Doni presi, da usare' },
  { route: 'scontri', label: 'Scontri', icon: '⚔️', who: 'tutti', hint: 'Dichiarare vinto o perso, storico' },
  { route: 'alleanze', label: 'Alleanze', icon: '🤝', who: 'coppie', hint: 'Proporre, accettare, rompere' },
  { route: 'eventi', label: 'Eventi', icon: '🏁', who: 'tutti', hint: 'Sfide del Consiglio con premio' },
  { route: 'zone', label: 'Zone', icon: '⬡', who: 'tutti', hint: 'Cosa fanno le zone della mappa' },
  { route: 'timer', label: 'Timer', icon: '⏱', who: 'tutti', hint: 'Veglia, stallo, blocco ingaggio…' },
  { route: 'annunci', label: 'Annunci', icon: '📣', who: 'tutti', hint: 'Gli annunci del Consiglio' },
  { route: 'avvisi', label: 'Avvisi', icon: '🔔', who: 'tutti', hint: 'Gli avvisi della regia (con sondaggi)' },
  { route: 'messaggi', label: 'Messaggi', icon: '💬', who: 'tutti', hint: 'Chat con il Consiglio' },
  { route: 'messaggi/solo', label: 'Messaggi solo per te', icon: '✉️', who: 'tutti', hint: 'La chat privata con il Consiglio' },
  { route: 'compagno', label: 'Chat con il compagno', icon: '👥', who: 'coppie', hint: 'La chat della coppia' },
  { route: 'radio', label: 'Radio', icon: '📻', who: 'tutti', hint: 'Canali radio della partita' },
  { route: 'regolamento', label: 'Regolamento', icon: '📖', who: 'tutti', hint: 'Le regole dei Giochi' },
  { route: 'ice', label: 'Dati ICE', icon: '🆘', who: 'tutti', hint: 'Contatto e dati per le emergenze' },
  { route: 'profilo', label: 'Profilo', icon: '👤', who: 'tutti', hint: 'Nome, nick, telefono, foto' },
  { route: 'impostazioni', label: 'Impostazioni', icon: '⚙️', who: 'tutti', hint: 'Notifiche, suoni, schermo' },
  { route: 'traccar', label: 'Traccar Client', icon: '📡', who: 'tutti', hint: 'Configurazione del tracciamento' },
  { route: 'installa', label: 'Installa l\'app', icon: '📲', who: 'tutti', hint: 'Aggiungere l\'app alla schermata home' },
  { route: 'indicazioni', label: 'Indicazioni campo', icon: '🧭', who: 'tutti', hint: 'Parcheggio, accettazione, punti utili' },
  { route: 'accettazione', label: 'Accettazione', icon: '✅', who: 'tutti', hint: 'Il pass per l\'accettazione all\'arrivo' },
  { route: 'statoarmi', label: 'Test repliche', icon: '🔫', who: 'tutti', hint: 'Esito del cronografo delle repliche' },
  { route: 'ristoro', label: 'Ristoro', icon: '🥪', who: 'tutti', hint: 'Ordinare panini e bevande' },
  { route: 'voto', label: 'Voto del pubblico', icon: '🏅', who: 'tutti', hint: 'La classifica del voto' },
  { route: 'campo', label: 'Campo (Eletti)', icon: '📍', who: 'eletti', hint: 'Piazzamenti di Altari e doni' },
  { route: 'incarichi', label: 'Incarichi (Eletti)', icon: '🎯', who: 'eletti', hint: 'Gli incarichi della squadra' },
  { route: 'mine', label: 'Mine (Eletti)', icon: '💣', who: 'eletti', hint: 'Posare e ricaricare le mine' },
  { route: 'beacon', label: 'Beacon (Eletti)', icon: '📶', who: 'eletti', hint: 'Disattivare gli Altari' },
  { route: 'punteggio', label: 'Punteggio (Eletti)', icon: '🏆', who: 'eletti', hint: 'Classifica degli Eletti' },
];
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Scelta di una pagina dell'app (con ricerca) o di un indirizzo esterno: torna { url, label } o null.
export async function pickAppLink() {
  let chosen = null;
  const list = h('div', { class: 'stack-xs app-link-list' });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Cerca una pagina: mappa, skill, ICE, regolamento…', autocomplete: 'off', oninput: () => draw() });
  const ext = h('input', { class: 'input', type: 'url', inputmode: 'url', placeholder: 'https://… (link esterno)' });
  const draw = () => {
    const words = norm(search.value).split(/\s+/).filter(Boolean);
    const hits = APP_PAGES.filter((p) => words.every((w) => norm(`${p.label} ${p.hint} ${p.route} ${p.who}`).includes(w)));
    list.replaceChildren(...(hits.length ? hits.map((p) => h('button', { type: 'button', class: 'btn btn-block app-link-item', onclick: (e) => { chosen = { url: `#/${p.route}`, label: p.label }; e.target.closest('form').requestSubmit(); } },
      h('span', { class: 'app-link-ico', 'aria-hidden': 'true' }, p.icon),
      h('span', { class: 'app-link-txt' }, h('strong', null, p.label), h('span', { class: 'tiny muted' }, p.hint)),
      p.who !== 'tutti' ? h('span', { class: 'chip' }, p.who) : null)) : [h('p', { class: 'empty' }, 'Nessuna pagina con questa ricerca.')]));
  };
  draw();
  const ok = await modal({ title: '🔗 Collegamento', okLabel: 'Inserisci il link esterno', tall: true,
    onOpen: () => setTimeout(() => search.focus(), 50),
    body: h('div', { class: 'stack-sm' },
      h('p', { class: 'tiny muted' }, 'Tocca una pagina dell\'app: nel testo diventa un pulsante che la apre. Il testo selezionato diventa la scritta del pulsante.'),
      search, list,
      h('div', { class: 'field' }, h('span', null, 'Oppure un indirizzo esterno'), ext)),
    onOk: () => {
      if (chosen) return true;
      const u = ext.value.trim();
      if (!/^https?:\/\/\S+$/i.test(u)) { toast('Scegli una pagina oppure scrivi un indirizzo https://…', 'error'); return false; }
      chosen = { url: u, label: 'Apri il link' };
      return true;
    } });
  return ok ? chosen : null;
}

export function mdEditor({ value = '', placeholder = '', rows = 8, maxlength = 8000, extra = [], onInput = null, keep = null } = {}) {
  const ta = h('textarea', { class: 'input md-input', rows, maxlength, placeholder, ...(keep ? { 'data-keep': keep } : {}) });
  ta.value = value;
  const changed = () => { ta.dispatchEvent(new Event('input', { bubbles: true })); };
  const sel = () => [ta.selectionStart ?? ta.value.length, ta.selectionEnd ?? ta.value.length];
  const wrap = (before, after = before, sample = 'testo') => {
    const [a, b] = sel();
    const t = ta.value.slice(a, b) || sample;
    ta.value = ta.value.slice(0, a) + before + t + after + ta.value.slice(b);
    ta.focus();
    ta.setSelectionRange(a + before.length, a + before.length + t.length);
    changed();
  };
  // Prefisso a ogni riga selezionata (titoli, elenchi, citazione); ripremuto lo toglie.
  const prefix = (fn, strip) => {
    const [a0, b0] = sel();
    const a = ta.value.lastIndexOf('\n', a0 - 1) + 1;
    let b = ta.value.indexOf('\n', b0);
    if (b < 0) b = ta.value.length;
    const ls = ta.value.slice(a, b).split('\n');
    const all = ls.every((l) => strip.test(l));
    const next = ls.map((l, i) => (all ? l.replace(strip, '') : fn(l.replace(/^(#{1,3}\s+|\s*>\s?|\s*[-*•]\s+|\s*\d+[.)]\s+)/, ''), i))).join('\n');
    ta.value = ta.value.slice(0, a) + next + ta.value.slice(b);
    ta.focus();
    ta.setSelectionRange(a, a + next.length);
    changed();
  };
  const insertBlock = (block) => {
    const [a] = sel();
    const pre = a && ta.value[a - 1] !== '\n' ? '\n\n' : '';
    ta.value = ta.value.slice(0, a) + pre + block + '\n' + ta.value.slice(a);
    ta.focus();
    const at = a + pre.length + block.length + 1;
    ta.setSelectionRange(at, at);
    changed();
  };
  // Collegamento: una pagina dell'app (con ricerca) o un indirizzo esterno; diventa un pulsante.
  const link = async () => {
    const range = sel();
    const r = await pickAppLink();
    if (!r) return;
    ta.focus();
    ta.setSelectionRange(...range);
    wrap('[', `](${r.url})`, r.label);
  };
  const tool = (label, title, fn) => h('button', { type: 'button', class: 'btn btn-sm md-tool', title, 'aria-label': title, onmousedown: (e) => e.preventDefault(), onclick: fn }, label);
  const preview = h('div', { class: 'md md-preview' });
  const draw = () => { preview.replaceChildren(...(ta.value.trim() ? md(ta.value) : [h('p', { class: 'muted tiny' }, 'L\'anteprima comparirà qui.')])); };
  let full = null;
  const home = h('div', { class: 'md-editor' });
  const toolbar = h('div', { class: 'md-toolbar' },
    tool('H1', 'Titolo', () => prefix((l) => `# ${l}`, /^#\s+/)),
    tool('H2', 'Sottotitolo', () => prefix((l) => `## ${l}`, /^##\s+/)),
    tool('H3', 'Titoletto', () => prefix((l) => `### ${l}`, /^###\s+/)),
    h('span', { class: 'md-sep' }),
    tool(h('strong', null, 'B'), 'Grassetto (Ctrl+B)', () => wrap('**')),
    tool(h('em', null, 'I'), 'Corsivo (Ctrl+I)', () => wrap('*')),
    tool(h('s', null, 'S'), 'Barrato', () => wrap('~~')),
    h('span', { class: 'md-sep' }),
    tool('• Elenco', 'Elenco puntato', () => prefix((l) => `- ${l}`, /^\s*[-*•]\s+/)),
    tool('1. Elenco', 'Elenco numerato', () => prefix((l, i) => `${i + 1}. ${l}`, /^\s*\d+[.)]\s+/)),
    tool('❝', 'Citazione', () => prefix((l) => `> ${l}`, /^\s*>\s?/)),
    tool('―', 'Linea di separazione', () => insertBlock('---')),
    h('span', { class: 'md-sep' }),
    tool('🔗 Link all\'app', 'Pulsante che apre una pagina dell\'app (o un link esterno)', link),
    ...extra.map((x) => tool(x.label, x.title, () => wrap(x.before, x.after, x.sample))),
    tool('¶', 'Nuovo paragrafo', () => insertBlock('')),
    h('span', { class: 'md-grow' }),
    tool('⛶ Schermo intero', 'Scrivi a schermo intero, con l\'anteprima', () => (full ? close() : open())));
  const close = () => {
    if (!full) return;
    home.append(toolbar, ta);
    full.remove();
    full = null;
    document.body.classList.remove('no-scroll');
    toolbar.lastChild.textContent = '⛶ Schermo intero';
    ta.focus();
  };
  const open = () => {
    full = h('div', { class: 'md-full', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Editor a schermo intero' },
      h('div', { class: 'md-full-head' }, h('strong', null, 'Editor'), h('span', { class: 'tiny muted' }, 'Esc per tornare'), h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: close }, 'Fine')),
      h('div', { class: 'md-full-body' }, h('div', { class: 'md-full-edit' }, toolbar, ta), h('div', { class: 'md-full-prev' }, h('div', { class: 'eyebrow' }, 'Anteprima'), preview)));
    document.body.append(full);
    document.body.classList.add('no-scroll');
    toolbar.lastChild.textContent = '⤡ Riduci';
    draw();
    ta.focus();
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && full) { e.preventDefault(); close(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); wrap('**'); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); wrap('*'); }
  });
  ta.addEventListener('input', () => { if (full) draw(); onInput?.(ta.value); });
  home.append(toolbar, ta);
  return { el: home, textarea: ta, get value() { return ta.value; }, set value(v) { ta.value = v; changed(); } };
}

// Stato della persona all'evento (profilo): iscrizione, accettazione, test repliche e joule per replica col pallino usato.
export function eventStatusCard(ev, { title = 'Il tuo stato all\'evento', gameName = null } = {}) {
  if (!ev) return null;
  const n2 = (x) => Number(x).toFixed(2).replace('.', ',');
  const t = (ms) => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const step = (done, label, sub, warn = false) => h('li', { class: `ev-step ${done ? 'done' : warn ? 'warn' : ''}` },
    h('span', { class: 'ev-dot', 'aria-hidden': 'true' }, done ? '✓' : ''), h('div', null, h('strong', null, label), sub ? h('div', { class: 'tiny muted' }, sub) : null));
  const enrolled = ev.enrolled === 'accepted';
  const chronoSub = ev.chronoDoneAt ? `Chiuso alle ${t(ev.chronoDoneAt)}` : ev.chronoStarted ? 'In corso' : 'Da fare al cronografo';
  const W = ev.weaponList ? ev.weaponList.map((w) => [w.key, w.label]) : [['main', 'Replica primaria'], ['backup', 'Primaria di riserva'], ['secondary', 'Replica secondaria']];
  const weapon = ([k, label]) => {
    const w = ev.weapons?.[k] || {};
    const val = w.ok ? (w.manual ? 'provata · spunta manuale' : `${n2(w.j)} J${w.n > 1 ? ` (media di ${w.n})` : ''}`) : w.failed ? (w.j == null ? 'non passa · segnata a mano' : `${n2(w.j)} J · non passa`) : 'da provare';
    const over = w.max != null && w.max >= 1;
    return h('div', { class: `ev-weapon ${w.ok ? 'ok' : w.failed ? 'bad' : ''}` },
      h('span', { class: 'small' }, label),
      h('strong', { class: 'mono' }, `${w.ok ? '✓ ' : w.failed ? '✕ ' : ''}${val}`),
      w.g ? h('span', { class: 'tiny muted' }, `pallino ${n2(w.g)} g${w.v ? ` · ${n2(w.v)} m/s` : ''}`) : null,
      over ? h('span', { class: 'tiny ev-over' }, `⚠ un colpo sopra 1 J (max ${n2(w.max)} J)`) : null);
  };
  return h('div', { class: 'card ev-card' },
    h('div', { class: 'eyebrow' }, gameName ? `${title} · ${gameName}` : title),
    h('ol', { class: 'ev-steps' },
      step(enrolled, enrolled ? 'Iscritto' : 'Iscrizione inviata', enrolled ? 'Approvato dal Consiglio' : 'In attesa di approvazione', !enrolled),
      step(!!ev.checkinAt, 'Accettazione', ev.checkinAt ? `Fatta alle ${t(ev.checkinAt)}` : 'Da fare all\'arrivo al campo'),
      step(!!ev.chronoDoneAt, 'Test repliche', chronoSub, ev.chronoStarted && !ev.chronoDoneAt)),
    ev.chronoStarted || ev.chronoDoneAt ? h('div', { class: 'ev-weapons' }, W.map(weapon)) : null);
}

// La Parola che si compone (~10 s, poi resta a schermo altri ~10 s): i frammenti affiorano sparsi nel buio uno dopo l'altro,
// poi scivolano al loro posto e formano la Parola. Un tocco salta l'attesa. done() alla fine.
export function wordCeremony(word, { eyebrow = 'La Soglia', title = '', done } = {}) {
  document.querySelector('.word-ceremony')?.remove();
  const parts = (word || []).filter(Boolean);
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const frags = parts.map((t) => h('span', { class: 'wc-frag mono' }, t));
  const line = h('div', { class: 'wc-word' }, frags);
  const el = h('div', { class: 'word-ceremony', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'La Parola' },
    h('div', { class: 'wc-box' }, h('div', { class: 'eyebrow wc-eyebrow' }, eyebrow), line, h('div', { class: 'wc-title' }, title)));
  document.body.append(el);
  const timers = [];
  let over = false;
  const finish = () => { if (over) return; over = true; timers.forEach(clearTimeout); el.remove(); done?.(); };
  el.addEventListener('click', finish);
  const at = (ms, fn) => timers.push(setTimeout(fn, still ? Math.min(ms, 600) : ms));
  // Punto di partenza casuale di ogni frammento, lontano dal suo posto nella Parola.
  frags.forEach((f) => {
    const a = Math.random() * Math.PI * 2;
    const r = 0.25 + Math.random() * 0.2;
    f.style.transform = `translate(${Math.cos(a) * r * innerWidth}px, ${Math.sin(a) * r * innerHeight}px) rotate(${(Math.random() - 0.5) * 50}deg) scale(1.6)`;
  });
  const step = Math.min(700, 4200 / Math.max(1, frags.length));
  frags.forEach((f, i) => at(600 + i * step, () => { f.classList.add('seen'); vibrate(30); }));
  at(5400, () => { el.classList.add('gather'); frags.forEach((f) => { f.style.transform = ''; }); });
  at(8200, () => { el.classList.add('formed'); vibrate([80, 40, 200]); });
  at(20400, finish); // la Parola composta resta a schermo una decina di secondi
  return el;
}

// Uscita negata: lampo rosso a tutto schermo (pagina della Soglia). Si chiude da sola o con un tocco.
export function exitDenied({ title = 'Uscita negata', lines = [], ms = 7000 } = {}) {
  document.querySelector('.exit-denied')?.remove();
  const el = h('div', { class: 'exit-denied', role: 'alertdialog', 'aria-label': title },
    h('div', { class: 'ed-box' }, h('div', { class: 'ed-icon', 'aria-hidden': 'true' }, '✕'), h('div', { class: 'ed-title' }, title),
      lines.filter(Boolean).map((l, i) => h('p', { class: i ? 'muted' : 'big' }, l))));
  const close = () => { clearTimeout(t); el.remove(); };
  const t = setTimeout(close, ms);
  el.addEventListener('click', close);
  document.body.append(el);
  vibrate([400, 150, 400]);
  return el;
}
