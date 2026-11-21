"""Generate the sample actuator used by the concept UI.

Parts are modeled once, at their own origin. The assembly places instances of
them (three planets, fourteen magnets) and says how each instance moves when
the rotor turns. Writes into web/public/models/:

- <part>.stl / <part>.step for every part (viewer + per-part export)
- actuator.step / actuator.stl for the placed assembly
- manifest.json: parts, the assembly tree, the gear train, and fit checks
"""

import json
import math
from itertools import combinations
from pathlib import Path

from build123d import (
    Align,
    Box,
    Compound,
    Cylinder,
    Part,
    PolarLocations,
    Pos,
    Rot,
    export_step,
    export_stl,
)

OUT = Path(__file__).resolve().parent.parent / "web" / "public" / "models"

SUN_T, PLANET_T, RING_T = 14, 15, 36


def tube(od, id_, h):
    return Cylinder(od / 2, h, align=None) - Cylinder(id_ / 2, h, align=None)


def ring_teeth(r, count, w, depth, h, outward=True):
    """A polar array of rectangular teeth sitting on radius r."""
    off = depth / 2 if outward else -depth / 2
    tooth = Box(depth, w, h, align=(Align.CENTER, Align.CENTER, Align.MIN))
    teeth = [loc * Pos(r + off, 0, 0) * tooth for loc in PolarLocations(0, count)]
    out = teeth[0]
    for t in teeth[1:]:
        out += t
    return out


def spur(r, count, h, bore=0.0):
    body = Cylinder(r, h, align=None) + ring_teeth(r, count, 2 * math.pi * r / count * 0.5, 2.0, h)
    if bore:
        body -= Cylinder(bore / 2, h, align=None)
    return body


def bolt_circle(r, count, d, h, angle=0.0):
    holes = [loc * Cylinder(d / 2, h, align=None) for loc in PolarLocations(r, count, start_angle=angle)]
    out = holes[0]
    for hole in holes[1:]:
        out += hole
    return out


# ---------------------------------------------------------------- parts


def housing():
    # Bolt ears sit on the outer wall so nothing intrudes on the rotor.
    body = tube(110, 100, 34) + bolt_circle(57, 8, 10, 34, 22.5)
    return body - bolt_circle(57, 8, 3.4, 34, 22.5)


def rear_cover():
    plate = Cylinder(55, 4, align=None) + bolt_circle(57, 8, 10, 4, 22.5) - Cylinder(6, 4, align=None)
    plate -= bolt_circle(57, 8, 3.4, 4, 22.5)
    return plate - bolt_circle(28, 4, 3, 4, 45)


def stator_core():
    return tube(44, 20, 16) + ring_teeth(22, 12, 6, 20, 16, outward=True)


def rotor_can():
    cap = Pos(0, 0, 22) * (Cylinder(49, 2.5, align=None) - Cylinder(8, 2.5, align=None))
    return tube(98, 92, 22) + cap


def magnet():
    return Box(2.5, 10, 14)


def sun_gear():
    return spur(9, SUN_T, 9, bore=5)


def planet():
    return spur(9.5, PLANET_T, 8, bore=4)


def ring_gear():
    return tube(100, 66, 10) + ring_teeth(33, RING_T, 2.6, 2.2, 10, outward=False)


def carrier():
    plate = Cylinder(30, 3, align=None) - Cylinder(5, 3, align=None)
    return plate - bolt_circle(21, 3, 4, 3)


def bearing():
    rollers = None
    for i, loc in enumerate(PolarLocations(40.5, 24)):
        r = loc * Pos(0, 0, 3.5) * Rot(0, 90 if i % 2 else 0, 45) * Cylinder(2.4, 4.8)
        rollers = r if rollers is None else rollers + r
    return tube(100, 84, 7) + tube(78, 62, 7) + rollers


def output_flange():
    boss = Cylinder(31, 7, align=None) - Cylinder(25, 7, align=None)
    disk = Pos(0, 0, 7) * (Cylinder(39, 5, align=None) - Cylinder(6, 5, align=None))
    disk -= Pos(0, 0, 7) * bolt_circle(31, 6, 3.4, 5)
    disk -= Pos(0, 0, 7) * bolt_circle(16, 6, 2.6, 5, 30)
    return boss + disk


def encoder_board():
    pcb = Box(34, 28, 1.6, align=(Align.CENTER, Align.CENTER, Align.MIN))  # centered in XY, sitting on Z=0
    chip = Pos(0, 0, 1.6) * Box(5, 5, 1, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return pcb + chip


def encoder_magnet():
    return Cylinder(3, 2.5, align=None)


# id, name, builder, color, material, density g/cm3
PARTS = [
    ("housing", "Housing", housing, "#b9bcc2", "Al 6061-T6", 2.70),
    ("rear-cover", "Rear cover", rear_cover, "#9ea2a8", "Al 6061-T6", 2.70),
    ("stator-core", "Stator core", stator_core, "#6d7178", "M19 laminations", 7.65),
    ("rotor-can", "Rotor can", rotor_can, "#3f444b", "1018 steel", 7.87),
    ("magnet", "Magnet", magnet, "#c8a24a", "N52 NdFeB", 7.50),
    ("sun-gear", "Sun gear", sun_gear, "#d26b3f", "PA12 (MJF)", 1.01),
    ("planet", "Planet gear", planet, "#e08a55", "PA12 (MJF)", 1.01),
    ("ring-gear", "Ring gear", ring_gear, "#8a8f96", "PA12 (MJF)", 1.01),
    ("carrier", "Carrier plate", carrier, "#5a6068", "Al 7075", 2.81),
    ("bearing", "Crossed roller bearing", bearing, "#c4c7cc", "52100 steel", 7.81),
    ("output-flange", "Output flange", output_flange, "#2f6fd6", "Al 7075", 2.81),
    ("encoder-board", "Encoder board", encoder_board, "#2f8a4c", "FR-4", 1.85),
    ("encoder-magnet", "Encoder magnet", encoder_magnet, "#c8a24a", "N35 NdFeB", 7.50),
]


# ---------------------------------------------------------------- assembly

# How an instance moves when the rotor turns:
#   fixed   - grounded to the housing
#   rotor   - turns with the rotor (input)
#   carrier - turns with the planet carrier (output, input / ratio)
#   planet  - orbits with the carrier and spins about its own axis


def inst(part, x=0.0, y=0.0, z=0.0, rot=0.0, motion="fixed", n=1):
    return {"id": f"{part}-{n}", "part": part, "pos": [round(x, 3), round(y, 3), z], "rot": rot, "motion": motion}


def ring_of(part, count, r, z, motion, phase=0.0):
    out = []
    for i in range(count):
        a = phase + 360 / count * i
        out.append(
            inst(part, r * math.cos(math.radians(a)), r * math.sin(math.radians(a)), z, a, motion, i + 1)
        )
    return out


GROUPS = [
    ("Housing", [inst("housing"), inst("rear-cover", z=-4)]),
    ("Stator", [inst("stator-core", z=6)]),
    (
        "Rotor",
        [inst("rotor-can", z=4, motion="rotor"), *ring_of("magnet", 14, 44.45, 16, "rotor"), inst("sun-gear", z=28.5, motion="rotor")],
    ),
    ("Gearbox", [inst("ring-gear", z=28.5), *ring_of("planet", 3, 21, 29, "planet"), inst("carrier", z=37.5, motion="carrier")]),
    ("Output", [inst("bearing", z=40.5), inst("output-flange", z=40.5, motion="carrier")]),
    ("Encoders", [inst("encoder-board", z=-10.6), inst("encoder-magnet", z=-7.5, motion="rotor")]),
]


def slug(name):
    return "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-").replace("--", "-")


def placed(shape, i):
    x, y, z = i["pos"]
    return Pos(x, y, z) * Rot(0, 0, i["rot"]) * shape


def overlaps(a, b):
    ba, bb = a.bounding_box(), b.bounding_box()
    lo_a, hi_a, lo_b, hi_b = (tuple(v) for v in (ba.min, ba.max, bb.min, bb.max))
    return all(lo_a[k] < hi_b[k] and lo_b[k] < hi_a[k] for k in range(3))


def fit_checks(shapes, instances):
    """Pairwise interference between placed instances, at the rest pose."""
    world = {i["id"]: placed(shapes[i["part"]], i) for i in instances}
    results = []
    for a, b in combinations(instances, 2):
        sa, sb = world[a["id"]], world[b["id"]]
        if not overlaps(sa, sb):
            continue
        common = sa & sb
        vol = common.volume if common is not None else 0.0
        if vol > 0.01:
            c = common.bounding_box().center()
            # The overlap itself, so the viewer can show exactly what collides.
            mesh = f"clash-{len(results) + 1}"
            export_stl(common, str(OUT / f"{mesh}.stl"), tolerance=0.01, angular_tolerance=0.1)
            results.append(
                {
                    "a": a["id"],
                    "b": b["id"],
                    "volume_mm3": round(vol, 2),
                    "at": [round(c.X, 1), round(c.Y, 1), round(c.Z, 1)],
                    "mesh": mesh,
                }
            )
    return results


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    instances = [i for _, group in GROUPS for i in group]
    qty = {pid: sum(1 for i in instances if i["part"] == pid) for pid, *_ in PARTS}

    parts, shapes = [], {}
    for pid, name, build, color, material, density in PARTS:
        shape = build()
        if not isinstance(shape, Part):
            shape = Part(shape.wrapped)
        shape.label = name
        shapes[pid] = shape
        export_stl(shape, str(OUT / f"{pid}.stl"), tolerance=0.02, angular_tolerance=0.15)
        export_step(shape, str(OUT / f"{pid}.step"))
        bb = shape.bounding_box()
        vol = shape.volume
        parts.append(
            {
                "id": pid,
                "name": name,
                "color": color,
                "material": material,
                "qty": qty[pid],
                "volume_mm3": round(vol, 1),
                "mass_g": round(vol / 1000 * density, 1),
                "bbox": [round(v, 1) for v in (bb.size.X, bb.size.Y, bb.size.Z)],
                "faces": len(shape.faces()),
                "fn": build.__name__,
            }
        )
        print(f"{name:24s} ×{qty[pid]:<3d} {len(shape.faces()):4d} faces  {vol / 1000:7.1f} cm3")

    world = []
    for i in instances:
        s = placed(shapes[i["part"]], i)
        s.label = i["id"]
        world.append(s)
    asm = Compound(children=world, label="QDD Actuator 110")
    export_stl(asm, str(OUT / "actuator.stl"), tolerance=0.02, angular_tolerance=0.15)
    export_step(asm, str(OUT / "actuator.step"))

    checks = fit_checks(shapes, instances)
    print(f"{len(checks)} interferences")
    for c in checks:
        print(f"  {c['a']:16s} × {c['b']:16s} {c['volume_mm3']:8.2f} mm3")

    manifest = {
        "name": "QDD Actuator 110",
        "parts": parts,
        "groups": [{"name": n, "instances": g} for n, g in GROUPS],
        "gears": {"sun": SUN_T, "planet": PLANET_T, "ring": RING_T},
        "checks": {"pose_deg": 0, "interferences": checks},
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    extras()


def bracket():
    base = Box(60, 30, 5, align=None)
    wall = Box(5, 30, 40, align=None)
    rib = Pos(5, 13, 5) * Box(25, 4, 25, align=None)
    body = base + wall + rib
    body -= Pos(40, 15, 0) * Cylinder(3.3, 5, align=None)
    body -= Pos(0, 15, 28) * Rot(0, 90, 0) * Cylinder(3.3, 5, align=None)
    return body


def desk_clamp():
    c = Box(14, 30, 70, align=None) + Pos(0, 0, 60) * Box(60, 30, 10, align=None)
    c += Box(60, 30, 10, align=None)
    c -= Pos(45, 15, 0) * Cylinder(4.2, 10, align=None)
    return c


def enclosure():
    shell = Box(80, 55, 28, align=None) - Pos(2.5, 2.5, 2.5) * Box(75, 50, 26, align=None)
    shell -= Pos(0, 27.5, 14) * Rot(0, 90, 0) * Cylinder(5, 3, align=None)
    return shell


def extras():
    for name, build in [("bracket", bracket), ("desk-clamp", desk_clamp), ("enclosure", enclosure)]:
        shape = build()
        export_stl(shape, str(OUT / f"x-{name}.stl"), tolerance=0.02, angular_tolerance=0.15)
        export_step(shape, str(OUT / f"x-{name}.step"))


if __name__ == "__main__":
    main()
