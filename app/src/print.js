'use strict';
// Pagine A4 stampabili (Stampa → Salva come PDF): cartelli degli Altari, dei Doni, della Soglia e credenziali.
// Ogni gruppo si stampa tutto, solo alcuni elementi (sel: chiavi come a12, g3, t5, p9) o tutti i gruppi insieme.
// In testa a ogni stampa c'è il logo: quello caricato in regia o, se manca, quello dello Zero Dark Team.
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { q, getSetting, setSetting, DATA_DIR } = require('./db');
const G = require('./game');
const { HttpError } = require('./util');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const qr = (text) => QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'Q' });

// ---------------------------------------------------------------- logo

const DEFAULT_LOGO = path.join(__dirname, '..', 'public', 'img', 'zdt-logo.jpg');
const LOGO_FILE = path.join(DATA_DIR, 'print-logo');
const LOGO_TYPES = { 'image/png': 1, 'image/jpeg': 1, 'image/webp': 1, 'image/svg+xml': 1, 'image/gif': 1 };

function logo() {
  const mime = getSetting('printLogoMime');
  if (mime && fs.existsSync(LOGO_FILE)) return { file: LOGO_FILE, mime, custom: true };
  return { file: DEFAULT_LOGO, mime: 'image/jpeg', custom: false };
}
function saveLogo(buf, mime) {
  if (!LOGO_TYPES[mime]) throw new HttpError(400, 'Formato non valido: usa PNG, JPG, WebP, GIF o SVG');
  if (!buf?.length) throw new HttpError(400, 'Immagine vuota');
  fs.writeFileSync(LOGO_FILE, buf);
  setSetting('printLogoMime', mime);
}
function resetLogo() {
  setSetting('printLogoMime', '');
  try { fs.unlinkSync(LOGO_FILE); } catch { /* già tolto */ }
}
// Nella pagina il logo va incorporato: il PDF salvato resta completo anche senza rete.
const logoTag = () => { const l = logo(); return `<img class="plogo" alt="" src="data:${l.mime};base64,${fs.readFileSync(l.file).toString('base64')}">`; };

// ---------------------------------------------------------------- stile comune

const BASE_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Big+Shoulders+Stencil+Display:wght@800;900&family=IBM+Plex+Mono:wght@400;600&family=Source+Serif+4:ital,wght@0,400;0,600;1,400&display=swap');
@page{size:A4;margin:0}
*{box-sizing:border-box}
html,body{margin:0;background:#E3E1D8;color:#1C211E;font-family:"Source Serif 4",Georgia,serif}
.toolbar{position:sticky;top:0;background:#1C211E;color:#E3E1D8;padding:12px 20px;display:flex;flex-wrap:wrap;gap:16px;align-items:center;font-family:"IBM Plex Mono",monospace;font-size:14px;z-index:2}
.toolbar button{font:inherit;background:#8E2A1F;color:#fff;border:0;padding:10px 18px;cursor:pointer}
.sheet{width:210mm;height:297mm;margin:16px auto;background:#ECEAE2;position:relative;overflow:hidden;page-break-after:always;break-after:page}
.mono{font-family:"IBM Plex Mono",monospace}
.display{font-family:"Big Shoulders Stencil Display",Impact,sans-serif;text-transform:uppercase}
.qr svg{width:100%;height:100%;display:block}
.plogo{object-fit:contain;display:block}
@media print{.toolbar{display:none}.sheet{margin:0;box-shadow:none}html,body{background:#fff}}
`;

// ---------------------------------------------------------------- gruppi

const pick = (sel, key) => !sel || sel.has(key);

async function altars(g, base, sel) {
  const points = q.all('SELECT * FROM points WHERE gameId = ?', g.id)
    .map((p) => ({ ...p, s: G.sectorById(p.sectorId) }))
    .sort((a, b) => a.s.ord - b.s.ord)
    .filter((p) => pick(sel, `a${p.id}`));
  const lg = logoTag();
  const sheets = await Promise.all(points.map(async (p) => `
  <section class="sheet altar">
    <div class="frame">
      <div class="head">${lg}<div class="top mono">Consiglio Zero · Avviso ai Legati · ${esc(g.name)}</div></div>
      <div class="emblem"><span class="display">${esc(p.s.roman)}</span></div>
      <h1 class="display">${esc(p.label)}</h1>
      <div class="sector mono">Settore ${esc(p.s.roman)} · ${esc(p.s.name)} — ${esc(p.s.element)}</div>
      <div class="qr">${await qr(`${base}/a/${p.qrToken}`)}</div>
      <p class="how">Inquadrate il segno con l'app dei Giochi («Scansiona Altare»). Allontanatevi. Poi pronunciate nell'app il Sigillo del Settore ${esc(p.s.name)}.</p>
      <div class="motto display">«${esc(p.s.motto)}»</div>
      <div class="keep display">Non rimuovere</div>
      <div class="warn mono">Non staccate questo avviso. Restate a 20 metri da chi lo sta inquadrando.</div>
    </div>
  </section>`));
  return {
    title: 'Cartelli Altari', count: points.length, note: 'Nessun Sigillo e nessun frammento è stampato sui cartelli.',
    empty: 'Nessun Altare: forma le coppie o crea gli Altari dei Settori in regia.', sheets,
    css: `
.altar .frame{position:absolute;inset:10mm;border:3mm solid #1C211E;padding:8mm 12mm;display:flex;flex-direction:column;align-items:center;text-align:center;gap:3.5mm}
.altar .frame::after{content:"";position:absolute;inset:3mm;border:.6mm solid #8E2A1F;pointer-events:none}
.altar .head{display:flex;flex-direction:column;align-items:center;gap:2mm}
.altar .plogo{width:18mm;height:18mm}
.altar .top{font-size:8.5pt;letter-spacing:.14em;text-transform:uppercase;color:#5B615A}
.altar .emblem{width:20mm;height:20mm;border-radius:50%;border:2mm solid #1C211E;display:grid;place-items:center}
.altar .emblem span{font-size:12mm;line-height:1;font-weight:900}
.altar h1{font-size:21mm;line-height:.85;margin:0;font-weight:900}
.altar .sector{font-size:13pt;color:#8E2A1F;font-weight:600}
.altar .qr{width:85mm;height:85mm;background:#fff;padding:5mm;border:1mm solid #1C211E}
.altar .how{font-size:11pt;max-width:140mm;margin:0}
.altar .motto{font-size:9mm;color:#8E2A1F;font-weight:800}
.altar .keep{margin-top:auto;width:100%;padding:2mm;background:#1C211E;color:#fff;font-size:10mm;font-weight:900;letter-spacing:.08em}
.altar .warn{font-size:9pt;color:#5B615A}`,
  };
}

async function exitSign(g, base, sel) {
  const soglia = G.landmarksOf(g.id).find((l) => l.kind === 'soglia');
  if (!soglia || !pick(sel, `u${soglia.id}`)) return { title: 'Codice di uscita', count: 0, sheets: [], css: '', empty: 'Nessuna Soglia.' };
  return {
    title: 'Codice di uscita', count: 1, note: 'Da appendere alla Soglia.', empty: '',
    sheets: [`<section class="sheet exit"><div class="frame">
  ${logoTag()}
  <div class="top mono">Consiglio Zero · ${esc(g.name)}</div>
  <h1 class="display">La Soglia</h1>
  <div class="sub mono">Codice di uscita</div>
  <div class="qr">${await qr(`${base}/u/${soglia.exitToken}`)}</div>
  <div class="mono code">Codice ${esc(soglia.exitToken.slice(-6).toUpperCase())}</div>
  <p class="how">Con la Parola intera, inquadrate questo segno con l'app dei Giochi («Leggi il codice di uscita»). Chi è ancora in alleanza non esce: rompete prima l'alleanza. Uscendo, il vostro Sigillo viene rivelato a tutti.</p>
  <div class="keep display">Non rimuovere</div>
</div></section>`],
    css: `
.exit .frame{position:absolute;inset:12mm;border:3mm solid #1C211E;padding:12mm 14mm;display:flex;flex-direction:column;align-items:center;text-align:center;gap:6mm}
.exit .frame::after{content:"";position:absolute;inset:3mm;border:.6mm solid #8E2A1F;pointer-events:none}
.exit .plogo{width:24mm;height:24mm}
.exit .top{font-size:10pt;letter-spacing:.14em;text-transform:uppercase;color:#5B615A}
.exit h1{font-size:26mm;line-height:.85;margin:0;font-weight:900}
.exit .sub{font-size:13pt;color:#8E2A1F;font-weight:600}
.exit .qr{width:110mm;height:110mm;background:#fff;padding:5mm;border:1mm solid #1C211E}
.exit .code{font-size:10pt;letter-spacing:.2em;color:#5B615A;margin-top:-3mm}
.exit .how{font-size:12pt;max-width:150mm;margin:0}
.exit .keep{margin-top:auto;width:100%;padding:2.5mm;background:#1C211E;color:#fff;font-size:11mm;font-weight:900;letter-spacing:.08em}`,
  };
}

async function credentials(g, base, sel) {
  const lg = logoTag();
  const teams = G.teamsOf(g.id).filter((t) => t.sectorId && pick(sel, `t${t.id}`));
  const cards = await Promise.all(teams.map(async (t) => {
    const members = q.all('SELECT name, nickname FROM players WHERE teamId = ? ORDER BY id', t.id);
    return `<div class="card">
      <div class="head">${lg}<span class="display roman">${esc(t.roman)}</span><div><div class="display name">Settore ${esc(t.sectorName)}</div>
      <div class="members">${members.map((m) => esc(m.name + (m.nickname ? ` «${m.nickname}»` : ''))).join(' · ')}</div>
      ${t.displayName ? `<div class="mono small">${esc(t.displayName)}</div>` : ''}</div></div>
      <div class="body"><div class="qr">${await qr(`${base}/login/${t.loginToken}`)}</div>
      <div class="info"><div class="mono small">Inquadrate per entrare nell'app<br>oppure aprite</div><div class="mono url">${esc(base)}</div>
      <div class="mono small">e inserite il codice d'accesso</div><div class="mono code">${esc(t.accessCode)}</div>
      <div class="mono small">Va bene su entrambi i telefoni della coppia.<br>Non è il vostro Sigillo.</div></div></div>
    </div>`;
  }));
  const elect = G.electOf(g.id);
  // Eletti: ognuno ha il proprio accesso personale (niente codice comune).
  const electMembers = (elect ? G.membersOf(elect.id) : []).filter((m) => pick(sel, `p${m.id}`));
  for (const m of electMembers) {
    const p = q.get('SELECT p.loginToken, p.accessCode, s.name AS squad FROM players p LEFT JOIN elect_squads s ON s.id = p.squadId WHERE p.id = ?', m.id);
    if (!p?.loginToken) continue;
    cards.push(`<div class="card">
      <div class="head">${lg}<span class="display roman">0</span><div><div class="display name">Eletto del Consiglio</div>
      <div class="members">${esc(m.name + (m.nickname ? ` «${m.nickname}»` : ''))}</div>
      ${p.squad ? `<div class="mono small">Squadra ${esc(p.squad)}</div>` : ''}</div></div>
      <div class="body"><div class="qr">${await qr(`${base}/login/${p.loginToken}`)}</div>
      <div class="info"><div class="mono small">Inquadra per entrare nell'app<br>oppure apri</div><div class="mono url">${esc(base)}</div>
      <div class="mono small">e inserisci il tuo codice personale</div><div class="mono code">${esc(p.accessCode)}</div>
      <div class="mono small">Accesso personale: non condividerlo.</div></div></div>
    </div>`);
  }
  const sheets = [];
  for (let i = 0; i < cards.length; i += 4) sheets.push(`<section class="sheet creds">${cards.slice(i, i + 4).join('')}</section>`);
  return {
    title: 'Credenziali', count: cards.length, note: 'Ritagliate lungo il tratteggio.', empty: 'Nessuna coppia con Settore.', sheets,
    css: `
.creds{display:grid;grid-template-rows:repeat(4,1fr);padding:8mm;gap:6mm}
.creds .card{border:1mm dashed #1C211E;padding:5mm 7mm;display:grid;gap:3mm;align-content:start}
.creds .head{display:flex;gap:5mm;align-items:center}
.creds .plogo{width:14mm;height:14mm;flex:none}
.creds .roman{font-size:14mm;font-weight:900;color:#8E2A1F;min-width:18mm;text-align:center}
.creds .name{font-size:9mm;font-weight:900;line-height:1}
.creds .members{font-size:11pt}
.creds .body{display:flex;gap:7mm;align-items:center}
.creds .qr{width:40mm;height:40mm;background:#fff;padding:2mm;flex:none}
.creds .info{display:grid;gap:1.5mm}
.creds .small{font-size:8.5pt;color:#5B615A}
.creds .url{font-size:11pt;font-weight:600}
.creds .code{font-size:20pt;font-weight:600;letter-spacing:.18em}`,
  };
}

const GIFT_CSS = `
.gifts{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:6mm;padding:8mm}
.gifts .gift{border:1.2mm solid #1C211E;outline:.5mm solid #7D6226;outline-offset:-3mm;padding:6mm;display:flex;flex-direction:column;align-items:center;text-align:center;gap:2.5mm}
.gifts .ghead{display:flex;align-items:center;gap:2mm}
.gifts .plogo{width:9mm;height:9mm}
.gifts .top{font-size:7.5pt;letter-spacing:.12em;text-transform:uppercase;color:#5B615A}
.gifts .title{font-size:10mm;font-weight:900;line-height:1}
.gifts .qr{width:58mm;height:58mm;background:#fff;padding:2mm}
.gifts .label{font-size:8mm;font-weight:800;color:#7D6226}
.gifts p{margin:0;font-size:9.5pt}
.gifts .sign{margin-top:auto;width:100%;padding:2mm;font-weight:800;font-size:9pt;text-transform:uppercase;letter-spacing:.06em;border:.6mm solid #1C211E}
.gifts .sign.remove{background:#1C211E;color:#fff}`;

// Cartelli dei doni QR: 4 per foglio. Il tipo non è stampato: si scopre solo prendendo il dono.
const giftRows = (g) => q.all("SELECT * FROM gifts WHERE gameId = ? AND parentGiftId IS NULL AND NOT (status = 'claimed' AND lat IS NULL AND placedAt IS NULL) ORDER BY id", g.id);
async function gifts(g, base, sel) {
  const lg = logoTag();
  const list = giftRows(g).filter((d) => pick(sel, `g${d.id}`));
  const cards = await Promise.all(list.map(async (d) => `<div class="gift">
      <div class="ghead">${lg}<div class="mono top">Consiglio Zero · ${esc(g.name)}</div></div>
      <div class="display title">Dono del Consiglio</div>
      <div class="qr">${await qr(`${base}/d/${d.qrToken}`)}</div>
      <div class="display label">${esc(d.label)}</div>
      <p>Scansionatelo con l'app dei Giochi («Scansiona»). Chi arriva primo lo prende.</p>
      <div class="sign ${d.removeSign === 0 ? 'keep' : 'remove'}">${d.removeSign === 0 ? 'Non rimuovere il cartello' : 'Cartello da rimuovere dopo la scansione'}</div>
    </div>`));
  const sheets = [];
  for (let i = 0; i < cards.length; i += 4) sheets.push(`<section class="sheet gifts">${cards.slice(i, i + 4).join('')}</section>`);
  return {
    title: 'Cartelli Doni', count: list.length, note: 'Il tipo del dono non è stampato.', empty: 'Nessun dono: creali nella sezione Doni QR della regia.', sheets,
    css: GIFT_CSS,
  };
}

// Postazioni nel Cerchio: un cartello A4 per Settore, dove la coppia lascia il suo armamentario.
// Tutti i Settori attivi (anche senza coppia, così i cartelli valgono per più partite); il nome della coppia,
// se c'è già, è scritto piccolo.
const sectorList = () => G.sectors().filter((s) => !s.archived);
const sectorColor = (s) => (/^#[0-9a-f]{3,8}$/i.test(s.color || '') ? s.color : '#8E2A1F');
function sectorEmblem(s, size = 60) {
  const c = sectorColor(s);
  const fs = s.roman.length > 3 ? 22 : s.roman.length > 2 ? 26 : 32;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}"><circle cx="50" cy="50" r="46" fill="#1C211E"/><circle cx="50" cy="50" r="38" fill="none" stroke="${c}" stroke-width="5"/><text x="50" y="52" text-anchor="middle" dominant-baseline="middle" font-family="Impact, 'Arial Narrow', sans-serif" font-weight="900" font-size="${fs}" fill="#ECEAE2">${esc(s.roman)}</text></svg>`;
}
async function stations(g, _base, sel) {
  const lg = logoTag();
  const teams = Object.fromEntries(G.teamsOf(g.id).filter((t) => t.sectorId).map((t) => [t.sectorId, t]));
  const list = sectorList().filter((s) => pick(sel, `s${s.id}`));
  const sheets = list.map((s) => {
    const c = sectorColor(s);
    const t = teams[s.id];
    return `<section class="sheet station" style="--c:${c}">
    <div class="band"></div>
    <div class="frame">
      <div class="head">${lg}<div class="top mono">Consiglio Zero · Il Cerchio · ${esc(g.name)}</div></div>
      <div class="label mono">Postazione</div>
      <div class="roman display">${esc(s.roman)}</div>
      <h1 class="display">Settore ${esc(s.name)}</h1>
      <div class="element mono">${esc(s.element)}</div>
      <div class="motto display">«${esc(s.motto)}»</div>
      <p class="how">Qui la coppia del Settore ${esc(s.name)} lascia il suo armamentario prima di entrare nel Cerchio.</p>
      ${t?.displayName ? `<div class="team mono">${esc(t.displayName)}</div>` : ''}
    </div>
    <div class="band"></div>
  </section>`;
  });
  return {
    title: 'Postazioni nel Cerchio', count: list.length, note: 'Un cartello per Settore: dove ogni coppia lascia il suo armamentario.', empty: 'Nessun Settore attivo.', sheets,
    css: `
.station{display:flex;flex-direction:column}
.station .band{height:16mm;background:var(--c);flex:none}
.station .frame{flex:1;margin:8mm 12mm;border:3mm solid #1C211E;outline:.8mm solid var(--c);outline-offset:-5mm;padding:10mm 12mm;display:flex;flex-direction:column;align-items:center;text-align:center;gap:4mm}
.station .head{display:flex;flex-direction:column;align-items:center;gap:2mm}
.station .plogo{width:20mm;height:20mm}
.station .top{font-size:9pt;letter-spacing:.14em;text-transform:uppercase;color:#5B615A}
.station .label{font-size:14pt;letter-spacing:.3em;text-transform:uppercase;color:#1C211E;background:var(--c);padding:1.5mm 6mm;font-weight:600;margin-top:4mm}
.station .roman{font-size:95mm;line-height:.8;font-weight:900;color:#1C211E;-webkit-text-stroke:1.2mm var(--c)}
.station h1{font-size:24mm;line-height:.9;margin:0;font-weight:900}
.station .element{font-size:14pt;color:#1C211E;font-weight:600;text-transform:uppercase;letter-spacing:.12em;border-bottom:1.2mm solid var(--c);padding-bottom:1mm}
.station .motto{font-size:11mm;font-weight:800;color:#5B615A}
.station .how{font-size:12pt;max-width:150mm;margin:auto 0 0}
.station .team{font-size:11pt;color:#5B615A;border-top:.4mm solid #1C211E;padding-top:2mm}
@media print{.station,.station *{-webkit-print-color-adjust:exact;print-color-adjust:exact}}`,
  };
}

// QR dei doni da abbinare sul campo: stessi cartelli dei doni (il dono non c'è ancora), con il numero piccolo in basso.
// Senza selezione si stampano quelli non ancora abbinati.
async function giftBlanksPrint(g, base, sel) {
  const lg = logoTag();
  const all = q.all('SELECT * FROM gift_blanks WHERE gameId = ? ORDER BY n', g.id);
  const list = sel ? all.filter((b) => pick(sel, `b${b.id}`)) : all.filter((b) => !b.giftId);
  const cards = await Promise.all(list.map(async (b) => `<div class="gift">
      <div class="ghead">${lg}<div class="mono top">Consiglio Zero · ${esc(g.name)}</div></div>
      <div class="display title">Dono del Consiglio</div>
      <div class="qr">${await qr(`${base}/d/${b.token}`)}</div>
      <p>Scansionatelo con l'app dei Giochi («Scansiona»). Chi arriva primo lo prende.</p>
      <div class="mono top" style="margin-top:auto">Q${b.n}</div>
    </div>`));
  const sheets = [];
  for (let i = 0; i < cards.length; i += 4) sheets.push(`<section class="sheet gifts">${cards.slice(i, i + 4).join('')}</section>`);
  return { title: 'QR dei doni da abbinare', count: list.length, note: 'QR senza dono: abbinali sul campo inquadrandoli (Doni QR → «📷 Abbina QR»).', empty: 'Nessun QR libero: creane in Doni QR → «QR da abbinare».', sheets, css: GIFT_CSS };
}

const GROUPS = { settori: stations, altari: altars, doni: gifts, qrliberi: giftBlanksPrint, uscita: exitSign, credenziali: credentials };

function doc(g, parts, title) {
  const count = parts.reduce((n, p) => n + p.count, 0);
  const body = parts.map((p) => (p.sheets.length ? p.sheets.join('\n') : parts.length === 1 ? `<p style="padding:40px">${esc(p.empty)}</p>` : '')).join('\n');
  const note = parts.length === 1 ? parts[0].note : parts.filter((p) => p.count).map((p) => `${p.title}: ${p.count}`).join(' · ');
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ${esc(g.name)}</title><style>${BASE_CSS}${parts.map((p) => p.css).join('\n')}</style></head><body>
<div class="toolbar"><span>${count} ${count === 1 ? 'elemento' : 'elementi'} · ${esc(g.name)}</span><button onclick="print()">Stampa / Salva PDF</button><span>${esc(note || '')}</span></div>
${body || '<p style="padding:40px">Niente da stampare.</p>'}
</body></html>`;
}

// kind: un gruppo o «tutto»; sel: stringa «a1,g4,…» (vuota = tutto il gruppo).
async function page(kind, g, base, selText = '') {
  const sel = selText ? new Set(String(selText).split(',').map((s) => s.trim()).filter(Boolean)) : null;
  if (kind === 'tutto') {
    const parts = [];
    for (const k of Object.keys(GROUPS)) parts.push(await GROUPS[k](g, base, sel));
    return doc(g, parts, 'Tutte le stampe');
  }
  const fn = GROUPS[kind];
  if (!fn) return null;
  const part = await fn(g, base, sel);
  return doc(g, [part], part.title);
}

// Per la pagina Stampe della regia: gli elementi di ogni gruppo con l'anteprima del QR.
async function catalog(g, base) {
  const altarsList = q.all('SELECT * FROM points WHERE gameId = ?', g.id).map((p) => ({ ...p, s: G.sectorById(p.sectorId) })).sort((a, b) => a.s.ord - b.s.ord);
  const soglia = G.landmarksOf(g.id).find((l) => l.kind === 'soglia');
  const elect = G.electOf(g.id);
  const electList = elect ? G.membersOf(elect.id).map((m) => ({ ...m, p: q.get('SELECT loginToken, squadId FROM players WHERE id = ?', m.id) })).filter((m) => m.p?.loginToken) : [];
  const item = async (key, title, sub, url, extra = {}) => ({ key, title, sub, svg: await qr(url), ...extra });
  return {
    logo: { custom: logo().custom },
    groups: [
      { kind: 'settori', title: 'Postazioni nel Cerchio', hint: 'Un cartello A4 per Settore (tutti i Settori attivi): dove ogni coppia lascia il suo armamentario nel Cerchio.', items: sectorList().map((s) => { const t = G.teamsOf(g.id).find((x) => x.sectorId === s.id); return { key: `s${s.id}`, title: `${s.roman} Settore ${s.name}`, sub: t ? (t.displayName || 'Coppia formata') : 'Postazione', svg: sectorEmblem(s, 100) }; }) },
      { kind: 'altari', title: 'Altari', hint: 'Un cartello A4 per Altare, con «Non rimuovere».', items: await Promise.all(altarsList.map((p) => item(`a${p.id}`, p.label, `Settore ${p.s.roman} · ${p.s.name}`, `${base}/a/${p.qrToken}`))) },
      { kind: 'doni', title: 'Doni', hint: 'Quattro cartelli per foglio. Il tipo del dono non è stampato.', items: await Promise.all(giftRows(g).map((d) => item(`g${d.id}`, d.label, d.removeSign === 0 ? 'Non rimuovere il cartello' : 'Da rimuovere dopo la scansione', `${base}/d/${d.qrToken}`))) },
      { kind: 'qrliberi', title: 'QR dei doni da abbinare', hint: 'QR senza dono (quelli non ancora abbinati): si abbinano sul campo inquadrandoli da Doni QR.', items: await Promise.all(q.all('SELECT * FROM gift_blanks WHERE gameId = ? AND giftId IS NULL ORDER BY n', g.id).map((b) => item(`b${b.id}`, `QR libero n° ${b.n}`, 'Da abbinare a un dono', `${base}/d/${b.token}`, { deleteUrl: `/api/m/games/${g.id}/gift-blanks/${b.id}` }))) },
      { kind: 'uscita', title: 'Soglia', hint: 'Il codice di uscita da appendere alla Soglia.', items: soglia ? [await item(`u${soglia.id}`, 'Codice di uscita', 'La Soglia', `${base}/u/${soglia.exitToken}`)] : [] },
      { kind: 'credenziali', title: 'Credenziali', hint: 'Quattro tessere per foglio: accesso delle coppie e personale degli Eletti.', items: [
        ...await Promise.all(G.teamsOf(g.id).filter((t) => t.sectorId).map((t) => item(`t${t.id}`, `${t.roman} Settore ${t.sectorName}`, 'Accesso della coppia', `${base}/login/${t.loginToken}`))),
        ...await Promise.all(electList.map((m) => item(`p${m.id}`, m.name, 'Eletto · accesso personale', `${base}/login/${m.p.loginToken}`))),
      ] },
    ],
  };
}

module.exports = { qr, page, catalog, logo, saveLogo, resetLogo };
