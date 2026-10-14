'use strict';
// Database SQLite (modulo nativo node:sqlite) con schema e helper minimi.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'zdg.sqlite'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, passHash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('master','validator')), displayName TEXT, createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, kind TEXT NOT NULL, refId INTEGER NOT NULL, createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sectors (
  id INTEGER PRIMARY KEY, ord INTEGER NOT NULL, roman TEXT NOT NULL, name TEXT NOT NULL,
  article TEXT NOT NULL, element TEXT NOT NULL, motto TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
  scheduledStart TEXT, startedAt INTEGER, endedAt INTEGER,
  durationMin INTEGER NOT NULL DEFAULT 240, truceMin INTEGER NOT NULL DEFAULT 5,
  firstRevelationDelayMin INTEGER NOT NULL DEFAULT 30, lastRevelationBeforeEndMin INTEGER NOT NULL DEFAULT 30,
  neverRevealedCount INTEGER NOT NULL DEFAULT 2, codeLength INTEGER NOT NULL DEFAULT 6,
  emergencyRadioChannel TEXT, bookUrl TEXT,
  pausedAt INTEGER, pausedFrom TEXT, totalPausedMs INTEGER NOT NULL DEFAULT 0,
  phrase TEXT, registrationOpen INTEGER NOT NULL DEFAULT 1,
  templates TEXT, timers TEXT, createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  sectorId INTEGER REFERENCES sectors(id), displayName TEXT,
  loginToken TEXT UNIQUE NOT NULL, accessCode TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', finishPosition INTEGER, wonAt INTEGER, createdAt INTEGER NOT NULL,
  UNIQUE (gameId, sectorId)
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name TEXT NOT NULL, nickname TEXT, phone TEXT, note TEXT,
  regGroup TEXT, requestedTeamName TEXT, selfRegistered INTEGER NOT NULL DEFAULT 0,
  teamId INTEGER REFERENCES teams(id) ON DELETE SET NULL, createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sector_codes (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  sectorId INTEGER NOT NULL REFERENCES sectors(id), code TEXT NOT NULL,
  neverRevealed INTEGER NOT NULL DEFAULT 0, UNIQUE (gameId, sectorId), UNIQUE (gameId, code)
);

CREATE TABLE IF NOT EXISTS points (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  sectorId INTEGER NOT NULL REFERENCES sectors(id), qrToken TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL, locationNote TEXT, UNIQUE (gameId, sectorId)
);

CREATE TABLE IF NOT EXISTS fragments (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  pointId INTEGER UNIQUE NOT NULL REFERENCES points(id) ON DELETE CASCADE,
  text TEXT NOT NULL, position INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS team_fragments (
  teamId INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  fragmentId INTEGER NOT NULL REFERENCES fragments(id) ON DELETE CASCADE,
  source TEXT NOT NULL, acquiredAt INTEGER NOT NULL, PRIMARY KEY (teamId, fragmentId)
);

CREATE TABLE IF NOT EXISTS team_code_notes (
  id INTEGER PRIMARY KEY, teamId INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  sectorId INTEGER NOT NULL, code TEXT NOT NULL, correct INTEGER NOT NULL, addedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS team_visits (
  teamId INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  pointId INTEGER NOT NULL REFERENCES points(id) ON DELETE CASCADE,
  visitedAt INTEGER NOT NULL, PRIMARY KEY (teamId, pointId)
);

CREATE TABLE IF NOT EXISTS revelations (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  sectorId INTEGER NOT NULL, ord INTEGER NOT NULL, scheduledMin REAL,
  firedAt INTEGER, status TEXT NOT NULL DEFAULT 'scheduled'
);

CREATE TABLE IF NOT EXISTS supply_drops (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  scheduledMin REAL, firedAt INTEGER, description TEXT, message TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled'
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  type TEXT NOT NULL, text TEXT NOT NULL, payload TEXT, createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  teamId INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  fromRole TEXT NOT NULL, author TEXT, text TEXT NOT NULL, createdAt INTEGER NOT NULL, readAt INTEGER
);

CREATE TABLE IF NOT EXISTS validations (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  teamId INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE, validatorId INTEGER,
  at INTEGER NOT NULL, result TEXT NOT NULL, missing TEXT, notes TEXT
);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY, gameId INTEGER, at INTEGER NOT NULL, actor TEXT, type TEXT NOT NULL, data TEXT
);

CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY, endpoint TEXT UNIQUE NOT NULL, data TEXT NOT NULL,
  teamId INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  userId INTEGER REFERENCES users(id) ON DELETE CASCADE, createdAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_players_game ON players(gameId);
CREATE INDEX IF NOT EXISTS ix_ann_game ON announcements(gameId, id);
CREATE INDEX IF NOT EXISTS ix_log_game ON event_log(gameId, id);
CREATE INDEX IF NOT EXISTS ix_msg_team ON messages(teamId, id);
`);

// Migrazioni leggere: colonne aggiunte dopo la prima versione.
function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn('games', 'isDemo', 'INTEGER NOT NULL DEFAULT 0');
addColumn('sectors', 'archived', 'INTEGER NOT NULL DEFAULT 0');
addColumn('sectors', 'altarLabel', 'TEXT');
addColumn('players', 'requestedSectorId', 'INTEGER');
addColumn('players', 'status', "TEXT NOT NULL DEFAULT 'accepted'");
// Come si è iscritto: in coppia, da temerario solitario o come candidato agli Eletti del Consiglio.
addColumn('players', 'requestedRole', 'TEXT');
// Accesso personale all'app subito dopo l'iscrizione (prima di essere in coppia).
addColumn('players', 'loginToken', 'TEXT');
addColumn('players', 'accessCode', 'TEXT');
addColumn('push_subs', 'playerId', 'INTEGER REFERENCES players(id) ON DELETE CASCADE');
// Messaggi vocali: file nella cartella dati, qui solo i riferimenti.
addColumn('messages', 'audioFile', 'TEXT');
addColumn('messages', 'audioMime', 'TEXT');
addColumn('messages', 'audioMs', 'INTEGER');
// Piazzamento sul campo degli Altari: coordinate dal telefono di chi piazza e foto.
addColumn('points', 'lat', 'REAL');
addColumn('points', 'lng', 'REAL');
addColumn('points', 'accuracy', 'REAL');
addColumn('points', 'photoFile', 'TEXT');
addColumn('points', 'placedAt', 'INTEGER');
addColumn('points', 'placedBy', 'TEXT');
addColumn('points', 'placeSource', 'TEXT');

// Doni QR: piazzati dagli Eletti, compaiono in mappa, li prende la prima coppia che li scansiona.
db.exec(`
CREATE TABLE IF NOT EXISTS gifts (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  typeId TEXT, name TEXT NOT NULL, icon TEXT, color TEXT, description TEXT, label TEXT NOT NULL,
  qrToken TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
  revealMode TEXT NOT NULL DEFAULT 'manual', revealAtMin REAL,
  lat REAL, lng REAL, accuracy REAL, photoFile TEXT, placedAt INTEGER, placedBy TEXT, placeSource TEXT,
  revealedAt INTEGER, claimedByTeamId INTEGER REFERENCES teams(id) ON DELETE SET NULL, claimedAt INTEGER, usedAt INTEGER,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_gifts_game ON gifts(gameId);
`);
// Scadenza dei doni: minuti di gioco dopo la comparsa (pause escluse).
addColumn('gifts', 'expiresAfterMin', 'REAL');
addColumn('gifts', 'revealElapsedMs', 'INTEGER');
addColumn('gifts', 'expiredAt', 'INTEGER');

// Alleanze e scontri. I Sigilli ricevuti finiscono nel taccuino con la loro origine (vinto / alleato / annotato).
addColumn('team_code_notes', 'source', 'TEXT');
// Validità della scansione di un Altare (minuti; 0 = senza limite).
addColumn('games', 'altarScanMin', 'INTEGER NOT NULL DEFAULT 15');

// Squadre degli Eletti e loro incarichi (Altari e Doni da piazzare, incarichi liberi).
db.exec(`
CREATE TABLE IF NOT EXISTS elect_squads (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#d1ad62', createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS squad_tasks (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  squadId INTEGER NOT NULL REFERENCES elect_squads(id) ON DELETE CASCADE,
  text TEXT NOT NULL, createdAt INTEGER NOT NULL, doneAt INTEGER, doneBy TEXT
);
`);
addColumn('players', 'squadId', 'INTEGER REFERENCES elect_squads(id) ON DELETE SET NULL');
addColumn('points', 'squadId', 'INTEGER REFERENCES elect_squads(id) ON DELETE SET NULL');
addColumn('gifts', 'squadId', 'INTEGER REFERENCES elect_squads(id) ON DELETE SET NULL');

// Ultima posizione GPS di ogni telefono (coppie a partita iniziata, Eletti dalla preparazione).
db.exec(`
CREATE TABLE IF NOT EXISTS positions (
  deviceId TEXT PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  teamId INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE, playerId INTEGER,
  lat REAL NOT NULL, lng REAL NOT NULL, acc REAL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_positions_game ON positions(gameId, at);
`);
db.exec(`
CREATE TABLE IF NOT EXISTS alliances (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE, createdAt INTEGER NOT NULL, endedAt INTEGER
);
CREATE TABLE IF NOT EXISTS alliance_members (
  allianceId INTEGER NOT NULL REFERENCES alliances(id) ON DELETE CASCADE,
  teamId INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE, joinedAt INTEGER NOT NULL, leftAt INTEGER
);
CREATE TABLE IF NOT EXISTS alliance_requests (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  fromTeamId INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE, toTeamId INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  status TEXT NOT NULL, createdAt INTEGER NOT NULL, respondedAt INTEGER
);
CREATE TABLE IF NOT EXISTS engagements (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  reporterTeamId INTEGER NOT NULL, opponentTeamId INTEGER NOT NULL, result TEXT NOT NULL, status TEXT NOT NULL,
  winners TEXT NOT NULL, losers TEXT NOT NULL, createdAt INTEGER NOT NULL, resolvedAt INTEGER, resolvedBy TEXT
);
CREATE TABLE IF NOT EXISTS team_timers (
  id INTEGER PRIMARY KEY, teamId INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  timerId TEXT NOT NULL, startedAt INTEGER NOT NULL, reason TEXT
);
CREATE INDEX IF NOT EXISTS ix_am_team ON alliance_members(teamId, leftAt);
CREATE INDEX IF NOT EXISTS ix_eng_game ON engagements(gameId, id);
`);
addColumn('teams', 'kind', "TEXT NOT NULL DEFAULT 'couple'");

// Avvisi della regia (con notifica push sul telefono).
db.exec(`
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT, target TEXT NOT NULL DEFAULT 'all',
  teamId INTEGER REFERENCES teams(id) ON DELETE CASCADE, author TEXT, createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notices_game ON notices(gameId, id);
`);

const stmtCache = new Map();
function prep(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}
const clean = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
const plain = (r) => (r ? { ...r } : r);

const q = {
  get: (sql, ...p) => plain(prep(sql).get(...clean(p))),
  all: (sql, ...p) => prep(sql).all(...clean(p)).map(plain),
  run: (sql, ...p) => prep(sql).run(...clean(p)),
};

let depth = 0;
function tx(fn) {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}

function getSetting(key) {
  const r = q.get('SELECT value FROM settings WHERE key = ?', key);
  return r ? r.value : null;
}
function setSetting(key, value) {
  q.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

module.exports = { db, q, tx, getSetting, setSetting, DATA_DIR };
