import SwiftUI

/// Mostra l'app web a tutto schermo. L'indirizzo si cambia con l'ingranaggio (es. quello del Codespace).
struct ContentView: View {
    @AppStorage("startURL") private var startURL = "https://edoardogangale.github.io/ai-transcription-studio/"
    @State private var showSettings = false
    @State private var draft = ""

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            WebView(urlString: startURL)
                .ignoresSafeArea()
            Button {
                draft = startURL
                showSettings = true
            } label: {
                Image(systemName: "gearshape.fill")
                    .padding(10)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .padding(14)
            .opacity(0.5)
        }
        .sheet(isPresented: $showSettings) {
            NavigationStack {
                Form {
                    Section("Indirizzo dell'app") {
                        TextField("https://…", text: $draft)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                    }
                    Section {
                        Text("Pagine GitHub (app «Sul dispositivo») oppure l'indirizzo https del Codespace (porta 8000).")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .navigationTitle("Impostazioni")
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Apri") { startURL = draft.trimmingCharacters(in: .whitespaces); showSettings = false }
                    }
                    ToolbarItem(placement: .cancellationAction) { Button("Annulla") { showSettings = false } }
                }
            }
        }
    }
}
