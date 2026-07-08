#!/usr/bin/env python3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import subprocess
import sys
from urllib.parse import parse_qs, urlparse

HOST = "127.0.0.1"
PORT = int(os.environ.get("SAFARI_TAB_SLEEPER_PORT", "17654"))
PRESSURE_THRESHOLD_GB = float(os.environ.get("SAFARI_TAB_SLEEPER_PRESSURE_GB", "3"))
ALERT_THRESHOLD_GB = float(os.environ.get("SAFARI_TAB_SLEEPER_ALERT_GB", "5"))
ARCHIVE_PATH = os.environ.get(
    "SAFARI_TAB_SLEEPER_ARCHIVE_PATH",
    os.path.join(os.path.dirname(__file__), "sleep-archive.json"),
)
ARCHIVE_LIMIT = int(os.environ.get("SAFARI_TAB_SLEEPER_ARCHIVE_LIMIT", "300"))

SLEEP_HTML = r"""<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Спящая вкладка</title>
  <link id="favicon" rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23f2f5f4'/%3E%3Cpath d='M10 11h12l-9 10h9' fill='none' stroke='%2364706d' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
  <style>
    :root { color-scheme: light; --accent: #0d8f7f; --accent-strong: #06695e; --bg: #f5faf8; --panel: #fff; --text: #17211f; --muted: #64706d; --border: #dce5e2; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--text); background: var(--bg); }
    main { width: min(620px, 100%); padding: 28px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
    .eyebrow { margin: 0 0 8px; color: var(--accent-strong); font-weight: 740; }
    h1 { margin: 0 0 10px; font-size: clamp(28px, 5vw, 44px); line-height: 1.08; }
    p { color: var(--muted); overflow-wrap: anywhere; }
    button, a { display: inline-flex; align-items: center; min-height: 40px; margin-top: 12px; border-radius: 8px; padding: 9px 14px; font: inherit; font-weight: 700; }
    button { border: 1px solid var(--accent); color: white; background: var(--accent); cursor: pointer; }
    a { color: var(--accent-strong); }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Safari Tab Sleeper</p>
    <h1 id="title">Вкладка выгружена.</h1>
    <p id="url">Исходная страница больше не работает.</p>
    <button id="restore" type="button">Восстановить вкладку</button>
    <a id="direct" href="#" hidden>Открыть исходный URL</a>
  </main>
  <script>
    const params = new URLSearchParams(location.hash.slice(1));
    const entry = decodeFallbackEntry(params.get('fallback'));
    const title = document.querySelector('#title');
    const url = document.querySelector('#url');
    const restore = document.querySelector('#restore');
    const direct = document.querySelector('#direct');
    const favicon = document.querySelector('#favicon');
    let wasHiddenAfterSleep = document.visibilityState === 'hidden';

    function decodeFallbackEntry(encoded) {
      try {
        if (!encoded) return null;
        const padded = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return null;
      }
    }

    function reasonTag(reason) {
      const tags = {
        'inactive-timeout': 'idle',
        'youtube-smart-cleanup': 'youtube',
        'manual-youtube-cleanup': 'youtube',
        'aggressive-domain': 'aggressive',
        'memory-pressure': 'memory',
        'memory-guard': 'memory',
        'manual-current-tab': 'manual',
        'manual-all-except-current': 'manual'
      };
      return tags[reason] || 'sleep';
    }

    function sleepingTitle(originalTitle, reason) {
      const cleanTitle = String(originalTitle || '').replace(/^\[(?:sleep|спит)(?::[^\]]+)?\]\s*/i, '').trim() || 'Спящая вкладка';
      const tag = reasonTag(reason);
      return tag === 'sleep' ? `[sleep] ${cleanTitle}` : `[sleep: ${tag}] ${cleanTitle}`;
    }

    function siteIcon(pageUrl, favIconUrl) {
      try {
        if (favIconUrl && /^https?:\/\//i.test(favIconUrl)) return favIconUrl;
        const parsed = new URL(normalizeRestorableUrl(pageUrl) || pageUrl);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return `${parsed.origin}/favicon.ico`;
      } catch {
        return '';
      }
      return '';
    }

    function decodeURIComponentSafely(value) {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }

    function normalizeRestorableUrl(value) {
      const candidates = [];
      const add = (candidate) => {
        const text = String(candidate || '').trim();
        if (text && !candidates.includes(text)) candidates.push(text);
      };

      add(value);
      let decoded = String(value || '').trim();
      for (let i = 0; i < 3; i += 1) {
        const next = decodeURIComponentSafely(decoded);
        if (next === decoded) break;
        decoded = next;
        add(decoded);
      }

      for (const candidate of [...candidates]) {
        try {
          const parsed = new URL(candidate);
          for (const key of ['url', 'u', 'target']) add(parsed.searchParams.get(key));
        } catch {}

        for (const match of candidate.match(/https?:\/\/[^\s"'<>]+/gi) || []) {
          add(match.replace(/[),.;]+$/, ''));
        }
      }

      for (const candidate of candidates) {
        try {
          const parsed = new URL(candidate);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
        } catch {}
      }

      return '';
    }

    function restoreNow() {
      if (restorableUrl) location.replace(restorableUrl);
    }

    function getAutoRestoreDelay() {
      if (!entry?.url || entry.autoRestore === false || entry.reason === 'manual-current-tab') return null;
      const sleptAt = Number(entry.sleptAt || 0);
      if (!sleptAt) return 0;
      return Math.max(0, 1200 - Math.max(0, Date.now() - sleptAt));
    }

    function scheduleRestoreOnReturn() {
      if (!restorableUrl || document.visibilityState !== 'visible') return;

      const automaticDelay = getAutoRestoreDelay();
      const manualReturn = entry.reason === 'manual-current-tab' && wasHiddenAfterSleep;
      if (automaticDelay === null && !manualReturn) return;

      window.setTimeout(() => {
        if (document.visibilityState === 'visible') restoreNow();
      }, (manualReturn ? 0 : automaticDelay) + 180);
    }

    const restorableUrl = normalizeRestorableUrl(entry?.url);

    if (restorableUrl) {
      document.title = sleepingTitle(entry.title, entry.reason);
      title.textContent = entry.title || 'Спящая вкладка';
      url.textContent = `Исходный URL: ${restorableUrl}`;
      direct.href = restorableUrl;
      direct.hidden = false;
      const iconUrl = siteIcon(restorableUrl, entry.favIconUrl);
      if (iconUrl) favicon.href = iconUrl;
      restore.addEventListener('click', restoreNow);

      window.addEventListener('focus', scheduleRestoreOnReturn);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          wasHiddenAfterSleep = true;
          return;
        }

        scheduleRestoreOnReturn();
      });
      scheduleRestoreOnReturn();
    } else {
      title.textContent = 'Не удалось восстановить вкладку';
      url.textContent = 'В локальной sleep-странице нет сохранённого исходного URL.';
      restore.disabled = true;
    }
  </script>
</body>
</html>
"""


def run_command(args):
    try:
        result = subprocess.run(
            args,
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
        return result.stdout
    except Exception:
        return ""


def measure_swap_mb():
    output = run_command(["sysctl", "vm.swapusage"])
    match = re.search(r"used = ([0-9.]+)([KMG])", output)
    if not match:
        return 0

    value = float(match.group(1))
    unit = match.group(2)
    if unit == "G":
        return int(value * 1024 + 0.5)
    if unit == "K":
        return int(value / 1024 + 0.5)
    return int(value + 0.5)


def format_mb(value):
    value = int(value or 0)
    if value >= 1024:
        text = f"{value / 1024:.1f}".replace(".", ",")
        return f"{text} ГБ"
    return f"{value} МБ"


def collect_memory_status():
    total_kb = 0
    max_kb = 0
    top_pid = ""
    top_command = ""
    output = run_command(["ps", "-axo", "pid=,rss=,command="])

    for line in output.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) < 3:
            continue

        pid, rss_text, command = parts
        if not re.search(r"Safari|WebKit|com\.apple\.WebKit", command):
            continue
        if "memory-guard.zsh" in command:
            continue

        try:
            rss = int(rss_text)
        except ValueError:
            continue

        total_kb += rss
        if rss > max_kb:
            max_kb = rss
            top_pid = pid
            top_command = command

    total_mb = int(total_kb / 1024 + 0.5)
    max_mb = int(max_kb / 1024 + 0.5)
    swap_used_mb = measure_swap_mb()
    pressure_kb = PRESSURE_THRESHOLD_GB * 1024 * 1024
    alert_kb = ALERT_THRESHOLD_GB * 1024 * 1024

    return {
        "ok": True,
        "totalMb": total_mb,
        "maxMb": max_mb,
        "swapUsedMb": swap_used_mb,
        "overThreshold": total_kb >= pressure_kb or max_kb >= pressure_kb or swap_used_mb * 1024 >= pressure_kb,
        "overAlert": total_kb >= alert_kb or max_kb >= alert_kb or swap_used_mb * 1024 >= alert_kb,
        "topPid": top_pid,
        "topCommand": top_command,
        "label": f"Safari/WebKit: {format_mb(total_mb)}",
        "details": f"Пик процесса {format_mb(max_mb)} · swap {format_mb(swap_used_mb)}",
    }


def collect_power_status():
    output = run_command(["pmset", "-g", "batt"])
    lower_output = output.lower()
    source = "unknown"
    if "battery power" in lower_output:
        source = "battery"
    elif "ac power" in lower_output:
        source = "power"

    percent_match = re.search(r"(\d+)%", output)
    percent = int(percent_match.group(1)) if percent_match else None
    charging = "charging" in lower_output or source == "power"

    if source == "battery" and percent is not None:
        label = f"Питание: батарея {percent}% — усыпление быстрее"
    elif source == "power":
        label = "Питание: зарядка — усыпление мягче"
    else:
        label = "Питание: неизвестно — обычный режим"

    return {
        "ok": True,
        "source": source,
        "batteryPercent": percent,
        "charging": charging,
        "label": label,
    }


def normalize_archive_url(value):
    text = str(value or "").strip()
    parsed = urlparse(text)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return ""
    return parsed.geturl()


def sanitize_archive_entry(entry):
    if not isinstance(entry, dict):
        return None

    restorable_url = normalize_archive_url(entry.get("url"))
    token = str(entry.get("token") or "").strip()
    if not restorable_url or not token:
        return None

    return {
        "token": token,
        "url": restorable_url,
        "title": str(entry.get("title") or restorable_url),
        "favIconUrl": str(entry.get("favIconUrl") or ""),
        "sleptAt": int(float(entry.get("sleptAt") or 0)),
        "reason": str(entry.get("reason") or "inactive-timeout"),
        "autoRestore": entry.get("autoRestore") is not False,
    }


def load_archive_entries():
    try:
        with open(ARCHIVE_PATH, "r", encoding="utf-8") as file:
            data = json.load(file)
        entries = data.get("entries", []) if isinstance(data, dict) else []
        return [entry for entry in entries if sanitize_archive_entry(entry)]
    except Exception:
        return []


def compact_archive_entries(entries):
    clean_entries = [sanitize_archive_entry(entry) for entry in entries]
    clean_entries = [entry for entry in clean_entries if entry]
    clean_entries.sort(key=lambda entry: int(entry.get("sleptAt") or 0), reverse=True)

    seen_urls = set()
    seen_tokens = set()
    compacted = []
    for entry in clean_entries:
        url_key = normalize_archive_url(entry.get("url"))
        token_key = entry.get("token")
        if not url_key or not token_key or url_key in seen_urls or token_key in seen_tokens:
            continue
        seen_urls.add(url_key)
        seen_tokens.add(token_key)
        compacted.append(entry)
        if len(compacted) >= ARCHIVE_LIMIT:
            break

    return compacted


def save_archive_entries(entries):
    archive_dir = os.path.dirname(ARCHIVE_PATH)
    if archive_dir:
        os.makedirs(archive_dir, exist_ok=True)
    compacted = compact_archive_entries(entries)
    with open(ARCHIVE_PATH, "w", encoding="utf-8") as file:
        json.dump({"entries": compacted}, file, ensure_ascii=False, indent=2)
    return compacted


def archive_entry(entry):
    clean_entry = sanitize_archive_entry(entry)
    if not clean_entry:
        return None, save_archive_entries(load_archive_entries())

    entries = [
        existing for existing in load_archive_entries()
        if existing.get("token") != clean_entry["token"]
    ]
    entries.append(clean_entry)
    return clean_entry, save_archive_entries(entries)


def find_archived_entry(token):
    entries = save_archive_entries(load_archive_entries())
    for entry in entries:
        if entry.get("token") == token:
            return entry, entries
    return None, entries


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            self.send_text(200, "ok\n", "text/plain; charset=utf-8")
            return
        if path == "/memory":
            self.send_json(200, collect_memory_status())
            return
        if path == "/power":
            self.send_json(200, collect_power_status())
            return
        if path == "/archive-entry":
            query = parse_qs(urlparse(self.path).query)
            token = (query.get("token") or [""])[0]
            entry, entries = find_archived_entry(token)
            if entry:
                self.send_json(200, {"ok": True, "entry": entry, "count": len(entries)})
                return
            self.send_json(404, {"ok": False, "reason": "missing-archive-entry", "count": len(entries)})
            return
        if path in ("/", "/sleep"):
            self.send_text(200, SLEEP_HTML, "text/html; charset=utf-8")
            return
        if path == "/favicon.ico":
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            return
        self.send_text(404, "not found\n", "text/plain; charset=utf-8")

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/archive-entry":
            self.send_text(404, "not found\n", "text/plain; charset=utf-8")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(min(length, 256 * 1024))
            body = json.loads(raw_body.decode("utf-8") or "{}")
            entry, entries = archive_entry(body.get("entry"))
            if not entry:
                self.send_json(400, {"ok": False, "reason": "invalid-archive-entry", "count": len(entries)})
                return
            self.send_json(200, {"ok": True, "entry": entry, "count": len(entries)})
        except Exception as error:
            self.send_json(500, {"ok": False, "reason": str(error)})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def send_text(self, status, body, content_type):
        encoded = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(encoded)

    def send_json(self, status, body):
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Safari Tab Sleeper server listening on http://{HOST}:{PORT}/sleep", flush=True)
    server.serve_forever()
