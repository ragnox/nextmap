// Numbers as the panels show them, the row of route figures, and text made safe for HTML.
export const km = (m) => (m == null ? '–' : m >= 10000 ? `${(m / 1000).toFixed(0)} km` : `${(m / 1000).toFixed(1)} km`);
export const hm = (m) => (m == null ? '–' : `${Math.round(m).toLocaleString('de-AT')} m`);
export const hours = (h) => {
  if (h == null) return null;
  const min = Math.round(h * 60);
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')} h`;
};
export const statsHtml = (s) => [['Length', km(s.length)], ['Ascent', hm(s.ascent)], ['Descent', hm(s.descent)], ['Highest', hm(s.max)], ['Lowest', hm(s.min)], ['Time', hours(s.duration) || '–']]
  .map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('');
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
