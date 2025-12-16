const deviceManager = require('../devices/deviceManager');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');

const deviceService = {
  async register(payload) {
    const { platform, proxy, meta = {}, avd } = payload || {};
    
    if (!platform || !['android', 'ios'].includes(platform)) {
      const e = new Error("'platform' must be 'android' or 'ios'");
      e.status = 400;
      throw e;
    }

    // If it's an Android device and no deviceId is provided, create an emulator
    if (platform === 'android' && !meta.deviceId) {
      const emulatorName = `emulator-${uuidv4().substring(0, 8)}`;
      const port = 5554 + Math.floor(Math.random() * 100); // Random port between 5554-5654
      
      // Create AVD (Android Virtual Device)
      // await this.executeCommand('avdmanager', [
      //   'create', 'avd',
      //   '-n', emulatorName,
      //   '-k', 'system-images;android-33;google_apis;x86_64',
      //   '--force'
      // ]);

      // Start the emulator
      const emulatorProcess = await this.startEmulator(avd, port, proxy);
      
      // Update meta with emulator details
      meta.emulator = {
        name: emulatorName,
        port,
        pid: emulatorProcess.pid,
        command: emulatorProcess.spawnargs.join(' ')
      };
      meta.deviceId = `emulator-${port}`;
    }

    return deviceManager.register({ platform, proxy, meta });
  },

  executeCommand(command, args = []) {
    return new Promise((resolve, reject) => {
      const cmd = spawn(command, args, { stdio: 'pipe' });
      let output = '';
      let error = '';

      cmd.stdout.on('data', (data) => {
        output += data.toString();
        logger.debug(`[${command}] ${data}`.trim());
      });

      cmd.stderr.on('data', (data) => {
        error += data.toString();
        logger.error(`[${command} ERROR] ${data}`.trim());
      });

      cmd.on('close', (code) => {
        if (code === 0) {
          resolve({ output, error });
        } else {
          reject(new Error(`Command failed with code ${code}: ${error || 'Unknown error'}`));
        }
      });
    });
  },

  async startEmulator(avdName, port, proxy) {
    const args = [
      '-avd', avdName,
      '-port', String(port),
      '-no-snapshot',
      '-no-audio',
      '-no-boot-anim',
      '-gpu', 'swiftshader_indirect',
      '-memory', '4096',
      '-cores', '2',
      '-netfast'
    ];

    if (proxy) {
      args.push('-http-proxy', proxy);
    }

    const emulatorProcess = spawn('emulator', args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Log emulator output
    emulatorProcess.stdout.on('data', (data) => {
      logger.info(`[Emulator ${avdName}] ${data}`.trim());
    });

    emulatorProcess.stderr.on('data', (data) => {
      logger.error(`[Emulator ${avdName} ERROR] ${data}`.trim());
    });

    return emulatorProcess;
  },

  list() {
    return deviceManager.list();
  },

  getOrThrow(id) {
    const d = deviceManager.get(id);
    if (!d) {
      const e = new Error('Device not found');
      e.status = 404;
      throw e;
    }
    return d;
  },

  updateProxy(id, proxy) {
    if (!proxy) {
      const e = new Error("'proxy' is required");
      e.status = 400;
      throw e;
    }
    const updated = deviceManager.update(id, { proxy });
    if (!updated) {
      const e = new Error('Device not found');
      e.status = 404;
      throw e;
    }
    return updated;
  },

  /**
   * Execute an adb command targeted at the correct emulator for a device UUID.
   * @param {string} id Device UUID stored by deviceManager
   * @param {string|string[]} command e.g. "shell pm grant com.pkg android.permission.ACCESS_FINE_LOCATION"
   * @returns {Promise<{stdout: string, stderr: string}>}
   */
  async executeAdb(id, command) {
    const device = this.getOrThrow(id);

    const serial = device?.meta?.deviceId
      || (device?.meta?.emulator?.port ? `emulator-${device.meta.emulator.port}` : null);

    if (!serial) {
      const e = new Error('Emulator serial not found for device');
      e.status = 400;
      throw e;
    }

    const parts = Array.isArray(command)
      ? command
      : String(command || '').trim().split(/\s+/).filter(Boolean);

    if (parts.length === 0) {
      const e = new Error("'command' is required");
      e.status = 400;
      throw e;
    }

    const args = ['-s', serial, ...parts];
    logger.debug(`Executing: adb ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      const proc = spawn('adb', args, { stdio: 'pipe' });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (err) => {
        reject(err);
      });
      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        } else {
          const err = new Error(`ADB command failed (${code}): ${stderr.trim() || 'Unknown error'}`);
          err.status = 500;
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        }
      });
    });
  },
  /**
   * Stop all emulators and clear device registry.
   * For each Android device: try to disable animations, then stop emulator.
   */
  async stopAllEmulators() {
    const devices = this.list();
    const results = [];

    for (const d of devices) {
      if (d.platform !== 'android') continue;

      const serial = d?.meta?.deviceId || (d?.meta?.emulator?.port ? `emulator-${d.meta.emulator.port}` : null);
      const pid = d?.meta?.emulator?.pid;
      const entry = { deviceId: d.id, serial, pid, stopped: false, errors: [] };

      // Best-effort: disable animations before shutdown (may fail if not booted)
      if (serial) {
        try { await this.executeAdb(d.id, ['shell', 'settings', 'put', 'global', 'window_animation_scale', '0']); }
        catch (e) { entry.errors.push(`disable window_animation_scale: ${e.message}`); }
        try { await this.executeAdb(d.id, ['shell', 'settings', 'put', 'global', 'transition_animation_scale', '0']); }
        catch (e) { entry.errors.push(`disable transition_animation_scale: ${e.message}`); }
        try { await this.executeAdb(d.id, ['shell', 'settings', 'put', 'global', 'animator_duration_scale', '0']); }
        catch (e) { entry.errors.push(`disable animator_duration_scale: ${e.message}`); }
      }

      // Try graceful shutdown first
      if (serial) {
        try {
          await this.executeAdb(d.id, ['emu', 'kill']);
          entry.stopped = true;
        } catch (e) {
          entry.errors.push(`adb emu kill: ${e.message}`);
        }
      }

      // Fallback: kill by PID
      if (!entry.stopped && typeof pid === 'number') {
        try {
          process.kill(pid, 'SIGKILL');
          entry.stopped = true;
        } catch (e) {
          entry.errors.push(`kill ${pid}: ${e.message}`);
        }
      }

      results.push(entry);
    }

    // Clear device registry
    try { deviceManager.clear(); } catch (_) {}

    return { results };
  },
  /**
   * Cleanup all emulators and related processes system-wide.
   * 1) Stop all known emulators from the registry (graceful, then force by PID)
   * 2) Best-effort kill any leftover emulator/qemu processes
   * 3) Kill adb server to release ports
   */
  async cleanupAll() {
    const summary = { stopResults: [], processKills: [], adbKill: null };
    try {
      const stopped = await this.stopAllEmulators();
      summary.stopResults = stopped.results || [];
    } catch (e) {
      summary.stopResults = [{ error: `stopAllEmulators failed: ${e.message}` }];
    }

    // Helper to run a command and ignore failures
    async function trySpawn(command, args) {
      return new Promise((resolve) => {
        const proc = spawn(command, args, { stdio: 'pipe' });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
          resolve({ command: `${command} ${args.join(' ')}`, code, stderr: stderr.trim() });
        });
        proc.on('error', (err) => {
          resolve({ command: `${command} ${args.join(' ')}`, code: -1, stderr: String(err?.message || err) });
        });
      });
    }

    // Kill common Android emulator processes that might remain
    const killPatterns = [
      ['pkill', ['-f', 'emulator']],
      ['pkill', ['-f', 'qemu-system-']],
    ];
    for (const [cmd, args] of killPatterns) {
      // eslint-disable-next-line no-await-in-loop
      const res = await trySpawn(cmd, args);
      summary.processKills.push(res);
    }

    // Kill adb server to release any lingering connections/ports
    summary.adbKill = await trySpawn('adb', ['kill-server']);

    return summary;
  },
};

module.exports = deviceService;
