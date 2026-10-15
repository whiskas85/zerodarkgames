// Utility condivise tra PWA coppie, regia, soglia e tabellone.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  let value;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'value') value = v;
      else if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
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

export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
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

export function fmtTime(ts, seconds = false) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? ':' + pad(d.getSeconds()) : ''}`;
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
          h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close(null) }, cancelLabel),
          h('button', { type: 'submit', class: `btn ${danger ? 'btn-danger' : 'btn-primary'}` }, okLabel))));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    document.body.append(dlg);
    dlg.showModal();
    (field || dlg.querySelector('.btn-primary, .btn-danger')).focus();
  });
}

// Finestra modale con contenuto libero. onOk() restituisce false per restare aperta (es. dati mancanti).
export function modal({ title, body, okLabel = 'Conferma', cancelLabel = 'Annulla', onOk, wide = false, onOpen }) {
  return new Promise((resolve) => {
    const close = (val) => { dlg.close(); dlg.remove(); resolve(val); };
    const ok = h('button', { type: 'submit', class: 'btn btn-primary' }, okLabel);
    const dlg = h('dialog', { class: `dlg ${wide ? 'dlg-wide' : ''}` },
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
      body,
      h('div', { class: 'dlg-actions' },
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close(null) }, cancelLabel),
        ok)));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    document.body.append(dlg);
    dlg.showModal();
    onOpen?.(dlg);
  });
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

export async function enablePush(as = 'team') {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Notifiche push non supportate su questo dispositivo/connessione (serve HTTPS)');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Permesso notifiche negato');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('GET', '/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  await api('POST', `/api/push/subscribe${as === 'staff' ? '?as=staff' : ''}`, { subscription: sub.toJSON() });
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

export const STATUS_LABELS = {
  draft: 'In preparazione', ready: 'Pronta', circle: 'Nel cerchio', truce: 'Tregua', hunt: 'Caccia aperta',
  last_half_hour: 'Ultima mezz\'ora', paused: 'SOSPESA', ended: 'Terminata',
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
    const finish = (val) => {
      if (done) return;
      done = true;
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
  }).catch(() => {});
} catch { /* niente rete */ }
