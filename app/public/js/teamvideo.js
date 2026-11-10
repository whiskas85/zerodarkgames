// Video di presentazione delle coppie, in tema Giochi del Buio: per ogni coppia il Settore (con il suo elemento),
// il numero romano, il motto, il logo e sotto i nick dei due membri. Si disegna su un canvas 1920×1080 e si può
// registrare in un file video direttamente dal browser (MediaRecorder), con una colonna sonora sintetizzata.
import { h, toast } from './lib.js';

// Formati: orizzontale (proiettore, YouTube) e verticali/quadrati per Instagram.
export const FORMATS = {
  landscape: { w: 1920, h: 1080, label: 'Orizzontale 16:9', hint: 'proiettore, YouTube' },
  reel: { w: 1080, h: 1920, label: 'Instagram Reel / Storia 9:16', hint: 'verticale a tutto schermo' },
  post: { w: 1080, h: 1350, label: 'Instagram post 4:5', hint: 'nel feed' },
  square: { w: 1080, h: 1080, label: 'Quadrato 1:1', hint: 'feed e WhatsApp' },
};
let W = 1920;
let H = 1080;
let U = 1; // scala dei testi e degli elementi
let NARROW = false; // verticale o quadrato: impaginazione impilata
function setFormat(key) {
  const f = FORMATS[key] || FORMATS.landscape;
  W = f.w; H = f.h;
  NARROW = W < H * 1.3;
  U = NARROW ? Math.min(W / 1000, H / 1300) : W / 1920;
  return f;
}
// Imposta il carattere e lo rimpicciolisce finché il testo (con la spaziatura) sta in maxW.
// Rimpicciolisce in proporzione anche la spaziatura tra le lettere (la usa spaced() per lo stesso testo).
let lastFit = { text: null, scale: 1 };
function fitFont(ctx, weight, size, family, text, maxW, spacing = 0) {
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.font = `${weight} ${size}px ${family}`;
  const w = ctx.measureText(text).width + spacing * Math.max(0, [...text].length - 1);
  const scale = w > maxW ? maxW / w : 1;
  if (scale < 1) { size = Math.floor(size * scale); ctx.font = `${weight} ${size}px ${family}`; }
  lastFit = { text, scale };
  return size;
}
const FD = '"Big Shoulders Stencil Display", Impact, "Arial Narrow", sans-serif';
const FM = '"IBM Plex Mono", ui-monospace, Consolas, monospace';
const INTRO = 5;
const OUTRO = 4.5;

// Particelle per elemento: direzione, velocità, dimensione, colore, forma.
const ELEMENTS = {
  Fuoco: { kind: 'ember', vy: [-170, -60], vx: [-25, 25], size: [2, 6], color: ['#ff9a3c', '#ff5a1f', '#ffd27a'], n: 90, glow: true },
  Acqua: { kind: 'drop', vy: [380, 620], vx: [-10, 10], size: [1.5, 3], color: ['#6fc3ff', '#a8dcff'], n: 110 },
  Terra: { kind: 'dust', vy: [-12, 12], vx: [8, 40], size: [2, 7], color: ['#a07a4a', '#7c5a33', '#c49a62'], n: 70 },
  Aria: { kind: 'streak', vy: [-15, 15], vx: [500, 900], size: [1, 2.5], color: ['#d8f1ff', '#9fd0e8'], n: 45 },
  Ferro: { kind: 'ember', vy: [-60, 160], vx: [-260, 260], size: [1.5, 3.5], color: ['#ffe2a1', '#ffb347', '#ffffff'], n: 70, glow: true },
  Legno: { kind: 'leaf', vy: [40, 110], vx: [-60, 60], size: [5, 10], color: ['#5f8f3e', '#8bb45a', '#a3772f'], n: 45 },
  Sale: { kind: 'crystal', vy: [20, 60], vx: [-15, 15], size: [2, 5], color: ['#ffffff', '#dfe8ea'], n: 70, glow: true },
  Cenere: { kind: 'dust', vy: [25, 70], vx: [-20, 20], size: [2, 5], color: ['#8d8d8d', '#5c5c5c', '#b5b5b5'], n: 90 },
  Pietra: { kind: 'dust', vy: [90, 220], vx: [-10, 10], size: [3, 8], color: ['#8a8578', '#6b675e'], n: 35 },
  Ombra: { kind: 'smoke', vy: [-25, -5], vx: [-20, 20], size: [60, 140], color: ['#12081f', '#1d0f2e', '#0a0a0a'], n: 28 },
  Ghiaccio: { kind: 'crystal', vy: [40, 110], vx: [-30, 30], size: [2, 5], color: ['#e8f7ff', '#bfe6ff'], n: 100, glow: true },
  Fulmine: { kind: 'ember', vy: [-40, 40], vx: [-40, 40], size: [1, 3], color: ['#d9e7ff', '#9ec2ff'], n: 50, glow: true, lightning: true },
};
const DEFAULT_EL = { kind: 'dust', vy: [-20, 20], vx: [-20, 20], size: [2, 5], color: ['#d1ad62'], n: 60 };

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const ease = (x) => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2; };
const easeOut = (x) => 1 - (1 - clamp(x)) ** 3;
// Andamento di una comparsa: da 0 a 1 tra a e b, poi resta a 1.
const span = (t, a, b) => clamp((t - a) / (b - a));

function hexToRgb(hex) {
  const m = String(hex || '').replace('#', '').match(/^([0-9a-f]{6})$/i);
  if (!m) return [209, 173, 98];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (rgb, a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;

function makeParticles(el) {
  const spec = ELEMENTS[el] || DEFAULT_EL;
  return Array.from({ length: spec.n }, () => spawn(spec, true));
}
function spawn(spec, anywhere) {
  const p = { x: rnd(0, W), y: anywhere ? rnd(0, H) : 0, vx: rnd(...spec.vx), vy: rnd(...spec.vy), s: rnd(...spec.size), c: pick(spec.color), life: rnd(0.6, 1), ph: rnd(0, 6.28), rot: rnd(0, 6.28) };
  if (!anywhere) {
    if (spec.vy[1] < 0) p.y = H + 20; else if (spec.vy[0] > 0) p.y = -20; else p.y = rnd(0, H);
    if (spec.vx[0] > 200) p.x = -40;
  }
  return p;
}
function stepParticles(ps, el, dt) {
  const spec = ELEMENTS[el] || DEFAULT_EL;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    p.x += (p.vx + Math.sin(p.ph) * 12) * dt;
    p.y += p.vy * dt;
    p.ph += dt * 2;
    p.rot += dt;
    if (p.y < -60 || p.y > H + 60 || p.x < -80 || p.x > W + 80) ps[i] = spawn(spec, false);
  }
}
function drawParticles(ctx, ps, el, alpha) {
  const spec = ELEMENTS[el] || DEFAULT_EL;
  ctx.save();
  for (const p of ps) {
    const a = alpha * p.life * (spec.kind === 'ember' ? 0.55 + 0.45 * Math.sin(p.ph * 3) : 1);
    if (a <= 0.01) continue;
    ctx.globalAlpha = a;
    ctx.fillStyle = p.c;
    ctx.strokeStyle = p.c;
    if (spec.glow) { ctx.shadowColor = p.c; ctx.shadowBlur = 14; } else ctx.shadowBlur = 0;
    switch (spec.kind) {
      case 'drop': ctx.lineWidth = p.s; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.035); ctx.stroke(); break;
      case 'streak': ctx.lineWidth = p.s; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.12, p.y - p.vy * 0.12); ctx.stroke(); break;
      case 'leaf': ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.beginPath(); ctx.ellipse(0, 0, p.s, p.s / 2.4, 0, 0, 6.29); ctx.fill(); ctx.restore(); break;
      case 'crystal': ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s); ctx.restore(); break;
      case 'smoke': {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.s);
        g.addColorStop(0, p.c); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = a * 0.5; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.s, 0, 6.29); ctx.fill(); break;
      }
      default: ctx.beginPath(); ctx.arc(p.x, p.y, p.s, 0, 6.29); ctx.fill();
    }
  }
  ctx.restore();
}

// Fulmine: una saetta frastagliata dall'alto.
function drawBolt(ctx, seed, alpha) {
  let x = W * (0.2 + 0.6 * seed);
  let y = 0;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = '#e6efff';
  ctx.shadowColor = '#9ec2ff';
  ctx.shadowBlur = 30;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x, y);
  let k = seed * 997;
  while (y < H * 0.75) { k = (k * 9301 + 49297) % 233280; x += ((k / 233280) - 0.5) * 120; y += 50 + (k % 40); ctx.lineTo(x, y); }
  ctx.stroke();
  ctx.restore();
}

// Sfondo: buio con alone del colore del Settore, vignetta e grana.
function drawBackdrop(ctx, rgb, glow, t) {
  ctx.fillStyle = '#050506';
  ctx.fillRect(0, 0, W, H);
  if (glow > 0) {
    const g = ctx.createRadialGradient(W / 2, H * 0.46, 40, W / 2, H * 0.46, H * 0.9);
    g.addColorStop(0, rgba(rgb, 0.38 * glow));
    g.addColorStop(0.45, rgba(rgb, 0.1 * glow));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  // Nebbia che scorre in basso.
  ctx.save();
  ctx.globalAlpha = 0.08 + 0.04 * Math.sin(t * 0.7);
  const fog = ctx.createLinearGradient(0, H * 0.65, 0, H);
  fog.addColorStop(0, 'rgba(0,0,0,0)');
  fog.addColorStop(1, rgba(rgb, 0.9));
  ctx.fillStyle = fog;
  ctx.fillRect(0, H * 0.6, W, H * 0.4);
  ctx.restore();
}
function drawVignette(ctx) {
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.85)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}
function drawGrain(ctx, grain) {
  ctx.save();
  ctx.globalAlpha = 0.07;
  ctx.drawImage(grain, Math.random() * -200, Math.random() * -200, W + 200, H + 200);
  ctx.restore();
}
function makeGrain() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const x = c.getContext('2d');
  const d = x.createImageData(512, 512);
  for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
  x.putImageData(d, 0, 0);
  return c;
}

// Testo con spaziatura tra le lettere (canvas non la supporta ovunque).
function spaced(ctx, text, x, y, spacing) {
  if (lastFit.text === text) spacing *= lastFit.scale;
  if ('letterSpacing' in ctx) { ctx.letterSpacing = `${spacing}px`; ctx.fillText(text, x, y); ctx.letterSpacing = '0px'; return; }
  const chars = [...text];
  const total = chars.reduce((t, ch) => t + ctx.measureText(ch).width + spacing, -spacing);
  const align = ctx.textAlign;
  let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  ctx.textAlign = 'left';
  for (const ch of chars) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + spacing; }
  ctx.textAlign = align;
}
// Sfarfallio da insegna che si accende.
const flicker = (t, start) => { const k = t - start; if (k < 0) return 0; if (k > 0.9) return 1; return Math.sin(k * 60) > -0.2 ? clamp(k * 1.4) : 0.15; };

function drawIntro(ctx, t, game, count) {
  const rgb = [209, 173, 98];
  drawBackdrop(ctx, [120, 20, 20], 0.6 * span(t, 0, 2), t);
  const a = flicker(t, 0.6);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = rgba([232, 220, 196], 0.85 * span(t, 0.2, 1.2));
  fitFont(ctx, 600, 30 * U, FM, 'IL CONSIGLIO ZERO PRESENTA', W * 0.9, 14 * U);
  const big = (190 + 10 * easeOut(span(t, 0.6, 4))) * U * (NARROW ? 1.15 : 1);
  // Verticale: il titolo va su due righe.
  const lines = NARROW ? ['I GIOCHI', 'DEL BUIO'] : ['I GIOCHI DEL BUIO'];
  const yMid = H * (NARROW ? 0.46 : 0.47);
  const yTitle0 = yMid - (lines.length - 1) * big * 0.5;
  const yTop = yTitle0 - big * 0.5;
  const yBottom = yTitle0 + (lines.length - 1) * big + big * 0.5;
  spaced(ctx, 'IL CONSIGLIO ZERO PRESENTA', W / 2, NARROW ? yTop - 60 * U : H * 0.3, 14 * U);
  ctx.shadowColor = rgba([226, 72, 50], 0.9);
  ctx.shadowBlur = 50 * a * U;
  ctx.fillStyle = rgba([240, 230, 210], a);
  lines.forEach((l, i) => { fitFont(ctx, 900, big, FD, l, W * 0.92, 6 * U); spaced(ctx, l, W / 2, yTitle0 + i * big, 6 * U); });
  ctx.shadowBlur = 0;
  ctx.fillStyle = rgba(rgb, span(t, 2, 3));
  const sub = `LE ${count} COPPIE · ${String(game || '').toUpperCase()}`.slice(0, 70);
  fitFont(ctx, 600, 34 * U, FM, sub, W * 0.9, 10 * U);
  spaced(ctx, sub, W / 2, NARROW ? yBottom + 90 * U : H * 0.62, 10 * U);
  // Linea che si allarga.
  const lw = Math.min(700 * U, W * 0.7) * easeOut(span(t, 1.2, 2.6));
  ctx.fillStyle = rgba(rgb, 0.8);
  ctx.fillRect(W / 2 - lw / 2, NARROW ? yBottom + 40 * U : H * 0.555, lw, Math.max(2, 3 * U));
  ctx.restore();
}

function drawOutro(ctx, t) {
  drawBackdrop(ctx, [120, 20, 20], 0.5, t);
  const a = span(t, 0.2, 1.4) * (1 - span(t, OUTRO - 1, OUTRO));
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = a;
  ctx.fillStyle = '#efe6d2';
  ctx.shadowColor = 'rgba(226,72,50,.8)';
  ctx.shadowBlur = 40 * U;
  const size = 120 * U * (NARROW ? 1.3 : 1);
  const lines = NARROW ? ['CHE IL BUIO', 'VI ACCOLGA'] : ['CHE IL BUIO VI ACCOLGA'];
  const y0 = H * 0.45 - (lines.length - 1) * size * 0.5;
  lines.forEach((l, i) => { fitFont(ctx, 900, size, FD, l, W * 0.92, 4 * U); spaced(ctx, l, W / 2, y0 + i * size, 4 * U); });
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#d1ad62';
  const sub = 'SOLO UNA COPPIA VARCHERÀ LA SOGLIA';
  fitFont(ctx, 600, 32 * U, FM, sub, W * 0.9, 12 * U);
  spaced(ctx, sub, W / 2, y0 + (lines.length - 1) * size + size * 0.5 + 70 * U, 12 * U);
  ctx.restore();
}

// Una coppia: dur secondi. Prima il Settore e il numero romano, poi il logo, poi i nick.
function drawTeam(ctx, t, dur, tm, st) {
  const rgb = hexToRgb(tm.color);
  const fadeIn = span(t, 0, 0.7);
  const fadeOut = 1 - span(t, dur - 0.7, dur);
  const vis = fadeIn * fadeOut;
  drawBackdrop(ctx, rgb, vis * (0.6 + 0.4 * easeOut(span(t, 2.0, 2.6))), t);
  stepParticles(st.particles, tm.element, st.dt);
  drawParticles(ctx, st.particles, tm.element, vis);
  if (ELEMENTS[tm.element]?.lightning) {
    const flash = [1.9, 2.05, dur * 0.72].find((x) => t > x && t < x + 0.12);
    if (flash) { ctx.fillStyle = `rgba(200,220,255,${0.25 * vis})`; ctx.fillRect(0, 0, W, H); drawBolt(ctx, (flash * 7) % 1, vis); }
  }
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Impaginazione: orizzontale come sempre; verticale/quadrato tutto impilato e centrato in altezza.
  let yLabel = 110; let yTitle = 205; let yMotto = 290; let cy = H * 0.56; let R = 200;
  if (NARROW) {
    R = Math.min(240 * U, (H - 465 * U - H * 0.12) / 2);
    const total = 465 * U + 2 * R;
    yLabel = (H - total) / 2 + 15 * U;
    yTitle = yLabel + 115 * U;
    yMotto = yTitle + 85 * U;
    cy = yMotto + 70 * U + R;
  }
  // Numero romano gigante, dietro a tutto.
  const rn = easeOut(span(t, 0.2, 1.6));
  ctx.globalAlpha = 0.14 * vis * rn;
  ctx.fillStyle = rgba(rgb, 1);
  ctx.font = `900 ${(700 + 80 * (1 - rn)) * Math.min(W, H) / 1080}px ${FD}`;
  ctx.fillText(tm.roman, W / 2, NARROW ? cy : H * 0.47);
  // In alto: Settore, numero romano ed elemento.
  ctx.globalAlpha = vis * span(t, 0.4, 1.2);
  ctx.fillStyle = rgba(rgb, 1);
  ctx.font = `600 ${30 * U}px ${FM}`;
  spaced(ctx, `${tm.roman} · SETTORE`, W / 2, yLabel, 16 * U);
  ctx.globalAlpha = vis * easeOut(span(t, 0.6, 1.5));
  ctx.fillStyle = '#f2ead8';
  ctx.shadowColor = rgba(rgb, 0.9);
  ctx.shadowBlur = 40 * U;
  fitFont(ctx, 900, (150 - 10 * easeOut(span(t, 0.6, 1.5))) * U, FD, tm.sectorName.toUpperCase(), W * 0.9, 10 * U);
  spaced(ctx, tm.sectorName.toUpperCase(), W / 2, yTitle, 10 * U);
  ctx.shadowBlur = 0;
  if (tm.motto) {
    ctx.globalAlpha = vis * span(t, 1.2, 2);
    ctx.fillStyle = 'rgba(242,234,216,.7)';
    fitFont(ctx, 'italic 400', 30 * U, 'Georgia, "Times New Roman", serif', `«${tm.motto}»`, W * 0.9);
    ctx.fillText(`«${tm.motto}»`, W / 2, yMotto);
  }
  // Logo: cerchio che si apre con un lampo.
  const cx = W / 2;
  const open = easeOut(span(t, 2.0, 2.7));
  if (open > 0) {
    ctx.globalAlpha = vis;
    // Anello del colore del Settore.
    ctx.strokeStyle = rgba(rgb, 0.9);
    ctx.lineWidth = Math.max(3, 6 * R / 200);
    ctx.shadowColor = rgba(rgb, 1);
    ctx.shadowBlur = 40 * U;
    ctx.beginPath();
    ctx.arc(cx, cy, R + 14 * R / 200, -Math.PI / 2, -Math.PI / 2 + 6.2832 * open);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R * open, 0, 6.2832);
    ctx.clip();
    ctx.fillStyle = '#0b0b0d';
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    if (tm.img) {
      const s = Math.max((R * 2) / tm.img.width, (R * 2) / tm.img.height) * (1.08 - 0.08 * open);
      const iw = tm.img.width * s;
      const ih = tm.img.height * s;
      ctx.drawImage(tm.img, cx - iw / 2, cy - ih / 2, iw, ih);
    } else {
      ctx.fillStyle = rgba(rgb, 1);
      ctx.font = `900 ${220 * R / 200}px ${FD}`;
      ctx.fillText(tm.roman, cx, cy + 10 * R / 200);
    }
    ctx.restore();
    // Lampo all'apertura.
    const fl = 1 - span(t, 2.0, 2.5);
    if (fl > 0 && t > 2.0) {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 2.4);
      g.addColorStop(0, `rgba(255,245,225,${0.7 * fl})`);
      g.addColorStop(1, 'rgba(255,245,225,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
  }
  // Nome della coppia (se ce l'ha) e nick dei due membri, sotto il logo.
  const nk = easeOut(span(t, 2.9, 3.7));
  const y0 = cy + R + 80 * U;
  if (tm.displayName) {
    ctx.globalAlpha = vis * nk;
    ctx.fillStyle = rgba(rgb, 1);
    const dn = tm.displayName.toUpperCase().slice(0, 48);
    fitFont(ctx, 600, 30 * U, FM, dn, W * 0.9, 12 * U);
    spaced(ctx, dn, cx, y0 - 10 * U + 20 * U * (1 - nk), 12 * U);
  }
  const nicks = tm.nicks.filter(Boolean);
  if (nicks.length) {
    const n2 = easeOut(span(t, 3.2, 4.1));
    ctx.globalAlpha = vis * n2;
    ctx.fillStyle = '#f2ead8';
    ctx.shadowColor = 'rgba(0,0,0,.9)';
    ctx.shadowBlur = 20 * U;
    const yN = y0 + (tm.displayName ? 75 : 40) * U + 30 * U * (1 - n2);
    if (nicks.length === 2) {
      const gap = 70 * U;
      const [a1, a2] = nicks.map((n) => n.toUpperCase());
      // Stessa grandezza per i due nick, che ciascuno stia nella sua metà.
      const longest = a1.length >= a2.length ? a1 : a2;
      const size = fitFont(ctx, 900, 92 * U, FD, longest, W / 2 - gap - W * 0.05, 4 * U);
      ctx.font = `900 ${size}px ${FD}`;
      ctx.textAlign = 'right';
      spaced(ctx, a1, cx - gap, yN, 4 * U);
      ctx.textAlign = 'left';
      spaced(ctx, a2, cx + gap, yN, 4 * U);
      ctx.textAlign = 'center';
      ctx.shadowBlur = 0;
      ctx.fillStyle = rgba(rgb, 1);
      ctx.font = `900 ${Math.min(60 * U, size * 0.7)}px ${FD}`;
      ctx.fillText('✦', cx, yN);
    } else {
      const txt = nicks.join('  ✦  ').toUpperCase();
      fitFont(ctx, 900, 92 * U, FD, txt, W * 0.9, 4 * U);
      spaced(ctx, txt, cx, yN, 4 * U);
    }
  }
  ctx.restore();
}

// Colonna sonora horror, tutta sintetizzata:
// - sotto, un bordone grave e scuro che respira lentamente e un filo di vento;
// - per ogni coppia: un risucchio grave che sale, poi un TONFO cupo all'apertura del logo,
//   e sui nick un respiro e un tonfo sordo per nome, con il battito di cuore.
function makeAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  const ac = new AC();
  const now = () => ac.currentTime;
  const out = ac.createGain();
  out.gain.value = 0.85;
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 4;
  out.connect(comp);
  const dest = ac.createMediaStreamDestination();
  comp.connect(ac.destination);
  comp.connect(dest);
  // Riverbero lungo (risposta all'impulso generata: rumore che si spegne in ~4 s).
  const verb = ac.createConvolver();
  const len = ac.sampleRate * 4.5;
  const ir = ac.createBuffer(2, len, ac.sampleRate);
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2.6; }
  verb.buffer = ir;
  const wet = ac.createGain(); wet.gain.value = 0.3;
  verb.connect(wet); wet.connect(out);
  const send = (node, dry = 0.6, w = 0.8) => { const d = ac.createGain(); d.gain.value = dry; node.connect(d); d.connect(out); const s = ac.createGain(); s.gain.value = w; node.connect(s); s.connect(verb); };
  const noiseBuf = ac.createBuffer(1, ac.sampleRate * 3, ac.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const noise = () => { const n = ac.createBufferSource(); n.buffer = noiseBuf; n.loop = true; return n; };
  const lfo = (freq, amount, target) => { const o = ac.createOscillator(); o.frequency.value = freq; const g = ac.createGain(); g.gain.value = amount; o.connect(g); g.connect(target); o.start(); return o; };
  const live = [];

  // Bordone: Mi grave + Fa (seconda minore) + Si bemolle (tritono), filtro che respira.
  const drone = ac.createGain(); drone.gain.value = 0;
  const dlp = ac.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 170; dlp.Q.value = 6;
  drone.connect(dlp); send(dlp, 0.8, 0.5);
  for (const [f, type, g] of [[41.2, 'sawtooth', 0.5], [43.65, 'sawtooth', 0.35], [58.27, 'triangle', 0.4], [20.6, 'sine', 0.8]]) {
    const o = ac.createOscillator(); o.type = type; o.frequency.value = f; const og = ac.createGain(); og.gain.value = g; o.connect(og); og.connect(drone); o.start(); live.push(o);
  }
  live.push(lfo(0.07, 90, dlp.frequency));
  // Tremolo lento e irregolare sul bordone.
  const trem = ac.createGain(); trem.gain.value = 1; dlp.disconnect(); dlp.connect(trem); send(trem, 0.8, 0.5);
  live.push(lfo(0.23, 0.25, trem.gain));

  // Vento che sussurra.
  const wind = noise(); const wf = ac.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 500; wf.Q.value = 3;
  const wg = ac.createGain(); wg.gain.value = 0;
  wind.connect(wf); wf.connect(wg); send(wg, 0.4, 0.8); wind.start(); live.push(wind);
  live.push(lfo(0.11, 350, wf.frequency));
  live.push(lfo(0.17, 0.02, wg.gain));

  const env = (g, t, a, peak, d) => { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); };
  const shaper = (() => { const w = ac.createWaveShaper(); const c = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; c[i] = Math.tanh(x * 6); } w.curve = c; return w; })();
  shaper.connect(out);

  return {
    ac, dest,
    start() {
      const t = now();
      drone.gain.setTargetAtTime(0.22, t, 2);
      wg.gain.setTargetAtTime(0.025, t, 3);
    },
    stop() {
      const t = now();
      for (const g of [drone, wg]) g.gain.setTargetAtTime(0, t, 0.8);
      setTimeout(() => { live.forEach((o) => { try { o.stop(); } catch { /* */ } }); ac.close(); }, 4000);
    },
    // Risucchio al contrario che sale verso il colpo (dur secondi).
    riser(dur = 1.4) {
      const t = now();
      const n = noise(); const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 2;
      f.frequency.setValueAtTime(120, t); f.frequency.exponentialRampToValueAtTime(1400, t + dur);
      const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.28, t + dur); g.gain.linearRampToValueAtTime(0, t + dur + 0.02);
      n.connect(f); f.connect(g); send(g, 0.7, 0.3); n.start(t); n.stop(t + dur + 0.05);
    },
    // Il TONFO: un colpo cupo e profondo, come una porta di pietra che si chiude (niente metalli né archi).
    boom(power = 1) {
      const t = now();
      const o = ac.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(62, t); o.frequency.exponentialRampToValueAtTime(26, t + 1.1);
      const g = ac.createGain(); env(g, t, 0.006, 1.0 * power, 1.7); o.connect(g); g.connect(shaper); send(g, 0.5, 0.25); o.start(t); o.stop(t + 1.9);
      const o2 = ac.createOscillator(); o2.type = 'triangle'; o2.frequency.setValueAtTime(110, t); o2.frequency.exponentialRampToValueAtTime(40, t + 0.25);
      const g2 = ac.createGain(); env(g2, t, 0.002, 0.45 * power, 0.35); o2.connect(g2); send(g2, 0.8, 0.2); o2.start(t); o2.stop(t + 0.5);
      const n = noise(); const nf = ac.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.setValueAtTime(380, t); nf.frequency.exponentialRampToValueAtTime(70, t + 0.5);
      const ng = ac.createGain(); env(ng, t, 0.002, 0.7 * power, 0.55); n.connect(nf); nf.connect(ng); send(ng, 0.8, 0.3); n.start(t); n.stop(t + 0.7);
    },
    // I nomi: un respiro grave che sale e un tonfo sordo per ogni nick.
    names(count = 2) {
      const t = now();
      const n = noise(); const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 4;
      f.frequency.setValueAtTime(150, t); f.frequency.exponentialRampToValueAtTime(700, t + 0.5);
      const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.45); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      n.connect(f); f.connect(g); send(g, 0.7, 0.3); n.start(t); n.stop(t + 1);
      for (let k = 0; k < Math.max(1, count); k++) {
        const tk = t + 0.15 + k * 0.3;
        const o = ac.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(k ? 58 : 66, tk); o.frequency.exponentialRampToValueAtTime(30, tk + 0.35);
        const og = ac.createGain(); env(og, tk, 0.004, 0.8, 0.45); o.connect(og); send(og, 0.9, 0.2); o.start(tk); o.stop(tk + 0.55);
      }
    },
    // Battito di cuore (due colpi sordi).
    heartbeat() {
      const t = now();
      for (const [dt, a] of [[0, 0.95], [0.22, 0.65]]) {
        const o = ac.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(70, t + dt); o.frequency.exponentialRampToValueAtTime(35, t + dt + 0.18);
        const g = ac.createGain(); env(g, t + dt, 0.005, a, 0.25); o.connect(g); send(g, 0.9, 0.2); o.start(t + dt); o.stop(t + dt + 0.35);
      }
    },
  };
}

function loadImg(src) {
  return new Promise((resolve) => { if (!src) return resolve(null); const i = new Image(); i.onload = () => resolve(i); i.onerror = () => resolve(null); i.src = src; });
}

// Le coppie della partita, in ordine di Settore, con logo e nick.
export async function teamsForVideo(ms) {
  const sec = new Map((ms.sectors || []).map((s) => [s.id, s]));
  const list = (ms.teams || []).filter((t) => t.sectorId).map((t) => {
    const s = sec.get(t.sectorId) || {};
    return { id: t.id, roman: t.roman || s.roman || '', sectorName: t.sectorName || s.name || '', element: t.sectorName || s.name, motto: s.motto || '', color: t.color || '#d1ad62', ord: s.ord ?? 99,
      displayName: t.displayName || '', nicks: (t.members || []).slice(0, 2).map((m) => m.nickname || (m.name || '').split(' ')[0]), logo: t.logoAt ? `/api/public/team-logo/${t.id}?v=${t.logoAt}` : null };
  }).sort((a, b) => a.ord - b.ord);
  await Promise.all(list.map(async (t) => { t.img = await loadImg(t.logo); }));
  return list;
}

export function pickRecorderType() {
  const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return window.MediaRecorder ? types.find((x) => MediaRecorder.isTypeSupported(x)) || '' : '';
}

// Riproduzione (e registrazione) a schermo intero. opts: { perTeam, sound, record }.
export async function playTeamVideo(ms, opts = {}) {
  const perTeam = Math.max(5, Math.min(15, Number(opts.perTeam) || 7));
  const fmtKey = FORMATS[opts.format] ? opts.format : 'landscape';
  setFormat(fmtKey);
  if (document.fonts?.load) await Promise.all([document.fonts.load(`900 100px ${FD}`), document.fonts.load(`600 30px ${FM}`)]).catch(() => {});
  const teams = await teamsForVideo(ms);
  if (!teams.length) { toast('Nessuna coppia con un Settore in questa partita', 'error'); return; }
  const canvas = h('canvas', { width: W, height: H, class: 'tv-canvas' });
  const ctx = canvas.getContext('2d');
  const status = h('div', { class: 'tv-status' });
  let stopped = false;
  const close = h('button', { type: 'button', class: 'tv-close', 'aria-label': 'Chiudi', onclick: () => { stopped = true; } }, '✕');
  const overlay = h('div', { class: 'tv-overlay' }, canvas, close, status);
  document.body.append(overlay);
  try { await overlay.requestFullscreen?.(); } catch { /* non obbligatorio */ }
  const grain = makeGrain();
  const audio = opts.sound !== false ? makeAudio() : null;
  const total = INTRO + teams.length * perTeam + OUTRO;
  let rec = null;
  const chunks = [];
  const type = opts.record ? pickRecorderType() : '';
  if (opts.record) {
    if (!type) { toast('Questo browser non sa registrare video: usa Chrome o Edge sul computer', 'error', 8000); overlay.remove(); return; }
    const stream = canvas.captureStream(30);
    if (audio) for (const tr of audio.dest.stream.getAudioTracks()) stream.addTrack(tr);
    rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 12_000_000 });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start(1000);
  }
  audio?.start();
  const states = teams.map((tm) => ({ particles: makeParticles(tm.element), dt: 0 }));
  const cues = new Set();
  const cue = (key, fn) => { if (!cues.has(key)) { cues.add(key); fn(); } };
  const t0 = performance.now();
  let last = t0;
  await new Promise((resolve) => {
    const frame = (now) => {
      const t = (now - t0) / 1000;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (stopped || t >= total) { resolve(); return; }
      ctx.globalAlpha = 1;
      if (t < INTRO) {
        drawIntro(ctx, t, ms.game?.name || '', teams.length);
        if (audio) { if (t > 0.6) cue('title', () => audio.boom()); }
      }
      else if (t < INTRO + teams.length * perTeam) {
        const i = Math.floor((t - INTRO) / perTeam);
        const lt = t - INTRO - i * perTeam;
        states[i].dt = dt;
        drawTeam(ctx, lt, perTeam, teams[i], states[i]);
        if (audio) { if (lt > 0.6) cue(`r${i}`, () => audio.riser(1.4)); if (lt > 2.0) cue(`b${i}`, () => audio.boom()); if (lt > 3.2) cue(`h${i}`, () => audio.names(teams[i].nicks.filter(Boolean).length)); }
        status.textContent = `${i + 1}/${teams.length} · ${teams[i].roman} ${teams[i].sectorName}${rec ? ' · ⏺ registrazione' : ''}`;
      } else { drawOutro(ctx, t - INTRO - teams.length * perTeam); if (audio) cue('end', () => audio.boom(1.2)); }
      drawVignette(ctx);
      drawGrain(ctx, grain);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  audio?.stop();
  if (rec) {
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    if (!stopped) {
      const blob = new Blob(chunks, { type: type.split(';')[0] });
      const a = h('a', { href: URL.createObjectURL(blob), download: `presentazione-coppie-${fmtKey === 'landscape' ? '16x9' : fmtKey === 'reel' ? 'reel-9x16' : fmtKey === 'post' ? 'post-4x5' : '1x1'}.${type.includes('mp4') ? 'mp4' : 'webm'}` });
      document.body.append(a); a.click(); a.remove();
      toast(`Video pronto: ${Math.round(blob.size / 1e6)} MB scaricati`, 'ok', 8000);
    } else toast('Registrazione interrotta', 'info');
  }
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  overlay.remove();
}

// Una sola immagine (per l'anteprima nella pagina): la coppia i al momento in cui compaiono i nick.
export function drawStill(canvas, team, perTeam = 7, format = 'landscape') {
  const f = setFormat(format);
  canvas.width = f.w; canvas.height = f.h;
  const ctx = canvas.getContext('2d');
  const st = { particles: makeParticles(team.element), dt: 0 };
  drawTeam(ctx, 5, perTeam, team, st);
  drawVignette(ctx);
}

export const VIDEO_TIMING = { INTRO, OUTRO };
