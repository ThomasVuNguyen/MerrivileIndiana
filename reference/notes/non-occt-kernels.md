# Non-OCCT geometry kernels for Merrivile — survey and benchmark

Date: 2026-11-21. Scope: brepjs and everything that is not opencascade.js / replicad / CascadeStudio / Chili3D / bitbybit (those are in the sibling OCCT-in-WASM notes). Machine: Linux x86_64, Node 22.16, Python 3.12.3, no Rust toolchain, no Emscripten.

Evidence tags used below: **[measured]** = I ran it here; **[read]** = taken from a README, docs page, npm/crates/GitHub metadata, or HN thread; **[inferred]** = my judgement.

Files:
- Benchmarks: `reference/bench/build123d/bench.py`, `reference/bench/brepjs/bench.mjs` + `diag.mjs`, `reference/bench/manifold/bench.mjs`, `reference/bench/usd-brep/bench.py`.
- Repos (shallow clones): `reference/repos/{brepjs,brepkit,truck,fornjot,CADmium,vcad,solidcore,manifold,springrep,solvespace,BREP.io}`.

---

## 0. The benchmark part and the baseline

Part: 60×40×5 mm plate, 4× Ø5 through holes 6 mm from each corner, Ø20×15 mm boss on top of the plate (z 5..20), Ø8 bore through plate + boss, R2 fillet at the boss/plate junction, 0.5 mm chamfers on the plate's four top outer edges.

Analytic volume without fillet/chamfer: 60·40·5 − 4·π·2.5²·5 + π·10²·15 − π·4²·20 = **15314.3802 mm³**.

**build123d 0.13 / native OCCT baseline [measured]** (`reference/bench/build123d/bench.py`, `.venv/bin/python`):

| metric | value |
|---|---|
| `import build123d` | 2.8–3.3 s |
| build (chamfer + fuse + fillet + 5 cuts) | 54–66 ms |
| volume (full part) | **15345.8917 mm³**, 18 faces, 40 edges, valid |
| volume (plain, no fillet/chamfer) | 15314.3802 mm³ (= analytic) |
| intersection with copy shifted +10 mm X | **10259.6152 mm³** (77–85 ms) |
| plain intersection | 10257.4778 mm³ |
| STEP export / STL export | 9–10 ms / 72–80 ms |
| tessellate(0.01, 0.2) | 7267 verts, 11128 tris, 88–93 ms |
| STEP re-import with `import_step` | volume 15345.8917, 18 faces, valid |

All other kernels are judged against 15345.8917 / 10259.6152 (full) and 15314.3802 / 10257.4778 (plain).

---

## 1. brepjs — what it actually is

**[read]** npm `brepjs` 20.28.3 (published 2026-11-17), Apache-2.0, author Andy Aragon (`andymai`), repo github.com/andymai/brepjs (150 stars, created 2026-02-01, 567 npm versions in 9.5 months, release-please automation, commits by `brepjs[bot]`). Description: "Exact B-Rep CAD in TypeScript on OpenCascade WebAssembly, with a pluggable geometry kernel."

**It is not a kernel.** It is a TypeScript API layer (fluent `shape(box(…)).cut(…).fillet(…)`, functional `Result<T>` API, finders, sketcher, STEP/STL/glTF/3MF/OBJ/IGES/DXF I/O, assembly tree + URDF, history/replay, text, voxel, sheet metal) over a `KernelAdapter` interface. Three adapters exist:

| kernel package | what | license | wasm size [measured] |
|---|---|---|---|
| `occt-wasm` 5.18.0 (default) | OCCT **8.0** compiled to WASM by the same author, arena/handle API, Web Worker support, 170+ methods | wasm output LGPL-2.1-only; tooling MIT/Apache | 21.4 MB raw, **6.8 MB gzip** (README says ~4.5 MB brotli) |
| `brepkit-wasm` 4.11.32 | **brepkit**, a from-scratch Rust B-rep kernel by the same author (github.com/andymai/brepkit, 45 stars, created 2026-03-02). "brepjs can use it in place of OpenCascade." Marked **beta** by brepjs docs. | **AGPL-3.0-only or commercial** (Collective Context, LLC) since 3.0.0; ≤2.129.x were MIT/Apache | 10.2 MB raw, **3.8 MB gzip** |
| `brepjs-opencascade` 0.15.6 | legacy opencascade.js custom build | LGPL-2.1 | 28 MB unpacked, last published 2026-03-26 |
| `brepjs-manifold` | Manifold adapter for mesh ops (`initFromManifold`) | — | — |

Relation to replicad/OCCT **[read]**: the README credits replicad for "proving OpenCascade works in JS" but says the author "hit performance limits" and "had to fight its API". brepjs is therefore a replicad-like layer, with its own OCCT 8 WASM build, plus the option to swap in brepkit. `AI-DISCLOSURE.md` in the repo: "Most, if not all, of this project has been created with the assistance of AI tooling."

Features relevant to Merrivile **[read + measured]**: booleans (`fuse/cut/intersect/cutAll`), `fillet`/`chamfer` (incl. variable radius), shell, sweep/loft/revolve, `importSTEP`/`exportSTEP`/`exportIGES`, `mesh()` returns `ShapeMesh { vertices, normals, triangles, faceGroups[{start,count,faceId}] }` and `meshEdges()` returns `edgeGroups[{start,count,edgeId}]` — i.e. **tessellation with face/edge IDs is built in**. `createAssembly/createAssemblyNode/exportAssemblySTEP/walkAssembly` exist for assemblies (not benchmarked). Finders in 20.x: `inDirection, ofLength, ofCurveType, parallelTo, atDistance, when, inList, not, either, and, or`. Note the docs on `main` still show `inPlane`, which the published 20.28.3 does not have — docs and package drift (API churns fast; the first `npm install brepjs occt-wasm` silently resolved brepjs **4.18.5** because of a peer-dep range, and 4.x has a completely different init API). `engines: node >= 24` but it ran on Node 22.

### brepjs benchmark [measured] (`reference/bench/brepjs/bench.mjs`, `diag.mjs`)

| metric | brepjs + occt-wasm | brepjs + brepkit |
|---|---|---|
| wasm load + init (cold, Node) | 332–344 ms, RSS 143–147 MB | 179–324 ms, RSS 114–122 MB |
| build full part (cold / median of 5 warm) | 235 ms / **37 ms** | 407 ms / **16 ms** |
| volume full part | **15345.8917** (= baseline) | **15345.8917** (= baseline) |
| faces / edges | 18 / 40 | 18 / 41 |
| intersection with +10 mm copy (cold / median warm) | 573 ms / 292 ms | 1741 ms / 927 ms |
| intersection volume | **10259.6152** (= baseline) | **10283.1646 — wrong by 0.23 %**; result has **10 177 faces** (mesh fallback) |
| intersection, plain part | 10257.4778 (= baseline) | 10257.4778 (= baseline), 19 faces, exact |
| intersection, chamfer-only part | 10235.1444 | 10235.1444 (exact) |
| intersection, fillet-only part | 10281.9485 | 10307.3574, 10 151 faces (mesh fallback) |
| mesh(0.01, 0.2) | 4287 verts, 6598 tris, 18 faceGroups, 142 ms | 6426 verts, 11618 tris, 18 faceGroups, 20 ms |
| STEP export | 50 kB, 105 ms, AP214 (`AUTOMOTIVE_DESIGN`), OCCT 8.0 writer | 28 kB, **3.7 ms**, `CONFIG_CONTROL_DESIGN` (AP203) |
| STEP surfaces | 11 PLANE, 6 CYLINDRICAL_SURFACE, 1 TOROIDAL_SURFACE | 11 PLANE, 6 CYLINDRICAL_SURFACE, 1 TOROIDAL_SURFACE (analytic preserved) |
| STEP validated by build123d `import_step` | volume 15345.8917, 18 faces, valid; OCCT intersection of imported copy 10259.6152 | volume 15345.8917, 18 faces, 41 edges, valid; OCCT intersection 10259.6152 |
| STEP re-import in brepjs | ok, volume 15345.8917, 189 ms | ok, 15345.8917, 28 ms |
| STL export | 330 kB, 23 ms | 581 kB, 27 ms |

Interpretation **[inferred]**: brepjs-on-OCCT reproduces the native OCCT numbers exactly, which is expected because it *is* OCCT. brepkit is genuinely fast on primitives/booleans/fillet/chamfer/STEP and its STEP output is clean analytic AP203 that OCCT accepts, but as soon as a boolean touches a toroidal (fillet) face it silently drops into the documented "mesh-based fallback" (README: "Hard boolean cases fall back to a mesh-based path … not guaranteed watertight"), producing a 10 000-facet pseudo-solid with a 0.2 % volume error and taking ~1 s. For interference checks between filleted parts that is a correctness bug, not just a performance cliff. brepjs's own benchmark page (`benchmarks/results/latest.md`, 2026-11-14) shows brepkit 1.3–30× faster than OCCT on simple cases and 1.3× slower on sphere meshing; it does not benchmark booleans on blended faces.

Verdict: **brepjs is the most complete TS API in this survey, but the only production-grade kernel behind it is OCCT** (so it belongs with the OCCT family for the kernel decision). brepkit is AGPL/commercial and not yet robust on blended geometry.

---

## 2. Rust B-rep kernels

### 2.1 truck (ricosjp) — `reference/repos/truck`
**[read]** github.com/ricosjp/truck, 1698 stars, Apache-2.0, created 2020-12, pushed 2026-11-18, 28 commits in the last 90 days, 16 contributors, 45 open issues. Crate versions on master: truck-modeling 0.6, truck-shapeops 0.4 (last crates.io release 2024-09-20), truck-stepio 0.3, truck-js 0.2 (wasm-bindgen wrapper; **not on npm or crates.io**), truck-assembly 0.1 (new). CHANGELOG "Unreleased" lists: "Fillet for a single edge", "Fix fillet's newton function", `EdgeBlendSurface`, `ApproxFilletSurface`, read/write assembly STEP, `truck-drafting` 2D crate. `truck-shapeops/src/fillet/` has `simple_fillet` and `fillet_with_side` plus an `experiment.rs`. `truck-stepio/src/lib.rs` still says: "Shapes created by set operations cannot be output yet."
Real B-rep (NURBS + analytic traits), booleans (single-ray classification, known fragile), STEP read (good, via ruststep) / STEP write limited, fillets experimental, tessellation per face (face IDs derivable), WASM via wasm-bindgen with the usual Rust stack caveats.
**Hands-on: not built** — no prebuilt wasm/npm artifact exists and no Rust toolchain is installed on this machine, so per the brief I did not build it. CADmium (below) was the only sizeable consumer and is archived.
Verdict **[inferred]**: the most mature *upstream* pure-Rust kernel, but still research-grade on booleans/fillets/STEP export; no LLM-facing API; not a candidate on its own.

### 2.2 monstertruck (virtualritz fork of truck)
**[read]** github.com/virtualritz/monstertruck, 40 stars, Apache-2.0, crate 0.4.2 (2026-11-13), 24 commits/90 d, 14 contributors. Forked because "getting PRs accepted upstream was proving to be a challenge". Adds: Result-typed booleans, fillet engine rewrite (per-edge radii, variable radius, chamfer, `fillet_edges_by_id`), assembly STEP output, STEP loader via their `step-p21` fork, T-splines, idiomatic renames with deprecated aliases. Also reverted an upstream boolean rewrite that regressed tests. Still no npm/wasm artifact. Verdict: same status as truck with faster iteration; watch, don't adopt.

### 2.3 Fornjot (hannobraun) — `reference/repos/fornjot`
**[read]** 2543 stars, **archived 2026-06-19**. README: "This project has been shut down. Its goals were never reached." Never had booleans. **Dead end.**

### 2.4 CADmium (CADmium-Co) — `reference/repos/CADmium`
**[read]** 1637 stars, **archived**, last commit 2025-09-05, README: "This repo is inactive." It was a SvelteKit UI over truck (wasm). **Dead end.**

### 2.5 NVIDIA USD BRep / SMLib — the big 2026 event
**[read]** github.com/NVIDIA-Omniverse/usd-brep, created 2026-10-08, **Apache-2.0**, 2125 stars, 323 forks, v1.0.0 (2026-10-08) → v1.0.2 (2026-11-19), only 5 commits in 90 d, "currently not accepting contributions", 46 open issues. SMLib is the commercial NURBS/B-rep kernel from Solid Modeling Solutions (acquired by NVIDIA May 2022; used by ClassCAD for 20+ years per DEVELOP3D, 2026-10-13). README: kernel "creates and edits BRep solids, with booleans, fillets, sweeps and offsets", healer, tessellator, validator, C++ and Python APIs, USD `BrepArray` schema. **No STEP reader/writer** in the package — only USD and native `.smb`; OCCT↔USD converter *tools* are separate C++ programs. No official WASM build; a community Emscripten port exists (github.com/RandoTechNerd/smlib-wasm, 5 stars, no dist/release). PyPI wheels: `usd-brep` 1.0.2, CPython 3.12 only, Linux x86_64/aarch64 (91 MB) and Windows. KNOWN_ISSUES.md lists healer mis-repairs, shell/offset failures, a crashing `stitch_brep_with_face`, inside-out triangles next to fillets, long-thin triangles at sphere poles, and `brep_relationship` reporting shallow overlaps as "touching".

**Hands-on [measured]** (`reference/bench/usd-brep/bench.py`, native wheel in a scratch venv, 264 MB installed):

| metric | SMLib (native, Python) |
|---|---|
| `import usd_brep` | 49 ms |
| build (box, 4 top edges linear-xsect fillet = 0.5 chamfer, union boss, R2 `fillet_edges` on junction, 5 `boolean_difference`) | 120 ms |
| volume (`compute_volume`, 1e-6) | **15345.8916** (baseline 15345.8917) — 18 faces, 40 edges, manifold |
| intersection with +10 mm copy | **10259.6151** (baseline 10259.6152), 145 ms |
| tessellate (chord 0.01, 15°) | 125 ms; `PolyBrep.get_faces()` gives one polyface per B-rep face → face IDs available |
| export | `.smb` 2.5 ms, USD `.usda` 15 ms (26 kB); **STEP: none** |

So SMLib reproduces OCCT's fillet/chamfer/boolean results to 4 decimals — it is a real, mature kernel, now Apache-2.0. Its gaps for Merrivile are STEP I/O, WASM, and NVIDIA's "no contributions" stance. A derived ecosystem has formed in six weeks:

- **solidcore** (tangency-labs, `reference/repos/solidcore`): "a Rust port of NVIDIA's SMLib B-rep kernel (CAD subset): safe, deterministic, wasm-compatible". Apache-2.0, 473 stars, created 2026-10-12, crate 1.0.1 (2026-10-30), developed inside `tangency-labs/solidcraft` (100+ commits/90 d, 7836 open issues — clearly agent-driven). Progress site (2026-11-21): 254 of 282 units green, 27 partial; blend module 24/25 units; SSI corpus 119 cases with 78 PASS / 9 DEFERRED / 21 INCOMPLETE / 10 WRONG TOPOLOGY on the Rust side; goldens "prove a result unchanged, not correct". No STEP, no npm package; `cargo check --target wasm32-unknown-unknown` is a stated goal with an 8 MiB stack caveat. On the independent-ish brep-conformance suite it passes 49.5 % and is 1.96 s median. **Not usable yet [inferred]**; the most interesting thing to re-check in 6 months.
- Also: `abstractFlo/smlib-rs` (Rust bindings to the C++), `bherbruck/tscad` ("CAD as TSX on the solidcore kernel (wasm)"), `rubenhekkens/scriptcad`, `DevPlus31/solidweave`.

### 2.6 springrep (springcraft-ai) — `reference/repos/springrep`
**[read]** github.com/springcraft-ai/springrep, **MIT**, 41 stars, created 2026-11-14 (one week old), crate 2.0.0 (2026-11-20), 50 commits in that week, no `unsafe`, no dependencies. README: extrude/revolve/sweep, union/intersection/difference, chamfers, fillets, shells, drafts, mass properties, **STEP AP214 read and write**, watertight tessellation, every face carries operation names (stable references). Show HN 2026-11-18 ("Robotics needs better CAD, so I wrote a B-rep kernel and 3,487 tests", 34 points, 9 comments). The accompanying `brep-conformance` leaderboard (run 2026-11-18, 3,487 cases) ranks springrep 100 % / 47.9 ms, OpenCASCADE 8.0.1 81.0 % / 74.7 ms, arris 60.5 % / 154 ms, solidcore 49.5 % / 1.96 s — but the suite is written by springrep's own authors, and an HN commenter (`simplesocieties`) notes "any operation that doesn't match springrep's API counts as a failure for the other kernels"; the maintainer conceded the point. Another commenter: "No you didn't, you asked an LLM to write it." No wasm/npm artifact, Rust only. **Not benchmarked (no toolchain).** Verdict **[inferred]**: too new and too self-graded to trust; license is ideal; revisit if it survives six months.

### 2.7 vcad (muni-works / ecto) — `reference/repos/vcad`
**[read]** Apache-2.0, 451 stars, created 2026-01-27, 100+ commits/90 d, 135 open issues. Started as "Building a CAD kernel in one night" (Cam Pedersen, 2026-01-28, Claude-assisted: "Twelve hours. Coffee. Spite."). Now a macOS 15+ app with an MCP server (`npx @vcad/mcp`, bundles a kernel WASM), its own Lisp ("loon") for agents, "receipts" for agent claims, and a paper on exact gradients through the kernel (HN 2026-11-13, 42 points). Kernel crates on crates.io (`vcad-kernel-*` 0.10.0, 2026-09): analytic surfaces + B-spline, half-edge topology, booleans, fillets, tessellation. Paper admits "Boolean and fillet code is order-nondeterministic" and topology changes are errors. STEP import/export was "upcoming" in January; the README now lists multi-format export but the HN launch thread (2026-01-30, 48 points) was brutal ("Vibe coded? Nothing works", broken camera, shading artifacts). No standalone npm kernel package. Verdict **[inferred]**: an agent-first *application* on a young kernel; not a kernel to embed.

### 2.8 next.BREP / BREP_kernel (mmiscool, Autodrop3d LLC)
**[read]** crate `BREP_kernel` 0.26.0 (2026-11-21, 1478 downloads), repo mmiscool/next.BREP.io_RUST_BREP_KERNEL (31 stars, 1 contributor, 24 commits/90 d). Successor of BREP.io (mesh-based "B-rep-style topology on triangle meshes", now deprecated, `reference/repos/BREP.io`). Site claims exact B-rep with analytic + NURBS, booleans, fillets/chamfers, **STEP/IGES import and STEP AP214 export**, assemblies with interference checks, sheet metal, ~20 MB WASM in the browser, and "CAD Kernel in Rust faster than SMLib" (HN, 6 points, no discussion). **License is custom and copyleft-plus**: "Any modifications … must be submitted to Autodrop3d LLC with an irrevocable assignment of the copyright via git pull request … Failure to contribute back … voids all permissions." Not OSI, not SaaS-friendly without a commercial deal. Verdict: **no**.

### 2.9 Other 2025–2026 "B-rep kernel in Rust" repos (all [read], none benchmarked)
A GitHub search for `b-rep kernel language:rust created:>2025-01-01` returns 20+ repos; nearly all are single-author, agent-built, weeks to months old:
- **arris** (arris-labs, MIT/Apache, 4 stars, 1 contributor, 100+ commits/90 d; PyPI + crates; provenance records; "validated against Open CASCADE as the test oracle"; 60.5 % on brep-conformance, refuses all "fillet after union" cases).
- **nacre** (elgar328, Apache-2.0, 7 stars): exact rational arithmetic, no global tolerance, browser playground; status M5 done (planar booleans), M6 quadric booleans in progress, "shape-only STEP export". Honest and interesting, far from fillets.
- **cadcore** (YATSKOVSKYI, MIT, 58 stars): analytic surfaces, O(N) filament sweep, STEP AP203/AP214 export, torus corner blends; targets toolpath/lattice use, not general booleans/fillets.
- cadrs (147 stars, Bevy app), ogeom-rs (LGPL), opencadkernel (MPL), Gensolid ("agent-built … alternative to Parasolid", 6 stars), Roshera-CAD (AGPL), keel, kerf, anvilcad, parcad (AGPL; "CAD your AI can check"), civilkit/cadkit-kernel (2 stars), QymCAD (OCCT-based, AGPL, 946 stars — not non-OCCT).
Verdict **[inferred]**: a Cambrian explosion of LLM-written kernels; none has a track record, an npm/wasm artifact and a permissive license *and* fillets + STEP at once, except on paper.

---

## 3. Mesh / CSG libraries

### 3.1 Manifold (elalish/manifold, npm `manifold-3d` 3.5.5) — `reference/bench/manifold`
**[read]** Apache-2.0, 2432 stars, ≥100 commits/90 d, ≥100 contributors (query capped at 100), used by OpenSCAD, Blender, Godot, BRL-CAD, trimesh, bitbybit, BREP.io. Guaranteed-manifold mesh booleans, SDF level sets, smoothing/refine, hull, minkowski, slice/project, per-triangle `faceID` and per-run `runOriginalID` for provenance. **Mesh only: no fillets/chamfers on arbitrary edges, no STEP** (glTF with `EXT_mesh_manifold`, 3MF, OBJ recommended; STL discouraged).

**[measured]** (`bench.mjs`, plain part only — fillet/chamfer unsupported):

| segments | build | volume | intersection (+10 mm) | tris | verts |
|---|---|---|---|---|---|
| 32 | 37 ms | 15293.125 | 10255.195 (46 ms) | 800 | 392 |
| 64 | 34 ms | 15309.059 | 10256.802 (114 ms) | 1568 | 776 |
| 128 | 98 ms (median of 5 warm: 93) | 15313.049 | 10257.324 (319 ms; median 250) | 3104 | 1544 |
| 256 | 315 ms | 15314.047 | 10257.439 (1154 ms) | 6176 | 3080 |

wasm load+init **20 ms**; wasm **543 kB raw / 205 kB gzip**. Volume error at 128 segments is 0.009 % vs analytic 15314.380 (polygonisation, not a bug). `faceID` gave 67 distinct IDs for plate+boss+bore at 64 segments [measured], i.e. curved faces are split per facet, so face picking works for planar faces but curved faces need your own grouping [inferred]. Verdict: **excellent for interference *estimates*, previews and mesh ops; not a B-rep and cannot satisfy requirement 1.** A good secondary engine (e.g. fast approximate interference on tessellations) [inferred].

### 3.2 JSCAD (`@jscad/modeling` 2.13.0)
**[read]** MIT, 3280 stars, 71 contributors, but only 5 commits in the last 90 d and the last 30 commits span 2024-12 → 2026-11 (a release was published 2026-11-07). Pure-JS BSP/CSG on polygon meshes, slow and not robust vs Manifold; `roundedCuboid`-style primitives only, no edge fillets, exports STL/AMF/3MF/OBJ/DXF/SVG, no STEP. Verdict: superseded by Manifold; dead end for this product.

### 3.3 OpenSCAD WASM (`openscad-wasm` 0.0.4, `openscad-wasm-prebuilt` 1.2.0, openscad-playground)
**[read]** GPL-2.0(-or-later); openscad/openscad-wasm 433 stars, 0 commits in 90 d; openscad-playground 499 stars, active, uses the Manifold backend. ~11 MB unpacked. Mesh output only (STL/3MF/OFF), no STEP, no fillets (library tricks only), GPL makes in-browser distribution of a proprietary SaaS problematic. Verdict: dead end.

---

## 4. SolveSpace — `reference/repos/solvespace`
**[read]** GPL-3.0-or-later (also the `slvs` solver library and the `js/slvs` package), 4261 stars, 93 commits/90 d, 281 open issues. Real NURBS surface modeller with booleans on "ratpoly shells", STEP export (`src/exportstep.cpp`), **no fillets** (only comments about fillet-like surfaces in `srf/`), excellent 2D/3D constraint solver. Official "Experimental Web Version" compiled with Emscripten (solvespace.com/webver.pl, updated 2026-10-21): "There is some speed penalty and there are many remaining bugs." Building needs the emsdk. Verdict **[inferred]**: GPLv3 rules out in-browser embedding in a commercial SaaS; server-side use would be legal but the solver is the only unique asset. Dead end as a kernel; possibly interesting as a constraint-solver reference.

## 5. CGAL
**[read]** Dual GPL/LGPL + commercial via GeometryFactory (cgal.org/license.html: kernel/support LGPL, "most geometric algorithms and data structures are GPL"; PMP corefinement booleans and Nef polyhedra are GPL packages). Exact-arithmetic mesh booleans, no B-rep, no fillets, no STEP. Only niche WASM ports exist (straight-skeleton, voron8, arrangement-2d-js); an Emscripten issue reports CGAL booleans hanging in the browser. Verdict: dead end for a B-rep product; Manifold already covers the mesh-boolean need with a permissive license.

## 6. Commercial kernels

| kernel | web/WASM story | licensing / cost (public info) | notes |
|---|---|---|---|
| **Parasolid** (Siemens; resold by Tech Soft 3D) | No WASM. Server-side only (Onshape runs it in the cloud; Tech Soft 3D "Cloud Modeler" demo wraps it in an HTTP service). | Three tiers (Designer / Editor / Communicator), Convergent Modeling add-on; **no public prices**, negotiated, royalties; 60-day free evaluation. Petition "Open Parasolid" notes fees are prohibitive for small projects. Plasticity (indie desktop app) licenses it, so small-vendor deals exist. | Gold standard; XT format; Windows/Linux/Mac. |
| **ACIS / CGM** (Spatial, Dassault) | No WASM; server-side. | No public prices; 3D InterOp sold separately. | Comparable to Parasolid. |
| **C3D Toolkit** (C3D Labs) | "C3D Web Vision" = microservice + web client; C3D Modeler and Converter run **server-side** (2023 blog); only the text-output module was compiled to WASM. No in-browser kernel. | Annual developer license + **royalty 2–7 % of product price, 25–30 % if functionality is "almost entirely" the toolkit**; academic USD 5 000/yr; startup pricing "set individually"; 25 % discount for full set; Linux/Mac/ARM cost extra. | Cheapest route to a commercial kernel; still server-side. |
| **Kubotek Kosmos 3D Framework 6.0** | Announced Sept 2024 as "first cloud-ready geometry kernel" with a **WebAssembly component** (mass properties, pattern recognition, tessellation client-side, modeling/translation). | No public pricing. | Worth a sales call if a commercial WASM kernel is wanted; capability detail unpublished. |
| **SMLib** (NVIDIA, ex-Solid Modeling Solutions) | Now **Apache-2.0** as USD BRep (see §2.5); community Emscripten build exists but is unreleased. | Free. | The real surprise of 2026. |

**[inferred]**: every commercial kernel is a server-side (Cloudflare Container) story, not a Worker/browser story, and none publishes prices; C3D is the only one with a published royalty formula.

---

## 7. Requirement scorecard (1 = best)

| option | 1 real B-rep + STEP + fillet + booleans | 2 tess. with face/edge IDs | 3 interference volume | 4 assemblies | 5 LLM can write it | 6 browser / edge | 7 SaaS license | 8 health/perf/size |
|---|---|---|---|---|---|---|---|---|
| brepjs + occt-wasm | ✅ exact baseline match [measured] | ✅ faceGroups/edgeGroups [measured] | ✅ exact [measured] | ✅ createAssembly / exportAssemblySTEP [read] | ✅ TS, huge API, `llms.txt`, Claude plugin; but churn | browser/Node ✅; Worker ❌ (21 MB wasm) | Apache + LGPL-2.1 wasm (OK) | 1 person + bots, 567 releases; 6.8 MB gz |
| brepjs + brepkit | ⚠ fillet/chamfer/STEP fine, **boolean on fillet falls back to mesh, 0.23 % error** [measured] | ✅ | ⚠ wrong on blended parts | ✅ via brepjs | ✅ same API | browser ✅ 3.8 MB gz; Worker ❌ 10 MB | **AGPL or paid** | 1 person, beta |
| SMLib / usd-brep | ✅ exact [measured] except **no STEP** | ✅ polyface per face [measured] | ✅ exact [measured] | ❌ (USD scene only) | Python/C++ only; good agent docs | native only (Container) | Apache-2.0 | NVIDIA, no contributions, few commits |
| solidcore (SMLib in Rust) | ⚠ port in progress, no STEP | — | — | — | — | wasm target intended | Apache-2.0 | very active, agent-driven |
| truck / monstertruck | ⚠ fillets experimental, STEP write partial | ✅ per face | ⚠ | truck-assembly new | Rust only | wasm-bindgen possible, no artifact | Apache-2.0 | moderate |
| springrep | ✅ on paper (self-graded) | ? | ? | ❌ | Rust only | wasm claimed | MIT | 1 week old |
| vcad | ⚠ nondeterministic booleans/fillets | ? | ? | app-level | loon/MCP | Mac app + wasm | Apache-2.0 | very active, rough |
| next.BREP | ✅ on paper | ? | ✅ claimed | ✅ claimed | Rust | 20 MB wasm | **custom copyleft + assignment** | 1 person |
| Manifold | ❌ mesh | ⚠ facet IDs | ✅ approx (0.009 % @128 seg) [measured] | n/a | ✅ tiny API | ✅ 205 kB gz, **Worker-feasible** | Apache-2.0 | excellent |
| JSCAD / OpenSCAD-wasm | ❌ mesh | ❌ | approx | n/a | ✅ | ✅ / GPL | MIT / **GPL** | low / n-a |
| SolveSpace | ⚠ NURBS + STEP, no fillets | ? | ? | ✅ (its own) | C++ | emscripten "experimental" | **GPLv3** | active |
| CGAL | ❌ mesh | ❌ | exact mesh | n/a | C++ | niche | **GPL**/commercial | mature |
| Fornjot, CADmium, BREP.io | archived / deprecated | | | | | | | **dead** |
| Parasolid / ACIS / C3D / Kosmos | ✅ | ✅ | ✅ | ✅ | C++ SDKs | server-side (Kosmos: WASM component) | $$$, C3D 2–7 % royalty | commercial |

---

## 8. Bottom line [inferred]

1. **Nothing non-OCCT is ready to be the *only* kernel of a STEP-exporting product today.** The only non-OCCT kernels that reproduced the baseline fillet/chamfer/boolean numbers are SMLib (no STEP, no WASM) and brepkit (STEP fine, but booleans on blended faces fall back to a lossy mesh and it is AGPL/commercial).
2. **brepjs** is worth taking seriously as the *TypeScript API layer* — it already has face/edge IDs, STEP both ways, assemblies and an LLM-oriented surface — but choose it knowing the engine is OCCT 8 in WASM (6.8 MB gz) and the project is one person plus bots with a fast-moving API.
3. **Manifold** is the right *secondary* engine: 205 kB, 20 ms init, robust booleans; it could even run inside a Cloudflare Worker for approximate interference and previews.
4. **Watch list** (re-check in Q1 2027): solidcore (SMLib port to Rust/WASM, Apache-2.0), springrep (MIT, needs independent validation), monstertruck fillets/STEP, Kubotek Kosmos WASM pricing.
5. **Dead ends**: Fornjot, CADmium, BREP.io, JSCAD, OpenSCAD-wasm, SolveSpace (GPL), CGAL (GPL, mesh), next.BREP (license), and every week-old agent-built Rust kernel without an artifact.
