// Minimal-download variant: install only the OCP.wasm wheels + build123d and stub the heavy
// optional deps (threejs-materials 85 MB, ipython, scikit-learn, sympy) with micropip mocks and
// tiny stub modules. Measures download size, wasm heap and timings for the benchmark part.
import { loadPyodide } from "pyodide";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const t = (label, t0) => console.log(`[t] ${label}: ${(performance.now() - t0).toFixed(0)} ms`);
let py = null;
const mem = (label) => {
  const m = process.memoryUsage();
  const heap = py ? (py._module.HEAPU8.length / 1048576).toFixed(0) : "?";
  console.log(`[mem] ${label}: wasmHEAP=${heap} MB rss=${(m.rss / 1048576).toFixed(0)} MB`);
};
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

let t0 = performance.now();
py = await loadPyodide();
t("loadPyodide", t0);
await py.loadPackage("micropip");
mem("after pyodide+micropip");

t0 = performance.now();
try {
  await py.runPythonAsync(`
import micropip, sys, types
# --- stubs for heavy deps that build123d imports at module level but we never call ---
stub_threejs = types.ModuleType("threejs_materials")
class PbrProperties: ...
def inject_materials(*a, **k): raise NotImplementedError("threejs_materials stubbed")
stub_threejs.PbrProperties = PbrProperties; stub_threejs.inject_materials = inject_materials
sys.modules["threejs_materials"] = stub_threejs
sk = types.ModuleType("sklearn"); skc = types.ModuleType("sklearn.cluster")
class DBSCAN:
    def __init__(self,*a,**k): raise NotImplementedError("sklearn stubbed")
skc.DBSCAN = DBSCAN; sk.cluster = skc
sys.modules["sklearn"] = sk; sys.modules["sklearn.cluster"] = skc
ip = types.ModuleType("IPython"); ipd = types.ModuleType("IPython.display")
class HTML:
    def __init__(self,*a,**k): pass
ipd.HTML = HTML; ip.display = ipd
ipl = types.ModuleType("IPython.lib"); ipp = types.ModuleType("IPython.lib.pretty")
class RepresentationPrinter:
    def __init__(self,*a,**k): pass
def pretty(obj, *a, **k): return repr(obj)
ipp.RepresentationPrinter = RepresentationPrinter; ipp.pretty = pretty; ipl.pretty = ipp; ip.lib = ipl
ip.__path__ = []; ipl.__path__ = []
sys.modules["IPython"] = ip; sys.modules["IPython.display"] = ipd; sys.modules["IPython.lib"] = ipl; sys.modules["IPython.lib.pretty"] = ipp

# 1. real OCP.wasm wheels first
await micropip.install([
  "https://files.pythonhosted.org/packages/0b/84/74f748a3232155a19f09c74cdf7f19cb07623542c48c01a8d06b4f98c836/cadquery_ocp_novtk_ocp_wasm-8.0.1.1.post202609241841-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
  "https://files.pythonhosted.org/packages/ff/dd/7c2d59e69c65810627dc1aae48ebf9be3f34c189e74c4a30e44f0bcb3c57/lib3mf_ocp_wasm-2.5.0.post202609241713-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
])
# 2. mocks so build123d's requirements resolve without downloading the heavy packages
mocks = [("threejs-materials","1.2.5"),("ipython","9.0.0"),("scikit-learn","1.8.0"),("sympy","1.14.0"),
         ("cadquery-ocp","8.0.1.1"),("cadquery-ocp-novtk","8.0.1.1"),("lib3mf","2.5.0"),("py-lib3mf","2.5.0")]
for name, ver in mocks:
    micropip.add_mock_package(name, ver)
await micropip.install("build123d==0.13.0")
for name, _ in mocks:
    try: micropip.remove_mock_package(name)
    except Exception: pass
for m in ("lib3mf", "requests", "sympy"):
    sys.modules.pop(m, None)
`);
} catch (e) { console.log("INSTALL ERROR:", String(e.message).slice(0, 3000)); process.exit(1); }
t("install (OCP.wasm wheels + build123d, heavy deps mocked)", t0);
mem("after install");
console.log(`[dl] total: ${(downloaded / 1048576).toFixed(1)} MB`);
for (const [n, l] of dl.sort((a, b) => b[1] - a[1])) if (l > 50000) console.log(`   ${(l / 1048576).toFixed(2).padStart(7)} MB  ${n}`);

t0 = performance.now();
try { py.runPython(`import OCP`); } catch (e) { console.log("IMPORT OCP ERROR:", String(e.message).slice(0, 2000)); process.exit(1); }
t("import OCP", t0);
mem("after import OCP");
t0 = performance.now();
try { py.runPython(`import build123d`); } catch (e) { console.log("IMPORT build123d ERROR:", String(e.message).slice(0, 3000)); process.exit(1); }
t("import build123d", t0);
mem("after import build123d");

py.FS.writeFile("/bench_part.py", fs.readFileSync(path.join(here, "..", "native", "bench_part.py"), "utf8"));
py.FS.mkdirTree("/out");
for (let i = 0; i < 3; i++) {
  t0 = performance.now();
  const res = py.runPython(`
import json, sys
sys.path.insert(0, "/")
import bench_part
json.dumps(bench_part.main("/out"))
`);
  t(`bench_part.main run ${i + 1}`, t0);
  if (i === 0) console.log(res);
}
mem("end");

// --- accounting: which Pyodide-distributed packages were loaded (served from CDN on a first visit) ---
const lock = JSON.parse(fs.readFileSync(path.join(here, "node_modules", "pyodide", "pyodide-lock.json"), "utf8"));
const loaded = py.loadedPackages;
let cdnBytes = 0;
const rows = [];
for (const name of Object.keys(loaded)) {
  const p = lock.packages[name] || lock.packages[name.toLowerCase()] || lock.packages[name.replace(/-/g, "_")];
  if (p && loaded[name] === "default channel") { rows.push([name, p.file_name]); }
}
// sizes: look at the cached wheel files in node_modules/pyodide
for (const [name, file] of rows) {
  try { const st = fs.statSync(path.join(here, "node_modules", "pyodide", file)); cdnBytes += st.size; console.log(`   [cdn] ${(st.size / 1048576).toFixed(2).padStart(7)} MB  ${file}`); } catch {}
}
console.log(`[dl] pyodide-CDN packages (cached locally this run, fetched on first visit): ${(cdnBytes / 1048576).toFixed(1)} MB`);
console.log(`[dl] pyodide core (pyodide.asm.wasm + python_stdlib.zip): ${((fs.statSync(path.join(here, "node_modules/pyodide/pyodide.asm.wasm")).size + fs.statSync(path.join(here, "node_modules/pyodide/python_stdlib.zip")).size) / 1048576).toFixed(1)} MB`);
// uncompressed size of the OCP extension inside the virtual FS
let total = 0;
const walk = (d) => { for (const n of py.FS.readdir(d)) { if (n === "." || n === "..") continue; const p2 = d + "/" + n; const st = py.FS.stat(p2); if (py.FS.isDir(st.mode)) walk(p2); else total += st.size; } };
walk("/lib/python3.14/site-packages/OCP"); console.log(`[fs] OCP package uncompressed: ${(total / 1048576).toFixed(1)} MB`);
total = 0; walk("/lib/python3.14/site-packages"); console.log(`[fs] all site-packages uncompressed: ${(total / 1048576).toFixed(1)} MB`);
