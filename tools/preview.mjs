// Erzeugt Kontrollbilder der aufbereiteten Daten (preview/*.jpg).
// Aufruf: npm run data:preview
import fs from 'node:fs';
import sharp from 'sharp';
import { OUT_DIR, RAW_DIR } from './config.mjs';

fs.mkdirSync('preview', { recursive: true });
const scene = JSON.parse(fs.readFileSync(`${OUT_DIR}/scene.json`, 'utf8'));
const S = scene.core.size;
const PXM = 2;            // Pixel pro Meter im Vorschaubild
const W = S * PXM;
const X = (x) => ((x + S / 2) * PXM).toFixed(1);
const Z = (z) => ((z + S / 2) * PXM).toFixed(1);

// 1) Luftbild + Gebäudeumrisse + Straßen + wichtige Orte
const buildings = JSON.parse(fs.readFileSync(`${OUT_DIR}/buildings.json`, 'utf8'));
const osm = JSON.parse(fs.readFileSync(`${OUT_DIR}/osm.json`, 'utf8'));
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}">`;
for (const f of osm) {
  if (!f.g || !f.tags.highway) continue;
  const b51 = /B 51/.test(f.tags.ref || '');
  const major = /primary|secondary|tertiary|residential|unclassified/.test(f.tags.highway);
  svg += `<polyline fill="none" stroke="${b51 ? '#ff7a00' : major ? '#ffe14d' : '#9ad0ff'}" stroke-width="${b51 ? 7 : major ? 4 : 2}" stroke-opacity="0.85" points="${f.g.map(([x, z]) => `${X(x)},${Z(z)}`).join(' ')}"/>`;
}
for (const b of buildings) for (const s of b.surfaces) if (s.t === 'G') {
  const r = s.r[0]; const pts = [];
  for (let i = 0; i < r.length; i += 3) pts.push(`${X(r[i])},${Z(r[i + 2])}`);
  svg += `<polygon fill="#ff2d55" fill-opacity="0.25" stroke="#ff2d55" stroke-width="2" points="${pts.join(' ')}"/>`;
}
for (const p of scene.pois) {
  svg += `<circle cx="${X(p.x)}" cy="${Z(p.z)}" r="14" fill="#00e0ff" stroke="#000" stroke-width="3"/>`;
  svg += `<text x="${+X(p.x) + 20}" y="${+Z(p.z) + 10}" font-family="Arial" font-weight="bold" font-size="34" fill="#fff" stroke="#000" stroke-width="7" paint-order="stroke">${p.name.replace(/&/g, '&amp;')}</text>`;
}
svg += `<text x="20" y="${W - 30}" font-family="Arial" font-size="30" fill="#fff" stroke="#000" stroke-width="6" paint-order="stroke">Kerngebiet 1,5 × 1,5 km · Luftbild LGLN DOP20 · Gebäude LGLN LoD2 (rot) · Straßen OSM (B51 orange)</text></svg>`;
await sharp(`${RAW_DIR}/ortho-core-preview.jpg`).resize(W, W)
  .composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 82 }).toFile('preview/1-luftbild-gebaeude-strassen.jpg');

// 2) Schummerung (Hillshade) des Geländes
{
  const t = scene.core.terrain;
  const raw = new Uint16Array(fs.readFileSync(`${OUT_DIR}/${t.file}`).buffer.slice(0));
  const h = (i, j) => raw[Math.min(t.ny - 1, Math.max(0, j)) * t.nx + Math.min(t.nx - 1, Math.max(0, i))] / 100;
  const out = Buffer.alloc(t.nx * t.ny * 3);
  const L = [-0.5, 0.6, 0.62]; // Licht aus Nordwest
  for (let j = 0; j < t.ny; j++) for (let i = 0; i < t.nx; i++) {
    const dx = (h(i + 1, j) - h(i - 1, j)) / 2 * 4, dz = (h(i, j + 1) - h(i, j - 1)) / 2 * 4;
    const n = [-dx, 1, -dz]; const len = Math.hypot(...n);
    const shade = Math.max(0, (n[0] * L[0] + n[1] * L[1] + n[2] * L[2]) / len);
    const elev = (h(i, j) - 100 - t.min) / (t.max - t.min);
    const k = (j * t.nx + i) * 3;
    out[k] = Math.round(255 * shade * (0.55 + 0.45 * elev));
    out[k + 1] = Math.round(255 * shade * (0.75 + 0.2 * elev));
    out[k + 2] = Math.round(255 * shade * (0.6 - 0.2 * elev));
  }
  await sharp(out, { raw: { width: t.nx, height: t.ny, channels: 3 } }).jpeg({ quality: 85 }).toFile('preview/2-gelaende-schummerung.jpg');
}

// 3) Objekthöhen (DOM − DGM): Bäume, Hecken, Gebäude
{
  const { data, info } = await sharp(`${OUT_DIR}/chm-core.png`).raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height * 3);
  for (let i = 0; i < info.width * info.height; i++) {
    const m = data[i * info.channels] / 10;
    const v = Math.min(1, m / 20);
    out[i * 3] = m < 1 ? 20 : Math.round(40 + 200 * v);
    out[i * 3 + 1] = m < 1 ? 20 : Math.round(200 - 80 * v);
    out[i * 3 + 2] = m < 1 ? 30 : Math.round(60 + 40 * v);
  }
  await sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).jpeg({ quality: 85 }).toFile('preview/3-objekthoehen.jpg');
}
// 4) Bereinigtes Luftbild + erkannte Bäume (gelb: Laubbaum, cyan: Nadelbaum) und Büsche (magenta)
{
  const v = JSON.parse(fs.readFileSync(`${OUT_DIR}/vegetation.json`, 'utf8'));
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}">`;
  const t = v.trees.data;
  for (let i = 0; i < t.length; i += 6) s += `<circle cx="${X(t[i])}" cy="${Z(t[i + 1])}" r="${t[i + 4] * PXM}" fill="none" stroke="${t[i + 5] ? '#00e5ff' : '#ffeb3b'}" stroke-width="2"/>`;
  const b = v.bushes.data;
  for (let i = 0; i < b.length; i += 4) s += `<rect x="${+X(b[i]) - 1.5}" y="${+Z(b[i + 1]) - 1.5}" width="3" height="3" fill="#ff00ff"/>`;
  s += '</svg>';
  const crop = { left: 1100, top: 900, width: 1400, height: 1100 };
  const full = await sharp(`${RAW_DIR}/ortho-core-clean-preview.jpg`).resize(W, W).composite([{ input: Buffer.from(s) }]).png().toBuffer();
  await sharp(full).extract(crop).jpeg({ quality: 85 }).toFile('preview/4-vegetation-ausschnitt.jpg');
  await sharp(`${RAW_DIR}/ortho-core-clean-preview.jpg`).resize(W, W).extract(crop).jpeg({ quality: 85 }).toFile('preview/5-luftbild-bereinigt-ausschnitt.jpg');
}
console.log('Kontrollbilder in ./preview geschrieben.');
