'use strict';
// Inviti del Consiglio: con un link monouso un account dei giocatori diventa master o validatore.
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zdg-staff-test-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const { q } = require('../src/db');
const A = require('../src/accounts');
const St = require('../src/staff');

const mario = A.register({ username: 'mario', password: 'password1', name: 'Mario Rossi', softairTeam: 'Zero Dark Team' });
const luca = A.register({ username: 'luca', password: 'password1', name: 'Luca Bianchi', softairTeam: 'nessuno' });

test('l\'invito da master fa di un account un master, una volta sola', () => {
  const inv = St.createInvite('master', 'master');
  assert.equal(St.staffOf(mario.id), null);
  const staff = St.claimInvite(inv.token, mario);
  assert.equal(staff.role, 'master');
  assert.equal(staff.username, 'mario');
  assert.equal(A.publicAccount(mario).staff, 'master');
  // Lo stesso link non serve a nessun altro.
  assert.throws(() => St.claimInvite(inv.token, luca), /scaduto o già usato/);
  assert.equal(St.staffOf(luca.id), null);
  // L'utente collegato non entra con username e password della regia.
  assert.equal(q.get("SELECT passHash FROM users WHERE username = 'mario'").passHash, '');
});

test('invito scaduto: niente ruolo', () => {
  const inv = St.createInvite('validator', 'master');
  q.run('UPDATE staff_invites SET expiresAt = ? WHERE token = ?', Date.now() - 1, inv.token);
  assert.equal(St.validInvite(inv.token), null);
  assert.throws(() => St.claimInvite(inv.token, luca), /scaduto/);
  assert.equal(St.pendingInvites().some((i) => i.token === inv.token), false);
});

test('validatore; un master non scende a validatore', () => {
  assert.equal(St.claimInvite(St.createInvite('validator', 'master').token, luca).role, 'validator');
  assert.equal(St.claimInvite(St.createInvite('validator', 'master').token, mario).role, 'master');
  assert.equal(St.claimInvite(St.createInvite('master', 'master').token, luca).role, 'master');
});

test('inviti annullabili; ruoli non validi rifiutati', () => {
  const inv = St.createInvite('validator', 'master');
  assert.ok(St.pendingInvites().some((i) => i.token === inv.token));
  St.cancelInvite(inv.token, 'master');
  assert.throws(() => St.claimInvite(inv.token, mario), /scaduto/);
  assert.throws(() => St.createInvite('admin', 'master'), /Ruolo/);
});

test('gli account dell\'organizzazione non si cancellano per sbaglio', () => {
  assert.throws(() => A.deleteAccount(mario.id, 'test'), /organizzazione/);
  assert.equal(A.deleteOrphanAccounts('test').deleted, 0);
  assert.ok(q.get('SELECT 1 FROM accounts WHERE id = ?', mario.id));
});

test('Consiglio Zero: chi entra con Zero Dark Ops chiede, il master sceglie le azioni', () => {
  const anna = A.register({ username: 'anna', password: 'password1', name: 'Anna Verdi', softairTeam: 'Zero Dark Team' });
  // Senza gestionale collegato la richiesta non si fa.
  assert.equal(St.councilStatus(anna).canRequest, false);
  assert.throws(() => St.requestCouncil(anna), /Zero Dark Ops/);
  q.run("INSERT INTO account_identities (accountId, iss, sub, providerName, opsName, squadra, createdAt, lastLoginAt) VALUES (?, 'https://ops', 'a1', 'Zero Dark Ops', 'Anna', 'Alfa', 0, 0)", anna.id);
  const st = St.requestCouncil(anna);
  assert.ok(st.requestedAt);
  assert.equal(St.pendingCount(), 1);
  assert.equal(St.councilList().requests[0].ops[0].squadra, 'Alfa');
  // Accettata con Test armi e Lancio doni (le chiavi sconosciute si scartano).
  const u = St.acceptCouncil(anna.id, ['armi', 'doni', 'boh'], 'master');
  assert.equal(u.role, 'validator');
  assert.deepEqual(u.perms, ['armi', 'doni']);
  assert.equal(St.pendingCount(), 0);
  assert.equal(St.can(u, 'armi'), true);
  assert.equal(St.can(u, 'soglia'), false);
  // Il master cambia le azioni; poi le dà la regia completa.
  const me = St.staffOf(mario.id);
  assert.deepEqual(St.setCouncilPerms(u.id, { perms: ['soglia'] }, me, 'master').perms, ['soglia']);
  assert.equal(St.setCouncilPerms(u.id, { master: true }, me, 'master').role, 'master');
  assert.equal(St.can(St.staffOf(anna.id), 'campo'), true);
  assert.throws(() => St.setCouncilPerms(me.id, { master: false }, me, 'master'), /da solo/);
  assert.throws(() => St.requestCouncil(anna), /già nel Consiglio/);
});

test('i validatori di prima restano con Soglia, Accettazione e Test armi', () => {
  assert.deepEqual(St.permsOf({ role: 'validator', perms: null }).sort(), ['accettazione', 'armi', 'soglia']);
  assert.deepEqual(St.permsOf({ role: 'validator', perms: '[]' }), []);
  assert.equal(St.homeOf('validator'), '/consiglio');
});

test('chi è in attesa in una partita può entrare nel Consiglio: lascia l\'iscrizione da giocatore', () => {
  const gid = Number(q.run("INSERT INTO games (name, status, createdAt) VALUES ('Attesa', 'draft', ?)", Date.now()).lastInsertRowid);
  const luca = A.register({ username: 'lucaattesa', password: 'password1', name: 'Luca Neri', softairTeam: 'nessuno' });
  const pid = Number(q.run("INSERT INTO players (gameId, name, accountId, status, createdAt) VALUES (?, 'Luca Neri', ?, 'pending', ?)", gid, luca.id, Date.now()).lastInsertRowid);
  const u = St.acceptCouncil(luca.id, ['armi'], 'master', pid);
  assert.equal(u.role, 'validator');
  assert.equal(q.get('SELECT 1 FROM players WHERE id = ?', pid), undefined);
});
