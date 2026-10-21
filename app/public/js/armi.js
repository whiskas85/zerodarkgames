// Test armi in una pagina a sé (regia e staff): conto alla rovescia all'inizio dell'evento e cruscotto del cronografo.
import * as CKUI from './checkin-ui.js';
import { h, mount, api, makeClock, fmtDuration, toast, stream, store, STATUS_LABELS } from './lib.js';

const $root = document.getElementById('root');
const clock = makeClock();
const PRE = ['created', 'draft', 'ready', 'circle'];
const params = new URLSearchParams(location.search);
const A = { me: null, games: [], gameId: Number(params.get('g')) || store.get('zdg_armi_game'), data: null };

// Conto alla rovescia: all'inizio previsto se la partita è in preparazione, altrimenti il tempo di gara rimanente.
const pad = (n) => String(n).padStart(2, '0');
function countdown() {
  const d = A.data;
  if (!d) return '—';
  const st = d.game.scheduledStart ? new Date(d.game.scheduledStart).getTime() : null;
  if (PRE.includes(d.game.status) && st) {
    const sec = Math.max(0, Math.floor((st - clock.serverNow()) / 1000));
    const days = Math.floor(sec / 86400);
    return `${days ? `${days}g ` : ''}${pad(Math.floor(sec / 3600) % 24)}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`;
  }
  return clock.snap?.startedAt ? fmtDuration(clock.remaining()) : '—';
}
setInterval(() => { for (const el of document.querySelectorAll('[data-cd]')) el.textContent = countdown(); }, 1000);

(async function boot() {
  try { A.me = (await api('GET', '/api/auth/me')).user; } catch { /* offline */ }
  if (!A.me) { location.replace('/'); return; }
  if (A.me.role !== 'master' && !A.me.perms?.includes('armi')) { location.replace('/consiglio'); return; }
  A.games = await api('GET', '/api/v/games');
  const live = A.games.find((g) => ['truce', 'hunt', 'last_half_hour', 'paused', 'circle', 'ready', 'draft'].includes(g.status));
  if (!A.games.some((g) => g.id === A.gameId)) A.gameId = (live || A.games[0])?.id || null;
  stream('/api/stream?as=staff', { refresh: (d) => { if (d.gameId === A.gameId) load(); } });
  await load();
})();

async function load() {
  if (!A.gameId) return render();
  try {
    A.data = await api('GET', `/api/v/games/${A.gameId}/checkin`);
    clock.set(A.data.clock);
  } catch (e) { toast(e.message, 'error'); }
  render();
}

const ctx = () => ({
  data: A.data,
  render,
  base: `/api/v/games/${A.gameId}`,
  call: async (method, path, body, okMsg) => {
    try {
      const r = await api(method, `/api/v/games/${A.gameId}${path}`, body);
      if (okMsg) toast(okMsg, 'ok');
      await load();
      return r ?? true;
    } catch (e) { toast(e.message, 'error', 7000); return null; }
  },
});

function render() {
  const d = A.data;
  const pre = d && PRE.includes(d.game.status) && d.game.scheduledStart;
  mount($root,
    h('header', { class: 'topbar soglia-top' },
      h('div', { class: 'brand' }, h('div', { class: 'emblem sm' }, h('span', null, '0')), h('div', null, h('div', { class: 'brand-t' }, 'Test armi'), h('div', { class: 'eyebrow' }, `Consiglio Zero · ${A.me?.username || ''}`))),
      h('select', { class: 'input game-select', onchange: (e) => { A.gameId = Number(e.target.value); store.set('zdg_armi_game', A.gameId); A.data = null; load(); } },
        A.games.map((g) => h('option', { value: g.id, selected: g.id === A.gameId }, `${g.name} · ${STATUS_LABELS[g.status]}`))),
      h('div', { class: 'top-actions' }, h('a', { class: 'btn btn-sm btn-ghost', href: A.me?.role === 'master' ? '/regia' : '/consiglio' }, A.me?.role === 'master' ? 'Regia' : 'Consiglio'))),
    h('main', { class: 'content armi' },
      d ? h('div', { class: 'event-cd' },
        h('div', { class: 'eyebrow' }, pre ? 'Inizio dell\'evento tra' : 'Tempo di gara rimanente'),
        h('div', { class: 'mono cd-time', 'data-cd': '1' }, countdown()),
        h('span', { class: `chip status-${d.game.status}` }, STATUS_LABELS[d.game.status])) : null,
      !A.gameId ? h('p', { class: 'empty' }, 'Nessuna partita.') : !d ? h('p', { class: 'empty' }, 'Caricamento…') : CKUI.viewChrono(ctx())));
}
