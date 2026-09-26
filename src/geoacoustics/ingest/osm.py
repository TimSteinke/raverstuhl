"""OpenStreetMap layers via the Overpass API: ways (access), buildings (receivers outside LoD2), protected areas."""

from __future__ import annotations

import json
import time
from pathlib import Path

import geopandas as gpd
import httpx
import numpy as np
from pyproj import Transformer
from shapely import LineString, Polygon, polygonize, union_all

from geoacoustics.grid import CRS

OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

QUERIES = {
    "ways": '(way["highway"]({bbox}); way["amenity"="parking"]({bbox}););',
    "buildings": 'way["building"]({bbox});',
    "water": (
        '(way["natural"~"^(water|wetland)$"]({bbox}); relation["natural"~"^(water|wetland)$"]({bbox});'
        ' way["waterway"="riverbank"]({bbox}); way["landuse"~"^(reservoir|basin)$"]({bbox});'
        ' relation["landuse"~"^(reservoir|basin)$"]({bbox}););'
    ),
    "protected": (
        '(way["boundary"="protected_area"]({bbox}); relation["boundary"="protected_area"]({bbox});'
        ' way["leisure"="nature_reserve"]({bbox}); relation["leisure"="nature_reserve"]({bbox}););'
    ),
}


def _bbox_latlon(bounds: tuple[float, float, float, float]) -> str:
    tr = Transformer.from_crs(CRS, "EPSG:4326", always_xy=True)
    xmin, ymin, xmax, ymax = bounds
    lon, lat = tr.transform([xmin, xmin, xmax, xmax], [ymin, ymax, ymin, ymax])
    return f"{min(lat):.5f},{min(lon):.5f},{max(lat):.5f},{max(lon):.5f}"


def fetch(layer: str, bounds: tuple[float, float, float, float], dest: Path, mirror: int = 0) -> dict:
    """Run one Overpass query (cached as JSON at ``dest``), starting with mirror number ``mirror``."""
    if not dest.exists():
        q = f"[out:json][timeout:900];{QUERIES[layer].format(bbox=_bbox_latlon(bounds))}out geom;"
        for attempt in range(6):
            url = OVERPASS_URLS[(mirror + attempt) % len(OVERPASS_URLS)]
            print(f"  overpass: {layer} {dest.stem} ({url.split('/')[2]})", flush=True)
            try:
                r = httpx.post(url, data={"data": q}, timeout=1000,
                               headers={"User-Agent": "geoacoustics-research/0.1"})
                r.raise_for_status()
                data = r.json()
                break
            except (httpx.HTTPError, ValueError) as exc:
                print(f"    failed: {exc}", flush=True)
                time.sleep(10 * (attempt + 1))
        else:
            raise RuntimeError(f"Overpass query for {layer} failed")
        if data.get("remark"):
            raise RuntimeError(f"Overpass: {data['remark']}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(".part")
        tmp.write_text(json.dumps(data))
        tmp.rename(dest)  # atomic: an interrupted run never leaves a truncated cache file
    return json.loads(dest.read_text())


TILE_M = 10_000  # fixed UTM grid, so tiles are shared between areas and runs


def fetch_tiled(layer: str, bounds: tuple[float, float, float, float], cache_dir: Path) -> dict:
    """``fetch`` over the 10 km tiles covering ``bounds``, merged; elements on tile edges are deduplicated.

    Uncached tiles are fetched in parallel, one per Overpass mirror.
    """
    from concurrent.futures import ThreadPoolExecutor

    xmin, ymin, xmax, ymax = bounds
    tiles = [(e, n) for e in range(int(xmin // TILE_M), int(np.ceil(xmax / TILE_M)))
             for n in range(int(ymin // TILE_M), int(np.ceil(ymax / TILE_M)))]

    def get(k_tile):
        k, (e, n) = k_tile
        tb = (e * TILE_M, n * TILE_M, (e + 1) * TILE_M, (n + 1) * TILE_M)
        return fetch(layer, tb, cache_dir / layer / f"{e * 10}_{n * 10}.json", mirror=k % len(OVERPASS_URLS))

    with ThreadPoolExecutor(len(OVERPASS_URLS)) as pool:
        results = list(pool.map(get, enumerate(tiles)))
    seen: set[tuple[str, int]] = set()
    elements = []
    for data in results:
        for el in data["elements"]:
            key = (el["type"], el["id"])
            if key not in seen:
                seen.add(key)
                elements.append(el)
    return {"elements": elements}


_TR = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)


def _coords(geom: list[dict]) -> np.ndarray:
    x, y = _TR.transform([p["lon"] for p in geom], [p["lat"] for p in geom])
    return np.column_stack([x, y])


def ways_gdf(data: dict) -> gpd.GeoDataFrame:
    rows, geoms = [], []
    for el in data["elements"]:
        if el["type"] != "way" or "geometry" not in el:
            continue
        tags = el.get("tags", {})
        xy = _coords(el["geometry"])
        closed = len(xy) >= 4 and el["nodes"][0] == el["nodes"][-1]
        is_area = tags.get("amenity") == "parking" or tags.get("area") == "yes" or "building" in tags
        geoms.append(Polygon(xy).buffer(0) if closed and is_area else LineString(xy))
        rows.append({"osm_id": el["id"], **{k: tags.get(k) for k in
                     ("highway", "amenity", "building", "building:levels", "tracktype", "access", "name")}})
    return gpd.GeoDataFrame(rows, geometry=geoms, crs=CRS)


def area_gdf(data: dict) -> gpd.GeoDataFrame:
    """Polygons from closed ways and multipolygon relations (outer rings only)."""
    rows, geoms = [], []
    for el in data["elements"]:
        tags = el.get("tags", {})
        if el["type"] == "way" and "geometry" in el and len(el["geometry"]) >= 4:
            geom = Polygon(_coords(el["geometry"])).buffer(0)
        elif el["type"] == "relation":
            lines = [LineString(_coords(m["geometry"])) for m in el.get("members", [])
                     if m.get("role") == "outer" and m.get("geometry")]
            if not lines:
                continue
            geom = union_all(list(polygonize(lines).geoms))
        else:
            continue
        if geom is None or geom.is_empty:
            continue
        rows.append({"osm_id": el["id"], "name": tags.get("name"),
                     **{k: tags.get(k) for k in ("protect_class", "leisure", "protection_title",
                                                 "natural", "landuse", "waterway")}})
        geoms.append(geom)
    return gpd.GeoDataFrame(rows, geometry=geoms, crs=CRS)
