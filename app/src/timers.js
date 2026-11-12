'use strict';
// Timer della regia: servono per gestire gli eventi. Ogni timer ha titolo, descrizione e durata (ore e minuti).
// Stati: ready (da avviare), running (scade a endsAt), paused (restano leftMs), done (spento).
// Un timer «running» con endsAt passato sta suonando: suona su tutte le regie aperte (e manda una notifica push
// ai master); «Rimanda» lo fa ripartire per N minuti e «Spegni» lo chiude, per tutti i dispositivi insieme.
const { q } = require('./db');
const G = require('./game');
const rt = require('./realtime');
const { HttpError } = require('./util');

const err = (status, msg) => new HttpError(status, msg);
const MIN = 60000;
const MAX_MS = (23 * 60 + 59) * MIN;

const row = (gameId, id) => {
  const t = q.get('SELECT * FROM staff_timers WHERE id = ? AND gameId = ?', Number(id), Number(gameId));
  if (!t) throw err(404, 'Timer non trovato');
  return t;
};
const changed = (gameId) => { rt.toStaff(gameId, 'timers'); rt.toStaffEvent('timers', { gameId }); };

function readDuration(body) {
  const hours = Math.floor(Number(body.hours) || 0);
  const minutes = Math.floor(Number(body.minutes) || 0);
  if (hours < 0 || minutes < 0 || minutes > 59 || hours > 23) throw err(400, 'Durata non valida: ore da 0 a 23, minuti da 0 a 59');
  const ms = (hours * 60 + minutes) * MIN;
  if (ms < MIN) throw err(400, 'Il timer dura almeno un minuto');
  if (ms > MAX_MS) throw err(400, 'Il timer dura al massimo 23 ore e 59 minuti');
  return ms;
}
function readText(body) {
  const title = String(body.title || '').trim().slice(0, 80);
  if (!title) throw err(400, 'Scrivi il titolo del timer');
  return { title, description: String(body.description || '').trim().slice(0, 500) };
}

function list(gameId) {
  const now = Date.now();
  return q.all("SELECT * FROM staff_timers WHERE gameId = ? ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'paused' THEN 1 WHEN 'ready' THEN 2 ELSE 3 END, COALESCE(endsAt, createdAt), id", Number(gameId))
    .map((t) => ({ ...t, ringing: t.status === 'running' && t.endsAt <= now }));
}

function create(gameId, body, actor) {
  const g = G.getGame(gameId);
  const { title, description } = readText(body || {});
  const durationMs = readDuration(body || {});
  const now = Date.now();
  const start = !!body?.start;
  const id = Number(q.run('INSERT INTO staff_timers (gameId, title, description, durationMs, status, endsAt, createdAt, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    g.id, title, description, durationMs, start ? 'running' : 'ready', start ? now + durationMs : null, now, String(actor || '')).lastInsertRowid);
  G.log(g.id, actor, 'timer_created', { title, minutes: durationMs / MIN, start });
  changed(g.id);
  return { ok: true, id };
}

function update(gameId, id, body, actor) {
  const t = row(gameId, id);
  const { title, description } = readText(body || {});
  const durationMs = readDuration(body || {});
  // Il timer in corso non cambia scadenza: la nuova durata vale dal prossimo avvio (o da «Ricomincia»).
  q.run('UPDATE staff_timers SET title = ?, description = ?, durationMs = ? WHERE id = ?', title, description, durationMs, t.id);
  G.log(t.gameId, actor, 'timer_updated', { title });
  changed(t.gameId);
  return { ok: true };
}

// start: dall'inizio (anche per rifarlo dopo che è suonato); pause / resume; snooze: suona di nuovo tra N minuti;
// stop: spegne (anche mentre suona); add: aggiunge N minuti a un timer in corso.
function action(gameId, id, body, actor) {
  const t = row(gameId, id);
  const now = Date.now();
  const what = String(body?.action || '');
  const mins = Math.floor(Number(body?.minutes) || 0);
  if (what === 'start') {
    q.run("UPDATE staff_timers SET status = 'running', endsAt = ?, leftMs = NULL, notifiedAt = NULL, snoozes = 0, doneAt = NULL, doneBy = NULL WHERE id = ?", now + t.durationMs, t.id);
  } else if (what === 'pause') {
    if (t.status !== 'running' || t.endsAt <= now) throw err(409, 'Il timer non è in corso');
    q.run("UPDATE staff_timers SET status = 'paused', leftMs = ?, endsAt = NULL WHERE id = ?", t.endsAt - now, t.id);
  } else if (what === 'resume') {
    if (t.status !== 'paused') throw err(409, 'Il timer non è in pausa');
    q.run("UPDATE staff_timers SET status = 'running', endsAt = ?, leftMs = NULL WHERE id = ?", now + t.leftMs, t.id);
  } else if (what === 'snooze') {
    if (mins < 1 || mins > 120) throw err(400, 'Rimanda da 1 a 120 minuti');
    if (t.status !== 'running' || t.endsAt > now) throw err(409, 'Il timer non sta suonando');
    q.run("UPDATE staff_timers SET endsAt = ?, notifiedAt = NULL, snoozes = snoozes + 1 WHERE id = ?", now + mins * MIN, t.id);
  } else if (what === 'add') {
    if (mins < 1 || mins > 120) throw err(400, 'Aggiungi da 1 a 120 minuti');
    if (t.status === 'running') q.run('UPDATE staff_timers SET endsAt = ? WHERE id = ?', Math.max(t.endsAt, now) + mins * MIN, t.id);
    else if (t.status === 'paused') q.run('UPDATE staff_timers SET leftMs = leftMs + ? WHERE id = ?', mins * MIN, t.id);
    else throw err(409, 'Il timer non è in corso');
  } else if (what === 'stop') {
    q.run("UPDATE staff_timers SET status = 'done', endsAt = NULL, leftMs = NULL, doneAt = ?, doneBy = ? WHERE id = ?", now, String(actor || ''), t.id);
  } else throw err(400, 'Azione non valida');
  G.log(t.gameId, actor, `timer_${what}`, { title: t.title, ...(mins ? { minutes: mins } : {}) });
  changed(t.gameId);
  return { ok: true };
}

function remove(gameId, id, actor) {
  const t = row(gameId, id);
  q.run('DELETE FROM staff_timers WHERE id = ?', t.id);
  G.log(t.gameId, actor, 'timer_deleted', { title: t.title });
  changed(t.gameId);
  return { ok: true };
}

// Ogni pochi secondi: i timer appena scaduti avvisano tutte le regie (anche con la pagina chiusa, via push).
function tickAll() {
  const now = Date.now();
  for (const t of q.all("SELECT * FROM staff_timers WHERE status = 'running' AND endsAt <= ? AND (notifiedAt IS NULL OR notifiedAt < endsAt)", now)) {
    q.run('UPDATE staff_timers SET notifiedAt = ? WHERE id = ?', t.endsAt, t.id);
    rt.pushMasters({ title: `⏰ ${t.title}`, body: t.description || 'Il timer è scaduto', url: '/regia#timer', tag: `timer-${t.id}`, timer: true }, { silent: true });
    rt.toStaffEvent('timers', { gameId: t.gameId, ring: t.id });
  }
}

module.exports = { list, create, update, action, remove, tickAll };
