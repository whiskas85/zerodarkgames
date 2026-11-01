'use strict';
// Voto del pubblico: un link da condividere (/vota) dove chiunque vota la sua coppia preferita tra quelle scelte dalla
// regia, solo prima della partita. Si vedono solo le percentuali e il podio. Difese contro i voti gonfiati:
// un voto per dispositivo (cookie), al massimo VOTES_PER_NET voti all'ora dalla stessa rete, verifica anti-robot
// (Cloudflare Turnstile, se configurata), voto «verificato» (con account) che pesa di più, segnalazione dei picchi.
const crypto = require('crypto');
const { q, tx, getSetting, setSetting } = require('./db');
const G = require('./game');
const rt = require('./realtime');
const { HttpError } = require('./util');

const err = (status, msg) => new HttpError(status, msg);
const SK = () => require('./skills');

const PRE = ['created', 'draft', 'ready'];
const VOTES_PER_NET = 3; // voti (dispositivi diversi) all'ora dalla stessa rete
const VERIFIED_WEIGHT = 3; // chi vota con l'account dei Giochi (o Zero Dark Ops)
const SPIKE_MIN = 5; // segnalazione: almeno 5 voti dalla stessa rete in 10 minuti
const SPIKE_MS = 10 * 60000;

const netHash = (ip) => crypto.createHash('sha256').update(`zdg-vote:${String(ip || '').replace(/^::ffff:/, '')}`).digest('hex').slice(0, 16);
const turnstile = () => ({ siteKey: process.env.TURNSTILE_SITE_KEY || getSetting('turnstileSiteKey') || null, secret: process.env.TURNSTILE_SECRET || getSetting('turnstileSecret') || null });

// La partita del voto: quella con il voto acceso (la più recente).
const voteGame = () => q.get('SELECT * FROM games WHERE voteEnabled = 1 ORDER BY id DESC LIMIT 1');
const isOpen = (g, now = Date.now()) => !!g && !!g.voteEnabled && PRE.includes(g.status) && (!g.voteOpensAt || g.voteOpensAt <= now) && (!g.voteClosesAt || g.voteClosesAt > now) && !g.votePrizedAt;

function votableTeams(gameId) {
  return q.all(`SELECT t.id, t.displayName, t.logoAt, s.name AS sectorName, s.roman, s.color FROM teams t JOIN sectors s ON s.id = t.sectorId
                WHERE t.gameId = ? AND t.kind = 'couple' AND t.votable = 1 AND t.status != 'withdrawn' ORDER BY s.ord, t.id`, gameId);
}
// Per il pubblico: solo il nome di battaglia (o il nome), niente foto delle persone.
const membersOf = (teamId) => q.all('SELECT p.name, p.nickname FROM players p WHERE p.teamId = ? ORDER BY p.id', teamId)
  .map((p) => ({ name: p.nickname || p.name.split(' ')[0] }));
const logoUrl = (t) => (t.logoAt ? `/api/public/team-logo/${t.id}?v=${t.logoAt}` : null);

// Punteggi (pesati, senza i voti annullati) → percentuali e classifica.
function results(gameId) {
  const teams = votableTeams(gameId);
  const sum = Object.fromEntries(q.all('SELECT teamId, SUM(weight) AS w, COUNT(*) AS n FROM votes WHERE gameId = ? AND annulledAt IS NULL GROUP BY teamId', gameId).map((r) => [r.teamId, r]));
  const total = teams.reduce((a, t) => a + (sum[t.id]?.w || 0), 0);
  const list = teams.map((t) => ({ ...t, score: sum[t.id]?.w || 0, votes: sum[t.id]?.n || 0, pct: total ? Math.round(((sum[t.id]?.w || 0) / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.score - a.score || a.id - b.id);
  return { total, list };
}

// Pagina pubblica: niente numeri assoluti, solo percentuali.
function publicState(device, account) {
  const g = voteGame();
  if (!g) return { game: null };
  const r = results(g.id);
  const mine = (account && q.get('SELECT teamId FROM votes WHERE gameId = ? AND accountId = ? AND annulledAt IS NULL', g.id, account.id))
    || (device && q.get('SELECT teamId FROM votes WHERE gameId = ? AND device = ? AND annulledAt IS NULL', g.id, device));
  const out = (t) => ({ id: t.id, roman: t.roman, sectorName: t.sectorName, color: t.color, displayName: t.displayName || null, logo: logoUrl(t), members: membersOf(t.id), pct: t.pct });
  return {
    game: { name: g.name, scheduledStart: g.scheduledStart || null },
    open: isOpen(g), opensAt: g.voteOpensAt || null, closesAt: g.voteClosesAt || null, closed: !!g.votePrizedAt || !PRE.includes(g.status),
    title: g.voteTitle || 'Il favore del pubblico',
    teams: r.list.map(out),
    podium: r.total ? r.list.slice(0, 3).filter((t) => t.score > 0).map(out) : [],
    myVote: mine?.teamId || null,
    verified: !!account, weight: account ? VERIFIED_WEIGHT : 1,
    turnstile: turnstile().siteKey,
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
async function castVote({ teamId, token, device, account, ip, ua }, now = Date.now()) {
  const g = voteGame();
  if (!g) throw err(404, 'Nessuna votazione in corso');
  if (!isOpen(g, now)) throw err(409, g.votePrizedAt || !PRE.includes(g.status) ? 'Votazione chiusa' : 'La votazione non è aperta in questo momento');
  if (!device) throw err(400, 'Dispositivo non riconosciuto: abilita i cookie e riprova');
  const t = votableTeams(g.id).find((x) => x.id === Number(teamId));
  if (!t) throw err(400, 'Coppia non votabile');
  const net = netHash(ip);
  const existing = (account && q.get('SELECT * FROM votes WHERE gameId = ? AND accountId = ? AND annulledAt IS NULL', g.id, account.id))
    || q.get('SELECT * FROM votes WHERE gameId = ? AND device = ? AND annulledAt IS NULL', g.id, device);
  // Limite per rete: solo per i voti nuovi (cambiare il proprio voto è sempre permesso).
  if (!existing && q.get('SELECT COUNT(*) AS n FROM votes WHERE gameId = ? AND net = ? AND createdAt > ?', g.id, net, now - 3600000).n >= VOTES_PER_NET) {
    throw err(429, 'Troppi voti da questa connessione: riprova più tardi o da un\'altra rete');
  }
  await checkTurnstile(token, ip);
  const weight = account ? VERIFIED_WEIGHT : 1;
  tx(() => {
    if (existing) q.run('UPDATE votes SET teamId = ?, weight = MAX(weight, ?), accountId = COALESCE(accountId, ?), updatedAt = ? WHERE id = ?', t.id, weight, account?.id ?? null, now, existing.id);
    else q.run('INSERT INTO votes (gameId, teamId, device, net, accountId, weight, ua, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', g.id, t.id, device, net, account?.id ?? null, weight, String(ua || '').slice(0, 160), now);
  });
  rt.toStaff(g.id, 'vote');
  return publicState(device, account);
}

// ---------------------------------------------------------------- regia

// Picchi sospetti: tanti voti dalla stessa rete in poco tempo (finestre di 10 minuti).
function spikes(gameId) {
  const rows = q.all('SELECT id, teamId, net, createdAt FROM votes WHERE gameId = ? AND annulledAt IS NULL ORDER BY net, createdAt', gameId);
  const out = [];
  for (let i = 0; i < rows.length;) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].net === rows[i].net && rows[j + 1].createdAt - rows[i].createdAt <= SPIKE_MS) j++;
    if (j - i + 1 >= SPIKE_MIN) {
      const group = rows.slice(i, j + 1);
      const byTeam = {};
      for (const v of group) byTeam[v.teamId] = (byTeam[v.teamId] || 0) + 1;
      out.push({ net: rows[i].net.slice(0, 6), from: group[0].createdAt, to: group.at(-1).createdAt, count: group.length, ids: group.map((v) => v.id), byTeam });
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
    prizes: [g.votePrize1 || null, g.votePrize2 || null, g.votePrize3 || null], prizedAt: g.votePrizedAt || null,
    turnstile: !!turnstile().secret && !!turnstile().siteKey, turnstileSiteKey: turnstile().siteKey || '', turnstileFromEnv: !!process.env.TURNSTILE_SECRET,
    giftTypes: SK().GIFTS.filter(SK().availableGift).map((x) => ({ id: x.id, name: x.name, icon: x.icon, color: x.color || null,
      description: String(x.description || '').replace('{durata}', x.durationMin || '').replace('{raggio}', x.radiusM || '') })),
    total: r.total,
    votes: q.get('SELECT COUNT(*) AS n, SUM(accountId IS NOT NULL) AS verified FROM votes WHERE gameId = ? AND annulledAt IS NULL', g.id),
    annulled: q.get('SELECT COUNT(*) AS n FROM votes WHERE gameId = ? AND annulledAt IS NOT NULL', g.id).n,
    teams: q.all("SELECT t.id, t.votable, t.displayName, s.name AS sectorName, s.roman, s.color FROM teams t JOIN sectors s ON s.id = t.sectorId WHERE t.gameId = ? AND t.kind = 'couple' AND t.status != 'withdrawn' ORDER BY s.ord, t.id", g.id)
      .map((t) => { const x = r.list.find((y) => y.id === t.id); return { ...t, votable: !!t.votable, pct: x?.pct || 0, votes: x?.votes || 0, score: x?.score || 0 }; }),
    ranking: r.list.map((t) => ({ id: t.id, roman: t.roman, sectorName: t.sectorName, pct: t.pct, votes: t.votes, score: t.score })),
    spikes: spikes(g.id),
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
  return { rank: me.score ? rank : null, pct: me.pct, of: r.list.length, open: isOpen(g), prizedAt: g.votePrizedAt || null, closesAt: g.voteClosesAt || null };
}

// Per la pagina Regia (live): podio e percentuali, se il voto è acceso.
function liveVote(gameId) {
  const g = G.getGame(gameId);
  if (!g.voteEnabled) return null;
  const r = results(g.id);
  return { open: isOpen(g), prizedAt: g.votePrizedAt || null, closesAt: g.voteClosesAt || null, total: r.total,
    votes: q.get('SELECT COUNT(*) AS n FROM votes WHERE gameId = ? AND annulledAt IS NULL', g.id).n,
    list: r.list.map((t) => ({ id: t.id, roman: t.roman, sectorName: t.sectorName, displayName: t.displayName || null, color: t.color, logo: logoUrl(t), pct: t.pct, score: t.score })) };
}

module.exports = { liveVote, teamVote, publicState, castVote, masterVote, updateVote, setVotable, annulVotes, awardPrizes, isOpen, VOTES_PER_NET, VERIFIED_WEIGHT };
