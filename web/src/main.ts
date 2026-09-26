import * as maplibregl from 'maplibre-gl';
import type { CanvasSource, GeoJSONSource, MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { Rave } from './audio';
import { BASE, loadDataset, sampleBilinear, sampleNearest, selectArea, type AreaInfo, type Dataset } from './data';
import { Engine, type NoiseResult } from './engine';
import { buildStyle } from './mapstyle';
import type { LngLat } from './meta';
import { RAMP_CYAN, RAMP_MAGENTA, buildCellCache, paintNoise, paintScores, rampCss, type CellCache, type Mode } from './overlays';
import { profileSvg } from './profile';
import type { PathDetail } from './propagation';
import { accessScore, combine, exposure, hiddenScore, noiseScore, sizeScore, type Exposure, type ScoreKey, type Weights } from './scoring';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const fmt = (v: number, d = 0) => (Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }) : '–');
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const MAP_HALF_M = 3000;
const MAP_RES_M = 25;

const MODES: { id: Mode; label: string; sub: string }[] = [
  { id: 'rating', label: 'Rating', sub: 'combined' },
  { id: 'cost', label: 'Disturbed', sub: 'people' },
  { id: 'noise', label: 'Noise', sub: 'score' },
  { id: 'hidden', label: 'Hidden', sub: 'roads · homes' },
  { id: 'access', label: 'Access', sub: 'by car' },
  { id: 'open', label: 'Open ground', sub: 'field size' },
];
const SEEN_LABELS: Record<string, string> = { major_roads: 'major roads', medium_roads: 'medium roads', homes: 'homes' };
const WEIGHT_LABELS: Record<ScoreKey, string> = { noise: 'Noise', access: 'Access', hidden: 'Hidden', size: 'Size' };

interface CandidateProps {
  cand_id: number; rank: number; score: number; area_m2: number; noise_cost: number; worst_excess_db: number;
  dist_way_m: number; nearest_way: string; dist_vehicle_m: number; nearest_vehicle_way: string;
  visible_frac: number; vis_major_roads: number; vis_medium_roads: number; vis_homes: number; nearest_view_m: number | null; slope_deg: number;
}

interface State {
  mode: Mode;
  weights: Weights;
  band: number; // -1 = max over bands
  gain: number;
  useKmet: boolean;
  click: { x: number; y: number; lon: number; lat: number } | null;
  cand: CandidateProps | null;
  result: NoiseResult | null;
  exp: Exposure | null;
  sel: number; // index into result.recIdx
  path: PathDetail | null;
  busy: boolean;
  listen: 'off' | 'floor' | 'out' | 'in';
}

let ds: Dataset;
let cache: CellCache;
let map: maplibregl.Map;
let engine: Engine;
const rave = new Rave();
const scoreCanvas = document.createElement('canvas');
const noiseCanvas = document.createElement('canvas');
const st: State = {
  mode: 'rating', weights: { noise: 0.55, access: 0.2, size: 0.1, hidden: 0.15 }, band: -1, gain: 0, useKmet: true,
  click: null, cand: null, result: null, exp: null, sel: -1, path: null, busy: false, listen: 'off',
};

// ------------------------------------------------------------------------------------------- boot
async function boot() {
  maplibregl.setWorkerUrl(new URL(`${import.meta.env.BASE_URL}vendor/maplibre/maplibre-gl-worker.mjs`, location.href).href);
  const msg = $('#loading-msg');
  const { areas, area } = await selectArea();
  document.title = areas.length > 1 ? `raverstuhl.lol · ${area.title}` : 'raverstuhl.lol';
  const setProgress = (frac: number, text: string) => {
    const pct = Math.max(0, Math.min(100, Math.floor(frac * 100)));
    $('#loading-bar').style.width = `${pct}%`;
    $('#loading-pct').textContent = `${pct} %`;
    $('.progress').setAttribute('aria-valuenow', String(pct));
    msg.textContent = text;
  };
  const mb = (n: number) => (n / 1e6).toFixed(1);
  setProgress(0, 'loading model data');
  // Downloads are 0–90 %, the steps after them the rest.
  ds = await loadDataset(({ loaded, total }) =>
    setProgress(total ? 0.9 * Math.min(loaded / total, 1) : 0,
      total ? `loading model data · ${mb(loaded)} / ${mb(total)} MB` : `loading model data · ${mb(loaded)} MB`));
  st.weights = { ...ds.meta.scoring.weights };
  setProgress(0.91, 'precomputing score cells');
  await new Promise((r) => setTimeout(r, 0));
  cache = buildCellCache(ds);
  paintScores(scoreCanvas, ds, cache, st.mode, st.weights);
  setProgress(0.95, 'starting workers');
  engine = new Engine(ds.meta, new URL(BASE, location.href).href, ds.receivers);

  map = new maplibregl.Map({
    container: 'map', style: buildStyle(ds.meta), bounds: coreBounds(), fitBoundsOptions: { padding: 40 },
    hash: true, maxPitch: 75, attributionControl: false, canvasContextAttributes: { preserveDrawingBuffer: true },
  });
  // Bottom-right stack, bottom to top: credits, GitHub link, scale bar, legend.
  map.addControl(new maplibregl.AttributionControl({
    compact: false,
    customAttribution: 'Copernicus DEM © DLR e.V., © Airbus DS, provided under COPERNICUS by the EU and ESA · <a href="https://maplibre.org">MapLibre</a> · recklessly vibe-coded with Claude Opus 5.5 (Anthropic)',
  }), 'bottom-right');
  map.addControl(new ElementControl($('#github')), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 140 }), 'bottom-right');
  map.addControl(new ElementControl($('#legend')), 'bottom-right');
  set3D(false, false);
  // Start as soon as the style is parsed: MapLibre's 'load' also waits for every initial tile, and a
  // single stalled tile request would otherwise keep the loading screen up forever.
  const mapErrors: string[] = [];
  map.on('error', (e) => {
    const m = (e.error?.message ?? String(e.error ?? e)).slice(0, 200);
    console.warn('map error:', m);
    if (mapErrors.length < 5) mapErrors.push(m);
  });
  let started = false;
  const start = () => {
    if (started || !map.getLayer('roads-minor')) return;
    started = true;
    addDataLayers();
    setProgress(1, 'ready');
    $('#loading').classList.add('done');
  };
  map.on('style.load', start);
  map.on('load', start);
  setProgress(0.97, 'starting map');
  setTimeout(() => {
    if (!started) {
      msg.textContent = `map is not starting. ${mapErrors.length ? `errors: ${mapErrors.join(' · ')}` : 'no error reported: check the browser console'}`;
    }
  }, 15000);
  map.on('mousemove', onMove);
  map.on('click', onClick);
  buildPanel();
  buildAreaSwitch(areas, area);
  renderLegend();
}

/** The area's modelled extent (LGL data) in lon/lat, for the initial view. */
function coreBounds(): [number, number, number, number] {
  const [x0, y0, x1, y1] = ds.meta.core_bounds;
  const ll = [ds.toLngLat(x0, y0), ds.toLngLat(x1, y1), ds.toLngLat(x0, y1), ds.toLngLat(x1, y0)];
  return [Math.min(...ll.map((p) => p[0])), Math.min(...ll.map((p) => p[1])), Math.max(...ll.map((p) => p[0])), Math.max(...ll.map((p) => p[1]))];
}

/** A dropdown under the name when more than one area is exported. */
function buildAreaSwitch(areas: AreaInfo[], area: AreaInfo) {
  if (areas.length < 2) return;
  const sel = document.createElement('select');
  sel.className = 'area-switch mono';
  sel.setAttribute('aria-label', 'Area');
  sel.innerHTML = areas.map((a) => `<option value="${esc(a.name)}" ${a.name === area.name ? 'selected' : ''}>${esc(a.title)}</option>`).join('');
  sel.addEventListener('change', () => { location.href = `${location.pathname}?area=${encodeURIComponent(sel.value)}`; });
  $('.brand').after(sel);
}

function addDataLayers() {
  const m = ds.meta;
  map.addSource('scores', { type: 'canvas', canvas: scoreCanvas, coordinates: m.display.corners, animate: false });
  map.addLayer({ id: 'scores', type: 'raster', source: 'scores', paint: { 'raster-opacity': 0.92, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } }, 'roads-minor');
  map.addSource('vis', { type: 'image', url: `${BASE}${m.visibility_image.url}`, coordinates: m.visibility_image.corners });
  map.addLayer({ id: 'vis', type: 'raster', source: 'vis', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.8, 'raster-fade-duration': 0 } }, 'roads-minor');
  noiseCanvas.width = noiseCanvas.height = 1;
  map.addSource('noise', { type: 'canvas', canvas: noiseCanvas, coordinates: m.display.corners, animate: false });
  map.addLayer({ id: 'noise', type: 'raster', source: 'noise', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.9, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } }, 'roads-minor');

  map.addSource('cands', { type: 'geojson', data: ds.candidates });
  map.addLayer({ id: 'cand-fill', type: 'fill', source: 'cands', minzoom: 11, paint: { 'fill-color': '#00e5ff', 'fill-opacity': 0.0 } });
  map.addLayer({
    id: 'cand-line', type: 'line', source: 'cands', minzoom: 12,
    paint: {
      'line-color': ['interpolate', ['linear'], ['get', 'score'], 0, '#244a66', 0.5, '#00a9c7', 0.9, '#b8f6ff'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.4, 16, 1.5],
      'line-opacity': 0.8,
    },
  });

  map.addSource('receivers', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'receivers', type: 'circle', source: 'receivers',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, ['max', 1.5, ['*', 0.5, ['sqrt', ['get', 'w']]]], 16, ['max', 3, ['*', 1.6, ['sqrt', ['get', 'w']]]]],
      'circle-color': ['interpolate', ['linear'], ['get', 'ex'], -6, '#3a2a66', 0, '#8a2be2', 3, '#d61fd0', 15, '#ff3c96', 25, '#fff0fa'],
      'circle-opacity': ['interpolate', ['linear'], ['get', 'ex'], -6, 0.35, 0, 0.9],
      'circle-stroke-color': '#05060b', 'circle-stroke-width': 0.6,
    },
  });
  map.addSource('sel', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'sel-path', type: 'line', source: 'sel', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#ffd400', 'line-width': 1.6, 'line-dasharray': [2, 2] } });
  map.addLayer({ id: 'sel-rec', type: 'circle', source: 'sel', filter: ['==', ['get', 'kind'], 'rec'], paint: { 'circle-radius': 7, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffd400', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'sel-src-glow', type: 'circle', source: 'sel', filter: ['==', ['get', 'kind'], 'src'], paint: { 'circle-radius': 16, 'circle-color': '#00e5ff', 'circle-opacity': 0.18, 'circle-blur': 0.8 } });
  map.addLayer({ id: 'sel-src', type: 'circle', source: 'sel', filter: ['==', ['get', 'kind'], 'src'], paint: { 'circle-radius': 5, 'circle-color': '#00e5ff', 'circle-stroke-color': '#e0fbff', 'circle-stroke-width': 1.5 } });

  map.addSource('sites', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: m.top_sites.slice(0, 15).map((s) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: { ...s } })) },
  });
  map.addLayer({ id: 'sites-ring', type: 'circle', source: 'sites', paint: { 'circle-radius': 9, 'circle-color': 'rgba(0,0,0,0.5)', 'circle-stroke-color': ['case', ['get', 'feasible'], '#00e5ff', '#6b7493'], 'circle-stroke-width': 1.8 } });
  map.addLayer({
    id: 'sites-label', type: 'symbol', source: 'sites',
    layout: { 'text-field': ['to-string', ['get', 'rank']], 'text-font': ['Noto Sans Bold'], 'text-size': 10.5, 'text-allow-overlap': true },
    paint: { 'text-color': ['case', ['get', 'feasible'], '#e0fbff', '#a3acc8'] },
  });
  map.on('mouseenter', 'receivers', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'receivers', () => (map.getCanvas().style.cursor = ''));
  map.on('mouseenter', 'sites-ring', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'sites-ring', () => (map.getCanvas().style.cursor = ''));
}

/** Wraps an existing DOM element as a MapLibre control, so it stacks with the built-in ones. */
class ElementControl implements maplibregl.IControl {
  constructor(private el: HTMLElement) {}
  onAdd() {
    this.el.classList.add('maplibregl-ctrl');
    return this.el;
  }
  onRemove() {
    this.el.remove();
  }
}

function refreshCanvas(id: string) {
  const src = map.getSource(id) as CanvasSource | undefined;
  if (!src) return;
  src.play();
  src.pause();
  map.triggerRepaint();
}

// -------------------------------------------------------------------------------------------- panel
function buildPanel() {
  const s = ds.meta.stats;
  $('#stats').innerHTML = [
    ['buildings', s.buildings], ['occupied', s.occupied_buildings], ['people-eq', s.people_eq], ['receivers', s.receiver_cells],
    ['heat sources', s.heat_points], ['open fields', s.candidates],
  ].map(([k, v]) => `<span>${k}</span><b>${fmt(v as number)}</b>`).join('');

  const modes = $('#modes');
  modes.innerHTML = MODES.map((m) => `<button role="radio" data-mode="${m.id}" aria-checked="${m.id === st.mode}">${m.label}<small>${m.sub}</small></button>`).join('');
  modes.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    st.mode = b.dataset.mode as Mode;
    modes.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    repaintScores();
    renderLegend();
  });

  const w = $('#weights');
  w.innerHTML = (Object.keys(WEIGHT_LABELS) as ScoreKey[]).map((k) =>
    `<label class="slider"><span>${WEIGHT_LABELS[k]}</span><input type="range" min="0" max="1" step="0.05" value="${st.weights[k]}" data-w="${k}"><output>${st.weights[k].toFixed(2)}</output></label>`).join('');
  w.addEventListener('input', (e) => {
    const i = e.target as HTMLInputElement;
    const k = i.dataset.w as ScoreKey;
    st.weights[k] = Number(i.value);
    (i.nextElementSibling as HTMLOutputElement).value = Number(i.value).toFixed(2);
    repaintScores();
    if (st.click) renderSidebar();
  });
  $('#maxworst').textContent = String(ds.meta.impact.max_worst_db);

  $('#top-sites').innerHTML = ds.meta.top_sites.slice(0, 15).map((t) =>
    `<li data-lon="${t.lon}" data-lat="${t.lat}" class="${t.feasible ? '' : 'infeasible'}"><b>#${t.rank}</b><span>${fmt(t.area_m2)} m² · ${fmt(t.noise_cost, 1)} ppl</span><span>${t.score.toFixed(2)}</span></li>`).join('');
  $('#top-sites').addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest('li');
    if (!li) return;
    const ll: LngLat = [Number(li.dataset.lon), Number(li.dataset.lat)];
    map.flyTo({ center: ll, zoom: 14.2, speed: 1.4 });
    select(ll[0], ll[1]);
  });

  const toggle = (id: string, fn: (on: boolean) => void) => $<HTMLInputElement>(id).addEventListener('change', (e) => fn((e.target as HTMLInputElement).checked));
  toggle('#t-vis', (on) => { map.setLayoutProperty('vis', 'visibility', on ? 'visible' : 'none'); renderLegend(); });
  toggle('#t-cand', (on) => map.setLayoutProperty('cand-line', 'visibility', on ? 'visible' : 'none'));
  toggle('#t-sites', (on) => ['sites-ring', 'sites-label'].forEach((l) => map.setLayoutProperty(l, 'visibility', on ? 'visible' : 'none')));
  toggle('#t-3d', (on) => set3D(on, true));
  $('#about-btn').addEventListener('click', () => { renderAbout(); $<HTMLDialogElement>('#about').showModal(); });
  $('#about').addEventListener('click', (e) => { if (e.target === e.currentTarget) $<HTMLDialogElement>('#about').close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });
}

let nav: maplibregl.NavigationControl | null = null;

/** 3D: terrain, tilt and rotation. 2D: always top-down and north-up, rotation and tilt disabled. */
function set3D(on: boolean, animate: boolean) {
  if (nav) map.removeControl(nav);
  nav = new maplibregl.NavigationControl(on ? { visualizePitch: true } : { showCompass: false });
  map.addControl(nav, 'top-right');
  if (on) {
    map.setMaxPitch(75);
    map.dragRotate.enable();
    map.keyboard.enableRotation();
    map.touchZoomRotate.enableRotation();
    map.touchPitch.enable();
    map.setTerrain({ source: 'dem-terrain', exaggeration: 1.6 });
    if (animate) map.easeTo({ pitch: 62, bearing: -25, duration: 1200 });
  } else {
    map.dragRotate.disable();
    map.keyboard.disableRotation();
    map.touchZoomRotate.disableRotation();
    map.touchPitch.disable();
    if (map.getTerrain()) map.setTerrain(null);
    const flatten = () => map.setMaxPitch(0);
    if (animate) {
      map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
      map.once('moveend', flatten);
    } else {
      map.jumpTo({ pitch: 0, bearing: 0 }); // also overrides a tilted view from the URL hash
      flatten();
    }
  }
}

function repaintScores() {
  paintScores(scoreCanvas, ds, cache, st.mode, st.weights);
  refreshCanvas('scores');
}

function renderLegend() {
  const items: string[] = [];
  const m = st.mode;
  if (m === 'cost') {
    items.push(`<div class="item">People disturbed if the rig stood here<div class="bar" style="background:${rampCss(RAMP_MAGENTA)}"></div><div class="ticks"><span>0.1</span><span>3</span><span>100</span><span>3k</span></div></div>`);
  } else {
    const label = { rating: 'Rating (bright = open field, dim = elsewhere)', noise: 'Noise score  0.5^(people/10)', hidden: 'Hidden from major roads', access: 'Access via OSM ways', open: 'Open ground · field size', cost: '' }[m];
    const ticks = m === 'rating' ? '<span>0</span><span>0.06</span><span>0.25</span><span>0.56</span><span>1 (√ scale)</span>' : '<span>0</span><span>0.5</span><span>1</span>';
    items.push(`<div class="item">${label}<div class="bar" style="background:${rampCss(RAMP_CYAN)}"></div><div class="ticks">${ticks}</div></div>`);
  }
  if ($<HTMLInputElement>('#t-vis').checked) {
    items.push(`<div class="item"><span class="sw" style="background:#ffd400"></span>seen from roads or homes &nbsp; <span class="sw" style="background:#08164e"></span>hidden</div>`);
  }
  if (st.result) {
    items.push(`<div class="item">Rig noise: dB over indoor detection threshold${st.band >= 0 ? ` (${ds.meta.model.bands_hz[st.band]} Hz)` : ''}<div class="bar" style="background:${rampCss(RAMP_MAGENTA)}"></div><div class="ticks"><span>0</span><span>10</span><span>20</span><span>30 dB</span></div><div class="sub">isolines 0 · 10 · 20 dB · dots = buildings (click one)</div></div>`);
  }
  $('#legend').innerHTML = items.join('');
}

// ---------------------------------------------------------------------------------------------- HUD
function onMove(e: MapMouseEvent) {
  const { lng, lat } = e.lngLat;
  const [x, y] = ds.toUtm(lng, lat);
  const m = ds.meta;
  const g = m.display;
  const inside = x >= g.xmin && x <= g.xmin + g.cols * g.res && y <= g.ymax && y >= g.ymax - g.rows * g.res;
  const cost = sampleBilinear(m.heat, ds.heat.cost, x, y);
  const worst = sampleBilinear(m.heat, ds.heat.worst, x, y);
  const audible = sampleBilinear(m.heat, ds.heat.audible, x, y);
  const elev = sampleNearest(g, ds.layers.elev, x, y);
  const i = inside ? Math.floor((g.ymax - y) / g.res) * g.cols + Math.floor((x - g.xmin) / g.res) : -1;
  const rating = i >= 0 && Number.isFinite(cache.noise[i])
    ? combine({ noise: cache.noise[i], access: cache.access[i], size: cache.open[i] ? cache.size[i] : 1, hidden: cache.hidden[i] },
      cache.open[i] ? st.weights : { ...st.weights, size: 0 }, worst <= m.impact.max_worst_db)
    : NaN;
  const ok = cost < 1;
  const vis = i >= 0 ? ds.layers.visible[i] : NaN;
  const seen = i >= 0 ? seenBy(ds.layers.seen_by[i]) : [];
  $('#hud').innerHTML = `
    <div class="lbl">if the rig stood here</div>
    <div class="big ${ok ? 'ok' : ''}">${inside && Number.isFinite(cost) ? fmt(cost, cost < 10 ? 1 : 0) : '–'} <small style="font-size:12px">people disturbed</small></div>
    <div class="row"><span>audible (people-eq)</span><span>${fmt(audible, 0)}</span></div>
    <div class="row"><span>loudest building</span><span>${Number.isFinite(worst) ? (worst > -50 ? `${worst >= 0 ? '+' : ''}${fmt(worst, 1)} dB` : 'inaudible') : '–'}</span></div>
    <div class="row"><span>rating · open ground</span><span>${fmt(rating, 2)} · ${i >= 0 && cache.open[i] ? `${fmt(ds.layers.open_area[i])} m²` : 'no'}</span></div>
    <div class="row"><span>seen from</span><span>${Number.isFinite(vis) ? (seen.length ? seen.join(', ') : 'nobody') : '–'}</span></div>
    <div class="row"><span>nearest car-usable way</span><span>${i >= 0 ? `${fmt(ds.layers.dist_vehicle[i])} m` : '–'}</span></div>
    <div class="row"><span>${lat.toFixed(5)}°N ${lng.toFixed(5)}°E</span><span>${Number.isFinite(elev) && elev > 0 ? `${fmt(elev)} m` : ''}</span></div>
    <div class="row"><span>UTM32 ${fmt(x)} E</span><span>${fmt(y)} N</span></div>`;
}

// ----------------------------------------------------------------------------------------- selection
function onClick(e: MapMouseEvent) {
  const recHit = st.result ? map.queryRenderedFeatures(e.point, { layers: ['receivers'] }) : [];
  if (recHit.length) {
    selectReceiver(recHit[0].properties!.k as number);
    return;
  }
  const site = map.queryRenderedFeatures(e.point, { layers: ['sites-ring'] });
  if (site.length) {
    const p = site[0].properties!;
    select(p.lon, p.lat);
    return;
  }
  select(e.lngLat.lng, e.lngLat.lat);
}

async function select(lon: number, lat: number) {
  const [x, y] = ds.toUtm(lon, lat);
  const [cx0, cy0, cx1, cy1] = ds.meta.core_bounds;
  st.click = { x, y, lon, lat };
  st.cand = candidateAt(lon, lat);
  st.result = null;
  st.exp = null;
  st.path = null;
  st.sel = -1;
  document.body.classList.add('sidebar-open');
  $('#sidebar').hidden = false;
  if (x < cx0 || x > cx1 || y < cy0 || y > cy1) {
    $('#sidebar').innerHTML = `<button class="close" aria-label="Close">×</button><h2>Outside the model</h2><p class="sub">The noise model runs inside the LGL data area (terrain + buildings in full detail). Click inside the lit area.</p>`;
    $('#sidebar .close').addEventListener('click', closeSidebar);
    return;
  }
  setSel();
  await compute();
}

async function compute() {
  if (!st.click) return;
  st.busy = true;
  renderSidebar();
  const res = await engine.noiseMap(st.click.x, st.click.y, MAP_HALF_M, MAP_RES_M, st.useKmet, ds.meta.model.bands_hz.length);
  st.result = res;
  st.busy = false;
  applyGain();
  const worst = st.exp!.worstIdx;
  if (worst >= 0) await selectReceiver(worst, false);
  else renderSidebar();
  map.setLayoutProperty('noise', 'visibility', 'visible');
  renderLegend();
}

/** Re-evaluates exposure, the noise canvas and the receiver dots for the current gain/band. */
function applyGain() {
  const r = st.result;
  if (!r) return;
  st.exp = exposure(r.recIdx, r.recLp, ds.receivers, ds.meta, st.gain);
  paintNoise(noiseCanvas, r, ds.meta.impact.thresholds_db, st.band, st.gain);
  const { x0, y0, res, cols, rows } = r.grid;
  const corners = [[x0, y0], [x0 + cols * res, y0], [x0 + cols * res, y0 - rows * res], [x0, y0 - rows * res]].map(([a, b]) => ds.toLngLat(a, b));
  (map.getSource('noise') as CanvasSource).setCoordinates(corners as [LngLat, LngLat, LngLat, LngLat]);
  refreshCanvas('noise');
  const [ox, oy] = ds.meta.receivers.origin;
  const feats: GeoJSON.Feature[] = [];
  for (let k = 0; k < r.recIdx.length; k++) {
    const ex = st.exp.excess[k];
    if (ex < -6) continue;
    const i = r.recIdx[k];
    feats.push({
      type: 'Feature', geometry: { type: 'Point', coordinates: ds.toLngLat(ox + ds.receivers[i * 4], oy + ds.receivers[i * 4 + 1]) },
      properties: { k, ex: Math.round(ex * 10) / 10, w: ds.receivers[i * 4 + 2] },
    });
  }
  (map.getSource('receivers') as GeoJSONSource).setData({ type: 'FeatureCollection', features: feats });
}

async function selectReceiver(k: number, render = true) {
  const r = st.result;
  if (!r || !st.click) return;
  st.sel = k;
  if (render) renderSidebar();
  const [ox, oy] = ds.meta.receivers.origin;
  const i = r.recIdx[k];
  const rx = ox + ds.receivers[i * 4];
  const ry = oy + ds.receivers[i * 4 + 1];
  st.path = await engine.path(st.click.x, st.click.y, rx, ry, st.useKmet);
  setSel(ds.toLngLat(rx, ry));
  renderSidebar();
  if (st.listen === 'out' || st.listen === 'in') setListen(st.listen);
}

/** The open field containing (lon, lat), by point-in-polygon on the loaded GeoJSON (independent of rendering). */
function candidateAt(lon: number, lat: number): CandidateProps | null {
  const inRing = (ring: number[][]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const inPoly = (rings: number[][][]) => inRing(rings[0]) && !rings.slice(1).some(inRing);
  for (const f of ds.candidates.features) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    if (polys.some((rings) => inPoly(rings as number[][][]))) return f.properties as CandidateProps;
  }
  return null;
}

function setSel(rec?: LngLat) {
  if (!st.click) return;
  const src: LngLat = [st.click.lon, st.click.lat];
  const feats: GeoJSON.Feature[] = [{ type: 'Feature', geometry: { type: 'Point', coordinates: src }, properties: { kind: 'src' } }];
  if (rec) {
    feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [src, rec] }, properties: { kind: 'path' } });
    feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: rec }, properties: { kind: 'rec' } });
  }
  (map.getSource('sel') as GeoJSONSource).setData({ type: 'FeatureCollection', features: feats });
}

function closeSidebar() {
  $('#sidebar').hidden = true;
  document.body.classList.remove('sidebar-open');
  st.click = null;
  st.result = null;
  rave.stop();
  st.listen = 'off';
  if (!map) return;
  map.setLayoutProperty('noise', 'visibility', 'none');
  (map.getSource('receivers') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
  (map.getSource('sel') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
  renderLegend();
}

function seenBy(bits: number): string[] {
  return ds.meta.seen_by_classes.filter((_, k) => (bits >> k) & 1).map((k) => SEEN_LABELS[k] ?? k);
}

// ------------------------------------------------------------------------------------------ sidebar
function pointScores() {
  const m = ds.meta;
  const c = st.click!;
  const g = m.display;
  const i = Math.floor((g.ymax - c.y) / g.res) * g.cols + Math.floor((c.x - g.xmin) / g.res);
  const cand = st.cand;
  const cost = st.exp ? st.exp.cost : sampleBilinear(m.heat, ds.heat.cost, c.x, c.y);
  const worst = st.exp ? st.exp.worst : sampleBilinear(m.heat, ds.heat.worst, c.x, c.y);
  const distWay = cand ? cand.dist_way_m : ds.layers.dist_way[i];
  const distVeh = cand ? cand.dist_vehicle_m : ds.layers.dist_vehicle[i];
  const seenAt = seenBy(ds.layers.seen_by[i]);
  const visFrac = cand ? cand.visible_frac ?? 0 : ds.layers.visible[i];
  const area = cand ? cand.area_m2 : cache.open[i] ? ds.layers.open_area[i] : 0;
  const s = { noise: noiseScore(cost, m), access: accessScore(distVeh, m), hidden: hiddenScore(visFrac, m), size: sizeScore(area, m) };
  const feasible = worst <= m.impact.max_worst_db;
  return { s, total: combine(s, st.weights, feasible), feasible, cost, worst, distWay, distVeh, visFrac, area, seenAt, pointVisible: ds.layers.visible[i], elev: ds.layers.elev[i] };
}

function bar(label: string, v: number, cls = '') {
  return `<div class="bar-row ${cls}"><span>${label}</span><div class="track"><div class="fill" style="width:${Math.max(0, Math.min(1, v)) * 100}%"></div></div><output>${fmt(v, 2)}</output></div>`;
}

function renderSidebar() {
  const sb = $('#sidebar');
  const c = st.click;
  if (!c) return;
  const m = ds.meta;
  const p = pointScores();
  const r = st.result;
  const e = st.exp;
  const cand = st.cand;
  const nb = m.model.bands_hz.length;
  const gmaps = `https://www.google.com/maps/search/?api=1&query=${c.lat.toFixed(6)},${c.lon.toFixed(6)}`;
  const gsat = `https://www.google.com/maps/@${c.lat.toFixed(6)},${c.lon.toFixed(6)},600m/data=!3m1!1e3`;
  const osm = `https://www.openstreetmap.org/?mlat=${c.lat.toFixed(6)}&mlon=${c.lon.toFixed(6)}#map=17/${c.lat.toFixed(6)}/${c.lon.toFixed(6)}`;

  const people = e ? e.cost : p.cost;
  const kpi = `<div class="kpi"><span class="n ${people < 1 ? 'ok' : ''}">${fmt(people, people < 10 ? 1 : 0)}</span><span class="u">people disturbed<br><span class="sub">weighted, indoors, worst-case night</span></span></div>`;

  let noiseBlock = `<p class="working">tracing propagation paths</p>`;
  if (r && e) {
    const wr = e.worstIdx;
    noiseBlock = `<dl class="kv">
      <dt>audible at all (people-eq)</dt><dd>${fmt(e.audible, 1)}</dd>
      <dt>receiver cells audible</dt><dd>${fmt(e.nAudible)} / ${fmt(r.recIdx.length)}</dd>
      <dt>loudest building</dt><dd>${wr >= 0 && e.worst > -50 ? `${e.worst >= 0 ? '+' : ''}${fmt(e.worst, 1)} dB` : 'inaudible'} <span class="pill ${p.feasible ? 'good' : 'bad'}">${p.feasible ? 'ok' : `> ${m.impact.max_worst_db} dB`}</span></dd>
    </dl>
    <div class="perf">${fmt(r.paths)} ray paths · ${r.workers} workers · ${fmt(r.ms)} ms · ${st.useKmet ? 'night inversion (ISO K_met)' : 'neutral atmosphere'}</div>`;
  }

  const nearestWay = cand?.nearest_way;
  const openBlock = cand
    ? `<dt>field size</dt><dd>${fmt(cand.area_m2)} m²</dd><dt>capacity (≈3 m²/person + rig)</dt><dd>~${fmt(Math.round(Math.max(0, (cand.area_m2 - 150) / 3) / 10) * 10)}</dd><dt>slope at centre</dt><dd>${fmt(cand.slope_deg, 1)}°</dd>${cand.rank ? `<dt>site rank</dt><dd>#${cand.rank} of ${fmt(m.stats.sites)}</dd>` : ''}`
    : p.area > 0 ? `<dt>open area</dt><dd>${fmt(p.area)} m²</dd>` : `<dt>open ground</dt><dd>no</dd><dt class="sub">trees, crops, buildings or too steep</dt><dd></dd>`;

  const controls = `<div class="controls">
    <label class="slider"><span>rig gain</span><input type="range" id="c-gain" min="-15" max="10" step="1" value="${st.gain}"><output>${st.gain > 0 ? '+' : ''}${st.gain} dB</output></label>
    <div class="seg" id="c-met"><button aria-pressed="${st.useKmet}" data-v="1">night inversion</button><button aria-pressed="${!st.useKmet}" data-v="0">neutral</button></div>
    <div class="seg" id="c-band"><button aria-pressed="${st.band === -1}" data-b="-1">max</button>${m.model.bands_hz.map((f, b) => `<button aria-pressed="${st.band === b}" data-b="${b}">${f < 100 ? f : Math.round(f)}</button>`).join('')}</div>
  </div>`;

  let pathBlock = '';
  if (r && e && st.sel >= 0) {
    const k = st.sel;
    const lp = Array.from(r.recLp.subarray(k * nb, (k + 1) * nb)).map((v) => v + st.gain);
    const thr = m.impact.thresholds_db;
    const lw = m.model.lw_db.map((v) => v + st.gain);
    const top = Math.max(...lw) + 5;
    const bottom = 0;
    const h = (v: number) => `${Math.max(0, Math.min(100, ((v - bottom) / (top - bottom)) * 100))}%`;
    const d = st.path;
    const w = ds.receivers[r.recIdx[k] * 4 + 2];
    pathBlock = `<h3>Path to ${k === e.worstIdx ? 'loudest' : 'selected'} building <span class="sub">(click dots to inspect)</span></h3>
      <div class="sub">${fmt(w, 1)} people-eq · ${d ? `${fmt(d.d2d)} m` : ''} · excess ${e.excess[k] >= 0 ? '+' : ''}${fmt(e.excess[k] + 0, 1)} dB</div>
      ${d ? profileSvg(d) : '<p class="working">loading profile</p>'}
      <div class="spectrum">${lw.map((v, b) => `<div class="col" title="${m.model.bands_hz[b]} Hz"><div class="lw" style="height:${h(v)}"></div><div class="lp" style="height:${h(lp[b])}"></div><div class="thr" style="bottom:${h(thr[b])}"></div></div>`).join('')}</div>
      <div class="spec-lbl">${m.model.bands_hz.map((f) => `<span>${f}</span>`).join('')}</div>
      <div class="sub"><span class="sw" style="display:inline-block;width:8px;height:8px;background:rgba(0,229,255,.4)"></span> L<sub>w</sub> rig &nbsp; <span style="color:var(--magenta)">■</span> L<sub>p</sub> at façade &nbsp; <span style="color:var(--yellow)">—</span> detection threshold (Hz)</div>
      ${d ? `<table class="bands"><tr><th>Hz</th><th>L<sub>w</sub></th><th>A<sub>div</sub></th><th>A<sub>atm</sub></th><th>A<sub>gr/bar</sub></th><th>A<sub>fol</sub></th><th>L<sub>p</sub></th><th>thr</th><th>Δ</th></tr>
        ${d.bands.map((bd, b) => {
          const ex = bd.lp + st.gain - thr[b];
          return `<tr class="${ex > 0 ? 'hot' : ''}"><td>${bd.f}</td><td>${fmt(lw[b], 0)}</td><td class="neg">−${fmt(d.adiv, 1)}</td><td class="neg">−${fmt(bd.aatm, 1)}</td><td class="neg">${bd.att >= 0 ? '−' : '+'}${fmt(Math.abs(bd.att), 1)}${bd.dz > bd.agr ? '<sup>D</sup>' : ''}</td><td class="neg">−${fmt(bd.afol, 1)}</td><td>${fmt(bd.lp + st.gain, 1)}</td><td>${fmt(thr[b], 0)}</td><td>${ex >= 0 ? '+' : ''}${fmt(ex, 1)}</td></tr>`;
        }).join('')}</table>
        <div class="perf">path ${fmt(d.pathLen, 0)} m vs direct ${fmt(d.direct, 0)} m → z = ${fmt(d.zDiff, 2)} m · K<sub>met</sub> ${fmt(d.kmet, 3)} · foliage ${fmt(d.folLen, 0)} m · <sup>D</sup> = terrain diffraction wins over ground effect</div>` : ''}
      <h3>Listen</h3>
      <div class="btns" id="listen">
        <button class="btn" data-l="floor" aria-pressed="${st.listen === 'floor'}">▶ dancefloor</button>
        <button class="btn" data-l="out" aria-pressed="${st.listen === 'out'}">▶ at the façade</button>
        <button class="btn" data-l="in" aria-pressed="${st.listen === 'in'}">▶ in the bedroom</button>
        <button class="btn" data-l="off">■ stop</button>
      </div>
      <p class="sub">Synthesised 128 BPM loop, filtered with this path's band attenuation. Volume is normalised, so you hear what's left of the spectrum: the kick survives, everything else is gone.</p>`;
  }

  sb.innerHTML = `<button class="close" aria-label="Close">×</button>
    <div class="coord mono"><b>${c.lat.toFixed(5)}°N ${c.lon.toFixed(5)}°E</b> · ${fmt(p.elev)} m<br>UTM32 ${fmt(c.x)} E ${fmt(c.y)} N</div>
    ${kpi}
    ${noiseBlock}
    <h3>Rating</h3>
    <div class="bars">${bar('overall', p.total, 'total')}${bar('noise', p.s.noise)}${bar('access', p.s.access)}${bar('hidden', p.s.hidden)}${bar('size', p.s.size)}</div>
    <h3>Visibility</h3>
    <dl class="kv">
      ${cand
        ? ds.meta.seen_by_classes.map((k) => {
            const f = (cand as unknown as Record<string, number>)[`vis_${k}`] ?? 0;
            return `<dt>seen from ${SEEN_LABELS[k] ?? k}</dt><dd><span class="pill ${f >= 0.5 ? 'bad' : f > 0 ? 'yes' : 'no'}">${f > 0 ? `${fmt(f * 100)} % of field` : 'no'}</span></dd>`;
          }).join('')
        : ds.meta.seen_by_classes.map((k) => {
            const on = p.seenAt.includes(SEEN_LABELS[k] ?? k);
            return `<dt>seen from ${SEEN_LABELS[k] ?? k}</dt><dd><span class="pill ${on ? 'yes' : 'no'}">${on ? 'yes' : 'no'}</span></dd>`;
          }).join('')}
      ${cand?.nearest_view_m ? `<dt>closest observer</dt><dd>${fmt(cand.nearest_view_m)} m</dd>` : ''}
    </dl>
    <h3>Access</h3>
    <dl class="kv">
      <dt>car-usable way${cand?.nearest_vehicle_way ? ` (${esc(cand.nearest_vehicle_way)})` : ''}</dt><dd>${fmt(p.distVeh)} m ${p.s.access === 0 ? '<span class="pill bad">too far</span>' : ''}</dd>
      <dt>any way incl. footpaths${nearestWay ? ` (${esc(nearestWay)})` : ''}</dt><dd>${fmt(p.distWay)} m</dd>
    </dl>
    <h3>Field</h3>
    <dl class="kv">
      ${openBlock}
    </dl>
    <h3>Rig &amp; atmosphere</h3>
    ${controls}
    ${pathBlock}
    <h3>Open in</h3>
    <div class="btns"><a class="btn" href="${gmaps}" target="_blank" rel="noopener">Google Maps ↗</a><a class="btn" href="${gsat}" target="_blank" rel="noopener">satellite ↗</a><a class="btn" href="${osm}" target="_blank" rel="noopener">OpenStreetMap ↗</a></div>`;

  sb.querySelector('.close')!.addEventListener('click', closeSidebar);
  sb.querySelector('#c-gain')?.addEventListener('input', (ev) => {
    st.gain = Number((ev.target as HTMLInputElement).value);
    applyGain();
    renderSidebar();
  });
  sb.querySelector('#c-met')?.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest('button');
    if (!b) return;
    const v = b.dataset.v === '1';
    if (v !== st.useKmet) {
      st.useKmet = v;
      compute();
    }
  });
  sb.querySelector('#c-band')?.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest('button');
    if (!b) return;
    st.band = Number(b.dataset.b);
    applyGain();
    renderSidebar();
    renderLegend();
  });
  sb.querySelector('#listen')?.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest('button');
    if (b) setListen(b.dataset.l as State['listen']);
  });
}

function setListen(mode: State['listen']) {
  st.listen = mode;
  if (mode === 'off') {
    rave.stop();
  } else {
    const r = st.result!;
    const nb = ds.meta.model.bands_hz.length;
    const lw = ds.meta.model.lw_db;
    let gains: number[] | null = null;
    if (mode !== 'floor' && st.sel >= 0) {
      // Relative to the dancefloor, ~15 m from the stacks: Lw − 20·log10(15) − 11.
      gains = lw.map((l, b) => r.recLp[st.sel * nb + b] - (l - 34.5) - (mode === 'in' ? ds.meta.impact.facade_reduction_db[b] : 0));
    }
    rave.setSpectrum(gains);
    rave.start();
  }
  $('#sidebar').querySelectorAll('#listen button').forEach((b) => b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.l === mode)));
}

// ------------------------------------------------------------------------------------------- about
function renderAbout() {
  const m = ds.meta;
  const s = m.stats;
  const i = m.impact;
  $('#about').innerHTML = `
    <h2>How it works</h2>
    <p>Everything you see is computed from open data: LGL Baden-Württemberg laser-scan terrain (DGM1) and surface (DOM1) models at 1 m, 3D buildings (LoD2), and OpenStreetMap. The heatmaps are precomputed. The noise map for a click is computed <b>live in your browser</b> by ${engine.size} Web Workers.</p>
    <div class="pipeline"><span>DGM1 + DOM1 tiles</span><i>→</i><span>2 m / 10 m rasters</span><i>→</i><span>open-ground mask</span><i>→</i><span>candidates</span><i>→</i><span>road viewshed</span><i>→</i><span>ISO 9613-2 per band</span><i>→</i><span>scores</span><i>→</i><span>this map</span></div>
    <h3>The rig</h3>
    <table><tr><th>band</th>${m.model.bands_hz.map((f) => `<th>${f} Hz</th>`).join('')}</tr>
      <tr><td>L<sub>w</sub> dB re 1 pW</td>${m.model.lw_db.map((v) => `<td>${v}</td>`).join('')}</tr>
      <tr><td>façade → bedroom</td>${i.facade_reduction_db.map((v) => `<td>−${v}</td>`).join('')}</tr>
      <tr><td>detection (outdoor)</td>${i.thresholds_db.map((v) => `<td>${v.toFixed(1)}</td>`).join('')}</tr></table>
    <p>A mid-size omni rig for ~100 people, sub at ${m.model.source_h_m} m. A building "hears" the party when any band at the façade exceeds the threshold: max(hearing threshold, quiet bedroom − ${i.rhythm_detect_db} dB) + façade reduction with the window tilted open.</p>
    <h3>Propagation (ISO 9613-2, octave bands)</h3>
    <span class="eq">L_p = L_w − A_div − A_atm − max(A_gr, D_z) − A_fol
A_div = 20·log10(d) + 11          spherical spreading
D_z   = 10·log10(3 + 20/λ · C3 · z · K_met),  ≤ 20 dB (1 edge) / 25 dB (multiple)
z     = (path over the terrain's upper convex hull) − (direct line)
K_met = exp(−1/2000 · √(d_ss·d_sr·d / 2z))   downwind / inversion at night</span>
    <p>For every path the terrain profile is sampled every ${m.model.step_m} m on the 10 m DTM. The diffraction path is a stretched string over the terrain (the upper convex hull), so a single ridge and a series of hills are handled the same way. Bass has wavelengths of 5–11 m, so hills stop it far worse than they stop the hi-hats. Forest barely helps: ${m.model.fol_per_m[1]} dB/m at 63 Hz.</p>
    <h3>From decibels to "people disturbed"</h3>
    <span class="eq">excess E = max over bands (L_p − threshold)
exposure = 0 for E ≤ ${i.faint_db} dB, rising to 1 at ${i.annoying_db} dB
people disturbed = Σ over buildings: occupants × night weight × exposure</span>
    <p>Occupants come from LoD2 footprint × storeys ÷ 47 m² per person. The night weight is 1 for homes, hotels and care homes, 0.15 for workplaces and 0 for barns and garden sheds. Buildings are pooled into ${fmt(s.receiver_cells)} receiver cells (25 m near, 250 m beyond ${fmt(m.receivers.near_field_m)} m).</p>
    <h3>The other ratings</h3>
    <ul>
      <li><b>Open ground:</b> nDSM (surface − terrain) &lt; ${m.candidates.max_ndsm_m} m, smooth, slope &lt; ${m.candidates.max_slope_deg}°, a ${m.candidates.min_width_m} m disc fits, ≥ ${m.candidates.min_area_m2} m², no water or nature reserves.</li>
      <li><b>Hidden:</b> viewsheds from major roads (motorway…secondary), medium roads (tertiary), sampled every ${m.visibility.observers.major_roads?.spacing_m} m at ${m.visibility.observers.major_roads?.eye_height_m} m eye height, and from homes: one observer per ${m.visibility.observers.homes?.cell_m} m cell with occupied houses, at an upper-floor window (${m.visibility.observers.homes?.eye_height_m} m). Target ${m.visibility.target_height_m} m, range ${fmt(m.visibility.max_range_m)} m. Anything more than ${m.visibility.min_obstacle_m} m above the ground blocks the view. People who can't hear the bass can still see the lights.</li>
      <li><b>Access:</b> organisers need to drive there. Only ways a car can use count (tracks and up, no footpaths): full score within ${m.candidates.access_full_m} m, 0.3 at ${m.candidates.max_vehicle_dist_m} m, excluded beyond.</li>
      <li><b>Rating:</b> weighted geometric mean of the four, ×0.25 if any building gets more than ${i.max_worst_db} dB over the threshold.</li>
    </ul>
    <h3>Caveats</h3>
    <p>A screening model, not a noise report. Worst-case weather is applied in every direction at once. There are no reflections and no lateral diffraction, and nothing is validated against measurements yet. Outside the LGL area the terrain comes from the Copernicus surface model, which counts forest as hills and overstates shielding there.</p>
    <h3>Disclaimer</h3>
    <p><b>Educational purposes only.</b> RAVERSTUHL demonstrates outdoor sound propagation and open geodata, and takes no responsibility for unsanctioned parties or any other use of this information. Respect nature and your neighbours.</p>
    <p><b>Recklessly vibe-coded.</b> This site, including its code, noise model, data processing and texts, was recklessly vibe-coded with Claude Opus 5.5, an AI by Anthropic, and may contain errors. Its results are estimates, not a noise assessment.</p>
    <h3>Data &amp; credits</h3>
    <ul class="sub">
      <li>Datenquelle: LGL, <a href="https://www.lgl-bw.de">www.lgl-bw.de</a>, <a href="https://www.govdata.de/dl-de/by-2-0">dl-de/by-2-0</a> (DGM1 terrain, DOM1 surface, LoD2 buildings)</li>
      <li>© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>, ODbL (roads, tracks, buildings outside LoD2, water, protected areas, map tiles)</li>
      <li>Copernicus DEM GLO-30 © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA (terrain beyond the LGL area)</li>
      <li>Recklessly vibe-coded with Claude Opus 5.5 (<a href="https://www.anthropic.com">Anthropic</a>)</li>
      <li>Map tiles <a href="https://openfreemap.org">OpenFreeMap</a> / <a href="https://openmaptiles.org">OpenMapTiles</a> · rendering <a href="https://maplibre.org">MapLibre GL JS</a> · fonts Space Grotesk, JetBrains Mono (OFL)</li>
    </ul>`;
}

boot().catch((err) => {
  console.error(err);
  $('#loading-msg').textContent = `failed: ${err.message}`;
});
