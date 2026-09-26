// MapLibre 6 ships its worker as an ES module that imports a shared chunk. Vite can't bundle that
// pair, so both files are copied verbatim to public/vendor/maplibre/ (run via predev/prebuild).
import { copyFileSync, mkdirSync } from 'node:fs';

const src = new URL('../node_modules/maplibre-gl/dist/', import.meta.url);
const dst = new URL('../public/vendor/maplibre/', import.meta.url);
mkdirSync(dst, { recursive: true });
for (const f of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) copyFileSync(new URL(f, src), new URL(f, dst));
