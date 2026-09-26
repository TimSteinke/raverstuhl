/** MapLibre style: our DEM (hillshade, 3D) + OpenFreeMap vector tiles for roads, buildings, names. */

import type { ExpressionSpecification, StyleSpecification } from 'maplibre-gl';
import { BASE } from './data';
import type { Meta } from './meta';

const NAME: ExpressionSpecification = ['coalesce', ['get', 'name:de'], ['get', 'name']];
const INK = '#e8ecff';
const HALO = '#04050a';

export function buildStyle(meta: Meta): StyleSpecification {
  const demUrl = new URL(BASE + meta.dem.url, window.location.href).href.replace(/%7B/g, '{').replace(/%7D/g, '}');
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      dem: {
        type: 'raster-dem', tiles: [demUrl], tileSize: 256, encoding: 'terrarium',
        minzoom: meta.dem.minzoom, maxzoom: meta.dem.maxzoom, bounds: meta.dem.bounds,
        attribution:
          'Datenquelle: LGL, <a href="https://www.lgl-bw.de">www.lgl-bw.de</a>, <a href="https://www.govdata.de/dl-de/by-2-0">dl-de/by-2-0</a>',
      },
      // Same tiles, separate source: MapLibre renders hillshade and 3D terrain better that way.
      'dem-terrain': {
        type: 'raster-dem', tiles: [demUrl], tileSize: 256, encoding: 'terrarium',
        minzoom: meta.dem.minzoom, maxzoom: meta.dem.maxzoom, bounds: meta.dem.bounds,
      },
      ofm: {
        type: 'vector', url: 'https://tiles.openfreemap.org/planet',
        attribution: '<a href="https://openfreemap.org">OpenFreeMap</a> · <a href="https://openmaptiles.org">© OpenMapTiles</a> · Data <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a> (ODbL)',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#05060b' } },
      {
        id: 'hillshade', type: 'hillshade', source: 'dem',
        paint: {
          'hillshade-method': 'multidirectional',
          'hillshade-illumination-direction': [315, 270, 0, 225],
          'hillshade-illumination-altitude': [35, 35, 35, 35],
          'hillshade-highlight-color': ['#4a5a80', '#26314a', '#26314a', '#1c2438'],
          'hillshade-shadow-color': ['#000000', '#020309', '#020309', '#03040c'],
          'hillshade-exaggeration': 0.75,
        },
      },
      { id: 'water', type: 'fill', source: 'ofm', 'source-layer': 'water', paint: { 'fill-color': '#071a33', 'fill-opacity': 0.9 } },
      {
        id: 'waterway', type: 'line', source: 'ofm', 'source-layer': 'waterway',
        paint: { 'line-color': '#0d2a4d', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 15, 2] },
      },
      // Data overlays are inserted here (before 'roads-minor').
      {
        id: 'roads-minor', type: 'line', source: 'ofm', 'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['tertiary', 'minor', 'service', 'track', 'path']]],
        minzoom: 11,
        paint: {
          'line-color': ['match', ['get', 'class'], ['track', 'path'], '#6f7ea3', '#8c97b5'],
          'line-opacity': ['match', ['get', 'class'], ['track', 'path'], 0.45, 0.55],
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.3, 14, 0.9, 17, 2],
          'line-dasharray': ['match', ['get', 'class'], ['track', 'path'], ['literal', [2, 1.5]], ['literal', [1, 0]]],
        },
      },
      {
        id: 'roads-major', type: 'line', source: 'ofm', 'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary']]],
        paint: {
          'line-color': '#dfe5f5',
          'line-opacity': 0.75,
          'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 13, 1.6, 17, 5],
        },
      },
      {
        id: 'rail', type: 'line', source: 'ofm', 'source-layer': 'transportation',
        filter: ['==', ['get', 'class'], 'rail'], minzoom: 11,
        paint: { 'line-color': '#9aa3bb', 'line-opacity': 0.5, 'line-width': 1, 'line-dasharray': [3, 2] },
      },
      {
        id: 'buildings', type: 'fill', source: 'ofm', 'source-layer': 'building', minzoom: 12,
        paint: {
          'fill-color': '#c7cfe6',
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.35, 16, 0.55],
          'fill-outline-color': '#e8ecff',
        },
      },
      {
        id: 'peaks', type: 'symbol', source: 'ofm', 'source-layer': 'mountain_peak', minzoom: 11,
        filter: ['has', 'name'],
        layout: {
          'text-field': ['concat', '▲ ', NAME, ['case', ['has', 'ele'], ['concat', '\n', ['to-string', ['get', 'ele']], ' m'], '']],
          'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-anchor': 'top', 'text-offset': [0, 0.2],
        },
        paint: { 'text-color': '#9fb0d8', 'text-halo-color': HALO, 'text-halo-width': 1.4 },
      },
      {
        id: 'places', type: 'symbol', source: 'ofm', 'source-layer': 'place',
        filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village', 'hamlet', 'suburb']]],
        layout: {
          'text-field': NAME,
          'text-font': ['match', ['get', 'class'], ['city', 'town'], ['literal', ['Noto Sans Bold']], ['literal', ['Noto Sans Regular']]],
          'text-size': ['match', ['get', 'class'], 'city', 16, 'town', 14, 'village', 12, 10.5],
          'text-transform': ['match', ['get', 'class'], ['city', 'town'], 'uppercase', 'none'],
          'text-letter-spacing': ['match', ['get', 'class'], ['city', 'town'], 0.12, 0.02],
          'symbol-sort-key': ['match', ['get', 'class'], 'city', 0, 'town', 1, 'village', 2, 3],
        },
        paint: { 'text-color': INK, 'text-halo-color': HALO, 'text-halo-width': 1.6, 'text-opacity': 0.92 },
      },
    ],
  };
}
