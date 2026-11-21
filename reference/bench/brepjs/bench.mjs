// Benchmark part in brepjs. KERNEL=occt-wasm (default) or KERNEL=brepkit
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
const KERNEL = process.env.KERNEL || 'occt-wasm';
const t0 = performance.now();
const brep = await import('brepjs');
const { box, cylinder, shape, exportSTEP, exportSTL, unwrap, mesh: meshShape, meshEdges: meshShapeEdges, registerKernel, isOk, edgeFinder, curveStartPoint, curveEndPoint } = brep;
const zOf = (p) => (Array.isArray(p) ? p[2] : (p.z ?? p[2]));
const atZ = (z) => (e) => Math.abs(zOf(curveStartPoint(e)) - z) < 1e-6 && Math.abs(zOf(curveEndPoint(e)) - z) < 1e-6;
let kernelId;
if (KERNEL === 'brepkit') {
  const bk = await import('brepkit-wasm');
  if (typeof bk.default === 'function') { try { await bk.default(); } catch (e) { console.log('brepkit default init:', e.message); } }
  const BrepKernel = bk.BrepKernel;
  registerKernel('brepkit', new brep.BrepkitAdapter(new BrepKernel()));
  kernelId = 'brepkit';
} else {
  kernelId = await brep.init();
}
const tLoad = performance.now() - t0;
console.log(`kernel=${kernelId} load+init ${tLoad.toFixed(1)} ms, rss ${(process.memoryUsage().rss/1e6).toFixed(0)} MB`);

function build({ withChamfer = true, withFillet = true } = {}) {
  let plate = shape(box(60, 40, 5));
  if (withChamfer) plate = plate.chamfer(edgeFinder().when(atZ(5)), 0.5);
  const boss = cylinder(10, 15, { at: [30, 20, 5] });
  let part = plate.fuse(boss);
  if (withFillet) part = part.fillet(edgeFinder().ofCurveType('CIRCLE').when(atZ(5)), 2);
  const holes = [[6, 6], [54, 6], [6, 34], [54, 34]].map(([x, y]) => cylinder(2.5, 5, { at: [x, y, 0] }));
  part = part.cutAll([...holes, cylinder(4, 20, { at: [30, 20, 0] })]);
  return part.val;
}

function run(label, opts) {
  try {
    const t1 = performance.now();
    const part = build(opts);
    const vol = shape(part).volume();
    const tBuild = performance.now() - t1;
    const t2 = performance.now();
    const shifted = shape(part).translate([10, 0, 0]).val;
    const inter = shape(part).intersect(shifted).val;
    const ivol = shape(inter).volume();
    const tInter = performance.now() - t2;
    const faces = brep.getFaces ? brep.getFaces(part).length : '?';
    console.log(`${label}: build ${tBuild.toFixed(1)} ms, volume ${vol.toFixed(4)} mm^3, intersection ${ivol.toFixed(4)} mm^3 (${tInter.toFixed(1)} ms), faces ${faces}`);
    return part;
  } catch (e) {
    console.log(`${label}: FAILED: ${e.message}`);
    return null;
  }
}

const part = run('full (chamfer+fillet)') || run('no fillet', { withFillet: false }) || run('plain', { withFillet: false, withChamfer: false });
if (part) {
  let t = performance.now();
  const m = meshShape(part, { tolerance: 0.01, angularTolerance: 0.2 });
  console.log(`mesh: ${m.vertices.length / 3} verts, ${m.triangles.length / 3} tris, faceGroups ${m.faceGroups.length} (${(performance.now() - t).toFixed(1)} ms)`);
  t = performance.now();
  const em = meshShapeEdges(part, { tolerance: 0.01 });
  console.log(`edges: ${em.edgeGroups.length} edgeGroups (${(performance.now() - t).toFixed(1)} ms)`);
  t = performance.now();
  const stepRes = exportSTEP(part);
  if (isOk(stepRes)) {
    const buf = Buffer.from(await stepRes.value.arrayBuffer());
    writeFileSync(new URL(`./bench_${kernelId}.step`, import.meta.url), buf);
    console.log(`STEP export: ${buf.length} bytes (${(performance.now() - t).toFixed(1)} ms)`);
  } else console.log('STEP export failed:', stepRes.error.message);
  t = performance.now();
  const stlRes = exportSTL(part, { tolerance: 0.01, angularTolerance: 0.2, binary: true });
  if (isOk(stlRes)) {
    const buf = Buffer.from(await stlRes.value.arrayBuffer());
    writeFileSync(new URL(`./bench_${kernelId}.stl`, import.meta.url), buf);
    console.log(`STL export: ${buf.length} bytes (${(performance.now() - t).toFixed(1)} ms)`);
  } else console.log('STL export failed:', stlRes.error.message);
  // round-trip import
  try {
    t = performance.now();
    const imported = await brep.importSTEP(stepRes.value);
    console.log(`STEP re-import: ${isOk(imported) ? 'ok, volume ' + shape(imported.value).volume().toFixed(4) : 'failed ' + imported.error.message} (${(performance.now() - t).toFixed(1)} ms)`);
  } catch (e) { console.log('STEP re-import threw:', e.message); }
}
console.log(`total wall ${(performance.now() - t0).toFixed(1)} ms, rss ${(process.memoryUsage().rss/1e6).toFixed(0)} MB`);
