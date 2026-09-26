from geoacoustics.ingest.lgl import Tile, tile_corner, tiles_for_boxes


def test_tile_corner_matches_lgl_naming():
    assert tile_corner(397_000, 5_328_000) == Tile(397, 5328)
    assert tile_corner(398_999, 5_329_999) == Tile(397, 5328)
    assert tile_corner(399_000, 5_330_000) == Tile(399, 5330)


def test_tile_url():
    t = Tile(399, 5330)
    assert t.url("dom1") == "https://opengeodata.lgl-bw.de/data/dom1/dom1_32_399_5330_2_bw.zip"
    assert t.url("dgm1") == "https://opengeodata.lgl-bw.de/data/dgm/dgm1_32_399_5330_2_bw.zip"
    assert t.url("lod2") == "https://opengeodata.lgl-bw.de/data/lod2/LoD2_32_399_5330_2_bw.zip"


def test_tiles_for_boxes_union():
    tiles = tiles_for_boxes([(397_500, 5_328_500, 400_500, 5_329_500), (397_100, 5_328_100, 397_200, 5_328_200)])
    assert tiles == [Tile(397, 5328), Tile(399, 5328)]


def test_find_tiles_across_dirs(tmp_path):
    from geoacoustics.ingest.lgl import find_tiles

    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    b.mkdir()
    (a / "dgm1_32_397_5328_2_bw.zip").touch()
    (b / "dgm1_32_397_5328_2_bw.zip").touch()
    (b / "dgm1_32_399_5328_2_bw.zip").touch()
    (b / "LoD2_32_399_5328_2_bw.zip").touch()
    (b / "LoD2_32_399_5328_2_bw (1).zip").touch()  # browser duplicate: ignored
    dgm = find_tiles([a, b], "dgm1")
    assert dgm == {Tile(397, 5328): a / "dgm1_32_397_5328_2_bw.zip", Tile(399, 5328): b / "dgm1_32_399_5328_2_bw.zip"}
    assert list(find_tiles([a, b], "lod2")) == [Tile(399, 5328)]
