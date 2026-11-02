# Trascrizione sul dispositivo (separata dall'app server)

App web installabile: la trascrizione (Whisper) gira **dentro Safari sull'iPad**. Nessun server, nessun account, nessun dato inviato: audio e testi restano nell'archivio del browser di quell'iPad. Ogni amico che apre il link ha il **proprio** archivio, separato dal tuo.

**Non provata su Safari/iPad reali**: collaudata solo con un modello finto in Chromium (interfaccia, VAD, salvataggio, elimina). Il caricamento del modello vero va verificato sull'iPad.

## Pubblicazione (una volta sola, GitHub Pages gratuito)
1. GitHub → repository → **Settings → Pages → Source: GitHub Actions**. (Con l'account gratuito il repository deve essere **pubblico**: il codice è visibile, i dati degli utenti no.)
2. Scheda **Actions** → «Pubblica app Sul dispositivo» → **Run workflow** (poi si aggiorna da sola a ogni modifica a `ondevice/`).
3. Il link sarà `https://edoardogangale.github.io/ai-transcription-studio/`.

## Uso (tu e gli amici)
1. Apri il link in **Safari** → Condividi → **Aggiungi alla schermata Home**.
2. Apri l'icona → *Test dispositivo* → *Scarica e prova il modello* (serve Internet **solo questa volta**, ~250 MB per Small).
3. *Registra e trascrivi*. Funziona anche offline.
4. A fine lezione: *Copia testo*, *Scarica .txt*, *Condividi audio* (per ritrascrivere con l'app server).

## Limiti
- Modelli più piccoli di quelli del server: qualità più bassa, soprattutto in italiano. Niente riconoscimento dei parlanti né correzione AI.
- Se il «Ritardo trascrizione» cresce, il modello è troppo lento per quell'iPad: scegline uno più piccolo.
- Mantieni lo schermo acceso e l'app in primo piano mentre registri.
- Cancellare i dati di Safari/il sito cancella l'archivio: condividi l'audio o copia il testo di ciò che vuoi conservare.
