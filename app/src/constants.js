'use strict';

// Colori dei Settori in mappa: ben distinti tra loro e dal blu di "voi" e dall'oro degli Eletti.
const SECTOR_COLORS = ['#e5484d', '#22c3e6', '#a0703c', '#e8e8e8', '#46c46a', '#9b6cf0', '#f97316', '#ff4fa3', '#14b8a6', '#a3e635', '#facc15', '#6366f1'];

const SECTORS = [
  ['I', 'Fuoco', 'del', 'le fornaci', 'Bruciamo per primi'],
  ['II', 'Acqua', "dell'", 'le dighe', 'Passiamo ovunque'],
  ['III', 'Terra', 'della', 'le miniere', 'Restiamo'],
  ['IV', 'Aria', "dell'", 'le torri radio', 'Sentiamo tutto'],
  ['V', 'Ferro', 'del', 'le officine', 'Non ci pieghiamo'],
  ['VI', 'Legno', 'del', 'le segherie', 'Cresciamo dove cadiamo'],
  ['VII', 'Sale', 'del', 'le saline', 'Conserviamo'],
  ['VIII', 'Cenere', 'della', 'le terre bruciate', 'Niente da perdere'],
  ['IX', 'Pietra', 'della', 'le cave', 'Aspettiamo'],
  ['X', 'Ombra', "dell'", 'i confini', 'Non ci vedete'],
  ['XI', 'Ghiaccio', 'del', "i passi d'alta quota", 'Resistiamo al freddo'],
  ['XII', 'Fulmine', 'del', 'le centrali', 'Colpiamo una volta sola'],
].map(([roman, name, article, element, motto], i) => ({ ord: i + 1, roman, name, article, element, motto }));

// Testi predefiniti degli annunci (sezione 7.3). [settore], [codice], [posizione] si compilano in automatico.
const DEFAULT_TEMPLATES = {
  start: 'I Giochi del Buio sono cominciati. Il bosco è in tregua per cinque minuti.',
  hunt_open: 'La tregua è finita. Il Consiglio apre la caccia.',
  revelation: 'Il Consiglio ha deciso. Il Sigillo del Settore [settore] è: [codice]. Ora è di tutti.',
  supply: 'Il Consiglio è generoso. Al Cuore vi aspettano dei doni. Andate a prenderli, se avete il coraggio.',
  last_half_hour: 'Restano trenta minuti. Il Consiglio non tradirà più nessuno. Da adesso ogni Sigillo va strappato con le armi.',
  victory: 'La Parola è stata pronunciata alla Soglia. Il Settore [settore] è libero. I Giochi continuano per il secondo e il terzo posto.',
  podium: 'Il Settore [settore] ha raggiunto la Soglia ed è [posizione].',
  pause: 'PARTITA SOSPESA. Fermatevi e ascoltate il canale radio d\'emergenza.',
  resume: 'La partita riprende.',
  end: 'I Giochi del Buio sono finiti. Abbassate le armi e tornate al Cuore.',
  gift: 'Un dono del Consiglio è comparso nel bosco. Guardate la mappa: chi arriva primo lo prende.',
  gift_taken: 'Un dono del Consiglio è stato preso: è sparito dalla mappa.',
  gift_expired: 'Un dono del Consiglio è svanito: nessuno è arrivato in tempo.',
  supply_end: 'La finestra degli armamenti al Cuore si è chiusa.',
};

const TEMPLATE_LABELS = {
  start: 'Via', hunt_open: 'Apertura caccia', revelation: 'Rivelazione', supply: 'Armamenti: apertura', supply_end: 'Armamenti: chiusura',
  last_half_hour: 'Ultima mezz\'ora', victory: 'Vittoria', podium: 'Podio', pause: 'Sospensione', resume: 'Ripresa', end: 'Fine', gift: 'Dono comparso', gift_taken: 'Dono preso', gift_expired: 'Dono svanito',
};

const DEFAULT_TIMERS = [
  { id: 'veglia', label: 'Veglia', minutes: 2, use: 'Fermo col cappellino dopo una sconfitta', endText: 'Potete togliere il cappellino quando volete.' },
  { id: 'stallo', label: 'Stallo', minutes: 10, use: 'Durata massima di un ingaggio', endText: 'Pareggio.' },
  { id: 'blocco', label: 'Blocco ingaggio', minutes: 5, use: 'Dopo trattativa fallita, alleanza rotta, pareggio o riingaggio', endText: 'Blocco terminato: potete ingaggiare di nuovo.' },
  { id: 'trattativa', label: 'Trattativa', minutes: 2, use: 'Durata massima della trattativa d\'alleanza', endText: 'Tempo di trattativa scaduto.' },
  { id: 'riproposta', label: 'Blocco riproposta', minutes: 15, use: 'Prima di riproporre l\'alleanza alla stessa coppia', endText: 'Potete riproporre l\'alleanza.' },
];

const LAST_PHASE_MIN = 30;
const ACTIVE = ['truce', 'hunt', 'last_half_hour'];
// «Creata»: partita appena creata, solo in regia (le app di campo non la vedono, iscrizioni chiuse).
const PRE_START = ['created', 'draft', 'ready', 'circle'];

const STATUS_LABELS = {
  created: 'Creata', draft: 'In preparazione', ready: 'Pronta', circle: 'Nel cerchio', truce: 'Tregua', hunt: 'Caccia aperta',
  last_half_hour: 'Ultima mezz\'ora', paused: 'SOSPESA', ended: 'Terminata',
};

module.exports = {
  SECTOR_COLORS, SECTORS, DEFAULT_TEMPLATES, TEMPLATE_LABELS, DEFAULT_TIMERS, LAST_PHASE_MIN, ACTIVE, PRE_START, STATUS_LABELS };
