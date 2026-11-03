# Analisi: Note di Apple e Google Keep (da fonti pubbliche) e cosa abbiamo copiato

Fonti consultate: [WWDC24 «Squeeze the most out of Apple Pencil»](https://developer.apple.com/videos/play/wwdc2024/10214/), [Apple Support: disegnare con Apple Pencil su iPad](https://support.apple.com/en-lb/guide/ipad/ipadc55b6c7a/ipados), [Apple Pencil](https://www.apple.com/apple-pencil/), [aiuto di Google Keep: disegni](https://support.google.com/keep/answer/6395656), [9to5Google: strumenti di disegno di Keep](https://9to5google.com/2016/12/17/google-keep-web-app-drawing-tools/), [Pointer Events 3 (W3C)](https://www.w3.org/TR/pointerevents3/), [Chrome: desynchronized](https://developer.chrome.com/blog/desynchronized), [lazy-brush](https://github.com/dulnan/lazy-brush), [filtro 1€](https://gery.casiez.net/1euro/).
Non esiste un'app «Google Notes» per il disegno: la più vicina è **Google Keep**; il confronto è con quella. Le descrizioni di Apple vengono da pagine pubbliche, non dal codice di Note: è un'imitazione dell'aspetto e del comportamento, non una copia.

| Funzione | Note (Apple) | Keep (Google) | Questa app |
|---|---|---|---|
| Penna, evidenziatore, matita | sì (matita sensibile all'inclinazione) | penna, pennarello, evidenziatore | sì; matita con ombreggiatura e grana |
| Gomma | oggetto / pixel | gomma, doppio tocco = cancella tutto | oggetto / pixel; «Svuota pagina» in ⋯ |
| Selezione | lazo | strumento Seleziona | lazo: sposta, duplica, ricolora, elimina |
| Righello | sì | no | sì (si ruota con due dita, snap a 45°) |
| Forme perfette | pausa a fine tratto | no | sì (pausa 0,75 s) |
| Carta | righe, quadretti, puntini | griglia | righe, quadretti, puntini, bianco |
| Anteprima punta sospesa (hover) | sì: colore, spessore, opacità | no | sì (grande quanto il tratto) |
| Doppio tocco Pencil | sì (ultimo strumento / gomma) | – | solo con l'involucro nativo `ios/` (Safari non lo riceve) |
| Stretta Pencil Pro | sì: tavolozza strumenti | – | solo con l'involucro nativo `ios/` |
| Stabilizzazione | – | – | sì, regolabile (filtro 1€), come le app di disegno |
| Trascrizione live nella pagina | no | no | sì |

## Latenza e fluidità (cosa dice la ricerca)
- `getCoalescedEvents` / `getPredictedEvents`: ci sono (gli eventi predetti vengono usati per disegnare in anticipo e poi scartati).
- `desynchronized` è un'ottimizzazione di Chromium: **non aiuta su Safari**.
- Non ho trovato fonti sui 120 Hz di Safari su iPad: dipende dall'iPad (serve ProMotion) e dalle impostazioni di sistema (Risparmio energetico spento).
- Lavori fatti: il livello del tratto in corso si ridisegna solo nella sua area, niente sfocature (`backdrop-filter`) sopra il foglio, animazione parole leggera, salvataggio solo a penna sollevata.
