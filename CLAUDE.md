# geoacoustics

Project idea: find remote outdoor spots suitable for raves by combining public geodata
with an outdoor sound-propagation model. The first test area is a 20 km radius around Freiburg
im Breisgau. The same pipeline should later run on any area that has geodata.

See `docs/plan.md` for the plan, the feasibility notes, the decisions and known limitations.
See `README.md` for commands. Run everything with `uv run ...`. Pipeline stages are in
`src/geoacoustics/pipeline.py`, model parameters in `configs/defaults.yaml`, areas in `configs/<area>.yaml`. The web demo lives in
`web/` (static, TypeScript). Its propagation and scoring code mirrors the Python code, and
`npm test` checks the two against each other: change both together.

## What a good spot looks like (requirements)

1. **Open area**: no vegetation or buildings in the way, roughly flat, big enough for a dancefloor
   plus a sound system. For example a forest clearing, a meadow or an empty parking lot.
2. **Access**: reachable by at least a footpath, without crossing open wilderness. A track that
   vehicles can use counts for more, because the gear has to get there.
3. **Low noise impact**: little sound, especially low-frequency bass (roughly 30–125 Hz), reaches
   places where people live or work. Terrain, distance and vegetation should do the shielding.
4. **Hidden**: can't be seen or heard from major roads or busy places (huts, campsites, trailhead
   car parks).

Hard exclusions (not scored, just removed): nature reserves (NSG) and similar protected areas.

## Tech stack & conventions

- Python ≥ 3.12, managed with `uv`. Core packages: numpy/scipy, rasterio/rioxarray, geopandas/shapely,
  pyproj, numba (for hot loops). Only move to Rust or CUDA once profiling shows numba isn't fast enough.
- Working CRS: **EPSG:25832** (ETRS89 / UTM 32N), the CRS the LGL BW data ships in. All internal
  rasters and vectors use metres in this CRS. For areas outside zone 32, pick the matching UTM zone
  for each AOI.
- Data layout: `data/raw/<source>/` (untouched downloads, gitignored), `data/interim/`,
  `data/processed/`. The pipeline must never modify `data/raw`.
- Structure the pipeline as separate, cacheable stages (ingest → derive layers → candidates →
  propagation → scoring → report). Each stage reads files and writes files, so any stage can be
  re-run on its own.
- Data-source adapters sit behind a common interface (DTM, DSM, buildings+use, land cover, roads/paths).
  One adapter targets high-res German state data. A global fallback uses Copernicus DEM, ESA WorldCover
  and OSM.
- Acoustic code works in **octave bands**, not just dB(A): bass is the main concern and A-weighting
  hides it. Every model assumption (source power, meteorology, thresholds) is an explicit config
  parameter with its units in the name, e.g. `source_lw_db`, `threshold_db_63hz`.
- Outputs are GeoPackage and GeoTIFF files so they can be inspected in QGIS, plus a ranked candidate
  table.
- Tests: pytest. Acoustic modules get tests against analytic cases (free-field spreading, a thin
  barrier using Maekawa/ISO 9613-2 formulas, atmospheric absorption from ISO 9613-1 tables).
