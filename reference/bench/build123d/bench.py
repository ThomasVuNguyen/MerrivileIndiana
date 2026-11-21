"""Baseline benchmark part in build123d 0.13 (native OCCT via OCP)."""
import time, sys, os
t0 = time.perf_counter()
from build123d import *
t_import = time.perf_counter() - t0

OUT = os.path.dirname(os.path.abspath(__file__))

def build(with_fillet=True, with_chamfer=True):
    plate = Box(60, 40, 5, align=(Align.CENTER, Align.CENTER, Align.MIN))
    if with_chamfer:
        top_outer = plate.edges().filter_by(Axis.Z, reverse=True).group_by(Axis.Z)[-1]
        plate = chamfer(top_outer, 0.5)
    boss = Pos(0, 0, 5) * Cylinder(10, 15, align=(Align.CENTER, Align.CENTER, Align.MIN))  # z=5..20, on top of plate
    part = plate + boss
    if with_fillet:
        # fillet the boss/plate junction edge: circular edge at z=5 with radius 10
        junction = part.edges().filter_by(GeomType.CIRCLE).filter_by(lambda e: abs(e.radius - 10) < 1e-6 and abs(e.center().Z - 5) < 1e-6)
        part = fillet(junction, 2)
    holes = [Pos(x, y, 0) * Cylinder(2.5, 5, align=(Align.CENTER, Align.CENTER, Align.MIN)) for x in (-24, 24) for y in (-14, 14)]
    for h in holes:
        part = part - h
    part = part - Cylinder(4, 20, align=(Align.CENTER, Align.CENTER, Align.MIN))  # bore through plate+boss
    return part

t1 = time.perf_counter()
part = build()
t_build = time.perf_counter() - t1
print(f"import time: {t_import*1000:.1f} ms")
print(f"build time: {t_build*1000:.1f} ms")
print(f"volume: {part.volume:.4f} mm^3")
print(f"faces: {len(part.faces())} edges: {len(part.edges())} solids: {len(part.solids())}")
print(f"valid: {part.is_valid}")

t2 = time.perf_counter()
shifted = Pos(10, 0, 0) * part
inter = part & shifted
t_inter = time.perf_counter() - t2
print(f"intersection volume (shift 10mm X): {inter.volume:.4f} mm^3  ({t_inter*1000:.1f} ms)")

# also a no-fillet / no-chamfer variant for comparing with mesh kernels
plain = build(with_fillet=False, with_chamfer=False)
print(f"plain (no fillet/chamfer) volume: {plain.volume:.4f} mm^3")
pinter = plain & (Pos(10, 0, 0) * plain)
print(f"plain intersection volume: {pinter.volume:.4f} mm^3")
# analytic check for plain: plate - 4 holes + boss (15 mm on top of plate) - D8 bore through plate+boss (20 mm)
import math
analytic = 60*40*5 - 4*math.pi*2.5**2*5 + math.pi*100*15 - math.pi*16*20
print(f"plain analytic volume: {analytic:.4f}")

t3 = time.perf_counter()
export_step(part, os.path.join(OUT, "bench_build123d.step"))
t_step = time.perf_counter() - t3
t4 = time.perf_counter()
export_stl(part, os.path.join(OUT, "bench_build123d.stl"))
t_stl = time.perf_counter() - t4
print(f"STEP export: {t_step*1000:.1f} ms  STL export: {t_stl*1000:.1f} ms")
# tessellate
t5 = time.perf_counter()
verts, tris = part.tessellate(0.01, 0.2)
print(f"tessellate: {len(verts)} verts {len(tris)} tris ({(time.perf_counter()-t5)*1000:.1f} ms)")
print(f"total wall: {(time.perf_counter()-t0)*1000:.1f} ms")
