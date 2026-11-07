// Kachelbare Rauschtextur (mehrere Oktaven) für Straßen, Vegetation und Details.
import * as THREE from 'three';

let cached = null;
export function getNoiseTexture(renderer) {
  if (cached) return cached;
  const S = 256;
  // Wertrauschen auf kachelbaren Gittern
  const octave = (cells, seed) => {
    let s = seed;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const g = Array.from({ length: cells * cells }, rnd);
    const out = new Float32Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const fx = (x / S) * cells, fy = (y / S) * cells;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const v = (i, j) => g[((y0 + j) % cells) * cells + ((x0 + i) % cells)];
      out[y * S + x] = (v(0, 0) * (1 - sx) + v(1, 0) * sx) * (1 - sy) + (v(0, 1) * (1 - sx) + v(1, 1) * sx) * sy;
    }
    return out;
  };
  const o1 = octave(4, 11), o2 = octave(16, 23), o3 = octave(64, 37), o4 = octave(128, 51);
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    img.data[i * 4] = Math.round(255 * (0.5 * o1[i] + 0.3 * o2[i] + 0.2 * o3[i])); // grob
    img.data[i * 4 + 1] = Math.round(255 * (0.6 * o3[i] + 0.4 * o4[i]));            // fein
    img.data[i * 4 + 2] = Math.round(255 * o2[i]);                                   // mittel
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  cached = tex;
  return tex;
}
