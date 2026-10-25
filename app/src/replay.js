// Rewind della partita: le tracce delle posizioni e il registro con la posizione di ogni azione,
// coppia per coppia, per rivedere la partita sulla mappa (anche mentre è in corso).
const { q } = require('./db');
const G = require('./game');

// since: solo quello che è arrivato dopo (per aggiornare la regia a partita in corso).
function replayData(gameId, { since = 0 } = {}) {
  const g = G.getGame(gameId);
  const now = Date.now();
  const firstTrack = q.get('SELECT MIN(at) AS at FROM position_track WHERE gameId = ?', g.id)?.at;
  const start = g.startedAt || firstTrack || now;
  const end = g.endedAt || now;
  const from = Math.max(Number(since) || 0, start - 30 * 60000);
  const units = G.teamsOf(g.id).filter((t) => t.sectorId).map((t) => ({
    teamId: t.id, kind: 'couple', roman: t.roman, label: `${t.roman} ${t.sectorName}`, color: t.sectorColor || '#ff4fa3',
    members: q.all('SELECT id, name, nickname FROM players WHERE teamId = ? ORDER BY id', t.id).map((p) => ({ id: p.id, name: p.nickname || p.name })),
  }));
  const elect = G.electOf(g.id);
  if (elect) {
    units.push({ teamId: elect.id, kind: 'elect', roman: '0', label: 'Eletti', color: '#d1ad62',
      members: q.all('SELECT id, name, nickname FROM players WHERE teamId = ? ORDER BY id', elect.id).map((p) => ({ id: p.id, name: p.nickname || p.name })) });
  }
  // Tracce compatte: per coppia e per telefono, punti [istante, lat, lng].
  const tracks = {};
  for (const r of q.all('SELECT teamId, playerId, deviceId, lat, lng, at FROM position_track WHERE gameId = ? AND at > ? ORDER BY at', g.id, from)) {
    const dev = r.playerId != null ? `p${r.playerId}` : `d${r.deviceId}`;
    ((tracks[r.teamId] ||= {})[dev] ||= []).push([r.at, Math.round(r.lat * 1e6) / 1e6, Math.round(r.lng * 1e6) / 1e6]);
  }
  const events = q.all('SELECT id, at, actor, type, data, teamId, lat, lng FROM event_log WHERE gameId = ? AND at > ? ORDER BY at', g.id, from);
  return {
    status: g.status, start, end, now, live: !g.endedAt && !!g.startedAt,
    units, tracks, events,
    places: [
      ...q.all('SELECT p.label, p.lat, p.lng, s.roman FROM points p JOIN sectors s ON s.id = p.sectorId WHERE p.gameId = ? AND p.lat IS NOT NULL', g.id).map((p) => ({ kind: 'altar', text: p.roman, label: p.label, lat: p.lat, lng: p.lng })),
      ...G.landmarksOf(g.id).filter((l) => l.lat != null).map((l) => ({ kind: 'place', place: l.kind, label: l.label || l.kind, lat: l.lat, lng: l.lng })),
    ],
  };
}

module.exports = { replayData };
