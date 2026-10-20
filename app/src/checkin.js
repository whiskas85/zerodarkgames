'use strict';
// Accettazione a inizio evento: la regia conferma chi è presente (iscritti) e le coppie al completo.
// Test armi: per ogni persona accettata, arma principale, principale di riserva e secondaria sotto 1 joule.
const { q } = require('./db');
const G = require('./game');
const { HttpError } = require('./util');

const err = (status, msg) => new HttpError(status, msg);
const WEAPONS = { main: 'chronoMain', backup: 'chronoBackup', secondary: 'chronoSecondary' };
const WEAPON_LABELS = { main: 'arma principale', backup: 'arma principale di riserva', secondary: 'arma secondaria' };

function playerOf(gameId, playerId) {
  const p = q.get('SELECT * FROM players WHERE id = ? AND gameId = ?', Number(playerId), gameId);
  if (!p) throw err(404, 'Iscritto non trovato');
  return p;
}

function setPlayerCheckin(gameId, playerId, on, actor) {
  const p = playerOf(gameId, playerId);
  if (on && p.status !== 'accepted') throw err(409, 'Prima approva l\'iscrizione');
  q.run('UPDATE players SET checkinAt = ?, checkinBy = ? WHERE id = ?', on ? Date.now() : null, on ? actor : null, p.id);
  // Chi non è più presente non è più confermato nemmeno come coppia.
  if (!on && p.teamId) q.run('UPDATE teams SET checkinAt = NULL, checkinBy = NULL WHERE id = ?', p.teamId);
  G.log(gameId, actor, on ? 'checkin_player' : 'checkin_player_undo', { name: p.name });
  G.notifyState(gameId);
  return { ok: true };
}

function setTeamCheckin(gameId, teamId, on, actor) {
  const t = q.get('SELECT * FROM teams WHERE id = ? AND gameId = ?', Number(teamId), gameId);
  if (!t) throw err(404, 'Coppia non trovata');
  if (on) {
    const missing = q.all('SELECT name FROM players WHERE teamId = ? AND checkinAt IS NULL', t.id);
    if (missing.length) throw err(409, `Manca la presenza di: ${missing.map((m) => m.name).join(', ')}`);
  }
  q.run('UPDATE teams SET checkinAt = ?, checkinBy = ? WHERE id = ?', on ? Date.now() : null, on ? actor : null, t.id);
  G.log(gameId, actor, on ? 'checkin_team' : 'checkin_team_undo', { teamId: t.id });
  G.notifyState(gameId);
  return { ok: true };
}

function setChrono(gameId, playerId, weapon, on, actor) {
  const col = WEAPONS[weapon];
  if (!col) throw err(400, 'Arma non valida');
  const p = playerOf(gameId, playerId);
  if (!p.checkinAt) throw err(409, 'Prima va accettato all\'ingresso');
  q.run(`UPDATE players SET ${col} = ?, chronoBy = ? WHERE id = ?`, on ? Date.now() : null, actor, p.id);
  G.log(gameId, actor, on ? 'chrono_ok' : 'chrono_undo', { name: p.name, arma: WEAPON_LABELS[weapon] });
  G.notifyState(gameId);
  return { ok: true };
}

module.exports = { setPlayerCheckin, setTeamCheckin, setChrono, WEAPONS };
