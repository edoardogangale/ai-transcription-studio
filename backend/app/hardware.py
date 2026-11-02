"""Rilevamento hardware (CPU/RAM/GPU) senza dipendere da PyTorch."""
import os
import shutil
import subprocess
from functools import lru_cache


def ram_gb() -> float:
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal"):
                    return round(int(line.split()[1]) / 1024 / 1024, 1)
    except OSError:
        pass
    try:
        import psutil
        return round(psutil.virtual_memory().total / 1e9, 1)
    except Exception:
        return 0.0


@lru_cache(maxsize=1)
def gpus() -> list:
    """GPU NVIDIA via nvidia-smi (l'unico backend GPU supportato da questa app)."""
    if not shutil.which("nvidia-smi"):
        return []
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=10).stdout
        res = []
        for i, line in enumerate(l for l in out.strip().splitlines() if l.strip()):
            name, mem = [x.strip() for x in line.split(",")]
            res.append({"index": i, "name": name, "vram_gb": round(int(mem) / 1024, 1)})
        return res
    except Exception:
        return []


def info() -> dict:
    g = gpus()
    return {"cpu_threads": os.cpu_count() or 1, "ram_gb": ram_gb(), "gpus": g,
            "devices": ["cpu"] + (["cuda"] if g else [])}


def process_peak_rss_mb() -> float:
    try:
        import resource
        return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)
    except Exception:
        return 0.0


def process_rss_mb() -> float:
    try:
        import psutil
        mi = psutil.Process().memory_info()
        # memoria anonima (rss - pagine file mappate): il memmap dell'audio è cache di file, non RAM allocata
        return round((mi.rss - getattr(mi, "shared", 0)) / 1e6, 1)
    except Exception:
        return 0.0
