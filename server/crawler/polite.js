// Polite web fetching for the crawler: honours robots.txt (for our user agent or *), waits between requests to the
// same host (at least the site's Crawl-delay), keeps fetched pages on disk so re-crawls do not hit the site again,
// and stops asking a site section that answered "too many requests" (or announced its quota is used up) until the
// time it gave.
import { UA, cached } from '../util.js';

const AGENT = 'nextmap';
const robotsCache = new Map();
const lastHit = new Map();
const blocked = new Map();            // host + first path segment -> time (ms) we may ask again

export class RateLimited extends Error {
  constructor(until) { super(`rate limited until ${new Date(until).toLocaleTimeString('de-AT')}`); this.until = until; }
}
const section = (u) => u.host + '/' + u.pathname.split('/')[1];
export const blockedUntil = (url) => { const t = blocked.get(section(new URL(url))) || 0; return t > Date.now() ? t : 0; };

// when may we ask again, from Retry-After (seconds or a date) or the X-RateLimit headers
function quotaUntil(res) {
  const ra = res.headers.get('retry-after');
  if (res.status === 429 || res.status === 503) {
    const secs = Number(ra), date = Date.parse(ra || '');
    return Date.now() + (Number.isFinite(secs) ? secs * 1000 : Number.isFinite(date) ? date - Date.now() : 20 * 60e3) + 5000;
  }
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    return reset > 1e9 ? reset * 1000 + 5000 : Date.now() + (reset > 0 ? reset * 1000 : 20 * 60e3) + 5000;
  }
  return 0;
}

export function parseRobots(text) {
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
  const mine = groups.filter((g) => g.agents.some((a) => a && a !== '*' && AGENT.includes(a)));
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

// the longest matching rule wins; on a tie Allow wins (as Google reads robots.txt)
export function robotsAllows(groups, path) {
  let best = null;
  for (const g of groups) for (const r of g.rules)
    if (ruleMatches(r, path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  return !best || best.allow;
}

export async function allowed(url) {
  const u = new URL(url), groups = await robotsFor(u.origin);
  if (groups === null) return { ok: false, delay: 0 };
  return { ok: robotsAllows(groups, u.pathname + u.search), delay: Math.max(0, ...groups.map((g) => g.delay)) };
}

// fetch a page politely; returns null when robots.txt forbids it, the page is missing, or `accept` rejects it
// (rejected answers are not cached)
export async function politeGet(url, { cacheKey, maxAgeMs = 14 * 86400e3, minDelay = 1500, headers = {}, accept } = {}) {
  const run = async () => {
    const rule = await allowed(url);
    if (!rule.ok) return null;
    if (blockedUntil(url)) throw new RateLimited(blockedUntil(url));
    const host = new URL(url).host;
    const wait = (lastHit.get(host) || 0) + Math.max(minDelay, rule.delay * 1000) - Date.now();
    lastHit.set(host, Date.now() + Math.max(wait, 0));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'de,en;q=0.8', ...headers }, signal: AbortSignal.timeout(30000) });
    const until = quotaUntil(res);
    if (until) blocked.set(section(new URL(url)), until);
    if (res.status === 429 || res.status === 503) throw new RateLimited(until);
    if (!res.ok) return null;
    const text = await res.text();
    return accept && !accept(text) ? null : Buffer.from(text);
  };
  const buf = cacheKey ? await cached(cacheKey, maxAgeMs, run) : await run();
  return buf ? buf.toString('utf8') : null;
}
