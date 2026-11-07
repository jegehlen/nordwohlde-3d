// Wandelt die Rohdaten in kompakte, browserfreundliche Dateien um (public/data).
// Aufruf: npm run data:build
//
// Koordinatensystem der Szene (Three.js, rechtshändig, Y nach oben):
//   x = Ost  - ORIGIN.e      (Meter)
//   y = Höhe - H0            (Meter, DHHN2016)
//   z = -(Nord - ORIGIN.n)   (Meter, Norden = -z)
import fs from 'node:fs';
import path from 'node:path';
import { fromFile } from 'geotiff';
import sharp from 'sharp';
import { ORIGIN, CORE, OUTER, CORE_SIZE, OUTER_SIZE, RAW_DIR, OUT_DIR, toUTM } from './config.mjs';
import { synthesizeMissingBuildings, attachOsmTags } from './osm-buildings.mjs';

sharp.cache(false);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(`${OUT_DIR}/ortho`, { recursive: true });
const rawMeta = JSON.parse(fs.readFileSync(`${RAW_DIR}/meta.json`, 'utf8'));

// ---------------------------------------------------------------- Raster-Mosaik (DGM1 / DOM1)
async function loadRasterTiles(dir) {
  const tiles = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.tif'))) {
    const tiff = await fromFile(path.join(dir, f));
    const img = await tiff.getImage();
    const [ox, oy] = img.getOrigin();
    const [rx, ry] = img.getResolution();
    const w = img.getWidth(), h = img.getHeight();
    const [data] = await img.readRasters();
    const nodata = img.getGDALNoData();
    tiles.push({ ox, oy, rx, ry, w, h, data, nodata, minE: ox, maxE: ox + w * rx, maxN: oy, minN: oy + h * ry });
  }
  return tiles;
}

function makeSampler(tiles) {
  // Wert an Pixelindex (globale Pixel um Zellmittelpunkte)
  const at = (e, n) => {
    for (const t of tiles) {
      if (e >= t.minE && e < t.maxE && n > t.minN && n <= t.maxN) {
        const c = Math.min(t.w - 1, Math.max(0, Math.floor((e - t.ox) / t.rx)));
        const r = Math.min(t.h - 1, Math.max(0, Math.floor((n - t.oy) / t.ry)));
        const v = t.data[r * t.w + c];
        return v === t.nodata || v < -1000 ? NaN : v;
      }
    }
    return NaN;
  };
  // Bilinear über Zellmittelpunkte (Auflösung 1 m angenommen, aus erster Kachel)
  const res = tiles[0].rx;
  return (e, n) => {
    const fx = (e - res / 2) / res, fy = (n - res / 2) / res;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const c = (i, j) => at((x0 + i) * res + res / 2, (y0 + j) * res + res / 2);
    const v00 = c(0, 0), v10 = c(1, 0), v01 = c(0, 1), v11 = c(1, 1);
    const vals = [v00, v10, v01, v11];
    if (vals.some(Number.isNaN)) { const ok = vals.filter((v) => !Number.isNaN(v)); return ok.length ? ok.reduce((a, b) => a + b) / ok.length : NaN; }
    return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
  };
}

console.log('Gelände (DGM1) laden …');
const dgm = makeSampler(await loadRasterTiles(`${RAW_DIR}/dgm1`));
const H0 = Math.floor(dgm(ORIGIN.e, ORIGIN.n));
console.log('  H0 =', H0, 'm über NHN');

function writeHeightGrid(name, b, step) {
  const nx = Math.round((b.maxE - b.minE) / step) + 1;
  const ny = Math.round((b.maxN - b.minN) / step) + 1;
  const arr = new Uint16Array(nx * ny);
  let min = Infinity, max = -Infinity, holes = 0;
  // Zeile 0 = Norden (z = -size/2), Spalte 0 = Westen
  for (let j = 0; j < ny; j++) {
    const n = b.maxN - j * step;
    for (let i = 0; i < nx; i++) {
      let h = dgm(b.minE + i * step, n);
      if (Number.isNaN(h)) { h = H0; holes++; }
      min = Math.min(min, h); max = Math.max(max, h);
      arr[j * nx + i] = Math.round((h - H0 + 100) * 100); // cm, Versatz 100 m
    }
  }
  fs.writeFileSync(`${OUT_DIR}/${name}.bin`, Buffer.from(arr.buffer));
  console.log(`  ${name}: ${nx}x${ny}, Höhe ${min.toFixed(2)}–${max.toFixed(2)} m, Lücken ${holes}`);
  return { file: `${name}.bin`, nx, ny, step, size: [b.maxE - b.minE, b.maxN - b.minN], encoding: 'uint16 cm, y = v/100 - 100', min: min - H0, max: max - H0 };
}

const terrainCore = writeHeightGrid('terrain-core', CORE, 1);
const terrainOuter = writeHeightGrid('terrain-outer', OUTER, 8);

// ---------------------------------------------------------------- Vegetationshöhe (DOM1 - DGM1)
console.log('Oberflächenmodell (DOM1) → Objekthöhen …');
const dom = makeSampler(await loadRasterTiles(`${RAW_DIR}/dom1`));
{
  const n = CORE_SIZE + 1;
  const chm = Buffer.alloc(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const e = CORE.minE + i, nn = CORE.maxN - j;
    const d = dom(e, nn) - dgm(e, nn);
    chm[j * n + i] = Number.isNaN(d) ? 0 : Math.max(0, Math.min(255, Math.round(d * 10))); // dm
  }
  await sharp(chm, { raw: { width: n, height: n, channels: 1 } }).png({ compressionLevel: 9 }).toFile(`${OUT_DIR}/chm-core.png`);
  console.log('  chm-core.png geschrieben (Dezimeter, 0–25,5 m)');
}

// ---------------------------------------------------------------- Luftbild Kern (DOP20)
console.log('Luftbild (DOP20) Kerngebiet …');
const ORTHO_GRID = 3;                 // 3x3 Kacheln à 500 m
const ORTHO_TILE_M = CORE_SIZE / ORTHO_GRID;
const PX = 0.2;
const mosaicW = Math.round(CORE_SIZE / PX);
const mosaic = Buffer.alloc(mosaicW * mosaicW * 3);
for (const f of fs.readdirSync(`${RAW_DIR}/dop20`).filter((f) => f.endsWith('.tif'))) {
  const tiff = await fromFile(`${RAW_DIR}/dop20/${f}`);
  const img = await tiff.getImage(0);
  const [ox, oy] = img.getOrigin();
  const w = img.getWidth(), h = img.getHeight();
  // Überlappung in Weltkoordinaten
  const e0 = Math.max(ox, CORE.minE), e1 = Math.min(ox + w * PX, CORE.maxE);
  const n0 = Math.max(oy - h * PX, CORE.minN), n1 = Math.min(oy, CORE.maxN);
  if (e1 <= e0 || n1 <= n0) continue;
  const win = [Math.round((e0 - ox) / PX), Math.round((oy - n1) / PX), Math.round((e1 - ox) / PX), Math.round((oy - n0) / PX)];
  // DOP liegt als JPEG/YCbCr vor – readRGB rechnet korrekt in RGB um.
  const rgb = await img.readRGB({ window: win, interleave: true });
  const ww = win[2] - win[0], wh = win[3] - win[1];
  const dx = Math.round((e0 - CORE.minE) / PX), dy = Math.round((CORE.maxN - n1) / PX);
  for (let r = 0; r < wh; r++) {
    const src = Buffer.from(rgb.buffer, rgb.byteOffset + r * ww * 3, ww * 3);
    src.copy(mosaic, ((dy + r) * mosaicW + dx) * 3);
  }
  console.log('  ', f, 'Fenster', win.join(','));
}
// Vorschaubild des gesamten Kerns (unbearbeitet)
await sharp(mosaic, { raw: { width: mosaicW, height: mosaicW, channels: 3 } })
  .resize(3000, 3000).jpeg({ quality: 85 }).toFile(`${RAW_DIR}/ortho-core-preview.jpg`);
// Die Kacheln werden erst nach der Gebäudeanalyse geschrieben (Bereinigung der Dachbilder am Boden).
const orthoTiles = [];

// ---------------------------------------------------------------- Luftbild Rand
console.log('Luftbild Randgebiet …');
{
  const files = fs.readdirSync(`${RAW_DIR}/dop20-low`).filter((f) => f.endsWith('.png'));
  const keys = files.map((f) => f.replace('.png', '').split('_').map(Number));
  const minE = Math.min(...keys.map((k) => k[0])) * 1000, minN = Math.min(...keys.map((k) => k[1])) * 1000;
  const maxE = Math.max(...keys.map((k) => k[0])) * 1000 + 2000, maxN = Math.max(...keys.map((k) => k[1])) * 1000 + 2000;
  const res = 2000 / 1250;
  const W = Math.round((maxE - minE) / res), H = Math.round((maxN - minN) / res);
  const comps = files.map((f, idx) => ({
    input: `${RAW_DIR}/dop20-low/${f}`,
    left: Math.round((keys[idx][0] * 1000 - minE) / res),
    top: Math.round((maxN - (keys[idx][1] * 1000 + 2000)) / res),
  }));
  const full = await sharp({ create: { width: W, height: H, channels: 3, background: '#556b2f' } }).composite(comps).png().toBuffer();
  await sharp(full)
    .extract({ left: Math.round((OUTER.minE - minE) / res), top: Math.round((maxN - OUTER.maxN) / res), width: Math.round(OUTER_SIZE / res), height: Math.round(OUTER_SIZE / res) })
    .resize(2048, 2048, { kernel: 'lanczos3' }).webp({ quality: 80 }).toFile(`${OUT_DIR}/ortho/outer.webp`);
  console.log('  ortho/outer.webp geschrieben');
}

// ---------------------------------------------------------------- LoD2-Gebäude
console.log('LoD2-Gebäude …');
const L = (e, n, h) => [+(e - ORIGIN.e).toFixed(2), +(h - H0).toFixed(2), +(-(n - ORIGIN.n)).toFixed(2)];
const inCore = (e, n, m = 0) => e >= CORE.minE - m && e <= CORE.maxE + m && n >= CORE.minN - m && n <= CORE.maxN + m;
const buildings = new Map();
const attr = (s, name) => { const m = s.match(new RegExp(`name="${name}">\\s*<gen:value>([^<]*)<`)); return m ? m[1] : undefined; };
const tag = (s, t) => { const m = s.match(new RegExp(`<${t}[^>]*>([^<]*)</${t}>`)); return m ? m[1] : undefined; };
const parsePos = (txt) => { const v = txt.trim().split(/\s+/).map(Number); const out = []; for (let i = 0; i < v.length; i += 3) out.push([v[i], v[i + 1], v[i + 2]]); return out; };

for (const f of fs.readdirSync(`${RAW_DIR}/lod2`).filter((f) => f.endsWith('.gml'))) {
  const s = fs.readFileSync(`${RAW_DIR}/lod2/${f}`, 'utf8');
  const chunks = s.split(/<bldg:Building gml:id="/).slice(1);
  for (const chunk of chunks) {
    const id = chunk.slice(0, chunk.indexOf('"'));
    if (buildings.has(id)) continue;
    const head = chunk.split('<bldg:boundedBy>')[0];
    const b = {
      id,
      fn: tag(head, 'bldg:function'),
      roof: tag(head, 'bldg:roofType'),
      roofName: attr(head, 'DachtypName'),
      h: +tag(head, 'bldg:measuredHeight') || undefined,
      ridge: +attr(head, 'Firsthoehe') - H0 || undefined,
      eave: +attr(head, 'MittlereTraufHoehe') - H0 || undefined,
      ground: +attr(head, 'AbsoluteHoehe') - H0 || undefined,
      surfaces: [],
    };
    let inside = false;
    const re = /<bldg:(WallSurface|RoofSurface|GroundSurface|ClosureSurface)[\s\S]*?<\/bldg:\1>/g;
    let m;
    while ((m = re.exec(chunk))) {
      const type = { WallSurface: 'W', RoofSurface: 'R', GroundSurface: 'G', ClosureSurface: 'C' }[m[1]];
      const polyRe = /<gml:Polygon[\s\S]*?<\/gml:Polygon>/g;
      let p;
      while ((p = polyRe.exec(m[0]))) {
        const rings = [];
        const ringRe = /<gml:(exterior|interior)>[\s\S]*?<gml:posList[^>]*>([^<]*)<\/gml:posList>/g;
        let r;
        while ((r = ringRe.exec(p[0]))) {
          const pts = parsePos(r[2]);
          if (pts.length > 1 && pts[0].every((v, k) => v === pts[pts.length - 1][k])) pts.pop();
          if (pts.some(([e, n]) => inCore(e, n))) inside = true;
          rings.push(pts.flatMap(([e, n, h]) => L(e, n, h)));
        }
        if (rings.length && rings[0].length >= 9) b.surfaces.push({ t: type, r: rings });
      }
    }
    for (const k of ['ridge', 'eave', 'ground']) if (b[k] !== undefined) b[k] = +b[k].toFixed(2);
    if (inside && b.surfaces.length) buildings.set(id, b);
  }
}
// Neubauten, die nur in OpenStreetMap erfasst sind (z. B. Kindergarten), ergänzen
{
  const osmRaw = JSON.parse(fs.readFileSync(`${RAW_DIR}/osm/osm.json`, 'utf8'));
  const loc = (c) => { const [e, n] = toUTM(c.lon, c.lat); return [e - ORIGIN.e, -(n - ORIGIN.n)]; };
  const feats = osmRaw.elements.filter((el) => el.type === 'way' && el.geometry && el.tags?.building).map((el) => ({
    type: 'way', id: el.id, tags: el.tags, g: el.geometry.map(loc),
  }));
  const tagged = osmRaw.elements.filter((el) => el.tags && (el.type === 'node' || (el.type === 'way' && el.geometry))).map((el) => ({
    type: el.type, id: el.id, tags: el.tags, p: el.type === 'node' ? loc(el) : undefined, g: el.geometry ? el.geometry.map(loc) : undefined,
  }));
  console.log(`   OSM-Angaben an ${attachOsmTags(tagged, [...buildings.values()])} Gebäude übertragen`);
  const half = CORE_SIZE / 2;
  const extra = synthesizeMissingBuildings(feats, [...buildings.values()], (x, z) => dgm(ORIGIN.e + x, ORIGIN.n - z) - H0, (x, z) => Math.abs(x) < half && Math.abs(z) < half);
  for (const b of extra) buildings.set(b.id, b);
  console.log(`   ${extra.length} Gebäude aus OpenStreetMap ergänzt:`, extra.map((b) => `${b.id}${b.name ? ' ' + b.name : ''} (${b.roofName})`).join(', '));
}
fs.writeFileSync(`${OUT_DIR}/buildings.json`, JSON.stringify([...buildings.values()]));
console.log('  ', buildings.size, 'Gebäude →', (fs.statSync(`${OUT_DIR}/buildings.json`).size / 1e6).toFixed(1), 'MB');

// ---------------------------------------------------------------- Luftbild bereinigen
// Das Luftbild ist kein „echtes“ Orthophoto: Dächer erscheinen je nach Höhe und Lage zur Kamera
// um einige Meter verschoben. Im 3D-Modell stehen die Gebäude jetzt selbst – deshalb werden die
// Bereiche um die Grundrisse mit der umgebenden Bodenfarbe aufgefüllt (Push-Pull-Verfahren).
console.log('Luftbild bereinigen (Dachbilder am Boden) …');
const MASK_SCALE = 1 / PX; // Pixel pro Meter
let buildingMask1m;        // Maske im 1-m-Raster für die Vegetationserkennung
{
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${mosaicW}" height="${mosaicW}"><g fill="#fff" stroke="#fff" stroke-linejoin="round">`;
  for (const b of buildings.values()) {
    let top = -Infinity, bottom = Infinity;
    for (const s of b.surfaces) for (const r of s.r) for (let k = 1; k < r.length; k += 3) { top = Math.max(top, r[k]); bottom = Math.min(bottom, r[k]); }
    const buf = Math.min(6, Math.max(1.8, 1.2 + 0.24 * (top - bottom)));
    for (const s of b.surfaces) if (s.t === 'G') {
      const r = s.r[0]; const pts = [];
      for (let k = 0; k < r.length; k += 3) pts.push(`${((r[k] + CORE_SIZE / 2) * MASK_SCALE).toFixed(1)},${((r[k + 2] + CORE_SIZE / 2) * MASK_SCALE).toFixed(1)}`);
      svg += `<polygon stroke-width="${(2 * buf * MASK_SCALE).toFixed(1)}" points="${pts.join(' ')}"/>`;
    }
  }
  svg += '</g></svg>';
  const mask = await sharp(Buffer.from(svg), { limitInputPixels: false })
    .flatten({ background: '#000000' }).extractChannel(0).raw().toBuffer();
  if (mask.length !== mosaicW * mosaicW) throw new Error('Maskengröße unerwartet: ' + mask.length);
  { let c = 0; for (let i = 0; i < mask.length; i += 7) if (mask[i] > 127) c++; console.log(`  maskierter Anteil: ${((c * 7 / mask.length) * 100).toFixed(1)} %`); }
  // weiche Kante
  const soft = await sharp(mask, { raw: { width: mosaicW, height: mosaicW, channels: 1 } }).blur(3).extractChannel(0).raw().toBuffer();
  console.log(`  weiche Maske: ${soft.length === mask.length ? 'ok' : 'Größe ' + soft.length}`);
  buildingMask1m = await sharp(mask, { raw: { width: mosaicW, height: mosaicW, channels: 1 } }).resize(CORE_SIZE, CORE_SIZE, { kernel: 'cubic' }).raw().toBuffer();

  // 1) Verkleinern (8×8-Blöcke), maskierte Pixel ausgelassen
  const F = 8, w = Math.ceil(mosaicW / F);
  let lv = { w, h: w, c: new Float32Array(w * w * 3), a: new Float32Array(w * w) };
  for (let y = 0; y < mosaicW; y++) for (let x = 0; x < mosaicW; x++) {
    // nur sicher unmaskierte Pixel (auch außerhalb der weichen Kante) als Quelle verwenden
    if (soft[y * mosaicW + x] > 0) continue;
    const m = 1;
    const k = Math.floor(y / F) * w + Math.floor(x / F), s = (y * mosaicW + x) * 3;
    lv.c[k * 3] += mosaic[s] * m; lv.c[k * 3 + 1] += mosaic[s + 1] * m; lv.c[k * 3 + 2] += mosaic[s + 2] * m;
    lv.a[k] += m;
  }
  for (let k = 0; k < w * w; k++) if (lv.a[k] > 0) { lv.c[k * 3] /= lv.a[k]; lv.c[k * 3 + 1] /= lv.a[k]; lv.c[k * 3 + 2] /= lv.a[k]; lv.a[k] = Math.min(1, lv.a[k] / (F * F * 0.9)); }
  // 2) Push-Pull: Pyramide nach unten, dann Lücken von grob nach fein füllen
  const levels = [lv];
  while (lv.w > 1) {
    const nw = Math.ceil(lv.w / 2), nh = Math.ceil(lv.h / 2);
    const nl = { w: nw, h: nh, c: new Float32Array(nw * nh * 3), a: new Float32Array(nw * nh) };
    for (let y = 0; y < lv.h; y++) for (let x = 0; x < lv.w; x++) {
      const k = y * lv.w + x, a = lv.a[k]; if (!a) continue;
      const q = (y >> 1) * nw + (x >> 1);
      nl.c[q * 3] += lv.c[k * 3] * a; nl.c[q * 3 + 1] += lv.c[k * 3 + 1] * a; nl.c[q * 3 + 2] += lv.c[k * 3 + 2] * a; nl.a[q] += a;
    }
    for (let q = 0; q < nw * nh; q++) if (nl.a[q] > 0) { nl.c[q * 3] /= nl.a[q]; nl.c[q * 3 + 1] /= nl.a[q]; nl.c[q * 3 + 2] /= nl.a[q]; nl.a[q] = Math.min(1, nl.a[q]); }
    levels.push(nl); lv = nl;
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l], c = levels[l + 1];
    // bilinear aus der gröberen Stufe interpolieren (vermeidet Blockmuster)
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const k = y * f.w + x, a = f.a[k];
      if (a >= 1) continue;
      const cx = Math.min(c.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), cy = Math.min(c.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.min(c.w - 1, x0 + 1), y1 = Math.min(c.h - 1, y0 + 1);
      const tx = cx - x0, ty = cy - y0;
      for (let ch = 0; ch < 3; ch++) {
        const v = (c.c[(y0 * c.w + x0) * 3 + ch] * (1 - tx) + c.c[(y0 * c.w + x1) * 3 + ch] * tx) * (1 - ty)
                + (c.c[(y1 * c.w + x0) * 3 + ch] * (1 - tx) + c.c[(y1 * c.w + x1) * 3 + ch] * tx) * ty;
        f.c[k * 3 + ch] = f.c[k * 3 + ch] * a + v * (1 - a);
      }
      f.a[k] = 1;
    }
  }
  const small = Buffer.alloc(w * w * 3);
  for (let i = 0; i < small.length; i++) small[i] = Math.round(levels[0].c[i]);
  const fill = await sharp(small, { raw: { width: w, height: w, channels: 3 } }).resize(mosaicW, mosaicW, { kernel: 'cubic' }).raw().toBuffer();
  // 3) Zusammensetzen – mit etwas Struktur, damit die Flächen nicht künstlich glatt wirken
  const r = (() => { let s = 99; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
  for (let p = 0; p < mosaicW * mosaicW; p++) {
    const m = soft[p] / 255; if (m <= 0) continue;
    const n = (r() - 0.5) * 14;
    for (let ch = 0; ch < 3; ch++) mosaic[p * 3 + ch] = Math.max(0, Math.min(255, Math.round(mosaic[p * 3 + ch] * (1 - m) + (fill[p * 3 + ch] + n) * m)));
  }
}
{
  const tilePx = mosaicW / ORTHO_GRID;
  for (let j = 0; j < ORTHO_GRID; j++) for (let i = 0; i < ORTHO_GRID; i++) {
    const buf = await sharp(mosaic, { raw: { width: mosaicW, height: mosaicW, channels: 3 } })
      .extract({ left: i * tilePx, top: j * tilePx, width: tilePx, height: tilePx }).raw().toBuffer();
    for (const [suffix, size] of [['hi', 2048], ['lo', 1024]]) {
      await sharp(buf, { raw: { width: tilePx, height: tilePx, channels: 3 } })
        .resize(size, size, { kernel: 'lanczos3' }).webp({ quality: 82 })
        .toFile(`${OUT_DIR}/ortho/core_${i}_${j}_${suffix}.webp`);
    }
    orthoTiles.push({ i, j, file: `ortho/core_${i}_${j}_{q}.webp` });
  }
  await sharp(mosaic, { raw: { width: mosaicW, height: mosaicW, channels: 3 } })
    .resize(3000, 3000).jpeg({ quality: 85 }).toFile(`${RAW_DIR}/ortho-core-clean-preview.jpg`);
  console.log('  9 Kacheln × 2 Qualitätsstufen geschrieben');
}

// ---------------------------------------------------------------- Bäume & Büsche (aus DOM1 − DGM1)
console.log('Vegetation erkennen …');
{
  const N = CORE_SIZE + 1;
  const chm = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const e = CORE.minE + i, nn = CORE.maxN - j;
    const d = dom(e, nn) - dgm(e, nn);
    chm[j * N + i] = Number.isNaN(d) ? 0 : Math.max(0, d);
  }
  // 3×3-Glättung
  const sm = new Float32Array(N * N);
  for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) {
    let s = 0; for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) s += chm[(j + b) * N + i + a];
    sm[j * N + i] = s / 9;
  }
  // Farbe im 1-m-Raster (Original-Luftbild ist hier bereits bereinigt – Vegetation liegt außerhalb der Masken)
  const col = await sharp(mosaic, { raw: { width: mosaicW, height: mosaicW, channels: 3 } }).resize(CORE_SIZE, CORE_SIZE, { kernel: 'cubic' }).raw().toBuffer();
  const colorAt = (i, j) => { const ii = Math.min(CORE_SIZE - 1, i), jj = Math.min(CORE_SIZE - 1, j); const k = (jj * CORE_SIZE + ii) * 3; return [col[k], col[k + 1], col[k + 2]]; };
  const isBuilding = (i, j) => buildingMask1m[Math.min(CORE_SIZE - 1, j) * CORE_SIZE + Math.min(CORE_SIZE - 1, i)] > 40;
  const isGreen = (i, j) => {
    // Vegetation: Grün dominiert oder sehr dunkel (Schatten im Kronendach)
    const [r, g, b] = colorAt(i, j);
    const lum = 0.3 * r + 0.59 * g + 0.11 * b;
    return (g >= r * 0.97 && g >= b * 0.95 && lum < 170) || (lum < 45 && b < g * 1.25);
  };
  const L = (i, j) => [i - CORE_SIZE / 2, j - CORE_SIZE / 2];
  const groundAtIJ = (i, j) => dgm(CORE.minE + i, CORE.maxN - j) - H0;

  const trees = [];
  const taken = new Uint8Array(N * N);
  for (let j = 3; j < N - 3; j++) for (let i = 3; i < N - 3; i++) {
    const h = sm[j * N + i];
    if (h < 3.0) continue;
    const rad = Math.round(Math.min(3.5, Math.max(1.5, 1.2 + 0.1 * h)));
    let isMax = true;
    for (let b = -rad; b <= rad && isMax; b++) for (let a = -rad; a <= rad; a++) {
      if ((a || b) && a * a + b * b <= rad * rad) {
        const v = sm[(j + b) * N + i + a];
        if (v > h || (v === h && (b < 0 || (b === 0 && a < 0)))) { isMax = false; break; }
      }
    }
    if (!isMax || isBuilding(i, j) || !isGreen(i, j) || taken[j * N + i]) continue;
    // Kronenradius: in 8 Richtungen bis die Höhe deutlich abfällt
    let rs = 0;
    for (let d = 0; d < 8; d++) {
      const ang = (d / 8) * Math.PI * 2, dx = Math.cos(ang), dy = Math.sin(ang);
      let s = 1;
      for (; s < 9; s++) {
        const ii = Math.round(i + dx * s), jj = Math.round(j + dy * s);
        if (ii < 0 || jj < 0 || ii >= N || jj >= N || sm[jj * N + ii] < Math.max(1.5, h * 0.55)) break;
      }
      rs += s;
    }
    const cr = Math.min(7.5, Math.max(1.2, rs / 8));
    const [x, z] = L(i, j);
    const [cr0, cg0, cb0] = colorAt(i, j);
    const darkBlue = cb0 > cr0 * 0.95 && (cr0 + cg0 + cb0) < 150;
    const conifer = cr / h < 0.2 || (darkBlue && cr / h < 0.3) ? 1 : 0;
    trees.push(+x.toFixed(1), +z.toFixed(1), +groundAtIJ(i, j).toFixed(2), +h.toFixed(1), +cr.toFixed(1), conifer);
    // Kronenbereich als belegt markieren (verhindert Büsche unter Bäumen)
    const R = Math.ceil(cr);
    for (let b = -R; b <= R; b++) for (let a = -R; a <= R; a++) {
      const jj = j + b, ii = i + a;
      if (jj >= 0 && ii >= 0 && jj < N && ii < N && a * a + b * b <= R * R) taken[jj * N + ii] = 1;
    }
  }
  // Büsche/Hecken: niedrige Vegetation auf einem 2-m-Raster
  const bushes = [];
  for (let j = 1; j < N - 1; j += 2) for (let i = 1; i < N - 1; i += 2) {
    const h = sm[j * N + i];
    if (h < 0.7 || h >= 3.0 || taken[j * N + i] || isBuilding(i, j) || !isGreen(i, j)) continue;
    const [x, z] = L(i, j);
    bushes.push(+x.toFixed(1), +z.toFixed(1), +groundAtIJ(i, j).toFixed(2), +h.toFixed(1));
  }
  fs.writeFileSync(`${OUT_DIR}/vegetation.json`, JSON.stringify({ trees: { stride: 6, fields: 'x,z,groundY,height,crownRadius,conifer', data: trees }, bushes: { stride: 4, fields: 'x,z,groundY,height', data: bushes } }));
  console.log(`  ${trees.length / 6} Bäume, ${bushes.length / 4} Busch-/Heckenpunkte → ${(fs.statSync(`${OUT_DIR}/vegetation.json`).size / 1e6).toFixed(1)} MB`);
}

// ---------------------------------------------------------------- OpenStreetMap
console.log('OpenStreetMap …');
const osm = JSON.parse(fs.readFileSync(`${RAW_DIR}/osm/osm.json`, 'utf8'));
const P = (lat, lon) => { const [e, n] = toUTM(lon, lat); return [+(e - ORIGIN.e).toFixed(2), +(-(n - ORIGIN.n)).toFixed(2)]; };
const feats = [];
for (const el of osm.elements) {
  const f = { type: el.type, id: el.id, tags: el.tags || {} };
  if (el.type === 'node') f.p = P(el.lat, el.lon);
  else if (el.type === 'way' && el.geometry) f.g = el.geometry.map((c) => P(c.lat, c.lon));
  else if (el.type === 'relation' && el.members) {
    f.m = el.members.filter((m) => m.geometry).map((m) => ({ role: m.role, g: m.geometry.map((c) => P(c.lat, c.lon)) }));
  } else continue;
  feats.push(f);
}
fs.writeFileSync(`${OUT_DIR}/osm.json`, JSON.stringify(feats));
console.log('  ', feats.length, 'Objekte →', (fs.statSync(`${OUT_DIR}/osm.json`).size / 1e6).toFixed(1), 'MB');

// ---------------------------------------------------------------- Wichtige Orte
const findOsm = (type, id) => feats.find((f) => f.type === type && f.id === id);
const centerOf = (f) => {
  if (f.p) return f.p;
  const g = f.g || f.m.flatMap((m) => m.g);
  return [g.reduce((a, c) => a + c[0], 0) / g.length, g.reduce((a, c) => a + c[1], 0) / g.length];
};
const POIS = [
  ['dorfladen', 'Dorfladen „Dorfmarkt & Landstube“', 'node', 10673112834],
  ['gasthaus', 'Lüdekes Gasthaus „Zum Hombachtal“', 'way', 301069386],
  ['schule', 'Grundschule Nordwohlde', 'way', 474603989],
  ['feuerwehr', 'Freiwillige Feuerwehr Nordwohlde', 'way', 474603977],
  ['sporthalle', 'Sporthalle', 'way', 760746265],
  ['sportplatz', 'Sportplatz TV Einigkeit Nordwohlde', 'way', 474573671],
  ['kirche', 'Nordwohlder Kirche', 'way', 337731474],
];
const pois = [];
for (const [key, name, type, id] of POIS) {
  const f = findOsm(type, id);
  if (!f) { console.warn('  POI nicht gefunden:', key); continue; }
  const [x, z] = centerOf(f);
  pois.push({ key, name, x: +x.toFixed(1), z: +z.toFixed(1), y: +(dgm(ORIGIN.e + x, ORIGIN.n - z) - H0).toFixed(2), osm: `${type}/${id}` });
}
// B51: Mittelpunkt des nächstgelegenen Abschnitts
{
  const b51 = feats.filter((f) => f.g && /B 51/.test(f.tags.ref || ''));
  let best = null;
  for (const f of b51) for (const [x, z] of f.g) { const d = Math.hypot(x, z); if (!best || d < best.d) best = { d, x, z }; }
  if (best) pois.push({ key: 'b51', name: 'Bundesstraße B51', x: +best.x.toFixed(1), z: +best.z.toFixed(1), y: +(dgm(ORIGIN.e + best.x, ORIGIN.n - best.z) - H0).toFixed(2) });
}

// ---------------------------------------------------------------- Szenen-Metadaten
const scene = {
  origin: { epsg: 25832, e: ORIGIN.e, n: ORIGIN.n, h0: H0 },
  core: { size: CORE_SIZE, terrain: terrainCore, ortho: { grid: ORTHO_GRID, tileSize: ORTHO_TILE_M, tiles: orthoTiles, qualities: { hi: 2048, lo: 1024 } }, chm: { file: 'chm-core.png', encoding: 'uint8 dm', res: 1 } },
  outer: { size: OUTER_SIZE, terrain: terrainOuter, ortho: 'ortho/outer.webp' },
  buildings: 'buildings.json',
  vegetation: 'vegetation.json',
  osm: 'osm.json',
  pois,
  sources: {
    lgln: { text: 'Geobasisdaten: LGLN (2026), Lizenz CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', dop: Object.values(rawMeta.tiles).filter((t) => t && t.Aktualitaet).map((t) => t.Aktualitaet).filter((v, i, a) => a.indexOf(v) === i) },
    osm: { text: '© OpenStreetMap-Mitwirkende, ODbL', url: 'https://www.openstreetmap.org/copyright' },
  },
  built: new Date().toISOString(),
};
fs.writeFileSync(`${OUT_DIR}/scene.json`, JSON.stringify(scene, null, 2));
console.log('scene.json geschrieben. POIs:', pois.map((p) => `${p.key}(${p.x},${p.z})`).join(' '));
