/// <reference lib="webworker" />
/**
 * Propagation worker. Each worker holds the receivers and its own terrain chunk cache and computes
 * a slice of a noise-map job: grid rows [r0, r1) and every `stride`-th receiver starting at `offset`.
 */

import type { Meta } from './meta';
import { emptyDetail, makeScratch, pathLevels, type BandModel } from './propagation';
import { TerrainStore, modelFromMeta } from './terrain';

export interface GridSpec {
  x0: number; // west edge
  y0: number; // north edge
  res: number;
  rows: number;
  cols: number;
}

export type WorkerRequest =
  | { type: 'init'; meta: Meta; base: string; receivers: Float32Array }
  | {
      type: 'map';
      id: number;
      x: number;
      y: number;
      grid: GridSpec;
      r0: number;
      r1: number;
      offset: number;
      stride: number;
      useKmet: boolean;
    }
  | { type: 'path'; id: number; x: number; y: number; rx: number; ry: number; useKmet: boolean };

export interface MapSlice {
  type: 'map';
  id: number;
  r0: number;
  r1: number;
  /** (r1 - r0) × cols × bands band levels (dB), NaN outside data. */
  levels: Float32Array;
  /** Receivers in range: index, and band levels. */
  recIdx: Int32Array;
  recLp: Float32Array;
  paths: number;
  ms: number;
}

let meta: Meta;
let store: TerrainStore;
let rec: Float32Array;

function model(useKmet: boolean): BandModel {
  return modelFromMeta(meta, { useKmet });
}

async function runMap(req: Extract<WorkerRequest, { type: 'map' }>): Promise<MapSlice> {
  const t0 = performance.now();
  const m = model(req.useKmet);
  const { terrain, canopy } = await store.window(req.x, req.y, m.maxRangeM + 3 * meta.terrain.res);
  const nb = m.freqs.length;
  const s = makeScratch(m);
  const out = new Float64Array(nb);
  const g = req.grid;
  const levels = new Float32Array((req.r1 - req.r0) * g.cols * nb);
  let paths = 0;
  for (let r = req.r0; r < req.r1; r++) {
    const y = g.y0 - (r + 0.5) * g.res;
    for (let c = 0; c < g.cols; c++) {
      const x = g.x0 + (c + 0.5) * g.res;
      pathLevels(terrain, canopy, m, req.x, req.y, x, y, out, s);
      paths++;
      const base = ((r - req.r0) * g.cols + c) * nb;
      for (let b = 0; b < nb; b++) levels[base + b] = out[b];
    }
  }

  const [ox, oy] = meta.receivers.origin;
  const near2 = meta.receivers.near_field_m ** 2;
  const max2 = m.maxRangeM ** 2;
  const idx: number[] = [];
  const lp: number[] = [];
  const n = meta.receivers.count;
  for (let i = req.offset; i < n; i += req.stride) {
    const rx = ox + rec[i * 4];
    const ry = oy + rec[i * 4 + 1];
    const lod = rec[i * 4 + 3];
    const d2 = (rx - req.x) ** 2 + (ry - req.y) ** 2;
    if (d2 > max2) continue;
    if (lod === 0 ? d2 >= near2 : d2 < near2) continue;
    pathLevels(terrain, canopy, m, req.x, req.y, rx, ry, out, s);
    paths++;
    idx.push(i);
    for (let b = 0; b < nb; b++) lp.push(out[b]);
  }
  return {
    type: 'map', id: req.id, r0: req.r0, r1: req.r1, levels,
    recIdx: Int32Array.from(idx), recLp: Float32Array.from(lp), paths, ms: performance.now() - t0,
  };
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (req.type === 'init') {
    meta = req.meta;
    rec = req.receivers;
    const base = req.base;
    store = new TerrainStore(meta, async (i, j) => {
      const res = await fetch(base + meta.terrain.url.replace('{i}', String(i)).replace('{j}', String(j)));
      return res.ok ? res.arrayBuffer() : null;
    });
    return;
  }
  if (req.type === 'map') {
    const slice = await runMap(req);
    (self as unknown as Worker).postMessage(slice, [slice.levels.buffer, slice.recIdx.buffer, slice.recLp.buffer]);
    return;
  }
  if (req.type === 'path') {
    const m = model(req.useKmet);
    const { terrain, canopy } = await store.window(req.x, req.y, m.maxRangeM + 3 * meta.terrain.res);
    const detail = emptyDetail();
    pathLevels(terrain, canopy, m, req.x, req.y, req.rx, req.ry, new Float64Array(m.freqs.length),
      makeScratch(m), detail);
    (self as unknown as Worker).postMessage({ type: 'path', id: req.id, detail });
  }
};
