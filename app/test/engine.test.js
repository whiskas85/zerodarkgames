'use strict';
// Criteri di accettazione (sezione 13 della specifica). Usa un database temporaneo.
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zdg-test-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const { q } = require('../src/db');
const C = require('../src/constants');
const G = require('../src/game');

for (const s of C.SECTORS) q.run('INSERT INTO sectors (ord, roman, name, article, element, motto) VALUES (?, ?, ?, ?, ?, ?)', s.ord, s.roman, s.name, s.article, s.element, s.motto);
q.run("INSERT INTO users (username, passHash, role, createdAt) VALUES ('val', 'x', 'validator', 0)");
const validator = { id: 1, username: 'val' };

// Sposta indietro l'inizio della partita per simulare il tempo trascorso.
function advanceTo(gameId, minutes) {
  const g = G.getGame(gameId);
  const shift = minutes * 60000 - G.clockOf(g).elapsedMs;
  q.run('UPDATE games SET startedAt = startedAt - ? WHERE id = ?', shift, gameId);
  G.tickAll();
}

function setupGame(teamsCount = 8) {
  const g = G.createGame({ name: 'Test' }, 'test');
  for (let i = 0; i < teamsCount * 2; i++) G.addPlayer(g.id, { name: `Giocatore ${i + 1}` });
  const r = G.autoPair(g.id, 'test');
  assert.equal(r.created, teamsCount);
  G.generateCodes(g.id, 'test');
  const words = Array.from({ length: teamsCount }, (_, i) => `parola${i + 1}`).join(' ');
  G.setPhrase(g.id, words, 'test');
  return G.getGame(g.id);
}

const teamsOf = (gameId) => q.all('SELECT * FROM teams WHERE gameId = ?', gameId);
const codeOf = (gameId, sectorId) => q.get('SELECT code FROM sector_codes WHERE gameId = ? AND sectorId = ?', gameId, sectorId).code;
// Sblocco come nell'app: prima si inquadra il QR dell'Altare, poi si pronuncia il Sigillo.
const scanUnlock = (t, token, code) => { G.visitPoint(t, token); return G.unlock(t, token, code); };
const pointOf = (gameId, sectorId) => q.get('SELECT * FROM points WHERE gameId = ? AND sectorId = ?', gameId, sectorId);
// «Perso» va confermato da chi ha vinto: lo dichiara lo sconfitto, il vincitore conferma.
const lose = (K, loser, winner, opts) => { const r = K.reportEngagement(loser, winner.id, 'lost', opts); if (r.status === 'pending') K.respondEngagement(winner, r.id, true); return r; };

test('1. calendario con 8 coppie: 6 rivelazioni a 35..210, 2 mai rivelati', () => {
  const g = setupGame(8);
  const revs = q.all('SELECT * FROM revelations WHERE gameId = ? ORDER BY scheduledMin', g.id);
  assert.deepEqual(revs.map((r) => r.scheduledMin), [35, 70, 105, 140, 175, 210]);
  const never = q.all('SELECT * FROM sector_codes WHERE gameId = ? AND neverRevealed = 1', g.id);
  assert.equal(never.length, 2);
  const inCal = new Set(revs.map((r) => r.sectorId));
  for (const n of never) assert.ok(!inCal.has(n.sectorId));
  // Formato dei Sigilli: 6 caratteri, niente caratteri ambigui.
  for (const c of q.all('SELECT code FROM sector_codes WHERE gameId = ?', g.id)) assert.match(c.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/);
  assert.ok(G.readiness(g).ok, JSON.stringify(G.readiness(g).issues));
});

test('2. il Sigillo non è visibile prima del cerchio', () => {
  const g = setupGame(4);
  const t = teamsOf(g.id)[0];
  assert.equal(G.teamState(t).seal, null);
  G.control(g.id, 'ready', 'test');
  assert.equal(G.teamState(t).seal, null);
  G.control(g.id, 'circle', 'test');
  assert.equal(G.teamState(t).seal, codeOf(g.id, t.sectorId));
  // Il taccuino non contiene codici altrui.
  const nb = G.teamState(t).notebook.filter((n) => n.sectorId !== t.sectorId);
  assert.ok(nb.every((n) => n.code === null));
});

test('3-12. partita completa', () => {
  const g = setupGame(8);
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  const teams = teamsOf(g.id);
  const [A, B] = teams;

  // 3. annuncio di inizio al via, apertura caccia dopo 5 minuti senza azioni manuali
  G.control(g.id, 'start', 'test');
  let anns = q.all('SELECT type FROM announcements WHERE gameId = ? ORDER BY id', g.id).map((a) => a.type);
  assert.deepEqual(anns, ['start']);
  advanceTo(g.id, 5.01);
  assert.equal(G.getGame(g.id).status, 'hunt');
  anns = q.all('SELECT type FROM announcements WHERE gameId = ? ORDER BY id', g.id).map((a) => a.type);
  assert.deepEqual(anns, ['start', 'hunt_open']);

  // 4. Altare di B: Sigillo giusto → frammento, Sigillo sbagliato → errore
  const pB = pointOf(g.id, B.sectorId);
  const bad = scanUnlock(A, pB.qrToken, codeOf(g.id, A.sectorId));
  assert.equal(bad.ok, false);
  assert.match(bad.message, /Sigillo non valido/);
  const good = scanUnlock(A, pB.qrToken, codeOf(g.id, B.sectorId).toLowerCase());
  assert.equal(good.ok, true);
  assert.ok(good.fragment.text.startsWith('parola'));

  // 5. visita registrata anche se il Sigillo arriva dopo
  const pC = pointOf(g.id, teams[2].sectorId);
  G.visitPoint(A, pC.qrToken);
  assert.ok(G.teamState(A).visited.some((v) => v.qrToken === pC.qrToken && !v.unlocked));

  // 6. frammento a mano accettato solo se reale
  assert.equal(G.addManualFragment(A, 'inventato').ok, false);
  const fragC = q.get('SELECT text FROM fragments WHERE pointId = ?', pC.id).text;
  const man = G.addManualFragment(A, `  ${fragC.toUpperCase()} `);
  assert.equal(man.ok, true);
  assert.equal(man.fragment.source, 'manual');

  // 7. taccuino: corretto / sbagliato
  assert.equal(G.addCodeNote(A, teams[3].sectorId, 'ZZZZZZ').correct, false);
  assert.equal(G.addCodeNote(A, teams[3].sectorId, codeOf(g.id, teams[3].sectorId)).correct, true);
  assert.equal(G.teamState(A).notebook.find((n) => n.sectorId === teams[3].sectorId).code, codeOf(g.id, teams[3].sectorId));

  // 8. rivelazione a 35′: codice nel taccuino di tutti + annuncio
  advanceTo(g.id, 35.01);
  const rev = q.get("SELECT * FROM revelations WHERE gameId = ? AND status = 'fired'", g.id);
  assert.ok(rev);
  for (const t of teams) assert.equal(G.teamState(t).notebook.find((n) => n.sectorId === rev.sectorId).code, codeOf(g.id, rev.sectorId));
  assert.ok(q.get("SELECT 1 FROM announcements WHERE gameId = ? AND type = 'revelation'", g.id));

  // 9. pausa: orologio e calendario fermi, alla ripresa nessun evento saltato
  G.control(g.id, 'pause', 'test');
  const elapsedAtPause = G.clockOf(G.getGame(g.id)).elapsedMs;
  // Un'ora di pausa: tutto è successo un'ora prima.
  q.run('UPDATE games SET pausedAt = pausedAt - ?, startedAt = startedAt - ? WHERE id = ?', 60 * 60000, 60 * 60000, g.id);
  G.tickAll();
  assert.equal(G.getGame(g.id).status, 'paused');
  assert.ok(Math.abs(G.clockOf(G.getGame(g.id)).elapsedMs - elapsedAtPause) < 1000);
  assert.equal(q.get("SELECT COUNT(*) AS n FROM revelations WHERE gameId = ? AND status = 'fired'", g.id).n, 1);
  G.control(g.id, 'resume', 'test');
  assert.equal(G.getGame(g.id).status, 'hunt');
  assert.ok(Math.abs(G.clockOf(G.getGame(g.id)).elapsedMs - elapsedAtPause) < 1000);
  advanceTo(g.id, 70.01);
  assert.equal(q.get("SELECT COUNT(*) AS n FROM revelations WHERE gameId = ? AND status = 'fired'", g.id).n, 2);

  // 10. validatore: incompleta mostra i mancanti; completa → won con posizione e annuncio
  const inc = G.validate(A.id, { mode: 'app' }, validator);
  assert.equal(inc.result, 'incomplete');
  assert.equal(inc.missing.length, 8 - 2);
  assert.equal(G.validatorView(A.id).team.status, 'active');
  for (const t of teams) scanUnlock(A, pointOf(g.id, t.sectorId).qrToken, codeOf(g.id, t.sectorId));
  const ok = G.validate(A.id, { mode: 'app' }, validator);
  assert.equal(ok.result, 'valid');
  assert.equal(ok.position, 1);
  assert.equal(q.get('SELECT status FROM teams WHERE id = ?', A.id).status, 'won');
  assert.ok(q.get("SELECT 1 FROM announcements WHERE gameId = ? AND type = 'victory'", g.id));
  // Dettati: uno sbagliato → errata
  const typed = q.all('SELECT position, text FROM fragments WHERE gameId = ?', g.id);
  typed[0].text = 'sbagliato';
  assert.equal(G.validate(B.id, { mode: 'typed', typed }, validator).result, 'wrong');

  // 11. dopo la prima vittoria le rivelazioni continuano e gli sblocchi funzionano
  advanceTo(g.id, 105.01);
  assert.equal(q.get("SELECT COUNT(*) AS n FROM revelations WHERE gameId = ? AND status = 'fired'", g.id).n, 3);
  assert.equal(scanUnlock(B, pointOf(g.id, A.sectorId).qrToken, codeOf(g.id, A.sectorId)).ok, true);

  // Ultima mezz'ora a 210: l'ultima rivelazione (210) parte, poi niente più
  advanceTo(g.id, 210.01);
  assert.equal(G.getGame(g.id).status, 'last_half_hour');
  assert.equal(q.get("SELECT COUNT(*) AS n FROM revelations WHERE gameId = ? AND status = 'fired'", g.id).n, 6);

  // 12. fine tempo: sblocchi disabilitati, classifica corretta
  advanceTo(g.id, 240.01);
  assert.equal(G.getGame(g.id).status, 'ended');
  assert.throws(() => scanUnlock(B, pointOf(g.id, B.sectorId).qrToken, codeOf(g.id, B.sectorId)), /finiti/);
  const st = G.standings(g.id);
  assert.equal(st[0].teamId, A.id);
  assert.equal(st[1].teamId, B.id); // 1 frammento
  assert.ok(st.slice(2).every((r) => r.fragments === 0));
  anns = q.all('SELECT type FROM announcements WHERE gameId = ? ORDER BY id', g.id).map((a) => a.type);
  assert.ok(anns.includes('last_half_hour'));
  assert.equal(anns.at(-1), 'end');
});

test('rivelazione manuale: il Settore esce dal calendario e gli orari non cambiano', () => {
  const g = setupGame(6);
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  advanceTo(g.id, 6);
  const before = q.all("SELECT * FROM revelations WHERE gameId = ? AND status = 'scheduled' ORDER BY scheduledMin", g.id);
  G.revealNext(g.id, 'test');
  const after = q.all("SELECT * FROM revelations WHERE gameId = ? AND status = 'scheduled' ORDER BY scheduledMin", g.id);
  assert.equal(after.length, before.length - 1);
  assert.deepEqual(after.map((r) => r.scheduledMin), before.slice(1).map((r) => r.scheduledMin));
});

test('calendario: casi limite R <= 0 e R = 1', () => {
  const base = { truceMin: 5, firstRevelationDelayMin: 30, durationMin: 240, lastRevelationBeforeEndMin: 30, neverRevealedCount: 2 };
  assert.deepEqual(G.revelationOffsets(base, 2), []);
  assert.deepEqual(G.revelationOffsets(base, 3), [35]);
});

test('partita di prova: pronta subito e tempo che avanza fino alla fine', () => {
  for (const n of [2, 5, 7, 10, 12]) {
    const id = G.createDemo(n, 'test');
    assert.ok(G.readiness(G.getGame(id)).ok, `demo ${n}: ${JSON.stringify(G.readiness(G.getGame(id)).issues)}`);
  }
  const id = G.createDemo(6, 'test');
  assert.throws(() => G.advanceDemo(id, 5, 'test'), /in corso/);
  G.control(id, 'ready', 'test');
  G.control(id, 'circle', 'test');
  G.control(id, 'start', 'test');
  G.advanceDemo(id, 40, 'test');
  assert.equal(G.getGame(id).status, 'hunt');
  assert.equal(q.get("SELECT COUNT(*) AS n FROM revelations WHERE gameId = ? AND status = 'fired'", id).n, 1);
  assert.ok(q.get("SELECT 1 FROM supply_drops WHERE gameId = ? AND status = 'scheduled'", id));
  const since = Date.now();
  G.advanceDemo(id, 30, 'test');
  G.settleDemoJump(id, since);
  assert.ok(q.get("SELECT 1 FROM supply_drops WHERE gameId = ? AND status = 'fired'", id));
  // L'armamento scavalcato dal salto risulta aperto al suo minuto previsto, non al momento del salto.
  const fired = q.get("SELECT * FROM supply_drops WHERE gameId = ? AND status = 'fired'", id);
  assert.ok(Math.abs((fired.firedAt - G.getGame(id).startedAt) / 60000 - fired.scheduledMin) < 0.01);
  // Gli avvenimenti restano al loro minuto di gioco: si sposta solo «adesso».
  const minOf = (at) => (at - G.getGame(id).startedAt) / 60000;
  const rev = () => q.get("SELECT firedAt FROM revelations WHERE gameId = ? AND status = 'fired'", id).firedAt;
  const drop = () => q.get("SELECT firedAt FROM supply_drops WHERE gameId = ? AND status = 'fired'", id).firedAt;
  const [r0, d0] = [minOf(rev()), minOf(drop())];
  G.advanceDemo(id, 10, 'test');
  assert.ok(Math.abs(minOf(rev()) - r0) < 0.01 && Math.abs(minOf(drop()) - d0) < 0.01);
  G.advanceDemo(id, -10, 'test');
  assert.ok(Math.abs(minOf(rev()) - r0) < 0.01 && Math.abs(minOf(drop()) - d0) < 0.01);
  // Indietro nel tempo: prima della fine della tregua si torna in tregua; mai prima del VIA.
  G.advanceDemo(id, -68, 'test');
  assert.equal(G.getGame(id).status, 'truce');
  assert.ok(G.clockOf(G.getGame(id)).elapsedMs < 3 * 60000);
  G.advanceDemo(id, -60, 'test');
  assert.ok(G.clockOf(G.getGame(id)).elapsedMs < 1000);
  assert.throws(() => G.advanceDemo(id, -5, 'test'), /VIA/);
  assert.equal(q.get("SELECT COUNT(*) AS n FROM revelations WHERE gameId = ? AND status = 'fired'", id).n, 1);
  G.advanceDemo(id, 75, 'test');
  assert.equal(G.getGame(id).status, 'hunt');
  G.advanceDemo(id, 200, 'test');
  assert.equal(G.getGame(id).status, 'ended');
  const t = q.get('SELECT * FROM teams WHERE gameId = ?', id);
  assert.equal(G.teamState(t).standings.length, 6);
  // Una partita vera non accetta l'avanzamento.
  const real = setupGame(3);
  G.control(real.id, 'ready', 'test');
  G.control(real.id, 'circle', 'test');
  G.control(real.id, 'start', 'test');
  assert.throws(() => G.advanceDemo(real.id, 5, 'test'), /prova/);
});

test('spostamenti tra Eletti e Settori: da soli o in scambio, la squadra passa a chi diventa Eletto', () => {
  const g = setupGame(2);
  const [A] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  const [a1, a2] = q.all('SELECT * FROM players WHERE teamId = ? ORDER BY id', A.id);
  const e1 = G.addElectPerson(g.id, { name: 'Eletto Uno' }, 'test');
  const elect = q.get("SELECT * FROM teams WHERE gameId = ? AND kind = 'elect'", g.id);
  const sq = Number(q.run('INSERT INTO elect_squads (gameId, name, color, createdAt) VALUES (?, ?, ?, ?)', g.id, 'Lupi', '#fff', Date.now()).lastInsertRowid);
  q.run('UPDATE players SET squadId = ? WHERE id = ?', sq, e1);
  const at = (id) => q.get('SELECT teamId, squadId FROM players WHERE id = ?', id);
  // Coppia completa: serve lo scambio.
  assert.throws(() => G.movePlayer(e1, { toTeamId: A.id }, 'test'), /completa/);
  G.movePlayer(e1, { toTeamId: A.id, swapWithId: a1.id }, 'test');
  assert.deepEqual(at(e1), { teamId: A.id, squadId: null });
  assert.deepEqual(at(a1.id), { teamId: elect.id, squadId: sq });
  // Da solo tra gli Eletti: la coppia resta incompleta; poi l'Eletto torna nella coppia incompleta.
  G.movePlayer(a2.id, { toTeamId: elect.id }, 'test');
  assert.equal(at(a2.id).teamId, elect.id);
  G.movePlayer(a1.id, { toTeamId: A.id }, 'test');
  assert.equal(at(a1.id).teamId, A.id);
  assert.throws(() => G.movePlayer(a1.id, { toTeamId: A.id }, 'test'), /già lì/);
});

test('finestre armamenti: si modificano anche aperte o chiuse', () => {
  const g = setupGame(2);
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  const id = G.saveSupply(g.id, { description: 'BB' }, 'test');
  G.fireSupply(id, 'test');
  const row = () => q.get('SELECT * FROM supply_drops WHERE id = ?', id);
  // Aperta fino a chiusura: si corregge il contenuto e le si dà una fine.
  G.saveSupply(g.id, { description: '2 casse di BB', message: 'Al Cuore!' }, 'test', id);
  assert.equal(row().description, '2 casse di BB');
  assert.equal(row().closesAt, null);
  assert.throws(() => G.shiftSupply(id, -5, 'test'), /Chiudi ora/);
  G.shiftSupply(id, 15, 'test');
  assert.ok(row().closesAt > Date.now() + 14 * 60000);
  // Durata cambiata da aperta (dall'apertura); vuota torna fino a chiusura.
  G.saveSupply(g.id, { durationMin: 40 }, 'test', id);
  assert.equal(row().closesAt, row().firedAt + 40 * 60000);
  G.saveSupply(g.id, { durationMin: '' }, 'test', id);
  assert.equal(row().closesAt, null);
  G.closeSupply(id, 'test');
  // Chiusa: si corregge solo il contenuto.
  G.saveSupply(g.id, { description: '3 casse', durationMin: 99 }, 'test', id);
  assert.equal(row().description, '3 casse');
  assert.equal(row().status, 'closed');
});

test('Settori e Altari: crea, modifica, elimina o archivia', () => {
  const id = G.saveSector(null, { name: 'Vento', element: 'i mulini', motto: 'Arriviamo ovunque' }, 'test');
  let s = G.sectorsAdmin().find((x) => x.id === id);
  assert.equal(s.roman, 'XIII');
  assert.equal(s.altar, 'Altare del Vento');
  assert.throws(() => G.saveSector(null, { name: 'vento' }, 'test'), /Esiste già/);
  G.saveSector(id, { name: 'Ambra', element: 'le resine', motto: 'Conserviamo la luce' }, 'test');
  s = G.sectorsAdmin().find((x) => x.id === id);
  assert.equal(s.altar, "Altare dell'Ambra");
  G.saveSector(id, { name: 'Ambra', altarLabel: 'Il Sepolcro di Resina' }, 'test');
  assert.equal(G.sectorsAdmin().find((x) => x.id === id).altar, 'Il Sepolcro di Resina');
  // Mai usato: eliminato davvero.
  assert.deepEqual(G.deleteSector(id, 'test'), { archived: false });
  assert.ok(!G.sectorsAdmin().some((x) => x.id === id));
  // In uso in una partita non terminata: non si elimina.
  const g = setupGame(2);
  const t = teamsOf(g.id)[0];
  assert.throws(() => G.deleteSector(t.sectorId, 'test'), /assegnato/);
});

test('iscrizione: da approvare, il Settore lo assegna il Consiglio', () => {
  const g = G.createGame({ name: 'Iscrizioni' }, 'test');
  G.publicRegister({ gameId: g.id, players: [{ name: 'A', softairTeam: 'ZDT' }, { name: 'B', softairTeam: 'ZDT' }], sectorId: G.sectors()[0].id });
  G.publicRegister({ gameId: g.id, players: [{ name: 'C', softairTeam: 'ZDT' }] });
  const pl = (n) => q.get('SELECT * FROM players WHERE gameId = ? AND name = ?', g.id, n);
  assert.equal(pl('A').status, 'pending');
  assert.equal(pl('A').requestedSectorId, null);
  // Non si accoppia chi non è stato accettato.
  assert.throws(() => G.createTeam(g.id, { playerIds: [pl('A').id, pl('B').id] }, 'test'), /accetta/);
  assert.equal(G.autoPair(g.id, 'test').created, 0);
  assert.equal(G.reviewPlayer(pl('A').id, 'accept', 'test').count, 2);
  assert.equal(pl('B').status, 'accepted');
  G.reviewPlayer(pl('C').id, 'reject', 'test');
  assert.equal(pl('C'), undefined);
  assert.equal(G.autoPair(g.id, 'test').created, 1);
  assert.ok(G.readiness(G.getGame(g.id)).issues.every((i) => !/da approvare/.test(i.text)));
});

test('Eletti del Consiglio: gruppo senza limite, fuori da Sigilli e classifica', () => {
  const g = setupGame(2);
  for (let i = 0; i < 5; i++) G.addElectPerson(g.id, { name: `Eletto ${i}` }, 'test');
  const e = G.electOf(g.id);
  assert.equal(G.membersOf(e.id).length, 5);
  assert.equal(G.teamsOf(g.id).length, 2);
  assert.ok(G.readiness(G.getGame(g.id)).ok);
  const st = G.teamState(e);
  assert.equal(st.team.kind, 'elect');
  assert.equal(st.seal, null);
  assert.equal(st.team.members.length, 5);
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  const p = q.get('SELECT * FROM points WHERE gameId = ?', g.id);
  assert.throws(() => scanUnlock(e, p.qrToken, 'XXXXXX'), /Eletti/);
  assert.ok(G.teamState(e).announcements.some((a) => a.type === 'start'));
  assert.equal(G.standings(g.id).length, 2);
  G.removeFromElect(G.membersOf(e.id)[0].id, 'test');
  assert.equal(G.membersOf(e.id).length, 4);
});

test('Avvisi: destinatari e cancellazione', () => {
  const g = setupGame(3);
  G.addElectPerson(g.id, { name: 'Eletto' }, 'test');
  const e = G.electOf(g.id);
  const [t1, t2] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  G.createNotice(g.id, { title: 'Ritrovo', body: 'Alle 8 al parcheggio', target: 'all' }, 'test');
  G.createNotice(g.id, { title: 'Solo coppie', target: 'couples' }, 'test');
  G.createNotice(g.id, { title: 'Solo Eletti', target: 'elect' }, 'test');
  const one = G.createNotice(g.id, { title: 'Per la prima coppia', target: 'team', teamId: t1.id }, 'test');
  assert.throws(() => G.createNotice(g.id, { title: '' }, 'test'), /titolo/);
  const titles = (t) => G.teamState(t).notices.map((n) => n.title).sort();
  assert.deepEqual(titles(t1), ['Per la prima coppia', 'Ritrovo', 'Solo coppie']);
  assert.deepEqual(titles(t2), ['Ritrovo', 'Solo coppie']);
  assert.deepEqual(titles(e), ['Ritrovo', 'Solo Eletti']);
  G.deleteNotice(one.id, 'test');
  assert.deepEqual(titles(t1), ['Ritrovo', 'Solo coppie']);
});

test('iscrizione: le tre strade (coppia, temerario solitario, Eletti)', () => {
  const g = G.createGame({ name: 'Tre strade' }, 'test');
  assert.throws(() => G.publicRegister({ gameId: g.id, mode: 'pair', players: [{ name: 'Solo', softairTeam: 'ZDT' }] }), /due Legati/);
  G.publicRegister({ gameId: g.id, mode: 'pair', players: [{ name: 'L1', softairTeam: 'ZDT' }, { name: 'L2', softairTeam: 'ZDT' }] });
  G.publicRegister({ gameId: g.id, mode: 'single', players: [{ name: 'T1', softairTeam: 'ZDT' }, { name: 'ignorato', softairTeam: 'ZDT' }] });
  G.publicRegister({ gameId: g.id, mode: 'elect', players: [{ name: 'E1', note: 'logistica al Cuore', softairTeam: 'ZDT' }] });
  const pl = (n) => q.get('SELECT * FROM players WHERE gameId = ? AND name = ?', g.id, n);
  assert.equal(pl('ignorato'), undefined);
  assert.equal(pl('T1').requestedRole, 'single');
  assert.equal(pl('E1').note, 'logistica al Cuore');
  // Accettato, il candidato entra direttamente tra gli Eletti.
  G.reviewPlayer(pl('E1').id, 'accept', 'test');
  assert.equal(pl('E1').teamId, G.electOf(g.id).id);
});

test('accesso personale: anteprima subito dopo l\'iscrizione, poi passa da solo alla coppia', () => {
  const g = G.createGame({ name: 'Anteprima' }, 'test');
  const r = G.publicRegister({ gameId: g.id, mode: 'pair', players: [{ name: 'P1', softairTeam: 'ZDT' }, { name: 'P2', softairTeam: 'ZDT' }] });
  const get = (id) => q.get('SELECT * FROM players WHERE id = ?', id);
  const p1 = get(r.playerIds[0]);
  assert.match(p1.accessCode, /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$/);
  assert.notEqual(p1.accessCode, get(r.playerIds[1]).accessCode);
  let st = G.lobbyState(p1);
  assert.equal(st.team.kind, 'lobby');
  assert.equal(st.player.status, 'pending');
  assert.equal(st.team.members.length, 2);
  assert.equal(st.seal, null);
  G.createNotice(g.id, { title: 'Benvenuti', target: 'all' }, 'test');
  G.createNotice(g.id, { title: 'Solo coppie', target: 'couples' }, 'test');
  assert.deepEqual(G.lobbyState(p1).notices.map((n) => n.title), ['Benvenuti']);
  G.reviewPlayer(p1.id, 'accept', 'test');
  G.createTeam(g.id, { playerIds: r.playerIds }, 'test');
  const after = get(p1.id);
  const team = q.get('SELECT * FROM teams WHERE id = ?', after.teamId);
  st = G.teamState(team, after);
  assert.equal(st.team.kind, 'couple');
  assert.equal(st.player.accessCode, p1.accessCode);
  assert.deepEqual(st.notices.map((n) => n.title).sort(), ['Benvenuti', 'Solo coppie']);
});

test("scansione dell'Altare: vale i minuti stabiliti, poi va ripetuta", () => {
  const g = setupGame(2);
  G.updateGame(g.id, { altarScanMin: 10 }, 'test');
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  const [A, B] = teamsOf(g.id);
  const pB = pointOf(g.id, B.sectorId);
  // Senza scansione non si sblocca.
  assert.equal(G.unlock(A, pB.qrToken, codeOf(g.id, B.sectorId)).ok, false);
  // Scansione di 11 minuti fa (es. arrivata dalla coda offline): scaduta.
  const v = G.visitPoint(A, pB.qrToken, Date.now() - 11 * 60000);
  assert.ok(v.expiresAt < Date.now());
  const r = G.unlock(A, pB.qrToken, codeOf(g.id, B.sectorId));
  assert.equal(r.ok, false);
  assert.equal(r.expired, true);
  // Nuova scansione: vale di nuovo e lo sblocco riesce.
  G.visitPoint(A, pB.qrToken);
  assert.equal(G.unlock(A, pB.qrToken, codeOf(g.id, B.sectorId)).ok, true);
  // 0 = senza limite
  G.updateGame(g.id, { altarScanMin: 0 }, 'test');
  const pA = pointOf(g.id, A.sectorId);
  assert.equal(G.visitPoint(B, pA.qrToken, Date.now() - 5 * 3600000).expiresAt, null);
  assert.equal(G.unlock(B, pA.qrToken, codeOf(g.id, A.sectorId)).ok, true);
});

test("lettura dell'Altare piazzato: vale solo entro il raggio fissato dalla regia", () => {
  const g = setupGame(2);
  const [A, B] = teamsOf(g.id);
  const pB = pointOf(g.id, B.sectorId);
  const pA = pointOf(g.id, A.sectorId);
  q.run('UPDATE points SET lat = 45.0, lng = 7.0 WHERE id = ?', pB.id);
  // Controllo spento: nessun controllo, anche senza posizione.
  assert.ok(G.visitPoint(A, pB.qrToken).visitedAt);
  G.updateGame(g.id, { altarRadiusM: 30, altarCheckOn: true }, 'test');
  // Senza GPS: rifiutata con la motivazione.
  assert.throws(() => G.visitPoint(A, pB.qrToken), /serve la posizione GPS/);
  // A circa 111 m (0,001° di latitudine): rifiutata con la distanza.
  assert.throws(() => G.visitPoint(A, pB.qrToken, null, { lat: 45.001, lng: 7.0, acc: 10 }), /circa 111 m.*entro 30 m/);
  // I due cerchi si toccano: Altare 30 m + GPS fino a 50 m. A 100 m nemmeno con GPS ±75 m (conta 50 m).
  assert.throws(() => G.visitPoint(A, pB.qrToken, null, { lat: 45.0009, lng: 7.0, acc: 75 }), /circa 100 m/);
  // A 78 m con GPS ±50 m: 30 + 50 = 80 m → accettata.
  assert.ok(G.visitPoint(A, pB.qrToken, null, { lat: 45.0007, lng: 7.0, acc: 50 }).visitedAt);
  // A 40 m con GPS ±20 m: i cerchi si toccano, accettata.
  assert.ok(G.visitPoint(A, pB.qrToken, null, { lat: 45.00036, lng: 7.0, acc: 20 }).visitedAt);
  // Altare senza coordinate: nessun controllo.
  q.run('UPDATE points SET lat = NULL, lng = NULL WHERE id = ?', pA.id);
  assert.ok(G.visitPoint(B, pA.qrToken).visitedAt);
  // Spento al volo dalla Regia: di nuovo nessun controllo (il raggio resta impostato).
  G.updateGame(g.id, { altarCheckOn: false }, 'test');
  assert.ok(G.visitPoint(A, pB.qrToken).visitedAt);
  assert.equal(G.getGame(g.id).altarRadiusM, 30);
  // In regia: il registro delle letture rifiutate, dalla più recente, con Altare, posizione e distanza.
  const rej = G.masterState(g.id).altarRejections;
  assert.equal(rej.length, 3);
  assert.equal(rej[0].reason, 'too_far');
  assert.equal(rej[0].altar, pB.label);
  assert.equal(rej[0].distM, 100);
  assert.equal(rej[1].distM, 111);
  assert.deepEqual([rej[1].lat, rej[1].altarLat, rej[1].radiusM], [45.001, 45, 30]);
  assert.equal(rej[2].reason, 'no_gps');
});

test('doni QR: piazzamento con foto e posizione, comparsa, presa, scadenza', () => {
  const F = require('../src/field');
  const g = setupGame(3);
  const [A, B] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  const type = F.giftTypes()[0];
  const { ids } = F.createGifts(g.id, { typeId: type.id, count: 2, revealMode: 'onplace', expiresAfterMin: 10 }, 'test');
  const photo = { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mime: 'image/jpeg', lat: 45.1, lng: 9.2, acc: 8 };
  assert.throws(() => F.placeGift(ids[0], g.id, { ...photo, lat: 'x' }, 'eletto'), /Posizione/);
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  advanceTo(g.id, 6);
  const r = F.placeGift(ids[0], g.id, photo, 'eletto');
  assert.equal(r.revealed, true);
  assert.equal(F.teamMap(A).gifts.length, 1);
  const tok = q.get('SELECT qrToken FROM gifts WHERE id = ?', ids[0]).qrToken;
  const got = F.claimGift(A, tok);
  assert.equal(got.gift.name, type.name);
  assert.throws(() => F.claimGift(B, tok), /già preso/);
  assert.equal(F.teamMap(B).gifts.length, 0);
  assert.ok(q.get("SELECT 1 FROM announcements WHERE gameId = ? AND type = 'gift_taken'", g.id));
  // Il secondo dono svanisce dopo 10 minuti di gioco.
  F.placeGift(ids[1], g.id, photo, 'eletto');
  advanceTo(g.id, 17);
  F.tickAll();
  assert.equal(q.get('SELECT status FROM gifts WHERE id = ?', ids[1]).status, 'expired');
  const tok2 = q.get('SELECT qrToken FROM gifts WHERE id = ?', ids[1]).qrToken;
  assert.throws(() => F.claimGift(B, tok2), /svanito/);
  // Altare piazzato: compare sulla mappa delle coppie.
  const p = pointOf(g.id, A.sectorId);
  F.placePoint(p.id, g.id, photo, 'eletto');
  assert.ok(F.teamMap(B).points.some((x) => x.id === p.id));
});

test("controllo posizione acceso dopo: le letture fatte senza controllo non valgono più (si riscansiona davanti all'Altare)", () => {
  const g = setupGame(2);
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  const [A, B] = teamsOf(g.id);
  const pB = pointOf(g.id, B.sectorId);
  q.run('UPDATE points SET lat = 45.0, lng = 7.0 WHERE id = ?', pB.id);
  // Lettura da lontano con il controllo spento: passa.
  G.visitPoint(A, pB.qrToken, null, { lat: 46, lng: 8, acc: 5 });
  G.updateGame(g.id, { altarCheckOn: true, altarRadiusM: 30 }, 'test');
  // Acceso il controllo: quella lettura non vale per il Sigillo e non risulta tra gli Altari letti.
  const r = G.unlock(A, pB.qrToken, codeOf(g.id, B.sectorId));
  assert.equal(r.ok, false);
  assert.match(r.message, /davanti all'Altare/);
  assert.equal(G.teamState(A).visited.some((v) => v.pointId === pB.id), false);
  // Da lontano: rifiutata; davanti all'Altare: vale e il Sigillo apre.
  assert.throws(() => G.visitPoint(A, pB.qrToken, null, { lat: 46, lng: 8, acc: 5 }), /Lettura rifiutata/);
  G.visitPoint(A, pB.qrToken, null, { lat: 45.0001, lng: 7.0, acc: 5 });
  assert.equal(G.unlock(A, pB.qrToken, codeOf(g.id, B.sectorId)).ok, true);
});

test("partita «Creata»: solo in regia, poi in preparazione; iscrizioni chiuse finché è creata", () => {
  const g = G.createGame({ name: 'Nuova', status: 'created', registrationOpen: true }, 'test');
  assert.equal(G.getGame(g.id).status, 'created');
  assert.throws(() => G.control(g.id, 'ready', 'test'), /non possibile/);
  G.control(g.id, 'prepare', 'test');
  assert.equal(G.getGame(g.id).status, 'draft');
  G.control(g.id, 'created', 'test');
  const back = G.getGame(g.id);
  assert.deepEqual([back.status, back.registrationOpen], ['created', 0]);
});

test('preparazione: Altare piazzato visto in regia, alle coppie solo dal via; tornando in preparazione i doni piazzati si tolgono', () => {
  const F = require('../src/field');
  const g = setupGame(2);
  const g2 = setupGame(2);
  const [A, B] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  const photo = { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mime: 'image/jpeg', lat: 45.1, lng: 9.2, acc: 8 };
  const p = pointOf(g.id, A.sectorId);
  F.placePoint(p.id, g.id, photo, 'master');
  // In regia risulta piazzato (mappa, elenco, preparazione).
  const ms = G.masterState(g.id);
  assert.equal(ms.points.find((x) => x.id === p.id).lat, 45.1);
  assert.equal(ms.altarsPlaced.placed, 1);
  assert.equal(F.fieldState(g.id).points.find((x) => x.id === p.id).lat, 45.1);
  // Alle coppie: non prima del via, poi sì (anche agli altri).
  assert.equal(F.teamMap(B).points.length, 0);
  // Cartello di un'altra partita aperta: la regia lo riconosce e sa di quale partita è.
  const r = F.resolveToken(g2.id, `https://x/a/${p.qrToken}`, true);
  assert.deepEqual([r.kind, r.id, r.gameId], ['point', p.id, g.id]);
  assert.throws(() => F.resolveToken(g2.id, `https://x/a/${p.qrToken}`), /non riconosciuto/);
  // Doni piazzati in prova: tornando in preparazione tornano da piazzare.
  const type = F.giftTypes()[0];
  const { ids } = F.createGifts(g.id, { typeId: type.id, count: 1, revealMode: 'manual' }, 'test');
  F.placeGift(ids[0], g.id, photo, 'master');
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'draft', 'test');
  const gift = q.get('SELECT status, lat FROM gifts WHERE id = ?', ids[0]);
  assert.deepEqual([gift.status, gift.lat], ['draft', null]);
  // L'Altare resta piazzato.
  assert.equal(q.get('SELECT lat FROM points WHERE id = ?', p.id).lat, 45.1);
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  assert.ok(F.teamMap(B).points.some((x) => x.id === p.id));
});

test('alleanze e scontri: Sigilli condivisi, vinti dalla parte vincente, timer di rientro', () => {
  const K = require('../src/combat');
  const g = setupGame(4);
  const [A, B, Cc, D] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  const known = (t, s) => G.teamState(t).notebook.find((n) => n.sectorId === s.sectorId);
  // Alleanza A + B: invito e accettazione, i Sigilli passano agli alleati.
  const req = K.requestAlliance(A, B.id);
  assert.throws(() => K.requestAlliance(A, B.id), /attesa/);
  K.respondRequest(B, req.id, true);
  assert.equal(known(A, B).code, codeOf(g.id, B.sectorId));
  assert.equal(known(A, B).source, 'alliance');
  assert.equal(known(B, A).code, codeOf(g.id, A.sectorId));
  // In tregua niente scontri.
  assert.throws(() => K.reportEngagement(Cc, A.id, 'won'), /Tregua/);
  advanceTo(g.id, 6);
  // C perde contro A: l'alleanza A+B riceve il Sigillo di C, C fa la Veglia.
  lose(K, Cc, A);
  assert.equal(known(A, Cc).source, 'won');
  assert.equal(known(B, Cc).code, codeOf(g.id, Cc.sectorId));
  assert.ok(K.serverTimers(Cc.id).some((t) => t.timerId === 'veglia'));
  // D dichiara di aver vinto contro A: serve la conferma degli sconfitti (A e B).
  const e = K.reportEngagement(D, A.id, 'won');
  assert.equal(e.status, 'pending');
  assert.equal(known(D, A).code, null);
  assert.equal(K.combatState(B).toConfirm.length, 1);
  // Le alleanze degli altri sono segrete: D non vede quanti sono né chi c'è dietro ad A.
  const seen = K.combatState(D);
  assert.ok(seen.teams.every((t) => !('allianceSize' in t)));
  assert.deepEqual(seen.history[0].losers.map((x) => x.teamId), [A.id]);
  assert.ok(!JSON.stringify(K.combatState(Cc).history).includes(`"teamId":${B.id}`));
  K.respondEngagement(B, e.id, true);
  assert.equal(known(D, A).code, codeOf(g.id, A.sectorId));
  assert.equal(known(D, B).code, codeOf(g.id, B.sectorId));
  // Vittoria sul telefono di D: i Sigilli di tutta l'alleanza sconfitta, anche se già noti.
  const v = K.combatState(D).victories.find((x) => x.id === e.id);
  assert.equal(v.against.teamId, A.id);
  assert.deepEqual(v.seals.map((x) => x.sectorId).sort(), [A.sectorId, B.sectorId].sort());
  assert.equal(v.seals.find((x) => x.sectorId === B.sectorId).code, codeOf(g.id, B.sectorId));
  // Anche l'alleato di chi vince vede la sua Vittoria (C ha perso contro A: vince anche B).
  assert.ok(K.combatState(B).victories.some((x) => x.seals.some((y) => y.sectorId === Cc.sectorId)));
  assert.equal(K.combatState(A).victories.some((x) => x.id === e.id), false);
  // Non si combatte contro un alleato; rottura con accettazione.
  assert.throws(() => K.reportEngagement(A, B.id, 'won'), /alleato/);
  const br = K.requestBreak(A, B.id);
  K.respondRequest(B, br.id, true);
  assert.equal(K.allianceOf(A.id), null);
  assert.ok(K.serverTimers(A.id).some((t) => t.timerId === 'blocco'));
  // Rifiuto: blocco riproposta.
  const r2 = K.requestAlliance(A, Cc.id);
  K.respondRequest(Cc, r2.id, false);
  assert.throws(() => K.requestAlliance(A, Cc.id), /Blocco riproposta/);
});

test('vittoria senza Sigilli nuovi: si ruba un Sigillo dal taccuino della parte sconfitta', () => {
  const K = require('../src/combat');
  const g = setupGame(5);
  const [A, B, Cc, D, E] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  advanceTo(g.id, 6);
  const known = (t, s) => G.teamState(t).notebook.find((n) => n.sectorId === s.sectorId);
  // Prima vittoria di D su C: Sigillo nuovo, niente furto.
  const e1 = lose(K, Cc, D);
  assert.equal(known(D, Cc).source, 'won');
  assert.equal(K.combatState(D).steals.length, 0);
  // C intanto ha scoperto il Sigillo di B (e D no).
  q.run('INSERT INTO team_code_notes (teamId, sectorId, code, correct, addedAt, source) VALUES (?, ?, ?, 1, ?, ?)', Cc.id, B.sectorId, codeOf(g.id, B.sectorId), Date.now(), 'note');
  // Seconda vittoria su C: D non ottiene niente di nuovo, gli si propone solo il Sigillo di B.
  const e2 = lose(K, Cc, D);
  assert.notEqual(e1.id, e2.id);
  const st = K.combatState(D).steals;
  assert.equal(st.length, 1);
  assert.deepEqual(st[0].candidates.map((c) => c.sectorId), [B.sectorId]);
  assert.throws(() => K.stealCode(D, e2.id, A.sectorId), /non si può rubare/);
  const got = K.stealCode(D, e2.id, B.sectorId);
  assert.equal(got.code, codeOf(g.id, B.sectorId));
  assert.equal(known(D, B).code, codeOf(g.id, B.sectorId));
  assert.equal(K.combatState(D).steals.length, 0);
  assert.throws(() => K.stealCode(D, e2.id, B.sectorId), /già scelto/);
  // Niente da rubare (C non conosce altro che D non sappia): nessuna proposta.
  lose(K, Cc, D);
  assert.equal(K.combatState(D).steals.length, 0);
  // Alleanza sconfitta: si sommano i taccuini di tutta l'alleanza.
  q.run('INSERT INTO team_code_notes (teamId, sectorId, code, correct, addedAt, source) VALUES (?, ?, ?, 1, ?, ?)', A.id, E.sectorId, codeOf(g.id, E.sectorId), Date.now(), 'note');
  K.respondRequest(A, K.requestAlliance(Cc, A.id).id, true);
  // D conosce già C; A è nuovo, quindi vince il Sigillo di A senza furto.
  lose(K, Cc, D);
  assert.equal(known(D, A).source, 'won');
  assert.equal(K.combatState(D).steals.length, 0);
  // Ora D li conosce tutti e due: si propone E (dal taccuino di A, alleato di C).
  advanceTo(g.id, 7);
  lose(K, Cc, D);
  assert.deepEqual(K.combatState(D).steals[0].candidates.map((c) => c.sectorId), [E.sectorId]);
});

test('Traccar Client: posizione anche a schermo spento, un solo punto per persona', () => {
  const F = require('../src/field');
  const g = setupGame(2);
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  const pl = q.get('SELECT * FROM players WHERE gameId = ? AND teamId IS NOT NULL ORDER BY id LIMIT 1', g.id);
  const info = F.trackingInfo(pl);
  assert.match(info.deviceId, /^[a-z0-9]{10}$/);
  assert.equal(F.trackingInfo(q.get('SELECT * FROM players WHERE id = ?', pl.id)).deviceId, info.deviceId);
  // Protocollo OsmAnd: parametri nell'indirizzo.
  F.recordTraccar({ id: info.deviceId, lat: '45.1', lon: '9.2', accuracy: '8', timestamp: String(Math.floor(Date.now() / 1000)) }, {});
  let mine = F.positionsOf(g.id).filter((x) => x.teamId === pl.teamId);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].lat, 45.1);
  // Versione nuova: JSON con location.coords.
  F.recordTraccar({}, { device_id: info.deviceId, location: { timestamp: new Date().toISOString(), coords: { latitude: 45.2, longitude: 9.3, accuracy: 5 } } });
  mine = F.positionsOf(g.id).filter((x) => x.teamId === pl.teamId);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].lat, 45.2);
  // Con l'app aperta sullo stesso giocatore: in mappa resta un solo punto, il più recente.
  F.recordPosition(q.get('SELECT * FROM teams WHERE id = ?', pl.teamId), pl, { deviceId: 'telefono-aperto-1', lat: 45.3, lng: 9.4, acc: 6 });
  mine = F.positionsOf(g.id).filter((x) => x.teamId === pl.teamId);
  assert.equal(mine.length, 1);
  // Punti vecchi rimasti nel telefono e identificativi sconosciuti: ignorati.
  assert.equal(F.recordTraccar({ id: info.deviceId, lat: '1', lon: '1', timestamp: String(Math.floor(Date.now() / 1000) - 3600) }, {}).ignored, 'vecchia');
  assert.equal(F.recordTraccar({ id: 'sconosciuto', lat: '1', lon: '1' }, {}).ok, false);
});

test('squadre di Eletti: membri, incarichi di piazzamento e incarichi liberi', () => {
  const F = require('../src/field');
  const g = setupGame(3);
  const e1 = G.addElectPerson(g.id, { name: 'Eletto Uno' }, 'test');
  const e2 = G.addElectPerson(g.id, { name: 'Eletto Due' }, 'test');
  const alfa = F.createSquad(g.id, { name: 'Alfa' }, 'test').id;
  const beta = F.createSquad(g.id, { name: 'Beta', color: '#5aa0e0' }, 'test').id;
  F.setMemberSquad(e1, alfa, 'test');
  F.setMemberSquad(e2, beta, 'test');
  // Solo gli Eletti entrano nelle squadre.
  const coupleMember = q.get('SELECT id FROM players WHERE gameId = ? AND teamId IN (SELECT id FROM teams WHERE kind = ?)', g.id, 'couple').id;
  assert.throws(() => F.setMemberSquad(coupleMember, alfa, 'test'), /Eletti/);
  const [p1, p2] = q.all('SELECT * FROM points WHERE gameId = ?', g.id);
  F.assignToSquad('point', p1.id, alfa, 'test');
  F.assignToSquad('point', p2.id, alfa, 'test');
  F.createTask(g.id, { squadId: alfa, text: 'Presidiate il Cuore' }, 'test');
  const elect = G.electOf(g.id);
  const player1 = q.get('SELECT * FROM players WHERE id = ?', e1);
  assert.equal(F.electSummary(elect, player1).squad.name, 'Alfa');
  assert.equal(F.electSummary(elect, player1).todo, 3);
  // Piazzare un Altare assegnato chiude l'incarico; l'incarico libero si segna come fatto.
  F.placePoint(p1.id, g.id, { buffer: Buffer.from([0xff, 0xd8]), mime: 'image/jpeg', lat: 45, lng: 9, acc: 5 }, 'eletti:Eletto Uno');
  const task = q.get('SELECT * FROM squad_tasks WHERE squadId = ?', alfa);
  F.setTaskDone(task.id, true, 'eletti:Eletto Uno', g.id);
  assert.equal(F.electSummary(elect, player1).todo, 1);
  const squads = F.fieldState(g.id).squads;
  assert.deepEqual(squads.map((s) => [s.name, s.members.length]), [['Alfa', 1], ['Beta', 1]]);
  // Eliminando la squadra i membri e gli incarichi tornano liberi.
  F.deleteSquad(alfa, 'test');
  assert.equal(q.get('SELECT squadId FROM players WHERE id = ?', e1).squadId, null);
  assert.equal(q.get('SELECT squadId FROM points WHERE id = ?', p2.id).squadId, null);
});

test('posizioni GPS: coppie solo a partita iniziata, Eletti da partita pronta', () => {
  const F = require('../src/field');
  const g = setupGame(2);
  const [A] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  G.addElectPerson(g.id, { name: 'Vedetta' }, 'test');
  const elect = G.electOf(g.id);
  const pos = (deviceId) => ({ deviceId, lat: 45.07, lng: 7.68, acc: 9 });
  // In preparazione: nessuno viene registrato. Da pronta: gli Eletti sì, la coppia no.
  assert.equal(F.recordPosition(A, null, pos('coppia-A-tel1')).tracking, false);
  assert.equal(F.recordPosition(elect, null, pos('eletto-tel-01')).tracking, false);
  assert.deepEqual(F.positionsOf(g.id), []);
  G.control(g.id, 'ready', 'test');
  assert.equal(F.recordPosition(elect, null, pos('eletto-tel-01')).tracking, true);
  assert.deepEqual(F.positionsOf(g.id).map((p) => p.kind), ['elect']);
  G.control(g.id, 'circle', 'test');
  assert.equal(F.recordPosition(A, null, pos('coppia-A-tel1')).tracking, false);
  G.control(g.id, 'start', 'test');
  assert.equal(F.recordPosition(A, null, pos('coppia-A-tel1')).tracking, true);
  assert.deepEqual(F.positionsOf(g.id).map((p) => p.kind).sort(), ['elect', 'team']);
  // Gli Eletti vedono solo gli Eletti.
  assert.deepEqual(F.positionsOf(g.id, 'elect').map((p) => p.kind), ['elect']);
  assert.throws(() => F.recordPosition(A, null, { deviceId: 'x', lat: 1, lng: 1 }), /Dispositivo/);
  G.control(g.id, 'end', 'test');
  assert.equal(F.recordPosition(A, null, pos('coppia-A-tel1')).tracking, false);
  assert.equal(F.recordPosition(elect, null, pos('eletto-tel-01')).tracking, false);
});

test('iscrizione: il team di softair è obbligatorio; candidati Eletti accettati direttamente in squadra', () => {
  const F = require('../src/field');
  const g = G.createGame({ name: 'Softair', registrationOpen: true }, 'test');
  assert.throws(() => G.publicRegister({ gameId: g.id, mode: 'single', players: [{ name: 'Senza team' }] }), /team di softair/);
  const { playerIds: [eid] } = G.publicRegister({ gameId: g.id, mode: 'elect', players: [{ name: 'Vedetta', softairTeam: 'Lupi Grigi' }] });
  const { id: sq } = F.createSquad(g.id, { name: 'Nord' }, 'test');
  G.reviewPlayer(eid, 'accept', 'test', { squadId: sq });
  const p = q.get('SELECT * FROM players WHERE id = ?', eid);
  assert.equal(p.teamId, G.electOf(g.id).id);
  assert.equal(p.squadId, sq);
  assert.equal(p.softairTeam, 'Lupi Grigi');
});

test('incarichi: punto indicato sulla mappa, spostamento alla squadra che ha piazzato, Soglia e Cerchio senza foto', () => {
  const F = require('../src/field');
  const g = setupGame(2);
  const { id: nord } = F.createSquad(g.id, { name: 'Nord' }, 'test');
  const { id: sud } = F.createSquad(g.id, { name: 'Sud' }, 'test');
  const p = q.get('SELECT * FROM points WHERE gameId = ? LIMIT 1', g.id);
  const photo = { buffer: Buffer.from([0xff, 0xd8]), mime: 'image/jpeg', lat: 45, lng: 9, acc: 5 };
  F.assignToSquad('point', p.id, nord, 'test', { targetLat: 45.1, targetLng: 9.1, note: 'vicino al ponte' });
  let row = q.get('SELECT * FROM points WHERE id = ?', p.id);
  assert.deepEqual([row.squadId, row.targetLat, row.taskNote, row.moveRequestedAt], [nord, 45.1, 'vicino al ponte', null]);
  assert.throws(() => F.assignToSquad('point', p.id, nord, 'test', { move: true }), /ancora piazzato/i);
  F.placePoint(p.id, g.id, photo, 'eletti:Uno', nord);
  row = q.get('SELECT * FROM points WHERE id = ?', p.id);
  assert.equal(row.placedSquadId, nord);
  // Spostamento: torna "da fare" per la squadra scelta, si chiude ripiazzando.
  F.assignToSquad('point', p.id, sud, 'test', { move: true, targetLat: null, targetLng: null });
  row = q.get('SELECT * FROM points WHERE id = ?', p.id);
  assert.ok(row.moveRequestedAt);
  assert.equal(row.squadId, sud);
  assert.equal(row.targetLat, null);
  F.placePoint(p.id, g.id, { ...photo, lat: 45.2 }, 'eletti:Due', sud);
  row = q.get('SELECT * FROM points WHERE id = ?', p.id);
  assert.deepEqual([row.moveRequestedAt, row.placedSquadId, row.lat], [null, sud, 45.2]);
  // Luoghi del gioco: due per partita, piazzabili senza foto, visibili alle coppie solo se piazzati.
  const st = F.fieldState(g.id);
  assert.deepEqual(st.landmarks.map((l) => l.kind), ['cerchio', 'soglia']);
  const soglia = st.landmarks.find((l) => l.kind === 'soglia');
  F.assignToSquad('landmark', soglia.id, nord, 'test');
  F.placeLandmark(soglia.id, g.id, { lat: 45.3, lng: 9.3, acc: 4 }, 'regia');
  const [A] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  // Nessun punto del gioco prima del tempo: la Soglia compare alle coppie solo dal via.
  assert.deepEqual(F.teamMap(A).landmarks, []);
  // Indicazioni campo (parcheggio…): visibili in preparazione, spariscono al Cerchio.
  assert.throws(() => F.createGuide(g.id, { label: 'Parcheggio' }, 'regia'), /mappa/);
  const gd = F.createGuide(g.id, { label: 'Parcheggio', icon: 'parking', lat: 45.1, lng: 9.1 }, 'regia');
  assert.deepEqual(F.teamMap(A).guide.map((x) => [x.label, x.icon]), [['Parcheggio', 'parking']]);
  F.updateGuide(gd.id, g.id, { icon: 'car<script>' }, 'regia');
  assert.equal(F.teamGuide(g.id)[0].icon, 'carscript');
  q.run("UPDATE games SET status = 'circle' WHERE id = ?", g.id);
  assert.deepEqual(F.teamMap(A).guide, []);
  q.run("UPDATE games SET status = 'hunt' WHERE id = ?", g.id);
  assert.deepEqual(F.teamMap(A).landmarks.map((l) => l.kind), ['soglia']);
  F.deleteGuide(gd.id, g.id, 'regia');
  assert.equal(F.fieldState(g.id).guide.length, 0);
  assert.equal(F.fieldState(g.id).landmarks.find((l) => l.kind === 'soglia').hasPhoto, false);
  assert.throws(() => F.placePoint(p.id, g.id, { lat: 45, lng: 9 }, 'x'), /Foto/);
});

test('Altari senza coppia: creati subito, Sigillo solo dal tradimento e ultimo in calendario, visibili alle coppie dal via', () => {
  const F = require('../src/field');
  const g0 = G.createGame({ name: 'Senza coppia' }, 'test');
  // Prima delle iscrizioni: un Altare per ogni Settore, subito in regia e piazzabile.
  const { added } = G.addFreePoints(g0.id, { all: true }, 'test');
  assert.equal(added, q.get('SELECT COUNT(*) AS n FROM sectors WHERE archived = 0').n);
  assert.ok(F.fieldState(g0.id).points.every((p) => p.free));
  const first = F.fieldState(g0.id).points[0];
  F.placePoint(first.id, g0.id, { lat: 45, lng: 9, provisional: true }, 'regia');
  // Le coppie prendono prima i Settori con l'Altare; l'Altare di una coppia nasce appena formata.
  for (let i = 0; i < 4; i++) G.addPlayer(g0.id, { name: `P${i}` });
  G.autoPair(g0.id, 'test');
  const teams = teamsOf(g0.id);
  assert.ok(teams.some((t) => t.sectorId === first.sectorId));
  const st = F.fieldState(g0.id);
  assert.equal(st.points.filter((p) => !p.free).length, 2);
  // Tolgo tutti gli Altari senza coppia tranne due: restano anche se non sono piazzati (creati dalla regia).
  const free = st.points.filter((p) => p.free);
  free.slice(2).forEach((p) => G.deletePoint(p.id, 'test'));
  assert.throws(() => G.deletePoint(st.points.find((p) => !p.free).id, 'test'), /di una coppia/);
  G.ensurePoints(G.getGame(g0.id), 'test');
  assert.equal(q.get('SELECT COUNT(*) AS n FROM points WHERE gameId = ?', g0.id).n, 4);
  G.updateGame(g0.id, { neverRevealedCount: 1 }, 'test');
  G.generateCodes(g0.id, 'test');
  G.setPhrase(g0.id, 'uno due tre quattro', 'test');
  const freeSectors = new Set(free.slice(0, 2).map((p) => p.sectorId));
  const codes = q.all('SELECT * FROM sector_codes WHERE gameId = ?', g0.id);
  assert.equal(codes.length, 4);
  // Mai rivelati solo tra le coppie; l'ultimo tradimento è di un Altare senza coppia (il lucchetto).
  assert.ok(codes.filter((c) => c.neverRevealed).every((c) => !freeSectors.has(c.sectorId)));
  const revs = q.all('SELECT * FROM revelations WHERE gameId = ? ORDER BY scheduledMin', g0.id);
  assert.equal(revs.length, 3);
  assert.ok(freeSectors.has(revs.at(-1).sectorId));
  assert.ok(G.readiness(G.getGame(g0.id)).ok, JSON.stringify(G.readiness(G.getGame(g0.id)).issues));
  // Taccuino: gli Altari senza coppia compaiono solo dal via; la mappa delle coppie è vuota fino al via.
  const [A] = teamsOf(g0.id);
  assert.equal(G.teamState(A).notebook.length, 2);
  assert.equal(F.teamMap(A).points.length, 0);
  for (const a of ['ready', 'circle']) G.control(g0.id, a, 'test');
  assert.equal(F.teamMap(A).points.length, 0);
  G.control(g0.id, 'start', 'test');
  assert.equal(F.teamMap(A).points.length, 1);
  const nb = G.teamState(A).notebook;
  assert.equal(nb.length, 4);
  assert.equal(nb.filter((n) => n.free).length, 2);
  // KMZ per ATAK: zip valido con il KML e le icone.
  const { name, data } = F.orgKmz(g0.id);
  assert.match(name, /\.kmz$/);
  assert.equal(data.readUInt32LE(0), 0x04034b50);
  const zlib = require('zlib');
  const kml = zlib.inflateRawSync(data.subarray(30 + data.readUInt16LE(26), 30 + data.readUInt16LE(26) + data.readUInt32LE(18))).toString();
  assert.match(kml, /<kml/);
  assert.match(kml, /provvisorio/);
  assert.match(F.teamKmz(A).data.toString('latin1'), /doc\.kml/);
});

test('posti per l\'iscrizione: Settori da aprire, coppie e temerari', () => {
  const A = require('../src/accounts');
  const g = G.createGame({ name: 'Posti' }, 'test');
  G.updateGame(g.id, { registrationOpen: 1, maxCouples: 9 }, 'test');
  let n = 0;
  const acc = () => A.register({ username: `posti${++n}`, password: 'password1', name: `P${n}`, softairTeam: 'nessuno' });
  const pair = () => { const r = A.enroll(acc(), { gameId: g.id, mode: 'pair' }); A.enroll(acc(), { gameId: g.id, mode: 'pair', pairCode: r.pairCode }); };
  // 9 Settori = 18 posti. 3 coppie e 1 temerario in attesa → 6 Settori per le coppie, 18 − 6 − 1 = 11 temerari.
  pair(); pair(); pair();
  A.enroll(acc(), { gameId: g.id, mode: 'single' });
  assert.deepEqual([G.spotsOf(g.id).couples, G.spotsOf(g.id).singles, G.spotsOf(g.id).places], [6, 11, 18]);
  // Un secondo temerario: con il primo fanno un Settore.
  A.enroll(acc(), { gameId: g.id, mode: 'single' });
  assert.deepEqual([G.spotsOf(g.id).couples, G.spotsOf(g.id).singles], [5, 10]);
  // Limiti: Settori finiti e tetto ai temerari.
  G.updateGame(g.id, { maxCouples: 4, maxSingles: 2 }, 'test');
  assert.deepEqual([G.spotsOf(g.id).couples, G.spotsOf(g.id).singles], [0, 0]);
  assert.throws(() => A.enroll(acc(), { gameId: g.id, mode: 'pair' }), /coppie esauriti/);
  assert.throws(() => A.enroll(acc(), { gameId: g.id, mode: 'single' }), /temerari solitari esauriti/);
  // Gli Eletti non hanno limite; vuoto = tutti i Settori attivi.
  A.enroll(acc(), { gameId: g.id, mode: 'elect' });
  G.updateGame(g.id, { maxCouples: '', maxSingles: '' }, 'test');
  assert.equal(G.spotsOf(g.id).capacity, q.get('SELECT COUNT(*) AS n FROM sectors WHERE archived = 0').n);
});

test('notifiche: chi le ha sul suo telefono, solo su quello della coppia, o per niente', () => {
  const g = setupGame(2);
  const [A, B] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  const [a1, a2] = q.all('SELECT id FROM players WHERE teamId = ? ORDER BY id', A.id);
  const now = Date.now();
  q.run('INSERT INTO push_subs (endpoint, data, playerId, createdAt) VALUES (?, ?, ?, ?)', 'https://push/a1', '{}', a1.id, now);
  q.run('INSERT INTO push_subs (endpoint, data, teamId, createdAt) VALUES (?, ?, ?, ?)', 'https://push/b', '{}', B.id, now);
  const rep = G.pushReport(g.id);
  const st = Object.fromEntries(rep.people.map((p) => [p.id, p.state]));
  assert.equal(st[a1.id], 'on');
  assert.equal(st[a2.id], 'off');
  for (const p of q.all('SELECT id FROM players WHERE teamId = ?', B.id)) assert.equal(st[p.id], 'shared');
  assert.ok(rep.people.every((p) => p.group === 'couple' && p.where));
  // Il numero in regia conta anche chi non ha Traccar verificato (qui nessuno).
  assert.equal(G.masterState(g.id).pushOff, 4);
  assert.ok(rep.people.every((p) => p.traccar === 'none'));
  assert.ok(Array.isArray(rep.staff));
});

test('Traccar: segnali anche prima del via, verifica con la prova a schermo spento, avviso se smette', () => {
  const F = require('../src/field');
  const g = setupGame(2);
  const pl = q.get('SELECT * FROM players WHERE gameId = ? AND teamId IS NOT NULL LIMIT 1', g.id);
  const info = F.trackingInfo(pl);
  assert.equal(info.state, 'none');
  const since = Date.now() - 60000;
  // Prima del via: il segnale conta per la verifica (senza salvare la posizione).
  F.recordTraccar({ id: info.deviceId, lat: '45.1', lon: '9.1', accuracy: '6' }, {});
  assert.throws(() => F.verifyTracking(pl, since), /un solo segnale/);
  F.recordTraccar({ id: info.deviceId, lat: '45.1', lon: '9.1', accuracy: '5' }, {});
  assert.equal(F.trackingInfo(pl, since).test.pings, 2);
  assert.throws(() => F.verifyTracking(pl, Date.now() - 5000), /45 secondi/);
  const ok = F.verifyTracking(pl, since);
  assert.equal(ok.state, 'ok');
  assert.ok(ok.verifiedAt);
  // Identificativo sconosciuto: ignorato; prova scaduta: rifiutata.
  assert.equal(F.recordTraccar({ id: 'nessuno', lat: '45', lon: '9' }, {}).ok, false);
  assert.throws(() => F.verifyTracking(pl, Date.now() - 3600000), /scaduta/);
  // Partita pronta (si parte a breve): senza un segnale negli ultimi 3 minuti compare «accendi Traccar»;
  // il primo segnale lo toglie.
  G.control(g.id, 'ready', 'test');
  q.run('UPDATE players SET trackSeenAt = ? WHERE id = ?', Date.now() - 11 * 60000, pl.id);
  const fresh = () => F.trackingStatus(q.get('SELECT * FROM players WHERE id = ?', pl.id));
  assert.deepEqual([fresh().prompt, fresh().state, fresh().soon], [true, 'off', true]);
  F.recordTraccar({ id: info.deviceId, lat: '45.1', lon: '9.1' }, {});
  // L'identificativo non cambia dopo la verifica.
  assert.equal(q.get('SELECT trackToken FROM players WHERE id = ?', pl.id).trackToken, info.deviceId);
  assert.deepEqual([fresh().prompt, fresh().state], [false, 'ok']);
  // Chi non l'ha mai configurato: avviso con la procedura guidata.
  const other = q.get('SELECT * FROM players WHERE gameId = ? AND teamId IS NOT NULL AND id != ? LIMIT 1', g.id, pl.id);
  assert.deepEqual([F.trackingStatus(other).prompt, F.trackingStatus(other).state], [true, 'none']);
  // A partita in corso, nessun segnale da più di 10 minuti: l'avviso torna.
  for (const a of ['circle', 'start']) G.control(g.id, a, 'test');
  q.run('UPDATE players SET trackSeenAt = ? WHERE id = ?', Date.now() - 11 * 60000, pl.id);
  assert.equal(F.trackingStatus(q.get('SELECT * FROM players WHERE id = ?', pl.id)).state, 'stale');
});

test('partita finita: in test riparte da capo, in produzione no', () => {
  const g = setupGame(3);
  const [A] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  for (const a of ['ready', 'circle', 'start']) G.control(g.id, a, 'test');
  const p = pointOf(g.id, A.sectorId);
  scanUnlock(A, p.qrToken, codeOf(g.id, A.sectorId));
  G.revealNext(g.id, 'test');
  G.control(g.id, 'end', 'test');
  assert.throws(() => G.control(g.id, 'restart', 'test'), /ambiente di test/);
  process.env.ZDG_ENV = 'test';
  try { G.control(g.id, 'restart', 'test'); } finally { delete process.env.ZDG_ENV; }
  const g2 = G.getGame(g.id);
  assert.deepEqual([g2.status, g2.startedAt, g2.endedAt], ['ready', null, null]);
  assert.equal(q.get('SELECT COUNT(*) AS n FROM team_fragments WHERE teamId = ?', A.id).n, 0);
  assert.equal(q.get('SELECT COUNT(*) AS n FROM team_visits WHERE teamId = ?', A.id).n, 0);
  assert.equal(q.get("SELECT COUNT(*) AS n FROM revelations WHERE gameId = ? AND status != 'scheduled'", g.id).n, 0);
  assert.equal(q.get('SELECT COUNT(*) AS n FROM announcements WHERE gameId = ?', g.id).n, 0);
  assert.ok(q.get('SELECT COUNT(*) AS n FROM fragments WHERE gameId = ?', g.id).n > 0);
  // Si rigioca: cerchio, via.
  for (const a of ['circle', 'start']) G.control(g.id, a, 'test');
  assert.equal(G.getGame(g.id).status, 'truce');
  // In test, tornando in preparazione il gioco è di nuovo pulito: niente emergenze, frammenti, annunci.
  scanUnlock(A, p.qrToken, codeOf(g.id, A.sectorId));
  q.run("INSERT INTO emergencies (gameId, teamId, who, source, createdAt) VALUES (?, ?, 'x', 'app', ?)", g.id, A.id, Date.now());
  G.control(g.id, 'end', 'test');
  process.env.ZDG_ENV = 'test';
  try { G.control(g.id, 'restart', 'test'); q.run('INSERT INTO emergencies (gameId, teamId, who, source, createdAt) VALUES (?, ?, \'x\', \'app\', ?)', g.id, A.id, Date.now()); G.control(g.id, 'draft', 'test'); } finally { delete process.env.ZDG_ENV; }
  assert.equal(G.getGame(g.id).status, 'draft');
  assert.equal(q.get('SELECT COUNT(*) AS n FROM emergencies WHERE gameId = ?', g.id).n, 0);
  assert.equal(q.get('SELECT COUNT(*) AS n FROM team_fragments WHERE teamId = ?', A.id).n, 0);
});

test('punti di interesse: creati dal campo, modificati, nel KMZ, usati come posizione', () => {
  const F = require('../src/field');
  const g = setupGame(2);
  assert.throws(() => F.createPoi(g.id, { label: '', lat: 45, lng: 9 }, 'regia'), /nome/);
  assert.throws(() => F.createPoi(g.id, { label: 'X', lat: 'a', lng: 9 }, 'regia'), /Posizione/);
  const p = F.createPoi(g.id, { label: 'Radura dei castagni', description: 'Ingresso dal sentiero nord', lat: 45.123, lng: 9.456, acc: 6 }, 'eletti:Uno');
  assert.deepEqual([p.label, p.description, p.accuracy], ['Radura dei castagni', 'Ingresso dal sentiero nord', 6]);
  const u = F.updatePoi(p.id, g.id, { description: '' }, 'regia');
  assert.deepEqual([u.label, u.description, u.lat], ['Radura dei castagni', null, 45.123]);
  assert.equal(F.fieldState(g.id).pois.length, 1);
  // Nel KMZ per ATAK c'è la cartella dei punti di interesse.
  const zlib = require('zlib');
  const { data } = F.orgKmz(g.id);
  const kml = zlib.inflateRawSync(data.subarray(30 + data.readUInt16LE(26), 30 + data.readUInt16LE(26) + data.readUInt32LE(18))).toString();
  assert.match(kml, /Punti di interesse/);
  assert.match(kml, /Radura dei castagni/);
  // Piazzare un Altare sulla coordinata del punto (posizione «manuale»).
  const pt = q.get('SELECT * FROM points WHERE gameId = ? LIMIT 1', g.id);
  F.placePoint(pt.id, g.id, { lat: u.lat, lng: u.lng, source: 'manual', provisional: true }, 'regia');
  assert.equal(q.get('SELECT lat FROM points WHERE id = ?', pt.id).lat, 45.123);
  // Solo i punti della propria partita.
  assert.throws(() => F.deletePoi(p.id, g.id + 999, 'regia'), /non trovato/);
  F.deletePoi(p.id, g.id, 'regia');
  assert.equal(F.fieldState(g.id).pois.length, 0);
});

test('piazzamento provvisorio: senza foto, segnato in mappa, confermato dal piazzamento normale', () => {
  const F = require('../src/field');
  const g = setupGame(2);
  const p = q.get('SELECT * FROM points WHERE gameId = ? LIMIT 1', g.id);
  const r = F.placePoint(p.id, g.id, { lat: 45.4, lng: 9.4, acc: 6, provisional: true }, 'eletti:Uno');
  assert.equal(r.provisional, true);
  let st = F.fieldState(g.id).points.find((x) => x.id === p.id);
  assert.deepEqual([st.provisional, st.lat, st.hasPhoto], [true, 45.4, false]);
  // Conferma con cartello e foto: non è più provvisorio.
  F.placePoint(p.id, g.id, { buffer: Buffer.from([0xff, 0xd8]), mime: 'image/jpeg', lat: 45.41, lng: 9.4, acc: 4 }, 'eletti:Uno');
  st = F.fieldState(g.id).points.find((x) => x.id === p.id);
  assert.deepEqual([st.provisional, st.hasPhoto], [false, true]);
  // Dono «appena piazzato»: provvisorio non viene annunciato.
  const { ids: [gid] } = F.createGifts(g.id, { typeId: 'archivio', count: 1, revealMode: 'onplace' }, 'test');
  for (const a of ['ready', 'circle', 'start']) G.control(g.id, a, 'test');
  assert.equal(F.placeGift(gid, g.id, { lat: 45, lng: 9, provisional: true }, 'eletti:Uno').revealed, false);
  assert.equal(F.fieldState(g.id).gifts.find((x) => x.id === gid).provisional, true);
  assert.equal(q.get('SELECT status FROM gifts WHERE id = ?', gid).status, 'placed');
  const soglia = F.fieldState(g.id).landmarks.find((l) => l.kind === 'soglia');
  F.placeLandmark(soglia.id, g.id, { lat: 45.3, lng: 9.3, acc: 4, provisional: true }, 'eletti:Uno');
  assert.equal(F.fieldState(g.id).landmarks.find((l) => l.kind === 'soglia').provisional, true);
});

test('doni: incarico alla squadra e annuncio programmato a un orario', () => {
  const F = require('../src/field');
  const g = setupGame(2);
  const { id: nord } = F.createSquad(g.id, { name: 'Nord' }, 'test');
  const { ids: [gid] } = F.createGifts(g.id, { typeId: 'archivio', count: 1, squadId: nord }, 'test');
  assert.equal(q.get('SELECT squadId FROM gifts WHERE id = ?', gid).squadId, nord);
  // Programmato prima del piazzamento: compare solo dopo che è piazzato e a partita in corso.
  F.scheduleGiftReveal(gid, { mode: 'at', at: Date.now() + 1000 }, 'test');
  assert.throws(() => F.scheduleGiftReveal(gid, { mode: 'at', at: Date.now() - 3600000 }, 'test'), /Orario/);
  F.placeGift(gid, g.id, { buffer: Buffer.from([0xff, 0xd8]), mime: 'image/jpeg', lat: 45, lng: 9 }, 'eletti:Uno', nord);
  for (const a of ['ready', 'circle', 'start']) G.control(g.id, a, 'test');
  q.run('UPDATE gifts SET revealAt = ? WHERE id = ?', Date.now() - 10, gid);
  F.tickAll();
  assert.equal(q.get('SELECT status FROM gifts WHERE id = ?', gid).status, 'revealed');
  // "Ora" su un dono non piazzato: compare appena piazzato; annullare riporta all'annuncio manuale.
  const { ids: [g2] } = F.createGifts(g.id, { typeId: 'taglia', count: 1 }, 'test');
  F.scheduleGiftReveal(g2, { mode: 'now' }, 'test');
  assert.equal(q.get('SELECT revealMode FROM gifts WHERE id = ?', g2).revealMode, 'onplace');
  F.scheduleGiftReveal(g2, { mode: 'cancel' }, 'test');
  assert.equal(q.get('SELECT revealMode FROM gifts WHERE id = ?', g2).revealMode, 'manual');
});

test('armamenti: finestra con durata, prolunga, chiusura automatica e apertura a un orario', () => {
  const g = setupGame(2);
  for (const a of ['ready', 'circle', 'start']) G.control(g.id, a, 'test');
  const id = G.saveSupply(g.id, { scheduledMin: 1, durationMin: 10, description: 'BB' }, 'test');
  G.shiftSupply(id, -1, 'test'); // anticipata al minuto 0
  G.tickAll();
  let s = q.get('SELECT * FROM supply_drops WHERE id = ?', id);
  assert.equal(s.status, 'fired');
  assert.ok(Math.abs(s.closesAt - (Date.now() + 600000)) < 5000);
  const [A] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  assert.equal(G.teamState(A).supplyOpen.length, 1);
  G.shiftSupply(id, 5, 'test');
  assert.ok(q.get('SELECT closesAt FROM supply_drops WHERE id = ?', id).closesAt > s.closesAt + 290000);
  q.run('UPDATE supply_drops SET closesAt = ? WHERE id = ?', Date.now() - 1, id);
  G.tickAll();
  s = q.get('SELECT * FROM supply_drops WHERE id = ?', id);
  assert.equal(s.status, 'closed');
  assert.ok(q.get("SELECT 1 FROM announcements WHERE gameId = ? AND type = 'supply_end'", g.id));
  assert.equal(G.teamState(A).supplyOpen.length, 0);
  // Apertura a un orario preciso.
  const id2 = G.saveSupply(g.id, { scheduledAt: Date.now() + 60000, durationMin: 5 }, 'test');
  q.run('UPDATE supply_drops SET scheduledAt = ? WHERE id = ?', Date.now() - 1, id2);
  G.tickAll();
  assert.equal(q.get('SELECT status FROM supply_drops WHERE id = ?', id2).status, 'fired');
  G.closeSupply(id2, 'test');
  assert.throws(() => G.closeSupply(id2, 'test'), /non è aperta/);
});

test('messaggi: tutti gli Eletti o una sola squadra', () => {
  const F = require('../src/field');
  const g = setupGame(2);
  const e1 = G.addElectPerson(g.id, { name: 'Uno' }, 'test');
  const e2 = G.addElectPerson(g.id, { name: 'Due' }, 'test');
  const { id: nord } = F.createSquad(g.id, { name: 'Nord' }, 'test');
  F.setMemberSquad(e1, nord, 'test');
  const elect = G.electOf(g.id);
  G.postMessage(elect, 'master', 'a tutti', 'regia');
  G.postMessage(elect, 'master', 'solo Nord', 'regia', null, nord);
  G.postMessage(elect, 'team', 'ricevuto', 'Uno', null, nord);
  const pl = (id) => q.get('SELECT * FROM players WHERE id = ?', id);
  assert.deepEqual(G.teamState(elect, pl(e1)).messages.map((m) => m.text), ['a tutti', 'solo Nord', 'ricevuto']);
  assert.deepEqual(G.teamState(elect, pl(e2)).messages.map((m) => m.text), ['a tutti']);
  const ms = G.masterState(g.id);
  assert.equal(ms.squads.find((s) => s.id === nord).unread, 1);
  assert.equal(ms.elect.unread, 0);
  G.markRead(elect.id, nord);
  assert.equal(G.masterState(g.id).squads.find((s) => s.id === nord).unread, 0);
});

test('account: registrazione, accesso, iscrizione come Legati con codice coppia, Temerario o Eletto', () => {
  const A = require('../src/accounts');
  const g = G.createGame({ name: 'Account', registrationOpen: true }, 'test');
  assert.throws(() => A.register({ username: 'x', password: 'lunga-abbastanza', name: 'X', softairTeam: 'ZDT' }), /Username/);
  assert.throws(() => A.register({ username: 'mario', password: 'corta', name: 'Mario', softairTeam: 'ZDT' }), /8 caratteri/);
  assert.throws(() => A.register({ username: 'mario', password: 'password1', name: 'Mario' }), /softair/);
  assert.throws(() => A.register({ username: 'VAL', password: 'password1', name: 'Finto', softairTeam: 'ZDT' }), /già in uso/); // come un account della regia
  const mario = A.register({ username: 'Mario.Rossi', password: 'password1', name: 'Mario Rossi', softairTeam: 'Lupi', nickname: 'Orso' });
  assert.equal(mario.username, 'mario.rossi');
  assert.equal(A.authenticate('MARIO.ROSSI', 'password1').id, mario.id);
  assert.equal(A.authenticate('mario.rossi', 'sbagliata'), null);
  assert.equal(A.currentPlayer(mario), undefined);
  // Coppia: il primo riceve il codice, il secondo si unisce con il codice.
  const r1 = A.enroll(mario, { gameId: g.id, mode: 'pair', teamName: 'Ombre' });
  assert.ok(r1.pairCode);
  assert.throws(() => A.enroll(mario, { gameId: g.id, mode: 'single' }), /già iscritto/);
  const luca = A.register({ username: 'luca', password: 'password2', name: 'Luca Bianchi', softairTeam: 'Lupi' });
  assert.throws(() => A.enroll(luca, { gameId: g.id, mode: 'pair', pairCode: 'NOPE99' }), /non trovato/);
  const r2 = A.enroll(luca, { gameId: g.id, mode: 'pair', pairCode: r1.pairCode.toLowerCase() });
  assert.equal(r2.partner, 'Mario Rossi');
  const anna = A.register({ username: 'anna', password: 'password3', name: 'Anna', softairTeam: 'nessuno' });
  assert.throws(() => A.enroll(anna, { gameId: g.id, mode: 'pair', pairCode: r1.pairCode }), /completa/);
  A.enroll(anna, { gameId: g.id, mode: 'elect', note: 'radio' });
  const pm = A.currentPlayer(mario);
  const pl = A.currentPlayer(luca);
  assert.equal(pm.regGroup, pl.regGroup);
  assert.equal(pl.requestedTeamName, 'Ombre');
  assert.deepEqual([pm.status, pm.softairTeam, pm.nickname, pm.accountId], ['pending', 'Lupi', 'Orso', mario.id]);
  // Approvati insieme, poi formano la coppia: l'account segue la coppia.
  G.reviewPlayer(pm.id, 'accept', 'test');
  assert.equal(A.currentPlayer(luca).status, 'accepted');
  G.createTeam(g.id, { playerIds: [pm.id, pl.id] }, 'test');
  assert.ok(A.currentPlayer(mario).teamId);
  // Profilo e password.
  A.updateProfile(mario, { nickname: 'Lupo', password: 'nuovapass1', currentPassword: 'password1' });
  assert.equal(A.authenticate('mario.rossi', 'nuovapass1').nickname, 'Lupo');
  assert.equal(q.get('SELECT nickname FROM players WHERE id = ?', pm.id).nickname, 'Lupo');
  assert.throws(() => A.updateProfile(mario, { password: 'altrapass1', currentPassword: 'sbagliata' }), /attuale/);
  A.resetPassword(luca.id, 'resettata1', 'regia');
  assert.ok(A.authenticate('luca', 'resettata1'));
  // Iscrizioni chiuse.
  G.updateGame(g.id, { registrationOpen: false }, 'test');
  const zoe = A.register({ username: 'zoe', password: 'password4', name: 'Zoe', softairTeam: 'ZDT' });
  assert.throws(() => A.enroll(zoe, { gameId: g.id, mode: 'single' }), /chiuse/);
});

test('notifiche: stesso telefono per regia ed Eletto, avviso degli incarichi della squadra', () => {
  const F = require('../src/field');
  const rt = require('../src/realtime');
  const g = setupGame(2);
  const e1 = G.addElectPerson(g.id, { name: 'Telefono condiviso' }, 'test');
  const { id: nord } = F.createSquad(g.id, { name: 'Nord' }, 'test');
  F.setMemberSquad(e1, nord, 'test');
  const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'x', auth: 'y' } };
  rt.saveSubscription(sub, { playerId: e1 });
  q.run("INSERT OR IGNORE INTO users (username, passHash, role, createdAt) VALUES ('regia2', 'x', 'master', 0)");
  const uid = q.get("SELECT id FROM users WHERE username = 'regia2'").id;
  rt.saveSubscription(sub, { userId: uid }); // la regia attiva le notifiche sullo stesso telefono
  const row = q.get('SELECT * FROM push_subs WHERE endpoint = ?', sub.endpoint);
  assert.deepEqual([row.playerId, row.userId], [e1, uid]);
  assert.ok(rt.gameSubs(g.id).some((s) => s.endpoint === sub.endpoint));
  rt.saveSubscription(sub, { playerId: e1 }); // e poi di nuovo l'Eletto
  assert.equal(q.get('SELECT userId FROM push_subs WHERE endpoint = ?', sub.endpoint).userId, uid);
  // Elenco degli incarichi per l'avviso nell'app; la regia vede chi ha le notifiche attive.
  F.createTask(g.id, { squadId: nord, text: 'Presidiate il ponte' }, 'test');
  const elect = G.electOf(g.id);
  const items = F.electSummary(elect, q.get('SELECT * FROM players WHERE id = ?', e1)).items;
  assert.deepEqual(items.map((x) => x.label), ['Presidiate il ponte']);
  assert.equal(G.masterState(g.id).elect.members.find((m) => m.id === e1).pushDevices, 1);
});

test('account: restano dopo aver eliminato la partita; la regia li elimina uno a uno o tutti quelli senza iscrizioni', () => {
  const A = require('../src/accounts');
  const g = G.createGame({ name: 'Da eliminare', registrationOpen: true }, 'test');
  const a1 = A.register({ username: 'orfano1', password: 'password1', name: 'Orfano Uno', softairTeam: 'ZDT' });
  const a2 = A.register({ username: 'orfano2', password: 'password2', name: 'Orfano Due', softairTeam: 'ZDT' });
  const a3 = A.register({ username: 'attivo3', password: 'password3', name: 'Attivo Tre', softairTeam: 'ZDT' });
  A.enroll(a1, { gameId: g.id, mode: 'single' });
  A.enroll(a2, { gameId: g.id, mode: 'single' });
  const g2 = G.createGame({ name: 'Resta', registrationOpen: true }, 'test');
  A.enroll(a3, { gameId: g2.id, mode: 'single' });
  G.deleteGame(g.id, 'test');
  const list = A.listAccounts().filter((a) => ['orfano1', 'orfano2', 'attivo3'].includes(a.username));
  assert.deepEqual(list.map((a) => [a.username, a.enrollments]), [['attivo3', 1], ['orfano1', 0], ['orfano2', 0]]);
  const before = A.listAccounts().length;
  const r = A.deleteOrphanAccounts('test');
  assert.ok(r.deleted >= 2);
  assert.equal(A.authenticate('orfano1', 'password1'), null);
  assert.ok(A.authenticate('attivo3', 'password3'));
  assert.equal(A.listAccounts().length, before - r.deleted);
  // Eliminazione singola: l'iscrizione in attesa sparisce con l'account.
  A.deleteAccount(a3.id, 'test');
  assert.equal(A.authenticate('attivo3', 'password3'), null);
  assert.equal(q.get('SELECT COUNT(*) AS n FROM players WHERE gameId = ?', g2.id).n, 0);
});

test('esfiltrazione con il QR della Soglia e rottura delle alleanze per distanza', () => {
  const K = require('../src/combat');
  const g = setupGame(3);
  const [A, B] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  const token = G.landmarksOf(g.id).find((l) => l.kind === 'soglia').exitToken;
  assert.ok(token);
  assert.throws(() => G.exfiltrate(A, 'sbagliato'), /codice di uscita/);
  // Parola intera ad A.
  for (const f of q.all('SELECT id FROM fragments WHERE gameId = ?', g.id)) {
    q.run("INSERT OR IGNORE INTO team_fragments (teamId, fragmentId, source, acquiredAt) VALUES (?, ?, 'altar', ?)", A.id, f.id, Date.now());
  }
  // In alleanza non si esce.
  K.respondRequest(B, K.requestAlliance(A, B.id).id, true);
  const denied = G.exfiltrate(A, token);
  assert.equal(denied.exfiltrated, false);
  assert.equal(denied.reason, 'alliance');
  assert.deepEqual(denied.allies, [q.get('SELECT name FROM sectors WHERE id = ?', B.sectorId).name]);
  // A e B a ~110 m: dopo più di 5 minuti l'alleanza si rompe da sola.
  const now = Date.now();
  q.run("INSERT INTO positions (deviceId, gameId, teamId, lat, lng, at) VALUES ('dA', ?, ?, 45.0, 9.0, ?)", g.id, A.id, now);
  q.run("INSERT INTO positions (deviceId, gameId, teamId, lat, lng, at) VALUES ('dB', ?, ?, 45.001, 9.0, ?)", g.id, B.id, now);
  K.tickAlliances(now);
  assert.ok(K.allianceOf(A.id));
  q.run('UPDATE positions SET at = ? WHERE gameId = ?', now + 3 * 60000, g.id);
  K.tickAlliances(now + 4 * 60000);
  assert.ok(K.allianceOf(A.id));
  q.run('UPDATE positions SET at = ? WHERE gameId = ?', now + 5 * 60000, g.id);
  K.tickAlliances(now + 5 * 60000 + 1000);
  assert.equal(K.allianceOf(A.id), null);
  assert.equal(K.allianceOf(B.id), null);
  assert.ok(q.get("SELECT 1 FROM event_log WHERE gameId = ? AND type = 'alliance_broken_distance'", g.id));
  assert.ok(K.serverTimers(A.id).some((t) => t.timerId === 'blocco'));
  // B senza la Parola intera: uscita negata.
  const missing = G.exfiltrate(B, token);
  assert.equal(missing.exfiltrated, false);
  assert.equal(missing.reason, 'missing');
  assert.equal(missing.missing, 3);
  // A esce: vittoria e Sigillo rivelato a tutti.
  const out = G.exfiltrate(A, token);
  assert.equal(out.exfiltrated, true);
  assert.equal(out.position, 1);
  assert.equal(out.revealed, true);
  // La Parola completa, in ordine, per la cerimonia alla Soglia.
  assert.ok(out.word.length > 0 && out.word.every(Boolean));
  assert.equal(q.get('SELECT status FROM teams WHERE id = ?', A.id).status, 'won');
  assert.ok(G.revealedCodes(g.id).some((r) => r.sectorId === A.sectorId));
  assert.equal(G.exfiltrate(A, token).already, true);
});

test('Skill e Doni (fase 1): scelta prima del via, ricariche, effetti e posizioni viste solo durante l\'effetto', () => {
  const S = require('../src/skills');
  const F = require('../src/field');
  const g = setupGame(4);
  const [A, B, Cc, D] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  // Scelta: 1 attiva/Ultimate + 1 passiva (configurabile).
  S.chooseSkill(A, 'tracker', true);
  assert.throws(() => S.chooseSkill(A, 'rete', true), /attiva o Ultimate/);
  S.chooseSkill(A, 'allarme', true);
  G.updateGame(g.id, { maxActiveSkills: 2 }, 'test');
  S.chooseSkill(A, 'rete', true);
  S.chooseSkill(B, 'ombra', true);
  S.chooseSkill(B, 'silenzio', true);
  S.chooseSkill(Cc, 'confusione', true);
  S.chooseSkill(Cc, 'memoria_nodo', true);
  S.chooseSkill(D, 'intercettazione', true);
  S.chooseSkill(D, 'presagio', true);
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  assert.throws(() => S.chooseSkill(A, 'occhio', true), /prima del via/);
  // Posizioni: nessuno vede nessuno senza effetti.
  const now = Date.now();
  const put = (t, lat, lng) => q.run('INSERT INTO positions (deviceId, gameId, teamId, lat, lng, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(deviceId) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, at = excluded.at', `dev${t.id}`, g.id, t.id, lat, lng, now);
  put(A, 45, 9); put(B, 45.001, 9); put(Cc, 45.002, 9); put(D, 45.003, 9);
  assert.deepEqual(S.sightingsFor(A), []);
  // Tracker su C: si vede C (Confusione aggiunge una posizione falsa e va in ricarica).
  S.useSkill(A, 'tracker', { teamId: Cc.id });
  assert.throws(() => S.useSkill(A, 'tracker', { teamId: Cc.id }), /ricarica/);
  const seen = S.sightingsFor(A);
  assert.equal(seen.filter((x) => x.teamId === Cc.id).length, 2);
  assert.ok(q.get("SELECT readyAt FROM team_skills WHERE teamId = ? AND skillId = 'confusione'", Cc.id).readyAt > now);
  // Rete: tutte le coppie; B (Silenzio di Vetro) solo come area di 100 m. Ombra nasconde B.
  S.useSkill(A, 'rete');
  const all = S.sightingsFor(A);
  assert.ok(all.some((x) => x.teamId === B.id && x.radius === 50));
  assert.ok(all.some((x) => x.teamId === D.id && x.radius === null));
  S.useSkill(B, 'ombra');
  assert.ok(!S.sightingsFor(A).some((x) => x.teamId === B.id));
  assert.deepEqual(S.sightingsFor(D).filter((x) => x.teamId === A.id), []);
  // Intercettazione: i Settori di cui A conosce il Sigillo.
  const r = S.useSkill(D, 'intercettazione', { teamId: A.id });
  assert.deepEqual(r.intercept.sectors.map((x) => x.sectorId), [A.sectorId]);
  // Doni: Taglia su D (tutti lo vedono), Immunità protegge.
  const gift = (t, typeId) => {
    const type = S.giftById(typeId);
    const id = Number(q.run("INSERT INTO gifts (gameId, typeId, name, label, qrToken, status, claimedByTeamId, claimedAt, createdAt) VALUES (?, ?, ?, 'Dono', ?, 'claimed', ?, ?, ?)", g.id, typeId, type.name, `tok${typeId}${t.id}${Math.random()}`, t.id, now, now).lastInsertRowid);
    return id;
  };
  // Presagio: D prende un dono piazzato ma non ancora annunciato; A (senza Presagio) no.
  const placed = (tok) => q.run("INSERT INTO gifts (gameId, typeId, name, label, qrToken, status, lat, lng, createdAt) VALUES (?, 'taglia', 'Taglia', 'Dono', ?, 'placed', 45, 9, ?)", g.id, tok, now);
  placed('presagio-early');
  assert.throws(() => F.claimGift(A, 'presagio-early'), /non è ancora comparso/);
  assert.equal(F.claimGift(D, 'presagio-early').ok, true);
  assert.equal(q.get("SELECT status, claimedByTeamId FROM gifts WHERE qrToken = 'presagio-early'").claimedByTeamId, D.id);
  F.useGift(Cc, gift(Cc, 'taglia'), { teamId: D.id });
  assert.ok(S.sightingsFor(B).some((x) => x.teamId === D.id));
  F.useGift(A, gift(A, 'scudo'));
  assert.throws(() => F.useGift(B, gift(B, 'furto'), { teamId: A.id }), /Immunità/);
  // Archivio Proibito e Grande Furto: Sigilli nel taccuino.
  const arc = F.useGift(B, gift(B, 'archivio'));
  assert.ok(G.teamState(B).notebook.find((n) => n.sectorId === arc.stolen.sectorId).code);
  const furto = F.useGift(D, gift(D, 'furto'), { teamId: B.id });
  assert.ok([B.sectorId, arc.stolen.sectorId].includes(furto.stolen.sectorId));
  // Sovraccarico: tutte le Skill di A di nuovo pronte. Maestro: una Skill in più.
  F.useGift(A, gift(A, 'sovraccarico'));
  assert.ok(!q.get("SELECT readyAt FROM team_skills WHERE teamId = ? AND skillId = 'tracker'", A.id).readyAt);
  F.useGift(A, gift(A, 'maestro'), { skillId: 'veggenza' });
  // Veggenza: il frammento di un Altare conosciuto (già inquadrato), senza Sigillo e senza tornarci.
  const pB = pointOf(g.id, B.sectorId);
  assert.throws(() => S.useSkill(A, 'veggenza', { pointId: pB.id }), /Altari che conoscete/);
  q.run('INSERT INTO team_visits (teamId, pointId, visitedAt) VALUES (?, ?, ?)', A.id, pB.id, now - 3600000);
  const v = S.useSkill(A, 'veggenza', { pointId: pB.id });
  assert.ok(v.fragment.text);
  // Custode: il Sigillo di B, che D conosce (rubato o no), resta coperto agli altri.
  q.run("INSERT INTO team_skills (teamId, skillId, source, addedAt) VALUES (?, 'custode', 'gift', ?)", B.id, now);
  S.useSkill(B, 'custode', { sectorId: B.sectorId });
  q.run("INSERT INTO team_code_notes (teamId, sectorId, code, correct, addedAt) VALUES (?, ?, ?, 1, ?)", Cc.id, B.sectorId, codeOf(g.id, B.sectorId), now);
  const nb = G.teamState(Cc).notebook.find((n) => n.sectorId === B.sectorId);
  assert.equal(nb.code, null);
  assert.ok(nb.guardedUntil > now);
  assert.ok(G.teamState(B).notebook.find((n) => n.sectorId === B.sectorId).code);
  // Memoria del Nodo: la scansione di C vale il doppio.
  const pA = pointOf(g.id, A.sectorId);
  const vis = G.visitPoint(Cc, pA.qrToken);
  assert.equal(vis.expiresAt - vis.visitedAt, 2 * G.getGame(g.id).altarScanMin * 60000);
  // Segugio: D segue C; quando C sblocca un Altare D viene avvisato e il Segugio finisce.
  q.run("INSERT INTO team_skills (teamId, skillId, source, addedAt) VALUES (?, 'segugio', 'gift', ?)", D.id, now);
  S.useSkill(D, 'segugio', { teamId: Cc.id });
  scanUnlock(Cc, pA.qrToken, codeOf(g.id, A.sectorId));
  assert.ok(q.get("SELECT endedAt, data FROM skill_effects WHERE teamId = ? AND code = 'segugio'", D.id).endedAt);
  // Tick: notifiche ritardate e fine degli effetti.
  S.tickAll(now + 60 * 60000);
  assert.deepEqual(S.sightingsFor(A, now + 60 * 60000), []);
  assert.equal(q.get('SELECT COUNT(*) AS n FROM skill_effects WHERE gameId = ? AND endedAt IS NULL AND endsAt IS NOT NULL', g.id).n, 0);
});

test('Skill negli scontri e nelle alleanze (fase 2): Maestria, Immunità, Reliquia, Velenoso, Diplomatico, Veglia Forzata, Ritirata', () => {
  const S = require('../src/skills');
  const K = require('../src/combat');
  const F = require('../src/field');
  const g = setupGame(5);
  const [A, B, Cc, D, E] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  G.updateGame(g.id, { maxActiveSkills: 2 }, 'test');
  S.chooseSkill(A, 'maestria', true); S.chooseSkill(A, 'velenoso', true); S.chooseSkill(A, 'veglia_forzata', true);
  S.chooseSkill(B, 'immunita', true); S.chooseSkill(B, 'diplomatico', true); S.chooseSkill(B, 'ritirata', true);
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  advanceTo(g.id, 6);
  const known = (t, s) => G.teamState(t).notebook.find((n) => n.sectorId === s.sectorId)?.code;
  const timer = (t, id) => q.get('SELECT * FROM team_timers WHERE teamId = ? AND timerId = ? ORDER BY id DESC LIMIT 1', t.id, id);
  // Maestria: A dichiara PERSO contro C ma usa la Skill → vince A; C fa la Veglia Forzata (4 minuti).
  // C vede un normale «perso» da confermare, senza sapere della Maestria; confermando, lo scontro si ribalta.
  const m = K.reportEngagement(A, Cc.id, 'lost', { skill: 'maestria' });
  assert.equal(m.status, 'pending');
  const ask = K.combatState(Cc).toConfirm.find((x) => x.id === m.id);
  assert.equal(ask.result, 'lost');
  assert.equal(ask.skill, null);
  assert.ok(!known(A, Cc));
  assert.equal(K.respondEngagement(Cc, m.id, true).flipped, true);
  assert.match(timer(Cc, 'veglia').reason, /Maestria delle armi/);
  assert.equal(K.combatState(A).victories.find((x) => x.id === m.id).skill, 'maestria');
  assert.equal(known(A, Cc), codeOf(g.id, Cc.sectorId));
  assert.ok(!known(Cc, A));
  assert.equal(timer(Cc, 'veglia').minutes, 4);
  assert.throws(() => K.reportEngagement(A, D.id, 'lost', { skill: 'maestria' }), /ricarica/);
  // Immunità: D dichiara di aver vinto contro B, B conferma con Immunità → D non riceve il Sigillo di B.
  const e = K.reportEngagement(D, B.id, 'won');
  K.respondEngagement(B, e.id, true, { skill: 'immunita' });
  assert.ok(!known(D, B));
  const vic = K.combatState(D).victories[0];
  assert.equal(vic.seals[0].code, null);
  assert.equal(vic.seals[0].hiddenBy, 'Immunità');
  // Reliquia Antica: E perde contro C, il suo Sigillo resta coperto.
  const id = Number(q.run("INSERT INTO gifts (gameId, typeId, name, label, qrToken, status, claimedByTeamId, claimedAt, createdAt) VALUES (?, 'reliquia', 'Reliquia Antica', 'Dono', 'tokrel', 'claimed', ?, ?, ?)", g.id, E.id, Date.now(), Date.now()).lastInsertRowid);
  F.useGift(E, id);
  lose(K, E, Cc);
  assert.ok(!known(Cc, E));
  // Diplomatico: B propone a E usando la Skill → E non riceve il Sigillo di B, B riceve quello di E. Ritirata: 8 minuti.
  const r1 = K.requestAlliance(B, Cc.id);
  K.respondRequest(Cc, r1.id, false);
  assert.equal(timer(B, 'blocco').minutes, 8);
  const r2 = K.requestAlliance(B, E.id, { diplomat: true });
  K.respondRequest(E, r2.id, true);
  assert.ok(!known(E, B));
  assert.equal(known(B, E), codeOf(g.id, E.sectorId));
  // Velenoso: A vince contro E (alleata di B) e rompe l'alleanza B+E.
  q.run('DELETE FROM team_timers WHERE teamId IN (?, ?)', A.id, E.id);
  q.run("UPDATE team_skills SET readyAt = NULL WHERE teamId = ?", A.id);
  lose(K, E, A);
  const eng = K.combatState(A).history[0];
  assert.equal(eng.canPoison, true);
  K.poison(A, eng.id);
  assert.equal(K.allianceOf(B.id), null);
  assert.throws(() => K.poison(A, eng.id), /già stato usato/);
});

test('Skill con gli Eletti (fase 3): Maestro della caccia, Ombra che interrompe la caccia, Alleanze sporche, incarichi con bersaglio', () => {
  const S = require('../src/skills');
  const F = require('../src/field');
  const g = setupGame(3);
  const [A, B, Cc] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  const squad = F.createSquad(g.id, { name: 'Nord' }, 'test');
  const sqId = squad.id ?? q.get('SELECT id FROM elect_squads WHERE gameId = ?', g.id).id;
  G.addElectPerson(g.id, { name: 'Eletto Uno' }, 'test');
  const electPlayer = q.get("SELECT p.id FROM players p JOIN teams t ON t.id = p.teamId WHERE t.gameId = ? AND t.kind = 'elect' LIMIT 1", g.id);
  F.setMemberSquad(electPlayer.id, sqId, 'test');
  G.updateGame(g.id, { maxActiveSkills: 2 }, 'test');
  S.chooseSkill(A, 'caccia', true);
  S.chooseSkill(B, 'ombra', true);
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  const now = Date.now();
  const elect = G.electOf(g.id);
  const put = (dev, teamId, playerId, lat, lng) => q.run('INSERT INTO positions (deviceId, gameId, teamId, playerId, lat, lng, at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(deviceId) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, at = excluded.at', dev, g.id, teamId, playerId, lat, lng, Date.now());
  put(`f3A${g.id}`, A.id, null, 45, 9); put(`f3B${g.id}`, B.id, null, 45.01, 9); put(`f3C${g.id}`, Cc.id, null, 45.02, 9); put(`f3E${g.id}`, elect.id, electPlayer.id, 45.0202, 9);
  // Maestro della caccia: incarico da assegnare; dopo l'assegnazione la squadra vede B, che non lo sa.
  S.useSkill(A, 'caccia', { teamId: B.id });
  const hunt = q.get("SELECT * FROM squad_tasks WHERE gameId = ? AND kind = 'hunt'", g.id);
  assert.equal(hunt.squadId, null);
  assert.equal(F.taskTargetPositions(sqId).length, 0);
  F.assignTask(hunt.id, sqId, 'test');
  assert.equal(F.taskTargetPositions(sqId)[0].teamId, B.id);
  // Ombra: la caccia si interrompe e il bersaglio sparisce.
  S.useSkill(B, 'ombra');
  assert.ok(q.get('SELECT cancelledAt FROM squad_tasks WHERE id = ?', hunt.id).cancelledAt);
  assert.equal(F.taskTargetPositions(sqId).length, 0);
  // Incarico della regia con bersaglio una coppia: la squadra la vede.
  F.createTask(g.id, { squadId: sqId, target: `team:${Cc.id}` }, 'test');
  assert.equal(F.taskTargetPositions(sqId)[0].teamId, Cc.id);
  // Alleanze sporche: la squadra più vicina parte subito, la coppia la vede; vicini → alleati per 30 minuti.
  const gid = Number(q.run("INSERT INTO gifts (gameId, typeId, name, label, qrToken, status, claimedByTeamId, claimedAt, createdAt) VALUES (?, 'sporche', 'Alleanze sporche', 'Dono', 'toksp', 'claimed', ?, ?, ?)", g.id, Cc.id, now, now).lastInsertRowid);
  F.useGift(Cc, gid);
  const meet = q.get("SELECT * FROM squad_tasks WHERE gameId = ? AND kind = 'meet'", g.id);
  assert.equal(meet.squadId, sqId);
  assert.ok(S.sightingsFor(Cc).some((x) => x.kind === 'elect'));
  S.tickAll(Date.now());
  const started = q.get('SELECT * FROM squad_tasks WHERE id = ?', meet.id);
  assert.ok(started.startedAt);
  assert.equal(S.skillsState(Cc).dirty.squadName, 'Nord');
  S.tickAll(started.endsAt + 1000);
  assert.ok(q.get('SELECT doneAt FROM squad_tasks WHERE id = ?', meet.id).doneAt);
  assert.equal(S.skillsState(Cc).dirty, null);
});

test('Traccar: a partita pronta l\'avviso compare e sparisce solo dopo due segnali', () => {
  const F = require('../src/field');
  const g = setupGame(2);
  const p = q.get("SELECT p.* FROM players p JOIN teams t ON t.id = p.teamId WHERE t.gameId = ? AND t.kind = 'couple' LIMIT 1", g.id);
  const info = F.trackingInfo(p);
  assert.equal(F.trackingStatus(q.get('SELECT * FROM players WHERE id = ?', p.id)).prompt, false);
  G.control(g.id, 'ready', 'test');
  const st = () => F.trackingStatus(q.get('SELECT * FROM players WHERE id = ?', p.id));
  assert.equal(st().prompt, true);
  F.recordTraccar({ id: info.deviceId, lat: '45', lon: '9' }, {});
  assert.equal(st().prompt, true);
  assert.equal(st().pings, 1);
  F.recordTraccar({ id: info.deviceId, lat: '45', lon: '9' }, {});
  assert.equal(st().prompt, false);
});

test('effetti nell\'orologio: chi vi osserva (dopo 1 minuto), i vostri effetti, sommati', () => {
  const S = require('../src/skills');
  const g = setupGame(3);
  const [A, B, Cc] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  G.updateGame(g.id, { maxActiveSkills: 2 }, 'test');
  S.chooseSkill(A, 'occhio', true); S.chooseSkill(A, 'rete', true);
  S.chooseSkill(B, 'ombra', true);
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  const put = (t, lat) => q.run('INSERT INTO positions (deviceId, gameId, teamId, lat, lng, at) VALUES (?, ?, ?, ?, 9, ?) ON CONFLICT(deviceId) DO UPDATE SET lat = excluded.lat, at = excluded.at', `ind${t.id}`, g.id, t.id, lat, Date.now());
  put(A, 45); put(B, 45.002); put(Cc, 45.02);
  S.useSkill(A, 'occhio');
  const codes = (t, now) => S.skillsState(t, now).indicators.map((x) => x.code).sort();
  assert.deepEqual(codes(B), []);
  S.tickAll(Date.now() + 61000);
  assert.deepEqual(codes(B, Date.now() + 61000), ['occhio']);
  assert.deepEqual(codes(Cc, Date.now() + 61000), []);
  // Due effetti insieme: Rete del Consiglio e Occhio (dopo l'avviso) si vedono entrambi.
  S.useSkill(A, 'rete');
  S.tickAll(Date.now() + 61000);
  assert.deepEqual(codes(B, Date.now() + 62000), ['occhio', 'rete']);
  assert.deepEqual(codes(Cc, Date.now() + 62000), ['rete']);
  // Ombra: non vi vede più nessuno, nell'orologio resta la vostra Ombra.
  S.useSkill(B, 'ombra');
  assert.deepEqual(codes(B, Date.now() + 62000), ['ombra']);
});

test('caccia degli Eletti: il bersaglio lo sa 1 minuto dopo l\'assegnazione', () => {
  const S = require('../src/skills');
  const F = require('../src/field');
  const g = setupGame(2);
  const [A, B] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  F.createSquad(g.id, { name: 'Sud' }, 'test');
  const sq = q.get('SELECT id FROM elect_squads WHERE gameId = ?', g.id).id;
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  F.createTask(g.id, { squadId: sq, kind: 'hunt', target: `team:${B.id}` }, 'test');
  const codes = (t) => S.skillsState(t).indicators.map((x) => x.code);
  assert.deepEqual(codes(B), []);
  S.tickAll(Date.now() + 61000);
  assert.deepEqual(codes(B), ['caccia']);
  assert.deepEqual(codes(A), []);
});

test('avanzamento del tempo: ricariche ed effetti delle Skill seguono il tempo di gioco', () => {
  process.env.ZDG_ENV = 'test';
  const S = require('../src/skills');
  const g = setupGame(2);
  const [A] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  S.chooseSkill(A, 'ombra', true);
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  advanceTo(g.id, 6);
  S.useSkill(A, 'ombra');
  const ready = () => q.get("SELECT readyAt FROM team_skills WHERE teamId = ? AND skillId = 'ombra'", A.id).readyAt;
  const before = ready();
  G.advanceDemo(g.id, 30, 'test');
  assert.ok(Math.abs(before - ready() - 30 * 60000) < 1000);
  // Ombra durava 15 minuti: dopo 30 è finita.
  assert.ok(!S.skillsState(A).indicators.some((x) => x.code === 'ombra'));
  delete process.env.ZDG_ENV;
});

test('«Perso» aspetta la conferma di chi ha vinto: niente Veglia né Sigilli prima', () => {
  const K = require('../src/combat');
  const g = setupGame(2);
  const [A, B] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  advanceTo(g.id, 6);
  const r = K.reportEngagement(A, B.id, 'lost');
  assert.equal(r.status, 'pending');
  assert.ok(!K.serverTimers(A.id).some((t) => t.timerId === 'veglia'));
  assert.ok(!G.teamState(B).notebook.find((n) => n.sectorId === A.sectorId).code);
  assert.equal(K.combatState(B).toConfirm.length, 1);
  assert.equal(K.combatState(B).toConfirm[0].result, 'lost');
  assert.throws(() => K.respondEngagement(A, r.id, true), /non trovato/);
  K.respondEngagement(B, r.id, true);
  assert.ok(K.serverTimers(A.id).some((t) => t.timerId === 'veglia'));
  assert.equal(G.teamState(B).notebook.find((n) => n.sectorId === A.sectorId).code, codeOf(g.id, A.sectorId));
});

test('emergenze reali: pulsante dell\'app e SOS di Traccar arrivano alla regia con la posizione', () => {
  const EM = require('../src/emergency');
  const F = require('../src/field');
  const g = setupGame(2);
  const [A] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  const p = q.get('SELECT * FROM players WHERE teamId = ? LIMIT 1', A.id);
  const r = EM.fromApp(A, p, { lat: 45.1, lng: 9.2, acc: 12 });
  assert.equal(r.located, true);
  // Premuto di nuovo: stessa emergenza, posizione aggiornata.
  assert.equal(EM.fromApp(A, p, { lat: 45.2, lng: 9.2 }).id, r.id);
  let list = EM.list(g.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].lat, 45.2);
  assert.match(list[0].who, /Settore/);
  // Gravità e commento: scelti da chi chiama, aggiornabili; una gravità sconosciuta non passa.
  EM.fromApp(A, p, { severity: 'grave', comment: '  caviglia rotta  ' });
  EM.fromApp(A, p, { severity: 'boh' });
  list = EM.list(g.id);
  assert.deepEqual([list[0].severity, list[0].comment], ['grave', 'caviglia rotta']);
  EM.ack(r.id, 'master');
  EM.close(r.id, 'master', 'tutto a posto');
  assert.ok(EM.list(g.id)[0].closedAt);
  // SOS di Traccar (alarm=sos).
  const info = F.trackingInfo(p);
  F.recordTraccar({ id: info.deviceId, lat: '45.3', lon: '9.3', alarm: 'sos' }, {});
  list = EM.list(g.id);
  assert.equal(list.filter((e) => !e.closedAt).length, 1);
  assert.equal(list.find((e) => !e.closedAt).source, 'traccar');
  assert.equal(list.find((e) => !e.closedAt).lat, 45.3);
});

test('Memoria del Nodo: minuti della scansione configurabili per partita', () => {
  const S = require('../src/skills');
  const g = setupGame(2);
  const [A, B] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  G.updateGame(g.id, { altarScanMin: 10, nodeScanMin: 25 }, 'test');
  S.chooseSkill(A, 'memoria_nodo', true);
  assert.match(S.skillsState(A).catalog.find((x) => x.id === 'memoria_nodo').description, /25 minuti invece di 10/);
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  const pB = pointOf(g.id, B.sectorId);
  const v = G.visitPoint(A, pB.qrToken);
  assert.equal(v.expiresAt - v.visitedAt, 25 * 60000);
  const w = G.visitPoint(B, pointOf(g.id, A.sectorId).qrToken);
  assert.equal(w.expiresAt - w.visitedAt, 10 * 60000);
});

test('Occhio del Consiglio: durata e raggio dai parametri della partita (predefinito 10 minuti, 500 m)', () => {
  const S = require('../src/skills');
  const g = setupGame(3);
  const [A, B, Cc] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  assert.equal(G.getGame(g.id).eyeMin, 10);
  G.updateGame(g.id, { eyeMin: 7, eyeRadiusM: 200 }, 'test');
  S.chooseSkill(A, 'occhio', true);
  assert.match(S.skillsState(A).catalog.find((x) => x.id === 'occhio').description, /entro 200 m da voi per 7 minuti/);
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  const put = (t, lat) => q.run('INSERT INTO positions (deviceId, gameId, teamId, lat, lng, at) VALUES (?, ?, ?, ?, 9, ?) ON CONFLICT(deviceId) DO UPDATE SET lat = excluded.lat, at = excluded.at', `eye${g.id}-${t.id}`, g.id, t.id, lat, Date.now());
  put(A, 45); put(B, 45.0015); put(Cc, 45.003); // B a ~170 m, C a ~330 m
  S.useSkill(A, 'occhio');
  const seen = S.sightingsFor(A).map((x) => x.teamId);
  assert.ok(seen.includes(B.id));
  assert.ok(!seen.includes(Cc.id));
  const e = q.get("SELECT * FROM skill_effects WHERE teamId = ? AND code = 'occhio'", A.id);
  assert.ok(Math.abs(e.endsAt - e.startedAt - 7 * 60000) < 1000);
});

test('Custode: finché il Sigillo è protetto il suo Altare non si apre, nemmeno scrivendolo', () => {
  const S = require('../src/skills');
  const g = setupGame(2);
  const [A, B] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  S.chooseSkill(B, 'custode', true);
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  S.useSkill(B, 'custode', { sectorId: B.sectorId });
  const pB = pointOf(g.id, B.sectorId);
  const r = scanUnlock(A, pB.qrToken, codeOf(g.id, B.sectorId));
  assert.equal(r.ok, false);
  assert.equal(r.guarded, true);
  assert.ok(G.teamState(A).visited.find((v) => v.qrToken === pB.qrToken).guardedUntil);
  // Finita la protezione si apre.
  q.run("UPDATE skill_effects SET endsAt = ? WHERE code = 'custode' AND teamId = ?", Date.now() - 1000, B.id);
  assert.equal(scanUnlock(A, pB.qrToken, codeOf(g.id, B.sectorId)).ok, true);
});

test('rompere un\'alleanza a più di 50 m non chiede conferma, anche allontanandosi dopo la richiesta', () => {
  const K = require('../src/combat');
  const g = setupGame(3);
  const [A, B, C] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  q.run("UPDATE games SET status = 'hunt' WHERE id = ?", g.id);
  const put = (t, lat) => q.run('INSERT INTO positions (deviceId, gameId, teamId, lat, lng, at) VALUES (?, ?, ?, ?, 9, ?) ON CONFLICT(deviceId) DO UPDATE SET lat = excluded.lat, at = excluded.at', `brk${g.id}-${t.id}`, g.id, t.id, lat, Date.now());
  // Già lontani (~110 m): rotta subito.
  K.respondRequest(B, K.requestAlliance(A, B.id).id, true);
  put(A, 45.0); put(B, 45.001);
  assert.equal(K.requestBreak(A, B.id).broken, true);
  assert.equal(K.allianceOf(A.id), null);
  assert.ok(K.serverTimers(B.id).some((t) => t.timerId === 'blocco'));
  // Vicini (~10 m): serve la conferma; poi chi l'ha chiesta si allontana e si rompe da sola.
  put(C, 45.0001);
  K.respondRequest(C, K.requestAlliance(A, C.id).id, true);
  const r = K.requestBreak(A, C.id);
  assert.ok(!r.broken && r.id);
  K.tickAlliances();
  assert.ok(K.allianceOf(A.id));
  put(A, 45.0008);
  K.tickAlliances();
  assert.equal(K.allianceOf(A.id), null);
  assert.equal(q.get('SELECT status FROM alliance_requests WHERE id = ?', r.id).status, 'accepted');
});

test('Privilegio del Cuore: la notifica degli armamenti arriva prima, e alla chiusura un avviso per i 5 minuti in più', () => {
  const S = require('../src/skills');
  const g = setupGame(3);
  const [A, B] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  S.chooseSkill(A, 'privilegio', true);
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  q.run("INSERT INTO supply_drops (gameId, scheduledMin, status, description) VALUES (?, 20, 'scheduled', 'Prova')", g.id);
  const drop = q.get('SELECT id FROM supply_drops WHERE gameId = ? ORDER BY id DESC', g.id).id;
  const sent = (t, kind) => q.get('SELECT COUNT(*) AS n FROM privilege_notices WHERE teamId = ? AND dropId = ? AND kind = ?', t.id, drop, kind).n;
  advanceTo(g.id, 10);
  S.tickAll();
  assert.equal(sent(A, 'early'), 0);
  advanceTo(g.id, 16);
  S.tickAll(); S.tickAll();
  assert.equal(sent(A, 'early'), 1);
  assert.equal(sent(B, 'early'), 0);
  G.fireSupply(drop, 'test');
  G.closeSupply(drop, 'test');
  S.tickAll();
  assert.equal(sent(A, 'late'), 1);
});

test('doni: ritardo all\'annuncio (compare N minuti dopo l\'annuncio) e cartello da rimuovere o no', () => {
  const F = require('../src/field');
  const g = setupGame(3);
  const { ids: [a] } = F.createGifts(g.id, { typeId: 'archivio', count: 1, revealDelayMin: 7, removeSign: false }, 'test');
  const { ids: [b] } = F.createGifts(g.id, { typeId: 'archivio', count: 1 }, 'test');
  const row = (id) => q.get('SELECT * FROM gifts WHERE id = ?', id);
  assert.equal(row(a).removeSign, 0);
  assert.equal(row(b).removeSign, 1);
  const before = Date.now();
  assert.equal(F.scheduleGiftReveal(a, { mode: 'now' }, 'test').revealed, false);
  assert.equal(row(a).revealMode, 'at');
  assert.ok(row(a).revealAt >= before + 7 * 60000 && row(a).revealAt <= Date.now() + 7 * 60000);
  assert.throws(() => F.createGifts(g.id, { typeId: 'archivio', revealDelayMin: -1 }, 'test'), /Ritardo/);
});

test('doni: «resta attivo» lo prende ogni coppia una volta; chi rilegge un dono lo trova scaduto', () => {
  const F = require('../src/field');
  const g = setupGame(3);
  const [A, B] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  const type = F.giftTypes()[0];
  const { ids: [multi, single] } = F.createGifts(g.id, { typeId: type.id, count: 2, revealMode: 'onplace' }, 'test');
  q.run('UPDATE gifts SET multi = 1 WHERE id = ?', multi);
  const photo = { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mime: 'image/jpeg', lat: 45.1, lng: 9.2, acc: 8 };
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  advanceTo(g.id, 6);
  F.placeGift(multi, g.id, photo, 'eletto');
  F.placeGift(single, g.id, photo, 'eletto');
  const tok = (id) => q.get('SELECT qrToken FROM gifts WHERE id = ?', id).qrToken;
  assert.equal(F.claimGift(A, tok(multi)).gift.name, type.name);
  assert.throws(() => F.claimGift(A, tok(multi)), /Dono scaduto: l'avete già preso/);
  assert.equal(F.claimGift(B, tok(multi)).gift.name, type.name);
  assert.equal(q.get('SELECT status FROM gifts WHERE id = ?', multi).status, 'revealed');
  assert.equal(F.teamMap(A).gifts.some((x) => x.id === multi), true);
  F.claimGift(A, tok(single));
  assert.throws(() => F.claimGift(A, tok(single)), /Dono scaduto/);
  assert.throws(() => F.claimGift(B, tok(single)), /Dono scaduto: l'ha già preso/);
});

test('regia: testi e tempi di Skill e Doni modificabili in preparazione, poi bloccati e usati nel gioco', () => {
  const S = require('../src/skills');
  const F = require('../src/field');
  const g = setupGame(3);
  const [A] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  S.editCatalog(g.id, 'skill', 'ombra', { name: 'Ombra Lunga', description: 'Sparite per 25 minuti.', durationMin: 25, cooldownMin: 50 }, 'test');
  S.editCatalog(g.id, 'gift', 'scudo', { name: 'Scudo d\'oro', durationMin: 5 }, 'test');
  const cat = S.editableCatalog(g.id);
  assert.equal(cat.editable, true);
  assert.equal(cat.skills.find((x) => x.id === 'ombra').current.name, 'Ombra Lunga');
  assert.equal(F.giftTypes(G.getGame(g.id)).find((x) => x.id === 'scudo').name, 'Scudo d\'oro');
  // Tag nelle descrizioni: la regia vede {durata}, le coppie il numero della partita.
  S.editCatalog(g.id, 'skill', 'tracker', { durationMin: 7 }, 'test');
  const tr = S.editableCatalog(g.id).skills.find((x) => x.id === 'tracker');
  assert.match(tr.current.description, /\{durata\} minuti/);
  assert.match(tr.preview, /per 7 minuti/);
  assert.ok(tr.tags.some((t) => t.tag === '{durata}' && t.value === 7));
  assert.match(F.giftTypes(G.getGame(g.id)).find((x) => x.id === 'scudo').description, /^Per 5 minuti/);
  // Migrazione: le descrizioni già riscritte a mano prendono i tag (una volta sola).
  q.run("DELETE FROM settings WHERE key = 'catalogTagsV1'");
  assert.equal(S.migrateCatalogTags(), 1);
  const om = S.editableCatalog(g.id).skills.find((x) => x.id === 'ombra');
  assert.equal(om.current.description, 'Sparite per {durata} minuti.');
  assert.equal(om.preview, 'Sparite per 25 minuti.');
  assert.equal(S.migrateCatalogTags(), 0);
  assert.throws(() => S.editCatalog(g.id, 'skill', 'ombra', { durationMin: -3 }, 'test'), /Minuti/);
  S.chooseSkill(A, 'ombra', true);
  G.control(g.id, 'ready', 'test');
  assert.throws(() => S.editCatalog(g.id, 'skill', 'ombra', { name: 'X' }, 'test'), /preparazione/);
  assert.equal(S.editableCatalog(g.id).editable, false);
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  advanceTo(g.id, 6);
  S.useSkill(A, 'ombra', {});
  const e = q.get("SELECT * FROM skill_effects WHERE teamId = ? AND code = 'ombra'", A.id);
  assert.equal(Math.round((e.endsAt - e.startedAt) / 60000), 25);
  const ready = q.get("SELECT readyAt FROM team_skills WHERE teamId = ? AND skillId = 'ombra'", A.id).readyAt;
  assert.ok(Math.abs(ready - Date.now() - 50 * 60000) < 5000);
  assert.equal(S.skillsState(A).mine.find((x) => x.id === 'ombra').name, 'Ombra Lunga');
});

test('ICE: dati facoltativi del profilo, alla regia solo dentro l\'emergenza chiamata dalla persona', () => {
  const A = require('../src/accounts');
  const EM = require('../src/emergency');
  const g = setupGame(3);
  const acc = A.register({ username: `ice${g.id}`, password: 'password1', name: 'Mario Rossi', softairTeam: 'nessuno' });
  A.updateProfile(acc, { iceBlood: '0 Rh+', iceConditions: 'asma', iceContactName: 'Laura', iceContactPhone: '333 1234567' });
  assert.equal(A.publicAccount(q.get('SELECT * FROM accounts WHERE id = ?', acc.id)).ice.blood, '0 Rh+');
  assert.ok(!JSON.stringify(A.listAccounts()).includes('asma'));
  const [T] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  const pid = Number(q.run('INSERT INTO players (gameId, teamId, name, accountId, status, createdAt) VALUES (?, ?, ?, ?, ?, ?)', g.id, T.id, 'Mario Rossi', acc.id, 'accepted', Date.now()).lastInsertRowid);
  const player = q.get('SELECT * FROM players WHERE id = ?', pid);
  EM.fromApp(T, player, { lat: 45, lng: 9 });
  const e = EM.list(g.id)[0];
  assert.equal(e.ice.conditions, 'asma');
  assert.equal(e.ice.contactPhone, '333 1234567');
});

test('avvisi: visti anche da chi si iscrive dopo; sondaggi Sì / No / Forse con risposta modificabile', () => {
  const g = setupGame(3);
  const [T] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  const n = G.createNotice(g.id, { title: 'Pizza dopo i Giochi?', target: 'all', poll: true }, 'test');
  // Iscritto dopo l'avviso, ancora senza Settore: lo vede e risponde.
  const pid = Number(q.run('INSERT INTO players (gameId, name, status, createdAt) VALUES (?, ?, ?, ?)', g.id, 'Tardivo', 'pending', Date.now()).lastInsertRowid);
  const late = q.get('SELECT * FROM players WHERE id = ?', pid);
  const seen = G.lobbyState(late).notices.find((x) => x.id === n.id);
  assert.ok(seen && seen.poll && seen.myVote === null);
  G.voteNotice(null, late, n.id, 'forse');
  G.voteNotice(null, late, n.id, 'si');
  G.voteNotice(T, null, n.id, 'no');
  assert.equal(G.lobbyState(late).notices.find((x) => x.id === n.id).myVote, 'si');
  assert.throws(() => G.voteNotice(T, null, n.id, 'boh'), /Risposta/);
  const res = G.masterState(g.id).notices.find((x) => x.id === n.id).results;
  assert.deepEqual(res.counts, { si: 1, no: 1, forse: 0 });
  const plain = G.createNotice(g.id, { title: 'Solo un avviso' }, 'test');
  assert.throws(() => G.voteNotice(T, null, plain.id, 'si'), /non è un sondaggio/);
});

test('accettazione e test armi: presenza, conferma coppia, armi sotto 1 joule solo per chi è presente', () => {
  const CK = require('../src/checkin');
  const g = setupGame(2);
  const [A] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  const [p1, p2] = q.all('SELECT * FROM players WHERE teamId = ? ORDER BY id', A.id);
  q.run("UPDATE players SET status = 'accepted' WHERE teamId = ?", A.id);
  assert.throws(() => CK.setChrono(g.id, p1.id, 'main', true, 'test'), /accettato/);
  CK.setPlayerCheckin(g.id, p1.id, true, 'test');
  assert.throws(() => CK.setTeamCheckin(g.id, A.id, true, 'test'), /Manca la presenza/);
  CK.setPlayerCheckin(g.id, p2.id, true, 'test');
  CK.setTeamCheckin(g.id, A.id, true, 'test');
  assert.ok(G.masterState(g.id).teams.find((t) => t.id === A.id).checkinAt);
  CK.setChrono(g.id, p1.id, 'main', true, 'test');
  CK.setChrono(g.id, p1.id, 'secondary', true, 'test');
  const row = q.get('SELECT chronoMain, chronoBackup, chronoSecondary FROM players WHERE id = ?', p1.id);
  assert.ok(row.chronoMain && !row.chronoBackup && row.chronoSecondary);
  assert.throws(() => CK.setChrono(g.id, p1.id, 'bazooka', true, 'test'), /Arma non valida/);
  // Tolta la presenza, la coppia torna da confermare.
  CK.setPlayerCheckin(g.id, p2.id, false, 'test');
  assert.equal(q.get('SELECT checkinAt FROM teams WHERE id = ?', A.id).checkinAt, null);
});

test('accettazione: spostare persone tra coppie e squadre di Eletti (anche nuove), le coppie toccate tornano da confermare', () => {
  const CK = require('../src/checkin');
  const g = setupGame(2);
  const [A, B] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  q.run('UPDATE players SET status = \'accepted\' WHERE gameId = ?', g.id);
  const [a1, a2] = q.all('SELECT * FROM players WHERE teamId = ? ORDER BY id', A.id);
  const [b1] = q.all('SELECT * FROM players WHERE teamId = ? ORDER BY id', B.id);
  for (const p of q.all('SELECT id FROM players WHERE teamId = ?', A.id)) CK.setPlayerCheckin(g.id, p.id, true, 'test');
  CK.setTeamCheckin(g.id, A.id, true, 'test');
  // Coppia piena: non entra nessuno.
  assert.throws(() => CK.placePlayer(g.id, b1.id, { teamId: A.id }, 'test'), /completa/);
  // a2 non è venuto: va fuori; A torna da confermare e accoglie b1.
  CK.placePlayer(g.id, a2.id, { none: true }, 'test');
  assert.equal(q.get('SELECT checkinAt FROM teams WHERE id = ?', A.id).checkinAt, null);
  CK.placePlayer(g.id, b1.id, { teamId: A.id }, 'test');
  assert.equal(q.get('SELECT teamId FROM players WHERE id = ?', b1.id).teamId, A.id);
  // Nuova squadra di Eletti trascinandoci qualcuno.
  CK.placePlayer(g.id, a2.id, { newSquad: 'Corvi' }, 'test');
  const row = q.get('SELECT p.teamId, s.name FROM players p JOIN elect_squads s ON s.id = p.squadId WHERE p.id = ?', a2.id);
  assert.equal(row.name, 'Corvi');
  assert.equal(row.teamId, G.electOf(g.id).id);
  assert.equal(a1.teamId, A.id);
});

test('test armi col cronografo: sotto 1 J spunta e salva la misura, da 1 J in su non passa', () => {
  const CK = require('../src/checkin');
  const g = setupGame(2);
  const [A] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  q.run("UPDATE players SET status = 'accepted' WHERE gameId = ?", g.id);
  const [p] = q.all('SELECT * FROM players WHERE teamId = ? ORDER BY id', A.id);
  CK.setPlayerCheckin(g.id, p.id, true, 'test');
  assert.equal(CK.setChrono(g.id, p.id, 'main', true, 'test', { joule: 0.94, mps: 96.97, grams: 0.2 }).ok, true);
  let row = q.get('SELECT chronoMain, chronoShots FROM players WHERE id = ?', p.id);
  assert.ok(row.chronoMain);
  assert.equal(JSON.parse(row.chronoShots).main.j, 0.94);
  // Ritestata sopra 1 J: torna da provare.
  assert.equal(CK.setChrono(g.id, p.id, 'main', true, 'test', { joule: 1.34, mps: 115.93, grams: 0.2 }).ok, false);
  row = q.get('SELECT chronoMain, chronoShots FROM players WHERE id = ?', p.id);
  assert.equal(row.chronoMain, null);
  assert.equal(JSON.parse(row.chronoShots).main.ok, false);
  // Spunta manuale (cronografo non disponibile): nessuna misura.
  CK.setChrono(g.id, p.id, 'secondary', true, 'test');
  row = q.get('SELECT chronoSecondary, chronoShots FROM players WHERE id = ?', p.id);
  assert.ok(row.chronoSecondary);
  assert.equal(JSON.parse(row.chronoShots).secondary, undefined);
  assert.throws(() => CK.setChrono(g.id, p.id, 'main', true, 'test', { joule: 'x' }), /Misura non valida/);
  // Negativo segnato a mano (senza cronografo): niente spunta, esito «non passa»; azzerando torna da provare.
  assert.equal(CK.setChrono(g.id, p.id, 'backup', true, 'test', null, true).ok, false);
  row = q.get('SELECT chronoBackup, chronoShots FROM players WHERE id = ?', p.id);
  assert.equal(row.chronoBackup, null);
  assert.deepEqual([JSON.parse(row.chronoShots).backup.ok, JSON.parse(row.chronoShots).backup.manual], [false, true]);
  const { eventStatus } = require('../src/eventstatus');
  assert.equal(eventStatus(q.get('SELECT * FROM players WHERE id = ?', p.id)).weapons.backup.failed, true);
  CK.setChrono(g.id, p.id, 'backup', false, 'test');
  assert.equal(JSON.parse(q.get('SELECT chronoShots FROM players WHERE id = ?', p.id).chronoShots).backup, undefined);
});

test("accettazione: a gioco iniziato chi non è stato accettato non partecipa (solo se la regia usa l'accettazione)", () => {
  const CK = require('../src/checkin');
  const g = setupGame(2);
  const [A, B] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  const [a1, a2] = q.all('SELECT * FROM players WHERE teamId = ? ORDER BY id', A.id);
  const [b1] = q.all('SELECT * FROM players WHERE teamId = ? ORDER BY id', B.id);
  G.control(g.id, 'ready', 'test');
  G.control(g.id, 'circle', 'test');
  G.control(g.id, 'start', 'test');
  // Nessuno accettato: la regia non usa l'accettazione, si gioca come sempre.
  assert.equal(G.notAccepted(G.getGame(g.id), b1, B), false);
  CK.setPlayerCheckin(g.id, a1.id, true, 'test');
  assert.equal(G.notAccepted(G.getGame(g.id), a1, A), false);
  assert.equal(G.notAccepted(G.getGame(g.id), a2, A), true);
  assert.equal(G.notAccepted(G.getGame(g.id), b1, B), true);
  // Accesso della coppia (senza persona): basta un accettato nella coppia.
  assert.equal(G.notAccepted(G.getGame(g.id), null, A), false);
  assert.equal(G.notAccepted(G.getGame(g.id), null, B), true);
  assert.equal(G.teamState(B, b1).notAccepted, true);
});

test('test armi: la persona toglie le armi che non ha e ne aggiunge altre (anche più di tre)', () => {
  const CK = require('../src/checkin');
  const ES = require('../src/eventstatus');
  const g = setupGame(2);
  const [A] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  q.run("UPDATE players SET status = 'accepted' WHERE gameId = ?", g.id);
  const [p] = q.all('SELECT * FROM players WHERE teamId = ? ORDER BY id', A.id);
  CK.setPlayerCheckin(g.id, p.id, true, 'test');
  CK.editWeapons(g.id, p.id, { action: 'remove', key: 'backup' }, 'giocatore');
  CK.editWeapons(g.id, p.id, { action: 'add', label: 'Pistola' }, 'giocatore');
  CK.editWeapons(g.id, p.id, { action: 'add', label: 'Secondo fucile' }, 'giocatore');
  let row = q.get('SELECT * FROM players WHERE id = ?', p.id);
  assert.deepEqual(ES.weaponList(row).map((w) => w.label), ['Arma principale', 'Arma secondaria', 'Pistola', 'Secondo fucile']);
  // L'arma aggiunta si prova come le altre e passa.
  assert.equal(CK.setChrono(g.id, p.id, 'w1', true, 'arbitro', { joule: 0.8, mps: 90, grams: 0.2 }).ok, true);
  row = q.get('SELECT * FROM players WHERE id = ?', p.id);
  assert.equal(ES.eventStatus(row).weapons.w1.ok, true);
  // Un'arma già provata non si toglie; quella tolta non si prova più.
  assert.throws(() => CK.editWeapons(g.id, p.id, { action: 'remove', key: 'w1' }, 'giocatore'), /già stata provata/);
  assert.throws(() => CK.setChrono(g.id, p.id, 'backup', true, 'arbitro'), /Arma non valida/);
  assert.throws(() => CK.editWeapons(g.id, p.id, { action: 'add', label: ' ' }, 'giocatore'), /nome/);
  // Rinomina: anche un'arma già provata, che resta con il suo esito.
  CK.editWeapons(g.id, p.id, { action: 'rename', key: 'w1', label: 'Glock 17' }, 'giocatore');
  const w1 = ES.eventStatus(q.get('SELECT * FROM players WHERE id = ?', p.id)).weapons.w1;
  assert.deepEqual([w1.label, w1.ok], ['Glock 17', true]);
});

test('test armi: più letture salvano media e massimo; la persona si chiude e si riapre', () => {
  const CK = require('../src/checkin');
  const g = setupGame(2);
  const [A] = teamsOf(g.id).filter((t) => t.kind === 'couple');
  q.run("UPDATE players SET status = 'accepted' WHERE gameId = ?", g.id);
  const [p] = q.all('SELECT * FROM players WHERE teamId = ? ORDER BY id', A.id);
  CK.setPlayerCheckin(g.id, p.id, true, 'test');
  const readings = [{ j: 0.94, v: 96.97 }, { j: 0.91, v: 95.5 }, { j: 0.96, v: 98.1 }];
  assert.equal(CK.setChrono(g.id, p.id, 'main', true, 'test', { joule: 0.937, mps: 96.86, grams: 0.2, readings }).ok, true);
  const s = JSON.parse(q.get('SELECT chronoShots FROM players WHERE id = ?', p.id).chronoShots).main;
  assert.equal(s.n, 3);
  assert.equal(s.max, 0.96);
  CK.setChronoDone(g.id, p.id, true, 'test');
  assert.ok(q.get('SELECT chronoDoneAt FROM players WHERE id = ?', p.id).chronoDoneAt);
  CK.setChronoDone(g.id, p.id, false, 'test');
  assert.equal(q.get('SELECT chronoDoneAt FROM players WHERE id = ?', p.id).chronoDoneAt, null);
});
