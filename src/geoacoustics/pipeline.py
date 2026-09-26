"""Pipeline stages. Each stage reads its inputs from files and writes its outputs to files."""

from __future__ import annotations

import time
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import yaml
from rasterio.features import rasterize, shapes
from scipy import ndimage
from shapely import Polygon, box, union_all
from shapely.geometry import shape

from geoacoustics.acoustics.propagation import BandModel, exposure_matrix_scores
from geoacoustics.grid import CRS, Grid, read_tif, write_tif
from geoacoustics.ingest import alkis, buildings, lgl, osm, terrain
from geoacoustics.visibility import sample_lines, viewshed_min_distance

VEHICLE_WAYS = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
                "service", "track", "living_street", "road",
                "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
PAVED_ROADS = VEHICLE_WAYS - {"track"}


def _merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in over.items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


@dataclass
class Ctx:
    cfg: dict
    root: Path

    @classmethod
    def load(cls, config: str) -> Ctx:
        """configs/<area>.yaml merged over configs/defaults.yaml; {name} in data paths is substituted."""
        path = Path(config).resolve()
        root = path.parent.parent  # configs/<area>.yaml → repo root
        defaults = path.parent / "defaults.yaml"
        cfg = yaml.safe_load(path.read_text())
        if defaults.exists() and defaults != path:
            cfg = _merge(yaml.safe_load(defaults.read_text()), cfg)
        cfg["data"] = {k: v.format(name=cfg["name"]) if isinstance(v, str) else v for k, v in cfg["data"].items()}
        return cls(cfg, root)

    def path(self, key: str, name: str = "") -> Path:
        return self.root / self.cfg["data"][key] / name

    @property
    def tile_dirs(self) -> list[Path]:
        return [self.path("lgl_download_dir"), *(self.root / d for d in self.cfg["data"].get("lgl_tile_dirs", []))]

    @cached_property
    def aoi_boxes(self) -> dict[str, list[float]]:
        """Named (xmin, ymin, xmax, ymax) boxes: explicit `aoi.boxes`, or one per ALKIS Gemarkung."""
        aoi = self.cfg["aoi"]
        if "boxes" in aoi:
            return aoi["boxes"]
        dirs = [self.root / d for d in aoi["alkis_dirs"] if (self.root / d).exists()]
        return alkis.aoi_boxes(dirs, self.root / "data/interim/alkis_extents.json")

    @cached_property
    def aoi_tiles(self) -> list[lgl.Tile]:
        return lgl.tiles_for_boxes(self.aoi_boxes.values())

    def tiles(self, product: str) -> dict[lgl.Tile, Path]:
        """AOI tiles of ``product`` that are present locally."""
        want = set(self.aoi_tiles)
        return {t: p for t, p in lgl.find_tiles(self.tile_dirs, product).items() if t in want}

    @cached_property
    def core_bounds(self) -> tuple[float, float, float, float]:
        """Bounding box (m) of the AOI's 2 km tiles (tiles the portal doesn't have stay NaN)."""
        es, ns = [t.e_km for t in self.aoi_tiles], [t.n_km for t in self.aoi_tiles]
        km = 1000
        return min(es) * km, min(ns) * km, (max(es) + 2) * km, (max(ns) + 2) * km

    @property
    def buffer_bounds(self):
        b = self.cfg["propagation"]["buffer_m"]
        xmin, ymin, xmax, ymax = self.core_bounds
        return xmin - b, ymin - b, xmax + b, ymax + b

    def grid(self, res: float, buffered: bool = False) -> Grid:
        return Grid.from_bounds(*(self.buffer_bounds if buffered else self.core_bounds), res)


def _log(msg: str, t0: float) -> None:
    print(f"[{time.time() - t0:7.1f}s] {msg}", flush=True)


# -------------------------------------------------------------------------------------------- download
def stage_download(ctx: Ctx) -> None:
    """Fetches the AOI's DGM1/DOM1/LoD2 tiles that aren't in any tile folder yet."""
    tiles = ctx.aoi_tiles
    print(f"  AOI: {len(ctx.aoi_boxes)} boxes, {len(tiles)} tiles × {len(lgl.PRODUCTS)} products")
    st = lgl.download_tiles(tiles, list(lgl.PRODUCTS), ctx.path("lgl_download_dir"), ctx.tile_dirs[1:])
    print("  " + ", ".join(f"{k}: {len(v)}" for k, v in st.items()))
    if st["failed"]:
        raise RuntimeError(f"{len(st['failed'])} downloads failed, rerun to retry: {st['failed'][:5]}")


def stage_coverage(ctx: Ctx) -> None:
    """Debug data for web/coverage.html: Gemarkung outlines, enclosed gaps and LGL tile status."""
    import json

    out = ctx.path("web_dir", "coverage")
    out.mkdir(parents=True, exist_ok=True)
    gem = alkis.gemarkung_shapes([ctx.root / d for d in ctx.cfg["aoi"]["alkis_dirs"] if (ctx.root / d).exists()],
                                 ctx.root / "data/interim/alkis_shapes")
    gem["area_km2"] = (gem.area / 1e6).round(2)
    gem.to_crs(4326).to_file(out / "gemarkungen.geojson", driver="GeoJSON")

    union = union_all(gem.geometry.buffer(1.0))  # 1 m tolerance: neighbours don't share every vertex
    parts = getattr(union, "geoms", [union])
    holes = [shape_ for part in parts for shape_ in (Polygon(r) for r in part.interiors) if shape_.area > 2000]
    gaps = gpd.GeoDataFrame({"area_m2": [round(h.area) for h in holes]}, geometry=holes, crs=CRS)
    gaps.to_crs(4326).to_file(out / "gaps.geojson", driver="GeoJSON")

    missing_log = ctx.path("lgl_download_dir", "_missing.txt")
    known_missing = set(missing_log.read_text().split()) if missing_log.exists() else set()
    have = {p: ctx.tiles(p) for p in lgl.PRODUCTS}
    rows = []
    for t in ctx.aoi_tiles:
        status = {p: "ok" if t in have[p] else "outside BW" if t.filename(p) in known_missing else "missing"
                  for p in lgl.PRODUCTS}
        rows.append({"tile": f"{t.e_km}_{t.n_km}", **status,
                     "geometry": box(t.e_km * 1000, t.n_km * 1000, (t.e_km + 2) * 1000, (t.n_km + 2) * 1000)})
    tiles = gpd.GeoDataFrame(rows, geometry="geometry", crs=CRS)
    tiles.to_crs(4326).to_file(out / "tiles.geojson", driver="GeoJSON")
    boxes = gpd.GeoDataFrame({"name": list(ctx.aoi_boxes)}, geometry=[box(*b) for b in ctx.aoi_boxes.values()],
                             crs=CRS)
    boxes.to_crs(4326).to_file(out / "aoi_boxes.geojson", driver="GeoJSON")
    summary = {"gemarkungen": len(gem), "area_km2": round(float(union.area) / 1e6, 1), "parts": len(parts),
               "gaps": len(gaps), "gap_area_km2": round(float(gaps.area.sum()) / 1e6, 3),
               "tiles": {p: {k: sum(r[p] == k for r in rows) for k in ("ok", "outside BW", "missing")}
                         for p in lgl.PRODUCTS}}
    (out / "summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary, indent=1))


# --------------------------------------------------------------------------------------------- terrain
def stage_terrain(ctx: Ctx) -> None:
    t0 = time.time()
    work = ctx.path("work_dir")
    g2, g10 = ctx.grid(2), ctx.grid(10)
    layers = terrain.build_lgl_rasters(ctx.tiles("dgm1"), ctx.tiles("dom1"), g2, g10)
    for key, grid in (("dtm_2m", g2), ("ndsm_2m", g2), ("dtm_10m", g10), ("canopy_10m", g10)):
        write_tif(work / f"{key}.tif", grid, layers[key])
    _log("LGL rasters written", t0)

    gb = ctx.grid(ctx.cfg["propagation"]["terrain_res_m"], buffered=True)
    glo = terrain.resample_to_grid(terrain.download_glo30(gb, ctx.path("raw_dir", "copernicus")), gb)
    r0 = round((gb.ymax - g10.ymax) / gb.res)
    c0 = round((g10.xmin - gb.xmin) / gb.res)
    lgl = np.full(gb.shape, np.nan, np.float32)
    can = np.zeros(gb.shape, np.float32)
    lgl[r0 : r0 + g10.rows, c0 : c0 + g10.cols] = layers["dtm_10m"]
    can[r0 : r0 + g10.rows, c0 : c0 + g10.cols] = np.nan_to_num(layers["canopy_10m"])
    write_tif(work / "terrain_buffer.tif", gb, np.where(np.isnan(lgl), glo, lgl).astype(np.float32))
    write_tif(work / "canopy_buffer.tif", gb, can)
    _log("buffered propagation terrain written", t0)


# ------------------------------------------------------------------------------------------------- osm
# layer → (extent, margin in m): what each OSM layer is needed for.
OSM_LAYERS = {"ways": ("core", 500), "protected": ("core", 0), "water": ("core", 0), "buildings": ("buffer", 0)}


def _osm_bounds(ctx: Ctx, layer: str):
    extent, margin = OSM_LAYERS[layer]
    xmin, ymin, xmax, ymax = ctx.core_bounds if extent == "core" else ctx.buffer_bounds
    return xmin - margin, ymin - margin, xmax + margin, ymax + margin


def stage_osm(ctx: Ctx) -> None:
    for layer in OSM_LAYERS:
        data = osm.fetch_tiled(layer, _osm_bounds(ctx, layer), ctx.path("raw_dir", "osm/tiles"))
        print(f"  {layer}: {len(data['elements'])} elements")


def _load_osm(ctx: Ctx, layer: str) -> dict:
    return osm.fetch_tiled(layer, _osm_bounds(ctx, layer), ctx.path("raw_dir", "osm/tiles"))


# ------------------------------------------------------------------------------------------- receivers
OSM_RESIDENTIAL = {"house", "residential", "apartments", "detached", "semidetached_house", "terrace",
                   "farm", "bungalow", "dormitory", "cabin"}
OSM_LODGING = {"hotel", "hostel", "hospital", "nursing_home"}
OSM_WORK = {"commercial", "industrial", "retail", "office", "school", "public", "civic", "church",
            "kindergarten", "university", "warehouse", "supermarket"}


def _osm_receivers(ctx: Ctx, coverage) -> gpd.GeoDataFrame:
    gdf = osm.ways_gdf(_load_osm(ctx, "buildings"))
    gdf = gdf[gdf.geom_type == "Polygon"].copy()
    gdf["area_m2"] = gdf.area
    cent = gdf.centroid
    gdf = gdf[~cent.within(coverage)].copy()
    cent = gdf.centroid
    kind = gdf["building"].fillna("yes")
    weight = np.select(
        [kind.isin(OSM_RESIDENTIAL), kind.isin(OSM_LODGING), kind == "yes", kind.isin(OSM_WORK)],
        [1.0, 1.0, 0.6, 0.15], 0.0)
    category = np.select(
        [kind.isin(OSM_RESIDENTIAL), kind.isin(OSM_LODGING), kind == "yes", kind.isin(OSM_WORK)],
        ["residential", "lodging", "unknown", "work"], "none")
    levels = pd.to_numeric(gdf["building:levels"], errors="coerce").fillna(2.0).clip(1, 30)
    occupants = gdf["area_m2"] * levels * buildings.NET_FACTOR / buildings.M2_PER_PERSON
    out = gpd.GeoDataFrame({
        "id": "osm_" + gdf["osm_id"].astype(str), "function": -1, "height_m": levels * 3.0,
        "area_m2": gdf["area_m2"], "x": cent.x, "y": cent.y, "category": category, "weight": weight,
        "occupants": occupants, "source": "osm",
    }, geometry=cent, crs=CRS)
    out.loc[out["area_m2"] < 30, "weight"] = 0.0
    out["people_eq"] = out["occupants"] * out["weight"]
    return out


def stage_receivers(ctx: Ctx) -> None:
    t0 = time.time()
    lod2_tiles = ctx.tiles("lod2")
    lod2 = buildings.load_lod2(list(lod2_tiles.values()))
    lod2["source"] = "lod2"
    _log(f"{len(lod2)} LoD2 buildings", t0)
    coverage = union_all([box(t.e_km * 1000, t.n_km * 1000, (t.e_km + 2) * 1000, (t.n_km + 2) * 1000)
                          for t in lod2_tiles])
    osm_b = _osm_receivers(ctx, coverage)
    _log(f"{len(osm_b)} OSM buildings outside LoD2 coverage", t0)
    rec = pd.concat([lod2, osm_b], ignore_index=True)
    rec = gpd.GeoDataFrame(rec, geometry="geometry", crs=CRS)
    rec.to_file(ctx.path("work_dir", "buildings.gpkg"), layer="buildings", driver="GPKG")

    # Two-level receiver set: 25 m cells used near the source, 250 m clusters further away, where
    # the position error barely changes the level. Each cell is valid on a [rmin, rmax) distance range.
    occ = rec[rec["people_eq"] > 0]
    near_m = ctx.cfg["propagation"]["near_field_m"]
    fine = _aggregate(occ, 25.0).assign(rmin=0.0, rmax=near_m)
    coarse = _aggregate(occ, 250.0).assign(rmin=near_m, rmax=1e12)
    agg = pd.concat([fine, coarse], ignore_index=True)
    agg.to_parquet(ctx.path("work_dir", "receivers.parquet"))
    _log(f"{len(fine)} fine + {len(coarse)} coarse receiver cells, "
         f"{fine.people_eq.sum():.0f} people-eq", t0)


def _aggregate(occ: pd.DataFrame, cell: float) -> pd.DataFrame:
    """People-weighted receiver position and summed weight per ``cell``-sized square."""
    df = pd.DataFrame({"cx": np.floor(occ.x / cell).astype(int), "cy": np.floor(occ.y / cell).astype(int),
                       "wx": occ.x * occ.people_eq, "wy": occ.y * occ.people_eq,
                       "people_eq": occ.people_eq})
    agg = df.groupby(["cx", "cy"]).agg(wx=("wx", "sum"), wy=("wy", "sum"), people_eq=("people_eq", "sum"),
                                       n_buildings=("people_eq", "size")).reset_index()
    agg["x"] = agg.wx / agg.people_eq
    agg["y"] = agg.wy / agg.people_eq
    return agg[["x", "y", "people_eq", "n_buildings"]]


# ------------------------------------------------------------------------------------------ candidates
def _ways(ctx: Ctx) -> gpd.GeoDataFrame:
    return osm.ways_gdf(_load_osm(ctx, "ways"))


def _protected(ctx: Ctx) -> gpd.GeoDataFrame:
    p = osm.area_gdf(_load_osm(ctx, "protected"))
    title = p["protection_title"].fillna("").str.lower()
    strict = (p["leisure"] == "nature_reserve") | p["protect_class"].isin(["1", "1a", "1b", "2", "3", "4"]) \
        | title.str.contains("naturschutzgebiet|réserve naturelle|reserve naturelle")
    return p[strict & ~title.str.contains("landschaftsschutz")]


def _rect_sides(rect) -> tuple[float, float]:
    xy = np.asarray(rect.exterior.coords)
    a, b = np.hypot(*(xy[1] - xy[0])), np.hypot(*(xy[2] - xy[1]))
    return max(a, b), min(a, b)


def _open_ground(dtm: np.ndarray, ndsm: np.ndarray, res: float, c: dict, block: int = 2048, halo: int = 16):
    """Open & flat mask and slope (°, float16), computed in row blocks to bound memory."""
    rows = dtm.shape[0]
    fill = float(np.nanmean(dtm))
    open_ = np.zeros(dtm.shape, bool)
    slope = np.zeros(dtm.shape, np.float16)
    for r0 in range(0, rows, block):
        a0, a1 = max(r0 - halo, 0), min(r0 + block + halo, rows)
        d = dtm[a0:a1]
        nd = ndsm[a0:a1]
        sm = ndimage.gaussian_filter(np.nan_to_num(d, nan=fill), 2.0)
        gy, gx = np.gradient(sm, res)
        sl = np.degrees(np.arctan(np.hypot(gx, gy)))
        ndz = np.nan_to_num(nd, nan=99.0)
        m1 = ndimage.uniform_filter(ndz, 5)
        m2 = ndimage.uniform_filter(ndz * ndz, 5)
        rough = np.sqrt(np.clip(m2 - m1 * m1, 0, None))
        o = (nd < c["max_ndsm_m"]) & (rough < c["max_roughness_m"]) & (sl < c["max_slope_deg"]) & np.isfinite(d)
        k0, k1 = r0 - a0, r0 - a0 + min(block, rows - r0)
        open_[r0 : r0 + (k1 - k0)] = o[k0:k1]
        slope[r0 : r0 + (k1 - k0)] = sl[k0:k1]
    return open_, slope


def stage_candidates(ctx: Ctx) -> None:
    t0 = time.time()
    c = ctx.cfg["candidates"]
    work = ctx.path("work_dir")
    g, dtm = read_tif(work / "dtm_2m.tif")
    _, ndsm = read_tif(work / "ndsm_2m.tif")
    res = g.res

    open_, slope = _open_ground(dtm, ndsm, res, c)
    del ndsm
    _log(f"open & flat: {open_.mean() * 100:.1f}% of cells", t0)

    ways = _ways(ctx)
    roads = ways[ways["highway"].isin(PAVED_ROADS)]
    road_mask = rasterize(((geom.buffer(4), 1) for geom in roads.geometry), out_shape=g.shape,
                          transform=g.transform, dtype=np.uint8).astype(bool)
    open_ &= ~road_mask
    if c["exclude_protected"]:
        prot = _protected(ctx)
        if len(prot):
            pm = rasterize(((geom, 1) for geom in prot.geometry), out_shape=g.shape,
                           transform=g.transform, dtype=np.uint8).astype(bool)
            open_ &= ~pm
            prot.to_file(work / "protected.gpkg", driver="GPKG")
    water = osm.area_gdf(_load_osm(ctx, "water"))
    if len(water):
        wm = rasterize(((geom, 1) for geom in water.geometry), out_shape=g.shape,
                       transform=g.transform, dtype=np.uint8).astype(bool)
        open_ &= ~wm
    _log("masked roads, water and protected areas", t0)

    r = c["min_width_m"] / 2 / res
    edt = ndimage.distance_transform_edt(open_).astype(np.float32)
    core_ = edt >= r
    opened = ndimage.distance_transform_edt(~core_) <= r
    del core_
    labels, n = ndimage.label(opened, structure=np.ones((3, 3)))
    areas = ndimage.sum_labels(opened, labels, np.arange(1, n + 1)) * res * res
    keep = np.flatnonzero(areas >= c["min_area_m2"]) + 1
    _log(f"{n} open regions, {len(keep)} ≥ {c['min_area_m2']} m²", t0)
    lut = np.zeros(n + 1, np.int32)
    lut[keep] = np.arange(1, len(keep) + 1)
    labels = lut[labels]
    centers = ndimage.maximum_position(edt, labels, np.arange(1, len(keep) + 1))
    radius = ndimage.maximum(edt, labels, np.arange(1, len(keep) + 1)) * res
    cr = np.array([p[0] for p in centers])
    cc = np.array([p[1] for p in centers])
    cx, cy = g.xy(cr, cc)

    polys = {int(v): shape(geom) for geom, v in shapes(labels, mask=labels > 0, transform=g.transform)}
    cand = gpd.GeoDataFrame({
        "cand_id": np.arange(1, len(keep) + 1),
        "area_m2": areas[keep - 1],
        "max_open_radius_m": radius,
        "x": cx, "y": cy,
        "elevation_m": dtm[cr, cc],
        "slope_deg": slope[cr, cc].astype(np.float32),
    }, geometry=[polys[i] for i in range(1, len(keep) + 1)], crs=CRS)

    mrr = cand.geometry.minimum_rotated_rectangle()
    sides = np.array([_rect_sides(r) for r in mrr])
    cand["elongation"] = sides[:, 0] / np.maximum(sides[:, 1], 1e-6)
    cand = cand[cand.elongation <= c["max_elongation"]].reset_index(drop=True)
    cx, cy = cand.x.to_numpy(), cand.y.to_numpy()

    # Access: distance from the dancefloor centre to the nearest OSM way / vehicle-capable way.
    pts = gpd.GeoDataFrame(cand[["cand_id"]], geometry=gpd.points_from_xy(cx, cy), crs=CRS)
    lines = ways[ways.geom_type == "LineString"]
    veh = lines[lines["highway"].isin(VEHICLE_WAYS)]
    near_any = gpd.sjoin_nearest(pts, lines[["highway", "geometry"]], distance_col="dist_way_m")
    near_veh = gpd.sjoin_nearest(pts, veh[["highway", "geometry"]], distance_col="dist_vehicle_m")
    near_any = near_any.drop_duplicates("cand_id").set_index("cand_id")
    near_veh = near_veh.drop_duplicates("cand_id").set_index("cand_id")
    cand["dist_way_m"] = cand.cand_id.map(near_any.dist_way_m)
    cand["nearest_way"] = cand.cand_id.map(near_any.highway)
    cand["dist_vehicle_m"] = cand.cand_id.map(near_veh.dist_vehicle_m)
    cand["nearest_vehicle_way"] = cand.cand_id.map(near_veh.highway)
    for label, kinds, min_d in (
        ("major", {"motorway", "trunk", "primary", "secondary", "motorway_link", "trunk_link",
                   "primary_link", "secondary_link"}, c["min_major_road_dist_m"]),
        ("minor", {"tertiary", "tertiary_link", "unclassified", "residential"}, c["min_minor_road_dist_m"]),
    ):
        rd = lines[lines["highway"].isin(kinds)][["geometry"]]
        near = gpd.sjoin_nearest(pts, rd, distance_col="d").drop_duplicates("cand_id").set_index("cand_id")
        cand[f"dist_{label}_road_m"] = cand.cand_id.map(near.d)
        cand = cand[cand[f"dist_{label}_road_m"] >= min_d]
    cand = cand[cand.dist_vehicle_m <= c["max_vehicle_dist_m"]].reset_index(drop=True)
    cand.to_file(work / "candidates.gpkg", driver="GPKG")
    write_tif(work / "open_2m.tif", g, (labels > 0).astype(np.uint8), nodata=None)
    _log(f"{len(cand)} candidates within {c['max_vehicle_dist_m']} m of a vehicle way", t0)


# ----------------------------------------------------------------------------------------------- noise
def band_model(ctx: Ctx) -> BandModel:
    s, p = ctx.cfg["source"], ctx.cfg["propagation"]
    return BandModel(s["bands_hz"], s["lw_db"], ground_g=p["ground_g"], use_kmet=p["use_kmet"],
                     step_m=p["step_m"], source_h_m=s["height_m"], receiver_h_m=p["receiver_height_m"])


def thresholds(ctx: Ctx) -> np.ndarray:
    i = ctx.cfg["impact"]
    """Outdoor façade level per band above which the music is detectable indoors."""
    indoor = np.maximum(np.array(i["hearing_threshold_db"]),
                        np.array(i["indoor_background_db"]) - i["rhythm_detect_db"])
    return indoor + np.array(i["facade_reduction_db"])


def score_sources(ctx: Ctx, sx: np.ndarray, sy: np.ndarray):
    work = ctx.path("work_dir")
    gb, terr = read_tif(work / "terrain_buffer.tif")
    _, can = read_tif(work / "canopy_buffer.tif")
    rec = pd.read_parquet(work / "receivers.parquet")
    m, i = band_model(ctx), ctx.cfg["impact"]
    return exposure_matrix_scores(
        terr.astype(np.float64), can.astype(np.float64), gb.xmin, gb.ymax, gb.res,
        np.ascontiguousarray(sx, float), np.ascontiguousarray(sy, float), m.hs,
        rec.x.to_numpy(float), rec.y.to_numpy(float), rec.people_eq.to_numpy(float),
        rec.rmin.to_numpy(float), rec.rmax.to_numpy(float), m.hr,
        m.freqs, m.iso_idx, m.lw, m.alpha, m.fol_fixed, m.fol_per_m, m.ground_g, m.use_kmet, m.step_m,
        float(ctx.cfg["propagation"]["max_range_m"]), thresholds(ctx), float(i["faint_db"]),
        float(i["annoying_db"]),
    )


def stage_noise(ctx: Ctx) -> None:
    t0 = time.time()
    work = ctx.path("work_dir")
    cand = gpd.read_file(work / "candidates.gpkg")
    cost, aud, worst = score_sources(ctx, cand.x.to_numpy(), cand.y.to_numpy())
    cand["noise_cost"], cand["audible_people_eq"], cand["worst_excess_db"] = cost, aud, worst
    cand.to_file(work / "candidates_noise.gpkg", driver="GPKG")
    _log(f"scored {len(cand)} candidates", t0)

    gh = ctx.grid(ctx.cfg["scoring"]["heatmap_res_m"])
    _, dtm10 = read_tif(work / "dtm_10m.tif")
    g10 = ctx.grid(10)
    hx, hy = gh.centres()
    r, c = g10.rc(hx, hy)
    valid = np.isfinite(dtm10[np.clip(np.round(r).astype(int), 0, g10.rows - 1),
                              np.clip(np.round(c).astype(int), 0, g10.cols - 1)])
    _log(f"heatmap: {valid.sum()} source points at {gh.res:.0f} m", t0)
    cost, aud, worst = score_sources(ctx, hx[valid], hy[valid])
    for name, v in (("cost", cost), ("audible", aud), ("worst", worst)):
        a = np.full(gh.shape, np.nan, np.float32)
        a[valid] = v
        write_tif(work / f"heat_{name}.tif", gh, a)
    _log("heatmap written", t0)


# ------------------------------------------------------------------------------------------ visibility
def _observers(ctx: Ctx, name: str, spec: dict) -> np.ndarray:
    if "classes" in spec:
        ways = _ways(ctx)
        roads = ways[ways["highway"].isin(spec["classes"]) & (ways.geom_type == "LineString")]
        return sample_lines(roads.geometry, spec["spacing_m"])
    bld = gpd.read_file(ctx.path("work_dir", "buildings.gpkg"), columns=["category", "people_eq", "x", "y"],
                        ignore_geometry=True)
    homes = bld[bld.category.isin(["residential", "lodging", "care"]) & (bld.people_eq > 0)]
    cell = spec["cell_m"]
    key = [np.floor(homes.x / cell), np.floor(homes.y / cell)]
    return homes.groupby(key)[["x", "y"]].mean().to_numpy()


def stage_visibility(ctx: Ctx) -> None:
    """Viewsheds per observer class (roads, homes). Writes view_<class>.tif and the combined view_any.tif."""
    t0 = time.time()
    v = ctx.cfg["visibility"]
    work = ctx.path("work_dir")
    g2, dtm2 = read_tif(work / "dtm_2m.tif")
    _, nd2 = read_tif(work / "ndsm_2m.tif")
    k = round(v["res_m"] / g2.res)
    rows, cols = g2.rows // k, g2.cols // k
    blocks = lambda a: a[: rows * k, : cols * k].reshape(rows, k, cols, k)  # noqa: E731
    with np.errstate(all="ignore"):
        dtm = np.nanmean(blocks(dtm2), axis=(1, 3))
        nd = np.nanmax(blocks(nd2), axis=(1, 3))
    del dtm2, nd2
    surface = dtm + np.where(np.nan_to_num(nd) > v["min_obstacle_m"], nd, 0.0)
    g = Grid(g2.xmin, g2.ymax, g2.res * k, rows, cols)

    combined = np.full(g.shape, np.inf, np.float32)
    per_class = {}
    for name, spec in v["observers"].items():
        obs = _observers(ctx, name, spec)
        dist = viewshed_min_distance(dtm.astype(np.float64), surface.astype(np.float64), g.xmin, g.ymax, g.res,
                                     obs[:, 0].copy(), obs[:, 1].copy(), float(spec["eye_height_m"]),
                                     float(v["target_height_m"]), float(v["max_range_m"]),
                                     float(spec.get("skip_obstacles_m", 0.0)))
        dist[np.isnan(dtm)] = np.nan
        write_tif(work / f"view_{name}.tif", g, dist)
        combined = np.fmin(combined, dist)
        per_class[name] = dist
        _log(f"{name}: {len(obs)} observers, sees {np.isfinite(dist).mean() * 100:.1f}% of cells", t0)
    combined[np.isnan(dtm)] = np.nan
    write_tif(work / "view_any.tif", g, combined)
    _log(f"seen by anyone: {np.isfinite(combined).mean() * 100:.1f}% of cells", t0)

    cand = gpd.read_file(work / "candidates.gpkg")
    labels = rasterize(zip(cand.geometry, cand.cand_id, strict=True), out_shape=g.shape, transform=g.transform,
                       dtype=np.int32, all_touched=True)
    ids = cand.cand_id.to_numpy()
    cand["visible_frac"] = ndimage.mean(np.isfinite(combined), labels, ids)
    for name, dist in per_class.items():
        cand[f"vis_{name}"] = ndimage.mean(np.isfinite(dist), labels, ids)
    near = np.where(np.isfinite(combined), combined, 1e9)
    cand["nearest_view_m"] = ndimage.minimum(near, labels, ids)
    cand.loc[cand.nearest_view_m >= 1e9, "nearest_view_m"] = np.nan
    cand.to_file(work / "candidates.gpkg", driver="GPKG")
    _log(f"{(cand.visible_frac > 0).mean() * 100:.0f}% of candidates partly visible", t0)


# ----------------------------------------------------------------------------------------------- score
def access_score(dist_vehicle_m, full_m: float, max_m: float):
    """1 up to ``full_m`` from a vehicle way, falling to 0.3 at ``max_m``; 0 beyond (not reachable by car)."""
    d = np.asarray(dist_vehicle_m, float)
    return np.where(d <= max_m, np.interp(d, [full_m, max_m], [1.0, 0.3]), 0.0)


def add_scores(cand: pd.DataFrame, cfg: dict) -> pd.DataFrame:
    """Sub-scores in [0, 1], the combined score and the hard noise limit. Mirrored in web/src/scoring.ts."""
    s, imp = cfg["scoring"], cfg["impact"]
    cand["noise_score"] = 0.5 ** (cand.noise_cost / imp["cost_half_people"])
    c = cfg["candidates"]
    cand["access_score"] = access_score(cand.dist_vehicle_m, c["access_full_m"], c["max_vehicle_dist_m"])
    cand["size_score"] = np.clip(cand.area_m2 / s["size_full_m2"], 0, 1)
    vis = cand["visible_frac"] if "visible_frac" in cand else pd.Series(0.0, index=cand.index)
    cand["hidden_score"] = np.interp(vis.fillna(0), [s["visible_ok_frac"], s["visible_bad_frac"]], [1.0, 0.2])
    w = s["weights"]
    # Weighted geometric mean: a spot that is bad on one criterion (above all: noise) stays bad.
    cand["score"] = np.exp(sum(w[k] * np.log(np.clip(cand[f"{k}_score"], 1e-9, 1)) for k in w)
                           / sum(w.values()))
    cand["feasible"] = cand.worst_excess_db <= imp["max_worst_db"]
    cand.loc[~cand.feasible, "score"] *= 0.25
    return cand


def stage_score(ctx: Ctx) -> None:
    work, out = ctx.path("work_dir"), ctx.path("out_dir")
    out.mkdir(parents=True, exist_ok=True)
    s = ctx.cfg["scoring"]
    cand = gpd.read_file(work / "candidates_noise.gpkg")
    cand = add_scores(cand, ctx.cfg)
    cand = cand.sort_values("score", ascending=False).reset_index(drop=True)
    # Merge neighbours into sites: greedy non-maximum suppression in score order.
    xy = cand[["x", "y"]].to_numpy()
    site = np.full(len(cand), -1)
    for i in range(len(cand)):
        if site[i] < 0:
            near = (np.hypot(*(xy - xy[i]).T) < s["site_merge_m"]) & (site < 0)
            site[near] = i
    cand["site_of"] = site
    cand = cand[cand.index == cand.site_of].reset_index(drop=True).drop(columns="site_of")
    cand["rank"] = np.arange(1, len(cand) + 1)
    lon, lat = gpd.GeoSeries(gpd.points_from_xy(cand.x, cand.y), crs=CRS).to_crs(4326).pipe(
        lambda g: (g.x, g.y))
    cand["lat"], cand["lon"] = lat.round(6), lon.round(6)
    cand.to_file(out / "candidates_ranked.gpkg", driver="GPKG")
    cols = ["rank", "score", "feasible", "noise_score", "access_score", "size_score", "area_m2",
            "worst_excess_db", "audible_people_eq", "noise_cost", "dist_way_m", "nearest_way",
            "dist_vehicle_m", "nearest_vehicle_way", "dist_major_road_m", "dist_minor_road_m",
            "hidden_score", "visible_frac", "vis_major_roads", "vis_medium_roads", "vis_homes",
            "nearest_view_m", "elevation_m",
            "lat", "lon"]
    cand[cols].to_csv(out / "candidates_ranked.csv", index=False, float_format="%.3f")
    print(cand[cols].head(15).to_string())


STAGES = {
    "download": stage_download,
    "coverage": stage_coverage,
    "terrain": stage_terrain,
    "osm": stage_osm,
    "receivers": stage_receivers,
    "candidates": stage_candidates,
    "visibility": stage_visibility,
    "noise": stage_noise,
    "score": stage_score,
}
