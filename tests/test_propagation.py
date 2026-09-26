import math

import numpy as np

from geoacoustics.acoustics.propagation import BandModel, path_levels


def _run(terrain, canopy, sx, sy, rx, ry, model, res=10.0):
    n = 5000
    out = np.empty(len(model.freqs))
    path_levels(terrain, canopy, 0.0, terrain.shape[0] * res, res, sx, sy, model.hs, rx, ry, model.hr,
                *model.args(), out, np.empty(n), np.empty(n), np.empty(n), np.empty(n, np.int64))
    return out


def _flat(size=400, z=200.0):
    return np.full((size, size), z), np.zeros((size, size))


def test_free_field_spreading_63hz():
    m = BandModel([63], [120.0])
    terrain, canopy = _flat()
    out = _run(terrain, canopy, 1000.0, 2000.0, 1100.0, 2000.0, m)
    direct = math.hypot(100.0, m.hr - m.hs)
    # Agr at 63 Hz is -3 dB (source + receiver regions) when q = 0.
    expected = 120 - (20 * math.log10(direct) + 11) - 0.1 * direct / 1000 + 3.0
    assert abs(out[0] - expected) < 1e-6


def test_6db_per_doubling():
    m = BandModel([63], [120.0])
    terrain, canopy = _flat()
    a = _run(terrain, canopy, 500.0, 2000.0, 1500.0, 2000.0, m)[0]
    b = _run(terrain, canopy, 500.0, 2000.0, 2500.0, 2000.0, m)[0]
    assert 5.8 < a - b < 6.3


def test_ridge_shields_and_bass_diffracts_more():
    m = BandModel([63, 500], [120.0, 120.0], use_kmet=False)
    terrain, canopy = _flat()
    ridge = terrain.copy()
    ridge[:, 195:205] += 30.0  # 30 m ridge halfway between x=1000 and x=3000
    free = _run(terrain, canopy, 1000.0, 2000.0, 3000.0, 2000.0, m)
    shielded = _run(ridge, canopy, 1000.0, 2000.0, 3000.0, 2000.0, m)
    ins = free - shielded
    assert ins[0] > 5.0
    assert shielded[1] < shielded[0]  # total attenuation behind the ridge is larger at 500 Hz
    assert ins[1] <= 20.0 + 3.0 + 1e-9  # capped Dz (single edge) + removed ground gain


def test_kmet_weakens_shielding():
    terrain, canopy = _flat()
    terrain[:, 195:205] += 30.0
    no_met = _run(terrain, canopy, 1000.0, 2000.0, 3000.0, 2000.0, BandModel([63], [120.0], use_kmet=False))
    met = _run(terrain, canopy, 1000.0, 2000.0, 3000.0, 2000.0, BandModel([63], [120.0], use_kmet=True))
    assert met[0] > no_met[0]


def test_foliage_attenuates():
    m = BandModel([125], [120.0])
    terrain, canopy = _flat()
    forest = canopy.copy()
    forest[:, 150:170] = 20.0  # 200 m of 20 m forest
    open_ = _run(terrain, canopy, 1000.0, 2000.0, 2000.0, 2000.0, m)[0]
    wooded = _run(terrain, forest, 1000.0, 2000.0, 2000.0, 2000.0, m)[0]
    assert abs((open_ - wooded) - 200 * 0.03) < 0.5
