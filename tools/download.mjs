// Lädt alle Rohdaten für das Gebiet herunter (LGLN OpenGeoData + OpenStreetMap).
// Aufruf: npm run data:download
import fs from 'node:fs';
import path from 'node:path';
import { fromUrl } from 'geotiff';
import sharp from 'sharp';
import { CORE, OUTER, RAW_DIR, toWGS } from './config.mjs';

const UA = { 'User-Agent': 'nordwohlde-3d/0.1 (data preparation)' };

const tilesFor = (b) => {
  const out = [];
  for (let e = Math.floor(b.minE / 1000); e <= Math.floor((b.maxE - 1) / 1000); e++)
    for (let n = Math.floor(b.minN / 1000); n <= Math.floor((b.maxN - 1) / 1000); n++) out.push({ e, n });
  return out;
};
const coreTiles = tilesFor(CORE);
const outerTiles = tilesFor(OUTER);
const key = (t) => `${t.e}_${t.n}`;

// Index laden: neueste Version je Kachel.
function loadIndex(name, urlProp) {
  const j = JSON.parse(fs.readFileSync(path.join(RAW_DIR, 'index', `${name}.geojson`), 'utf8'));
  const map = new Map();
  for (const f of j.features) {
    const [e, n] = f.geometry.coordinates[0].reduce(
      (a, c) => [Math.min(a[0], c[0]), Math.min(a[1], c[1])], [Infinity, Infinity]);
    const k = `${Math.round(e / 1000)}_${Math.round(n / 1000)}`;
    const prev = map.get(k);
    if (!prev || f.properties.Aktualitaet > prev.Aktualitaet) map.set(k, { url: f.properties[urlProp], Aktualitaet: f.properties.Aktualitaet });
  }
  return map;
}

async function download(url, file, retries = 3) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return console.log('  vorhanden', path.basename(file));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      return console.log('  geladen', path.basename(file), (fs.statSync(file).size / 1e6).toFixed(1), 'MB');
    } catch (e) {
      console.warn('  Fehler', url, e.message, i < retries - 1 ? '– neuer Versuch' : '');
      if (i === retries - 1) throw e;
    }
  }
}

const meta = { tiles: {}, sources: {} };

// 1) DGM1 (Gelände) – ganzer Außenbereich, 1 m Raster
console.log('DGM1');
const dgm = loadIndex('dgm1', 'dgm1');
for (const t of outerTiles) {
  const it = dgm.get(key(t)); if (!it) { console.warn('  fehlt', key(t)); continue; }
  await download(it.url, `${RAW_DIR}/dgm1/${key(t)}.tif`);
  meta.tiles[`dgm1_${key(t)}`] = it.Aktualitaet;
}

// 2) DOM1 (Oberfläche inkl. Bäume) – Kerngebiet
console.log('DOM1');
const dom = loadIndex('dom1', 'dom1');
for (const t of coreTiles) {
  const it = dom.get(key(t)); if (!it) { console.warn('  fehlt', key(t)); continue; }
  await download(it.url, `${RAW_DIR}/dom1/${key(t)}.tif`);
  meta.tiles[`dom1_${key(t)}`] = it.Aktualitaet;
}

// DOP-Kacheln sind hier 2 km groß und in mehreren Jahrgängen vorhanden:
// alle Kacheln, die ein Gebiet schneiden, jeweils neuester Jahrgang.
function dopTiles(b) {
  const j = JSON.parse(fs.readFileSync(path.join(RAW_DIR, 'index', 'dop20.geojson'), 'utf8'));
  const map = new Map();
  for (const f of j.features) {
    const c = f.geometry.coordinates[0];
    const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
    const t = { minE: Math.min(...xs), maxE: Math.max(...xs), minN: Math.min(...ys), maxN: Math.max(...ys) };
    if (t.maxE <= b.minE || t.minE >= b.maxE || t.maxN <= b.minN || t.minN >= b.maxN) continue;
    const k = `${t.minE / 1000}_${t.minN / 1000}`;
    const prev = map.get(k);
    if (!prev || f.properties.Aktualitaet > prev.Aktualitaet)
      map.set(k, { key: k, ...t, url: f.properties.rgb, Aktualitaet: f.properties.Aktualitaet });
  }
  return [...map.values()];
}

// 3) DOP20 (Luftbild) – Kerngebiet in voller Auflösung
console.log('DOP20 Kern');
const dopCore = dopTiles(CORE);
for (const it of dopCore) {
  await download(it.url, `${RAW_DIR}/dop20/${it.key}.tif`);
  meta.tiles[`dop20_${it.key}`] = { ...it, url: undefined };
}

// 4) DOP20 Außenbereich – nur eine Übersichtsstufe (ca. 1,6 m/px) per HTTP-Range aus dem COG
console.log('DOP20 Rand (Übersicht)');
for (const it of dopTiles(OUTER)) {
  const file = `${RAW_DIR}/dop20-low/${it.key}.png`;
  meta.tiles[`dop20low_${it.key}`] = { ...it, url: undefined };
  if (fs.existsSync(file)) { console.log('  vorhanden', path.basename(file)); continue; }
  const tiff = await fromUrl(it.url, { headers: UA });
  const n = await tiff.getImageCount();
  let img = null;
  for (let i = 0; i < n; i++) {
    const c = await tiff.getImage(i);
    if (c.getSamplesPerPixel() >= 3 && c.getWidth() >= 1200 && (!img || c.getWidth() < img.getWidth())) img = c;
  }
  const w = img.getWidth(), h = img.getHeight();
  // DOP liegt als JPEG/YCbCr vor – readRGB rechnet korrekt in RGB um.
  const rgb = await img.readRGB({ interleave: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength), { raw: { width: w, height: h, channels: 3 } }).png().toFile(file);
  console.log('  geladen', path.basename(file), `${w}x${h}`);
}

// 5) LoD2-Gebäude (CityGML) – Kerngebiet
console.log('LoD2');
for (const t of coreTiles) {
  await download(`https://lod2.s3.eu-de.cloud-object-storage.appdomain.cloud/LoD2_32_${t.e}_${t.n}_1_ni.gml`, `${RAW_DIR}/lod2/${key(t)}.gml`);
}

// 6) OpenStreetMap – Außenbereich
console.log('OSM');
const osmFile = `${RAW_DIR}/osm/osm.json`;
if (!fs.existsSync(osmFile)) {
  const [w, s] = toWGS(OUTER.minE, OUTER.minN);
  const [e, nn] = toWGS(OUTER.maxE, OUTER.maxN);
  const bb = `${s},${w},${nn},${e}`;
  const q = `[out:json][timeout:180];(
    way["highway"](${bb});
    nwr["building"](${bb});
    nwr["landuse"](${bb}); nwr["natural"](${bb}); nwr["leisure"](${bb});
    nwr["amenity"](${bb}); nwr["shop"](${bb}); nwr["barrier"](${bb});
    nwr["waterway"](${bb}); nwr["man_made"](${bb}); nwr["highway"~"street_lamp|bus_stop"](${bb});
    node["traffic_sign"](${bb}); node["power"](${bb}); way["power"](${bb});
    way["railway"](${bb});
  );out geom tags;`;
  const r = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST', headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(q),
  });
  if (!r.ok) throw new Error('Overpass HTTP ' + r.status);
  fs.mkdirSync(path.dirname(osmFile), { recursive: true });
  fs.writeFileSync(osmFile, await r.text());
  console.log('  geladen osm.json', (fs.statSync(osmFile).size / 1e6).toFixed(1), 'MB');
} else console.log('  vorhanden osm.json');

meta.downloaded = new Date().toISOString();
fs.writeFileSync(`${RAW_DIR}/meta.json`, JSON.stringify(meta, null, 2));
console.log('Fertig.');
