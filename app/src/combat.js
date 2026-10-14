'use strict';
// Alleanze (invito + accettazione, rottura allo stesso modo) e scontri (vinto / perso / pareggio).
// I Sigilli passano da soli: agli alleati quando si stringe l'alleanza, ai vincitori (e ai loro alleati) dopo uno scontro.
const { q, tx } = require('./db');
const C = require('./constants');
const G = require('./game');
const rt = require('./realtime');
const { HttpError } = require('./util');

const err = (status, msg) => new HttpError(status, msg);
const MAX_ALLIANCE = 3; // regolamento: massimo 3 coppie per alleanza
const REQUEST_TTL_MS = 3 * 60000; // un invito vale per la durata di una trattativa (con margine)
const RETRY_BLOCK_MS = 15 * 60000; // blocco riproposta alla stessa coppia

// ---------------------------------------------------------------- utilità

function team(id) {
  return q.get(`SELECT t.*, s.name AS sectorName, s.roman FROM teams t LEFT JOIN sectors s ON s.id = t.sectorId WHERE t.id = ?`, Number(id));
}

function requireCouple(t) {
  if (!t || t.kind !== 'couple') throw err(403, 'Alleanze e scontri riguardano le coppie');
  if (t.status === 'withdrawn') throw err(409, 'Coppia ritirata');
}

function requirePlaying(gameId, { engagement = false } = {}) {
  const g = G.getGame(gameId);
  if (g.status === 'paused') throw err(409, 'Partita sospesa');
  if (!C.ACTIVE.includes(g.status)) throw err(409, 'Si gioca solo a partita in corso');
  if (engagement && g.status === 'truce') throw err(409, 'Tregua: nessun ingaggio');
  return g;
}

function allianceOf(teamId) {
  const m = q.get('SELECT allianceId FROM alliance_members WHERE teamId = ? AND leftAt IS NULL', teamId);
  if (!m) return null;
  return { id: m.allianceId, members: q.all('SELECT teamId FROM alliance_members WHERE allianceId = ? AND leftAt IS NULL ORDER BY joinedAt', m.allianceId).map((r) => r.teamId) };
}

// La "parte" di una coppia in uno scontro: lei e i suoi alleati.
const sideOf = (teamId) => allianceOf(teamId)?.members || [teamId];

function startTimer(teamId, timerId, reason) {
  q.run('INSERT INTO team_timers (teamId, timerId, startedAt, reason) VALUES (?, ?, ?, ?)', teamId, timerId, Date.now(), reason);
}

// Il Sigillo di un Settore arriva nel taccuino di una coppia (se non lo conosce già).
function giveCode(toTeamId, fromTeamId, source) {
  const to = team(toTeamId);
  const from = team(fromTeamId);
  if (!to || !from?.sectorId || to.id === from.id) return false;
  const sc = q.get('SELECT code FROM sector_codes WHERE gameId = ? AND sectorId = ?', from.gameId, from.sectorId);
  if (!sc) return false;
  if (q.get('SELECT 1 FROM team_code_notes WHERE teamId = ? AND sectorId = ? AND correct = 1', to.id, from.sectorId)) return false;
  q.run('INSERT INTO team_code_notes (teamId, sectorId, code, correct, addedAt, source) VALUES (?, ?, ?, 1, ?, ?)', to.id, from.sectorId, sc.code, Date.now(), source);
  return true;
}

const names = (ids) => ids.map((id) => team(id)?.sectorName).filter(Boolean);

function notify(teamIds, gameId, push) {
  for (const id of new Set(teamIds)) {
    rt.toTeams(gameId, 'state', {}, id);
    if (push) rt.pushTeams(gameId, { ...push, url: push.url || '/#/scontri' }, id);
  }
  rt.toStaff(gameId, 'combat');
}

function expireOld(gameId) {
  q.run("UPDATE alliance_requests SET status = 'expired', respondedAt = ? WHERE gameId = ? AND status = 'pending' AND createdAt < ?", Date.now(), gameId, Date.now() - REQUEST_TTL_MS);
}

// ---------------------------------------------------------------- alleanze

function requestAlliance(me, toTeamId) {
  requireCouple(me);
  requirePlaying(me.gameId);
  expireOld(me.gameId);
  const other = team(toTeamId);
  requireCouple(other);
  if (other.gameId !== me.gameId || other.id === me.id) throw err(400, 'Coppia non valida');
  const mine = sideOf(me.id);
  const theirs = sideOf(other.id);
  if (mine.includes(other.id)) throw err(409, `Siete già alleati con ${other.sectorName}`);
  if (mine.length + theirs.length > MAX_ALLIANCE) throw err(409, `Un'alleanza ha al massimo ${MAX_ALLIANCE} coppie`);
  if (q.get("SELECT 1 FROM alliance_requests WHERE gameId = ? AND status = 'pending' AND ((fromTeamId = ? AND toTeamId = ?) OR (fromTeamId = ? AND toTeamId = ?))", me.gameId, me.id, other.id, other.id, me.id)) {
    throw err(409, 'C\'è già una proposta in attesa tra voi');
  }
  const last = q.get("SELECT respondedAt FROM alliance_requests WHERE kind = 'join' AND fromTeamId = ? AND toTeamId = ? AND status = 'rejected' ORDER BY id DESC LIMIT 1", me.id, other.id);
  if (last && Date.now() - last.respondedAt < RETRY_BLOCK_MS) {
    throw err(409, `Blocco riproposta: potrete riproporre l'alleanza a ${other.sectorName} tra ${Math.ceil((RETRY_BLOCK_MS - (Date.now() - last.respondedAt)) / 60000)} minuti`);
  }
  const id = Number(q.run("INSERT INTO alliance_requests (gameId, kind, fromTeamId, toTeamId, status, createdAt) VALUES (?, 'join', ?, ?, 'pending', ?)", me.gameId, me.id, other.id, Date.now()).lastInsertRowid);
  G.log(me.gameId, `coppia:${me.id}`, 'alliance_proposed', { from: me.sectorName, to: other.sectorName });
  notify([other.id, me.id], me.gameId, null);
  rt.pushTeams(me.gameId, { title: 'Proposta di alleanza', body: `Il Settore ${me.sectorName} vi propone un'alleanza. Rispondete nell'app.`, tag: `ally-${id}`, url: '/#/scontri' }, other.id);
  return { ok: true, id };
}

function requestBreak(me, allyTeamId) {
  requireCouple(me);
  requirePlaying(me.gameId);
  expireOld(me.gameId);
  const ally = team(allyTeamId);
  const a = allianceOf(me.id);
  if (!a || !a.members.includes(ally?.id) || ally.id === me.id) throw err(409, 'Non siete alleati con questa coppia');
  if (q.get("SELECT 1 FROM alliance_requests WHERE kind = 'break' AND status = 'pending' AND fromTeamId = ?", me.id)) throw err(409, 'Avete già chiesto di rompere l\'alleanza: attendete la risposta');
  const id = Number(q.run("INSERT INTO alliance_requests (gameId, kind, fromTeamId, toTeamId, status, createdAt) VALUES (?, 'break', ?, ?, 'pending', ?)", me.gameId, me.id, ally.id, Date.now()).lastInsertRowid);
  G.log(me.gameId, `coppia:${me.id}`, 'alliance_break_proposed', { from: me.sectorName, to: ally.sectorName });
  notify([ally.id, me.id], me.gameId, null);
  rt.pushTeams(me.gameId, { title: 'Rottura dell\'alleanza', body: `Il Settore ${me.sectorName} vuole rompere l'alleanza. Rispondete nell'app.`, tag: `ally-${id}`, url: '/#/scontri' }, ally.id);
  return { ok: true, id };
}

function respondRequest(me, requestId, accept) {
  requireCouple(me);
  expireOld(me.gameId);
  const r = q.get('SELECT * FROM alliance_requests WHERE id = ?', Number(requestId));
  if (!r || r.toTeamId !== me.id) throw err(404, 'Proposta non trovata');
  if (r.status !== 'pending') throw err(409, r.status === 'expired' ? 'Proposta scaduta: chiedete di rifarla' : 'Proposta già chiusa');
  requirePlaying(me.gameId);
  const from = team(r.fromTeamId);
  if (!accept) {
    q.run("UPDATE alliance_requests SET status = 'rejected', respondedAt = ? WHERE id = ?", Date.now(), r.id);
    if (r.kind === 'join') {
      // Trattativa fallita: blocco ingaggio tra le due coppie.
      startTimer(me.id, 'blocco', `Trattativa fallita con ${from.sectorName}`);
      startTimer(from.id, 'blocco', `Trattativa fallita con ${me.sectorName}`);
    }
    G.log(me.gameId, `coppia:${me.id}`, r.kind === 'join' ? 'alliance_rejected' : 'alliance_break_rejected', { from: from.sectorName, to: me.sectorName });
    notify([from.id, me.id], me.gameId, null);
    rt.pushTeams(me.gameId, { title: r.kind === 'join' ? 'Alleanza rifiutata' : 'Rottura rifiutata', body: `Il Settore ${me.sectorName} ha rifiutato.`, tag: `ally-${r.id}`, url: '/#/scontri' }, from.id);
    return { ok: true, accepted: false };
  }
  let members;
  tx(() => {
    q.run("UPDATE alliance_requests SET status = 'accepted', respondedAt = ? WHERE id = ?", Date.now(), r.id);
    if (r.kind === 'join') {
      const mine = sideOf(from.id);
      const theirs = sideOf(me.id);
      if (mine.length + theirs.length > MAX_ALLIANCE) throw err(409, `Un'alleanza ha al massimo ${MAX_ALLIANCE} coppie`);
      // Si uniscono le due parti (coppie singole o alleanze) in una sola alleanza.
      const keep = allianceOf(from.id)?.id || allianceOf(me.id)?.id
        || Number(q.run('INSERT INTO alliances (gameId, createdAt) VALUES (?, ?)', me.gameId, Date.now()).lastInsertRowid);
      for (const id of new Set([...mine, ...theirs])) {
        const cur = allianceOf(id);
        if (cur?.id === keep) continue;
        if (cur) q.run('UPDATE alliance_members SET leftAt = ? WHERE teamId = ? AND leftAt IS NULL', Date.now(), id);
        q.run('INSERT INTO alliance_members (allianceId, teamId, joinedAt) VALUES (?, ?, ?)', keep, id, Date.now());
      }
      members = allianceOf(me.id).members;
      // Stringendo l'alleanza ci si mostra i Sigilli: ogni alleato riceve quelli degli altri.
      for (const a of members) for (const b of members) if (a !== b) giveCode(a, b, 'alliance');
    } else {
      const a = allianceOf(from.id);
      members = a ? [...a.members] : [from.id, me.id];
      q.run('UPDATE alliance_members SET leftAt = ? WHERE teamId = ? AND leftAt IS NULL', Date.now(), from.id);
      const rest = q.all('SELECT teamId FROM alliance_members WHERE allianceId = ? AND leftAt IS NULL', a.id);
      if (rest.length < 2) {
        q.run('UPDATE alliance_members SET leftAt = ? WHERE allianceId = ? AND leftAt IS NULL', Date.now(), a.id);
        q.run('UPDATE alliances SET endedAt = ? WHERE id = ?', Date.now(), a.id);
      }
      // Alleanza rotta: blocco ingaggio tra chi esce e chi resta.
      for (const id of members) startTimer(id, 'blocco', `Alleanza rotta (${from.sectorName})`);
    }
  });
  G.log(me.gameId, `coppia:${me.id}`, r.kind === 'join' ? 'alliance_formed' : 'alliance_broken', { teams: names(members) });
  notify(members, me.gameId, r.kind === 'join'
    ? { title: 'Alleanza stretta', body: `Alleati: ${names(members).join(', ')}. Avete ricevuto i loro Sigilli.`, tag: `ally-${r.id}` }
    : { title: 'Alleanza rotta', body: `Il Settore ${from.sectorName} lascia l'alleanza. Blocco ingaggio 5 minuti.`, tag: `ally-${r.id}` });
  return { ok: true, accepted: true };
}

function cancelRequest(me, requestId) {
  const r = q.get('SELECT * FROM alliance_requests WHERE id = ?', Number(requestId));
  if (!r || r.fromTeamId !== me.id || r.status !== 'pending') throw err(404, 'Proposta non trovata');
  q.run("UPDATE alliance_requests SET status = 'cancelled', respondedAt = ? WHERE id = ?", Date.now(), r.id);
  notify([r.toTeamId, me.id], me.gameId, null);
  return { ok: true };
}

// ---------------------------------------------------------------- scontri

function applyEngagement(e, by) {
  const winners = JSON.parse(e.winners);
  const losers = JSON.parse(e.losers);
  const won = [];
  tx(() => {
    q.run("UPDATE engagements SET status = 'confirmed', resolvedAt = ?, resolvedBy = ? WHERE id = ?", Date.now(), by, e.id);
    if (e.result === 'draw') {
      for (const id of [...winners, ...losers]) startTimer(id, 'blocco', 'Pareggio');
      return;
    }
    // Ogni vincitore (e ogni suo alleato) riceve i Sigilli di tutta la parte sconfitta.
    for (const w of winners) for (const l of losers) if (giveCode(w, l, 'won')) won.push(l);
    for (const l of losers) startTimer(l, 'veglia', `Sconfitta contro ${names(winners).join(', ')}`);
  });
  G.log(e.gameId, by, 'engagement_confirmed', { result: e.result, winners: names(winners), losers: names(losers) });
  if (e.result === 'draw') {
    notify([...winners, ...losers], e.gameId, { title: 'Pareggio', body: 'Blocco ingaggio: 5 minuti.', tag: `eng-${e.id}` });
    return;
  }
  notify(winners, e.gameId, { title: 'Scontro vinto', body: `Sigilli conquistati: ${names(losers).join(', ')}. Li trovate nel taccuino.`, tag: `eng-${e.id}`, url: '/#/codici' });
  notify(losers, e.gameId, { title: 'Scontro perso', body: 'Cappellino: Veglia di 2 minuti, poi tornate in gioco.', tag: `eng-${e.id}`, url: '/#/timer' });
}

function reportEngagement(me, opponentTeamId, result) {
  requireCouple(me);
  requirePlaying(me.gameId, { engagement: true });
  if (!['won', 'lost', 'draw'].includes(result)) throw err(400, 'Esito non valido');
  const opp = team(opponentTeamId);
  requireCouple(opp);
  if (opp.gameId !== me.gameId || opp.id === me.id) throw err(400, 'Avversario non valido');
  const mine = sideOf(me.id);
  if (mine.includes(opp.id)) throw err(409, 'Non si combatte contro un alleato');
  const theirs = sideOf(opp.id);
  const winners = result === 'lost' ? theirs : mine;
  const losers = result === 'lost' ? mine : theirs;
  // "Vinto" va confermato dallo sconfitto; "perso" e "pareggio" valgono subito.
  const status = result === 'won' ? 'pending' : 'confirmed';
  const id = Number(q.run('INSERT INTO engagements (gameId, reporterTeamId, opponentTeamId, result, status, winners, losers, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    me.gameId, me.id, opp.id, result, 'pending', JSON.stringify(winners), JSON.stringify(losers), Date.now()).lastInsertRowid);
  const e = q.get('SELECT * FROM engagements WHERE id = ?', id);
  G.log(me.gameId, `coppia:${me.id}`, 'engagement_reported', { result, reporter: me.sectorName, opponent: opp.sectorName });
  if (status === 'confirmed') {
    applyEngagement(e, `coppia:${me.id}`);
  } else {
    notify([...losers, me.id], me.gameId, null);
    rt.pushTeams(me.gameId, { title: 'Confermate la sconfitta', body: `Il Settore ${me.sectorName} dichiara di avervi sconfitto. Confermate o contestate nell'app.`, tag: `eng-${id}`, url: '/#/scontri' }, opp.id);
    for (const l of losers) if (l !== opp.id) rt.toTeams(me.gameId, 'state', {}, l);
  }
  return { ok: true, id, status };
}

function respondEngagement(me, engagementId, confirm) {
  requireCouple(me);
  const e = q.get('SELECT * FROM engagements WHERE id = ?', Number(engagementId));
  if (!e || !JSON.parse(e.losers).includes(me.id)) throw err(404, 'Scontro non trovato');
  if (e.status !== 'pending') throw err(409, 'Scontro già registrato');
  if (confirm) {
    applyEngagement(e, `coppia:${me.id}`);
    return { ok: true, status: 'confirmed' };
  }
  q.run("UPDATE engagements SET status = 'contested', resolvedAt = ? WHERE id = ?", Date.now(), e.id);
  G.log(e.gameId, `coppia:${me.id}`, 'engagement_contested', { by: me.sectorName, reporter: team(e.reporterTeamId).sectorName });
  notify([e.reporterTeamId, me.id], e.gameId, null);
  rt.pushMasters({ title: 'Scontro contestato', body: `${team(e.reporterTeamId).sectorName} contro ${me.sectorName}: serve la regia.`, url: '/regia#live' });
  return { ok: true, status: 'contested' };
}

// La regia decide gli scontri contestati (o annulla un esito).
function resolveEngagement(engagementId, decision, actor) {
  const e = q.get('SELECT * FROM engagements WHERE id = ?', Number(engagementId));
  if (!e) throw err(404, 'Scontro non trovato');
  if (!['pending', 'contested'].includes(e.status)) throw err(409, 'Scontro già chiuso');
  if (decision === 'confirm') applyEngagement(e, actor);
  else if (decision === 'cancel') {
    q.run("UPDATE engagements SET status = 'cancelled', resolvedAt = ?, resolvedBy = ? WHERE id = ?", Date.now(), actor, e.id);
    G.log(e.gameId, actor, 'engagement_cancelled', { id: e.id });
    notify([...JSON.parse(e.winners), ...JSON.parse(e.losers)], e.gameId, null);
  } else throw err(400, 'Decisione non valida');
}

// ---------------------------------------------------------------- viste

const teamLite = (id) => { const t = team(id); return t ? { teamId: t.id, sectorName: t.sectorName, roman: t.roman, displayName: t.displayName } : null; };

function engagementOut(e, meId) {
  const winners = JSON.parse(e.winners);
  const losers = JSON.parse(e.losers);
  return {
    id: e.id, result: e.result, status: e.status, createdAt: e.createdAt, resolvedAt: e.resolvedAt,
    reporter: teamLite(e.reporterTeamId), opponent: teamLite(e.opponentTeamId),
    winners: winners.map(teamLite), losers: losers.map(teamLite),
    mine: meId ? (e.result === 'draw' ? 'draw' : winners.includes(meId) ? 'won' : losers.includes(meId) ? 'lost' : null) : null,
  };
}

function combatState(me) {
  if (me.kind !== 'couple') return null;
  expireOld(me.gameId);
  const a = allianceOf(me.id);
  const allied = new Set(a?.members || [me.id]);
  const now = Date.now();
  const blocks = {};
  for (const r of q.all("SELECT toTeamId, respondedAt FROM alliance_requests WHERE kind = 'join' AND fromTeamId = ? AND status = 'rejected' AND respondedAt > ?", me.id, now - RETRY_BLOCK_MS)) {
    blocks[r.toTeamId] = Math.max(blocks[r.toTeamId] || 0, r.respondedAt + RETRY_BLOCK_MS);
  }
  const reqOut = (r) => ({ id: r.id, kind: r.kind, createdAt: r.createdAt, expiresAt: r.createdAt + REQUEST_TTL_MS, team: teamLite(r.kind === 'join' || r.toTeamId !== me.id ? r.toTeamId : r.fromTeamId) });
  const recent = q.all('SELECT * FROM engagements WHERE gameId = ? ORDER BY id DESC LIMIT 60', me.gameId)
    .filter((e) => [...JSON.parse(e.winners), ...JSON.parse(e.losers)].includes(me.id));
  return {
    maxAlliance: MAX_ALLIANCE,
    alliance: a ? { id: a.id, members: a.members.map(teamLite) } : null,
    teams: G.teamsOf(me.gameId).filter((t) => t.id !== me.id && t.sectorId && t.status !== 'withdrawn')
      .map((t) => ({ teamId: t.id, sectorName: t.sectorName, roman: t.roman, displayName: t.displayName, allied: allied.has(t.id), allianceSize: sideOf(t.id).length, retryAt: blocks[t.id] || null })),
    incoming: q.all("SELECT * FROM alliance_requests WHERE toTeamId = ? AND status = 'pending' ORDER BY id", me.id)
      .map((r) => ({ ...reqOut(r), team: teamLite(r.fromTeamId) })),
    outgoing: q.all("SELECT * FROM alliance_requests WHERE fromTeamId = ? AND status = 'pending' ORDER BY id", me.id).map((r) => ({ ...reqOut(r), team: teamLite(r.toTeamId) })),
    toConfirm: recent.filter((e) => e.status === 'pending' && JSON.parse(e.losers).includes(me.id)).map((e) => engagementOut(e, me.id)),
    history: recent.slice(0, 15).map((e) => engagementOut(e, me.id)),
  };
}

// Timer avviati dal server (Veglia dopo una sconfitta, blocchi): i telefoni li fanno partire da soli.
function serverTimers(teamId) {
  return q.all('SELECT * FROM team_timers WHERE teamId = ? AND startedAt > ? ORDER BY id', teamId, Date.now() - 30 * 60000);
}

function masterCombat(gameId) {
  expireOld(gameId);
  const alliances = q.all('SELECT * FROM alliances WHERE gameId = ? AND endedAt IS NULL ORDER BY id', gameId)
    .map((a) => ({ id: a.id, createdAt: a.createdAt, members: q.all('SELECT teamId FROM alliance_members WHERE allianceId = ? AND leftAt IS NULL', a.id).map((m) => teamLite(m.teamId)) }))
    .filter((a) => a.members.length > 1);
  return {
    alliances,
    open: q.all("SELECT * FROM engagements WHERE gameId = ? AND status IN ('pending','contested') ORDER BY id DESC", gameId).map((e) => engagementOut(e)),
    recent: q.all("SELECT * FROM engagements WHERE gameId = ? AND status IN ('confirmed','cancelled') ORDER BY id DESC LIMIT 20", gameId).map((e) => engagementOut(e)),
    requests: q.all("SELECT * FROM alliance_requests WHERE gameId = ? AND status = 'pending' ORDER BY id", gameId)
      .map((r) => ({ id: r.id, kind: r.kind, from: teamLite(r.fromTeamId), to: teamLite(r.toTeamId), createdAt: r.createdAt })),
  };
}

module.exports = { requestAlliance, requestBreak, respondRequest, cancelRequest, reportEngagement, respondEngagement, resolveEngagement, combatState, serverTimers, masterCombat, allianceOf, MAX_ALLIANCE };
