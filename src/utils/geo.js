// Great-circle helpers for GPS simulation.
//
// A simulated drive needs more than a sequence of coordinates: apps read
// Location.getSpeed() and getBearing(), and navigation UIs orient the map by
// heading. Deriving both from consecutive route points keeps the simulated
// motion physically consistent with the positions being reported.

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** Metres between two coordinates (haversine). */
function distanceMeters(from, to) {
  const dLat = toRad(to.lat - from.lat);
  const dLon = toRad(to.lon - from.lon);
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);

  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from one coordinate to another, in degrees clockwise from north. */
function bearingDegrees(from, to) {
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const dLon = toRad(to.lon - from.lon);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const MS_TO_KNOTS = 1.9438444924406;
const metersPerSecondToKnots = (mps) => mps * MS_TO_KNOTS;

/** Decimal degrees -> NMEA ddmm.mmmm / dddmm.mmmm. */
function toNmeaDegrees(value, degreeDigits) {
  const abs = Math.abs(value);
  const degrees = Math.floor(abs);
  const minutes = (abs - degrees) * 60;
  return `${String(degrees).padStart(degreeDigits, '0')}${minutes.toFixed(4).padStart(7, '0')}`;
}

/**
 * Build a $GPRMC sentence. This is the only way to convey a course/bearing to
 * the emulator: `geo fix` accepts a velocity but has no bearing parameter.
 */
function buildGprmc({ lat, lon, speedMps = 0, bearing = 0, date = new Date() }) {
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(date.getUTCFullYear() % 100).padStart(2, '0');

  const course = ((bearing % 360) + 360) % 360;

  const body = `GPRMC,${hh}${mm}${ss}.00,A,`
    + `${toNmeaDegrees(lat, 2)},${lat >= 0 ? 'N' : 'S'},`
    + `${toNmeaDegrees(lon, 3)},${lon >= 0 ? 'E' : 'W'},`
    + `${metersPerSecondToKnots(speedMps).toFixed(2)},${course.toFixed(2)},`
    + `${dd}${mo}${yy},,,A`;

  // Checksum is the XOR of everything between '$' and '*'.
  let checksum = 0;
  for (let i = 0; i < body.length; i += 1) checksum ^= body.charCodeAt(i);

  return `$${body}*${checksum.toString(16).toUpperCase().padStart(2, '0')}`;
}

// No car drives faster than this. Speed is derived from the gap between
// consecutive route points, so a sparse polyline — Google's overview_polyline
// can put a kilometre between points — implies speeds in the hundreds of km/h.
// Reporting those to a navigation app is worse than reporting nothing: Maps
// stops snapping the fix to a road and reroutes on every tick. Resample with
// `speedKmh` to actually move at a sane pace; this cap only stops the reported
// value being nonsense in the meantime.
const PLAUSIBLE_MAX_SPEED_MPS = 70; // 252 km/h

/**
 * Annotate route points with the speed and bearing implied by travelling
 * between them at `intervalMs` per leg. Explicit values on a point win.
 *
 * @param {Array} points
 * @param {number} intervalMs
 * @param {{maxSpeedMps?:number}} [opts]
 * @returns {Array} points with `speed`, `bearing` and, where the derived speed
 *   was capped, `speedClamped: <the implausible original>`
 */
function annotateRoute(points, intervalMs, { maxSpeedMps = PLAUSIBLE_MAX_SPEED_MPS } = {}) {
  const seconds = Math.max(0.001, intervalMs / 1000);

  return points.map((point, i) => {
    const next = points[i + 1];
    const prev = points[i - 1];

    let bearing = point.bearing;
    if (bearing === undefined) {
      if (next) bearing = bearingDegrees(point, next);
      else if (prev) bearing = bearingDegrees(prev, point); // keep the last heading
      else bearing = 0;
    }

    // An explicit speed on the point is the caller's business; only a speed we
    // derived from the geometry is capped.
    if (point.speed !== undefined) return { ...point, speed: point.speed, bearing };

    // Speed for a leg is the distance to the next point over the interval;
    // the final point inherits the previous leg's speed rather than stopping
    // dead, which is what a vehicle arriving actually looks like.
    let speed;
    if (next) speed = distanceMeters(point, next) / seconds;
    else if (prev) speed = distanceMeters(prev, point) / seconds;
    else speed = 0;

    if (speed > maxSpeedMps) {
      return { ...point, speed: maxSpeedMps, bearing, speedClamped: speed };
    }
    return { ...point, speed, bearing };
  });
}

/** Point at `fraction` along the straight line between two coordinates. */
function interpolate(from, to, fraction) {
  return {
    lat: from.lat + (to.lat - from.lat) * fraction,
    lon: from.lon + (to.lon - from.lon) * fraction,
  };
}

/**
 * Resample a route so each tick advances a realistic distance.
 *
 * Directions polylines are sparse — consecutive points can be hundreds of
 * metres apart. Emitting one per tick makes the device teleport and report
 * implausible speeds (a 170 m hop every 2 s is 305 km/h). Interpolating at a
 * chosen speed produces smooth motion an app will follow like a real drive.
 *
 * @param {Array<{lat:number,lon:number}>} points route waypoints
 * @param {{speedKmh:number, intervalMs:number, maxPoints?:number}} opts
 */
function interpolateRoute(points, { speedKmh, intervalMs, maxPoints = 20000 }) {
  if (points.length < 2) return points.slice();

  const stepMeters = (speedKmh / 3.6) * (intervalMs / 1000);
  if (!(stepMeters > 0)) return points.slice();

  // Measure every leg once, then walk the polyline by cumulative distance.
  // Stepping leg-by-leg with a carry-over gives uneven spacing at each
  // boundary, which shows up as the reported speed swinging wildly.
  const legs = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const meters = distanceMeters(points[i], points[i + 1]);
    if (meters === 0) continue;
    legs.push({ from: points[i], to: points[i + 1], meters, start: total });
    total += meters;
  }
  if (legs.length === 0) return [points[0]];

  const out = [];
  let leg = 0;
  for (let travelled = 0; travelled < total && out.length < maxPoints; travelled += stepMeters) {
    while (leg < legs.length - 1 && travelled > legs[leg].start + legs[leg].meters) leg += 1;
    const current = legs[leg];
    out.push(interpolate(current.from, current.to, (travelled - current.start) / current.meters));
  }

  out.push(points[points.length - 1]);
  return out;
}

module.exports = {
  PLAUSIBLE_MAX_SPEED_MPS,
  distanceMeters,
  bearingDegrees,
  metersPerSecondToKnots,
  toNmeaDegrees,
  buildGprmc,
  annotateRoute,
  interpolate,
  interpolateRoute,
};
