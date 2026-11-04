import sharp from 'sharp';

const W = 864;
const H = 1152;
const base =
  'C:/Users/soura/.cursor/projects/c-Projects-Ganabhawan-Ticket/assets/ganabhawan-gate-base.jpg';
const out = 'public/images/samatat/ganabhawan-gate-poster.jpg';

const pillar = [
  'public/images/samatat/shows/actor-koushik-sen.jpg',
  'public/images/samatat/shows/actor-rajatava-dutta.jpg',
  'public/images/samatat/shows/actor-goutam-halder.jpg',
  'public/images/samatat/shows/actor-debshankar-halder.jpg',
];
const hang = [
  'public/images/samatat/shows/actor-anjana-basu.jpg',
  'public/images/samatat/collage-05.jpg',
  'public/images/samatat/collage-01.jpg',
  'public/images/samatat/shows/jatra-gopal-still.jpg',
];
const frames = [
  { left: 78, top: 265, width: 118, height: 168 },
  { left: 78, top: 500, width: 118, height: 188 },
  { left: 668, top: 265, width: 118, height: 168 },
  { left: 668, top: 500, width: 118, height: 188 },
];
const banners = [
  { left: 205, top: 205, width: 100, height: 132, rotate: -5 },
  { left: 315, top: 188, width: 100, height: 132, rotate: 3 },
  { left: 445, top: 188, width: 100, height: 132, rotate: -3 },
  { left: 555, top: 205, width: 100, height: 132, rotate: 5 },
];

async function cover(src, w, h) {
  return sharp(src).rotate().resize(w, h, { fit: 'cover', position: 'attention' }).toBuffer();
}

const composites = [];
for (let i = 0; i < frames.length; i++) {
  const f = frames[i];
  const buf = await cover(pillar[i], f.width, f.height);
  const framed = await sharp(buf)
    .extend({ top: 3, bottom: 3, left: 3, right: 3, background: { r: 196, g: 147, b: 26 } })
    .jpeg()
    .toBuffer();
  composites.push({ input: framed, left: f.left - 3, top: f.top - 3 });
}
for (let i = 0; i < banners.length; i++) {
  const b = banners[i];
  const buf = await cover(hang[i], b.width, b.height);
  const mat = await sharp(buf)
    .extend({ top: 3, bottom: 10, left: 3, right: 3, background: { r: 250, g: 245, b: 230 } })
    .png()
    .toBuffer();
  const rotated = await sharp(mat)
    .rotate(b.rotate, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const meta = await sharp(rotated).metadata();
  const dx = Math.round(((meta.width || b.width) - b.width) / 2);
  const dy = Math.round(((meta.height || b.height) - b.height) / 2);
  composites.push({
    input: rotated,
    left: Math.max(0, b.left - dx),
    top: Math.max(0, b.top - dy),
  });
}

const svg = Buffer.from(`<svg width="${W}" height="72" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="rgba(24,19,17,0.72)"/>
  <text x="50%" y="30" text-anchor="middle" fill="#f5e6b8" font-family="Georgia, serif" font-size="15" letter-spacing="3">GANABHAWAN · UTTARPARA</text>
  <text x="50%" y="54" text-anchor="middle" fill="#ffffff" font-family="Noto Sans Bengali, Georgia, serif" font-size="18" font-weight="700">সমতট নাট্যমেলা ২০২৬</text>
</svg>`);
composites.push({ input: await sharp(svg).png().toBuffer(), left: 0, top: H - 72 });

await sharp(base)
  .resize(W, H)
  .composite(composites)
  .jpeg({ quality: 91, mozjpeg: true })
  .toFile(out);
console.log('wrote', out);
