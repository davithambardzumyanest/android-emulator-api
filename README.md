# Unified Mobile Emulator API

A lightweight HTTP API for orchestrating Android emulators and device actions from scripts, CI pipelines, or other services. It can:
- **Register and launch** Android emulators on-demand.
- **Control apps and UI** (launch, close, tap, swipe, type, back, home, rotate).
- **Send intents** and **simulate GPS** (set location or follow a route from Google Directions).
- **Capture screenshots** or stream frames.
- **Cleanup** all emulators/processes and ensure the next start boots as a fresh device.


## Architecture
- **Server:** Express (`index.js`) exposes routes in `src/routes/api.js`.
- **Services:**
  - `src/services/deviceService.js` handles device registry, starting/stopping emulators, adb exec, cleanup.
  - `src/services/actionService.js` translates API calls to `ActionEngine` operations.
  - `src/services/navigationService.js` fetches Directions, opens Maps, and simulates GPS routes.
- **Actions Engine:** `src/actions/actionEngine` (implementation not shown here) performs adb-level tasks.
- **Registry:** `src/devices/deviceManager` tracks device objects and metadata.
- **Logging:** `src/logger.js` with `pino`.


## Resource tuning

Each emulator is the expensive thing here, not the API. The defaults aim at a
headless server running several devices at once; every knob lives in `.env`
(see `.env.example`) so a host can be tuned without a code change.

What the defaults do:

- **RAM/cores follow the AVD, capped.** `EMULATOR_MAX_MEMORY_MB` (2048) and
  `EMULATOR_MAX_CORES` (2) only ever lower what `config.ini` asks for. An AVD
  left at the wizard default of 8192MB gets clamped; an AVD already sized at
  1536MB is left alone. Set `EMULATOR_MEMORY_MB`/`EMULATOR_CORES` to force a value.
- **Headless by default** (`EMULATOR_HEADLESS=true`). A window adds a whole
  compositing path on top of software rendering.
- **`-gpu swiftshader_indirect` by default.** On a box with no usable GPU,
  `auto` probes, fails, and falls back to software anyway.
- **No blanket `-wipe-data`.** `-read-only` already gives every boot a throwaway
  data overlay, so wiping only forced a redundant first boot.
- **Animations are switched off once the device boots**
  (`EMULATOR_TUNE_AFTER_BOOT`). With a software renderer every animation frame
  is rasterised on the host CPU.
- **Admission control.** `MAX_EMULATORS` (4) plus a free-memory check refuse a
  device the host cannot afford - overshooting into swap costs far more than the
  extra device is worth.
- **`uiautomator dump` is no longer run before every adb call.** It is the single
  most expensive operation you can ask a device for; enable it per-host with
  `ADB_AUTO_DISMISS_DIALOGS=true` only if devices genuinely need it.

Measured on an 8-vCPU / 15GB host, same AVD, back to back:

| | before | after |
|---|---|---|
| RAM per device (RSS) | ~4.8 GB | ~2.9 GB |
| Idle CPU per device | 204-369% | ~153% |
| Boot time | ~180 s | ~138 s |

The remaining idle CPU is the software renderer plus Android's first-boot
optimisation, which `-read-only` makes it redo on every boot. The next lever
would be booting from a warm snapshot (`EMULATOR_COLD_BOOT=false`), which needs
`EMULATOR_READ_ONLY=false` and one AVD per device.


## Prerequisites
- Linux host with the Android SDK tools installed and on PATH:
  - `emulator`, `adb` (and optionally `avdmanager`, `sdkmanager`).
- At least one AVD image installed (e.g., system-images;android-33;google_apis;x86_64).
- Node.js 18+ recommended.


## Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure environment variables in `.env` (see `.env.example`):
   - `PORT` (default: 3000)
   - `LOG_LEVEL` (default: info)
   - `GOOGLE_MAPS_API_KEY` (required for navigation routes)
3. Start the API:
   ```bash
   npm start
   # or
   npm run dev
   ```


## Quick Start
- Health check:
  ```bash
  curl http://localhost:3000/
  ```
- Register a device (and start an emulator):
  ```bash
  curl -X POST http://localhost:3000/devices/register \
    -H 'Content-Type: application/json' \
    -d '{"platform":"android","avd":"YourAvdName"}'
  ```
  Response includes `deviceId`, emulator `port`, `pid`, and the command used.


## API Reference
Below is a concise list of primary endpoints. All bodies are JSON unless noted.

- **GET /** – health/status.

- **POST /devices/register** – register a device (starts emulator if Android and no `meta.deviceId`).
  - Body:
    - `platform`: `android` | `ios`
    - `avd`: name of the AVD to boot (Android)
    - `proxy`: optional HTTP proxy (e.g., `http://user:pass@host:port`)
    - `meta`: optional metadata

- **GET /devices** – list registered devices.

- **POST /devices/:id/proxy** – set proxy for a device.
  - Body: `{ "proxy": "http://host:port" }`

- **POST /devices/:id/launch** – launch app by package name.
  - Body: `{ "appId": "com.example.app" }`
- **POST /devices/:id/close** – close app by package name.
  - Body: `{ "appId": "com.example.app" }`

- **POST /devices/:id/tap** – tap coordinates.
  - Body: `{ "x": 100, "y": 200 }`
- **POST /devices/:id/swipe** – swipe between coordinates.
  - Body: `{ "x1":0, "y1":0, "x2":100, "y2":200, "durationMs":500 }`
- **POST /devices/:id/type** – type text.
  - Body: `{ "text": "Hello" }`
- **POST /devices/:id/back** – navigate back.
- **POST /devices/:id/home** – go home.
- **POST /devices/:id/rotate** – set orientation.
  - Body: `{ "orientation": "portrait" | "landscape" }`

- **POST /devices/:id/adb** – run arbitrary adb subcommand against the mapped emulator.
  - Body: `{ "command": "shell pm list packages" }` (string or array)

- **POST /devices/:id/intent** – send Android intent.
  - Body example:
    ```json
    {
      "action": "android.intent.action.VIEW",
      "data": "google.navigation:q=37.7749,-122.4194",
      "component": "com.google.android.apps.maps"
    }
    ```

- **POST /devices/:id/gps/set** – set GPS location.
  - Body: `{ "lat": 37.7749, "lon": -122.4194 }`

- **POST /devices/:id/gps/route** – simulate route along points.
  - Body: `{ "points": [{"lat":..,"lon":..}, ...], "intervalMs": 2000, "loop": false }`

- **POST /devices/:id/screenshot** – returns a PNG stream once.
- **GET /devices/:id/stream** – multipart stream of PNG frames.

- **POST /cleanup** – stop all emulators and cleanup processes.
  - Behavior:
    - Attempts graceful shutdown (`adb -s emulator-XXXX emu kill`) for all known and detected emulators.
    - Force-kills leftover `qemu-system-*` or exact `emulator` binaries if needed.
    - Kills the `adb` server.
    - Sets a one-time flag so the **next** emulator start uses `-wipe-data` (fresh device state).
  - Example:
    ```bash
    curl -X POST http://localhost:3000/cleanup
    ```


## Cleanup semantics (Fresh device on next start)
- `POST /cleanup` ensures the next `register` that boots an emulator will pass `-wipe-data`, producing a fresh data partition (no installed apps, new Android ID, no previous state).
- This is implemented via a one-time flag stored in `.state/wipe-once.flag` that is consumed on the next boot.
- The device registry is cleared during cleanup via `deviceManager.clear()` so subsequent registrations are fresh records.


## Environment Variables
- `PORT`: server port (default `3000`).
- `LOG_LEVEL`: pino log level (`info`, `debug`, etc.).
- `GOOGLE_MAPS_API_KEY`: required for Directions-based GPS routes and Maps intents in `navigationService`.
- `EMULATOR_HEADLESS`: when `true`, starts the Android emulator with `-no-window` (headless mode). Default: `false`.
- `EMULATOR_GPU`: Android emulator GPU mode passed to `-gpu`. Default: `auto`. Common values: `host`, `auto`, `swiftshader`, `swangle`, `software`, `lavapipe`.
- `EMULATOR_DNS`: optional comma-separated DNS servers passed to emulator via `-dns-server`. Example: `8.8.8.8,1.1.1.1`.


## Security & Hardening
- **Rate limiting:** Global limiter is enabled in `index.js` via `express-rate-limit`.
- **Helmet & CORS:** Enabled by default.
- Consider protecting sensitive endpoints (like `/cleanup`) with an auth token, IP allowlist, or stricter rate limits.


## Troubleshooting
- Emulator doesn’t start:
  - Ensure `emulator` and `adb` are on PATH and an AVD named in `register` exists.
  - Try `POST /cleanup` then re-register; next start will use `-wipe-data`.
- ADB not detected or device offline:
  - `POST /cleanup` kills the adb server; the next command restarts it.
- API stopped after cleanup:
  - Fixed by avoiding broad `pkill -f emulator`; now uses exact matches and adb enumeration.


## Development
- Start server: `npm start`
- Dev mode (nodemon): `npm run dev`
- Logging level via `LOG_LEVEL=debug` for more verbosity.


## License
MIT (or project-specific).
