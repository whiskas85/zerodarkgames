'use strict';
// Emergenze reali (OFF GAME, non di gioco): il pulsante EMERGENZA dell'app o l'SOS di Traccar Client mandano alla
// regia chi chiama e dove si trova. La regia salta subito alla pagina Emergenze.
const { q } = require('./db');
const G = require('./game');
const rt = require('./realtime');
const { HttpError } = require('./util');

const err = (status, msg) => new HttpError(status, msg);
const POS_MAX_AGE = 10 * 60000;

function whoOf(player, team) {
  if (player) return [player.name, player.nickname ? `«${player.nickname}»` : null].filter(Boolean).join(' ');
  if (team?.sectorId) {
    const s = q.get('SELECT name, roman FROM sectors WHERE id = ?', team.sectorId);
    return `Coppia ${s.roman} · Settore ${s.name}`;
  }
  return team?.displayName || 'Sconosciuto';
}

function whereOf(team, player) {
  if (!team) return null;
  if (team.kind === 'elect') {
    const sq = player?.squadId ? q.get('SELECT name FROM elect_squads WHERE id = ?', player.squadId) : null;
    return sq ? `Eletti · squadra ${sq.name}` : 'Eletti del Consiglio';
  }
  const s = team.sectorId ? q.get('SELECT name, roman FROM sectors WHERE id = ?', team.sectorId) : null;
  return s ? `${s.roman} · Settore ${s.name}` : null;
}

// Ultima posizione nota: del telefono di quella persona, altrimenti della coppia.
function lastPos(playerId, teamId) {
  const since = Date.now() - POS_MAX_AGE;
  return (playerId && q.get('SELECT lat, lng, acc, at FROM positions WHERE playerId = ? AND at > ? ORDER BY at DESC LIMIT 1', playerId, since))
    || (teamId && q.get('SELECT lat, lng, acc, at FROM positions WHERE teamId = ? AND at > ? ORDER BY at DESC LIMIT 1', teamId, since)) || null;
}

// Dati ICE dell'account di chi chiama: è l'unico momento in cui arrivano alla regia.
function iceOf(player) {
  const a = player?.accountId ? q.get('SELECT iceBlood, iceConditions, iceContactName, iceContactPhone FROM accounts WHERE id = ?', player.accountId) : null;
  if (!a || !(a.iceBlood || a.iceConditions || a.iceContactName || a.iceContactPhone)) return null;
  return JSON.stringify({ blood: a.iceBlood, conditions: a.iceConditions, contactName: a.iceContactName, contactPhone: a.iceContactPhone });
}

// Gravità scelta da chi chiama: lieve, seria o grave (pericolo di vita). Il commento dice di cosa si tratta.
const SEVERITY = { lieve: 'Lieve', seria: 'Seria', grave: 'GRAVE' };
const readSeverity = (v) => (SEVERITY[v] ? v : null);
const readComment = (v) => String(v ?? '').trim().slice(0, 300) || null;

function raise({ gameId, team = null, player = null, pos = null, source = 'app', severity = null, comment = null }) {
  const lat = parseFloat(pos?.lat);
  const lng = parseFloat(pos?.lng);
  const given = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng, acc: Number.isFinite(parseFloat(pos.acc)) ? Math.round(parseFloat(pos.acc)) : null } : null;
  const p = given || lastPos(player?.id, team?.id);
  // Stessa persona che preme di nuovo (o Traccar che ripete l'SOS): si aggiorna l'emergenza aperta, non se ne crea un'altra.
  const open = q.get(`SELECT * FROM emergencies WHERE gameId = ? AND closedAt IS NULL AND ${player ? 'playerId = ?' : 'teamId = ?'} AND createdAt > ? ORDER BY id DESC LIMIT 1`,
    gameId, player ? player.id : team?.id ?? -1, Date.now() - 10 * 60000);
  if (open) {
    if (p) q.run('UPDATE emergencies SET lat = ?, lng = ?, acc = ? WHERE id = ?', p.lat, p.lng, p.acc ?? null, open.id);
    // Gravità e commento si possono aggiornare (anche dopo la chiamata).
    if (severity || comment) {
      q.run('UPDATE emergencies SET severity = COALESCE(?, severity), comment = COALESCE(?, comment) WHERE id = ?', severity, comment, open.id);
      rt.toStaff(gameId, 'emergency');
    }
    rt.toStaffEvent('emergency', { gameId, id: open.id, repeat: true });
    if (team) rt.toTeams(gameId, 'state', {}, team.id);
    return { ok: true, id: open.id, repeat: true, located: !!p };
  }
  const who = whoOf(player, team);
  const where = whereOf(team, player);
  const id = Number(q.run(`INSERT INTO emergencies (gameId, teamId, playerId, who, phone, source, lat, lng, acc, createdAt, ice, severity, comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    gameId, team?.id ?? null, player?.id ?? null, where ? `${who} (${where})` : who, player?.phone || null, source, p?.lat ?? null, p?.lng ?? null, p?.acc ?? null, Date.now(), iceOf(player), severity, comment).lastInsertRowid);
  G.log(gameId, player ? `giocatore:${player.id}` : team ? `coppia:${team.id}` : 'traccar', 'emergency', { id, who, source });
  rt.pushMasters({ title: `🚨 EMERGENZA${severity ? ` ${SEVERITY[severity]}` : ''} (OFF GAME)`, body: `${who}${where ? ` · ${where}` : ''}${source === 'traccar' ? ' · SOS da Traccar' : ''}${p ? '' : ' · posizione sconosciuta'}${comment ? ` · «${comment}»` : ''}`,
    tag: `emergency-${id}`, url: '/regia#emergenze', requireInteraction: true });
  rt.toStaffEvent('emergency', { gameId, id });
  rt.toStaff(gameId, 'emergency');
  if (team) rt.toTeams(gameId, 'state', {}, team.id);
  return { ok: true, id, located: !!p };
}

// Dal telefono (pulsante EMERGENZA).
function fromApp(team, player, body) {
  const gameId = team?.gameId ?? player?.gameId;
  if (!gameId) throw err(400, 'Partita non trovata');
  return raise({ gameId, team: team || (player?.teamId ? q.get('SELECT * FROM teams WHERE id = ?', player.teamId) : null), player, pos: body, source: 'app',
    severity: readSeverity(body?.severity), comment: readComment(body?.comment) });
}

// Da Traccar Client (pulsante SOS): il giocatore è riconosciuto dal suo identificativo.
function fromTraccar(player, pos) {
  const team = player.teamId ? q.get('SELECT * FROM teams WHERE id = ?', player.teamId) : null;
  return raise({ gameId: player.gameId, team, player, pos, source: 'traccar' });
}

function list(gameId) {
  return q.all('SELECT * FROM emergencies WHERE gameId = ? ORDER BY closedAt IS NOT NULL, id DESC LIMIT 50', gameId).map((e) => {
    const live = e.closedAt ? null : lastPos(e.playerId, e.teamId);
    return { ...e, ice: e.ice ? JSON.parse(e.ice) : null, live: live && (!e.lat || live.at > e.createdAt) ? live : null };
  });
}

function ack(id, actor) {
  const e = q.get('SELECT * FROM emergencies WHERE id = ?', Number(id));
  if (!e) throw err(404, 'Emergenza non trovata');
  if (!e.ackAt) q.run('UPDATE emergencies SET ackAt = ?, ackBy = ? WHERE id = ?', Date.now(), actor, e.id);
  G.log(e.gameId, actor, 'emergency_ack', { id: e.id, who: e.who });
  // Chi ha chiamato sa che la regia ha preso in carico.
  if (e.teamId) rt.pushTeams(e.gameId, { title: 'Emergenza ricevuta', body: 'La Direzione ha preso in carico la vostra emergenza. Restate dove siete e tenete la radio accesa.', tag: `emergency-${e.id}`, url: '/#/home' }, e.teamId);
  rt.toStaff(e.gameId, 'emergency');
  if (e.teamId) rt.toTeams(e.gameId, 'state', {}, e.teamId);
}

function close(id, actor, note) {
  const e = q.get('SELECT * FROM emergencies WHERE id = ?', Number(id));
  if (!e) throw err(404, 'Emergenza non trovata');
  q.run('UPDATE emergencies SET closedAt = ?, closedBy = ?, note = ?, ackAt = COALESCE(ackAt, ?), ackBy = COALESCE(ackBy, ?) WHERE id = ?',
    Date.now(), actor, String(note || '').trim().slice(0, 300) || null, Date.now(), actor, e.id);
  G.log(e.gameId, actor, 'emergency_closed', { id: e.id, who: e.who });
  rt.toStaff(e.gameId, 'emergency');
  // Chiusa: sul telefono tornano gli effetti di gioco.
  if (e.teamId) rt.toTeams(e.gameId, 'state', {}, e.teamId);
}

// Archiviata (solo se chiusa): sparisce dalla vista della regia; si può riprendere dall'archivio.
function archive(id, actor, on = true) {
  const e = q.get('SELECT * FROM emergencies WHERE id = ?', Number(id));
  if (!e) throw err(404, 'Emergenza non trovata');
  if (on && !e.closedAt) throw err(409, 'Chiudi l\'emergenza prima di archiviarla');
  q.run('UPDATE emergencies SET archivedAt = ? WHERE id = ?', on ? Date.now() : null, e.id);
  G.log(e.gameId, actor, on ? 'emergency_archived' : 'emergency_unarchived', { id: e.id, who: e.who });
  rt.toStaff(e.gameId, 'emergency');
}
// Tutte le chiuse di una partita in archivio.
function archiveClosed(gameId, actor) {
  const n = Number(q.run('UPDATE emergencies SET archivedAt = ? WHERE gameId = ? AND closedAt IS NOT NULL AND archivedAt IS NULL', Date.now(), Number(gameId)).changes);
  if (n) { G.log(Number(gameId), actor, 'emergency_archived', { count: n }); rt.toStaff(Number(gameId), 'emergency'); }
  return n;
}

module.exports = { fromApp, fromTraccar, list, ack, close, raise, archive, archiveClosed };
