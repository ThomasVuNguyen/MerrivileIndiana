"""Benchmark part for the kernel comparison, in build123d.

- 60x40x5 mm plate, 4 x D5 through holes 6 mm in from each corner
- D20 x 15 mm boss at centre with D8 through bore
- 2 mm fillet at boss/plate junction, 0.5 mm chamfer on plate top outer edges
- export STEP, compute volume, intersection volume with copy shifted 10 mm in X

Runs identically under native CPython and under Pyodide (no file-system
assumptions beyond writing one STEP file to the cwd).
"""

import os
import sys
import time

T0 = time.perf_counter()
import build123d as bd  # noqa: E402

T_IMPORT = time.perf_counter() - T0


def rss_mb():
    try:
        import resource

        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    except Exception:
        return float("nan")


def build():
    from build123d import (
        Align,
        Axis,
        Box,
        Cylinder,
        GridLocations,
        Pos,
        Select,
        chamfer,
        fillet,
    )

    plate = Box(60, 40, 5, align=(Align.CENTER, Align.CENTER, Align.MIN))
    # top outer edges chamfer (before holes so only the rectangle edges are selected)
    top_edges = plate.faces().sort_by(Axis.Z)[-1].edges()
    plate = chamfer(top_edges, 0.5)
    holes = [loc * Cylinder(2.5, 5, align=(Align.CENTER, Align.CENTER, Align.MIN)) for loc in GridLocations(48, 28, 2, 2)]
    for h in holes:
        plate -= h
    boss = Pos(0, 0, 5) * Cylinder(10, 15, align=(Align.CENTER, Align.CENTER, Align.MIN))
    part = plate + boss
    # the circle where the boss meets the plate top
    junction = part.edges().filter_by(bd.GeomType.CIRCLE).filter_by(lambda e: abs(e.center().Z - 5) < 1e-6 and abs(e.radius - 10) < 1e-6)
    part = fillet(junction, 2)
    part -= Cylinder(4, 30, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return part


def main(out_dir="."):
    t = time.perf_counter()
    part = build()
    t_build = time.perf_counter() - t

    t = time.perf_counter()
    vol = part.volume
    t_vol = time.perf_counter() - t

    t = time.perf_counter()
    shifted = bd.Pos(10, 0, 0) * part
    inter = part & shifted
    ivol = sum(s.volume for s in inter) if isinstance(inter, (list, tuple)) else inter.volume
    t_inter = time.perf_counter() - t

    t = time.perf_counter()
    step_path = os.path.join(out_dir, "bench_part.step")
    bd.export_step(part, step_path)
    t_step = time.perf_counter() - t
    step_size = os.path.getsize(step_path)

    t = time.perf_counter()
    reimported = bd.import_step(step_path)
    t_step_in = time.perf_counter() - t

    t = time.perf_counter()
    mesh = part.tessellate(0.1, 0.5)
    t_tess = time.perf_counter() - t

    t = time.perf_counter()
    stl_path = os.path.join(out_dir, "bench_part.stl")
    bd.export_stl(part, stl_path)
    t_stl = time.perf_counter() - t

    res = {
        "python": sys.version.split()[0],
        "build123d": bd.__version__,
        "platform": sys.platform,
        "import_s": round(T_IMPORT, 3),
        "build_s": round(t_build, 3),
        "volume_mm3": round(vol, 3),
        "volume_s": round(t_vol, 4),
        "intersect_volume_mm3": round(ivol, 3),
        "intersect_s": round(t_inter, 3),
        "faces": len(part.faces()),
        "edges": len(part.edges()),
        "vertices": len(part.vertices()),
        "valid": part.is_valid() if callable(part.is_valid) else part.is_valid,
        "step_export_s": round(t_step, 3),
        "step_bytes": step_size,
        "step_import_s": round(t_step_in, 3),
        "step_reimport_volume_mm3": round(reimported.volume, 3),
        "tessellate_s": round(t_tess, 3),
        "tess_vertices": len(mesh[0]),
        "tess_triangles": len(mesh[1]),
        "stl_export_s": round(t_stl, 3),
        "stl_bytes": os.path.getsize(stl_path),
        "max_rss_mb": round(rss_mb(), 1),
    }
    return res


if __name__ == "__main__":
    import json

    out = sys.argv[1] if len(sys.argv) > 1 else "."
    print(json.dumps(main(out), indent=2))
