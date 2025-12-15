const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const deviceManager = require('../devices/deviceManager');
const logger = require('../logger');

class EmulatorManager {
  constructor() {
    this.processes = new Map();
  }

  async startEmulator({
    avd,
    port = 5554,
    proxy,
    noSnapshot = true,
    noAudio = true,
    noBootAnim = true,
    gpu = 'swiftshader_indirect',
    memory = 4096,
    cores = 4,
  }) {
    try {
      const serial = `emulator-${port}`;
      logger.info(`Starting emulator ${avd} on port ${port}...`);

      // Build command arguments
      const args = [
        '-avd', avd,
        '-port', String(port),
        ...(noSnapshot ? ['-no-snapshot'] : []),
        ...(noAudio ? ['-no-audio'] : []),
        ...(noBootAnim ? ['-no-boot-anim'] : []),
        '-gpu', gpu,
        '-memory', String(memory),
        '-cores', String(cores),
        '-netfast'
      ];

      if (proxy) {
        args.push('-http-proxy', proxy);
        logger.info(`Using proxy: ${proxy}`);
      }

      // Log the full command for debugging
      const command = `emulator ${args.join(' ')} &`;
      logger.debug(`Executing: ${command}`);

      // Start emulator process
      const emulatorProcess = spawn('emulator', args, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      // Log emulator output
      emulatorProcess.stdout.on('data', (data) => {
        logger.debug(`[Emulator ${avd}]: ${data.toString().trim()}`);
      });

      emulatorProcess.stderr.on('data', (data) => {
        logger.error(`[Emulator ${avd} Error]: ${data.toString().trim()}`);
      });

      emulatorProcess.on('close', (code) => {
        const msg = `Emulator ${avd} (${serial}) process exited with code ${code}`;
        if (code === 0) {
          logger.info(msg);
        } else {
          logger.error(msg);
        }
        this.processes.delete(serial);
      });

      // Store process reference
      this.processes.set(serial, emulatorProcess);

      // Wait for device to be ready
      await this.waitForBoot(serial);
      logger.info(`Emulator ${avd} (${serial}) is ready`);

      // Configure device
      await this.configureDevice(serial);

      // Register device
      const device = deviceManager.register({
        platform: 'android',
        proxy,
        meta: {
          serial,
          avd,
          port,
          pid: emulatorProcess.pid
        }
      });

      return { success: true, device };
    } catch (error) {
      logger.error(`Failed to start emulator: ${error.message}`);
      throw error;
    }
  }

  async waitForBoot(serial, timeout = 120000) {
    const start = Date.now();
    logger.debug(`Waiting for ${serial} to boot...`);

    while (Date.now() - start < timeout) {
      try {
        const booted = await this.executeAdbCommand(serial, 'getprop sys.boot_completed');
        if (booted.trim() === '1') {
          return true;
        }
      } catch (e) {
        // Ignore errors while waiting for boot
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error(`Timeout waiting for ${serial} to boot`);
  }

  async configureDevice(serial) {
    try {
      logger.debug(`Configuring device ${serial}...`);
      
      // Enable location services
      await this.executeAdbCommand(serial, 'settings put secure location_mode 3');
      
      // Grant necessary permissions to Maps
      await this.executeAdbCommand(
        serial,
        'pm grant com.google.android.apps.maps android.permission.ACCESS_FINE_LOCATION'
      );
      
      logger.debug(`Device ${serial} configured successfully`);
    } catch (error) {
      logger.error(`Failed to configure device ${serial}: ${error.message}`);
      throw error;
    }
  }

  async executeAdbCommand(serial, command) {
    return new Promise((resolve, reject) => {
      const adbCommand = `adb -s ${serial} ${command}`;
      logger.debug(`Executing: ${adbCommand}`);
      
      const process = spawn('sh', ['-c', adbCommand]);
      let output = '';
      let error = '';

      process.stdout.on('data', (data) => {
        output += data.toString();
      });

      process.stderr.on('data', (data) => {
        error += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(`ADB command failed (${code}): ${error || 'Unknown error'}`));
        }
      });
    });
  }

  async stopEmulator(serial) {
    try {
      logger.info(`Stopping emulator ${serial}...`);
      
      // Kill the emulator process
      const process = this.processes.get(serial);
      if (process) {
        process.kill('SIGTERM');
        this.processes.delete(serial);
      }

      // Force stop using ADB as fallback
      try {
        await this.executeAdbCommand(serial, 'emu kill');
      } catch (e) {
        // Ignore if emulator is already stopped
      }

      // Update device status
      const device = deviceManager.get(serial);
      if (device) {
        device.status = 'offline';
      }

      logger.info(`Emulator ${serial} stopped`);
      return { success: true };
    } catch (error) {
      logger.error(`Failed to stop emulator ${serial}: ${error.message}`);
      throw error;
    }
  }

  getEmulatorStatus() {
    return {
      processes: Array.from(this.processes.entries()).map(([serial, process]) => ({
        serial,
        pid: process.pid,
        status: 'running'
      })),
      devices: deviceManager.list()
    };
  }
}

module.exports = new EmulatorManager();
