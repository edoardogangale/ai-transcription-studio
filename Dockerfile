# Immagine per far girare l'app su un server/NAS/Mac con Docker. I dati (modelli, audio, archivio) vanno in un VOLUME:
# i modelli si scaricano una volta sola e restano anche se aggiorni l'immagine.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend ./backend
COPY frontend ./frontend
ENV STUDIO_DATA=/data PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8000
HEALTHCHECK CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/api/health')" || exit 1
CMD ["python", "-m", "uvicorn", "app.main:app", "--app-dir", "backend", "--host", "0.0.0.0", "--port", "8000"]
