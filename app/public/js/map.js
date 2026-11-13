// Mappe OpenTopoMap (Leaflet servito localmente). Una vista persiste tra i ridisegni della pagina:
// l'elemento della mappa viene riagganciato, i segnaposto si aggiornano senza ricreare la mappa.

import { mdiSvg } from './mdi.js';

let leafletLoading = null;
export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  leafletLoading ||= new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/vendor/leaflet/leaflet.css';
    document.head.append(css);
    const s = document.createElement('script');
    s.src = '/vendor/leaflet/leaflet.js';
    // Dopo Leaflet il plugin della rotazione (due dita, bussola); senza, la mappa funziona lo stesso (non ruota).
    s.onload = () => {
      const r = document.createElement('script');
      r.src = '/vendor/leaflet-rotate/leaflet-rotate.js';
      r.onload = () => resolve(window.L);
      r.onerror = () => resolve(window.L);
      document.head.append(r);
    };
    s.onerror = () => { leafletLoading = null; reject(new Error('Mappa non disponibile senza rete')); };
    document.head.append(s);
  });
  return leafletLoading;
}

// Riquadri dal nostro server: li ha su disco (area scaricata dalla regia) o li prende una volta e li tiene.
const TILES = '/tiles/{z}/{x}/{y}.png';
const FALLBACK_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = 'Mappa © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>, SRTM · Stile © <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA)';
const ITALY = [42.5, 12.5];

export const PERSON_TEAM = '#ff4fa3';
export const PERSON_ELECT = '#d1ad62';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Colore chiaro (testo scuro sopra) o scuro (testo bianco).
function isLight(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 160;
}

// Segnaposto: Altare (quadrato con numero romano), Dono (cerchio con icona), io (punto blu).
export function pinHtml(item) {
  // Piazzato provvisorio (senza cartello né foto): stesso segnaposto con il triangolo di attenzione «!».
  if (item.provisional) return `<span class="pin-prov-wrap">${pinHtml({ ...item, provisional: false })}<span class="pin-prov" title="Provvisorio">!</span></span>`;
  if (item.kind === 'altar') return `<span class="pin pin-altar ${item.mine ? 'pin-mine' : ''} ${item.off ? 'pin-off' : ''}"${item.color ? ` style="border-color:${esc(item.color)}"` : ''}>${esc(item.text)}</span>`;
  if (item.kind === 'place') return `<span class="pin pin-place pin-${esc(item.place)}">${landmarkIcon(item.place)}</span>`;
  // Mina tracciante degli Eletti: armata (oro), scattata (rossa, pulsa finché la coppia è marcata).
  if (item.kind === 'mine') return `<span class="pin pin-trap pin-trap-${esc(item.state || 'armed')}">💣</span>`;
  if (item.kind === 'target') return '<span class="pin pin-target">⌖</span>';
  // Emergenza reale: segnaposto rosso che pulsa (grigio se chiusa).
  if (item.kind === 'emergency') return `<span class="pin-sos ${item.state || ''}">${esc(item.text || '!')}</span>`;
  if (item.kind === 'poi') return '<span class="pin pin-poi"><span>◆</span></span>';
  if (item.kind === 'event') return `<span class="pin pin-event">${mdiSvg('flagCheckered', 18)}</span>`;
  if (item.kind === 'guide') return `<span class="pin pin-guide">${mdiSvg(item.icon, 18)}</span>`;
  if (item.kind === 'gift') return `<span class="pin pin-gift pin-${item.state}" style="--c:${esc(item.color || '#d1ad62')}">${esc(item.text || '✦')}</span>`;
  // Persone (telefoni di coppie ed Eletti), riconoscibili a colpo d'occhio e sempre della stessa misura:
  // coppia = cerchio del colore del Settore con il numero romano sopra; Eletto = rombo del colore della squadra con il nome sopra.
  if (item.kind === 'team' || item.kind === 'elect') {
    const c = esc(item.color || (item.kind === 'team' ? PERSON_TEAM : PERSON_ELECT));
    const label = item.text ? `<span class="who-label">${esc(item.text)}</span>` : '';
    // Sotto il segno: perché la posizione è ferma (taglia a intermittenza, o nascosta da un effetto).
    const note = item.note ? `<span class="who-note">${esc(item.note)}</span>` : '';
    return `<span class="who-pin who-${item.kind} ${item.stale ? 'pin-stale' : ''} ${item.blocked ? 'pin-blocked' : ''}" style="--c:${c}">${label}<span class="who-mark"></span>${note}</span>`;
  }
  return '<span class="pin pin-me"></span>';
}

// Le persone (coppie ed Eletti) stanno sopra a tutti gli altri segnaposto; "io" sta sopra a tutto.
const zOf = (it) => (it.kind === 'emergency' ? 9000 : it.kind === 'team' || it.kind === 'elect' ? 5000 : it.kind === 'target' ? 200 : 0);

// Riquadri che coprono un'area (come sul server): per scaricare la mappa offline e stimarne la dimensione.
const lon2x = (lng, z) => Math.floor(((lng + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };
export function tilesFor(b, minZ, maxZ) {
  const out = [];
  for (let z = minZ; z <= maxZ; z++) {
    for (let x = lon2x(b.west, z); x <= lon2x(b.east, z); x++) for (let y = lat2y(b.north, z); y <= lat2y(b.south, z); y++) out.push([z, x, y]);
  }
  return out;
}

// Taglia il segmento p→q (pixel) dentro il rettangolo [x0, y0, x1, y1] (Liang–Barsky): null se ne resta fuori.
function clipSeg(p, q, [x0, y0, x1, y1]) {
  let t0 = 0;
  let t1 = 1;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  for (const [pp, qq] of [[-dx, p.x - x0], [dx, x1 - p.x], [-dy, p.y - y0], [dy, y1 - p.y]]) {
    if (pp === 0) { if (qq < 0) return null; continue; }
    const r = qq / pp;
    if (pp < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [{ x: p.x + t0 * dx, y: p.y + t0 * dy }, { x: p.x + t1 * dx, y: p.y + t1 * dy }];
}
// Basta che un pezzo di lato si veda: anche una zona piccola sullo schermo mostra il suo conto alla rovescia.
const EDGE_MIN_PX = 1;

// remember: chiave per ricordare lo zoom della mappa tra un'apertura e l'altra (anche tra una sessione e l'altra).
// Con uno zoom ricordato, all'apertura la mappa si centra sul puntatore (la vostra posizione) o, senza, al centro
// di ciò che c'è da vedere, sempre a quello zoom. La prima volta in assoluto inquadra tutto come sempre.
// ---- Bussola del telefono condivisa (freccia della posizione e mappa che segue la bussola)
// devHeading: dove punta la parte alta dello schermo, in gradi dal nord (già corretto per lo schermo in orizzontale).
let devHeading = null;
let devHeadingAt = 0;
let devListening = false;
const devSubs = new Set();
// Media circolare pesata di direzioni (gradi): [{ hd, w }] → gradi, oppure null se i campioni si annullano.
function meanHeading(samples) {
  let x = 0; let y = 0;
  for (const m of samples) { const r = m.hd * Math.PI / 180; x += Math.sin(r) * (m.w ?? 1); y += Math.cos(r) * (m.w ?? 1); }
  if (Math.hypot(x, y) < 1e-6) return null;
  return ((Math.atan2(x, y) * 180 / Math.PI) + 360) % 360;
}
const angDiff = (a, b) => { let d = Math.abs(a - b) % 360; if (d > 180) d = 360 - d; return d; };
// Letture della bussola dell'ultimo mezzo secondo: la direzione usata è la loro media (niente tremolio).
const DEV_WINDOW_MS = 500;
const devBuf = [];
const devDiag = { source: null, raw: null, count: 0, firstAt: 0, ignored: 0 };
function pushDevHeading(hd, source) {
  const now = Date.now();
  devBuf.push({ hd, at: now });
  while (devBuf.length && now - devBuf[0].at > DEV_WINDOW_MS) devBuf.shift();
  devDiag.source = source; devDiag.raw = hd; devDiag.count += 1; devDiag.firstAt ||= now;
  devHeading = meanHeading(devBuf) ?? hd;
  devHeadingAt = now;
  for (const f of devSubs) f(devHeading);
}
function onDevOri(e) {
  let hd = null;
  if (Number.isFinite(e.webkitCompassHeading)) hd = e.webkitCompassHeading;
  else if (e.alpha != null && (e.type === 'deviceorientationabsolute' || e.absolute)) hd = 360 - e.alpha;
  if (hd == null) { devDiag.ignored += 1; return; }
  const scr = Number(window.screen?.orientation?.angle) || Number(window.orientation) || 0;
  pushDevHeading((((hd + scr) % 360) + 360) % 360, Number.isFinite(e.webkitCompassHeading) ? 'bussola di iOS' : 'orientamento assoluto del browser');
}
// Per la diagnosi (Impostazioni): cosa sta mandando la bussola del telefono adesso.
export function compassStatus() {
  const now = Date.now();
  const secs = devDiag.firstAt ? Math.max(1, (now - devDiag.firstAt) / 1000) : 0;
  return { listening: devListening, heading: devHeading == null ? null : Math.round(devHeading), raw: devDiag.raw == null ? null : Math.round(devDiag.raw),
    ageMs: devHeadingAt ? now - devHeadingAt : null, source: devDiag.source, perSec: secs ? Math.round(devDiag.count / secs) : 0, ignored: devDiag.ignored };
}
// Accende la bussola; ask: dentro un tocco si può chiedere il permesso (iPhone). Torna true se è accesa.
export async function ensureCompass(ask = false) {
  if (devListening) return true;
  const D = window.DeviceOrientationEvent;
  if (!D) return false;
  if (typeof D.requestPermission === 'function') {
    if (!ask) return false;
    try { if ((await D.requestPermission()) !== 'granted') return false; } catch { return false; }
  }
  if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onDevOri);
  window.addEventListener('deviceorientation', onDevOri);
  devListening = true;
  // Alcuni Android non danno la bussola con deviceorientation: dopo un secondo senza dati si prova il sensore
  // di orientamento assoluto (Generic Sensor API, Chrome).
  setTimeout(() => { if (!devHeadingAt) startOrientationSensor(); }, 1000);
  return true;
}
function startOrientationSensor() {
  if (!('AbsoluteOrientationSensor' in window)) return;
  try {
    const sensor = new window.AbsoluteOrientationSensor({ frequency: 30, referenceFrame: 'screen' });
    sensor.addEventListener('reading', () => {
      const [x, y, z, w] = sensor.quaternion;
      const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * 180 / Math.PI;
      // referenceFrame 'screen': l'orientamento dello schermo è già compreso.
      pushDevHeading((((360 - yaw) % 360) + 360) % 360, 'sensore di orientamento');
    });
    sensor.start();
  } catch { /* sensore non disponibile o permesso negato */ }
}
// Da dove prende la direzione la freccia della posizione: 'gps' (direzione di marcia) o 'compass' (bussola).
export const arrowSource = () => { try { return localStorage.getItem('zdg_arrow_src') === 'compass' ? 'compass' : 'gps'; } catch { return 'gps'; } };
export function setArrowSource(v) {
  try { localStorage.setItem('zdg_arrow_src', v === 'compass' ? 'compass' : 'gps'); } catch { /* */ }
  window.dispatchEvent(new Event('zdg-arrow-src'));
}
const ARROW_HTML = '<span class="zdg-me-arrow"><svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M12 2 L20 21 L12 16.5 L4 21 Z" fill="#3b82f6" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg></span>';

export function createMapView({ className = '', remember = null, nav = false, rotate = false } = {}) {
  const zoomKey = remember ? `zdg_mapzoom_${remember}` : null;
  const savedZoom = (() => { try { const z = zoomKey && Number(localStorage.getItem(zoomKey)); return z >= 3 && z <= 20 ? z : null; } catch { return null; } })();
  // Una richiesta esplicita (mostra un incarico, un punto…) vince sulla centratura automatica dell'apertura.
  let focusAt = 0;
  const el = document.createElement('div');
  el.className = `zdg-map ${className}`;
  const markers = new Map();
  const lines = new Map();
  const circles = new Map();
  const polys = new Map();
  const badges = new Map();
  // Naviga: linea «magnetica» tra la mia posizione e un segnaposto, con i metri che mancano (si aggiorna da sola).
  let navKey = null; let navLine = null; let navLabel = null; let navBar = null;
  const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1).replace('.', ',')} km` : `${Math.round(m)} m`);
  function navStop() {
    navKey = null;
    navLine?.remove(); navLabel?.remove(); navLine = null; navLabel = null;
    if (navBar) navBar.hidden = true;
  }
  function navDraw() {
    if (!map || !navKey) return;
    const t = markers.get(navKey);
    if (!t) { navStop(); return; }
    if (!navBar) {
      navBar = document.createElement('div');
      navBar.className = 'zdg-nav-bar';
      navBar.innerHTML = '<span class="zdg-nav-ico" aria-hidden="true">🧭</span><span class="zdg-nav-txt"></span><button type="button" class="zdg-nav-stop" aria-label="Smetti di navigare">✕</button>';
      navBar.querySelector('.zdg-nav-stop').addEventListener('click', (e) => { e.stopPropagation(); navStop(); });
      L.DomEvent.disableClickPropagation(navBar);
      el.appendChild(navBar);
    }
    navBar.hidden = false;
    const txt = navBar.querySelector('.zdg-nav-txt');
    const name = t._zdgTitle || 'il punto';
    if (!me) { txt.textContent = `Verso ${name}: in attesa della vostra posizione…`; navLine?.remove(); navLabel?.remove(); navLine = null; navLabel = null; return; }
    const a = me.getLatLng(); const b = t.getLatLng();
    const d = distM({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
    const here = d <= Math.max(10, Math.min(30, meAcc || 0));
    txt.textContent = here ? `${name}: siete arrivati` : `${name} · ${fmtDist(d)}`;
    navBar.classList.toggle('arrived', here);
    if (!navLine) navLine = L.polyline([a, b], { color: '#3b82f6', weight: 4, opacity: 0.9, dashArray: '10 8', interactive: false }).addTo(map);
    else navLine.setLatLngs([a, b]);
    const mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
    const html = `<span class="zdg-nav-dist">${fmtDist(d)}</span>`;
    if (!navLabel) navLabel = L.marker(mid, { icon: L.divIcon({ className: 'zdg-nav-label', html, iconSize: null }), interactive: false, zIndexOffset: 9000 }).addTo(map);
    else { navLabel.setLatLng(mid); navLabel.setIcon(L.divIcon({ className: 'zdg-nav-label', html, iconSize: null })); }
  }
  function navStart(key) {
    navKey = key;
    for (const m of markers.values()) m.closePopup();
    navDraw();
    const t = markers.get(key);
    if (t && me) { auto = false; focusAt = Date.now(); clearTimeout(fitTimer); map.fitBounds(L.latLngBounds([me.getLatLng(), t.getLatLng()]).pad(0.25), { maxZoom: 18 }); }
  }
  // Pulsante «Naviga» in fondo al popup di ogni segnaposto.
  function addNavButton(m) {
    const c = m.getPopup()?.getElement()?.querySelector('.leaflet-popup-content');
    if (!c || c.querySelector('.zdg-nav-btn')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'zdg-nav-btn';
    b.textContent = navKey === m._zdgKey ? '✕ Smetti di navigare' : '🧭 Naviga';
    b.addEventListener('click', (e) => { e.stopPropagation(); if (navKey === m._zdgKey) { navStop(); m.closePopup(); } else navStart(m._zdgKey); });
    c.appendChild(b);
  }
  // Etichette sul bordo (conto alla rovescia): sul lato che si vede, ruotate come il lato.
  const edgeBadges = new Map();
  // Fra i lati della zona che si vedono sullo schermo si sceglie quello col tratto visibile più lungo: l'etichetta
  // va a metà di quel tratto (a metà tra i due vertici se il lato si vede tutto), inclinata come il lato.
  // Se nessun lato si vede abbastanza, niente etichetta.
  function placeEdge(e) {
    if (!map) return;
    const size = map.getSize();
    const pad = 16;
    const rect = [pad, pad, size.x - pad, size.y - pad];
    const px = e.points.map((p) => map.latLngToContainerPoint(p));
    let best = null;
    px.forEach((a, i) => {
      const seg = clipSeg(a, px[(i + 1) % px.length], rect);
      if (!seg) return;
      const len = Math.hypot(seg[1].x - seg[0].x, seg[1].y - seg[0].y);
      if (len >= EDGE_MIN_PX && (!best || len > best.len)) best = { seg, len };
    });
    const el = e.marker.getElement();
    if (!best) { if (el) el.style.display = 'none'; return; }
    const [a, b] = best.seg;
    let ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    // La scritta non va mai a testa in giù.
    if (ang > 90) ang -= 180; else if (ang < -90) ang += 180;
    e.marker.setLatLng(map.containerPointToLatLng([(a.x + b.x) / 2, (a.y + b.y) / 2]));
    if (el) { el.style.display = ''; const box = el.firstElementChild; if (box) box.style.transform = `translate(-50%, -50%) rotate(${ang.toFixed(1)}deg)`; }
  }
  const placeEdges = () => { for (const e of edgeBadges.values()) placeEdge(e); };
  let map = null;
  let L = null;
  let fitted = false;
  let placed = false;
  let me = null;
  let meCircle = null;
  let onTap = null;
  let onMarkerTap = null;
  let onShapeTap = null;
  let pending = null;
  let meAcc = null;
  let hi = null;
  // Centratura automatica: attiva finché chi guarda non sposta o ingrandisce la mappa;
  // si riattiva ogni volta che la mappa torna visibile (si riapre la pagina).
  let auto = true;
  let fitTimer = null;
  const autoFit = () => {
    if (!auto || !map) return;
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      if (!auto) return;
      // Zoom ricordato: sul puntatore (se il GPS è vero) o al centro dei segnaposto, a quello zoom.
      if (savedZoom) {
        const z = map.getZoom();
        if (me && (meAcc == null || meAcc <= 300)) map.setView(me.getLatLng(), z);
        else if (markers.size) map.setView(L.latLngBounds([...markers.values()].map((m) => m.getLatLng())).getCenter(), z);
        return;
      }
      view.fit();
    }, 250);
  };
  const outOfView = (ll) => map && !map.getBounds().pad(-0.05).contains(ll);
  for (const ev of ['pointerdown', 'wheel', 'touchstart']) el.addEventListener(ev, () => { auto = false; }, { passive: true });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting && map) { map.invalidateSize(); if (Date.now() - focusAt > 3000) { auto = true; autoFit(); } }
    }).observe(el);
  }

  // Orientamento della mappa: north (a mano), compass (bussola del telefono), gps (direzione di marcia).
  const rot = { mode: 'north', paint: null, target: null, raf: 0, last: null, stop: null };
  const wrap360 = (d) => ((d % 360) + 360) % 360;
  // Gira la mappa verso la direzione (gradi dal nord), dolcemente e senza scatti oltre lo 0/360.
  function aimBearing(heading) {
    if (!map?.setBearing || !Number.isFinite(heading)) return;
    rot.target = wrap360(heading);
    if (rot.raf) return;
    rot.raf = requestAnimationFrame(function step() {
      rot.raf = 0;
      if (rot.mode === 'north' || rot.target == null) return;
      const cur = wrap360(map.getBearing());
      let diff = rot.target - cur;
      if (diff > 180) diff -= 360;
      if (diff < -180) diff += 360;
      if (Math.abs(diff) < 1) return;
      map.setBearing(wrap360(cur + diff * 0.35));
      rot.raf = requestAnimationFrame(step);
    });
  }
  function stopRotSource() { rot.stop?.(); rot.stop = null; rot.target = null; rot.last = null; }
  async function startCompass() {
    if (!(await ensureCompass(true))) return 'La bussola non c\'è su questo dispositivo (o il permesso è negato)';
    const sub = (hd) => { if (rot.mode === 'compass') aimBearing(hd); };
    devSubs.add(sub);
    rot.stop = () => devSubs.delete(sub);
    if (devHeading != null && Date.now() - devHeadingAt < 3000) { aimBearing(devHeading); return null; }
    await new Promise((r) => setTimeout(r, 1500));
    return (devHeading != null && Date.now() - devHeadingAt < 3000) || rot.mode !== 'compass' ? null : 'La bussola del telefono non risponde: prova il modo GPS';
  }
  // Modo GPS: la mappa segue la direzione di marcia media (la stessa della freccia), solo mentre ci si muove.
  function gpsHeading(pos) {
    if (rot.mode !== 'gps' || !pos) return;
    if (arrow.gpsHd != null && Date.now() - arrow.lastMoveAt < 4000) aimBearing(arrow.gpsHd);
  }
  async function setRotMode(mode, toNorth) {
    stopRotSource();
    rot.mode = mode;
    if (toNorth || mode === 'north') { if (toNorth) map.setBearing(0); }
    rot.paint?.();
    if (mode === 'compass') {
      const msg = await startCompass();
      if (msg && rot.mode === 'compass') { flash(msg); setRotMode('gps', false); return; }
      flash('Mappa: segue la bussola del telefono');
    } else if (mode === 'gps') {
      if (lastPos) gpsHeading(lastPos);
      flash('Mappa: segue la direzione di marcia (GPS). Camminate qualche metro');
    } else if (!toNorth) flash('Mappa: nord in alto');
    else flash('Mappa: nord in alto (0°)');
  }
  let lastPos = null;
  // Freccia della posizione: in movimento il pallino diventa un triangolo verso la direzione (GPS o bussola, da
  // Impostazioni); fermi da più di 12 secondi torna il pallino.
  // Direzione GPS: si tengono le posizioni degli ultimi 10 secondi e si prende la direzione tra la media della
  // prima metà e la media della seconda metà (l'errore del singolo punto pesa poco). Se il telefono dà anche la
  // sua direzione di marcia (in movimento), si usa la media delle ultime letture. La freccia disegnata cambia
  // solo se la direzione si sposta di almeno 10° (GPS) o 4° (bussola).
  const arrow = { lastMoveAt: 0, gpsHd: null, raf: 0, pts: [], hds: [], shown: null };
  const MOVE_HOLD_MS = 12000;
  const GPS_WINDOW_MS = 10000;
  function meHeading() {
    if (arrowSource() === 'compass' && devHeading != null && Date.now() - devHeadingAt < 5000) return { hd: devHeading, step: 4 };
    return arrow.gpsHd == null ? null : { hd: arrow.gpsHd, step: 10 };
  }
  function paintMe() {
    const node = me?.getElement?.();
    if (!node) return;
    const h0 = meHeading();
    const show = Date.now() - arrow.lastMoveAt < MOVE_HOLD_MS && h0 != null;
    const want = show ? 'arrow' : 'dot';
    if (node.dataset.mode !== want) { node.innerHTML = show ? ARROW_HTML : pinHtml({ kind: 'me' }); node.dataset.mode = want; arrow.shown = null; }
    if (!show) return;
    if (arrow.shown == null || angDiff(arrow.shown, h0.hd) >= h0.step) arrow.shown = h0.hd;
    node.firstChild.style.transform = `rotate(${wrap360(arrow.shown - (map.getBearing ? map.getBearing() : 0))}deg)`;
  }
  const paintMeSoon = () => { if (arrow.raf) return; arrow.raf = requestAnimationFrame(() => { arrow.raf = 0; paintMe(); }); };
  function trackMove(pos) {
    const now = Date.now();
    arrow.pts.push({ lat: pos.lat, lng: pos.lng, at: now });
    while (arrow.pts.length && now - arrow.pts[0].at > GPS_WINDOW_MS) arrow.pts.shift();
    while (arrow.hds.length && now - arrow.hds[0].at > 5000) arrow.hds.shift();
    // Direzione di marcia data dal telefono (affidabile solo in movimento).
    if (Number.isFinite(pos.heading) && Number.isFinite(pos.speed) && pos.speed > 0.5) arrow.hds.push({ hd: pos.heading, w: Math.min(3, pos.speed), at: now });
    if (arrow.hds.length >= 3) {
      const m = meanHeading(arrow.hds);
      if (m != null) { arrow.gpsHd = m; arrow.lastMoveAt = now; return; }
    }
    const n = arrow.pts.length;
    if (n < 2) return;
    const half = Math.floor(n / 2);
    const avg = (list) => ({ lat: list.reduce((t, q) => t + q.lat, 0) / list.length, lng: list.reduce((t, q) => t + q.lng, 0) / list.length });
    const a = avg(arrow.pts.slice(0, half));
    const b = avg(arrow.pts.slice(n - half));
    const R = 6371000; const toR = Math.PI / 180;
    const dy = (b.lat - a.lat) * toR * R;
    const dx = (b.lng - a.lng) * toR * R * Math.cos(b.lat * toR);
    // Con pochi punti serve uno spostamento più netto; con tanti basta meno (la media toglie l'errore).
    const need = Math.max(n < 4 ? 4 : 2.5, (pos.acc || 0) * (n < 4 ? 0.5 : 0.3));
    if (Math.hypot(dx, dy) < need) return;
    arrow.gpsHd = wrap360(Math.atan2(dx, dy) / toR);
    arrow.lastMoveAt = now;
  }
  devSubs.add(() => { if (arrowSource() === 'compass') paintMeSoon(); });
  window.addEventListener('zdg-arrow-src', () => { if (arrowSource() === 'compass') ensureCompass(false); paintMeSoon(); });
  if (arrowSource() === 'compass') ensureCompass(false);
  setInterval(() => { if (me && el.isConnected) paintMe(); }, 3000);
  // Avviso breve sulla mappa (senza dipendere dai toast della pagina).
  function flash(text) {
    const old = el.querySelector('.zdg-map-flash');
    old?.remove();
    const f = document.createElement('div');
    f.className = 'zdg-map-flash';
    f.textContent = text;
    el.append(f);
    setTimeout(() => f.remove(), 2600);
  }

  const ready = loadLeaflet().then((lib) => {
    L = lib;
    const canRotate = rotate && !!L.Map.TouchRotate;
    // Zone e cerchi si disegnano ben oltre lo schermo (padding 1.5 = una volta e mezza la vista per lato): spostando o
    // girando la mappa non si vedono bordi tagliati che si ridisegnano.
    map = L.map(el, { zoomControl: true, attributionControl: true, renderer: L.svg({ padding: 1.5 }), ...(canRotate ? { rotate: true, touchRotate: true, rotateControl: false, bearing: 0, zoomSnap: 0.25 } : {}) }).setView(ITALY, savedZoom || 6);
    // Gesto a due dita (zoom o rotazione): quando si alza un dito prima dell'altro, il dito rimasto non deve far
    // scivolare la mappa per inerzia. L'inerzia si spegne con il secondo dito e torna al prossimo tocco con un dito solo.
    if (canRotate) el.addEventListener('touchstart', (e) => { map.options.inertia = e.touches.length < 2; }, { passive: true, capture: true });
    // Bussola: l'ago punta al nord, sotto i gradi di rotazione. Tocco: cambia modo (Nord in alto → Bussola del
    // telefono → Direzione del GPS). Pressione lunga: torna al nord (0°) e al modo Nord. Girando la mappa con due
    // dita si torna al modo Nord (la rotazione resta quella scelta a mano).
    if (canRotate) {
      const MODES = { north: ['NORD', 'Nord in alto (gira con due dita)'], compass: ['BUSSOLA', 'Segue la bussola del telefono'], gps: ['GPS', 'Segue la direzione di marcia (GPS)'] };
      let btn = null;
      const paint = () => {
        if (!btn) return;
        const deg = ((Math.round(map.getBearing()) % 360) + 360) % 360;
        btn.querySelector('.zdg-compass-rose').style.transform = `rotate(${-deg}deg)`;
        btn.querySelector('.zdg-compass-deg').textContent = `${deg}°`;
        btn.querySelector('.zdg-compass-mode').textContent = MODES[rot.mode][0];
        btn.classList.toggle('turned', deg !== 0 && rot.mode === 'north');
        btn.classList.toggle('mode-compass', rot.mode === 'compass');
        btn.classList.toggle('mode-gps', rot.mode === 'gps');
        btn.title = `${MODES[rot.mode][1]}. Tocca per cambiare modo, tieni premuto per tornare al nord.`;
        btn.setAttribute('aria-label', btn.title);
      };
      rot.paint = paint;
      const Compass = L.Control.extend({
        options: { position: 'bottomright' },
        onAdd() {
          const b = L.DomUtil.create('button', 'zdg-compass');
          btn = b;
          b.type = 'button';
          b.innerHTML = '<span class="zdg-compass-mode"></span><span class="zdg-compass-rose" aria-hidden="true"><svg viewBox="0 0 24 24" width="26" height="26"><path d="M12 2 L16 12 L12 10.5 L8 12 Z" fill="#e5484d"/><path d="M12 22 L8 12 L12 13.5 L16 12 Z" fill="#cbd5e1"/><text x="12" y="7.6" text-anchor="middle" font-size="4.2" font-weight="700" fill="#fff">N</text></svg></span><span class="zdg-compass-deg">0°</span>';
          L.DomEvent.disableClickPropagation(b);
          let pressT = null;
          let longDone = false;
          const cancelPress = () => { clearTimeout(pressT); pressT = null; };
          L.DomEvent.on(b, 'pointerdown', () => { longDone = false; cancelPress(); pressT = setTimeout(() => { longDone = true; setRotMode('north', true); try { navigator.vibrate?.(40); } catch { /* */ } }, 600); });
          L.DomEvent.on(b, 'pointerup pointerleave pointercancel', cancelPress);
          L.DomEvent.on(b, 'contextmenu', (e) => L.DomEvent.preventDefault(e));
          L.DomEvent.on(b, 'click', (e) => {
            L.DomEvent.stop(e);
            if (longDone) { longDone = false; return; }
            setRotMode(rot.mode === 'north' ? 'compass' : rot.mode === 'compass' ? 'gps' : 'north', rot.mode === 'gps');
          });
          map.on('rotate', () => { paint(); paintMeSoon(); });
          paint();
          return b;
        },
      });
      map.addControl(new Compass());
      // Due dita sulla mappa: rotazione a mano, si torna al modo Nord.
      el.addEventListener('touchstart', (e) => { if (e.touches.length >= 2 && rot.mode !== 'north') setRotMode('north', false); }, { passive: true, capture: true });
    }
    if (savedZoom) fitted = true;
    if (zoomKey) map.on('zoomend', () => { try { localStorage.setItem(zoomKey, String(map.getZoom())); } catch { /* */ } });
    // OpenTopoMap arriva al 17: oltre si ingrandiscono le sue immagini (zoom digitale) fino al 20.
    const topo = L.tileLayer(TILES, { maxZoom: 20, maxNativeZoom: 17, attribution: ATTRIBUTION }).addTo(map);
    // Se il nostro server non lo dà (né su disco né dai server delle mappe), quel riquadro si prende da OpenStreetMap.
    topo.on('tileerror', (e) => {
      if (!e.tile || e.tile.dataset.fallback) return;
      e.tile.dataset.fallback = '1';
      e.tile.src = FALLBACK_TILES.replace('{z}', e.coords.z).replace('{x}', e.coords.x).replace('{y}', e.coords.y);
    });
    map.on('click', (e) => onTap?.(e.latlng));
    // Spostando o ingrandendo la mappa l'etichetta del conto alla rovescia passa sul lato che si vede.
    map.on('moveend zoomend resize', placeEdges);
    if (pending) { view.setItems(pending); pending = null; }
    return view;
  }).catch((e) => {
    el.classList.add('zdg-map-error');
    el.textContent = e.message;
  });

  const view = {
    el,
    ready,
    get map() { return map; },
    // items: [{ key, kind, lat, lng, text, color, state, mine, popup }]
    setItems(items) {
      if (!map) { pending = items; return; }
      const keep = new Set();
      let changed = false;
      for (const it of items) {
        if (it.lat == null || it.lng == null) continue;
        keep.add(it.key);
        const html = pinHtml(it);
        let m = markers.get(it.key);
        if (!m) {
          m = L.marker([it.lat, it.lng], { icon: L.divIcon({ className: 'zdg-pin', html, iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -16] }), title: it.title || '', zIndexOffset: zOf(it) }).addTo(map);
          m._zdgHtml = html;
          m._zdgKey = it.key;
          m._zdgZ = zOf(it);
          // Tocco su un segnaposto: se chi usa la mappa lo gestisce (true), niente popup.
          m.on('click', (e) => { if (onMarkerTap?.(m._zdgKey, m.getLatLng())) { L.DomEvent.stop(e); setTimeout(() => m.closePopup(), 0); } });
          if (nav) m.on('popupopen', () => addNavButton(m));
          markers.set(it.key, m);
          changed = true;
        } else {
          m.setLatLng([it.lat, it.lng]);
          if (outOfView(m.getLatLng())) changed = true;
          if (m._zdgHtml !== html) { m.setIcon(L.divIcon({ className: 'zdg-pin', html, iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -16] })); m._zdgHtml = html; }
        }
        m._zdgTitle = it.title || '';
        if (it.popup) { if (m.getPopup()) { m.setPopupContent(it.popup); if (nav && m.isPopupOpen()) addNavButton(m); } else m.bindPopup(it.popup, { maxWidth: 260 }); }
        else if (nav && !m.getPopup() && !it.noNav) m.bindPopup(`<strong>${esc(it.title || '')}</strong>`, { maxWidth: 260 });
      }
      for (const [k, m] of markers) if (!keep.has(k)) { m.remove(); markers.delete(k); changed = true; }
      if (navKey) navDraw();
      if (!fitted && keep.size) { view.fit(); fitted = true; } else if (savedZoom && !placed && keep.size) { placed = true; autoFit(); } else if (changed) autoFit();
    },
    // Aree circolari (posizioni sfocate, presagi, copertura degli Altari): [{ key, lat, lng, radius, color, title, fill, weight, dash, interactive }]
    setCircles(list) {
      if (!map) return;
      const keep = new Set();
      for (const c of list) {
        keep.add(c.key);
        let ci = circles.get(c.key);
        if (!ci) {
          ci = L.circle([c.lat, c.lng], { radius: c.radius, color: c.color || '#d1ad62', weight: c.weight ?? 2, fillOpacity: c.fill ?? 0.18, dashArray: c.dash || '6 6', interactive: c.interactive ?? true }).addTo(map);
          if (c.title) ci.bindTooltip(c.title, { sticky: true });
          circles.set(c.key, ci);
        } else { ci.setLatLng([c.lat, c.lng]); ci.setRadius(c.radius); }
      }
      for (const [k, ci] of circles) if (!keep.has(k)) { ci.remove(); circles.delete(k); }
    },
    // Linee tratteggiate (es. tra coppie alleate): [{ key, points: [[lat, lng], …], color, title }]
    setLines(list) {
      if (!map) return;
      const keep = new Set();
      for (const l of list) {
        keep.add(l.key);
        let pl = lines.get(l.key);
        if (!pl) { pl = L.polyline(l.points, { color: l.color || '#d1ad62', weight: 3, opacity: 0.85, dashArray: '8 7', interactive: !!l.title }).addTo(map); if (l.title) pl.bindTooltip(l.title, { sticky: true }); lines.set(l.key, pl); }
        else { pl.setLatLngs(l.points); pl.setStyle({ color: l.color || '#d1ad62' }); }
      }
      for (const [k, pl] of lines) if (!keep.has(k)) { pl.remove(); lines.delete(k); }
    },
    // Zone (poligoni chiusi): [{ key, points: [[lat, lng], …], color, title, dash, fill }]
    setPolygons(list) {
      if (!map) return;
      const keep = new Set();
      for (const z of list) {
        keep.add(z.key);
        let pg = polys.get(z.key);
        const style = { color: z.color || '#d1ad62', weight: z.weight ?? 2, fillOpacity: z.fill ?? 0.18, dashArray: z.dash || null, interactive: !!(z.title || z.popup) };
        // Con un popup (tocco sulla zona) niente tooltip: sul telefono si sovrapporrebbero.
        if (!pg) { pg = L.polygon(z.points, style).addTo(map); pg._zdgSig = JSON.stringify([z.points, style]); pg.on('click', () => onShapeTap?.(z.key)); if (z.popup) pg.bindPopup(z.popup, { maxWidth: 260 }); else if (z.title) pg.bindTooltip(z.title, { sticky: true }); polys.set(z.key, pg); }
        else {
          // Si ridisegna solo se la forma o lo stile sono cambiati davvero (niente sfarfallio a ogni aggiornamento).
          const sig = JSON.stringify([z.points, style]);
          if (pg._zdgSig !== sig) { pg.setLatLngs(z.points); pg.setStyle(style); pg._zdgSig = sig; }
          if (z.popup) { if (!pg.getPopup()) pg.bindPopup(z.popup, { maxWidth: 260 }); else if (pg._zdgPop !== z.popup) pg.setPopupContent(z.popup); pg._zdgPop = z.popup; } else if (z.title && pg._zdgTip !== z.title) { pg.setTooltipContent(z.title); pg._zdgTip = z.title; } }
      }
      for (const [k, pg] of polys) if (!keep.has(k)) { pg.remove(); polys.delete(k); }
      // Etichetta di una zona (es. conto alla rovescia): z.badge è HTML. badgeEdge: sul lato visibile, inclinata come
      // il lato; se no fissa al centro.
      for (const z of list) {
        let e = edgeBadges.get(z.key);
        if (!z.badge || !z.badgeEdge) { if (e) { e.marker.remove(); edgeBadges.delete(z.key); } }
        else {
          if (!e) {
            const marker = L.marker(z.points[0], { interactive: false, keyboard: false, zIndexOffset: 5000,
              icon: L.divIcon({ className: 'zone-edge', html: `<div class="zone-badge zone-edge-badge">${z.badge}</div>`, iconSize: [0, 0] }) }).addTo(map);
            e = { marker, html: z.badge };
            edgeBadges.set(z.key, e);
          } else if (e.html !== z.badge) {
            e.marker.setIcon(L.divIcon({ className: 'zone-edge', html: `<div class="zone-badge zone-edge-badge">${z.badge}</div>`, iconSize: [0, 0] }));
            e.html = z.badge;
          }
          e.points = z.points;
          placeEdge(e);
        }
        let b = badges.get(z.key);
        if (!z.badge || z.badgeEdge) { if (b) { b.remove(); badges.delete(z.key); } continue; }
        const at = polys.get(z.key)?.getCenter();
        if (!at) continue;
        if (!b) { b = L.tooltip({ permanent: true, direction: 'center', className: 'zone-badge', interactive: false }).setLatLng(at).setContent(z.badge).addTo(map); badges.set(z.key, b); }
        else { b.setLatLng(at); if (b._zdgHtml !== z.badge) b.setContent(z.badge); }
        b._zdgHtml = z.badge;
      }
      for (const [k, b] of badges) if (!keep.has(k)) { b.remove(); badges.delete(k); }
      for (const [k, e] of edgeBadges) if (!keep.has(k)) { e.marker.remove(); edgeBadges.delete(k); }
    },
    // Centra su tutti i segnaposto (e sulla mia posizione).
    fit() {
      if (!map) return;
      const pts = [...markers.values()].map((m) => m.getLatLng());
      // La mia posizione conta solo se è un GPS vero (non una stima di rete a chilometri di distanza).
      if (me && (meAcc == null || meAcc <= 300)) pts.push(me.getLatLng());
      if (pts.length === 1) map.setView(pts[0], 16);
      else if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 17 });
    },
    setMe(pos) {
      if (!map) return;
      if (pos) { lastPos = pos; trackMove(pos); gpsHeading(pos); }
      if (!pos) { me?.remove(); meCircle?.remove(); me = null; meCircle = null; return; }
      const ll = [pos.lat, pos.lng];
      const first = !me || (meAcc > 300 && pos.acc <= 300);
      meAcc = pos.acc ?? null;
      if (!me) {
        me = L.marker(ll, { icon: L.divIcon({ className: 'zdg-pin', html: pinHtml({ kind: 'me' }), iconSize: [22, 22], iconAnchor: [11, 11] }), zIndexOffset: 10000, title: 'Voi' }).addTo(map);
        meCircle = L.circle(ll, { radius: pos.acc || 10, color: '#3b82f6', weight: 1, fillOpacity: 0.12 }).addTo(map);
      } else {
        me.setLatLng(ll);
        meCircle.setLatLng(ll).setRadius(pos.acc || 10);
      }
      paintMe();
      if ((first || outOfView(me.getLatLng())) && (meAcc == null || meAcc <= 300)) autoFit();
      if (navKey) navDraw();
    },
    // Naviga verso un segnaposto (per chiave) o smetti (null).
    navigate(key) { if (key) navStart(key); else navStop(); },
    get navigating() { return navKey; },
    // "Dove siamo": scelta esplicita, la centratura automatica si ferma fino alla prossima apertura.
    // Centra su un punto qualsiasi (es. il bersaglio di un incarico): la centratura automatica si ferma.
    centerOn(lat, lng, zoom = 17) { if (!map) return; auto = false; focusAt = Date.now(); clearTimeout(fitTimer); map.setView([lat, lng], Math.max(map.getZoom(), zoom)); },
    // Senza zoom: sposta solo la mappa con il pallino al centro, lo zoom resta com'è.
    centerMe(zoom = null) { if (map && me) { auto = false; if (zoom == null) map.panTo(me.getLatLng()); else map.setView(me.getLatLng(), Math.max(map.getZoom(), zoom)); } },
    onTap(fn) { onTap = fn; },
    onMarkerTap(fn) { onMarkerTap = fn; },
    // Tocco su una zona (poligono con titolo o popup): riceve la sua chiave.
    onShapeTap(fn) { onShapeTap = fn; },
    // Da chiamare dopo che l'elemento è stato riagganciato alla pagina.
    refresh() { if (map) setTimeout(() => { map.invalidateSize(); autoFit(); }, 30); },
    resize() { if (map) map.invalidateSize(); },
    // Inquadra alcuni segnaposto (per chiave) insieme alla mia posizione; la centratura automatica si ferma.
    focus(keys) {
      if (!map) return false;
      const pts = keys.map((k) => (markers.get(k) || circles.get(k))?.getLatLng()).filter(Boolean);
      if (!pts.length) return false;
      auto = false;
      focusAt = Date.now();
      clearTimeout(fitTimer);
      if (me && (meAcc == null || meAcc <= 300)) pts.push(me.getLatLng());
      if (pts.length === 1) map.setView(pts[0], 17);
      else map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 18 });
      return true;
    },
    // Mette in evidenza un segnaposto o una zona (per chiave): centra la mappa, lo porta sopra a tutto e apre il suo popup.
    highlight(key) {
      if (!map) return false;
      const m = markers.get(key);
      const pg = polys.get(key);
      if (!m && !pg) return false;
      auto = false;
      focusAt = Date.now();
      clearTimeout(fitTimer);
      if (hi && hi !== m) { hi.setZIndexOffset(hi._zdgZ || 0); hi.getElement()?.classList.remove('zdg-hi'); }
      hi = null;
      if (m) {
        hi = m;
        m.setZIndexOffset(20000);
        map.setView(m.getLatLng(), Math.max(map.getZoom(), 17));
        m.getElement()?.classList.add('zdg-hi');
        if (m.getPopup()) m.openPopup();
        return true;
      }
      pg.bringToFront();
      map.fitBounds(pg.getBounds().pad(0.15), { maxZoom: 18 });
      const w = pg.options.weight;
      pg.setStyle({ weight: 6 });
      setTimeout(() => pg.setStyle({ weight: w }), 1600);
      if (pg.getTooltip()) pg.openTooltip(pg.getCenter());
      return true;
    },
    // Riattiva la centratura automatica (es. dopo "Tutto il campo").
    autoCenter() { auto = true; view.fit(); },
  };
  return view;
}

// Precisione: oltre SEND_MAX_ACC la posizione viene dalla rete (non dal GPS) e non va mandata alla regia;
// oltre PLACE_MAX_ACC non basta per piazzare un punto (si tocca la mappa).
export const SEND_MAX_ACC = 300;
export const PLACE_MAX_ACC = 50;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
export function accuracyHint(acc) {
  if (acc == null || acc <= PLACE_MAX_ACC) return null;
  if (acc <= SEND_MAX_ACC) return 'GPS ancora impreciso: restate all\'aperto qualche secondo.';
  return isIOS()
    ? 'Posizione approssimativa (non è il GPS): Impostazioni → Privacy → Localizzazione → Siti web di Safari → attiva "Posizione esatta", poi andate all\'aperto.'
    : 'Posizione approssimativa (non è il GPS): attivate la Posizione del telefono e, per Chrome, "Usa posizione precisa" (Impostazioni → App → Chrome → Autorizzazioni → Posizione), poi andate all\'aperto.';
}

// Posizione continua dal telefono (solo in contesto sicuro). Restituisce stop().
export function watchPosition(onPos, onError) {
  if (!window.isSecureContext || !navigator.geolocation) {
    onError?.(window.isSecureContext ? 'Posizione non disponibile su questo dispositivo' : 'La posizione è disponibile solo con l\'indirizzo https del Consiglio');
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (p) => onPos({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy), at: p.timestamp, heading: Number.isFinite(p.coords.heading) ? p.coords.heading : null, speed: Number.isFinite(p.coords.speed) ? p.coords.speed : null }),
    (e) => onError?.(e.code === 1 ? 'Permesso di posizione negato: consentilo dalle impostazioni del browser' : 'Posizione non disponibile: andate all\'aperto e riprovate'),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

// Icona dei luoghi del gioco: Soglia, Base degli Eletti, Cerchio di inizio.
export const landmarkIcon = (kind) => (kind === 'soglia' ? '⛩' : kind === 'base' ? '⌂' : '◯');

// Mine traccianti degli Eletti (le vede solo il Consiglio): segnaposto e cerchio del raggio.
export function mineItems(mines = [], popupExtra = () => '') {
  const now = Date.now();
  return mines.map((m) => {
    const marked = m.markUntil && m.markUntil > now;
    const state = m.triggeredAt ? (marked ? 'marked' : 'spent') : 'armed';
    const t = new Date(m.placedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    const until = marked ? new Date(m.markUntil).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '';
    return { key: `mine${m.id}`, kind: 'mine', state, lat: m.lat, lng: m.lng, title: 'Mina tracciante',
      popup: `<strong>💣 Mina tracciante</strong><br>${esc(m.author || 'Eletti')} · posata alle ${t} · raggio ${m.radius} m${m.triggeredAt ? `<br><b>Scattata</b>${m.team ? `: ${esc(m.team.roman)} · Settore ${esc(m.team.sectorName)}` : ''}${marked ? ` · marcata fino alle ${until}` : ''}` : '<br>Armata'}${popupExtra(m)}` };
  });
}
export const mineCircles = (mines = []) => mines.filter((m) => !m.triggeredAt).map((m) => ({ key: `minec${m.id}`, lat: m.lat, lng: m.lng, radius: m.radius, color: '#d1ad62', fill: 0.08, weight: 1, dash: '3 5', interactive: false }));

// Soglia, Cerchio di inizio e Base degli Eletti.
export function landmarkItem(l, popupExtra = '') {
  return { key: `l${l.id}`, kind: 'place', place: l.kind, lat: l.lat, lng: l.lng, title: l.label, provisional: l.provisional, popup: `<strong>${esc(l.label)}</strong>${l.provisional ? '<br>⚠ Provvisorio' : ''}${popupExtra}` };
}

// I telefoni della stessa coppia vicini tra loro (entro 30 m) diventano un solo pallino; se si allontanano, due.
export const PAIR_MERGE_M = 30;
const distM = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180));
export function groupPositions(list) {
  const out = [];
  const byTeam = new Map();
  for (const p of list) {
    if (p.kind !== 'team') { out.push(p); continue; }
    (byTeam.get(p.teamId) || byTeam.set(p.teamId, []).get(p.teamId)).push(p);
  }
  for (const devs of byTeam.values()) {
    // Raggruppa i telefoni entro 30 m l'uno dall'altro.
    const groups = [];
    for (const p of devs) {
      const g = groups.find((gr) => gr.every((x) => distM(x, p) <= PAIR_MERGE_M));
      if (g) g.push(p); else groups.push([p]);
    }
    for (const g of groups) {
      if (g.length === 1) { out.push(g[0]); continue; }
      const lat = g.reduce((s, x) => s + x.lat, 0) / g.length;
      const lng = g.reduce((s, x) => s + x.lng, 0) / g.length;
      out.push({ ...g[0], deviceId: g.map((x) => x.deviceId).sort().join('+'), lat, lng, acc: Math.max(...g.map((x) => x.acc || 0)) || null,
        at: Math.max(...g.map((x) => x.at)), stale: g.every((x) => x.stale), who: g.map((x) => x.who).join(' e '), together: g.length });
    }
  }
  return out;
}

// Telefono → segnaposto per la mappa (popup con chi è e da quanto non si aggiorna).
export function positionItem(p) {
  const ago = Math.max(0, Math.round((Date.now() - p.at) / 60000));
  return {
    key: `pos-${p.deviceId}`, kind: p.kind, lat: p.lat, lng: p.lng, stale: p.stale, color: p.color, blocked: p.blocked,
    note: p.blocked ? 'non può essere mostrata' : p.frozen ? 'ultima posizione' : p.mine ? '💣 marcata' : null,
    text: p.kind === 'team' ? p.roman || '?' : p.label || '?', title: p.label,
    // Popup: chi è, le persone della coppia (o della squadra di Eletti) e da quando è ferma la posizione.
    popup: `<strong>${esc(p.label)}</strong><br>${esc(p.who)}${p.together ? '<br><small>insieme (entro 30 m)</small>' : ''}${p.members?.length ? `<div class="pop-members"><small>${p.kind === 'team' ? 'Coppia' : 'Squadra'}:</small> ${p.members.map(esc).join(', ')}</div>` : ''}<small>${ago ? `${ago} min fa` : 'adesso'}${p.acc ? ` · ±${p.acc} m` : ''}</small>`,
  };
}
