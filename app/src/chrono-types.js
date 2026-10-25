// Tipi di cronografo: l'Acetech AC6000 è integrato nell'app; gli altri marchi si aggiungono dalla regia
// descrivendo il canale Bluetooth (servizio e caratteristica che mandano i tiri) e come leggere la velocità.
const { q } = require('./db');
const { HttpError } = require('./util');

const err = (status, msg) => new HttpError(status, msg);
const FORMATS = { ascii: 'Testo (primo numero del messaggio)', u16le: 'Intero 16 bit (little endian)', u16be: 'Intero 16 bit (big endian)', u32le: 'Intero 32 bit (little endian)', f32le: 'Decimale 32 bit (little endian)' };
const UNITS = { mps: 'm/s', fps: 'fps (piedi al secondo)' };
const BUILTIN = [{ id: 'ac6000', name: 'Acetech AC6000', builtin: true }];

// UUID: codice corto (fff0, 0xfff0) o completo.
function readUuid(v, label) {
  const s = String(v || '').trim().toLowerCase().replace(/^0x/, '');
  if (/^[0-9a-f]{4}$/.test(s)) return s;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) return s;
  throw err(400, `${label}: scrivi il codice corto (es. fff0) o l'UUID completo`);
}
function readType(data) {
  const name = String(data.name || '').trim().slice(0, 60);
  if (!name) throw err(400, 'Dai un nome al cronografo (es. marca e modello)');
  const format = FORMATS[data.format] ? data.format : 'ascii';
  const divisor = Number(String(data.divisor ?? 1).replace(',', '.'));
  if (!(divisor > 0)) throw err(400, 'Il divisore deve essere maggiore di zero (1 se il numero è già la velocità)');
  return {
    name, namePrefix: String(data.namePrefix || '').trim().slice(0, 40) || null,
    serviceUuid: readUuid(data.serviceUuid, 'Servizio'), charUuid: readUuid(data.charUuid, 'Caratteristica'),
    format, byteOffset: Math.max(0, Math.min(64, Math.round(Number(data.byteOffset) || 0))), divisor, unit: UNITS[data.unit] ? data.unit : 'mps',
  };
}

function listTypes() {
  return { builtin: BUILTIN, custom: q.all('SELECT * FROM chrono_types ORDER BY name'), formats: FORMATS, units: UNITS };
}
function createType(data, actor) {
  const t = readType(data || {});
  const id = Number(q.run('INSERT INTO chrono_types (name, namePrefix, serviceUuid, charUuid, format, byteOffset, divisor, unit, createdAt, author) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    t.name, t.namePrefix, t.serviceUuid, t.charUuid, t.format, t.byteOffset, t.divisor, t.unit, Date.now(), actor || null).lastInsertRowid);
  return q.get('SELECT * FROM chrono_types WHERE id = ?', id);
}
function updateType(id, data) {
  const old = q.get('SELECT * FROM chrono_types WHERE id = ?', Number(id));
  if (!old) throw err(404, 'Cronografo non trovato');
  const t = readType({ ...old, ...data });
  q.run('UPDATE chrono_types SET name = ?, namePrefix = ?, serviceUuid = ?, charUuid = ?, format = ?, byteOffset = ?, divisor = ?, unit = ? WHERE id = ?',
    t.name, t.namePrefix, t.serviceUuid, t.charUuid, t.format, t.byteOffset, t.divisor, t.unit, old.id);
  return q.get('SELECT * FROM chrono_types WHERE id = ?', old.id);
}
function deleteType(id) {
  if (!q.run('DELETE FROM chrono_types WHERE id = ?', Number(id)).changes) throw err(404, 'Cronografo non trovato');
}

module.exports = { listTypes, createType, updateType, deleteType, readType };
