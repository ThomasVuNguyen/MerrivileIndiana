// Variant/timing diagnostics for brepjs kernels. KERNEL=occt-wasm|brepkit
import { performance } from 'node:perf_hooks';
const KERNEL = process.env.KERNEL || 'occt-wasm';
const brep = await import('brepjs');
const { box, cylinder, shape, registerKernel, edgeFinder, curveStartPoint, curveEndPoint, isValidSolid } = brep;
if (KERNEL === 'brepkit') { const bk = await import('brepkit-wasm'); registerKernel('brepkit', new brep.BrepkitAdapter(new bk.BrepKernel())); } else await brep.init();
const atZ = (z) => (e) => Math.abs(curveStartPoint(e)[2] - z) < 1e-6 && Math.abs(curveEndPoint(e)[2] - z) < 1e-6;
function build({ withChamfer = true, withFillet = true } = {}) {
  let plate = shape(box(60, 40, 5));
  if (withChamfer) plate = plate.chamfer(edgeFinder().when(atZ(5)), 0.5);
  let part = plate.fuse(cylinder(10, 15, { at: [30, 20, 5] }));
  if (withFillet) part = part.fillet(edgeFinder().ofCurveType('CIRCLE').when(atZ(5)), 2);
  const holes = [[6, 6], [54, 6], [6, 34], [54, 34]].map(([x, y]) => cylinder(2.5, 5, { at: [x, y, 0] }));
  return part.cutAll([...holes, cylinder(4, 20, { at: [30, 20, 0] })]).val;
}
for (const [label, opts] of [['plain', { withChamfer: false, withFillet: false }], ['chamfer only', { withFillet: false }], ['fillet only', { withChamfer: false }], ['full', {}]]) {
  const part = build(opts);
  const shifted = shape(part).translate([10, 0, 0]).val;
  const inter = shape(part).intersect(shifted).val;
  const faces = brep.getFaces(inter).length;
  const valid = typeof isValidSolid === 'function' ? isValidSolid(inter) : '?';
  console.log(`${KERNEL} ${label}: volume ${shape(part).volume().toFixed(4)}, intersection ${shape(inter).volume().toFixed(4)} (faces ${faces}, validSolid ${valid}), fuse-check: part∪shifted ${shape(part).fuse(shifted).volume().toFixed(4)}`);
}
const tb = [], ti = [];
for (let i = 0; i < 5; i++) {
  let t = performance.now(); const part = build(); tb.push(performance.now() - t);
  t = performance.now(); shape(part).intersect(shape(part).translate([10, 0, 0]).val).volume(); ti.push(performance.now() - t);
}
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`${KERNEL} timings over 5 runs: build ${tb.map(x => x.toFixed(0)).join('/')} ms (median ${med(tb).toFixed(0)}), intersection ${ti.map(x => x.toFixed(0)).join('/')} ms (median ${med(ti).toFixed(0)})`);
