// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('./src/logger');
const apiRouter = require('./src/routes/api');
const deviceService = require('./src/services/deviceService');

const app = express();
const PORT = process.env.PORT || 3000;

// Basic security & parsing
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Rate limiting (per IP)
const limiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
app.use(limiter);

// Request logging
app.use((req, res, next) => {
  logger.info({ method: req.method, url: req.url });
  next();
});

// Routes
app.use('/', apiRouter);

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Error handler
app.use((err, _req, res, _next) => {
  logger.error({ err }, 'Unhandled error');
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

// Start server
app.listen(PORT, async () => {
  logger.info(`Unified Mobile Emulator API running on http://localhost:${PORT}`);

  // The registry is in-memory, so a restart leaves any running emulator
  // orphaned - holding RAM that nothing tracks or can shut down.
  try {
    await deviceService.adoptOrphanEmulators();
  } catch (e) {
    logger.warn(`orphan adoption failed: ${e.message}`);
  }
});

app.use((err, req, res, next) => {
  console.error('Error:', err);

  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error'
  });
});