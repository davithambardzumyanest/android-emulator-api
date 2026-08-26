// Element location and interaction.
//
// The old clickByText took the first XML node whose `text` attribute matched,
// tapped its centre and hoped. It failed whenever:
//   - the label was a non-clickable TextView inside a clickable row;
//   - the element was described by content-desc instead of text (icons);
//   - the screen had not finished rendering yet (dump taken too early);
//   - the element was below the fold and needed a scroll;
//   - the text differed only by case, padding or a non-breaking space;
//   - several nodes matched and index 0 was the off-screen one.
//
// This module addresses each of those: normalise, score, wait, scroll, then
// tap the nearest ancestor that actually accepts input.
const ui = require('./ui');
const { shell } = require('./adb');
const logger = require('../logger');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Collapse whitespace variants (incl. NBSP) and case for tolerant matching. */
function normalize(value) {
  return String(value ?? '')
    .replace(/[   ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const SEARCH_FIELDS = ['text', 'content-desc', 'resource-id', 'hint'];

/**
 * Score how well a node matches. Higher is better; null means no match.
 * The ranking is what stops "Send" from selecting "Resend" when both exist.
 */
function scoreNode(node, { needle, exact, fields, screen }) {
  let best = null;

  for (const field of fields) {
    const raw = node[field];
    if (raw === undefined || raw === null || raw === '') continue;

    // resource-id matches on the trailing id, so callers can pass 'login_button'
    // instead of 'com.example.app:id/login_button'.
    const value = field === 'resource-id'
      ? normalize(String(raw).split('/').pop())
      : normalize(raw);

    let score = null;
    if (value === needle) score = 100;
    else if (!exact && value.startsWith(needle)) score = 70;
    else if (!exact && value.endsWith(needle)) score = 60;
    else if (!exact && value.includes(needle)) score = 50;
    if (score === null) continue;

    // Prefer the visible label a user would read over an internal id.
    if (field === 'text') score += 12;
    else if (field === 'content-desc') score += 8;
    else if (field === 'hint') score += 2;

    // Penalise long strings that merely contain the needle.
    if (score < 100 && value.length > needle.length * 3) score -= 10;

    best = best === null ? score : Math.max(best, score);
  }

  if (best === null) return null;

  if (node.clickable === 'true') best += 15;
  else if (ui.clickableAncestor(node)) best += 8;

  if (node.enabled === 'false') best -= 40;
  if (node['long-clickable'] === 'true') best += 2;

  const bounds = ui.parseBounds(node.bounds);
  if (!bounds) return null;

  if (!ui.isVisible(node, screen)) best -= 60;
  // Fully off-screen vertically: only reachable after a scroll.
  if (screen.height && (bounds.y1 >= screen.height || bounds.y2 <= 0)) best -= 40;

  return best;
}

/**
 * Rank every match on the current screen.
 * @returns {Array<{node:object, score:number, bounds:object, target:object, visible:boolean}>}
 */
function rank(nodeList, { text, exact = false, field = 'any', className }) {
  const needle = normalize(text);
  const fields = field === 'any' ? SEARCH_FIELDS : [field];
  const screen = ui.screenSize(nodeList);

  const results = [];
  for (const node of nodeList) {
    if (className && !String(node.class || '').includes(className)) continue;

    const score = scoreNode(node, { needle, exact, fields, screen });
    if (score === null) continue;

    const target = ui.clickableAncestor(node) || node;
    const bounds = ui.parseBounds(target.bounds) || ui.parseBounds(node.bounds);
    if (!bounds) continue;

    results.push({ node, target, score, bounds, visible: ui.isVisible(node, screen) });
  }

  // Deduplicate: several labels can resolve to the same clickable row.
  const byTarget = new Map();
  for (const result of results) {
    const key = `${result.bounds.x1},${result.bounds.y1},${result.bounds.x2},${result.bounds.y2}`;
    const existing = byTarget.get(key);
    if (!existing || result.score > existing.score) byTarget.set(key, result);
  }

  return [...byTarget.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Stable, human order for equal scores: top-to-bottom, left-to-right.
    if (a.bounds.y1 !== b.bounds.y1) return a.bounds.y1 - b.bounds.y1;
    return a.bounds.x1 - b.bounds.x1;
  });
}

/** Swipe a scrollable container by ~65% of its height. */
async function scrollBy(serial, container, screen, direction) {
  const bounds = container
    ? ui.parseBounds(container.bounds)
    : { x1: 0, y1: 0, x2: screen.width, y2: screen.height, centerX: Math.floor(screen.width / 2) };

  const centerX = bounds.centerX ?? Math.floor((bounds.x1 + bounds.x2) / 2);
  const height = bounds.y2 - bounds.y1;
  const margin = Math.floor(height * 0.15);
  const top = bounds.y1 + margin;
  const bottom = bounds.y2 - margin;
  if (bottom - top < 40) return false;

  const [fromY, toY] = direction === 'up' ? [top, bottom] : [bottom, top];
  await shell(serial, ['input', 'swipe', String(centerX), String(fromY), String(centerX), String(toY), '400']);
  ui.invalidate(serial);
  // Let the fling settle before the next dump.
  await sleep(450);
  return true;
}

/**
 * Wait for an element to appear, scrolling to look for it if asked.
 *
 * @param {string} serial
 * @param {object} query {text, exact, field, className, index}
 * @param {object} opts  {timeoutMs, pollMs, scroll, maxScrolls, requireVisible}
 * @returns {Promise<{match:object, candidates:Array, scrolls:number, attempts:number}>}
 */
async function waitFor(serial, query, opts = {}) {
  const {
    timeoutMs = 5000,
    pollMs = 350,
    scroll = true,
    maxScrolls = 6,
    requireVisible = true,
  } = opts;

  const index = Number.isFinite(query.index) ? query.index : 0;
  const deadline = Date.now() + timeoutMs;

  let scrolls = 0;
  let attempts = 0;
  let lastRanked = [];
  let scrollDirection = 'down';

  let lastDumpError = null;

  while (Date.now() < deadline) {
    attempts += 1;

    // A dump can fail transiently mid-transition. That means "not ready yet",
    // not "give up" — keep polling until the deadline.
    let nodeList;
    try {
      nodeList = await ui.nodes(serial, { fresh: true });
    } catch (e) {
      lastDumpError = e;
      logger.debug({ serial, err: e.message }, 'waitFor: UI not readable, retrying');
      await sleep(pollMs);
      continue;
    }
    lastDumpError = null;

    const ranked = rank(nodeList, query);
    lastRanked = ranked;

    const usable = requireVisible ? ranked.filter((r) => r.visible) : ranked;
    if (usable.length > index) {
      return { match: usable[index], candidates: usable, scrolls, attempts };
    }

    // Nothing usable yet. Scroll to reveal more, then reverse once we hit the
    // bottom so an element above the starting position is still reachable.
    if (scroll && scrolls < maxScrolls) {
      const screen = ui.screenSize(nodeList);
      const container = ui.scrollableContainer(nodeList, screen);
      // Cached from the dump we just took, so this costs nothing.
      const before = await ui.dumpXml(serial).catch(() => null);

      const scrolled = await scrollBy(serial, container, screen, scrollDirection);
      if (scrolled) {
        scrolls += 1;
        const after = await ui.dumpXml(serial, { fresh: true }).catch(() => null);
        // Screen unchanged => we reached the end of the list.
        if (before !== null && after !== null && before === after) {
          if (scrollDirection === 'down') {
            scrollDirection = 'up';
          } else {
            break; // Both directions exhausted.
          }
        }
        continue;
      }
    }

    await sleep(pollMs);
  }

  if (lastDumpError) {
    // Never report "element not found" when we could not read the screen at
    // all — that sends callers hunting for a selector bug that is not there.
    lastDumpError.message = `Could not read the screen while looking for '${query.text}': ${lastDumpError.message}`;
    throw lastDumpError;
  }

  const error = new Error(
    `No element matching '${query.text}' after ${attempts} attempt(s)`
    + `${scrolls ? ` and ${scrolls} scroll(s)` : ''}`,
  );
  error.status = 404;
  // Diagnostics beat a bare 404 when a selector stops working.
  error.candidates = lastRanked.slice(0, 5).map((r) => ({
    text: r.node.text || null,
    contentDesc: r.node['content-desc'] || null,
    resourceId: r.node['resource-id'] || null,
    class: r.node.class || null,
    score: r.score,
    visible: r.visible,
    bounds: r.bounds,
  }));
  error.visibleText = await visibleTexts(serial).catch(() => []);
  throw error;
}

/** Text currently on screen — returned with 404s so callers can self-correct. */
async function visibleTexts(serial, limit = 40) {
  const nodeList = await ui.nodes(serial);
  const screen = ui.screenSize(nodeList);
  const seen = new Set();
  for (const node of nodeList) {
    if (!ui.isVisible(node, screen)) continue;
    const label = (node.text || node['content-desc'] || '').trim();
    if (label) seen.add(label);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

/**
 * Find an element and tap it.
 * Taps the nearest clickable ancestor, then optionally confirms the screen
 * actually reacted — a tap that lands on a disabled control used to report
 * success.
 */
async function clickByText(serial, query, opts = {}) {
  const { verify = true, settleMs = 350 } = opts;

  const found = await waitFor(serial, query, opts);
  const { match, candidates, scrolls, attempts } = found;
  const bounds = match.bounds;

  const before = verify ? await ui.dumpXml(serial).catch(() => null) : null;

  await shell(serial, ['input', 'tap', String(bounds.centerX), String(bounds.centerY)]);
  ui.invalidate(serial);

  let changed = null;
  if (verify) {
    await sleep(settleMs);
    const after = await ui.dumpXml(serial, { fresh: true }).catch(() => null);
    changed = before !== null && after !== null ? before !== after : null;
    if (changed === false) {
      logger.warn({ serial, text: query.text }, 'tap landed but the screen did not change');
    }
  }

  return {
    ok: true,
    x: bounds.centerX,
    y: bounds.centerY,
    matched: {
      text: match.node.text || null,
      contentDesc: match.node['content-desc'] || null,
      resourceId: match.node['resource-id'] || null,
      class: match.node.class || null,
      clickable: match.target.clickable === 'true',
      score: match.score,
      bounds,
    },
    matches: candidates.length,
    scrolls,
    attempts,
    screenChanged: changed,
  };
}

module.exports = { clickByText, waitFor, rank, normalize, visibleTexts, scrollBy };
