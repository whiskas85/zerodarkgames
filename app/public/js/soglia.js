// La Soglia: validazione finale dei frammenti (validatore o regia).
import { h, mount, api, fmtTime, fmtDuration, makeClock, toast, dialog, stream, store, STATUS_LABELS, wordCeremony, exitDenied } from './lib.js';

const $root = document.getElementById('root');
// Countdown di gara (orologio del server, come in regia e nell'app).
const clock = makeClock();
setInterval(() => {
  for (const el of document.querySelectorAll('[data-clock="remaining"]')) el.textContent = clock.snap?.startedAt ? fmtDuration(clock.remaining()) : clock.snap ? fmtDuration(clock.snap.durationMs) : '—';
}, 1000);
// Solo la Soglia (validazione e uscita): accettazione e test armi hanno le loro pagine.
const can = (p) => V.me?.role === 'master' || !!V.me?.perms?.includes(p);
const V = { me: null, games: [], gameId: store.get('zdg_soglia_game'), data: null, teamId: null, team: null, typed: {}, check: null, mode: 'app' };

(async function boot() {
  // Service worker: serve anche per installare la pagina come app (telefono, tablet, computer).
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try { V.me = (await api('GET', '/api/auth/me')).user; } catch { /* offline */ }
  // Senza la Soglia: le sue azioni sono nella pagina del Consiglio.
  if (V.me && !can('soglia')) { location.replace('/consiglio'); return; }
  if (V.me) await start(); else render();
})();

async function start() {
  V.games = await api('GET', '/api/v/games');
  // Partita ricordata finita o sparita: si passa a quella in corso (o pronta), la stessa della regia.
  const live = V.games.find((g) => ['truce', 'hunt', 'last_half_hour', 'paused', 'circle', 'ready'].includes(g.status));
  const kept = V.games.find((g) => g.id === V.gameId);
  if (!kept || (kept.status === 'ended' && live)) V.gameId = (live || V.games[0])?.id || null;
  stream('/api/stream?as=staff', {
    refresh: (d) => { if (d.gameId === V.gameId) load(); },
    // Una coppia ha inquadrato il codice di uscita: la Soglia si apre (la Parola si compone) o nega l'uscita.
    soglia: (d) => { if (d.gameId === V.gameId) sogliaEffect(d); },
  });
  await load();
}

async function load() {
  if (!V.gameId) return render();
  try {
    V.data = await api('GET', `/api/v/games/${V.gameId}/teams`);
    clock.set(V.data.clock);
    if (V.teamId) V.team = await api('GET', `/api/v/teams/${V.teamId}`);
  } catch (e) { toast(e.message, 'error'); }
  render();
}

function render() {
  if (!V.me) return mount($root, login());
  mount($root,
    h('header', { class: 'topbar soglia-top' },
      h('div', { class: 'brand' }, h('div', { class: 'emblem sm' }, h('span', null, '0')), h('div', null, h('div', { class: 'brand-t' }, 'La Soglia'), h('div', { class: 'eyebrow' }, `Ufficiale del Consiglio · ${V.me.username}`))),
      h('select', { class: 'input game-select', onchange: (e) => { V.gameId = Number(e.target.value); store.set('zdg_soglia_game', V.gameId); V.teamId = null; V.team = null; load(); } },
        V.games.map((g) => h('option', { value: g.id, selected: g.id === V.gameId }, `${g.name} · ${STATUS_LABELS[g.status]}`))),
      h('div', { class: 'top-actions' }, h('button', { class: 'btn btn-sm btn-ghost', onclick: async () => { await api('POST', '/api/auth/logout').catch(() => {}); location.href = '/'; } }, 'Esci'))),
    V.me.role === 'master' ? null : h('nav', { class: 'soglia-tabs' }, h('a', { href: '/consiglio' }, 'Consiglio ↗')),
    h('main', { class: 'content soglia' },
      // Countdown di gara ben visibile, sopra a tutto.
      V.data?.clock ? h('div', { class: 'race-clock' },
        h('div', { class: 'eyebrow' }, 'Tempo di gara rimanente'),
        h('div', { class: 'mono race-time', 'data-clock': 'remaining' }, clock.snap?.startedAt ? fmtDuration(clock.remaining()) : fmtDuration(V.data.clock.durationMs)),
        h('span', { class: `chip status-${V.data.clock.status}` }, STATUS_LABELS[V.data.clock.status])) : null,
      h('div', { class: 'reminder' }, h('strong', null, 'Si presenta una sola coppia: le alleanze vanno sciolte prima.'), ' Alla Soglia non si combatte.'),
      !V.gameId ? h('p', { class: 'empty' }, 'Nessuna partita avviata.')
        : h('div', { class: 'soglia-cols' }, h('div', { class: 'soglia-main' }, V.team ? teamView() : teamList()), exitPanel())));
}

// A fianco: il QR del codice di uscita, da far inquadrare alla coppia con la Parola intera (come il cartello).
function exitPanel() {
  const d = V.data;
  if (!d) return null;
  const box = h('div', { class: 'exit-qr' });
  if (d.exitSvg) box.innerHTML = d.exitSvg; // SVG generato dal server
  return h('aside', { class: 'panel exit-panel' },
    h('div', { class: 'eyebrow' }, 'La Soglia · codice di uscita'),
    d.exitSvg ? box : h('p', { class: 'muted' }, 'Codice di uscita non ancora creato: si crea quando la Soglia è segnata sulla mappa.'),
    d.exitCode ? h('div', { class: 'mono exit-code' }, `${d.game.name} · codice ${d.exitCode}`) : null,
    d.exitCode ? h('p', { class: 'tiny muted' }, 'Lo stesso codice è scritto sotto il QR del cartello stampato: se non coincide, avete scelto un\'altra partita in alto.') : null,
    h('p', { class: 'small' }, 'Con la Parola intera la coppia lo inquadra con l\'app («Leggi il codice di uscita») ed esce. Chi è ancora in alleanza non esce. Uscendo, il suo Sigillo viene rivelato a tutti.'),
    // Prova a schermo, senza toccare la partita: gli stessi effetti che partono quando una coppia inquadra il codice.
    h('div', { class: 'exit-try' }, h('div', { class: 'eyebrow' }, 'Prova gli effetti'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => sogliaEffect({ ok: false, reason: 'missing', missing: 2, total: 6, sectorName: 'di prova', roman: '' }) }, '✕ Uscita negata'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => sogliaEffect({ ok: true, position: 1, word: d.word?.filter(Boolean).length ? d.word : ['LA', 'PA', 'RO', 'LA'], sectorName: 'di prova', roman: '' }) }, '✦ La Parola si compone')));
}

function sogliaEffect(d) {
  const who = `${d.roman ? `${d.roman} · ` : ''}Settore ${d.sectorName}`;
  if (d.ok) {
    wordCeremony(d.word, { eyebrow: `${who} · la Soglia si apre`, title: d.position ? `${d.position}° posto` : 'Esfiltrati' });
    return;
  }
  exitDenied({ lines: [who, d.reason === 'alliance'
    ? `Ancora alleati${d.allies?.length ? ` con ${d.allies.map((n) => `il Settore ${n}`).join(', ')}` : ''}: un'alleanza non passa la Soglia.`
    : `Parola incompleta: mancano ${d.missing === 1 ? '1 frammento' : `${d.missing} frammenti`}${d.total ? ` (${d.total - d.missing} / ${d.total})` : ''}.`] });
}

// Niente login proprio: tutto passa dal login principale.
function login() {
  location.replace('/');
  return h('main', { class: 'login-page' }, h('p', { class: 'muted' }, 'Accesso…'));
}

function teamList() {
  const d = V.data;
  if (!d) return h('p', { class: 'empty' }, 'Caricamento…');
  return h('div', { class: 'stack' },
    h('div', { class: 'panel-head' }, h('h2', null, 'Scegli la coppia'), h('span', { class: 'chip' }, STATUS_LABELS[d.clock.status])),
    h('div', { class: 'soglia-teams' }, d.teams.map((t) => h('button', { class: `soglia-team ${t.status}`, disabled: t.status === 'withdrawn', onclick: async () => { V.teamId = t.teamId; V.typed = {}; V.check = null; V.mode = 'app'; await load(); } },
      h('span', { class: 'team-roman' }, t.roman), h('span', { class: 'grow' }, h('strong', null, t.sectorName), t.displayName ? h('div', { class: 'tiny muted' }, t.displayName) : null),
      t.status === 'won' ? h('span', { class: 'chip chip-ok' }, `${t.finishPosition}°`) : t.status === 'withdrawn' ? h('span', { class: 'chip' }, 'ritirata') : h('span', { class: 'mono' }, `${t.fragments} fr.`)))));
}

function teamView() {
  const { team, fragments, complete, validations } = V.team;
  const active = ['truce', 'hunt', 'last_half_hour'].includes(V.data?.clock.status);
  const canValidate = active && team.status === 'active';
  const checkBy = Object.fromEntries((V.check || []).map((c) => [c.position, c.status]));
  const notes = h('input', { class: 'input', placeholder: 'Note (facoltative)' });

  const validate = async () => {
    const typed = Object.entries(V.typed).map(([position, text]) => ({ position: Number(position), text }));
    if (!(await dialog({ title: 'Registrare la validazione?', text: V.mode === 'typed' ? 'Confronto dei frammenti dettati dalla coppia.' : 'Verifica dei frammenti presenti nell\'app della coppia.', okLabel: 'Valida' }))) return;
    try {
      const r = await api('POST', `/api/v/teams/${team.id}/validate`, { mode: V.mode, typed, notes: notes.value });
      if (r.result === 'valid') toast(`VALIDATA: ${team.sectorName} è ${r.position}°`, 'ok', 9000);
      else toast(`Esito: ${r.result === 'wrong' ? 'errata' : 'incompleta'} — la coppia torna in gioco`, 'error', 9000);
      await load();
    } catch (e) { toast(e.message, 'error'); }
  };

  return h('div', { class: 'stack' },
    h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { V.teamId = null; V.team = null; render(); } }, '‹ Tutte le coppie'),
    h('div', { class: 'panel' },
      h('div', { class: 'team-head' }, h('span', { class: 'team-roman' }, team.roman), h('div', { class: 'grow' }, h('h2', null, `Settore ${team.sectorName}`), h('div', { class: 'muted' }, team.members.map((m) => m.name + (m.nickname ? ` «${m.nickname}»` : '')).join(' e '))),
        team.status === 'won' ? h('span', { class: 'chip chip-ok' }, `validata · ${team.finishPosition}°`) : null),
      h('div', { class: 'mode-switch' },
        h('button', { class: `btn btn-sm ${V.mode === 'app' ? 'btn-primary' : ''}`, onclick: () => { V.mode = 'app'; render(); } }, 'Frammenti nell\'app'),
        h('button', { class: `btn btn-sm ${V.mode === 'typed' ? 'btn-primary' : ''}`, onclick: () => { V.mode = 'typed'; render(); } }, 'Frammenti dettati')),
      V.mode === 'app'
        ? h('ol', { class: 'check-list' }, fragments.map((f) => h('li', { class: f.owned ? 'ok' : 'ko' },
          h('span', { class: 'mark' }, f.owned ? '✓' : '✗'), h('span', { class: 'mono pos' }, f.position),
          h('div', { class: 'grow' }, h('strong', null, f.owned ? f.text : 'mancante'), h('div', { class: 'tiny muted' }, f.pointLabel + (f.source === 'manual' ? ' · ricevuto' : ''))))))
        : h('div', { class: 'stack-sm' },
          h('p', { class: 'muted tiny' }, 'Scrivi i frammenti che la coppia ti mostra o ti legge, nell\'ordine della Parola.'),
          h('ol', { class: 'check-list' }, fragments.map((f) => h('li', { class: checkBy[f.position] === 'ok' ? 'ok' : checkBy[f.position] ? 'ko' : '' },
            h('span', { class: 'mark' }, checkBy[f.position] === 'ok' ? '✓' : checkBy[f.position] ? '✗' : '·'), h('span', { class: 'mono pos' }, f.position),
            h('input', { class: 'input input-sm grow', value: V.typed[f.position] || '', placeholder: f.pointLabel, oninput: (e) => { V.typed[f.position] = e.target.value; } })))),
          h('button', { class: 'btn btn-sm', onclick: async () => {
            V.check = await api('POST', `/api/v/teams/${team.id}/check`, { typed: Object.entries(V.typed).map(([position, text]) => ({ position: Number(position), text })) });
            render();
          } }, 'Confronta')),
      V.mode === 'app' ? h('div', { class: complete ? 'verdict ok' : 'verdict ko' }, complete ? 'Parola completa nell\'app' : `Mancano ${fragments.filter((f) => !f.owned).length} frammenti`) : null,
      canValidate ? h('div', { class: 'stack-sm' }, notes, h('button', { class: 'btn btn-primary btn-xl btn-block', onclick: validate }, 'Registra esito alla Soglia'))
        : h('p', { class: 'muted' }, team.status === 'won' ? 'Coppia già validata.' : 'Si valida solo a partita in corso.')),
    validations.length ? h('div', { class: 'panel' }, h('h3', { class: 'sub' }, 'Tentativi precedenti'), h('ul', { class: 'users' }, validations.map((v) => h('li', null,
      h('span', { class: 'mono tiny' }, fmtTime(v.at, true)), h('span', { class: `chip ${v.result === 'valid' ? 'chip-ok' : 'chip-blood'}` }, { valid: 'valida', incomplete: 'incompleta', wrong: 'errata' }[v.result]), v.notes || '')))) : null);
}
