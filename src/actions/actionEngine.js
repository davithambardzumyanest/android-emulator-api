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

  async screenshotStream(deviceId, retryCount = 0) {
    const MAX_RETRIES = 3;
    const device = deviceManager.ensure(deviceId);
    const serial = device?.meta?.deviceId;
    const {promisify} = require('util');
    const {exec} = require('child_process');
    const execAsync = promisify(exec);

    if (!serial) {
      throw new Error('Device serial number is not available');
    }

    console.log(`[${serial}] [${retryCount + 1}/${MAX_RETRIES}] taking screenshot...`);

    // First, ensure the emulator is responsive
    try {
      // Check if device is online
      const {stdout: devices} = await execAsync('adb devices');
      if (!devices.includes(serial)) {
        throw new Error('Device not found in adb devices');
      }

      // Check if device is booted
      const {stdout: bootStatus} = await execAsync(`adb -s ${serial} shell getprop sys.boot_completed`);
      if (bootStatus.trim() !== '1') {
        throw new Error('Device not fully booted');
      }

      // Handle any system dialogs
      const dialogHandled = await handleSystemDialogs(serial);
      if (dialogHandled) {
        console.log(`[${serial}] Handled system dialog, retrying screenshot...`);
        // Small delay to let the dialog close
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

    } catch (e) {
      console.error(`[${serial}] Device check failed:`, e.message);
      if (retryCount < MAX_RETRIES - 1) {
        const delay = 2000 * (retryCount + 1); // Exponential backoff
        console.log(`[${serial}] Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.screenshotStream(deviceId, retryCount + 1);
      }
      throw new Error(`Device not responding: ${e.message}`);
    }

    try {
      // Try direct screencap first (faster)
      const command = `adb -s ${serial} exec-out screencap -p`;
      console.log(`[${serial}] Executing: ${command}`);

      const proc = exec(command, {
        encoding: 'buffer',
        maxBuffer: 20 * 1024 * 1024, // 20MB buffer for large screenshots
        timeout: 10000 // 10 second timeout
      });

      const stream = new PassThrough();
      let stderr = '';
      let stdoutLength = 0;
      let hasData = false;

      // Set a timeout for the entire operation
      const timeout = setTimeout(() => {
        if (!hasData) {
          proc.kill();
          stream.emit('error', new Error('Screenshot operation timed out'));
        }
      }, 15000);

      proc.stdout.on('data', (chunk) => {
        if (!hasData) hasData = true;
        stdoutLength += chunk.length;
        stream.write(chunk);
      });

      proc.stderr.on('data', (data) => {
        const errorMsg = data.toString().trim();
        if (errorMsg) {
          stderr += errorMsg;
          console.error(`[${serial}] stderr:`, errorMsg);
        }
      });

      return new Promise((resolve, reject) => {
        proc.on('close', (code) => {
          clearTimeout(timeout);

          if (code !== 0 || !hasData) {
            const error = new Error(
                code !== 0
                    ? `screencap failed with code ${code}: ${stderr || 'No error details'}`
                    : 'No screenshot data received'
            );

            if (retryCount < MAX_RETRIES - 1) {
              console.warn(`[${serial}] ${error.message}, retrying...`);
              setTimeout(() => {
                resolve(this.screenshotStream(deviceId, retryCount + 1));
              }, 1000);
            } else {
              console.error(`[${serial}] Failed after ${MAX_RETRIES} attempts:`, error.message);
              reject(error);
            }
            return;
          }

          console.log(`[${serial}] Captured ${stdoutLength} bytes of screenshot data`);
          stream.end();
          resolve(stream);
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          console.error(`[${serial}] Process error:`, err.message);

          if (retryCount < MAX_RETRIES - 1) {
            console.log(`[${serial}] Retrying after error...`);
            setTimeout(() => {
              resolve(this.screenshotStream(deviceId, retryCount + 1));
            }, 1000);
          } else {
            reject(new Error(`Failed to capture screenshot: ${err.message}`));
          }
        });
      });

    } catch (error) {
      console.error(`[${serial}] Error in screenshot capture:`, error);

      if (retryCount < MAX_RETRIES - 1) {
        console.log(`[${serial}] Retrying after error...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.screenshotStream(deviceId, retryCount + 1);
      }

      throw error;
    }

  }
}

module.exports = ActionEngine;