#!/usr/bin/env node
/**
 * Monoprice 10761 Web Controller
 *
 * Backend: Node.js + Express
 * - Controls the Monoprice 10761 6-zone whole-home audio amplifier over RS-232.
 * - Exposes a REST API for zone power, source, volume, tone, balance, and mute.
 * - Maintains a server-side JSON config for UI theme, source names, and zone metadata.
 *
 * IMPORTANT: RS-232 protocol details (validated against real hardware):
 * - 9600 baud, 8-N-1, straight-through DB9, CR+LF terminator.
 * - Zone prefix is "1<Z>" where 1 is controller ID and Z is single-digit zone (1–6).
 *   Example: Zone 1 prefix "11", Zone 6 prefix "16".
 * - Commands:
 *   Query:  ?1<Z>\r\n       (e.g. ?11\r\n)
 *   Power:  <1<Z>PR01\r\n   (on)  / <1<Z>PR00\r\n (off)
 *   Source: <1<Z>CH0N\r\n   (01–06)
 *   Volume: <1<Z>VO##\r\n   (00–38)
 *   Treble: <1<Z>TR##\r\n   (tone control)
 *   Bass:   <1<Z>BS##\r\n   (tone control)
 *   Balance:<1<Z>BL##\r\n   (left/right balance)
 *   Mute:   <1<Z>MU01\r\n   (mute on) / <1<Z>MU00\r\n (mute off)
 *
 * Query responses:
 * - Amp echoes sent bytes, then sends '#' and a line beginning with '>'.
 * - Response: ">" + 22 ASCII digits (11 × 2-digit fields).
 *   Fields (2 chars each after '>'):
 *     0: ZZ zone echo
 *     1: PA public address (not used here)
 *     2: PR power (0/1)
 *     3: MU mute (0/1)
 *     4: DT do not disturb
 *     5: VO volume (00–38)
 *     6: TR treble
 *     7: BS bass
 *     8: BL balance
 *     9: CH source (01–06)
 *    10: LS keypad flag
 *
 * Set commands:
 * - Do NOT produce a status response; they just echo bytes.
 * - We only wait for the serial port to drain, then resolve.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { SerialPort } = require('serialport');

// Environment variables
const PORT = parseInt(process.env.PORT || '3000', 10);
const SERIAL_PATH = process.env.SERIAL_PATH || '/dev/ttyUSB0';
const CONFIG_PATH = process.env.CONFIG_PATH || path.resolve('./config.json');

// Serial terminator CR+LF: two bytes 0x0D 0x0A
const TERMINATOR = Buffer.from([0x0D, 0x0A]);

// Express app
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Config store -----------------------------------------------------------

const DEFAULT_CONFIG = {
  theme: 'dark',
  sourceNames: {
    '1': 'Source 1',
    '2': 'Source 2',
    '3': 'Source 3',
    '4': 'Source 4',
    '5': 'Source 5',
    '6': 'Source 6'
  },
  zones: {
    '1': { name: 'Living Room', icon: '🛋️', maxVolume: 38 },
    '2': { name: 'Kitchen', icon: '🍳', maxVolume: 38 },
    '3': { name: 'Master Bed', icon: '🛏️', maxVolume: 38 },
    '4': { name: 'Office', icon: '💻', maxVolume: 38 },
    '5': { name: 'Patio', icon: '🌿', maxVolume: 38 },
    '6': { name: 'Garage', icon: '🏠', maxVolume: 30 } // example safer cap outdoors
  }
};

let config = loadConfig();

/**
 * Load config from disk or create with defaults.
 */
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      return deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), parsed);
    }
  } catch (err) {
    console.error('Failed to read config.json, using defaults:', err);
  }
  // Create file with defaults on first run
  try {
    writeConfig(DEFAULT_CONFIG);
  } catch (err) {
    console.error('Failed to write default config.json:', err);
  }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

/**
 * Atomic write: write to tmp file then rename.
 */
function writeConfig(cfg) {
  const tmpPath = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmpPath, CONFIG_PATH);
}

/**
 * Deep merge src into target (mutates target).
 * Used for PATCH /api/config.
 */
function deepMerge(target, src) {
  if (typeof src !== 'object' || src === null) return target;
  for (const key of Object.keys(src)) {
    const val = src[key];
    if (Array.isArray(val)) {
      target[key] = val.slice();
    } else if (typeof val === 'object' && val !== null) {
      if (typeof target[key] !== 'object' || target[key] === null) {
        target[key] = {};
      }
      deepMerge(target[key], val);
    } else {
      target[key] = val;
    }
  }
  return target;
}

// --- Serial port and helpers ------------------------------------------------

/**
 * SerialPort instance.
 * Note: we use raw Buffer mode with a 'data' listener directly.
 */
const serial = new SerialPort({
  path: SERIAL_PATH,
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  autoOpen: true
});

serial.on('error', (err) => {
  console.error('Serial error:', err);
});

// Promise chain to serialize all RS-232 transactions.
let serialQueue = Promise.resolve();

/**
 * Enqueue a function that returns a promise, ensuring serialised access.
 */
function enqueueSerial(fn) {
  serialQueue = serialQueue.then(() => fn()).catch((err) => {
    console.error('Serial queue error:', err);
  });
  return serialQueue;
}

/**
 * Write a command string (without terminator) as bytes plus CR+LF,
 * then wait for the port to drain. Used for set commands (PR/CH/VO/TR/BS/BL/MU).
 */
function writeCommand(cmd) {
  return enqueueSerial(() => {
    return new Promise((resolve, reject) => {
      try {
        const buf = Buffer.from(cmd, 'ascii');
        const payload = Buffer.concat([buf, TERMINATOR]);
        serial.write(payload, (writeErr) => {
          if (writeErr) {
            return reject(writeErr);
          }
          serial.drain((drainErr) => {
            if (drainErr) {
              return reject(drainErr);
            }
            resolve();
          });
        });
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Send a query command (e.g. "?11") and resolve with the status line
 * starting at '>' once it arrives.
 *
 * Algorithm:
 * - Attach a data listener to accumulate chunks into a buffer string.
 * - Once we see '>', start a 200ms settle timer to allow remaining bytes.
 * - On timer fire, extract substring from '>' and resolve.
 */
function queryCommand(cmd) {
  return enqueueSerial(() => {
    return new Promise((resolve, reject) => {
      let buffer = '';
      let settleTimer = null;
      let resolved = false;

      function cleanup() {
        serial.off('data', onData);
        if (settleTimer) {
          clearTimeout(settleTimer);
          settleTimer = null;
        }
      }

      function onData(chunk) {
        // Append ASCII data
        buffer += chunk.toString('ascii');
        const idx = buffer.indexOf('>');
        if (idx !== -1 && !settleTimer) {
          // Start settle timer once '>' is detected
          settleTimer = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            cleanup();
            // Extract from '>' onwards
            const response = buffer.slice(idx);
            resolve(response);
          }, 200); // 200ms settle
        }
      }

      serial.on('data', onData);

      try {
        const buf = Buffer.from(cmd, 'ascii');
        const payload = Buffer.concat([buf, TERMINATOR]);
        serial.write(payload, (writeErr) => {
          if (writeErr) {
            cleanup();
            return reject(writeErr);
          }
          // For query we do not wait for drain response to parse; data listener handles arrival.
          serial.drain((drainErr) => {
            if (drainErr && !resolved) {
              cleanup();
              return reject(drainErr);
            }
          });
        });
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  });
}

/**
 * Build the "1Z" prefix for a zone.
 * Controller ID is 1, zone is single digit 1–6.
 * We do NOT use the two-digit zone format documented in some manuals,
 * because this hardware expects the "1<Z>" format (e.g. 11, 12, ..., 16).
 */
function zonePrefix(zone) {
  return `1${zone}`;
}

/**
 * Parse the zone status line (starting with '>') into an object:
 * { zone, power, source, volume, mute, treble, bass, balance }
 *
 * raw example: ">1100000000111111100401"
 */
function parseZoneStatus(raw, zone) {
  if (!raw || raw[0] !== '>') {
    throw new Error('Invalid status line: ' + raw);
  }

  // Strip everything that isn't a digit after '>'
  const digits = raw
    .slice(1)
    .replace(/[^\d]/g, '');

  if (digits.length < 22) {
    throw new Error('Status line too short: ' + digits);
  }

  const fields = [];
  for (let i = 0; i < 11; i++) {
    fields.push(digits.slice(i * 2, i * 2 + 2));
  }

  const zoneEcho = parseInt(fields[0], 10);
  const power = fields[2] === '01';
  const mute = fields[3] === '01';
  const volume = parseInt(fields[5], 10);
  const treble = parseInt(fields[6], 10);
  const bass = parseInt(fields[7], 10);
  const balance = parseInt(fields[8], 10);
  const source = parseInt(fields[9], 10);

  return {
    zone,
    zoneEcho,
    power,
    mute,
    volume,
    treble,
    bass,
    balance,
    source
  };
}

// --- High-level amp helpers -------------------------------------------------

function validateZone(zone) {
  const z = Number(zone);
  if (!Number.isInteger(z) || z < 1 || z > 6) {
    const err = new Error('zone must be 1-6');
    err.statusCode = 400;
    throw err;
  }
  return z;
}

function validateSource(src) {
  const s = Number(src);
  if (!Number.isInteger(s) || s < 1 || s > 6) {
    const err = new Error('source must be 1-6');
    err.statusCode = 400;
    throw err;
  }
  return s;
}

function clampVolume(zone, vol) {
  let v = Number(vol);
  if (!Number.isFinite(v)) v = 0;
  if (v < 0) v = 0;
  if (v > 38) v = 38;
  // Apply per-zone maxVolume cap from config if present
  const zoneCfg = config.zones[String(zone)];
  if (zoneCfg && typeof zoneCfg.maxVolume === 'number') {
    if (v > zoneCfg.maxVolume) {
      v = zoneCfg.maxVolume;
    }
  }
  return v;
}

// Tone/balance ranges: the Monoprice/Xantech-style amps use integer steps
// for treble, bass, and balance. We clamp to a safe 0–14 range by default.
// Adjust if you know the exact range for your hardware.
function clampTone(value) {
  let v = Number(value);
  if (!Number.isFinite(v)) v = 0;
  if (v < 0) v = 0;
  if (v > 14) v = 14;
  return v;
}

// Balance: treat as 0–20 where 10 is center by default.
// This matches common multi-zone amp balance ranges (left/right steps).
function clampBalance(value) {
  let v = Number(value);
  if (!Number.isFinite(v)) v = 10;
  if (v < 0) v = 0;
  if (v > 20) v = 20;
  return v;
}

/**
 * Query a zone's state.
 */
async function getZoneState(zone) {
  const z = validateZone(zone);
  const prefix = zonePrefix(z);
  const cmd = `?${prefix}`;
  const raw = await queryCommand(cmd);
  return parseZoneStatus(raw, z);
}

async function setZonePower(zone, on) {
  const z = validateZone(zone);
  const prefix = zonePrefix(z);
  const cmd = `<${prefix}PR${on ? '01' : '00'}`;
  await writeCommand(cmd);
  return { zone: z, power: !!on };
}

async function setZoneSource(zone, src) {
  const z = validateZone(zone);
  const s = validateSource(src);
  const prefix = zonePrefix(z);
  const srcStr = String(s).padStart(2, '0');
  const cmd = `<${prefix}CH${srcStr}`;
  await writeCommand(cmd);
  return { zone: z, source: s };
}

async function setZoneVolume(zone, vol) {
  const z = validateZone(zone);
  const v = clampVolume(z, vol);
  const prefix = zonePrefix(z);
  const volStr = String(v).padStart(2, '0');
  const cmd = `<${prefix}VO${volStr}`;
  await writeCommand(cmd);
  return { zone: z, volume: v };
}

async function setZoneMute(zone, mute) {
  const z = validateZone(zone);
  const prefix = zonePrefix(z);
  const cmd = `<${prefix}MU${mute ? '01' : '00'}`;
  await writeCommand(cmd);
  return { zone: z, mute: !!mute };
}

async function setZoneTreble(zone, treble) {
  const z = validateZone(zone);
  const t = clampTone(treble);
  const prefix = zonePrefix(z);
  const tStr = String(t).padStart(2, '0');
  const cmd = `<${prefix}TR${tStr}`;
  await writeCommand(cmd);
  return { zone: z, treble: t };
}

async function setZoneBass(zone, bass) {
  const z = validateZone(zone);
  const b = clampTone(bass);
  const prefix = zonePrefix(z);
  const bStr = String(b).padStart(2, '0');
  const cmd = `<${prefix}BS${bStr}`;
  await writeCommand(cmd);
  return { zone: z, bass: b };
}

async function setZoneBalance(zone, balance) {
  const z = validateZone(zone);
  const b = clampBalance(balance);
  const prefix = zonePrefix(z);
  const bStr = String(b).padStart(2, '0');
  const cmd = `<${prefix}BL${bStr}`;
  await writeCommand(cmd);
  return { zone: z, balance: b };
}

// --- API endpoints ----------------------------------------------------------

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Zone state: GET /api/state?zone=N
app.get('/api/state', async (req, res) => {
  try {
    const zone = req.query.zone;
    if (zone === undefined) {
      return res.status(400).json({ error: 'zone must be 1-6' });
    }
    const state = await getZoneState(zone);
    res.json({
      zone: state.zone,
      power: state.power,
      source: state.source,
      volume: state.volume,
      mute: state.mute,
      treble: state.treble,
      bass: state.bass,
      balance: state.balance
    });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'internal error' });
  }
});

// Power: POST /api/zone/:zone/power { on: true/false }
app.post('/api/zone/:zone/power', async (req, res) => {
  try {
    const zone = req.params.zone;
    const { on } = req.body;
    if (typeof on !== 'boolean') {
      return res.status(400).json({ error: 'on must be true or false' });
    }
    const result = await setZonePower(zone, on);
    res.json({ ok: true, zone: result.zone, power: result.power });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'internal error' });
  }
});

// Source: POST /api/zone/:zone/source { source: 1-6 }
app.post('/api/zone/:zone/source', async (req, res) => {
  try {
    const zone = req.params.zone;
    const { source } = req.body;
    const result = await setZoneSource(zone, source);
    res.json({ ok: true, zone: result.zone, source: result.source });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'internal error' });
  }
});

// Volume: POST /api/zone/:zone/volume { volume: 0-38 }
app.post('/api/zone/:zone/volume', async (req, res) => {
  try {
    const zone = req.params.zone;
    const { volume } = req.body;
    const result = await setZoneVolume(zone, volume);
    res.json({ ok: true, zone: result.zone, volume: result.volume });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'internal error' });
  }
});

// Mute: POST /api/zone/:zone/mute { mute: true/false }
app.post('/api/zone/:zone/mute', async (req, res) => {
  try {
    const zone = req.params.zone;
    const { mute } = req.body;
    if (typeof mute !== 'boolean') {
      return res.status(400).json({ error: 'mute must be true or false' });
    }
    const result = await setZoneMute(zone, mute);
    res.json({ ok: true, zone: result.zone, mute: result.mute });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'internal error' });
  }
});

// Treble: POST /api/zone/:zone/treble { treble: int }
app.post('/api/zone/:zone/treble', async (req, res) => {
  try {
    const zone = req.params.zone;
    const { treble } = req.body;
    const result = await setZoneTreble(zone, treble);
    res.json({ ok: true, zone: result.zone, treble: result.treble });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'internal error' });
  }
});

// Bass: POST /api/zone/:zone/bass { bass: int }
app.post('/api/zone/:zone/bass', async (req, res) => {
  try {
    const zone = req.params.zone;
    const { bass } = req.body;
    const result = await setZoneBass(zone, bass);
    res.json({ ok: true, zone: result.zone, bass: result.bass });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'internal error' });
  }
});

// Balance: POST /api/zone/:zone/balance { balance: int }
app.post('/api/zone/:zone/balance', async (req, res) => {
  try {
    const zone = req.params.zone;
    const { balance } = req.body;
    const result = await setZoneBalance(zone, balance);
    res.json({ ok: true, zone: result.zone, balance: result.balance });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'internal error' });
  }
});

// Config: GET /api/config
app.get('/api/config', (req, res) => {
  res.json(config);
});

// Config: PATCH /api/config (deep merge + validation)
app.patch('/api/config', (req, res) => {
  try {
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return res.status(400).json({ error: 'body must be an object' });
    }

    // Validate top-level keys
    const allowedTop = new Set(['theme', 'sourceNames', 'zones']);
    for (const key of Object.keys(body)) {
      if (!allowedTop.has(key)) {
        return res.status(400).json({ error: `unknown top-level key: ${key}` });
      }
    }

    // Validate theme if present
    if (body.theme && typeof body.theme !== 'string') {
      return res.status(400).json({ error: 'theme must be a string' });
    }

    // Validate sourceNames if present
    if (body.sourceNames) {
      if (typeof body.sourceNames !== 'object' || body.sourceNames === null) {
        return res.status(400).json({ error: 'sourceNames must be an object' });
      }
      for (const [k, v] of Object.entries(body.sourceNames)) {
        if (!['1', '2', '3', '4', '5', '6'].includes(k)) {
          return res.status(400).json({ error: `invalid source key: ${k}` });
        }
        if (typeof v !== 'string') {
          return res.status(400).json({ error: `sourceNames["${k}"] must be a string` });
        }
      }
    }

    // Validate zones if present
    if (body.zones) {
      if (typeof body.zones !== 'object' || body.zones === null) {
        return res.status(400).json({ error: 'zones must be an object' });
      }
      for (const [zoneKey, zoneVal] of Object.entries(body.zones)) {
        if (!['1', '2', '3', '4', '5', '6'].includes(zoneKey)) {
          return res.status(400).json({ error: `zone must be 1-6 (got ${zoneKey})` });
        }
        if (typeof zoneVal !== 'object' || zoneVal === null) {
          return res.status(400).json({ error: `zones["${zoneKey}"] must be an object` });
        }
        if (zoneVal.name && typeof zoneVal.name !== 'string') {
          return res.status(400).json({ error: `zones["${zoneKey}"].name must be a string` });
        }
        if (zoneVal.icon && typeof zoneVal.icon !== 'string') {
          return res.status(400).json({ error: `zones["${zoneKey}"].icon must be a string` });
        }
        if (zoneVal.maxVolume !== undefined) {
          const mv = Number(zoneVal.maxVolume);
          if (!Number.isFinite(mv) || mv < 0 || mv > 38) {
            return res.status(400).json({ error: `zones["${zoneKey}"].maxVolume must be 0-38` });
          }
        }
      }
    }

    // Merge into current config and persist
    config = deepMerge(config, body);
    writeConfig(config);
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message || 'internal error' });
  }
});

// --- systemd unit example ---------------------------------------------------
/**
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
 */

// --- Start server -----------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Monoprice 10761 controller listening on port ${PORT}`);
});