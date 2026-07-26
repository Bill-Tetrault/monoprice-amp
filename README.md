# Monoprice 10761 Web Controller

A mobile‑first web UI and JSON API for the Monoprice 6‑Zone Home Audio Multizone Controller and Amplifier (PID 10761), exposing RS‑232 control over HTTP for six stereo zones. [web:29][file:41]

The app runs on a Linux host (e.g., Raspberry Pi) with a USB‑to‑RS232 adapter connected to the amp’s serial port, and serves a single‑page interface optimized for phones.

---

## Features

- **Monoprice 10761 RS‑232 control**
  - Uses the documented Monoprice/Xantech‑style RS‑232 protocol: `?<zone>` for queries and `<zoneCMDxx` for writes. [web:55][file:41]
  - Zone addressing uses `11–16` for zones 1–6 on amp 1 (e.g., Zone 1 = `11`, Zone 6 = `16`). [web:55]

- **Single‑column, mobile‑first UI**
  - Compact shell UI designed around a 480px viewport.
  - Bottom tab bar for server status, zones, and sources.
  - Detail view per zone with tone, balance, volume, source selection, and auto‑off timer controls. [file:42]

- **Live zone status polling**
  - Backend sends `?11`–`?16` query commands and parses noisy responses (echoed commands, `#` framing) to extract the real `>…` status lines.
  - Frontend periodically calls `/api/state?zone=N` and `/api/serial-status` to keep the UI in sync with keypad changes and detect serial issues. [file:41][file:42]

- **Reliable RS‑232 command handling**
  - Writes use `<11PR01`, `<11VOxx`, `<11CHxx`, etc., so the amp accepts power, volume, source, tone, mute, and balance changes. [web:55][file:41]
  - Serial access is serialized via a queue to avoid overlapping commands on the line. [file:41]

- **Per‑zone auto‑off timers**
  - Global automation enable plus per‑zone `enabled`/`minutes` settings.
  - Defaults include a 120‑minute auto‑off for Zone 6 (Patio), with other zones configurable via the UI.
  - Auto‑off is reset on power, source, volume, or tone changes for the affected zone. [file:41][file:42]

- **Editable zone names and icons**
  - Zones can be renamed (e.g., “Kitchen”, “Garage”, “Master Bedroom”) and assigned emoji icons via the settings screen.
  - Names and icons are persisted in `config.json` and restored on restart. [file:42][file:41]

- **Editable source names**
  - Six sources can be renamed (e.g., “Sonos”, “Chromecast”, “TV”, etc.).
  - Source names are displayed in the zones list and in the detail view. [file:42]

- **Persistent configuration**
  - All user configuration (title, theme, zone metadata, source names, auto‑off settings) stored in `config.json`.
  - Config is merged with sane defaults on startup and written atomically (temp file + rename). [file:41]

---

## Architecture

- **Backend**
  - Node.js (tested with Node 20) + Express 4. [file:41]
  - `serialport` 12 for RS‑232 access.
  - REST‑style JSON endpoints under `/api/*` for health, serial status, zone state, zone control, and config.

- **Frontend**
  - Static `public/index.html` served by Express.
  - Vanilla JS; no build step required.
  - Single page with three main views:
    - Server status (health, serial device, clock).
    - Zones list + per‑zone detail.
    - Settings (app title, zone names/icons, source names). [file:42]

---

## Requirements

- Linux host (Debian/Ubuntu/Raspberry Pi OS) or similar.
- Node.js 18+ (20.x recommended). [file:41]
- USB‑to‑RS232 adapter supported by Linux (e.g., FTDI).
- Monoprice 10761 amp connected to the adapter via a proper RS‑232 cable.
- Access to `/dev/ttyUSB0` (or equivalent) for the Node process.

---

## Installation (using Git)

1. **Install system dependencies**

   ```bash
   sudo apt update
   sudo apt install -y git nodejs npm
   ```

2. **Clone the repo**

   ```bash
   cd /opt
   sudo git clone https://github.com/Bill-Tetrault/monoprice-amp.git
   sudo chown -R $USER:$USER monoprice-amp
   cd monoprice-amp
   ```

3. **Install Node dependencies**

   ```bash
   npm install
   ```

4. **Create an initial config (optional)**

   On first run, the app will create `config.json` with defaults if it does not exist. You can pre‑seed it if you like:

   ```bash
   cat > config.json <<'EOF'
   {
     "title": "Whole-Home Audio",
     "theme": "dark",
     "sourceNames": {
       "1": "Source 1",
       "2": "Source 2",
       "3": "Source 3",
       "4": "Source 4",
       "5": "Source 5",
       "6": "Source 6"
     },
     "zones": {
       "1": { "name": "Kitchen", "icon": "🍽️", "maxVolume": 38 },
       "2": { "name": "Laundry", "icon": "🧺", "maxVolume": 38 },
       "3": { "name": "Garage",  "icon": "🚗", "maxVolume": 30 },
       "4": { "name": "Master Bedroom", "icon": "🛏️", "maxVolume": 38 },
       "5": { "name": "Bathroom", "icon": "🛁", "maxVolume": 38 },
       "6": { "name": "Patio", "icon": "🌿", "maxVolume": 30 }
     },
     "automation": {
       "enabled": true,
       "defaultMinutes": 120,
       "zones": {
         "1": { "enabled": false, "minutes": 120 },
         "2": { "enabled": false, "minutes": 120 },
         "3": { "enabled": true,  "minutes": 120 },
         "4": { "enabled": false, "minutes": 120 },
         "5": { "enabled": false, "minutes": 120 },
         "6": { "enabled": true,  "minutes": 120 }
       }
     }
   }
   EOF
   ```

   You can also just let the app create this on first start and then edit zone/source names from the UI. [file:41][file:42]

5. **Wire up the serial adapter**

   - Plug the USB‑RS232 adapter into the host.
   - Connect the RS‑232 cable from the adapter to the Monoprice amp’s serial port.
   - Confirm the device path (e.g., `/dev/ttyUSB0`) via:

     ```bash
     ls -l /dev/ttyUSB*
     ```

---

## Running

### Simple foreground run

From the repo directory:

```bash
SERIAL_PATH=/dev/ttyUSB0 PORT=3000 node server.js
```

- `SERIAL_PATH` (or `SERIALPATH`) overrides the default `/dev/ttyUSB0`. [file:41]
- `PORT` defaults to 3000 if not set.

### Systemd service example

For a more permanent setup:

```bash
sudo tee /etc/systemd/system/monoprice-amp.service <<'EOF'
[Unit]
Description=Monoprice 10761 Web Controller
After=network.target

[Service]
WorkingDirectory=/opt/monoprice-amp
ExecStart=/usr/bin/env SERIAL_PATH=/dev/ttyUSB0 PORT=3000 node server.js
Restart=on-failure
User=admin
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable monoprice-amp
sudo systemctl start monoprice-amp
```

---

## Using the Web UI

1. Open a browser to:

   ```text
   http://<host>:3000/
   ```

2. **Server tab**
   - Shows app title, serial path, and basic health.
   - Displays a banner if the serial device is offline or status cannot be read. [file:42]

3. **Zones tab**
   - Lists all six zones with name, current source, and volume badge when powered.
   - Tap a zone to open its detail view:
     - Power toggle.
     - Source selection (1–6).
     - Volume slider (respecting per‑zone `maxVolume`).
     - Bass, treble, balance sliders.
     - Auto‑off toggle and timer. [file:42]

4. **Settings tab**
   - Edit app title.
   - Rename zones and change icons.
   - Edit source names via the bottom sheet “Source names” editor. [file:42]

All changes are persisted to `config.json`; on restart, the amp state is read over RS‑232 and merged with the saved configuration. [file:41]

---

## API Overview

The backend exposes simple JSON endpoints:

- `GET /api/health`
  - Returns `{ "ok": true }` if the app is up. [file:41]

- `GET /api/serial-status`
  - Returns serial info: `online`, `path`, `lastError`, `openedAt`, `lastClosedAt`, `lastActivityAt`. [file:41]

- `GET /api/state?zone=N`
  - Queries the amplifier via `?<zonePrefix>` and returns parsed status for zone `N`. [file:41]

- `POST /api/zone/:zone/power`
  - Body: `{ "on": true|false }`.
  - Sends `<11PR01` / `<11PR00`‑style commands and schedules/cancels auto‑off as appropriate. [web:55][file:41]

- `POST /api/zone/:zone/source`
  - Body: `{ "source": 1..6 }`.
  - Sends `<11CHxx`. [web:55][file:41]

- `POST /api/zone/:zone/volume`
  - Body: `{ "volume": 0..max }` (clamped per zone).
  - Sends `<11VOxx`. [web:55][file:41]

- `POST /api/zone/:zone/mute`
  - Body: `{ "mute": true|false }`.
  - Sends `<11MU01` / `<11MU00`. [web:55][file:41]

- `POST /api/zone/:zone/treble`
  - Body: `{ "treble": 0..14 }`.
  - Sends `<11TRxx`. [web:55][file:41]

- `POST /api/zone/:zone/bass`
  - Body: `{ "bass": 0..14 }`.
  - Sends `<11BSxx`. [web:55][file:41]

- `POST /api/zone/:zone/balance`
  - Body: `{ "balance": 0..20 }` (center = 10).
  - Sends `<11BLxx`. [web:55][file:41]

- `GET /api/config`
  - Returns the merged configuration (defaults + `config.json`). [file:41]

- `PATCH /api/config` / `POST /api/config`
  - Accepts partial updates to title, theme, zones, source names, and automation settings.
  - Writes updated config to disk and returns the new configuration. [file:41]

---

## Notes and Limitations

- This controller targets the Monoprice 10761/related Xantech‑style amps that use `11–16` zone addressing; other models with different RS‑232 syntax may require changes. [web:55]
- The app assumes a single amp at address 1; stacked or multi‑amp setups are not yet supported.
- Serial timing values (settle delay and query timeout) are tuned for typical 10761 response speeds; extremely slow or noisy setups may require adjusting these constants. [file:41]

---
