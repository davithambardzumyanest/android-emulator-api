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
    try {
        const parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: ""
        });

        // 1️⃣ Dump UI hierarchy to device
        await execAsync(`adb -s ${serial} shell uiautomator dump /sdcard/ui.xml`);

        // 2️⃣ Pull XML to local
        const localPath = `/tmp/ui_${serial}.xml`;
        await execAsync(`adb -s ${serial} pull /sdcard/ui.xml ${localPath}`);

        // 3️⃣ Read XML content
        const xmlData = fs.readFileSync(localPath, 'utf-8');

        // 4️⃣ Quick check for "System UI isn't responding"
        if (!xmlData.includes("System UI isn't responding")) {
            return false; // No dialog present
        }

        // 5️⃣ Parse XML
        const options = { ignoreAttributes: false, attributeNamePrefix: "" };
        const jsonObj = parser.parse(xmlData, options);

        // 6️⃣ Recursively collect all nodes
        function collectNodes(node, nodes = []) {
            if (!node) return nodes;
            if (node.node) {
                const children = Array.isArray(node.node) ? node.node : [node.node];
                for (const child of children) {
                    nodes.push(child);
                    collectNodes(child, nodes);
                }
            }
            return nodes;
        }

        const allNodes = collectNodes(jsonObj.hierarchy);

        // 7️⃣ Search for "Wait" button
        const waitNodes = allNodes.filter(el =>
            el.text === "Wait" || el.contentDesc === "Wait"
        );

        if (waitNodes.length === 0) {
            return false; // Dialog found but no Wait button
        }

        // 8️⃣ Get bounds and calculate tap coordinates
        const bounds = waitNodes[0].bounds; // e.g., "[880,1600][1000,1660]"
        const nums = bounds.match(/\d+/g).map(Number);
        const x = Math.floor((nums[0] + nums[2]) / 2);
        const y = Math.floor((nums[1] + nums[3]) / 2);

        // 9️⃣ Tap the "Wait" button
        await execAsync(`adb -s ${serial} shell input tap ${x} ${y}`);
        console.log(`Clicked "Wait" button at (${x},${y})`);
        return true;

    } catch (error) {
        return await execAsync(`adb -s ${serial} shell input tap 540 980`);
        return await execAsync(`adb -s ${serial} shell input tap 540 1050`);

        console.error('Error handling system dialogs:', error);
        return false;
    }
}

module.exports = { handleSystemDialogs };
