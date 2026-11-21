"""Tessellation that keeps B-rep identity: every triangle knows its face, every
polyline its edge, so the viewer can pick a face and the AI can be told which."""

from __future__ import annotations

import base64
import math

import numpy as np


def tessellate(shape) -> dict:
    bb = shape.bounding_box()
    diag = max(bb.diagonal, 1e-6)
    tol = max(0.005, diag * 0.0006)
    angular = 0.2

    positions: list[np.ndarray] = []
    indices: list[np.ndarray] = []
    face_ranges: list[list[int]] = []
    face_info: list[dict] = []
    offset = tri_start = 0
    for face in shape.faces():
        verts, tris = face.tessellate(tol, angular)
        if not tris:
            face_ranges.append([tri_start, 0])
            face_info.append(_face_info(face))
            continue
        v = np.array([(p.X, p.Y, p.Z) for p in verts], dtype=np.float32)
        t = np.array(tris, dtype=np.uint32) + offset
        positions.append(v)
        indices.append(t)
        face_ranges.append([tri_start, len(t)])
        face_info.append(_face_info(face))
        offset += len(v)
        tri_start += len(t)

    edge_points: list[np.ndarray] = []
    edge_ranges: list[list[int]] = []
    seg_start = 0
    for edge in shape.edges():
        pts = _sample_edge(edge, tol)
        segs = np.concatenate([pts[:-1], pts[1:]], axis=1).reshape(-1, 3) if len(pts) > 1 else np.zeros((0, 3), np.float32)
        edge_points.append(segs.astype(np.float32))
        edge_ranges.append([seg_start, len(segs) // 2])
        seg_start += len(segs) // 2

    pos = np.concatenate(positions) if positions else np.zeros((0, 3), np.float32)
    idx = np.concatenate(indices) if indices else np.zeros((0, 3), np.uint32)
    edges = np.concatenate(edge_points) if edge_points else np.zeros((0, 3), np.float32)
    return {
        "positions": _b64(pos),
        "indices": _b64(idx.astype(np.uint32)),
        "edges": _b64(edges),
        "faceRanges": face_ranges,
        "edgeRanges": edge_ranges,
        "faces": face_info,
        # Kept server-side for the render; stripped before the mesh is stored.
        "_arrays": {"positions": pos, "indices": idx, "edges": edges},
    }


def _face_info(face) -> dict:
    kind = str(face.geom_type).split(".")[-1].lower()
    center = face.center()
    info = {"type": kind, "area": round(face.area, 3), "center": [round(center.X, 3), round(center.Y, 3), round(center.Z, 3)]}
    try:
        n = face.normal_at(center) if kind == "plane" else None
        if n is not None:
            info["normal"] = [round(n.X, 4), round(n.Y, 4), round(n.Z, 4)]
    except Exception:
        pass
    if kind == "cylinder":
        try:
            info["radius"] = round(face.radius, 4)
        except Exception:
            pass
    return info


def _sample_edge(edge, tol: float) -> np.ndarray:
    if str(edge.geom_type).endswith("LINE"):
        ts = [0.0, 1.0]
    else:
        n = int(min(256, max(8, math.ceil(edge.length / max(tol * 40, 0.25)))))
        ts = list(np.linspace(0.0, 1.0, n + 1))
    pts = edge.positions(ts)
    return np.array([(p.X, p.Y, p.Z) for p in pts], dtype=np.float32)


def _b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()
