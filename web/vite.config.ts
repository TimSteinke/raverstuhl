import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // Missing DEM tiles must 404 (not fall back to index.html) so MapLibre skips them.
  appType: 'mpa',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    // coverage.html: debug view of the input data (ALKIS outlines, LGL tiles), not linked from the site.
    rollupOptions: { input: { main: 'index.html', coverage: 'coverage.html' } },
  },
});
