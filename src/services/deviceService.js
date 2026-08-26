// Device registry operations. Emulator lifecycle lives in emulatorService.
const deviceManager = require('../devices/deviceManager');
const emulatorService = require('./emulatorService');
const avdConfig = require('../devices/avdConfig');
const profiles = require('../devices/profiles');
const config = require('../config');
const logger = require('../logger');
const { adbText, shell, getProp, listEmulators } = require('../utils/adb');

/** Parse a proxy into host/port. */
function parseProxy(value) {
  try {
    const url = new URL(value);
    return {
      host: url.hostname,
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    };
  } catch (_) {
    const m = /^([^:]+):(\d+)$/.exec(String(value));
    if (m) return { host: m[1], port: Number(m[2]) };
    const e = new Error(`Invalid proxy '${value}'; expected a URL or host:port`);
    e.status = 400;
    throw e;
  }
}

const deviceService = {
  /**
   * Register a device, booting an emulator when one is not supplied.
   * Unlike the previous version this waits for the emulator to finish booting,
   * so the device is usable the moment this resolves.
   */
  async register(payload = {}) {
    const { platform, proxy, meta = {}, avd, profile, wipe } = payload;

    if (!['android', 'ios'].includes(platform)) {
      const e = new Error("'platform' must be 'android' or 'ios'");
      e.status = 400;
      throw e;
    }

    if (platform === 'android' && !meta.deviceId) {
      const started = await emulatorService.start({ avd, proxy, profile, wipe });
      meta.deviceId = started.serial;
      meta.emulator = {
        avd: started.avd,
        serial: started.serial,
        port: started.port,
        pid: started.pid,
        bootMs: started.bootMs,
        command: started.command,
      };
      meta.profile = started.profile;
    }

    if (platform === 'android' && meta.deviceId) {
      // Adopting an existing emulator: make sure it is actually there. Without
      // this the registration succeeds and every later call fails with a
      // confusing "device not found" from adb.
      const live = await listEmulators().catch(() => []);
      if (!live.includes(meta.deviceId)) {
        const e = new Error(`Emulator '${meta.deviceId}' is not running. Attached: ${live.join(', ') || 'none'}`);
        e.status = 404;
        throw e;
      }

      // Reflect what the guest actually reports, so callers can verify the
      // device presents itself the way the profile intended.
      meta.identity = await this.identity(meta.deviceId).catch(() => null);
    }

    const device = deviceManager.register({ platform, proxy, meta });

    if (platform === 'android' && proxy) {
      try {
        await this.applyProxy(device.id, proxy);
      } catch (e) {
        logger.warn({ deviceId: device.id, err: e.message }, 'applyProxy on register failed');
      }
    }

    return device;
  },

  /** What the guest reports about itself. */
  async identity(serial) {
    const props = [
      'ro.product.manufacturer',
      'ro.product.model',
      'ro.product.brand',
      'ro.product.device',
      'ro.build.version.release',
      'ro.build.version.sdk',
      'ro.build.fingerprint',
    ];
    const values = await Promise.all(props.map((name) => getProp(serial, name)));
    const identity = Object.fromEntries(props.map((name, i) => [name, values[i]]));

    const size = await shell(serial, ['wm', 'size'], { check: false });
    const density = await shell(serial, ['wm', 'density'], { check: false });
    identity.screen = /(\d+)x(\d+)/.exec(size)?.[0] || null;
    identity.density = /(\d+)/.exec(density)?.[0] || null;

    return identity;
  },

  list() {
    return deviceManager.list();
  },

  getOrThrow(id) {
    return deviceManager.ensure(id);
  },

  /** Stop the emulator behind a device and drop it from the registry. */
  async unregister(id) {
    const device = deviceManager.ensure(id);
    const serial = device.meta?.deviceId;
    let stopped = null;
    if (serial) stopped = await emulatorService.stop(serial);
    deviceManager.remove(id);
    return { ok: true, deviceId: id, stopped };
  },

  /** Set or clear the guest's global HTTP proxy. */
  async applyProxy(id, proxyUrl) {
    const device = deviceManager.ensure(id);
    const serial = device.meta?.deviceId;
    if (!serial) {
      const e = new Error('Emulator serial not found for device');
      e.status = 400;
      throw e;
    }

    if (!proxyUrl || String(proxyUrl).trim() === '') {
      await shell(serial, ['settings', 'put', 'global', 'http_proxy', ':0'], { check: false });
      await shell(serial, ['settings', 'delete', 'global', 'global_http_proxy_host'], { check: false });
      await shell(serial, ['settings', 'delete', 'global', 'global_http_proxy_port'], { check: false });
      await shell(serial, ['settings', 'put', 'global', 'global_http_proxy_exclusion_list', ''], { check: false });
      deviceManager.update(id, { proxy: null });
      return { cleared: true };
    }

    const { host, port } = parseProxy(proxyUrl);
    await shell(serial, ['settings', 'put', 'global', 'http_proxy', `${host}:${port}`]);
    await shell(serial, ['settings', 'put', 'global', 'global_http_proxy_host', host]);
    await shell(serial, ['settings', 'put', 'global', 'global_http_proxy_port', String(port)]);
    await shell(serial, ['settings', 'put', 'global', 'global_http_proxy_exclusion_list', ''], { check: false });

    deviceManager.update(id, { proxy: proxyUrl });
    return { applied: true, host, port };
  },

  /**
   * Update the stored proxy and apply it.
   * The old version fired applyProxy into a floating async IIFE and returned
   * before it ran, so failures surfaced nowhere and callers saw success.
   */
  async updateProxy(id, proxy) {
    if (proxy === undefined) {
      const e = new Error("'proxy' is required (pass null or '' to clear)");
      e.status = 400;
      throw e;
    }
    const result = await this.applyProxy(id, proxy);
    return { device: deviceManager.ensure(id), ...result };
  },

  /**
   * Run an adb subcommand against a device.
   * @param {string} id device uuid
   * @param {string|string[]} command argv, or a string split on whitespace
   */
  async executeAdb(id, command) {
    const device = deviceManager.ensure(id);
    const serial = device.meta?.deviceId
      || (device.meta?.emulator?.port ? `emulator-${device.meta.emulator.port}` : null);

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

    // No implicit uiautomator dump here. The old code ran a full dialog scan
    // before every adb call, adding seconds to every request.
    const res = await adbText(serial, parts, { check: false });
    return { stdout: res, stderr: '' };
  },

  /** Available AVDs plus the profile each currently reports. */
  listAvds() {
    return avdConfig.list().map((name) => {
      const cfg = avdConfig.read(name);
      return {
        avd: name,
        screen: `${cfg['hw.lcd.width']}x${cfg['hw.lcd.height']}`,
        density: cfg['hw.lcd.density'],
        ramMb: cfg['hw.ramSize'],
        image: cfg['image.sysdir.1'],
        playStore: cfg['PlayStore.enabled'] === 'yes',
      };
    });
  },

  listProfiles() {
    return profiles.list();
  },

  /** Apply a hardware profile to an AVD without booting it. */
  applyProfile(avd, profile = config.device.profile) {
    return avdConfig.applyProfile(avd, profile);
  },

  async runningEmulators() {
    return listEmulators();
  },

  /**
   * Re-adopt devices registered before a restart.
   * Emulators outlive the API, so their registrations should too — otherwise a
   * deploy leaves clients holding device ids that 404.
   */
  async restoreRegistry() {
    const live = await listEmulators().catch(() => []);
    return deviceManager.restore(live);
  },

  /** Stop every emulator and clear the registry. */
  async cleanupAll(options) {
    const summary = await emulatorService.cleanupAll(options);
    deviceManager.clear();
    return summary;
  },
};

module.exports = deviceService;
