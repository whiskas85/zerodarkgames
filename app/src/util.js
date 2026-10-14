'use strict';
const crypto = require('crypto');

// Alfabeto dei Sigilli: niente 0/O, 1/I/L.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
}

function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [s, h] = stored.split(':');
  const got = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 32);
  const exp = Buffer.from(h, 'hex');
  return got.length === exp.length && crypto.timingSafeEqual(got, exp);
}

// Confronto testi dei frammenti: senza accenti, maiuscolo, punteggiatura ignorata.
function normText(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

function normCode(s) {
  return String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ORDINALS = ['', 'primo', 'secondo', 'terzo', 'quarto', 'quinto', 'sesto', 'settimo', 'ottavo', 'nono', 'decimo', 'undicesimo', 'dodicesimo'];
const ordinal = (n) => ORDINALS[n] || `${n}°`;

module.exports = { CODE_ALPHABET, randomCode, randomToken, shuffle, hashPassword, verifyPassword, normText, normCode, HttpError, ordinal };
