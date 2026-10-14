'use strict';
// Pagine A4 stampabili (Stampa → Salva come PDF): cartelli degli Altari e credenziali delle coppie.
const QRCode = require('qrcode');
const { q } = require('./db');
const G = require('./game');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const qr = (text) => QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'Q' });

const BASE_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Big+Shoulders+Stencil+Display:wght@800;900&family=IBM+Plex+Mono:wght@400;600&family=Source+Serif+4:ital,wght@0,400;0,600;1,400&display=swap');
@page{size:A4;margin:0}
*{box-sizing:border-box}
html,body{margin:0;background:#E3E1D8;color:#1C211E;font-family:"Source Serif 4",Georgia,serif}
.toolbar{position:sticky;top:0;background:#1C211E;color:#E3E1D8;padding:12px 20px;display:flex;gap:16px;align-items:center;font-family:"IBM Plex Mono",monospace;font-size:14px;z-index:2}
.toolbar button{font:inherit;background:#8E2A1F;color:#fff;border:0;padding:10px 18px;cursor:pointer}
.sheet{width:210mm;height:297mm;margin:16px auto;background:#ECEAE2;position:relative;overflow:hidden;page-break-after:always;break-after:page}
.mono{font-family:"IBM Plex Mono",monospace}
.display{font-family:"Big Shoulders Stencil Display",Impact,sans-serif;text-transform:uppercase}
@media print{.toolbar{display:none}.sheet{margin:0;box-shadow:none}html,body{background:#fff}}
`;

async function altarsPage(g, base) {
  const points = q.all('SELECT * FROM points WHERE gameId = ?', g.id)
    .map((p) => ({ ...p, s: G.sectorById(p.sectorId) }))
    .sort((a, b) => a.s.ord - b.s.ord);
  const sheets = await Promise.all(points.map(async (p) => `
  <section class="sheet altar">
    <div class="frame">
      <div class="top mono">Consiglio Zero · Avviso ai Legati · ${esc(g.name)}</div>
      <div class="emblem"><span class="display">${esc(p.s.roman)}</span></div>
      <h1 class="display">${esc(p.label)}</h1>
      <div class="sector mono">Settore ${esc(p.s.roman)} · ${esc(p.s.name)} — ${esc(p.s.element)}</div>
      <div class="qr">${await qr(`${base}/a/${p.qrToken}`)}</div>
      <p class="how">Inquadrate il segno con l'app dei Giochi («Scansiona Altare»). Allontanatevi. Poi pronunciate nell'app il Sigillo del Settore ${esc(p.s.name)}.</p>
      <div class="motto display">«${esc(p.s.motto)}»</div>
      <div class="warn mono">Non staccate questo avviso. Restate a 20 metri da chi lo sta inquadrando.</div>
    </div>
  </section>`));
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cartelli Altari — ${esc(g.name)}</title><style>${BASE_CSS}
.altar .frame{position:absolute;inset:12mm;border:3mm solid #1C211E;padding:12mm 14mm;display:flex;flex-direction:column;align-items:center;text-align:center;gap:6mm}
.altar .frame::after{content:"";position:absolute;inset:3mm;border:.6mm solid #8E2A1F;pointer-events:none}
.top{font-size:10pt;letter-spacing:.14em;text-transform:uppercase;color:#5B615A}
.emblem{width:26mm;height:26mm;border-radius:50%;border:2mm solid #1C211E;display:grid;place-items:center}
.emblem span{font-size:16mm;line-height:1;font-weight:900}
h1{font-size:30mm;line-height:.85;margin:0;font-weight:900}
.sector{font-size:13pt;color:#8E2A1F;font-weight:600}
.qr{width:105mm;height:105mm;background:#fff;padding:5mm;border:1mm solid #1C211E}
.qr svg{width:100%;height:100%;display:block}
.how{font-size:13pt;max-width:140mm;margin:0}
.motto{font-size:14mm;color:#8E2A1F;font-weight:800}
.warn{font-size:9pt;color:#5B615A;margin-top:auto}
</style></head><body>
<div class="toolbar"><span>${points.length} cartelli · ${esc(g.name)}</span><button onclick="print()">Stampa / Salva PDF</button><span>Nessun Sigillo e nessun frammento è stampato sui cartelli.</span></div>
${sheets.join('\n') || '<p style="padding:40px">Nessun Altare: forma le coppie e sincronizza gli Altari.</p>'}
</body></html>`;
}

async function credentialsPage(g, base) {
  const teams = G.teamsOf(g.id).filter((t) => t.sectorId);
  const cards = await Promise.all(teams.map(async (t) => {
    const members = q.all('SELECT name, nickname FROM players WHERE teamId = ? ORDER BY id', t.id);
    return `<div class="card">
      <div class="head"><span class="display roman">${esc(t.roman)}</span><div><div class="display name">Settore ${esc(t.sectorName)}</div>
      <div class="members">${members.map((m) => esc(m.name + (m.nickname ? ` «${m.nickname}»` : ''))).join(' · ')}</div>
      ${t.displayName ? `<div class="mono small">${esc(t.displayName)}</div>` : ''}</div></div>
      <div class="body"><div class="qr">${await qr(`${base}/login/${t.loginToken}`)}</div>
      <div class="info"><div class="mono small">Inquadrate per entrare nell'app<br>oppure aprite</div><div class="mono url">${esc(base)}</div>
      <div class="mono small">e inserite il codice d'accesso</div><div class="mono code">${esc(t.accessCode)}</div>
      <div class="mono small">Va bene su entrambi i telefoni della coppia.<br>Non è il vostro Sigillo.</div></div></div>
    </div>`;
  }));
  const elect = G.electOf(g.id);
  const electMembers = elect ? G.membersOf(elect.id) : [];
  // Eletti: ognuno ha il proprio accesso personale (niente codice comune).
  for (const m of electMembers) {
    const p = q.get('SELECT p.loginToken, p.accessCode, s.name AS squad FROM players p LEFT JOIN elect_squads s ON s.id = p.squadId WHERE p.id = ?', m.id);
    cards.push(`<div class="card">
      <div class="head"><span class="display roman">0</span><div><div class="display name">Eletto del Consiglio</div>
      <div class="members">${esc(m.name + (m.nickname ? ` «${m.nickname}»` : ''))}</div>
      ${p.squad ? `<div class="mono small">Squadra ${esc(p.squad)}</div>` : ''}</div></div>
      <div class="body"><div class="qr">${await qr(`${base}/login/${p.loginToken}`)}</div>
      <div class="info"><div class="mono small">Inquadra per entrare nell'app<br>oppure apri</div><div class="mono url">${esc(base)}</div>
      <div class="mono small">e inserisci il tuo codice personale</div><div class="mono code">${esc(p.accessCode)}</div>
      <div class="mono small">Accesso personale: non condividerlo.</div></div></div>
    </div>`);
  }
  const pages = [];
  for (let i = 0; i < cards.length; i += 4) pages.push(`<section class="sheet creds">${cards.slice(i, i + 4).join('')}</section>`);
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Credenziali coppie — ${esc(g.name)}</title><style>${BASE_CSS}
.creds{display:grid;grid-template-rows:repeat(4,1fr);padding:8mm;gap:6mm}
.card{border:1mm dashed #1C211E;padding:5mm 7mm;display:grid;gap:3mm;align-content:start}
.head{display:flex;gap:5mm;align-items:center}
.roman{font-size:14mm;font-weight:900;color:#8E2A1F;min-width:18mm;text-align:center}
.name{font-size:9mm;font-weight:900;line-height:1}
.members{font-size:11pt}
.body{display:flex;gap:7mm;align-items:center}
.qr{width:40mm;height:40mm;background:#fff;padding:2mm;flex:none}
.qr svg{width:100%;height:100%;display:block}
.info{display:grid;gap:1.5mm}
.small{font-size:8.5pt;color:#5B615A}
.url{font-size:11pt;font-weight:600}
.code{font-size:20pt;font-weight:600;letter-spacing:.18em}
</style></head><body>
<div class="toolbar"><span>${teams.length} coppie${electMembers.length ? ' + Eletti' : ''} · ${esc(g.name)}</span><button onclick="print()">Stampa / Salva PDF</button><span>Ritagliate lungo il tratteggio.</span></div>
${pages.join('\n') || '<p style="padding:40px">Nessuna coppia con Settore.</p>'}
</body></html>`;
}

// Cartelli dei doni QR: 4 per foglio. Il tipo non è stampato: si scopre solo prendendo il dono.
async function giftsPage(g, base) {
  const gifts = q.all('SELECT * FROM gifts WHERE gameId = ? ORDER BY id', g.id);
  const cards = await Promise.all(gifts.map(async (d) => `<div class="gift">
      <div class="mono top">Consiglio Zero · ${esc(g.name)}</div>
      <div class="display title">Dono del Consiglio</div>
      <div class="qr">${await qr(`${base}/d/${d.qrToken}`)}</div>
      <div class="display label">${esc(d.label)}</div>
      <p>Scansionatelo con l'app dei Giochi («Scansiona»). Chi arriva primo lo prende.</p>
    </div>`));
  const pages = [];
  for (let i = 0; i < cards.length; i += 4) pages.push(`<section class="sheet gifts">${cards.slice(i, i + 4).join('')}</section>`);
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cartelli Doni — ${esc(g.name)}</title><style>${BASE_CSS}
.gifts{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:6mm;padding:8mm}
.gift{border:1.2mm solid #1C211E;outline:.5mm solid #7D6226;outline-offset:-3mm;padding:7mm;display:flex;flex-direction:column;align-items:center;text-align:center;gap:3mm}
.gift .top{font-size:7.5pt;letter-spacing:.12em;text-transform:uppercase;color:#5B615A}
.gift .title{font-size:10mm;font-weight:900;line-height:1}
.gift .qr{width:62mm;height:62mm;background:#fff;padding:2mm}
.gift .qr svg{width:100%;height:100%;display:block}
.gift .label{font-size:8mm;font-weight:800;color:#7D6226}
.gift p{margin:0;font-size:9.5pt}
</style></head><body>
<div class="toolbar"><span>${gifts.length} doni · ${esc(g.name)}</span><button onclick="print()">Stampa / Salva PDF</button><span>Il tipo del dono non è stampato.</span></div>
${pages.join('\n') || '<p style="padding:40px">Nessun dono: creali nella sezione Doni QR della regia.</p>'}
</body></html>`;
}

module.exports = { altarsPage, credentialsPage, giftsPage };
