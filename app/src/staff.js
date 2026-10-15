'use strict';
// Organizzazione (master e validatori) a partire da un account dei giocatori: un master genera un link d'invito,
// chi lo apre entra dal login principale (username e password o Zero Dark Ops) e diventa master o validatore.
// Il link vale una volta sola e scade; il master vede chi l'ha usato e può togliere il ruolo quando vuole.
const { q, tx } = require('./db');
const G = require('./game');
const { randomToken, HttpError } = require('./util');

const err = (status, msg) => new HttpError(status, msg);
const INVITE_TTL = 24 * 3600000;
const ROLE_LABEL = { master: 'master', validator: 'validatore' };

const staffOf = (accountId) => (accountId && q.get('SELECT id, username, role, displayName FROM users WHERE accountId = ?', accountId)) || null;
const homeOf = (role) => (role === 'master' ? '/regia' : '/soglia');

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

module.exports = { staffOf, homeOf, createInvite, pendingInvites, cancelInvite, validInvite, claimInvite, ROLE_LABEL };
