# Monoprice 10761 RS-232 Web Controller

This rebuilt bundle reflects the latest app direction for your Monoprice 10761 whole-home amplifier controller: mobile-safe UI rendering, inline SVG power icon rendering, zone icon editing that works on phones, serial-open timeout handling, server-side reconciliation polling, no-op volume suppression, and per-zone auto-off support with Zone 6 enabled at 120 minutes by default.

## Files

- `server.js` — Express + SerialPort backend for the Monoprice 10761.
- `public/index.html` — Single-page mobile-friendly web UI.
- `package.json` — Node package manifest.
- `README.md` — Setup and deployment notes.
- `CODE_REVIEW.md` — Review notes and next-step recommendations.

## Setup

1. Copy the bundle to your Raspberry Pi, for example `/opt/monoprice-amp`.
2. Run `npm install`.
3. Start the app with:
   - `SERIAL_PATH=/dev/ttyUSB0 PORT=3000 npm start`
4. Open `http://<pi-ip>:3000` in your browser.

## Notes

- The backend waits for the serial adapter to become ready and returns HTTP 503 if it never opens within `SERIAL_OPEN_TIMEOUT_MS`.
- Reconciliation polling runs every `RECONCILE_INTERVAL_MS` to keep the cache aligned with wall-keypad changes.
- Zone 6 auto-off defaults to enabled at 120 minutes.
- Theme preference is persisted in `config.json` through the backend config API.
