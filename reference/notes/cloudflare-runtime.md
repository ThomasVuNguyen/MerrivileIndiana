# Cloudflare runtime options for Merrivile geometry execution

Research notes, checked **2026-11-21** unless stated otherwise. Every fact is tagged:

- **[READ]** read in official Cloudflare docs / changelog (link given)
- **[MEASURED]** measured on this machine (wrangler 4.166.0, workerd local; Linux 6.8, node 22.16)
- **[INFERRED]** my conclusion from READ/MEASURED facts; not verified end to end
- **[COMMUNITY]** forum / GitHub / blog, not official

Context: the AI writes code (build123d Python or replicad/opencascade.js TypeScript) that produces B-rep geometry; the code must be executed, tessellated, exported to STEP/STL/GLB and stored. Browser viewer is React + three.js. Goal is 100% Cloudflare.

---

## 0. TL;DR

| Runtime | Can it run OCCT-class geometry? | Hard limits that matter | Status |
|---|---|---|---|
| Workers (JS + WASM) | **Not as shipped.** 22 MB OCCT WASM *uploads* fine (64 MiB cap) and the module instantiates, but Emscripten/embind glue dies on `new Function` (no dynamic code gen in Workers). Needs a custom `-sDYNAMIC_EXECUTION=0` build and would then have ~28 MB headroom under the 128 MB isolate cap (replicad build reserves 100 MB initial memory). | 64 MiB uncompressed bundle; 128 MB memory/isolate incl. WASM; 1 s startup; 30 s CPU default, 5 min max (Paid); single thread, no SharedArrayBuffer/Web Workers; no `eval`/`new Function`/`WebAssembly.compile(bytes)` | GA |
| Python Workers (Pyodide) | **No.** Only pure-Python + PyEmscripten wheels from PyPI/Pyodide; OCP.wasm wheels are not on PyPI and the 128 MB isolate cannot hold OCCT (build123d native peak RSS is 459 MB). | same as Workers; Python 3.14 / Pyodide 314.0.6 by default | GA (2026-09-21) |
| Dynamic Workers | Good for running the AI's *orchestration* JS in a sandbox; same engine limits as Workers so same OCCT caveats. Accepts `{wasm: ArrayBuffer}` modules at load time. | per-load cpuMs/subRequests caps; 4 (Worker) / 10 (DO) distinct dynamic workers in flight | GA-ish (no beta label) |
| **Containers** (DO-scheduled) | **Yes.** Any linux/amd64 image. Python + build123d works in 512 MiB; `lite` (256 MiB) is too small. | lite 1/16 vCPU 256 MiB 2 GB ... standard-4 4 vCPU 12 GiB 20 GB; custom sizes from 1/16 vCPU / 256 MiB; cold start 1-3 s + image entrypoint; image size = instance disk; 50 GB image storage/account | Containers GA 2026-04-13; the `durable_object` scheduling policy (needed for sandboxes/snapshots) is **public beta** and the `default` policy is deprecated |
| Sandbox SDK (`@cloudflare/sandbox` 1.0.3) | Yes — it is a thin helper over `ctx.container.exec()`; custom Dockerfile supported (copy `sandbox-shim`). `enableInternet:false` + HTTP(S) intercepts = egress control. | same as Containers; `exec()` has no built-in timeout; inactivity timeout up to 6 h | GA 2026-04-13 (Containers pricing) |
| Durable Objects / Agents SDK | Right place for the per-project agent loop + WebSocket streaming. | 128 MB; 30 s CPU per event (resets per incoming message; 5 min max); wall-clock unlimited while waiting on LLM fetch (≤15 min per pending op); 10 GB SQLite per object; 32,768 hibernatable WebSockets per object | GA |
| Workflows / Queues | Long multi-step jobs (export pipelines, retries). Not compute. | Queues msg 128 KB; Workflows step CPU 30 s default / 5 min max; step result 1 MiB | GA |

**Verdict:** geometry execution lives in a **Container** (Python + build123d, or a Node/OCCT image) driven by a Durable Object; the agent loop lives in a Durable Object (Agents SDK) that streams to the browser over hibernatable WebSockets; artifacts to R2; metadata to D1 or DO SQLite. Workers-side OCCT WASM is a stretch goal only after a CSP-safe (`-sDYNAMIC_EXECUTION=0`), small-initial-memory build exists.

---

## 1. Workers (JS)

Source: https://developers.cloudflare.com/workers/platform/limits/ (raw: `.../limits/index.md`), checked 2026-11-21.

| Limit | Free | Paid | Tag |
|---|---|---|---|
| Worker size (uncompressed) | 64 MiB | 64 MiB | [READ] |
| Compressed size limit | none ("There is no compressed size limit. Only the uncompressed bundle size counts.") | none | [READ] |
| Memory per isolate (JS heap + WASM allocations) | 128 MB | 128 MB | [READ] |
| CPU time per HTTP request | 10 ms | 30 s default, up to 5 min via `limits.cpu_ms = 300000` | [READ] |
| Wall-clock per HTTP request | unlimited while client connected | same | [READ] |
| Startup time (parse + run global scope) | 1 s | 1 s (error 10021 `Script startup exceeded CPU time limit`) | [READ] |
| Subrequests per invocation | 50 | 10,000 (raisable to 10M) | [READ] |
| Simultaneous open connections | 6 | 6 | [READ] |
| Incoming request body | 100 MB (Free/Pro zone), 200 MB (Business), up to 5 GB (Enterprise self-serve) — depends on the **zone** plan, not Workers plan | | [READ] |
| Outbound request body from a DO or container outbound handler | 100 MiB default | | [READ] |
| Response body size | not enforced by Workers (CDN cache 512 MB / 5 GB Ent) | | [READ] |
| Number of Workers | 100 | 500 | [READ] |
| Static asset file size | 25 MiB | 25 MiB | [READ] |

Changelog evidence:
- 2026-09-04 "Deploy larger Workers — up to 64 MiB for both free and paid plans"; removed the 3 MB (Free) / 10 MB (Paid) **compressed** checks. https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/ [READ]
- 2025-10-10 startup limit raised 400 ms -> 1 s. https://developers.cloudflare.com/changelog/post/2025-10-10-increased-startup-time/ [READ]
- The Agents SDK limits page still says "each script can be up to 10 MB" — stale relative to the Workers page. https://developers.cloudflare.com/agents/platform/limits/ [READ]

WebAssembly rules (https://developers.cloudflare.com/workers/runtime-apis/webassembly/ and `.../webassembly/javascript/`) [READ]:
- Import `.wasm` as a module (`import mod from "./x.wasm"`); wrangler bundles `.wasm` / `.wasm?module` by default.
- "`WebAssembly.instantiate()` only supports pre-compiled modules" — i.e. no runtime compilation from bytes.
- "Threading is not possible": single thread per Worker, Web Worker API not supported. SIMD supported. WASI experimental. (SharedArrayBuffer/Atomics are not mentioned in the docs; with no Web Workers there is nothing to share with — [INFERRED] the pthread/`replicad_multi` build is unusable.)
- Large WASM makes startup slower; use `wasm-opt`; `wrangler check startup` profiles it.

Pricing (https://developers.cloudflare.com/workers/platform/pricing/) [READ]: Paid $5/mo min; 10 M requests + 30 M CPU-ms included; $0.30/M requests, $0.02 per extra 1 M CPU-ms. Free: 100k req/day, 10 ms CPU.

### 1.1 Hands-on: 22 MB OCCT WASM in a Worker — [MEASURED]

Prototype in `reference/bench/cf-wasm/` (wrangler 4.166.0, `replicad-opencascadejs` 1.2.1, `replicad`). Files: `wrangler.jsonc`, `src/worker.mjs` (Emscripten glue + replicad), `src/probe.mjs` + `wrangler.probe.jsonc` (raw instantiation probe), `hash/` (password hashing probe).

WASM sizes on disk: `replicad_single.wasm` 22,942,327 B (gzip 7,205,596 B); `replicad_multi.wasm` 22,475,349 B (gzip 7,200,310 B).

1. `npx wrangler deploy --dry-run --outdir dist`:
   ```
   Total Upload: 23266.19 KiB / gzip: 7266.12 KiB
   No bindings found.
   --dry-run: exiting now.
   ```
   -> exit 0. Bundle accepted at 22.7 MiB uncompressed (would have been rejected by the pre-2026-09 10 MB compressed limit; it is 7.1 MB gzip, so it would have passed the old Paid limit anyway, but not the old Free 3 MB).
   The dist contains `worker.js` (882 KB glue+replicad) and the raw `.wasm` as a separate module.

2. `npx wrangler dev` then `GET /`: the module import works, but calling `initOpenCascade()` fails on every request:
   ```
   EvalError: Code generation from strings disallowed for this context
       at new Function (<anonymous>)
       at Ec (.../worker.js:1743:9)        <- embind craftInvokerFunction: `new Function(q, n + "}\n")(...d)`
       ...
       at wasm://wasm/057849de:wasm-function[9333]   <- static constructors registering embind classes
   ```
   The bundled glue has exactly two `new Function` sites (lines 1743 and 2728 of `dist/worker.js`), both from embind; zero `eval`. So the WASM itself compiled and started; the **JS glue** is the blocker.

3. Raw probe (`src/probe.mjs`) results, two runs:
   ```
   {"importCount":65,"importModules":["a"],"memoryImport":[],
    "instantiateMs":7, ... ,
    "compileFromBytes":"CompileError: WebAssembly.compile(): Wasm code generation disallowed by embedder",
    "newFunction":"EvalError: Code generation from strings disallowed for this context",
    "eval":"EvalError: Code generation from strings disallowed for this context"}
   ```
   - Instantiating the already-compiled 22 MB module with stub imports takes 6-7 ms (compile happened at script load).
   - Runtime compile from bytes, `eval` and `new Function` are all disallowed, even in local workerd — consistent with [COMMUNITY] reports: https://community.cloudflare.com/t/evalerror-code-generation-from-strings-disallowed-for-this-context/356430 , https://answeroverflow.com/m/1202287354459721778
   - wrangler dev became ready ~3.7 s after launch (includes wrangler's own boot; not a production startup measurement). `wrangler check startup` result: see section 1.2.

4. Memory [READ from `reference/repos/replicad/packages/replicad-opencascadejs/build-config/custom_build_multi.yml`]: the replicad build uses `-sINITIAL_MEMORY=100MB -sMAXIMUM_MEMORY=4GB -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=8388608`. Against a 128 MB isolate cap that leaves ~28 MB for growth plus the JS heap. [INFERRED] Real models would hit the cap; the runtime then recycles the isolate.

5. Fix path [INFERRED, supported by repo evidence]: rebuild OCCT with Emscripten `-sDYNAMIC_EXECUTION=0` (embind then avoids `new Function`) and a small `INITIAL_MEMORY`. `reference/repos/taucad-opencascade.js` already targets this: `src/ocjs_bindgen/embind_builtins.py:83 "JS body is emitted at link time (CSP-strict / -sDYNAMIC_EXECUTION=0 compatible)"` and `experiments/q67-rbv-cost/build-csp-safe.sh` uses `-sDYNAMIC_EXECUTION=0`. No published npm OCCT build (replicad-opencascadejs, opencascade.js, @bitbybit-dev/occt) advertises this; nobody on forums/GitHub reports running OCCT on Workers (searched 2026-11-21, no hits).

### 1.2 `wrangler check startup` on the 22 MB bundle — [MEASURED]

See appendix A at the bottom (filled from the run).

---

## 2. Python Workers

Sources: https://developers.cloudflare.com/workers/languages/python/ , `.../python/packages/` , `.../python/how-python-workers-work/` , https://developers.cloudflare.com/workers/configuration/compatibility-flags/ , https://blog.cloudflare.com/python-workers-ga/ , https://blog.cloudflare.com/python-workers-advancements/ , workerd `build/python_metadata.bzl` (https://raw.githubusercontent.com/cloudflare/workerd/main/build/python_metadata.bzl). Checked 2026-11-21.

- Status: **GA since 2026-09-21** (blog). [READ]
- Pyodide / Python versions embedded in workerd (python_metadata.bzl) [READ]:
  - `0.26.0a2` — Python 3.12.1, Emscripten 3.1.52, flag `python_workers`
  - `0.28.2` — Python 3.13.2, Emscripten 4.0.9, flag `python_workers_20250116`
  - `314.0.4` — Python 3.14.2, Emscripten 5.0.3, flag `python_workers_20260610`
  - `314.0.6` — Python 3.14.2, Emscripten 5.0.3, flag `python_workers_314` — **default for compatibility dates >= 2026-09-08** (compatibility-flags page)
  - `python_workers_development` tracks 314.0.6.
  - Docs: a new Python each August, matching Pyodide ~6 months later, 5-year support window.
- Packages [READ]: declared in `pyproject.toml`; `uv run pywrangler deploy` vendors them into `python_modules` with uv. Supported: pure-Python packages on PyPI, **PyEmscripten (PEP 783) wheels on PyPI**, and packages bundled in Pyodide. "Any packages with native C/C++/Rust extensions must be cross-compiled to WebAssembly" (GA blog). Docs do not describe vendoring a local `.whl`.
- Cold start [READ, blog 2025-12]: fastapi+httpx+pydantic ~1.03 s mean with deploy-time memory snapshots (~10 s without). Snapshot = linear memory captured after running top-level imports at deploy time.
- Limits: same Worker limits (64 MiB bundle, 128 MB isolate, CPU). No Python-specific limits page. [READ]
- Dynamic Workers accept `{py: string}` modules but "startup is much slower than JavaScript". [READ]

**Can OCP.wasm / build123d run here?** [INFERRED: no]
- `reference/repos/OCP.wasm` (github.com/yeicor/OCP.wasm, HEAD 2026-09-24) builds against `pyodide-xbuildenv==314.0.7` (`requirements.txt`), i.e. the same Python 3.14 / Pyodide 314 line Cloudflare now ships (314.0.6) — ABI could line up. [READ repo]
- But its wheels are **not on PyPI**: `cadquery-ocp-novtk` 8.0.1.1.0 on PyPI has only win/manylinux/macos wheels (checked via PyPI JSON, 2026-11-21) [MEASURED]. OCP.wasm's `bootstrap.py` installs via micropip from its own index. pywrangler has no documented local-wheel path.
- Size/memory: native OCP is 151 MB (`OCP/`) + 230 MB (`cadquery_ocp_novtk.libs`) on Linux; `import build123d` peak RSS 438 MB, a model + STEP/STL export 459 MB (`/usr/bin/time -v`, this machine) [MEASURED]. A wasm port will not fit a 128 MB isolate or (likely) a 64 MiB bundle.

---

## 3. Cloudflare Containers

Sources: https://developers.cloudflare.com/containers/ , `.../containers/platform-details/limits/` (raw `containers/platform/limits/index.md`), `.../containers/pricing/` , `.../containers/platform-details/architecture/` , `.../containers/configuration/scheduling-policy/` , `.../containers/configuration/scaling-and-routing/` , `.../containers/configuration/outbound-traffic/` , `.../containers/guides/local-dev/` , `.../containers/guides/image-management/` , `.../containers/api/durable-object-container/` , changelog https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/ . Checked 2026-11-21.

**Status** [READ]: Containers + Sandboxes **GA on 2026-04-13** (Workers Paid only). Public beta began 2025-06-24. However the scheduling-policy page (checked 2026-11-21) says: `default` policy = **deprecated**; `durable_object` policy = **public beta**. Snapshots = public beta (free during beta). Inbound TCP/gRPC to containers = public beta (2026-11-19).

**Instance types** [READ]:

| Type | vCPU | Memory | Disk |
|---|---|---|---|
| lite (`dev` alias) | 1/16 | 256 MiB | 2 GB |
| basic | 1/4 | 1 GiB | 4 GB |
| standard-1 (`standard` alias) | 1/2 | 4 GiB | 8 GB |
| standard-2 | 1 | 6 GiB | 12 GB |
| standard-3 | 2 | 8 GiB | 16 GB |
| standard-4 | 4 | 12 GiB | 20 GB |

Custom sizes (`durable_object` policy, `ctx.container.start({instance: {vcpu, memoryMib, diskMb}})`): minimum 1/16 vCPU, 256 MiB, 2 GB. Note: with the `durable_object` policy the named `basic`, `dev`, `standard` values are **not accepted** (lite, standard-1..4 or a custom object); `lite` is the default. Changelog 2026-01-05 introduced custom instance types.

**Account limits** [READ]: per instance max 4 vCPU / 12 GiB / 20 GB; concurrent 15,000 vCPU, 60 TiB memory, 300 TB disk (raisable). GA blog: 15,000 concurrent `lite`, 6,000 `basic`, >1,000 larger. `max_instances` exists only for the deprecated `default` policy; with `durable_object` policy running instances just count toward account limits.

**Image limits** [READ]: image size "same as instance disk space" (so up to 20 GB); 50 GB total image storage per account; snapshots max 20 GB, 30-day retention. Images are built by Docker locally and pushed to Cloudflare's R2-backed registry (`wrangler containers build -p`), or (default policy only) pulled from Docker Hub / ECR / GAR. `durable_object` policy requires digest-pinned `registry.cloudflare.com/...@sha256:...` references or the managed `cloudflare/debian-trixie` image (node:24.20.0-trixie-slim).

**Cold start** [READ]: "can often be in the 1-3 second range", depending on image size and entrypoint. Instances start in the nearest location with a pre-fetched image; DO and container are not guaranteed to be co-located. Shutdown: SIGTERM, up to 15 min, then SIGKILL. Disk is ephemeral; snapshots or FUSE-mounted R2 for persistence.

**Pricing** [READ, Workers Paid $5/mo]:
- vCPU: $0.000020 per vCPU-s **active only** (375 vCPU-min/mo included)
- Memory: $0.0000025 per GiB-s provisioned while running (25 GiB-h/mo included)
- Disk: $0.00000007 per GB-s provisioned while running (200 GB-h/mo included)
- Egress: $0.025/GB NA+EU (1 TB incl), $0.05 Oceania/KR/TW, $0.04 elsewhere.
- Billed per 10 ms while running; stops when the instance sleeps.
- [INFERRED] examples: a custom 1/4 vCPU + 1 GiB + 4 GB instance kept running costs ≈ $0.010/h (~$7.5/mo always-on) + CPU when busy (1 h of saturated 1/4 vCPU ≈ $0.018). standard-1 running ≈ $0.038/h (~$28/mo always-on).

**Pairing with Durable Objects** [READ]: a container is addressed only through its DO (`env.MY_CONTAINER.getByName(id)`), `this.ctx.container.start({image, enableInternet, instance, env, entrypoint, containerSnapshot})`, `monitor()`, `getTcpPort(n).fetch()`, `setInactivityTimeout(ms)` (max 6 h; not surviving DO restarts, re-set in the constructor), `exec(argv, {stdin, stdout, stderr, pty, user, signal})` -> `ExecProcess` with `stdout`/`stderr` streams, `output()` (buffers into DO memory, 128 MB cap), `exitCode`, `kill(signal)`. `exec()` has **no built-in timeout** — wrap commands in GNU `timeout --kill-after`. Processes started with `exec()` get only `PATH` from `env`. Use `enable_request_signal` to abort on client disconnect. Patterns: one named DO per user/project (sandbox), or a fixed pool `instance-${random}` for stateless routing.

**Outbound** [READ]: `enableInternet` is required in `start()`; with `false` only HTTP/HTTPS the Worker intercepts (`interceptOutboundHttp(s)`, hostname rules, 128 entries max) can leave; non-HTTP traffic and public DNS are denied. With `true` anything goes except what is intercepted.

**Local dev** [READ]: requires Docker-compatible engine (Docker Desktop, Colima…); `wrangler dev` (>= 4.136.0 for `durable_object` policy; >= 4.141.0 for `cloudflare/debian-trixie` locally) or `vite dev`; images built from a Dockerfile path or pulled; press `r` to rebuild; `max_instances` not enforced locally; deployed processes keep root capabilities even as non-root users. [MEASURED] On this machine `docker` 29.9.3 is installed but the user is not in the `docker` group (`permission denied ... /var/run/docker.sock`), so the container local-dev path was **not** exercised.

**build123d sizing probe** [MEASURED, cgroup via `systemd-run --user -p MemoryMax=…`, this machine's x86 CPU, no CPU cap]:
- MemoryMax=256M: killed (no output) -> `lite` (256 MiB) is too small.
- MemoryMax=512M: box+fillet+6 holes+STEP+STL export OK in 2.98 s (incl. ~2.9 s `import build123d`).
- MemoryMax=1G: OK in 2.84 s.
- Native install footprint: `.venv` 869 MB (OCP 151 MB + libs 230 MB) -> a `python:3.12-slim` + build123d image will be roughly 1.0-1.3 GB [INFERRED]; fits the 2 GB `lite` disk only barely, comfortable on >= 4 GB disk.
- [INFERRED] With 1/16 or 1/4 vCPU the ~3 s import will stretch to 10-50 s unless the interpreter is kept warm (`sleep infinity` entrypoint + `exec` into a long-running Python worker process, or snapshots after import).

---

## 4. Cloudflare Sandbox SDK

Sources: https://developers.cloudflare.com/sandbox/ , `.../sandbox/concepts/` , `.../sandbox/concepts/security/` , `.../sandbox/concepts/lifetime/` , `.../sandbox/reference/` , `.../sandbox/commands/` , `.../sandbox/commands/run-python-code/` , `.../sandbox/network/` , https://blog.cloudflare.com/sandbox-ga/ , npm `@cloudflare/sandbox`. Checked 2026-11-21.

- Status: GA with Containers (2026-04-13). npm `@cloudflare/sandbox` **1.0.3** (published 2026-10-23) [MEASURED `npm view`]. Also `@cloudflare/containers` 0.3.7.
- Two environments [READ]: **Container** (full Linux, for code needing an OS: child processes, servers, compilers) and **Dynamic Worker** (JS/Py/WASM in an isolate, only reaches methods you pass in; `globalOutbound: null` kills `fetch`/`connect`).
- Architecture [READ, reference page]: the package "works with a container you start from a Durable Object. Its classes run helper processes in the running container through `exec()`. The package does not start, stop, or monitor the container." Image requirement: copy `/usr/local/bin/sandbox-shim` from `docker.io/cloudflare/sandbox:<version matching npm>`; example Dockerfile `FROM node:24-trixie-slim` + `COPY --from=docker.io/cloudflare/sandbox:1.0.1 ...` + `sleep infinity`. The "Run Python code" guide uses `FROM python:3.13-slim` + `RUN pip install ...`, runs `python3 -` from stdin wrapped in `timeout 60 --kill-after 5`, with `enableInternet: false`. -> **custom Dockerfiles are the normal path** [READ]; a `python:3.12-slim` + `pip install build123d` image is therefore supported [INFERRED].
- Features [READ, GA blog + docs]: `exec` (buffered or streamed, SSE guides), background processes, PTY terminals over WebSocket, file ops (`Files` class, R2 bucket mounts), preview URLs via `exposePort`, git clone, code interpreter contexts (Python/JS/TS with state), filesystem watch, snapshots/backup-restore (snapshots "rolling out"; stored in R2).
- Isolation [READ security page]: isolation is between sandboxes, not inside one; every process in a deployed sandbox effectively has root; one sandbox per user/job; sandbox name must derive from the authenticated user; treat all output as untrusted. Docs do not name the VM technology. Containers start with `enableInternet:false` by default in sandbox examples; credentials should be injected by outbound intercepts in the Worker.
- Lifetime [READ]: instance runs while the DO is active; `setInactivityTimeout()` up to **6 hours**; without it "Cloudflare stops the instance shortly after the Durable Object becomes inactive"; `monitor()` reports stops only while the DO is in memory (<= 15 min). Deploys don't restart running instances.
- Pricing/limits: same as Containers (the sandbox pages link to Containers pricing/limits). "Active CPU pricing" — idle while waiting on an LLM is not billed for CPU (memory/disk still are while running). [READ]

---

## 5. Durable Objects and the Agents SDK

Sources: https://developers.cloudflare.com/durable-objects/platform/limits/ , `.../durable-objects/platform/pricing/` , `.../durable-objects/concepts/durable-object-lifecycle/` , `.../durable-objects/best-practices/websockets/` , `.../durable-objects/api/websockets/` , https://developers.cloudflare.com/agents/ , `.../agents/platform/limits/` , npm `agents`. Checked 2026-11-21.

Limits [READ]:
- Memory: 128 MB per object (pricing page: "Duration billing charges for the 128 MB of memory your Durable Object is allocated").
- CPU: 30 s per request/WebSocket message/alarm by default; **each incoming HTTP request or WebSocket message resets the budget**; `limits.cpu_ms` up to 300,000 (5 min).
- Wall clock: unlimited while a request, RPC, response stream, WebSocket or pending I/O is in flight. Alarm handlers 15 min.
- Pending operations (outbound `fetch()`, `waitUntil`, timers, TCP sockets, outbound WebSockets, RPC) keep the object in memory **for up to 15 minutes each** from start; a long LLM stream that takes longer than 15 min could see the object evicted [INFERRED]. Eviction after 70-140 s idle (non-hibernatable); hibernation after 10 s idle when nothing pends.
- Storage (SQLite-backed): 10 GB per object, unlimited per account on Paid (5 GB Free); key+value <= 8 MB; row/BLOB <= 8 MB; statement <= 100 KB; 100 columns.
- WebSockets: 32,768 hibernatable connections per object (api/websockets); received message <= 32 MiB; `serializeAttachment` <= 16,384 B; outgoing WebSockets do not hibernate.
- Throughput: single-threaded, soft limit ~1,000 req/s per object; 6 simultaneous outgoing connections; 500 DO classes per account (Paid).
- Outbound request body 100 MiB default.

Pricing [READ]: Paid: 1 M requests + 400,000 GB-s/mo included; $0.15/M requests; $12.50 per M GB-s; rows read 25 B incl then $0.001/M; rows written 50 M incl then $1.00/M; 5 GB-month incl then $0.20/GB-mo (storage billing from 2026-01-07). Duration is wall-clock × 128 MB while active **or idle but unable to hibernate** (e.g. awaiting an LLM `fetch`). WebSocket messages billed 20:1; hibernated time not billed.
- [INFERRED] cost of an agent waiting on an LLM: 0.125 GB × 60 s = 7.5 GB-s ≈ $0.0001 per minute of waiting; 400,000 GB-s included ≈ 889 agent-hours/month free.

Agents SDK [READ]: each Agent = one DO ("preset Durable Object with Lifecycle and capabilities"); capabilities State, WebSockets, Scheduler, MCP client; harnesses Pi / OpenCode / Think (Pi Durable is "experimental"); channels chat/voice/email/Slack/webhooks; tools include sandbox + workspace. Limits page: 1 GB state per agent; 30 s CPU per agent that resets on HTTP/WS message/scheduled task; wall-clock per step unlimited ("so a step can wait on ... an LLM response"). npm `agents` **0.34.0** [MEASURED].

Suitability for a per-project agent loop with WebSocket streaming: good fit [INFERRED from the above]. Keep the LLM tool-call loop in the DO, use hibernatable WebSockets to the browser, call the container DO via RPC for geometry; persist transcripts in DO SQLite or D1.

---

## 6. R2 and D1

Sources: https://developers.cloudflare.com/r2/platform/limits/ , `.../r2/pricing/` , `.../r2/api/s3/presigned-urls/` , `.../r2/api/s3/api/` , https://developers.cloudflare.com/d1/platform/limits/ , `.../d1/platform/pricing/`. Checked 2026-11-21.

R2 [READ]:
- Max object 5 TiB (4.995 TiB multipart); single-part upload 5 GiB; 10,000 parts; metadata 8,192 B; 100,000 buckets default.
- Pricing: $0.015/GB-mo; Class A $4.50/M; Class B $0.36/M; **egress free**; free tier 10 GB-mo, 1 M A, 10 M B.
- Presigned URLs: GET/HEAD/PUT/DELETE supported; POST (HTML form) not; expiry 1 s – 7 days; must be generated with S3 credentials + SigV4 (`aws4fetch` works in a Worker with `nodejs_compat`); the R2 binding cannot generate them; they work only on the S3 API host, not custom domains; bucket CORS required for browser use; `Content-Type` signed must match.
- S3 API implements CreateMultipartUpload / UploadPart / CompleteMultipartUpload. [INFERRED] presigned `UploadPart` works like any SigV4 query-signed request, but the docs don't state it; verify before relying on it.
- Browser STEP import path [INFERRED]: Worker issues a presigned PUT (up to 5 GiB single-part) -> browser PUTs straight to R2 -> Worker/Queue notifies the container to convert. Uploading *through* a Worker is capped by the zone plan body limit (100 MB Free/Pro).

D1 [READ]:
- Max DB size 10 GB (Paid, "cannot be further increased"), 500 MB Free; 1 TB/account; 50,000 DBs incl; row/BLOB <= 2 MB; statement <= 100 KB; 100 bound params; query <= 30 s; result set <= 50 MB (from 2026-11-04); 1,000 queries per invocation (50 Free); single-threaded per DB; Time Travel 30 days (Paid).
- Pricing: 25 B rows read + 50 M rows written + 5 GB included; $0.001/M read, $1.00/M written, $0.75/GB-mo.
- [INFERRED] Keep STEP/GLB in R2, only metadata/version pointers in D1 (2 MB row cap, 10 GB DB cap). Per-project version history could also live in the project's DO SQLite (10 GB per object).

---

## 7. Auth (email + password) on Workers

Sources: https://better-auth.com/docs/guides/cloudflare , Workers limits page, https://developers.cloudflare.com/email-service/ , `.../email-service/platform/limits/` , `.../email-service/platform/pricing/` , `.../email-service/api/send-emails/workers-api/` , https://resend.com/pricing , better-auth source `packages/better-auth/src/crypto/password.ts`. Checked 2026-11-21.

Better Auth on D1 [READ + COMMUNITY]:
- Official Cloudflare guide: needs `nodejs_compat` (default for compatibility dates >= 2026-08-04); `process.env` populated from 2025-04-01; set `advanced.ipAddress.ipAddressHeaders: ["cf-connecting-ip"]`; pass `waitUntil` as `advanced.backgroundTasks.handler`; cannot hold pooled DB clients across requests; KV is unsuitable as `secondaryStorage`.
- No first-party D1 adapter: use `drizzleAdapter(drizzle(env.DB), { provider: "sqlite" })` (drizzle-orm/d1) or Kysely with the community `kysely-d1` dialect; the auth instance must be created per request/lazily because the D1 binding exists only in request context [COMMUNITY: dev.to, answeroverflow threads]. better-auth npm **1.7.27** [MEASURED].
- Hashing: better-auth's `password.ts` imports `hashPassword/verifyPassword` from `@better-auth/utils/password`, which uses `node:crypto` scrypt on Node/Bun/Deno and `@noble/hashes` scrypt elsewhere [READ source]. Which branch Workers' `nodejs_compat` selects depends on export conditions — [UNVERIFIED]; both exist in workerd (`node:crypto` scrypt measured below). Better Auth's default scrypt parameters are not in that file; recalled as N=16384, r=16, p=1, dkLen=64 [UNVERIFIED — check `@better-auth/utils`].

Hashing cost inside workerd [MEASURED, `reference/bench/cf-wasm/hash/`, `wrangler dev`, three runs, this machine's CPU]:

| Algorithm | ms per hash |
|---|---|
| WebCrypto PBKDF2-SHA256, 100k iterations | 42-62 |
| WebCrypto PBKDF2-SHA256, 600k iterations (OWASP) | 242-322 |
| `node:crypto` scrypt N=16384 r=8 p=1 | 28-34 |
| `node:crypto` scrypt N=16384 r=16 p=1 | 56-62 |
| `node:crypto` scrypt N=32768 r=8 p=1 | 59-64 |

- Against limits [READ]: Free plan 10 ms CPU -> **impossible** (matches community "exceeded CPU" reports); Paid 30 s default -> every row above is fine with 2 orders of magnitude of margin. Production Workers CPUs may differ from this laptop; wall-clock vs CPU-time of `node:crypto` scrypt in workerd not separately measured [INFERRED: counted as CPU since workerd has no thread pool offload semantics for billing — verify in Workers Logs].
- Argon2 wasm not measured; it would need a `new Function`-free wasm build (same Workers restriction as above) [INFERRED].

Email sending [READ]:
- Cloudflare **Email Sending is Beta**, Workers Paid only; free to verified destination addresses on any plan. 3,000 emails/mo included then $0.35 per 1,000. Limits: 50 recipients/message, 25 MiB message, 16 KB custom headers, 998-char subject, new accounts start with a "conservative daily quota" that ramps; must send from an onboarded routing domain (30 domains/zone). Binding: `send_email: [{ name: "EMAIL" }]` -> `env.EMAIL.send({to, from, subject, text})`. Also REST and SMTP.
- Resend: free 3,000/mo, 100/day, 3 domains; Pro $20/mo for 50k [READ].
- [INFERRED] Either works for verification/reset mails; Cloudflare's is cheaper at scale but beta with an unspecified daily ramp — risky for a launch burst.

---

## 8. Other Cloudflare primitives for heavy/long work

- **Workflows** [READ https://developers.cloudflare.com/workflows/reference/limits/ , `.../pricing/`]: 10,000 steps default (25,000 max), CPU per step 30 s default / 5 min max, wall-clock per step unlimited, step result 1 MiB, persisted state 1 GB/instance, 50,000 concurrent instances, 300 instances/s; pricing on Workers Standard (10 M requests, 30 M CPU-ms), 500k steps/mo incl then $0.80/100k, 1 GB-mo storage incl. Good for "export all formats, retry, notify" pipelines, not for compute itself.
- **Queues** [READ https://developers.cloudflare.com/queues/platform/limits/]: 128 KB messages, 100/batch, 5,000 msg/s per queue, 25 GB backlog, 14-day retention, consumer wall-clock 15 min, CPU 30 s default/5 min max, 250 concurrent consumers. Use for "model file arrived in R2 -> convert" fan-out.
- **Dynamic Workers** [READ https://developers.cloudflare.com/dynamic-workers/ , `.../api-reference/` , `.../usage/limits/` , `.../platform/limits/`]: `env.LOADER.get(id, () => ({compatibilityDate, mainModule, modules: {"x.js": {js}, "y.py": {py}, "z.wasm": {wasm: ArrayBuffer}}, globalOutbound}))`; per-load `cpuMs`/`subRequests` caps; 4 distinct dynamic Workers in flight per Worker request, 10 per DO; Durable Object Facets give each sandbox its own SQLite. Pricing page is empty (307 B) as of 2026-11-21. Good for running the AI's *orchestration* snippets (Code Mode) against a narrow tool API, not for OCCT.
- **Workers AI**: irrelevant (user brings their own OpenAI-compatible LLM).
- **Cron Triggers**: 15 min CPU for >= 1 h intervals (Paid) — maintenance only.

---

## 9. Where geometry execution should live — recommendation

1. **Container per project (or small pool)**, `durable_object` scheduling policy, custom instance ≈ 1/4-1/2 vCPU + 1 GiB (not `lite`), image `python:3.12-slim` + `build123d` (+ `sandbox-shim` if using `@cloudflare/sandbox`), entrypoint `sleep infinity`, and a long-lived Python worker process started via `exec` that keeps `build123d` imported (avoids the ~3 s import per job). `enableInternet: false`. Wrap each job in `timeout`. Stream stdout/stderr back through the DO to the browser WebSocket. Write STEP/STL/GLB to R2 (via an intercepted HTTPS host or by returning bytes through the DO; mind the 128 MB DO memory and 100 MiB outbound body).
2. **Agent loop** in a Durable Object (Agents SDK), hibernatable WebSocket to the React client; LLM calls are plain `fetch` (wall-clock free, each pending op <= 15 min).
3. **Metadata/versioning** in D1 (or the project DO's SQLite), **files** in R2, **browser STEP import** via presigned PUT.
4. **Workers-side OCCT WASM** only as a later optimization once a `-sDYNAMIC_EXECUTION=0`, low-initial-memory OCCT build exists (taucad-opencascade.js is heading there); it would give ~0 cold start for small parts but is bounded by 128 MB.
5. Keep **localhost** parity: `wrangler dev` runs Worker + DO + container locally with Docker (user must be in the `docker` group on this machine).

## 10. Risks / unknowns

- `durable_object` scheduling policy (the one you need for sandboxes/snapshots/custom instance sizes) is still **public beta**; the GA `default` policy is deprecated. API churn likely.
- Cold start = 1-3 s container + Python import (~3 s at full CPU, much more at 1/16-1/4 vCPU) unless kept warm; keeping warm costs ~$7-28/month per always-on instance.
- DO and container may be in different locations; the browser <-> DO <-> container hop adds latency.
- Output path sizes: DO memory 128 MB and 100 MiB outbound body limit — large STEP/GLB should go container -> R2 directly (intercepted host) rather than through `output()`.
- Email Sending is beta with an undocumented daily ramp; Resend is the safer launch fallback.
- Better Auth on D1 is a community pattern (Drizzle/Kysely), not an official adapter; per-request auth instance construction required.
- Not measured: production Worker startup validation for a 22 MB WASM bundle (needs a deploy), production CPU speed for hashing, actual container cold starts, Docker-based local dev (no docker group), presigned multipart `UploadPart`.
- Stale docs exist (Agents limits page still says 10 MB scripts; some third-party pages still cite 3/10 MB compressed) — always re-check the limits pages.

---

## Appendix A — `wrangler check startup` output (local, 22 MB bundle)

`npx wrangler check startup` in `reference/bench/cf-wasm/` (2026-11-21) [MEASURED]:

```
│ Bundle: 23266.19 KiB / gzip: 7270.24 KiB
│ Local startup profile:
│   Profile window: 93.3 ms
│   Sampled time: 80.4 ms
│   Active: 69.3 ms (including 0.0 ms garbage collection)
│   Idle: 11.1 ms
│   Samples: 53
│ CPU Profile has been written to worker-startup.cpuprofile.
│ Note that the CPU Profile was measured on your Worker running locally ... should not be expected to exactly match what your Worker's startup time will be when deploying to Cloudflare.
```

Reading: with the 22 MB module imported at top level but `initOpenCascade()` deferred to the first request, local global-scope startup is ~70 ms active, far under the 1 s production limit. [INFERRED] V8 compiles the module lazily/in tiers, so the real production validation (which runs on Cloudflare's CPUs and may include compile time) is the unknown; it needs an actual `wrangler deploy` to confirm. Repro: `cd reference/bench/cf-wasm && npm install && npm run dryrun && npm run dev` (then `curl localhost:8787/`), `npx wrangler dev -c wrangler.probe.jsonc` for the raw probe, `cd hash && npx wrangler dev` for the hashing probe.
