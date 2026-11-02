import os
import subprocess
import sys
import tempfile
from pathlib import Path

_tmp = tempfile.mkdtemp(prefix="studio-test-")
os.environ["STUDIO_DATA"] = _tmp
os.environ["STUDIO_ENABLE_MOCK"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from fastapi.testclient import TestClient


def make_audio(path, bursts, gap=1.2, fmt_args=()):
    """Audio sintetico: toni (simulano parlato) separati da silenzio. bursts = durate in secondi."""
    parts, filt = [], []
    for i, d in enumerate(bursts):
        parts += ["-f", "lavfi", "-t", str(d), "-i", f"sine=frequency={300 + 40 * i}:sample_rate=16000"]
        filt.append(f"[{i}:a]volume=0.5[a{i}];aevalsrc=0:d={gap}:s=16000[g{i}]")
    chain = ";".join(filt) + ";" + "".join(f"[a{i}][g{i}]" for i in range(len(bursts))) + f"concat=n={2 * len(bursts)}:v=0:a=1[out]"
    subprocess.run(["ffmpeg", "-y", "-v", "error", *parts, "-filter_complex", chain, "-map", "[out]", *fmt_args, str(path)], check=True)


@pytest.fixture(scope="session")
def client():
    from app.main import app
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def wav(tmp_path_factory):
    p = tmp_path_factory.mktemp("aud") / "lezione è àccènti.wav"
    make_audio(p, [6, 7, 5, 9, 4])
    return p
