'use strict';
// Motore di gioco: setup, macchina a stati, calendario, sblocchi, validazione, classifica.
const fs = require('fs');
const path = require('path');
const { q, tx, DATA_DIR } = require('./db');
const C = require('./constants');
const { randomCode, randomToken, shuffle, normText, normCode, HttpError, ordinal } = require('./util');
const rt = require('./realtime');

const err = (status, msg) => new HttpError(status, msg);

// ---------------------------------------------------------------- lettura

function getGame(id) {
  const g = q.get('SELECT * FROM games WHERE id = ?', Number(id));
  if (!g) throw err(404, 'Partita non trovata');
  return g;
}

const templatesOf = (g) => ({ ...C.DEFAULT_TEMPLATES, ...(g.templates ? JSON.parse(g.templates) : {}) });
const timersOf = (g) => (g.timers ? JSON.parse(g.timers) : C.DEFAULT_TIMERS);

// Settori (e i loro Altari): dati di configurazione modificabili dalla regia.
let sectorCache = null;
function sectors() {
  if (!sectorCache) sectorCache = q.all('SELECT * FROM sectors ORDER BY ord, id');
  return sectorCache;
}
const activeSectors = () => sectors().filter((s) => !s.archived);
const sectorById = (id) => sectors().find((s) => s.id === id);
const defaultAltarLabel = (s) => `Altare ${s.article}${s.article.endsWith("'") ? '' : ' '}${s.name}`;
const altarLabel = (s) => s.altarLabel?.trim() || defaultAltarLabel(s);

function teamsOf(gameId) {
  return q.all(`SELECT t.*, s.name AS sectorName, s.roman, s.ord AS sectorOrd, s.article, s.motto, s.element, s.color AS sectorColor
                FROM teams t LEFT JOIN sectors s ON s.id = t.sectorId
                WHERE t.gameId = ? AND t.kind = 'couple' ORDER BY COALESCE(s.ord, 99), t.id`, gameId);
}

function membersOf(teamId) {
  return q.all('SELECT id, name, nickname, phone, softairTeam, squadId FROM players WHERE teamId = ? ORDER BY id', teamId);
}

// ---------------------------------------------------------------- tempo

function elapsedMs(g, now = Date.now()) {
  if (!g.startedAt) return 0;
  let paused = g.totalPausedMs || 0;
  if (g.status === 'paused' && g.pausedAt) paused += now - g.pausedAt;
  const end = g.status === 'ended' && g.endedAt ? g.endedAt : now;
  return Math.max(0, end - g.startedAt - paused);
}

function clockOf(g, now = Date.now()) {
  const e = elapsedMs(g, now);
  const dur = g.durationMin * 60000;
  return {
    serverNow: now,
    status: g.status,
    statusLabel: C.STATUS_LABELS[g.status],
    pausedFrom: g.pausedFrom,
    running: C.ACTIVE.includes(g.status),
    elapsedMs: e,
    durationMs: dur,
    huntAtMs: g.truceMin * 60000,
    lastPhaseAtMs: (g.durationMin - C.LAST_PHASE_MIN) * 60000,
    startedAt: g.startedAt,
  };
}

// ---------------------------------------------------------------- log e annunci

function log(gameId, actor, type, data = null) {
  q.run('INSERT INTO event_log (gameId, at, actor, type, data) VALUES (?, ?, ?, ?, ?)',
    gameId, Date.now(), actor || 'sistema', type, data ? JSON.stringify(data) : null);
  rt.toStaff(gameId, type);
}

const fill = (tpl, vars) => tpl.replace(/\[(\w+)\]/g, (m, k) => (vars[k] != null ? vars[k] : m));

function announce(gameId, type, vars = {}, payload = null, customText = null) {
  const g = getGame(gameId);
  const text = customText || fill(templatesOf(g)[type] || '', vars);
  const now = Date.now();
  const r = q.run('INSERT INTO announcements (gameId, type, text, payload, createdAt) VALUES (?, ?, ?, ?, ?)',
    gameId, type, text, payload ? JSON.stringify(payload) : null, now);
  const a = { id: Number(r.lastInsertRowid), type, text, payload, createdAt: now };
  rt.toTeams(gameId, 'announcement', a);
  rt.pushTeams(gameId, { title: 'Consiglio Zero', body: text, tag: `ann-${a.id}`, url: '/#/annunci' });
  log(gameId, 'sistema', 'announcement', { type, text });
  return a;
}

function notifyState(gameId) {
  rt.toTeams(gameId, 'state', {});
  rt.toStaff(gameId, 'state');
}

// ---------------------------------------------------------------- partite

const GAME_FIELDS = ['name', 'scheduledStart', 'durationMin', 'truceMin', 'firstRevelationDelayMin', 'lastRevelationBeforeEndMin',
  'neverRevealedCount', 'codeLength', 'emergencyRadioChannel', 'bookUrl', 'registrationOpen', 'altarScanMin', 'maxCouples', 'maxSingles', 'maxActiveSkills', 'maxPassiveSkills', 'nodeScanMin', 'eyeMin', 'eyeRadiusM'];
const INT_FIELDS = new Set(['durationMin', 'truceMin', 'firstRevelationDelayMin', 'lastRevelationBeforeEndMin', 'neverRevealedCount', 'codeLength', 'altarScanMin', 'maxCouples', 'maxSingles', 'maxActiveSkills', 'maxPassiveSkills', 'nodeScanMin', 'eyeMin', 'eyeRadiusM']);
// Campi numerici facoltativi: vuoto = nessun valore (si usa il predefinito).
const NULLABLE_INT = new Set(['maxCouples', 'maxSingles']);
// Parametri che cambiano tempi o Sigilli: modificabili solo prima del via.
const LOCKED_AFTER_START = new Set(['maxActiveSkills', 'maxPassiveSkills', 'durationMin', 'truceMin', 'firstRevelationDelayMin', 'lastRevelationBeforeEndMin', 'neverRevealedCount', 'codeLength']);

function createGame(data, actor) {
  if (!data.name?.trim()) throw err(400, 'Il nome della partita è obbligatorio');
  const r = q.run(`INSERT INTO games (name, scheduledStart, emergencyRadioChannel, bookUrl, createdAt) VALUES (?, ?, ?, ?, ?)`,
    data.name.trim(), data.scheduledStart || null, data.emergencyRadioChannel || null, data.bookUrl || '/regolamento.html', Date.now());
  const id = Number(r.lastInsertRowid);
  updateGame(id, data, actor);
  log(id, actor, 'game_created', { name: data.name });
  return getGame(id);
}

function updateGame(id, data, actor) {
  const g = getGame(id);
  const started = !C.PRE_START.includes(g.status);
  const sets = [];
  const vals = [];
  for (const f of GAME_FIELDS) {
    if (data[f] === undefined) continue;
    if (started && LOCKED_AFTER_START.has(f)) continue;
    let v = data[f];
    if (NULLABLE_INT.has(f) && (v === '' || v === null)) v = null;
    else if (INT_FIELDS.has(f)) {
      v = parseInt(v, 10);
      if (!Number.isFinite(v) || v < 0) throw err(400, `Valore non valido per ${f}`);
    }
    if (f === 'codeLength' && (v < 4 || v > 12)) throw err(400, 'La lunghezza del Sigillo deve essere tra 4 e 12');
    if (f === 'durationMin' && v < 40) throw err(400, 'Durata troppo breve');
    if (f === 'registrationOpen') v = v ? 1 : 0;
    sets.push(`${f} = ?`);
    vals.push(v === '' ? null : v);
  }
  if (data.templates !== undefined) {
    const t = {};
    for (const k of Object.keys(C.DEFAULT_TEMPLATES)) if (data.templates[k] && data.templates[k] !== C.DEFAULT_TEMPLATES[k]) t[k] = String(data.templates[k]);
    sets.push('templates = ?');
    vals.push(JSON.stringify(t));
  }
  if (data.timers !== undefined) {
    const t = C.DEFAULT_TIMERS.map((d) => {
      const m = parseFloat(data.timers?.[d.id]);
      return { ...d, minutes: Number.isFinite(m) && m > 0 ? m : d.minutes };
    });
    sets.push('timers = ?');
    vals.push(JSON.stringify(t));
  }
  if (!sets.length) return g;
  q.run(`UPDATE games SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
  log(id, actor, 'game_updated', { fields: Object.keys(data) });
  if (C.PRE_START.includes(g.status) && ['durationMin', 'truceMin', 'firstRevelationDelayMin', 'lastRevelationBeforeEndMin'].some((f) => data[f] !== undefined)) {
    retimeCalendar(getGame(id));
  }
  if (C.PRE_START.includes(g.status) && data.neverRevealedCount !== undefined && q.get('SELECT 1 FROM sector_codes WHERE gameId = ?', id)) {
    extractNeverRevealed(getGame(id), actor);
  }
  notifyState(id);
  return getGame(id);
}

function deleteGame(id, actor) {
  const g = getGame(id);
  if (C.ACTIVE.includes(g.status) || g.status === 'paused') throw err(409, 'Non si può eliminare una partita in corso');
  q.run('DELETE FROM games WHERE id = ?', g.id);
  log(null, actor, 'game_deleted', { id: g.id, name: g.name });
}

/**
 * Traccar Client di una persona, nello stato della sua partita:
 * - «soon» = partita pronta o cerchio aperto (si parte a breve), «live» = partita in corso;
 * - in quei momenti servono almeno 2 segnali, l'ultimo negli ultimi 10 minuti: altrimenti «prompt» = chiedi di accenderlo;
 * - state: 'ok' (acceso/verificato) · 'off' (verificato ma spento) · 'stale' (tace durante la partita) · 'none' (mai verificato).
 */
// Traccar Client di default manda un segnale ogni 5 minuti (o a ogni spostamento): finestra di 10 minuti anche prima del via.
const TRACK_SOON_MS = 10 * 60000;
const TRACK_LIVE_MS = 10 * 60000;
const TRACK_ON_PINGS = 2;
const TRACK_PINGS_WINDOW_MS = 30 * 60000;
function trackStateOf(player, game, team) {
  const soon = !!team && ['ready', 'circle'].includes(game.status);
  const live = !!team && (team.kind === 'elect' ? !['draft', 'ended'].includes(game.status) && !soon : [...C.ACTIVE, 'paused'].includes(game.status) && team.status !== 'withdrawn');
  const verified = !!player.trackVerifiedAt;
  if (!soon && !live) return { state: verified ? 'ok' : 'none', soon, live, prompt: false };
  // Traccar acceso: almeno 2 segnali (nell'ultima mezz'ora) e l'ultimo recente.
  const recent = player.trackSeenAt && Date.now() - player.trackSeenAt < (soon ? TRACK_SOON_MS : TRACK_LIVE_MS)
    && q.get('SELECT COUNT(*) AS n FROM track_pings WHERE playerId = ? AND at > ?', player.id, Date.now() - TRACK_PINGS_WINDOW_MS).n >= TRACK_ON_PINGS;
  if (recent) return { state: 'ok', soon, live, prompt: false, on: true };
  return { state: !verified ? 'none' : soon ? 'off' : 'stale', soon, live, prompt: true };
}

function requirePreStart(g, what = 'Questa modifica') {
  if (!C.PRE_START.includes(g.status)) throw err(409, `${what} è possibile solo prima del via`);
}

// ---------------------------------------------------------------- giocatori: iscrizione e approvazione

// Chi si iscrive online resta "da approvare" finché la regia non lo accetta; chi aggiunge la regia è già accettato.
function addPlayer(gameId, p, { actor, self = false, regGroup = null, requestedTeamName = null, requestedRole = null } = {}) {
  if (!p?.name?.trim()) throw err(400, 'Il nome del giocatore è obbligatorio');
  if (self && !String(p.softairTeam || '').trim()) throw err(400, `Indica il team di softair di ${p.name.trim()} (o "nessuno")`);
  const r = q.run(`INSERT INTO players (gameId, name, nickname, softairTeam, phone, note, regGroup, requestedTeamName, requestedRole, status, selfRegistered, loginToken, accessCode, createdAt)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    gameId, p.name.trim().slice(0, 80), p.nickname?.trim().slice(0, 40) || null, String(p.softairTeam || '').trim().slice(0, 60) || null, p.phone?.trim().slice(0, 30) || null,
    p.note?.trim().slice(0, 300) || null, regGroup, requestedTeamName, requestedRole, self ? 'pending' : 'accepted', self ? 1 : 0,
    randomToken(24), uniqueAccessCode(), Date.now());
  log(gameId, actor || 'iscrizione', 'player_added', { name: p.name, pending: self });
  return Number(r.lastInsertRowid);
}

function publicRegister(data) {
  const g = getGame(data.gameId);
  if (!g.registrationOpen || g.status !== 'draft') throw err(409, 'Le iscrizioni a questa partita sono chiuse');
  // Tre strade: la coppia (due Legati), il temerario solitario (verrà accoppiato a caso), gli Eletti del Consiglio.
  const mode = ['pair', 'single', 'elect'].includes(data.mode) ? data.mode : (data.players || []).length >= 2 ? 'pair' : 'single';
  const players = (data.players || []).filter((p) => p?.name?.trim()).slice(0, mode === 'pair' ? 2 : 1);
  if (mode === 'pair' && players.length !== 2) throw err(400, 'Una coppia sono due Legati: inserite entrambi i nomi');
  if (!players.length) throw err(400, 'Inserisci il tuo nome');
  const group = mode === 'pair' ? randomToken(6) : null;
  const teamName = mode === 'pair' ? data.teamName?.trim().slice(0, 60) || null : null;
  const ids = tx(() => players.map((p) => addPlayer(g.id, p, { self: true, regGroup: group, requestedTeamName: teamName, requestedRole: mode })));
  const what = { pair: 'Iscrizione coppia', single: 'Temerario solitario', elect: 'Candidatura agli Eletti' }[mode];
  rt.pushMasters({ title: `${what} da approvare`, body: `${players.map((p) => p.name).join(' e ')} — ${g.name}`, url: mode === 'elect' ? '/regia#squadre' : '/regia#coppie', tag: `iscrizione-${ids[0]}` });
  rt.toStaff(g.id, 'registration');
  return { ok: true, mode, paired: mode === 'pair', playerIds: ids };
}

// Accetta o rifiuta un'iscrizione: chi si è iscritto insieme viene deciso insieme.
// opts.squadId: per i candidati agli Eletti, la squadra in cui entrano subito.
function reviewPlayer(id, decision, actor, opts = {}) {
  const pl = q.get('SELECT * FROM players WHERE id = ?', id);
  if (!pl) throw err(404, 'Giocatore non trovato');
  const group = pl.regGroup ? q.all('SELECT * FROM players WHERE gameId = ? AND regGroup = ?', pl.gameId, pl.regGroup) : [pl];
  if (decision === 'accept') {
    tx(() => group.forEach((p) => q.run("UPDATE players SET status = 'accepted' WHERE id = ?", p.id)));
    // Un candidato agli Eletti accettato entra subito nel gruppo.
    const electIds = group.filter((p) => p.requestedRole === 'elect' && !p.teamId).map((p) => p.id);
    if (electIds.length) {
      addToElect(pl.gameId, electIds, actor);
      const sq = opts.squadId ? q.get('SELECT id FROM elect_squads WHERE id = ? AND gameId = ?', Number(opts.squadId), pl.gameId) : null;
      if (sq) for (const pid of electIds) q.run('UPDATE players SET squadId = ? WHERE id = ?', sq.id, pid);
    }
    const subs = q.all(`SELECT * FROM push_subs WHERE playerId IN (${group.map(() => '?').join(',')})`, ...group.map((p) => p.id));
    rt.pushSubs(subs, { title: 'Il Consiglio vi ha accettati', body: electIds.length ? 'Siete tra gli Eletti del Consiglio.' : 'Presto riceverete il vostro Settore.', tag: 'accepted', url: '/#/home' });
    rt.toTeams(pl.gameId, 'state', {});
  } else if (decision === 'reject') {
    if (group.some((p) => p.teamId)) throw err(409, 'Già in coppia o tra gli Eletti: toglilo prima');
    tx(() => group.forEach((p) => {
      q.run("DELETE FROM sessions WHERE kind = 'player' AND refId = ?", p.id);
      q.run('DELETE FROM players WHERE id = ?', p.id);
    }));
  } else throw err(400, 'Decisione non valida');
  log(pl.gameId, actor, decision === 'accept' ? 'registration_accepted' : 'registration_rejected', { names: group.map((p) => p.name) });
  return { count: group.length };
}

function updatePlayer(id, p, actor) {
  const pl = q.get('SELECT * FROM players WHERE id = ?', id);
  if (!pl) throw err(404, 'Giocatore non trovato');
  q.run('UPDATE players SET name = COALESCE(?, name), nickname = ?, phone = ?, note = ?, softairTeam = ? WHERE id = ?',
    p.name?.trim() || null, p.nickname?.trim() || null, p.phone?.trim() || null, p.note?.trim() || null,
    p.softairTeam !== undefined ? String(p.softairTeam || '').trim() || null : pl.softairTeam, id);
  log(pl.gameId, actor, 'player_updated', { id });
}

function deletePlayer(id, actor) {
  const pl = q.get('SELECT * FROM players WHERE id = ?', id);
  if (!pl) throw err(404, 'Giocatore non trovato');
  if (pl.teamId) throw err(409, 'Il giocatore è in una coppia o tra gli Eletti: toglilo prima');
  q.run("DELETE FROM sessions WHERE kind = 'player' AND refId = ?", id);
  q.run('DELETE FROM players WHERE id = ?', id);
  log(pl.gameId, actor, 'player_deleted', { name: pl.name });
}

// Codici d'accesso unici tra coppie, Eletti e giocatori.
function uniqueAccessCode() {
  for (;;) {
    const c = randomCode(8);
    if (!q.get('SELECT 1 FROM teams WHERE accessCode = ?', c) && !q.get('SELECT 1 FROM players WHERE accessCode = ?', c)) return c;
  }
}

// Giocatori creati prima dell'accesso personale: genera le credenziali mancanti.
function ensurePlayerCredentials() {
  for (const p of q.all('SELECT id FROM players WHERE loginToken IS NULL OR accessCode IS NULL')) {
    q.run('UPDATE players SET loginToken = ?, accessCode = ? WHERE id = ?', randomToken(24), uniqueAccessCode(), p.id);
  }
}

// ---------------------------------------------------------------- coppie (il Settore lo assegna il Consiglio)

function availableSectors(gameId) {
  const used = new Set(q.all('SELECT sectorId FROM teams WHERE gameId = ? AND sectorId IS NOT NULL', gameId).map((r) => r.sectorId));
  return activeSectors().filter((s) => !used.has(s.id));
}

// Prima i Settori che hanno già un Altare (magari già piazzato nel bosco), poi gli altri.
/**
 * Posti liberi per l'iscrizione. La regia decide quanti Settori aprire (N, di base tutti i Settori attivi):
 * N Settori sono 2N posti. Settori liberi per le coppie = N − coppie iscritte − temerari già accoppiabili (2 = 1 Settore);
 * posti per i temerari = 2N − 2 × coppie iscritte − temerari iscritti. Esempio: 9 Settori, 3 coppie e 1 temerario
 * in attesa → 6 Settori per le coppie, 18 − 6 − 1 = 11 posti per i temerari.
 * Contano le iscrizioni in attesa e quelle accettate.
 */
function spotsOf(gameId) {
  const g = getGame(gameId);
  const capacity = g.maxCouples ?? activeSectors().length;
  const live = "status IN ('pending','accepted')";
  const pairs = q.get(`SELECT COUNT(DISTINCT regGroup) AS n FROM players WHERE gameId = ? AND ${live} AND requestedRole = 'pair'`, g.id).n;
  const singles = q.get(`SELECT COUNT(*) AS n FROM players WHERE gameId = ? AND ${live} AND requestedRole = 'single'`, g.id).n;
  // Giocatori aggiunti a mano dalla regia (non Eletti): occupano mezza coppia ciascuno.
  const others = q.get(`SELECT COUNT(*) AS n FROM players p LEFT JOIN teams t ON t.id = p.teamId
                        WHERE p.gameId = ? AND p.${live} AND p.requestedRole IS NULL AND COALESCE(t.kind, 'couple') != 'elect'`, g.id).n;
  const loose = singles + others;
  const couples = Math.max(0, capacity - pairs - Math.floor(loose / 2));
  let freeSingles = Math.max(0, capacity * 2 - pairs * 2 - loose);
  if (g.maxSingles != null) freeSingles = Math.max(0, Math.min(freeSingles, g.maxSingles - singles));
  return { couples, singles: freeSingles, capacity, places: capacity * 2, maxSingles: g.maxSingles ?? null, taken: { pairs, singles, others } };
}

function firstFreeSector(gameId) {
  const withAltar = new Set(q.all('SELECT sectorId FROM points WHERE gameId = ?', gameId).map((r) => r.sectorId));
  const free = availableSectors(gameId);
  return free.find((s) => withAltar.has(s.id)) || free[0];
}

function createTeam(gameId, data, actor) {
  const g = getGame(gameId);
  if (!['draft', 'ready'].includes(g.status)) throw err(409, 'Le coppie si formano prima di aprire il cerchio');
  const ids = [...new Set((data.playerIds || []).map(Number))];
  if (ids.length !== 2) throw err(400, 'Seleziona due giocatori per formare la coppia');
  const teamId = tx(() => {
    const pls = ids.map((id) => q.get('SELECT * FROM players WHERE id = ? AND gameId = ?', id, g.id));
    if (pls.some((p) => !p)) throw err(400, 'Giocatore non valido');
    if (pls.some((p) => p.status !== 'accepted')) throw err(409, 'Prima accetta l\'iscrizione dei giocatori');
    if (pls.some((p) => p.teamId)) throw err(409, 'Uno dei giocatori è già in coppia o tra gli Eletti');
    const sector = data.sectorId ? sectorById(Number(data.sectorId)) : firstFreeSector(g.id);
    if (!sector) throw err(409, 'Non ci sono più Settori liberi: aggiungine uno in "Settori e Altari"');
    if (q.get('SELECT 1 FROM teams WHERE gameId = ? AND sectorId = ?', g.id, sector.id)) throw err(409, `Il Settore ${sector.name} è già assegnato`);
    const name = data.displayName?.trim() || pls[0].requestedTeamName || null;
    const r = q.run(`INSERT INTO teams (gameId, sectorId, displayName, loginToken, accessCode, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
      g.id, sector.id, name, randomToken(24), uniqueAccessCode(), Date.now());
    const teamId = Number(r.lastInsertRowid);
    for (const p of pls) q.run('UPDATE players SET teamId = ? WHERE id = ?', teamId, p.id);
    log(g.id, actor, 'team_created', { teamId, sector: sector.name, members: pls.map((p) => p.name) });
    return teamId;
  });
  syncPoints(g);
  // I telefoni dei giocatori entrati col codice personale diventano subito dispositivi della coppia.
  notifyState(g.id);
  return teamId;
}

function autoPair(gameId, actor) {
  const g = getGame(gameId);
  if (!['draft', 'ready'].includes(g.status)) throw err(409, 'Le coppie si formano prima di aprire il cerchio');
  const free = q.all("SELECT * FROM players WHERE gameId = ? AND teamId IS NULL AND status = 'accepted' ORDER BY id", g.id);
  const created = [];
  // Prima chi si è iscritto insieme, poi gli altri a caso.
  const groups = {};
  for (const p of free) if (p.regGroup) (groups[p.regGroup] ||= []).push(p);
  const used = new Set();
  for (const grp of Object.values(groups)) {
    if (grp.length === 2 && firstFreeSector(g.id)) {
      created.push(createTeam(g.id, { playerIds: grp.map((p) => p.id) }, actor));
      grp.forEach((p) => used.add(p.id));
    }
  }
  const rest = shuffle(free.filter((p) => !used.has(p.id)));
  while (rest.length >= 2 && firstFreeSector(g.id)) {
    created.push(createTeam(g.id, { playerIds: [rest.pop().id, rest.pop().id] }, actor));
  }
  return { created: created.length, leftover: rest.length };
}

// ---------------------------------------------------------------- Eletti del Consiglio

// Un gruppo per partita, con un numero qualsiasi di persone e un proprio accesso all'app.
// Ricevono annunci, avvisi e messaggi; non hanno Sigillo, non usano gli Altari, non sono in classifica.
function electOf(gameId) {
  return q.get("SELECT * FROM teams WHERE gameId = ? AND kind = 'elect'", gameId);
}

function ensureElect(gameId) {
  if (!electOf(gameId)) {
    q.run("INSERT INTO teams (gameId, sectorId, displayName, loginToken, accessCode, kind, createdAt) VALUES (?, NULL, 'Eletti del Consiglio', ?, ?, 'elect', ?)",
      gameId, randomToken(24), uniqueAccessCode(), Date.now());
  }
  return electOf(gameId);
}

function addToElect(gameId, playerIds, actor) {
  const g = getGame(gameId);
  const e = ensureElect(g.id);
  const ids = [...new Set((playerIds || []).map(Number))];
  if (!ids.length) throw err(400, 'Nessuna persona selezionata');
  tx(() => {
    for (const id of ids) {
      const p = q.get('SELECT * FROM players WHERE id = ? AND gameId = ?', id, g.id);
      if (!p) throw err(400, 'Persona non valida');
      if (p.status !== 'accepted') throw err(409, `Prima accetta l'iscrizione di ${p.name}`);
      if (p.teamId) throw err(409, `${p.name} è già in una coppia o tra gli Eletti`);
      q.run('UPDATE players SET teamId = ? WHERE id = ?', e.id, p.id);
    }
  });
  log(g.id, actor, 'elect_added', { count: ids.length });
  notifyState(g.id);
}

function addElectPerson(gameId, p, actor) {
  const id = addPlayer(Number(gameId), p, { actor });
  addToElect(gameId, [id], actor);
  return id;
}

function removeFromElect(playerId, actor) {
  const p = q.get('SELECT * FROM players WHERE id = ?', playerId);
  if (!p) throw err(404, 'Persona non trovata');
  const e = electOf(p.gameId);
  if (!e || p.teamId !== e.id) throw err(409, 'Questa persona non è tra gli Eletti');
  q.run('UPDATE players SET teamId = NULL WHERE id = ?', p.id);
  log(p.gameId, actor, 'elect_removed', { name: p.name });
  notifyState(p.gameId);
}

// Spostamento tra Eletti e coppie: da solo (verso una coppia incompleta o tra gli Eletti) oppure in scambio con
// una persona dell'altra parte. Chi diventa Eletto prende la squadra di chi esce dagli Eletti.
function movePlayer(playerId, { toTeamId, swapWithId } = {}, actor) {
  const p = q.get('SELECT * FROM players WHERE id = ?', Number(playerId));
  if (!p || !p.teamId) throw err(404, 'Persona non trovata in una coppia o tra gli Eletti');
  const g = getGame(p.gameId);
  if (g.status === 'ended') throw err(409, 'Partita finita');
  const from = q.get('SELECT * FROM teams WHERE id = ?', p.teamId);
  const to = q.get('SELECT * FROM teams WHERE id = ? AND gameId = ?', Number(toTeamId), g.id);
  if (!to) throw err(404, 'Destinazione non trovata');
  if (to.id === from.id) throw err(409, 'È già lì');
  if ((from.kind === 'elect') === (to.kind === 'elect')) throw err(409, 'Lo spostamento è tra Eletti e coppie');
  if (to.kind !== 'elect' && to.status === 'withdrawn') throw err(409, 'Coppia ritirata');
  const other = swapWithId ? q.get('SELECT * FROM players WHERE id = ? AND teamId = ?', Number(swapWithId), to.id) : null;
  if (swapWithId && !other) throw err(400, 'La persona da scambiare non è lì');
  if (!other && to.kind === 'couple' && q.get('SELECT COUNT(*) AS n FROM players WHERE teamId = ?', to.id).n >= 2) throw err(409, 'La coppia è completa: scegli con chi scambiare');
  const squad = from.kind === 'elect' ? p.squadId : other?.squadId ?? null;
  tx(() => {
    q.run('UPDATE players SET teamId = ?, squadId = ? WHERE id = ?', to.id, to.kind === 'elect' ? squad : null, p.id);
    if (other) q.run('UPDATE players SET teamId = ?, squadId = ? WHERE id = ?', from.id, from.kind === 'elect' ? squad : null, other.id);
  });
  const label = (t) => (t.kind === 'elect' ? 'Eletti' : `Settore ${sectorById(t.sectorId)?.name || ''}`);
  log(g.id, actor, 'player_moved', { name: p.name, from: label(from), to: label(to), swap: other?.name || null });
  notifyState(g.id);
}

// Luoghi del gioco (la Soglia, il Cerchio di inizio): una riga per partita, creata alla prima richiesta.
const LANDMARKS = [{ kind: 'cerchio', label: 'Cerchio di inizio' }, { kind: 'soglia', label: 'La Soglia' }];
function landmarksOf(gameId) {
  for (const l of LANDMARKS) q.run('INSERT OR IGNORE INTO landmarks (gameId, kind, label) VALUES (?, ?, ?)', gameId, l.kind, l.label);
  q.run("UPDATE landmarks SET exitToken = ? WHERE gameId = ? AND kind = 'soglia' AND exitToken IS NULL", randomToken(18), gameId);
  return q.all("SELECT * FROM landmarks WHERE gameId = ? ORDER BY kind = 'soglia', id", gameId);
}

function requireCouple(team) {
  if (team.kind === 'elect') throw err(403, 'Gli Eletti del Consiglio non usano Altari, Sigilli e frammenti');
}

// ---------------------------------------------------------------- Avvisi

const NOTICE_TARGETS = { all: 'Tutti', couples: 'Solo le coppie', elect: 'Solo gli Eletti', team: 'Una coppia' };

function noticeVisible(n, team) {
  if (team.kind === 'lobby') return n.target === 'all';
  return n.target === 'all' || (n.target === 'couples' && team.kind !== 'elect') || (n.target === 'elect' && team.kind === 'elect') || (n.target === 'team' && n.teamId === team.id);
}

function noticesFor(team) {
  return q.all('SELECT id, title, body, target, teamId, createdAt FROM notices WHERE gameId = ? ORDER BY id DESC', team.gameId).filter((n) => noticeVisible(n, team));
}

function createNotice(gameId, data, actor) {
  const g = getGame(gameId);
  const title = String(data.title || '').trim().slice(0, 80);
  const body = String(data.body || '').trim().slice(0, 1000);
  if (!title) throw err(400, 'Il titolo dell\'avviso è obbligatorio');
  const target = NOTICE_TARGETS[data.target] ? data.target : 'all';
  let teamId = null;
  if (target === 'team') {
    teamId = Number(data.teamId);
    if (!q.get('SELECT 1 FROM teams WHERE id = ? AND gameId = ?', teamId, g.id)) throw err(400, 'Scegli la coppia destinataria');
  }
  const now = Date.now();
  const id = Number(q.run('INSERT INTO notices (gameId, title, body, target, teamId, author, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    g.id, title, body || null, target, teamId, actor || null, now).lastInsertRowid);
  const n = { id, title, body, target, teamId, createdAt: now };
  rt.toTeams(g.id, 'notice', n);
  const subs = rt.gameSubs(g.id).filter((s) => target === 'all' || (target === 'couples' && s.teamKind === 'couple')
    || (target === 'elect' && s.teamKind === 'elect') || (target === 'team' && s.effTeamId === teamId));
  rt.pushSubs(subs, { title: `Avviso · ${title}`, body: body || 'Toccate per leggere l\'avviso del Consiglio.', tag: `notice-${id}`, url: '/#/avvisi' });
  log(g.id, actor, 'notice', { title, target });
  return { ...n, devices: subs.length };
}

function deleteNotice(id, actor) {
  const n = q.get('SELECT * FROM notices WHERE id = ?', id);
  if (!n) throw err(404, 'Avviso non trovato');
  q.run('DELETE FROM notices WHERE id = ?', n.id);
  log(n.gameId, actor, 'notice_deleted', { title: n.title });
  notifyState(n.gameId);
}

function updateTeam(teamId, data, actor) {
  const t = q.get('SELECT * FROM teams WHERE id = ?', teamId);
  if (!t) throw err(404, 'Coppia non trovata');
  const g = getGame(t.gameId);
  if (data.displayName !== undefined) q.run('UPDATE teams SET displayName = ? WHERE id = ?', data.displayName?.trim() || null, t.id);
  if (data.sectorId !== undefined && Number(data.sectorId) !== t.sectorId) {
    if (!['draft', 'ready'].includes(g.status)) throw err(409, 'Il Settore si cambia solo prima di aprire il cerchio');
    const s = sectorById(Number(data.sectorId));
    if (!s) throw err(400, 'Settore non valido');
    const other = q.get('SELECT * FROM teams WHERE gameId = ? AND sectorId = ?', g.id, s.id);
    tx(() => {
      // Scambio di Settore se quello scelto è occupato.
      if (other) q.run('UPDATE teams SET sectorId = NULL WHERE id = ?', other.id);
      q.run('UPDATE teams SET sectorId = ? WHERE id = ?', s.id, t.id);
      if (other) q.run('UPDATE teams SET sectorId = ? WHERE id = ?', t.sectorId, other.id);
    });
    log(g.id, actor, 'team_sector_changed', { teamId: t.id, sector: s.name, swappedWith: other?.id });
    syncPoints(g);
  }
  if (Array.isArray(data.playerIds)) {
    if (!['draft', 'ready'].includes(g.status)) throw err(409, 'I membri si cambiano solo prima di aprire il cerchio');
    const ids = [...new Set(data.playerIds.map(Number))];
    if (ids.length !== 2) throw err(400, 'Una coppia ha due giocatori');
    tx(() => {
      for (const id of ids) {
        const p = q.get('SELECT * FROM players WHERE id = ? AND gameId = ?', id, g.id);
        if (!p || (p.teamId && p.teamId !== t.id)) throw err(409, 'Giocatore non disponibile');
      }
      q.run('UPDATE players SET teamId = NULL WHERE teamId = ?', t.id);
      for (const id of ids) q.run('UPDATE players SET teamId = ? WHERE id = ?', t.id, id);
    });
    log(g.id, actor, 'team_members_changed', { teamId: t.id });
  }
  notifyState(g.id);
}

function dissolveTeam(teamId, actor) {
  const t = q.get('SELECT * FROM teams WHERE id = ?', teamId);
  if (!t) throw err(404, 'Coppia non trovata');
  const g = getGame(t.gameId);
  if (t.kind === 'elect') throw err(409, 'Gli Eletti non si sciolgono: togli le persone una alla volta');
  if (!['draft', 'ready'].includes(g.status)) throw err(409, 'Una coppia si scioglie solo prima di aprire il cerchio; durante la partita usa "Ritira"');
  tx(() => {
    q.run('UPDATE players SET teamId = NULL WHERE teamId = ?', t.id);
    q.run('DELETE FROM teams WHERE id = ?', t.id);
  });
  log(g.id, actor, 'team_dissolved', { teamId: t.id });
  syncPoints(g);
  notifyState(g.id);
}

function withdrawTeam(teamId, actor, restore = false) {
  const t = q.get('SELECT * FROM teams WHERE id = ?', teamId);
  if (!t) throw err(404, 'Coppia non trovata');
  if (t.status === 'won') throw err(409, 'La coppia ha già vinto');
  q.run('UPDATE teams SET status = ? WHERE id = ?', restore ? 'active' : 'withdrawn', t.id);
  log(t.gameId, actor, restore ? 'team_restored' : 'team_withdrawn', { teamId: t.id });
  notifyState(t.gameId);
}

function regenTeamToken(teamId, actor) {
  const t = q.get('SELECT * FROM teams WHERE id = ?', teamId);
  if (!t) throw err(404, 'Coppia non trovata');
  tx(() => {
    q.run('UPDATE teams SET loginToken = ?, accessCode = ? WHERE id = ?', randomToken(24), uniqueAccessCode(), t.id);
    q.run("DELETE FROM sessions WHERE kind = 'team' AND refId = ?", t.id);
  });
  log(t.gameId, actor, 'team_token_regenerated', { teamId: t.id });
}

// ---------------------------------------------------------------- gestione Settori e Altari

const ROMAN = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
function toRoman(n) {
  let s = '';
  for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; }
  return s;
}

// Articolo per "Altare ___ Nome": dell' davanti a vocale, dello davanti a s impura/z/gn/ps, della per i femminili in -a.
function guessArticle(name) {
  const n = name.trim().toLowerCase();
  if (/^[aeiouàèéìòù]/.test(n)) return "dell'";
  if (/^(s[bcdfgklmnpqrtvz]|z|gn|ps|x|y)/.test(n)) return 'dello';
  if (n.endsWith('a')) return 'della';
  return 'del';
}

function sectorsAdmin() {
  const usage = Object.fromEntries(q.all(`SELECT s.id,
      (SELECT COUNT(*) FROM teams t WHERE t.sectorId = s.id) AS teams,
      (SELECT COUNT(*) FROM teams t JOIN games g ON g.id = t.gameId WHERE t.sectorId = s.id AND g.status NOT IN ('ended')) AS liveTeams,
      (SELECT COUNT(*) FROM players p WHERE p.requestedSectorId = s.id AND p.teamId IS NULL) AS requests
    FROM sectors s`).map((r) => [r.id, r]));
  return sectors().map((s) => ({ ...s, altar: altarLabel(s), defaultAltar: defaultAltarLabel(s), usage: usage[s.id] }));
}

const ARTICLES = ['del', 'dello', 'della', "dell'", 'dei', 'degli', 'delle'];

function saveSector(id, data, actor) {
  const name = String(data.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const old = id ? sectorById(Number(id)) : null;
  if (id && !old) throw err(404, 'Settore non trovato');
  if (!name) throw err(400, 'Il nome del Settore è obbligatorio');
  const clash = sectors().find((s) => s.name.toLowerCase() === name.toLowerCase() && s.id !== old?.id);
  if (clash) throw err(409, `Esiste già il Settore ${clash.name}${clash.archived ? ' (archiviato: ripristinalo)' : ''}`);
  let article = String(data.article ?? '').trim();
  if (!article || (old && name !== old.name && article === old.article && !data.articleTouched)) article = guessArticle(name);
  if (!ARTICLES.includes(article)) throw err(400, 'Articolo non valido');
  const element = String(data.element ?? old?.element ?? '').trim().slice(0, 60);
  const motto = String(data.motto ?? old?.motto ?? '').trim().slice(0, 80);
  const custom = data.altarLabel !== undefined ? String(data.altarLabel || '').trim().slice(0, 60) || null : old?.altarLabel ?? null;
  let ord = data.ord !== undefined && data.ord !== '' ? parseInt(data.ord, 10) : old?.ord;
  if (!old && !Number.isFinite(ord)) ord = (q.get('SELECT MAX(ord) AS m FROM sectors').m || 0) + 1;
  if (!Number.isFinite(ord) || ord < 1 || ord > 999) throw err(400, 'Ordine non valido');
  const roman = toRoman(ord);
  const color = /^#[0-9a-f]{6}$/i.test(data.color || '') ? data.color.toLowerCase() : old?.color || C.SECTOR_COLORS[(ord - 1) % C.SECTOR_COLORS.length];
  let sid = old?.id;
  tx(() => {
    if (old) {
      q.run('UPDATE sectors SET ord = ?, roman = ?, name = ?, article = ?, element = ?, motto = ?, altarLabel = ?, color = ? WHERE id = ?', ord, roman, name, article, element, motto, custom, color, old.id);
      // Gli Altari delle partite non ancora iniziate seguono il nuovo nome, se non erano stati rinominati a mano.
      const newLabel = altarLabel({ name, article, altarLabel: custom });
      q.run(`UPDATE points SET label = ? WHERE sectorId = ? AND label = ? AND gameId IN (SELECT id FROM games WHERE status IN ('draft','ready','circle'))`,
        newLabel, old.id, altarLabel(old));
    } else {
      sid = Number(q.run('INSERT INTO sectors (ord, roman, name, article, element, motto, altarLabel, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ord, roman, name, article, element, motto, custom, color).lastInsertRowid);
    }
  });
  sectorCache = null;
  log(null, actor, old ? 'sector_updated' : 'sector_created', { name });
  for (const g of q.all("SELECT id FROM games WHERE status != 'ended'")) notifyState(g.id);
  return sid;
}

function deleteSector(id, actor) {
  const s = sectorById(Number(id));
  if (!s) throw err(404, 'Settore non trovato');
  const used = q.get(`SELECT (SELECT COUNT(*) FROM teams WHERE sectorId = ?) + (SELECT COUNT(*) FROM sector_codes WHERE sectorId = ?)
                      + (SELECT COUNT(*) FROM points WHERE sectorId = ?) + (SELECT COUNT(*) FROM revelations WHERE sectorId = ?) AS n`, s.id, s.id, s.id, s.id).n;
  const live = q.get(`SELECT COUNT(*) AS n FROM teams t JOIN games g ON g.id = t.gameId WHERE t.sectorId = ? AND g.status != 'ended'`, s.id).n;
  if (live) throw err(409, `Il Settore ${s.name} è assegnato a una coppia in una partita non terminata: cambia prima il Settore della coppia`);
  q.run('UPDATE players SET requestedSectorId = NULL WHERE requestedSectorId = ?', s.id);
  // Se compare nello storico delle partite finite lo archiviamo, altrimenti lo eliminiamo.
  if (used) q.run('UPDATE sectors SET archived = 1 WHERE id = ?', s.id);
  else q.run('DELETE FROM sectors WHERE id = ?', s.id);
  sectorCache = null;
  log(null, actor, used ? 'sector_archived' : 'sector_deleted', { name: s.name });
  return { archived: !!used };
}

function restoreSector(id, actor) {
  const s = sectorById(Number(id));
  if (!s) throw err(404, 'Settore non trovato');
  q.run('UPDATE sectors SET archived = 0 WHERE id = ?', s.id);
  sectorCache = null;
  log(null, actor, 'sector_restored', { name: s.name });
}

// ---------------------------------------------------------------- Sigilli, Altari, Parola

function usedSectorIds(gameId) {
  return q.all('SELECT sectorId FROM teams WHERE gameId = ? AND sectorId IS NOT NULL', gameId).map((r) => r.sectorId);
}

// Settori in gioco: quelli delle coppie più quelli degli Altari senza coppia, in ordine di Settore.
function gameSectorIds(gameId) {
  const ids = new Set([...usedSectorIds(gameId), ...q.all('SELECT sectorId FROM points WHERE gameId = ?', gameId).map((r) => r.sectorId)]);
  return [...ids].sort((a, b) => (sectorById(a)?.ord ?? 0) - (sectorById(b)?.ord ?? 0));
}

// Altari: uno per ogni coppia con Settore, creato appena la coppia c'è. Gli Altari rimasti senza coppia
// restano se sono stati aggiunti dalla regia o già piazzati nel bosco; gli altri si tolgono.
function syncPoints(g) {
  if (!C.PRE_START.includes(g.status)) return 0;
  const used = usedSectorIds(g.id);
  let added = 0;
  tx(() => {
    for (const sid of used) {
      if (!q.get('SELECT 1 FROM points WHERE gameId = ? AND sectorId = ?', g.id, sid)) {
        q.run('INSERT INTO points (gameId, sectorId, qrToken, label) VALUES (?, ?, ?, ?)', g.id, sid, randomToken(18), altarLabel(sectorById(sid)));
        added++;
      }
    }
    q.run(`DELETE FROM points WHERE gameId = ? AND manual = 0 AND lat IS NULL${used.length ? ` AND sectorId NOT IN (${used.map(() => '?').join(',')})` : ''}`, g.id, ...used);
  });
  return added;
}

function ensurePoints(g, actor) {
  requirePreStart(g, 'La modifica degli Altari');
  syncPoints(g);
  log(g.id, actor, 'points_synced', { count: q.get('SELECT COUNT(*) AS n FROM points WHERE gameId = ?', g.id).n });
}

// Altare senza coppia: il suo Sigillo non lo custodisce nessuno, arriva solo dal Tradimento del Consiglio.
// Si può creare subito (anche prima delle iscrizioni) per piazzarlo nel bosco; se poi una coppia prende
// quel Settore, diventa il suo Altare.
function addFreePoints(gameId, { sectorId, all } = {}, actor) {
  const g = getGame(gameId);
  requirePreStart(g, 'L\'aggiunta degli Altari');
  const have = new Set(q.all('SELECT sectorId FROM points WHERE gameId = ?', g.id).map((r) => r.sectorId));
  const list = all ? activeSectors().filter((x) => !have.has(x.id)) : [sectorById(Number(sectorId))];
  if (!list[0]) throw err(all ? 409 : 400, all ? 'Tutti i Settori hanno già un Altare' : 'Settore non valido');
  if (!all && have.has(list[0].id)) throw err(409, `Il Settore ${list[0].name} ha già un Altare`);
  tx(() => list.forEach((x) => q.run('INSERT INTO points (gameId, sectorId, qrToken, label, manual) VALUES (?, ?, ?, ?, 1)', g.id, x.id, randomToken(18), altarLabel(x))));
  log(g.id, actor, 'points_added', { count: list.length, sectors: list.map((x) => x.name) });
  notifyState(g.id);
  return { added: list.length };
}

function deletePoint(pointId, actor) {
  const p = q.get('SELECT * FROM points WHERE id = ?', Number(pointId));
  if (!p) throw err(404, 'Altare non trovato');
  const g = getGame(p.gameId);
  requirePreStart(g, 'L\'eliminazione di un Altare');
  if (q.get('SELECT 1 FROM teams WHERE gameId = ? AND sectorId = ?', g.id, p.sectorId)) throw err(409, 'L\'Altare è di una coppia: si toglie solo cambiando o sciogliendo la coppia');
  q.run('DELETE FROM points WHERE id = ?', p.id);
  log(g.id, actor, 'point_deleted', { label: p.label });
  notifyState(g.id);
}

function generateCodes(gameId, actor) {
  const g = getGame(gameId);
  requirePreStart(g, 'La generazione dei Sigilli');
  if (usedSectorIds(g.id).length < 2) throw err(409, 'Servono almeno due coppie con Settore');
  syncPoints(g);
  const used = gameSectorIds(g.id);
  tx(() => {
    const prevFlags = Object.fromEntries(q.all('SELECT sectorId, neverRevealed FROM sector_codes WHERE gameId = ?', g.id).map((r) => [r.sectorId, r.neverRevealed]));
    q.run('DELETE FROM sector_codes WHERE gameId = ?', g.id);
    const seen = new Set();
    for (const sid of used) {
      let c;
      do c = randomCode(g.codeLength); while (seen.has(c));
      seen.add(c);
      q.run('INSERT INTO sector_codes (gameId, sectorId, code, neverRevealed) VALUES (?, ?, ?, ?)', g.id, sid, c, prevFlags[sid] || 0);
    }
  });
  log(g.id, actor, 'codes_generated', { count: used.length });
  const couples = new Set(usedSectorIds(g.id));
  const flags = q.all('SELECT sectorId FROM sector_codes WHERE gameId = ? AND neverRevealed = 1', g.id);
  if (flags.length !== Math.min(g.neverRevealedCount, couples.size) || flags.some((f) => !couples.has(f.sectorId))) extractNeverRevealed(g, actor);
  else buildCalendar(g, actor);
  notifyState(g.id);
}

function extractNeverRevealed(g, actor) {
  requirePreStart(g, 'L\'estrazione dei Sigilli mai rivelati');
  const all = q.all('SELECT * FROM sector_codes WHERE gameId = ?', g.id);
  if (!all.length) throw err(409, 'Genera prima i Sigilli');
  // I mai rivelati sono sempre Sigilli di coppie: quelli degli Altari senza coppia arrivano solo dal Tradimento.
  const couples = new Set(usedSectorIds(g.id));
  const codes = all.filter((c) => couples.has(c.sectorId));
  const k = Math.min(g.neverRevealedCount, codes.length);
  const chosen = new Set(shuffle(codes).slice(0, k).map((c) => c.id));
  tx(() => all.forEach((c) => q.run('UPDATE sector_codes SET neverRevealed = ? WHERE id = ?', chosen.has(c.id) ? 1 : 0, c.id)));
  log(g.id, actor, 'never_revealed_extracted', { count: k });
  buildCalendar(g, actor);
}

// Sezione 7.1: orari delle rivelazioni in minuti dal via. n = Sigilli in gioco, never = quanti mai rivelati.
function revelationOffsets(g, n, never = g.neverRevealedCount) {
  const H = g.truceMin;
  const F = H + g.firstRevelationDelayMin;
  const L = g.durationMin - g.lastRevelationBeforeEndMin;
  const R = n - never;
  if (R <= 0) return [];
  if (R === 1) return [F];
  const step = (L - F) / (R - 1);
  return Array.from({ length: R }, (_, i) => Math.round((F + i * step) * 100) / 100);
}

function buildCalendar(g, actor) {
  requirePreStart(g, 'Il calendario delle rivelazioni');
  const codes = q.all('SELECT * FROM sector_codes WHERE gameId = ? AND neverRevealed = 0', g.id);
  // Ultimo Tradimento («lucchetto»): il Sigillo di un Altare senza coppia, che nessuno può vincere o rubare.
  // Così nessuno può finire prima di quell'orario.
  const couples = new Set(usedSectorIds(g.id));
  const order = shuffle(codes);
  const lock = order.findIndex((c) => !couples.has(c.sectorId));
  if (lock >= 0) order.push(...order.splice(lock, 1));
  const offsets = revelationOffsets(g, order.length, 0);
  tx(() => {
    q.run('DELETE FROM revelations WHERE gameId = ?', g.id);
    offsets.forEach((m, i) => {
      if (order[i]) q.run('INSERT INTO revelations (gameId, sectorId, ord, scheduledMin) VALUES (?, ?, ?, ?)', g.id, order[i].sectorId, i + 1, m);
    });
  });
  log(g.id, actor, 'calendar_built', { offsets });
}

// Ricalcola solo gli orari, mantenendo l'ordine dei Settori.
function retimeCalendar(g) {
  const revs = q.all("SELECT * FROM revelations WHERE gameId = ? AND status = 'scheduled' ORDER BY ord", g.id);
  if (!revs.length) return;
  const n = q.get('SELECT COUNT(*) AS n FROM sector_codes WHERE gameId = ? AND neverRevealed = 0', g.id).n;
  const offsets = revelationOffsets(g, n, 0);
  revs.forEach((r, i) => q.run('UPDATE revelations SET scheduledMin = ? WHERE id = ?', offsets[i] ?? r.scheduledMin, r.id));
}

function editRevelation(revId, data, actor) {
  const r = q.get('SELECT * FROM revelations WHERE id = ?', revId);
  if (!r) throw err(404, 'Rivelazione non trovata');
  const g = getGame(r.gameId);
  if (r.status !== 'scheduled') throw err(409, 'Rivelazione già eseguita o saltata');
  if (data.scheduledMin !== undefined) {
    const m = parseFloat(data.scheduledMin);
    if (!Number.isFinite(m) || m < 0 || m > g.durationMin) throw err(400, 'Orario non valido');
    q.run('UPDATE revelations SET scheduledMin = ? WHERE id = ?', m, r.id);
  }
  if (data.sectorId !== undefined && Number(data.sectorId) !== r.sectorId) {
    requirePreStart(g, 'Il cambio di Settore in calendario');
    const sid = Number(data.sectorId);
    const code = q.get('SELECT * FROM sector_codes WHERE gameId = ? AND sectorId = ?', g.id, sid);
    if (!code) throw err(400, 'Settore senza Sigillo');
    if (code.neverRevealed) throw err(409, 'Quel Sigillo è tra i mai rivelati');
    const other = q.get('SELECT * FROM revelations WHERE gameId = ? AND sectorId = ?', g.id, sid);
    tx(() => {
      if (other) q.run('UPDATE revelations SET sectorId = ? WHERE id = ?', r.sectorId, other.id);
      q.run('UPDATE revelations SET sectorId = ? WHERE id = ?', sid, r.id);
    });
  }
  log(g.id, actor, 'revelation_edited', { revId, ...data });
  notifyState(g.id);
}

function editPoint(pointId, data, actor) {
  const p = q.get('SELECT * FROM points WHERE id = ?', pointId);
  if (!p) throw err(404, 'Altare non trovato');
  q.run('UPDATE points SET label = COALESCE(?, label), locationNote = ? WHERE id = ?',
    data.label?.trim() || null, data.locationNote !== undefined ? data.locationNote?.trim() || null : p.locationNote, p.id);
  log(p.gameId, actor, 'point_edited', { pointId });
  notifyState(p.gameId);
}

function regenPointToken(pointId, actor) {
  const p = q.get('SELECT * FROM points WHERE id = ?', pointId);
  if (!p) throw err(404, 'Altare non trovato');
  requirePreStart(getGame(p.gameId), 'La rigenerazione dei QR');
  tx(() => {
    q.run('UPDATE points SET qrToken = ? WHERE id = ?', randomToken(18), p.id);
    q.run('DELETE FROM team_visits WHERE pointId = ?', p.id);
  });
  log(p.gameId, actor, 'point_token_regenerated', { pointId });
}

function setPhrase(gameId, phrase, actor) {
  const g = getGame(gameId);
  requirePreStart(g, 'La modifica della Parola');
  ensurePoints(g, actor);
  const points = q.all('SELECT * FROM points WHERE gameId = ?', g.id);
  if (!points.length) throw err(409, 'Non ci sono Altari: forma le coppie o aggiungi gli Altari');
  const words = String(phrase || '').trim().split(/\s+/).filter(Boolean);
  if (words.length < points.length) throw err(400, `La Parola deve avere almeno ${points.length} parole (una per Altare): ne ha ${words.length}`);
  const n = points.length;
  const base = Math.floor(words.length / n);
  let extra = words.length % n;
  const chunks = [];
  let i = 0;
  for (let k = 0; k < n; k++) {
    const len = base + (extra-- > 0 ? 1 : 0);
    chunks.push(words.slice(i, i + len).join(' '));
    i += len;
  }
  const norm = chunks.map(normText);
  if (new Set(norm).size !== norm.length) throw err(400, 'Due frammenti risultano uguali: cambia la Parola in modo che ogni pezzo sia diverso');
  const order = shuffle(points);
  tx(() => {
    q.run('DELETE FROM fragments WHERE gameId = ?', g.id);
    order.forEach((p, k) => q.run('INSERT INTO fragments (gameId, pointId, text, position) VALUES (?, ?, ?, ?)', g.id, p.id, chunks[k], k + 1));
    q.run('UPDATE games SET phrase = ? WHERE id = ?', words.join(' '), g.id);
  });
  log(g.id, actor, 'phrase_set', { fragments: n });
  notifyState(g.id);
}

function editFragment(fragmentId, data, actor) {
  const f = q.get('SELECT * FROM fragments WHERE id = ?', fragmentId);
  if (!f) throw err(404, 'Frammento non trovato');
  const g = getGame(f.gameId);
  requirePreStart(g, 'La modifica dei frammenti');
  const text = String(data.text || '').trim();
  if (!text) throw err(400, 'Il frammento non può essere vuoto');
  const clash = q.all('SELECT * FROM fragments WHERE gameId = ? AND id != ?', g.id, f.id).find((o) => normText(o.text) === normText(text));
  if (clash) throw err(400, 'Esiste già un frammento con lo stesso testo');
  let position = f.position;
  if (data.position !== undefined) {
    position = parseInt(data.position, 10);
    const other = q.get('SELECT * FROM fragments WHERE gameId = ? AND position = ? AND id != ?', g.id, position, f.id);
    if (other) q.run('UPDATE fragments SET position = ? WHERE id = ?', f.position, other.id);
  }
  q.run('UPDATE fragments SET text = ?, position = ? WHERE id = ?', text, position, f.id);
  const all = q.all('SELECT text FROM fragments WHERE gameId = ? ORDER BY position', g.id);
  q.run('UPDATE games SET phrase = ? WHERE id = ?', all.map((x) => x.text).join(' '), g.id);
  log(g.id, actor, 'fragment_edited', { fragmentId });
}

// ---------------------------------------------------------------- controllo di preparazione

// Controllo di preparazione, diviso nelle 4 parti del setup (il "sigillo" della regia):
// I Coppie · II Sigilli · III Altari e Parola · IV Doni (facoltativi).
function readiness(g) {
  const issues = [];
  const teams = teamsOf(g.id);
  const withSector = teams.filter((t) => t.sectorId);
  const codes = q.all('SELECT * FROM sector_codes WHERE gameId = ?', g.id);
  const points = q.all('SELECT * FROM points WHERE gameId = ?', g.id);
  const frags = q.all('SELECT * FROM fragments WHERE gameId = ?', g.id);
  const revs = q.all("SELECT * FROM revelations WHERE gameId = ? AND status = 'scheduled'", g.id);
  const placedAltars = points.filter((p) => p.lat != null).length;
  const gifts = q.get("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status != 'draft' THEN 1 ELSE 0 END), 0) AS placed FROM gifts WHERE gameId = ? AND parentGiftId IS NULL", g.id);
  const freePlayers = q.get("SELECT COUNT(*) AS n FROM players WHERE gameId = ? AND teamId IS NULL AND status = 'accepted'", g.id).n;
  const pending = q.get("SELECT COUNT(*) AS n FROM players WHERE gameId = ? AND status = 'pending'", g.id).n;
  const E = (part, text) => issues.push({ level: 'error', part, text });
  const W = (part, text) => issues.push({ level: 'warn', part, text });

  if (withSector.length < 2) E('coppie', 'Servono almeno due coppie con Settore');
  if (teams.length !== withSector.length) E('coppie', 'Ci sono coppie senza Settore');
  const codeSectors = new Set(codes.map((c) => c.sectorId));
  const inPlay = new Set([...withSector.map((t) => t.sectorId), ...points.map((p) => p.sectorId)]);
  if ([...inPlay].some((sid) => !codeSectors.has(sid)) || codes.length !== inPlay.size) E('sigilli', 'Sigilli da generare o rigenerare (coppie o Altari sono cambiati)');
  const coupleSectors = new Set(withSector.map((t) => t.sectorId));
  const k = Math.min(g.neverRevealedCount, codes.filter((c) => coupleSectors.has(c.sectorId)).length);
  const never = codes.filter((c) => c.neverRevealed);
  if (codes.length && (never.length !== k || never.some((c) => !coupleSectors.has(c.sectorId)))) E('sigilli', 'Estrazione dei Sigilli mai rivelati da rifare');
  const expected = codes.filter((c) => !c.neverRevealed).map((c) => c.sectorId).sort().join(',');
  const inCal = revs.map((r) => r.sectorId).sort().join(',');
  if (codes.length && expected !== inCal) E('sigilli', 'Calendario delle rivelazioni da ricalcolare');
  const pointSectors = new Set(points.map((p) => p.sectorId));
  if (withSector.some((t) => !pointSectors.has(t.sectorId))) E('altari', 'Altari da sincronizzare con le coppie');
  if (!points.length || frags.length !== points.length) E('altari', 'La Parola non è divisa tra tutti gli Altari');
  if (!g.emergencyRadioChannel) W('generale', 'Canale radio d\'emergenza non impostato');
  if (freePlayers) W('coppie', `${freePlayers} giocatori accettati senza coppia`);
  if (pending) W('coppie', `${pending} iscrizioni da approvare`);

  const firstError = (part) => issues.find((i) => i.part === part && i.level === 'error')?.text;
  const part = (key, roman, label, href, okDetail, optional = false, done = null) => {
    const err = firstError(key);
    const isDone = done ?? !err;
    return { key, roman, label, href, optional, done: isDone, detail: err || (isDone ? okDetail : '') };
  };
  const parts = [
    part('coppie', 'I', 'Coppie', '#coppie', `${withSector.length} coppie con Settore`),
    part('sigilli', 'II', 'Sigilli', '#sigilli', `${codes.length} Sigilli · ${revs.length} ${revs.length === 1 ? "tradimento" : "tradimenti"} in calendario`),
    part('altari', 'III', 'Altari e Parola', '#altari', `${points.length} Altari${points.length > withSector.length ? ` (${points.length - withSector.length} senza coppia)` : ''} · Parola divisa in ${frags.length} frammenti`),
    // IV · Campo: Altari piazzati nel bosco (foto + posizione) dallo strumento di campo.
    { key: 'campo', roman: 'IV', label: 'Campo', href: '#mappa', optional: true, done: points.length > 0 && placedAltars === points.length,
      detail: points.length ? `Altari piazzati ${placedAltars}/${points.length}${gifts.n ? ` · doni piazzati ${gifts.placed}/${gifts.n}` : ''}` : 'Gli Altari si piazzano dopo averli creati' },
  ];
  return { ok: !issues.some((i) => i.level === 'error'), issues, parts };
}

// ---------------------------------------------------------------- macchina a stati

function setStatus(g, status, extra = {}) {
  const cols = { status, ...extra };
  const keys = Object.keys(cols);
  q.run(`UPDATE games SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => cols[k]), g.id);
  Object.assign(g, cols);
}

// Solo nell'ambiente di test: una partita finita torna «pronta» con tutto il gioco azzerato (Sigilli, Altari,
// Parola, coppie e piazzamenti restano), per rigiocarla senza rifare il setup.
const isTestEnv = () => process.env.ZDG_ENV === 'test';
function restartGame(g, actor) {
  if (!isTestEnv()) throw err(403, 'Far ripartire una partita finita è possibile solo nell\'ambiente di test');
  const teamIds = teamsOf(g.id).map((t) => t.id);
  const inTeams = teamIds.length ? `(${teamIds.map(() => '?').join(',')})` : '(NULL)';
  tx(() => {
    for (const t of ['team_fragments', 'team_code_notes', 'team_visits', 'team_timers']) q.run(`DELETE FROM ${t} WHERE teamId IN ${inTeams}`, ...teamIds);
    q.run("UPDATE teams SET status = 'active', finishPosition = NULL, wonAt = NULL WHERE gameId = ?", g.id);
    q.run('DELETE FROM engagement_steals WHERE engagementId IN (SELECT id FROM engagements WHERE gameId = ?)', g.id);
    for (const t of ['engagements', 'alliances', 'alliance_requests', 'announcements', 'messages', 'validations', 'positions']) q.run(`DELETE FROM ${t} WHERE gameId = ?`, g.id);
    // Tradimenti: quelli aggiunti a mano spariscono, gli altri tornano in calendario.
    q.run('DELETE FROM revelations WHERE gameId = ? AND scheduledMin IS NULL', g.id);
    q.run("UPDATE revelations SET status = 'scheduled', firedAt = NULL WHERE gameId = ?", g.id);
    q.run("UPDATE supply_drops SET status = 'scheduled', firedAt = NULL, closesAt = NULL, closedAt = NULL WHERE gameId = ?", g.id);
    // Doni: tornano piazzati (non ancora comparsi) o da piazzare.
    q.run(`UPDATE gifts SET status = CASE WHEN lat IS NULL THEN 'draft' ELSE 'placed' END, revealedAt = NULL, revealElapsedMs = NULL,
           claimedByTeamId = NULL, claimedAt = NULL, usedAt = NULL, expiredAt = NULL WHERE gameId = ?`, g.id);
    require('./skills').resetGame(g.id);
    setStatus(g, 'ready', { startedAt: null, totalPausedMs: 0, pausedAt: null, pausedFrom: null, endedAt: null });
  });
  log(g.id, actor, 'game_restarted');
  pushTraccarOn(g);
}

// Si parte a breve: a tutti i telefoni della partita, «accendi Traccar» (l'avviso nell'app sparisce dopo due segnali).
function pushTraccarOn(g) {
  rt.pushTeams(g.id, { title: 'Accendi Traccar Client', body: 'I Giochi stanno per iniziare: apri Traccar Client e accendi il tracciamento. L\'avviso sparisce appena arrivano due segnali.', tag: 'traccar-on', url: '/#/home' });
}

function control(gameId, action, actor) {
  const g = getGame(gameId);
  const now = Date.now();
  const need = (...st) => { if (!st.includes(g.status)) throw err(409, `Azione "${action}" non possibile nello stato "${C.STATUS_LABELS[g.status]}"`); };
  switch (action) {
    case 'ready': {
      need('draft');
      const r = readiness(g);
      if (!r.ok) throw err(409, 'Setup incompleto: ' + r.issues.filter((i) => i.level === 'error').map((i) => i.text).join('; '));
      setStatus(g, 'ready', { registrationOpen: 0 });
      pushTraccarOn(g);
      break;
    }
    case 'draft':
      need('ready', 'circle');
      // Di nuovo in preparazione: gli Altari visitati (anche le prove) si azzerano.
      q.run('DELETE FROM team_visits WHERE teamId IN (SELECT id FROM teams WHERE gameId = ?)', g.id);
      setStatus(g, 'draft');
      break;
    case 'circle':
      need('ready');
      setStatus(g, 'circle');
      pushTraccarOn(g);
      break;
    case 'start': {
      need('circle');
      const r = readiness(g);
      if (!r.ok) throw err(409, 'Setup incompleto: ' + r.issues.filter((i) => i.level === 'error').map((i) => i.text).join('; '));
      setStatus(g, 'truce', { startedAt: now, totalPausedMs: 0, pausedAt: null, pausedFrom: null, endedAt: null });
      log(g.id, actor, 'game_started');
      announce(g.id, 'start');
      break;
    }
    case 'pause':
      need(...C.ACTIVE);
      setStatus(g, 'paused', { pausedAt: now, pausedFrom: g.status });
      log(g.id, actor, 'game_paused');
      announce(g.id, 'pause');
      break;
    case 'resume':
      need('paused');
      setStatus(g, g.pausedFrom || 'hunt', { totalPausedMs: (g.totalPausedMs || 0) + (now - g.pausedAt), pausedAt: null, pausedFrom: null });
      log(g.id, actor, 'game_resumed');
      announce(g.id, 'resume');
      break;
    case 'end':
      need(...C.ACTIVE, 'paused');
      endGame(g, actor, now);
      break;
    case 'restart':
      need('ended');
      restartGame(g, actor);
      break;
    default:
      throw err(400, 'Azione sconosciuta');
  }
  if (!['start', 'pause', 'resume', 'end'].includes(action)) log(g.id, actor, 'status_' + action);
  notifyState(g.id);
  if (action === 'resume') tickGame(getGame(g.id));
  return getGame(g.id);
}

function endGame(g, actor, now = Date.now()) {
  const extra = { endedAt: now, pausedAt: null, pausedFrom: null };
  if (g.status === 'paused' && g.pausedAt) extra.totalPausedMs = (g.totalPausedMs || 0) + (now - g.pausedAt);
  setStatus(g, 'ended', extra);
  q.run("UPDATE revelations SET status = 'skipped' WHERE gameId = ? AND status = 'scheduled'", g.id);
  log(g.id, actor, 'game_ended');
  announce(g.id, 'end');
}

// ---------------------------------------------------------------- rivelazioni e doni

function fireRevelation(g, rev, actor, manual = false) {
  const code = q.get('SELECT * FROM sector_codes WHERE gameId = ? AND sectorId = ?', g.id, rev.sectorId);
  const s = sectorById(rev.sectorId);
  q.run('UPDATE revelations SET status = ?, firedAt = ? WHERE id = ?', manual ? 'manual' : 'fired', Date.now(), rev.id);
  log(g.id, actor, 'revelation', { sector: s.name, manual });
  announce(g.id, 'revelation', { settore: s.name, codice: code.code }, { sectorId: s.id, sectorName: s.name, code: code.code });
}

function revealNow(revId, actor) {
  const r = q.get('SELECT * FROM revelations WHERE id = ?', revId);
  if (!r) throw err(404, 'Rivelazione non trovata');
  const g = getGame(r.gameId);
  if (!C.ACTIVE.includes(g.status)) throw err(409, 'Si rivela solo a partita in corso');
  if (r.status !== 'scheduled') throw err(409, 'Già rivelato o saltato');
  fireRevelation(g, r, actor, true);
  notifyState(g.id);
}

function revealNext(gameId, actor) {
  const r = q.get("SELECT * FROM revelations WHERE gameId = ? AND status = 'scheduled' ORDER BY scheduledMin, ord LIMIT 1", gameId);
  if (!r) throw err(409, 'Nessuna rivelazione in calendario');
  revealNow(r.id, actor);
}

function revealSector(gameId, sectorId, actor) {
  const g = getGame(gameId);
  if (!C.ACTIVE.includes(g.status)) throw err(409, 'Si rivela solo a partita in corso');
  const existing = q.get('SELECT * FROM revelations WHERE gameId = ? AND sectorId = ?', g.id, sectorId);
  if (existing && ['fired', 'manual'].includes(existing.status)) throw err(409, 'Sigillo già rivelato');
  if (existing && existing.status === 'scheduled') return revealNow(existing.id, actor);
  if (!q.get('SELECT 1 FROM sector_codes WHERE gameId = ? AND sectorId = ?', g.id, sectorId)) throw err(400, 'Settore non in gioco');
  let rev = existing;
  if (!rev) {
    const r = q.run("INSERT INTO revelations (gameId, sectorId, ord, scheduledMin, status) VALUES (?, ?, 999, NULL, 'scheduled')", g.id, sectorId);
    rev = q.get('SELECT * FROM revelations WHERE id = ?', r.lastInsertRowid);
  }
  fireRevelation(g, rev, actor, true);
  notifyState(g.id);
}

function postponeRevelation(revId, minutes, actor) {
  const r = q.get('SELECT * FROM revelations WHERE id = ?', revId);
  if (!r) throw err(404, 'Rivelazione non trovata');
  if (r.status !== 'scheduled') throw err(409, 'Già rivelato o saltato');
  const m = parseFloat(minutes);
  if (!Number.isFinite(m) || m === 0) throw err(400, 'Minuti non validi');
  q.run('UPDATE revelations SET scheduledMin = MAX(0, scheduledMin + ?) WHERE id = ?', m, r.id);
  log(r.gameId, actor, 'revelation_postponed', { revId, minutes: m });
  notifyState(r.gameId);
}

function skipRevelation(revId, actor, restore = false) {
  const r = q.get('SELECT * FROM revelations WHERE id = ?', revId);
  if (!r) throw err(404, 'Rivelazione non trovata');
  if (!restore && r.status !== 'scheduled') throw err(409, 'Già rivelato o saltato');
  if (restore && r.status !== 'skipped') throw err(409, 'Non è stata saltata');
  q.run('UPDATE revelations SET status = ? WHERE id = ?', restore ? 'scheduled' : 'skipped', r.id);
  log(r.gameId, actor, restore ? 'revelation_restored' : 'revelation_skipped', { revId });
  notifyState(r.gameId);
}

// Finestra armamenti: si apre a un minuto dal via (scheduledMin), a un orario (scheduledAt, ms) o a mano;
// resta aperta durationMin minuti (vuoto = solo l'annuncio, senza chiusura).
// Stati: scheduled → fired (aperta) → closed.
function saveSupply(gameId, data, actor, id = null) {
  const g = getGame(gameId);
  const old = id ? q.get('SELECT * FROM supply_drops WHERE id = ? AND gameId = ?', id, g.id) : null;
  if (id && !old) throw err(404, 'Finestra non trovata');
  const num = (v) => (v === '' || v == null ? null : parseFloat(v));
  // Già aperta o chiusa: si correggono contenuto e messaggio; da aperta anche la durata (vuota = fino a chiusura).
  if (old && old.status !== 'scheduled') {
    const description = data.description !== undefined ? String(data.description || '').trim() || null : old.description;
    const message = data.message !== undefined ? String(data.message || '').trim() || null : old.message;
    let { closesAt, durationMin } = old;
    if (old.status === 'fired' && data.durationMin !== undefined) {
      durationMin = num(data.durationMin);
      if (durationMin != null && (!Number.isFinite(durationMin) || durationMin <= 0 || durationMin > 600)) throw err(400, 'Durata non valida (minuti)');
      closesAt = durationMin != null ? old.firedAt + Math.round(durationMin * 60000) : null;
      if (closesAt != null && closesAt < Date.now() + 30000) throw err(409, 'Con questa durata la finestra sarebbe già finita: usa «Chiudi ora»');
    }
    q.run('UPDATE supply_drops SET description = ?, message = ?, durationMin = ?, closesAt = ? WHERE id = ?', description, message, durationMin, closesAt, old.id);
    log(g.id, actor, 'supply_edited', { id: old.id, durationMin });
    notifyState(g.id);
    return old.id;
  }
  const m = num(data.scheduledMin);
  if (m != null && (!Number.isFinite(m) || m < 0 || m > g.durationMin)) throw err(400, 'Minuto dal via non valido');
  const at = num(data.scheduledAt);
  if (at != null && (!Number.isFinite(at) || at < Date.now() - 60000)) throw err(400, 'Orario di apertura non valido (già passato?)');
  const dur = num(data.durationMin);
  if (dur != null && (!Number.isFinite(dur) || dur <= 0 || dur > 600)) throw err(400, 'Durata non valida (minuti)');
  const vals = [m, at == null ? null : Math.round(at), dur, data.description || null, data.message || null];
  if (id) q.run('UPDATE supply_drops SET scheduledMin = ?, scheduledAt = ?, durationMin = ?, description = ?, message = ? WHERE id = ?', ...vals, id);
  else id = Number(q.run('INSERT INTO supply_drops (gameId, scheduledMin, scheduledAt, durationMin, description, message) VALUES (?, ?, ?, ?, ?, ?)', g.id, ...vals).lastInsertRowid);
  log(g.id, actor, 'supply_saved', { scheduledMin: m, scheduledAt: at, durationMin: dur });
  notifyState(g.id);  return id;
}

function getSupply(id) {
  const s = q.get('SELECT * FROM supply_drops WHERE id = ?', Number(id));
  if (!s) throw err(404, 'Finestra non trovata');
  return s;
}

function deleteSupply(id, actor) {
  const s = getSupply(id);
  q.run('DELETE FROM supply_drops WHERE id = ?', s.id);
  log(s.gameId, actor, 'supply_deleted', { id });
  notifyState(s.gameId);
}

function fireSupply(id, actor) {
  const s = getSupply(id);
  const g = getGame(s.gameId);
  if (!C.ACTIVE.includes(g.status)) throw err(409, 'Gli armamenti si aprono solo a partita in corso');
  if (s.status !== 'scheduled') throw err(409, 'Finestra già aperta');
  const now = Date.now();
  const closesAt = s.durationMin ? now + s.durationMin * 60000 : null;
  q.run("UPDATE supply_drops SET status = 'fired', firedAt = ?, closesAt = ? WHERE id = ?", now, closesAt, s.id);
  log(g.id, actor, 'supply_fired', { id: s.id, durationMin: s.durationMin });
  const base = s.message || templatesOf(g).supply;
  const text = s.durationMin ? `${base} La finestra resta aperta ${s.durationMin} minuti.` : base;
  announce(g.id, 'supply', {}, { supplyId: s.id, closesAt }, text);
  notifyState(g.id);
}

function closeSupply(id, actor) {
  const s = getSupply(id);
  if (s.status !== 'fired' || s.closedAt) throw err(409, 'La finestra non è aperta');
  q.run("UPDATE supply_drops SET status = 'closed', closedAt = ?, closesAt = MIN(COALESCE(closesAt, ?), ?) WHERE id = ?", Date.now(), Date.now(), Date.now(), s.id);
  log(s.gameId, actor, 'supply_closed', { id: s.id });
  announce(s.gameId, 'supply_end', {}, { supplyId: s.id });
  notifyState(s.gameId);
}

// Sposta l'apertura (finestra in attesa: minuti negativi = anticipa) o prolunga/accorcia la finestra aperta.
function shiftSupply(id, minutes, actor) {
  const s = getSupply(id);
  const m = parseFloat(minutes);
  if (!Number.isFinite(m) || !m) throw err(400, 'Minuti non validi');
  if (s.status === 'scheduled') {
    if (s.scheduledMin != null) q.run('UPDATE supply_drops SET scheduledMin = MAX(0, scheduledMin + ?) WHERE id = ?', m, s.id);
    else if (s.scheduledAt != null) q.run('UPDATE supply_drops SET scheduledAt = MAX(?, scheduledAt + ?) WHERE id = ?', Date.now(), m * 60000, s.id);
    else throw err(409, 'Finestra a mano: aprila con "Apri ora"');
  } else if (s.status === 'fired' && s.closesAt) {
    q.run('UPDATE supply_drops SET closesAt = MAX(?, closesAt + ?), durationMin = MAX(1, durationMin + ?) WHERE id = ?', Date.now() + 30000, m * 60000, m, s.id);
  } else if (s.status === 'fired') {
    // Aperta fino a chiusura: «chiudi tra m minuti» le dà una fine.
    if (m <= 0) throw err(409, 'La finestra non ha una durata: usa «Chiudi ora»');
    const closesAt = Date.now() + Math.round(m * 60000);
    q.run('UPDATE supply_drops SET closesAt = ?, durationMin = ? WHERE id = ?', closesAt, Math.max(1, Math.round((closesAt - s.firedAt) / 60000)), s.id);
  } else throw err(409, 'Finestra già chiusa');
  log(s.gameId, actor, 'supply_shifted', { id: s.id, minutes: m, open: s.status === 'fired' });
  notifyState(s.gameId);
}

// Finestre aperte, per le app (le coppie vedono il conto alla rovescia della chiusura).
function openSupply(gameId) {
  return q.all("SELECT s.id, s.firedAt, s.closesAt, a.text FROM supply_drops s LEFT JOIN announcements a ON a.gameId = s.gameId AND a.type = 'supply' AND json_extract(a.payload, '$.supplyId') = s.id WHERE s.gameId = ? AND s.status = 'fired' AND s.closesAt IS NOT NULL ORDER BY s.closesAt", gameId);
}

function freeAnnouncement(gameId, text, actor) {
  const g = getGame(gameId);
  const t = String(text || '').trim();
  if (!t) throw err(400, 'Testo vuoto');
  log(g.id, actor, 'free_announcement');
  return announce(g.id, 'free', {}, null, t.slice(0, 500));
}

// ---------------------------------------------------------------- motore a tempo

function tickGame(g) {
  if (!C.ACTIVE.includes(g.status)) return;
  const e = elapsedMs(g) / 60000;
  const lastStart = g.durationMin - C.LAST_PHASE_MIN;
  if (g.status === 'truce' && e >= g.truceMin) {
    setStatus(g, 'hunt');
    log(g.id, 'sistema', 'phase_hunt');
    announce(g.id, 'hunt_open');
    notifyState(g.id);
  }
  if (g.status === 'hunt') {
    const due = q.all("SELECT * FROM revelations WHERE gameId = ? AND status = 'scheduled' AND scheduledMin IS NOT NULL AND scheduledMin <= ? AND scheduledMin <= ? ORDER BY scheduledMin, ord",
      g.id, e, lastStart + 1e-6);
    for (const r of due) fireRevelation(g, r, 'sistema');
    if (due.length) notifyState(g.id);
  }
  const now = Date.now();
  const drops = q.all("SELECT * FROM supply_drops WHERE gameId = ? AND status = 'scheduled' AND ((scheduledMin IS NOT NULL AND scheduledMin <= ?) OR (scheduledAt IS NOT NULL AND scheduledAt <= ?))", g.id, e, now);
  for (const s of drops) fireSupply(s.id, 'sistema');
  const closing = q.all("SELECT id FROM supply_drops WHERE gameId = ? AND status = 'fired' AND closesAt IS NOT NULL AND closesAt <= ?", g.id, now);
  for (const s of closing) closeSupply(s.id, 'sistema');
  if (g.status === 'hunt' && e >= lastStart) {
    setStatus(g, 'last_half_hour');
    log(g.id, 'sistema', 'phase_last_half_hour');
    const skipped = q.run("UPDATE revelations SET status = 'skipped' WHERE gameId = ? AND status = 'scheduled'", g.id).changes;
    if (skipped) log(g.id, 'sistema', 'revelations_skipped_last_phase', { count: skipped });
    announce(g.id, 'last_half_hour');
    notifyState(g.id);
  }
  if (e >= g.durationMin) {
    endGame(g, 'sistema');
    notifyState(g.id);
  }
}

function tickAll() {
  const games = q.all(`SELECT * FROM games WHERE status IN (${C.ACTIVE.map(() => '?').join(',')})`, ...C.ACTIVE);
  for (const g of games) {
    try { tickGame(g); } catch (e) { console.error('tick', g.id, e); }
  }
}

// ---------------------------------------------------------------- azioni delle coppie

function gameForTeam(team) {
  return getGame(team.gameId);
}

function requireActive(g) {
  if (g.status === 'paused') throw err(409, 'Partita sospesa: gli Altari sono fermi');
  if (g.status === 'ended') throw err(409, 'I Giochi sono finiti: gli Altari sono chiusi');
  if (!C.ACTIVE.includes(g.status)) throw err(409, 'Gli Altari si aprono al via');
}

function pointByToken(g, qrToken) {
  const p = q.get('SELECT * FROM points WHERE gameId = ? AND qrToken = ?', g.id, String(qrToken || ''));
  if (!p) throw err(404, 'Altare non riconosciuto per questa partita');
  return p;
}

function fragmentOut(f, p, source, acquiredAt) {
  return { fragmentId: f.id, position: f.position, text: f.text, pointLabel: p.label, sectorId: p.sectorId, source, acquiredAt };
}

// Una scansione vale altarScanMin minuti (0 = senza limite); poi l'Altare va riscansionato.
const scanWindowMs = (g) => (g.altarScanMin > 0 ? g.altarScanMin * 60000 : null);
function scanExpiresAt(g, visitedAt, team = null) {
  const w = scanWindowMs(g);
  // Memoria del Nodo (Skill passiva): la scansione vale quanto deciso nei parametri della partita (mai meno del normale).
  const node = team && require('./skills').hasSkill(team.id, 'memoria_nodo') && g.nodeScanMin > 0 ? Math.max(w || 0, g.nodeScanMin * 60000) : null;
  return w && visitedAt ? visitedAt + (node || w) : null;
}

// Fa fede l'ora in cui il QR è stato inquadrato (anche se arriva dopo dalla coda offline), mai nel futuro né troppo vecchia.
function scanTime(at) {
  const now = Date.now();
  const t = Number(at);
  return Number.isFinite(t) && t <= now + 60000 && t > now - 12 * 3600000 ? Math.min(t, now) : now;
}

function recordScan(team, p, at) {
  q.run('INSERT INTO team_visits (teamId, pointId, visitedAt) VALUES (?, ?, ?) ON CONFLICT(teamId, pointId) DO UPDATE SET visitedAt = MAX(visitedAt, excluded.visitedAt)',
    team.id, p.id, scanTime(at));
  return q.get('SELECT visitedAt FROM team_visits WHERE teamId = ? AND pointId = ?', team.id, p.id).visitedAt;
}

function visitPoint(team, qrToken, at) {
  requireCouple(team);
  const g = gameForTeam(team);
  const p = pointByToken(g, qrToken);
  const visitedAt = recordScan(team, p, at);
  const s = sectorById(p.sectorId);
  const f = q.get('SELECT * FROM fragments WHERE pointId = ?', p.id);
  const owned = f && q.get('SELECT * FROM team_fragments WHERE teamId = ? AND fragmentId = ?', team.id, f.id);
  return {
    qrToken: p.qrToken, label: p.label, sectorId: s.id, sectorName: s.name, visitedAt, expiresAt: scanExpiresAt(g, visitedAt, team),
    unlocked: !!owned, fragment: owned ? fragmentOut(f, p, owned.source, owned.acquiredAt) : null,
  };
}

function unlock(team, qrToken, code) {
  requireCouple(team);
  const g = gameForTeam(team);
  const p = pointByToken(g, qrToken);
  requireActive(g);
  const f = q.get('SELECT * FROM fragments WHERE pointId = ?', p.id);
  if (!f) throw err(409, 'Questo Altare non custodisce frammenti');
  const owned = q.get('SELECT * FROM team_fragments WHERE teamId = ? AND fragmentId = ?', team.id, f.id);
  if (owned) return { ok: true, already: true, label: p.label, fragment: fragmentOut(f, p, owned.source, owned.acquiredAt) };
  // Serve una scansione ancora valida dell'Altare.
  const v = q.get('SELECT visitedAt FROM team_visits WHERE teamId = ? AND pointId = ?', team.id, p.id);
  const exp = v ? scanExpiresAt(g, v.visitedAt, team) : null;
  if (!v) return { ok: false, label: p.label, expired: true, message: 'Prima inquadrate il QR dell\'Altare con l\'app' };
  if (exp && exp < Date.now()) {
    log(g.id, `coppia:${team.id}`, 'unlock_scan_expired', { teamId: team.id, point: p.label });
    return { ok: false, label: p.label, expired: true, message: `Scansione scaduta (valeva ${g.altarScanMin} minuti): tornate all'Altare e riscansionatelo` };
  }
  const sc = q.get('SELECT * FROM sector_codes WHERE gameId = ? AND sectorId = ?', g.id, p.sectorId);
  const s = sectorById(p.sectorId);
  // Custode di un'altra coppia: finché il Sigillo è protetto, quell'Altare non si apre (nemmeno scrivendolo).
  const guardedUntil = p.sectorId !== team.sectorId && require('./skills').protectedSeals(team)[p.sectorId];
  if (guardedUntil) {
    return { ok: false, label: p.label, guarded: true, guardedUntil, message: `Sigillo del Settore ${s.name} custodito da un'altra coppia (Skill Custode): l'Altare non si apre fino alle ${new Date(guardedUntil).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })}.` };
  }
  if (!sc || normCode(code) !== sc.code) {
    log(g.id, `coppia:${team.id}`, 'unlock_failed', { teamId: team.id, point: p.label, attempt: normCode(code).slice(0, 12) });
    return { ok: false, label: p.label, message: `Sigillo non valido per questo Altare (${s.name})` };
  }
  const now = Date.now();
  q.run("INSERT INTO team_fragments (teamId, fragmentId, source, acquiredAt) VALUES (?, ?, 'unlocked', ?)", team.id, f.id, now);
  log(g.id, `coppia:${team.id}`, 'unlock', { teamId: team.id, point: p.label });
  require('./skills').onAltarUnlocked(team, p);
  rt.toTeams(g.id, 'state', {}, team.id);
  return { ok: true, label: p.label, fragment: fragmentOut(f, p, 'unlocked', now) };
}

function addManualFragment(team, text) {
  requireCouple(team);
  const g = gameForTeam(team);
  requireActive(g);
  const n = normText(text);
  if (!n) throw err(400, 'Scrivi il frammento');
  const f = q.all('SELECT * FROM fragments WHERE gameId = ?', g.id).find((x) => normText(x.text) === n);
  if (!f) {
    log(g.id, `coppia:${team.id}`, 'manual_fragment_failed', { teamId: team.id });
    return { ok: false, message: 'Questo non è un frammento della Parola' };
  }
  const p = q.get('SELECT * FROM points WHERE id = ?', f.pointId);
  const owned = q.get('SELECT * FROM team_fragments WHERE teamId = ? AND fragmentId = ?', team.id, f.id);
  if (owned) return { ok: true, already: true, fragment: fragmentOut(f, p, owned.source, owned.acquiredAt) };
  const now = Date.now();
  q.run("INSERT INTO team_fragments (teamId, fragmentId, source, acquiredAt) VALUES (?, ?, 'manual', ?)", team.id, f.id, now);
  log(g.id, `coppia:${team.id}`, 'manual_fragment', { teamId: team.id, point: p.label });
  rt.toTeams(g.id, 'state', {}, team.id);
  return { ok: true, fragment: fragmentOut(f, p, 'manual', now) };
}

function addCodeNote(team, sectorId, code) {
  requireCouple(team);
  const g = gameForTeam(team);
  if (['draft', 'ready'].includes(g.status)) throw err(409, 'Il taccuino si apre nel cerchio');
  const sid = Number(sectorId);
  const sc = q.get('SELECT * FROM sector_codes WHERE gameId = ? AND sectorId = ?', g.id, sid);
  if (!sc) throw err(400, 'Settore non in gioco');
  const c = normCode(code);
  if (!c) throw err(400, 'Scrivi il Sigillo');
  const correct = c === sc.code;
  q.run('INSERT INTO team_code_notes (teamId, sectorId, code, correct, addedAt) VALUES (?, ?, ?, ?, ?)', team.id, sid, c.slice(0, 16), correct ? 1 : 0, Date.now());
  log(g.id, `coppia:${team.id}`, correct ? 'code_note_ok' : 'code_note_wrong', { teamId: team.id, sector: sectorById(sid).name });
  return { ok: true, correct, sectorName: sectorById(sid).name, code: correct ? sc.code : null };
}

// ---------------------------------------------------------------- messaggi

const AUDIO_TYPES = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/aac': 'aac', 'audio/x-m4a': 'm4a' };
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const MAX_AUDIO_MS = 120000;

// Messaggio di testo o vocale (audio = { buffer, mime, ms }).
// squadId: solo per gli Eletti, conversazione con una singola squadra (null = tutti gli Eletti).
// senderId: il giocatore che scrive (gli Eletti scrivono in un canale di gruppo: gli altri membri lo ricevono).
function postMessage(team, fromRole, text, author, audio = null, squadId = null, senderId = null) {
  const t = String(text || '').trim().slice(0, 1000);
  let ext = null;
  let ms = null;
  if (audio) {
    const mime = String(audio.mime || '').split(';')[0].trim().toLowerCase();
    ext = AUDIO_TYPES[mime];
    if (!ext) throw err(415, 'Formato audio non supportato');
    if (!audio.buffer?.length) throw err(400, 'Vocale vuoto');
    ms = Math.max(0, Math.min(MAX_AUDIO_MS, parseInt(audio.ms, 10) || 0));
    audio.mime = mime;
  } else if (!t) throw err(400, 'Messaggio vuoto');
  const now = Date.now();
  const squad = squadId && team.kind === 'elect' ? q.get('SELECT * FROM elect_squads WHERE id = ? AND gameId = ?', Number(squadId), team.gameId) : null;
  if (squadId && !squad) throw err(400, 'Squadra non trovata');
  const r = q.run('INSERT INTO messages (gameId, teamId, squadId, fromRole, author, text, audioMime, audioMs, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    team.gameId, team.id, squad?.id ?? null, fromRole, author || null, t, audio ? audio.mime : null, ms, now);
  const id = Number(r.lastInsertRowid);
  if (audio) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    const file = `${id}.${ext}`;
    fs.writeFileSync(path.join(AUDIO_DIR, file), audio.buffer);
    q.run('UPDATE messages SET audioFile = ? WHERE id = ?', file, id);
  }
  const m = { id, teamId: team.id, squadId: squad?.id ?? null, fromRole, author, text: t, audioMime: audio ? audio.mime : null, audioMs: ms, createdAt: now };
  const preview = audio ? `🎤 Messaggio vocale (${Math.round((ms || 0) / 1000)}″)` : t;
  if (fromRole === 'master' && squad) {
    // Solo i telefoni dei membri della squadra.
    const members = new Set(q.all('SELECT id FROM players WHERE squadId = ?', squad.id).map((x) => x.id));
    rt.toTeamsWhere(team.gameId, 'message', m, (c) => c.teamId === team.id && members.has(c.playerId));
    rt.pushSubs(q.all('SELECT ps.* FROM push_subs ps JOIN players p ON p.id = ps.playerId WHERE p.squadId = ?', squad.id),
      { title: `Consiglio, squadra ${squad.name}`, body: preview, tag: `msg-${m.id}`, url: '/#/messaggi' });
  } else if (fromRole === 'master') {
    rt.toTeams(team.gameId, 'message', m, team.id);
    rt.pushTeams(team.gameId, { title: 'Messaggio dal Consiglio', body: preview, tag: `msg-${m.id}`, url: '/#/messaggi' }, team.id);
  } else {
    // Canali degli Eletti: il messaggio arriva subito a tutti i membri del canale (tutti gli Eletti o la squadra).
    if (team.kind === 'elect') {
      const members = squad ? new Set(q.all('SELECT id FROM players WHERE squadId = ?', squad.id).map((x) => x.id)) : null;
      rt.toTeamsWhere(team.gameId, 'message', m, (c) => c.teamId === team.id && (!members || members.has(c.playerId)));
      const subs = rt.gameSubs(team.gameId).filter((x) => x.effTeamId === team.id && x.playerId !== senderId && (!members || members.has(x.playerId)));
      rt.pushSubs(subs, { title: `${author || 'Eletto'} · ${squad ? `squadra ${squad.name}` : 'Tutti gli Eletti'}`, body: preview, tag: `msg-${m.id}`, url: '/#/messaggi' });
    }
    const s = team.sectorId ? sectorById(team.sectorId) : null;
    const from = team.kind === 'elect' ? (squad ? `squadra ${squad.name}` : 'Eletti del Consiglio') : s ? 'Settore ' + s.name : 'coppia';
    rt.pushMasters({ title: `Messaggio da ${from}${author ? ` (${author})` : ''}`, body: preview, url: '/regia#comunicazioni' });
  }
  log(team.gameId, fromRole === 'master' ? author : `coppia:${team.id}`, 'message', { teamId: team.id, fromRole });
  return m;
}

// File di un vocale, solo per la sua coppia o per l'organizzazione.
function messageAudio(id, { team, user }) {
  const m = q.get('SELECT * FROM messages WHERE id = ?', Number(id));
  if (!m?.audioFile) throw err(404, 'Vocale non trovato');
  if (!user && team?.id !== m.teamId) throw err(403, 'Non autorizzato');
  return { file: path.join(AUDIO_DIR, m.audioFile), mime: m.audioMime };
}

// squadId: undefined = tutta la conversazione, null = solo quella con tutti gli Eletti, numero = una squadra.
function markRead(teamId, squadId) {
  if (squadId === undefined) q.run("UPDATE messages SET readAt = ? WHERE teamId = ? AND fromRole = 'team' AND readAt IS NULL", Date.now(), teamId);
  else q.run("UPDATE messages SET readAt = ? WHERE teamId = ? AND squadId IS ? AND fromRole = 'team' AND readAt IS NULL", Date.now(), teamId, squadId);
}

// ---------------------------------------------------------------- correzioni di regia

function correctFragments(teamId, { action, fragmentId, reason }, actor) {
  const t = q.get('SELECT * FROM teams WHERE id = ?', teamId);
  if (!t) throw err(404, 'Coppia non trovata');
  if (!String(reason || '').trim()) throw err(400, 'La motivazione è obbligatoria');
  const f = q.get('SELECT * FROM fragments WHERE id = ? AND gameId = ?', fragmentId, t.gameId);
  if (!f) throw err(404, 'Frammento non trovato');
  if (action === 'add') q.run("INSERT OR IGNORE INTO team_fragments (teamId, fragmentId, source, acquiredAt) VALUES (?, ?, 'manual', ?)", t.id, f.id, Date.now());
  else if (action === 'remove') q.run('DELETE FROM team_fragments WHERE teamId = ? AND fragmentId = ?', t.id, f.id);
  else throw err(400, 'Azione non valida');
  log(t.gameId, actor, 'fragment_correction', { teamId: t.id, action, position: f.position, reason });
  rt.toTeams(t.gameId, 'state', {}, t.id);
}

// ---------------------------------------------------------------- validazione alla Soglia

function teamFragmentsBoard(team) {
  const frags = q.all(`SELECT f.*, p.label AS pointLabel, tf.source, tf.acquiredAt
                       FROM fragments f JOIN points p ON p.id = f.pointId
                       LEFT JOIN team_fragments tf ON tf.fragmentId = f.id AND tf.teamId = ?
                       WHERE f.gameId = ? ORDER BY f.position`, team.id, team.gameId);
  return frags;
}

function validatorView(teamId) {
  const t = q.get('SELECT * FROM teams WHERE id = ?', teamId);
  if (!t) throw err(404, 'Coppia non trovata');
  const s = t.sectorId ? sectorById(t.sectorId) : null;
  const rows = teamFragmentsBoard(t).map((f) => ({
    position: f.position, pointLabel: f.pointLabel, owned: !!f.source, text: f.source ? f.text : null, source: f.source,
  }));
  return {
    team: { id: t.id, displayName: t.displayName, sectorName: s?.name, roman: s?.roman, status: t.status, finishPosition: t.finishPosition, members: membersOf(t.id) },
    fragments: rows,
    complete: rows.length > 0 && rows.every((r) => r.owned),
    validations: q.all('SELECT * FROM validations WHERE teamId = ? ORDER BY id DESC', t.id),
  };
}

function compareTyped(teamId, typed) {
  const t = q.get('SELECT * FROM teams WHERE id = ?', teamId);
  if (!t) throw err(404, 'Coppia non trovata');
  const frags = q.all('SELECT * FROM fragments WHERE gameId = ? ORDER BY position', t.gameId);
  const map = Object.fromEntries((typed || []).map((x) => [Number(x.position), x.text]));
  return frags.map((f) => {
    const v = map[f.position];
    const empty = !normText(v);
    return { position: f.position, status: empty ? 'missing' : normText(v) === normText(f.text) ? 'ok' : 'wrong' };
  });
}

function validate(teamId, { mode, typed, notes }, user) {
  const t = q.get('SELECT * FROM teams WHERE id = ?', teamId);
  if (!t) throw err(404, 'Coppia non trovata');
  const g = getGame(t.gameId);
  if (!C.ACTIVE.includes(g.status)) throw err(409, 'Si valida solo a partita in corso');
  requireCouple(t);
  if (t.status !== 'active') throw err(409, t.status === 'won' ? 'Coppia già validata' : 'Coppia ritirata');
  let result;
  let missing = [];
  if (mode === 'typed') {
    const cmp = compareTyped(t.id, typed);
    missing = cmp.filter((c) => c.status !== 'ok').map((c) => ({ position: c.position, status: c.status }));
    result = !missing.length ? 'valid' : missing.some((m) => m.status === 'wrong') ? 'wrong' : 'incomplete';
  } else {
    const board = teamFragmentsBoard(t);
    missing = board.filter((f) => !f.source).map((f) => ({ position: f.position, pointLabel: f.pointLabel, status: 'missing' }));
    result = board.length && !missing.length ? 'valid' : 'incomplete';
  }
  const now = Date.now();
  let position = null;
  tx(() => {
    q.run('INSERT INTO validations (gameId, teamId, validatorId, at, result, missing, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      g.id, t.id, user.id, now, result, JSON.stringify(missing), notes || null);
    if (result === 'valid') {
      position = (q.get("SELECT MAX(finishPosition) AS m FROM teams WHERE gameId = ? AND status = 'won'", g.id).m || 0) + 1;
      q.run("UPDATE teams SET status = 'won', finishPosition = ?, wonAt = ? WHERE id = ?", position, now, t.id);
    }
  });
  const s = sectorById(t.sectorId);
  log(g.id, user.username, 'validation', { teamId: t.id, result, position });
  if (result === 'valid') {
    if (position === 1) announce(g.id, 'victory', { settore: s.name }, { teamId: t.id, position });
    else announce(g.id, 'podium', { settore: s.name, posizione: ordinal(position) }, { teamId: t.id, position });
  }
  notifyState(g.id);
  return { result, position, missing };
}

// Esfiltrazione: la coppia inquadra il QR di uscita della Soglia. Con la Parola intera e senza alleati esce
// (come una validazione) e il suo Sigillo viene rivelato a tutti, come in un tradimento.
function exfiltrate(team, token) {
  requireCouple(team);
  const g = getGame(team.gameId);
  landmarksOf(g.id);
  const soglia = q.get("SELECT * FROM landmarks WHERE gameId = ? AND kind = 'soglia'", g.id);
  if (!token || !soglia?.exitToken || String(token) !== soglia.exitToken) throw err(404, 'Questo non è il codice di uscita della Soglia di questa partita');
  if (g.status === 'paused') throw err(409, 'Partita sospesa: non si esce adesso');
  if (!C.ACTIVE.includes(g.status)) throw err(409, 'Si esfiltra solo a partita in corso');
  const t = q.get('SELECT * FROM teams WHERE id = ?', team.id);
  if (t.status === 'won') return { exfiltrated: true, already: true, position: t.finishPosition };
  if (t.status !== 'active') throw err(409, 'Coppia ritirata');
  const s = sectorById(t.sectorId);
  const ally = q.get('SELECT allianceId FROM alliance_members WHERE teamId = ? AND leftAt IS NULL', t.id);
  if (ally) {
    const allies = q.all(`SELECT s.name FROM alliance_members m JOIN teams t ON t.id = m.teamId JOIN sectors s ON s.id = t.sectorId
                          WHERE m.allianceId = ? AND m.leftAt IS NULL AND m.teamId <> ?`, ally.allianceId, t.id).map((r) => r.name);
    log(g.id, `coppia:${t.id}`, 'exit_denied', { settore: s.name, reason: 'alleanza', allies });
    return { exfiltrated: false, reason: 'alliance', allies };
  }
  const board = teamFragmentsBoard(t);
  const missing = board.filter((f) => !f.source).length;
  if (!board.length || missing) {
    log(g.id, `coppia:${t.id}`, 'exit_denied', { settore: s.name, reason: 'frammenti', missing });
    return { exfiltrated: false, reason: 'missing', missing, total: board.length };
  }
  const now = Date.now();
  let position;
  tx(() => {
    q.run('INSERT INTO validations (gameId, teamId, validatorId, at, result, missing, notes) VALUES (?, ?, NULL, ?, ?, ?, ?)',
      g.id, t.id, now, 'valid', '[]', 'Esfiltrazione con il QR di uscita della Soglia');
    position = (q.get("SELECT MAX(finishPosition) AS m FROM teams WHERE gameId = ? AND status = 'won'", g.id).m || 0) + 1;
    q.run("UPDATE teams SET status = 'won', finishPosition = ?, wonAt = ? WHERE id = ?", position, now, t.id);
  });
  log(g.id, `coppia:${t.id}`, 'exfiltration', { teamId: t.id, settore: s.name, position });
  if (position === 1) announce(g.id, 'victory', { settore: s.name }, { teamId: t.id, position });
  else announce(g.id, 'podium', { settore: s.name, posizione: ordinal(position) }, { teamId: t.id, position });
  // Il Sigillo di chi esce arriva a tutti, come un tradimento (se non era già stato rivelato).
  let revealed = false;
  try { revealSector(g.id, t.sectorId, 'esfiltrazione'); revealed = true; } catch { /* già rivelato */ }
  notifyState(g.id);
  return { exfiltrated: true, position, revealed };
}

// ---------------------------------------------------------------- classifica (7.2)

function standings(gameId) {
  const teams = teamsOf(gameId).filter((t) => t.status !== 'withdrawn');
  const stats = Object.fromEntries(q.all(`SELECT tf.teamId, COUNT(*) AS n, MAX(tf.acquiredAt) AS lastAt
                                          FROM team_fragments tf JOIN teams t ON t.id = tf.teamId
                                          WHERE t.gameId = ? GROUP BY tf.teamId`, gameId).map((r) => [r.teamId, r]));
  const rows = teams.map((t) => ({
    teamId: t.id, sectorName: t.sectorName, roman: t.roman, displayName: t.displayName, status: t.status,
    finishPosition: t.finishPosition, fragments: stats[t.id]?.n || 0, lastAt: stats[t.id]?.lastAt || null,
  }));
  const won = rows.filter((r) => r.status === 'won').sort((a, b) => a.finishPosition - b.finishPosition);
  const others = rows.filter((r) => r.status !== 'won').sort((a, b) => b.fragments - a.fragments || (a.lastAt ?? Infinity) - (b.lastAt ?? Infinity));
  return [...won, ...others].map((r, i) => ({ ...r, rank: i + 1 }));
}


// ---------------------------------------------------------------- partita di prova

const DEMO_NAMES = [
  ['Marco Rossi', 'Volpe'], ['Luca Bianchi', 'Gufo'], ['Sara Verdi', 'Lince'], ['Paolo Neri', 'Orso'], ['Giulia Gallo', 'Falco'],
  ['Andrea Costa', 'Lupo'], ['Elena Fontana', 'Corvo'], ['Davide Moretti', 'Cinghiale'], ['Chiara Ricci', 'Vipera'], ['Matteo Greco', 'Tasso'],
  ['Fabio Conti', 'Airone'], ['Irene Marino', 'Riccio'], ['Nicola Fabbri', 'Ombra'], ['Laura Testa', 'Eco'], ['Simone Leone', 'Ferro'],
  ['Marta Villa', 'Brina'], ['Stefano Serra', 'Cobra'], ['Anna Ferri', 'Nebbia'], ['Giorgio Pace', 'Sasso'], ['Valeria Monti', 'Selce'],
  ['Pietro Sala', 'Gheppio'], ['Silvia Riva', 'Faina'], ['Enrico Gatti', 'Granito'], ['Federica Rizzo', 'Cenere'],
];
const DEMO_PHRASE = 'Nel buio del bosco solo chi resta unito porta la Parola intera oltre la Soglia e libera il proprio Settore';

function createDemo(teamsCount, actor) {
  const n = Math.min(12, Math.max(2, parseInt(teamsCount, 10) || 6));
  const g = createGame({
    name: `Partita di prova · ${new Date().toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Rome' })}`,
    emergencyRadioChannel: 'PMR 8 · 446.09375 (prova)',
  }, actor);
  q.run('UPDATE games SET isDemo = 1, registrationOpen = 0 WHERE id = ?', g.id);
  shuffle(DEMO_NAMES).slice(0, n * 2).forEach(([name, nickname]) => addPlayer(g.id, { name, nickname }, { actor }));
  autoPair(g.id, actor);
  generateCodes(g.id, actor);
  setPhrase(g.id, DEMO_PHRASE, actor);
  saveSupply(g.id, { scheduledMin: 60, description: 'Prova: 2 casse di BB', message: '' }, actor);
  addElectPerson(g.id, { name: 'Consigliere Primo', nickname: 'Occhio' }, actor);
  addElectPerson(g.id, { name: 'Consigliere Secondo', nickname: 'Bilancia' }, actor);
  log(g.id, actor, 'demo_created', { teams: n });
  return g.id;
}

// Solo partite di prova: fa passare il tempo di gioco per vedere subito rivelazioni, fasi e fine.
// Orari di gioco della partita (salvati in ora reale): spostandoli insieme al via ogni avvenimento resta al suo
// minuto di gioco e si muove solo «adesso». Il registro resta in ora reale, le posizioni GPS restano attuali.
const GAME_TIMES = {
  revelations: ['firedAt'], supply_drops: ['firedAt', 'scheduledAt', 'closesAt', 'closedAt'], announcements: ['createdAt'],
  messages: ['createdAt'], validations: ['at'], gifts: ['revealedAt', 'claimedAt', 'usedAt', 'expiredAt', 'revealAt', 'publicAt'],
  squad_tasks: ['doneAt', 'assignedAt', 'cancelledAt', 'startedAt', 'endsAt', 'notifiedAt'],
  // Skill: effetti in corso e avvisi ritardati seguono il tempo di gioco.
  skill_effects: ['startedAt', 'endsAt', 'endedAt', 'notifyAt', 'notifiedAt'], alliances: ['createdAt', 'endedAt'], alliance_requests: ['createdAt', 'respondedAt'],
  engagements: ['createdAt', 'resolvedAt'], notices: ['createdAt'], teams: ['wonAt'],
};
const TEAM_TIMES = {
  team_fragments: ['acquiredAt'], team_code_notes: ['addedAt'], team_visits: ['visitedAt'], alliance_members: ['joinedAt', 'leftAt'],
  engagement_steals: ['createdAt', 'chosenAt'], team_timers: ['startedAt'],
  // Ricariche delle Skill: portando avanti il tempo di 30 minuti, mancano 30 minuti in meno.
  team_skills: ['readyAt'],
};
function shiftGameTimes(gameId, ms) {
  for (const [t, cols] of Object.entries(GAME_TIMES)) q.run(`UPDATE ${t} SET ${cols.map((c) => `${c} = ${c} - ?`).join(', ')} WHERE gameId = ?`, ...cols.map(() => ms), gameId);
  for (const [t, cols] of Object.entries(TEAM_TIMES)) q.run(`UPDATE ${t} SET ${cols.map((c) => `${c} = ${c} - ?`).join(', ')} WHERE teamId IN (SELECT id FROM teams WHERE gameId = ?)`, ...cols.map(() => ms), gameId);
}

// Dopo un salto in avanti: ciò che il salto ha scavalcato risulta partito al suo minuto previsto, non al momento
// del salto (tradimenti, armamenti, doni a minuto o a orario); un armamento già finito risulta chiuso alla sua ora.
function settleDemoJump(gameId, since) {
  const g = getGame(gameId);
  if (!canWarp(g) || !g.startedAt) return;
  const at = (min) => g.startedAt + Math.round(min * 60000);
  q.run("UPDATE revelations SET firedAt = ? + scheduledMin * 60000 WHERE gameId = ? AND status = 'fired' AND firedAt >= ? AND scheduledMin IS NOT NULL", g.startedAt, g.id, since);
  for (const s of q.all("SELECT * FROM supply_drops WHERE gameId = ? AND status = 'fired' AND firedAt >= ? AND (scheduledMin IS NOT NULL OR scheduledAt IS NOT NULL)", g.id, since)) {
    const firedAt = s.scheduledMin != null ? at(s.scheduledMin) : s.scheduledAt;
    const closesAt = s.durationMin ? firedAt + s.durationMin * 60000 : s.closesAt;
    q.run('UPDATE supply_drops SET firedAt = ?, closesAt = ? WHERE id = ?', firedAt, closesAt, s.id);
    if (closesAt && closesAt <= Date.now()) {
      closeSupply(s.id, 'sistema');
      q.run('UPDATE supply_drops SET closedAt = ?, closesAt = ? WHERE id = ?', closesAt, closesAt, s.id);
    }
  }
  for (const x of q.all("SELECT * FROM gifts WHERE gameId = ? AND revealedAt >= ? AND revealMode IN ('time','at')", g.id, since)) {
    const revealedAt = x.revealMode === 'time' && x.revealAtMin != null ? at(x.revealAtMin) : x.revealAt;
    if (revealedAt) q.run('UPDATE gifts SET revealedAt = ?, revealElapsedMs = ? WHERE id = ?', revealedAt, revealedAt - g.startedAt, x.id);
  }
}

// Avanzamento del tempo: nelle partite di prova e, nell'ambiente di test, in tutte le partite.
const canWarp = (g) => !!g.isDemo || isTestEnv();

function advanceDemo(gameId, minutes, actor) {
  const g = getGame(gameId);
  if (!canWarp(g)) throw err(403, 'Il tempo si può far avanzare solo nelle partite di prova o nell\'ambiente di test');
  if (!C.ACTIVE.includes(g.status)) throw err(409, 'Il tempo avanza solo a partita in corso (non in pausa)');
  let m = parseFloat(minutes);
  if (!Number.isFinite(m) || m === 0 || Math.abs(m) > 240) throw err(400, 'Minuti non validi');
  // Indietro: non prima del VIA. Ciò che è già successo (tradimenti, armamenti, scontri) resta registrato.
  if (m < 0) {
    const back = elapsedMs(g) / 60000;
    if (back < 0.01) throw err(409, 'Siete già al VIA: non si torna più indietro');
    m = Math.max(m, -back);
  }
  tx(() => {
    q.run('UPDATE games SET startedAt = startedAt - ? WHERE id = ?', Math.round(m * 60000), g.id);
    shiftGameTimes(g.id, Math.round(m * 60000));
  });
  log(g.id, actor, m > 0 ? 'demo_advance' : 'demo_rewind', { minutes: m });
  if (m < 0) {
    // Tornando prima dell'inizio di una fase si torna anche alla fase precedente.
    const now = getGame(g.id);
    const e = elapsedMs(now) / 60000;
    if (now.status === 'last_half_hour' && e < now.durationMin - C.LAST_PHASE_MIN) setStatus(now, 'hunt');
    if (getGame(g.id).status === 'hunt' && e < now.truceMin) setStatus(getGame(g.id), 'truce');
  }
  tickGame(getGame(g.id));
  notifyState(g.id);
}

// ---------------------------------------------------------------- viste

function revealedCodes(gameId) {
  return q.all(`SELECT r.sectorId, r.firedAt, c.code FROM revelations r
                JOIN sector_codes c ON c.gameId = r.gameId AND c.sectorId = r.sectorId
                WHERE r.gameId = ? AND r.status IN ('fired','manual')`, gameId);
}

function electState(team, player = null) {
  const g = gameForTeam(team);
  const squadId = player?.squadId ?? null;
  const squads = Object.fromEntries(q.all('SELECT id, name FROM elect_squads WHERE gameId = ?', g.id).map((x) => [x.id, x.name]));
  return {
    clock: clockOf(g),
    game: { id: g.id, name: g.name, emergencyRadioChannel: g.emergencyRadioChannel, bookUrl: g.bookUrl || '/regolamento.html', codeLength: g.codeLength, timers: timersOf(g), scheduledStart: g.scheduledStart },
    team: { id: team.id, kind: 'elect', displayName: team.displayName || 'Eletti del Consiglio', status: team.status, sector: null, members: membersOf(team.id).map((m) => ({ name: m.name, nickname: m.nickname })) },
    seal: null, fragments: [], notebook: [], visited: [],
    announcements: q.all('SELECT id, type, text, payload, createdAt FROM announcements WHERE gameId = ? ORDER BY id DESC LIMIT 200', g.id).map((a) => ({ ...a, payload: a.payload ? JSON.parse(a.payload) : null })),
    notices: noticesFor(team),
    // Conversazione con tutti gli Eletti più quella della propria squadra.
    messages: q.all('SELECT id, squadId, fromRole, author, text, audioMime, audioMs, createdAt FROM messages WHERE teamId = ? AND (squadId IS NULL OR squadId = ?) ORDER BY id', team.id, squadId)
      .map((m) => ({ ...m, squadName: m.squadId ? squads[m.squadId] || null : null })),
    supplyOpen: openSupply(g.id),
    standings: g.status === 'ended' ? standings(g.id).map((r) => ({ rank: r.rank, sectorName: r.sectorName, roman: r.roman, fragments: r.fragments, status: r.status, finishPosition: r.finishPosition, mine: false })) : null,
  };
}

function playerInfo(player) {
  return player ? { id: player.id, name: player.name, nickname: player.nickname, accessCode: player.accessCode, status: player.status, role: player.requestedRole } : null;
}

// Anteprima: iscritto (anche in attesa di approvazione) che non è ancora in una coppia né tra gli Eletti.
function lobbyState(player) {
  const g = getGame(player.gameId);
  const partner = player.regGroup ? q.get('SELECT name, nickname FROM players WHERE gameId = ? AND regGroup = ? AND id != ?', g.id, player.regGroup, player.id) : null;
  return {
    clock: clockOf(g),
    game: { id: g.id, name: g.name, emergencyRadioChannel: g.emergencyRadioChannel, bookUrl: g.bookUrl || '/regolamento.html', codeLength: g.codeLength, timers: timersOf(g), scheduledStart: g.scheduledStart },
    team: { id: null, kind: 'lobby', displayName: player.requestedTeamName, status: player.status, sector: null,
      members: [player, partner].filter(Boolean).map((m) => ({ name: m.name, nickname: m.nickname })) },
    player: playerInfo(player),
    seal: null, fragments: [], notebook: [], visited: [], messages: [], standings: null,
    announcements: q.all('SELECT id, type, text, payload, createdAt FROM announcements WHERE gameId = ? ORDER BY id DESC LIMIT 200', g.id).map((a) => ({ ...a, payload: a.payload ? JSON.parse(a.payload) : null })),
    notices: noticesFor({ gameId: g.id, kind: 'lobby', id: null }),
  };
}

function teamState(team, player = null) {
  const st = teamStateCore(team, player);
  st.player = playerInfo(player);
  return st;
}

function teamStateCore(team, player = null) {
  if (team.kind === 'elect') return electState(team, player);
  const g = gameForTeam(team);
  const s = team.sectorId ? sectorById(team.sectorId) : null;
  const sealVisible = !['draft', 'ready'].includes(g.status);
  const own = sealVisible && s ? q.get('SELECT code FROM sector_codes WHERE gameId = ? AND sectorId = ?', g.id, s.id) : null;
  const gameTeams = teamsOf(g.id).filter((t) => t.sectorId);
  const revealed = Object.fromEntries(revealedCodes(g.id).map((r) => [r.sectorId, r]));
  const notes = q.all('SELECT * FROM team_code_notes WHERE teamId = ? ORDER BY id', team.id);
  const lastNote = {};
  for (const n of notes) {
    if (n.correct) lastNote[n.sectorId] = n;
    else if (!lastNote[n.sectorId]?.correct) lastNote[n.sectorId] = n;
  }
  const points = q.all('SELECT * FROM points WHERE gameId = ?', g.id);
  const pointBySector = Object.fromEntries(points.map((p) => [p.sectorId, p]));
  const visitRows = Object.fromEntries(q.all('SELECT pointId, visitedAt FROM team_visits WHERE teamId = ?', team.id).map((v) => [v.pointId, v.visitedAt]));
  const visits = new Set(Object.keys(visitRows).map(Number));
  const scanValid = (pid) => { const e = scanExpiresAt(g, visitRows[pid], team); return !e || e >= Date.now(); };
  const board = teamFragmentsBoard(team);
  const ownedPoints = new Set(board.filter((f) => f.source).map((f) => f.pointId));

  // Taccuino: un Sigillo per ogni Altare in gioco, anche di quelli senza coppia (questi solo dal via).
  const coupleSectors = new Set(gameTeams.map((t) => t.sectorId));
  const guarded = require('./skills').protectedSeals(team);
  const notebook = (C.PRE_START.includes(g.status) ? [...coupleSectors] : gameSectorIds(g.id)).map((sid) => ({ sectorId: sid })).map((t) => {
    const sec = sectorById(t.sectorId);
    const p = pointBySector[t.sectorId];
    let entry = { sectorId: sec.id, sectorName: sec.name, roman: sec.roman, code: null, source: null };
    if (t.sectorId === team.sectorId && own) entry = { ...entry, code: own.code, source: 'own' };
    else if (revealed[t.sectorId]) entry = { ...entry, code: revealed[t.sectorId].code, source: 'revealed', at: revealed[t.sectorId].firedAt };
    else if (lastNote[t.sectorId]?.correct) entry = { ...entry, code: lastNote[t.sectorId].code, source: ['won', 'alliance', 'stolen', 'archive'].includes(lastNote[t.sectorId].source) ? lastNote[t.sectorId].source : 'note', at: lastNote[t.sectorId].addedAt };
    else if (lastNote[t.sectorId]) entry = { ...entry, wrongAttempt: lastNote[t.sectorId].code };
    entry.visitedToken = p && visits.has(p.id) && scanValid(p.id) ? p.qrToken : null;
    entry.unlocked = p ? ownedPoints.has(p.id) : false;
    if (!coupleSectors.has(t.sectorId)) entry.free = true;
    // Custode di un'altra coppia: il Sigillo resta coperto fino allo scadere (il proprio si legge sempre).
    if (guarded[t.sectorId] && entry.code && entry.source !== 'own') entry = { ...entry, code: null, guardedUntil: guarded[t.sectorId] };
    return entry;
  });

  const visited = points.filter((p) => visits.has(p.id)).map((p) => ({
    pointId: p.id, qrToken: p.qrToken, label: p.label, sectorId: p.sectorId, sectorName: sectorById(p.sectorId).name, unlocked: ownedPoints.has(p.id), guardedUntil: p.sectorId !== team.sectorId ? guarded[p.sectorId] || null : null,
    visitedAt: visitRows[p.id], expiresAt: scanExpiresAt(g, visitRows[p.id], team),
  }));

  return {
    clock: clockOf(g),
    game: {
      id: g.id, name: g.name, emergencyRadioChannel: g.emergencyRadioChannel, bookUrl: g.bookUrl || '/regolamento.html',
      codeLength: g.codeLength, timers: timersOf(g), scheduledStart: g.scheduledStart, altarScanMin: g.altarScanMin,
    },
    team: {
      id: team.id, kind: 'couple', displayName: team.displayName, status: team.status, finishPosition: team.finishPosition,
      sector: s ? { id: s.id, name: s.name, roman: s.roman, motto: s.motto, element: s.element } : null,
      members: membersOf(team.id).map((m) => ({ name: m.name, nickname: m.nickname })),
    },
    seal: own ? own.code : null,
    fragments: board.map((f) => ({
      position: f.position, pointLabel: f.pointLabel, text: f.source ? f.text : null, source: f.source || null, acquiredAt: f.acquiredAt || null,
    })),
    notebook,
    visited,
    announcements: q.all('SELECT id, type, text, payload, createdAt FROM announcements WHERE gameId = ? ORDER BY id DESC LIMIT 200', g.id)
      .map((a) => ({ ...a, payload: a.payload ? JSON.parse(a.payload) : null })),
    notices: noticesFor(team),
    messages: q.all('SELECT id, fromRole, author, text, audioMime, audioMs, createdAt FROM messages WHERE teamId = ? ORDER BY id', team.id),
    supplyOpen: openSupply(g.id),
    // A fine partita la classifica è pubblica.
    standings: g.status === 'ended' ? standings(g.id).map((r) => ({ rank: r.rank, sectorName: r.sectorName, roman: r.roman, fragments: r.fragments, status: r.status, finishPosition: r.finishPosition, mine: r.teamId === team.id })) : null,
  };
}

function nextEvents(g) {
  const nextRev = q.get("SELECT * FROM revelations WHERE gameId = ? AND status = 'scheduled' AND scheduledMin IS NOT NULL ORDER BY scheduledMin, ord LIMIT 1", g.id);
  // Prossima apertura degli armamenti, in ms dal via (gli orari fissi vengono convertiti).
  const el = elapsedMs(g);
  const nextSupply = q.all("SELECT * FROM supply_drops WHERE gameId = ? AND status = 'scheduled' AND (scheduledMin IS NOT NULL OR scheduledAt IS NOT NULL)", g.id)
    .map((s) => ({ ...s, scheduledMin: s.scheduledMin ?? (g.startedAt ? (el + (s.scheduledAt - Date.now())) / 60000 : null) }))
    .filter((s) => s.scheduledMin != null).sort((a, b) => a.scheduledMin - b.scheduledMin)[0];
  return {
    revelation: nextRev ? { id: nextRev.id, sectorId: nextRev.sectorId, sectorName: sectorById(nextRev.sectorId).name, atMs: nextRev.scheduledMin * 60000 } : null,
    supply: nextSupply ? { id: nextSupply.id, atMs: nextSupply.scheduledMin * 60000, description: nextSupply.description } : null,
    huntAtMs: g.truceMin * 60000,
    lastPhaseAtMs: (g.durationMin - C.LAST_PHASE_MIN) * 60000,
    endAtMs: g.durationMin * 60000,
  };
}

/**
 * Chi riceve le notifiche push. Per ogni persona della partita (in attesa, accettata, in coppia o tra gli Eletti):
 * 'on' = ha un telefono suo con le notifiche attive; 'shared' = solo il telefono della coppia (entrato col codice
 * della coppia) le riceve; 'off' = nessun dispositivo. In più l'organizzazione (master e validatori).
 */
function pushReport(gameId) {
  const g = getGame(gameId);
  const own = Object.fromEntries(q.all('SELECT playerId, COUNT(*) AS n FROM push_subs WHERE playerId IS NOT NULL GROUP BY playerId').map((r) => [r.playerId, r.n]));
  const shared = Object.fromEntries(q.all('SELECT teamId, COUNT(*) AS n FROM push_subs WHERE teamId IS NOT NULL AND playerId IS NULL GROUP BY teamId').map((r) => [r.teamId, r.n]));
  const squads = Object.fromEntries(q.all('SELECT id, name FROM elect_squads WHERE gameId = ?', g.id).map((x) => [x.id, x.name]));
  const people = q.all(`SELECT p.id, p.name, p.nickname, p.phone, p.status, p.requestedRole, p.teamId, p.squadId, a.username, p.trackVerifiedAt, p.trackSeenAt,
                               t.kind AS teamKind, t.status AS teamStatus, s.name AS sectorName, s.roman, s.ord
                        FROM players p LEFT JOIN accounts a ON a.id = p.accountId LEFT JOIN teams t ON t.id = p.teamId
                        LEFT JOIN sectors s ON s.id = t.sectorId
                        WHERE p.gameId = ? AND p.status IN ('pending','accepted')`, g.id).map((p) => {
    const mine = own[p.id] || 0;
    const team = p.teamId ? shared[p.teamId] || 0 : 0;
    const group = p.teamKind === 'elect' ? 'elect' : p.teamKind === 'couple' ? 'couple' : p.status === 'pending' ? 'pending' : 'free';
    return {
      id: p.id, name: p.name, nickname: p.nickname, phone: p.phone, username: p.username, status: p.status, requestedRole: p.requestedRole,
      group, where: group === 'couple' ? `${p.roman || ''} ${p.sectorName || ''}`.trim() : group === 'elect' ? (squads[p.squadId] ? `Squadra ${squads[p.squadId]}` : 'Eletti') : null,
      sectorOrd: p.ord ?? 999, devices: mine, teamDevices: team, state: mine ? 'on' : team ? 'shared' : 'off',
      // Traccar Client: verificato con la prova a schermo spento; «stale» se a partita in corso tace da 10 minuti.
      traccar: trackStateOf(p, g, p.teamId ? { kind: p.teamKind, status: p.teamStatus } : null).state, trackSeenAt: p.trackSeenAt || null,
    };
  }).sort((a, b) => a.sectorOrd - b.sectorOrd || a.name.localeCompare(b.name));
  const staff = q.all(`SELECT u.id, u.username, u.displayName, u.role, (SELECT COUNT(*) FROM push_subs ps WHERE ps.userId = u.id) AS devices
                       FROM users u ORDER BY u.role = 'master' DESC, u.username`).map((u) => ({ ...u, state: u.devices ? 'on' : 'off' }));
  return { people, staff };
}

function masterState(gameId) {
  const g = getGame(gameId);
  const elect = ensureElect(g.id);
  const pushDevices = {};
  for (const s of rt.gameSubs(g.id)) if (s.effTeamId) pushDevices[s.effTeamId] = (pushDevices[s.effTeamId] || 0) + 1;
  const online = rt.onlineByTeam();
  const teams = teamsOf(g.id);
  const fragCount = q.get('SELECT COUNT(*) AS n FROM fragments WHERE gameId = ?', g.id).n;
  const tfStats = Object.fromEntries(q.all(`SELECT tf.teamId, COUNT(*) AS n, MAX(tf.acquiredAt) AS lastAt FROM team_fragments tf
                                            JOIN teams t ON t.id = tf.teamId WHERE t.gameId = ? GROUP BY tf.teamId`, g.id).map((r) => [r.teamId, r]));
  const lastUnlock = Object.fromEntries(q.all(`SELECT tf.teamId, p.label, tf.acquiredAt FROM team_fragments tf
      JOIN fragments f ON f.id = tf.fragmentId JOIN points p ON p.id = f.pointId JOIN teams t ON t.id = tf.teamId
      WHERE t.gameId = ? ORDER BY tf.acquiredAt`, g.id).map((r) => [r.teamId, r]));
  const unread = Object.fromEntries(q.all("SELECT teamId, COUNT(*) AS n FROM messages WHERE gameId = ? AND fromRole = 'team' AND readAt IS NULL AND squadId IS NULL GROUP BY teamId", g.id).map((r) => [r.teamId, r.n]));
  const unreadSquad = Object.fromEntries(q.all("SELECT squadId, COUNT(*) AS n FROM messages WHERE gameId = ? AND fromRole = 'team' AND readAt IS NULL AND squadId IS NOT NULL GROUP BY squadId", g.id).map((r) => [r.squadId, r.n]));
  const owned = {};
  for (const r of q.all('SELECT tf.teamId, tf.fragmentId, tf.source FROM team_fragments tf JOIN teams t ON t.id = tf.teamId WHERE t.gameId = ?', g.id)) {
    (owned[r.teamId] ||= []).push({ fragmentId: r.fragmentId, source: r.source });
  }
  const revs = q.all('SELECT * FROM revelations WHERE gameId = ? ORDER BY COALESCE(scheduledMin, 99999), ord', g.id);
  const revBySector = Object.fromEntries(revs.map((r) => [r.sectorId, r]));
  const coupleSectors = new Set(teams.filter((t) => t.sectorId).map((t) => t.sectorId));
  const codes = q.all('SELECT * FROM sector_codes WHERE gameId = ?', g.id).map((c) => {
    const r = revBySector[c.sectorId];
    const s = sectorById(c.sectorId);
    return {
      ...c, sectorName: s.name, roman: s.roman, sectorOrd: s.ord, free: !coupleSectors.has(c.sectorId),
      state: r && ['fired', 'manual'].includes(r.status) ? 'revealed' : c.neverRevealed ? 'never' : 'pending',
      revelation: r || null,
    };
  }).sort((a, b) => a.sectorOrd - b.sectorOrd);

  return {
    clock: clockOf(g),
    game: { ...g, templates: templatesOf(g), timers: timersOf(g) },
    readiness: readiness(g),
    spots: spotsOf(g.id),
    env: process.env.ZDG_ENV || 'production',
    // Passaggi di fase (per la timeline degli stati in regia), dall'ultima ripartenza della partita.
    phaseLog: q.all(`SELECT type, at FROM event_log WHERE gameId = ? AND id > COALESCE((SELECT MAX(id) FROM event_log WHERE gameId = ? AND type = 'game_restarted'), 0)
                     AND type IN ('status_draft', 'status_ready', 'status_circle', 'game_started', 'phase_hunt', 'phase_last_half_hour', 'game_paused', 'game_resumed', 'game_ended') ORDER BY id`, g.id, g.id),
    canWarp: canWarp(g),
    // Persone (coppie ed Eletti) senza notifiche su nessun dispositivo: il numero accanto a «Notifiche».
    pushOff: pushReport(g.id).people.filter((p) => (p.state === 'off' || p.traccar !== 'ok') && ['couple', 'elect'].includes(p.group)).length,
    next: nextEvents(g),
    sectors: sectors(),
    players: q.all(`SELECT p.*, a.username, (SELECT COUNT(*) FROM players x WHERE x.gameId = p.gameId AND x.regGroup = p.regGroup) AS groupSize
                     FROM players p LEFT JOIN accounts a ON a.id = p.accountId WHERE p.gameId = ? ORDER BY p.teamId IS NOT NULL, p.regGroup IS NULL, p.regGroup, p.id`, g.id),
    teams: teams.map((t) => ({
      id: t.id, sectorId: t.sectorId, sectorName: t.sectorName, roman: t.roman, displayName: t.displayName, color: t.sectorColor,
      status: t.status, finishPosition: t.finishPosition, accessCode: t.accessCode, loginToken: t.loginToken,
      members: membersOf(t.id), fragments: tfStats[t.id]?.n || 0, fragmentsTotal: fragCount,
      lastUnlock: lastUnlock[t.id] || null, online: online[t.id] || 0, unread: unread[t.id] || 0, owned: owned[t.id] || [], pushDevices: pushDevices[t.id] || 0,
    })),
    elect: {
      id: elect.id, displayName: elect.displayName, accessCode: elect.accessCode, loginToken: elect.loginToken,
      members: membersOf(elect.id).map((m) => ({ ...m, pushDevices: q.get('SELECT COUNT(*) AS n FROM push_subs WHERE playerId = ?', m.id).n })), online: online[elect.id] || 0, unread: unread[elect.id] || 0, pushDevices: pushDevices[elect.id] || 0,
    },
    squads: q.all('SELECT id, name, color FROM elect_squads WHERE gameId = ? ORDER BY id', g.id).map((x) => ({
      ...x, members: q.all('SELECT id, name, nickname FROM players WHERE squadId = ?', x.id), unread: unreadSquad[x.id] || 0,
    })),
    notices: q.all('SELECT * FROM notices WHERE gameId = ? ORDER BY id DESC', g.id),
    noticeTargets: NOTICE_TARGETS,
    codes,
    revelations: revs.map((r) => ({ ...r, sectorName: sectorById(r.sectorId).name, roman: sectorById(r.sectorId).roman })),
    points: q.all(`SELECT p.*, f.id AS fragmentId, f.text AS fragmentText, f.position FROM points p
                   LEFT JOIN fragments f ON f.pointId = p.id WHERE p.gameId = ?`, g.id)
      .map((p) => ({ ...p, sectorName: sectorById(p.sectorId).name, roman: sectorById(p.sectorId).roman, sectorOrd: sectorById(p.sectorId).ord, free: !coupleSectors.has(p.sectorId) }))
      .sort((a, b) => a.sectorOrd - b.sectorOrd),
    landmarks: landmarksOf(g.id),
    emergencies: require('./emergency').list(g.id),
    // Incarichi generati dalle coppie (Maestro della caccia, Alleanze sporche) ancora senza squadra: banner in ogni pagina.
    pendingTasks: q.all('SELECT id, kind, targetLabel, text, createdAt FROM squad_tasks WHERE gameId = ? AND squadId IS NULL AND doneAt IS NULL AND cancelledAt IS NULL ORDER BY id', g.id),
    skills: require('./skills').masterSkills(g.id),
    supply: q.all("SELECT * FROM supply_drops WHERE gameId = ? ORDER BY status = 'closed', COALESCE(scheduledMin, 99999), COALESCE(scheduledAt, 0), id", g.id),
    announcements: q.all('SELECT * FROM announcements WHERE gameId = ? ORDER BY id DESC LIMIT 100', g.id),
    messages: q.all('SELECT * FROM messages WHERE gameId = ? ORDER BY id', g.id),
    validations: q.all('SELECT v.*, u.username FROM validations v LEFT JOIN users u ON u.id = v.validatorId WHERE v.gameId = ? ORDER BY v.id DESC', g.id),
    events: q.all('SELECT * FROM event_log WHERE gameId = ? ORDER BY id DESC LIMIT 150', g.id),
    standings: standings(g.id),
    templateLabels: C.TEMPLATE_LABELS,
  };
}

// Tabellone per il maxischermo al Cuore: solo informazioni pubbliche.
function boardState(gameId) {
  const g = getGame(gameId);
  const revealed = Object.fromEntries(revealedCodes(g.id).map((r) => [r.sectorId, r]));
  const next = nextEvents(g);
  return {
    clock: clockOf(g),
    game: { id: g.id, name: g.name, codeLength: g.codeLength },
    sectors: teamsOf(g.id).filter((t) => t.sectorId).map((t) => ({
      sectorId: t.sectorId, name: t.sectorName, roman: t.roman,
      code: revealed[t.sectorId]?.code || null, revealedAt: revealed[t.sectorId]?.firedAt || null,
      status: t.status, finishPosition: t.finishPosition,
    })),
    nextRevelationAtMs: g.status === 'hunt' || g.status === 'truce' || g.status === 'paused' ? next.revelation?.atMs ?? null : null,
    standings: standings(g.id).map((s) => ({ rank: s.rank, sectorName: s.sectorName, roman: s.roman, fragments: s.fragments, status: s.status, finishPosition: s.finishPosition })),
    fragmentsTotal: q.get('SELECT COUNT(*) AS n FROM fragments WHERE gameId = ?', g.id).n,
    announcements: q.all('SELECT id, type, text, createdAt FROM announcements WHERE gameId = ? ORDER BY id DESC LIMIT 6', g.id),
  };
}

module.exports = {
  landmarksOf, scanExpiresAt,
  getGame, sectors, sectorById, teamsOf, sectorsAdmin, saveSector, deleteSector, restoreSector, availableSectors,
  messageAudio, reviewPlayer, lobbyState, ensurePlayerCredentials, electOf, ensureElect, addToElect, addElectPerson, removeFromElect, createNotice, deleteNotice, membersOf, createGame, updateGame, deleteGame,
  addPlayer, publicRegister, updatePlayer, deletePlayer, createTeam, autoPair, updateTeam, dissolveTeam, withdrawTeam, regenTeamToken,
  spotsOf, pushReport, trackStateOf, TRACK_ON_PINGS, TRACK_PINGS_WINDOW_MS, ensurePoints, addFreePoints, deletePoint, gameSectorIds, generateCodes, extractNeverRevealed, buildCalendar, revelationOffsets, editRevelation, editPoint, regenPointToken, setPhrase, editFragment,
  readiness, control, revealNow, revealNext, revealSector, postponeRevelation, skipRevelation,
  saveSupply, deleteSupply, fireSupply, closeSupply, shiftSupply, freeAnnouncement, tickAll,
  visitPoint, unlock, addManualFragment, addCodeNote, postMessage, markRead, correctFragments,
  movePlayer, settleDemoJump, revealedCodes, validatorView, compareTyped, validate, exfiltrate, standings, teamState, masterState, boardState, log, clockOf, createDemo, advanceDemo,
  announce, notifyState,
};
