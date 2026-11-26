"""Files the geometry service keeps between requests, on local disk.

- Components' BREPs by the SHA-256 of their bytes, so a 20 MB vendor board isn't resent with every
  build, inspect or assembly check. The Worker sends hashes; a request that names a BREP this
  container doesn't have answers {"ok": false, "need": [hash, ...]} and the Worker uploads them
  (POST /cache/<hash>) and asks again.
- Outputs too big for a JSON reply (an imported component's BREP and viewer mesh, assembly STEP
  exports), fetched once by the Worker (GET /cache/<name>) and streamed into R2.

Oldest files go first when the cache passes LIMIT bytes.
"""

from __future__ import annotations

import hashlib
import os
import re
import tempfile

DIR = os.environ.get("MERRIVILE_CACHE", os.path.join(tempfile.gettempdir(), "merrivile-cache"))
LIMIT = 3 * 1024**3
NAME = re.compile(r"^[0-9a-f]{64}(\.[a-z0-9.]+)?$|^out-[0-9a-f]{32}\.[a-z0-9.]+$")

os.makedirs(DIR, exist_ok=True)


def path(name: str) -> str:
    if not NAME.match(name):
        raise ValueError(f"bad cache name {name!r}")
    return os.path.join(DIR, name)


def has(name: str) -> bool:
    p = path(name)
    if os.path.exists(p):
        os.utime(p)  # recently used: kept longer
        return True
    return False


def missing(hashes) -> list[str]:
    return [h for h in dict.fromkeys(hashes) if not has(f"{h}.brep")]


def put_stream(name: str, stream, length: int, expect_hash: str | None = None) -> None:
    """Write `length` bytes from `stream`; with expect_hash, refuse bytes whose SHA-256 differs."""
    fd, tmp = tempfile.mkstemp(dir=DIR, prefix=".in-")
    digest = hashlib.sha256()
    try:
        with os.fdopen(fd, "wb") as f:
            left = length
            while left:
                chunk = stream.read(min(left, 1 << 20))
                if not chunk:
                    raise ValueError("body ended early")
                digest.update(chunk)
                f.write(chunk)
                left -= len(chunk)
        if expect_hash and digest.hexdigest() != expect_hash:
            raise ValueError("the bytes don't match the hash")
        os.replace(tmp, path(name))
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    evict()


def put_file(src: str) -> str:
    """Move a finished BREP into the cache under its hash; returns the hash."""
    digest = hashlib.sha256()
    with open(src, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    h = digest.hexdigest()
    os.replace(src, path(f"{h}.brep"))
    evict()
    return h


def output(ext: str) -> str:
    """A fresh path for an output the Worker will fetch once."""
    return path(f"out-{os.urandom(16).hex()}.{ext}")


def evict() -> None:
    files = []
    for n in os.listdir(DIR):
        p = os.path.join(DIR, n)
        if n.startswith(".in-") or not os.path.isfile(p):
            continue
        st = os.stat(p)
        files.append((st.st_atime if n.startswith("out-") else st.st_mtime, st.st_size, p))
    total = sum(s for _, s, _ in files)
    for _, size, p in sorted(files):
        if total <= LIMIT:
            break
        os.unlink(p)
        total -= size
