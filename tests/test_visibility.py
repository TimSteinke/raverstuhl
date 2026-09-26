import numpy as np

from geoacoustics.visibility import viewshed_min_distance


def _run(dtm, surface, obs_xy, res=10.0, target_h=3.0, max_range=1000.0, skip=0.0):
    return viewshed_min_distance(dtm, surface, 0.0, dtm.shape[0] * res, res,
                                 np.array([obs_xy[0]]), np.array([obs_xy[1]]), 1.5, target_h, max_range, skip)


def test_flat_ground_is_visible_within_range():
    dtm = np.zeros((101, 101))
    d = _run(dtm, dtm.copy(), (505.0, 505.0), max_range=300.0)
    assert np.isfinite(d[50, 60]) and abs(d[50, 60] - 100.0) < 1e-6
    assert np.isinf(d[50, 100])  # beyond max_range


def test_tree_line_blocks_view_but_low_scrub_does_not():
    dtm = np.zeros((101, 101))
    trees = dtm.copy()
    trees[:, 55] = 15.0  # 15 m high forest edge 50 m east of the observer
    d = _run(dtm, trees, (505.0, 505.0))
    assert np.isfinite(d[50, 54])
    assert np.isinf(d[50, 70])
    assert np.isfinite(d[50, 40])  # the other side is open


def test_own_building_is_skipped_near_the_observer():
    dtm = np.zeros((101, 101))
    house = dtm.copy()
    house[49:52, 49:53] = 10.0  # observer stands inside a 10 m house
    assert np.isinf(_run(dtm, house, (505.0, 505.0))[50, 80])
    assert np.isfinite(_run(dtm, house, (505.0, 505.0), skip=25.0)[50, 80])
