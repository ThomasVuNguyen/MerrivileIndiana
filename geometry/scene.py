"""Pictures for inspect: each part (or item, or loose solid) in its own colour with a legend, and
exact section cuts.

part(id) labels the solid it returns with the part id. build123d carries the label through
Pos()/Rot()/moved() copies and booleans (it keeps the left operand's), so a moved copy still
gets its part's colour. Compound() drops children's labels: give `result` a list or a dict.
"""

from __future__ import annotations

import numpy as np

from geometry.mesh import tessellate
from geometry.render import BASE, PALETTE, merge, render_views

AXES = {"x": (1.0, 0.0, 0.0), "y": (0.0, 1.0, 0.0), "z": (0.0, 0.0, 1.0)}


def render_scene(value, colors: dict[str, str], views: list | None, size: int, section: dict | None = None) -> bytes | None:
    """A sheet of `value` (a shape, a list of shapes or {name: shape}); None when there's nothing to draw.

    `colors` maps part id to its display colour. `views` are (name, dir, up) tuples, or None for the
    default (iso, front, top, right; or two views of the cut face with a section).
    """
    items = _colour(_items(value), colors)
    cut = _plane([s for _, s, _ in items], section) if section else None
    meshes, legend = [], []
    for name, shape, rgb in items:
        mask = None
        if cut:
            shape = _split(shape, cut)
            if shape is None:
                continue
        if not (shape.faces() or shape.edges()):
            continue
        mesh = tessellate(shape, info=False)
        if cut:
            mask = _cut_mask(shape, mesh, cut)
        meshes.append((mesh["_arrays"], rgb, mask))
        if (name, rgb) not in legend:
            legend.append((name, rgb))
    if not meshes:
        return None
    if views is None and cut:
        views = _section_views(cut)
    return render_views({"_arrays": merge(meshes)}, views, size, legend)


def _items(value) -> list:
    """(name or None, shape) pairs, flattening lists and dicts."""
    from build123d import Compound, Shape

    out: list = []

    def add(name, v):
        if hasattr(v, "part") and not isinstance(v, Shape):  # a BuildPart context
            v = v.part
        if isinstance(v, dict):
            for k, x in v.items():
                add(str(k), x)
        elif isinstance(v, (list, tuple)):
            shapes = [x.part if hasattr(x, "part") and not isinstance(x, Shape) else x for x in v]
            if name is not None and all(isinstance(x, Shape) for x in shapes):
                out.append((name, Compound(shapes)))  # several shapes under one name: one colour
            else:
                for x in v:
                    add(name, x)
        elif isinstance(v, Shape):
            out.append((name, v))
        elif v is not None:
            raise TypeError(f"`result` holds a {type(v).__name__}; expected build123d shapes.")

    add(None, value)
    return out


def _colour(pairs: list, colors: dict[str, str]) -> list:
    """(name, shape, rgb): parts keep their colour unless another part already has it; the rest get palette colours."""
    out: list = []
    by_part: dict[str, tuple] = {}
    used: list = []
    palette = iter([_rgb(c) for c in PALETTE] * 50)

    def fresh():
        for c in palette:
            if all(_far(c, u) for u in used):
                return c
        return tuple(BASE)

    loose = [(n, s) for n, s in pairs if (s.label or "") not in colors]
    single = len(pairs) == 1 and len(loose) == 1 and len(pairs[0][1].solids()) <= 1
    for i, (name, shape) in enumerate(pairs):
        pid = shape.label if shape.label in colors else None
        if pid:
            if pid not in by_part:
                c = _rgb(colors[pid])
                by_part[pid] = c if all(_far(c, u) for u in used) else fresh()
                used.append(by_part[pid])
            out.append((name or pid, shape, by_part[pid]))
            continue
        label = name or shape.label or (f"item {i + 1}" if len(pairs) > 1 else "")
        solids = shape.solids()
        if single:  # one plain shape looks like a build's render
            out.append((label or "result", shape, tuple(BASE)))
        elif len(solids) > 1:
            for k, solid in enumerate(solids):
                c = fresh()
                used.append(c)
                out.append((f"{label} · solid {k + 1}" if label else f"solid {k + 1}", solid, c))
        else:
            c = fresh()
            used.append(c)
            out.append((label or "result", shape, c))
    return out


def _plane(shapes: list, section: dict):
    """(normal, offset, keep) from {normal: [x, y, z] | "x" | "y" | "z", offset?, keep?}."""
    from build123d import Compound

    raw = section.get("normal", "z")
    if isinstance(raw, str):
        if raw.lower() not in AXES:
            raise ValueError(f'section.normal must be "x", "y", "z" or [x, y, z], not {raw!r}.')
        n = np.array(AXES[raw.lower()])
    else:
        n = np.array([float(x) for x in raw], dtype=np.float64)
        if n.shape != (3,) or np.linalg.norm(n) < 1e-9:
            raise ValueError("section.normal must be a non-zero [x, y, z].")
        n = n / np.linalg.norm(n)
    keep = str(section.get("keep", "below")).lower()
    if keep not in ("below", "above"):
        raise ValueError('section.keep must be "below" or "above".')
    if section.get("offset") is not None:
        offset = float(section["offset"])
    else:
        c = Compound(shapes).bounding_box().center()
        offset = float(n @ np.array([c.X, c.Y, c.Z]))
    return n, offset, keep


def _split(shape, cut):
    """The part of `shape` on the kept side of the plane, with real cut faces; None if nothing's left."""
    from build123d import Compound, Keep, Plane, Shape

    n, offset, keep = cut
    plane = Plane(origin=tuple(n * offset), z_dir=tuple(n))
    try:
        r = shape.split(plane, keep=Keep.BOTTOM if keep == "below" else Keep.TOP)
    except Exception as exc:
        raise RuntimeError(f"The section cut failed: {type(exc).__name__}: {exc}") from None
    if isinstance(r, (list, tuple)):
        r = Compound(list(r)) if r else None
    return r if isinstance(r, Shape) else None


def _cut_mask(shape, mesh: dict, cut) -> np.ndarray:
    """True for the triangles of faces lying in the cut plane."""
    n, offset, _ = cut
    mask = np.zeros(len(mesh["_arrays"]["indices"]), dtype=bool)
    tol = max(1e-4, shape.bounding_box().diagonal * 1e-6)
    for face, (start, count) in zip(shape.faces(), mesh["faceRanges"]):
        if not count or not str(face.geom_type).endswith("PLANE"):
            continue
        c = face.center()
        if abs(n @ np.array([c.X, c.Y, c.Z]) - offset) > tol:
            continue
        fn = face.normal_at(c)
        if abs(abs(n @ np.array([fn.X, fn.Y, fn.Z])) - 1) < 1e-6:
            mask[start : start + count] = True
    return mask


def _section_views(cut) -> list:
    """Straight at the cut face, and an iso view from its side."""
    n, offset, keep = cut
    s = n if keep == "below" else -n  # the cut face's outward normal
    up = (0.0, 1.0, 0.0) if abs(s[2]) > 0.9 else (0.0, 0.0, 1.0)
    iso = np.array([1.0, -1.0, 0.8])
    iso = iso / np.linalg.norm(iso)
    if iso @ s < 0.2:  # mirror the iso view to the cut side
        iso = iso - 2 * (iso @ s) * s + 0.6 * s
    axis = next((k.upper() for k, v in AXES.items() if abs(abs(n @ np.array(v)) - 1) < 1e-9), None)
    at = f"{axis} = {offset:g}" if axis else f"{offset:g} mm along [{', '.join(f'{x:.3g}' for x in n)}]"
    return [(f"section at {at}", tuple(s), up), ("section iso", tuple(iso), (0.0, 0.0, 1.0))]


def _rgb(hex_color: str) -> tuple:
    h = hex_color.lstrip("#")
    return tuple(float(int(h[i : i + 2], 16)) for i in (0, 2, 4)) if len(h) == 6 else tuple(BASE)


def _far(a, b) -> bool:
    return float(np.abs(np.array(a) - np.array(b)).sum()) > 60


CLASH_RGB = (230.0, 20.0, 20.0)


def render_assembly(items: list, overlay: list, views: list | None, size: int, section: dict | None = None) -> tuple[bytes | None, bytes | None]:
    """A sheet of a placed assembly, each instance in its colour, clash volumes red over everything.

    items are {name, color "#rrggbb", shape (placed), matrix (4x4), arrays (the unplaced shape's mesh)}:
    without a section the unplaced mesh is moved, so a big vendor model is tessellated once.
    Returns (sheet, thumbnail).
    """
    from geometry.render import merge, render_thumb, render_views

    cut = _plane([i["shape"] for i in items], section) if section else None
    meshes, legend = [], []
    for it in items:
        rgb = _rgb(it["color"])
        if cut:
            shape = _split(it["shape"], cut)
            if shape is None or not (shape.faces() or shape.edges()):
                continue
            mesh = tessellate(shape, info=False)
            meshes.append((mesh["_arrays"], rgb, _cut_mask(shape, mesh, cut)))
        else:
            a, m = it["arrays"], it["matrix"]
            R, t = m[:3, :3], m[:3, 3]
            meshes.append(({"positions": a["positions"].astype(np.float64) @ R.T + t, "indices": a["indices"], "edges": a["edges"].astype(np.float64) @ R.T + t}, rgb, None))
        if (it["name"], rgb) not in legend:
            legend.append((it["name"], rgb))
    for shape in overlay:
        if cut:
            shape = _split(shape, cut)
            if shape is None or not shape.faces():
                continue
        mesh = tessellate(shape, info=False)
        meshes.append((mesh["_arrays"], CLASH_RGB, None, True))
    if overlay:
        legend.append(("clash", CLASH_RGB))
    if not meshes:
        return None, None
    if views is None and cut:
        views = _section_views(cut)
    merged = {"_arrays": merge(meshes)}
    return render_views(merged, views, size, legend), (render_thumb(merged) if not cut else None)
