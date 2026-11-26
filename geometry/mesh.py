"""Tessellation that keeps B-rep identity: every triangle knows its face, every
polyline its edge, so the viewer can pick a face and the AI can be told which.

The whole shape is meshed once by OpenCASCADE and the triangulations are read face by
face (a vendor board with 7,000 faces takes about a second); edges are read from the
same mesh, so they line up with the triangles.
"""

from __future__ import annotations

import base64
import math

import numpy as np


def tessellate(shape, tol: float | None = None, info: bool = True) -> dict:
    """The viewer mesh of `shape`. `tol` overrides the deflection (coarser for pictures of big assemblies);
    info=False skips the per-face details, which only the viewer needs."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.TopAbs import TopAbs_REVERSED
    from OCP.TopLoc import TopLoc_Location

    if tol is None:
        # The quick box: the optimal one takes seconds on a vendor board.
        tol = max(0.005, max(shape.bounding_box(optimal=False).diagonal, 1e-6) * 0.0006)
    angular = 0.2
    BRepMesh_IncrementalMesh(shape.wrapped, tol, True, angular, True)

    positions: list[np.ndarray] = []
    indices: list[np.ndarray] = []
    face_ranges: list[list[int]] = []
    face_info: list[dict] = []
    # Each edge's polyline from the first face that has it, keyed by the edge.
    polylines: dict = {}
    offset = tri_start = 0
    for face in shape.faces():
        loc = TopLoc_Location()
        poly = BRep_Tool.Triangulation_s(face.wrapped, loc)
        if info:
            face_info.append(_face_info(face))
        if poly is None or poly.NbTriangles() == 0:
            face_ranges.append([tri_start, 0])
            continue
        v = _nodes(poly, loc)
        t = np.array([poly.Triangle(i).Get() for i in range(1, poly.NbTriangles() + 1)], dtype=np.int64) - 1
        if face.wrapped.Orientation() == TopAbs_REVERSED:
            t = t[:, [0, 2, 1]]
        positions.append(v)
        indices.append((t + offset).astype(np.uint32))
        face_ranges.append([tri_start, len(t)])
        for edge in face.edges():
            key = edge.wrapped
            if key in polylines:
                continue
            on = BRep_Tool.PolygonOnTriangulation_s(edge.wrapped, poly, loc)
            if on is not None:
                polylines[key] = v[[on.Node(i) - 1 for i in range(1, on.NbNodes() + 1)]]
        offset += len(v)
        tri_start += len(t)

    edge_points: list[np.ndarray] = []
    edge_ranges: list[list[int]] = []
    seg_start = 0
    for edge in shape.edges():
        pts = polylines.get(edge.wrapped)
        if pts is None:
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


def _nodes(poly, loc) -> np.ndarray:
    """A triangulation's nodes in the shape's coordinates."""
    v = np.array([poly.Node(i).Coord() for i in range(1, poly.NbNodes() + 1)], dtype=np.float64)
    if not loc.IsIdentity():
        t = loc.Transformation()
        m = np.array([[t.Value(r, c) for c in range(1, 5)] for r in range(1, 4)])
        v = v @ m[:, :3].T + m[:, 3]
    return v.astype(np.float32)


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
