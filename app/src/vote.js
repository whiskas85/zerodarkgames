'use strict';
// Voto del pubblico: un link da condividere (/vota) dove chiunque vota la sua coppia preferita tra quelle scelte dalla
// regia, solo prima della partita. Si vedono solo le percentuali e il podio. Difese contro i voti gonfiati:
// un voto per dispositivo (cookie), attese crescenti (3, 10, 30 minuti) per i voti nuovi dalla stessa rete, verifica anti-robot
// (Cloudflare Turnstile, se configurata), voto «verificato» (con account) che pesa di più, segnalazione dei picchi.
const crypto = require('crypto');
const { q, tx, getSetting, setSetting } = require('./db');
const G = require('./game');
const rt = require('./realtime');
const { HttpError } = require('./util');

const err = (status, msg) => new HttpError(status, msg);
const SK = () => require('./skills');

const PRE = ['created', 'draft', 'ready'];
const VOTES_PER_NET = 3; // (storico) prima: voti all'ora dalla stessa rete
// Stessa rete (stesso Wi-Fi o indirizzo): dopo il primo voto, ogni voto nuovo da un altro dispositivo aspetta
// 3, poi 10, poi 30 minuti dal precedente. Dopo 2 ore senza voti da quella rete si riparte da capo.
const NET_WAITS_MIN = [3, 10, 30];
const NET_WINDOW_MS = 2 * 3600000;
// Fino a quando questa rete deve aspettare per un voto nuovo (null = può votare subito).
function netWaitUntil(gameId, net, now = Date.now()) {
  const rows = q.all('SELECT createdAt FROM votes WHERE gameId = ? AND net = ? AND createdAt > ? ORDER BY createdAt', gameId, net, now - NET_WINDOW_MS);
  if (!rows.length) return null;
  const wait = NET_WAITS_MIN[Math.min(rows.length, NET_WAITS_MIN.length) - 1] * 60000;
  const until = rows.at(-1).createdAt + wait;
  return until > now ? until : null;
}
const VERIFIED_WEIGHT = 3; // chi vota con l'account dei Giochi (o Zero Dark Ops)
const SPIKE_MIN = 5; // segnalazione: almeno 5 voti dalla stessa rete in 10 minuti
const SPIKE_MS = 10 * 60000;

// ---------------------------------------------------------------- Tor
// Con Tor ogni voto arriva da un indirizzo diverso: il limite per rete non basta. L'elenco pubblico dei nodi di uscita
// di Tor si scarica all'avvio e ogni ora (resta salvato: un riavvio senza rete usa l'ultimo). Da lì non si vota, e la
// regia vede (e annulla) i voti già arrivati da quegli indirizzi: l'impronta della rete è la stessa (netHash).
const TOR_LIST_URL = 'https://check.torproject.org/torbulkexitlist';
let torIps = new Set((() => { try { return JSON.parse(getSetting('torExitList') || '[]'); } catch { return []; } })());
let torAt = Number(getSetting('torExitListAt')) || null;
const cleanIp = (ip) => String(ip || '').replace(/^::ffff:/, '').trim();
function setTorList(list, at = Date.now()) {
  const ips = [...new Set(list.map(cleanIp).filter((x) => /^[\d.:a-f]+$/i.test(x)))];
  if (!ips.length) return 0;
  torIps = new Set(ips); torAt = at;
  setSetting('torExitList', JSON.stringify(ips)); setSetting('torExitListAt', String(at));
  return ips.length;
}
async function refreshTor() {
  try {
    const res = await fetch(TOR_LIST_URL, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const n = setTorList((await res.text()).split(/\s+/));
    if (n) console.log(`Tor: ${n} nodi di uscita`);
  } catch (e) { console.warn('Elenco Tor non aggiornato:', e.message); }
}
const isTor = (ip) => torIps.has(cleanIp(ip));
if (process.env.NODE_ENV !== 'test' && !process.env.ZDG_NO_TOR_FETCH) {
  setTimeout(refreshTor, 5000).unref();
  setInterval(refreshTor, 3600000).unref();
}

// La «rete» di un voto: l'indirizzo IPv4, oppure per IPv6 il prefisso /64 (una casa o un telefono ne ha un blocco intero
// e può cambiare indirizzo a piacere dentro quel blocco).
function netOf(ip) {
  const a = cleanIp(ip);
  if (!a.includes(':')) return a;
  const [head, tail = ''] = a.split('%')[0].split('::');
  const hs = head ? head.split(':') : [];
  const ts = a.includes('::') && tail ? tail.split(':') : [];
  const full = a.includes('::') ? [...hs, ...Array(Math.max(0, 8 - hs.length - ts.length)).fill('0'), ...ts] : hs;
  return `${full.slice(0, 4).map((x) => (parseInt(x, 16) || 0).toString(16)).join(':')}::/64`;
}
const netHash = (ip) => crypto.createHash('sha256').update(`zdg-vote:${netOf(ip)}`).digest('hex').slice(0, 16);
const turnstile = () => ({ siteKey: process.env.TURNSTILE_SITE_KEY || getSetting('turnstileSiteKey') || null, secret: process.env.TURNSTILE_SECRET || getSetting('turnstileSecret') || null });

// La partita del voto: quella con il voto acceso (la più recente).
const voteGame = () => q.get('SELECT * FROM games WHERE voteEnabled = 1 ORDER BY id DESC LIMIT 1');
// Chiusura: quella scelta dalla regia, altrimenti l'inizio previsto della partita (ora del server).
const startMs = (g) => (g?.scheduledStart ? Date.parse(g.scheduledStart) || null : null);
const closeAt = (g) => g?.voteClosesAt || startMs(g);
const isOpen = (g, now = Date.now()) => !!g && !!g.voteEnabled && PRE.includes(g.status) && (!g.voteOpensAt || g.voteOpensAt <= now) && (!closeAt(g) || closeAt(g) > now) && !g.votePrizedAt;

function votableTeams(gameId) {
  return q.all(`SELECT t.id, t.displayName, t.logoAt, s.name AS sectorName, s.roman, s.color, s.ord AS sectorOrd FROM teams t JOIN sectors s ON s.id = t.sectorId
                WHERE t.gameId = ? AND t.kind = 'couple' AND t.votable = 1 AND t.status != 'withdrawn' ORDER BY s.ord, t.id`, gameId);
}
// Per il pubblico: solo il nome di battaglia (o il nome), niente foto delle persone.
const membersOf = (teamId) => q.all('SELECT p.name, p.nickname FROM players p WHERE p.teamId = ? ORDER BY p.id', teamId)
  .map((p) => ({ name: p.nickname || p.name.split(' ')[0] }));
const logoUrl = (t) => (t.logoAt ? `/api/public/team-logo/${t.id}?v=${t.logoAt}` : null);

// Punteggi (pesati, senza i voti annullati) → percentuali e classifica.
function results(gameId) {
  const teams = votableTeams(gameId);
  const sum = Object.fromEntries(q.all('SELECT teamId, SUM(weight) AS w, COUNT(*) AS n, SUM(weight > 1) AS x3 FROM votes WHERE gameId = ? AND annulledAt IS NULL GROUP BY teamId', gameId).map((r) => [r.teamId, r]));
  const total = teams.reduce((a, t) => a + (sum[t.id]?.w || 0), 0);
  const list = teams.map((t) => ({ ...t, score: sum[t.id]?.w || 0, votes: sum[t.id]?.n || 0, heavy: sum[t.id]?.x3 || 0, pct: total ? Math.round(((sum[t.id]?.w || 0) / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.score - a.score || a.id - b.id);
  return { total, list };
}

// Pagina pubblica: niente numeri assoluti, solo percentuali.
function publicState(device, account, ip = null, now = Date.now()) {
  const g = voteGame();
  if (!g) return { game: null };
  const r = results(g.id);
  const mine = (account && q.get('SELECT teamId FROM votes WHERE gameId = ? AND accountId = ? AND annulledAt IS NULL', g.id, account.id))
    || (device && q.get('SELECT teamId FROM votes WHERE gameId = ? AND device = ? AND annulledAt IS NULL', g.id, device));
  const out = (t) => ({ id: t.id, roman: t.roman, sectorName: t.sectorName, color: t.color, displayName: t.displayName || null, logo: logoUrl(t), members: membersOf(t.id), pct: t.pct });
  return {
    game: { name: g.name, scheduledStart: g.scheduledStart || null },
    open: isOpen(g), opensAt: g.voteOpensAt || null, closesAt: closeAt(g), closesAtStart: !g.voteClosesAt && !!startMs(g),
    closed: !!g.votePrizedAt || !PRE.includes(g.status) || (!!closeAt(g) && closeAt(g) <= Date.now()),
    // Per i conti alla rovescia: ora del server e inizio previsto della partita (senza chiusura, il voto chiude al via).
    serverNow: Date.now(), startAt: g.scheduledStart ? (Date.parse(g.scheduledStart) || null) : null,
    title: g.voteTitle || 'Il favore del pubblico',
    // Elenco da votare in ordine di Settore (numero romano); il podio resta in ordine di voti.
    teams: [...r.list].sort((a, b) => a.sectorOrd - b.sectorOrd || a.id - b.id).map(out),
    podium: r.total ? r.list.slice(0, 3).filter((t) => t.score > 0).map(out) : [],
    myVote: mine?.teamId || null,
    verified: !!account, weight: account ? VERIFIED_WEIGHT : 1,
    turnstile: turnstile().siteKey,
    // Dalla rete Tor: la pagina lo dice subito (e non mostra i pulsanti attivi).
    tor: !!ip && isTor(ip),
    // Stessa rete: fino a quando aspettare per un voto nuovo (chi ha già votato può sempre cambiarlo).
    netWait: !mine && ip ? netWaitUntil(g.id, netHash(ip), now) : null,
  };
}

async function checkTurnstile(token, ip) {
  const { secret } = turnstile();
  if (!secret) return true;
  if (!token) throw err(400, 'Conferma di non essere un robot');
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: new URLSearchParams({ secret, response: String(token), remoteip: String(ip || '') }) });
    const data = await res.json();
    if (!data.success) throw err(400, 'Verifica anti-robot non riuscita: ricarica la pagina e riprova');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw err(503, 'Verifica anti-robot non disponibile: riprova tra poco');
  }
  return true;
}

// Voto (o cambio di voto: lo stesso dispositivo, o lo stesso account, ha un voto solo).
async function castVote({ teamId, token, device, account, ip, ua, fp }, now = Date.now()) {
  const g = voteGame();
  if (!g) throw err(404, 'Nessuna votazione in corso');
  if (!isOpen(g, now)) throw err(409, g.votePrizedAt || !PRE.includes(g.status) || (closeAt(g) && closeAt(g) <= now) ? 'Votazione chiusa' : 'La votazione non è aperta in questo momento');
  if (!device) throw err(400, 'Dispositivo non riconosciuto: abilita i cookie e riprova');
  const t = votableTeams(g.id).find((x) => x.id === Number(teamId));
  if (!t) throw err(400, 'Coppia non votabile');
  // Dal browser Tor (o da un programma che passa da Tor) non si vota.
  if (isTor(ip)) throw err(403, 'Dalla rete Tor non si vota: usa una connessione normale (Wi-Fi o dati del telefono)');
  const net = netHash(ip);
  // Impronta del browser (schermo, lingua, fuso, processore…): la navigazione privata cambia il cookie ma non questa.
  // Stessa rete e stessa impronta = stesso telefono: il voto si cambia, non se ne aggiunge uno.
  const print = /^[a-f0-9]{16,64}$/i.test(String(fp || '')) ? String(fp).toLowerCase().slice(0, 32) : null;
  const existing = (account && q.get('SELECT * FROM votes WHERE gameId = ? AND accountId = ? AND annulledAt IS NULL', g.id, account.id))
    || q.get('SELECT * FROM votes WHERE gameId = ? AND device = ? AND annulledAt IS NULL', g.id, device)
    || (print && q.get('SELECT * FROM votes WHERE gameId = ? AND net = ? AND fp = ? AND annulledAt IS NULL AND accountId IS NULL ORDER BY id DESC LIMIT 1', g.id, net, print));
  // Tetto giornaliero: al massimo N voti nuovi in 24 ore dalla stessa rete (chi ha l'account non ha tetto).
  const cap = Number(g.voteNetDailyMax) || 0;
  if (!existing && !account && cap > 0) {
    const day = q.get('SELECT COUNT(*) AS n, MIN(createdAt) AS first FROM votes WHERE gameId = ? AND net = ? AND createdAt > ?', g.id, net, now - 86400000);
    if (day.n >= cap) {
      const e = err(429, `Da questa connessione sono già arrivati ${day.n} voti nelle ultime 24 ore: il limite è ${cap}. Se siete in tanti sulla stessa rete, votate con l'account dei Giochi o dai dati del telefono.`);
      e.extra = { waitUntil: day.first + 86400000, serverNow: now };
      throw e;
    }
  }
  // Limite per rete: solo per i voti nuovi (cambiare il proprio voto è sempre permesso).
  const wait = existing ? null : netWaitUntil(g.id, net, now);
  if (wait) {
    const e = err(429, `Da questa connessione è appena stato votato: il prossimo voto sarà possibile tra ${Math.ceil((wait - now) / 60000)} minuti`);
    e.extra = { waitUntil: wait, serverNow: now };
    throw e;
  }
  await checkTurnstile(token, ip);
  const weight = account ? VERIFIED_WEIGHT : 1;
  tx(() => {
    if (existing) q.run('UPDATE votes SET teamId = ?, weight = MAX(weight, ?), accountId = COALESCE(accountId, ?), updatedAt = ? WHERE id = ?', t.id, weight, account?.id ?? null, now, existing.id);
    else q.run('INSERT INTO votes (gameId, teamId, device, net, accountId, weight, ua, createdAt, fp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', g.id, t.id, device, net, account?.id ?? null, weight, String(ua || '').slice(0, 160), now, print);
  });
  rt.toStaff(g.id, 'vote');
  return publicState(device, account, ip, now);
}

// ---------------------------------------------------------------- regia

// Per un gruppo di voti: per coppia quanti voti, quanti ×3 (con l'account) e quanti punti valgono.
function weightsOf(votes) {
  const out = {};
  for (const v of votes) {
    const w = (out[v.teamId] ||= { votes: 0, heavy: 0, points: 0 });
    w.votes += 1; w.points += v.weight || 1; if ((v.weight || 1) > 1) w.heavy += 1;
  }
  return out;
}

// Picchi sospetti: tanti voti dalla stessa rete in poco tempo (finestre di 10 minuti).
function spikes(gameId) {
  const rows = q.all('SELECT id, teamId, net, weight, createdAt FROM votes WHERE gameId = ? AND annulledAt IS NULL ORDER BY net, createdAt', gameId);
  const out = [];
  for (let i = 0; i < rows.length;) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].net === rows[i].net && rows[j + 1].createdAt - rows[i].createdAt <= SPIKE_MS) j++;
    if (j - i + 1 >= SPIKE_MIN) {
      const group = rows.slice(i, j + 1);
      const byTeam = {};
      for (const v of group) byTeam[v.teamId] = (byTeam[v.teamId] || 0) + 1;
      // Per squadra: quanti voti di questo picco sono andati a ogni coppia (e quali, per annullarli a parte).
      const idsByTeam = {};
      for (const v of group) (idsByTeam[v.teamId] ||= []).push(v.id);
      out.push({ weights: weightsOf(group), net: rows[i].net.slice(0, 6), from: group[0].createdAt, to: group.at(-1).createdAt, count: group.length, ids: group.map((v) => v.id), byTeam, idsByTeam });
      i = j + 1;
    } else i++;
  }
  return out;
}

function masterVote(gameId) {
  const g = G.getGame(gameId);
  const r = results(g.id);
  return {
    enabled: !!g.voteEnabled, open: isOpen(g), opensAt: g.voteOpensAt || null, closesAt: g.voteClosesAt || null, title: g.voteTitle || '',
    netDailyMax: g.voteNetDailyMax ?? 3,
    prizes: [g.votePrize1 || null, g.votePrize2 || null, g.votePrize3 || null], prizedAt: g.votePrizedAt || null,
    turnstile: !!turnstile().secret && !!turnstile().siteKey, turnstileSiteKey: turnstile().siteKey || '', turnstileFromEnv: !!process.env.TURNSTILE_SECRET,
    giftTypes: SK().GIFTS.filter(SK().availableGift).map((x) => ({ id: x.id, name: x.name, icon: x.icon, color: x.color || null,
      description: String(x.description || '').replace('{durata}', x.durationMin || '').replace('{raggio}', x.radiusM || '') })),
    total: r.total,
    votes: q.get('SELECT COUNT(*) AS n, SUM(accountId IS NOT NULL) AS verified FROM votes WHERE gameId = ? AND annulledAt IS NULL', g.id),
    annulled: q.get('SELECT COUNT(*) AS n FROM votes WHERE gameId = ? AND annulledAt IS NOT NULL', g.id).n,
    teams: q.all("SELECT t.id, t.votable, t.displayName, s.name AS sectorName, s.roman, s.color FROM teams t JOIN sectors s ON s.id = t.sectorId WHERE t.gameId = ? AND t.kind = 'couple' AND t.status != 'withdrawn' ORDER BY s.ord, t.id", g.id)
      .map((t) => { const x = r.list.find((y) => y.id === t.id); return { ...t, votable: !!t.votable, pct: x?.pct || 0, votes: x?.votes || 0, score: x?.score || 0, heavy: x?.heavy || 0 }; }),
    ranking: r.list.map((t) => ({ id: t.id, roman: t.roman, sectorName: t.sectorName, pct: t.pct, votes: t.votes, score: t.score, heavy: t.heavy })),
    spikes: spikes(g.id),
    // Quanto vale un voto dato con l'account (per i conteggi «×3» della regia).
    weight: VERIFIED_WEIGHT,
    // Voti (validi) arrivati da indirizzi che oggi sono nodi di uscita di Tor.
    tor: (() => {
      const nets = new Set([...torIps].map(netHash));
      const rows = q.all('SELECT id, teamId, net, weight FROM votes WHERE gameId = ? AND annulledAt IS NULL', g.id).filter((v) => nets.has(v.net));
      // Divisi per coppia: a chi sono andati i voti da Tor (e quali, per annullarli a parte).
      const idsByTeam = {};
      for (const v of rows) (idsByTeam[v.teamId] ||= []).push(v.id);
      return { listAt: torAt, exits: torIps.size, votes: rows.length, ids: rows.map((v) => v.id), idsByTeam, weights: weightsOf(rows) };
    })(),
  };
}

const clampTs = (v) => (v == null || v === '' ? null : Number(v) > 0 ? Number(v) : null);
function updateVote(gameId, data, actor) {
  const g = G.getGame(gameId);
  if (data.enabled !== undefined) {
    // Un solo link: accendendo il voto qui si spegne nelle altre partite.
    if (data.enabled) q.run('UPDATE games SET voteEnabled = 0 WHERE id != ?', g.id);
    q.run('UPDATE games SET voteEnabled = ? WHERE id = ?', data.enabled ? 1 : 0, g.id);
  }
  if (data.opensAt !== undefined) q.run('UPDATE games SET voteOpensAt = ? WHERE id = ?', clampTs(data.opensAt), g.id);
  if (data.closesAt !== undefined) q.run('UPDATE games SET voteClosesAt = ? WHERE id = ?', clampTs(data.closesAt), g.id);
  if (data.netDailyMax !== undefined) q.run('UPDATE games SET voteNetDailyMax = ? WHERE id = ?', Math.max(0, Math.min(100, Math.round(Number(data.netDailyMax)) || 0)), g.id);
  if (data.title !== undefined) q.run('UPDATE games SET voteTitle = ? WHERE id = ?', String(data.title || '').trim().slice(0, 80) || null, g.id);
  // Chiavi di Cloudflare Turnstile (verifica anti-robot), se non sono nel file .env.
  if (data.turnstileSiteKey !== undefined) setSetting('turnstileSiteKey', String(data.turnstileSiteKey || '').trim().slice(0, 120));
  if (data.turnstileSecret !== undefined && String(data.turnstileSecret).trim()) setSetting('turnstileSecret', String(data.turnstileSecret).trim().slice(0, 200));
  if (data.turnstileSecret === null) setSetting('turnstileSecret', '');
  for (const [i, k] of [[1, 'prize1'], [2, 'prize2'], [3, 'prize3']]) {
    if (data[k] !== undefined) q.run(`UPDATE games SET votePrize${i} = ? WHERE id = ?`, data[k] && SK().giftById(data[k]) ? data[k] : null, g.id);
  }
  G.log(g.id, actor, 'vote_updated', { enabled: data.enabled });
  rt.toStaff(g.id, 'vote');
  return masterVote(g.id);
}

function setVotable(teamId, on, actor) {
  const t = q.get("SELECT * FROM teams WHERE id = ? AND kind = 'couple'", Number(teamId));
  if (!t) throw err(404, 'Coppia non trovata');
  q.run('UPDATE teams SET votable = ? WHERE id = ?', on ? 1 : 0, t.id);
  G.log(t.gameId, actor, 'vote_team', { teamId: t.id, votable: !!on });
  rt.toStaff(t.gameId, 'vote');
}

function annulVotes(gameId, ids, actor) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Boolean);
  if (!list.length) throw err(400, 'Nessun voto da annullare');
  const n = tx(() => list.reduce((a, id) => a + Number(q.run('UPDATE votes SET annulledAt = ?, annulledBy = ? WHERE id = ? AND gameId = ? AND annulledAt IS NULL', Date.now(), actor, id, Number(gameId)).changes), 0));
  G.log(Number(gameId), actor, 'vote_annulled', { count: n });
  rt.toStaff(Number(gameId), 'vote');
  return { annulled: n };
}

// ---------------------------------------------------------------- pulizia dei voti a ripetizione

// Come cambierebbero le percentuali annullando quei voti: prima e dopo, coppia per coppia.
function simulate(gameId, ids) {
  const drop = new Set((ids || []).map(Number));
  const teams = votableTeams(gameId);
  const rows = q.all('SELECT id, teamId, weight FROM votes WHERE gameId = ? AND annulledAt IS NULL', gameId);
  const tally = (list) => { const m = {}; for (const v of list) { const x = (m[v.teamId] ||= { score: 0, votes: 0 }); x.score += v.weight || 1; x.votes += 1; } return m; };
  const before = tally(rows);
  const after = tally(rows.filter((v) => !drop.has(v.id)));
  const tot = (m) => teams.reduce((a, t) => a + (m[t.id]?.score || 0), 0);
  const tb = tot(before); const ta = tot(after);
  const pct = (m, t, T) => (T ? Math.round(((m[t.id]?.score || 0) / T) * 1000) / 10 : 0);
  const list = teams.map((t) => ({ id: t.id, label: `${t.roman} ${t.sectorName}`, name: t.displayName || null,
    before: { pct: pct(before, t, tb), votes: before[t.id]?.votes || 0, score: before[t.id]?.score || 0 },
    after: { pct: pct(after, t, ta), votes: after[t.id]?.votes || 0, score: after[t.id]?.score || 0 } }));
  const rank = (k) => [...list].sort((a, b) => b[k].score - a[k].score || a.id - b.id).map((x) => x.id);
  const rb = rank('before'); const ra = rank('after');
  for (const x of list) { x.before.rank = rb.indexOf(x.id) + 1; x.after.rank = ra.indexOf(x.id) + 1; }
  return { removed: rows.filter((v) => drop.has(v.id)).length, list: list.sort((a, b) => a.after.rank - b.after.rank) };
}

// Voti a ripetizione: più voti dalla stessa rete alla stessa coppia. Se ne tiene uno (il verificato, o il primo)
// e si propongono da annullare gli altri. level 'strong' = solo reti con almeno 4 voti alla coppia; 'all' = da 2 in su.
function suspicious(gameId, { teamId = null, level = 'strong' } = {}) {
  const min = level === 'all' ? 2 : 4;
  const rows = q.all('SELECT * FROM votes WHERE gameId = ? AND annulledAt IS NULL ORDER BY createdAt', gameId);
  const groups = new Map();
  for (const v of rows) {
    if (teamId && v.teamId !== Number(teamId)) continue;
    const k = `${v.teamId}|${v.net}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(v);
  }
  const teams = Object.fromEntries(votableTeams(gameId).map((t) => [t.id, `${t.roman} ${t.sectorName}`]));
  const out = [];
  for (const list of groups.values()) {
    if (list.length < min) continue;
    const verified = list.filter((v) => v.accountId);
    const keep = verified.length ? verified : [list[0]];
    const drop = list.filter((v) => !keep.includes(v));
    if (!drop.length) continue;
    const devices = new Set(list.map((v) => v.device)).size;
    const burst = list.slice(1).some((v, i) => v.createdAt - list[i].createdAt <= 3 * 60000);
    const uas = new Set(list.map((v) => uaShort(v.ua)));
    const why = [`${list.length} voti dalla stessa rete`, devices === list.length ? 'ogni volta un dispositivo nuovo (cookie cancellati o navigazione privata)' : `${devices} dispositivi`,
      burst ? 'voti a pochi minuti l\'uno dall\'altro' : null, uas.size === 1 ? `sempre ${[...uas][0]}` : null].filter(Boolean).join(' · ');
    out.push({ teamId: list[0].teamId, team: teams[list[0].teamId] || '?', net: list[0].net.slice(0, 8), votes: list.length, keep: keep.length, annul: drop.map((v) => v.id), why,
      strong: list.length >= 4 && devices === list.length });
  }
  out.sort((a, b) => b.annul.length - a.annul.length);
  const ids = out.flatMap((x) => x.annul);
  return { level, teamId: teamId ? Number(teamId) : null, groups: out, ids, preview: simulate(gameId, ids) };
}

// Premi: un Dono alla prima, alla seconda e alla terza coppia (quelli scelti dalla regia, o a caso), annuncio a tutti.
function awardPrizes(gameId, actor) {
  const g = G.getGame(gameId);
  if (g.votePrizedAt) throw err(409, 'Premi già assegnati');
  const top = results(g.id).list.filter((t) => t.score > 0).slice(0, 3);
  if (!top.length) throw err(409, 'Nessun voto: niente premi da assegnare');
  const medals = ['🥇', '🥈', '🥉'];
  const given = tx(() => top.map((t, i) => {
    const team = q.get('SELECT * FROM teams WHERE id = ?', t.id);
    const gift = SK().grantVirtualGift(team, `Favore del pubblico · ${i + 1}°`, g[`votePrize${i + 1}`] || null);
    rt.pushTeams(g.id, { title: `${medals[i]} Favore del pubblico: ${i + 1}° posto`, body: `Il pubblico vi ha votati (${t.pct}%): ${gift.icon} ${gift.name} è tra i vostri doni.`, tag: `vote-${g.id}`, url: '/#/doni' }, t.id);
    return { teamId: t.id, place: i + 1, pct: t.pct, gift: gift.name };
  }));
  q.run('UPDATE games SET votePrizedAt = ? WHERE id = ?', Date.now(), g.id);
  G.freeAnnouncement(g.id, `Il favore del pubblico: ${top.map((t, i) => `${medals[i]} ${t.roman} Settore ${t.sectorName} (${t.pct}%)`).join(' · ')}. Le prime tre coppie ricevono un Dono.`, actor);
  G.log(g.id, actor, 'vote_prized', { given });
  rt.toStaff(g.id, 'vote');
  rt.toTeams(g.id, 'state', {});
  return { given };
}

// Per l'app della coppia: la sua posizione nel voto del pubblico (se è tra le votabili della partita col voto acceso).
function teamVote(team) {
  if (!team || team.kind !== 'couple' || !team.votable) return null;
  const g = G.getGame(team.gameId);
  if (!g.voteEnabled) return null;
  const r = results(g.id);
  const i = r.list.findIndex((t) => t.id === team.id);
  if (i < 0) return null;
  const me = r.list[i];
  // A pari punteggio stessa posizione.
  const rank = r.list.filter((t) => t.score > me.score).length + 1;
  // Classifica completa per l'app (podio e lista): stessa posizione a pari punteggio, la propria coppia segnata.
  const ranking = r.list.map((t) => ({ id: t.id, roman: t.roman, sectorName: t.sectorName, displayName: t.displayName || null, color: t.color, logo: logoUrl(t), pct: t.pct,
    rank: t.score ? r.list.filter((x) => x.score > t.score).length + 1 : null, mine: t.id === team.id }));
  return { rank: me.score ? rank : null, pct: me.pct, of: r.list.length, open: isOpen(g), prizedAt: g.votePrizedAt || null, closesAt: closeAt(g), ranking };
}

// Per la pagina Regia (live): podio e percentuali, se il voto è acceso.
function liveVote(gameId) {
  const g = G.getGame(gameId);
  if (!g.voteEnabled) return null;
  const r = results(g.id);
  return { open: isOpen(g), prizedAt: g.votePrizedAt || null, closesAt: closeAt(g), total: r.total,
    votes: q.get('SELECT COUNT(*) AS n FROM votes WHERE gameId = ? AND annulledAt IS NULL', g.id).n,
    list: r.list.map((t) => ({ id: t.id, roman: t.roman, sectorName: t.sectorName, displayName: t.displayName || null, color: t.color, logo: logoUrl(t), pct: t.pct, score: t.score, votes: t.votes, heavy: t.heavy })) };
}

// Browser e sistema da user agent (per riconoscere a colpo d'occhio voti tutti uguali o automatici).
function uaShort(ua) {
  const u = String(ua || '');
  if (!u) return 'sconosciuto';
  if (/headless|phantom|puppeteer|playwright|selenium|curl|wget|python|node-fetch|axios|go-http|java\//i.test(u)) return '🤖 automatico';
  const os = /iPhone|iPad/.test(u) ? 'iPhone' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows' : /Mac OS X/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : 'altro';
  const br = /Instagram/.test(u) ? 'Instagram' : /FBAN|FBAV/.test(u) ? 'Facebook' : /WhatsApp/.test(u) ? 'WhatsApp' : /SamsungBrowser/.test(u) ? 'Samsung' : /EdgA?\//.test(u) ? 'Edge'
    : /Firefox|FxiOS/.test(u) ? 'Firefox' : /CriOS|Chrome/.test(u) ? 'Chrome' : /Safari/.test(u) ? 'Safari' : 'altro';
  return `${os} · ${br}`;
}

// Analisi dei voti di una coppia: da quali reti (impronta, non l'indirizzo), con quali dispositivi e browser, a che ritmo.
// Serve a capire se una crescita costante viene da tanta gente o da pochi che votano a ripetizione.
function voteAnalysis(gameId, teamId) {
  const g = G.getGame(gameId);
  const t = q.get("SELECT t.id, t.displayName, s.name AS sectorName, s.roman FROM teams t JOIN sectors s ON s.id = t.sectorId WHERE t.id = ? AND t.gameId = ?", Number(teamId), g.id);
  if (!t) throw err(404, 'Coppia non trovata');
  const all = q.all('SELECT v.*, a.name AS accountName, a.username FROM votes v LEFT JOIN accounts a ON a.id = v.accountId WHERE v.gameId = ? ORDER BY v.createdAt', g.id);
  const mine = all.filter((v) => v.teamId === t.id);
  const live = mine.filter((v) => !v.annulledAt);
  // Per rete: quanti voti in tutto, quanti a questa coppia, quanti ad altre.
  const nets = new Map();
  for (const v of all.filter((x) => !x.annulledAt)) {
    const n = nets.get(v.net) || { net: v.net, total: 0, toTeam: 0, first: v.createdAt, last: v.createdAt, devices: new Set() };
    n.total++; if (v.teamId === t.id) n.toTeam++; n.last = v.createdAt; n.devices.add(v.device);
    nets.set(v.net, n);
  }
  const byNet = [...nets.values()].filter((n) => n.toTeam).map((n) => ({ net: n.net.slice(0, 8), toTeam: n.toTeam, others: n.total - n.toTeam, devices: n.devices.size, first: n.first, last: n.last }))
    .sort((a, b) => b.toTeam - a.toTeam);
  const count = (key) => { const m = new Map(); for (const v of live) { const k = key(v); m.set(k, (m.get(k) || 0) + 1); } return [...m].map(([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n); };
  // Ritmo: intervalli tra un voto e l'altro (molto regolari = sospetto di voti a ripetizione).
  const gaps = live.slice(1).map((v, i) => v.createdAt - live[i].createdAt).sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  const byHour = count((v) => new Date(v.createdAt).toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', hour: '2-digit' }));
  const lonely = byNet.filter((n) => !n.others).reduce((a, n) => a + n.toTeam, 0);
  return {
    team: { id: t.id, label: `${t.roman} ${t.sectorName}`, name: t.displayName || null },
    totals: { votes: live.length, annulled: mine.length - live.length, verified: live.filter((v) => v.accountId).length, nets: byNet.length,
      devices: new Set(live.map((v) => v.device)).size, changed: live.filter((v) => v.updatedAt).length,
      // Voti da reti che hanno votato solo questa coppia (più di uno dalla stessa rete).
      sameNetRepeat: byNet.filter((n) => n.toTeam > 1).reduce((a, n) => a + n.toTeam, 0), onlyThisTeam: lonely,
      medianGapMin: median != null ? Math.round(median / 6000) / 10 : null },
    byNet, byUa: count((v) => uaShort(v.ua)), byHour: byHour.sort((a, b) => a.key.localeCompare(b.key)),
    votes: mine.slice().reverse().map((v) => ({ id: v.id, at: v.createdAt, changedAt: v.updatedAt || null, net: v.net.slice(0, 8), device: String(v.device).slice(0, 8),
      verified: !!v.accountId, account: v.accountName ? `${v.accountName}${v.username ? ` (@${v.username})` : ''}` : null, weight: v.weight, ua: uaShort(v.ua), uaFull: v.ua || '',
      netVotes: nets.get(v.net)?.total || 0, annulled: !!v.annulledAt })),
  };
}

module.exports = {
  simulate, suspicious, voteAnalysis, uaShort, netOf, setTorList, isTor, refreshTor, liveVote, teamVote, publicState, castVote, masterVote, updateVote, setVotable, annulVotes, awardPrizes, isOpen, VOTES_PER_NET, VERIFIED_WEIGHT };
