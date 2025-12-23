// src/utils/dialogHandler.js
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');
const execAsync = promisify(exec);

/**
 * Handle system dialogs (e.g., "System UI isn't responding") using UIAutomator dump
 * @param {string} serial - ADB device serial
 * @returns {Promise<boolean>} - true if a dialog was handled
 */
async function handleSystemDialogs(serial) {
    const deviceDumpFile = `/sdcard/window_dump_${serial}.xml`;
    const localDumpFile = `/tmp/window_dump_${serial}.xml`;
    
    try {
        // 1️⃣ Dump UI hierarchy to device
        await execAsync(`adb -s ${serial} shell uiautomator dump ${deviceDumpFile}`);

        // 2️⃣ Pull XML to local
        await execAsync(`adb -s ${serial} pull ${deviceDumpFile} ${localDumpFile}`);

        // 3️⃣ Read XML content
        const xmlData = fs.readFileSync(localDumpFile, 'utf-8');

        // 4️⃣ Quick check for "System UI isn't responding"
        if (!xmlData.includes("System UI isn't responding")) {
            return false; // No dialog present
        }
        
        // Use clickByText to handle the "Wait" button
        const device = { meta: { deviceId: serial }, platform: 'android' };
        const android = require('../platforms/android');
        
        try {
            // Call clickByText with skipDialogCheck to prevent infinite loop
            await android.clickByText(device, { 
                text: 'Wait',
                exact: true,
                index: 0,
                skipDialogCheck: true
            });
            console.log(`[${serial}] Successfully clicked "Wait" button`);
            return true;
        } catch (clickError) {
            console.error(`[${serial}] Failed to click "Wait" button:`, clickError);
            return false;
        }

    } catch (error) {
        console.error(`[${serial}] Error handling system dialogs:`, error);
        return false;
    } finally {
        // Clean up files in all cases
        try {
            if (fs.existsSync(localDumpFile)) {
                fs.unlinkSync(localDumpFile);
            }
        } catch (cleanupError) {
            console.warn(`[${serial}] Failed to clean up temporary files:`, cleanupError);
        }
    }
}

module.exports = { handleSystemDialogs };
