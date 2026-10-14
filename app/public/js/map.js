// Mappe OpenTopoMap (Leaflet servito localmente). Una vista persiste tra i ridisegni della pagina:
// l'elemento della mappa viene riagganciato, i segnaposto si aggiornano senza ricreare la mappa.

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

const TILES = 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = 'Mappa © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>, SRTM · Stile © <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA)';
const ITALY = [42.5, 12.5];

export const PERSON_TEAM = '#ff4fa3';
export const PERSON_ELECT = '#d1ad62';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Segnaposto: Altare (quadrato con numero romano), Dono (cerchio con icona), io (punto blu).
export function pinHtml(item) {
  if (item.kind === 'altar') return `<span class="pin pin-altar ${item.mine ? 'pin-mine' : ''}">${esc(item.text)}</span>`;
  if (item.kind === 'place') return `<span class="pin pin-place pin-${esc(item.place)}">${item.place === 'soglia' ? '⛩' : '◯'}</span>`;
  if (item.kind === 'target') return '<span class="pin pin-target">⌖</span>';
  if (item.kind === 'gift') return `<span class="pin pin-gift pin-${item.state}" style="--c:${esc(item.color || '#d1ad62')}">${esc(item.text || '✦')}</span>`;
  // Persone (telefoni di coppie ed Eletti): solo un pallino colorato, per non confonderle con i punti del gioco.
  // Coppie magenta, Eletti del colore della squadra; chi è, lo dice il popup.
  if (item.kind === 'team' || item.kind === 'elect') return `<span class="dot-wrap"><span class="pin-dot ${item.stale ? 'pin-stale' : ''}" style="--c:${esc(item.color || (item.kind === 'team' ? PERSON_TEAM : PERSON_ELECT))}"></span></span>`;
  return '<span class="pin pin-me"></span>';
}

export function createMapView({ className = '' } = {}) {
  const el = document.createElement('div');
  el.className = `zdg-map ${className}`;
  const markers = new Map();
  let map = null;
  let L = null;
  let fitted = false;
  let me = null;
  let meCircle = null;
  let onTap = null;
  let pending = null;

  const ready = loadLeaflet().then((lib) => {
    L = lib;
    map = L.map(el, { zoomControl: true, attributionControl: true }).setView(ITALY, 6);
    L.tileLayer(TILES, { maxZoom: 17, subdomains: 'abc', attribution: ATTRIBUTION, crossOrigin: true }).addTo(map);
    map.on('click', (e) => onTap?.(e.latlng));
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
      for (const it of items) {
        if (it.lat == null || it.lng == null) continue;
        keep.add(it.key);
        const html = pinHtml(it);
        let m = markers.get(it.key);
        if (!m) {
          m = L.marker([it.lat, it.lng], { icon: L.divIcon({ className: 'zdg-pin', html, iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -16] }), title: it.title || '' }).addTo(map);
          m._zdgHtml = html;
          markers.set(it.key, m);
        } else {
          m.setLatLng([it.lat, it.lng]);
          if (m._zdgHtml !== html) { m.setIcon(L.divIcon({ className: 'zdg-pin', html, iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -16] })); m._zdgHtml = html; }
        }
        if (it.popup) { if (m.getPopup()) m.setPopupContent(it.popup); else m.bindPopup(it.popup, { maxWidth: 260 }); }
      }
      for (const [k, m] of markers) if (!keep.has(k)) { m.remove(); markers.delete(k); }
      if (!fitted && keep.size) { view.fit(); fitted = true; }
    },
    // Centra su tutti i segnaposto (e sulla mia posizione).
    fit() {
      if (!map) return;
      const pts = [...markers.values()].map((m) => m.getLatLng());
      if (me) pts.push(me.getLatLng());
      if (pts.length === 1) map.setView(pts[0], 16);
      else if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 17 });
    },
    setMe(pos) {
      if (!map) return;
      if (!pos) { me?.remove(); meCircle?.remove(); me = null; meCircle = null; return; }
      const ll = [pos.lat, pos.lng];
      if (!me) {
        me = L.marker(ll, { icon: L.divIcon({ className: 'zdg-pin', html: pinHtml({ kind: 'me' }), iconSize: [22, 22], iconAnchor: [11, 11] }), zIndexOffset: 1000, title: 'Voi' }).addTo(map);
        meCircle = L.circle(ll, { radius: pos.acc || 10, color: '#3b82f6', weight: 1, fillOpacity: 0.12 }).addTo(map);
      } else {
        me.setLatLng(ll);
        meCircle.setLatLng(ll).setRadius(pos.acc || 10);
      }
    },
    centerMe(zoom = 17) { if (map && me) map.setView(me.getLatLng(), Math.max(map.getZoom(), zoom)); },
    onTap(fn) { onTap = fn; },
    // Da chiamare dopo che l'elemento è stato riagganciato alla pagina.
    refresh() { if (map) setTimeout(() => map.invalidateSize(), 30); },
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
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

// Soglia e Cerchio di inizio.
export function landmarkItem(l, popupExtra = '') {
  return { key: `l${l.id}`, kind: 'place', place: l.kind, lat: l.lat, lng: l.lng, title: l.label, popup: `<strong>${esc(l.label)}</strong>${popupExtra}` };
}

// Telefono → segnaposto per la mappa (popup con chi è e da quanto non si aggiorna).
export function positionItem(p) {
  const ago = Math.max(0, Math.round((Date.now() - p.at) / 60000));
  return {
    key: `pos-${p.deviceId}`, kind: p.kind, lat: p.lat, lng: p.lng, stale: p.stale, color: p.color,
    text: p.kind === 'team' ? p.roman || '?' : (p.label || '?').slice(0, 2).toUpperCase(), title: p.label,
    popup: `<strong>${esc(p.label)}</strong><br>${esc(p.who)}<br><small>${ago ? `${ago} min fa` : 'adesso'}${p.acc ? ` · ±${p.acc} m` : ''}</small>`,
  };
}
