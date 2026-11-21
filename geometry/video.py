"""Videos for the Library and chat: a poster frame, a sheet of frames the AI can
look at, and an MP4 copy for files browsers can't play (AVI, WMV, MKV, MPEG…)."""

from __future__ import annotations

import io
import json
import os
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFont

POSTER_EDGE = 1568
CELL = 512
FRAMES = 6
# What browsers play without help: MP4/MOV with H.264, HEVC (Safari, Chrome on Mac/Windows) or AV1; WebM with VP8/VP9/AV1.
PLAYABLE = {"mp4": {"h264", "hevc", "av1"}, "m4v": {"h264", "hevc", "av1"}, "mov": {"h264", "hevc", "av1"}, "webm": {"vp8", "vp9", "av1"}}


def probe(path: str) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
        capture_output=True, timeout=60, check=False,
    )
    info = json.loads(out.stdout or b"{}")
    video = next((s for s in info.get("streams", []) if s.get("codec_type") == "video" and s.get("disposition", {}).get("attached_pic") != 1), None)
    if not video:
        raise ValueError("no video stream in this file")
    duration = float(info.get("format", {}).get("duration") or video.get("duration") or 0)
    return {"duration": duration, "codec": video.get("codec_name", "")}


def _frame(path: str, at: float, edge: int) -> Image.Image:
    # -ss before -i seeks by keyframe, which is fast even in long files; ffmpeg applies rotation.
    scale = f"scale='min({edge},iw)':'min({edge},ih)':force_original_aspect_ratio=decrease"
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{at:.3f}", "-i", path, "-frames:v", "1", "-vf", scale, "-f", "image2pipe", "-c:v", "png", "-"],
        capture_output=True, timeout=120, check=False,
    )
    if not out.stdout:
        raise ValueError(out.stderr.decode(errors="replace").strip().splitlines()[-1] if out.stderr else "could not read a frame")
    return Image.open(io.BytesIO(out.stdout)).convert("RGB")


def _clock(t: float) -> str:
    t = int(t)
    return f"{t // 3600}:{t // 60 % 60:02d}:{t % 60:02d}" if t >= 3600 else f"{t // 60}:{t % 60:02d}"


def _jpeg(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=84)
    return buf.getvalue()


def frames(path: str, ext: str) -> dict:
    """Poster (a frame near the start) and a 3×2 sheet of frames across the video, times marked."""
    meta = probe(path)
    duration = meta["duration"]
    poster = _frame(path, min(1.0, duration * 0.1), POSTER_EDGE)
    times = [duration * (i + 0.5) / FRAMES for i in range(FRAMES)] if duration > 0 else [0.0]
    cells = []
    for t in times:
        try:
            cells.append((t, _frame(path, t, CELL)))
        except ValueError:
            pass
    if not cells:
        cells = [(0.0, poster.copy())]
    for _, im in cells:
        im.thumbnail((CELL, CELL))
    cols = min(3, len(cells))
    rows = (len(cells) + cols - 1) // cols
    cw = max(im.width for _, im in cells)
    ch = max(im.height for _, im in cells)
    sheet = Image.new("RGB", (cols * cw, rows * ch), "white")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=22)
    for i, (t, im) in enumerate(cells):
        x, y = i % cols * cw, i // cols * ch
        sheet.paste(im, (x, y))
        label = _clock(t)
        box = draw.textbbox((x + 8, y + 8), label, font=font)
        draw.rectangle((box[0] - 4, box[1] - 3, box[2] + 4, box[3] + 3), fill="black")
        draw.text((x + 8, y + 8), label, fill="white", font=font)
    return {
        "ok": True,
        "poster": _jpeg(poster),
        "sheet": _jpeg(sheet),
        "width": poster.width,
        "height": poster.height,
        "duration": round(duration, 2),
        "needsCopy": meta["codec"] not in PLAYABLE.get(ext, set()),
    }


def web_copy(path: str, timeout: float = 720) -> str:
    """An H.264/AAC MP4 at most 1280 px on the long edge, streamable (faststart). Returns its path."""
    fd, out = tempfile.mkstemp(suffix=".mp4")
    os.close(fd)
    scale = "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'"
    run = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", path, "-map", "0:v:0", "-map", "0:a:0?", "-vf", scale,
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", out],
        capture_output=True, timeout=timeout, check=False,
    )
    if run.returncode != 0 or os.path.getsize(out) == 0:
        os.unlink(out)
        raise ValueError(run.stderr.decode(errors="replace").strip().splitlines()[-1] if run.stderr else "conversion failed")
    return out
