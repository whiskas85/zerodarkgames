'use strict';
// Skill delle coppie e Doni con effetto. Le Skill si scelgono prima del via (limiti per partita) o si vincono con i
// Doni; ogni Skill ha il suo tempo di ricarica. Le posizioni degli altri non arrivano mai alle coppie, tranne mentre
// un effetto le mostra: il server decide chi vede chi e per quanto.
const { q, tx } = require('./db');
const C = require('./constants');
const G = require('./game');
const K = require('./combat');
const rt = require('./realtime');
const { HttpError, randomToken, shuffle } = require('./util');

const err = (status, msg) => new HttpError(status, msg);
const MIN = 60000;
const POS_FRESH_MS = 3 * MIN;

// kind: active | ultimate | passive. target: team | altar | seal | expiredAltar | null.
// phase > 1: non ancora disponibile (compare nel catalogo come «in arrivo»).
const SKILLS = [
  { id: 'occhio', name: 'Occhio del Consiglio', icon: '👁️', kind: 'active', cooldownMin: 60, durationMin: 2, target: null, description: 'Mostra sulla mappa tutte le coppie entro 500 m da voi per 2 minuti. Nessuno lo sa.' },
  { id: 'ombra', name: 'Ombra', icon: '🥷', kind: 'active', cooldownMin: 45, durationMin: 15, target: null, description: 'Per 15 minuti la vostra posizione non compare a nessuna coppia, qualunque Skill o Dono usino.' },
  { id: 'intercettazione', name: 'Intercettazione', icon: '📡', kind: 'active', cooldownMin: 30, target: 'team', description: 'Scegliete una coppia: scoprite di quali Settori conosce il Sigillo (il codice resta sfocato).' },
  { id: 'segugio', name: 'Segugio', icon: '🦅', kind: 'active', cooldownMin: 30, target: 'team', description: 'Scegliete una coppia: vi arriva una notifica alla prossima volta che conquista un Altare.' },
  { id: 'custode', name: 'Custode', icon: '🛡️', kind: 'active', cooldownMin: 90, durationMin: 20, target: 'seal', description: 'Proteggete un Sigillo per 20 minuti: le altre coppie che lo conoscono lo vedono coperto, con il conto alla rovescia.' },
  { id: 'tracker', name: 'Tracker', icon: '⚡', kind: 'active', cooldownMin: 30, durationMin: 5, target: 'team', description: 'Seguite una coppia sulla mappa per 5 minuti. Lei se ne accorge dopo 1 minuto.' },
  { id: 'memoria', name: 'Memoria', icon: '🧩', kind: 'active', cooldownMin: 60, target: 'expiredAltar', description: 'Riaprite un Altare già inquadrato la cui scansione è scaduta: potete di nuovo pronunciarne il Sigillo.' },
  { id: 'confusione', name: 'Confusione', icon: '🌀', kind: 'active', cooldownMin: 45, durationMin: 15, target: null, auto: true, description: 'Automatica: quando qualcuno vede la vostra posizione, per 15 minuti vede anche una posizione falsa.' },
  { id: 'diplomatico', name: 'Diplomatico', icon: '🤝', kind: 'active', cooldownMin: 60, phase: 2, description: 'Stringete un\'alleanza senza mostrare il vostro Sigillo agli alleati.' },
  { id: 'velenoso', name: 'Velenoso', icon: '☠️', kind: 'active', cooldownMin: 60, phase: 2, description: 'Dopo uno scontro, rompete l\'alleanza avversaria coinvolta.' },
  { id: 'maestria', name: 'Maestria delle armi', icon: '⚔️', kind: 'active', cooldownMin: 60, phase: 2, description: 'Trasformate uno scontro perso in una vittoria.' },
  { id: 'immunita', name: 'Immunità', icon: '🧿', kind: 'active', cooldownMin: 45, phase: 2, description: 'Perdendo uno scontro, il vostro Sigillo resta coperto ai vincitori.' },
  { id: 'caccia', name: 'Maestro della caccia', icon: '🎯', kind: 'active', cooldownMin: 30, phase: 3, description: 'Mandate gli Eletti a dare la caccia a una coppia.' },
  { id: 'rete', name: 'Rete del Consiglio', icon: '🌐', kind: 'ultimate', cooldownMin: 90, durationMin: 3, target: null, description: 'Per 3 minuti vedete sulla mappa tutte le coppie. Se ne accorgono dopo 1 minuto.' },
  { id: 'veggenza', name: 'Veggenza', icon: '🔮', kind: 'ultimate', cooldownMin: 90, target: 'altar', description: 'Scegliete un Altare e prendete subito il suo frammento, senza Sigillo e senza andarci.' },
  { id: 'intuizione', name: 'Intuizione', icon: '🧠', kind: 'ultimate', cooldownMin: 90, target: 'altar', description: 'Aprite un Altare a scelta da lontano, come se l\'aveste appena inquadrato: poi serve il suo Sigillo.' },
  { id: 'autorita', name: 'Autorità', icon: '👑', kind: 'ultimate', cooldownMin: 90, target: null, description: 'Ricevete subito un Dono a caso.' },
  { id: 'silenzio', name: 'Silenzio di Vetro', icon: '🔇', kind: 'passive', description: 'Quando una coppia vi scopre con Occhio o Rete del Consiglio, vede solo un\'area di 100 m, non il punto esatto.' },
  { id: 'velo', name: 'Velo di Ceneri', icon: '🌫️', kind: 'passive', description: 'Tracciamenti e taglie contro di voi durano la metà.' },
  { id: 'allarme', name: 'Allarme di Prossimità', icon: '📳', kind: 'passive', description: 'Una vibrazione silenziosa vi avvisa quando una coppia non alleata arriva entro 80 m.' },
  { id: 'presagio', name: 'Presagio del Dono', icon: '✨', kind: 'passive', description: 'Quando compare un Dono vedete subito un cerchio di 100 m che lo contiene; le altre coppie lo vedono 5 minuti dopo.' },
  { id: 'memoria_nodo', name: 'Memoria del Nodo', icon: '⏳', kind: 'passive', description: 'Una scansione di Altare vi vale il doppio del tempo.' },
  { id: 'privilegio', name: 'Privilegio del Cuore', icon: '❤️', kind: 'passive', description: 'Gli armamenti al Cuore valgono per voi 5 minuti prima dell\'apertura e 5 minuti dopo la chiusura.' },
  { id: 'veglia_forzata', name: 'Veglia Forzata', icon: '⛓️', kind: 'passive', phase: 2, description: 'Chi perde contro di voi resta fermo 4 minuti invece di 2.' },
  { id: 'ritirata', name: 'Ritirata del Diplomatico', icon: '🏳️', kind: 'passive', phase: 2, description: 'Dopo una trattativa fallita il blocco ingaggio sale a 8 minuti.' },
];

// target: team | altar | skill | swap | null. phase > 1: non ancora creabile dalla regia.
const GIFTS = [
  { id: 'maestro', name: 'Maestro', icon: '🎓', color: '#d1ad62', target: 'newSkill', description: 'Aggiungete alle vostre Skill una Skill a scelta, pronta da usare.' },
  { id: 'chiave', name: 'Chiave Maestra', icon: '🗝️', color: '#e0b04f', target: 'scannedAltar', description: 'Aprite un Altare senza il suo Sigillo. Dovete averlo appena inquadrato (scansione valida).' },
  { id: 'furto', name: 'Grande Furto', icon: '💰', color: '#e0603f', target: 'team', description: 'Rubate a una coppia un Sigillo a caso tra quelli che conosce e voi no: se l\'aveva solo annotato, lo perde.' },
  { id: 'tracciamento', name: 'Tracciamento', icon: '📍', color: '#5aa0e0', target: 'team', durationMin: 20, description: 'Vedete sulla mappa una coppia a scelta per 20 minuti.' },
  { id: 'archivio', name: 'Archivio Proibito', icon: '📚', color: '#9b6cf0', target: null, description: 'Ricevete un Sigillo che non conoscete ancora.' },
  { id: 'scudo', name: 'Immunità', icon: '🛡️', color: '#6fbf73', target: null, durationMin: 15, description: 'Per 15 minuti nessuna Skill o Dono avversario vi colpisce (tracciamenti, taglie, furti, scansioni).' },
  { id: 'seconda', name: 'Seconda Possibilità', icon: '🔄', color: '#4fc1c1', target: 'cooldownSkill', description: 'Ricaricate subito una Skill in ricarica.' },
  { id: 'sovraccarico', name: 'Sovraccarico', icon: '⚡', color: '#facc15', target: null, description: 'Ricaricate subito tutte le vostre Skill.' },
  { id: 'taglia', name: 'Taglia', icon: '🚨', color: '#e5484d', target: 'team', durationMin: 15, description: 'Una coppia a scelta compare sulla mappa di tutti per 15 minuti. Se ne accorge dopo 1 minuto.' },
  { id: 'dossier', name: 'Dossier Segreto', icon: '🕵️', color: '#a0703c', target: 'team', description: 'Vedete tutti i Sigilli che conosce una coppia a scelta.' },
  { id: 'benedizione', name: 'Benedizione del Consiglio', icon: '✨', color: '#f0e3b0', target: 'swap', description: 'Sostituite una vostra Skill con un\'altra, pronta da usare.' },
  { id: 'sporche', name: 'Alleanze sporche', icon: '🤝', color: '#7a7a7a', phase: 3, description: 'Per 30 minuti alleati con una squadra di Eletti.' },
  { id: 'reliquia', name: 'Reliquia Antica', icon: '💎', color: '#22c3e6', phase: 2, durationMin: 30, description: 'Per 30 minuti i vostri Sigilli non si perdono.' },
];

const skillById = (id) => SKILLS.find((s) => s.id === id);
const giftById = (id) => GIFTS.find((g) => g.id === id);
const available = (x) => !x.phase || x.phase <= 1;
const isPassive = (s) => s.kind === 'passive';

// ---------------------------------------------------------------- utilità

function team(id) {
  return q.get('SELECT t.*, s.name AS sectorName, s.roman, s.color AS sectorColor FROM teams t LEFT JOIN sectors s ON s.id = t.sectorId WHERE t.id = ?', Number(id));
}

function requireCouple(t) {
  if (!t || t.kind !== 'couple') throw err(403, 'Skill e Doni sono delle coppie');
}

function requirePlaying(t) {
  const g = G.getGame(t.gameId);
  if (g.status === 'paused') throw err(409, 'Partita sospesa');
  if (!C.ACTIVE.includes(g.status)) throw err(409, 'Skill e Doni si usano a partita in corso');
  if (t.status !== 'active') throw err(409, t.status === 'won' ? 'Avete già passato la Soglia' : 'Coppia ritirata');
  return g;
}

const hasSkill = (teamId, skillId) => !!q.get('SELECT 1 FROM team_skills WHERE teamId = ? AND skillId = ?', teamId, skillId);

function activeEffects(gameId, now = Date.now()) {
  return q.all('SELECT * FROM skill_effects WHERE gameId = ? AND endedAt IS NULL AND (endsAt IS NULL OR endsAt > ?)', gameId, now);
}
const effectOn = (gameId, teamId, code, now = Date.now()) => activeEffects(gameId, now).find((e) => e.teamId === teamId && e.code === code);
const immune = (t, now = Date.now()) => !!effectOn(t.gameId, t.id, 'scudo', now);
const hidden = (t, now = Date.now()) => !!effectOn(t.gameId, t.id, 'ombra', now);

function latestPos(teamId, now = Date.now()) {
  return q.get('SELECT lat, lng, at FROM positions WHERE teamId = ? AND at > ? ORDER BY at DESC LIMIT 1', teamId, now - POS_FRESH_MS);
}

function distM(a, b) {
  const R = 6371000; const r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Spostamento di un punto di (dx, dy) metri.
function offset(p, dx, dy) {
  return { lat: p.lat + dy / 111320, lng: p.lng + dx / (111320 * Math.cos((p.lat * Math.PI) / 180)) };
}
// Numero pseudo-casuale stabile (stesso seme → stesso valore): le aree sfocate non «ballano» a ogni aggiornamento.
function seeded(seed) {
  let h = 2166136261;
  for (const c of String(seed)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

function startEffect(t, kind, code, { durationMin = null, target = null, sectorId = null, pointId = null, notifyAfterMin = null, data = null } = {}) {
  const now = Date.now();
  const id = Number(q.run(`INSERT INTO skill_effects (gameId, teamId, kind, code, targetTeamId, targetSectorId, targetPointId, startedAt, endsAt, notifyAt, data)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  t.gameId, t.id, kind, code, target, sectorId, pointId, now, durationMin ? now + durationMin * MIN : null,
  notifyAfterMin != null ? now + notifyAfterMin * MIN : null, data ? JSON.stringify(data) : null).lastInsertRowid);
  return id;
}

// Velo di Ceneri: tracciamenti e taglie contro chi ce l'ha durano la metà.
const trackMin = (target, min) => (hasSkill(target.id, 'velo') ? min / 2 : min);

function pickTarget(me, targetTeamId) {
  const t = team(targetTeamId);
  if (!t || t.gameId !== me.gameId || t.kind !== 'couple' || t.id === me.id) throw err(400, 'Scegliete una coppia avversaria');
  if (t.status !== 'active') throw err(409, `Il Settore ${t.sectorName} è fuori dal gioco`);
  if (immune(t)) throw err(409, `Il Settore ${t.sectorName} è protetto da un\'Immunità: riprovate più tardi`);
  return t;
}

function refreshTeams(gameId, ids) {
  for (const id of new Set(ids)) rt.toTeams(gameId, 'state', {}, id);
  rt.toStaff(gameId, 'skills');
}

// ---------------------------------------------------------------- scelta prima del via

function limitsOf(g) {
  return { active: Math.max(0, g.maxActiveSkills ?? 1), passive: Math.max(0, g.maxPassiveSkills ?? 1) };
}

function chooseSkill(me, skillId, on) {
  requireCouple(me);
  const g = G.getGame(me.gameId);
  if (!C.PRE_START.includes(g.status)) throw err(409, 'Le Skill si scelgono solo prima del via');
  const s = skillById(skillId);
  if (!s) throw err(404, 'Skill sconosciuta');
  if (!on) {
    q.run("DELETE FROM team_skills WHERE teamId = ? AND skillId = ? AND source = 'chosen'", me.id, s.id);
  } else {
    if (!available(s)) throw err(409, `${s.name} non è ancora disponibile`);
    if (hasSkill(me.id, s.id)) return { ok: true };
    const lim = limitsOf(g);
    const chosen = q.all("SELECT skillId FROM team_skills WHERE teamId = ? AND source = 'chosen'", me.id).map((r) => skillById(r.skillId)).filter(Boolean);
    const passive = isPassive(s);
    const n = chosen.filter((x) => isPassive(x) === passive).length;
    const max = passive ? lim.passive : lim.active;
    if (n >= max) throw err(409, max ? `Avete già ${max === 1 ? 'la vostra Skill' : `${max} Skill`} ${passive ? 'passiva' : 'attiva o Ultimate'}: toglietene una per sceglierne un'altra` : `In questa partita non si scelgono Skill ${passive ? 'passive' : 'attive'}`);
    q.run("INSERT INTO team_skills (teamId, skillId, source, addedAt) VALUES (?, ?, 'chosen', ?)", me.id, s.id, Date.now());
  }
  G.log(g.id, `coppia:${me.id}`, on ? 'skill_chosen' : 'skill_removed', { teamId: me.id, skill: s.name });
  refreshTeams(g.id, [me.id]);
  return { ok: true };
}

// ---------------------------------------------------------------- uso delle Skill

function useSkill(me, skillId, params = {}) {
  requireCouple(me);
  const g = requirePlaying(me);
  const s = skillById(skillId);
  const own = s && q.get('SELECT * FROM team_skills WHERE teamId = ? AND skillId = ?', me.id, s.id);
  if (!own) throw err(404, 'Non avete questa Skill');
  if (!available(s)) throw err(409, `${s.name} non è ancora disponibile`);
  if (isPassive(s) || s.auto) throw err(409, `${s.name} si attiva da sola`);
  const now = Date.now();
  if (own.readyAt && own.readyAt > now) throw err(409, `${s.name} è in ricarica: pronta tra ${Math.ceil((own.readyAt - now) / MIN)} minuti`);
  const result = applySkill(g, me, s, params);
  q.run('UPDATE team_skills SET readyAt = ? WHERE id = ?', now + s.cooldownMin * MIN, own.id);
  G.log(g.id, `coppia:${me.id}`, 'skill_used', { teamId: me.id, skill: s.name, target: result.targetName || null });
  refreshTeams(g.id, [me.id, ...(result.notifyTeams || [])]);
  delete result.notifyTeams;
  return { ok: true, skill: s.id, ...result };
}

function applySkill(g, me, s, p) {
  switch (s.id) {
    case 'occhio': {
      if (!latestPos(me.id)) throw err(409, 'Serve la vostra posizione: accendete il GPS (o Traccar) e riprovate');
      startEffect(me, 'skill', s.id, { durationMin: s.durationMin });
      return { message: 'Per 2 minuti vedete le coppie entro 500 m.' };
    }
    case 'ombra':
      startEffect(me, 'skill', s.id, { durationMin: s.durationMin });
      return { message: 'Siete nell\'Ombra per 15 minuti.' };
    case 'rete':
      startEffect(me, 'skill', s.id, { durationMin: s.durationMin, notifyAfterMin: 1 });
      return { message: 'Per 3 minuti vedete tutte le coppie.' };
    case 'tracker': {
      const t = pickTarget(me, p.teamId);
      startEffect(me, 'skill', s.id, { durationMin: trackMin(t, s.durationMin), target: t.id, notifyAfterMin: 1 });
      return { targetName: t.sectorName, message: `Seguite il Settore ${t.sectorName} sulla mappa.` };
    }
    case 'intercettazione': {
      const t = pickTarget(me, p.teamId);
      const sectors = [...K.knownSectors(t)].map((sid) => G.sectorById(sid)).filter(Boolean)
        .sort((a, b) => a.ord - b.ord).map((x) => ({ sectorId: x.id, sectorName: x.name, roman: x.roman, element: x.element }));
      startEffect(me, 'skill', s.id, { target: t.id, data: { sectors } });
      endNow(me.gameId, me.id, s.id);
      return { targetName: t.sectorName, intercept: { sectorName: t.sectorName, sectors } };
    }
    case 'segugio': {
      const t = pickTarget(me, p.teamId);
      q.run("UPDATE skill_effects SET endedAt = ? WHERE teamId = ? AND code = 'segugio' AND endedAt IS NULL", Date.now(), me.id);
      startEffect(me, 'skill', s.id, { target: t.id });
      return { targetName: t.sectorName, message: `Vi avvisiamo quando il Settore ${t.sectorName} conquista un Altare.` };
    }
    case 'custode': {
      const sid = Number(p.sectorId);
      const known = K.knownSectors(me);
      if (!known.has(sid)) throw err(400, 'Scegliete un Sigillo che conoscete');
      startEffect(me, 'skill', s.id, { durationMin: s.durationMin, sectorId: sid });
      return { message: `Il Sigillo del Settore ${G.sectorById(sid).name} è protetto per 20 minuti.` };
    }
    case 'memoria': {
      const pt = q.get('SELECT * FROM points WHERE id = ? AND gameId = ?', Number(p.pointId), g.id);
      const v = pt && q.get('SELECT visitedAt FROM team_visits WHERE teamId = ? AND pointId = ?', me.id, pt.id);
      if (!v) throw err(400, 'Scegliete un Altare che avete già inquadrato');
      const exp = G.scanExpiresAt(g, v.visitedAt, me);
      if (!exp || exp > Date.now()) throw err(409, 'La scansione di questo Altare è ancora valida');
      q.run('UPDATE team_visits SET visitedAt = ? WHERE teamId = ? AND pointId = ?', Date.now(), me.id, pt.id);
      startEffect(me, 'skill', s.id, { pointId: pt.id });
      endNow(me.gameId, me.id, s.id);
      return { qrToken: pt.qrToken, message: `${pt.label} di nuovo aperto: pronunciate il Sigillo.` };
    }
    case 'veggenza': {
      const pt = q.get('SELECT * FROM points WHERE id = ? AND gameId = ?', Number(p.pointId), g.id);
      const f = pt && q.get('SELECT * FROM fragments WHERE pointId = ?', pt.id);
      if (!f) throw err(400, 'Scegliete un Altare che custodisce un frammento');
      if (q.get('SELECT 1 FROM team_fragments WHERE teamId = ? AND fragmentId = ?', me.id, f.id)) throw err(409, 'Avete già il frammento di questo Altare');
      q.run("INSERT INTO team_fragments (teamId, fragmentId, source, acquiredAt) VALUES (?, ?, 'skill', ?)", me.id, f.id, Date.now());
      startEffect(me, 'skill', s.id, { pointId: pt.id });
      endNow(me.gameId, me.id, s.id);
      return { fragment: { position: f.position, text: f.text, pointLabel: pt.label }, message: `Frammento di ${pt.label}: «${f.text}».` };
    }
    case 'intuizione': {
      const pt = q.get('SELECT * FROM points WHERE id = ? AND gameId = ?', Number(p.pointId), g.id);
      if (!pt) throw err(400, 'Scegliete un Altare');
      q.run('INSERT INTO team_visits (teamId, pointId, visitedAt) VALUES (?, ?, ?) ON CONFLICT(teamId, pointId) DO UPDATE SET visitedAt = excluded.visitedAt', me.id, pt.id, Date.now());
      startEffect(me, 'skill', s.id, { pointId: pt.id });
      endNow(me.gameId, me.id, s.id);
      return { qrToken: pt.qrToken, message: `${pt.label} aperto: pronunciate il Sigillo.` };
    }
    case 'autorita': {
      const gift = grantVirtualGift(me, 'Dono di Autorità');
      startEffect(me, 'skill', s.id, { data: { giftId: gift.id } });
      endNow(me.gameId, me.id, s.id);
      return { gift, message: `Avete ricevuto il dono ${gift.name}.` };
    }
    default:
      throw err(409, `${s.name} non si usa da qui`);
  }
}

function endNow(gameId, teamId, code) {
  q.run('UPDATE skill_effects SET endedAt = ? WHERE id = (SELECT MAX(id) FROM skill_effects WHERE gameId = ? AND teamId = ? AND code = ?)', Date.now(), gameId, teamId, code);
}

// Un Dono senza QR (Autorità): finisce subito tra i doni della coppia.
function grantVirtualGift(me, label) {
  const type = shuffle(GIFTS.filter(available))[0];
  const now = Date.now();
  const id = Number(q.run(`INSERT INTO gifts (gameId, typeId, name, icon, color, description, label, qrToken, status, revealMode, claimedByTeamId, claimedAt, createdAt)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', 'manual', ?, ?, ?)`,
  me.gameId, type.id, type.name, type.icon, type.color, type.description, label, randomToken(18), me.id, now, now).lastInsertRowid);
  rt.toStaff(me.gameId, 'gifts');
  return { id, typeId: type.id, name: type.name, icon: type.icon, color: type.color, description: type.description };
}

// ---------------------------------------------------------------- uso dei Doni

function useGift(me, gift, params = {}) {
  const type = giftById(gift.typeId);
  if (!type) return null; // dono senza effetto automatico (tipi vecchi): si segna solo come usato
  requireCouple(me);
  const g = requirePlaying(me);
  if (!available(type)) throw err(409, `${type.name} non è ancora disponibile`);
  const result = applyGift(g, me, type, params);
  q.run('UPDATE gifts SET usedAt = ? WHERE id = ?', Date.now(), gift.id);
  G.log(g.id, `coppia:${me.id}`, 'gift_used', { teamId: me.id, label: gift.label, type: type.name, target: result.targetName || null });
  refreshTeams(g.id, [me.id, ...(result.notifyTeams || [])]);
  rt.toStaff(g.id, 'gifts');
  delete result.notifyTeams;
  return { ok: true, gift: type.id, ...result };
}

function applyGift(g, me, type, p) {
  const now = Date.now();
  switch (type.id) {
    case 'maestro': {
      const s = skillById(p.skillId);
      if (!s || !available(s)) throw err(400, 'Scegliete una Skill disponibile');
      if (hasSkill(me.id, s.id)) throw err(409, `Avete già ${s.name}`);
      q.run("INSERT INTO team_skills (teamId, skillId, source, addedAt) VALUES (?, ?, 'gift', ?)", me.id, s.id, now);
      return { message: `${s.name} aggiunta alle vostre Skill.` };
    }
    case 'benedizione': {
      const from = skillById(p.fromSkillId);
      const to = skillById(p.skillId);
      if (!from || !hasSkill(me.id, from.id)) throw err(400, 'Scegliete la Skill da sostituire');
      if (!to || !available(to)) throw err(400, 'Scegliete la nuova Skill');
      if (hasSkill(me.id, to.id)) throw err(409, `Avete già ${to.name}`);
      tx(() => {
        q.run('DELETE FROM team_skills WHERE teamId = ? AND skillId = ?', me.id, from.id);
        q.run("INSERT INTO team_skills (teamId, skillId, source, addedAt) VALUES (?, ?, 'gift', ?)", me.id, to.id, now);
      });
      return { message: `${from.name} sostituita da ${to.name}.` };
    }
    case 'seconda': {
      const s = skillById(p.skillId);
      const own = s && q.get('SELECT * FROM team_skills WHERE teamId = ? AND skillId = ?', me.id, s.id);
      if (!own || !own.readyAt || own.readyAt <= now) throw err(400, 'Scegliete una Skill in ricarica');
      q.run('UPDATE team_skills SET readyAt = NULL WHERE id = ?', own.id);
      return { message: `${s.name} è di nuovo pronta.` };
    }
    case 'sovraccarico':
      q.run('UPDATE team_skills SET readyAt = NULL WHERE teamId = ?', me.id);
      return { message: 'Tutte le vostre Skill sono pronte.' };
    case 'chiave': {
      const pt = q.get('SELECT * FROM points WHERE id = ? AND gameId = ?', Number(p.pointId), g.id);
      const f = pt && q.get('SELECT * FROM fragments WHERE pointId = ?', pt.id);
      if (!f) throw err(400, 'Scegliete un Altare che custodisce un frammento');
      const v = q.get('SELECT visitedAt FROM team_visits WHERE teamId = ? AND pointId = ?', me.id, pt.id);
      const exp = v ? G.scanExpiresAt(g, v.visitedAt, me) : null;
      if (!v || (exp && exp < now)) throw err(409, 'La Chiave Maestra funziona solo all\'Altare: inquadratene prima il QR');
      if (q.get('SELECT 1 FROM team_fragments WHERE teamId = ? AND fragmentId = ?', me.id, f.id)) throw err(409, 'Avete già il frammento di questo Altare');
      q.run("INSERT INTO team_fragments (teamId, fragmentId, source, acquiredAt) VALUES (?, ?, 'gift', ?)", me.id, f.id, now);
      onAltarUnlocked(me, pt);
      return { fragment: { position: f.position, text: f.text, pointLabel: pt.label }, message: `${pt.label} aperto: «${f.text}».` };
    }
    case 'furto': {
      const t = pickTarget(me, p.teamId);
      const mine = K.knownSectors(me);
      const pool = [...K.knownSectors(t)].filter((sid) => !mine.has(sid));
      if (!pool.length) return { targetName: t.sectorName, stolen: null, message: `Il Settore ${t.sectorName} non conosce Sigilli che voi non abbiate già.` };
      const sid = shuffle(pool)[0];
      const sc = q.get('SELECT code FROM sector_codes WHERE gameId = ? AND sectorId = ?', g.id, sid);
      tx(() => {
        q.run("INSERT INTO team_code_notes (teamId, sectorId, code, correct, addedAt, source) VALUES (?, ?, ?, 1, ?, 'stolen')", me.id, sid, sc.code, now);
        // Chi l'aveva solo annotato (ricevuto o scritto) lo perde; il proprio e quelli rivelati restano.
        q.run('DELETE FROM team_code_notes WHERE teamId = ? AND sectorId = ?', t.id, sid);
      });
      const sec = G.sectorById(sid);
      rt.pushTeams(g.id, { title: 'Grande Furto', body: 'Una coppia vi ha rubato un Sigillo dal taccuino.', tag: `furto-${now}`, url: '/#/codici' }, t.id);
      return { targetName: t.sectorName, notifyTeams: [t.id], stolen: { sectorId: sid, sectorName: sec.name, roman: sec.roman, code: sc.code }, message: `Rubato il Sigillo del Settore ${sec.name}.` };
    }
    case 'archivio': {
      const mine = K.knownSectors(me);
      const pool = q.all('SELECT sectorId FROM sector_codes WHERE gameId = ?', g.id).map((r) => r.sectorId).filter((sid) => !mine.has(sid));
      if (!pool.length) throw err(409, 'Conoscete già tutti i Sigilli');
      const sid = shuffle(pool)[0];
      const sc = q.get('SELECT code FROM sector_codes WHERE gameId = ? AND sectorId = ?', g.id, sid);
      q.run("INSERT INTO team_code_notes (teamId, sectorId, code, correct, addedAt, source) VALUES (?, ?, ?, 1, ?, 'archive')", me.id, sid, sc.code, now);
      const sec = G.sectorById(sid);
      return { stolen: { sectorId: sid, sectorName: sec.name, roman: sec.roman, code: sc.code }, message: `Nuovo Sigillo: Settore ${sec.name}.` };
    }
    case 'scudo':
      startEffect(me, 'gift', type.id, { durationMin: type.durationMin });
      return { message: 'Per 15 minuti nessuna Skill o Dono avversario vi colpisce.' };
    case 'tracciamento': {
      const t = pickTarget(me, p.teamId);
      startEffect(me, 'gift', type.id, { durationMin: trackMin(t, type.durationMin), target: t.id });
      return { targetName: t.sectorName, message: `Vedete il Settore ${t.sectorName} sulla mappa.` };
    }
    case 'taglia': {
      const t = pickTarget(me, p.teamId);
      startEffect(me, 'gift', type.id, { durationMin: trackMin(t, type.durationMin), target: t.id, notifyAfterMin: 1 });
      return { targetName: t.sectorName, message: `Taglia sul Settore ${t.sectorName}: lo vedono tutti.` };
    }
    case 'dossier': {
      const t = pickTarget(me, p.teamId);
      const codes = [...K.knownSectors(t)].map((sid) => ({ s: G.sectorById(sid), c: q.get('SELECT code FROM sector_codes WHERE gameId = ? AND sectorId = ?', g.id, sid) }))
        .filter((x) => x.s && x.c).sort((a, b) => a.s.ord - b.s.ord).map((x) => ({ sectorId: x.s.id, sectorName: x.s.name, roman: x.s.roman, code: x.c.code }));
      startEffect(me, 'gift', type.id, { target: t.id, data: { codes } });
      endNow(g.id, me.id, type.id);
      return { targetName: t.sectorName, dossier: { sectorName: t.sectorName, codes } };
    }
    default:
      throw err(409, `${type.name} non si usa da qui`);
  }
}

// ---------------------------------------------------------------- effetti visti dalle coppie

// Posizioni degli altri che una coppia vede ora (solo durante un effetto). Mai Ombra; Immunità protegge dalle
// scansioni; Silenzio di Vetro sfoca le scansioni; Confusione aggiunge una posizione falsa.
function sightingsFor(me, now = Date.now()) {
  if (me.kind !== 'couple') return [];
  const g = G.getGame(me.gameId);
  if (!C.ACTIVE.includes(g.status) && g.status !== 'paused') return [];
  const effects = activeEffects(g.id, now);
  const couples = q.all("SELECT t.id FROM teams t WHERE t.gameId = ? AND t.kind = 'couple' AND t.status = 'active' AND t.id <> ?", g.id, me.id).map((r) => team(r.id));
  const out = new Map();
  const add = (t, source, until, scan) => {
    if (hidden(t, now)) return;
    if (scan && immune(t, now)) return;
    const pos = latestPos(t.id, now);
    if (!pos) return;
    const prev = out.get(t.id);
    if (prev && (prev.until || Infinity) >= (until || Infinity) && !prev.approx) return;
    out.set(t.id, { t, pos, source, until, scan });
  };
  const mine = effects.filter((e) => e.teamId === me.id);
  for (const e of mine) {
    if (e.code === 'rete') for (const t of couples) add(t, 'Rete del Consiglio', e.endsAt, true);
    if (e.code === 'occhio') {
      const here = latestPos(me.id, now);
      if (here) for (const t of couples) { const p = latestPos(t.id, now); if (p && distM(here, p) <= 500) add(t, 'Occhio del Consiglio', e.endsAt, true); }
    }
    if (['tracker', 'tracciamento'].includes(e.code)) { const t = couples.find((x) => x.id === e.targetTeamId); if (t) add(t, e.code === 'tracker' ? 'Tracker' : 'Tracciamento', e.endsAt, false); }
  }
  for (const e of effects.filter((x) => x.code === 'taglia')) {
    const t = couples.find((x) => x.id === e.targetTeamId);
    if (t) add(t, 'Taglia', e.endsAt, false);
  }
  const list = [];
  for (const { t, pos, source, until, scan } of out.values()) {
    const base = { teamId: t.id, sectorName: t.sectorName, displayName: t.displayName || null, roman: t.roman, color: t.sectorColor, source, until, at: pos.at };
    if (scan && hasSkill(t.id, 'silenzio')) {
      // Area di 100 m che contiene la posizione vera, con il centro spostato in modo stabile.
      const a = seeded(`${t.id}:${me.id}:${Math.floor(now / (10 * MIN))}`) * 2 * Math.PI;
      const c = offset(pos, Math.cos(a) * 35, Math.sin(a) * 35);
      list.push({ ...base, lat: c.lat, lng: c.lng, radius: 50 });
    } else list.push({ ...base, lat: pos.lat, lng: pos.lng, radius: null });
    const fake = confusionFor(t, couples, now);
    if (fake) list.push({ ...base, lat: fake.lat, lng: fake.lng, radius: null, key: 'f' });
  }
  return list.map((x, i) => ({ ...x, key: `${x.teamId}${x.key || ''}-${i}` }));
}

// Confusione: si accende da sola la prima volta che qualcuno vede la coppia (se non è in ricarica) e per 15 minuti
// a chi la vede compare anche una posizione falsa (quella di un'altra coppia, o un punto a 150-300 m).
function confusionFor(t, couples, now) {
  const own = q.get("SELECT * FROM team_skills WHERE teamId = ? AND skillId = 'confusione'", t.id);
  if (!own) return null;
  let e = effectOn(t.gameId, t.id, 'confusione', now);
  if (!e) {
    if (own.readyAt && own.readyAt > now) return null;
    const s = skillById('confusione');
    const others = couples.filter((x) => x.id !== t.id).map((x) => x.id);
    const pos = latestPos(t.id, now);
    const a = Math.random() * 2 * Math.PI;
    const d = 150 + Math.random() * 150;
    const fallback = pos ? offset(pos, Math.cos(a) * d, Math.sin(a) * d) : null;
    const id = startEffect(t, 'skill', 'confusione', { durationMin: s.durationMin, data: { fakeTeamId: others.length ? shuffle(others)[0] : null, fallback } });
    q.run('UPDATE team_skills SET readyAt = ? WHERE id = ?', now + s.cooldownMin * MIN, own.id);
    G.log(t.gameId, 'sistema', 'skill_auto', { teamId: t.id, skill: s.name });
    e = q.get('SELECT * FROM skill_effects WHERE id = ?', id);
  }
  const d = JSON.parse(e.data || '{}');
  const p = d.fakeTeamId ? latestPos(d.fakeTeamId, now) : null;
  return p || d.fallback || null;
}

// Sigilli coperti da Custode di un'altra coppia: { sectorId: endsAt }.
function protectedSeals(me, now = Date.now()) {
  const out = {};
  for (const e of activeEffects(me.gameId, now)) if (e.code === 'custode' && e.teamId !== me.id && e.targetSectorId) out[e.targetSectorId] = Math.max(out[e.targetSectorId] || 0, e.endsAt);
  return out;
}

// Presagio del Dono: cerchi (100 m di diametro) attorno ai doni appena comparsi, per chi ha la passiva.
function giftHints(me, now = Date.now()) {
  if (!hasSkill(me.id, 'presagio')) return [];
  return q.all("SELECT id, hintLat, hintLng, publicAt FROM gifts WHERE gameId = ? AND status = 'revealed' AND publicAt > ? AND hintLat IS NOT NULL", me.gameId, now)
    .map((g) => ({ id: g.id, lat: g.hintLat, lng: g.hintLng, radius: 50, until: g.publicAt }));
}

// Compare un dono: se qualcuno ha Presagio, le altre coppie lo vedono 5 minuti dopo; chi l'ha vede subito un cerchio.
function onGiftRevealed(gift) {
  const holders = q.all("SELECT t.id FROM teams t JOIN team_skills k ON k.teamId = t.id AND k.skillId = 'presagio' WHERE t.gameId = ? AND t.status = 'active'", gift.gameId).map((r) => r.id);
  if (!holders.length || gift.lat == null) return false;
  const a = Math.random() * 2 * Math.PI;
  const c = offset(gift, Math.cos(a) * 35 * Math.random(), Math.sin(a) * 35 * Math.random());
  q.run('UPDATE gifts SET publicAt = ?, hintLat = ?, hintLng = ? WHERE id = ?', Date.now() + 5 * MIN, c.lat, c.lng, gift.id);
  for (const id of holders) rt.pushTeams(gift.gameId, { title: 'Presagio del Dono', body: 'Un Dono è appena comparso: guardate il cerchio sulla mappa. Gli altri lo sapranno tra 5 minuti.', tag: `presagio-${gift.id}`, url: '/#/mappa' }, id);
  return true;
}

// Segugio: quando la coppia seguita conquista un Altare, chi la segue riceve la notifica (una volta sola).
function onAltarUnlocked(t, point) {
  const hounds = q.all("SELECT * FROM skill_effects WHERE gameId = ? AND code = 'segugio' AND targetTeamId = ? AND endedAt IS NULL", t.gameId, t.id);
  if (!hounds.length) return;
  const tt = team(t.id);
  for (const e of hounds) {
    q.run('UPDATE skill_effects SET endedAt = ?, data = ? WHERE id = ?', Date.now(), JSON.stringify({ point: point.label }), e.id);
    rt.pushTeams(t.gameId, { title: 'Segugio', body: `Il Settore ${tt.sectorName} ha appena conquistato ${point.label}.`, tag: `segugio-${e.id}`, url: '/#/skill' }, e.teamId);
    rt.toTeams(t.gameId, 'state', {}, e.teamId);
  }
}

// Memoria del Nodo: la scansione di un Altare vale il doppio.
const scanFactor = (t) => (t && hasSkill(t.id, 'memoria_nodo') ? 2 : 1);

// Privilegio del Cuore: finestre degli armamenti allargate di 5 minuti prima e dopo.
function supplyFor(me, g, now = Date.now()) {
  if (!hasSkill(me.id, 'privilegio')) return null;
  const el = G.clockOf(g).elapsedMs;
  const soon = q.all("SELECT * FROM supply_drops WHERE gameId = ? AND status = 'scheduled'", g.id).map((s) => {
    const atMs = s.scheduledMin != null ? s.scheduledMin * MIN : s.scheduledAt ? el + (s.scheduledAt - now) : null;
    return atMs != null && atMs - el <= 5 * MIN && atMs - el > 0 ? { id: s.id, opensAt: now + (atMs - el), description: s.description } : null;
  }).filter(Boolean);
  const late = q.all("SELECT id, closedAt, description FROM supply_drops WHERE gameId = ? AND status = 'closed' AND closedAt > ?", g.id, now - 5 * MIN)
    .map((s) => ({ id: s.id, until: s.closedAt + 5 * MIN, description: s.description }));
  return soon.length || late.length ? { early: soon, late } : null;
}

// ---------------------------------------------------------------- stato per l'app

function skillsState(me, now = Date.now()) {
  if (me.kind !== 'couple') return null;
  const g = G.getGame(me.gameId);
  const own = q.all('SELECT * FROM team_skills WHERE teamId = ? ORDER BY id', me.id);
  const effects = q.all('SELECT * FROM skill_effects WHERE teamId = ? ORDER BY id DESC LIMIT 40', me.id);
  const live = effects.filter((e) => !e.endedAt && (!e.endsAt || e.endsAt > now));
  const name = (id) => (id ? team(id)?.sectorName : null);
  return {
    limits: limitsOf(g),
    canChoose: C.PRE_START.includes(g.status),
    catalog: SKILLS.map((s) => ({ ...s, available: available(s) })),
    giftCatalog: GIFTS.map((x) => ({ ...x, available: available(x) })),
    mine: own.map((r) => {
      const s = skillById(r.skillId);
      const eff = live.find((e) => e.code === r.skillId);
      return s ? { ...s, source: r.source, readyAt: r.readyAt && r.readyAt > now ? r.readyAt : null, activeUntil: eff ? eff.endsAt : null, active: !!eff, targetName: eff ? name(eff.targetTeamId) : null } : null;
    }).filter(Boolean),
    // Effetti in corso sulla coppia (Immunità del Dono, tracciamenti in corso…).
    effects: live.map((e) => ({ id: e.id, code: e.code, kind: e.kind, until: e.endsAt, targetName: name(e.targetTeamId), name: (e.kind === 'gift' ? giftById(e.code) : skillById(e.code))?.name })),
    // Ultimi risultati (Intercettazione, Dossier, Segugio).
    results: effects.filter((e) => ['intercettazione', 'dossier', 'segugio'].includes(e.code) && e.data).slice(0, 6)
      .map((e) => ({ id: e.id, code: e.code, at: e.endedAt || e.startedAt, targetName: name(e.targetTeamId), data: JSON.parse(e.data) })),
    sightings: sightingsFor(me, now),
    giftHints: giftHints(me, now),
    supply: C.ACTIVE.includes(g.status) ? supplyFor(me, g, now) : null,
  };
}

function masterSkills(gameId, now = Date.now()) {
  const rows = q.all("SELECT k.*, t.id AS tid FROM team_skills k JOIN teams t ON t.id = k.teamId WHERE t.gameId = ? ORDER BY k.id", gameId);
  const byTeam = {};
  for (const r of rows) {
    const s = skillById(r.skillId);
    if (s) (byTeam[r.teamId] ||= []).push({ id: s.id, name: s.name, icon: s.icon, kind: s.kind, source: r.source, readyAt: r.readyAt && r.readyAt > now ? r.readyAt : null });
  }
  const effects = activeEffects(gameId, now).map((e) => ({
    id: e.id, teamId: e.teamId, code: e.code, kind: e.kind, until: e.endsAt, targetTeamId: e.targetTeamId,
    name: (e.kind === 'gift' ? giftById(e.code) : skillById(e.code))?.name, teamName: team(e.teamId)?.sectorName, targetName: e.targetTeamId ? team(e.targetTeamId)?.sectorName : null,
  }));
  return { byTeam, effects };
}

// ---------------------------------------------------------------- motore a tempo

const near = new Map(); // allarme di prossimità: coppie già segnalate (chiave "chi:altro")
function tickAll(now = Date.now()) {
  const games = q.all(`SELECT * FROM games WHERE status IN (${C.ACTIVE.map(() => '?').join(',')})`, ...C.ACTIVE);
  for (const g of games) {
    // Notifiche ritardate (Tracker, Rete del Consiglio, Taglia): a 1 minuto dall'attivazione.
    for (const e of q.all('SELECT * FROM skill_effects WHERE gameId = ? AND notifyAt IS NOT NULL AND notifiedAt IS NULL AND notifyAt <= ?', g.id, now)) {
      q.run('UPDATE skill_effects SET notifiedAt = ? WHERE id = ?', now, e.id);
      if (e.endedAt) continue;
      if (e.code === 'rete') {
        const ids = q.all("SELECT id FROM teams WHERE gameId = ? AND kind = 'couple' AND status = 'active' AND id <> ?", g.id, e.teamId).map((r) => r.id);
        for (const id of ids) if (!hidden({ gameId: g.id, id }, now)) rt.pushTeams(g.id, { title: 'Rete del Consiglio', body: 'Una coppia ha visto le posizioni di tutti.', tag: `rete-${e.id}`, url: '/#/home' }, id);
      } else if (e.targetTeamId) {
        const title = e.code === 'taglia' ? 'Taglia su di voi' : 'Siete tracciati';
        const body = e.code === 'taglia' ? 'Tutte le coppie vedono la vostra posizione.' : 'Una coppia segue la vostra posizione sulla mappa.';
        rt.pushTeams(g.id, { title, body, tag: `track-${e.id}`, url: '/#/home' }, e.targetTeamId);
      }
    }
    // Effetti appena finiti: le mappe si aggiornano.
    const ended = q.all('SELECT * FROM skill_effects WHERE gameId = ? AND endedAt IS NULL AND endsAt IS NOT NULL AND endsAt <= ?', g.id, now);
    for (const e of ended) q.run('UPDATE skill_effects SET endedAt = ? WHERE id = ?', e.endsAt, e.id);
    if (ended.length) {
      if (ended.some((e) => e.code === 'taglia' || e.code === 'custode')) rt.toTeams(g.id, 'state', {});
      else for (const id of new Set(ended.map((e) => e.teamId))) rt.toTeams(g.id, 'state', {}, id);
      rt.toStaff(g.id, 'skills');
    }
    // Presagio: allo scadere dei 5 minuti il dono compare a tutti.
    for (const gift of q.all("SELECT * FROM gifts WHERE gameId = ? AND status = 'revealed' AND publicAt IS NOT NULL AND publicAt <= ? AND hintLat IS NOT NULL", g.id, now)) {
      q.run('UPDATE gifts SET hintLat = NULL, hintLng = NULL WHERE id = ?', gift.id);
      G.announce(g.id, 'gift', {}, { giftId: gift.id });
      rt.toTeams(g.id, 'state', {});
    }
    if (g.status !== 'paused') proximity(g, now);
  }
}

function proximity(g, now) {
  const holders = q.all("SELECT t.id FROM teams t JOIN team_skills k ON k.teamId = t.id AND k.skillId = 'allarme' WHERE t.gameId = ? AND t.status = 'active'", g.id).map((r) => r.id);
  if (!holders.length) return;
  const couples = q.all("SELECT id FROM teams WHERE gameId = ? AND kind = 'couple' AND status = 'active'", g.id).map((r) => r.id);
  for (const h of holders) {
    const here = latestPos(h, now);
    if (!here) continue;
    const allies = new Set(K.allianceOf(h)?.members || []);
    for (const o of couples) {
      if (o === h || allies.has(o)) continue;
      const p = latestPos(o, now);
      const key = `${h}:${o}`;
      const d = p ? distM(here, p) : Infinity;
      if (d <= 80 && !near.has(key)) {
        near.set(key, now);
        rt.pushTeams(g.id, { title: 'Presenza rilevata nelle vicinanze', body: '', tag: `allarme-${h}`, url: '/#/home', silent: true }, h);
        rt.toTeams(g.id, 'proximity', {}, h);
      } else if (d > 120) near.delete(key);
    }
  }
}

// Partita di test ripartita: si azzerano ricariche, effetti e Skill vinte con i Doni (la scelta resta).
function resetGame(gameId) {
  q.run('DELETE FROM skill_effects WHERE gameId = ?', gameId);
  q.run("DELETE FROM team_skills WHERE source <> 'chosen' AND teamId IN (SELECT id FROM teams WHERE gameId = ?)", gameId);
  q.run('UPDATE team_skills SET readyAt = NULL WHERE teamId IN (SELECT id FROM teams WHERE gameId = ?)', gameId);
}

module.exports = {
  SKILLS, GIFTS, skillById, giftById, chooseSkill, useSkill, useGift, skillsState, masterSkills, sightingsFor, protectedSeals,
  onGiftRevealed, onAltarUnlocked, scanFactor, tickAll, resetGame, limitsOf,
};
