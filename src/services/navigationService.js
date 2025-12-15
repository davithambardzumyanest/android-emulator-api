const axios = require('axios');
const polyline = require('@mapbox/polyline');
const deviceManager = require('../devices/deviceManager');
const ActionEngine = require('../actions/actionEngine');

function toCoordsTuple(value) {
  if (Array.isArray(value) && value.length === 2) return { lat: Number(value[0]), lon: Number(value[1]) };
  if (value && typeof value === 'object' && typeof value.lat === 'number' && typeof value.lon === 'number') return value;
  throw Object.assign(new Error("Invalid coordinate; expected [lat, lon] or {lat, lon}"), { status: 400 });
}

function parseProxyUrl(u) {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    const proxy = {
      protocol: parsed.protocol.replace(':',''),
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80),
    };
    if (parsed.username) proxy.auth = { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password || '') };
    return proxy;
  } catch (_) {
    return null;
  }
}

async function fetchDirections(origin, destination, apiKey, mode = 'driving', axiosProxy) {
  const o = `${origin.lat},${origin.lon}`;
  const d = `${destination.lat},${destination.lon}`;
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}&mode=${encodeURIComponent(mode)}&key=${encodeURIComponent(apiKey)}`;
  const config = {};
  if (axiosProxy) {
    // Axios proxy config: { host, port, auth: { username, password }, protocol }
    config.proxy = {
      host: axiosProxy.host,
      port: axiosProxy.port,
      protocol: axiosProxy.protocol || 'http',
      ...(axiosProxy.auth ? { auth: axiosProxy.auth } : {}),
    };
  }
  const { data } = await axios.get(url, config);
  if (data.status !== 'OK') {
    const msg = data.error_message || data.status || 'Directions API error';
    const e = new Error(msg);
    e.status = 400;
    throw e;
  }
  const route = data.routes?.[0];
  if (!route) throw Object.assign(new Error('No routes found'), { status: 404 });
  const points = polyline.decode(route.overview_polyline.points)
    .map(([lat, lon]) => ({ lat, lon }));
  return { points, raw: data };
}

module.exports = {
  async navigate({ origin, destination, deviceId, intervalMs = 2000, openMaps = true, proxy }) {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      const e = new Error('GOOGLE_MAPS_API_KEY not set');
      e.status = 500;
      throw e;
    }
    const o = toCoordsTuple(origin);
    const d = toCoordsTuple(destination);

    // Acquire or use specified device
    let device;
    if (deviceId) {
      device = deviceManager.ensure(deviceId);
    } else {
      device = deviceManager.acquire({ platform: 'android' });
      if (!device) {
        const e = new Error('No available Android devices');
        e.status = 409;
        throw e;
      }
    }

    // Use proxy for Directions if provided (request proxy has priority, fallback to device.proxy)
    const axiosProxy = parseProxyUrl(proxy || device.proxy);

    const { points } = await fetchDirections(o, d, apiKey, 'driving', axiosProxy);

    // Optionally open Google Maps with navigation intent
    if (openMaps) {
      const destQuery = `${d.lat},${d.lon}`;
      await ActionEngine.intent(device.id, {
        action: 'android.intent.action.VIEW',
        data: `google.navigation:q=${encodeURIComponent(destQuery)}`,
        component: 'com.google.android.apps.maps',
      });
    }

    // Start GPS simulation along the route
    const task = await ActionEngine.simulateRoute(device.id, { points, intervalMs });

    return { ok: true, deviceId: device.id, taskId: task.taskId, pointsCount: points.length };
  },
};
