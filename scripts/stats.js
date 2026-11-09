#!/usr/bin/env node
// nextmap's visitors, usage and health, from Cloudflare, in the terminal:
//   node scripts/stats.js [today|week|month] [--json|--markdown]   visits, countries, referrers, devices, load times,
//                                                                   usage counts, Function requests, R2 reads, health
//   node scripts/stats.js check                                     exit 1 (and say why) when a quota or an error rate
//                                                                   passes a threshold; StatsBar shows the same
//   node scripts/stats.js sql "SELECT …"                            a raw Analytics Engine query (dataset nextmap_stats)
// Token: CLOUDFLARE_API_TOKEN (an API token with Account Analytics: Read) or, without one, wrangler's own login
// (~/Library/Preferences/.wrangler), refreshed with `wrangler whoami` when it has expired. The Analytics Engine SQL
// API may need the API token; the GraphQL (Web Analytics, Functions, R2) works with wrangler's login.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

export const ACCOUNT = '4aebe04c04af9a5b7f6b8065bf446565';
export const SITE = '85c9ff3f3dfb463aa56769a6ba2a4eca';         // Web Analytics site tag of nextmap.pages.dev
export const BUCKET = 'nextmap-data';
export const DATASET = 'nextmap_stats';
export const FREE = { requests: 100000, points: 100000, r2Reads: 10_000_000 };   // per day, per day, per month
export const THRESHOLDS = { quotaEarly: 0.7, quotaEarlyUntilHour: 18, quota: 0.9, upstreamErrors: 0.05, visitorErrors: 0.02 };

// ------------------------------------------------------------ token
const WRANGLER = path.join(os.homedir(), 'Library/Preferences/.wrangler/config/default.toml');
const tomlValue = (text, key) => text.split('\n').find((l) => l.startsWith(`${key} `))?.split('"')[1];
export function token() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const read = () => (fs.existsSync(WRANGLER) ? fs.readFileSync(WRANGLER, 'utf8') : '');
  let t = read();
  const exp = Date.parse(tomlValue(t, 'expiration_time') || '');
  if (!(exp > Date.now() + 60000)) {                             // wrangler refreshes its token on any authenticated command
    try { execSync('npx --yes wrangler whoami', { stdio: 'ignore', timeout: 60000 }); } catch { /* reported below */ }
    t = read();
  }
  const tok = tomlValue(t, 'oauth_token');
  if (!tok) throw new Error('no Cloudflare token: set CLOUDFLARE_API_TOKEN or run `npx wrangler login`');
  return tok;
}

// ------------------------------------------------------------ Cloudflare
async function gql(query) {
  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors.map((e) => e.message).join('; '));
  return j.data.viewer.accounts[0];
}
export async function sql(query) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`, {
    method: 'POST', headers: { Authorization: `Bearer ${token()}` }, body: query,
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).data;
}
const iso = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');
const ae = (d) => `toDateTime('${iso(d).replace('T', ' ').replace('Z', '')}')`;
const dayStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const monthStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

// the period and the one before it, for the trend
export function period(name, now = new Date()) {
  const to = now;
  const from = name === 'today' ? dayStart(now) : new Date(now.getTime() - (name === 'month' ? 30 : 7) * 86400000);
  return { name, from, to, prevFrom: new Date(from.getTime() - (to.getTime() - from.getTime())) };
}

// ------------------------------------------------------------ the report
const rumFilter = (p, from = p.from) => `filter:{siteTag:"${SITE}",datetime_geq:"${iso(from)}",datetime_lt:"${iso(p.to)}"}`;
const topBy = (p, dim) => `rumPageloadEventsAdaptiveGroups(limit:10,${rumFilter(p)},orderBy:[sum_visits_DESC]){sum{visits} dimensions{${dim}}}`;
const soft = (fn) => fn().catch((e) => ({ error: e.message }));     // a dataset that fails leaves the rest of the report standing

export async function audience(p) {
  const a = await gql(`{viewer{accounts(filter:{accountTag:"${ACCOUNT}"}){
    total:rumPageloadEventsAdaptiveGroups(limit:1,${rumFilter(p)}){count sum{visits}}
    prev:rumPageloadEventsAdaptiveGroups(limit:1,filter:{siteTag:"${SITE}",datetime_geq:"${iso(p.prevFrom)}",datetime_lt:"${iso(p.from)}"}){count sum{visits}}
    days:rumPageloadEventsAdaptiveGroups(limit:31,${rumFilter(p)},orderBy:[date_ASC]){count sum{visits} dimensions{date}}
    countries:${topBy(p, 'countryName')}
    referrers:${topBy(p, 'refererHost')}
    devices:${topBy(p, 'deviceType')}
    browsers:${topBy(p, 'userAgentBrowser')}
  }}}`);
  const top = (k, dim) => (a[k] || []).map((g) => [g.dimensions[dim] || '(none)', g.sum.visits]);
  return {
    visits: a.total[0]?.sum.visits || 0, pageViews: a.total[0]?.count || 0, prevVisits: a.prev[0]?.sum.visits || 0,
    days: (a.days || []).map((g) => [g.dimensions.date, g.sum.visits, g.count]),
    countries: top('countries', 'countryName'), referrers: top('referrers', 'refererHost'), devices: top('devices', 'deviceType'), browsers: top('browsers', 'userAgentBrowser'),
  };
}
export async function performance(p) {
  const a = await gql(`{viewer{accounts(filter:{accountTag:"${ACCOUNT}"}){
    perf:rumPerformanceEventsAdaptiveGroups(limit:1,${rumFilter(p)}){quantiles{largestContentfulPaintP50 largestContentfulPaintP75 firstContentfulPaintP50 firstContentfulPaintP75}}
  }}}`);
  const q = a.perf[0]?.quantiles || {};
  return { lcpP50: q.largestContentfulPaintP50, lcpP75: q.largestContentfulPaintP75, fcpP50: q.firstContentfulPaintP50, fcpP75: q.firstContentfulPaintP75 };
}
export async function functions(p) {
  const a = await gql(`{viewer{accounts(filter:{accountTag:"${ACCOUNT}"}){
    days:pagesFunctionsInvocationsAdaptiveGroups(limit:31,filter:{datetime_geq:"${iso(p.from)}",datetime_lt:"${iso(p.to)}"},orderBy:[date_ASC]){sum{requests errors} dimensions{date}}
    today:pagesFunctionsInvocationsAdaptiveGroups(limit:1,filter:{datetime_geq:"${iso(dayStart(p.to))}"}){sum{requests errors}}
  }}}`);
  return { days: (a.days || []).map((g) => [g.dimensions.date, g.sum.requests, g.sum.errors]), today: a.today[0]?.sum.requests || 0, todayErrors: a.today[0]?.sum.errors || 0 };
}
const R2_WRITES = /^(Put|Copy|Delete|CreateMultipart|UploadPart|CompleteMultipart|AbortMultipart)/;
export async function r2(p) {
  const a = await gql(`{viewer{accounts(filter:{accountTag:"${ACCOUNT}"}){
    ops:r2OperationsAdaptiveGroups(limit:20,filter:{datetime_geq:"${iso(monthStart(p.to))}",bucketName:"${BUCKET}"}){sum{requests} dimensions{actionType}}
  }}}`);
  const ops = (a.ops || []).map((g) => [g.dimensions.actionType, g.sum.requests]);
  const sum = (test) => ops.filter(([k]) => test(k)).reduce((s, [, n]) => s + n, 0);
  return { ops, reads: sum((k) => !R2_WRITES.test(k)), writes: sum((k) => R2_WRITES.test(k)) };
}
// usage counts and the up/ Function's health from Analytics Engine (shared/stats.js and functions/up/ say what is written)
export async function usage(p) {
  const where = `timestamp >= ${ae(p.from)} AND timestamp < ${ae(p.to)}`;
  const rows = await sql(`SELECT index1 AS event, blob1 AS value, SUM(_sample_interval * double1) AS n FROM ${DATASET} WHERE ${where} AND index1 != 'up' GROUP BY event, value ORDER BY event, n DESC`);
  const visits = rows.filter((r) => r.event === 'visit').reduce((s, r) => s + r.n, 0);
  return { visits, events: rows.map((r) => [r.event, r.value, Math.round(r.n)]) };
}
export async function health(p) {
  const where = `timestamp >= ${ae(p.from)} AND timestamp < ${ae(p.to)}`;
  const rows = await sql(`SELECT blob1 AS kind, blob2 AS outcome, SUM(_sample_interval) AS n, quantileWeighted(0.5)(double1, _sample_interval) AS p50 FROM ${DATASET} WHERE ${where} AND index1 = 'up' GROUP BY kind, outcome ORDER BY kind, n DESC`);
  const points = await sql(`SELECT SUM(_sample_interval) AS n FROM ${DATASET} WHERE timestamp >= ${ae(dayStart(p.to))}`);
  return { rows: rows.map((r) => [r.kind, r.outcome, Math.round(r.n), Math.round(r.p50)]), pointsToday: Math.round(points[0]?.n || 0) };
}

export async function report(name = 'week', now = new Date()) {
  const p = period(name, now);
  const [aud, perf, fn, bucket, use, up] = await Promise.all([soft(() => audience(p)), soft(() => performance(p)), soft(() => functions(p)), soft(() => r2(p)), soft(() => usage(p)), soft(() => health(p))]);
  return { period: { name, from: iso(p.from), to: iso(p.to) }, audience: aud, performance: perf, functions: fn, r2: bucket, usage: use, health: up };
}

// ------------------------------------------------------------ thresholds (also in StatsBar)
export function problems(r, now = new Date()) {
  const out = [], T = THRESHOLDS;
  const fnShare = (r.functions?.today || 0) / FREE.requests;
  if (fnShare >= T.quota) out.push(`Function requests today at ${pct(fnShare)} of the free ${FREE.requests.toLocaleString()}`);
  else if (fnShare >= T.quotaEarly && now.getUTCHours() < T.quotaEarlyUntilHour) out.push(`Function requests already at ${pct(fnShare)} of today's free quota before ${T.quotaEarlyUntilHour}:00 UTC`);
  const r2Share = (r.r2?.reads || 0) / FREE.r2Reads;
  if (r2Share >= T.quotaEarly) out.push(`R2 reads this month at ${pct(r2Share)} of the free ${FREE.r2Reads.toLocaleString()}`);
  const pointShare = (r.health?.pointsToday || 0) / FREE.points;
  if (pointShare >= T.quotaEarly) out.push(`Analytics Engine points today at ${pct(pointShare)} of the free ${FREE.points.toLocaleString()}`);
  const rows = r.health?.rows || [];
  const n = (test) => rows.filter(([, o]) => test(o)).reduce((s, [, , c]) => s + c, 0);
  const up = n((o) => o === 'upstream'), bad = n((o) => o === 'upstream-error');
  if (up + bad >= 20 && bad / (up + bad) > T.upstreamErrors) out.push(`tiris failures: ${bad} of ${up + bad} upstream fetches (${pct(bad / (up + bad))})`);
  const errs = (r.usage?.events || []).filter(([e]) => e === 'error').reduce((s, [, , c]) => s + c, 0), visits = r.usage?.visits || 0;
  if (visits >= 20 && errs / visits > T.visitorErrors) out.push(`browser errors in ${pct(errs / visits)} of ${visits} visits`);
  return out;
}

// ------------------------------------------------------------ output
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const ms = (v) => (v == null ? '–' : `${Math.round(v)} ms`);
function sections(r) {
  const a = r.audience, s = [];
  const list = (rows) => rows.map(([k, v]) => [k, v.toLocaleString()]);
  const trend = a.prevVisits ? ` (${a.visits >= a.prevVisits ? '+' : ''}${Math.round(((a.visits - a.prevVisits) / a.prevVisits) * 100)}% vs the period before)` : '';
  s.push({ title: `Visits, ${r.period.name}`, lead: a.error || `${a.visits.toLocaleString()} visits, ${a.pageViews.toLocaleString()} page loads${trend}`,
    rows: a.error ? [] : a.days.map(([d, v, c]) => [d, v.toLocaleString(), c.toLocaleString()]), head: ['Day', 'Visits', 'Page loads'] });
  if (!a.error) {
    s.push({ title: 'Countries', rows: list(a.countries), head: ['Country', 'Visits'] });
    s.push({ title: 'Referrers', rows: list(a.referrers), head: ['Site', 'Visits'] });
    s.push({ title: 'Devices', rows: list(a.devices).concat(list(a.browsers)), head: ['Device / browser', 'Visits'] });
  }
  const p = r.performance;
  s.push({ title: 'Load time', lead: p.error || `LCP ${ms(p.lcpP50)} median, ${ms(p.lcpP75)} p75 · first paint ${ms(p.fcpP50)} median, ${ms(p.fcpP75)} p75`, rows: [] });
  const u = r.usage;
  s.push({ title: 'What visitors did (counts per visit, shared/stats.js)', lead: u.error ? `unavailable: ${u.error}` : `${u.visits.toLocaleString()} counted visits`,
    rows: u.error ? [] : u.events.map(([e, v, n]) => [`${e}:${v}`, n.toLocaleString(), u.visits ? pct(n / u.visits) : '']), head: ['Event', 'Count', 'Per visit'] });
  const f = r.functions;
  s.push({ title: 'Pages Function requests', lead: f.error || `today ${f.today.toLocaleString()} of ${FREE.requests.toLocaleString()} free (${pct(f.today / FREE.requests)}), ${f.todayErrors} errors`,
    rows: f.error ? [] : f.days.map(([d, n, e]) => [d, n.toLocaleString(), String(e)]), head: ['Day', 'Requests', 'Errors'] });
  const b = r.r2;
  s.push({ title: 'R2 this month', lead: b.error || `${b.reads.toLocaleString()} reads of ${FREE.r2Reads.toLocaleString()} free (${pct(b.reads / FREE.r2Reads)}), ${b.writes.toLocaleString()} writes`,
    rows: b.error ? [] : b.ops.map(([k, n]) => [k, n.toLocaleString()]), head: ['Operation', 'Requests'] });
  const h = r.health;
  s.push({ title: 'up/ Function health (past the edge cache)', lead: h.error ? `unavailable: ${h.error}` : `${h.pointsToday.toLocaleString()} Analytics Engine points today of ${FREE.points.toLocaleString()} free`,
    rows: h.error ? [] : h.rows.map(([k, o, n, p50]) => [`${k} ${o}`, n.toLocaleString(), `${p50} ms`]), head: ['Request', 'Count', 'Median'] });
  return s;
}
export function render(r, fmt = 'text', now = new Date()) {
  const s = sections(r), warn = problems(r, now), out = [];
  if (fmt === 'markdown') {
    out.push(`# nextmap stats, ${r.period.name}`, '', `${r.period.from.slice(0, 10)} to ${r.period.to.slice(0, 10)} (UTC), written ${iso(now)}`, '');
    if (warn.length) out.push('**Attention:** ' + warn.join(' · '), '');
    for (const sec of s) {
      out.push(`## ${sec.title}`, '');
      if (sec.lead) out.push(sec.lead, '');
      if (sec.rows.length) out.push(`| ${sec.head.join(' | ')} |`, `| ${sec.head.map(() => '---').join(' | ')} |`, ...sec.rows.map((row) => `| ${row.join(' | ')} |`), '');
    }
  } else {
    out.push(`nextmap stats, ${r.period.name}: ${r.period.from.slice(0, 16)} to ${r.period.to.slice(0, 16)} UTC`);
    if (warn.length) out.push('', ...warn.map((w) => `!! ${w}`));
    for (const sec of s) {
      out.push('', sec.title.toUpperCase());
      if (sec.lead) out.push(`  ${sec.lead}`);
      const w = sec.rows.reduce((m, row) => Math.max(m, row[0].length), 0);
      for (const row of sec.rows) out.push(`  ${row[0].padEnd(w)}  ${row.slice(1).join('  ')}`);
    }
  }
  return out.join('\n');
}

// ------------------------------------------------------------ main
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const args = process.argv.slice(2), flag = (f) => args.includes(f);
  const cmd = args.find((a) => !a.startsWith('--')) || 'week';
  try {
    if (cmd === 'sql') { console.log(JSON.stringify(await sql(args[args.indexOf('sql') + 1]), null, 2)); }
    else if (cmd === 'check') {
      const r = await report('week'), warn = problems(r);
      console.log(warn.length ? warn.map((w) => `!! ${w}`).join('\n') : 'ok: all quotas and error rates within limits');
      process.exit(warn.length ? 1 : 0);
    } else {
      if (!['today', 'week', 'month'].includes(cmd)) throw new Error(`unknown period ${cmd}; use today, week or month`);
      const r = await report(cmd);
      console.log(flag('--json') ? JSON.stringify(r, null, 2) : render(r, flag('--markdown') ? 'markdown' : 'text'));
    }
  } catch (e) { console.error(`stats: ${e.message}`); process.exit(2); }
}
