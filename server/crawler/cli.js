// Crawl from the command line:  npm run crawl -- "Zillertal" [osm,bergfex]
import { startCrawl, jobStatus } from './index.js';

const region = process.argv[2] || 'Zillertal';
const sources = process.argv[3] ? process.argv[3].split(',') : undefined;
startCrawl(region, sources);
const timer = setInterval(() => {
  const s = jobStatus();
  if (s.state !== 'running') { clearInterval(timer); console.log(s.state, s.sources.map((x) => `${x.id}: ${x.state} (${x.found})`).join(', ')); }
}, 1000);
