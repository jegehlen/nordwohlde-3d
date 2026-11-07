// Bäume, Büsche und Hecken – Positionen, Höhen und Kronenbreiten aus DOM1 − DGM1 (LGLN).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getNoiseTexture } from './noise.js';

const rng = (seed) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

/** Unregelmäßiger „Blob“: Ikosaeder mit verrauschten Radien. */
function blob(detail, r, seed) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const rand = rng(seed);
  const bumps = Array.from({ length: 6 }, () => [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1, 0.1 + rand() * 0.15]);
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    let k = 1;
    for (const [bx, by, bz, a] of bumps) k += a * Math.max(0, v.x * bx + v.y * by + v.z * bz);
    // deterministisch aus der Richtung (gleiche Ecken → gleicher Wert, sonst entstehen Risse)
    k += 0.06 * Math.sin(v.x * 12.9898 + v.y * 78.233 + v.z * 37.719 + seed);
    p.setXYZ(i, v.x * r * k, v.y * r * k, v.z * r * k);
  }
  g.computeVertexNormals();
  return g;
}

/** Normalen Richtung „von der Kronenmitte nach außen“ mischen → weiche, runde Schattierung statt Facetten. */
function softenNormals(g, k, center = new THREE.Vector3()) {
  const p = g.attributes.position, n = g.attributes.normal, v = new THREE.Vector3(), w = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).sub(center).normalize();
    w.fromBufferAttribute(n, i).multiplyScalar(1 - k).addScaledVector(v, k).normalize();
    n.setXYZ(i, w.x, w.y, w.z);
  }
  n.needsUpdate = true;
}

/** Laubbaumkrone: mehrere überlappende Blobs, normiert auf Radius 1 / Höhe −1…1. */
function deciduousCrown(detail, blobs) {
  const rand = rng(4242);
  const parts = [blob(detail, 0.72, 1).translate(0, 0.05, 0)];
  for (let i = 1; i < blobs; i++) {
    const a = (i / (blobs - 1)) * Math.PI * 2 + rand(), rr = 0.42 + rand() * 0.12;
    parts.push(blob(detail, 0.48 + rand() * 0.12, i + 7).translate(Math.cos(a) * rr, (rand() - 0.4) * 0.55, Math.sin(a) * rr));
  }
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
  g.computeBoundingBox();
  const bb = g.boundingBox;
  const sx = 2 / (bb.max.x - bb.min.x), sy = 2 / (bb.max.y - bb.min.y), sz = 2 / (bb.max.z - bb.min.z);
  g.translate(-(bb.max.x + bb.min.x) / 2, -(bb.max.y + bb.min.y) / 2, -(bb.max.z + bb.min.z) / 2).scale(sx, sy, sz);
  softenNormals(g, 0.7);
  return g;
}

/** Nadelbaumkrone: gestapelte, unregelmäßige Kegel; normiert auf Radius 1 / Höhe 0…1. */
function coniferCrown(segments) {
  const parts = [];
  const tiers = 4;
  for (let t = 0; t < tiers; t++) {
    const y0 = t / tiers * 0.8, h = 0.42 - t * 0.04, r = 1 - t * 0.2;
    const c = new THREE.ConeGeometry(r, h, segments, 1, true).translate(0, y0 + h / 2, 0);
    const p = c.attributes.position, rand = rng(t + 3);
    for (let i = 0; i < p.count; i++) if (p.getY(i) < y0 + h * 0.5) { p.setX(i, p.getX(i) * (0.85 + rand() * 0.3)); p.setZ(i, p.getZ(i) * (0.85 + rand() * 0.3)); }
    c.computeVertexNormals();
    parts.push(c.toNonIndexed());
  }
  const top = new THREE.ConeGeometry(0.35, 0.3, segments, 1).translate(0, 0.85, 0);
  parts.push(top.toNonIndexed());
  const g = mergeGeometries(parts);
  g.computeBoundingBox();
  g.scale(1, 1 / g.boundingBox.max.y, 1);
  softenNormals(g, 0.45, new THREE.Vector3(0, 0.35, 0));
  return g;
}

/** Laubmaterial: Farbvariation pro Instanz, „Blätterbüschel“ durch verrauschte Normalen, dunkleres Inneres. */
function makeFoliageMaterial(noiseTex, { translucency = 0.25 } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.noiseTex = { value: noiseTex };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos; varying float vLocalY;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLocalY = position.y;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D noiseTex; varying vec3 vWPos; varying float vLocalY;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float n1 = texture2D(noiseTex, vWPos.xz * 0.35 + vWPos.y * 0.21).g;
        float n2 = texture2D(noiseTex, vWPos.zy * 0.5 + vWPos.x * 0.13).g;
        float leaf = n1 * 0.6 + n2 * 0.4;
        diffuseColor.rgb *= (0.74 + 0.52 * leaf) * mix(0.62, 1.08, clamp(vLocalY * 0.5 + 0.5, 0.0, 1.0));`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        vec3 pn = vec3(texture2D(noiseTex, vWPos.xy * 0.8).g, texture2D(noiseTex, vWPos.yz * 0.8).g, texture2D(noiseTex, vWPos.zx * 0.8).g) - 0.5;
        normal = normalize(normal + pn * 0.65);`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // etwas durchscheinendes Licht im Laub
        reflectedLight.indirectDiffuse += diffuseColor.rgb * ${translucency.toFixed(2)} * 0.5;`);
  };
  mat.customProgramCacheKey = () => `nw3d-foliage-${translucency}`;
  return mat;
}

export async function buildVegetation({ url, quality, renderer }) {
  const data = await (await fetch(url)).json();
  const lo = quality.name === 'lo';
  const noiseTex = getNoiseTexture(renderer);
  const group = new THREE.Group();
  group.name = 'vegetation';

  const T = data.trees.data, TS = data.trees.stride;
  const nTrees = T.length / TS;
  const dec = [], con = [];
  for (let i = 0; i < nTrees; i++) (T[i * TS + 5] ? con : dec).push(i);

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();
  const rand = rng(2024);

  // Laubbäume (Eiche, Buche, Linde … – Spätsommer)
  const decGreens = ['#4a6a28', '#56742c', '#425f25', '#617833', '#4d6e30', '#5a6c2a', '#668238'];
  // Handy: 3 grobe Blobs (60 Dreiecke) statt 6 feiner (480) – mit weichen Normalen kaum sichtbar
  const crownGeo = deciduousCrown(lo ? 0 : 1, lo ? 3 : 6);
  const crowns = new THREE.InstancedMesh(crownGeo, makeFoliageMaterial(noiseTex), dec.length);
  const trunkGeo = new THREE.CylinderGeometry(0.6, 1, 1, lo ? 5 : 7, 1).translate(0, 0.5, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3f35, roughness: 0.95 });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, nTrees);
  let ti = 0;
  dec.forEach((i, k) => {
    const x = T[i * TS], z = T[i * TS + 1], gy = T[i * TS + 2], h = T[i * TS + 3], r = T[i * TS + 4];
    const crownH = Math.min(h - 1.5, Math.max(h * 0.72, r * 1.7));
    const cy = gy + h - crownH / 2;
    q.setFromAxisAngle(up, rand() * Math.PI * 2);
    s.set(r * (0.95 + rand() * 0.15), crownH / 2, r * (0.95 + rand() * 0.15));
    crowns.setMatrixAt(k, m.compose(p.set(x, cy, z), q, s));
    color.set(decGreens[Math.floor(rand() * decGreens.length)]).convertSRGBToLinear().multiplyScalar(0.85 + rand() * 0.3);
    crowns.setColorAt(k, color);
    const tr = Math.max(0.12, Math.min(0.55, h * 0.022 + r * 0.03));
    trunks.setMatrixAt(ti++, m.compose(p.set(x, gy - 0.3, z), q, s.set(tr, h - crownH * 0.6 + 0.3, tr)));
  });

  // Nadelbäume (Fichte, Kiefer)
  const conGreens = ['#26391f', '#2c4424', '#22341d', '#304a2a'];
  const conGeo = coniferCrown(lo ? 6 : 9);
  const conifers = new THREE.InstancedMesh(conGeo, makeFoliageMaterial(noiseTex, { translucency: 0.1 }), con.length);
  con.forEach((i, k) => {
    const x = T[i * TS], z = T[i * TS + 1], gy = T[i * TS + 2], h = T[i * TS + 3], r = T[i * TS + 4];
    const base = gy + h * 0.22;
    q.setFromAxisAngle(up, rand() * Math.PI * 2);
    conifers.setMatrixAt(k, m.compose(p.set(x, base, z), q, s.set(Math.max(1.2, r * 1.05), h * 0.78, Math.max(1.2, r * 1.05))));
    color.set(conGreens[Math.floor(rand() * conGreens.length)]).convertSRGBToLinear().multiplyScalar(0.85 + rand() * 0.3);
    conifers.setColorAt(k, color);
    const tr = Math.max(0.12, h * 0.018);
    trunks.setMatrixAt(ti++, m.compose(p.set(x, gy - 0.3, z), q, s.set(tr, h * 0.3, tr)));
  });
  trunks.count = ti;

  // Büsche & Hecken
  const B = data.bushes.data, BS = data.bushes.stride, nAll = B.length / BS;
  // Handy: jeden zweiten Punkt, dafür etwas größere Büsche
  const stepB = lo ? 2 : 1, grow = lo ? 1.3 : 1;
  const nB = Math.ceil(nAll / stepB);
  const bushGeo = blob(lo ? 0 : 1, 1, 99);
  const bushes = new THREE.InstancedMesh(bushGeo, makeFoliageMaterial(noiseTex, { translucency: 0.2 }), nB);
  const bushGreens = ['#41602a', '#4b6a2c', '#38552a', '#56722f', '#3f5a26'];
  for (let j = 0, k = 0; j < nAll; j += stepB, k++) {
    const x = B[j * BS] + (rand() - 0.5) * 0.6, z = B[j * BS + 1] + (rand() - 0.5) * 0.6, gy = B[j * BS + 2], h = B[j * BS + 3];
    const rr = (1.15 + rand() * 0.35) * grow;
    q.setFromAxisAngle(up, rand() * Math.PI * 2);
    bushes.setMatrixAt(k, m.compose(p.set(x, gy + h * 0.45, z), q, s.set(rr, h * 0.6, rr)));
    color.set(bushGreens[Math.floor(rand() * bushGreens.length)]).convertSRGBToLinear().multiplyScalar(0.8 + rand() * 0.35);
    bushes.setColorAt(k, color);
  }

  for (const im of [crowns, conifers, trunks, bushes]) {
    im.castShadow = !(lo && im === bushes);
    im.receiveShadow = true;
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    group.add(im);
  }
  group.userData.stats = { deciduous: dec.length, conifers: con.length, bushes: nB };
  return group;
}
