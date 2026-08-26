// Google Directions -> GPS route simulation.
//
// This module was previously unreachable: it required '@mapbox/polyline',
// which is not in package.json and not installed, so importing it threw. It
// also called deviceManager.acquire(), which did not exist. The polyline
// decoder is inlined below to avoid the dependency entirely.
const axios = require('axios');
const deviceManager = require('../devices/deviceManager');
const ActionEngine = require('../actions/actionEngine');
const logger = require('../logger');

/**
 * Decode a Google encoded polyline into [lat, lon] pairs.
 * Reference: developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
function decodePolyline(encoded, precision = 5) {
  const factor = 10 ** precision;
  const points = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    for (const axis of ['lat', 'lon']) {
      let result = 0;
      let shift = 0;
      let byte;

      do {
        byte = encoded.charCodeAt(index) - 63;
        index += 1;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);

      const delta = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (axis === 'lat') lat += delta; else lon += delta;
    }
    points.push([lat / factor, lon / factor]);
  }

  return points;
}

function toCoords(value, name) {
  if (Array.isArray(value) && value.length === 2) {
    return { lat: Number(value[0]), lon: Number(value[1]) };
  }
  if (value && typeof value === 'object' && Number.isFinite(Number(value.lat)) && Number.isFinite(Number(value.lon))) {
    return { lat: Number(value.lat), lon: Number(value.lon) };
  }
  const e = new Error(`'${name}' must be [lat, lon] or {lat, lon}`);
  e.status = 400;
  throw e;
}

function parseProxyUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const proxy = {
      protocol: url.protocol.replace(':', ''),
      host: url.hostname,
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    };
    if (url.username) {
      proxy.auth = {
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password || ''),
      };
    }
    return proxy;
  } catch (_) {
    return null;
  }
}

async function fetchDirections(origin, destination, apiKey, mode, proxy) {
  const { data } = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
    // Passed as params so values are encoded once, by axios.
    params: {
      origin: `${origin.lat},${origin.lon}`,
      destination: `${destination.lat},${destination.lon}`,
      mode,
      key: apiKey,
    },
    timeout: 15000,
    ...(proxy ? { proxy } : {}),
  });

  if (data.status !== 'OK') {
    const e = new Error(data.error_message || data.status || 'Directions API error');
    e.status = data.status === 'ZERO_RESULTS' ? 404 : 400;
    throw e;
  }

  const route = data.routes?.[0];
  if (!route?.overview_polyline?.points) {
    const e = new Error('No route geometry returned');
    e.status = 404;
    throw e;
  }

  return decodePolyline(route.overview_polyline.points).map(([lat, lon]) => ({ lat, lon }));
}

module.exports = {
  decodePolyline,

  async navigate({ origin, destination, deviceId, intervalMs = 2000, openMaps = true, proxy, mode = 'driving' }) {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      const e = new Error('GOOGLE_MAPS_API_KEY is not set');
      e.status = 503;
      throw e;
    }

    const from = toCoords(origin, 'origin');
    const to = toCoords(destination, 'destination');

    const device = deviceId
      ? deviceManager.ensure(deviceId)
      : deviceManager.acquire({ platform: 'android' });

    if (!device) {
      const e = new Error('No available Android devices');
      e.status = 409;
      throw e;
    }

    const points = await fetchDirections(from, to, apiKey, mode, parseProxyUrl(proxy || device.proxy));
    logger.info({ deviceId: device.id, points: points.length }, 'route fetched');

    // Put the device at the start before opening Maps, so navigation begins
    // from the route's origin rather than the emulator's default location.
    await ActionEngine.setGPS(device.id, { lat: from.lat, lon: from.lon });

    if (openMaps) {
      await ActionEngine.intent(device.id, {
        action: 'android.intent.action.VIEW',
        data: `google.navigation:q=${to.lat},${to.lon}`,
        component: 'com.google.android.apps.maps/com.google.android.maps.MapsActivity',
      });
    }

    const task = await ActionEngine.simulateRoute(device.id, { points, intervalMs });
    return { ok: true, deviceId: device.id, taskId: task.taskId, pointsCount: points.length };
  },
};
