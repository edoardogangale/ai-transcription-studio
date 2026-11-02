"""Esportazioni TXT, SRT, VTT, JSON, DOCX, PDF (UTF-8 / font Unicode) per una o più trascrizioni.
Tutte usano la stessa "vista": filtro opzionale 'solo insegnante', evidenziazioni (giallo) e note dell'utente."""
import bisect
import io
import json
import time
from pathlib import Path
from xml.sax.saxutils import escape

from .textutil import ts


def teacher_of(t):
    return (t.get("stats") or {}).get("teacher")


def speaker_label(t, spk):
    return ((t.get("stats") or {}).get("speakers") or {}).get(spk, {}).get("label", spk) if spk else None


def visible_segments(t, teacher_only=True):
    """Segmenti da esportare. Con 'solo insegnante' scarta le voci riconosciute come estranee."""
    teacher = teacher_of(t)
    segs = t.get("segments") or []
    if teacher_only and teacher:
        segs = [s for s in segs if s.get("speaker") in (None, teacher)]
    return [s for s in segs if s["text"].strip()]


def blocks(t, notes, teacher_only=True):
    """[{time, speaker, text, highlight, notes:[testi]}] — note agganciate al segmento che contiene il loro istante."""
    segs = visible_segments(t, teacher_only)
    starts = [s["start"] for s in segs]
    teacher = teacher_of(t)
    out = [{"time": s["start"], "speaker": speaker_label(t, s.get("speaker")) if teacher and s.get("speaker") not in (None, teacher) else None,
            "text": s["text"].strip(), "highlight": False, "notes": []} for s in segs]
    for n in notes or []:
        if n["kind"] == "highlight":
            t0, t1 = n["t0"], n["t1"] if n["t1"] is not None else n["t0"]
            for b, s in zip(out, segs):
                if s["start"] <= t1 and s["end"] >= t0:
                    b["highlight"] = True
        elif out:
            i = max(0, bisect.bisect_right(starts, n["t0"]) - 1)
            out[i]["notes"].append(n["text"] or "")
    return out


def _mmss(sec):
    return ts(sec)[:8] if sec >= 3600 else ts(sec)[3:8]


# ---------------------------------------------------------------- sottotitoli / json
def _cues(segments, max_chars=84):
    for s in segments:
        txt = s["text"].strip()
        if not txt:
            continue
        ws = s.get("words") or []
        if len(txt) <= max_chars or len(ws) != len(txt.split()):
            yield s["start"], s["end"], txt
            continue
        cur, start, toks = [], ws[0]["s"], txt.split()
        for i, (tok, w) in enumerate(zip(toks, ws)):
            cur.append(tok)
            if len(" ".join(cur)) >= max_chars - 15 or i == len(toks) - 1:
                yield start, w["e"], " ".join(cur)
                cur, start = [], ws[i + 1]["s"] if i + 1 < len(ws) else w["e"]


def to_srt(t, teacher_only=True, **_):
    return "\n".join(f"{i}\n{ts(a)} --> {ts(max(b, a + 0.2))}\n{x}\n"
                     for i, (a, b, x) in enumerate(_cues(visible_segments(t, teacher_only)), 1)).encode("utf-8")


def to_vtt(t, teacher_only=True, **_):
    out = ["WEBVTT\n"] + [f"{ts(a, '.')} --> {ts(max(b, a + 0.2), '.')}\n{x}\n" for a, b, x in _cues(visible_segments(t, teacher_only))]
    return "\n".join(out).encode("utf-8")


def to_json(t, teacher_only=True, notes=None, **_):
    keep = ("id", "title", "filename", "duration", "language", "detected_language", "model_id", "context", "has_word_ts", "stats", "created")
    d = {k: t.get(k) for k in keep}
    d["segments"] = visible_segments(t, teacher_only)
    d["notes"] = notes or []
    d["timestamp_precision"] = "word" if t.get("has_word_ts") else "segment"
    d["only_teacher"] = bool(teacher_only and teacher_of(t))
    return json.dumps(d, ensure_ascii=False, indent=2).encode("utf-8")


# ---------------------------------------------------------------- testo / docx / pdf (uno o più)
def _header(t, folder_path):
    bits = [time.strftime("%d/%m/%Y %H:%M", time.localtime(t.get("created") or 0)), f"durata {_mmss(t.get('duration') or 0)}",
            f"modello {t.get('model_id')}"]
    if folder_path:
        bits.insert(0, folder_path)
    return " · ".join(bits)


def _items_blocks(item, teacher_only):
    """item = dict(t, notes, folder, paragraphs). Con 'paragraphs' (modalità pulita/appunti) niente timestamp."""
    if item.get("paragraphs") is not None:
        return [{"time": None, "speaker": None, "text": p, "highlight": False, "notes": []} for p in item["paragraphs"].split("\n\n") if p.strip()]
    return blocks(item["t"], item.get("notes"), teacher_only)


def to_txt(items, teacher_only=True, include_notes=True):
    out = []
    for it in items:
        t = it["t"]
        out.append(f"{t.get('title')}\n{'=' * len(t.get('title') or '')}\n{_header(t, it.get('folder'))}\n")
        for b in _items_blocks(it, teacher_only):
            line = (f"[{_mmss(b['time'])}] " if b["time"] is not None else "") + (f"{b['speaker']}: " if b["speaker"] else "") + b["text"]
            out.append(("★ " if b["highlight"] else "") + line)
            if include_notes:
                out += [f"   ✎ Nota: {n}" for n in b["notes"]]
        out.append("")
    return "\n".join(out).strip().encode("utf-8") + b"\n"


def to_docx(items, teacher_only=True, include_notes=True):
    from docx import Document
    from docx.enum.text import WD_COLOR_INDEX
    from docx.shared import Pt, RGBColor
    d = Document()
    if len(items) > 1:
        d.add_heading("Trascrizioni", 0)
        for it in items:
            d.add_paragraph(f"{it['t'].get('title')} — {_mmss(it['t'].get('duration') or 0)}", style="List Bullet")
        d.add_page_break()
    for n, it in enumerate(items):
        t = it["t"]
        if n:
            d.add_page_break()
        d.add_heading(t.get("title") or "Trascrizione", 1)
        d.add_paragraph(_header(t, it.get("folder")))
        for b in _items_blocks(it, teacher_only):
            if b["text"].startswith("## ") or b["text"].startswith("# "):
                d.add_heading(b["text"].lstrip("# ").strip(), 2)
                continue
            p = d.add_paragraph()
            if b["time"] is not None:
                r = p.add_run(f"[{_mmss(b['time'])}] ")
                r.font.size, r.font.color.rgb = Pt(8), RGBColor(0x66, 0x66, 0x66)
            if b["speaker"]:
                p.add_run(b["speaker"] + ": ").bold = True
            r = p.add_run(b["text"])
            if b["highlight"]:
                r.font.highlight_color = WD_COLOR_INDEX.YELLOW
            if include_notes:
                for note in b["notes"]:
                    q = d.add_paragraph()
                    q.paragraph_format.left_indent = Pt(18)
                    rr = q.add_run("✎ Nota: " + note)
                    rr.italic, rr.font.color.rgb = True, RGBColor(0x1d, 0x4e, 0xd8)
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def _font():
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf",
              "/Library/Fonts/Arial Unicode.ttf", "C:/Windows/Fonts/arial.ttf"):
        if Path(p).exists():
            return p
    return None


def to_pdf(items, teacher_only=True, include_notes=True):
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer
    fp, name = _font(), "Helvetica"
    if fp:
        pdfmetrics.registerFont(TTFont("StudioSans", fp))
        name = "StudioSans"
    ss = getSampleStyleSheet()
    body = ParagraphStyle("b", parent=ss["BodyText"], fontName=name, fontSize=10.5, leading=15, spaceAfter=4)
    note = ParagraphStyle("n", parent=body, leftIndent=18, textColor="#1d4ed8", fontSize=9.5)
    meta = ParagraphStyle("m", parent=body, textColor="#666666", fontSize=9)
    h1 = ParagraphStyle("h1", parent=ss["Heading1"], fontName=name)
    h2 = ParagraphStyle("h2", parent=ss["Heading2"], fontName=name)
    buf = io.BytesIO()
    title = items[0]["t"].get("title") if len(items) == 1 else f"Trascrizioni ({len(items)})"
    doc = SimpleDocTemplate(buf, pagesize=A4, title=title or "Trascrizione", author="AI Transcription Studio")
    story = []
    if len(items) > 1:
        story += [Paragraph("Trascrizioni", h1), Spacer(1, 6)]
        story += [Paragraph(f"{i}. {escape(it['t'].get('title') or '')} — {_mmss(it['t'].get('duration') or 0)}", body) for i, it in enumerate(items, 1)]
        story.append(PageBreak())
    for n, it in enumerate(items):
        t = it["t"]
        if n:
            story.append(PageBreak())
        story += [Paragraph(escape(t.get("title") or "Trascrizione"), h1), Paragraph(escape(_header(t, it.get("folder"))), meta), Spacer(1, 8)]
        for b in _items_blocks(it, teacher_only):
            if b["text"].startswith("## ") or b["text"].startswith("# "):
                story.append(Paragraph(escape(b["text"].lstrip("# ").strip()), h2))
                continue
            txt = escape(b["text"]).replace("\n", "<br/>")
            if b["highlight"]:
                txt = f'<font backColor="#fff3a3">{txt}</font>'
            pre = (f'<font color="#888888" size="8">[{_mmss(b["time"])}]</font> ' if b["time"] is not None else "") + \
                  (f"<b>{escape(b['speaker'])}:</b> " if b["speaker"] else "")
            story.append(Paragraph(pre + txt, body))
            if include_notes:
                story += [Paragraph("✎ Nota: " + escape(x), note) for x in b["notes"]]
    doc.build(story)
    return buf.getvalue()


FORMATS = {
    "txt": "text/plain; charset=utf-8", "srt": "application/x-subrip; charset=utf-8", "vtt": "text/vtt; charset=utf-8",
    "json": "application/json; charset=utf-8", "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
MULTI = {"txt": to_txt, "docx": to_docx, "pdf": to_pdf}
SINGLE_ONLY = {"srt": to_srt, "vtt": to_vtt, "json": to_json}
