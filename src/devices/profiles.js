// Realistic hardware profiles.
//
// The AVDs on this host claimed to be a "Galaxy S21" and a "Pixel 5" while
// actually reporting `hw.device.name = pixel` at 800x1280/320dpi (and two of
// them at 320x640 with 96 MB of RAM, which cannot boot a usable Android 33).
// These profiles carry each phone's real panel size, density, RAM and build
// identifiers so the guest reports something a real handset would.
//
// Screen/RAM values come from the manufacturer spec sheets; the build strings
// mirror the stock retail images.

const PROFILES = {
  pixel_5: {
    label: 'Google Pixel 5',
    hardware: { name: 'pixel_5', manufacturer: 'Google' },
    screen: { width: 1080, height: 2340, density: 440 },
    ramMb: 8192,
    heapMb: 512,
    cores: 4,
    sdcardMb: 8192,
    dataPartitionMb: 8192,
    props: {
      'ro.product.brand': 'google',
      'ro.product.manufacturer': 'Google',
      'ro.product.model': 'Pixel 5',
      'ro.product.name': 'redfin',
      'ro.product.device': 'redfin',
      'ro.board.platform': 'lito',
      'ro.build.product': 'redfin',
      'ro.build.fingerprint': 'google/redfin/redfin:13/TQ3A.230805.001/10316531:user/release-keys',
      'ro.build.description': 'redfin-user 13 TQ3A.230805.001 10316531 release-keys',
    },
  },

  pixel_7: {
    label: 'Google Pixel 7',
    hardware: { name: 'pixel_7', manufacturer: 'Google' },
    screen: { width: 1080, height: 2400, density: 420 },
    ramMb: 8192,
    heapMb: 512,
    cores: 4,
    sdcardMb: 8192,
    dataPartitionMb: 8192,
    props: {
      'ro.product.brand': 'google',
      'ro.product.manufacturer': 'Google',
      'ro.product.model': 'Pixel 7',
      'ro.product.name': 'panther',
      'ro.product.device': 'panther',
      'ro.board.platform': 'gs201',
      'ro.build.product': 'panther',
      'ro.build.fingerprint': 'google/panther/panther:13/TQ3A.230805.001/10316531:user/release-keys',
      'ro.build.description': 'panther-user 13 TQ3A.230805.001 10316531 release-keys',
    },
  },

  pixel_6a: {
    label: 'Google Pixel 6a',
    hardware: { name: 'pixel_6a', manufacturer: 'Google' },
    screen: { width: 1080, height: 2400, density: 420 },
    ramMb: 6144,
    heapMb: 384,
    cores: 4,
    sdcardMb: 8192,
    dataPartitionMb: 8192,
    props: {
      'ro.product.brand': 'google',
      'ro.product.manufacturer': 'Google',
      'ro.product.model': 'Pixel 6a',
      'ro.product.name': 'bluejay',
      'ro.product.device': 'bluejay',
      'ro.board.platform': 'gs101',
      'ro.build.product': 'bluejay',
      'ro.build.fingerprint': 'google/bluejay/bluejay:13/TQ3A.230805.001/10316531:user/release-keys',
      'ro.build.description': 'bluejay-user 13 TQ3A.230805.001 10316531 release-keys',
    },
  },

  galaxy_s21: {
    label: 'Samsung Galaxy S21 5G',
    // No stock Samsung profile ships with the SDK, so drive the panel from
    // the explicit screen block below rather than an `hw.device.name`.
    hardware: { name: null, manufacturer: 'Samsung' },
    screen: { width: 1080, height: 2400, density: 421 },
    ramMb: 8192,
    heapMb: 512,
    cores: 4,
    sdcardMb: 8192,
    dataPartitionMb: 8192,
    props: {
      'ro.product.brand': 'samsung',
      'ro.product.manufacturer': 'samsung',
      'ro.product.model': 'SM-G991B',
      'ro.product.name': 'o1sxeea',
      'ro.product.device': 'o1s',
      'ro.board.platform': 'exynos2100',
      'ro.build.product': 'o1s',
      'ro.build.fingerprint': 'samsung/o1sxeea/o1s:13/TP1A.220624.014/G991BXXS9DWderivative:user/release-keys',
      'ro.build.description': 'o1sxeea-user 13 TP1A.220624.014 release-keys',
    },
  },

  galaxy_a54: {
    label: 'Samsung Galaxy A54 5G',
    hardware: { name: null, manufacturer: 'Samsung' },
    screen: { width: 1080, height: 2340, density: 403 },
    ramMb: 6144,
    heapMb: 384,
    cores: 4,
    sdcardMb: 8192,
    dataPartitionMb: 8192,
    props: {
      'ro.product.brand': 'samsung',
      'ro.product.manufacturer': 'samsung',
      'ro.product.model': 'SM-A546B',
      'ro.product.name': 'a54xnaxx',
      'ro.product.device': 'a54x',
      'ro.board.platform': 'exynos1380',
      'ro.build.product': 'a54x',
      'ro.build.fingerprint': 'samsung/a54xnaxx/a54x:13/TP1A.220624.014/A546BXXU4BWderivative:user/release-keys',
      'ro.build.description': 'a54xnaxx-user 13 TP1A.220624.014 release-keys',
    },
  },
};

function get(name) {
  const key = String(name || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return PROFILES[key] || null;
}

function list() {
  return Object.entries(PROFILES).map(([id, p]) => ({
    id,
    label: p.label,
    screen: p.screen,
    ramMb: p.ramMb,
    model: p.props['ro.product.model'],
  }));
}

module.exports = { PROFILES, get, list };
