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
const deviceSettings = require('../devices/deviceSettings');
const portAllocator = require('../utils/portAllocator');
const { run, adb, adbText, shell, getProp, listEmulators } = require('../utils/adb');
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
 * Find the pid of the emulator serving a console port.
 * Needed because `setsid --fork` hides the real pid from spawn().
 */
async function findEmulatorPid(port) {
  try {
    const { stdout } = await run('pgrep', ['-f', `-port ${port}`], { timeoutMs: 5000 });
    const pids = stdout.toString().split(/\s+/).map(Number).filter(Number.isFinite);
    // The qemu process is the longest-lived match; take the lowest pid.
    return pids.length ? Math.min(...pids) : null;
  } catch (_) {
    return null;
  }
}

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
  async start({ avd, proxy, profile: profileName = config.device.profile, wipe, settings } = {}) {
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

    // `setsid --fork` double-forks: the intermediate exits at once and the
    // emulator is reparented to init, so it is no longer a descendant of this
    // process. That matters because PM2 tree-kills the whole process tree on
    // restart — `detached: true` alone is not enough, and emulators were being
    // killed by every deploy despite running detached.
    const useSetsid = process.platform === 'linux' && fs.existsSync('/usr/bin/setsid');
    const proc = useSetsid
      ? spawn('/usr/bin/setsid', ['--fork', 'emulator', ...args], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: config.android.env,
      })
      : spawn('emulator', args, {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: config.android.env,
      });

    // The child owns the descriptor now.
    try { fs.closeSync(logFd); } catch (_) { /* already closed */ }

    proc.on('error', (err) => logger.error({ serial, err: err.message }, 'emulator spawn failed'));

    let exited = false;
    proc.on('close', (code) => {
      // Under setsid this fires as soon as the intermediate forks, which is
      // normal and says nothing about the emulator. Liveness is tracked by
      // polling adb in waitForBoot instead.
      if (useSetsid) {
        logger.debug({ serial, code }, 'setsid helper exited (emulator continues)');
        return;
      }
      exited = true;
      logger.info({ serial, code }, 'emulator process exited');
      this.processes.delete(serial);
      portAllocator.release(port);
    });

    proc.unref();
    this.processes.set(serial, { process: proc, avd, port, startedAt, pid: null });

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
    const emulatorPid = await findEmulatorPid(port);
    if (emulatorPid) {
      const entry = this.processes.get(serial);
      if (entry) entry.pid = emulatorPid;
    }
    logger.info({ serial, bootMs, pid: emulatorPid }, 'emulator booted');

    const configured = await this.configureDevice(serial, profileName, settings);
    portAllocator.release(port); // now tracked via `adb devices`

    return {
      serial,
      port,
      pid: emulatorPid || proc.pid,
      avd,
      bootMs,
      profile: profileResult,
      settings: configured.settings,
      command: `emulator ${args.join(' ')}`,
    };
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
  async configureDevice(serial, profileName = config.device.profile, overrides = {}) {
    const profile = profiles.get(profileName);
    const settings = deviceSettings.resolve(overrides);
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
    // stay_on_while_plugged_in only holds while charging, and the realism
    // settings below deliberately unplug the device — so the screen timeout is
    // what actually keeps it awake. Without a long timeout the screen sleeps
    // and every uiautomator dump fails with "null root node".
    await put('global', 'stay_on_while_plugged_in', 7);
    await put('system', 'screen_off_timeout', settings.screenOffTimeoutMs);
    await run('wake', ['input', 'keyevent', 'KEYCODE_WAKEUP']);
    await run('dismiss keyguard', ['wm', 'dismiss-keyguard']);

    // The "Swipe up to exit full screen" overlay takes window focus and makes
    // uiautomator return "null root node", breaking every UI query underneath.
    await put('secure', 'immersive_mode_confirmations', 'confirmed');

    // Disable the lock screen outright. After a wipe boot the device comes up
    // locked and intents land behind the keyguard, so launching an app appears
    // to do nothing. `wm dismiss-keyguard` alone is not enough: the keyguard
    // returns on the next screen-off.
    await run('disable lockscreen', ['locksettings', 'set-disabled', 'true']);
    await put('secure', 'lockscreen.disabled', 1);
    await run('swipe away keyguard', ['input', 'keyevent', 'KEYCODE_MENU']);

    // --- Location ----------------------------------------------------------
    await run('location enabled', ['cmd', 'location', 'set-location-enabled', 'true']);
    await put('secure', 'location_mode', settings.locationMode);

    if (settings.gpsOnly) {
      // Leave only the GPS provider in play. Otherwise the fused provider can
      // answer with a network fix derived from Wi-Fi or the exit IP, which on a
      // proxied device points at a different country than the injected fix —
      // and Maps then plans a route from there.
      //
      // Written as a plain value: the '+gps' / '-network' prefix syntax was
      // special-cased by old LocationManager versions, but on Android 13 this
      // is an ordinary string write and the prefixes end up stored literally
      // (verified: the setting read back as the string "+gps").
      await run('providers: gps only', ['settings', 'put', 'secure', 'location_providers_allowed', 'gps']);
      // Google Location Accuracy (the NLP consent) feeds the network provider.
      await put('secure', 'network_location_opt_in', 0);
      await put('global', 'wifi_scan_always_enabled', 0);
      await put('global', 'ble_scan_always_enabled', 0);
      await put('global', 'assisted_gps_enabled', 0);
    }

    // A navigation app without location permission ignores every fix we inject.
    for (const pkg of settings.grantLocationTo) {
      // eslint-disable-next-line no-await-in-loop
      await run(`grant location to ${pkg}`, ['pm', 'grant', pkg, 'android.permission.ACCESS_FINE_LOCATION']);
      // eslint-disable-next-line no-await-in-loop
      await run(`grant coarse to ${pkg}`, ['pm', 'grant', pkg, 'android.permission.ACCESS_COARSE_LOCATION']);
    }

    // --- Radios ------------------------------------------------------------
    // Wi-Fi is off by default so the guest's traffic goes out over the
    // emulated mobile link, which is the path `-http-proxy` actually proxies.
    // That is deliberate, but it is one `svc` call away from a device with no
    // network at all — and a navigation app with no network cannot fetch tiles
    // or plan a route, which looks exactly like "the emulator is broken".
    // ensureConnectivity below checks rather than assumes.
    await run(settings.wifi ? 'wifi on' : 'wifi off', ['svc', 'wifi', settings.wifi ? 'enable' : 'disable']);
    await run(settings.mobileData ? 'mobile data on' : 'mobile data off', ['svc', 'data', settings.mobileData ? 'enable' : 'disable']);

    const network = await this.ensureConnectivity(serial, settings);
    if (network.online) applied.push(`network via ${network.via}`);
    else failed.push(`network: ${network.reason}`);

    // --- Realism -----------------------------------------------------------
    if (settings.batteryCharging) {
      await run('battery charging', ['dumpsys', 'battery', 'set', 'ac', '1']);
      await run('battery status', ['dumpsys', 'battery', 'set', 'status', '2']);
    } else {
      // A real phone is not sitting at 100% on AC forever.
      await run('battery unplugged', ['dumpsys', 'battery', 'unplug']);
      await run('battery discharging', ['dumpsys', 'battery', 'set', 'status', '3']);
    }
    await run('battery level', ['dumpsys', 'battery', 'set', 'level', String(settings.batteryLevel)]);

    if (profile) {
      // Shows up in Settings and in Bluetooth/Wi-Fi Direct advertisements.
      await put('global', 'device_name', profile.props['ro.product.model']);
      await put('secure', 'bluetooth_name', profile.props['ro.product.model']);
    }

    // Timezone and locale should agree with where the device claims to be;
    // a mismatch is both unrealistic and confuses region-sensitive apps.
    // Only touched when the caller asked for a specific value — see the note
    // in config.js on why a default here does more harm than good.
    if (settings.timezone) {
      const set = await this.setTimezone(serial, settings.timezone);
      if (set.ok) applied.push(`timezone=${settings.timezone}`);
      else failed.push(`timezone: ${set.reason}`);
    }
    if (settings.locale) {
      // Stored now, but only takes effect on the next boot: Android has no way
      // to switch locale live from the shell.
      await run('locale (next boot)', ['setprop', 'persist.sys.locale', settings.locale]);
    }
    await put('system', 'screen_brightness_mode', 1);

    // A freshly-flashed device has setup completed; leaving these at 0 leaves
    // the setup wizard in front of every app.
    await put('secure', 'user_setup_complete', 1);
    await put('global', 'device_provisioned', 1);

    // Animation scales: real devices animate. Only flatten them when the
    // caller has explicitly traded realism for automation speed.
    const scale = settings.disableAnimations ? '0' : '1';
    await put('global', 'window_animation_scale', scale);
    await put('global', 'transition_animation_scale', scale);
    await put('global', 'animator_duration_scale', scale);

    logger.info(
      { serial, applied: applied.length, failed: failed.length, gpsOnly: settings.gpsOnly, online: network.online },
      'device configured',
    );
    if (failed.length) logger.debug({ serial, failed }, 'some device settings failed');

    return { settings, applied, failed, network };
  }

  /**
   * Confirm the guest still has a route to the internet after the radios were
   * configured, and put Wi-Fi back if it does not.
   *
   * Turning Wi-Fi off is how traffic is kept on the proxied mobile link, but
   * whether the emulated modem brings a data connection up at all depends on
   * the system image and on the AVD's `hw.gsmModem`. When it does not, the
   * device is left with no network whatsoever: Maps opens to a blank grid and
   * never routes. Restoring Wi-Fi trades exact proxy routing for a device that
   * works, and says so loudly rather than leaving it to be discovered from a
   * screenshot.
   */
  async ensureConnectivity(serial, settings, { attempts = 6, delayMs = 2000 } = {}) {
    const probe = async () => {
      // `ip route` needs no system service, so it answers while the framework
      // is still settling — unlike `dumpsys connectivity`.
      const routes = await shell(serial, ['ip', 'route'], { check: false, timeoutMs: 10000 })
        .catch(() => '');
      const match = /^default\b.*\bdev\s+(\S+)/m.exec(routes);
      return match ? match[1] : null;
    };

    for (let i = 0; i < attempts; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const iface = await probe();
      if (iface) return { online: true, via: iface, wifiRestored: false };
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayMs);
    }

    if (settings.wifi) {
      return { online: false, via: null, wifiRestored: false, reason: 'no default route (Wi-Fi already on)' };
    }

    logger.warn({ serial }, 'no default route with Wi-Fi off; re-enabling Wi-Fi so the device has a network');
    await shell(serial, ['svc', 'wifi', 'enable'], { check: false }).catch(() => '');

    for (let i = 0; i < attempts; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayMs);
      // eslint-disable-next-line no-await-in-loop
      const iface = await probe();
      if (iface) {
        logger.warn(
          { serial, iface },
          'Wi-Fi restored to give the device a network; traffic on this interface may bypass the emulator proxy',
        );
        return { online: true, via: iface, wifiRestored: true };
      }
    }

    return { online: false, via: null, wifiRestored: true, reason: 'no default route on either radio' };
  }

  /**
   * Set the device timezone, verifying it actually took.
   *
   * `setprop persist.sys.timezone` silently does nothing as the shell user —
   * the property is owned by the system — so the plain call is tried first and
   * then escalated through `su` on userdebug images. The result is read back
   * rather than assumed, because the failure is otherwise invisible.
   */
  async setTimezone(serial, timezone) {
    const attempts = [
      ['setprop', 'persist.sys.timezone', timezone],
      ['su', '0', 'setprop', 'persist.sys.timezone', timezone],
    ];

    for (const parts of attempts) {
      // eslint-disable-next-line no-await-in-loop
      await shell(serial, parts, { check: false }).catch(() => '');
      // eslint-disable-next-line no-await-in-loop
      const actual = await getProp(serial, 'persist.sys.timezone');
      if (actual === timezone) return { ok: true, timezone };
    }

    const actual = await getProp(serial, 'persist.sys.timezone');
    return {
      ok: false,
      reason: `still ${actual || 'unset'} (needs a rooted or userdebug image)`,
    };
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

    // Fall back to killing the process if the console kill did not take. Use
    // the emulator's own pid (discovered after boot), not the setsid helper's.
    const port = entry?.port ?? Number(serial.split('-')[1]);
    const pid = entry?.pid || (Number.isFinite(port) ? await findEmulatorPid(port) : null);

    if (pid && (await listEmulators()).includes(serial)) {
      try {
        // Negative pid kills the whole group: the emulator launcher execs qemu,
        // so signalling one alone can orphan the other.
        process.kill(-pid, 'SIGKILL');
      } catch (e) {
        if (e.code !== 'ESRCH') {
          try { process.kill(pid, 'SIGKILL'); } catch (e2) {
            if (e2.code !== 'ESRCH') errors.push(`kill ${pid}: ${e2.message}`);
          }
        }
      }
    }

    if (entry) {
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
