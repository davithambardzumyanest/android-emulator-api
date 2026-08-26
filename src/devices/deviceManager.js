const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');

class DeviceManager {
  constructor() {
    this.devices = new Map();
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
    return this.devices.delete(id);
  }

  clear() {
    for (const id of this.devices.keys()) this.clearTasks(id);
    this.devices.clear();
  }
}

module.exports = new DeviceManager();
