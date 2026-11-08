// Ristoro: menù di panini e bevande in offerta libera. Lo stesso modulo serve a chi ordina (app delle coppie e degli
// Eletti, Consiglio) e all'addetto (pagina /ristoro e regia).
// - Prima dell'ora limite si manda un ORDINE (modificabile e annullabile fino all'ora limite).
// - Dopo l'ora limite si può mandare solo una RICHIESTA d'ordine: la decide l'addetto (accetta o rifiuta).
import { h, api, toast, dialog, modal } from './lib.js';

const TZ = 'Europe/Rome';
export const fmtDT = (ts) => (ts ? new Date(ts).toLocaleString('it-IT', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
export const euro = (n) => (n == null ? null : Number(n).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' }));
// Prezzo grande a destra della voce: importo indicativo (o «offerta libera»), con la scritta piccola sotto.
const bigPrice = (p) => h('div', { class: 'food-bigprice' }, p == null ? [h('span', null, 'offerta'), h('strong', null, 'libera')] : [h('strong', null, euro(p)), h('span', null, 'offerta indicativa')]);
const offerText = (p) => (p == null ? 'offerta libera' : `offerta indicativa ${euro(p)}`);

const STATUS = {
  'order:active': ['Ordine', 'food-st-ok'],
  'order:cancelled': ['Ordine annullato', 'food-st-off'],
  'request:pending': ['Richiesta d\'ordine · in attesa', 'food-st-wait'],
  'request:accepted': ['Richiesta d\'ordine · accettata', 'food-st-ok'],
  'request:rejected': ['Richiesta d\'ordine · rifiutata', 'food-st-no'],
  'request:cancelled': ['Richiesta annullata', 'food-st-off'],
};
const LOG = { created: 'Ordine inviato', requested: 'Richiesta d\'ordine inviata', updated: 'Modificato', cancelled: 'Annullato', accepted: 'Richiesta accettata', rejected: 'Richiesta rifiutata', reopened: 'Rimessa in attesa', paid: 'Consegnato e pagato', unpaid: 'Pagamento annullato' };
const statusChip = (o) => { const [label, cls] = STATUS[`${o.kind}:${o.status}`] || [o.status, '']; return h('span', { class: `food-st ${cls}` }, label); };
const linesList = (o) => h('ul', { class: 'food-lines' }, o.lines.map((l) => h('li', null, h('b', { class: 'mono' }, `${l.qty}×`), ` ${l.title}`, l.price != null ? h('span', { class: 'tiny muted' }, ` · ${euro(l.price)}`) : null)));
const dates = (o) => h('div', { class: 'tiny muted' }, `Inviato ${fmtDT(o.createdAt)}`, o.updatedAt > o.createdAt + 1000 ? ` · ultima modifica ${fmtDT(o.updatedAt)}` : '');
const history = (o) => (o.log?.length > 1 ? h('details', { class: 'food-log' }, h('summary', { class: 'tiny' }, `Storico (${o.log.length})`),
  h('ul', { class: 'tiny' }, o.log.map((x) => h('li', null, `${fmtDT(x.at)} · ${LOG[x.action] || x.action}${x.by ? ` · ${x.by}` : ''}${x.summary ? ` · ${x.summary}` : ''}`)))) : null);

// ---------------------------------------------------------------- chi ordina

// base: '/api/food' (app) o '/api/v/food' (Consiglio); query(): '' oppure '?g=ID'.
export function createFoodOrder({ base, query = () => '', rerender }) {
  const S = { data: null, loading: false, cart: new Map(), note: '', editing: null, at: 0 };
  const url = (path = '') => `${base}${path}${query()}`;
  async function load(force = false) {
    if (S.loading || (!force && S.data && Date.now() - S.at < 15000)) return;
    S.loading = true;
    try { S.data = await api('GET', url()); S.at = Date.now(); } catch (e) { toast(e.message, 'error'); } finally { S.loading = false; rerender(); }
  }
  const reset = () => { S.cart.clear(); S.note = ''; S.editing = null; };
  const setQty = (id, q) => { if (q > 0) S.cart.set(id, Math.min(20, q)); else S.cart.delete(id); rerender(); };
  const edit = (o) => {
    reset();
    for (const l of o.lines) if (l.itemId && S.data.menu.some((m) => m.id === l.itemId)) S.cart.set(l.itemId, l.qty);
    S.note = o.note || ''; S.editing = o;
    rerender(); window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  async function send() {
    const d = S.data;
    const lines = [...S.cart].map(([itemId, qty]) => ({ itemId, qty }));
    if (!lines.length) return toast('Il carrello è vuoto', 'error');
    const isRequest = S.editing ? S.editing.kind === 'request' : !d.open;
    if (isRequest && !S.editing && !(await dialog({ title: 'Mandare una richiesta d\'ordine?', text: 'L\'ora limite è passata: questa NON è un ordine. È una richiesta che il Consiglio può accettare o rifiutare. Riceverai la risposta qui.', okLabel: 'Manda la richiesta' }))) return;
    try {
      if (S.editing) await api('PUT', url(`/orders/${S.editing.id}`), { lines, note: S.note });
      else await api('POST', url('/orders'), { lines, note: S.note });
      toast(S.editing ? 'Modifica salvata' : isRequest ? 'Richiesta d\'ordine inviata' : 'Ordine inviato', 'ok');
      reset(); await load(true);
    } catch (e) { toast(e.message, 'error', 7000); load(true); }
  }
  async function cancel(o) {
    if (!(await dialog({ title: o.kind === 'request' ? 'Annullare la richiesta?' : 'Annullare l\'ordine?', text: 'Resta nello storico come annullato.', okLabel: 'Annulla l\'ordine', cancelLabel: 'No', danger: true }))) return;
    try { await api('DELETE', url(`/orders/${o.id}`)); toast('Annullato', 'ok'); if (S.editing?.id === o.id) reset(); load(true); } catch (e) { toast(e.message, 'error', 7000); }
  }
  function view() {
    if (!S.data) { load(); return h('p', { class: 'empty' }, 'Caricamento del menù…'); }
    load();
    const d = S.data;
    const menu = d.menu;
    const total = menu.reduce((t, m) => t + (m.price || 0) * (S.cart.get(m.id) || 0), 0);
    const count = [...S.cart.values()].reduce((a, b) => a + b, 0);
    const isRequest = S.editing ? S.editing.kind === 'request' : !d.open;
    const canEdit = (o) => o.status !== 'cancelled' && !o.payment && (o.kind === 'order' ? d.open : o.status === 'pending');
    return h('div', { class: 'food stack' },
      h('div', { class: 'food-head' }, h('h2', null, '🥪 Ristoro'), h('p', { class: 'small muted' }, 'Panini e bevande dei Giochi.')),
      h('div', { class: 'food-free' }, h('strong', null, 'Offerta libera'), h('span', null, 'I prezzi sono solo un\'offerta indicativa: al ritiro ognuno lascia quello che vuole.'),
        h('span', { class: 'small' }, 'Si paga al ritiro: 💶 contanti', d.payLinks?.satispay ? [' · ', h('a', { href: d.payLinks.satispay, target: '_blank', rel: 'noopener' }, '📱 Satispay')] : '', d.payLinks?.paypal ? [' · ', h('a', { href: d.payLinks.paypal, target: '_blank', rel: 'noopener' }, '🅿️ PayPal')] : '', '.')),
      d.open
        ? h('div', { class: 'food-deadline open' }, h('strong', null, d.deadline ? `Ordini aperti fino a ${fmtDT(d.deadline)}` : 'Ordini aperti'),
          h('span', { class: 'small' }, d.deadline ? 'Fino all\'ora limite puoi modificare o annullare i tuoi ordini.' : 'Puoi modificare o annullare i tuoi ordini finché il Consiglio non fissa l\'ora limite.'))
        : h('div', { class: 'food-deadline closed' }, h('strong', null, `Ora limite passata (${fmtDT(d.deadline)})`),
          h('span', { class: 'small' }, 'Non si ordina più. Puoi solo mandare una ', h('b', null, 'RICHIESTA D\'ORDINE'), ': non è un ordine, il Consiglio deciderà se accettarla. Gli ordini già fatti non si cambiano più.')),
      d.ended ? h('p', { class: 'empty' }, 'La partita è finita.') : null,
      S.editing ? h('div', { class: 'food-editing' }, h('span', null, `Stai modificando ${S.editing.kind === 'request' ? 'la richiesta' : 'l\'ordine'} del ${fmtDT(S.editing.createdAt)}`),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { reset(); rerender(); } }, 'Lascia stare')) : null,
      menu.length ? h('ul', { class: 'food-menu' }, menu.map((m) => {
        const qn = S.cart.get(m.id) || 0;
        return h('li', { class: `food-item ${qn ? 'on' : ''}` },
          h('div', { class: 'food-item-main' }, h('strong', null, m.title), m.description ? h('span', { class: 'small muted' }, m.description) : null),
          h('div', { class: 'food-item-side' }, bigPrice(m.price), h('div', { class: 'food-qty' },
            h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': `Togli un ${m.title}`, disabled: !qn, onclick: () => setQty(m.id, qn - 1) }, '−'),
            h('b', { class: 'mono' }, String(qn)),
            h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': `Aggiungi un ${m.title}`, disabled: d.ended, onclick: () => setQty(m.id, qn + 1) }, '+'))));
      })) : h('p', { class: 'empty' }, 'Il menù non è ancora pronto.'),
      count ? h('div', { class: `food-cart ${isRequest ? 'is-request' : ''}` },
        h('div', { class: 'food-cart-head' }, h('strong', null, `${S.editing ? 'Modifica' : 'Carrello'}: ${count} ${count === 1 ? 'voce' : 'voci'}`), total ? h('span', { class: 'small' }, `offerta indicativa ${euro(total)}`) : null),
        h('textarea', { class: 'input', rows: 2, maxlength: 300, placeholder: 'Note (facoltative): es. senza cipolla, per due persone…', value: S.note, oninput: (e) => { S.note = e.target.value; } }),
        isRequest ? h('p', { class: 'small food-req-note' }, '⚠ Dopo l\'ora limite questa è una RICHIESTA d\'ordine, non un ordine: il Consiglio può accettarla o rifiutarla.') : null,
        h('button', { class: `btn btn-block ${isRequest ? 'btn-warn' : 'btn-primary'}`, type: 'button', onclick: send },
          S.editing ? 'Salva la modifica' : isRequest ? 'Manda la richiesta d\'ordine' : 'Invia l\'ordine')) : null,
      h('section', { class: 'stack-sm' }, h('h3', null, 'I tuoi ordini e richieste'),
        d.orders.length ? h('ul', { class: 'food-orders' }, d.orders.map((o) => h('li', { class: `food-order ${o.status === 'cancelled' ? 'off' : ''} ${o.kind}` },
          h('div', { class: 'food-order-head' }, statusChip(o), o.total ? h('span', { class: 'tiny muted' }, `offerta indicativa ${euro(o.total)}`) : null),
          linesList(o), o.note ? h('p', { class: 'small' }, `Note: ${o.note}`) : null, dates(o),
          o.decidedAt ? h('div', { class: 'tiny muted' }, `${o.status === 'accepted' ? 'Accettata' : 'Rifiutata'} ${fmtDT(o.decidedAt)}`) : null,
          o.payment ? h('div', { class: 'food-paid' }, `✓ Consegnato e pagato · ${o.payment.methodLabel} · ${fmtDT(o.payment.at)}`) : null,
          history(o),
          canEdit(o) && !d.ended ? h('div', { class: 'row-actions' },
            h('button', { class: 'btn btn-sm', type: 'button', onclick: () => edit(o) }, 'Modifica'),
            h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => cancel(o) }, 'Annulla')) : null))) : h('p', { class: 'empty' }, 'Non hai ancora ordinato niente.')));
  }
  return { view, load: () => load(true) };
}

// ---------------------------------------------------------------- addetto

// gameId(): la partita; tutto passa da /api/v/games/:id/food (permesso «ristoro» o master).
export function createFoodAdmin({ gameId, rerender }) {
  const S = { data: null, gid: null, loading: false, at: 0, tab: 'ordini' };
  const pending = () => S.data?.counts?.pending || 0;
  const base = () => `/api/v/games/${gameId()}/food`;
  async function load(force = false) {
    const gid = gameId();
    if (!gid || S.loading || (!force && S.data && S.gid === gid && Date.now() - S.at < 15000)) return;
    S.loading = true;
    try { S.data = await api('GET', base()); S.gid = gid; S.at = Date.now(); } catch (e) { toast(e.message, 'error'); } finally { S.loading = false; rerender(); }
  }
  const call = async (method, path, body, ok) => { try { await api(method, `${base()}${path}`, body); if (ok) toast(ok, 'ok'); await load(true); return true; } catch (e) { toast(e.message, 'error', 7000); return false; } };

  async function itemDialog(it = null) {
    const title = h('input', { class: 'input', maxlength: 80, value: it?.title || '', placeholder: 'es. Panino porchetta' });
    const desc = h('textarea', { class: 'input', rows: 2, maxlength: 300, placeholder: 'Descrizione (facoltativa)' });
    desc.value = it?.description || '';
    const price = h('input', { class: 'input', inputmode: 'decimal', value: it?.price ?? '', placeholder: 'es. 5 (vuoto = offerta libera)' });
    await modal({
      title: it ? 'Modifica la voce' : 'Nuova voce del menù', okLabel: it ? 'Salva' : 'Aggiungi',
      body: h('div', { class: 'stack-sm' },
        h('label', { class: 'field' }, h('span', null, 'Titolo'), title), h('label', { class: 'field' }, h('span', null, 'Descrizione'), desc),
        h('label', { class: 'field' }, h('span', null, 'Prezzo indicativo (€)'), price),
        h('p', { class: 'tiny muted' }, 'Il prezzo è un\'offerta indicativa: nell\'app compare sempre «offerta libera».')),
      onOpen: () => setTimeout(() => title.focus(), 50),
      onOk: async () => {
        const body = { title: title.value, description: desc.value, price: price.value };
        await api(it ? 'PUT' : 'POST', `${base()}/items${it ? `/${it.id}` : ''}`, body);
        toast(it ? 'Voce salvata' : 'Voce aggiunta', 'ok'); load(true); return true;
      },
    });
  }
  async function deadlineDialog() {
    const d = S.data;
    const toLocal = (ts) => { if (!ts) return ''; const x = new Date(ts); const p = (n) => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`; };
    const input = h('input', { class: 'input', type: 'datetime-local', value: toLocal(d.deadline) });
    await modal({
      title: 'Ora limite per ordinare', okLabel: 'Salva',
      body: h('div', { class: 'stack-sm' },
        // Scorciatoie da telefono: da adesso in avanti.
        h('div', { class: 'food-quick' }, [[30, 'Tra 30 min'], [60, 'Tra 1 ora'], [120, 'Tra 2 ore'], [0, 'Chiudi adesso']].map(([min, label]) => h('button', { type: 'button', class: `btn btn-sm ${min ? '' : 'btn-warn'}`, onclick: () => { const t = Date.now() + min * 60000; input.value = toLocal(Math.ceil(t / 60000) * 60000); } }, label))),
        h('label', { class: 'field' }, h('span', null, 'Fino a quando si ordina'), input),
        h('p', { class: 'tiny muted' }, 'Dopo quest\'ora non si fanno più ordini: si possono solo mandare RICHIESTE d\'ordine, che accetti o rifiuti tu. Gli ordini già fatti non si modificano più.')),
      onOk: async () => { if (!input.value) throw new Error('Scegli data e ora'); await call('PUT', '/deadline', { deadline: new Date(input.value).getTime() }, 'Ora limite salvata'); return true; },
    });
  }
  const who = (o) => h('div', { class: 'food-who' }, h('strong', null, o.owner.name), h('span', { class: `chip food-kind-${o.owner.kind}` }, o.owner.kind === 'consiglio' ? 'Consiglio' : o.owner.kind === 'eletto' ? 'Eletto' : 'Legati'),
    o.owner.sub ? h('span', { class: 'tiny muted' }, o.owner.sub) : null);
  const orderCard = (o) => h('li', { class: `food-order ${o.status === 'cancelled' || o.status === 'rejected' ? 'off' : ''} ${o.kind}` },
    h('div', { class: 'food-order-head' }, who(o), statusChip(o)),
    linesList(o), o.note ? h('p', { class: 'small' }, `Note: ${o.note}`) : null, dates(o),
    o.decidedAt ? h('div', { class: 'tiny muted' }, `${o.status === 'accepted' ? 'Accettata' : 'Rifiutata'} ${fmtDT(o.decidedAt)}${o.decidedBy ? ` da ${o.decidedBy}` : ''}`) : null,
    history(o),
    o.kind === 'request' && o.status !== 'cancelled' ? h('div', { class: 'row-actions' },
      o.status !== 'accepted' ? h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => call('POST', `/orders/${o.id}/decision`, { decision: 'accept' }, 'Richiesta accettata') }, 'Accetta') : null,
      o.status !== 'rejected' ? h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => call('POST', `/orders/${o.id}/decision`, { decision: 'reject' }, 'Richiesta rifiutata') }, 'Rifiuta') : null,
      o.status !== 'pending' ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => call('POST', `/orders/${o.id}/decision`, { decision: 'pending' }, 'Rimessa in attesa') }, 'Rimetti in attesa') : null) : null);
  const totalsTable = (list) => (list.length ? h('table', { class: 'food-totals' }, h('tbody', null, list.map((x) => h('tr', null, h('td', { class: 'mono' }, `${x.qty}×`), h('td', null, x.title), h('td', { class: 'tiny muted' }, x.offer ? euro(x.offer) : ''))))) : h('p', { class: 'tiny muted' }, 'Niente.'));

  // Paga: come ha pagato (contanti, Satispay, PayPal, con il QR da far inquadrare) e quanto (offerta libera).
  async function payDialog(p) {
    const d = S.data;
    let method = 'contanti';
    const amount = h('input', { class: 'input food-amount', inputmode: 'decimal', value: p.toPayTotal ? String(p.toPayTotal).replace('.', ',') : '', placeholder: 'es. 10' });
    const note = h('input', { class: 'input', maxlength: 200, placeholder: 'Nota (facoltativa)' });
    const qrBox = h('div', { class: 'food-qr' });
    const seg = h('div', { class: 'food-tabs food-pay-methods' });
    const paint = () => {
      seg.replaceChildren(...[['contanti', '💶 Contanti'], ['satispay', '📱 Satispay'], ['paypal', '🅿️ PayPal']].map(([k, l]) => h('button', { type: 'button', class: method === k ? 'on' : '', onclick: () => { method = k; paint(); } }, l)));
      const svg = d.qr?.[method];
      if (method === 'contanti') qrBox.replaceChildren();
      else if (svg) { const el = h('div', { class: 'food-qr-img' }); el.innerHTML = svg; qrBox.replaceChildren(h('p', { class: 'tiny muted' }, `Fai inquadrare il QR di ${method === 'paypal' ? 'PayPal' : 'Satispay'}:`), el, h('a', { class: 'tiny', href: d.payLinks[method], target: '_blank', rel: 'noopener' }, d.payLinks[method])); }
      else qrBox.replaceChildren(h('p', { class: 'small warn-text' }, `Nessun link ${method === 'paypal' ? 'PayPal' : 'Satispay'} impostato: aggiungilo in «Link per pagare».`));
    };
    paint();
    await modal({
      title: `Paga · ${p.owner.name}`, okLabel: 'Pagato e consegnato', tall: true,
      body: h('div', { class: 'stack-sm' },
        h('ul', { class: 'food-pay-sum' }, p.toPay.map((o) => h('li', null, h('span', { class: 'tiny muted' }, o.kind === 'request' ? 'Richiesta accettata' : 'Ordine'), ' ', o.lines.map((l) => `${l.qty}× ${l.title}`).join(', ')))),
        h('p', { class: 'small' }, 'Offerta indicativa: ', h('strong', null, euro(p.toPayTotal) || '—'), h('span', { class: 'tiny muted' }, ' · offerta libera')),
        h('div', { class: 'field' }, h('span', null, 'Come ha pagato'), seg), qrBox,
        h('label', { class: 'field' }, h('span', null, 'Quanto ha lasciato (€)'), amount), note),
      onOk: async () => {
        await api('POST', `${base()}/pay`, { ownerKey: p.key, method, amount: amount.value, note: note.value });
        toast(`${p.owner.name}: consegnato e pagato`, 'ok'); load(true); return true;
      },
    });
  }
  async function linksDialog() {
    const d = S.data;
    const sat = h('input', { class: 'input', inputmode: 'url', value: d.payLinks.satispay || '', placeholder: 'https://… (link Satispay)' });
    const pp = h('input', { class: 'input', inputmode: 'url', value: d.payLinks.paypal || '', placeholder: 'https://paypal.me/…' });
    await modal({
      title: 'Link per pagare', okLabel: 'Salva',
      body: h('div', { class: 'stack-sm' }, h('label', { class: 'field' }, h('span', null, 'Satispay'), sat), h('label', { class: 'field' }, h('span', null, 'PayPal'), pp),
        h('p', { class: 'tiny muted' }, 'Alla consegna, scegliendo Satispay o PayPal compare il QR da far inquadrare. Chi ordina vede i link nella pagina del Ristoro.')),
      onOk: async () => { await api('PUT', `${base()}/paylinks`, { satispay: sat.value, paypal: pp.value }); toast('Link salvati', 'ok'); load(true); return true; },
    });
  }
  function deliveryView(d) {
    const people = d.delivery;
    const todo = people.filter((p) => !p.done);
    const done = people.filter((p) => p.done);
    const byMethod = {};
    for (const x of d.payments) byMethod[x.methodLabel] = (byMethod[x.methodLabel] || 0) + x.amount;
    const cashed = d.payments.reduce((t, x) => t + x.amount, 0);
    const personCard = (p) => h('li', { class: `food-person ${p.done ? 'done' : ''}` },
      h('div', { class: 'food-order-head' }, h('div', { class: 'food-who' }, h('strong', null, p.owner.name), h('span', { class: `chip food-kind-${p.owner.kind}` }, p.owner.kind === 'consiglio' ? 'Consiglio' : p.owner.kind === 'eletto' ? 'Eletto' : 'Legati'), p.owner.sub ? h('span', { class: 'tiny muted' }, p.owner.sub) : null),
        p.done ? h('span', { class: 'food-st food-st-ok' }, '✓ Pagato') : h('strong', { class: 'food-person-tot' }, euro(p.toPayTotal) || 'offerta libera')),
      h('ol', { class: 'food-person-orders' }, p.orders.map((o) => h('li', { class: o.payment ? 'paid' : '' },
        h('div', { class: 'tiny muted' }, `${o.kind === 'request' ? 'Richiesta accettata' : 'Ordine'} · ${fmtDT(o.createdAt)}${o.total ? ` · ${euro(o.total)}` : ''}`),
        linesList(o), o.note ? h('p', { class: 'small' }, `Note: ${o.note}`) : null))),
      p.payments.map((x) => h('div', { class: 'food-paid' }, h('span', null, `💶 ${x.methodLabel} · ${euro(x.amount)} · ${fmtDT(x.at)}${x.by ? ` · ${x.by}` : ''}${x.note ? ` · ${x.note}` : ''}`),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => { if (await dialog({ title: 'Annullare il pagamento?', text: `${p.owner.name}: torna da consegnare.`, okLabel: 'Annulla il pagamento', cancelLabel: 'No', danger: true })) call('DELETE', `/payments/${x.id}`, undefined, 'Pagamento annullato'); } }, 'Annulla'))),
      p.toPay.length ? h('button', { class: 'btn btn-primary btn-block food-pay-btn', type: 'button', onclick: () => payDialog(p) }, `💶 Paga${p.toPayTotal ? ` · ${euro(p.toPayTotal)}` : ''}`) : null);
    const filters = [['dacons', 'Da consegnare', todo.length, todo.length > 0], ['fatti', 'Pagati', done.length, false]];
    if (!['dacons', 'fatti'].includes(S.dtab)) S.dtab = 'dacons';
    const shown = S.dtab === 'fatti' ? done : todo;
    return h('div', { class: 'food food-admin stack' },
      h('div', { class: 'food-cash' }, h('div', null, h('div', { class: 'eyebrow' }, 'Incassato'), h('strong', null, euro(cashed) || '0,00 €')),
        h('div', { class: 'tiny muted' }, Object.entries(byMethod).map(([k, v]) => `${k} ${euro(v)}`).join(' · ') || 'Ancora niente'),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: linksDialog }, d.payLinks.satispay || d.payLinks.paypal ? '🔗 Link per pagare' : '🔗 Aggiungi i link Satispay e PayPal')),
      h('nav', { class: 'food-tabs', role: 'tablist', 'aria-label': 'Filtro' }, filters.map(([k, l, n, alert]) => h('button', { type: 'button', role: 'tab', class: S.dtab === k ? 'on' : '', onclick: () => { S.dtab = k; rerender(); } }, h('span', null, l), h('b', { class: `food-tab-n ${alert ? 'alert' : ''}` }, String(n))))),
      shown.length ? h('ul', { class: 'food-people' }, shown.map(personCard)) : h('p', { class: 'empty' }, S.dtab === 'fatti' ? 'Nessuno ha ancora pagato.' : 'Nessuno da servire.'));
  }

  // Due pagine distinte: 'menu' (le voci) e 'orders' (ordini e richieste, con il filtro tra i due).
  function view(mode = 'orders') {
    if (!gameId()) return h('p', { class: 'empty' }, 'Scegli la partita.');
    if (!S.data || S.gid !== gameId()) { load(); return h('p', { class: 'empty' }, 'Caricamento…'); }
    load();
    const d = S.data;
    const live = d.items.filter((i) => !i.archived);
    if (mode === 'delivery') return deliveryView(d);
    if (mode === 'menu') {
      return h('div', { class: 'food food-admin stack' },
        h('div', { class: 'row-actions' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => itemDialog() }, '＋ Aggiungi una voce')),
        h('p', { class: 'tiny muted' }, 'Titolo, descrizione e prezzo indicativo: chi ordina vede sempre «offerta libera». Una voce già ordinata, se la togli, esce dal menù ma resta negli ordini.'),
        live.length ? h('ul', { class: 'food-menu' }, live.map((m, i) => h('li', { class: 'food-item food-admin-item' },
          // Titolo e descrizione a sinistra, prezzo grande a destra (oro).
          h('div', { class: 'food-admin-top' },
            h('div', { class: 'food-item-main' }, h('strong', null, m.title), m.description ? h('span', { class: 'small muted' }, m.description) : null,
              h('span', { class: 'tiny muted' }, `Creata ${fmtDT(m.createdAt)}${m.updatedAt > m.createdAt + 1000 ? ` · modificata ${fmtDT(m.updatedAt)}` : ''}`)),
            bigPrice(m.price)),
          h('div', { class: 'food-admin-actions' },
            h('button', { class: 'btn btn-sm btn-ghost', type: 'button', disabled: i === 0, 'aria-label': 'Sposta su', onclick: () => call('POST', `/items/${m.id}/move`, { dir: -1 }) }, '↑'),
            h('button', { class: 'btn btn-sm btn-ghost', type: 'button', disabled: i === live.length - 1, 'aria-label': 'Sposta giù', onclick: () => call('POST', `/items/${m.id}/move`, { dir: 1 }) }, '↓'),
            h('button', { class: 'btn btn-sm', type: 'button', onclick: () => itemDialog(m) }, 'Modifica'),
            h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => { if (await dialog({ title: `Togliere «${m.title}»?`, text: 'Esce dal menù. Gli ordini già fatti restano com\'erano.', okLabel: 'Togli', danger: true })) call('DELETE', `/items/${m.id}`, undefined, 'Voce tolta'); } }, 'Togli'))))) : h('p', { class: 'empty' }, 'Il menù è vuoto: aggiungi la prima voce.'));
    }
    const filters = [['ordini', 'Ordini', d.counts.orders, false], ['richieste', 'Richieste d\'ordine', d.counts.pending, d.counts.pending > 0]];
    const activeOrders = d.orders.filter((o) => o.status === 'active');
    const offOrders = d.orders.filter((o) => o.status !== 'active');
    return h('div', { class: 'food food-admin stack' },
      h('div', { class: `food-deadline ${d.open ? 'open' : 'closed'}` },
        h('strong', null, d.deadline ? (d.open ? `Ora limite: ${fmtDT(d.deadline)} · ordini aperti` : `Ora limite passata (${fmtDT(d.deadline)}) · arrivano solo richieste`) : 'Nessuna ora limite: ordini aperti'),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn btn-sm', type: 'button', onclick: deadlineDialog }, d.deadline ? 'Cambia l\'ora limite' : 'Fissa l\'ora limite'),
          d.deadline ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => call('PUT', '/deadline', { deadline: null }, 'Ora limite tolta: ordini aperti') }, 'Togli') : null,
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => load(true) }, '↻ Aggiorna'))),
      // Filtro: ordini (entro l'ora limite) o richieste d'ordine (dopo), con quante aspettano una risposta.
      h('nav', { class: 'food-tabs', role: 'tablist', 'aria-label': 'Filtro' }, filters.map(([k, l, n, alert]) => h('button', { type: 'button', role: 'tab', 'aria-selected': S.tab === k ? 'true' : 'false', class: S.tab === k ? 'on' : '', onclick: () => { S.tab = k; rerender(); } }, h('span', null, l), h('b', { class: `food-tab-n ${alert ? 'alert' : ''}` }, String(n))))),
      S.tab === 'richieste' ? h('section', { class: 'stack-sm food-sec-req' },
        h('p', { class: 'food-hint req' }, 'Arrivate DOPO l\'ora limite: non sono ordini finché non le accetti.'),
        d.requests.length ? h('ul', { class: 'food-orders' }, [...d.requests].sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.createdAt - a.createdAt).map(orderCard)) : h('p', { class: 'empty' }, 'Nessuna richiesta.'),
        h('h3', null, 'Richieste accettate: da preparare'), totalsTable(d.totals.accepted))
      : h('section', { class: 'stack-sm food-sec-ord' },
        h('p', { class: 'food-hint ord' }, 'Fatti entro l\'ora limite.'),
        // Da preparare: in cima il totale (ordini + richieste accettate); il dettaglio si apre a richiesta.
        h('div', { class: 'food-sum' }, h('h3', null, 'Da preparare'), totalsTable(d.totals.all),
          d.counts.accepted ? h('details', { class: 'food-sum-detail' }, h('summary', { class: 'small' }, `Dettaglio: ${d.counts.orders} ordini + ${d.counts.accepted} richieste accettate`),
            h('div', { class: 'eyebrow' }, 'Ordini'), totalsTable(d.totals.orders), h('div', { class: 'eyebrow' }, 'Richieste accettate'), totalsTable(d.totals.accepted)) : null),
        activeOrders.length ? h('ul', { class: 'food-orders' }, [...activeOrders].reverse().map(orderCard)) : h('p', { class: 'empty' }, 'Nessun ordine.'),
        offOrders.length ? h('details', null, h('summary', { class: 'small' }, `Annullati (${offOrders.length})`), h('ul', { class: 'food-orders' }, offOrders.map(orderCard))) : null));
  }
  return { view, load: () => load(true), pending };
}
