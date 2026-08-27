const express = require('express');

const deviceService = require('../services/deviceService');
const emulatorService = require('../services/emulatorService');
const actionService = require('../services/actionService');
const navigationService = require('../services/navigationService');
const config = require('../config');
const logger = require('../logger');

const router = express.Router();

/**
 * Wrap an async handler so a rejection reaches the error middleware.
 * Every route previously repeated the same try/catch and mapped errors
 * inconsistently (`e.status || 501` on screenshot, bare 500 elsewhere).
 */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

router.get('/', (_req, res) => {
  res.json({
    name: 'Unified Mobile Emulator API',
    status: 'ok',
    devices: deviceService.list().length,
    emulators: emulatorService.status().running.length,
  });
});

/** Detailed health, including what adb can actually see. */
router.get('/health', wrap(async (_req, res) => {
  const running = await deviceService.runningEmulators();
  res.json({
    status: 'ok',
    uptimeSec: Math.round(process.uptime()),
    registeredDevices: deviceService.list().length,
    managedEmulators: emulatorService.status().running,
    adbEmulators: running,
    profile: config.device.profile,
    quickBoot: config.emulator.quickBoot,
  });
}));

// --- Inventory -------------------------------------------------------------

router.get('/avds', wrap(async (_req, res) => res.json({ avds: deviceService.listAvds() })));
router.get('/profiles', (_req, res) => res.json({ profiles: deviceService.listProfiles(), active: config.device.profile }));

/** Apply a realistic hardware profile to an AVD without booting it. */
router.post('/avds/:avd/profile', wrap(async (req, res) => {
  const result = deviceService.applyProfile(req.params.avd, (req.body || {}).profile);
  res.json({ success: true, ...result });
}));

// --- Device lifecycle ------------------------------------------------------

router.post('/devices/register', wrap(async (req, res) => {
  const device = await deviceService.register(req.body || {});
  res.json({
    success: true,
    deviceId: device.id,
    platform: device.platform,
    status: device.status,
    serial: device.meta.deviceId || null,
    emulator: device.meta.emulator || null,
    identity: device.meta.identity || null,
    profile: device.meta.profile || null,
    registeredAt: device.createdAt,
  });
}));

router.get('/devices', (_req, res) => res.json({ devices: deviceService.list() }));

router.get('/devices/:id', wrap(async (req, res) => res.json({ device: deviceService.getOrThrow(req.params.id) })));

router.delete('/devices/:id', wrap(async (req, res) => res.json(await deviceService.unregister(req.params.id))));

router.post('/devices/:id/proxy', wrap(async (req, res) => {
  res.json({ ok: true, ...(await deviceService.updateProxy(req.params.id, (req.body || {}).proxy)) });
}));

// --- App control -----------------------------------------------------------

router.post('/devices/:id/launch', wrap(async (req, res) => res.json(await actionService.launchApp(req.params.id, req.body || {}))));
router.post('/devices/:id/close', wrap(async (req, res) => res.json(await actionService.closeApp(req.params.id, req.body || {}))));

// --- Input -----------------------------------------------------------------

router.post('/devices/:id/tap', wrap(async (req, res) => res.json(await actionService.tap(req.params.id, req.body || {}))));
router.post('/devices/:id/swipe', wrap(async (req, res) => res.json(await actionService.swipe(req.params.id, req.body || {}))));
router.post('/devices/:id/type', wrap(async (req, res) => res.json(await actionService.type(req.params.id, req.body || {}))));
router.post('/devices/:id/back', wrap(async (req, res) => res.json(await actionService.back(req.params.id))));
router.post('/devices/:id/home', wrap(async (req, res) => res.json(await actionService.home(req.params.id))));
router.post('/devices/:id/rotate', wrap(async (req, res) => res.json(await actionService.rotate(req.params.id, req.body || {}))));

// --- Element interaction ---------------------------------------------------

router.post('/devices/:id/click-by-text', wrap(async (req, res) => res.json(await actionService.clickByText(req.params.id, req.body || {}))));
router.post('/devices/:id/wait-for-text', wrap(async (req, res) => res.json(await actionService.waitForText(req.params.id, req.body || {}))));
router.post('/devices/:id/find', wrap(async (req, res) => res.json(await actionService.findElements(req.params.id, req.body || {}))));
router.post('/devices/:id/type-into', wrap(async (req, res) => res.json(await actionService.typeInto(req.params.id, req.body || {}))));

router.get('/devices/:id/pageinfo', wrap(async (req, res) => res.json(await actionService.getCurrentPageInfo(req.params.id))));

// --- Raw adb ---------------------------------------------------------------

router.post('/devices/:id/adb', wrap(async (req, res) => {
  if (!config.security.allowRawAdb) {
    // Arbitrary adb is remote code execution on the host's device. Opt in.
    return res.status(403).json({ success: false, error: 'Raw adb is disabled. Set ALLOW_RAW_ADB=true to enable.' });
  }
  const { command } = req.body || {};
  if (!command || (typeof command === 'string' && command.trim() === '')) {
    return res.status(400).json({ success: false, error: "'command' is required" });
  }
  const result = await deviceService.executeAdb(req.params.id, command);
  return res.json({ success: true, ...result });
}));

router.post('/devices/:id/intent', wrap(async (req, res) => res.json(await actionService.intent(req.params.id, req.body || {}))));

// --- Location --------------------------------------------------------------

router.post('/devices/:id/gps/set', wrap(async (req, res) => res.json(await actionService.setGPS(req.params.id, req.body || {}))));

/** Read back what Android reports, to verify a fix actually landed. */
router.get('/devices/:id/gps', wrap(async (req, res) => res.json(await actionService.getLocation(req.params.id))));
router.post('/devices/:id/gps/route', wrap(async (req, res) => res.json(await actionService.simulateRoute(req.params.id, req.body || {}))));
router.get('/devices/:id/gps/route', wrap(async (req, res) => res.json(actionService.listRoutes(req.params.id))));
router.delete('/devices/:id/gps/route/:taskId', wrap(async (req, res) => res.json(actionService.stopRoute(req.params.id, req.params.taskId))));

router.post('/devices/:id/navigate', wrap(async (req, res) => {
  res.json(await navigationService.navigate({ ...(req.body || {}), deviceId: req.params.id }));
}));

// --- Capture ---------------------------------------------------------------

router.post('/devices/:id/screenshot', wrap(async (req, res) => {
  // Buffered rather than piped: piping meant a mid-stream failure tried to set
  // a status code after the headers had already gone out.
  const png = await actionService.screenshot(req.params.id);
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Length', png.length);
  res.end(png);
}));

router.get('/devices/:id/screenshot', wrap(async (req, res) => {
  const png = await actionService.screenshot(req.params.id);
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Length', png.length);
  res.end(png);
}));

/** MJPEG-style stream of PNG frames. */
router.get('/devices/:id/stream', (req, res) => {
  const boundary = 'frame';
  const intervalMs = Math.max(200, Math.min(5000, Number(req.query.intervalMs) || 500));

  res.writeHead(200, {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    Connection: 'close',
    'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`,
  });

  let running = true;
  const stop = () => { running = false; };
  req.on('close', stop);
  res.on('error', stop);

  (async () => {
    let consecutiveFailures = 0;

    while (running && !res.writableEnded) {
      const startedAt = Date.now();
      try {
        const png = await actionService.screenshot(req.params.id);
        consecutiveFailures = 0;

        // Stop if the client vanished while we were capturing.
        if (!running || res.writableEnded) break;

        res.write(`--${boundary}\r\nContent-Type: image/png\r\nContent-Length: ${png.length}\r\n\r\n`);
        // Respect backpressure: without this a slow client makes frames pile
        // up in memory until the process runs out of heap.
        if (!res.write(png)) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
        res.write('\r\n');
      } catch (e) {
        consecutiveFailures += 1;
        logger.warn({ deviceId: req.params.id, err: e.message, consecutiveFailures }, 'stream frame failed');
        if (consecutiveFailures >= 5) break;
      }

      const elapsed = Date.now() - startedAt;
      if (running) await new Promise((resolve) => setTimeout(resolve, Math.max(0, intervalMs - elapsed)));
    }

    if (!res.writableEnded) res.end();
  })().catch((e) => {
    logger.error({ deviceId: req.params.id, err: e.message }, 'stream loop crashed');
    if (!res.writableEnded) res.end();
  });
});

// --- Maintenance -----------------------------------------------------------

router.post('/cleanup', wrap(async (req, res) => {
  const wipeNextStart = (req.body || {}).wipeNextStart !== false;
  const summary = await deviceService.cleanupAll({ wipeNextStart });
  res.json({ success: true, ...summary });
}));

module.exports = router;
