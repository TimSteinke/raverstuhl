"""Download 2 km tiles from the LGL BW open-data portal (opengeodata.lgl-bw.de).

Tiles are named by their south-west corner in km (EPSG:25832), e.g. ``dgm1_32_397_5328_2_bw.zip``
covers E 397–399 km, N 5328–5330 km. Easting corners are odd, northing corners even. Tiles outside
Baden-Württemberg return 404.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import httpx

BASE_URL = "https://opengeodata.lgl-bw.de/data"
TILE_SIZE_KM = 2

# product -> (url subdirectory, file name template)
PRODUCTS: dict[str, tuple[str, str]] = {
    "dgm1": ("dgm", "dgm1_32_{e}_{n}_2_bw.zip"),
    "dom1": ("dom1", "dom1_32_{e}_{n}_2_bw.zip"),
    "lod2": ("lod2", "LoD2_32_{e}_{n}_2_bw.zip"),
}


@dataclass(frozen=True)
class Tile:
    e_km: int
    n_km: int

    def filename(self, product: str) -> str:
        return PRODUCTS[product][1].format(e=self.e_km, n=self.n_km)

    def url(self, product: str) -> str:
        return f"{BASE_URL}/{PRODUCTS[product][0]}/{self.filename(product)}"


def tile_corner(e_m: float, n_m: float) -> Tile:
    """Tile containing the point (e_m, n_m) in EPSG:25832 metres."""
    e_km, n_km = e_m / 1000, n_m / 1000
    e0 = 2 * math.floor((e_km - 1) / TILE_SIZE_KM) + 1
    n0 = 2 * math.floor(n_km / TILE_SIZE_KM)
    return Tile(e0, n0)


def tiles_for_boxes(boxes_m: Iterable[tuple[float, float, float, float]]) -> list[Tile]:
    """All tiles intersecting any of the (emin, nmin, emax, nmax) boxes, sorted."""
    tiles: set[Tile] = set()
    for emin, nmin, emax, nmax in boxes_m:
        lo, hi = tile_corner(emin, nmin), tile_corner(emax, nmax)
        for e in range(lo.e_km, hi.e_km + 1, TILE_SIZE_KM):
            for n in range(lo.n_km, hi.n_km + 1, TILE_SIZE_KM):
                tiles.add(Tile(e, n))
    return sorted(tiles, key=lambda t: (t.e_km, t.n_km))


_TILE_NAME = re.compile(r"^(dgm1|dom1|LoD2)_32_(\d+)_(\d+)_2_bw\.zip$")
_PRODUCT_OF = {"dgm1": "dgm1", "dom1": "dom1", "LoD2": "lod2"}


def find_tiles(dirs: Iterable[Path], product: str) -> dict[Tile, Path]:
    """Tiles of ``product`` present in any of ``dirs`` (first directory wins on duplicates)."""
    found: dict[Tile, Path] = {}
    for d in dirs:
        if not d.exists():
            continue
        for p in sorted(d.iterdir()):
            m = _TILE_NAME.match(p.name)
            if m and _PRODUCT_OF[m[1]] == product:
                found.setdefault(Tile(int(m[2]), int(m[3])), p)
    return found


def _download(client: httpx.Client, url: str, dest: Path) -> str:
    part = dest.with_suffix(dest.suffix + ".part")
    with client.stream("GET", url) as r:
        if r.status_code == 404:
            return "missing"
        r.raise_for_status()
        with part.open("wb") as f:
            for chunk in r.iter_bytes(1 << 20):
                f.write(chunk)
    part.rename(dest)
    return "downloaded"


def download_tiles(
    tiles: Iterable[Tile], products: Iterable[str], dest_dir: Path, search_dirs: Iterable[Path] = (),
    workers: int = 8,
) -> dict[str, list[str]]:
    """Download tiles that aren't in ``dest_dir`` or ``search_dirs`` yet. Returns file names by status."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    tiles = list(tiles)
    dirs = [dest_dir, *search_dirs]
    status: dict[str, list[str]] = {"present": [], "downloaded": [], "missing": [], "failed": []}
    # Tiles the portal doesn't have (outside BW) are remembered, so reruns don't ask again.
    missing_log = dest_dir / "_missing.txt"
    known_missing = set(missing_log.read_text().split()) if missing_log.exists() else set()
    todo = []
    for p in products:
        have = find_tiles(dirs, p)
        for t in tiles:
            if t in have:
                status["present"].append(t.filename(p))
            elif t.filename(p) in known_missing:
                status["missing"].append(t.filename(p))
            else:
                todo.append((t.url(p), dest_dir / t.filename(p)))

    transport = httpx.HTTPTransport(retries=3)
    with httpx.Client(transport=transport, timeout=120, follow_redirects=True) as client:

        def run(job: tuple[str, Path]) -> tuple[str, str]:
            url, dest = job
            try:
                return dest.name, _download(client, url, dest)
            except httpx.HTTPError as exc:
                return dest.name, f"failed: {exc}"

        with ThreadPoolExecutor(workers) as pool:
            for i, (name, result) in enumerate(pool.map(run, todo)):
                key = "failed" if result.startswith("failed") else result
                status[key].append(name)
                print(f"  [{i + 1}/{len(todo)}] {result:>10}  {name}", flush=True)
    missing_log.write_text("\n".join(sorted(known_missing | set(status["missing"]))) + "\n")
    return status
