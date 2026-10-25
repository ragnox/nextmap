// Polite web fetching for the crawler: honours robots.txt (for our user agent or *), waits between requests to the
// same host (at least the site's Crawl-delay), and keeps fetched pages on disk so re-crawls do not hit the site again.
import { UA, cached } from '../util.js';

const AGENT = 'nextmap';
const robotsCache = new Map();
const lastHit = new Map();

function parseRobots(text) {
  const groups = []; let cur = null, lastWasAgent = false;
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [], delay: 0 }; groups.push(cur); }
      cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (k === 'allow' || k === 'disallow') cur.rules.push({ allow: k === 'allow', path: v });
    else if (k === 'crawl-delay') cur.delay = Number(v) || 0;
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && AGENT.includes(a)));
  return mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
}

function ruleMatches(rule, path) {
  if (!rule.path) return false;
  const re = new RegExp('^' + rule.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
  return re.test(path);
}

async function robotsFor(origin) {
  if (!robotsCache.has(origin)) {
    robotsCache.set(origin, (async () => {
      try {
        const res = await fetch(origin + '/robots.txt', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
        if (res.status >= 400 && res.status < 500) return [];            // no robots.txt: everything allowed
        if (!res.ok) return null;                                         // server trouble: crawl nothing
        return parseRobots(await res.text());
      } catch { return null; }
    })());
  }
  return robotsCache.get(origin);
}

export async function allowed(url) {
  const u = new URL(url), groups = await robotsFor(u.origin);
  if (groups === null) return { ok: false, delay: 0 };
  const path = u.pathname + u.search;
  let best = null;
  for (const g of groups) for (const r of g.rules)
    if (ruleMatches(r, path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  return { ok: !best || best.allow, delay: Math.max(0, ...groups.map((g) => g.delay)) };
}

// fetch an HTML page politely; returns null when robots.txt forbids it or the page is missing
export async function politeGet(url, { cacheKey, maxAgeMs = 14 * 86400e3, minDelay = 1500 } = {}) {
  const run = async () => {
    const rule = await allowed(url);
    if (!rule.ok) return null;
    const host = new URL(url).host;
    const wait = (lastHit.get(host) || 0) + Math.max(minDelay, rule.delay * 1000) - Date.now();
    lastHit.set(host, Date.now() + Math.max(wait, 0));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'de,en;q=0.8' }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) return null;
    return Buffer.from(await res.text());
  };
  const buf = cacheKey ? await cached(cacheKey, maxAgeMs, run) : await run();
  return buf ? buf.toString('utf8') : null;
}
