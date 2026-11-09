#!/bin/sh
# The first deploy of the visitor monitoring, end to end: tests, the Pages Functions bundle check, StatsBar and the
# weekly note, the deploy, one visit, and the first stats readout. Run from the repo on the Mac: sh tools/ship-stats.sh
set -e
cd "$(dirname "$0")/.."
echo "== tests"; npm test
echo "== Pages Functions bundle (functions/stats.js imports ../shared/stats.js)"
npx wrangler pages functions build --outdir /tmp/nextmap-fn-build && echo "bundle ok"
echo "== StatsBar and the weekly note"; sh tools/statsbar/install.sh
echo "== deploy"; npm run deploy
echo "== one visit, then the first readout"
open "https://nextmap.pages.dev/?region=Zillertal"
echo "Switch the site to Winter, open a route, then close or hide the tab (that sends the beacon). Waiting 90 s…"
sleep 90
node scripts/stats.js today
echo "== check"; node scripts/stats.js check || true
echo "Live Function log (Ctrl-C to stop): npx wrangler pages deployment tail --project-name nextmap"
