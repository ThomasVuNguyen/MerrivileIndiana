"""Runs one AI-written build123d script in a child process and collects the results.

`build` makes a part (metrics, mesh, STEP/STL, renders, datums). `inspect` runs analysis code, prints
measurements, and renders whatever it assigns to `result`. Both run in the same namespace: build123d
pre-imported, asset(name) for files sent alongside, part(id) for the project's other parts,
component(id) for the account's vendor components and assembly(id) for placed assemblies.
`import_component` reads a vendor STEP; `assembly` places an assembly's instances, checks and draws it.

Children are forked from a forkserver that has already imported build123d, so a
build starts in milliseconds instead of paying the ~3 s import every time. Each
script gets its own process: a crash, a runaway loop or leaked OCCT memory dies
with it.
"""

from __future__ import annotations

import os

# One BLAS thread: forked, memory-limited children can't start OpenBLAS's thread pool and hang in
# the first big matrix product (a vendor board's mesh); these jobs are small and one per process.
for _var in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

import base64
import contextlib
import io
import multiprocessing as mp
import resource
import shutil
import tempfile
import time
import traceback

SCRIPT = "part.py"
MEMORY_LIMIT = 3 * 1024**3


def _context() -> mp.context.BaseContext:
    ctx = mp.get_context("forkserver")
    ctx.set_forkserver_preload(["build123d", "geometry.mesh", "geometry.render", "geometry.datums", "geometry.assembly", "geometry.check"])
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
    components: dict | None = None,
) -> dict:
    """Execute `source` and return metrics, mesh, STEP/STL, a render and its datums, or an error.

    `assets` are files the script can open with asset(name), such as an imported STEP; `parts` are the
    project's other parts for part(id); `components` are {id: {hash, names?}} for component(id), their
    BREPs already in the cache. `part_id` is the part being built, so it can't use itself.
    `bodies` is how many separate solids `result` is meant to hold (a print plate); None means one.
    """
    return _spawn(_job, (source, assets or {}, parts or {}, part_id, bodies, components or {}), timeout)


def inspect(
    code: str,
    timeout: float = 60.0,
    assets: dict[str, bytes] | None = None,
    parts: dict[str, str] | None = None,
    views: list | None = None,
    size: int = 420,
    colors: dict[str, str] | None = None,
    section: dict | None = None,
    components: dict | None = None,
    assemblies: dict | None = None,
) -> dict:
    """Run analysis code. part(id) builds a project part from its source (exact B-rep, no STEP round trip).

    Returns stdout, `report` (any JSON value the code assigns) and, when it assigns `result`, its full-precision
    metrics and a render of `views` (names from render.PRESETS or {name, dir, up}; [] for none). Parts are drawn
    in their `colors` (part id → "#rrggbb"), other shapes in palette colours; `section` cuts the picture
    (see scene.render_scene). `assemblies` are {id: placed leaves} for assembly(id).
    """
    return _spawn(_inspect_job, (code, assets or {}, parts or {}, views, size, colors or {}, section, components or {}, assemblies or {}), timeout)


def import_component(step_path: str, timeout: float = 280.0) -> dict:
    """Read a vendor STEP: its BREP and viewer mesh go into the cache (by the BREP's hash); returns
    metrics, renders, suggested datums, the holes found and an outline."""
    return _spawn(_component_job, (step_path,), timeout)


def assembly(job: dict, timeout: float = 120.0) -> dict:
    """Place an assembly (or take placed leaves), then check, render and export it as asked; see _assembly_in."""
    return _spawn(_assembly_job, (job,), timeout)


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


def _job(source: str, assets: dict[str, bytes], parts: dict[str, str], part_id: str | None, bodies: int | None, components: dict, conn) -> None:
    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT, MEMORY_LIMIT))
    out = io.StringIO()
    try:
        conn.send(_run(source, out, assets, parts, part_id, bodies, components))
    except BaseException as exc:  # anything the script raises, including SystemExit
        conn.send({"ok": False, "error": _describe(exc, source), "stdout": out.getvalue()[-4000:]})
    finally:
        conn.close()


def _run(source: str, out: io.StringIO, assets: dict[str, bytes], parts: dict[str, str], part_id: str | None, bodies: int | None, components: dict) -> dict:
    files = tempfile.mkdtemp(prefix="assets-")
    try:
        return _run_in(source, out, _environment(assets, parts, files, components), part_id, bodies)
    finally:
        shutil.rmtree(files, ignore_errors=True)


def _environment(assets: dict[str, bytes], parts: dict[str, str], files: str, components: dict | None = None, assemblies: dict | None = None):
    """What part scripts and inspect code run in: `from build123d import *` already done, asset(name)
    for the files sent alongside, part(id), a project part's solid built from its last good source,
    component(id), a vendor component's solid from its BREP, and assembly(id), {instance name: placed
    shape}. Pattern(points, normal) helps publish a hole pattern in `datums`.

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
        ns.update(asset=asset, part=part, component=component, assembly=assembly, Pattern=Pattern)
        return ns

    from geometry import cache
    from geometry.datums import Pattern

    components = components or {}
    assemblies = assemblies or {}

    def component(cid: str):
        """A vendor component's solid (exact B-rep; it never changes)."""
        key = f"component:{cid}"
        if key not in loaded:
            if cid not in components:
                raise PartError(f"No component {cid!r} in this account. Components: {', '.join(sorted(components)) or 'none'}.")
            from build123d import import_brep

            loaded[key] = import_brep(cache.path(f"{components[cid]['hash']}.brep"))
            loaded[key].label = cid
        return loaded[key]

    def assembly(aid: str) -> dict:
        """{instance name: shape placed where the assembly's last save put it}, ready to draw or measure."""
        if aid not in assemblies:
            raise PartError(f"No assembly {aid!r} in this project. Assemblies: {', '.join(sorted(assemblies)) or 'none'}.")
        out: dict = {}
        for leaf in assemblies[aid]:
            shape = shape_of(leaf["key"]).moved(_location(leaf["matrix"]))
            name = leaf.get("name") or leaf["path"]
            out[leaf["path"] if name in out else name] = shape
        return out

    root: dict = {}

    def shape_of(key: str):
        """The unplaced shape for a leaf's ref key: "part:<id>", "part:<id>@<version>" or "component:<id>"."""
        kind, _, ref = key.partition(":")
        if kind == "component":
            return component(ref)
        root.setdefault("ns", namespace("__part__", ()))
        shape = root["ns"]["part"](ref)
        shape.label = ref.split("@")[0]  # a pinned version keeps its part's colour
        return shape

    namespace.shape_of = shape_of  # type: ignore[attr-defined]
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

    from geometry.datums import serialise

    datums, floating = serialise(ns.get("datums"), shape)
    problems += floating

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
        "datums": datums,
        "mesh": mesh,
        "step": base64.b64encode(step).decode(),
        "stl": base64.b64encode(stl).decode(),
        "render": base64.b64encode(png).decode(),
        "thumb": base64.b64encode(thumb).decode(),
    }


def _inspect_job(code: str, assets: dict[str, bytes], parts: dict[str, str], views, size: int, colors: dict[str, str], section, components: dict, assemblies: dict, conn) -> None:
    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT, MEMORY_LIMIT))
    out = io.StringIO()
    files = tempfile.mkdtemp(prefix="assets-")
    try:
        conn.send(_inspect_in(code, out, _environment(assets, parts, files, components, assemblies), views, size, colors, section))
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
    reply["metrics"] = _metrics(shape, precise=True, quick_box=len(shape.faces()) > 2000)
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


def _metrics(shape, precise: bool = False, quick_box: bool = False) -> dict:
    r = (lambda x: float(x)) if precise else (lambda x: round(x, 3))
    xyz = (lambda v: [float(v.X), float(v.Y), float(v.Z)]) if precise else _xyz
    # The optimal box takes seconds on a vendor model with thousands of faces.
    bb = shape.bounding_box(optimal=not quick_box)
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


def _location(matrix):
    """A build123d Location from 16 numbers, row-major (p_world = M · [x, y, z, 1])."""
    from build123d import Location
    from OCP.gp import gp_Trsf

    m = [float(x) for x in matrix]
    t = gp_Trsf()
    t.SetValues(*m[0:4], *m[4:8], *m[8:12])
    return Location(t)


# ---------------------------------------------------------------- components


def _component_job(step_path: str, conn) -> None:
    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT, MEMORY_LIMIT))
    try:
        conn.send(_component(step_path))
    except BaseException as exc:
        conn.send({"ok": False, "error": {"type": type(exc).__name__, "message": str(exc)[:2000], "line": None, "trace": []}, "stdout": ""})
    finally:
        conn.close()


def _component(step_path: str) -> dict:
    import json

    from build123d import export_brep, import_step

    from geometry import cache
    from geometry.datums import suggest
    from geometry.mesh import tessellate
    from geometry.render import render_thumb, render_views

    shape = import_step(step_path)
    if not shape.faces():
        raise ValueError("The STEP file has no faces: no geometry to use.")
    names = _solid_names(shape)
    tmp = cache.output("brep")
    export_brep(shape, tmp)
    h = cache.put_file(tmp)
    mesh = tessellate(shape)
    png, thumb = render_views(mesh), render_thumb(mesh)
    _save_render_mesh(h, mesh["_arrays"])
    mesh.pop("_arrays")
    with open(cache.path(f"{h}.mesh.json"), "w") as f:
        json.dump(mesh, f)
    suggested, holes = suggest(shape)
    metrics = _metrics(shape, precise=True, quick_box=True)
    warnings = []
    if not shape.solids():
        warnings.append("It has surfaces but no closed solids: distances and keep-outs work, clash volumes don't.")
    return {
        "ok": True,
        "hash": h,
        "brep_bytes": os.path.getsize(cache.path(f"{h}.brep")),
        "mesh": f"{h}.mesh.json",
        "names": names,
        "metrics": metrics,
        "suggested": suggested,
        "holes": holes,
        "outline": {"min": metrics["bbox"]["min"], "max": metrics["bbox"]["max"]},
        "warnings": warnings,
        "render": base64.b64encode(png).decode(),
        "thumb": base64.b64encode(thumb).decode(),
    }


def _solid_names(shape) -> list[str]:
    """Each solid's label from the STEP's product tree, in shape.solids() order ("" when unnamed)."""
    out: list[str] = []

    def walk(node, label):
        own = getattr(node, "label", "") or label
        kids = list(getattr(node, "children", ()) or ())
        if kids:
            for k in kids:
                walk(k, own)
        else:
            out.extend([own] * len(node.solids()))

    walk(shape, "")
    return out if len(out) == len(shape.solids()) else [""] * len(shape.solids())


def _save_render_mesh(h: str, arrays: dict) -> None:
    import numpy as np

    from geometry import cache

    with open(cache.path(f"{h}.render.npz"), "wb") as f:
        np.savez(f, positions=arrays["positions"], indices=arrays["indices"], edges=arrays["edges"])


def _render_mesh(h: str) -> dict | None:
    import numpy as np

    from geometry import cache

    try:
        if not cache.has(f"{h}.render.npz"):
            return None
        with np.load(cache.path(f"{h}.render.npz")) as z:
            return {k: z[k] for k in ("positions", "indices", "edges")}
    except Exception:
        return None


# ---------------------------------------------------------------- assemblies


def _assembly_job(job: dict, conn) -> None:
    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT, MEMORY_LIMIT))
    files = tempfile.mkdtemp(prefix="assets-")
    try:
        conn.send(_assembly_in(job, _environment({}, job.get("parts") or {}, files, job.get("components") or {})))
    except BaseException as exc:
        from geometry.assembly import AssemblyError

        kind = "AssemblyError" if isinstance(exc, AssemblyError) else type(exc).__name__
        conn.send({"ok": False, "error": {"type": kind, "message": str(exc)[:2000], "line": None, "trace": []}, "stdout": ""})
    finally:
        shutil.rmtree(files, ignore_errors=True)
        conn.close()


def _assembly_in(job: dict, environment) -> dict:
    """Lay out, check, render and export an assembly.

    job: spec {instances, requirements?, clearance?}; catalog {datums: {ref key: {name: datum}},
    assemblies: {id: spec}, colors: {ref key: "#rrggbb"}, keepouts: {ref key: [keep-out]}};
    previous {path: matrix}; or leaves [{path, name, key, matrix, color?}] to skip the layout.
    parts/components as for build. check: bool; time_limit s; render: {views?, size?, section?} or None;
    highlight: [[path, path]] pairs to draw clashes for without a full check; export: bool.
    """
    from build123d import Compound

    from geometry.assembly import Layout, flat, requirements, unflat
    from geometry.check import check, keepout_shape
    from geometry.mesh import tessellate
    from geometry.scene import render_assembly

    started = time.perf_counter()
    catalog = job.get("catalog") or {}
    spec = job.get("spec") or {"instances": []}
    layout = None
    if job.get("leaves") is not None:
        leaves = [{**l, "matrix": unflat(l["matrix"])} for l in job["leaves"]]
        findings: list = []
    else:
        layout = Layout(spec, catalog, job.get("previous") or {})
        leaves = layout.leaves()
        findings = layout.all_findings()

        def reqs(lay):
            out = []
            for sub in lay.subs.values():
                out += reqs(sub)
            return out + requirements(lay, lay.spec.get("requirements") or [])

        findings += reqs(layout)
    resolve_ms = round((time.perf_counter() - started) * 1000)

    shape_of = environment.shape_of
    names = {cid: c.get("names") or [] for cid, c in (job.get("components") or {}).items()}
    placed = []
    for leaf in leaves:
        try:
            base = shape_of(leaf["key"])
        except Exception as exc:
            findings.append({"kind": "error", "severity": "warning", "instances": [leaf["path"]], "message": f"{leaf['path']} ({leaf['key']}) couldn't be built: {exc}"})
            continue
        loc = _location(flat(leaf["matrix"]))
        kind, _, ref = leaf["key"].partition(":")
        placed.append({**leaf, "base": base, "shape": base.moved(loc), "names": names.get(ref, []) if kind == "component" else []})

    colours = _leaf_colours(placed, catalog.get("colors") or {})
    reply: dict = {
        "ok": True,
        "leaves": [{"path": l["path"], "name": l["name"], "key": l["key"], "matrix": flat(l["matrix"]), "color": colours[l["path"]]} for l in placed],
        "resolve_ms": resolve_ms,
    }
    if layout is not None:
        reply["instances"] = layout.report_instances()
        reply["ground"] = layout.ground

    overlay = []
    clashes = []
    if job.get("check"):
        t0 = time.perf_counter()
        keepouts = []
        for l in placed:
            for k in (catalog.get("keepouts") or {}).get(l["key"], []):
                try:
                    keepouts.append({"owner": l["path"], "label": k.get("label") or k.get("kind"), "shape": keepout_shape(k).moved(_location(flat(l["matrix"])))})
                except Exception as exc:
                    findings.append({"kind": "error", "severity": "warning", "instances": [l["path"]], "message": f"Keep-out {k.get('label')!r} of {l['path']} is malformed: {exc}"})
        ground = {layout.ground} if layout is not None else {placed[0]["path"].split("/")[0]} if placed else set()
        clearance = float(spec.get("clearance") or 0.2)
        limit = max(1.0, float(job.get("time_limit") or 30) - (time.perf_counter() - started))
        r = check(placed, ground, clearance, keepouts, limit)
        base_index = len(findings)
        findings += r["findings"]
        for idx, shapes in r["clash_shapes"]:
            mesh = tessellate(Compound(shapes), info=False)
            mesh.pop("_arrays")
            findings[base_index + idx]["mesh"] = len(clashes)
            clashes.append(mesh)
            if findings[base_index + idx]["kind"] == "clash":
                overlay += shapes
        reply.update(partial=r["partial"], pairs_checked=r["pairs_checked"], pairs_skipped=r["pairs_skipped"], check_ms=round((time.perf_counter() - t0) * 1000))
    elif job.get("highlight"):
        by_path = {l["path"]: l["shape"] for l in placed}
        for a, b in job["highlight"]:
            if a in by_path and b in by_path:
                try:
                    common = by_path[a] & by_path[b]
                    if common is not None and common.solids():
                        overlay.append(common)
                except Exception:
                    pass
    reply["findings"] = findings
    reply["clashes"] = clashes

    render = job.get("render")
    if render is not None and placed:
        from geometry.render import PRESETS

        views = None
        if render.get("views"):
            views = []
            for v in render["views"][:6]:
                if isinstance(v, str):
                    if v not in PRESETS:
                        raise ValueError(f"Unknown view {v!r}. Named views: {', '.join(PRESETS)}.")
                    views.append(PRESETS[v])
                else:
                    views.append((str(v.get("name", "view")), tuple(v["dir"]), tuple(v.get("up") or (0.0, 0.0, 1.0))))
        items = []
        meshes: dict = {}
        for l in placed:
            kind, _, ref = l["key"].partition(":")
            if l["key"] not in meshes:
                h = (job.get("components") or {}).get(ref, {}).get("hash") if kind == "component" else None
                meshes[l["key"]] = (_render_mesh(h) if h else None) or tessellate(l["base"], info=False)["_arrays"]
            items.append({"name": l["name"], "color": colours[l["path"]], "shape": l["shape"], "matrix": l["matrix"], "arrays": meshes[l["key"]]})
        png, thumb = render_assembly(items, overlay, views, max(200, min(int(render.get("size") or 420), 1000)), render.get("section"))
        if png:
            reply["render"] = base64.b64encode(png).decode()
        if thumb:
            reply["thumb"] = base64.b64encode(thumb).decode()

    if job.get("export") and placed:
        from geometry import cache

        out = cache.output("step")
        _export(placed, out, str(job.get("name") or "assembly"))
        reply["step"] = os.path.basename(out)
        reply["step_bytes"] = os.path.getsize(out)
    reply["ms_inside"] = round((time.perf_counter() - started) * 1000)
    return reply


def _leaf_colours(placed: list, colors: dict) -> dict:
    """One colour per instance: its own colour, its part's, or a palette colour; repeats get a fresh one."""
    from geometry.render import PALETTE
    from geometry.scene import _far, _rgb

    out, used = {}, []
    palette = iter(PALETTE * 20)
    for l in placed:
        want = l.get("color") or colors.get(l["key"]) or colors.get(l["key"].split("@")[0])
        c = want if want and all(_far(_rgb(want), u) for u in used) else None
        while c is None:
            nxt = next(palette, None)
            if nxt is None:
                c = want or "#b9bcc2"
            elif all(_far(_rgb(nxt), u) for u in used) and _far(_rgb(nxt), (255.0, 0.0, 0.0)):
                c = nxt
        used.append(_rgb(c))
        out[l["path"]] = c
    return out


def _export(placed: list, path: str, name: str) -> None:
    """A STEP of the placed assembly, one named shape per instance, sub-assemblies nested."""
    from build123d import Compound, export_step

    tree: dict = {}
    for l in placed:
        *subs, last = l["path"].split("/")
        node = tree
        for s in subs:
            node = node.setdefault(s, {})
        node[last] = ("leaf", l)

    def build(node: dict, label: str):
        kids = []
        for key, v in node.items():
            if isinstance(v, tuple):
                s = v[1]["shape"].moved(_location([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]))  # a copy to name
                s.label = str(v[1]["name"] or key)
                kids.append(s)
            else:
                kids.append(build(v, key))
        return Compound(children=kids, label=label)

    export_step(build(tree, name), path)
