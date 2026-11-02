import subprocess

import numpy as np
import pytest

from app import audio
from conftest import make_audio


def test_probe_ok_and_formats(tmp_path):
    for ext, args in [("wav", ()), ("mp3", ()), ("m4a", ()), ("flac", ()), ("aac", ())]:
        p = tmp_path / f"a.{ext}"
        make_audio(p, [3, 2], fmt_args=args)
        info = audio.probe(p)
        assert 6 < info["duration"] < 9, ext


def test_probe_corrupted_and_non_audio(tmp_path):
    bad = tmp_path / "x.mp3"
    bad.write_bytes(b"questo non e' audio" * 100)
    with pytest.raises(audio.AudioError):
        audio.probe(bad)
    empty = tmp_path / "e.wav"
    empty.write_bytes(b"")
    with pytest.raises(audio.AudioError):
        audio.probe(empty)


def test_convert_and_normalize(tmp_path):
    src = tmp_path / "a.wav"
    make_audio(src, [4, 3])
    out = audio.convert_to_pcm(src, tmp_path / "a.pcm", normalize=True, denoise=True)
    pcm = audio.open_pcm(out)
    assert abs(len(pcm) / audio.SR - 9.4) < 0.3  # 4+1.2+3+1.2
    assert np.abs(pcm).max() > 0


def test_chunks_cut_only_in_silence_and_cover_all_speech(tmp_path):
    bursts = [6, 7, 5, 9, 4, 8, 6, 7]
    src = tmp_path / "a.wav"
    make_audio(src, bursts, gap=1.0)
    pcm = audio.open_pcm(audio.convert_to_pcm(src, tmp_path / "a.pcm"))
    db = audio.frame_energy(pcm)
    chunks = audio.plan_chunks(db, max_len=20, min_len=8)
    assert len(chunks) >= 3 and all(b - a <= 20.01 for a, b in chunks)
    # i tagli (tranne inizio/fine) devono cadere nel silenzio: energia bassa
    mask = audio.speech_mask(db)
    for _, b in chunks[:-1]:
        i = int(b / audio.FRAME)
        assert not mask[min(i, len(mask) - 1)], f"taglio a {b}s dentro il parlato"
    # nessun frame di parlato escluso dalle finestre
    covered = np.zeros(len(mask), bool)
    for a, b in chunks:
        covered[int(a / audio.FRAME):int(b / audio.FRAME)] = True
    assert not (mask & ~covered).any()
    # nessuna sovrapposizione -> nessuna parola duplicata
    assert all(chunks[i][1] <= chunks[i + 1][0] + 1e-6 for i in range(len(chunks) - 1))


def test_silence_only_returns_no_chunks(tmp_path):
    p = tmp_path / "s.wav"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-t", "5", "-i", "anullsrc=r=16000", str(p)], check=True)
    pcm = audio.open_pcm(audio.convert_to_pcm(p, tmp_path / "s.pcm"))
    assert audio.plan_chunks(audio.frame_energy(pcm)) == []


@pytest.mark.slow
def test_three_hour_file_constant_memory(tmp_path):
    import psutil
    p = tmp_path / "long.pcm"
    # 190 minuti sintetici: 20 s di tono + 1.5 s di silenzio, ripetuti (generato a blocchi)
    unit = tmp_path / "u.pcm"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "sine=f=300:r=16000:d=20", "-f", "lavfi", "-i",
                    "anullsrc=r=16000:cl=mono", "-filter_complex", "[1:a]atrim=0:1.5[s];[0:a][s]concat=n=2:v=0:a=1", "-f", "s16le", str(unit)], check=True)
    blob = unit.read_bytes()
    with open(p, "wb") as f:
        for _ in range(int(190 * 60 / 21.5)):
            f.write(blob)
    anon = lambda: (lambda m: m.rss - m.shared)(psutil.Process().memory_info())
    rss0 = anon()
    pcm = audio.open_pcm(p)
    dur = len(pcm) / audio.SR
    chunks = audio.plan_chunks(audio.frame_energy(pcm), max_len=28)
    grow = (anon() - rss0) / 1e6
    assert dur >= 180 * 60 and len(chunks) > 400
    assert grow < 250, f"RAM cresciuta di {grow} MB"
