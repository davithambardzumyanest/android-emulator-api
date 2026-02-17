const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const { PassThrough } = require('stream');
const execAsync = promisify(exec);

// Helper to run xcrun simctl commands with proper device placement
// Example: simctl('launch', { deviceId, args: [bundleId] }) =>
//   xcrun simctl launch <deviceId> <bundleId>
async function simctl(subcommand, { deviceId, args = [] } = {}) {
  const parts = ['xcrun', 'simctl', subcommand];
  if (deviceId) parts.push(deviceId);
  if (!Array.isArray(args)) args = [args];
  parts.push(...args.map(String));
  const full = parts.join(' ');
  const { stdout, stderr } = await execAsync(full);
  if (stderr && stderr.trim()) {
    if (/error|failed/i.test(stderr)) throw new Error(stderr.trim());
  }
  return stdout;
}

// Helper to run xcrun simctl commands that return binary data (e.g., screenshots)
// Uses spawn to avoid maxBuffer limits of exec when dealing with large PNGs.
async function simctlBinary(command, { deviceId } = {}) {
  // For binary commands we want to explicitly target a simulator via `io <device> ...`
  // Example: xcrun simctl io <deviceId> screenshot --type=png -
  const target = deviceId || 'booted';
  const args = ['simctl', 'io', target, ...String(command).split(' ')];
  return spawn('xcrun', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

module.exports = {
  async launchApp(device, appId) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }
    
    // Check if app is installed before trying to launch
    const isInstalled = await this.isAppInstalled(device, appId);
    if (!isInstalled) {
      // Provide helpful error message with alternatives
      let errorMsg = `App '${appId}' is not installed on this simulator.`;
      
      // Suggest alternatives for common apps
      if (appId === 'com.google.Maps') {
        errorMsg += '\n\nGoogle Maps is not pre-installed on iOS simulators. Options:\n';
        errorMsg += '1. Install Google Maps manually via App Store in the simulator\n';
        errorMsg += '2. Use Apple Maps instead (bundle ID: com.apple.Maps)\n';
        errorMsg += '3. Install Google Maps via .ipa/.app file using /devices/:id/apps/install endpoint';
      }
      
      const e = new Error(errorMsg);
      e.status = 404;
      e.code = 'APP_NOT_INSTALLED';
      throw e;
    }
    
    await simctl('launch', { deviceId, args: [appId] });
    return { ok: true };
  },

  async openUrl(device, url) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }
    if (typeof url !== 'string' || !url.trim()) {
      throw new Error('URL is required to open on iOS simulator');
    }
    await simctl('openurl', { deviceId, args: [url] });
    return { ok: true };
  },

  async closeApp(device, appId) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }
    await simctl('terminate', { deviceId, args: [appId] });
    return { ok: true };
  },

  async tap(device, { x, y }) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }
    // Vanilla simctl does not support tap; this requires additional tooling.
    throw new Error('tap is not implemented for iOS simulators using simctl alone');
  },

  async swipe(device, { x1, y1, x2, y2, durationMs = 300 }) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }
    // Vanilla simctl does not support swipe; this requires additional tooling.
    throw new Error('swipe is not implemented for iOS simulators using simctl alone');
  },

  async type(device, { text }) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }
    // Vanilla simctl does not provide generic text typing; this requires additional tooling.
    throw new Error('type is not implemented for iOS simulators using simctl alone');
  },

  async back(device) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }
    // There is no generic \"back\" key for iOS simulators via simctl.
    throw new Error('back is not implemented for iOS simulators using simctl');
  },

  async home(device) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }
    // Home button events via simctl are not exposed in this API yet.
    throw new Error('home is not implemented for iOS simulators using simctl');
  },

  async rotate(device, { orientation }) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }

    // Orientation control via simctl is not currently wired up.
    throw new Error('rotate is not implemented for iOS simulators using simctl');
  },

  async setGPS(device, { lat, lon }) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }
    // Newer simctl supports: xcrun simctl location <device> set <lat> <lon>
    await simctl('location', { deviceId, args: ['set', lat, lon] });
    return { ok: true };
  },

  async screenshotStream(device) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }

    // Capture PNG to stdout: xcrun simctl io <deviceId> screenshot --type=png -
    const proc = await simctlBinary('screenshot --type=png -', { deviceId });
    const stream = new PassThrough();
    
    proc.stdout.pipe(stream);
    
    proc.on('error', (err) => {
      stream.emit('error', err);
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        stream.emit('error', new Error(`simctl screenshot exited with code ${code}`));
      }
    });
    
    return stream;
  },

  /**
   * Check if an app is installed on the device by bundle ID.
   */
  async isAppInstalled(device, bundleId) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }
    if (!bundleId || typeof bundleId !== 'string') {
      throw new Error('Bundle ID is required');
    }

    try {
      const stdout = await simctl('listapps', { deviceId, args: ['--json'] });
      const apps = JSON.parse(stdout);
      return bundleId in apps;
    } catch (e) {
      return false;
    }
  },

  /**
   * Install an app from an .app bundle or .ipa file path.
   */
  async installApp(device, appPath) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }
    if (!appPath || typeof appPath !== 'string') {
      throw new Error('App path is required');
    }

    await simctl('install', { deviceId, args: [appPath] });
    return { ok: true };
  },

  /**
   * Execute an arbitrary xcrun simctl command for this device.
   * Command should be the subcommand and arguments.
   * For commands that require a device ID (like launch, openurl, etc.), the device ID is automatically injected.
   * For commands that don't require a device ID (like list, create, etc.), the device ID is not injected.
   * Example: executeCommand(device, "launch com.apple.mobilesafari")
   *          => xcrun simctl launch <deviceId> com.apple.mobilesafari
   * Example: executeCommand(device, "list devices")
   *          => xcrun simctl list devices
   */
  async executeCommand(device, command) {
    const deviceId = device?.meta?.deviceId;
    if (!deviceId) {
      throw new Error('iOS device ID is required');
    }
    if (typeof command !== 'string' || !command.trim()) {
      throw new Error('command is required and must be a non-empty string');
    }

    // Parse command into subcommand and args
    const parts = command.trim().split(/\s+/);
    const subcommand = parts[0];
    const args = parts.slice(1);

    // Commands that don't require a device ID (device ID should not be injected)
    const commandsWithoutDeviceId = [
      'list', 'create', 'delete', 'erase', 'clone', 'rename', 'pair', 'unpair',
      'addmedia', 'getappcontainer', 'getenv', 'setenv', 'unsetenv', 'spawn',
      'terminate', 'install', 'uninstall', 'upgrade', 'shutdown', 'boot',
      'bootstatus', 'logverbose', 'log', 'privacy', 'keychain', 'pbs', 'ui',
      'io', 'status_bar', 'notifications', 'push', 'recordvideo', 'recordaudio',
      'screenshot', 'get_app_container', 'getenv', 'setenv', 'unsetenv'
    ];

    // If command doesn't require device ID, execute without injecting device ID
    if (commandsWithoutDeviceId.includes(subcommand)) {
      const fullCommand = ['xcrun', 'simctl', subcommand, ...args].join(' ');
        console.log(fullCommand)
      const { stdout, stderr } = await execAsync(fullCommand);
      if (stderr && stderr.trim()) {
        if (/error|failed/i.test(stderr)) throw new Error(`Command failed: ${fullCommand}\n${stderr.trim()}`);
      }
      return { ok: true, stdout: stdout.trim() };
    }

    // For commands that require device ID, inject it after the subcommand
    const stdout = await simctl(subcommand, { deviceId, args });
    return { ok: true, stdout: stdout.trim() };
  },
};
