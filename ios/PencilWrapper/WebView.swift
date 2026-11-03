import SwiftUI
import WebKit

/// WKWebView che inoltra alla pagina i pulsanti della Apple Pencil (doppio tocco e stretta della Pencil Pro):
/// Safari non li espone, solo le app native tramite UIPencilInteraction.
struct WebView: UIViewRepresentable {
    let urlString: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        let web = WKWebView(frame: .zero, configuration: config)
        web.uiDelegate = context.coordinator
        web.scrollView.bounces = false
        web.allowsBackForwardNavigationGestures = false
        if #available(iOS 16.4, *) { web.isInspectable = true }

        let interaction = UIPencilInteraction()
        interaction.delegate = context.coordinator
        web.addInteraction(interaction)

        context.coordinator.web = web
        load(web)
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        if web.url?.absoluteString != urlString, let url = URL(string: urlString) { web.load(URLRequest(url: url)) }
    }

    private func load(_ web: WKWebView) {
        if let url = URL(string: urlString) { web.load(URLRequest(url: url)) }
    }

    final class Coordinator: NSObject, WKUIDelegate, UIPencilInteractionDelegate {
        weak var web: WKWebView?
        private var lastSent = Date.distantPast

        private func send(_ type: String, point: CGPoint? = nil) {
            // le versioni nuove e vecchie dell'API possono scattare entrambe: ignora il doppione
            guard Date().timeIntervalSince(lastSent) > 0.2 else { return }
            lastSent = Date()
            var detail = "{type:'\(type)'"
            if let p = point { detail += ",x:\(Int(p.x)),y:\(Int(p.y))" }
            detail += "}"
            web?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('pencil',{detail:\(detail)}))")
        }

        // Doppio tocco (iOS 17.5+)
        @available(iOS 17.5, *)
        func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
            send("doubleTap", point: tap.hoverPose?.location)
        }

        // Stretta della Apple Pencil Pro (iOS 17.5+)
        @available(iOS 17.5, *)
        func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
            if squeeze.phase == .ended { send("squeeze", point: squeeze.hoverPose?.location) }
        }

        // Doppio tocco su versioni precedenti
        func pencilInteractionDidTap(_ interaction: UIPencilInteraction) { send("doubleTap") }

        // Microfono per la registrazione live
        @available(iOS 15.0, *)
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(.grant)
        }
    }
}
