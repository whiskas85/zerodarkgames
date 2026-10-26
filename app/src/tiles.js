// Riquadri della mappa (tile) serviti dal nostro server: se li ha su disco li dà subito, altrimenti li scarica
// una volta (OpenTopoMap, o OpenStreetMap se non risponde), li salva e li serve. La regia può scaricare in anticipo
// un'area del campo: le app poi la scaricano sul telefono e la mappa funziona anche senza rete.
const fs = require('fs');
const path = require('path');
const { q, DATA_DIR } = require('./db');
const { HttpError } = require('./util');

const err = (status, msg) => new HttpError(status, msg);
const DIR = path.join(DATA_DIR, 'tiles');
const UA = 'ZeroDarkGames/1.0 (mappa del campo da gioco)';
const MAX_Z = 17;
const MAX_TILES = 4000;

const tilePath = (z, x, y) => path.join(DIR, String(z), String(x), `${y}.png`);
const valid = (z, x, y) => Number.isInteger(z) && Number.isInteger(x) && Number.isInteger(y) && z >= 0 && z <= MAX_Z && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z;

async function fetchWithTimeout(url, ms = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally { clearTimeout(timer); }
}

// Un riquadro alla volta per indirizzo (più telefoni che chiedono lo stesso non lo scaricano due volte).
const inflight = new Map();
async function getTile(z, x, y) {
  if (!valid(z, x, y)) throw err(400, 'Riquadro non valido');
  const file = tilePath(z, x, y);
  if (fs.existsSync(file)) return { file };
  const key = `${z}/${x}/${y}`;
  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      const sub = 'abc'[(x + y) % 3];
      let buf;
      try { buf = await fetchWithTimeout(`https://${sub}.tile.opentopomap.org/${z}/${x}/${y}.png`); } catch {
        buf = await fetchWithTimeout(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`);
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      return { file };
    })().finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

// Riquadri che coprono un'area (sud, ovest, nord, est) dal livello minZ a maxZ.
const lon2x = (lng, z) => Math.floor(((lng + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };
function tilesFor(b, minZ, maxZ) {
  const out = [];
  for (let z = minZ; z <= maxZ; z++) {
    const x0 = lon2x(b.west, z); const x1 = lon2x(b.east, z);
    const y0 = lat2y(b.north, z); const y1 = lat2y(b.south, z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
  }
  return out;
}

function readArea(data) {
  const b = data?.bounds || {};
  const s = Number(b.south); const w = Number(b.west); const n = Number(b.north); const e = Number(b.east);
  if (![s, w, n, e].every(Number.isFinite) || s >= n || w >= e || Math.abs(s) > 85 || Math.abs(n) > 85) throw err(400, 'Area non valida');
  const minZ = Math.max(10, Math.min(MAX_Z, Math.round(Number(data.minZ) || 13)));
  const maxZ = Math.max(minZ, Math.min(MAX_Z, Math.round(Number(data.maxZ) || MAX_Z)));
  return { bounds: { south: s, west: w, north: n, east: e }, minZ, maxZ };
}

const areaOf = (gameId) => { const r = q.get('SELECT offlineMap FROM games WHERE id = ?', Number(gameId)); return r?.offlineMap ? JSON.parse(r.offlineMap) : null; };
const saveArea = (gameId, a) => q.run('UPDATE games SET offlineMap = ? WHERE id = ?', a ? JSON.stringify(a) : null, Number(gameId));

// Scaricamento sul server, in sottofondo (due riquadri alla volta, per non pesare sui server delle mappe).
const jobs = new Map();
function startDownload(gameId, data, actor) {
  const area = readArea(data);
  const list = tilesFor(area.bounds, area.minZ, area.maxZ);
  if (list.length > MAX_TILES) throw err(400, `Area troppo grande: ${list.length} riquadri (massimo ${MAX_TILES}). Stringi l'area o abbassa il dettaglio.`);
  const job = { gameId: Number(gameId), total: list.length, done: 0, failed: 0, running: true, startedAt: Date.now() };
  jobs.set(job.gameId, job);
  saveArea(gameId, { ...area, count: list.length, version: Date.now(), readyAt: null, by: actor || null });
  (async () => {
    let i = 0;
    const worker = async () => {
      while (i < list.length && job.running) {
        const [z, x, y] = list[i++];
        try { await getTile(z, x, y); job.done++; } catch { job.failed++; }
      }
    };
    await Promise.all([worker(), worker()]);
    job.running = false;
    const a = areaOf(gameId);
    if (a) saveArea(gameId, { ...a, readyAt: Date.now(), failed: job.failed });
  })();
  return status(gameId);
}

function status(gameId) {
  const job = jobs.get(Number(gameId));
  const area = areaOf(gameId);
  return { area, job: job ? { total: job.total, done: job.done, failed: job.failed, running: job.running } : null };
}

function clearArea(gameId) {
  const job = jobs.get(Number(gameId));
  if (job) job.running = false;
  saveArea(gameId, null);
  return { ok: true };
}

// Per l'app: l'area da scaricare sul telefono (solo se il server l'ha pronta).
function teamOffline(gameId) {
  const a = areaOf(gameId);
  if (!a?.readyAt || (a.failed || 0) >= a.count) return null;
  return { version: a.version, bounds: a.bounds, minZ: a.minZ, maxZ: a.maxZ, count: a.count };
}

module.exports = { getTile, tilesFor, readArea, startDownload, status, clearArea, teamOffline, MAX_TILES };
