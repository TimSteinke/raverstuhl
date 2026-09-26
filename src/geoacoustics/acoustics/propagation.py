"""Octave-band outdoor propagation over terrain, following ISO 9613-2 (engineering method).

Per source–receiver pair and octave band::

    Lp = Lw − Adiv − Aatm − max(Agr, Dz) − Afol

* Adiv: spherical spreading, 20·log10(d) + 11.
* Aatm: air absorption, α(f)·d.
* Agr:  ground effect (ISO 9613-2 Table 3, source/middle/receiver regions).
* Dz:   diffraction over terrain. The diffraction path is the upper convex hull of the terrain
        profile between source and receiver (a stretched string), which handles single and multiple
        edges. ISO combines barrier and ground as Agr + Abar = Dz, capped at 20 dB (single edge) or
        25 dB (multiple edges).
* Kmet: ISO's meteorological correction, which weakens terrain shielding over long paths. It
        models downwind/inversion conditions, so the result is a night-time worst case.
* Afol: foliage attenuation (ISO 9613-2 Annex A) for the part of the path that runs through canopy.

This is a screening model: no reflections, no lateral diffraction, no explicit sound-speed profile.
"""

from __future__ import annotations

import math

import numba as nb
import numpy as np

SPEED_OF_SOUND = 340.0

# ISO 9613-2 Annex A, Table A.1 (dB for 10–20 m of foliage, dB/m for 20–200 m). 31.5 Hz extrapolated.
FOLIAGE = {31.5: (0.0, 0.01), 63: (0.0, 0.02), 125: (0.0, 0.03), 250: (1.0, 0.04),
           500: (1.0, 0.05), 1000: (1.0, 0.06), 2000: (2.0, 0.08), 4000: (3.0, 0.09)}
# ISO 9613-1 air absorption at 10 °C, 70 % RH (dB/km). 31.5 Hz extrapolated.
AIR_ABSORPTION = {31.5: 0.03, 63: 0.1, 125: 0.4, 250: 1.0, 500: 1.9, 1000: 3.7, 2000: 9.7, 4000: 32.8}


@nb.njit(cache=True, inline="always")
def _bilinear(z, x0, y0, res, x, y):
    fc = (x - x0) / res - 0.5
    fr = (y0 - y) / res - 0.5
    r = int(math.floor(fr))
    c = int(math.floor(fc))
    if r < 0 or c < 0 or r + 1 >= z.shape[0] or c + 1 >= z.shape[1]:
        return np.nan
    dr = fr - r
    dc = fc - c
    return ((z[r, c] * (1 - dc) + z[r, c + 1] * dc) * (1 - dr)
            + (z[r + 1, c] * (1 - dc) + z[r + 1, c + 1] * dc) * dr)


@nb.njit(cache=True)
def _ground_region(band_idx_iso, h, dp, G):
    """ISO 9613-2 Table 3 for the source or receiver region."""
    e50 = 1.0 - math.exp(-dp / 50.0)
    if band_idx_iso <= 1:  # 31.5, 63 Hz
        return -1.5
    if band_idx_iso == 2:  # 125 Hz: a'
        a = 1.5 + 3.0 * math.exp(-0.12 * (h - 5.0) ** 2) * e50 + 5.7 * math.exp(-0.09 * h * h) * (
            1.0 - math.exp(-2.8e-6 * dp * dp))
        return -1.5 + G * a
    if band_idx_iso == 3:  # 250 Hz: b'
        return -1.5 + G * (1.5 + 8.6 * math.exp(-0.09 * h * h) * e50)
    if band_idx_iso == 4:  # 500 Hz: c'
        return -1.5 + G * (1.5 + 14.0 * math.exp(-0.46 * h * h) * e50)
    if band_idx_iso == 5:  # 1 kHz: d'
        return -1.5 + G * (1.5 + 5.0 * math.exp(-0.9 * h * h) * e50)
    return -1.5 * (1.0 - G)


@nb.njit(cache=True)
def _ground(band_idx_iso, hs, hr, dp, Gs, Gm, Gr):
    q = 0.0
    if dp > 30.0 * (hs + hr):
        q = 1.0 - 30.0 * (hs + hr) / dp
    am = -3.0 * q if band_idx_iso <= 1 else -3.0 * q * (1.0 - Gm)
    return _ground_region(band_idx_iso, hs, dp, Gs) + _ground_region(band_idx_iso, hr, dp, Gr) + am


@nb.njit(cache=True)
def path_levels(
    terrain, canopy, x0, y0, res, sx, sy, hs, rx, ry, hr, freqs, iso_idx, lw, alpha_db_km,
    fol_fixed, fol_per_m, ground_g, use_kmet, step_m, out, tmp_t, tmp_z, tmp_c, hull,
):
    """Band levels at receiver (rx, ry) from a source at (sx, sy); written to ``out``. Returns distance."""
    dx = rx - sx
    dy = ry - sy
    d2d = math.sqrt(dx * dx + dy * dy)
    gs = _bilinear(terrain, x0, y0, res, sx, sy)
    gr = _bilinear(terrain, x0, y0, res, rx, ry)
    if math.isnan(gs) or math.isnan(gr):
        for b in range(out.shape[0]):
            out[b] = np.nan
        return d2d
    zs = gs + hs
    zr = gr + hr
    d2d = max(d2d, 1.0)
    n = min(max(int(d2d / step_m), 2), tmp_t.shape[0] - 1)

    # Terrain profile: t = horizontal distance from source, z = ground, c = canopy height.
    for i in range(n + 1):
        f = i / n
        tmp_t[i] = f * d2d
        if i == 0:
            tmp_z[i] = zs
        elif i == n:
            tmp_z[i] = zr
        else:
            g = _bilinear(terrain, x0, y0, res, sx + f * dx, sy + f * dy)
            tmp_z[i] = zs + f * (zr - zs) if math.isnan(g) else g
        cz = _bilinear(canopy, x0, y0, res, sx + f * dx, sy + f * dy)
        tmp_c[i] = 0.0 if math.isnan(cz) else cz

    # Upper convex hull (monotone chain) = shortest path over the terrain.
    k = 0
    for i in range(n + 1):
        while k >= 2:
            o = hull[k - 2]
            a = hull[k - 1]
            cross = (tmp_t[a] - tmp_t[o]) * (tmp_z[i] - tmp_z[o]) - (tmp_z[a] - tmp_z[o]) * (tmp_t[i] - tmp_t[o])
            if cross >= 0.0:
                k -= 1
            else:
                break
        hull[k] = i
        k += 1

    direct = math.sqrt(d2d * d2d + (zr - zs) ** 2)
    path = 0.0
    for j in range(k - 1):
        a = hull[j]
        b = hull[j + 1]
        path += math.sqrt((tmp_t[b] - tmp_t[a]) ** 2 + (tmp_z[b] - tmp_z[a]) ** 2)
    z_diff = path - direct
    n_edges = k - 2
    dss = 0.0
    dsr = 0.0
    e = 0.0
    if n_edges >= 1:
        a = hull[1]
        b = hull[k - 2]
        dss = math.sqrt(tmp_t[a] ** 2 + (tmp_z[a] - zs) ** 2)
        dsr = math.sqrt((d2d - tmp_t[b]) ** 2 + (zr - tmp_z[b]) ** 2)
        e = max(path - dss - dsr, 0.0)

    # Length of the (hull) path inside canopy taller than 3 m.
    fol_len = 0.0
    j = 0
    for i in range(1, n):
        while hull[j + 1] < i:
            j += 1
        a = hull[j]
        b = hull[j + 1]
        w = (tmp_t[i] - tmp_t[a]) / max(tmp_t[b] - tmp_t[a], 1e-9)
        hp = tmp_z[a] + w * (tmp_z[b] - tmp_z[a])
        if tmp_c[i] > 3.0 and hp < tmp_z[i] + tmp_c[i]:
            fol_len += d2d / n
    fol_len = min(fol_len, 200.0)

    adiv = 20.0 * math.log10(direct) + 11.0
    kmet = 1.0
    if use_kmet and z_diff > 0.0 and n_edges >= 1:
        kmet = math.exp(-(1.0 / 2000.0) * math.sqrt(dss * dsr * direct / (2.0 * z_diff)))
    for bi in range(freqs.shape[0]):
        lam = SPEED_OF_SOUND / freqs[bi]
        agr = _ground(iso_idx[bi], hs, hr, d2d, ground_g[0], ground_g[1], ground_g[2])
        att = agr
        if n_edges >= 1 and z_diff > 0.0:
            c3 = 1.0
            if n_edges >= 2 and e > 0.0:
                r = (5.0 * lam / e) ** 2
                c3 = (1.0 + r) / (1.0 / 3.0 + r)
            dz = 10.0 * math.log10(3.0 + (20.0 / lam) * c3 * z_diff * kmet)
            dz = min(dz, 20.0 if n_edges == 1 else 25.0)
            att = max(agr, dz)
        afol = 0.0
        if fol_len >= 20.0:
            afol = fol_len * fol_per_m[bi]
        elif fol_len >= 10.0:
            afol = fol_fixed[bi]
        out[bi] = lw[bi] - adiv - alpha_db_km[bi] * direct / 1000.0 - att - afol
    return d2d


@nb.njit(parallel=True, cache=True)
def exposure_matrix_scores(
    terrain, canopy, x0, y0, res, src_x, src_y, hs, rec_x, rec_y, rec_w, rec_rmin, rec_rmax, hr, freqs, iso_idx, lw,
    alpha_db_km, fol_fixed, fol_per_m, ground_g, use_kmet, step_m, max_range_m, thresholds,
    faint_db, annoying_db,
):
    """Per source: annoyance cost, people-eq. above threshold, and worst receiver excess (dB).

    exposure(E) = 0 for E ≤ faint_db, rising linearly to 1 at annoying_db, where E is the band
    level above threshold, maximised over bands. cost = Σ receiver weight × exposure.
    Receiver r is only used for sources at distance rec_rmin[r] ≤ d < rec_rmax[r] (level-of-detail).
    """
    ns = src_x.shape[0]
    nb_ = freqs.shape[0]
    cost = np.zeros(ns)
    audible = np.zeros(ns)
    worst = np.full(ns, -99.0)
    max_n = int(max_range_m / step_m) + 4
    r2max = max_range_m * max_range_m
    for s in nb.prange(ns):
        tmp_t = np.empty(max_n)
        tmp_z = np.empty(max_n)
        tmp_c = np.empty(max_n)
        hull = np.empty(max_n, np.int64)
        lp = np.empty(nb_)
        c_sum = 0.0
        a_sum = 0.0
        w_max = -99.0
        for r in range(rec_x.shape[0]):
            ddx = rec_x[r] - src_x[s]
            ddy = rec_y[r] - src_y[s]
            dd2 = ddx * ddx + ddy * ddy
            if dd2 > r2max or dd2 < rec_rmin[r] ** 2 or dd2 >= rec_rmax[r] ** 2:
                continue
            path_levels(terrain, canopy, x0, y0, res, src_x[s], src_y[s], hs, rec_x[r], rec_y[r], hr,
                        freqs, iso_idx, lw, alpha_db_km, fol_fixed, fol_per_m, ground_g, use_kmet,
                        step_m, lp, tmp_t, tmp_z, tmp_c, hull)
            ex = -99.0
            for b in range(nb_):
                if not math.isnan(lp[b]):
                    ex = max(ex, lp[b] - thresholds[b])
            if ex > 0.0:
                a_sum += rec_w[r]
            w_max = max(w_max, ex)
            if ex > faint_db:
                c_sum += rec_w[r] * min((ex - faint_db) / (annoying_db - faint_db), 1.0)
        cost[s] = c_sum
        audible[s] = a_sum
        worst[s] = w_max
    return cost, audible, worst


@nb.njit(parallel=True, cache=True)
def level_map(
    terrain, canopy, x0, y0, res, sx, sy, hs, rec_x, rec_y, hr, freqs, iso_idx, lw, alpha_db_km,
    fol_fixed, fol_per_m, ground_g, use_kmet, step_m, max_range_m,
):
    """Band levels (n_receivers, n_bands) for one source, e.g. to draw a noise map on grid points."""
    nr = rec_x.shape[0]
    out = np.full((nr, freqs.shape[0]), np.nan)
    max_n = int(max_range_m / step_m) + 4
    for r in nb.prange(nr):
        if (rec_x[r] - sx) ** 2 + (rec_y[r] - sy) ** 2 > max_range_m ** 2:
            continue
        tmp_t = np.empty(max_n)
        tmp_z = np.empty(max_n)
        tmp_c = np.empty(max_n)
        hull = np.empty(max_n, np.int64)
        lp = np.empty(freqs.shape[0])
        path_levels(terrain, canopy, x0, y0, res, sx, sy, hs, rec_x[r], rec_y[r], hr, freqs, iso_idx,
                    lw, alpha_db_km, fol_fixed, fol_per_m, ground_g, use_kmet, step_m, lp, tmp_t,
                    tmp_z, tmp_c, hull)
        out[r] = lp
    return out


ISO_BANDS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000]


class BandModel:
    """Band-dependent constants packed as arrays for the numba kernels."""

    def __init__(self, freqs: list[float], lw_db: list[float], ground_g=(1.0, 1.0, 0.5),
                 use_kmet: bool = True, step_m: float = 10.0, source_h_m: float = 1.5,
                 receiver_h_m: float = 4.0):
        self.freqs = np.array(freqs, float)
        self.iso_idx = np.array([ISO_BANDS.index(f) for f in freqs], np.int64)
        self.lw = np.array(lw_db, float)
        self.alpha = np.array([AIR_ABSORPTION[f] for f in freqs], float)
        self.fol_fixed = np.array([FOLIAGE[f][0] for f in freqs], float)
        self.fol_per_m = np.array([FOLIAGE[f][1] for f in freqs], float)
        self.ground_g = np.array(ground_g, float)
        self.use_kmet = use_kmet
        self.step_m = step_m
        self.hs = source_h_m
        self.hr = receiver_h_m

    def args(self):
        return (self.freqs, self.iso_idx, self.lw, self.alpha, self.fol_fixed, self.fol_per_m,
                self.ground_g, self.use_kmet, self.step_m)
