const { exec } = require('child_process');
const { promisify } = require('util');
const { PassThrough } = require('stream');
const execAsync = promisify(exec);

// Helper to run xcrun simctl commands
async function simctl(command, { deviceId } = {}) {
  const prefix = deviceId ? `xcrun simctl ${deviceId}` : 'xcrun simctl';
  const full = `${prefix} ${command}`;
  const { stdout, stderr } = await execAsync(full);
  if (stderr && stderr.trim()) {
    if (/error|failed/i.test(stderr)) throw new Error(stderr.trim());
  }
  return stdout;
}

// Helper to run xcrun simctl commands that return binary data
async function simctlBinary(command, { deviceId } = {}) {
  const prefix = deviceId ? `xcrun simctl ${deviceId}` : 'xcrun simctl';
  const full = `${prefix} ${command}`;
  return exec(full, { encoding: 'buffer' });
}

module.exports = {
  async launchApp(device, appId) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }
    await simctl(`launch ${appId}`, { deviceId });
    return { ok: true };
  },

  async closeApp(device, appId) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }
    await simctl(`terminate ${appId}`, { deviceId });
    return { ok: true };
  },

  async tap(device, { x, y }) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }
    await simctl(`tap ${x} ${y}`, { deviceId });
    return { ok: true };
  },

  async swipe(device, { x1, y1, x2, y2, durationMs = 300 }) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }
    await simctl(`swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`, { deviceId });
    return { ok: true };
  },

  async type(device, { text }) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }
    await simctl(`type "${text}"`, { deviceId });
    return { ok: true };
  },

  async back(device) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }
    await simctl('keyevent KEYCODE_BACK', { deviceId });
    return { ok: true };
  },

  async home(device) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }
    await simctl('keyevent KEYCODE_HOME', { deviceId });
    return { ok: true };
  },

  async rotate(device, { orientation }) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }
    
    if (orientation === 'portrait') {
      await simctl('rotate portrait', { deviceId });
    } else if (orientation === 'landscape') {
      await simctl('rotate landscape', { deviceId });
    }
    return { ok: true };
  },

  async setGPS(device, { lat, lon }) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }
    await simctl(`location set ${lat} ${lon}`, { deviceId });
    return { ok: true };
  },

  async screenshotStream(device) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }

    const proc = await simctlBinary('screenshot --type=png --output=-', { deviceId });
    const stream = new PassThrough();
    
    proc.stdout.pipe(stream);
    
    proc.on('error', (err) => {
      stream.emit('error', err);
    });
    
    return stream;
  },
};
