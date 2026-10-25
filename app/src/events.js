// Eventi: sfide proposte dalla regia alle coppie.
// Candidatura «Accetto la sfida» (una coppia = un posto) o di un'alleanza intera (ogni coppia alleata conferma);
// a fine prove la regia o la squadra di Eletti custode chiude l'evento: ogni coppia conferma la chiusura e
// prende subito il premio; quando hanno confermato tutte (o allo scadere del tempo) parte la tregua tra i partecipanti.
const { q, tx } = require('./db');
const G = require('./game');
const rt = require('./realtime');
const { HttpError, shuffle } = require('./util');

const err = (status, msg) => new HttpError(status, msg);
const SK = () => require('./skills');
const K = () => require('./combat');

const REWARDS = { gift: 'Un Dono', fragment: 'Un frammento della Parola', code: 'Un Sigillo (codice)' };
const LIVE = ['open', 'running', 'closing', 'truce'];

function team(id) {
  return q.get('SELECT t.*, s.name AS sectorName, s.roman FROM teams t LEFT JOIN sectors s ON s.id = t.sectorId WHERE t.id = ?', Number(id));
}
const teamLite = (t) => (t ? { teamId: t.id, sectorName: t.sectorName, roman: t.roman, displayName: t.displayName } : null);
const getEvent = (id) => q.get('SELECT * FROM game_events WHERE id = ?', Number(id));
const entriesOf = (eventId) => q.all('SELECT * FROM event_entries WHERE eventId = ? ORDER BY joinedAt', eventId);
const accepted = (eventId) => q.all("SELECT * FROM event_entries WHERE eventId = ? AND status = 'accepted' ORDER BY joinedAt", eventId);
const used = (eventId) => q.get('SELECT COUNT(*) AS n FROM event_entries WHERE eventId = ?', eventId).n;
const candidaturesOpen = (ev, now = Date.now()) => ev.status === 'open' && (!ev.openUntil || ev.openUntil > now);
const squadName = (id) => (id ? q.get('SELECT name FROM elect_squads WHERE id = ?', id)?.name || null : null);

// Aggiornamento a telefoni e regia: le coppie coinvolte, gli Eletti e la pagina Eventi della regia.
function changed(ev) {
  rt.toTeams(ev.gameId, 'state', {});
  rt.toStaff(ev.gameId, 'events');
}
function pushTeamsOf(ev, teamIds, payload) {
  for (const id of new Set(teamIds)) rt.pushTeams(ev.gameId, { tag: `evento-${ev.id}`, url: `/#/eventi/${ev.id}`, ...payload }, id);
}
function pushSquad(ev, payload) {
  if (!ev.squadId) return;
  const subs = q.all('SELECT ps.* FROM push_subs ps JOIN players p ON p.id = ps.playerId WHERE p.squadId = ?', ev.squadId);
  rt.pushSubs(subs, { tag: `evento-${ev.id}`, url: `/#/eventi/${ev.id}`, ...payload });
}

// ---------------------------------------------------------------- regia

function createEvent(gameId, data, actor) {
  const g = G.getGame(gameId);
  const name = String(data.name || '').trim().slice(0, 80);
  if (!name) throw err(400, 'Dai un nome all\'evento');
  const slots = Math.round(Number(data.slots));
  if (!(slots >= 1 && slots <= 20)) throw err(400, 'Capienza: da 1 a 20 coppie');
  const rewardKind = REWARDS[data.rewardKind] ? data.rewardKind : 'gift';
  const rewardGiftType = rewardKind === 'gift' && data.rewardGiftType && SK().giftById(data.rewardGiftType) ? data.rewardGiftType : null;
  let squadId = Number(data.squadId) || null;
  if (squadId && !q.get('SELECT 1 FROM elect_squads WHERE id = ? AND gameId = ?', squadId, g.id)) squadId = null;
  const windowMin = Number(data.windowMin) || 0;
  const num = (v, def, min, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : def; };
  const now = Date.now();
  // launch: proposto subito alle coppie; altrimenti resta «da lanciare», visibile solo in regia.
  const id = Number(q.run(`INSERT INTO game_events (gameId, name, description, squadId, slots, rewardKind, rewardGiftType, windowMin, confirmMin, truceMin, status, createdAt, author)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
  g.id, name, String(data.description || '').trim().slice(0, 2000) || null, squadId, slots, rewardKind, rewardGiftType,
  windowMin > 0 ? windowMin : null, num(data.confirmMin, 3, 1, 60), num(data.truceMin, 5, 0, 60), now, actor || null).lastInsertRowid);
  if (data.location) writeLocation(id, data.location);
  writeSchedule(id, data);
  G.log(g.id, actor, 'event_created', { name, slots, launch: !!data.launch });
  if (data.launch) return launchEvent(id, actor);
  changed(getEvent(id));
  return masterEvent(getEvent(id));
}

// Orario: startAt (istante in ms o data leggibile; vuoto = parte a mano) e durationMin (vuoto = senza durata).
function readSchedule(data, ev = {}) {
  let startAt = ev.startAt ?? null;
  if (data.startAt !== undefined) {
    if (data.startAt === null || data.startAt === '') startAt = null;
    else {
      const t = typeof data.startAt === 'number' ? data.startAt : Date.parse(data.startAt);
      if (!Number.isFinite(t)) throw err(400, 'Orario di inizio non valido');
      startAt = t;
    }
  }
  let durationMin = ev.durationMin ?? null;
  if (data.durationMin !== undefined) {
    const n = Math.round(Number(data.durationMin));
    durationMin = data.durationMin === null || data.durationMin === '' || !n ? null : Math.max(1, Math.min(600, n));
  }
  return { startAt, durationMin };
}
function writeSchedule(id, data) {
  const ev = getEvent(id);
  const sc = readSchedule(data, ev);
  q.run('UPDATE game_events SET startAt = ?, durationMin = ?, endNotifiedAt = CASE WHEN ? IS durationMin THEN endNotifiedAt ELSE NULL END WHERE id = ?', sc.startAt, sc.durationMin, sc.durationMin, id);
}
function setSchedule(id, data, actor) {
  const ev = getEvent(id);
  if (!ev) throw err(404, 'Evento non trovato');
  writeSchedule(ev.id, data || {});
  const nx = getEvent(ev.id);
  G.log(ev.gameId, actor, 'event_schedule', { name: ev.name, startAt: nx.startAt, durationMin: nx.durationMin });
  changed(ev);
  return masterEvent(nx);
}
// Fine prevista: dall'avvio vero (o dall'orario d'inizio) più la durata.
const endsAtOf = (ev) => (ev.durationMin ? (ev.startedAt || ev.startAt || 0) + ev.durationMin * 60000 || null : null);

// Luogo: { label, lat, lng } oppure null per toglierlo.
function readLocation(loc) {
  if (!loc) return { label: null, lat: null, lng: null };
  const lat = Number(loc.lat); const lng = Number(loc.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw err(400, 'Luogo non valido');
  return { label: String(loc.label || '').trim().slice(0, 80) || 'Luogo dell\'evento', lat, lng };
}
function writeLocation(id, loc) {
  const l = readLocation(loc);
  q.run('UPDATE game_events SET locLabel = ?, locLat = ?, locLng = ? WHERE id = ?', l.label, l.lat, l.lng, id);
}
function setLocation(id, loc, actor) {
  const ev = getEvent(id);
  if (!ev) throw err(404, 'Evento non trovato');
  writeLocation(ev.id, loc);
  G.log(ev.gameId, actor, 'event_location', { name: ev.name, place: loc?.label || null });
  changed(ev);
  return masterEvent(getEvent(ev.id));
}

// Lancio: l'evento arriva a tutte le coppie (notifica) e alla squadra custode; da qui corre la finestra di candidatura.
function launchEvent(id, actor) {
  const ev = getEvent(id);
  if (!ev) throw err(404, 'Evento non trovato');
  if (ev.status !== 'draft') throw err(409, 'Evento già lanciato');
  const now = Date.now();
  q.run("UPDATE game_events SET status = 'open', launchedAt = ?, openUntil = ? WHERE id = ?", now, ev.windowMin ? now + ev.windowMin * 60000 : null, ev.id);
  G.log(ev.gameId, actor, 'event_launched', { name: ev.name });
  rt.pushTeams(ev.gameId, { title: `Evento · ${ev.name}`, body: `Sfida per ${ev.slots} ${ev.slots === 1 ? 'coppia' : 'coppie'}: toccate per accettarla.`, tag: `evento-${ev.id}`, url: `/#/eventi/${ev.id}` });
  pushSquad(ev, { title: `Evento affidato alla vostra squadra · ${ev.name}`, body: 'Lo seguite voi sul campo e lo chiudete a fine prove.' });
  changed(ev);
  return masterEvent(getEvent(ev.id));
}

function deleteEvent(id, actor) {
  const ev = getEvent(id);
  if (!ev) throw err(404, 'Evento non trovato');
  q.run('DELETE FROM game_events WHERE id = ?', ev.id);
  G.log(ev.gameId, actor, 'event_deleted', { name: ev.name });
  changed(ev);
}

// Chi può avviare e chiudere: la regia, o gli Eletti della squadra custode.
function canManage(ev, who) {
  if (who.master) return true;
  return !!(who.player?.squadId && who.player.squadId === ev.squadId && who.player.gameId === ev.gameId);
}

function startEvent(id, who) {
  return tx(() => {
    const ev = getEvent(id);
    if (!ev) throw err(404, 'Evento non trovato');
    if (!canManage(ev, who)) throw err(403, 'L\'evento lo avvia la regia o la squadra di Eletti che lo custodisce');
    if (ev.status === 'draft') throw err(409, 'Prima lancia l\'evento alle coppie');
    if (ev.status !== 'open') throw err(409, 'Evento già avviato');
    // Le candidature di alleanza non confermate da tutti decadono.
    dropPendingGroups(ev);
    const list = accepted(ev.id);
    if (!list.length) throw err(409, 'Nessuna coppia ha accettato la sfida');
    q.run("UPDATE game_events SET status = 'running', startedAt = ? WHERE id = ?", Date.now(), ev.id);
    G.log(ev.gameId, who.actor, 'event_started', { name: ev.name, teams: list.length });
    pushTeamsOf(ev, list.map((e) => e.teamId), { title: `Evento iniziato · ${ev.name}`, body: `Al termine dell'evento scatterà una tregua obbligatoria di ${ev.truceMin} minuti tra i partecipanti.` });
    changed(ev);
    return { ok: true };
  });
}

// outcomes: { teamId: 'won' | 'lost' } deciso da chi chiude; chi non è indicato ha vinto.
function closeEvent(id, who, outcomes = {}) {
  return tx(() => {
    const ev = getEvent(id);
    if (!ev) throw err(404, 'Evento non trovato');
    if (!canManage(ev, who)) throw err(403, 'L\'evento lo chiude la regia o la squadra di Eletti che lo custodisce');
    if (ev.status === 'open') startEvent(id, who);
    else if (ev.status !== 'running') throw err(409, 'Evento già chiuso');
    const now = Date.now();
    q.run("UPDATE game_events SET status = 'closing', closingAt = ?, closeDeadline = ?, closedBy = ? WHERE id = ?", now, now + ev.confirmMin * 60000, who.actor || null, ev.id);
    const list = accepted(ev.id);
    for (const e of list) q.run('UPDATE event_entries SET outcome = ? WHERE eventId = ? AND teamId = ?', outcomes?.[e.teamId] === 'lost' ? 'lost' : 'won', ev.id, e.teamId);
    const lost = list.filter((e) => outcomes?.[e.teamId] === 'lost').map((e) => e.teamId);
    G.log(ev.gameId, who.actor, 'event_closing', { name: ev.name, won: list.length - lost.length, lost: lost.length });
    pushTeamsOf(ev, list.map((e) => e.teamId).filter((t) => !lost.includes(t)), { title: `Sfida vinta · ${ev.name}`, body: `Confermate la chiusura nell'app entro ${ev.confirmMin} minuti per ricevere il premio.` });
    pushTeamsOf(ev, lost, { title: `Sfida persa · ${ev.name}`, body: 'Niente premio questa volta. Confermate la chiusura nell\'app.' });
    changed(ev);
    return { ok: true };
  });
}

// ---------------------------------------------------------------- coppie

function requireCouple(t) {
  if (!t || t.kind !== 'couple') throw err(403, 'Gli eventi sono per le coppie');
  if (t.status === 'withdrawn') throw err(409, 'Coppia ritirata');
}

// Candidatura: la coppia da sola, o con alliance tutta l'alleanza (le altre coppie devono confermare).
// Una coppia invitata dalla sua alleanza accetta con la stessa chiamata.
function joinEvent(me, player, id, { alliance = false } = {}) {
  requireCouple(me);
  return tx(() => {
    const ev = getEvent(id);
    if (!ev || ev.gameId !== me.gameId) throw err(404, 'Evento non trovato');
    if (!candidaturesOpen(ev)) throw err(409, 'Candidature chiuse');
    const by = player ? [player.name, player.nickname ? `«${player.nickname}»` : null].filter(Boolean).join(' ') : null;
    const mine = q.get('SELECT * FROM event_entries WHERE eventId = ? AND teamId = ?', ev.id, me.id);
    if (mine) {
      if (mine.status === 'pending') {
        q.run("UPDATE event_entries SET status = 'accepted', joinedAt = ?, joinedBy = ? WHERE eventId = ? AND teamId = ?", Date.now(), by, ev.id, me.id);
        const group = q.all('SELECT * FROM event_entries WHERE eventId = ? AND groupId = ?', ev.id, mine.groupId);
        if (group.every((e) => e.status === 'accepted' || e.teamId === me.id)) {
          pushTeamsOf(ev, group.map((e) => e.teamId), { title: `Evento · ${ev.name}`, body: 'Tutta l\'alleanza ha accettato la sfida.' });
        }
      }
      changed(ev);
      return { ok: true };
    }
    const free = ev.slots - used(ev.id);
    const now = Date.now();
    if (alliance) {
      const a = K().allianceOf(me.id);
      if (!a || a.members.length < 2) throw err(409, 'Non siete in un\'alleanza');
      const others = a.members.filter((t) => t !== me.id && !q.get('SELECT 1 FROM event_entries WHERE eventId = ? AND teamId = ?', ev.id, t));
      if (others.length + 1 > free) throw err(409, free ? `L'alleanza supera i posti rimasti (${free}): può candidarsi solo una coppia da sola` : 'Evento al completo');
      q.run("INSERT INTO event_entries (eventId, teamId, groupId, status, joinedAt, joinedBy) VALUES (?, ?, ?, 'accepted', ?, ?)", ev.id, me.id, me.id, now, by);
      for (const t of others) q.run("INSERT INTO event_entries (eventId, teamId, groupId, status, joinedAt) VALUES (?, ?, ?, 'pending', ?)", ev.id, t, me.id, now);
      pushTeamsOf(ev, others, { title: `Evento · ${ev.name}`, body: `Il Settore ${me.sectorName} ha candidato la vostra alleanza: confermate nell'app.` });
    } else {
      if (free < 1) throw err(409, 'Evento al completo');
      q.run("INSERT INTO event_entries (eventId, teamId, status, joinedAt, joinedBy) VALUES (?, ?, 'accepted', ?, ?)", ev.id, me.id, now, by);
    }
    G.log(me.gameId, `coppia:${me.id}`, 'event_joined', { name: ev.name, alliance: !!alliance });
    changed(ev);
    return { ok: true };
  });
}

// Ritiro (o rifiuto dell'invito dell'alleanza): una candidatura di alleanza decade per tutte le coppie.
function leaveEvent(me, id) {
  requireCouple(me);
  return tx(() => {
    const ev = getEvent(id);
    const mine = ev && q.get('SELECT * FROM event_entries WHERE eventId = ? AND teamId = ?', ev.id, me.id);
    if (!mine) throw err(404, 'Non siete iscritti a questo evento');
    if (ev.status !== 'open') throw err(409, 'L\'evento è già iniziato');
    if (mine.groupId) {
      const group = q.all('SELECT teamId FROM event_entries WHERE eventId = ? AND groupId = ?', ev.id, mine.groupId).map((e) => e.teamId);
      q.run('DELETE FROM event_entries WHERE eventId = ? AND groupId = ?', ev.id, mine.groupId);
      pushTeamsOf(ev, group.filter((t) => t !== me.id), { title: `Evento · ${ev.name}`, body: `Il Settore ${me.sectorName} si è tirato indietro: la candidatura dell'alleanza è decaduta.` });
    } else q.run('DELETE FROM event_entries WHERE eventId = ? AND teamId = ?', ev.id, me.id);
    changed(ev);
    return { ok: true };
  });
}

function dropPendingGroups(ev) {
  for (const { groupId } of q.all("SELECT DISTINCT groupId FROM event_entries WHERE eventId = ? AND status = 'pending' AND groupId IS NOT NULL", ev.id)) {
    q.run('DELETE FROM event_entries WHERE eventId = ? AND groupId = ?', ev.id, groupId);
  }
}

// Il premio, per ogni coppia: un Dono (di un tipo scelto o a caso), un frammento che non ha, un Sigillo che non conosce.
// Se non c'è più nulla da darle di quel tipo riceve un Dono a caso.
function giveReward(ev, t) {
  const label = `Evento · ${ev.name}`.slice(0, 36);
  if (ev.rewardKind === 'fragment') {
    const f = shuffle(q.all(`SELECT f.id, f.text, f.position, p.label FROM fragments f JOIN points p ON p.id = f.pointId
                             WHERE f.gameId = ? AND f.text IS NOT NULL AND f.id NOT IN (SELECT fragmentId FROM team_fragments WHERE teamId = ?)`, ev.gameId, t.id))[0];
    if (f) {
      q.run("INSERT OR IGNORE INTO team_fragments (teamId, fragmentId, source, acquiredAt) VALUES (?, ?, 'manual', ?)", t.id, f.id, Date.now());
      return { kind: 'fragment', text: f.text, label: f.label };
    }
  }
  if (ev.rewardKind === 'code') {
    const known = K().knownSectors(t);
    const c = shuffle(q.all('SELECT sc.sectorId, sc.code, s.name AS sectorName, s.roman FROM sector_codes sc JOIN sectors s ON s.id = sc.sectorId WHERE sc.gameId = ?', ev.gameId)
      .filter((x) => !known.has(x.sectorId)))[0];
    if (c) {
      q.run("INSERT INTO team_code_notes (teamId, sectorId, code, correct, addedAt, source) VALUES (?, ?, ?, 1, ?, 'event')", t.id, c.sectorId, c.code, Date.now());
      return { kind: 'code', code: c.code, sectorName: c.sectorName, roman: c.roman };
    }
  }
  const g = SK().grantVirtualGift(t, label, ev.rewardKind === 'gift' ? ev.rewardGiftType : null);
  return { kind: 'gift', name: g.name, icon: g.icon, color: g.color, description: g.description };
}

// Chi ha vinto prende il premio; chi ha perso lo perde.
function confirmEntry(ev, entry, auto = false) {
  const t = team(entry.teamId);
  const won = entry.outcome !== 'lost';
  const reward = won && t && t.status !== 'withdrawn' ? giveReward(ev, t) : null;
  q.run('UPDATE event_entries SET confirmedAt = ?, reward = ? WHERE eventId = ? AND teamId = ?', Date.now(), reward ? JSON.stringify({ ...reward, auto }) : null, ev.id, entry.teamId);
  G.log(ev.gameId, auto ? 'evento' : `coppia:${entry.teamId}`, 'event_confirmed', { teamId: entry.teamId, name: ev.name, team: t?.sectorName, outcome: won ? 'won' : 'lost', reward: reward?.kind, auto });
  rt.toTeams(ev.gameId, 'state', {}, entry.teamId);
}

// La coppia conferma la chiusura: prende subito il premio. Quando hanno confermato tutte parte la tregua.
function confirmClose(me, id) {
  requireCouple(me);
  return tx(() => {
    const ev = getEvent(id);
    const mine = ev && q.get("SELECT * FROM event_entries WHERE eventId = ? AND teamId = ? AND status = 'accepted'", ev.id, me.id);
    if (!mine) throw err(404, 'Non partecipate a questo evento');
    if (ev.status !== 'closing') throw err(409, ev.status === 'running' ? 'L\'evento non è ancora chiuso' : 'Chiusura già confermata');
    if (!mine.confirmedAt) confirmEntry(ev, mine);
    if (!q.get("SELECT 1 FROM event_entries WHERE eventId = ? AND status = 'accepted' AND confirmedAt IS NULL", ev.id)) startTruce(ev);
    changed(ev);
    const row = q.get('SELECT reward, outcome FROM event_entries WHERE eventId = ? AND teamId = ?', ev.id, me.id);
    return { ok: true, outcome: row.outcome || 'won', reward: JSON.parse(row.reward || 'null') };
  });
}

function startTruce(ev) {
  const now = Date.now();
  const ids = accepted(ev.id).map((e) => e.teamId);
  if (ev.truceMin > 0) {
    q.run("UPDATE game_events SET status = 'truce', truceUntil = ? WHERE id = ?", now + ev.truceMin * 60000, ev.id);
    pushTeamsOf(ev, ids, { title: `Tregua · ${ev.name}`, body: `Nessun ingaggio tra i partecipanti per ${ev.truceMin} minuti.` });
  } else {
    q.run("UPDATE game_events SET status = 'done', doneAt = ? WHERE id = ?", now, ev.id);
  }
  G.log(ev.gameId, 'evento', 'event_truce', { name: ev.name, minutes: ev.truceMin });
}

// Ogni pochi secondi: chiusure scadute (conferma d'ufficio, premio a tutti) e tregue finite.
function tickAll(now = Date.now()) {
  // Orario d'inizio raggiunto: l'evento parte da solo se qualcuno ha accettato la sfida.
  for (const ev of q.all("SELECT * FROM game_events WHERE status = 'open' AND startAt IS NOT NULL AND startAt <= ?", now)) {
    if (!q.get("SELECT 1 FROM event_entries WHERE eventId = ? AND status = 'accepted'", ev.id)) continue;
    try { startEvent(ev.id, { master: true, actor: 'orario' }); } catch (e) { /* già partito */ }
  }
  // Durata finita: regia ed Eletti custodi chiudono l'evento indicando chi ha vinto.
  for (const ev of q.all("SELECT * FROM game_events WHERE status = 'running' AND durationMin IS NOT NULL AND endNotifiedAt IS NULL")) {
    const end = endsAtOf(ev);
    if (!end || end > now) continue;
    q.run('UPDATE game_events SET endNotifiedAt = ? WHERE id = ?', now, ev.id);
    const msg = { title: `Tempo scaduto · ${ev.name}`, body: 'Chiudete l\'evento indicando chi ha vinto e chi ha perso.', tag: `evento-fine-${ev.id}` };
    rt.pushMasters({ ...msg, url: '/regia#eventi' });
    pushSquad(ev, msg);
    G.log(ev.gameId, 'orario', 'event_time_up', { name: ev.name });
    changed(ev);
  }
  for (const ev of q.all("SELECT * FROM game_events WHERE status = 'closing' AND closeDeadline <= ?", now)) {
    tx(() => {
      for (const e of q.all("SELECT * FROM event_entries WHERE eventId = ? AND status = 'accepted' AND confirmedAt IS NULL", ev.id)) confirmEntry(ev, e, true);
      startTruce(ev);
    });
    changed(ev);
  }
  for (const ev of q.all("SELECT * FROM game_events WHERE status = 'truce' AND truceUntil <= ?", now)) {
    q.run("UPDATE game_events SET status = 'done', doneAt = ? WHERE id = ?", now, ev.id);
    pushTeamsOf(ev, accepted(ev.id).map((e) => e.teamId), { title: `Fine della tregua · ${ev.name}`, body: 'Le ostilità possono riprendere.' });
    changed(ev);
  }
  // Finestra di candidatura scaduta: le alleanze non confermate da tutti decadono.
  for (const ev of q.all("SELECT * FROM game_events WHERE status = 'open' AND openUntil <= ? AND EXISTS (SELECT 1 FROM event_entries e WHERE e.eventId = game_events.id AND e.status = 'pending')", now)) {
    dropPendingGroups(ev);
    changed(ev);
  }
}

// Tregua dell'evento: due coppie che vi hanno partecipato non possono ingaggiarsi.
function truceBetween(aId, bId, now = Date.now()) {
  return q.get(`SELECT ev.name, ev.truceUntil FROM game_events ev
                JOIN event_entries a ON a.eventId = ev.id AND a.teamId = ? AND a.status = 'accepted'
                JOIN event_entries b ON b.eventId = ev.id AND b.teamId = ? AND b.status = 'accepted'
                WHERE ev.status = 'truce' AND ev.truceUntil > ?`, aId, bId, now) || null;
}

// ---------------------------------------------------------------- viste

function baseOut(ev) {
  const list = entriesOf(ev.id);
  return {
    id: ev.id, name: ev.name, description: ev.description, status: ev.status, slots: ev.slots,
    taken: list.length, joined: list.filter((e) => e.status === 'accepted').length,
    rewardKind: ev.rewardKind, rewardLabel: ev.rewardKind === 'gift' && ev.rewardGiftType ? `Dono: ${SK().giftById(ev.rewardGiftType)?.name || ev.rewardGiftType}` : REWARDS[ev.rewardKind],
    openUntil: ev.openUntil, open: candidaturesOpen(ev), windowMin: ev.windowMin, launchedAt: ev.launchedAt,
    location: ev.locLat != null ? { label: ev.locLabel, lat: ev.locLat, lng: ev.locLng } : null,
    startAt: ev.startAt, durationMin: ev.durationMin, endsAt: endsAtOf(ev), timeUp: !!ev.endNotifiedAt, confirmMin: ev.confirmMin, truceMin: ev.truceMin,
    startedAt: ev.startedAt, closingAt: ev.closingAt, closeDeadline: ev.closeDeadline, truceUntil: ev.truceUntil, doneAt: ev.doneAt,
    squadId: ev.squadId, squadName: squadName(ev.squadId), createdAt: ev.createdAt,
  };
}

const entryOut = (e) => ({ ...teamLite(team(e.teamId)), status: e.status, groupId: e.groupId, joinedBy: e.joinedBy, joinedAt: e.joinedAt, confirmedAt: e.confirmedAt, outcome: e.outcome, reward: e.reward ? JSON.parse(e.reward) : null });

function masterEvent(ev) {
  return { ...baseOut(ev), author: ev.author, closedBy: ev.closedBy, entries: entriesOf(ev.id).map(entryOut) };
}

function masterEvents(gameId) {
  return { list: q.all('SELECT * FROM game_events WHERE gameId = ? ORDER BY id DESC', gameId).map(masterEvent), rewards: REWARDS,
    giftTypes: SK().GIFTS.filter(SK().availableGift).map((x) => ({ id: x.id, name: x.name, icon: x.icon })) };
}

// Per l'app: le coppie vedono gli eventi aperti e quelli a cui partecipano (finiti da poco compresi);
// gli Eletti quelli affidati alla loro squadra.
function teamEvents(t, player = null) {
  if (!t) return [];
  const now = Date.now();
  const recent = (ev) => LIVE.includes(ev.status) || (ev.doneAt && now - ev.doneAt < 30 * 60000);
  const all = q.all('SELECT * FROM game_events WHERE gameId = ? ORDER BY id DESC', t.gameId);
  if (t.kind === 'elect') {
    const squadId = player?.squadId || null;
    return all.filter((ev) => squadId && ev.squadId === squadId && recent(ev))
      .map((ev) => ({ ...baseOut(ev), custodian: true, entries: entriesOf(ev.id).map(entryOut) }));
  }
  if (t.kind !== 'couple') return [];
  const ally = K().allianceOf(t.id);
  return all.map((ev) => {
    const mine = q.get('SELECT * FROM event_entries WHERE eventId = ? AND teamId = ?', ev.id, t.id);
    if (!(mine ? recent(ev) : ev.status === 'open')) return null;
    const out = baseOut(ev);
    const group = mine?.groupId ? q.all('SELECT * FROM event_entries WHERE eventId = ? AND groupId = ?', ev.id, mine.groupId) : [];
    return {
      ...out,
      mine: mine ? { status: mine.status, joinedBy: mine.joinedBy, confirmedAt: mine.confirmedAt, outcome: mine.outcome, reward: mine.reward ? JSON.parse(mine.reward) : null,
        group: group.length ? group.map((e) => ({ ...teamLite(team(e.teamId)), status: e.status })) : null } : null,
      allianceSize: ally?.members.length || 1,
      // Dentro l'evento le coppie compaiono una per una, senza alleanze.
      participants: ev.status !== 'open' && mine ? accepted(ev.id).map((e) => teamLite(team(e.teamId))) : null,
    };
  }).filter(Boolean);
}

module.exports = { REWARDS, createEvent, launchEvent, setLocation, setSchedule, deleteEvent, startEvent, closeEvent, joinEvent, leaveEvent, confirmClose, tickAll, truceBetween, masterEvents, teamEvents, getEvent };
