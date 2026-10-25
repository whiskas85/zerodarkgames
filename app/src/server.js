'use strict';
const path = require('path');
// Versione dell'app (quella del service worker): se cambia mentre un telefono ha l'app aperta, gli si chiede di aggiornarla.
const APP_VERSION = (/VERSION = '([^']+)'/.exec(require('fs').readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8')) || [])[1] || null;
const express = require('express');
const QRCode = require('qrcode');
const { q, getSetting, setSetting } = require('./db');
const C = require('./constants');
const G = require('./game');
const rt = require('./realtime');
const { randomToken, hashPassword, verifyPassword, HttpError } = require('./util');
const print = require('./print');
const F = require('./field');
const A = require('./accounts');
const K = require('./combat');
const S = require('./skills');
const EV = require('./events');
const RP = require('./replay');
const Z = require('./zones');
const CK = require('./checkin');
const EM = require('./emergency');
const O = require('./ops');
const St = require('./staff');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COOKIE_USER = 'zdg_u';
const COOKIE_TEAM = 'zdg_t';
const COOKIE_OPS = 'zdg_ops';
const COOKIE_INVITE = 'zdg_inv';
const ONE_YEAR = 365 * 24 * 3600;

// ---------------------------------------------------------------- seed

function seed() {
  if (!q.get('SELECT 1 FROM sectors LIMIT 1')) {
    for (const s of C.SECTORS) q.run('INSERT INTO sectors (ord, roman, name, article, element, motto, color) VALUES (?, ?, ?, ?, ?, ?, ?)', s.ord, s.roman, s.name, s.article, s.element, s.motto, C.SECTOR_COLORS[(s.ord - 1) % C.SECTOR_COLORS.length]);
  }
  const user = process.env.MASTER_USER || 'master';
  const pass = process.env.MASTER_PASSWORD || 'cambiami';
  const existing = q.get('SELECT * FROM users WHERE username = ?', user);
  if (!existing) {
    q.run("INSERT INTO users (username, passHash, role, displayName, createdAt) VALUES (?, ?, 'master', 'Consiglio Zero', ?)", user, hashPassword(pass), Date.now());
    console.log(`Utente MASTER creato: ${user}`);
  } else if (process.env.MASTER_PASSWORD_RESET === '1') {
    q.run('UPDATE users SET passHash = ? WHERE id = ?', hashPassword(pass), existing.id);
    console.log(`Password MASTER reimpostata per ${user}`);
  }
  if (pass === 'cambiami') console.warn('ATTENZIONE: password MASTER di default. Imposta MASTER_PASSWORD nel file .env');
}

// ---------------------------------------------------------------- helper http

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isHttps(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function setCookie(req, res, name, value, maxAge = ONE_YEAR) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (isHttps(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

// Indirizzo usato in link e QR (cartelli, credenziali, iscrizione). Ordine: impostazione della regia,
// variabile PUBLIC_URL, indirizzo da cui è aperta la pagina.
function requestOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}
function baseUrl(req) {
  const fromSettings = getSetting('publicUrl');
  if (fromSettings) return fromSettings;
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  return requestOrigin(req);
}
function normalizeBaseUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  let u;
  try { u = new URL(/^https?:\/\//i.test(v) ? v : `http://${v}`); } catch { throw new HttpError(400, 'Indirizzo non valido: es. http://192.168.1.50:8090'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, "L'indirizzo deve iniziare con http:// o https://");
  if (u.pathname !== '/' || u.search || u.hash) throw new HttpError(400, 'Solo indirizzo e porta, senza percorso: es. http://192.168.1.50:8090');
  return u.origin;
}

const wrap = (fn) => async (req, res, next) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) { next(e); }
};

function newSession(kind, refId) {
  const token = randomToken(32);
  q.run('INSERT INTO sessions (token, kind, refId, createdAt) VALUES (?, ?, ?, ?)', token, kind, refId, Date.now());
  return token;
}

// La coppia della sessione con il nome del suo Settore (serve nei messaggi: «Il Settore X ha…»).
function teamRow(id, noElect = false) {
  return q.get(`SELECT t.*, s.name AS sectorName, s.roman, s.color AS sectorColor FROM teams t LEFT JOIN sectors s ON s.id = t.sectorId
                WHERE t.id = ?${noElect ? " AND t.kind != 'elect'" : ''}`, id);
}

function loadAuth(req, _res, next) {
  const c = cookies(req);
  if (c[COOKIE_USER]) {
    const s = q.get("SELECT * FROM sessions WHERE token = ? AND kind = 'user'", c[COOKIE_USER]);
    if (s) req.user = St.withPerms(q.get('SELECT id, username, role, displayName, perms FROM users WHERE id = ?', s.refId));
  }
  if (c[COOKIE_TEAM]) {
    const s = q.get("SELECT * FROM sessions WHERE token = ? AND kind IN ('team','player','account')", c[COOKIE_TEAM]);
    if (s?.kind === 'account') {
      // Account del giocatore: segue la sua iscrizione attuale (anteprima, coppia o Eletti).
      req.account = q.get('SELECT * FROM accounts WHERE id = ?', s.refId);
      req.player = req.account ? A.currentPlayer(req.account) : null;
      if (req.player?.teamId) req.team = teamRow(req.player.teamId);
    }
    // Gli Eletti entrano solo con l'accesso personale: le vecchie sessioni col codice comune non valgono più.
    if (s?.kind === 'team') req.team = teamRow(s.refId, true);
    if (s?.kind === 'player') {
      // Accesso personale: segue il giocatore; quando entra in una coppia o tra gli Eletti ne diventa un dispositivo.
      req.player = q.get('SELECT * FROM players WHERE id = ?', s.refId);
      if (req.player?.teamId) req.team = teamRow(req.player.teamId);
    }
  }
  // Account entrato con un invito del Consiglio: è anche master o validatore.
  if (!req.user && req.account) req.user = St.staffOf(req.account.id);
  next();
}

// Dopo l'accesso di un account: se il browser porta un invito del Consiglio lo si accetta.
// Torna l'utente dell'organizzazione (o null) e l'eventuale errore dell'invito.
function acceptPendingInvite(req, res, account) {
  const token = cookies(req)[COOKIE_INVITE];
  if (!token) return { staff: St.staffOf(account.id) };
  setCookie(req, res, COOKIE_INVITE, '', 0);
  try { return { staff: St.claimInvite(token, account) }; } catch (e) { return { staff: St.staffOf(account.id), inviteError: e.message }; }
}

const needMaster = (req, _res, next) => (req.user?.role === 'master' ? next() : next(new HttpError(401, 'Accesso riservato alla regia')));
const needStaff = (req, _res, next) => (req.user ? next() : next(new HttpError(401, 'Accesso riservato all\'organizzazione')));
// Azione del Consiglio Zero: il master le ha tutte, gli altri quelle che il master ha aperto loro (una basta).
const needPerm = (...perms) => (req, _res, next) => (!req.user ? next(new HttpError(401, 'Accesso riservato all\'organizzazione'))
  : perms.some((p) => St.can(req.user, p)) ? next() : next(new HttpError(403, 'Questa azione non ti è stata aperta dal Consiglio')));
const NOT_ACCEPTED = 'Non sei stato accettato all\'arrivo: non puoi partecipare alla partita. Presentati al Consiglio.';
const needTeam = (req, _res, next) => {
  if (!req.team) return next(new HttpError(req.player ? 403 : 401, req.player ? 'Disponibile quando il Consiglio vi avrà assegnato il Settore' : 'Accesso coppia richiesto'));
  // A gioco iniziato chi non è stato accettato all'arrivo non partecipa.
  if (G.notAccepted(G.getGame(req.team.gameId), req.player, req.team)) return next(new HttpError(403, NOT_ACCEPTED));
  next();
};
const needMember = (req, _res, next) => (req.team || req.player || req.account ? next() : next(new HttpError(401, 'Accesso richiesto')));
const actor = (req) => req.user?.username || 'regia';

// Limite tecnico anti-abuso: 30 richieste al minuto per coppia sulle azioni.
const hits = new Map();
function teamRateLimit(req, _res, next) {
  const now = Date.now();
  const arr = (hits.get(req.team.id) || []).filter((t) => now - t < 60000);
  if (arr.length >= 30) return next(new HttpError(429, 'Troppe richieste: aspettate qualche secondo'));
  arr.push(now);
  hits.set(req.team.id, arr);
  next();
}

// Limite sui tentativi di login per IP.
const loginHits = new Map();
function loginLimit(req, _res, next) {
  const key = req.ip;
  const now = Date.now();
  const arr = (loginHits.get(key) || []).filter((t) => now - t < 10 * 60000);
  if (arr.length >= 20) return next(new HttpError(429, 'Troppi tentativi: riprova tra qualche minuto'));
  arr.push(now);
  loginHits.set(key, arr);
  next();
}

// ---------------------------------------------------------------- app

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use(loadAuth);

// Aperto anche da altri indirizzi: la regia lo usa per provare se l'indirizzo dei QR risponde.
app.get('/api/health', (_req, res) => { res.set('Access-Control-Allow-Origin', '*'); res.json({ ok: true, env: process.env.ZDG_ENV || 'production' }); });
app.get('/api/time', (_req, res) => res.json({ now: Date.now() }));

// ---- autenticazione staff
// Un solo accesso per tutti: la regia (master e validatori) va in regia o alla Soglia, i giocatori nella loro app.
app.post('/api/auth/login', loginLimit, wrap((req, res) => {
  const name = String(req.body.username || '').trim();
  const u = q.get('SELECT * FROM users WHERE username = ?', name) || q.get('SELECT * FROM users WHERE lower(username) = lower(?)', name);
  if (u && verifyPassword(req.body.password || '', u.passHash)) {
    setCookie(req, res, COOKIE_USER, newSession('user', u.id), 30 * 24 * 3600);
    G.log(null, u.username, 'login');
    return { id: u.id, username: u.username, role: u.role, displayName: u.displayName, home: St.homeOf(u.role) };
  }
  const a = A.authenticate(name, req.body.password);
  if (!a) throw new HttpError(401, 'Username o password non validi');
  setCookie(req, res, COOKIE_TEAM, newSession('account', a.id));
  const p = A.currentPlayer(a);
  if (p) G.log(p.gameId, `giocatore:${p.id}`, 'player_login', { playerId: p.id });
  const { staff, inviteError } = acceptPendingInvite(req, res, a);
  if (staff) return { role: staff.role, username: a.username, home: St.homeOf(staff.role), inviteError };
  return { role: 'player', username: a.username, home: '/#/home', inviteError };
}));
app.post('/api/auth/register', loginLimit, wrap((req, res) => {
  const a = A.register(req.body || {});
  setCookie(req, res, COOKIE_TEAM, newSession('account', a.id));
  const { staff, inviteError } = acceptPendingInvite(req, res, a);
  return { role: staff ? staff.role : 'player', username: a.username, home: staff ? St.homeOf(staff.role) : null, inviteError };
}));
// Link d'invito del Consiglio: con l'account già aperto si accetta subito, altrimenti si passa dal login principale.
app.get('/invito/:token', (req, res) => {
  if (!St.validInvite(req.params.token)) return res.redirect('/?invito=invalido');
  if (req.account) {
    try {
      const staff = St.claimInvite(req.params.token, req.account);
      return res.redirect(St.homeOf(staff.role));
    } catch { return res.redirect('/?invito=invalido'); }
  }
  setCookie(req, res, COOKIE_INVITE, req.params.token, 3600);
  res.redirect('/?invito=1');
});
// Partite aperte alle iscrizioni, con i posti liberi per coppie e temerari solitari.
const openGames = () => q.all("SELECT id, name, scheduledStart FROM games WHERE registrationOpen = 1 AND status = 'draft' ORDER BY id DESC")
  .map((g) => { const s = G.spotsOf(g.id); return { ...g, spots: { couples: s.couples, singles: s.singles } }; });
// Account del giocatore: profilo, iscrizioni, partite aperte; iscrizione a una partita.
const needAccount = (req, _res, next) => (req.account ? next() : next(new HttpError(401, 'Accedi con il tuo account')));
app.get('/api/account', needAccount, (req, res) => res.json({
  account: A.publicAccount(req.account),
  enrollments: A.enrollments(req.account),
  games: openGames(),
}));
app.patch('/api/account', needAccount, wrap((req) => { A.updateProfile(req.account, req.body || {}); return { ok: true }; }));
app.post('/api/account/enroll', needAccount, loginLimit, wrap((req) => A.enroll(req.account, req.body || {})));
// Gestionali collegati: il giocatore toglie un collegamento dal profilo.
app.delete('/api/account/ops/:iid', needAccount, wrap((req) => { O.unlink(req.account, req.params.iid); return { ok: true }; }));
// Consiglio Zero: chi è entrato con Zero Dark Ops chiede l'accesso; il master sceglie dalla regia cosa può fare.
app.get('/api/council', needAccount, (req, res) => res.json(St.councilStatus(req.account)));
app.post('/api/council/request', needAccount, wrap((req) => St.requestCouncil(req.account)));
app.delete('/api/council/request', needAccount, wrap((req) => St.withdrawCouncil(req.account)));

// ---- «Accedi con Zero Dark Ops» (OpenID Connect): /auth/ops/<gestionale> → gestionale → /auth/ops/callback
// ritorno: 'app' (/) o 'iscrizione'; collega=1 aggiunge il gestionale all'account già aperto.
const OPS_BACK = { app: '/', iscrizione: '/iscrizione' };
const opsRedirectUri = (req) => `${baseUrl(req)}/auth/ops/callback`;
const opsFail = (res, back, msg) => res.redirect(`${OPS_BACK[back] || '/'}?ops_errore=${encodeURIComponent(msg)}${back === 'iscrizione' ? '#profilo' : ''}`);
app.get('/api/public/ops', (_req, res) => res.json(O.publicList()));
app.get('/auth/ops/callback', loginLimit, async (req, res) => {
  const state = String(req.query.state || '');
  setCookie(req, res, COOKIE_OPS, '', 0);
  try {
    const done = await O.finish(state, cookies(req)[COOKIE_OPS], req.query);
    const r = O.resolveAccount(done, req.account?.id ?? null);
    const back = done.flow.back;
    if (!r.linked) setCookie(req, res, COOKIE_TEAM, newSession('account', r.account.id));
    if (r.linked) return res.redirect('/iscrizione?ops=collegato#profilo');
    const { staff, inviteError } = acceptPendingInvite(req, res, r.account);
    if (inviteError) return res.redirect(`/?ops_errore=${encodeURIComponent(inviteError)}`);
    if (staff) return res.redirect(St.homeOf(staff.role));
    const p = A.currentPlayer(r.account);
    if (p) G.log(p.gameId, `giocatore:${p.id}`, 'player_login', { playerId: p.id, gestionale: done.provider.name });
    // Account nuovo o senza iscrizione: si sceglie la sfida.
    if (r.created || back === 'iscrizione' || !p) return res.redirect(`/iscrizione${r.created ? '?ops=nuovo' : ''}#scelta`);
    res.redirect('/#/home');
  } catch (e) {
    if ((e.status || 500) >= 500 && !(e instanceof HttpError)) console.error(e);
    opsFail(res, e.flow?.back, e instanceof HttpError ? e.message : 'Accesso con il gestionale non riuscito');
  }
});
app.get('/auth/ops/:id', async (req, res) => {
  const back = OPS_BACK[req.query.ritorno] ? req.query.ritorno : 'app';
  // L'indirizzo di ritorno registrato nel gestionale è quello pubblico: il giro parte da lì (stesso host, stessi cookie).
  if (new URL(requestOrigin(req)).host !== new URL(baseUrl(req)).host && !req.query.collega) return res.redirect(`${baseUrl(req)}${req.originalUrl}`);
  try {
    const link = req.query.collega === '1';
    if (link && !req.account) throw new HttpError(401, 'Accedi al tuo account prima di collegare il gestionale');
    const { url, state } = await O.start(req.params.id, { mode: link ? 'link' : 'login', accountId: req.account?.id, redirectUri: opsRedirectUri(req), back });
    setCookie(req, res, COOKIE_OPS, state, 600);
    res.redirect(url);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    opsFail(res, back, e instanceof HttpError ? e.message : 'Accesso con il gestionale non riuscito');
  }
});

// Esci dalla regia o dalla Soglia: si chiude tutto (anche l'account) e si torna al login principale.
app.post('/api/auth/logout', wrap((req, res) => {
  const c = cookies(req);
  for (const name of [COOKIE_USER, COOKIE_TEAM]) {
    if (c[name]) q.run('DELETE FROM sessions WHERE token = ?', c[name]);
    setCookie(req, res, name, '', 0);
  }
  return { ok: true, home: '/' };
}));
app.get('/api/auth/me', (req, res) => res.json({ user: req.user || null, team: req.team ? { id: req.team.id } : null }));

// ---- iscrizione pubblica
app.get('/api/public/games', (_req, res) => res.json(openGames()));
// Data del prossimo evento per la pagina di login: la partita vera (non di prova, non finita) in programma.
app.get('/api/public/event', (_req, res) => {
  const g = q.all("SELECT name, scheduledStart FROM games WHERE isDemo = 0 AND status NOT IN ('ended', 'created') AND scheduledStart IS NOT NULL AND scheduledStart != ''")
    .map((x) => {
      const v = String(x.scheduledStart);
      const d = /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : Number.isFinite(Number(v)) ? new Date(Number(v)).toISOString().slice(0, 10) : null;
      return d ? { name: x.name, date: d } : null;
    }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date))[0];
  res.json(g || null);
});
// Le iscrizioni passano dall'account del giocatore (/api/auth/register + /api/account/enroll).

// ---- accesso coppie
// Un dispositivo entra come coppia/Eletti (codice della squadra) o come giocatore (codice personale).
function deviceLogin(req, res, kind, refId, gameId) {
  setCookie(req, res, COOKIE_TEAM, newSession(kind, refId));
  G.log(gameId, kind === 'team' ? `coppia:${refId}` : `giocatore:${refId}`, kind === 'team' ? 'team_login' : 'player_login', kind === 'team' ? { teamId: refId } : { playerId: refId });
  rt.toStaff(gameId, 'login');
}
function loginBy(field, value) {
  const t = q.get(`SELECT * FROM teams WHERE ${field} = ? AND kind != 'elect'`, value);
  if (t) return { kind: 'team', id: t.id, gameId: t.gameId };
  const p = q.get(`SELECT * FROM players WHERE ${field} = ?`, value);
  if (p) return { kind: 'player', id: p.id, gameId: p.gameId };
  return null;
}
app.get('/login/:token', (req, res) => {
  const who = loginBy('loginToken', req.params.token);
  if (!who) return res.redirect('/?login=invalid');
  deviceLogin(req, res, who.kind, who.id, who.gameId);
  res.redirect('/#/home');
});
app.post('/api/team/login', loginLimit, wrap((req, res) => {
  const code = String(req.body.accessCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const who = code && loginBy('accessCode', code);
  if (!who) throw new HttpError(401, 'Codice d\'accesso non valido');
  deviceLogin(req, res, who.kind, who.id, who.gameId);
  return { ok: true };
}));
app.post('/api/team/logout', wrap((req, res) => {
  const c = cookies(req);
  if (c[COOKIE_TEAM]) q.run('DELETE FROM sessions WHERE token = ?', c[COOKIE_TEAM]);
  setCookie(req, res, COOKIE_TEAM, '', 0);
  return { ok: true };
}));

// ---- API coppia
// La mappa della coppia per ATAK / Google Earth: solo ciò che vede nell'app.
app.get('/api/team/map.kmz', needTeam, (req, res, next) => { try { sendKmz(res, F.teamKmz(req.team)); } catch (e) { next(e); } });
// Voce «Consiglio Zero» nell'app: per chi è entrato con Zero Dark Ops o è già nell'organizzazione.
const councilFlag = (req) => !!req.account && (!!St.staffOf(req.account.id) || St.councilStatus(req.account).canRequest);
app.get('/api/team/state', needMember, wrap((req) => {
  if (!req.player && !req.team) return { noEnrollment: true, account: A.publicAccount(req.account), council: councilFlag(req) };
  // Partita finita e una nuova aperta alle iscrizioni: l'app invita a iscriversi.
  const openNew = req.account && G.getGame(req.player?.gameId ?? req.team.gameId).status === 'ended'
    && q.get("SELECT 1 FROM games g WHERE g.registrationOpen = 1 AND g.status = 'draft' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.gameId = g.id AND p.accountId = ?)", req.account.id);
  if (!req.team) return { ...G.lobbyState(req.player), guide: F.teamGuide(req.player.gameId), account: A.publicAccount(req.account), council: councilFlag(req), openNew: !!openNew, tracking: F.trackingStatus(q.get('SELECT * FROM players WHERE id = ?', req.player.id)) };
  const st = G.teamState(req.team, req.player);
  st.map = F.teamMap(req.team);
  st.guide = st.map?.guide || [];
  // Stato di Traccar Client per questa persona (il «flag» resta finché la prova non riesce).
  st.tracking = req.player ? F.trackingStatus(q.get('SELECT * FROM players WHERE id = ?', req.player.id)) : null;
  st.council = councilFlag(req);
  st.gifts = req.team.kind === 'couple' ? F.teamGifts(req.team) : [];
  st.combat = K.combatState(req.team);
  st.skills = S.skillsState(req.team);
  st.serverTimers = req.team.kind === 'couple' ? K.serverTimers(req.team.id) : [];
  st.events = EV.teamEvents(req.team, req.player);
  st.zones = Z.teamZones(req.team);
  if (req.team.kind === 'elect') st.field = F.electSummary(req.team, req.player);
  st.account = A.publicAccount(req.account);
  st.appVersion = APP_VERSION;
  st.openNew = !!openNew;
  return st;
}));
// Alleanze: proposta, accettazione/rifiuto, rottura (stesso schema). Scontri: vinto / perso / pareggio.
app.post('/api/team/alliance/request', needTeam, teamRateLimit, wrap((req) => K.requestAlliance(req.team, req.body.teamId, { diplomat: !!req.body.diplomat })));
app.post('/api/team/alliance/break', needTeam, teamRateLimit, wrap((req) => K.requestBreak(req.team, req.body.teamId)));
app.post('/api/team/alliance/:id/respond', needTeam, teamRateLimit, wrap((req) => K.respondRequest(req.team, req.params.id, !!req.body.accept, { diplomat: !!req.body.diplomat })));
app.post('/api/team/alliance/:id/cancel', needTeam, wrap((req) => K.cancelRequest(req.team, req.params.id)));
app.post('/api/team/engagement', needTeam, teamRateLimit, wrap((req) => K.reportEngagement(req.team, req.body.opponentTeamId, req.body.result, { skill: req.body.skill })));
app.post('/api/team/engagement/:id/steal', needTeam, teamRateLimit, wrap((req) => K.stealCode(req.team, req.params.id, req.body.sectorId)));
app.post('/api/team/engagement/:id/poison', needTeam, teamRateLimit, wrap((req) => K.poison(req.team, req.params.id)));
app.post('/api/team/engagement/:id/respond', needTeam, teamRateLimit, wrap((req) => K.respondEngagement(req.team, req.params.id, !!req.body.confirm, { skill: req.body.skill })));
// Posizione GPS del telefono (nessun limite di frequenza condiviso con le azioni: arriva ogni ~20 s).
const lastPos = new Map();
app.post('/api/team/position', needTeam, wrap((req) => {
  const key = String(req.body.deviceId || '');
  const now = Date.now();
  if (now - (lastPos.get(key) || 0) < 5000) return { ok: true, throttled: true };
  lastPos.set(key, now);
  return F.recordPosition(req.team, req.player, req.body || {});
}));
// Traccar Client (posizione anche con l'app chiusa o lo schermo spento): risponde sempre OK, altrimenti il
// telefono continua a riprovare all'infinito.
const lastTraccar = new Map();
app.all(['/api/traccar', '/api/traccar/'], express.urlencoded({ extended: false }), (req, res) => {
  const key = String(req.query.id || req.query.deviceid || req.body?.device_id || req.body?.id || req.ip);
  const now = Date.now();
  if (now - (lastTraccar.get(key) || 0) >= 5000) {
    lastTraccar.set(key, now);
    try { F.recordTraccar(req.query, req.body); } catch { /* posizione non valida: si ignora */ }
  }
  res.type('text').send('OK');
});
// Configurazione di Traccar Client per questo giocatore.
app.get('/api/team/tracking', needMember, wrap((req) => {
  if (!req.player) throw new HttpError(409, 'Entra con il tuo account o con il tuo codice personale per avere l\'identificativo');
  return { serverUrl: `${baseUrl(req)}/api/traccar`, ...F.trackingInfo(req.player, req.query.since) };
}));
// Fine della prova a schermo spento: se i segnali sono arrivati, Traccar è verificato.
app.post('/api/team/tracking/verify', needMember, wrap((req) => {
  if (!req.player) throw new HttpError(409, 'Entra con il tuo account o con il tuo codice personale');
  return { serverUrl: `${baseUrl(req)}/api/traccar`, ...F.verifyTracking(req.player, req.body?.since) };
}));
// EMERGENZA reale (OFF GAME): da qualunque telefono della partita, anche prima della coppia.
// Avviso di sicurezza pre-gara letto e compreso (per chi entra con l'accesso personale; con il codice di coppia resta sul telefono).
// Le mie repliche per il test: aggiungerne (anche più di tre) o togliere quelle che non ho (solo con l'accesso personale).
app.post('/api/team/weapons', needMember, wrap((req) => {
  if (!req.player) throw new HttpError(409, 'Serve il tuo accesso personale (non quello della coppia)');
  return CK.editWeapons(req.player.gameId, req.player.id, req.body || {}, `giocatore:${req.player.id}`);
}));
app.post('/api/team/safety-ack', needMember, wrap((req) => {
  if (req.player) q.run('UPDATE players SET safetyAckAt = COALESCE(safetyAckAt, ?) WHERE id = ?', Date.now(), req.player.id);
  return { ok: true };
}));
// Risposta a un sondaggio negli avvisi (anche da chi è ancora in anteprima, senza Settore).
app.post('/api/team/notices/:id/vote', needMember, wrap((req) => {
  if (!req.team && !req.player) throw new HttpError(403, 'Iscriviti a una partita per rispondere');
  return G.voteNotice(req.team, req.player, req.params.id, String(req.body?.choice || ''));
}));
// Avvisi visti nell'app: per la regia «letto da».
app.post('/api/team/notices/read', needMember, wrap((req) => G.readNotices(req.team, req.player, req.body?.ids)));
// Eventi: candidatura (anche dell'alleanza), ritiro, conferma della chiusura; gli Eletti custodi avviano e chiudono.
app.post('/api/team/events/:id/join', needTeam, wrap((req) => EV.joinEvent(req.team, req.player, req.params.id, { alliance: !!req.body?.alliance })));
app.post('/api/team/events/:id/leave', needTeam, wrap((req) => EV.leaveEvent(req.team, req.params.id)));
app.post('/api/team/events/:id/confirm', needTeam, wrap((req) => EV.confirmClose(req.team, req.params.id)));
const electWho = (req) => {
  const pl = req.player ? q.get('SELECT * FROM players WHERE id = ?', req.player.id) : null;
  return { player: pl, actor: pl ? `eletto:${pl.name}` : 'eletti' };
};
app.post('/api/team/events/:id/start', needTeam, wrap((req) => EV.startEvent(req.params.id, electWho(req))));
app.post('/api/team/events/:id/close', needTeam, wrap((req) => EV.closeEvent(req.params.id, electWho(req), req.body?.outcomes || {})));
app.post('/api/team/emergency', needMember, wrap((req) => {
  if (!req.team && !req.player) throw new HttpError(403, 'Entrate in una partita per chiamare la Direzione');
  return EM.fromApp(req.team, req.player, req.body || {});
}));
app.post('/api/team/exit', needTeam, teamRateLimit, wrap((req) => G.exfiltrate(req.team, req.body.token)));
app.post('/api/team/gift/claim', needTeam, teamRateLimit, wrap((req) => F.claimGift(req.team, req.body.token)));
app.post('/api/team/gift/:id/use', needTeam, teamRateLimit, wrap((req) => F.useGift(req.team, req.params.id, req.body || {})));
// Skill: scelta prima del via (tutta la coppia), uso a partita in corso.
app.post('/api/team/skill/:id/choose', needTeam, wrap((req) => S.chooseSkill(req.team, req.params.id, req.body.on !== false)));
app.post('/api/team/skill/:id/use', needTeam, teamRateLimit, wrap((req) => S.useSkill(req.team, req.params.id, req.body || {})));
app.get('/api/team/point/:qrToken', needTeam, wrap((req) => G.visitPoint(req.team, req.params.qrToken, req.query.at,
  req.query.lat != null ? { lat: req.query.lat, lng: req.query.lng, acc: req.query.acc } : null)));
app.post('/api/team/unlock', needTeam, teamRateLimit, wrap((req) => G.unlock(req.team, req.body.qrToken, req.body.code)));
app.post('/api/team/fragment', needTeam, teamRateLimit, wrap((req) => G.addManualFragment(req.team, req.body.text)));
app.post('/api/team/note', needTeam, teamRateLimit, wrap((req) => G.addCodeNote(req.team, req.body.sectorId, req.body.code)));
// Gli Eletti scrivono a tutti gli Eletti (con la regia) oppure solo nella conversazione della propria squadra.
const msgSquad = (req, value) => {
  if (req.team.kind !== 'elect' || !value) return null;
  if (Number(value) !== req.player?.squadId) throw new HttpError(403, 'Puoi scrivere solo nella conversazione della tua squadra');
  return Number(value);
};
const msgAuthor = (req) => (req.team.kind === 'elect' && req.player ? req.player.nickname || req.player.name : null);
app.post('/api/team/message', needTeam, teamRateLimit, wrap((req) => G.postMessage(req.team, 'team', req.body.text, msgAuthor(req), null, msgSquad(req, req.body.squadId), req.player?.id ?? null)));
// Vocali: corpo binario (audio/*), durata in ?ms=. Massimo ~2 minuti.
const rawAudio = express.raw({ type: 'audio/*', limit: '4mb' });
app.post('/api/team/message/audio', needTeam, teamRateLimit, rawAudio, wrap((req) => G.postMessage(req.team, 'team', '', msgAuthor(req), { buffer: req.body, mime: req.headers['content-type'], ms: req.query.ms }, msgSquad(req, req.query.squadId), req.player?.id ?? null)));
app.get('/api/media/message/:id', (req, res, next) => {
  try {
    const a = G.messageAudio(req.params.id, { team: req.team, user: req.user });
    res.sendFile(a.file, { headers: { 'Content-Type': a.mime, 'Cache-Control': 'private, max-age=31536000' } });
  } catch (e) { next(e); }
});

// ---- push e stream
app.get('/api/push/key', (_req, res) => res.json({ publicKey: rt.publicKey() }));
app.post('/api/push/subscribe', wrap((req) => {
  const staff = req.query.as === 'staff';
  if (staff ? !req.user : !req.team && !req.player) throw new HttpError(401, 'Non autenticato');
  rt.saveSubscription(req.body.subscription, staff ? { userId: req.user.id }
    : req.player ? { playerId: req.player.id } : { teamId: req.team.id });
  return { ok: true };
}));

app.get('/api/stream', (req, res, next) => {
  const asStaff = req.query.as === 'staff';
  if (asStaff ? !req.user : !req.team && !req.player) return next(new HttpError(req.account ? 409 : 401, 'Non autenticato'));
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 4000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ now: Date.now() })}\n\n`);
  if (asStaff) rt.addClient({ res, kind: 'user', userId: req.user.id, role: req.user.role });
  else {
    const gameId = req.team?.gameId ?? req.player.gameId;
    // L'app dice se è installata e con quale versione (pagina Notifiche, Traccar e ICE della regia).
    if (req.player && req.query.v) {
      const ua = String(req.headers['user-agent'] || '');
      const os = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile/i.test(ua)) ? 'ios' : /Android/i.test(ua) ? 'android' : ua ? 'desktop' : null;
      q.run('UPDATE players SET appVersion = ?, appInstalled = ?, appSeenAt = ?, appOs = ? WHERE id = ?', String(req.query.v).slice(0, 20), req.query.inst === '1' ? 1 : 0, Date.now(), os, req.player.id);
    }
    rt.addClient({ res, kind: 'team', teamId: req.team?.id ?? null, gameId, playerId: req.player?.id ?? null });
    rt.toStaff(gameId, 'online');
    res.on('close', () => rt.toStaff(gameId, 'online'));
  }
});

// ---- strumento di campo (/campo): Master o Eletti, dal telefono
// Regia sul campo: il master e chi nel Consiglio Zero ha l'azione «Campo».
const fieldStaff = (req) => St.can(req.user, 'campo');
const needField = (req, _res, next) => {
  if (fieldStaff(req)) return next();
  if (req.team?.kind !== 'elect') return next(new HttpError(401, 'Riservato alla regia e agli Eletti del Consiglio'));
  if (G.notAccepted(G.getGame(req.team.gameId), req.player, req.team)) return next(new HttpError(403, NOT_ACCEPTED));
  next();
};
const fieldGame = (req) => {
  if (req.team?.kind === 'elect' && !fieldStaff(req)) return req.team.gameId;
  const id = Number(req.query.gameId || req.body?.gameId);
  if (!id) throw new HttpError(400, 'Partita non indicata');
  return id;
};
const fieldWho = (req) => (fieldStaff(req) ? req.user.username : `eletti:${req.player?.name || 'Eletti'}`);
const rawImage = express.raw({ type: 'image/*', limit: '10mb' });
app.get('/api/field/whoami', (req, res) => {
  if (fieldStaff(req)) return res.json({ role: 'master', regiaGameId: q.get('SELECT lastGameId FROM users WHERE id = ?', req.user.id)?.lastGameId || null, name: req.user.username, games: q.all("SELECT id, name, status FROM games WHERE status NOT IN ('ended', 'created') ORDER BY id DESC") });
  if (req.team?.kind === 'elect') {
    const squad = req.player?.squadId ? q.get('SELECT id, name, color FROM elect_squads WHERE id = ?', req.player.squadId) : null;
    return res.json({ role: 'elect', name: req.player?.name || 'Eletti del Consiglio', personal: !!req.player, squad, gameId: req.team.gameId, games: q.all('SELECT id, name, status FROM games WHERE id = ?', req.team.gameId) });
  }
  res.status(401).json({ error: 'Accesso riservato alla regia e agli Eletti' });
});
app.get('/api/field/state', needField, wrap((req) => F.fieldState(fieldGame(req))));
const sendKmz = (res, { name, data }) => {
  res.set({ 'Content-Type': 'application/vnd.google-earth.kmz', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
  res.send(data);
};
// Tutti i punti per ATAK / Google Earth (regia ed Eletti).
app.get('/api/field/export.kmz', needField, (req, res, next) => { try { sendKmz(res, F.orgKmz(fieldGame(req))); } catch (e) { next(e); } });
// Punti di interesse del campo.
app.post('/api/field/pois', needField, wrap((req) => F.createPoi(fieldGame(req), req.body || {}, fieldWho(req))));
app.patch('/api/field/pois/:id', needField, wrap((req) => F.updatePoi(req.params.id, fieldGame(req), req.body || {}, fieldWho(req))));
app.delete('/api/field/pois/:id', needField, wrap((req) => { F.deletePoi(req.params.id, fieldGame(req), fieldWho(req)); return { ok: true }; }));
app.post('/api/field/guide', needField, wrap((req) => F.createGuide(fieldGame(req), req.body || {}, fieldWho(req))));
app.patch('/api/field/guide/:id', needField, wrap((req) => F.updateGuide(req.params.id, fieldGame(req), req.body || {}, fieldWho(req))));
app.delete('/api/field/guide/:id', needField, wrap((req) => { F.deleteGuide(req.params.id, fieldGame(req), fieldWho(req)); return { ok: true }; }));
// Agli Eletti: gli altri Eletti e, finché un incarico della loro squadra è aperto, la coppia bersaglio.
app.get('/api/field/positions', needField, wrap((req) => (fieldStaff(req) ? F.positionsOf(fieldGame(req), 'master')
  : [...F.positionsOf(fieldGame(req), 'elect'), ...(req.player?.squadId ? F.taskTargetPositions(req.player.squadId) : [])])));
app.post('/api/field/tasks/:tid/done', needField, wrap((req) => { F.setTaskDone(req.params.tid, req.body.done !== false, fieldWho(req), fieldGame(req)); return { ok: true }; }));
app.get('/api/field/resolve', needField, wrap((req) => F.resolveToken(fieldGame(req), req.query.text, fieldStaff(req))));
// La regia può piazzare dalla mappa senza foto; dal telefono degli Eletti la foto di Altari e Doni resta obbligatoria.
const placement = (req) => ({ buffer: Buffer.isBuffer(req.body) ? req.body : null, mime: req.headers['content-type'], lat: req.query.lat, lng: req.query.lng, acc: req.query.acc, source: req.query.source, photoOptional: req.user?.role === 'master', provisional: req.query.provisional === '1' });
const placerSquad = (req) => req.player?.squadId || req.query.squadId || null;
app.post('/api/field/points/:id/place', needField, express.raw({ type: () => true, limit: '10mb' }), wrap((req) => F.placePoint(req.params.id, fieldGame(req), placement(req), fieldWho(req), placerSquad(req))));
// Soglia e Cerchio: foto facoltativa (corpo vuoto = senza foto).
app.post('/api/field/landmarks/:id/place', needField, express.raw({ type: () => true, limit: '10mb' }), wrap((req) => F.placeLandmark(req.params.id, fieldGame(req), placement(req), fieldWho(req), placerSquad(req))));
app.post('/api/field/gifts/:id/place', needField, express.raw({ type: () => true, limit: '10mb' }), wrap((req) => F.placeGift(req.params.id, fieldGame(req), placement(req), fieldWho(req), placerSquad(req))));
// Foto dei piazzamenti: solo organizzazione ed Eletti della partita.
const sendPhoto = (kind) => (req, res, next) => {
  try {
    const p = F.photoFile(kind, req.params.id);
    if (!req.user && !(req.team?.kind === 'elect' && req.team.gameId === p.gameId)) throw new HttpError(403, 'Non autorizzato');
    res.sendFile(p.file, { headers: { 'Cache-Control': 'private, max-age=31536000' } });
  } catch (e) { next(e); }
};
app.get('/api/media/point/:id', sendPhoto('point'));
app.get('/api/media/gift/:id', sendPhoto('gift'));
app.get('/api/media/landmark/:id', sendPhoto('landmark'));

// ---- API regia (MASTER)
const m = express.Router();
m.use(needMaster);
const gameId = (req) => Number(req.params.id);

// Notifiche della regia su questo dispositivo: stato, prova, spegnimento.
m.get('/push/status', wrap((req) => ({
  thisDevice: !!(req.query.endpoint && q.get('SELECT 1 FROM push_subs WHERE endpoint = ? AND userId = ?', String(req.query.endpoint), req.user.id)),
  devices: q.get('SELECT COUNT(*) AS n FROM push_subs WHERE userId = ?', req.user.id).n,
})));
m.post('/push/test', wrap(async (req) => ({ devices: await rt.pushUser(req.user.id, { title: 'Prova notifiche', body: 'Le notifiche della regia arrivano su questo dispositivo.', tag: 'push-test', url: '/regia' }) })));
m.post('/push/off', wrap((req) => {
  const ep = String(req.body?.endpoint || '');
  q.run('UPDATE push_subs SET userId = NULL WHERE endpoint = ? AND userId = ?', ep, req.user.id);
  q.run('DELETE FROM push_subs WHERE endpoint = ? AND userId IS NULL AND teamId IS NULL AND playerId IS NULL', ep);
  return { ok: true };
}));
m.get('/games/:id/push-report', wrap((req) => ({ ...G.pushReport(gameId(req)), currentVersion: APP_VERSION })));
m.get('/sectors', (_req, res) => res.json(G.sectorsAdmin()));
m.post('/sectors', wrap((req) => ({ id: G.saveSector(null, req.body || {}, actor(req)) })));
m.patch('/sectors/:sid', wrap((req) => ({ id: G.saveSector(Number(req.params.sid), req.body || {}, actor(req)) })));
m.delete('/sectors/:sid', wrap((req) => G.deleteSector(Number(req.params.sid), actor(req))));
m.post('/sectors/:sid/restore', wrap((req) => { G.restoreSector(Number(req.params.sid), actor(req)); return { ok: true }; }));
m.get('/games', (_req, res) => res.json(q.all('SELECT id, name, status, scheduledStart, createdAt FROM games ORDER BY id DESC')));
// Dalla regia una partita nuova nasce «Creata»: le app di campo la vedono da «In preparazione».
m.post('/games', wrap((req) => G.createGame({ ...(req.body || {}), status: 'created' }, actor(req))));
m.patch('/games/:id', wrap((req) => G.updateGame(gameId(req), req.body || {}, actor(req))));
m.delete('/games/:id', wrap((req) => { G.deleteGame(gameId(req), actor(req)); return { ok: true }; }));
m.post('/demo', wrap((req) => ({ id: G.createDemo(req.body.teams, actor(req)) })));
m.post('/games/:id/advance', wrap((req) => {
  const since = Date.now();
  G.advanceDemo(gameId(req), req.body.minutes, actor(req));
  // Ciò che il salto ha scavalcato parte al suo minuto previsto (poi i doni scaduti svaniscono).
  F.tickAll();
  G.settleDemoJump(gameId(req), since);
  F.tickAll();
  return { ok: true };
}));
m.get('/games/:id/state', wrap((req) => (q.run('UPDATE users SET lastGameId = ? WHERE id = ? AND coalesce(lastGameId, 0) != ?', gameId(req), req.user.id, gameId(req)), { ...G.masterState(gameId(req)), combat: K.masterCombat(gameId(req)), gameEvents: EV.masterEvents(gameId(req)), mapZones: Z.masterZones(gameId(req)), councilPending: St.pendingCount() })));
m.post('/engagements/:eid/resolve', wrap((req) => { K.resolveEngagement(req.params.eid, req.body.decision, actor(req)); return { ok: true }; }));
m.post('/games/:id/action', wrap((req) => { G.control(gameId(req), req.body.action, actor(req)); return { ok: true }; }));

// Giocatore aggiunto a mano dalla regia (già accettato), con il ruolo: Legato, Temerario solitario o Eletto.
m.post('/games/:id/players', wrap((req) => {
  const role = ['pair', 'single', 'elect'].includes(req.body?.role) ? req.body.role : null;
  const id = G.addPlayer(gameId(req), req.body || {}, { actor: actor(req), requestedRole: role });
  if (role === 'elect') G.addToElect(gameId(req), [id], actor(req));
  return { id };
}));
// Accettazione a inizio evento e test repliche.
// on assente con la sola checklist: si salvano le spunte senza cambiare l'accettazione.
const ckOn = (b) => (b?.on === undefined ? (b?.checks ? null : true) : b.on !== false);
m.post('/games/:id/checkin/player/:pid', wrap((req) => CK.setPlayerCheckin(gameId(req), req.params.pid, ckOn(req.body), actor(req), req.body?.checks || null)));
m.post('/games/:id/weapons/:pid', wrap((req) => CK.editWeapons(gameId(req), req.params.pid, req.body || {}, actor(req))));
m.post('/games/:id/chrono/:pid/live', wrap((req) => CK.setChronoLive(gameId(req), req.params.pid, req.body?.weapon, req.body?.readings, { open: req.body?.open !== false, grams: req.body?.grams })));
m.post('/games/:id/checkin/team/:tid', wrap((req) => CK.setTeamCheckin(gameId(req), req.params.tid, req.body?.on !== false, actor(req))));
m.post('/games/:id/place/:pid', wrap((req) => CK.placePlayer(gameId(req), req.params.pid, req.body || {}, actor(req))));
m.post('/games/:id/chrono/:pid/done', wrap((req) => CK.setChronoDone(gameId(req), req.params.pid, req.body?.on !== false, actor(req))));
m.post('/games/:id/chrono/:pid', wrap((req) => CK.setChrono(gameId(req), req.params.pid, req.body?.weapon, req.body?.on !== false, actor(req), req.body?.shot || null, req.body?.fail === true)));
m.post('/players/:pid/review', wrap((req) => G.reviewPlayer(Number(req.params.pid), req.body.decision, actor(req), { squadId: req.body.squadId })));
m.post('/games/:id/elect', wrap((req) => { G.addToElect(gameId(req), req.body.playerIds, actor(req)); return { ok: true }; }));
m.post('/games/:id/elect/person', wrap((req) => ({ id: G.addElectPerson(gameId(req), req.body || {}, actor(req)) })));
m.post('/players/:pid/move', wrap((req) => { G.movePlayer(Number(req.params.pid), req.body || {}, actor(req)); return { ok: true }; }));
m.delete('/elect/members/:pid', wrap((req) => { G.removeFromElect(Number(req.params.pid), actor(req)); return { ok: true }; }));
m.post('/games/:id/zones', wrap((req) => Z.createZone(gameId(req), req.body || {}, actor(req))));
m.patch('/zones/:zid', wrap((req) => Z.updateZone(Number(req.params.zid), req.body || {}, actor(req))));
m.delete('/zones/:zid', wrap((req) => { Z.deleteZone(Number(req.params.zid), actor(req)); return { ok: true }; }));
m.get('/games/:id/replay', wrap((req) => RP.replayData(gameId(req), { since: Number(req.query.since) || 0 })));
m.get('/games/:id/prints', wrap((req) => print.catalog(G.getGame(gameId(req)), baseUrl(req))));
m.post('/print-logo', rawImage, wrap((req) => { print.saveLogo(req.body, String(req.headers['content-type'] || '').split(';')[0]); return { ok: true }; }));
m.delete('/print-logo', wrap(() => { print.resetLogo(); return { ok: true }; }));
m.get('/games/:id/events', wrap((req) => EV.masterEvents(gameId(req))));
m.post('/games/:id/events', wrap((req) => EV.createEvent(gameId(req), req.body || {}, actor(req))));
m.patch('/events/:eid/location', wrap((req) => EV.setLocation(Number(req.params.eid), req.body?.location || null, actor(req))));
m.post('/events/:eid/launch', wrap((req) => EV.launchEvent(Number(req.params.eid), actor(req))));
m.delete('/events/:eid', wrap((req) => { EV.deleteEvent(Number(req.params.eid), actor(req)); return { ok: true }; }));
m.post('/events/:eid/start', wrap((req) => EV.startEvent(Number(req.params.eid), { master: true, actor: actor(req) })));
m.post('/events/:eid/close', wrap((req) => EV.closeEvent(Number(req.params.eid), { master: true, actor: actor(req) }, req.body?.outcomes || {})));
m.post('/games/:id/notices', wrap((req) => G.createNotice(gameId(req), req.body || {}, actor(req))));
m.delete('/notices/:nid', wrap((req) => { G.deleteNotice(Number(req.params.nid), actor(req)); return { ok: true }; }));
m.patch('/players/:pid', wrap((req) => { G.updatePlayer(Number(req.params.pid), req.body || {}, actor(req)); return { ok: true }; }));
m.delete('/players/:pid', wrap((req) => { G.deletePlayer(Number(req.params.pid), actor(req)); return { ok: true }; }));

m.post('/games/:id/teams', wrap((req) => ({ id: G.createTeam(gameId(req), req.body || {}, actor(req)) })));
m.post('/games/:id/auto-pair', wrap((req) => G.autoPair(gameId(req), actor(req))));
m.post('/players/:pid/pending', wrap((req) => { G.setPending(Number(req.params.pid), actor(req)); return { ok: true }; }));
m.post('/games/:id/people/assign', wrap((req) => G.assignPerson(gameId(req), req.body || {}, actor(req))));
m.patch('/teams/:tid', wrap((req) => { G.updateTeam(Number(req.params.tid), req.body || {}, actor(req)); return { ok: true }; }));
m.delete('/teams/:tid', wrap((req) => { G.dissolveTeam(Number(req.params.tid), actor(req)); return { ok: true }; }));
m.post('/teams/:tid/withdraw', wrap((req) => { G.withdrawTeam(Number(req.params.tid), actor(req), !!req.body.restore); return { ok: true }; }));
m.post('/teams/:tid/regen-token', wrap((req) => { G.regenTeamToken(Number(req.params.tid), actor(req)); return { ok: true }; }));
m.post('/teams/:tid/fragments', wrap((req) => { G.correctFragments(Number(req.params.tid), req.body || {}, actor(req)); return { ok: true }; }));
m.post('/teams/:tid/message', wrap((req) => {
  const t = q.get('SELECT * FROM teams WHERE id = ?', Number(req.params.tid));
  if (!t) throw new HttpError(404, 'Coppia non trovata');
  G.markRead(t.id, t.kind === 'elect' ? null : undefined);
  return G.postMessage(t, 'master', req.body.text, actor(req));
}));
m.post('/teams/:tid/message/audio', rawAudio, wrap((req) => {
  const t = q.get('SELECT * FROM teams WHERE id = ?', Number(req.params.tid));
  if (!t) throw new HttpError(404, 'Coppia non trovata');
  G.markRead(t.id, t.kind === 'elect' ? null : undefined);
  return G.postMessage(t, 'master', '', actor(req), { buffer: req.body, mime: req.headers['content-type'], ms: req.query.ms });
}));
m.post('/teams/:tid/read', wrap((req) => {
  const t = q.get('SELECT * FROM teams WHERE id = ?', Number(req.params.tid));
  if (t) G.markRead(t.id, t.kind === 'elect' ? null : undefined);
  if (t) rt.toStaff(t.gameId, 'read');
  return { ok: true };
}));

m.post('/games/:id/codes', wrap((req) => { G.generateCodes(gameId(req), actor(req)); return { ok: true }; }));
m.post('/games/:id/never', wrap((req) => { G.extractNeverRevealed(G.getGame(gameId(req)), actor(req)); return { ok: true }; }));
m.post('/games/:id/calendar', wrap((req) => { G.buildCalendar(G.getGame(gameId(req)), actor(req)); return { ok: true }; }));
m.post('/games/:id/points', wrap((req) => { G.ensurePoints(G.getGame(gameId(req)), actor(req)); return { ok: true }; }));
m.post('/games/:id/points/free', wrap((req) => G.addFreePoints(gameId(req), req.body || {}, actor(req))));
m.delete('/points/:pid', wrap((req) => { G.deletePoint(Number(req.params.pid), actor(req)); return { ok: true }; }));
m.post('/games/:id/phrase', wrap((req) => { G.setPhrase(gameId(req), req.body.phrase, actor(req)); return { ok: true }; }));
m.patch('/points/:pid', wrap((req) => { G.editPoint(Number(req.params.pid), req.body || {}, actor(req)); return { ok: true }; }));
m.post('/points/:pid/regen', wrap((req) => { G.regenPointToken(Number(req.params.pid), actor(req)); return { ok: true }; }));
m.patch('/fragments/:fid', wrap((req) => { G.editFragment(Number(req.params.fid), req.body || {}, actor(req)); return { ok: true }; }));

m.patch('/revelations/:rid', wrap((req) => { G.editRevelation(Number(req.params.rid), req.body || {}, actor(req)); return { ok: true }; }));
m.post('/revelations/:rid/reveal', wrap((req) => { G.revealNow(Number(req.params.rid), actor(req)); return { ok: true }; }));
m.post('/revelations/:rid/postpone', wrap((req) => { G.postponeRevelation(Number(req.params.rid), req.body.minutes, actor(req)); return { ok: true }; }));
m.post('/revelations/:rid/skip', wrap((req) => { G.skipRevelation(Number(req.params.rid), actor(req), !!req.body.restore); return { ok: true }; }));
m.post('/games/:id/reveal-next', wrap((req) => { G.revealNext(gameId(req), actor(req)); return { ok: true }; }));
m.post('/games/:id/reveal-sector', wrap((req) => { G.revealSector(gameId(req), Number(req.body.sectorId), actor(req)); return { ok: true }; }));

m.post('/games/:id/supply', wrap((req) => ({ ok: true, id: G.saveSupply(gameId(req), req.body || {}, actor(req)) })));
m.patch('/supply/:sid', wrap((req) => {
  const s = q.get('SELECT * FROM supply_drops WHERE id = ?', Number(req.params.sid));
  if (!s) throw new HttpError(404, 'Finestra non trovata');
  G.saveSupply(s.gameId, req.body || {}, actor(req), s.id);
  return { ok: true };
}));
m.delete('/supply/:sid', wrap((req) => { G.deleteSupply(Number(req.params.sid), actor(req)); return { ok: true }; }));
m.post('/supply/:sid/fire', wrap((req) => { G.fireSupply(Number(req.params.sid), actor(req)); return { ok: true }; }));
m.post('/supply/:sid/close', wrap((req) => { G.closeSupply(Number(req.params.sid), actor(req)); return { ok: true }; }));
m.post('/supply/:sid/shift', wrap((req) => { G.shiftSupply(Number(req.params.sid), req.body.minutes, actor(req)); return { ok: true }; }));

// Squadre degli Eletti e incarichi
m.post('/games/:id/squads', wrap((req) => F.createSquad(gameId(req), req.body || {}, actor(req))));
m.patch('/squads/:sid', wrap((req) => { F.updateSquad(req.params.sid, req.body || {}, actor(req)); return { ok: true }; }));
m.delete('/squads/:sid', wrap((req) => { F.deleteSquad(req.params.sid, actor(req)); return { ok: true }; }));
m.post('/players/:pid/squad', wrap((req) => { F.setMemberSquad(req.params.pid, req.body.squadId || null, actor(req)); return { ok: true }; }));
m.post('/assign', wrap((req) => {
  const b = req.body || {};
  const opts = {};
  if ('targetLat' in b) { opts.targetLat = b.targetLat; opts.targetLng = b.targetLng; }
  if ('note' in b) opts.note = b.note;
  opts.move = !!b.move;
  F.assignToSquad(b.kind, b.id, b.squadId || null, actor(req), opts);
  return { ok: true };
}));
// Conversazione con una singola squadra di Eletti.
const squadThread = (req) => {
  const sq = q.get('SELECT * FROM elect_squads WHERE id = ?', Number(req.params.sid));
  if (!sq) throw new HttpError(404, 'Squadra non trovata');
  return { sq, elect: G.ensureElect(sq.gameId) };
};
m.post('/squads/:sid/message', wrap((req) => {
  const { sq, elect } = squadThread(req);
  G.markRead(elect.id, sq.id);
  return G.postMessage(elect, 'master', req.body.text, actor(req), null, sq.id);
}));
m.post('/squads/:sid/message/audio', rawAudio, wrap((req) => {
  const { sq, elect } = squadThread(req);
  G.markRead(elect.id, sq.id);
  return G.postMessage(elect, 'master', '', actor(req), { buffer: req.body, mime: req.headers['content-type'], ms: req.query.ms }, sq.id);
}));
m.post('/squads/:sid/read', wrap((req) => {
  const { sq, elect } = squadThread(req);
  G.markRead(elect.id, sq.id);
  rt.toStaff(sq.gameId, 'read');
  return { ok: true };
}));
m.post('/games/:id/tasks', wrap((req) => F.createTask(gameId(req), req.body || {}, actor(req))));
m.get('/games/:id/emergencies', wrap((req) => EM.list(gameId(req))));
m.post('/emergencies/:eid/ack', wrap((req) => { EM.ack(req.params.eid, actor(req)); return { ok: true }; }));
m.post('/emergencies/:eid/close', wrap((req) => { EM.close(req.params.eid, actor(req), req.body?.note); return { ok: true }; }));
m.post('/tasks/:tid/assign', wrap((req) => { F.assignTask(req.params.tid, req.body.squadId, actor(req)); return { ok: true }; }));
m.post('/tasks/:tid/cancel', wrap((req) => { F.cancelTask(req.params.tid, actor(req)); return { ok: true }; }));
m.post('/tasks/:tid/done', wrap((req) => { F.setTaskDone(req.params.tid, req.body.done !== false, actor(req)); return { ok: true }; }));
m.delete('/tasks/:tid', wrap((req) => { F.deleteTask(req.params.tid, actor(req)); return { ok: true }; }));
m.get('/gift-types', (_req, res) => res.json(F.giftTypes()));
// Testi e tempi di Skill e Doni della partita: modificabili solo in preparazione.
m.get('/games/:id/catalog', wrap((req) => S.editableCatalog(gameId(req))));
m.put('/games/:id/catalog/:kind/:item', wrap((req) => S.editCatalog(gameId(req), req.params.kind, req.params.item, req.body || {}, actor(req))));
m.post('/games/:id/gifts', wrap((req) => F.createGifts(gameId(req), req.body || {}, actor(req))));
m.patch('/gifts/:gid', wrap((req) => { F.updateGift(req.params.gid, req.body || {}, actor(req)); return { ok: true }; }));
m.delete('/gifts/:gid', wrap((req) => { F.deleteGift(req.params.gid, actor(req)); return { ok: true }; }));
m.post('/gifts/:gid/reveal', wrap((req) => { F.revealGift(req.params.gid, actor(req)); return { ok: true }; }));
m.post('/gifts/:gid/schedule', wrap((req) => F.scheduleGiftReveal(req.params.gid, req.body || {}, actor(req))));
m.post('/gifts/:gid/reset', wrap((req) => { F.resetGift(req.params.gid, actor(req)); return { ok: true }; }));
m.post('/games/:id/announce', wrap((req) => G.freeAnnouncement(gameId(req), req.body.text, actor(req))));

m.get('/accounts', (_req, res) => res.json(A.listAccounts()));
m.delete('/accounts/:aid', wrap((req) => { A.deleteAccount(req.params.aid, actor(req)); return { ok: true }; }));
m.post('/accounts/cleanup', wrap((req) => A.deleteOrphanAccounts(actor(req))));
m.post('/accounts/:aid/password', wrap((req) => { A.resetPassword(req.params.aid, req.body.password, actor(req)); return { ok: true }; }));
m.get('/users', (_req, res) => res.json(q.all(`SELECT u.id, u.username, u.role, u.displayName, u.createdAt, u.accountId, a.username AS accountUsername,
    (SELECT group_concat(i.providerName, ' · ') FROM account_identities i WHERE i.accountId = u.accountId) AS ops
  FROM users u LEFT JOIN accounts a ON a.id = u.accountId ORDER BY u.role, u.username`)));
// Inviti del Consiglio: link monouso (24 ore) per diventare master o validatore con il proprio account.
// Consiglio Zero: richieste d'accesso e azioni di ciascuno.
m.get('/council', (_req, res) => res.json(St.councilList()));
m.post('/council/requests/:aid/accept', wrap((req) => St.acceptCouncil(req.params.aid, req.body?.perms, actor(req), req.body?.playerId || null)));
m.delete('/council/requests/:aid', wrap((req) => { St.rejectCouncil(req.params.aid, actor(req)); return { ok: true }; }));
m.patch('/council/:uid', wrap((req) => St.setCouncilPerms(req.params.uid, req.body || {}, req.user, actor(req))));
m.get('/invites', (req, res) => res.json(St.pendingInvites().map((i) => ({ ...i, url: `${baseUrl(req)}/invito/${i.token}` }))));
m.post('/invites', wrap((req) => { const i = St.createInvite(req.body?.role, actor(req)); return { ...i, url: `${baseUrl(req)}/invito/${i.token}` }; }));
m.delete('/invites/:token', wrap((req) => { St.cancelInvite(req.params.token, actor(req)); return { ok: true }; }));
m.post('/users', wrap((req) => {
  const { username, password, role, displayName } = req.body || {};
  if (!username?.trim() || !password || password.length < 6) throw new HttpError(400, 'Username e password (almeno 6 caratteri) obbligatori');
  if (!['master', 'validator'].includes(role)) throw new HttpError(400, 'Ruolo non valido');
  if (q.get('SELECT 1 FROM users WHERE username = ?', username.trim())) throw new HttpError(409, 'Username già in uso');
  q.run('INSERT INTO users (username, passHash, role, displayName, createdAt) VALUES (?, ?, ?, ?, ?)', username.trim(), hashPassword(password), role, displayName || null, Date.now());
  G.log(null, actor(req), 'user_created', { username, role });
  return { ok: true };
}));
m.patch('/users/:uid', wrap((req) => {
  const { password } = req.body || {};
  if (!password || password.length < 6) throw new HttpError(400, 'Password di almeno 6 caratteri');
  if (q.get('SELECT accountId FROM users WHERE id = ?', Number(req.params.uid))?.accountId) throw new HttpError(409, 'Entra con il suo account: la password si cambia dal suo profilo');
  q.run('UPDATE users SET passHash = ? WHERE id = ?', hashPassword(password), Number(req.params.uid));
  return { ok: true };
}));
m.delete('/users/:uid', wrap((req) => {
  const uid = Number(req.params.uid);
  if (uid === req.user.id) throw new HttpError(409, 'Non puoi eliminare te stesso');
  q.run('DELETE FROM sessions WHERE kind = ? AND refId = ?', 'user', uid);
  q.run('DELETE FROM users WHERE id = ?', uid);
  return { ok: true };
}));

m.get('/qr.svg', async (req, res, next) => {
  try {
    const svg = await QRCode.toString(String(req.query.text || ''), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').send(svg);
  } catch (e) { next(e); }
});
m.get('/base-url', (req, res) => res.json({ baseUrl: baseUrl(req) }));
// Gestionali per «Accedi con Zero Dark Ops»: l'indirizzo di ritorno va registrato nel gestionale.
m.get('/settings/ops', (req, res) => res.json({ providers: O.adminList(), redirectUri: opsRedirectUri(req) }));
m.post('/settings/ops', wrap((req) => O.saveProvider({ ...req.body, id: undefined }, actor(req))));
m.put('/settings/ops/:id', wrap((req) => O.saveProvider({ ...req.body, id: req.params.id }, actor(req))));
m.delete('/settings/ops/:id', wrap((req) => { O.deleteProvider(req.params.id, actor(req)); return { ok: true }; }));
m.get('/settings/public-url', (req, res) => res.json({
  publicUrl: getSetting('publicUrl') || '', envPublicUrl: process.env.PUBLIC_URL || '', current: baseUrl(req), requestOrigin: requestOrigin(req),
}));
m.put('/settings/public-url', wrap((req) => {
  const v = normalizeBaseUrl(req.body.publicUrl);
  if (v) setSetting('publicUrl', v);
  else q.run("DELETE FROM settings WHERE key = 'publicUrl'");
  G.log(null, actor(req), 'public_url_changed', { publicUrl: v || null });
  return { publicUrl: v, current: baseUrl(req) };
}));

app.use('/api/m', m);

// ---- API validatore (regia o validatore)
const v = express.Router();
v.use(needStaff);
// Le partite «Creata» restano solo in regia: le app di campo (Soglia, Test repliche, Consiglio) non le vedono.
v.get('/games', (req, res) => res.json(q.all(`SELECT id, name, status FROM games${req.user.role === 'master' ? '' : " WHERE status != 'created'"} ORDER BY id DESC`)));
v.get('/games/:id/teams', needPerm('soglia'), wrap(async (req) => {
  const g = G.getGame(Number(req.params.id));
  // Codice di uscita della Soglia: il QR da mostrare a schermo accanto all'elenco (lo stesso del cartello stampato).
  const soglia = q.get("SELECT exitToken FROM landmarks WHERE gameId = ? AND kind = 'soglia' AND exitToken IS NOT NULL", g.id);
  const exitUrl = soglia ? `${baseUrl(req)}/u/${soglia.exitToken}` : null;
  // Stesso generatore del cartello stampato: il QR è identico.
  const exitSvg = exitUrl ? await print.qr(exitUrl) : null;
  const exitCode = soglia ? soglia.exitToken.slice(-6).toUpperCase() : null;
  // Per provare la cerimonia a schermo: la Parola vera solo al master, agli altri una parola d'esempio.
  const word = req.user.role === 'master' ? q.all('SELECT text FROM fragments WHERE gameId = ? ORDER BY position', g.id).map((f) => f.text) : null;
  // I pulsanti «Prova gli effetti» compaiono solo nell'ambiente di test.
  const tryEffects = process.env.ZDG_ENV === 'test';
  return { exitUrl, exitSvg, exitCode, word, tryEffects, clock: G.clockOf(g), game: { id: g.id, name: g.name }, teams: G.standings(g.id).concat(G.teamsOf(g.id).filter((t) => t.status === 'withdrawn').map((t) => ({ teamId: t.id, sectorName: t.sectorName, roman: t.roman, displayName: t.displayName, status: t.status }))) };
}));
v.get('/teams/:tid', needPerm('soglia'), wrap((req) => G.validatorView(Number(req.params.tid))));
// Accettazione e test repliche anche per lo staff (validatori), dalla pagina Soglia.
const sActor = (req) => req.user?.username || 'staff';
v.get('/games/:id/checkin', needPerm('accettazione', 'armi'), wrap((req) => CK.checkinData(Number(req.params.id))));
v.post('/games/:id/checkin/player/:pid', needPerm('accettazione'), wrap((req) => CK.setPlayerCheckin(Number(req.params.id), req.params.pid, ckOn(req.body), sActor(req), req.body?.checks || null)));
v.post('/games/:id/weapons/:pid', needPerm('armi'), wrap((req) => CK.editWeapons(Number(req.params.id), req.params.pid, req.body || {}, sActor(req))));
v.post('/games/:id/chrono/:pid/live', needPerm('armi'), wrap((req) => CK.setChronoLive(Number(req.params.id), req.params.pid, req.body?.weapon, req.body?.readings, { open: req.body?.open !== false, grams: req.body?.grams })));
v.post('/games/:id/checkin/team/:tid', needPerm('accettazione'), wrap((req) => CK.setTeamCheckin(Number(req.params.id), req.params.tid, req.body?.on !== false, sActor(req))));
v.post('/games/:id/place/:pid', needPerm('accettazione'), wrap((req) => CK.placePlayer(Number(req.params.id), req.params.pid, req.body || {}, sActor(req))));
v.post('/games/:id/chrono/:pid/done', needPerm('armi'), wrap((req) => CK.setChronoDone(Number(req.params.id), req.params.pid, req.body?.on !== false, sActor(req))));
v.post('/games/:id/chrono/:pid', needPerm('armi'), wrap((req) => CK.setChrono(Number(req.params.id), req.params.pid, req.body?.weapon, req.body?.on !== false, sActor(req), req.body?.shot || null, req.body?.fail === true)));
v.post('/games/:id/squads', needPerm('accettazione'), wrap((req) => F.createSquad(Number(req.params.id), req.body || {}, sActor(req))));
v.post('/teams/:tid/check', needPerm('soglia'), wrap((req) => G.compareTyped(Number(req.params.tid), req.body.typed)));
v.post('/teams/:tid/validate', needPerm('soglia'), wrap((req) => G.validate(Number(req.params.tid), req.body || {}, req.user)));
v.get('/board/:id', wrap((req) => G.boardState(Number(req.params.id))));
// Lancio doni e annunci dal Consiglio Zero.
v.get('/games/:id/gifts', needPerm('doni'), wrap((req) => {
  const g = G.getGame(Number(req.params.id));
  return { clock: G.clockOf(g), gifts: F.fieldState(g.id).gifts.map(({ id, label, name, icon, color, status, revealMode, revealAtMin, revealAt, revealedAt, claimedAt }) => ({ id, label, name, icon, color, status, revealMode, revealAtMin, revealAt, revealedAt, claimedAt })) };
}));
v.post('/gifts/:gid/reveal', needPerm('doni'), wrap((req) => { F.revealGift(req.params.gid, sActor(req)); return { ok: true }; }));
v.post('/games/:id/announce', needPerm('comunicazioni'), wrap((req) => G.freeAnnouncement(Number(req.params.id), req.body?.text, sActor(req))));
app.use('/api/v', v);

// ---- pagine stampabili
// Un gruppo (altari, doni, uscita, credenziali) o «tutto»; ?sel=a1,g4 stampa solo quegli elementi.
app.get('/regia/stampa/:kind/:id', needMaster, wrap(async (req, res) => {
  const html = await print.page(req.params.kind, G.getGame(Number(req.params.id)), baseUrl(req), req.query.sel || '');
  if (!html) throw new HttpError(404, 'Stampa non trovata');
  res.type('html').send(html);
}));
// Logo delle stampe: quello caricato in regia o quello dello Zero Dark Team.
app.get('/regia/stampa-logo', needMaster, (_req, res) => { const l = print.logo(); res.sendFile(l.file, { headers: { 'Content-Type': l.mime, 'Cache-Control': 'no-cache' } }); });

// ---- file statici e pagine
const sendPage = (file) => (_req, res) => res.sendFile(path.join(PUBLIC_DIR, file), { headers: { 'Cache-Control': 'no-cache' } });
app.get('/sw.js', sendPage('sw.js'));
// Decoder QR per lo scanner interno dell'app (quando il browser non ha BarcodeDetector).
app.get('/vendor/jsQR.js', (_req, res) => res.sendFile(require.resolve('jsqr/dist/jsQR.js'), { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' } }));
app.get('/', sendPage('index.html'));
app.get('/a/:token', sendPage('index.html'));
app.get('/d/:token', sendPage('index.html'));
app.get('/u/:token', sendPage('index.html'));
app.get('/campo', sendPage('campo.html'));
// Leaflet per le mappe OpenTopoMap (servito localmente: funziona anche con poca rete).
app.use('/vendor/leaflet', express.static(path.join(path.dirname(require.resolve('leaflet/package.json')), 'dist'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
app.get('/regia', sendPage('regia.html'));
app.get('/soglia', sendPage('soglia.html'));
app.get('/armi', sendPage('armi.html'));
app.get('/accettazione', sendPage('armi.html'));
app.get('/consiglio', sendPage('consiglio.html'));
app.get('/iscrizione', sendPage('iscrizione.html'));
app.get('/tabellone', sendPage('tabellone.html'));
app.use(express.static(PUBLIC_DIR, { index: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

// ---- errori
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Risorsa non trovata')));
app.use((e, req, res, _next) => {
  const status = e.status || (e.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(e);
  if (req.path.startsWith('/api/') || req.headers.accept?.includes('application/json')) {
    return res.status(status).json({ error: status >= 500 ? 'Errore interno' : e.message });
  }
  if (status === 401) return res.redirect('/');
  res.status(status).type('text').send(e.message);
});

seed();
G.ensurePlayerCredentials();
rt.initPush();
try { S.migrateCatalogTags(); } catch (e) { console.error('migrazione tag', e); }
setInterval(G.tickAll, 1000).unref();
setInterval(F.tickAll, 2000).unref();
setInterval(() => { try { K.tickAlliances(); } catch (e) { console.error(e); } }, 20000).unref();
setInterval(() => { try { S.tickAll(); } catch (e) { console.error(e); } }, 5000).unref();
setInterval(() => { try { EV.tickAll(); } catch (e) { console.error(e); } }, 3000).unref();
setInterval(() => { try { Z.tickAll(); } catch (e) { console.error(e); } }, 5000).unref();
G.tickAll();

app.listen(PORT, () => console.log(`Zero Dark Games in ascolto sulla porta ${PORT}`));
