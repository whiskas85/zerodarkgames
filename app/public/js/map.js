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
    s.onload = () => resolve(window.L);
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
  if (item.kind === 'place') return `<span class="pin pin-place pin-${esc(item.place)}">${item.place === 'soglia' ? '⛩' : '◯'}</span>`;
  if (item.kind === 'target') return '<span class="pin pin-target">⌖</span>';
  // Emergenza reale: segnaposto rosso che pulsa (grigio se chiusa).
  if (item.kind === 'emergency') return `<span class="pin-sos ${item.state || ''}">${esc(item.text || '!')}</span>`;
  if (item.kind === 'poi') return '<span class="pin pin-poi"><span>◆</span></span>';
  if (item.kind === 'event') return `<span class="pin pin-event">${mdiSvg('flagCheckered', 18)}</span>`;
  if (item.kind === 'guide') return `<span class="pin pin-guide">${mdiSvg(item.icon, 18)}</span>`;
  if (item.kind === 'gift') return `<span class="pin pin-gift pin-${item.state}" style="--c:${esc(item.color || '#d1ad62')}">${esc(item.text || '✦')}</span>`;
  // Persone (telefoni di coppie ed Eletti): solo un pallino colorato, per non confonderle con i punti del gioco.
  // Coppie magenta, Eletti del colore della squadra; chi è, lo dice il popup.
  // Coppie: il pallino porta il numero romano del Settore.
  if (item.kind === 'team' && item.text) return `<span class="dot-wrap"><span class="pin-dot pin-dot-num ${item.stale ? 'pin-stale' : ''} ${isLight(item.color || PERSON_TEAM) ? 'on-light' : ''}" style="--c:${esc(item.color || PERSON_TEAM)}">${esc(item.text)}</span></span>`;
  if (item.kind === 'team' || item.kind === 'elect') return `<span class="dot-wrap"><span class="pin-dot ${item.stale ? 'pin-stale' : ''}" style="--c:${esc(item.color || (item.kind === 'team' ? PERSON_TEAM : PERSON_ELECT))}"></span></span>`;
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

// remember: chiave per ricordare zoom e posizione della mappa tra un'apertura e l'altra (e tra una sessione e l'altra).
// Con una vista ricordata, all'apertura la mappa si centra sul puntatore (la vostra posizione) tenendo lo zoom;
// senza puntatore resta dov'era. La prima volta in assoluto inquadra tutto come sempre.
export function createMapView({ className = '', remember = null } = {}) {
  const viewKey = remember ? `zdg_mapview_${remember}` : null;
  const savedView = (() => { try { const v = viewKey && JSON.parse(localStorage.getItem(viewKey) || 'null'); return v && Number.isFinite(v.lat) && Number.isFinite(v.lng) && Number.isFinite(v.z) ? v : null; } catch { return null; } })();
  const el = document.createElement('div');
  el.className = `zdg-map ${className}`;
  const markers = new Map();
  const lines = new Map();
  const circles = new Map();
  const polys = new Map();
  const badges = new Map();
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
      // Vista ricordata: sul puntatore con lo zoom di adesso, se c'è (e il GPS è vero); se no la mappa resta com'è.
      if (savedView) { if (me && (meAcc == null || meAcc <= 300)) map.setView(me.getLatLng(), map.getZoom()); return; }
      view.fit();
    }, 250);
  };
  const outOfView = (ll) => map && !map.getBounds().pad(-0.05).contains(ll);
  for (const ev of ['pointerdown', 'wheel', 'touchstart']) el.addEventListener(ev, () => { auto = false; }, { passive: true });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting && map) { auto = true; map.invalidateSize(); autoFit(); }
    }).observe(el);
  }

  const ready = loadLeaflet().then((lib) => {
    L = lib;
    map = L.map(el, { zoomControl: true, attributionControl: true }).setView(savedView ? [savedView.lat, savedView.lng] : ITALY, savedView ? savedView.z : 6);
    if (savedView) fitted = true;
    if (viewKey) map.on('moveend', () => { const c = map.getCenter(); try { localStorage.setItem(viewKey, JSON.stringify({ lat: c.lat, lng: c.lng, z: map.getZoom() })); } catch { /* */ } });
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
          markers.set(it.key, m);
          changed = true;
        } else {
          m.setLatLng([it.lat, it.lng]);
          if (outOfView(m.getLatLng())) changed = true;
          if (m._zdgHtml !== html) { m.setIcon(L.divIcon({ className: 'zdg-pin', html, iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -16] })); m._zdgHtml = html; }
        }
        if (it.popup) { if (m.getPopup()) m.setPopupContent(it.popup); else m.bindPopup(it.popup, { maxWidth: 260 }); }
      }
      for (const [k, m] of markers) if (!keep.has(k)) { m.remove(); markers.delete(k); changed = true; }
      if (!fitted && keep.size) { view.fit(); fitted = true; } else if (changed) autoFit();
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
        if (!pg) { pg = L.polygon(z.points, style).addTo(map); pg.on('click', () => onShapeTap?.(z.key)); if (z.popup) pg.bindPopup(z.popup, { maxWidth: 260 }); else if (z.title) pg.bindTooltip(z.title, { sticky: true }); polys.set(z.key, pg); }
        else { pg.setLatLngs(z.points); pg.setStyle(style); if (z.popup) { if (pg.getPopup()) pg.setPopupContent(z.popup); else pg.bindPopup(z.popup, { maxWidth: 260 }); } else if (z.title) pg.setTooltipContent(z.title); }
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
      if ((first || outOfView(me.getLatLng())) && (meAcc == null || meAcc <= 300)) autoFit();
    },
    // "Dove siamo": scelta esplicita, la centratura automatica si ferma fino alla prossima apertura.
    centerMe(zoom = 17) { if (map && me) { auto = false; map.setView(me.getLatLng(), Math.max(map.getZoom(), zoom)); } },
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
    (p) => onPos({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy), at: p.timestamp }),
    (e) => onError?.(e.code === 1 ? 'Permesso di posizione negato: consentilo dalle impostazioni del browser' : 'Posizione non disponibile: andate all\'aperto e riprovate'),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

// Soglia e Cerchio di inizio.
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
    key: `pos-${p.deviceId}`, kind: p.kind, lat: p.lat, lng: p.lng, stale: p.stale, color: p.color,
    text: p.kind === 'team' ? p.roman || '?' : (p.label || '?').slice(0, 2).toUpperCase(), title: p.label,
    popup: `<strong>${esc(p.label)}</strong><br>${esc(p.who)}${p.together ? '<br><small>insieme (entro 30 m)</small>' : ''}<br><small>${ago ? `${ago} min fa` : 'adesso'}${p.acc ? ` · ±${p.acc} m` : ''}</small>`,
  };
}
