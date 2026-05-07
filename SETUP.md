# SETUP.md – Monoprice 10761 Amp Web Controller

## Prerequisites
- Raspberry Pi running Raspberry Pi OS (64-bit recommended)
- USB-to-serial adapter (USB-A to DB9 male, straight-through cable)
- Monoprice 10761 powered on and connected

---

## 1. Install Node.js 20 LTS

```bash
# Download and run the NodeSource setup script for Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node -v    # should print v20.x.x
npm  -v
```

---

## 2. Clone / copy the project

```bash
sudo mkdir -p /opt/monoprice-amp
sudo chown $USER:$USER /opt/monoprice-amp
# Copy package.json, server.js, and the public/ folder into /opt/monoprice-amp/
```

---

## 3. Install dependencies

```bash
cd /opt/monoprice-amp
npm install
```

---

## 4. Grant serial port access

The user running the server must be in the `dialout` group:

```bash
sudo usermod -aG dialout $USER
# You must log out and log back in (or reboot) for this to take effect
```

Verify your adapter path:

```bash
ls -l /dev/ttyUSB*   # typical output: /dev/ttyUSB0
# OR
ls -l /dev/ttyACM*   # some adapters enumerate here instead
```

---

## 5. Test run

```bash
cd /opt/monoprice-amp
SERIAL_PATH=/dev/ttyUSB0 PORT=3000 node server.js
```

Open a browser on any device on your LAN:
```
http://<raspberry-pi-ip>:3000
```

Confirm the green "serial open" state (no offline banner appears at the top).

---

## 6. Install as a systemd service

Create the unit file:

```bash
sudo nano /etc/systemd/system/monoprice-amp.service
```

Paste:

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

> **Note:** Change `User=pi` if your Raspberry Pi OS user is different (e.g., `User=bill`).
> Confirm the node path with `which node` and update `ExecStart` if needed.

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now monoprice-amp

# Check status
sudo systemctl status monoprice-amp

# Watch live logs
sudo journalctl -u monoprice-amp -f
```

---

## 7. Find your Pi's IP address

```bash
hostname -I
```

Then from any phone, tablet, or computer on the same network:
```
http://<pi-ip>:3000
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Serial port not open" banner | Check `SERIAL_PATH`; confirm dialout group membership (re-login required) |
| "Command Error." in logs | Verify straight-through DB9 cable (not null-modem); confirm zone 1–6 only |
| Timeout on zone query | Check baud rate is 9600; confirm amp is powered on; reseat USB adapter |
| Can't reach :3000 from LAN | Check Pi firewall: `sudo ufw allow 3000` |
| `config.json` not saving | Check write permissions: `ls -la /opt/monoprice-amp/` |

---

## Environment variables reference

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `SERIAL_PATH` | `/dev/ttyUSB0` | Serial device path |
| `CONFIG_PATH` | `./config.json` | Path to UI config file |

---

## RS-232 cable pinout reminder

This amp uses a **straight-through** DB9 cable (not a null-modem crossover):

| Signal | DB9 Pin | Wire color (typical) |
|---|---|---|
| RX | 2 | Yellow |
| TX | 3 | Orange |
| GND | 5 | Black |

Both ends connect the **same pin numbers** together.  
The amp has a **female** DB9 socket; your USB adapter cable needs a **male** DB9 plug.
