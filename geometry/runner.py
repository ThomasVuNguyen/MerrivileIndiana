"""Runs one AI-written build123d script in a child process and collects the results.

`build` makes a part (metrics, mesh, STEP/STL, renders). `inspect` runs analysis code that can load
the project's parts with part(id), prints measurements, and renders whatever it assigns to `result`.

Children are forked from a forkserver that has already imported build123d, so a
build starts in milliseconds instead of paying the ~3 s import every time. Each
script gets its own process: a crash, a runaway loop or leaked OCCT memory dies
with it.
"""

from __future__ import annotations

import base64
import contextlib
import io
import multiprocessing as mp
import os
import resource
import shutil
import tempfile
import time
import traceback

SCRIPT = "part.py"
MEMORY_LIMIT = 3 * 1024**3


def _context() -> mp.context.BaseContext:
    ctx = mp.get_context("forkserver")
    ctx.set_forkserver_preload(["build123d", "geometry.mesh", "geometry.render"])
    return ctx


_ctx = _context()


def build(source: str, timeout: float = 60.0, assets: dict[str, bytes] | None = None) -> dict:
    """Execute `source` and return metrics, mesh, STEP/STL and a render, or an error.

    `assets` are files the script can open with asset(name), such as an imported STEP.
    """
    return _spawn(_job, (source, assets or {}), timeout)


def inspect(
    code: str,
    timeout: float = 60.0,
    assets: dict[str, bytes] | None = None,
    parts: dict[str, str] | None = None,
    views: list | None = None,
    size: int = 420,
) -> dict:
    """Run analysis code. part(id) builds a project part from its source (exact B-rep, no STEP round trip).

    Returns stdout, `report` (any JSON value the code assigns) and, when it assigns `result`, its full-precision
    metrics and a render of `views` (names from render.PRESETS or {name, dir, up}; [] for none).
    """
    return _spawn(_inspect_job, (code, assets or {}, parts or {}, views, size), timeout)


def _spawn(target, args: tuple, timeout: float) -> dict:
    started = time.perf_counter()
    parent, child = _ctx.Pipe(duplex=False)
    proc = _ctx.Process(target=target, args=(*args, child), daemon=True)
    proc.start()
    child.close()
    result: dict | None = None
    timed_out = not parent.poll(timeout)
    if not timed_out:
        try:
            result = parent.recv()
        except EOFError:
            result = None
    if proc.is_alive():
        proc.kill()
    proc.join(5)
    if result is None:
        if timed_out:
            reason = f"timed out after {timeout:.0f} s"
        elif proc.exitcode is not None and proc.exitcode < 0:
            reason = f"crashed (signal {-proc.exitcode}), often from running out of memory"
        else:
            reason = f"exited with code {proc.exitcode}"
        result = {"ok": False, "error": {"type": "BuildAborted", "message": f"The build {reason}.", "line": None, "trace": []}, "stdout": ""}
    result["ms"] = round((time.perf_counter() - started) * 1000)
    return result


def _job(source: str, assets: dict[str, bytes], conn) -> None:
    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT, MEMORY_LIMIT))
    out = io.StringIO()
    try:
        conn.send(_run(source, out, assets))
    except BaseException as exc:  # anything the script raises, including SystemExit
        conn.send({"ok": False, "error": _describe(exc, source), "stdout": out.getvalue()[-4000:]})
    finally:
        conn.close()


def _run(source: str, out: io.StringIO, assets: dict[str, bytes]) -> dict:
    files = tempfile.mkdtemp(prefix="assets-")
    try:
        return _run_in(source, out, assets, files)
    finally:
        shutil.rmtree(files, ignore_errors=True)


def _run_in(source: str, out: io.StringIO, assets: dict[str, bytes], files: str) -> dict:
    from build123d import Compound, Shape, export_step, export_stl

    from geometry.mesh import tessellate
    from geometry.render import render_thumb, render_views

    for name, data in assets.items():
        with open(os.path.join(files, os.path.basename(name)), "wb") as f:
            f.write(data)

    def asset(name: str) -> str:
        path = os.path.join(files, os.path.basename(name))
        if not os.path.exists(path):
            raise FileNotFoundError(f"No asset named {name!r}. Available: {', '.join(sorted(assets)) or 'none'}.")
        return path

    namespace: dict = {"__name__": "__part__", "asset": asset}
    with contextlib.redirect_stdout(out):
        exec(compile(source, SCRIPT, "exec"), namespace)
    shape = _resolve(namespace.get("result"), Compound, Shape)
    problems = []
    if not shape.solids():
        raise ValueError("`result` has no solids. Parts must be closed 3D solids (extrude, revolve, loft…), not sketches or faces.")
    if not shape.is_valid:
        problems.append("OpenCASCADE reports the shape as invalid (BRepCheck). Booleans or fillets may have left bad geometry.")
    if len(shape.solids()) > 1:
        problems.append(f"`result` holds {len(shape.solids())} separate solids. If it's meant to be one part, fuse them or check that features touch.")

    mesh = tessellate(shape)
    png, thumb = render_views(mesh), render_thumb(mesh)
    mesh.pop("_arrays")
    with tempfile.TemporaryDirectory() as tmp:
        step_path, stl_path = os.path.join(tmp, "part.step"), os.path.join(tmp, "part.stl")
        export_step(shape, step_path)
        export_stl(shape, stl_path)
        step, stl = open(step_path, "rb").read(), open(stl_path, "rb").read()

    return {
        "ok": True,
        "stdout": out.getvalue()[-4000:],
        "warnings": problems,
        "metrics": _metrics(shape),
        "mesh": mesh,
        "step": base64.b64encode(step).decode(),
        "stl": base64.b64encode(stl).decode(),
        "render": base64.b64encode(png).decode(),
        "thumb": base64.b64encode(thumb).decode(),
    }


def _inspect_job(code: str, assets: dict[str, bytes], parts: dict[str, str], views, size: int, conn) -> None:
    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT, MEMORY_LIMIT))
    out = io.StringIO()
    files = tempfile.mkdtemp(prefix="assets-")
    try:
        conn.send(_inspect_in(code, out, assets, parts, views, size, files))
    except BaseException as exc:
        conn.send({"ok": False, "error": _describe(exc, code), "stdout": out.getvalue()[-20000:]})
    finally:
        shutil.rmtree(files, ignore_errors=True)
        conn.close()


def _inspect_in(code: str, out: io.StringIO, assets: dict[str, bytes], parts: dict[str, str], views, size: int, files: str) -> dict:
    import json

    from build123d import Compound, Shape

    from geometry.mesh import tessellate
    from geometry.render import PRESETS, render_views

    for name, data in assets.items():
        with open(os.path.join(files, os.path.basename(name)), "wb") as f:
            f.write(data)

    def asset(name: str) -> str:
        path = os.path.join(files, os.path.basename(name))
        if not os.path.exists(path):
            raise FileNotFoundError(f"No asset named {name!r}. Available: {', '.join(sorted(assets)) or 'none'}.")
        return path

    loaded: dict = {}

    def part(pid: str):
        """A project part's current solid, built from its source."""
        if pid not in loaded:
            if pid not in parts:
                raise KeyError(f"No part {pid!r} was loaded. Parts: {', '.join(sorted(parts)) or 'none'}.")
            ns: dict = {"__name__": "__part__", "asset": asset}
            try:
                exec(compile(parts[pid], f"part {pid}", "exec"), ns)
                loaded[pid] = _resolve(ns.get("result"), Compound, Shape)
            except Exception as exc:
                raise RuntimeError(f"part({pid!r}) failed to build: {type(exc).__name__}: {exc}") from None
        return loaded[pid]

    namespace: dict = {"__name__": "__inspect__", "asset": asset, "part": part}
    with contextlib.redirect_stdout(out):
        exec(compile(code, SCRIPT, "exec"), namespace)
    reply: dict = {"ok": True, "stdout": out.getvalue()[-20000:]}
    if namespace.get("report") is not None:
        reply["report"] = json.loads(json.dumps(namespace["report"], default=str))
    if namespace.get("result") is None:
        return reply
    shape = _resolve(namespace["result"], Compound, Shape)
    reply["metrics"] = _metrics(shape, precise=True)
    if views != [] and (shape.faces() or shape.edges()):
        chosen = []
        for v in views or ["iso", "front", "top", "right"]:
            if isinstance(v, str):
                if v not in PRESETS:
                    raise ValueError(f"Unknown view {v!r}. Named views: {', '.join(PRESETS)}; or pass {{name, dir: [x, y, z], up?}}.")
                chosen.append(PRESETS[v])
            else:
                chosen.append((str(v.get("name", "view")), tuple(v["dir"]), tuple(v.get("up") or (0.0, 0.0, 1.0))))
        mesh = tessellate(shape)
        reply["render"] = base64.b64encode(render_views(mesh, chosen[:6], max(200, min(int(size), 1000)))).decode()
    return reply


def _metrics(shape, precise: bool = False) -> dict:
    r = (lambda x: float(x)) if precise else (lambda x: round(x, 3))
    xyz = (lambda v: [float(v.X), float(v.Y), float(v.Z)]) if precise else _xyz
    bb = shape.bounding_box()
    solids = shape.solids()
    return {
        "volume_mm3": r(shape.volume),
        "area_mm2": r(shape.area),
        "bbox": {"min": xyz(bb.min), "max": xyz(bb.max), "size": xyz(bb.size)},
        "center": xyz(shape.center()) if solids else None,
        "solids": len(solids),
        "faces": len(shape.faces()),
        "edges": len(shape.edges()),
        "valid": bool(shape.is_valid),
    }


def _resolve(value, Compound, Shape):
    if value is None:
        raise NameError("The script must assign the finished part to a variable named `result`.")
    if hasattr(value, "part") and not isinstance(value, Shape):  # a BuildPart context
        value = value.part
    if isinstance(value, (list, tuple)):
        value = Compound(list(value))
    if not isinstance(value, Shape):
        raise TypeError(f"`result` is a {type(value).__name__}, expected a build123d Part/Solid/Compound.")
    return value


def _xyz(v) -> list[float]:
    return [round(v.X, 4), round(v.Y, 4), round(v.Z, 4)]


def _describe(exc: BaseException, source: str) -> dict:
    """Error type, message and the script lines involved, without build123d internals."""
    lines = source.splitlines()
    if isinstance(exc, SyntaxError) and exc.filename == SCRIPT:
        return {"type": "SyntaxError", "message": exc.msg, "line": exc.lineno, "trace": [_frame(exc.lineno, lines)]}
    frames = [f for f in traceback.extract_tb(exc.__traceback__) if f.filename == SCRIPT]
    trace = [_frame(f.lineno, lines) for f in frames]
    return {"type": type(exc).__name__, "message": str(exc)[:2000], "line": frames[-1].lineno if frames else None, "trace": trace}


def _frame(lineno: int | None, lines: list[str]) -> dict:
    code = lines[lineno - 1].strip() if lineno and 0 < lineno <= len(lines) else ""
    return {"line": lineno, "code": code}
