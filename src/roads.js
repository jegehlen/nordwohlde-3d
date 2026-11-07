// Straßen und Wege aus OpenStreetMap als Bänder auf dem Gelände:
// Asphalt, Pflaster, Schotter; Fahrbahnmarkierungen auf B51 und Kreisstraßen; Bordsteine im Ort;
// Straßenlaternen entlang der Dorfstraßen.
import * as THREE from 'three';
import { getNoiseTexture } from './noise.js';

const SURF = { ASPHALT: 0, PAVING: 1, GRAVEL: 2, DIRT: 3, CURB: 4 };
const MARK = { NONE: 0, PRIMARY: 1, SECONDARY: 2 };

function surfaceOf(tags, fallback) {
  const s = tags.surface || '';
  if (/asphalt|concrete$|^paved$/.test(s)) return SURF.ASPHALT;
  if (/paving|sett|cobble|concrete:plates|concrete:lanes|bricks/.test(s)) return SURF.PAVING;
  if (/gravel|compacted|pebble/.test(s)) return SURF.GRAVEL;
  if (/ground|dirt|earth|sand|mud/.test(s)) return SURF.DIRT;
  if (/grass/.test(s)) return null;
  return fallback;
}

/** Breite, Belag, Markierung und Rang (für die Überlagerung an Kreuzungen) je Wegtyp. */
function roadSpec(tags) {
  const hw = tags.highway;
  const lanes = +tags.lanes || 0;
  switch (hw) {
    case 'primary': case 'primary_link':
      return { w: Math.max(2, lanes || 2) * 3.25 + 0.7, s: surfaceOf(tags, SURF.ASPHALT), m: MARK.PRIMARY, rank: 6, curb: false };
    case 'secondary': case 'secondary_link':
      return { w: 6.5, s: surfaceOf(tags, SURF.ASPHALT), m: MARK.SECONDARY, rank: 5, curb: true };
    case 'tertiary': return { w: 6.0, s: surfaceOf(tags, SURF.ASPHALT), m: MARK.NONE, rank: 5, curb: true };
    case 'unclassified': return { w: 5.0, s: surfaceOf(tags, SURF.ASPHALT), m: MARK.NONE, rank: 4, curb: true };
    case 'residential': return { w: 5.2, s: surfaceOf(tags, SURF.ASPHALT), m: MARK.NONE, rank: 4, curb: true };
    case 'living_street': return { w: 4.6, s: surfaceOf(tags, SURF.PAVING), m: MARK.NONE, rank: 4, curb: false };
    case 'service': {
      const w = tags.service === 'parking_aisle' ? 5 : tags.service === 'driveway' ? 3 : 3.5;
      return { w, s: surfaceOf(tags, SURF.ASPHALT), m: MARK.NONE, rank: 3, curb: false };
    }
    case 'track': {
      const s = surfaceOf(tags, null);
      return s === null || s === SURF.DIRT ? null : { w: 3, s, m: MARK.NONE, rank: 2, curb: false };
    }
    case 'cycleway': return { w: 2.2, s: surfaceOf(tags, SURF.ASPHALT), m: MARK.NONE, rank: 2, curb: false };
    case 'footway': case 'path': case 'pedestrian': {
      const s = surfaceOf(tags, null);
      return s === null || s === SURF.DIRT ? null : { w: hw === 'pedestrian' ? 4 : 1.8, s, m: MARK.NONE, rank: 1, curb: false };
    }
    default: return null;
  }
}

function resample(pts, maxSeg) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / maxSeg));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return out;
}

function makeRoadMaterial(noiseTex) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.92, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.noiseTex = { value: noiseTex };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aRoad;   // x: u quer (m), y: v längs (m), z: Belag, w: Markierung
        attribute float aWidth;
        varying vec4 vRoad; varying float vWidth; varying vec2 vWorldXZ;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vRoad = aRoad; vWidth = aWidth;
        vWorldXZ = (modelMatrix * vec4(position, 1.0)).xz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D noiseTex;
        varying vec4 vRoad; varying float vWidth; varying vec2 vWorldXZ;
        float markMask = 0.0;`)
      .replace('#include <map_fragment>', `
        float coarse = texture2D(noiseTex, vWorldXZ * 0.013).r;
        float fine = texture2D(noiseTex, vWorldXZ * 0.9).g;
        float mid = texture2D(noiseTex, vWorldXZ * 0.11).b;
        float surf = vRoad.z;
        float u = vRoad.x, v = vRoad.y, hw = vWidth * 0.5;
        float edge = 1.0 - smoothstep(hw - 0.6, hw, abs(u)); // (smoothstep mit edge0 > edge1 ist undefiniert)
        vec3 col;
        if (surf < 0.5) {            // Asphalt
          col = vec3(0.105, 0.105, 0.11) * (0.8 + 0.35 * coarse) * (0.85 + 0.3 * fine);
          col = mix(col * 1.25 + vec3(0.03, 0.025, 0.015), col, edge); // staubiger Rand
          col *= 0.92 + 0.16 * mid;   // Flickstellen
        } else if (surf < 1.5) {     // Pflaster (Rechteckverband 20 × 10 cm)
          vec2 p = vec2(u, v) / vec2(0.1, 0.2);
          p.y += step(1.0, mod(floor(p.x), 2.0)) * 0.5;
          vec2 f = fract(p);
          float joint = step(0.92, f.x) + step(0.95, f.y);
          col = vec3(0.36, 0.33, 0.3) * (0.82 + 0.3 * coarse) * (0.9 + 0.2 * fine);
          col *= 1.0 - 0.35 * clamp(joint, 0.0, 1.0);
        } else if (surf < 2.5) {     // Schotter / wassergebundene Decke
          col = vec3(0.47, 0.43, 0.36) * (0.8 + 0.3 * coarse) * (0.75 + 0.5 * fine);
          col = mix(col * 0.85, col, edge);
        } else if (surf < 3.5) {     // Erde
          col = vec3(0.33, 0.27, 0.2) * (0.8 + 0.4 * fine);
        } else {                     // Bordstein
          col = vec3(0.6, 0.6, 0.58) * (0.85 + 0.2 * fine);
        }
        // Fahrbahnmarkierungen
        float mk = vRoad.w;
        if (mk > 0.5) {
          float lineW = 0.12;
          float center = 1.0 - smoothstep(lineW * 0.5, lineW * 0.5 + 0.02, abs(u));
          float dash = step(mod(v, 12.0), 6.0);           // Leitlinie außerorts: 6 m Strich, 6 m Lücke
          markMask = center * dash;
          if (mk < 1.5) {                                   // B51: zusätzlich durchgehende Randlinien
            float d = abs(abs(u) - (hw - 0.45));
            markMask = max(markMask, 1.0 - smoothstep(0.075, 0.095, d));
          }
          markMask *= 0.75 + 0.25 * fine;
          col = mix(col, vec3(0.82, 0.82, 0.8), markMask);
        }
        diffuseColor.rgb = col;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.7, markMask);`);
  };
  mat.customProgramCacheKey = () => 'nw3d-road-v1';
  return mat;
}

export function buildRoads({ osm, groundAt, buildingInfo, quality, renderer, bounds }) {
  const lift = quality.name === 'lo' ? 0.2 : 0.1;
  const pos = [], nor = [], road = [], width = [], idx = [];
  const lampSpots = [];

  // Raster mit Gebäudemittelpunkten für „im Ort“-Abfragen
  const cell = 30, bmap = new Map();
  for (const b of buildingInfo) {
    const k = `${Math.floor(b.x / cell)},${Math.floor(b.z / cell)}`;
    bmap.set(k, (bmap.get(k) || 0) + 1);
  }
  const village = (x, z) => {
    let n = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) n += bmap.get(`${Math.floor(x / cell) + a},${Math.floor(z / cell) + b}`) || 0;
    return n >= 3;
  };

  const ways = osm.filter((f) => f.g && f.tags.highway && !f.tags.area)
    .map((f) => ({ f, spec: roadSpec(f.tags) }))
    .filter((o) => o.spec)
    .sort((a, b) => a.spec.rank - b.spec.rank);

  const addRibbon = (pts, w, surface, mark, y0, offset = 0) => {
    // pts: [[x,z], …] mit Abstand ≤ 2 m; Querschnitt aus 3 Punkten (links, Mitte, rechts)
    const base = pos.length / 3;
    let v = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let tx = b[0] - a[0], tz = b[1] - a[1];
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const nx = -tz, nz = tx;
      if (i > 0) v += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
      for (const s of [-1, 0, 1]) {
        const u = offset + (s * w) / 2;
        const x = p[0] + nx * u, z = p[1] + nz * u;
        pos.push(x, groundAt(x, z) + y0, z);
        nor.push(0, 1, 0);
        road.push(s * w / 2, v, surface, mark);
        width.push(w);
      }
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const r0 = base + i * 3, r1 = r0 + 3;
      idx.push(r0, r0 + 1, r1, r1, r0 + 1, r1 + 1, r0 + 1, r0 + 2, r1 + 1, r1 + 1, r0 + 2, r1 + 2);
    }
  };

  for (const { f, spec } of ways) {
    let pts = f.g.filter(([x, z]) => Math.abs(x) < bounds && Math.abs(z) < bounds);
    if (pts.length < 2) continue;
    // Enden etwas verlängern, damit Einmündungen geschlossen wirken
    const ext = (p, q) => { const dx = p[0] - q[0], dz = p[1] - q[1], l = Math.hypot(dx, dz) || 1; return [p[0] + (dx / l) * spec.w * 0.35, p[1] + (dz / l) * spec.w * 0.35]; };
    pts = [ext(pts[0], pts[1]), ...pts.slice(1, -1), ext(pts[pts.length - 1], pts[pts.length - 2])];
    if (pts.length === 2) pts = [pts[0], pts[1]];
    pts = resample(pts, 2);
    const y0 = lift + spec.rank * 0.006;
    addRibbon(pts, spec.w, spec.s, spec.m, y0);

    // Bordsteine und Laternen nur im Ort
    if (spec.curb) {
      // Abschnittsweise: nur wo Bebauung angrenzt
      let run = [];
      const flush = () => {
        if (run.length > 3) {
          addRibbon(run, 0.3, SURF.CURB, MARK.NONE, y0 + 0.09, -spec.w / 2 - 0.12);
          addRibbon(run, 0.3, SURF.CURB, MARK.NONE, y0 + 0.09, spec.w / 2 + 0.12);
        }
        run = [];
      };
      for (const p of pts) { if (village(p[0], p[1])) run.push(p); else flush(); }
      flush();
      // Laternen alle ~38 m, abwechselnd links/rechts
      let acc = 19, side = 1;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        acc += Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (acc >= 38 && village(b[0], b[1])) {
          acc = 0; side = -side;
          let tx = b[0] - a[0], tz = b[1] - a[1]; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
          const off = spec.w / 2 + 0.75;
          lampSpots.push({ x: b[0] - tz * off * side, z: b[1] + tx * off * side, dirX: tz * side, dirZ: -tx * side });
        }
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aRoad', new THREE.Float32BufferAttribute(road, 4));
  g.setAttribute('aWidth', new THREE.Float32BufferAttribute(width, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, makeRoadMaterial(getNoiseTexture(renderer)));
  mesh.name = 'roads';
  mesh.receiveShadow = true;

  const group = new THREE.Group();
  group.name = 'roads';
  group.add(mesh, buildLamps(lampSpots, groundAt));
  group.userData.stats = { ways: ways.length, triangles: idx.length / 3, lamps: lampSpots.length };
  return group;
}

/** Schlichte Mastleuchten (ca. 5 m, anthrazit, Leuchtenkopf mit Ausleger). */
function buildLamps(spots, groundAt) {
  const pole = new THREE.CylinderGeometry(0.05, 0.075, 5, 8).translate(0, 2.5, 0);
  const arm = new THREE.BoxGeometry(0.06, 0.06, 0.55).translate(0, 4.95, 0.25);
  const head = new THREE.BoxGeometry(0.22, 0.09, 0.5).translate(0, 4.9, 0.55);
  const metal = new THREE.MeshStandardMaterial({ color: 0x3a3d40, roughness: 0.5, metalness: 0.6 });
  const glass = new THREE.MeshStandardMaterial({ color: 0xe8eef0, roughness: 0.3, metalness: 0.1, emissive: 0x000000 });
  const geos = [[pole, metal], [arm, metal], [head, glass]];
  const group = new THREE.Group();
  group.name = 'lamps';
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  for (const [geo, mat] of geos) {
    const inst = new THREE.InstancedMesh(geo, mat, spots.length);
    spots.forEach((l, i) => {
      q.setFromAxisAngle(up, Math.atan2(l.dirX, l.dirZ));
      p.set(l.x, groundAt(l.x, l.z), l.z);
      inst.setMatrixAt(i, m.compose(p, q, s));
    });
    inst.castShadow = true;
    inst.computeBoundingSphere();
    group.add(inst);
  }
  return group;
}
