#!/usr/bin/env bash
set -Eeuo pipefail

LOG_FILE="/var/log/android-emulator-api-install.log"
mkdir -p "$(dirname "$LOG_FILE")"

exec > >(tee -a "$LOG_FILE") 2>&1

echo "[$(date -Is)] Starting android-emulator-api server install"

if [[ "${EUID}" -ne 0 ]]; then
  echo "[$(date -Is)] ERROR: Please run as root (sudo)."
  exit 1
fi

APP_DIR="/var/www/android-emulator-api"
ANDROID_SDK_ROOT="/opt/android-sdk"
ANDROID_HOME="$ANDROID_SDK_ROOT"

NODE_MAJOR="20"
PM2_APP_NAME="android-emulator-api"

AVD_NAME_DEFAULT="pixel3_api33_1"
AVD_DEVICE_DEFAULT="pixel_3"
AVD_API_DEFAULT="33"
AVD_ABI_DEFAULT="google_apis;x86_64"

EMULATOR_PORT_DEFAULT="5554"

export DEBIAN_FRONTEND=noninteractive

echo "[$(date -Is)] Updating apt..."
apt-get update -y

echo "[$(date -Is)] Installing base packages..."
apt-get install -y --no-install-recommends \
  ca-certificates curl wget unzip zip git jq \
  build-essential \
  openjdk-17-jre-headless \
  libstdc++6 libc6 \
  libpulse0 \
  libnss3 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
  libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 \
  mesa-vulkan-drivers \
  qemu-kvm \
  socat \
  && true

echo "[$(date -Is)] Ensuring KVM is available..."
if [[ -e /dev/kvm ]]; then
  echo "[$(date -Is)] /dev/kvm exists"
else
  echo "[$(date -Is)] WARNING: /dev/kvm not found. Emulator will be slow/unstable without virtualization."
fi

if getent group kvm >/dev/null 2>&1; then
  echo "[$(date -Is)] kvm group exists"
else
  echo "[$(date -Is)] WARNING: kvm group not found"
fi

echo "[$(date -Is)] Installing Node.js ${NODE_MAJOR}.x..."
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q "^v${NODE_MAJOR}"; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
else
  echo "[$(date -Is)] Node already installed: $(node -v)"
fi

echo "[$(date -Is)] Installing PM2..."
npm install -g pm2

mkdir -p "$ANDROID_SDK_ROOT"

if [[ ! -d "$ANDROID_SDK_ROOT/cmdline-tools" ]]; then
  echo "[$(date -Is)] Installing Android SDK command line tools..."
  TMP_DIR="$(mktemp -d)"
  pushd "$TMP_DIR" >/dev/null
  wget -q -O cmdline-tools.zip "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
  unzip -q cmdline-tools.zip
  mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools"
  rm -rf "$ANDROID_SDK_ROOT/cmdline-tools/latest" || true
  mv cmdline-tools "$ANDROID_SDK_ROOT/cmdline-tools/latest"
  popd >/dev/null
  rm -rf "$TMP_DIR"
else
  echo "[$(date -Is)] Android SDK cmdline-tools already present"
fi

export ANDROID_SDK_ROOT ANDROID_HOME
export PATH="$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator:$PATH"

echo "[$(date -Is)] Accepting Android SDK licenses..."
yes | sdkmanager --licenses || true

echo "[$(date -Is)] Installing Android SDK packages..."
sdkmanager \
  "platform-tools" \
  "emulator" \
  "platforms;android-${AVD_API_DEFAULT}" \
  "system-images;android-${AVD_API_DEFAULT};${AVD_ABI_DEFAULT}" \
  "tools" \
  "build-tools;${AVD_API_DEFAULT}.0.0" \
  || true

echo "[$(date -Is)] Verifying emulator and adb..."
which adb || true
adb version || true
which emulator || true
emulator -version || true

# Ensure a non-root user to run emulator and the API
API_USER="androidapi"
if ! id "$API_USER" >/dev/null 2>&1; then
  echo "[$(date -Is)] Creating user ${API_USER}..."
  useradd -m -s /bin/bash "$API_USER"
fi

# Add user to kvm group if present
if getent group kvm >/dev/null 2>&1; then
  usermod -aG kvm "$API_USER" || true
fi

# Create AVD if missing
echo "[$(date -Is)] Ensuring AVD exists (${AVD_NAME_DEFAULT})..."
AVD_LIST="$(sudo -u "$API_USER" bash -lc "export ANDROID_SDK_ROOT='$ANDROID_SDK_ROOT'; export ANDROID_HOME='$ANDROID_HOME'; export PATH='$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator:\$PATH'; avdmanager list avd 2>/dev/null || true")"

if echo "$AVD_LIST" | grep -q "Name: ${AVD_NAME_DEFAULT}"; then
  echo "[$(date -Is)] AVD already exists"
else
  echo "[$(date -Is)] Creating AVD ${AVD_NAME_DEFAULT}..."
  sudo -u "$API_USER" bash -lc "\
    set -e; \
    export ANDROID_SDK_ROOT='$ANDROID_SDK_ROOT'; \
    export ANDROID_HOME='$ANDROID_HOME'; \
    export PATH='$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator:\$PATH'; \
    yes 'no' | avdmanager create avd -n '${AVD_NAME_DEFAULT}' -k 'system-images;android-${AVD_API_DEFAULT};${AVD_ABI_DEFAULT}' -d '${AVD_DEVICE_DEFAULT}' --force"
fi

# App installation
if [[ ! -d "$APP_DIR" ]]; then
  echo "[$(date -Is)] ERROR: App directory not found at $APP_DIR"
  echo "[$(date -Is)] You can either git clone it there, or edit APP_DIR in this script."
  exit 1
fi

echo "[$(date -Is)] Installing app dependencies..."
cd "$APP_DIR"
sudo -u "$API_USER" bash -lc "cd '$APP_DIR' && npm ci"

# Write systemd env file for persistent PATH/SDK vars (optional)
ENV_FILE="/etc/android-emulator-api.env"
echo "[$(date -Is)] Writing env file to $ENV_FILE"
cat > "$ENV_FILE" <<EOF
ANDROID_SDK_ROOT=$ANDROID_SDK_ROOT
ANDROID_HOME=$ANDROID_HOME
PATH=$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
PM2_APP_NAME=$PM2_APP_NAME
EMULATOR_HEADLESS=true
EOF

# Start with PM2
echo "[$(date -Is)] Starting app with PM2 as user ${API_USER}..."
# Use bash -lc so PATH from env file is used
sudo -u "$API_USER" bash -lc "\
  export \$(cat '$ENV_FILE' | xargs); \
  cd '$APP_DIR'; \
  pm2 delete '$PM2_APP_NAME' >/dev/null 2>&1 || true; \
  pm2 start index.js --name '$PM2_APP_NAME'; \
  pm2 save"

echo "[$(date -Is)] Enabling PM2 startup..."
# This installs the startup script for the user
sudo -u "$API_USER" bash -lc "pm2 startup systemd -u '$API_USER' --hp '/home/$API_USER'" || true
systemctl enable "pm2-${API_USER}" || true
systemctl start "pm2-${API_USER}" || true

echo "[$(date -Is)] Install complete. Logs: $LOG_FILE"
echo "[$(date -Is)] PM2 status (as $API_USER):"
sudo -u "$API_USER" bash -lc "pm2 status" || true
