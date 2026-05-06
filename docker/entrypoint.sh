#!/usr/bin/env bash
set -euo pipefail

AVD_NAME="${DEFAULT_AVD_NAME:-pixel3_api33_1}"
AVD_PACKAGE="${DEFAULT_AVD_PACKAGE:-system-images;android-33;google_apis;x86_64}"

mkdir -p /root/.android/avd
touch /root/.android/repositories.cfg || true

if command -v avdmanager >/dev/null 2>&1; then
  if [ ! -f "/root/.android/avd/${AVD_NAME}.ini" ]; then
    echo "[entrypoint] AVD '${AVD_NAME}' missing; creating..."
    echo "no" | avdmanager create avd -n "${AVD_NAME}" -k "${AVD_PACKAGE}" --force >/dev/null

    # Apply optional template only at creation time (avoid modifying live AVD files).
    if [ -f "/opt/avd-config-template.ini" ]; then
      cp /opt/avd-config-template.ini "/root/.android/avd/${AVD_NAME}.avd/config.ini"
    fi
  fi
fi

exec "$@"
