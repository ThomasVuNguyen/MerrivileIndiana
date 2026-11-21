// Benchmark part written against the raw embind OCCT API.
// Shared by opencascade.js 2.0-beta (donalffons, suffixed overloads such as gp_Pnt_3)
// and libcascade 3.x (taucad, suffix-free overloads). `C`/`S` pick the suffixed symbol
// when it exists, else the bare one, so the same ~110 lines of modelling code run on both.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runBench(oc, { label, outDir, tag }) {
  const now = () => performance.now();
  const C = (name, idx) => oc[`${name}_${idx}`] ?? oc[name];                 // class ctor
  const S = (cls, name, idx) => (oc[cls][`${name}_${idx}`] ?? oc[cls][name]).bind(oc[cls]); // static
  const M = (obj, name, idx, ...a) => (obj[`${name}_${idx}`] ?? obj[name]).call(obj, ...a);  // method
  const progress = () => new (C("Message_ProgressRange", 1))();
  const pnt = (x, y, z) => new (C("gp_Pnt", 3))(x, y, z);
  const dirZ = () => new (C("gp_Dir", 4))(0, 0, 1);
  const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE, FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE, SHAPE = oc.TopAbs_ShapeEnum.TopAbs_SHAPE;

  const explore = (shape, type, cast) => {
    const out = [];
    const ex = new (C("TopExp_Explorer", 2))(shape, type, SHAPE);
    for (; ex.More(); ex.Next()) out.push(cast(ex.Current()));
    return out;
  };
  const edgesOf = (s) => explore(s, EDGE, (x) => S("TopoDS", "Edge", 1)(x));
  const facesOf = (s) => explore(s, FACE, (x) => S("TopoDS", "Face", 1)(x));
  const cylinder = (r, h, x = 0, y = 0, z = 0) =>
    new (C("BRepPrimAPI_MakeCylinder", 3))(new (C("gp_Ax2", 3))(pnt(x, y, z), dirZ()), r, h).Shape();
  const fuse = (a, b) => new (C("BRepAlgoAPI_Fuse", 3))(a, b, progress()).Shape();
  const cut = (a, b) => new (C("BRepAlgoAPI_Cut", 3))(a, b, progress()).Shape();
  const common = (a, b) => new (C("BRepAlgoAPI_Common", 3))(a, b, progress()).Shape();
  const volume = (s) => {
    const p = new (C("GProp_GProps", 1))();
    S("BRepGProp", "VolumeProperties", 1)(s, p, false, false, false);
    return p.Mass();
  };

  function build() {
    // 60x40x5 plate centred in XY, bottom at z=0
    let plate = new (C("BRepPrimAPI_MakeBox", 3))(pnt(-30, -20, 0), 60, 40, 5).Shape();
    // 0.5 mm chamfer on the 4 top outer edges: linear edges with both ends at z=5
    const chamfer = new (C("BRepFilletAPI_MakeChamfer", 1))(plate);
    for (const e of edgesOf(plate)) {
      const c = new (C("BRepAdaptor_Curve", 2))(e);
      if (c.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) continue;
      const p0 = c.Value(c.FirstParameter()), p1 = c.Value(c.LastParameter());
      if (Math.abs(p0.Z() - 5) < 1e-6 && Math.abs(p1.Z() - 5) < 1e-6) M(chamfer, "Add", 2, 0.5, e);
    }
    plate = chamfer.Shape();
    // D20 x 15 boss standing on the plate (z=5..20), fused
    let part = fuse(plate, cylinder(10, 15, 0, 0, 5));
    // 2 mm fillet at boss/plate junction: circular edge r=10 at z=5
    const fillet = new (C("BRepFilletAPI_MakeFillet", 1))(part, oc.ChFi3d_FilletShape.ChFi3d_Rational);
    for (const e of edgesOf(part)) {
      const c = new (C("BRepAdaptor_Curve", 2))(e);
      if (c.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Circle) continue;
      const circ = c.Circle();
      if (Math.abs(circ.Radius() - 10) < 1e-6 && Math.abs(circ.Location().Z() - 5) < 1e-6) M(fillet, "Add", 2, 2, e);
    }
    part = fillet.Shape();
    // 4 x D5 through holes, 6 mm in from each corner
    for (const x of [-24, 24]) for (const y of [-14, 14]) part = cut(part, cylinder(2.5, 5, x, y, 0));
    // D8 through bore (plate + boss)
    part = cut(part, cylinder(4, 20));
    return part;
  }

  const tBuild0 = now();
  const part = build();
  const tBuild = now() - tBuild0;
  const vol = volume(part);
  const faces = facesOf(part);
  // unique edges (explorer repeats shared ones); libcascade 3.1 does not bind TopTools_IndexedMapOfShape
  const uniq = [];
  for (const e of edgesOf(part)) if (!uniq.some((u) => u.IsSame(e))) uniq.push(e);
  const nEdges = uniq.length;
  const analyzer = new (C("BRepCheck_Analyzer", 1))(part, true, false);
  const valid = M(analyzer, "IsValid", 2);

  // STEP export via the emscripten virtual FS
  const tStep0 = now();
  const writer = new (C("STEPControl_Writer", 1))();
  writer.Transfer(part, oc.STEPControl_StepModelType.STEPControl_AsIs, true, progress());
  writer.Write(`${tag}.step`);
  const stepText = oc.FS.readFile(`${tag}.step`, { encoding: "utf8" });
  writeFileSync(join(outDir, `bench_${tag}.step`), stepText);
  const tStep = now() - tStep0;

  // Mesh (with per-face triangle groups) + STL
  const tMesh0 = now();
  new (C("BRepMesh_IncrementalMesh", 2))(part, 0.01, false, 0.2, false);
  let nVerts = 0, nTris = 0;
  const faceGroups = [];
  faces.forEach((f, i) => {
    const loc = new (C("TopLoc_Location", 1))();
    const tri = M(oc.BRep_Tool, "Triangulation", 1, f, loc, 0);
    if (!tri || (tri.IsNull && tri.IsNull())) return;
    const t = tri.get ? tri.get() : tri;          // Handle<> in 2.0-beta, direct object in libcascade 3
    faceGroups.push({ faceId: i, start: nTris, count: t.NbTriangles() });
    nVerts += t.NbNodes(); nTris += t.NbTriangles();
  });
  const tMesh = now() - tMesh0;
  const tStl0 = now();
  const stl = new (C("StlAPI_Writer", 1))();
  stl.Write(part, `${tag}.stl`, progress());
  writeFileSync(join(outDir, `bench_${tag}.stl`), oc.FS.readFile(`${tag}.stl`));
  const tStl = now() - tStl0;

  // Interference volume with a copy shifted +10 in X
  const tInter0 = now();
  const trsf = new (C("gp_Trsf", 1))();
  M(trsf, "SetTranslation", 1, new (C("gp_Vec", 4))(10, 0, 0));
  const shifted = new (C("BRepBuilderAPI_Transform", 2))(part, trsf, true).Shape();
  const interVol = volume(common(part, shifted));
  const tInter = now() - tInter0;

  const ru = process.resourceUsage();
  return {
    kernel: label,
    build_ms: +tBuild.toFixed(1), step_export_ms: +tStep.toFixed(1), stl_export_ms: +tStl.toFixed(1),
    mesh_ms: +tMesh.toFixed(1), intersect_ms: +tInter.toFixed(1),
    volume: +vol.toFixed(4), faces: faces.length, edges: nEdges, valid,
    intersect_volume: +interVol.toFixed(4),
    mesh_vertices: nVerts, mesh_triangles: nTris, mesh_face_groups: faceGroups.length,
    step_bytes: stepText.length,
    peak_rss_mb: Math.round(ru.maxRSS / 1024),
    rss_now_mb: Math.round(process.memoryUsage().rss / 1048576),
    wasm_heap_mb: Math.round((oc.HEAPU8?.length ?? oc.wasmMemory?.buffer.byteLength ?? 0) / 1048576),
  };
}
