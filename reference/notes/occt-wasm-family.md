# OpenCASCADE-to-WASM JavaScript family — survey and benchmark

Date: 2026-11-21. Scope: every notable project that ships OCCT compiled to WebAssembly for JS/TS,
evaluated against Merrivile's requirements (real B-rep + STEP, fillet/chamfer, booleans, tessellation
with face/edge IDs, interference volume, assemblies, LLM-writability, browser/edge runtime, licensing,
maintenance, size). Companion material:

- Clones (shallow): `reference/repos/{opencascade.js,taucad-opencascade.js,replicad,CascadeStudio,chili3d,bitbybit,occt-import-js,occt-wasm}`
- Prototypes: `reference/bench/{build123d,replicad,opencascadejs,libcascade,bitbybit,occt-import-js,occt-wasm}`

Evidence tags used below: **[measured]** = I ran it on this machine (Node v22.16.0, Linux 6.8, build123d 0.13 in
`.venv`); **[read]** = taken from docs, code, package metadata, GitHub API or npm registry; **[inferred]** = my reasoning.

---

## 0. TL;DR

| Option | Verdict | Use it for… |
|---|---|---|
| **replicad** 1.2.1 (+ replicad-opencascadejs) | Best high-level JS API; MIT; active (1.0 in Aug 2026); wasm 22.5 MB / 7.2 MB gz; meshes carry `faceId`/`edgeId` | The LLM-facing modelling API in browser or Node/Container |
| **libcascade** 3.1.0 (taucad fork of opencascade.js) | The *maintained* raw OCCT 8.0.1 binding (253 commits/yr); suffix-free overloads, native wasm exceptions, pthread build; 42.7 MB / 12.2 MB gz | Raw OCCT escape hatch under replicad (replicad already builds on this toolchain) |
| **opencascade.js** 2.0-beta (donalffons) | Dormant since 2023-03, OCCT 7.6-dev, 50 MB / 13.7 MB gz, 6 s load. Historic; do not adopt | Nothing new; it is the ancestor of everything else |
| **occt-wasm** 5.18 (andymai) + brepjs | New (Mar 2026), very active, OCCT 8.0.1, 21.4 MB / 6.8 MB gz (4.5 MB br), arena handles, Node+Worker, structured errors; MIT tooling / LGPL wasm | A second strong candidate for a kernel service; smaller than libcascade, friendlier than raw embind |
| **@bitbybit-dev/occt** 1.7.0 | Rich DTO API, OCCT 8.0.1, 3 wasm variants incl. 64-bit + pthreads, MCP server for agents; but the C++ kernel layer is **closed source** and the package is Y-up; 31.7 MB / 9.7 MB gz | Only if you want their cloud/MCP ecosystem; not as the kernel we own |
| **Chili3D** 0.8 | AGPL-3.0 app; `chili-wasm` is LGPL-3.0 and built with `-sENVIRONMENT=web` (no Node); 10.7 MB / 4.6 MB gz; tessellation with face/edge groups; has an AI chat/MCP bridge | Reference implementation for a browser CAD UI, not a library |
| **CascadeStudio** 2 (zalo) | MIT; worker-only engine (`cascade-core`) on zalo's own OCCT 8.0.0-rc4 fork of opencascade.js (21.2 MB / 6.4 MB gz); live again in 2026 | Reference for an LLM-friendly "standard library" over raw OCCT; `CascadeAPI` agent hooks |
| **occt-import-js** 0.0.23 | Import-only (STEP/IGES/BREP → meshes with `brep_faces` ranges), OCCT 7.6.1, 7.6 MB / 3.1 MB gz, 50 ms load, frozen since 2024-12 | Keep as the viewer's STEP importer (what web/ uses today); nothing else |
| **Official OCCT WASM** | None exists as a JS package. OCCT ships an Emscripten CMake toolchain + WebGL sample only | — |

**Benchmark headline [measured]:** all four B-rep implementations (native build123d, replicad, opencascade.js beta,
libcascade; bitbybit too) produced the identical part: volume **15345.8917 mm³**, 18 faces / 40 edges, valid, and the
identical interference volume **10259.6152 mm³** with a copy shifted 10 mm in X. Every WASM-written STEP re-imported
in native build123d with the same volume/face count.

---

## 1. Benchmark

### 1.1 Part definition (as finally agreed in `reference/bench/build123d/bench.py`)

60×40×5 plate (centred in XY, z=0..5), 0.5 mm chamfer on the four top outer edges, Ø20×15 boss standing on the plate
(z=5..20), 2 mm fillet at the boss/plate junction, four Ø5 through holes at (±24, ±14), Ø8 bore through plate+boss.
Then: volume, STEP + STL export, tessellation with face ids, and `volume(part ∩ translate(part, 10,0,0))`.

Note: the baseline script in `bench/build123d/` was being edited concurrently by another survey agent while I worked
(the boss interpretation changed from "z=0..15" to "on top of the plate, z=5..20"). I re-aligned all WASM prototypes to
the final interpretation and re-ran everything; the numbers below are all from the final geometry. The earlier
interpretation also agreed across kernels (14026.4228 / 9875.338).

### 1.2 Results [measured]

Node v22.16.0, single run unless noted (3 runs for the three JS B-rep kernels; ranges shown). `peak RSS` is
`/usr/bin/time -v` max resident set of the whole process. Tessellation at linear 0.01 / angular 0.2.

| Kernel | wasm load | build | STEP export | STL | mesh+ids | ∩ volume calc | volume | faces/edges | ∩ volume | peak RSS | STEP re-import (build123d) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **build123d 0.13 native** (OCP 8.0.1) | import 2.95–3.16 s | 60 ms | 10 ms | 78 ms | 97 ms (7267 v / 11128 t) | 93–150 ms | 15345.8917 | 18/40 valid | 10259.6152 | 468 MB | — (baseline) |
| **replicad 1.2.1** / replicad-opencascadejs 1.2.1 (OCCT 8.0.1 via taucad 3.1.0 toolchain) | 340–467 ms | 303–405 ms | 81–113 ms | 266–412 ms | 79–125 ms (4287 v / 6598 t, 18 faceGroups, 40 edgeGroups) | 590–996 ms | 15345.8917 | 18/40 valid | 10259.6152 | 401–418 MB (wasm heap 100 MB) | 15345.8917, 18 faces, valid |
| **opencascade.js 2.0.0-beta.b5ff984** full (OCCT 7.6-dev, 2022-04) | **5.97–6.94 s** | 311–463 ms | 82–104 ms | 37–49 ms | 210–317 ms (18 face groups) | 1.33–1.70 s | 15345.8917 | 18/40 valid | 10259.6152 | 647–655 MB (heap 100 MB) | 15345.8917, 18 faces, valid |
| **libcascade 3.1.0** single (OCCT 8.0.1) | 1.19–1.51 s | 155–191 ms | 66–103 ms | 75–104 ms | 82–126 ms (18 face groups) | 383–586 ms | 15345.8917 | 18/40 valid | 10259.6152 | 513–523 MB (heap 128 MB) | 15345.8917, 18 faces, valid |
| **@bitbybit-dev/occt 1.7.0** (32-bit single, OCCT 8.0.1 fork) | 1.04–1.15 s | 262–332 ms | n/m | n/m | 149 ms (18 faceList / 40 edgeList) | 539–593 ms | 15345.8917 | 18 | 10259.6152 | 503–525 MB | 15345.8917, 18 faces, valid |
| **occt-import-js 0.0.23** (import only, OCCT 7.6.1) | 50 ms | — | — | — | read replicad STEP: 333 ms → 1 mesh, 4287 v / 6598 t, `brep_faces` = 18 ranges | — | — | — | — | 228 MB | — |

Observations:
- Volume and interference volume are bit-identical across OCCT 7.6 / 8.0.1, native and wasm — booleans, fillet and
  chamfer are the same algorithms; what differs is speed and packaging.
- libcascade (OCCT 8.0.1 + `-fwasm-exceptions` + mimalloc) is ~2× faster than the 2023 beta on build, mesh and
  booleans, and loads in ~1.3 s instead of ~6 s. replicad sits between because of its wrapper overhead and because
  `measureVolume`/`intersect` allocate wrapper objects.
- Native build123d is still 3–5× faster on booleans than any wasm build (60 ms build vs 155–405 ms), but pays 3 s
  of Python import.
- Peak RSS of any OCCT-wasm process is 400–650 MB in Node — that is Node + V8 + a 100–128 MB initial wasm heap. See
  §4 for what that means on Cloudflare.
- STEP files: replicad's is AP214 (`AUTOMOTIVE_DESIGN`) ~56 KB; raw builds ~50.5 KB. All re-import cleanly.

### 1.3 Code size and "how natural for an LLM" [measured + inferred]

| | Lines of modelling code (whole script incl. timing/export) | Notes |
|---|---|---|
| build123d | 62 (`bench/build123d/bench.py`) | `Box - Cylinder`, `chamfer(edges, 0.5)`, `fillet(edges.filter_by(GeomType.CIRCLE)…, 2)`. Edge selection by filters. Most natural. |
| replicad | 96 (`bench/replicad/bench.mjs`), ~20 lines of actual modelling | `makeBaseBox(60,40,5).chamfer(0.5, e => e.inPlane("XY", 5)).fuse(makeCylinder(10,15,[0,0,5])).fillet(2, e => e.ofCurveType("CIRCLE").inPlane("XY",5).ofLength(2π·10))`. Fluent, immutable-looking, finder-based selection. Very close to what an LLM would guess. |
| raw opencascade.js / libcascade | 129 (`bench/opencascadejs/bench-core.mjs`), ~45 lines of modelling | `new oc.BRepPrimAPI_MakeBox_3(gp_Pnt, 60,40,5)`, `TopExp_Explorer`, `BRepAdaptor_Curve.GetType()==GeomAbs_Circle`, `BRepFilletAPI_MakeFillet.Add_2(r, edge)`, `BRepAlgoAPI_Cut_3(a,b,Message_ProgressRange)`, STEP via emscripten FS. An LLM knows OCCT's C++ names, but the embind overload suffixes (`_2`, `_3`), `Handle<>.get()`, `Message_ProgressRange` arguments and manual `.delete()` are exactly the things it gets wrong. libcascade removes the suffixes (same source ran on both via a 3-line adapter) but still needs OCCT knowledge. |
| bitbybit | ~45 lines of modelling (`bench/bitbybit/smoke.mjs`) | DTO calls: `fillets.filletEdges({shape, radius:2, indexes:[20]})`. Edge selection is by **index**, so you must enumerate edges and compute centres/lengths yourself. **Y-up** (`createBox` height is Y) tripped me (first attempt built the plate in XZ). Has an MCP server that serves exact signatures to agents. |

---

## 2. Project-by-project

### 2.1 opencascade.js (donalffons) — the ancestor

- Repo: https://github.com/donalffons/opencascade.js — 945 stars, LGPL-2.1, created 2020-01. **Last commit 2023-03-27, 0 commits in the last 12 months**, last release tag v1.1.1 (2020-09). npm `opencascade.js@1.1.1` (2023-03-23), `@beta` = `2.0.0-beta.b5ff984` (2023-03-23). [read: gh api, npm]
- Open issues "Project Maintenance Status?" (#273, 2024-03) and "Is this still maintained?" (#305, 2026-07) are unanswered by the author; the community points at forks. PR #301 "feat: OCCT V8 + Emscripten 6 with native WASM exceptions" (by rifont, 2026-03, 21 comments) is open and is what became the taucad fork. [read]
- OCCT version: Dockerfile pins OCCT commit `bb368e27…` = 2022-04-26 ("BOP wrong results on a cone…"), i.e. a 7.6.x dev snapshot; emsdk 3.1.14. [read: Dockerfile + gh api]
- Size: `opencascade.full.wasm` **50.3 MB raw / 13.7 MB gzip**; `opencascade.full.d.ts` 203k lines (8540 classes). [measured]
- Load time in Node: **6.0–6.9 s** (the 50 MB module is compiled synchronously-ish; no wasm cache). [measured]
- API coverage: everything (full OCCT) — fillet (`BRepFilletAPI_MakeFillet`), chamfer, booleans (`BRepAlgoAPI_*`), STEP read/write (`STEPControl_Reader/Writer`, via emscripten FS), `BRepMesh_IncrementalMesh` + `BRep_Tool.Triangulation` per face (you build face/edge ids yourself with explorers), `BRepGProp.VolumeProperties`. Verified by the benchmark. [measured]
- Threading: build system has a `multi-threaded` variant (`-pthread`), the published beta is single-threaded. Memory: `INITIAL_MEMORY=100 MB`, `ALLOW_MEMORY_GROWTH`. Memory management is manual `.delete()` on every embind object; nothing frees itself. [read: compile scripts + dist js; measured heap]
- Node: yes (`opencascade.js/dist/node.js` patches `__dirname`/`require`). Cloudflare Worker: 50 MB wasm is under the new 64 MiB uncompressed limit but the 100 MB initial heap alone is close to the 128 MB isolate limit — see §4. [read + inferred]
- Custom builds: a YAML "custom build" mechanism (via Docker + ytt) lets you bind only the classes you need; this is what replicad, CascadeStudio and others use to get 21–23 MB builds. [read]
- License: LGPL-2.1 (OCCT's licence incl. the Open CASCADE exception) applies to the wasm. See §5.

**Verdict:** dormant. Everything useful about it now lives in the taucad fork (libcascade). Do not start new work on it.

### 2.2 libcascade — taucad/opencascade.js fork (the maintained raw binding)

- Repo: https://github.com/taucad/opencascade.js (fork of donalffons, created 2026-02-21), 16 stars but **253 commits in the last 12 months**, last push 2026-11-12, maintainer `rifont` (250 commits). Releases v3.0.0 (2026-08-13) … **v3.1.0 (2026-10-13)**. npm `libcascade@3.1.0` (2026-10-13), engines `node>=22`, ESM only. [read: gh api, npm]
- OCCT **8.0.1** (DEPS.json pins commit `b8f597c6`, tag V8_0_1), Emscripten 6.0.5, `-O3 -fwasm-exceptions -msimd128`, mimalloc, `INITIAL_MEMORY=128MB`, `MAXIMUM_MEMORY=4GB`, `ALLOW_MEMORY_GROWTH`, `-sWASM_BIGINT`. Each dist file has a `provenance.json`. [read]
- Size: `opencascade_single.wasm` **42.75 MB raw / 12.19 MB gzip**; `opencascade_multi.wasm` 42.73 MB / 12.22 MB gz; `types.d.ts` 263k lines (4797 classes, 4496 bound symbols). [measured]
- Load time in Node: **1.19–1.51 s**. [measured]
- What changed vs. the beta ("What's new in v3", README): suffix-free overloads (one symbol per class, val-based dispatch — `new oc.gp_Pnt(x,y,z)`), native wasm exceptions decodable via `oc.getExceptionMessage`, return-by-value output params, full TS/JSDoc bindings, reproducible builds, a container toolchain `ghcr.io/taucad/opencascade.js:3.1.0-{single,multi}-threaded` for custom builds. BENCHMARKS.md claims ~parity with native C++ on heavy fuses and 1.1–1.4× vs build123d on meshing/booleans; multi-thread: 1.24× overall, 1.81× boolean grid, +39% init. [read]
- Threading: `libcascade/multi/init` gives a pthread build; needs COOP/COEP headers in browsers; `oc.BOPAlgo_Options.SetParallelMode(true)` etc. [read]
- Memory management: still manual `.delete()`; README recommends the `using` keyword (explicit resource management) — Node 22 doesn't support `using` syntax natively, Node 24 does. [read + measured: I had to use `.delete()`-free leaky code in Node 22]
- Gaps I hit [measured]: `TopTools_IndexedMapOfShape` / `TopExp.MapShapes` are **not bound** in 3.1.0 (I fell back to O(n²) `IsSame` to count unique edges). `BRep_Tool.Triangulation` returns the object directly rather than a `Handle` (`.get()` not needed). Otherwise the same modelling code ran on both the beta and libcascade.
- Node: yes. Browser: yes. replicad-opencascadejs 1.2.1 is built with this exact toolchain (its package.json build scripts), which is why replicad and libcascade share the same OCCT 8.0.1 results. [read]
- License: LGPL-2.1-only WITH Open-CASCADE-Exception-1.0 (npm metadata). [read]

**Verdict:** this is the "raw opencascade.js" to use if we want direct OCCT. Young project with a single very active maintainer; the fact that replicad standardised on it is the strongest signal.

### 2.3 replicad (sgenoud) — the high-level API

- Repo: https://github.com/sgenoud/replicad — 724 stars, MIT, created 2021-11, **last push 2026-11-06, 100 commits in 12 months**, essentially one maintainer (sgenoud 442 commits; next contributors 14 and 13). Reached **1.0.0 on 2026-08-14**; now 1.2.1 (2026-11-06). npm: `replicad` (MIT), `replicad-opencascadejs` (LGPL-2.1-only, 48.8 MB unpacked), `replicad-threejs-helper`, `replicad-cli`, `replicad-evaluator`, studio app. [read: gh api, npm]
- OCCT: 8.0.1 via the taucad 3.1.0 toolchain, as a **custom build** binding only what replicad needs: `replicad_single.d.ts` declares 302 classes vs libcascade's 4797. Both `single` and `multi` (pthread) wasm ship. [read + measured]
- Size: `replicad_single.wasm` **22.9 MB raw / 7.21 MB gzip**; `replicad_multi.wasm` 22.5 MB / 7.20 MB gz; `replicad.js` 708 KB (148 KB gz); plus `opentype.js` (fonts) and `manifold-3d` (optional mesh kernel, `MeshShape`) as peers. [measured]
- Load in Node: **340–467 ms**; wasm heap 100 MB at rest. [measured]
- API coverage for our needs [read d.ts + measured]:
  - `fillet(radiusConfig, filter?)`, `chamfer(...)` with `EdgeFinder` (`inPlane`, `ofCurveType`, `ofLength`, `inDirection`, `parallelTo`, `containsPoint`, …) and radius-as-function; also `draft` and 2D `Drawing.fillet/chamfer`.
  - Booleans `fuse/cut/intersect` (+ `simplify`), `makeBaseBox/makeCylinder/...`, sketches, extrude/revolve/loft/sweep.
  - `blobSTEP()`, `exportSTEP(shapes, {unit})` (multi-shape assembly STEP with colour/name), `importSTEP(blob)`, `blobSTL`, `importSTL`.
  - `mesh({tolerance, angularTolerance})` → `{vertices, triangles, normals, faceGroups:[{start,count,faceId}]}` and `meshEdges()` → `{lines, edgeGroups:[{start,count,edgeId}]}`; `replicad-threejs-helper` turns these into BufferGeometry groups for picking. Exactly requirement 2. [measured: 18 face groups, 40 edge groups]
  - `measureVolume`, `measureArea`, `measureLength`, `measureDistanceBetween`, `measureShapeVolumeProperties` (centre of mass). [measured]
  - Escape hatch: `getOC()` returns the embind instance; `shape.wrapped` is the `TopoDS_Shape` (I used `BRepCheck_Analyzer` through it).
- Memory management: wrapper objects register with a `FinalizationRegistry` that calls `.delete()` when the JS object is collected, plus `GCWithScope()`/`localGC()` helpers; so user code never calls `.delete()`. [read: `src/register.ts`]
- Threading/workers: the docs and studio run replicad in a Web Worker via comlink (`studio/src/builder.worker.js`); the `multi` wasm exists but the library itself doesn't expose parallel toggles. [read]
- Node: yes (`replicad-cli` does exactly this); the wasm module auto-detects Node and reads the file next to the loader. [measured]
- Assemblies: no assembly model; `exportSTEP([{shape, name, color}])` writes several shapes in one STEP; placing parts = `translate/rotate` the shapes yourself. [read]
- LLM-writability: best of the family. The API reads like build123d-in-JS and the docs are short. Risks: replicad-specific conventions (`makeBaseBox` is centred in XY with z from 0, `inPlane("XY", 5)` for a z-offset) that an LLM must be told.

**Verdict:** the high-level API to put in front of the LLM. One-maintainer risk is real but the project just shipped 1.0 and rebased its kernel on the maintained fork.

### 2.4 occt-wasm (andymai) + brepjs — the newcomer

- Repo: https://github.com/andymai/occt-wasm — created 2026-03-26, 77 stars, MIT OR Apache-2.0 tooling, **pushed 2026-11-21 (today)**, releases weekly (v5.18.0 2026-11-21, v5.17.2 2026-11-14), one maintainer (andymai 267 commits). Companion https://github.com/andymai/brepjs (150 stars, Apache-2.0, npm brepjs 20.28.3) is a higher-level parametric API "AI agents can write parts with". [read: gh api, npm]
- OCCT **8.0.1** (submodule points to andymai/OCCT commit c7f60ffe, 2026-09-21; version.cmake says 8.0.1). [read]
- Size: `occt-wasm.wasm` **21.37 MB raw / 6.81 MB gzip** (README claims ~4.5 MB brotli; brotli isn't installed here so unverified). Excludes TKV3d/AIS, IGES. Requires wasm SIMD + tail calls + wasm exceptions. [measured + read]
- API: ~170 methods on an `OcctKernel` object; shapes are **u32 arena handles** (no `.delete()`, `release()` or `Symbol.dispose` on the kernel); structured error codes (`OcctErrorCode`); `fillet(solid, edges, r)`, `chamfer`, `fuse/cut/common`, `tessellate()` → positions/normals/indices, `wireframe()`, `exportStep/importStep`, STL/glTF/BREP, XCAF assemblies, `getVolume`, shape history. `OcctWorker` (comlink) for Web Workers; Node 18+ supported. I did not build the benchmark part on it (out of the requested scope), only installed it. [read]
- License: wasm output LGPL-2.1-only; README explicitly argues loading the `.wasm` from a URL satisfies LGPL relinking (user can override `OcctKernel.init({wasm})`). [read]

**Verdict:** worth a follow-up prototype. It is the only project besides bitbybit that designed memory management (arena handles) and errors for programmatic callers, and brepjs explicitly targets agents. Risk: 8 months old, one person, breaking-change cadence (v5 already).

### 2.5 CascadeStudio (zalo)

- Repo: https://github.com/zalo/CascadeStudio — 1510 stars, MIT, **106 commits in 12 months**, last commit 2026-06-16, last push 2026-10-19; zalo 339 commits, next contributor 10. No GitHub releases; the app deploys to GitHub Pages/Vercel. [read]
- Rewritten in 2026 as a monorepo: `packages/cascade-core` (engine: Web Worker + `ShapeToMesh.js` + `StandardLibrary.js`) and `packages/cascade-studio` (UI). README: "exposes the full power of the OpenCascade kernel (OCCT 8.0)", `Volume()/SurfaceArea()/CenterOfMass()`, a selector API `Edges(shape).parallel([0,0,1]).max([0,0,1]).indices()`, OpenSCAD mode, modelling-history timeline, and an **Agent API `window.CascadeAPI`** for Playwright/tooling. [read]
- Kernel: depends on `github:zalo/opencascade.js#cascadestudio-v2` — zalo's own fork, Dockerfile pins **OCCT V8_0_0_rc4** + emsdk 4.0.23 (branch updated 2026-02-20). `dist/cascadestudio.wasm` **21.24 MB raw / 6.44 MB gzip** (custom build). [read + measured by downloading]
- Face/edge ids: `ShapeToMesh.js` enumerates faces with `TopExp_Explorer` and keys edges by `OCJS.HashCode(edge)`, emitting `face_index`/edge indices per group. [read]
- Runtime: the engine is "evaluate CAD code in a Web Worker"; `cascade-core` README only documents copying `cascade-worker.js`, `cascadestudio.wasm`, `fonts/` into static assets — **no Node entry**. [read]

**Verdict:** a good reference for a concise, LLM-friendly standard library over raw OCCT (its `StandardLibrary.js` is essentially what an LLM tool layer looks like) but it is an app, not a library we'd depend on.

### 2.6 Chili3D (xiangechen)

- Repo: https://github.com/xiangechen/chili3d — 5014 stars, **AGPL-3.0**, 470 commits in 12 months, release 0.8.0 (2026-10-30), xiangechen 1321 commits vs next contributor 7. README: commercial "Chili3D Pro" edition exists; "for commercial licensing options, contact xiangetg@msn.cn"; "The C++ WASM module (`cpp/`) is licensed under LGPL-3.0". [read]
- Kernel: `packages/wasm` builds OCCT **V8_0_1** (`scripts/setup_wasm_deps.mjs`) with emsdk latest; link flags `-sEXPORT_ES6=1 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sENVIRONMENT=web` → **browser only** (the generated loader has no Node branch). Prebuilt `chili-wasm.wasm` is checked into the repo: **10.68 MB raw / 4.57 MB gzip** (npm `chili3d@1.1.2` ships a 15.8 MB variant). [read + measured]
- Exposed C++ surface (`chili-wasm.d.ts`, 941 lines): a `ShapeFactory` with `fillet(shape, edgeIndexes[], r)`, `chamfer`, `filletVariable`, `chamferTwoDist`, `booleanCommon/Cut/Fuse` (+ `*Tracked` variants returning history), `removeFillet`; `Converter.convertFromStep(Uint8Array)` / `convertToStep(shapes[])`; `Mesher.mesh()` → `FaceMeshData {position, normal, uv, index, group, faces[]}` + `EdgeMeshData {position, group, edges[]}` — tessellation with face/edge mapping built in; `volume(shape)`. It is a hand-written embind facade, not a full binding. [read]
- AI: `packages/ai` provides chat-driven modelling (Anthropic + OpenAI-compatible providers), `run_program` / `run_parametric` tools, on-demand skills, and a local MCP bridge (`chili3d-mcp`). [read]

**Verdict:** AGPL rules it out as a dependency for a commercial SaaS unless you buy a licence; the LGPL `cpp/` facade is small and instructive (it shows the ~900-line API surface a browser CAD actually needs) but is web-only. Great competitor/reference for "AI edits a model".

### 2.7 bitbybit.dev (@bitbybit-dev/occt and friends)

- Repo: https://github.com/bitbybit-dev/bitbybit — 212 stars, MIT, **757 commits in 12 months**, v1.7.0 (2026-11-17), matas-bitbybit-dev 1647 commits (company-backed, essentially one developer). Packages: `@bitbybit-dev/occt` (102 MB unpacked), `occt-worker`, `core`, `manifold`, `jscad`, `threejs`, `babylonjs`, `mcp`, `cad-cloud-sdk`. [read]
- Kernel: OCCT **8.0.1** (their fork `bitbybit-dev/OCCT` branch `bitbybit-main`, updated 2026-11-18). Three wasm builds: `bitbybit-dev-occt` 32-bit **31.70 MB / 9.67 MB gz**, `-64-bit` (memory64, 33.17 MB / 9.95 MB gz), `-64-bit-mt` (pthreads, 32.02 MB / 9.77 MB gz). [read + measured]
- **The C++ "Bitbybit kernel layer" is closed source**: the package `NOTICE` says the wasm is MIT-licensed as a binary, built from unpublished C++ statically linked with OCCT (LGPL + exception); they publish "relink kits" (object files + link command) per build on `bitbybit-assets` releases to satisfy LGPL relinking. [read: NOTICE]
- API: DTO-style services — `shapes.solid.createBox({width,height,length,center})`, `fillets.filletEdges({shape, radius, indexes})` (+ `...WithHistory` variants), `booleans.union/difference/intersection`, `io.saveShapeSTEP/loadSTEPorIGES`, `shapeToMesh({shape, precision})` → `{faceList[{faceIndex, vertexCoord, normalCoord, indices…}], edgeList, pointsList}`, `shapes.solid.getSolidVolume`, an `assembly` service, clash/`SelfIntersections` analysis, 16k-line input typings. **Y-up** coordinate convention (Babylon heritage) and `adjustYtoZ` flags on IO. [read + measured]
- Node: works (`examples/node/basic`) but the ESM sources use extension-less imports, so plain `node` fails (`ERR_MODULE_NOT_FOUND …/shapes-helper.service`); I had to run under `tsx`. Browser: `occt-worker` wraps it in a Web Worker. [measured]
- LLM story: a free MCP server (`https://mcp.bitbybit.dev/mcp`) serves exact signatures for the installed version; "CAD Cloud" runs geometry server-side with Hono-on-Cloudflare-Workers templates (their cloud, your key). [read]

**Verdict:** technically complete and the only one with memory64 + pthreads today, but the closed kernel layer, Y-up convention and vendor-centric ecosystem make it a poor base for a kernel we own.

### 2.8 occt-import-js (kovacsv)

- Repo: https://github.com/kovacsv/occt-import-js — 296 stars, LGPL-2.1, last commit/release **0.0.23 on 2024-12-03, 0 commits in 12 months**; kovacsv 131 commits (author of Online3DViewer). OCCT submodule = commit "Update version up to 7.6.1" (2022-02-01). Link flags `-sMODULARIZE -sSTACK_SIZE=10MB -sALLOW_MEMORY_GROWTH`. [read]
- Size: **7.60 MB raw / 3.09 MB gzip**. Load 50 ms in Node. [measured]
- API: `ReadStepFile/ReadIgesFile/ReadBrepFile(Uint8Array, {linearUnit, linearDeflectionType, linearDeflection, angularDeflection})` → `{success, root:{name, meshes[], children[]}, meshes:[{name, attributes:{position,normal}, index, brep_faces:[{first,last,color}], color}]}`. One mesh per shape, with `brep_faces` giving triangle ranges per B-rep face (so face picking is possible; **no edge data**). No modelling, no export. [measured on the replicad STEP: 18 `brep_faces`]
- Node: yes (CommonJS). Browser: yes (what `web/` uses today).

**Verdict:** keep as the viewer's STEP importer until the kernel we pick can tessellate imports itself; then drop it.

### 2.9 OCCT's own WebAssembly story

- Open Cascade ships Emscripten support in OCCT's CMake (`TKService`/WebGL sample `occt_samples_webgl` since 7.4; the official docs page is for 7.6.0) and the dev forum discusses `-fwasm-exceptions` crashes, but **there is no official npm package or JS binding as of 2026-11**; dev.opencascade.org merely lists opencascade.js as a community project. OCCT itself: V8.0.1 released 2026-07-30, 400 commits/12 months, LGPL-2.1 with exception. [read: web search + gh api]
- The WebAssembly projects above therefore all carry their own binding layer; the "official" piece is only the C++ kernel and toolchain file.

---

## 3. Requirement-by-requirement matrix

| Requirement | replicad | libcascade | ocjs beta | occt-wasm | bitbybit | Chili3D wasm | CascadeStudio | occt-import-js |
|---|---|---|---|---|---|---|---|---|
| 1 B-rep, STEP export, fillet/chamfer, booleans | yes [m] | yes [m] | yes [m] | yes [r] | yes [m] | yes [r] (web only) | yes [r] | import only |
| 2 Tessellation with face/edge ids | `faceGroups`+`edgeGroups` [m] | DIY per face (explorer) [m] | DIY [m] | `tessellate`+`wireframe` [r] | `faceList`/`edgeList` [m] | `FaceMeshData.group/faces` [r] | `face_index` [r] | `brep_faces` only [m] |
| 3 Interference volume | `intersect`+`measureVolume` [m] | `BRepAlgoAPI_Common`+`BRepGProp` [m] | same [m] | `common`+`getVolume` [r] | `intersection`+`getSolidVolume` [m] | `booleanCommon`+`volume` [r] | yes [r] | no |
| 4 Assemblies | multi-shape STEP, DIY transforms | XCAF bound (DIY) | XCAF (DIY) | XCAF helpers [r] | `assembly` service [r] | app-level | app-level | reads hierarchy |
| 5 LLM-writable | best | needs OCCT expertise | worse (suffixes) | good (handles, enums) | ok (MCP), Y-up trap | n/a | good std-lib | n/a |
| 6 Browser / Node / Worker | all | all (+pthreads) | all, 6 s load | all (+Worker) | all (tsx in Node) | browser only | browser only | all |
| 7 Licence | MIT + LGPL wasm | LGPL+exception | LGPL | MIT/Apache + LGPL wasm | MIT binary, closed C++ | AGPL app / LGPL-3 wasm | MIT + LGPL wasm | LGPL |
| 8 Maintenance | 1 dev, 1.0 Aug 2026 | 1 dev, very active | dormant | 1 dev, very active | 1 company dev, very active | 1 dev, very active | 1 dev, active | dormant |
| wasm raw / gzip | 22.9 / 7.2 MB | 42.7 / 12.2 MB | 50.3 / 13.7 MB | 21.4 / 6.8 MB | 31.7 / 9.7 MB | 10.7 / 4.6 MB | 21.2 / 6.4 MB | 7.6 / 3.1 MB |

[m] = measured here, [r] = read.

---

## 4. Running it on Cloudflare

- **Workers / Durable Objects** [read: developers.cloudflare.com/workers/platform/limits, changelog 2026-09-04]: the bundle limit is now **64 MiB uncompressed on all plans** (the old 3 MB / 10 MB *compressed* checks were removed on 2026-09-04). So even the 50 MB beta fits by size. But: **128 MB memory per isolate, including WebAssembly allocations**, **1 s startup** for global scope, 10 ms CPU (free) / up to 5 min CPU (paid) per request.
- [inferred from measurements] Every OCCT-wasm build here reserves a 100 MB (replicad, ocjs) or 128 MB (libcascade) **initial** linear memory and grows from there; Node peak RSS was 400–650 MB. A 128 MB isolate would be at or over the limit before the first boolean. Instantiating a 22–43 MB module also takes 0.3–1.5 s in Node, which must happen lazily inside a request, not at global scope. I did not run workerd to confirm the OOM; treat it as "near-certain to fail without a custom build with a small initial heap", and even then the model's working set for real parts will exceed 128 MB.
- **Cloudflare Containers** are the realistic edge target: plain Node 22 (or Python + build123d) in a container, invoked from a Worker/DO. replicad-cli and the Node benches here are already that shape. Bitbybit's own "CAD Cloud" templates use Hono on Workers only as a proxy to their servers, which supports the inference.
- **Browser** remains the cheapest place to run the kernel: replicad (7.2 MB gz) or occt-wasm (6.8 MB gz, ~4.5 MB br claimed) in a Web Worker, with the LLM's code executed client-side, and STEP sent to R2.

---

## 5. Licensing (LGPL OCCT compiled to WASM) [read + inferred]

- OCCT is LGPL-2.1 **with the Open CASCADE exception 1.0** (lets you distribute without the LGPL's "object code for relinking" burden for statically linked apps if you reproduce the notice; in practice vendors interpret it as "use freely, publish OCCT modifications"). All the wasm binaries inherit LGPL-2.1 — replicad's, taucad's, zalo's, andymai's, bitbybit's all say so in their package licence fields or NOTICE.
- A SaaS that loads `*.wasm` from a URL and keeps its own JS/TS separate (replicad: MIT; libcascade bindings: LGPL-with-exception; occt-wasm tooling: MIT/Apache) is the normal commercial arrangement. occt-wasm's README spells out the "user can swap the .wasm URL" argument; bitbybit publishes relink kits for the statically linked closed layer. Nothing here requires open-sourcing Merrivile.
- Chili3D is AGPL-3.0 for the app (network copyleft — would cover a SaaS that embeds it) and offers paid commercial licences; only its `cpp/` wasm facade is LGPL-3.0.
- bitbybit's wasm is MIT as a binary but contains unpublished C++; auditability is nil.

---

## 6. Risks (biggest first)

1. **Bus factor = 1 everywhere.** replicad (sgenoud), libcascade (rifont), occt-wasm/brepjs (andymai), CascadeStudio (zalo), Chili3D (xiangechen), bitbybit (matas) are each one person; the original opencascade.js went silent in 2023 with no handover and took three years to be forked properly. Mitigation: pin versions, keep the custom-build config (taucad Docker toolchain) in our repo so we can rebuild the wasm ourselves.
2. **Not edge-runnable.** 100–128 MB initial heaps and 0.3–1.5 s instantiation vs Workers' 128 MB/1 s limits [inferred]. Plan for Containers (or the browser) from day one.
3. **Manual memory in raw bindings.** libcascade/ocjs leak unless every object is `.delete()`d; replicad hides it with FinalizationRegistry, occt-wasm with arenas. LLM-written raw OCCT code *will* leak; put the LLM behind replicad/occt-wasm, not raw embind.
4. **Download size.** 7 MB gz (replicad) is acceptable for a CAD web app; 12 MB gz (libcascade full) is not for first paint. Use custom builds.
5. **API churn.** replicad crossed 1.0 three months ago; occt-wasm is on major v5 after 8 months; libcascade v3 broke every suffix name. Freeze a version per Merrivile release and keep the LLM prompt/tool docs tied to it.
6. **Face-id stability across edits** is not solved by any of them (ids are explorer order; a rebuild renumbers). Bitbybit `*WithHistory` and Chili3D `*Tracked` return OCCT history maps, libcascade exposes `BRepTools_History` — needed later for persistent face selection.

---

## 7. Reproduce

```bash
# baseline
.venv/bin/python reference/bench/build123d/bench.py
# wasm kernels (each dir has its own package.json / node_modules)
(cd reference/bench/replicad      && node bench.mjs)
(cd reference/bench/opencascadejs && node bench.mjs)   # donalffons beta
(cd reference/bench/libcascade    && node bench.mjs)   # shares ../opencascadejs/bench-core.mjs
(cd reference/bench/bitbybit      && npx tsx smoke.mjs)
(cd reference/bench/occt-import-js && node smoke.mjs)  # reads ../replicad/bench_replicad.step
# validate a STEP with native build123d
.venv/bin/python -c "from build123d import import_step; s=import_step('reference/bench/replicad/bench_replicad.step'); print(s.volume, len(s.faces()))"
```

Repos/registry stats were pulled with `gh api repos/<owner>/<repo>`, `.../commits?since=2025-11-21`, `.../releases`,
`.../contributors`, and `npm view <pkg>` on 2026-11-21.
