/** Loads the static export and offers point lookups in UTM metres. */

import proj4 from 'proj4';
import type { GridMeta, Meta } from './meta';

export interface AreaInfo {
  name: string;
  title: string;
  bounds: [number, number, number, number];
}

/** Base URL of the selected area's data folder (set by selectArea). */
export let BASE = '';

/** Reads data/areas.json and selects ?area=<name>, else the first area. */
export async function selectArea(): Promise<{ areas: AreaInfo[]; area: AreaInfo }> {
  const areas: AreaInfo[] = await (await fetch(`${import.meta.env.BASE_URL}data/areas.json`)).json();
  if (!areas.length) throw new Error('no areas exported');
  const want = new URLSearchParams(location.search).get('area');
  const area = areas.find((a) => a.name === want) ?? areas[0];
  BASE = `${import.meta.env.BASE_URL}data/${area.name}/`;
  return { areas, area };
}

export interface Layers {
  elev: Float32Array;
  open_area: Float32Array;
  open_frac: Float32Array;
  dist_way: Float32Array;
  dist_vehicle: Float32Array;
  visible: Float32Array;
  seen_by: Float32Array;
}

export interface Heat {
  cost: Float32Array;
  audible: Float32Array;
  worst: Float32Array;
}

export interface Dataset {
  meta: Meta;
  layers: Layers;
  heat: Heat;
  receivers: Float32Array;
  candidates: GeoJSON.FeatureCollection;
  toLngLat(x: number, y: number): [number, number];
  toUtm(lon: number, lat: number): [number, number];
}

/** Streams a file and reports every chunk, so the loading screen can show real progress. */
async function fetchBytes(url: string, onChunk: (n: number) => void): Promise<Uint8Array> {
  const r = await fetch(BASE + url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  if (!r.body) {
    const buf = new Uint8Array(await r.arrayBuffer());
    onChunk(buf.byteLength);
    return buf;
  }
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
    onChunk(value.byteLength);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

export interface LoadProgress {
  /** Bytes received so far and the expected total (uncompressed; 0 if unknown). */
  loaded: number;
  total: number;
}

/** Everything the page needs before the map can start, downloaded in parallel. */
export async function loadDataset(onProgress: (p: LoadProgress) => void): Promise<Dataset> {
  const meta: Meta = await (await fetch(BASE + 'meta.json')).json();
  proj4.defs(meta.crs, meta.proj4);
  const fwd = proj4('EPSG:4326', meta.crs);

  // meta.initial_files lists the exact (uncompressed) sizes; gzip hides them from Content-Length.
  const sizes = meta.initial_files ?? {};
  const progress: LoadProgress = { loaded: 0, total: Object.values(sizes).reduce((a, b) => a + b, 0) };
  const tick = (n: number) => {
    progress.loaded += n;
    onProgress(progress);
  };
  const buf = async (url: string) => {
    const b = await fetchBytes(url, tick);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  };

  const layerJob = Promise.all(
    Object.entries(meta.display.layers).map(async ([k, l]) => {
      const data = await buf(l.url);
      const raw = l.dtype === 'u16' ? new Uint16Array(data) : new Uint8Array(data);
      const f = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) f[i] = raw[i] * l.scale;
      return [k, f] as const;
    }),
  );
  const heatJob = Promise.all(
    (['cost', 'audible', 'worst'] as const).map(async (k) => new Float32Array(await buf(meta.heat.urls[k]))),
  );
  const recJob = buf(meta.receivers.url).then((b) => new Float32Array(b));
  const candJob = fetchBytes('candidates.geojson', tick).then((b) => JSON.parse(new TextDecoder().decode(b)));
  const [layerEntries, [cost, audible, worst], receivers, candidates] = await Promise.all([layerJob, heatJob, recJob, candJob]);
  const layers = Object.fromEntries(layerEntries) as unknown as Layers;

  return {
    meta, layers, heat: { cost, audible, worst }, receivers, candidates,
    toLngLat: (x, y) => fwd.inverse([x, y]) as [number, number],
    toUtm: (lon, lat) => fwd.forward([lon, lat]) as [number, number],
  };
}

/** Nearest-cell lookup; NaN outside the grid. */
export function sampleNearest(g: GridMeta, a: ArrayLike<number>, x: number, y: number): number {
  const c = Math.floor((x - g.xmin) / g.res);
  const r = Math.floor((g.ymax - y) / g.res);
  if (r < 0 || c < 0 || r >= g.rows || c >= g.cols) return NaN;
  return a[r * g.cols + c];
}

/** Bilinear lookup between cell centres; falls back to nearest where a neighbour is NaN. */
export function sampleBilinear(g: GridMeta, a: ArrayLike<number>, x: number, y: number): number {
  const fc = (x - g.xmin) / g.res - 0.5;
  const fr = (g.ymax - y) / g.res - 0.5;
  const r = Math.floor(fr);
  const c = Math.floor(fc);
  if (r < 0 || c < 0 || r + 1 >= g.rows || c + 1 >= g.cols) return sampleNearest(g, a, x, y);
  const i = r * g.cols + c;
  const v = (a[i] * (c + 1 - fc) + a[i + 1] * (fc - c)) * (r + 1 - fr) +
    (a[i + g.cols] * (c + 1 - fc) + a[i + g.cols + 1] * (fc - c)) * (fr - r);
  return Number.isNaN(v) ? sampleNearest(g, a, x, y) : v;
}
