const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const deviceManager = require('../devices/deviceManager');
const logger = require('../logger');
const fs = require('fs');
const path = require('path');

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

  async cleanupAll() {
    const startTime = Date.now();
    const summary = {
      stopResults: [],
      processKills: [],
      cacheCleanup: { errors: [], paths: [], count: 0 },
      duration: 0
    };

    // Phase 1: Stop all registered emulators in parallel
    const stopPromises = [];
    const devices = deviceManager.list();
    
    for (const device of devices) {
      if (device.platform === 'android' && device.meta?.deviceId) {
        stopPromises.push(
          this.stopEmulator(device.meta.deviceId)
            .then(result => ({ deviceId: device.id, success: true, result }))
            .catch(error => ({ deviceId: device.id, success: false, error: error.message }))
        );
      }
    }

    if (stopPromises.length > 0) {
      const stopResults = await Promise.allSettled(stopPromises);
      summary.stopResults = stopResults.map(result => 
        result.status === 'fulfilled' ? result.value : { error: result.reason }
      );
    }

    // Phase 2: Kill all Android emulator processes in parallel
    const killPatterns = [
      ['pkill', ['-f', 'emulator64-crash-service']],
      ['pkill', ['-f', 'emulator-net']],
      ['pkill', ['-f', 'qemu-system-x86_64']],
      ['pkill', ['-f', 'qemu-system-i386']],
      ['pkill', ['-x', 'emulator']],
      ['pkill', ['-x', 'emulator64-arm']],
      ['pkill', ['-f', 'android-emulator']]
    ];

    const killPromises = killPatterns.map(([cmd, args]) => 
      new Promise((resolve) => {
        const proc = spawn(cmd, args, { stdio: 'pipe', timeout: 3000 });
        let stderr = '';
        
        proc.stderr.on('data', (d) => stderr += d.toString());
        
        proc.on('close', (code) => {
          resolve({ command: `${cmd} ${args.join(' ')}`, code, stderr: stderr.trim() });
        });
        
        proc.on('error', (err) => {
          resolve({ command: `${cmd} ${args.join(' ')}`, code: -1, stderr: String(err?.message || err) });
        });
        
        proc.on('timeout', () => {
          proc.kill('SIGKILL');
          resolve({ command: `${cmd} ${args.join(' ')}`, code: -1, stderr: 'Timeout' });
        });
      })
    );

    const killResults = await Promise.allSettled(killPromises);
    summary.processKills = killResults.map(result => 
      result.status === 'fulfilled' ? result.value : { error: result.reason }
    );

    // Phase 3: Force kill any remaining emulator processes
    try {
      const { stdout: psOutput } = await this.executeCommand('ps', ['aux']);
      const emulatorProcesses = psOutput
        .split('\n')
        .filter(line => line.includes('emulator') || line.includes('qemu'))
        .map(line => {
          const parts = line.trim().split(/\s+/);
          return {
            pid: parts[1],
            command: parts.slice(10).join(' ')
          };
        });

      const forceKillPromises = emulatorProcesses.map(({ pid, command }) =>
        new Promise((resolve) => {
          try {
            process.kill(pid, 'SIGKILL');
            resolve({ pid, command, killed: true });
          } catch (e) {
            resolve({ pid, command, killed: false, error: e.message });
          }
        })
      );

      const forceKillResults = await Promise.allSettled(forceKillPromises);
      summary.processKills.push(...forceKillResults.map(result => 
        result.status === 'fulfilled' ? result.value : { error: result.reason }
      ));
    } catch (e) {
      summary.processKills.push({ error: `Process enumeration failed: ${e.message}` });
    }

    // Phase 4: Clear Android emulator caches and temp files in parallel
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const cacheCleanupPromises = [];

    if (home) {
      const cachePaths = [
        path.join(home, '.android', 'avd'),
        path.join(home, '.android', 'cache'),
        path.join(home, '.android', 'breakpad'),
        '/tmp/android-*',
        '/tmp/emulator-*',
        '/tmp/qemu-*'
      ];

      for (const cachePath of cachePaths) {
        cacheCleanupPromises.push(
          new Promise((resolve) => {
            try {
              if (cachePath.startsWith('/tmp/')) {
                // Handle temp files with glob pattern
                const { spawn } = require('child_process');
                const proc = spawn('find', ['/tmp', '-maxdepth', '1', '-name', cachePath.split('/tmp/')[1], '-exec', 'rm', '-rf', '{}', '+']);
                
                proc.on('close', (code) => {
                  resolve({ path: cachePath, cleaned: code === 0, error: null });
                });
                
                proc.on('error', (err) => {
                  resolve({ path: cachePath, cleaned: false, error: err.message });
                });
              } else if (fs.existsSync(cachePath)) {
                // Handle directory cleanup
                const entries = fs.readdirSync(cachePath, { withFileTypes: true });
                let cleanedCount = 0;
                const errors = [];

                for (const entry of entries) {
                  const fullPath = path.join(cachePath, entry.name);
                  try {
                    if (entry.isDirectory()) {
                      // Only clean cache/data directories, not AVD definitions
                      if (!fullPath.endsWith('.ini') && !fullPath.includes('system-images')) {
                        fs.rmSync(fullPath, { recursive: true, force: true });
                        cleanedCount++;
                      }
                    } else {
                      // Remove cache files
                      if (fullPath.includes('.cache') || fullPath.includes('.lock') || fullPath.includes('.tmp')) {
                        fs.unlinkSync(fullPath);
                        cleanedCount++;
                      }
                    }
                  } catch (e) {
                    errors.push(`${fullPath}: ${e.message}`);
                  }
                }
                resolve({ path: cachePath, cleanedCount, errors });
              } else {
                resolve({ path: cachePath, cleanedCount: 0, errors: [] });
              }
            } catch (e) {
              resolve({ path: cachePath, cleanedCount: 0, errors: [e.message] });
            }
          })
        );
      }
    }

    // Execute all cache cleanup operations in parallel
    if (cacheCleanupPromises.length > 0) {
      const cacheResults = await Promise.allSettled(cacheCleanupPromises);
      cacheResults.forEach(result => {
        if (result.status === 'fulfilled') {
          const { path, cleanedCount, errors } = result.value;
          summary.cacheCleanup.paths.push(path);
          summary.cacheCleanup.count += cleanedCount || 0;
          summary.cacheCleanup.errors.push(...(errors || []));
        } else {
          summary.cacheCleanup.errors.push(result.reason);
        }
      });
    }

    // Phase 5: Clear device registry and state
    try {
      deviceManager.clear();
      const stateFiles = [
        path.join(__dirname, '../../.state'),
        path.join(__dirname, '../../devices.json'),
        path.join(__dirname, '../../registry.json')
      ];

      for (const stateFile of stateFiles) {
        try {
          if (fs.existsSync(stateFile)) {
            fs.rmSync(stateFile, { recursive: true, force: true });
            summary.cacheCleanup.paths.push(stateFile);
          }
        } catch (e) {
          summary.cacheCleanup.errors.push(`${stateFile}: ${e.message}`);
        }
      }
    } catch (e) {
      summary.cacheCleanup.errors.push(`Registry cleanup failed: ${e.message}`);
    }

    // Phase 6: Restart API via PM2
    try {
      const pm2Service = process.env.PM2_APP_NAME || 'android-emulator-api';
      logger.info(`Restarting PM2 service: ${pm2Service}`);
      
      const restartResult = await new Promise((resolve) => {
        const proc = spawn('pm2', ['restart', pm2Service], { stdio: 'pipe', timeout: 10000 });
        let stdout = '';
        let stderr = '';
        
        proc.stdout.on('data', (data) => stdout += data.toString());
        proc.stderr.on('data', (data) => stderr += data.toString());
        
        proc.on('close', (code) => {
          resolve({
            command: `pm2 restart ${pm2Service}`,
            code,
            stdout: stdout.trim(),
            stderr: stderr.trim()
          });
        });
        
        proc.on('error', (err) => {
          resolve({
            command: `pm2 restart ${pm2Service}`,
            code: -1,
            stdout: '',
            stderr: err.message
          });
        });
        
        proc.on('timeout', () => {
          proc.kill('SIGKILL');
          resolve({
            command: `pm2 restart ${pm2Service}`,
            code: -1,
            stdout: '',
            stderr: 'Timeout'
          });
        });
      });
      
      summary.pm2Restart = restartResult;
      
      if (restartResult.code === 0) {
        logger.info(`PM2 service ${pm2Service} restarted successfully`);
      } else {
        logger.error(`PM2 restart failed: ${restartResult.stderr}`);
      }
    } catch (e) {
      summary.pm2Restart = {
        command: 'pm2 restart android-emulator-api',
        code: -1,
        stdout: '',
        stderr: e.message
      };
      logger.error(`PM2 restart failed: ${e.message}`);
    }

    // Calculate total duration
    summary.duration = Date.now() - startTime;
    
    logger.info(`Android emulator cleanup completed in ${summary.duration}ms`);
    return summary;
  }

  async executeCommand(command, args = []) {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { stdio: 'pipe' });
      let output = '';
      let error = '';

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr.on('data', (data) => {
        error += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(`Command failed with code ${code}: ${error || 'Unknown error'}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
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
