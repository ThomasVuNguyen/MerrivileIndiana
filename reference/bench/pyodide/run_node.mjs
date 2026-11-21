// Run the build123d benchmark part under Pyodide in Node 22 using OCP.wasm wheels.
// Usage: node run_node.mjs [--local]   (--local: use wheels cached in ./wheels via a file server)
import { loadPyodide } from "pyodide";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const t = (label, t0) => console.log(`[t] ${label}: ${(performance.now() - t0).toFixed(0)} ms`);
let pyRef = null;
const mem = (label) => {
  const m = process.memoryUsage();
  if (pyRef) console.log(`[wasm] ${label}: HEAP=${(pyRef._module.HEAPU8.length / 1048576).toFixed(0)} MB`);
  console.log(`[mem] ${label}: rss=${(m.rss / 1048576).toFixed(0)} MB heapUsed=${(m.heapUsed / 1048576).toFixed(0)} MB external=${(m.external / 1048576).toFixed(0)} MB arrayBuffers=${(m.arrayBuffers / 1048576).toFixed(0)} MB`);
};

// Track downloads (sizes) by wrapping fetch.
let downloaded = 0;
const dl = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const r = await realFetch(url, opts);
  const len = Number(r.headers.get("content-length") || 0);
  downloaded += len;
  dl.push([String(url && url.url ? url.url : url).split("/").pop().slice(0, 100), len]);
  return r;
};

mem("start");
let t0 = performance.now();
const py = await loadPyodide();
pyRef = py;
t("loadPyodide", t0);
mem("after loadPyodide");

t0 = performance.now();
await py.loadPackage("micropip");
t("loadPackage(micropip)", t0);

// OCP.wasm bootstrap script (from the cloned repo)
const bootstrap = fs.readFileSync(path.join(here, "..", "..", "repos", "OCP.wasm", "build123d", "bootstrap.py"), "utf8");
py.FS.writeFile("/bootstrap.py", bootstrap);

t0 = performance.now();
try {
await py.runPythonAsync(`
import logging, sys
logging.basicConfig(level=logging.INFO, stream=sys.stdout)
sys.path.insert(0, "/")
import bootstrap
await bootstrap.bootstrap(build123d_ref="0.13.0")
`);
} catch (e) { console.log("BOOTSTRAP ERROR:", String(e.message).slice(0, 4000)); process.exit(1); }
t("bootstrap.install_build123d (download+install wheels)", t0);
mem("after install");
console.log(`[dl] total content-length bytes: ${downloaded} (${(downloaded / 1048576).toFixed(1)} MB)`);
for (const [n, l] of dl) if (l > 100000) console.log(`   ${(l / 1048576).toFixed(1).padStart(6)} MB  ${n}`);

t0 = performance.now();
py.runPython(`import OCP`);
t("import OCP", t0);
mem("after import OCP");
t0 = performance.now();
py.runPython(`import build123d`);
t("import build123d", t0);
mem("after import build123d");

const bench = fs.readFileSync(path.join(here, "..", "native", "bench_part.py"), "utf8");
py.FS.writeFile("/bench_part.py", bench);
py.FS.mkdirTree("/out");
t0 = performance.now();
const res = py.runPython(`
import json, sys
sys.path.insert(0, "/")
import bench_part
json.dumps(bench_part.main("/out"), indent=2)
`);
t("bench_part.main (build+vol+intersect+step+tess+stl)", t0);
console.log(res);
mem("after bench");
const step = py.FS.readFile("/out/bench_part.step");
fs.writeFileSync(path.join(here, "bench_part.pyodide.step"), step);
console.log(`STEP written: ${step.length} bytes -> bench_part.pyodide.step`);
// second run to measure warm build time
t0 = performance.now();
py.runPython(`bench_part.main("/out")`);
t("bench_part.main second run (warm)", t0);
mem("end");
