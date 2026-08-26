// Dispatch layer: resolve a device id to its platform controller.
//
// Screenshot capture used to live here with its own retry/dialog logic that
// ran `adb devices`, `getprop sys.boot_completed` and a full uiautomator dump
// before every single frame. Capture is now one `exec-out screencap` in the
// platform module; retries stay here, where they are cheap.
const deviceManager = require('../devices/deviceManager');
const android = require('../platforms/android');
const ios = require('../platforms/ios');
const logger = require('../logger');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function controllerFor(device) {
  if (device.platform === 'android') return android;
  if (device.platform === 'ios') return ios;
  const e = new Error(`Unsupported platform '${device.platform}'`);
  e.status = 400;
  throw e;
}

/** Resolve device + controller, asserting the operation exists. */
function resolve(deviceId, operation) {
  const device = deviceManager.ensure(deviceId);
  const controller = controllerFor(device);
  if (typeof controller[operation] !== 'function') {
    const e = new Error(`'${operation}' is not supported on ${device.platform}`);
    e.status = 501;
    throw e;
  }
  return { device, controller };
}

function delegate(operation) {
  return async (deviceId, ...args) => {
    const { device, controller } = resolve(deviceId, operation);
    return controller[operation](device, ...args);
  };
}

const ActionEngine = {
  launchApp: delegate('launchApp'),
  closeApp: delegate('closeApp'),
  tap: delegate('tap'),
  swipe: delegate('swipe'),
  type: delegate('type'),
  back: delegate('back'),
  home: delegate('home'),
  rotate: delegate('rotate'),
  intent: delegate('intent'),
  setGPS: delegate('setGPS'),
  getCurrentPageInfo: delegate('getCurrentPageInfo'),
  clickByText: delegate('clickByText'),
  waitForText: delegate('waitForText'),
  findElements: delegate('findElements'),
  typeInto: delegate('typeInto'),

  /**
   * PNG bytes of the current screen, with a short retry for transient
   * screencap failures during app transitions.
   */
  async screenshot(deviceId, { retries = 2 } = {}) {
    const { device, controller } = resolve(deviceId, 'screenshot');

    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await controller.screenshot(device);
      } catch (e) {
        lastError = e;
        logger.warn({ deviceId, attempt: attempt + 1, err: e.message }, 'screenshot failed');
        if (attempt < retries) await sleep(500 * (attempt + 1));
      }
    }
    throw lastError;
  },

  /**
   * Drive GPS along a list of points.
   * The handle is stored on the device so /gps/route/:taskId and cleanup can
   * stop it; previously nothing could, and the interval outlived the device.
   */
  async simulateRoute(deviceId, { points, intervalMs = 1500, loop = false }) {
    const { device, controller } = resolve(deviceId, 'setGPS');
    if (!Array.isArray(points) || points.length === 0) {
      const e = new Error("'points' must be a non-empty array");
      e.status = 400;
      throw e;
    }

    if (!device.tasks.route) device.tasks.route = {};
    const taskId = `route-${Date.now()}`;
    let index = 0;
    let running = false;

    const stop = () => {
      const handle = device.tasks.route[taskId];
      if (handle) {
        clearInterval(handle);
        delete device.tasks.route[taskId];
      }
    };

    const tick = async () => {
      // Skip if the previous tick is still in flight; setInterval does not
      // wait for async work and adb calls can outlast a short interval.
      if (running) return;
      running = true;
      try {
        const point = points[index];
        await controller.setGPS(device, {
          lat: point.lat,
          lon: point.lon,
          speed: point.speed || 0,
          bearing: point.bearing || 0,
        });

        index += 1;
        if (index >= points.length) {
          if (loop) index = 0;
          else stop();
        }
      } catch (e) {
        logger.error({ deviceId, taskId, err: e.message }, 'route simulation stopped');
        stop();
      } finally {
        running = false;
      }
    };

    device.tasks.route[taskId] = setInterval(tick, Math.max(200, intervalMs));
    tick(); // Emit the first point immediately instead of after one interval.

    return { ok: true, taskId, points: points.length, intervalMs, loop };
  },

  stopRoute(deviceId, taskId) {
    const device = deviceManager.ensure(deviceId);
    const handle = device.tasks?.route?.[taskId];
    if (!handle) {
      const e = new Error(`Route task '${taskId}' not found`);
      e.status = 404;
      throw e;
    }
    clearInterval(handle);
    delete device.tasks.route[taskId];
    return { ok: true, taskId, stopped: true };
  },

  listRoutes(deviceId) {
    const device = deviceManager.ensure(deviceId);
    return { ok: true, taskIds: Object.keys(device.tasks?.route || {}) };
  },
};

module.exports = ActionEngine;
