// Measure password-hash CPU cost inside workerd: WebCrypto PBKDF2 and node:crypto scrypt.
import { scrypt as nodeScrypt } from "node:crypto";
async function pbkdf2(iter) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("correct horse battery staple"), "PBKDF2", false, ["deriveBits"]);
  const t = performance.now();
  await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: crypto.getRandomValues(new Uint8Array(16)), iterations: iter }, key, 256);
  return performance.now() - t;
}
function scrypt(N, r, p) {
  return new Promise((res, rej) => {
    const t = performance.now();
    nodeScrypt("correct horse battery staple", crypto.getRandomValues(new Uint8Array(16)), 64, { N, r, p, maxmem: 128 * 1024 * 1024 }, (e) => e ? rej(e) : res(performance.now() - t));
  });
}
export default {
  async fetch(request) {
    const out = {};
    try { out.pbkdf2_100k_ms = await pbkdf2(100_000); } catch (e) { out.pbkdf2_100k = String(e); }
    try { out.pbkdf2_600k_ms = await pbkdf2(600_000); } catch (e) { out.pbkdf2_600k = String(e); }
    try { out.scrypt_N16384_r8_p1_ms = await scrypt(16384, 8, 1); } catch (e) { out.scrypt_16384_8 = String(e); }
    try { out.scrypt_N16384_r16_p1_ms_betterauth_default = await scrypt(16384, 16, 1); } catch (e) { out.scrypt_16384_16 = String(e); }
    try { out.scrypt_N32768_r8_p1_ms = await scrypt(32768, 8, 1); } catch (e) { out.scrypt_32768_8 = String(e); }
    return Response.json(out);
  }
};
