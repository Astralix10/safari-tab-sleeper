//
//  ViewController.swift
//  Safari Tab Sleeper
//
//  Created by Astralix on 09.07.2026.
//

import Cocoa
import SafariServices
import WebKit

let extensionBundleIdentifier = "com.local.safari-tab-sleeper.Extension"

class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {

    private struct CompanionExtensionState: Decodable {
        let ok: Bool
        let active: Bool
    }

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            guard let state = state, error == nil else {
                self.resolveCompanionExtensionState(error: error, in: webView)
                return
            }

            DispatchQueue.main.async {
                self.showExtensionState(enabled: state.isEnabled, in: webView)
            }
        }
    }

    private func resolveCompanionExtensionState(error: Error?, in webView: WKWebView) {
        guard let url = URL(string: "http://127.0.0.1:17654/extension-state") else {
            showError(error?.localizedDescription ?? "Safari не вернул состояние расширения.", in: webView)
            return
        }

        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3)
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let statusCode = (response as? HTTPURLResponse)?.statusCode
            DispatchQueue.main.async {
                let state = data.flatMap { try? JSONDecoder().decode(CompanionExtensionState.self, from: $0) }
                guard statusCode == 200, state?.ok == true, state?.active == true else {
                    if let error {
                        self.showError(error.localizedDescription, in: webView)
                    } else {
                        self.showExtensionState(enabled: false, in: webView)
                    }
                    return
                }

                self.showExtensionState(enabled: true, in: webView)
            }
        }.resume()
    }

    private func showExtensionState(enabled: Bool, in webView: WKWebView) {
        if #available(macOS 13, *) {
            webView.evaluateJavaScript("show(\(enabled), true)")
        } else {
            webView.evaluateJavaScript("show(\(enabled), false)")
        }
    }

    private func showError(_ message: String, in webView: WKWebView? = nil) {
        let targetWebView = webView ?? self.webView
        guard let encoded = try? JSONEncoder().encode(message),
              let literal = String(data: encoded, encoding: .utf8) else {
            return
        }
        targetWebView?.evaluateJavaScript("showError(\(literal))")
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let command = message.body as? String, command == "open-preferences" else {
            return;
        }

        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
            DispatchQueue.main.async {
                if let error {
                    self.showError(error.localizedDescription)
                    return
                }

                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                    let safari = NSRunningApplication.runningApplications(
                        withBundleIdentifier: "com.apple.Safari"
                    ).first
                    safari?.activate(options: [.activateAllWindows])
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
                        NSApplication.shared.terminate(nil)
                    }
                }
            }
        }
    }

}
