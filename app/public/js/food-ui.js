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
  'request:rejected': ['Richiesta d\'ordine · rifiutata', 'food-st-no'],
  'request:cancelled': ['Richiesta annullata', 'food-st-off'],
};
const LOG = { created: 'Ordine inviato', requested: 'Richiesta d\'ordine inviata', updated: 'Modificato', cancelled: 'Annullato', accepted: 'Richiesta accettata: diventa un ordine', rejected: 'Richiesta rifiutata', reopened: 'Rimessa in attesa', paid: 'Consegnato e pagato', unpaid: 'Pagamento annullato', delivered: 'Consegnato', undelivered: 'Consegna annullata' };
const statusChip = (o) => { const [label, cls] = STATUS[`${o.kind}:${o.status}`] || [o.status, '']; return h('span', { class: `food-st ${cls}` }, o.fromRequest && o.kind === 'order' ? `${label} · da richiesta accettata` : label); };
const linesList = (o) => h('ul', { class: 'food-lines' }, o.lines.map((l) => h('li', null, h('b', { class: 'mono' }, `${l.qty}×`), ` ${l.title}`, l.price != null ? h('span', { class: 'tiny muted' }, ` · ${euro(l.price)}`) : null,
  l.delivered ? h('span', { class: `food-ld ${l.delivered >= l.qty ? 'ok' : 'part'}` }, l.delivered >= l.qty ? ' ✓ consegnato' : ` ${l.delivered} di ${l.qty} consegnati`) : null)));
const accRow = (k, v, strong) => h('div', { class: `food-acc-row ${strong ? 'strong' : ''}` }, h('span', null, k), h('b', null, v));
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
      const placed = S.editing ? null : await api('POST', url('/orders'), { lines, note: S.note });
      toast(S.editing ? 'Modifica salvata' : isRequest ? 'Richiesta d\'ordine inviata' : 'Ordine inviato', 'ok');
      reset();
      // Dati freschi anche se un aggiornamento (SSE) è già in corso: servono per proporre il pagamento.
      try { S.data = await api('GET', url()); S.at = Date.now(); } catch { /* resta quello che c'è */ }
      rerender();
      // Ordine appena fatto: si può pagare subito in anticipo (o al ritiro).
      if (placed?.kind === 'order' && canPay() && await dialog({ title: 'Ordine inviato', text: 'Vuoi pagarlo adesso in anticipo con Satispay o PayPal? Puoi anche pagare alla cassa al ritiro.', okLabel: '💳 Paga adesso', cancelLabel: 'Pago al ritiro' })) prepay(placed.total);
    } catch (e) { toast(e.message, 'error', 7000); load(true); }
  }
  async function cancel(o) {
    if (!(await dialog({ title: o.kind === 'request' ? 'Annullare la richiesta?' : 'Annullare l\'ordine?', text: 'Resta nello storico come annullato.', okLabel: 'Annulla l\'ordine', cancelLabel: 'No', danger: true }))) return;
    try { await api('DELETE', url(`/orders/${o.id}`)); toast('Annullato', 'ok'); if (S.editing?.id === o.id) reset(); load(true); } catch (e) { toast(e.message, 'error', 7000); }
  }
  // Paga in anticipo: Satispay o PayPal si aprono fuori dall'app; poi «Ho pagato» e la cassa conferma.
  // Si può pagare in anticipo se c'è un link (Satispay o PayPal) e resta qualcosa da pagare non già dichiarato.
  const canPay = () => { const d = S.data; const a = d?.account; return !!a && !d.ended && !a.closed && a.toPay > a.pendingAmount && !!(d.payLinks?.satispay || d.payLinks?.paypal); };
  async function prepay(suggest) {
    const d = S.data;
    const acc = d.account;
    const left = Math.max(0, Math.round((acc.toPay - acc.pendingAmount) * 100) / 100);
    const def = suggest > 0 ? Math.min(suggest, left) : left;
    const opts = [['satispay', '📱 Satispay'], ['paypal', '🅿️ PayPal']].filter(([k]) => d.payLinks?.[k]);
    let method = opts[0]?.[0];
    let opened = false;
    const amount = h('input', { class: 'input food-amount', inputmode: 'decimal', value: def ? String(def).replace('.', ',') : '', placeholder: 'es. 10' });
    const seg = h('div', { class: 'food-tabs food-pay-methods' });
    const go = h('a', { class: 'btn btn-block food-go', target: '_blank', rel: 'noopener', onclick: () => { opened = true; } });
    const paint = () => {
      seg.replaceChildren(h('button', { type: 'button', class: 'off', onclick: () => toast('I contanti si danno alla cassa, al ritiro.') }, '💶 Contanti'),
        ...opts.map(([k, l]) => h('button', { type: 'button', class: method === k ? 'on' : '', onclick: () => { method = k; opened = false; paint(); } }, l)));
      go.href = d.payLinks[method];
      go.textContent = `Apri ${method === 'paypal' ? 'PayPal' : 'Satispay'} e paga ↗`;
    };
    paint();
    await modal({
      title: 'Paga in anticipo', okLabel: '✓ Ho pagato', tall: true,
      body: h('div', { class: 'stack-sm' },
        h('div', { class: 'food-acc' }, accRow('Totale indicativo', euro(acc.total) || 'offerta libera'), accRow('Già pagato', euro(acc.paid) || '0,00 €'), acc.pendingAmount ? accRow('In attesa di conferma', euro(acc.pendingAmount)) : null, accRow('Resta', euro(acc.toPay) || '0,00 €', true)),
        h('p', { class: 'tiny muted' }, 'Offerta libera: il totale è solo indicativo. I contanti si danno alla cassa al ritiro.'),
        h('div', { class: 'field' }, h('span', null, 'Come paghi'), seg),
        h('label', { class: 'field' }, h('span', null, 'Quanto paghi (€)'), amount),
        h('ol', { class: 'food-steps small' }, h('li', null, 'Apri il link: si esce dall\'app e paghi lì.'), h('li', null, 'Torna qui e premi «Ho pagato».'), h('li', null, 'Il pagamento resta in attesa finché la cassa non lo conferma.')),
        go),
      onOk: async () => {
        if (!opened && !(await dialog({ title: 'Hai già pagato?', text: 'Non hai aperto il link di pagamento da qui. Confermi di aver già pagato?', okLabel: 'Sì, ho pagato', cancelLabel: 'No' }))) return false;
        await api('POST', url('/payments'), { method, amount: amount.value });
        toast('Pagamento inviato: in attesa di conferma dalla cassa', 'ok'); load(true); return true;
      },
    });
  }
  async function cancelPay(x) {
    if (!(await dialog({ title: 'Annullare il pagamento dichiarato?', text: 'Toglilo solo se non hai pagato davvero.', okLabel: 'Annulla', cancelLabel: 'No', danger: true }))) return;
    try { await api('DELETE', url(`/payments/${x.id}`)); toast('Annullato', 'ok'); load(true); } catch (e) { toast(e.message, 'error', 7000); }
  }
  function view() {
    if (!S.data) { load(); return h('p', { class: 'empty' }, 'Caricamento del menù…'); }
    load();
    const d = S.data;
    const menu = d.menu;
    const total = menu.reduce((t, m) => t + (m.price || 0) * (S.cart.get(m.id) || 0), 0);
    const count = [...S.cart.values()].reduce((a, b) => a + b, 0);
    const isRequest = S.editing ? S.editing.kind === 'request' : !d.open;
    const canEdit = (o) => o.status !== 'cancelled' && !o.delivered && (o.kind === 'order' ? d.open : o.status === 'pending');
    const acc = d.account;
    return h('div', { class: 'food stack' },
      h('div', { class: 'food-head' }, h('h2', null, '🥪 Ristoro'), h('p', { class: 'small muted' }, 'Panini e bevande dei Giochi.')),
      h('div', { class: 'food-free' }, h('strong', null, 'Offerta libera'), h('span', null, 'I prezzi sono solo un\'offerta indicativa: al ritiro ognuno lascia quello che vuole.'),
        h('span', { class: 'small' }, 'Si paga in anticipo dall\'app o alla cassa al ritiro, anche in più volte: 💶 contanti alla cassa', d.payLinks?.satispay ? [' · ', h('a', { href: d.payLinks.satispay, target: '_blank', rel: 'noopener' }, '📱 Satispay')] : '', d.payLinks?.paypal ? [' · ', h('a', { href: d.payLinks.paypal, target: '_blank', rel: 'noopener' }, '🅿️ PayPal')] : '', '.')),
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
      acc && (acc.items || acc.paid) ? h('div', { class: 'food-acc' }, h('div', { class: 'eyebrow' }, 'Il tuo conto'),
        accRow('Totale indicativo', euro(acc.total) || 'offerta libera'), accRow('Pagato', euro(acc.paid) || '0,00 €'),
        accRow(acc.closed ? 'Conto chiuso' : 'Resta da pagare', acc.closed ? '✓' : euro(acc.toPay) || '0,00 €', true),
        accRow('Ritirato', acc.deliveredAll ? '✓ tutto' : `${acc.delivered} di ${acc.items}`),
        acc.pendingAmount ? accRow('In attesa di conferma', euro(acc.pendingAmount)) : null,
        d.payments?.length ? h('ul', { class: 'food-hist food-my-pays' }, d.payments.map((x) => h('li', { class: x.pending ? 'wait' : x.rejected ? 'no' : '' },
          h('span', null, `${x.pending ? '⏳' : x.rejected ? '✗' : '💶'} ${fmtDT(x.at)} · ${x.methodLabel} ${euro(x.amount)}${x.pending ? ' · in attesa che la cassa confermi' : x.rejected ? ' · non arrivato: passa alla cassa' : ' · confermato'}`),
          x.pending ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => cancelPay(x) }, 'Annulla') : null)))
          : null,
        canPay() ? h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => prepay() }, '💳 Paga in anticipo') : null) : null,
      h('section', { class: 'stack-sm' }, h('h3', null, 'I tuoi ordini e richieste'),
        d.orders.length ? h('ul', { class: 'food-orders' }, d.orders.map((o) => h('li', { class: `food-order ${o.status === 'cancelled' ? 'off' : ''} ${o.kind}` },
          h('div', { class: 'food-order-head' }, statusChip(o), o.total ? h('span', { class: 'tiny muted' }, `offerta indicativa ${euro(o.total)}`) : null),
          linesList(o), o.note ? h('p', { class: 'small' }, `Note: ${o.note}`) : null, dates(o),
          o.decidedAt ? h('div', { class: 'tiny muted' }, `${o.fromRequest ? 'Richiesta accettata' : 'Rifiutata'} ${fmtDT(o.decidedAt)}`) : null,
          o.delivered ? h('div', { class: o.delivered >= o.items ? 'food-paid' : 'food-part' }, o.delivered >= o.items ? '✓ Consegnato' : `Consegnato in parte: ${o.delivered} di ${o.items}`) : null,
          history(o),
          (canEdit(o) && !d.ended) || (o.kind === 'order' && o.status === 'active' && canPay()) ? h('div', { class: 'row-actions' },
            o.kind === 'order' && o.status === 'active' && canPay() ? h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => prepay(o.total) }, `💳 Paga${o.total ? ` ${euro(Math.min(o.total, Math.max(0, d.account.toPay - d.account.pendingAmount)))}` : ''}`) : null,
            canEdit(o) && !d.ended ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => edit(o) }, 'Modifica') : null,
            canEdit(o) && !d.ended ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => cancel(o) }, 'Annulla') : null) : null))) : h('p', { class: 'empty' }, 'Non hai ancora ordinato niente.')));
  }
  return { view, load: () => load(true) };
}

// ---------------------------------------------------------------- addetto

// gameId(): la partita; tutto passa da /api/v/games/:id/food (permesso «ristoro» o master).
export function createFoodAdmin({ gameId, rerender, methodsHref = '' }) {
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
    o.decidedAt ? h('div', { class: 'tiny muted' }, `${o.fromRequest ? 'Richiesta accettata' : 'Rifiutata'} ${fmtDT(o.decidedAt)}${o.decidedBy ? ` da ${o.decidedBy}` : ''}`) : null,
    history(o),
    o.kind === 'request' && o.status !== 'cancelled' ? h('div', { class: 'row-actions' },
      h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => call('POST', `/orders/${o.id}/decision`, { decision: 'accept' }, 'Richiesta accettata: ora è un ordine') }, 'Accetta'),
      o.status !== 'rejected' ? h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => call('POST', `/orders/${o.id}/decision`, { decision: 'reject' }, 'Richiesta rifiutata') }, 'Rifiuta') : null,
      o.status !== 'pending' ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => call('POST', `/orders/${o.id}/decision`, { decision: 'pending' }, 'Rimessa in attesa') }, 'Rimetti in attesa') : null) : null);
  const totalsTable = (list) => (list.length ? h('table', { class: 'food-totals' }, h('tbody', null, list.map((x) => h('tr', null, h('td', { class: 'mono' }, `${x.qty}×`), h('td', null, x.title), h('td', { class: 'tiny muted' }, x.offer ? euro(x.offer) : ''))))) : h('p', { class: 'tiny muted' }, 'Niente.'));

  // Paga: come ha pagato (contanti, Satispay, PayPal, con il QR da far inquadrare) e quanto. Prima o dopo il ritiro, anche a rate.
  async function payDialog(p) {
    const d = S.data;
    let method = 'contanti';
    const amount = h('input', { class: 'input food-amount', inputmode: 'decimal', value: p.toPay ? String(p.toPay).replace('.', ',') : '', placeholder: 'es. 10' });
    const closes = h('input', { type: 'checkbox' });
    const note = h('input', { class: 'input', maxlength: 200, placeholder: 'Nota (facoltativa)' });
    const qrBox = h('div', { class: 'food-qr' });
    const seg = h('div', { class: 'food-tabs food-pay-methods' });
    const paint = () => {
      seg.replaceChildren(...[['contanti', '💶 Contanti'], ['satispay', '📱 Satispay'], ['paypal', '🅿️ PayPal']].map(([k, l]) => h('button', { type: 'button', class: method === k ? 'on' : '', onclick: () => { method = k; paint(); } }, l)));
      const svg = d.qr?.[method];
      if (method === 'contanti') qrBox.replaceChildren();
      else if (svg) { const el = h('div', { class: 'food-qr-img' }); el.innerHTML = svg; qrBox.replaceChildren(h('p', { class: 'tiny muted' }, `Fai inquadrare il QR di ${method === 'paypal' ? 'PayPal' : 'Satispay'}:`), el, h('a', { class: 'tiny', href: d.payLinks[method], target: '_blank', rel: 'noopener' }, d.payLinks[method])); }
      else qrBox.replaceChildren(h('p', { class: 'small warn-text' }, `Nessun link ${method === 'paypal' ? 'PayPal' : 'Satispay'} impostato: aggiungilo in «Metodi di pagamento».`));
    };
    paint();
    await modal({
      title: `Paga · ${p.owner.name}`, okLabel: 'Registra il pagamento', tall: true,
      body: h('div', { class: 'stack-sm' },
        h('div', { class: 'food-acc' }, accRow('Totale indicativo', euro(p.total) || 'offerta libera'), accRow('Già pagato', euro(p.paid) || '0,00 €'), accRow('Resta', euro(p.toPay) || '0,00 €', true)),
        h('p', { class: 'tiny muted' }, p.deliveredAll ? 'Ha già ritirato tutto.' : p.delivered ? `Ha ritirato ${p.delivered} di ${p.items}: il pagamento è a parte, si può pagare prima o dopo.` : 'Non ha ancora ritirato niente: si può pagare prima o dopo.'),
        h('div', { class: 'field' }, h('span', null, 'Come ha pagato'), seg), qrBox,
        h('label', { class: 'field' }, h('span', null, 'Quanto ha pagato adesso (€)'), amount),
        h('label', { class: 'check' }, closes, h('span', null, 'Chiudi il conto: offerta libera, il resto non è dovuto')), note),
      onOk: async () => {
        await api('POST', `${base()}/pay`, { ownerKey: p.key, method, amount: amount.value, closes: closes.checked, note: note.value });
        toast(`${p.owner.name}: pagamento registrato`, 'ok'); load(true); return true;
      },
    });
  }
  // Conferma alla cassa di un pagamento dichiarato in anticipo (si può correggere l'importo arrivato).
  async function confirmDialog(p, x) {
    const amount = h('input', { class: 'input food-amount', inputmode: 'decimal', value: String(x.amount).replace('.', ',') });
    const closes = h('input', { type: 'checkbox' });
    await modal({
      title: `Conferma · ${p.owner.name}`, okLabel: 'Pagamento arrivato',
      body: h('div', { class: 'stack-sm' },
        h('p', { class: 'small' }, `Controlla su ${x.methodLabel} che siano arrivati i soldi.`),
        h('label', { class: 'field' }, h('span', null, 'Importo arrivato (€)'), amount),
        h('label', { class: 'check' }, closes, h('span', null, 'Chiudi il conto: offerta libera, il resto non è dovuto'))),
      onOk: async () => { await api('POST', `${base()}/payments/${x.id}/confirm`, { amount: amount.value, closes: closes.checked }); toast(`${p.owner.name}: pagamento confermato`, 'ok'); load(true); return true; },
    });
  }
  // Consegna: tutto quello che manca, oppure solo una parte (quantità per voce).
  async function deliverDialog(p) {
    const rows = [];
    for (const o of p.orders) for (const l of o.lines) {
      const left = l.qty - l.delivered;
      if (left <= 0) continue;
      const r = { lineId: l.id, left, qty: left };
      const n = h('b', { class: 'mono' }, String(left));
      const set = (v) => { r.qty = Math.max(0, Math.min(left, v)); n.textContent = String(r.qty); };
      r.el = h('li', { class: 'food-deliver-row' },
        h('div', { class: 'food-item-main' }, h('strong', null, l.title), h('span', { class: 'tiny muted' }, `${o.fromRequest ? 'Ordine da richiesta' : 'Ordine'} · ne mancano ${left}${l.delivered ? ` (già dati ${l.delivered})` : ''}`)),
        h('div', { class: 'food-qty' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => set(r.qty - 1) }, '−'), n, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => set(r.qty + 1) }, '+')));
      rows.push(r);
    }
    await modal({
      title: `Consegna · ${p.owner.name}`, okLabel: 'Consegnato', tall: true,
      body: h('div', { class: 'stack-sm' }, h('p', { class: 'tiny muted' }, 'Lascia le quantità che consegni adesso: quello che resta si consegna dopo. Il pagamento è a parte.'), h('ul', { class: 'food-deliver' }, rows.map((r) => r.el))),
      onOk: async () => {
        const lines = rows.filter((r) => r.qty > 0).map((r) => ({ lineId: r.lineId, qty: r.qty }));
        if (!lines.length) throw new Error('Niente da consegnare');
        await api('POST', `${base()}/deliver`, { ownerKey: p.key, lines });
        toast(`${p.owner.name}: consegnato`, 'ok'); load(true); return true;
      },
    });
  }
  // Pagina a sé: i metodi di pagamento (contanti sempre; Satispay e PayPal con il loro link e il QR).
  function methodsView(d) {
    const sat = h('input', { class: 'input', inputmode: 'url', value: d.payLinks.satispay || '', placeholder: 'https://… (link Satispay)', 'data-keep': 'food-sat' });
    const pp = h('input', { class: 'input', inputmode: 'url', value: d.payLinks.paypal || '', placeholder: 'https://paypal.me/…', 'data-keep': 'food-pp' });
    const qr = (k) => {
      if (!d.qr?.[k]) return h('p', { class: 'tiny muted' }, 'Nessun link: alla consegna non compare il QR.');
      const el = h('div', { class: 'food-qr-img' }); el.innerHTML = d.qr[k];
      return h('div', { class: 'food-qr' }, el, h('a', { class: 'tiny', href: d.payLinks[k], target: '_blank', rel: 'noopener' }, d.payLinks[k]));
    };
    const card = (ico, title, txt, input, k) => h('li', { class: 'food-item food-method' },
      h('div', { class: 'food-admin-top' }, h('div', { class: 'food-item-main' }, h('strong', null, `${ico} ${title}`), h('span', { class: 'small muted' }, txt)),
        h('span', { class: `food-st ${k === 'contanti' || d.payLinks[k] ? 'food-st-ok' : ''}` }, k === 'contanti' || d.payLinks[k] ? 'Attivo' : 'Da impostare')),
      input ? h('label', { class: 'field' }, h('span', null, 'Link'), input) : null, input ? qr(k) : null);
    const save = async () => { await call('PUT', '/paylinks', { satispay: sat.value, paypal: pp.value }, 'Metodi di pagamento salvati'); };
    return h('div', { class: 'food food-admin stack' },
      h('p', { class: 'tiny muted' }, 'Come si può pagare al ritiro. Chi ordina vede i link nella pagina del Ristoro; al ritiro, scegliendo Satispay o PayPal, compare il QR da far inquadrare.'),
      h('ul', { class: 'food-menu' },
        card('💶', 'Contanti', 'Sempre disponibile.', null, 'contanti'),
        card('📱', 'Satispay', 'Il link del negozio o del profilo Satispay.', sat, 'satispay'),
        card('🅿️', 'PayPal', 'Il link paypal.me o di pagamento.', pp, 'paypal')),
      h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: save }, 'Salva i metodi di pagamento'));
  }
  function deliveryView(d) {
    const people = d.delivery;
    const byMethod = {};
    for (const x of d.payments) byMethod[x.methodLabel] = (byMethod[x.methodLabel] || 0) + x.amount;
    const cashed = d.payments.reduce((t, x) => t + x.amount, 0);
    const owed = people.reduce((t, p) => t + p.toPay, 0);
    const kindChip = (p) => h('span', { class: `chip food-kind-${p.owner.kind}` }, p.owner.kind === 'consiglio' ? 'Consiglio' : p.owner.kind === 'eletto' ? 'Eletto' : 'Legati');
    const lineDone = (l) => (l.delivered >= l.qty ? h('span', { class: 'food-ld ok' }, '✓ consegnato') : l.delivered ? h('span', { class: 'food-ld part' }, `${l.delivered} di ${l.qty} consegnati`) : null);
    const undo = (title, text, path, ok) => async () => { if (await dialog({ title, text, okLabel: 'Annulla', cancelLabel: 'No', danger: true })) call('DELETE', path, undefined, ok); };
    const personCard = (p) => {
      const tags = [];
      if (p.toDeliver > 0) tags.push('dacons');
      if (!p.paidAll || p.pendingPayments.length) tags.push('dapagare');
      if (p.done) tags.push('fatti');
      const hist = [
        ...p.deliveries.map((x) => ({ at: x.at, el: h('li', { class: 'food-hist-del' }, h('span', null, `📦 ${fmtDT(x.at)} · ${x.summary}${x.by ? ` · ${x.by}` : ''}`),
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: undo('Annullare la consegna?', `${p.owner.name}: ${x.summary} torna da consegnare.`, `/deliveries/${x.id}`, 'Consegna annullata') }, 'Annulla')) })),
        ...p.payments.map((x) => ({ at: x.at, el: h('li', { class: 'food-hist-pay' }, h('span', null, `💶 ${fmtDT(x.at)} · ${x.methodLabel} ${euro(x.amount)}${x.closes ? ' · conto chiuso' : ''}${x.by ? ` · ${x.by}` : ''}${x.note ? ` · ${x.note}` : ''}`),
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: undo('Annullare il pagamento?', `${p.owner.name}: ${euro(x.amount)} con ${x.methodLabel}.`, `/payments/${x.id}`, 'Pagamento annullato') }, 'Annulla')) })),
      ].sort((a, b) => a.at - b.at).map((x) => x.el);
      return h('li', { class: `food-person ${p.done ? 'done' : ''}`, 'data-f': tags.join(' '), 'data-q': `${p.owner.name} ${p.owner.sub || ''} ${p.orders.flatMap((o) => o.lines.map((l) => l.title)).join(' ')}`.toLowerCase() },
        h('div', { class: 'food-order-head' }, h('div', { class: 'food-who' }, h('strong', null, p.owner.name), kindChip(p), p.owner.sub ? h('span', { class: 'tiny muted' }, p.owner.sub) : null),
          p.paidAll ? h('span', { class: 'food-st food-st-ok' }, '✓ Pagato') : h('div', { class: 'food-owed' }, h('strong', { class: 'food-person-tot' }, euro(p.toPay) || 'offerta libera'), h('span', { class: 'tiny muted' }, p.paid ? 'ancora da pagare' : 'da pagare'))),
        h('div', { class: 'food-person-state' },
          p.deliveredAll ? h('span', { class: 'food-st food-st-ok' }, '📦 Consegnato tutto') : h('span', { class: 'food-st food-st-wait' }, `📦 Da consegnare ${p.toDeliver} di ${p.items}`),
          p.paid ? h('span', { class: `food-st ${p.paidAll ? 'food-st-ok' : 'food-st-wait'}` }, `💶 Pagato ${euro(p.paid)}${p.total ? ` di ${euro(p.total)}` : ''}${p.closed ? ' · chiuso' : ''}`) : h('span', { class: 'food-st' }, '💶 Non ha pagato')),
        p.pendingPayments.length ? h('ul', { class: 'food-pend' }, p.pendingPayments.map((x) => h('li', null,
          h('div', null, h('strong', null, `⏳ ${x.methodLabel} ${euro(x.amount)}`), h('span', { class: 'tiny' }, ` · pagato in anticipo ${fmtDT(x.at)} · da verificare`)),
          h('div', { class: 'food-pend-actions' },
            h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => confirmDialog(p, x) }, '✓ Arrivato'),
            h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: async () => { if (await dialog({ title: 'Pagamento non arrivato?', text: `${p.owner.name}: ${x.methodLabel} ${euro(x.amount)}. Riceverà un avviso di passare alla cassa.`, okLabel: 'Non arrivato', cancelLabel: 'No', danger: true })) call('POST', `/payments/${x.id}/reject`, {}, 'Segnato come non arrivato'); } }, 'Non arrivato'))))) : null,
        h('ol', { class: 'food-person-orders' }, p.orders.map((o) => h('li', null,
          h('div', { class: 'tiny muted' }, `${o.fromRequest ? 'Ordine da richiesta accettata' : 'Ordine'} · ${fmtDT(o.createdAt)}${o.total ? ` · ${euro(o.total)}` : ''}`),
          h('ul', { class: 'food-lines' }, o.lines.map((l) => h('li', { class: l.delivered >= l.qty ? 'got' : '' }, h('b', { class: 'mono' }, `${l.qty}×`), ` ${l.title} `, lineDone(l)))),
          o.note ? h('p', { class: 'small' }, `Note: ${o.note}`) : null))),
        hist.length ? h('details', { class: 'food-log' }, h('summary', { class: 'tiny' }, `Consegne e pagamenti (${hist.length})`), h('ul', { class: 'food-hist' }, hist)) : null,
        h('div', { class: 'food-person-actions' },
          p.toDeliver > 0 ? h('button', { class: 'btn btn-primary food-pay-btn', type: 'button', onclick: () => deliverDialog(p) }, `📦 Consegna${p.delivered ? ' il resto' : ''}`) : null,
          !p.paidAll ? h('button', { class: `btn ${p.toDeliver > 0 ? '' : 'btn-primary'} food-pay-btn`, type: 'button', onclick: () => payDialog(p) }, `💶 Paga${p.toPay ? ` · ${euro(p.toPay)}` : ''}`) : null));
    };
    const filters = [['dacons', 'Da consegnare'], ['dapagare', 'Da pagare'], ['fatti', 'Fatti']];
    if (!filters.some(([k]) => k === S.dtab)) S.dtab = 'dacons';
    const list = h('ul', { class: 'food-people' }, people.map(personCard));
    const empty = h('p', { class: 'empty' });
    const counts = {};
    const tabs = h('nav', { class: 'food-tabs food-tabs-ritiro', role: 'tablist', 'aria-label': 'Filtro' }, filters.map(([k, l]) => {
      counts[k] = h('b', { class: 'food-tab-n' }, '0');
      return h('button', { type: 'button', role: 'tab', 'data-k': k, onclick: () => { S.dtab = k; apply(); } }, h('span', null, l), counts[k]);
    }));
    const search = h('input', { class: 'input food-search', type: 'search', placeholder: 'Cerca un nome o una voce…', value: S.dq || '', 'data-keep': 'food-dq', oninput: (e) => { S.dq = e.target.value; apply(); } });
    // Filtro e ricerca senza ridisegnare la pagina (la tastiera resta aperta).
    function apply() {
      const words = (S.dq || '').toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      for (const k of Object.keys(counts)) counts[k].textContent = '0';
      for (const li of list.children) {
        const hit = words.every((w) => li.dataset.q.includes(w));
        const tags = li.dataset.f.split(' ').filter(Boolean);
        if (hit) for (const t of tags) counts[t].textContent = String(Number(counts[t].textContent) + 1);
        li.hidden = !(hit && tags.includes(S.dtab));
        if (!li.hidden) shown++;
      }
      for (const b of tabs.children) b.classList.toggle('on', b.dataset.k === S.dtab);
      counts.dacons.classList.toggle('alert', counts.dacons.textContent !== '0');
      empty.hidden = !!shown;
      empty.textContent = words.length ? 'Nessuno con questo nome qui: prova un altro filtro.' : S.dtab === 'fatti' ? 'Nessuno ha ancora ritirato e pagato tutto.' : S.dtab === 'dapagare' ? 'Nessuno deve pagare.' : 'Niente da consegnare.';
    }
    apply();
    return h('div', { class: 'food food-admin stack' },
      h('div', { class: 'food-cash' }, h('div', null, h('div', { class: 'eyebrow' }, 'Incassato'), h('strong', null, euro(cashed) || '0,00 €')),
        h('div', { class: 'food-cash-owed' }, h('div', { class: 'eyebrow' }, 'Ancora da pagare'), h('strong', null, euro(owed) || '0,00 €')),
        h('div', { class: 'tiny muted' }, Object.entries(byMethod).map(([k, v]) => `${k} ${euro(v)}`).join(' · ') || 'Ancora niente'),
        methodsHref && !d.payLinks.satispay && !d.payLinks.paypal ? h('a', { class: 'btn btn-sm food-cash-link', href: methodsHref }, '💳 Imposta Satispay e PayPal') : null),
      d.counts.payPending ? h('button', { class: 'food-pend-alert', type: 'button', onclick: () => { S.dtab = 'dapagare'; S.dq = ''; search.value = ''; apply(); } }, `⏳ ${d.counts.payPending} ${d.counts.payPending === 1 ? 'pagamento in anticipo da verificare' : 'pagamenti in anticipo da verificare'}`) : null,
      search, tabs, list, empty);
  }

  // Mini cruscotto per chi gestisce la cucina: ordini aperti, evasi, da chiudere; incassi attesi, pagati, ricevuti.
  // href(page, filtro): dove portano le caselle (la pagina Ritiro si apre sul filtro giusto).
  function dashboard(href) {
    if (!gameId()) return null;
    if (!S.data || S.gid !== gameId()) { load(); return h('p', { class: 'empty' }, 'Caricamento del Ristoro…'); }
    load();
    const d = S.data;
    const live = d.orders.filter((o) => o.status === 'active');
    const open = live.filter((o) => o.delivered < o.items).length;
    const done = live.filter((o) => o.items && o.delivered >= o.items).length;
    const toClose = d.delivery.filter((p) => p.deliveredAll && !p.paidAll).length;
    const expected = d.delivery.reduce((t, p) => t + p.total, 0);
    const declared = d.delivery.reduce((t, p) => t + p.pendingAmount, 0);
    const received = d.payments.reduce((t, x) => t + x.amount, 0);
    const cell = (n, label, hint, go, cls = '') => h('a', { class: `food-dash-cell ${cls}`, href: go.page, onclick: () => { if (go.tab) S.dtab = go.tab; } },
      h('strong', null, n), h('span', null, label), hint ? h('span', { class: 'tiny muted' }, hint) : null);
    return h('div', { class: 'food-dash' },
      d.counts.pending ? h('a', { class: 'food-pend-alert', href: href('orders') }, `🧾 ${d.counts.pending} ${d.counts.pending === 1 ? 'richiesta d\'ordine da decidere' : 'richieste d\'ordine da decidere'}`) : null,
      d.counts.payPending ? h('a', { class: 'food-pend-alert', href: href('delivery'), onclick: () => { S.dtab = 'dapagare'; } }, `⏳ ${d.counts.payPending} ${d.counts.payPending === 1 ? 'pagamento in anticipo da verificare' : 'pagamenti in anticipo da verificare'}`) : null,
      h('div', { class: 'eyebrow' }, 'Ordini'),
      h('div', { class: 'food-dash-row' },
        cell(String(open), 'Aperti', 'da consegnare', { page: href('delivery'), tab: 'dacons' }, open ? 'warn' : ''),
        cell(String(done), 'Evasi', 'consegnati', { page: href('delivery'), tab: 'fatti' }),
        cell(String(toClose), 'Da chiudere', 'consegnati, non pagati', { page: href('delivery'), tab: 'dapagare' }, toClose ? 'warn' : '')),
      h('div', { class: 'eyebrow' }, 'Incassi'),
      h('div', { class: 'food-dash-row' },
        cell(euro(expected) || '0 €', 'Attesi', 'totale indicativo', { page: href('delivery'), tab: 'dapagare' }),
        cell(euro(declared) || '0 €', 'Pagati', 'in anticipo, da verificare', { page: href('delivery'), tab: 'dapagare' }, declared ? 'warn' : ''),
        cell(euro(received) || '0 €', 'Ricevuti', 'in cassa', { page: href('delivery'), tab: 'fatti' }, 'ok')));
  }

  // Due pagine distinte: 'menu' (le voci) e 'orders' (ordini e richieste, con il filtro tra i due).
  function view(mode = 'orders') {
    if (!gameId()) return h('p', { class: 'empty' }, 'Scegli la partita.');
    if (!S.data || S.gid !== gameId()) { load(); return h('p', { class: 'empty' }, 'Caricamento…'); }
    load();
    const d = S.data;
    const live = d.items.filter((i) => !i.archived);
    if (mode === 'delivery') return deliveryView(d);
    if (mode === 'methods') return methodsView(d);
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
        h('p', { class: 'food-hint req' }, 'Arrivate DOPO l\'ora limite: non sono ordini finché non le accetti. Accettata, una richiesta diventa un ordine e la trovi in «Ordini».'),
        d.requests.length ? h('ul', { class: 'food-orders' }, [...d.requests].sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.createdAt - a.createdAt).map(orderCard)) : h('p', { class: 'empty' }, 'Nessuna richiesta.'),
        null)
      : h('section', { class: 'stack-sm food-sec-ord' },
        h('p', { class: 'food-hint ord' }, 'Fatti entro l\'ora limite, più le richieste accettate.'),
        // Da preparare: in cima il totale (ordini + richieste accettate); il dettaglio si apre a richiesta.
        h('div', { class: 'food-sum' }, h('h3', null, 'Da preparare'), totalsTable(d.totals.all),
          d.counts.accepted ? h('p', { class: 'tiny muted' }, `${d.counts.orders} ordini, di cui ${d.counts.accepted} da richieste accettate.`) : null),
        activeOrders.length ? h('ul', { class: 'food-orders' }, [...activeOrders].reverse().map(orderCard)) : h('p', { class: 'empty' }, 'Nessun ordine.'),
        offOrders.length ? h('details', null, h('summary', { class: 'small' }, `Annullati (${offOrders.length})`), h('ul', { class: 'food-orders' }, offOrders.map(orderCard))) : null));
  }
  return { view, dashboard, load: () => load(true), pending };
}
