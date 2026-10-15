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
