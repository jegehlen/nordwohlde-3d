import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { loadHeightGrid, makeGroundSampler, buildCoreTerrain, buildOuterTerrain } from './terrain.js';
import { DroneControls } from './controls.js';
import { buildBuildings } from './buildings.js';
import { buildRoads } from './roads.js';
import { buildVegetation } from './vegetation.js';
import { buildLandmarks } from './landmarks.js';
import { buildWater, makeObstacleSampler, PlaceLabels, AdaptiveResolution } from './extras.js';

const BASE = './data/';
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ Qualitätsstufe
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const params = new URLSearchParams(location.search);
const forced = params.get('q');
const low = forced ? forced === 'lo' : isTouch;
const QUALITY = low
  ? { name: 'lo', ortho: 'lo', terrainStep: 4, outerStep: 16, pixelRatio: Math.min(devicePixelRatio, 1.5), shadowMap: 2048, shadowExtent: 150 }
  : { name: 'hi', ortho: 'hi', terrainStep: 2, outerStep: 8, pixelRatio: Math.min(devicePixelRatio, 2), shadowMap: 4096, shadowExtent: 220 };
if (isTouch) document.body.classList.add('touch');

// ------------------------------------------------------------------ Renderer & Szene
const canvas = $('scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (e) {
  $('loader-text').textContent = 'Ihr Browser oder Gerät unterstützt kein WebGL – die 3D-Ansicht kann nicht angezeigt werden.';
  throw e;
}
renderer.setPixelRatio(QUALITY.pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Neutral-Tonemapping erhält die echten Farben des Luftbilds besser als ACES
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // in dieser three.js-Version bereits weich gefiltert

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 14000);

// ------------------------------------------------------------------ Himmel & Licht (sonniger Sommertag)
// Sonnenstand Mitte Juli, ca. 15:30 Uhr MESZ in Nordwohlde: Azimut ~235° (SW), Höhe ~45°
const SUN_AZIMUTH = 235, SUN_ELEVATION = 45;
const sunDir = new THREE.Vector3().setFromSphericalCoords(
  1, THREE.MathUtils.degToRad(90 - SUN_ELEVATION), THREE.MathUtils.degToRad(180 - SUN_AZIMUTH),
);
// setFromSphericalCoords: theta von +z aus; Norden ist -z → Umrechnung über 180° - Azimut

function buildSky() {
  const sky = new Sky();
  sky.scale.setScalar(1000);
  const u = sky.material.uniforms;
  u.turbidity.value = 3.2;
  u.rayleigh.value = 1.3;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.82;
  u.sunPosition.value.copy(sunDir);
  // Himmel einmalig in eine Cube-Map rendern → Hintergrund + Umgebungslicht
  const skyScene = new THREE.Scene();
  skyScene.add(sky);
  const rt = new THREE.WebGLCubeRenderTarget(512, { type: THREE.HalfFloatType });
  const cubeCam = new THREE.CubeCamera(1, 2000, rt);
  cubeCam.update(renderer, skyScene);
  scene.background = rt.texture;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(skyScene, 0.02).texture;
  scene.environmentIntensity = 0.3;
  pmrem.dispose();
}
buildSky();

// Das Luftbild enthält bereits Licht und Schatten – daher moderate Beleuchtung,
// sodass flacher Boden ungefähr seine Originalfarbe zeigt.
const sun = new THREE.DirectionalLight(0xfff3e0, 1.25);
sun.position.copy(sunDir).multiplyScalar(1000);
sun.castShadow = true;
sun.shadow.mapSize.set(QUALITY.shadowMap, QUALITY.shadowMap);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.35;
sun.shadow.intensity = 0.85;
scene.add(sun, sun.target);

// Schattenbereich folgt der Kamera (Ausschnitt vor der Kamera am Boden)
const _fwd = new THREE.Vector3();
function updateShadowFrustum() {
  const agl = Math.max(2, controls.agl);
  const ext = Math.min(520, Math.max(QUALITY.shadowExtent, Math.ceil((agl * 2.4) / 40) * 40));
  camera.getWorldDirection(_fwd); _fwd.y = 0; _fwd.normalize();
  const ahead = Math.min(ext * 0.6, 20 + agl * 1.2);
  const texel = (2 * ext) / QUALITY.shadowMap;
  const fx = Math.round((camera.position.x + _fwd.x * ahead) / texel) * texel;
  const fz = Math.round((camera.position.z + _fwd.z * ahead) / texel) * texel;
  const fy = groundAt(fx, fz);
  sun.target.position.set(fx, fy, fz);
  sun.position.set(fx, fy, fz).addScaledVector(sunDir, 800);
  const cam = sun.shadow.camera;
  if (cam.right !== ext) {
    cam.left = -ext; cam.right = ext; cam.top = ext; cam.bottom = -ext;
    cam.near = 400; cam.far = 1300;
    cam.updateProjectionMatrix();
  }
}
scene.add(new THREE.HemisphereLight(0xd6e6ff, 0x6a7448, 0.42)); // Himmelslicht hellt Schattenseiten auf

// Sommerlicher Dunst in der Ferne – Farbe passend zum Horizont des Himmels
scene.fog = new THREE.FogExp2(0xcbd9e6, 0.00034);

// ------------------------------------------------------------------ Laden
const loaderBar = $('loader-bar'), loaderText = $('loader-text');
const progress = { scene: 0, core: 0, outer: 0, tex: 0, bld: 0 };
const weights = { scene: 0.03, core: 0.4, outer: 0.07, tex: 0.4, bld: 0.1 };
function setProgress(key, v, text) {
  progress[key] = v;
  const total = Object.keys(weights).reduce((a, k) => a + weights[k] * progress[k], 0);
  loaderBar.style.width = `${(total * 100).toFixed(1)}%`;
  if (text) loaderText.textContent = text;
}

let controls, groundAt, meta, labels, water;
const adaptive = new AdaptiveResolution(renderer, QUALITY.pixelRatio, low ? 0.55 : 0.75);

async function init() {
  setProgress('scene', 0, 'Lade Szenenbeschreibung …');
  meta = await (await fetch(BASE + 'scene.json')).json();
  setProgress('scene', 1, 'Lade Geländemodell …');

  const [coreGrid, outerGrid] = await Promise.all([
    loadHeightGrid(BASE + meta.core.terrain.file, meta.core.terrain, (p) => setProgress('core', p)),
    loadHeightGrid(BASE + meta.outer.terrain.file, meta.outer.terrain, (p) => setProgress('outer', p)),
  ]);
  groundAt = makeGroundSampler(coreGrid, outerGrid);

  setProgress('core', 1, 'Lade Luftbilder …');
  const [core, outer] = await Promise.all([
    buildCoreTerrain({ scene: meta, coreGrid, quality: QUALITY, renderer, base: BASE, onProgress: (p) => setProgress('tex', p) }),
    buildOuterTerrain({ scene: meta, outerGrid, quality: QUALITY, renderer, base: BASE }),
  ]);
  scene.add(outer, core);
  setProgress('tex', 1, 'Baue Gebäude …');

  const buildings = await buildBuildings({ url: BASE + meta.buildings, sceneMeta: meta, orthoTextures: core.userData.textures, renderer });
  scene.add(buildings);
  console.info('Gebäude:', buildings.userData.stats);
  setProgress('bld', 0.5, 'Pflanze Bäume, baue Straßen …');

  const [osm, vegetation] = await Promise.all([
    fetch(BASE + meta.osm).then((r) => r.json()),
    buildVegetation({ url: BASE + meta.vegetation, quality: QUALITY, renderer }),
  ]);
  const roads = buildRoads({ osm, groundAt, buildingInfo: buildings.userData.info, quality: QUALITY, renderer, bounds: meta.outer.size / 2 - 20 });
  const landmarks = buildLandmarks({ meta, buildingsRaw: buildings.userData.raw, osm, groundAt });
  console.info('Wichtige Orte:', landmarks.userData.report);
  water = buildWater({ osm, groundAt, renderer, bounds: meta.outer.size / 2 - 20 });
  scene.add(roads, vegetation, landmarks, water);
  applyEnvironment(landmarks, 0.5);
  applyEnvironment(water, 0.32); // schmale Bäche im Schatten der Ufergehölze spiegeln nur schwach
  // Die Himmels-Umgebung enthält die sehr helle Sonne. Ohne Dämpfung würden flache, raue Flächen
  // (Straßen, Boden) bei flachem Blickwinkel weißlich spiegeln → Intensität je Objektgruppe begrenzen.
  applyEnvironment(roads, 0.12);
  applyEnvironment(core, 0.3);
  applyEnvironment(outer, 0.3);
  applyEnvironment(buildings, 0.4);
  applyEnvironment(vegetation, 0.3);
  console.info('Straßen:', roads.userData.stats, 'Vegetation:', vegetation.userData.stats);
  setProgress('bld', 1, 'Fertig');

  controls = new DroneControls(camera, canvas, {
    groundAt, bounds: meta.outer.size / 2 - 60, touch: isTouch,
    obstacle: makeObstacleSampler(buildings.userData.raw),
  });
  if (isTouch) $('touch-ui').hidden = false;
  labels = new PlaceLabels(meta.pois, groundAt, $('labels'));
  try { if (localStorage.getItem('nw3d-labels') === '0') { labels.setEnabled(false); $('btn-labels').setAttribute('aria-pressed', 'false'); } } catch {}

  // Startansicht: aus Südwesten (Sonne im Rücken) auf den Ortskern
  const start = new THREE.Vector3(-260, 0, 520);
  start.y = groundAt(start.x, start.z) + 150;
  const look = new THREE.Vector3(170, groundAt(170, 60) , 60);
  const dir = look.clone().sub(start);
  controls.setPose(start, Math.atan2(-dir.x, -dir.z), Math.atan2(dir.y, Math.hypot(dir.x, dir.z)));

  buildPlacesMenu();
  renderer.compile(scene, camera);
  $('loader').classList.add('done');
  setTimeout(() => $('loader').remove(), 1000);

  // Hilfe beim ersten Besuch zeigen
  let seen = false;
  try { seen = localStorage.getItem('nw3d-help') === '1'; } catch {}
  if (!seen) $('help').hidden = false;

  renderer.setAnimationLoop(loop);
}

function applyEnvironment(root, intensity) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material)) {
      if (!m.isMeshStandardMaterial) continue;
      m.envMap = scene.environment;
      m.envMapIntensity = intensity;
      m.needsUpdate = true;
    }
  });
}

// ------------------------------------------------------------------ Orte-Menü
const PLACE_INFO = {
  dorfladen: 'An der Kirche',
  gasthaus: 'Nordwohlder Dorfstraße 5',
  kirche: 'An der Kirche 1',
  schule: 'An der Schule 1',
  feuerwehr: 'An der Schule 1',
  sporthalle: 'Rolandstraße 36',
  sportplatz: 'TV Einigkeit Nordwohlde',
  b51: 'Bundesstraße westlich des Ortes',
};
const PLACE_ORDER = ['dorfladen', 'gasthaus', 'kirche', 'schule', 'feuerwehr', 'sporthalle', 'sportplatz', 'b51'];

function buildPlacesMenu() {
  const nav = $('places');
  const add = (label, sub, fn) => {
    const b = document.createElement('button');
    b.innerHTML = `${label}<small>${sub}</small>`;
    b.addEventListener('click', () => { fn(); togglePlaces(false); });
    nav.append(b);
  };
  add('Überblick', 'Ganzer Ortskern von oben', () => {
    const pos = new THREE.Vector3(-320, 0, 620); pos.y = groundAt(pos.x, pos.z) + 260;
    controls.flyTo(pos, new THREE.Vector3(150, groundAt(150, 0), 0), 3);
  });
  for (const key of PLACE_ORDER) {
    const p = meta.pois.find((q) => q.key === key);
    if (!p) continue;
    const name = p.name.replace(/„|“/g, (m) => m);
    add(name, PLACE_INFO[key] || '', () => {
      // Blick aus Südwesten, Sonne im Rücken
      const target = new THREE.Vector3(p.x, p.y + 4, p.z);
      const dist = key === 'sportplatz' || key === 'b51' ? 140 : 75;
      const pos = new THREE.Vector3(p.x - dist * 0.62, 0, p.z + dist * 0.78);
      pos.y = Math.max(groundAt(pos.x, pos.z), p.y) + dist * 0.55;
      controls.flyTo(pos, target);
    });
  }
}
function togglePlaces(force) {
  const nav = $('places');
  const show = force ?? nav.hidden;
  nav.hidden = !show;
  $('btn-places').setAttribute('aria-expanded', String(show));
}
$('btn-places').addEventListener('click', () => togglePlaces());
$('btn-help').addEventListener('click', () => { $('help').hidden = false; });
$('help-close').addEventListener('click', () => {
  $('help').hidden = true;
  try { localStorage.setItem('nw3d-help', '1'); } catch {}
  canvas.focus();
});
canvas.addEventListener('pointerdown', () => togglePlaces(false));

// ------------------------------------------------------------------ Schleife
const timer = new THREE.Timer();
const hudAlt = $('hud-alt'), hudSpeed = $('hud-speed');
let hudTimer = 1; // sofort beim ersten Bild füllen
function loop() {
  timer.update();
  const dt = timer.getDelta();
  controls.update(dt);
  updateShadowFrustum();
  water?.userData.update(timer.getElapsed());
  labels?.update(camera, innerWidth, innerHeight);
  compassNeedle.style.transform = `rotate(${controls.yaw}rad)`;
  adaptive.update(dt);
  hudTimer += dt;
  if (hudTimer > 0.2) {
    hudTimer = 0;
    hudAlt.textContent = `Höhe ${Math.round(controls.agl)} m`;
    hudSpeed.textContent = `${Math.round(controls.velocity.length() * 3.6)} km/h`;
  }
  renderer.render(scene, camera);
}
const compassNeedle = $('compass-needle');

// Ortsnamen ein-/ausblenden
$('btn-labels').addEventListener('click', () => {
  const on = !labels.enabled;
  labels.setEnabled(on);
  $('btn-labels').setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('nw3d-labels', on ? '1' : '0'); } catch {}
});
// Kompass: Klick dreht die Blickrichtung nach Norden
$('compass').addEventListener('click', () => {
  const p = camera.position.clone();
  const target = p.clone().add(new THREE.Vector3(0, Math.tan(controls.pitch) * 100, -100));
  controls.flyTo(p, target, 1.2);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

init().catch((err) => {
  console.error(err);
  loaderText.textContent = 'Fehler beim Laden: ' + err.message;
});

// Für Tests/Debugging
window.__nw3d = { scene, camera, renderer, QUALITY, get controls() { return controls; }, get groundAt() { return groundAt; } };
