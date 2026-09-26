/** Assembles terrain/canopy windows from the exported 2 km chunks (10 m, int16 dm + uint8 ¼ m). */

import type { Meta } from './meta';
import type { BandModel, Raster } from './propagation';

export type ChunkFetcher = (i: number, j: number) => Promise<ArrayBuffer | null>;

export function modelFromMeta(meta: Meta, overrides: Partial<BandModel> = {}): BandModel {
  const m = meta.model;
  return {
    freqs: m.bands_hz,
    isoIdx: m.iso_idx,
    lw: m.lw_db,
    alphaDbKm: m.alpha_db_km,
    folFixed: m.fol_fixed,
    folPerM: m.fol_per_m,
    groundG: m.ground_g,
    useKmet: m.use_kmet,
    stepM: m.step_m,
    hs: m.source_h_m,
    hr: m.receiver_h_m,
    maxRangeM: m.max_range_m,
    ...overrides,
  };
}

export class TerrainStore {
  private cache = new Map<string, Promise<ArrayBuffer | null>>();

  constructor(
    private meta: Meta,
    private fetchChunk: ChunkFetcher,
  ) {}

  private chunk(i: number, j: number): Promise<ArrayBuffer | null> {
    const key = `${i}_${j}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.fetchChunk(i, j);
      this.cache.set(key, p);
    }
    return p;
  }

  /** Terrain + canopy covering the square (x ± radius, y ± radius), aligned to chunk boundaries. */
  async window(x: number, y: number, radius: number, onProgress?: (done: number, total: number) => void) {
    const t = this.meta.terrain;
    const span = t.chunk * t.res;
    const ymaxAll = t.ymax;
    const j0 = Math.max(0, Math.floor((x - radius - t.xmin) / span));
    const j1 = Math.min(t.chunk_cols - 1, Math.floor((x + radius - t.xmin) / span));
    const i0 = Math.max(0, Math.floor((ymaxAll - (y + radius)) / span));
    const i1 = Math.min(t.chunk_rows - 1, Math.floor((ymaxAll - (y - radius)) / span));
    const nr = (i1 - i0 + 1) * t.chunk;
    const nc = (j1 - j0 + 1) * t.chunk;
    const tz = new Float32Array(nr * nc).fill(NaN);
    const cz = new Float32Array(nr * nc);
    const jobs: Promise<void>[] = [];
    let done = 0;
    const total = (i1 - i0 + 1) * (j1 - j0 + 1);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        jobs.push(
          this.chunk(i, j).then((buf) => {
            done++;
            onProgress?.(done, total);
            if (!buf) return;
            const n = t.chunk * t.chunk;
            const ti = new Int16Array(buf, 0, n);
            const ci = new Uint8Array(buf, 2 * n, n);
            const r0 = (i - i0) * t.chunk;
            const c0 = (j - j0) * t.chunk;
            for (let r = 0; r < t.chunk; r++) {
              const src = r * t.chunk;
              const dst = (r0 + r) * nc + c0;
              for (let c = 0; c < t.chunk; c++) {
                const v = ti[src + c];
                tz[dst + c] = v === t.nodata ? NaN : v / t.terrain_scale;
                cz[dst + c] = ci[src + c] / t.canopy_scale;
              }
            }
          }),
        );
      }
    }
    await Promise.all(jobs);
    const x0 = t.xmin + j0 * span;
    const y0 = ymaxAll - i0 * span;
    const terrain: Raster = { z: tz, rows: nr, cols: nc, x0, y0, res: t.res };
    const canopy: Raster = { z: cz, rows: nr, cols: nc, x0, y0, res: t.res };
    return { terrain, canopy };
  }
}
