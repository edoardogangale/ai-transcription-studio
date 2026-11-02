"""Elaborazione audio: validazione, conversione a PCM 16 kHz mono su disco, VAD a energia,
segmentazione ai silenzi, forma d'onda. L'audio non viene mai caricato per intero in RAM:
si usa un np.memmap sul file PCM e si legge una finestra per volta."""
import json
import subprocess
from pathlib import Path

import numpy as np

SR = 16000
FRAME = 0.03  # secondi


class AudioError(Exception):
    pass


def probe(path) -> dict:
    """Verifica integrità e formato. Solleva AudioError se il file non è audio decodificabile."""
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
                           capture_output=True, text=True, timeout=60)
    except FileNotFoundError:
        raise AudioError("FFmpeg/ffprobe non installato.")
    if r.returncode != 0:
        raise AudioError("File non riconosciuto come audio valido o danneggiato.")
    info = json.loads(r.stdout or "{}")
    streams = [s for s in info.get("streams", []) if s.get("codec_type") == "audio"]
    if not streams:
        raise AudioError("Nessuna traccia audio nel file.")
    dur = float(info.get("format", {}).get("duration") or streams[0].get("duration") or 0)
    if "aac" in (info["format"].get("format_name") or "") and "mp4" not in info["format"]["format_name"]:
        dur = exact_duration(path) or dur  # AAC ADTS grezzo: la durata di ffprobe è solo una stima dal bitrate
    if dur <= 0:
        raise AudioError("Durata non determinabile: file probabilmente danneggiato.")
    return {"duration": dur, "codec": streams[0].get("codec_name"), "format": info["format"].get("format_name")}


def exact_duration(path):
    """Durata reale decodificando (senza scrivere): usata per i formati senza durata affidabile."""
    import re
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-f", "null", "-", "-progress", "pipe:1", "-nostats"],
                       capture_output=True, text=True)
    ms = re.findall(r"out_time_ms=(\d+)", r.stdout)
    return int(ms[-1]) / 1e6 if ms else None


def convert_to_pcm(src, dst, normalize=False, denoise=False) -> Path:
    """Converte in PCM s16le 16 kHz mono (file .pcm grezzo). Filtri opzionali ffmpeg:
    highpass+loudnorm (normalizzazione) e afftdn (riduzione rumore)."""
    filters = []
    if denoise:
        filters.append("afftdn=nf=-25")
    if normalize:
        filters += ["highpass=f=70", "loudnorm=I=-18:TP=-2:LRA=11"]
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(src), "-vn", "-ac", "1", "-ar", str(SR)]
    if filters:
        cmd += ["-af", ",".join(filters)]
    cmd += ["-f", "s16le", str(dst)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not Path(dst).exists() or Path(dst).stat().st_size < SR * 2 * 0.1:
        raise AudioError("Conversione fallita (file danneggiato?): " + (r.stderr or "")[-300:])
    return Path(dst)


def open_pcm(path) -> np.memmap:
    return np.memmap(path, dtype=np.int16, mode="r")


def read_window(pcm: np.memmap, start: float, end: float) -> np.ndarray:
    a, b = max(0, int(start * SR)), min(len(pcm), int(end * SR))
    return pcm[a:b].astype(np.float32) / 32768.0


def frame_energy(pcm: np.memmap, block_s: float = 60.0):
    """Energia RMS (dB) per frame da 30 ms, calcolata a blocchi (memoria costante)."""
    n = int(FRAME * SR)
    out = []
    step = int(block_s * SR) // n * n
    for off in range(0, len(pcm), step):
        x = pcm[off:off + step].astype(np.float32) / 32768.0
        m = len(x) // n
        if m == 0:
            continue
        rms = np.sqrt((x[:m * n].reshape(m, n) ** 2).mean(axis=1) + 1e-12)
        out.append(20 * np.log10(rms))
    return np.concatenate(out) if out else np.zeros(0, dtype=np.float32)


def speech_mask(db: np.ndarray, hangover: int = 5) -> np.ndarray:
    """VAD a soglia adattiva: pavimento di rumore = 5° percentile, soglia = min(floor+9, picco-12 dB),
    minimo -55 dB. Hangover per non spezzare le parole alle code. È un VAD semplice a energia,
    NON un modello neurale: in presenza di rumore forte può considerare 'parlato' anche il rumore."""
    if len(db) == 0:
        return np.zeros(0, dtype=bool)
    floor, peak = np.percentile(db, 5), np.percentile(db, 95)
    # tetto relativo al picco: con pochissimo silenzio il pavimento stimato è già parlato
    thr = max(min(floor + 9.0, peak - 12.0), -55.0)
    m = db > thr
    if hangover:
        k = np.ones(hangover * 2 + 1)
        m = np.convolve(m.astype(float), k, mode="same") > 0
    return m


def plan_chunks(db: np.ndarray, max_len: float = 28.0, min_len: float = 8.0, min_silence_frames: int = 6,
                total: float | None = None):
    """Divide in finestre <= max_len tagliando al punto più silenzioso (preferibilmente in una pausa lunga),
    mai a metà parola se esiste una pausa nella finestra. Ritorna [(start_s, end_s), ...].
    Le zone di silenzio prolungato iniziali/finali vengono scartate. Nessun overlap necessario:
    il taglio cade nel silenzio, quindi nessuna parola è duplicata né persa."""
    n = len(db)
    if n == 0:
        return []
    mask = speech_mask(db)
    if not mask.any():
        return []
    f = lambda s: int(s / FRAME)
    first = int(np.argmax(mask))
    last = n - int(np.argmax(mask[::-1]))
    chunks, pos = [], first
    while pos < last:
        end = min(pos + f(max_len), last)
        if end < last:
            lo = pos + f(min_len)
            win = db[lo:end]
            # silenzi: run di frame non-parlato; scegli il più lungo (a pari lunghezza, il più tardo)
            quiet = ~mask[lo:end]
            best, best_len, run_start = None, 0, None
            for i, q in enumerate(np.append(quiet, False)):
                if q and run_start is None:
                    run_start = i
                elif not q and run_start is not None:
                    ln = i - run_start
                    if ln >= best_len and ln >= min_silence_frames:
                        best, best_len = run_start + ln // 2, ln
                    run_start = None
            if best is None:  # nessuna pausa: taglia al frame più silenzioso (ultimo ripiego)
                best = int(np.argmin(win[: max(1, len(win) - 1)]))
            end = lo + best
        s, e = pos * FRAME, end * FRAME
        if e - s > 0.3:
            chunks.append((round(s, 3), round(e, 3)))
        pos = end
        while pos < last and not mask[pos]:  # salta il silenzio dopo il taglio
            pos += 1
    if total:
        chunks = [(a, min(b, total)) for a, b in chunks]
    return chunks


def plan_in_ranges(db: np.ndarray, ranges, max_len: float = 28.0):
    """Pianifica i chunk dentro intervalli di parlante già noti [(s,e,spk)]: ogni chunk ha un solo parlante.
    Ritorna [(a,b,spk)] in ordine temporale."""
    out = []
    for s, e, spk in ranges:
        i0, i1 = int(s / FRAME), int(e / FRAME)
        for a, b in plan_chunks(db[i0:i1], max_len=max_len):
            out.append((round(s + a, 3), round(s + b, 3), spk))
    return sorted(out)


def waveform_peaks(pcm: np.memmap, bins: int = 1600):
    n = len(pcm)
    if n == 0:
        return []
    edges = np.linspace(0, n, bins + 1, dtype=np.int64)
    out = []
    for a, b in zip(edges[:-1], edges[1:]):
        seg = pcm[a:max(b, a + 1)]
        out.append(round(float(np.abs(seg).max()) / 32768.0, 4))
    return out
