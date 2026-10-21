'use strict';
// Stato della persona all'evento, per il suo profilo: iscrizione, accettazione all'arrivo, test armi
// (per ogni arma: passata, joule, velocità e peso del pallino usato). Solo lettura, nessuna dipendenza.
const WEAPONS = [['main', 'chronoMain'], ['backup', 'chronoBackup'], ['secondary', 'chronoSecondary']];

function eventStatus(p) {
  if (!p) return null;
  let shots = {};
  try { shots = JSON.parse(p.chronoShots || '{}') || {}; } catch { shots = {}; }
  const weapons = Object.fromEntries(WEAPONS.map(([w, col]) => {
    const s = shots[w];
    return [w, { ok: !!p[col], at: p[col] || null, manual: (!!p[col] && !s) || !!s?.manual, j: s?.j ?? null, v: s?.v ?? null, g: s?.g ?? null, n: s?.n ?? null, max: s?.max ?? null, failed: !!s && s.ok === false && !p[col] }];
  }));
  return {
    enrolled: p.status,
    checkinAt: p.checkinAt || null,
    chronoDoneAt: p.chronoDoneAt || null,
    chronoStarted: WEAPONS.some(([w, col]) => p[col] || shots[w]),
    weapons,
  };
}

module.exports = { eventStatus };
