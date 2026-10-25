// Zone della mappa (geofencing lato server): la regia disegna poligoni, le posizioni delle coppie che arrivano
// dicono chi è dentro. Gli effetti valgono solo entrando: chi è già dentro quando la zona nasce (o viene accesa)
// non la subisce finché non esce e rientra. Quando le zone si sovrappongono, per la visibilità vince lo strato più alto.
const { q, tx } = require('./db');
const C = require('./constants');
const G = require('./game');
const rt = require('./realtime');
const { HttpError } = require('./util');

const err = (status, msg) => new HttpError(status, msg);
const SK = () => require('./skills');

const KINDS = {
  ombra: { label: 'Cono d\'Ombra', icon: '🌑', color: '#5b4b8a', effect: 'Finché restate dentro nessuna coppia vi vede sulla mappa, qualunque Skill o Dono usi (la regia sì).' },
  luce: { label: 'Campo di Luce', icon: '☀️', color: '#f0a020', effect: 'Finché restate dentro tutte le coppie vi vedono sulla mappa.' },
  emp: { label: 'Zona di Disturbo', icon: '⚡', color: '#22c3e6', effect: 'Dentro non funzionano le Skill attive e la mappa è oscurata.' },
  santuario: { label: 'Santuario', icon: '🏛️', color: '#d1ad62', effect: 'Dentro le Skill in ricarica si ricaricano al doppio della velocità.' },
  conquista: { label: 'Zona di Conquista', icon: '👑', color: '#e5484d', effect: 'La prima coppia che resta dentro {min} minuti di fila vince un Dono a caso.' },
};
const effectOf = (z) => KINDS[z.kind].effect.replace('{min}', z.holdMin || 3);

// ---------------------------------------------------------------- geometria

// Punto nel poligono (ray casting su lat/lng: per un campo da gioco va benissimo).
function inside(pt, poly) {
  let ok = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i]; const [yj, xj] = poly[j];
    if (((yi > pt.lat) !== (yj > pt.lat)) && pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi) ok = !ok;
  }
  return ok;
}
const pointsOf = (z) => JSON.parse(z.points);
const zonesOf = (gameId, activeOnly = true) => q.all(`SELECT * FROM map_zones WHERE gameId = ? ${activeOnly ? 'AND active = 1' : ''} ORDER BY layer, id`, gameId);
const teamPos = (teamId, now = Date.now()) => q.get('SELECT lat, lng, at FROM positions WHERE teamId = ? AND at > ? ORDER BY at DESC LIMIT 1', teamId, now - 10 * 60000);

// ---------------------------------------------------------------- regia

function cleanPoints(list) {
  const pts = (Array.isArray(list) ? list : []).map((p) => [Number(p[0] ?? p.lat), Number(p[1] ?? p.lng)])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180);
  if (pts.length < 3) throw err(400, 'Una zona ha almeno 3 punti');
  if (pts.length > 200) throw err(400, 'Troppi punti (massimo 200)');
  return pts.map(([a, b]) => [Math.round(a * 1e6) / 1e6, Math.round(b * 1e6) / 1e6]);
}

function createZone(gameId, data, actor) {
  const g = G.getGame(gameId);
  if (!KINDS[data.kind]) throw err(400, 'Tipo di zona non valido');
  const pts = cleanPoints(data.points);
  const layer = Math.max(1, Math.min(99, Math.round(Number(data.layer)) || 1));
  const holdMin = data.kind === 'conquista' ? Math.max(1, Math.min(60, Math.round(Number(data.holdMin)) || 3)) : null;
  const name = String(data.name || '').trim().slice(0, 60) || KINDS[data.kind].label;
  const active = data.active === false ? 0 : 1;
  const id = Number(q.run('INSERT INTO map_zones (gameId, kind, name, points, layer, active, holdMin, createdAt, author) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    g.id, data.kind, name, JSON.stringify(pts), layer, active, holdMin, Date.now(), actor || null).lastInsertRowid);
  if (active) markImmune(getZone(id));
  G.log(g.id, actor, 'zone_created', { name, kind: data.kind, layer });
  changed(g.id);
  return zoneOut(getZone(id));
}
const getZone = (id) => q.get('SELECT * FROM map_zones WHERE id = ?', Number(id));

function updateZone(id, data, actor) {
  const z = getZone(id);
  if (!z) throw err(404, 'Zona non trovata');
  const next = { ...z };
  if (data.name !== undefined) next.name = String(data.name || '').trim().slice(0, 60) || KINDS[z.kind].label;
  if (data.layer !== undefined) next.layer = Math.max(1, Math.min(99, Math.round(Number(data.layer)) || 1));
  if (data.holdMin !== undefined && z.kind === 'conquista') next.holdMin = Math.max(1, Math.min(60, Math.round(Number(data.holdMin)) || 3));
  if (data.points !== undefined) next.points = JSON.stringify(cleanPoints(data.points));
  if (data.active !== undefined) next.active = data.active ? 1 : 0;
  // Conquista rimessa in palio: si azzera il vincitore.
  const reopen = data.reset && z.kind === 'conquista';
  q.run('UPDATE map_zones SET name = ?, layer = ?, holdMin = ?, points = ?, active = ?, winnerTeamId = ?, wonAt = ?, reward = ? WHERE id = ?',
    next.name, next.layer, next.holdMin, next.points, next.active, reopen ? null : z.winnerTeamId, reopen ? null : z.wonAt, reopen ? null : z.reward, z.id);
  // Accesa (o ridisegnata, o rimessa in palio): chi è già dentro non la subisce finché non esce.
  if (next.active && (!z.active || data.points !== undefined || reopen)) markImmune(getZone(z.id));
  if (!next.active) q.run('DELETE FROM zone_presence WHERE zoneId = ?', z.id);
  G.log(z.gameId, actor, 'zone_updated', { name: next.name, active: !!next.active, reset: !!reopen });
  changed(z.gameId);
  return zoneOut(getZone(z.id));
}

function deleteZone(id, actor) {
  const z = getZone(id);
  if (!z) throw err(404, 'Zona non trovata');
  q.run('DELETE FROM map_zones WHERE id = ?', z.id);
  G.log(z.gameId, actor, 'zone_deleted', { name: z.name });
  changed(z.gameId);
}

function markImmune(z) {
  q.run('DELETE FROM zone_presence WHERE zoneId = ?', z.id);
  const poly = pointsOf(z);
  for (const t of G.teamsOf(z.gameId)) {
    const p = teamPos(t.id);
    if (p && inside(p, poly)) q.run('INSERT INTO zone_presence (zoneId, teamId, inside, immune, enteredAt) VALUES (?, ?, 1, 1, ?)', z.id, t.id, Date.now());
  }
}

function changed(gameId) {
  rt.toStaff(gameId, 'zones');
  rt.toTeams(gameId, 'state', {});
}

// ---------------------------------------------------------------- posizioni

// Una posizione nuova di una coppia: ingressi e uscite dalle zone attive.
function onPosition(team, pos, now = Date.now()) {
  if (team.kind !== 'couple') return;
  const g = G.getGame(team.gameId);
  if (!C.ACTIVE.includes(g.status)) return;
  let any = false;
  for (const z of zonesOf(g.id)) {
    const isIn = inside(pos, pointsOf(z));
    const pr = q.get('SELECT * FROM zone_presence WHERE zoneId = ? AND teamId = ?', z.id, team.id);
    if (isIn && !pr?.inside) {
      q.run(`INSERT INTO zone_presence (zoneId, teamId, inside, immune, enteredAt, leftAt) VALUES (?, ?, 1, 0, ?, NULL)
             ON CONFLICT(zoneId, teamId) DO UPDATE SET inside = 1, immune = 0, enteredAt = excluded.enteredAt, leftAt = NULL`, z.id, team.id, now);
      G.log(g.id, `coppia:${team.id}`, 'zone_enter', { teamId: team.id, zone: z.name, kind: z.kind, lat: pos.lat, lng: pos.lng });
      any = true;
    } else if (!isIn && pr?.inside) {
      q.run('UPDATE zone_presence SET inside = 0, immune = 0, leftAt = ? WHERE zoneId = ? AND teamId = ?', now, z.id, team.id);
      if (!pr.immune) G.log(g.id, `coppia:${team.id}`, 'zone_exit', { teamId: team.id, zone: z.name, kind: z.kind, lat: pos.lat, lng: pos.lng });
      any = true;
    }
  }
  if (any) { rt.toTeams(g.id, 'state', {}, team.id); rt.toStaff(g.id, 'zones'); }
}

// Zone che agiscono su una coppia adesso (dentro e non immune), dalla priorità più bassa alla più alta.
function appliedZones(teamId) {
  return q.all(`SELECT z.*, p.enteredAt FROM map_zones z JOIN zone_presence p ON p.zoneId = z.id
                WHERE p.teamId = ? AND p.inside = 1 AND p.immune = 0 AND z.active = 1 ORDER BY z.layer, z.id`, teamId);
}

// Visibilità decisa dalle zone: 'hidden' (Cono d'Ombra), 'shown' (Campo di Luce) o null; vince lo strato più alto.
function visibilityOf(teamId) {
  const top = appliedZones(teamId).filter((z) => z.kind === 'ombra' || z.kind === 'luce').at(-1);
  return top ? (top.kind === 'ombra' ? 'hidden' : 'shown') : null;
}
const inEmp = (teamId) => appliedZones(teamId).some((z) => z.kind === 'emp');

// Ogni pochi secondi: Santuario (la ricarica corre al doppio) e Conquista (chi resta dentro abbastanza vince).
let lastTick = Date.now();
function tickAll(now = Date.now()) {
  const dt = Math.min(60000, Math.max(0, now - lastTick));
  lastTick = now;
  const games = q.all(`SELECT id FROM games WHERE status IN (${C.ACTIVE.map(() => '?').join(',')})`, ...C.ACTIVE);
  for (const { id: gameId } of games) {
    if (dt) {
      for (const p of q.all(`SELECT DISTINCT p.teamId FROM zone_presence p JOIN map_zones z ON z.id = p.zoneId
                             WHERE z.gameId = ? AND z.active = 1 AND z.kind = 'santuario' AND p.inside = 1 AND p.immune = 0`, gameId)) {
        q.run('UPDATE team_skills SET readyAt = MAX(?, readyAt - ?) WHERE teamId = ? AND readyAt > ?', now, dt, p.teamId, now);
      }
    }
    for (const z of q.all("SELECT * FROM map_zones WHERE gameId = ? AND active = 1 AND kind = 'conquista' AND winnerTeamId IS NULL", gameId)) {
      const best = q.get('SELECT teamId, enteredAt FROM zone_presence WHERE zoneId = ? AND inside = 1 AND immune = 0 AND enteredAt <= ? ORDER BY enteredAt LIMIT 1', z.id, now - z.holdMin * 60000);
      if (best) conquer(z, best.teamId, now);
    }
  }
}

function conquer(z, teamId, now) {
  tx(() => {
    const t = q.get('SELECT t.*, s.name AS sectorName FROM teams t LEFT JOIN sectors s ON s.id = t.sectorId WHERE t.id = ?', teamId);
    const gift = SK().grantVirtualGift(t, `Conquista · ${z.name}`.slice(0, 36));
    q.run('UPDATE map_zones SET winnerTeamId = ?, wonAt = ?, reward = ? WHERE id = ?', teamId, now, JSON.stringify(gift), z.id);
    G.log(z.gameId, `coppia:${teamId}`, 'zone_conquered', { teamId, zone: z.name, gift: gift.name });
    rt.pushTeams(z.gameId, { title: `${KINDS.conquista.icon} Zona conquistata`, body: `Avete conquistato «${z.name}»: ${gift.icon} ${gift.name} è tra i vostri doni.`, tag: `zona-${z.id}`, url: '/#/doni' }, teamId);
  });
  changed(z.gameId);
}

// ---------------------------------------------------------------- viste

function zoneOut(z) {
  return { id: z.id, kind: z.kind, name: z.name, points: pointsOf(z), layer: z.layer, active: !!z.active, holdMin: z.holdMin,
    label: KINDS[z.kind].label, icon: KINDS[z.kind].icon, color: KINDS[z.kind].color, effect: effectOf(z),
    winnerTeamId: z.winnerTeamId, wonAt: z.wonAt, reward: z.reward ? JSON.parse(z.reward) : null };
}

function masterZones(gameId) {
  return { kinds: KINDS, list: zonesOf(gameId, false).map((z) => ({ ...zoneOut(z),
    inside: q.all('SELECT p.teamId, p.immune, p.enteredAt FROM zone_presence p WHERE p.zoneId = ? AND p.inside = 1', z.id) })) };
}

// Per la coppia: tutte le zone attive (con l'effetto), quelle in cui è adesso e l'avanzamento della Conquista.
function teamZones(t) {
  if (!t || t.kind !== 'couple') return null;
  const now = Date.now();
  const mine = appliedZones(t.id);
  return {
    list: zonesOf(t.gameId).filter((z) => !(z.kind === 'conquista' && z.winnerTeamId)).map(zoneOut),
    here: mine.map((z) => ({ id: z.id, kind: z.kind, name: z.name, enteredAt: z.enteredAt, holdMin: z.holdMin,
      holdUntil: z.kind === 'conquista' && !z.winnerTeamId ? z.enteredAt + z.holdMin * 60000 : null })),
    visibility: visibilityOf(t.id),
    emp: mine.some((z) => z.kind === 'emp'),
    won: q.all('SELECT * FROM map_zones WHERE gameId = ? AND winnerTeamId = ? AND wonAt > ?', t.gameId, t.id, now - 30 * 60000).map((z) => ({ id: z.id, name: z.name, wonAt: z.wonAt, reward: JSON.parse(z.reward || 'null') })),
  };
}

module.exports = { KINDS, inside, createZone, updateZone, deleteZone, onPosition, appliedZones, visibilityOf, inEmp, tickAll, masterZones, teamZones };
