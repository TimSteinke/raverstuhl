/** Paints the raster overlays (rating/sub-scores, click noise map) into canvases for MapLibre. */

import { sampleBilinear, type Dataset } from './data';
import type { NoiseResult } from './engine';
import { accessScore, combine, hiddenScore, noiseScore, sizeScore, type Weights } from './scoring';

export type Mode = 'rating' | 'noise' | 'cost' | 'access' | 'hidden' | 'open';

type Stop = [number, number, number, number, number]; // value, r, g, b, a(0-1)

function ramp(stops: Stop[]) {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let k = 0;
    while (k < stops.length - 2 && v > stops[k + 1][0]) k++;
    const [v0, ...a] = stops[k];
    const [v1, ...b] = stops[k + 1];
    const t = Math.min(Math.max((v - v0) / (v1 - v0 || 1), 0), 1);
    for (let j = 0; j < 4; j++) lut[i * 4 + j] = (a[j] + (b[j] - a[j]) * t) * (j === 3 ? 255 : 1);
  }
  return lut;
}

/** Cyan: the "good" quantity (rating, scores). */
export const RAMP_CYAN = ramp([
  [0.0, 0, 20, 40, 0.0],
  [0.25, 0, 70, 110, 0.35],
  [0.5, 0, 140, 190, 0.6],
  [0.8, 0, 229, 255, 0.82],
  [1.0, 210, 255, 255, 0.95],
]);
/** Magenta: sound where it shouldn't be (disturbance, excess over threshold). */
export const RAMP_MAGENTA = ramp([
  [0.0, 60, 0, 90, 0.0],
  [0.12, 110, 20, 170, 0.35],
  [0.4, 220, 30, 200, 0.6],
  [0.75, 255, 60, 150, 0.8],
  [1.0, 255, 230, 245, 0.95],
]);

export function rampCss(lut: Uint8ClampedArray, n = 12): string {
  const parts = [];
  for (let i = 0; i <= n; i++) {
    const k = Math.round((i / n) * 255) * 4;
    parts.push(`rgba(${lut[k]},${lut[k + 1]},${lut[k + 2]},${(lut[k + 3] / 255).toFixed(2)}) ${((i / n) * 100).toFixed(0)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(',')})`;
}

/** Cost (people disturbed) → [0, 1] on a log scale: 0.1 … 3000 people. */
export function costT(cost: number): number {
  return Math.min(Math.max(Math.log10(Math.max(cost, 0.1) / 0.1) / Math.log10(30000), 0), 1);
}

/** Per display cell values that don't depend on the weights. */
export interface CellCache {
  cost: Float32Array;
  worst: Float32Array;
  noise: Float32Array;
  access: Float32Array;
  hidden: Float32Array;
  size: Float32Array;
  open: Uint8Array;
}

export function buildCellCache(ds: Dataset): CellCache {
  const { meta, layers, heat } = ds;
  const g = meta.display;
  const n = g.rows * g.cols;
  const c: CellCache = {
    cost: new Float32Array(n), worst: new Float32Array(n), noise: new Float32Array(n),
    access: new Float32Array(n), hidden: new Float32Array(n), size: new Float32Array(n), open: new Uint8Array(n),
  };
  const minArea = meta.candidates.min_area_m2 as number;
  for (let r = 0; r < g.rows; r++) {
    const y = g.ymax - (r + 0.5) * g.res;
    for (let col = 0; col < g.cols; col++) {
      const i = r * g.cols + col;
      const x = g.xmin + (col + 0.5) * g.res;
      const cost = sampleBilinear(meta.heat, heat.cost, x, y);
      c.cost[i] = cost;
      c.worst[i] = sampleBilinear(meta.heat, heat.worst, x, y);
      c.noise[i] = Number.isNaN(cost) ? NaN : noiseScore(cost, meta);
      c.access[i] = accessScore(layers.dist_vehicle[i], meta);
      c.hidden[i] = hiddenScore(layers.visible[i], meta);
      c.size[i] = sizeScore(layers.open_area[i], meta);
      c.open[i] = layers.open_frac[i] > 0.25 && layers.open_area[i] >= minArea && layers.elev[i] > 0 ? 1 : 0;
    }
  }
  return c;
}

export function paintScores(canvas: HTMLCanvasElement, ds: Dataset, cache: CellCache, mode: Mode, w: Weights) {
  const g = ds.meta.display;
  canvas.width = g.cols;
  canvas.height = g.rows;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(g.cols, g.rows);
  const px = img.data;
  const maxWorst = ds.meta.impact.max_worst_db;
  const n = g.rows * g.cols;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(cache.noise[i]) || ds.layers.elev[i] === 0) continue;
    let v: number;
    let lut = RAMP_CYAN;
    let alpha = 1;
    const s = { noise: cache.noise[i], access: cache.access[i], size: cache.size[i], hidden: cache.hidden[i] };
    switch (mode) {
      case 'rating': {
        const feasible = cache.worst[i] <= maxWorst;
        if (cache.open[i]) v = combine(s, w, feasible);
        else {
          // Off open ground: the location rating without the field-size term, dimmed.
          const { size: _size, ...rest } = w;
          v = combine({ ...s, size: 1 }, { ...rest, size: 0 }, feasible);
          alpha = 0.5;
        }
        v = Math.sqrt(v); // most ratings are small; a √ scale shows their distribution
        break;
      }
      case 'noise': v = s.noise; break;
      case 'cost': v = costT(cache.cost[i]); lut = RAMP_MAGENTA; alpha = 0.72; break;
      case 'access': v = s.access; break;
      case 'hidden': v = s.hidden; break;
      case 'open': v = cache.open[i] ? 0.35 + 0.65 * s.size : 0; break;
    }
    const k = Math.round(Math.min(Math.max(v, 0), 1) * 255) * 4;
    px[i * 4] = lut[k];
    px[i * 4 + 1] = lut[k + 1];
    px[i * 4 + 2] = lut[k + 2];
    px[i * 4 + 3] = lut[k + 3] * alpha;
  }
  ctx.putImageData(img, 0, 0);
}

/** Excess (dB over the indoor-detection threshold) → [0, 1]: 0 … 30 dB. */
export function excessT(ex: number): number {
  return Math.min(Math.max(ex / 30, 0), 1);
}

export const ISO_LINES_DB = [0, 10, 20];

/**
 * Noise footprint of one source: max-over-bands (or one band) excess, upsampled ×`up` with bilinear
 * interpolation, plus bright isolines at ISO_LINES_DB.
 */
export function paintNoise(canvas: HTMLCanvasElement, res: NoiseResult, thresholds: number[], band: number, gainDb: number, up = 4) {
  const { rows, cols } = res.grid;
  const nb = thresholds.length;
  const ex = new Float32Array(rows * cols);
  for (let i = 0; i < rows * cols; i++) {
    let v = -99;
    for (let b = 0; b < nb; b++) {
      if (band >= 0 && b !== band) continue;
      const lp = res.levels[i * nb + b];
      if (!Number.isNaN(lp)) v = Math.max(v, lp + gainDb - thresholds[b]);
    }
    ex[i] = v;
  }
  const W = cols * up;
  const H = rows * up;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const px = img.data;
  const fine = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const fr = Math.min(Math.max((y + 0.5) / up - 0.5, 0), rows - 1.001);
    const r = Math.floor(fr), dr = fr - r;
    for (let x = 0; x < W; x++) {
      const fc = Math.min(Math.max((x + 0.5) / up - 0.5, 0), cols - 1.001);
      const c = Math.floor(fc), dc = fc - c;
      const i = r * cols + c;
      fine[y * W + x] = (ex[i] * (1 - dc) + ex[i + 1] * dc) * (1 - dr) + (ex[i + cols] * (1 - dc) + ex[i + cols + 1] * dc) * dr;
    }
  }
  const cls = (v: number) => {
    let k = 0;
    while (k < ISO_LINES_DB.length && v >= ISO_LINES_DB[k]) k++;
    return k;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const v = fine[i];
      if (v < -1) continue;
      const k = Math.round(excessT(v) * 255) * 4;
      const a = Math.max(RAMP_MAGENTA[k + 3] * 0.72, 38);
      const c0 = cls(v);
      const edge = (x + 1 < W && cls(fine[i + 1]) !== c0) || (y + 1 < H && cls(fine[i + W]) !== c0);
      if (edge && v > -1) {
        px[i * 4] = 255; px[i * 4 + 1] = 190; px[i * 4 + 2] = 250; px[i * 4 + 3] = 150;
      } else {
        px[i * 4] = RAMP_MAGENTA[k]; px[i * 4 + 1] = RAMP_MAGENTA[k + 1]; px[i * 4 + 2] = RAMP_MAGENTA[k + 2]; px[i * 4 + 3] = a;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}
