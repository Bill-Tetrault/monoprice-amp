# Monoprice 10761 Web Controller – Raspberry Pi Setup

This guide installs the Node.js web controller for the Monoprice 10761
6‑zone whole‑home audio amplifier on a Raspberry Pi using a USB–RS‑232
adapter. The app runs as a systemd service and exposes a mobile‑friendly
web UI.

## 1. Install Node.js 20 LTS (NodeSource)

On Raspberry Pi OS:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
npm -v
```

Confirm that `node -v` reports a 20.x version.

## 2. Project layout and dependencies

Create the project directory and copy files:

```bash
sudo mkdir -p /opt/monoprice-amp/public
sudo chown -R $USER:$USER /opt/monoprice-amp
cd /opt/monoprice-amp
```

Place these files in `/opt/monoprice-amp`:

- `package.json`
- `server.js`
- `public/index.html`

Then install dependencies:

```bash
cd /opt/monoprice-amp
npm install
```

This installs:

- `express` ^4.18
- `serialport` ^12.0.0

## 3. Give the user serial port access

The USB‑to‑RS‑232 adapter appears as `/dev/ttyUSB0` (or similar). Add your user
to the `dialout` group so Node can open the device without sudo:

```bash
sudo usermod -aG dialout $USER
# Log out and log back in so group membership applies
```

You can verify the device path with:

```bash
ls -l /dev/ttyUSB*
```

Adjust `SERIAL_PATH` later if your adapter uses a different name.

## 4. Test run

From the project directory:

```bash
cd /opt/monoprice-amp
SERIAL_PATH=/dev/ttyUSB0 PORT=3000 npm start
```

You should see:

```text
Monoprice 10761 controller listening on port 3000
```

Visit the web UI from any device on your network:

```text
http://<pi-ip>:3000
```

Replace `<pi-ip>` with your Pi’s IP address (e.g. `192.168.1.50`).

- The app will auto‑create `config.json` on first run with default theme,
  source names, and zone names.
- Zone power, source, volume, mute, tone, balance, and max‑volume caps are
  available via the UI once the amp is connected over RS‑232.

Press `Ctrl+C` to stop the test process.

## 5. systemd service

Create a systemd unit file so the controller starts automatically on boot:

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

Adjust `User=pi` if you use a different username, and update `SERIAL_PATH` if your
adapter is not `/dev/ttyUSB0`.

Then enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now monoprice-amp
```

Check status:

```bash
sudo systemctl status monoprice-amp
```

You should see the service active and logs indicating that it is listening on
port 3000.

## 6. Accessing the UI

From any device on your LAN:

```text
http://<pi-ip>:3000
```

- The theme, source names, zone names, emojis, and max‑volume caps are stored in
  `config.json` and shared by all browsers.
- Each zone card shows power, source, and volume controls.
- An **Advanced** panel per zone provides mute, bass, treble, balance, and
  per‑zone max‑volume settings.
- The server enforces the per‑zone max‑volume cap for all volume changes,
  protecting outdoor speakers (e.g. Zone 6) from accidental over‑driving.

If you change `PORT` in the systemd unit, update the URL accordingly.

## 7. Updating the app

To deploy code updates:

```bash
cd /opt/monoprice-amp
git pull   # or copy updated files
npm install
sudo systemctl restart monoprice-amp
```

Check logs for any serial or config errors:

```bash
journalctl -u monoprice-amp -n 50 -f
```

The app will keep your existing `config.json` and apply any new defaults via
server-side deep merge.