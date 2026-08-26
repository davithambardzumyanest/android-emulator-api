const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

// Registrations are mirrored to disk so a deploy or `pm2 restart` does not
// invalidate device ids that clients are still using. Emulators run detached
// and outlive the API, so the ids must outlive it too.
const stateDir = path.join(__dirname, '../../.state');
const registryFile = path.join(stateDir, 'devices.json');

class DeviceManager {
  constructor() {
    this.devices = new Map();
  }

  /** Write the registry to disk. Best effort: never fail a request over this. */
  persist() {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      // `tasks` holds live timer handles, which cannot be serialised.
      const data = this.list().map(({ tasks, ...rest }) => rest);
      fs.writeFileSync(`${registryFile}.tmp`, JSON.stringify(data, null, 2));
      fs.renameSync(`${registryFile}.tmp`, registryFile);
    } catch (e) {
      logger.warn({ err: e.message }, 'could not persist device registry');
    }
  }

  /**
   * Restore registrations from disk, keeping only devices whose emulator is
   * still running.
   * @param {string[]} liveSerials serials currently visible to adb
   */
  restore(liveSerials = []) {
    let restored = 0;
    let dropped = 0;
    try {
      if (!fs.existsSync(registryFile)) return { restored, dropped };
      const data = JSON.parse(fs.readFileSync(registryFile, 'utf8'));

      for (const device of Array.isArray(data) ? data : []) {
        const serial = device?.meta?.deviceId;
        // An android device without a live emulator is a dead registration.
        if (device.platform === 'android' && (!serial || !liveSerials.includes(serial))) {
          dropped += 1;
          continue;
        }
        this.devices.set(device.id, { ...device, tasks: {} });
        restored += 1;
      }
    } catch (e) {
      logger.warn({ err: e.message }, 'could not restore device registry');
    }
    if (restored || dropped) logger.info({ restored, dropped }, 'device registry restored');
    this.persist();
    return { restored, dropped };
  }

  register({ platform, proxy, meta }) {
    const id = uuidv4();
    const device = {
      id,
      platform, // 'android' | 'ios'
      proxy: proxy || null,
      status: 'ready',
      session: {},
      tasks: {},
      meta: meta || {},
      createdAt: new Date().toISOString(),
    };
    this.devices.set(id, device);
    this.persist();
    return device;
  }

  list() {
    return Array.from(this.devices.values());
  }

  get(id) {
    return this.devices.get(id) || null;
  }

  /**
   * Merge a patch into a device *in place*.
   * The previous version replaced the stored object with a copy, so any caller
   * holding a reference — simulateRoute holds one for the lifetime of a route —
   * silently kept mutating an orphaned object.
   */
  update(id, patch) {
    const device = this.get(id);
    if (!device) return null;
    Object.assign(device, patch);
    this.persist();
    return device;
  }

  ensure(id) {
    const device = this.get(id);
    if (!device) {
      const e = new Error('Device not found');
      e.status = 404;
      throw e;
    }
    return device;
  }

  /** First device matching a platform that is not already busy. */
  acquire({ platform } = {}) {
    return this.list().find((d) => (!platform || d.platform === platform) && d.status === 'ready') || null;
  }

  /**
   * Stop every background task on a device.
   * Route simulations run on setInterval; clearing the registry without
   * clearing them left timers firing GPS updates forever.
   */
  clearTasks(id) {
    const device = this.get(id);
    if (!device?.tasks) return 0;
    let cleared = 0;
    for (const group of Object.values(device.tasks)) {
      for (const [taskId, handle] of Object.entries(group || {})) {
        clearInterval(handle);
        delete group[taskId];
        cleared += 1;
      }
    }
    if (cleared) logger.debug({ deviceId: id, cleared }, 'cleared background tasks');
    return cleared;
  }

  remove(id) {
    this.clearTasks(id);
    const removed = this.devices.delete(id);
    this.persist();
    return removed;
  }

  clear() {
    for (const id of this.devices.keys()) this.clearTasks(id);
    this.devices.clear();
    this.persist();
  }
}

module.exports = new DeviceManager();
