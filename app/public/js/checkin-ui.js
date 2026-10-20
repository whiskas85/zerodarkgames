// Accettazione a inizio evento e Test armi: condivisi tra la regia e lo staff (pagina Soglia).
// ctx = { data: { players, teams, elect, squads }, call(method, path, body, okMsg), render() }.
import { h, fmtTime, dialog } from './lib.js';

const section = (title, ...children) => h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, title)), ...children);

let ckFilter = '';
const personLabel = (p) => [p.name, p.nickname ? `«${p.nickname}»` : null].filter(Boolean).join(' ');
// Persone accettate raggruppate per squadra: coppie (per Settore), Eletti (per squadra), chi è ancora senza coppia.
function peopleGroups(ctx, only = () => true, keepEmpty = false) {
  const ms = ctx.data;
  const f = ckFilter.trim().toLowerCase();
  const match = (p) => !f || [p.name, p.nickname, p.username, p.softairTeam].some((x) => String(x || '').toLowerCase().includes(f));
  const people = ms.players.filter((p) => p.status === 'accepted' && only(p));
  const out = ms.teams.filter((t) => t.status !== 'withdrawn').map((t) => ({ team: t, dest: { teamId: t.id }, title: `${t.roman || '—'} · Settore ${t.sectorName || 'da assegnare'}`, sub: t.displayName, people: people.filter((p) => p.teamId === t.id) }));
  const elect = people.filter((p) => p.teamId === ms.elect?.id);
  for (const sq of ms.squads || []) out.push({ dest: { squadId: sq.id }, title: `Eletti · Squadra ${sq.name}`, people: elect.filter((p) => p.squadId === sq.id), color: sq.color });
  out.push({ dest: { elect: true }, title: 'Eletti senza squadra', people: elect.filter((p) => !p.squadId || !(ms.squads || []).some((x) => x.id === p.squadId)) });
  const inTeam = new Set([...ms.teams.map((t) => t.id), ms.elect?.id]);
  out.push({ dest: { none: true }, title: 'Senza coppia', people: people.filter((p) => !inTeam.has(p.teamId)) });
  // All'accettazione restano anche i gruppi vuoti (Settore senza nessuno, squadra nuova): ci si trascina dentro.
  return out.map((g) => ({ ...g, all: g.people, people: g.people.filter(match) })).filter((g) => g.people.length || (keepEmpty && !ckFilter.trim()));
}
const ckSearch = (ctx) => h('input', { class: 'input input-sm', type: 'search', placeholder: 'Cerca per nome, soprannome, team softair…', value: ckFilter, 'data-keep': 'ck-filter', oninput: (e) => { ckFilter = e.target.value; ctx.render(); } });
const ckCount = (n, tot, label) => h('div', { class: 'ck-count' }, h('strong', { class: 'mono' }, `${n}/${tot}`), h('span', { class: 'tiny muted' }, label));

export function viewCheckin(ctx) {
  const ms = ctx.data;
  const accepted = ms.players.filter((p) => p.status === 'accepted');
  const present = accepted.filter((p) => p.checkinAt).length;
  const teamsOk = ms.teams.filter((t) => t.checkinAt).length;
  const pending = ms.players.filter((p) => p.status === 'pending').length;
  const toggle = (p) => ctx.call('POST', (`/checkin/player/${p.id}`), { on: !p.checkinAt }, p.checkinAt ? null : `${p.nickname || p.name}: presente`);
  const teamToggle = async (t) => {
    if (t.checkinAt && !(await dialog({ title: 'Annullare la conferma?', text: `${t.roman} · Settore ${t.sectorName}: la coppia torna da confermare.`, okLabel: 'Annulla conferma' }))) return;
    ctx.call('POST', (`/checkin/team/${t.id}`), { on: !t.checkinAt }, t.checkinAt ? 'Conferma annullata' : 'Coppia confermata');
  };
  return h('div', { class: 'stack' },
    section('Accettazione',
      h('p', { class: 'muted tiny' }, 'All\'arrivo al campo: segna chi è presente, poi conferma la coppia quando ci sono tutti e due. Solo gli iscritti già approvati; chi è presente compare nel Test armi.'),
      h('div', { class: 'ck-counts' }, ckCount(present, accepted.length, 'presenti'), ckCount(teamsOk, ms.teams.length, 'coppie confermate')),
      pending ? h('p', { class: 'small warn-text' }, `${pending} iscrizioni ancora da approvare: le trovi in «Iscrizioni e coppie».`) : null,
      ckSearch(ctx)),
    h('p', { class: 'tiny muted' }, 'Manca qualcuno? Trascina le persone con la maniglia ⠿ da una coppia all\'altra (se ha un posto libero), tra le squadre degli Eletti o su «Nuova squadra di Eletti». La coppia toccata torna da confermare.'),
    h('div', { class: 'ck-grid' }, peopleGroups(ctx, () => true, true).map((g) => {
      const allIn = g.all.length > 0 && g.all.every((p) => p.checkinAt);
      return h('div', { class: `panel ck-group ${g.team?.checkinAt ? 'ck-done' : ''}`, 'data-drop': JSON.stringify(g.dest), style: { '--c': g.team?.color || g.color || 'var(--line)' } },
        h('div', { class: 'ck-head' }, h('strong', null, g.title), g.sub ? h('span', { class: 'tiny muted' }, g.sub) : null),
        g.people.length ? null : h('p', { class: 'ck-empty tiny muted' }, 'Vuota: trascina qui qualcuno'),
        g.people.map((p) => h('div', { class: 'ck-row' }, h('span', { class: 'ck-grip', title: 'Trascina per spostare', 'aria-label': `Sposta ${p.name}`, onpointerdown: (e) => ckDrag(ctx, e, p) }, '⠿'), h('button', { class: `ck-person ${p.checkinAt ? 'on' : ''}`, type: 'button', onclick: () => toggle(p) },
          h('span', { class: 'ck-box', 'aria-hidden': 'true' }, p.checkinAt ? '✓' : ''),
          h('span', { class: 'grow' }, h('strong', null, personLabel(p)), h('span', { class: 'tiny muted' }, [p.username ? `@${p.username}` : null, p.softairTeam].filter(Boolean).join(' · '))),
          h('span', { class: 'tiny' }, p.checkinAt ? `presente ${fmtTime(p.checkinAt)}` : 'presente?')))),
        g.team ? h('button', { class: `btn btn-block ${g.team.checkinAt ? 'btn-ok' : 'btn-primary'}`, type: 'button', disabled: !g.team.checkinAt && !allIn, onclick: () => teamToggle(g.team) },
          g.team.checkinAt ? `✓ Coppia confermata · ${fmtTime(g.team.checkinAt)}` : allIn ? 'Conferma la coppia' : 'Conferma la coppia (manca qualcuno)') : null);
    }),
    // Nuova squadra di Eletti: si crea toccando, oppure trascinandoci sopra qualcuno.
    h('button', { class: 'panel ck-group ck-new', type: 'button', 'data-drop': JSON.stringify({ newSquad: true }), onclick: async () => {
      const name = await dialog({ title: 'Nuova squadra di Eletti', input: { placeholder: 'Nome della squadra' }, okLabel: 'Crea' });
      if (name && name.trim()) ctx.call('POST', ('/squads'), { name: name.trim() }, 'Squadra creata');
    } }, h('strong', null, '＋ Nuova squadra di Eletti'), h('span', { class: 'tiny muted' }, 'Tocca per crearla vuota, o trascina qui una persona'))));
}

// Trascina e rilascia (mouse e dita): dalla maniglia ⠿ fino a un gruppo; al rilascio la persona viene spostata.
function ckDrag(ctx, e, p) {
  e.preventDefault();
  const ghost = h('div', { class: 'ck-ghost' }, `⠿ ${personLabel(p)}`);
  document.body.append(ghost);
  let over = null;
  const at = (x, y) => document.elementsFromPoint(x, y).find((el) => el.dataset?.drop);
  const move = (ev) => {
    ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
    const z = at(ev.clientX, ev.clientY);
    if (z !== over) { over?.classList.remove('ck-over'); over = z; over?.classList.add('ck-over'); }
    // Vicino ai bordi la pagina scorre da sola.
    if (ev.clientY < 60) window.scrollBy(0, -12); else if (ev.clientY > window.innerHeight - 60) window.scrollBy(0, 12);
  };
  const end = async () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    ghost.remove();
    over?.classList.remove('ck-over');
    if (!over) return;
    let dest = JSON.parse(over.dataset.drop);
    if (dest.newSquad) {
      const name = await dialog({ title: 'Nuova squadra di Eletti', text: `${personLabel(p)} entra nella nuova squadra.`, input: { placeholder: 'Nome della squadra' }, okLabel: 'Crea e sposta' });
      if (!name || !name.trim()) return;
      dest = { newSquad: name.trim() };
    }
    ctx.call('POST', (`/place/${p.id}`), dest, `${p.nickname || p.name} spostato`);
  };
  move(e);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

const CHRONO = [['main', 'chronoMain', 'Arma principale'], ['backup', 'chronoBackup', 'Principale di riserva'], ['secondary', 'chronoSecondary', 'Arma secondaria']];
export function viewChrono(ctx) {
  const ms = ctx.data;
  const present = ms.players.filter((p) => p.status === 'accepted' && p.checkinAt);
  const mainOk = present.filter((p) => p.chronoMain).length;
  const toggle = (p, weapon, col) => ctx.call('POST', (`/chrono/${p.id}`), { weapon, on: !p[col] });
  const groups = peopleGroups(ctx, (p) => !!p.checkinAt);
  return h('div', { class: 'stack' },
    section('Test armi',
      h('p', { class: 'muted tiny' }, 'Prova al cronografo, persona per persona. Segnare un\'arma vuol dire che è stata provata ed è minore di 1 joule. Compare solo chi è stato accettato all\'ingresso.'),
      h('div', { class: 'ck-counts' }, ckCount(mainOk, present.length, 'con l\'arma principale provata')),
      ckSearch(ctx)),
    groups.length ? h('div', { class: 'ck-grid' }, groups.map((g) => h('div', { class: 'panel ck-group', style: { '--c': g.team?.color || g.color || 'var(--line)' } },
      h('div', { class: 'ck-head' }, h('strong', null, g.title), g.sub ? h('span', { class: 'tiny muted' }, g.sub) : null),
      g.people.map((p) => h('div', { class: 'chrono-person' },
        h('strong', null, personLabel(p)),
        h('div', { class: 'chrono-row' }, CHRONO.map(([weapon, col, label]) => h('button', { class: `chrono-btn ${p[col] ? 'on' : ''}`, type: 'button', title: p[col] ? `Provata alle ${fmtTime(p[col])}` : 'Tocca se è minore di 1 joule', onclick: () => toggle(p, weapon, col) },
          h('span', { class: 'ck-box', 'aria-hidden': 'true' }, p[col] ? '✓' : ''),
          h('span', null, label, h('span', { class: 'tiny' }, 'minore di 1 joule'))))))))))
      : h('p', { class: 'empty' }, ckFilter ? 'Nessuno con questo nome.' : 'Ancora nessuno accettato: prima passa dall\'Accettazione.'));
}

