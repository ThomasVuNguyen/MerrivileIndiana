// Benchmark part in replicad 1.2.1 (replicad-opencascadejs 1.2.1 wasm) under Node 22.
// Run: node bench.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = dirname(fileURLToPath(import.meta.url));
const now = () => performance.now();

// ---- 1. load wasm -------------------------------------------------------
const tLoad0 = now();
const opencascade = (await import("replicad-opencascadejs")).default;
const replicad = await import("replicad");
const { setOC, getOC, makeBaseBox, makeCylinder, measureVolume } = replicad;
const oc = await opencascade();
setOC(oc);
const tLoad = now() - tLoad0;

// ---- 2. build the part --------------------------------------------------
function build() {
  // 60x40x5 plate, centred in XY, bottom at z=0
  let plate = makeBaseBox(60, 40, 5);
  // 0.5 mm chamfer on the 4 top outer edges (edges lying in the z=5 plane)
  plate = plate.chamfer(0.5, (e) => e.inPlane("XY", 5));
  // D20 x 15 boss standing on the plate (z=5..20), like the build123d baseline
  let part = plate.fuse(makeCylinder(10, 15, [0, 0, 5]));
  // 2 mm fillet at the boss/plate junction: the circular edge of radius 10 at z=5
  part = part.fillet(2, (e) =>
    e.ofCurveType("CIRCLE").inPlane("XY", 5).ofLength(2 * Math.PI * 10)
  );
  // 4 x D5 through holes, 6 mm in from each corner
  for (const x of [-24, 24])
    for (const y of [-14, 14]) part = part.cut(makeCylinder(2.5, 5, [x, y, 0]));
  // D8 through bore (plate + boss)
  part = part.cut(makeCylinder(4, 20, [0, 0, 0]));
  return part;
}

const tBuild0 = now();
const part = build();
const tBuild = now() - tBuild0;

const volume = measureVolume(part);
const nFaces = part.faces.length;
const nEdges = part.edges.length;
const analyzer = new (getOC().BRepCheck_Analyzer)(part.wrapped, true, false);
const valid = (analyzer.IsValid_2 ?? analyzer.IsValid).call(analyzer);

// ---- 3. export ----------------------------------------------------------
const tStep0 = now();
const stepBlob = part.blobSTEP();
const stepText = Buffer.from(await stepBlob.arrayBuffer());
writeFileSync(join(OUT, "bench_replicad.step"), stepText);
const tStep = now() - tStep0;

const tStl0 = now();
const stlBlob = part.blobSTL({ tolerance: 0.01, angularTolerance: 0.2 });
writeFileSync(join(OUT, "bench_replicad.stl"), Buffer.from(await stlBlob.arrayBuffer()));
const tStl = now() - tStl0;

// mesh with face ids + edges with edge ids (what the viewer would consume)
const tMesh0 = now();
const mesh = part.mesh({ tolerance: 0.01, angularTolerance: 0.2 });
const edges = part.meshEdges({ tolerance: 0.01, angularTolerance: 0.2 });
const tMesh = now() - tMesh0;

// ---- 4. interference volume --------------------------------------------
const tInter0 = now();
const shifted = part.clone().translate(10, 0, 0);
const inter = part.intersect(shifted);
const interVolume = measureVolume(inter);
const tInter = now() - tInter0;

const ru = process.resourceUsage();
console.log(JSON.stringify({
  kernel: "replicad 1.2.1 / replicad-opencascadejs 1.2.1",
  wasm_load_ms: +tLoad.toFixed(1),
  build_ms: +tBuild.toFixed(1),
  step_export_ms: +tStep.toFixed(1),
  stl_export_ms: +tStl.toFixed(1),
  mesh_ms: +tMesh.toFixed(1),
  intersect_ms: +tInter.toFixed(1),
  volume: +volume.toFixed(4),
  faces: nFaces,
  edges: nEdges,
  valid,
  intersect_volume: +interVolume.toFixed(4),
  mesh_vertices: mesh.vertices.length / 3,
  mesh_triangles: mesh.triangles.length / 3,
  mesh_face_groups: mesh.faceGroups.length,
  mesh_edge_groups: edges.edgeGroups.length,
  step_bytes: stepText.length,
  peak_rss_mb: Math.round(ru.maxRSS / 1024),
  rss_now_mb: Math.round(process.memoryUsage().rss / 1048576),
  wasm_heap_mb: Math.round((oc.HEAPU8?.length ?? oc.wasmMemory?.buffer.byteLength ?? 0) / 1048576),
}, null, 2));
