const { exec } = require('child_process');
const { promisify } = require('util');
const { PassThrough } = require('stream');
const execAsync = promisify(exec);

// Helper to run adb commands, optionally targeting a specific device serial
async function adb(command, { serial } = {}) {
  const prefix = serial ? `adb -s ${serial}` : 'adb';
  const full = `${prefix} ${command}`;
  const { stdout, stderr } = await execAsync(full);
  if (stderr && stderr.trim()) {
    // adb often writes non-fatal info to stderr; do not throw unless clear error
    if (/error|failed/i.test(stderr)) throw new Error(stderr.trim());
  }
  return stdout;
}

module.exports = {
  // meta: { serial } should be stored on device.meta.serial when registering
  async launchApp(device, appId) {
    const serial = device.meta?.serial;
    // Prefer 'am start' to launch activity; if main activity unknown, fallback to monkey
    try {
      await adb(`shell monkey -p ${appId} -c android.intent.category.LAUNCHER 1`, { serial });
    } catch (_) {
      await adb(`shell am start -n ${appId}/.MainActivity`, { serial });
    }
    return { ok: true };
  },

  async intent(device, { action, data, category, component, flags, extras } = {}) {
    const serial = device.meta?.serial;
    const parts = ['shell', 'am', 'start'];
    if (action) parts.push('-a', action);
    if (data) parts.push('-d', `'${data}'`);
    if (category) parts.push('-c', category);
    if (component) parts.push('-n', component);
    if (typeof flags === 'number') parts.push('-f', String(flags));
    if (extras && typeof extras === 'object') {
      for (const [k, v] of Object.entries(extras)) {
        if (typeof v === 'number') {
          parts.push('-ei', k, String(v));
        } else if (typeof v === 'boolean') {
          parts.push('-ez', k, v ? 'true' : 'false');
        } else {
          parts.push('-e', k, String(v));
        }
      }
    }
    await adb(parts.join(' '), { serial });
    return { ok: true };
  },

  async closeApp(device, appId) {
    const serial = device.meta?.serial;
    if (!appId) return { ok: false, error: "'appId' required to close app" };
    await adb(`shell am force-stop ${appId}`, { serial });
    return { ok: true };
  },

  async tap(device, { x, y }) {
    const serial = device.meta?.serial;
    await adb(`shell input tap ${x} ${y}`, { serial });
    return { ok: true };
  },

  async swipe(device, { x1, y1, x2, y2, durationMs = 300 }) {
    const serial = device.meta?.serial;
    await adb(`shell input swipe ${x1} ${y1} ${x2} ${y2} ${Math.max(1, durationMs)}` , { serial });
    return { ok: true };
  },

  async type(device, { text }) {
    const serial = device.meta?.serial;
    // Escape spaces
    const escaped = text.replace(/ /g, '%s');
    await adb(`shell input text "${escaped}"`, { serial });
    return { ok: true };
  },

  async back(device) {
    const serial = device.meta?.serial;
    await adb('shell input keyevent 4', { serial });
    return { ok: true };
  },

  async home(device) {
    const serial = device.meta?.serial;
    await adb('shell input keyevent 3', { serial });
    return { ok: true };
  },

  async rotate(device, { orientation }) {
    const serial = device.meta?.serial;
    // Best-effort: disable auto-rotate and set user rotation
    if (orientation === 'portrait') {
      await adb('shell settings put system accelerometer_rotation 0', { serial });
      await adb('shell settings put system user_rotation 0', { serial });
    } else {
      await adb('shell settings put system accelerometer_rotation 0', { serial });
      await adb('shell settings put system user_rotation 1', { serial });
    }
    return { ok: true };
  },

  async setGPS(device, { lat, lon }) {
    const serial = device.meta?.serial;
    // Many emulators support: adb emu geo fix <lon> <lat>
    await adb(`emu geo fix ${lon} ${lat}`, { serial });
    return { ok: true };
  },

  async screenshotStream(device) {
    const serial = device.meta?.serial;
    // Stream PNG from screencap
    const child = require('child_process').spawn('adb', [
      ...(serial ? ['-s', serial] : []),
      'exec-out', 'screencap', '-p'
    ]);
    const stream = new PassThrough();
    child.stdout.pipe(stream);
    child.stderr.on('data', (d) => {
      // ignore unless error is thrown
    });
    child.on('error', (e) => {
      stream.destroy(e);
    });
    return stream;
  },
};
