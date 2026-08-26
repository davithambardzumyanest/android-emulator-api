// UI hierarchy access.
//
// The old code wrote the dump to /sdcard, pulled it, read it from /tmp and
// unlinked it — four round trips per query, plus leftover files on the device.
// `exec-out uiautomator dump /dev/tty` streams the XML straight back in one.
// Results are cached briefly so a dialog check and a click can share a dump.
const { XMLParser } = require('fast-xml-parser');
const { adbBuffer, shell } = require('./adb');
const config = require('../config');
const logger = require('../logger');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  trimValues: false,
});

const cache = new Map(); // serial -> { at, xml }

function stripDumpFooter(text) {
  // uiautomator appends "UI hierchary dumped to: /dev/tty" (sic) after the XML.
  const end = text.lastIndexOf('</hierarchy>');
  if (end === -1) return text.trim();
  return text.slice(0, end + '</hierarchy>'.length).trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One dump attempt. Returns the XML, or '' plus the reason it failed. */
async function attemptDump(serial) {
  // Fast path: straight to stdout, one round trip.
  try {
    const out = await adbBuffer(serial, ['exec-out', 'uiautomator', 'dump', '/dev/tty'], { check: false });
    const text = out.toString('utf8');
    if (text.includes('<hierarchy')) return { xml: stripDumpFooter(text) };
    // uiautomator reports its own failures on stdout with exit code 0.
    const reported = /^ERROR:.*$/m.exec(text);
    if (reported) return { xml: '', reason: reported[0].trim() };
  } catch (e) {
    logger.debug({ serial, err: e.message }, 'exec-out uiautomator dump failed');
  }

  // Fallback for images where /dev/tty is not writable.
  const remote = '/data/local/tmp/window_dump.xml';
  const dumpOut = await shell(serial, ['uiautomator', 'dump', remote], { check: false });
  if (!/dumped to/i.test(dumpOut)) {
    // Do not `cat` a file the dump never wrote — that produced a confusing
    // "No such file or directory" instead of uiautomator's real complaint.
    const reported = /^ERROR:.*$/m.exec(dumpOut);
    return { xml: '', reason: reported ? reported[0].trim() : (dumpOut || 'uiautomator dump produced no output') };
  }

  const text = await shell(serial, ['cat', remote], { check: false });
  await shell(serial, ['rm', '-f', remote], { check: false });
  return text.includes('<hierarchy')
    ? { xml: stripDumpFooter(text) }
    : { xml: '', reason: 'dump file contained no hierarchy' };
}

/**
 * Fetch the current UI hierarchy as XML.
 *
 * uiautomator fails transiently and often — "null root node returned by
 * UiTestAutomationBridge" during animations, window transitions and while a
 * system overlay has focus — so a single attempt is retried before giving up.
 *
 * @param {string} serial
 * @param {{fresh?: boolean, retries?: number}} [opts] fresh:true bypasses the cache
 */
async function dumpXml(serial, { fresh = false, retries = 2 } = {}) {
  const cached = cache.get(serial);
  if (!fresh && cached && Date.now() - cached.at < config.adb.uiCacheMs) {
    return cached.xml;
  }

  let reason = 'unknown';
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await attemptDump(serial);
    if (result.xml) {
      cache.set(serial, { at: Date.now(), xml: result.xml });
      return result.xml;
    }
    reason = result.reason || reason;
    logger.debug({ serial, attempt: attempt + 1, reason }, 'UI dump retry');
    // eslint-disable-next-line no-await-in-loop
    if (attempt < retries) await sleep(400 * (attempt + 1));
  }

  const e = new Error(`Could not read UI hierarchy: ${reason}`);
  e.status = 503;
  e.retryable = true;
  throw e;
}

/** Drop the cached dump — call after any action that changes the screen. */
function invalidate(serial) {
  cache.delete(serial);
}

/**
 * Flatten the parsed hierarchy into a list of node attribute objects.
 * Each node gets a non-enumerable `parent` and `depth` so callers can walk
 * upwards — a label is very often a non-clickable child of the real target.
 */
function flatten(node, out = [], parent = null, depth = 0) {
  if (!node || typeof node !== 'object') return out;

  const isElement = node.bounds !== undefined || node.class !== undefined;
  if (isElement) {
    Object.defineProperty(node, 'parent', { value: parent, enumerable: false, configurable: true });
    Object.defineProperty(node, 'depth', { value: depth, enumerable: false, configurable: true });
    out.push(node);
  }

  const children = node.node;
  if (children) {
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) flatten(child, out, isElement ? node : parent, depth + 1);
  }
  return out;
}

/** Parse the dump into a flat node list. */
async function nodes(serial, opts) {
  const xml = await dumpXml(serial, opts);
  const parsed = parser.parse(xml);
  return flatten(parsed.hierarchy || parsed);
}

/**
 * Screen size in pixels.
 * Taken from the root node, which uiautomator sizes to the display. Using the
 * max over all nodes would grow the "screen" to include off-screen list items,
 * making everything look visible.
 */
function screenSize(list) {
  const root = list.find((node) => node.parent == null && parseBounds(node.bounds))
    || list.find((node) => parseBounds(node.bounds));
  const b = root ? parseBounds(root.bounds) : null;
  return b ? { width: b.x2, height: b.y2 } : { width: 0, height: 0 };
}

/** A node is usable only if it has real, on-screen area. */
function isVisible(node, screen) {
  const b = parseBounds(node.bounds);
  if (!b || b.width <= 0 || b.height <= 0) return false;
  if (b.x2 <= 0 || b.y2 <= 0) return false;
  if (screen.width && b.x1 >= screen.width) return false;
  if (screen.height && b.y1 >= screen.height) return false;
  return true;
}

/** Nearest ancestor (or self) that will actually accept a tap. */
function clickableAncestor(node, maxHops = 5) {
  let current = node;
  let hops = 0;
  while (current && hops <= maxHops) {
    if (current.clickable === 'true' && current.enabled !== 'false') return current;
    current = current.parent;
    hops += 1;
  }
  return null;
}

/** The first scrollable container on screen, if any. */
function scrollableContainer(list, screen) {
  const candidates = list.filter((n) => n.scrollable === 'true' && isVisible(n, screen));
  if (!candidates.length) return null;
  // Largest scrollable area is the one the user would swipe.
  return candidates.sort((a, b) => {
    const ba = parseBounds(a.bounds);
    const bb = parseBounds(b.bounds);
    return (bb.width * bb.height) - (ba.width * ba.height);
  })[0];
}

/** Parse an android `[x1,y1][x2,y2]` bounds string into a rect + centre. */
function parseBounds(bounds) {
  const m = /\[(-?\d+),(-?\d+)]\[(-?\d+),(-?\d+)]/.exec(String(bounds || ''));
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1, 5).map(Number);
  return {
    x1, y1, x2, y2,
    width: x2 - x1,
    height: y2 - y1,
    centerX: Math.floor((x1 + x2) / 2),
    centerY: Math.floor((y1 + y2) / 2),
  };
}

/**
 * Find nodes whose text or content-desc matches.
 * @param {object[]} list from nodes()
 * @param {{text:string, exact?:boolean, field?:'text'|'content-desc'|'any'}} query
 */
function match(list, { text, exact = false, field = 'any' }) {
  const needle = exact ? text : String(text).toLowerCase();
  const fields = field === 'any' ? ['text', 'content-desc'] : [field];

  return list.filter((node) => fields.some((key) => {
    const value = node[key];
    if (value === undefined || value === null || value === '') return false;
    const haystack = exact ? String(value) : String(value).toLowerCase();
    return exact ? haystack === needle : haystack.includes(needle);
  }));
}

module.exports = {
  dumpXml, invalidate, nodes, parseBounds, match, flatten,
  screenSize, isVisible, clickableAncestor, scrollableContainer,
};
