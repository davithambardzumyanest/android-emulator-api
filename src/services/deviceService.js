const deviceManager = require('../devices/deviceManager');
const {spawn} = require('child_process');
const {v4: uuidv4} = require('uuid');
const logger = require('../logger');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { handleSystemDialogs } = require('../utils/dialogHandler');
const cfg = require('../config/emulatorConfig');

// Run adb directly, without the per-call dialog sweep that executeAdb does.
// Used by the boot/tuning paths, which run before the device can be driven.
function execAdbRaw(args) {
    return new Promise((resolve, reject) => {
        const proc = spawn('adb', args, {stdio: ['ignore', 'pipe', 'pipe']});
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code === 0) resolve({stdout, stderr});
            else reject(new Error(`adb ${args.join(' ')} failed (${code}): ${stderr.trim() || 'Unknown error'}`));
        });
    });
}

// Read the sizing an AVD asks for, so we can clamp it rather than blindly
// overriding it. Values look like "1536M", "8192M" or a bare number of MB.
function readAvdSizing(avdName) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const configPath = path.join(home, '.android', 'avd', `${avdName}.avd`, 'config.ini');
    const sizing = {ramMb: null, cores: null};
    try {
        const text = fs.readFileSync(configPath, 'utf8');
        const ram = text.match(/^hw\.ramSize\s*=\s*(\d+)\s*([MG])?/mi);
        if (ram) {
            const n = Number(ram[1]);
            sizing.ramMb = (ram[2] || '').toUpperCase() === 'G' ? n * 1024 : n;
        }
        const cores = text.match(/^hw\.cpu\.ncore\s*=\s*(\d+)/mi);
        if (cores) sizing.cores = Number(cores[1]);
    } catch (_) { /* no config, fall back to emulator defaults */ }
    return sizing;
}

// One-time wipe flag to ensure next emulator start uses a clean data partition
const wipeFlagPath = path.join(__dirname, '../../.state');
const wipeFlagFile = path.join(wipeFlagPath, 'wipe-once.flag');

// Normalize proxy string for emulator flag (-http-proxy) which is more reliable with host:port
function normalizeProxyForEmulator(p) {
    if (!p) return null;
    try {
        const u = new URL(p);
        // If credentials or explicit scheme provided, pass through as-is (emulator supports full URL with auth)
        if (u.username || u.password || /:^https?:$/.test(u.protocol)) {
            return p;
        }
        const host = u.hostname;
        const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
        return `${host}:${port}`;
    } catch (_) {
        // allow host:port format directly
        return String(p);
    }
}

function setWipeOnceFlag() {
    try {
        fs.mkdirSync(wipeFlagPath, {recursive: true});
        fs.writeFileSync(wipeFlagFile, String(Date.now()));
    } catch (_) { /* ignore */
    }
}

function consumeWipeOnceFlag() {
    try {
        if (fs.existsSync(wipeFlagFile)) {
            fs.unlinkSync(wipeFlagFile);
            return true;
        }
    } catch (_) { /* ignore */
    }
    return false;
}

const deviceService = {
    async register(payload) {
        const {platform, proxy, meta = {}, avd} = payload || {};

        if (!platform || !['android', 'ios'].includes(platform)) {
            const e = new Error("'platform' must be 'android' or 'ios'");
            e.status = 400;
            throw e;
        }

        // If it's an Android device and no deviceId is provided, create an emulator
        if (platform === 'android' && !meta.deviceId) {
            await this.assertCapacity();

            const emulatorName = `emulator-${uuidv4().substring(0, 8)}`;
            const port = await this.allocatePort();

            // Create AVD (Android Virtual Device)
            // await this.executeCommand('avdmanager', [
            //   'create', 'avd',
            //   '-n', emulatorName,
            //   '-k', 'system-images;android-33;google_apis;x86_64',
            //   '--force'
            // ]);

            // Start the emulator
            const emulatorProcess = await this.startEmulator(avd, port, proxy);

            // Update meta with emulator details
            meta.emulator = {
                name: emulatorName,
                port,
                pid: emulatorProcess.pid,
                command: emulatorProcess.spawnargs.join(' ')
            };
            meta.deviceId = `emulator-${port}`;
        }

        const device = deviceManager.register({platform, proxy, meta});

        // Apply the low-resource settings once the device is up. Detached on
        // purpose: register() has always returned as soon as the process spawns,
        // and blocking here for a ~2 minute cold boot would break callers.
        if (platform === 'android' && cfg.tuneAfterBoot && device?.meta?.deviceId) {
            const serial = device.meta.deviceId;
            (async () => {
                const booted = await this.waitForBoot(serial);
                if (!booted) {
                    logger.warn(`[${serial}] not booted before timeout; skipping low-resource tuning`);
                    return;
                }
                try {
                    await this.tuneForLowResourceUse(serial);
                } catch (e) {
                    logger.warn(`[${serial}] low-resource tuning failed: ${e.message}`);
                }
            })();
        }

        // Best-effort: apply Android proxy if provided
        if (platform === 'android' && proxy) {
            try {
                await this.applyProxy(device.id, proxy);
            } catch (e) {
                logger.warn(`applyProxy on register failed: ${e.message}`);
            }
        }

        return device;
    },

    /**
     * Refuse to start a device we cannot afford. Overshooting RAM pushes the
     * whole host into swap, which costs far more than the extra device gains.
     */
    async assertCapacity() {
        const registered = deviceManager.list().filter((d) => d.platform === 'android').length;
        let live = 0;
        try {
            const {stdout} = await execAdbRaw(['devices']);
            live = stdout.split(/\r?\n/).filter((l) => /^emulator-\d+\s+\S/.test(l.trim())).length;
        } catch (_) { /* fall back to the registry count */ }

        const running = Math.max(registered, live);
        if (running >= cfg.maxDevices) {
            const e = new Error(`Device limit reached (${running}/${cfg.maxDevices}). Stop a device or raise MAX_EMULATORS.`);
            e.status = 429;
            throw e;
        }

        const freeMb = Math.floor(os.freemem() / (1024 * 1024));
        const needMb = cfg.assumedDeviceMb + cfg.reservedHostMb;
        if (freeMb < needMb) {
            const e = new Error(`Not enough free memory to start another emulator (${freeMb}MB free, ~${needMb}MB needed).`);
            e.status = 503;
            throw e;
        }
    },

    /**
     * Pick a console port that is not already claimed. The old random pick
     * collided often, and a collision means an emulator that boots, fails to
     * take the port, and burns CPU for nothing.
     *
     * The registry lives in memory, so it is empty after a restart even when
     * emulators are still running - adb is the authority on what is actually up.
     */
    async allocatePort() {
        const taken = new Set(
            deviceManager.list()
                .map((d) => d?.meta?.emulator?.port)
                .filter((p) => typeof p === 'number')
        );

        try {
            const {stdout} = await execAdbRaw(['devices']);
            for (const line of stdout.split(/\r?\n/)) {
                const m = line.trim().match(/^emulator-(\d+)\s+\S+/);
                if (m) taken.add(Number(m[1]));
            }
        } catch (e) {
            logger.warn(`could not enumerate adb devices for port allocation: ${e.message}`);
        }

        for (let port = 5554; port <= 5584; port += 2) {
            if (!taken.has(port)) return port;
        }
        const e = new Error('No free emulator console port in range 5554-5584');
        e.status = 503;
        throw e;
    },

    executeCommand(command, args = []) {
        return new Promise((resolve, reject) => {
            const cmd = spawn(command, args, {stdio: 'pipe'});
            let output = '';
            let error = '';

            cmd.stdout.on('data', (data) => {
                output += data.toString();
                logger.debug(`[${command}] ${data}`.trim());
            });

            cmd.stderr.on('data', (data) => {
                error += data.toString();
                logger.error(`[${command} ERROR] ${data}`.trim());
            });

            cmd.on('close', (code) => {
                if (code === 0) {
                    resolve({output, error});
                } else {
                    reject(new Error(`Command failed with code ${code}: ${error || 'Unknown error'}`));
                }
            });
        });
    },
    /**
     * Apply or clear Android global HTTP proxy on device.
     * Accepts URL (http/https) or host:port.
     */
    async applyProxy(id, proxyUrl) {
        // If falsy, clear proxy settings
        if (!proxyUrl || String(proxyUrl).trim() === '') {
            try {
                await this.executeAdb(id, ['shell', 'settings', 'put', 'global', 'http_proxy', ':0']);
            } catch (_) {
            }
            try {
                await this.executeAdb(id, ['shell', 'settings', 'delete', 'global', 'global_http_proxy_host']);
            } catch (_) {
            }
            try {
                await this.executeAdb(id, ['shell', 'settings', 'delete', 'global', 'global_http_proxy_port']);
            } catch (_) {
            }
            try {
                await this.executeAdb(id, ['shell', 'settings', 'put', 'global', 'global_http_proxy_exclusion_list', '']);
            } catch (_) {
            }
            return {cleared: true};
        }

        function parse(u) {
            try {
                const parsed = new URL(u);
                const host = parsed.hostname;
                const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
                return {host, port};
            } catch (_) {
                const m = String(u).match(/^([^:]+):(\d+)$/);
                if (m) return {host: m[1], port: Number(m[2])};
                const e = new Error('Invalid proxy URL');
                e.status = 400;
                throw e;
            }
        }

        const {host, port} = parse(proxyUrl);
        const hostPort = `${host}:${port}`;
        await this.executeAdb(id, ['shell', 'settings', 'put', 'global', 'http_proxy', hostPort]);
        await this.executeAdb(id, ['shell', 'settings', 'put', 'global', 'global_http_proxy_host', host]);
        await this.executeAdb(id, ['shell', 'settings', 'put', 'global', 'global_http_proxy_port', String(port)]);
        // Ensure no exclusion list blocks traffic
        try {
            await this.executeAdb(id, ['shell', 'settings', 'put', 'global', 'global_http_proxy_exclusion_list', '']);
        } catch (_) {
        }
        return {applied: true, host, port};
    },

    async startEmulator(avdName, port, proxy) {
        const args = [
            '-avd', avdName,
            '-port', String(port),

            // KVM acceleration
            '-accel', 'on',

            '-no-snapshot-save',   // never write a snapshot back to the AVD
            '-no-audio',           // no audio stack for headless work
            '-no-boot-anim',       // skip the boot animation (pure render cost)
            '-no-metrics',         // skip the metrics prompt/uploader
            '-gpu', cfg.gpu,       // software renderer by default; see emulatorConfig
            '-camera-back', 'none',
            '-camera-front', 'none',
            '-netdelay', 'none',
            '-netspeed', 'full'
        ];

        // Cold boot unless the host has been set up with a warm snapshot.
        if (cfg.coldBoot) {
            args.push('-no-snapshot');
        }

        // Lets several devices share one AVD, and gives each boot a throwaway
        // data overlay - which is why -wipe-data is not needed alongside it.
        if (cfg.readOnly) {
            args.push('-read-only');
        }

        // Take the AVD's own sizing, but never above the configured ceiling.
        // An explicit EMULATOR_MEMORY_MB / EMULATOR_CORES still wins outright.
        const avdSizing = readAvdSizing(avdName);

        const memoryMb = cfg.memoryMb > 0
            ? cfg.memoryMb
            : (avdSizing.ramMb && avdSizing.ramMb > cfg.maxMemoryMb ? cfg.maxMemoryMb : null);
        if (memoryMb) {
            if (!cfg.memoryMb) {
                logger.info(`[Emulator ${avdName}] capping RAM ${avdSizing.ramMb}MB -> ${memoryMb}MB`);
            }
            args.push('-memory', String(memoryMb));
        }

        const cores = cfg.cores > 0
            ? cfg.cores
            : (avdSizing.cores && avdSizing.cores > cfg.maxCores ? cfg.maxCores : null);
        if (cores) {
            args.push('-cores', String(cores));
        }
        if (cfg.resolution) {
            args.push('-skin', cfg.resolution);
        }

        if (cfg.headless) {
            args.push('-no-window');
        }

        // A fresh device was requested (one-time wipe), or wiping is forced on.
        if (consumeWipeOnceFlag() || cfg.wipeData) {
            args.push('-wipe-data');
        }

        if (proxy) {
            const norm = normalizeProxyForEmulator(proxy);
            args.push('-http-proxy', norm);
            // Set public DNS to avoid corporate DNS blocking when using proxy
            args.push('-dns-server', cfg.dns);
            logger.info(`[Emulator ${avdName}] using proxy ${norm} with DNS ${cfg.dns}`);
        }

        logger.info(`[Emulator ${avdName}] emulator ${args.join(' ')}`);

        // stdout/stderr are piped rather than inherited: the emulator is chatty
        // and inheriting dumps every line into the pm2 log for the life of the
        // device. They still have to be drained or the child blocks on a full pipe.
        const emulatorProcess = spawn('emulator', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
            env: {
                ...process.env,                         // keep existing env
                ANDROID_HOME: process.env.ANDROID_HOME || '/root/Android/Sdk',
                ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT || '/root/Android/Sdk',
                PATH: process.env.PATH
                    + ':/root/Android/Sdk/emulator'
                    + ':/root/Android/Sdk/platform-tools'
                    + ':/root/Android/Sdk/tools'
            }
        });

        emulatorProcess.stdout.on('data', (d) => logger.debug(`[Emulator ${avdName}] ${String(d).trim()}`));
        emulatorProcess.stderr.on('data', (d) => logger.debug(`[Emulator ${avdName}] ${String(d).trim()}`));

        // Log process exit
        emulatorProcess.on('close', (code) => {
            logger.info(`Emulator process exited with code ${code}`);
        });

        emulatorProcess.on('error', (err) => {
            logger.error(`Failed to start emulator: ${err.message}`);
        });

        return emulatorProcess;
    },

    /**
     * Poll until the device reports sys.boot_completed, or the timeout expires.
     */
    async waitForBoot(serial, timeoutMs = cfg.bootTimeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const {stdout} = await execAdbRaw(['-s', serial, 'shell', 'getprop', 'sys.boot_completed']);
                if (stdout.trim() === '1') return true;
            } catch (_) { /* device not up yet */ }
            await new Promise((r) => setTimeout(r, 2000));
        }
        return false;
    },

    /**
     * Settings that cut steady-state CPU on a device we only drive over adb.
     * Animations are the big one: with a software renderer every frame of every
     * transition is rasterised on the host CPU. Applied once, after boot.
     */
    async tuneForLowResourceUse(serial) {
        const settings = [
            ['global', 'window_animation_scale', '0'],
            ['global', 'transition_animation_scale', '0'],
            ['global', 'animator_duration_scale', '0'],
            ['global', 'package_verifier_enable', '0'],
            ['secure', 'screensaver_enabled', '0'],
        ];

        const applied = [];
        for (const [namespace, key, value] of settings) {
            try {
                await execAdbRaw(['-s', serial, 'shell', 'settings', 'put', namespace, key, value]);
                applied.push(`${namespace}.${key}=${value}`);
            } catch (e) {
                logger.warn(`[${serial}] failed to set ${namespace}.${key}: ${e.message}`);
            }
        }
        logger.info(`[${serial}] low-resource tuning applied: ${applied.join(', ')}`);
        return applied;
    },

    /**
     * Register any running emulator the registry does not know about.
     *
     * The registry lives in memory, so every restart loses it while the
     * emulators keep running - they then hold RAM that nothing can see, count
     * against, or shut down. Adopting them puts them back under control.
     */
    async adoptOrphanEmulators() {
        const known = new Set(
            deviceManager.list()
                .map((d) => d?.meta?.deviceId)
                .filter(Boolean)
        );

        let serials = [];
        try {
            const {stdout} = await execAdbRaw(['devices']);
            serials = stdout.split(/\r?\n/)
                .map((l) => l.trim())
                .filter((l) => /^emulator-\d+\s+device$/.test(l))
                .map((l) => l.split(/\s+/)[0]);
        } catch (e) {
            logger.warn(`could not enumerate adb devices to adopt orphans: ${e.message}`);
            return [];
        }

        const adopted = [];
        for (const serial of serials) {
            if (known.has(serial)) continue;
            const port = Number(serial.split('-')[1]);
            const device = deviceManager.register({
                platform: 'android',
                proxy: null,
                meta: {
                    deviceId: serial,
                    adopted: true,
                    emulator: {name: serial, port, pid: null, command: null}
                }
            });
            adopted.push({id: device.id, serial});
        }

        if (adopted.length > 0) {
            logger.info(`adopted ${adopted.length} orphaned emulator(s): ${adopted.map((a) => a.serial).join(', ')}`);
        }
        return adopted;
    },

    list() {
        return deviceManager.list();
    },

    getOrThrow(id) {
        const d = deviceManager.get(id);
        if (!d) {
            const e = new Error('Device not found');
            e.status = 404;
            throw e;
        }
        return d;
    },

    updateProxy(id, proxy) {
        if (!proxy) {
            const e = new Error("'proxy' is required");
            e.status = 400;
            throw e;
        }
        const updated = deviceManager.update(id, {proxy});
        if (!updated) {
            const e = new Error('Device not found');
            e.status = 404;
            throw e;
        }
        // Apply proxy on device (async, best-effort)
        (async () => {
            try {
                await this.applyProxy(id, proxy);
            } catch (e) {
                logger.warn(`applyProxy on update failed: ${e.message}`);
            }
        })();
        return updated;
    },

    /**
     * Execute an adb command targeted at the correct emulator for a device UUID.
     * @param {string} id Device UUID stored by deviceManager
     * @param {string|string[]} command e.g. "shell pm grant com.pkg android.permission.ACCESS_FINE_LOCATION"
     * @returns {Promise<{stdout: string, stderr: string}>}
     */
    async executeAdb(id, command) {
        const device = this.getOrThrow(id);

        const serial = device?.meta?.deviceId
            || (device?.meta?.emulator?.port ? `emulator-${device.meta.emulator.port}` : null);

        if (!serial) {
            const e = new Error('Emulator serial not found for device');
            e.status = 400;
            throw e;
        }

        const parts = Array.isArray(command)
            ? command
            : String(command || '').trim().split(/\s+/).filter(Boolean);

        if (parts.length === 0) {
            const e = new Error("'command' is required");
            e.status = 400;
            throw e;
        }
        // uiautomator dump + pull on every adb call is far too expensive to do
        // unconditionally; opt in with ADB_AUTO_DISMISS_DIALOGS=true.
        if (cfg.autoDismissDialogs) {
            await handleSystemDialogs(serial);
        }
        const args = ['-s', serial, ...parts];
        logger.debug(`Executing: adb ${args.join(' ')}`);

        return new Promise((resolve, reject) => {
            const proc = spawn('adb', args, {stdio: 'pipe'});
            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (d) => {
                stdout += d.toString();
            });
            proc.stderr.on('data', (d) => {
                stderr += d.toString();
            });
            proc.on('error', (err) => {
                reject(err);
            });
            proc.on('close', (code) => {
                if (code === 0) {
                    resolve({stdout: stdout.trim(), stderr: stderr.trim()});
                } else {
                    const err = new Error(`ADB command failed (${code}): ${stderr.trim() || 'Unknown error'}`);
                    err.status = 500;
                    err.stdout = stdout;
                    err.stderr = stderr;
                    reject(err);
                }
            });
        });
    },
    /**
     * Stop all emulators and clear device registry.
     * For each Android device: try to disable animations, then stop emulator.
     */
    async stopAllEmulators() {
        const devices = this.list();
        const results = [];

        for (const d of devices) {
            if (d.platform !== 'android') continue;

            const serial = d?.meta?.deviceId || (d?.meta?.emulator?.port ? `emulator-${d.meta.emulator.port}` : null);
            const pid = d?.meta?.emulator?.pid;
            const entry = {deviceId: d.id, serial, pid, stopped: false, errors: []};

            // Best-effort: disable animations before shutdown (may fail if not booted)
            if (serial) {
                try {
                    await this.executeAdb(d.id, ['shell', 'settings', 'put', 'global', 'window_animation_scale', '0']);
                } catch (e) {
                    entry.errors.push(`disable window_animation_scale: ${e.message}`);
                }
                try {
                    await this.executeAdb(d.id, ['shell', 'settings', 'put', 'global', 'transition_animation_scale', '0']);
                } catch (e) {
                    entry.errors.push(`disable transition_animation_scale: ${e.message}`);
                }
                try {
                    await this.executeAdb(d.id, ['shell', 'settings', 'put', 'global', 'animator_duration_scale', '0']);
                } catch (e) {
                    entry.errors.push(`disable animator_duration_scale: ${e.message}`);
                }
            }

            // Try graceful shutdown first
            if (serial) {
                try {
                    await this.executeAdb(d.id, ['emu', 'kill']);
                    entry.stopped = true;
                } catch (e) {
                    entry.errors.push(`adb emu kill: ${e.message}`);
                }
            }

            // Fallback: kill by PID
            if (!entry.stopped && typeof pid === 'number') {
                try {
                    process.kill(pid, 'SIGKILL');
                    entry.stopped = true;
                } catch (e) {
                    entry.errors.push(`kill ${pid}: ${e.message}`);
                }
            }

            results.push(entry);
        }

        // Clear device registry
        try {
            deviceManager.clear();
        } catch (_) {
        }

        return {results};
    },
    /**
     * Cleanup all emulators and related processes system-wide.
     * 1) Stop all known emulators from the registry (graceful, then force by PID)
     * 2) Best-effort kill any leftover emulator/qemu processes
     * 3) Kill adb server to release ports
     */
    async cleanupAll() {
        const summary = {
            stopResults: [],
            adbEnumeratedKills: [],
            processKills: [],
            adbKill: null,
            wipeNextStart: false,
            deepClean: { avdPaths: [], tmpPaths: [], errors: [] }
        };
        try {
            const stopped = await this.stopAllEmulators();
            summary.stopResults = stopped.results || [];
        } catch (e) {
            summary.stopResults = [{error: `stopAllEmulators failed: ${e.message}`}];
        }

        // Helper to run a command and ignore failures
        async function trySpawn(command, args) {
            return new Promise((resolve) => {
                const proc = spawn(command, args, {stdio: 'pipe'});
                let stderr = '';
                proc.stderr.on('data', (d) => {
                    stderr += d.toString();
                });
                proc.on('close', (code) => {
                    resolve({command: `${command} ${args.join(' ')}`, code, stderr: stderr.trim()});
                });
                proc.on('error', (err) => {
                    resolve({command: `${command} ${args.join(' ')}`, code: -1, stderr: String(err?.message || err)});
                });
            });
        }

        // Enumerate any running emulators via adb and request graceful kill
        const devicesList = await (async () => {
            const res = await trySpawn('adb', ['devices']);
            const out = (res.stderr ? '' : '') + '';
            // We need stdout; re-run capturing stdout
            return new Promise((resolve) => {
                const proc = spawn('adb', ['devices'], {stdio: ['ignore', 'pipe', 'pipe']});
                let stdout = '';
                proc.stdout.on('data', (d) => {
                    stdout += d.toString();
                });
                proc.on('close', () => resolve(stdout));
                proc.on('error', () => resolve(''));
            });
        })();

        const emulatorSerials = String(devicesList)
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => /^emulator-\d+\s+device$/.test(l))
            .map((l) => l.split(/\s+/)[0]);

        for (const serial of emulatorSerials) {
            // eslint-disable-next-line no-await-in-loop
            const res = await trySpawn('adb', ['-s', serial, 'emu', 'kill']);
            summary.adbEnumeratedKills.push({serial, ...res});
        }

        // Kill common QEMU processes that might remain (avoid broad -f on 'emulator' to not match our API path)
        const killPatterns = [
            ['pkill', ['-f', 'qemu-system-']],
            ['pkill', ['-x', 'emulator']],
            ['pkill', ['-x', 'emulator-headless']],
        ];
        for (const [cmd, args] of killPatterns) {
            // eslint-disable-next-line no-await-in-loop
            const res = await trySpawn(cmd, args);
            summary.processKills.push(res);
        }

        // // Kill adb server to release any lingering connections/ports
        // summary.adbKill = await trySpawn('adb', ['kill-server']);

        // Ensure next emulator start is a fresh device. Under -read-only every
        // boot already gets a throwaway data overlay, so forcing -wipe-data on
        // top of it only buys a redundant first boot.
        if (cfg.readOnly) {
            summary.wipeNextStart = false;
        } else {
            setWipeOnceFlag();
            summary.wipeNextStart = true;
        }

        // Deep clean: remove caches/locks/logs/snapshots and temp emulator files
        try {
            const dc = this.deepCleanEmulatorCaches();
            summary.deepClean = dc;
        } catch (e) {
            summary.deepClean.errors = [String(e?.message || e)];
        }

        // The PM2 restart is deliberately NOT done here: it kills this process,
        // so doing it inline means the caller never receives the summary above.
        // The route restarts once the response has been flushed instead.
        summary.pm2RestartPending = Boolean(process.env.PM2_APP_NAME && process.env.PM2_APP_NAME.trim());

        return summary;
    },

    /**
     * Restart this API via PM2, if a service name is configured.
     * Call this only after the HTTP response has been flushed - it kills us.
     */
    restartViaPm2() {
        const pm2Service = String(process.env.PM2_APP_NAME || '').trim();
        if (!pm2Service) return false;

        logger.info(`Restarting PM2 service: ${pm2Service}`);
        const proc = spawn('pm2', ['restart', pm2Service], {stdio: 'ignore', detached: true});
        proc.on('error', (e) => logger.error(`pm2 restart failed: ${e.message}`));
        proc.unref();
        return true;
    },

    /**
     * Remove emulator caches/locks/logs/snapshots under ~/.android/avd and temp files in /tmp.
     * Does not delete AVD definitions (.ini or system images). Best-effort and safe.
     */
    deepCleanEmulatorCaches() {
        const res = { avdPaths: [], tmpPaths: [], errors: [] };
        try {
            const home = process.env.HOME || process.env.USERPROFILE || '';
            if (home) {
                const avdRoot = path.join(home, '.android', 'avd');
                if (fs.existsSync(avdRoot)) {
                    const entries = fs.readdirSync(avdRoot, { withFileTypes: true });
                    for (const ent of entries) {
                        if (!ent.isDirectory() || !ent.name.endsWith('.avd')) continue;
                        const avdDir = path.join(avdRoot, ent.name);
                        const targets = [
                            'cache.img',
                            'cache.img.qcow2',
                            'multiinstance.lock',
                            'hardware-qemu.ini.lock',
                            'config.ini.lock',
                        ];
                        const targetDirs = ['snapshots', 'logs', 'tmp'];
                        for (const f of targets) {
                            const p = path.join(avdDir, f);
                            try { if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); res.avdPaths.push(p); } } catch (e) { res.errors.push(`${p}: ${e.message}`); }
                        }
                        for (const d of targetDirs) {
                            const p = path.join(avdDir, d);
                            try { if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); res.avdPaths.push(p); } } catch (e) { res.errors.push(`${p}: ${e.message}`); }
                        }
                        // Remove generic *.lock files
                        try {
                            const avdFiles = fs.readdirSync(avdDir);
                            for (const name of avdFiles) {
                                if (name.endsWith('.lock')) {
                                    const p = path.join(avdDir, name);
                                    try { fs.rmSync(p, { force: true }); res.avdPaths.push(p); } catch (e) { res.errors.push(`${p}: ${e.message}`); }
                                }
                            }
                        } catch (e) { res.errors.push(`${avdDir}: ${e.message}`); }
                    }
                }
            }
        } catch (e) {
            res.errors.push(`avdRoot: ${e.message}`);
        }

        // Clean /tmp emulator leftovers
        try {
            const tmp = '/tmp';
            const patterns = [/^android-emu/i, /^android-.*/i, /^AndroidEmulator/i, /^emu-.*$/i];
            if (fs.existsSync(tmp)) {
                const entries = fs.readdirSync(tmp, { withFileTypes: true });
                for (const ent of entries) {
                    const name = ent.name;
                    if (patterns.some((re) => re.test(name))) {
                        const p = path.join(tmp, name);
                        try { fs.rmSync(p, { recursive: true, force: true }); res.tmpPaths.push(p); } catch (e) { res.errors.push(`${p}: ${e.message}`); }
                    }
                }
            }
        } catch (e) {
            res.errors.push(`tmp: ${e.message}`);
        }

        return res;
    },
};

module.exports = deviceService;
