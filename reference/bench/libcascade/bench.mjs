// libcascade 3.1.0 (taucad fork of opencascade.js, OCCT 8.0.1) single-threaded, Node 22.  Run: node bench.mjs
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runBench } from "../opencascadejs/bench-core.mjs";
const OUT = dirname(fileURLToPath(import.meta.url));
const t0 = performance.now();
const { createInstance } = await import("libcascade/single/init");
const oc = await createInstance();
const wasm_load_ms = +(performance.now() - t0).toFixed(1);
const r = await runBench(oc, { label: "libcascade 3.1.0 single (OCCT 8.0.1)", outDir: OUT, tag: "libcascade" });
console.log(JSON.stringify({ wasm_load_ms, ...r }, null, 2));
