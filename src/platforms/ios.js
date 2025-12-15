module.exports = {
  async launchApp(device, appId) {
    return { ok: false, error: 'iOS control not implemented yet', status: 501 };
  },
  async closeApp(device, appId) {
    return { ok: false, error: 'iOS control not implemented yet', status: 501 };
  },
  async tap(device, payload) {
    return { ok: false, error: 'iOS control not implemented yet', status: 501 };
  },
  async swipe(device, payload) {
    return { ok: false, error: 'iOS control not implemented yet', status: 501 };
  },
  async type(device, payload) {
    return { ok: false, error: 'iOS control not implemented yet', status: 501 };
  },
  async back(device) {
    return { ok: false, error: 'iOS control not implemented yet', status: 501 };
  },
  async home(device) {
    return { ok: false, error: 'iOS control not implemented yet', status: 501 };
  },
  async rotate(device, payload) {
    return { ok: false, error: 'iOS control not implemented yet', status: 501 };
  },
  async setGPS(device, coords) {
    return { ok: false, error: 'iOS control not implemented yet', status: 501 };
  },
  async screenshotStream(device) {
    const e = new Error('iOS screenshot not implemented');
    e.status = 501;
    throw e;
  },
};
