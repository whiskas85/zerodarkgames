// Lavoro sul campo (Altari e Doni da piazzare, incarichi delle squadre, mappa del campo).
// Usato dall'app degli Eletti (dentro la loro app) e dallo strumento di campo della regia (/campo).
import { h, mount, api, fmtTime, toast, store, scanQR, vibrate } from './lib.js';
import { createMapView, watchPosition, positionItem, landmarkItem, accuracyHint, PLACE_MAX_ACC } from './map.js';

const GIFT_STATE = { draft: 'Da piazzare', placed: 'Piazzato · non ancora annunciato', revealed: 'Annunciato: in mappa alle coppie', claimed: 'Preso', expired: 'Svanito (scaduto)' };

// Distanza approssimata in metri.
export const meters = (a, b) => Math.round(Math.hypot((a.lat - b.lat) * 111320, (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180)));
const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);

// Quando la regia ha programmato l'annuncio del dono.
export function revealText(g) {
  if (g.revealMode === 'at' && g.revealAt) return `Annuncio alle ${fmtTime(g.revealAt)}`;
  if (g.revealMode === 'onplace') return 'Annunciato appena piazzato';
  if (g.revealMode === 'time') return `Annuncio a ${g.revealAtMin}′ dal via`;
  return 'Annuncio quando lo decide la regia';
}

// Un Altare o un Dono da piazzare (o da spostare) per una squadra.
export const isPending = (x, kind) => (kind !== 'gift'
  ? x.lat == null || !!x.moveRequestedAt
  : !['claimed', 'expired'].includes(x.status) && (x.status === 'draft' || !!x.moveRequestedAt));

/**
 * F: { who: { role, squad }, gameId, squadId, data, me, geoError }
 * rerender(): ridisegna la pagina che ospita le viste.
 */
export function createField(F, { rerender }) {
  const mapView = createMapView({ className: 'campo-map' });
  let stopWatch = null;
  let positions = [];
  let mapOn = false;
  let loading = false;

  const gpsText = () => (F.me ? `GPS ± ${F.me.acc} m · ${fmtTime(F.me.at, true)}${accuracyHint(F.me.acc) ? ` · ${accuracyHint(F.me.acc)}` : ''}` : F.geoError || 'Ricerca della posizione…');

  function startGps() {
    if (stopWatch) return;
    stopWatch = watchPosition((pos) => {
      F.me = pos;
      F.geoError = null;
      mapView.setMe(pos);
      const el = document.getElementById('gps-now');
      if (el) el.textContent = gpsText();
    }, (msg) => { F.geoError = msg; const el = document.getElementById('gps-now'); if (el) el.textContent = msg; });
  }
  function stopGps() { stopWatch?.(); stopWatch = null; }

  async function load() {
    if (!F.gameId || loading) return;
    loading = true;
    try {
      F.data = await api('GET', `/api/field/state?gameId=${F.gameId}`);
    } catch (e) { if (!e.offline) toast(e.message, 'error'); }
    loading = false;
    rerender();
  }

  // Posizioni degli altri telefoni, aggiornate ogni 15 secondi mentre la mappa è aperta.
  async function loadPositions() {
    if (!F.gameId) return;
    try { positions = await api('GET', `/api/field/positions?gameId=${F.gameId}`); updateMap(); } catch { /* senza rete */ }
  }
  setInterval(() => { if (mapOn) loadPositions(); }, 15000);

  const mySquad = () => (F.data?.squads || []).find((x) => x.id === F.squadId) || null;

  // ------------------------------------------------------------ incarichi della squadra
  function viewTasks() {
    const d = F.data;
    if (!d) return h('p', { class: 'empty' }, 'Caricamento…');
    const squads = d.squads || [];
    if (!squads.length) return h('p', { class: 'empty' }, 'La regia non ha ancora creato squadre di Eletti: trovate Altari e Doni nella scheda Piazza.');
    const sq = mySquad();
    if (!sq) return h('p', { class: 'empty' }, 'Il Consiglio non ti ha ancora assegnato a una squadra: intanto trovi Altari, luoghi e Doni nella scheda Piazza.');
    const pts = d.points.filter((p) => p.squadId === sq.id);
    const gifts = d.gifts.filter((g) => g.squadId === sq.id && !['claimed', 'expired'].includes(g.status));
    const places = (d.landmarks || []).filter((l) => l.squadId === sq.id);
    const todo = [
      ...places.filter((l) => isPending(l, 'landmark')).map((l) => ({ kind: 'landmark', id: l.id, label: l.label, item: l })),
      ...pts.filter((p) => isPending(p, 'point')).map((p) => ({ kind: 'point', id: p.id, label: p.label, item: p })),
      ...gifts.filter((g) => isPending(g, 'gift')).map((g) => ({ kind: 'gift', id: g.id, label: `${g.label} · ${g.icon} ${g.name}`, item: g })),
    ];
    const done = [...places.filter((l) => !isPending(l, 'landmark')).map((l) => l.label), ...pts.filter((p) => !isPending(p, 'point')).map((p) => p.label), ...gifts.filter((g) => !isPending(g, 'gift')).map((g) => g.label)];
    const toggle = async (t) => {
      try {
        await api('POST', `/api/field/tasks/${t.id}/done?gameId=${F.gameId}`, { done: !t.doneAt, gameId: F.gameId });
        load();
      } catch (e) { toast(e.message, 'error'); }
    };
    return h('div', { class: 'stack-sm' },
      h('div', { class: 'squad-banner', style: { '--c': sq.color } }, h('strong', null, `Squadra ${sq.name}`), h('span', { class: 'small muted' }, sq.members.map((m) => m.nickname || m.name).join(' · '))),
      h('div', { class: 'eyebrow' }, `Da piazzare (${todo.length})`),
      todo.length ? h('ul', { class: 'campo-list' }, todo.map((t) => {
        const x = t.item;
        const target = x.targetLat != null ? { lat: x.targetLat, lng: x.targetLng } : null;
        return h('li', { class: 'campo-item task-item' },
          h('div', { class: 'campo-info' },
            h('strong', null, t.label),
            x.moveRequestedAt ? h('span', { class: 'chip chip-blood' }, 'Da spostare') : null,
            target ? h('div', { class: 'small ok-text' }, '⌖ Punto indicato dalla regia', F.me ? ` · a ${fmtDist(meters(F.me, target))}` : '') : h('div', { class: 'small muted' }, 'Punto libero: scegliete voi'),
            x.taskNote ? h('div', { class: 'small' }, `«${x.taskNote}»`) : null),
          h('div', { class: 'stack-sm' },
            h('button', { class: 'btn btn-sm btn-primary', onclick: () => openPlacement(t) }, x.moveRequestedAt ? 'Sposta' : 'Piazza'),
            target ? h('button', { class: 'btn btn-sm', onclick: () => showOnMap(target) }, 'Mappa') : null));
      })) : h('p', { class: 'muted small' }, 'Niente da piazzare.'),
      h('div', { class: 'eyebrow' }, `Incarichi (${sq.tasks.filter((t) => !t.doneAt).length} da fare)`),
      sq.tasks.length ? h('ul', { class: 'campo-list' }, sq.tasks.map((t) => h('li', { class: `campo-item task-item ${t.doneAt ? 'done' : ''}` },
        h('div', { class: 'campo-info' }, h('strong', null, t.text), t.doneAt ? h('span', { class: 'tiny muted' }, `Fatto ${fmtTime(t.doneAt)} · ${(t.doneBy || '').replace('eletti:', '')}`) : null),
        h('button', { class: `btn btn-sm ${t.doneAt ? '' : 'btn-primary'}`, onclick: () => toggle(t) }, t.doneAt ? 'Riapri' : 'Fatto')))) : h('p', { class: 'muted small' }, 'Nessun incarico libero.'),
      done.length ? h('p', { class: 'small ok-text' }, `Già piazzati: ${done.join(', ')}`) : null);
  }

  function placedLine(x) {
    if (x.lat == null) return h('span', { class: 'chip chip-warn' }, 'Da piazzare');
    return h('span', { class: 'chip chip-ok' }, `Piazzato ${fmtTime(x.placedAt)}${x.accuracy ? ` · ±${x.accuracy} m` : ''}${x.placeSource === 'manual' ? ' · manuale' : ''}`);
  }
  const squadName = (id) => (F.data?.squads || []).find((s) => s.id === id)?.name;

  // ------------------------------------------------------------ elenco Altari
  function viewAltars() {
    const d = F.data;
    if (!d) return h('p', { class: 'empty' }, 'Caricamento…');
    const places = (d.landmarks || []).map((l) => h('li', { class: `campo-item ${l.lat != null && !l.moveRequestedAt ? 'done' : ''}` },
      l.hasPhoto ? h('img', { class: 'campo-thumb', src: `/api/media/landmark/${l.id}?v=${l.placedAt}`, alt: `Foto di ${l.label}`, loading: 'lazy' }) : h('div', { class: 'campo-thumb empty-thumb' }, l.kind === 'soglia' ? '⛩' : '◯'),
      h('div', { class: 'campo-info' },
        h('strong', null, l.label), h('div', { class: 'small muted' }, 'Luogo del gioco · foto facoltativa'),
        placedLine(l), l.moveRequestedAt ? h('span', { class: 'chip chip-blood' }, 'Da spostare') : null,
        l.squadId ? h('div', { class: 'tiny muted' }, `Incarico: squadra ${squadName(l.squadId) || '?'}`) : null),
      h('button', { class: `btn btn-sm ${l.lat != null && !l.moveRequestedAt ? '' : 'btn-primary'}`, onclick: () => openPlacement({ kind: 'landmark', id: l.id, label: l.label, item: l }) }, l.lat != null ? (l.moveRequestedAt ? 'Sposta' : 'Ripiazza') : 'Piazza')));
    if (!d.points.length) return h('div', { class: 'stack-sm' }, h('ul', { class: 'campo-list' }, places), h('p', { class: 'empty' }, 'Nessun Altare: la regia deve prima formare le coppie e sincronizzare gli Altari.'));
    return h('ul', { class: 'campo-list' }, places, d.points.map((p) => h('li', { class: `campo-item ${p.lat != null && !p.moveRequestedAt ? 'done' : ''}` },
      p.hasPhoto ? h('img', { class: 'campo-thumb', src: `/api/media/point/${p.id}?v=${p.placedAt}`, alt: `Foto di ${p.label}`, loading: 'lazy' }) : h('div', { class: 'campo-thumb empty-thumb' }, p.roman),
      h('div', { class: 'campo-info' },
        h('strong', null, p.label), h('div', { class: 'small muted' }, `Settore ${p.sectorName}${p.locationNote ? ` · ${p.locationNote}` : ''}`),
        placedLine(p), p.moveRequestedAt ? h('span', { class: 'chip chip-blood' }, 'Da spostare') : null,
        p.squadId ? h('div', { class: 'tiny muted' }, `Incarico: squadra ${squadName(p.squadId) || '?'}`) : null,
        p.placedBy ? h('div', { class: 'tiny muted' }, `da ${p.placedBy}`) : null),
      h('button', { class: `btn btn-sm ${p.lat != null && !p.moveRequestedAt ? '' : 'btn-primary'}`, onclick: () => openPlacement({ kind: 'point', id: p.id, label: p.label, item: p }) }, p.lat != null ? (p.moveRequestedAt ? 'Sposta' : 'Ripiazza') : 'Piazza'))));
  }

  // ------------------------------------------------------------ elenco Doni
  function viewGifts() {
    const d = F.data;
    if (!d) return h('p', { class: 'empty' }, 'Caricamento…');
    if (!d.gifts.length) return h('p', { class: 'empty' }, 'Nessun dono: la regia li crea e ne stampa i cartelli.');
    return h('ul', { class: 'campo-list' }, d.gifts.map((g) => h('li', { class: `campo-item gift-${g.status}` },
      g.hasPhoto ? h('img', { class: 'campo-thumb', src: `/api/media/gift/${g.id}?v=${g.placedAt}`, alt: `Foto di ${g.label}`, loading: 'lazy' }) : h('div', { class: 'campo-thumb empty-thumb', style: { color: g.color } }, g.icon),
      h('div', { class: 'campo-info' },
        h('strong', null, `${g.label} · `, h('span', { style: { color: g.color } }, `${g.icon} ${g.name}`)),
        h('span', { class: `chip ${g.status === 'draft' ? 'chip-warn' : g.status === 'revealed' ? 'chip-blood' : g.status === 'claimed' ? '' : 'chip-ok'}` },
          g.status === 'claimed' ? `Preso da ${g.claimedBy}` : GIFT_STATE[g.status]),
        g.moveRequestedAt ? h('span', { class: 'chip chip-blood' }, 'Da spostare') : null,
        g.squadId ? h('div', { class: 'tiny muted' }, `Incarico: squadra ${squadName(g.squadId) || '?'}${g.targetLat != null ? ' · punto indicato' : ''}`) : null,
        g.lat != null ? h('div', { class: 'tiny muted' }, `Piazzato ${fmtTime(g.placedAt)}${g.accuracy ? ` · ±${g.accuracy} m` : ''} da ${g.placedBy}`) : null,
        g.expiresAfterMin && !['claimed', 'expired'].includes(g.status) ? h('div', { class: 'tiny muted' }, `Svanisce ${g.expiresAfterMin}′ dopo l'annuncio`) : null,
        ['draft', 'placed'].includes(g.status) ? h('div', { class: 'tiny muted' }, revealText(g)) : null),
      !['claimed', 'expired'].includes(g.status) ? h('button', { class: `btn btn-sm ${isPending(g, 'gift') ? 'btn-primary' : ''}`, onclick: () => openPlacement({ kind: 'gift', id: g.id, label: `${g.label} · ${g.name}`, item: g }) },
        g.status === 'draft' ? 'Piazza e attiva' : g.moveRequestedAt ? 'Sposta' : 'Ripiazza') : null)));
  }

  // ------------------------------------------------------------ mappa del campo
  function updateMap() {
    const d = F.data;
    if (!d) return;
    const deviceId = store.get('zdg_device');
    const sq = mySquad();
    mapView.setItems([
      ...positions.filter((p) => p.deviceId !== deviceId).map(positionItem),
      ...(d.landmarks || []).map((l) => landmarkItem(l)),
      ...d.points.map((p) => ({ key: `p${p.id}`, kind: 'altar', lat: p.lat, lng: p.lng, text: p.roman, title: p.label,
        popup: `<strong>${p.label}</strong><br>Piazzato ${fmtTime(p.placedAt)} da ${p.placedBy || '?'}${p.accuracy ? ` · ±${p.accuracy} m` : ''}${p.hasPhoto ? `<img src="/api/media/point/${p.id}?v=${p.placedAt}" alt="">` : ''}` })),
      // Agli Eletti i doni presi o svaniti spariscono dalla mappa; la regia li vede ancora (barrati).
      ...d.gifts.filter((g) => F.who.role === 'master' || !['claimed', 'expired'].includes(g.status)).map((g) => ({ key: `g${g.id}`, kind: 'gift', lat: g.lat, lng: g.lng, text: g.icon, color: g.color,
        state: g.status === 'placed' ? 'hidden' : g.status, title: g.label,
        popup: `<strong>${g.label} · ${g.name}</strong><br>${GIFT_STATE[g.status]}${g.claimedBy ? ` da ${g.claimedBy}` : ''}${g.hasPhoto ? `<img src="/api/media/gift/${g.id}?v=${g.placedAt}" alt="">` : ''}` })),
      // Punti indicati dalla regia per gli incarichi ancora da fare (della propria squadra; la regia li vede tutti).
      ...[...d.points.map((p) => ['point', p]), ...d.gifts.map((g) => ['gift', g]), ...(d.landmarks || []).map((l) => ['landmark', l])]
        .filter(([k, x]) => x.targetLat != null && isPending(x, k) && (F.who.role === 'master' || (sq && x.squadId === sq.id)))
        .map(([k, x]) => ({ key: `t${k}${x.id}`, kind: 'target', lat: x.targetLat, lng: x.targetLng, title: `Qui: ${x.label}`, popup: `<strong>Da piazzare qui</strong><br>${x.label}${x.taskNote ? `<br><small>${x.taskNote}</small>` : ''}` })),
    ]);
    if (F.me) mapView.setMe(F.me);
  }

  function viewMap() {
    const d = F.data;
    if (!d) return h('p', { class: 'empty' }, 'Caricamento…');
    if (!mapOn) { mapOn = true; loadPositions(); }
    queueMicrotask(() => { updateMap(); mapView.refresh(); });
    return h('div', { class: 'stack-sm' },
      mapView.el,
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn btn-sm', onclick: () => mapView.centerMe() }, '◎ La mia posizione'),
        h('button', { class: 'btn btn-sm', onclick: () => mapView.fit() }, 'Tutto il campo')),
      h('div', { class: 'map-legend' },
        h('span', null, h('span', { class: 'pin pin-altar' }, 'I'), ' Altare'),
        h('span', null, h('span', { class: 'pin pin-place pin-soglia' }, '⛩'), ' Soglia'),
        h('span', null, h('span', { class: 'pin pin-place' }, '◯'), ' Cerchio'),
        h('span', null, h('span', { class: 'pin pin-gift pin-hidden' }, '✦'), ' Dono non annunciato'),
        h('span', null, h('span', { class: 'pin pin-gift pin-revealed', style: { '--c': '#d1ad62' } }, '✦'), ' Dono annunciato'),
        h('span', null, h('span', { class: 'pin pin-target' }, '⌖'), ' Punto indicato dalla regia'),
        h('span', null, h('span', { class: 'pin-dot', style: { '--c': '#d1ad62' } }), ' Altri Eletti (colore della squadra)'),
        h('span', null, h('span', { class: 'pin pin-me' }), ' Tu')),
      d.points.some((p) => p.lat == null) ? h('p', { class: 'muted small' }, `Altari ancora da piazzare: ${d.points.filter((p) => p.lat == null).map((p) => p.sectorName).join(', ')}`) : null);
  }
  const leaveMap = () => { mapOn = false; };

  // Apre la mappa centrata sul punto indicato (dal pulsante "Mappa" dell'incarico).
  let focusTarget = null;
  function showOnMap(target) {
    focusTarget = target;
    rerender('mappa');
    setTimeout(() => { mapView.map?.setView([focusTarget.lat, focusTarget.lng], 17); }, 250);
  }

  // ------------------------------------------------------------ scansione del cartello
  async function scanSign() {
    const text = await scanQR({
      title: 'Scansiona il cartello',
      hint: 'Inquadra il QR dell\'Altare o del Dono che stai piazzando.',
      accept: (t) => (/\/(a|d)\/[\w-]+/.test(t) ? true : 'Questo QR non è un Altare né un Dono'),
    });
    if (!text) return;
    try {
      const r = await api('GET', `/api/field/resolve?gameId=${F.gameId}&text=${encodeURIComponent(text)}`);
      const item = r.kind === 'gift' ? F.data?.gifts.find((g) => g.id === r.id) : F.data?.points.find((p) => p.id === r.id);
      openPlacement({ kind: r.kind, id: r.id, label: item?.name ? `${item.label} · ${item.name}` : r.label, item });
    } catch (e) { toast(e.message, 'error', 6000); }
  }

  // ------------------------------------------------------------ piazzamento: posizione + foto + conferma

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
    startGps();
    const item = target.item;
    const goal = item?.targetLat != null ? { lat: item.targetLat, lng: item.targetLng } : null;
    const photoOptional = target.kind === 'landmark';
    const sheetMap = createMapView({ className: 'sheet-map' });
    let manual = null; // posizione scelta toccando la mappa
    let photo = null;
    const posLine = h('div', { class: 'mono small' });
    const goalLine = goal ? h('div', { class: 'small ok-text' }) : null;
    const photoPreview = h('div', { class: 'photo-preview' }, h('span', { class: 'muted' }, 'Nessuna foto'));
    const confirmBtn = h('button', { class: 'btn btn-primary btn-xl btn-block', type: 'button', disabled: true }, 'Conferma piazzamento');
    const position = () => manual || F.me;
    const sync = () => {
      const p = position();
      // GPS troppo impreciso per piazzare: si aspetta un valore migliore o si tocca il punto sulla mappa.
      const tooVague = !manual && p && p.acc > PLACE_MAX_ACC;
      posLine.textContent = manual ? `Punto scelto sulla mappa (${manual.lat.toFixed(5)}, ${manual.lng.toFixed(5)})`
        : p ? `GPS: ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} · ± ${p.acc} m${tooVague ? ` — troppo impreciso per piazzare: aspetta o tocca il punto esatto sulla mappa. ${accuracyHint(p.acc)}` : ''}`
          : (F.geoError || 'Ricerca della posizione GPS…');
      posLine.className = `mono small ${p && (manual || p.acc <= 30) ? 'ok-text' : 'bad-text'}`;
      if (goalLine) goalLine.textContent = p ? `⌖ Punto indicato dalla regia a ${fmtDist(meters(p, goal))}` : '⌖ La regia ha indicato un punto sulla mappa';
      confirmBtn.disabled = !(p && !tooVague && (photo || photoOptional));
      if (p) sheetMap.setMe(p);
    };
    const tick = setInterval(sync, 1000);
    sheetMap.ready.then(() => {
      sheetMap.onTap((ll) => { manual = { lat: ll.lat, lng: ll.lng, acc: null }; sync(); sheetMap.centerMe(); vibrate(30); });
      if (goal) sheetMap.setItems([{ key: 'goal', kind: 'target', lat: goal.lat, lng: goal.lng, title: 'Punto indicato' }]);
      if (F.me) { sheetMap.setMe(F.me); }
      if (goal) sheetMap.fit(); else if (F.me) sheetMap.centerMe(17);
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
      if (!p || (!manual && p.acc > PLACE_MAX_ACC) || (!photo && !photoOptional)) return;
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Invio in corso…';
      const qs = new URLSearchParams({ gameId: F.gameId, lat: p.lat, lng: p.lng, acc: p.acc ?? '', source: manual ? 'manual' : 'gps', squadId: F.squadId || '' });
      try {
        const path = { gift: 'gifts', point: 'points', landmark: 'landmarks' }[target.kind];
        const res = await fetch(`/api/field/${path}/${target.id}/place?${qs}`, { method: 'POST', headers: { 'Content-Type': photo ? 'image/jpeg' : 'application/octet-stream' }, body: photo || undefined, credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Errore ${res.status}`);
        vibrate([80, 60, 200]);
        toast(target.kind === 'gift' ? `${data.label} piazzato${data.revealed ? ' e annunciato alle coppie' : ''}` : `${data.label} piazzato`, 'ok', 6000);
        close();
        load();
      } catch (e) {
        toast(e.message.includes('Failed to fetch') ? 'Nessuna rete: riprova appena c\'è segnale' : e.message, 'error', 7000);
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Conferma piazzamento';
      }
    });
    const sheet = h('div', { class: 'place-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Piazza ${target.label}` },
      h('div', { class: 'place-head' }, h('div', null, h('div', { class: 'eyebrow' }, item?.moveRequestedAt ? 'Sposta' : target.kind === 'gift' ? 'Piazza e attiva il dono' : target.kind === 'landmark' ? 'Piazza il luogo' : 'Piazza l\'Altare'), h('h2', null, target.label)),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: close }, 'Annulla')),
      item?.taskNote ? h('p', { class: 'note' }, `Dalla regia: «${item.taskNote}»`) : null,
      h('section', { class: 'place-step' },
        h('div', { class: 'step-title' }, h('span', { class: 'step-n' }, '1'), 'Posizione'),
        h('p', { class: 'muted small' }, goal ? 'Raggiungi il punto ⌖ indicato dalla regia e mettiti accanto al cartello. Se il GPS è impreciso, tocca il punto esatto sulla mappa.' : 'Mettiti accanto al cartello: l\'app usa il GPS di questo telefono. Se il GPS non c\'è o è impreciso, tocca il punto esatto sulla mappa.'),
        goalLine, posLine, sheetMap.el),
      h('section', { class: 'place-step' },
        h('div', { class: 'step-title' }, h('span', { class: 'step-n' }, '2'), photoOptional ? 'Foto (facoltativa)' : 'Foto del piazzamento'),
        h('label', { class: 'btn btn-block', for: 'place-photo' }, '📷 Scatta la foto'), fileInput, photoPreview),
      h('section', { class: 'place-step' }, confirmBtn));
    document.body.append(sheet);
    document.body.classList.add('no-scroll');
    sync();
  }

  // Quante cose restano da fare alla mia squadra.
  function todoCount() {
    const d = F.data;
    const sq = mySquad();
    if (!d || !sq) return 0;
    return (d.landmarks || []).filter((l) => l.squadId === sq.id && isPending(l, 'landmark')).length
      + d.points.filter((p) => p.squadId === sq.id && isPending(p, 'point')).length
      + d.gifts.filter((g) => g.squadId === sq.id && isPending(g, 'gift')).length
      + sq.tasks.filter((t) => !t.doneAt).length;
  }

  return { load, startGps, stopGps, gpsText, viewTasks, viewAltars, viewGifts, viewMap, leaveMap, updateMap, scanSign, openPlacement, todoCount, mapView };
}
