// Request validation for device actions. Keeps ActionEngine free of HTTP concerns.
const ActionEngine = require('../actions/actionEngine');

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(`'${name}' is required and must be a non-empty string`);
  return value;
}

function requireNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(`'${name}' must be a number`);
  return n;
}

/** Shared options for the find/click family. */
function selectorOptions(body = {}) {
  const opts = {};
  if (body.timeoutMs !== undefined) opts.timeoutMs = Math.max(0, Math.min(120000, requireNumber(body.timeoutMs, 'timeoutMs')));
  if (body.pollMs !== undefined) opts.pollMs = Math.max(50, requireNumber(body.pollMs, 'pollMs'));
  if (body.scroll !== undefined) opts.scroll = Boolean(body.scroll);
  if (body.maxScrolls !== undefined) opts.maxScrolls = Math.max(0, Math.min(30, requireNumber(body.maxScrolls, 'maxScrolls')));
  if (body.requireVisible !== undefined) opts.requireVisible = Boolean(body.requireVisible);
  if (body.verify !== undefined) opts.verify = Boolean(body.verify);
  if (body.settleMs !== undefined) opts.settleMs = Math.max(0, requireNumber(body.settleMs, 'settleMs'));
  return opts;
}

const SELECTOR_FIELDS = ['any', 'text', 'content-desc', 'resource-id', 'hint'];

function selectorQuery(body = {}) {
  const query = { text: requireString(body.text, 'text') };

  if (body.exact !== undefined) query.exact = Boolean(body.exact);
  if (body.className !== undefined) query.className = requireString(body.className, 'className');

  if (body.field !== undefined) {
    if (!SELECTOR_FIELDS.includes(body.field)) {
      throw badRequest(`'field' must be one of: ${SELECTOR_FIELDS.join(', ')}`);
    }
    query.field = body.field;
  }

  if (body.index !== undefined) {
    const index = requireNumber(body.index, 'index');
    if (index < 0 || !Number.isInteger(index)) throw badRequest("'index' must be a non-negative integer");
    query.index = index;
  }

  return query;
}

const actionService = {
  launchApp: (deviceId, body) => ActionEngine.launchApp(deviceId, requireString(body?.appId, 'appId')),
  closeApp: (deviceId, body) => ActionEngine.closeApp(deviceId, requireString(body?.appId, 'appId')),

  tap(deviceId, body) {
    return ActionEngine.tap(deviceId, {
      x: requireNumber(body?.x, 'x'),
      y: requireNumber(body?.y, 'y'),
    });
  },

  swipe(deviceId, body) {
    return ActionEngine.swipe(deviceId, {
      x1: requireNumber(body?.x1, 'x1'),
      y1: requireNumber(body?.y1, 'y1'),
      x2: requireNumber(body?.x2, 'x2'),
      y2: requireNumber(body?.y2, 'y2'),
      durationMs: body?.durationMs === undefined ? 300 : requireNumber(body.durationMs, 'durationMs'),
    });
  },

  type(deviceId, body) {
    if (typeof body?.text !== 'string') throw badRequest("'text' must be a string");
    return ActionEngine.type(deviceId, { text: body.text });
  },

  back: (deviceId) => ActionEngine.back(deviceId),
  home: (deviceId) => ActionEngine.home(deviceId),

  rotate(deviceId, body) {
    const orientation = body?.orientation;
    if (!['portrait', 'landscape'].includes(orientation)) {
      throw badRequest("'orientation' must be 'portrait' or 'landscape'");
    }
    return ActionEngine.rotate(deviceId, { orientation });
  },

  intent(deviceId, body = {}) {
    const { action, data, category, component, flags, extras } = body;
    if (!action && !data && !component) {
      throw badRequest("At least one of 'action', 'data' or 'component' is required");
    }
    return ActionEngine.intent(deviceId, { action, data, category, component, flags, extras });
  },

  setGPS(deviceId, body) {
    return ActionEngine.setGPS(deviceId, {
      lat: requireNumber(body?.lat, 'lat'),
      lon: requireNumber(body?.lon, 'lon'),
      speed: body?.speed === undefined ? 0 : requireNumber(body.speed, 'speed'),
      bearing: body?.bearing === undefined ? 0 : requireNumber(body.bearing, 'bearing'),
    });
  },

  simulateRoute(deviceId, body = {}) {
    const { points, intervalMs, loop } = body;
    if (!Array.isArray(points) || points.length === 0) {
      throw badRequest("'points' must be a non-empty array of {lat, lon}");
    }
    points.forEach((p, i) => {
      if (!Number.isFinite(Number(p?.lat)) || !Number.isFinite(Number(p?.lon))) {
        throw badRequest(`points[${i}] must have numeric 'lat' and 'lon'`);
      }
    });
    return ActionEngine.simulateRoute(deviceId, {
      points,
      intervalMs: intervalMs === undefined ? 1500 : requireNumber(intervalMs, 'intervalMs'),
      loop: Boolean(loop),
    });
  },

  stopRoute: (deviceId, taskId) => ActionEngine.stopRoute(deviceId, requireString(taskId, 'taskId')),
  listRoutes: (deviceId) => ActionEngine.listRoutes(deviceId),

  screenshot: (deviceId) => ActionEngine.screenshot(deviceId),
  getCurrentPageInfo: (deviceId) => ActionEngine.getCurrentPageInfo(deviceId),

  clickByText: (deviceId, body) => ActionEngine.clickByText(deviceId, selectorQuery(body), selectorOptions(body)),
  waitForText: (deviceId, body) => ActionEngine.waitForText(deviceId, selectorQuery(body), selectorOptions(body)),
  findElements: (deviceId, body) => ActionEngine.findElements(deviceId, selectorQuery(body)),

  typeInto(deviceId, body = {}) {
    if (typeof body.value !== 'string') throw badRequest("'value' must be a string");
    return ActionEngine.typeInto(
      deviceId,
      { ...selectorQuery(body), value: body.value, clear: body.clear === undefined ? true : Boolean(body.clear) },
      selectorOptions(body),
    );
  },
};

module.exports = actionService;
