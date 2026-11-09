// Usage counts on the public site: tallies of which regions, layers and functions a visit used, sent once as one
// small beacon when the tab is hidden (shared/stats.js says what may be counted). Off in the local app, on
// localhost, and for visitors with Global Privacy Control; nothing is stored in the browser.
import { tally, encode } from '../shared/stats.js';

export function createStats({ enabled = false, url = 'stats' } = {}) {
  let counts = {};
  const on = enabled && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function';
  const count = (event, value = '') => { if (on) tally(counts, event, value); };
  function flush() {
    if (!on || !Object.keys(counts).length) return false;
    const text = encode(counts);
    counts = {};
    try { return navigator.sendBeacon(url, new Blob([text], { type: 'text/plain' })); } catch { return false; }
  }
  if (on) {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('pagehide', flush);
    // what broke, by type only: no message, no stack, no URL
    window.addEventListener('error', (e) => count('error', e.message && /webgl/i.test(e.message) ? 'webgl' : 'js'));
    window.addEventListener('unhandledrejection', () => count('error', 'promise'));
  }
  return { count, flush, enabled: on };
}

// on: the static site, not on localhost, and the visitor has not asked not to be counted
export function statsEnabled(backend) {
  if (!backend || backend.mode !== 'static') return false;
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return false;
  if (navigator.globalPrivacyControl === true) return false;
  return true;
}
