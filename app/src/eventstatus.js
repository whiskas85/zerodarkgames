'use strict';
// Stato della persona all'evento, per il suo profilo: iscrizione, accettazione all'arrivo, test armi
// (per ogni arma: passata, joule, velocità e peso del pallino usato). Solo lettura, nessuna dipendenza.
// Armi della persona: di base principale, principale di riserva e secondaria; se ne possono togliere o aggiungere.
const LEGACY = { main: 'chronoMain', backup: 'chronoBackup', secondary: 'chronoSecondary' };
const DEFAULT_WEAPONS = [{ key: 'main', label: 'Arma principale' }, { key: 'backup', label: 'Principale di riserva' }, { key: 'secondary', label: 'Arma secondaria' }];
const parseJson = (v, d) => { try { return JSON.parse(v || '') ?? d; } catch { return d; } };
function weaponsOf(p) {
  const list = parseJson(p.weapons, null);
  return Array.isArray(list) ? list.filter((w) => w && w.key && w.label) : DEFAULT_WEAPONS.slice();
}
// Quando l'arma è passata (spunta): le tre di base nelle loro colonne, le altre in chronoPass.
const passOf = (p, key) => (LEGACY[key] ? p[LEGACY[key]] : parseJson(p.chronoPass, {})[key]) || null;
// Elenco per l'Accettazione/Test armi: chiave, nome e spunta.
const weaponList = (p) => weaponsOf(p).map((w) => ({ key: w.key, label: w.label, custom: !LEGACY[w.key], ok: passOf(p, w.key) }));

// Letture del cronografo in corso, persona per persona (solo in memoria): la persona le vede in tempo reale nell'app.
const LIVE_TTL = 10 * 60000;
const live = new Map();
// data null = prova chiusa; con open la prova è aperta anche prima del primo tiro (l'arbitro ha scelto l'arma).
function setLive(playerId, data) {
  if (!data || (!data.open && !data.readings?.length)) live.delete(Number(playerId));
  else live.set(Number(playerId), { ...data, at: Date.now() });
}
function liveOf(playerId) {
  const x = live.get(Number(playerId));
  if (x && Date.now() - x.at > LIVE_TTL) { live.delete(Number(playerId)); return null; }
  return x || null;
}

// Cosa si controlla all'accettazione: lo stato rilevato dall'app (notifiche, Traccar provato, avviso ICE letto,
// ICE compilato, app installata) e la spunta del Consiglio, se l'ha cambiata a mano.
const CHECKS = [['notifiche', 'Notifiche attive'], ['traccar', 'Traccar provato'], ['iceLetto', 'Avviso di sicurezza (ICE) letto'], ['iceCompilato', 'ICE compilato (facoltativo)'], ['app', 'App installata']];
function autoChecks(p) {
  const { q } = require('./db');
  const own = q.get('SELECT COUNT(*) AS n FROM push_subs WHERE playerId = ?', p.id).n;
  const shared = p.teamId ? q.get('SELECT COUNT(*) AS n FROM push_subs WHERE teamId = ? AND playerId IS NULL', p.teamId).n : 0;
  const a = p.accountId ? q.get('SELECT iceBlood, iceConditions, iceContactName, iceContactPhone FROM accounts WHERE id = ?', p.accountId) : null;
  return {
    notifiche: own + shared > 0, traccar: !!p.trackVerifiedAt, iceLetto: !!p.safetyAckAt,
    iceCompilato: !!(a && (a.iceBlood || a.iceConditions || a.iceContactName || a.iceContactPhone)), app: !!p.appInstalled,
  };
}
function checksOf(p) {
  let saved = {};
  try { saved = JSON.parse(p.checkinChecks || '{}') || {}; } catch { saved = {}; }
  const auto = autoChecks(p);
  return CHECKS.map(([key, label]) => ({ key, label, auto: auto[key], on: saved[key] ?? auto[key], manual: saved[key] != null, optional: key === 'iceCompilato' }));
}

function eventStatus(p) {
  if (!p) return null;
  let shots = {};
  try { shots = JSON.parse(p.chronoShots || '{}') || {}; } catch { shots = {}; }
  const list = weaponsOf(p).map((wp) => {
    const w = wp.key;
    const pass = passOf(p, w);
    const s = shots[w];
    return { key: w, label: wp.label, custom: !LEGACY[w], ok: !!pass, at: pass || null, manual: (!!pass && !s) || !!s?.manual, j: s?.j ?? null, v: s?.v ?? null, g: s?.g ?? null, n: s?.n ?? null, max: s?.max ?? null, failed: !!s && s.ok === false && !pass,
      readings: s?.readings || null, testedAt: s?.at || null, by: s?.by || null };
  });
  const weapons = Object.fromEntries(list.map((w) => [w.key, w]));
  return {
    enrolled: p.status,
    checkinAt: p.checkinAt || null,
    chronoDoneAt: p.chronoDoneAt || null,
    chronoStarted: list.some((w) => w.ok || shots[w.key]),
    weapons,
    weaponList: list,
    checks: checksOf(p),
    live: liveOf(p.id),
  };
}

module.exports = { weaponsOf, passOf, weaponList, LEGACY, DEFAULT_WEAPONS, eventStatus, checksOf, setLive, liveOf, CHECKS };
