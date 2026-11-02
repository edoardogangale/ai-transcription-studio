"""Esportazioni TXT, SRT, VTT, JSON, DOCX, PDF (UTF-8 / font Unicode)."""
import io
import json
from pathlib import Path

from .textutil import full_text, ts


def to_txt(t, text=None):
    return (text if text is not None else full_text(t["segments"], "\n")).encode("utf-8")


def _cues(segments, max_chars=84):
    """Un cue per segmento; i segmenti troppo lunghi sono divisi sui timestamp di parola se disponibili."""
    for s in segments:
        txt = s["text"].strip()
        if not txt:
            continue
        ws = s.get("words") or []
        if len(txt) <= max_chars or len(ws) != len(txt.split()):
            yield s["start"], s["end"], txt
            continue
        cur, start = [], ws[0]["s"]
        toks = txt.split()
        for i, (tok, w) in enumerate(zip(toks, ws)):
            cur.append(tok)
            if len(" ".join(cur)) >= max_chars - 15 or i == len(toks) - 1:
                yield start, w["e"], " ".join(cur)
                cur, start = [], ws[i + 1]["s"] if i + 1 < len(ws) else w["e"]


def to_srt(t):
    out = []
    for i, (a, b, x) in enumerate(_cues(t["segments"]), 1):
        out.append(f"{i}\n{ts(a)} --> {ts(max(b, a + 0.2))}\n{x}\n")
    return "\n".join(out).encode("utf-8")


def to_vtt(t):
    out = ["WEBVTT\n"]
    for a, b, x in _cues(t["segments"]):
        out.append(f"{ts(a, '.')} --> {ts(max(b, a + 0.2), '.')}\n{x}\n")
    return "\n".join(out).encode("utf-8")


def to_json(t):
    keep = ("id", "title", "filename", "duration", "language", "detected_language", "model_id", "context",
            "has_word_ts", "stats", "segments", "created")
    d = {k: t.get(k) for k in keep}
    d["timestamp_precision"] = "word" if t.get("has_word_ts") else "segment"
    return json.dumps(d, ensure_ascii=False, indent=2).encode("utf-8")


def _blocks(t, text=None):
    if text is not None:
        return [("", p) for p in text.split("\n\n") if p.strip()]
    return [(f"[{ts(s['start'])[:8]}]" + (f" {s['speaker']}" if s.get("speaker") else ""), s["text"])
            for s in t["segments"] if s["text"].strip()]


def to_docx(t, text=None):
    from docx import Document
    d = Document()
    d.add_heading(t.get("title") or "Trascrizione", 1)
    d.add_paragraph(f"Modello: {t.get('model_id')} · Lingua: {t.get('language')} · Durata: {ts(t.get('duration') or 0)[:8]}")
    for label, body in _blocks(t, text):
        if body.startswith("## ") or body.startswith("# "):
            d.add_heading(body.lstrip("# ").strip(), 2)
            continue
        p = d.add_paragraph()
        if label:
            r = p.add_run(label + " ")
            r.bold = True
        p.add_run(body)
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def _font():
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/Library/Fonts/Arial Unicode.ttf",
              "C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf"):
        if Path(p).exists():
            return p
    return None


def to_pdf(t, text=None):
    from xml.sax.saxutils import escape
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer
    fp, name = _font(), "Helvetica"
    if fp:
        pdfmetrics.registerFont(TTFont("StudioSans", fp))
        name = "StudioSans"
    ss = getSampleStyleSheet()
    body = ParagraphStyle("b", parent=ss["BodyText"], fontName=name, fontSize=10.5, leading=15)
    h = ParagraphStyle("h", parent=ss["Heading1"], fontName=name)
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, title=t.get("title") or "Trascrizione")
    story = [Paragraph(escape(t.get("title") or "Trascrizione"), h), Spacer(1, 8)]
    for label, b in _blocks(t, text):
        txt = escape(b).replace("\n", "<br/>")
        story.append(Paragraph((f"<b>{escape(label)}</b> " if label else "") + txt, body))
        story.append(Spacer(1, 4))
    doc.build(story)
    return buf.getvalue()


FORMATS = {
    "txt": ("text/plain; charset=utf-8", to_txt), "srt": ("application/x-subrip; charset=utf-8", to_srt),
    "vtt": ("text/vtt; charset=utf-8", to_vtt), "json": ("application/json; charset=utf-8", to_json),
    "docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", to_docx),
    "pdf": ("application/pdf", to_pdf),
}
