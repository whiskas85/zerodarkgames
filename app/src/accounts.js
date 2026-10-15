'use strict';
// Account dei giocatori: ci si registra una volta con username e password, poi per ogni partita si sceglie
// come partecipare (Legati, Temerario Solitario, Eletti). I master non si registrano: li crea la regia.
const { q, tx } = require('./db');
const G = require('./game');
const rt = require('./realtime');
const { hashPassword, verifyPassword, randomCode, HttpError } = require('./util');

const err = (status, msg) => new HttpError(status, msg);
const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;
const normUser = (u) => String(u || '').trim().toLowerCase();

function publicAccount(a) {
  if (!a) return null;
  // ops: gestionali collegati (Zero Dark Ops); senza password si entra solo da lì.
  const ops = q.all('SELECT id, iss, providerName, opsName, squadra FROM account_identities WHERE accountId = ? ORDER BY id', a.id);
  return { id: a.id, username: a.username, name: a.name, nickname: a.nickname, softairTeam: a.softairTeam, phone: a.phone, hasPassword: !!a.passHash, ops };
}

function register(data) {
  const username = normUser(data.username);
  if (!USERNAME_RE.test(username)) throw err(400, 'Username: da 3 a 30 caratteri tra lettere, numeri, punto, trattino e trattino basso');
  const password = String(data.password || '');
  if (password.length < 8) throw err(400, 'La password deve avere almeno 8 caratteri');
  const name = String(data.name || '').trim().slice(0, 80);
  if (!name) throw err(400, 'Nome e cognome sono obbligatori');
  const softairTeam = String(data.softairTeam || '').trim().slice(0, 60);
  if (!softairTeam) throw err(400, 'Indica il team di softair di appartenenza (o "nessuno")');
  // Lo username non deve confondersi con quello di un account della regia.
  if (q.get('SELECT 1 FROM accounts WHERE username = ?', username) || q.get('SELECT 1 FROM users WHERE lower(username) = ?', username)) throw err(409, 'Username già in uso: scegline un altro');
  const id = Number(q.run('INSERT INTO accounts (username, passHash, name, nickname, softairTeam, phone, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    username, hashPassword(password), name, String(data.nickname || '').trim().slice(0, 40) || null, softairTeam,
    String(data.phone || '').trim().slice(0, 30) || null, Date.now()).lastInsertRowid);
  G.log(null, username, 'account_created');
  return q.get('SELECT * FROM accounts WHERE id = ?', id);
}

function authenticate(username, password) {
  const a = q.get('SELECT * FROM accounts WHERE username = ?', normUser(username));
  return a && verifyPassword(String(password || ''), a.passHash) ? a : null;
}

function updateProfile(account, data) {
  const name = data.name !== undefined ? String(data.name).trim().slice(0, 80) : account.name;
  if (!name) throw err(400, 'Nome e cognome sono obbligatori');
  const softairTeam = data.softairTeam !== undefined ? String(data.softairTeam).trim().slice(0, 60) : account.softairTeam;
  if (!softairTeam) throw err(400, 'Indica il team di softair di appartenenza (o "nessuno")');
  const nickname = data.nickname !== undefined ? String(data.nickname).trim().slice(0, 40) || null : account.nickname;
  const phone = data.phone !== undefined ? String(data.phone).trim().slice(0, 30) || null : account.phone;
  q.run('UPDATE accounts SET name = ?, nickname = ?, softairTeam = ?, phone = ? WHERE id = ?', name, nickname, softairTeam, phone, account.id);
  // I dati seguono le iscrizioni alle partite non ancora finite.
  q.run(`UPDATE players SET name = ?, nickname = ?, softairTeam = ?, phone = ? WHERE accountId = ? AND gameId IN (SELECT id FROM games WHERE status != 'ended')`, name, nickname, softairTeam, phone, account.id);
  if (data.password) {
    if (String(data.password).length < 8) throw err(400, 'La password deve avere almeno 8 caratteri');
    // Chi è entrato solo con il gestionale non ha ancora una password: la imposta senza quella attuale.
    if (account.passHash && !verifyPassword(String(data.currentPassword || ''), account.passHash)) throw err(403, 'La password attuale non è corretta');
    q.run('UPDATE accounts SET passHash = ? WHERE id = ?', hashPassword(String(data.password)), account.id);
  }
}

// La regia reimposta la password di un giocatore che l'ha dimenticata.
function resetPassword(accountId, password, actor) {
  const a = q.get('SELECT * FROM accounts WHERE id = ?', Number(accountId));
  if (!a) throw err(404, 'Account non trovato');
  if (String(password || '').length < 8) throw err(400, 'La password deve avere almeno 8 caratteri');
  q.run('UPDATE accounts SET passHash = ? WHERE id = ?', hashPassword(String(password)), a.id);
  G.log(null, actor, 'account_password_reset', { username: a.username });
}

// L'iscrizione "attuale" dell'account: quella in una partita non finita (la più recente), altrimenti l'ultima.
function currentPlayer(account) {
  return q.get(`SELECT p.* FROM players p JOIN games g ON g.id = p.gameId WHERE p.accountId = ?
                ORDER BY g.status = 'ended', p.id DESC LIMIT 1`, account.id);
}

function enrollments(account) {
  return q.all(`SELECT p.id, p.gameId, g.name AS gameName, g.status AS gameStatus, p.status, p.requestedRole, p.regGroup, p.teamId,
                  (SELECT COUNT(*) FROM players x WHERE x.gameId = p.gameId AND x.regGroup = p.regGroup) AS groupSize
                FROM players p JOIN games g ON g.id = p.gameId WHERE p.accountId = ? ORDER BY p.id DESC`, account.id)
    .map((e) => ({ ...e, pairCode: e.requestedRole === 'pair' && e.groupSize < 2 ? e.regGroup : null }));
}

const PAIR_CODE = () => randomCode(6);

/**
 * Iscrizione a una partita: mode 'pair' (crea la coppia e riceve il codice da dare al compagno,
 * oppure si unisce con il codice del compagno), 'single' (Temerario Solitario), 'elect' (Eletti).
 */
function enroll(account, data) {
  const g = G.getGame(Number(data.gameId));
  if (!g.registrationOpen || g.status !== 'draft') throw err(409, 'Le iscrizioni a questa partita sono chiuse');
  if (q.get('SELECT 1 FROM players WHERE gameId = ? AND accountId = ?', g.id, account.id)) throw err(409, 'Sei già iscritto a questa partita');
  const mode = ['pair', 'single', 'elect'].includes(data.mode) ? data.mode : null;
  if (!mode) throw err(400, 'Scegli come partecipare');
  let group = null;
  let teamName = null;
  let partner = null;
  if (mode === 'pair') {
    const code = String(data.pairCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code) {
      const members = q.all("SELECT * FROM players WHERE gameId = ? AND regGroup = ? AND requestedRole = 'pair'", g.id, code);
      if (!members.length) throw err(404, 'Codice coppia non trovato: controllalo con il tuo compagno');
      if (members.length >= 2) throw err(409, 'Questa coppia è già completa');
      group = code;
      partner = members[0];
      teamName = partner.requestedTeamName;
    } else {
      do group = PAIR_CODE(); while (q.get('SELECT 1 FROM players WHERE regGroup = ?', group));
      teamName = String(data.teamName || '').trim().slice(0, 60) || null;
    }
  }
  const playerId = tx(() => {
    const id = G.addPlayer(g.id, { name: account.name, nickname: account.nickname || '', softairTeam: account.softairTeam, phone: account.phone || '', note: mode === 'elect' ? String(data.note || '') : '' },
      { self: true, regGroup: group, requestedTeamName: teamName, requestedRole: mode });
    q.run('UPDATE players SET accountId = ? WHERE id = ?', account.id, id);
    // Se il compagno era già stato accettato, chi si unisce lo segue nella decisione del Consiglio.
    return id;
  });
  const what = { pair: partner ? 'Legato (si unisce alla coppia)' : 'Coppia (in attesa del compagno)', single: 'Temerario solitario', elect: 'Candidatura agli Eletti' }[mode];
  rt.pushMasters({ title: `${what} da approvare`, body: `${account.name}${partner ? ` con ${partner.name}` : ''} — ${g.name}`, url: mode === 'elect' ? '/regia#squadre' : '/regia#coppie' });
  rt.toStaff(g.id, 'registration');
  return { ok: true, playerId, mode, pairCode: mode === 'pair' && !partner ? group : null, partner: partner ? partner.name : null };
}

// ---- gestione dalla regia

function listAccounts() {
  return q.all(`SELECT a.id, a.username, a.name, a.nickname, a.softairTeam, a.phone, a.createdAt, a.passHash != '' AS hasPassword,
                  (SELECT group_concat(i.providerName, ' · ') FROM account_identities i WHERE i.accountId = a.id) AS ops,
                  (SELECT COUNT(*) FROM players p WHERE p.accountId = a.id) AS enrollments,
                  (SELECT COUNT(*) FROM players p JOIN games g ON g.id = p.gameId WHERE p.accountId = a.id AND g.status != 'ended') AS active,
                  (SELECT group_concat(g.name, ' · ') FROM players p JOIN games g ON g.id = p.gameId WHERE p.accountId = a.id) AS games
                FROM accounts a ORDER BY a.username`);
}

// Elimina un account: le iscrizioni a partite non finite vanno prima tolte dalla partita (coppia, Eletti, iscrizione).
function deleteAccount(id, actor) {
  const a = q.get('SELECT * FROM accounts WHERE id = ?', Number(id));
  if (!a) throw err(404, 'Account non trovato');
  const busy = q.get(`SELECT g.name FROM players p JOIN games g ON g.id = p.gameId WHERE p.accountId = ? AND g.status != 'ended' AND p.teamId IS NOT NULL`, a.id);
  if (busy) throw err(409, `${a.username} è in una coppia o tra gli Eletti nella partita «${busy.name}»: toglilo prima da lì`);
  tx(() => {
    // Iscrizioni non ancora in squadra (in attesa o accettate senza coppia): si cancellano con l'account.
    q.run(`DELETE FROM players WHERE accountId = ? AND teamId IS NULL AND gameId IN (SELECT id FROM games WHERE status != 'ended')`, a.id);
    q.run('UPDATE players SET accountId = NULL WHERE accountId = ?', a.id);
    q.run("DELETE FROM sessions WHERE kind = 'account' AND refId = ?", a.id);
    q.run('DELETE FROM accounts WHERE id = ?', a.id);
  });
  G.log(null, actor, 'account_deleted', { username: a.username });
}

// Account senza alcuna iscrizione (es. dopo aver eliminato una partita).
function deleteOrphanAccounts(actor) {
  const ids = q.all('SELECT id FROM accounts a WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.accountId = a.id)').map((r) => r.id);
  tx(() => {
    for (const id of ids) {
      q.run("DELETE FROM sessions WHERE kind = 'account' AND refId = ?", id);
      q.run('DELETE FROM accounts WHERE id = ?', id);
    }
  });
  if (ids.length) G.log(null, actor, 'accounts_cleanup', { count: ids.length });
  return { deleted: ids.length };
}

module.exports = {
  listAccounts, deleteAccount, deleteOrphanAccounts, register, authenticate, updateProfile, resetPassword, currentPlayer, enrollments, enroll, publicAccount };
