// Prototype: can a ~22 MB OCCT (replicad-opencascadejs) WASM module run in a Cloudflare Worker?
// Run: npm install && npm run dryrun (size check) && npm run dev (then curl localhost:8787/).
// Result 2026-11-21: bundle accepted (23 MiB < 64 MiB), module instantiates, but Emscripten embind glue
// throws "EvalError: Code generation from strings disallowed" (new Function) -> needs a -sDYNAMIC_EXECUTION=0 build.
// Minimal probe: import the ~22 MB replicad OCCT WASM as a module and
// instantiate it via the Emscripten glue inside a Worker.
import occWasm from "../node_modules/replicad-opencascadejs/dist/replicad_single.wasm";
import initOpenCascade from "replicad-opencascadejs";
import { setOC, drawCircle } from "replicad";

let ocPromise = null;
function getOC() {
  if (!ocPromise) {
    ocPromise = initOpenCascade({
      // Emscripten hook: hand it the already-compiled module.
      instantiateWasm: (imports, cb) => {
        WebAssembly.instantiate(occWasm, imports).then((inst) => cb(inst));
        return {};
      },
      locateFile: (f) => f,
    });
  }
  return ocPromise;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/mem") {
      return Response.json({ wasmModuleType: typeof occWasm, imports: WebAssembly.Module.imports(occWasm).length, exports: WebAssembly.Module.exports(occWasm).length });
    }
    const t0 = Date.now();
    try {
      const oc = await getOC();
      setOC(oc);
      const t1 = Date.now();
      const r = Number(url.searchParams.get("r") ?? 10);
      const shape = drawCircle(r).sketchOnPlane("XY").extrude(2 * r);
      const mesh = shape.mesh({ tolerance: 0.1, angularTolerance: 0.3 });
      const stl = shape.blobSTL ? "blobSTL available" : "no blobSTL";
      const t2 = Date.now();
      return Response.json({ ok: true, initMs: t1 - t0, modelMs: t2 - t1, triangles: mesh.triangles.length / 3, vertices: mesh.vertices.length / 3, stl });
    } catch (e) {
      return Response.json({ ok: false, error: String(e && e.stack || e), afterMs: Date.now() - t0 }, { status: 500 });
    }
  },
};
