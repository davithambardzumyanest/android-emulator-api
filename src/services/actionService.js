const ActionEngine = require('../actions/actionEngine');

const actionService = {
  async launchApp(deviceId, body) {
    const appId = body?.appId;
    if (!appId || typeof appId !== 'string') {
      const e = new Error("'appId' is required");
      e.status = 400;
      throw e;
    }
    return ActionEngine.launchApp(deviceId, appId);
  },

  async closeApp(deviceId, body) {
    const appId = body?.appId;
    if (!appId || typeof appId !== 'string') {
      const e = new Error("'appId' is required");
      e.status = 400;
      throw e;
    }
    return ActionEngine.closeApp(deviceId, appId);
  },

  async tap(deviceId, body) {
    const { x, y } = body || {};
    if (typeof x !== 'number' || typeof y !== 'number') {
      const e = new Error("'x' and 'y' must be numbers");
      e.status = 400;
      throw e;
    }
    return ActionEngine.tap(deviceId, { x, y });
  },

  async swipe(deviceId, body) {
    const { x1, y1, x2, y2, durationMs } = body || {};
    for (const v of [x1, y1, x2, y2]) {
      if (typeof v !== 'number') {
        const e = new Error("'x1','y1','x2','y2' must be numbers");
        e.status = 400;
        throw e;
      }
    }
    return ActionEngine.swipe(deviceId, { x1, y1, x2, y2, durationMs });
  },

  async type(deviceId, body) {
    const { text } = body || {};
    if (typeof text !== 'string') {
      const e = new Error("'text' must be a string");
      e.status = 400;
      throw e;
    }
    return ActionEngine.type(deviceId, { text });
  },

  async back(deviceId) {
    return ActionEngine.back(deviceId);
  },

  async home(deviceId) {
    return ActionEngine.home(deviceId);
  },

  async rotate(deviceId, body) {
    const { orientation } = body || {};
    if (!['portrait', 'landscape'].includes(orientation)) {
      const e = new Error("'orientation' must be 'portrait' or 'landscape'");
      e.status = 400;
      throw e;
    }
    return ActionEngine.rotate(deviceId, { orientation });
  },

  async intent(deviceId, body) {
    const { action, data, category, component, flags, extras } = body || {};
    if (!action && !data && !component) {
      const e = new Error("At least one of 'action', 'data', or 'component' is required");
      e.status = 400;
      throw e;
    }
    return ActionEngine.intent(deviceId, { action, data, category, component, flags, extras });
  },

  async setGPS(deviceId, body) {
    const { lat, lon } = body || {};
    if (typeof lat !== 'number' || typeof lon !== 'number') {
      const e = new Error("'lat' and 'lon' must be numbers");
      e.status = 400;
      throw e;
    }
    return ActionEngine.setGPS(deviceId, { lat, lon });
  },

  async simulateRoute(deviceId, body) {
    const { points, intervalMs, loop } = body || {};
    if (!Array.isArray(points) || points.some(p => typeof p?.lat !== 'number' || typeof p?.lon !== 'number')) {
      const e = new Error("'points' must be an array of {lat:number, lon:number}");
      e.status = 400;
      throw e;
    }
    return ActionEngine.simulateRoute(deviceId, { points, intervalMs, loop });
  },

  async screenshotStream(deviceId) {
    return ActionEngine.screenshotStream(deviceId);
  },
  
  async clickByText(deviceId, body) {
    const { text, exact, index } = body || {};
    if (typeof text !== 'string') {
      const e = new Error("'text' is required and must be a string");
      e.status = 400;
      throw e;
    }
    
    const clickParams = { text };
    if (exact !== undefined) clickParams.exact = Boolean(exact);
    if (index !== undefined) {
      const idx = Number(index);
      if (isNaN(idx) || idx < 0) {
        const e = new Error("If provided, 'index' must be a non-negative number");
        e.status = 400;
        throw e;
      }
      clickParams.index = idx;
    }
    
    return ActionEngine.clickByText(deviceId, clickParams);
  },
};

module.exports = actionService;
