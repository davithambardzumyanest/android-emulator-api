// Per-device settings, resolved from request overrides on top of config defaults.
//
// Everything here can be supplied on POST /devices/register so a caller can
// describe the device it wants in one call, rather than registering and then
// issuing a series of adb commands.
const config = require('../config');

function bool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

function num(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function str(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/**
 * Resolve a settings object for a device.
 * @param {object} [overrides] the `settings` block from a register request
 */
function resolve(overrides = {}) {
  const o = overrides || {};

  return {
    // null means "leave the image's own value alone".
    locale: str(o.locale, config.device.locale) || null,
    timezone: str(o.timezone, config.device.timezone) || null,
    batteryLevel: num(o.batteryLevel, config.device.batteryLevel, { min: 1, max: 100 }),
    batteryCharging: bool(o.batteryCharging, false),
    disableAnimations: bool(o.disableAnimations, config.device.disableAnimations),
    screenOffTimeoutMs: num(o.screenOffTimeoutMs, config.device.screenOffTimeoutMs, { min: 15000 }),

    // --- Location behaviour ------------------------------------------------
    // Android's fused provider blends GPS with network (Wi-Fi/cell/IP) location.
    // On an emulator behind a proxy those disagree — the injected GPS fix says
    // one country and Google's network lookup says the proxy's — and apps such
    // as Maps can route from the wrong origin. gpsOnly removes the second
    // opinion so the injected fix is the only one available.
    gpsOnly: bool(o.gpsOnly, config.device.gpsOnly),
    // A real phone navigating in a car is on mobile data, not Wi-Fi. Leaving
    // Wi-Fi on also feeds the network location provider.
    wifi: bool(o.wifi, config.device.wifi),
    mobileData: bool(o.mobileData, true),
    locationMode: num(o.locationMode, 3, { min: 0, max: 3 }),

    // Packages to grant location permission to. Maps is included by default
    // because a navigation app with no location permission silently refuses to
    // follow the injected fix. Unknown packages are ignored.
    grantLocationTo: Array.isArray(o.grantLocationTo)
      ? o.grantLocationTo.filter((p) => typeof p === 'string' && p.trim())
      : ['com.google.android.apps.maps'],
  };
}

/** Shape of the settings block, for documentation and error messages. */
const FIELDS = [
  'locale', 'timezone', 'batteryLevel', 'batteryCharging', 'disableAnimations',
  'screenOffTimeoutMs', 'gpsOnly', 'wifi', 'mobileData', 'locationMode',
  'grantLocationTo',
];

module.exports = { resolve, FIELDS };
