// opencascade.js 2.0.0-beta.b5ff984 (donalffons) full build, Node 22.  Run: node bench.mjs
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runBench } from "./bench-core.mjs";
const OUT = dirname(fileURLToPath(import.meta.url));
const t0 = performance.now();
const initOpenCascade = (await import("opencascade.js/dist/node.js")).default;
const oc = await initOpenCascade();
const wasm_load_ms = +(performance.now() - t0).toFixed(1);
const r = await runBench(oc, { label: "opencascade.js 2.0.0-beta.b5ff984 (full, OCCT 7.6.x-dev 2022-04)", outDir: OUT, tag: "ocjs" });
console.log(JSON.stringify({ wasm_load_ms, ...r }, null, 2));
