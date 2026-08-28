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
const geo = require('../utils/geo');

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
  getLocation: delegate('getLocation'),
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
   * Drive GPS along a route.
   *
   * Each emitted fix carries the speed and bearing implied by the movement, so
   * apps reading Location.getSpeed()/getBearing() — and navigation UIs that
   * orient by heading — see a coherent drive instead of a series of jumps with
   * speed 0 and bearing 0.
   *
   * With `speedKmh` the route is resampled so every tick advances a realistic
   * distance; without it, one waypoint is emitted per tick as before, and the
   * derived speed is capped at a plausible maximum. Passing a raw Directions
   * polyline without `speedKmh` is what makes a device appear to teleport: the
   * response reports `clampedPoints` so that is visible rather than silent.
   */
  async simulateRoute(deviceId, {
    points, intervalMs = 1500, loop = false, speedKmh,
  }) {
    const { device, controller } = resolve(deviceId, 'setGPS');
    if (!Array.isArray(points) || points.length === 0) {
      const e = new Error("'points' must be a non-empty array");
      e.status = 400;
      throw e;
    }

    const tick = Math.max(200, intervalMs);
    const path = speedKmh
      ? geo.interpolateRoute(points, { speedKmh, intervalMs: tick })
      : points;
    const track = geo.annotateRoute(path, tick);
    const clampedPoints = track.filter((p) => p.speedClamped !== undefined).length;

    if (clampedPoints) {
      logger.warn(
        { deviceId, clampedPoints, total: track.length, intervalMs: tick },
        'route points are too far apart for this interval; reported speed capped — pass speedKmh to resample',
      );
    }

    if (!device.tasks.route) device.tasks.route = {};
    const taskId = `route-${Date.now()}`;
    let index = 0;
    let timer = null;
    let stopped = false;

    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      delete device.tasks.route[taskId];
    };

    // Self-scheduling rather than setInterval: an adb round trip costs a
    // meaningful fraction of a short tick, and setInterval does not wait for
    // async work. The old loop skipped any tick that overlapped the previous
    // one, so playback ran slower than the speed each fix claimed — an
    // inconsistency a navigation app notices. Subtracting the elapsed time
    // keeps the real pace matching the reported one.
    const step = async () => {
      if (stopped) return;
      const startedAt = Date.now();

      try {
        const point = track[index];
        await controller.setGPS(device, {
          lat: point.lat,
          lon: point.lon,
          speed: point.speed,
          bearing: point.bearing,
        });

        index += 1;
        if (index >= track.length) {
          if (loop) index = 0;
          else { stop(); return; }
        }
      } catch (e) {
        logger.error({ deviceId, taskId, err: e.message }, 'route simulation stopped');
        stop();
        return;
      }

      if (stopped) return;
      timer = setTimeout(step, Math.max(0, tick - (Date.now() - startedAt)));
      // A pending fix must not hold the process open on shutdown.
      if (typeof timer.unref === 'function') timer.unref();
      device.tasks.route[taskId] = { stop };
    };

    device.tasks.route[taskId] = { stop };
    step(); // Emit the first fix now rather than after one tick.

    const meters = track.reduce(
      (sum, p, i) => (i ? sum + geo.distanceMeters(track[i - 1], p) : 0),
      0,
    );

    return {
      ok: true,
      taskId,
      points: track.length,
      waypoints: points.length,
      intervalMs: tick,
      loop,
      distanceMeters: Math.round(meters),
      estimatedDurationSec: Math.round((track.length * tick) / 1000),
      speedKmh: speedKmh || null,
      clampedPoints,
    };
  },

  stopRoute(deviceId, taskId) {
    const device = deviceManager.ensure(deviceId);
    const handle = device.tasks?.route?.[taskId];
    if (!handle) {
      const e = new Error(`Route task '${taskId}' not found`);
      e.status = 404;
      throw e;
    }
    handle.stop();
    return { ok: true, taskId, stopped: true };
  },

  listRoutes(deviceId) {
    const device = deviceManager.ensure(deviceId);
    return { ok: true, taskIds: Object.keys(device.tasks?.route || {}) };
  },
};

module.exports = ActionEngine;
