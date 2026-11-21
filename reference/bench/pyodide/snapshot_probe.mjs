// Can a Pyodide memory snapshot skip the 17 s `import build123d`? (experimental API, Pyodide >= 0.27)
import { loadPyodide } from "pyodide";
import fs from "node:fs";
const t = (l, t0) => console.log(`[t] ${l}: ${(performance.now() - t0).toFixed(0)} ms`);
let t0 = performance.now();
let py;
try {
  py = await loadPyodide({ _makeSnapshot: true });
  t("loadPyodide(_makeSnapshot)", t0);
  await py.loadPackage("micropip");
  py.FS.writeFile("/bootstrap.py", fs.readFileSync("../../repos/OCP.wasm/build123d/bootstrap.py", "utf8"));
  await py.runPythonAsync(`import sys; sys.path.insert(0,"/"); import bootstrap; await bootstrap.bootstrap(build123d_ref="0.13.0")`);
  t0 = performance.now(); py.runPython("import build123d"); t("import build123d", t0);
  t0 = performance.now();
  const snap = py.makeMemorySnapshot();
  t("makeMemorySnapshot", t0);
  fs.writeFileSync("/tmp/b123d.snap", Buffer.from(snap));
  console.log(`[snap] ${(snap.byteLength / 1048576).toFixed(0)} MB`);
} catch (e) { console.log("SNAPSHOT MAKE ERROR:", String(e.message || e).slice(0, 1500)); process.exit(1); }
try {
  t0 = performance.now();
  const py2 = await loadPyodide({ _loadSnapshot: fs.readFileSync("/tmp/b123d.snap") });
  t("loadPyodide(_loadSnapshot)", t0);
  t0 = performance.now();
  console.log(py2.runPython("import build123d; from build123d import Box; str(Box(1,2,3).volume)"));
  t("Box volume after snapshot restore", t0);
} catch (e) { console.log("SNAPSHOT LOAD ERROR:", String(e.message || e).slice(0, 1500)); }
