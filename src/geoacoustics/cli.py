"""Command-line entry point: ``geoacoustics build configs/<area>.yaml [stage ...]``."""

from __future__ import annotations

import argparse
import time


def cmd_build(args: argparse.Namespace) -> None:
    from geoacoustics import pipeline, webexport

    stages = {**pipeline.STAGES, "export_web": webexport.stage_export_web}
    unknown = set(args.stages) - set(stages)
    if unknown:
        raise SystemExit(f"unknown stage(s) {sorted(unknown)}; choose from {list(stages)}")
    ctx = pipeline.Ctx.load(args.config)
    names = args.stages or list(stages)
    if args.start_from:
        names = names[names.index(args.start_from):]
    t0 = time.time()
    for name in names:
        print(f"=== {name}", flush=True)
        stages[name](ctx)
    print(f"=== done in {(time.time() - t0) / 60:.1f} min")


def cmd_alkis_fill(args: argparse.Namespace) -> None:
    """Finds Gemarkungen that fill gaps in an area's ALKIS coverage and downloads them."""
    from geoacoustics import pipeline
    from geoacoustics.ingest import alkis

    ctx = pipeline.Ctx.load(args.config)
    dirs = [ctx.root / d for d in ctx.cfg["aoi"]["alkis_dirs"] if (ctx.root / d).exists()]
    have = alkis.gemarkung_shapes(dirs, ctx.root / "data/interim/alkis_shapes")
    index = alkis.portal_index(tuple(have.to_crs(4326).total_bounds))
    todo = alkis.fill_candidates(have, index, args.min_inside)
    for _, r in todo.iterrows():
        print(f"  {r['name']:24s} {r.geometry.area / 1e6:5.1f} km²  {r.inside * 100:4.0f} % inside")
    if args.dry_run or todo.empty:
        print(f"{len(todo)} Gemarkungen would be added" if len(todo) else "no gaps to fill")
        return
    dest = ctx.root / args.dest
    alkis.download(todo, dest)
    if args.dest not in ctx.cfg["aoi"]["alkis_dirs"]:
        print(f"note: add '{args.dest}' to aoi.alkis_dirs in {args.config}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="geoacoustics")
    sub = parser.add_subparsers(required=True)
    p = sub.add_parser("build", help="build an area: download tiles, run the pipeline, export the web data")
    p.add_argument("config", help="configs/<area>.yaml")
    p.add_argument("stages", nargs="*", help="only these stages (default: all, in order)")
    p.add_argument("--from", dest="start_from", metavar="STAGE", help="resume from this stage")
    p.set_defaults(func=cmd_build)
    p = sub.add_parser("alkis-fill", help="download ALKIS Gemarkungen that fill gaps in an area's coverage")
    p.add_argument("config")
    p.add_argument("--dest", default="data/raw/alkis", help="download folder (default: data/raw/alkis)")
    p.add_argument("--min-inside", type=float, default=0.5,
                   help="share of a Gemarkung inside the coverage's convex hull to count as a gap (default 0.5)")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_alkis_fill)
    args = parser.parse_args()
    args.func(args)
