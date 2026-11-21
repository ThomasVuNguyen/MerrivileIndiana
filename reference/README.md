# Geometry kernel research (2026-11-21)

Five parallel surveys, each with hands-on benchmarks. Detailed notes:

| Notes | Covers |
|---|---|
| [notes/occt-wasm-family.md](notes/occt-wasm-family.md) | opencascade.js, libcascade (taucad fork), replicad, occt-wasm, bitbybit, Chili3D, CascadeStudio, occt-import-js |
| [notes/non-occt-kernels.md](notes/non-occt-kernels.md) | brepjs/brepkit, truck, Fornjot, CADmium, Manifold, JSCAD, OpenSCAD, SolveSpace, CGAL, NVIDIA SMLib, commercial kernels (Parasolid, ACIS, C3D, Kosmos) |
| [notes/build123d-everywhere.md](notes/build123d-everywhere.md) | OCP.wasm / build123d in Pyodide, Python Workers, native server numbers, build123d vs CadQuery, ocp-tessellate, three-cad-viewer, bd_warehouse |
| [notes/ai-cad-landscape.md](notes/ai-cad-landscape.md) | which CAD languages LLMs write best, Zoo/KCL, CADAM, build123d-mcp, Onshape/Autodesk, agent-loop patterns |
| [notes/cloudflare-runtime.md](notes/cloudflare-runtime.md) | what runs where on Cloudflare: Workers, Python Workers, Containers, Sandbox SDK, Durable Objects, R2/D1, auth, email |

`repos/` holds shallow clones and `bench/` the prototypes. Both are gitignored except bench sources.

## Benchmark part

A 60×40×5 plate with 4 Ø5 holes, plus a Ø20×15 boss with an Ø8 bore. The boss base has an R2 fillet and the plate's top edges a 0.5 mm chamfer. Each kernel also computed the intersection with a copy shifted 10 mm in X.

| Kernel | Ready | Build | Volume mm³ | ∩ mm³ | STEP valid |
|---|---|---|---|---|---|
| build123d native | 3.0 s import | 50–60 ms | 15345.8917 | 10259.6152 | baseline |
| replicad 1.2.1 (wasm) | 0.3–0.5 s | 0.3–0.4 s | 15345.8917 | 10259.6152 | yes |
| brepjs + occt-wasm | n/m | 37 ms warm | 15345.8917 | 10259.6152 | yes |
| libcascade 3.1.0 | 1.2–1.5 s | 0.16–0.19 s | 15345.8917 | 10259.6152 | yes |
| bitbybit 1.7.0 | 1.0–1.2 s | 0.26–0.33 s | 15345.8917 | 10259.6152 | yes |
| opencascade.js 2.0-beta | 6–7 s | 0.3–0.5 s | 15345.8917 | 10259.6152 | yes |
| build123d in Pyodide (Chromium) | ~43 s first part | 0.3 s | 15345.892 | 10259.615 | yes |
| brepkit (Rust) | n/m | 16 ms | 15345.8917 | **10283.16 (wrong, mesh fallback)** | yes |
| Manifold (mesh) | 20 ms | 93 ms | 15313 (approx.) | 10257 (approx.) | no STEP |

Every OCCT-based option produced bit-identical geometry. Only the language and runtime around the kernel differ.

## Conclusions

1. **The kernel is OpenCASCADE.** Every option that exports real STEP with working fillets and booleans is OCCT underneath. The non-OCCT kernels are archived (Fornjot, CADmium), mesh-only (Manifold, JSCAD, OpenSCAD), GPL, research-grade (truck), or not yet correct (brepkit). Commercial kernels (Parasolid, ACIS, C3D) are server-only and priced by negotiation.
2. **The AI writes build123d.** It has the best published evidence (CADDesigner: build123d Pass@1 0.59 vs CadQuery 0.50) and the strongest open agent harness (build123d-mcp). It also has a part library (bd_warehouse: fasteners, bearings, spur gears, threads) and face/edge-ID tessellation (ocp-tessellate). No independent evidence exists for replicad, KCL or FeatureScript.
3. **Geometry runs in a Cloudflare Container**, driven by a per-project Durable Object that runs the agent loop. Neither JS nor Python Workers can host OCCT today:
   - The Emscripten glue throws `EvalError` on `new Function`.
   - The 100 MB initial heap doesn't fit the 128 MB isolate limit.
   - OCP's `.so` is 152 MB.

   build123d needs about 470 MB, so it runs on a container with 1 GiB of memory or more.
4. **The browser stays a viewer.** It receives the mesh plus face/edge IDs from ocp-tessellate. replicad, or occt-wasm with brepjs, is the proven fallback if we later want client-side geometry: exact measuring, offline use, or zero compute cost. It produced identical results, is about 7 MB gzipped and loads in under 0.5 s.
5. **build123d in the browser (OCP.wasm/Pyodide)** works but costs about 54–147 MB of download and roughly 40 s to the first part. It is fine for a future "offline playground" and not for the main loop.

## Risks

- Every OCCT wasm project has a single maintainer. The original opencascade.js died silently in 2023.
- build123d's API changes between releases: pin the version and put the known gotchas in the system prompt.
- Container cold start is 1–3 s plus about 3 s to import build123d. Keep one warm process per active project.
- The Durable Object `durable_object` scheduling policy for Containers is still in public beta.
- Face IDs are not stable across edits in any kernel. Assemblies should attach to named connectors that the part scripts declare, not to face IDs.
