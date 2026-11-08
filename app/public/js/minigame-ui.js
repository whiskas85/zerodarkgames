// Minigiochi veloci (Altari e Beacon): il server sceglie il gioco e ne dà i parametri; qui si gioca a schermo intero.
// playMinigame(mg) → true (superato), 'retry' (sbagliato: si chiede una nuova sfida), false (annullato).
// withMinigame(call): esegue l'azione; se il server chiede un minigioco lo fa giocare e ripete l'azione.
import { h, api, vibrate } from './lib.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PADS = [['#e5484d', 'Rosso'], ['#3fb950', 'Verde'], ['#3b82f6', 'Blu'], ['#facc15', 'Giallo']];

export async function withMinigame(call) {
  let res = await call();
  for (let i = 0; res?.minigame && i < 20; i++) {
    const r = await playMinigame(res.minigame);
    if (!r) return null;
    res = await call();
  }
  return res;
}

export function playMinigame(mg) {
  return new Promise((resolve) => {
    let over = false;
    const area = h('div', { class: 'mg-area' });
    const status = h('p', { class: 'mg-status' });
    const close = (v) => { if (over) return; over = true; el.remove(); resolve(v); };
    const el = h('div', { class: 'mg-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': mg.name },
      h('div', { class: 'mg-card' },
        h('div', { class: 'eyebrow' }, '🎲 Minigioco del Consiglio'),
        h('h2', null, mg.name),
        h('p', { class: 'small muted' }, mg.hint),
        area, status,
        h('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: () => close(false) }, 'Annulla')));
    document.body.append(el);

    const finish = async (body) => {
      if (over) return;
      area.replaceChildren(h('div', { class: 'mg-wait' }, 'Verifica…'));
      let r;
      try { r = await api('POST', `/api/team/minigame/${mg.id}/done`, body); } catch (e) { status.textContent = e.message; r = { ok: false }; }
      if (r.ok) {
        vibrate([80, 50, 200]);
        area.replaceChildren(h('div', { class: 'mg-result ok' }, '✓ Superato'));
        await sleep(800);
        return close(true);
      }
      vibrate([300]);
      const btn = h('button', { class: 'btn btn-primary btn-block', type: 'button', disabled: true, onclick: () => close('retry') }, 'Riprova');
      area.replaceChildren(h('div', { class: 'mg-result no' }, '✗ Non superato'), btn);
      const until = r.retryAt || Date.now() + 10000;
      const tick = () => {
        if (over) return;
        const s = Math.ceil((until - Date.now()) / 1000);
        if (s > 0) { btn.textContent = `Riprova tra ${s}s`; setTimeout(tick, 250); } else { btn.textContent = 'Riprova'; btn.disabled = false; }
      };
      tick();
    };

    const start = async () => {
      if (mg.notBefore && mg.notBefore > Date.now()) {
        while (!over && mg.notBefore > Date.now()) { area.replaceChildren(h('div', { class: 'mg-wait' }, `Si riparte tra ${Math.ceil((mg.notBefore - Date.now()) / 1000)}s`)); await sleep(250); }
      }
      if (over) return;
      const p = mg.params;
      if (mg.game === 'simon') return simon(p);
      if (mg.game === 'memoria') return memoria(p);
      if (mg.game === 'tempo') return tempo(p);
      return ordine(p);
    };

    // Ripeti il segnale: la sequenza si accende, poi la si ripete.
    async function simon(p) {
      const pads = PADS.slice(0, p.pads).map(([c, n], i) => h('button', { type: 'button', class: 'mg-pad', style: { '--c': c }, 'aria-label': n, disabled: true, onclick: () => tap(i) }));
      area.replaceChildren(h('div', { class: 'mg-pads' }, pads));
      const taps = [];
      const light = async (i, ms = 450) => { pads[i].classList.add('on'); vibrate([30]); await sleep(ms); pads[i].classList.remove('on'); };
      status.textContent = 'Guardate…';
      await sleep(600);
      for (const i of p.seq) { if (over) return; await light(i); await sleep(220); }
      status.textContent = `Ripetete la sequenza (${p.seq.length} luci)`;
      pads.forEach((b) => { b.disabled = false; });
      function tap(i) {
        light(i, 180);
        taps.push(i);
        if (taps[taps.length - 1] !== p.seq[taps.length - 1] || taps.length === p.seq.length) { pads.forEach((b) => { b.disabled = true; }); finish({ answer: taps.join('') }); }
        else status.textContent = `${taps.length} di ${p.seq.length}`;
      }
    }
    // Ricorda il codice: le cifre compaiono per pochi secondi, poi si scrivono.
    async function memoria(p) {
      const code = h('div', { class: 'mg-code mono' }, p.code.split('').join(' '));
      area.replaceChildren(code);
      for (let s = Math.ceil(p.showMs / 1000); s > 0 && !over; s--) { status.textContent = `Memorizzate… ${s}`; await sleep(1000); }
      if (over) return;
      status.textContent = 'Scrivete le cifre che avete visto';
      const inp = h('input', { class: 'input input-code mono', inputmode: 'numeric', maxlength: p.code.length, autocomplete: 'off', placeholder: '•'.repeat(p.code.length) });
      area.replaceChildren(h('form', { class: 'stack-sm', onsubmit: (e) => { e.preventDefault(); finish({ answer: inp.value }); } }, inp, h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Conferma')));
      inp.focus();
    }
    // Ferma al momento giusto: l'indicatore va avanti e indietro; si tocca quando è nella zona luminosa.
    function tempo(p) {
      let round = 0;
      let hits = 0;
      let zone = 0;
      let t0 = performance.now();
      const zoneEl = h('i', { class: 'mg-zone' });
      const mark = h('b', { class: 'mg-mark' });
      const bar = h('div', { class: 'mg-bar' }, zoneEl, mark);
      const dots = h('div', { class: 'mg-dots' });
      const stop = h('button', { class: 'btn btn-primary btn-xl btn-block', type: 'button', onclick: () => shot() }, 'STOP');
      area.replaceChildren(bar, dots, stop);
      const pos = () => { const ph = ((performance.now() - t0) / 1100) % 2; return ph < 1 ? ph : 2 - ph; };
      const next = () => { zone = 0.1 + Math.random() * (0.8 - p.zone); zoneEl.style.left = `${zone * 100}%`; zoneEl.style.width = `${p.zone * 100}%`; t0 = performance.now() - Math.random() * 1100; };
      const paint = () => { dots.replaceChildren(...Array.from({ length: p.rounds }, (_, i) => h('span', { class: i < round ? (dots.dataset[`r${i}`] === '1' ? 'hit' : 'miss') : '' }))); };
      const loop = () => { if (over || round >= p.rounds) return; mark.style.left = `${pos() * 100}%`; requestAnimationFrame(loop); };
      function shot() {
        if (round >= p.rounds) return;
        const x = pos();
        const ok = x >= zone && x <= zone + p.zone;
        dots.dataset[`r${round}`] = ok ? '1' : '0';
        if (ok) { hits++; vibrate([40]); } else vibrate([150]);
        round++;
        paint();
        status.textContent = `${hits} centri su ${round} (ne servono ${p.need})`;
        if (round >= p.rounds || hits >= p.need || p.rounds - round < p.need - hits) { stop.disabled = true; setTimeout(() => finish({ ok: hits >= p.need }), 400); return; }
        next();
      }
      status.textContent = `Ne servono ${p.need} su ${p.rounds}`;
      next(); paint(); loop();
    }
    // Tocca in ordine: i numeri da 1 a 9, mescolati, prima che finisca il tempo.
    function ordine(p) {
      const nums = Array.from({ length: p.n }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
      let want = 1;
      const end = Date.now() + p.seconds * 1000;
      const btns = nums.map((n) => h('button', { type: 'button', class: 'mg-num', onclick: (e) => {
        if (n === want) { e.currentTarget.classList.add('done'); e.currentTarget.disabled = true; want++; vibrate([20]); if (want > p.n) finish({ ok: true }); }
        else { e.currentTarget.classList.add('bad'); vibrate([120]); const b = e.currentTarget; setTimeout(() => b.classList.remove('bad'), 300); }
      } }, String(n)));
      area.replaceChildren(h('div', { class: 'mg-grid' }, btns));
      const tick = () => {
        if (over || want > p.n) return;
        const s = Math.ceil((end - Date.now()) / 1000);
        if (s <= 0) { btns.forEach((b) => { b.disabled = true; }); finish({ ok: false }); return; }
        status.textContent = `Prossimo: ${want} · ${s}s`;
        setTimeout(tick, 200);
      };
      tick();
    }
    start();
  });
}
