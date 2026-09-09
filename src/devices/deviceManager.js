const { v4: uuidv4 } = require('uuid');

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
      // Bumped by every request that names this device. Expiry runs off this
      // rather than off createdAt: a device driving a long campaign must not be
      // reclaimed out from under the client just for having been registered a
      // while ago.
      lastUsedAt: new Date().toISOString(),
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

  update(id, patch) {
    const d = this.get(id);
    if (!d) return null;
    const updated = { ...d, ...patch };
    this.devices.set(id, updated);
    return updated;
  }

  // Mark the device as used right now. Mutated in place rather than going
  // through update(): update() swaps in a fresh object, and simulateRoute()
  // holds a reference to this one to park its interval handles on.
  touch(id) {
    const d = this.get(id);
    if (!d) return null;
    d.lastUsedAt = new Date().toISOString();
    return d;
  }

  ensure(id) {
    const d = this.get(id);
    if (!d) throw new Error('Device not found');
    return d;
  }

  remove(id) {
    return this.devices.delete(id);
  }

  clear() {
    this.devices.clear();
  }
}

module.exports = new DeviceManager();
