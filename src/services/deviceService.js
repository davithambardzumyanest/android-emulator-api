const deviceManager = require('../devices/deviceManager');

const deviceService = {
  register(payload) {
    const { platform, proxy, meta } = payload || {};
    if (!platform || !['android', 'ios'].includes(platform)) {
      const e = new Error("'platform' must be 'android' or 'ios'");
      e.status = 400;
      throw e;
    }
    return deviceManager.register({ platform, proxy, meta });
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
    const updated = deviceManager.update(id, { proxy });
    if (!updated) {
      const e = new Error('Device not found');
      e.status = 404;
      throw e;
    }
    return updated;
  },
};

module.exports = deviceService;
