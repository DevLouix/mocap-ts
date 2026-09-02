#!/usr/bin/env bash
set -Eeuo pipefail

# Platform lifecycle helper for mocap-ts.
#
# Usage:
#   bash scripts/platform.sh dev start
#   bash scripts/platform.sh dev stop
#   bash scripts/platform.sh prod start
#   bash scripts/platform.sh prod logs
#
# Development runs Next.js and its in-process file-backed worker. Production
# runs the durable Docker Compose stack. Production stop never removes named
# volumes; use Docker directly when intentionally destroying data.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${MOCAP_PLATFORM_RUNTIME_DIR:-${ROOT_DIR}/.mocap/platform}"
DEV_PID_FILE="${RUNTIME_DIR}/dev.pid"
DEV_LOG_FILE="${RUNTIME_DIR}/dev.log"
DEV_PORT="${MOCAP_DEV_PORT:-3000}"

usage() {
  cat <<'EOF'
Usage: bash scripts/platform.sh <dev|prod> <start|stop|restart|status|logs>

Targets:
  dev    Local Next.js development server with the file-backed worker
  prod   Durable Docker Compose stack (PostgreSQL, Redis, MinIO, web, worker)

Examples:
  pnpm platform dev start
  pnpm platform dev stop
  pnpm platform prod start
  pnpm platform prod logs
EOF
}

fail() {
  printf 'platform: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

compose() {
  docker compose -f "${ROOT_DIR}/docker-compose.yml" "$@"
}

ensure_runtime_dir() {
  mkdir -p "${RUNTIME_DIR}"
}

pid_is_running() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

read_dev_pid() {
  [[ -f "${DEV_PID_FILE}" ]] || return 1
  local pid
  pid="$(<"${DEV_PID_FILE}")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$pid"
}

start_dev() {
  require_command pnpm
  ensure_runtime_dir

  if local pid="$(read_dev_pid 2>/dev/null || true)"; [[ -n "$pid" ]] && pid_is_running "$pid"; then
    printf 'Development platform is already running (pid %s, http://localhost:%s).\n' "$pid" "$DEV_PORT"
    return 0
  fi

  rm -f "${DEV_PID_FILE}"
  printf 'Starting development platform on http://localhost:%s ...\n' "$DEV_PORT"
  (
    cd "${ROOT_DIR}"
    export NODE_ENV=development
    # Keep API uploads and the in-process worker on the same absolute root.
    export MOCAP_DATA_DIR="${MOCAP_DATA_DIR:-${ROOT_DIR}/.mocap}"
    export MOCAP_AUTH_MODE="${MOCAP_AUTH_MODE:-local}"
    export MOCAP_PERSISTENCE="${MOCAP_PERSISTENCE:-file}"
    export MOCAP_WORKER_MODE="${MOCAP_WORKER_MODE:-file}"
    export PORT="$DEV_PORT"
    exec pnpm --filter @mocap-ts/web dev
  ) >>"${DEV_LOG_FILE}" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" >"${DEV_PID_FILE}"
  printf 'Development platform started (pid %s). Logs: %s\n' "$pid" "${DEV_LOG_FILE}"
}

stop_dev() {
  local pid
  pid="$(read_dev_pid 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    printf 'Development platform is not running.\n'
    rm -f "${DEV_PID_FILE}"
    return 0
  fi

  if ! pid_is_running "$pid"; then
    printf 'Development platform is not running (stale pid file removed).\n'
    rm -f "${DEV_PID_FILE}"
    return 0
  fi

  printf 'Stopping development platform (pid %s) ...\n' "$pid"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in {1..20}; do
    pid_is_running "$pid" || break
    sleep 0.5
  done
  if pid_is_running "$pid"; then
    printf 'Development process did not exit after 10 seconds; send SIGINT manually if needed.\n' >&2
    return 1
  fi
  rm -f "${DEV_PID_FILE}"
  printf 'Development platform stopped.\n'
}

status_dev() {
  local pid
  pid="$(read_dev_pid 2>/dev/null || true)"
  if [[ -n "$pid" ]] && pid_is_running "$pid"; then
    printf 'Development platform: running (pid %s, http://localhost:%s)\n' "$pid" "$DEV_PORT"
  else
    printf 'Development platform: stopped\n'
    [[ -f "${DEV_PID_FILE}" ]] && rm -f "${DEV_PID_FILE}"
  fi
  return 0
}

logs_dev() {
  ensure_runtime_dir
  touch "${DEV_LOG_FILE}"
  tail -n 200 -f "${DEV_LOG_FILE}"
}

start_prod() {
  require_command docker
  printf 'Starting durable production platform ...\n'
  compose up -d --build
  printf 'Production platform started. Web: http://localhost:3000\n'
}

stop_prod() {
  require_command docker
  printf 'Stopping durable production platform (named volumes are preserved) ...\n'
  compose stop
  printf 'Production platform stopped.\n'
}

status_prod() {
  require_command docker
  compose ps
}

logs_prod() {
  require_command docker
  compose logs --tail=200 -f
}

run_target() {
  local target="$1"
  local action="$2"
  case "${target}:${action}" in
    dev:start) start_dev ;;
    dev:stop) stop_dev ;;
    dev:restart) stop_dev || true; start_dev ;;
    dev:status) status_dev ;;
    dev:logs) logs_dev ;;
    prod:start) start_prod ;;
    prod:stop) stop_prod ;;
    prod:restart) stop_prod; start_prod ;;
    prod:status) status_prod ;;
    prod:logs) logs_prod ;;
    *) usage; exit 2 ;;
  esac
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || "$#" -eq 0 ]]; then
  usage
  exit 0
fi

[[ "$#" -eq 2 ]] || { usage; exit 2; }
run_target "$1" "$2"
