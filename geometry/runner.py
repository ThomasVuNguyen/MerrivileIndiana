"""Runs one AI-written build123d script in a child process and collects the results.

`build` makes a part (metrics, mesh, STEP/STL, renders). `inspect` runs analysis code, prints
measurements, and renders whatever it assigns to `result`. Both run in the same namespace: build123d
pre-imported, asset(name) for files sent alongside, and part(id) for the project's other parts.

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


class PartError(RuntimeError):
    """part(id) couldn't give a solid: no such part, a cycle, or its source failed."""


def build(
    source: str,
    timeout: float = 60.0,
    assets: dict[str, bytes] | None = None,
    parts: dict[str, str] | None = None,
    part_id: str | None = None,
    bodies: int | None = None,
) -> dict:
    """Execute `source` and return metrics, mesh, STEP/STL and a render, or an error.

    `assets` are files the script can open with asset(name), such as an imported STEP; `parts` are the
    project's other parts for part(id). `part_id` is the part being built, so it can't use itself.
    `bodies` is how many separate solids `result` is meant to hold (a print plate); None means one.
    """
    return _spawn(_job, (source, assets or {}, parts or {}, part_id, bodies), timeout)


def inspect(
    code: str,
    timeout: float = 60.0,
    assets: dict[str, bytes] | None = None,
    parts: dict[str, str] | None = None,
    views: list | None = None,
    size: int = 420,
    colors: dict[str, str] | None = None,
    section: dict | None = None,
) -> dict:
    """Run analysis code. part(id) builds a project part from its source (exact B-rep, no STEP round trip).

    Returns stdout, `report` (any JSON value the code assigns) and, when it assigns `result`, its full-precision
    metrics and a render of `views` (names from render.PRESETS or {name, dir, up}; [] for none). Parts are drawn
    in their `colors` (part id → "#rrggbb"), other shapes in palette colours; `section` cuts the picture
    (see scene.render_scene).
    """
    return _spawn(_inspect_job, (code, assets or {}, parts or {}, views, size, colors or {}, section), timeout)


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


def _job(source: str, assets: dict[str, bytes], parts: dict[str, str], part_id: str | None, bodies: int | None, conn) -> None:
    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT, MEMORY_LIMIT))
    out = io.StringIO()
    try:
        conn.send(_run(source, out, assets, parts, part_id, bodies))
    except BaseException as exc:  # anything the script raises, including SystemExit
        conn.send({"ok": False, "error": _describe(exc, source), "stdout": out.getvalue()[-4000:]})
    finally:
        conn.close()


def _run(source: str, out: io.StringIO, assets: dict[str, bytes], parts: dict[str, str], part_id: str | None, bodies: int | None) -> dict:
    files = tempfile.mkdtemp(prefix="assets-")
    try:
        return _run_in(source, out, _environment(assets, parts, files), part_id, bodies)
    finally:
        shutil.rmtree(files, ignore_errors=True)


def _environment(assets: dict[str, bytes], parts: dict[str, str], files: str):
    """What part scripts and inspect code run in: `from build123d import *` already done, asset(name)
    for the files sent alongside, and part(id), a project part's solid built from its last good source.

    Returns namespace(name, chain): a fresh namespace whose part() knows the chain of parts being built,
    so a part can't use itself, directly or through others. Built parts are shared across namespaces.
    """
    from build123d import Compound, Shape

    for name, data in assets.items():
        with open(os.path.join(files, os.path.basename(name)), "wb") as f:
            f.write(data)

    def asset(name: str) -> str:
        path = os.path.join(files, os.path.basename(name))
        if not os.path.exists(path):
            raise FileNotFoundError(f"No asset named {name!r}. Available: {', '.join(sorted(assets)) or 'none'}.")
        return path

    loaded: dict = {}

    def namespace(name: str, chain: tuple[str, ...]) -> dict:
        def part(pid: str):
            """A project part's current solid, built from its source."""
            if pid in chain:
                path = " → ".join((*chain, pid))
                raise PartError(f"part({pid!r}) makes a cycle ({path}). A part can't use itself, directly or through other parts.")
            if pid not in loaded:
                if pid not in parts:
                    raise PartError(f"No part {pid!r} with a good build in this project. Parts: {', '.join(sorted(parts)) or 'none'}.")
                ns = namespace("__part__", (*chain, pid))
                try:
                    exec(compile(parts[pid], f"part {pid}", "exec"), ns)
                    loaded[pid] = _resolve(ns.get("result"), Compound, Shape)
                    # Moved copies and booleans keep the label, so a render can give the part its colour.
                    loaded[pid].label = pid
                except PartError:
                    raise
                except Exception as exc:
                    raise PartError(f"part({pid!r}) failed to build: {type(exc).__name__}: {exc}") from None
            return loaded[pid]

        ns: dict = {"__name__": name}
        exec("from build123d import *", ns)
        ns.update(asset=asset, part=part)
        return ns

    return namespace


def _run_in(source: str, out: io.StringIO, namespace, part_id: str | None, bodies: int | None) -> dict:
    from build123d import Compound, Shape, export_step, export_stl

    from geometry.mesh import tessellate
    from geometry.render import render_thumb, render_views

    ns = namespace("__part__", (part_id,) if part_id else ())
    with contextlib.redirect_stdout(out):
        exec(compile(source, SCRIPT, "exec"), ns)
    shape = _resolve(ns.get("result"), Compound, Shape)
    problems = []
    solids = len(shape.solids())
    if not solids:
        raise ValueError("`result` has no solids. Parts must be closed 3D solids (extrude, revolve, loft…), not sketches or faces.")
    if not shape.is_valid:
        problems.append("OpenCASCADE reports the shape as invalid (BRepCheck). Booleans or fillets may have left bad geometry.")
    if bodies is not None:
        if solids != bodies:
            problems.append(f"`result` holds {solids} separate solid{'s' if solids != 1 else ''}; expected {bodies} (bodies={bodies}). Check that features touch, or change bodies.")
    elif solids > 1:
        problems.append(f"`result` holds {solids} separate solids. If it's meant to be one part, fuse them or check that features touch; if they're printed together on purpose, pass bodies={solids}.")

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


def _inspect_job(code: str, assets: dict[str, bytes], parts: dict[str, str], views, size: int, colors: dict[str, str], section, conn) -> None:
    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT, MEMORY_LIMIT))
    out = io.StringIO()
    files = tempfile.mkdtemp(prefix="assets-")
    try:
        conn.send(_inspect_in(code, out, _environment(assets, parts, files), views, size, colors, section))
    except BaseException as exc:
        conn.send({"ok": False, "error": _describe(exc, code), "stdout": out.getvalue()[-20000:]})
    finally:
        shutil.rmtree(files, ignore_errors=True)
        conn.close()


def _inspect_in(code: str, out: io.StringIO, environment, views, size: int, colors=None, section=None) -> dict:
    import json

    from build123d import Compound, Shape

    from geometry.render import PRESETS
    from geometry.scene import render_scene

    namespace = environment("__inspect__", ())
    with contextlib.redirect_stdout(out):
        exec(compile(code, SCRIPT, "exec"), namespace)
    reply: dict = {"ok": True, "stdout": out.getvalue()[-20000:]}
    if namespace.get("report") is not None:
        reply["report"] = json.loads(json.dumps(namespace["report"], default=str))
    value = namespace.get("result")
    if value is None:
        return reply
    # {name: shape} labels the legend; metrics are for all of it.
    shape = _resolve(list(value.values()) if isinstance(value, dict) else value, Compound, Shape)
    reply["metrics"] = _metrics(shape, precise=True)
    if views != [] and (shape.faces() or shape.edges()):
        chosen = None if not views and section else []
        for v in views or ([] if section else ["iso", "front", "top", "right"]):
            if isinstance(v, str):
                if v not in PRESETS:
                    raise ValueError(f"Unknown view {v!r}. Named views: {', '.join(PRESETS)}; or pass {{name, dir: [x, y, z], up?}}.")
                chosen.append(PRESETS[v])
            else:
                chosen.append((str(v.get("name", "view")), tuple(v["dir"]), tuple(v.get("up") or (0.0, 0.0, 1.0))))
        png = render_scene(value, colors or {}, chosen[:6] if chosen else None, max(200, min(int(size), 1000)), section)
        if png:
            reply["render"] = base64.b64encode(png).decode()
        elif section:
            reply["stdout"] += "\n(The section plane leaves nothing on the kept side; no picture.)"
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
