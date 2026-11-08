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

const linesOf = (orderId) => q.all('SELECT itemId, title, price, qty FROM food_order_lines WHERE orderId = ? ORDER BY id', orderId);
const logOf = (orderId) => q.all('SELECT at, action, by, summary FROM food_order_log WHERE orderId = ? ORDER BY id', orderId);
const summaryOf = (lines) => lines.map((l) => `${l.qty}× ${l.title}`).join(', ');
const orderOut = (o) => {
  const lines = linesOf(o.id);
  const total = lines.reduce((t, l) => t + (l.price || 0) * l.qty, 0);
  return { id: o.id, kind: o.kind, status: o.status, note: o.note || '', owner: { key: o.ownerKey, name: o.ownerName, kind: o.ownerKind, sub: o.ownerSub },
    lines, total: Math.round(total * 100) / 100, items: lines.reduce((t, l) => t + l.qty, 0),
    createdAt: o.createdAt, updatedAt: o.updatedAt, cancelledAt: o.cancelledAt, decidedAt: o.decidedAt, decidedBy: o.decidedBy, log: logOf(o.id),
    payment: o.paymentId ? paymentOut(q.get('SELECT * FROM food_payments WHERE id = ? AND cancelledAt IS NULL', o.paymentId)) : null };
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
  if (o.paymentId) throw err(409, 'Già consegnato e pagato: per cambiarlo parla con il Consiglio');
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

// L'addetto accetta o rifiuta una richiesta arrivata dopo l'ora limite.
function decideRequest(gameId, orderId, decision, actor) {
  const o = q.get("SELECT * FROM food_orders WHERE id = ? AND gameId = ? AND kind = 'request'", Number(orderId), Number(gameId));
  if (!o) throw err(404, 'Richiesta non trovata');
  if (o.status === 'cancelled') throw err(409, 'Richiesta annullata da chi l\'aveva fatta');
  if (!['accept', 'reject', 'pending'].includes(decision)) throw err(400, 'Decisione non valida');
  const status = decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : 'pending';
  const now = Date.now();
  q.run('UPDATE food_orders SET status = ?, decidedAt = ?, decidedBy = ?, updatedAt = ? WHERE id = ?', status, status === 'pending' ? null : now, status === 'pending' ? null : actor, now, o.id);
  addLog(o.id, status === 'accepted' ? 'accepted' : status === 'rejected' ? 'rejected' : 'reopened', actor, null);
  G.log(o.gameId, actor, 'food_request_decided', { owner: o.ownerName, status });
  const subs = o.ownerKey.startsWith('p') ? q.all('SELECT * FROM push_subs WHERE playerId = ?', Number(o.ownerKey.slice(1)))
    : o.ownerKey.startsWith('t') ? q.all('SELECT * FROM push_subs WHERE teamId = ?', Number(o.ownerKey.slice(1))) : [];
  if (status !== 'pending' && subs.length) rt.pushSubs(subs, { title: status === 'accepted' ? '🥪 Richiesta accettata' : '🥪 Richiesta rifiutata', body: status === 'accepted' ? 'Il Consiglio ha accettato la vostra richiesta d\'ordine.' : 'Il Consiglio non può accettare la vostra richiesta d\'ordine.', tag: `food-${o.id}`, url: '/#/ristoro' });
  changed(o.gameId);
  return orderOut(q.get('SELECT * FROM food_orders WHERE id = ?', o.id));
}

// ---------------------------------------------------------------- consegna e pagamento

const METHODS = { contanti: 'Contanti', satispay: 'Satispay', paypal: 'PayPal' };
const paymentOut = (p) => (p ? { id: p.id, method: p.method, methodLabel: METHODS[p.method] || p.method, amount: p.amount, note: p.note || '', at: p.at, by: p.by } : null);
// Da consegnare: ordini attivi e richieste accettate.
const deliverable = (o) => (o.kind === 'order' && o.status === 'active') || (o.kind === 'request' && o.status === 'accepted');
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

// Paga (e consegna): copre tutti gli ordini da consegnare di quella persona non ancora pagati.
function pay(gameId, ownerKey, data, actor) {
  const g = G.getGame(gameId);
  const method = String(data.method || '');
  if (!METHODS[method]) throw err(400, 'Scegli come ha pagato');
  const amount = Number(String(data.amount ?? '').replace(',', '.'));
  if (!Number.isFinite(amount) || amount < 0 || amount > 10000) throw err(400, 'Importo non valido');
  const list = q.all('SELECT * FROM food_orders WHERE gameId = ? AND ownerKey = ? AND paymentId IS NULL', g.id, String(ownerKey)).filter(deliverable);
  if (!list.length) throw err(409, 'Niente da pagare per questa persona');
  const now = Date.now();
  const id = tx(() => {
    const pid = Number(q.run('INSERT INTO food_payments (gameId, ownerKey, ownerName, method, amount, note, at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      g.id, list[0].ownerKey, list[0].ownerName, method, Math.round(amount * 100) / 100, clean(data.note, 200) || null, now, actor).lastInsertRowid);
    for (const o of list) {
      q.run('UPDATE food_orders SET paymentId = ?, updatedAt = ? WHERE id = ?', pid, now, o.id);
      addLog(o.id, 'paid', actor, `${METHODS[method]} · ${amount.toFixed(2)} €`);
    }
    return pid;
  });
  G.log(g.id, actor, 'food_paid', { owner: list[0].ownerName, method, amount });
  changed(g.id);
  return paymentOut(q.get('SELECT * FROM food_payments WHERE id = ?', id));
}

function unpay(gameId, paymentId, actor) {
  const p = q.get('SELECT * FROM food_payments WHERE id = ? AND gameId = ? AND cancelledAt IS NULL', Number(paymentId), Number(gameId));
  if (!p) throw err(404, 'Pagamento non trovato');
  const now = Date.now();
  tx(() => {
    q.run('UPDATE food_payments SET cancelledAt = ?, cancelledBy = ? WHERE id = ?', now, actor, p.id);
    for (const o of q.all('SELECT id FROM food_orders WHERE paymentId = ?', p.id)) {
      q.run('UPDATE food_orders SET paymentId = NULL, updatedAt = ? WHERE id = ?', now, o.id);
      addLog(o.id, 'unpaid', actor, null);
    }
  });
  G.log(p.gameId, actor, 'food_unpaid', { owner: p.ownerName });
  changed(p.gameId);
  return { ok: true };
}

// Persone da servire: chi ha ordini da consegnare, con gli ordini divisi, il totale indicativo e il pagamento.
function deliveryOf(orders) {
  const people = new Map();
  for (const o of orders.filter(deliverable)) {
    const k = o.owner.key;
    const p = people.get(k) || { key: k, owner: o.owner, orders: [], toPay: [], paid: [], total: 0, toPayTotal: 0, firstAt: o.createdAt };
    p.orders.push(o);
    p.total += o.total;
    if (o.payment) p.paid.push(o); else { p.toPay.push(o); p.toPayTotal += o.total; }
    p.firstAt = Math.min(p.firstAt, o.createdAt);
    people.set(k, p);
  }
  return [...people.values()].map((p) => {
    const payments = [...new Map(p.paid.map((o) => [o.payment.id, o.payment])).values()];
    return { ...p, total: Math.round(p.total * 100) / 100, toPayTotal: Math.round(p.toPayTotal * 100) / 100, payments, done: !p.toPay.length };
  }).sort((a, b) => a.done - b.done || a.owner.name.localeCompare(b.owner.name));
}

// ---------------------------------------------------------------- viste

// Per chi ordina: menù, ora limite e i propri ordini e richieste.
function forOwner(owner) {
  const g = G.getGame(owner.gameId);
  return {
    gameId: g.id, gameName: g.name, deadline: g.foodDeadline || null, open: isOpen(g), ended: g.status === 'ended', serverNow: Date.now(),
    menu: menuOf(g.id), payLinks: payLinks(g),
    orders: q.all('SELECT * FROM food_orders WHERE gameId = ? AND ownerKey = ? ORDER BY id DESC', g.id, owner.key).map(orderOut),
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
  const accepted = requests.filter((o) => o.status === 'accepted');
  return {
    gameId: g.id, gameName: g.name, deadline: g.foodDeadline || null, open: isOpen(g), serverNow: Date.now(),
    items: q.all('SELECT * FROM food_items WHERE gameId = ? ORDER BY archivedAt IS NOT NULL, ord, id', g.id).map(itemOut),
    orders, requests,
    totals: { orders: count(live), accepted: count(accepted), all: count([...live, ...accepted]) },
    counts: { orders: live.length, pending: requests.filter((o) => o.status === 'pending').length, accepted: accepted.length },
    delivery: deliveryOf(all), payLinks: payLinks(g),
    payments: q.all('SELECT * FROM food_payments WHERE gameId = ? AND cancelledAt IS NULL ORDER BY at', g.id).map(paymentOut),
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
  setPayLinks, pay, unpay, payQr, METHODS, saveItem, removeItem, moveItem, setDeadline, placeOrder, updateOrder, cancelOrder, decideRequest, forOwner, forStaff, teamSummary, menuOf, isOpen };
