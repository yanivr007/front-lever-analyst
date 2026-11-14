// Minimal SVG charts: one y-axis, thin marks, recessive grid, tap/hover tooltip.

export interface Series { name: string; color: string; points: { x: number; y: number }[] }
export interface ChartOpts {
  fmtX: (x: number) => string;
  fmtY: (y: number) => string;
  yMin?: number; yMax?: number;
  /** Draw a reference line at this y (e.g. 0° = horizontal). */
  refY?: number;
  dots?: boolean;
}

const W = 340, H = 150, PL = 34, PR = 10, PT = 10, PB = 22;

function niceRange(lo: number, hi: number): [number, number] {
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.1;
  return [lo - pad, hi + pad];
}

export function lineChart(el: HTMLElement, series: Series[], o: ChartOpts) {
  const all = series.flatMap(s => s.points);
  if (!all.length) { el.innerHTML = '<p class="muted">אין עדיין נתונים</p>'; return; }
  const xs = all.map(p => p.x), ys = all.map(p => p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  if (x0 === x1) { x0 -= 1; x1 += 1; }
  const [ry0, ry1] = niceRange(Math.min(...ys, o.refY ?? Infinity), Math.max(...ys, o.refY ?? -Infinity));
  const y0 = o.yMin ?? ry0, y1 = o.yMax ?? ry1;
  const sx = (x: number) => PL + ((x - x0) / (x1 - x0)) * (W - PL - PR);
  const sy = (y: number) => PT + (1 - (y - y0) / (y1 - y0)) * (H - PT - PB);
  const grid = [0, 0.5, 1].map(f => {
    const y = y0 + f * (y1 - y0);
    return `<line class="grid" x1="${PL}" x2="${W - PR}" y1="${sy(y)}" y2="${sy(y)}"/><text class="axis" x="${PL - 5}" y="${sy(y) + 3}" text-anchor="end">${o.fmtY(y)}</text>`;
  }).join('');
  const ref = o.refY !== undefined ? `<line class="ref" x1="${PL}" x2="${W - PR}" y1="${sy(o.refY)}" y2="${sy(o.refY)}"/>` : '';
  const lines = series.map(s => {
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join('');
    const dots = o.dots ? s.points.map(p => `<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`).join('') : '';
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
  }).join('');
  const legend = series.length > 1
    ? `<div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('')}</div>` : '';
  el.innerHTML = `${legend}<div class="chart-wrap" dir="ltr">
    <svg viewBox="0 0 ${W} ${H}" role="img">
      ${grid}${ref}
      <text class="axis" x="${PL}" y="${H - 5}">${o.fmtX(x0)}</text>
      <text class="axis" x="${W - PR}" y="${H - 5}" text-anchor="end">${o.fmtX(x1)}</text>
      ${lines}
      <line class="cross" y1="${PT}" y2="${H - PB}" visibility="hidden"/>
    </svg><div class="tip" hidden></div></div>`;

  const svg = el.querySelector('svg')!, cross = el.querySelector<SVGLineElement>('.cross')!, tip = el.querySelector<HTMLElement>('.tip')!;
  const uniqX = [...new Set(xs)].sort((a, b) => a - b);
  const show = (ev: PointerEvent) => {
    const r = svg.getBoundingClientRect();
    const vx = ((ev.clientX - r.left) / r.width) * W;
    const x = uniqX.reduce((best, c) => (Math.abs(sx(c) - vx) < Math.abs(sx(best) - vx) ? c : best));
    cross.setAttribute('x1', String(sx(x))); cross.setAttribute('x2', String(sx(x))); cross.setAttribute('visibility', 'visible');
    const rows = series.map(s => {
      const p = s.points.reduce((b, c) => (Math.abs(c.x - x) < Math.abs(b.x - x) ? c : b));
      return `<div><i style="background:${s.color}"></i>${series.length > 1 ? s.name + ': ' : ''}<b>${o.fmtY(p.y)}</b></div>`;
    }).join('');
    tip.innerHTML = `<div class="muted">${o.fmtX(x)}</div>${rows}`;
    tip.hidden = false;
    const left = (sx(x) / W) * r.width;
    tip.style.left = Math.min(Math.max(left, 50), r.width - 50) + 'px';
  };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
}
