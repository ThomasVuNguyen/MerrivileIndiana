// Benchmark part in Manifold (mesh CSG). No fillet/chamfer support -> plain variant only.
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
const t0 = performance.now();
const Module = (await import('manifold-3d')).default;
const wasm = await Module();
wasm.setup();
const { Manifold } = wasm;
const tLoad = performance.now() - t0;

function build(segments) {
  const plate = Manifold.cube([60, 40, 5], true).translate([0, 0, 2.5]);
  const boss = Manifold.cylinder(15, 10, 10, segments).translate([0, 0, 5]);
  let part = plate.add(boss);
  const holes = [];
  for (const x of [-24, 24]) for (const y of [-14, 14]) holes.push(Manifold.cylinder(5, 2.5, 2.5, segments).translate([x, y, 0]));
  const bore = Manifold.cylinder(20, 4, 4, segments);
  part = Manifold.difference(part, Manifold.union([...holes, bore]));
  return part;
}

for (const segments of [32, 64, 128, 256]) {
  const t1 = performance.now();
  const part = build(segments);
  const vol = part.volume();
  const tBuild = performance.now() - t1;
  const t2 = performance.now();
  const shifted = part.translate([10, 0, 0]);
  const inter = Manifold.intersection(part, shifted);
  const ivol = inter.volume();
  const tInter = performance.now() - t2;
  const m = part.getMesh();
  console.log(`segments=${segments}: build ${tBuild.toFixed(1)} ms, volume ${vol.toFixed(3)} mm^3, intersection ${ivol.toFixed(3)} mm^3 (${tInter.toFixed(1)} ms), tris ${m.numTri}, verts ${m.numVert}, faceIDs(runOriginalID)=${m.runOriginalID?.length}`);
  if (segments === 128) {
    // write binary STL
    const tri = m.triVerts, v = m.vertProperties, n = m.numTri;
    const buf = Buffer.alloc(84 + n * 50); buf.writeUInt32LE(n, 80);
    for (let i = 0; i < n; i++) { const o = 84 + i * 50 + 12; for (let k = 0; k < 3; k++) { const vi = tri[i*3+k]; buf.writeFloatLE(v[vi*3], o + k*12); buf.writeFloatLE(v[vi*3+1], o + k*12 + 4); buf.writeFloatLE(v[vi*3+2], o + k*12 + 8); } }
    writeFileSync(new URL('./bench_manifold.stl', import.meta.url), buf);
  }
}
console.log(`wasm load+init: ${tLoad.toFixed(1)} ms`);
console.log('analytic plain volume:', (60*40*5 - 4*Math.PI*2.5**2*5 + Math.PI*100*15 - Math.PI*16*20).toFixed(3));
