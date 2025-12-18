const deviceManager = require('../devices/deviceManager');
const {spawn} = require('child_process');
const {v4: uuidv4} = require('uuid');
const logger = require('../logger');
const fs = require('fs');
const path = require('path');

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
            const emulatorName = `emulator-${uuidv4().substring(0, 8)}`;
            const port = 5554 + Math.floor(Math.random() * 100); // Random port between 5554-5654

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
            '-no-snapshot',        // don’t use snapshots, ensures clean boot
            '-no-audio',           // disable audio for headless
            '-no-boot-anim',       // skip boot animation for faster start
            '-gpu', 'swiftshader_indirect', // software GPU for headless
            '-memory', '8192',     // increase RAM to 8GB for stability
            '-cores', '4',         // increase CPU cores if server allows
            '-netfast',            // optimize network emulation
            '-no-window',          // run headless
            '-wipe-data',          // optional: ensures fresh emulator state
            '-verbose',            // logs more info, useful for debugging
            '-read-only'           // optional if you plan multiple instances of the same AVD
        ];

        // Headless mode via env
        const headless = String(process.env.EMULATOR_HEADLESS || '').toLowerCase() === 'true';
        if (headless) {
            args.push('-no-window');
        }

        // If cleanup requested a fresh device, wipe data on next boot
        if (consumeWipeOnceFlag()) {
            args.push('-wipe-data');
        }

        if (proxy) {
            const norm = normalizeProxyForEmulator(proxy);
            args.push('-http-proxy', norm);
            // Set public DNS to avoid corporate DNS blocking when using proxy
            args.push('-dns-server', process.env.EMULATOR_DNS || '8.8.8.8,1.1.1.1');
            logger.info(`[Emulator ${avdName}] using proxy ${norm} with DNS ${process.env.EMULATOR_DNS || '8.8.8.8,1.1.1.1'}`);
        }

        // Launch emulator directly with logs to console for debugging
        const emulatorProcess = spawn('emulator', args, {
            stdio: 'inherit', // pipe to parent's stdio to see logs in console
            shell: false,
            env: {
                ...process.env,                         // keep existing env
                ANDROID_HOME: '/root/Android/Sdk',      // set correct SDK path
                ANDROID_SDK_ROOT: '/root/Android/Sdk',
                PATH: process.env.PATH
                    + ':/root/Android/Sdk/emulator'
                    + ':/root/Android/Sdk/platform-tools'
                    + ':/root/Android/Sdk/tools'
            }
        });

        // Log process exit
        emulatorProcess.on('close', (code) => {
            logger.info(`Emulator process exited with code ${code}`);
        });

        emulatorProcess.on('error', (err) => {
            logger.error(`Failed to start emulator: ${err.message}`);
        });

        return emulatorProcess;
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

        // Kill adb server to release any lingering connections/ports
        summary.adbKill = await trySpawn('adb', ['kill-server']);

        // Ensure next emulator start is a fresh device (one-time wipe)
        setWipeOnceFlag();
        summary.wipeNextStart = true;

        // Deep clean: remove caches/locks/logs/snapshots and temp emulator files
        try {
            const dc = this.deepCleanEmulatorCaches();
            summary.deepClean = dc;
        } catch (e) {
            summary.deepClean.errors = [String(e?.message || e)];
        }

        // Optionally restart this API via PM2 if service name is provided
        const pm2Service = process.env.PM2_APP_NAME;
        if (pm2Service && pm2Service.trim().length > 0) {
            try {
                summary.pm2Restart = await (async () => {
                    // reuse trySpawn in this scope
                    return await trySpawn('pm2', ['restart', pm2Service]);
                })();
            } catch (e) {
                summary.pm2Restart = { command: `pm2 restart ${pm2Service}`, code: -1, stderr: String(e?.message || e) };
            }
        }

        return summary;
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
