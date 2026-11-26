"""Datums: named planes, axes, points and hole patterns that assemblies snap together.

A part script publishes them next to `result`:

    datums = {"seat": Plane((0, 0, 4), z_dir=(0, 0, 1)), "optical_axis": Axis((0, 0, 0), (0, 0, 1)),
              "m2_holes": [Vector(-10, -10, 0), Vector(10, -10, 0), Vector(10, 10, 0), Vector(-10, 10, 0)]}

They're serialised at full precision as plain dicts (the Worker stores them on the part):

    plane   {"kind": "plane", "origin": [x, y, z], "normal": [x, y, z], "x": [x, y, z]}
    axis    {"kind": "axis", "origin": [...], "direction": [...]}
    point   {"kind": "point", "at": [...]}
    pattern {"kind": "pattern", "points": [[...], ...], "normal": [...], "diameter"?: mm}

Plane normals point out of the material (like face normals): two planes snap face to face.
Imported vendor models (components) get suggested datums: hole patterns in the board plane, the
largest flat face and bores.
"""

from __future__ import annotations

import math

import numpy as np

FLOAT_TOL = 1e-3  # mm: a plane further than this from every flat face, or a pattern point from every hole axis, floats


class Pattern:
    """A hole pattern for a part's datums: points plus one normal (default: fitted to the points)."""

    def __init__(self, points, normal=None, diameter: float | None = None):
        self.points = [_vec(p) for p in points]
        self.normal = None if normal is None else _unit(_vec(normal))
        self.diameter = diameter


def serialise(datums, shape=None) -> tuple[dict, list[str]]:
    """{name: datum dict} from a script's `datums`, and warnings (bad entries, floating datums)."""
    if datums is None:
        return {}, []
    if not isinstance(datums, dict):
        raise TypeError(f"`datums` must be a dict of name → Plane/Axis/Vector/[Vector, …], not {type(datums).__name__}.")
    out, warnings = {}, []
    for name, value in datums.items():
        name = str(name)
        if not _good_name(name):
            raise ValueError(f"Datum name {name!r}: use letters, digits, _, - and . (no slashes or spaces), up to 60 characters.")
        out[name] = to_datum(value, name)
    if shape is not None:
        warnings += floating(out, shape)
    return out, warnings


def to_datum(value, name: str = "datum") -> dict:
    """One datum dict from a build123d Plane, Axis, Location, Vector, point tuple, list of points,
    Pattern, planar or cylindrical Face, or circular Edge."""
    from build123d import Axis, Edge, Face, GeomType, Location, Plane, Vector

    if isinstance(value, dict) and value.get("kind") in ("plane", "axis", "point", "pattern"):
        return _clean(value)
    if isinstance(value, Plane):
        return {"kind": "plane", "origin": _xyz(value.origin), "normal": _xyz(value.z_dir), "x": _xyz(value.x_dir)}
    if isinstance(value, Location):
        p = Plane(value)
        return {"kind": "plane", "origin": _xyz(p.origin), "normal": _xyz(p.z_dir), "x": _xyz(p.x_dir)}
    if isinstance(value, Axis):
        return {"kind": "axis", "origin": _xyz(value.position), "direction": _xyz(value.direction)}
    if isinstance(value, Pattern):
        return _pattern(value.points, value.normal, value.diameter, name)
    if isinstance(value, Face):
        if value.geom_type == GeomType.PLANE:
            p = Plane(value)
            return {"kind": "plane", "origin": _xyz(value.center()), "normal": _xyz(value.normal_at()), "x": _xyz(p.x_dir)}
        if value.geom_type in (GeomType.CYLINDER, GeomType.CONE):
            o, d, _ = _cylinder(value)
            return {"kind": "axis", "origin": list(map(float, o)), "direction": list(map(float, d))}
        raise ValueError(f"Datum {name!r}: only planar and cylindrical faces make datums, not {value.geom_type}.")
    if isinstance(value, Edge):
        if value.geom_type == GeomType.CIRCLE:
            return {"kind": "axis", "origin": _xyz(value.arc_center), "direction": _xyz(value.normal())}
        raise ValueError(f"Datum {name!r}: only circular edges make axis datums.")
    if isinstance(value, Vector):
        return {"kind": "point", "at": _xyz(value)}
    if isinstance(value, (list, tuple)):
        if len(value) == 3 and all(isinstance(x, (int, float)) for x in value):
            return {"kind": "point", "at": [float(x) for x in value]}
        if len(value) >= 2:
            return _pattern([_vec(p) for p in value], None, None, name)
    raise TypeError(f"Datum {name!r} is a {type(value).__name__}; use Plane, Axis, Vector or a list of Vectors (a hole pattern).")


def floating(datums: dict, shape) -> list[str]:
    """Planes that lie in no flat face of the shape, and pattern points on no hole axis."""
    from build123d import GeomType

    out = []
    flats = None
    axes = None
    for name, d in datums.items():
        if d["kind"] == "plane":
            if flats is None:
                flats = [(_np(f.center()), _unit(_np(f.normal_at()))) for f in shape.faces() if f.geom_type == GeomType.PLANE]
            o, n = np.array(d["origin"]), _unit(np.array(d["normal"]))
            parallel = [abs(float((o - c) @ fn)) for c, fn in flats if abs(abs(float(fn @ n)) - 1) < 1e-9]
            if not parallel or min(parallel) > FLOAT_TOL:
                where = f"the nearest parallel face is {min(parallel):.4g} mm away" if parallel else "no flat face is parallel to it"
                out.append(f"Datum {name!r} floats: its plane is in no flat face of the part ({where}). Snaps to it work, but check it's where you meant.")
        elif d["kind"] == "pattern":
            axes = axes if axes is not None else [_cylinder(f)[:2] for f in shape.faces() if _is_cyl(f)]
            off = [i + 1 for i, p in enumerate(d["points"]) if not any(_line_gap(np.array(p), o, a) <= FLOAT_TOL for o, a in axes)]
            if off:
                out.append(f"Datum {name!r} floats: point{'s' if len(off) > 1 else ''} {', '.join(map(str, off))} of {len(d['points'])} {'are' if len(off) > 1 else 'is'} on no hole axis (within {FLOAT_TOL} mm).")
    return out


def suggest(shape) -> tuple[dict, list[dict]]:
    """Datums for an imported model: its base face, hole patterns in that plane, and bores.

    Returns ({name: datum with a "note"}, holes) where holes are [{diameter, at, direction}] in the base plane.
    """
    from build123d import GeomType

    faces = shape.faces()
    planes = [f for f in faces if f.geom_type == GeomType.PLANE]
    if not planes:
        return {}, []
    bb = shape.bounding_box(optimal=False)
    centre = np.array([bb.center().X, bb.center().Y, bb.center().Z])
    biggest = max(f.area for f in planes)
    # Of the biggest flat faces (a board has two), the one with the body behind it: the mounting side.
    big = [f for f in planes if f.area >= biggest * 0.98]
    base = min(big, key=lambda f: float((centre - _np(f.center())) @ _np(f.normal_at())))
    n = _unit(_np(base.normal_at()))
    origin = _np(base.center())
    x = _principal(base, n)
    out: dict = {
        "base": {"kind": "plane", "origin": _list(origin), "normal": _list(n), "x": _list(x), "note": f"largest flat face ({base.area:.1f} mm²), normal out of the part"},
    }

    # Holes: concave cylinders, merged when coaxial (OpenCASCADE often splits one hole in two faces).
    holes: list[dict] = []
    for f in faces:
        if not _is_cyl(f):
            continue
        o, d, r = _cylinder(f)
        if not _concave(f, o, d):
            continue
        span = _span(f)
        for h in holes:
            if abs(h["r"] - r) < 1e-4 and abs(abs(h["d"] @ d) - 1) < 1e-9 and _line_gap(h["o"], o, d) < 1e-4:
                h["span"] += span
                break
        else:
            holes.append({"o": o, "d": d, "r": r, "span": span})
    round_holes = [h for h in holes if h["span"] >= math.radians(300)]
    plane_holes = [h for h in round_holes if abs(abs(h["d"] @ n) - 1) < 1e-4]
    groups: dict[float, list] = {}
    for h in plane_holes:
        groups.setdefault(round(2 * h["r"], 3), []).append(h)
    y = np.cross(n, x)
    for dia, hs in sorted(groups.items(), key=lambda kv: -kv[0]):
        if len(hs) < 2:
            continue
        pts = [_on_plane(h["o"], h["d"], origin, n) for h in hs]
        pts.sort(key=lambda p: (round(float((p - origin) @ x), 3), round(float((p - origin) @ y), 3)))
        name = f"holes_d{dia:g}"
        span = _extent(pts, x, y)
        out[name] = {
            "kind": "pattern",
            "points": [_list(p) for p in pts],
            "normal": _list(n),
            "diameter": dia,
            "note": f"{len(pts)} through holes Ø{dia:g} mm in the base plane, {span}",
        }
    # Bores: the biggest round holes that aren't part of a pattern, any direction.
    patterned = {id(h) for hs in groups.values() if len(hs) >= 2 for h in hs}
    bores = sorted((h for h in round_holes if id(h) not in patterned and h["r"] >= 1), key=lambda h: -h["r"])[:3]
    for i, h in enumerate(bores):
        name = f"bore_d{2 * h['r']:.3g}"
        if name in out:
            name += f"_{i + 1}"
        o = h["o"] + ((_np(bb.center()) - h["o"]) @ h["d"]) * h["d"]  # mid-way along the body
        out[name] = {"kind": "axis", "origin": _list(o), "direction": _list(h["d"]), "note": f"bore Ø{2 * h['r']:.4g} mm"}
    flat = {id(h) for h in plane_holes}
    listed = [{"diameter": round(2 * h["r"], 4), "at": _list(_on_plane(h["o"], h["d"], origin, n) if id(h) in flat else h["o"]), "direction": _list(h["d"])} for h in round_holes]
    return out, listed[:200]


# ---------------------------------------------------------------- transforms of datums


def transform(d: dict, m: np.ndarray) -> dict:
    """The datum moved by a 4x4 matrix."""
    R, t = m[:3, :3], m[:3, 3]
    p = lambda v: _list(R @ np.array(v) + t)
    v = lambda v: _list(R @ np.array(v))
    if d["kind"] == "plane":
        return {**d, "origin": p(d["origin"]), "normal": v(d["normal"]), "x": v(d["x"])}
    if d["kind"] == "axis":
        return {**d, "origin": p(d["origin"]), "direction": v(d["direction"])}
    if d["kind"] == "point":
        return {**d, "at": p(d["at"])}
    return {**d, "points": [p(q) for q in d["points"]], "normal": v(d["normal"])}


# ---------------------------------------------------------------- helpers


def _pattern(points, normal, diameter, name) -> dict:
    P = np.array([[float(c) for c in p] for p in points], dtype=np.float64)
    if len(P) < 2:
        raise ValueError(f"Pattern {name!r} needs at least two points.")
    if normal is None:
        if len(P) < 3:
            raise ValueError(f"Pattern {name!r} has two points; give its normal: Pattern(points, normal=(0, 0, 1)).")
        _, s, vt = np.linalg.svd(P - P.mean(axis=0))
        if s[1] < 1e-9:
            raise ValueError(f"Pattern {name!r}: the points are on one line; give its normal with Pattern(points, normal=…).")
        normal = vt[2]
        normal = normal if normal[np.argmax(np.abs(normal))] > 0 else -normal
    out = {"kind": "pattern", "points": [_list(p) for p in P], "normal": _list(_unit(np.asarray(normal, dtype=np.float64)))}
    if diameter:
        out["diameter"] = float(diameter)
    return out


def _clean(d: dict) -> dict:
    keys = {"plane": ("origin", "normal", "x"), "axis": ("origin", "direction"), "point": ("at",), "pattern": ("points", "normal")}[d["kind"]]
    out = {"kind": d["kind"]}
    for k in keys:
        out[k] = [[float(c) for c in p] for p in d[k]] if k == "points" else [float(c) for c in d[k]]
    for k in ("normal", "direction", "x"):
        if k in out:
            out[k] = _list(_unit(np.array(out[k])))
    if d.get("diameter"):
        out["diameter"] = float(d["diameter"])
    return out


def _good_name(name: str) -> bool:
    return bool(name) and len(name) <= 60 and all(c.isalnum() or c in "_-." for c in name) and not name.startswith(".")


def _is_cyl(face) -> bool:
    from build123d import GeomType

    return face.geom_type == GeomType.CYLINDER


def _cylinder(face):
    """(point on axis, unit direction, radius) of a cylindrical or conical face."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Cylinder

    s = BRepAdaptor_Surface(face.wrapped)
    g = s.Cylinder() if s.GetType() == GeomAbs_Cylinder else s.Cone()
    ax = g.Axis()
    o, d = ax.Location(), ax.Direction()
    r = g.Radius() if s.GetType() == GeomAbs_Cylinder else g.RefRadius()
    return np.array([o.X(), o.Y(), o.Z()]), np.array([d.X(), d.Y(), d.Z()]), float(r)


def _concave(face, o, d) -> bool:
    """A hole (the surface faces its axis), not a boss or a rounded corner."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepTools import BRepTools
    from OCP.gp import gp_Pnt, gp_Vec
    from OCP.TopAbs import TopAbs_REVERSED

    s = BRepAdaptor_Surface(face.wrapped)
    u0, u1, v0, v1 = BRepTools.UVBounds_s(face.wrapped)
    p, du, dv = gp_Pnt(), gp_Vec(), gp_Vec()
    s.D1((u0 + u1) / 2, (v0 + v1) / 2, p, du, dv)
    n = du.Crossed(dv)
    if face.wrapped.Orientation() == TopAbs_REVERSED:
        n.Reverse()
    q = np.array([p.X(), p.Y(), p.Z()])
    radial = (q - o) - ((q - o) @ d) * d
    return float(np.array([n.X(), n.Y(), n.Z()]) @ radial) < 0


def _span(face) -> float:
    from OCP.BRepTools import BRepTools

    u0, u1, _, _ = BRepTools.UVBounds_s(face.wrapped)
    return float(u1 - u0)


def _principal(face, n: np.ndarray) -> np.ndarray:
    """The face's x direction: the first global axis in its plane when it's square to them, else its long direction."""
    if np.abs(n).max() > 1 - 1e-9:
        return np.eye(3)[np.argmin(np.abs(n))]
    pts = np.array([[v.X, v.Y, v.Z] for v in face.vertices()], dtype=np.float64)
    ref = np.eye(3)[np.argmin(np.abs(n))]
    if len(pts) >= 3:
        flat = pts - pts.mean(axis=0)
        flat = flat - np.outer(flat @ n, n)
        _, s, vt = np.linalg.svd(flat, full_matrices=False)
        if s[0] > 1e-9 and (len(s) < 2 or s[0] > s[1] * 1.0001):
            ref = vt[0]
    x = ref - (ref @ n) * n
    if np.linalg.norm(x) < 1e-9:
        x = np.cross(n, np.eye(3)[np.argmin(np.abs(n))])
    x = _unit(x)
    return x if x[np.argmax(np.abs(x))] > 0 else -x


def _on_plane(o, d, origin, n) -> np.ndarray:
    """Where the line o + t·d meets the plane through origin with normal n."""
    den = d @ n
    return o + ((origin - o) @ n) / den * d if abs(den) > 1e-12 else o


def _extent(pts, x, y) -> str:
    P = np.array(pts)
    a, b = P @ x, P @ y
    return f"spanning {np.ptp(a):.3f} × {np.ptp(b):.3f} mm (along the base's x and y)"


def _line_gap(p, o, d) -> float:
    v = p - o
    return float(np.linalg.norm(v - (v @ d) * d))


def _vec(p) -> np.ndarray:
    if hasattr(p, "X"):
        return np.array([p.X, p.Y, p.Z], dtype=np.float64)
    a = np.array([float(c) for c in p], dtype=np.float64)
    if a.shape != (3,):
        raise ValueError(f"Expected a point (x, y, z), got {p!r}.")
    return a


def _np(v) -> np.ndarray:
    return np.array([v.X, v.Y, v.Z], dtype=np.float64)


def _unit(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v)
    if n < 1e-12:
        raise ValueError("A datum direction can't be zero.")
    return v / n


def _xyz(v) -> list[float]:
    return [float(v.X), float(v.Y), float(v.Z)]


def _list(a) -> list[float]:
    return [float(c) for c in a]
