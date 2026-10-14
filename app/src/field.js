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

function giftOut(g) {
  const t = g.claimedByTeamId ? q.get('SELECT t.displayName, s.name AS sectorName, s.roman FROM teams t LEFT JOIN sectors s ON s.id = t.sectorId WHERE t.id = ?', g.claimedByTeamId) : null;
  return {
    id: g.id, label: g.label, typeId: g.typeId, name: g.name, icon: g.icon, color: g.color, description: g.description,
    status: g.status, revealMode: g.revealMode, revealAtMin: g.revealAtMin,
    lat: g.lat, lng: g.lng, accuracy: g.accuracy, placedAt: g.placedAt, placedBy: g.placedBy, hasPhoto: !!g.photoFile,
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
  const ids = tx(() => {
    let n = q.get('SELECT COUNT(*) AS n FROM gifts WHERE gameId = ?', game.id).n;
    const out = [];
    for (let i = 0; i < count; i++) {
      n += 1;
      out.push(Number(q.run(`INSERT INTO gifts (gameId, typeId, name, icon, color, description, label, qrToken, revealMode, revealAtMin, expiresAfterMin, createdAt)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        game.id, type.id, type.name, type.icon, type.color, type.description, `Dono ${n}`, randomToken(18), revealMode, revealAtMin, expiresAfterMin, Date.now()).lastInsertRowid));
    }
    return out;
  });
  G.log(game.id, actor, 'gifts_created', { type: type.name, count });
  rt.toStaff(game.id, 'gifts');
  return { ids };
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
  q.run("UPDATE gifts SET status = 'draft', lat = NULL, lng = NULL, accuracy = NULL, photoFile = NULL, placedAt = NULL, placedBy = NULL, revealedAt = NULL, revealElapsedMs = NULL, expiredAt = NULL WHERE id = ?", g.id);
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
    const due = q.all("SELECT id FROM gifts WHERE gameId = ? AND status = 'placed' AND revealMode = 'time' AND revealAtMin <= ?", game.id, e);
    for (const d of due) {
      try { revealGift(d.id, 'sistema'); } catch (e2) { console.error('gift tick', e2.message); }
    }
    const elapsed = e * 60000;
    const expired = q.all("SELECT * FROM gifts WHERE gameId = ? AND status = 'revealed' AND expiresAfterMin IS NOT NULL AND revealElapsedMs IS NOT NULL AND revealElapsedMs + expiresAfterMin * 60000 <= ?", game.id, elapsed);
    for (const g of expired) expireGift(g);
  }
}

// ---------------------------------------------------------------- piazzamento sul campo

function readPlacement(body) {
  const lat = parseFloat(body.lat);
  const lng = parseFloat(body.lng);
  const acc = body.acc != null && body.acc !== '' ? parseFloat(body.acc) : null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw err(400, 'Posizione mancante o non valida');
  const mime = String(body.mime || '').split(';')[0].trim().toLowerCase();
  const ext = IMAGE_TYPES[mime];
  if (!ext) throw err(415, 'Foto in un formato non supportato');
  if (!body.buffer?.length) throw err(400, 'Foto mancante');
  return { lat, lng, acc: Number.isFinite(acc) ? Math.round(acc) : null, ext, buffer: body.buffer, source: body.source === 'manual' ? 'manual' : 'gps' };
}

function savePhoto(prefix, id, p) {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const file = `${prefix}-${id}-${Date.now()}.${p.ext}`;
  fs.writeFileSync(path.join(PHOTO_DIR, file), p.buffer);
  return file;
}

function placePoint(pointId, gameId, body, who) {
  const pt = q.get('SELECT * FROM points WHERE id = ? AND gameId = ?', Number(pointId), Number(gameId));
  if (!pt) throw err(404, 'Altare non trovato in questa partita');
  if (G.getGame(pt.gameId).status === 'ended') throw err(409, 'La partita è terminata');
  const p = readPlacement(body);
  const file = savePhoto('altare', pt.id, p);
  q.run('UPDATE points SET lat = ?, lng = ?, accuracy = ?, photoFile = ?, placedAt = ?, placedBy = ?, placeSource = ? WHERE id = ?',
    p.lat, p.lng, p.acc, file, Date.now(), who, p.source, pt.id);
  removePhoto(pt.photoFile);
  G.log(pt.gameId, who, 'point_placed', { label: pt.label, accuracy: p.acc, source: p.source });
  rt.toStaff(pt.gameId, 'placed');
  rt.toTeams(pt.gameId, 'state', {});
  return { ok: true, label: pt.label };
}

function placeGift(giftId, gameId, body, who) {
  const g = q.get('SELECT * FROM gifts WHERE id = ? AND gameId = ?', Number(giftId), Number(gameId));
  if (!g) throw err(404, 'Dono non trovato in questa partita');
  if (g.status === 'claimed') throw err(409, 'Questo dono è già stato preso');
  if (g.status === 'expired') throw err(409, 'Questo dono è svanito: la regia può riportarlo da piazzare');
  if (G.getGame(g.gameId).status === 'ended') throw err(409, 'La partita è terminata');
  const p = readPlacement(body);
  const file = savePhoto('dono', g.id, p);
  const status = g.status === 'revealed' ? 'revealed' : 'placed';
  q.run('UPDATE gifts SET status = ?, lat = ?, lng = ?, accuracy = ?, photoFile = ?, placedAt = ?, placedBy = ?, placeSource = ? WHERE id = ?',
    status, p.lat, p.lng, p.acc, file, Date.now(), who, p.source, g.id);
  removePhoto(g.photoFile);
  G.log(g.gameId, who, 'gift_placed', { label: g.label, type: g.name, accuracy: p.acc });
  if (status === 'placed' && g.revealMode === 'onplace') revealGift(g.id, who);
  rt.toStaff(g.gameId, 'placed');
  rt.toTeams(g.gameId, 'state', {});
  return { ok: true, label: g.label, revealed: g.revealMode === 'onplace' || status === 'revealed' };
}

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
  const row = kind === 'point' ? q.get('SELECT gameId, photoFile FROM points WHERE id = ?', Number(id)) : q.get('SELECT gameId, photoFile FROM gifts WHERE id = ?', Number(id));
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
    }));
  return {
    game: { id: game.id, name: game.name, status: game.status },
    clock: G.clockOf(game),
    points,
    gifts: q.all('SELECT * FROM gifts WHERE gameId = ? ORDER BY id', game.id).map(giftOut),
    giftTypes: giftTypes(),
  };
}

// Per le coppie: Altari piazzati e doni comparsi (non ancora presi). Il tipo del dono resta una sorpresa.
function teamMap(team) {
  if (team.kind === 'lobby') return null;
  return {
    points: q.all(`SELECT p.id, p.label, p.lat, p.lng, p.sectorId, s.name AS sectorName, s.roman FROM points p JOIN sectors s ON s.id = p.sectorId
                   WHERE p.gameId = ? AND p.lat IS NOT NULL ORDER BY s.ord`, team.gameId)
      .map((p) => ({ ...p, mine: p.sectorId === team.sectorId })),
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
  giftTypes, saveGiftTypes, createGifts, updateGift, deleteGift, resetGift, revealGift, tickAll,
  placePoint, placeGift, resolveToken, photoFile, fieldState, teamMap, teamGifts, claimGift, useGift,
};
