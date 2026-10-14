'use strict';
// Campo: piazzamento di Altari e Doni (foto + coordinate dal telefono di Eletti o Master), doni QR e mappe.
const fs = require('fs');
const path = require('path');
const { q, tx, DATA_DIR, getSetting, setSetting } = require('./db');
const C = require('./constants');
const G = require('./game');
const rt = require('./realtime');
const { randomToken, HttpError } = require('./util');

const err = (status, msg) => new HttpError(status, msg);
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// ---------------------------------------------------------------- catalogo dei tipi di dono

const DEFAULT_GIFT_TYPES = [
  { id: 'riscatto', name: 'Riscatto', icon: '↺', color: '#6fbf73', description: 'Cancella un ingaggio perso: invece del Sigillo mostrate questo dono. Vale una volta.' },
  { id: 'spacca', name: 'Spacca alleanze', icon: '⚡', color: '#e0603f', description: 'Mostratelo a due coppie alleate: la loro alleanza è sciolta e non possono riallearsi per 15 minuti.' },
  { id: 'tregua', name: 'Tregua', icon: '⛨', color: '#5aa0e0', description: 'Per 5 minuti nessuno può ingaggiarvi: mostratelo a chi vi attacca e fate partire il timer.' },
  { id: 'occhio', name: 'Occhio del Consiglio', icon: '◉', color: '#d1ad62', description: 'Scrivete alla regia: il Consiglio vi darà un indizio sulla posizione di un Altare a vostra scelta.' },
];

function giftTypes() {
  const raw = getSetting('giftTypes');
  return raw ? JSON.parse(raw) : DEFAULT_GIFT_TYPES;
}

function saveGiftTypes(list, actor) {
  if (!Array.isArray(list) || !list.length) throw err(400, 'Serve almeno un tipo di dono');
  const seen = new Set();
  const clean = list.map((t, i) => {
    const name = String(t.name || '').trim().slice(0, 40);
    if (!name) throw err(400, 'Ogni tipo di dono deve avere un nome');
    let id = String(t.id || '').trim() || name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `dono-${i + 1}`;
    while (seen.has(id)) id += '-x';
    seen.add(id);
    const color = /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#d1ad62';
    return { id, name, icon: String(t.icon || '✦').trim().slice(0, 2) || '✦', color, description: String(t.description || '').trim().slice(0, 300) };
  });
  setSetting('giftTypes', JSON.stringify(clean));
  G.log(null, actor, 'gift_types_saved', { count: clean.length });
  return clean;
}

// ---------------------------------------------------------------- doni

// Incarico di piazzamento (Altari e Doni): punto indicato, nota, spostamento richiesto, squadra che ha piazzato.
const taskFields = (r) => ({
  targetLat: r.targetLat, targetLng: r.targetLng, taskNote: r.taskNote, moveRequestedAt: r.moveRequestedAt, placedSquadId: r.placedSquadId,
});

function giftOut(g) {
  const t = g.claimedByTeamId ? q.get('SELECT t.displayName, s.name AS sectorName, s.roman FROM teams t LEFT JOIN sectors s ON s.id = t.sectorId WHERE t.id = ?', g.claimedByTeamId) : null;
  return {
    id: g.id, label: g.label, typeId: g.typeId, name: g.name, icon: g.icon, color: g.color, description: g.description,
    status: g.status, revealMode: g.revealMode, revealAtMin: g.revealAtMin, revealAt: g.revealAt,
    lat: g.lat, lng: g.lng, accuracy: g.accuracy, placedAt: g.placedAt, placedBy: g.placedBy, hasPhoto: !!g.photoFile, squadId: g.squadId,
    ...taskFields(g),
    revealedAt: g.revealedAt, claimedAt: g.claimedAt, usedAt: g.usedAt, expiredAt: g.expiredAt,
    expiresAfterMin: g.expiresAfterMin, expiresAtElapsedMs: g.expiresAfterMin && g.revealElapsedMs != null ? g.revealElapsedMs + g.expiresAfterMin * 60000 : null,
    claimedBy: t ? `${t.roman || ''} ${t.sectorName || ''}`.trim() : null,
  };
}

function getGift(id) {
  const g = q.get('SELECT * FROM gifts WHERE id = ?', Number(id));
  if (!g) throw err(404, 'Dono non trovato');
  return g;
}

function createGifts(gameId, data, actor) {
  const game = G.getGame(gameId);
  if (game.status === 'ended') throw err(409, 'La partita è terminata');
  const type = giftTypes().find((t) => t.id === data.typeId);
  if (!type) throw err(400, 'Scegli il tipo di dono');
  const count = Math.max(1, Math.min(50, parseInt(data.count, 10) || 1));
  const revealMode = ['manual', 'onplace', 'time'].includes(data.revealMode) ? data.revealMode : 'manual';
  let revealAtMin = null;
  if (revealMode === 'time') {
    revealAtMin = parseFloat(data.revealAtMin);
    if (!Number.isFinite(revealAtMin) || revealAtMin < 0 || revealAtMin > game.durationMin) throw err(400, 'Minuto di comparsa non valido');
  }
  let expiresAfterMin = null;
  if (data.expiresAfterMin !== undefined && data.expiresAfterMin !== null && data.expiresAfterMin !== '') {
    expiresAfterMin = parseFloat(data.expiresAfterMin);
    if (!Number.isFinite(expiresAfterMin) || expiresAfterMin <= 0 || expiresAfterMin > 600) throw err(400, 'Scadenza non valida (minuti dopo la comparsa)');
  }
  const squad = data.squadId ? getSquad(data.squadId) : null;
  if (squad && squad.gameId !== game.id) throw err(400, 'Squadra di un\'altra partita');
  const target = readTarget(data);
  const note = String(data.note || '').trim().slice(0, 300) || null;
  const ids = tx(() => {
    let n = q.get('SELECT COUNT(*) AS n FROM gifts WHERE gameId = ?', game.id).n;
    const out = [];
    for (let i = 0; i < count; i++) {
      n += 1;
      out.push(Number(q.run(`INSERT INTO gifts (gameId, typeId, name, icon, color, description, label, qrToken, revealMode, revealAtMin, expiresAfterMin, squadId, targetLat, targetLng, taskNote, createdAt)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        game.id, type.id, type.name, type.icon, type.color, type.description, `Dono ${n}`, randomToken(18), revealMode, revealAtMin, expiresAfterMin,
        squad?.id ?? null, target.lat, target.lng, note, Date.now()).lastInsertRowid));
    }
    return out;
  });
  G.log(game.id, actor, 'gifts_created', { type: type.name, count });
  if (squad) notifySquad(squad.id, { title: `Incarico per la squadra ${squad.name}`, body: `Piazzate ${count > 1 ? `${count} doni` : 'un dono'} (${type.name})${target.lat != null ? ' nel punto indicato sulla mappa' : ''}`, tag: `task-gifts-${ids[0]}` });
  rt.toStaff(game.id, 'gifts');
  return { ids };
}

// Punto indicato dalla regia sulla mappa (facoltativo): { lat, lng } oppure null.
function readTarget(data) {
  if (data.targetLat == null || data.targetLat === '' || data.targetLng == null || data.targetLng === '') return { lat: null, lng: null };
  const lat = parseFloat(data.targetLat);
  const lng = parseFloat(data.targetLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw err(400, 'Punto sulla mappa non valido');
  return { lat, lng };
}

// Annuncio del dono: subito, a un orario preciso (ms), oppure annullato.
// Se il dono non è ancora piazzato, compare appena viene piazzato (dopo l'orario scelto).
function scheduleGiftReveal(id, data, actor) {
  const g = getGift(id);
  if (!['draft', 'placed'].includes(g.status)) throw err(409, g.status === 'revealed' ? 'Il dono è già stato annunciato' : 'Dono già preso o svanito');
  const mode = data.mode;
  if (mode === 'cancel') {
    q.run("UPDATE gifts SET revealMode = 'manual', revealAt = NULL WHERE id = ?", g.id);
    G.log(g.gameId, actor, 'gift_schedule_cancelled', { label: g.label });
  } else if (mode === 'now') {
    if (g.status === 'placed') { revealGift(g.id, actor); return { revealed: true }; }
    q.run("UPDATE gifts SET revealMode = 'onplace', revealAt = NULL WHERE id = ?", g.id);
    G.log(g.gameId, actor, 'gift_scheduled', { label: g.label, when: 'appena piazzato' });
  } else if (mode === 'at') {
    const at = Number(data.at);
    if (!Number.isFinite(at) || at < Date.now() - 60000 || at > Date.now() + 2 * 86400000) throw err(400, 'Orario dell\'annuncio non valido');
    q.run("UPDATE gifts SET revealMode = 'at', revealAt = ? WHERE id = ?", Math.round(at), g.id);
    G.log(g.gameId, actor, 'gift_scheduled', { label: g.label, at: Math.round(at) });
  } else throw err(400, 'Scegli quando annunciare il dono');
  rt.toStaff(g.gameId, 'gifts');
  return { revealed: false };
}

function updateGift(id, data, actor) {
  const g = getGift(id);
  if (['claimed', 'expired'].includes(g.status)) throw err(409, 'Dono già preso o svanito: non si modifica');
  const sets = [];
  const vals = [];
  if (data.label !== undefined) { sets.push('label = ?'); vals.push(String(data.label).trim().slice(0, 40) || g.label); }
  if (data.revealMode !== undefined) {
    if (!['manual', 'onplace', 'time'].includes(data.revealMode)) throw err(400, 'Modalità non valida');
    sets.push('revealMode = ?'); vals.push(data.revealMode);
    const m = data.revealMode === 'time' ? parseFloat(data.revealAtMin) : null;
    if (data.revealMode === 'time' && (!Number.isFinite(m) || m < 0)) throw err(400, 'Minuto di comparsa non valido');
    sets.push('revealAtMin = ?'); vals.push(m);
  }
  if (data.expiresAfterMin !== undefined) {
    const m = data.expiresAfterMin === '' || data.expiresAfterMin === null ? null : parseFloat(data.expiresAfterMin);
    if (m !== null && (!Number.isFinite(m) || m <= 0)) throw err(400, 'Scadenza non valida');
    sets.push('expiresAfterMin = ?'); vals.push(m);
  }
  if (!sets.length) return;
  q.run(`UPDATE gifts SET ${sets.join(', ')} WHERE id = ?`, ...vals, g.id);
  G.log(g.gameId, actor, 'gift_updated', { label: g.label });
  rt.toStaff(g.gameId, 'gifts');
}

function removePhoto(file) {
  if (file) fs.rmSync(path.join(PHOTO_DIR, file), { force: true });
}

function deleteGift(id, actor) {
  const g = getGift(id);
  q.run('DELETE FROM gifts WHERE id = ?', g.id);
  removePhoto(g.photoFile);
  G.log(g.gameId, actor, 'gift_deleted', { label: g.label });
  rt.toStaff(g.gameId, 'gifts');
  rt.toTeams(g.gameId, 'state', {});
}

// Riporta il dono a "da piazzare" (es. piazzato nel posto sbagliato).
function resetGift(id, actor) {
  const g = getGift(id);
  if (g.status === 'claimed') throw err(409, 'Dono già preso');
  q.run("UPDATE gifts SET status = 'draft', lat = NULL, lng = NULL, accuracy = NULL, photoFile = NULL, placedAt = NULL, placedBy = NULL, placedSquadId = NULL, moveRequestedAt = NULL, revealedAt = NULL, revealElapsedMs = NULL, expiredAt = NULL WHERE id = ?", g.id);
  removePhoto(g.photoFile);
  G.log(g.gameId, actor, 'gift_reset', { label: g.label });
  rt.toStaff(g.gameId, 'gifts');
  rt.toTeams(g.gameId, 'state', {});
}

function revealGift(id, actor) {
  const g = getGift(id);
  if (g.status === 'draft') throw err(409, 'Il dono va prima piazzato sul campo');
  if (g.status !== 'placed') throw err(409, g.status === 'revealed' ? 'Il dono è già comparso' : g.status === 'expired' ? 'Il dono è svanito' : 'Dono già preso');
  q.run("UPDATE gifts SET status = 'revealed', revealedAt = ?, revealElapsedMs = ? WHERE id = ?", Date.now(), G.clockOf(G.getGame(g.gameId)).elapsedMs, g.id);
  G.log(g.gameId, actor, 'gift_revealed', { label: g.label, type: g.name });
  G.announce(g.gameId, 'gift', {}, { giftId: g.id });
  rt.toTeams(g.gameId, 'state', {});
  rt.toStaff(g.gameId, 'gifts');
}

// Scaduto: sparisce dalle mappe, nessuno può più prenderlo.
function expireGift(g) {
  q.run("UPDATE gifts SET status = 'expired', expiredAt = ? WHERE id = ? AND status = 'revealed'", Date.now(), g.id);
  G.log(g.gameId, 'sistema', 'gift_expired', { label: g.label, type: g.name });
  G.announce(g.gameId, 'gift_expired', {}, { giftId: g.id });
  rt.toTeams(g.gameId, 'state', {});
  rt.toStaff(g.gameId, 'gifts');
}

// Comparsa programmata (minuti dal via, pause escluse).
function tickAll() {
  const games = q.all(`SELECT * FROM games WHERE status IN (${C.ACTIVE.map(() => '?').join(',')})`, ...C.ACTIVE);
  for (const game of games) {
    const e = G.clockOf(game).elapsedMs / 60000;
    const due = q.all(`SELECT id FROM gifts WHERE gameId = ? AND status = 'placed'
                       AND ((revealMode = 'time' AND revealAtMin <= ?) OR (revealMode = 'at' AND revealAt <= ?))`, game.id, e, Date.now());
    for (const d of due) {
      try { revealGift(d.id, 'sistema'); } catch (e2) { console.error('gift tick', e2.message); }
    }
    const elapsed = e * 60000;
    const expired = q.all("SELECT * FROM gifts WHERE gameId = ? AND status = 'revealed' AND expiresAfterMin IS NOT NULL AND revealElapsedMs IS NOT NULL AND revealElapsedMs + expiresAfterMin * 60000 <= ?", game.id, elapsed);
    for (const g of expired) expireGift(g);
  }
}

// ---------------------------------------------------------------- piazzamento sul campo

function readPlacement(body, photoOptional = false) {
  const lat = parseFloat(body.lat);
  const lng = parseFloat(body.lng);
  const acc = body.acc != null && body.acc !== '' ? parseFloat(body.acc) : null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw err(400, 'Posizione mancante o non valida');
  const source = body.source === 'manual' ? 'manual' : 'gps';
  const hasPhoto = Buffer.isBuffer(body.buffer) && body.buffer.length > 0;
  if (!hasPhoto && photoOptional) return { lat, lng, acc: Number.isFinite(acc) ? Math.round(acc) : null, ext: null, buffer: null, source };
  const mime = String(body.mime || '').split(';')[0].trim().toLowerCase();
  const ext = IMAGE_TYPES[mime];
  if (!ext) throw err(415, 'Foto in un formato non supportato');
  if (!hasPhoto) throw err(400, 'Foto mancante');
  return { lat, lng, acc: Number.isFinite(acc) ? Math.round(acc) : null, ext, buffer: body.buffer, source: body.source === 'manual' ? 'manual' : 'gps' };
}

function savePhoto(prefix, id, p) {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const file = `${prefix}-${id}-${Date.now()}.${p.ext}`;
  fs.writeFileSync(path.join(PHOTO_DIR, file), p.buffer);
  return file;
}

// Squadra che piazza: quella dell'Eletto (codice personale), quella scelta sul telefono, altrimenti quella incaricata.
function placerSquad(gameId, squadId, fallback) {
  const s = squadId ? q.get('SELECT id FROM elect_squads WHERE id = ? AND gameId = ?', Number(squadId), Number(gameId)) : null;
  return s?.id ?? fallback ?? null;
}

function placePoint(pointId, gameId, body, who, squadId = null) {
  const pt = q.get('SELECT * FROM points WHERE id = ? AND gameId = ?', Number(pointId), Number(gameId));
  if (!pt) throw err(404, 'Altare non trovato in questa partita');
  if (G.getGame(pt.gameId).status === 'ended') throw err(409, 'La partita è terminata');
  const p = readPlacement(body);
  const file = savePhoto('altare', pt.id, p);
  q.run('UPDATE points SET lat = ?, lng = ?, accuracy = ?, photoFile = ?, placedAt = ?, placedBy = ?, placeSource = ?, placedSquadId = ?, moveRequestedAt = NULL WHERE id = ?',
    p.lat, p.lng, p.acc, file, Date.now(), who, p.source, placerSquad(pt.gameId, squadId, pt.squadId), pt.id);
  removePhoto(pt.photoFile);
  G.log(pt.gameId, who, pt.moveRequestedAt ? 'point_moved' : 'point_placed', { label: pt.label, accuracy: p.acc, source: p.source });
  rt.toStaff(pt.gameId, 'placed');
  rt.toTeams(pt.gameId, 'state', {});
  return { ok: true, label: pt.label };
}

function placeGift(giftId, gameId, body, who, squadId = null) {
  const g = q.get('SELECT * FROM gifts WHERE id = ? AND gameId = ?', Number(giftId), Number(gameId));
  if (!g) throw err(404, 'Dono non trovato in questa partita');
  if (g.status === 'claimed') throw err(409, 'Questo dono è già stato preso');
  if (g.status === 'expired') throw err(409, 'Questo dono è svanito: la regia può riportarlo da piazzare');
  if (G.getGame(g.gameId).status === 'ended') throw err(409, 'La partita è terminata');
  const p = readPlacement(body);
  const file = savePhoto('dono', g.id, p);
  const status = g.status === 'revealed' ? 'revealed' : 'placed';
  q.run('UPDATE gifts SET status = ?, lat = ?, lng = ?, accuracy = ?, photoFile = ?, placedAt = ?, placedBy = ?, placeSource = ?, placedSquadId = ?, moveRequestedAt = NULL WHERE id = ?',
    status, p.lat, p.lng, p.acc, file, Date.now(), who, p.source, placerSquad(g.gameId, squadId, g.squadId), g.id);
  removePhoto(g.photoFile);
  G.log(g.gameId, who, 'gift_placed', { label: g.label, type: g.name, accuracy: p.acc });
  if (status === 'placed' && g.revealMode === 'onplace') revealGift(g.id, who);
  rt.toStaff(g.gameId, 'placed');
  rt.toTeams(g.gameId, 'state', {});
  return { ok: true, label: g.label, revealed: g.revealMode === 'onplace' || status === 'revealed' };
}

// Luoghi del gioco (Soglia, Cerchio di inizio): come gli Altari, ma la foto è facoltativa.
function placeLandmark(id, gameId, body, who, squadId = null) {
  const l = q.get('SELECT * FROM landmarks WHERE id = ? AND gameId = ?', Number(id), Number(gameId));
  if (!l) throw err(404, 'Luogo non trovato in questa partita');
  if (G.getGame(l.gameId).status === 'ended') throw err(409, 'La partita è terminata');
  const p = readPlacement(body, true);
  const file = p.buffer ? savePhoto(l.kind, l.id, p) : null;
  q.run('UPDATE landmarks SET lat = ?, lng = ?, accuracy = ?, photoFile = ?, placedAt = ?, placedBy = ?, placeSource = ?, placedSquadId = ?, moveRequestedAt = NULL WHERE id = ?',
    p.lat, p.lng, p.acc, file, Date.now(), who, p.source, placerSquad(l.gameId, squadId, l.squadId), l.id);
  removePhoto(l.photoFile);
  G.log(l.gameId, who, 'landmark_placed', { label: l.label, accuracy: p.acc, source: p.source });
  rt.toStaff(l.gameId, 'placed');
  rt.toTeams(l.gameId, 'state', {});
  return { ok: true, label: l.label };
}

const landmarkOut = (l) => ({
  id: l.id, kind: l.kind, label: l.label, lat: l.lat, lng: l.lng, accuracy: l.accuracy, placedAt: l.placedAt, placedBy: l.placedBy,
  placeSource: l.placeSource, hasPhoto: !!l.photoFile, squadId: l.squadId, ...taskFields(l),
});

// Cartello scansionato sul campo: Altare (/a/…) o Dono (/d/…).
function resolveToken(gameId, text) {
  const s = String(text || '');
  const a = s.match(/\/a\/([\w-]+)/);
  if (a) {
    const pt = q.get('SELECT id, label FROM points WHERE gameId = ? AND qrToken = ?', Number(gameId), a[1]);
    if (pt) return { kind: 'point', id: pt.id, label: pt.label };
  }
  const d = s.match(/\/d\/([\w-]+)/);
  if (d) {
    const g = q.get('SELECT id, label FROM gifts WHERE gameId = ? AND qrToken = ?', Number(gameId), d[1]);
    if (g) return { kind: 'gift', id: g.id, label: g.label };
  }
  throw err(404, 'Cartello non riconosciuto per questa partita');
}

function photoFile(kind, id) {
  const table = { point: 'points', gift: 'gifts', landmark: 'landmarks' }[kind];
  const row = table ? q.get(`SELECT gameId, photoFile FROM ${table} WHERE id = ?`, Number(id)) : null;
  if (!row?.photoFile) throw err(404, 'Foto non trovata');
  return { gameId: row.gameId, file: path.join(PHOTO_DIR, row.photoFile) };
}

// ---------------------------------------------------------------- viste

// Per regia ed Eletti: tutto, compresi i doni non ancora comparsi.
function fieldState(gameId) {
  const game = G.getGame(gameId);
  const points = q.all(`SELECT p.*, s.name AS sectorName, s.roman, s.ord FROM points p JOIN sectors s ON s.id = p.sectorId WHERE p.gameId = ? ORDER BY s.ord`, game.id)
    .map((p) => ({
      id: p.id, label: p.label, sectorId: p.sectorId, sectorName: p.sectorName, roman: p.roman, locationNote: p.locationNote,
      lat: p.lat, lng: p.lng, accuracy: p.accuracy, placedAt: p.placedAt, placedBy: p.placedBy, placeSource: p.placeSource, hasPhoto: !!p.photoFile,
      squadId: p.squadId, ...taskFields(p),
    }));
  return {
    game: { id: game.id, name: game.name, status: game.status },
    clock: G.clockOf(game),
    points,
    gifts: q.all('SELECT * FROM gifts WHERE gameId = ? ORDER BY id', game.id).map(giftOut),
    giftTypes: giftTypes(),
    squads: squadsOf(game.id),
    landmarks: G.landmarksOf(game.id).map(landmarkOut),
  };
}

// ---------------------------------------------------------------- squadre degli Eletti

const SQUAD_COLORS = ['#e0603f', '#5aa0e0', '#6fbf73', '#d1ad62', '#b07ad9', '#e07ab0', '#4fc1c1', '#c9c9c9'];

function squadsOf(gameId) {
  const elect = G.electOf(gameId);
  const members = elect ? G.membersOf(elect.id) : [];
  const squadOfMember = Object.fromEntries(q.all('SELECT id, squadId FROM players WHERE gameId = ?', gameId).map((p) => [p.id, p.squadId]));
  return q.all('SELECT * FROM elect_squads WHERE gameId = ? ORDER BY id', gameId).map((s) => ({
    ...s,
    members: members.filter((m) => squadOfMember[m.id] === s.id).map((m) => ({ id: m.id, name: m.name, nickname: m.nickname })),
    tasks: q.all('SELECT * FROM squad_tasks WHERE squadId = ? ORDER BY doneAt IS NOT NULL, id', s.id),
  }));
}

function getSquad(id) {
  const s = q.get('SELECT * FROM elect_squads WHERE id = ?', Number(id));
  if (!s) throw err(404, 'Squadra non trovata');
  return s;
}

// Avvisa i telefoni dei membri della squadra (accesso personale) e aggiorna gli Eletti collegati.
function notifySquad(squadId, push) {
  const s = getSquad(squadId);
  const subs = q.all('SELECT ps.* FROM push_subs ps JOIN players p ON p.id = ps.playerId WHERE p.squadId = ?', s.id);
  if (push) rt.pushSubs(subs, { url: '/campo#incarichi', ...push });
  const elect = G.electOf(s.gameId);
  if (elect) rt.toTeams(s.gameId, 'state', {}, elect.id);
  rt.toStaff(s.gameId, 'squads');
}

function createSquad(gameId, data, actor) {
  const game = G.getGame(gameId);
  const name = String(data.name || '').trim().slice(0, 40);
  if (!name) throw err(400, 'Il nome della squadra è obbligatorio');
  const n = q.get('SELECT COUNT(*) AS n FROM elect_squads WHERE gameId = ?', game.id).n;
  const color = /^#[0-9a-f]{6}$/i.test(data.color) ? data.color : SQUAD_COLORS[n % SQUAD_COLORS.length];
  const id = Number(q.run('INSERT INTO elect_squads (gameId, name, color, createdAt) VALUES (?, ?, ?, ?)', game.id, name, color, Date.now()).lastInsertRowid);
  G.log(game.id, actor, 'squad_created', { name });
  rt.toStaff(game.id, 'squads');
  return { id };
}

function updateSquad(id, data, actor) {
  const s = getSquad(id);
  const name = data.name !== undefined ? String(data.name).trim().slice(0, 40) : s.name;
  if (!name) throw err(400, 'Il nome della squadra è obbligatorio');
  const color = /^#[0-9a-f]{6}$/i.test(data.color) ? data.color : s.color;
  q.run('UPDATE elect_squads SET name = ?, color = ? WHERE id = ?', name, color, s.id);
  G.log(s.gameId, actor, 'squad_updated', { name });
  notifySquad(s.id, null);
}

function deleteSquad(id, actor) {
  const s = getSquad(id);
  q.run('DELETE FROM elect_squads WHERE id = ?', s.id);
  G.log(s.gameId, actor, 'squad_deleted', { name: s.name });
  rt.toStaff(s.gameId, 'squads');
  const elect = G.electOf(s.gameId);
  if (elect) rt.toTeams(s.gameId, 'state', {}, elect.id);
}

function setMemberSquad(playerId, squadId, actor) {
  const p = q.get('SELECT * FROM players WHERE id = ?', Number(playerId));
  if (!p) throw err(404, 'Eletto non trovato');
  const elect = G.electOf(p.gameId);
  if (!elect || p.teamId !== elect.id) throw err(409, 'Solo gli Eletti del Consiglio entrano nelle squadre');
  const s = squadId ? getSquad(squadId) : null;
  if (s && s.gameId !== p.gameId) throw err(400, 'Squadra di un\'altra partita');
  q.run('UPDATE players SET squadId = ? WHERE id = ?', s?.id ?? null, p.id);
  G.log(p.gameId, actor, 'squad_member', { name: p.name, squad: s?.name || null });
  if (s) notifySquad(s.id, { title: `Squadra ${s.name}`, body: `${p.name}, sei nella squadra ${s.name}.`, tag: `squad-${s.id}` });
  else rt.toStaff(p.gameId, 'squads');
}

// Assegna un Altare o un Dono da piazzare (o da spostare) a una squadra (null = nessuna).
// opts: { targetLat, targetLng } punto indicato sulla mappa (assenti = invariato, null = libero), note, move.
function assignToSquad(kind, id, squadId, actor, opts = {}) {
  const table = { gift: 'gifts', point: 'points', landmark: 'landmarks' }[kind];
  if (!table) throw err(400, 'Tipo non valido');
  const row = q.get(`SELECT * FROM ${table} WHERE id = ?`, Number(id));
  if (!row) throw err(404, kind === 'gift' ? 'Dono non trovato' : kind === 'landmark' ? 'Luogo non trovato' : 'Altare non trovato');
  if (kind === 'gift' && ['claimed', 'expired'].includes(row.status)) throw err(409, 'Dono già preso o svanito');
  const s = squadId ? getSquad(squadId) : null;
  if (s && s.gameId !== row.gameId) throw err(400, 'Squadra di un\'altra partita');
  if (!s) {
    q.run(`UPDATE ${table} SET squadId = NULL, targetLat = NULL, targetLng = NULL, taskNote = NULL, moveRequestedAt = NULL WHERE id = ?`, row.id);
    G.log(row.gameId, actor, 'squad_unassigned', { item: row.label });
    if (row.squadId) notifySquad(row.squadId, null); else rt.toStaff(row.gameId, 'squads');
    return;
  }
  const placed = kind === 'gift' ? row.status !== 'draft' : row.lat != null;
  const move = !!opts.move;
  if (move && !placed) throw err(409, 'Non è ancora piazzato: assegnalo da piazzare');
  const target = 'targetLat' in opts ? readTarget(opts) : { lat: row.targetLat, lng: row.targetLng };
  const note = 'note' in opts ? String(opts.note || '').trim().slice(0, 300) || null : row.taskNote;
  q.run(`UPDATE ${table} SET squadId = ?, targetLat = ?, targetLng = ?, taskNote = ?, moveRequestedAt = ? WHERE id = ?`,
    s.id, target.lat, target.lng, note, move ? Date.now() : null, row.id);
  if (row.squadId && row.squadId !== s.id) notifySquad(row.squadId, null);
  G.log(row.gameId, actor, move ? 'squad_move' : 'squad_assigned', { item: row.label, squad: s.name, target: target.lat != null });
  // Solo se c'è davvero qualcosa da fare (un punto già piazzato e non da spostare è solo un'attribuzione).
  if (move || !placed) {
    notifySquad(s.id, { title: `Incarico per la squadra ${s.name}`, body: `${move ? 'Spostate' : 'Piazzate'}: ${row.label}${target.lat != null ? ' · punto indicato sulla mappa' : ''}${note ? ` · ${note}` : ''}`, tag: `task-${kind}-${row.id}` });
  } else notifySquad(s.id, null);
}

function createTask(gameId, data, actor) {
  const s = getSquad(data.squadId);
  if (s.gameId !== Number(gameId)) throw err(400, 'Squadra di un\'altra partita');
  const text = String(data.text || '').trim().slice(0, 300);
  if (!text) throw err(400, 'Scrivi l\'incarico');
  const id = Number(q.run('INSERT INTO squad_tasks (gameId, squadId, text, createdAt) VALUES (?, ?, ?, ?)', s.gameId, s.id, text, Date.now()).lastInsertRowid);
  G.log(s.gameId, actor, 'squad_task', { squad: s.name, text });
  notifySquad(s.id, { title: `Incarico per la squadra ${s.name}`, body: text, tag: `task-${id}` });
  return { id };
}

function setTaskDone(taskId, done, who, gameId = null) {
  const t = q.get('SELECT * FROM squad_tasks WHERE id = ?', Number(taskId));
  if (!t || (gameId && t.gameId !== Number(gameId))) throw err(404, 'Incarico non trovato');
  q.run('UPDATE squad_tasks SET doneAt = ?, doneBy = ? WHERE id = ?', done ? Date.now() : null, done ? who : null, t.id);
  G.log(t.gameId, who, done ? 'squad_task_done' : 'squad_task_reopened', { text: t.text });
  notifySquad(t.squadId, null);
}

function deleteTask(taskId, actor) {
  const t = q.get('SELECT * FROM squad_tasks WHERE id = ?', Number(taskId));
  if (!t) throw err(404, 'Incarico non trovato');
  q.run('DELETE FROM squad_tasks WHERE id = ?', t.id);
  G.log(t.gameId, actor, 'squad_task_deleted', { text: t.text });
  notifySquad(t.squadId, null);
}

// ---------------------------------------------------------------- posizioni GPS

const POSITION_MAX_AGE = 30 * 60000; // dopo 30 minuti senza aggiornamenti il telefono sparisce dalla mappa
const POSITION_STALE = 5 * 60000; // dopo 5 minuti il segnaposto si sbiadisce

// Le coppie si vedono in mappa solo a partita iniziata; gli Eletti già dalla preparazione.
function trackingActive(team, status) {
  if (team.kind === 'couple') return [...C.ACTIVE, 'paused'].includes(status) && team.status !== 'withdrawn';
  if (team.kind === 'elect') return status !== 'ended';
  return false;
}

function recordPosition(team, player, body) {
  const game = G.getGame(team.gameId);
  if (!trackingActive(team, game.status)) return { ok: true, tracking: false };
  const lat = parseFloat(body.lat);
  const lng = parseFloat(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw err(400, 'Posizione non valida');
  const deviceId = String(body.deviceId || '').replace(/[^\w-]/g, '').slice(0, 40);
  if (deviceId.length < 8) throw err(400, 'Dispositivo non valido');
  const acc = Number.isFinite(parseFloat(body.acc)) ? Math.round(parseFloat(body.acc)) : null;
  q.run(`INSERT INTO positions (deviceId, gameId, teamId, playerId, lat, lng, acc, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(deviceId) DO UPDATE SET gameId = excluded.gameId, teamId = excluded.teamId, playerId = excluded.playerId,
         lat = excluded.lat, lng = excluded.lng, acc = excluded.acc, at = excluded.at`,
    deviceId, game.id, team.id, player?.id ?? null, lat, lng, acc, Date.now());
  return { ok: true, tracking: true };
}

// viewer: 'master' (tutti) oppure 'elect' (solo gli Eletti).
function positionsOf(gameId, viewer = 'master') {
  const now = Date.now();
  const rows = q.all(`SELECT pos.*, t.kind, t.displayName, s.name AS sectorName, s.roman, pl.name AS playerName, pl.nickname, pl.squadId,
                        sq.name AS squadName, sq.color AS squadColor
                      FROM positions pos JOIN teams t ON t.id = pos.teamId
                      LEFT JOIN sectors s ON s.id = t.sectorId
                      LEFT JOIN players pl ON pl.id = pos.playerId
                      LEFT JOIN elect_squads sq ON sq.id = pl.squadId
                      WHERE pos.gameId = ? AND pos.at > ?`, Number(gameId), now - POSITION_MAX_AGE);
  return rows.filter((r) => viewer === 'master' || r.kind === 'elect').map((r) => ({
    deviceId: r.deviceId, kind: r.kind === 'elect' ? 'elect' : 'team', lat: r.lat, lng: r.lng, acc: r.acc, at: r.at, stale: now - r.at > POSITION_STALE,
    label: r.kind === 'elect' ? (r.nickname || r.playerName || 'Eletto') : `${r.roman} ${r.sectorName}`,
    who: r.kind === 'elect' ? (r.squadName ? `Squadra ${r.squadName}` : 'Eletti del Consiglio') : (r.nickname || r.playerName || r.displayName || 'coppia'),
    roman: r.roman, color: r.kind === 'elect' ? (r.squadColor || '#d1ad62') : '#3b82f6',
  }));
}

// Riepilogo per la home degli Eletti: la propria squadra e cosa resta da fare.
function electSummary(team, player) {
  const squadId = player?.squadId || null;
  const squad = squadId ? q.get('SELECT id, name, color FROM elect_squads WHERE id = ?', squadId) : null;
  if (!squad) return { squad: null, todo: null };
  const todo = q.get('SELECT COUNT(*) AS n FROM points WHERE squadId = ? AND (lat IS NULL OR moveRequestedAt IS NOT NULL)', squad.id).n
    + q.get("SELECT COUNT(*) AS n FROM gifts WHERE squadId = ? AND status NOT IN ('claimed', 'expired') AND (status = 'draft' OR moveRequestedAt IS NOT NULL)", squad.id).n
    + q.get('SELECT COUNT(*) AS n FROM landmarks WHERE squadId = ? AND (lat IS NULL OR moveRequestedAt IS NOT NULL)', squad.id).n
    + q.get('SELECT COUNT(*) AS n FROM squad_tasks WHERE squadId = ? AND doneAt IS NULL', squad.id).n;
  return { squad, todo };
}

// Per le coppie: Altari piazzati e doni comparsi (non ancora presi). Il tipo del dono resta una sorpresa.
function teamMap(team) {
  if (team.kind === 'lobby') return null;
  return {
    points: q.all(`SELECT p.id, p.label, p.lat, p.lng, p.sectorId, s.name AS sectorName, s.roman FROM points p JOIN sectors s ON s.id = p.sectorId
                   WHERE p.gameId = ? AND p.lat IS NOT NULL ORDER BY s.ord`, team.gameId)
      .map((p) => ({ ...p, mine: p.sectorId === team.sectorId })),
    landmarks: q.all('SELECT id, kind, label, lat, lng FROM landmarks WHERE gameId = ? AND lat IS NOT NULL', team.gameId),
    gifts: q.all("SELECT id, label, lat, lng, revealedAt, expiresAfterMin, revealElapsedMs FROM gifts WHERE gameId = ? AND status = 'revealed' AND lat IS NOT NULL", team.gameId)
      .map((g) => ({ id: g.id, label: g.label, lat: g.lat, lng: g.lng, revealedAt: g.revealedAt, expiresAtElapsedMs: g.expiresAfterMin && g.revealElapsedMs != null ? g.revealElapsedMs + g.expiresAfterMin * 60000 : null })),
  };
}

function teamGifts(team) {
  return q.all('SELECT * FROM gifts WHERE claimedByTeamId = ? ORDER BY claimedAt DESC', team.id)
    .map((g) => ({ id: g.id, label: g.label, name: g.name, icon: g.icon, color: g.color, description: g.description, claimedAt: g.claimedAt, usedAt: g.usedAt }));
}

// ---------------------------------------------------------------- azioni delle coppie

function claimGift(team, token) {
  if (team.kind === 'elect') throw err(403, 'Gli Eletti piazzano i doni, non li prendono');
  const game = G.getGame(team.gameId);
  if (!C.ACTIVE.includes(game.status)) throw err(409, game.status === 'paused' ? 'Partita sospesa' : 'I doni si prendono a partita in corso');
  const g = q.get('SELECT * FROM gifts WHERE gameId = ? AND qrToken = ?', game.id, String(token || ''));
  if (!g) throw err(404, 'Dono non riconosciuto per questa partita');
  if (g.status === 'claimed') {
    if (g.claimedByTeamId === team.id) return { ok: true, already: true, gift: teamGifts(team).find((x) => x.id === g.id) };
    const t = q.get('SELECT s.name FROM teams t JOIN sectors s ON s.id = t.sectorId WHERE t.id = ?', g.claimedByTeamId);
    throw err(409, `Troppo tardi: questo dono l'ha già preso il Settore ${t?.name || '?'}`);
  }
  if (g.status === 'expired') throw err(409, 'Troppo tardi: il dono è svanito');
  if (g.status !== 'revealed') throw err(409, 'Questo dono non è ancora comparso: il Consiglio lo farà comparire più tardi');
  const r = q.run("UPDATE gifts SET status = 'claimed', claimedByTeamId = ?, claimedAt = ? WHERE id = ? AND status = 'revealed'", team.id, Date.now(), g.id);
  if (!r.changes) throw err(409, 'Troppo tardi: un\'altra coppia è stata più veloce');
  G.log(game.id, `coppia:${team.id}`, 'gift_claimed', { teamId: team.id, label: g.label, type: g.name });
  // Notifica a coppie ed Eletti (senza dire chi l'ha preso): il dono sparisce dalle loro mappe.
  G.announce(game.id, 'gift_taken', {}, { giftId: g.id });
  rt.toStaff(game.id, 'gifts');
  const s = q.get('SELECT name FROM sectors WHERE id = ?', team.sectorId);
  rt.pushMasters({ title: 'Dono preso', body: `${g.label} (${g.name}) preso dal Settore ${s?.name || '?'}`, url: '/regia#mappa' });
  return { ok: true, gift: teamGifts(team).find((x) => x.id === g.id) };
}

function useGift(team, giftId) {
  const g = q.get('SELECT * FROM gifts WHERE id = ? AND claimedByTeamId = ?', Number(giftId), team.id);
  if (!g) throw err(404, 'Dono non trovato tra i vostri');
  if (g.usedAt) return { ok: true, already: true };
  q.run('UPDATE gifts SET usedAt = ? WHERE id = ?', Date.now(), g.id);
  G.log(team.gameId, `coppia:${team.id}`, 'gift_used', { teamId: team.id, label: g.label, type: g.name });
  rt.toStaff(team.gameId, 'gifts');
  return { ok: true };
}

module.exports = {
  recordPosition, positionsOf, trackingActive, squadsOf, createSquad, updateSquad, deleteSquad, setMemberSquad, assignToSquad, createTask, setTaskDone, deleteTask, electSummary,
  giftTypes, saveGiftTypes, createGifts, scheduleGiftReveal, updateGift, deleteGift, resetGift, revealGift, tickAll,
  placePoint, placeGift, placeLandmark, resolveToken, photoFile, fieldState, teamMap, teamGifts, claimGift, useGift,
};
