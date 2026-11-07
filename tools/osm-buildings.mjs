// Ergänzt Gebäude, die in OpenStreetMap vorhanden sind, aber (noch) nicht in den LoD2-Daten des LGLN
// (z. B. Neubauten). Erzeugt LoD2-ähnliche Flächen (Wände, Dach, Grund), damit sie im Browser wie alle
// anderen Gebäude behandelt werden.

const area2 = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length]; a += x1 * z2 - x2 * z1; } return a / 2; };

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Kleinstes umschließendes Rechteck → Mittelpunkt, Achsen, Halbmaße. */
function minRect(pts) {
  const hull = convexHull(pts);
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const [x1, z1] = hull[i], [x2, z2] = hull[(i + 1) % hull.length];
    const l = Math.hypot(x2 - x1, z2 - z1); if (l < 1e-6) continue;
    const ux = (x2 - x1) / l, uz = (z2 - z1) / l, vx = -uz, vz = ux;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, z] of hull) { const a = x * ux + z * uz, b = x * vx + z * vz; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
    const area = (a1 - a0) * (b1 - b0);
    if (!best || area < best.area) best = { area, ux, uz, vx, vz, a0, a1, b0, b1 };
  }
  const { ux, uz, vx, vz, a0, a1, b0, b1 } = best;
  const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
  let r = { cx: ux * ca + vx * cb, cz: uz * ca + vz * cb, ux, uz, vx, vz, ha: (a1 - a0) / 2, hb: (b1 - b0) / 2, area: best.area };
  if (r.hb > r.ha) r = { ...r, ux: vx, uz: vz, vx: -ux, vz: -uz, ha: r.hb, hb: r.ha }; // u = Längsachse
  return r;
}

/**
 * Überträgt beschreibende OSM-Angaben (Name, Fassadenfarbe, Material, Nutzung) auf die Gebäude,
 * deren Grundriss den OSM-Mittelpunkt bzw. -Punkt enthält.
 */
export function attachOsmTags(osmFeatures, buildings) {
  const KEYS = ['name', 'building', 'building:colour', 'building:material', 'roof:colour', 'roof:material', 'amenity', 'shop', 'leisure', 'building:levels'];
  const polys = [];
  for (const b of buildings) for (const s of b.surfaces) if (s.t === 'G') {
    const r = s.r[0], poly = [];
    for (let k = 0; k < r.length; k += 3) poly.push([r[k], r[k + 2]]);
    polys.push({ b, poly });
  }
  let n = 0;
  for (const f of osmFeatures) {
    const t = f.tags || {};
    if (!KEYS.some((k) => t[k]) || t.highway || t.landuse || t.natural) continue;
    let x, z;
    if (f.p) [x, z] = f.p;
    else if (f.g && (t.building || t.amenity || t.shop)) { const g = f.g.slice(0, -1); x = g.reduce((s, p) => s + p[0], 0) / g.length; z = g.reduce((s, p) => s + p[1], 0) / g.length; }
    else continue;
    const hit = polys.find((p) => pointInPoly(x, z, p.poly));
    if (!hit) continue;
    hit.b.osm = hit.b.osm || {};
    for (const k of KEYS) if (t[k] && !(k === 'building' && t[k] === 'yes')) hit.b.osm[k] = t[k];
    n++;
  }
  return n;
}

/**
 * @param osmFeatures  OSM-Objekte in Szenenkoordinaten (x, z)
 * @param lod2         Liste der LoD2-Gebäude (mit Grundflächen)
 * @param groundAt     (x, z) → Geländehöhe (Szene)
 * @param inCore       (x, z) → boolean
 */
export function synthesizeMissingBuildings(osmFeatures, lod2, groundAt, inCore) {
  // LoD2-Grundrisse + Rasterindex
  const foot = [];
  for (const b of lod2) for (const s of b.surfaces) if (s.t === 'G') {
    const r = s.r[0], poly = [];
    for (let k = 0; k < r.length; k += 3) poly.push([r[k], r[k + 2]]);
    foot.push(poly);
  }
  const CELL = 25, grid = new Map();
  foot.forEach((poly, i) => {
    const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
    for (let gx = Math.floor(Math.min(...xs) / CELL); gx <= Math.floor(Math.max(...xs) / CELL); gx++)
      for (let gz = Math.floor(Math.min(...zs) / CELL); gz <= Math.floor(Math.max(...zs) / CELL); gz++) {
        const k = `${gx},${gz}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
      }
  });
  const covered = (x, z) => (grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) || []).some((i) => pointInPoly(x, z, foot[i]));

  const out = [];
  for (const f of osmFeatures) {
    const t = f.tags;
    if (!t.building || f.type !== 'way' || !f.g || f.g.length < 4) continue;
    if (/^(roof|carport|construction|ruins)$/.test(t.building)) continue;
    let poly = f.g.slice(0, -1);
    const a = area2(poly);
    if (Math.abs(a) < 15) continue;
    const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length, cz = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    if (!inCore(cx, cz)) continue;
    // Stichproben: Mittelpunkt + Ecken (zur Mitte gezogen)
    const samples = [[cx, cz], ...poly.map(([x, z]) => [x + (cx - x) * 0.3, z + (cz - z) * 0.3])];
    const hit = samples.filter(([x, z]) => covered(x, z)).length / samples.length;
    if (hit > 0.3) continue;

    // Höhen
    const levels = +t['building:levels'] || (/house|residential|detached|kindergarten|school/.test(t.building) || t.amenity ? 1 : 1);
    const eaveRel = +t.height ? +t.height - (+t['roof:height'] || 0) : levels * 3.0 + 0.4;
    const ground = Math.min(...poly.map(([x, z]) => groundAt(x, z)));
    const eave = ground + eaveRel;
    const rect = minRect(poly);
    const rectish = Math.abs(a) / rect.area > 0.82;
    let shape = t['roof:shape'] || (rectish && rect.hb > 2.5 ? (rect.ha / rect.hb < 1.35 ? 'hipped' : 'gabled') : 'flat');
    if (!rectish) shape = 'flat';
    const roofH = +t['roof:height'] || (shape === 'flat' ? 0 : Math.min(7, rect.hb * Math.tan((40 * Math.PI) / 180)));

    const surfaces = [];
    const P = (x, y, z) => [+x.toFixed(2), +y.toFixed(2), +z.toFixed(2)];
    const ring = (pts) => pts.flat();
    if (shape === 'flat') {
      // Grundriss gegen den Uhrzeigersinn (von oben) für nach außen zeigende Wände
      if (a < 0) poly = poly.slice().reverse();
      for (let i = 0; i < poly.length; i++) {
        const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % poly.length];
        surfaces.push({ t: 'W', r: [ring([P(x1, ground, z1), P(x2, ground, z2), P(x2, eave, z2), P(x1, eave, z1)])] });
      }
      surfaces.push({ t: 'R', r: [ring(poly.map(([x, z]) => P(x, eave, z)))] });
      surfaces.push({ t: 'G', r: [ring(poly.slice().reverse().map(([x, z]) => P(x, ground, z)))] });
    } else {
      // Rechteck-Gebäude mit Sattel- oder Walmdach
      const { cx: rx, cz: rz, ux, uz, vx, vz, ha, hb } = rect;
      const C = (sa, sb) => [rx + ux * ha * sa + vx * hb * sb, rz + uz * ha * sa + vz * hb * sb];
      let corners = [C(-1, -1), C(1, -1), C(1, 1), C(-1, 1)];
      if (area2(corners) < 0) corners = [C(-1, -1), C(-1, 1), C(1, 1), C(1, -1)];
      const ridgeY = eave + roofH;
      const inset = shape === 'hipped' ? Math.min(ha * 0.9, hb) : 0;
      const R1 = [rx - ux * (ha - inset), rz - uz * (ha - inset)], R2 = [rx + ux * (ha - inset), rz + uz * (ha - inset)];
      for (let i = 0; i < 4; i++) {
        const [x1, z1] = corners[i], [x2, z2] = corners[(i + 1) % 4];
        surfaces.push({ t: 'W', r: [ring([P(x1, ground, z1), P(x2, ground, z2), P(x2, eave, z2), P(x1, eave, z1)])] });
        // Dachfläche über dieser Kante: zum nächstgelegenen Firstpunkt
        const mx = (x1 + x2) / 2, mz = (z1 + z2) / 2;
        const along = Math.abs((x2 - x1) * ux + (z2 - z1) * uz) > Math.abs((x2 - x1) * vx + (z2 - z1) * vz);
        if (along) {
          const d1 = Math.hypot(R1[0] - x2, R1[1] - z2), d2 = Math.hypot(R2[0] - x2, R2[1] - z2);
          const [near2, near1] = d1 < d2 ? [R1, R2] : [R2, R1];
          surfaces.push({ t: 'R', r: [ring([P(x1, eave, z1), P(x2, eave, z2), P(near2[0], ridgeY, near2[1]), P(near1[0], ridgeY, near1[1])])] });
        } else {
          const R = Math.hypot(R1[0] - mx, R1[1] - mz) < Math.hypot(R2[0] - mx, R2[1] - mz) ? R1 : R2;
          if (shape === 'hipped') surfaces.push({ t: 'R', r: [ring([P(x1, eave, z1), P(x2, eave, z2), P(R[0], ridgeY, R[1])])] });
          else surfaces.push({ t: 'W', r: [ring([P(x1, eave, z1), P(x2, eave, z2), P(R[0], ridgeY, R[1])])] }); // Giebel
        }
      }
      surfaces.push({ t: 'G', r: [ring(corners.slice().reverse().map(([x, z]) => P(x, ground, z)))] });
    }
    // Orientierung aller Flächen prüfen: Normale nach außen (Wände/Dach) bzw. nach unten (Grund)
    const center = [cx, ground + eaveRel / 2, cz];
    for (const s of surfaces) {
      const r = s.r[0];
      let nx = 0, ny = 0, nz = 0, mx = 0, my = 0, mz = 0;
      const n = r.length / 3;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const [ax, ay, az] = [r[i * 3], r[i * 3 + 1], r[i * 3 + 2]], [bx, by, bz] = [r[j * 3], r[j * 3 + 1], r[j * 3 + 2]];
        nx += (ay - by) * (az + bz); ny += (az - bz) * (ax + bx); nz += (ax - bx) * (ay + by);
        mx += ax / n; my += ay / n; mz += az / n;
      }
      const want = s.t === 'G' ? -ny : nx * (mx - center[0]) + ny * (my - center[1]) + nz * (mz - center[2]);
      if (want < 0) {
        const rev = [];
        for (let i = n - 1; i >= 0; i--) rev.push(r[i * 3], r[i * 3 + 1], r[i * 3 + 2]);
        s.r[0] = rev;
      }
    }
    const fn = /school/.test(t.building) || t.amenity === 'school' ? '31001_3021'
      : t.amenity === 'kindergarten' || t.building === 'kindergarten' ? '31001_3065'
      : /house|residential|detached|semidetached|terrace/.test(t.building) ? '31001_1000' : '31001_2000';
    out.push({
      id: `OSM_${f.id}`, fn, roof: shape, roofName: shape === 'flat' ? 'PolyFlatRoof' : shape === 'hipped' ? 'HipRoof' : 'GableRoof',
      eave: +eave.toFixed(2), ridge: +(eave + roofH).toFixed(2), ground: +ground.toFixed(2), surfaces, source: 'osm', name: t.name,
    });
  }
  return out;
}
