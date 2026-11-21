// Smoke test for @bitbybit-dev/occt 1.7.0 in Node 22: wasm load time, then the same benchmark part
// built through bitbybit's high-level services (DTO-style API).  Run: node smoke.mjs
import { createRequire } from "node:module";
import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const OUT = dirname(fileURLToPath(import.meta.url));
const now = () => performance.now();

const t0 = now();
const initOpenCascade = (await import("@bitbybit-dev/occt/bitbybit-dev-occt/index.js")).default;
const { OccHelper } = await import("@bitbybit-dev/occt/lib/occ-helper.js");
const { OCCTService } = await import("@bitbybit-dev/occt/lib/occ-service.js");
const kernelDir = dirname(require.resolve("@bitbybit-dev/occt/bitbybit-dev-occt/index.js"));
const wasmPath = join(kernelDir, readdirSync(kernelDir).find((f) => f.endsWith(".wasm")));
const occ = await initOpenCascade({ locateFile: (p) => (p.endsWith(".wasm") ? wasmPath : p) });
const helper = new OccHelper(occ);
const occt = new OCCTService(occ, helper);
const wasm_load_ms = +(now() - t0).toFixed(1);

const tB = now();
const { shapes, booleans, fillets, io } = occt;
// bitbybit is Y-up (Babylon convention): createBox width=X, height=Y, length=Z. Build the part with Y as "up".
let plate = shapes.solid.createBox({ width: 60, height: 5, length: 40, center: [0, 2.5, 0] });
// chamfer top outer edges: edges whose centre of mass lies at y=5 (bitbybit selects edges by index)
const plateEdges = shapes.edge.getEdges({ shape: plate });
const topIdx = plateEdges.map((e, i) => [shapes.edge.getEdgeCenterOfMass({ shape: e })[1], i]).filter(([y]) => Math.abs(y - 5) < 1e-6).map(([, i]) => i);
plate = fillets.chamferEdges({ shape: plate, distance: 0.5, indexes: topIdx });
const boss = shapes.solid.createCylinder({ radius: 10, height: 15, center: [0, 5, 0], direction: [0, 1, 0] });
let part = booleans.union({ shapes: [plate, boss], keepEdges: false });
const edges = shapes.edge.getEdges({ shape: part });
const junction = edges.map((e, i) => [e, i]).filter(([e]) => {
  const c = shapes.edge.getEdgeCenterOfMass({ shape: e });
  const len = shapes.edge.getEdgeLength({ shape: e });
  return Math.abs(c[1] - 5) < 1e-6 && Math.abs(len - 2 * Math.PI * 10) < 1e-3;
}).map(([, i]) => i);
part = fillets.filletEdges({ shape: part, radius: 2, indexes: junction });
const tools = [];
for (const x of [-24, 24]) for (const z of [-14, 14]) tools.push(shapes.solid.createCylinder({ radius: 2.5, height: 5, center: [x, 0, z], direction: [0, 1, 0] }));
tools.push(shapes.solid.createCylinder({ radius: 4, height: 20, center: [0, 0, 0], direction: [0, 1, 0] }));
part = booleans.difference({ shape: part, shapes: tools, keepEdges: false });
const build_ms = +(now() - tB).toFixed(1);

const volume = shapes.solid.getSolidVolume({ shape: part });
const faces = shapes.face.getFaces({ shape: part }).length;
const step = io.saveShapeSTEP({ shape: part, fileName: "bench_bitbybit.step", adjustYtoZ: false, tryDownload: false });
writeFileSync(join(OUT, "bench_bitbybit.step"), step);
const tM = now();
const mesh = occt.shapeToMesh({ shape: part, precision: 0.01, adjustYtoZ: false });
const mesh_ms = +(now() - tM).toFixed(1);
const tI = now();
const shifted = occt.transforms.translate({ shape: part, translation: [10, 0, 0] });
const inter = booleans.intersection({ shapes: [part, shifted], keepEdges: false });
const intersect_volume = shapes.solid.getSolidVolume({ shape: inter });
const intersect_ms = +(now() - tI).toFixed(1);

console.log("edges selected: chamfer", topIdx, "fillet", junction);
console.log(JSON.stringify({
  kernel: "@bitbybit-dev/occt 1.7.0 (32-bit single-thread build, OCCT 8.0.1 fork)",
  wasm_load_ms, build_ms, mesh_ms, intersect_ms,
  volume: +volume.toFixed(4), faces, intersect_volume: +intersect_volume.toFixed(4),
  mesh_faces: mesh?.faceList?.length ?? null, mesh_edges: mesh?.edgeList?.length ?? null, mesh_keys: Object.keys(mesh ?? {}),
  step_bytes: step.length,
  peak_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024),
}, null, 2));
