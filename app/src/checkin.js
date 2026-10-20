'use strict';
// Accettazione a inizio evento: la regia conferma chi è presente (iscritti) e le coppie al completo.
// Test armi: per ogni persona accettata, arma principale, principale di riserva e secondaria sotto 1 joule.
const { q, tx } = require('./db');
const rt = require('./realtime');
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

// Spostamento all'accettazione (trascina e rilascia): in una coppia con un posto libero, in una squadra di Eletti
// (anche nuova), tra gli Eletti senza squadra o fuori da tutto. Le coppie toccate tornano da confermare.
function placePlayer(gameId, playerId, dest = {}, actor) {
  const g = G.getGame(gameId);
  if (g.status === 'ended') throw err(409, 'Partita finita');
  const p = playerOf(gameId, playerId);
  if (p.status !== 'accepted') throw err(409, 'Prima approva l\'iscrizione');
  let teamId = null;
  let squadId = null;
  let label = 'Senza coppia';
  const electTeam = () => { G.ensureElect(g.id); return G.electOf(g.id); };
  if (dest.newSquad) dest = { squadId: require('./field').createSquad(g.id, { name: dest.newSquad }, actor).id };
  if (dest.teamId) {
    const t = q.get("SELECT * FROM teams WHERE id = ? AND gameId = ? AND kind = 'couple'", Number(dest.teamId), g.id);
    if (!t) throw err(404, 'Coppia non trovata');
    if (t.status === 'withdrawn') throw err(409, 'Coppia ritirata');
    if (t.id !== p.teamId && q.get('SELECT COUNT(*) AS n FROM players WHERE teamId = ?', t.id).n >= 2) throw err(409, 'La coppia è già completa: prima sposta fuori uno dei due');
    teamId = t.id;
    label = `Settore ${G.sectorById(t.sectorId)?.name || '?'}`;
  } else if (dest.squadId) {
    const sq = q.get('SELECT * FROM elect_squads WHERE id = ? AND gameId = ?', Number(dest.squadId), g.id);
    if (!sq) throw err(404, 'Squadra non trovata');
    teamId = electTeam().id;
    squadId = sq.id;
    label = `Eletti · ${sq.name}`;
  } else if (dest.elect) {
    teamId = electTeam().id;
    label = 'Eletti';
  } else if (!dest.none) throw err(400, 'Destinazione non valida');
  if (teamId === p.teamId && (squadId ?? null) === (p.squadId ?? null)) return { ok: true };
  const from = p.teamId ? q.get('SELECT * FROM teams WHERE id = ?', p.teamId) : null;
  tx(() => {
    q.run('UPDATE players SET teamId = ?, squadId = ? WHERE id = ?', teamId, squadId, p.id);
    q.run("UPDATE teams SET checkinAt = NULL, checkinBy = NULL WHERE id IN (?, ?) AND kind = 'couple'", p.teamId ?? 0, teamId ?? 0);
  });
  const fromLabel = !from ? 'Senza coppia' : from.kind === 'elect' ? 'Eletti' : `Settore ${G.sectorById(from.sectorId)?.name || '?'}`;
  G.log(g.id, actor, 'player_moved', { name: p.name, from: fromLabel, to: label });
  rt.toStaff(g.id, 'squads');
  G.notifyState(g.id);
  return { ok: true };
}

module.exports = { setPlayerCheckin, setTeamCheckin, setChrono, placePlayer, WEAPONS };
