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
// Telefono (obbligatorio: serve all'organizzazione, anche per il gruppo WhatsApp della partita).
// Si tiene com'è scritto (spazi compresi), ma deve avere almeno 8 cifre ed essere fatto solo di cifre, spazi, + . - / ( ).
function cleanPhone(v) {
  const s = String(v ?? '').trim().slice(0, 30);
  if (!s) return null;
  if (!/^\+?[\d\s./()-]+$/.test(s) || s.replace(/\D/g, '').length < 8) throw err(400, 'Numero di telefono non valido: scrivilo con il prefisso, es. +39 333 1234567');
  return s;
}
const needPhone = (v) => { const p = cleanPhone(v); if (!p) throw err(400, 'Il numero di telefono è obbligatorio: serve all\'organizzazione (anche per il gruppo WhatsApp della partita)'); return p; };

function publicAccount(a) {
  if (!a) return null;
  // ops: gestionali collegati (Zero Dark Ops); senza password si entra solo da lì.
  const ops = q.all('SELECT id, iss, providerName, opsName, squadra, picture FROM account_identities WHERE accountId = ? ORDER BY id', a.id);
  // staff: ruolo nell'organizzazione ottenuto con un invito del Consiglio (master o validatore).
  const staff = q.get('SELECT role FROM users WHERE accountId = ?', a.id)?.role || null;
  // ice: solo alla persona stessa (il suo profilo); alla regia arriva soltanto dentro un'emergenza chiamata da lei.
  return { id: a.id, username: a.username, name: a.name, nickname: a.nickname, softairTeam: a.softairTeam, phone: a.phone, needsPhone: !a.phone, hasPassword: !!a.passHash, ops, staff,
    mustChangePassword: !!a.mustChangePassword,
    // Avatar nell'app: la foto del gestionale, se c'è (altrimenti le iniziali).
    picture: ops.find((o) => o.picture)?.picture || null,
    ice: { blood: a.iceBlood || '', conditions: a.iceConditions || '', contactName: a.iceContactName || '', contactPhone: a.iceContactPhone || '' } };
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
  const phone = needPhone(data.phone);
  // Lo username non deve confondersi con quello di un account della regia.
  if (q.get('SELECT 1 FROM accounts WHERE username = ?', username) || q.get('SELECT 1 FROM users WHERE lower(username) = ?', username)) throw err(409, 'Username già in uso: scegline un altro');
  const id = Number(q.run('INSERT INTO accounts (username, passHash, name, nickname, softairTeam, phone, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    username, hashPassword(password), name, String(data.nickname || '').trim().slice(0, 40) || null, softairTeam,
    phone, Date.now()).lastInsertRowid);
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
  const phone = data.phone !== undefined ? needPhone(data.phone) : account.phone;
  q.run('UPDATE accounts SET name = ?, nickname = ?, softairTeam = ?, phone = ? WHERE id = ?', name, nickname, softairTeam, phone, account.id);
  // ICE (facoltativo): si salva solo se il modulo lo manda.
  if (data.iceBlood !== undefined || data.iceConditions !== undefined || data.iceContactName !== undefined || data.iceContactPhone !== undefined) {
    const t = (v, n) => String(v ?? '').trim().slice(0, n) || null;
    q.run('UPDATE accounts SET iceBlood = ?, iceConditions = ?, iceContactName = ?, iceContactPhone = ? WHERE id = ?',
      t(data.iceBlood, 12), t(data.iceConditions, 600), t(data.iceContactName, 80), t(data.iceContactPhone, 30), account.id);
  }
  // I dati seguono le iscrizioni alle partite non ancora finite.
  q.run(`UPDATE players SET name = ?, nickname = ?, softairTeam = ?, phone = ? WHERE accountId = ? AND gameId IN (SELECT id FROM games WHERE status != 'ended')`, name, nickname, softairTeam, phone, account.id);
  if (data.password) {
    if (String(data.password).length < 8) throw err(400, 'La password deve avere almeno 8 caratteri');
    // Chi è entrato solo con il gestionale non ha ancora una password: la imposta senza quella attuale.
    if (account.passHash && !verifyPassword(String(data.currentPassword || ''), account.passHash)) throw err(403, 'La password attuale non è corretta');
    q.run('UPDATE accounts SET passHash = ?, mustChangePassword = 0 WHERE id = ?', hashPassword(String(data.password)), account.id);
  }
}

// Password temporanea facile da leggere e da scrivere su WhatsApp (niente 0/O, 1/l/I).
function tempPassword() {
  const crypto = require('crypto');
  const L = 'abcdefghjkmnpqrstuvwxyz';
  const D = '23456789';
  const pick = (s, n) => Array.from({ length: n }, () => s[crypto.randomInt(s.length)]).join('');
  return `${pick(L, 4)}-${pick(D, 4)}`;
}
// La regia reimposta la password di chi l'ha dimenticata (solo account con username e password: chi entra con
// Zero Dark Ops la gestisce lì). Senza password indicata ne genera una temporanea. Al primo accesso la persona
// deve sceglierne una nuova; le sessioni aperte si chiudono (deve rientrare con quella nuova).
function resetPassword(accountId, password, actor) {
  const a = q.get('SELECT * FROM accounts WHERE id = ?', Number(accountId));
  if (!a) throw err(404, 'Account non trovato');
  if (q.get('SELECT 1 FROM account_identities WHERE accountId = ?', a.id)) throw err(409, 'Questa persona entra con Zero Dark Ops: la password si gestisce lì');
  const pwd = password ? String(password) : tempPassword();
  if (pwd.length < 8) throw err(400, 'La password deve avere almeno 8 caratteri');
  q.run('UPDATE accounts SET passHash = ?, mustChangePassword = 1 WHERE id = ?', hashPassword(pwd), a.id);
  q.run("DELETE FROM sessions WHERE kind = 'account' AND refId = ?", a.id);
  q.run("DELETE FROM sessions WHERE kind = 'user' AND refId IN (SELECT id FROM users WHERE accountId = ?)", a.id);
  G.log(null, actor, 'account_password_reset', { username: a.username });
  return { username: a.username, password: pwd, name: a.name, phone: a.phone || null };
}

// La persona sceglie la nuova password (obbligatorio dopo un reset della regia: senza quella attuale).
function changePassword(account, data) {
  const pwd = String(data?.password || '');
  if (pwd.length < 8) throw err(400, 'La password deve avere almeno 8 caratteri');
  if (!account.mustChangePassword && account.passHash && !verifyPassword(String(data?.currentPassword || ''), account.passHash)) throw err(403, 'La password attuale non è corretta');
  if (account.mustChangePassword && verifyPassword(pwd, account.passHash)) throw err(400, 'Scegline una diversa da quella che ti ha dato la regia');
  q.run('UPDATE accounts SET passHash = ?, mustChangePassword = 0 WHERE id = ?', hashPassword(pwd), account.id);
  G.log(null, account.username, 'account_password_changed');
  return { ok: true };
}

// L'iscrizione "attuale" dell'account: quella in una partita non finita (la più recente), altrimenti l'ultima.
function currentPlayer(account) {
  return q.get(`SELECT p.* FROM players p JOIN games g ON g.id = p.gameId WHERE p.accountId = ?
                ORDER BY g.status = 'ended', p.id DESC LIMIT 1`, account.id);
}

function enrollments(account) {
  const ES = require('./eventstatus');
  return q.all(`SELECT p.*, g.name AS gameName, g.status AS gameStatus,
                  (SELECT COUNT(*) FROM players x WHERE x.gameId = p.gameId AND x.regGroup = p.regGroup) AS groupSize
                FROM players p JOIN games g ON g.id = p.gameId WHERE p.accountId = ? ORDER BY p.id DESC`, account.id)
    .map((e) => ({ id: e.id, gameId: e.gameId, gameName: e.gameName, gameStatus: e.gameStatus, status: e.status, requestedRole: e.requestedRole, regGroup: e.regGroup, teamId: e.teamId, groupSize: e.groupSize,
      pairCode: e.requestedRole === 'pair' && e.groupSize < 2 ? e.regGroup : null, event: ES.eventStatus(e) }));
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
  // Il telefono serve all'organizzazione (anche per il gruppo WhatsApp della partita): niente iscrizione senza.
  if (!account.phone) throw err(409, 'Prima inserisci il tuo numero di telefono nel profilo: è obbligatorio per iscriversi');
  const mode = ['pair', 'single', 'elect'].includes(data.mode) ? data.mode : null;
  if (!mode) throw err(400, 'Scegli come partecipare');
  let group = null;
  let teamName = null;
  let partner = null;
  // Posti: chi si unisce al compagno occupa il posto già preso dalla sua coppia.
  const spots = G.spotsOf(g.id);
  if (mode === 'pair' && !String(data.pairCode || '').trim() && spots.couples < 1) {
    throw err(409, spots.singles > 0 ? 'Settori per le coppie esauriti: se il tuo compagno ha già creato la coppia entra con il suo codice, altrimenti iscriviti come Temerario Solitario' : 'Settori per le coppie esauriti: se il tuo compagno ha già creato la coppia entra con il suo codice, altrimenti chiedi al Consiglio');
  }
  if (mode === 'single' && spots.singles < 1) throw err(409, 'Posti per i temerari solitari esauriti');
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
  rt.pushMasters({ title: `${what} da approvare`, body: `${account.name}${partner ? ` con ${partner.name}` : ''} — ${g.name}`, url: mode === 'elect' ? '/regia#squadre' : '/regia#coppie', tag: `iscrizione-${playerId}` });
  rt.toStaff(g.id, 'registration');
  return { ok: true, playerId, mode, pairCode: mode === 'pair' && !partner ? group : null, partner: partner ? partner.name : null };
}

/**
 * Un Legato diventa Temerario Solitario (es. il compagno non arriva o non può più venire): fino al Cerchio, finché
 * non è in una coppia. Il posto da Legato si libera; se il compagno si era già unito, a lui resta il codice coppia
 * per un altro Legato. Lo stato dell'iscrizione (in attesa o accettata) resta com'è.
 */
function pairToSingle(player, actor) {
  if (!player) throw err(404, 'Iscrizione non trovata');
  const g = G.getGame(player.gameId);
  if (!['created', 'draft', 'ready'].includes(g.status)) throw err(409, 'Le iscrizioni a questa partita sono chiuse');
  if (player.requestedRole !== 'pair') throw err(409, 'Non sei iscritto come Legato');
  if (player.teamId) throw err(409, 'Sei già in una coppia: per cambiare chiedi al Consiglio');
  if (!['pending', 'accepted'].includes(player.status)) throw err(409, 'Iscrizione non attiva');
  if (g.maxSingles != null && G.spotsOf(g.id).taken.singles >= g.maxSingles) throw err(409, 'Posti per i temerari solitari esauriti: chiedi al Consiglio');
  const partner = player.regGroup ? q.get("SELECT * FROM players WHERE gameId = ? AND regGroup = ? AND id != ? AND requestedRole = 'pair'", g.id, player.regGroup, player.id) : null;
  q.run("UPDATE players SET requestedRole = 'single', regGroup = NULL, requestedTeamName = NULL WHERE id = ?", player.id);
  G.log(g.id, actor, 'pair_to_single', { name: player.name, partner: partner?.name || null });
  rt.pushMasters({ title: 'Legato → Temerario solitario', body: `${player.name}${partner ? ` lascia la coppia con ${partner.name}` : ''} — ${g.name}`, url: '/regia#coppie', tag: `iscrizione-${player.id}` });
  rt.toStaff(g.id, 'registration');
  return { ok: true, partner: partner ? partner.name : null };
}

// ---- gestione dalla regia

function listAccounts() {
  return q.all(`SELECT a.id, a.username, a.name, a.nickname, a.softairTeam, a.phone, a.createdAt, a.passHash != '' AS hasPassword, (SELECT role FROM users u WHERE u.accountId = a.id) AS staff,
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
  const staff = q.get('SELECT role FROM users WHERE accountId = ?', a.id);
  if (staff) throw err(409, `${a.username} fa parte dell'organizzazione (${staff.role === 'master' ? 'master' : 'validatore'}): toglilo prima da Organizzazione`);
  const busy = q.get(`SELECT g.name FROM players p JOIN games g ON g.id = p.gameId WHERE p.accountId = ? AND g.status != 'ended' AND p.teamId IS NOT NULL`, a.id);
  if (busy) throw err(409, `${a.username} è in una coppia o tra gli Eletti nella partita «${busy.name}»: toglilo prima da lì`);
  tx(() => {
    // Iscrizioni non ancora in squadra (in attesa o accettate senza coppia): si cancellano con l'account.
    q.run(`DELETE FROM players WHERE accountId = ? AND teamId IS NULL AND gameId IN (SELECT id FROM games WHERE status != 'ended')`, a.id);
    q.run('UPDATE players SET accountId = NULL WHERE accountId = ?', a.id);
    q.run("DELETE FROM sessions WHERE kind = 'account' AND refId = ?", a.id);
  q.run("DELETE FROM sessions WHERE kind = 'user' AND refId IN (SELECT id FROM users WHERE accountId = ?)", a.id);
    q.run('DELETE FROM accounts WHERE id = ?', a.id);
  });
  G.log(null, actor, 'account_deleted', { username: a.username });
}

// Persone → Elimina: toglie la persona dalla partita e, se chiesto, elimina anche il suo profilo (account).
function deletePerson(playerId, withAccount, actor) {
  const p = q.get('SELECT * FROM players WHERE id = ?', Number(playerId));
  if (!p) throw err(404, 'Persona non trovata');
  const a = withAccount && p.accountId ? q.get('SELECT * FROM accounts WHERE id = ?', p.accountId) : null;
  if (a) {
    // Prima i controlli sull'account, così non si toglie la persona per poi fermarsi a metà.
    const staff = q.get('SELECT role FROM users WHERE accountId = ?', a.id);
    if (staff) throw err(409, `${a.username} fa parte dell'organizzazione (${staff.role === 'master' ? 'master' : 'validatore'}): toglilo prima da Organizzazione`);
    const busy = q.get(`SELECT g.name FROM players x JOIN games g ON g.id = x.gameId WHERE x.accountId = ? AND x.id != ? AND g.status != 'ended' AND x.teamId IS NOT NULL`, a.id, p.id);
    if (busy) throw err(409, `${a.username} è anche in una coppia o tra gli Eletti nella partita «${busy.name}»: toglilo prima da lì`);
  }
  const r = G.removePerson(p.id, actor);
  if (a) deleteAccount(a.id, actor);
  return { ...r, account: !!a };
}

// Account senza alcuna iscrizione (es. dopo aver eliminato una partita).
function deleteOrphanAccounts(actor) {
  // Chi fa parte dell'organizzazione (master, validatori) resta anche senza iscrizioni.
  const ids = q.all('SELECT id FROM accounts a WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.accountId = a.id) AND NOT EXISTS (SELECT 1 FROM users u WHERE u.accountId = a.id)').map((r) => r.id);
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
  cleanPhone, listAccounts, deleteAccount, deletePerson, deleteOrphanAccounts, register, authenticate, updateProfile, resetPassword, changePassword, tempPassword, currentPlayer, enrollments, enroll, pairToSingle, publicAccount };
