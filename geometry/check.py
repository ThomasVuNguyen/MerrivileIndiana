"""Checks of a placed assembly: clashes, tight gaps, contacts, floating parts, keep-out intrusions.

Every instance is split into its solids (a vendor board has hundreds), boxes rule out most pairs,
and only pairs whose boxes come within the clearance get exact OpenCASCADE checks: the minimum
distance (BRepExtrema), and for touching pairs the common volume (a boolean). Findings are
warnings; nothing here blocks a save. A time limit stops early with partial results.
"""

from __future__ import annotations

import time

import numpy as np

CONTACT = 1e-3  # mm: closer than this is touching
CLASH = 1e-3  # mm³: more common volume than this is a clash


def check(leaves: list[dict], ground: set[str], clearance: float, keepouts: list[dict], time_limit: float) -> dict:
    """`leaves` are [{path, shape (placed), names?: per-solid labels}]; `keepouts` [{owner, label, shape}].

    Returns {findings, clash_shapes: [(index of the finding, shape)], partial, pairs_checked, pairs_skipped}.
    """
    started = time.perf_counter()
    items = []  # (leaf index, solid, solid label)
    for li, leaf in enumerate(leaves):
        solids = leaf["shape"].solids()
        names = leaf.get("names") or []
        if not solids:  # surfaces only (some vendor STEPs): distances still work
            items.append((li, leaf["shape"], ""))
            continue
        for k, s in enumerate(solids):
            items.append((li, s, names[k] if k < len(names) else ""))
    lo, hi = _boxes([s for _, s, _ in items])
    owner = np.array([li for li, _, _ in items])
    margin = clearance + CONTACT
    near = np.all(lo[:, None, :] - margin <= hi[None, :, :], axis=2) & np.all(lo[None, :, :] - margin <= hi[:, None, :], axis=2)
    near &= owner[:, None] < owner[None, :]
    pairs = np.argwhere(near)
    # Group by instance pair; check the pairs of solids whose boxes overlap most first.
    by_leaf: dict[tuple[int, int], list] = {}
    for i, j in pairs:
        by_leaf.setdefault((owner[i], owner[j]), []).append((i, j))

    findings: list[dict] = []
    clash_shapes: list = []
    touching: dict[int, set[int]] = {li: set() for li in range(len(leaves))}
    gaps: dict[tuple[int, int], tuple] = {}
    checked = skipped = 0
    partial = False
    for (a, b), cand in by_leaf.items():
        clash = {"volume": 0.0, "moment": np.zeros(3), "lo": None, "hi": None, "shapes": [], "where": set()}
        contact = None
        best_gap = None
        for i, j in cand:
            if time.perf_counter() - started > time_limit:
                partial = True
                skipped += 1
                continue
            checked += 1
            d, pa, pb = _distance(items[i][1], items[j][1])
            if d is None:
                continue
            if d < CONTACT:
                common = _common(items[i][1], items[j][1])
                vol = common.volume if common is not None else 0.0
                if vol > CLASH:
                    c = common.center()
                    clash["volume"] += vol
                    clash["moment"] += vol * np.array([c.X, c.Y, c.Z])
                    bb = common.bounding_box(optimal=False)
                    blo, bhi = np.array([bb.min.X, bb.min.Y, bb.min.Z]), np.array([bb.max.X, bb.max.Y, bb.max.Z])
                    clash["lo"] = blo if clash["lo"] is None else np.minimum(clash["lo"], blo)
                    clash["hi"] = bhi if clash["hi"] is None else np.maximum(clash["hi"], bhi)
                    clash["shapes"].append(common)
                    clash["where"].add((items[i][2], items[j][2]))
                elif contact is None:
                    contact = (d, pa)
            elif d < clearance and (best_gap is None or d < best_gap[0]):
                best_gap = (d, pa, pb, items[i][2], items[j][2])
        pa_, pb_ = leaves[a]["path"], leaves[b]["path"]
        if clash["volume"] > CLASH:
            touching[a].add(b)
            touching[b].add(a)
            centroid = clash["moment"] / clash["volume"]
            where = _where(clash["where"])
            findings.append(
                {
                    "kind": "clash",
                    "severity": "warning",
                    "instances": [pa_, pb_],
                    "value": float(clash["volume"]),
                    "unit": "mm³",
                    "at": [float(x) for x in centroid],
                    "bbox": {"min": [float(x) for x in clash["lo"]], "max": [float(x) for x in clash["hi"]]},
                    "message": f"{pa_} and {pb_} overlap by {clash['volume']:.4g} mm³ around ({_fmt(centroid)}), in a box {_fmt(clash['hi'] - clash['lo'], ' × ')} mm{where}.",
                }
            )
            clash_shapes.append((len(findings) - 1, clash["shapes"]))
        elif contact is not None:
            touching[a].add(b)
            touching[b].add(a)
            findings.append({"kind": "contact", "severity": "info", "instances": [pa_, pb_], "value": float(contact[0]), "unit": "mm", "at": contact[1], "message": f"{pa_} touches {pb_} (gap {contact[0]:.2g} mm) near ({_fmt(contact[1])})."})
        if best_gap is not None and clash["volume"] <= CLASH and contact is None:
            d, pa, pb, na, nb = best_gap
            gaps[(a, b)] = best_gap
            mid = [(x + y) / 2 for x, y in zip(pa, pb)]
            findings.append(
                {
                    "kind": "tight_gap",
                    "severity": "warning",
                    "instances": [pa_, pb_],
                    "value": float(d),
                    "unit": "mm",
                    "at": mid,
                    "message": f"{pa_} and {pb_} are {d:.4f} mm apart at ({_fmt(mid)}), under the {clearance:g} mm clearance{_where({(na, nb)})}.",
                }
            )

    # Floating: not connected to the ground through touching parts.
    roots = {li for li, leaf in enumerate(leaves) if leaf["path"] in ground or any(leaf["path"].startswith(g + "/") for g in ground)}
    seen, todo = set(roots), list(roots)
    while todo:
        for n in touching[todo.pop()]:
            if n not in seen:
                seen.add(n)
                todo.append(n)
    for li, leaf in enumerate(leaves):
        if li in seen or partial:
            continue
        others = sorted(leaves[n]["path"] for n in touching[li])
        gap = _nearest(leaf["shape"], [leaves[n]["shape"] for n in seen], lo, hi, owner, li)
        why = f"touches only {', '.join(others)}, which {'doesn' if len(others) == 1 else 'don'}'t connect to the ground" if others else "touches nothing"
        msg = f"{leaf['path']} floats: it {why}" + (f"; the nearest grounded part is {gap:.4f} mm away." if gap is not None else ".")
        findings.append({"kind": "floating", "severity": "warning", "instances": [leaf["path"]], **({"value": gap, "unit": "mm"} if gap is not None else {}), "message": msg})

    # Keep-outs: clearance volumes of components (a plug, a lens's field of view) that nothing may enter.
    for ko in keepouts:
        if time.perf_counter() - started > time_limit:
            partial = True
            break
        kb = ko["shape"].bounding_box(optimal=False)
        klo, khi = np.array([kb.min.X, kb.min.Y, kb.min.Z]), np.array([kb.max.X, kb.max.Y, kb.max.Z])
        hit = np.nonzero(np.all(lo <= khi, axis=1) & np.all(hi >= klo, axis=1))[0]
        per_leaf: dict[int, list] = {}
        for i in hit:
            if leaves[owner[i]]["path"] == ko["owner"]:
                continue
            common = _common(ko["shape"], items[i][1])
            if common is not None and common.volume > CLASH:
                per_leaf.setdefault(int(owner[i]), []).append(common)
        for li, commons in per_leaf.items():
            vol = sum(c.volume for c in commons)
            centroid = sum((c.volume * np.array([c.center().X, c.center().Y, c.center().Z]) for c in commons), np.zeros(3)) / vol
            lo_, hi_ = _boxes(commons)
            findings.append(
                {
                    "kind": "keepout",
                    "severity": "warning",
                    "instances": [leaves[li]["path"], ko["owner"]],
                    "value": float(vol),
                    "unit": "mm³",
                    "at": [float(x) for x in centroid],
                    "bbox": {"min": [float(x) for x in lo_.min(axis=0)], "max": [float(x) for x in hi_.max(axis=0)]},
                    "keepout": ko["label"],
                    "message": f"{leaves[li]['path']} enters {ko['owner']}'s keep-out \"{ko['label']}\" by {vol:.4g} mm³ around ({_fmt(centroid)}).",
                }
            )
            clash_shapes.append((len(findings) - 1, commons))
    return {"findings": findings, "clash_shapes": clash_shapes, "partial": partial, "pairs_checked": checked, "pairs_skipped": skipped}


def keepout_shape(k: dict):
    """A keep-out volume in its component's frame: box {min, max}, cylinder {origin, direction, radius,
    length} or cone {origin (apex end), direction, angle (half-angle, degrees), length, radius? at the start}."""
    import math

    from build123d import Align, Box, Cone, Cylinder, Plane, Pos

    kind = k.get("kind")
    if kind == "box":
        lo, hi = np.array(k["min"], dtype=float), np.array(k["max"], dtype=float)
        size = hi - lo
        if (size <= 0).any():
            raise ValueError(f"keep-out {k.get('label')!r}: max must exceed min on every axis")
        return Pos(*((lo + hi) / 2)) * Box(*size)
    plane = Plane(origin=tuple(k["origin"]), z_dir=tuple(k["direction"]))
    length = float(k["length"])
    if kind == "cylinder":
        return plane.location * Cylinder(float(k["radius"]), length, align=(Align.CENTER, Align.CENTER, Align.MIN))
    if kind == "cone":
        r0 = float(k.get("radius") or 0)
        r1 = r0 + length * math.tan(math.radians(float(k["angle"])))
        return plane.location * Cone(max(r0, 1e-4), r1, length, align=(Align.CENTER, Align.CENTER, Align.MIN))
    raise ValueError(f"keep-out kind {kind!r}: use box, cylinder or cone")


def _distance(a, b):
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    try:
        ext = BRepExtrema_DistShapeShape(a.wrapped, b.wrapped)
        if not ext.IsDone() or ext.NbSolution() == 0:
            return None, None, None
        p, q = ext.PointOnShape1(1), ext.PointOnShape2(1)
        return float(ext.Value()), [p.X(), p.Y(), p.Z()], [q.X(), q.Y(), q.Z()]
    except Exception:
        return None, None, None


def _common(a, b):
    try:
        r = a & b
    except Exception:
        return None
    return r if r is not None and r.solids() else None


def _boxes(shapes) -> tuple[np.ndarray, np.ndarray]:
    lo, hi = [], []
    for s in shapes:
        bb = s.bounding_box(optimal=False)
        lo.append([bb.min.X, bb.min.Y, bb.min.Z])
        hi.append([bb.max.X, bb.max.Y, bb.max.Z])
    return np.array(lo, dtype=np.float64).reshape(-1, 3), np.array(hi, dtype=np.float64).reshape(-1, 3)


def _nearest(shape, others, lo, hi, owner, li) -> float | None:
    """Distance from a floating instance to the closest grounded one (up to 40 of them)."""
    if not others:
        return None
    best = None
    for other in others[:40]:
        d, _, _ = _distance(shape, other)
        if d is not None and (best is None or d < best):
            best = d
    return best


def _where(pairs: set) -> str:
    names = sorted({f"{_short(a)} / {_short(b)}" for a, b in pairs if a or b})
    return f" ({'; '.join(names[:4])}{' …' if len(names) > 4 else ''})" if names else ""


def _short(label: str) -> str:
    return label.split(",")[0].replace("_", " ").strip() or "—"


def _fmt(v, sep: str = ", ") -> str:
    return sep.join(f"{x:.3f}" for x in v)
