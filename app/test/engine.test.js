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
  G.advanceDemo(id, 30, 'test');
  assert.ok(q.get("SELECT 1 FROM supply_drops WHERE gameId = ? AND status = 'fired'", id));
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
  G.publicRegister({ gameId: g.id, players: [{ name: 'A' }, { name: 'B' }], sectorId: G.sectors()[0].id });
  G.publicRegister({ gameId: g.id, players: [{ name: 'C' }] });
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
  assert.throws(() => G.publicRegister({ gameId: g.id, mode: 'pair', players: [{ name: 'Solo' }] }), /due Legati/);
  G.publicRegister({ gameId: g.id, mode: 'pair', players: [{ name: 'L1' }, { name: 'L2' }] });
  G.publicRegister({ gameId: g.id, mode: 'single', players: [{ name: 'T1' }, { name: 'ignorato' }] });
  G.publicRegister({ gameId: g.id, mode: 'elect', players: [{ name: 'E1', note: 'logistica al Cuore' }] });
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
  const r = G.publicRegister({ gameId: g.id, mode: 'pair', players: [{ name: 'P1' }, { name: 'P2' }] });
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
  K.reportEngagement(Cc, A.id, 'lost');
  assert.equal(known(A, Cc).source, 'won');
  assert.equal(known(B, Cc).code, codeOf(g.id, Cc.sectorId));
  assert.ok(K.serverTimers(Cc.id).some((t) => t.timerId === 'veglia'));
  // D dichiara di aver vinto contro A: serve la conferma degli sconfitti (A e B).
  const e = K.reportEngagement(D, A.id, 'won');
  assert.equal(e.status, 'pending');
  assert.equal(known(D, A).code, null);
  assert.equal(K.combatState(B).toConfirm.length, 1);
  K.respondEngagement(B, e.id, true);
  assert.equal(known(D, A).code, codeOf(g.id, A.sectorId));
  assert.equal(known(D, B).code, codeOf(g.id, B.sectorId));
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
