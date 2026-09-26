"""Terrain and surface rasters: LGL DGM1/DOM1 tiles → 2 m and 10 m grids; Copernicus GLO-30 as fallback.

The LGL zips each hold four 1 km sub-tiles: DGM1 as ``.xyz`` point lists (cell centres at .5 m),
DOM1 as GeoTIFFs. We never unpack them to disk; each 1 km sub-tile is aggregated straight to
the coarser working grids.
"""

from __future__ import annotations

import re
import zipfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import Resampling, reproject

from geoacoustics.grid import CRS, Grid

_SUBTILE = re.compile(r"(dgm1|dom1)_32_(\d+)_(\d+)_1_bw_\d{4}\.(xyz|tif)$")
KM = 1000


def _read_dgm_xyz(data: bytes, e_km: int, n_km: int) -> np.ndarray:
    xyz = np.fromstring(data.decode("ascii"), sep=" ").reshape(-1, 3)
    out = np.full((KM, KM), np.nan, np.float32)
    col = np.floor(xyz[:, 0] - e_km * KM).astype(int)
    row = np.floor((n_km + 1) * KM - xyz[:, 1]).astype(int)
    out[row, col] = xyz[:, 2]
    return out


def _read_dom_tif(zip_path: Path, member: str, e_km: int, n_km: int) -> np.ndarray:
    """1 km × 1 km DOM array; tiles at the state border can be smaller and are padded with NaN."""
    out = np.full((KM, KM), np.nan, np.float32)
    with rasterio.open(f"/vsizip/{zip_path}/{member}") as src:
        assert src.transform.a == 1.0
        a = src.read(1).astype(np.float32)
        a[a == src.nodata] = np.nan
        r0 = round((n_km + 1) * KM - src.bounds.top)
        c0 = round(src.bounds.left - e_km * KM)
        out[r0 : r0 + a.shape[0], c0 : c0 + a.shape[1]] = a
    return out


def _subtiles(zip_path: Path) -> dict[tuple[int, int], str]:
    out = {}
    with zipfile.ZipFile(zip_path) as z:
        for name in z.namelist():
            m = _SUBTILE.search(name)
            if m:
                out[(int(m[2]), int(m[3]))] = name
    return out


def _block(a: np.ndarray, k: int) -> np.ndarray:
    """View a (n*k, m*k) array as (n, m, k*k) blocks."""
    n, m = a.shape[0] // k, a.shape[1] // k
    return a.reshape(n, k, m, k).transpose(0, 2, 1, 3).reshape(n, m, k * k)


def _process_dgm_zip(args: tuple[Path, Path | None]) -> list[tuple[int, int, dict[str, np.ndarray]]]:
    dgm_zip, dom_zip = args
    dom_members = _subtiles(dom_zip) if dom_zip else {}
    results = []
    with zipfile.ZipFile(dgm_zip) as z:
        for (e, n), member in _subtiles(dgm_zip).items():
            dtm = _read_dgm_xyz(z.read(member), e, n)
            if (e, n) in dom_members:
                ndsm = np.clip(_read_dom_tif(dom_zip, dom_members[(e, n)], e, n) - dtm, 0, None)
            else:
                ndsm = np.full_like(dtm, np.nan)
            with np.errstate(all="ignore"):
                layers = {
                    "dtm_2m": np.nanmean(_block(dtm, 2), axis=2),
                    "ndsm_2m": np.nanmax(_block(ndsm, 2), axis=2),
                    "dtm_10m": np.nanmean(_block(dtm, 10), axis=2),
                    # Upper-canopy height per 10 m cell, for foliage attenuation.
                    "canopy_10m": np.nanpercentile(_block(ndsm, 10), 90, axis=2),
                }
            results.append((e, n, {k: v.astype(np.float32) for k, v in layers.items()}))
    return results


def build_lgl_rasters(
    dgm: dict, dom: dict, grid2: Grid, grid10: Grid, workers: int = 8
) -> dict[str, np.ndarray]:
    """Mosaic LGL DGM1/DOM1 tiles ({Tile: zip path}) into 2 m and 10 m arrays (NaN where no data)."""
    grids = {"dtm_2m": grid2, "ndsm_2m": grid2, "dtm_10m": grid10, "canopy_10m": grid10}
    out = {k: np.full(g.shape, np.nan, np.float32) for k, g in grids.items()}
    jobs = [(p, dom.get(t)) for t, p in sorted(dgm.items(), key=lambda kv: (kv[0].e_km, kv[0].n_km))]
    zips = jobs
    with ProcessPoolExecutor(workers) as pool:
        for i, results in enumerate(pool.map(_process_dgm_zip, jobs)):
            for e, n, layers in results:
                for key, a in layers.items():
                    g = grids[key]
                    r0 = round((g.ymax - (n + 1) * KM) / g.res)
                    c0 = round((e * KM - g.xmin) / g.res)
                    if 0 <= r0 and r0 + a.shape[0] <= g.rows and 0 <= c0 and c0 + a.shape[1] <= g.cols:
                        out[key][r0 : r0 + a.shape[0], c0 : c0 + a.shape[1]] = a
            print(f"  terrain {i + 1}/{len(zips)}", end="\r", flush=True)
    print()
    return out


GLO30_URL = (
    "https://copernicus-dem-30m.s3.amazonaws.com/"
    "Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM/Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM.tif"
)


def download_glo30(grid: Grid, dest_dir: Path) -> list[Path]:
    """Fetch the 1°×1° Copernicus GLO-30 tiles covering ``grid`` (northern/eastern hemisphere only)."""
    import httpx
    from pyproj import Transformer

    tr = Transformer.from_crs(CRS, "EPSG:4326", always_xy=True)
    xmin, ymin, xmax, ymax = grid.bounds
    lons, lats = tr.transform([xmin, xmin, xmax, xmax], [ymin, ymax, ymin, ymax])
    dest_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for lat in range(int(np.floor(min(lats))), int(np.floor(max(lats))) + 1):
        for lon in range(int(np.floor(min(lons))), int(np.floor(max(lons))) + 1):
            url = GLO30_URL.format(lat=lat, lon=lon)
            path = dest_dir / url.rsplit("/", 1)[1]
            if not path.exists():
                print(f"  downloading {path.name}")
                with httpx.stream("GET", url, timeout=300, follow_redirects=True) as r:
                    r.raise_for_status()
                    with path.with_suffix(".part").open("wb") as f:
                        for chunk in r.iter_bytes(1 << 20):
                            f.write(chunk)
                path.with_suffix(".part").rename(path)
            paths.append(path)
    return paths


def resample_to_grid(paths: list[Path], grid: Grid) -> np.ndarray:
    """Bilinear resample of (possibly several) rasters onto ``grid``; later files fill gaps."""
    out = np.full(grid.shape, np.nan, np.float32)
    for p in paths:
        tmp = np.full(grid.shape, np.nan, np.float32)
        with rasterio.open(p) as src:
            reproject(
                rasterio.band(src, 1), tmp, dst_transform=grid.transform, dst_crs=CRS,
                dst_nodata=np.nan, resampling=Resampling.bilinear,
            )
        out = np.where(np.isnan(out), tmp, out)
    return out
