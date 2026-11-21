"""Probe ocp-tessellate output on the benchmark part, and bd_warehouse parts."""

import json
import sys
import time

sys.path.insert(0, "/home/thomas/Development/MerrivileIndiana/reference/bench/native")
import bench_part  # noqa: E402

part = bench_part.build()
part.label = "bench_part"
part.color = (0.9, 0.7, 0.1)

t = time.perf_counter()
from ocp_tessellate.convert import tessellate_group, to_ocpgroup  # noqa: E402

t_imp = time.perf_counter() - t

t = time.perf_counter()
group, instances = to_ocpgroup(part)
meshed, shapes, mapping = tessellate_group(group, instances)
t_tess = time.perf_counter() - t


def summarize(o, depth=0):
    if isinstance(o, dict):
        return {k: summarize(v, depth + 1) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        if o and isinstance(o[0], (int, float)):
            return f"<{type(o).__name__} len={len(o)}>"
        return [summarize(x, depth + 1) for x in o[:3]] + ([f"... +{len(o)-3}"] if len(o) > 3 else [])
    if hasattr(o, "shape") and hasattr(o, "dtype"):
        return f"<ndarray {o.shape} {o.dtype}>"
    return o


print("import ocp_tessellate: %.2fs, tessellate: %.3fs" % (t_imp, t_tess))
print("shapes keys:", list(shapes.keys()))
print("shapes tree:", json.dumps(summarize(shapes), indent=1, default=str)[:3000])
print("meshed instances:", len(meshed))
m0 = meshed[0]
print("instance keys:", list(m0.keys()) if isinstance(m0, dict) else type(m0))
print("instance summary:", json.dumps(summarize(m0), indent=1, default=str)[:2500])
print("mapping:", json.dumps(summarize(mapping), default=str)[:600])

# --- bd_warehouse ---
t = time.perf_counter()
from bd_warehouse.fastener import SocketHeadCapScrew, HexNut  # noqa: E402
from bd_warehouse.gear import SpurGear  # noqa: E402
from bd_warehouse.bearing import SingleRowDeepGrooveBallBearing  # noqa: E402
from bd_warehouse.thread import IsoThread  # noqa: E402

print("import bd_warehouse: %.2fs" % (time.perf_counter() - t))
for name, fn in [
    ("M4x12 SHCS", lambda: SocketHeadCapScrew(size="M4-0.7", length=12, simple=True)),
    ("M4x12 SHCS threaded", lambda: SocketHeadCapScrew(size="M4-0.7", length=12, simple=False)),
    ("M4 hex nut", lambda: HexNut(size="M4-0.7")),
    ("SpurGear m1 z20", lambda: SpurGear(module=1, tooth_count=20, thickness=5, pressure_angle=20)),
    ("608 bearing", lambda: SingleRowDeepGrooveBallBearing(size="M8-22-7")),
    ("IsoThread M8", lambda: IsoThread(major_diameter=8, pitch=1.25, length=10)),
]:
    t = time.perf_counter()
    try:
        obj = fn()
        dt = time.perf_counter() - t
        print(f"  {name:22} ok  {dt:6.2f}s faces={len(obj.faces())} volume={obj.volume:.1f}")
    except Exception as e:
        print(f"  {name:22} FAIL {time.perf_counter()-t:6.2f}s {type(e).__name__}: {str(e)[:160]}")
