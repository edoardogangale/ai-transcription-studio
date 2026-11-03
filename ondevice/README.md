# Trascrizione sul dispositivo (separata dall'app server)

App web installabile: la trascrizione (Whisper) gira **dentro Safari sull'iPad**. Nessun server, nessun account, nessun dato inviato: audio e testi restano nell'archivio del browser di quell'iPad. Ogni amico che apre il link ha il **proprio** archivio, separato dal tuo.

**Non provata su Safari/iPad reali**: collaudata solo con un modello finto in Chromium (interfaccia, VAD, salvataggio, elimina; quaderno con mouse e tocchi simulati: `tests/e2e/e2e_ink.mjs`, 44 controlli). Il caricamento del modello vero va verificato sull'iPad.

## Pubblicazione (una volta sola, GitHub Pages gratuito)
1. GitHub → repository → **Settings → Pages → Source: GitHub Actions**. (Con l'account gratuito il repository deve essere **pubblico**: il codice è visibile, i dati degli utenti no.)
2. Scheda **Actions** → «Pubblica app Sul dispositivo» → **Run workflow** (poi si aggiorna da sola a ogni modifica a `ondevice/`).
3. Il link sarà `https://edoardogangale.github.io/ai-transcription-studio/`.

## Uso (tu e gli amici)
1. Apri il link in **Safari** → Condividi → **Aggiungi alla schermata Home**.
2. Apri l'icona → *Test dispositivo* → *Scarica e prova il modello* (serve Internet **solo questa volta**, ~250 MB per Small).
3. *Registra e trascrivi*. Funziona anche offline.
4. A fine lezione: *Copia testo*, *Scarica .txt*, *Condividi audio* (per ritrascrivere con l'app server).

## Appunti (quaderno stile Note di Apple / GoodNotes)
- **Apple Pencil scrive, il dito scorre** (pizzica per lo zoom). Tocco con 2 dita = annulla, 3 dita = ripristina. Opzione "Scrivi anche col dito" per chi non ha la Pencil.
- Strumenti: penna (sensibile alla pressione), stilografica, matita, evidenziatore, gomma a oggetto o a pixel, lazo (seleziona, sposta, duplica, ricolora, elimina), testo, righello (sposta con un dito, ruota con due; la penna segue il bordo).
- **Forme**: a fine tratto tieni ferma la penna mezzo secondo → linea, freccia, cerchio, ellisse, rettangolo, triangolo diventano perfetti.
- **Strumenti rapidi**: tieni premuto un dito sul foglio (mezzo secondo).
- **Palmo**: dopo che la Pencil ha toccato lo schermo, le dita vengono ignorate per ~1 s, e i contatti larghi (palmo) sempre.
- Tocca di nuovo lo strumento attivo per lo spessore (e per il tipo di gomma). Colori + colore libero.
- Foglio: bianco, righe, quadretti, puntini; distanza righe; colore; A4 verticale/orizzontale, largo, infinito; **Allarga →** e **Allunga ↓** (si allunga anche da solo quando scrivi in fondo). Esporta in PNG.
- **Registra e prendi appunti**: la trascrizione live si scrive **dentro il foglio come testo vero** (selezionabile, copiabile, modificabile: tocca il testo col dito), con le parole che compaiono animate; il foglio si allunga da solo. Ciò che aggiunge l'app (orari, paragrafi, pause) è **viola e corsivo** e non modificabile; il parlato è nero. Puoi scrivere a mano sopra e intorno. Il pannello laterale (▤) è facoltativo.
- **Pencil sospesa** (iPad con hover): compare l'ombra della punta con colore e spessore dello strumento. **Matita inclinata**: tratto largo e più chiaro per ombreggiare, con grana di grafite.
- **Non possibile sul web**: il doppio tocco e la stretta della Apple Pencil non arrivano a Safari. Al loro posto c'è il pulsante **⇄** (passa alla gomma e torna indietro). Il font è quello di sistema dell'iPad (San Francisco, lo stesso di Note).

## Fluidità (120 Hz)
Il foglio è disegnato in tessere bitmap: scorrere e zoomare ricompone poche immagini invece di ridisegnare i tratti (misurato in Chromium con 3000 tratti: ~1 ms → ~0,06 ms di lavoro JS per fotogramma). Anche la scrittura usa gli eventi "coalesced" e "predicted" della Pencil. **Safari segue i 120 Hz solo se**: *Impostazioni → Batteria → Risparmio energetico* è spento e *Impostazioni → App → Safari → Avanzate → Funzionalità → «Prefer Page Rendering Updates near 60fps»* è spento (se la voce c'è).

## Scorrimento, zoom e Pencil (versione aggiornata)
- Il foglio blocca i gesti nativi di Safari: un dito scorre, due dita pizzicano per lo zoom, senza zoomare tutta la pagina.
- La pagina non si zooma più con il pizzico del browser (`maximum-scale=1`).
- Il tratto della penna è levigato e la pressione viene addolcita, così il tratto non sfarfalla.
- **Doppio tocco e pulsante della Apple Pencil**: Safari non li riceve. Servirebbe un'app nativa (Xcode, su Mac).
- **Trascrizione sul dispositivo**: le frasi arrivano fino a 25 s, con più contesto per Whisper. Il taglio avviene a fine frase (2,5 s di silenzio) o dopo una pausa dopo 6 s.

## Nitidezza (2K e oltre)
Il foglio è disegnato alla risoluzione del display: fino a 3× (iPad Pro), anche zoomato fino a 6× dove serve, con tessere bitmap. L'esportazione PNG è almeno 2048 px di larghezza.

## Stabilizzazione, fluidità e pulsanti della Pencil (versione aggiornata)
- **Stabilizzazione del tratto** (filtro One Euro): cursore in *⋯* e nelle opzioni delle penne (0–100%, di base 35%). Leviga il tremore a velocità bassa e resta pronto quando scrivi veloce. Con la stabilizzazione attiva le forme perfette usano il tratto vero.
- Il tratto in corso si ridisegna solo nella sua area; niente sfocature sopra il foglio; l'anteprima della punta sospesa è grande quanto il tratto; il salvataggio non parte mentre scrivi.
- **Pulsanti della Pencil**: da Safari impossibili; con l'involucro nativo in `ios/` (Xcode sul Mac, non ancora compilato) doppio tocco = gomma ↔ strumento e stretta (Pencil Pro) = strumenti rapidi. La pagina ascolta l'evento `pencil`.
- Analisi di Note e Keep e confronto con le funzioni dell'app: `ondevice/ANALISI.md`.

## Download del modello (Whisper Large v3 Turbo si bloccava)
Causa probabile: per Turbo l'app chiedeva il codificatore a precisione piena (molti GB) e Safari restava fermo. Ora Turbo usa la versione q4 (~0,8 GB in tutto). Il download è **a pezzi da 8 MB con ripresa**: se per 25 s non arriva nulla, interrompe e riprova (fino a 8 volte); i pezzi già scaricati restano anche se chiudi l'app; schermo acceso e archivio persistente durante il download. In *Impostazioni* vedi se il modello è già «✓ scaricato». Provato con un finto server (rete che cade, richieste bloccate, niente Range, ripresa): `tests/e2e/e2e_download.mjs` (15 controlli). **Non provato col vero Hugging Face** (da qui non è raggiungibile): se il blocco resta, mandami il messaggio che compare.

## Limiti
- Modelli più piccoli di quelli del server: qualità più bassa, soprattutto in italiano. Niente riconoscimento dei parlanti né correzione AI.
- Se il «Ritardo trascrizione» cresce, il modello è troppo lento per quell'iPad: scegline uno più piccolo.
- Mantieni lo schermo acceso e l'app in primo piano mentre registri.
- Cancellare i dati di Safari/il sito cancella l'archivio: condividi l'audio o copia il testo di ciò che vuoi conservare.
