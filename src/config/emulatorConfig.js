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

    // Ceilings applied to whatever the AVD asks for, so an AVD left at some
    // wizard default cannot dwarf the host on its own.
    //
    // Sized for the deployed host - 8 vCPU / 62 GB running about two devices at
    // a time. At that concurrency the AVDs' own request (8192MB / 4 cores) fits
    // comfortably, so these ceilings are set not to clamp it: two devices is
    // ~17GB of the 62GB, and the guest vCPUs are idle often enough that 2x4 on
    // 8 host cores is not real oversubscription. The old 2048/2 pair was
    // written for a 15GB box and six devices, and on this host it only starved
    // the emulators.
    get maxMemoryMb() {
        return envInt('EMULATOR_MAX_MEMORY_MB', 8192);
    },

    get maxCores() {
        return envInt('EMULATOR_MAX_CORES', 4);
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
    //
    // The client steadily runs two. The third slot is headroom for the overlap
    // when it registers a replacement before releasing the device it is done
    // with - without it that handoff is a 429.
    get maxDevices() {
        return envInt('MAX_EMULATORS', 3);
    },

    // Reserve for the host itself before admitting another emulator.
    get reservedHostMb() {
        return envInt('HOST_RESERVED_MB', 4096);
    },

    // Assumed footprint of one emulator when checking free memory. Measured on
    // the host: qemu RSS lands about 500MB above whatever -memory grants it.
    get assumedDeviceMb() {
        return envInt('EMULATOR_ASSUMED_MB', 8704);
    },

    // uiautomator dump is one of the most expensive things you can ask a device
    // to do. Running it before every single adb call is not affordable.
    get autoDismissDialogs() {
        return envBool('ADB_AUTO_DISMISS_DIALOGS', false);
    },

    // How long to watch a freshly spawned emulator before calling it started.
    // It can die within a second - a busy AVD, a name that does not exist - and
    // reporting a "ready" device for a dead process only resurfaces later as a
    // confusing "Device not found" on the caller's next request.
    get startupGraceMs() {
        return envInt('EMULATOR_STARTUP_GRACE_MS', 4000);
    },

    // How long a device may sit unused before it is retired. This is the
    // reclaim mechanism: every request naming a device bumps its lastUsedAt, so
    // a device driving a campaign is never a candidate no matter how long the
    // campaign runs, while one the client walked away from frees its slot and
    // its AVD within the window.
    get deviceMaxIdleMs() {
        const raw = String(process.env.DEVICE_MAX_IDLE_MS ?? '').trim();
        if (raw === '0') return 0;
        return envInt('DEVICE_MAX_IDLE_MS', 15 * 60 * 1000);
    },

    // Absolute cap on a device's life, counted from registration and ignoring
    // activity. Off by default, and it should stay off: it was the 1h version
    // of this that tore down devices in the middle of an active drive, since
    // nothing about a busy device makes it younger. Set it only as a backstop
    // against a client that keeps touching a device it can no longer use.
    get deviceMaxAgeMs() {
        return envInt('DEVICE_MAX_AGE_MS', 0);
    },

    // How often the expiry sweep runs.
    get deviceSweepIntervalMs() {
        return envInt('DEVICE_SWEEP_INTERVAL_MS', 60 * 1000);
    },

    // /cleanup tears down every running device. The endpoint is unauthenticated
    // and a caller polling it on a timer is indistinguishable from an operator
    // running it once, so the destructive sweep is opt-in rather than default.
    get cleanupRequiresForce() {
        return envBool('CLEANUP_REQUIRE_FORCE', true);
    },

    // With EMULATOR_READ_ONLY=false an AVD backs exactly one emulator, so a
    // register that does not name one has to be given a free one or it races
    // whatever is already running. Only ever fills in a missing name: an AVD the
    // caller asked for by name is never substituted, because the AVDs differ in
    // which Google account is signed in and swapping one silently would run the
    // campaign as the wrong user.
    get avdAutoPick() {
        return envBool('AVD_AUTO_PICK', true);
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
