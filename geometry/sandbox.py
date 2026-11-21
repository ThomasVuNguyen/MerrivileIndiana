"""Runs AI-written Python over the person's files, in a fresh directory, with limits.
The container has no internet; files saved in out/ go back to the caller."""

from __future__ import annotations

import os
import resource
import shutil
import subprocess
import sys
import tempfile

STDOUT = 20_000
STDERR = 6_000
OUT_FILES = 12
OUT_BYTES = 30 * 1024 * 1024


def _limits() -> None:
    resource.setrlimit(resource.RLIMIT_AS, (3 << 30, 3 << 30))
    resource.setrlimit(resource.RLIMIT_FSIZE, (500 << 20, 500 << 20))


def _tail(data: bytes, limit: int) -> str:
    text = data.decode(errors="replace")
    return text if len(text) <= limit else f"… [first {len(text) - limit} characters cut]\n" + text[-limit:]


def run(code: str, files: dict[str, bytes], timeout: float = 120) -> dict:
    work = tempfile.mkdtemp(prefix="py-")
    try:
        os.makedirs(os.path.join(work, "out"))
        for name, data in files.items():
            with open(os.path.join(work, os.path.basename(name) or "file"), "wb") as f:
                f.write(data)
        with open(os.path.join(work, "main.py"), "w") as f:
            f.write(code)
        env = {"PATH": os.environ.get("PATH", ""), "HOME": work, "MPLBACKEND": "Agg", "PYTHONDONTWRITEBYTECODE": "1", "MPLCONFIGDIR": work}
        try:
            proc = subprocess.run([sys.executable, "main.py"], cwd=work, env=env, capture_output=True, timeout=timeout, preexec_fn=_limits, check=False)
        except subprocess.TimeoutExpired as exc:
            return {"ok": False, "error": f"stopped after {int(timeout)} s", "stdout": _tail(exc.stdout or b"", STDOUT), "stderr": _tail(exc.stderr or b"", STDERR), "files": {}}
        out: dict[str, bytes] = {}
        size = 0
        for name in sorted(os.listdir(os.path.join(work, "out")))[:OUT_FILES]:
            path = os.path.join(work, "out", name)
            if os.path.isfile(path) and size + os.path.getsize(path) <= OUT_BYTES:
                size += os.path.getsize(path)
                with open(path, "rb") as f:
                    out[name] = f.read()
        return {
            "ok": proc.returncode == 0,
            **({} if proc.returncode == 0 else {"error": f"exit code {proc.returncode}"}),
            "stdout": _tail(proc.stdout, STDOUT),
            "stderr": _tail(proc.stderr, STDERR),
            "files": out,
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)
