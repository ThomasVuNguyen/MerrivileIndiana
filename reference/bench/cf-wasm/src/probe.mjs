// Probe 2: time pure WebAssembly instantiation of the precompiled 22 MB module with stub imports,
// and check whether runtime compilation from bytes is allowed in workerd.
import occWasm from "../node_modules/replicad-opencascadejs/dist/replicad_single.wasm";
export default {
  async fetch(request) {
    const out = {};
    const imps = WebAssembly.Module.imports(occWasm);
    out.importCount = imps.length;
    out.importModules = [...new Set(imps.map(i => i.module))];
    out.memoryImport = imps.filter(i => i.kind === "memory").map(i => `${i.module}.${i.name}`);
    out.exportsSample = WebAssembly.Module.exports(occWasm).slice(0, 8).map(e => e.name);
    // Stub imports: every function becomes a no-op; memory/table provided if imported.
    const importObject = {};
    for (const i of imps) {
      importObject[i.module] ??= {};
      if (i.kind === "function") importObject[i.module][i.name] = () => 0;
      else if (i.kind === "memory") importObject[i.module][i.name] = new WebAssembly.Memory({ initial: 256, maximum: 2048 });
      else if (i.kind === "table") importObject[i.module][i.name] = new WebAssembly.Table({ initial: 0, element: "anyfunc" });
      else if (i.kind === "global") importObject[i.module][i.name] = new WebAssembly.Global({ value: "i32", mutable: false }, 0);
    }
    let t = performance.now();
    try {
      const inst = await WebAssembly.instantiate(occWasm, importObject);
      out.instantiateMs = Math.round(performance.now() - t);
      const mem = inst.exports.memory;
      out.exportedMemoryPages = mem ? mem.buffer.byteLength / 65536 : null;
      out.exportedMemoryMiB = mem ? Math.round(mem.buffer.byteLength / 1048576) : null;
      // Try to grow linear memory to see where the 128 MB isolate limit bites (local workerd may not enforce).
      try { const before = mem.buffer.byteLength; mem.grow(1024); out.grewTo_MiB = Math.round(mem.buffer.byteLength / 1048576); out.grewFrom_MiB = Math.round(before/1048576);} catch (e) { out.growError = String(e); }
    } catch (e) { out.instantiateError = String(e); }
    // Runtime compile from bytes
    t = performance.now();
    try {
      const tiny = new Uint8Array([0,97,115,109,1,0,0,0]);
      await WebAssembly.compile(tiny);
      out.compileFromBytes = "allowed (local workerd)";
    } catch (e) { out.compileFromBytes = String(e); }
    try { new Function("return 1")(); out.newFunction = "allowed"; } catch (e) { out.newFunction = String(e); }
    try { eval("1+1"); out.eval = "allowed"; } catch (e) { out.eval = String(e); }
    return Response.json(out);
  }
};
