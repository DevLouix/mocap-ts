#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-dev}"

case "$TARGET" in
  dev|prod) exec bash "$ROOT_DIR/scripts/platform.sh" "$TARGET" stop ;;
  -h|--help)
    printf 'Usage: bash scripts/stop.sh <dev|prod>\n'
    exit 0
    ;;
  *)
    printf 'Usage: bash scripts/stop.sh <dev|prod>\n' >&2
    exit 2
    ;;
esac
