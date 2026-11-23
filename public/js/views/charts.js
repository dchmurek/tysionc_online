// Wykresy (Chart.js hostowany lokalnie). Bez biblioteki – czytelny komunikat zamiast pustego miejsca.
const charts = new WeakMap();
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function base() {
  const muted = css('--muted');
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 450 },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: '#f4efe2', titleColor: '#14110a', bodyColor: '#14110a', padding: 10, cornerRadius: 10, usePointStyle: true } },
    scales: { x: { grid: { display: false }, ticks: { color: muted }, border: { color: css('--axis') } }, y: { grid: { color: css('--grid') }, ticks: { color: muted }, border: { display: false } } },
  };
}

function make(canvas, cfg) {
  if (!canvas) return null;
  if (!window.Chart) { canvas.replaceWith(Object.assign(document.createElement('p'), { className: 'muted small', textContent: 'Wykres niedostępny (biblioteka się nie wczytała).' })); return null; }
  window.Chart.defaults.font.family = css('--sans');
  const ch = new window.Chart(canvas, cfg);
  const root = canvas.closest('.view');
  if (root) { const list = charts.get(root) || []; list.push(ch); charts.set(root, list); }
  return ch;
}

export function destroyCharts(root) {
  for (const c of charts.get(root) || []) c.destroy();
  charts.set(root, []);
}

export function lineChart(canvas, { labels, series, refs = [], xTitle, stepped = false }) {
  const o = base();
  o.interaction = { mode: 'index', intersect: false };
  o.plugins.tooltip.filter = (i) => i.dataset.ref !== true;
  if (xTitle) o.scales.x.title = { display: true, text: xTitle, color: css('--muted') };
  o.scales.x.ticks.maxTicksLimit = 10;
  const datasets = series.map((s) => ({ label: s.label, data: s.data, borderColor: s.color, backgroundColor: s.color, borderWidth: 2, pointRadius: labels.length > 30 ? 0 : 3, pointBorderColor: css('--surface'), pointBorderWidth: 2, tension: 0, stepped }));
  for (const r of refs) datasets.push({ label: r.label, ref: true, data: labels.map(() => r.value), borderColor: 'rgba(201,164,92,.55)', borderDash: [5, 5], borderWidth: 1, pointRadius: 0 });
  return make(canvas, { type: 'line', data: { labels, datasets }, options: o });
}

export function barChart(canvas, { labels, data, colors, max, suffix = '', horizontal = true, tooltip }) {
  const o = base();
  if (horizontal) {
    o.indexAxis = 'y';
    const { x, y } = o.scales;
    o.scales = { x: { ...y, beginAtZero: true, ticks: { ...y.ticks, precision: 0 } }, y: { ...x, ticks: { ...x.ticks, color: css('--ink-2') } } };
    if (max) o.scales.x.max = max;
    if (suffix) o.scales.x.ticks.callback = (v) => v + suffix;
  }
  if (tooltip) o.plugins.tooltip.callbacks = { label: tooltip };
  return make(canvas, { type: 'bar', data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 26 }] }, options: o });
}

export function stackedBars(canvas, { labels, sets }) {
  const o = base();
  o.scales.x.stacked = true;
  o.scales.y.stacked = true;
  o.scales.y.ticks.precision = 0;
  o.interaction = { mode: 'index', intersect: false };
  return make(canvas, { type: 'bar', data: { labels, datasets: sets.map((s) => ({ label: s.label, data: s.data, backgroundColor: s.color, borderRadius: 4, maxBarThickness: 34 })) }, options: o });
}
