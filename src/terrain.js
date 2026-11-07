// Gelände: Höhenraster (LGLN DGM1) + Luftbild (LGLN DOP20)
import * as THREE from 'three';
import { getNoiseTexture } from './noise.js';

/** Lädt ein Uint16-Höhenraster (cm, Versatz 100 m) und liefert Float-Höhen in Szenen-Metern. */
export async function loadHeightGrid(url, meta, onProgress) {
  const buf = await fetchWithProgress(url, onProgress);
  const raw = new Uint16Array(buf);
  const h = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) h[i] = raw[i] / 100 - 100;
  return { h, nx: meta.nx, ny: meta.ny, step: meta.step, size: meta.size[0] };
}

/** Bilineare Höhenabfrage; außerhalb des Rasters wird am Rand geklemmt. */
export function makeHeightSampler(grid) {
  const { h, nx, ny, step, size } = grid;
  const half = size / 2;
  return (x, z) => {
    let fx = (x + half) / step, fz = (z + half) / step;
    fx = Math.min(nx - 1.0001, Math.max(0, fx));
    fz = Math.min(ny - 1.0001, Math.max(0, fz));
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const a = h[j * nx + i], b = h[j * nx + i + 1], c = h[(j + 1) * nx + i], d = h[(j + 1) * nx + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  };
}

/** Kombinierte Abfrage: Kerngebiet (1 m) bevorzugt, sonst Randgebiet (8 m). */
export function makeGroundSampler(coreGrid, outerGrid) {
  const core = makeHeightSampler(coreGrid), outer = makeHeightSampler(outerGrid);
  const ch = coreGrid.size / 2;
  return (x, z) => (Math.abs(x) <= ch && Math.abs(z) <= ch ? core(x, z) : outer(x, z));
}

/**
 * Baut ein Gitter-Mesh über das Rechteck [x0,x0+w]×[z0,z0+w] mit Schrittweite step.
 * heightAt(x,z) liefert die Höhe; Normalen werden aus dem Höhenfeld berechnet.
 */
function buildGridGeometry(x0, z0, w, step, heightAt, { normalDelta = step, yOffsetAt = null } = {}) {
  const n = Math.round(w / step) + 1;
  const pos = new Float32Array(n * n * 3);
  const nor = new Float32Array(n * n * 3);
  const uv = new Float32Array(n * n * 2);
  const d = normalDelta;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = x0 + i * step, z = z0 + j * step;
      const k = j * n + i;
      let y = heightAt(x, z);
      if (yOffsetAt) y += yOffsetAt(x, z);
      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      const dx = (heightAt(x + d, z) - heightAt(x - d, z)) / (2 * d);
      const dz = (heightAt(x, z + d) - heightAt(x, z - d)) / (2 * d);
      const len = Math.hypot(dx, 1, dz);
      nor[k * 3] = -dx / len; nor[k * 3 + 1] = 1 / len; nor[k * 3 + 2] = -dz / len;
      uv[k * 2] = i / (n - 1);
      uv[k * 2 + 1] = 1 - j / (n - 1); // Bildoberkante = Norden = kleinstes z
    }
  }
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let p = 0;
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i, b = a + 1, c = a + n, e = c + 1;
    idx[p++] = a; idx[p++] = c; idx[p++] = b;
    idx[p++] = b; idx[p++] = c; idx[p++] = e;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

/** Bodenmaterial: Luftbild + feines Detailrauschen (Gras, Erde), damit der Boden aus der Nähe nicht verwaschen wirkt. */
function makeGroundMaterial(map, noiseTex) {
  const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.95, metalness: 0 });
  // Das Luftbild ist bereits „belichtet“ (Sonne, Schatten). Ebener Boden erhält in der Szene
  // rund 1,4-fache Beleuchtung → abschwächen, damit helle Flächen nicht ins Weiße laufen.
  mat.color.setRGB(0.74, 0.74, 0.74);
  if (!noiseTex) return mat;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.noiseTex = { value: noiseTex };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D noiseTex;\nvarying vec3 vGWorld;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          float d = distance(cameraPosition, vGWorld);
          float fade = 1.0 - smoothstep(60.0, 260.0, d);
          float n1 = texture2D(noiseTex, vGWorld.xz * 1.9).g;
          float n2 = texture2D(noiseTex, vGWorld.xz * 0.37).b;
          // grünliche Flächen bekommen Grasstruktur, übrige feine Körnung
          float green = smoothstep(0.0, 0.06, diffuseColor.g - max(diffuseColor.r, diffuseColor.b));
          float detail = mix(0.9 + 0.2 * n1, 0.78 + 0.44 * n1, green) * (0.94 + 0.12 * n2);
          diffuseColor.rgb *= mix(1.0, detail, fade);
        }`);
  };
  mat.customProgramCacheKey = () => 'nw3d-ground-v1';
  return mat;
}

/** Erzeugt das Kerngebiet als 3×3 Kacheln mit je eigenem Luftbild. */
export async function buildCoreTerrain({ scene: sceneMeta, coreGrid, quality, renderer, base, onProgress }) {
  const group = new THREE.Group();
  group.name = 'terrain-core';
  const heightAt = makeHeightSampler(coreGrid);
  const { grid, tileSize, tiles } = sceneMeta.core.ortho;
  const half = sceneMeta.core.size / 2;
  const loader = new THREE.TextureLoader();
  const aniso = renderer.capabilities.getMaxAnisotropy();
  let done = 0;
  group.userData.textures = {};
  await Promise.all(tiles.map(async (t) => {
    const url = base + t.file.replace('{q}', quality.ortho);
    const tex = await loader.loadAsync(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = aniso;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    group.userData.textures[`${t.i}_${t.j}`] = tex;
    const x0 = -half + t.i * tileSize, z0 = -half + t.j * tileSize;
    const geo = buildGridGeometry(x0, z0, tileSize, quality.terrainStep, heightAt, { normalDelta: Math.max(1, quality.terrainStep) });
    const mesh = new THREE.Mesh(geo, makeGroundMaterial(tex, getNoiseTexture(renderer)));
    mesh.receiveShadow = true;
    mesh.name = `core_${t.i}_${t.j}`;
    group.add(mesh);
    onProgress?.(++done / tiles.length);
  }));
  return group;
}

/** Randgebiet (4×4 km, grob) – im Kernbereich etwas abgesenkt, damit es vom Kern verdeckt wird. */
export async function buildOuterTerrain({ scene: sceneMeta, outerGrid, quality, renderer, base }) {
  const heightAt = makeHeightSampler(outerGrid);
  const size = sceneMeta.outer.size, half = size / 2;
  const coreHalf = sceneMeta.core.size / 2 - outerGrid.step * 1.5;
  const tex = await new THREE.TextureLoader().loadAsync(base + sceneMeta.outer.ortho);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const geo = buildGridGeometry(-half, -half, size, quality.outerStep, heightAt, {
    normalDelta: quality.outerStep,
    yOffsetAt: (x, z) => (Math.abs(x) < coreHalf && Math.abs(z) < coreHalf ? -4 : 0),
  });
  const mesh = new THREE.Mesh(geo, makeGroundMaterial(tex));
  mesh.receiveShadow = true;
  mesh.name = 'terrain-outer';

  // Weiter Boden bis zum Horizont (durch Dunst verdeckt)
  const far = new THREE.Mesh(
    new THREE.RingGeometry(half * 0.98, 13000, 96, 1),
    new THREE.MeshStandardMaterial({ color: 0x6f7d4c, roughness: 1 }),
  );
  far.rotation.x = -Math.PI / 2;
  far.position.y = outerGrid.h.reduce((a, b) => a + b, 0) / outerGrid.h.length - 0.5;
  far.name = 'terrain-far';

  const group = new THREE.Group();
  group.name = 'terrain-outer';
  group.add(mesh, far);
  return group;
}

export async function fetchWithProgress(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const total = +r.headers.get('content-length') || 0;
  if (!r.body || !total || !onProgress) return r.arrayBuffer();
  const reader = r.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress(Math.min(1, got / total));
  }
  const out = new Uint8Array(got); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}
