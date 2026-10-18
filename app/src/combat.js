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
  return q.get(`SELECT t.*, s.name AS sectorName, s.roman, s.color AS sectorColor FROM teams t LEFT JOIN sectors s ON s.id = t.sectorId WHERE t.id = ?`, Number(id));
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

// Skill (caricato al bisogno: skills.js usa questo modulo).
const SK = () => require('./skills');

// minutes: durata diversa da quella del timer della partita (Veglia Forzata, Ritirata del Diplomatico).
function startTimer(teamId, timerId, reason, minutes = null) {
  q.run('INSERT INTO team_timers (teamId, timerId, startedAt, reason, minutes) VALUES (?, ?, ?, ?, ?)', teamId, timerId, Date.now(), reason, minutes);
}
const presetMin = (gameId, timerId) => ((JSON.parse(G.getGame(gameId).timers || 'null') || C.DEFAULT_TIMERS).find((t) => t.id === timerId)?.minutes) || 0;

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

// Settori di cui una coppia conosce il Sigillo: il proprio, quelli rivelati dal Consiglio, quelli nel taccuino.
function knownSectors(t) {
  const set = new Set(t.sectorId ? [t.sectorId] : []);
  for (const r of G.revealedCodes(t.gameId)) set.add(r.sectorId);
  for (const n of q.all('SELECT sectorId FROM team_code_notes WHERE teamId = ? AND correct = 1', t.id)) set.add(n.sectorId);
  return set;
}

// Vittoria senza Sigilli nuovi: si ruba un Sigillo dal taccuino della parte sconfitta (di tutta l'alleanza),
// tra quelli che il vincitore non conosce ancora.
function stealCandidates(e, winnerId) {
  const me = team(winnerId);
  const mine = knownSectors(me);
  const pool = new Set();
  const hidden = JSON.parse(e.hidden || '{}');
  for (const l of JSON.parse(e.losers)) {
    const lt = team(l);
    // Reliquia Antica: nessun Sigillo di quella coppia si ruba. Immunità: solo il suo resta coperto.
    if (hidden[l] === 'reliquia') continue;
    for (const sid of knownSectors(lt)) if (!mine.has(sid) && !(hidden[l] && sid === lt.sectorId)) pool.add(sid);
  }
  return q.all('SELECT s.id AS sectorId, s.name AS sectorName, s.roman FROM sectors s JOIN sector_codes c ON c.sectorId = s.id AND c.gameId = ? ORDER BY s.ord', me.gameId)
    .filter((s) => pool.has(s.sectorId));
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

function requestAlliance(me, toTeamId, opts = {}) {
  requireCouple(me);
  if (opts.diplomat) SK().checkSkill(me, 'diplomatico');
  requirePlaying(me.gameId);
  expireOld(me.gameId);
  const other = team(toTeamId);
  requireCouple(other);
  if (other.gameId !== me.gameId || other.id === me.id) throw err(400, 'Coppia non valida');
  const mine = sideOf(me.id);
  if (mine.includes(other.id)) throw err(409, `Siete già alleati con ${other.sectorName}`);
  // Le alleanze degli altri sono segrete: qui si controlla solo la propria; il totale si verifica all'accettazione.
  if (mine.length >= MAX_ALLIANCE) throw err(409, `La vostra alleanza è al completo (${MAX_ALLIANCE} coppie)`);
  if (q.get("SELECT 1 FROM alliance_requests WHERE gameId = ? AND status = 'pending' AND ((fromTeamId = ? AND toTeamId = ?) OR (fromTeamId = ? AND toTeamId = ?))", me.gameId, me.id, other.id, other.id, me.id)) {
    throw err(409, 'C\'è già una proposta in attesa tra voi');
  }
  const last = q.get("SELECT respondedAt FROM alliance_requests WHERE kind = 'join' AND fromTeamId = ? AND toTeamId = ? AND status = 'rejected' ORDER BY id DESC LIMIT 1", me.id, other.id);
  if (last && Date.now() - last.respondedAt < RETRY_BLOCK_MS) {
    throw err(409, `Blocco riproposta: potrete riproporre l'alleanza a ${other.sectorName} tra ${Math.ceil((RETRY_BLOCK_MS - (Date.now() - last.respondedAt)) / 60000)} minuti`);
  }
  const id = Number(q.run("INSERT INTO alliance_requests (gameId, kind, fromTeamId, toTeamId, status, createdAt, diplomat) VALUES (?, 'join', ?, ?, 'pending', ?, ?)", me.gameId, me.id, other.id, Date.now(), opts.diplomat ? 1 : 0).lastInsertRowid);
  G.log(me.gameId, `coppia:${me.id}`, 'alliance_proposed', { from: me.sectorName, to: other.sectorName });
  notify([other.id, me.id], me.gameId, null);
  rt.pushTeams(me.gameId, { title: 'Proposta di alleanza', body: `Il Settore ${me.sectorName} vi propone un'alleanza. Rispondete nell'app.`, tag: `ally-${id}`, url: '/#/alleanze' }, other.id);
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
  rt.pushTeams(me.gameId, { title: 'Rottura dell\'alleanza', body: `Il Settore ${me.sectorName} vuole rompere l'alleanza. Rispondete nell'app.`, tag: `ally-${id}`, url: '/#/alleanze' }, ally.id);
  return { ok: true, id };
}

function respondRequest(me, requestId, accept, opts = {}) {
  requireCouple(me);
  expireOld(me.gameId);
  const r = q.get('SELECT * FROM alliance_requests WHERE id = ?', Number(requestId));
  if (!r || r.toTeamId !== me.id) throw err(404, 'Proposta non trovata');
  if (r.status !== 'pending') throw err(409, r.status === 'expired' ? 'Proposta scaduta: chiedete di rifarla' : 'Proposta già chiusa');
  requirePlaying(me.gameId);
  const from = team(r.fromTeamId);
  // Diplomatico: chi lo usa (chi propone o chi accetta) entra nell'alleanza senza mostrare il proprio Sigillo.
  const diplomats = new Set();
  if (accept && r.kind === 'join') {
    if (opts.diplomat) { SK().checkSkill(me, 'diplomatico'); diplomats.add(me.id); }
    if (r.diplomat) { try { SK().checkSkill(from, 'diplomatico'); diplomats.add(from.id); } catch { /* ricarica partita nel frattempo: alleanza normale */ } }
  }
  if (!accept) {
    q.run("UPDATE alliance_requests SET status = 'rejected', respondedAt = ? WHERE id = ?", Date.now(), r.id);
    if (r.kind === 'join') {
      // Trattativa fallita: blocco ingaggio tra le due coppie (8 minuti con la Ritirata del Diplomatico).
      const retreat = SK().hasSkill(me.id, 'ritirata') || SK().hasSkill(from.id, 'ritirata') ? 8 : null;
      startTimer(me.id, 'blocco', `Trattativa fallita con ${from.sectorName}${retreat ? ' (Ritirata del Diplomatico)' : ''}`, retreat);
      startTimer(from.id, 'blocco', `Trattativa fallita con ${me.sectorName}${retreat ? ' (Ritirata del Diplomatico)' : ''}`, retreat);
    }
    G.log(me.gameId, `coppia:${me.id}`, r.kind === 'join' ? 'alliance_rejected' : 'alliance_break_rejected', { from: from.sectorName, to: me.sectorName });
    notify([from.id, me.id], me.gameId, null);
    rt.pushTeams(me.gameId, { title: r.kind === 'join' ? 'Alleanza rifiutata' : 'Rottura rifiutata', body: `Il Settore ${me.sectorName} ha rifiutato.`, tag: `ally-${r.id}`, url: '/#/alleanze' }, from.id);
    return { ok: true, accepted: false };
  }
  let members;
  tx(() => {
    q.run("UPDATE alliance_requests SET status = 'accepted', respondedAt = ? WHERE id = ?", Date.now(), r.id);
    if (r.kind === 'join') {
      const mine = sideOf(from.id);
      const theirs = sideOf(me.id);
      if (mine.length + theirs.length > MAX_ALLIANCE) throw err(409, `Alleanza impossibile: insieme superereste le ${MAX_ALLIANCE} coppie`);
      // Si uniscono le due parti (coppie singole o alleanze) in una sola alleanza.
      const keep = allianceOf(from.id)?.id || allianceOf(me.id)?.id
        || Number(q.run('INSERT INTO alliances (gameId, createdAt) VALUES (?, ?)', me.gameId, Date.now()).lastInsertRowid);
      for (const id of new Set([...mine, ...theirs])) {
        const cur = allianceOf(id);
        if (cur?.id === keep) { if (diplomats.has(id)) q.run('UPDATE alliance_members SET hideCode = 1 WHERE allianceId = ? AND teamId = ? AND leftAt IS NULL', keep, id); continue; }
        const wasHidden = cur ? q.get('SELECT hideCode FROM alliance_members WHERE allianceId = ? AND teamId = ? AND leftAt IS NULL', cur.id, id)?.hideCode : 0;
        if (cur) q.run('UPDATE alliance_members SET leftAt = ? WHERE teamId = ? AND leftAt IS NULL', Date.now(), id);
        q.run('INSERT INTO alliance_members (allianceId, teamId, joinedAt, hideCode) VALUES (?, ?, ?, ?)', keep, id, Date.now(), wasHidden || diplomats.has(id) ? 1 : 0);
      }
      members = allianceOf(me.id).members;
      // Stringendo l'alleanza ci si mostra i Sigilli: ogni alleato riceve quelli degli altri (non chi ha usato Diplomatico).
      const hidden = new Set(q.all('SELECT teamId FROM alliance_members WHERE allianceId = ? AND leftAt IS NULL AND hideCode = 1', keep).map((x) => x.teamId));
      for (const a of members) for (const b of members) if (a !== b && !hidden.has(b)) giveCode(a, b, 'alliance');
      for (const d of diplomats) SK().consumeSkill(team(d), 'diplomatico', names(members.filter((x) => x !== d)).join(', '));
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
  G.log(me.gameId, `coppia:${me.id}`, r.kind === 'join' ? 'alliance_formed' : 'alliance_broken', { teams: names(members), diplomats: names([...diplomats]) });
  notify(members, me.gameId, r.kind === 'join'
    ? { title: 'Alleanza stretta', body: `Alleati: ${names(members).join(', ')}. Avete ricevuto i loro Sigilli${diplomats.size ? ' (non quelli protetti da Diplomatico)' : ''}.`, tag: `ally-${r.id}` }
    : { title: 'Alleanza rotta', body: `Il Settore ${from.sectorName} lascia l'alleanza. Blocco ingaggio 5 minuti.`, tag: `ally-${r.id}` });
  return { ok: true, accepted: true };
}

// Rottura per distanza: un alleato che resta per più di 5 minuti a più di 50 m da tutti gli altri esce dall'alleanza.
const FAR_M = 50;
const FAR_MS = 5 * 60000;
const POS_FRESH_MS = 3 * 60000;
const farSince = new Map(); // teamId → da quando è lontano dagli alleati
function distM(a, b) {
  const R = 6371000; const r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function breakForDistance(a, t, meters) {
  const members = [...a.members];
  tx(() => {
    q.run('UPDATE alliance_members SET leftAt = ? WHERE teamId = ? AND leftAt IS NULL', Date.now(), t.id);
    const rest = q.all('SELECT teamId FROM alliance_members WHERE allianceId = ? AND leftAt IS NULL', a.id);
    if (rest.length < 2) {
      q.run('UPDATE alliance_members SET leftAt = ? WHERE allianceId = ? AND leftAt IS NULL', Date.now(), a.id);
      q.run('UPDATE alliances SET endedAt = ? WHERE id = ?', Date.now(), a.id);
    }
    for (const id of members) startTimer(id, 'blocco', `Alleanza rotta per distanza (${t.sectorName})`);
  });
  G.log(t.gameId, 'sistema', 'alliance_broken_distance', { teams: names(members), settore: t.sectorName, metri: Math.round(meters) });
  notify(members, t.gameId, {
    title: 'Alleanza rotta per distanza',
    body: `Il Settore ${t.sectorName} è rimasto per più di 5 minuti a più di ${FAR_M} m dagli alleati: l'alleanza si è rotta. Blocco ingaggio 5 minuti.`,
    tag: `ally-far-${a.id}-${t.id}`, url: '/#/alleanze',
  });
}

function tickAlliances(now = Date.now()) {
  const seen = new Set();
  const games = q.all(`SELECT id FROM games WHERE status IN (${C.ACTIVE.map(() => '?').join(', ')}) AND status <> 'paused'`, ...C.ACTIVE);
  for (const g of games) {
    for (const al of q.all('SELECT id FROM alliances WHERE gameId = ? AND endedAt IS NULL', g.id)) {
      const ids = q.all('SELECT teamId FROM alliance_members WHERE allianceId = ? AND leftAt IS NULL', al.id).map((r) => r.teamId);
      // Ultima posizione recente di ogni coppia (il telefono più aggiornato).
      const pos = {};
      for (const id of ids) {
        const p = q.get('SELECT lat, lng, at FROM positions WHERE teamId = ? AND at > ? ORDER BY at DESC LIMIT 1', id, now - POS_FRESH_MS);
        if (p) pos[id] = p;
      }
      for (const id of ids) {
        seen.add(id);
        const others = ids.filter((x) => x !== id && pos[x]);
        if (!pos[id] || !others.length) { farSince.delete(id); continue; }
        const near = Math.min(...others.map((x) => distM(pos[id], pos[x])));
        if (near <= FAR_M) { farSince.delete(id); continue; }
        if (!farSince.has(id)) farSince.set(id, now);
        if (now - farSince.get(id) > FAR_MS) {
          farSince.delete(id);
          const a = allianceOf(id);
          if (a) breakForDistance(a, team(id), near);
          break; // l'alleanza è cambiata: le altre coppie si ricontrollano al prossimo giro
        }
      }
    }
  }
  for (const id of farSince.keys()) if (!seen.has(id)) farSince.delete(id);
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
  const stealers = [];
  // Sigilli che restano coperti: Immunità (Skill, scelta nello scontro) e Reliquia Antica (Dono attivo).
  const hidden = JSON.parse(e.hidden || '{}');
  for (const l of losers) if (!hidden[l] && SK().reliquiaOn(team(l))) hidden[l] = 'reliquia';
  if (Object.keys(hidden).length) { q.run('UPDATE engagements SET hidden = ? WHERE id = ?', JSON.stringify(hidden), e.id); e.hidden = JSON.stringify(hidden); }
  // Veglia Forzata: chi perde contro chi ce l'ha resta fermo il doppio.
  // Veglia Forzata: chi la ha tra i vincitori raddoppia la Veglia degli sconfitti (es. 2 + 2 minuti).
  const forcer = winners.find((w) => SK().hasSkill(w, 'veglia_forzata'));
  const forced = !!forcer;
  const baseMin = presetMin(e.gameId, 'veglia') || 2;
  const vegliaMin = forced ? 2 * baseMin : null;
  const forcedText = forced ? `Veglia ${baseMin} minuti + ${baseMin} minuti per la Veglia Forzata del Settore ${team(forcer)?.sectorName}` : '';
  tx(() => {
    q.run("UPDATE engagements SET status = 'confirmed', resolvedAt = ?, resolvedBy = ? WHERE id = ?", Date.now(), by, e.id);
    if (e.result === 'draw') {
      for (const id of [...winners, ...losers]) startTimer(id, 'blocco', 'Pareggio');
      return;
    }
    // Ogni vincitore (e ogni suo alleato) riceve i Sigilli di tutta la parte sconfitta.
    const gained = new Set();
    for (const w of winners) for (const l of losers) if (!hidden[l] && giveCode(w, l, 'won')) { won.push(l); gained.add(w); }
    // Chi non ottiene niente di nuovo (li conosceva già tutti) sceglie un Sigillo da rubare alla parte sconfitta.
    for (const w of winners) {
      if (!gained.has(w) && stealCandidates(e, w).length) {
        q.run('INSERT OR IGNORE INTO engagement_steals (engagementId, teamId, createdAt) VALUES (?, ?, ?)', e.id, w, Date.now());
        stealers.push(w);
      }
    }
    const face = team([e.reporterTeamId, e.opponentTeamId].find((id) => winners.includes(id)))?.sectorName || '';
    for (const l of losers) startTimer(l, 'veglia', `Sconfitta contro ${face}${forced ? ` · ${forcedText}` : ''}`, vegliaMin);
  });
  G.log(e.gameId, by, 'engagement_confirmed', { result: e.result, winners: names(winners), losers: names(losers) });
  if (e.result === 'draw') {
    notify([...winners, ...losers], e.gameId, { title: 'Pareggio', body: 'Blocco ingaggio: 5 minuti.', tag: `eng-${e.id}` });
    return;
  }
  notify(winners.filter((w) => !stealers.includes(w)), e.gameId, { title: 'Scontro vinto', body: `Sigilli conquistati: ${names(losers).join(', ')}. Li trovate nel taccuino.`, tag: `eng-${e.id}`, url: '/#/codici' });
  notify(stealers, e.gameId, { title: 'Scontro vinto', body: 'I loro Sigilli li conoscete già: scegliete quale rubare.', tag: `eng-${e.id}`, url: '/#/scontri' });
  notify(losers, e.gameId, { title: 'Scontro perso', body: `${e.skill === 'maestria' ? `Il Settore ${team(e.skillTeamId)?.sectorName} ha ribaltato lo scontro con Maestria delle armi. ` : ''}Cappellino: ${forced ? `${forcedText} (in tutto ${vegliaMin} minuti)` : `Veglia di ${baseMin} minuti`}, poi tornate in gioco.`, tag: `eng-${e.id}`, url: '/#/timer' });
}

function reportEngagement(me, opponentTeamId, result, opts = {}) {
  requireCouple(me);
  requirePlaying(me.gameId, { engagement: true });
  if (!['won', 'lost', 'draw'].includes(result)) throw err(400, 'Esito non valido');
  // Perso, ma con una Skill: Maestria delle armi (diventa vittoria) o Immunità (il Sigillo resta coperto).
  const skill = result === 'lost' && ['maestria', 'immunita'].includes(opts.skill) ? opts.skill : null;
  if (skill) SK().checkSkill(me, skill);
  const opp = team(opponentTeamId);
  requireCouple(opp);
  if (opp.gameId !== me.gameId || opp.id === me.id) throw err(400, 'Avversario non valido');
  const mine = sideOf(me.id);
  if (mine.includes(opp.id)) throw err(409, 'Non si combatte contro un alleato');
  const theirs = sideOf(opp.id);
  const flip = skill === 'maestria';
  const winners = result === 'lost' && !flip ? theirs : mine;
  const losers = result === 'lost' && !flip ? mine : theirs;
  // "Vinto" va confermato dallo sconfitto, "perso" dal vincitore; il pareggio vale subito (e la Maestria delle armi:
  // l'esito dichiarato dall'avversario non conta).
  const status = flip || result === 'draw' ? 'confirmed' : 'pending';
  const id = Number(q.run('INSERT INTO engagements (gameId, reporterTeamId, opponentTeamId, result, status, winners, losers, createdAt, skill, skillTeamId, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    me.gameId, me.id, opp.id, flip ? 'won' : result, 'pending', JSON.stringify(winners), JSON.stringify(losers), Date.now(), skill, skill ? me.id : null,
    skill === 'immunita' ? JSON.stringify({ [me.id]: 'immunita' }) : null).lastInsertRowid);
  const e = q.get('SELECT * FROM engagements WHERE id = ?', id);
  if (skill) SK().consumeSkill(me, skill, opp.sectorName);
  G.log(me.gameId, `coppia:${me.id}`, 'engagement_reported', { result, reporter: me.sectorName, opponent: opp.sectorName, skill });
  if (status === 'confirmed') {
    applyEngagement(e, `coppia:${me.id}`);
  } else {
    // Conferma dalla parte avversaria (la vede la coppia con cui si è combattuto e i suoi alleati).
    notify([...theirs, me.id], me.gameId, null);
    rt.pushTeams(me.gameId, result === 'won'
      ? { title: 'Confermate la sconfitta', body: `Il Settore ${me.sectorName} dichiara di avervi sconfitto. Confermate o contestate nell'app.`, tag: `eng-${id}`, url: '/#/scontri' }
      : { title: 'Confermate la vittoria', body: `Il Settore ${me.sectorName} dichiara di aver perso contro di voi. Confermate o contestate nell'app.`, tag: `eng-${id}`, url: '/#/scontri' }, opp.id);
  }
  return { ok: true, id, status };
}

function respondEngagement(me, engagementId, confirm, opts = {}) {
  requireCouple(me);
  const e = q.get('SELECT * FROM engagements WHERE id = ?', Number(engagementId));
  // Risponde la parte avversaria di chi ha dichiarato (sconfitti per un «vinto», vincitori per un «perso»).
  const other = e ? (JSON.parse(e.winners).includes(e.reporterTeamId) ? JSON.parse(e.losers) : JSON.parse(e.winners)) : [];
  if (!e || !other.includes(me.id)) throw err(404, 'Scontro non trovato');
  const iLost = JSON.parse(e.losers).includes(me.id);
  if (e.status !== 'pending') throw err(409, 'Scontro già registrato');
  const skill = confirm && iLost && ['maestria', 'immunita'].includes(opts.skill) ? opts.skill : null;
  if (skill) {
    SK().checkSkill(me, skill);
    if (skill === 'maestria') {
      // L'esito dichiarato dall'avversario non conta: vince chi usa la Maestria (e la sua parte).
      q.run('UPDATE engagements SET winners = ?, losers = ?, skill = ?, skillTeamId = ? WHERE id = ?', e.losers, e.winners, 'maestria', me.id, e.id);
    } else {
      q.run('UPDATE engagements SET skill = ?, skillTeamId = ?, hidden = ? WHERE id = ?', 'immunita', me.id, JSON.stringify({ ...JSON.parse(e.hidden || '{}'), [me.id]: 'immunita' }), e.id);
    }
    SK().consumeSkill(me, skill, team(e.reporterTeamId)?.sectorName);
  }
  if (confirm) {
    applyEngagement(q.get('SELECT * FROM engagements WHERE id = ?', e.id), `coppia:${me.id}`);
    return { ok: true, status: 'confirmed', skill };
  }
  q.run("UPDATE engagements SET status = 'contested', resolvedAt = ? WHERE id = ?", Date.now(), e.id);
  G.log(e.gameId, `coppia:${me.id}`, 'engagement_contested', { by: me.sectorName, reporter: team(e.reporterTeamId).sectorName });
  notify([e.reporterTeamId, me.id], e.gameId, null);
  rt.pushMasters({ title: 'Scontro contestato', body: `${team(e.reporterTeamId).sectorName} contro ${me.sectorName}: serve la regia.`, url: '/regia#live' });
  return { ok: true, status: 'contested' };
}

// Velenoso: subito dopo uno scontro registrato (vinto o perso), una coppia della parte che ha la Skill rompe
// l'alleanza della parte avversaria. Una volta per scontro.
function poison(me, engagementId) {
  requireCouple(me);
  requirePlaying(me.gameId);
  const e = q.get('SELECT * FROM engagements WHERE id = ?', Number(engagementId));
  const winners = e ? JSON.parse(e.winners) : [];
  const losers = e ? JSON.parse(e.losers) : [];
  if (!e || e.gameId !== me.gameId || ![...winners, ...losers].includes(me.id)) throw err(404, 'Scontro non trovato');
  if (e.status !== 'confirmed' || e.result === 'draw') throw err(409, 'Velenoso si usa dopo uno scontro vinto o perso');
  if (e.poisonBy) throw err(409, 'In questo scontro Velenoso è già stato usato');
  if (Date.now() - (e.resolvedAt || e.createdAt) > VICTORY_SHOW_MS) throw err(409, 'Troppo tardi: Velenoso si usa subito dopo lo scontro');
  const enemySide = winners.includes(me.id) ? losers : winners;
  const face = team([e.reporterTeamId, e.opponentTeamId].find((id) => enemySide.includes(id)));
  const a = allianceOf(face.id);
  if (!a) throw err(409, `Il Settore ${face.sectorName} non è in alleanza`);
  if (SK().immune(face)) throw err(409, `Il Settore ${face.sectorName} è protetto da un'Immunità`);
  SK().checkSkill(me, 'velenoso');
  const members = [...a.members];
  tx(() => {
    q.run('UPDATE alliance_members SET leftAt = ? WHERE allianceId = ? AND leftAt IS NULL', Date.now(), a.id);
    q.run('UPDATE alliances SET endedAt = ? WHERE id = ?', Date.now(), a.id);
    q.run('UPDATE engagements SET poisonBy = ? WHERE id = ?', me.id, e.id);
    for (const id of members) startTimer(id, 'blocco', `Alleanza rotta dal Velenoso del Settore ${me.sectorName}`);
  });
  SK().consumeSkill(me, 'velenoso', names(members).join(', '));
  G.log(me.gameId, `coppia:${me.id}`, 'alliance_poisoned', { by: me.sectorName, teams: names(members) });
  notify(members, me.gameId, { title: 'Alleanza avvelenata', body: `Il Settore ${me.sectorName} ha usato Velenoso: la vostra alleanza è rotta. Blocco ingaggio 5 minuti.`, tag: `poison-${e.id}`, url: '/#/alleanze' });
  notify([me.id], me.gameId, null);
  return { ok: true, broken: names(members) };
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

const teamLite = (id) => { const t = team(id); return t ? { teamId: t.id, sectorName: t.sectorName, roman: t.roman, displayName: t.displayName, color: t.sectorColor } : null; };

function engagementOut(e, meId) {
  let winners = JSON.parse(e.winners);
  let losers = JSON.parse(e.losers);
  // Per le coppie l'alleanza dell'altra parte resta segreta: di là si vede solo chi ha combattuto direttamente.
  if (meId) {
    const face = (side) => [[e.reporterTeamId, e.opponentTeamId].find((id) => side.includes(id))];
    if (winners.includes(meId)) losers = face(losers);
    else if (losers.includes(meId)) winners = face(winners);
  }
  return {
    id: e.id, result: e.result, status: e.status, createdAt: e.createdAt, resolvedAt: e.resolvedAt,
    reporter: teamLite(e.reporterTeamId), opponent: teamLite(e.opponentTeamId),
    winners: winners.map(teamLite), losers: losers.map(teamLite),
    mine: meId ? (e.result === 'draw' ? 'draw' : winners.includes(meId) ? 'won' : losers.includes(meId) ? 'lost' : null) : null,
    skill: e.skill || null, skillBy: e.skillTeamId ? teamLite(e.skillTeamId) : null,
    hidden: JSON.parse(e.hidden || '{}'), poisonBy: e.poisonBy ? teamLite(e.poisonBy) : null,
    // Velenoso si può usare: scontro registrato da poco e parte avversaria in alleanza (lo vede solo chi ha la Skill).
    canPoison: !!(meId && e.status === 'confirmed' && e.result !== 'draw' && !e.poisonBy && Date.now() - (e.resolvedAt || e.createdAt) < VICTORY_SHOW_MS
      && SK().hasSkill(meId, 'velenoso') && (() => { const enemy = JSON.parse(e.winners).includes(meId) ? JSON.parse(e.losers) : JSON.parse(e.winners); const f = [e.reporterTeamId, e.opponentTeamId].find((id) => enemy.includes(id)); return f && !!allianceOf(f); })()),
  };
}

const VICTORY_SHOW_MS = 10 * 60000;

// Il vincitore sceglie quale Sigillo rubare: lo riceve nel taccuino e lo vede svelarsi.
function stealCode(me, engagementId, sectorId) {
  requireCouple(me);
  const s = q.get('SELECT * FROM engagement_steals WHERE engagementId = ? AND teamId = ?', Number(engagementId), me.id);
  if (!s) throw err(404, 'Nessun Sigillo da rubare per questo scontro');
  if (s.chosenAt) throw err(409, 'Avete già scelto il Sigillo di questo scontro');
  const e = q.get('SELECT * FROM engagements WHERE id = ?', s.engagementId);
  const pick = stealCandidates(e, me.id).find((c) => c.sectorId === Number(sectorId));
  if (!pick) throw err(409, 'Questo Sigillo non si può rubare: sceglietene un altro');
  const sc = q.get('SELECT code FROM sector_codes WHERE gameId = ? AND sectorId = ?', me.gameId, pick.sectorId);
  tx(() => {
    q.run('INSERT INTO team_code_notes (teamId, sectorId, code, correct, addedAt, source) VALUES (?, ?, ?, 1, ?, ?)', me.id, pick.sectorId, sc.code, Date.now(), 'won');
    q.run('UPDATE engagement_steals SET sectorId = ?, chosenAt = ? WHERE id = ?', pick.sectorId, Date.now(), s.id);
  });
  G.log(me.gameId, `coppia:${me.id}`, 'seal_stolen', { by: me.sectorName, sector: pick.sectorName, engagementId: e.id });
  rt.toTeams(me.gameId, 'state', {}, me.id);
  rt.toStaff(me.gameId, 'combat');
  return { ...pick, code: sc.code };
}

// Furti ancora da scegliere (il popup si può chiudere: la scelta resta nella pagina Scontri).
function pendingSteals(me) {
  return q.all('SELECT * FROM engagement_steals WHERE teamId = ? AND chosenAt IS NULL ORDER BY id', me.id).map((s) => {
    const e = q.get('SELECT * FROM engagements WHERE id = ?', s.engagementId);
    if (!e || e.status !== 'confirmed') return null;
    const candidates = stealCandidates(e, me.id);
    return candidates.length ? { engagementId: e.id, against: victoryOut(e).against, candidates } : null;
  }).filter(Boolean);
}

function victoryOut(e) {
  const winners = JSON.parse(e.winners);
  const face = [e.reporterTeamId, e.opponentTeamId].find((id) => !winners.includes(id));
  const hidden = JSON.parse(e.hidden || '{}');
  const seals = JSON.parse(e.losers).map((id) => {
    const t = team(id);
    const sc = t?.sectorId ? q.get('SELECT code FROM sector_codes WHERE gameId = ? AND sectorId = ?', t.gameId, t.sectorId) : null;
    if (!sc) return null;
    // Immunità o Reliquia Antica: il Sigillo resta sfocato, con il motivo.
    if (hidden[id]) return { sectorId: t.sectorId, sectorName: t.sectorName, roman: t.roman, code: null, hiddenBy: hidden[id] === 'reliquia' ? 'Reliquia Antica' : 'Immunità', length: sc.code.length };
    return { sectorId: t.sectorId, sectorName: t.sectorName, roman: t.roman, code: sc.code };
  }).filter(Boolean);
  return { id: e.id, resolvedAt: e.resolvedAt, against: teamLite(face), seals, skill: e.skill, skillBy: e.skillTeamId ? teamLite(e.skillTeamId) : null };
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
      .map((t) => ({ teamId: t.id, sectorName: t.sectorName, roman: t.roman, displayName: t.displayName, allied: allied.has(t.id), retryAt: blocks[t.id] || null })),
    incoming: q.all("SELECT * FROM alliance_requests WHERE toTeamId = ? AND status = 'pending' ORDER BY id", me.id)
      .map((r) => ({ ...reqOut(r), team: teamLite(r.fromTeamId) })),
    outgoing: q.all("SELECT * FROM alliance_requests WHERE fromTeamId = ? AND status = 'pending' ORDER BY id", me.id).map((r) => ({ ...reqOut(r), team: teamLite(r.toTeamId) })),
    toConfirm: recent.filter((e) => e.status === 'pending' && (JSON.parse(e.winners).includes(e.reporterTeamId) ? JSON.parse(e.losers) : JSON.parse(e.winners)).includes(me.id))
      .map((e) => engagementOut(e, me.id)),
    // Vittorie appena confermate (anche degli alleati): il telefono mostra la Vittoria con i Sigilli di tutta
    // la parte sconfitta, anche quelli che si conoscevano già (rivelati, annotati, da un'alleanza).
    steals: pendingSteals(me),
    victories: recent.filter((e) => e.status === 'confirmed' && e.result !== 'draw' && JSON.parse(e.winners).includes(me.id) && e.resolvedAt > now - VICTORY_SHOW_MS)
      .map((e) => victoryOut(e)),
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
    // Tutti gli scontri della partita per la timeline della regia (con i Sigilli rubati).
    timeline: q.all('SELECT * FROM engagements WHERE gameId = ? ORDER BY id DESC LIMIT 300', gameId).map((e) => ({
      ...engagementOut(e),
      steals: q.all('SELECT s.teamId, s.chosenAt, x.name AS sectorName FROM engagement_steals s LEFT JOIN sectors x ON x.id = s.sectorId WHERE s.engagementId = ?', e.id)
        .map((x) => ({ team: teamLite(x.teamId), sectorName: x.sectorName, chosen: !!x.chosenAt })),
    })),
    requests: q.all("SELECT * FROM alliance_requests WHERE gameId = ? AND status = 'pending' ORDER BY id", gameId)
      .map((r) => ({ id: r.id, kind: r.kind, from: teamLite(r.fromTeamId), to: teamLite(r.toTeamId), createdAt: r.createdAt })),
  };
}

module.exports = { poison, knownSectors, tickAlliances, FAR_M, FAR_MS, stealCode, requestAlliance, requestBreak, respondRequest, cancelRequest, reportEngagement, respondEngagement, resolveEngagement, combatState, serverTimers, masterCombat, allianceOf, MAX_ALLIANCE };
