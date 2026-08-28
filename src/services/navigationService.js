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
  if (!route) {
    const e = new Error('No route geometry returned');
    e.status = 404;
    throw e;
  }

  // Prefer the per-step polylines over `overview_polyline`. The overview is a
  // simplified line meant for drawing a route on a small map — on a city route
  // consecutive points can be hundreds of metres apart and cut corners across
  // buildings. Feeding that to a navigation app makes the device jump off the
  // road and reroute. The step polylines are the real geometry.
  const detailed = [];
  for (const leg of route.legs || []) {
    for (const step of leg.steps || []) {
      if (!step.polyline?.points) continue;
      for (const [lat, lon] of decodePolyline(step.polyline.points)) {
        const last = detailed[detailed.length - 1];
        // Steps repeat the previous step's final point.
        if (last && last.lat === lat && last.lon === lon) continue;
        detailed.push({ lat, lon });
      }
    }
  }

  if (detailed.length >= 2) return detailed;

  if (!route.overview_polyline?.points) {
    const e = new Error('No route geometry returned');
    e.status = 404;
    throw e;
  }
  return decodePolyline(route.overview_polyline.points).map(([lat, lon]) => ({ lat, lon }));
}

const MAPS_PACKAGE = 'com.google.android.apps.maps';

/**
 * Give Maps a chance to reach the foreground before the drive starts.
 * Polls the foreground package and falls back to simply waiting, because a UI
 * dump can fail on a loaded host and that is not a reason to abort the route.
 */
async function waitForMaps(deviceId, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const info = await ActionEngine.getCurrentPageInfo(deviceId);
      if (info?.currentApp?.packageName === MAPS_PACKAGE) {
        // Foregrounded is not the same as ready to navigate; let it plan.
        await new Promise((r) => { setTimeout(r, 2000); });
        return true;
      }
    } catch (e) {
      logger.debug({ deviceId, err: e.message }, 'foreground check failed while waiting for Maps');
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 1000); });
  }
  logger.warn({ deviceId, timeoutMs }, 'Maps did not reach the foreground in time; starting the route anyway');
  return false;
}

module.exports = {
  decodePolyline,

  async navigate({
    origin, destination, deviceId, intervalMs = 2000, openMaps = true, proxy, mode = 'driving',
    speedKmh = 50, loop = false, waitForFix = true, mapsSettleMs = 6000,
  }) {
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

    // Put the device at the start *and wait for the platform to report it*
    // before opening Maps. Injecting a fix is asynchronous — the console
    // accepts it, then the GNSS HAL delivers it and the framework records it —
    // so a navigation intent sent in that window is planned from the device's
    // previous position. That is the usual reason a simulated drive begins in
    // the wrong place.
    const seed = await ActionEngine.setGPS(device.id, {
      lat: from.lat,
      lon: from.lon,
      waitForFix,
      // Nothing is requesting location yet on an idle device, so Android may
      // have no fix to confirm against. Do not stall the whole request on it.
      fixTimeoutMs: 8000,
    });
    if (seed.warning) logger.warn({ deviceId: device.id, warning: seed.warning }, 'start fix not confirmed');

    if (openMaps) {
      await ActionEngine.intent(device.id, {
        action: 'android.intent.action.VIEW',
        data: `google.navigation:q=${to.lat},${to.lon}`,
        component: `${MAPS_PACKAGE}/com.google.android.maps.MapsActivity`,
      });

      // Maps has to come to the foreground, acquire a fix and plan the route
      // before it will follow anything we inject. Starting playback the
      // instant `am start` returns means the first stretch of the drive is
      // delivered to an app that is still on its splash screen — it then
      // starts navigating from wherever the route had already reached.
      await waitForMaps(device.id, mapsSettleMs);
    }

    // `speedKmh` resamples the polyline so each tick advances a realistic
    // distance. Without it the raw Directions geometry is emitted one point
    // per tick, which reports speeds in the hundreds of km/h and makes Maps
    // refuse to snap the fix to a road.
    const task = await ActionEngine.simulateRoute(device.id, {
      points, intervalMs, speedKmh, loop,
    });

    return {
      ok: true,
      deviceId: device.id,
      taskId: task.taskId,
      pointsCount: points.length,
      startFix: seed.fix || null,
      route: task,
    };
  },
};
