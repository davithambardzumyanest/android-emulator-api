// Central configuration. Everything tunable lives here so behaviour is
// predictable and no SDK paths are hard-coded in service code.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function int(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

const home = process.env.HOME || os.homedir();

/**
 * Locate the Android SDK.
 * The previous code hard-coded '/root/Android/Sdk', which is wrong for any
 * host that does not run this API as root — including this one, where the SDK
 * lives at /usr/lib/android-sdk. Detection order: explicit env, the real path
 * behind the `emulator` binary on PATH, then the usual install locations.
 */
function detectSdkRoot() {
  if (process.env.ANDROID_SDK_ROOT) return process.env.ANDROID_SDK_ROOT;
  if (process.env.ANDROID_HOME) return process.env.ANDROID_HOME;

  // `emulator` lives in <sdk>/emulator, so its real path names the SDK.
  try {
    const resolved = fs.realpathSync(
      execFileSync('which', ['emulator'], { encoding: 'utf8' }).trim(),
    );
    const root = path.dirname(path.dirname(resolved));
    if (fs.existsSync(path.join(root, 'platform-tools'))) return root;
  } catch (_) { /* emulator not on PATH */ }

  const candidates = [
    path.join(home, 'Android', 'Sdk'),
    path.join(home, 'android-sdk'),
    '/usr/lib/android-sdk',
    '/opt/android-sdk',
    '/usr/local/lib/android/sdk',
  ];
  return candidates.find((dir) => fs.existsSync(dir)) || path.join(home, 'Android', 'Sdk');
}

const sdkRoot = detectSdkRoot();

const config = {
  port: int(process.env.PORT, 3000),
  logLevel: process.env.LOG_LEVEL || 'info',

  android: {
    sdkRoot,
    avdHome: process.env.ANDROID_AVD_HOME || path.join(home, '.android', 'avd'),
    // Extra directories appended to PATH for spawned SDK binaries.
    binPaths: [
      path.join(sdkRoot, 'emulator'),
      path.join(sdkRoot, 'platform-tools'),
      path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin'),
    ],
  },

  emulator: {
    headless: bool(process.env.EMULATOR_HEADLESS, false),
    gpu: process.env.EMULATOR_GPU || 'swiftshader_indirect',
    // Explicit RAM in MB. Unset => 4096, or the device profile's RAM when
    // EMULATOR_MEMORY_FROM_PROFILE is on. Always clamped to host memory.
    memoryMb: int(process.env.EMULATOR_MEMORY_MB, null),
    memoryFromProfile: bool(process.env.EMULATOR_MEMORY_FROM_PROFILE, false),
    cores: int(process.env.EMULATOR_CORES, 4),
    dns: process.env.EMULATOR_DNS || '',
    // Quick boot reuses the AVD snapshot: seconds instead of a cold boot.
    quickBoot: bool(process.env.EMULATOR_QUICK_BOOT, true),
    // Needed only to run several instances of the SAME AVD. It makes the AVD
    // files read-only, which also stops snapshots being saved — so leaving it
    // on permanently means quick boot can never take effect.
    readOnly: bool(process.env.EMULATOR_READ_ONLY, false),
    // Only wipe when explicitly asked (or when /cleanup armed the one-shot flag).
    wipeData: bool(process.env.EMULATOR_WIPE_DATA, false),
    bootTimeoutMs: int(process.env.EMULATOR_BOOT_TIMEOUT_MS, 300000),
    // Emulator console ports are even and live in this range.
    portRange: { min: 5554, max: 5680 },
    // 'lte' models a real mobile link; 'fast' is the unthrottled emulator default.
    netProfile: (process.env.EMULATOR_NET_PROFILE || 'lte').toLowerCase(),
    audio: bool(process.env.EMULATOR_AUDIO, false),
    // Also send a $GPRMC sentence with each fix. Off by default: emulator
    // 36.4.9.0 accepts `geo nmea` and answers OK but ignores it entirely
    // (verified - the position does not even move to the one in the sentence),
    // so it is a wasted adb round trip on every fix. Enable if your emulator
    // build honours NMEA.
    gpsNmea: bool(process.env.EMULATOR_GPS_NMEA, false),
    // Unset => let the AVD's config.ini decide (virtualscene back, emulated front).
    camera: process.env.EMULATOR_CAMERA || '',
  },

  device: {
    // Hardware profile applied to new/patched AVDs; see src/devices/profiles.js
    profile: process.env.DEVICE_PROFILE || 'pixel_5',
    // Unset by default. Forcing a timezone or locale that disagrees with the
    // coordinates you inject is worse than leaving the image's own: a device
    // reporting New York time while its GPS sits in Yerevan is both
    // unrealistic and confuses region-sensitive apps. Set these explicitly,
    // per device, to match where the device claims to be.
    locale: process.env.DEVICE_LOCALE || null,
    timezone: process.env.DEVICE_TIMEZONE || null,
    batteryLevel: int(process.env.DEVICE_BATTERY_LEVEL, 87),
    // The device must not fall asleep: a dark screen breaks every UI query.
    // 24h by default; lower it only if you want the device to sleep.
    screenOffTimeoutMs: int(process.env.DEVICE_SCREEN_OFF_TIMEOUT_MS, 86400000),
    // Realistic devices animate. Turn on only when you need raw automation speed.
    disableAnimations: bool(process.env.DEVICE_DISABLE_ANIMATIONS, false),
    // Rewrite AVD config.ini from the profile before each boot.
    applyProfileToAvd: bool(process.env.DEVICE_APPLY_PROFILE, true),
    // Boot with a writable /system so build.prop can be patched. Required for
    // real build-identity spoofing; see "Device realism" in the README.
    writableSystem: bool(process.env.DEVICE_WRITABLE_SYSTEM, false),
    // Use only the injected GPS fix for location. Android's fused provider
    // otherwise blends in network (Wi-Fi/cell/IP) location, which disagrees
    // with the injected position whenever the device is behind a proxy in a
    // different country — and apps then route from the wrong origin.
    gpsOnly: bool(process.env.DEVICE_GPS_ONLY, true),
    // Wi-Fi feeds the network location provider; a phone navigating in a car
    // is on mobile data anyway.
    wifi: bool(process.env.DEVICE_WIFI, false),
  },

  adb: {
    timeoutMs: int(process.env.ADB_TIMEOUT_MS, 30000),
    maxBuffer: int(process.env.ADB_MAX_BUFFER, 32 * 1024 * 1024),
    // UI dumps are expensive; reuse a fresh one across calls in this window.
    uiCacheMs: int(process.env.ADB_UI_CACHE_MS, 400),
  },

  security: {
    apiToken: process.env.API_TOKEN || '',
    corsOrigin: process.env.CORS_ORIGIN || '*',
    // /devices/:id/adb runs arbitrary adb subcommands; off by default.
    allowRawAdb: bool(process.env.ALLOW_RAW_ADB, false),
  },

  runtime: {
    // Stop emulators when the API exits. Off by default: emulators are spawned
    // detached, so a deploy or `pm2 restart` does not end live sessions and they
    // can be re-adopted by registering with `meta.deviceId`.
    cleanupOnExit: bool(process.env.CLEANUP_ON_EXIT, false),
  },
};

// PATH used for every spawned SDK binary.
config.android.env = {
  ...process.env,
  ANDROID_SDK_ROOT: sdkRoot,
  ANDROID_HOME: sdkRoot,
  PATH: [process.env.PATH, ...config.android.binPaths].filter(Boolean).join(':'),
};

module.exports = config;
