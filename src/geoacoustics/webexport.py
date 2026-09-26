"""Export pipeline results as static files for the web demo (``web/public/data/<name>/``).

Everything the browser needs is precomputed except the per-click noise map. That one is computed
client-side by a TypeScript port of the propagation kernel, so the export also ships the propagation
inputs: quantised 10 m terrain/canopy chunks and the receiver set, plus test vectors that pin the port
to the Python implementation.

Binary files are little-endian, row-major, north row first.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from PIL import Image
from pyproj import Transformer
from rasterio.features import rasterize
from scipy import ndimage

from geoacoustics.acoustics.propagation import path_levels
from geoacoustics.grid import CRS, Grid, read_tif
from geoacoustics.pipeline import (
    VEHICLE_WAYS,
    Ctx,
    _log,
    _ways,
    add_scores,
    band_model,
    thresholds,
)

DISPLAY_RES = 20.0
VIS_MAX_PX = 4096  # longest side of the visibility overlay image
CHUNK = 200  # cells per terrain chunk side (2 km at 10 m)
NODATA_I16 = -32768
TERRAIN_SCALE = 10.0  # int16 decimetres
CANOPY_SCALE = 4.0  # uint8 quarter metres

TO_LL = Transformer.from_crs(CRS, "EPSG:4326", always_xy=True)
FROM_LL = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)


def _corners(g: Grid) -> list[list[float]]:
    """Grid corners as [lon, lat]: top-left, top-right, bottom-right, bottom-left (MapLibre order)."""
    xmin, ymin, xmax, ymax = g.bounds
    lon, lat = TO_LL.transform([xmin, xmax, xmax, xmin], [ymax, ymax, ymin, ymin])
    return [[round(a, 7), round(b, 7)] for a, b in zip(lon, lat, strict=True)]


def _grid_meta(g: Grid) -> dict:
    return {"xmin": g.xmin, "ymax": g.ymax, "res": g.res, "rows": g.rows, "cols": g.cols,
            "corners": _corners(g)}


def _block_reduce(a: np.ndarray, k: int, fn) -> np.ndarray:
    r, c = a.shape[0] // k, a.shape[1] // k
    return fn(a[: r * k, : c * k].reshape(r, k, c, k), axis=(1, 3))


def _write(path: Path, arr: np.ndarray) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = np.ascontiguousarray(arr).astype(arr.dtype.newbyteorder("<"), copy=False).tobytes()
    path.write_bytes(data)
    return len(data)


# ------------------------------------------------------------------------------------ display layers
def _display_layers(ctx: Ctx, out: Path, meta: dict, t0: float) -> None:
    work = ctx.path("work_dir")
    g2, dtm2 = read_tif(work / "dtm_2m.tif")
    k = int(DISPLAY_RES / g2.res)
    gd = Grid(g2.xmin, g2.ymax, DISPLAY_RES, g2.rows // k, g2.cols // k)
    layers = {}

    with np.errstate(all="ignore"):
        elev = _block_reduce(dtm2, k, np.nanmean)
    layers["elev"] = ("u16", np.where(np.isnan(elev), 0, np.round(elev * 10)).astype(np.uint16), 0.1)
    del dtm2

    # Open ground: area (m²) of the open region each 20 m cell belongs to (max over the block).
    _, open2 = read_tif(work / "open_2m.tif")
    labels, n = ndimage.label(open2 > 0, structure=np.ones((3, 3)))
    areas = np.concatenate([[0], ndimage.sum_labels(open2 > 0, labels, np.arange(1, n + 1)) * g2.res ** 2])
    area2 = areas[labels].astype(np.float32)
    del labels
    layers["open_area"] = ("u16", np.clip(_block_reduce(area2, k, np.max) / 10, 0, 65535).astype(np.uint16), 10.0)
    layers["open_frac"] = ("u8", np.round(_block_reduce((open2 > 0).astype(np.float32), k, np.mean) * 255)
                           .astype(np.uint8), 1 / 255)
    del area2, open2
    _log("display: elevation + open ground", t0)

    # Access: distance to the nearest way / vehicle-capable way, via EDT on a 4 m raster.
    ways = _ways(ctx)
    lines = ways[ways.geom_type == "LineString"]
    ge = Grid(gd.xmin, gd.ymax, 4.0, gd.rows * 5, gd.cols * 5)
    for key, sel in (("dist_way", lines), ("dist_vehicle", lines[lines["highway"].isin(VEHICLE_WAYS)])):
        m = rasterize(((g, 1) for g in sel.geometry), out_shape=ge.shape, transform=ge.transform,
                      dtype=np.uint8, all_touched=True)
        d = ndimage.distance_transform_edt(m == 0) * ge.res
        layers[key] = ("u16", np.clip(d[2::5, 2::5], 0, 65535).astype(np.uint16), 1.0)
    _log("display: access distances", t0)

    # Visibility from major roads: visible share of each 20 m cell.
    gv, vd = read_tif(work / "view_any.tif")
    kv = int(DISPLAY_RES / gv.res)
    vis = _block_reduce(np.isfinite(vd).astype(np.float32), kv, np.mean)
    layers["visible"] = ("u8", np.round(vis[: gd.rows, : gd.cols] * 255).astype(np.uint8), 1 / 255)
    # Who can see it: bit k set if any part of the 20 m cell is visible from observer class k.
    seen_by = np.zeros(gd.shape, np.uint8)
    classes = list(ctx.cfg["visibility"]["observers"])
    for bit, name in enumerate(classes):
        _, vc = read_tif(work / f"view_{name}.tif")
        any_c = _block_reduce(np.isfinite(vc).astype(np.float32), kv, np.max)[: gd.rows, : gd.cols] > 0
        seen_by |= (any_c.astype(np.uint8) << bit)
    layers["seen_by"] = ("u8", seen_by, 1.0)
    meta["seen_by_classes"] = classes

    # Crisp visibility overlay: yellow = seen, dark blue = hidden.
    kv8 = max(1, int(np.ceil(max(gv.rows, gv.cols) / VIS_MAX_PX)))
    seen = _block_reduce(np.isfinite(vd).astype(np.float32), kv8, np.mean)
    valid = _block_reduce(np.isfinite(vd) | (vd == np.inf), kv8, np.mean) > 0  # NaN = no terrain
    rgba = np.zeros((*seen.shape, 4), np.uint8)
    rgba[..., :3] = np.where(seen[..., None] >= 0.5, [255, 212, 0], [8, 22, 78])
    rgba[..., 3] = np.where(valid, np.where(seen >= 0.5, 170, 150), 0)
    Image.fromarray(rgba, "RGBA").save(out / "visibility.png", optimize=True)
    gvis = Grid(gv.xmin, gv.ymax, gv.res * kv8, *seen.shape)
    meta["visibility_image"] = {"url": "visibility.png", **_grid_meta(gvis)}
    _log("display: visibility", t0)

    for key, (_, arr, _) in layers.items():
        assert arr.shape == gd.shape, (key, arr.shape, gd.shape)
        _write(out / f"layer_{key}.bin", arr)
    meta["display"] = {**_grid_meta(gd),
                       "layers": {k: {"dtype": d, "scale": s, "url": f"layer_{k}.bin"}
                                  for k, (d, _, s) in layers.items()}}

    # Heatmaps from the noise stage (50 m, float32).
    heat = {}
    for key in ("cost", "audible", "worst"):
        gh, a = read_tif(work / f"heat_{key}.tif")
        _write(out / f"heat_{key}.bin", a.astype(np.float32))
        heat[key] = f"heat_{key}.bin"
    meta["heat"] = {**_grid_meta(gh), "urls": heat}


# ------------------------------------------------------------------------------- propagation inputs
def _propagation_inputs(ctx: Ctx, out: Path, meta: dict, t0: float) -> tuple[np.ndarray, np.ndarray, Grid]:
    work = ctx.path("work_dir")
    gb, terr = read_tif(work / "terrain_buffer.tif")
    _, can = read_tif(work / "canopy_buffer.tif")
    tq = np.where(np.isnan(terr), NODATA_I16, np.round(terr * TERRAIN_SCALE)).astype(np.int16)
    cq = np.clip(np.round(np.nan_to_num(can) * CANOPY_SCALE), 0, 255).astype(np.uint8)
    nr, nc = -(-gb.rows // CHUNK), -(-gb.cols // CHUNK)
    size = 0
    for i in range(nr):
        for j in range(nc):
            t = np.full((CHUNK, CHUNK), NODATA_I16, np.int16)
            c = np.zeros((CHUNK, CHUNK), np.uint8)
            bt = tq[i * CHUNK : (i + 1) * CHUNK, j * CHUNK : (j + 1) * CHUNK]
            t[: bt.shape[0], : bt.shape[1]] = bt
            c[: bt.shape[0], : bt.shape[1]] = cq[i * CHUNK : (i + 1) * CHUNK, j * CHUNK : (j + 1) * CHUNK]
            p = out / "terrain" / f"{i}_{j}.bin"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(t.astype("<i2").tobytes() + c.tobytes())
            size += p.stat().st_size
    meta["terrain"] = {**_grid_meta(gb), "chunk": CHUNK, "chunk_rows": nr, "chunk_cols": nc,
                       "terrain_scale": TERRAIN_SCALE, "canopy_scale": CANOPY_SCALE,
                       "nodata": NODATA_I16, "url": "terrain/{i}_{j}.bin"}
    _log(f"terrain chunks: {nr}×{nc}, {size / 1e6:.1f} MB", t0)

    rec = pd.read_parquet(work / "receivers.parquet")
    near_m = ctx.cfg["propagation"]["near_field_m"]
    lod = (rec.rmin >= near_m).astype(np.float32)  # 0 = fine (used < near_m), 1 = coarse
    arr = np.column_stack([rec.x - gb.xmin, rec.y - (gb.ymax - gb.rows * gb.res), rec.people_eq, lod])
    _write(out / "receivers.bin", arr.astype(np.float32))
    meta["receivers"] = {"url": "receivers.bin", "count": len(rec), "stride": 4,
                         "origin": [gb.xmin, gb.ymax - gb.rows * gb.res],
                         "fields": ["dx", "dy", "people_eq", "lod"], "near_field_m": near_m}

    # Dequantised arrays, exactly what the browser will see.
    terr_q = np.where(tq == NODATA_I16, np.nan, tq / TERRAIN_SCALE)
    can_q = cq / CANOPY_SCALE
    return terr_q, can_q, gb


def _test_vectors(ctx: Ctx, terr, can, gb: Grid, out: Path, n: int = 400) -> None:
    """Random source–receiver pairs with band levels from the numba kernel, for the TS port's tests."""
    rng = np.random.default_rng(1)
    m = band_model(ctx)
    xmin, ymin, xmax, ymax = ctx.core_bounds
    cases = []
    lp = np.empty(len(m.freqs))
    scratch = int(ctx.cfg["propagation"]["max_range_m"] / m.step_m) + 4
    while len(cases) < n:
        sx, sy = rng.uniform(xmin, xmax), rng.uniform(ymin, ymax)
        d, a = rng.uniform(20, 7000), rng.uniform(0, 2 * np.pi)
        rx, ry = sx + d * np.cos(a), sy + d * np.sin(a)
        path_levels(terr, can, gb.xmin, gb.ymax, gb.res, sx, sy, m.hs, rx, ry, m.hr, *m.args(), lp,
                    np.empty(scratch), np.empty(scratch), np.empty(scratch), np.empty(scratch, np.int64))
        if np.all(np.isfinite(lp)):
            cases.append({"s": [sx, sy], "r": [rx, ry], "lp": [round(float(v), 6) for v in lp]})
    (out / "test_vectors.json").write_text(json.dumps(cases))


# ------------------------------------------------------------------------------------------ vectors
def _vectors(ctx: Ctx, out: Path, meta: dict) -> None:
    work, proc = ctx.path("work_dir"), ctx.path("out_dir")
    cand = add_scores(gpd.read_file(work / "candidates_noise.gpkg"), ctx.cfg)
    ranked = gpd.read_file(proc / "candidates_ranked.gpkg")
    rank_by_id = dict(zip(ranked.cand_id, ranked["rank"], strict=True))
    cand["rank"] = cand.cand_id.map(rank_by_id).fillna(0).astype(int)
    lon, lat = TO_LL.transform(cand.x.to_numpy(), cand.y.to_numpy())
    cand["lon"], cand["lat"] = np.round(lon, 6), np.round(lat, 6)
    # Only what the site reads (sidebar, outline colour, scoring test): this file is part of the initial load.
    cols = ["cand_id", "rank", "score", "area_m2", "noise_cost", "worst_excess_db", "dist_way_m", "nearest_way",
            "dist_vehicle_m", "nearest_vehicle_way", "visible_frac", "vis_major_roads", "vis_medium_roads",
            "vis_homes", "nearest_view_m", "slope_deg"]
    g = cand[cols + ["geometry"]].copy()
    g["geometry"] = g.geometry.simplify(3.0)
    for c in g.columns:
        if g[c].dtype.kind == "f":
            g[c] = g[c].round(4 if c in ("score", "noise_cost", "visible_frac") else 2)
    g.to_crs(4326).to_file(out / "candidates.geojson", driver="GeoJSON", COORDINATE_PRECISION=5)
    top = ranked.head(25)
    meta["top_sites"] = [
        {"rank": int(r["rank"]), "cand_id": int(r.cand_id), "score": round(float(r.score), 4),
         "lon": float(r.lon), "lat": float(r.lat), "area_m2": float(r.area_m2),
         "noise_cost": round(float(r.noise_cost), 3), "feasible": bool(r.feasible)}
        for _, r in top.iterrows()]
    meta["stats"] = {"candidates": len(cand), "sites": len(ranked), "feasible_sites": int(ranked.feasible.sum())}


# -------------------------------------------------------------------------------------------- DEM
def _dem_tiles(ctx: Ctx, out: Path, meta: dict, t0: float, zmin: int = 8, zmax_core: int = 14,
               zmax_buffer: int = 12) -> None:
    """Terrarium-encoded 256 px DEM tiles (Web Mercator) for MapLibre hillshade and 3D terrain."""
    work = ctx.path("work_dir")
    g2, dtm2 = read_tif(work / "dtm_2m.tif")
    with np.errstate(all="ignore"):
        dtm4 = _block_reduce(dtm2, 2, np.nanmean)
    del dtm2
    g4 = Grid(g2.xmin, g2.ymax, 4.0, *dtm4.shape)
    gb, terr = read_tif(work / "terrain_buffer.tif")

    def bilinear(g: Grid, z: np.ndarray, x, y):
        r, c = g.rc(x, y)
        r0, c0 = np.floor(r).astype(int), np.floor(c).astype(int)
        ok = (r0 >= 0) & (c0 >= 0) & (r0 + 1 < g.rows) & (c0 + 1 < g.cols)
        r0c, c0c = np.clip(r0, 0, g.rows - 2), np.clip(c0, 0, g.cols - 2)
        dr, dc = r - r0c, c - c0c
        v = ((z[r0c, c0c] * (1 - dc) + z[r0c, c0c + 1] * dc) * (1 - dr)
             + (z[r0c + 1, c0c] * (1 - dc) + z[r0c + 1, c0c + 1] * dc) * dr)
        return np.where(ok, v, np.nan)

    def lonlat_to_tile(lon, lat, z):
        n = 2 ** z
        x = (lon + 180) / 360 * n
        y = (1 - np.log(np.tan(np.radians(lat)) + 1 / np.cos(np.radians(lat))) / np.pi) / 2 * n
        return x, y

    bb = {"core": ctx.core_bounds, "buffer": gb.bounds}
    bb_ll = {}
    for k, (xmin, ymin, xmax, ymax) in bb.items():
        lon, lat = TO_LL.transform([xmin, xmin, xmax, xmax], [ymin, ymax, ymin, ymax])
        bb_ll[k] = (min(lon), min(lat), max(lon), max(lat))
    count, size = 0, 0
    px = (np.arange(256) + 0.5) / 256
    for z in range(zmin, zmax_core + 1):
        lon0, lat0, lon1, lat1 = bb_ll["core" if z > zmax_buffer else "buffer"]
        tx0, ty1 = lonlat_to_tile(lon0, lat0, z)
        tx1, ty0 = lonlat_to_tile(lon1, lat1, z)
        n = 2 ** z
        for tx in range(int(tx0), int(tx1) + 1):
            for ty in range(int(ty0), int(ty1) + 1):
                u, v = np.meshgrid(tx + px, ty + px)
                lon = u / n * 360 - 180
                lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * v / n))))
                x, y = FROM_LL.transform(lon, lat)
                h = bilinear(g4, dtm4, x, y)
                h = np.where(np.isnan(h), bilinear(gb, terr, x, y), h)
                if np.all(np.isnan(h)):
                    continue
                h = np.nan_to_num(h, nan=float(np.nanmin(h)))
                e = np.clip(h + 32768, 0, 65535.99)
                rgb = np.stack([np.floor(e / 256), np.floor(e % 256), np.floor((e % 1) * 256)], -1)
                p = out / "dem" / str(z) / str(tx) / f"{ty}.png"
                p.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(rgb.astype(np.uint8), "RGB").save(p, optimize=True)
                count += 1
                size += p.stat().st_size
    meta["dem"] = {"url": "dem/{z}/{x}/{y}.png", "encoding": "terrarium", "minzoom": zmin,
                   "maxzoom": zmax_core, "bounds": list(bb_ll["buffer"])}
    _log(f"DEM tiles: {count}, {size / 1e6:.1f} MB", t0)


# ------------------------------------------------------------------------------------------- stage
def stage_export_web(ctx: Ctx) -> None:
    t0 = time.time()
    out = ctx.path("web_dir")
    out.mkdir(parents=True, exist_ok=True)
    cfg = ctx.cfg
    m = band_model(ctx)
    meta: dict = {
        "name": cfg["name"], "title": cfg.get("title", cfg["name"]), "crs": CRS,
        "proj4": "+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
        "core_bounds": list(ctx.core_bounds),
        "model": {
            "bands_hz": list(map(float, m.freqs)), "lw_db": list(map(float, m.lw)),
            "alpha_db_km": list(map(float, m.alpha)), "fol_fixed": list(map(float, m.fol_fixed)),
            "fol_per_m": list(map(float, m.fol_per_m)), "ground_g": list(map(float, m.ground_g)),
            "iso_idx": list(map(int, m.iso_idx)), "use_kmet": bool(m.use_kmet), "step_m": m.step_m,
            "source_h_m": m.hs, "receiver_h_m": m.hr,
            "max_range_m": cfg["propagation"]["max_range_m"],
        },
        "impact": {**cfg["impact"], "thresholds_db": list(map(float, thresholds(ctx)))},
        "scoring": cfg["scoring"], "visibility": cfg["visibility"], "candidates": cfg["candidates"],
    }
    _display_layers(ctx, out, meta, t0)
    terr, can, gb = _propagation_inputs(ctx, out, meta, t0)
    _test_vectors(ctx, terr, can, gb, out)
    _log("test vectors", t0)
    _vectors(ctx, out, meta)
    _dem_tiles(ctx, out, meta, t0)
    bld = gpd.read_file(ctx.path("work_dir", "buildings.gpkg"), columns=["people_eq", "source"],
                        ignore_geometry=True)
    rec = pd.read_parquet(ctx.path("work_dir", "receivers.parquet"))
    meta["stats"].update({
        "buildings": len(bld), "buildings_lod2": int((bld.source == "lod2").sum()),
        "occupied_buildings": int((bld.people_eq > 0).sum()),
        "people_eq": round(float(rec[rec.rmin == 0].people_eq.sum())),
        "receiver_cells": len(rec), "heat_points": int(np.isfinite(read_tif(ctx.path("work_dir", "heat_cost.tif"))[1]).sum()),
    })
    add_initial_files(out, meta)
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    _write_area_index(out.parent)
    total = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    _log(f"web export: {total / 1e6:.1f} MB in {out}", t0)



def add_initial_files(out: Path, meta: dict) -> None:
    """meta["initial_files"]: the files the site loads before the map starts, with their byte sizes.

    Servers usually gzip them, which hides the size from the browser; the loading bar uses these instead.
    """
    urls = [layer["url"] for layer in meta["display"]["layers"].values()]
    urls += list(meta["heat"]["urls"].values()) + [meta["receivers"]["url"], "candidates.geojson"]
    meta["initial_files"] = {u: (out / u).stat().st_size for u in urls}


def _write_area_index(data_dir: Path) -> None:
    """data/areas.json lists every exported area; the site loads the first one unless ?area= is set."""
    areas = []
    for m in sorted(data_dir.glob("*/meta.json")):
        meta = json.loads(m.read_text())
        areas.append({"name": meta["name"], "title": meta.get("title", meta["name"]),
                      "bounds": meta["dem"]["bounds"]})
    (data_dir / "areas.json").write_text(json.dumps(areas, indent=1))
