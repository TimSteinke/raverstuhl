"""Regular north-up raster grids in the working CRS, plus GeoTIFF I/O helpers."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from affine import Affine

CRS = "EPSG:25832"


@dataclass(frozen=True)
class Grid:
    """``shape = (rows, cols)``. Row 0 is the northern edge; cell (r, c) centre is ``xy(r, c)``."""

    xmin: float
    ymax: float
    res: float
    rows: int
    cols: int

    @classmethod
    def from_bounds(cls, xmin: float, ymin: float, xmax: float, ymax: float, res: float) -> Grid:
        return cls(xmin, ymax, res, round((ymax - ymin) / res), round((xmax - xmin) / res))

    @property
    def shape(self) -> tuple[int, int]:
        return self.rows, self.cols

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        return self.xmin, self.ymax - self.rows * self.res, self.xmin + self.cols * self.res, self.ymax

    @property
    def transform(self) -> Affine:
        return Affine(self.res, 0, self.xmin, 0, -self.res, self.ymax)

    def xy(self, r, c):
        return self.xmin + (np.asarray(c) + 0.5) * self.res, self.ymax - (np.asarray(r) + 0.5) * self.res

    def rc(self, x, y):
        """Fractional (row, col) of points; cell centres are at integer values."""
        return (self.ymax - np.asarray(y)) / self.res - 0.5, (np.asarray(x) - self.xmin) / self.res - 0.5

    def centres(self) -> tuple[np.ndarray, np.ndarray]:
        r, c = np.mgrid[0 : self.rows, 0 : self.cols]
        return self.xy(r, c)


def write_tif(path: Path, grid: Grid, data: np.ndarray, nodata: float | None = np.nan) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    predictor = 3 if np.issubdtype(data.dtype, np.floating) else 2
    with rasterio.open(
        path, "w", driver="GTiff", width=grid.cols, height=grid.rows, count=1, dtype=data.dtype,
        crs=CRS, transform=grid.transform, nodata=nodata, compress="deflate", predictor=predictor,
        tiled=True, blockxsize=512, blockysize=512, BIGTIFF="IF_SAFER",
    ) as dst:
        dst.write(data, 1)


def read_tif(path: Path) -> tuple[Grid, np.ndarray]:
    with rasterio.open(path) as src:
        t = src.transform
        grid = Grid(t.c, t.f, t.a, src.height, src.width)
        return grid, src.read(1)
