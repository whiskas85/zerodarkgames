'use strict';
// Suoni del VIA caricati dalla regia (validi per tutte le regie): bip dei secondi, uno per ciascun numero
// (facoltativo, es. una voce che conta) e il VIA. Dove manca un file la regia usa il suono sintetizzato.
const fs = require('fs');
const path = require('path');
const { getSetting, setSetting, DATA_DIR } = require('./db');
const { HttpError } = require('./util');

const SLOTS = ['tick', '5', '4', '3', '2', '1', 'go'];
const TYPES = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac' };
const MAX_BYTES = 3 * 1024 * 1024;
const DIR = path.join(DATA_DIR, 'sounds');

const index = () => { try { return JSON.parse(getSetting('goSounds') || '{}'); } catch { return {}; } };
const fileOf = (slot) => path.join(DIR, `go-${slot}`);

function list() {
  const ix = index();
  return Object.fromEntries(SLOTS.filter((s) => ix[s] && fs.existsSync(fileOf(s))).map((s) => [s, { name: ix[s].name, type: ix[s].type, at: ix[s].at, size: ix[s].size }]));
}
function save(slot, buf, type, name) {
  if (!SLOTS.includes(slot)) throw new HttpError(400, 'Suono non valido');
  const mime = String(type || '').split(';')[0].trim().toLowerCase();
  if (!TYPES[mime]) throw new HttpError(400, 'Formato non valido: usa MP3, WAV, OGG o M4A');
  if (!buf?.length) throw new HttpError(400, 'File vuoto');
  if (buf.length > MAX_BYTES) throw new HttpError(400, 'File troppo grande (massimo 3 MB)');
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(fileOf(slot), buf);
  const ix = index();
  ix[slot] = { name: String(name || '').slice(0, 80) || `${slot}.${TYPES[mime]}`, type: mime, at: Date.now(), size: buf.length };
  setSetting('goSounds', JSON.stringify(ix));
  return list();
}
function remove(slot) {
  if (!SLOTS.includes(slot)) throw new HttpError(400, 'Suono non valido');
  const ix = index();
  delete ix[slot];
  setSetting('goSounds', JSON.stringify(ix));
  try { fs.unlinkSync(fileOf(slot)); } catch { /* già tolto */ }
  return list();
}
function file(slot) {
  const ix = index();
  if (!SLOTS.includes(slot) || !ix[slot] || !fs.existsSync(fileOf(slot))) throw new HttpError(404, 'Suono non trovato');
  return { path: fileOf(slot), type: ix[slot].type };
}

module.exports = { SLOTS, list, save, remove, file };
