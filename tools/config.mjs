// Zentrale Konfiguration des Gebiets.
import proj4 from 'proj4';

proj4.defs('EPSG:25832', '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');

// Mittelpunkt: zwischen Gasthaus Lüdeke, Dorfladen, Schule – leicht nach NW verschoben,
// damit B51 (Westen) und Sportplatz (Norden) im Kerngebiet liegen.
export const CENTER_WGS84 = { lat: 52.9055, lon: 8.7340 };

export const toUTM = (lon, lat) => proj4('EPSG:4326', 'EPSG:25832', [lon, lat]);
export const toWGS = (e, n) => proj4('EPSG:25832', 'EPSG:4326', [e, n]);

const [ce, cn] = toUTM(CENTER_WGS84.lon, CENTER_WGS84.lat);
// Auf ganze Meter runden – der Ursprung der 3D-Szene.
export const ORIGIN = { e: Math.round(ce), n: Math.round(cn) };

export const CORE_SIZE = 1500;   // Kerngebiet volle Detailtiefe (m)
export const OUTER_SIZE = 4000;  // grober Rand (m)

export const bbox = (size) => ({
  minE: ORIGIN.e - size / 2, maxE: ORIGIN.e + size / 2,
  minN: ORIGIN.n - size / 2, maxN: ORIGIN.n + size / 2,
});

export const CORE = bbox(CORE_SIZE);
export const OUTER = bbox(OUTER_SIZE);

export const RAW_DIR = 'data-raw';
export const OUT_DIR = 'public/data';
