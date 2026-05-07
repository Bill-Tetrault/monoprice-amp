# 🎵 Monoprice 10761 – RS-232 Web Controller

A clean, mobile-first web application to control a **Monoprice 10761 6-zone whole-home audio amplifier** over RS-232 from a Raspberry Pi. Control all six zones from any phone, tablet, or browser on your local network — no app install required.

![Node.js](https://img.shields.io/badge/Node.js-20%20LTS-green?logo=node.js)
![Express](https://img.shields.io/badge/Express-4.18-lightgrey?logo=express)
![SerialPort](https://img.shields.io/badge/serialport-12-blue)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## Screenshots

| Dark Mode | Light Mode |
|-----------|------------|
| Six zone cards with power, source, and volume controls | Same UI with light theme toggled via 🌞/🌙 button |

---

## Features

- 🎛 **Full amp control** — power on/off, source select (6 inputs), volume (0–38) per zone
- 📱 **Mobile-first responsive grid** — 1 col (phone) → 2 col (tablet) → 3 col (desktop)
- 🌗 **Light / dark theme** toggle, persisted server-side
- ✏️ **Inline zone name editing** — click any zone name, type, blur to save
- 😀 **Emoji icon picker** — 30 icons, tap the zone emoji to change it
- 🎛 **Source name editor** — rename all 6 inputs (e.g. "Apple TV", "Vinyl", "Spotify")
- 🔄 **Multi-device sync** — config polls every 60 s so all browsers stay in sync
- 💾 **Zero client-side persistence** — no localStorage; all state lives in `config.json` on the server
- ⚡ **No build step** — single `index.html` with embedded CSS + JS (vanilla, no frameworks)
- 🔌 **Graceful offline mode** — server starts even if serial port is unavailable; banner alerts you

---

## Hardware Requirements

| Item | Details |
|------|---------|
| Amplifier | Monoprice 10761 6-Zone Whole-Home Audio Amplifier |
| Controller | Raspberry Pi (any model with USB; Pi 4 recommended) |
| Adapter | USB-to-Serial adapter (USB-A → DB9 male plug) |
| Cable | Straight-through DB9 cable (**not** null-modem/crossover) |

### DB9 Cable Pinout

The amp uses a **straight-through** cable — same pin numbers on both ends:

| Signal | DB9 Pin |
|--------|---------|
| RX     | 2       |
| TX     | 3       |
| GND    | 5       |

> ⚠️ The amp has a **female** DB9 socket. Your USB adapter must present a **male** DB9 plug.

---

## Project Structure

```
/opt/monoprice-amp/
├── package.json        # Dependencies: express ^4.18, serialport ^12
├── server.js           # Backend: Express API + RS-232 serial logic + config I/O
├── config.json         # Auto-created on first run; stores theme, zone names, source names
├── SETUP.md            # Raspberry Pi install + systemd service instructions
└── public/
    └── index.html      # Full SPA — HTML + CSS + JS, no build step required
```

---

## Quick Start

### 1. Install Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Install the app

```bash
sudo mkdir -p /opt/monoprice-amp/public
# Copy server.js, package.json into /opt/monoprice-amp/
# Copy public/index.html into /opt/monoprice-amp/public/
cd /opt/monoprice-amp && npm install
```

### 3. Grant serial port access

```bash
sudo usermod -aG dialout $USER
# Log out and back in for this to take effect
```

### 4. Run it

```bash
cd /opt/monoprice-amp
SERIAL_PATH=/dev/ttyUSB0 PORT=3000 node server.js
```

Open from any device on your network:
```
http://<raspberry-pi-ip>:3000
```

### 5. Run as a service (optional but recommended)

See [SETUP.md](SETUP.md) for full systemd instructions. The short version:

```bash
sudo systemctl enable --now monoprice-amp
sudo journalctl -u monoprice-amp -f   # watch live logs
```

---

## REST API Reference

### Amp Control

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| `GET` | `/api/health` | — | `{ ok: true, serialOpen: bool }` |
| `GET` | `/api/state?zone=N` | — | `{ zone, power, source, volume }` |
| `POST` | `/api/zone/:zone/power` | `{ "on": true }` | `{ ok, zone, power }` |
| `POST` | `/api/zone/:zone/source` | `{ "source": 1–6 }` | `{ ok, zone, source }` |
| `POST` | `/api/zone/:zone/volume` | `{ "volume": 0–38 }` | `{ ok, zone, volume }` |

### Configuration

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| `GET` | `/api/config` | — | Full config JSON |
| `PATCH` | `/api/config` | Partial config object | Updated full config |

**`PATCH` examples:**

```bash
# Change theme
curl -X PATCH http://pi:3000/api/config   -H "Content-Type: application/json"   -d '{"theme":"light"}'

# Rename zone 2
curl -X PATCH http://pi:3000/api/config   -H "Content-Type: application/json"   -d '{"zones":{"2":{"name":"Dining Room"}}}'

# Rename source 3
curl -X PATCH http://pi:3000/api/config   -H "Content-Type: application/json"   -d '{"sourceNames":{"3":"Apple TV"}}'
```

---

## Configuration File (`config.json`)

Auto-created on first run with these defaults:

```json
{
  "theme": "dark",
  "sourceNames": {
    "1": "Source 1", "2": "Source 2", "3": "Source 3",
    "4": "Source 4", "5": "Source 5", "6": "Source 6"
  },
  "zones": {
    "1": { "name": "Living Room", "icon": "🛋️" },
    "2": { "name": "Kitchen",     "icon": "🍳" },
    "3": { "name": "Master Bed",  "icon": "🛏️" },
    "4": { "name": "Office",      "icon": "💻" },
    "5": { "name": "Patio",       "icon": "🌿" },
    "6": { "name": "Garage",      "icon": "🏠" }
  }
}
```

All changes made through the UI are written back atomically (write to `.tmp` → rename).

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `SERIAL_PATH` | `/dev/ttyUSB0` | Serial device path |
| `CONFIG_PATH` | `./config.json` | Path to the UI config file |

---

## RS-232 Protocol Notes

These behaviors were validated against real hardware. The implementation strictly follows them.

| Detail | Value |
|--------|-------|
| Baud rate | 9600 |
| Frame | 8-N-1 |
| Command terminator | `\r\n` (CR+LF, 0x0D 0x0A) — `\r` alone or `\n` alone cause "Command Error." |
| Zone prefix | Controller ID (`1`) + zone digit (`1`–`6`) → `11`–`16` |
| Query response | `>` + 22 ASCII digits; may arrive in chunks (200 ms settle timer used) |
| Set command response | **None** — power/source/volume commands produce no response; drain only |

> ⚠️ Some Monoprice firmware manuals document a two-digit zone format (`11`–`16` without the
> controller prefix). **This format causes "Command Error." on this unit.** The correct format
> is always `1<zone-digit>`, e.g. zone 4 → `14`.

### Command Reference

| Action | Command | Example (zone 1) |
|--------|---------|-----------------|
| Query state | `?1<Z>\r\n` | `?11\r\n` |
| Power on | `<1<Z>PR01\r\n` | `<11PR01\r\n` |
| Power off | `<1<Z>PR00\r\n` | `<11PR00\r\n` |
| Set source | `<1<Z>CH0N\r\n` | `<11CH02\r\n` |
| Set volume | `<1<Z>VO##\r\n` | `<11VO15\r\n` |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| ⚠️ Offline banner at top | Check `SERIAL_PATH`; confirm `dialout` group membership (re-login required) |
| "Command Error." in logs | Verify straight-through DB9 cable; confirm zone range is 1–6 |
| Zone query times out | Check baud is 9600; confirm amp is powered on; reseat USB adapter |
| Can't reach `:3000` from LAN | `sudo ufw allow 3000` |
| `config.json` not saving | Check write permissions: `ls -la /opt/monoprice-amp/` |
| Service won't start | Confirm `User=` in unit file matches your Pi username; check `which node` path |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 LTS |
| HTTP server | Express 4.18 |
| Serial communication | serialport 12 (raw Buffer mode, no parser) |
| Frontend | Vanilla JS + CSS custom properties (no frameworks, no build step) |
| Config persistence | JSON flat file with atomic writes |
| Process management | systemd |

---

## License

MIT — free to use, modify, and self-host.
