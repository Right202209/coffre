import { clamp, valid } from "./metrics.js";
export const metricColors = { cpu: "#38bdf8", memory: "#34d399", disk: "#fbbf24", network: "#22d3ee" };
export function networkScale(rate) { return valid(rate) ? Math.min(100, Math.log10(rate + 1) * 14) : null; }
export function ringSvg(value) {
  const pct = valid(value) ? clamp(value) : 0;
  // Circumference is itself 100. Renderers that ignore SVG pathLength still draw the correct arc.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44"><circle cx="22" cy="22" r="${100 / (2 * Math.PI)}" fill="none" stroke="currentColor" stroke-width="5" pathLength="100" stroke-dasharray="${pct} ${100 - pct}" transform="rotate(-90 22 22)"/></svg>`;
}
export function trendPoints(history, key) {
  const values = history.slice(-24).map(point => point[key]);
  const max = key === "network" ? Math.max(1, ...values.filter(valid)) : 100;
  // Fixed x scale preserves missing-sample gaps; never backfill invented values.
  return values.map((value, i) => valid(value) ? { x: 2 + i * 116 / 23,
    y: 32 - Math.min(1, value / max) * 30 } : null);
}
export function segments(points) {
  const result = []; let current = [];
  for (const point of points) {
    if (point) current.push(point);
    else if (current.length) { result.push(current); current = []; }
  }
  if (current.length) result.push(current);
  return result;
}
export function trendSvg(history, key) {
  const paths = segments(trendPoints(history, key)).filter(s => s.length > 1).map(s => {
    const line = `M ${s.map(p => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" L ")}`;
    return `<path d="${line} L ${s.at(-1).x.toFixed(2)} 34 L ${s[0].x.toFixed(2)} 34 Z" fill="currentColor" opacity="0.12"/><path d="${line}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 34">${paths.join("")}</svg>`;
}
