# Nordwohlde 3D

Begehbare 3D-Darstellung des Ortskerns von Nordwohlde (Stadt Bassum, Landkreis Diepholz) im Browser –
mit echtem Gelände, Luftbild, allen Gebäuden, Straßen, Bäumen und Hecken. Gebaut mit Three.js und Vite.

**Bedienung:** wie eine Drohne – PC: `W A S D` fliegen, `E`/`Q` steigen/sinken, Maus ziehen zum Umschauen,
`Shift` schneller. Handy/Tablet: linker Stick fliegen, rechts wischen umschauen, ▲/▼ Höhe.
Über „Orte“ fliegt man direkt zu Dorfladen, Gasthaus Lüdeke, Kirche, Schule, Feuerwehr, Sporthalle, Sportplatz und B51.

## Entwicklung

```bash
npm install
npm run dev             # lokale Vorschau unter http://localhost:5173
npm run build           # fertige Seite in dist/
```

## Daten neu aufbereiten

```bash
npm run data:download   # LGLN OpenGeoData + OpenStreetMap → data-raw/ (ca. 400 MB, nicht im Repository)
npm run data:build      # → public/data/ (ca. 16 MB, browserfertig)
npm run data:preview    # Kontrollbilder → preview/
```

Gebiet: 1,5 × 1,5 km Kerngebiet (volle Detailtiefe) + 4 × 4 km Umgebung, festgelegt in `tools/config.mjs`.

## Aufbau

| Datei | Inhalt |
|---|---|
| `src/terrain.js` | Gelände (DGM1) mit Luftbild (DOP20) |
| `src/buildings.js` | Gebäude aus LoD2 mit Fassaden, Fenstern, Dächern |
| `src/roads.js` | Straßen, Markierungen, Bordsteine, Laternen |
| `src/vegetation.js` | Bäume und Hecken aus Oberflächenmodell (DOM1 − DGM1) |
| `src/landmarks.js` | Schilder, Eingänge, Feuerwehrtore, Außengastronomie, Sportanlage |
| `src/extras.js` | Gewässer, Kollision, Ortsnamen, adaptive Auflösung |
| `src/controls.js` | Drohnensteuerung (Tastatur, Maus, Touch) |
| `tools/` | Datenaufbereitung (Node.js) |

## Quellen & Lizenzen

- Geobasisdaten: © LGLN (2026), Lizenz [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) –
  Digitales Geländemodell DGM1, Digitales Oberflächenmodell DOM1, Digitale Orthophotos DOP20 (Befliegung 05.09.2024),
  3D-Gebäudemodelle LoD2. Die Daten wurden für die Darstellung verändert (Ausschnitt, Auflösung, Bereinigung).
- Kartendaten: © [OpenStreetMap-Mitwirkende](https://www.openstreetmap.org/copyright), ODbL
- Schilder, Fassadendetails, Tore und Laternenstandorte sind nachempfunden und nicht vermessen.
