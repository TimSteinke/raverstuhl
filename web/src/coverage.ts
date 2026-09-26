/** Debug page: ALKIS Gemarkung outlines, gaps and LGL tile status for an area (?area=<name>). */

import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const area = new URLSearchParams(location.search).get('area') ?? 'breisgau';
const base = `${import.meta.env.BASE_URL}data/${area}/coverage/`;
maplibregl.setWorkerUrl(new URL(`${import.meta.env.BASE_URL}vendor/maplibre/maplibre-gl-worker.mjs`, location.href).href);

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: { ofm: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: '© OpenStreetMap contributors · OpenFreeMap · LGL dl-de/by-2-0' } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#05060b' } },
      { id: 'water', type: 'fill', source: 'ofm', 'source-layer': 'water', paint: { 'fill-color': '#0a1a33' } },
      { id: 'roads', type: 'line', source: 'ofm', 'source-layer': 'transportation', filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary']]], paint: { 'line-color': '#3a4466', 'line-width': 1 } },
      { id: 'places', type: 'symbol', source: 'ofm', 'source-layer': 'place', filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village']]], layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 10 }, paint: { 'text-color': '#6b7493', 'text-halo-color': '#05060b', 'text-halo-width': 1 } },
    ],
  },
  center: [7.8, 48.05],
  zoom: 10,
});

map.on('load', async () => {
  const src = (f: string) => ({ type: 'geojson' as const, data: base + f });
  map.addSource('gem', src('gemarkungen.geojson'));
  map.addSource('gaps', src('gaps.geojson'));
  map.addSource('tiles', src('tiles.geojson'));
  map.addSource('boxes', src('aoi_boxes.geojson'));
  map.addLayer({ id: 'gem-fill', type: 'fill', source: 'gem', paint: { 'fill-color': '#00e5ff', 'fill-opacity': 0.18 } });
  map.addLayer({ id: 'gem-line', type: 'line', source: 'gem', paint: { 'line-color': '#00e5ff', 'line-width': 1.2 } });
  map.addLayer({ id: 'gaps', type: 'fill', source: 'gaps', paint: { 'fill-color': '#ff2bd6', 'fill-opacity': 0.55 } });
  map.addLayer({ id: 'gaps-line', type: 'line', source: 'gaps', paint: { 'line-color': '#ff2bd6', 'line-width': 2 } });
  map.addLayer({
    id: 'tiles', type: 'line', source: 'tiles',
    paint: {
      'line-color': ['case', ['all', ['==', ['get', 'dgm1'], 'ok'], ['==', ['get', 'dom1'], 'ok'], ['==', ['get', 'lod2'], 'ok']], '#3cf29a',
        ['==', ['get', 'dgm1'], 'outside BW'], '#ffd400', '#ff4d6d'],
      'line-width': 0.8, 'line-opacity': 0.6,
    },
  });
  map.addLayer({ id: 'boxes', type: 'line', source: 'boxes', layout: { visibility: 'none' }, paint: { 'line-color': '#a3acc8', 'line-width': 1, 'line-dasharray': [3, 2] } });
  map.addLayer({ id: 'gem-label', type: 'symbol', source: 'gem', layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 11 }, paint: { 'text-color': '#e8ecff', 'text-halo-color': '#05060b', 'text-halo-width': 1.5 } });

  const gem = await (await fetch(base + 'gemarkungen.geojson')).json();
  const b = new maplibregl.LngLatBounds();
  for (const f of gem.features) for (const ring of (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates)) for (const c of ring[0]) b.extend(c);
  map.fitBounds(b, { padding: 30, duration: 0 });
  const summary = await (await fetch(base + 'summary.json')).json();
  document.querySelector('#summary')!.textContent =
    `${summary.gemarkungen} Gemarkungen, ${summary.area_km2} km², ${summary.parts} part(s)\n${summary.gaps} enclosed gap(s), ${summary.gap_area_km2} km²\n` +
    Object.entries(summary.tiles as Record<string, Record<string, number>>).map(([p, v]) => `${p}: ${v.ok} ok · ${v['outside BW']} outside BW · ${v.missing} missing`).join('\n');

  map.on('mousemove', (e) => {
    const f = map.queryRenderedFeatures(e.point, { layers: ['gaps', 'gem-fill', 'tiles'] });
    const g = f.find((x) => x.layer.id === 'gaps');
    const m = f.find((x) => x.layer.id === 'gem-fill');
    const t = map.queryRenderedFeatures([[e.point.x - 2, e.point.y - 2], [e.point.x + 2, e.point.y + 2]], { layers: ['tiles'] })[0];
    document.querySelector('#hover')!.innerHTML = [
      g ? `<b style="color:#ff2bd6">gap</b> ${(g.properties.area_m2 / 1e6).toFixed(2)} km²` : '',
      m ? `<b>${m.properties.name}</b> · ${m.properties.area_km2} km² · ${m.properties.folder}` : 'no Gemarkung here',
      t ? `tile ${t.properties.tile}: dgm1 ${t.properties.dgm1} · dom1 ${t.properties.dom1} · lod2 ${t.properties.lod2}` : '',
    ].filter(Boolean).join('<br>');
  });
  (document.querySelector('#t-boxes') as HTMLInputElement).onchange = (ev) => map.setLayoutProperty('boxes', 'visibility', (ev.target as HTMLInputElement).checked ? 'visible' : 'none');
  (document.querySelector('#t-tiles') as HTMLInputElement).onchange = (ev) => map.setLayoutProperty('tiles', 'visibility', (ev.target as HTMLInputElement).checked ? 'visible' : 'none');
});
