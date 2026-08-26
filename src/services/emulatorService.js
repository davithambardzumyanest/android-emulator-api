// Emulator lifecycle: start, wait for boot, configure realistically, stop.
//
// This replaces two overlapping implementations that disagreed about metadata
// keys and both had destructive cleanup paths. See CHANGES.md for details.
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const config = require('../config');
const logger = require('../logger');
const profiles = require('../devices/profiles');
const avdConfig = require('../devices/avdConfig');
const portAllocator = require('../utils/portAllocator');
const { adb, adbText, shell, getProp, listEmulators } = require('../utils/adb');
const { suppressDialogs } = require('../utils/dialogHandler');

const stateDir = path.join(__dirname, '../../.state');
const wipeFlagFile = path.join(stateDir, 'wipe-once.flag');
const logDir = path.join(stateDir, 'emulator-logs');

/** Last few meaningful lines of an emulator log, for error messages. */
function readLogTail(logPath, lines = 4) {
  try {
    return fs.readFileSync(logPath, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^(INFO|libunwind)/.test(l))
      .slice(-lines)
      .join(' | ')
      .slice(0, 500);
  } catch (_) {
    return '';
  }
}

function setWipeOnceFlag() {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(wipeFlagFile, String(Date.now()));
    return true;
  } catch (e) {
    logger.warn({ err: e.message }, 'could not arm wipe-once flag');
    return false;
  }
}

function consumeWipeOnceFlag() {
  try {
    if (fs.existsSync(wipeFlagFile)) {
      fs.unlinkSync(wipeFlagFile);
      return true;
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'could not consume wipe-once flag');
  }
  return false;
}

/** Normalise a proxy for the emulator's `-http-proxy` flag. */
function normalizeProxy(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    // Credentials must be passed through as a full URL.
    if (url.username || url.password) return value;
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return `${url.hostname}:${port}`;
  } catch (_) {
    return String(value);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * RAM to give the guest.
 * Follows the device profile so the guest reports the phone's real RAM, but
 * never promises more than the host can actually back — an over-committed
 * -memory makes the emulator fail to start rather than run slowly.
 */
function resolveMemoryMb(profileName) {
  if (config.emulator.memoryMb) return config.emulator.memoryMb;

  // Profile RAM (8 GB for a Pixel 5) is realistic but expensive: several
  // emulators at that size saturate a shared host. Opt in explicitly.
  const profile = profiles.get(profileName);
  const wanted = config.emulator.memoryFromProfile ? (profile?.ramMb || 4096) : 4096;

  // os.freemem() ignores reclaimable page cache and badly understates what is
  // usable, so prefer MemAvailable where the kernel reports it.
  let availableMb = Math.floor(os.freemem() / (1024 * 1024));
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo);
    if (match) availableMb = Math.floor(Number(match[1]) / 1024);
  } catch (_) { /* not Linux, or /proc unavailable */ }

  // Leave 2 GB for the host and this API, and round to a 256 MB boundary.
  const safeMb = Math.floor(Math.max(2048, availableMb - 2048) / 256) * 256;
  const granted = Math.min(wanted, safeMb);

  if (granted < wanted) {
    logger.warn({ profile: profileName, wanted, granted, availableMb }, 'capping emulator RAM to fit host memory');
  }
  return granted;
}

class EmulatorService {
  constructor() {
    /** serial -> { process, avd, port, startedAt } */
    this.processes = new Map();
  }

  /**
   * Build the emulator argv.
   * Perf notes:
   *  - Quick boot (snapshot) turns a ~60-90s cold boot into a few seconds.
   *  - The old args hard-coded `-wipe-data`, forcing a full cold boot every
   *    single time and then appended it a second time from the flag.
   * Realism notes:
   *  - Cameras and audio hardware stay present; the emulator default of
   *    `-camera-back none` is a giveaway that no real phone shares.
   *  - Network is shaped to an LTE profile instead of `-netfast`.
   */
  buildArgs({ avd, port, proxy, profileName, wipe }) {
    const args = [
      '-avd', avd,
      '-port', String(port),
      '-accel', 'on',
      '-gpu', config.emulator.gpu,
      '-memory', String(resolveMemoryMb(profileName)),
      '-cores', String(config.emulator.cores),
      '-no-boot-anim',
    ];

    // -read-only lets several instances share one AVD, at the cost of being
    // unable to save a snapshot. Opt in only when you actually need it.
    if (config.emulator.readOnly) args.push('-read-only');

    if (wipe) {
      // Cold boot onto a fresh data partition, then save a snapshot for next time.
      args.push('-wipe-data', '-no-snapshot-load');
    } else if (!config.emulator.quickBoot) {
      args.push('-no-snapshot');
    }
    // Quick boot is the emulator's own default: it loads and saves
    // `default_boot` on its own, so the fast path passes no snapshot flags.

    if (config.emulator.headless) args.push('-no-window');
    if (!config.emulator.audio) args.push('-no-audio');

    // Only override the AVD's own camera config when explicitly asked; the
    // profile already configures a back and front camera, and a phone with no
    // cameras at all is not something an app will ever see in the wild.
    if (config.emulator.camera) {
      args.push('-camera-back', config.emulator.camera, '-camera-front', config.emulator.camera);
    }

    if (config.emulator.netProfile === 'fast') {
      args.push('-netfast');
    } else {
      // A real handset on LTE: shaped throughput and non-zero latency.
      args.push('-netspeed', 'lte', '-netdelay', 'none');
    }

    if (proxy) {
      const normalized = normalizeProxy(proxy);
      args.push('-http-proxy', normalized);
      logger.info({ avd, proxy: normalized }, 'emulator using proxy');
    }

    const dns = config.emulator.dns || (proxy ? '8.8.8.8,1.1.1.1' : '');
    if (dns) args.push('-dns-server', dns);

    // A writable /system is the only way to change the ro.product.* identity
    // baked into the image (verified: `-prop` alone leaves ro.product.model as
    // 'sdk_gphone64_x86_64'). Off by default — it disables verity and slows the
    // first boot, so opt in only when build identity actually matters.
    if (config.device.writableSystem) args.push('-writable-system');

    // Build identity (ro.product.*) is deliberately NOT passed via -prop:
    // emulator 36.x rejects it outright — "unexpected '-prop' value
    // (ro.product.model=...), only 'qemu.*' properties are supported" — so it
    // only produced warnings. Changing the build identity needs a writable
    // /system and a build.prop patch; see "Device realism" in the README.

    return args;
  }

  /**
   * Start an emulator and wait until it is usable.
   * @returns {Promise<{serial:string, port:number, pid:number, avd:string, bootMs:number, profile:object}>}
   */
  async start({ avd, proxy, profile: profileName = config.device.profile, wipe } = {}) {
    if (!avd) {
      const e = new Error("'avd' is required");
      e.status = 400;
      throw e;
    }

    const available = avdConfig.list();
    if (!available.includes(avd)) {
      const e = new Error(`AVD '${avd}' not found. Available: ${available.join(', ') || 'none'}`);
      e.status = 404;
      throw e;
    }

    // Make the virtual hardware match the phone we claim to be before boot.
    let profileResult = null;
    if (config.device.applyProfileToAvd) {
      profileResult = avdConfig.applyProfile(avd, profileName);
      // Geometry changes invalidate any existing snapshot.
      if (Object.keys(profileResult.changed).length > 0) wipe = true;
    }

    const shouldWipe = wipe || config.emulator.wipeData || consumeWipeOnceFlag();
    const port = await portAllocator.allocate();
    const serial = `emulator-${port}`;
    const args = this.buildArgs({ avd, port, proxy, profileName, wipe: shouldWipe });

    logger.info({ avd, serial, wipe: shouldWipe, profile: profileName }, 'starting emulator');
    const startedAt = Date.now();

    // Emulator output goes to a file, not to a pipe held by this process.
    // With piped stdio a detached emulator still dies when the API restarts:
    // the pipe breaks and the next write kills it (observed as a clean exit 0
    // moments after a `pm2 restart`). A file descriptor has no such tie.
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${serial}.log`);
    const logFd = fs.openSync(logPath, 'a');

    const proc = spawn('emulator', args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: config.android.env,
    });

    // The child owns the descriptor now.
    try { fs.closeSync(logFd); } catch (_) { /* already closed */ }

    proc.on('error', (err) => logger.error({ serial, err: err.message }, 'emulator spawn failed'));

    let exited = false;
    proc.on('close', (code) => {
      exited = true;
      logger.info({ serial, code }, 'emulator process exited');
      this.processes.delete(serial);
      portAllocator.release(port);
    });

    proc.unref();
    this.processes.set(serial, { process: proc, avd, port, startedAt });

    try {
      await this.waitForBoot(serial, () => exited);
    } catch (e) {
      portAllocator.release(port);
      // Kill the process group: `emulator` is a launcher that execs qemu as a
      // child, so signalling only the launcher leaves qemu running and holding
      // the port — an orphan that survives the failed registration.
      try { process.kill(-proc.pid, 'SIGKILL'); } catch (_) { /* already gone */ }
      try { proc.kill('SIGKILL'); } catch (_) { /* already gone */ }
      const tail = readLogTail(logPath);
      e.message = `${e.message}${tail ? ` (emulator log: ${tail})` : ''}`;
      throw e;
    }

    const bootMs = Date.now() - startedAt;
    logger.info({ serial, bootMs }, 'emulator booted');

    await this.configureDevice(serial, profileName);
    portAllocator.release(port); // now tracked via `adb devices`

    return { serial, port, pid: proc.pid, avd, bootMs, profile: profileResult, command: `emulator ${args.join(' ')}` };
  }

  /**
   * Block until the device reports a completed boot.
   * The old code returned as soon as spawn() resolved, so every command issued
   * right after /devices/register raced an unbooted device.
   */
  async waitForBoot(serial, hasExited = () => false, timeoutMs = config.emulator.bootTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastState = '';

    while (Date.now() < deadline) {
      if (hasExited()) {
        const e = new Error(`Emulator ${serial} exited before finishing boot`);
        e.status = 500;
        throw e;
      }

      try {
        const booted = await getProp(serial, 'sys.boot_completed');
        if (booted === '1') {
          // boot_completed fires before the launcher settles; package manager
          // readiness is what actually makes `pm`/`am` reliable.
          const pm = await shell(serial, ['pm', 'path', 'android'], { check: false });
          if (pm.includes('package:')) {
            const anim = await getProp(serial, 'init.svc.bootanim');
            if (anim !== 'running') return true;
          }
        }
        lastState = booted;
      } catch (e) {
        lastState = e.message;
      }

      await sleep(1500);
    }

    const e = new Error(`Timed out after ${timeoutMs}ms waiting for ${serial} to boot (last state: ${lastState || 'no response'})`);
    e.status = 504;
    throw e;
  }

  /**
   * Post-boot settings that make the device behave like a real handset in use,
   * and remove the things that made automation flaky.
   */
  async configureDevice(serial, profileName = config.device.profile) {
    const profile = profiles.get(profileName);
    const applied = [];
    const failed = [];

    const put = async (namespace, key, value) => {
      try {
        await shell(serial, ['settings', 'put', namespace, key, String(value)]);
        applied.push(`${namespace}.${key}=${value}`);
      } catch (e) {
        failed.push(`${namespace}.${key}: ${e.message}`);
      }
    };

    const run = async (label, parts) => {
      try {
        await shell(serial, parts, { check: false });
        applied.push(label);
      } catch (e) {
        failed.push(`${label}: ${e.message}`);
      }
    };

    // --- Reliability -------------------------------------------------------
    // Stops "X isn't responding" dialogs at the source. This is what makes the
    // per-command UI polling in the old dialogHandler unnecessary.
    try {
      await suppressDialogs(serial);
      applied.push('error dialogs suppressed');
    } catch (e) {
      failed.push(`suppressDialogs: ${e.message}`);
    }

    // Keep the screen on and unlocked so screenshots and taps land.
    // Note stay_on_while_plugged_in only holds while the device is charging,
    // and the realism settings below deliberately unplug it — so the screen
    // timeout is what actually keeps the device awake. Without a long timeout
    // the screen sleeps and every uiautomator dump fails with "null root node".
    await put('global', 'stay_on_while_plugged_in', 7);
    await put('system', 'screen_off_timeout', config.device.screenOffTimeoutMs);
    await run('wake', ['input', 'keyevent', 'KEYCODE_WAKEUP']);
    await run('dismiss keyguard', ['wm', 'dismiss-keyguard']);

    // The "Swipe up to exit full screen" overlay takes window focus and makes
    // uiautomator return "null root node", breaking every UI query underneath.
    await put('secure', 'immersive_mode_confirmations', 'confirmed');

    // --- Realism -----------------------------------------------------------
    // A real phone is not sitting at 100% on AC forever.
    await run('battery level', ['dumpsys', 'battery', 'set', 'level', String(config.device.batteryLevel)]);
    await run('battery unplugged', ['dumpsys', 'battery', 'unplug']);
    await run('battery discharging', ['dumpsys', 'battery', 'set', 'status', '3']);

    if (profile) {
      // Shows up in Settings and in Bluetooth/Wi-Fi Direct advertisements.
      await put('global', 'device_name', profile.props['ro.product.model']);
      await run('bluetooth name', ['settings', 'put', 'secure', 'bluetooth_name', profile.props['ro.product.model']]);
    }

    await run('timezone', ['setprop', 'persist.sys.timezone', config.device.timezone]);
    await put('system', 'screen_brightness_mode', 1);
    await put('secure', 'location_mode', 3);
    // A freshly-flashed device has setup completed; leaving these at 0 leaves
    // the setup wizard hanging in front of every app.
    await put('secure', 'user_setup_complete', 1);
    await put('global', 'device_provisioned', 1);

    // Animation scales: real devices animate. Only flatten them when the
    // caller has explicitly traded realism for automation speed.
    const scale = config.device.disableAnimations ? '0' : '1';
    await put('global', 'window_animation_scale', scale);
    await put('global', 'transition_animation_scale', scale);
    await put('global', 'animator_duration_scale', scale);

    logger.info({ serial, applied: applied.length, failed: failed.length }, 'device configured');
    if (failed.length) logger.debug({ serial, failed }, 'some device settings failed');

    return { applied, failed };
  }

  /** Grant a permission, ignoring "not a changeable permission" noise. */
  async grantPermission(serial, pkg, permission) {
    return shell(serial, ['pm', 'grant', pkg, permission], { check: false });
  }

  /** Stop one emulator: console kill first, then the process group. */
  async stop(serial) {
    const entry = this.processes.get(serial);
    const errors = [];

    try {
      await adbText(serial, ['emu', 'kill'], { check: false, timeoutMs: 10000 });
    } catch (e) {
      errors.push(`emu kill: ${e.message}`);
    }

    // Give the console kill a moment before escalating.
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await listEmulators()).includes(serial)) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(500);
    }

    if (entry?.process?.pid) {
      try {
        // Negative pid: the emulator was spawned detached, so kill the whole
        // group — killing only the launcher orphans the qemu child.
        process.kill(-entry.process.pid, 'SIGKILL');
      } catch (e) {
        if (e.code !== 'ESRCH') errors.push(`kill group: ${e.message}`);
      }
      this.processes.delete(serial);
      portAllocator.release(entry.port);
    }

    return { serial, stopped: errors.length === 0, errors };
  }

  /**
   * Stop every emulator this host is running.
   *
   * Deliberately narrower than the previous implementation, which:
   *   - deleted every `*.avd` directory under ~/.android/avd (the AVDs
   *     themselves, not caches) — unrecoverable data loss;
   *   - force-killed every process whose `ps aux` line contained 'emulator',
   *     which matches this API's own path (/var/www/.../android-emulator-api);
   *   - restarted itself through PM2 as a side effect of a cleanup call.
   */
  async cleanupAll({ wipeNextStart = true } = {}) {
    const startedAt = Date.now();
    const summary = { stopped: [], leftovers: [], wipeNextStart: false, durationMs: 0 };

    const serials = new Set([...this.processes.keys(), ...(await listEmulators())]);
    const results = await Promise.allSettled([...serials].map((serial) => this.stop(serial)));
    summary.stopped = results.map((r) => (r.status === 'fulfilled' ? r.value : { error: String(r.reason?.message || r.reason) }));

    // Anything still answering adb after a graceful stop.
    summary.leftovers = await listEmulators();

    if (wipeNextStart) summary.wipeNextStart = setWipeOnceFlag();

    summary.durationMs = Date.now() - startedAt;
    logger.info({ stopped: summary.stopped.length, leftovers: summary.leftovers.length, durationMs: summary.durationMs }, 'cleanup complete');
    return summary;
  }

  status() {
    return {
      running: [...this.processes.entries()].map(([serial, entry]) => ({
        serial,
        avd: entry.avd,
        port: entry.port,
        pid: entry.process.pid,
        uptimeMs: Date.now() - entry.startedAt,
      })),
    };
  }
}

module.exports = new EmulatorService();
module.exports.setWipeOnceFlag = setWipeOnceFlag;
module.exports.normalizeProxy = normalizeProxy;
