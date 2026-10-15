'use strict';
// «Accedi con il gestionale»: i giocatori entrano con l'account di Zero Dark Ops (OpenID Connect, authorization
// code con PKCE S256; vedi docs/IDENTITA.md di team-management). L'identità è la coppia (iss, sub): un account
// del gioco può avere più gestionali collegati, ogni (iss, sub) appartiene a un solo account.
const crypto = require('crypto');
const { q, tx, getSetting, setSetting } = require('./db');
const G = require('./game');
const { randomToken, randomCode, HttpError } = require('./util');

const err = (status, msg) => new HttpError(status, msg);
const SCOPE = 'openid profile squadra';
const FLOW_TTL = 10 * 60000;
const CACHE_TTL = 3600000;
const CLOCK_SKEW = 120;

// ---- gestionali configurati: uno dal file .env (OPS_*), gli altri aggiunti dalla regia

function envProvider() {
  if (!process.env.OPS_ISSUER || !process.env.OPS_CLIENT_ID) return null;
  return {
    id: 'ops', name: process.env.OPS_NAME || 'Zero Dark Ops', issuer: normIssuer(process.env.OPS_ISSUER),
    clientId: process.env.OPS_CLIENT_ID, clientSecret: process.env.OPS_CLIENT_SECRET || '', fromEnv: true,
  };
}
function savedProviders() {
  try { return JSON.parse(getSetting('opsProviders') || '[]'); } catch { return []; }
}
function providers() {
  const env = envProvider();
  return [...(env ? [env] : []), ...savedProviders().filter((p) => !env || p.id !== env.id)];
}
function provider(id) {
  const p = providers().find((x) => x.id === id);
  if (!p) throw err(404, 'Gestionale non configurato');
  return p;
}

function normIssuer(raw) {
  const v = String(raw || '').trim().replace(/\/+$/, '');
  let u;
  try { u = new URL(v); } catch { throw err(400, 'Indirizzo del gestionale non valido: es. https://ops.zerodarkteam.it'); }
  const local = /^(localhost|127\.|\[::1\])/.test(u.host);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw err(400, "L'indirizzo del gestionale deve essere https://");
  if (u.search || u.hash) throw err(400, 'Indirizzo del gestionale senza parametri: es. https://ops.zerodarkteam.it');
  return v;
}

// Elenco per i pulsanti di accesso (senza dati riservati).
const publicList = () => providers().map((p) => ({ id: p.id, name: p.name, issuer: p.issuer }));
// Elenco per la regia: il segreto non torna mai indietro.
const adminList = () => providers().map(({ clientSecret, ...p }) => ({ ...p, hasSecret: !!clientSecret }));

function saveProvider(data, actor) {
  const list = savedProviders();
  const existing = data.id ? list.find((p) => p.id === data.id) : null;
  if (data.id && !existing) throw err(data.id === 'ops' ? 409 : 404, data.id === 'ops' ? 'Questo gestionale è nel file .env: si cambia da lì' : 'Gestionale non trovato');
  const name = String(data.name || '').trim().slice(0, 40) || 'Zero Dark Ops';
  const issuer = normIssuer(data.issuer);
  const clientId = String(data.clientId || '').trim();
  if (!clientId) throw err(400, 'Manca il client_id dato dal gestionale');
  // Segreto: vuoto = resta quello di prima; "-" lo toglie (app senza segreto, solo PKCE).
  const secretIn = data.clientSecret === undefined ? '' : String(data.clientSecret).trim();
  const clientSecret = secretIn === '-' ? '' : secretIn || existing?.clientSecret || '';
  if (providers().some((p) => p.issuer === issuer && p.id !== existing?.id)) throw err(409, 'Questo gestionale è già configurato');
  const p = { id: existing?.id || randomCode(6).toLowerCase(), name, issuer, clientId, clientSecret };
  setSetting('opsProviders', JSON.stringify(existing ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]));
  discovery.delete(issuer);
  G.log(null, actor, existing ? 'ops_provider_changed' : 'ops_provider_added', { name, issuer });
  return { id: p.id };
}

function deleteProvider(id, actor) {
  const list = savedProviders();
  const p = list.find((x) => x.id === id);
  if (!p) throw err(id === 'ops' ? 409 : 404, id === 'ops' ? 'Questo gestionale è nel file .env: si toglie da lì' : 'Gestionale non trovato');
  setSetting('opsProviders', JSON.stringify(list.filter((x) => x.id !== id)));
  G.log(null, actor, 'ops_provider_removed', { name: p.name, issuer: p.issuer });
}

// ---- configurazione e chiavi del gestionale (in cache per un'ora)

const discovery = new Map();
const jwksCache = new Map();

async function getJson(url, init) {
  let res;
  try { res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) }); } catch { throw err(502, 'Il gestionale non risponde: riprova tra poco'); }
  let data = null;
  try { data = await res.json(); } catch { /* non JSON */ }
  return { res, data };
}

async function config(p) {
  const hit = discovery.get(p.issuer);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.cfg;
  const { res, data } = await getJson(`${p.issuer}/.well-known/openid-configuration`);
  if (!res.ok || !data?.authorization_endpoint || !data?.token_endpoint || !data?.jwks_uri) throw err(502, 'Configurazione del gestionale non valida');
  if (String(data.issuer).replace(/\/+$/, '') !== p.issuer) throw err(502, "Il gestionale dichiara un indirizzo diverso da quello configurato");
  discovery.set(p.issuer, { at: Date.now(), cfg: data });
  return data;
}

async function signingKey(cfg, kid) {
  const find = (keys) => keys.find((k) => k.kty === 'RSA' && (!kid || k.kid === kid) && (!k.use || k.use === 'sig'));
  const hit = jwksCache.get(cfg.jwks_uri);
  let jwk = hit && Date.now() - hit.at < CACHE_TTL ? find(hit.keys) : null;
  if (!jwk) {
    // Chiave sconosciuta: il gestionale potrebbe averle ruotate, si riscaricano.
    const { res, data } = await getJson(cfg.jwks_uri);
    if (!res.ok || !Array.isArray(data?.keys)) throw err(502, 'Chiavi del gestionale non disponibili');
    jwksCache.set(cfg.jwks_uri, { at: Date.now(), keys: data.keys });
    jwk = find(data.keys);
  }
  if (!jwk) throw err(502, 'Chiave di firma del gestionale non trovata');
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

// Verifica dell'id_token: firma RS256, emittente, destinatario, scadenza e nonce.
async function verifyIdToken(p, cfg, token, nonce) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw err(502, 'Risposta del gestionale non valida');
  let header, claims;
  try { header = b64json(parts[0]); claims = b64json(parts[1]); } catch { throw err(502, 'Risposta del gestionale non valida'); }
  if (header.alg !== 'RS256') throw err(502, 'Firma del gestionale non supportata');
  const key = await signingKey(cfg, header.kid);
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw err(502, 'Firma del gestionale non valida');
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (String(claims.iss).replace(/\/+$/, '') !== p.issuer) throw err(502, 'Il gestionale ha risposto a nome di un altro');
  if (!aud.includes(p.clientId) || (aud.length > 1 && claims.azp !== p.clientId)) throw err(502, 'Risposta del gestionale destinata a un\'altra app');
  if (!(claims.exp > now - CLOCK_SKEW)) throw err(502, 'Risposta del gestionale scaduta: riprova');
  if (claims.iat && claims.iat > now + CLOCK_SKEW) throw err(502, 'Orologio del gestionale non allineato');
  if (claims.nonce !== nonce) throw err(502, 'Risposta del gestionale non attesa: riprova');
  if (!claims.sub) throw err(502, 'Il gestionale non ha indicato chi sei');
  return claims;
}

// ---- il giro: avvio → gestionale → ritorno

const flows = new Map();
function pruneFlows() {
  const now = Date.now();
  for (const [k, f] of flows) if (now - f.at > FLOW_TTL) flows.delete(k);
}

/**
 * Prepara l'accesso: torna l'indirizzo del gestionale e lo state da legare al browser (cookie).
 * mode 'login' entra (o crea l'account), 'link' collega il gestionale all'account già aperto.
 */
async function start(id, { mode, accountId, redirectUri, back }) {
  const p = provider(id);
  const cfg = await config(p);
  if (cfg.code_challenge_methods_supported && !cfg.code_challenge_methods_supported.includes('S256')) throw err(502, 'Il gestionale non supporta PKCE S256');
  pruneFlows();
  const state = randomToken(24);
  const nonce = randomToken(24);
  const verifier = randomToken(48);
  flows.set(state, { at: Date.now(), providerId: p.id, issuer: p.issuer, nonce, verifier, mode, accountId: accountId || null, redirectUri, back });
  const url = new URL(cfg.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: p.clientId, redirect_uri: redirectUri, scope: SCOPE, state, nonce,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  }).toString();
  return { url: url.toString(), state };
}

/** Ritorno dal gestionale: scambia il codice, verifica l'id_token e torna i dati della persona. */
async function finish(state, cookieState, query) {
  const f = flows.get(state);
  flows.delete(state);
  if (!f || state !== cookieState || Date.now() - f.at > FLOW_TTL) throw err(400, 'Accesso scaduto o aperto da un altro browser: riprova');
  const fail = (msg) => Object.assign(err(400, msg), { flow: f });
  if (query.error) {
    throw fail(query.error === 'access_denied' ? 'Accesso annullato: il permesso non è stato dato' : `Il gestionale ha rifiutato l'accesso (${String(query.error).slice(0, 40)})`);
  }
  const p = providers().find((x) => x.id === f.providerId && x.issuer === f.issuer);
  if (!p) throw fail('Gestionale non più configurato');
  // Difesa dal mix-up fra gestionali: se il gestionale dice chi è, deve essere quello da cui si è partiti.
  if (query.iss && String(query.iss).replace(/\/+$/, '') !== p.issuer) throw fail('Risposta da un gestionale diverso: riprova');
  if (!query.code) throw fail('Risposta del gestionale senza codice');
  const cfg = await config(p);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: String(query.code), redirect_uri: f.redirectUri, code_verifier: f.verifier });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  const methods = cfg.token_endpoint_auth_methods_supported || ['client_secret_basic'];
  if (p.clientSecret && methods.includes('client_secret_basic')) {
    headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(p.clientId)}:${encodeURIComponent(p.clientSecret)}`).toString('base64')}`;
  } else {
    body.set('client_id', p.clientId);
    if (p.clientSecret) body.set('client_secret', p.clientSecret);
  }
  const { res, data } = await getJson(cfg.token_endpoint, { method: 'POST', headers, body });
  if (!res.ok || !data?.id_token) throw fail(`Il gestionale non ha confermato l'accesso${data?.error ? ` (${String(data.error).slice(0, 40)})` : ''}`);
  const claims = await verifyIdToken(p, cfg, data.id_token, f.nonce);
  // Nome, callsign e squadra: dall'id_token e, se c'è, dal userinfo (stessa persona).
  let info = {};
  if (cfg.userinfo_endpoint && data.access_token) {
    const u = await getJson(cfg.userinfo_endpoint, { headers: { Authorization: `Bearer ${data.access_token}`, Accept: 'application/json' } }).catch(() => null);
    if (u?.res.ok && u.data?.sub === claims.sub) info = u.data;
  }
  return { flow: f, provider: p, claims: { ...info, ...claims } };
}

// ---- account collegati

function profileOf(c) {
  const name = String(c.name || [c.given_name, c.family_name].filter(Boolean).join(' ') || c.preferred_username || '').trim().slice(0, 80);
  const callsign = String(c.preferred_username || '').trim().slice(0, 40);
  return {
    name: name || 'Operatore', nickname: callsign && callsign !== name ? callsign : null,
    squadra: String(c.squadra?.nome || '').trim().slice(0, 60) || null,
  };
}

function uniqueUsername(c) {
  const base = String(c.preferred_username || c.given_name || c.name || 'operatore')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '.').replace(/^[._-]+|[._-]+$/g, '').slice(0, 24) || 'operatore';
  const stem = base.length < 3 ? `${base}.ops` : base;
  const taken = (u) => q.get('SELECT 1 FROM accounts WHERE username = ?', u) || q.get('SELECT 1 FROM users WHERE lower(username) = ?', u);
  if (!taken(stem)) return stem;
  for (let i = 2; i < 1000; i++) if (!taken(`${stem}${i}`)) return `${stem}${i}`;
  return `${stem}.${randomCode(4).toLowerCase()}`;
}

function identityRow(p, claims) {
  return q.get('SELECT * FROM account_identities WHERE iss = ? AND sub = ?', p.issuer, String(claims.sub));
}

function touch(id, p, claims) {
  const pr = profileOf(claims);
  q.run('UPDATE account_identities SET providerName = ?, opsName = ?, squadra = ?, lastLoginAt = ? WHERE id = ?', p.name, pr.name, pr.squadra, Date.now(), id);
}

/**
 * Persona tornata dal gestionale → account del gioco. Torna { account, created, linked }.
 * - (iss, sub) già collegato: quell'account;
 * - collegamento chiesto da un account aperto: si collega a lui;
 * - altrimenti nasce un account nuovo con nome, callsign e squadra del gestionale (senza password).
 */
function resolveAccount({ flow, provider: p, claims }, currentAccountId) {
  return tx(() => {
    const known = identityRow(p, claims);
    if (flow.mode === 'link') {
      if (!flow.accountId || flow.accountId !== currentAccountId) throw Object.assign(err(401, 'Accedi di nuovo al tuo account e ripeti il collegamento'), { flow });
      if (known && known.accountId !== flow.accountId) throw Object.assign(err(409, `Questo account di ${p.name} è già collegato a un altro account dei Giochi`), { flow });
      if (!known && q.get('SELECT 1 FROM account_identities WHERE accountId = ? AND iss = ?', flow.accountId, p.issuer)) {
        throw Object.assign(err(409, `Il tuo account è già collegato a un'altra persona di ${p.name}: scollegala prima`), { flow });
      }
      if (known) touch(known.id, p, claims);
      else addIdentity(flow.accountId, p, claims);
      const account = q.get('SELECT * FROM accounts WHERE id = ?', flow.accountId);
      G.log(null, account.username, 'account_ops_linked', { gestionale: p.name });
      return { account, linked: true };
    }
    if (known) {
      touch(known.id, p, claims);
      return { account: q.get('SELECT * FROM accounts WHERE id = ?', known.accountId) };
    }
    const pr = profileOf(claims);
    const username = uniqueUsername(claims);
    const id = Number(q.run('INSERT INTO accounts (username, passHash, name, nickname, softairTeam, phone, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      username, '', pr.name, pr.nickname, pr.squadra || 'nessuno', null, Date.now()).lastInsertRowid);
    addIdentity(id, p, claims);
    G.log(null, username, 'account_created', { gestionale: p.name });
    return { account: q.get('SELECT * FROM accounts WHERE id = ?', id), created: true };
  });
}

function addIdentity(accountId, p, claims) {
  const pr = profileOf(claims);
  const now = Date.now();
  q.run('INSERT INTO account_identities (accountId, iss, sub, providerName, opsName, squadra, createdAt, lastLoginAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    accountId, p.issuer, String(claims.sub), p.name, pr.name, pr.squadra, now, now);
}

const identitiesOf = (accountId) => q.all('SELECT id, iss, providerName, opsName, squadra, createdAt, lastLoginAt FROM account_identities WHERE accountId = ? ORDER BY id', accountId);

// Scollega: chi non ha una password non può togliere l'ultimo modo per rientrare.
function unlink(account, identityId) {
  const row = q.get('SELECT * FROM account_identities WHERE id = ? AND accountId = ?', Number(identityId), account.id);
  if (!row) throw err(404, 'Collegamento non trovato');
  const others = q.get('SELECT COUNT(*) AS n FROM account_identities WHERE accountId = ? AND id != ?', account.id, row.id).n;
  if (!account.passHash && !others) throw err(409, 'Prima imposta una password: senza, non potresti più entrare');
  q.run('DELETE FROM account_identities WHERE id = ?', row.id);
  G.log(null, account.username, 'account_ops_unlinked', { gestionale: row.providerName });
}

module.exports = { providers, publicList, adminList, saveProvider, deleteProvider, start, finish, resolveAccount, identitiesOf, unlink, verifyIdToken, profileOf, uniqueUsername };
