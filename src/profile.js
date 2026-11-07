// The elevation profile on a canvas: distance along the bottom, height up the side, a marker where the pointer is.
// Steep stretches can be filled in the colour of their class (one colour or null per sample).
const PAD = { l: 44, r: 8, t: 10, b: 22 };

export function drawProfile(canvas, p, { color = '#ff5a2e', colors = null, hover = -1 } = {}) {
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const es = p.e.filter((v) => v != null);
  if (!es.length) return;
  const lo = Math.floor(Math.min(...es) / 100) * 100, hi = Math.ceil(Math.max(...es) / 100) * 100 || lo + 100;
  const total = p.d[p.d.length - 1] || 1;
  const X = (d) => PAD.l + (d / total) * (W - PAD.l - PAD.r), Y = (e) => H - PAD.b - ((e - lo) / Math.max(hi - lo, 1)) * (H - PAD.t - PAD.b);
  ctx.font = '18px system-ui'; ctx.fillStyle = 'rgba(242,241,236,0.6)'; ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1;
  const step = (hi - lo) > 1200 ? 500 : (hi - lo) > 500 ? 200 : 100;
  for (let e = lo; e <= hi; e += step) { ctx.beginPath(); ctx.moveTo(PAD.l, Y(e)); ctx.lineTo(W - PAD.r, Y(e)); ctx.stroke(); ctx.fillText(e, 2, Y(e) + 6); }
  const kstep = total > 40000 ? 10000 : total > 20000 ? 5000 : total > 8000 ? 2000 : total > 2500 ? 1000 : 500;
  for (let d = kstep; d < total; d += kstep) ctx.fillText(`${d / 1000}`, X(d) - 5, H - 3);
  const curve = () => p.d.forEach((d, i) => { if (p.e[i] != null) ctx.lineTo(X(d), Y(p.e[i])); });
  ctx.beginPath(); ctx.moveTo(X(0), H - PAD.b); curve(); ctx.lineTo(X(total), H - PAD.b); ctx.closePath();
  ctx.fillStyle = color + '55'; ctx.fill();
  // steep stretches: runs of samples with the same colour, filled down to the axis
  if (colors) for (let i = 1; i < p.d.length;) {
    if (!colors[i] || p.e[i] == null || p.e[i - 1] == null) { i++; continue; }
    let j = i;
    while (j + 1 < p.d.length && colors[j + 1] === colors[i] && p.e[j + 1] != null) j++;
    ctx.beginPath(); ctx.moveTo(X(p.d[i - 1]), H - PAD.b);
    for (let k = i - 1; k <= j; k++) ctx.lineTo(X(p.d[k]), Y(p.e[k]));
    ctx.lineTo(X(p.d[j]), H - PAD.b); ctx.closePath();
    ctx.fillStyle = colors[i] + 'b0'; ctx.fill();
    i = j + 1;
  }
  ctx.beginPath(); curve(); ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.stroke();
  if (hover >= 0) {
    const x = X(p.d[hover]);
    ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, H - PAD.b); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 20px system-ui';
    const label = `${(p.d[hover] / 1000).toFixed(1)} km · ${Math.round(p.e[hover])} m`;
    ctx.fillText(label, Math.min(x + 6, W - ctx.measureText(label).width - 4), PAD.t + 18);
  }
}

// the sample under the pointer
export function profileIndex(canvas, p, clientX) {
  const r = canvas.getBoundingClientRect(), x = ((clientX - r.left) / r.width) * canvas.width;
  const total = p.d[p.d.length - 1], d = ((x - PAD.l) / (canvas.width - PAD.l - PAD.r)) * total;
  let i = 0;
  while (i < p.d.length - 1 && p.d[i] < d) i++;
  return i;
}
