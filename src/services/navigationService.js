const deviceManager = require('../devices/deviceManager');
const ActionEngine = require('../actions/actionEngine');

function toLocationString(value) {
  if (Array.isArray(value) && value.length === 2) {
    const lat = Number(value[0]);
    const lon = Number(value[1]);
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      throw Object.assign(new Error("Invalid coordinate; expected numeric [lat, lon]"), { status: 400 });
    }
    return `${lat},${lon}`;
  }
  if (value && typeof value === 'object' && typeof value.lat === 'number' && typeof value.lon === 'number') {
    return `${value.lat},${value.lon}`;
  }
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  throw Object.assign(new Error("Invalid location; expected [lat, lon], {lat, lon}, or non-empty string"), { status: 400 });
}

module.exports = {
  /**
   * Navigate on a registered iOS simulator device by opening Google Maps.
   * - Works only for already-registered devices (deviceId is required).
   * - Does NOT call any external Directions API or require GOOGLE_MAPS_API_KEY.
   * - Opens Google Maps via URL scheme (comgooglemaps://) to start turn-by-turn navigation.
   * - Use /devices/:id/gps/set or /devices/:id/gps/route to control the simulated location.
   */
  async navigate({ origin, destination, deviceId, mode = 'driving', openMaps = true }) {
    const destProvided = destination !== undefined && destination !== null;
    if (!destProvided) {
      const e = new Error('destination is required');
      e.status = 400;
      throw e;
    }

    if (!deviceId) {
      const e = new Error('deviceId is required and must reference a registered iOS simulator');
      e.status = 400;
      throw e;
    }

    // Only operate on already-registered devices
    const device = deviceManager.ensure(deviceId);
    if (device.platform !== 'ios') {
      const e = new Error('Navigation API currently supports only iOS simulator devices');
      e.status = 400;
      throw e;
    }

    const destQuery = toLocationString(destination);
    const originQuery = origin ? toLocationString(origin) : 'Current Location';

    // Optionally open Google Maps with navigation URL on iOS
    if (openMaps) {
      // Use Google Maps URL scheme on iOS. Requires Google Maps to be installed in the simulator.
      // See: https://developers.google.com/maps/documentation/urls/ios-urlscheme
      const params = new URLSearchParams();
      params.set('daddr', destQuery);
      params.set('directionsmode', mode || 'driving');
      if (originQuery) params.set('saddr', originQuery);
      const mapsUrl = `comgooglemaps://?${params.toString()}`;
      await ActionEngine.openUrl(device.id, mapsUrl);
    }

    return {
      ok: true,
      deviceId: device.id,
      origin: originQuery,
      destination: destQuery,
      mode: mode || 'driving',
    };
  },
};
