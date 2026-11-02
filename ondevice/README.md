# Trascrizione sul dispositivo (separata dall'app server)

App web installabile: la trascrizione (Whisper) gira **dentro Safari sull'iPad**. Nessun server, nessun account, nessun dato inviato: audio e testi restano nell'archivio del browser di quell'iPad. Ogni amico che apre il link ha il **proprio** archivio, separato dal tuo.

**Non provata su Safari/iPad reali**: collaudata solo con un modello finto in Chromium (interfaccia, VAD, salvataggio, elimina; quaderno con mouse e tocchi simulati: `tests/e2e/e2e_ink.mjs`, 37 controlli). Il caricamento del modello vero va verificato sull'iPad.

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
- **Strumenti rapidi**: appoggia la penna e tienila ferma mezzo secondo.
- Tocca di nuovo lo strumento attivo per lo spessore (e per il tipo di gomma). Colori + colore libero.
- Foglio: bianco, righe, quadretti, puntini; distanza righe; colore; A4 verticale/orizzontale, largo, infinito; **Allarga →** e **Allunga ↓** (si allunga anche da solo quando scrivi in fondo). Esporta in PNG.
- **Registra e prendi appunti**: la trascrizione live si scrive **dentro il foglio come testo vero** (selezionabile, copiabile, modificabile: tocca il testo col dito), con le parole che compaiono animate; il foglio si allunga da solo. Ciò che aggiunge l'app (orari, paragrafi, pause) è **viola e corsivo** e non modificabile; il parlato è nero. Puoi scrivere a mano sopra e intorno. Il pannello laterale (▤) è facoltativo.
- **Pencil sospesa** (iPad con hover): compare l'ombra della punta con colore e spessore dello strumento. **Matita inclinata**: tratto largo e più chiaro per ombreggiare, con grana di grafite.
- **Non possibile sul web**: il doppio tocco e la stretta della Apple Pencil non arrivano a Safari. Al loro posto c'è il pulsante **⇄** (passa alla gomma e torna indietro). Il font è quello di sistema dell'iPad (San Francisco, lo stesso di Note).

## Limiti
- Modelli più piccoli di quelli del server: qualità più bassa, soprattutto in italiano. Niente riconoscimento dei parlanti né correzione AI.
- Se il «Ritardo trascrizione» cresce, il modello è troppo lento per quell'iPad: scegline uno più piccolo.
- Mantieni lo schermo acceso e l'app in primo piano mentre registri.
- Cancellare i dati di Safari/il sito cancella l'archivio: condividi l'audio o copia il testo di ciò che vuoi conservare.
