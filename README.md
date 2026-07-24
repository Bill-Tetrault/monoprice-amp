# Monoprice 10761 Web Controller

A production-ready web application for controlling a **Monoprice 10761** 6-zone whole-home audio amplifier over **RS-232** from a Raspberry Pi using a USB-to-serial adapter. The backend is built with **Node.js + Express**, and the frontend is a mobile-first single-page app in **vanilla JavaScript** with no build step. The Monoprice amplifier family exposes RS-232 control and zone status fields including power, source, volume, mute, treble, bass, and balance, which makes this architecture a good fit for a lightweight local controller.[1][2]

## Features

### Core control

- Power on/off for each zone.[1]
- Source selection for each zone.[1]
- Volume control with server-side clamping to the amp's 0-38 range.[1]
- Polling-based state refresh so multiple phones or browsers stay in sync through the server.[2]

### Advanced zone settings

Each zone now includes an **Advanced** panel with the following controls:

- Mute toggle.[2]
- Treble slider.[2]
- Bass slider.[2]
- Balance slider with a center reset action.[1]
- Per-zone max-volume cap stored in the server config and enforced on every volume write.[1]

These controls map to the amplifier's zone status and command fields for `MU`, `TR`, `BS`, and `BL`, while the max-volume cap is enforced by the web controller before the RS-232 volume command is sent.[1][2]

### Server-side configuration

All UI configuration is stored in a single `config.json` file on the Raspberry Pi, so browsers do not keep persistent local state. The server creates `config.json` from defaults on first run, deep-merges partial updates from `PATCH /api/config`, and writes the file atomically using a temporary file and rename operation.[2]

Config includes:

- Theme (`light` or `dark`).
- Source names for inputs 1-6.
- Zone names and icons.
- Per-zone max-volume caps.

## Architecture

```text
/opt/monoprice-amp/
  package.json
  server.js
  config.json         # auto-created on first run
  public/
    index.html
```

### Backend

The backend exposes REST endpoints for health checks, reading zone state, changing power/source/volume, updating advanced settings, and reading or patching configuration. Serial traffic is serialized through a Promise chain so commands never overlap on the RS-232 link, which is especially important because the amplifier returns query data differently from set commands.[1][2]

### Frontend

The frontend is a single HTML file with embedded CSS and JavaScript. On page load it fetches `/api/config`, renders the full UI from server data, then queries `/api/state?zone=N` for each zone in a staggered sequence to avoid piling requests onto the serial queue.[1]

## RS-232 protocol notes

These protocol details are important for reliable operation with the Monoprice amp family and match the validated behavior used in the controller implementation.[1][3]

- Serial settings: `9600, 8-N-1`.[1]
- Cable: straight-through DB9, not a null modem cable.[3]
- Every command must end with `\r\n`.[3]
- Zone prefix format is `1<zone>` using a single-digit zone number 1-6.[3]
- Query commands return a `>` status record after echoed bytes.[1]
- Set commands should resolve after serial drain and should not wait for a `>` response.[1]

### Zone status fields

The zone response includes 11 two-digit fields. This app uses these fields directly when parsing state.[1]

| Field | Meaning |
|-------|---------|
| `PR` | Power [1] |
| `MU` | Mute [1] |
| `VO` | Volume [1] |
| `TR` | Treble [1] |
| `BS` | Bass [1] |
| `BL` | Balance [1] |
| `CH` | Source [1] |

## API

### Health

- `GET /api/health` → `{ ok: true }`

### Zone state

- `GET /api/state?zone=N`
- Response includes:
  - `zone`
  - `power`
  - `source`
  - `volume`
  - `mute`
  - `treble`
  - `bass`
  - `balance`

### Zone control

- `POST /api/zone/:zone/power` with `{ "on": true|false }`
- `POST /api/zone/:zone/source` with `{ "source": 1-6 }`
- `POST /api/zone/:zone/volume` with `{ "volume": 0-38 }`
- `POST /api/zone/:zone/mute` with `{ "mute": true|false }`
- `POST /api/zone/:zone/treble` with `{ "treble": 0-14 }`
- `POST /api/zone/:zone/bass` with `{ "bass": 0-14 }`
- `POST /api/zone/:zone/balance` with `{ "balance": 0-20 }`

### Configuration

- `GET /api/config`
- `PATCH /api/config`

Examples:

```json
{ "theme": "light" }
```

```json
{ "zones": { "6": { "name": "Outdoor", "icon": "🌿", "maxVolume": 28 } } }
```

```json
{ "sourceNames": { "3": "Apple TV" } }
```

## Config example

```json
{
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
    "1": { "name": "Living Room", "icon": "🛋️", "maxVolume": 38 },
    "2": { "name": "Kitchen", "icon": "🍳", "maxVolume": 38 },
    "3": { "name": "Master Bed", "icon": "🛏️", "maxVolume": 38 },
    "4": { "name": "Office", "icon": "💻", "maxVolume": 38 },
    "5": { "name": "Patio", "icon": "🌿", "maxVolume": 38 },
    "6": { "name": "Garage", "icon": "🏠", "maxVolume": 30 }
  }
}
```

## Installation

### 1. Install Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Install dependencies

```bash
cd /opt/monoprice-amp
npm install
```

### 3. Enable serial access

```bash
sudo usermod -aG dialout $USER
```

Log out and back in so the new group membership applies.

### 4. Run manually for testing

```bash
SERIAL_PATH=/dev/ttyUSB0 PORT=3000 npm start
```

### 5. Access the app

Open:

```text
http://<pi-ip>:3000
```

## systemd service

Use this unit file to run the app on boot:

```ini
[Unit]
Description=Monoprice 10761 Web Controller
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/opt/monoprice-amp
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=SERIAL_PATH=/dev/ttyUSB0
Environment=CONFIG_PATH=/opt/monoprice-amp/config.json
ExecStart=/usr/bin/node /opt/monoprice-amp/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now monoprice-amp
```

## UI overview

- Header with light/dark theme toggle.
- Source editor modal for renaming the six inputs.
- One card per zone with emoji icon, editable zone name, power toggle, source selector, volume slider, and status chip.
- Advanced zone panel with mute, bass, treble, balance, and max-volume controls.

The browser keeps only in-memory state during a session. On reload, the app rebuilds itself from `/api/config` and live zone polling rather than from local storage.[2]

## Notes and limits

- The app assumes the amplifier is reachable at the configured serial device path.
- Set commands do not return a normal status payload, so the backend resolves them after `serial.drain()` instead of waiting for a reply.[1]
- Advanced tone and balance ranges are implemented with safe clamped integer values in the controller; if a specific hardware unit uses different accepted ranges, those clamp values can be adjusted in `server.js`.[1][2]
- Zone 6 is a good candidate for a lower max-volume cap when it drives outdoor speakers.[1]

## License

MIT