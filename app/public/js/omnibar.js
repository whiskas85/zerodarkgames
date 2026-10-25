// Omnibar: una barra che cerca in tutto il testo delle card e le filtra (app e regia).
import { h } from './lib.js';
import { mdi } from './mdi.js';

// Senza accenti e maiuscole: «Città» si trova anche scrivendo «citta».
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Vero se ogni parola cercata compare da qualche parte nei campi.
export function matches(query, ...fields) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold(fields.flat(Infinity).filter((x) => x != null).join(' '));
  return words.every((w) => hay.includes(w));
}

// La barra: onInput riceve il testo a ogni tasto; count (facoltativo) mostra quante card restano.
export function omnibar({ keep, value = '', placeholder = 'Cerca…', onInput, count = null }) {
  const input = h('input', { class: 'omni-input', type: 'search', 'data-keep': keep, value, placeholder, autocomplete: 'off', spellcheck: 'false', 'aria-label': placeholder,
    oninput: (e) => onInput(e.target.value),
    onkeydown: (e) => { if (e.key === 'Escape' && e.target.value) { e.target.value = ''; onInput(''); } } });
  return h('div', { class: 'omnibar' },
    h('span', { class: 'omni-ico', 'aria-hidden': 'true' }, mdi('magnify', 20)),
    input,
    value && count != null ? h('span', { class: 'omni-count' }, String(count)) : null,
    value ? h('button', { class: 'omni-clear', type: 'button', 'aria-label': 'Cancella la ricerca', onclick: () => { input.value = ''; onInput(''); } }, mdi('close', 18)) : null);
}
