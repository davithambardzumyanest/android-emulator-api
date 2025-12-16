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

  ensure(id) {
    const d = this.get(id);
    if (!d) throw new Error('Device not found');
    return d;
  }

  clear() {
    this.devices.clear();
  }
}

module.exports = new DeviceManager();
