const { exec } = require('child_process');
const { PassThrough } = require('stream');
const deviceManager = require('../devices/deviceManager');
const android = require('../platforms/android');
const ios = require('../platforms/ios');
const { handleSystemDialogs } = require('../utils/dialogHandler');

async function withDialogHandling(deviceId, action) {
  const device = deviceManager.ensure(deviceId);
  // // Check for and handle any system dialogs
  // if (device.platform === 'android' && device?.meta?.deviceId) {
  //     console.log('android dialog handling')
  //     await handleSystemDialogs(device?.meta?.deviceId);
  // } else {
  //     console.log('device.platform')
  //     console.log(device.platform)
  // }
  return action(device);
}

function controllerFor(device) {
  if (device.platform === 'android') return android;
  if (device.platform === 'ios') return ios;
  throw Object.assign(new Error('Unsupported platform'), { status: 400 });
}

const ActionEngine = {
  async launchApp(deviceId, appId) {
    return withDialogHandling(deviceId,
        device => controllerFor(device).launchApp(device, appId)
    );
  },
  async closeApp(deviceId, appId) {
    const device = deviceManager.ensure(deviceId);
    const ctrl = controllerFor(device);
    return ctrl.closeApp(device, appId);
  },
  async tap(deviceId, payload) {
    return withDialogHandling(deviceId,
        device => controllerFor(device).tap(device, payload)
    );
  },

  async clickByText(deviceId, {text, exact = true, index = 0}) {
    return withDialogHandling(deviceId,
        device => controllerFor(device).clickByText(device, {text, exact, index})
    );
  },
  async swipe(deviceId, payload) {
    const device = deviceManager.ensure(deviceId);
    const ctrl = controllerFor(device);
    return ctrl.swipe(device, payload);
  },
  async type(deviceId, payload) {
    const device = deviceManager.ensure(deviceId);
    const ctrl = controllerFor(device);
    return ctrl.type(device, payload);
  },
  async back(deviceId) {
    const device = deviceManager.ensure(deviceId);
    const ctrl = controllerFor(device);
    return ctrl.back(device);
  },
  async home(deviceId) {
    const device = deviceManager.ensure(deviceId);
    const ctrl = controllerFor(device);
    return ctrl.home(device);
  },
  async rotate(deviceId, payload) {
    const device = deviceManager.ensure(deviceId);
    const ctrl = controllerFor(device);
    return ctrl.rotate(device, payload);
  },
  async intent(deviceId, payload) {
    const device = deviceManager.ensure(deviceId);
    const ctrl = controllerFor(device);
    if (typeof ctrl.intent !== 'function') {
      const e = new Error('Intent not supported on this platform');
      e.status = 501;
      throw e;
    }
    return ctrl.intent(device, payload);
  },
  async setGPS(deviceId, payload) {
    const device = deviceManager.ensure(deviceId);
    const ctrl = controllerFor(device);
    return ctrl.setGPS(device, payload);
  },
  async simulateRoute(deviceId, {points, intervalMs = 1500, loop = false}) {
    const device = deviceManager.ensure(deviceId);
    if (!device.tasks.route) device.tasks.route = {};
    const ctrl = controllerFor(device);
    const taskId = `route-${Date.now()}`;
    let idx = 0;

    const tick = async () => {
      try {
        if (!points || points.length === 0) return;
        const p = points[idx];
        await ctrl.setGPS(device, {lat: p.lat, lon: p.lon});
        idx += 1;
        if (idx >= points.length) {
          if (loop) idx = 0; else clearInterval(device.tasks.route[taskId]);
        }
      } catch (e) {
        clearInterval(device.tasks.route[taskId]);
      }
    };

    device.tasks.route[taskId] = setInterval(tick, intervalMs);
    return {ok: true, taskId};
  },
  async screenshotStream(deviceId, retryCount = 0) {
    const MAX_RETRIES = 2;
    const device = deviceManager.ensure(deviceId);
    const serial = device?.meta?.deviceId;
    const attempt = retryCount + 1;

    if (!serial) {
      throw new Error('Device serial number is not available');
    }

    console.log(`[screenshot] Taking screenshot from device: ${serial}`);
    
    // First, ensure the emulator is responsive
    try {
      await new Promise((resolve, reject) => {
        exec(`adb -s ${serial} shell getprop dev.bootcomplete`, (error, stdout) => {
          if (error || !stdout.toString().includes('1')) {
            console.log('[screenshot] Emulator not fully booted, waiting...');
            return reject(new Error('Emulator not ready'));
          }
          resolve();
        });
      });
      handleSystemDialogs(serial)
    } catch (e) {
      if (retryCount < MAX_RETRIES) {
        console.log(`[screenshot] Retrying... (${retryCount + 1}/${MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        return this.screenshotStream(deviceId, retryCount + 1);
      }
      throw new Error('Emulator not responding. Please ensure the emulator is fully booted.');
    }

    return new Promise((resolve, reject) => {
      const command = `adb -s ${serial} exec-out screencap -p`;
      console.log(`[screenshot] Attempt ${attempt} - Executing: ${command}`);

      const proc = exec(command, {
        encoding: 'buffer',
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large screenshots
      });

      const stream = new PassThrough();
      let stderr = '';
      let stdoutLength = 0;

      proc.stdout.on('data', (chunk) => {
        stdoutLength += chunk.length;
        stream.write(chunk);
      });

      proc.stderr.on('data', (data) => {
        const errorMsg = data.toString().trim();
        if (errorMsg) {
          stderr += errorMsg;
          console.error(`[screenshot] stderr:`, errorMsg);
        }
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          const error = new Error(`screencap failed with code ${code}: ${stderr || 'No error details'}`);
          console.error(`[screenshot] Error:`, error.message);
          stream.emit('error', error);
          reject(error);
        } else if (stdoutLength === 0) {
          const error = new Error('Received empty screenshot data');
          console.error(`[screenshot] Error:`, error.message);
          stream.emit('error', error);
          reject(error);
        } else {
          console.log(`[screenshot] Captured ${stdoutLength} bytes of screenshot data`);
          stream.end();
          resolve(stream);
        }
      });

      proc.on('error', (err) => {
        const error = new Error(`screencap process error: ${err.message}`);
        console.error(`[screenshot] Process error:`, error.message);
        stream.emit('error', error);
        reject(error);
      });
    });
  }
}

module.exports = ActionEngine;
