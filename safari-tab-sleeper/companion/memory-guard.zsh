#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
THRESHOLD_GB="3"
ALERT_THRESHOLD_GB="5"
INTERVAL_SECONDS="60"
COOLDOWN_SECONDS="600"
CLEANUP_COOLDOWN_SECONDS="300"
SAMPLE_FILE=""
SWAP_SAMPLE_FILE=""
ONCE="0"
DRY_RUN="0"
AUTO_SLEEP_PRESSURE_DOMAINS="1"
PAUSE_FILE="$SCRIPT_DIR/pause-until"
SETTINGS_READY_FILE="$SCRIPT_DIR/settings-ready"
SLEEP_SERVER_URL="${SAFARI_TAB_SLEEPER_SLEEP_URL:-http://127.0.0.1:17654/sleep}"
SLEEP_SERVER_HEALTH_URL="${SAFARI_TAB_SLEEPER_HEALTH_URL:-${SLEEP_SERVER_URL%/sleep}/health}"
SLEEP_SERVER_SCRIPT="$SCRIPT_DIR/sleeper-server.py"
SLEEP_SERVER_LOG="$HOME/Library/Logs/safari-tab-sleeper-server.log"
SLEEP_SERVER_ERROR_LOG="$HOME/Library/Logs/safari-tab-sleeper-server.err.log"
PYTHON_BIN="${SAFARI_TAB_SLEEPER_PYTHON:-/usr/bin/python3}"

usage() {
  cat <<'EOF'
Usage: memory-guard.zsh [options]

Options:
  --threshold-gb N   Порог тихой автоочистки Safari/WebKit в ГБ. По умолчанию: 3
  --alert-threshold-gb N
                     Порог пользовательских окон/уведомлений в ГБ. По умолчанию: 5
  --interval N       Интервал проверки в секундах. По умолчанию: 60
  --cooldown N       Минимальная пауза между диалогами. По умолчанию: 600
  --cleanup-cooldown N
                     Минимальная пауза между автоочистками. По умолчанию: 300
  --sample FILE      Читать sample ps вместо живого списка процессов.
  --swap-sample FILE Читать sample sysctl vm.swapusage вместо живого swap.
  --no-auto-pressure Не усыплять тяжёлые фоновые вкладки автоматически.
  --no-auto-youtube  Старый алиас для --no-auto-pressure.
  --once             Выполнить одну проверку и выйти.
  --dry-run          Напечатать значения и не показывать диалоги.
  -h, --help         Показать справку.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --threshold-gb)
      THRESHOLD_GB="$2"
      shift 2
      ;;
    --alert-threshold-gb)
      ALERT_THRESHOLD_GB="$2"
      shift 2
      ;;
    --interval)
      INTERVAL_SECONDS="$2"
      shift 2
      ;;
    --cooldown)
      COOLDOWN_SECONDS="$2"
      shift 2
      ;;
    --cleanup-cooldown)
      CLEANUP_COOLDOWN_SECONDS="$2"
      shift 2
      ;;
    --sample)
      SAMPLE_FILE="$2"
      shift 2
      ;;
    --swap-sample)
      SWAP_SAMPLE_FILE="$2"
      shift 2
      ;;
    --no-auto-pressure|--no-auto-youtube)
      AUTO_SLEEP_PRESSURE_DOMAINS="0"
      shift
      ;;
    --once)
      ONCE="1"
      shift
      ;;
    --dry-run)
      DRY_RUN="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Неизвестная опция: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

collect_processes() {
  if [[ -n "$SAMPLE_FILE" ]]; then
    cat "$SAMPLE_FILE"
  else
    ps -axo pid=,rss=,command=
  fi
}

collect_swap() {
  if [[ -n "$SWAP_SAMPLE_FILE" ]]; then
    cat "$SWAP_SAMPLE_FILE"
  else
    sysctl vm.swapusage 2>/dev/null || true
  fi
}

measure_swap_mb() {
  local raw value unit
  raw="$(collect_swap | sed -nE 's/.*used = ([0-9.]+)([KMG]).*/\1 \2/p' | head -n 1)"
  if [[ -z "$raw" ]]; then
    print "0"
    return
  fi

  value="${raw%% *}"
  unit="${raw##* }"
  awk -v value="$value" -v unit="$unit" 'BEGIN {
    if (unit == "G") printf "%.0f", value * 1024
    else if (unit == "K") printf "%.0f", value / 1024
    else printf "%.0f", value
  }'
}

measure_memory() {
  local threshold_kb
  local alert_threshold_kb
  local swap_used_mb
  threshold_kb=$(awk -v gb="$THRESHOLD_GB" 'BEGIN { printf "%.0f", gb * 1024 * 1024 }')
  alert_threshold_kb=$(awk -v gb="$ALERT_THRESHOLD_GB" 'BEGIN { printf "%.0f", gb * 1024 * 1024 }')
  swap_used_mb="$(measure_swap_mb)"

  collect_processes | awk -v threshold_kb="$threshold_kb" -v alert_threshold_kb="$alert_threshold_kb" -v swap_used_mb="$swap_used_mb" '
    {
      pid=$1
      rss=$2
      if (rss !~ /^[0-9]+$/) next
      command=""
      for (i=3; i<=NF; i++) {
        command = command (i == 3 ? "" : " ") $i
      }
      if (command !~ /\/Safari\.app\/|\/Safari Technology Preview\.app\/|com\.apple\.Safari|\/WebKit\.framework\/|com\.apple\.WebKit/) next
      total += rss
      if (rss > max) {
        max = rss
        top_pid = pid
        top_command = command
      }
    }
    END {
      total_mb = int(total / 1024 + 0.5)
      max_mb = int(max / 1024 + 0.5)
      over = (total >= threshold_kb || max >= threshold_kb) ? 1 : 0
      over_alert = (total >= alert_threshold_kb || max >= alert_threshold_kb) ? 1 : 0
      printf "total_mb=%d max_mb=%d swap_used_mb=%d over_threshold=%d over_alert=%d top_pid=%s top_command=%s\n", total_mb, max_mb, swap_used_mb, over, over_alert, top_pid, top_command
    }
  '
}

field_from_line() {
  local line="$1"
  local field="$2"
  print -- "$line" | sed -n "s/.*$field=\\([0-9]*\\).*/\\1/p"
}

pause_remaining_seconds() {
  if [[ ! -f "$PAUSE_FILE" ]]; then
    print "0"
    return
  fi

  local pause_until now
  pause_until="$(cat "$PAUSE_FILE" 2>/dev/null || print "0")"
  now="$(date +%s)"
  if [[ "$pause_until" == <-> && "$pause_until" -gt "$now" ]]; then
    print "$(( pause_until - now ))"
    return
  fi

  rm -f "$PAUSE_FILE" 2>/dev/null || true
  print "0"
}

settings_are_synced() {
  [[ -f "$SETTINGS_READY_FILE" ]]
}

sleep_server_is_healthy() {
  /usr/bin/curl --silent --fail --max-time 1 "$SLEEP_SERVER_HEALTH_URL" >/dev/null 2>&1
}

ensure_sleep_server() {
  if sleep_server_is_healthy; then
    return 0
  fi

  if [[ ! -x "$PYTHON_BIN" || ! -f "$SLEEP_SERVER_SCRIPT" ]]; then
    print "Safari Tab Sleeper: не найден Python или sleeper-server.py" >&2
    return 1
  fi

  "$PYTHON_BIN" "$SLEEP_SERVER_SCRIPT" </dev/null >>"$SLEEP_SERVER_LOG" 2>>"$SLEEP_SERVER_ERROR_LOG" &!

  local attempt
  for attempt in {1..20}; do
    sleep 0.1
    if sleep_server_is_healthy; then
      return 0
    fi
  done

  print "Safari Tab Sleeper: сервер не запустился на $SLEEP_SERVER_HEALTH_URL" >&2
  return 1
}

sleep_with_server_watchdog() {
  local remaining="$1"
  local step

  while (( remaining > 0 )); do
    step=5
    if (( remaining < step )); then
      step="$remaining"
    fi

    sleep "$step"
    remaining=$(( remaining - step ))

    if [[ "$DRY_RUN" != "1" ]]; then
      ensure_sleep_server || true
    fi
  done
}

show_memory_alert_notification() {
  local total_mb="$1"
  local max_mb="$2"
  local swap_used_mb="$3"
  local top_command="$4"

  osascript <<APPLESCRIPT >/dev/null 2>&1 || true
set totalText to "$total_mb"
set maxText to "$max_mb"
set swapText to "$swap_used_mb"
set processText to "$top_command"
set messageText to "Safari/WebKit: " & totalText & " MB. Пик процесса: " & maxText & " MB. Swap: " & swapText & " MB. Открой расширение и нажми «Освободить память сейчас»."
display notification messageText with title "Safari Tab Sleeper"
APPLESCRIPT
}

show_cleanup_summary() {
  local slept_count="$1"
  local before_total_mb="$2"
  local after_total_mb="$3"
  local before_swap_mb="$4"
  local after_swap_mb="$5"

  osascript <<APPLESCRIPT >/dev/null 2>&1 || true
set sleptText to "$slept_count"
set beforeTotalText to "$before_total_mb"
set afterTotalText to "$after_total_mb"
set beforeSwapText to "$before_swap_mb"
set afterSwapText to "$after_swap_mb"
set messageText to "Усыплено тяжёлых фоновых вкладок: " & sleptText & ". Safari/WebKit RSS: " & beforeTotalText & " MB -> " & afterTotalText & " MB. Swap: " & beforeSwapText & " MB -> " & afterSwapText & " MB."
display notification messageText with title "Safari Tab Sleeper"
APPLESCRIPT
}

sleep_inactive_pressure_tabs() {
  if ! settings_are_synced; then
    print "slept_count=0 settings_pending=1"
    return 0
  fi

  osascript "$SCRIPT_DIR/sleep-inactive-youtube-tabs.applescript" "$SLEEP_SERVER_URL" "$SCRIPT_DIR/allowlist.txt" 2>/dev/null || true
}

LAST_ALERT_AT="0"
LAST_CLEANUP_AT="0"

while true; do
  if [[ "$DRY_RUN" != "1" ]]; then
    ensure_sleep_server || true
  fi

  line="$(measure_memory)"

  if [[ "$DRY_RUN" == "1" ]]; then
    print -- "$line"
  fi

  over_threshold="$(field_from_line "$line" "over_threshold")"
  over_alert="$(field_from_line "$line" "over_alert")"
  total_mb="$(field_from_line "$line" "total_mb")"
  max_mb="$(field_from_line "$line" "max_mb")"
  swap_used_mb="$(field_from_line "$line" "swap_used_mb")"
  top_command="$(print -- "$line" | sed -n 's/.*top_command=//p')"

  now="$(date +%s)"
  pause_remaining="$(pause_remaining_seconds)"
  if [[ "$DRY_RUN" != "1" && "$pause_remaining" -gt 0 ]]; then
    if [[ "$ONCE" == "1" ]]; then
      exit 0
    fi
    sleep_with_server_watchdog "$INTERVAL_SECONDS"
    continue
  fi

  if [[ "$DRY_RUN" != "1" && "$over_threshold" == "1" ]]; then
    pressure_result=""
    if [[ "$AUTO_SLEEP_PRESSURE_DOMAINS" == "1" && $(( now - LAST_CLEANUP_AT )) -ge "$CLEANUP_COOLDOWN_SECONDS" ]]; then
      LAST_CLEANUP_AT="$now"
      pressure_result="$(sleep_inactive_pressure_tabs)"
      slept_count="$(field_from_line "$pressure_result" "slept_count")"
      slept_count="${slept_count:-0}"
      if [[ "$slept_count" == "0" ]]; then
        :
      else
        print -- "$(date '+%Y-%m-%d %H:%M:%S') pressure cleanup: $pressure_result"
        sleep 2
        after_line="$(measure_memory)"
        after_total_mb="$(field_from_line "$after_line" "total_mb")"
        after_swap_used_mb="$(field_from_line "$after_line" "swap_used_mb")"
        if [[ "$over_alert" == "1" && $(( now - LAST_ALERT_AT )) -ge "$COOLDOWN_SECONDS" ]]; then
          show_cleanup_summary "$slept_count" "$total_mb" "${after_total_mb:-$total_mb}" "$swap_used_mb" "${after_swap_used_mb:-$swap_used_mb}"
          LAST_ALERT_AT="$now"
        fi
        if [[ "$ONCE" == "1" ]]; then
          exit 0
        fi
        sleep_with_server_watchdog "$INTERVAL_SECONDS"
        continue
      fi
    fi

    if [[ "$over_alert" == "1" && $(( now - LAST_ALERT_AT )) -ge "$COOLDOWN_SECONDS" ]]; then
      show_memory_alert_notification "$total_mb" "$max_mb" "$swap_used_mb" "$top_command"
      LAST_ALERT_AT="$now"
    fi
  fi

  if [[ "$ONCE" == "1" ]]; then
    exit 0
  fi

  sleep_with_server_watchdog "$INTERVAL_SECONDS"
done
