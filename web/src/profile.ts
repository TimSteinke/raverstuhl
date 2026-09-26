/** SVG chart of one propagation path: terrain, canopy, line of sight and the diffraction path. */

import type { PathDetail } from './propagation';

const W = 340;
const H = 150;
const PAD = { l: 34, r: 8, t: 10, b: 22 };

export function profileSvg(d: PathDetail): string {
  const t = d.profileT;
  const z = d.profileZ;
  const c = d.profileC;
  if (!t.length) return '';
  const zTop = z.map((v, i) => v + (c[i] > 3 ? c[i] : 0));
  const zmin = Math.min(...z) - 5;
  const zmax = Math.max(...zTop, d.zs, d.zr) + 10;
  const X = (v: number) => PAD.l + (v / t[t.length - 1]) * (W - PAD.l - PAD.r);
  const Y = (v: number) => PAD.t + (1 - (v - zmin) / (zmax - zmin)) * (H - PAD.t - PAD.b);
  // Drop the endpoints (they carry source/receiver height, not ground) for the ground polygon.
  const ground = t.map((v, i) => `${X(v).toFixed(1)},${Y(i === 0 ? d.zs - 1.5 : i === t.length - 1 ? d.zr - 4 : z[i]).toFixed(1)}`);
  const groundPoly = `${X(0)},${Y(zmin)} ${ground.join(' ')} ${X(t[t.length - 1])},${Y(zmin)}`;
  let canopy = '';
  for (let i = 1; i < t.length - 1; i++) {
    if (c[i] > 3) {
      canopy += `<line x1="${X(t[i]).toFixed(1)}" x2="${X(t[i]).toFixed(1)}" y1="${Y(z[i]).toFixed(1)}" y2="${Y(z[i] + c[i]).toFixed(1)}" />`;
    }
  }
  const hull = d.hull.map((i) => `${X(t[i]).toFixed(1)},${Y(z[i]).toFixed(1)}`).join(' ');
  const edges = d.hull.slice(1, -1).map((i) => `<circle cx="${X(t[i]).toFixed(1)}" cy="${Y(z[i]).toFixed(1)}" r="2.5" />`).join('');
  const ticks = [zmin + 5, (zmin + zmax) / 2, zmax - 10].map((v) =>
    `<text x="${PAD.l - 4}" y="${Y(v) + 3}" text-anchor="end">${Math.round(v)}</text>`).join('');
  const km = t[t.length - 1] / 1000;
  return `<svg class="profile" viewBox="0 0 ${W} ${H}" role="img" aria-label="Terrain profile along the propagation path">
    <polygon class="p-ground" points="${groundPoly}" />
    <g class="p-canopy">${canopy}</g>
    <line class="p-direct" x1="${X(0)}" y1="${Y(d.zs)}" x2="${X(t[t.length - 1])}" y2="${Y(d.zr)}" />
    <polyline class="p-hull" points="${hull}" />
    <g class="p-edges">${edges}</g>
    <circle class="p-src" cx="${X(0)}" cy="${Y(d.zs)}" r="4" />
    <rect class="p-rec" x="${X(t[t.length - 1]) - 4}" y="${Y(d.zr) - 4}" width="8" height="8" />
    <g class="p-axis">${ticks}
      <text x="${PAD.l}" y="${H - 6}">0</text>
      <text x="${W - PAD.r}" y="${H - 6}" text-anchor="end">${km.toFixed(2)} km</text>
      <text x="${(W + PAD.l) / 2}" y="${H - 6}" text-anchor="middle">m a.s.l. · ${d.nEdges} diffraction edge${d.nEdges === 1 ? '' : 's'}</text>
    </g>
  </svg>`;
}
