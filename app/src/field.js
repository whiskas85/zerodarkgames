'use strict';
// Campo: piazzamento di Altari e Doni (foto + coordinate dal telefono di Eletti o Master), doni QR e mappe.
const fs = require('fs');
const path = require('path');
const { q, tx, DATA_DIR } = require('./db');
const C = require('./constants');
const { buildKmz } = require('./kmz');
const G = require('./game');
const rt = require('./realtime');
const { randomToken, randomCode, HttpError } = require('./util');

const err = (status, msg) => new HttpError(status, msg);
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// ---------------------------------------------------------------- catalogo dei tipi di dono

// Tipi di dono: il catalogo fisso dei Doni con effetto (skills.js). Quelli non ancora disponibili non si creano.
function giftTypes(game = null) {
  const S = require('./skills');
  return S.GIFTS.filter((t) => !t.phase || t.phase <= 1).map((t) => S.giftForGame(t, game || {}))
    .map((t) => ({ id: t.id, name: t.name, icon: t.icon, color: t.color, description: t.description }));
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
    provisional: !!g.provisional,
    ...taskFields(g),
    revealedAt: g.revealedAt, claimedAt: g.claimedAt, usedAt: g.usedAt, expiredAt: g.expiredAt,
    revealDelayMin: g.revealDelayMin || null, removeSign: g.removeSign !== 0, multi: !!g.multi,
    // Resta attivo dopo la lettura: le coppie che l'hanno già preso.
    takenBy: g.multi ? q.all('SELECT s.name, s.roman, c.claimedAt FROM gifts c JOIN teams t ON t.id = c.claimedByTeamId LEFT JOIN sectors s ON s.id = t.sectorId WHERE c.parentGiftId = ? ORDER BY c.claimedAt', g.id)
      .map((x) => `${x.roman || ''} ${x.name || ''}`.trim()) : [],
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
  const type = giftTypes(game).find((t) => t.id === data.typeId);
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
  const revealDelayMin = readDelay(data.revealDelayMin);
  // Titolo scelto dalla regia (facoltativo): con più doni si numera («Cassa 1», «Cassa 2»…); altrimenti «Dono N».
  const title = String(data.label || '').trim().slice(0, 36);
  const multi = data.multi === true || data.multi === 1 || data.multi === '1' ? 1 : 0;
  const removeSign = data.removeSign === false || data.removeSign === 0 || data.removeSign === '0' ? 0 : 1;
  const squad = data.squadId ? getSquad(data.squadId) : null;
  if (squad && squad.gameId !== game.id) throw err(400, 'Squadra di un\'altra partita');
  const target = readTarget(data);
  const note = String(data.note || '').trim().slice(0, 300) || null;
  const ids = tx(() => {
    let n = q.get('SELECT COUNT(*) AS n FROM gifts WHERE gameId = ? AND parentGiftId IS NULL', game.id).n;
    const out = [];
    for (let i = 0; i < count; i++) {
      n += 1;
      out.push(Number(q.run(`INSERT INTO gifts (gameId, typeId, name, icon, color, description, label, qrToken, revealMode, revealAtMin, expiresAfterMin, squadId, targetLat, targetLng, taskNote, createdAt, revealDelayMin, removeSign, multi)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        game.id, type.id, type.name, type.icon, type.color, type.description, title ? (count > 1 ? `${title} ${i + 1}` : title) : `Dono ${n}`, randomToken(18), revealMode, revealAtMin, expiresAfterMin,
        squad?.id ?? null, target.lat, target.lng, note, Date.now(), revealDelayMin, removeSign, multi).lastInsertRowid));
    }
    return out;
  });
  G.log(game.id, actor, 'gifts_created', { type: type.name, count });
  if (squad) notifySquad(squad.id, { title: `Incarico per la squadra ${squad.name}`, body: `Piazzate ${count > 1 ? `${count} doni` : 'un dono'} (${type.name})${target.lat != null ? ' nel punto indicato sulla mappa' : ''}`, tag: `task-gifts-${ids[0]}` });
  rt.toStaff(game.id, 'gifts');
  return { ids };
}

// Ritardo dopo l'annuncio (minuti, facoltativo).
function readDelay(v) {
  if (v === undefined || v === null || v === '') return null;
  const m = parseFloat(v);
  if (!Number.isFinite(m) || m < 0 || m > 600) throw err(400, 'Ritardo non valido (minuti dopo l\'annuncio)');
  return m || null;
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
  } else if (mode === 'now' && g.revealDelayMin > 0) {
    // Ritardo all'annuncio: il dono compare N minuti dopo questo annuncio (o appena piazzato, se arriva dopo).
    const at = Date.now() + g.revealDelayMin * 60000;
    q.run("UPDATE gifts SET revealMode = 'at', revealAt = ? WHERE id = ?", at, g.id);
    G.log(g.gameId, actor, 'gift_scheduled', { label: g.label, at, ritardo: g.revealDelayMin });
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
  if (data.revealDelayMin !== undefined) { sets.push('revealDelayMin = ?'); vals.push(readDelay(data.revealDelayMin)); }
  if (data.removeSign !== undefined) { sets.push('removeSign = ?'); vals.push(data.removeSign ? 1 : 0); }
  if (data.multi !== undefined) { sets.push('multi = ?'); vals.push(data.multi ? 1 : 0); }
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

// Partita riportata in preparazione: i doni già piazzati (o presi) tornano tutti da piazzare, senza posizione
// né foto; le copie dei doni «per tutti» lette dalle coppie si tolgono.
function resetAllGifts(gameId, actor) {
  const list = q.all("SELECT id, photoFile FROM gifts WHERE gameId = ? AND parentGiftId IS NULL AND (status != 'draft' OR lat IS NOT NULL)", gameId);
  q.run('DELETE FROM gifts WHERE gameId = ? AND parentGiftId IS NOT NULL', gameId);
  q.run(`UPDATE gifts SET status = 'draft', lat = NULL, lng = NULL, accuracy = NULL, photoFile = NULL, placedAt = NULL, placedBy = NULL, placedSquadId = NULL,
         placeSource = NULL, provisional = 0, moveRequestedAt = NULL, revealedAt = NULL, revealElapsedMs = NULL, expiredAt = NULL, publicAt = NULL,
         hintLat = NULL, hintLng = NULL, claimedByTeamId = NULL, claimedAt = NULL, usedAt = NULL WHERE gameId = ?`, gameId);
  for (const g of list) removePhoto(g.photoFile);
  if (list.length) G.log(gameId, actor, 'gifts_reset_all', { count: list.length });
  return list.length;
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
  // Presagio del Dono: se una coppia ha la passiva, l'annuncio a tutti arriva 5 minuti dopo.
  if (!require('./skills').onGiftRevealed(g)) G.announce(g.gameId, 'gift', {}, { giftId: g.id });
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
  const prov = !!body.provisional;
  const p = readPlacement(body, !!body.photoOptional || prov);
  const file = p.buffer ? savePhoto('altare', pt.id, p) : null;
  q.run('UPDATE points SET lat = ?, lng = ?, accuracy = ?, photoFile = ?, placedAt = ?, placedBy = ?, placeSource = ?, placedSquadId = ?, moveRequestedAt = NULL, provisional = ? WHERE id = ?',
    p.lat, p.lng, p.acc, file, Date.now(), who, p.source, placerSquad(pt.gameId, squadId, pt.squadId), prov ? 1 : 0, pt.id);
  removePhoto(pt.photoFile);
  G.log(pt.gameId, who, prov ? 'point_placed_provisional' : pt.moveRequestedAt ? 'point_moved' : 'point_placed', { label: pt.label, accuracy: p.acc, source: p.source });
  rt.toStaff(pt.gameId, 'placed');
  rt.toTeams(pt.gameId, 'state', {});
  return { ok: true, label: pt.label, provisional: prov };
}

function placeGift(giftId, gameId, body, who, squadId = null) {
  const g = q.get('SELECT * FROM gifts WHERE id = ? AND gameId = ?', Number(giftId), Number(gameId));
  if (!g) throw err(404, 'Dono non trovato in questa partita');
  if (g.status === 'claimed') throw err(409, 'Questo dono è già stato preso');
  if (g.status === 'expired') throw err(409, 'Questo dono è svanito: la regia può riportarlo da piazzare');
  if (G.getGame(g.gameId).status === 'ended') throw err(409, 'La partita è terminata');
  const prov = !!body.provisional;
  const p = readPlacement(body, !!body.photoOptional || prov);
  const file = p.buffer ? savePhoto('dono', g.id, p) : null;
  const status = g.status === 'revealed' ? 'revealed' : 'placed';
  q.run('UPDATE gifts SET status = ?, lat = ?, lng = ?, accuracy = ?, photoFile = ?, placedAt = ?, placedBy = ?, placeSource = ?, placedSquadId = ?, moveRequestedAt = NULL, provisional = ? WHERE id = ?',
    status, p.lat, p.lng, p.acc, file, Date.now(), who, p.source, placerSquad(g.gameId, squadId, g.squadId), prov ? 1 : 0, g.id);
  removePhoto(g.photoFile);
  G.log(g.gameId, who, prov ? 'gift_placed_provisional' : 'gift_placed', { label: g.label, type: g.name, accuracy: p.acc });
  // Provvisorio: niente annuncio «appena piazzato», arriva con il piazzamento definitivo.
  if (status === 'placed' && g.revealMode === 'onplace' && !prov) revealGift(g.id, who);
  rt.toStaff(g.gameId, 'placed');
  rt.toTeams(g.gameId, 'state', {});
  return { ok: true, label: g.label, provisional: prov, revealed: (g.revealMode === 'onplace' && !prov) || status === 'revealed' };
}

// Luoghi del gioco (Soglia, Cerchio di inizio): come gli Altari, ma la foto è facoltativa.
function placeLandmark(id, gameId, body, who, squadId = null) {
  const l = q.get('SELECT * FROM landmarks WHERE id = ? AND gameId = ?', Number(id), Number(gameId));
  if (!l) throw err(404, 'Luogo non trovato in questa partita');
  if (G.getGame(l.gameId).status === 'ended') throw err(409, 'La partita è terminata');
  const prov = !!body.provisional;
  const p = readPlacement(body, true);
  const file = p.buffer ? savePhoto(l.kind, l.id, p) : null;
  q.run('UPDATE landmarks SET lat = ?, lng = ?, accuracy = ?, photoFile = ?, placedAt = ?, placedBy = ?, placeSource = ?, placedSquadId = ?, moveRequestedAt = NULL, provisional = ? WHERE id = ?',
    p.lat, p.lng, p.acc, file, Date.now(), who, p.source, placerSquad(l.gameId, squadId, l.squadId), prov ? 1 : 0, l.id);
  removePhoto(l.photoFile);
  G.log(l.gameId, who, 'landmark_placed', { label: l.label, accuracy: p.acc, source: p.source });
  rt.toStaff(l.gameId, 'placed');
  rt.toTeams(l.gameId, 'state', {});
  return { ok: true, label: l.label, provisional: prov };
}

const landmarkOut = (l) => ({
  id: l.id, kind: l.kind, label: l.label, lat: l.lat, lng: l.lng, accuracy: l.accuracy, placedAt: l.placedAt, placedBy: l.placedBy,
  placeSource: l.placeSource, hasPhoto: !!l.photoFile, squadId: l.squadId, provisional: !!l.provisional, ...taskFields(l),
});

// Cartello scansionato sul campo: Altare (/a/…) o Dono (/d/…).
// anyGame (regia): un cartello di un'altra partita aperta si riconosce lo stesso e si dice di quale partita è.
function resolveToken(gameId, text, anyGame = false) {
  const s = String(text || '');
  if (anyGame) {
    const tok = s.match(/\/(a|d)\/([\w-]+)/);
    const row = tok && q.get(`SELECT x.id, x.label, x.gameId, g.name AS gameName FROM ${tok[1] === 'a' ? 'points' : 'gifts'} x JOIN games g ON g.id = x.gameId
      WHERE x.qrToken = ? AND g.status NOT IN ('ended', 'created')`, tok[2]);
    if (row && row.gameId !== Number(gameId)) return { kind: tok[1] === 'a' ? 'point' : 'gift', id: row.id, label: row.label, gameId: row.gameId, gameName: row.gameName };
  }
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
  const couples = new Set(q.all('SELECT sectorId FROM teams WHERE gameId = ? AND sectorId IS NOT NULL', game.id).map((r) => r.sectorId));
  const points = q.all(`SELECT p.*, s.name AS sectorName, s.roman, s.ord, s.color AS sectorColor FROM points p JOIN sectors s ON s.id = p.sectorId WHERE p.gameId = ? ORDER BY s.ord`, game.id)
    .map((p) => ({
      id: p.id, label: p.label, sectorId: p.sectorId, sectorName: p.sectorName, roman: p.roman, color: p.sectorColor, locationNote: p.locationNote,
      lat: p.lat, lng: p.lng, accuracy: p.accuracy, placedAt: p.placedAt, placedBy: p.placedBy, placeSource: p.placeSource, hasPhoto: !!p.photoFile,
      squadId: p.squadId, provisional: !!p.provisional, free: !couples.has(p.sectorId), ...taskFields(p),
    }));
  return {
    game: { id: game.id, name: game.name, status: game.status },
    clock: G.clockOf(game),
    points,
    // Alla regia anche il token del QR: il cartello si vede (e si stampa) dalla tabella.
    gifts: q.all('SELECT * FROM gifts WHERE gameId = ? AND parentGiftId IS NULL ORDER BY id', game.id).map((g) => ({ ...giftOut(g), qrToken: g.qrToken })),
    giftTypes: giftTypes(game),
    squads: squadsOf(game.id),
    // Incarichi generati da Skill e Doni (o creati senza squadra): da assegnare.
    openTasks: q.all('SELECT * FROM squad_tasks WHERE gameId = ? AND squadId IS NULL AND doneAt IS NULL AND cancelledAt IS NULL ORDER BY id', game.id),
    landmarks: G.landmarksOf(game.id).map(landmarkOut),
    pois: poisOf(game.id),
    guide: guideOf(game.id),
  };
}

// ---------------------------------------------------------------- indicazioni campo

// Parcheggio, accettazione e simili: le coppie (e chi è iscritto ma non ancora in coppia) li vedono fino al Cerchio.
const GUIDE_STATUSES = ['draft', 'ready'];
const guideOut = (x) => ({ id: x.id, label: x.label, description: x.description, icon: x.icon || 'mapMarker', lat: x.lat, lng: x.lng });
const guideOf = (gameId) => q.all('SELECT * FROM guide_points WHERE gameId = ? ORDER BY id', gameId).map(guideOut);
function teamGuide(gameId) {
  return GUIDE_STATUSES.includes(G.getGame(gameId).status) ? guideOf(gameId) : [];
}

function readGuide(body, old = null) {
  const label = body.label !== undefined ? String(body.label || '').trim().slice(0, 60) : old?.label;
  if (!label) throw err(400, 'Dai un nome al punto');
  const description = body.description !== undefined ? String(body.description || '').trim().slice(0, 300) || null : old?.description ?? null;
  const icon = body.icon !== undefined ? String(body.icon || '').replace(/[^\w]/g, '').slice(0, 40) || null : old?.icon ?? null;
  let { lat, lng } = old || {};
  if (body.lat !== undefined || body.lng !== undefined) {
    lat = parseFloat(body.lat);
    lng = parseFloat(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw err(400, 'Posizione non valida');
  }
  if (lat == null || lng == null) throw err(400, 'Scegli il punto sulla mappa');
  return { label, description, icon, lat, lng };
}

const guideChanged = (gameId) => { rt.toStaff(gameId, 'guide'); rt.toTeams(gameId, 'state', {}); };

function createGuide(gameId, body, who) {
  const g = G.getGame(gameId);
  const p = readGuide(body || {});
  const id = Number(q.run('INSERT INTO guide_points (gameId, label, description, icon, lat, lng, createdAt, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    g.id, p.label, p.description, p.icon, p.lat, p.lng, Date.now(), who).lastInsertRowid);
  G.log(g.id, who, 'guide_created', { label: p.label });
  guideChanged(g.id);
  return guideOut(q.get('SELECT * FROM guide_points WHERE id = ?', id));
}

function updateGuide(id, gameId, body, who) {
  const old = q.get('SELECT * FROM guide_points WHERE id = ? AND gameId = ?', Number(id), Number(gameId));
  if (!old) throw err(404, 'Indicazione non trovata');
  const p = readGuide(body || {}, old);
  q.run('UPDATE guide_points SET label = ?, description = ?, icon = ?, lat = ?, lng = ?, updatedAt = ? WHERE id = ?', p.label, p.description, p.icon, p.lat, p.lng, Date.now(), old.id);
  guideChanged(old.gameId);
  return guideOut(q.get('SELECT * FROM guide_points WHERE id = ?', old.id));
}

function deleteGuide(id, gameId, who) {
  const old = q.get('SELECT * FROM guide_points WHERE id = ? AND gameId = ?', Number(id), Number(gameId));
  if (!old) throw err(404, 'Indicazione non trovata');
  q.run('DELETE FROM guide_points WHERE id = ?', old.id);
  G.log(old.gameId, who, 'guide_deleted', { label: old.label });
  guideChanged(old.gameId);
}

// ---------------------------------------------------------------- punti di interesse

const poiOut = (x) => ({ id: x.id, label: x.label, description: x.description, lat: x.lat, lng: x.lng, accuracy: x.accuracy, createdAt: x.createdAt, createdBy: x.createdBy });
// Un punto di interesse è un segnaposto: se un Altare, un luogo o un Dono ci viene messo sopra, il punto è «occupato»
// e non si mostra più sulle mappe (torna visibile se l'oggetto si sposta altrove).
function poisOf(gameId) {
  const taken = [
    ...q.all('SELECT lat, lng FROM points WHERE gameId = ? AND lat IS NOT NULL', gameId),
    ...q.all('SELECT lat, lng FROM landmarks WHERE gameId = ? AND lat IS NOT NULL', gameId),
    ...q.all("SELECT lat, lng FROM gifts WHERE gameId = ? AND lat IS NOT NULL AND status NOT IN ('claimed', 'expired')", gameId),
  ];
  const near = (a, b) => Math.abs(a.lat - b.lat) < 0.00002 && Math.abs(a.lng - b.lng) < 0.00003; // ~2 m
  return q.all('SELECT * FROM pois WHERE gameId = ? ORDER BY label COLLATE NOCASE, id', gameId)
    .map((x) => ({ ...poiOut(x), occupied: x.lat != null && taken.some((t) => near(t, x)) }));
}

function readPoi(body, old = null) {
  const label = body.label !== undefined ? String(body.label || '').trim().slice(0, 60) : old?.label;
  if (!label) throw err(400, 'Dai un nome al punto');
  const description = body.description !== undefined ? String(body.description || '').trim().slice(0, 500) || null : old?.description ?? null;
  let { lat, lng } = old || {};
  let acc = old?.accuracy ?? null;
  if (body.lat !== undefined || body.lng !== undefined) {
    lat = parseFloat(body.lat);
    lng = parseFloat(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw err(400, 'Posizione non valida');
    acc = Number.isFinite(parseFloat(body.acc)) ? Math.round(parseFloat(body.acc)) : null;
  }
  return { label, description, lat, lng, acc };
}

const poiChanged = (gameId) => { rt.toStaff(gameId, 'pois'); rt.toTeams(gameId, 'state', {}); };

function createPoi(gameId, body, who) {
  const g = G.getGame(gameId);
  const p = readPoi(body || {});
  const id = Number(q.run('INSERT INTO pois (gameId, label, description, lat, lng, accuracy, createdAt, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    g.id, p.label, p.description, p.lat, p.lng, p.acc, Date.now(), who).lastInsertRowid);
  G.log(g.id, who, 'poi_created', { label: p.label });
  poiChanged(g.id);
  return poiOut(q.get('SELECT * FROM pois WHERE id = ?', id));
}

function updatePoi(id, gameId, body, who) {
  const old = q.get('SELECT * FROM pois WHERE id = ? AND gameId = ?', Number(id), Number(gameId));
  if (!old) throw err(404, 'Punto di interesse non trovato');
  const p = readPoi(body || {}, old);
  q.run('UPDATE pois SET label = ?, description = ?, lat = ?, lng = ?, accuracy = ?, updatedAt = ? WHERE id = ?', p.label, p.description, p.lat, p.lng, p.acc, Date.now(), old.id);
  G.log(old.gameId, who, 'poi_updated', { label: p.label });
  poiChanged(old.gameId);
  return poiOut(q.get('SELECT * FROM pois WHERE id = ?', old.id));
}

function deletePoi(id, gameId, who) {
  const old = q.get('SELECT * FROM pois WHERE id = ? AND gameId = ?', Number(id), Number(gameId));
  if (!old) throw err(404, 'Punto di interesse non trovato');
  q.run('DELETE FROM pois WHERE id = ?', old.id);
  G.log(old.gameId, who, 'poi_deleted', { label: old.label });
  poiChanged(old.gameId);
}

// ---------------------------------------------------------------- KMZ per ATAK

const GIFT_LABEL = { draft: 'da piazzare', placed: 'piazzato, non ancora comparso', revealed: 'comparso in mappa', claimed: 'preso', expired: 'svanito' };
const when = (ms) => (ms ? new Date(ms).toLocaleString('it-IT', { timeZone: process.env.TZ || 'Europe/Rome', dateStyle: 'short', timeStyle: 'short' }) : '');
const kmzName = (game) => `giochi-del-buio-${String(game.name || game.id).toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || game.id}.kmz`;
const placeDesc = (x) => [
  x.provisional ? '⚠ Piazzamento provvisorio: da confermare' : null,
  x.placedAt ? `Piazzato ${when(x.placedAt)}${x.placedBy ? ` da ${String(x.placedBy).replace('eletti:', '')}` : ''}${x.accuracy ? ` · ±${x.accuracy} m` : ''}` : null,
].filter(Boolean);

// Regia ed Eletti: tutti i punti piazzati (luoghi, Altari, Doni) e i punti indicati per gli incarichi ancora da fare.
function orgKmz(gameId) {
  const st = fieldState(gameId);
  const squad = Object.fromEntries(st.squads.map((x) => [x.id, x.name]));
  const pending = (x) => x.lat == null || x.moveRequestedAt || x.provisional;
  const folders = [
    { name: 'Luoghi', items: st.landmarks.map((l) => ({ name: l.label, lat: l.lat, lng: l.lng, shape: 'circle', color: l.kind === 'soglia' ? '#c0392b' : '#d1ad62', provisional: l.provisional,
      description: placeDesc(l).join('<br>') })) },
    { name: 'Altari', items: st.points.map((p) => ({ name: `${p.roman} · ${p.label}${p.provisional ? ' (provvisorio)' : ''}`, lat: p.lat, lng: p.lng, shape: 'square', color: p.color, provisional: p.provisional,
      description: [`Settore ${p.sectorName}${p.free ? ' · Altare senza coppia' : ''}`, p.locationNote, ...placeDesc(p)].filter(Boolean).join('<br>') })) },
    { name: 'Doni', items: st.gifts.filter((g) => !['claimed', 'expired'].includes(g.status)).map((g) => ({ name: `${g.label} · ${g.name}${g.provisional ? ' (provvisorio)' : ''}`, lat: g.lat, lng: g.lng, shape: 'circle', color: g.color, provisional: g.provisional,
      description: [`Stato: ${GIFT_LABEL[g.status] || g.status}`, ...placeDesc(g)].join('<br>') })) },
    { name: 'Punti di interesse', items: st.pois.map((x) => ({ name: x.label, lat: x.lat, lng: x.lng, shape: 'diamond', color: '#b07ad9', description: x.description || '' })) },
    { name: 'Punti indicati dalla regia', items: [...st.points, ...st.gifts.filter((g) => !['claimed', 'expired'].includes(g.status)), ...st.landmarks]
      .filter((x) => x.targetLat != null && pending(x))
      .map((x) => ({ name: `Da piazzare: ${x.label}`, lat: x.targetLat, lng: x.targetLng, shape: 'ring', color: '#ffffff',
        description: [x.squadId ? `Squadra ${squad[x.squadId] || '?'}` : null, x.taskNote ? `Nota: ${x.taskNote}` : null].filter(Boolean).join('<br>') })) },
  ];
  return { name: kmzName(st.game), data: buildKmz(`${st.game.name} · tutti i punti`, folders) };
}

// Coppie: solo ciò che vedono sulla loro mappa (gli Altari dal via, i Doni comparsi).
function teamKmz(team) {
  const game = G.getGame(team.gameId);
  const m = teamMap(team);
  const folders = [
    { name: 'Luoghi', items: m.landmarks.map((l) => ({ name: l.label, lat: l.lat, lng: l.lng, shape: 'circle', color: l.kind === 'soglia' ? '#c0392b' : '#d1ad62' })) },
    { name: 'Altari', items: m.points.map((p) => ({ name: `${p.roman} · ${p.label}`, lat: p.lat, lng: p.lng, shape: 'square', color: p.mine ? '#d1ad62' : '#e0603f', description: `Settore ${p.sectorName}${p.mine ? ' · il vostro' : ''}` })) },
    { name: 'Doni', items: m.gifts.map((g) => ({ name: `Dono ${g.label}`, lat: g.lat, lng: g.lng, shape: 'circle', color: '#d1ad62' })) },
  ];
  return { name: kmzName(game), data: buildKmz(game.name, folders) };
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
    tasks: q.all('SELECT * FROM squad_tasks WHERE squadId = ? ORDER BY doneAt IS NOT NULL OR cancelledAt IS NOT NULL, id', s.id),
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

// Incarichi degli Eletti. kind: text (libero), goto (raggiungere un punto o una coppia), hunt (caccia a una coppia,
// da Maestro della caccia), meet (incontro con una coppia per Alleanze sporche). Senza squadra = da assegnare.
const TASK_KINDS = ['text', 'goto', 'hunt', 'meet'];

// Bersaglio: "team:ID", "point:ID", "landmark:ID", "poi:ID", "gift:ID" oppure { lat, lng }.
function taskTarget(gameId, data) {
  const ref = String(data.target || '');
  const [kind, raw] = ref.split(':');
  const id = Number(raw);
  if (kind === 'team') {
    const t = q.get("SELECT t.id, s.name, s.roman FROM teams t JOIN sectors s ON s.id = t.sectorId WHERE t.id = ? AND t.gameId = ? AND t.kind = 'couple'", id, gameId);
    if (!t) throw err(400, 'Coppia non valida');
    return { targetTeamId: t.id, targetLabel: `${t.roman} · Settore ${t.name}` };
  }
  const table = { point: 'points', landmark: 'landmarks', poi: 'pois', gift: 'gifts' }[kind];
  if (table) {
    const r = q.get(`SELECT * FROM ${table} WHERE id = ? AND gameId = ?`, id, gameId);
    if (!r || r.lat == null) throw err(400, 'Punto non valido o non ancora piazzato');
    return { targetLat: r.lat, targetLng: r.lng, targetLabel: r.label || r.name || 'Punto' };
  }
  const t = readTarget(data);
  return t.lat != null ? { targetLat: t.lat, targetLng: t.lng, targetLabel: String(data.targetLabel || 'Punto sulla mappa').slice(0, 80) } : {};
}

function createTask(gameId, data, actor, extra = {}) {
  const s = data.squadId ? getSquad(data.squadId) : null;
  if (s && s.gameId !== Number(gameId)) throw err(400, 'Squadra di un\'altra partita');
  const target = taskTarget(Number(gameId), data);
  let kind = TASK_KINDS.includes(data.kind) ? data.kind : 'text';
  if (kind === 'text' && (target.targetTeamId || target.targetLat != null)) kind = 'goto';
  const text = String(data.text || '').trim().slice(0, 300)
    || (kind === 'hunt' ? `Caccia: ${target.targetLabel}` : kind === 'goto' && target.targetLabel ? `Raggiungete ${target.targetLabel}` : '');
  if (!text) throw err(400, 'Scrivi l\'incarico');
  const now = Date.now();
  const id = Number(q.run(`INSERT INTO squad_tasks (gameId, squadId, text, createdAt, kind, targetTeamId, targetLat, targetLng, targetLabel, source, sourceTeamId, assignedAt)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  Number(gameId), s?.id ?? null, text, now, kind, target.targetTeamId ?? null, target.targetLat ?? null, target.targetLng ?? null, target.targetLabel ?? null,
  extra.source || 'regia', extra.sourceTeamId ?? null, s ? now : null).lastInsertRowid);
  G.log(Number(gameId), actor, 'squad_task', { squad: s?.name || null, text });
  if (s) notifySquad(s.id, { title: `Incarico per la squadra ${s.name}`, body: text, tag: `task-${id}` });
  rt.toStaff(Number(gameId), 'field');
  return { id };
}

function assignTask(taskId, squadId, actor) {
  const t = q.get('SELECT * FROM squad_tasks WHERE id = ?', Number(taskId));
  if (!t || t.doneAt || t.cancelledAt) throw err(404, 'Incarico non trovato o già chiuso');
  const s = getSquad(squadId);
  if (s.gameId !== t.gameId) throw err(400, 'Squadra di un\'altra partita');
  const prev = t.squadId;
  q.run('UPDATE squad_tasks SET squadId = ?, assignedAt = ? WHERE id = ?', s.id, Date.now(), t.id);
  G.log(t.gameId, actor, 'squad_task_assigned', { squad: s.name, text: t.text });
  if (prev && prev !== s.id) notifySquad(prev, { title: 'Incarico tolto', body: t.text, tag: `task-${t.id}` });
  notifySquad(s.id, { title: `Incarico per la squadra ${s.name}`, body: t.text, tag: `task-${t.id}` });
  if (t.kind === 'meet' && t.targetTeamId) {
    rt.pushTeams(t.gameId, { title: 'Alleanze sporche', body: `La squadra ${s.name} degli Eletti vi raggiunge: la vedete sulla mappa.`, tag: `meet-${t.id}`, url: '/#/mappa' }, t.targetTeamId);
    rt.toTeams(t.gameId, 'state', {}, t.targetTeamId);
  }
  rt.toStaff(t.gameId, 'field');
}

// Annullato (dalla regia, oppure perché la coppia bersaglio è entrata nell'Ombra).
function cancelTask(taskId, actor, why = null) {
  const t = q.get('SELECT * FROM squad_tasks WHERE id = ?', Number(taskId));
  if (!t || t.doneAt || t.cancelledAt) return false;
  q.run('UPDATE squad_tasks SET cancelledAt = ? WHERE id = ?', Date.now(), t.id);
  G.log(t.gameId, actor, 'squad_task_cancelled', { text: t.text, why });
  if (t.squadId) notifySquad(t.squadId, { title: why ? 'Abortite l\'incarico' : 'Incarico annullato', body: why || t.text, tag: `task-${t.id}` });
  if (t.targetTeamId) rt.toTeams(t.gameId, 'state', {}, t.targetTeamId);
  rt.toStaff(t.gameId, 'field');
  return true;
}

function setTaskDone(taskId, done, who, gameId = null) {
  const t = q.get('SELECT * FROM squad_tasks WHERE id = ?', Number(taskId));
  if (!t || (gameId && t.gameId !== Number(gameId))) throw err(404, 'Incarico non trovato');
  q.run('UPDATE squad_tasks SET doneAt = ?, doneBy = ? WHERE id = ?', done ? Date.now() : null, done ? who : null, t.id);
  G.log(t.gameId, who, done ? 'squad_task_done' : 'squad_task_reopened', { text: t.text });
  if (t.squadId) notifySquad(t.squadId, null);
  if (t.targetTeamId) rt.toTeams(t.gameId, 'state', {}, t.targetTeamId);
  rt.toStaff(t.gameId, 'field');
}

function deleteTask(taskId, actor) {
  const t = q.get('SELECT * FROM squad_tasks WHERE id = ?', Number(taskId));
  if (!t) throw err(404, 'Incarico non trovato');
  q.run('DELETE FROM squad_tasks WHERE id = ?', t.id);
  G.log(t.gameId, actor, 'squad_task_deleted', { text: t.text });
  if (t.squadId) notifySquad(t.squadId, null);
  rt.toStaff(t.gameId, 'field');
}

// Incarichi aperti con una coppia da seguire: gli Eletti della squadra ne vedono la posizione finché l'incarico è aperto.
const openTaskSql = 'doneAt IS NULL AND cancelledAt IS NULL';

// ---------------------------------------------------------------- posizioni GPS

const POSITION_MAX_AGE = 30 * 60000; // dopo 30 minuti senza aggiornamenti il telefono sparisce dalla mappa
const POSITION_STALE = 5 * 60000; // dopo 5 minuti il segnaposto si sbiadisce

// Le coppie si vedono in mappa solo a partita iniziata; gli Eletti da quando la partita è pronta (non in preparazione).
function trackingActive(team, status) {
  if (team.kind === 'couple') return [...C.ACTIVE, 'paused'].includes(status) && team.status !== 'withdrawn';
  if (team.kind === 'elect') return !['created', 'draft', 'ended'].includes(status);
  return false;
}

// Posizione da Traccar Client (protocollo OsmAnd: parametri nell'indirizzo o nel modulo; versioni nuove: JSON con
// location.coords). L'identificativo è il trackToken personale del giocatore.
function parseTraccar(query, body) {
  const b = Array.isArray(body) ? body[body.length - 1] || {} : body || {};
  const loc = b.location || {};
  const c = loc.coords || {};
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');
  let lat = pick(query.lat, b.lat, c.latitude);
  let lng = pick(query.lon, b.lon, query.lng, b.lng, c.longitude);
  const pair = pick(query.location, typeof b.location === 'string' ? b.location : undefined);
  if ((lat == null || lng == null) && pair) [lat, lng] = String(pair).split(',');
  const ts = pick(query.timestamp, b.timestamp, loc.timestamp);
  let at = null;
  if (ts != null) {
    const n = Number(ts);
    at = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(ts);
  }
  return {
    id: String(pick(query.id, query.deviceid, b.id, b.deviceid, b.device_id) || ''),
    lat: parseFloat(lat), lng: parseFloat(lng), acc: parseFloat(pick(query.accuracy, b.accuracy, c.accuracy)), at: Number.isFinite(at) ? at : null,
    // SOS: «alarm=sos» (protocollo OsmAnd) o l'evento/allarme nel JSON delle versioni recenti.
    sos: /sos/i.test(String(pick(query.alarm, b.alarm, loc.alarm, loc.event, loc.extras?.alarm, b.event) || '')),
  };
}

function recordTraccar(query, body) {
  const p = parseTraccar(query, body);
  const player = p.id ? q.get('SELECT * FROM players WHERE trackToken = ?', p.id) : null;
  if (!player) return { ok: false, reason: 'unknown' };
  // Pulsante SOS di Traccar Client: emergenza reale (OFF GAME) alla regia, con la posizione.
  if (p.sos) { try { require('./emergency').fromTraccar(player, p); } catch (e) { console.error('sos', e.message); } }
  // Punti rimasti in memoria nel telefono (senza rete): conta solo la posizione attuale.
  if (p.at && Date.now() - p.at > 2 * 60000) return { ok: true, ignored: 'vecchia' };
  // Segnale ricevuto (anche prima del via o prima della coppia): serve alla verifica, senza salvare la posizione.
  const now = Date.now();
  const wasQuiet = !player.trackSeenAt || now - player.trackSeenAt > 2 * 60000;
  q.run('UPDATE players SET trackSeenAt = ? WHERE id = ?', now, player.id);
  q.run('INSERT INTO track_pings (playerId, at, acc) VALUES (?, ?, ?)', player.id, now, Number.isFinite(p.acc) ? Math.round(p.acc) : null);
  // Secondo segnale (o primo dopo un silenzio): l'app di quella persona si aggiorna e toglie o rimette l'avviso «accendi Traccar».
  const pings = q.get('SELECT COUNT(*) AS n FROM track_pings WHERE playerId = ? AND at > ?', player.id, now - G.TRACK_PINGS_WINDOW_MS).n;
  if ((wasQuiet || pings === G.TRACK_ON_PINGS) && player.teamId) { rt.toTeamsWhere(player.gameId, 'state', {}, (c) => c.playerId === player.id || c.teamId === player.teamId); rt.toStaff(player.gameId, 'traccar'); }
  q.run('DELETE FROM track_pings WHERE playerId = ? AND id NOT IN (SELECT id FROM track_pings WHERE playerId = ? ORDER BY id DESC LIMIT 60)', player.id, player.id);
  const team = player.teamId ? q.get('SELECT * FROM teams WHERE id = ?', player.teamId) : null;
  if (!team) return { ok: true, tracking: false };
  return recordPosition(team, player, { deviceId: `trk-${player.id}-${p.id.slice(0, 12)}`, lat: p.lat, lng: p.lng, acc: Number.isFinite(p.acc) ? p.acc : undefined });
}

// Identificativo per Traccar Client (creato alla prima richiesta), stato della verifica e segnali ricevuti
// dall'inizio della prova (since).
const TRACK_TEST_MIN_PINGS = 2;
const TRACK_TEST_MIN_MS = 45000;
function trackingInfo(player, since = null) {
  // Sempre dal database: una copia vecchia del giocatore senza identificativo ne creerebbe uno nuovo.
  player = q.get('SELECT * FROM players WHERE id = ?', player.id);
  if (!player.trackToken) {
    let t;
    do t = randomCode(10).toLowerCase(); while (q.get('SELECT 1 FROM players WHERE trackToken = ?', t));
    q.run('UPDATE players SET trackToken = ? WHERE id = ?', t, player.id);
  }
  player = q.get('SELECT * FROM players WHERE id = ?', player.id);
  const s = Number(since) || null;
  const test = s ? q.get('SELECT COUNT(*) AS n, MAX(at) AS last, MIN(at) AS first FROM track_pings WHERE playerId = ? AND at >= ?', player.id, s) : null;
  const lastAcc = q.get('SELECT acc FROM track_pings WHERE playerId = ? ORDER BY id DESC LIMIT 1', player.id)?.acc ?? null;
  return {
    deviceId: player.trackToken, lastAt: player.trackSeenAt || null, lastAcc, verifiedAt: player.trackVerifiedAt || null,
    test: test ? { since: s, pings: test.n, firstAt: test.first, lastAt: test.last } : null,
    ...trackingStatus(player),
  };
}

/**
 * Stato di Traccar per il «flag» nell'app: 'none' = da configurare e verificare; 'ok' = verificato
 * (e, a partita in corso, segnali recenti); 'stale' = verificato ma da 10 minuti non arriva niente durante la partita.
 */
function trackingStatus(player) {
  if (!player) return { state: 'none' };
  const team = player.teamId ? q.get('SELECT * FROM teams WHERE id = ?', player.teamId) : null;
  const st = G.trackStateOf(player, G.getGame(player.gameId), team);
  const pings = q.get('SELECT COUNT(*) AS n FROM track_pings WHERE playerId = ? AND at > ?', player.id, Date.now() - G.TRACK_PINGS_WINDOW_MS).n;
  return { ...st, everSeen: !!player.trackSeenAt, pings, lastAt: player.trackSeenAt || null, deviceId: player.trackToken || null, verifiedAt: player.trackVerifiedAt || null };
}

// Fine della prova: almeno 2 segnali da Traccar dopo l'inizio, su almeno 45 secondi (il telefono era in tasca).
function verifyTracking(player, since) {
  const s = Number(since);
  if (!s || s > Date.now() || Date.now() - s > 20 * 60000) throw err(400, 'Prova scaduta: ricominciala');
  const t = q.get('SELECT COUNT(*) AS n, MAX(at) AS last FROM track_pings WHERE playerId = ? AND at >= ?', player.id, s);
  if (t.n < TRACK_TEST_MIN_PINGS) throw err(409, t.n ? 'È arrivato un solo segnale: lascia il telefono bloccato ancora un po\'' : 'Da Traccar non è arrivato nessun segnale: controlla indirizzo, identificativo e che il servizio sia acceso');
  if (Date.now() - s < TRACK_TEST_MIN_MS) throw err(409, 'Ancora qualche secondo: la prova dura almeno 45 secondi');
  q.run('UPDATE players SET trackVerifiedAt = ? WHERE id = ?', Date.now(), player.id);
  G.log(player.gameId, `giocatore:${player.id}`, 'traccar_verified', { name: player.name, pings: t.n });
  rt.toStaff(player.gameId, 'traccar');
  return trackingInfo(player);
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
  // Posizione di rete (non GPS): non la mostriamo in mappa.
  if (acc != null && acc > 300) return { ok: true, tracking: true, ignored: 'imprecisa' };
  q.run(`INSERT INTO positions (deviceId, gameId, teamId, playerId, lat, lng, acc, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(deviceId) DO UPDATE SET gameId = excluded.gameId, teamId = excluded.teamId, playerId = excluded.playerId,
         lat = excluded.lat, lng = excluded.lng, acc = excluded.acc, at = excluded.at`,
    deviceId, game.id, team.id, player?.id ?? null, lat, lng, acc, Date.now());
  trackPoint(game.id, team.id, player?.id ?? null, deviceId, lat, lng, acc);
  return { ok: true, tracking: true };
}

// Storico per il Rewind: un punto ogni 10 s per dispositivo, o prima se si è spostato di oltre 15 m.
const lastTrack = new Map();
function trackPoint(gameId, teamId, playerId, deviceId, lat, lng, acc, now = Date.now()) {
  const last = lastTrack.get(deviceId);
  if (last && now - last.at < 10000 && require('./skills').distM(last, { lat, lng }) < 15) return;
  lastTrack.set(deviceId, { at: now, lat, lng });
  q.run('INSERT INTO position_track (gameId, teamId, playerId, deviceId, lat, lng, acc, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', gameId, teamId, playerId, deviceId, lat, lng, acc, now);
}

// viewer: 'master' (tutti) oppure 'elect' (solo gli Eletti).
function positionsOf(gameId, viewer = 'master') {
  const now = Date.now();
  const rows = q.all(`SELECT pos.*, t.kind, t.displayName, s.name AS sectorName, s.roman, s.color AS sectorColor, pl.name AS playerName, pl.nickname, pl.squadId,
                        sq.name AS squadName, sq.color AS squadColor
                      FROM positions pos JOIN teams t ON t.id = pos.teamId
                      LEFT JOIN sectors s ON s.id = t.sectorId
                      LEFT JOIN players pl ON pl.id = pos.playerId
                      LEFT JOIN elect_squads sq ON sq.id = pl.squadId
                      WHERE pos.gameId = ? AND pos.at > ?`, Number(gameId), now - POSITION_MAX_AGE);
  // Stessa persona da due fonti (app aperta e Traccar Client): resta solo la posizione più recente.
  const latest = new Map();
  for (const r of rows) {
    const k = r.playerId != null ? `p${r.playerId}` : `d${r.deviceId}`;
    if (!latest.has(k) || latest.get(k).at < r.at) latest.set(k, r);
  }
  return [...latest.values()].filter((r) => viewer === 'master' || r.kind === 'elect').map((r) => ({
    deviceId: r.deviceId, teamId: r.teamId, kind: r.kind === 'elect' ? 'elect' : 'team', lat: r.lat, lng: r.lng, acc: r.acc, at: r.at, stale: now - r.at > POSITION_STALE,
    label: r.kind === 'elect' ? (r.nickname || r.playerName || 'Eletto') : `${r.roman} ${r.sectorName}`,
    who: r.kind === 'elect' ? (r.squadName ? `Squadra ${r.squadName}` : 'Eletti del Consiglio') : (r.nickname || r.playerName || r.displayName || 'coppia'),
    roman: r.roman, color: r.kind === 'elect' ? (r.squadColor || '#d1ad62') : (r.sectorColor || '#ff4fa3'),
  }));
}

// Riepilogo per la home degli Eletti: la propria squadra e cosa resta da fare.
// Posizioni delle coppie bersaglio degli incarichi aperti della squadra (mai chi è nell'Ombra).
function taskTargets(squadId) {
  const S = require('./skills');
  return q.all(`SELECT * FROM squad_tasks WHERE squadId = ? AND targetTeamId IS NOT NULL AND ${openTaskSql}`, squadId).map((t) => {
    const team = q.get('SELECT t.id, t.gameId, s.name, s.roman, s.color FROM teams t JOIN sectors s ON s.id = t.sectorId WHERE t.id = ?', t.targetTeamId);
    if (!team || S.hiddenTeam(team)) return null;
    const p = q.get('SELECT lat, lng, at FROM positions WHERE teamId = ? AND at > ? ORDER BY at DESC LIMIT 1', team.id, Date.now() - POSITION_MAX_AGE);
    return p ? { taskId: t.id, kind: t.kind, teamId: team.id, roman: team.roman, sectorName: team.name, color: team.color, lat: p.lat, lng: p.lng, at: p.at } : null;
  }).filter(Boolean);
}

// Bersagli degli incarichi come segnaposto della mappa degli Eletti.
function taskTargetPositions(squadId) {
  const now = Date.now();
  return taskTargets(squadId).map((x) => ({
    deviceId: `task-${x.taskId}`, teamId: x.teamId, kind: 'team', lat: x.lat, lng: x.lng, acc: null, at: x.at, stale: now - x.at > POSITION_STALE,
    label: `${x.roman} · Settore ${x.sectorName}`, who: x.kind === 'hunt' ? '🎯 Bersaglio della caccia' : x.kind === 'meet' ? '🤝 Coppia da raggiungere (Alleanze sporche)' : '⌖ Coppia da raggiungere',
    roman: x.roman, color: x.color,
  }));
}

function electSummary(team, player) {
  const squadId = player?.squadId || null;
  const squad = squadId ? q.get('SELECT id, name, color FROM elect_squads WHERE id = ?', squadId) : null;
  if (!squad) return { squad: null, todo: null, items: [] };
  const todo = q.get('SELECT COUNT(*) AS n FROM points WHERE squadId = ? AND (lat IS NULL OR moveRequestedAt IS NOT NULL)', squad.id).n
    + q.get("SELECT COUNT(*) AS n FROM gifts WHERE squadId = ? AND status NOT IN ('claimed', 'expired') AND (status = 'draft' OR moveRequestedAt IS NOT NULL)", squad.id).n
    + q.get('SELECT COUNT(*) AS n FROM landmarks WHERE squadId = ? AND (lat IS NULL OR moveRequestedAt IS NOT NULL)', squad.id).n
    + q.get(`SELECT COUNT(*) AS n FROM squad_tasks WHERE squadId = ? AND ${openTaskSql}`, squad.id).n;
  // Le cose da fare, con una chiave stabile: l'app avvisa quando ne compare una nuova.
  const items = [
    ...q.all('SELECT id, label, moveRequestedAt FROM landmarks WHERE squadId = ? AND (lat IS NULL OR moveRequestedAt IS NOT NULL)', squad.id).map((x) => ({ key: `l${x.id}:${x.moveRequestedAt || 0}`, label: `${x.moveRequestedAt ? 'Spostate' : 'Piazzate'}: ${x.label}` })),
    ...q.all('SELECT id, label, moveRequestedAt FROM points WHERE squadId = ? AND (lat IS NULL OR moveRequestedAt IS NOT NULL)', squad.id).map((x) => ({ key: `p${x.id}:${x.moveRequestedAt || 0}`, label: `${x.moveRequestedAt ? 'Spostate' : 'Piazzate'}: ${x.label}` })),
    ...q.all("SELECT id, label, name, moveRequestedAt FROM gifts WHERE squadId = ? AND status NOT IN ('claimed', 'expired') AND (status = 'draft' OR moveRequestedAt IS NOT NULL)", squad.id).map((x) => ({ key: `g${x.id}:${x.moveRequestedAt || 0}`, label: `${x.moveRequestedAt ? 'Spostate' : 'Piazzate'}: ${x.label} (${x.name})` })),
    ...q.all(`SELECT id, text FROM squad_tasks WHERE squadId = ? AND ${openTaskSql}`, squad.id).map((x) => ({ key: `t${x.id}`, label: x.text })),
  ];
  return { squad, todo, items, targets: taskTargets(squad.id) };
}

// Per le coppie: Altari piazzati e doni comparsi (non ancora presi). Il tipo del dono resta una sorpresa.
// Gli Altari compaiono alle coppie solo dal via: prima li vede solo l'organizzazione (regia ed Eletti).
function teamMap(team) {
  if (team.kind === 'lobby') return null;
  const { status } = G.getGame(team.gameId);
  const started = team.kind === 'elect' || !C.PRE_START.includes(status);
  return {
    points: !started ? [] : q.all(`SELECT p.id, p.label, p.lat, p.lng, p.sectorId, s.name AS sectorName, s.roman FROM points p JOIN sectors s ON s.id = p.sectorId
                   WHERE p.gameId = ? AND p.lat IS NOT NULL ORDER BY s.ord`, team.gameId)
      .map((p) => ({ ...p, mine: p.sectorId === team.sectorId })),
    // Nessun punto del gioco prima del tempo: il Cerchio compare dal Cerchio, la Soglia dal via (gli Eletti li vedono sempre).
    landmarks: q.all('SELECT id, kind, label, lat, lng FROM landmarks WHERE gameId = ? AND lat IS NOT NULL', team.gameId)
      .filter((l) => team.kind === 'elect' || started || (l.kind === 'cerchio' && status === 'circle')),
    guide: teamGuide(team.gameId),
    gifts: q.all("SELECT id, label, lat, lng, revealedAt, expiresAfterMin, revealElapsedMs FROM gifts WHERE gameId = ? AND status = 'revealed' AND lat IS NOT NULL AND (publicAt IS NULL OR publicAt <= ? OR ? = 'elect')", team.gameId, Date.now(), team.kind)
      .map((g) => ({ id: g.id, label: g.label, lat: g.lat, lng: g.lng, revealedAt: g.revealedAt, expiresAtElapsedMs: g.expiresAfterMin && g.revealElapsedMs != null ? g.revealElapsedMs + g.expiresAfterMin * 60000 : null })),
  };
}

function teamGifts(team) {
  return q.all('SELECT * FROM gifts WHERE claimedByTeamId = ? ORDER BY claimedAt DESC', team.id)
    .map((g) => ({ id: g.id, label: g.label, typeId: g.typeId, name: g.name, icon: g.icon, color: g.color, description: g.description, claimedAt: g.claimedAt, usedAt: g.usedAt }));
}

// ---------------------------------------------------------------- azioni delle coppie

function claimGift(team, token) {
  if (team.kind === 'elect') throw err(403, 'Gli Eletti piazzano i doni, non li prendono');
  const game = G.getGame(team.gameId);
  if (!C.ACTIVE.includes(game.status)) throw err(409, game.status === 'paused' ? 'Partita sospesa' : 'I doni si prendono a partita in corso');
  const g = q.get('SELECT * FROM gifts WHERE gameId = ? AND qrToken = ?', game.id, String(token || ''));
  if (!g) throw err(404, 'Dono non riconosciuto per questa partita');
  // Un dono letto non si riprende: a chi lo rilegge risulta scaduto.
  const mine = g.claimedByTeamId === team.id || (g.multi && q.get('SELECT 1 FROM gifts WHERE parentGiftId = ? AND claimedByTeamId = ?', g.id, team.id));
  if (mine) throw err(409, 'Dono scaduto: l\'avete già preso. Lo trovate tra i vostri doni.');
  if (g.status === 'claimed') {
    const t = q.get('SELECT s.name FROM teams t JOIN sectors s ON s.id = t.sectorId WHERE t.id = ?', g.claimedByTeamId);
    throw err(409, `Dono scaduto: l'ha già preso il Settore ${t?.name || '?'}`);
  }
  if (g.status === 'expired') throw err(409, 'Dono scaduto: è svanito');
  // Presagio del Dono: chi ha la passiva può prendere anche un dono già piazzato ma non ancora annunciato.
  const early = g.status === 'placed' && require('./skills').hasSkill(team.id, 'presagio');
  if (g.status !== 'revealed' && !early) throw err(409, 'Questo dono non è ancora comparso: il Consiglio lo farà comparire più tardi');
  if (g.multi) {
    // Resta attivo per le altre coppie: questa ne prende una copia sua, il dono resta sulla mappa.
    const id = Number(q.run(`INSERT INTO gifts (gameId, typeId, name, icon, color, description, label, qrToken, status, revealMode, claimedByTeamId, claimedAt, createdAt, parentGiftId, removeSign)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', 'manual', ?, ?, ?, ?, ?)`,
    game.id, g.typeId, g.name, g.icon, g.color, g.description, g.label, randomToken(18), team.id, Date.now(), Date.now(), g.id, g.removeSign).lastInsertRowid);
    G.log(game.id, `coppia:${team.id}`, 'gift_claimed', { teamId: team.id, label: g.label, type: g.name, multi: true, ...(early ? { presagio: 'preso prima dell\'annuncio' } : {}) });
    rt.toStaff(game.id, 'gifts');
    const s = q.get('SELECT name FROM sectors WHERE id = ?', team.sectorId);
    rt.pushMasters({ title: 'Dono preso', body: `${g.label} (${g.name}) preso dal Settore ${s?.name || '?'} · resta attivo per le altre coppie`, url: '/regia#doniqr' });
    return { ok: true, gift: teamGifts(team).find((x) => x.id === id) };
  }
  const r = q.run("UPDATE gifts SET status = 'claimed', claimedByTeamId = ?, claimedAt = ? WHERE id = ? AND status = ?", team.id, Date.now(), g.id, g.status);
  if (!r.changes) throw err(409, 'Troppo tardi: un\'altra coppia è stata più veloce');
  G.log(game.id, `coppia:${team.id}`, 'gift_claimed', { teamId: team.id, label: g.label, type: g.name, ...(early ? { presagio: 'preso prima dell\'annuncio' } : {}) });
  // Notifica a coppie ed Eletti (senza dire chi l'ha preso): il dono sparisce dalle loro mappe.
  // Preso con Presagio prima dell'annuncio: nessuno l'ha mai visto, non si annuncia niente (e non comparirà più).
  if (!early) G.announce(game.id, 'gift_taken', {}, { giftId: g.id });
  rt.toStaff(game.id, 'gifts');
  const s = q.get('SELECT name FROM sectors WHERE id = ?', team.sectorId);
  rt.pushMasters({ title: 'Dono preso', body: `${g.label} (${g.name}) preso dal Settore ${s?.name || '?'}${early ? ' · con Presagio, prima dell\'annuncio' : ''}`, url: '/regia#mappa' });
  return { ok: true, gift: teamGifts(team).find((x) => x.id === g.id) };
}

function useGift(team, giftId, params = {}) {
  const g = q.get('SELECT * FROM gifts WHERE id = ? AND claimedByTeamId = ?', Number(giftId), team.id);
  if (!g) throw err(404, 'Dono non trovato tra i vostri');
  if (g.usedAt) return { ok: true, already: true };
  // Doni con effetto: lo applica il server. Gli altri (tipi vecchi) si segnano solo come usati.
  const r = require('./skills').useGift(team, g, params);
  if (r) return r;
  q.run('UPDATE gifts SET usedAt = ? WHERE id = ?', Date.now(), g.id);
  G.log(team.gameId, `coppia:${team.id}`, 'gift_used', { teamId: team.id, label: g.label, type: g.name });
  rt.toStaff(team.gameId, 'gifts');
  return { ok: true };
}

module.exports = {
  recordTraccar, parseTraccar, trackingInfo, trackingStatus, verifyTracking, recordPosition, positionsOf, trackingActive, squadsOf, createSquad, updateSquad, deleteSquad, setMemberSquad, assignToSquad, createTask, assignTask, cancelTask, notifySquadPublic: notifySquad, taskTargetPositions, setTaskDone, deleteTask, electSummary,
  giftTypes, createGifts, scheduleGiftReveal, updateGift, deleteGift, resetGift, resetAllGifts, revealGift, tickAll,
  createPoi, updatePoi, deletePoi, createGuide, updateGuide, deleteGuide, teamGuide, orgKmz, teamKmz, placePoint, placeGift, placeLandmark, resolveToken, photoFile, fieldState, teamMap, teamGifts, claimGift, useGift,
};
