require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const config = require('./src/config');
const logger = require('./src/logger');
const apiRouter = require('./src/routes/api');
const deviceService = require('./src/services/deviceService');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // Behind nginx/PM2; needed for correct rate-limit keys.

app.use(helmet());
app.use(cors({ origin: config.security.corsOrigin === '*' ? true : config.security.corsOrigin.split(',') }));
app.use(express.json({ limit: '1mb' }));

// Malformed JSON should read as JSON, not an HTML error page.
app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ success: false, error: 'Invalid JSON body' });
  }
  return next(err);
});

/**
 * Rate limiting.
 * The screenshot stream holds one long-lived request, so it is exempt — the
 * old global limiter counted it once and then blocked nothing useful anyway.
 */
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.endsWith('/stream'),
}));

// Optional bearer token. This API can install apps, read the screen and run
// adb, so it should not sit open on a reachable interface.
if (config.security.apiToken) {
  app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/health') return next();
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-api-token');
    if (token !== config.security.apiToken) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    return next();
  });
} else {
  logger.warn('API_TOKEN is not set — every endpoint is unauthenticated');
}

// Request logging with status and duration, so slow calls are visible.
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger[res.statusCode >= 500 ? 'error' : 'info']({
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs),
    }, 'request');
  });
  next();
});

app.use('/', apiRouter);

app.use((req, res) => {
  res.status(404).json({ success: false, error: `Not Found: ${req.method} ${req.originalUrl}` });
});

// Single error handler. The previous file registered two — the second, added
// after app.listen(), could never run.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) logger.error({ err, url: req.originalUrl }, 'unhandled error');
  else logger.warn({ err: err.message, url: req.originalUrl }, 'request rejected');

  if (res.headersSent) return;

  res.status(status).json({
    success: false,
    error: err.message || 'Internal Server Error',
    // Selector failures carry diagnostics that make them actionable.
    ...(err.candidates ? { candidates: err.candidates } : {}),
    ...(err.visibleText ? { visibleText: err.visibleText } : {}),
    ...(process.env.NODE_ENV === 'development' && status >= 500 ? { stack: err.stack } : {}),
  });
});

const server = app.listen(config.port, () => {
  logger.info(`Unified Mobile Emulator API listening on http://localhost:${config.port}`);
});

// Keep long screenshot streams from being cut by the default 5s header timeout.
server.headersTimeout = 120000;
server.requestTimeout = 0;

/** Stop emulators before exiting so a restart does not leak qemu processes. */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  server.close();
  try {
    await deviceService.cleanupAll({ wipeNextStart: false });
  } catch (e) {
    logger.error({ err: e.message }, 'cleanup during shutdown failed');
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A rejection anywhere used to take the whole process down silently under PM2.
process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandled promise rejection'));
process.on('uncaughtException', (err) => logger.error({ err }, 'uncaught exception'));

module.exports = { app, server };
