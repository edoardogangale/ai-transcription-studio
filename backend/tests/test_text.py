from app import postprocess, adapters
from app.textutil import wer, word_diff, diff_summary, ts, seg_words
from app.vocab import suggestions


def test_wer_known():
    r = wer("il gatto mangia il topo", "il gatto mangia topo")
    assert r["edits"] == 1 and r["wer"] == 0.2
    assert wer("Ciao, mondo!", "ciao mondo")["wer"] == 0
    assert wer("a b c", "x y z")["wer"] == 1.0


def test_diff_marks_differences():
    A = [{"start": 0, "end": 4, "text": "Kant scrive la critica", "words": []}]
    B = [{"start": 0, "end": 4, "text": "Cant scrive la critica", "words": []}]
    b = word_diff(A, B)
    assert diff_summary(b)["differences"] == 1
    d = [x for x in b if x["op"] != "equal"][0]
    assert d["a"] == "Kant" and d["b"] == "Cant" and d["t_a"] == 0


def test_timestamps_fmt():
    assert ts(3723.456) == "01:02:03,456" and ts(1.5, ".") == "00:00:01.500"


def test_word_timestamps_vs_interpolation():
    s = {"start": 0, "end": 4, "text": "uno due tre quattro", "words": [{"w": x, "s": i, "e": i + 1} for i, x in enumerate("1234")]}
    w, exact = seg_words(s)
    assert exact and w[2] == ("tre", 2)
    s["text"] = "uno due tre quattro cinque"  # modificato dall'utente -> interpolazione dichiarata
    w, exact = seg_words(s)
    assert not exact and len(w) == 5


def test_clean_mode_keeps_meaning():
    t = postprocess.clean_text("Allora ehm il il teorema, uhm, dice che no no no è falso", "it")
    assert "ehm" not in t.lower() and "uhm" not in t.lower()
    assert "il il" not in t.lower()
    assert "no no no" in t  # ripetizione potenzialmente significativa: preservata
    paras = postprocess.clean_paragraphs([{"start": 0, "end": 2, "text": "uno."}, {"start": 10, "end": 12, "text": "due."}])
    assert "\n\n" in paras


def test_tokens_to_words():
    w = adapters.tokens_to_words(["▁Ci", "ao", "▁mon", "do"], [0.1, 0.2, 0.9, 1.0])
    assert [x["w"] for x in w] == ["Ciao", "mondo"] and w[1]["s"] == 0.9


def test_vocab_suggestions_are_only_proposals(client):
    segs = [{"start": 0, "end": 1, "text": "secondo Schopenhaur la volontà"}]
    s = suggestions(segs, "Filosofia")
    assert s and s[0]["term"] == "Schopenhauer"
    assert segs[0]["text"] == "secondo Schopenhaur la volontà"  # mai modificato
