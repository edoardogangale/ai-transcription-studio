# AI Transcription Studio

Applicazione **privata e locale** per trascrivere registrazioni (soprattutto lezioni di 1–3 ore) in italiano e inglese con modelli open source. Nessun account, nessun cloud, nessuna API a pagamento: l'audio non lascia mai il tuo computer.

- **Backend**: Python 3.11+, FastAPI, FFmpeg, SQLite, sherpa-onnx (unico runtime per tutti i modelli).
- **Frontend**: HTML/CSS/JS senza build, responsive (iPad, PC, smartphone), tema chiaro/scuro, installabile come PWA.

> Progetto indipendente: non ha alcun legame con altri repository.

## Come la avvio? (scegli UNA strada)

L'app ha due parti: i **modelli AI** girano su un computer/server (non nel browser: un browser non può eseguire modelli Python), e l'**iPad** è lo schermo. Serve quindi un posto dove farla girare.

### A) Hai solo l'iPad → GitHub Codespaces (gratis, nessun computer)
1. Sull'iPad apri **github.com** in Safari, entra nel tuo account, apri la repository **ai-transcription-studio**.
2. Tocca **Code → Codespaces → Create codespace on main** (la prima volta ci vogliono 2–3 minuti: installa tutto da solo e **avvia l'app**).
3. Si apre l'editor: nel terminale in basso vedi un riquadro con **l'indirizzo** (`https://….app.github.dev`) e il **codice amministratore**. Se non lo vedi: scheda **PORTE** → porta 8000 → icona del globo; il codice è in `~/.ai-transcription-studio/token.txt` (`cat` dal terminale).
4. Apri l'indirizzo, inserisci il codice. **Condividi → Aggiungi a Home**: ora è un'app sul tuo iPad.
5. **Modelli AI → Installa** (Parakeet v3 + Whisper Turbo bastano) — **una volta sola**: restano salvati nel Codespace anche quando si ferma per inattività. Non eliminare il Codespace e non dovrai riscaricare nulla.
6. Dalle volte successive: da GitHub → Codespaces → riprendi il tuo (l'app riparte da sola); oppure, se è ancora acceso, apri direttamente l'icona sulla Home.

*Limiti onesti*: i Codespaces gratuiti hanno una quota mensile di ore e spazio (l'ordine di grandezza è ~120 ore-core e ~15 GB al mese: **controlla** in GitHub → Settings → Billing, può cambiare); il Codespace si ferma dopo un po' di inattività e va ripreso; CPU a 4 core, niente GPU (quindi Parakeet/Turbo sì, Whisper Large V3 no). Questa strada **non è stata provata qui**: i file `.devcontainer` e gli script sono scritti e controllati nella parte che posso eseguire, ma non ho potuto avviare un vero Codespace.

#### Far durare la quota gratuita di Codespaces
GitHub conta le **ore-core** (una macchina da 4 core accesa 1 ora = 4 ore-core). Per un account gratuito l'ordine di grandezza che ricordo è **~120 ore-core e ~15 GB di spazio al mese** (**verificalo** su github.com/settings/billing → Codespaces: può cambiare). Quanto "costa" una lezione di 2 ore, dalle mie misure su 4 core (potrebbero differire sul loro hardware):
| Modello | Tempo di calcolo | Ore-core consumate |
|---|---|---|
| Parakeet v3 | ~10 min | ~0,6 |
| Whisper Turbo | ~1 ora | ~4 |
| **Registrazione live di 2 h** | **2 ore (tutta la durata)** | **~8** |
Quindi: **registra con Memo Vocali e carica il file dopo** (non col live per tutta la lezione), usa **Parakeet** di solito e Turbo solo quando serve, carica **più file insieme** e poi spegni. **Spegni il Codespace appena finito** (GitHub → Codespaces → ⋯ → Stop) e imposta il timeout di inattività al minimo (github.com/settings/codespaces → *Default idle timeout*): il tempo da fermo conta.

#### Se la quota è finita
1. **Aspetta il reset mensile**: i dati restano; esporta prima i PDF che ti servono (non puoi aprire l'app finché è spento).
2. **Paga a consumo**: in Settings → Billing imposti tu un limite di spesa (di base è 0 €, quindi si blocca e basta). Il costo orario è basso ma controlla i prezzi attuali su GitHub.
3. **Usa un computer** (di casa, di un compagno, della scuola): è gratis e senza limiti. Basta `./scripts/start.sh --lan`; i modelli si scaricano la prima volta.
4. **Server sempre acceso** (avanzato): una VM con Docker (`docker compose up -d`). L'offerta gratuita di Oracle Cloud è **da verificare**: le fonti che ho trovato sono discordanti e diverse indicano che nel 2026 l'allocazione ARM gratuita sarebbe stata ridotta (≈2 core / 12 GB) ([Oracle Always Free 2026](https://space-node.net/blog/oracle-cloud-always-free-limits-2026), [InfoQ](https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/)). Non l'ho provata né la compatibilità ARM. Servizi come Hugging Face Spaces o Colab gratuiti li sconsiglio: il disco si cancella a ogni riavvio, quindi dovresti riscaricare i modelli (e gli audio passerebbero da server altrui).

### B) Hai un computer (Mac/Windows/Linux) → lo avvii lì
Requisiti: **Python 3.11+** e **FFmpeg** (`brew install ffmpeg` · `winget install Gyan.FFmpeg` · `sudo apt install ffmpeg`).
```bash
./scripts/start.sh                 # solo su questo computer → http://localhost:8000
./scripts/start.sh --lan           # raggiungibile dall'iPad (stesso Wi-Fi), con codice di accesso
./scripts/start.sh --lan --https   # come sopra con HTTPS autofirmato (serve per microfono e condivisione da iPad)
```
Windows: `scripts\start.bat` oppure `scripts\start.bat lan`. Poi sull'iPad apri l'indirizzo stampato e inserisci il codice. Con un Mac Apple Silicon la correzione AI è molto più veloce.
**Dall'iPad fuori casa** (e per i compagni): [Tailscale](https://tailscale.com) (gratuito) dà un indirizzo HTTPS privato al tuo computer: `tailscale serve --bg 8000`. Non esporre mai la porta direttamente su Internet.

### C) Un server/NAS con Docker
`docker compose up -d` (imposta `STUDIO_TOKEN` con un codice tuo). I modelli stanno nel volume `studio-data`: si scaricano una volta sola.

### I modelli si scaricano UNA volta sola
Stanno **fuori dalla cartella del progetto**: `~/.ai-transcription-studio/models` (Codespaces: nella home del Codespace; Docker: volume). Aggiornare o riscaricare il progetto non li tocca; la pagina *Modelli AI* ti dice dove sono e ti avvisa se la posizione non è persistente. Ripetere il download serve solo se **elimini tu** il Codespace/volume o la cartella.

### Avere l'app sull'iPad SENZA avviare ogni volta un Codespace (ricerca)
Premessa: i modelli devono girare *da qualche parte*. Le strade realistiche, in ordine di praticità:
| Strada | Com'è | Costo | Note onesti |
|---|---|---|---|
| **Un computer di casa sempre acceso + Tailscale** | L'icona sulla Home dell'iPad apre l'app **subito**, da casa e fuori, con HTTPS | gratis (corrente) | È la soluzione migliore se hai un Mac/PC/mini-PC da lasciare acceso. `./scripts/start.sh --lan` + `tailscale serve --bg 8000` ([Tailscale](https://tailscale.com)). Non provata qui. |
| **VPS sempre acceso** | Come sopra, senza computer di casa | a pagamento (l'offerta gratuita di Oracle sembra ridotta: vedi sopra) | `docker compose up -d`. Non provato. |
| **Codespaces con meno attrito** | Resta com'è, ma si riavvia in un tocco | gratis (quota) | Timeout di inattività più lungo (github.com/settings/codespaces) e un'automazione di **Comandi Rapidi** che chiama l'API di GitHub per avviare il Codespace (`POST /user/codespaces/{nome}/start`, serve un token con permesso Codespaces). **Non provato**; il token resta salvato sull'iPad: usa un token a scadenza e con il solo permesso necessario. |
| **App interamente sull'iPad, senza server** | Nessun server | gratis | **Oggi non c'è un'opzione buona con le funzioni di questa app.** (1) *Nel browser* (Whisper in WebGPU/WASM, [transformers.js](https://github.com/huggingface/transformers.js/issues/1739)): su Safari/iPad i limiti di memoria per scheda sono stretti, ci sono perdite di memoria note e restano praticabili solo modelli tiny/base, che nelle mie misure sbagliano molto (WER 30–38% sull'italiano di prova); i modelli grandi (Turbo ~2,9 GB) possono non entrare. (2) *App nativa* con [WhisperKit](https://www.argmaxinc.com/blog/whisperkit) (MIT, gira sul Neural Engine): richiede Xcode su Mac per compilarla (nessuna fonte trovata su Swift Playgrounds e Apple ID gratuito) e non posso né compilarla né provarla da qui. Esistono app gratuite di terze parti per trascrivere sull'iPad (non verificate), ma senza cartelle, profili, live, quaderno e correzione AI di questa. |
**Consiglio**: se hai un computer che può restare acceso, usa quello con Tailscale (apertura istantanea, nessun limite di ore). Se no, tieni Codespaces con le abitudini descritte sopra e, se vuoi, l'automazione dei Comandi Rapidi.

## Per i tuoi compagni (profili con archivi separati)
Quando l'app è protetta (`--lan`, Codespaces, Docker) il codice che vedi all'avvio è **amministratore**. In **Impostazioni → Persone** crei un profilo per ogni compagno: ricevono un **codice personale** (mostrato una sola volta) e un indirizzo da aprire sul loro iPad.
- Ognuno ha un **archivio privato**: registrazioni, audio, cartelle, vocabolario e correzioni sono separati. **Nemmeno tu** vedi le registrazioni degli altri (verificato da test automatici).
- I **modelli e la potenza di calcolo sono condivisi**: li installi tu una volta per tutti (i compagni non possono installare/eliminare modelli né cambiare impostazioni).
- Se un compagno perde il codice: *Nuovo codice*. Eliminare un profilo elimina **definitivamente** anche le sue registrazioni.
- Se ci sono molte persone insieme, i lavori si mettono in coda e girano a coppie (impostazione "in parallelo"): su un Codespace a 4 core aspettati attese.
- **Privacy**: tutto resta sul server che scegli tu (il tuo Codespace/computer). Per le registrazioni dei compagni, tu come amministratore sei responsabile di quel server: dì loro dove girano i loro audio.

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
| **Quaderno** | Per ogni trascrizione un documento libero come Word / Note di Apple: correggi e cancella con la tastiera, formatti (grassetto, titoli, elenchi, evidenziatore) e **disegni o scrivi con l'Apple Pencil** (penna, evidenziatore, frecce, gomma, annulla). Vedi "Quaderno". |
| **Più persone** | Profili con codice personale e archivio **privato** (anche l'amministratore non vede quello degli altri); modelli e calcolo condivisi. Vedi "Per i tuoi compagni". |
| **Correzione AI** | Facoltativa: LLM locale gratuito (Qwen3 via Ollama) che *propone* correzioni e segnala parti fuori tema; approvi tu, con diff e controlli di sicurezza; ricorda le correzioni per materia. Vedi "Correzione con AI". |

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

## Uso dall'iPad (iPad Pro M5 e altri)
Interfaccia pensata per il touch: bersagli ≥ 44 px, strumenti sempre visibili (nessuna funzione dipende dall'hover), "Sposta in…" al posto del solo trascinamento, vista a due colonne in orizzontale e a colonna in verticale (iPad Pro 11" e 13"), installabile dalla Home. **Collaudata con un iPad Pro emulato in Chromium (non Safari reale)**: touch, 11"/13", verticale/orizzontale, 34 controlli superati.
- **Microfono e condivisione dei file richiedono HTTPS**: con Codespaces o Tailscale ce l'hai già; in rete locale usa `--lan --https` e fidati del certificato. Senza HTTPS la registrazione live non parte (l'app lo dice) e "Condividi audio" scarica il file.
- Caricare file: dal selettore file dell'iPad (anche *Memo Vocali*, m4a). Su iPad il trascinamento fra cartelle non c'è: usa "📁 Sposta in…".

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

## Quaderno (testo libero + Apple Pencil)
Dall'editor tocca **📓 Quaderno**: l'app crea un documento di testo dalla trascrizione (paragrafi con il testo fedele, **▶ per riascoltare** ogni punto, le tue evidenziazioni e note).
- **Testo**: scrivi, cancella e correggi con la tastiera; grassetto/corsivo/sottolineato, titoli, elenchi, evidenziatore, annulla/ripeti; "＋ Disegno" inserisce uno spazio vuoto per schemi. Salvataggio automatico. Con l'Apple Pencil, **Scribble** di iPadOS (scrivere a mano nei campi di testo) dovrebbe funzionare nel quaderno, ma dipende da iPadOS e non l'ho potuto provare.
- **Disegno**: penna (spessore in base alla pressione), evidenziatore, freccia, gomma (cancella il tratto toccato), 5 colori, 3 spessori. Di norma disegna **solo la penna** e un dito **scorre la pagina** (così il palmo appoggiato non lascia segni); si può attivare "Disegna anche col dito".
- **I disegni seguono il testo**: ogni tratto è legato al paragrafo vicino; se aggiungi o cancelli testo sopra, il disegno si sposta con il suo paragrafo (verificato). Sono tratti vettoriali, non immagini.
- **PDF**: *Esporta → PDF con disegni (Stampa)* → su iPad *Condividi → Salva su File* (o pizzica l'anteprima per ottenere il PDF). I disegni diventano SVG vettoriali dentro il loro paragrafo (verificato: il PDF contiene i tracciati). **Word (.docx)** e **.txt** esportano solo il testo, senza disegni.
- **Quaderno e trascrizione sono indipendenti**: modificare il quaderno non cambia segmenti, timestamp e audio sincronizzati. "Ricrea dalla trascrizione" ricomincia da zero (con conferma). La ricerca nell'archivio trova anche il testo del quaderno. Privato per profilo come il resto.
- **Limiti**: l'inchiostro per quaderno è limitato a ~8 MB; il canvas copre solo la parte visibile (così funziona con documenti lunghissimi). **Collaudato con eventi di tipo `pen` simulati e mouse in Chromium** (tratto, pressione, freccia, evidenziatore, gomma, annulla, ancoraggio, salvataggio, stampa); **non con un vero Apple Pencil su Safari**: pressione, inclinazione e il rifiuto del palmo vanno provati sul tuo iPad.

## Correzione con AI (facoltativa, gratuita, open source)
Serve **solo se** la trascrizione non è già abbastanza buona: l'app valuta caso per caso se conviene ("consigliata", "facoltativa", "probabilmente non serve") in base al modello usato (dalle misure sopra) e ai punti dubbi trovati. Con Whisper Turbo/Large di solito **non serve**; con Parakeet è facoltativa (nomi e termini tecnici); con i modelli veloci è consigliata.
- **Come funziona**: un piccolo LLM locale via [Ollama](https://ollama.com) (nessun dato esce dal computer). Modello consigliato: **Qwen3 4B** (licenza Apache-2.0, ~2,6 GB, anche su CPU); **Qwen3 8B** (~5,2 GB, 16 GB di RAM) capisce meglio il contesto; i modelli si scaricano **una volta sola** dall'app (Impostazioni → Correzione con AI) e restano in Ollama. Su Linux/Codespaces: `bash scripts/install_ollama.sh`; su Mac/Windows installa l'app da ollama.com.
- **Che cosa fa**: corregge parole ascoltate male, nomi propri e termini scritti male, accenti e apostrofi; **segnala** (non cancella) le parti fuori tema (chiacchiere, rumori, allucinazioni). Il testo originale resta sempre salvato.
- **Mai modifiche automatiche**: l'AI propone, vedi il *diff* parola per parola con ▶ per riascoltare, e approvi ciò che vuoi. Le parti fuori tema non sono preselezionate. Ogni proposta passa controlli di sicurezza: se cambia troppe parole, altera un numero o toglie un termine del glossario viene **scartata** (e te lo dice).
- **"Istruirla"** (senza addestramento, che non è fattibile gratis su un PC/iPad): le dai contesto — materia, argomento della cartella, il tuo glossario, **istruzioni personali per cartella** ("il professore chiama gli studenti per nome: ignorali…") e la **memoria delle correzioni** che hai già approvato (riproposte anche senza AI nelle trascrizioni future e date all'AI come esempio). Impostazioni → *Memoria delle correzioni*.
- **Solo i punti dubbi** (predefinito se ce ne sono) o tutto il testo: l'AI su CPU è lenta (ordine di grandezza: decine di minuti per una lezione intera), quindi conviene limitarsi ai punti sospetti.
- **Cosa NON ho potuto verificare**: Hugging Face e il registro di Ollama non sono raggiungibili dal mio ambiente, quindi **non ho mai eseguito un LLM vero**. Tutta la logica (prompt, schema JSON, controlli di sicurezza, diff, approvazione, memoria, errori) è collaudata con un server finto compatibile con Ollama, anche con risposte "cattive" di proposito. **La qualità reale delle correzioni di Qwen3 sul tuo audio è da verificare con una prova**: fai una revisione su una lezione che conosci e guarda il diff prima di approvare. La scelta di Qwen3 si basa su licenza (Apache-2.0) e supporto multilingue dichiarato dal produttore, non su un benchmark indipendente sull'italiano che io abbia trovato.

## Test

```bash
./scripts/test.sh            # 67 test backend (~25 s); --slow aggiunge il file sintetico da 190 minuti
STUDIO_REAL=1 STUDIO_DATA=/percorso/data STUDIO_TEST_EN=en.wav STUDIO_TEST_WAV=... STUDIO_TEST_TRUTH=... \
  pytest backend/tests/real_models     # test con MODELLI VERI (genera l'audio con real_models/make_speech.py)
node tests/e2e/e2e_mock.mjs ...        # browser, tutti i flussi (server con STUDIO_ENABLE_MOCK=1)
node tests/e2e/e2e_real.mjs ...        # browser con modelli veri (server normale)
node tests/e2e/e2e_users_ai.mjs ...    # profili, accesso, correzione AI (server con STUDIO_TOKEN + tests/e2e/fake_ollama.py)
node tests/e2e/e2e_ipad.mjs ...        # iPad Pro emulato: touch, bersagli, orientamenti
node tests/e2e/e2e_notebook.mjs ...    # quaderno: testo, inchiostro (pen simulato), ancoraggio, stampa PDF
node tests/e2e/e2e_delete.mjs ...      # eliminazione in ogni stato (finita, in elaborazione, registrazione aperta/orfana, multipla)
node tests/e2e/e2e_allbuttons.mjs ...  # prova a premere TUTTI i pulsanti di ogni schermata e segnala quelli senza effetto
node tests/e2e/stable_live.mjs ...     # i pulsanti del live non vengono ridisegnati (i tocchi non si perdono)
```
**Superati in sviluppo**: 67 test backend (inclusi profili isolati e correzione AI con finto Ollama) (pipeline, cartelle, ricerca, PDF unico, ZIP audio, parallelismo reale, live via WebSocket, recupero dopo crash, filtro insegnante…); 4 test con modelli veri (parlanti + solo insegnante, live, tutti i modelli in inglese); **57 controlli nel browser** con mock (cartelle, 3 file in parallelo con avvio automatico, copia multipla, PDF unico, condivisione, evidenziazione parola per parola, note, live con microfono finto, responsive iPad/smartphone) e **25 su profili/accesso/AI**, **34 su iPad Pro emulato** e **19 con modelli veri** (parola evidenziata coerente con i tempi del modello, salto alla parola, voci estranee escluse, live).
Il mock (`STUDIO_ENABLE_MOCK=1`) aggiunge due schede "MOCK" chiaramente etichettate; non esiste in uso normale.

## Cosa NON è stato verificato

- **Parlato reale**: tutti i test di accuratezza usano voce sintetica; il WER su lezioni vere (rumore, accenti, termini tecnici) è **sconosciuto**. Usa *Confronta modelli* + WER con un riferimento corretto a mano per decidere.
- **GPU**: nessuna disponibile; il provider CUDA di sherpa-onnx richiede la sua build CUDA (non installata né provata). Su CPU tutto è provato.
- **iPad/Safari reali**: HTTPS, microfono, Web Share, notifiche e comportamento in background sono descritti ma provati solo su Chromium (anche iPad emulato). **GitHub Codespaces, Docker e Tailscale non sono stati avviati davvero.**
- **Un LLM vero** (vedi sopra).
- **Licenze** dei modelli: riportate da fonti terze, da confermare sulle model card. Ollama/appunti con LLM presente non provato (solo il caso "assente").
- Audio di durata 2–3 ore con modelli veri: la segmentazione è provata su 190 minuti sintetici, l'inferenza reale solo su file brevi.

## Appunti a mano libera (con cartelle) e registrazione live scritta nella pagina

Voce **✎ Appunti** nel menu. Come l'app «Sul dispositivo» (stesso motore di scrittura: Apple Pencil, dito che scorre e zooma, strumenti, forme, righello, lazo…), ma qui:
- le note sono salvate **sul server**, con le stesse **cartelle (materie → argomenti)** dell'Archivio: puoi sceglierle, spostarle, cercare nei titoli e nel testo;
- nella nota c'è **● Registra**: la trascrizione live **si scrive dentro la pagina** (testo vero, modificabile, con paragrafi/pause in viola) usando i **modelli del server** (Parakeet, Whisper…), e puoi chiedere a fine registrazione di ritrascrivere l'audio con un modello più accurato; l'audio e la trascrizione completa vanno anche nell'Archivio («🎙 Trascrizione» nella nota);
- ogni profilo ha i propri appunti, privati.
Test: `tests/e2e/e2e_notes.mjs` (22 controlli, con modello finto), `backend/tests/test_pages.py`. Il motore `ink.js` esiste in due copie (`ondevice/` e `frontend/`) che devono restare identiche (c'è un test).

## Privacy

Tutto è locale (`data/`: audio, database, pesi). Nessuna telemetria. Accessi di rete: solo il download dei pesi da GitHub (su tua richiesta) e, se lo usi, Ollama su `127.0.0.1`. Eliminare una trascrizione rimuove **definitivamente** anche l'audio (se non usato da altre). Funziona in qualunque stato: anche se è in elaborazione o con una registrazione live ancora aperta (viene fermata e scartata). La conferma è dentro l'app (niente finestre del browser) e ogni errore è mostrato a schermo; "Seleziona tutto" include anche gli elementi in corso.

## Struttura

```
backend/app/   main.py (API) · engine.py (coda parallela, cache modelli) · live.py (sessioni live) · audio.py (VAD/chunking)
               adapters.py · registry.py (modelli, misure) · installer.py · diarization.py · exports.py · db.py (FTS, cartelle, note)
backend/tests/ test automatici (+ real_models/ con modelli veri)     tests/e2e/  collaudo nel browser
frontend/      core.js (router, attività, notifiche) · library.js · new.js · live.js · editor.js · misc.js · style.css · sw.js
scripts/       start.sh · start.bat · test.sh
```
