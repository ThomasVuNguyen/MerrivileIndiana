import { loadPyodide } from "pyodide";
import fs from "node:fs";
const py = await loadPyodide();
await py.loadPackage("micropip");
py.FS.writeFile("/bootstrap.py", fs.readFileSync("../../repos/OCP.wasm/build123d/bootstrap.py","utf8"));
try {
  await py.runPythonAsync(`
import logging, sys
logging.basicConfig(level=logging.INFO, stream=sys.stdout)
sys.path.insert(0, "/")
import bootstrap
print([n for n in dir(bootstrap) if not n.startswith('_')])
await bootstrap.install_build123d()
`);
} catch (e) { console.log("ERROR:", String(e.message).slice(0, 3000)); }
