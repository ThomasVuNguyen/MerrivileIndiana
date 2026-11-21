// Headless Chromium run of index.html via Playwright. Serves this folder on a local port.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srv = http.createServer((req, res) => {
  const f = path.join(here, req.url === "/" ? "index.html" : req.url.split("?")[0]);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": f.endsWith(".html") ? "text/html" : "text/plain" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(8765, r));

const browser = await chromium.launch({ args: ["--enable-precise-memory-info"] });
const ctx = await browser.newContext();
const page = await ctx.newPage();
let bytes = 0; const big = [];
page.on("response", async (r) => {
  try { const h = r.headers()["content-length"]; const n = Number(h || 0); bytes += n; if (n > 500000) big.push([r.url().split("/").pop().slice(0, 90), n]); } catch {}
});
page.on("console", (m) => { const s = m.text(); if (/^\[|^ERROR|^\{|^\}|^ "/.test(s)) process.stdout.write(s + "\n"); });
const t0 = Date.now();
await page.goto("http://localhost:8765/");
await page.waitForFunction(() => window.__done === true, null, { timeout: 600000 });
console.log(`[browser] wall total ${(Date.now() - t0) / 1000}s`);
console.log(`[browser] network bytes (content-length sum, compressed on the wire): ${(bytes / 1048576).toFixed(1)} MB`);
for (const [n, l] of big.sort((a, b) => b[1] - a[1])) console.log(`   ${(l / 1048576).toFixed(1).padStart(6)} MB ${n}`);
const session = await ctx.newCDPSession(page);
const pm = await session.send("Performance.getMetrics");
for (const m of pm.metrics) if (/JSHeapUsedSize|JSHeapTotalSize/.test(m.name)) console.log(`[browser] ${m.name}: ${(m.value / 1048576).toFixed(0)} MB`);
await browser.close();
srv.close();
