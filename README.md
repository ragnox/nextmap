# nextmap

A FATMAP-style 3D map of Tyrol, on the same engine as the Stummerberg walkthrough (three.js 0.170, bundled with esbuild).

- **Terrain** from the Land Tirol laser scan (tiris DGM): 0.5 m from zoom 14 on, 5 m below that, streamed tile by tile from the tiris WCS. Outside Tyrol (South Tyrol, Salzburg) and at small scales it falls back to the AWS Terrain Tiles. The earth's curvature is applied, so the horizon drops as it should.
- **Imagery**: orthophotos from basemap.at or Land Tirol (20 cm), patched with EOX Sentinel-2 cloudless where they have no coverage, plus **current Sentinel-2 scenes** for summer and winter, picked per region (whole region covered, fewest clouds, preferred month: March for winter, August for summer) and rendered through Microsoft Planetary Computer.
- **Winter** lays the Sentinel-2 snow cover (NDSI, so it also finds snow in shadow) onto the high-resolution orthophoto; walls too steep to hold snow stay bare. Choose “Sentinel-2 · current season” to see the raw satellite scene instead.
- **Overlays**: slope angle in the usual avalanche classes (30/35/40/45°), contour lines, and from Land Tirol: mountain trails, wildlife and forest protection zones, lifts.
- **Routes**: a crawler that finds hiking and ski-touring routes for a region (default Zillertal):
  - **OpenStreetMap** (Overpass): hiking route relations and ski tours, with tracks. Unnamed routes are named after the summit or hut at their highest point; ski tours split into several ways are merged.
  - **bergfex.at**: the region's hiking and ski-touring listings; start point, length, ascent, altitude range, time and difficulty. Their tracks need a login and are not fetched; these show as start markers with a link.
  - Robots.txt is honoured (for `nextmap` or `*`), with at least 1.5 s between requests to a site, and every page is cached so re-crawls stay quiet.
  - Every route with a track is measured on the tiris DGM (length, ascent, descent, high and low point); selecting one draws its elevation profile from the 0.5 m DGM and offers a GPX download.

## Run

```bash
npm install
npm start
```

Then open http://localhost:5173. `npm run dev` rebuilds the frontend and restarts the server on changes.

Crawl from the shell instead of the button: `npm run crawl -- "Zillertal"` (or `npm run crawl -- "Stubaital" osm`).

## Controls

Left drag pans, right drag (or Ctrl + drag) rotates and tilts, the wheel zooms to the cursor. Click a route on the map or in the list to see its details; hover the profile to find a point on the map. The compass turns the view north.

## Layout

| Path | What |
| --- | --- |
| `server/index.js` | HTTP server: static files and the API |
| `server/dem.js` | Elevation tiles: tiris WCS (5 m / 0.5 m, both Gauss-Krüger zones) + Terrarium fill, 259×259 Float32 per tile |
| `server/imagery.js` | Orthophoto and Land Tirol overlay tiles, cached in `cache/` |
| `server/sentinel.js` | Sentinel-2 scene choice (STAC) and tiles with the snow fraction in alpha |
| `server/crawler/` | Regions, OSM and bergfex sources, polite fetching, crawl jobs |
| `src/terrain.js` | Quadtree level of detail; leaves draw with the nearest loaded ancestor's data |
| `src/shaders.js` | Terrain shaders: DEM in the vertex shader, imagery, snow, slope, contours, overlays |
| `src/routes.js` | Routes painted into each tile's overlay canvas so they lie exactly on the ground |
| `src/ui.js` | Side panel, layers, crawler control, profile chart |

Regions with hand-made extents: Zillertal, Stubaital, Ötztal, Pitztal, Kaunertal, Sellrain, Wipptal, Karwendel, Kitzbüheler Alpen, Paznaun, Arlberg, Osttirol. Anything else is geocoded with Nominatim and widened to about 25 km.

## Data and licences

Land Tirol (tiris) terrain, orthophotos and overlays, CC BY 4.0 · basemap.at, CC BY 4.0 · Copernicus Sentinel-2 data (modified) via Microsoft Planetary Computer · EOX Sentinel-2 cloudless 2023 (CC BY-NC-SA 4.0, non-commercial) · Mapzen/AWS Terrain Tiles · © OpenStreetMap contributors, ODbL · route listings link back to bergfex.at, whose content stays theirs.
