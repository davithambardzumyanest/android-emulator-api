const deviceManager = require('../devices/deviceManager');
const {spawn} = require('child_process');
const {v4: uuidv4} = require('uuid');
const logger = require('../logger');
const fs = require('fs');
const path = require('path');

const deviceService = {
    async register(payload) {
        const {platform, proxy, meta = {}, avd} = payload || {};

        if (platform !== 'ios') {
            const e = new Error("This API only supports iOS platform");
            e.status = 400;
            throw e;
        }

        // If it's an iOS device and no deviceId is provided, create a simulator
        if (!meta.deviceId) {
            const simulatorDeviceId = await this.startIOSSimulator(avd);

            // Update meta with simulator details
            meta.simulator = {
                deviceId: simulatorDeviceId,
                name: avd || 'iPhone 14',
                command: `xcrun simctl boot ${simulatorDeviceId}`
            };
            meta.deviceId = simulatorDeviceId;
        }

        const device = deviceManager.register({platform, proxy, meta});
        return device;
    },

    executeCommand(command, args = []) {
        return new Promise((resolve, reject) => {
            const cmd = spawn(command, args, {stdio: 'pipe'});
            let output = '';
            let error = '';

            cmd.stdout.on('data', (data) => {
                output += data.toString();
                logger.debug(`[${command}] ${data}`.trim());
            });

            cmd.stderr.on('data', (data) => {
                error += data.toString();
                logger.error(`[${command} ERROR] ${data}`.trim());
            });

            cmd.on('close', (code) => {
                if (code === 0) {
                    resolve({output, error});
                } else {
                    reject(new Error(`Command failed with code ${code}: ${error || 'Unknown error'}`));
                }
            });
        });
    },

    async startIOSSimulator(deviceName = 'iPhone 14') {
        // List available simulators
        const { stdout: simulatorsList } = await this.executeCommand('xcrun', ['simctl', 'list', 'devices', 'available']);
        
        // Parse list to find requested device
        const lines = simulatorsList.split('\n');
        let targetDeviceId = null;
        
        for (const line of lines) {
            if (line.includes(deviceName) && line.includes('Booted')) {
                // Device is already booted, extract its ID
                const match = line.match(/\(([A-F0-9-]+)\)/);
                if (match) {
                    targetDeviceId = match[1];
                    break;
                }
            } else if (line.includes(deviceName) && !line.includes('Booted')) {
                // Device is available but not booted, extract its ID
                const match = line.match(/\(([A-F0-9-]+)\)/);
                if (match) {
                    targetDeviceId = match[1];
                    break;
                }
            }
        }
        
        if (!targetDeviceId) {
            throw new Error(`iOS simulator '${deviceName}' not found. Available simulators:\n${simulatorsList}`);
        }
        
        // Check if simulator is already booted
        const { stdout: bootedList } = await this.executeCommand('xcrun', ['simctl', 'list', 'devices', 'booted']);
        if (!bootedList.includes(targetDeviceId)) {
            // Boot simulator
            await this.executeCommand('xcrun', ['simctl', 'boot', targetDeviceId]);
            logger.info(`iOS simulator ${deviceName} (${targetDeviceId}) booted successfully`);
        } else {
            logger.info(`iOS simulator ${deviceName} (${targetDeviceId}) already booted`);
        }
        
        return targetDeviceId;
    },

    list() {
        return deviceManager.list();
    },

    getOrThrow(id) {
        const d = deviceManager.get(id);
        if (!d) {
            const e = new Error('Device not found');
            e.status = 404;
            throw e;
        }
        return d;
    },

    updateProxy(id, proxy) {
        if (!proxy) {
            const e = new Error("'proxy' is required");
            e.status = 400;
            throw e;
        }
        const updated = deviceManager.update(id, {proxy});
        if (!updated) {
            const e = new Error('Device not found');
            e.status = 404;
            throw e;
        }
        return updated;
    },

    /**
     * Stop all simulators and clear device registry.
     */
    async stopAllEmulators() {
        const devices = this.list();
        const results = [];

        for (const d of devices) {
            const entry = {deviceId: d.id, platform: d.platform, stopped: false, errors: []};

            if (d.platform === 'ios') {
                const deviceId = d?.meta?.deviceId;
                entry.deviceId = deviceId;

                if (deviceId) {
                    try {
                        await this.executeCommand('xcrun', ['simctl', 'shutdown', deviceId]);
                        entry.stopped = true;
                    } catch (e) {
                        entry.errors.push(`simctl shutdown: ${e.message}`);
                    }
                }
            }

            results.push(entry);
        }

        // Clear device registry
        try {
            deviceManager.clear();
        } catch (_) {
        }

        return {results};
    },

    /**
     * Cleanup all simulators and related processes system-wide.
     */
    async cleanupAll() {
        const summary = {
            stopResults: [],
            iosKills: [],
            deepClean: { errors: [] }
        };
        try {
            const stopped = await this.stopAllEmulators();
            summary.stopResults = stopped.results || [];
        } catch (e) {
            summary.stopResults = [{error: `stopAllEmulators failed: ${e.message}`}];
        }

        // Helper to run a command and ignore failures
        async function trySpawn(command, args) {
            return new Promise((resolve) => {
                const proc = spawn(command, args, {stdio: 'pipe'});
                let stderr = '';
                proc.stderr.on('data', (d) => {
                    stderr += d.toString();
                });
                proc.on('close', (code) => {
                    resolve({command: `${command} ${args.join(' ')}`, code, stderr: stderr.trim()});
                });
                proc.on('error', (err) => {
                    resolve({command: `${command} ${args.join(' ')}`, code: -1, stderr: String(err?.message || err)});
                });
            });
        }

        // Shutdown all iOS simulators
        try {
            const { stdout: bootedSimulators } = await this.executeCommand('xcrun', ['simctl', 'list', 'devices', 'booted']);
            const simulatorIds = bootedSimulators
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.includes('Booted'))
                .map(line => {
                    const match = line.match(/\(([A-F0-9-]+)\)/);
                    return match ? match[1] : null;
                })
                .filter(id => id);

            for (const simulatorId of simulatorIds) {
                const res = await trySpawn('xcrun', ['simctl', 'shutdown', simulatorId]);
                summary.iosKills.push({simulatorId, ...res});
            }
        } catch (e) {
            summary.iosKills.push({error: `Failed to list/shutdown iOS simulators: ${e.message}`});
        }

        return summary;
    },
};

module.exports = deviceService;
