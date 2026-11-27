"""Assembly guides: path checks and step sheets.

The Worker samples every motion with web/shared/guide.ts (the same maths the viewer plays it with)
and sends matrices; this module only measures and draws.

Path check: at each sample, each moving instance is tested against every other instance shown,
per solid: boxes first, then the exact OpenCASCADE common volume. Pairs that already overlap when
assembled are left to the assembly check. One finding per step and pair: when they first touch,
the most they overlap and where.

Step sheet: one picture per step from its camera, framed on what the step is about. Instances out
of focus are drawn faded, those still to come in a build guide faint; labels are dots with text, and
dark arrows show where things moved.
"""

from __future__ import annotations

import base64
import io
import time
from functools import cached_property

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from geometry.render import BASE, EDGE, SS, _basis, _edges, _raster_all, _triad

OVERLAP = 0.01  # mm³: more common volume than this is a clash on the way
TRAIL = (38, 42, 52)  # dark with a white halo: reads over any part colour
LABEL = (200, 40, 90)


def guide_in(job: dict, environment, mesh_of) -> dict:
    """job: leaves [{path, name, key, matrix, color}], check [{step, duration, present, static, samples:
    [{t, m: {path: matrix}, active: [path]}]}], sheet {cells, size, thumb}, time_limit.

    `mesh_of(key, shape)` gives a leaf's render arrays in its own frame.
    """
    started = time.perf_counter()
    leaves = {l["path"]: l for l in job.get("leaves") or []}
    shapes: dict = {}
    problems: list[str] = []
    for path, l in leaves.items():
        if l["key"] in shapes:
            continue
        try:
            shapes[l["key"]] = environment.shape_of(l["key"])
        except Exception as exc:
            problems.append(f"{path} ({l['key']}) couldn't be built: {exc}")
    reply: dict = {"ok": True, "findings": [], "partial": False, "samples": 0, "check_ms": 0, "problems": problems}
    if job.get("check"):
        t0 = time.perf_counter()
        limit = max(1.0, float(job.get("time_limit") or 30) - (t0 - started))
        reply.update(path_check(job["check"], leaves, shapes, limit))
        reply["check_ms"] = round((time.perf_counter() - t0) * 1000)
    sheet = job.get("sheet")
    if sheet and sheet.get("cells"):
        meshes: dict = {}
        for l in leaves.values():
            if l["key"] in shapes and l["key"] not in meshes:
                meshes[l["key"]] = mesh_of(l["key"], shapes[l["key"]])
        size = max(200, min(int(sheet.get("size") or 360), 800))
        png, thumb = draw_sheet(sheet["cells"], leaves, meshes, size, bool(sheet.get("thumb")))
        if png:
            reply["sheet"] = base64.b64encode(png).decode()
        if thumb:
            reply["thumb"] = base64.b64encode(thumb).decode()
    return reply


# ---------------------------------------------------------------- path check


def path_check(steps: list, leaves: dict, shapes: dict, time_limit: float) -> dict:
    started = time.perf_counter()
    # Each shape's solids with the corners of their boxes, in the shape's own frame.
    solids = {key: _prepare(shape) for key, shape in shapes.items()}
    findings: list = []
    assembled = {p: np.array(l["matrix"], dtype=np.float64).reshape(4, 4) for p, l in leaves.items()}
    assembled_overlap: dict = {}
    samples = 0
    partial = False
    for st in steps:
        present = [p for p in st["present"] if p in leaves and leaves[p]["key"] in solids]
        static = {p: np.array(st["static"][p], dtype=np.float64).reshape(4, 4) for p in present}
        # Once a pair is known to clash, look again only now and then: the first moment is already
        # exact, and the worst one doesn't need every sample.
        stride = max(1, len(st["samples"]) // 24)
        hits: dict = {}  # pair -> {mover, other, first, last, volume, t, at}
        for k, sample in enumerate(st["samples"]):
            if time.perf_counter() - started > time_limit:
                partial = True
                break
            samples += 1
            mats = dict(static)
            for p, m in sample["m"].items():
                if p in static:
                    mats[p] = np.array(m, dtype=np.float64).reshape(4, 4)
            active = [p for p in sample["active"] if p in mats]
            done: set = set()
            for a in active:
                for b in present:
                    pair = tuple(sorted((a, b)))
                    if b == a or pair in done or (pair in hits and k % stride):
                        continue
                    done.add(pair)
                    # Still as they sit assembled to each other (a sub-assembly moving as one): the
                    # assembly check covers that.
                    if np.allclose(np.linalg.inv(mats[a]) @ mats[b], np.linalg.inv(assembled[a]) @ assembled[b], atol=1e-6):
                        continue
                    vol, at = _overlap(solids[leaves[a]["key"]], mats[a], solids[leaves[b]["key"]], mats[b])
                    if vol <= OVERLAP:
                        continue
                    if pair not in assembled_overlap:
                        assembled_overlap[pair] = _overlap(solids[leaves[a]["key"]], assembled[a], solids[leaves[b]["key"]], assembled[b])[0] > OVERLAP
                    if assembled_overlap[pair]:
                        continue
                    h = hits.setdefault(pair, {"mover": a, "other": b, "first": sample["t"], "volume": 0.0})
                    h["last"] = sample["t"]
                    if vol > h["volume"]:
                        h.update(volume=vol, t=sample["t"], at=at)
        for h in hits.values():
            a, b = h["mover"], h["other"]
            span = f"from t = {h['first']:.2f} s" + (f" to {h['last']:.2f} s" if h["last"] > h["first"] else "")
            findings.append(
                {
                    "kind": "path_clash",
                    "severity": "warning",
                    "step": st["step"],
                    "t": round(float(h["first"]), 3),
                    "instances": [a, b],
                    "value": float(h["volume"]),
                    "unit": "mm³",
                    "at": [round(float(x), 3) for x in h["at"]],
                    "message": f"Step {st['step'] + 1}: {a} passes through {b} on its way, {span} of {st['duration']:.2f} s; worst about {h['volume']:.4g} mm³ at t = {h['t']:.2f} s around ({_fmt(h['at'])}).",
                }
            )
        if partial:
            break
    return {"findings": findings, "partial": partial, "samples": samples}


def _prepare(shape) -> list:
    """Each solid of a shape with what _overlap needs, in the shape's own frame."""
    return [_Solid(s) for s in (shape.solids() or [shape])]


class _Solid:
    """A solid and, worked out when first needed, its faces' box corners, a point on its boundary,
    whether it's closed, its volume and centre (all in its own frame)."""

    def __init__(self, solid):
        self.solid = solid
        self.corners = _corners(solid)
        self._classifier = None

    @cached_property
    def faces(self) -> np.ndarray:
        return np.array([_corners(f) for f in self.solid.faces()], dtype=np.float64).reshape(-1, 8, 3)

    @cached_property
    def point(self) -> np.ndarray:
        vs = self.solid.vertices()
        p = vs[0].center() if vs else self.solid.faces()[0].center()
        return np.array([p.X, p.Y, p.Z], dtype=np.float64)

    @cached_property
    def closed(self) -> bool:
        """Watertight and the right way out. Vendor STEPs have open and inside-out shells (a point far
        away classifies as inside), and classifying points against those means nothing."""
        from OCP.BRepClass3d import BRepClass3d_SolidClassifier
        from OCP.gp import gp_Pnt
        from OCP.ShapeAnalysis import ShapeAnalysis_Shell
        from OCP.TopAbs import TopAbs_OUT

        check = ShapeAnalysis_Shell()
        check.LoadShells(self.solid.wrapped)
        check.CheckOrientedShells(self.solid.wrapped, True)
        if check.NbLoaded() == 0 or check.HasFreeEdges():
            return False
        far = self.corners.max(axis=0) + 1000.0
        return BRepClass3d_SolidClassifier(self.solid.wrapped, gp_Pnt(*[float(x) for x in far]), 1e-6).State() == TopAbs_OUT

    @cached_property
    def volume(self) -> float:
        return self.solid.volume

    @cached_property
    def center(self) -> np.ndarray:
        c = self.solid.center()
        return np.array([c.X, c.Y, c.Z], dtype=np.float64)

    def contains(self, p: np.ndarray) -> bool:
        """Is the point (in the solid's own frame) inside it? Only meaningful for a closed solid."""
        from OCP.BRepClass3d import BRepClass3d_SolidClassifier
        from OCP.gp import gp_Pnt
        from OCP.TopAbs import TopAbs_IN

        if np.any(p < self.corners.min(axis=0)) or np.any(p > self.corners.max(axis=0)):
            return False
        if self._classifier is None:
            self._classifier = BRepClass3d_SolidClassifier(self.solid.wrapped)
        self._classifier.Perform(gp_Pnt(*[float(x) for x in p]), 1e-6)
        return self._classifier.State() == TopAbs_IN


def _face_boxes(s: _Solid, m: np.ndarray) -> tuple:
    p = s.faces @ m[:3, :3].T + m[:3, 3]
    return p.min(axis=1), p.max(axis=1)


def _overlap(sa: list, ma: np.ndarray, sb: list, mb: np.ndarray) -> tuple[float, list]:
    """Common volume of two placed shapes (lists of _Solid) and its centroid.

    Boxes first. Then, if no face box of one solid overlaps a face box of the other, their
    boundaries can't cross, so one is inside the other (a point classification says which) or they
    are apart. Only solids whose faces may cross get the exact boolean: a board of hundreds of
    solids sitting in a tray costs a few box tests, not hundreds of booleans.
    """
    boxes_a = [_box(s.corners, ma) for s in sa]
    boxes_b = [_box(s.corners, mb) for s in sb]
    if not _hit(_union(boxes_a), _union(boxes_b)):
        return 0.0, []
    total, moment = 0.0, np.zeros(3)
    loc_a = loc_b = None
    faces_a: dict = {}
    faces_b: dict = {}
    for i, (a, box_a) in enumerate(zip(sa, boxes_a)):
        for j, (b, box_b) in enumerate(zip(sb, boxes_b)):
            if not _hit(box_a, box_b):
                continue
            fa = faces_a.get(i) or faces_a.setdefault(i, _face_boxes(a, ma))
            fb = faces_b.get(j) or faces_b.setdefault(j, _face_boxes(b, mb))
            crossing = np.any(np.all((fa[0][:, None] < fb[1][None] - 1e-6) & (fb[0][None] < fa[1][:, None] - 1e-6), axis=2))
            if not crossing:
                # Apart, or one wholly inside the other. Only a closed solid can tell what's inside it;
                # a contained open one gets the boolean below.
                if b.closed and b.contains(_to_local(mb, _apply(ma, a.point))):
                    inner = (a, ma)
                elif a.closed and a.contains(_to_local(ma, _apply(mb, b.point))):
                    inner = (b, mb)
                else:
                    continue
                if inner[0].closed:
                    total += inner[0].volume
                    moment += inner[0].volume * _apply(inner[1], inner[0].center)
                    continue
            if loc_a is None:
                loc_a, loc_b = _location(ma), _location(mb)
            try:
                common = a.solid.moved(loc_a) & b.solid.moved(loc_b)
            except Exception:
                continue
            if common is None or not common.solids():
                continue
            v = common.volume
            if v > 1e-9:
                c = common.center()
                total += v
                moment += v * np.array([c.X, c.Y, c.Z])
    return total, (moment / total).tolist() if total > 0 else []


def _apply(m: np.ndarray, p: np.ndarray) -> np.ndarray:
    return m[:3, :3] @ p + m[:3, 3]


def _to_local(m: np.ndarray, p: np.ndarray) -> np.ndarray:
    return m[:3, :3].T @ (p - m[:3, 3])


def _corners(shape) -> np.ndarray:
    bb = shape.bounding_box(optimal=False)
    lo, hi = (bb.min.X, bb.min.Y, bb.min.Z), (bb.max.X, bb.max.Y, bb.max.Z)
    return np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])], dtype=np.float64)


def _box(corners: np.ndarray, m: np.ndarray) -> tuple:
    p = corners @ m[:3, :3].T + m[:3, 3]
    return p.min(axis=0), p.max(axis=0)


def _union(boxes: list) -> tuple:
    return np.min([b[0] for b in boxes], axis=0), np.max([b[1] for b in boxes], axis=0)


def _hit(a: tuple, b: tuple, tol: float = 1e-6) -> bool:
    """Boxes that overlap by more than touching (a common volume needs that)."""
    return bool(np.all(a[0] < b[1] - tol) and np.all(b[0] < a[1] - tol))


def _location(m: np.ndarray):
    from build123d import Location
    from OCP.gp import gp_Trsf

    t = gp_Trsf()
    t.SetValues(*[float(x) for x in m[:3, :].reshape(-1)])
    return Location(t)


def _fmt(v) -> str:
    return ", ".join(f"{x:.2f}" for x in v)


# ---------------------------------------------------------------- step sheet


def draw_sheet(cells: list, leaves: dict, meshes: dict, size: int, thumb: bool) -> tuple[bytes | None, bytes | None]:
    """A grid of step pictures, and (with thumb) a 16:10 thumbnail of the last one."""
    images = [_cell(c, leaves, meshes, size) for c in cells]
    images = [im for im in images if im is not None]
    if not images:
        return None, None
    cols = 1 if len(images) == 1 else 2 if len(images) <= 4 else 3
    rows = (len(images) + cols - 1) // cols
    sheet = Image.new("RGB", (size * cols, size * rows), (255, 255, 255))
    for i, im in enumerate(images):
        sheet.paste(im, ((i % cols) * size, (i // cols) * size))
    draw = ImageDraw.Draw(sheet)
    for c in range(1, cols):
        draw.line([(size * c, 0), (size * c, size * rows)], fill=(215, 218, 222))
    for r in range(1, rows):
        draw.line([(0, size * r), (size * cols, size * r)], fill=(215, 218, 222))
    buf = io.BytesIO()
    sheet.save(buf, "PNG", optimize=True)
    small = None
    if thumb:
        im = _cell({**cells[-1], "title": "", "labels": [], "warn": False}, leaves, meshes, 420, triad=False)
        if im is not None:
            h = int(420 * 10 / 16)
            top = (420 - h) // 2
            b = io.BytesIO()
            im.crop((0, top, 420, top + h)).save(b, "PNG", optimize=True)
            small = b.getvalue()
    return buf.getvalue(), small


def _rgb(hex_color: str) -> np.ndarray:
    h = (hex_color or "").lstrip("#")
    return np.array([int(h[i : i + 2], 16) for i in (0, 2, 4)], dtype=np.float64) if len(h) == 6 else BASE.copy()


def _cell(cell: dict, leaves: dict, meshes: dict, size: int, triad: bool = True) -> Image.Image | None:
    """One picture: solid instances z-buffered with edges, faded and ghost ones blended over them."""
    solid, clear = [], []  # (positions, indices, edges, rgb, alpha)
    for it in cell["items"]:
        leaf = leaves.get(it["path"])
        arrays = meshes.get(leaf["key"]) if leaf else None
        if arrays is None:
            continue
        m = np.array(it["matrix"], dtype=np.float64).reshape(4, 4)
        R, t = m[:3, :3], m[:3, 3]
        pos = arrays["positions"].astype(np.float64) @ R.T + t
        edges = arrays["edges"].astype(np.float64) @ R.T + t
        alpha = float(it["alpha"])
        entry = (it["path"], pos, arrays["indices"].astype(np.int64), edges, _rgb(leaf.get("color")), alpha, bool(it.get("ghost")))
        (solid if alpha >= 0.99 else clear).append(entry)
    if not solid and not clear:
        return None
    framed = set(cell.get("frame") or [])
    box_pts = [e[1] for e in solid + clear if not framed or e[0] in framed] or [e[1] for e in solid + clear]
    pts = np.concatenate(box_pts)
    lo, hi = pts.min(axis=0), pts.max(axis=0)

    W = size * SS
    right, true_up, fwd = _basis(np.array(cell["dir"], dtype=np.float64), np.array(cell["up"], dtype=np.float64))
    center = (lo + hi) / 2
    box = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
    project = lambda p: np.stack([(p - center) @ right, (p - center) @ true_up, (p - center) @ fwd], axis=-1)
    extent = max(np.abs(project(box)[:, :2]).max(), 1e-6)
    scale = (W * 0.36 * float(cell.get("zoom") or 1)) / extent
    oy = W * 0.03  # room for the title
    to_px = lambda q: np.stack([W / 2 + q[..., 0] * scale, W / 2 + oy - q[..., 1] * scale, q[..., 2]], axis=-1)
    light = np.array([-0.35, 0.55, 0.76])

    def layer(entries):
        if not entries:
            return None
        P = np.concatenate([project(e[1]) for e in entries])
        offsets = np.cumsum([0] + [len(e[1]) for e in entries[:-1]])
        tris = np.concatenate([e[2] + o for e, o in zip(entries, offsets)])
        rgb_v = np.concatenate([np.tile(e[4], (len(e[2]), 1)) for e in entries])
        alpha = np.concatenate([np.full(len(e[2]), e[5]) for e in entries])
        ghost = np.concatenate([np.full(len(e[2]), e[6]) for e in entries])
        A, B, C = P[tris[:, 0]], P[tris[:, 1]], P[tris[:, 2]]
        n = np.cross(B - A, C - A)
        nn = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        shade = 0.5 + 0.5 * np.clip(nn @ light, 0, 1)
        T = to_px(np.stack([A, B, C], axis=1))
        return {"T": T, "front": np.nonzero(n[:, 2] > 0)[0], "rgb": rgb_v * shade[:, None], "alpha": alpha, "ghost": ghost}

    color = np.full((W, W, 3), 255.0)
    zbuf = np.full((W, W), -np.inf)
    ids = np.full((W, W), -1, dtype=np.int64)
    s = layer(solid)
    if s is not None:
        _raster_all(s["T"], s["front"], ids, zbuf)
        hit = ids >= 0
        color[hit] = s["rgb"][ids[hit]]
        edges = np.concatenate([e[3] for e in solid])
        if len(edges):
            _edges(to_px(project(edges).reshape(-1, 2, 3)), color, zbuf, extent * 0.006)
    c = layer(clear)
    if c is not None:
        # The nearest see-through surface in front of the solid ones, blended over them. Ghosts are
        # drawn grey-blue so they don't read as parts already in place.
        zt = np.full((W, W), -np.inf)
        it = np.full((W, W), -1, dtype=np.int64)
        _raster_all(c["T"], c["front"], it, zt)
        on = (it >= 0) & (zt > zbuf)
        k = it[on]
        a = np.where(c["ghost"][k], 0.16, np.maximum(c["alpha"][k], 0.28))[:, None]
        tint = np.where(c["ghost"][k][:, None], np.array([150.0, 165.0, 190.0]) * (0.7 + 0.3 * c["rgb"][k] / 255), c["rgb"][k])
        color[on] = color[on] * (1 - a) + tint * a
    img = Image.fromarray(np.clip(color, 0, 255).astype(np.uint8))
    if triad:
        _triad(ImageDraw.Draw(img), right, true_up, W)
    img = img.resize((size, size), Image.LANCZOS)
    draw = ImageDraw.Draw(img)
    px = lambda p: to_px(project(np.array(p, dtype=np.float64)[None, :]))[0, :2] / SS
    for trail in cell.get("trails") or []:
        q = [tuple(px(p)) for p in trail]
        draw.line(q, fill=(255, 255, 255), width=5, joint="curve")
        draw.line(q, fill=TRAIL, width=2, joint="curve")
        x, y = q[0]
        draw.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(255, 255, 255), outline=TRAIL, width=2)
        _arrow(draw, q)
    small = _font(12)
    placed: list = []  # label boxes so far, so they don't cover each other
    for lab in cell.get("labels") or []:
        x, y = px(lab["point"])
        draw.ellipse([x - 4, y - 4, x + 4, y + 4], fill=LABEL, outline=(255, 255, 255))
        text = str(lab["text"])[:60]
        w = draw.textlength(text, font=small)
        clamp = lambda tx, ty: (min(max(tx, 4), size - w - 8), min(max(ty, 22), size - 18))
        tries = [clamp(x + dx * (8 if dx > 0 else w + 8), y + dy) for dy in (-18, 6, -38, 26, -58, 46) for dx in (1, -1)]
        tx, ty = next((p for p in tries if not any(p[0] - 4 < b[2] and b[0] < p[0] + w + 4 and p[1] - 2 < b[3] and b[1] < p[1] + 16 for b in placed)), tries[0])
        placed.append((tx - 3, ty - 1, tx + w + 3, ty + 15))
        draw.line([(x, y), (tx + (0 if tx > x else w), ty + 7)], fill=LABEL, width=1)
        draw.rectangle([tx - 3, ty - 1, tx + w + 3, ty + 15], fill=(255, 255, 255), outline=LABEL)
        draw.text((tx, ty), text, fill=(60, 20, 35), font=small)
    if cell.get("title"):
        title = _fit(draw, str(cell["title"]), _font(14), size - 16 - (22 if cell.get("warn") else 0))
        draw.text((8, 6), title, fill=(30, 32, 36), font=_font(14))
        if cell.get("warn"):
            x = size - 22
            draw.polygon([(x + 8, 7), (x + 16, 21), (x, 21)], fill=(240, 170, 30), outline=(150, 90, 0))
            draw.text((x + 6, 9), "!", fill=(60, 30, 0), font=_font(11))
    return img


def _arrow(draw: ImageDraw.ImageDraw, q: list) -> None:
    """An arrowhead at the end of a trail, along its last visible stretch."""
    end = np.array(q[-1])
    for p in reversed(q[:-1]):
        d = end - np.array(p)
        if np.linalg.norm(d) > 3:
            d = d / np.linalg.norm(d)
            n = np.array([-d[1], d[0]])
            a, b = end - 9 * d + 5 * n, end - 9 * d - 5 * n
            draw.polygon([tuple(end), tuple(a), tuple(b)], fill=TRAIL, outline=(255, 255, 255))
            return


_fonts: dict = {}


def _font(px: int):
    if px not in _fonts:
        try:
            _fonts[px] = ImageFont.load_default(size=px)
        except Exception:  # Pillow without FreeType
            _fonts[px] = ImageFont.load_default()
    return _fonts[px]


def _fit(draw: ImageDraw.ImageDraw, text: str, font, width: float) -> str:
    if draw.textlength(text, font=font) <= width:
        return text
    while text and draw.textlength(text + "…", font=font) > width:
        text = text[:-1]
    return text + "…"
