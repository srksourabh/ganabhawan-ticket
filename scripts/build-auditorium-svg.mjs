/**
 * Builds public/images/auditorium-house.svg
 * View from the stage: stage at the bottom, Premier in front,
 * Superior behind it, one balcony above. Zones highlight on hover.
 */
import { writeFileSync } from 'node:fs';

const W = 680;
const H = 960;
const CX = 340;

const parts = [];
let shapes = 0;
const el = (s) => {
  shapes += 1;
  parts.push(s);
};

const hash = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const r1 = (n) => Math.round(n * 10) / 10;

function span(y, yFront, yBack, front, back) {
  const t = (yFront - y) / (yFront - yBack);
  const c = Math.max(0, Math.min(1, t));
  return front + (back - front) * c;
}

function seatMarkup(x, y, w, h, shade, gid) {
  const armW = Math.max(1.15, w * 0.12);
  const jx = (hash(x * 3 + y) - 0.5) * 0.5;
  const xx = r1(x + jx);
  const yy = r1(y);
  const ww = r1(w);
  const hh = r1(h);
  const rx = r1(Math.min(ww, hh) * 0.16);
  const patch = hash(x + y * 9);
  return [
    `<ellipse cx="${r1(xx + ww / 2)}" cy="${r1(yy + hh + 1.4)}" rx="${r1(ww * 0.46)}" ry="${r1(Math.max(0.8, hh * 0.12))}" fill="#0c1424" opacity="0.34"/>`,
    `<rect x="${r1(xx + ww * 0.08)}" y="${r1(yy + hh * 0.78)}" width="${r1(ww * 0.84)}" height="${r1(hh * 0.22)}" rx="${r1(hh * 0.06)}" fill="#102038"/>`,
    `<rect x="${r1(xx - armW * 0.15)}" y="${r1(yy + hh * 0.22)}" width="${r1(armW)}" height="${r1(hh * 0.78)}" rx="${r1(armW * 0.4)}" fill="url(#woodArm)"/>`,
    `<rect x="${r1(xx + ww - armW * 0.85)}" y="${r1(yy + hh * 0.22)}" width="${r1(armW)}" height="${r1(hh * 0.78)}" rx="${r1(armW * 0.4)}" fill="url(#woodArm)"/>`,
    `<path d="M ${xx} ${r1(yy + hh * 0.2)} Q ${xx} ${yy} ${r1(xx + ww * 0.18)} ${yy} H ${r1(xx + ww * 0.82)} Q ${r1(xx + ww)} ${yy} ${r1(xx + ww)} ${r1(yy + hh * 0.2)} V ${r1(yy + hh * 0.86)} Q ${r1(xx + ww)} ${r1(yy + hh)} ${r1(xx + ww * 0.8)} ${r1(yy + hh)} H ${r1(xx + ww * 0.2)} Q ${xx} ${r1(yy + hh)} ${xx} ${r1(yy + hh * 0.86)} Z" fill="url(#${gid})"/>`,
    `<rect x="${xx}" y="${r1(yy + hh * 0.16)}" width="${r1(ww * 0.16)}" height="${r1(hh * 0.7)}" fill="#061428" opacity="0.22"/>`,
    `<rect x="${r1(xx + ww * 0.84)}" y="${r1(yy + hh * 0.16)}" width="${r1(ww * 0.16)}" height="${r1(hh * 0.7)}" fill="#04101e" opacity="0.16"/>`,
    `<ellipse cx="${r1(xx + ww * 0.46)}" cy="${r1(yy + hh * 0.16)}" rx="${r1(ww * 0.32)}" ry="${r1(hh * 0.13)}" fill="#c5dff8" opacity="${patch > 0.5 ? 0.42 : 0.26}"/>`,
    `<rect x="${r1(xx + ww * 0.4)}" y="${r1(yy + hh * 0.22)}" width="${r1(ww * 0.07)}" height="${r1(hh * 0.48)}" fill="#e8f4ff" opacity="0.18"/>`,
    patch > 0.82 ? `<ellipse cx="${r1(xx + ww * 0.62)}" cy="${r1(yy + hh * 0.58)}" rx="${r1(ww * 0.16)}" ry="${r1(hh * 0.12)}" fill="${shade}" opacity="0.2"/>` : '',
    `<path d="M ${r1(xx + ww * 0.2)} ${r1(yy + hh * 0.74)} H ${r1(xx + ww * 0.8)}" fill="none" stroke="#0a1c34" stroke-width="0.4" opacity="0.35"/>`,
    `<ellipse cx="${r1(xx + ww * 0.42)}" cy="${r1(yy + hh * 0.2)}" rx="${r1(ww * 0.2)}" ry="${r1(hh * 0.08)}" fill="url(#seatSheen)"/>`,
    `<ellipse class="glow" cx="${r1(xx + ww / 2)}" cy="${r1(yy + hh * 0.4)}" rx="${r1(ww * 0.4)}" ry="${r1(hh * 0.46)}" fill="#fff3d4"/>`,
  ].join('');
}

function stallSeats(yFront, yBack, rows, perSide, halfFront, halfBack, aisleFront, aisleBack, gid, shade) {
  let html = '';
  let n = 0;
  for (let r = 0; r < rows; r++) {
    const t = rows === 1 ? 1 : r / (rows - 1);
    const y = yBack + (yFront - yBack) * t;
    const half = halfBack + (halfFront - halfBack) * t;
    const aisle = aisleBack + (aisleFront - aisleBack) * t;
    const rowSpan = half - aisle;
    const slot = rowSpan / perSide;
    const seatW = slot * 0.74;
    const seatH = seatW * 0.86;
    const riserY = r1(y - seatH - 1.4);
    const riserH = r1(Math.max(1.2, seatH * 0.08));
    html += `<path d="M ${r1(CX - half)} ${riserY} H ${r1(CX - aisle)} V ${r1(riserY + riserH)} H ${r1(CX - half)} Z M ${r1(CX + aisle)} ${riserY} H ${r1(CX + half)} V ${r1(riserY + riserH)} H ${r1(CX + aisle)} Z" fill="#1c1410" opacity="0.45"/>`;
    shapes += 1;
    for (const side of [-1, 1]) {
      for (let c = 0; c < perSide; c++) {
        const cx = CX + side * (aisle + (c + 0.5) * slot);
        html += seatMarkup(cx - seatW / 2, y - seatH, seatW, seatH, shade, gid);
        n += 1;
        shapes += 11;
      }
    }
  }
  return { html, n };
}

function balconySeats(rows, perSide) {
  let html = '';
  let n = 0;
  const yFront = 198;
  const yBack = 84;
  for (let r = 0; r < rows; r++) {
    const t = rows === 1 ? 1 : r / (rows - 1);
    const yBase = yBack + (yFront - yBack) * t;
    const half = 150 + (210 - 150) * t;
    const aisle = 12 + 4 * t;
    const curve = 6 + 10 * t;
    const rowSpan = half - aisle;
    const slot = rowSpan / perSide;
    const seatW = slot * 0.62;
    const seatH = Math.min(seatW * 0.72, (yFront - yBack) / rows * 0.78);
    for (const side of [-1, 1]) {
      for (let c = 0; c < perSide; c++) {
        const local = aisle + (c + 0.5) * slot;
        const cx = CX + side * local;
        const y = yBase + curve * ((cx - CX) / half) ** 2;
        html += seatMarkup(cx - seatW / 2, y - seatH, seatW, seatH, '#1a3c68', 'balconyVelvet');
        n += 1;
        shapes += 11;
      }
    }
  }
  return { html, n };
}

function curvePoints(x0, x1, yCenter, bow, steps = 36) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    const y = yCenter + bow * ((x - CX) / ((x1 - x0) / 2)) ** 2;
    pts.push([r1(x), r1(y)]);
  }
  return pts;
}

function bandPath(x0, x1, yCenter, bow, thick) {
  const top = curvePoints(x0, x1, yCenter, bow);
  const bot = curvePoints(x0, x1, yCenter + thick, bow * 0.92).reverse();
  const d = [...top, ...bot].map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ') + ' Z';
  return d;
}

// Two-thirds of the previous 242: 9 × 9 × 2 = 162 in each zone.
// A cross-aisle separates Premier from Superior on the same floor.
const ROWS = 9;
const PER_SIDE = 9;
const STALLS_FRONT = 746;
const STALLS_BACK = 318;
const SUPERIOR_FRONT = 478;
const PREMIER_BACK = 590;
const premier = stallSeats(STALLS_FRONT, PREMIER_BACK, ROWS, PER_SIDE, 248, 214, 20, 16, 'premierVelvet', '#7eb6e8');
const superior = stallSeats(SUPERIOR_FRONT, STALLS_BACK, ROWS, PER_SIDE, 190, 158, 14, 12, 'superiorVelvet', '#1a3c68');

const fascia = bandPath(108, 572, 214, 34, 28);
const rail = bandPath(108, 572, 210, 34, 5);
const railPts = curvePoints(128, 552, 212, 30, 8);

let lamps = '';
let balusters = '';
const railLine = curvePoints(112, 568, 214, 32, 56);
for (let i = 0; i < railLine.length; i++) {
  const [x, y] = railLine[i];
  balusters += `<rect x="${r1(x - 1.1)}" y="${r1(y + 4)}" width="2.2" height="16" rx="0.6" fill="#f4e6c8" opacity="0.85"/>`;
  shapes += 1;
  if (i % 7 === 0) {
    lamps += `<ellipse cx="${x}" cy="${r1(y - 2)}" rx="11" ry="7" fill="#ffd898" opacity="0.16"/>`;
    lamps += `<ellipse cx="${x}" cy="${r1(y - 2)}" rx="6" ry="4" fill="#fff1cc" opacity="0.22"/>`;
    lamps += `<ellipse cx="${x}" cy="${r1(y - 8)}" rx="2.4" ry="3.6" fill="url(#lampGlow)"/>`;
    lamps += `<rect x="${r1(x - 0.7)}" y="${r1(y - 4)}" width="1.4" height="7" fill="#6a5430"/>`;
    shapes += 4;
  }
}

let sconces = '';
for (const side of [-1, 1]) {
  for (const y of [340, 470, 620, 740]) {
    const x = side < 0 ? 46 : 634;
    sconces += `<ellipse cx="${x}" cy="${y}" rx="7" ry="10" fill="url(#sconceGlow)" opacity="0.85"/>`;
    sconces += `<rect x="${x - 1.2}" y="${y - 8}" width="2.4" height="14" rx="0.6" fill="#d7c08a"/>`;
    shapes += 2;
  }
}

let grain = '';
for (let i = 0; i <= 18; i++) {
  const t = i / 18;
  const xTop = 150 + 380 * t;
  const xBot = 70 + 540 * t;
  grain += `<path d="M ${r1(xTop)} 812 L ${r1(xBot)} 948" fill="none" stroke="#2a2118" stroke-width="0.6" opacity="${0.18 + (i % 3) * 0.04}"/>`;
  shapes += 1;
}
for (let i = 0; i < 7; i++) {
  const y = 830 + i * 16;
  grain += `<path d="M 90 ${y} Q 250 ${y + 2} 340 ${y - 1} T 590 ${y + 1}" fill="none" stroke="#8a7352" stroke-width="0.4" opacity="0.12"/>`;
  shapes += 1;
}

let speck = '';
for (let i = 0; i < 70; i++) {
  const x = 20 + hash(i) * 640;
  const y = 40 + hash(i + 19) * 760;
  if (x > 90 && x < 590 && y > 120 && y < 790) continue;
  speck += `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(0.6 + hash(i + 3) * 0.8)}" fill="#f0e2c4" opacity="${r1(0.05 + hash(i + 5) * 0.08)}"/>`;
  shapes += 1;
}

let leaves = '';
for (let i = 0; i < 42; i++) {
  const t = i / 41;
  const x = 70 + 540 * t;
  const y = 78 + 36 * ((x - CX) / 270) ** 2;
  const tilt = (t - 0.5) * 40;
  leaves += `<ellipse cx="${r1(x)}" cy="${r1(y)}" rx="7" ry="2.2" transform="rotate(${r1(tilt)} ${r1(x)} ${r1(y)})" fill="#e6d3a2" opacity="0.55"/>`;
  shapes += 1;
}

let panels = '';
for (const side of [-1, 1]) {
  for (let i = 0; i < 5; i++) {
    const y = 280 + i * 100;
    const x = side < 0 ? 18 : 612;
    panels += `<rect x="${x}" y="${y}" width="50" height="78" rx="2" fill="url(#panelInner)" stroke="#c6ad72" stroke-width="0.6" opacity="0.9"/>`;
    panels += `<rect x="${x + 6}" y="${y + 8}" width="38" height="62" rx="1" fill="none" stroke="#e8d7a8" stroke-width="0.4" opacity="0.7"/>`;
    shapes += 2;
  }
}

const balcony = balconySeats(ROWS, PER_SIDE);
const premierPoly = '118,582 562,582 604,752 76,752';
const superiorPoly = '168,308 512,308 546,488 134,488';
const balconyPoly = '100,72 580,72 590,248 90,248';

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-labelledby="title desc">
  <title id="title">Ganabhawan auditorium, seen from the stage</title>
  <desc id="desc">The stage is the floor at the bottom. Premier is the front of the ground floor, Superior is the back of the ground floor, and the single gallery is Balcony. Hover a zone to light every seat in that block. Seats are not numbered.</desc>
  <defs>
    <linearGradient id="ceiling" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2a2118"/>
      <stop offset="45%" stop-color="#4a3b2c"/>
      <stop offset="100%" stop-color="#6b5340"/>
    </linearGradient>
    <radialGradient id="houseGlow" cx="50%" cy="18%" r="65%">
      <stop offset="0%" stop-color="#f0d7a4" stop-opacity="0.45"/>
      <stop offset="40%" stop-color="#c4a36a" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#1a120e" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="wallCream" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#efe2c8"/>
      <stop offset="40%" stop-color="#e4d2ae"/>
      <stop offset="100%" stop-color="#cbb892"/>
    </linearGradient>
    <linearGradient id="wallLeft" x1="1" y1="0" x2="0" y2="0">
      <stop offset="0%" stop-color="#f3e6cc"/>
      <stop offset="55%" stop-color="#d9c49a"/>
      <stop offset="100%" stop-color="#8d734c"/>
    </linearGradient>
    <linearGradient id="wallRight" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#f3e6cc"/>
      <stop offset="55%" stop-color="#d9c49a"/>
      <stop offset="100%" stop-color="#8d734c"/>
    </linearGradient>
    <linearGradient id="archGold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f4e7c4"/>
      <stop offset="35%" stop-color="#d4b36a"/>
      <stop offset="70%" stop-color="#a6843e"/>
      <stop offset="100%" stop-color="#6e5424"/>
    </linearGradient>
    <linearGradient id="fasciaCream" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f7edd8"/>
      <stop offset="45%" stop-color="#e6d3aa"/>
      <stop offset="100%" stop-color="#b89a62"/>
    </linearGradient>
    <linearGradient id="brass" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fff6dd"/>
      <stop offset="30%" stop-color="#e6c56a"/>
      <stop offset="60%" stop-color="#a67c32"/>
      <stop offset="100%" stop-color="#5c4014"/>
    </linearGradient>
    <linearGradient id="premierVelvet" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#7eb6ea"/>
      <stop offset="28%" stop-color="#3d7ec4"/>
      <stop offset="62%" stop-color="#245e9c"/>
      <stop offset="100%" stop-color="#12325c"/>
    </linearGradient>
    <linearGradient id="superiorVelvet" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#5a92c8"/>
      <stop offset="34%" stop-color="#2a629c"/>
      <stop offset="70%" stop-color="#1a4574"/>
      <stop offset="100%" stop-color="#0e2848"/>
    </linearGradient>
    <linearGradient id="balconyVelvet" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#4a7eb4"/>
      <stop offset="40%" stop-color="#1e4e86"/>
      <stop offset="100%" stop-color="#0c2444"/>
    </linearGradient>
    <radialGradient id="seatSheen" cx="40%" cy="35%" r="65%">
      <stop offset="0%" stop-color="#eaf4ff" stop-opacity="0.9"/>
      <stop offset="45%" stop-color="#8eb8e0" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="woodArm" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#2a1c12"/>
      <stop offset="40%" stop-color="#6a4a2c"/>
      <stop offset="100%" stop-color="#1a100c"/>
    </linearGradient>
    <linearGradient id="stageFloor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#14110e"/>
      <stop offset="18%" stop-color="#2a241c"/>
      <stop offset="55%" stop-color="#3a3228"/>
      <stop offset="100%" stop-color="#1a1612"/>
    </linearGradient>
    <radialGradient id="stageReflect" cx="50%" cy="20%" r="75%">
      <stop offset="0%" stop-color="#f0d8a0" stop-opacity="0.28"/>
      <stop offset="45%" stop-color="#c4a060" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="curtain" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#4a1020"/>
      <stop offset="22%" stop-color="#8a2438"/>
      <stop offset="48%" stop-color="#c44a58"/>
      <stop offset="72%" stop-color="#7a1c30"/>
      <stop offset="100%" stop-color="#3a0c18"/>
    </linearGradient>
    <linearGradient id="speakerBody" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#1a1c20"/>
      <stop offset="35%" stop-color="#3a3e46"/>
      <stop offset="100%" stop-color="#121418"/>
    </linearGradient>
    <radialGradient id="spot" cx="50%" cy="0%" r="80%">
      <stop offset="0%" stop-color="#fff6d8" stop-opacity="0.55"/>
      <stop offset="40%" stop-color="#ffe0a0" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#ffe0a0" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="exitDoor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#3a342c"/>
      <stop offset="40%" stop-color="#2a241c"/>
      <stop offset="100%" stop-color="#16120e"/>
    </linearGradient>
    <radialGradient id="lampGlow" cx="50%" cy="40%" r="60%">
      <stop offset="0%" stop-color="#fff8e8"/>
      <stop offset="35%" stop-color="#ffd78a" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#e8a040" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="sconceGlow" cx="50%" cy="40%" r="60%">
      <stop offset="0%" stop-color="#fff6e0"/>
      <stop offset="40%" stop-color="#f0c27a" stop-opacity="0.75"/>
      <stop offset="100%" stop-color="#c08040" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="washGold" cx="50%" cy="50%" r="62%">
      <stop offset="0%" stop-color="#ffe3a8" stop-opacity="0.42"/>
      <stop offset="55%" stop-color="#f0c080" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="#f0c080" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="carpet" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#142033"/>
      <stop offset="50%" stop-color="#24384f"/>
      <stop offset="100%" stop-color="#142033"/>
    </linearGradient>
    <linearGradient id="panelInner" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f6ecd4"/>
      <stop offset="50%" stop-color="#e7d4ae"/>
      <stop offset="100%" stop-color="#c9b084"/>
    </linearGradient>
    <radialGradient id="underBalcony" cx="50%" cy="0%" r="70%">
      <stop offset="0%" stop-color="#120e0c" stop-opacity="0.55"/>
      <stop offset="70%" stop-color="#120e0c" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="#120e0c" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="lip" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0e0c0a"/>
      <stop offset="40%" stop-color="#2a241c"/>
      <stop offset="100%" stop-color="#0c0a08"/>
    </linearGradient>
    <clipPath id="hallClip">
      <path d="M 28 830 L 96 248 C 150 108 230 62 340 56 C 450 62 530 108 584 248 L 652 830 Z"/>
    </clipPath>
    <clipPath id="stageClip">
      <path d="M 168 786 Q 40 830 78 900 Q 150 956 340 964 Q 530 956 602 900 Q 640 830 512 786 Q 340 762 168 786 Z"/>
    </clipPath>
  </defs>
  <style>
    .scenery, .scenery * { pointer-events: none; }
    .zone { cursor: pointer; }
    .glow { opacity: 0; pointer-events: none; }
    .wash { opacity: 0; pointer-events: none; }
    .zone-plate { fill: #10141c; opacity: 0.9; stroke: #f0e2bc; stroke-width: 1.1; pointer-events: none; }
    .zone-label { fill: #fff8ea; opacity: 1; font-family: Georgia, 'Times New Roman', serif; font-weight: 700; letter-spacing: 0.14em; pointer-events: none; }
    .zone:hover .glow, .zone:focus-within .glow { opacity: 0.5; }
    .zone:hover .wash, .zone:focus-within .wash { opacity: 1; }
    .hit { fill: transparent; outline: none; }
    .hit:focus { outline: none; }
  </style>

  <!-- 1 environment: cream house, gold arch, warm lamps -->
  <g class="scenery">
  <rect width="${W}" height="${H}" fill="url(#wallCream)"/>
  <rect width="${W}" height="210" fill="url(#ceiling)"/>
  <rect width="${W}" height="${H}" fill="url(#houseGlow)"/>
  <path d="M 0 0 H 92 L 78 800 H 0 Z" fill="url(#wallLeft)"/>
  <path d="M 680 0 H 588 L 602 800 H 680 Z" fill="url(#wallRight)"/>
  <path d="M 36 250 C 36 90 160 28 340 22 C 520 28 644 90 644 250 L 608 268 C 590 120 490 78 340 74 C 190 78 90 120 72 268 Z" fill="url(#wallCream)"/>
  <path d="M 48 246 C 48 102 168 42 340 36 C 512 42 632 102 632 246" fill="none" stroke="url(#archGold)" stroke-width="10"/>
  <path d="M 62 252 C 62 116 176 60 340 54 C 504 60 618 116 618 252" fill="none" stroke="#f7edd4" stroke-width="1.4" opacity="0.85"/>
  <path d="M 78 258 C 78 132 186 78 340 72 C 494 78 602 132 602 258" fill="none" stroke="#8d6a32" stroke-width="1" opacity="0.45"/>
  ${leaves}
  ${panels}
  ${speck}
  ${sconces}
  <g id="exit-left">
    <path d="M 16 612 V 548 Q 16 520 46 520 Q 76 520 76 548 V 612 Z" fill="#1c1814"/>
    <path d="M 20 608 V 552 Q 20 528 46 528 Q 72 528 72 552 V 608 Z" fill="url(#exitDoor)"/>
    <path d="M 46 528 V 608" stroke="#c6ad72" stroke-width="0.8"/>
    <circle cx="40" cy="572" r="1.3" fill="#e6d3a2"/>
    <circle cx="52" cy="572" r="1.3" fill="#e6d3a2"/>
    <ellipse cx="46" cy="516" rx="10" ry="5" fill="url(#lampGlow)" opacity="0.85"/>
    <text x="46" y="506" text-anchor="middle" fill="#f3e6c4" font-family="Georgia, 'Times New Roman', serif" font-size="7" letter-spacing="0.14em">EXIT</text>
  </g>
  <g id="exit-right">
    <path d="M 664 612 V 548 Q 664 520 634 520 Q 604 520 604 548 V 612 Z" fill="#1c1814"/>
    <path d="M 660 608 V 552 Q 660 528 634 528 Q 608 528 608 552 V 608 Z" fill="url(#exitDoor)"/>
    <path d="M 634 528 V 608" stroke="#c6ad72" stroke-width="0.8"/>
    <circle cx="628" cy="572" r="1.3" fill="#e6d3a2"/>
    <circle cx="640" cy="572" r="1.3" fill="#e6d3a2"/>
    <ellipse cx="634" cy="516" rx="10" ry="5" fill="url(#lampGlow)" opacity="0.85"/>
    <text x="634" y="506" text-anchor="middle" fill="#f3e6c4" font-family="Georgia, 'Times New Roman', serif" font-size="7" letter-spacing="0.14em">EXIT</text>
  </g>
  </g>

  <!-- 2–8 house, back to front. Premier and Superior share one floor. -->
  <g clip-path="url(#hallClip)">
    <g class="scenery">
      <path d="M 150 70 L 530 70 L 560 250 L 120 250 Z" fill="#2a1c18"/>
      <path d="M 158 300 L 522 300 L 612 760 L 68 760 Z" fill="#241816"/>
      <path d="M 326 312 H 354 L 350 470 H 330 Z" fill="url(#carpet)"/>
      <path d="M 124 496 L 556 496 L 582 574 L 98 574 Z" fill="#3a322a"/>
      <path d="M 120 494 H 560" fill="none" stroke="#e6d3a2" stroke-width="1" opacity="0.55"/>
      <path d="M 96 576 H 584" fill="none" stroke="#e6d3a2" stroke-width="1" opacity="0.55"/>
      <path d="M 322 598 H 358 L 362 748 H 318 Z" fill="url(#carpet)"/>
      <path d="${fascia}" fill="url(#fasciaCream)"/>
      ${balusters}
      <path d="${rail}" fill="url(#brass)"/>
      ${lamps}
      <path d="M 132 274 H 548" fill="none" stroke="#e6d3a2" stroke-width="0.8" opacity="0.55"/>
      <ellipse cx="340" cy="300" rx="180" ry="10" fill="url(#underBalcony)"/>
    </g>

    <g class="zone zone-balcony">
      ${balcony.html}
      <path class="wash" d="M 108 74 L 572 74 L 586 246 L 94 246 Z" fill="url(#washGold)"/>
      <rect class="zone-plate" x="242" y="124" width="196" height="32" rx="5"/>
      <text class="zone-label" x="340" y="146" text-anchor="middle" font-size="16">BALCONY</text>
      <polygon class="hit" points="${balconyPoly}" tabindex="0"><title>Balcony</title></polygon>
    </g>

    <g class="zone zone-superior">
      ${superior.html}
      <path class="wash" d="M 160 308 L 520 308 L 552 486 L 128 486 Z" fill="url(#washGold)"/>
      <rect class="zone-plate" x="222" y="372" width="236" height="36" rx="5"/>
      <text class="zone-label" x="340" y="397" text-anchor="middle" font-size="18">SUPERIOR</text>
      <polygon class="hit" points="${superiorPoly}" tabindex="0"><title>Superior</title></polygon>
    </g>

    <g class="zone zone-premier">
      ${premier.html}
      <path class="wash" d="M 110 584 L 570 584 L 612 756 L 68 756 Z" fill="url(#washGold)"/>
      <rect class="zone-plate" x="228" y="648" width="224" height="38" rx="5"/>
      <text class="zone-label" x="340" y="674" text-anchor="middle" font-size="20">PREMIER</text>
      <polygon class="hit" points="${premierPoly}" tabindex="0"><title>Premier</title></polygon>
    </g>
  </g>

  <!-- stage in front: shell apron, a sliver of curtain, lights and speakers -->
  <g class="scenery">
    <path d="M 108 748 C 96 790 118 812 112 836 L 150 828 C 142 800 156 772 148 748 Z" fill="url(#curtain)"/>
    <path d="M 124 752 C 118 786 132 808 128 830" fill="none" stroke="#f0c0c4" stroke-width="0.7" opacity="0.35"/>
    <path d="M 572 748 C 584 790 562 812 568 836 L 530 828 C 538 800 524 772 532 748 Z" fill="url(#curtain)"/>
    <path d="M 556 752 C 562 786 548 808 552 830" fill="none" stroke="#f0c0c4" stroke-width="0.7" opacity="0.35"/>
    <path d="M 168 786 Q 40 830 78 900 Q 150 956 340 964 Q 530 956 602 900 Q 640 830 512 786 Q 340 762 168 786 Z" fill="#120e0c"/>
    <g clip-path="url(#stageClip)">
      <rect x="40" y="760" width="600" height="210" fill="url(#stageFloor)"/>
      <rect x="40" y="760" width="600" height="210" fill="url(#stageReflect)"/>
      ${grain}
      <path d="M 200 800 Q 340 860 480 800 L 470 900 Q 340 940 210 900 Z" fill="url(#spot)" opacity="0.9"/>
      <path d="M 250 808 Q 340 850 430 808 L 424 880 Q 340 910 256 880 Z" fill="#fff6dd" opacity="0.08"/>
    </g>
    <path d="M 168 786 Q 340 762 512 786" fill="none" stroke="#e6d3a2" stroke-width="1.3" opacity="0.7"/>
    <path d="M 120 812 Q 70 860 96 918" fill="none" stroke="#8a7040" stroke-width="0.6" opacity="0.45"/>
    <path d="M 560 812 Q 610 860 584 918" fill="none" stroke="#8a7040" stroke-width="0.6" opacity="0.45"/>
    <path d="M 188 774 H 492" stroke="#5c5348" stroke-width="3"/>
    <path d="M 188 774 H 492" stroke="#d7c29a" stroke-width="0.6" opacity="0.7"/>
    ${[210, 255, 300, 340, 380, 425, 470].map((x) => `<g>
      <rect x="${x - 7}" y="762" width="14" height="10" rx="2" fill="#2a241c"/>
      <ellipse cx="${x}" cy="768" rx="4" ry="3" fill="#1a140c"/>
      <ellipse cx="${x}" cy="770" rx="2.2" ry="1.6" fill="url(#lampGlow)"/>
      <path d="M ${x - 16} 786 L ${x + 16} 786 L ${x + 8} 830 L ${x - 8} 830 Z" fill="url(#spot)" opacity="0.55"/>
    </g>`).join('')}
    <g>
      <rect x="46" y="820" width="26" height="78" rx="3" fill="url(#speakerBody)"/>
      <rect x="50" y="826" width="18" height="50" rx="1" fill="#0e1014"/>
      ${[0, 1, 2, 3, 4, 5, 6].map((i) => `<path d="M 52 ${832 + i * 6} H 66" stroke="#3a4048" stroke-width="0.7" opacity="0.8"/>`).join('')}
      <circle cx="59" cy="886" r="6" fill="#1a1e24" stroke="#5a6168" stroke-width="0.6"/>
      <circle cx="59" cy="886" r="2.2" fill="#2a3038"/>
    </g>
    <g>
      <rect x="608" y="820" width="26" height="78" rx="3" fill="url(#speakerBody)"/>
      <rect x="612" y="826" width="18" height="50" rx="1" fill="#0e1014"/>
      ${[0, 1, 2, 3, 4, 5, 6].map((i) => `<path d="M 614 ${832 + i * 6} H 628" stroke="#3a4048" stroke-width="0.7" opacity="0.8"/>`).join('')}
      <circle cx="621" cy="886" r="6" fill="#1a1e24" stroke="#5a6168" stroke-width="0.6"/>
      <circle cx="621" cy="886" r="2.2" fill="#2a3038"/>
    </g>
    <rect x="238" y="892" width="204" height="38" rx="5" fill="#10141c" opacity="0.9" stroke="#f0e2bc" stroke-width="1.1"/>
    <text x="340" y="918" text-anchor="middle" fill="#fff8ea" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="20" letter-spacing="0.22em">STAGE</text>
  </g>
</svg>
`;

writeFileSync(new URL('../public/images/auditorium-house.svg', import.meta.url), svg);
console.log('shapes-approx', shapes, 'premier', premier.n, 'superior', superior.n, 'balcony', balcony.n);
console.log('bytes', Buffer.byteLength(svg));
