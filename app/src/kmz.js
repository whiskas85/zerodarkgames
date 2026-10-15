'use strict';
// Esportazione dei punti del gioco in KMZ (KML compresso con le sue icone), da aprire in ATAK,
// Google Earth o qualunque app di mappe. Niente dipendenze: zip e PNG scritti a mano con zlib.
const zlib = require('zlib');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Zip minimale (deflate), sufficiente per un KMZ.
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // nomi in UTF-8
    head.writeUInt16LE(8, 8);
    head.writeUInt32LE(0, 10); // ora e data DOS: non servono
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    locals.push(head, name, packed);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(0, 12);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, name);
    offset += head.length + name.length + packed.length;
  }
  const cdir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdir, end]);
}

// Icona PNG 32×32: quadrato (Altare), cerchio (luoghi e Doni), anello (punto indicato).
// Un triangolo giallo in alto a destra segna i piazzamenti provvisori.
function icon(shape, hex, provisional = false) {
  const S = 32;
  const rgb = [1, 3, 5].map((i) => parseInt((hex || '#d1ad62').slice(i, i + 2), 16) || 0);
  const px = Buffer.alloc(S * S * 4);
  const set = (x, y, [r, g, b], a = 255) => { const i = (y * S + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a; };
  const dark = [20, 24, 22];
  const white = [255, 255, 255];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x - 15.5; const dy = y - 15.5; const d = Math.hypot(dx, dy);
      if (shape === 'square') {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        if (m <= 13.5) set(x, y, m >= 9.5 ? rgb : dark);
        else if (m <= 15) set(x, y, white);
      } else if (shape === 'ring') {
        if (d <= 14 && d >= 9) set(x, y, rgb);
        else if (d <= 15.5 && d > 14) set(x, y, dark);
        else if (d <= 3) set(x, y, rgb);
      } else if (d <= 13) set(x, y, rgb);
      else if (d <= 15.5) set(x, y, white);
    }
  }
  if (provisional) {
    // Triangolo 14×12 con il vertice in alto, nell'angolo in alto a destra.
    for (let y = 0; y < 13; y++) {
      const half = (y / 12) * 8;
      for (let x = 0; x < S; x++) if (Math.abs(x - 24) <= half) set(x, y, y >= 3 && y <= 8 && x === 24 ? [17, 17, 17] : y === 10 && x === 24 ? [17, 17, 17] : [255, 204, 0]);
    }
  }
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/**
 * folders: [{ name, items: [{ name, lat, lng, shape, color, provisional, description }] }]
 * Restituisce il KMZ (Buffer). Le cartelle vuote non compaiono.
 */
function buildKmz(title, folders) {
  const icons = new Map();
  const styleOf = (it) => {
    const id = `${it.shape}-${String(it.color || '#d1ad62').replace('#', '')}${it.provisional ? '-p' : ''}`;
    if (!icons.has(id)) icons.set(id, icon(it.shape, it.color, it.provisional));
    return id;
  };
  const body = folders.filter((f) => f.items.some((i) => i.lat != null)).map((f) => `  <Folder><name>${esc(f.name)}</name>
${f.items.filter((i) => i.lat != null).map((i) => `    <Placemark><name>${esc(i.name)}</name><styleUrl>#${styleOf(i)}</styleUrl>${i.description ? `<description><![CDATA[${String(i.description).replace(/]]>/g, ']]&gt;')}]]></description>` : ''}<Point><coordinates>${Number(i.lng).toFixed(7)},${Number(i.lat).toFixed(7)},0</coordinates></Point></Placemark>`).join('\n')}
  </Folder>`).join('\n');
  const styles = [...icons.keys()].map((id) => `  <Style id="${id}"><IconStyle><scale>1</scale><Icon><href>files/${id}.png</href></Icon><hotSpot x="0.5" y="0.5" xunits="fraction" yunits="fraction"/></IconStyle><LabelStyle><scale>0.9</scale></LabelStyle></Style>`).join('\n');
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document><name>${esc(title)}</name>
${styles}
${body}
</Document>
</kml>
`;
  return zip([{ name: 'doc.kml', data: kml }, ...[...icons].map(([id, png]) => ({ name: `files/${id}.png`, data: png }))]);
}

module.exports = { buildKmz, zip, crc32, icon };
