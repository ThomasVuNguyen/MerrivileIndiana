"""Runs one AI-written build123d script in a child process and collects the results.

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
    started = time.perf_counter()
    parent, child = _ctx.Pipe(duplex=False)
    proc = _ctx.Process(target=_job, args=(source, child, assets or {}), daemon=True)
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


def _job(source: str, conn, assets: dict[str, bytes]) -> None:
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

    bb = shape.bounding_box()
    mesh = tessellate(shape)
    png, thumb = render_views(mesh), render_thumb(mesh)
    mesh.pop("_arrays")
    with tempfile.TemporaryDirectory() as tmp:
        step_path, stl_path = os.path.join(tmp, "part.step"), os.path.join(tmp, "part.stl")
        export_step(shape, step_path)
        export_stl(shape, stl_path)
        step, stl = open(step_path, "rb").read(), open(stl_path, "rb").read()

    com = shape.center()
    return {
        "ok": True,
        "stdout": out.getvalue()[-4000:],
        "warnings": problems,
        "metrics": {
            "volume_mm3": round(shape.volume, 3),
            "area_mm2": round(shape.area, 3),
            "bbox": {"min": _xyz(bb.min), "max": _xyz(bb.max), "size": _xyz(bb.size)},
            "center": _xyz(com),
            "solids": len(shape.solids()),
            "faces": len(shape.faces()),
            "edges": len(shape.edges()),
            "valid": bool(shape.is_valid),
        },
        "mesh": mesh,
        "step": base64.b64encode(step).decode(),
        "stl": base64.b64encode(stl).decode(),
        "render": base64.b64encode(png).decode(),
        "thumb": base64.b64encode(thumb).decode(),
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
