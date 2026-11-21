# AI text-to-CAD landscape: which language should the Merrivile agent write?

Research notes, 2026-11-21. Scope: (1) which CAD representation LLMs generate best, with benchmark evidence; (2) products and open-source projects doing AI text-to-CAD and the tech each chose; (3) Zoo's stack; (4) Onshape as a backend; plus hands-on reading of cloned repos.

Evidence labels used throughout:
- **[read]** = read in the linked source (paper/blog/docs).
- **[code]** = seen in cloned source code under `reference/repos/`.
- **[inferred]** = my inference; not stated by a source.
- **[secondary]** = from a third-party aggregator/press, not the primary source.

Repos cloned (shallow, `git clone --depth 1`) into `/home/thomas/Development/MerrivileIndiana/reference/repos/`:
`build123d-mcp` (pzfreo, Apache-2.0, HEAD 2026-11-19), `modeling-app` (KittyCAD/Zoo, MIT), `CADAM` (Adam-CAD, GPLv3, HEAD 2026-10-14), `cad-bench` (CAD-bench), `CAD_Code_Generation` (CADPrompt dataset). Pre-existing: `bitbybit`, `CascadeStudio`, `chili3d`, `occt-import-js`, `opencascade.js`, `replicad`.

---

## 0. Executive summary

1. **Python-over-OCCT code (CadQuery, build123d) is the representation with the most evidence behind it**, and it is what the field's benchmarks and the top leaderboard entries use. Direct sequence/DSL formats (DeepCAD-style command sequences) are measurably worse than CadQuery for the same models [read: Text2CAD-Bench Table 3]. OpenSCAD is *more reliably executable* for weak models and the best "balanced" format in one 2026 benchmark [read: P3D-Bench], but it cannot produce B-rep/STEP, which Merrivile needs.
2. **Agent loops with execution + geometric measurement + rendered views beat one-shot generation everywhere they are measured**: CAD-bench best one-shot 0.599 vs best agent 0.677 (and 0.037 vs 0.141 on functional tasks) [read]; CADGenBench top entries are all iterative harnesses (build123d-mcp + Opus 5.5 at 86.9% vs the same family's one-shot baselines around 23–37%) [secondary: BenchLM snapshot]; CADSmith full loop takes mean Chamfer from 28.37 (zero-shot) to 0.74 [read].
3. **Numeric/kernel feedback is the workhorse; vision is the tiebreaker.** CADSmith's ablation: removing vision barely changes easy tiers but on the hardest tier raises mean CD from 1.42 to 49.68 [read]. P3D-Bench: multi-turn render feedback helped Gemini 3.1 Pro (Judge 0.576 to 0.649) but did nothing for GPT-5.5, which stopped after the first turn 62% of the time [read]. CADCodeVerify's VQA answers were only 64.6–68.2% accurate when manually checked [read].
4. **Products split by kernel ownership, not by language choice**: Zoo built its own kernel *and* language (KCL) specifically so that the LLM writes readable code against a kernel they control [read]; Adam/CADAM ships OpenSCAD-wasm in the browser but publicly plans to move to CadQuery/build123d for fillets/lofts/STEP [read]; Onshape and Autodesk expose their kernels to agents via MCP (FeatureScript MCP, Fusion Compute MCP) [read]; Backflip and Leo are proprietary ML-to-B-rep products with no public language [read/secondary].
5. **Recommendation for Merrivile: keep build123d as the authored language**, wrap it in a small tool surface modelled on build123d-mcp (`execute` / `measure` / `validate` / `render_view` / `snapshot`), run the Python server-side (OCCT in a sandboxed worker), and store the script as the part's source of truth. Details and alternatives in section 9.

---

## 1. Which CAD representation do LLMs generate best?

### 1.1 Candidate representations

| Family | Examples | Executable without a GUI? | B-rep/STEP out? | Notes |
|---|---|---|---|---|
| Python over OCCT | CadQuery, build123d | yes (pip) | yes | Most benchmark evidence; build123d is CadQuery's successor from the same community |
| CSG DSL | OpenSCAD | yes (CLI/wasm) | **no** (mesh only) | Highest executability for weak models; no fillets on B-rep, no STEP |
| JS/TS over OCCT | replicad, CascadeStudio, bitbybit | yes (opencascade.js wasm) | yes | No published LLM benchmark found |
| JS CSG | JSCAD | yes | no | No published LLM benchmark found |
| Proprietary DSL | Zoo KCL, Onshape FeatureScript | needs vendor engine | yes (vendor) | Zoo trains/fine-tunes on KCL; no third-party benchmark found |
| Feature/sketch sequences | DeepCAD-style, Text2CAD, CADFusion | needs a decoder/executor | varies | Measurably worse than code for the same LLM [read: Text2CAD-Bench] |
| Direct tool calls | ToolCAD (FreeCAD MCP primitives), Onshape/Fusion MCP | n/a | yes | Works, but no controlled comparison against code generation exists |

### 1.2 Benchmarks and papers (2023–2026), concrete findings

#### CADCodeVerify / CADPrompt (Alrashedy et al., arXiv 2410.05340, v1 Oct 2024, v2 Feb 2025; ICLR 2025)
- Links: https://arxiv.org/abs/2410.05340 , HTML https://arxiv.org/html/2410.05340v2 , data repo https://github.com/Kamel773/CAD_Code_Generation (cloned; contains only the 200-sample dataset, **no** CADCodeVerify code [code]).
- Language: **CadQuery** (Python). "a Python-based parametric CAD language with a built-in compiler" [read].
- Loop: VLM writes 2–5 yes/no verification questions from the text prompt, answers them against four renders at 0/90/180/270 degrees with chain-of-thought, turns "No/Unclear" answers into feedback, regenerates; **2 refinement iterations** ("no improvement was observed beyond the second refinement") [read].
- Results (Table 2, median; GPT-4 few-shot): point-cloud distance 0.155 (generated) -> 0.137 (3D-Premise baseline) -> **0.127 (CADCodeVerify)**; compile rate 96.0% -> 96.5%; Hausdorff 0.494 -> 0.419. Gemini few-shot: PC dist 0.171 -> 0.147, compile 85.0% -> 85.0%. CodeLlama few-shot: 0.224 -> 0.185, compile 67.0% -> 73.5% [read].
- Caveat: manual check found the VLM's answers to its own verification questions were only **64.6% (refine 1) / 68.2% (refine 2) accurate** (Table 9) [read]. The paper has no "error-feedback-only" ablation, so you cannot isolate the vision contribution [read].
- Dataset repo quote [code]: `CADPrompt/00000007/Python_Code.py`:
  ```python
  sketch:cq.Sketch = cq.Sketch().circle(radius)
  part:cq.Workplane = cq.Workplane("XY").placeSketch(sketch).extrude(height)
  ```
  and `Ground_Truth.json` per sample carries face/edge/vertex counts, bbox, volume, `Is_Solid` — i.e. exactly the kind of kernel metrics later papers feed back to the model.

#### Text2CAD-Bench (Wang et al., arXiv 2605.18430, 18 May 2026)
- Link: https://arxiv.org/abs/2605.18430 (PDF text extracted locally).
- 600 human-curated CadQuery models, 4 tiers; CadQuery 2.4 in isolated Python 3.10; **up to 3 retries with error feedback**, best attempt counted [read].
- Main results (Table 1, geometric prompts; CD x10^3 lower is better / invalidity rate): GPT-5.2 L1 44.31 / 11.1%, L2 60.38 / 20.0%, **L3 93.46 / 68.0%**; Claude-4.5-Sonnet L1 52.62 / 20.3%, L3 70.13 / 70.0%; Gemini3-Flash L3 91.61 / 12.8% [read]. Domain-specific fine-tuned models (Text2CAD, CADFusion, Text2CADQuery) have CD > 200 on every tier [read].
- **Representation ablation (Table 3)**: the same LLMs generating DeepCAD-style command sequences instead of CadQuery: invalidity rises "universally — DeepSeek-V3.2 rises from 13.3% to 67.3% on L1-Geo, and GLM 4.7 from 26.3% to 50.7% on L2-Geo"; conclusion: "Python-based CadQuery representations enable models to exploit pretrained code generation capabilities, yielding substantial improvements over command sequences in both execution validity and geometric accuracy" [read].
- Prompt style: geometric (appearance) prompts beat procedural (sequence) prompts on L1–L2 by 5–10 points of invalidity; procedural prompts win on L3 (sweeps/lofts) [read]. Relevant to Merrivile: how the *user* phrases a request matters as much as the language.
- System prompt (Appendix D) starts: "You are an expert CadQuery programmer. Generate Python code using CadQuery to create 3D models. ... 1. MUST start with: import cadquery as cq ... CADQUERY API NOTES (IMPORTANT - avoid common errors)" with five worked examples (chamfer, sweep, loft, twist extrude, fillet); retry prompt: "The previous CadQuery code attempt failed with an error ... Generate corrected CadQuery code that fixes the issue" [read].
- Limitations stated by the authors: CadQuery-only ("limits direct comparison with systems targeting other CAD formats such as OpenSCAD, FreeCAD scripts"), no multi-turn / visual feedback evaluated [read].

#### P3D-Bench (arXiv 2606.11152, v2 10 Jun 2026) — the only direct multi-format comparison found
- Link: https://arxiv.org/html/2606.11152v2
- Formats: minimal JSON, **OpenSCAD**, **CadQuery**, Three.js; tasks Text-to-3D, Image-to-3D, Assembly-3D; outputs executed and rendered [read].
- "OpenSCAD is the more reliable target overall, lifting Valid% to 94%–99% across the board." On CadQuery, Valid% ranges 22%–99% depending on model; "CadQuery often fails to execute, especially for weaker models" [read].
- Image-to-3D, GPT-5.5 (Geo/Topo/Judge/Valid): CadQuery 0.524/0.914/0.526/0.937; OpenSCAD 0.567/1.000/0.592/1.000; Three.js 0.556/0.828/0.569/1.000. Claude Opus 4.6 Judge: CadQuery 0.383, OpenSCAD 0.463, Three.js 0.447. Shared-case cross-model average: CadQuery 0.439 vs OpenSCAD 0.629 [read].
- JSON (a structured-ops format) is "clearly the weakest format" on assembly tasks [read].
- **Multi-turn render feedback** (Image-to-3D, OpenSCAD, up to 10 turns, model sees reference image + its code + multi-view renders): Gemini 3.1 Pro average rose 0.715 -> 0.745 (Judge 0.576 -> 0.649), mean 7.9 turns; GPT-5.5 0.720 -> 0.722, mean 1.5 turns, 62% stopped after turn 1. "feedback helps only when a model keeps revising" [read].
- [inferred] The CadQuery deficit here is mostly *executability* of frontier-model-free-form CadQuery (API hallucination), which is exactly what an execute-and-repair loop fixes; P3D-Bench's main table is one-shot.

#### CADDesigner (arXiv 2508.01031, v6 19 May 2026) — the only build123d vs CadQuery head-to-head found
- Link: https://arxiv.org/html/2508.01031v6
- ReAct agent (Claude-4-Sonnet) with tools: requirement refinement, code generation, command execution, **visual feedback** (renders six views, VLM generates targeted questions and answers them, returns termination signal + diagnostic feedback); failed runs return structured error info [read].
- Table 5 (200 test models, text only):

  | Representation | IoU | CD | HD | Pass@1 | Avg retries | Success | Latency |
  |---|---|---|---|---|---|---|---|
  | ECIP (their API layer over CadQuery) | 0.3041 | 0.1236 | 0.4154 | 0.46 | 1.86 | 100% | 436 s |
  | CadQuery | 0.2827 | 0.1818 | 0.5186 | 0.50 | 2.01 | 87.5% | 541 s |
  | **build123d** | 0.2617 | 0.1570 | 0.5126 | **0.59** | 1.91 | 96.0% | **363 s** |

  "build123d reaches the highest Pass@1 and the shortest latency" but lower IoU; authors attribute the IoU gap to build123d's operator ("symbolic") algebra being harder for LLMs to read [read]. Note the paper's own Pass@1 for ECIP is inconsistent between tables (0.45 vs 0.46) [read].
- [inferred] build123d's lower one-shot IoU but higher pass rate suggests: fewer API errors, more semantic errors. That is the profile a measure/compare loop is good at catching.

#### CADSmith (Barkley, Loghmani, Barati Farimani, arXiv 2603.26512, 27 Mar 2026)
- Link: https://arxiv.org/html/2603.26512v1
- Generates **CadQuery**; 5 agents (Planner, Coder with RAG over CadQuery docs + error-solution patterns, Executor in sandbox, Validator = Claude Opus judge, Refiner); inner loop fixes execution errors (max 3), outer loop checks geometry (max 5) [read].
- Kernel feedback fed to the judge: volume, bounding box, face/edge/vertex counts, center of mass, solid validity (invalid solid fails automatically), plus three rendered views (iso, high-angle rear, front profile) [read].
- Results (100 prompts, absolute mm, ICP-aligned):

  | Config | Exec % | CD median | CD mean | F1 median | IoU median |
  |---|---|---|---|---|---|
  | Zero-shot | 95 | 0.55 | 28.37 | 0.9707 | 0.8085 |
  | No-vision (kernel metrics only) | 99 | 0.48 | 18.19 | 0.9792 | 0.9563 |
  | Full (kernel + vision) | 100 | 0.48 | **0.74** | 0.9846 | 0.9629 |

  88/100 converged on the first iteration. Ablation: on the hardest tier removing vision raises mean CD 1.42 -> 49.68 and lowers mean F1 0.85 -> 0.74; kernel metrics alone can miss "false convergence" (plausible dimensions, wrong structure) [read].
- Critique of Query2CAD's captioner-based visual feedback: encoded visual representations "lose the geometric precision needed to resolve dimensional errors" [read via search snippet].

#### CAD-bench (anonymous NeurIPS 2026 submission; repo https://github.com/CAD-bench/cad-bench, cloned)
- Paper PDF: https://cdn.jsdelivr.net/gh/CAD-bench/cad-bench@main/paper/main.pdf
- 17 tasks from cube to simulated gearboxes; grader checks named dimensions, pose, threads, mating, and rigid-body motion in Blender; `reward = 0.05*build_success + 0.95*overall_score` [read, code: `verifier/bench/config.py`].
- Language: **build123d 0.10.0 on Python 3.11**; every task instruction ends "Create `/workspace/final.py`. The file must run with Python 3.11 and Build123D 0.10.0, and it must leave the completed model in a top-level variable named `part`" [code: `dataset/*/instruction.md`]. One-shot harnesses return "CAD code inside a structured XML block" [read].
- Execution [code: `verifier/tasks/utils.py`]: in-process `exec` with restricted builtins, import allowlist `{"build123d","math","numpy"}`, SIGALRM timeout; result taken from `part` / `result` / `model` / `build_part()`; tessellated via `part.tessellate(0.03)` into trimesh. Reference gate is a boolean-volume diff against `solution/gold.py`, not Chamfer.
- Results: best of 19 one-shot model sweeps **0.599** (Gemini 3.1 Pro), best of 32 agent-harness runs **0.677** (Codex + GPT-5.4-mini). Means by tier, one-shot vs agent: easy 0.930/0.906, medium 0.753/0.849, hard 0.585/0.761, **functional 0.037/0.141**. Right-angle gearbox builds in 96.9% of agent attempts but scores 4.0% [read]. "Agent harnesses generally outperform standalone one-shot generation, consistent with the hypothesis that execution feedback helps repair dimensional, geometric, and interface errors" [read].
- The repo contains **no prompts or tools** of its own; agents come from the Harbor framework (codex, pi) [code].

#### CADGenBench (Hugging Face, 2026; repo https://github.com/huggingface/cadgenbench)
- Tasks: engineering drawing -> STEP; STEP + edit request -> STEP. Tool-agnostic (submit STEP). Reference baseline supports **build123d (default) and CadQuery** [read].
- Scoring: validity gate (well-formed, watertight B-rep; failure zeroes everything), surface-distance F1 + volume IoU, interface match via keep-in/keep-out volumes, topology via Betti numbers [read].
- Baseline agent: "writes build123d Python, renders the resulting STEP (PyVista/VTK), and reviews the renders to refine its code"; loops until valid [read].
- Leaderboard (BenchLM mirror, snapshot 20 Nov 2026, **[secondary]**, https://benchlm.ai/md/benchmarks/cadgenbenchgeneration.md): 1. SMC Harness v1.2 + Fable 5.2 Max 91.7%; 2. Godela "Modernized Agentic" 90.2%; 3. **build123d-mcp 0.3.85 + Claude Opus 5.5 (max effort) 86.9%**; 5. build123d-mcp + Opus 5 xhigh 59.6%; HF one-shot baselines: GPT-5.6 Sol 35.5%, GPT-5.5 Pro 32.1%, Opus 4.7 29.9%, Opus 4.6 23.6%, Gemini 3.1 Flash-Lite 22.4%. No CadQuery submission is labelled as such. build123d-mcp's README claims (June 2026) it lifted the same model from 0.360 to 0.457 and validity from 88% to 100% [read, self-reported].

#### Parametric CAD Bench v3 (gNucleus AI, arXiv 2611.02659, 2 Nov 2026)
- Link: https://arxiv.org/abs/2611.02659 (PDF text extracted locally).
- 100 tasks; agents work in a pinned **FreeCAD 1.1.0** container and must save a native `.FCStd` with a feature tree; grader = geometry similarity + spec checks (1% tolerance) [read].
- Snapshot 24 Sep 2026, 13 model–agent systems: Claude Code + Opus 5.5 **61.03%** overall, 84.66% image-to-CAD; mini-swe-agent + Opus 5.5 57.96%; Codex + GPT-6 Astra 56.87%; Claude Code + Fable 5.1 56.75% (best creation, 55.48%). Create-and-edit is hardest: five tasks score zero for every system. Agent choice matters: Gemini 3.8 Flash scores 31.10% image-to-CAD with mini-swe-agent's multimodal bridge vs 17.45% with Antigravity [read].
- [inferred] This is the strongest evidence that *general coding agents with a Python CAD API* (FreeCAD's here) are competitive, and that the harness (what tools/images the model gets) moves scores by 10–20 points.

#### CAD-Coder (Guan et al., arXiv 2505.19713, v3 Oct 2025)
- Link: https://arxiv.org/html/2505.19713v3
- CadQuery; Qwen2.5-7B SFT on 8K pairs + GRPO with Chamfer + format reward; 110K triplets auto-generated with DeepSeek-V3 keeping the executable lowest-CD candidate [read].
- Invalid-code rate: CAD-Coder 1.45%, Text2CAD 3.75%, **GPT-4o 93.00%, Claude-3.7-Sonnet 47.03%** (one-shot, on their DeepCAD-derived test set) [read]. Shows how badly 2025 frontier models did one-shot on this distribution and how much targeted fine-tuning helps — but see Text2CAD-Bench where the fine-tuned models collapse on anything beyond the training distribution.

#### Text-to-CadQuery (Xie & Ju, arXiv 2505.06507, May 2025)
- Link: https://arxiv.org/html/2505.06507v1
- Argument for CadQuery: "a pure Python package that can be executed directly without any external software dependencies", unlike FreeCAD/OpenSCAD; pretrained LLMs already write Python [read]. 170K pairs; Qwen2.5-3B best (Gemini-judged similarity 69.3% vs 58.8% baseline; median CD 0.191 vs 0.370) [read].

#### CAD-Recode (Rukhovich et al., ICCV 2025) — point cloud -> CadQuery
- https://cad-recode.github.io ; Qwen2-1.5B + point projector trained on 1M procedurally generated CadQuery scripts; 10x lower mean CD than prior work on DeepCAD/Fusion360 [read]. Relevant as evidence that CadQuery is a good *target language for small models*, and as a possible STEP-import-to-script path.

#### ToolCAD (arXiv 2604.07960, Apr 2026) — direct tool calls
- Link: https://arxiv.org/html/2604.07960v2
- FreeCAD wrapped as six MCP primitives (`set_coord_system`, `create_complex_sketch`, `create_simple_sketch`, `boolean_operation`, `multiple_fuse`, `extrude_face`); RL in a "CAD gym" with engine feedback: raw engine output (geometric conflicts, constraint warnings, API errors) plus structured success/fail messages and a list of current entities [read].
- ToolCAD Qwen2.5-7B (L3): invalidity 1.51, MCD 1.12, success 63.9% vs GPT-4o ReAct 9.12 / 5.88 / 62.7% [read]. **No controlled comparison against code generation** — the paper argues for tools in the intro but runs no CadQuery baseline on the same setup [read].

#### Others, briefly
- **Query2CAD** (Badagabettu et al., arXiv 2406.00144, 2024): GPT-4 writes FreeCAD Python; BLIP-2 captions renders for refinement; needed human-in-the-loop because the captioner produced false negatives [read via search]. Later work (CADSmith) explicitly moved to kernel measurements because captions lose dimensional precision.
- **BlenderLLM** (2024): fine-tuned Blender-script model with self-improvement; 200-prompt benchmark [secondary]. Blender bpy is mesh-only; not relevant for B-rep.
- **CAD-Assistant** (Mallis et al., 2024): VLM planner generating FreeCAD Python, zero-shot across tasks [secondary].
- **CADBench** (MIT, arXiv 2605.10873, May/Jun 2026): 18K samples, image/mesh -> CAD program; pipeline accepts **CadQuery**; conclusion: "specialized mesh-to-CAD models substantially outperform code-generating VLMs" under idealized inputs, VLMs "remain far from reliable CAD program reconstruction"; evaluation is direct generation without tool use [read].
- **BenchCAD** (arXiv 2605.10865, 2026): 17,900 execution-verified CadQuery programs across 106 industrial families; headline finding is that models identify the part family but miss local dimensions [read via search]. BenchCAD 2.0 (Oct 2026) adds agentic evaluation in an offline sandbox [read in PCB v3 related work].
- **CadEval** (Epoch AI, 2026, https://epoch.ai/benchmarks/cad-eval): OpenSCAD-style programs, Chamfer/Hausdorff/volume thresholds; no public per-model scores on the page [read].
- **STEP-LLM** (arXiv 2601.12641, DATE 2026): generates STEP text directly, arguing scripts are kernel-dependent [read via search]. [inferred] Not practical for editing workflows; STEP is not a design representation.
- **Zoo KCL**: no third-party benchmark of LLM-written KCL found. Zoo's own claim is qualitative ("LLMs need clear, human-readable code to work well", "Zoo built both—a readable CAD language and a custom 3D kernel—which is why Zookeeper works so well with LLMs") [read: https://zoo.dev/docs/zoo-design-studio/text-to-cad].
- **replicad / JSCAD / CascadeStudio / bitbybit**: no published LLM benchmark found. Community projects exist (kernelCAD-web: "agent-oriented layer over Replicad/OpenCASCADE... JSON-serializable commands, introspection, and feedback loops"; C33D: commercial, LLM builds a node graph over replicad) [secondary].

### 1.3 Evidence matrix (what the numbers support)

| Claim | Support | Strength |
|---|---|---|
| Code beats command sequences for the same LLM | Text2CAD-Bench Table 3 (IR 13% -> 67% for DeepSeek-V3.2) | strong, controlled |
| OpenSCAD is more *executable* one-shot than CadQuery | P3D-Bench (Valid 94–99% vs 22–99%) | strong, controlled, but one-shot and mesh-only |
| build123d has higher pass rate / lower latency than CadQuery; slightly lower one-shot IoU | CADDesigner Table 5 | single study, one agent, one model |
| Iterative agents beat one-shot | CAD-bench (0.599 vs 0.677; functional 0.037 vs 0.141), CADGenBench leaderboard, CADSmith, PCB v3 | strong, consistent across 4 sources |
| Kernel metrics alone get most of the gain; vision closes hard cases | CADSmith ablation | single study, clean ablation |
| Visual feedback helps only if the model keeps iterating | P3D-Bench multi-turn | single study |
| VLM self-verification is noisy | CADCodeVerify Table 9 (64.6–68.2% answer accuracy) | single study |
| Direct tool calls can match code | ToolCAD | no controlled comparison exists |
| KCL is LLM-friendly | Zoo marketing only | no independent evidence |

---

## 2. Self-correction loops: what the sources actually do

Ordered from cheapest to most expensive signal. All of these are implemented somewhere in the cloned repos or papers.

1. **Compile/execute error -> retry with traceback.** Universal. Text2CAD-Bench: 3 retries. CADSmith inner loop: 3. build123d-mcp adds classification + hints [code: `tools/execute.py`]:
   ```python
   def execute_code(session, code: str) -> str:
       result = session.execute(code)
       if result.startswith("Error:") or result.startswith("Constraint failed"):
           matched = [hint for patterns, hint in _HINTS if any(re.search(p, result) for p in patterns)]
           if matched:
               result += "\n\nHint: " + ("\n      ".join(matched))
           classification = _classify_from_error_string(result)   # {"failure_class": ..., "suggested_fix": ...}
           result += "\n\n" + json.dumps(classification)
   ```
   with hints such as "ShapeList is not a Part — `Box() + Cylinder()` concatenates shapes into a list rather than fusing them. Fix: use `Part() + Box(...) + Cylinder(...)`" [code: `tools/repair_hints.py`]. This is a cheap way to convert build123d's quirks into one-shot fixes.
2. **Validity gate.** build123d-mcp `validate()`: "BRepCheck well-formedness, a closed manifold, a real solid body, and non-degenerate volume" [code: `tools/validate.py`]. CADGenBench zeroes the score on an invalid STEP; CADSmith fails invalid solids automatically. Merrivile's STEP/STL export should refuse invalid solids the same way.
3. **Kernel measurements returned as text.** CADSmith: volume, bbox, face/edge/vertex counts, center of mass, validity. build123d-mcp `measure()` returns "volume, surface area, topology (face/edge/vertex counts, plus for solids: solids, through_openings = genus ... voids), bounding box ... center of mass, inertia tensor, and a face-type inventory classifying every face as Plane/Cylinder/Cone/Sphere/Torus/BSpline"; its system prompt says "Prefer measure over render_view for verifying geometry — numbers are unambiguous. topology is the fastest confirmation that a boolean operation succeeded: a failed cut leaves face/edge/vertex counts unchanged" [code: `server.py`, `default_prompt.md`].
4. **Spec conformance.** build123d-mcp `verify_spec(spec_json)` checks envelope, solid count, volume range, hole patterns, bosses, countersinks, material-at-point, wall thickness, parameter ranges and returns PASS/FAIL/UNVERIFIED per requirement [code: `tools/verify_spec.py`]. CAD-bench's graders do the same thing offline. [inferred] For Merrivile this is the natural way to let the model turn a user request into checkable assertions before writing code.
5. **Rendered views to the model.** CADAM: seven views (ISO, FRONT, BACK, LEFT, RIGHT, TOP, BOTTOM) on one "preview sheet" attached to the tool result [code]. CADCodeVerify: 4 views at 90 degrees. CADSmith: 3 views (iso, rear-high, front). CADDesigner: 6 views. build123d-mcp: `render_view(view="iso", clip_plane="y", quality="high")` with section cuts for internal geometry [code].
6. **VLM-generated verification questions.** CADCodeVerify and CADDesigner. Noisy (64–68% answer accuracy) but adds a few points; CADSmith instead uses a *stronger* model (Opus) as judge of a weaker generator (Sonnet) plus kernel numbers.
7. **Parameter robustness audit.** build123d-mcp `design_audit()` nudges each top-level numeric parameter +/-10% in a subprocess and re-runs the validity gate; flags "brittle" parameters [code]. [inferred] Directly useful for Merrivile's "paper" concept where parts are meant to be re-edited by the AI later.
8. **Snapshots.** build123d-mcp `save_snapshot`/`restore_snapshot`; prompt: "Don't layer fixes on a broken state" [code].

Stopping behaviour matters: P3D-Bench shows GPT-5.5 declares victory after one turn. CADAM's prompt fights this explicitly: "Do not finalize just because OpenSCAD compiled. Finalize only because the views look right." [code: `src/server/aiChat.ts`]. CADSmith caps outer loop at 5; CADCodeVerify at 2.

---

## 3. Products and open-source projects

| Product | Language the AI writes | Kernel | Runs where | Open? | Notes |
|---|---|---|---|---|---|
| Zoo Design Studio / Zookeeper / Text-to-CAD | **KCL** | Zoo's own engine (OpenNURBS + Vulkan, GPU) | engine server-side; app/KCL interpreter client-side (Rust/WASM) | app + kcl-lib MIT; **engine proprietary** | Section 4 |
| Adam / CADAM (YC W25) | **OpenSCAD** (+BOSL2) | OpenSCAD (CGAL/Manifold) compiled to WASM | **browser** compiles; LLM via server (Vercel AI SDK, Anthropic/Google/OpenRouter) | CADAM GPLv3 | Plans CadQuery/build123d for fillets/lofts/STEP [read HN]. Mesh output only. |
| Backflip AI | none public (ML, "thinking" mode) | not disclosed; outputs feature-based CAD (extrusions/revolves), STEP export, Fusion add-in | cloud | closed | Scan/photo/drawing/video -> CAD; 7–10 min solves; mixed reviews [read engineering.com 2026-09-30] |
| Leo AI | none public ("Large Mechanical Model", "not an LLM") | B-rep output compatible with SolidWorks/Onshape/Catia/Inventor | cloud + CAD plugins | closed | Generates full assemblies with feature trees [secondary] |
| Onshape (PTC) | **FeatureScript** via FeatureScript MCP Server (Onshape Labs, Aug 2026); AI Advisor (chat) | Parasolid | SaaS | closed; MCP via App Store subscription | Section 5 |
| Autodesk Fusion | agents call Fusion via **Fusion Compute MCP** (public beta 2026): CAD/CAM/assemblies/exports; "neural CAD" text-to-B-rep foundation model announced, not shipped | Autodesk kernel | cloud Fusion sessions (2 concurrent, 1 h max, 15 min idle) | closed | [read Autodesk blog] |
| build123d-mcp (pzfreo) | **build123d** | OCCT via build123d | local subprocess (stdio) or self-hosted HTTP | Apache-2.0 | 37+ tools; sandboxed worker; top-3 on CADGenBench with Opus 5.5 |
| cadquery-mcp (PyPI 0.1.0) | CadQuery | OCCT | local | OSS | single render-to-SVG tool [secondary] |
| vibe-cading (June 2026) | CadQuery | OCCT | local | OSS | optional MCP server [secondary] |
| freecad-robust-mcp, AnkusDrive | FreeCAD Python | OCCT (FreeCAD) | local, needs running FreeCAD | OSS | [secondary] |
| kernelCAD-web, C33D, ForgeCAD | replicad / TS | opencascade.js (browser) | browser | mixed | no benchmarks [secondary] |
| Godela, Standard Manufacturing Co "SMC Harness", Mecado | undisclosed harnesses over build123d (Mecado baselines say "with Build123d") | OCCT | ? | closed | top of CADGenBench [secondary] |

### 3.1 CADAM (Adam) — what the code shows [code]
- Stack: React 19 + TanStack Start + Vite; Three.js/R3F viewer; Supabase; OpenSCAD WASM in a Web Worker (`src/worker/openSCAD.ts`, derived from seasick/openscad-web-gui); Vercel AI SDK with `@ai-sdk/anthropic`, `@ai-sdk/google`, `@openrouter/ai-sdk-provider` (`src/server/aiChat.ts`).
- Tools (`shared/chatAi.ts`): `build_parametric_model` ("Create or update the complete OpenSCAD CAD artifact. After the browser compiles it, inspect the returned multi-view preview sheet and call this tool again if the model needs another revision."), `answer_user`, `create_mesh` (separate mesh-gen path).
- The loop is **client-executed**: the browser compiles, renders 7 views, uploads the sheet, and returns the tool output with the text "Compilation successful. Inspect the multi-view render in this tool result against the user request from every visible angle. If any required feature is missing, wrong, too simple, disconnected, non-printable, hidden from some view, or visually unclear, call build_parametric_model again with a corrected complete OpenSCAD script." Compile failures return `Compilation failed:\n<stderr>` as a tool error and auto-continue (`src/components/chat/ChatSession.tsx`). `stopWhen: stepCountIs(60)` for parametric chats.
- System prompt (`PARAMETRIC_AGENT_PROMPT`) highlights: "Keep looping through write -> multi-view screenshot inspection -> rewrite until the model is good or you hit the turn limit"; a per-object checklist ("Mug -> body, hollow interior, rim, base, handle, printable wall thickness"); parameter conventions with OpenSCAD Customizer comments (`width = 50; // [10:1:200]`) so the UI renders sliders without re-prompting; `*_color` parameters for color pickers; BOSL2 for threads and sweeps.
- Export: STL/OFF/DXF only; no STEP (OpenSCAD limitation) [code, read HN].
- Maintainers on HN (Sep 2025): "Gemini 2.5 and Claude 4 were the most reliable API options"; roadmap "Move beyond CSG primitives ... via CadQuery or Build123D"; commenters report hallucinated BOSL functions and non-watertight unions [read].

### 3.2 build123d-mcp — what the code shows [code]
- Architecture (`research.md`, `worker.py`): FastMCP server; parent process never loads OCCT; a spawned worker owns the build123d session; per-op timeouts (execute 30 s, render 120 s, export 60 s, measure 10 s); worker killed and restarted on crash. Three-layer sandbox for LLM code: AST check, restricted builtins, timeout (`security.py`).
- Tool surface (`llms.md`): `execute`, `session_state`, `render_view`, `measure`, `validate`, `design_audit`, `suggest_spec`, `verify_spec`, `clearance`, `cross_sections`, `export`, `interference`, `inspect_features`, `diff_step`, `edit_feature`, `import_cad_file`, `search_library`/`load_part` (bd_warehouse: bearings, fasteners, gears, threads), `last_error`, `repair_hints`, `workflow_hints`, `save_snapshot`/`restore_snapshot`/`diff_snapshot`, `reset`, plus resources (`build123d://quickref`, selectors cookbook) and a `start-cad-session` prompt.
- Session model: one persistent Python namespace; "Assign your final shape to `result`"; `show(shape, "name")` registers named parts so assemblies can be rendered/measured/exported per part.
- System prompt (`default_prompt.md`) validation protocol, verbatim: "Follow this order — deterministic checks before visual: 1. After every `execute()` — call `measure()`. ... 2. After assembly positioning — call `compare(a="part", b="mate", kind="fit")` ... Status should be `touching` or `apart`, not `interpenetrating`. 3. Only after (1) and (2) pass — call `render_view()`. 4. Before finishing a parametric part — call `design_audit()` ... 5. Before final export — call `validate()`, then `export()`." And: "Author for editability — a design to edit, not a shape to render. Put named parameters with units at the top and build from them, never from inline magic constants."
- `measure()` returns `through_openings` (genus) and `voids` computed from B-rep Euler–Poincaré counts; the changelog says on 7 CADGenBench outputs it matches the scorer's topology tuple exactly (v0.3.92).
- Self-reported: CADGenBench June 2026, 0.360 -> 0.457 and validity 88% -> 100% for the same model [read README].

### 3.3 Zoo modeling-app — see section 4.

---

## 4. Zoo's stack

- **What is open**: the Design Studio app is MIT (`modeling-app/LICENSE`, "Copyright 2023, The Zoo Authors") [read GitHub]. The KCL compiler/interpreter crate `kcl-lib` is MIT on crates.io ("compiler tooling (parser, lexer, code generation), the standard library implementation, a LSP implementation") [read docs.rs/lib.rs]. Python bindings `KittyCAD/kcl.py` exist [read].
- **What is closed**: the geometry engine. Zoo: "Zoo Design Studio (the application layer, not the engine) is open source" [read: https://zoo.dev/blog/zoo-design-studio-v1 , 21 May 2025]; FAQ: "The CAD geometry engine is not open source" and "An internet connection is required for modeling, rendering, Zookeeper" [read: https://zoo.dev/docs/faq]. The engine is "our own geometry engine" built with OpenNURBS and Vulkan, with surface/surface intersection "derived as a parallelizable root-finding problem that runs on modern GPUs" [read blog]. A third-party index describes the 3D view as "a video stream from a hosted geometry engine via WebSockets" [secondary]; see the code findings below.
- **Third-party use**: yes. FAQ: developers can "build a custom CAD application with Zoo's APIs"; Zoo MCP lets external AI clients connect via API token [read]. Endpoints: `/ws/modeling/commands` (engine websocket), `/ws/ml/copilot` (Zookeeper agent websocket), `/ws/ml/reasoning/{id}`, `/user/text-to-cad`, `/ml/custom/models` (org-trained custom models) [read: https://zoo.dev/docs/developer-tools/api/ml].
- **Cost**: usage-based, per second. "Text-to-CAD now bills per second at the same $0.50/min rate" (billing update 26 Sep 2025) [read blog]; per-second post: "$0.50 per minute, which is $1/120 per second" since 30 Sep 2025, calls under 10 s billed since 14 Oct 2025 [read]. Failed calls free; GET free except the two websockets; Zookeeper reasoning time and API usage draw from one monthly credit; pay-as-you-go is opt-in. The current included minutes per plan render as unfilled template placeholders on the FAQ page (`{{pricing.free.included_usage_minutes}}`) and the pricing table did not load without JS, so I could **not** confirm 2026 free-tier amounts; older sources say 20 free minutes/month (Jan 2025 post) or 20 Text-to-CAD credits/month (May 2025 post) [read, dated]. Zoo Design Studio modeling itself is "unlimited" for interactive use; the API meter applies to programmatic use [read].
- **[inferred] cost model for a Merrivile-like app on Zoo**: every modeling websocket session is metered at $0.50/engine-minute, so an agent that keeps a session open while iterating would cost roughly $30/hour of wall-clock engine time, before LLM tokens. Fine for a demo, awkward for an always-on viewer.
- **KCL and LLMs**: Zoo's stated design: dimensions with units (`length = 2mm`), immutable values, named arguments, `|>` pipelines so that "functions read like a feature tree", terse enough for "human reviewable version-control diffs"; "no mechanical engineer ever has to touch KCL" [read blog]. Zookeeper (Jan 2026, Design Studio v1.1) "is powered by LLMs with strict context management", "frequently executes the model to check for errors", analyzes models "via visual snapshots and computational tools for engineering" (center of mass, mass, surface area, volume), follows "Plan, Act, Observe, Update, Repeat" [read: https://zoo.dev/research/zookeeper , 5 Feb 2026]. Enterprise customers can convert feature-tree files to KCL to fine-tune a bespoke model [read blog]. **No independent benchmark of LLM-written KCL was found**; general-purpose models have essentially no KCL in pretraining compared with Python, so Zoo's good results depend on their own fine-tuning and tooling [inferred]. KCL 3.0 introduced breaking changes ("Migrating to KCL 3.0" page) [read docs index], which is a hazard for any model trained on older samples [inferred].

### 4.1 modeling-app code findings
See section 7.5. Summary [code]: KCL interpreter is MIT and runs as WASM in the browser, but every modeling command goes over `wss://api.zoo.dev/ws/modeling/commands` to the private engine (`github.com/KittyCAD/engine`, not public); the default viewer is a WebRTC `<video>` of the engine's render; an opt-in local three.js renderer still fetches a GLB from the remote engine; Zookeeper's prompts, tools and compile/repair loop are server-side and invisible to the client.

---

## 5. Onshape as a backend (brief)

- **Plans**: Free $0 (public documents only, non-commercial), Standard $1,500/user/yr, Professional $2,500/user/yr, Enterprise custom [read: https://www.onshape.com/en/pricing].
- **API limits** [read: https://onshape-public.github.io/docs/auth/limits]: annual successful-call caps — Free/Standard 2,500 per user, Professional 5,000, Enterprise 10,000 per full user. Calls via API keys and *private* OAuth apps count; calls from apps **publicly listed in the App Store** do not. Scraping public documents is prohibited [read api-intro].
- **AI surface**: FeatureScript MCP Server (Onshape Labs, announced 13 Aug 2026; `https://fs-mcp.labs.onshape.app/mcp`, HTTP transport; subscribe via App Store; the AI can "insert it into an Onshape document, run it, evaluate the results, identify errors, and revise the code") [read]. No general document/Part-Studio MCP is described (post of 9 Sep 2026) [read]. AI Advisor is a chat assistant, GA on all plans [secondary].
- **Practicality for Merrivile** [inferred]: driving Onshape means (a) every Merrivile user needs an Onshape account; (b) on Free, every part is public; (c) a private integration burns 2,500 calls/user/year — one agent iteration is several calls (update feature, evaluate FeatureScript, export tessellation), so that is a few hundred edits per year; (d) geometry would be rendered by Onshape or fetched as tessellation/STEP via the API, so Merrivile's three.js viewer would still need an export step; (e) FeatureScript is a less-trained language than Python for LLMs, and the vendor's own MCP uses an in-document run/evaluate/revise loop rather than anything Merrivile could run offline. Verdict: viable as an *export/sync target* later, not as the modeling backend.

---

## 6. Reusable ideas for Merrivile's agent loop

From the sources above, ranked by evidence and cost:

1. **Tool surface, not raw code dumps.** Use a persistent-session `execute` tool plus `measure`, `validate`, `render_view`, `save/restore_snapshot`, `export` (build123d-mcp's core five plus snapshots). Return kernel numbers as structured text *before* images; put "deterministic checks before visual" in the system prompt [code: build123d-mcp].
2. **Error classification + hints** for build123d's recurring gotchas (ShapeList vs Part, `None` from BuildPart, fillet radius too large, selector empty). This is a ~60-line table in build123d-mcp [code] and directly addresses the executability deficit P3D-Bench measured for Python CAD.
3. **Validity gate before export**, same semantics as CADGenBench's scorer: BRepCheck, closed manifold, one solid, non-zero volume. Refuse to export otherwise [code].
4. **Multi-view preview sheet as a single image** in the tool result (CADAM's seven views on one PNG) [code]; a section cut (`clip_plane`) view for internals [code: build123d-mcp].
5. **Spec-first**: have the model write a small JSON spec (envelope, hole patterns, volume range) from the user's request and verify against it before declaring done (build123d-mcp `suggest_spec`/`verify_spec`). CAD-bench shows "builds" are not "correct": 12.5% of all attempts built but scored zero [read].
6. **Parameter hygiene for editability**: named parameters with units at the top of the script; `design_audit` perturbation to catch brittle parameters [code]; CADAM's Customizer-style annotations drive UI widgets without re-prompting [code]. Fits Merrivile's "the human only inspects/changes appearance" model: expose sliders from script metadata.
7. **Stopping rule**: require a final `validate` + `measure` + one render before the model may answer; forbid "finalize because it compiled" [code: CADAM prompt]; cap iterations (CADSmith 3 inner / 5 outer).
8. **Judge split**: a cheaper generator and a stronger judge given kernel metrics + 3 views (CADSmith) — relevant because Merrivile is "any OpenAI-compatible LLM": the judge prompt is model-agnostic.
9. **Assemblies**: register named parts (`show(part, "name")`) and give the model `compare(kind="fit")`/`interference` tools; CAD-bench shows functional assemblies are where every system fails (0.141 agent mean) [read], so this is where tool feedback pays most.
10. **Prompt-style guidance for users**: geometric descriptions for simple parts, procedural descriptions for sweeps/lofts [read: Text2CAD-Bench].

---

## 7. Hands-on repo notes

### 7.1 build123d-mcp (`reference/repos/build123d-mcp`)
Covered in 3.2 and 2. Extra details worth copying:
- `execute` success path appends "Session objects: name (type), ..." so the model always knows what exists [code: `tools/execute.py`].
- `last_error()` returns exception type, message, line number and a 5-line excerpt [code: `server.py`].
- `inspect_features` / `diff_step` use a feature-recognition library (`specify-core`) to describe holes, bosses, fillets and to diff two STEP files ("orange modified, green added, red removed" overlay) [code: `server.py` docstrings].
- Docs worth reading: `docs/design-conformance-proposal.md`, `docs/arko-t-design-state-analysis.md` (the "valid shape vs editable design" argument), `docs/adr/0002-worker-subprocess-crash-containment.md`.

### 7.2 CADAM (`reference/repos/CADAM`)
Covered in 3.1. Files: `src/server/aiChat.ts` (prompts, model pricing table, `stepCountIs(60)`), `shared/chatAi.ts` (tool schemas), `src/components/chat/ChatSession.tsx` (client-side tool execution, preview-sheet upload, auto-continue), `src/worker/openSCAD.ts` + `src/vendor/openscad-wasm` (compiler), `src/components/viewer/OpenSCADViewer.tsx` (STL/OFF preview, "Fix with AI" button that feeds `OpenSCADError.stdErr` back), `benchmarks/*.scad` (13 showcase parts: turbine blisk, V8, planetary gearbox).

### 7.3 cad-bench (`reference/repos/cad-bench`)
Covered in 1.2. Useful as a **test suite for Merrivile**: 17 `instruction.md` tasks with graders in `verifier/tasks/`, `metadata/cad-bench-reported-results.json` (51 runs). The grader's `exec` sandbox (`verifier/tasks/utils.py`: restricted builtins, import allowlist, SIGALRM) is a minimal reference for running LLM-written build123d server-side.

### 7.4 CAD_Code_Generation (`reference/repos/CAD_Code_Generation`)
CADPrompt dataset only (200 folders with `Python_Code.py`, STL/OBJ, DeepCAD JSON, `Ground_Truth.json` metrics, two prompt variants). No CADCodeVerify code. Useful as a second test set (CadQuery -> would need porting to build123d, or run CadQuery alongside).

### 7.5 modeling-app (`reference/repos/modeling-app`) [code]
All paths relative to the repo root. `node_modules` not installed, so `@kittycad/lib` message types were read from mocks and renderers.

**KCL executes in the browser as WASM, but geometry is built remotely.**
- `scripts/build-wasm.sh`: `wasm_pack_args=(build kcl-wasm-lib --release --target=web ...)`; loaded by `src/lib/wasm_lib_wrapper.ts`.
- `rust/kcl-lib/src/engine/engine_manager/wasm_transport.rs`: "Functions for setting up our WebSocket and WebRTC connections for communications with the engine." The WASM interpreter calls back into JS (`sendModelingCommandFromWasm` in `src/lib/engineConnection/connectionManager.ts`) which forwards each modeling command over a websocket.
- `src/env.ts`: `KITTYCAD_WEBSOCKET_URL: wss://api.${domain}/ws/modeling/commands`, `ZOOKEEPER_WEBSOCKET_URL: wss://api.${domain}/ws/ml/copilot`; `.env.production` sets `zoo.dev`.
- Command protocol is the published crate `kittycad-modeling-cmds = "0.2.262"` (`rust/Cargo.toml`); the engine itself is a separate private repo referenced only in `.github/ISSUE_TEMPLATE/release.md` ("Clone https://github.com/KittyCAD/engine ..."). The only local option is a URL override `ws://localhost:8080/ws/modeling/commands` for Zoo developers; `mock_transport.rs` "Doesn't actually connect to the engine" and returns zero-extent bounding boxes. **No offline kernel ships.**

**Viewer: video stream by default.**
- `README.md`: "The 3D view in Design Studio is just a video stream from our hosted geometry engine. The app sends new modeling commands to the engine via WebSockets, which returns back video frames of the view within the engine."
- `src/lib/engineConnection/connection.ts`: `new RTCPeerConnection(...)`; `src/components/ConnectionStream.tsx`: `<video autoPlay muted ... id="video-stream" />`.
- Opt-in `useLocalRenderer` (default false, `src/lib/settings/initialSettings.tsx`): still asks the *remote* engine for a GLB (`exportModel({ type: 'gltf', storage: 'binary', ... })` in `src/clientSideScene/localRenderer/LocalRenderer.ts`) and renders it with three.js. So the three.js path exists, but geometry still comes from the cloud.

**Zookeeper (AI) is entirely server-side.**
- Client sends (`src/lib/zookeeper/zookeeperManagerMachine.ts`): `{ type: 'user', project_id, content: prompt, project_name, source_ranges, current_files (all project files as blobs, 'text/kcl'), active_file, mode, additional_files (screenshots) }`, msgpack-encoded over the copilot websocket. Max message 128 MiB ("Matches text-to-cad's --ws-max-size").
- Selections become `source_ranges` with short NL hints written by the client, e.g. `"The selected wall originates from this specific sketch segment. Add or use a tag on this segment to refer to the wall, for example \`sketch(on = faceOf(someSweepVariable, face = someRegion.tags.segmentTag)) { ... }\`."` (`src/lib/zookeeper/zookeeperPromptRequest.ts`). These are the only prompt-like strings in the client; **no system prompt or tool schema exists client-side**.
- Client receives streamed `reasoning` items typed `text | markdown | kcl_docs | kcl_code_examples | feature_tree_outline | design_plan {steps:[{edit_instructions, filepath_to_edit}]} | generated_kcl_code | kcl_code_error | created/updated/deleted_kcl_file`, and `tool_output.result` typed `text_to_cad | edit_kcl_code` (with `outputs: {'main.kcl': ...}` and an optional unified-diff `zookeeper_edit_patch`), `mechanical_knowledge_base`, and project file tools `project_write_file/mkdir/rm/cp/mv` ("MCP mutations return acknowledged Project metadata", `src/lib/zookeeper/cloudProjectTools.ts`).
- [inferred from those types] The server agent's loop is: retrieve KCL docs and code examples, outline the feature tree, write a design plan, generate KCL, compile it, surface `kcl_code_error`, regenerate — i.e. a docs-RAG + execute-and-repair loop like CADSmith's, plus engine snapshots per Zoo's research post.
- Error feedback: the client shows `kcl_code_error` (`src/components/Thinking.tsx`) and re-executes applied edits locally (`ZookeeperFileRequestProcessor.ts`, `editorPlugin.ts` `shouldExecute: true`), but **does not send local execution errors back**; the server runs its own compile loop.

**License**: `LICENSE` MIT; `rust/kcl-lib/Cargo.toml` and `rust/kcl-wasm-lib/Cargo.toml` declare `license = "MIT"`.

**KCL sample** (`public/kcl-samples/pipe-with-bend/main.kcl`, one of 129 samples):
```kcl
@settings(defaultLengthUnit = in, kclVersion = 2.0)

innerDiameter = 10
outerDiameter = 20
bendRadius = 30
bendAngle = 90deg

pipeSectionSketch = sketch(on = XZ) {
  outerCircle = circle(start = [var 40in, var 0in], center = [var 30in, var 0in])
  fixed([outerCircle.center, [bendRadius, 0]])
  radius(outerCircle) == outerDiameter / 2

  innerCircle = circle(start = [var 35in, var 0in], center = [var 30in, var 0in])
  coincident([innerCircle.center, outerCircle.center])
  radius(innerCircle) == innerDiameter / 2
}

pipeSectionRegion = region(segments = [pipeSectionSketch.outerCircle])
pipe = revolve(pipeSectionRegion, axis = Y, angle = bendAngle)
hide(pipeSectionSketch)
```
[inferred] Note the constraint-solver sketch block (`fixed`, `coincident`, `radius(...) ==`): KCL 2.0/3.0 is drifting toward a constraint DSL that general LLMs have not seen in pretraining; the `kcl_docs`/`kcl_code_examples` reasoning steps above show Zoo compensates with retrieval.

---

## 8. Gaps / things I could not find
- No benchmark scores OpenSCAD, CadQuery **and** build123d on the same tasks; CADDesigner (CadQuery vs build123d) and P3D-Bench (OpenSCAD vs CadQuery) are the two halves.
- No independent evaluation of LLM-written KCL or FeatureScript.
- No controlled "structured tool calls vs code" comparison (ToolCAD argues for tools but has no code baseline on its setup).
- Zoo's current per-plan included minutes (pricing page needs JS; FAQ placeholders unrendered).
- Onshape API Terms of Use text (only the limits page and pricing page were readable).
- Leo AI / Backflip internals beyond "B-rep output" statements in press.
- CADCodeVerify's exact prompts (in the OpenReview appendix, not fetched).

---

## 9. Recommendation on the modeling language

**Keep build123d (Python over OCCT) as the language the AI writes, executed server-side in a sandboxed worker, with a small MCP-style tool surface.** Reasons, with the evidence class:

- It produces B-rep and STEP, which Merrivile's import/export requires; OpenSCAD cannot (CADAM's own roadmap is leaving it for this reason) [read].
- Python-over-OCCT has the broadest LLM evidence base and is what the strongest public harnesses use: CAD-bench's built-in one-shot format and CADGenBench's baseline and top-3 entry are build123d [read/secondary]; CADDesigner found build123d had the highest pass@1 and lowest latency of the three Python representations it tested [read].
- Its weaknesses (API hallucination, `ShapeList` confusion, slightly lower one-shot geometric fidelity) are exactly what an execute/measure/validate loop plus a hint table fixes, and that loop is open-source and Apache-licensed in build123d-mcp [code].
- Any OpenAI-compatible LLM can write Python; KCL and FeatureScript tie you to a vendor engine (Zoo: metered, closed, online-only; Onshape: call caps, public docs on Free) [read].
- Sequence/JSON-ops formats are measurably worse for general LLMs [read: Text2CAD-Bench, P3D-Bench]. Direct tool calls (ToolCAD-style primitives) are unproven against code and lose the script as a reviewable, diffable source of truth [inferred].

Hedges and alternatives:
- If a browser-only kernel becomes a hard requirement, the TS route (replicad / opencascade.js, already in `reference/repos`) keeps B-rep but has **no** LLM evidence; expect to write the hint table and docs-in-context yourself. OpenSCAD-wasm (CADAM) is the most executable but mesh-only.
- Keep CadQuery importable in the same sandbox: most datasets/benchmarks (CADPrompt, Text2CAD-Bench, BenchCAD, CADBench) are CadQuery, and build123d and CadQuery share `cadquery-ocp`, so running both costs nothing and lets Merrivile reuse those test sets.
- Put the build123d quickref and selector cookbook (build123d-mcp resources) into the system prompt or a retrieval tool; CADSmith's RAG over API docs is part of why its executability hit 99–100%.
- For "appearance" and "explode" (human-facing commands already mocked in `web/`), keep those as separate non-geometry tools so the geometry loop stays deterministic [inferred].

Sources index (all accessed 2026-11-21): see links inline. Papers: arXiv 2410.05340, 2605.18430, 2606.11152, 2508.01031, 2603.26512, 2611.02659, 2505.19713, 2505.06507, 2604.07960, 2605.10873, 2605.10865, 2406.00144, 2601.12641; CAD-bench paper (jsdelivr PDF); CADGenBench GitHub + BenchLM mirror; Zoo blog/FAQ/research/docs; Onshape pricing/limits/blog; Autodesk Fusion blog; engineering.com 2026-09-30; HN 45140921.
