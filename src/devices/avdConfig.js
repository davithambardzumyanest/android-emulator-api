// Read and patch AVD config.ini files.
//
// The emulator only honours a subset of hardware settings from the command
// line; screen geometry, density, sensors and RAM come from the AVD's
// config.ini. Applying a profile there is what actually makes the guest look
// like the phone it claims to be.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const profiles = require('./profiles');
const logger = require('../logger');

function avdDir(avdName) {
  return path.join(config.android.avdHome, `${avdName}.avd`);
}

function configPath(avdName) {
  return path.join(avdDir(avdName), 'config.ini');
}

/** Parse a `key = value` ini into a plain object, preserving nothing else. */
function read(avdName) {
  const file = configPath(avdName);
  if (!fs.existsSync(file)) {
    const e = new Error(`AVD '${avdName}' not found at ${file}`);
    e.status = 404;
    throw e;
  }
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function write(avdName, values) {
  const file = configPath(avdName);
  const body = Object.keys(values)
    .sort()
    .map((key) => `${key} = ${values[key]}`)
    .join('\n');
  fs.writeFileSync(file, `${body}\n`, 'utf8');
}

/** List AVD names present on this host. */
function list() {
  if (!fs.existsSync(config.android.avdHome)) return [];
  return fs.readdirSync(config.android.avdHome, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.avd'))
    .map((entry) => entry.name.slice(0, -'.avd'.length))
    .filter((name) => fs.existsSync(configPath(name)));
}

/**
 * Build the hardware settings a realistic handset would report.
 * Anything not listed here is left untouched.
 */
function hardwareSettings(profile) {
  const { screen, ramMb, heapMb, cores, sdcardMb, dataPartitionMb, hardware } = profile;

  const settings = {
    // --- Panel -------------------------------------------------------------
    'hw.lcd.width': String(screen.width),
    'hw.lcd.height': String(screen.height),
    'hw.lcd.density': String(screen.density),
    // 16-bit colour is an emulator-only artefact; every real panel is 32-bit.
    'hw.lcd.depth': '32',
    'hw.lcd.vsync': '60',
    'hw.initialOrientation': 'portrait',

    // --- Compute -----------------------------------------------------------
    'hw.ramSize': String(ramMb),
    'vm.heapSize': String(heapMb),
    'hw.cpu.ncore': String(cores),

    // --- Storage -----------------------------------------------------------
    'sdcard.size': `${sdcardMb}M`,
    'disk.dataPartition.size': `${dataPartitionMb}M`,
    'userdata.useQcow2': 'yes',

    // --- Peripherals a modern phone has ------------------------------------
    // Gesture navigation, no hardware keys, no d-pad, no trackball.
    'hw.mainKeys': 'no',
    'hw.dPad': 'no',
    'hw.trackBall': 'no',
    'hw.keyboard': 'yes',
    'hw.screen': 'multi-touch',
    'hw.battery': 'yes',
    'hw.gps': 'yes',
    'hw.gsmModem': 'yes',
    'hw.sdCard': 'yes',
    'hw.audioInput': 'yes',
    'hw.audioOutput': 'yes',
    'hw.camera.back': 'virtualscene',
    'hw.camera.front': 'emulated',

    // --- Sensors -----------------------------------------------------------
    'hw.accelerometer': 'yes',
    'hw.accelerometer_uncalibrated': 'yes',
    'hw.gyroscope': 'yes',
    'hw.sensors.gyroscope_uncalibrated': 'yes',
    'hw.sensors.magnetic_field': 'yes',
    'hw.sensors.magnetic_field_uncalibrated': 'yes',
    'hw.sensors.orientation': 'yes',
    'hw.sensors.proximity': 'yes',
    'hw.sensors.light': 'yes',
    'hw.sensors.pressure': 'yes',
    'hw.sensors.humidity': 'no',
    'hw.sensors.temperature': 'no',
    'hw.sensors.heading': 'yes',

    // --- GPU ---------------------------------------------------------------
    'hw.gpu.enabled': 'yes',
    'hw.gpu.mode': config.emulator.gpu,

    // --- Radio -------------------------------------------------------------
    // The emulator default (unlimited, zero latency) is not a mobile link.
    'runtime.network.speed': config.emulator.netProfile === 'fast' ? 'full' : 'lte',
    'runtime.network.latency': config.emulator.netProfile === 'fast' ? 'none' : 'umts',

    'showDeviceFrame': 'no',
    'skin.dynamic': 'yes',
  };

  if (hardware.name) {
    settings['hw.device.name'] = hardware.name;
    settings['hw.device.manufacturer'] = hardware.manufacturer;
  }

  return settings;
}

/**
 * Apply a profile to an AVD's config.ini.
 * @returns {{avd:string, profile:string, changed:object, unchanged:number}}
 */
function applyProfile(avdName, profileName = config.device.profile) {
  const profile = profiles.get(profileName);
  if (!profile) {
    const e = new Error(`Unknown device profile '${profileName}'. Known: ${profiles.list().map((p) => p.id).join(', ')}`);
    e.status = 400;
    throw e;
  }

  const current = read(avdName);
  const desired = hardwareSettings(profile);
  const changed = {};

  for (const [key, value] of Object.entries(desired)) {
    if (current[key] !== value) {
      changed[key] = { from: current[key] ?? null, to: value };
      current[key] = value;
    }
  }

  // `hw.device.hash2` pins the config to a stock device definition; leaving a
  // stale hash in place makes Studio silently restore the old geometry.
  if (Object.keys(changed).length && current['hw.device.hash2']) {
    delete current['hw.device.hash2'];
    changed['hw.device.hash2'] = { from: 'stale', to: null };
  }

  if (Object.keys(changed).length) {
    write(avdName, current);
    logger.info({ avd: avdName, profile: profileName, changed: Object.keys(changed).length }, 'AVD profile applied');
  }

  return {
    avd: avdName,
    profile: profileName,
    label: profile.label,
    changed,
    unchanged: Object.keys(desired).length - Object.keys(changed).length,
  };
}

/** Boot properties to pass as `-prop name=value`. */
function bootProps(profileName = config.device.profile) {
  const profile = profiles.get(profileName);
  return profile ? { ...profile.props } : {};
}

module.exports = { read, write, list, applyProfile, bootProps, hardwareSettings, configPath, avdDir };
