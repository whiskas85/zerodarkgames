// Accettazione a inizio evento e Test armi: condivisi tra la regia e lo staff (pagina Soglia).
// ctx = { data: { players, teams, elect, squads }, call(method, path, body, okMsg), render() }.
import { h, fmtTime, dialog, toast } from './lib.js';

const section = (title, ...children) => h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, title)), ...children);

let ckFilter = '';
const personLabel = (p) => [p.name, p.nickname ? `«${p.nickname}»` : null].filter(Boolean).join(' ');
// Persone accettate raggruppate per squadra: coppie (per Settore), Eletti (per squadra), chi è ancora senza coppia.
function peopleGroups(ctx, only = () => true, keepEmpty = false) {
  const ms = ctx.data;
  const f = ckFilter.trim().toLowerCase();
  const match = (p) => !f || [p.name, p.nickname, p.username, p.softairTeam].some((x) => String(x || '').toLowerCase().includes(f));
  const people = ms.players.filter((p) => p.status === 'accepted' && only(p));
  const out = ms.teams.filter((t) => t.status !== 'withdrawn').map((t) => ({ team: t, dest: { teamId: t.id }, title: `${t.roman || '—'} · Settore ${t.sectorName || 'da assegnare'}`, sub: t.displayName, people: people.filter((p) => p.teamId === t.id) }));
  const elect = people.filter((p) => p.teamId === ms.elect?.id);
  for (const sq of ms.squads || []) out.push({ dest: { squadId: sq.id }, title: `Eletti · Squadra ${sq.name}`, people: elect.filter((p) => p.squadId === sq.id), color: sq.color });
  out.push({ dest: { elect: true }, title: 'Eletti senza squadra', people: elect.filter((p) => !p.squadId || !(ms.squads || []).some((x) => x.id === p.squadId)) });
  const inTeam = new Set([...ms.teams.map((t) => t.id), ms.elect?.id]);
  out.push({ dest: { none: true }, title: 'Senza coppia', people: people.filter((p) => !inTeam.has(p.teamId)) });
  // All'accettazione restano anche i gruppi vuoti (Settore senza nessuno, squadra nuova): ci si trascina dentro.
  return out.map((g) => ({ ...g, all: g.people, people: g.people.filter(match) })).filter((g) => g.people.length || (keepEmpty && !ckFilter.trim()));
}
const ckSearch = (ctx) => h('input', { class: 'input input-sm', type: 'search', placeholder: 'Cerca per nome, soprannome, team softair…', value: ckFilter, 'data-keep': 'ck-filter', oninput: (e) => { ckFilter = e.target.value; ctx.render(); } });
const ckCount = (n, tot, label) => h('div', { class: 'ck-count' }, h('strong', { class: 'mono' }, `${n}/${tot}`), h('span', { class: 'tiny muted' }, label));

export function viewCheckin(ctx) {
  const ms = ctx.data;
  const accepted = ms.players.filter((p) => p.status === 'accepted');
  const present = accepted.filter((p) => p.checkinAt).length;
  const teamsOk = ms.teams.filter((t) => t.checkinAt).length;
  const pending = ms.players.filter((p) => p.status === 'pending').length;
  const toggle = (p) => ctx.call('POST', (`/checkin/player/${p.id}`), { on: !p.checkinAt }, p.checkinAt ? null : `${p.nickname || p.name}: presente`);
  const teamToggle = async (t) => {
    if (t.checkinAt && !(await dialog({ title: 'Annullare la conferma?', text: `${t.roman} · Settore ${t.sectorName}: la coppia torna da confermare.`, okLabel: 'Annulla conferma' }))) return;
    ctx.call('POST', (`/checkin/team/${t.id}`), { on: !t.checkinAt }, t.checkinAt ? 'Conferma annullata' : 'Coppia confermata');
  };
  return h('div', { class: 'stack' },
    section('Accettazione',
      h('p', { class: 'muted tiny' }, 'All\'arrivo al campo: segna chi è presente, poi conferma la coppia quando ci sono tutti e due. Solo gli iscritti già approvati; chi è presente compare nel Test armi.'),
      h('div', { class: 'ck-counts' }, ckCount(present, accepted.length, 'presenti'), ckCount(teamsOk, ms.teams.length, 'coppie confermate')),
      pending ? h('p', { class: 'small warn-text' }, `${pending} iscrizioni ancora da approvare: le trovi in «Iscrizioni e coppie».`) : null,
      ckSearch(ctx)),
    h('p', { class: 'tiny muted' }, 'Manca qualcuno? Trascina le persone con la maniglia ⠿ da una coppia all\'altra (se ha un posto libero), tra le squadre degli Eletti o su «Nuova squadra di Eletti». La coppia toccata torna da confermare.'),
    h('div', { class: 'ck-grid' }, peopleGroups(ctx, () => true, true).map((g) => {
      const allIn = g.all.length > 0 && g.all.every((p) => p.checkinAt);
      return h('div', { class: `panel ck-group ${g.team?.checkinAt ? 'ck-done' : ''}`, 'data-drop': JSON.stringify(g.dest), style: { '--c': g.team?.color || g.color || 'var(--line)' } },
        h('div', { class: 'ck-head' }, h('strong', null, g.title), g.sub ? h('span', { class: 'tiny muted' }, g.sub) : null),
        g.people.length ? null : h('p', { class: 'ck-empty tiny muted' }, 'Vuota: trascina qui qualcuno'),
        g.people.map((p) => h('div', { class: 'ck-row' }, h('span', { class: 'ck-grip', title: 'Trascina per spostare', 'aria-label': `Sposta ${p.name}`, onpointerdown: (e) => ckDrag(ctx, e, p) }, '⠿'), h('button', { class: `ck-person ${p.checkinAt ? 'on' : ''}`, type: 'button', onclick: () => toggle(p) },
          h('span', { class: 'ck-box', 'aria-hidden': 'true' }, p.checkinAt ? '✓' : ''),
          h('span', { class: 'grow' }, h('strong', null, personLabel(p)), h('span', { class: 'tiny muted' }, [p.username ? `@${p.username}` : null, p.softairTeam].filter(Boolean).join(' · '))),
          h('span', { class: 'tiny' }, p.checkinAt ? `presente ${fmtTime(p.checkinAt)}` : 'presente?')))),
        g.team ? h('button', { class: `btn btn-block ${g.team.checkinAt ? 'btn-ok' : 'btn-primary'}`, type: 'button', disabled: !g.team.checkinAt && !allIn, onclick: () => teamToggle(g.team) },
          g.team.checkinAt ? `✓ Coppia confermata · ${fmtTime(g.team.checkinAt)}` : allIn ? 'Conferma la coppia' : 'Conferma la coppia (manca qualcuno)') : null);
    }),
    // Nuova squadra di Eletti: si crea toccando, oppure trascinandoci sopra qualcuno.
    h('button', { class: 'panel ck-group ck-new', type: 'button', 'data-drop': JSON.stringify({ newSquad: true }), onclick: async () => {
      const name = await dialog({ title: 'Nuova squadra di Eletti', input: { placeholder: 'Nome della squadra' }, okLabel: 'Crea' });
      if (name && name.trim()) ctx.call('POST', ('/squads'), { name: name.trim() }, 'Squadra creata');
    } }, h('strong', null, '＋ Nuova squadra di Eletti'), h('span', { class: 'tiny muted' }, 'Tocca per crearla vuota, o trascina qui una persona'))));
}

// Trascina e rilascia (mouse e dita): dalla maniglia ⠿ fino a un gruppo; al rilascio la persona viene spostata.
function ckDrag(ctx, e, p) {
  e.preventDefault();
  const ghost = h('div', { class: 'ck-ghost' }, `⠿ ${personLabel(p)}`);
  document.body.append(ghost);
  let over = null;
  const at = (x, y) => document.elementsFromPoint(x, y).find((el) => el.dataset?.drop);
  const move = (ev) => {
    ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
    const z = at(ev.clientX, ev.clientY);
    if (z !== over) { over?.classList.remove('ck-over'); over = z; over?.classList.add('ck-over'); }
    // Vicino ai bordi la pagina scorre da sola.
    if (ev.clientY < 60) window.scrollBy(0, -12); else if (ev.clientY > window.innerHeight - 60) window.scrollBy(0, 12);
  };
  const end = async () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    ghost.remove();
    over?.classList.remove('ck-over');
    if (!over) return;
    let dest = JSON.parse(over.dataset.drop);
    if (dest.newSquad) {
      const name = await dialog({ title: 'Nuova squadra di Eletti', text: `${personLabel(p)} entra nella nuova squadra.`, input: { placeholder: 'Nome della squadra' }, okLabel: 'Crea e sposta' });
      if (!name || !name.trim()) return;
      dest = { newSquad: name.trim() };
    }
    ctx.call('POST', (`/place/${p.id}`), dest, `${p.nickname || p.name} spostato`);
  };
  move(e);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

const CHRONO = [['main', 'chronoMain', 'Arma principale'], ['backup', 'chronoBackup', 'Principale di riserva'], ['secondary', 'chronoSecondary', 'Arma secondaria']];
// ---------------------------------------------------------------- cronografo Bluetooth: registrazione dei dati grezzi
// Prima fase: ci si collega al cronografo (Web Bluetooth, Chrome su Android o computer), si ascoltano tutti i canali e si
// registrano i byte di ogni tiro accanto al valore letto sul display. Dal registro esportato si ricava il formato.
const BT = { device: null, server: null, log: [], status: 'Non collegato', panel: null, listEl: null, statusEl: null, liveEl: null, shotsEl: null, manual: false, retries: 0, extra: '' };
// Acetech AC6000-BT: protocollo ricostruito dal progetto open source t1ckrate/ac6000-ble (licenza MIT).
// Dopo il «saluto» (0x4B) il cronografo manda ogni tiro (0x52) con la velocità in cm/s; i joule li calcoliamo noi.
const AC = {
  svcNotify: '5cde0c3d-7b1d-4352-94bb-02269c9f42b5', chNotify: '3337e46e-f79e-4ff5-9a49-77c36d170c62',
  svcWrite: '53c47fe1-6c22-4ea6-99c7-7b6325ec75b9', chWrite: '9c6aa1ee-b4b9-44a1-ba45-1558c9109b4c',
};
const acHello = (token) => { const f = [0xaa, 6, 0x4b, ...token]; return Uint8Array.from([...f, f.reduce((a, b) => a + b, 0) & 0xff]); };
// Peso del pallino letto dal cronografo (slot attivo): byte 7-8 in centesimi di grammo. Il record 0x47 di alcuni
// firmware usa i millesimi (200 = 0,20 g): un pallino non pesa più di 1 g, quindi oltre si divide per 1000.
function acWeight(raw) { const g = raw / 100; return g > 1 ? raw / 1000 : g; }
function setBb(grams, from) {
  if (!(grams > 0 && grams < 1)) return;
  try { localStorage.setItem('zdg_bt_bb', grams.toFixed(2)); } catch { /* */ }
  BT.bbSrc = from;
  btRefresh();
}
const bbGrams = () => { const v = parseFloat(String(localStorage.getItem('zdg_bt_bb') || '0.20').replace(',', '.')); return v > 0 && v < 2 ? v : 0.2; };
// Il browser lascia leggere solo i servizi dichiarati qui: quelli standard, le «seriali BLE» dei moduli più diffusi
// (Nordic, HM-10, Microchip/ISSC, Telink, Dialog, TI, Silabs…) e i codici corti proprietari più usati.
const KNOWN = [AC.svcNotify, AC.svcWrite, 'battery_service', 'device_information', 'generic_access', 'generic_attribute',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', '6e40fff0-b5a3-f393-e0a9-e50e24dcca9e', '49535343-fe7d-4ae5-8fa9-9fafd205e455', '0000d0ff-3c17-d293-8e48-14fe2e4da212',
  '00010203-0405-0607-0809-0a0b0c0d1910', '0783b03e-8535-b5a0-7140-a304d2495cb7', 'f000c0e0-0451-4000-b000-000000000000',
  '1d14d6ee-fd63-4fa1-bfa4-8f47b42119f0', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '0000fff0-0000-1000-8000-00805f9b34fb', '0000ffe0-0000-1000-8000-00805f9b34fb'];
const range = (from, n) => [...Array(n).keys()].map((i) => from + i);
const SHORT = [...range(0xfe00, 512), ...range(0xae00, 256), ...range(0xa000, 64), ...range(0xb000, 64), ...range(0x0000 + 0xf000, 64), ...range(0xd000, 16), ...range(0xe000, 16)];
const hex = (dv) => [...new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
const ascii = (dv) => [...new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·')).join('');
const shortId = (uuid) => (/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.test(uuid) ? `0x${uuid.slice(4, 8)}` : uuid);
// Letture possibili dei byte: se uno di questi numeri coincide col display, il formato è trovato.
function guesses(dv) {
  const out = [];
  const n = dv.byteLength;
  for (let i = 0; i + 2 <= n; i++) out.push(`u16le@${i}=${dv.getUint16(i, true)}`, `u16be@${i}=${dv.getUint16(i, false)}`);
  for (let i = 0; i + 4 <= n; i++) { const f = dv.getFloat32(i, true); if (Number.isFinite(f) && Math.abs(f) > 0.01 && Math.abs(f) < 10000) out.push(`f32le@${i}=${f.toFixed(3)}`); }
  const nums = ascii(dv).match(/\d+[.,]?\d*/g);
  if (nums) out.push(`testo=${nums.join('|')}`);
  return out.join('  ');
}
function btAdd(entry) {
  const e = { t: new Date().toISOString(), ...entry };
  BT.log.push(e);
  try { localStorage.setItem('zdg_bt_log', JSON.stringify(BT.log.slice(-2000))); } catch { /* spazio pieno */ }
  if (BT.listEl) BT.listEl.prepend(btRow(e));
}
const btRow = (e) => h('div', { class: `bt-row bt-${e.kind}` },
  h('span', { class: 'mono tiny muted' }, e.t.slice(11, 23)),
  e.kind === 'note' ? h('strong', null, `📝 Display: ${e.text}`)
    : e.kind === 'shot' ? h('strong', { class: e.ok ? 'ok-text' : 'bad-text' }, `🎯 ${e.text}`)
    : e.kind === 'info' ? h('span', { class: 'small' }, e.text)
      : h('span', { class: 'bt-data' }, h('span', { class: 'tiny muted' }, `${e.service} › ${e.char}${e.via ? ` (${e.via})` : ''}`), h('code', null, e.hex), h('span', { class: 'tiny muted' }, `«${e.ascii}»`), h('span', { class: 'tiny muted bt-guess' }, e.guess)));
// Il cronografo è collegato e pronto (AC6000 abbinato)?
const btLive = () => !!(BT.ready && BT.device?.gatt?.connected);
// Ridisegna la pagina (cruscotto, sessione) quando cambia qualcosa del cronografo; non mentre si scrive.
function btRefresh() { if (BT.ctx && !document.activeElement?.matches?.('input, textarea')) BT.ctx.render(); }
function btStatus(text) { BT.status = text; if (BT.statusEl) BT.statusEl.textContent = text; btRefresh(); }

// Un tiro: velocità → joule con il peso del pallino scelto. Con una sessione aperta (persona + arma) si aggiunge
// alle sue letture; la media decide se l'arma passa (sotto 1 J).
function btShot(mps) {
  const g = bbGrams();
  const j = 0.5 * (g / 1000) * mps * mps;
  const ok = j < 1;
  const target = BT.session;
  btAdd({ kind: 'shot', text: `${mps.toFixed(2)} m/s · ${(mps * 3.28084).toFixed(0)} fps · ${j.toFixed(2)} J (${g.toFixed(2)} g)${target ? ` → ${target.label}` : ''}`, ok });
  BT.last = { j, v: mps, g, ok, at: Date.now() };
  if (target) target.readings.push({ j, v: mps, g });
  if (BT.ctx) BT.ctx.render();
}

// AC6000: notifiche, poi il saluto (token ricordato, altrimenti abbinamento con 00 00, fino a 8 tentativi).
async function acStart(server) {
  const nCh = await (await server.getPrimaryService(AC.svcNotify)).getCharacteristic(AC.chNotify);
  const wCh = await (await server.getPrimaryService(AC.svcWrite)).getCharacteristic(AC.chWrite);
  let acked = null;
  nCh.addEventListener('characteristicvaluechanged', (ev) => {
    const dv = ev.target.value;
    const f = [...new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)];
    btAdd({ kind: 'data', via: 'AC6000', service: 'AC6000', char: f[2] != null ? `cmd 0x${f[2].toString(16)}` : '?', hex: hex(dv), ascii: ascii(dv), guess: '' });
    if (f[0] !== 0xaa) return;
    if (f[2] === 0x4b) { try { localStorage.setItem('zdg_ac_token', JSON.stringify(f.slice(3, -1))); } catch { /* */ } acked?.(); }
    if (f[2] === 0x41) acked?.();
    // Slot attivo (0x5A, anche quando lo si cambia sul cronografo) o record letto (0x47): aggiorna il peso del pallino.
    if (f[2] === 0x5a) slotSeen = true;
    if (f[2] === 0x5a && f.length >= 10) setBb(acWeight(f[7] | (f[8] << 8)), `dal cronografo · slot ${f[4]}`);
    if (f[2] === 0x47 && f.length >= 11) setBb(acWeight(f[8] | (f[9] << 8)), `dal cronografo · slot ${f[5]}`);
    if (f[2] === 0x52 && f.length >= 10) { const raw = f[5] | (f[6] << 8) | (f[7] << 16) | (f[8] << 24); btShot(raw / 100); }
  });
  await nCh.startNotifications();
  // Ogni messaggio inviato finisce nel registro (→), per capire cosa il cronografo riceve.
  const send = (frame) => {
    btAdd({ kind: 'info', text: `→ ${[...frame].map((b) => b.toString(16).padStart(2, '0')).join(' ')}` });
    return wCh.writeValueWithoutResponse ? wCh.writeValueWithoutResponse(frame) : wCh.writeValue(frame);
  };
  let slotSeen = false;
  const wait = (ms) => new Promise((res) => { acked = () => { acked = null; res(true); }; setTimeout(() => res(false), ms); });
  let token = [0xdf, 0x02];
  try { const t = JSON.parse(localStorage.getItem('zdg_ac_token') || 'null'); if (Array.isArray(t) && t.length === 2) token = t; } catch { /* */ }
  // Comandi: AA LEN CMD payload CS, con CS = (somma da LEN all'ultimo byte + chiave) & FF. La chiave dipende dal
  // cronografo: è il primo byte del suo codice di abbinamento + 0xAC (0xDF→0x8B nel progetto originale, 0x48→0xF4).
  const cmd = (c, payload) => {
    let tk = token;
    try { const t = JSON.parse(localStorage.getItem('zdg_ac_token') || 'null'); if (Array.isArray(t) && t.length === 2) tk = t; } catch { /* */ }
    const body = [3 + payload.length + 1, c, ...payload];
    return Uint8Array.from([0xaa, ...body, (body.reduce((a, b) => a + b, 0) + tk[0] + 0xac) & 0xff]);
  };
  // Dopo il saluto si chiede lo slot attivo (0x5A) per avere subito il peso del pallino impostato. Si prova con la
  // chiave del cronografo e, se non risponde, con le altre due varianti note del checksum (non risponde ai messaggi errati).
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const askSlot = async () => {
    const tries = [cmd(0x5a, [0x00]), Uint8Array.from([0xaa, 0x05, 0x5a, 0x00, 0xea]), Uint8Array.from([0xaa, 0x05, 0x5a, 0x00, (0xaa + 0x05 + 0x5a) & 0xff])];
    await pause(400);
    for (const fr of tries) {
      if (slotSeen) return;
      await send(fr).catch(() => {});
      await pause(1200);
    }
    if (!slotSeen) btAdd({ kind: 'info', text: 'Il cronografo non ha detto il peso del pallino: cambia slot sull\'AC6000 (avanti e indietro) oppure scrivilo qui.' });
  };
  await send(acHello(token));
  if (await wait(3000)) { askSlot(); return true; }
  for (let i = 0; i < 8; i++) { await send(acHello([0, 0])); if (await wait(3000)) { askSlot(); return true; } }
  return false;
}

// Dove gira la pagina: Bluetooth via browser c'è su Chrome (Android, computer) e su iPhone solo con app come Bluefy.
const IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function btSupportNote() {
  if (navigator.bluetooth) return null;
  if (IOS) return 'Su iPhone Safari non usa il Bluetooth: installa l\'app gratuita «Bluefy – Web BLE Browser», aprila su questa pagina, accedi e collega il cronografo. Intanto puoi spuntare a mano.';
  return 'Questo browser non usa il Bluetooth: apri la pagina con Chrome (Android o computer). Intanto puoi spuntare a mano.';
}
// Errori del Bluetooth spiegati (Android: Bluetooth spento, permesso «Dispositivi nelle vicinanze», ecc.).
function btErrText(err) {
  if (err.name === 'NotFoundError') return /cancel/i.test(err.message) ? 'Nessun cronografo scelto' : 'Nessun cronografo trovato: è acceso e vicino? Chiudi l\'app AceSoft sul telefono (il cronografo accetta un solo collegamento).';
  if (err.name === 'NotAllowedError' || err.name === 'SecurityError') return 'Permesso negato: su Android consenti a Chrome «Dispositivi nelle vicinanze» e la posizione, poi riprova.';
  if (err.name === 'NetworkError') return 'Collegamento non riuscito: spegni e riaccendi il cronografo, avvicinati e riprova.';
  if (/adapter|bluetooth.*(off|unavailable)/i.test(err.message)) return 'Bluetooth spento: attivalo sul telefono e riprova.';
  return `Errore: ${err.message}`;
}

// mode 'ac6000': elenco con i soli AC6000 e pochi servizi (più veloce, va bene anche su Android e Bluefy);
// altrimenti (diagnostica) tutti i dispositivi e tutti i servizi noti.
async function btConnect(extraUuid, mode = 'all') {
  if (!navigator.bluetooth) { btStatus(btSupportNote()); return; }
  try {
    if (navigator.bluetooth.getAvailability && !(await navigator.bluetooth.getAvailability().catch(() => true))) { btStatus('Bluetooth spento o non disponibile: attivalo e riprova.'); return; }
    BT.extra = extraUuid;
    const extra = String(extraUuid || '').split(/[\s,]+/).filter(Boolean).map((u) => u.replace(/^0x/i, '')).map((u) => (/^[0-9a-f]{4}$/i.test(u) ? parseInt(u, 16) : u.toLowerCase()));
    const device = await navigator.bluetooth.requestDevice(mode === 'ac6000'
      ? { filters: [{ namePrefix: 'AC6000' }], optionalServices: [AC.svcNotify, AC.svcWrite, 'generic_access'] }
      : { acceptAllDevices: true, optionalServices: [...KNOWN, ...SHORT, ...extra] });
    if (BT.device !== device) {
      BT.device = device;
      // Se il cronografo chiude la connessione (inattività, segnale), ci si ricollega da soli qualche volta.
      device.addEventListener('gattserverdisconnected', () => {
        btAdd({ kind: 'info', text: 'Scollegato' });
        BT.ready = false;
        BT.ctx?.render();
        if (BT.manual || BT.retries >= 5) { btStatus(`Scollegato da ${device.name || 'cronografo'}`); return; }
        BT.retries++;
        btStatus(`Connessione persa: mi ricollego (${BT.retries}/5)…`);
        setTimeout(() => btOpen(device).catch((err) => btStatus(btErrText(err))), 1000);
      });
    }
    BT.manual = false;
    BT.retries = 0;
    await btOpen(device);
  } catch (err) {
    btStatus(btErrText(err));
  }
}

async function btOpen(device) {
  btStatus(`Collegamento a ${device.name || device.id}…`);
  BT.server = await device.gatt.connect();
  btAdd({ kind: 'info', text: `Collegato a «${device.name || '(senza nome)'}» · id ${device.id}` });
  // AC6000: subito il saluto, prima che chiuda la connessione per inattività.
  const isAc = await BT.server.getPrimaryService(AC.svcNotify).then(() => true).catch(() => false);
  if (isAc) {
    btStatus('Acetech AC6000: abbinamento…');
    const ok = await acStart(BT.server);
    BT.retries = 0;
    BT.ready = ok;
    BT.ctx?.render();
    btStatus(ok ? `AC6000 pronto: spara, il risultato compare qui sotto (pallino ${bbGrams().toFixed(2)} g)` : 'AC6000 collegato ma non risponde al saluto: spegni e riaccendi il cronografo e ricollega');
    return;
  }
  {
    const services = await BT.server.getPrimaryServices();
    if (!services.some((x) => !/^0000180[01]-/.test(x.uuid))) btAdd({ kind: 'info', text: 'Solo i servizi standard: il canale dei tiri ha un codice che il browser non conosce. Trovalo (vedi istruzioni sopra), scrivilo in «Servizio extra» e ricollega.' });
    for (const sv of services) {
      const chars = await sv.getCharacteristics().catch(() => []);
      btAdd({ kind: 'info', text: `Servizio ${shortId(sv.uuid)} · ${chars.length} caratteristiche` });
      for (const c of chars) {
        const pr = ['broadcast', 'read', 'writeWithoutResponse', 'write', 'notify', 'indicate', 'authenticatedSignedWrites', 'reliableWrite', 'writableAuxiliaries'].filter((k) => c.properties[k]).join(', ');
        btAdd({ kind: 'info', text: `  ↳ ${shortId(c.uuid)} [${pr}]` });
        const rec = (dv, via) => btAdd({ kind: 'data', via, service: shortId(sv.uuid), char: shortId(c.uuid), hex: hex(dv), ascii: ascii(dv), guess: guesses(dv) });
        if (c.properties.read) await c.readValue().then((dv) => rec(dv, 'lettura')).catch(() => {});
        if (c.properties.notify || c.properties.indicate) {
          c.addEventListener('characteristicvaluechanged', (ev) => rec(ev.target.value, 'notifica'));
          await c.startNotifications().catch((err) => btAdd({ kind: 'info', text: `    notifiche non attivabili: ${err.message}` }));
        }
      }
    }
    btStatus(`In ascolto su ${device.name || 'cronografo'}: spara e segna il valore del display`);
  }
}

function btExport() {
  const blob = new Blob([JSON.stringify({ device: BT.device?.name || null, userAgent: navigator.userAgent, log: BT.log }, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `cronografo-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json` });
  document.body.append(a);
  a.click();
  a.remove();
}

// Diagnostica (dati grezzi): registro di tutto quello che passa, esportabile; per i cronografi non ancora supportati.
function btDiag() {
  if (BT.panel) return BT.panel;
  try { BT.log = JSON.parse(localStorage.getItem('zdg_bt_log') || '[]'); } catch { BT.log = []; }
  const uuid = h('input', { class: 'input input-sm', placeholder: 'Servizio extra (facoltativo, es. fff0 o UUID completo)', value: localStorage.getItem('zdg_bt_uuid') || '', oninput: (e) => { try { localStorage.setItem('zdg_bt_uuid', e.target.value); } catch { /* */ } } });
  const shot = h('input', { class: 'input input-sm', placeholder: 'Valore sul display, es. 92,4 m/s · pallino 0,20 g' });
  BT.statusEl = h('p', { class: 'small bt-status' }, BT.status);
  BT.listEl = h('div', { class: 'bt-log' }, [...BT.log].reverse().map(btRow));
  const note = () => { if (!shot.value.trim()) return; btAdd({ kind: 'note', text: shot.value.trim() }); shot.value = ''; shot.focus(); };
  BT.panel = h('details', { class: 'panel bt-panel' },
    h('summary', null, h('strong', null, '🔧 Diagnostica cronografo'), h('span', { class: 'tiny muted' }, ' · dati grezzi, per i modelli non ancora supportati')),
    h('p', { class: 'tiny muted' }, 'Collega, spara, scrivi il valore del display e premi «Segna»; ripeti 5–10 volte a velocità diverse; «Esporta» e manda il file.'),
    h('details', { class: 'tiny muted' }, h('summary', null, 'Se compaiono solo i servizi 0x1800/0x1801: come trovare il codice del canale'),
      h('p', null, 'Su computer con Chrome: apri una nuova scheda, scrivi chrome://bluetooth-internals → «Devices» → «Start scan», premi «Inspect» sul cronografo: compare l\'elenco dei servizi. Su Android: app nRF Connect → Scan → Connect sul cronografo. Copia i codici lunghi (UUID) dei servizi diversi da 1800/1801, incollali in «Servizio extra» e ricollega.')),
    uuid,
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => btConnect(uuid.value) }, 'Collega (diagnostica)'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: btExport }, '⇩ Esporta registro'),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { if (!confirm('Cancellare il registro?')) return; BT.log = []; try { localStorage.removeItem('zdg_bt_log'); } catch { /* */ } BT.listEl.replaceChildren(); } }, 'Svuota')),
    BT.statusEl,
    h('form', { class: 'row-actions', onsubmit: (e) => { e.preventDefault(); note(); } }, shot, h('button', { class: 'btn btn-sm', type: 'submit' }, 'Segna')),
    BT.listEl);
  return BT.panel;
}

const SHORT_LABEL = { main: 'Primaria', backup: 'Backup', secondary: 'Secondaria' };
const shotsOf = (p) => { try { return JSON.parse(p.chronoShots || '{}') || {}; } catch { return {}; } };
const num = (x, d = 2) => Number(x).toFixed(d).replace('.', ',');
const fmtJ = (j) => `${num(j)} J`;
const fmtV = (v) => (v ? `${num(v)} m/s` : '');
const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
let chronoGroup = null;
let showClosed = false;

// Cruscotto del cronografo: collegamento, peso del pallino, ultimo tiro.
function chronoDash() {
  const live = btLive();
  const last = BT.last;
  return h('div', { class: 'panel chrono-dash' },
    h('div', { class: 'dash-top' },
      h('div', { class: 'dash-conn' },
        h('span', { class: `chip ${live ? 'chip-ok' : ''}` }, live ? `📶 ${BT.device?.name || 'Cronografo'}` : '📶 Cronografo non collegato'),
        h('span', { class: 'tiny muted' }, live ? 'Pronto: apri un\'arma qui sotto e spara' : btSupportNote() || BT.status)),
      navigator.bluetooth ? (live
        ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { BT.manual = true; try { BT.device?.gatt?.disconnect(); } catch { /* */ } } }, 'Scollega')
        : h('button', { class: 'btn btn-primary', type: 'button', onclick: () => btConnect('', 'ac6000') }, 'Collega cronografo')) : null),
    h('div', { class: 'dash-grid' },
      h('label', { class: 'dash-bb' }, h('span', { class: 'eyebrow' }, 'Pallino'),
        h('span', { class: 'dash-bb-in' }, h('input', { class: 'input input-sm bt-bb', type: 'number', step: '0.01', min: '0.10', max: '1', value: bbGrams().toFixed(2),
          onchange: (e) => { try { localStorage.setItem('zdg_bt_bb', e.target.value); } catch { /* */ } BT.bbSrc = 'scritto a mano'; btRefresh(); } }), ' g'),
        h('span', { class: 'tiny muted' }, BT.bbSrc || 'scritto a mano')),
      h('div', { class: `dash-last ${last ? (last.ok ? 'ok' : 'bad') : ''}` },
        h('span', { class: 'eyebrow' }, 'Ultimo tiro'),
        last ? [h('strong', { class: 'mono dash-j' }, fmtJ(last.j)), h('span', { class: 'tiny mono' }, `${fmtV(last.v)} · ${Math.round(last.v * 3.28084)} fps`)]
          : h('span', { class: 'tiny muted' }, '—'))));
}

// Sessione di prova: persona + arma; i tiri si sommano, la media decide. OK salva tutto.
function chronoSession(ctx) {
  const ss = BT.session;
  if (!ss) return null;
  const p = ctx.data.players.find((x) => x.id === ss.playerId);
  if (!p) { BT.session = null; return null; }
  const r = ss.readings;
  const mj = avg(r.map((x) => x.j));
  const mv = avg(r.map((x) => x.v));
  const max = r.length ? Math.max(...r.map((x) => x.j)) : 0;
  const ok = r.length && mj < 1;
  const over = r.filter((x) => x.j >= 1).length;
  const close = () => { BT.session = null; ctx.render(); };
  const save = async () => {
    const res = await ctx.call('POST', `/chrono/${p.id}`, { weapon: ss.weapon, shot: { joule: mj, mps: mv, grams: bbGrams(), readings: r.map((x) => ({ j: x.j, v: x.v })) } }, ok ? `${ss.label}: media ${fmtJ(mj)} ✓` : null);
    if (res && res.ok === false) toast(`${ss.label}: media ${fmtJ(mj)}, non passa`, 'error', 8000);
    if (res) close();
  };
  const manual = async () => {
    if (!(await dialog({ title: 'Spuntare a mano?', text: `${ss.label}: provata e minore di 1 joule, senza letture del cronografo.`, okLabel: 'Spunta' }))) return;
    if (await ctx.call('POST', `/chrono/${p.id}`, { weapon: ss.weapon, on: true }, `${ss.label}: spuntata a mano`)) close();
  };
  const col = CHRONO.find(([w]) => w === ss.weapon)[1];
  return h('div', { class: 'panel chrono-session' },
    h('div', { class: 'cs-head' }, h('div', null, h('div', { class: 'eyebrow' }, 'Prova in corso'), h('strong', null, ss.label)),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': 'Chiudi', onclick: close }, '✕')),
    h('p', { class: 'small muted' }, btLive() ? `Spara: ogni tiro si aggiunge qui (pallino ${num(bbGrams())} g). Poi «OK, salva».` : 'Cronografo non collegato: collegalo in alto, oppure spunta a mano.'),
    r.length ? h('div', { class: 'cs-reads' }, r.map((x, i) => h('span', { class: `cs-read ${x.j < 1 ? 'ok' : 'bad'}` }, `#${i + 1} ${fmtJ(x.j)} · ${fmtV(x.v)}`,
      h('button', { type: 'button', class: 'cs-del', title: 'Togli questa lettura', onclick: () => { r.splice(i, 1); ctx.render(); } }, '✕')))) : h('p', { class: 'tiny muted' }, 'Nessuna lettura ancora.'),
    r.length ? h('div', { class: `cs-sum ${ok ? 'ok' : 'bad'}` },
      h('div', null, h('span', { class: 'eyebrow' }, `Media di ${r.length}`), h('strong', { class: 'mono' }, fmtJ(mj))),
      h('div', null, h('span', { class: 'eyebrow' }, 'Velocità media'), h('strong', { class: 'mono' }, fmtV(mv))),
      h('div', null, h('span', { class: 'eyebrow' }, 'Massimo'), h('strong', { class: 'mono' }, fmtJ(max))),
      h('strong', { class: 'cs-verdict' }, ok ? '✓ Media minore di 1 joule' : '✗ Media da 1 joule in su: non passa'),
      over ? h('strong', { class: 'cs-over' }, `⚠ ${over === 1 ? '1 colpo' : `${over} colpi`} sopra 1 joule (max ${fmtJ(max)})`) : null) : null,
    h('div', { class: 'row-actions' },
      h('button', { class: `btn ${ok ? 'btn-primary' : 'btn-danger'}`, type: 'button', disabled: !r.length, onclick: save }, ok ? 'OK, salva' : 'Salva (non passa)'),
      h('button', { class: 'btn', type: 'button', onclick: manual }, 'Spunta a mano'),
      p[col] ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: async () => { if (await ctx.call('POST', `/chrono/${p.id}`, { weapon: ss.weapon, on: false }, 'Spunta tolta')) close(); } }, 'Togli spunta') : null,
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: close }, 'Annulla')));
}

export function viewChrono(ctx) {
  BT.ctx = ctx;
  const ms = ctx.data;
  const present = ms.players.filter((p) => p.status === 'accepted' && p.checkinAt);
  const closed = present.filter((p) => p.chronoDoneAt).length;
  const tested = present.reduce((n, p) => n + CHRONO.filter(([, col]) => p[col]).length, 0);
  const groups = peopleGroups(ctx, (p) => !!p.checkinAt).map((g) => ({ ...g, key: JSON.stringify(g.dest) }));
  if (chronoGroup && !groups.some((g) => g.key === chronoGroup)) chronoGroup = null;
  const shown = groups.filter((g) => !chronoGroup || g.key === chronoGroup)
    .flatMap((g) => g.people.map((p) => ({ p, g })))
    .filter(({ p }) => showClosed || !p.chronoDoneAt);
  const open = (p, weapon, label) => { BT.session = { playerId: p.id, weapon, label: `${personLabel(p)} · ${label}`, readings: [] }; ctx.render(); };
  const closeP = async (p) => {
    if (p.chronoDoneAt) return ctx.call('POST', `/chrono/${p.id}/done`, { on: false }, `${p.nickname || p.name}: riaperta`);
    if (!p.chronoMain && !(await dialog({ title: 'Chiudere senza arma principale?', text: `${personLabel(p)} non ha l'arma principale provata.`, okLabel: 'Chiudi comunque' }))) return;
    if (BT.session?.playerId === p.id) BT.session = null;
    return ctx.call('POST', `/chrono/${p.id}/done`, { on: true }, `${p.nickname || p.name}: chiusa`);
  };
  const tile = (key, title, done, tot, color) => h('button', { type: 'button', class: `chrono-tile ${chronoGroup === key ? 'on' : ''} ${tot && done === tot ? 'full' : ''}`, style: { '--c': color || 'var(--line)' }, onclick: () => { chronoGroup = chronoGroup === key ? null : key; ctx.render(); } },
    h('strong', null, title), h('span', { class: 'mono small' }, `${done}/${tot}`), h('span', { class: 'tiny muted' }, 'chiuse'));
  return h('div', { class: 'stack' },
    section('Test armi',
      h('details', { class: 'muted tiny chrono-help' }, h('summary', null, 'Come funziona'),
        h('p', null, 'Ogni replica va provata al cronografo, persona per persona. Tocca un\'arma: spara uno o più tiri, guarda la media e dai «OK, salva» (passa se la media è sotto 1 joule). Senza cronografo: «Spunta a mano». Quando una persona ha finito, «Chiudi» e sparisce dalla lista.'),
        h('p', null, 'Cronografo Bluetooth (Acetech AC6000-BT): Chrome su Android o computer; su iPhone con l\'app Bluefy. Chiudi l\'app AceSoft prima di collegarlo.')),
      h('div', { class: 'ck-counts' }, ckCount(closed, present.length, 'persone chiuse'), h('div', { class: 'ck-count' }, h('strong', { class: 'mono' }, String(tested)), h('span', { class: 'tiny muted' }, 'repliche provate')))),
    chronoDash(),
    chronoSession(ctx),
    h('div', { class: 'chrono-tiles' },
      tile(null, 'Tutte', closed, present.length),
      groups.map((g) => tile(g.key, g.title, g.all.filter((p) => p.chronoDoneAt).length, g.all.length, g.team?.color || g.color))),
    h('div', { class: 'chrono-tools' }, ckSearch(ctx),
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: showClosed, onchange: (e) => { showClosed = e.target.checked; ctx.render(); } }), ` Mostra anche le chiuse (${closed})`)),
    shown.length ? h('div', { class: 'chrono-table' }, shown.map(({ p, g }) => {
      const shots = shotsOf(p);
      return h('div', { class: `chrono-tr ${p.chronoDoneAt ? 'closed' : ''} ${BT.session?.playerId === p.id ? 'active' : ''}`, style: { '--c': g.team?.color || g.color || 'var(--line)' } },
        h('div', { class: 'chrono-who' }, h('strong', null, personLabel(p)), h('span', { class: 'tiny muted' }, g.title)),
        h('div', { class: 'chrono-weapons' }, CHRONO.map(([weapon, col, label]) => {
          const s = shots[weapon];
          const cur = BT.session?.playerId === p.id && BT.session.weapon === weapon;
          const sub = p[col] ? (s ? `${fmtJ(s.j)}${s.n > 1 ? ` · media di ${s.n}` : ''}` : 'a mano') : s && s.ok === false ? `✗ ${fmtJ(s.j)}` : 'da provare';
          // Colpi sopra 1 J tra le letture salvate (anche se la media passa): in rosso.
          const overN = (s?.readings || []).filter((x) => x.j >= 1).length || (s && s.max >= 1 ? 1 : 0);
          return h('button', { type: 'button', class: `chrono-wbtn ${p[col] ? 'on' : ''} ${s && s.ok === false && !p[col] ? 'fail' : ''} ${overN && p[col] ? 'over' : ''} ${cur ? 'cur' : ''}`, disabled: !!p.chronoDoneAt, onclick: () => open(p, weapon, label) },
            h('span', { class: 'ck-box', 'aria-hidden': 'true' }, p[col] ? '✓' : cur ? '🎯' : ''), h('span', null, h('span', { class: 'w-long' }, label), h('span', { class: 'w-short' }, SHORT_LABEL[weapon]), h('span', { class: 'tiny' }, sub),
              overN && s ? h('span', { class: 'tiny w-over' }, `⚠ ${overN} sopra 1 J · max ${fmtJ(s.max ?? s.j)}`) : null));
        })),
        h('button', { type: 'button', class: `btn btn-sm ${p.chronoDoneAt ? 'btn-ghost' : ''} chrono-close`, onclick: () => closeP(p) }, p.chronoDoneAt ? 'Riapri' : 'Chiudi ✓'));
    })) : h('p', { class: 'empty' }, ckFilter ? 'Nessuno con questo nome.' : present.length ? 'Tutti chiusi qui. 🎉' : 'Ancora nessuno accettato: prima passa dall\'Accettazione.'),
    btDiag(),
    BT.session ? h('div', { class: 'chrono-sheet-pad' }) : null);
}
