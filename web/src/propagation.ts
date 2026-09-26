/**
 * ISO 9613-2 octave-band propagation over terrain: a line-by-line port of
 * src/geoacoustics/acoustics/propagation.py (numba). Tested against the Python kernel with the
 * exported test vectors (propagation.test.ts). Keep both in sync.
 */

export const SPEED_OF_SOUND = 340.0;

export interface Raster {
  /** Row-major, north row first; NaN = no data. */
  z: Float32Array | Float64Array;
  rows: number;
  cols: number;
  x0: number; // west edge (m)
  y0: number; // north edge (m)
  res: number;
}

export interface BandModel {
  freqs: number[];
  isoIdx: number[];
  lw: number[];
  alphaDbKm: number[];
  folFixed: number[];
  folPerM: number[];
  groundG: [number, number, number];
  useKmet: boolean;
  stepM: number;
  hs: number;
  hr: number;
  maxRangeM: number;
}

export interface Scratch {
  t: Float64Array;
  z: Float64Array;
  c: Float64Array;
  hull: Int32Array;
}

export function makeScratch(model: BandModel): Scratch {
  const n = Math.trunc(model.maxRangeM / model.stepM) + 4;
  return { t: new Float64Array(n), z: new Float64Array(n), c: new Float64Array(n), hull: new Int32Array(n) };
}

export function bilinear(r: Raster, x: number, y: number): number {
  const fc = (x - r.x0) / r.res - 0.5;
  const fr = (r.y0 - y) / r.res - 0.5;
  const ri = Math.floor(fr);
  const ci = Math.floor(fc);
  if (ri < 0 || ci < 0 || ri + 1 >= r.rows || ci + 1 >= r.cols) return NaN;
  const dr = fr - ri;
  const dc = fc - ci;
  const z = r.z;
  const i = ri * r.cols + ci;
  return (z[i] * (1 - dc) + z[i + 1] * dc) * (1 - dr) + (z[i + r.cols] * (1 - dc) + z[i + r.cols + 1] * dc) * dr;
}

function groundRegion(bandIdxIso: number, h: number, dp: number, G: number): number {
  const e50 = 1.0 - Math.exp(-dp / 50.0);
  if (bandIdxIso <= 1) return -1.5;
  if (bandIdxIso === 2) {
    const a =
      1.5 + 3.0 * Math.exp(-0.12 * (h - 5.0) ** 2) * e50 + 5.7 * Math.exp(-0.09 * h * h) * (1.0 - Math.exp(-2.8e-6 * dp * dp));
    return -1.5 + G * a;
  }
  if (bandIdxIso === 3) return -1.5 + G * (1.5 + 8.6 * Math.exp(-0.09 * h * h) * e50);
  if (bandIdxIso === 4) return -1.5 + G * (1.5 + 14.0 * Math.exp(-0.46 * h * h) * e50);
  if (bandIdxIso === 5) return -1.5 + G * (1.5 + 5.0 * Math.exp(-0.9 * h * h) * e50);
  return -1.5 * (1.0 - G);
}

function ground(bandIdxIso: number, hs: number, hr: number, dp: number, g: [number, number, number]): number {
  let q = 0.0;
  if (dp > 30.0 * (hs + hr)) q = 1.0 - (30.0 * (hs + hr)) / dp;
  const am = bandIdxIso <= 1 ? -3.0 * q : -3.0 * q * (1.0 - g[1]);
  return groundRegion(bandIdxIso, hs, dp, g[0]) + groundRegion(bandIdxIso, hr, dp, g[2]) + am;
}

/** Per-band breakdown of one path, for the path inspector. */
export interface PathDetail {
  d2d: number;
  direct: number;
  pathLen: number;
  zDiff: number;
  nEdges: number;
  kmet: number;
  folLen: number;
  adiv: number;
  n: number;
  profileT: number[];
  profileZ: number[];
  profileC: number[];
  hull: number[];
  zs: number;
  zr: number;
  bands: { f: number; aatm: number; agr: number; dz: number; att: number; afol: number; lp: number }[];
}

/**
 * Band levels at (rx, ry) from a source at (sx, sy), written to `out`. Returns the 2D distance.
 * With `detail`, also fills in the attenuation terms and the profile.
 */
export function pathLevels(
  terrain: Raster,
  canopy: Raster,
  m: BandModel,
  sx: number,
  sy: number,
  rx: number,
  ry: number,
  out: Float64Array,
  s: Scratch,
  detail?: PathDetail,
): number {
  const dx = rx - sx;
  const dy = ry - sy;
  let d2d = Math.sqrt(dx * dx + dy * dy);
  const gs = bilinear(terrain, sx, sy);
  const gr = bilinear(terrain, rx, ry);
  const nb = m.freqs.length;
  if (Number.isNaN(gs) || Number.isNaN(gr)) {
    for (let b = 0; b < nb; b++) out[b] = NaN;
    return d2d;
  }
  const zs = gs + m.hs;
  const zr = gr + m.hr;
  d2d = Math.max(d2d, 1.0);
  const n = Math.min(Math.max(Math.trunc(d2d / m.stepM), 2), s.t.length - 1);
  const T = s.t,
    Z = s.z,
    C = s.c,
    H = s.hull;

  for (let i = 0; i <= n; i++) {
    const f = i / n;
    T[i] = f * d2d;
    if (i === 0) Z[i] = zs;
    else if (i === n) Z[i] = zr;
    else {
      const g = bilinear(terrain, sx + f * dx, sy + f * dy);
      Z[i] = Number.isNaN(g) ? zs + f * (zr - zs) : g;
    }
    const cz = bilinear(canopy, sx + f * dx, sy + f * dy);
    C[i] = Number.isNaN(cz) ? 0.0 : cz;
  }

  // Upper convex hull (monotone chain) = shortest path over the terrain.
  let k = 0;
  for (let i = 0; i <= n; i++) {
    while (k >= 2) {
      const o = H[k - 2];
      const a = H[k - 1];
      const cross = (T[a] - T[o]) * (Z[i] - Z[o]) - (Z[a] - Z[o]) * (T[i] - T[o]);
      if (cross >= 0.0) k -= 1;
      else break;
    }
    H[k] = i;
    k += 1;
  }

  const direct = Math.sqrt(d2d * d2d + (zr - zs) ** 2);
  let path = 0.0;
  for (let j = 0; j < k - 1; j++) {
    const a = H[j];
    const b = H[j + 1];
    path += Math.sqrt((T[b] - T[a]) ** 2 + (Z[b] - Z[a]) ** 2);
  }
  const zDiff = path - direct;
  const nEdges = k - 2;
  let dss = 0.0;
  let dsr = 0.0;
  let e = 0.0;
  if (nEdges >= 1) {
    const a = H[1];
    const b = H[k - 2];
    dss = Math.sqrt(T[a] ** 2 + (Z[a] - zs) ** 2);
    dsr = Math.sqrt((d2d - T[b]) ** 2 + (zr - Z[b]) ** 2);
    e = Math.max(path - dss - dsr, 0.0);
  }

  // Length of the (hull) path inside canopy taller than 3 m.
  let folLen = 0.0;
  let j = 0;
  for (let i = 1; i < n; i++) {
    while (H[j + 1] < i) j += 1;
    const a = H[j];
    const b = H[j + 1];
    const w = (T[i] - T[a]) / Math.max(T[b] - T[a], 1e-9);
    const hp = Z[a] + w * (Z[b] - Z[a]);
    if (C[i] > 3.0 && hp < Z[i] + C[i]) folLen += d2d / n;
  }
  folLen = Math.min(folLen, 200.0);

  const adiv = 20.0 * Math.log10(direct) + 11.0;
  let kmet = 1.0;
  if (m.useKmet && zDiff > 0.0 && nEdges >= 1) {
    kmet = Math.exp(-(1.0 / 2000.0) * Math.sqrt((dss * dsr * direct) / (2.0 * zDiff)));
  }
  if (detail) detail.bands = [];
  for (let bi = 0; bi < nb; bi++) {
    const lam = SPEED_OF_SOUND / m.freqs[bi];
    const agr = ground(m.isoIdx[bi], m.hs, m.hr, d2d, m.groundG);
    let att = agr;
    let dz = 0.0;
    if (nEdges >= 1 && zDiff > 0.0) {
      let c3 = 1.0;
      if (nEdges >= 2 && e > 0.0) {
        const r = ((5.0 * lam) / e) ** 2;
        c3 = (1.0 + r) / (1.0 / 3.0 + r);
      }
      dz = 10.0 * Math.log10(3.0 + (20.0 / lam) * c3 * zDiff * kmet);
      dz = Math.min(dz, nEdges === 1 ? 20.0 : 25.0);
      att = Math.max(agr, dz);
    }
    let afol = 0.0;
    if (folLen >= 20.0) afol = folLen * m.folPerM[bi];
    else if (folLen >= 10.0) afol = m.folFixed[bi];
    const aatm = (m.alphaDbKm[bi] * direct) / 1000.0;
    out[bi] = m.lw[bi] - adiv - aatm - att - afol;
    if (detail) detail.bands.push({ f: m.freqs[bi], aatm, agr, dz, att, afol, lp: out[bi] });
  }
  if (detail) {
    Object.assign(detail, {
      d2d, direct, pathLen: path, zDiff, nEdges, kmet, folLen, adiv, n, zs, zr,
      profileT: Array.from(T.subarray(0, n + 1)),
      profileZ: Array.from(Z.subarray(0, n + 1)),
      profileC: Array.from(C.subarray(0, n + 1)),
      hull: Array.from(H.subarray(0, k)),
    });
  }
  return d2d;
}

export function emptyDetail(): PathDetail {
  return {
    d2d: 0, direct: 0, pathLen: 0, zDiff: 0, nEdges: 0, kmet: 1, folLen: 0, adiv: 0, n: 0,
    profileT: [], profileZ: [], profileC: [], hull: [], zs: 0, zr: 0, bands: [],
  };
}
