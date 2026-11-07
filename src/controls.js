// Drohnensteuerung: Tastatur + Maus (PC) sowie virtueller Stick + Wischen (Touch)
import * as THREE from 'three';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// Pointer-Capture kann (z. B. bei bereits beendeten Berührungen) fehlschlagen – dann ohne weiter.
const capture = (el, id) => { try { el.setPointerCapture(id); } catch { /* ignorieren */ } };
const MIN_AGL = 1.8;       // minimale Höhe über Grund (m)
const MAX_ALT = 700;       // maximale Flughöhe (Szenen-m)

export class DroneControls {
  constructor(camera, dom, { groundAt, bounds, touch, obstacle = null }) {
    this.obstacle = obstacle;
    this.camera = camera;
    this.dom = dom;
    this.groundAt = groundAt;
    this.bounds = bounds;
    this.yaw = 0;
    this.pitch = -0.3;
    this.velocity = new THREE.Vector3();
    this.baseSpeed = 14;         // m/s
    this.keys = new Set();
    this.stick = { x: 0, y: 0 }; // Touch-Stick (-1..1)
    this.altInput = 0;           // Touch-Höhe (-1, 0, 1)
    this.flight = null;          // laufender Anflug
    this.onUserInput = null;
    camera.rotation.order = 'YXZ';
    this.#bindKeyboard();
    this.#bindPointer();
    if (touch) this.#bindTouchUI();
  }

  get agl() { return this.camera.position.y - this.groundAt(this.camera.position.x, this.camera.position.z); }

  setPose(pos, yaw, pitch) {
    this.camera.position.copy(pos);
    this.yaw = yaw; this.pitch = pitch;
    this.velocity.set(0, 0, 0);
    this.#applyRotation();
  }

  /** Sanfter Anflug zu einer Position mit Blick auf ein Ziel. */
  flyTo(pos, target, duration = 2.6) {
    const dir = new THREE.Vector3().subVectors(target, pos);
    const yaw = Math.atan2(-dir.x, -dir.z);
    const pitch = Math.atan2(dir.y, Math.hypot(dir.x, dir.z));
    let dyaw = yaw - this.yaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    const from = this.camera.position.clone();
    // Bogen nach oben, damit der Flug nicht durch Hindernisse führt
    const lift = Math.min(120, from.distanceTo(pos) * 0.25);
    this.flight = { t: 0, duration, from, to: pos.clone(), yaw0: this.yaw, dyaw, pitch0: this.pitch, pitch1: pitch, lift };
    this.velocity.set(0, 0, 0);
  }

  #interrupt() {
    this.flight = null;
    this.onUserInput?.();
  }

  #applyRotation() {
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  #bindKeyboard() {
    const movementKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyC', 'ShiftLeft', 'ShiftRight', 'PageUp', 'PageDown']);
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (movementKeys.has(e.code)) {
        this.keys.add(e.code);
        if (!e.code.startsWith('Shift')) this.#interrupt();
        if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  #bindPointer() {
    const el = this.dom;
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (drag) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      capture(el, e.pointerId);
      el.classList.add('dragging');
      el.focus();
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      const k = e.pointerType === 'touch' ? 0.0045 : 0.0028;
      this.yaw -= dx * k;
      this.pitch = clamp(this.pitch - dy * k, -1.5, 1.5);
      if (dx || dy) this.#interrupt();
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      el.classList.remove('dragging');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.baseSpeed = clamp(this.baseSpeed * (e.deltaY > 0 ? 0.85 : 1.18), 2, 120);
    }, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  #bindTouchUI() {
    const stick = document.getElementById('stick');
    const knob = document.getElementById('stick-knob');
    let id = null, cx = 0, cy = 0;
    const R = 50;
    const move = (e) => {
      let dx = e.clientX - cx, dy = e.clientY - cy;
      const len = Math.hypot(dx, dy);
      if (len > R) { dx *= R / len; dy *= R / len; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.stick.x = dx / R; this.stick.y = -dy / R;
    };
    stick.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      id = e.pointerId; capture(stick, id);
      const r = stick.getBoundingClientRect();
      cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      move(e); this.#interrupt();
    });
    stick.addEventListener('pointermove', (e) => { if (e.pointerId === id) move(e); });
    const release = (e) => {
      if (e.pointerId !== id) return;
      id = null; this.stick.x = this.stick.y = 0;
      knob.style.transform = '';
    };
    stick.addEventListener('pointerup', release);
    stick.addEventListener('pointercancel', release);

    for (const [btnId, dir] of [['btn-up', 1], ['btn-down', -1]]) {
      const b = document.getElementById(btnId);
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); capture(b, e.pointerId); this.altInput = dir; b.classList.add('active'); this.#interrupt(); });
      const up = () => { if (this.altInput === dir) this.altInput = 0; b.classList.remove('active'); };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
    }
  }

  update(dt) {
    dt = Math.min(dt, 0.1);
    const cam = this.camera;

    if (this.flight) {
      const f = this.flight;
      f.t += dt / f.duration;
      const t = Math.min(1, f.t);
      const s = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
      cam.position.lerpVectors(f.from, f.to, s);
      cam.position.y += Math.sin(Math.PI * s) * f.lift;
      this.yaw = f.yaw0 + f.dyaw * s;
      this.pitch = f.pitch0 + (f.pitch1 - f.pitch0) * s;
      this.#applyRotation();
      if (t >= 1) this.flight = null;
      return;
    }

    const k = this.keys;
    let fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) + this.stick.y;
    let side = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) + this.stick.x;
    let up = (k.has('KeyE') || k.has('Space') || k.has('PageUp') ? 1 : 0) - (k.has('KeyQ') || k.has('KeyC') || k.has('PageDown') ? 1 : 0) + this.altInput;
    fwd = clamp(fwd, -1, 1); side = clamp(side, -1, 1); up = clamp(up, -1, 1);

    // Geschwindigkeit wächst mit der Höhe über Grund – unten präzise, oben zügig
    const agl = Math.max(0, this.agl);
    const boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 3.5 : 1;
    const speed = this.baseSpeed * clamp(0.45 + agl / 50, 0.45, 4) * boost;

    const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
    const target = new THREE.Vector3(
      (-sinY * fwd + cosY * side) * speed,
      up * speed * 0.7,
      (-cosY * fwd - sinY * side) * speed,
    );
    // Trägheit wie bei einer Drohne
    const a = 1 - Math.exp(-dt * 3.2);
    this.velocity.lerp(target, a);
    const px = cam.position.x, pz = cam.position.z;
    cam.position.addScaledVector(this.velocity, dt);

    // Gebäude: nicht hindurchfliegen – an der Wand entlanggleiten
    if (this.obstacle) {
      const y = cam.position.y, clear = (x, z) => y > this.obstacle(x, z) + 0.8;
      if (!clear(cam.position.x, cam.position.z)) {
        if (clear(px, cam.position.z)) { cam.position.x = px; this.velocity.x = 0; }
        else if (clear(cam.position.x, pz)) { cam.position.z = pz; this.velocity.z = 0; }
        else if (clear(px, pz)) { cam.position.x = px; cam.position.z = pz; this.velocity.x = this.velocity.z = 0; }
        else cam.position.y = this.obstacle(cam.position.x, cam.position.z) + 0.85; // eingeklemmt → aufs Dach
      }
    }

    // Grenzen
    const b = this.bounds;
    cam.position.x = clamp(cam.position.x, -b, b);
    cam.position.z = clamp(cam.position.z, -b, b);
    const ground = Math.max(this.groundAt(cam.position.x, cam.position.z), this.obstacle ? this.obstacle(cam.position.x, cam.position.z) - 0.8 : -Infinity);
    if (cam.position.y < ground + MIN_AGL) { cam.position.y = ground + MIN_AGL; this.velocity.y = Math.max(0, this.velocity.y); }
    if (cam.position.y > MAX_ALT) { cam.position.y = MAX_ALT; this.velocity.y = Math.min(0, this.velocity.y); }
    this.#applyRotation();
  }
}
