const express = require('express');
const router = express.Router();
const deviceService = require('../services/deviceService');
const actionService = require('../services/actionService');

router.get('/', (_req, res) => {
  res.json({ name: 'Unified Mobile Emulator API', status: 'ok' });
});

// Device Management
router.post('/devices/register', (req, res) => {
  try {
    const device = deviceService.register(req.body || {});
    res.json({ deviceId: device.id, device });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'register failed' });
  }
});

router.get('/devices', (_req, res) => {
  res.json({ devices: deviceService.list() });
});

router.post('/devices/:id/proxy', (req, res) => {
  try {
    const updated = deviceService.updateProxy(req.params.id, (req.body || {}).proxy);
    res.json({ ok: true, device: updated });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'proxy update failed' });
  }
});

// App control
router.post('/devices/:id/launch', async (req, res) => {
  try {
    const result = await actionService.launchApp(req.params.id, req.body || {});
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'launch failed' });
  }
});

router.post('/devices/:id/close', async (req, res) => {
  try {
    const result = await actionService.closeApp(req.params.id, req.body || {});
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'close failed' });
  }
});

// Global actions
router.post('/devices/:id/tap', async (req, res) => {
  try {
    const result = await actionService.tap(req.params.id, req.body || {});
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'tap failed' });
  }
});

router.post('/devices/:id/swipe', async (req, res) => {
  try {
    const result = await actionService.swipe(req.params.id, req.body || {});
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'swipe failed' });
  }
});

router.post('/devices/:id/type', async (req, res) => {
  try {
    const result = await actionService.type(req.params.id, req.body || {});
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'type failed' });
  }
});

router.post('/devices/:id/back', async (req, res) => {
  try {
    const result = await actionService.back(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'back failed' });
  }
});

router.post('/devices/:id/home', async (req, res) => {
  try {
    const result = await actionService.home(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'home failed' });
  }
});

router.post('/devices/:id/rotate', async (req, res) => {
  try {
    const result = await actionService.rotate(req.params.id, req.body || {});
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'rotate failed' });
  }
});

// Android intents (VIEW, navigation, geo, etc.)
router.post('/devices/:id/intent', async (req, res) => {
  try {
    const result = await actionService.intent(req.params.id, req.body || {});
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'intent failed' });
  }
});

// GPS
router.post('/devices/:id/gps/set', async (req, res) => {
  try {
    const result = await actionService.setGPS(req.params.id, req.body || {});
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'gps set failed' });
  }
});

router.post('/devices/:id/gps/route', async (req, res) => {
  try {
    const result = await actionService.simulateRoute(req.params.id, req.body || {});
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'route failed' });
  }
});

// Screenshot
router.post('/devices/:id/screenshot', async (req, res) => {
  try {
    const stream = await actionService.screenshotStream(req.params.id);
    res.setHeader('Content-Type', 'image/png');
    stream.pipe(res);
  } catch (e) {
    res.status(e.status || 501).json({ error: e.message || 'screenshot not implemented' });
  }
});

// MJPEG-like stream using repeated PNG frames
router.get('/devices/:id/stream', async (req, res) => {
  const boundary = 'frame';
  res.writeHead(200, {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`,
  });

  let running = true;
  const intervalMs = Math.max(200, Math.min(2000, Number(req.query.intervalMs) || 500));

  req.on('close', () => { running = false; });

  async function captureOnce() {
    // Get one PNG buffer by consuming the screenshot stream
    const stream = await actionService.screenshotStream(req.params.id);
    return new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  async function loop() {
    while (running) {
      try {
        const png = await captureOnce();
        res.write(`--${boundary}\r\n`);
        res.write('Content-Type: image/png\r\n');
        res.write(`Content-Length: ${png.length}\r\n\r\n`);
        res.write(png);
        res.write('\r\n');
      } catch (_) {
        // If capture fails, wait a bit and retry
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    try { res.end(); } catch (_) {}
  }

  loop();
});

module.exports = router;
