"""Small image jobs: crop an item out of a photo, and make previews (HEIC included)."""

from __future__ import annotations

import base64
import io

import pillow_heif
from PIL import Image, ImageOps

# iPhone photos (HEIC/HEIF) open like any other image.
pillow_heif.register_heif_opener()


def crop(data: bytes, box: list[float] | None, size: int = 512) -> dict:
    """Crop `box` ([x, y, w, h] in pixels of the original) and fit it in a square PNG."""
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    if box:
        x, y, w, h = (float(v) for v in box)
        left, top = max(0, int(x)), max(0, int(y))
        right, bottom = min(img.width, int(x + w)), min(img.height, int(y + h))
        if right - left < 8 or bottom - top < 8:
            raise ValueError(f"crop box {box} is outside the {img.width}×{img.height} image or too small")
        img = img.crop((left, top, right, bottom))
    img.thumbnail((size, size), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, "PNG", optimize=True)
    return {"ok": True, "png": base64.b64encode(out.getvalue()).decode(), "width": img.width, "height": img.height}


def preview(data: bytes, edge: int = 1568) -> dict:
    """A JPEG no larger than `edge` on the long side, upright, for display and for the AI."""
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    full = img.size
    img.thumbnail((edge, edge), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, "JPEG", quality=85, optimize=True)
    return {"ok": True, "jpeg": base64.b64encode(out.getvalue()).decode(), "width": img.width, "height": img.height, "fullWidth": full[0], "fullHeight": full[1]}
