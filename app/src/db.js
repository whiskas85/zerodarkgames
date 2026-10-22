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
// Anti «furbetto del QR»: la lettura di un Altare piazzato vale solo entro questi metri (0 = nessun controllo).
addColumn('games', 'altarRadiusM', 'INTEGER NOT NULL DEFAULT 0');
// Interruttore del controllo (si spegne al volo in Regia se in gioco crea problemi); il raggio resta impostato.
if (!db.prepare('PRAGMA table_info(games)').all().some((c) => c.name === 'altarCheckOn')) {
  addColumn('games', 'altarCheckOn', 'INTEGER NOT NULL DEFAULT 0');
  db.exec('UPDATE games SET altarCheckOn = 1 WHERE altarRadiusM > 0');
}
// Letture degli Altari rifiutate (fuori raggio o senza GPS): la regia le vede con la posizione della coppia.
db.exec(`CREATE TABLE IF NOT EXISTS altar_rejections (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  teamId INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE, pointId INTEGER NOT NULL REFERENCES points(id) ON DELETE CASCADE,
  at INTEGER NOT NULL, lat REAL, lng REAL, acc REAL, distM REAL, radiusM INTEGER, reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_altar_rejections ON altar_rejections(gameId, at);`);

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
// Incarichi di piazzamento: punto indicato dalla regia (facoltativo), nota, richiesta di spostamento,
// squadra che ha piazzato davvero (proposta di default quando si chiede di spostare).
for (const t of ['points', 'gifts']) {
  addColumn(t, 'targetLat', 'REAL');
  addColumn(t, 'targetLng', 'REAL');
  addColumn(t, 'taskNote', 'TEXT');
  addColumn(t, 'moveRequestedAt', 'INTEGER');
  addColumn(t, 'placedSquadId', 'INTEGER');
}
// Annuncio del dono programmato a un orario preciso (ms).
addColumn('gifts', 'revealAt', 'INTEGER');
// Armamenti: finestra con inizio (minuto dal via o orario) e durata.
addColumn('supply_drops', 'scheduledAt', 'INTEGER');
addColumn('supply_drops', 'durationMin', 'REAL');
addColumn('supply_drops', 'closesAt', 'INTEGER');
addColumn('supply_drops', 'closedAt', 'INTEGER');
// Team di softair di appartenenza (chiesto all'iscrizione).
addColumn('players', 'softairTeam', 'TEXT');
// Luoghi del gioco da piazzare sul campo come gli Altari (foto facoltativa): la Soglia e il Cerchio di inizio.
db.exec(`
CREATE TABLE IF NOT EXISTS landmarks (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, label TEXT NOT NULL,
  lat REAL, lng REAL, accuracy REAL, photoFile TEXT, placedAt INTEGER, placedBy TEXT, placeSource TEXT, placedSquadId INTEGER,
  squadId INTEGER REFERENCES elect_squads(id) ON DELETE SET NULL, targetLat REAL, targetLng REAL, taskNote TEXT, moveRequestedAt INTEGER,
  UNIQUE (gameId, kind)
);
`);
// Colore di ogni Settore (pallini della coppia e bordo dell'Altare in mappa).
addColumn('sectors', 'color', 'TEXT');
{
  const palette = ['#e5484d', '#22c3e6', '#a0703c', '#e8e8e8', '#46c46a', '#9b6cf0', '#f97316', '#ff4fa3', '#14b8a6', '#a3e635', '#facc15', '#6366f1'];
  for (const s of db.prepare('SELECT id, ord FROM sectors WHERE color IS NULL').all()) {
    db.prepare('UPDATE sectors SET color = ? WHERE id = ?').run(palette[(Math.max(1, s.ord) - 1) % palette.length], s.id);
  }
}
// Account dei giocatori (username e password); per ogni partita l'iscrizione è una riga di players.
db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, passHash TEXT NOT NULL,
  name TEXT NOT NULL, nickname TEXT, softairTeam TEXT, phone TEXT, createdAt INTEGER NOT NULL
);
`);
addColumn('players', 'accountId', 'INTEGER REFERENCES accounts(id) ON DELETE SET NULL');
// Gestionali (Zero Dark Ops) collegati a un account: l'identità è la coppia (iss, sub), il sub vale solo nel suo gestionale.
db.exec(`
CREATE TABLE IF NOT EXISTS account_identities (
  id INTEGER PRIMARY KEY, accountId INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  iss TEXT NOT NULL, sub TEXT NOT NULL, providerName TEXT, opsName TEXT, squadra TEXT,
  createdAt INTEGER NOT NULL, lastLoginAt INTEGER, UNIQUE (iss, sub)
);
CREATE INDEX IF NOT EXISTS ix_identities_account ON account_identities(accountId);
`);
// Regia e Soglia da un account dei giocatori (entrato anche con Zero Dark Ops): ci si arriva solo con un
// link d'invito generato da un master, monouso e a scadenza.
// Piazzamento provvisorio (senza cartello né foto): da confermare con il piazzamento normale.
for (const t of ['points', 'gifts', 'landmarks']) addColumn(t, 'provisional', 'INTEGER NOT NULL DEFAULT 0');
// Altare aggiunto dalla regia (anche senza coppia): resta anche se nessuna coppia ha quel Settore.
addColumn('points', 'manual', 'INTEGER NOT NULL DEFAULT 0');
// Codice di uscita della Soglia: il QR che le coppie inquadrano per esfiltrare con la Parola intera.
addColumn('landmarks', 'exitToken', 'TEXT');
// Testo per le coppie prima della gara (markdown): test armi, partenza, cose da fare.
addColumn('games', 'prepInfo', 'TEXT');
// Accettazione a inizio evento (presenza di iscritti e coppie) e test armi (sotto 1 joule) sul singolo.
addColumn('players', 'checkinAt', 'INTEGER');
addColumn('players', 'checkinBy', 'TEXT');
addColumn('teams', 'checkinAt', 'INTEGER');
addColumn('teams', 'checkinBy', 'TEXT');
addColumn('players', 'chronoMain', 'INTEGER');
addColumn('players', 'chronoBackup', 'INTEGER');
addColumn('players', 'chronoSecondary', 'INTEGER');
addColumn('players', 'chronoBy', 'TEXT');
// Misure del cronografo per arma: { main: { j, v, g, at, by }, … } (assenti se la spunta è manuale).
addColumn('players', 'chronoShots', 'TEXT');
// Persona «chiusa» al test armi (finito con tutte le sue repliche): sparisce dalla lista.
addColumn('players', 'chronoDoneAt', 'INTEGER');
// Skill delle coppie (scelte prima del via o vinte con i Doni) ed effetti in corso di Skill e Doni.
db.exec(`
CREATE TABLE IF NOT EXISTS team_skills (
  id INTEGER PRIMARY KEY, teamId INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  skillId TEXT NOT NULL, source TEXT NOT NULL, addedAt INTEGER NOT NULL, readyAt INTEGER, UNIQUE (teamId, skillId)
);
CREATE TABLE IF NOT EXISTS skill_effects (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  teamId INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE, kind TEXT NOT NULL, code TEXT NOT NULL,
  targetTeamId INTEGER, targetSectorId INTEGER, targetPointId INTEGER,
  startedAt INTEGER NOT NULL, endsAt INTEGER, endedAt INTEGER, notifyAt INTEGER, notifiedAt INTEGER, data TEXT
);
CREATE INDEX IF NOT EXISTS ix_effects_game ON skill_effects(gameId, endedAt);
`);
addColumn('games', 'maxActiveSkills', 'INTEGER NOT NULL DEFAULT 1');
addColumn('games', 'maxPassiveSkills', 'INTEGER NOT NULL DEFAULT 1');
// Presagio del Dono: chi ha la passiva vede subito un cerchio attorno al dono, gli altri lo vedono 5 minuti dopo.
addColumn('gifts', 'publicAt', 'INTEGER');
addColumn('gifts', 'hintLat', 'REAL');
addColumn('gifts', 'hintLng', 'REAL');
// Posti per l'iscrizione: coppie (vuoto = una per Settore) e temerari solitari (vuoto = senza limite a parte).
addColumn('games', 'maxCouples', 'INTEGER');
addColumn('games', 'maxSingles', 'INTEGER');
// Punti di interesse segnati sul campo (regia ed Eletti): coordinata, titolo e descrizione.
// Servono da promemoria e come posizione già pronta per piazzare Altari, Doni e luoghi.
db.exec(`CREATE TABLE IF NOT EXISTS pois (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  label TEXT NOT NULL, description TEXT, lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL,
  createdAt INTEGER NOT NULL, createdBy TEXT, updatedAt INTEGER
);
CREATE INDEX IF NOT EXISTS ix_pois_game ON pois(gameId);`);
// Indicazioni campo (parcheggio, accettazione…): punti con icona MDI che coppie e iscritti vedono prima del Cerchio.
db.exec(`CREATE TABLE IF NOT EXISTS guide_points (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  label TEXT NOT NULL, description TEXT, icon TEXT, lat REAL NOT NULL, lng REAL NOT NULL,
  createdAt INTEGER NOT NULL, createdBy TEXT, updatedAt INTEGER
);
CREATE INDEX IF NOT EXISTS ix_guide_game ON guide_points(gameId);`);
// Identificativo personale per l'app di tracciamento (Traccar Client): posizione anche a schermo spento.
addColumn('players', 'trackToken', 'TEXT');
addColumn('players', 'trackSeenAt', 'INTEGER');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_players_track ON players(trackToken)');
// Verifica di Traccar Client: la prova a schermo spento è riuscita (segnali arrivati con il telefono in tasca).
addColumn('players', 'trackVerifiedAt', 'INTEGER');
// Segnali di Traccar Client (solo ora e precisione, non la posizione): servono a verificare che funzioni anche prima del via.
db.exec(`CREATE TABLE IF NOT EXISTS track_pings (
  id INTEGER PRIMARY KEY, playerId INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE, at INTEGER NOT NULL, acc REAL
);
CREATE INDEX IF NOT EXISTS ix_track_pings ON track_pings(playerId, at);`);
addColumn('users', 'perms', 'TEXT');
// Ultima partita aperta in regia: Campo (sul telefono) la segue, così i piazzamenti finiscono nella partita giusta.
addColumn('users', 'lastGameId', 'INTEGER');
// Scansione dell'Altare fatta con il controllo di posizione superato (1); quelle senza controllo non valgono quando lo si accende.
addColumn('team_visits', 'geoOk', 'INTEGER NOT NULL DEFAULT 0');
// Checklist dell'accettazione spuntata dal Consiglio (le voci non cambiate seguono lo stato rilevato dall'app).
addColumn('players', 'checkinChecks', 'TEXT');
// Armi della persona per il test (null = le tre di base) e spunte delle armi aggiunte (le tre di base hanno le loro colonne).
addColumn('players', 'weapons', 'TEXT');
addColumn('players', 'chronoPass', 'TEXT');
addColumn('account_identities', 'picture', 'TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS council_requests (
  accountId INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, createdAt INTEGER NOT NULL
)`);
addColumn('users', 'accountId', 'INTEGER REFERENCES accounts(id) ON DELETE CASCADE');
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_account ON users(accountId);
CREATE TABLE IF NOT EXISTS staff_invites (
  token TEXT PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('master','validator')), createdBy TEXT,
  createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, usedAt INTEGER, usedBy INTEGER
);
`);
// Messaggi con una singola squadra di Eletti (null = tutti gli Eletti).
addColumn('messages', 'squadId', 'INTEGER');

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
CREATE TABLE IF NOT EXISTS engagement_steals (
  id INTEGER PRIMARY KEY, engagementId INTEGER NOT NULL, teamId INTEGER NOT NULL, sectorId INTEGER,
  createdAt INTEGER NOT NULL, chosenAt INTEGER, UNIQUE (engagementId, teamId)
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

// Fase 2 delle Skill (scontri e alleanze): durata propria di un timer (Veglia Forzata, Ritirata del Diplomatico),
// Sigillo nascosto agli alleati (Diplomatico), Skill usate in uno scontro (Maestria, Immunità, Velenoso).
addColumn('team_timers', 'minutes', 'REAL');
addColumn('alliance_members', 'hideCode', 'INTEGER NOT NULL DEFAULT 0');
addColumn('alliance_requests', 'diplomat', 'INTEGER NOT NULL DEFAULT 0');
addColumn('engagements', 'skill', 'TEXT');
addColumn('engagements', 'skillTeamId', 'INTEGER');
addColumn('engagements', 'hidden', 'TEXT');
addColumn('engagements', 'poisonBy', 'INTEGER');

// Fase 3 delle Skill: incarichi degli Eletti con un tipo (testo, raggiungi, caccia, incontro) e un bersaglio,
// anche ancora senza squadra (generati da una Skill o da un Dono: la regia li assegna).
{
  const col = db.prepare('PRAGMA table_info(squad_tasks)').all().find((c) => c.name === 'squadId');
  if (col?.notnull) {
    db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE squad_tasks_new (
      id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      squadId INTEGER REFERENCES elect_squads(id) ON DELETE SET NULL,
      text TEXT NOT NULL, createdAt INTEGER NOT NULL, doneAt INTEGER, doneBy TEXT
    );
    INSERT INTO squad_tasks_new (id, gameId, squadId, text, createdAt, doneAt, doneBy) SELECT id, gameId, squadId, text, createdAt, doneAt, doneBy FROM squad_tasks;
    DROP TABLE squad_tasks;
    ALTER TABLE squad_tasks_new RENAME TO squad_tasks;
    COMMIT;
    PRAGMA foreign_keys = ON;
    `);
  }
}
addColumn('squad_tasks', 'kind', "TEXT NOT NULL DEFAULT 'text'");
addColumn('squad_tasks', 'targetTeamId', 'INTEGER');
addColumn('squad_tasks', 'targetLat', 'REAL');
addColumn('squad_tasks', 'targetLng', 'REAL');
addColumn('squad_tasks', 'targetLabel', 'TEXT');
addColumn('squad_tasks', 'source', "TEXT NOT NULL DEFAULT 'regia'");
addColumn('squad_tasks', 'sourceTeamId', 'INTEGER');
addColumn('squad_tasks', 'assignedAt', 'INTEGER');
addColumn('squad_tasks', 'cancelledAt', 'INTEGER');
addColumn('squad_tasks', 'startedAt', 'INTEGER');
addColumn('squad_tasks', 'endsAt', 'INTEGER');
// Avviso alla coppia bersaglio (1 minuto dopo che la squadra la vede).
addColumn('squad_tasks', 'notifiedAt', 'INTEGER');

// Emergenze reali (OFF GAME): dal pulsante dell'app o dall'SOS di Traccar, con la posizione di chi chiama.
db.exec(`
CREATE TABLE IF NOT EXISTS emergencies (
  id INTEGER PRIMARY KEY, gameId INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  teamId INTEGER, playerId INTEGER, who TEXT NOT NULL, phone TEXT, source TEXT NOT NULL,
  lat REAL, lng REAL, acc REAL, createdAt INTEGER NOT NULL, ackAt INTEGER, ackBy TEXT, closedAt INTEGER, closedBy TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS ix_emergencies_game ON emergencies(gameId, closedAt);
`);

// Memoria del Nodo: validità della scansione di un Altare per chi ha la Skill (minuti, configurabile per partita).
addColumn('games', 'nodeScanMin', 'INTEGER NOT NULL DEFAULT 30');

// Occhio del Consiglio: durata (minuti) e raggio (metri) configurabili per partita.
addColumn('games', 'eyeMin', 'INTEGER NOT NULL DEFAULT 10');
addColumn('games', 'eyeRadiusM', 'INTEGER NOT NULL DEFAULT 500');

// Privilegio del Cuore: avvisi già mandati (apertura anticipata, chiusura posticipata), una volta per finestra.
db.exec(`
CREATE TABLE IF NOT EXISTS privilege_notices (
  teamId INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE, dropId INTEGER NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (teamId, dropId, kind)
);
`);

// Doni: ritardo (minuti) tra l'annuncio della regia e la comparsa; cartello da rimuovere dopo la presa o da lasciare.
addColumn('gifts', 'revealDelayMin', 'REAL');
addColumn('gifts', 'removeSign', 'INTEGER NOT NULL DEFAULT 1');

// Doni che restano attivi dopo la lettura: ogni coppia ne prende una copia (una volta sola); la copia ricorda l'originale.
addColumn('gifts', 'multi', 'INTEGER NOT NULL DEFAULT 0');
addColumn('gifts', 'parentGiftId', 'INTEGER');

// Testi e tempi di Skill e Doni modificati dalla regia per questa partita (JSON: { skills: {id: {...}}, gifts: {id: {...}} }).
addColumn('games', 'catalogEdits', 'TEXT');

// ICE (In Case of Emergency), facoltativo e OFF GAME: dati sanitari e contatto, letti solo quando la persona chiama un'emergenza.
addColumn('accounts', 'iceBlood', 'TEXT');
addColumn('accounts', 'iceConditions', 'TEXT');
addColumn('accounts', 'iceContactName', 'TEXT');
addColumn('accounts', 'iceContactPhone', 'TEXT');
// L'emergenza porta con sé i dati ICE di chi l'ha chiamata (copiati al momento della chiamata).
addColumn('emergencies', 'ice', 'TEXT');

// Mini sondaggi negli avvisi: Sì / No / Forse, una risposta per persona (o per accesso di coppia), modificabile.
addColumn('notices', 'poll', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`
CREATE TABLE IF NOT EXISTS notice_votes (
  noticeId INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE, voterKey TEXT NOT NULL,
  playerId INTEGER, teamId INTEGER, name TEXT, choice TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (noticeId, voterKey)
);
`);

// Avviso di sicurezza pre-gara (EMERGENZA e ICE): quando la persona ha confermato «Ho letto e ho compreso».
addColumn('players', 'safetyAckAt', 'INTEGER');

// App del giocatore: installata (schermata Home) e versione, comunicate quando apre l'app.
addColumn('players', 'appInstalled', 'INTEGER');
addColumn('players', 'appVersion', 'TEXT');
addColumn('players', 'appSeenAt', 'INTEGER');
// Sistema del telefono (ios, android, desktop) letto dal browser all'apertura dell'app.
addColumn('players', 'appOs', 'TEXT');

module.exports = { db, q, tx, getSetting, setSetting, DATA_DIR };
