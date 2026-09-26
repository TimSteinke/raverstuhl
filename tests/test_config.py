from geoacoustics.pipeline import Ctx, _merge


def test_merge_is_deep_and_overrides():
    base = {"a": 1, "b": {"x": 1, "y": 2}}
    assert _merge(base, {"b": {"y": 3}, "c": 4}) == {"a": 1, "b": {"x": 1, "y": 3}, "c": 4}
    assert base == {"a": 1, "b": {"x": 1, "y": 2}}


def test_area_config_loads_over_defaults(tmp_path):
    cfg_dir = tmp_path / "configs"
    cfg_dir.mkdir()
    (cfg_dir / "defaults.yaml").write_text("data:\n  work_dir: data/interim/{name}\nscoring: {w: 1}\n")
    (cfg_dir / "x.yaml").write_text("name: x\naoi: {boxes: {a: [0, 0, 1, 1]}}\nscoring: {w: 2}\n")
    ctx = Ctx.load(str(cfg_dir / "x.yaml"))
    assert ctx.cfg["scoring"]["w"] == 2
    assert ctx.path("work_dir") == tmp_path / "data/interim/x"
    assert ctx.aoi_boxes == {"a": [0, 0, 1, 1]}
