// Central place for the knobs that decide how much CPU/RAM each emulator costs.
// Everything is env-overridable so a host can be tuned without a code change.

function envInt(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envBool(name, fallback) {
    const raw = String(process.env[name] ?? '').trim().toLowerCase();
    if (raw === '') return fallback;
    return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

function envStr(name, fallback) {
    const raw = String(process.env[name] ?? '').trim();
    return raw === '' ? fallback : raw;
}

const emulatorConfig = {
    envInt,
    envBool,
    envStr,

    // Software rendering is what actually burns host CPU on a headless box.
    // 'auto' probes for a GPU, fails, and falls back anyway - ask for the
    // software path directly so we skip the probe and the window pipeline.
    get gpu() {
        return envStr('EMULATOR_GPU', 'swiftshader_indirect');
    },

    // A server has no display; a visible window only adds compositing work.
    get headless() {
        return envBool('EMULATOR_HEADLESS', true);
    },

    // 0 / unset means "inherit the AVD's own config.ini". Set this only to force
    // a specific size; a hardcoded value can just as easily inflate usage as cut it.
    get memoryMb() {
        return envInt('EMULATOR_MEMORY_MB', 0);
    },

    get cores() {
        return envInt('EMULATOR_CORES', 0);
    },

    // Ceilings applied to whatever the AVD asks for. An AVD left at the wizard
    // default (8192MB) would otherwise dwarf the host on its own.
    get maxMemoryMb() {
        return envInt('EMULATOR_MAX_MEMORY_MB', 2048);
    },

    get maxCores() {
        return envInt('EMULATOR_MAX_CORES', 2);
    },

    // Optional "WIDTHxHEIGHT" override. Fewer pixels is less software rasterising
    // per frame and smaller screencap payloads.
    get resolution() {
        const raw = envStr('EMULATOR_RESOLUTION', '');
        return /^\d+x\d+$/.test(raw) ? raw : null;
    },

    // -read-only already gives every boot a throwaway data overlay, so a blanket
    // -wipe-data just forces a redundant first-boot (dexopt, package scan).
    get readOnly() {
        return envBool('EMULATOR_READ_ONLY', true);
    },

    get wipeData() {
        return envBool('EMULATOR_WIPE_DATA', false);
    },

    get coldBoot() {
        return envBool('EMULATOR_COLD_BOOT', true);
    },

    get dns() {
        return envStr('EMULATOR_DNS', '8.8.8.8,1.1.1.1');
    },

    // Hard ceiling on concurrent emulators. Overshooting pushes the host into
    // swap, which costs far more CPU than the extra device is worth.
    get maxDevices() {
        return envInt('MAX_EMULATORS', 4);
    },

    // Reserve for the host itself before admitting another emulator.
    get reservedHostMb() {
        return envInt('HOST_RESERVED_MB', 1536);
    },

    // Assumed footprint of one emulator when checking free memory.
    get assumedDeviceMb() {
        return envInt('EMULATOR_ASSUMED_MB', 1800);
    },

    // uiautomator dump is one of the most expensive things you can ask a device
    // to do. Running it before every single adb call is not affordable.
    get autoDismissDialogs() {
        return envBool('ADB_AUTO_DISMISS_DIALOGS', false);
    },

    get tuneAfterBoot() {
        return envBool('EMULATOR_TUNE_AFTER_BOOT', true);
    },

    get bootTimeoutMs() {
        return envInt('EMULATOR_BOOT_TIMEOUT_MS', 300000);
    },

    // Floor for the MJPEG stream interval; each frame is a full guest-side
    // PNG encode, so a 200ms floor just queues work that never drains.
    get minStreamIntervalMs() {
        return envInt('STREAM_MIN_INTERVAL_MS', 500);
    },
};

module.exports = emulatorConfig;
