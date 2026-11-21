"""Spreadsheets and documents as text the AI can read: every sheet as CSV, Word and
PowerPoint as their text and tables."""

from __future__ import annotations

import io

SHEETS = {"xlsx", "xlsm", "xls", "ods", "numbers"}
DOCS = {"docx", "pptx", "odt"}


def convert(path: str, ext: str) -> str:
    if ext in SHEETS:
        return _sheets(path, ext)
    if ext == "docx":
        return _docx(path)
    if ext == "pptx":
        return _pptx(path)
    if ext == "odt":
        return _odt(path)
    raise ValueError(f"can't read .{ext} files")


def _sheets(path: str, ext: str) -> str:
    import pandas as pd

    if ext == "numbers":
        from numbers_parser import Document

        frames = {}
        for sheet in Document(path).sheets:
            for table in sheet.tables:
                name = sheet.name if len(sheet.tables) == 1 else f"{sheet.name} / {table.name}"
                frames[name] = pd.DataFrame(table.rows(values_only=True))
    else:
        engine = {"xls": "xlrd", "ods": "odf"}.get(ext, "openpyxl")
        # No header row assumed: messy sheets keep their titles and notes as rows.
        frames = pd.read_excel(path, sheet_name=None, header=None, engine=engine)
    parts = []
    for name, df in frames.items():
        df = df.dropna(how="all").dropna(axis=1, how="all")
        if df.empty:
            parts.append(f'## Sheet "{name}" · empty')
            continue
        buf = io.StringIO()
        df.to_csv(buf, index=False, header=False)
        parts.append(f'## Sheet "{name}" · {len(df)} rows × {len(df.columns)} columns\n{buf.getvalue().rstrip()}')
    return "\n\n".join(parts) or "(no sheets)"


def _rows(table) -> str:
    return "\n".join(" | ".join(cell.text.strip() for cell in row.cells) for row in table.rows)


def _docx(path: str) -> str:
    import docx

    doc = docx.Document(path)
    text = "\n".join(p.text for p in doc.paragraphs if p.text.strip())
    tables = [f"## Table {i + 1}\n{_rows(t)}" for i, t in enumerate(doc.tables)]
    return "\n\n".join([text, *tables]).strip() or "(no text)"


def _pptx(path: str) -> str:
    from pptx import Presentation

    slides = []
    for n, slide in enumerate(Presentation(path).slides, 1):
        lines = []
        for shape in slide.shapes:
            if shape.has_text_frame and shape.text_frame.text.strip():
                lines.append(shape.text_frame.text.strip())
            if getattr(shape, "has_table", False) and shape.has_table:
                lines.append(_rows(shape.table))
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame.text.strip():
            lines.append(f"Notes: {slide.notes_slide.notes_text_frame.text.strip()}")
        slides.append(f"## Slide {n}\n" + "\n".join(lines))
    return "\n\n".join(slides) or "(no slides)"


def _odt(path: str) -> str:
    from odf import teletype, text
    from odf.opendocument import load

    doc = load(path)
    return "\n".join(teletype.extractText(p) for p in doc.getElementsByType(text.P) if teletype.extractText(p).strip()) or "(no text)"
