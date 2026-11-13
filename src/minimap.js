// Minikarte: Grundriss (Gebäude, Straßen, Gewässer, Flächennutzung) nordwärts ausgerichtet,
// mittig die aktuelle Position als blinkender Punkt mit Blickrichtungskegel.
// Die Karte wird einmalig in eine große Leinwand gezeichnet; pro Bild wird nur der Ausschnitt kopiert.

const LANDUSE = {
  forest: '#24392a', wood: '#24392a', scrub: '#283b2c', orchard: '#2a3e2c', plant_nursery: '#2a3e2c',
  meadow: '#26332a', grass: '#29372d', grassland: '#26332a', recreation_ground: '#2c3d2f', farmland: '#232b27',
  residential: '#2a2f36', farmyard: '#2e2f30', commercial: '#33303a', industrial: '#33303a',
  cemetery: '#2b382f', religious: '#33303a', quarry: '#3a3630', basin: '#24435e',
};
const ROAD = { // Breite in m, Farbe
  primary: [8, '#f2c46b'], secondary: [7, '#e8d9a8'], secondary_link: [6, '#e8d9a8'],
  tertiary: [6, '#d9dee3'], unclassified: [5, '#c3cad1'], residential: [5, '#c3cad1'], living_street: [4.5, '#c3cad1'],
  service: [3.5, '#8f9aa5'], track: [3, '#7d6f5a'], footway: [1.6, '#9aa4ae'], path: [1.6, '#9aa4ae'],
  cycleway: [1.6, '#9aa4ae'], steps: [1.6, '#9aa4ae'],
};
const ROAD_ORDER = ['track', 'path', 'footway', 'cycleway', 'steps', 'service', 'living_street', 'residential',
  'unclassified', 'tertiary', 'secondary_link', 'secondary', 'primary'];

export class MiniMap {
  constructor({ el, osm, buildings, pois, low }) {
    this.el = el;
    this.canvas = el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.cone = el.querySelector('.mm-cone');
    this.range = 220; // halber sichtbarer Ausschnitt in m
    this.half = 1200; // Kartenausdehnung ±m um den Ursprung
    this.S = low ? 1 : 1.5; // Pixel je m in der Grundkarte
    this.base = this.#renderBase(osm, buildings, pois);
    this.last = '';
    this.resize();
    addEventListener('resize', () => this.resize());
    el.addEventListener('transitionend', () => this.resize());
  }

  #renderBase(osm, buildings, pois) {
    const { S, half } = this;
    const size = Math.round(half * 2 * S);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const tx = (x) => (x + half) * S;
    g.fillStyle = '#1e2620';
    g.fillRect(0, 0, size, size);
    g.lineJoin = g.lineCap = 'round';

    const path = (pts, close) => {
      g.beginPath();
      pts.forEach(([x, z], i) => (i ? g.lineTo(tx(x), tx(z)) : g.moveTo(tx(x), tx(z))));
      if (close) g.closePath();
    };

    // Flächennutzung
    for (const f of osm) {
      if (!f.g || f.g.length < 3) continue;
      const col = LANDUSE[f.tags.landuse] || LANDUSE[f.tags.natural];
      if (!col) continue;
      path(f.g, true); g.fillStyle = col; g.fill();
    }
    // Gewässer
    for (const f of osm) {
      if (!f.g || f.g.length < 2) continue;
      if (f.tags.natural === 'water') { path(f.g, true); g.fillStyle = '#2f6aa3'; g.fill(); }
      else if (f.tags.waterway) {
        const w = f.tags.waterway === 'river' ? 6 : f.tags.waterway === 'stream' ? 2.5 : 1.5;
        path(f.g, false); g.strokeStyle = '#3b7cbd'; g.lineWidth = Math.max(1, w * S); g.stroke();
      }
    }
    // Straßen (unwichtige zuerst, Hauptstraßen oben)
    const ways = osm.filter((f) => f.g && f.g.length > 1 && ROAD[f.tags.highway])
      .sort((a, b) => ROAD_ORDER.indexOf(a.tags.highway) - ROAD_ORDER.indexOf(b.tags.highway));
    for (const f of ways) {
      const [w, col] = ROAD[f.tags.highway];
      path(f.g, false);
      g.strokeStyle = col; g.lineWidth = Math.max(1.2, w * S);
      if (f.tags.highway === 'track' || f.tags.highway === 'path') g.setLineDash([3 * S, 2 * S]);
      g.stroke(); g.setLineDash([]);
    }
    // Gebäude (Grundflächen aus LoD2)
    g.fillStyle = '#d8c39a'; g.strokeStyle = '#8c7a58'; g.lineWidth = Math.max(0.8, 0.4 * S);
    for (const b of buildings) {
      g.beginPath();
      for (const s of b.surfaces) {
        if (s.t !== 'G') continue;
        for (const r of s.r) {
          for (let i = 0; i < r.length; i += 3) (i ? g.lineTo(tx(r[i]), tx(r[i + 2])) : g.moveTo(tx(r[i]), tx(r[i + 2])));
          g.closePath();
        }
      }
      g.fill('evenodd'); g.stroke();
    }
    // Wichtige Orte
    for (const p of pois) {
      g.beginPath(); g.arc(tx(p.x), tx(p.z), 5 * S, 0, Math.PI * 2);
      g.fillStyle = '#f2b33d'; g.fill();
      g.lineWidth = 1.5 * S; g.strokeStyle = '#1b1300'; g.stroke();
    }
    return c;
  }

  resize() {
    const css = this.canvas.clientWidth || 120;
    const px = Math.round(css * Math.min(devicePixelRatio, 2));
    if (this.canvas.width !== px) { this.canvas.width = this.canvas.height = px; this.last = ''; }
  }

  setVisible(on) { this.el.hidden = !on; if (on) { this.resize(); this.last = ''; } }

  update(x, z, yaw, agl) {
    if (this.el.hidden) return;
    // Ausschnitt wächst mit der Flughöhe
    const target = Math.min(700, Math.max(140, 110 + agl * 1.6)) * (this.el.classList.contains('big') ? 1.6 : 1);
    this.range += (target - this.range) * 0.08;
    this.cone.style.transform = `rotate(${-yaw}rad)`;

    const key = `${x.toFixed(1)},${z.toFixed(1)},${this.range.toFixed(1)},${this.canvas.width}`;
    if (key === this.last) return;
    this.last = key;
    const { ctx, canvas, S, half, range } = this;
    const W = canvas.width;
    ctx.fillStyle = '#1e2620';
    ctx.fillRect(0, 0, W, W);
    const k = W / (2 * range); // Pixel je m auf der Minikarte
    // Grundkarte so zeichnen, dass (x, z) in der Mitte liegt
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.base, (-half - x) * k + W / 2, (-half - z) * k + W / 2, 2 * half * k, 2 * half * k);
  }
}
