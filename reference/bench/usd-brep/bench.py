"""Benchmark part on NVIDIA SMLib via the usd-brep 1.0.2 PyPI wheel (native x86_64, not WASM).
Run with a venv that has `pip install usd-brep` (Python 3.12 only)."""
import time, os, math
t0 = time.perf_counter()
import usd_brep as ub
t_import = time.perf_counter() - t0
OUT = os.path.dirname(os.path.abspath(__file__))

def edge_near(brep, pt):
    idx, _ = ub.find_edge(brep, pt)
    return brep.edges()[idx]

def build(with_chamfer=True, with_fillet=True):
    plate = ub.create_box((0, 0, 0), 60, 40, 5)
    if with_chamfer:
        top = [edge_near(plate, p) for p in [(30, 0, 5), (60, 20, 5), (30, 40, 5), (0, 20, 5)]]
        # xsect_type=0: linear cross-section; at a 90-degree edge the setback equals radius -> 0.5 mm equal-distance chamfer
        ub.fillet_edges(plate, top, radius=0.5, xsect_type=0)
    boss = ub.create_cylinder((30, 20, 5), 10, 15)
    part = ub.boolean_union(plate, boss)
    if with_fillet:
        junction = edge_near(part, (40, 20, 5))
        ub.fillet_edges(part, [junction], radius=2.0, xsect_type=1)
    for (x, y) in [(6, 6), (54, 6), (6, 34), (54, 34)]:
        part = ub.boolean_difference(part, ub.create_cylinder((x, y, 0), 2.5, 5))
    part = ub.boolean_difference(part, ub.create_cylinder((30, 20, 0), 4, 20))
    return part

def run(label, **kw):
    try:
        t1 = time.perf_counter()
        part = build(**kw)
        vol = ub.compute_volume(part, 1e-6)
        t_build = time.perf_counter() - t1
        t2 = time.perf_counter()
        shifted = ub.brep_copy(part); ub.translate(shifted, (10, 0, 0))
        inter = ub.boolean_intersection(ub.brep_copy(part), shifted)
        ivol = ub.compute_volume(inter, 1e-6)
        t_inter = time.perf_counter() - t2
        print(f"{label}: build {t_build*1000:.1f} ms, volume {vol:.4f} mm^3, intersection {ivol:.4f} mm^3 ({t_inter*1000:.1f} ms), faces {part.face_count()} edges {part.edge_count()} manifold {ub.is_manifold_solid(part)}")
        return part
    except Exception as e:
        print(f"{label}: FAILED: {type(e).__name__}: {e}")
        return None

print(f"import usd_brep: {t_import*1000:.1f} ms")
part = run("full (chamfer+fillet)") or run("no fillet", with_fillet=False) or run("plain", with_fillet=False, with_chamfer=False)
if part is not None:
    t = time.perf_counter()
    poly = ub.tessellate(part, chord_height_tolerance=0.01, surface_angle_tolerance_deg=15)
    dt = (time.perf_counter()-t)*1000
    arrays = poly.to_mesh_arrays()
    try:
        desc = {k: (len(v) if hasattr(v, '__len__') else v) for k, v in (arrays.items() if isinstance(arrays, dict) else enumerate(arrays))}
    except Exception as e:
        desc = repr(arrays)[:300]
    print(f"tessellate: {dt:.1f} ms; polyfaces {len(poly.get_faces())} (one per B-rep face -> face IDs) ; mesh arrays {desc}")
    print("to_mesh_arrays doc:", (poly.to_mesh_arrays.__doc__ or '').strip()[:500])
    t = time.perf_counter()
    part.write_to_file(os.path.join(OUT, 'bench_smlib.smb'))
    print(f".smb native write ({(time.perf_counter()-t)*1000:.1f} ms)")
    t = time.perf_counter()
    try:
        ub.usd.export_brep(part, os.path.join(OUT, 'bench_smlib.usda'))
        print(f"USD export ({(time.perf_counter()-t)*1000:.1f} ms), size {os.path.getsize(os.path.join(OUT,'bench_smlib.usda'))} bytes")
    except Exception as e:
        print("USD export failed:", e)
    print("STEP export: not available in usd-brep (no STEP writer in the package; only USD/.smb, OCCT converter tools are separate C++ tools)")
print(f"total wall {(time.perf_counter()-t0)*1000:.1f} ms")
