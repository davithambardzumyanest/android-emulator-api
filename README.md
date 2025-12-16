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
