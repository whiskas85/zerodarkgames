// Accettazione a inizio evento e Test armi: condivisi tra la regia e lo staff (pagina Soglia).
// ctx = { data: { players, teams, elect, squads }, call(method, path, body, okMsg), render() }.
import { h, fmtTime, dialog } from './lib.js';

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
function btStatus(text) { BT.status = text; if (BT.statusEl) BT.statusEl.textContent = text; }

// Un tiro: velocità → joule con il peso del pallino scelto; verde sotto 1 J, rosso da 1 J in su.
function btShot(mps) {
  const g = bbGrams();
  const j = 0.5 * (g / 1000) * mps * mps;
  const ok = j < 1;
  btAdd({ kind: 'shot', text: `${mps.toFixed(2)} m/s · ${(mps * 3.28084).toFixed(0)} fps · ${j.toFixed(2)} J (${g.toFixed(2)} g)`, ok });
  if (BT.liveEl) {
    BT.liveEl.className = `bt-live ${ok ? 'ok' : 'bad'}`;
    BT.liveEl.replaceChildren(
      h('div', { class: 'bt-live-j mono' }, `${j.toFixed(2).replace('.', ',')} J`),
      h('div', { class: 'small mono' }, `${mps.toFixed(2).replace('.', ',')} m/s · ${(mps * 3.28084).toFixed(0)} fps · pallino ${g.toFixed(2).replace('.', ',')} g`),
      h('strong', null, ok ? '✓ Minore di 1 joule' : '✗ 1 joule o più: non passa'));
  }
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
    if (f[2] === 0x52 && f.length >= 10) { const raw = f[5] | (f[6] << 8) | (f[7] << 16) | (f[8] << 24); btShot(raw / 100); }
  });
  await nCh.startNotifications();
  const send = (frame) => (wCh.writeValueWithoutResponse ? wCh.writeValueWithoutResponse(frame) : wCh.writeValue(frame));
  const wait = (ms) => new Promise((res) => { acked = () => { acked = null; res(true); }; setTimeout(() => res(false), ms); });
  let token = [0xdf, 0x02];
  try { const t = JSON.parse(localStorage.getItem('zdg_ac_token') || 'null'); if (Array.isArray(t) && t.length === 2) token = t; } catch { /* */ }
  await send(acHello(token));
  if (await wait(3000)) return true;
  for (let i = 0; i < 8; i++) { await send(acHello([0, 0])); if (await wait(3000)) return true; }
  return false;
}

async function btConnect(extraUuid) {
  if (!navigator.bluetooth) { btStatus('Questo browser non supporta il Bluetooth: usa Chrome su Android o su computer (non iPhone).'); return; }
  try {
    BT.extra = extraUuid;
    const extra = String(extraUuid || '').split(/[\s,]+/).filter(Boolean).map((u) => u.replace(/^0x/i, '')).map((u) => (/^[0-9a-f]{4}$/i.test(u) ? parseInt(u, 16) : u.toLowerCase()));
    const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [...KNOWN, ...SHORT, ...extra] });
    if (BT.device !== device) {
      BT.device = device;
      // Se il cronografo chiude la connessione (inattività, segnale), ci si ricollega da soli qualche volta.
      device.addEventListener('gattserverdisconnected', () => {
        btAdd({ kind: 'info', text: 'Scollegato' });
        if (BT.manual || BT.retries >= 5) { btStatus(`Scollegato da ${device.name || 'cronografo'}`); return; }
        BT.retries++;
        btStatus(`Connessione persa: mi ricollego (${BT.retries}/5)…`);
        setTimeout(() => btOpen(device).catch((err) => btStatus(`Errore: ${err.message}`)), 1000);
      });
    }
    BT.manual = false;
    BT.retries = 0;
    await btOpen(device);
  } catch (err) {
    btStatus(err.name === 'NotFoundError' ? 'Nessun dispositivo scelto' : `Errore: ${err.message}`);
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

function btPanel() {
  if (BT.panel) return BT.panel;
  try { BT.log = JSON.parse(localStorage.getItem('zdg_bt_log') || '[]'); } catch { BT.log = []; }
  const uuid = h('input', { class: 'input input-sm', placeholder: 'Servizio extra (facoltativo, es. fff0 o UUID completo)', value: localStorage.getItem('zdg_bt_uuid') || '', oninput: (e) => { try { localStorage.setItem('zdg_bt_uuid', e.target.value); } catch { /* */ } } });
  const shot = h('input', { class: 'input input-sm', placeholder: 'Valore sul display, es. 92,4 m/s · pallino 0,20 g' });
  BT.statusEl = h('p', { class: 'small bt-status' }, BT.status);
  BT.liveEl = h('div', { class: 'bt-live' }, h('span', { class: 'tiny muted' }, 'Ultimo tiro: compare qui appena il cronografo lo manda.'));
  const bb = h('input', { class: 'input input-sm bt-bb', type: 'number', step: '0.01', min: '0.10', max: '1', value: bbGrams().toFixed(2),
    oninput: (e) => { try { localStorage.setItem('zdg_bt_bb', e.target.value); } catch { /* */ } } });
  BT.listEl = h('div', { class: 'bt-log' }, [...BT.log].reverse().map(btRow));
  const note = () => { if (!shot.value.trim()) return; btAdd({ kind: 'note', text: shot.value.trim() }); shot.value = ''; shot.focus(); };
  BT.panel = h('details', { class: 'panel bt-panel' },
    h('summary', null, h('strong', null, '📶 Cronografo Bluetooth'), h('span', { class: 'tiny muted' }, ' · Acetech AC6000-BT letto in automatico; altri modelli: registrazione')),
    h('p', { class: 'tiny muted' }, 'Chrome su Android o computer (non iPhone). Chiudi l\'app del produttore, poi: 1) Collega e scegli il cronografo; 2) spara; 3) scrivi il valore del display e premi «Segna»; ripeti 5–10 volte a velocità diverse; 4) «Esporta» e manda il file.'),
    h('details', { class: 'tiny muted' }, h('summary', null, 'Se compaiono solo i servizi 0x1800/0x1801: come trovare il codice del canale'),
      h('p', null, 'Su computer con Chrome: apri una nuova scheda, scrivi chrome://bluetooth-internals → «Devices» → «Start scan», premi «Inspect» sul cronografo: compare l\'elenco dei servizi. Su Android: app nRF Connect → Scan → Connect sul cronografo. Copia i codici lunghi (UUID) dei servizi diversi da 1800/1801, incollali in «Servizio extra» (anche più di uno, separati da spazio) e ricollega.')),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => btConnect(uuid.value) }, 'Collega cronografo'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { BT.manual = true; try { BT.device?.gatt?.disconnect(); } catch { /* già scollegato */ } } }, 'Scollega'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: btExport }, '⇩ Esporta registro'),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { if (!confirm('Cancellare il registro?')) return; BT.log = []; try { localStorage.removeItem('zdg_bt_log'); } catch { /* */ } BT.listEl.replaceChildren(); } }, 'Svuota')),
    h('label', { class: 'bt-bb-row' }, h('span', { class: 'small' }, 'Peso del pallino (g) per i joule'), bb),
    BT.statusEl,
    BT.liveEl,
    h('details', { class: 'tiny muted' }, h('summary', null, 'Altri cronografi: servizio extra'), uuid),
    h('form', { class: 'row-actions', onsubmit: (e) => { e.preventDefault(); note(); } }, shot, h('button', { class: 'btn btn-sm', type: 'submit' }, 'Segna')),
    BT.listEl);
  return BT.panel;
}

export function viewChrono(ctx) {
  const ms = ctx.data;
  const present = ms.players.filter((p) => p.status === 'accepted' && p.checkinAt);
  const mainOk = present.filter((p) => p.chronoMain).length;
  const toggle = (p, weapon, col) => ctx.call('POST', (`/chrono/${p.id}`), { weapon, on: !p[col] });
  const groups = peopleGroups(ctx, (p) => !!p.checkinAt);
  return h('div', { class: 'stack' },
    section('Test armi',
      h('p', { class: 'muted tiny' }, 'Prova al cronografo, persona per persona. Segnare un\'arma vuol dire che è stata provata ed è minore di 1 joule. Compare solo chi è stato accettato all\'ingresso.'),
      h('div', { class: 'ck-counts' }, ckCount(mainOk, present.length, 'con l\'arma principale provata')),
      ckSearch(ctx)),
    btPanel(),
    groups.length ? h('div', { class: 'ck-grid' }, groups.map((g) => h('div', { class: 'panel ck-group', style: { '--c': g.team?.color || g.color || 'var(--line)' } },
      h('div', { class: 'ck-head' }, h('strong', null, g.title), g.sub ? h('span', { class: 'tiny muted' }, g.sub) : null),
      g.people.map((p) => h('div', { class: 'chrono-person' },
        h('strong', null, personLabel(p)),
        h('div', { class: 'chrono-row' }, CHRONO.map(([weapon, col, label]) => h('button', { class: `chrono-btn ${p[col] ? 'on' : ''}`, type: 'button', title: p[col] ? `Provata alle ${fmtTime(p[col])}` : 'Tocca se è minore di 1 joule', onclick: () => toggle(p, weapon, col) },
          h('span', { class: 'ck-box', 'aria-hidden': 'true' }, p[col] ? '✓' : ''),
          h('span', null, label, h('span', { class: 'tiny' }, 'minore di 1 joule'))))))))))
      : h('p', { class: 'empty' }, ckFilter ? 'Nessuno con questo nome.' : 'Ancora nessuno accettato: prima passa dall\'Accettazione.'));
}

