"""A four-view sheet (iso, front, top, right) of a tessellated part, for the AI to look at.

A small numpy z-buffer rasterizer: no GPU or OpenGL, so it runs the same in a
container as on a laptop. B-rep edges are drawn where the z-buffer says they're
visible.
"""

from __future__ import annotations

import io

import numpy as np
from PIL import Image, ImageDraw, ImageFont

CELL = 420
SS = 2  # supersampling for anti-aliasing
VIEWS = [
    # name, view direction (camera looks along -dir), up vector
    ("iso", (1.0, -1.0, 0.8), (0.0, 0.0, 1.0)),
    ("front  (-Y)", (0.0, -1.0, 0.0), (0.0, 0.0, 1.0)),
    ("top  (+Z)", (0.0, 0.0, 1.0), (0.0, 1.0, 0.0)),
    ("right  (+X)", (1.0, 0.0, 0.0), (0.0, 0.0, 1.0)),
]
# Named views an inspection can ask for, besides an explicit direction.
PRESETS = {
    "iso": VIEWS[0],
    "front": VIEWS[1],
    "top": VIEWS[2],
    "right": VIEWS[3],
    "back": ("back  (+Y)", (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)),
    "left": ("left  (-X)", (-1.0, 0.0, 0.0), (0.0, 0.0, 1.0)),
    "bottom": ("bottom  (-Z)", (0.0, 0.0, -1.0), (0.0, -1.0, 0.0)),
    "iso-back": ("iso back", (-1.0, 1.0, 0.8), (0.0, 0.0, 1.0)),
    "iso-below": ("iso below", (1.0, -1.0, -0.8), (0.0, 0.0, 1.0)),
}
BASE = np.array([196, 200, 207], dtype=np.float64)
EDGE = (30, 32, 36)


def render_views(mesh: dict, views: list | None = None, cell: int = CELL) -> bytes:
    """A sheet of views, two per row. `views` are (name, direction, up) tuples; default iso/front/top/right."""
    views = views or VIEWS
    arrays = mesh["_arrays"]
    pos, tris, edges = arrays["positions"].astype(np.float64), arrays["indices"].astype(np.int64), arrays["edges"].astype(np.float64)
    cols = 1 if len(views) == 1 else 2
    rows = (len(views) + cols - 1) // cols
    sheet = Image.new("RGB", (cell * cols, cell * rows), (255, 255, 255))
    lo, hi = pos.min(axis=0), pos.max(axis=0)
    size = hi - lo
    for i, (name, d, up) in enumerate(views):
        img = _render_one(pos, tris, edges, np.array(d, dtype=np.float64), np.array(up, dtype=np.float64), cell=cell)
        sheet.paste(img, ((i % cols) * cell, (i // cols) * cell))
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    for i, (name, _, _) in enumerate(views):
        draw.text(((i % cols) * cell + 10, (i // cols) * cell + 8), name, fill=(90, 94, 100), font=font)
    for c in range(1, cols):
        draw.line([(cell * c, 0), (cell * c, cell * rows)], fill=(225, 227, 230))
    for r in range(1, rows):
        draw.line([(0, cell * r), (cell * cols, cell * r)], fill=(225, 227, 230))
    dims = f"bbox {size[0]:.1f} x {size[1]:.1f} x {size[2]:.1f} mm   X red  Y green  Z blue"
    draw.text((10, cell * rows - 18), dims, fill=(90, 94, 100), font=font)
    buf = io.BytesIO()
    sheet.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def render_thumb(mesh: dict) -> bytes:
    """The iso view alone, cropped to 16:10, for project cards."""
    arrays = mesh["_arrays"]
    pos, tris, edges = arrays["positions"].astype(np.float64), arrays["indices"].astype(np.int64), arrays["edges"].astype(np.float64)
    name, d, up = VIEWS[0]
    img = _render_one(pos, tris, edges, np.array(d), np.array(up), triad=False)
    h = int(CELL * 10 / 16)
    top = (CELL - h) // 2
    buf = io.BytesIO()
    img.crop((0, top, CELL, top + h)).save(buf, "PNG", optimize=True)
    return buf.getvalue()


def _basis(d: np.ndarray, up: np.ndarray):
    fwd = d / np.linalg.norm(d)  # from target toward camera
    right = np.cross(up, fwd)
    if np.linalg.norm(right) < 1e-6:
        right = np.cross(np.array([0.0, 1.0, 0.0]), fwd)
    right /= np.linalg.norm(right)
    true_up = np.cross(fwd, right)
    return right, true_up, fwd


def _render_one(pos, tris, edges, d, up, triad: bool = True, cell: int = CELL) -> Image.Image:
    W = cell * SS
    right, true_up, fwd = _basis(d, up)
    center = (pos.min(axis=0) + pos.max(axis=0)) / 2
    project = lambda p: np.stack([(p - center) @ right, (p - center) @ true_up, (p - center) @ fwd], axis=-1)
    P = project(pos)
    extent = max(np.abs(P[:, :2]).max(), 1e-6)
    scale = (W * 0.40) / extent
    to_px = lambda q: np.stack([W / 2 + q[..., 0] * scale, W / 2 - q[..., 1] * scale, q[..., 2]], axis=-1)

    color = np.full((W, W, 3), 255.0)
    zbuf = np.full((W, W), -np.inf)
    if len(tris):
        A, B, C = P[tris[:, 0]], P[tris[:, 1]], P[tris[:, 2]]
        n = np.cross(B - A, C - A)
        nn = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        light = np.array([-0.35, 0.55, 0.76])
        shade = 0.5 + 0.5 * np.clip(nn @ light, 0, 1)
        T = to_px(np.stack([A, B, C], axis=1))
        for k in np.nonzero(n[:, 2] > 0)[0]:
            _raster(T[k], BASE * shade[k], color, zbuf)
    img = Image.fromarray(color.astype(np.uint8))
    if len(edges):
        E = to_px(project(edges).reshape(-1, 2, 3))
        bias = extent * scale * 0.006
        draw = ImageDraw.Draw(img)
        for a, b in E:
            steps = max(2, int(np.hypot(*(b[:2] - a[:2])) / 2))
            t = np.linspace(0, 1, steps)
            pts = a[None, :] * (1 - t[:, None]) + b[None, :] * t[:, None]
            xi = np.clip(pts[:, 0].astype(int), 0, W - 1)
            yi = np.clip(pts[:, 1].astype(int), 0, W - 1)
            seen = pts[:, 2] * scale + bias >= zbuf[yi, xi] * scale
            # Draw the visible runs of the segment.
            run = None
            for i in range(steps):
                if seen[i] and run is None:
                    run = i
                if (not seen[i] or i == steps - 1) and run is not None:
                    j = i if seen[i] else i - 1
                    if j > run:
                        draw.line([tuple(pts[run, :2]), tuple(pts[j, :2])], fill=EDGE, width=SS)
                    run = None
    if triad:
        _triad(ImageDraw.Draw(img), right, true_up, W)
    return img.resize((cell, cell), Image.LANCZOS)


def _raster(t: np.ndarray, rgb: np.ndarray, color: np.ndarray, zbuf: np.ndarray) -> None:
    """Fill one screen-space triangle (x, y, depth) into the z-buffer; larger depth is nearer."""
    W = zbuf.shape[0]
    x0, x1 = int(max(np.floor(t[:, 0].min()), 0)), int(min(np.ceil(t[:, 0].max()), W - 1))
    y0, y1 = int(max(np.floor(t[:, 1].min()), 0)), int(min(np.ceil(t[:, 1].max()), W - 1))
    if x1 < x0 or y1 < y0:
        return
    xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
    (ax, ay, az), (bx, by, bz), (cx, cy, cz) = t
    den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if abs(den) < 1e-12:
        return
    w0 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / den
    w1 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / den
    w2 = 1 - w0 - w1
    inside = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
    z = w0 * az + w1 * bz + w2 * cz
    region = zbuf[y0 : y1 + 1, x0 : x1 + 1]
    win = inside & (z > region)
    region[win] = z[win]
    color[y0 : y1 + 1, x0 : x1 + 1][win] = rgb


def _triad(draw: ImageDraw.ImageDraw, right, true_up, W: int) -> None:
    origin = np.array([W - 40 * SS, W - 40 * SS])
    for axis, color in zip(np.eye(3), [(220, 60, 60), (40, 160, 90), (60, 100, 220)]):
        v = np.array([axis @ right, -(axis @ true_up)]) * 24 * SS
        if np.linalg.norm(v) < 2:
            continue
        draw.line([tuple(origin), tuple(origin + v)], fill=color, width=2 * SS)
