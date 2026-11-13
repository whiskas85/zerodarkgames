'use strict';
// Mine traccianti («mine sonore») degli Eletti e punteggio degli Eletti.
//
// Mine: un Eletto posa una mina dove si trova (GPS). La vede solo il Consiglio (regia ed Eletti). La prima coppia che
// passa entro il raggio (mineRadiusM, di base 20 m) la fa scattare: la coppia è marcata e per mineMarkMin minuti
// (di base 5) tutti la vedono in mappa, coppie ed Eletti; la coppia lo scopre sempre il minuto dopo (notifica e
// simbolo della mina nella sua app). Le mine sono della squadra: ogni squadra ha mineCount mine (di base 3) in comune,
// chiunque della squadra le posa; finite, si ricaricano alla Base degli Eletti (un luogo del gioco da piazzare come la
// Soglia) o dalla regia. Un Eletto senza squadra ha una scorta sua. Chi è nascosto (Skill Ombra, Cono d'Ombra) non fa scattare
// le mine: restano armate.
//
// Punteggio: ogni azione riuscita degli Eletti è una riga di elect_scores (squadra e persona); i punti per tipo li
// sceglie la regia nei parametri della partita e valgono anche per le azioni già fatte.
const { q, tx } = require('./db');
const C = require('./constants');
const G = require('./game');
const rt = require('./realtime');
const { HttpError } = require('./util');

const err = (status, msg) => new HttpError(status, msg);
const SK = () => require('./skills');
const MIN = 60000;
// Ricarica: entro 30 m dalla Base (più l'incertezza del GPS, al massimo 20 m).
const BASE_RADIUS_M = 30;
// La coppia marcata lo scopre dopo un minuto.
const NOTIFY_AFTER_MS = MIN;
// Le mine scattate restano in mappa al Consiglio (in rosso) per 10 minuti.
const TRIGGERED_SHOW_MS = 10 * MIN;
// Si posano da quando gli Eletti sono in campo (partita pronta) fino alla fine.
const PLACE_STATUSES = ['ready', 'circle', 'truce', 'hunt', 'last_half_hour', 'paused'];

const cfg = (g) => ({
  count: Number(g.mineCount) >= 0 ? Number(g.mineCount) : 3,
  radius: Number(g.mineRadiusM) > 0 ? Number(g.mineRadiusM) : 20,
  markMin: Number(g.mineMarkMin) > 0 ? Number(g.mineMarkMin) : 5,
  // Durata dalla posa (0 = senza scadenza).
  lifeMin: Number.isFinite(Number(g.mineLifeMin)) && g.mineLifeMin != null ? Math.max(0, Number(g.mineLifeMin)) : 60,
});
// Mina armata: non scattata, non tolta, non scaduta.
const ARMED = '(triggeredAt IS NULL AND removedAt IS NULL AND (expiresAt IS NULL OR expiresAt > ?))';
const hhmm = (ms) => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'Europe/Rome' });
const electName = (p) => (p ? p.nickname || p.name : 'Eletti');
const teamOf = (id) => q.get('SELECT t.*, s.name AS sectorName, s.roman, s.color AS sectorColor FROM teams t LEFT JOIN sectors s ON s.id = t.sectorId WHERE t.id = ?', id);

function requireElect(team, player) {
  if (!team || team.kind !== 'elect') throw err(403, 'Le mine le posano gli Eletti');
  if (!player) throw err(403, 'Serve il tuo accesso personale di Eletto');
}
function readPos(body) {
  const lat = Number(body?.lat); const lng = Number(body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw err(400, 'Posizione non disponibile: attiva il GPS');
  const acc = Number(body?.acc);
  return { lat, lng, acc: Number.isFinite(acc) ? Math.round(acc) : null };
}
const baseOf = (gameId) => q.get("SELECT * FROM landmarks WHERE gameId = ? AND kind = 'base' AND lat IS NOT NULL", gameId);

// Scorta della squadra: mine posate da chiunque della squadra dopo l'ultima ricarica (scattate o no: una mina posata è spesa).
function squadMinesLeft(squadId, g) {
  const sq = q.get('SELECT * FROM elect_squads WHERE id = ?', squadId);
  if (!sq) return 0;
  const used = q.get('SELECT COUNT(*) AS n FROM elect_mines WHERE squadId = ? AND gameId = ? AND placedAt > ?', sq.id, g.id, sq.minesReloadAt || 0).n;
  return Math.max(0, cfg(g).count - used);
}
// Mine a disposizione di un Eletto: quelle della sua squadra (senza squadra: una scorta sua).
function minesLeft(player, g = G.getGame(player.gameId)) {
  if (player.squadId) return squadMinesLeft(player.squadId, g);
  const used = q.get('SELECT COUNT(*) AS n FROM elect_mines WHERE playerId = ? AND gameId = ? AND squadId IS NULL AND placedAt > ?', player.id, g.id, player.minesReloadAt || 0).n;
  return Math.max(0, cfg(g).count - used);
}
const reloadPool = (pl, now) => (pl.squadId ? q.run('UPDATE elect_squads SET minesReloadAt = ? WHERE id = ?', now, pl.squadId) : q.run('UPDATE players SET minesReloadAt = ? WHERE id = ?', now, pl.id));
// Telefoni da avvisare per una scorta: tutta la squadra (o la persona senza squadra).
const poolSubs = (pl) => (pl.squadId ? q.all('SELECT ps.* FROM push_subs ps JOIN players p ON p.id = ps.playerId WHERE p.squadId = ?', pl.squadId) : q.all('SELECT * FROM push_subs WHERE playerId = ?', pl.id));

function changed(gameId, { couples = false } = {}) {
  const elect = G.electOf(gameId);
  if (couples) rt.toTeams(gameId, 'state', {});
  else if (elect) rt.toTeams(gameId, 'state', {}, elect.id);
  rt.toStaff(gameId, 'mines');
}

// ---------------------------------------------------------------- azioni degli Eletti

function placeMine(team, player, body) {
  requireElect(team, player);
  const g = G.getGame(team.gameId);
  if (!PLACE_STATUSES.includes(g.status)) throw err(409, g.status === 'ended' ? 'La partita è finita' : g.status === 'exfil' ? 'Esfiltrazione: le mine non si posano più' : 'Le mine si posano da quando la partita è pronta');
  const pos = readPos(body);
  if (pos.acc != null && pos.acc > 50) throw err(409, `GPS troppo impreciso (±${pos.acc} m): aspettate qualche secondo all'aperto e riprovate`);
  const pl = q.get('SELECT * FROM players WHERE id = ?', player.id);
  if (!minesLeft(pl, g)) throw err(409, baseOf(g.id) ? `Mine finite${pl.squadId ? ' (sono della squadra)' : ''}: ricaricatele alla Base degli Eletti` : 'Mine finite: la Base degli Eletti non è ancora sulla mappa, chiedete alla regia');
  const { radius, lifeMin } = cfg(g);
  // Sempre dopo l'ultima ricarica, anche se cade nello stesso millisecondo: altrimenti la mina non sarebbe contata come spesa.
  const reloadAt = (pl.squadId ? q.get('SELECT minesReloadAt FROM elect_squads WHERE id = ?', pl.squadId)?.minesReloadAt : pl.minesReloadAt) || 0;
  const now = Math.max(Date.now(), reloadAt + 1);
  const id = Number(q.run('INSERT INTO elect_mines (gameId, squadId, playerId, author, lat, lng, radiusM, placedAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    g.id, pl.squadId || null, pl.id, electName(pl), pos.lat, pos.lng, radius, now, lifeMin ? now + lifeMin * MIN : null).lastInsertRowid);
  G.log(g.id, `giocatore:${pl.id}`, 'mine_placed', { by: electName(pl), radius, lat: pos.lat, lng: pos.lng });
  changed(g.id);
  return { ok: true, id, left: minesLeft(pl, g), radius };
}

function reloadMines(team, player, body) {
  requireElect(team, player);
  const g = G.getGame(team.gameId);
  const base = baseOf(g.id);
  if (!base) throw err(409, 'La Base degli Eletti non è ancora sulla mappa: chiedete alla regia');
  const pos = readPos(body);
  const d = SK().distM(pos, base);
  const reach = BASE_RADIUS_M + Math.min(20, pos.acc || 0);
  if (d > reach) throw err(409, `Siete a ${Math.round(d)} m dalla Base: avvicinatevi (entro ${BASE_RADIUS_M} m) per ricaricare`);
  const pl = q.get('SELECT * FROM players WHERE id = ?', player.id);
  const before = minesLeft(pl, g);
  reloadPool(pl, Date.now());
  G.log(g.id, `giocatore:${pl.id}`, 'mines_reloaded', { by: electName(pl), from: before, to: cfg(g).count });
  // Gli altri della squadra lo sanno: la scorta è di tutti.
  if (pl.squadId) rt.pushSubs(poolSubs(pl).filter((x) => x.playerId !== pl.id), { title: '💣 Mine ricaricate', body: `${electName(pl)} ha ricaricato le mine della squadra alla Base: ne avete ${cfg(g).count}.`, tag: 'mines-reload', url: '/#/mine' });
  changed(g.id);
  return { ok: true, left: cfg(g).count, before };
}

// Ricarica dalla regia, ovunque siano: una squadra (squadId), la scorta di un Eletto (playerId: quella della sua squadra)
// o tutte le squadre (e gli Eletti senza squadra).
function reloadByRegia(gameId, target, actor) {
  const g = G.getGame(gameId);
  const t = target && typeof target === 'object' ? target : { playerId: target };
  const elects = q.all("SELECT p.* FROM players p JOIN teams t ON t.id = p.teamId WHERE p.gameId = ? AND t.kind = 'elect'", g.id);
  let pools;
  if (t.squadId) {
    const sq = q.get('SELECT * FROM elect_squads WHERE id = ? AND gameId = ?', Number(t.squadId), g.id);
    if (!sq) throw err(404, 'Squadra non trovata');
    pools = [{ squadId: sq.id, id: null, label: `squadra ${sq.name}` }];
  } else if (t.playerId) {
    const pl = elects.find((p) => p.id === Number(t.playerId));
    if (!pl) throw err(404, 'Eletto non trovato');
    pools = [{ ...pl, label: pl.squadId ? `squadra ${q.get('SELECT name FROM elect_squads WHERE id = ?', pl.squadId)?.name || ''}` : electName(pl) }];
  } else {
    pools = [...q.all('SELECT id AS squadId, name FROM elect_squads WHERE gameId = ?', g.id).map((sq) => ({ squadId: sq.squadId, id: null, label: `squadra ${sq.name}` })),
      ...elects.filter((p) => !p.squadId).map((p) => ({ ...p, label: electName(p) }))];
    if (!pools.length) throw err(404, 'Nessun Eletto');
  }
  const now = Date.now();
  const push = { title: '💣 Mine ricaricate', body: `Il Consiglio vi ha ricaricato le mine: ne avete ${cfg(g).count}.`, tag: 'mines-reload', url: '/#/mine' };
  for (const pl of pools) { reloadPool(pl, now); rt.pushSubs(poolSubs(pl), push); }
  G.log(g.id, actor, 'mines_reloaded', { by: actor, who: t.squadId || t.playerId ? pools[0].label : 'tutte le squadre', to: cfg(g).count });
  changed(g.id);
  return { ok: true, count: pools.length, mines: cfg(g).count };
}

function removeMine(gameId, mineId, actor) {
  const m = q.get('SELECT * FROM elect_mines WHERE id = ? AND gameId = ?', Number(mineId), Number(gameId));
  if (!m) throw err(404, 'Mina non trovata');
  if (m.removedAt) return { ok: true };
  q.run('UPDATE elect_mines SET removedAt = ?, removedBy = ? WHERE id = ?', Date.now(), actor, m.id);
  G.log(m.gameId, actor, 'mine_removed', { by: m.author, triggered: !!m.triggeredAt });
  // Rimossa mentre la coppia è ancora marcata: la marcatura finisce.
  changed(m.gameId, { couples: !!(m.markUntil && m.markUntil > Date.now()) });
  return { ok: true };
}

// ---------------------------------------------------------------- scatto

// Posizione nuova di una coppia: la prima mina armata nel raggio scatta (una alla volta).
function onPosition(team, pos, now = Date.now()) {
  if (!team || team.kind !== 'couple' || team.status !== 'active') return;
  const g = G.getGame(team.gameId);
  // Nell'extra time (esfiltrazione) le mine non scattano più.
  if (!C.ACTIVE.includes(g.status) || g.status === 'exfil') return;
  const armed = q.all(`SELECT * FROM elect_mines WHERE gameId = ? AND ${ARMED}`, g.id, now);
  if (!armed.length) return;
  const S = SK();
  const hit = armed.map((m) => ({ m, d: S.distM(pos, m) })).filter((x) => x.d <= x.m.radiusM).sort((a, b) => a.d - b.d)[0];
  if (!hit) return;
  // Nascosti (Ombra, Cono d'Ombra): la mina non li sente.
  const full = teamOf(team.id);
  if (S.hiddenTeam(full, now) || require('./zones').visibilityOf(team.id) === 'hidden') return;
  const { markMin } = cfg(g);
  const until = now + markMin * MIN;
  const r = q.run('UPDATE elect_mines SET triggeredAt = ?, teamId = ?, trigLat = ?, trigLng = ?, markUntil = ?, notifyAt = ? WHERE id = ? AND triggeredAt IS NULL',
    now, team.id, pos.lat, pos.lng, until, now + NOTIFY_AFTER_MS, hit.m.id);
  if (!r.changes) return;
  const m = hit.m;
  tx(() => {
    addScore(g.id, 'mine', `mine:${m.id}`, { squadId: m.squadId, playerId: m.playerId, label: `Mina: Settore ${full.sectorName}` });
  });
  G.log(g.id, 'sistema', 'mine_triggered', { teamId: team.id, settore: full.sectorName, by: m.author, minutes: markMin, lat: pos.lat, lng: pos.lng });
  // Chi l'ha posata (la sua squadra) lo sa subito; tutti vedono la coppia da adesso.
  const push = { title: '💣 Mina scattata', body: `${m.author}: il Settore ${full.sectorName} è marcato fino alle ${hhmm(until)}. Tutti lo vedono in mappa.`, tag: `mine-${m.id}`, url: '/#/mappa' };
  if (m.squadId) { try { require('./field').notifySquadPublic(m.squadId, push); } catch { /* squadra eliminata */ } }
  else if (m.playerId) rt.pushSubs(q.all('SELECT * FROM push_subs WHERE playerId = ?', m.playerId), push);
  rt.pushMasters({ title: '💣 Mina scattata', body: `Settore ${full.sectorName} marcato per ${markMin} minuti (mina di ${m.author}).`, url: '/regia#mappa' });
  // Le altre coppie lo vedono subito: la coppia marcata si aggiorna, ma lo scopre solo dopo un minuto.
  rt.toTeams(g.id, 'state', {});
  rt.toStaff(g.id, 'mines');
}

function tickAll(now = Date.now()) {
  // Il minuto dopo: la coppia marcata lo scopre.
  for (const m of q.all('SELECT * FROM elect_mines WHERE notifyAt IS NOT NULL AND notifiedAt IS NULL AND notifyAt <= ? AND removedAt IS NULL', now)) {
    q.run('UPDATE elect_mines SET notifiedAt = ? WHERE id = ?', now, m.id);
    if (!m.teamId || !(m.markUntil > now)) continue;
    rt.pushTeams(m.gameId, { title: '💣 Mina sonora: siete marcati', body: `Avete fatto scattare una mina del Consiglio: fino alle ${hhmm(m.markUntil)} tutti vedono la vostra posizione.`, tag: `mine-${m.id}`, url: '/#/mappa' }, m.teamId);
    rt.toTeams(m.gameId, 'state', {}, m.teamId);
  }
  // Fine della marcatura: le mappe si aggiornano.
  const ended = q.all('SELECT * FROM elect_mines WHERE markUntil IS NOT NULL AND markUntil <= ? AND endedNotifiedAt IS NULL', now);
  for (const m of ended) q.run('UPDATE elect_mines SET endedNotifiedAt = ? WHERE id = ?', now, m.id);
  for (const gameId of new Set(ended.map((m) => m.gameId))) { rt.toTeams(gameId, 'state', {}); rt.toStaff(gameId, 'mines'); }
  // Mine scadute senza scattare: spariscono dalle mappe di regia ed Eletti.
  const expired = q.all('SELECT * FROM elect_mines WHERE expiresAt IS NOT NULL AND expiresAt <= ? AND triggeredAt IS NULL AND removedAt IS NULL AND expiredNotifiedAt IS NULL', now);
  for (const m of expired) q.run('UPDATE elect_mines SET expiredNotifiedAt = ? WHERE id = ?', now, m.id);
  for (const gameId of new Set(expired.map((m) => m.gameId))) changed(gameId);
}

// ---------------------------------------------------------------- viste

// Coppie marcate adesso: { teamId, until, since, mineId } (la marcatura più lunga per coppia).
function markedTeams(gameId, now = Date.now()) {
  const out = new Map();
  for (const m of q.all('SELECT * FROM elect_mines WHERE gameId = ? AND teamId IS NOT NULL AND markUntil > ? AND removedAt IS NULL', gameId, now)) {
    const prev = out.get(m.teamId);
    if (!prev || prev.until < m.markUntil) out.set(m.teamId, { teamId: m.teamId, until: m.markUntil, since: m.triggeredAt, mineId: m.id, notified: !!m.notifiedAt });
  }
  return [...out.values()];
}

// Per la coppia marcata: lo sa solo dal minuto dopo.
function coupleMark(team, now = Date.now()) {
  if (!team || team.kind !== 'couple') return null;
  const m = markedTeams(team.gameId, now).find((x) => x.teamId === team.id);
  if (!m) return null;
  const n = q.get('SELECT notifiedAt FROM elect_mines WHERE id = ?', m.mineId);
  return n?.notifiedAt ? { until: m.until, since: m.since } : null;
}

const mineOut = (m, now = Date.now()) => {
  const t = m.teamId ? teamOf(m.teamId) : null;
  return {
    id: m.id, lat: m.lat, lng: m.lng, radius: m.radiusM, placedAt: m.placedAt, expiresAt: m.expiresAt || null, author: m.author, squadId: m.squadId, playerId: m.playerId,
    triggeredAt: m.triggeredAt || null, markUntil: m.markUntil && m.markUntil > now ? m.markUntil : null,
    team: t ? { teamId: t.id, roman: t.roman, sectorName: t.sectorName, color: t.sectorColor } : null,
  };
};

// Le mine per il Consiglio (regia ed Eletti): armate e scattate da poco.
function minesOf(gameId, now = Date.now()) {
  return q.all(`SELECT * FROM elect_mines WHERE gameId = ? AND removedAt IS NULL AND (${ARMED} OR (triggeredAt IS NOT NULL AND (triggeredAt > ? OR markUntil > ?))) ORDER BY id`, gameId, now, now - TRIGGERED_SHOW_MS, now)
    .map((m) => mineOut(m, now));
}

// Pagina «Mine» dell'app degli Eletti.
function electMines(team, player) {
  if (!team || team.kind !== 'elect') return null;
  const g = G.getGame(team.gameId);
  const c = cfg(g);
  const pl = player ? q.get('SELECT * FROM players WHERE id = ?', player.id) : null;
  const base = baseOf(g.id);
  return {
    count: c.count, radius: c.radius, markMin: c.markMin, lifeMin: c.lifeMin, left: pl ? minesLeft(pl, g) : 0, personal: !!pl,
    squadName: pl?.squadId ? q.get('SELECT name FROM elect_squads WHERE id = ?', pl.squadId)?.name || null : null,
    canPlace: PLACE_STATUSES.includes(g.status),
    base: base ? { lat: base.lat, lng: base.lng, radius: BASE_RADIUS_M, label: base.label } : null,
    list: minesOf(g.id).map((m) => ({ ...m, mine: !!pl && m.playerId === pl.id, squad: !!pl?.squadId && m.squadId === pl.squadId })),
    score: electScore(g.id, pl),
  };
}

// ---------------------------------------------------------------- punteggio degli Eletti

const SCORE_KINDS = {
  fight: { label: 'Ingaggio vinto', icon: '⚔', field: 'scoreFight', def: 3 },
  bounty: { label: 'Taglia riscossa', icon: '💰', field: 'scoreBounty', def: 5 },
  beacon: { label: 'Beacon riuscito', icon: '📡', field: 'scoreBeacon', def: 2 },
  mine: { label: 'Mina scattata', icon: '💣', field: 'scoreMine', def: 2 },
};
const scoreValues = (g) => Object.fromEntries(Object.entries(SCORE_KINDS).map(([k, v]) => [k, Number.isFinite(Number(g[v.field])) && g[v.field] != null ? Number(g[v.field]) : v.def]));

function addScore(gameId, kind, ref, { squadId = null, playerId = null, label = null } = {}) {
  if (!SCORE_KINDS[kind]) return;
  // Senza squadra si prende quella della persona.
  const sq = squadId ?? (playerId ? q.get('SELECT squadId FROM players WHERE id = ?', playerId)?.squadId : null) ?? null;
  q.run('INSERT OR IGNORE INTO elect_scores (gameId, squadId, playerId, kind, ref, label, at) VALUES (?, ?, ?, ?, ?, ?, ?)', gameId, sq, playerId, kind, ref, label, Date.now());
  const elect = G.electOf(gameId);
  if (elect) rt.toTeams(gameId, 'state', {}, elect.id);
  rt.toStaff(gameId, 'scores');
}
function removeScore(gameId, kind, ref) {
  if (q.run('DELETE FROM elect_scores WHERE gameId = ? AND kind = ? AND ref = ?', gameId, kind, ref).changes) {
    const elect = G.electOf(gameId);
    if (elect) rt.toTeams(gameId, 'state', {}, elect.id);
    rt.toStaff(gameId, 'scores');
  }
}

// Classifica delle squadre (e delle persone) con il dettaglio per tipo.
function scoresOf(gameId) {
  const g = G.getGame(gameId);
  const val = scoreValues(g);
  const rows = q.all('SELECT * FROM elect_scores WHERE gameId = ? ORDER BY at DESC', g.id);
  const squads = q.all('SELECT id, name, color FROM elect_squads WHERE gameId = ? ORDER BY id', g.id);
  const people = q.all("SELECT p.id, p.name, p.nickname, p.squadId FROM players p JOIN teams t ON t.id = p.teamId WHERE p.gameId = ? AND t.kind = 'elect' ORDER BY p.id", g.id);
  const zero = () => Object.fromEntries(Object.keys(SCORE_KINDS).map((k) => [k, 0]));
  const sum = (list) => { const counts = zero(); for (const r of list) counts[r.kind] += 1; return { counts, total: Object.entries(counts).reduce((a, [k, n]) => a + n * val[k], 0) }; };
  const rank = (list) => list.sort((a, b) => b.total - a.total || a.id - b.id).map((x, i, arr) => ({ ...x, rank: arr.filter((y) => y.total > x.total).length + 1, _i: i }));
  const squadList = rank(squads.map((s) => ({ ...s, minesLeft: squadMinesLeft(s.id, g), ...sum(rows.filter((r) => r.squadId === s.id)) })));
  const full = Object.fromEntries(q.all("SELECT p.* FROM players p JOIN teams t ON t.id = p.teamId WHERE p.gameId = ? AND t.kind = 'elect'", g.id).map((p) => [p.id, p]));
  const personList = rank(people.map((p) => ({ id: p.id, name: p.nickname || p.name, squadId: p.squadId, minesLeft: full[p.id] ? minesLeft(full[p.id], g) : 0, ...sum(rows.filter((r) => r.playerId === p.id)) })));
  return {
    mineCount: cfg(g).count,
    values: val,
    kinds: Object.fromEntries(Object.entries(SCORE_KINDS).map(([k, v]) => [k, { label: v.label, icon: v.icon, points: val[k] }])),
    squads: squadList.map(({ _i, ...x }) => x),
    people: personList.map(({ _i, ...x }) => x),
    recent: rows.slice(0, 30).map((r) => ({ kind: r.kind, label: r.label, at: r.at, points: val[r.kind], squadId: r.squadId, playerId: r.playerId,
      who: r.playerId ? (people.find((p) => p.id === r.playerId)?.nickname || people.find((p) => p.id === r.playerId)?.name || null) : null })),
  };
}

// Per l'app degli Eletti: la propria squadra, sé stessi e la classifica delle squadre.
function electScore(gameId, player) {
  const s = scoresOf(gameId);
  return {
    kinds: s.kinds,
    squads: s.squads,
    squad: player?.squadId ? s.squads.find((x) => x.id === player.squadId) || null : null,
    me: player ? s.people.find((x) => x.id === player.id) || null : null,
    recent: s.recent.filter((r) => player?.squadId && r.squadId === player.squadId).slice(0, 10),
  };
}

// Partita di test ripartita: niente mine né punti.
function resetGame(gameId) {
  q.run('DELETE FROM elect_mines WHERE gameId = ?', gameId);
  q.run('DELETE FROM elect_scores WHERE gameId = ?', gameId);
  q.run('UPDATE players SET minesReloadAt = NULL WHERE gameId = ?', gameId);
}

module.exports = {
  BASE_RADIUS_M, SCORE_KINDS, placeMine, reloadMines, reloadByRegia, removeMine, onPosition, tickAll, markedTeams, coupleMark, minesOf, minesLeft, electMines,
  addScore, removeScore, scoresOf, electScore, resetGame,
};
