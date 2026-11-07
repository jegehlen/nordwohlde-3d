// Ergänzungen: Gewässer, Gebäude-Kollision, Ortsbeschriftungen, Kompass, adaptive Auflösung.
import * as THREE from 'three';
import earcut from 'earcut';
import { getNoiseTexture } from './noise.js';

// ------------------------------------------------------------------ Gewässer (Hombach, Gräben, Teiche)
const WATER_WIDTH = { river: 8, canal: 5, stream: 2.2, ditch: 1.6, drain: 1.2 };

function makeWaterMaterial(noiseTex) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x16211c, roughness: 0.14, metalness: 0.0,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  mat.userData.time = { value: 0 };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.noiseTex = { value: noiseTex };
    shader.uniforms.uTime = mat.userData.time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D noiseTex; uniform float uTime; varying vec3 vWW;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec2 uv1 = vWW.xz * 0.35 + vec2(uTime * 0.03, uTime * 0.017);
          vec2 uv2 = vWW.xz * 0.9 - vec2(uTime * 0.021, uTime * 0.04);
          float a = texture2D(noiseTex, uv1).g - 0.5, b = texture2D(noiseTex, uv2).g - 0.5;
          float c = texture2D(noiseTex, uv1 + 0.37).g - 0.5, d = texture2D(noiseTex, uv2 + 0.61).g - 0.5;
          vec3 ripple = normalize(vec3((a + b) * 0.35, 1.0, (c + d) * 0.35));
          normal = normalize((viewMatrix * vec4(ripple, 0.0)).xyz);
        }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        diffuseColor.rgb *= 0.85 + 0.3 * texture2D(noiseTex, vWW.xz * 0.05).r;`);
  };
  mat.customProgramCacheKey = () => 'nw3d-water-v1';
  return mat;
}

export function buildWater({ osm, groundAt, renderer, bounds }) {
  const pos = [], idx = [];
  const addVert = (x, y, z) => { pos.push(x, y, z); return pos.length / 3 - 1; };

  for (const f of osm) {
    const w = WATER_WIDTH[f.tags.waterway];
    if (!w || !f.g || f.tags.tunnel || f.tags.layer < 0) continue;
    const pts = [];
    for (let i = 0; i < f.g.length; i++) {
      const [ax, az] = f.g[i];
      if (Math.abs(ax) > bounds || Math.abs(az) > bounds) continue;
      if (pts.length) {
        const [px, pz] = pts[pts.length - 1];
        const n = Math.ceil(Math.hypot(ax - px, az - pz) / 2);
        for (let k = 1; k < n; k++) pts.push([px + ((ax - px) * k) / n, pz + ((az - pz) * k) / n]);
      }
      pts.push([ax, az]);
    }
    if (pts.length < 2) continue;
    const base = pos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let tx = b[0] - a[0], tz = b[1] - a[1]; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const [x, z] = pts[i];
      const lx = x - tz * w / 2, lz = z + tx * w / 2, rx = x + tz * w / 2, rz = z - tx * w / 2;
      // Wasserspiegel: tiefster Punkt im Querschnitt + etwas Wasserstand
      const y = Math.min(groundAt(x, z), groundAt(lx, lz), groundAt(rx, rz)) + 0.22;
      addVert(lx, y, lz); addVert(rx, y, rz);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const k = base + i * 2;
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  // Teiche / stehende Gewässer
  for (const f of osm) {
    if (!(f.tags.natural === 'water' || f.tags.landuse === 'basin' || f.tags.water) || !f.g || f.g.length < 4) continue;
    const ring = f.g.slice(0, -1).filter(([x, z]) => Math.abs(x) < bounds && Math.abs(z) < bounds);
    if (ring.length < 3) continue;
    const y = Math.min(...ring.map(([x, z]) => groundAt(x, z))) + 0.15;
    const tri = earcut(ring.flat());
    const base = pos.length / 3;
    for (const [x, z] of ring) addVert(x, y, z);
    for (let t = 0; t < tri.length; t += 3) idx.push(base + tri[t], base + tri[t + 2], base + tri[t + 1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Normalen nach oben ausrichten (Wicklung kann je nach Linienrichtung wechseln)
  const n = g.attributes.normal; for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  const mat = makeWaterMaterial(getNoiseTexture(renderer));
  mat.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'water';
  mesh.receiveShadow = true;
  mesh.userData.update = (t) => { mat.userData.time.value = t; };
  return mesh;
}

// ------------------------------------------------------------------ Gebäude als Hindernis
function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Liefert (x, z) → Dachhöhe des Gebäudes an dieser Stelle oder -Infinity. */
export function makeObstacleSampler(buildingsRaw) {
  const CELL = 20, grid = new Map();
  for (const b of buildingsRaw) {
    let top = -Infinity;
    for (const s of b.surfaces) for (const r of s.r) for (let k = 1; k < r.length; k += 3) top = Math.max(top, r[k]);
    const g = b.surfaces.find((s) => s.t === 'G'); if (!g) continue;
    const poly = []; for (let k = 0; k < g.r[0].length; k += 3) poly.push([g.r[0][k], g.r[0][k + 2]]);
    const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
    const e = { poly, top };
    for (let gx = Math.floor(Math.min(...xs) / CELL); gx <= Math.floor(Math.max(...xs) / CELL); gx++)
      for (let gz = Math.floor(Math.min(...zs) / CELL); gz <= Math.floor(Math.max(...zs) / CELL); gz++) {
        const k = `${gx},${gz}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(e);
      }
  }
  return (x, z) => {
    const list = grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
    if (!list) return -Infinity;
    let top = -Infinity;
    for (const e of list) if (e.top > top && pointInPoly(x, z, e.poly)) top = e.top;
    return top;
  };
}

// ------------------------------------------------------------------ Ortsbeschriftungen
export class PlaceLabels {
  constructor(pois, groundAt, container) {
    this.items = pois.map((p) => {
      const el = document.createElement('div');
      el.className = 'place-label';
      el.textContent = p.name.replace(/^Dorfladen /, 'Dorfladen ');
      container.append(el);
      return { el, pos: new THREE.Vector3(p.x, Math.max(p.y, groundAt(p.x, p.z)) + (p.key === 'b51' ? 6 : 16), p.z), key: p.key };
    });
    this.enabled = true;
    this.v = new THREE.Vector3();
  }
  setEnabled(on) { this.enabled = on; for (const it of this.items) it.el.style.display = on ? '' : 'none'; }
  update(camera, w, h) {
    if (!this.enabled) return;
    for (const it of this.items) {
      const d = camera.position.distanceTo(it.pos);
      this.v.copy(it.pos).project(camera);
      const visible = this.v.z < 1 && Math.abs(this.v.x) < 1.1 && Math.abs(this.v.y) < 1.1 && d < 1400 && d > 12;
      if (!visible) { it.el.style.opacity = '0'; continue; }
      const x = (this.v.x * 0.5 + 0.5) * w, y = (-this.v.y * 0.5 + 0.5) * h;
      it.el.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      it.el.style.opacity = String(Math.min(1, Math.max(0, (1400 - d) / 500)));
      it.el.style.zIndex = String(Math.round(10000 - d));
    }
  }
}

// ------------------------------------------------------------------ Adaptive Auflösung
export class AdaptiveResolution {
  constructor(renderer, maxRatio, minRatio = 0.6) {
    this.r = renderer; this.max = maxRatio; this.min = Math.min(minRatio, maxRatio);
    this.ratio = maxRatio; this.acc = 0; this.frames = 0; this.cooldown = 2;
  }
  update(dt) {
    if (document.hidden || dt <= 0 || dt > 0.5) return;
    this.acc += dt; this.frames++; this.cooldown -= dt;
    if (this.acc < 1.5) return;
    const avg = this.acc / this.frames;
    this.acc = 0; this.frames = 0;
    if (this.cooldown > 0) return;
    let next = this.ratio;
    if (avg > 1 / 32 && this.ratio > this.min) next = Math.max(this.min, this.ratio - 0.15);
    else if (avg < 1 / 55 && this.ratio < this.max) next = Math.min(this.max, this.ratio + 0.1);
    if (next !== this.ratio) {
      this.ratio = next;
      this.r.setPixelRatio(next);
      this.cooldown = 3;
    }
  }
}
