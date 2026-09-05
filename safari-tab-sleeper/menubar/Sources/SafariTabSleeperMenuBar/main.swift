import AppKit
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let statusMenuItem = NSMenuItem(title: "Safari/WebKit: проверяю...", action: nil, keyEquivalent: "")
    private let pauseMenuItem = NSMenuItem(title: "Поставить монитор на паузу на 1 час", action: #selector(pauseMonitor), keyEquivalent: "")
    private let resumeMenuItem = NSMenuItem(title: "Возобновить монитор", action: #selector(resumeMonitor), keyEquivalent: "")
    private let runtimeDirectory: URL
    private let pauseFile: URL
    private let sleepServerURL = "http://127.0.0.1:17654/sleep"

    override init() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        runtimeDirectory = home.appendingPathComponent("Library/Application Support/Safari Tab Sleeper", isDirectory: true)
        pauseFile = runtimeDirectory.appendingPathComponent("pause-until")
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem.button?.title = "ST"
        statusItem.button?.toolTip = "Safari Tab Sleeper"
        configureMenu()
        refreshStatus()
    }

    private func configureMenu() {
        let menu = NSMenu()
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(NSMenuItem(title: "Обновить статус", action: #selector(refreshStatus), keyEquivalent: "r"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Усыпить тяжёлые фоновые вкладки", action: #selector(sleepHeavyInactiveTabs), keyEquivalent: "h"))
        menu.addItem(NSMenuItem(title: "Усыпить все фоновые вкладки", action: #selector(sleepAllBackgroundTabs), keyEquivalent: "s"))
        menu.addItem(NSMenuItem(title: "Усыпить активную вкладку Safari", action: #selector(sleepActiveSafariTab), keyEquivalent: ""))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(pauseMenuItem)
        menu.addItem(resumeMenuItem)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Открыть runtime-папку", action: #selector(openRuntimeFolder), keyEquivalent: "o"))
        menu.addItem(NSMenuItem(title: "Выйти", action: #selector(quit), keyEquivalent: "q"))
        statusItem.menu = menu
        updatePauseItems()
    }

    @objc private func refreshStatus() {
        statusItem.button?.title = "ST ..."
        runInBackground({ [self] in
            run("/bin/zsh", [scriptPath("memory-guard.zsh"), "--once", "--dry-run"])
        }, completion: { [self] output in
            updateStatus(from: output)
        })
    }

    @objc private func sleepHeavyInactiveTabs() {
        runScriptAction(
            title: "Тяжёлые вкладки усыплены",
            scriptName: "sleep-inactive-youtube-tabs.applescript",
            messagePrefix: "Очистка тяжёлых фоновых вкладок"
        )
    }

    @objc private func sleepAllBackgroundTabs() {
        runScriptAction(
            title: "Фоновые вкладки усыплены",
            scriptName: "sleep-all-inactive-tabs.applescript",
            messagePrefix: "Очистка фоновых вкладок"
        )
    }

    @objc private func sleepActiveSafariTab() {
        runInBackground({ [self] in
            run("/usr/bin/osascript", [
                scriptPath("sleep-current-tab.applescript"),
                sleepServerURL,
                scriptPath("allowlist.txt")
            ])
        }, completion: { [self] output in
            if output.contains("reason=allowlisted") {
                notify("Вкладка защищена", "Этот сайт отмечен как «Не усыплять».")
            } else {
                notify("Активная вкладка усыплена", output.isEmpty ? "Активная вкладка Safari отправлена спать." : output)
            }
        })
    }

    @objc private func pauseMonitor() {
        do {
            try FileManager.default.createDirectory(at: runtimeDirectory, withIntermediateDirectories: true)
            let pauseUntil = String(Int(Date().timeIntervalSince1970) + 3600)
            try pauseUntil.write(to: pauseFile, atomically: true, encoding: .utf8)
            updatePauseItems()
            notify("Монитор на паузе", "Монитор памяти Safari Tab Sleeper остановлен на 1 час.")
        } catch {
            notify("Не удалось поставить на паузу", error.localizedDescription)
        }
    }

    @objc private func resumeMonitor() {
        try? FileManager.default.removeItem(at: pauseFile)
        updatePauseItems()
        notify("Монитор снова активен", "Монитор памяти Safari Tab Sleeper снова работает.")
    }

    @objc private func openRuntimeFolder() {
        NSWorkspace.shared.open(runtimeDirectory)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func runScriptAction(title: String, scriptName: String, messagePrefix: String) {
        runInBackground({ [self] in
            run("/usr/bin/osascript", [scriptPath(scriptName), sleepServerURL, scriptPath("allowlist.txt")])
        }, completion: { [self] output in
            let sleptCount = numericField("slept_count", in: output) ?? 0
            notify(title, "\(messagePrefix): усыплено вкладок: \(sleptCount).")
        })
    }

    private func updateStatus(from output: String) {
        let total = numericField("total_mb", in: output) ?? 0
        let max = numericField("max_mb", in: output) ?? 0
        let swap = numericField("swap_used_mb", in: output) ?? 0
        let over = numericField("over_threshold", in: output) == 1

        let titlePrefix = over ? "ST !" : "ST"
        statusItem.button?.title = "\(titlePrefix) \(formatGigabytes(total))"
        statusMenuItem.title = "Safari/WebKit: всего \(total) MB, максимум \(max) MB, swap \(swap) MB"
        updatePauseItems()
    }

    private func updatePauseItems() {
        let pauseUntil = (try? String(contentsOf: pauseFile, encoding: .utf8)).flatMap { Int($0.trimmingCharacters(in: .whitespacesAndNewlines)) } ?? 0
        let remaining = max(0, pauseUntil - Int(Date().timeIntervalSince1970))
        pauseMenuItem.isEnabled = remaining == 0
        resumeMenuItem.isEnabled = remaining > 0
        if remaining > 0 {
            resumeMenuItem.title = "Возобновить монитор (осталось \(remaining / 60) мин)"
        } else {
            resumeMenuItem.title = "Возобновить монитор"
        }
    }

    private func scriptPath(_ name: String) -> String {
        runtimeDirectory.appendingPathComponent(name).path
    }

    private func formatGigabytes(_ megabytes: Int) -> String {
        String(format: "%.1fG", Double(megabytes) / 1024.0)
    }

    private func numericField(_ field: String, in text: String) -> Int? {
        let pattern = "\(NSRegularExpression.escapedPattern(for: field))=([0-9]+)"
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return nil
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, range: range),
              let valueRange = Range(match.range(at: 1), in: text) else {
            return nil
        }
        return Int(text[valueRange])
    }

    @discardableResult
    private func run(_ executable: String, _ arguments: [String]) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return "error=\(error.localizedDescription)"
        }
    }

    private func runInBackground(_ work: @escaping () -> String, completion: @escaping (String) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let output = work()
            DispatchQueue.main.async {
                completion(output)
            }
        }
    }

    private func notify(_ title: String, _ message: String) {
        let script = "display notification \(appleScriptLiteral(message)) with title \(appleScriptLiteral(title))"
        _ = run("/usr/bin/osascript", ["-e", script])
    }

    private func appleScriptLiteral(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
