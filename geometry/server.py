"""Geometry service: POST /build runs a build123d script and returns the part; POST /inspect runs
analysis code over a project's parts (measurements, checks, custom renders in part colours,
section cuts); POST /image/crop
crops a picture for the shop; POST /image/preview makes a JPEG preview (HEIC too);
POST /video/frames and /video/copy read a video sent as the raw body; POST /convert turns a
spreadsheet or document (raw body) into text; POST /python runs AI-written Python over files.
POST /component reads a vendor STEP (raw body) into a component; POST /assembly places an assembly's
instances from their snaps, checks clashes, gaps and alignment, renders and exports it; POST /guide
checks a guide's sampled motions for clashes along the way and draws a sheet of its steps.

The script gets asset(name) for files sent alongside it (an imported STEP), part(id) for the
project's other parts, sent as their sources, and component(id) for vendor components, sent as the
hashes of BREPs this service keeps (geometry/cache.py): a request naming one it doesn't have
answers {"ok": false, "need": [hash, ...]}; POST /cache/<hash> uploads it (raw body) and GET
/cache/<name> fetches outputs too big for JSON (a component's BREP and mesh, STEP exports).

Locally the Worker calls this over HTTP; on Cloudflare the same process runs
inside a Container next to the project's Durable Object.

    .venv/bin/python -m geometry.server --port 8790
"""

from __future__ import annotations

import os

# One BLAS thread: forked, memory-limited children can't start OpenBLAS's thread pool and hang in
# the first big matrix product (a vendor board's mesh); these jobs are small and one per process.
for _var in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

import argparse
import base64
import json
import shutil
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from geometry import cache, images, office, runner, sandbox, video

MAX_BODY = 64 * 1024 * 1024
MAX_VIDEO = 5 * 1024**3
# Reported by /health so a deploy can check the container runs the new image.
VERSION = "2026-11-27.guides2"


class Handler(BaseHTTPRequestHandler):
    server_version = "merrivile-geometry/0.1"

    def do_GET(self) -> None:
        if self.path == "/health":
            return self._json(200, {"ok": True, "version": VERSION})
        if self.path.startswith("/cache/"):
            return self._cache_get(self.path[len("/cache/") :])
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path in ("/image/crop", "/image/preview"):
            return self._image(self.path)
        if self.path in ("/video/frames", "/video/copy", "/convert", "/component"):
            return self._raw(self.path)
        if self.path == "/python":
            return self._python()
        if self.path == "/inspect":
            return self._inspect()
        if self.path in ("/assembly", "/guide"):
            return self._assembly(self.path)
        if self.path.startswith("/cache/"):
            return self._cache_put(self.path[len("/cache/") :])
        if self.path != "/build":
            return self._json(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._json(413, {"error": "body must be 1 byte to 64 MiB"})
        try:
            body = json.loads(self.rfile.read(length))
            source = body["source"]
            timeout = float(body.get("timeout", 60))
            assets = {str(k): base64.b64decode(v) for k, v in (body.get("assets") or {}).items()}
            parts = {str(k): str(v) for k, v in (body.get("parts") or {}).items()}
            part_id = str(body["id"]) if body.get("id") else None
            bodies = max(int(body["bodies"]), 1) if body.get("bodies") is not None else None
            components = _components(body)
        except (ValueError, KeyError, TypeError, AttributeError):
            return self._json(400, {"error": "expected JSON {source, id?, parts?, assets?, components?, bodies?, timeout?}"})
        if not isinstance(source, str):
            return self._json(400, {"error": "source must be a string"})
        if need := cache.missing(c["hash"] for c in components.values()):
            return self._json(200, {"ok": False, "need": need})
        self._json(200, runner.build(source, min(max(timeout, 1.0), 300.0), assets, parts, part_id, bodies, components))

    def _inspect(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._json(413, {"error": "body must be 1 byte to 64 MiB"})
        try:
            body = json.loads(self.rfile.read(length))
            code = body["code"]
            timeout = min(max(float(body.get("timeout", 120)), 1.0), 300.0)
            assets = {str(k): base64.b64decode(v) for k, v in (body.get("assets") or {}).items()}
            parts = {str(k): str(v) for k, v in (body.get("parts") or {}).items()}
            views, size = body.get("views"), int(body.get("size", 420))
            colors = {str(k): str(v) for k, v in (body.get("colors") or {}).items()}
            section = body.get("section")
            if section is not None and not isinstance(section, dict):
                raise TypeError("section")
            components = _components(body)
            assemblies = dict(body.get("assemblies") or {})
        except (ValueError, KeyError, TypeError, AttributeError):
            return self._json(400, {"error": "expected JSON {code, parts?, assets?, components?, assemblies?, views?, size?, colors?, section?, timeout?}"})
        if need := cache.missing(c["hash"] for c in components.values()):
            return self._json(200, {"ok": False, "need": need})
        self._json(200, runner.inspect(code, timeout, assets, parts, views, size, colors, section, components, assemblies))

    def _assembly(self, path: str) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._json(413, {"error": "body must be 1 byte to 64 MiB"})
        try:
            job = json.loads(self.rfile.read(length))
            job["components"] = _components(job)
            timeout = min(max(float(job.get("timeout", 120)), 1.0), 300.0)
        except (ValueError, KeyError, TypeError, AttributeError):
            return self._json(400, {"error": "expected JSON {spec | leaves, catalog, parts?, components?, previous?, check?, render?, export?, sheet?, timeout?}"})
        if need := cache.missing(c["hash"] for c in job["components"].values()):
            return self._json(200, {"ok": False, "need": need})
        self._json(200, runner.guide(job, timeout) if path == "/guide" else runner.assembly(job, timeout))

    def _cache_put(self, name: str) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_VIDEO:
            return self._json(413, {"error": "body must be 1 byte to 5 GiB"})
        h = name.removesuffix(".brep")
        try:
            cache.put_stream(f"{h}.brep", self.rfile, length, expect_hash=h)
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        self._json(200, {"ok": True})

    def _cache_get(self, name: str) -> None:
        try:
            path = cache.path(name)
        except ValueError:
            return self._json(400, {"error": "bad name"})
        if not os.path.exists(path):
            return self._json(404, {"error": "not in the cache (it may have been evicted)"})
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(os.path.getsize(path)))
        self.end_headers()
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile, 1 << 20)
        if name.startswith("out-"):  # outputs are fetched once
            os.unlink(path)

    def _image(self, path: str) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._json(413, {"error": "body must be 1 byte to 64 MiB"})
        try:
            body = json.loads(self.rfile.read(length))
            data = base64.b64decode(body["image"])
            result = images.preview(data) if path == "/image/preview" else images.crop(data, body.get("box"), int(body.get("size", 512)))
        except Exception as exc:  # bad image, bad box
            return self._json(200, {"ok": False, "error": str(exc)})
        self._json(200, result)

    def _python(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._json(413, {"error": "body must be 1 byte to 64 MiB"})
        try:
            body = json.loads(self.rfile.read(length))
            files = {str(k): base64.b64decode(v) for k, v in (body.get("files") or {}).items()}
            timeout = min(max(float(body.get("timeout", 120)), 1.0), 300.0)
            code = body["code"]
        except (ValueError, KeyError, TypeError, AttributeError):
            return self._json(400, {"error": "expected JSON {code, files?, timeout?}"})
        out = sandbox.run(code, files, timeout)
        out["files"] = {k: base64.b64encode(v).decode() for k, v in out["files"].items()}
        self._json(200, out)

    def _raw(self, path: str) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_VIDEO:
            return self._json(413, {"error": "body must be 1 byte to 5 GiB"})
        ext = (self.headers.get("X-Ext") or "").lower()
        fd, src = tempfile.mkstemp(suffix="." + (ext or "bin"))
        try:
            with os.fdopen(fd, "wb") as f:
                left = length
                while left:
                    chunk = self.rfile.read(min(left, 1 << 20))
                    if not chunk:
                        return self._json(400, {"error": "body ended early"})
                    f.write(chunk)
                    left -= len(chunk)
            if path == "/component":
                return self._json(200, runner.import_component(src))
            if path == "/convert":
                try:
                    return self._json(200, {"ok": True, "text": office.convert(src, ext)})
                except Exception as exc:  # corrupt, encrypted or not really that format
                    return self._json(200, {"ok": False, "error": str(exc) or type(exc).__name__})
            if path == "/video/frames":
                try:
                    out = video.frames(src, ext)
                except (ValueError, subprocess.TimeoutExpired) as exc:
                    return self._json(200, {"ok": False, "error": str(exc) or "could not read this video"})
                out["poster"] = base64.b64encode(out["poster"]).decode()
                out["sheet"] = base64.b64encode(out["sheet"]).decode()
                return self._json(200, out)
            try:
                copy = video.web_copy(src)
            except (ValueError, subprocess.TimeoutExpired) as exc:
                return self._json(422, {"error": str(exc) or "conversion failed"})
            try:
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", str(os.path.getsize(copy)))
                self.end_headers()
                with open(copy, "rb") as f:
                    shutil.copyfileobj(f, self.wfile, 1 << 20)
            finally:
                os.unlink(copy)
        finally:
            os.unlink(src)

    def _json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("geometry: " + fmt % args + "\n")


def _components(body: dict) -> dict:
    """{id: {hash, names?}} from a request; hashes are hex SHA-256 of the BREP."""
    out = {}
    for cid, c in (body.get("components") or {}).items():
        h = str(c["hash"])
        cache.path(f"{h}.brep")  # validates the hash
        out[str(cid)] = {"hash": h, "names": [str(n) for n in (c.get("names") or [])]}
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8790)
    args = parser.parse_args()
    # Warm the forkserver now so the first build doesn't pay for the import.
    runner.build("from build123d import Box\nresult = Box(1, 1, 1)", timeout=120)
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"geometry service on http://{args.host}:{args.port}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
