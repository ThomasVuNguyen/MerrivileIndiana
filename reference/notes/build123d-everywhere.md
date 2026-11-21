# build123d everywhere: Pyodide/OCP.wasm, Cloudflare Python Workers, native server, viewer tooling

Research notes for Merrivile, 2026-11-21. Scope: keep build123d (OCCT via OCP) as the
geometry kernel and find out where it can run.

Legend used throughout:
- **[measured]** – I ran it on this machine (Ubuntu, Linux 6.8, Node 22.16, Python 3.12.3 venv with build123d 0.13.0, Pyodide 314.0.8, headless Chromium 141).
- **[read]** – taken from a document, repo, or API response; link given.
- **[inferred]** – my own conclusion from the above.

Artifacts:
- Benchmark part script (runs unchanged natively and under Pyodide): `reference/bench/native/bench_part.py`
- Pyodide/Node runners: `reference/bench/pyodide/run_node.mjs` (full OCP.wasm bootstrap), `run_node_minimal.mjs` (trimmed deps), `snapshot_probe.mjs`
- Browser harness: `reference/bench/pyodide/browser/index.html` + `run_browser.mjs` (Playwright, headless Chromium)
- ocp-tessellate / bd_warehouse probe: `reference/bench/tessellate/tess_probe.py` (own uv venv in that folder)
- Docker attempt: `reference/bench/docker/Dockerfile` (could not run: no docker-socket permission, see §4)
- Shallow clones: `reference/repos/{OCP.wasm,three-cad-viewer,ocp-tessellate,bd_warehouse}` (plus `build123d-mcp` cloned earlier by another researcher)

---

## 0. The benchmark part

60×40×5 plate, 4 × Ø5 holes 6 mm from the corners (so on a 48×28 grid), Ø20×15 boss with Ø8
through bore, R2 fillet at the boss/plate junction, 0.5 mm chamfer on the plate's top outer edges.
Then: STEP export, STEP re-import, volume, intersection volume with a copy shifted +10 mm X,
tessellate(0.1, 0.5), STL export.

Hand check of the volume **[inferred]**: 12000 − 4·98.2 + 4712 − 1005 (bore through plate+boss) + ~60 (fillet) − ~25 (chamfer) ≈ 15349 mm³. Measured 15345.9 everywhere. Good.

Two build123d 0.13 API wrinkles hit while writing the 60-line script **[measured]**:
- `part.intersect(other)` returns a `ShapeList`, not a shape (`AttributeError: 'ShapeList' object has no attribute 'volume'`); the `&` operator returns a shape. 
- `Shape.is_valid` is a property in 0.13 (`TypeError: 'bool' object is not callable`); older docs/examples call it as a method.
Both are the kind of thing an LLM trained on older build123d trips on (see §3).

### Benchmark table (same script, same part, identical results everywhere) **[measured]**

| Environment | Download (first visit) | Init (runtime + install) | `import build123d` | Build (fillet/chamfer/booleans) | Volume | Intersect vol. + time | STEP export | Tessellate | Memory |
|---|---|---|---|---|---|---|---|---|---|
| Native CPython 3.12, venv (3 runs) | n/a (870 MB site-packages on disk) | ~0.7 s interpreter start* | 2.9–3.2 s (OCP alone 2.2 s) | 0.050–0.059 s | 15345.892 mm³, 1.1 ms | 10259.615 mm³, 0.09–0.11 s | 9–10 ms, 50 469 B | 18–22 ms (892 v / 1028 tri) | 437 MB max RSS after import only; 470–483 MB max RSS for whole run |
| Pyodide 314.0.8 in **Node 22**, full OCP.wasm bootstrap | 141 MB (first run, incl. Pyodide CDN pkgs) / 111 MB (Pyodide pkgs cached) | loadPyodide 2.1–2.5 s + bootstrap 31–35 s | 18.3 s (import OCP 5.9 s + rest 12.5 s) | 0.23–0.30 s | same, 4.5 ms | same, 0.39–0.55 s | 94 ms, 50 469 B | 66 ms | wasm linear memory 353 MB after install, **424 MB** after import; Node RSS 4.2–4.9 GB (V8 garbage from micropip, not meaningful) |
| Pyodide 314.0.8 in Node 22, **minimal deps** (threejs-materials/ipython/sklearn/sympy mocked) | ~54 MB (11.6 core + 24.7 PyPI + 18.0 Pyodide CDN) | 2.1 s + 16.4–19.9 s | 12.1–14.5 s (import OCP 5.0–6.4 s + 6.9–8.1 s) | 0.33 s | same | same, 0.64 s | 149 ms | 118 ms | wasm memory 237 MB after install, 284 MB after import OCP, **410 MB** after import build123d |
| Pyodide 314.0.8 in **headless Chromium 141** (Playwright), full bootstrap | 146.7 MB on the wire (content-length sum) | loadPyodide 2.4–2.6 s + bootstrap 20.4–20.7 s | 16.9–17.0 s | 0.30 s (run 1); whole main() 1.6 s → 0.65–0.71 s warm | same | same, 0.47 s | 133 ms | 120 ms | wasm memory 353 → **424 MB**; JS heap 890–932 MB; total wall to first part **43 s** |

\* `python -c pass` costs 0.66–0.75 s in this venv because of `_virtualenv.pth`; with `-S -I` it is 0.01 s. The import numbers above include it. Pyodide's `import_s` column is 0 because the module was already imported before `main()` ran.

Pyodide slowdown vs native **[inferred from the table]**: ~5–6× on modelling ops (build 0.05 → 0.23–0.33 s; intersect 0.1 → 0.4–0.64 s), ~10× on STEP write, ~6× on tessellation, ~6× on `import build123d`. Fine for a part of this size; a ~300-face assembly like the actuator in `tools/gen_models.py` would be seconds, not minutes **[inferred]**.

STEP files from native and Pyodide differ only in the 2 header timestamp lines (`diff` = 4 lines) **[measured]**. Face/edge/vertex counts (18/40/25), STL size (556 484 B) and tessellation (892 vertices, 1028 triangles) are byte-identical, i.e. OCP.wasm is the same OCCT 8.0.1 doing the same thing.

---

## 1. OCP compiled to WebAssembly for Pyodide

### 1.1 What exists

**yeicor/OCP.wasm** — https://github.com/yeicor/OCP.wasm **[read, `gh api` 2026-11-21]**
- 52 stars, 6 forks, 0 open issues, MIT, created 2025-05-31, last push 2026-09-24 ("upgrade(ocp): bump OCP to 8.0.1.1").
- Single maintainer (yeicor); Renovate bot does most PRs. Issue #41 ("Minimal version?" – drop STEP/IGES/visualisation toolkits for a smaller wasm) was answered 2026-09-10: "I don't see any reason why this shouldn't be possible … That said, I'm not using OCP.wasm enough myself to justify putting time into implementing this." **[read]**
- It is not a fork of OCCT code; it is a build system: CMake + `pyodide-build 0.39` that compiles **OCCT V8_0_1** (`cadquery-ocp-novtk/CMakeLists.txt:156`) and the CadQuery/OCP pybind11 wrapper with Emscripten, without VTK, plus **lib3mf 2.5.0** (needed by build123d's 3MF `Mesher`). Output goes to PyPI, not GitHub releases (the repo has zero GitHub releases).
- PyPI packages **[read, PyPI JSON]**:
  - `cadquery-ocp-novtk-OCP.wasm` latest `8.0.1.1.post202609241841` (2026-09-24), wheel `cp314-cp314-pyemscripten_2026_0_wasm32`, **22.7 MB** compressed; 30 releases since 2026-05-17; also `cp313-pyemscripten_2025_0` builds for older Pyodide. Debug builds (`.dev…`) are ~41–43 MB.
  - `lib3mf-OCP.wasm` 2.5.0, 0.6 MB.
- The wheel is a single file: `OCP.cpython-314-wasm32-emscripten.so` = **152.2 MB uncompressed** **[measured, `unzip -l`]**. That is why the wasm linear memory jumps to ~285 MB just from `import OCP` – the whole binding is loaded as a dynamic library into linear memory.
- `build123d/bootstrap.py` (the official way in): installs the two wheels, registers micropip *mock packages* for `cadquery-ocp`, `cadquery-ocp-novtk`, `lib3mf`, `py-lib3mf` so build123d's requirements resolve, then `micropip.install("build123d==<ver>")`. Entry point is `await bootstrap.bootstrap(build123d_ref="0.13.0")` (not `install_build123d` – I guessed wrong first: `AttributeError: module 'bootstrap' has no attribute 'install_build123d'`).
- The README says the build123d test suite passes "(almost) 100%" with the extra tricks in `build123d/test.py` **[read]**; I did not run the suite.

Downstream projects **[read, `gh api`]**:
- yeicor-3d/yet-another-cad-viewer – 149★, pushed 2026-11-21, browser viewer + build123d playground on OCP.wasm.
- Jojain/build123d-sandbox – 21★, pushed 2026-09-23.
- radther/build123dWebAssmGenDemo – 5★, last push 2025-07-03 (STL generator demo).
- build123d docs' "External tools" page lists OCP.wasm **[read]**.

Other Python-OCCT-in-browser ports: none found. CadQuery has no Pyodide build (its `cadquery-ocp` wheel includes VTK; OCP.wasm's package is deliberately the no-VTK variant, and CadQuery itself is not on Pyodide) **[read, searches 2026-11-21; inferred]**. A separate "nanocct" binding (bernhard-42, nanobind, stable ABI, 3★, created 2026-09-28, 50–55 MB native wheels) exists but has no wasm build **[read]**.

### 1.2 Does build123d install under Pyodide?  Yes **[measured]**

Full bootstrap in Node 22 with Pyodide 314.0.8 (Python 3.14.2) succeeded and installed everything build123d 0.13.0 requires. The requirement list of build123d 0.13 (from `importlib.metadata`) **[measured]**:

```
cadquery-ocp-novtk<8.1,>=8.0, typing_extensions, numpy<3,>=2, svgpathtools, anytree, ezdxf,
fonttools, ipython<10,>=8, ocpsvg, ocp_gordon, trianglesolver, sympy, scipy, scikit-learn<2,>=1.5,
webcolors, requests, lib3mf / py-lib3mf, bd_materials, threejs-materials<1.3,>=1.2.1
```

What actually came over the wire in the full bootstrap **[measured, Node fetch wrapper / Chromium `content-length`]**:

| Wheel | MB |
|---|---|
| threejs_materials-1.2.5 | **85.6** |
| cadquery_ocp_novtk_ocp_wasm-8.0.1.1 | 21.7 |
| scipy-1.18.0 (Pyodide CDN) | 13.2 |
| scikit_learn-1.8.0 (CDN) | 4.2 |
| sympy-1.14.0 (CDN) | 3.9 |
| pyodide.asm.wasm | 3.3 (on the wire; 14 MB npm package) |
| numpy-2.4.6 (CDN) | 2.8 |
| python_stdlib.zip | 2.4 |
| ezdxf, pygments, fonttools, pillow, ipython, lib3mf, build123d itself (0.37 MB), ~25 small wheels | ~8 |
| **Total** | **146.7 MB** (Chromium), 141 MB (Node, first run) |

`threejs-materials` (85.6 MB of PBR texture assets, pulled in by `bd_materials` and imported at module level by `build123d/exporters3d.py:69`) is 58% of the download and is only used for glTF material export. `ipython` is imported at module level by `topology/shape_core.py:77` (`from IPython.lib.pretty import …`) and `jupyter_tools.py`; `sklearn.cluster.DBSCAN` by `brep_from_stl.py:54`; `sympy` is required but never imported at module level **[measured, grep]**.

**Minimal variant** (`run_node_minimal.mjs`) **[measured]**: install the two OCP.wasm wheels first, then `micropip.add_mock_package` for threejs-materials, ipython, scikit-learn, sympy (+ the OCP/lib3mf names), install `build123d==0.13.0`, remove the mocks, and pre-seed `sys.modules` with tiny stubs for `threejs_materials`, `sklearn.cluster.DBSCAN`, `IPython.display.HTML`, `IPython.lib.pretty.{RepresentationPrinter,pretty}`. Result: PyPI download **24.7 MB** + Pyodide-CDN packages **18.0 MB** (scipy 13.4, numpy 2.8, fonttools 1.1, requests stack, …) + Pyodide core 11.6 MB ≈ **54 MB** first visit, and the benchmark ran with identical results. Mistakes along the way (exact errors, for anyone repeating this): mocking `lib3mf` *before* installing the real wheel → `ImportError: cannot import name 'Lib3MF' from 'lib3mf' (unknown location)`; stubbing `IPython` without `IPython.lib` → `ModuleNotFoundError: No module named 'IPython.lib'; 'IPython' is not a package`; mocking `requests` → `ModuleNotFoundError: No module named 'requests'` (exporters3d imports it, so just install it, 0.06 MB).

Further reduction would need (a) build123d upstream making threejs-materials/ipython/sklearn lazy imports (a small PR), (b) rebuilding OCP.wasm without IGES/VTK-ish toolkits (issue #41; STEP must stay), (c) dropping scipy, which is imported at module level by `objects_part.py`, `operations_sketch.py`, `objects_curve.py` (ConvexHull, Voronoi, minimize) – harder **[inferred]**.

### 1.3 Load time **[measured]**

- Pyodide core: 2.1–2.6 s (Node and Chromium alike).
- Installing wheels (download + unzip into MEMFS): 20 s in Chromium, 31–35 s in Node for the full set; 16–20 s for the minimal set. micropip unzips in Python, so this is CPU-bound, not just network.
- `import build123d`: **17 s in Chromium, 18 s in Node** (full deps), 12–14 s minimal. `import OCP` alone is 5–6.4 s (instantiating a 152 MB dylib with hundreds of thousands of pybind11 registrations). Native is 2.2 s for OCP, 2.9–3.2 s total.
- Time-to-first-part in a fresh tab: **43 s** on a fast desktop with a warm CDN. Subsequent parts: 0.65–0.75 s for the whole bench `main()` (build + two volumes + STEP out/in + tessellate + STL).
- Pyodide's experimental memory snapshot (`loadPyodide({_makeSnapshot:true})` → `makeMemorySnapshot()`) that would let the 17 s import be skipped does **not** work after loading OCP: `SNAPSHOT MAKE ERROR: Unexpected hiwire entry at index 6` **[measured, Pyodide 314.0.8]**. The documented limitation is that snapshots don't support loaded dynamic libraries / live JS proxies. So the import cost must be paid per page load (or hidden in a Web Worker, with the browser HTTP cache or a Service Worker caching the 54–147 MB of wheels).

### 1.4 Feature check **[measured]**

| Feature | Pyodide result |
|---|---|
| Box/Cylinder primitives, `GridLocations`, `Pos` | works |
| Boolean union/subtract (`+`, `-`) | works |
| `fillet` on selected circular edge, `chamfer` on face edges | works, same topology as native (18 faces) |
| `&` intersection + `.volume` | works, 10259.615 mm³ identical |
| `export_step` | works, byte-identical apart from header timestamps |
| `import_step` (re-read own file) | works, volume identical |
| `Shape.tessellate(0.1, 0.5)` | works, 892 v / 1028 tri identical |
| `export_stl` | works, 556 484 B identical |
| `is_valid` | True |
| 3MF (`Mesher`) | not exercised (lib3mf wheel installed, import succeeded) |
| SVG/DXF import, text (`fontTools`) | not exercised; deps installed |
| glTF with materials (`threejs_materials`) | not exercised; needs the 85 MB wheel |

### 1.5 Verdict for the browser **[inferred]**

Technically real and surprisingly complete: it is the same OCCT 8.0.1 + same build123d code and gives bit-identical geometry. The costs are a ~55–150 MB download, ~20–40 s cold start per tab (unavoidable 12–17 s import even when everything is cached) and 410–424 MB of wasm memory. For Merrivile, where the *AI* writes code and the human only inspects, running the kernel in the human's browser mainly buys offline/private use; it doesn't help the agent loop, which runs server-side anyway. Maintenance risk: one hobbyist maintainer, wheels tied to an exact Pyodide ABI (`pyemscripten_2026_0`, cp314), so every Pyodide major bump needs a rebuild (history shows it happened for 0.27→0.29→314 within 2026, with lag).

---

## 2. Cloudflare Python Workers

Facts **[read]**:
- Limits page (https://developers.cloudflare.com/workers/platform/limits/): Worker bundle **64 MiB uncompressed** (no compressed limit), **128 MB memory per isolate "including the JavaScript heap"** (WebAssembly allocations included), CPU 30 s default / 5 min max on Paid, **startup (global scope) must finish within 1 s**.
- "How Python Workers work" (https://developers.cloudflare.com/workers/languages/python/how-python-workers-work/): Pyodide version is chosen by compatibility date; at deploy time Cloudflare runs top-level imports and **snapshots the WebAssembly linear memory**; requests restore the snapshot ("we perform the expensive initialization work at deploy time, rather than at runtime").
- Packages page (https://developers.cloudflare.com/workers/languages/python/packages/): "pure and PyEmscripten Python packages on PyPI" and Pyodide-bundled packages; declared in `pyproject.toml`, bundled by `pywrangler`/`uv` into `python_modules` at deploy. Blog 2025-12-08 (https://blog.cloudflare.com/python-workers-advancements): cold start 1.027 s mean for fastapi+httpx+pydantic with snapshots (≈10 s without); Python Workers GA Sept 2026 (InfoQ https://infoq.com/news/2026/09/cloudflare-python-workers-ga): Python 3.12/3.13/3.14 selectable by compat flag, PEP 783 PyEmscripten wheels accepted, Cloudflare says only that it "plans to make Python Workers more memory-efficient".
- OCP.wasm publishes exactly the PEP 783 `pyemscripten` wheel tag Cloudflare says it accepts, so in principle `cadquery-ocp-novtk-OCP.wasm` is an installable dependency.

Measured numbers that matter here **[measured, §1]**:
- The OCP `.so` is 152 MB uncompressed → **2.4× the 64 MiB bundle limit on its own**; the full set of site-packages is far larger.
- Wasm linear memory is **284 MB after `import OCP`** and **410–424 MB after `import build123d`** (minimal or full deps) → **2.2–3.3× the 128 MB isolate limit**, before any geometry is built, and before counting the JS heap.
- `import build123d` takes 12–18 s; Cloudflare's snapshot would absorb this at deploy time *if* the snapshot machinery can hold a 400 MB image (Pyodide's own snapshot failed with a loaded OCP; Cloudflare's implementation is different and does support dynamic libraries per the blog, but a 400 MB snapshot is far outside the 128 MB budget anyway).

Verdict **[inferred]**: **Not feasible today, and not close.** It fails two hard limits by 2–3× (bundle size, memory). The gap is not something build123d or OCP.wasm can engineer away: OCCT's modelling + STEP toolkits alone are > 100 MB of wasm, and the ~285 MB resident after import is mostly the dylib image plus pybind11 type registrations. The realistic Cloudflare option for Python OCCT is **Cloudflare Containers** (a normal Linux container running native build123d, §4), with Workers/DO only as the front door and R2 for STEP/STL/mesh storage. The JS-side OCCT ports (opencascade.js, replicad; other researchers) are also far from 128 MB (opencascade.js full build is ~30–40 MB wasm; its runtime memory is also well above 128 MB for real parts) – out of my scope but worth cross-checking.

---

## 3. build123d vs CadQuery

### Numbers **[read, `gh api` 2026-11-21]**

| | gumyr/build123d | CadQuery/cadquery |
|---|---|---|
| Stars / forks | 3 808 / 341 | 6 148 / 575 |
| Open issues+PRs | 243 | 489 |
| Contributors | 104 | 112 |
| Commits in last 12 months | **~1 153** | ~79 |
| Releases last 12 months | 0.10.0 (2025-11), 0.11.0, 0.11.1, 0.12.0, 0.13.0 (2026-09-21) | 2.6.0, 2.6.1 (2025-10), 2.7.0 (2026-02), 2.8.0 (2026-06) |
| Created | 2022-07 | 2018-10 |
| License | Apache-2.0 | Apache-2.0 (GitHub shows NOASSERTION) |
| Kernel | OCP 8.0 (cadquery-ocp-novtk) | OCP (cadquery-ocp incl. VTK) |
| Pyodide build | yes (OCP.wasm, community) | no |
| Docs for LLMs | `llms.txt` served at https://build123d.readthedocs.io/en/latest/llms.txt (9 kB index; `sphinx-llms-txt` is in its docs extras) | none found |

build123d was derived from CadQuery's direct API and both sit on the same OCP wrapper, so shapes can be moved between them (build123d docs) **[read]**. build123d is pre-1.0 and moves fast (≈15× CadQuery's commit rate this year, API still shifting – see the `is_valid` property / `intersect` return type changes I hit). CadQuery is stable, slower, and Workplane/fluent-API centric.

### Ergonomics **[inferred, from the docs and writing the bench]**
- build123d offers two styles: *builder* (context managers `with BuildPart(): …`, implicit state) and *algebra* (`part = Box(..) - Cylinder(..)`, `Pos()*shape`, explicit objects). Algebra mode is what `tools/gen_models.py` uses, and it's the style that maps best to "an LLM emits a script, we exec it" because there is no hidden context and selectors are plain Python (`.faces().sort_by(Axis.Z)[-1].edges()`).
- CadQuery's fluent chain (`cq.Workplane("XY").box(60,40,5).faces(">Z").workplane().rect(48,28,forConstruction=True).vertices().hole(5)`) is compact and heavily represented in training data, but string selectors (`">Z"`, `"|Z"`) and workplane state are a frequent LLM failure point; errors surface far from their cause.

### Which do LLMs write better? **[read]**
- **CADDesigner** (arXiv 2508.01031, v6 2026-05-19, https://arxiv.org/html/2508.01031v6), Table 5, 200 test models, Claude-4-Sonnet as the code-writing agent with per-library RAG over official docs: **build123d Pass@1 0.59, CD 0.157, HD 0.513, latency 363 s** vs **CadQuery 0.50 / 0.182 / 0.519 / 541 s** (and their own ECIP 0.46). Quote: "Build123d attains the highest Pass@1 and shortest latency", attributed to its compact syntax; both "show wider variability and higher CD/HD" than ECIP. This is the only head-to-head I found.
- **CADGenBench** (huggingface/cadgenbench, 157★, created 2026-05-27, https://github.com/huggingface/cadgenbench): tool-agnostic (scores STEP), but its reference baseline "supports the build123d and CadQuery backends" with **build123d as the default**. Leaderboard Space returned HTTP 401 to me.
- **build123d-mcp** (pzfreo, 157★, pushed 2026-11-21): claims that on the CADGenBench leaderboard in June 2026 its feedback-loop server lifted the same model from 0.360 → 0.457 CAD score and 88% → 100% validity. Vendor claim, but it shows the active AI-CAD tooling is accreting around build123d. It ships a 43 kB `llms.md` cheat-sheet (cloned at `reference/repos/build123d-mcp/llms.md`) – useful raw material for Merrivile's system prompt.
- Text2CAD-Bench (arXiv 2605.18430) and MUSE (arXiv 2605.28579) use CadQuery only, and report that even producing an executable CadQuery script is hard; they don't test build123d. Survey: arXiv 2505.08137.

Verdict **[inferred]**: Keep build123d. Evidence (one paper, the benchmark default, the MCP ecosystem) points the same way, it's what the repo already uses, it is the only one with a browser build, and its algebra API is the easiest to sandbox and explain in a tool schema. Mitigate its API churn by pinning the version (0.13.0), by putting the version-specific gotchas (`is_valid` property, `&` for intersection, `GridLocations`, `Align`) into the system prompt, and by giving the model an execution feedback loop (errors + measurements), which build123d-mcp's numbers suggest matters more than the library choice.

---

## 4. Native server-side build123d

### Measured on this machine (Python 3.12.3, build123d 0.13.0, OCP 8.0.1.1, 3 runs) **[measured]**

| | value |
|---|---|
| `python -c "import build123d"` wall | 4.07 s incl. 0.7 s venv startup; `-X importtime` total **2.6 s** (OCP.OCP 0.65 s, sklearn 0.6 s, `brep_from_stl` 0.74 s, build_common 1.45 s cumulative) |
| `import OCP` only | 2.23 s wall, **277 MB** max RSS |
| after `import build123d` | **437 MB** max RSS |
| bench part (build + volumes + STEP + tessellate + STL) | 0.05 s build, 0.1 s intersect, whole process 4.5–4.8 s wall, **470–483 MB** max RSS |
| bare python | 54 MB RSS |
| site-packages on disk (`uv pip install build123d==0.13.0`) | **870 MB**: cadquery_ocp_novtk.libs 230 MB + OCP 151 MB (= 381 MB OCCT), scipy 92+30, threejs_materials 87, sklearn 38, numpy 34+23, jedi 33 (ipython), ezdxf 31, sympy 30, fontTools 24, pillow 15 |
| removable with lazy imports upstream (threejs_materials, sklearn, jedi, sympy, IPython) | 189 MB |

### Docker image size **[inferred – I could not run docker: `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock`, user not in the docker group, sudo needs a password]**
`python:3.12-slim` is ~125 MB; `pip install build123d` adds the 870 MB above (plus pip cache if not `--no-cache-dir`) → **≈1.0 GB uncompressed, ~300–350 MB compressed** (OCCT .so files compress ~3:1, as the 152 MB → 22.7 MB wasm wheel shows). The Dockerfile is in `reference/bench/docker/` for whoever has docker rights. Cloudflare Containers limits (https://developers.cloudflare.com/containers/platform-details/limits/) **[read]**: lite 1/16 vCPU / 256 MiB / 2 GB disk; basic 1/4 vCPU / 1 GiB / 4 GB; standard-1 1/2 vCPU / 4 GiB / 8 GB; max image size "same as instance disk space"; 50 GB image storage per account. So a ~1 GB build123d image fits from `basic` up; `lite` (256 MiB) is too small for the ~440–480 MB RSS measured above, so **`basic` (1 GiB) is the floor for one worker process, `standard-1` (4 GiB) for a small pool** **[inferred]**.

### Process strategy **[inferred from the numbers]**
- Cold start of a worker process: ~3 s import + ~440 MB RSS. Never pay this per request: keep a **warm pool** (one process per concurrent job; `fork()` after import doesn't help much because OCCT's memory is mostly the loaded .so and static registries which are already copy-on-write shared pages, so N processes cost ~N×(440−~300 shared) ≈ 150–200 MB each incremental – unmeasured, inferred from the import-only RSS vs libs size).
- A single long-lived process handles a bench-size part in ~0.1–0.3 s; the real cost per request is the AI round-trip, not geometry. Run each AI-written script in a **subprocess with a timeout** (OCCT can hang or crash on bad booleans; a crash must not kill the pool) – i.e. a tiny supervisor like build123d-mcp's sandbox.
- Cache by script hash → STEP/BREP + mesh JSON in R2; recompute only on edit. `Shape.tessellate` is 20 ms natively, so meshes can be produced on demand; the expensive part would be re-running the whole script, so cache the BREP (`export_brep`, fast and lossless) between edits.
- Memory limit for the container: 1 GB is comfortable for one worker (max RSS 483 MB here); 2 GB for two.

---

## 5. Viewer / tessellation tooling

### ocp-tessellate (bernhard-42) **[read + measured]**
- 15★ (it's a backend library; ocp_vscode, its consumer, is the popular one), Apache-2.0, pushed 2026-11-20, v3.7.0; requires OCP 7.8/7.9/8.0 or nanocct.
- API: `group, instances = to_ocpgroup(obj)`; `meshed, shapes, mapping = tessellate_group(group, instances, kwargs={"deviation":…, "angular_tolerance":…})`; or `export_three_cad_viewer_js(...)`.
- On the bench part: import 0.09 s, tessellate **0.08 s**. Output per instance (numpy arrays) **[measured]**: `vertices (7956 f32 = 2652 verts)`, `triangles (10704 i32 = 3568 tris)`, `normals`, `edges (5166 f32 polyline segments)`, `obj_vertices (75)`, **`face_types (18)`, `edge_types (40)`, `triangles_per_face (18)`, `segments_per_edge (40)`**. The last four give exactly the per-face / per-edge ID mapping needed for picking and highlighting faces/edges in an r3f viewer (triangle index → face index by prefix sums of `triangles_per_face`). `shapes` is the three-cad-viewer scene tree (`version: 3`, `parts[]`, `loc` as `[xyz, quaternion]`, `color`, `alpha`, `state`, `bb`), and `mapping` links back to the `TopoDS_Shape` with a `cache_id`.
- It is unopinionated about the renderer: it is plain numpy → JSON/typed arrays. Merrivile can use it server-side (native) to produce a compact binary mesh with face/edge IDs instead of STL, and keep its own r3f viewer. Note it tessellates vertices per face (2652 vs 892 for `Shape.tessellate`), which is what you want for per-face colouring/flat normals.

### three-cad-viewer (bernhard-42) **[read]**
- 397★, MIT, v5.2.1, pushed 2026-11-20, TypeScript, three.js; the clone is 540 MB because `docs/` + `examples/` hold big sample meshes. `Data Format.md` and `Design.md` are the useful documents: hierarchical `Shapes` tree, `[faces, edges]` visibility state per leaf, GPU id-picking (`IdPicker`), measurement/select/zebra tools, clipping, a "Studio" PBR mode with materials table, assembly `loc` transforms, explode slider (`Changes.md`).
- It is a batteries-included imperative viewer (own toolbar/tree/DOM), not an r3f component; embedding it inside a React/r3f app would mean giving it a canvas and a container and talking to it via `Viewer` methods. For Merrivile it's more useful as a **reference** – its data format (face/edge arrays + per-face counts), its id-picking approach, and the three-cad-viewer `Shapes` JSON could be adopted wholesale as the wire format from the Python side, with Merrivile's own r3f components rendering it. **[inferred]**

### Part libraries **[measured in `reference/bench/tessellate/.venv`, bd_warehouse 0.4.0]**

| Part | time | faces | volume |
|---|---|---|---|
| `SocketHeadCapScrew("M4-0.7", 12, simple=True)` | 0.14 s | 13 | 246.8 |
| same, `simple=False` (real thread) | 0.26 s | 165 | 286.3 |
| `HexNut("M4-0.7")` | 0.07 s | 27 | 95.2 |
| `SpurGear(module=1, tooth_count=20, thickness=5)` | 0.22 s | 122 | 1532.6 |
| `SingleRowDeepGrooveBallBearing("M8-22-7")` (608) | 0.17 s | 28 | 1659.0 |
| `IsoThread(major_diameter=8, pitch=1.25, length=10)` | 0.18 s | 72 | 98.1 |

bd_warehouse (117★, pushed 2026-11-05) modules: bearing, bushing, fastener (166 kB: screws, nuts, washers, many ISO/DIN standards from CSV data), flange, gear (89 kB: involute spur/ring/rack, `SpurGear`, `SpurGearPlan`), open_builds (V-slot extrusions), o_rings, pipe, retaining_ring, shaft_key, sprocket, thread (ISO/ACME/metric trapezoidal/plastic). All work with build123d 0.13 out of the box. Other gear options: GarryBGoode/py_gearworks (formerly gggears, 79★, pushed 2026-11-15, listed in build123d's external-tools page) for bevel/helical/planetary; meadiode/cq_gears (170★, CadQuery, last push 2024-12) is dormant **[read]**. For the actuator in `tools/gen_models.py`, `bd_warehouse.gear.SpurGear` would replace the hand-rolled rectangular-tooth `spur()` with real involute teeth **[inferred]**.

---

## 6. Summary of verdicts

1. **OCP.wasm in the browser** – works, bit-identical geometry, ~5× slower than native, 54–147 MB download, 12–17 s import (not snapshot-able), 410–424 MB wasm memory. Viable for an optional "run offline in the browser" mode or a self-contained playground; not needed for the Merrivile loop where the agent executes code server-side. One-person project, ABI-tied to Pyodide releases.
2. **Cloudflare Python Workers** – no: 152 MB extension vs 64 MiB bundle limit; 285–424 MB wasm memory vs 128 MB isolate limit. Use **Cloudflare Containers** with native build123d instead.
3. **Native build123d** – 2.6–3.2 s import, ~440 MB RSS after import, ~480 MB peak for a part, 870 MB site-packages (~1 GB image). Warm pool + subprocess sandbox + BREP/mesh caching.
4. **build123d over CadQuery** – better LLM results in the one head-to-head (Pass@1 0.59 vs 0.50), default in CADGenBench, far more active development, `llms.txt`, Pyodide build exists; cost is API churn (pin 0.13, prompt with gotchas).
5. **ocp-tessellate** – yes, reuse it server-side for meshes with face/edge IDs (80 ms per part); **three-cad-viewer** – reuse its data format and picking ideas, not the component.
6. **bd_warehouse** – fasteners, nuts, bearings, threads, spur gears all work; py_gearworks for fancier gears.
