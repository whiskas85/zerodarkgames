// Guida delle Skill: spiegazione dettagliata e «schermate» illustrate di cosa succede (pagina #/skill/<id>).
// I numeri (durate, ricariche, raggi) arrivano dalla Skill della partita, così la guida resta giusta anche se la regia li cambia.
import { h } from './lib.js';

const min = (n) => (n === 1 ? '1 minuto' : `${n} minuti`);

// Schermate: mappa (coppie, aree, Altari), scheda in home, notifica, Sigillo, scelta da elenco.
// Coordinate in percentuale dentro il riquadro.
export const SKILL_GUIDE = {
  occhio: (s) => ({
    how: 'Toccate «Usa»: parte subito, non serve scegliere nessuno. Per tutta la durata la mappa mostra le coppie vicine a voi.',
    effect: [`Per ${min(s.durationMin)} vedete sulla mappa ogni coppia che si trova entro il raggio dell'Occhio dalla vostra posizione, aggiornata in continuo.`,
      'Dopo 1 minuto le coppie viste ricevono un avviso: sanno di essere osservate, non da chi.'],
    tips: 'Usatelo prima di avvicinarvi a un Altare conteso: sapete chi c\'è intorno prima di entrare nel raggio di tiro.',
    shots: [
      { t: 'map', me: [50, 55], areas: [[50, 55, 34, '#d1ad62']], dots: [[30, 40, 'enemy', 'II'], [68, 70, 'enemy', 'V'], [88, 18, 'far', 'III']], cap: 'Le coppie nel cerchio compaiono; quelle fuori restano invisibili.' },
      { t: 'notify', title: 'Siete osservati', body: 'Qualcuno vi ha visto con l\'Occhio del Consiglio.', cap: 'Cosa vede la coppia osservata, 1 minuto dopo.' },
    ],
  }),
  ombra: (s) => ({
    how: 'Toccate «Usa»: da quel momento sparite dalle mappe delle altre coppie.',
    effect: [`Per ${min(s.durationMin)} la vostra posizione non compare a nessuno: né con Occhio o Rete, né con Tracker, Tracciamento o Taglia.`,
      'Chi vi stava già seguendo vede il vostro pallino sparire.'],
    tips: 'Perfetta per uscire da un Tracker o da una Taglia, o per avvicinarvi alla Soglia senza farvi vedere.',
    shots: [
      { t: 'map', me: [50, 50], ghost: true, dots: [[25, 30, 'enemy', 'IV']], cap: 'Sulla mappa degli altri il vostro pallino non c\'è.' },
      { t: 'card', ico: '🥷', eyebrow: 'Ombra · ancora 12:40', title: 'Siete invisibili alle altre coppie', bar: 0.8, cap: 'Il conto alla rovescia nella vostra home.' },
    ],
  }),
  intercettazione: () => ({
    how: 'Toccate «Usa» e scegliete una coppia dall\'elenco.',
    effect: ['Scoprite di quali Settori quella coppia conosce il Sigillo. Il codice resta sfocato: sapete chi ha in mano, non cosa.',
      'La coppia intercettata non viene avvisata.'],
    tips: 'Utile per capire chi è vicino alla Parola intera, o chi conosce il vostro Sigillo.',
    shots: [
      { t: 'pick', title: 'Su quale coppia?', items: ['I · Fuoco', 'II · Acqua', 'IV · Aria'], sel: 1, cap: 'Si sceglie la coppia.' },
      { t: 'seal', items: [['III · Terra', 'blur'], ['V · Ferro', 'blur']], cap: 'Il risultato: i Settori, con il codice sfocato.' },
    ],
  }),
  segugio: () => ({
    how: 'Toccate «Usa» e scegliete una coppia. Il Segugio resta in ascolto finché lei non conquista un Altare.',
    effect: ['Alla sua prossima conquista vi arriva una notifica con il nome dell\'Altare e l\'ora. In home compare la scheda del Segugio per 30 minuti.',
      'La coppia seguita non viene avvisata.'],
    tips: 'Sapere dove ha appena aperto un Altare vi dice dove si trova: è il momento di andarle incontro.',
    shots: [
      { t: 'notify', title: '🦅 Segugio', body: 'Il Settore Acqua ha appena conquistato l\'Altare del Ferro.', cap: 'La notifica, anche a telefono in tasca.' },
      { t: 'card', ico: '🦅', eyebrow: 'Segugio · 14:32', title: 'II Acqua ha conquistato l\'Altare del Ferro', cap: 'La scheda in home.' },
    ],
  }),
  custode: (s) => ({
    how: 'Toccate «Usa» e scegliete quale Sigillo proteggere tra quelli che conoscete (anche il vostro).',
    effect: [`Per ${min(s.durationMin)} le altre coppie che conoscono quel Sigillo lo vedono coperto, con il conto alla rovescia: non possono leggerlo né usarlo per aprire il suo Altare.`],
    tips: 'Proteggete il vostro Sigillo appena qualcuno l\'ha scoperto, o quello di un Altare che state per aprire voi.',
    shots: [
      { t: 'seal', items: [['IV · Aria', 'guard']], cap: 'Cosa vedono gli altri: Sigillo custodito, con il tempo che manca.' },
      { t: 'pick', title: 'Quale Sigillo proteggere?', items: ['IV · Aria (il vostro)', 'II · Acqua', 'VI · Legno'], sel: 0, cap: 'Si sceglie il Sigillo.' },
    ],
  }),
  tracker: (s) => ({
    how: 'Toccate «Usa» e scegliete la coppia da seguire.',
    effect: [`Per ${min(s.durationMin)} vedete la sua posizione sulla mappa, aggiornata in continuo. In home una scheda vi dice chi state tracciando e quanto manca.`,
      'Dopo 1 minuto la coppia viene avvisata di essere tracciata.'],
    tips: 'Avete un minuto di vantaggio prima che lo sappia: usatelo per avvicinarvi.',
    shots: [
      { t: 'map', me: [30, 70], dots: [[65, 30, 'target', 'II']], trail: true, cap: 'La coppia tracciata, evidenziata sulla mappa.' },
      { t: 'card', ico: '⚡', eyebrow: 'Tracker · ancora 4:12', title: 'Stai tracciando II Acqua', bar: 0.8, cap: 'La scheda in home: un tocco apre la mappa.' },
    ],
  }),
  memoria: () => ({
    how: 'Toccate «Usa» e scegliete un Altare che avete già inquadrato ma la cui scansione è scaduta.',
    effect: ['La scansione torna valida, come se l\'aveste appena inquadrato: potete pronunciare il Sigillo di quell\'Altare da dove siete.'],
    tips: 'Se avete inquadrato un Altare senza conoscerne il Sigillo, lo riaprite quando lo scoprite, senza tornarci.',
    shots: [
      { t: 'pick', title: 'Quale Altare riaprire?', items: ['Altare del Fuoco · scaduto', 'Altare della Terra · scaduto'], sel: 1, cap: 'Gli Altari con la scansione scaduta.' },
      { t: 'card', ico: '⛬', eyebrow: 'Altare della Terra', title: 'Scansione valida: pronunciate il Sigillo', bar: 1, cap: 'L\'Altare è di nuovo aperto.' },
    ],
  }),
  confusione: (s) => ({
    how: 'Non si usa: si attiva da sola quando qualcuno vi vede (Occhio, Rete, Tracker, Tracciamento, Taglia).',
    effect: [`Per ${min(s.durationMin)} chi vi guarda vede due pallini: il vostro e uno falso, a qualche centinaio di metri.`,
      'Poi va in ricarica e si riattiva alla prossima occasione.'],
    tips: 'Chi vi insegue deve scegliere quale pallino seguire: il tempo che perde è vostro.',
    shots: [
      { t: 'map', me: [40, 60], dots: [[40, 60, 'enemy', 'IV'], [72, 28, 'enemy', 'IV']], cap: 'Cosa vede chi vi osserva: due pallini, uno è falso.' },
    ],
  }),
  diplomatico: () => ({
    how: 'Si usa dalla pagina Alleanze, proponendo o accettando un\'alleanza.',
    effect: ['L\'alleanza si stringe senza mostrare il vostro Sigillo agli alleati: loro vi mostrano il loro, voi no.'],
    tips: 'Alleatevi senza regalare il vostro Sigillo a chi domani sarà un nemico.',
    shots: [
      { t: 'seal', items: [['IV · Aria', 'diplo']], cap: 'Cosa vedono gli alleati al posto del vostro Sigillo.' },
    ],
  }),
  velenoso: () => ({
    how: 'Si usa dalla pagina Scontri, subito dopo uno scontro, vinto o perso.',
    effect: ['L\'alleanza della coppia avversaria si rompe all\'istante: tutti i suoi alleati ricevono l\'avviso. Scatta il blocco ingaggio di 5 minuti.'],
    tips: 'Un\'alleanza forte vi sta schiacciando? Uno scontro, poi Velenoso, e tornano soli.',
    shots: [
      { t: 'notify', title: 'Alleanza avvelenata', body: 'Il Settore Aria ha usato Velenoso: la vostra alleanza è rotta.', cap: 'L\'avviso agli alleati avversari.' },
    ],
  }),
  maestria: () => ({
    how: 'Si usa dalla pagina Scontri, su uno scontro perso.',
    effect: ['Lo scontro diventa una vittoria per voi, qualunque esito abbia dichiarato l\'avversario: è lui a mostrare il Sigillo.'],
    tips: 'È l\'asso nella manica: tenetela per lo scontro che non potete permettervi di perdere.',
    shots: [
      { t: 'card', ico: '⚔️', eyebrow: 'Scontro con II Acqua', title: 'Perso → Vinto con Maestria delle repliche', tone: 'win', cap: 'L\'esito ribaltato nello storico degli scontri.' },
    ],
  }),
  immunita: () => ({
    how: 'Si usa dalla pagina Scontri, quando perdete uno scontro.',
    effect: ['Avete perso, ma il vostro Sigillo resta coperto ai vincitori: non lo scoprono.'],
    tips: 'Perdere costa solo la Veglia, non il segreto.',
    shots: [
      { t: 'seal', items: [['IV · Aria', 'immune']], cap: 'Cosa vedono i vincitori.' },
    ],
  }),
  caccia: () => ({
    how: 'Toccate «Usa» e scegliete la coppia da far cacciare.',
    effect: ['Il Consiglio affida la missione a una squadra di Eletti, che vede il bersaglio sulla mappa finché la caccia dura.',
      'La coppia cacciata lo scopre 1 minuto dopo.'],
    tips: 'Mandate gli Eletti su chi è in testa: anche se non lo prendono, lo costringono a muoversi.',
    shots: [
      { t: 'map', me: [20, 80], dots: [[60, 35, 'target', 'I'], [45, 55, 'elect', ''], [52, 60, 'elect', '']], cap: 'Gli Eletti (pallini dorati) puntano il bersaglio.' },
      { t: 'notify', title: 'Siete cacciati', body: 'Una squadra di Eletti vi sta dando la caccia.', cap: 'L\'avviso alla coppia cacciata.' },
    ],
  }),
  rete: (s) => ({
    how: 'Toccate «Usa»: parte subito.',
    effect: [`Per ${min(s.durationMin)} vedete sulla mappa tutte le coppie in gioco, ovunque siano.`, 'Dopo 1 minuto tutte ricevono l\'avviso.'],
    tips: 'Ultimate: la ricarica è lunga. Usatela quando dovete decidere dove andare per il finale.',
    shots: [
      { t: 'map', me: [50, 50], dots: [[15, 20, 'enemy', 'I'], [80, 25, 'enemy', 'II'], [25, 75, 'enemy', 'III'], [85, 80, 'enemy', 'V'], [60, 15, 'enemy', 'VI']], cap: 'Tutte le coppie sulla mappa.' },
    ],
  }),
  veggenza: () => ({
    how: 'Toccate «Usa» e scegliete uno degli Altari che avete già inquadrato.',
    effect: ['Prendete subito il frammento di quell\'Altare, senza Sigillo e senza tornarci.'],
    tips: 'Ultimate: tenetela per l\'Altare del Settore il cui Sigillo non riuscite a scoprire.',
    shots: [
      { t: 'pick', title: 'Quale Altare?', items: ['Altare del Fuoco', 'Altare della Terra', 'Altare del Legno'], sel: 2, cap: 'Gli Altari che conoscete.' },
      { t: 'card', ico: '❖', eyebrow: 'La Parola', title: 'Nuovo frammento dall\'Altare del Legno', tone: 'win', cap: 'Il frammento arriva subito.' },
    ],
  }),
  intuizione: () => ({
    how: 'Toccate «Usa» e scegliete un Altare qualsiasi.',
    effect: ['L\'Altare si apre come se l\'aveste appena inquadrato: per sbloccarlo vi serve comunque il suo Sigillo.'],
    tips: 'Conoscete un Sigillo ma l\'Altare è lontano o sorvegliato? Apritelo da dove siete.',
    shots: [
      { t: 'map', me: [20, 75], altars: [[75, 25, 'III']], areas: [[75, 25, 14, '#d1ad62']], cap: 'Un Altare lontano, aperto senza andarci.' },
    ],
  }),
  autorita: () => ({
    how: 'Toccate «Usa».',
    effect: ['Ricevete subito un Dono a caso, che trovate in «I vostri doni».'],
    tips: 'Un Dono può essere una Chiave Maestra, un Grande Furto, un Tracciamento… è un azzardo, ma sempre utile.',
    shots: [
      { t: 'card', ico: '✦', eyebrow: 'Dono ricevuto', title: 'Chiave Maestra', tone: 'win', cap: 'Il Dono compare tra i vostri.' },
    ],
  }),
  silenzio: () => ({
    how: 'Passiva: lavora da sola per tutta la partita.',
    effect: ['Quando una coppia vi scopre con Occhio del Consiglio o Rete del Consiglio vede solo un\'area di 100 m, non il punto esatto.'],
    tips: 'Chi vi cerca sa la zona, non dove siete: dovrà battere il bosco.',
    shots: [
      { t: 'map', me: [55, 50], areas: [[55, 50, 22, '#ff4fa3']], noMe: true, cap: 'Cosa vede chi vi osserva: un\'area, non il pallino.' },
    ],
  }),
  velo: () => ({
    how: 'Passiva: sempre attiva.',
    effect: ['Tracker, Tracciamento e Taglia lanciati contro di voi durano la metà del tempo.'],
    tips: 'Chi vi segue ha meno tempo per raggiungervi.',
    shots: [
      { t: 'card', ico: '🌫️', eyebrow: 'Tracciamento su di voi', title: 'Finisce tra 2:30 invece di 5:00', bar: 0.5, cap: 'Il tracciamento si esaurisce prima.' },
    ],
  }),
  allarme: () => ({
    how: 'Passiva: sempre attiva, con il GPS del telefono.',
    effect: ['Una vibrazione silenziosa vi avvisa quando una coppia non alleata arriva entro 80 m da voi.'],
    tips: 'Tenete il telefono in tasca: se vibra, fermatevi e guardatevi intorno.',
    shots: [
      { t: 'map', me: [50, 55], areas: [[50, 55, 18, '#e5484d']], dots: [[62, 45, 'enemy', '']], cap: 'Una coppia entra nel raggio di 80 m: il telefono vibra.' },
    ],
  }),
  presagio: () => ({
    how: 'Passiva: sempre attiva.',
    effect: ['Quando compare un Dono vedete subito un cerchio di 100 m che lo contiene; le altre coppie lo vedono 5 minuti dopo.',
      'Potete prendere anche un Dono che trovate prima che venga annunciato.'],
    tips: 'Cinque minuti di vantaggio bastano per arrivare primi.',
    shots: [
      { t: 'map', me: [25, 70], areas: [[68, 35, 20, '#d1ad62']], cap: 'Il cerchio dorato contiene il Dono.' },
      { t: 'card', ico: '✨', eyebrow: 'Presagio del Dono', title: 'Un Dono è appena comparso', bar: 0.7, cap: 'La scheda in home: la barra è il vostro vantaggio.' },
    ],
  }),
  memoria_nodo: () => ({
    how: 'Passiva: sempre attiva.',
    effect: ['La scansione di un Altare vi vale più a lungo del normale: avete più tempo per allontanarvi prima di pronunciare il Sigillo.'],
    tips: 'Inquadrate e sparite: pronunciate il Sigillo quando siete al sicuro.',
    shots: [
      { t: 'card', ico: '⏳', eyebrow: 'Altare dell\'Acqua', title: 'Scansione valida ancora a lungo', bar: 0.9, cap: 'La barra della scansione dura di più.' },
    ],
  }),
  privilegio: () => ({
    how: 'Passiva: sempre attiva.',
    effect: ['Gli armamenti al Cuore valgono per voi 5 minuti prima dell\'apertura (la notifica vi arriva subito) e 5 minuti dopo la chiusura.'],
    tips: 'Arrivate al Cuore quando non c\'è nessuno, e andatevene per ultimi.',
    shots: [
      { t: 'card', ico: '❤️', eyebrow: 'Privilegio del Cuore · i primi', title: 'Gli armamenti sono già aperti per voi', bar: 0.6, cap: 'La scheda in home prima dell\'apertura.' },
    ],
  }),
  veglia_forzata: () => ({
    how: 'Passiva: sempre attiva.',
    effect: ['Chi perde uno scontro contro di voi resta fermo con il cappellino 4 minuti invece di 2.'],
    tips: 'Più tempo per allontanarvi, o per arrivare all\'Altare che stavano difendendo.',
    shots: [
      { t: 'card', ico: '⛓️', eyebrow: 'Veglia', title: 'Cappellino: 4 minuti', bar: 1, tone: 'bad', cap: 'Il timer di chi perde contro di voi.' },
    ],
  }),
  ritirata: () => ({
    how: 'Passiva: sempre attiva.',
    effect: ['Dopo una trattativa d\'alleanza fallita il blocco ingaggio sale a 8 minuti.'],
    tips: 'Rifiutare un\'alleanza vi compra più tempo per sganciarvi.',
    shots: [
      { t: 'card', ico: '🏳️', eyebrow: 'Blocco ingaggio', title: 'Nessuno scontro per 8 minuti', bar: 1, cap: 'Il blocco dopo una trattativa fallita.' },
    ],
  }),
};

export const guideOf = (s) => (SKILL_GUIDE[s.id] ? SKILL_GUIDE[s.id](s) : null);

// ---- le «schermate»

const pct = (v) => `${v}%`;
function shotMap(x) {
  const layer = h('div', { class: 'sh-map' });
  for (const [cx, cy, r, c] of x.areas || []) layer.append(h('i', { class: 'sh-area', style: { left: pct(cx), top: pct(cy), width: pct(r * 2), '--c': c } }));
  for (const [cx, cy, label] of x.altars || []) layer.append(h('i', { class: 'sh-altar', style: { left: pct(cx), top: pct(cy) } }, label));
  for (const [cx, cy, kind, label] of x.dots || []) layer.append(h('i', { class: `sh-dot sh-${kind}`, style: { left: pct(cx), top: pct(cy) } }, label));
  if (x.me && !x.noMe) layer.append(h('i', { class: `sh-me ${x.ghost ? 'ghost' : ''}`, style: { left: pct(x.me[0]), top: pct(x.me[1]) } }));
  return layer;
}
function shotCard(x) {
  return h('div', { class: `sh-card ${x.tone || ''}` }, h('span', { class: 'sh-card-ico' }, x.ico),
    h('span', { class: 'sh-card-body' }, h('span', { class: 'eyebrow' }, x.eyebrow), h('strong', null, x.title),
      x.bar != null ? h('span', { class: 'sh-bar' }, h('i', { style: { width: pct(Math.round(x.bar * 100)) } })) : null));
}
function shotNotify(x) {
  return h('div', { class: 'sh-notify' }, h('div', { class: 'sh-notify-app' }, h('b', null, '0'), ' I Giochi del Buio · ora'), h('strong', null, x.title), h('p', null, x.body));
}
const SEAL_STATE = { blur: ['▒▒▒▒▒▒', 'codice sfocato'], guard: ['🛡️ 18:42', 'custodito'], diplo: ['🤝 ••••••', 'nascosto dal Diplomatico'], immune: ['🧿 ••••••', 'coperto da Immunità'] };
function shotSeal(x) {
  return h('div', { class: 'sh-seals' }, x.items.map(([label, st]) => h('div', { class: `sh-seal ${st}` }, h('span', { class: 'eyebrow' }, label),
    h('strong', { class: 'mono' }, SEAL_STATE[st][0]), h('span', { class: 'tiny' }, SEAL_STATE[st][1]))));
}
function shotPick(x) {
  return h('div', { class: 'sh-pick' }, h('strong', null, x.title), x.items.map((it, i) => h('span', { class: `sh-opt ${i === x.sel ? 'on' : ''}` }, it)));
}

export function skillShot(x) {
  const body = { map: shotMap, card: shotCard, notify: shotNotify, seal: shotSeal, pick: shotPick }[x.t]?.(x);
  return h('figure', { class: 'sh' }, h('div', { class: `sh-phone sh-${x.t}-wrap` }, body), h('figcaption', null, x.cap));
}
