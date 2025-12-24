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
        await execAsync(`adb -s ${serial} shell uiautomator dump --compressed ${deviceDumpFile}`);

        // 2️⃣ Pull XML to local
        await execAsync(`adb -s ${serial} pull ${deviceDumpFile} ${localDumpFile}`);

        // 3️⃣ Read XML content
        const xmlData = fs.readFileSync(localDumpFile, 'utf-8');

        // 4️⃣ Check for any system dialogs that need handling
        const hasSystemDialog = (
            xmlData.includes("System UI isn't responding") || 
            xmlData.includes("isn't responding") ||
            xmlData.includes('com.android.systemui') ||
            xmlData.includes('android:id/alertTitle')
        );

        if (!hasSystemDialog) {
            return false; // No dialog present
        }
        
        console.log(`[${serial}] System dialog detected, attempting to handle...`);
        
        // Use clickByText to handle the "Wait" button or other dialog buttons
        const device = { meta: { deviceId: serial }, platform: 'android' };
        const android = require('../platforms/android');
        
        // Try to find and click common dialog buttons in order of preference
        const buttonsToTry = ['Wait', 'OK', 'Dismiss', 'Close', 'Yes', 'No', 'Cancel'];
        
        for (const buttonText of buttonsToTry) {
            try {
                await android.clickByText(device, { 
                    text: buttonText,
                    exact: true,
                    index: 0,
                    skipDialogCheck: true
                });
                console.log(`[${serial}] Successfully clicked "${buttonText}" button`);
                return true;
            } catch (clickError) {
                // Ignore and try the next button
                continue;
            }
        }
        
        // If we get here, no known buttons were found
        console.warn(`[${serial}] No known dialog buttons found to click`);
        return false;

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
