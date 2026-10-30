// Zone della mappa (geofencing lato server): la regia disegna poligoni, le posizioni delle coppie che arrivano
// dicono chi è dentro. Gli effetti valgono solo entrando: chi è già dentro quando la zona nasce (o viene accesa)
// (se non la conosceva: nuova, non abilitata o ridisegnata) non la subisce finché non esce e rientra; se la vedeva già
// in grigio (abilitata e spenta) e viene accesa, la subisce subito. Quando le zone si sovrappongono, per la visibilità vince lo strato più alto.
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
  santuario: { label: 'Santuario', icon: '🏛️', color: '#d1ad62', effect: 'Dentro le Skill in ricarica si ricaricano più in fretta (×{rate}).' },
  conquista: { label: 'Zona di Conquista', icon: '👑', color: '#e5484d', effect: 'La prima coppia che resta dentro {min} minuti di fila vince un Dono a caso.' },
  noplay: { label: 'Zona NO PLAY', icon: '⛔', color: '#ff2a2a', effect: 'Vietato entrare, per coppie ed Eletti. Chi si avvicina ha 30 secondi per allontanarsi, poi la regia viene avvisata.' },
};
// NO PLAY: scatta a 5 m dal bordo (il GPS sbaglia di qualche metro), finisce oltre 15 m fuori; 30 secondi per uscire.
const NOPLAY_NEAR_M = 5;
const NOPLAY_CLEAR_M = 15;
const NOPLAY_GRACE_MS = 30000;
// Santuario: moltiplicatore della ricarica scelto dalla regia (da ×1,1 a ×10; di base ×2).
const DEFAULT_RATE = 2;
const rateOf = (z) => (Number(z.rate) > 1 ? Number(z.rate) : DEFAULT_RATE);
const clampRate = (v) => (v == null || v === '' ? null : Math.max(1.1, Math.min(10, Math.round(Number(String(v).replace(',', '.')) * 10) / 10 || DEFAULT_RATE)));
const fmtRate = (r) => String(r).replace('.', ',');
const effectOf = (z) => KINDS[z.kind].effect.replace('{min}', z.holdMin || 3).replace('{rate}', fmtRate(rateOf(z)));

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
// Distanza dal bordo in metri, con segno: positiva dentro, negativa fuori.
function edgeDepth(pt, poly) {
  const M = 111320;
  const c = Math.cos((pt.lat * Math.PI) / 180);
  const xy = ([la, ln]) => [(ln - pt.lng) * M * c, (la - pt.lat) * M];
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = xy(poly[j]); const [bx, by] = xy(poly[i]);
    const dx = bx - ax; const dy = by - ay;
    const t = dx || dy ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return inside(pt, poly) ? best : -best;
}
// Isteresi sul bordo (il GPS balla di qualche metro e i due telefoni della coppia non coincidono):
// si entra a ENTER_M dentro il bordo, si esce oltre EXIT_M fuori o dopo EXIT_AFTER_MS passati fuori.
const ENTER_M = 3;
const EXIT_M = 12;
const EXIT_AFTER_MS = 45000;
// Conquista: uscire azzera il tempo, quindi il margine è più stretto (6 m o 10 secondi).
const exitM = (z) => (z.kind === 'conquista' ? 6 : EXIT_M);
const exitAfter = (z) => (z.kind === 'conquista' ? 10000 : EXIT_AFTER_MS);
const pointsOf = (z) => JSON.parse(z.points);
// Abilitata = esiste per le coppie (la vedono, anche spenta, e gli Eletti la possono accendere con un Beacon).
// Attiva = accesa: il suo effetto vale. Una zona non abilitata è come se non ci fosse.
const zonesOf = (gameId, activeOnly = true) => q.all(`SELECT * FROM map_zones WHERE gameId = ? ${activeOnly ? 'AND active = 1 AND enabled = 1' : ''} ORDER BY layer, id`, gameId);
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
  // Senza strato indicato la zona nuova va in cima (vince sulle altre finché non la si sposta).
  const top = q.get('SELECT MAX(layer) AS m FROM map_zones WHERE gameId = ?', g.id)?.m || 0;
  const layer = data.layer != null && data.layer !== '' ? Math.max(1, Math.min(999, Math.round(Number(data.layer)) || 1)) : top + 1;
  const holdMin = data.kind === 'conquista' ? Math.max(1, Math.min(60, Math.round(Number(data.holdMin)) || 3)) : null;
  const name = String(data.name || '').trim().slice(0, 60) || KINDS[data.kind].label;
  const active = data.active === false && data.kind !== 'noplay' ? 0 : 1;
  const enabled = data.enabled === false ? 0 : 1;
  const beaconMin = clampBeacon(data.beaconMin);
  const beaconOnMin = clampOn(data.beaconOnMin);
  const rate = data.kind === 'santuario' ? clampRate(data.rate) : null;
  const id = Number(q.run('INSERT INTO map_zones (gameId, kind, name, points, layer, active, enabled, holdMin, beaconMin, beaconOnMin, rate, createdAt, author) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    g.id, data.kind, name, JSON.stringify(pts), layer, active, enabled, holdMin, beaconMin, beaconOnMin, rate, Date.now(), actor || null).lastInsertRowid);
  if (active && enabled) markImmune(getZone(id));
  G.log(g.id, actor, 'zone_created', { name, kind: data.kind, layer });
  changed(g.id);
  return zoneOut(getZone(id));
}
const clampBeacon = (v) => Math.max(1, Math.min(60, Math.round(Number(v)) || 1));
// Quanto resta accesa dopo un Beacon: vuoto o 0 = per sempre (finché non la spegne la regia), altrimenti minuti.
const clampOn = (v) => (v == null || v === '' || !(Number(v) > 0) ? null : Math.max(1, Math.min(600, Math.round(Number(v)))));
const getZone = (id) => q.get('SELECT * FROM map_zones WHERE id = ?', Number(id));

function updateZone(id, data, actor) {
  const z = getZone(id);
  if (!z) throw err(404, 'Zona non trovata');
  const next = { ...z };
  if (data.name !== undefined) next.name = String(data.name || '').trim().slice(0, 60) || KINDS[z.kind].label;
  if (data.layer !== undefined) next.layer = Math.max(1, Math.min(999, Math.round(Number(data.layer)) || 1));
  if (data.holdMin !== undefined && z.kind === 'conquista') next.holdMin = Math.max(1, Math.min(60, Math.round(Number(data.holdMin)) || 3));
  if (data.points !== undefined) next.points = JSON.stringify(cleanPoints(data.points));
  if (data.active !== undefined) next.active = data.active ? 1 : 0;
  if (data.enabled !== undefined) next.enabled = data.enabled ? 1 : 0;
  if (data.beaconMin !== undefined) next.beaconMin = clampBeacon(data.beaconMin);
  if (data.beaconOnMin !== undefined) next.beaconOnMin = clampOn(data.beaconOnMin);
  if (data.rate !== undefined && z.kind === 'santuario') next.rate = clampRate(data.rate);
  // Accesa o spenta dalla regia (o rimessa in palio): niente scadenza, decide la regia. Il Beacon la rimette dopo.
  if (data.active !== undefined || data.reset) next.activeUntil = null;
  // Conquista rimessa in palio: si azzera il vincitore.
  // Riaccesa (dalla regia o da un Beacon) dopo essere stata conquistata: torna in palio.
  const reopen = z.kind === 'conquista' && (data.reset || (!z.active && next.active && !!z.winnerTeamId));
  if (data.reset && z.kind === 'conquista') next.active = 1;
  q.run('UPDATE map_zones SET name = ?, layer = ?, holdMin = ?, points = ?, active = ?, enabled = ?, beaconMin = ?, beaconOnMin = ?, activeUntil = ?, rate = ?, winnerTeamId = ?, wonAt = ?, reward = ? WHERE id = ?',
    next.name, next.layer, next.holdMin, next.points, next.active, next.enabled, next.beaconMin, next.beaconOnMin, next.activeUntil, next.rate ?? null, reopen ? null : z.winnerTeamId, reopen ? null : z.wonAt, reopen ? null : z.reward, z.id);
  // Accesa (dalla regia o da un Beacon): un eventuale Beacon in corso non serve più.
  // Accesa o non più abilitata: un eventuale Beacon in corso non serve più.
  if (next.active || !next.enabled) q.run('UPDATE map_zones SET beaconStartedAt = NULL, beaconEndsAt = NULL, beaconBy = NULL, beaconPlayerId = NULL WHERE id = ?', z.id);
  const on = next.active && next.enabled;
  const wasOn = z.active && z.enabled !== 0;
  // Accesa (o ridisegnata, o rimessa in palio): chi è già dentro la subisce subito solo se la zona era già abilitata
  // (la vedeva in grigio: sapeva che poteva accendersi); se non era abilitata o è stata ridisegnata, è immune finché non esce e rientra.
  if (on && (!wasOn || data.points !== undefined || reopen)) markImmune(getZone(z.id), z.enabled === 0 || data.points !== undefined);
  if (!on) q.run('DELETE FROM zone_presence WHERE zoneId = ?', z.id);
  G.log(z.gameId, actor, 'zone_updated', { name: next.name, active: !!next.active, enabled: !!next.enabled, reset: !!reopen });
  changed(z.gameId);
  return zoneOut(getZone(z.id));
}

// Ordine dalla regia (trascinando): la prima dell'elenco è quella in cima e vince sulle altre quando si sovrappongono.
function reorderZones(gameId, ids, actor) {
  const list = (Array.isArray(ids) ? ids : []).map(Number);
  const mine = new Set(q.all('SELECT id FROM map_zones WHERE gameId = ?', Number(gameId)).map((r) => r.id));
  if (!list.length || list.some((id) => !mine.has(id))) throw err(400, 'Ordine delle zone non valido');
  tx(() => list.forEach((id, i) => q.run('UPDATE map_zones SET layer = ? WHERE id = ?', list.length - i, id)));
  G.log(Number(gameId), actor, 'zone_updated', { name: 'ordine delle zone' });
  changed(Number(gameId));
  return { ok: true };
}

function deleteZone(id, actor) {
  const z = getZone(id);
  if (!z) throw err(404, 'Zona non trovata');
  q.run('DELETE FROM map_zones WHERE id = ?', z.id);
  G.log(z.gameId, actor, 'zone_deleted', { name: z.name });
  changed(z.gameId);
}

// Chi è dentro quando la zona si accende: immune (non la subisce finché non esce e rientra) se la zona non la
// conosceva (nuova, non abilitata, ridisegnata); se invece la vedeva già in grigio sapeva del rischio e la subisce subito.
function markImmune(z, immune = true) {
  q.run('DELETE FROM zone_presence WHERE zoneId = ?', z.id);
  if (z.kind === 'noplay') return;
  const poly = pointsOf(z);
  for (const t of G.teamsOf(z.gameId)) {
    const p = teamPos(t.id);
    if (p && inside(p, poly)) q.run('INSERT INTO zone_presence (zoneId, teamId, inside, immune, enteredAt) VALUES (?, ?, 1, ?, ?)', z.id, t.id, immune ? 1 : 0, Date.now());
  }
}

function changed(gameId) {
  rt.toStaff(gameId, 'zones');
  rt.toTeams(gameId, 'state', {});
}

// ---------------------------------------------------------------- posizioni

// Una posizione nuova di una coppia: ingressi e uscite dalle zone attive.
function onPosition(team, pos, now = Date.now(), player = null) {
  const g = G.getGame(team.gameId);
  if (!C.ACTIVE.includes(g.status)) return;
  // Eletti: per loro conta solo la NO PLAY, telefono per telefono.
  if (team.kind === 'elect') { if (player) noplayCheck(g, team, player, (poly) => edgeDepth(pos, poly), pos, now); return; }
  if (team.kind !== 'couple') return;
  let any = false;
  // Tutti i telefoni della coppia sentiti negli ultimi 2 minuti (la coppia è dentro se almeno uno lo è).
  // Conta il GPS del telefono con l'app aperta (istantaneo); Traccar («trk-…») solo se l'app non manda da 1 minuto.
  const recent = q.all('SELECT deviceId, lat, lng, at FROM positions WHERE teamId = ? AND at > ?', team.id, now - 2 * 60000);
  const fromApp = recent.filter((r) => !String(r.deviceId).startsWith('trk-') && r.at > now - 60000);
  const devs = fromApp.length ? fromApp : recent;
  if (!devs.length) devs.push(pos);
  for (const z of zonesOf(g.id)) {
    if (z.kind === 'noplay') continue;
    const poly = pointsOf(z);
    const depth = Math.max(...devs.map((d) => edgeDepth(d, poly)));
    const pr = q.get('SELECT * FROM zone_presence WHERE zoneId = ? AND teamId = ?', z.id, team.id);
    if (!pr?.inside && depth >= ENTER_M) {
      q.run(`INSERT INTO zone_presence (zoneId, teamId, inside, immune, enteredAt, leftAt, outsideSince) VALUES (?, ?, 1, 0, ?, NULL, NULL)
             ON CONFLICT(zoneId, teamId) DO UPDATE SET inside = 1, immune = 0, enteredAt = excluded.enteredAt, leftAt = NULL, outsideSince = NULL`, z.id, team.id, now);
      G.log(g.id, `coppia:${team.id}`, 'zone_enter', { teamId: team.id, zone: z.name, kind: z.kind, lat: pos.lat, lng: pos.lng });
      any = true;
    } else if (pr?.inside && depth >= 0) {
      if (pr.outsideSince) q.run('UPDATE zone_presence SET outsideSince = NULL WHERE zoneId = ? AND teamId = ?', z.id, team.id);
    } else if (pr?.inside && depth > -exitM(z) && !(pr.outsideSince && now - pr.outsideSince >= exitAfter(z))) {
      // Appena fuori dal bordo: per ora resta dentro.
      if (!pr.outsideSince) q.run('UPDATE zone_presence SET outsideSince = ? WHERE zoneId = ? AND teamId = ?', now, z.id, team.id);
    } else if (pr?.inside) {
      q.run('UPDATE zone_presence SET inside = 0, immune = 0, leftAt = ?, outsideSince = NULL WHERE zoneId = ? AND teamId = ?', now, z.id, team.id);
      if (!pr.immune) G.log(g.id, `coppia:${team.id}`, 'zone_exit', { teamId: team.id, zone: z.name, kind: z.kind, lat: pos.lat, lng: pos.lng });
      any = true;
    }
  }
  if (any) { rt.toTeams(g.id, 'state', {}, team.id); rt.toStaff(g.id, 'zones'); }
  noplayCheck(g, team, null, (poly) => Math.max(...devs.map((d) => edgeDepth(d, poly))), pos, now);
}

// ---------------------------------------------------------------- NO PLAY

const noplayZones = (gameId) => zonesOf(gameId).filter((z) => z.kind === 'noplay');
const openHit = (zoneId, team, player) => (player
  ? q.get('SELECT * FROM noplay_hits WHERE zoneId = ? AND playerId = ? AND leftAt IS NULL', zoneId, player.id)
  : q.get('SELECT * FROM noplay_hits WHERE zoneId = ? AND teamId = ? AND playerId IS NULL AND leftAt IS NULL', zoneId, team.id));
const electLabel = (player) => {
  const sq = player.squadId ? q.get('SELECT name FROM elect_squads WHERE id = ?', player.squadId) : null;
  return `${player.nickname || player.name}${sq ? ` (squadra ${sq.name})` : ' (Eletti)'}`;
};
const coupleLabel = (teamId) => { const t = q.get('SELECT s.roman, s.name FROM teams t LEFT JOIN sectors s ON s.id = t.sectorId WHERE t.id = ?', teamId); return t ? `${t.roman} · Settore ${t.name}` : 'Coppia'; };
const hitWho = (h) => (h.playerId ? electLabel(q.get('SELECT * FROM players WHERE id = ?', h.playerId) || { name: 'Eletto' }) : coupleLabel(h.teamId));
function noplayCheck(g, team, player, depthOf, pos, now) {
  let any = false;
  for (const z of noplayZones(g.id)) {
    const d = depthOf(pointsOf(z));
    const hit = openHit(z.id, team, player);
    if (!hit && d >= -NOPLAY_NEAR_M) {
      q.run('INSERT INTO noplay_hits (gameId, zoneId, teamId, playerId, enteredAt, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?)', g.id, z.id, team.id, player?.id ?? null, now, pos.lat, pos.lng);
      G.log(g.id, player ? `giocatore:${player.id}` : `coppia:${team.id}`, 'noplay_enter', { teamId: team.id, who: player ? electLabel(player) : coupleLabel(team.id), zone: z.name, lat: pos.lat, lng: pos.lng });
      any = true;
    } else if (hit && d < -NOPLAY_CLEAR_M) {
      q.run('UPDATE noplay_hits SET leftAt = ? WHERE id = ?', now, hit.id);
      G.log(g.id, player ? `giocatore:${player.id}` : `coppia:${team.id}`, 'noplay_exit', { teamId: team.id, who: hitWho(hit), zone: z.name, alerted: !!hit.alertedAt });
      if (hit.alertedAt) rt.pushMasters({ title: `⛔ Uscita dalla NO PLAY`, body: `${hitWho(hit)} è uscita da «${z.name}»`, tag: `noplay-${hit.id}`, url: '/regia#mappa' });
      any = true;
    } else if (hit && d >= -NOPLAY_NEAR_M) q.run('UPDATE noplay_hits SET lat = ?, lng = ? WHERE id = ?', pos.lat, pos.lng, hit.id);
  }
  if (any) { rt.toTeams(g.id, 'state', {}, team.id); rt.toStaff(g.id, 'zones'); }
}

// Dopo 30 secondi ancora dentro: avviso alla regia (una volta). Zona spenta o tolta: la violazione si chiude.
function noplayTick(gameId, now) {
  for (const h of q.all(`SELECT h.*, z.name AS zoneName, z.active, z.enabled, z.kind FROM noplay_hits h JOIN map_zones z ON z.id = h.zoneId
                         WHERE h.gameId = ? AND h.leftAt IS NULL`, gameId)) {
    if (!h.active || !h.enabled || h.kind !== 'noplay') {
      q.run('UPDATE noplay_hits SET leftAt = ? WHERE id = ?', now, h.id);
      rt.toTeams(gameId, 'state', {}, h.teamId);
      continue;
    }
    if (h.alertedAt || h.enteredAt + NOPLAY_GRACE_MS > now) continue;
    q.run('UPDATE noplay_hits SET alertedAt = ? WHERE id = ?', now, h.id);
    G.log(gameId, 'sistema', 'noplay_alert', { teamId: h.teamId, who: hitWho(h), zone: h.zoneName, lat: h.lat, lng: h.lng });
    rt.pushMasters({ title: '⛔ NO PLAY violata', body: `${hitWho(h)} è dentro «${h.zoneName}» da oltre 30 secondi`, tag: `noplay-${h.id}`, url: '/regia#mappa', requireInteraction: true });
    rt.toStaff(gameId, 'zones');
    rt.toTeams(gameId, 'state', {}, h.teamId);
  }
}
// Per il telefono: la violazione aperta (della coppia, o di questo Eletto).
function noplayOf(t, player) {
  const h = t.kind === 'elect'
    ? (player ? q.get('SELECT h.*, z.name AS zoneName FROM noplay_hits h JOIN map_zones z ON z.id = h.zoneId WHERE h.playerId = ? AND h.leftAt IS NULL ORDER BY h.id DESC LIMIT 1', player.id) : null)
    : q.get('SELECT h.*, z.name AS zoneName FROM noplay_hits h JOIN map_zones z ON z.id = h.zoneId WHERE h.teamId = ? AND h.playerId IS NULL AND h.leftAt IS NULL ORDER BY h.id DESC LIMIT 1', t.id);
  return h ? { zoneId: h.zoneId, name: h.zoneName, enteredAt: h.enteredAt, deadline: h.enteredAt + NOPLAY_GRACE_MS, alertedAt: h.alertedAt } : null;
}

// Zone che agiscono su una coppia adesso (dentro e non immune), dalla priorità più bassa alla più alta.
function appliedZones(teamId) {
  return q.all(`SELECT z.*, p.enteredAt FROM map_zones z JOIN zone_presence p ON p.zoneId = z.id
                WHERE p.teamId = ? AND p.inside = 1 AND p.immune = 0 AND z.active = 1 AND z.enabled = 1 ORDER BY z.layer, z.id`, teamId);
}

// Visibilità decisa dalle zone: 'hidden' (Cono d'Ombra), 'shown' (Campo di Luce) o null; vince lo strato più alto.
function visibilityOf(teamId) {
  const g = q.get('SELECT g.status FROM games g JOIN teams t ON t.gameId = g.id WHERE t.id = ?', teamId);
  if (!g || !(C.ACTIVE.includes(g.status) || g.status === 'paused')) return null;
  const top = appliedZones(teamId).filter((z) => z.kind === 'ombra' || z.kind === 'luce').at(-1);
  return top ? (top.kind === 'ombra' ? 'hidden' : 'shown') : null;
}
const inEmp = (teamId) => { const g = q.get('SELECT g.status FROM games g JOIN teams t ON t.gameId = g.id WHERE t.id = ?', teamId); return !!g && C.ACTIVE.includes(g.status) && appliedZones(teamId).some((z) => z.kind === 'emp'); };

// Santuario: quante volte più veloce corre la ricarica delle Skill.
// Ogni pochi secondi: Santuario (la ricarica corre al doppio) e Conquista (chi resta dentro abbastanza vince).
let lastTick = Date.now();
function tickAll(now = Date.now()) {
  const dt = Math.min(60000, Math.max(0, now - lastTick));
  lastTick = now;
  const games = q.all(`SELECT id FROM games WHERE status IN (${C.ACTIVE.map(() => '?').join(',')})`, ...C.ACTIVE);
  for (const { id: gameId } of games) {
    noplayTick(gameId, now);
    // Accesa da un Beacon a tempo: allo scadere si spegne da sola.
    for (const z of q.all('SELECT * FROM map_zones WHERE gameId = ? AND active = 1 AND activeUntil IS NOT NULL AND activeUntil <= ?', gameId, now)) {
      updateZone(z.id, { active: false }, 'sistema');
      G.log(gameId, 'sistema', 'zone_beacon_expired', { zone: z.name, minutes: z.beaconOnMin });
    }
    if (dt) {
      // Dentro più Santuari vale il moltiplicatore più alto.
      for (const p of q.all(`SELECT p.teamId, MAX(COALESCE(z.rate, ${DEFAULT_RATE})) AS rate FROM zone_presence p JOIN map_zones z ON z.id = p.zoneId
                             WHERE z.gameId = ? AND z.active = 1 AND z.enabled = 1 AND z.kind = 'santuario' AND p.inside = 1 AND p.immune = 0 GROUP BY p.teamId`, gameId)) {
        q.run('UPDATE team_skills SET readyAt = MAX(?, readyAt - ?) WHERE teamId = ? AND readyAt > ?', now, dt * (p.rate - 1), p.teamId, now);
      }
    }
    for (const z of q.all("SELECT * FROM map_zones WHERE gameId = ? AND active = 1 AND enabled = 1 AND kind = 'conquista' AND winnerTeamId IS NULL", gameId)) {
      const best = q.get('SELECT teamId, enteredAt FROM zone_presence WHERE zoneId = ? AND inside = 1 AND immune = 0 AND enteredAt <= ? ORDER BY enteredAt LIMIT 1', z.id, now - z.holdMin * 60000);
      if (best) conquer(z, best.teamId, now);
    }
  }
}

function conquer(z, teamId, now) {
  tx(() => {
    const t = q.get('SELECT t.*, s.name AS sectorName FROM teams t LEFT JOIN sectors s ON s.id = t.sectorId WHERE t.id = ?', teamId);
    const gift = SK().grantVirtualGift(t, `Conquista · ${z.name}`.slice(0, 36));
    // Conquistata: la zona si spegne (resta segnato chi e quando); la riaccendono gli Eletti con un Beacon o la regia.
    q.run('UPDATE map_zones SET winnerTeamId = ?, wonAt = ?, reward = ?, active = 0, activeUntil = NULL WHERE id = ?', teamId, now, JSON.stringify(gift), z.id);
    q.run('DELETE FROM zone_presence WHERE zoneId = ?', z.id);
    G.log(z.gameId, `coppia:${teamId}`, 'zone_conquered', { teamId, zone: z.name, gift: gift.name });
    rt.pushTeams(z.gameId, { title: `${KINDS.conquista.icon} Zona conquistata`, body: `Avete conquistato «${z.name}»: ${gift.icon} ${gift.name} è tra i vostri doni.`, tag: `zona-${z.id}`, url: '/#/doni' }, teamId);
  });
  changed(z.gameId);
}

// ---------------------------------------------------------------- Beacon degli Eletti

// Le zone spente in cui cade un punto (la più alta per strato per prima).
const offZonesAt = (gameId, pos) => q.all("SELECT * FROM map_zones WHERE gameId = ? AND active = 0 AND enabled = 1 AND kind != 'noplay' ORDER BY layer DESC, id DESC", gameId).filter((z) => inside(pos, pointsOf(z)));
const readPos = (body) => {
  const lat = Number(body?.lat); const lng = Number(body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw err(400, 'Posizione non disponibile: attiva il GPS');
  return { lat, lng };
};
const electName = (player) => (player ? player.nickname || player.name : 'Eletti');
function requireElect(team, player) {
  if (!team || team.kind !== 'elect') throw err(403, 'Il Beacon lo lanciano gli Eletti');
  if (!player) throw err(403, 'Serve il tuo accesso personale di Eletto');
}

// Lancio: vicino a un Altare lo disattiva, dentro una zona spenta parte la sequenza (beaconMin minuti).
// Se nel punto ci sono più bersagli (un Altare dentro una zona, zone sovrapposte…) si risponde con l'elenco e
// l'Eletto sceglie: il telefono rimanda la richiesta con target { kind: 'altar' | 'zone', id }.
function beaconTargets(gameId, pos) {
  return [
    ...altarsAt(gameId, pos).map((p) => ({ kind: 'altar', id: p.id, name: p.label, action: 'disattiva', icon: '⛬', off: (p.disabledUntil || 0) > Date.now() })),
    ...offZonesAt(gameId, pos).map((z) => ({ kind: 'zone', id: z.id, name: z.name, action: 'attiva', icon: KINDS[z.kind].icon, label: KINDS[z.kind].label, color: KINDS[z.kind].color, beaconMin: z.beaconMin })),
  ];
}
function launchBeacon(team, player, body) {
  requireElect(team, player);
  const pos = readPos(body);
  const targets = beaconTargets(team.gameId, pos);
  if (!targets.length) throw err(409, 'Non siete all\'interno di un\'area da attivare né vicino a un Altare');
  const want = body?.target;
  const pick = want ? targets.find((t) => t.kind === want.kind && t.id === Number(want.id)) : targets.length === 1 ? targets[0] : null;
  if (want && !pick) throw err(409, 'Non siete più nel raggio di quel bersaglio: rilanciate il Beacon');
  if (!pick) return { choose: true, targets };
  // Vicino a un Altare (entro il suo raggio di lettura): l'Altare si disattiva subito per altarBeaconMin minuti.
  if (pick.kind === 'altar') return disableAltar(team, player, q.get('SELECT * FROM points WHERE id = ?', pick.id), pos);
  const z = getZone(pick.id);
  const now = Date.now();
  if (!(z.beaconEndsAt && z.beaconEndsAt > now - 60000)) {
    q.run('UPDATE map_zones SET beaconStartedAt = ?, beaconEndsAt = ?, beaconBy = ?, beaconPlayerId = ? WHERE id = ?', now, now + z.beaconMin * 60000, electName(player), player.id, z.id);
    G.log(z.gameId, `giocatore:${player.id}`, 'zone_beacon', { zone: z.name, minutes: z.beaconMin, lat: pos.lat, lng: pos.lng });
    rt.toStaff(z.gameId, 'zones');
  }
  return beaconOut(getZone(z.id));
}

// Altari nel raggio di lettura, dal più vicino.
function altarsAt(gameId, pos) {
  const g = G.getGame(gameId);
  const radius = Number(g.altarRadiusM) > 0 ? Number(g.altarRadiusM) : 30;
  return q.all('SELECT * FROM points WHERE gameId = ? AND lat IS NOT NULL', gameId)
    .map((p) => ({ p, d: SK().distM(pos, p) })).filter((x) => x.d <= radius).sort((a, b) => a.d - b.d).map((x) => x.p);
}
function disableAltar(team, player, p, pos) {
  const g = G.getGame(team.gameId);
  const min = Number(g.altarBeaconMin) > 0 ? Number(g.altarBeaconMin) : 15;
  const now = Date.now();
  const until = Math.max(p.disabledUntil || 0, now + min * 60000);
  q.run('UPDATE points SET disabledUntil = ?, disabledBy = ? WHERE id = ?', until, electName(player), p.id);
  G.log(g.id, `giocatore:${player.id}`, 'altar_beacon', { point: p.label, minutes: min, lat: pos.lat, lng: pos.lng });
  closeBeaconTasks(player, `point:${p.id}`);
  rt.toStaff(g.id, 'points');
  rt.toTeams(g.id, 'state', {});
  return { kind: 'altar', id: p.id, name: p.label, until, minutes: min };
}

// Fine della sequenza: se si è ancora dentro l'area la zona si accende, altrimenti il Beacon si interrompe.
function completeBeacon(team, player, zoneId, body) {
  requireElect(team, player);
  const z = getZone(zoneId);
  if (!z || z.gameId !== team.gameId) throw err(404, 'Zona non trovata');
  if (z.active) return { ok: true, active: true, zone: beaconOut(z) };
  if (!z.beaconEndsAt) throw err(409, 'Nessun Beacon in corso in questa zona');
  const now = Date.now();
  if (now < z.beaconEndsAt - 3000) throw err(409, 'Il Beacon non ha ancora finito');
  const pos = readPos(body);
  if (!inside(pos, pointsOf(z))) {
    q.run('UPDATE map_zones SET beaconStartedAt = NULL, beaconEndsAt = NULL, beaconBy = NULL, beaconPlayerId = NULL WHERE id = ?', z.id);
    G.log(z.gameId, `giocatore:${player.id}`, 'zone_beacon_failed', { zone: z.name, lat: pos.lat, lng: pos.lng });
    rt.toStaff(z.gameId, 'zones');
    throw err(409, 'Siete usciti dall\'area: Beacon interrotto');
  }
  updateZone(z.id, { active: true }, `eletti:${electName(player)}`);
  // Accesa dal Beacon: resta accesa per i minuti impostati dalla regia (o per sempre), poi si spegne da sola.
  const until = z.beaconOnMin ? Date.now() + z.beaconOnMin * 60000 : null;
  if (until) { q.run('UPDATE map_zones SET activeUntil = ? WHERE id = ?', until, z.id); changed(z.gameId); }
  closeBeaconTasks(player, `zone:${z.id}`);
  G.log(z.gameId, `giocatore:${player.id}`, 'zone_beacon_done', { zone: z.name, minutes: z.beaconOnMin || null, lat: pos.lat, lng: pos.lng });
  return { ok: true, active: true, zone: beaconOut(getZone(z.id)) };
}

const beaconOut = (z) => ({ id: z.id, name: z.name, kind: z.kind, label: KINDS[z.kind].label, icon: KINDS[z.kind].icon, color: KINDS[z.kind].color,
  active: !!z.active, beaconMin: z.beaconMin, beaconOnMin: z.beaconOnMin || null, activeUntil: z.activeUntil || null, startedAt: z.beaconStartedAt, endsAt: z.beaconEndsAt, by: z.beaconBy });

// Per l'app degli Eletti: le zone spente (da attivare) e il Beacon in corso di questa persona.
// Per l'app degli Eletti: tutto ciò che il Beacon può azionare (zone spente da accendere, Altari piazzati da
// disattivare) con la geometria per le distanze dal telefono, gli incarichi Beacon della squadra e il Beacon in corso.
function electBeacon(team, player) {
  if (!team || team.kind !== 'elect') return null;
  const g = G.getGame(team.gameId);
  const off = q.all("SELECT * FROM map_zones WHERE gameId = ? AND active = 0 AND enabled = 1 AND kind != 'noplay' ORDER BY name", team.gameId);
  const mine = player ? off.find((z) => z.beaconPlayerId === player.id && z.beaconEndsAt && z.beaconEndsAt > Date.now() - 60000) : null;
  const radius = Number(g.altarRadiusM) > 0 ? Number(g.altarRadiusM) : 30;
  const tasks = player?.squadId ? q.all("SELECT id, text, targetRef FROM squad_tasks WHERE squadId = ? AND kind = 'beacon' AND doneAt IS NULL AND cancelledAt IS NULL", player.squadId) : [];
  const taskOf = (ref) => tasks.find((t) => t.targetRef === ref) || null;
  const targets = [
    ...off.map((z) => ({ ...beaconOut(z), ref: `zone:${z.id}`, points: pointsOf(z), task: taskOf(`zone:${z.id}`) })),
    ...q.all('SELECT * FROM points WHERE gameId = ? AND lat IS NOT NULL ORDER BY id', team.gameId).map((p) => ({
      kind: 'altar', id: p.id, ref: `point:${p.id}`, name: p.label, icon: '⛬', lat: p.lat, lng: p.lng, radius, minutes: Number(g.altarBeaconMin) > 0 ? Number(g.altarBeaconMin) : 15,
      disabledUntil: (p.disabledUntil || 0) > Date.now() ? p.disabledUntil : null, task: taskOf(`point:${p.id}`) })),
  ];
  return { off: off.map(beaconOut), targets, running: mine ? beaconOut(mine) : null };
}

// Incarico Beacon della squadra su quel bersaglio: riuscito il Beacon, si chiude da solo.
function closeBeaconTasks(player, ref) {
  if (!player?.squadId) return;
  const F = require('./field');
  for (const t of q.all("SELECT id FROM squad_tasks WHERE squadId = ? AND kind = 'beacon' AND targetRef = ? AND doneAt IS NULL AND cancelledAt IS NULL", player.squadId, ref)) {
    F.setTaskDone(t.id, true, `eletti:${electName(player)}`);
  }
}

// ---------------------------------------------------------------- viste

function zoneOut(z) {
  return { id: z.id, kind: z.kind, name: z.name, points: pointsOf(z), layer: z.layer, active: !!z.active, enabled: z.enabled !== 0, holdMin: z.holdMin, rate: z.kind === 'santuario' ? rateOf(z) : null, beaconMin: z.beaconMin, beaconOnMin: z.beaconOnMin || null, activeUntil: z.activeUntil || null, beaconEndsAt: z.beaconEndsAt, beaconBy: z.beaconBy,
    label: KINDS[z.kind].label, icon: KINDS[z.kind].icon, color: KINDS[z.kind].color, effect: effectOf(z),
    winnerTeamId: z.winnerTeamId, wonAt: z.wonAt, reward: z.reward ? JSON.parse(z.reward) : null,
    winnerLabel: z.winnerTeamId ? (() => { const w = q.get('SELECT s.roman, s.name FROM teams t JOIN sectors s ON s.id = t.sectorId WHERE t.id = ?', z.winnerTeamId); return w ? `${w.roman} ${w.name}` : null; })() : null };
}

function masterZones(gameId) {
  return { kinds: KINDS, list: zonesOf(gameId, false).map((z) => ({ ...zoneOut(z),
    inside: q.all('SELECT p.teamId, p.immune, p.enteredAt FROM zone_presence p WHERE p.zoneId = ? AND p.inside = 1', z.id),
    violations: z.kind === 'noplay' ? q.all('SELECT * FROM noplay_hits WHERE zoneId = ? AND (leftAt IS NULL OR leftAt > ?) ORDER BY id DESC LIMIT 20', z.id, Date.now() - 3 * 3600000)
      .map((h) => ({ id: h.id, who: hitWho(h), teamId: h.teamId, playerId: h.playerId, enteredAt: h.enteredAt, alertedAt: h.alertedAt, leftAt: h.leftAt, lat: h.lat, lng: h.lng })) : [] })) };
}

// Per la coppia: tutte le zone attive (con l'effetto), quelle in cui è adesso e l'avanzamento della Conquista.
function teamZones(t, player = null) {
  if (!t || !['couple', 'elect'].includes(t.kind)) return null;
  // Eletti: vedono le zone abilitate (accese e spente: dove lanciare il Beacon), senza effetti su di loro.
  if (t.kind === 'elect') {
    return { list: q.all('SELECT * FROM map_zones WHERE gameId = ? AND enabled = 1 ORDER BY layer, id', t.gameId).map(zoneOut), here: [], visibility: null, emp: false, won: [], recharge: 1,
      countdown: !!G.getGame(t.gameId).zoneCountdown, noplay: noplayOf(t, player) };
  }
  // Prima del Cerchio le coppie non vedono le zone (come gli altri luoghi del gioco).
  if (['created', 'draft', 'ready'].includes(G.getGame(t.gameId).status)) return null;
  const now = Date.now();
  // Effetti (e animazioni) solo a partita in corso: a fine partita restano le zone sulla mappa.
  const g = G.getGame(t.gameId);
  const mine = C.ACTIVE.includes(g.status) || g.status === 'paused' ? appliedZones(t.id) : [];
  return {
    // Le zone abilitate, anche spente (in grigio: si possono accendere con un Beacon degli Eletti).
    list: q.all('SELECT * FROM map_zones WHERE gameId = ? AND enabled = 1 ORDER BY layer, id', t.gameId).map(zoneOut),
    here: mine.map((z) => ({ id: z.id, kind: z.kind, name: z.name, enteredAt: z.enteredAt, holdMin: z.holdMin,
      holdUntil: z.kind === 'conquista' && !z.winnerTeamId ? z.enteredAt + z.holdMin * 60000 : null })),
    visibility: visibilityOf(t.id),
    // La regia sceglie se mostrare sulla mappa quanto manca allo spegnimento delle zone a tempo.
    countdown: !!g.zoneCountdown,
    noplay: noplayOf(t, null),
    // Zone in cui la coppia era già dentro quando sono nate: il telefono non ne mostra l'effetto finché non esce e rientra.
    immune: q.all('SELECT zoneId FROM zone_presence WHERE teamId = ? AND inside = 1 AND immune = 1', t.id).map((r) => r.zoneId),
    emp: mine.some((z) => z.kind === 'emp'),
    // Dentro un Santuario: la ricarica delle Skill corre più veloce (il moltiplicatore più alto).
    recharge: Math.max(1, ...mine.filter((z) => z.kind === 'santuario').map(rateOf)),
    won: q.all('SELECT * FROM map_zones WHERE gameId = ? AND winnerTeamId = ? AND wonAt > ?', t.gameId, t.id, now - 30 * 60000).map((z) => ({ id: z.id, name: z.name, wonAt: z.wonAt, reward: JSON.parse(z.reward || 'null') })),
  };
}

module.exports = { NOPLAY_GRACE_MS, KINDS, inside, reorderZones, launchBeacon, completeBeacon, electBeacon, createZone, updateZone, deleteZone, onPosition, appliedZones, visibilityOf, inEmp, tickAll, masterZones, teamZones };
