# nextmap

A FATMAP-style 3D map of Tyrol, on the same engine as the Stummerberg walkthrough (three.js 0.170, bundled with esbuild).

- **Terrain** from the Land Tirol laser scan (tiris DGM): 0.5 m from zoom 14 on, 5 m below that, streamed tile by tile from the tiris WCS. Outside Tyrol (South Tyrol, Salzburg) and at small scales it falls back to the AWS Terrain Tiles. The earth's curvature is applied, so the horizon drops as it should.
- **Imagery**: orthophotos from basemap.at or Land Tirol (20 cm), patched with EOX Sentinel-2 cloudless where they have no coverage, plus **current Sentinel-2 scenes** for summer and winter, picked per region (whole region covered, fewest clouds, preferred month: March for winter, August for summer) and rendered through Microsoft Planetary Computer.
- **Winter** lays the Sentinel-2 snow cover (NDSI, so it also finds snow in shadow) onto the high-resolution orthophoto; walls too steep to hold snow stay bare. Choose “Sentinel-2 · current season” to see the raw satellite scene instead.
- **Overlays**: slope angle in the usual avalanche classes (30/35/40/45°), contour lines, and from Land Tirol: mountain trails, wildlife and forest protection zones, lifts.
- **Hybrid** (the Satellite/Hybrid switch): roads, forest and farm tracks, trails, lifts and railways from OpenStreetMap vector tiles (OpenFreeMap), drawn onto the terrain, with place and peak names as labels that stay upright, give way to each other and hide behind ridges.
- **Every view is a link**: region, camera (latitude, longitude, altitude, heading, pitch), season, imagery, map style, layers, route filter and the open route are kept in the address bar, e.g. `?region=Zillertal&camera=47.16300,11.86400,2350,200.0,-42.0&season=winter&style=hybrid&layers=slope&kind=skitour&route=osm-r18304781`. Moving the map updates it; opening a region or a route adds a history entry, so Back and Forward work.
- **Phones**: the map fills the screen; routes and search sit in a sheet at the bottom that you pull up by its handle (or tap). A fullscreen button where the browser has one; added to the home screen, nextmap opens without browser bars.
- **Routes**: a crawler that finds routes for a region (default Zillertal): hiking, mountain bike, eMTB, Bike & Hike, ski touring and backcountry freeride, each in its own colour and filter:
  - **OpenStreetMap** (Overpass): hiking and mountain-bike route relations (eMTB where the name or tags say so), ski tours, and freeride runs (downhill marked freeride, or ungroomed backcountry “Skirouten”), with tracks. Unnamed routes, and those named only by a trail number, are named after the summit or hut at their highest point; ski tours split into several ways are merged. A region that has never been crawled fetches its OSM routes as soon as it is opened.
  - **bergfex.at**: the region's hiking, mountain-bike, E-MTB, ski-touring and freeride listings with each tour's GPX track (from the tour's download link), time and difficulty; length, climb and altitudes are measured on the DGM like the OSM routes. bergfex serves these downloads without a login but only about 40 per 20 minutes, so a crawl gets the first ones and the rest follow in the background at that pace (the panel shows how many are in). A tour without a track shows as a start marker; selecting it tries to fetch the track straight away. You can also get a tour's file with “GPX on bergfex” in your own logged-in browser and drop it on the tour's panel (or use “Attach GPX…”) to use it at once. To send your bergfex login with the downloads (in case it raises the limit, or bergfex starts requiring it), copy `.env.example` to `.env` and fill in `BERGFEX_COOKIE`; it is only sent with the GPX downloads.
  - **Bike & Hike**, which no source lists, is combined from the others: a bike route (at most 45 km and 1800 m) whose highest point meets a hiking route that goes on to a summit or hut 200–1400 m higher within 8 km. The ride is drawn solid, the walk dashed, with one profile for both.
  - Robots.txt is honoured (for `nextmap` or `*`), with at least 1.5 s between requests to a site; a “too many requests” answer or a used-up quota header pauses that part of the site until the time it gives; every page is cached so re-crawls stay quiet.
  - Every route with a track is measured on the tiris DGM (length, ascent, descent, high and low point); selecting one draws its elevation profile from the 0.5 m DGM and offers a GPX download.

## Run

```bash
npm install
npm start
```

Then open http://localhost:5173. `npm run dev` rebuilds the frontend and restarts the server on changes.

Crawl from the shell instead of the button: `npm run crawl -- "Zillertal"` (or `npm run crawl -- "Stubaital" osm`). A source can be limited to some of bergfex's categories, e.g. `npm run crawl -- "Osttirol" bergfex:e-mtb`; that crawl replaces only those tours. Presets can name several bergfex areas, since bergfex's regions are often smaller (Karwendel covers Achensee, Silberregion Karwendel, Seefeld and Innsbruck).

`npm test` runs the unit tests (robots.txt rules, the bergfex page and GPX parsers, OSM line chaining and route naming, projections and tile maths).

On a phone the route list is a bottom sheet (tap its header to expand it) and the layers open from the button at the top right.

## Public site (Cloudflare Pages)

**https://nextmap.pages.dev** is the static build: no server behind it. Visitors' browsers fetch the tiris DGM, the orthophotos and Sentinel-2 directly (all of them allow it) and build the tiles in a web worker with the same code the local server uses (`shared/`), keeping elevation tiles in the browser for the next visit. Routes come from snapshots of the OpenStreetMap crawls in `dist/data/routes/` (with the Bike & Hike tours made only of OSM routes). For any other region, “Search the web for routes” (or simply opening a region without a snapshot) searches OpenStreetMap straight from the visitor's browser, measures the routes on the terrain in the data worker and keeps them in that browser, with the same code the local crawler uses (`shared/routes.js`). bergfex tours and GPX uploads stay in the local app, since bergfex's content is not ours to republish.

```bash
npm run deploy
```

builds `dist/` (`npm run build:static`) from the current `cache/routes/` and uploads it with `wrangler pages deploy` to the `nextmap` project on the Cloudflare account wrangler is logged in to (`npx wrangler login`; it needs only Pages write access). Code files carry a hash in their name, so a visitor never mixes old and new files.

## Controls

Like Google Earth and Google Maps:

| Input | Does |
| --- | --- |
| Drag | Moves the map; the ground under the cursor follows it |
| Shift + drag, Ctrl/⌘ + drag, or right drag | Turns and tilts around the point you grabbed, which stays in place |
| Alt + drag | Looks around from where the camera is |
| Wheel, trackpad pinch | Zooms to the point under the cursor |
| Double-click | Zooms in there (Shift: out) |
| Arrows / WASD | Move · Q E or Shift + ←/→ turn · R F or Shift + ↑/↓ tilt · + − zoom · N north up · ? help |
| Touch | One finger moves; two fingers pinch, twist to turn, slide up or down together to tilt |

The view glides on briefly after a drag, never goes below the ground, and moves closer instead of through a slope when you turn near one. The buttons at the bottom right zoom, switch between looking straight down and the tilted view, turn north up, and show the controls. Click a route on the map or in the list to see its details; hover the profile to find a point on the map.

## Layout

| Path | What |
| --- | --- |
| `shared/` | Code for both sides: tile maths and profiles, the DEM builder and TIFF reader, Sentinel-2 scenes, imagery sources, regions, OSM routes with naming, merging and Bike & Hike |
| `server/index.js` | HTTP server: static files and the API |
| `server/dem.js`, `imagery.js`, `sentinel.js` | The shared tile code with disk caches: elevation (tiris WCS 5 m / 0.5 m + Terrarium, 259×259 Float32 per tile), orthophotos and overlays, Sentinel-2 with the snow fraction in alpha |
| `server/crawler/` | Regions, OSM and bergfex sources, Bike & Hike combinations, polite fetching, crawl jobs |
| `src/crawl.js` | The public site's route search: OpenStreetMap from the browser, kept in Cache Storage |
| `src/backend.js` | The local server's API, or on a static host the data worker and the route snapshots |
| `src/worker.js` | Data worker for the static site: elevation tiles, orthophoto patching, Sentinel-2 snow, profiles |
| `scripts/build.js` | Builds `public/` for the local server and `dist/` for Cloudflare Pages |
| `src/hybrid.js`, `src/labels.js` | Hybrid layer from OpenStreetMap vector tiles, and the place and peak labels |
| `src/urlstate.js` | The view in the address bar |
| `src/controls.js` | Camera navigation: grab, orbit around a point, look around, zoom to cursor, keys, touch |
| `src/terrain.js` | Quadtree level of detail; leaves draw with the nearest loaded ancestor's data |
| `src/shaders.js` | Terrain shaders: DEM in the vertex shader, imagery, snow, slope, contours, overlays |
| `src/routes.js` | Routes painted into each tile's overlay canvas so they lie exactly on the ground |
| `src/ui.js` | Side panel, layers, crawler control, profile chart |

Regions with hand-made extents: Zillertal, Stubaital, Ötztal, Pitztal, Kaunertal, Sellrain, Wipptal, Karwendel, Rofan, Kitzbüheler Alpen, Paznaun, Arlberg, Osttirol. Anything else is geocoded with Nominatim and widened to about 25 km.

## Data and licences

Land Tirol (tiris) terrain, orthophotos and overlays, CC BY 4.0 · basemap.at, CC BY 4.0 · Copernicus Sentinel-2 data (modified) via Microsoft Planetary Computer · EOX Sentinel-2 cloudless 2023 (CC BY-NC-SA 4.0, non-commercial) · Mapzen/AWS Terrain Tiles · OpenFreeMap, © OpenMapTiles · © OpenStreetMap contributors, ODbL · bergfex.at tours and tracks stay bergfex's: for your own use, linked back to their pages.
