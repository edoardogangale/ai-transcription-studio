"""Quaderno: un documento di testo ricco (come Word / Note di Apple) ricavato dalla trascrizione, con inchiostro (Apple Pencil).
- il testo è HTML PULITO da una lista bianca di tag/attributi (nessuno script, nessun link, nessun evento);
- l'inchiostro è salvato come tratti vettoriali ancorati al paragrafo vicino (seguono il testo quando cambia);
- è un documento INDIPENDENTE dalla trascrizione sincronizzata: le modifiche qui non cambiano segmenti e timestamp."""
import io
import re
from html import escape
from html.parser import HTMLParser

from . import exports
from .textutil import ts

MAX_HTML = 2_000_000
MAX_INK = 8_000_000
ALLOWED = {"p", "div", "br", "h1", "h2", "h3", "b", "strong", "i", "em", "u", "s", "strike", "mark", "ul", "ol", "li", "span", "blockquote", "aside", "hr", "sub", "sup"}
VOID = {"br", "hr"}
CLASSES = {"nb-ts", "nb-note", "nb-space"}
DROP_CONTENT = {"script", "style", "iframe", "object", "embed", "template", "svg", "math", "noscript", "head", "title", "textarea", "select", "option", "button"}
COLOR = re.compile(r"^(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?\)|[a-zA-Z]{3,20})$")
STYLE_OK = {"color", "background-color", "font-weight", "font-style", "text-decoration", "text-align"}
STYLE_VALUES = {"font-weight": {"bold", "normal", "700", "600"}, "font-style": {"italic", "normal"}, "text-decoration": {"underline", "line-through", "none", "underline line-through"}, "text-align": {"left", "right", "center", "justify"}}


def _clean_style(v: str) -> str:
    out = []
    for part in v.split(";"):
        if ":" not in part:
            continue
        k, val = (x.strip().lower() for x in part.split(":", 1))
        if k not in STYLE_OK or "url(" in val or "expression" in val or "javascript" in val:
            continue
        if k in STYLE_VALUES and val not in STYLE_VALUES[k]:
            continue
        if k in ("color", "background-color") and not COLOR.match(val):
            continue
        out.append(f"{k}: {val}")
    return "; ".join(out)


class _San(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.skip, self.stack = [], 0, []

    def handle_starttag(self, tag, attrs):
        if tag in DROP_CONTENT:
            self.skip += 1
            return
        if self.skip or tag not in ALLOWED:
            return
        keep = []
        for k, v in attrs:
            v = v or ""
            if k == "class":
                cl = [c for c in v.split() if c in CLASSES]
                if cl:
                    keep.append(f'class="{" ".join(cl)}"')
            elif k == "style":
                st = _clean_style(v)
                if st:
                    keep.append(f'style="{escape(st, quote=True)}"')
            elif k == "data-bid" and re.fullmatch(r"[A-Za-z0-9_-]{1,24}", v):
                keep.append(f'data-bid="{v}"')
            elif k == "data-t" and re.fullmatch(r"\d{1,6}(\.\d{1,3})?", v):
                keep.append(f'data-t="{v}"')
            elif k == "contenteditable" and v == "false":
                keep.append('contenteditable="false"')
        self.out.append(f"<{tag}{(' ' + ' '.join(keep)) if keep else ''}>")
        if tag not in VOID:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        if tag in VOID and not self.skip and tag in ALLOWED:
            self.out.append(f"<{tag}>")

    def handle_endtag(self, tag):
        if tag in DROP_CONTENT:
            self.skip = max(0, self.skip - 1)
            return
        if self.skip or tag not in ALLOWED or tag in VOID:
            return
        if tag in self.stack:
            while self.stack:
                t = self.stack.pop()
                self.out.append(f"</{t}>")
                if t == tag:
                    break

    def handle_data(self, data):
        if not self.skip:
            self.out.append(escape(data, quote=False))

    def close(self):
        super().close()
        while self.stack:
            self.out.append(f"</{self.stack.pop()}>")


def sanitize(html: str) -> str:
    p = _San()
    p.feed(html or "")
    p.close()
    return "".join(p.out)


def to_text(html: str) -> str:
    class T(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.o = []

        def handle_starttag(self, tag, attrs):
            if tag in ("p", "div", "li", "h1", "h2", "h3", "br", "blockquote", "aside"):
                self.o.append("\n")
            if tag == "li":
                self.o.append("• ")

        def handle_data(self, d):
            self.o.append(d)
    t = T()
    t.feed(html or "")
    return re.sub(r"\n{3,}", "\n\n", "".join(t.o)).strip()


def validate_ink(ink) -> list:
    """Accetta solo tratti ben formati (tipo, colore, spessore, punti numerici); scarta il resto."""
    out = []
    for s in ink if isinstance(ink, list) else []:
        try:
            if s.get("t") not in ("pen", "hl", "arrow") or not isinstance(s.get("p"), list) or not 1 <= len(s["p"]) <= 20000:
                continue
            if not COLOR.match(str(s.get("c", ""))):
                continue
            w = float(s.get("w", 3))
            pts = [[float(a), float(b), float(c) if len(pt) > 2 else 0.5] for pt in s["p"] for a, b, c in [(pt + [0.5])[:3]]]
            out.append({"id": str(s.get("id", ""))[:24], "t": s["t"], "c": s["c"], "w": max(0.5, min(60.0, w)), "a": str(s.get("a", ""))[:24], "fy": float(s.get("fy", 0)), "p": pts})
        except (TypeError, ValueError, AttributeError):
            continue
    return out


# ---------------------------------------------------------------- creazione dalla trascrizione
def initial_html(t, notes, teacher_only=True, include_notes=True, gap=1.6, max_chars=700) -> str:
    """Paragrafi dalla trascrizione fedele (senza pulizia: il testo resta quello detto), con ▶ tempo, evidenziazioni (mark) e note."""
    segs = exports.visible_segments(t, teacher_only)
    bl = exports.blocks(t, notes if include_notes else [], teacher_only)
    out = [f"<h1>{escape(t.get('title') or 'Quaderno')}</h1>"]
    paras, cur, last_end = [], None, None
    for s, b in zip(segs, bl):
        if cur is None or s["start"] - (last_end or 0) > gap or cur["len"] > max_chars:
            cur = {"t": s["start"], "parts": [], "notes": [], "len": 0}
            paras.append(cur)
        txt = escape(b["text"])
        cur["parts"].append(f"<mark>{txt}</mark>" if b["highlight"] else txt)
        cur["notes"] += b["notes"]
        cur["len"] += len(b["text"])
        last_end = s["end"]
    for k, p in enumerate(paras):
        mm = ts(p["t"])[:8] if p["t"] >= 3600 else ts(p["t"])[3:8]
        out.append(f'<p data-bid="b{k}" data-t="{p["t"]:.2f}"><span class="nb-ts" contenteditable="false">▶ {mm}</span> {" ".join(p["parts"])}</p>')
        for n in p["notes"]:
            out.append(f'<aside class="nb-note">✎ {escape(n)}</aside>')
    return "".join(out)


# ---------------------------------------------------------------- esportazione (testo, DOCX); il PDF con inchiostro si fa dal browser (Stampa)
def to_docx(html: str, title: str) -> bytes:
    from docx import Document
    from docx.enum.text import WD_COLOR_INDEX
    d = Document()
    state = {"p": None, "b": 0, "i": 0, "u": 0, "mark": 0, "list": None}

    class H(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)

        def _new(self, style=None):
            state["p"] = d.add_paragraph(style=style)

        def handle_starttag(self, tag, attrs):
            if tag in ("h1", "h2", "h3"):
                state["p"] = d.add_heading("", int(tag[1]))
            elif tag in ("p", "div", "blockquote", "aside"):
                self._new()
            elif tag == "li":
                self._new("List Bullet")
            elif tag in ("ul", "ol"):
                pass
            elif tag in ("b", "strong"):
                state["b"] += 1
            elif tag in ("i", "em"):
                state["i"] += 1
            elif tag == "u":
                state["u"] += 1
            elif tag == "mark":
                state["mark"] += 1
            elif tag == "br" and state["p"] is not None:
                state["p"].add_run().add_break()

        def handle_endtag(self, tag):
            if tag in ("b", "strong"):
                state["b"] = max(0, state["b"] - 1)
            elif tag in ("i", "em"):
                state["i"] = max(0, state["i"] - 1)
            elif tag == "u":
                state["u"] = max(0, state["u"] - 1)
            elif tag == "mark":
                state["mark"] = max(0, state["mark"] - 1)

        def handle_data(self, data):
            if not data.strip() and state["p"] is None:
                return
            if state["p"] is None:
                self._new()
            r = state["p"].add_run(data)
            r.bold, r.italic, r.underline = bool(state["b"]), bool(state["i"]), bool(state["u"])
            if state["mark"]:
                r.font.highlight_color = WD_COLOR_INDEX.YELLOW

    d.add_heading(title or "Quaderno", 0)
    H().feed(html or "")
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()
