# iOS Simulator API

A lightweight HTTP API for orchestrating iOS simulators from scripts, CI pipelines, or other services. It can:

## Features
- **iOS Support:**
  - Register and boot iOS simulators using xcrun simctl
  - Control apps and UI (launch, close, tap, swipe, type, back, home, rotate)
  - Simulate GPS location
  - Capture screenshots or stream frames
  - Cleanup all simulators

## Architecture
- **Server:** Express (`index.js`) exposes routes in `src/routes/api.js`.
- **Services:**
  - `src/services/deviceService.js` handles device registry, starting/stopping simulators, simctl exec, cleanup.
  - `src/services/actionService.js` translates API calls to `ActionEngine` operations.
  - `src/services/navigationService.js` fetches Directions, opens Maps, and simulates GPS routes.
- **Actions Engine:** `src/actions/actionEngine` performs iOS-specific tasks.
- **Registry:** `src/devices/deviceManager` tracks device objects and metadata.
- **Logging:** `src/logger.js` with `pino`.

## Prerequisites

### For iOS Support:
- macOS host (iOS simulators only run on macOS)
- Xcode Command Line Tools installed
- iOS simulators available (installed with Xcode)
- Node.js 18+ recommended.

### Installation of Prerequisites:

#### macOS Setup:

1. **Install Homebrew** (if not already installed):
   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```

2. **Install Node.js**:
   ```bash
   brew install node
   ```

3. **Install Xcode Command Line Tools** (required for iOS simulators):
   ```bash
   xcode-select --install
   ```

4. **Verify iOS Simulators**:
   ```bash
   # List available iOS simulators
   xcrun simctl list devices available
   ```

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure environment variables** in `.env` (see `.env.example`):
   ```env
   PORT=3000
   LOG_LEVEL=info
   GOOGLE_MAPS_API_KEY=your_google_maps_api_key_here
   ```

3. **Start the API**:
   ```bash
   npm start
   # or for development with auto-reload
   npm run dev
   ```

## Quick Start

### Health Check:
```bash
curl http://localhost:3000/
```

### Register an iOS Device:
```bash
curl -X POST http://localhost:3000/devices/register \
  -H 'Content-Type: application/json' \
  -d '{"platform":"ios","avd":"iPhone 14"}'
```

### List Available iOS Simulators:
```bash
xcrun simctl list devices available
```

## API Reference

Below is a concise list of primary endpoints. All bodies are JSON unless noted.

### Device Management

- **GET /** – health/status.

- **POST /devices/register** – register a device (starts simulator if no `meta.deviceId`).
  - Body:
    - `platform`: `ios` (only supported platform)
    - `avd`: name of simulator to boot
    - `proxy`: optional HTTP proxy (e.g., `http://user:pass@host:port`)
    - `meta`: optional metadata

- **GET /devices** – list registered devices.

- **POST /devices/:id/proxy** – set proxy for a device.
  - Body: `{ "proxy": "http://host:port" }`

### App Control

- **POST /devices/:id/launch** – launch app by bundle ID.
  - Body: `{ "appId": "com.example.app" }`

- **POST /devices/:id/close** – close app by bundle ID.
  - Body: `{ "appId": "com.example.app" }`

### UI Actions

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

### GPS and Location

- **POST /devices/:id/gps/set** – set GPS location.
  - Body: `{ "lat": 37.7749, "lon": -122.4194 }`

- **POST /devices/:id/gps/route** – simulate route along points.
  - Body: `{ "points": [{"lat":..,"lon":..}, ...], "intervalMs": 2000, "loop": false }`

### Raw Command Execution (iOS-only)

- **POST /devices/:id/xcrun** – execute arbitrary `xcrun simctl` command for registered device.
  - Body: `{ "command": "launch com.apple.mobilesafari" }`
  - The command should be the simctl subcommand and arguments (without device ID).
  - The device ID is automatically injected from the registered device.
  - Examples:
    ```bash
    # Launch Safari
    curl -X POST http://localhost:3000/devices/<DEVICE_ID>/xcrun \
      -H 'Content-Type: application/json' \
      -d '{"command": "launch com.apple.mobilesafari"}'
    
    # Open URL
    curl -X POST http://localhost:3000/devices/<DEVICE_ID>/xcrun \
      -H 'Content-Type: application/json' \
      -d '{"command": "openurl https://example.com"}'
    
    # Get device info
    curl -X POST http://localhost:3000/devices/<DEVICE_ID>/xcrun \
      -H 'Content-Type: application/json' \
      -d '{"command": "list devices"}'
    
    # Install app
    curl -X POST http://localhost:3000/devices/<DEVICE_ID>/xcrun \
      -H 'Content-Type: application/json' \
      -d '{"command": "install /path/to/app.app"}'
    ```

### Media and Screenshots

- **POST /devices/:id/screenshot** – returns a PNG stream once.
- **GET /devices/:id/stream** – multipart stream of PNG frames.

### Cleanup

- **POST /cleanup** – stop all simulators and cleanup processes.
  - Behavior:
    - Attempts graceful shutdown for all known iOS simulators
    - Force-kills leftover processes if needed
  - Example:
    ```bash
    curl -X POST http://localhost:3000/cleanup
    ```

## Platform-Specific Notes

### iOS:
- Uses xcrun simctl for simulator control
- Limited to macOS hosts only
- Supports basic app control and UI interactions
- Requires Xcode Command Line Tools
- Simulator names must match available simulators (use `xcrun simctl list devices available`)

## Environment Variables

- `PORT`: server port (default `3000`).
- `LOG_LEVEL`: pino log level (`info`, `debug`, etc.).
- `GOOGLE_MAPS_API_KEY`: required for Directions-based GPS routes and Maps intents in `navigationService`.

## Security & Hardening

- **Rate limiting:** Global limiter is enabled in `index.js` via `express-rate-limit`.
- **Helmet & CORS:** Enabled by default.
- Consider protecting sensitive endpoints (like `/cleanup`) with an auth token, IP allowlist, or stricter rate limits.

## Troubleshooting

### iOS Issues:
- Simulator doesn't start:
  - Ensure Xcode Command Line Tools are installed: `xcode-select --install`
  - Check available simulators: `xcrun simctl list devices available`
  - Verify simulator name matches exactly
- Simulator commands fail:
  - Ensure simulator is booted: `xcrun simctl list devices booted`
  - Try `POST /cleanup` to reset simulator state

### General:
- API not responding:
  - Check logs for error messages
  - Verify port is not already in use
  - Ensure all prerequisites are installed

## Development

- Start server: `npm start`
- Dev mode (nodemon): `npm run dev`
- Logging level via `LOG_LEVEL=debug` for more verbosity.

## License

MIT
