const sharp = require('sharp');

// adb screencap only produces PNG. Re-encoding to JPEG at 70 is several times
// smaller and still readable, so it is the default.
const DEFAULT_TYPE = 'jpeg';
const DEFAULT_QUALITY = 70;
const TYPE_ALIASES = { png: 'png', jpeg: 'jpeg', jpg: 'jpeg', webp: 'webp' };

// Returns { type, quality } or throws an error with status 400.
function parseScreenshotOptions({ type = DEFAULT_TYPE, quality = DEFAULT_QUALITY } = {}) {
  const format = TYPE_ALIASES[String(type).toLowerCase()];
  if (!format) {
    const e = new Error(`type must be one of: png, jpeg, webp (got "${type}")`);
    e.status = 400;
    throw e;
  }

  const q = Number(quality);
  if (!Number.isFinite(q) || q < 1 || q > 100) {
    const e = new Error(`quality must be a number from 1 to 100 (got "${quality}")`);
    e.status = 400;
    throw e;
  }

  return { type: format, quality: Math.round(q) };
}

// Returns { buffer, type }. `fast` skips mozjpeg (~6x faster, ~30% bigger) for streaming.
// Flat screens (blank home screen, solid dialogs) can compress better as PNG,
// so the original PNG is kept whenever it is smaller.
async function encodeScreenshot(pngBuffer, { type, quality }, { fast = false } = {}) {
  if (type === 'png') return { buffer: pngBuffer, type: 'png' };
  const image = sharp(pngBuffer);
  const buffer = type === 'webp'
    ? await image.webp({ quality }).toBuffer()
    : await image.jpeg({ quality, mozjpeg: !fast }).toBuffer();
  return buffer.length < pngBuffer.length ? { buffer, type } : { buffer: pngBuffer, type: 'png' };
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

module.exports = { parseScreenshotOptions, encodeScreenshot, streamToBuffer };
