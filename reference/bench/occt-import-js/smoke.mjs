// occt-import-js 0.0.23 in Node 22: wasm load time + read the replicad-produced STEP of the benchmark part.
// Shows what the viewer gets back: one mesh per *shape* (not per face), with face ranges in `brep_faces`.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const now = () => performance.now();

const t0 = now();
const occtimportjs = require("occt-import-js");
const occt = await occtimportjs();
const wasm_load_ms = +(now() - t0).toFixed(1);

const buf = readFileSync(new URL("../replicad/bench_replicad.step", import.meta.url));
const t1 = now();
const res = occt.ReadStepFile(new Uint8Array(buf), { linearDeflectionType: "absolute_value", linearDeflection: 0.01, angularDeflection: 0.2 });
const read_ms = +(now() - t1).toFixed(1);
const m = res.meshes[0];
console.log(JSON.stringify({
  kernel: "occt-import-js 0.0.23 (OCCT 7.6.1)",
  wasm_load_ms, read_ms, success: res.success,
  meshes: res.meshes.length,
  vertices: m.attributes.position.array.length / 3,
  triangles: m.index.array.length / 3,
  brep_faces: m.brep_faces?.length,
  first_brep_face: m.brep_faces?.[0],
  mesh_keys: Object.keys(m),
  peak_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024),
}, null, 2));
