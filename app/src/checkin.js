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

// Spunta di un'arma: manuale (on/off) oppure dal cronografo (misura con joule, velocità e peso del pallino).
// Una misura da 1 joule in su non passa: l'arma resta (o torna) da provare e il tentativo finisce nel registro.
// manualFail: test segnato a mano come negativo (da 1 J in su), senza letture del cronografo.
function setChrono(gameId, playerId, weapon, on, actor, shot = null, manualFail = false) {
  const col = WEAPONS[weapon];
  if (!col) throw err(400, 'Arma non valida');
  const p = playerOf(gameId, playerId);
  if (!p.checkinAt) throw err(409, 'Prima va accettato all\'ingresso');
  let shots = {};
  try { shots = JSON.parse(p.chronoShots || '{}') || {}; } catch { shots = {}; }
  const j = shot && Number(shot.joule);
  if (shot && !(Number.isFinite(j) && j >= 0)) throw err(400, 'Misura non valida');
  const fail = manualFail || (shot && j >= 1);
  const passed = shot ? !fail : manualFail ? false : on;
  // Più letture: si salva la media (che decide se passa), il massimo e le singole letture.
  const readings = Array.isArray(shot?.readings) ? shot.readings.slice(0, 50).map((r) => ({ j: Math.round(Number(r.j) * 1000) / 1000, v: Math.round(Number(r.v) * 100) / 100, ...(Number(r.g) > 0 ? { g: Math.round(Number(r.g) * 1000) / 1000 } : {}) })).filter((r) => Number.isFinite(r.j)) : null;
  if (shot) shots[weapon] = { j: Math.round(j * 1000) / 1000, v: Number(shot.mps) || null, g: Number(shot.grams) || null, max: readings?.length ? Math.max(...readings.map((r) => r.j)) : null, n: readings?.length || 1, readings, at: Date.now(), by: actor, ok: !fail };
  else if (manualFail) shots[weapon] = { manual: true, ok: false, j: null, at: Date.now(), by: actor };
  else delete shots[weapon];
  q.run(`UPDATE players SET ${col} = ?, chronoBy = ?, chronoShots = ? WHERE id = ?`, passed ? Date.now() : null, actor, JSON.stringify(shots), p.id);
  const data = { name: p.name, arma: WEAPON_LABELS[weapon], ...(manualFail ? { manuale: true } : shot ? { joule: j.toFixed(2), 'm/s': Number(shot.mps).toFixed(2), ...(readings?.length > 1 ? { letture: readings.length, media: true } : {}) } : { manuale: true }) };
  G.log(gameId, actor, fail ? 'chrono_fail' : passed ? 'chrono_ok' : 'chrono_undo', data);
  G.notifyState(gameId);
  return { ok: !fail, joule: shot ? j : null };
}

// Persona finita al test armi: si chiude (sparisce dalla lista) o si riapre.
function setChronoDone(gameId, playerId, on, actor) {
  const p = playerOf(gameId, playerId);
  q.run('UPDATE players SET chronoDoneAt = ? WHERE id = ?', on ? Date.now() : null, p.id);
  G.log(gameId, actor, on ? 'chrono_closed' : 'chrono_reopened', { name: p.name });
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

// Dati per le pagine di accettazione e test armi dello staff (stessa forma dello stato della regia).
function checkinData(gameId) {
  const g = G.getGame(gameId);
  const elect = G.electOf(g.id);
  return {
    game: { id: g.id, name: g.name, status: g.status, scheduledStart: g.scheduledStart || null },
    clock: G.clockOf(g),
    players: q.all(`SELECT p.id, p.name, p.nickname, p.status, p.teamId, p.squadId, p.softairTeam, p.checkinAt, p.chronoMain, p.chronoBackup, p.chronoSecondary, p.chronoShots, p.chronoDoneAt, a.username
                    FROM players p LEFT JOIN accounts a ON a.id = p.accountId WHERE p.gameId = ? ORDER BY p.id`, g.id),
    teams: G.teamsOf(g.id).map((t) => ({ id: t.id, roman: t.roman, sectorName: t.sectorName, displayName: t.displayName, color: t.sectorColor, status: t.status, checkinAt: t.checkinAt || null })),
    elect: elect ? { id: elect.id } : null,
    squads: q.all('SELECT id, name, color FROM elect_squads WHERE gameId = ? ORDER BY id', g.id),
  };
}

module.exports = { setPlayerCheckin, setTeamCheckin, setChrono, setChronoDone, placePlayer, checkinData, WEAPONS };
