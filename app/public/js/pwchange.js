// Cambio password obbligatorio: dopo un reset della regia, al primo accesso la persona sceglie la sua password.
// Torna quando la password è cambiata (la finestra non si chiude senza).
import { h, api, toast } from './lib.js';

export function forcePasswordChange(username = '') {
  return new Promise((resolve) => {
    const p1 = h('input', { class: 'input', type: 'password', minlength: 8, required: true, autocomplete: 'new-password', placeholder: 'almeno 8 caratteri' });
    const p2 = h('input', { class: 'input', type: 'password', minlength: 8, required: true, autocomplete: 'new-password', placeholder: 'ripeti la password' });
    const btn = h('button', { class: 'btn btn-primary btn-xl btn-block', type: 'submit' }, 'Salva la nuova password');
    const el = h('div', { class: 'pw-force', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Scegli una nuova password' },
      h('form', { class: 'pw-card stack', onsubmit: async (e) => {
        e.preventDefault();
        if (p1.value !== p2.value) return toast('Le due password non coincidono', 'error');
        btn.disabled = true;
        try {
          await api('POST', '/api/account/password', { password: p1.value });
          toast('Password cambiata', 'ok');
          el.remove();
          resolve(true);
        } catch (err) { toast(err.offline ? 'Serve la rete per cambiare la password' : err.message, 'error', 6000); btn.disabled = false; }
      } },
      h('div', { class: 'eyebrow' }, '🔑 Nuova password'),
      h('h2', null, 'Scegli la tua password'),
      h('p', { class: 'small muted' }, `La regia ti ha dato una password temporanea${username ? ` per @${username}` : ''}. Prima di continuare scegline una tua: la userai per entrare d'ora in poi.`),
      h('label', { class: 'field' }, h('span', null, 'Nuova password'), p1),
      h('label', { class: 'field' }, h('span', null, 'Ripeti la password'), p2),
      btn));
    document.body.append(el);
    setTimeout(() => p1.focus(), 50);
  });
}
