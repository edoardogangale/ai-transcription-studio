@echo off
REM Avvio di AI Transcription Studio (Windows). Usa "start.bat lan" per l'accesso da iPad in rete locale.
cd /d "%~dp0\.."
if "%STUDIO_DATA%"=="" set STUDIO_DATA=%USERPROFILE%\.ai-transcription-studio
if not exist "%STUDIO_DATA%" mkdir "%STUDIO_DATA%"
where ffmpeg >nul 2>nul || (echo ERRORE: FFmpeg non trovato. Installalo con: winget install Gyan.FFmpeg & exit /b 1)
if not exist .venv (py -3.11 -m venv .venv || py -3 -m venv .venv)
call .venv\Scripts\activate.bat
pip install -q -r requirements.txt
if not exist data mkdir data
set HOST=127.0.0.1
if /i "%1"=="lan" (
  set HOST=0.0.0.0
  if not exist "%STUDIO_DATA%\token.txt" python -c "import secrets;print(secrets.token_urlsafe(18))" > "%STUDIO_DATA%\token.txt"
  set /p STUDIO_TOKEN=<"%STUDIO_DATA%\token.txt"
  echo Token di accesso: %STUDIO_TOKEN%
  echo Apri da iPad: http://IP-DI-QUESTO-PC:8000
)
python -m uvicorn app.main:app --app-dir backend --host %HOST% --port 8000
