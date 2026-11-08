'use strict';
// Ristoro: panini e bevande in offerta libera (il prezzo è solo indicativo).
// - L'addetto del Consiglio (permesso «ristoro», o il master) crea le voci del menù e fissa l'ora limite.
// - Coppie, Eletti e Consiglio vedono il menù, riempiono il carrello e mandano l'ordine; possono modificarlo o
//   annullarlo finché l'ora limite non è passata.
// - Dopo l'ora limite non si ordina più: si può solo mandare una RICHIESTA d'ordine, che l'addetto accetta o
//   rifiuta. Ordini e richieste restano ben separati, per chi ordina e per l'addetto.
// - Ogni inserimento, modifica, annullamento e decisione resta nello storico con data e ora.
const { q, tx } = require('./db');
const G = require('./game');
const rt = require('./realtime');
const { HttpError } = require('./util');

const err = (status, msg) => new HttpError(status, msg);
const MAX_QTY = 20;
const MAX_LINES = 30;

const clean = (v, n) => String(v ?? '').trim().slice(0, n);
const price = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 1000) throw err(400, 'Offerta indicativa non valida');
  return Math.round(n * 100) / 100;
};
const isOpen = (g, now = Date.now()) => !g.foodDeadline || now < g.foodDeadline;
const changed = (gameId) => { rt.toStaff(gameId, 'food'); rt.toTeams(gameId, 'food', {}); };

// ---------------------------------------------------------------- menù (addetto)

const itemOut = (i) => ({ id: i.id, title: i.title, description: i.description || '', price: i.price, ord: i.ord, archived: !!i.archivedAt, createdAt: i.createdAt, updatedAt: i.updatedAt });
const menuOf = (gameId) => q.all('SELECT * FROM food_items WHERE gameId = ? AND archivedAt IS NULL ORDER BY ord, id', gameId).map(itemOut);

function saveItem(gameId, data, actor, itemId = null) {
  const g = G.getGame(gameId);
  const title = clean(data.title, 80);
  if (!title) throw err(400, 'Scrivi il nome della voce');
  const description = clean(data.description, 300) || null;
  const p = price(data.price);
  const now = Date.now();
  if (itemId) {
    const it = q.get('SELECT * FROM food_items WHERE id = ? AND gameId = ?', Number(itemId), g.id);
    if (!it) throw err(404, 'Voce non trovata');
    q.run('UPDATE food_items SET title = ?, description = ?, price = ?, ord = COALESCE(?, ord), updatedAt = ? WHERE id = ?', title, description, p, data.ord != null ? Number(data.ord) : null, now, it.id);
    G.log(g.id, actor, 'food_item_updated', { title });
  } else {
    const ord = (q.get('SELECT MAX(ord) AS m FROM food_items WHERE gameId = ?', g.id).m || 0) + 1;
    itemId = Number(q.run('INSERT INTO food_items (gameId, title, description, price, ord, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)', g.id, title, description, p, ord, now, now).lastInsertRowid);
    G.log(g.id, actor, 'food_item_added', { title });
  }
  changed(g.id);
  return itemOut(q.get('SELECT * FROM food_items WHERE id = ?', itemId));
}

// Una voce già ordinata non si cancella: esce dal menù (gli ordini restano com'erano).
function removeItem(gameId, itemId, actor) {
  const it = q.get('SELECT * FROM food_items WHERE id = ? AND gameId = ?', Number(itemId), Number(gameId));
  if (!it) throw err(404, 'Voce non trovata');
  const used = q.get('SELECT 1 FROM food_order_lines WHERE itemId = ? LIMIT 1', it.id);
  if (used) q.run('UPDATE food_items SET archivedAt = ?, updatedAt = ? WHERE id = ?', Date.now(), Date.now(), it.id);
  else q.run('DELETE FROM food_items WHERE id = ?', it.id);
  G.log(it.gameId, actor, 'food_item_removed', { title: it.title });
  changed(it.gameId);
  return { ok: true, archived: !!used };
}

function moveItem(gameId, itemId, dir) {
  const list = q.all('SELECT * FROM food_items WHERE gameId = ? AND archivedAt IS NULL ORDER BY ord, id', Number(gameId));
  const i = list.findIndex((x) => x.id === Number(itemId));
  const j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= list.length) return { ok: true };
  [list[i], list[j]] = [list[j], list[i]];
  tx(() => list.forEach((x, k) => q.run('UPDATE food_items SET ord = ? WHERE id = ?', k + 1, x.id)));
  changed(Number(gameId));
  return { ok: true };
}

function setDeadline(gameId, deadline, actor) {
  const g = G.getGame(gameId);
  const v = deadline == null || deadline === '' ? null : Number(deadline);
  if (v != null && !(v > 0)) throw err(400, 'Ora limite non valida');
  q.run('UPDATE games SET foodDeadline = ? WHERE id = ?', v, g.id);
  G.log(g.id, actor, 'food_deadline', { deadline: v });
  changed(g.id);
  return { deadline: v };
}

// ---------------------------------------------------------------- ordini

const linesOf = (orderId) => q.all('SELECT id, itemId, title, price, qty, delivered FROM food_order_lines WHERE orderId = ? ORDER BY id', orderId);
const logOf = (orderId) => q.all('SELECT at, action, by, summary FROM food_order_log WHERE orderId = ? ORDER BY id', orderId);
const summaryOf = (lines) => lines.map((l) => `${l.qty}× ${l.title}`).join(', ');
const orderOut = (o) => {
  const lines = linesOf(o.id);
  const total = lines.reduce((t, l) => t + (l.price || 0) * l.qty, 0);
  return { id: o.id, kind: o.kind, status: o.status, fromRequest: !!o.fromRequest, note: o.note || '', owner: { key: o.ownerKey, name: o.ownerName, kind: o.ownerKind, sub: o.ownerSub },
    lines, total: Math.round(total * 100) / 100, items: lines.reduce((t, l) => t + l.qty, 0), delivered: lines.reduce((t, l) => t + l.delivered, 0),
    createdAt: o.createdAt, updatedAt: o.updatedAt, cancelledAt: o.cancelledAt, decidedAt: o.decidedAt, decidedBy: o.decidedBy, log: logOf(o.id) };
};

// Le righe: solo voci del menù di questa partita, quantità da 1 a 20.
function readLines(gameId, lines) {
  if (!Array.isArray(lines)) throw err(400, 'Carrello non valido');
  const out = new Map();
  for (const l of lines.slice(0, MAX_LINES)) {
    const qty = Math.floor(Number(l?.qty));
    if (!(qty > 0)) continue;
    const it = q.get('SELECT * FROM food_items WHERE id = ? AND gameId = ? AND archivedAt IS NULL', Number(l.itemId), gameId);
    if (!it) throw err(409, 'Una voce del carrello non è più nel menù: ricarica e riprova');
    const prev = out.get(it.id);
    out.set(it.id, { itemId: it.id, title: it.title, price: it.price, qty: Math.min(MAX_QTY, (prev?.qty || 0) + qty) });
  }
  if (!out.size) throw err(400, 'Il carrello è vuoto');
  return [...out.values()];
}
function writeLines(orderId, lines) {
  q.run('DELETE FROM food_order_lines WHERE orderId = ?', orderId);
  for (const l of lines) q.run('INSERT INTO food_order_lines (orderId, itemId, title, price, qty) VALUES (?, ?, ?, ?, ?)', orderId, l.itemId, l.title, l.price, l.qty);
}
const addLog = (orderId, action, by, summary) => q.run('INSERT INTO food_order_log (orderId, at, action, by, summary) VALUES (?, ?, ?, ?, ?)', orderId, Date.now(), action, by, summary || null);

// owner: { key, name, kind, sub, gameId } (vedi server.js: coppia, Eletto o Consiglio).
function placeOrder(owner, data) {
  const g = G.getGame(owner.gameId);
  if (g.status === 'ended') throw err(409, 'La partita è finita');
  const lines = readLines(g.id, data.lines);
  const now = Date.now();
  // Prima dell'ora limite è un ordine; dopo, solo una richiesta d'ordine (decide l'addetto).
  const kind = isOpen(g, now) ? 'order' : 'request';
  const status = kind === 'order' ? 'active' : 'pending';
  const note = clean(data.note, 300) || null;
  const id = tx(() => {
    const oid = Number(q.run('INSERT INTO food_orders (gameId, ownerKey, ownerName, ownerKind, ownerSub, kind, status, note, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      g.id, owner.key, owner.name, owner.kind, owner.sub || null, kind, status, note, now, now).lastInsertRowid);
    writeLines(oid, lines);
    addLog(oid, kind === 'order' ? 'created' : 'requested', owner.name, summaryOf(lines));
    return oid;
  });
  G.log(g.id, owner.name, kind === 'order' ? 'food_order' : 'food_request', { items: summaryOf(lines) });
  if (kind === 'request') rt.pushMasters({ title: '🥪 Richiesta d\'ordine', body: `${owner.name}: ${summaryOf(lines)} (dopo l'ora limite)`, url: '/regia#ristoro' });
  changed(g.id);
  return orderOut(q.get('SELECT * FROM food_orders WHERE id = ?', id));
}

function ownOrder(owner, orderId) {
  const o = q.get('SELECT * FROM food_orders WHERE id = ? AND gameId = ? AND ownerKey = ?', Number(orderId), owner.gameId, owner.key);
  if (!o) throw err(404, 'Ordine non trovato');
  return o;
}
// Si modifica o annulla: l'ordine fino all'ora limite, la richiesta finché l'addetto non ha deciso.
function editable(o, g, now = Date.now()) {
  if (o.status === 'cancelled') throw err(409, 'Già annullato');
  if (q.get('SELECT 1 AS x FROM food_order_lines WHERE orderId = ? AND delivered > 0', o.id)) throw err(409, 'Già consegnato (anche solo in parte): per cambiarlo parla con il Consiglio');
  if (o.kind === 'order' && !isOpen(g, now)) throw err(409, 'L\'ora limite è passata: l\'ordine non si cambia più. Per modifiche parla con il Consiglio, oppure manda una nuova richiesta d\'ordine.');
  if (o.kind === 'request' && o.status !== 'pending') throw err(409, `La richiesta è già stata ${o.status === 'accepted' ? 'accettata' : 'rifiutata'} dal Consiglio`);
}

function updateOrder(owner, orderId, data) {
  const o = ownOrder(owner, orderId);
  const g = G.getGame(o.gameId);
  editable(o, g);
  const lines = readLines(g.id, data.lines);
  const note = data.note !== undefined ? clean(data.note, 300) || null : o.note;
  tx(() => {
    writeLines(o.id, lines);
    q.run('UPDATE food_orders SET note = ?, updatedAt = ? WHERE id = ?', note, Date.now(), o.id);
    addLog(o.id, 'updated', owner.name, summaryOf(lines));
  });
  G.log(g.id, owner.name, 'food_order_updated', { items: summaryOf(lines), kind: o.kind });
  changed(g.id);
  return orderOut(q.get('SELECT * FROM food_orders WHERE id = ?', o.id));
}

function cancelOrder(owner, orderId) {
  const o = ownOrder(owner, orderId);
  const g = G.getGame(o.gameId);
  editable(o, g);
  const now = Date.now();
  q.run("UPDATE food_orders SET status = 'cancelled', cancelledAt = ?, updatedAt = ? WHERE id = ?", now, now, o.id);
  addLog(o.id, 'cancelled', owner.name, null);
  G.log(g.id, owner.name, 'food_order_cancelled', { kind: o.kind });
  changed(g.id);
  return { ok: true };
}

// Le notifiche di chi ha ordinato (coppia o Eletto; il Consiglio non ne ha).
const ownerSubs = (key) => (key.startsWith('p') ? q.all('SELECT * FROM push_subs WHERE playerId = ?', Number(key.slice(1)))
  : key.startsWith('t') ? q.all('SELECT * FROM push_subs WHERE teamId = ?', Number(key.slice(1))) : []);

// L'addetto accetta o rifiuta una richiesta arrivata dopo l'ora limite. Accettata, diventa un ordine.
// Una rifiutata si può rimettere in attesa.
function decideRequest(gameId, orderId, decision, actor) {
  const o = q.get("SELECT * FROM food_orders WHERE id = ? AND gameId = ? AND kind = 'request'", Number(orderId), Number(gameId));
  if (!o) throw err(404, 'Richiesta non trovata');
  if (o.status === 'cancelled') throw err(409, 'Richiesta annullata da chi l\'aveva fatta');
  if (!['accept', 'reject', 'pending'].includes(decision)) throw err(400, 'Decisione non valida');
  if (decision === 'pending' && o.status !== 'rejected') throw err(409, 'Si rimette in attesa solo una richiesta rifiutata');
  if (decision === 'reject' && o.status === 'rejected') throw err(409, 'Già rifiutata');
  const status = decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : 'pending';
  const now = Date.now();
  if (status === 'accepted') q.run("UPDATE food_orders SET kind = 'order', status = 'active', fromRequest = 1, decidedAt = ?, decidedBy = ?, updatedAt = ? WHERE id = ?", now, actor, now, o.id);
  else q.run('UPDATE food_orders SET status = ?, decidedAt = ?, decidedBy = ?, updatedAt = ? WHERE id = ?', status, status === 'pending' ? null : now, status === 'pending' ? null : actor, now, o.id);
  addLog(o.id, status === 'accepted' ? 'accepted' : status === 'rejected' ? 'rejected' : 'reopened', actor, null);
  G.log(o.gameId, actor, 'food_request_decided', { owner: o.ownerName, status });
  const subs = ownerSubs(o.ownerKey);
  if (status !== 'pending' && subs.length) rt.pushSubs(subs, { title: status === 'accepted' ? '🥪 Richiesta accettata' : '🥪 Richiesta rifiutata', body: status === 'accepted' ? 'Il Consiglio ha accettato la vostra richiesta: ora è un ordine.' : 'Il Consiglio non può accettare la vostra richiesta d\'ordine.', tag: `food-${o.id}`, url: '/#/ristoro' });
  changed(o.gameId);
  return orderOut(q.get('SELECT * FROM food_orders WHERE id = ?', o.id));
}

// ---------------------------------------------------------------- consegna e pagamento

const METHODS = { contanti: 'Contanti', satispay: 'Satispay', paypal: 'PayPal' };
const paymentOut = (p) => (p ? { id: p.id, method: p.method, methodLabel: METHODS[p.method] || p.method, amount: p.amount, note: p.note || '', at: p.at, by: p.by, closes: !!p.closes,
  pending: !!p.pending && !p.cancelledAt, rejected: !!p.rejectedAt, confirmedAt: p.confirmedAt || null, confirmedBy: p.confirmedBy || null } : null);
// Da consegnare: ordini attivi e richieste accettate.
const deliverable = (o) => o.kind === 'order' && o.status === 'active';
const payLinks = (g) => ({ paypal: g.foodPaypal || null, satispay: g.foodSatispay || null });

function setPayLinks(gameId, data, actor) {
  const g = G.getGame(gameId);
  const url = (v) => {
    const s = clean(v, 300);
    if (!s) return null;
    if (!/^https:\/\/[^\s"'<>]+$/i.test(s)) throw err(400, 'Il link deve iniziare con https://');
    return s;
  };
  const paypal = data.paypal !== undefined ? url(data.paypal) : g.foodPaypal;
  const satispay = data.satispay !== undefined ? url(data.satispay) : g.foodSatispay;
  q.run('UPDATE games SET foodPaypal = ?, foodSatispay = ? WHERE id = ?', paypal, satispay, g.id);
  G.log(g.id, actor, 'food_pay_links', { paypal: !!paypal, satispay: !!satispay });
  changed(g.id);
  return payLinks({ foodPaypal: paypal, foodSatispay: satispay });
}

const round = (n) => Math.round(n * 100) / 100;
const readAmount = (v) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 10000) throw err(400, 'Importo non valido');
  return round(n);
};

// Righe ancora da consegnare a una persona (ordini attivi e richieste accettate).
function openLines(gameId, ownerKey) {
  const orders = q.all('SELECT * FROM food_orders WHERE gameId = ? AND ownerKey = ?', gameId, String(ownerKey)).filter(deliverable);
  const out = [];
  for (const o of orders) for (const l of q.all('SELECT * FROM food_order_lines WHERE orderId = ?', o.id)) out.push({ ...l, order: o });
  return { orders, lines: out };
}

// Consegna: tutto quello che manca (all) oppure solo alcune quantità ({ lineId, qty }). Il pagamento è a parte.
function deliver(gameId, ownerKey, data, actor) {
  const g = G.getGame(gameId);
  const { orders, lines } = openLines(g.id, ownerKey);
  if (!orders.length) throw err(404, 'Nessun ordine da consegnare per questa persona');
  const want = new Map();
  if (data.all) for (const l of lines) { if (l.qty > l.delivered) want.set(l.id, l.qty - l.delivered); }
  else for (const x of Array.isArray(data.lines) ? data.lines : []) {
    const qty = Math.floor(Number(x?.qty));
    if (qty > 0) want.set(Number(x.lineId), (want.get(Number(x.lineId)) || 0) + qty);
  }
  if (!want.size) throw err(400, 'Niente da consegnare');
  const done = [];
  for (const [lineId, qty] of want) {
    const l = lines.find((x) => x.id === lineId);
    if (!l) throw err(409, 'Una voce non è più da consegnare: ricarica e riprova');
    if (qty > l.qty - l.delivered) throw err(409, `${l.title}: ne mancano solo ${l.qty - l.delivered}`);
    done.push({ l, qty });
  }
  const summary = done.map((x) => `${x.qty}× ${x.l.title}`).join(', ');
  const now = Date.now();
  const owner = orders[0];
  const id = tx(() => {
    for (const x of done) q.run('UPDATE food_order_lines SET delivered = delivered + ? WHERE id = ?', x.qty, x.l.id);
    const byOrder = new Map();
    for (const x of done) byOrder.set(x.l.orderId, [...(byOrder.get(x.l.orderId) || []), `${x.qty}× ${x.l.title}`]);
    for (const [oid, parts] of byOrder) { addLog(oid, 'delivered', actor, parts.join(', ')); q.run('UPDATE food_orders SET updatedAt = ? WHERE id = ?', now, oid); }
    return Number(q.run('INSERT INTO food_deliveries (gameId, ownerKey, ownerName, lines, summary, at, by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      g.id, owner.ownerKey, owner.ownerName, JSON.stringify(done.map((x) => ({ lineId: x.l.id, qty: x.qty }))), summary, now, actor).lastInsertRowid);
  });
  G.log(g.id, actor, 'food_delivered', { owner: owner.ownerName, items: summary });
  changed(g.id);
  return { id, summary };
}

function undeliver(gameId, deliveryId, actor) {
  const d = q.get('SELECT * FROM food_deliveries WHERE id = ? AND gameId = ? AND cancelledAt IS NULL', Number(deliveryId), Number(gameId));
  if (!d) throw err(404, 'Consegna non trovata');
  const now = Date.now();
  tx(() => {
    q.run('UPDATE food_deliveries SET cancelledAt = ?, cancelledBy = ? WHERE id = ?', now, actor, d.id);
    for (const x of JSON.parse(d.lines)) {
      const l = q.get('SELECT * FROM food_order_lines WHERE id = ?', x.lineId);
      if (!l) continue;
      q.run('UPDATE food_order_lines SET delivered = MAX(0, delivered - ?) WHERE id = ?', x.qty, l.id);
      addLog(l.orderId, 'undelivered', actor, `${x.qty}× ${l.title}`);
    }
  });
  G.log(d.gameId, actor, 'food_undelivered', { owner: d.ownerName });
  changed(d.gameId);
  return { ok: true };
}

// Pagamento della persona (prima o dopo il ritiro, anche a rate). «closes»: offerta libera, il resto non è dovuto.
function pay(gameId, ownerKey, data, actor) {
  const g = G.getGame(gameId);
  const method = String(data.method || '');
  if (!METHODS[method]) throw err(400, 'Scegli come ha pagato');
  const amount = readAmount(data.amount);
  const closes = !!data.closes;
  if (!amount && !closes) throw err(400, 'Scrivi quanto ha pagato');
  const { orders } = openLines(g.id, ownerKey);
  if (!orders.length) throw err(409, 'Nessun ordine per questa persona');
  const o = orders[0];
  const id = Number(q.run('INSERT INTO food_payments (gameId, ownerKey, ownerName, method, amount, note, at, by, closes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    g.id, o.ownerKey, o.ownerName, method, amount, clean(data.note, 200) || null, Date.now(), actor, closes ? 1 : 0).lastInsertRowid);
  G.log(g.id, actor, 'food_paid', { owner: o.ownerName, method, amount, closes });
  changed(g.id);
  return paymentOut(q.get('SELECT * FROM food_payments WHERE id = ?', id));
}

// Chi ha ordinato paga in anticipo con Satispay o PayPal (fuori dall'app) e lo dichiara: resta in attesa finché
// la cassa non lo conferma. Non conta nel pagato finché non è confermato.
function declarePayment(owner, data) {
  const g = G.getGame(owner.gameId);
  const method = String(data.method || '');
  if (!['satispay', 'paypal'].includes(method)) throw err(400, 'Scegli Satispay o PayPal (i contanti si danno alla cassa)');
  if (!payLinks(g)[method]) throw err(409, `${METHODS[method]} non è attivo: paga alla cassa`);
  const amount = readAmount(data.amount);
  if (!amount) throw err(400, 'Scrivi quanto hai pagato');
  const { orders } = openLines(g.id, owner.key);
  if (!orders.length) throw err(409, 'Non hai ordini da pagare');
  if (q.get('SELECT COUNT(*) AS n FROM food_payments WHERE gameId = ? AND ownerKey = ? AND pending = 1 AND cancelledAt IS NULL', g.id, owner.key).n >= 5) throw err(429, 'Hai già troppi pagamenti in attesa di conferma');
  const id = Number(q.run('INSERT INTO food_payments (gameId, ownerKey, ownerName, method, amount, note, at, by, pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)',
    g.id, owner.key, owner.name, method, amount, clean(data.note, 200) || null, Date.now(), owner.name).lastInsertRowid);
  G.log(g.id, owner.name, 'food_pay_declared', { method, amount });
  rt.pushMasters({ title: '💶 Pagamento da verificare', body: `${owner.name}: ${METHODS[method]} ${amount.toFixed(2)} € (in anticipo)`, url: '/regia#ristoro-consegna' });
  changed(g.id);
  return paymentOut(q.get('SELECT * FROM food_payments WHERE id = ?', id));
}

function cancelDeclared(owner, paymentId) {
  const p = q.get('SELECT * FROM food_payments WHERE id = ? AND gameId = ? AND ownerKey = ? AND cancelledAt IS NULL', Number(paymentId), owner.gameId, owner.key);
  if (!p) throw err(404, 'Pagamento non trovato');
  if (!p.pending) throw err(409, 'La cassa l\'ha già confermato: per cambiarlo parla con il Consiglio');
  q.run('UPDATE food_payments SET cancelledAt = ?, cancelledBy = ? WHERE id = ?', Date.now(), owner.name, p.id);
  changed(p.gameId);
  return { ok: true };
}

// La cassa conferma (eventualmente correggendo l'importo arrivato) o dice che non è arrivato.
function confirmPayment(gameId, paymentId, data, actor) {
  const p = q.get('SELECT * FROM food_payments WHERE id = ? AND gameId = ? AND cancelledAt IS NULL AND pending = 1', Number(paymentId), Number(gameId));
  if (!p) throw err(404, 'Pagamento in attesa non trovato');
  const amount = data.amount != null && data.amount !== '' ? readAmount(data.amount) : p.amount;
  if (!amount) throw err(400, 'Importo non valido');
  q.run('UPDATE food_payments SET pending = 0, amount = ?, closes = ?, confirmedAt = ?, confirmedBy = ? WHERE id = ?', amount, data.closes ? 1 : 0, Date.now(), actor, p.id);
  G.log(p.gameId, actor, 'food_pay_confirmed', { owner: p.ownerName, method: p.method, amount });
  const subs = ownerSubs(p.ownerKey);
  if (subs.length) rt.pushSubs(subs, { title: '💶 Pagamento confermato', body: `La cassa ha ricevuto ${amount.toFixed(2)} € con ${METHODS[p.method]}.`, tag: `foodpay-${p.id}`, url: '/#/ristoro' });
  changed(p.gameId);
  return paymentOut(q.get('SELECT * FROM food_payments WHERE id = ?', p.id));
}

function rejectPayment(gameId, paymentId, actor) {
  const p = q.get('SELECT * FROM food_payments WHERE id = ? AND gameId = ? AND cancelledAt IS NULL AND pending = 1', Number(paymentId), Number(gameId));
  if (!p) throw err(404, 'Pagamento in attesa non trovato');
  const now = Date.now();
  q.run('UPDATE food_payments SET cancelledAt = ?, cancelledBy = ?, rejectedAt = ? WHERE id = ?', now, actor, now, p.id);
  G.log(p.gameId, actor, 'food_pay_rejected', { owner: p.ownerName, method: p.method, amount: p.amount });
  const subs = ownerSubs(p.ownerKey);
  if (subs.length) rt.pushSubs(subs, { title: '💶 Pagamento non arrivato', body: `La cassa non trova il pagamento di ${p.amount.toFixed(2)} € con ${METHODS[p.method]}: passate alla cassa.`, tag: `foodpay-${p.id}`, url: '/#/ristoro' });
  changed(p.gameId);
  return { ok: true };
}

function unpay(gameId, paymentId, actor) {
  const p = q.get('SELECT * FROM food_payments WHERE id = ? AND gameId = ? AND cancelledAt IS NULL', Number(paymentId), Number(gameId));
  if (!p) throw err(404, 'Pagamento non trovato');
  q.run('UPDATE food_payments SET cancelledAt = ?, cancelledBy = ? WHERE id = ?', Date.now(), actor, p.id);
  G.log(p.gameId, actor, 'food_unpaid', { owner: p.ownerName });
  changed(p.gameId);
  return { ok: true };
}

const deliveryOut = (d) => ({ id: d.id, summary: d.summary, at: d.at, by: d.by });
// Il conto di una persona: totale indicativo, pagato, quanto resta; voci consegnate e da consegnare.
function accountOf(orders, all) {
  const payments = all.filter((x) => !x.pending && !x.rejected);
  const pendingAmount = round(all.filter((x) => x.pending).reduce((t, x) => t + x.amount, 0));
  const total = round(orders.reduce((t, o) => t + o.total, 0));
  const paid = round(payments.reduce((t, x) => t + x.amount, 0));
  const closed = payments.some((x) => x.closes);
  const items = orders.reduce((t, o) => t + o.items, 0);
  const delivered = orders.reduce((t, o) => t + o.delivered, 0);
  const toPay = closed ? 0 : round(Math.max(0, total - paid));
  return { total, paid, toPay, closed, items, delivered, toDeliver: items - delivered, pendingAmount, deliveredAll: items > 0 && delivered >= items, paidAll: closed || (total > 0 ? paid >= total : paid > 0) };
}

// Persone da servire: ordini divisi, cosa manca da consegnare, quanto manca da pagare; consegne e pagamenti.
function deliveryOf(gameId, orders) {
  const people = new Map();
  for (const o of orders.filter(deliverable)) {
    const p = people.get(o.owner.key) || { key: o.owner.key, owner: o.owner, orders: [] };
    p.orders.push(o);
    people.set(o.owner.key, p);
  }
  const pays = q.all('SELECT * FROM food_payments WHERE gameId = ? AND cancelledAt IS NULL ORDER BY at', gameId);
  const dels = q.all('SELECT * FROM food_deliveries WHERE gameId = ? AND cancelledAt IS NULL ORDER BY at', gameId);
  return [...people.values()].map((p) => {
    const all = pays.filter((x) => x.ownerKey === p.key).map(paymentOut);
    const a = accountOf(p.orders, all);
    return { ...p, payments: all.filter((x) => !x.pending), pendingPayments: all.filter((x) => x.pending), deliveries: dels.filter((x) => x.ownerKey === p.key).map(deliveryOut), ...a, done: a.deliveredAll && a.paidAll };
  }).sort((a, b) => b.pendingPayments.length - a.pendingPayments.length || a.done - b.done || a.owner.name.localeCompare(b.owner.name));
}

// ---------------------------------------------------------------- viste

// Per chi ordina: menù, ora limite e i propri ordini e richieste.
function forOwner(owner) {
  const g = G.getGame(owner.gameId);
  const orders = q.all('SELECT * FROM food_orders WHERE gameId = ? AND ownerKey = ? ORDER BY id DESC', g.id, owner.key).map(orderOut);
  const payments = q.all('SELECT * FROM food_payments WHERE gameId = ? AND ownerKey = ? AND (cancelledAt IS NULL OR rejectedAt IS NOT NULL) ORDER BY at', g.id, owner.key).map(paymentOut);
  return {
    gameId: g.id, gameName: g.name, deadline: g.foodDeadline || null, open: isOpen(g), ended: g.status === 'ended', serverNow: Date.now(),
    menu: menuOf(g.id), payLinks: payLinks(g),
    orders, payments, account: accountOf(orders.filter(deliverable), payments),
    me: { name: owner.name, kind: owner.kind, sub: owner.sub || null },
  };
}

// Per l'app: quante voci ha il menù e se si ordina ancora (la sezione Ristoro c'è sempre).
function teamSummary(gameId) {
  const g = G.getGame(gameId);
  const n = q.get('SELECT COUNT(*) AS n FROM food_items WHERE gameId = ? AND archivedAt IS NULL', g.id).n;
  return { items: n, deadline: g.foodDeadline || null, open: isOpen(g) };
}

// Per l'addetto: menù (anche le voci tolte), ora limite, ordini e richieste separati, quantità da preparare.
function forStaff(gameId) {
  const g = G.getGame(gameId);
  const all = q.all('SELECT * FROM food_orders WHERE gameId = ? ORDER BY createdAt', g.id).map(orderOut);
  const orders = all.filter((o) => o.kind === 'order');
  const requests = all.filter((o) => o.kind === 'request');
  const count = (list) => {
    const m = new Map();
    for (const o of list) for (const l of o.lines) {
      const k = l.itemId || l.title;
      const x = m.get(k) || { title: l.title, qty: 0, offer: 0 };
      x.qty += l.qty; x.offer += (l.price || 0) * l.qty; m.set(k, x);
    }
    return [...m.values()].sort((a, b) => b.qty - a.qty);
  };
  const live = orders.filter((o) => o.status === 'active');
  const accepted = live.filter((o) => o.fromRequest);
  return {
    gameId: g.id, gameName: g.name, deadline: g.foodDeadline || null, open: isOpen(g), serverNow: Date.now(),
    items: q.all('SELECT * FROM food_items WHERE gameId = ? ORDER BY archivedAt IS NOT NULL, ord, id', g.id).map(itemOut),
    orders, requests,
    totals: { orders: count(live), accepted: count(accepted), all: count(live) },
    counts: { orders: live.length, pending: requests.filter((o) => o.status === 'pending').length, accepted: accepted.length, payPending: q.get('SELECT COUNT(*) AS n FROM food_payments WHERE gameId = ? AND cancelledAt IS NULL AND pending = 1', g.id).n },
    delivery: deliveryOf(g.id, all), payLinks: payLinks(g),
    payments: q.all('SELECT * FROM food_payments WHERE gameId = ? AND cancelledAt IS NULL AND pending = 0 ORDER BY at', g.id).map(paymentOut),
  };
}

// QR dei link per pagare, da mostrare alla consegna.
async function payQr(gameId) {
  const QRCode = require('qrcode');
  const l = payLinks(G.getGame(gameId));
  const out = {};
  for (const k of ['paypal', 'satispay']) if (l[k]) out[k] = await QRCode.toString(l[k], { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return out;
}

module.exports = {
  setPayLinks, pay, unpay, deliver, undeliver, declarePayment, cancelDeclared, confirmPayment, rejectPayment, payQr, METHODS, saveItem, removeItem, moveItem, setDeadline, placeOrder, updateOrder, cancelOrder, decideRequest, forOwner, forStaff, teamSummary, menuOf, isOpen };
