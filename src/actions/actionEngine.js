const deviceManager = require('../devices/deviceManager');
const android = require('../platforms/android');
const ios = require('../platforms/ios');
const { handleSystemDialogs } = require('../utils/dialogHandler');

async function withDialogHandling(deviceId, action) {
  const device = deviceManager.ensure(deviceId);
  // Check for and handle any system dialogs
  if (device.platform === 'android' && device?.meta?.deviceId) {
      console.log('android dialog handling')
      await handleSystemDialogs(device?.meta?.deviceId);
  } else {
      console.log('device.platform')
      console.log(device.platform)
  }
  return action(device);
}

function controllerFor(device) {
  if (device.platform === 'android') return android;
  if (device.platform === 'ios') return ios;
  throw Object.assign(new Error('Unsupported platform'), { status: 400 });
}

const ActionEngine = {
  async launchApp(deviceId, appId) {
    return withDialogHandling(deviceId, 
        device => controllerFor(device).launchApp(device, appId)
    );
  },
  async closeApp(deviceId, appId) {
    const device = deviceManager.ensure(deviceId);
    const ctrl = controllerFor(device);
    return ctrl.closeApp(device, appId);
  },
  async tap(deviceId, payload) {
    return withDialogHandling(deviceId,
        device => controllerFor(device).tap(device, payload)
    );
  },

  async clickByText(deviceId, { text, exact = true, index = 0 }) {
    return withDialogHandling(deviceId,
      device => controllerFor(device).clickByText(device, { text, exact, index })
    );
  },
  async swipe(deviceId, payload) {
    const device = deviceManager.ensure(deviceId);
    const ctrl = controllerFor(device);
    return ctrl.swipe(device, payload);
  },
  async type(deviceId, payload) {
    const device = deviceManager.ensure(deviceId);
    const ctrl = controllerFor(device);
    return ctrl.type(device, payload);
  },
  async back(deviceId) {
    const device = deviceManager.ensure(deviceId);
    const ctrl = controllerFor(device);
    return ctrl.back(device);
  },
  async home(deviceId) {
    const device = deviceManager.ensure(deviceId);
    const ctrl = controllerFor(device);
    return ctrl.home(device);
  },
  async rotate(deviceId, payload) {
    const device = deviceManager.ensure(deviceId);
    const ctrl = controllerFor(device);
    return ctrl.rotate(device, payload);
  },
  async intent(deviceId, payload) {
    const device = deviceManager.ensure(deviceId);
    const ctrl = controllerFor(device);
    if (typeof ctrl.intent !== 'function') {
      const e = new Error('Intent not supported on this platform');
      e.status = 501;
      throw e;
    }
    return ctrl.intent(device, payload);
  },
  async setGPS(deviceId, payload) {
    const device = deviceManager.ensure(deviceId);
    const ctrl = controllerFor(device);
    return ctrl.setGPS(device, payload);
  },
  async simulateRoute(deviceId, { points, intervalMs = 1500, loop = false }) {
    const device = deviceManager.ensure(deviceId);
    if (!device.tasks.route) device.tasks.route = {};
    const ctrl = controllerFor(device);
    const taskId = `route-${Date.now()}`;
    let idx = 0;

    const tick = async () => {
      try {
        if (!points || points.length === 0) return;
        const p = points[idx];
        await ctrl.setGPS(device, { lat: p.lat, lon: p.lon });
        idx += 1;
        if (idx >= points.length) {
          if (loop) idx = 0; else clearInterval(device.tasks.route[taskId]);
        }
      } catch (e) {
        clearInterval(device.tasks.route[taskId]);
      }
    };

    device.tasks.route[taskId] = setInterval(tick, intervalMs);
    return { ok: true, taskId };
  },
  async screenshotStream(deviceId) {
    return withDialogHandling(deviceId,
        () => {
            const device = deviceManager.ensure(deviceId);
            const ctrl = controllerFor(device);
            return ctrl.screenshotStream(device);
        }
    );
  },
};

module.exports = ActionEngine;
