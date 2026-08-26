// Emulator console port allocation.
//
// The previous code picked `5555 + random*2` from a 16-slot range and checked
// nothing. Two concurrent registrations could draw the same port, and a draw
// could land on a port an already-running emulator held — in both cases the
// second emulator fails to start while the API still hands back its serial.
//
// (Those ports were odd. Current emulator builds accept an odd console port,
// so that alone was not the defect; the missing collision check was. Even
// ports are used here because they are the documented convention and adb
// takes the port above for its channel.)
const net = require('net');
const config = require('../config');
const { listEmulators } = require('./adb');

// Ports handed out in this process but whose emulator has not appeared in
// `adb devices` yet.
const reserved = new Set();

function isFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Find the lowest free even console port.
 * @param {Set<number>} [busy] extra ports to skip
 */
async function allocate(busy = new Set()) {
  const { min, max } = config.emulator.portRange;

  const inUse = new Set(busy);
  for (const serial of await listEmulators()) {
    const port = Number(serial.split('-')[1]);
    if (Number.isFinite(port)) inUse.add(port);
  }

  for (let port = min; port <= max; port += 2) {
    if (inUse.has(port) || reserved.has(port)) continue;
    // The emulator needs both the console port and the adb port above it.
    /* eslint-disable no-await-in-loop */
    if (!(await isFree(port)) || !(await isFree(port + 1))) continue;
    /* eslint-enable no-await-in-loop */
    reserved.add(port);
    return port;
  }

  const e = new Error(`No free emulator port in ${min}-${max}`);
  e.status = 503;
  throw e;
}

function release(port) {
  reserved.delete(port);
}

module.exports = { allocate, release };
