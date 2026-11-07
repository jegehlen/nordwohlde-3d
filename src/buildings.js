// Gebäude aus den LGLN-LoD2-Daten: Wände mit prozeduralen Fassaden (Klinker, Putz, Bretter/Blech,
// Fenster), Dächer mit den echten Farben aus dem Luftbild.
import * as THREE from 'three';
import earcut from 'earcut';

// ------------------------------------------------------------------ Hilfen
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}
const rng = (seed) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

function newellNormal(pts) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/** Trianguliert ein ebenes 3D-Polygon (mit Löchern) → Liste von Dreiecken [a,b,c] in Weltkoordinaten. */
function triangulate(rings, normal) {
  const ax = Math.abs(normal[0]), ay = Math.abs(normal[1]), az = Math.abs(normal[2]);
  // auf die dominante Ebene projizieren
  const [i0, i1] = ax >= ay && ax >= az ? [1, 2] : ay >= az ? [0, 2] : [0, 1];
  const flat = [], holes = [], pts = [];
  for (let r = 0; r < rings.length; r++) {
    if (r > 0) holes.push(pts.length);
    const ring = rings[r];
    for (let k = 0; k < ring.length; k += 3) {
      const p = [ring[k], ring[k + 1], ring[k + 2]];
      pts.push(p); flat.push(p[i0], p[i1]);
    }
  }
  const idx = earcut(flat, holes.length ? holes : undefined, 2);
  const tris = [];
  for (let t = 0; t < idx.length; t += 3) {
    let a = pts[idx[t]], b = pts[idx[t + 1]], c = pts[idx[t + 2]];
    // Wicklung an die Polygon-Normale anpassen (nach außen zeigend)
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * normal[0] + cy * normal[1] + cz * normal[2] < 0) [b, c] = [c, b];
    tris.push(a, b, c);
  }
  return tris;
}

// ------------------------------------------------------------------ Gebäudetypen & Stile
const STYLE = { BRICK: 0, PLASTER: 1, BOARDS: 2 };
// Norddeutscher Klinker: überwiegend rot bis rotbraun, einzelne bunte/braune Töne
const BRICK_TINTS = ['#b0553c', '#a14b36', '#b8644a', '#94493a', '#a85a44', '#c07050', '#8c5243', '#b9765a', '#9e4a3a'];
const PLASTER_TINTS = ['#ece6d8', '#e2dccd', '#f1eee6', '#d8d0bd', '#e9e1cc'];
const BOARD_TINTS = ['#3a3b33', '#2f3a2e', '#4a3324', '#5b4a3a', '#3d4148'];
const METAL_TINTS = ['#b8b8b0', '#a9aca6', '#c2bcae', '#8f948d'];

function classify(b, area, height) {
  const fn = b.fn || '';
  // Hochsilos, Futtermittelsilos der Mühle, Schornsteine: klein und hoch
  if (height > 11 && area < 120 && height > Math.sqrt(area) * 1.6 && fn !== '31001_3041') return 'silo';
  if (fn.startsWith('51')) return 'canopy';
  if (fn === '31001_1000' || fn === '31001_1210') return 'house';
  if (fn.startsWith('31001_3')) return 'public';
  if (fn === '31001_2720' || fn === '31001_2600') return 'farm';
  if (area < 70) return 'shed';
  if (area > 350) return 'hall';
  return 'commercial';
}

function chooseStyle(type, r) {
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  switch (type) {
    case 'house': return r() < 0.78 ? { s: STYLE.BRICK, c: pick(BRICK_TINTS), win: 1 } : { s: STYLE.PLASTER, c: pick(PLASTER_TINTS), win: 1 };
    case 'public': return { s: STYLE.BRICK, c: pick(BRICK_TINTS), win: 1 };
    case 'farm': return r() < 0.55 ? { s: STYLE.BRICK, c: pick(BRICK_TINTS), win: 0.3 } : { s: STYLE.BOARDS, c: pick(BOARD_TINTS), win: 0 };
    case 'hall': return r() < 0.45 ? { s: STYLE.BRICK, c: pick(BRICK_TINTS), win: 0.35 } : { s: STYLE.BOARDS, c: pick(METAL_TINTS), win: 0.15 };
    case 'commercial': { const x = r(); return x < 0.6 ? { s: STYLE.BRICK, c: pick(BRICK_TINTS), win: 0.55 } : x < 0.8 ? { s: STYLE.PLASTER, c: pick(PLASTER_TINTS), win: 0.5 } : { s: STYLE.BOARDS, c: pick(BOARD_TINTS), win: 0 }; }
    case 'silo': return { s: STYLE.PLASTER, c: pick(['#b9b6ad', '#c9c6bd', '#a8aaa6', '#d2d0c8']), win: 0 };
    case 'shed': { const x = r(); return x < 0.5 ? { s: STYLE.BRICK, c: pick(BRICK_TINTS), win: 0 } : x < 0.8 ? { s: STYLE.BOARDS, c: pick(BOARD_TINTS), win: 0 } : { s: STYLE.PLASTER, c: pick(PLASTER_TINTS), win: 0 }; }
    default: return { s: STYLE.BOARDS, c: pick(BOARD_TINTS), win: 0 };
  }
}

// ------------------------------------------------------------------ Fassadentextur (prozedural)
// Kanäle: R = Klinker-Helligkeit, G = Fugenmaske, B = Bretter/Blech-Muster. 1 Kachel = 1 m × 1 m.
function makeFacadeTexture(renderer) {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(S, S);
  const d = img.data;
  const rows = 13, cols = 4;               // Klinker ~24 × 7,7 cm (inkl. Fuge)
  const rowH = S / rows, colW = S / cols;
  const brickVal = [];
  const r = rng(1234);
  for (let i = 0; i < rows * (cols + 1); i++) brickVal.push(0.25 + r() * 0.75);
  const boardW = S / 7;                    // Bretter ~14 cm
  for (let y = 0; y < S; y++) {
    const row = Math.floor(y / rowH);
    const fy = y - row * rowH;
    const shift = (row % 2) * colW * 0.5;
    for (let x = 0; x < S; x++) {
      const xs = (x + shift) % S;
      const col = Math.floor(xs / colW);
      const fx = xs - col * colW;
      const mortar = fy < 4.2 || fx < 4.2 ? 1 : 0;
      const n = r();
      const k = (y * S + x) * 4;
      d[k] = Math.round(255 * Math.min(1, brickVal[row * (cols + 1) + col] * (0.88 + n * 0.24)));
      d[k + 1] = mortar * 255;
      const bx = x % boardW;
      const groove = bx < 3 ? 0.35 : bx < 5 ? 0.7 : 1;
      const grain = 0.86 + 0.14 * Math.sin(y * 0.08 + Math.floor(x / boardW) * 7.1) * 0.5 + n * 0.1;
      d[k + 2] = Math.round(255 * Math.min(1, groove * grain));
      d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

function makeWallMaterial(facadeTex) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0, vertexColors: true });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.facadeTex = { value: facadeTex };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aFacade;   // x: Fensteranteil, y: Traufhöhe über Grund, z: Wandlänge, w: Zufallswert
        attribute float aStyle;   // 0 Klinker, 1 Putz, 2 Bretter/Blech
        attribute vec2 aWall;     // Wandkoordinaten in Metern (entlang, Höhe über Grund)
        varying vec4 vFacade; varying float vStyle; varying vec2 vWall;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vFacade = aFacade; vStyle = aStyle; vWall = aWall;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D facadeTex;
        varying vec4 vFacade; varying float vStyle; varying vec2 vWall;
        float glassMask = 0.0;
        float h13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }`)
      .replace('#include <map_fragment>', `
        vec3 tint = diffuseColor.rgb;
        vec4 ft = texture2D(facadeTex, vWall);
        vec3 col;
        if (vStyle < 0.5) {
          vec3 brick = tint * (0.72 + 0.45 * ft.r);
          col = mix(brick, tint * 0.25 + vec3(0.42, 0.41, 0.38), ft.g * 0.85);
        } else if (vStyle < 1.5) {
          float n = texture2D(facadeTex, vWall * 0.31).r;
          col = tint * (0.93 + 0.1 * n);
        } else {
          col = tint * (0.55 + 0.6 * ft.b);
        }
        // Fenster
        float frameMask = 0.0;
        if (vFacade.x > 0.0) {
          float spacing = vFacade.x > 0.9 ? 3.1 : 4.6;
          float L = vFacade.z;
          float n = floor((L - 0.9) / spacing);
          if (n >= 1.0) {
            float off = (L - n * spacing) * 0.5;
            float bx = (vWall.x - off) / spacing;
            float bi = floor(bx);
            float fx = (bx - bi) * spacing;
            float storey = 2.75;
            float fl = floor(max(vWall.y, 0.0) / storey);
            float fy = vWall.y - fl * storey;
            float ww = 1.2, wh = 1.3, sill = 0.9;
            bool ok = bi >= 0.0 && bi < n && fl * storey + sill + wh < vFacade.y - 0.2
                      && h13(vec3(bi, fl, vFacade.w * 97.0)) < vFacade.x;
            if (ok) {
              float cx = abs(fx - spacing * 0.5);
              float cy = fy - sill;
              if (cx < ww * 0.5 && cy > 0.0 && cy < wh) {
                float edge = min(ww * 0.5 - cx, min(cy, wh - cy));
                bool mullion = abs(fx - spacing * 0.5) < 0.035 || abs(cy - wh * 0.72) < 0.035;
                if (edge < 0.07 || mullion) frameMask = 1.0; else glassMask = 1.0;
              }
              // Fensterbank
              if (cx < ww * 0.5 + 0.06 && cy < 0.0 && cy > -0.07) frameMask = 0.6;
            }
          }
        }
        col = mix(col, vec3(0.93, 0.93, 0.9) * (0.75 + 0.25 * frameMask), step(0.01, frameMask));
        col = mix(col, vec3(0.045, 0.06, 0.075), glassMask);
        // Bodennähe etwas abdunkeln (Spritzwasser, Umgebungsverdeckung)
        col *= mix(0.72, 1.0, smoothstep(0.0, 1.4, vWall.y));
        diffuseColor.rgb = col;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        if (vStyle > 1.5) roughnessFactor = 0.62;
        roughnessFactor = mix(roughnessFactor, 0.06, glassMask);`);
  };
  mat.customProgramCacheKey = () => 'nw3d-wall-v1';
  return mat;
}

// ------------------------------------------------------------------ Dachziegel (prozedural)
// R = Helligkeit der Dachpfannen. 1 Kachel = 1 m entlang der Traufe × 1 m entlang des Gefälles.
function makeRoofTexture(renderer) {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(S, S);
  const d = img.data;
  const cols = 3, rows = 3;                  // Pfannen ~33 × 33 cm
  const cw = S / cols, rh = S / rows;
  const r = rng(77);
  const tileVar = Array.from({ length: cols * rows }, () => 0.85 + r() * 0.3);
  for (let y = 0; y < S; y++) {
    const row = Math.floor(y / rh), fy = (y - row * rh) / rh;   // 0 oben (First) … 1 unten (Traufe)
    for (let x = 0; x < S; x++) {
      const col = Math.floor(x / cw), fx = (x - col * cw) / cw;
      // Wellenprofil der Pfanne + Schattenkante an der Überlappung
      const wave = 0.78 + 0.22 * Math.sin(fx * Math.PI * 2 - 0.6);
      const overlap = fy > 0.9 ? 0.55 : fy < 0.06 ? 1.08 : 1;
      const v = Math.min(1, wave * overlap * tileVar[row * cols + col] * (0.95 + r() * 0.1));
      const k = (y * S + x) * 4;
      d[k] = d[k + 1] = d[k + 2] = Math.round(255 * v * 0.92); d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function makeRoofMaterial(orthoTex, roofTex) {
  const mat = new THREE.MeshStandardMaterial({
    map: orthoTex, roughness: 0.78, metalness: 0, envMapIntensity: 0.5,
    side: THREE.DoubleSide, shadowSide: THREE.FrontSide,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.roofTex = { value: roofTex };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aRoof; varying vec3 vRoof;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vRoof = aRoof;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D roofTex; varying vec3 vRoof;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        // Luftbildfarbe leicht entsättigen/abdunkeln und mit Ziegelstruktur überlagern
        vec3 base = diffuseColor.rgb;
        float l = dot(base, vec3(0.299, 0.587, 0.114));
        base = mix(vec3(l), base, 1.12) * 0.82;
        float t = texture2D(roofTex, vRoof.xy).r;
        float flatRoof = vRoof.z;
        float n = texture2D(roofTex, vRoof.xy * 0.173).r;
        diffuseColor.rgb = base * mix(0.55 + 0.6 * t, 0.9 + 0.15 * n, flatRoof);`);
  };
  mat.customProgramCacheKey = () => 'nw3d-roof-v1';
  return mat;
}

// ------------------------------------------------------------------ Aufbau
export async function buildBuildings({ url, sceneMeta, orthoTextures, renderer }) {
  const data = await (await fetch(url)).json();
  const wall = { pos: [], nor: [], col: [], fac: [], sty: [], wuv: [] };
  const { grid, tileSize } = sceneMeta.core.ortho;
  const half = sceneMeta.core.size / 2;
  const roofBins = Array.from({ length: grid * grid }, () => ({ pos: [], nor: [], uv: [], roof: [] }));
  const color = new THREE.Color();
  const info = [];
  const SKIRT = 1.2; // Wände nach unten verlängern, damit am Hang keine Lücken entstehen

  for (const b of data) {
    // Kennwerte
    let groundY = Infinity, topY = -Infinity, area = 0, cx = 0, cz = 0, cn = 0;
    for (const s of b.surfaces) for (const r of s.r) for (let k = 0; k < r.length; k += 3) {
      groundY = Math.min(groundY, r[k + 1]); topY = Math.max(topY, r[k + 1]);
      cx += r[k]; cz += r[k + 2]; cn++;
    }
    for (const s of b.surfaces) if (s.t === 'G') {
      const r = s.r[0];
      for (let k = 0; k < r.length; k += 3) {
        const k2 = (k + 3) % r.length;
        area += r[k] * r[k2 + 2] - r[k2] * r[k + 2];
      }
    }
    area = Math.abs(area) / 2;
    cx /= cn; cz /= cn;
    const type = classify(b, area, topY - groundY);
    const r = rng(Math.floor(hashStr(b.id) * 2147483646) + 1);
    const st = chooseStyle(type, r);
    // Angaben aus OpenStreetMap haben Vorrang (z. B. Klinkerfarbe der Feuerwehr)
    const osmCol = b.osm?.['building:colour'];
    if (osmCol && /^#?[0-9a-f]{6}$|^[a-z]+$/i.test(osmCol)) {
      try { color.set(osmCol); st.c = '#' + color.getHexString(); } catch { /* unbekannte Farbe */ }
      if (b.osm['building:material'] === 'brick') st.s = STYLE.BRICK;
      else if (b.osm['building:material'] === 'plaster') st.s = STYLE.PLASTER;
    }
    if (b.osm?.amenity === 'place_of_worship') st.win = 0; // Kirchenfenster passen nicht ins Wohnhausraster
    // Gaststätten, Läden, Bank & Co.: im Dorf typischerweise Klinkerbauten mit Fenstern
    if ((b.osm?.amenity || b.osm?.shop) && st.s === STYLE.BOARDS && !osmCol) { st.s = STYLE.BRICK; st.c = BRICK_TINTS[Math.floor(r() * BRICK_TINTS.length)]; st.win = 0.8; }
    if (b.fn === '31001_3072' && !osmCol) { st.s = STYLE.BRICK; st.c = '#c4573c'; }
    color.set(st.c).convertSRGBToLinear();
    const eaveRel = (b.eave !== undefined && b.roofName !== 'PolyFlatRoof' ? b.eave : topY) - groundY;
    const seed = r();
    info.push({ id: b.id, type, x: cx, z: cz, groundY, topY, area });

    for (const s of b.surfaces) {
      if (s.t === 'G' || s.t === 'C') continue;
      const ring0 = s.r[0];
      const pts = [];
      for (let k = 0; k < ring0.length; k += 3) pts.push([ring0[k], ring0[k + 1], ring0[k + 2]]);
      const n = newellNormal(pts);
      const isWall = s.t === 'W' || Math.abs(n[1]) < 0.12;

      if (isWall) {
        // Wandachse horizontal entlang der Wand
        let hx = -n[2], hz = n[0];
        const hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;
        let umin = Infinity, umax = -Infinity;
        for (const p of pts) { const u = p[0] * hx + p[2] * hz; umin = Math.min(umin, u); umax = Math.max(umax, u); }
        const L = umax - umin;
        // Skirt: Punkte auf Bodenhöhe nach unten verlängern
        const rings = s.r.map((ring) => {
          const out = ring.slice();
          for (let k = 1; k < out.length; k += 3) if (out[k] <= groundY + 0.05) out[k] -= SKIRT;
          return out;
        });
        for (const p of triangulate(rings, n)) {
          wall.pos.push(p[0], p[1], p[2]);
          wall.nor.push(n[0], n[1], n[2]);
          wall.col.push(color.r, color.g, color.b);
          wall.fac.push(st.win, eaveRel, L, seed);
          wall.sty.push(st.s);
          wall.wuv.push(p[0] * hx + p[2] * hz - umin, p[1] - groundY);
        }
      } else {
        // Dach → Luftbild-Kachel nach Lage des Gebäudes
        const ti = Math.min(grid - 1, Math.max(0, Math.floor((cx + half) / tileSize)));
        const tj = Math.min(grid - 1, Math.max(0, Math.floor((cz + half) / tileSize)));
        const bin = roofBins[tj * grid + ti];
        const x0 = -half + ti * tileSize, z0 = -half + tj * tileSize;
        // Dachkoordinaten: entlang der Traufe / entlang des Gefälles (in Metern auf der Dachfläche)
        const flatRoof = n[1] > 0.985 ? 1 : 0;
        let dx = n[0], dz = n[2];
        const dl = Math.hypot(dx, dz);
        if (dl < 1e-3) { dx = 1; dz = 0; } else { dx /= dl; dz /= dl; }
        const slopeK = 1 / Math.max(0.2, n[1]);
        for (const p of triangulate(s.r, n)) {
          bin.pos.push(p[0], p[1], p[2]);
          bin.nor.push(n[0], n[1], n[2]);
          bin.uv.push((p[0] - x0) / tileSize, 1 - (p[2] - z0) / tileSize);
          bin.roof.push(-p[0] * dz + p[2] * dx, (p[0] * dx + p[2] * dz) * slopeK, flatRoof);
        }
      }
    }
  }

  const group = new THREE.Group();
  group.name = 'buildings';

  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(wall.pos, 3));
  wg.setAttribute('normal', new THREE.Float32BufferAttribute(wall.nor, 3));
  wg.setAttribute('color', new THREE.Float32BufferAttribute(wall.col, 3));
  wg.setAttribute('aFacade', new THREE.Float32BufferAttribute(wall.fac, 4));
  wg.setAttribute('aStyle', new THREE.Float32BufferAttribute(wall.sty, 1));
  wg.setAttribute('aWall', new THREE.Float32BufferAttribute(wall.wuv, 2));
  wg.computeBoundingSphere();
  const walls = new THREE.Mesh(wg, makeWallMaterial(makeFacadeTexture(renderer)));
  walls.name = 'walls';
  walls.castShadow = walls.receiveShadow = true;
  group.add(walls);

  const roofTex = makeRoofTexture(renderer);
  roofBins.forEach((bin, k) => {
    if (!bin.pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(bin.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(bin.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(bin.uv, 2));
    g.setAttribute('aRoof', new THREE.Float32BufferAttribute(bin.roof, 3));
    g.computeBoundingSphere();
    const i = k % grid, j = Math.floor(k / grid);
    // DoubleSide: Vordächer/Überdachungen auch von unten sichtbar
    const m = new THREE.Mesh(g, makeRoofMaterial(orthoTextures[`${i}_${j}`], roofTex));
    m.name = `roofs_${i}_${j}`;
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  });

  group.userData.info = info;
  group.userData.raw = data;
  group.userData.stats = { buildings: data.length, wallTriangles: wall.pos.length / 9, roofTriangles: roofBins.reduce((a, b) => a + b.pos.length / 9, 0) };
  return group;
}
