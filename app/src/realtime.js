'use strict';
// Canale in tempo reale: Server-Sent Events per i client aperti, Web Push per quelli in background.
const webpush = require('web-push');
const { q, getSetting, setSetting } = require('./db');

const clients = new Set(); // { res, gameId, kind: 'team'|'user', teamId, userId, role }

function addClient(c) {
  clients.add(c);
  c.res.on('close', () => clients.delete(c));
}

function write(c, event, data) {
  try {
    c.res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
  } catch { clients.delete(c); }
}

// Coppie della partita (tutte o una sola).
function toTeams(gameId, event, data, teamId = null) {
  for (const c of clients) {
    if (c.kind === 'team' && c.gameId === gameId && (teamId == null || c.teamId === teamId)) write(c, event, data);
  }
}

// Telefoni della partita scelti con un filtro (es. i membri di una squadra di Eletti).
function toTeamsWhere(gameId, event, data, pred) {
  for (const c of clients) if (c.kind === 'team' && c.gameId === gameId && pred(c)) write(c, event, data);
}

// Regia e validatori: ricevono un "refresh" con debounce per non saturare la rete.
const pendingStaff = new Map();
function toStaff(gameId, reason = 'update') {
  if (pendingStaff.has(gameId)) return;
  pendingStaff.set(gameId, setTimeout(() => {
    pendingStaff.delete(gameId);
    for (const c of clients) if (c.kind === 'user') write(c, 'refresh', { gameId, reason });
  }, 300));
}

function onlineByTeam() {
  const m = {};
  for (const c of clients) if (c.kind === 'team') m[c.teamId] = (m[c.teamId] || 0) + 1;
  return m;
}

setInterval(() => {
  for (const c of clients) {
    try { c.res.write(': ping\n\n'); } catch { clients.delete(c); }
  }
}, 25000).unref();

// ---- Web Push ----
let vapid = null;
function initPush() {
  let keys = getSetting('vapid');
  if (!keys) {
    keys = JSON.stringify(webpush.generateVAPIDKeys());
    setSetting('vapid', keys);
  }
  vapid = JSON.parse(keys);
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:consiglio@zerodarkteam.it', vapid.publicKey, vapid.privateKey);
}
const publicKey = () => vapid?.publicKey;

function saveSubscription(sub, { teamId = null, userId = null, playerId = null }) {
  if (!sub?.endpoint) return;
  q.run(`INSERT INTO push_subs (endpoint, data, teamId, userId, playerId, createdAt) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET data = excluded.data, teamId = excluded.teamId, userId = excluded.userId, playerId = excluded.playerId`,
    sub.endpoint, JSON.stringify(sub), teamId, userId, playerId, Date.now());
}

// Dispositivi dei giocatori di una partita. Un dispositivo entrato col codice personale segue il giocatore:
// la sua "squadra" è quella in cui il giocatore si trova adesso (null se non è ancora in coppia).
function gameSubs(gameId) {
  return q.all(`SELECT ps.*, COALESCE(ps.teamId, pl.teamId) AS effTeamId, t.kind AS teamKind
                FROM push_subs ps
                LEFT JOIN players pl ON pl.id = ps.playerId
                LEFT JOIN teams t ON t.id = COALESCE(ps.teamId, pl.teamId)
                WHERE ps.userId IS NULL AND (t.gameId = ? OR pl.gameId = ?)`, gameId, gameId);
}

async function sendPush(subs, payload) {
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(JSON.parse(s.data), body, { TTL: 600, urgency: 'high' });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) q.run('DELETE FROM push_subs WHERE id = ?', s.id);
    }
  }));
}

function pushTeams(gameId, payload, teamId = null) {
  const subs = gameSubs(gameId).filter((s) => teamId == null || s.effTeamId === teamId);
  sendPush(subs, payload).catch(() => {});
}

function pushMasters(payload) {
  const subs = q.all("SELECT p.* FROM push_subs p JOIN users u ON u.id = p.userId WHERE u.role = 'master'");
  sendPush(subs, payload).catch(() => {});
}

function pushSubs(subs, payload) {
  sendPush(subs, payload).catch(() => {});
}

module.exports = { addClient, toTeams, toTeamsWhere, toStaff, onlineByTeam, initPush, publicKey, saveSubscription, pushTeams, pushMasters, pushSubs, gameSubs };
