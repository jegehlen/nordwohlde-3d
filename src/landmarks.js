// Detailausstattung der wichtigen Orte: Schilder, Eingänge, Tore, Außengastronomie, Sportanlage.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ------------------------------------------------------------------ Geometrie-Hilfen
function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function footprint(b) {
  let ground = Infinity, top = -Infinity;
  const poly = [];
  for (const s of b.surfaces) for (const r of s.r) for (let k = 0; k < r.length; k += 3) { ground = Math.min(ground, r[k + 1]); top = Math.max(top, r[k + 1]); }
  const g = b.surfaces.find((s) => s.t === 'G');
  if (g) for (let k = 0; k < g.r[0].length; k += 3) poly.push([g.r[0][k], g.r[0][k + 2]]);
  const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length, cz = poly.reduce((a, p) => a + p[1], 0) / poly.length;
  return { poly, ground, top, cx, cz };
}

function minRect(pts) {
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length];
    const l = Math.hypot(x2 - x1, z2 - z1); if (l < 1e-6) continue;
    const ux = (x2 - x1) / l, uz = (z2 - z1) / l, vx = -uz, vz = ux;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, z] of pts) { const a = x * ux + z * uz, b = x * vx + z * vz; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
    const area = (a1 - a0) * (b1 - b0);
    if (!best || area < best.area) best = { area, ux, uz, vx, vz, a0, a1, b0, b1 };
  }
  const { ux, uz, vx, vz, a0, a1, b0, b1 } = best;
  const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
  let r = { cx: ux * ca + vx * cb, cz: uz * ca + vz * cb, ux, uz, vx, vz, L: a1 - a0, W: b1 - b0 };
  if (r.W > r.L) r = { ...r, ux: vx, uz: vz, vx: -ux, vz: -uz, L: r.W, W: r.L };
  return r;
}

/**
 * Wand eines Gebäudes, die zur Straße zeigt: nach außen gerichtet, möglichst nah an der Straße,
 * ausreichend lang. roadDist(x, z) → { d, dx, dz } (Abstand und Richtung zur nächsten Straße).
 */
function pickFacade(b, roadDist, minLen = 3, center = null, blocked = () => false) {
  let best = null;
  if (!center) { const fp = footprint(b); center = [fp.cx, fp.cz]; }
  for (const s of b.surfaces) {
    if (s.t !== 'W') continue;
    const r = s.r[0], pts = [];
    for (let k = 0; k < r.length; k += 3) pts.push([r[k], r[k + 1], r[k + 2]]);
    // Normale (Newell)
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length];
      nx += (a[1] - c[1]) * (a[2] + c[2]); ny += (a[2] - c[2]) * (a[0] + c[0]); nz += (a[0] - c[0]) * (a[1] + c[1]);
    }
    const hl = Math.hypot(nx, nz); if (hl < 1e-6 || Math.abs(ny) / Math.hypot(nx, ny, nz) > 0.2) continue;
    nx /= hl; nz /= hl;
    // sicherstellen, dass die Normale nach außen zeigt
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, mz = pts.reduce((a, p) => a + p[2], 0) / pts.length;
    if (nx * (mx - center[0]) + nz * (mz - center[1]) < 0) { nx = -nx; nz = -nz; }
    const tx = -nz, tz = nx;
    let u0 = Infinity, u1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pts) { const u = p[0] * tx + p[2] * tz; u0 = Math.min(u0, u); u1 = Math.max(u1, u); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    const len = u1 - u0;
    if (len < minLen) continue;
    // Wände, vor denen direkt ein anderes Gebäude steht (angebaut), überspringen
    const um = (u0 + u1) / 2, dPlane = pts[0][0] * nx + pts[0][2] * nz;
    if ([0.25, 0.5, 0.75].some((k) => { const u = u0 + (u1 - u0) * k; return blocked(tx * u + nx * (dPlane + 1.5), tz * u + nz * (dPlane + 1.5)); })) continue;
    void um;
    const rd = roadDist(mx, mz);
    const facing = nx * rd.dx + nz * rd.dz;
    const score = facing - rd.d / 12 + Math.min(len, 14) / 28;
    if (!best || score > best.score) {
      const d = pts[0][0] * nx + pts[0][2] * nz; // Abstand der Wandebene
      best = { score, nx, nz, tx, tz, u0, u1, len, y0, y1, d, mid: (u0 + u1) / 2 };
    }
  }
  return best;
}

/** Position auf einer Fassade: entlang (u), Höhe (y), Abstand vor der Wand (off). */
function onFacade(f, u, y, off = 0.05) {
  return new THREE.Vector3(f.tx * u + f.nx * (f.d + off), y, f.tz * u + f.nz * (f.d + off));
}
function facadeQuat(f) {
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(f.nx, f.nz));
}

// ------------------------------------------------------------------ Schilder
function signTexture({ lines, bg, fg, font = 'Arial', weight = 'bold', border = null, w = 1024, h = 256, letters = false }) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  if (!letters) {
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    if (border) { ctx.strokeStyle = border; ctx.lineWidth = h * 0.05; ctx.strokeRect(h * 0.05, h * 0.05, w - h * 0.1, h - h * 0.1); }
  }
  ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const total = lines.reduce((a, l) => a + (l.size || 1), 0);
  let y = h * 0.1;
  for (const l of lines) {
    const lh = (h * 0.8 * (l.size || 1)) / total;
    let size = lh * 0.78;
    ctx.font = `${l.italic ? 'italic ' : ''}${l.weight || weight} ${size}px ${l.font || font}`;
    while (ctx.measureText(l.text).width > w * 0.9 && size > 8) { size *= 0.95; ctx.font = `${l.italic ? 'italic ' : ''}${l.weight || weight} ${size}px ${l.font || font}`; }
    if (letters) { ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 2; }
    ctx.fillStyle = l.color || fg;
    ctx.fillText(l.text, w / 2, y + lh / 2);
    y += lh;
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function addSign(group, f, { u, y, width, height, depth = 0.06, ...style }) {
  const tex = signTexture(style);
  const front = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, transparent: !!style.letters, alphaTest: style.letters ? 0.4 : 0 });
  if (style.letters) {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, height), front);
    plane.position.copy(onFacade(f, u, y, 0.04)); plane.quaternion.copy(facadeQuat(f));
    group.add(plane);
    return;
  }
  const side = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.6 });
  const box = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), [side, side, side, side, front, side]);
  box.position.copy(onFacade(f, u, y, depth / 2 + 0.02)); box.quaternion.copy(facadeQuat(f));
  box.castShadow = true;
  group.add(box);
}

function addDoor(group, f, { u, w = 1.1, h = 2.2, color = 0x3b2a1e, glass = false, ground }) {
  const mat = glass
    ? new THREE.MeshStandardMaterial({ color: 0x1a2630, roughness: 0.08, metalness: 0.2, envMapIntensity: 1 })
    : new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
  const frame = new THREE.MeshStandardMaterial({ color: glass ? 0x5a5f63 : 0xeeeeea, roughness: 0.5, metalness: glass ? 0.6 : 0 });
  const d = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.05), mat);
  d.position.copy(onFacade(f, u, ground + h / 2, 0.03)); d.quaternion.copy(facadeQuat(f));
  const fr = new THREE.Mesh(new THREE.BoxGeometry(w + 0.16, h + 0.08, 0.04), frame);
  fr.position.copy(onFacade(f, u, ground + h / 2 + 0.04, 0.015)); fr.quaternion.copy(facadeQuat(f));
  // Stufe
  const step = new THREE.Mesh(new THREE.BoxGeometry(w + 0.8, 0.16, 0.9), new THREE.MeshStandardMaterial({ color: 0x8a8580, roughness: 0.9 }));
  step.position.copy(onFacade(f, u, ground + 0.02, 0.45)); step.quaternion.copy(facadeQuat(f));
  step.receiveShadow = true;
  group.add(fr, d, step);
}

/** Großes Schaufenster (Dorfladen). */
function addShopWindow(group, f, { u, w, h, ground }) {
  const glass = new THREE.MeshStandardMaterial({ color: 0x223038, roughness: 0.05, metalness: 0.3, envMapIntensity: 1.2 });
  const frame = new THREE.MeshStandardMaterial({ color: 0x3c4246, roughness: 0.4, metalness: 0.5 });
  const g = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.04), glass);
  g.position.copy(onFacade(f, u, ground + 0.5 + h / 2, 0.03)); g.quaternion.copy(facadeQuat(f));
  const fr = new THREE.Mesh(new THREE.BoxGeometry(w + 0.14, h + 0.14, 0.03), frame);
  fr.position.copy(onFacade(f, u, ground + 0.5 + h / 2, 0.012)); fr.quaternion.copy(facadeQuat(f));
  group.add(fr, g);
}

/** Sektionaltore der Feuerwehr. */
function addGarageDoors(group, f, { count, w = 3.6, h = 4.2, ground, gap = 1.2 }) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 256;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#d9dcdd'; ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 6; i++) { ctx.fillStyle = '#b9bcbe'; ctx.fillRect(0, i * (256 / 6) - 2, 256, 4); }
  ctx.fillStyle = '#2a3238'; for (let i = 0; i < 4; i++) ctx.fillRect(18 + i * 60, 256 / 6 * 1.25, 42, 22); // Fensterreihe
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const doorMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45, metalness: 0.3 });
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xb3261e, roughness: 0.5 });
  const total = count * w + (count - 1) * gap;
  for (let i = 0; i < count; i++) {
    const u = f.mid - total / 2 + w / 2 + i * (w + gap);
    const d = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.06), doorMat);
    d.position.copy(onFacade(f, u, ground + h / 2, 0.04)); d.quaternion.copy(facadeQuat(f));
    const fr = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, h + 0.15, 0.04), frameMat);
    fr.position.copy(onFacade(f, u, ground + h / 2 + 0.07, 0.02)); fr.quaternion.copy(facadeQuat(f));
    group.add(fr, d);
  }
  // Vorplatz (Beton)
  const apron = new THREE.Mesh(new THREE.BoxGeometry(total + 2, 0.1, 8), new THREE.MeshStandardMaterial({ color: 0x9c9a95, roughness: 0.9 }));
  apron.position.copy(onFacade(f, f.mid, ground - 0.02, 4)); apron.quaternion.copy(facadeQuat(f));
  apron.receiveShadow = true;
  group.add(apron);
  return total;
}

/** Außengastronomie: Tische, Stühle, Sonnenschirme. */
function addTerrace(group, f, { count, ground, groundAt }) {
  const wood = new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.8 });
  const cloth = new THREE.MeshStandardMaterial({ color: 0xe9e1cf, roughness: 0.9, side: THREE.DoubleSide });
  const pole = new THREE.MeshStandardMaterial({ color: 0xcfcfcf, roughness: 0.4, metalness: 0.5 });
  const table = mergeGeometries([
    new THREE.BoxGeometry(1.4, 0.05, 0.8).translate(0, 0.74, 0),
    new THREE.BoxGeometry(0.06, 0.72, 0.06).translate(-0.62, 0.36, -0.32), new THREE.BoxGeometry(0.06, 0.72, 0.06).translate(0.62, 0.36, -0.32),
    new THREE.BoxGeometry(0.06, 0.72, 0.06).translate(-0.62, 0.36, 0.32), new THREE.BoxGeometry(0.06, 0.72, 0.06).translate(0.62, 0.36, 0.32),
    // zwei Bänke
    new THREE.BoxGeometry(1.4, 0.05, 0.3).translate(0, 0.45, -0.7), new THREE.BoxGeometry(1.4, 0.05, 0.3).translate(0, 0.45, 0.7),
    new THREE.BoxGeometry(0.06, 0.45, 0.25).translate(-0.6, 0.22, -0.7), new THREE.BoxGeometry(0.06, 0.45, 0.25).translate(0.6, 0.22, -0.7),
    new THREE.BoxGeometry(0.06, 0.45, 0.25).translate(-0.6, 0.22, 0.7), new THREE.BoxGeometry(0.06, 0.45, 0.25).translate(0.6, 0.22, 0.7),
  ]);
  const umbrella = new THREE.ConeGeometry(1.6, 0.6, 8, 1, true).translate(0, 2.45, 0);
  const stick = new THREE.CylinderGeometry(0.03, 0.03, 2.4, 6).translate(0, 1.2, 0);
  const q = facadeQuat(f);
  for (let i = 0; i < count; i++) {
    // links und rechts vom Eingang/Schild, damit die Schirme das Schild nicht verdecken
    const side = i % 2 ? 1 : -1, k = Math.floor(i / 2);
    const u = f.mid + side * (3.6 + k * 3.3);
    if (Math.abs(u - f.mid) > f.len / 2 + 1) continue;
    const p = onFacade(f, u, 0, 3.8);
    p.y = groundAt(p.x, p.z);
    const t = new THREE.Mesh(table, wood); t.position.copy(p); t.quaternion.copy(q); t.castShadow = true;
    const um = new THREE.Mesh(umbrella, cloth); um.position.copy(p); um.castShadow = true;
    const st = new THREE.Mesh(stick, pole); st.position.copy(p);
    group.add(t, um, st);
  }
}

function addBench(group, pos, rotY) {
  const wood = new THREE.MeshStandardMaterial({ color: 0x6d4f33, roughness: 0.8 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x2f3336, roughness: 0.5, metalness: 0.6 });
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.05, 0.42).translate(0, 0.45, 0), wood));
  g.add(new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.35, 0.05).translate(0, 0.72, -0.2), wood));
  for (const x of [-0.75, 0.75]) g.add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.45, 0.42).translate(x, 0.22, 0), metal));
  g.position.copy(pos); g.rotation.y = rotY;
  g.traverse((o) => { o.castShadow = true; });
  group.add(g);
}

function addPlanter(group, pos) {
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.3, 0.5, 12).translate(0, 0.25, 0), new THREE.MeshStandardMaterial({ color: 0x9a6a4a, roughness: 0.8 }));
  const plant = new THREE.Mesh(new THREE.IcosahedronGeometry(0.4, 1).translate(0, 0.75, 0), new THREE.MeshStandardMaterial({ color: 0x3f6a2a, roughness: 0.9 }));
  const flowers = new THREE.Mesh(new THREE.IcosahedronGeometry(0.18, 0).translate(0.15, 0.95, 0.1), new THREE.MeshStandardMaterial({ color: 0xc8324a, roughness: 0.8 }));
  for (const m of [pot, plant, flowers]) { m.position.copy(pos); m.castShadow = true; group.add(m); }
}

// ------------------------------------------------------------------ Sportanlage
function pitchMaterial({ L, W, kind }) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDim = { value: new THREE.Vector2(L, W) };
    shader.uniforms.uKind = { value: kind };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aField;\nvarying vec2 vField;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvField = aField;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec2 uDim; uniform float uKind; varying vec2 vField;
        float lineAt(float d) { float w = fwidth(d); return 1.0 - smoothstep(0.06, 0.06 + max(0.02, w), abs(d)); }
        float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }`)
      .replace('#include <map_fragment>', `
        vec2 p = vField; float hl = uDim.x * 0.5, hw = uDim.y * 0.5;
        float a = abs(p.x), b = abs(p.y);
        vec3 col; float line = 0.0;
        if (uKind < 0.5) {
          // Fußball: Rasen mit Mähstreifen
          float stripe = mod(floor((p.x + hl) / 5.5), 2.0);
          col = mix(vec3(0.052, 0.118, 0.026), vec3(0.068, 0.148, 0.034), stripe);
          col *= 0.92 + 0.12 * hash(floor(p * 3.0));
          if (a <= hl && b <= hw) {
            line = max(line, lineAt(a - (hl - 0.06)) * step(b, hw));
            line = max(line, lineAt(b - (hw - 0.06)) * step(a, hl));
            line = max(line, lineAt(p.x));                                      // Mittellinie
            line = max(line, lineAt(length(p) - 9.15));                         // Mittelkreis
            line = max(line, 1.0 - smoothstep(0.14, 0.17, length(p)));          // Anstoßpunkt
            float ga = hl - a;                                                   // Abstand zur Torlinie
            line = max(line, lineAt(ga - 16.5) * step(b, 20.16));               // Strafraum
            line = max(line, lineAt(b - 20.16) * step(ga, 16.5));
            line = max(line, lineAt(ga - 5.5) * step(b, 9.16));                 // Torraum
            line = max(line, lineAt(b - 9.16) * step(ga, 5.5));
            vec2 spot = vec2(hl - 11.0, 0.0);
            line = max(line, 1.0 - smoothstep(0.12, 0.15, length(vec2(a, b) - spot)));  // Elfmeterpunkt
            line = max(line, lineAt(length(vec2(a, b) - spot) - 9.15) * step(16.5, ga)); // Teilkreis
            line = max(line, lineAt(length(vec2(hl - a, hw - b)) - 1.0) * step(hl - a, 1.0) * step(hw - b, 1.0)); // Eckbögen
          }
          col = mix(col, vec3(0.75), line);
        } else if (uKind < 1.5) {
          // Laufbahn (Kunststoff) mit Bahnlinien
          col = vec3(0.28, 0.065, 0.04) * (0.9 + 0.15 * hash(floor(p * 8.0)));
          float lane = abs(mod(p.y + hw, 1.22) - 0.0);
          line = max(lineAt(lane), lineAt(b - hw + 0.05));
          line = max(line, lineAt(a - hl + 3.0));
          col = mix(col, vec3(0.92), line);
        } else {
          // Beachvolleyball: Sand
          col = vec3(0.5, 0.4, 0.24) * (0.85 + 0.2 * hash(floor(p * 10.0)));
          line = lineAt(a - 8.0) * step(b, 4.0) + lineAt(b - 4.0) * step(a, 8.0);
          col = mix(col, vec3(0.2, 0.3, 0.7), clamp(line, 0.0, 1.0));
        }
        diffuseColor.rgb = col;`);
  };
  mat.customProgramCacheKey = () => 'nw3d-pitch-v1';
  return mat;
}

function fieldMesh(rect, L, W, kind, groundAt, lift = 0.08) {
  const nu = Math.max(2, Math.ceil(L / 2)), nv = Math.max(2, Math.ceil(W / 2));
  const pos = [], fld = [], idx = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const a = -L / 2 + (L * i) / nu, b = -W / 2 + (W * j) / nv;
    const x = rect.cx + rect.ux * a + rect.vx * b, z = rect.cz + rect.uz * a + rect.vz * b;
    pos.push(x, groundAt(x, z) + lift, z);
    fld.push(a, b);
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const k = j * (nu + 1) + i;
    idx.push(k, k + nu + 1, k + 1, k + 1, k + nu + 1, k + nu + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aField', new THREE.Float32BufferAttribute(fld, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Normalen nach oben (Gelände ist hier eben)
  const n = g.attributes.normal; for (let i = 0; i < n.count; i++) { if (n.getY(i) < 0) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i)); }
  const m = new THREE.Mesh(g, pitchMaterial({ L, W, kind }));
  m.receiveShadow = true;
  return m;
}

function netTexture() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function addGoal(group, rect, a, groundAt, netTex) {
  const white = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.4 });
  const dir = Math.sign(a);
  const at = (aa, b) => { const x = rect.cx + rect.ux * aa + rect.vx * b, z = rect.cz + rect.uz * aa + rect.vz * b; return new THREE.Vector3(x, groundAt(x, z), z); };
  // lokales −z (Netz) zeigt vom Spielfeld weg, lokales x entlang der Torlinie
  const ox = rect.ux * dir, oz = rect.uz * dir;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-ox, -oz));
  const g = new THREE.Group();
  const post = new THREE.CylinderGeometry(0.06, 0.06, 2.44, 10).translate(0, 1.22, 0);
  for (const b of [-3.66, 3.66]) { const m = new THREE.Mesh(post, white); m.position.set(b, 0, 0); g.add(m); }
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 7.44, 10).rotateZ(Math.PI / 2).translate(0, 2.44, 0), white);
  g.add(bar);
  // Netz
  const netMat = new THREE.MeshBasicMaterial({ map: netTex, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, color: 0xffffff });
  const mk = (w, h, rep) => { const t = netTex.clone(); t.repeat.set(w / 0.12, h / 0.12); t.needsUpdate = true; return new THREE.MeshBasicMaterial({ map: t, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide }); };
  const back = new THREE.Mesh(new THREE.PlaneGeometry(7.32, 2.0), mk(7.32, 2.0)); back.position.set(0, 1.0, -2.0 * 1); g.add(back);
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(7.32, 2.1), mk(7.32, 2.1)); roof.rotation.x = Math.PI / 2 - 0.22; roof.position.set(0, 2.22, -1.0); g.add(roof);
  for (const b of [-3.66, 3.66]) {
    const side = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 2.44), mk(2.0, 2.44)); side.rotation.y = Math.PI / 2; side.position.set(b, 1.22, -1.0); g.add(side);
  }
  void netMat;
  const p = at(a, 0);
  g.position.copy(p);
  g.quaternion.copy(q);
  g.traverse((o) => { if (o.isMesh && o.material === white) o.castShadow = true; });
  group.add(g);
}

function addFloodlight(group, pos, lookAt) {
  const metal = new THREE.MeshStandardMaterial({ color: 0x9aa0a4, roughness: 0.5, metalness: 0.7 });
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.28, 16, 10).translate(0, 8, 0), metal);
  mast.position.copy(pos); mast.castShadow = true;
  const head = new THREE.Group();
  head.add(new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.0, 0.25), metal));
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xf2f4f5, roughness: 0.2, metalness: 0.1 });
  for (let i = 0; i < 4; i++) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.12), lampMat); l.position.set(-0.8 + i * 0.55, 0, 0.17); head.add(l); }
  head.position.set(pos.x, pos.y + 16.2, pos.z);
  head.lookAt(lookAt.x, pos.y + 4, lookAt.z);
  head.traverse((o) => { o.castShadow = true; });
  group.add(mast, head);
}

function addVolleyNet(group, rect, groundAt) {
  const metal = new THREE.MeshStandardMaterial({ color: 0xd0d0d0, roughness: 0.4, metalness: 0.6 });
  const at = (b) => { const x = rect.cx + rect.vx * b, z = rect.cz + rect.vz * b; return new THREE.Vector3(x, groundAt(x, z), z); };
  for (const b of [-5, 5]) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.55, 8).translate(0, 1.27, 0), metal); p.position.copy(at(b)); p.castShadow = true; group.add(p); }
  const t = netTexture(); t.repeat.set(10 / 0.1, 1 / 0.1);
  const net = new THREE.Mesh(new THREE.PlaneGeometry(10, 1), new THREE.MeshBasicMaterial({ map: t, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, color: 0x222222 }));
  const c = at(0); net.position.set(c.x, c.y + 1.93, c.z);
  net.rotation.y = Math.atan2(rect.ux, rect.uz);
  group.add(net);
}

// ------------------------------------------------------------------ Aufbau
export function buildLandmarks({ meta, buildingsRaw, osm, groundAt }) {
  const group = new THREE.Group();
  group.name = 'landmarks';
  const fps = buildingsRaw.map((b) => ({ b, ...footprint(b) }));
  const poi = (key) => meta.pois.find((p) => p.key === key);

  const findBuilding = (x, z, pred = () => true) => {
    const inside = fps.find((f) => f.poly.length && pred(f.b) && pointInPoly(x, z, f.poly));
    if (inside) return inside;
    let best = null;
    for (const f of fps) { if (!pred(f.b)) continue; const d = Math.hypot(f.cx - x, f.cz - z); if (!best || d < best.d) best = { ...f, d }; }
    return best && best.d < 35 ? best : null;
  };
  // Richtung von einem Punkt zur nächstgelegenen Fahrstraße
  const roads = osm.filter((f) => f.g && /primary|secondary|tertiary|residential|unclassified|living_street|service/.test(f.tags.highway || ''));
  const toRoad = (x, z) => {
    let best = null;
    for (const f of roads) for (let i = 1; i < f.g.length; i++) {
      const [ax, az] = f.g[i - 1], [bx, bz] = f.g[i];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(px - x, pz - z);
      if (!best || d < best.d) best = { d, dx: (px - x) / (d || 1), dz: (pz - z) / (d || 1) };
    }
    return best;
  };
  const facadeToRoad = (f, minLen = 3) => pickFacade(f.b, toRoad, minLen, [f.cx, f.cz],
    (x, z) => fps.some((o) => o.b !== f.b && o.poly.length && Math.abs(o.cx - x) < 60 && Math.abs(o.cz - z) < 60 && pointInPoly(x, z, o.poly)));
  const report = {};

  // --- Gasthaus Lüdeke
  {
    const f = findBuilding(poi('gasthaus').x, poi('gasthaus').z, (b) => /Gasthaus/.test(b.osm?.name || ''));
    const fa = f && facadeToRoad(f);
    if (fa) {
      const signY = Math.min(f.ground + 3.6, fa.y1 - 0.5);
      addSign(group, fa, { u: fa.mid, y: signY, width: Math.min(5.5, fa.len * 0.6), height: 1.1,
        lines: [{ text: 'Lüdekes Gasthaus', size: 0.8, font: 'Georgia, serif', italic: true }, { text: '„Zum Hombachtal“', size: 1.1, font: 'Georgia, serif' }],
        bg: '#1f3a2b', fg: '#efe6c8', border: '#c9b47a' });
      addDoor(group, fa, { u: fa.mid, ground: f.ground, color: 0x4a2c1a });
      addTerrace(group, fa, { count: Math.max(2, Math.min(4, Math.floor(fa.len / 4))), ground: f.ground, groundAt });
      report.gasthaus = f.b.id;
    }
  }

  // --- Dorfladen „Dorfmarkt & Landstube“
  {
    const p = poi('dorfladen');
    const f = findBuilding(p.x, p.z, (b) => !/Kirche/.test(b.osm?.name || '') && b.fn !== '51009_1610');
    const fa = f && facadeToRoad(f);
    if (fa) {
      const signY = Math.min(f.ground + 3.3, fa.y1 - 0.45);
      addSign(group, fa, { u: fa.mid, y: signY, width: Math.min(6, fa.len * 0.7), height: 0.9,
        lines: [{ text: 'Dorfmarkt & Landstube', size: 1 }], bg: '#f5f1e6', fg: '#2f6b2a', border: '#2f6b2a', font: 'Trebuchet MS, Arial' });
      const sw = Math.min(3.2, fa.len * 0.3);
      addShopWindow(group, fa, { u: fa.mid - 0.9 - sw / 2 - 0.3, w: sw, h: 1.9, ground: f.ground });
      addDoor(group, fa, { u: fa.mid, w: 1.4, h: 2.25, ground: f.ground, glass: true });
      const bp = onFacade(fa, fa.mid + 2.4, 0, 1.2); bp.y = groundAt(bp.x, bp.z);
      addBench(group, bp, Math.atan2(fa.nx, fa.nz));
      for (const du of [-1.3, 1.3]) { const pp = onFacade(fa, fa.mid + du, 0, 0.6); pp.y = groundAt(pp.x, pp.z); addPlanter(group, pp); }
      report.dorfladen = f.b.id;
    }
  }

  // --- Grundschule
  {
    const p = poi('schule');
    const f = findBuilding(p.x, p.z, (b) => /^31001_30/.test(b.fn) || b.osm?.building === 'school' || true);
    const fa = f && facadeToRoad(f);
    if (fa) {
      addSign(group, fa, { u: fa.mid, y: Math.min(f.ground + 3.4, fa.y1 - 0.6), width: Math.min(8, fa.len * 0.6), height: 0.7, letters: true, w: 2048, h: 180,
        lines: [{ text: 'Grundschule Nordwohlde' }], fg: '#2b2f33', font: 'Arial' });
      addDoor(group, fa, { u: fa.mid, w: 2.0, h: 2.4, ground: f.ground, glass: true });
      // Vordach über dem Eingang
      const canopy = new THREE.Mesh(new THREE.BoxGeometry(4, 0.18, 2.2), new THREE.MeshStandardMaterial({ color: 0xe8e8e6, roughness: 0.6 }));
      canopy.position.copy(onFacade(fa, fa.mid, f.ground + 2.9, 1.1)); canopy.quaternion.copy(facadeQuat(fa)); canopy.castShadow = true;
      group.add(canopy);
      report.schule = f.b.id;
    }
  }

  // --- Feuerwehr (Neubau 2025, Klinker)
  {
    const p = poi('feuerwehr');
    // Fahrzeughalle = größtes Gebäude des Feuerwehr-Ensembles (LoD2-Funktion 3072 oder direkt daneben)
    const area = (poly) => Math.abs(poly.reduce((a, [x1, z1], i) => { const [x2, z2] = poly[(i + 1) % poly.length]; return a + x1 * z2 - x2 * z1; }, 0) / 2);
    const cands = fps.filter((x) => x.poly.length && (x.b.fn === '31001_3072' || (Math.hypot(x.cx - p.x, x.cz - p.z) < 30 && /^31001_(2000|3)/.test(x.b.fn))));
    const f = cands.sort((a, b) => area(b.poly) - area(a.poly))[0];
    if (f) {
      // Hallenfassade: längste, ausreichend hohe Wand Richtung Straße
      const fa = facadeToRoad(f, 8);
      if (fa) {
        const eaveRel = (f.b.eave ?? fa.y1) - f.ground;
        // Platz für den Schriftzug zwischen Tor und Traufe lassen
        const h = Math.min(4.2, eaveRel - 1.25, fa.y1 - f.ground - 1.25);
        const count = Math.max(1, Math.min(3, Math.floor((fa.len - 1.5) / 4.9)));
        const total = h > 2.5 ? addGarageDoors(group, fa, { count, h, ground: f.ground }) : 0;
        addSign(group, fa, { u: fa.mid, y: f.ground + Math.max(h, 0) + 0.55, width: Math.min(Math.max(total * 0.75, 5), fa.len * 0.7), height: 0.7, w: 2048, h: 256,
          lines: [{ text: 'FEUERWEHR' }], bg: '#f4f4f2', fg: '#c3201a', font: 'Arial Black, Arial' });
        report.feuerwehr = f.b.id;
      }
    }
  }

  // --- Sporthalle
  {
    const p = poi('sporthalle');
    const f = findBuilding(p.x, p.z, (b) => /^31001_3/.test(b.fn) || true);
    const fa = f && facadeToRoad(f);
    if (fa) {
      addSign(group, fa, { u: fa.mid, y: Math.min(f.ground + 4.2, fa.y1 - 0.7), width: Math.min(6, fa.len * 0.5), height: 0.8, letters: true, w: 1536, h: 200,
        lines: [{ text: 'Sporthalle' }], fg: '#1d4f8f', font: 'Arial' });
      addDoor(group, fa, { u: fa.mid, w: 2.2, h: 2.4, ground: f.ground, glass: true });
      report.sporthalle = f.b.id;
    }
  }

  // --- Vereinsheim des TV Einigkeit
  {
    const f = fps.find((x) => x.b.osm?.name === 'Vereinsheim');
    if (f) {
      const fa = facadeToRoad(f);
      if (fa) addSign(group, fa, { u: fa.mid, y: Math.min(f.ground + 2.8, fa.y1 - 0.4), width: Math.min(5, fa.len * 0.7), height: 0.8,
        lines: [{ text: 'TV Einigkeit', size: 1.1 }, { text: 'Nordwohlde', size: 0.8 }], bg: '#ffffff', fg: '#1d4f8f', border: '#1d4f8f' });
    }
  }

  // --- Sportplatz
  {
    const netTex = netTexture();
    const pitches = osm.filter((f) => f.tags.leisure === 'pitch' && f.g && f.g.length >= 5);
    let fields = 0;
    for (const pf of pitches) {
      const sport = pf.tags.sport;
      const rect = minRect(pf.g.slice(0, -1));
      if (sport === 'soccer') {
        const L = Math.min(105, rect.L - 4), W = Math.min(68, rect.W - 4);
        group.add(fieldMesh(rect, L, W, 0, groundAt));
        addGoal(group, rect, L / 2, groundAt, netTex);
        addGoal(group, rect, -L / 2, groundAt, netTex);
        for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
          const a = sa * L / 4, b = sb * (W / 2 + 4);
          const x = rect.cx + rect.ux * a + rect.vx * b, z = rect.cz + rect.uz * a + rect.vz * b;
          addFloodlight(group, new THREE.Vector3(x, groundAt(x, z), z), new THREE.Vector3(rect.cx + rect.ux * a, 0, rect.cz + rect.uz * a));
        }
        fields++;
      } else if (sport === 'athletics') {
        group.add(fieldMesh(rect, rect.L, rect.W, 1, groundAt));
      } else if (sport === 'volleyball' || sport === 'beachvolleyball') {
        group.add(fieldMesh(rect, rect.L, rect.W, 2, groundAt));
        addVolleyNet(group, rect, groundAt);
      }
    }
    report.sportfelder = fields;
  }

  group.userData.report = report;
  return bakeStatic(group);
}

/**
 * Fasst alle statischen Einzelteile mit gleichem Material zu einem Mesh zusammen
 * (weniger Zeichenaufrufe – wichtig für Handys).
 */
function bakeStatic(group) {
  group.updateMatrixWorld(true);
  const buckets = new Map();
  const keep = [];
  group.traverse((o) => {
    if (!o.isMesh) return;
    if (Array.isArray(o.material) || o.isInstancedMesh) { keep.push(o); return; }
    const attrs = Object.keys(o.geometry.attributes).sort().join(',');
    const key = `${o.material.uuid}|${attrs}|${o.castShadow}`;
    if (!buckets.has(key)) buckets.set(key, { material: o.material, cast: o.castShadow, receive: o.receiveShadow, geos: [] });
    const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(o.matrixWorld);
    buckets.get(key).geos.push(g);
  });
  const out = new THREE.Group();
  out.name = group.name;
  out.userData = group.userData;
  for (const b of buckets.values()) {
    const merged = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos);
    if (!merged) continue;
    const m = new THREE.Mesh(merged, b.material);
    m.castShadow = b.cast; m.receiveShadow = b.receive;
    out.add(m);
  }
  for (const o of keep) {
    const c = o.clone();
    o.matrixWorld.decompose(c.position, c.quaternion, c.scale);
    out.add(c);
  }
  return out;
}
