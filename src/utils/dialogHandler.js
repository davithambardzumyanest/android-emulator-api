// System dialog handling.
//
// The previous implementation ran a full uiautomator dump + adb pull + local
// file read before *every* adb command, then decided a dialog was present if
// the XML contained the string 'com.android.systemui' — which it always does,
// because the status and navigation bars are systemui windows. It then clicked
// the first substring match for one of Wait/OK/Dismiss/Close/Yes/No/Cancel, so
// 'No' matched labels like "Notifications" and "Now", tapping random UI.
//
// The fix has two halves:
//   1. suppressDialogs() sets `hide_error_dialogs`, which stops ANR and crash
//      dialogs from ever appearing. Applied once at boot.
//   2. handleSystemDialogs() only looks at *actual* dialog windows and matches
//      button labels exactly, and is called explicitly rather than on every
//      command.
const { shell } = require('./adb');
const ui = require('./ui');
const logger = require('../logger');

// Matched against a node's resource-id / class to decide it is really a dialog.
const DIALOG_MARKERS = [
  'android:id/alertTitle',
  'android:id/aerr_',          // "isn't responding" / "has stopped"
  'android:id/button1',
  'com.android.permissioncontroller',
  'com.google.android.permissioncontroller',
];

// Exact labels, most-preferred first. Exact matching only — substring matching
// is what made the old handler tap arbitrary controls.
const DISMISS_LABELS = ['Wait', 'OK', 'Ok', 'Got it', 'Dismiss', 'Close', 'Continue'];

/**
 * Ask the platform to stop showing ANR/crash dialogs at all.
 * Call once after boot; cheap and removes the need to poll for them.
 */
async function suppressDialogs(serial) {
  const settings = [
    ['global', 'hide_error_dialogs', '1'],
    ['global', 'anr_show_background', '0'],
    ['secure', 'anr_show_background', '0'],
  ];
  for (const [namespace, key, value] of settings) {
    // eslint-disable-next-line no-await-in-loop
    await shell(serial, ['settings', 'put', namespace, key, value], { check: false });
  }
}

/** True when the dump contains a real dialog window, not just system chrome. */
function looksLikeDialog(nodes) {
  return nodes.some((node) => {
    const id = node['resource-id'] || '';
    return DIALOG_MARKERS.some((marker) => id.startsWith(marker));
  });
}

/**
 * Detect and dismiss a system dialog.
 * @param {string} serial
 * @returns {Promise<boolean>} true when a dialog was dismissed
 */
async function handleSystemDialogs(serial) {
  let nodes;
  try {
    nodes = await ui.nodes(serial);
  } catch (e) {
    logger.debug({ serial, err: e.message }, 'dialog check: could not read UI');
    return false;
  }

  if (!looksLikeDialog(nodes)) return false;

  for (const label of DISMISS_LABELS) {
    const [target] = ui.match(nodes, { text: label, exact: true, field: 'text' });
    if (!target) continue;

    const bounds = ui.parseBounds(target.bounds);
    if (!bounds) continue;

    // eslint-disable-next-line no-await-in-loop
    await shell(serial, ['input', 'tap', String(bounds.centerX), String(bounds.centerY)]);
    ui.invalidate(serial);
    logger.info({ serial, label }, 'dismissed system dialog');
    return true;
  }

  logger.warn({ serial }, 'dialog detected but no known dismiss button found');
  return false;
}

module.exports = { handleSystemDialogs, suppressDialogs };
