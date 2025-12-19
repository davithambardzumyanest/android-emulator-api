const { exec } = require('child_process');
const { promisify } = require('util');
const { PassThrough } = require('stream');
const execAsync = promisify(exec);

// Make exec available globally for the module
const { exec: execSync } = require('child_process');

// Helper to run adb commands, optionally targeting a specific device serial
async function adb(command, { serial } = {}) {
  const prefix = serial ? `adb -s ${serial}` : 'adb';
  const full = `${prefix} ${command}`;
  const { stdout, stderr } = await execAsync(full);
  if (stderr && stderr.trim()) {
    // adb often writes non-fatal info to stderr; do not throw unless clear error
    if (/error|failed/i.test(stderr)) throw new Error(stderr.trim());
  }
  return stdout;
}

module.exports = {
  // meta: { serial } should be stored on device.meta.serial when registering
  async launchApp(device, appId) {
    const serial = device?.meta?.deviceId;
    // Prefer 'am start' to launch activity; if main activity unknown, fallback to monkey
    try {
      await adb(`shell monkey -p ${appId} -c android.intent.category.LAUNCHER 1`, { serial });
    } catch (_) {
      await adb(`shell am start -n ${appId}/.MainActivity`, { serial });
    }
    return { ok: true };
  },

  async intent(device, { action, data, category, component, flags, extras } = {}) {
    const serial = device?.meta?.deviceId;
    const parts = ['shell', 'am', 'start'];
    if (action) parts.push('-a', action);
    if (data) parts.push('-d', `'${data}'`);
    if (category) parts.push('-c', category);
    if (component) parts.push('-n', component);
    if (typeof flags === 'number') parts.push('-f', String(flags));
    if (extras && typeof extras === 'object') {
      for (const [k, v] of Object.entries(extras)) {
        if (typeof v === 'number') {
          parts.push('-ei', k, String(v));
        } else if (typeof v === 'boolean') {
          parts.push('-ez', k, v ? 'true' : 'false');
        } else {
          parts.push('-e', k, String(v));
        }
      }
    }
    await adb(parts.join(' '), { serial });
    return { ok: true };
  },

  async closeApp(device, appId) {
    const serial = device?.meta?.deviceId;
    if (!appId) return { ok: false, error: "'appId' required to close app" };
    await adb(`shell am force-stop ${appId}`, { serial });
    return { ok: true };
  },

  async tap(device, { x, y }) {
    const serial = device?.meta?.deviceId;
    await adb(`shell input tap ${x} ${y}`, { serial });
    return { ok: true };
  },

  async swipe(device, { x1, y1, x2, y2, durationMs = 300 }) {
    const serial = device?.meta?.deviceId;
    await adb(`shell input swipe ${x1} ${y1} ${x2} ${y2} ${Math.max(1, durationMs)}` , { serial });
    return { ok: true };
  },

  async type(device, { text }) {
    const serial = device?.meta?.deviceId;
    // Escape spaces
    const escaped = text.replace(/ /g, '%s');
    await adb(`shell input text "${escaped}"`, { serial });
    return { ok: true };
  },

  async back(device) {
    const serial = device?.meta?.deviceId;
    await adb('shell input keyevent 4', { serial });
    return { ok: true };
  },

  async home(device) {
    const serial = device?.meta?.deviceId;
    await adb('shell input keyevent 3', { serial });
    return { ok: true };
  },

  async rotate(device, { orientation }) {
    const serial = device?.meta?.deviceId;
    // Best-effort: disable auto-rotate and set user rotation
    if (orientation === 'portrait') {
      await adb('shell settings put system accelerometer_rotation 0', { serial });
      await adb('shell settings put system user_rotation 0', { serial });
    } else {
      await adb('shell settings put system accelerometer_rotation 0', { serial });
      await adb('shell settings put system user_rotation 1', { serial });
    }
    return { ok: true };
  },

  async setGPS(device, { lat, lon }) {
    const serial = device?.meta?.deviceId;
    // Many emulators support: adb emu geo fix <lon> <lat>
    await adb(`emu geo fix ${lon} ${lat}`, { serial });
    return { ok: true };
  },

  async clickByText(device, { text, exact = true, index = 0 }) {
    const serial = device?.meta?.deviceId;
    
    // Dump the UI hierarchy to XML
    await adb(`shell uiautomator dump /sdcard/window_dump.xml`, { serial });
    const xmlDump = await adb(`shell cat /sdcard/window_dump.xml`, { serial });
    
    // Parse the XML to find elements with the target text
    const { parseString } = require('xml2js');
    const parsed = await new Promise((resolve, reject) => {
      parseString(xmlDump, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
    
    // Find all nodes with the text
    const findNodes = (node, text, nodes = []) => {
      if (node.$.text && 
          node.$.text.toLowerCase().includes(text.toLowerCase())) {
        nodes.push(node);
      }
      
      if (node.node) {
        const children = Array.isArray(node.node) ? node.node : [node.node];
        children.forEach(child => findNodes(child, text, nodes));
      }
      
      return nodes;
    };
    
    const matchingNodes = findNodes(parsed.hierarchy, text);
    
    if (matchingNodes.length === 0) {
      throw new Error(`No elements found with text: ${text}`);
    }
    
    if (index >= matchingNodes.length) {
      throw new Error(`Index ${index} out of bounds. Found ${matchingNodes.length} matching elements.`);
    }
    
    // Get bounds of the element
    const bounds = matchingNodes[index].$.bounds;
    const match = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    
    if (!match) {
      throw new Error(`Could not parse bounds: ${bounds}`);
    }
    
    const x1 = parseInt(match[1], 10);
    const y1 = parseInt(match[2], 10);
    const x2 = parseInt(match[3], 10);
    const y2 = parseInt(match[4], 10);
    
    // Calculate center point
    const centerX = Math.floor((x1 + x2) / 2);
    const centerY = Math.floor((y1 + y2) / 2);
    
    // Tap on the center of the element
    await this.tap(device, { x: centerX, y: centerY });
    
    return { 
      count: matchingNodes.length,
      bounds: { x1, y1, x2, y2 }
    };
  },

  async screenshotStream(device) {
    const execAsync = promisify(exec);
    
    const serial = device?.meta?.deviceId;
    if (!serial) {
      throw new Error('Device serial number is required for taking screenshots');
    }

    // Add a small delay to ensure the screen is fully rendered
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const command = `adb -s ${serial} exec-out screencap -p`;
    console.log(`[screenshot] Taking screenshot from device: ${serial}`);
    
    try {
      // First, try the direct method
      const { stdout, stderr } = await execAsync(command, { 
        encoding: 'buffer',
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer
      });
      
      if (!stdout || stdout.length === 0) {
        throw new Error('Received empty screenshot data');
      }
      
      console.log(`[screenshot] Captured ${stdout.length} bytes of screenshot data`);
      
      // Create a stream from the buffer
      const { Readable } = require('stream');
      const stream = new Readable();
      stream.push(stdout);
      stream.push(null); // Signal end of stream
      
      return stream;
      
    } catch (error) {
      console.error('[screenshot] Error capturing screenshot:', error);
      
      // If direct method fails, try saving to a temporary file first
      try {
        console.log('[screenshot] Trying alternative method with temporary file...');
        const tempFile = `/sdcard/screenshot-${Date.now()}.png`;
        
        // Save screenshot to device
        await execAsync(`adb -s ${serial} shell screencap -p ${tempFile}`);
        
        // Pull the file
        await execAsync(`adb -s ${serial} pull ${tempFile} /tmp/`);
        
        // Read the file
        const fs = require('fs');
        const filePath = `/tmp/screenshot-${Date.now()}.png`;
        const fileStream = fs.createReadStream(filePath);
        
        // Clean up
        fileStream.on('end', () => {
          fs.unlink(filePath, () => {});
          execAsync(`adb -s ${serial} shell rm ${tempFile}`).catch(() => {});
        });
        
        return fileStream;
        
      } catch (fallbackError) {
        console.error('[screenshot] Fallback method also failed:', fallbackError);
        throw new Error(`Failed to capture screenshot: ${fallbackError.message}`);
      }
    }
  },
};
