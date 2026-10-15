'use strict';
// «Accedi con Zero Dark Ops»: giro OpenID Connect completo contro un finto gestionale locale.
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zdg-ops-test-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const { q } = require('../src/db');
const A = require('../src/accounts');
const O = require('../src/ops');

// ---- finto gestionale: discovery, jwks, token (verifica PKCE e segreto), userinfo
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const codes = new Map();
let issuer;
let person = { sub: 'ckx-1', name: 'Mario Rossi', preferred_username: 'Falco', squadra: { nome: 'Zero Dark Team' } };
let tamper = null;

function sign(claims, key = privateKey) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${enc(claims)}`;
  return `${head}.${crypto.sign('RSA-SHA256', Buffer.from(head), key).toString('base64url')}`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, issuer);
  const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/.well-known/openid-configuration') {
    return json(200, {
      issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, jwks_uri: `${issuer}/oauth/jwks`,
      userinfo_endpoint: `${issuer}/oauth/userinfo`, code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    });
  }
  if (url.pathname === '/oauth/jwks') return json(200, { keys: [jwk] });
  if (url.pathname === '/oauth/userinfo') return json(200, { sub: person.sub, email: 'mario@example.it' });
  if (url.pathname === '/oauth/token') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = new URLSearchParams(body);
      const c = codes.get(p.get('code'));
      codes.delete(p.get('code'));
      const auth = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString();
      if (auth !== 'giochi:segreto') return json(401, { error: 'invalid_client' });
      if (!c || crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url') !== c.challenge || p.get('redirect_uri') !== c.redirectUri) return json(400, { error: 'invalid_grant' });
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: issuer, aud: 'giochi', sub: person.sub, nonce: c.nonce, iat: now, exp: now + 300, name: person.name, preferred_username: person.preferred_username, squadra: person.squadra };
      json(200, { access_token: 'at', token_type: 'Bearer', id_token: tamper ? tamper(claims) : sign(claims) });
    });
    return;
  }
  json(404, {});
});

// Il browser: segue il redirect verso il gestionale, che «approva» e rimanda indietro con code e state.
function authorize(startUrl) {
  const u = new URL(startUrl);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.match(u.searchParams.get('scope'), /openid/);
  const code = crypto.randomBytes(8).toString('hex');
  codes.set(code, { challenge: u.searchParams.get('code_challenge'), nonce: u.searchParams.get('nonce'), redirectUri: u.searchParams.get('redirect_uri') });
  return { code, state: u.searchParams.get('state') };
}
async function login(mode = 'login', accountId = null) {
  const { url, state } = await O.start(id, { mode, accountId, redirectUri: 'http://localhost:8090/auth/ops/callback', back: 'app' });
  const back = authorize(url);
  assert.equal(back.state, state);
  return O.resolveAccount(await O.finish(back.state, state, { code: back.code }), accountId);
}

let id;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://localhost:${server.address().port}`;
  id = O.saveProvider({ name: 'Zero Dark Ops', issuer, clientId: 'giochi', clientSecret: 'segreto' }, 'test').id;
});
test.after(() => server.close());

test('primo accesso: nasce un account senza password con nome, callsign e squadra', async () => {
  const r = await login();
  assert.equal(r.created, true);
  assert.equal(r.account.username, 'falco');
  assert.equal(r.account.name, 'Mario Rossi');
  assert.equal(r.account.nickname, 'Falco');
  assert.equal(r.account.softairTeam, 'Zero Dark Team');
  assert.equal(r.account.passHash, '');
  assert.equal(A.authenticate('falco', ''), null);
  const pub = A.publicAccount(r.account);
  assert.equal(pub.hasPassword, false);
  assert.equal(pub.ops[0].providerName, 'Zero Dark Ops');
  // Il segreto non torna alla regia.
  assert.equal(O.adminList()[0].clientSecret, undefined);
  assert.equal(O.adminList()[0].hasSecret, true);
});

test('secondo accesso: stesso (iss, sub) → stesso account', async () => {
  const r = await login();
  assert.equal(r.created, undefined);
  assert.equal(r.account.username, 'falco');
  assert.equal(q.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
});

test('senza password non si scollega l\'ultimo gestionale; con la password sì', async () => {
  const a = q.get("SELECT * FROM accounts WHERE username = 'falco'");
  const iid = A.publicAccount(a).ops[0].id;
  assert.throws(() => O.unlink(a, iid), /password/);
  A.updateProfile(a, { password: 'nuovapassword' });
  const withPass = q.get('SELECT * FROM accounts WHERE id = ?', a.id);
  assert.ok(A.authenticate('falco', 'nuovapassword'));
  O.unlink(withPass, iid);
  assert.equal(A.publicAccount(withPass).ops.length, 0);
});

test('collegamento a un account esistente, poi si entra da lì', async () => {
  const mine = A.register({ username: 'luca', password: 'password1', name: 'Luca Bianchi', softairTeam: 'nessuno' });
  person = { sub: 'ckx-2', name: 'Luca Bianchi', preferred_username: 'Orso', squadra: { nome: 'Zero Dark Team' } };
  // Il collegamento vale solo se l'account aperto al ritorno è lo stesso che l'ha chiesto.
  await assert.rejects(login('link', null), /Accedi di nuovo/);
  const r = await login('link', mine.id);
  assert.equal(r.linked, true);
  assert.equal(r.account.id, mine.id);
  const again = await login();
  assert.equal(again.account.id, mine.id);
  // Lo stesso account del gestionale non si collega a un secondo account dei Giochi.
  const other = A.register({ username: 'altro', password: 'password1', name: 'Altro', softairTeam: 'nessuno' });
  await assert.rejects(login('link', other.id), /già collegato/);
});

test('username già preso: si aggiunge un numero', async () => {
  person = { sub: 'ckx-3', name: 'Paolo Verdi', preferred_username: 'Luca' };
  const r = await login();
  assert.equal(r.account.username, 'luca2');
  assert.equal(r.account.softairTeam, 'nessuno');
});

test('id_token non valido o state sbagliato: niente accesso', async () => {
  person = { sub: 'ckx-4', name: 'Intruso' };
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  for (const [t, re] of [
    [(c) => sign(c, other), /Firma/],
    [(c) => sign({ ...c, aud: 'altra-app' }), /un'altra app/],
    [(c) => sign({ ...c, nonce: 'x' }), /non attesa/],
    [(c) => sign({ ...c, exp: 1 }), /scaduta/],
    [(c) => sign({ ...c, iss: 'https://falso.example' }), /a nome di un altro/],
  ]) {
    tamper = t;
    await assert.rejects(login(), re);
  }
  tamper = null;
  const { url, state } = await O.start(id, { mode: 'login', redirectUri: 'http://localhost:8090/auth/ops/callback', back: 'app' });
  const back = authorize(url);
  await assert.rejects(O.finish(back.state, 'altro-browser', { code: back.code }), /altro browser/);
  // Lo state si usa una volta sola.
  await assert.rejects(O.finish(back.state, state, { code: back.code }), /scaduto/);
  assert.equal(q.get("SELECT COUNT(*) AS n FROM accounts WHERE name = 'Intruso'").n, 0);
});

test('il gestionale rifiuta o risponde un altro emittente', async () => {
  const s1 = await O.start(id, { mode: 'login', redirectUri: 'http://localhost:8090/auth/ops/callback', back: 'iscrizione' });
  const err = await O.finish(s1.state, s1.state, { error: 'access_denied' }).catch((e) => e);
  assert.match(err.message, /annullato/);
  assert.equal(err.flow.back, 'iscrizione');
  const s2 = await O.start(id, { mode: 'login', redirectUri: 'http://localhost:8090/auth/ops/callback', back: 'app' });
  await assert.rejects(O.finish(s2.state, s2.state, { code: 'x', iss: 'https://falso.example' }), /diverso/);
});

test('configurazione dalla regia: https obbligatorio, niente doppioni', () => {
  assert.throws(() => O.saveProvider({ issuer: 'http://ops.example.it', clientId: 'x' }, 'test'), /https/);
  assert.throws(() => O.saveProvider({ issuer, clientId: 'x' }, 'test'), /già configurato/);
  const p = O.saveProvider({ name: 'Squadra Ospite', issuer: 'https://ops.ospiti.example', clientId: 'x' }, 'test');
  assert.equal(O.publicList().length, 2);
  O.deleteProvider(p.id, 'test');
  assert.equal(O.publicList().length, 1);
});
