# Involucro nativo per i pulsanti della Apple Pencil (NON ancora compilato né provato)

Safari non riceve il **doppio tocco** né la **stretta** (Pencil Pro) della Apple Pencil: arrivano solo alle app native (`UIPencilInteraction`).
Questa piccola app iOS mostra la pagina web a tutto schermo in un `WKWebView` e inoltra i pulsanti alla pagina come evento `pencil`.
Il quaderno (`ink.js`) lo ascolta già: doppio tocco = gomma ↔ strumento (come il tasto ⇄), stretta = strumenti rapidi.

**Stato onesto:** il codice Swift è scritto senza poterlo compilare (qui non c'è Xcode): al primo tentativo possono esserci errori da correggere. Se Xcode ne segnala, copiami il messaggio.

## Come installarla (serve il Mac con Xcode; con un Apple ID gratuito dura 7 giorni, poi si reinstalla)
1. Xcode → *File → New → Project → iOS → App*. Nome: `PencilWrapper`, Interface: **SwiftUI**, Language: **Swift**.
2. Cancella `ContentView.swift` creato da Xcode e trascina nel progetto i tre file di questa cartella: `PencilWrapperApp.swift`, `ContentView.swift`, `WebView.swift` (sostituisci `PencilWrapperApp.swift` se esiste già).
3. Nel target → *Info* aggiungi la chiave **Privacy - Microphone Usage Description** con un testo tipo «Serve per trascrivere le lezioni».
4. Target → *Signing & Capabilities*: scegli il tuo **Team** (il tuo Apple ID) e un *Bundle Identifier* unico.
5. Sull'iPad: *Impostazioni → Privacy e sicurezza → Modalità sviluppatore → On* (riavvia). Collega l'iPad al Mac, scegline il nome in alto in Xcode e premi **Run**.
6. Sull'iPad, la prima volta: *Impostazioni → Generali → VPN e gestione dispositivo* → fidati del tuo Apple ID.
7. Apri l'app: di base carica l'app «Sul dispositivo»; con l'ingranaggio in basso a sinistra cambi indirizzo (es. quello del Codespace).

## Cosa fa la Apple Pencil
- Doppio tocco: usa l'azione scelta in *Impostazioni → Apple Pencil* solo se l'app la gestisce; qui arriva alla pagina e cambia strumento.
- Stretta (Pencil Pro): apre gli strumenti rapidi nel punto dove la Pencil è sospesa.
