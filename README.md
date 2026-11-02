# AI Transcription Studio

Applicazione **privata e locale** per trascrivere registrazioni (soprattutto lezioni di 1–3 ore) in italiano e inglese con modelli open source. Nessun account, nessun cloud, nessuna API a pagamento: l'audio non lascia mai il tuo computer.

- **Backend**: Python 3.11+, FastAPI, FFmpeg, SQLite, coda di lavori in background.
- **Frontend**: HTML/CSS/JS senza build, responsive (iPad, PC, smartphone), tema chiaro/scuro, installabile come PWA.

> Progetto indipendente. Non ha alcun legame con altri repository.

## Avvio rapido

Requisiti: **Python 3.11+** e **FFmpeg** (`sudo apt install ffmpeg` · `brew install ffmpeg` · `winget install Gyan.FFmpeg`).

```bash
./scripts/start.sh                 # solo questo computer → http://localhost:8000
./scripts/start.sh --lan           # raggiungibile da iPad/altri PC, protetto da token
./scripts/start.sh --lan --https   # come sopra con HTTPS autofirmato (necessario per il microfono da iPad)
```
Windows: `scripts\start.bat` oppure `scripts\start.bat lan`.

Lo script crea il virtualenv, installa le dipendenze e stampa l'indirizzo e il token da usare.
Poi: **Modelli AI → Installa** (i pesi si scaricano solo quando lo chiedi) → **Nuova trascrizione**.

## Uso dall'iPad (importante)

Un browser HTML **non può eseguire modelli Python installati su un altro dispositivo**: l'iPad è solo lo schermo. I modelli girano sul computer/server in cui avvii l'app; l'iPad invia l'audio al backend sulla rete locale e riceve il testo. Quindi:

1. Avvia sul computer con `--lan` (computer e iPad sulla stessa rete Wi-Fi).
2. Apri sull'iPad l'indirizzo stampato e inserisci il token.
3. In Safari: *Condividi → Aggiungi a Home* per installarla come PWA.
4. **Registrazione dal microfono**: Safari la consente solo in contesto sicuro. Da iPad su indirizzo di rete locale serve HTTPS (`--https`, accetta il certificato autofirmato; su iOS potrebbe servire installarlo/fidarsene da Impostazioni). In alternativa registra con l'app Memo Vocali e carica il file. Su `localhost` il microfono funziona senza HTTPS.
5. Non esporre mai la porta su Internet: il token protegge l'accesso in rete locale, ma il server non è pensato per l'esposizione pubblica.

## I sei modelli (tre per lingua)

| Lingua | Modello | Runtime | Note |
|---|---|---|---|
| IT | NVIDIA **Parakeet TDT 0.6B v3** | onnx-asr / ONNX Runtime (CPU o GPU) | multilingue, timestamp per parola, nessun prompt |
| IT | OpenAI **Whisper Large V3** | faster-whisper (CTranslate2) | supporta glossario (`initial_prompt`), rilevamento lingua |
| IT | Mistral **Voxtral Mini 4B Realtime** | transformers, **sperimentale**, solo GPU | timestamp solo a segmento |
| EN | NVIDIA **Parakeet TDT 0.6B v2** | onnx-asr | solo inglese |
| EN | OpenAI **Whisper Large V3** | faster-whisper | |
| EN | Mistral **Voxtral Mini 4B Realtime** | transformers, sperimentale | |

### Decisioni sulla selezione (da leggere)

- **"Parakeet Ultra" non è stato trovato.** Nessuna fonte consultata ne indica l'esistenza: per l'italiano è stato usato **Parakeet TDT 0.6B v3** (multilingue, italiano incluso).
- Per l'inglese ho usato il **v2** (addestrato solo su inglese) anziché il v3 richiesto, per non avere due schede identiche nelle due liste. Se preferisci il v3 anche per l'inglese basta cambiare una riga in `backend/app/registry.py` (`BY_LANGUAGE["en"]`). Non ho potuto verificare in questa sessione quale dei due sia più accurato in inglese.
- Un modello che supporta entrambe le lingue compare in entrambe le liste, come richiesto: sempre esattamente tre per lingua. Con "Rilevamento automatico" sono proposti solo i modelli con rilevamento lingua (Parakeet v3, Whisper).
- **Benchmark**: nell'interfaccia compare solo un dato con fonte reale (il WER medio di Parakeet v3 su Open ASR Leaderboard, solo inglese). Per tutti gli altri c'è scritto "nessun benchmark verificato". La velocità è "non misurata su questo PC". Non sono stati inseriti numeri inventati.
- **Il modello consigliato** è un'euristica dichiarata (CPU → Parakeet, il più leggero; GPU → Whisper, l'unico con supporto al vocabolario), **non** una classifica di accuratezza.

## Cosa NON è stato verificato (stato onesto)

L'ambiente di sviluppo non poteva raggiungere `huggingface.co` (proxy: 403) e non aveva GPU. Quindi:

| Verificato | Non verificato |
|---|---|
| Tutta la pipeline (upload, validazione, conversione, VAD, segmentazione, coda, annullamento/ripresa, timestamp, salvataggio, esportazioni, editor, confronto, auth, responsive) con un **adattatore finto** di test | **L'inferenza reale di tutti e tre i modelli** (nessun checkpoint scaricato, nessuna trascrizione reale eseguita) |
| Le librerie `faster-whisper` e `onnx-asr` si installano e si importano; `onnx-asr` elenca ufficialmente Parakeet TDT 0.6B v2 e v3 e il formato dei risultati con timestamp (letto dal codice installato) | Esistenza dei checkpoint su Hugging Face, **licenze**, dimensioni di download, requisiti RAM/VRAM (le soglie in app sono prudenziali, non misurate) |
| Percorso di errore del download (rete bloccata → errore chiaro, nessun crash) | Download reale con avanzamento; che i file `*.int8.onnx` filtrati in `installer.py` esistano con quel nome |
| Il test con 190 minuti di audio sintetico (solo segmentazione) resta a memoria costante | Accuratezza (WER) di qualunque modello su parlato reale; qualità del VAD a energia su rumore reale |
| | Adattatore Voxtral (scritto sulla documentazione generale, può richiedere correzioni), diarizzazione pyannote, appunti con Ollama (percorso "LLM assente" testato, quello "LLM presente" no) |

**Primo passo consigliato sul tuo computer**: installa un modello, trascrivi un file di 2–3 minuti, e se qualcosa non va guarda i log del terminale: gli adattatori sono corti (`backend/app/adapters.py`) e facili da correggere. Poi usa **Confronta modelli** + WER con una trascrizione di riferimento corretta a mano per scegliere il modello migliore per le tue lezioni.

## Come funziona la trascrizione

1. **Upload** a blocchi su disco (mai il file intero in RAM) con SHA-256 e verifica ffprobe (formato, durata, integrità): i file danneggiati sono rifiutati con un messaggio.
2. **Conversione** FFmpeg → PCM 16 kHz mono su disco (opzioni: normalizzazione loudnorm, riduzione rumore `afftdn`).
3. **VAD a energia** (soglia adattiva, con hangover) e **segmentazione ai silenzi**: finestre ≤ 28 s tagliate nella pausa più lunga disponibile, **senza sovrapposizione** perché il taglio cade nel silenzio (nessuna parola persa né duplicata, testato). Se non esiste pausa si taglia al punto più silenzioso. Il VAD non è neurale: con rumore forte può considerare parlato anche il rumore.
4. **Inferenza** una finestra per volta leggendo da `np.memmap`; **risultato intermedio salvato a ogni finestra**.
5. Ricostruzione con timestamp assoluti; rimozione dei cicli di allucinazione (stesso testo ≥3 volte di fila).
6. Salvataggio in SQLite; memoria del modello liberata a coda vuota.

**Avanzamento**: mostra solo conteggi reali ("segmento audio 3 di 12"). Nessuna percentuale o tempo rimanente inventati. **Annulla** ferma il job tra una finestra e l'altra; **Riprendi** continua dai segmenti già fatti (anche dopo un riavvio dell'app). **Duplicati**: stesso audio+modello+lingua+opzioni riapre la trascrizione esistente.

## Modalità

- **A Fedele**: testo del modello con le tue correzioni.
- **B Pulita**: regole deterministiche, senza LLM. Rimuove solo intercalari non lessicali (ehm, uhm, um…) e raddoppi di parole funzione ("il il"); crea paragrafi dalle pause. La punteggiatura è quella del modello ASR (non viene inventata). Le ripetizioni potenzialmente significative ("no no no") restano.
- **C Appunti strutturati**: richiede un **LLM locale** via [Ollama](https://ollama.com) (`ollama pull <modello>`). Senza LLM la modalità è dichiarata indisponibile. L'output è marcato come rielaborazione AI, distinta dal testo pronunciato, e il prompt vieta di aggiungere informazioni.

## Vocabolario scolastico

Contesti: Matematica, Fisica, Chimica, Filosofia, Storia, Italiano, Inglese, Scienze, Altro, più i tuoi termini (Impostazioni). Sono usati **solo** così:
1. con **Whisper**, come `initial_prompt` (meccanismo supportato dal modello);
2. con tutti i modelli, come **suggerimenti** nell'editor (parole molto simili a un termine del glossario): li applichi tu con un clic. **Nessuna sostituzione automatica.** Parakeet e Voxtral non hanno un meccanismo di prompt.

## Editor, confronto, esportazione

- **Editor**: player con velocità 0,75–2×, forma d'onda cliccabile, timeline, segmento attivo evidenziato, ricerca (insensibile ad accenti/maiuscole), testo modificabile con **salvataggio automatico**. Cliccare una parola riporta l'audio a quel punto: se il modello dà timestamp per parola il salto è preciso (finché il segmento non è modificato; dopo una modifica è una stima proporzionale), altrimenti si riparte dall'inizio del segmento e l'interfaccia lo dichiara.
- **Confronta modelli** (2–3): stessi audio, risultati affiancati, differenze a livello di parola con riproduzione del punto, tempo di elaborazione, parole, memoria di picco (RAM anonima del processo; **non** include la VRAM). La differenza tra trascrizioni non è presentata come accuratezza: il **WER** si calcola solo se incolli un riferimento verificato.
- **Esporta**: TXT, PDF, DOCX, SRT, VTT, JSON (segmenti e parole con timestamp), in UTF-8 con accenti. Il PDF usa DejaVu Sans se presente nel sistema, altrimenti Helvetica.

## Modelli AI: gestione

Installa/elimina i pesi, avanzamento reale (byte su disco / byte totali), spazio occupato, dispositivo (Auto/CPU/GPU) in Impostazioni. Se un modello non è compatibile (es. Voxtral senza GPU, RAM/VRAM sotto soglia), la scheda spiega il motivo e l'avvio è bloccato lato server. Nessun download parte da solo.
GPU: sostituisci `onnx-asr[cpu,hub]` con `onnx-asr[gpu,hub]` in `requirements.txt` e usa un CUDA compatibile. Per Voxtral: `pip install -r requirements-voxtral.txt`.

## Privacy

Tutto è locale (`data/`: audio, database, pesi). Nessuna telemetria. Gli unici accessi di rete sono il download dei pesi da Hugging Face (su tua richiesta) e, se lo usi, Ollama su `127.0.0.1`. Elimina una trascrizione dall'editor per rimuovere **definitivamente** anche l'audio (se non usato da altre trascrizioni).

## Test

```bash
./scripts/test.sh            # 29 test backend (~10 s)
./scripts/test.sh --slow     # + file sintetico da 190 minuti (verifica memoria costante)
```
Collaudo nel browser (Chromium, Playwright) in `tests/e2e/e2e.mjs`: va eseguito con il server avviato con `STUDIO_ENABLE_MOCK=1`, che aggiunge due schede "MOCK (solo test)" chiaramente etichettate, non presenti in uso normale.
Copre: upload, durata/dimensione, lingua, selezione modello e incompatibilità, trascrizione, click su parola/timestamp → audio, velocità, ricerca, modifica + salvataggio + accenti, modalità, esportazione, tema, assenza di scroll orizzontale su iPad (verticale/orizzontale) e smartphone, confronto, pagina modelli.

## Struttura

```
backend/app/   main.py (API) · engine.py (coda) · audio.py (VAD/chunking) · adapters.py (modelli)
               registry.py (modelli/compatibilità) · installer.py · postprocess.py · exports.py · vocab.py …
backend/tests/ test automatici          frontend/  PWA (index.html, app.js, style.css, sw.js)
scripts/       start.sh · start.bat · test.sh
```
