"""Assemblies: where every instance goes, from plain positions or snaps between named datums.

No constraint solver: each instance is placed once, in dependency order, from the instances it
snaps to. Plain placement is pos [x, y, z] mm then rot [rx, ry, rz] degrees, exactly build123d's
Pos(x, y, z) * Rot(rx, ry, rz) (intrinsic X then Y then Z: R = Rx · Ry · Rz).

Snaps (`own` is a datum of the instance being placed, `to` is "<instance>.<datum>", or
"<sub>/<child>.<datum>" inside a sub-assembly; instance ids have no dots, so an address splits at
its first dot and datum names may have them, e.g. "pi.holes_d2.7"):
- plane → plane: the planes' frames meet face to face (normals opposed; flip: aligned, x along x),
  offset mm apart along the target normal, turned spin° about it.
- axis → axis: coaxial with directions aligned (flip: opposed), offset mm along the target axis,
  spin° about it; the turn about the axis otherwise keeps the instance's rot.
- point → point: they coincide; the orientation is the instance's rot.
- pattern → pattern: best rigid fit of the points (Kabsch), normals opposed (flip: aligned), offset
  along the target normal, spin about it; the per-point residual is reported.
Two snaps: the first places the instance, then both are met together by least squares from there
(e.g. a lens: axis → axis, then its seat plane → the cell's seat). What can't be met is reported.

Matrices are 4x4, row-major, for column vectors: p_world = M · [x, y, z, 1].
"""

from __future__ import annotations

import math

import numpy as np

from geometry.datums import transform

DIST_TOL = 1e-3  # mm: a snap met closer than this is met
ANGLE_TOL = 0.01  # degrees
PATTERN_TOL = 0.05  # mm: a pattern fit worse than this is a finding
REQ_MM = 0.02  # default alignment tolerances
REQ_DEG = 0.05


class AssemblyError(ValueError):
    """The assembly can't be laid out at all (a cycle, a sub-assembly that contains itself)."""


# ---------------------------------------------------------------- matrices


def plain(pos=None, rot=None) -> np.ndarray:
    """Pos(*pos) * Rot(*rot) as a matrix."""
    m = np.eye(4)
    rx, ry, rz = (math.radians(float(a)) for a in (rot or (0, 0, 0)))
    m[:3, :3] = _rx(rx) @ _ry(ry) @ _rz(rz)
    m[:3, 3] = [float(v) for v in (pos or (0, 0, 0))]
    return m


def euler(m: np.ndarray) -> list[float]:
    """[rx, ry, rz] degrees with Rot(rx, ry, rz) == m's rotation (R = Rx · Ry · Rz)."""
    R = m[:3, :3]
    ry = math.asin(max(-1.0, min(1.0, R[0, 2])))
    if abs(R[0, 2]) < 1 - 1e-9:
        rx = math.atan2(-R[1, 2], R[2, 2])
        rz = math.atan2(-R[0, 1], R[0, 0])
    else:  # gimbal lock: put it all in rx
        rx = math.atan2(R[2, 1], R[1, 1])
        rz = 0.0
    return [math.degrees(rx), math.degrees(ry), math.degrees(rz)]


def flat(m: np.ndarray) -> list[float]:
    return [float(x) for x in m.reshape(-1)]


def unflat(v) -> np.ndarray:
    return np.array([float(x) for x in v], dtype=np.float64).reshape(4, 4)


def _rx(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def _ry(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def _rz(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def rotation(axis, angle_deg: float) -> np.ndarray:
    """3x3 rotation about a unit axis."""
    k = np.asarray(axis, dtype=np.float64)
    k = k / np.linalg.norm(k)
    a = math.radians(angle_deg)
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(a) * K + (1 - math.cos(a)) * K @ K


def minimal(a, b) -> np.ndarray:
    """The smallest rotation taking unit vector a to unit vector b."""
    a, b = _unit(a), _unit(b)
    c = float(a @ b)
    if c > 1 - 1e-15:
        return np.eye(3)
    if c < -1 + 1e-12:
        perp = np.cross(a, np.eye(3)[np.argmin(np.abs(a))])
        return rotation(perp, 180.0)
    return rotation(np.cross(a, b), math.degrees(math.acos(c)))


def about(point, axis, angle_deg: float) -> np.ndarray:
    """4x4 rotation about a line."""
    m = np.eye(4)
    R = rotation(axis, angle_deg)
    p = np.asarray(point, dtype=np.float64)
    m[:3, :3] = R
    m[:3, 3] = p - R @ p
    return m


def frame(origin, x, z) -> np.ndarray:
    """4x4 of a right-handed frame (x, z × x, z) at origin."""
    z = _unit(z)
    x = _unit(np.asarray(x) - (np.asarray(x) @ z) * z)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = x, np.cross(z, x), z, origin
    return m


# ---------------------------------------------------------------- layout


class Layout:
    """One assembly laid out: each instance's matrix in the assembly's frame, sub-assemblies recursively.

    `catalog` is {"datums": {ref key: {name: datum}}, "assemblies": {id: spec}}; ref keys are
    "part:<id>", "part:<id>@<version>" and "component:<id>". `previous` is {path: 16 numbers} from the
    last save, kept for instances whose snaps can't be met.
    """

    def __init__(self, spec: dict, catalog: dict, previous: dict | None = None, prefix: str = "", stack: tuple = ()):
        self.spec, self.catalog, self.prefix = spec, catalog, prefix
        self.previous = previous or {}
        self.instances = {i["id"]: i for i in spec.get("instances", [])}
        self.M: dict[str, np.ndarray] = {}
        self.subs: dict[str, Layout] = {}
        self.state: dict[str, dict] = {}
        self.findings: list[dict] = []
        if not self.instances:
            return
        for inst in self.instances.values():
            sub = inst["ref"].get("assembly")
            if sub is not None:
                if sub in stack:
                    raise AssemblyError(f"Assembly {sub!r} contains itself ({' → '.join((*stack, sub))}).")
                if sub not in catalog.get("assemblies", {}):
                    raise AssemblyError(f"Instance {inst['id']!r}: no assembly {sub!r}.")
                self.subs[inst["id"]] = Layout(catalog["assemblies"][sub], catalog, self.previous, f"{prefix}{inst['id']}/", (*stack, sub))
        ground = next((i["id"] for i in self.instances.values() if i.get("ground")), next(iter(self.instances)))
        self.ground = ground
        for iid in self._order():
            self._place(self.instances[iid], iid == ground)

    # -- order

    def _order(self) -> list[str]:
        deps = {iid: [t for t in self._targets(i) if t in self.instances and t != iid] for iid, i in self.instances.items()}
        done: list[str] = []
        state: dict[str, int] = {}

        def visit(iid, path):
            if state.get(iid) == 2:
                return
            if state.get(iid) == 1:
                cycle = path[path.index(iid):] + [iid]
                raise AssemblyError(f"Snaps go round in a circle: {' → '.join(self.prefix + c for c in cycle)}. Ground one of them or place it with pos/rot.")
            state[iid] = 1
            for d in deps[iid]:
                visit(d, path + [iid])
            state[iid] = 2
            done.append(iid)

        if self.instances:
            visit(self.ground if hasattr(self, "ground") else next(iter(self.instances)), [])
        for iid in self.instances:
            visit(iid, [])
        return done

    def _targets(self, inst) -> list[str]:
        if inst.get("ground") or not inst.get("snap"):
            return []
        snaps = inst["snap"] if isinstance(inst["snap"], list) else [inst["snap"]]
        return [str(s.get("to", "")).split(".")[0].split("/")[0] for s in snaps]

    # -- placing one instance

    def _place(self, inst: dict, is_ground: bool) -> None:
        iid = inst["id"]
        snaps = inst.get("snap")
        st: dict = {"status": "ok"}
        self.state[iid] = st
        if is_ground or not snaps:
            if is_ground and snaps:
                self.findings.append(_finding("info", "ground", [self.prefix + iid], f"{self.prefix}{iid} is the ground (fixed at its pos/rot); its snap is ignored. Mark another instance ground: true to snap this one."))
            self.M[iid] = plain(inst.get("pos"), inst.get("rot"))
            return
        snaps = snaps if isinstance(snaps, list) else [snaps]
        try:
            resolved = [self._resolve_snap(inst, s) for s in snaps]
        except Unresolved as why:
            kept = self.previous.get(self.prefix + iid)
            self.M[iid] = unflat(kept) if kept is not None else plain(inst.get("pos"), inst.get("rot"))
            st.update(status="unresolved", problem=str(why))
            where = "keeps its last placement" if kept is not None else "is at its pos/rot (never placed before)"
            self.findings.append(_finding("warning", "unresolved", [self.prefix + iid], f"{self.prefix}{iid}: {why} It {where}; nothing moved it."))
            return
        R0 = plain(None, inst.get("rot"))[:3, :3]
        M, info = _solve(resolved, R0)
        self.M[iid] = M
        st["snaps"] = info
        for k, s in enumerate(info):
            if s.get("note"):
                self.findings.append(_finding("info", "snap", [self.prefix + iid], f"{self.prefix}{iid} snap {k + 1}: {s['note']}"))
            if s["kind"] == "pattern" and s["residual_mm"] > PATTERN_TOL:
                worst = int(np.argmax(s["points_mm"]))
                self.findings.append(
                    _finding(
                        "warning",
                        "pattern_fit",
                        [self.prefix + iid, self.prefix + _target_instance(s["to"])],
                        f"{self.prefix}{iid} {s['own']} → {s['to']}: the hole patterns don't match; worst point {worst + 1} is {s['residual_mm']:.4f} mm off (rms {s['rms_mm']:.4f} mm).",
                        value=s["residual_mm"],
                        unit="mm",
                        at=s["at"][worst] if s.get("at") else None,
                    )
                )
            elif len(info) > 1 and (s["residual_mm"] > DIST_TOL or s["residual_deg"] > ANGLE_TOL):
                self.findings.append(
                    _finding(
                        "warning",
                        "snap_conflict",
                        [self.prefix + iid, self.prefix + _target_instance(s["to"])],
                        f"{self.prefix}{iid}: its two snaps can't both be met; {s['own']} → {s['to']} is off by {s['residual_mm']:.4f} mm and {s['residual_deg']:.4f}°.",
                        value=s["residual_mm"],
                        unit="mm",
                    )
                )

    def _resolve_snap(self, inst: dict, s: dict) -> dict:
        own_name, to = str(s.get("own", "")), str(s.get("to", ""))
        if "." not in to:
            raise Unresolved(f'snap "to" must be "<instance>.<datum>", not {to!r}.')
        own = self.local_datum(inst["id"], own_name)
        target_path, _, target_datum = to.partition(".")
        head = target_path.split("/")[0]
        if head not in self.instances:
            raise Unresolved(f"it snaps to {self.prefix}{head}, which isn't in the assembly (any more).")
        if self.state.get(head, {}).get("status") == "unresolved":
            pass  # placed where it was kept; snapping to it still works
        tgt = self.world_datum(target_path, target_datum)
        if own["kind"] != tgt["kind"]:
            raise Unresolved(f"{own_name} is a {own['kind']} but {to} is a {tgt['kind']}; snap like to like.")
        if own["kind"] == "pattern" and len(own["points"]) != len(tgt["points"]):
            raise Unresolved(f"{own_name} has {len(own['points'])} points but {to} has {len(tgt['points'])}.")
        return {"kind": own["kind"], "own": own, "tgt": tgt, "own_name": own_name, "to": to, "offset": float(s.get("offset") or 0), "flip": bool(s.get("flip")), "spin": float(s.get("spin") or 0)}

    # -- datums

    def local_datum(self, iid: str, name: str) -> dict:
        """A datum of instance iid in the instance's own frame ("child.datum" inside a sub-assembly)."""
        inst = self.instances[iid]
        if iid in self.subs:
            path, _, datum = name.partition(".")
            if not datum:
                raise Unresolved(f"{self.prefix}{iid} is a sub-assembly: name a datum of one of its instances, e.g. child.{name}.")
            return self.subs[iid].world_datum(path, datum)
        if "/" in name:
            raise Unresolved(f"own datum {name!r}: give just the datum name of {self.prefix}{iid}.")
        datums = self.catalog.get("datums", {}).get(ref_key(inst["ref"]), {})
        if name not in datums:
            raise Unresolved(f"{_ref_label(inst['ref'])} has no datum {name!r} (it has: {', '.join(sorted(datums)) or 'none'}).")
        return datums[name]

    def world_datum(self, path: str, name: str) -> dict:
        """A datum of the instance at path ("inst" or "sub/child") in this assembly's frame."""
        head, _, rest = path.partition("/")
        if head not in self.instances:
            raise Unresolved(f"no instance {self.prefix}{head}.")
        if head not in self.M:
            raise Unresolved(f"{self.prefix}{head} isn't placed yet.")
        if rest:
            if head not in self.subs:
                raise Unresolved(f"{self.prefix}{head} isn't a sub-assembly, so {path} names nothing.")
            return transform(self.subs[head].world_datum(rest, name), self.M[head])
        return transform(self.local_datum(head, name), self.M[head])

    # -- results

    def leaves(self, base: np.ndarray | None = None) -> list[dict]:
        """Every part and component instance with its matrix in the top frame, sub-assemblies flattened."""
        base = np.eye(4) if base is None else base
        out = []
        for iid, inst in self.instances.items():
            W = base @ self.M[iid]
            if iid in self.subs:
                out += self.subs[iid].leaves(W)
            else:
                out.append({"path": self.prefix + iid, "name": inst.get("name") or iid, "ref": inst["ref"], "key": ref_key(inst["ref"]), "matrix": W, "color": inst.get("color")})
        return out

    def all_findings(self) -> list[dict]:
        return [f for sub in self.subs.values() for f in sub.all_findings()] + self.findings

    def report_instances(self) -> list[dict]:
        out = []
        for iid in self.instances:
            st = self.state.get(iid, {"status": "ok"})
            out.append({"id": iid, "matrix": flat(self.M[iid]), **st, **({"instances": self.subs[iid].report_instances()} if iid in self.subs else {})})
        return out


class Unresolved(Exception):
    pass


def ref_key(ref: dict) -> str:
    if "part" in ref:
        return f"part:{ref['part']}@{ref['version']}" if ref.get("version") else f"part:{ref['part']}"
    if "component" in ref:
        return f"component:{ref['component']}"
    return f"assembly:{ref['assembly']}"


def _ref_label(ref: dict) -> str:
    return ref_key(ref).replace(":", " ")


def _target_instance(to: str) -> str:
    return to.partition(".")[0]


# ---------------------------------------------------------------- snapping


def _solve(snaps: list[dict], R0: np.ndarray) -> tuple[np.ndarray, list[dict]]:
    """The instance's matrix from one snap (closed form) or two (closed form, then least squares)."""
    M, notes = _closed(snaps[0], R0)
    if len(snaps) > 1:
        if snaps[0]["kind"] == "pattern":
            notes = (notes or "") + " A pattern snap fixes every degree of freedom; the second snap was only checked."
        else:
            M = _refine(snaps, M)
    info = []
    for k, s in enumerate(snaps):
        r = _measure(s, M)
        info.append({"own": s["own_name"], "to": s["to"], "kind": s["kind"], **r, **({"note": notes} if k == 0 and notes else {})})
    return M, info


def _closed(s: dict, R0: np.ndarray) -> tuple[np.ndarray, str | None]:
    own, tgt, kind = s["own"], s["tgt"], s["kind"]
    if kind == "plane":
        Fo = frame(np.array(own["origin"]), own["x"], own["normal"])
        n_t = _unit(tgt["normal"])
        Ft = frame(np.array(tgt["origin"]) + s["offset"] * n_t, tgt["x"], n_t)
        flipm = np.eye(4) if s["flip"] else np.diag([1.0, -1.0, -1.0, 1.0])  # face to face: half a turn about x
        D = about(Ft[:3, 3], n_t, s["spin"]) @ Ft @ flipm
        return D @ np.linalg.inv(Fo), None
    if kind == "axis":
        d_t = _unit(tgt["direction"])
        goal = -d_t if s["flip"] else d_t
        R = rotation(goal, s["spin"]) @ minimal(R0 @ _unit(own["direction"]), goal) @ R0
        M = np.eye(4)
        M[:3, :3] = R
        M[:3, 3] = np.array(tgt["origin"]) + s["offset"] * d_t - R @ np.array(own["origin"])
        return M, None
    if kind == "point":
        M = np.eye(4)
        M[:3, :3] = R0
        M[:3, 3] = np.array(tgt["at"]) - R0 @ np.array(own["at"])
        return M, None
    return _fit_pattern(s, R0)


def _fit_pattern(s: dict, R0: np.ndarray) -> tuple[np.ndarray, str | None]:
    """Best rigid fit of the own points onto the target's, trying every way they can pair up."""
    own, tgt = s["own"], s["tgt"]
    P = np.array(own["points"], dtype=np.float64)
    n_t = _unit(tgt["normal"])
    Q = np.array(tgt["points"], dtype=np.float64) + s["offset"] * n_t
    goal = n_t if s["flip"] else -n_t
    n_o = _unit(own["normal"])
    L = max(float(np.ptp(Q, axis=0).max()), 10.0)
    cP, cQ = P.mean(axis=0), Q.mean(axis=0)

    def fit(order):
        A = np.vstack([P, cP + L * n_o])
        B = np.vstack([Q[order], cQ + L * goal])
        R, t = _kabsch(A, B)
        err = np.linalg.norm(P @ R.T + t - Q[order], axis=1)
        return R, t, float(err.max()), order

    candidates = [fit(np.arange(len(P)))]
    # Other pairings: turn the own pattern so its normal meets the goal, then try each target point
    # for the own point furthest from the centre, pairing the rest by nearest neighbour.
    R1 = minimal(R0 @ n_o, goal) @ R0
    P1 = (P - cP) @ R1.T
    anchor = int(np.argmax(np.linalg.norm(P1, axis=1)))
    for j in range(len(Q)):
        a, b = _flat(P1[anchor], goal), _flat(Q[j] - cQ, goal)
        if np.linalg.norm(a) < 1e-9 or np.linalg.norm(b) < 1e-9:
            continue
        ang = math.degrees(math.atan2(float(np.cross(a, b) @ goal), float(a @ b)))
        P2 = P1 @ rotation(goal, ang).T + cQ
        order = _pair(P2, Q)
        if order is not None:
            candidates.append(fit(order))
    best = min(c[2] for c in candidates)
    good = [c for c in candidates if c[2] <= best + 1e-6]
    chosen = candidates[0] if candidates[0][2] <= best + 1e-6 else min(good, key=lambda c: _angle(c[0], R0))
    note = None
    turns = {round(_angle(c[0], chosen[0]), 3) for c in good}
    if candidates[0] is not chosen and len(turns) > 1:
        note = f"the pattern fits {len(turns)} ways (it's symmetric); chose the one closest to the instance's rot. Use spin (e.g. 180) to turn it about the normal."
    R, t = chosen[0], chosen[1]
    M = np.eye(4)
    M[:3, :3], M[:3, 3] = R, t
    s["order"] = chosen[3]
    if s["spin"]:
        M = about(cQ, n_t, s["spin"]) @ M
    return M, note


def _pair(A: np.ndarray, B: np.ndarray):
    """Greedy nearest-neighbour pairing of two equally long point lists; order[i] is A[i]'s partner."""
    d = np.linalg.norm(A[:, None, :] - B[None, :, :], axis=2)
    order = -np.ones(len(A), dtype=np.int64)
    used = set()
    for flat_i in np.argsort(d, axis=None):
        i, j = divmod(int(flat_i), len(B))
        if order[i] >= 0 or j in used:
            continue
        order[i] = j
        used.add(j)
    return order if (order >= 0).all() else None


def _kabsch(A: np.ndarray, B: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """R, t minimising |A·Rᵀ + t − B| (proper rotation)."""
    cA, cB = A.mean(axis=0), B.mean(axis=0)
    H = (A - cA).T @ (B - cB)
    U, _, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T)) or 1.0
    R = Vt.T @ np.diag([1.0, 1.0, d]) @ U.T
    return R, cB - R @ cA


def _refine(snaps: list[dict], M0: np.ndarray) -> np.ndarray:
    """Meet every snap together by least squares, starting from the first snap's placement (and a few
    quarter turns about its main direction, in case the second snap needs one)."""
    first = snaps[0]
    tgt = first["tgt"]
    axis = _unit(tgt.get("normal") or tgt.get("direction") or [0, 0, 1])
    pivot = np.array(tgt.get("origin") or tgt.get("at"))
    starts = [about(pivot, axis, a) @ M0 for a in (0, 90, 180, 270)]
    if first["kind"] == "point":
        starts += [about(pivot, ax, a) @ M0 for ax in np.eye(3) for a in (90, 180, 270)]
    best = None
    for k, start in enumerate(starts):
        M = _lm(snaps, start, pivot)
        cost = float(np.linalg.norm(_residuals(snaps, M)))
        if best is None or cost < best[0] - 1e-9:
            best = (cost, M)
    return best[1]


def _lm(snaps, M0, pivot, iters: int = 60) -> np.ndarray:
    def at(x):
        m = np.eye(4)
        w = x[:3]
        ang = np.linalg.norm(w)
        m[:3, :3] = rotation(w / ang, math.degrees(ang)) if ang > 1e-15 else np.eye(3)
        m[:3, 3] = pivot + x[3:] - m[:3, :3] @ pivot
        return m @ M0

    x = np.zeros(6)
    r = _residuals(snaps, at(x))
    for _ in range(iters):
        J = np.empty((len(r), 6))
        for k in range(6):
            dx = np.zeros(6)
            dx[k] = 1e-7
            J[:, k] = (_residuals(snaps, at(x + dx)) - r) / 1e-7
        step = np.linalg.lstsq(J, -r, rcond=1e-10)[0]  # minimum norm: free directions don't move
        x2 = x + step
        r2 = _residuals(snaps, at(x2))
        if np.linalg.norm(r2) <= np.linalg.norm(r):
            x, r = x2, r2
            if np.linalg.norm(step) < 1e-13:
                break
        else:
            step *= 0.5
            x2 = x + step
            r2 = _residuals(snaps, at(x2))
            if np.linalg.norm(r2) < np.linalg.norm(r):
                x, r = x2, r2
            else:
                break
    return at(x)


def _residuals(snaps, M) -> np.ndarray:
    """What each snap still misses with the instance at M: only what the snap pins down."""
    R, t = M[:3, :3], M[:3, 3]
    out = []
    L = 10.0  # mm per radian, to weigh angles against distances
    for s in snaps:
        own, tgt = s["own"], s["tgt"]
        if s["kind"] == "plane":
            n_t = _unit(tgt["normal"])
            o = R @ own["origin"] + t
            goal = n_t if s["flip"] else -n_t
            out += [float((o - tgt["origin"]) @ n_t - s["offset"])]
            out += list(L * (R @ _unit(own["normal"]) - goal))
        elif s["kind"] == "axis":
            d_t = _unit(tgt["direction"])
            v = R @ own["origin"] + t - tgt["origin"]
            out += list(v - (v @ d_t) * d_t)
            out += list(L * (R @ _unit(own["direction"]) - (-d_t if s["flip"] else d_t)))
        elif s["kind"] == "point":
            out += list(R @ own["at"] + t - tgt["at"])
        else:
            n_t = _unit(tgt["normal"])
            Q = np.array(tgt["points"]) + s["offset"] * n_t
            order = s.get("order")
            if order is None:
                _fit_pattern(s, np.eye(3))
                order = s["order"]
            out += list((np.array(own["points"]) @ R.T + t - Q[order]).reshape(-1))
            out += list(L * (R @ _unit(own["normal"]) - (n_t if s["flip"] else -n_t)))
    return np.array(out)


def _measure(s: dict, M) -> dict:
    """How well a snap is met: residual mm and degrees (and per point for patterns)."""
    R, t = M[:3, :3], M[:3, 3]
    own, tgt = s["own"], s["tgt"]
    if s["kind"] == "plane":
        n_t = _unit(tgt["normal"])
        o = R @ own["origin"] + t
        return {"residual_mm": abs(float((o - tgt["origin"]) @ n_t - s["offset"])), "residual_deg": _deg(R @ own["normal"], n_t if s["flip"] else -n_t)}
    if s["kind"] == "axis":
        d_t = _unit(tgt["direction"])
        v = R @ own["origin"] + t - tgt["origin"]
        return {"residual_mm": float(np.linalg.norm(v - (v @ d_t) * d_t)), "residual_deg": _deg(R @ own["direction"], -d_t if s["flip"] else d_t)}
    if s["kind"] == "point":
        return {"residual_mm": float(np.linalg.norm(R @ own["at"] + t - tgt["at"])), "residual_deg": 0.0}
    n_t = _unit(tgt["normal"])
    Q = np.array(tgt["points"]) + s["offset"] * n_t
    order = s.get("order")
    if order is None:
        _fit_pattern(s, np.eye(3))
        order = s["order"]
    placed = np.array(own["points"]) @ R.T + t
    err = np.linalg.norm(placed - Q[order], axis=1)
    return {
        "residual_mm": float(err.max()),
        "rms_mm": float(np.sqrt((err**2).mean())),
        "points_mm": [float(e) for e in err],
        "pairs": [int(j) + 1 for j in order],
        "at": [[float(c) for c in p] for p in placed],
        "residual_deg": _deg(R @ own["normal"], n_t if s["flip"] else -n_t),
    }


# ---------------------------------------------------------------- requirements


def requirements(layout: Layout, reqs: list[dict]) -> list[dict]:
    """Findings for declared alignment requirements: coaxial, parallel, distance."""
    out = []
    for q in reqs or []:
        kind = q.get("kind")
        label = q.get("name") or f"{kind}({q.get('a')}, {q.get('b')}{', ' + str(q.get('value')) if kind == 'distance' else ''})"
        insts = [layout.prefix + str(q.get(k, "")).partition(".")[0] for k in ("a", "b")]
        try:
            a, b = (layout.world_datum(*_split(str(q.get(k, "")))) for k in ("a", "b"))
        except Unresolved as why:
            out.append(_finding("warning", "requirement", insts, f"{label} can't be checked: {why}", requirement=label))
            continue
        except ValueError as why:
            out.append(_finding("warning", "requirement", insts, f"{label} can't be checked: {why}", requirement=label))
            continue
        tol_mm = float(q.get("tol_mm", q.get("tol", REQ_MM)) if q.get("tol_mm", q.get("tol")) is not None else REQ_MM)
        tol_deg = float(q["tol_deg"]) if q.get("tol_deg") is not None else REQ_DEG
        try:
            if kind == "coaxial":
                if a["kind"] != "axis" or b["kind"] != "axis":
                    raise ValueError("coaxial needs two axes")
                da, db = _unit(a["direction"]), _unit(b["direction"])
                ang = math.degrees(math.acos(min(1.0, abs(float(da @ db)))))
                off = max(_line_gap(b["origin"], a["origin"], da), _line_gap(a["origin"], b["origin"], db))
                ok = ang <= tol_deg and off <= tol_mm
                msg = f"{label}: axes {ang:.4f}° apart (tolerance {tol_deg:g}°) and {off:.4f} mm apart (tolerance {tol_mm:g} mm)"
                out.append(_finding("info" if ok else "warning", "requirement", insts, msg + (" ✓" if ok else " ✗"), value=ang if ang / tol_deg >= off / tol_mm else off, unit="deg" if ang / tol_deg >= off / tol_mm else "mm", at=b["origin"], requirement=label, ok=ok, measures=[{"name": "angle", "value": ang, "unit": "deg", "tol": tol_deg}, {"name": "offset", "value": off, "unit": "mm", "tol": tol_mm}]))
            elif kind == "parallel":
                va, vb = _direction(a), _direction(b)
                if a["kind"] != b["kind"] and "plane" in (a["kind"], b["kind"]) and "axis" in (a["kind"], b["kind"]):
                    ang = math.degrees(math.asin(min(1.0, abs(float(va @ vb)))))  # the axis lies along the plane
                else:
                    ang = math.degrees(math.acos(min(1.0, abs(float(va @ vb)))))
                ok = ang <= tol_deg
                out.append(_finding("info" if ok else "warning", "requirement", insts, f"{label}: {ang:.4f}° out of parallel (tolerance {tol_deg:g}°)" + (" ✓" if ok else " ✗"), value=ang, unit="deg", requirement=label, ok=ok, measures=[{"name": "angle", "value": ang, "unit": "deg", "tol": tol_deg}]))
            elif kind == "distance":
                want = float(q["value"])
                d = _distance(a, b)
                dev = abs(d - want)
                ok = dev <= tol_mm
                out.append(_finding("info" if ok else "warning", "requirement", insts, f"{label}: measured {d:.4f} mm, wanted {want:g} ± {tol_mm:g} mm (off by {dev:.4f} mm)" + (" ✓" if ok else " ✗"), value=d, unit="mm", requirement=label, ok=ok, measures=[{"name": "distance", "value": d, "unit": "mm", "tol": tol_mm}, {"name": "deviation", "value": dev, "unit": "mm", "tol": tol_mm}]))
            else:
                raise ValueError(f"unknown requirement kind {kind!r} (coaxial, parallel, distance)")
        except (ValueError, KeyError) as why:
            out.append(_finding("warning", "requirement", insts, f"{label} can't be checked: {why}", requirement=label))
    return out


def _split(ref: str) -> tuple[str, str]:
    path, _, name = ref.partition(".")
    if not path or not name:
        raise ValueError(f'name a datum as "<instance>.<datum>", not {ref!r}')
    return path, name


def _direction(d: dict) -> np.ndarray:
    if d["kind"] == "plane":
        return _unit(d["normal"])
    if d["kind"] == "axis":
        return _unit(d["direction"])
    if d["kind"] == "pattern":
        return _unit(d["normal"])
    raise ValueError("a point has no direction")


def _anchor(d: dict) -> np.ndarray:
    if d["kind"] == "point":
        return np.array(d["at"])
    if d["kind"] == "pattern":
        return np.array(d["points"]).mean(axis=0)
    return np.array(d["origin"])


def _distance(a: dict, b: dict) -> float:
    ka, kb = a["kind"], b["kind"]
    if ka == "plane" or kb == "plane":
        plane, other = (a, b) if ka == "plane" else (b, a)
        return abs(float((_anchor(other) - np.array(plane["origin"])) @ _unit(plane["normal"])))
    if ka == "axis" and kb == "axis":
        da, db = _unit(a["direction"]), _unit(b["direction"])
        c = np.cross(da, db)
        w = np.array(b["origin"]) - np.array(a["origin"])
        if np.linalg.norm(c) < 1e-9:
            return _line_gap(b["origin"], a["origin"], da)
        return abs(float(w @ c)) / float(np.linalg.norm(c))
    if ka == "axis" or kb == "axis":
        axis, other = (a, b) if ka == "axis" else (b, a)
        return _line_gap(_anchor(other), axis["origin"], _unit(axis["direction"]))
    return float(np.linalg.norm(_anchor(a) - _anchor(b)))


# ---------------------------------------------------------------- helpers


def _finding(severity: str, kind: str, instances: list[str], message: str, **extra) -> dict:
    f = {"kind": kind, "severity": severity, "instances": instances, "message": message}
    for k, v in extra.items():
        if v is not None:
            f[k] = [float(x) for x in v] if k == "at" else v
    return f


def _flat(v, n) -> np.ndarray:
    return v - (v @ n) * n


def _angle(Ra, Rb) -> float:
    c = (np.trace(Ra @ Rb.T) - 1) / 2
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def _deg(a, b) -> float:
    return math.degrees(math.acos(max(-1.0, min(1.0, float(_unit(a) @ _unit(b))))))


def _line_gap(p, o, d) -> float:
    v = np.array(p) - np.array(o)
    return float(np.linalg.norm(v - (v @ d) * d))


def _unit(v) -> np.ndarray:
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)
