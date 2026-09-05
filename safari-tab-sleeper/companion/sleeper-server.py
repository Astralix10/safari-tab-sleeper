#!/usr/bin/env python3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import base64
import fcntl
import hmac
import json
import os
import re
import secrets
import subprocess
import threading
import time
from urllib.parse import parse_qs, urlparse

HOST = "127.0.0.1"
PORT = int(os.environ.get("SAFARI_TAB_SLEEPER_PORT", "17654"))
PRESSURE_THRESHOLD_GB = float(os.environ.get("SAFARI_TAB_SLEEPER_PRESSURE_GB", "3"))
ALERT_THRESHOLD_GB = float(os.environ.get("SAFARI_TAB_SLEEPER_ALERT_GB", "5"))
ARCHIVE_PATH = os.environ.get(
    "SAFARI_TAB_SLEEPER_ARCHIVE_PATH",
    os.path.join(os.path.dirname(__file__), "sleep-archive.json"),
)
ALLOWLIST_PATH = os.environ.get(
    "SAFARI_TAB_SLEEPER_ALLOWLIST_PATH",
    os.path.join(os.path.dirname(__file__), "allowlist.txt"),
)
SETTINGS_READY_PATH = os.environ.get(
    "SAFARI_TAB_SLEEPER_SETTINGS_READY_PATH",
    os.path.join(os.path.dirname(ALLOWLIST_PATH) or os.path.dirname(__file__), "settings-ready"),
)
SETTINGS_PATH = os.environ.get(
    "SAFARI_TAB_SLEEPER_SETTINGS_PATH",
    os.path.join(os.path.dirname(ALLOWLIST_PATH) or os.path.dirname(__file__), "companion-settings.json"),
)
TRUSTED_ORIGIN_PATH = os.environ.get(
    "SAFARI_TAB_SLEEPER_TRUSTED_ORIGIN_PATH",
    os.path.join(os.path.dirname(ALLOWLIST_PATH) or os.path.dirname(__file__), "trusted-extension-origin.txt"),
)
HEARTBEAT_PATH = os.environ.get(
    "SAFARI_TAB_SLEEPER_HEARTBEAT_PATH",
    os.path.join(os.path.dirname(ALLOWLIST_PATH) or os.path.dirname(__file__), "extension-heartbeat.txt"),
)
ARCHIVE_LIMIT = int(os.environ.get("SAFARI_TAB_SLEEPER_ARCHIVE_LIMIT", "300"))
YOUTUBE_FAMILY_DOMAINS = ("youtube.com", "youtu.be", "youtube-nocookie.com")
YOUTUBE_ALLOWLIST_PATTERNS = (
    "youtube.com",
    "*.youtube.com",
    "youtu.be",
    "*.youtu.be",
    "youtube-nocookie.com",
    "*.youtube-nocookie.com",
)
TRUSTED_EXTENSION_SCHEMES = (
    "safari-web-extension://",
    "safari-extension://",
    "chrome-extension://",
    "moz-extension://",
)
MUTATION_HEADER = "X-Safari-Tab-Sleeper-Token"
NATIVE_HEADER = "X-Safari-Tab-Sleeper-Native"
MUTATION_TOKEN = os.environ.get(
    "SAFARI_TAB_SLEEPER_MUTATION_TOKEN",
    "",
)
SLEEP_CURRENT_SCRIPT = os.environ.get(
    "SAFARI_TAB_SLEEPER_CURRENT_SCRIPT",
    os.path.join(os.path.dirname(__file__), "sleep-current-tab.applescript"),
)
ARCHIVE_LOCK = threading.RLock()
ACTIVE_ARCHIVE_TOKENS = None
SETTINGS_LOCK = threading.RLock()
TRUSTED_ORIGIN_LOCK = threading.RLock()
HEARTBEAT_LOCK = threading.RLock()
CLEANUP_REQUEST_LOCK = threading.RLock()
LAST_EXTENSION_HEARTBEAT = 0.0
LAST_EXTENSION_VERSION = ""
PENDING_CLEANUP_REQUEST = None
EXTENSION_HEARTBEAT_MAX_AGE_SECONDS = 15 * 60

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
    const token = params.get('token') || new URLSearchParams(location.search).get('token') || '';
    let entry = decodeFallbackEntry(params.get('fallback')) || legacySleepEntry(params);
    let restorableUrl = '';
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

    function legacySleepEntry(hashParams) {
      const originalUrl = hashParams.get('url');
      if (!originalUrl) return null;
      return {
        token: '',
        url: originalUrl,
        title: hashParams.get('title') || originalUrl,
        favIconUrl: '',
        sleptAt: Date.now(),
        reason: hashParams.get('reason') || 'memory-pressure',
        autoRestore: hashParams.get('auto') === '1'
      };
    }

    function reasonTag(reason) {
      const tags = {
        'inactive-timeout': 'idle',
        'youtube-smart-cleanup': 'youtube',
        'manual-youtube-cleanup': 'youtube',
        'aggressive-domain': 'aggressive',
        'memory-pressure': 'memory',
        'memory-guard': 'memory',
        'manual-memory-cleanup': 'memory',
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
      return /^data:|^blob:/i.test(String(favIconUrl || '')) ? favIconUrl : '';
    }

    function decodeURIComponentSafely(value) {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }

    function unwrapSleepUrl(value) {
      let current = String(value || '').trim();
      const seen = new Set();
      for (let depth = 0; depth < 8 && current && !seen.has(current); depth += 1) {
        seen.add(current);
        try {
          const parsed = new URL(current);
          const protocol = parsed.protocol.toLowerCase();
          const path = parsed.pathname.toLowerCase();
          const host = parsed.hostname.toLowerCase();
          const isWrapper = (protocol === 'file:' && path.endsWith('/local-sleeper.html'))
            || ((host === '127.0.0.1' || host === 'localhost') && path === '/sleep')
            || (protocol.includes('extension:') && path.endsWith('/sleep/sleep.html'));
          if (!isWrapper) break;
          const sleepParams = new URLSearchParams(parsed.hash.slice(1));
          const fallback = decodeFallbackEntry(sleepParams.get('fallback'));
          const next = sleepParams.get('url') || fallback?.url || '';
          if (!next) break;
          current = next;
        } catch {
          break;
        }
      }
      return current;
    }

    function normalizeRestorableUrl(value) {
      let candidate = unwrapSleepUrl(value);
      if (candidate.startsWith('about:reader?')) candidate = new URL(candidate).searchParams.get('url') || '';
      for (const prefix of ['x-safari-reader://', 'safari-reader://']) {
        if (candidate.toLowerCase().startsWith(prefix)) candidate = decodeURIComponentSafely(candidate.slice(prefix.length));
      }
      try {
        const parsed = new URL(candidate);
        if (['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.pathname === '/sleep') return '';
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
      } catch {}
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
      if (!restorableUrl || entry.restoreOnFocus === false || document.visibilityState !== 'visible') return;

      const automaticDelay = getAutoRestoreDelay();
      const manualReturn = entry.reason === 'manual-current-tab' && wasHiddenAfterSleep;
      if (automaticDelay === null && !manualReturn) return;

      window.setTimeout(() => {
        if (document.visibilityState === 'visible') restoreNow();
      }, (manualReturn ? 0 : automaticDelay) + 180);
    }

    function renderEntry() {
      restorableUrl = normalizeRestorableUrl(entry?.url);
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
    }

    async function loadEntry() {
      if (!entry && token) {
        for (let attempt = 0; attempt < 12 && !entry; attempt += 1) {
          try {
            const response = await fetch(`/archive-entry?token=${encodeURIComponent(token)}`, { cache: 'no-store' });
            if (response.ok) entry = (await response.json()).entry || null;
          } catch {}
          if (!entry) await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      renderEntry();
    }
    loadEntry();
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


def is_safari_process(command):
    return bool(re.search(
        r"^(?:/Applications/Safari\.app/Contents/MacOS/Safari|"
        r"/Applications/Safari Technology Preview\.app/Contents/MacOS/Safari Technology Preview|"
        r"/System/Applications/Safari\.app/Contents/MacOS/Safari|"
        r"/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari\.app/Contents/MacOS/Safari|"
        r"/System/Volumes/Preboot/Cryptexes/App/System/Library/StagedFrameworks/Safari/.*/com\.apple\.WebKit\.(?:WebContent|GPU|Networking)|"
        r"/System/Library/.*/com\.apple\.WebKit\.(?:WebContent|GPU|Networking))(?:\s|$)",
        str(command or ""),
    ))


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
        if not is_safari_process(command):
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
        "overThreshold": total_kb >= pressure_kb or max_kb >= pressure_kb,
        "overAlert": total_kb >= alert_kb or max_kb >= alert_kb,
        "topPid": top_pid,
        "topCommand": top_command,
        "label": f"Safari/WebKit: {format_mb(total_mb)}",
        "details": f"Пик процесса {format_mb(max_mb)} · системный swap {format_mb(swap_used_mb)}",
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
    charging = bool(re.search(r";\s*charging(?:;|$)", lower_output)) or source == "power"

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


def collect_active_safari_tab():
    script = r'''
tell application "Safari"
    if it is not running then return ""
    if (count of windows) is 0 then return ""
    set targetTab to current tab of front window
    set tabURL to URL of targetTab
    try
        set tabTitle to name of targetTab
    on error
        set tabTitle to tabURL
    end try
    return tabURL & linefeed & tabTitle
end tell
'''
    output = run_command(["/usr/bin/osascript", "-e", script]).rstrip("\n")
    if not output:
        return {"ok": False, "reason": "missing-active-tab", "url": "", "title": ""}

    url, _, title = output.partition("\n")
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return {"ok": False, "reason": "unsupported-active-tab", "url": "", "title": ""}

    return {
        "ok": True,
        "url": parsed.geturl(),
        "title": title.strip() or parsed.geturl(),
    }


def sleep_current_safari_tab():
    if not os.path.isfile(SLEEP_CURRENT_SCRIPT):
        return {"ok": False, "reason": "sleep-script-missing"}

    active_tab = collect_active_safari_tab()
    token = secrets.token_urlsafe(18)
    try:
        result = subprocess.run(
            [
                "/usr/bin/osascript",
                SLEEP_CURRENT_SCRIPT,
                f"http://{HOST}:{PORT}/sleep",
                ALLOWLIST_PATH,
                token,
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=8,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "reason": "automation-timeout"}
    except Exception:
        return {"ok": False, "reason": "automation-unavailable"}

    output = str(result.stdout or "").strip()
    reason_match = re.search(r"(?:^|\s)reason=([^\s]+)", output)
    count_match = re.search(r"(?:^|\s)slept_count=(\d+)", output)
    slept_count = int(count_match.group(1)) if count_match else 0
    if result.returncode == 0 and slept_count > 0:
        response = {"ok": True, "sleptCount": slept_count}
        if active_tab.get("ok"):
            entry, _ = archive_entry({
                "token": token,
                "url": active_tab.get("url"),
                "title": active_tab.get("title"),
                "sleptAt": int(time.time() * 1000),
                "reason": "manual-current-tab",
                "autoRestore": False,
            })
            if entry:
                response["token"] = entry["token"]
        return response

    if reason_match:
        return {"ok": False, "reason": reason_match.group(1), "sleptCount": slept_count}
    return {
        "ok": False,
        "reason": "automation-failed" if result.returncode else "missing-active-tab",
        "sleptCount": slept_count,
    }


def sanitize_domain_patterns(value):
    raw_entries = value if isinstance(value, list) else []
    patterns = []

    def add_pattern(pattern):
        if pattern and pattern not in patterns:
            patterns.append(pattern)

    for raw_entry in raw_entries:
        entry = str(raw_entry or "").strip().lower()
        if not entry or entry.startswith("#"):
            continue
        if "://" in entry:
            parsed = urlparse(entry)
            entry = parsed.hostname or ""
        entry = entry.split("/", 1)[0].strip()
        if not entry or entry.startswith("#"):
            continue
        add_pattern(entry)
        if is_youtube_family_domain(entry):
            for youtube_pattern in YOUTUBE_ALLOWLIST_PATTERNS:
                add_pattern(youtube_pattern)
    return patterns


def is_youtube_family_domain(value):
    domain = str(value or "").lower()
    if domain.startswith("*."):
        domain = domain[2:]
    if domain.startswith("www."):
        domain = domain[4:]
    return any(domain == youtube_domain or domain.endswith(f".{youtube_domain}") for youtube_domain in YOUTUBE_FAMILY_DOMAINS)


def write_allowlist(patterns):
    with SETTINGS_LOCK:
        allowlist_dir = os.path.dirname(ALLOWLIST_PATH)
        if allowlist_dir:
            os.makedirs(allowlist_dir, exist_ok=True)
        temp_path = f"{ALLOWLIST_PATH}.tmp"
        with open(temp_path, "w", encoding="utf-8") as file:
            file.write("".join(f"{pattern}\n" for pattern in patterns))
        os.replace(temp_path, ALLOWLIST_PATH)


def write_settings_ready():
    with SETTINGS_LOCK:
        if settings_ready():
            return
        ready_dir = os.path.dirname(SETTINGS_READY_PATH)
        if ready_dir:
            os.makedirs(ready_dir, exist_ok=True)
        with open(SETTINGS_READY_PATH, "w", encoding="utf-8") as file:
            file.write("ready\n")


def settings_ready():
    return os.path.exists(SETTINGS_READY_PATH)


def normalize_extension_origin(value):
    candidate = str(value or "").strip()
    if not candidate.startswith(TRUSTED_EXTENSION_SCHEMES):
        return ""
    parsed = urlparse(candidate)
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


def read_trusted_extension_origin():
    with TRUSTED_ORIGIN_LOCK:
        try:
            with open(TRUSTED_ORIGIN_PATH, "r", encoding="utf-8") as file:
                return normalize_extension_origin(file.read())
        except Exception:
            return ""


def pair_extension_origin(origin):
    candidate = normalize_extension_origin(origin)
    if not candidate:
        return False

    with TRUSTED_ORIGIN_LOCK:
        trusted_origin = read_trusted_extension_origin()
        if trusted_origin and hmac.compare_digest(candidate, trusted_origin):
            return True

        # Safari can rotate a WebExtension's internal UUID after an app update.
        # The bearer token remains the authentication boundary, so remember the
        # latest valid extension origin instead of breaking the new popup/worker.
        origin_dir = os.path.dirname(TRUSTED_ORIGIN_PATH)
        if origin_dir:
            os.makedirs(origin_dir, exist_ok=True)
        temp_path = f"{TRUSTED_ORIGIN_PATH}.tmp"
        with open(temp_path, "w", encoding="utf-8") as file:
            file.write(f"{candidate}\n")
        os.replace(temp_path, TRUSTED_ORIGIN_PATH)
        return True


def mark_extension_heartbeat(body=None):
    global LAST_EXTENSION_HEARTBEAT, LAST_EXTENSION_VERSION
    timestamp = time.time()
    with HEARTBEAT_LOCK:
        LAST_EXTENSION_HEARTBEAT = timestamp
        LAST_EXTENSION_VERSION = str((body or {}).get("version") or "")[:32]
        try:
            heartbeat_dir = os.path.dirname(HEARTBEAT_PATH)
            if heartbeat_dir:
                os.makedirs(heartbeat_dir, exist_ok=True)
            temp_path = f"{HEARTBEAT_PATH}.tmp"
            with open(temp_path, "w", encoding="utf-8") as file:
                file.write(f"{timestamp:.6f}\n")
            os.replace(temp_path, HEARTBEAT_PATH)
        except OSError:
            pass
    return {"ok": True, "active": True}


def collect_extension_state():
    global LAST_EXTENSION_HEARTBEAT
    with HEARTBEAT_LOCK:
        if not LAST_EXTENSION_HEARTBEAT:
            try:
                with open(HEARTBEAT_PATH, "r", encoding="utf-8") as file:
                    LAST_EXTENSION_HEARTBEAT = float(file.read().strip())
            except (OSError, ValueError):
                LAST_EXTENSION_HEARTBEAT = 0.0
        age_seconds = max(0.0, time.time() - LAST_EXTENSION_HEARTBEAT) if LAST_EXTENSION_HEARTBEAT else None
    active = age_seconds is not None and age_seconds <= EXTENSION_HEARTBEAT_MAX_AGE_SECONDS
    return {
        "ok": True,
        "active": active,
        "ageSeconds": round(age_seconds, 1) if age_seconds is not None else None,
        "version": LAST_EXTENSION_VERSION,
    }


def read_allowlist():
    with SETTINGS_LOCK:
        try:
            with open(ALLOWLIST_PATH, "r", encoding="utf-8") as file:
                return sanitize_domain_patterns(file.read().splitlines())
        except Exception:
            return []


def read_companion_settings():
    with SETTINGS_LOCK:
        try:
            with open(SETTINGS_PATH, "r", encoding="utf-8") as file:
                data = json.load(file)
            if not isinstance(data, dict):
                raise ValueError("invalid-settings")
        except Exception:
            data = {}
        return {
            "allowlist": sanitize_domain_patterns(data.get("allowlist", read_allowlist())),
            "pressureDomains": sanitize_domain_patterns(data.get("pressureDomains", [])),
        }


def save_companion_settings(settings):
    if not isinstance(settings, dict) or not isinstance(settings.get("allowlist"), list):
        raise ValueError("invalid-settings-schema")
    if "pressureDomains" in settings and not isinstance(settings.get("pressureDomains"), list):
        raise ValueError("invalid-settings-schema")
    allowlist = sanitize_domain_patterns(settings["allowlist"])
    pressure_domains = sanitize_domain_patterns(settings.get("pressureDomains", []))
    with SETTINGS_LOCK:
        if settings_ready() and read_companion_settings() == {"allowlist": allowlist, "pressureDomains": pressure_domains}:
            return {"ok": True, "ready": True, "allowlist": allowlist, "pressureDomains": pressure_domains}
        if read_allowlist() != allowlist:
            write_allowlist(allowlist)
        settings_dir = os.path.dirname(SETTINGS_PATH)
        if settings_dir:
            os.makedirs(settings_dir, exist_ok=True)
        temp_path = f"{SETTINGS_PATH}.tmp"
        with open(temp_path, "w", encoding="utf-8") as file:
            json.dump({"allowlist": allowlist, "pressureDomains": pressure_domains}, file, ensure_ascii=False, indent=2)
        os.replace(temp_path, SETTINGS_PATH)
        write_settings_ready()
    return {
        "ok": True,
        "ready": True,
        "allowlist": allowlist,
        "pressureDomains": pressure_domains,
    }


def queue_cleanup_request(body):
    global PENDING_CLEANUP_REQUEST
    with CLEANUP_REQUEST_LOCK:
        action = str(body.get("action") or "queue")
        if action == "ack":
            request_id = str(body.get("requestId") or "")
            if PENDING_CLEANUP_REQUEST and hmac.compare_digest(request_id, PENDING_CLEANUP_REQUEST["requestId"]):
                PENDING_CLEANUP_REQUEST = None
            return {"ok": True, "pending": PENDING_CLEANUP_REQUEST is not None}
        request_id = secrets.token_urlsafe(18)
        PENDING_CLEANUP_REQUEST = {
            "requestId": request_id,
            "requestedAt": int(time.time() * 1000),
            "totalMb": max(0, int(float(body.get("totalMb") or 0))),
            "maxMb": max(0, int(float(body.get("maxMb") or 0))),
        }
        return {"ok": True, "queued": True, **PENDING_CLEANUP_REQUEST}


def read_cleanup_request():
    with CLEANUP_REQUEST_LOCK:
        if not PENDING_CLEANUP_REQUEST:
            return {"ok": True, "pending": False}
        return {"ok": True, "pending": True, **PENDING_CLEANUP_REQUEST}


def is_known_sleep_wrapper(parsed):
    scheme = str(parsed.scheme or "").lower()
    hostname = str(parsed.hostname or "").lower()
    path = str(parsed.path or "").lower()
    if scheme == "file" and path.endswith("/local-sleeper.html"):
        return True
    if hostname in ("127.0.0.1", "localhost") and path == "/sleep":
        return True
    return scheme in ("safari-web-extension", "safari-extension", "chrome-extension", "moz-extension") and path.endswith("/sleep/sleep.html")


def decode_fallback_url(encoded):
    try:
        value = str(encoded or "")
        padded = value + "=" * (-len(value) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
        return str(payload.get("url") or "") if isinstance(payload, dict) else ""
    except Exception:
        return ""


def unwrap_sleep_url(value):
    current = str(value or "").strip()
    seen = set()
    for _ in range(8):
        if not current or current in seen:
            break
        seen.add(current)
        parsed = urlparse(current)
        if not is_known_sleep_wrapper(parsed):
            break
        params = parse_qs(parsed.fragment)
        next_url = (params.get("url") or [""])[0]
        if not next_url:
            next_url = decode_fallback_url((params.get("fallback") or [""])[0])
        if not next_url:
            return ""
        current = next_url.strip()
    return current


def normalize_archive_url(value):
    text = unwrap_sleep_url(value)
    parsed = urlparse(text)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or is_known_sleep_wrapper(parsed):
        return ""
    return parsed.geturl()


def sanitize_archive_entry(entry):
    if not isinstance(entry, dict):
        return None

    restorable_url = normalize_archive_url(entry.get("url"))
    token = str(entry.get("token") or "").strip()
    if not restorable_url or not token:
        return None

    try:
        slept_at = max(0, int(float(entry.get("sleptAt") or 0)))
    except (TypeError, ValueError, OverflowError):
        return None

    return {
        "token": token,
        "url": restorable_url,
        "title": str(entry.get("title") or restorable_url),
        "favIconUrl": str(entry.get("favIconUrl") or ""),
        "sleptAt": slept_at,
        "reason": str(entry.get("reason") or "inactive-timeout"),
        "autoRestore": entry.get("autoRestore") is not False,
        "restoreOnFocus": entry.get("restoreOnFocus") is not False,
    }


def load_archive_entries():
    global ACTIVE_ARCHIVE_TOKENS
    with ARCHIVE_LOCK:
        try:
            with open(ARCHIVE_PATH, "r", encoding="utf-8") as file:
                data = json.load(file)
            entries = data.get("entries", []) if isinstance(data, dict) else []
            if ACTIVE_ARCHIVE_TOKENS is None:
                ACTIVE_ARCHIVE_TOKENS = set(data.get("activeTokens", [])) if isinstance(data, dict) else set()
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
    inactive_count = 0
    for entry in clean_entries:
        url_key = normalize_archive_url(entry.get("url"))
        token_key = entry.get("token")
        active = token_key in (ACTIVE_ARCHIVE_TOKENS or set())
        if not url_key or not token_key or token_key in seen_tokens:
            continue
        if not active and (url_key in seen_urls or inactive_count >= ARCHIVE_LIMIT):
            continue
        seen_urls.add(url_key)
        seen_tokens.add(token_key)
        compacted.append(entry)
        if not active:
            inactive_count += 1

    return compacted


def save_archive_entries(entries):
    with ARCHIVE_LOCK:
        archive_dir = os.path.dirname(ARCHIVE_PATH)
        if archive_dir:
            os.makedirs(archive_dir, exist_ok=True)
        compacted = compact_archive_entries(entries)
        temp_path = f"{ARCHIVE_PATH}.tmp"
        payload = {"entries": compacted, "activeTokens": sorted(ACTIVE_ARCHIVE_TOKENS or [])}
        try:
            with open(ARCHIVE_PATH, "r", encoding="utf-8") as file:
                if json.load(file) == payload:
                    return compacted
        except (OSError, ValueError):
            pass
        with open(temp_path, "w", encoding="utf-8") as file:
            json.dump(payload, file, ensure_ascii=False, indent=2)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp_path, ARCHIVE_PATH)
        return compacted


def archive_entry(entry):
    with ARCHIVE_LOCK:
        clean_entry = sanitize_archive_entry(entry)
        if not clean_entry:
            return None, save_archive_entries(load_archive_entries())

        entries = [
            existing for existing in load_archive_entries()
            if existing.get("token") != clean_entry["token"]
        ]
        entries.append(clean_entry)
        return clean_entry, save_archive_entries(entries)


def update_archive(body):
    global ACTIVE_ARCHIVE_TOKENS
    with ARCHIVE_LOCK:
        entries = load_archive_entries()
        active_tokens = body.get("activeTokens")
        if active_tokens is not None:
            if not isinstance(active_tokens, list) or any(not isinstance(token, str) or not token for token in active_tokens):
                raise ValueError("invalid-active-tokens")
        action = body.get("action", "put")
        if action == "delete":
            token = body.get("token")
            if not isinstance(token, str) or not token:
                raise ValueError("invalid-token")
            ACTIVE_ARCHIVE_TOKENS = set(ACTIVE_ARCHIVE_TOKENS or []) - {token}
            entries = save_archive_entries([entry for entry in entries if entry["token"] != token])
            return {"ok": True, "count": len(entries)}
        if action == "reconcile":
            if active_tokens is None:
                raise ValueError("missing-active-tokens")
            recovered = body.get("entries", [])
            if not isinstance(recovered, list) or any(not sanitize_archive_entry(entry) for entry in recovered):
                raise ValueError("invalid-archive-entry")
            recovered_by_token = {entry["token"]: entry for entry in recovered if entry["token"] in active_tokens}
            entries = [entry for entry in entries if entry["token"] not in recovered_by_token]
            entries.extend(recovered_by_token.values())
            ACTIVE_ARCHIVE_TOKENS = set(active_tokens)
            entries = save_archive_entries(entries)
            return {"ok": True, "count": len(entries)}
        if action != "put" or not sanitize_archive_entry(body.get("entry")):
            raise ValueError("invalid-archive-entry")
        if active_tokens is not None:
            ACTIVE_ARCHIVE_TOKENS = set(active_tokens)
        entry, entries = archive_entry(body["entry"])
        return {"ok": True, "entry": entry, "count": len(entries)}


def find_archived_entry(token):
    with ARCHIVE_LOCK:
        entries = compact_archive_entries(load_archive_entries())
        for entry in entries:
            if entry.get("token") == token:
                return entry, entries
        return None, entries


class SleeperHTTPServer(ThreadingHTTPServer):
    request_queue_size = 128
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def has_valid_host(self):
        host = str(self.headers.get("Host") or "").strip().lower()
        return host in (f"127.0.0.1:{PORT}", f"localhost:{PORT}")

    def request_origin(self):
        return str(self.headers.get("Origin") or "").strip()

    def is_extension_origin(self, origin=None):
        candidate = self.request_origin() if origin is None else str(origin or "").strip()
        return bool(normalize_extension_origin(candidate))

    def is_authorized_request(self):
        supplied_token = str(self.headers.get(MUTATION_HEADER) or "")
        if not MUTATION_TOKEN or not hmac.compare_digest(supplied_token, MUTATION_TOKEN):
            return False
        origin = self.request_origin()
        if origin:
            return pair_extension_origin(origin)
        return hmac.compare_digest(str(self.headers.get(NATIVE_HEADER) or ""), "1")

    def send_cors_headers(self):
        origin = self.request_origin()
        if self.is_extension_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("invalid-content-length") from error
        if length < 0 or length > 256 * 1024:
            raise ValueError("request-too-large")
        raw_body = self.rfile.read(length)
        body = json.loads(raw_body.decode("utf-8") or "{}")
        if not isinstance(body, dict):
            raise ValueError("invalid-json-object")
        return body

    def do_GET(self):
        if not self.has_valid_host():
            self.send_json(421, {"ok": False, "reason": "invalid-host"})
            return
        path = urlparse(self.path).path
        if path == "/health":
            self.send_text(200, "ok\n", "text/plain; charset=utf-8")
            return
        if path in ("/memory", "/power", "/active-tab", "/settings", "/cleanup-request") and not self.is_authorized_request():
            self.send_json(403, {"ok": False, "reason": "unauthorized-request"})
            return
        if path == "/memory":
            self.send_json(200, collect_memory_status())
            return
        if path == "/power":
            self.send_json(200, collect_power_status())
            return
        if path == "/active-tab":
            self.send_json(200, collect_active_safari_tab())
            return
        if path == "/extension-state":
            self.send_json(200, collect_extension_state())
            return
        if path == "/settings":
            self.send_json(200, {"ok": True, "ready": settings_ready(), **read_companion_settings()})
            return
        if path == "/cleanup-request":
            self.send_json(200, read_cleanup_request())
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
            self.send_cors_headers()
            self.end_headers()
            return
        self.send_text(404, "not found\n", "text/plain; charset=utf-8")

    def do_POST(self):
        if not self.has_valid_host():
            self.send_json(421, {"ok": False, "reason": "invalid-host"})
            return
        if not self.is_authorized_request():
            self.send_json(403, {"ok": False, "reason": "unauthorized-mutation"})
            return

        path = urlparse(self.path).path
        try:
            body = self.read_json_body()
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json(400, {"ok": False, "reason": "invalid-json"})
            return
        except ValueError as error:
            reason = str(error) or "invalid-request"
            status = 413 if reason == "request-too-large" else 400
            self.send_json(status, {"ok": False, "reason": reason})
            return

        if path == "/settings":
            try:
                self.send_json(200, save_companion_settings(body))
            except ValueError as error:
                self.send_json(400, {"ok": False, "reason": str(error) or "invalid-settings-schema"})
            except Exception:
                self.send_json(500, {"ok": False, "reason": "settings-write-failed"})
            return

        if path == "/sleep-current":
            self.send_json(409, {"ok": False, "reason": "extension-required"})
            return

        if path == "/heartbeat":
            self.send_json(200, mark_extension_heartbeat(body))
            return

        if path == "/cleanup-request":
            try:
                self.send_json(200, queue_cleanup_request(body))
            except (TypeError, ValueError, OverflowError):
                self.send_json(400, {"ok": False, "reason": "invalid-cleanup-request"})
            return

        if path != "/archive-entry":
            self.send_text(404, "not found\n", "text/plain; charset=utf-8")
            return

        try:
            self.send_json(200, update_archive(body))
        except (TypeError, ValueError, OverflowError):
            self.send_json(400, {"ok": False, "reason": "invalid-archive-entry"})
        except Exception:
            self.send_json(500, {"ok": False, "reason": "archive-write-failed"})

    def do_OPTIONS(self):
        if not self.has_valid_host():
            self.send_response(421)
            self.end_headers()
            return
        if not self.is_extension_origin():
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(204)
        self.send_cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", f"content-type, {MUTATION_HEADER.lower()}, {NATIVE_HEADER.lower()}")
        self.end_headers()

    def send_text(self, status, body, content_type):
        encoded = body.encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            return False
        return True

    def send_json(self, status, body):
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            return False
        return True

    def log_message(self, format, *args):
        return


if __name__ == "__main__":
    lock_path = f"/tmp/safari-tab-sleeper-{os.getuid()}-{PORT}.lock"
    server_lock = open(lock_path, "w", encoding="utf-8")
    try:
        fcntl.flock(server_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit(0)
    save_archive_entries(load_archive_entries())
    server = SleeperHTTPServer((HOST, PORT), Handler)
    print(f"Safari Tab Sleeper server listening on http://{HOST}:{PORT}/sleep", flush=True)
    server.serve_forever()
