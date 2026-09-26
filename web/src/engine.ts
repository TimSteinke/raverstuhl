/** Worker pool front-end: splits a noise-map job across workers and merges the slices. */

import type { Meta } from './meta';
import type { PathDetail } from './propagation';
import type { GridSpec, MapSlice, WorkerRequest } from './worker';

export interface NoiseResult {
  x: number;
  y: number;
  useKmet: boolean;
  grid: GridSpec;
  /** rows × cols × bands, dB. */
  levels: Float32Array;
  recIdx: Int32Array;
  /** recIdx.length × bands, dB. */
  recLp: Float32Array;
  paths: number;
  ms: number;
  workers: number;
}

export class Engine {
  private workers: Worker[] = [];
  private nextId = 1;
  private pending = new Map<number, (v: unknown) => void>();

  constructor(meta: Meta, base: string, receivers: Float32Array, n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))) {
    for (let k = 0; k < n; k++) {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev) => {
        const cb = this.pending.get(ev.data.id);
        if (cb) {
          this.pending.delete(ev.data.id);
          cb(ev.data);
        }
      };
      w.postMessage({ type: 'init', meta, base, receivers } satisfies WorkerRequest);
      this.workers.push(w);
    }
  }

  get size() {
    return this.workers.length;
  }

  private call<T>(w: Worker, req: WorkerRequest & { id: number }): Promise<T> {
    return new Promise((resolve) => {
      this.pending.set(req.id, resolve as (v: unknown) => void);
      w.postMessage(req);
    });
  }

  async noiseMap(x: number, y: number, halfWidth: number, res: number, useKmet: boolean, nb: number): Promise<NoiseResult> {
    const t0 = performance.now();
    const cols = Math.round((2 * halfWidth) / res);
    const grid: GridSpec = { x0: x - halfWidth, y0: y + halfWidth, res, rows: cols, cols };
    const n = this.workers.length;
    const per = Math.ceil(grid.rows / n);
    const jobs = this.workers.map((w, k) =>
      this.call<MapSlice>(w, {
        type: 'map', id: this.nextId++, x, y, grid,
        r0: Math.min(k * per, grid.rows), r1: Math.min((k + 1) * per, grid.rows),
        offset: k, stride: n, useKmet,
      }),
    );
    const slices = await Promise.all(jobs);
    const levels = new Float32Array(grid.rows * grid.cols * nb);
    let paths = 0;
    let nrec = 0;
    for (const s of slices) {
      levels.set(s.levels, s.r0 * grid.cols * nb);
      paths += s.paths;
      nrec += s.recIdx.length;
    }
    const recIdx = new Int32Array(nrec);
    const recLp = new Float32Array(nrec * nb);
    let o = 0;
    for (const s of slices) {
      recIdx.set(s.recIdx, o);
      recLp.set(s.recLp, o * nb);
      o += s.recIdx.length;
    }
    return { x, y, useKmet, grid, levels, recIdx, recLp, paths, ms: performance.now() - t0, workers: n };
  }

  path(x: number, y: number, rx: number, ry: number, useKmet: boolean): Promise<PathDetail> {
    return this.call<{ detail: PathDetail }>(this.workers[0], { type: 'path', id: this.nextId++, x, y, rx, ry, useKmet })
      .then((r) => r.detail);
  }
}
