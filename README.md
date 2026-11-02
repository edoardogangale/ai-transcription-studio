# AI Transcription Studio

Applicazione **privata e locale** per trascrivere registrazioni (soprattutto lezioni di 1–3 ore) in italiano e inglese con modelli open source. Nessun account, nessun cloud, nessuna API a pagamento: l'audio non lascia mai il tuo computer.

- **Backend**: Python 3.11+, FastAPI, FFmpeg, SQLite, sherpa-onnx (unico runtime per tutti i modelli).
- **Frontend**: HTML/CSS/JS senza build, responsive (iPad, PC, smartphone), tema chiaro/scuro, installabile come PWA.

> Progetto indipendente: non ha alcun legame con altri repository.

## Avvio rapido

Requisiti: **Python 3.11+** e **FFmpeg** (`sudo apt install ffmpeg` · `brew install ffmpeg` · `winget install Gyan.FFmpeg`).

```bash
./scripts/start.sh                 # solo questo computer → http://localhost:8000
./scripts/start.sh --lan           # raggiungibile da iPad/altri PC, protetto da token
./scripts/start.sh --lan --https   # come sopra con HTTPS autofirmato (serve per microfono/condivisione da iPad)
```
Windows: `scripts\start.bat` oppure `scripts\start.bat lan`. Lo script crea il virtualenv, installa le dipendenze e stampa indirizzo e token.
Poi: **Modelli AI → Installa** (i pesi si scaricano solo quando lo chiedi, da GitHub: niente account, token o Hugging Face) → **Nuova trascrizione** oppure **Live**.

## Funzioni

| Cosa | Come funziona |
|---|---|
| **Cartelle (materie › argomenti)** | Crea materie e sotto-cartelle, sposta con trascinamento o da menu. **Memoria**: ogni cartella ricorda lingua, modello, contesto e opzioni dell'ultimo lavoro e li riproponi alla prossima trascrizione. L'archivio ricorda anche l'ultima cartella aperta. |
| **Ricerca in tutto l'archivio** | Cerca dentro il testo di *tutte* le trascrizioni (SQLite FTS5: ignora accenti e maiuscole, accetta prefissi) e mostra l'estratto. Si aggiorna quando correggi il testo. |
| **Trascrizione live** | Registri dal microfono e il testo compare frase per frase. Note ed evidenziazioni in diretta (★ ultimi 5–60 s, ✎ nota) agganciate al tempo dell'audio. Alla fine l'audio diventa m4a e la trascrizione è normale: puoi **ritrascrivere** lo stesso audio con un modello più accurato. |
| **Copia / PDF unico** | Pulsante ⧉ su ogni trascrizione. Selezionando più registrazioni: **Copia testo** (tutte insieme), **PDF unico** (una dopo l'altra, con indice), DOCX, TXT. Le esportazioni includono evidenziazioni (giallo) e note. |
| **Condividere gli audio** | Foglio di condivisione del sistema con i file veri (Web Share) quando il browser lo permette (serve HTTPS); altrimenti scarica il file, o uno ZIP per più registrazioni. |
| **Più audio insieme** | Carichi molti file: si caricano in parallelo (3) e **partono da soli appena caricati**; le trascrizioni girano in parallelo (1–4, Impostazioni). |
| **Lavoro in background** | Trascrizione e salvataggio dell'audio live avvengono sul server: continuano anche chiudendo la pagina. Centro attività (come i download) con caricamenti, trascrizioni, download dei modelli, registrazione; notifiche di sistema di avanzamento/fine. Vedi "Background: cosa è garantito". |
| **Ascolto con testo evidenziato** | Vista *Ascolto*: parola corrente evidenziata e sottolineata, parole già dette colorate, il resto attenuato, scorrimento automatico, clic su una parola per ripartire da lì. Con timestamp per parola (Parakeet) è preciso; con Whisper è una **stima** proporzionale (lo dichiara). Vista *Modifica* per correggere. |
| **Chi parla** | Riconoscimento dei parlanti locale (pyannote segmentation 3.0 + WeSpeaker). L'insegnante = chi parla di più (modificabile). Le altre voci sono nascoste ed escluse da copia/PDF (si possono mostrare), oppure **non trascritte affatto** ("solo l'insegnante": più veloce). |

## Modelli (tre per lingua + due veloci)

Un solo runtime, **sherpa-onnx** (k2-fsa, Apache-2.0); pesi dalle release GitHub di sherpa-onnx. Le dimensioni sono **misurate** (Content-Length reale).

| | Modello | Download | Note |
|---|---|---|---|
| **IT** | NVIDIA **Parakeet TDT 0.6B v3** | 487 MB | multilingue (25 lingue), timestamp **per parola**, il più veloce |
| **IT** | OpenAI **Whisper Large V3 Turbo** | 564 MB | accuratezza vicina al Large V3, ~10× più rapido su CPU |
| **IT** | OpenAI **Whisper Large V3** | 1,07 GB | più accurato nella fonte citata; **molto lento su CPU** |
| **EN** | NVIDIA **Parakeet TDT 0.6B v2** (solo inglese) | 482 MB | timestamp per parola |
| **EN** | Whisper Large V3 Turbo · Whisper Large V3 | come sopra | |
| **Veloci** | Whisper **Base** · Whisper **Tiny** | 208 MB · 116 MB | molto meno accurati: bozze o PC lenti |

Con "Rilevamento automatico" sono proposti i tre modelli con rilevamento lingua.

### Misure reali (eseguite in sviluppo)

4 core CPU, nessuna GPU, **36 s di italiano sintetico** (voci TTS, 95 parole). La **velocità** (RTF = secondi di calcolo / secondi di audio) è un buon ordine di grandezza; il **WER** su un campione così piccolo e sintetico è solo **indicativo** e non rappresenta una classe reale.

| Modello | WER | Velocità | Una lezione di 2 h su 4 core |
|---|---|---|---|
| Parakeet v3 | 10,5% | 0,08× (12× più veloce del reale) | ~10 min |
| Whisper Turbo | 4,2% | 0,50× | ~1 h |
| Whisper Large V3 | 4,2% | **5,52×** | **~11 h** (pensato per GPU) |
| Whisper Base | 29,5% | 0,19× | ~23 min |
| Whisper Tiny | 37,9% | 0,11× | ~13 min |

L'app mostra anche la velocità **misurata sul tuo PC** man mano che trascrivi (esclude i lavori con riconoscimento parlanti). Inglese verificato con la frase di prova inclusa nei pacchetti (tutti i modelli installati la trascrivono correttamente).

### Come sono stati scelti (ricerca)

- Fonte confrontata sull'**italiano** (FLEURS, pesi quantizzati, aggregatore terzo → indicativa, non model card): Whisper Large V3 2,54% · Turbo 2,77% · Parakeet v3 3,02% · Canary-1B v2 3,10% ([models.handy.computer](https://models.handy.computer/languages/it)).
- Parakeet v3: WER medio 6,34% sull'Open ASR Leaderboard **in inglese** ([openwhispr](https://openwhispr.com/it/blog/parakeet-vs-whisper-vs-nemotron)).
- Panoramiche 2026 consultate: [Gladia](https://www.gladia.io/blog/best-open-source-speech-to-text-models), [Northflank](https://northflank.com/blog/best-open-source-speech-to-text-stt-model-in-2026-benchmarks), [Pinggy](https://pinggy.io/blog/best_open_source_self_hosted_speech_to_text_models/), [MarkTechPost](https://www.marktechpost.com/2026/07/23/best-open-speech-recognition-asr-models-in-2026-wer-languages-latency-and-license-compared/). Concordano che Whisper resta il riferimento per copertura linguistica e Parakeet per velocità; le classifiche cambiano con la data.
- **"Parakeet Ultra" non esiste** in nessuna fonte: sostituito con il v3 reale.
- **Voxtral Mini 4B Realtime è stato rimosso**: richiedeva GPU da 16 GB, non ho trovato né benchmark né un modo di eseguirlo/verificarlo. **Canary-1B v2** non è distribuito nel formato usato da sherpa-onnx (asset 404).
- **Modelli più recenti visti nella ricerca e NON integrati** (nessun percorso di esecuzione che potessi scaricare e verificare qui): Cohere Transcribe (2B, ~5,4% WER inglese), IBM Granite Speech 4.1 2B, NVIDIA Canary-Qwen 2.5B, Qwen3-ASR, Nemotron 3.5 ASR. Se cambi idea, aggiungere un modello = una voce in `backend/app/registry.py` + un adattatore in `adapters.py`.
- Il modello **consigliato** è un'euristica dichiarata sulle misure sopra (CPU → Turbo, GPU → Large V3), non una classifica di accuratezza.

## Riconoscimento dei parlanti: come funziona e cosa ho misurato

La diarizzazione gira **prima** della trascrizione e i cambi di voce diventano i confini dei pezzi da trascrivere: ogni pezzo ha un solo parlante (anche se un compagno interrompe a metà frase) e le voci estranee possono essere saltate.
Verificato su audio sintetico con due voci: confini dei turni entro ~0,2 s dalla verità; l'insegnante identificata in tutti gli interventi; con "solo insegnante" le frasi del compagno ("quaderno", "mensa") non entrano nel testo e il WER dell'insegnante è ~5%.
**Limiti**: sono due voci TTS, non una classe vera con rumore e voci simili. Senza indicare il numero di voci, una stessa voce con frasi brevi può essere divisa in "Voce 2/Voce 3" (soglia 0,5: sotto 0,6 divide, da 0,6 in su fonde tutto, incluso l'insegnante); indicando il numero di voci ("2") le separa correttamente. L'embedding è addestrato su voci in inglese (VoxCeleb). Il passo richiede l'audio intero in RAM (~0,7 GB per 3 ore): è l'unico non a memoria costante. Se sbaglia, correggi nell'editor (cambia insegnante, rinomina, riassegna un segmento).

## Live: come funziona

Il browser invia PCM 16 kHz via WebSocket; il server salva subito l'audio su disco (recuperabile se tutto si interrompe), rileva le pause con un VAD a energia e trascrive ogni frase appena finisce. Il **ritardo reale** (audio ricevuto − audio trascritto) è mostrato in pagina: se il modello è più lento del tempo reale cresce. Prima di registrare l'app mostra la velocità del modello scelto. Verificato con Parakeet vero (microfono finto che riproduce la lezione): frasi trascritte in diretta, WER 8,4%, audio m4a salvato, note ed evidenziazioni persistite. Non verificato su un microfono reale né su iPad.

## Background: cosa è garantito (e cosa no)

- ✔ **Trascrizioni** e salvataggio dell'audio live sono sul server: continuano a prescindere dal browser.
- ✔ I caricamenti e la registrazione proseguono se cambi pagina nell'app (stato globale), con schermo tenuto acceso (Wake Lock), notifica persistente "● Registrazione in corso", controlli multimediali e riconnessione automatica che **reinvia l'audio non confermato**.
- ✔ Notifiche di sistema di avanzamento e completamento mentre la pagina è aperta, anche in secondo piano.
- ✘ **Browser e sistema possono sospendere il microfono** se l'app va in background o lo schermo si blocca, soprattutto su iPad/iPhone. Per lezioni lunghe tieni l'app aperta sullo schermo o registra con Memo Vocali e **carica** il file (poi la trascrizione prosegue sul server).
- ✘ **Notifiche ad app completamente chiusa**: richiederebbero Web Push (chiavi VAPID, HTTPS e, per forza di cose, servizi push di Apple/Google). **Non implementato**, per non introdurre servizi esterni. Un caricamento in corso si interrompe se chiudi la pagina.

## Uso dall'iPad

Un browser HTML **non può eseguire modelli Python installati su un altro dispositivo**: l'iPad è solo lo schermo; i modelli girano sul computer dove avvii l'app.
1. Avvia con `--lan` (stessa rete Wi-Fi) e apri sull'iPad l'indirizzo stampato; inserisci il token.
2. Safari: *Condividi → Aggiungi a Home* per installarla come PWA.
3. **Microfono e condivisione file richiedono HTTPS**: usa `--lan --https` e fidati del certificato autofirmato. Senza HTTPS la registrazione live non parte (l'app lo dice) e "Condividi audio" scarica il file.
4. Non esporre mai la porta su Internet: il token protegge l'accesso in rete locale, non è pensato per l'esposizione pubblica.

## Come funziona la trascrizione

1. **Upload** a blocchi su disco con SHA-256 e verifica ffprobe (formato, durata, integrità).
2. **Conversione** FFmpeg → PCM 16 kHz mono su disco (normalizzazione loudnorm e riduzione rumore `afftdn` opzionali).
3. **VAD a energia** e **segmentazione ai silenzi**: finestre ≤ 28 s (18 s per Whisper, per timestamp più fini) tagliate nella pausa più lunga, senza sovrapposizione (nessuna parola persa o duplicata, testato). Il VAD non è neurale: con rumore forte può scambiare il rumore per parlato.
4. **Inferenza** una finestra per volta da `np.memmap` (file da 3 ore a memoria costante, testato); risultato intermedio salvato a ogni finestra.
5. Annulla/Riprendi (anche dopo riavvio), nessun duplicato (stesso audio+modello+opzioni riapre l'esistente), modello scaricato dalla memoria a coda vuota.

Avanzamento: solo conteggi reali ("segmento 3 di 12"), nessuna percentuale o tempo rimanente inventati.

## Modalità e vocabolario

- **A Fedele**: testo del modello con le tue correzioni. **B Pulita**: regole deterministiche (toglie solo intercalari tipo "ehm" e raddoppi di parole funzione; paragrafi dalle pause; nessun LLM). **C Appunti**: richiede un LLM locale via [Ollama](https://ollama.com); senza, è dichiarata indisponibile; l'output è marcato come rielaborazione AI.
- **Vocabolario**: con questo runtime nessun modello accetta un prompt/glossario, quindi i termini (contesti Matematica, Fisica, … più i tuoi) generano solo **suggerimenti di correzione** nell'editor (parole molto simili a un termine): li applichi tu con un clic, **mai sostituzioni automatiche**.

## Test

```bash
./scripts/test.sh            # 47 test backend (~20 s); --slow aggiunge il file sintetico da 190 minuti
STUDIO_REAL=1 STUDIO_DATA=/percorso/data STUDIO_TEST_EN=en.wav STUDIO_TEST_WAV=... STUDIO_TEST_TRUTH=... \
  pytest backend/tests/real_models     # test con MODELLI VERI (genera l'audio con real_models/make_speech.py)
node tests/e2e/e2e_mock.mjs ...        # browser, tutti i flussi (server con STUDIO_ENABLE_MOCK=1)
node tests/e2e/e2e_real.mjs ...        # browser con modelli veri (server normale)
```
**Superati in sviluppo**: 47 test backend (pipeline, cartelle, ricerca, PDF unico, ZIP audio, parallelismo reale, live via WebSocket, recupero dopo crash, filtro insegnante…); 4 test con modelli veri (parlanti + solo insegnante, live, tutti i modelli in inglese); **57 controlli nel browser** con mock (cartelle, 3 file in parallelo con avvio automatico, copia multipla, PDF unico, condivisione, evidenziazione parola per parola, note, live con microfono finto, responsive iPad/smartphone) e **19 con modelli veri** (parola evidenziata coerente con i tempi del modello, salto alla parola, voci estranee escluse, live).
Il mock (`STUDIO_ENABLE_MOCK=1`) aggiunge due schede "MOCK" chiaramente etichettate; non esiste in uso normale.

## Cosa NON è stato verificato

- **Parlato reale**: tutti i test di accuratezza usano voce sintetica; il WER su lezioni vere (rumore, accenti, termini tecnici) è **sconosciuto**. Usa *Confronta modelli* + WER con un riferimento corretto a mano per decidere.
- **GPU**: nessuna disponibile; il provider CUDA di sherpa-onnx richiede la sua build CUDA (non installata né provata). Su CPU tutto è provato.
- **iPad/Safari reali**: HTTPS, microfono, Web Share, notifiche e comportamento in background sono descritti ma provati solo su Chromium.
- **Licenze** dei modelli: riportate da fonti terze, da confermare sulle model card. Ollama/appunti con LLM presente non provato (solo il caso "assente").
- Audio di durata 2–3 ore con modelli veri: la segmentazione è provata su 190 minuti sintetici, l'inferenza reale solo su file brevi.

## Privacy

Tutto è locale (`data/`: audio, database, pesi). Nessuna telemetria. Accessi di rete: solo il download dei pesi da GitHub (su tua richiesta) e, se lo usi, Ollama su `127.0.0.1`. Eliminare una trascrizione rimuove **definitivamente** anche l'audio (se non usato da altre).

## Struttura

```
backend/app/   main.py (API) · engine.py (coda parallela, cache modelli) · live.py (sessioni live) · audio.py (VAD/chunking)
               adapters.py · registry.py (modelli, misure) · installer.py · diarization.py · exports.py · db.py (FTS, cartelle, note)
backend/tests/ test automatici (+ real_models/ con modelli veri)     tests/e2e/  collaudo nel browser
frontend/      core.js (router, attività, notifiche) · library.js · new.js · live.js · editor.js · misc.js · style.css · sw.js
scripts/       start.sh · start.bat · test.sh
```
