"""LoD2 CityGML buildings → receiver points with estimated night-time occupants.

Building function codes follow the ALKIS Gebäudefunktion catalogue (``31001_<code>``).
"""

from __future__ import annotations

import zipfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from lxml import etree
from shapely import Polygon, union_all

from geoacoustics.grid import CRS

NS = {
    "bldg": "http://www.opengis.net/citygml/building/1.0",
    "gml": "http://www.opengis.net/gml",
    "core": "http://www.opengis.net/citygml/1.0",
}
BLDG = f"{{{NS['bldg']}}}Building"

# Residential floor area per person (m², Germany ≈ 47) and gross-to-net floor area factor.
M2_PER_PERSON = 47.0
NET_FACTOR = 0.8
STOREY_HEIGHT_M = 3.0


def night_weight(code: int) -> tuple[str, float]:
    """(category, weight): how much a person in this building type counts between midnight and noon."""
    if code == 1313:  # Gartenhaus
        return "none", 0.0
    if code in (1311, 1312):  # Wochenend-/Ferienhaus
        return "residential", 0.5
    if 1000 <= code < 2000:
        return "residential", 1.0
    if 2070 <= code < 2080:  # hotels, hostels, campsite buildings
        return "lodging", 1.0
    if 3050 <= code < 3070:  # hospitals, care homes
        return "care", 1.0
    if 2400 <= code < 2500 or 2700 <= code < 3000:  # transport/parking, agricultural sheds and barns
        return "none", 0.0
    if 2000 <= code < 4000:
        return "work", 0.15
    return "unknown", 0.3


def _parse_building(el) -> dict | None:
    func = el.findtext("bldg:function", namespaces=NS)
    code = int(func.split("_")[-1]) if func and "_" in func else 9998
    heights = [float(h) for h in el.xpath(".//bldg:measuredHeight/text()", namespaces=NS)]
    polys = []
    for pl in el.xpath(".//bldg:GroundSurface//gml:posList/text()", namespaces=NS):
        xyz = np.array(pl.split(), float).reshape(-1, 3)
        if len(xyz) >= 4:
            polys.append(Polygon(xyz[:, :2]).buffer(0))
    if not polys:
        return None
    foot = union_all(polys)
    c = foot.centroid
    return {
        "id": el.get(f"{{{NS['gml']}}}id"),
        "function": code,
        "height_m": max(heights) if heights else np.nan,
        "area_m2": foot.area,
        "x": c.x,
        "y": c.y,
    }


def _parse_zip(path: Path) -> list[dict]:
    rows = []
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if not name.endswith(".gml"):
                continue
            with z.open(name) as f:
                for _, el in etree.iterparse(f, events=("end",), tag=BLDG, huge_tree=True):
                    if el.getparent().tag.endswith("cityObjectMember"):
                        row = _parse_building(el)
                        if row:
                            rows.append(row)
                        el.clear()
    return rows


def load_lod2(zips: list[Path], workers: int = 8) -> gpd.GeoDataFrame:
    with ProcessPoolExecutor(workers) as pool:
        rows = [r for rs in pool.map(_parse_zip, zips) for r in rs]
    df = pd.DataFrame(rows).drop_duplicates("id")
    return add_occupants(gpd.GeoDataFrame(df, geometry=gpd.points_from_xy(df.x, df.y), crs=CRS))


def add_occupants(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    cat_w = gdf["function"].map(night_weight)
    gdf["category"] = [c for c, _ in cat_w]
    gdf["weight"] = [w for _, w in cat_w]
    storeys = np.clip(np.round((gdf["height_m"].fillna(4.0) - 1.0) / STOREY_HEIGHT_M), 1, 30)
    gdf["occupants"] = gdf["area_m2"] * storeys * NET_FACTOR / M2_PER_PERSON
    gdf.loc[gdf["area_m2"] < 20, "weight"] = 0.0
    gdf["people_eq"] = gdf["occupants"] * gdf["weight"]
    return gdf
