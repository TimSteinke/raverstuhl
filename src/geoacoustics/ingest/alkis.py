"""Area of interest from ALKIS NAS exports: one bounding box per Gemarkung.

The NAS XML files are only scanned for coordinates; their content isn't used otherwise. Extents
are robust to stray coordinates (a few NAS files contain single far-away points) and are cached,
because scanning takes a few seconds per file.
"""

from __future__ import annotations

import json
import re
import zipfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

_POS = re.compile(rb"<gml:pos(?:List)?[^>]*>([^<]+)<")
MARGIN_M = 100.0


def gemarkung_extent(zip_path: Path) -> list[float]:
    """(xmin, ymin, xmax, ymax) in EPSG:25832, ignoring the outermost 0.01 % of coordinates."""
    with zipfile.ZipFile(zip_path) as z:
        name = next(n for n in z.namelist() if n.endswith(".xml"))
        data = z.read(name)
    vals = np.fromstring(b" ".join(_POS.findall(data)).decode("ascii"), sep=" ")  # noqa: NPY201
    xs = vals[(vals > 2e5) & (vals < 9e5)]
    ys = vals[(vals > 5e6) & (vals < 6e6)]
    lo, hi = 0.01, 99.99
    return [float(np.percentile(xs, lo)) - MARGIN_M, float(np.percentile(ys, lo)) - MARGIN_M,
            float(np.percentile(xs, hi)) + MARGIN_M, float(np.percentile(ys, hi)) + MARGIN_M]


def gemarkung_name(zip_path: Path) -> str:
    m = re.match(r"ALKIS-oE_\d+_(.+)_nas", zip_path.stem)
    return m[1] if m else zip_path.stem


def aoi_boxes(dirs: list[Path], cache: Path, workers: int = 6) -> dict[str, list[float]]:
    """Gemarkung name → bounding box for every ALKIS zip in ``dirs`` (duplicates like 'x (1).zip' skipped)."""
    cached = json.loads(cache.read_text()) if cache.exists() else {}
    zips: dict[str, Path] = {}
    for d in dirs:
        for p in sorted(d.glob("ALKIS-oE_*_nas*.zip")):
            key = p.name.replace(" (1)", "")
            zips.setdefault(key, p)
    todo = {k: p for k, p in zips.items()
            if cached.get(k, {}).get("size") != p.stat().st_size}
    if todo:
        print(f"  scanning {len(todo)} ALKIS files for their extent")
        with ProcessPoolExecutor(workers) as pool:
            for (k, p), ext in zip(todo.items(), pool.map(gemarkung_extent, todo.values()), strict=True):
                cached[k] = {"size": p.stat().st_size, "name": gemarkung_name(p), "bbox": ext}
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(cached, indent=1, ensure_ascii=False))
    return {cached[k]["name"]: cached[k]["bbox"] for k in zips}


_FLST = re.compile(rb"<AX_Flurstueck .*?</AX_Flurstueck>", re.S)
_EXT = re.compile(rb"<gml:exterior>(.*?)</gml:exterior>", re.S)


def gemarkung_shape(zip_path: Path, simplify_m: float = 2.0):
    """Gemarkung outline: union of its parcels' (AX_Flurstueck) outer rings; holes filled."""
    from shapely import Polygon, make_valid, union_all

    with zipfile.ZipFile(zip_path) as z:
        name = next(n for n in z.namelist() if n.endswith(".xml"))
        data = z.read(name)
    polys = []
    for block in _FLST.findall(data):
        for ext in _EXT.findall(block):
            pts = np.fromstring(b" ".join(_POS.findall(ext)).decode("ascii"), sep=" ")  # noqa: NPY201
            if pts.size < 6:
                continue
            xy = pts.reshape(-1, 2)
            keep = np.ones(len(xy), bool)
            keep[1:] = np.any(np.diff(xy, axis=0) != 0, axis=1)  # segments repeat their shared endpoints
            xy = xy[keep]
            if len(xy) >= 3:
                polys.append(make_valid(Polygon(xy)))
    shape = union_all(polys).buffer(0.5).buffer(-0.5)  # close sub-metre slivers between parcels
    return shape.simplify(simplify_m), len(polys)


def gemarkung_shapes(dirs: list[Path], cache_dir: Path, workers: int = 6):
    """GeoDataFrame of Gemarkung outlines for every ALKIS zip in ``dirs`` (cached per file)."""
    import geopandas as gpd

    from geoacoustics.grid import CRS

    zips: dict[str, Path] = {}
    for d in dirs:
        for p in sorted(d.glob("ALKIS-oE_*_nas*.zip")):
            zips.setdefault(p.name.replace(" (1)", ""), p)
    cache_dir.mkdir(parents=True, exist_ok=True)
    todo = {k: p for k, p in zips.items() if not (cache_dir / f"{k}.{p.stat().st_size}.wkb").exists()}
    if todo:
        print(f"  building outlines for {len(todo)} Gemarkungen")
        with ProcessPoolExecutor(workers) as pool:
            for (k, p), (shape, n) in zip(todo.items(), pool.map(gemarkung_shape, todo.values()), strict=True):
                (cache_dir / f"{k}.{p.stat().st_size}.wkb").write_bytes(shape.wkb)
                print(f"    {gemarkung_name(p)}: {n} parcels")
    from shapely import from_wkb

    rows = [{"name": gemarkung_name(p), "file": k, "folder": p.parent.name,
             "geometry": from_wkb((cache_dir / f"{k}.{p.stat().st_size}.wkb").read_bytes())}
            for k, p in zips.items()]
    return gpd.GeoDataFrame(rows, geometry="geometry", crs=CRS)


# The LGL portal's Gemarkungen overlay: vector tiles whose features carry the NAS download file name.
INDEX_TILES = "https://opengeodata.lgl-bw.de/tiles/vts/Gemarkungen/{z}/{x}/{y}.pbf"
DOWNLOAD_BASE = "https://opengeodata.lgl-bw.de"


def portal_index(bounds_lonlat: tuple[float, float, float, float], z: int = 10):
    """Gemarkungen from the portal's index tiles covering ``bounds_lonlat``: name, NAS file, URL, outline."""
    import math

    import geopandas as gpd
    import httpx
    import mapbox_vector_tile
    from shapely import union_all
    from shapely.geometry import shape as to_shape
    from shapely.ops import transform

    from geoacoustics.grid import CRS

    lon0, lat0, lon1, lat1 = bounds_lonlat
    n = 2 ** z

    def tx(lon):
        return int((lon + 180) / 360 * n)

    def ty(lat):
        return int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)

    parts: dict[str, list] = {}
    meta: dict[str, dict] = {}
    with httpx.Client(timeout=60) as client:
        for x in range(tx(lon0), tx(lon1) + 1):
            for y in range(ty(lat1), ty(lat0) + 1):
                r = client.get(INDEX_TILES.format(z=z, x=x, y=y))
                if r.status_code != 200 or not r.content:
                    continue
                layer = mapbox_vector_tile.decode(r.content, default_options={"y_coord_down": True}).get("Gemarkungen")
                if not layer:
                    continue
                ext = layer.get("extent", 4096)

                def to_ll(px, py, *_, x=x, y=y, ext=ext):
                    import numpy as np

                    u = (x + np.asarray(px) / ext) / n
                    v = (y + np.asarray(py) / ext) / n
                    return u * 360 - 180, np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * v))))

                for f in layer["features"]:
                    m = json.loads(f["properties"]["metadata"])
                    nas = next(t for p in m["products"] if p["name"] == "ALKIS" for t in p["types"] if t["type"] == "NAS")
                    key = nas["fileName"]
                    meta[key] = {"name": m["name"], "file": key, "url": DOWNLOAD_BASE + nas["downloadURL"]}
                    parts.setdefault(key, []).append(transform(to_ll, to_shape(f["geometry"])).buffer(0))
    rows = [{**meta[k], "geometry": union_all(v)} for k, v in parts.items()]
    return gpd.GeoDataFrame(rows, geometry="geometry", crs=4326).to_crs(CRS)


def fill_candidates(have, index, min_inside: float = 0.5):
    """Index Gemarkungen not yet present with at least ``min_inside`` of their area inside the convex hull
    of the present ones: this fills enclosed gaps and joins separate parts."""
    hull = have.union_all().convex_hull
    todo = index[~index.file.isin(set(have.file))].copy()
    todo["inside"] = todo.geometry.intersection(hull).area / todo.area
    return todo[todo.inside >= min_inside].sort_values("name")


def download(rows, dest: Path) -> list[Path]:
    """Download the NAS zips of index rows (``file``, ``url``) into ``dest``; existing files are kept."""
    import httpx

    dest.mkdir(parents=True, exist_ok=True)
    out = []
    with httpx.Client(timeout=300, follow_redirects=True) as client:
        for _, r in rows.iterrows():
            path = dest / r.file
            if not path.exists():
                with client.stream("GET", r.url, params={"customerGroup": "keine-angabe"}) as resp:
                    resp.raise_for_status()
                    with path.with_suffix(".part").open("wb") as f:
                        for chunk in resp.iter_bytes(1 << 20):
                            f.write(chunk)
                path.with_suffix(".part").rename(path)
                print(f"  downloaded {r.file} ({path.stat().st_size / 1e6:.1f} MB)")
            out.append(path)
    return out
