'use strict';
// Minigiochi veloci per sbloccare un Altare (coppie) o completare un Beacon (Eletti), se la regia li ha abilitati.
// Il server sceglie il gioco (quello impostato o a caso), ne genera i parametri e, per quelli verificabili
// («Ripeti il segnale», «Ricorda il codice»), controlla la risposta. Chi sbaglia riprova dopo una breve attesa.
// Un minigioco superato vale: per l'Altare finché vale la scansione; per il Beacon per 10 minuti, una volta.
const crypto = require('crypto');
const { q } = require('./db');
const G = require('./game');
const { HttpError } = require('./util');

const GAMES = {
  simon: { name: 'Ripeti il segnale', hint: 'Guardate la sequenza di luci, poi ripetetela toccando gli stessi colori.' },
  memoria: { name: 'Ricorda il codice', hint: 'Memorizzate le cifre che compaiono per pochi secondi, poi scrivetele.' },
  tempo: { name: 'Ferma al momento giusto', hint: 'Toccate quando l\'indicatore è nella zona luminosa: 3 volte su 4 tentativi.' },
  ordine: { name: 'Tocca in ordine', hint: 'Toccate i numeri da 1 a 9 in ordine, prima che finisca il tempo.' },
};
const MODES = ['off', 'random', ...Object.keys(GAMES)];
const RETRY_MS = 10000;
const BEACON_VALID_MS = 10 * 60000;

const rint = (n) => crypto.randomInt(n);
function challenge(game) {
  if (game === 'simon') { const seq = Array.from({ length: 5 }, () => rint(4)); return { params: { seq, pads: 4 }, answer: seq.join('') }; }
  if (game === 'memoria') { const code = Array.from({ length: 5 }, () => rint(10)).join(''); return { params: { code, showMs: 3000 }, answer: code }; }
  if (game === 'tempo') return { params: { rounds: 4, need: 3, zone: 0.18 }, answer: null };
  return { params: { n: 9, seconds: 12 }, answer: null };
}
const cleanMode = (v) => (MODES.includes(v) ? v : 'off');

// Minigiochi spenti dalla regia: non escono a caso e non si usano anche se scelti (si passa a uno acceso a caso).
const offList = (g) => { try { return new Set(JSON.parse(g?.minigamesOff || '[]')); } catch { return new Set(); } };
const enabledGames = (g) => Object.keys(GAMES).filter((k) => !offList(g).has(k));
// Che minigioco serve per quel bersaglio: 'off' = nessuno.
function modeFor(g, ref) {
  let mode;
  if (ref.startsWith('altar:')) {
    const p = q.get('SELECT minigame FROM points WHERE id = ?', Number(ref.slice(6)));
    mode = cleanMode(p?.minigame || g.altarMinigame || 'off');
  } else mode = cleanMode(g.beaconMinigame || 'off');
  if (mode === 'off') return 'off';
  if (!enabledGames(g).length) return 'off';
  return mode !== 'random' && offList(g).has(mode) ? 'random' : mode;
}
// Accende o spegne un minigioco per la partita.
function setEnabled(gameId, game, on, actor) {
  const g = G.getGame(gameId);
  if (!GAMES[game]) throw new HttpError(404, 'Minigioco non trovato');
  const off = offList(g);
  if (on) off.delete(game); else off.add(game);
  q.run('UPDATE games SET minigamesOff = ? WHERE id = ?', off.size ? JSON.stringify([...off]) : null, g.id);
  G.log(g.id, actor, on ? 'minigame_enabled' : 'minigame_disabled', { game: GAMES[game].name });
  return list(G.getGame(g.id));
}
// Per la regia: i minigiochi con lo stato e dove si usano.
const list = (g) => ({ games: Object.entries(GAMES).map(([id, x]) => ({ id, ...x, enabled: !offList(g).has(id) })), altar: g.altarMinigame || 'off', beacon: g.beaconMinigame || 'off',
  altarsCustom: q.get('SELECT COUNT(*) AS n FROM points WHERE gameId = ? AND minigame IS NOT NULL', g.id).n });

// Da chiamare prima dell'azione: null se non serve o è già superato; altrimenti la sfida da giocare.
// since: per l'Altare, il momento della scansione (il minigioco vale solo dopo di essa).
function gate({ g, ref, teamId, playerId = null, since = 0 }) {
  const mode = modeFor(g, ref);
  if (mode === 'off') return null;
  const who = playerId ? 'playerId = ?' : 'teamId = ?';
  const id = playerId || teamId;
  const passed = ref.startsWith('beacon:')
    ? q.get(`SELECT * FROM minigame_runs WHERE gameId = ? AND ref = ? AND ${who} AND passedAt IS NOT NULL AND usedAt IS NULL AND passedAt > ? ORDER BY id DESC LIMIT 1`, g.id, ref, id, Date.now() - BEACON_VALID_MS)
    : q.get(`SELECT * FROM minigame_runs WHERE gameId = ? AND ref = ? AND ${who} AND passedAt IS NOT NULL AND passedAt >= ? ORDER BY id DESC LIMIT 1`, g.id, ref, id, since);
  if (passed) return { passed };
  // Una sfida ancora aperta (non giocata) si ripropone; dopo un errore si aspetta un attimo.
  const open = q.get(`SELECT * FROM minigame_runs WHERE gameId = ? AND ref = ? AND ${who} AND doneAt IS NULL AND createdAt > ? ORDER BY id DESC LIMIT 1`, g.id, ref, id, Date.now() - 10 * 60000);
  if (open) return { minigame: out(open) };
  const failed = q.get(`SELECT doneAt FROM minigame_runs WHERE gameId = ? AND ref = ? AND ${who} AND doneAt IS NOT NULL AND passedAt IS NULL ORDER BY id DESC LIMIT 1`, g.id, ref, id);
  const retryAt = failed ? failed.doneAt + RETRY_MS : 0;
  const keys = enabledGames(g);
  const game = mode === 'random' ? keys[rint(keys.length)] : mode;
  const c = challenge(game);
  const runId = Number(q.run('INSERT INTO minigame_runs (gameId, ref, teamId, playerId, game, params, answer, createdAt, notBefore) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    g.id, ref, teamId, playerId, game, JSON.stringify(c.params), c.answer, Date.now(), retryAt || null).lastInsertRowid);
  return { minigame: out(q.get('SELECT * FROM minigame_runs WHERE id = ?', runId)) };
}
const out = (r) => ({ id: r.id, game: r.game, name: GAMES[r.game].name, hint: GAMES[r.game].hint, params: JSON.parse(r.params), notBefore: r.notBefore || null });
// Il Beacon consuma il minigioco superato.
const use = (run) => run && q.run('UPDATE minigame_runs SET usedAt = ? WHERE id = ?', Date.now(), run.id);

// Risposta del telefono: verificata dove si può («Ripeti il segnale», «Ricorda il codice»).
function done(team, player, runId, body) {
  const r = q.get('SELECT * FROM minigame_runs WHERE id = ?', Number(runId));
  if (!r || r.teamId !== team.id || (r.playerId && r.playerId !== player?.id)) throw new HttpError(404, 'Minigioco non trovato');
  if (r.doneAt) return { ok: !!r.passedAt, already: true };
  if (r.notBefore && Date.now() < r.notBefore) throw new HttpError(429, 'Aspettate qualche secondo prima di riprovare');
  const answer = String(body?.answer ?? '').replace(/\D/g, '');
  const ok = r.answer != null ? answer === r.answer : !!body?.ok;
  const now = Date.now();
  q.run('UPDATE minigame_runs SET doneAt = ?, passedAt = ? WHERE id = ?', now, ok ? now : null, r.id);
  G.log(r.gameId, player ? `giocatore:${player.id}` : `coppia:${team.id}`, ok ? 'minigame_passed' : 'minigame_failed', { game: GAMES[r.game].name, ref: r.ref });
  return { ok, retryAt: ok ? null : now + RETRY_MS };
}

module.exports = { GAMES, MODES, cleanMode, gate, done, use, modeFor, setEnabled, list, challenge };
