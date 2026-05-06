#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./restart_docker.sh           # restart default service(s)
#   ./restart_docker.sh dev       # restart with dev profile

MODE="${1:-prod}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed or not in PATH"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose is not available"
  exit 1
fi

echo "Stopping containers..."
docker compose down

echo "Starting containers..."
if [[ "$MODE" == "dev" ]]; then
  docker compose --profile dev up --build
else
  docker compose up --build
fi
