'use strict';
// Organizzazione (master e validatori) a partire da un account dei giocatori: un master genera un link d'invito,
// chi lo apre entra dal login principale (username e password o Zero Dark Ops) e diventa master o validatore.
// Il link vale una volta sola e scade; il master vede chi l'ha usato e può togliere il ruolo quando vuole.
const { q, tx } = require('./db');
const G = require('./game');
const { randomToken, HttpError } = require('./util');
const rt = require('./realtime');

const err = (status, msg) => new HttpError(status, msg);
const INVITE_TTL = 24 * 3600000;
const ROLE_LABEL = { master: 'master', validator: 'validatore' };

// Consiglio Zero: le azioni che il master può aprire a ciascuno. Il master le ha tutte; i validatori di prima
// (senza scelta salvata) restano con Soglia, Accettazione e Test repliche.
const PERMS = [
  ['accettazione', 'Accettazione', 'Conferma iscritti e squadre all\'arrivo'],
  ['armi', 'Test repliche', 'Cronografo e spunta delle repliche'],
  ['soglia', 'Soglia', 'Validazione dei frammenti all\'uscita'],
  ['campo', 'Campo', 'Strumento di campo: piazza Altari, punti e doni'],
  ['doni', 'Lancio doni', 'Fa comparire i doni già piazzati'],
  ['comunicazioni', 'Annunci', 'Manda un annuncio a tutte le coppie'],
];
const PERM_KEYS = PERMS.map(([k]) => k);
const LEGACY_PERMS = ['soglia', 'accettazione', 'armi'];

function permsOf(u) {
  if (!u) return [];
  if (u.role === 'master') return PERM_KEYS.slice();
  if (u.perms == null) return LEGACY_PERMS.slice();
  // Già letto (utente della sessione) o ancora come testo dal database.
  if (Array.isArray(u.perms)) return u.perms.filter((k) => PERM_KEYS.includes(k));
  try { return JSON.parse(u.perms).filter((k) => PERM_KEYS.includes(k)); } catch { return []; }
}
const can = (u, perm) => permsOf(u).includes(perm);
const withPerms = (u) => (u ? { ...u, perms: permsOf(u) } : null);

const staffOf = (accountId) => withPerms((accountId && q.get('SELECT id, username, role, displayName, perms FROM users WHERE accountId = ?', accountId)) || null);
const homeOf = (role) => (role === 'master' ? '/regia' : '/consiglio');

function createInvite(role, actor) {
  if (!ROLE_LABEL[role]) throw err(400, 'Ruolo non valido');
  const token = randomToken(24);
  const now = Date.now();
  q.run('INSERT INTO staff_invites (token, role, createdBy, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?)', token, role, actor, now, now + INVITE_TTL);
  G.log(null, actor, 'staff_invite_created', { role });
  return { token, role, expiresAt: now + INVITE_TTL };
}

const pendingInvites = () => q.all('SELECT token, role, createdBy, createdAt, expiresAt FROM staff_invites WHERE usedAt IS NULL AND expiresAt > ? ORDER BY createdAt DESC', Date.now());

function cancelInvite(token, actor) {
  const r = q.run('DELETE FROM staff_invites WHERE token = ? AND usedAt IS NULL', String(token));
  if (!r.changes) throw err(404, 'Invito non trovato o già usato');
  G.log(null, actor, 'staff_invite_cancelled');
}

function validInvite(token) {
  const inv = token ? q.get('SELECT * FROM staff_invites WHERE token = ?', String(token)) : null;
  return inv && !inv.usedAt && inv.expiresAt > Date.now() ? inv : null;
}

/** L'account accetta l'invito: diventa (o resta) utente dell'organizzazione. Un master non scende a validatore. */
function claimInvite(token, account) {
  return tx(() => {
    const inv = validInvite(token);
    if (!inv) throw err(410, 'Invito scaduto o già usato: chiedine uno nuovo al Consiglio');
    q.run('UPDATE staff_invites SET usedAt = ?, usedBy = ? WHERE token = ?', Date.now(), account.id, inv.token);
    const cur = staffOf(account.id);
    if (cur) {
      if (inv.role === 'master' && cur.role !== 'master') q.run("UPDATE users SET role = 'master' WHERE id = ?", cur.id);
    } else {
      let username = account.username;
      for (let i = 2; q.get('SELECT 1 FROM users WHERE lower(username) = lower(?)', username); i++) username = `${account.username}${i}`;
      q.run('INSERT INTO users (username, passHash, role, displayName, createdAt, accountId) VALUES (?, ?, ?, ?, ?, ?)', username, '', inv.role, account.name, Date.now(), account.id);
    }
    const staff = staffOf(account.id);
    G.log(null, staff.username, 'staff_invite_accepted', { role: staff.role, account: account.username });
    return staff;
  });
}

// ---- richieste d'accesso al Consiglio Zero: chi entra con Zero Dark Ops la chiede, il master sceglie le azioni.
const opsOf = (accountId) => q.all('SELECT providerName, opsName, squadra FROM account_identities WHERE accountId = ? ORDER BY id', accountId);

function councilStatus(account) {
  const staff = staffOf(account.id);
  const req = q.get('SELECT createdAt FROM council_requests WHERE accountId = ?', account.id);
  return { canRequest: opsOf(account.id).length > 0, requestedAt: req?.createdAt || null,
    staff: staff ? { role: staff.role, perms: staff.perms } : null };
}

function requestCouncil(account) {
  if (staffOf(account.id)) throw err(409, 'Sei già nel Consiglio Zero');
  if (!opsOf(account.id).length) throw err(403, 'La richiesta si fa entrando con Zero Dark Ops');
  const r = q.run('INSERT OR IGNORE INTO council_requests (accountId, createdAt) VALUES (?, ?)', account.id, Date.now());
  if (r.changes) {
    G.log(null, `account:${account.username}`, 'council_requested');
    const o = opsOf(account.id)[0];
    rt.pushMasters({ title: 'Consiglio Zero: richiesta d\'accesso', body: `${account.name}${o?.squadra ? ` · ${o.squadra}` : ''}`, url: '/regia#squadre/consiglio', tag: `consiglio-${account.id}` });
    rt.toStaff(null, 'council');
  }
  return councilStatus(account);
}

function withdrawCouncil(account) {
  q.run('DELETE FROM council_requests WHERE accountId = ?', account.id);
  return councilStatus(account);
}

const pendingCount = () => q.get('SELECT count(*) AS n FROM council_requests r WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.accountId = r.accountId)').n;
const cleanPerms = (perms) => [...new Set((Array.isArray(perms) ? perms : []).filter((k) => PERM_KEYS.includes(k)))];

/** Richieste in attesa e membri dell'organizzazione con le loro azioni. */
function councilList() {
  const requests = q.all(`SELECT r.accountId, r.createdAt, a.username, a.name, a.nickname, a.softairTeam, a.phone FROM council_requests r
    JOIN accounts a ON a.id = r.accountId WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.accountId = r.accountId) ORDER BY r.createdAt`)
    .map((r) => ({ ...r, ops: opsOf(r.accountId) }));
  const members = q.all(`SELECT u.id, u.username, u.role, u.displayName, u.perms, u.accountId, u.createdAt, a.username AS accountUsername, a.nickname, a.softairTeam, a.phone
    FROM users u LEFT JOIN accounts a ON a.id = u.accountId ORDER BY u.role, coalesce(u.displayName, u.username)`)
    .map((u) => ({ ...withPerms(u), ops: u.accountId ? opsOf(u.accountId) : [] }));
  return { perms: PERMS.map(([key, label, hint]) => ({ key, label, hint })), requests, members };
}

function acceptCouncil(accountId, perms, actor) {
  return tx(() => {
    const a = q.get('SELECT * FROM accounts WHERE id = ?', Number(accountId));
    if (!a) throw err(404, 'Account non trovato');
    q.run('DELETE FROM council_requests WHERE accountId = ?', a.id);
    if (staffOf(a.id)) throw err(409, 'È già nel Consiglio Zero');
    let username = a.username;
    for (let i = 2; q.get('SELECT 1 FROM users WHERE lower(username) = lower(?)', username); i++) username = `${a.username}${i}`;
    q.run("INSERT INTO users (username, passHash, role, displayName, createdAt, accountId, perms) VALUES (?, '', 'validator', ?, ?, ?, ?)",
      username, a.name, Date.now(), a.id, JSON.stringify(cleanPerms(perms)));
    G.log(null, actor, 'council_accepted', { account: a.username, perms: cleanPerms(perms) });
    return staffOf(a.id);
  });
}

function rejectCouncil(accountId, actor) {
  const r = q.run('DELETE FROM council_requests WHERE accountId = ?', Number(accountId));
  if (!r.changes) throw err(404, 'Richiesta non trovata');
  G.log(null, actor, 'council_rejected', { accountId: Number(accountId) });
}

/** Il master cambia le azioni di un membro, o lo fa diventare master (regia completa) e viceversa. */
function setCouncilPerms(uid, { perms, master }, me, actor) {
  const u = q.get('SELECT * FROM users WHERE id = ?', Number(uid));
  if (!u) throw err(404, 'Persona non trovata');
  if (master === false && u.id === me.id) throw err(409, 'Non puoi toglierti la regia da solo');
  const role = master === true ? 'master' : master === false ? 'validator' : u.role;
  const next = perms === undefined ? u.perms : JSON.stringify(cleanPerms(perms));
  q.run('UPDATE users SET role = ?, perms = ? WHERE id = ?', role, next, u.id);
  G.log(null, actor, 'council_perms', { username: u.username, role, perms: next });
  return withPerms(q.get('SELECT id, username, role, displayName, perms FROM users WHERE id = ?', u.id));
}

module.exports = { PERMS, pendingCount, permsOf, can, withPerms, councilStatus, requestCouncil, withdrawCouncil, councilList, acceptCouncil, rejectCouncil, setCouncilPerms,
  staffOf, homeOf, createInvite, pendingInvites, cancelInvite, validInvite, claimInvite, ROLE_LABEL };
