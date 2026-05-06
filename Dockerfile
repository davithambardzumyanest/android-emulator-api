FROM node:20-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

# --- Android SDK / Emulator toolchain (optional but installed by default) ---
# This image includes adb/emulator/sdkmanager so the API can start emulators
# from inside the container. At runtime, you'll still need /dev/kvm passthrough
# (see docker-compose.yml) for hardware acceleration.

ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH="${PATH}:/opt/android-sdk/platform-tools:/opt/android-sdk/emulator:/opt/android-sdk/cmdline-tools/latest/bin"

# Dependencies required by Android emulator + sdkmanager + basic networking
RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-17-jre-headless \
    wget unzip ca-certificates \
    libstdc++6 libc6 libgcc-s1 \
    libpulse0 libnss3 \
    libxkbfile1 \
    libxkbcommon0 libxkbcommon-x11-0 \
    libxcb-cursor0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 libxcb-render-util0 libxcb-shape0 libxcb-xinerama0 libxcb-xkb1 \
    libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxi6 libxrandr2 libxrender1 libxtst6 \
    libgl1 libglu1-mesa \
  && rm -rf /var/lib/apt/lists/*

# Install Android commandline-tools (sdkmanager/avdmanager)
RUN mkdir -p /opt/android-sdk/cmdline-tools \
  && wget -qO /tmp/cmdline-tools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
  && unzip -q /tmp/cmdline-tools.zip -d /opt/android-sdk/cmdline-tools \
  && mv /opt/android-sdk/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest \
  && rm -f /tmp/cmdline-tools.zip

# Prepare Android home so sdkmanager/avdmanager don't fail
RUN mkdir -p /root/.android /root/.android/avd \
  && touch /root/.android/repositories.cfg

# Install required SDK packages (platform-tools=adb, emulator, and a system image)
# You can adjust API level / image flavor if needed.
RUN yes | sdkmanager --licenses >/dev/null \
  && sdkmanager --install \
    "platform-tools" \
    "emulator" \
    "platforms;android-33" \
    "system-images;android-33;google_apis;x86_64"

# Ensure volumes don't hide AVDs: create at container start if missing
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Keep AVD config template outside live AVD directories.
COPY avds/config.ini /opt/avd-config-template.ini

# Install dependencies first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application source
COPY index.js ./index.js
COPY src ./src

# Runtime state (wipe-once flag, etc.)
RUN mkdir -p /app/.state

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "index.js"]
