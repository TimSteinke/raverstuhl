"""Visibility: radial line-of-sight sweeps over terrain plus tall obstacles.

Observers sit on sample points along roads or at homes. The blocking surface is the DTM plus the nDSM wherever
the nDSM exceeds ``min_obstacle_m`` (trees, buildings; low scrub and crops don't block). A cell
counts as visible when a target ``target_h_m`` above the bare ground clears the running horizon
angle of the ray.
"""

from __future__ import annotations

import math

import numba as nb
import numpy as np
from shapely import LineString, MultiLineString


@nb.njit(parallel=True, cache=True)
def viewshed_min_distance(dtm, surface, x0, y0, res, obs_x, obs_y, obs_h, target_h, max_range_m,
                          skip_obstacles_m=0.0):
    """Per cell: distance (m) to the nearest observer that can see it; inf where unseen.

    Within ``skip_obstacles_m`` of the observer only the bare terrain blocks the view (so an observer
    at a window isn't blinded by their own house).

    Observers run in parallel and share the output. Two threads writing the same cell at the same
    moment can lose the smaller distance; that is rare and harmless for a screening heuristic.
    """
    rows, cols = dtm.shape
    out = np.full((rows, cols), np.inf, np.float32)
    n_rays = int(2.0 * math.pi * max_range_m / res) + 1
    n_steps = int(max_range_m / res)
    for o in nb.prange(obs_x.shape[0]):
        fr = (y0 - obs_y[o]) / res - 0.5
        fc = (obs_x[o] - x0) / res - 0.5
        r0 = int(round(fr))
        c0 = int(round(fc))
        if r0 < 0 or c0 < 0 or r0 >= rows or c0 >= cols or math.isnan(dtm[r0, c0]):
            continue
        eye = dtm[r0, c0] + obs_h
        for k in range(n_rays):
            a = 2.0 * math.pi * k / n_rays
            dr = -math.sin(a)
            dc = math.cos(a)
            horizon = -1e9
            for s in range(1, n_steps + 1):
                r = int(round(fr + dr * s))
                c = int(round(fc + dc * s))
                if r < 0 or c < 0 or r >= rows or c >= cols:
                    break
                g = dtm[r, c]
                if math.isnan(g):
                    break
                d = s * res
                t_ang = (g + target_h - eye) / d
                if t_ang >= horizon and d < out[r, c]:
                    out[r, c] = d
                o_ang = ((g if d < skip_obstacles_m else surface[r, c]) - eye) / d
                if o_ang > horizon:
                    horizon = o_ang
    return out


def sample_lines(geoms, spacing_m: float) -> np.ndarray:
    """Points every ``spacing_m`` along (multi)line geometries, as an (n, 2) array."""
    pts = []
    for geom in geoms:
        parts = geom.geoms if isinstance(geom, MultiLineString) else [geom]
        for line in parts:
            if not isinstance(line, LineString) or line.length == 0:
                continue
            d = np.arange(0, line.length + 1e-9, spacing_m)
            pts.extend((p.x, p.y) for p in line.interpolate(d))
    return np.array(pts, float).reshape(-1, 2)
