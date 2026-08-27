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

All bodies are JSON.

### Status
- `GET /` – health summary.
- `GET /health` – uptime, registered devices, emulators adb can see.

### Inventory
- `GET /avds` – AVDs on this host with their current screen/density/RAM.
- `GET /profiles` – available realistic device profiles.
- `POST /avds/:avd/profile` – apply a profile to an AVD's `config.ini` without booting.
  - Body: `{ "profile": "pixel_5" }`

### Devices
- `POST /devices/register` – register a device. **Waits for the emulator to finish booting**, then applies realistic device settings, so the device is usable when this returns.
  - Body: `platform` (`android`|`ios`), `avd`, optional `profile`, `proxy`, `wipe`, `meta`.
  - Pass `meta.deviceId` (e.g. `emulator-5554`) to adopt an already-running emulator instead of booting one.
- `GET /devices` · `GET /devices/:id`
- `DELETE /devices/:id` – stop the emulator and drop the registration.
- `POST /devices/:id/proxy` – set/clear the guest HTTP proxy. Body: `{ "proxy": "http://host:port" }` (`null` clears).

### Apps and input
- `POST /devices/:id/launch` · `/close` – Body: `{ "appId": "com.example.app" }`
- `POST /devices/:id/tap` – `{ "x": 100, "y": 200 }`
- `POST /devices/:id/swipe` – `{ "x1":0,"y1":0,"x2":100,"y2":200,"durationMs":500 }`
- `POST /devices/:id/type` – `{ "text": "Hello" }`
- `POST /devices/:id/back` · `/home`
- `POST /devices/:id/rotate` – `{ "orientation": "portrait"|"landscape" }`
- `POST /devices/:id/intent` – `{ "action", "data", "category", "component", "flags", "extras" }`

### Finding and clicking elements
`click-by-text`, `wait-for-text` and `find` share one selector:

| Field | Default | Meaning |
|---|---|---|
| `text` | required | What to look for |
| `exact` | `false` | Exact match instead of substring |
| `field` | `any` | `any` \| `text` \| `content-desc` \| `resource-id` \| `hint` |
| `className` | – | Restrict to a widget class, e.g. `Button` |
| `index` | `0` | Which ranked match to use |
| `timeoutMs` | `5000` | How long to wait for it to appear |
| `scroll` | `true` | Scroll to look for it (then reverse at the end of the list) |
| `maxScrolls` | `6` | Scroll attempts |
| `requireVisible` | `true` | Ignore off-screen matches |
| `verify` | `true` | Report whether the tap changed the screen |

Matching is case-, whitespace- and NBSP-insensitive; `resource-id` matches the
short form (`login_button` matches `com.example:id/login_button`). Candidates are
**ranked**, not taken in document order, and the tap lands on the nearest
clickable ancestor — a label inside a clickable row works.

- `POST /devices/:id/click-by-text` – find and tap.
- `POST /devices/:id/wait-for-text` – wait for an element without tapping.
- `POST /devices/:id/find` – list ranked matches with scores. Use this to debug a selector.
- `POST /devices/:id/type-into` – focus a field by label/hint and type. Body adds `value`, `clear`.

A 404 from these includes `visibleText` (what is actually on screen) and
`candidates` (near misses with scores), so a failing selector is diagnosable
from the response alone.

- `GET /devices/:id/pageinfo` – foreground package/activity plus structured screen contents.

### Location
- `POST /devices/:id/gps/set` – `{ "lat", "lon", "speed", "bearing", "altitude", "satellites" }`
  - `speed` is **metres per second** (converted to knots for the emulator).
  - `bearing` is degrees clockwise from north.
- `GET /devices/:id/gps` – read back the location Android actually reports
  (provider, lat/lon, speed, bearing, accuracy), so you can verify a fix landed.
  Returns `location: null` on an idle device: Android only records fixes while
  an app is requesting location.
- `POST /devices/:id/gps/route` – `{ "points": [{lat,lon}], "intervalMs": 1000, "speedKmh": 50, "loop": false }`
  - Each fix carries the **speed and bearing implied by the movement**, so apps
    reading `Location.getSpeed()`/`getBearing()` and navigation UIs that orient
    by heading see a coherent drive.
  - With `speedKmh` the route is resampled so every tick advances a realistic
    distance. Without it, one waypoint is emitted per tick — with sparse
    Directions polylines that means the device teleports and reports
    implausible speeds.
  - Per-point `speed`/`bearing` override the derived values.
- `GET /devices/:id/gps/route` – list running route tasks.
- `DELETE /devices/:id/gps/route/:taskId` – stop one.
- `POST /devices/:id/navigate` – `{ "origin", "destination" }`; fetches a Google Directions route and drives GPS along it. Needs `GOOGLE_MAPS_API_KEY`.

### Capture
- `GET|POST /devices/:id/screenshot` – PNG.
- `GET /devices/:id/stream?intervalMs=500` – multipart PNG stream.

### Raw adb
- `POST /devices/:id/adb` – `{ "command": "shell pm list packages" }`.
  Disabled unless `ALLOW_RAW_ADB=true`; it is arbitrary command execution on the device.

### Maintenance
- `POST /cleanup` – stop every emulator and clear the registry.
  - Body: `{ "wipeNextStart": true }` (default) arms a one-shot `-wipe-data` for the next boot.
  - It stops emulators and nothing else. It does **not** delete AVDs, kill unrelated
    processes, or restart this service.


## Device realism

`GET /profiles` lists the built-in profiles. Each carries a real handset's panel
size, density, RAM and build identifiers.

Applying a profile (on boot, or via `POST /avds/:avd/profile`) rewrites the AVD's
`config.ini`: screen geometry and density, 32-bit colour depth, RAM and heap,
gesture navigation (no hardware keys, d-pad or trackball), front and back
cameras, the full sensor set, and an LTE-shaped network instead of the
unthrottled default.

After boot the device is configured the way a phone in use looks: battery at a
partial level and discharging rather than pinned to 100% on AC, a real device
name, timezone, screen timeout, location enabled, setup marked complete, and
animations left on (set `DEVICE_DISABLE_ANIMATIONS=true` to trade that for speed).

**Build identity is a known limitation.** `Build.MODEL` still reports
`sdk_gphone64_x86_64`. The emulator's `-prop` flag cannot change it — emulator
36.x rejects anything outside `qemu.*` ("unexpected '-prop' value
(ro.product.model=...), only 'qemu.*' properties are supported"), and the props
are baked read-only into the system image. Each profile still carries the real
build strings, but applying them requires a writable `/system`:

```bash
DEVICE_WRITABLE_SYSTEM=true   # boot with -writable-system
adb -s emulator-5554 root && adb -s emulator-5554 remount
# patch ro.product.* in /system/build.prop, then reboot
```

This disables verity and slows the first boot, so it is off by default. The
screen, hardware, sensor and behavioural realism above all apply either way.


## GPS, speed and bearing

**Position and speed work.** Both are injected with the emulator's documented
`geo fix <lon> <lat> [alt [satellites [velocity]]]`, velocity in knots. Verified
on a device: setting 13.9 m/s reads back as `speed: 13.900277`, 27.8 m/s as
`27.800554`. (Before this, velocity was never supplied and every fix arrived
with `speed: 0`.)

**Bearing cannot be injected** on emulator 36.4.9.0. `geo fix` has no bearing
parameter, and `geo nmea` — the console's only other channel — is a no-op: it
answers `OK` but the fix does not change at all, not even the position given in
the sentence. `Location.getBearing()` therefore stays `0`. `setGPS` returns
`bearingApplied: false` rather than letting you assume otherwise. The GPRMC path
is kept behind `EMULATOR_GPS_NMEA=true` for builds that do honour NMEA.

This does not block navigation. Maps and other apps derive heading from
consecutive positions, and `simulateRoute` produces smooth, correctly-spaced
movement at a realistic speed. Use `GET /devices/:id/gps` to confirm what the
platform actually reports.

```bash
# 50 km/h along a route, one fix per second
curl -X POST localhost:3000/devices/$ID/gps/route -H 'Content-Type: application/json' \
  -d '{"points":[{"lat":40.758,"lon":-73.9855},{"lat":40.7484,"lon":-73.9857}],
       "speedKmh":50,"intervalMs":1000}'

curl localhost:3000/devices/$ID/gps   # verify what Android reports
```


## Performance notes

- **Quick boot** (`EMULATOR_QUICK_BOOT=true`) boots from the AVD snapshot.
  `-wipe-data` is applied only when asked, not on every start. `-read-only` is
  now opt-in (`EMULATOR_READ_ONLY`) because it blocks snapshot saving, which
  silently defeats quick boot; enable it only to run several instances of one AVD.
- **`register` waits for boot**, so callers no longer race an unbooted device.
- **UI dumps** use one `exec-out uiautomator dump /dev/tty` round trip instead of
  dump + pull + read + unlink, and are cached briefly so a dialog check and a
  click share one dump.
- **No implicit UI dump per adb call.** ANR/crash dialogs are suppressed at boot
  with `hide_error_dialogs` instead of being polled for.
- **adb calls are serialised per device**, so concurrent dumps and screencaps do
  not clobber each other.
- **RAM** follows the device profile, capped to what the host can actually back.


## Security

- `API_TOKEN` enables bearer auth on every endpoint except `/` and `/health`.
  Without it the API is unauthenticated — and it can read the screen, install
  apps and run adb.
- `ALLOW_RAW_ADB` gates the arbitrary-adb endpoint (default off).
- `CORS_ORIGIN` restricts origins.
- All device commands are spawned as argv arrays and quoted for the device
  shell, so text, intent URIs and package names cannot inject commands.


## Troubleshooting

- **Emulator will not start** – check `emulator -accel-check`, confirm the AVD
  exists (`GET /avds`), and confirm the SDK was detected (`GET /health`).
- **`Could not read UI hierarchy`** – uiautomator failed, usually mid-animation
  or while a system overlay has focus. Calls retry automatically; if it persists,
  the screen may be off.
- **Selector not matching** – `POST /devices/:id/find` shows every ranked
  candidate with its score.
- **Stale emulators** – `POST /cleanup`.


## Development

```bash
npm start        # or: npm run dev
LOG_LEVEL=debug npm start
```


## License
MIT (or project-specific).
