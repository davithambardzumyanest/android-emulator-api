// iOS is not implemented. Each method throws with 501 so the API returns a
// proper status; the previous version resolved with `{ ok:false, status:501 }`,
// which surfaced to callers as HTTP 200 and read as success.
function notImplemented(operation) {
  return async () => {
    const e = new Error(`iOS ${operation} is not implemented`);
    e.status = 501;
    throw e;
  };
}

module.exports = {
  launchApp: notImplemented('launchApp'),
  closeApp: notImplemented('closeApp'),
  intent: notImplemented('intent'),
  tap: notImplemented('tap'),
  swipe: notImplemented('swipe'),
  type: notImplemented('type'),
  back: notImplemented('back'),
  home: notImplemented('home'),
  rotate: notImplemented('rotate'),
  setGPS: notImplemented('setGPS'),
  getCurrentPageInfo: notImplemented('getCurrentPageInfo'),
  clickByText: notImplemented('clickByText'),
  waitForText: notImplemented('waitForText'),
  findElements: notImplemented('findElements'),
  typeInto: notImplemented('typeInto'),
  screenshot: notImplemented('screenshot'),
};
