// Android device control.
//
// Every command goes through src/utils/adb, which spawns argv arrays and quotes
// each part for the device shell. The previous version built command strings and
// passed them to exec(), so any text, intent URI or package name containing shell
// metacharacters was executed on the host.
const { adbText, adbBuffer, shell, getProp } = require('../utils/adb');
const ui = require('../utils/ui');
const finder = require('../utils/finder');
const logger = require('../logger');

function serialOf(device) {
  const serial = device?.meta?.deviceId || device?.meta?.serial;
  if (!serial) {
    const e = new Error('Device serial not found. Register the device before sending commands.');
    e.status = 400;
    throw e;
  }
  return serial;
}

/** Screen-changing commands must drop the cached UI dump. */
async function act(device, parts, opts) {
  const serial = serialOf(device);
  const out = await shell(serial, parts, opts);
  ui.invalidate(serial);
  return out;
}

module.exports = {
  async launchApp(device, appId) {
    const serial = serialOf(device);

    // `monkey` finds the launcher activity without us knowing its name, but it
    // exits 0 even when the package is missing, so verify the package first.
    const path = await shell(serial, ['pm', 'path', appId], { check: false });
    if (!path.includes('package:')) {
      const e = new Error(`Package '${appId}' is not installed`);
      e.status = 404;
      throw e;
    }

    await shell(serial, ['monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1']);
    ui.invalidate(serial);
    return { ok: true, appId };
  },

  async closeApp(device, appId) {
    if (!appId) {
      const e = new Error("'appId' is required to close an app");
      e.status = 400;
      throw e;
    }
    await act(device, ['am', 'force-stop', appId]);
    return { ok: true, appId };
  },

  async intent(device, { action, data, category, component, flags, extras } = {}) {
    const parts = ['am', 'start'];
    if (action) parts.push('-a', action);
    if (data) parts.push('-d', data);
    if (category) parts.push('-c', category);
    if (component) parts.push('-n', component);
    if (Number.isFinite(flags)) parts.push('-f', String(flags));

    if (extras && typeof extras === 'object') {
      for (const [key, value] of Object.entries(extras)) {
        if (typeof value === 'number') parts.push(Number.isInteger(value) ? '-ei' : '-ef', key, String(value));
        else if (typeof value === 'boolean') parts.push('-ez', key, value ? 'true' : 'false');
        else parts.push('-e', key, String(value));
      }
    }

    const out = await act(device, parts);
    // `am start` reports failures on stdout with a zero exit code.
    if (/^Error:/m.test(out)) {
      const e = new Error(out.split('\n').find((line) => line.startsWith('Error:')) || out);
      e.status = 400;
      throw e;
    }
    return { ok: true, output: out };
  },

  async tap(device, { x, y }) {
    await act(device, ['input', 'tap', String(Math.round(x)), String(Math.round(y))]);
    return { ok: true, x, y };
  },

  async swipe(device, { x1, y1, x2, y2, durationMs = 300 }) {
    const duration = Math.max(1, Math.round(durationMs));
    await act(device, [
      'input', 'swipe',
      String(Math.round(x1)), String(Math.round(y1)),
      String(Math.round(x2)), String(Math.round(y2)),
      String(duration),
    ]);
    return { ok: true };
  },

  async type(device, { text }) {
    // shellQuote (applied inside shell()) wraps the text in single quotes, so
    // spaces and metacharacters survive intact — the old '%s' substitution only
    // covered spaces and broke on &, ", $, ` and friends.
    if (/[^\x20-\x7E]/.test(text)) {
      logger.warn('type(): non-ASCII text is not reliably supported by `input text`');
    }
    await act(device, ['input', 'text', text]);
    return { ok: true, length: text.length };
  },

  async back(device) {
    await act(device, ['input', 'keyevent', '4']);
    return { ok: true };
  },

  async home(device) {
    await act(device, ['input', 'keyevent', '3']);
    return { ok: true };
  },

  async rotate(device, { orientation }) {
    const serial = serialOf(device);
    await shell(serial, ['settings', 'put', 'system', 'accelerometer_rotation', '0']);
    await shell(serial, ['settings', 'put', 'system', 'user_rotation', orientation === 'landscape' ? '1' : '0']);
    ui.invalidate(serial);
    return { ok: true, orientation };
  },

  /**
   * Current foreground package/activity plus a structured view of the screen.
   *
   * The package is derived from the UI dump we already need, rather than from
   * `dumpsys`: every uiautomator node carries a `package` attribute, so this
   * costs nothing extra and works across API levels. The old code parsed
   * `dumpsys window` output with a regex whose capture group could only ever
   * match a single character, and returned null on Android 14 where the
   * format differs.
   */
  async getCurrentPageInfo(device) {
    const serial = serialOf(device);

    const page = {
      textElements: [],
      contentDescriptions: [],
      clickableElements: [],
      inputFields: [],
      buttons: [],
      error: null,
    };

    let packageName = null;
    let nodes = [];

    try {
      nodes = await ui.nodes(serial, { fresh: true });
      packageName = ui.foregroundPackage(nodes);

      const seen = { text: new Set(), desc: new Set(), click: new Set(), button: new Set() };

      for (const node of nodes) {
        const text = (node.text || '').trim();
        const desc = (node['content-desc'] || '').trim();
        const cls = node.class || '';
        const bounds = ui.parseBounds(node.bounds);

        if (text) seen.text.add(text);
        if (desc) seen.desc.add(desc);

        if (node.clickable === 'true' && (text || desc)) {
          const label = text || desc;
          if (!seen.click.has(label)) {
            seen.click.add(label);
            page.clickableElements.push({ label, class: cls, bounds });
          }
        }

        if (cls === 'android.widget.EditText') {
          page.inputFields.push({
            text,
            hint: node.hint || null,
            focused: node.focused === 'true',
            bounds,
          });
        }

        if (cls.endsWith('Button') && (text || desc)) {
          const label = text || desc;
          if (!seen.button.has(label)) {
            seen.button.add(label);
            page.buttons.push({ label, bounds });
          }
        }
      }

      page.textElements = [...seen.text];
      page.contentDescriptions = [...seen.desc];
    } catch (e) {
      page.error = `UI dump failed: ${e.message}`;
    }

    // The activity name needs dumpsys, which is slow and can stall on a loaded
    // host. It is a nice-to-have, so cap it and carry on without it.
    let activityName = null;
    try {
      const dump = await shell(serial, ['dumpsys', 'activity', 'activities'], { check: false, timeoutMs: 8000 });
      const match = /(?:mResumedActivity|topResumedActivity)[^{]*\{[^ ]* [^ ]* ([\w.]+)\/([\w.$]+)/.exec(dump);
      if (match) {
        if (!packageName) packageName = match[1];
        activityName = match[2];
      }
    } catch (e) {
      logger.debug({ serial, err: e.message }, 'activity name lookup skipped');
    }

    return {
      ok: true,
      currentApp: { packageName, activityName },
      pageContent: page,
      timestamp: new Date().toISOString(),
    };
  },

  async setGPS(device, { lat, lon, speed = 0, bearing = 0 }) {
    const serial = serialOf(device);
    // `emu` is a console command, not a shell command — it must not be quoted
    // for the device shell.
    await adbText(serial, ['emu', 'geo', 'fix', String(lon), String(lat)]);

    if (speed > 0 || bearing > 0) {
      const normalizedBearing = ((bearing % 360) + 360) % 360;
      const speedKnots = speed * 1.94384;

      // NMEA needs ddmm.mmmm, not decimal degrees — the old code sent decimal
      // degrees, so any consumer parsing the sentence read the wrong position.
      const toNmea = (value, degreeDigits) => {
        const abs = Math.abs(value);
        const degrees = Math.floor(abs);
        const minutes = (abs - degrees) * 60;
        return `${String(degrees).padStart(degreeDigits, '0')}${minutes.toFixed(4).padStart(7, '0')}`;
      };

      const now = new Date();
      const hhmmss = `${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}${String(now.getUTCSeconds()).padStart(2, '0')}`;
      const ddmmyy = `${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCFullYear() % 100).padStart(2, '0')}`;

      const body = `GPRMC,${hhmmss},A,${toNmea(lat, 2)},${lat >= 0 ? 'N' : 'S'},`
        + `${toNmea(lon, 3)},${lon >= 0 ? 'E' : 'W'},`
        + `${speedKnots.toFixed(2)},${normalizedBearing.toFixed(2)},${ddmmyy},,,A`;

      let checksum = 0;
      for (let i = 0; i < body.length; i += 1) checksum ^= body.charCodeAt(i);

      const sentence = `$${body}*${checksum.toString(16).toUpperCase().padStart(2, '0')}`;
      await adbText(serial, ['emu', 'geo', 'nmea', sentence], { check: false });
    }

    return { ok: true, lat, lon };
  },

  /**
   * Tap the element matching `text`.
   *
   * Matching is tolerant (case, whitespace, NBSP) and searches text,
   * content-desc, resource-id and hint. Candidates are ranked rather than
   * taken in document order, the tap lands on the nearest clickable ancestor,
   * and the element is waited for — and scrolled to — before giving up.
   *
   * @param {object} query {text, exact, index, field, className}
   * @param {object} opts  {timeoutMs, scroll, maxScrolls, requireVisible, verify}
   */
  async clickByText(device, query, opts = {}) {
    const serial = serialOf(device);
    return finder.clickByText(serial, query, opts);
  },

  /** Wait for an element to appear without tapping it. */
  async waitForText(device, query, opts = {}) {
    const serial = serialOf(device);
    const { match, candidates, scrolls, attempts } = await finder.waitFor(serial, query, opts);
    return {
      ok: true,
      found: {
        text: match.node.text || null,
        contentDesc: match.node['content-desc'] || null,
        resourceId: match.node['resource-id'] || null,
        class: match.node.class || null,
        bounds: match.bounds,
        score: match.score,
      },
      matches: candidates.length,
      scrolls,
      attempts,
    };
  },

  /** All elements matching a query, ranked — useful for debugging selectors. */
  async findElements(device, query) {
    const serial = serialOf(device);
    const nodes = await ui.nodes(serial, { fresh: true });
    return {
      ok: true,
      elements: finder.rank(nodes, query).map((r) => ({
        text: r.node.text || null,
        contentDesc: r.node['content-desc'] || null,
        resourceId: r.node['resource-id'] || null,
        class: r.node.class || null,
        clickable: r.target.clickable === 'true',
        visible: r.visible,
        score: r.score,
        bounds: r.bounds,
      })),
    };
  },

  /** Focus a field by its label/hint and type into it. */
  async typeInto(device, { text, value, clear = true, ...query }, opts = {}) {
    const serial = serialOf(device);

    await finder.clickByText(serial, { ...query, text }, { ...opts, verify: false });
    if (clear) {
      // Move to end, then delete backwards — `input keyevent 123` is END.
      await shell(serial, ['input', 'keyevent', '123']);
      await shell(serial, ['input', 'keyevent', '--longpress', ...Array(64).fill('67')], { check: false });
    }
    await shell(serial, ['input', 'text', value]);
    ui.invalidate(serial);
    return { ok: true, value };
  },

  /** Raw PNG bytes of the current screen. */
  async screenshot(device) {
    const serial = serialOf(device);
    const png = await adbBuffer(serial, ['exec-out', 'screencap', '-p']);
    if (!png.length) {
      const e = new Error('screencap returned no data');
      e.status = 503;
      throw e;
    }
    return png;
  },

  /** Cheap liveness probe used before expensive work. */
  async isBooted(device) {
    const serial = serialOf(device);
    return (await getProp(serial, 'sys.boot_completed')) === '1';
  },
};
