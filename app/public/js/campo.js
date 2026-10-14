// Strumento di campo per Eletti e Master: piazza Altari e Doni con foto e posizione del proprio telefono.
import { h, mount, api, fmtTime, toast, stream, store, scanQR, cameraSupported, vibrate, STATUS_LABELS } from './lib.js';
import { createMapView, watchPosition, positionItem } from './map.js';

const $root = document.getElementById('root');
const F = {
  who: null,
  gameId: store.get('zdg_campo_game'),
  data: null,
  tab: location.hash.slice(1) || 'incarichi',
  squadId: null,
  me: null, // ultima posizione nota { lat, lng, acc, at }
  geoError: null,
};
const mapView = createMapView({ className: 'campo-map' });
let stopWatch = null;

window.addEventListener('hashchange', () => { F.tab = location.hash.slice(1) || 'incarichi'; render(); });

(async function boot() {
  try {
    F.who = await api('GET', '/api/field/whoami');
  } catch {
    return mount($root, viewLogin());
  }
  if (F.who.role === 'elect') F.gameId = F.who.gameId;
  // Squadra: quella dell'Eletto entrato col codice personale, altrimenti la scelta fatta su questo telefono.
  F.squadId = F.who.squad?.id || store.get('zdg_campo_squad') || null;
  if (!F.who.games.some((g) => g.id === F.gameId)) F.gameId = F.who.games[0]?.id || null;
  store.set('zdg_campo_game', F.gameId);
  stream(F.who.role === 'master' ? '/api/stream?as=staff' : '/api/stream', {
    refresh: (d) => { if (d.gameId === F.gameId) load(); },
    state: () => load(),
    open: () => load(),
  });
  startGps();
  await load();
})();

function startGps() {
  stopWatch?.();
  stopWatch = watchPosition((pos) => {
    F.me = pos;
    sendPosition(pos);
    F.geoError = null;
    mapView.setMe(pos);
    const el = document.getElementById('gps-now');
    if (el) el.textContent = gpsText();
  }, (msg) => { F.geoError = msg; const el = document.getElementById('gps-now'); if (el) el.textContent = msg; });
}

const gpsText = () => (F.me ? `GPS ± ${F.me.acc} m · ${fmtTime(F.me.at, true)}` : F.geoError || 'Ricerca della posizione…');

let loading = false;
async function load() {
  if (!F.gameId || loading) return render();
  loading = true;
  try {
    F.data = await api('GET', `/api/field/state?gameId=${F.gameId}`);
  } catch (e) { toast(e.message, 'error'); }
  loading = false;
  render();
}

// ---------------------------------------------------------------- render

function render() {
  if (!F.who) return;
  const d = F.data;
  const placedA = d ? d.points.filter((p) => p.lat != null).length : 0;
  const placedG = d ? d.gifts.filter((g) => g.status !== 'draft').length : 0;
  mount($root,
    h('header', { class: 'top campo-top' },
      h('a', { class: 'back', href: F.who.role === 'master' ? '/regia' : '/#/home', 'aria-label': 'Indietro' }, '‹'),
      h('div', { class: 'top-id' },
        h('div', { class: 'top-sector' }, 'Campo'),
        h('div', { class: 'top-sub' }, `${F.who.role === 'master' ? 'Regia' : 'Eletti'} · ${F.who.name}`)),
      F.who.role === 'master' && F.who.games.length > 1 ? h('select', { class: 'input campo-game', 'aria-label': 'Partita', onchange: (e) => { F.gameId = Number(e.target.value); store.set('zdg_campo_game', F.gameId); F.data = null; load(); } },
        F.who.games.map((g) => h('option', { value: g.id, selected: g.id === F.gameId }, g.name))) : null),
    h('main', { class: 'main campo' },
      !F.gameId ? h('p', { class: 'empty' }, 'Nessuna partita aperta.') : !d ? h('p', { class: 'empty' }, 'Caricamento…') : [
        h('div', { class: 'campo-head' },
          h('div', null, h('div', { class: 'eyebrow' }, `${d.game.name} · ${STATUS_LABELS[d.game.status]}`), h('div', { class: 'mono small', id: 'gps-now' }, gpsText())),
          h('button', { class: 'btn btn-primary btn-block btn-xl', onclick: scanSign }, '⌖ Scansiona un cartello'),
          cameraSupported() ? null : h('p', { class: 'muted small' }, 'Scanner e GPS richiedono l\'indirizzo https: scegli dall\'elenco e indica il punto toccando la mappa.')),
        h('nav', { class: 'seg-tabs' },
          tabLink('incarichi', 'Incarichi'),
          tabLink('altari', `Altari ${placedA}/${d.points.length}`),
          tabLink('doni', `Doni ${placedG}/${d.gifts.length}`),
          tabLink('mappa', 'Mappa')),
        F.tab === 'doni' ? viewGifts(d) : F.tab === 'mappa' ? (loadPositionsOnce(), viewMap(d)) : F.tab === 'altari' ? viewAltars(d) : viewTasks(d),
      ]));
  if (F.tab === 'mappa') { updateMap(d); mapView.refresh(); }
}

// Incarichi della squadra: Altari e Doni da piazzare assegnati dalla regia, incarichi liberi da spuntare.
function viewTasks(d) {
  const squads = d.squads || [];
  if (!squads.length) return h('p', { class: 'empty' }, 'La regia non ha ancora creato squadre di Eletti: usate le schede Altari e Doni.');
  const sq = squads.find((x) => x.id === F.squadId);
  const chooser = !F.who.squad ? h('label', { class: 'field' }, h('span', null, 'La tua squadra'),
    h('select', { class: 'input', onchange: (e) => { F.squadId = Number(e.target.value) || null; store.set('zdg_campo_squad', F.squadId); render(); } },
      h('option', { value: '' }, '— scegli —'), squads.map((x) => h('option', { value: x.id, selected: x.id === F.squadId }, x.name)))) : null;
  if (!sq) return h('div', { class: 'stack-sm' }, chooser, h('p', { class: 'empty' }, 'Scegli la tua squadra per vedere gli incarichi.'));
  const pts = d.points.filter((p) => p.squadId === sq.id);
  const gifts = d.gifts.filter((g) => g.squadId === sq.id && !['claimed', 'expired'].includes(g.status));
  const todo = [...pts.filter((p) => p.lat == null).map((p) => ({ kind: 'point', id: p.id, label: p.label })),
    ...gifts.filter((g) => g.status === 'draft').map((g) => ({ kind: 'gift', id: g.id, label: `${g.label} · ${g.name}` }))];
  const done = [...pts.filter((p) => p.lat != null).map((p) => p.label), ...gifts.filter((g) => g.status !== 'draft').map((g) => g.label)];
  const toggle = async (t) => {
    try {
      await api('POST', `/api/field/tasks/${t.id}/done?gameId=${F.gameId}`, { done: !t.doneAt, gameId: F.gameId });
      load();
    } catch (e) { toast(e.message, 'error'); }
  };
  return h('div', { class: 'stack-sm' },
    chooser,
    h('div', { class: 'squad-banner', style: { '--c': sq.color } }, h('strong', null, `Squadra ${sq.name}`), h('span', { class: 'small muted' }, sq.members.map((m) => m.nickname || m.name).join(' · '))),
    h('div', { class: 'eyebrow' }, `Da piazzare (${todo.length})`),
    todo.length ? h('ul', { class: 'campo-list' }, todo.map((t) => h('li', { class: 'campo-item task-item' },
      h('div', { class: 'campo-info' }, h('strong', null, t.label)),
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => openPlacement(t) }, 'Piazza')))) : h('p', { class: 'muted small' }, 'Niente da piazzare.'),
    h('div', { class: 'eyebrow' }, `Incarichi (${sq.tasks.filter((t) => !t.doneAt).length} da fare)`),
    sq.tasks.length ? h('ul', { class: 'campo-list' }, sq.tasks.map((t) => h('li', { class: `campo-item task-item ${t.doneAt ? 'done' : ''}` },
      h('div', { class: 'campo-info' }, h('strong', null, t.text), t.doneAt ? h('span', { class: 'tiny muted' }, `Fatto ${fmtTime(t.doneAt)} · ${(t.doneBy || '').replace('eletti:', '')}`) : null),
      h('button', { class: `btn btn-sm ${t.doneAt ? '' : 'btn-primary'}`, onclick: () => toggle(t) }, t.doneAt ? 'Riapri' : 'Fatto')))) : h('p', { class: 'muted small' }, 'Nessun incarico libero.'),
    done.length ? h('p', { class: 'small ok-text' }, `Già piazzati: ${done.join(', ')}`) : null);
}

let positionsLoaded = false;
function loadPositionsOnce() {
  if (positionsLoaded) return;
  positionsLoaded = true;
  api('GET', `/api/field/positions?gameId=${F.gameId}`).then((p) => { positions = p; updateMap(F.data); }).catch(() => {});
}

const tabLink = (id, label) => h('a', { href: `#${id}`, class: F.tab === id ? 'on' : '' }, label);

function placedLine(x) {
  if (x.lat == null) return h('span', { class: 'chip chip-warn' }, 'Da piazzare');
  return h('span', { class: 'chip chip-ok' }, `Piazzato ${fmtTime(x.placedAt)}${x.accuracy ? ` · ±${x.accuracy} m` : ''}${x.placeSource === 'manual' ? ' · manuale' : ''}`);
}

function viewAltars(d) {
  if (!d.points.length) return h('p', { class: 'empty' }, 'Nessun Altare: la regia deve prima formare le coppie e sincronizzare gli Altari.');
  return h('ul', { class: 'campo-list' }, d.points.map((p) => h('li', { class: `campo-item ${p.lat != null ? 'done' : ''}` },
    p.hasPhoto ? h('img', { class: 'campo-thumb', src: `/api/media/point/${p.id}?v=${p.placedAt}`, alt: `Foto di ${p.label}`, loading: 'lazy' }) : h('div', { class: 'campo-thumb empty-thumb' }, p.roman),
    h('div', { class: 'campo-info' },
      h('strong', null, p.label), h('div', { class: 'small muted' }, `Settore ${p.sectorName}${p.locationNote ? ` · ${p.locationNote}` : ''}`),
      placedLine(p), p.placedBy ? h('div', { class: 'tiny muted' }, `da ${p.placedBy}`) : null),
    h('button', { class: `btn btn-sm ${p.lat != null ? '' : 'btn-primary'}`, onclick: () => openPlacement({ kind: 'point', id: p.id, label: p.label }) }, p.lat != null ? 'Ripiazza' : 'Piazza'))));
}

const GIFT_STATE = { draft: 'Da piazzare', placed: 'Piazzato · non ancora comparso', revealed: 'Comparso in mappa', claimed: 'Preso', expired: 'Svanito (scaduto)' };

function viewGifts(d) {
  if (!d.gifts.length) return h('p', { class: 'empty' }, 'Nessun dono: la regia li crea nella sezione Doni QR e ne stampa i cartelli.');
  return h('ul', { class: 'campo-list' }, d.gifts.map((g) => h('li', { class: `campo-item gift-${g.status}` },
    g.hasPhoto ? h('img', { class: 'campo-thumb', src: `/api/media/gift/${g.id}?v=${g.placedAt}`, alt: `Foto di ${g.label}`, loading: 'lazy' }) : h('div', { class: 'campo-thumb empty-thumb', style: { color: g.color } }, g.icon),
    h('div', { class: 'campo-info' },
      h('strong', null, `${g.label} · `, h('span', { style: { color: g.color } }, `${g.icon} ${g.name}`)),
      h('span', { class: `chip ${g.status === 'draft' ? 'chip-warn' : g.status === 'revealed' ? 'chip-blood' : g.status === 'claimed' ? '' : 'chip-ok'}` },
        g.status === 'claimed' ? `Preso da ${g.claimedBy}` : GIFT_STATE[g.status]),
      g.lat != null ? h('div', { class: 'tiny muted' }, `Piazzato ${fmtTime(g.placedAt)}${g.accuracy ? ` · ±${g.accuracy} m` : ''} da ${g.placedBy}`) : null,
      g.expiresAfterMin && !['claimed', 'expired'].includes(g.status) ? h('div', { class: 'tiny muted' }, `Svanisce ${g.expiresAfterMin}′ dopo la comparsa`) : null,
      !['claimed', 'expired'].includes(g.status) ? h('div', { class: 'tiny muted' }, { manual: 'Compare quando lo decide la regia', onplace: 'Compare appena piazzato', time: `Compare a ${g.revealAtMin}′ dal via` }[g.revealMode]) : null),
    !['claimed', 'expired'].includes(g.status) ? h('button', { class: `btn btn-sm ${g.status === 'draft' ? 'btn-primary' : ''}`, onclick: () => openPlacement({ kind: 'gift', id: g.id, label: `${g.label} · ${g.name}` }) }, g.status === 'draft' ? 'Piazza e attiva' : 'Ripiazza') : null)));
}

function viewMap(d) {
  return h('div', { class: 'stack-sm' },
    mapView.el,
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn btn-sm', onclick: () => mapView.centerMe() }, '◎ La mia posizione'),
      h('button', { class: 'btn btn-sm', onclick: () => mapView.fit() }, 'Tutto il campo')),
    h('div', { class: 'map-legend' },
      h('span', null, h('span', { class: 'pin pin-altar' }, 'I'), ' Altare'),
      h('span', null, h('span', { class: 'pin pin-gift pin-hidden' }, '✦'), ' Dono non comparso'),
      h('span', null, h('span', { class: 'pin pin-gift pin-revealed', style: { '--c': '#d1ad62' } }, '✦'), ' Dono comparso'),
      h('span', null, h('span', { class: 'pin pin-me' }), ' Tu')),
    d.points.some((p) => p.lat == null) ? h('p', { class: 'muted small' }, `Altari ancora da piazzare: ${d.points.filter((p) => p.lat == null).map((p) => p.sectorName).join(', ')}`) : null);
}

// Gli Eletti condividono la posizione dalla preparazione (la regia la vede in mappa).
const deviceId = (() => {
  let id = store.get('zdg_device');
  if (!id) { id = `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`; store.set('zdg_device', id); }
  return id;
})();
let lastSent = 0;
function sendPosition(pos) {
  if (F.who?.role !== 'elect' || Date.now() - lastSent < 20000) return;
  lastSent = Date.now();
  api('POST', '/api/team/position', { deviceId, lat: pos.lat, lng: pos.lng, acc: pos.acc }).catch(() => { lastSent = 0; });
}

// Posizioni degli altri telefoni (regia: tutti; Eletti: gli Eletti), aggiornate ogni 15 secondi sulla mappa.
let positions = [];
setInterval(async () => {
  if (F.tab !== 'mappa' || !F.gameId) return;
  try { positions = await api('GET', `/api/field/positions?gameId=${F.gameId}`); updateMap(F.data); } catch { /* senza rete */ }
}, 15000);

function updateMap(d) {
  if (!d) return;
  mapView.setItems([
    ...positions.filter((p) => p.deviceId !== deviceId).map(positionItem),
    ...d.points.map((p) => ({ key: `p${p.id}`, kind: 'altar', lat: p.lat, lng: p.lng, text: p.roman, title: p.label,
      popup: `<strong>${p.label}</strong><br>Piazzato ${fmtTime(p.placedAt)} da ${p.placedBy || '?'}${p.accuracy ? ` · ±${p.accuracy} m` : ''}${p.hasPhoto ? `<img src="/api/media/point/${p.id}?v=${p.placedAt}" alt="">` : ''}` })),
    // Agli Eletti i doni presi o svaniti spariscono dalla mappa; la regia li vede ancora (barrati).
    ...d.gifts.filter((g) => F.who.role === 'master' || !['claimed', 'expired'].includes(g.status)).map((g) => ({ key: `g${g.id}`, kind: 'gift', lat: g.lat, lng: g.lng, text: g.icon, color: g.color,
      state: g.status === 'placed' ? 'hidden' : g.status, title: g.label,
      popup: `<strong>${g.label} · ${g.name}</strong><br>${GIFT_STATE[g.status]}${g.claimedBy ? ` da ${g.claimedBy}` : ''}${g.hasPhoto ? `<img src="/api/media/gift/${g.id}?v=${g.placedAt}" alt="">` : ''}` })),
  ]);
  if (F.me) mapView.setMe(F.me);
}

// ---------------------------------------------------------------- scansione del cartello

async function scanSign() {
  const text = await scanQR({
    title: 'Scansiona il cartello',
    hint: 'Inquadra il QR dell\'Altare o del Dono che stai piazzando.',
    accept: (t) => (/\/(a|d)\/[\w-]+/.test(t) ? true : 'Questo QR non è un Altare né un Dono'),
  });
  if (!text) return;
  try {
    const r = await api('GET', `/api/field/resolve?gameId=${F.gameId}&text=${encodeURIComponent(text)}`);
    const item = r.kind === 'gift' ? F.data.gifts.find((g) => g.id === r.id) : null;
    openPlacement({ kind: r.kind, id: r.id, label: item ? `${item.label} · ${item.name}` : r.label });
  } catch (e) { toast(e.message, 'error', 6000); }
}

// ---------------------------------------------------------------- piazzamento: posizione + foto + conferma

// Ridimensiona la foto (max 1600 px) in JPEG: caricamento veloce anche con poco segnale.
async function compressPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.82));
  } finally { URL.revokeObjectURL(url); }
}

function openPlacement(target) {
  const sheetMap = createMapView({ className: 'sheet-map' });
  let manual = null; // posizione scelta toccando la mappa
  let photo = null;
  const posLine = h('div', { class: 'mono small' });
  const photoPreview = h('div', { class: 'photo-preview' }, h('span', { class: 'muted' }, 'Nessuna foto'));
  const confirmBtn = h('button', { class: 'btn btn-primary btn-xl btn-block', type: 'button', disabled: true }, 'Conferma piazzamento');
  const position = () => manual || F.me;
  const sync = () => {
    const p = position();
    posLine.textContent = manual ? `Punto scelto sulla mappa (${manual.lat.toFixed(5)}, ${manual.lng.toFixed(5)})` : p ? `GPS: ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} · ± ${p.acc} m` : (F.geoError || 'Ricerca della posizione GPS…');
    posLine.className = `mono small ${p && (manual || p.acc <= 30) ? 'ok-text' : 'bad-text'}`;
    confirmBtn.disabled = !(p && photo);
    if (p) sheetMap.setMe(p);
  };
  const tick = setInterval(sync, 1000);
  sheetMap.ready.then(() => {
    sheetMap.onTap((ll) => { manual = { lat: ll.lat, lng: ll.lng, acc: null }; sync(); sheetMap.centerMe(); vibrate(30); });
    if (F.me) { sheetMap.setMe(F.me); sheetMap.centerMe(17); }
    sheetMap.refresh();
  });
  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'sr-only', id: 'place-photo', onchange: async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      photo = await compressPhoto(f);
      const url = URL.createObjectURL(photo);
      mount(photoPreview, h('img', { src: url, alt: 'Foto del piazzamento' }));
      sync();
    } catch { toast('Foto non leggibile, riprova', 'error'); }
  } });
  const close = () => { clearInterval(tick); sheet.remove(); document.body.classList.remove('no-scroll'); };
  confirmBtn.addEventListener('click', async () => {
    const p = position();
    if (!p || !photo) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Invio in corso…';
    const qs = new URLSearchParams({ gameId: F.gameId, lat: p.lat, lng: p.lng, acc: p.acc ?? '', source: manual ? 'manual' : 'gps' });
    try {
      const res = await fetch(`/api/field/${target.kind === 'gift' ? 'gifts' : 'points'}/${target.id}/place?${qs}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: photo, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Errore ${res.status}`);
      vibrate([80, 60, 200]);
      toast(target.kind === 'gift' ? `${data.label} piazzato${data.revealed ? ' e comparso in mappa' : ''}` : `${data.label} piazzato`, 'ok', 6000);
      close();
      load();
    } catch (e) {
      toast(e.message.includes('Failed to fetch') ? 'Nessuna rete: riprova appena c\'è segnale' : e.message, 'error', 7000);
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Conferma piazzamento';
    }
  });
  const sheet = h('div', { class: 'place-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Piazza ${target.label}` },
    h('div', { class: 'place-head' }, h('div', null, h('div', { class: 'eyebrow' }, target.kind === 'gift' ? 'Piazza e attiva il dono' : 'Piazza l\'Altare'), h('h2', null, target.label)),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: close }, 'Annulla')),
    h('section', { class: 'place-step' },
      h('div', { class: 'step-title' }, h('span', { class: 'step-n' }, '1'), 'Posizione'),
      h('p', { class: 'muted small' }, 'Mettiti accanto al cartello: l\'app usa il GPS di questo telefono. Se il GPS non c\'è o è impreciso, tocca il punto esatto sulla mappa.'),
      posLine, sheetMap.el),
    h('section', { class: 'place-step' },
      h('div', { class: 'step-title' }, h('span', { class: 'step-n' }, '2'), 'Foto del piazzamento'),
      h('label', { class: 'btn btn-block', for: 'place-photo' }, '📷 Scatta la foto'), fileInput, photoPreview),
    h('section', { class: 'place-step' }, confirmBtn));
  document.body.append(sheet);
  document.body.classList.add('no-scroll');
  sync();
}

// ---------------------------------------------------------------- accesso

function viewLogin() {
  return h('main', { class: 'login' },
    h('div', { class: 'emblem big' }, h('span', null, '0')),
    h('h1', null, 'Campo'),
    h('p', { class: 'muted' }, 'Strumento di piazzamento di Altari e Doni, riservato alla regia e agli Eletti del Consiglio.'),
    h('a', { class: 'btn btn-primary btn-xl btn-block', href: '/' }, 'Sono un Eletto: entra nell\'app'),
    h('a', { class: 'btn btn-block', href: '/regia' }, 'Sono la regia: accedi'),
    h('p', { class: 'muted small' }, 'Dopo l\'accesso torna su questa pagina.'));
}
