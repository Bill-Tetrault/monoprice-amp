#!/usr/bin/env node
/**
 * Monoprice 10761 Web Controller
 *
 * Backend: Node.js + Express
 * - Controls the Monoprice 10761 6-zone whole-home audio amplifier over RS-232.
 * - Exposes a REST API for zone power, source, volume, tone, balance, and mute.
 * - Maintains a server-side JSON config for UI theme, source names, zone metadata,
 *   and per-zone auto-off timers.
 *
 * IMPORTANT RS-232 NOTES (validated):
 * - 9600 baud, 8-N-1, straight-through DB9, CR+LF terminator (0x0D 0x0A).
 * - Zone prefix = "1<Z>" where 1 is controller ID and Z is single-digit zone (1–6).
 *   Example: zone 1 -> "11", zone 6 -> "16".
 * - Query:   ?1<Z>\r\n       e.g. "?11\r\n"
 * - Power:   <1<Z>PR01\r\n   on / <1<Z>PR00\r\n off
 * - Source:  <1<Z>CH0N\r\n   01–06
 * - Volume:  <1<Z>VO##\r\n   00–38
 * - Tone, balance, mute follow the same "<1<Z>XX##" pattern.
 *
 * Query commands:
 * - Amp echoes sent bytes, then '#', then a line that starts with '>' and
 *   contains 22 ASCII digits (11 × 2-digit fields).
 *
 * Set commands:
 * - Amp does NOT send a '>' status line; it just echoes bytes.
 *   We therefore only wait for serial.drain() and do not attempt to parse a
 *   response for set commands.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { SerialPort } = require('serialport');

const PORT = parseInt(process.env.PORT || '3000', 10);
const SERIAL_PATH = process.env.SERIAL_PATH || '/dev/ttyUSB0';
const CONFIG_PATH = process.env.CONFIG_PATH || path.resolve('./config.json');

// CR+LF terminator required by the amp.
const TERMINATOR = Buffer.from([0x0D, 0x0A]);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Default UI + automation config.
 * This is used to seed config.json on first run and to fill in missing keys
 * when loading an existing config file.
 */
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
    '1': { name: 'Kitchen',        icon: '🍳', maxVolume: 38 },
    '2': { name: 'Laundry',        icon: '🧺', maxVolume: 38 },
    '3': { name: 'Garage',         icon: '🚗', maxVolume: 30 },
    '4': { name: 'Master Bedroom', icon: '🛏️', maxVolume: 38 },
    '5': { name: 'Bathroom',       icon: '🛁', maxVolume: 38 },
    '6': { name: 'Patio',          icon: '🌿', maxVolume: 30 }
  },
  automation: {
    enabled: true,
    defaultMinutes: 120,
    zones: {
      '1': { enabled: false, minutes: 120 },
      '2': { enabled: false, minutes: 120 },
      '3': { enabled: true,  minutes: 120 },
      '4': { enabled: false, minutes: 120 },
      '5': { enabled: false, minutes: 120 },
      '6': { enabled: true,  minutes: 120 }
    }
  }
};

let config = loadConfig();

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      // Deep merge user config over defaults.
      return deepMerge(structuredClone(DEFAULT_CONFIG), parsed);
    }
  } catch (err) {
    console.error('Failed to read config.json, using defaults:', err);
  }

  try {
    writeConfig(DEFAULT_CONFIG);
  } catch (err) {
    console.error('Failed to write default config.json:', err);
  }

  return structuredClone(DEFAULT_CONFIG);
}

function writeConfig(cfg) {
  const tmpPath = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmpPath, CONFIG_PATH);
}

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

/**
 * Serial connection status for the frontend banner.
 */
const serialStatus = {
  online: false,
  path: SERIAL_PATH,
  lastError: null,
  openedAt: null,
  lastClosedAt: null,
  lastActivityAt: null
};

/**
 * Raw Buffer mode SerialPort.
 * No parser pipes, we consume 'data' events directly.
 */
const serial = new SerialPort({
  path: SERIAL_PATH,
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  autoOpen: true
});

serial.on('open', () => {
  serialStatus.online = true;
  serialStatus.lastError = null;
  serialStatus.openedAt = new Date().toISOString();
  console.log(`Serial port open: ${SERIAL_PATH}`);
});

serial.on('close', () => {
  serialStatus.online = false;
  serialStatus.lastClosedAt = new Date().toISOString();
  console.warn(`Serial port closed: ${SERIAL_PATH}`);
});

serial.on('error', (err) => {
  serialStatus.online = false;
  serialStatus.lastError = err && err.message ? err.message : String(err);
  console.error('Serial error:', err);
});

serial.on('data', () => {
  serialStatus.lastActivityAt = new Date().toISOString();
});

/**
 * Serial transaction queue – ensures RS-232 commands never overlap.
 */
let serialQueue = Promise.resolve();

function enqueueSerial(fn) {
  serialQueue = serialQueue.then(() => fn());
  return serialQueue;
}

function ensureSerialOnline() {
  if (!serial.isOpen) {
    serialStatus.online = false;
    const err = new Error(`serial port offline: ${SERIAL_PATH}`);
    err.statusCode = 503;
    throw err;
  }
}

/**
 * Write a set-command (power/source/volume/tone/balance/mute).
 * Appends CR+LF, waits for drain, does not expect a '>' response.
 */
function writeCommand(cmd) {
  return enqueueSerial(() => new Promise((resolve, reject) => {
    try {
      ensureSerialOnline();
      const buf = Buffer.from(cmd, 'ascii');
      const payload = Buffer.concat([buf, TERMINATOR]);

      serial.write(payload, (writeErr) => {
        if (writeErr) {
          serialStatus.online = serial.isOpen;
          serialStatus.lastError = writeErr.message || String(writeErr);
          return reject(writeErr);
        }

        serial.drain((drainErr) => {
          if (drainErr) {
            serialStatus.online = serial.isOpen;
            serialStatus.lastError = drainErr.message || String(drainErr);
            return reject(drainErr);
          }

          serialStatus.lastActivityAt = new Date().toISOString();
          resolve();
        });
      });
    } catch (err) {
      reject(err);
    }
  }));
}

/**
 * Send a query command (?1Z) and resolve with the full '>...' response line.
 * Accumulates raw 'data' chunks, waits 200 ms after '>' appears to let the
 * buffer settle, then slices from '>' onward.
 */
function queryCommand(cmd) {
  return enqueueSerial(() => new Promise((resolve, reject) => {
    let buffer = '';
    let settleTimer = null;
    let timeoutTimer = null;
    let finished = false;

    function finish(err, value) {
      if (finished) return;
      finished = true;
      cleanup();
      if (err) reject(err);
      else resolve(value);
    }

    function cleanup() {
      serial.off('data', onData);
      if (settleTimer) clearTimeout(settleTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }

    function onData(chunk) {
      buffer += chunk.toString('ascii');
      serialStatus.lastActivityAt = new Date().toISOString();

      const idx = buffer.indexOf('>');
      if (idx !== -1) {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          const response = buffer.slice(idx);
          finish(null, response);
        }, 200);
      }
    }

    try {
      ensureSerialOnline();

      timeoutTimer = setTimeout(() => {
        const err = new Error(`query timeout waiting for amp response to "${cmd}"`);
        err.statusCode = 504;
        finish(err);
      }, 2000);

      serial.on('data', onData);

      const buf = Buffer.from(cmd, 'ascii');
      const payload = Buffer.concat([buf, TERMINATOR]);

      serial.write(payload, (writeErr) => {
        if (writeErr) {
          serialStatus.online = serial.isOpen;
          serialStatus.lastError = writeErr.message || String(writeErr);
          return finish(writeErr);
        }

        serial.drain((drainErr) => {
          if (drainErr) {
            serialStatus.online = serial.isOpen;
            serialStatus.lastError = drainErr.message || String(drainErr);
            return finish(drainErr);
          }
        });
      });
    } catch (err) {
      finish(err);
    }
  }));
}

/**
 * Build the "1Z" prefix (controller 1 + single-digit zone).
 */
function zonePrefix(zone) {
  return `1${zone}`;
}

/**
 * Parse a raw ">1100000000111111100401" status line into fields.
 */
function parseZoneStatus(raw, zone) {
  if (!raw || raw[0] !== '>') {
    throw new Error('Invalid status line: ' + raw);
  }

  const digits = raw.slice(1).replace(/[^\d]/g, '');
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

/**
 * Auto-off timer map: { [zone]: timeoutId }
 */
const autoOffTimers = {};

/**
 * Helpers for validation and clamping.
 */
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

  const zoneCfg = config.zones[String(zone)];
  if (zoneCfg && typeof zoneCfg.maxVolume === 'number') {
    if (v > zoneCfg.maxVolume) v = zoneCfg.maxVolume;
  }
  return v;
}

function clampTone(value) {
  let v = Number(value);
  if (!Number.isFinite(v)) v = 0;
  if (v < 0) v = 0;
  if (v > 14) v = 14;
  return v;
}

function clampBalance(value) {
  let v = Number(value);
  if (!Number.isFinite(v)) v = 10;
  if (v < 0) v = 0;
  if (v > 20) v = 20;
  return v;
}

/**
 * Automation helpers – read enable/minutes from config.automation.
 */
function getAutoOffSettings(zone) {
  const global = config.automation || {};
  const perZone = global.zones?.[String(zone)] || {};
  const enabled = Boolean(global.enabled && perZone.enabled);
  const minutesRaw = perZone.minutes ?? global.defaultMinutes ?? 120;
  const minutes = Number(minutesRaw);
  return {
    enabled,
    minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 120
  };
}

function cancelAutoOff(zone) {
  const key = String(zone);
  if (autoOffTimers[key]) {
    clearTimeout(autoOffTimers[key]);
    autoOffTimers[key] = null;
  }
}

/**
 * Schedule auto-off for a zone:
 * - Clears any existing timer.
 * - If automation disabled, does nothing.
 * - Otherwise schedules a setTimeout that re-queries the zone and powers it
 *   off if still on.
 */
function scheduleAutoOff(zone) {
  const key = String(zone);
  const settings = getAutoOffSettings(zone);

  cancelAutoOff(zone);

  if (!settings.enabled) return;

  const ms = settings.minutes * 60 * 1000;
  autoOffTimers[key] = setTimeout(async () => {
    try {
      const state = await getZoneState(zone);
      if (state.power) {
        await setZonePower(zone, false);
        console.log(
          `Auto-off: zone ${zone} powered off after ${settings.minutes} minutes.`
        );
      }
    } catch (err) {
      console.error('Auto-off failed for zone', zone, err);
    } finally {
      autoOffTimers[key] = null;
    }
  }, ms);
}

/**
 * High-level helpers.
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

  if (on) scheduleAutoOff(z);
  else cancelAutoOff(z);

  return { zone: z, power: !!on };
}

async function setZoneSource(zone, src) {
  const z = validateZone(zone);
  const s = validateSource(src);
  const prefix = zonePrefix(z);
  const srcStr = String(s).padStart(2, '0');
  const cmd = `<${prefix}CH${srcStr}`;
  await writeCommand(cmd);
  scheduleAutoOff(z);
  return { zone: z, source: s };
}

async function setZoneVolume(zone, vol) {
  const z = validateZone(zone);
  const v = clampVolume(z, vol);
  const prefix = zonePrefix(z);
  const volStr = String(v).padStart(2, '0');
  const cmd = `<${prefix}VO${volStr}`;
  await writeCommand(cmd);
  scheduleAutoOff(z);
  return { zone: z, volume: v };
}

async function setZoneMute(zone, mute) {
  const z = validateZone(zone);
  const prefix = zonePrefix(z);
  const cmd = `<${prefix}MU${mute ? '01' : '00'}`;
  await writeCommand(cmd);
  scheduleAutoOff(z);
  return { zone: z, mute: !!mute };
}

async function setZoneTreble(zone, treble) {
  const z = validateZone(zone);
  const t = clampTone(treble);
  const prefix = zonePrefix(z);
  const tStr = String(t).padStart(2, '0');
  const cmd = `<${prefix}TR${tStr}`;
  await writeCommand(cmd);
  scheduleAutoOff(z);
  return { zone: z, treble: t };
}

async function setZoneBass(zone, bass) {
  const z = validateZone(zone);
  const b = clampTone(bass);
  const prefix = zonePrefix(z);
  const bStr = String(b).padStart(2, '0');
  const cmd = `<${prefix}BS${bStr}`;
  await writeCommand(cmd);
  scheduleAutoOff(z);
  return { zone: z, bass: b };
}

async function setZoneBalance(zone, balance) {
  const z = validateZone(zone);
  const b = clampBalance(balance);
  const prefix = zonePrefix(z);
  const bStr = String(b).padStart(2, '0');
  const cmd = `<${prefix}BL${bStr}`;
  await writeCommand(cmd);
  scheduleAutoOff(z);
  return { zone: z, balance: b };
}

/**
 * API endpoints.
 */

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/serial-status', (req, res) => {
  res.json({
    online: serial.isOpen,
    path: serialStatus.path,
    lastError: serialStatus.lastError,
    openedAt: serialStatus.openedAt,
    lastClosedAt: serialStatus.lastClosedAt,
    lastActivityAt: serialStatus.lastActivityAt
  });
});

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
    res.status(err.statusCode || 500).json({ error: err.message || 'internal error' });
  }
});

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
    res.status(err.statusCode || 500).json({ error: err.message || 'internal error' });
  }
});

app.post('/api/zone/:zone/source', async (req, res) => {
  try {
    const zone = req.params.zone;
    const { source } = req.body;
    const result = await setZoneSource(zone, source);
    res.json({ ok: true, zone: result.zone, source: result.source });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'internal error' });
  }
});

app.post('/api/zone/:zone/volume', async (req, res) => {
  try {
    const zone = req.params.zone;
    const { volume } = req.body;
    const result = await setZoneVolume(zone, volume);
    res.json({ ok: true, zone: result.zone, volume: result.volume });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'internal error' });
  }
});

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
    res.status(err.statusCode || 500).json({ error: err.message || 'internal error' });
  }
});

app.post('/api/zone/:zone/treble', async (req, res) => {
  try {
    const zone = req.params.zone;
    const { treble } = req.body;
    const result = await setZoneTreble(zone, treble);
    res.json({ ok: true, zone: result.zone, treble: result.treble });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'internal error' });
  }
});

app.post('/api/zone/:zone/bass', async (req, res) => {
  try {
    const zone = req.params.zone;
    const { bass } = req.body;
    const result = await setZoneBass(zone, bass);
    res.json({ ok: true, zone: result.zone, bass: result.bass });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'internal error' });
  }
});

app.post('/api/zone/:zone/balance', async (req, res) => {
  try {
    const zone = req.params.zone;
    const { balance } = req.body;
    const result = await setZoneBalance(zone, balance);
    res.json({ ok: true, zone: result.zone, balance: result.balance });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'internal error' });
  }
});

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.patch('/api/config', (req, res) => {
  try {
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return res.status(400).json({ error: 'body must be an object' });
    }

    const allowedTop = new Set(['theme', 'sourceNames', 'zones', 'automation']);
    for (const key of Object.keys(body)) {
      if (!allowedTop.has(key)) {
        return res.status(400).json({ error: `unknown top-level key: ${key}` });
      }
    }

    if (body.theme !== undefined) {
      if (body.theme !== 'light' && body.theme !== 'dark') {
        return res.status(400).json({ error: 'theme must be "light" or "dark"' });
      }
    }

    if (body.sourceNames) {
      if (typeof body.sourceNames !== 'object' || body.sourceNames === null || Array.isArray(body.sourceNames)) {
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

    if (body.zones) {
      if (typeof body.zones !== 'object' || body.zones === null || Array.isArray(body.zones)) {
        return res.status(400).json({ error: 'zones must be an object' });
      }
      for (const [zoneKey, zoneVal] of Object.entries(body.zones)) {
        if (!['1', '2', '3', '4', '5', '6'].includes(zoneKey)) {
          return res.status(400).json({ error: `zone must be 1-6 (got ${zoneKey})` });
        }
        if (typeof zoneVal !== 'object' || zoneVal === null || Array.isArray(zoneVal)) {
          return res.status(400).json({ error: `zones["${zoneKey}"] must be an object` });
        }
        if (zoneVal.name !== undefined && typeof zoneVal.name !== 'string') {
          return res.status(400).json({ error: `zones["${zoneKey}"].name must be a string` });
        }
        if (zoneVal.icon !== undefined && typeof zoneVal.icon !== 'string') {
          return res.status(400).json({ error: `zones["${zoneKey}"].icon must be a string` });
        }
        if (zoneVal.maxVolume !== undefined) {
          const mv = Number(zoneVal.maxVolume);
          if (!Number.isFinite(mv) || mv < 0 || mv > 38) {
            return res.status(400).json({ error: `zones["${zoneKey}"].maxVolume must be 0-38` });
          }
          zoneVal.maxVolume = mv;
        }
      }
    }

    if (body.automation !== undefined) {
      const a = body.automation;
      if (typeof a !== 'object' || a === null || Array.isArray(a)) {
        return res.status(400).json({ error: 'automation must be an object' });
      }
      if (a.enabled !== undefined && typeof a.enabled !== 'boolean') {
        return res.status(400).json({ error: 'automation.enabled must be true or false' });
      }
      if (a.defaultMinutes !== undefined) {
        const minutes = Number(a.defaultMinutes);
        if (!Number.isFinite(minutes) || minutes < 1) {
          return res.status(400).json({ error: 'automation.defaultMinutes must be >= 1' });
        }
        a.defaultMinutes = minutes;
      }
      if (a.zones !== undefined) {
        if (typeof a.zones !== 'object' || a.zones === null || Array.isArray(a.zones)) {
          return res.status(400).json({ error: 'automation.zones must be an object' });
        }
        for (const [zoneKey, zoneVal] of Object.entries(a.zones)) {
          if (!['1', '2', '3', '4', '5', '6'].includes(zoneKey)) {
            return res.status(400).json({ error: `automation zone must be 1-6 (got ${zoneKey})` });
          }
          if (typeof zoneVal !== 'object' || zoneVal === null || Array.isArray(zoneVal)) {
            return res.status(400).json({ error: `automation.zones["${zoneKey}"] must be an object` });
          }
          if (zoneVal.enabled !== undefined && typeof zoneVal.enabled !== 'boolean') {
            return res.status(400).json({ error: `automation.zones["${zoneKey}"].enabled must be true or false` });
          }
          if (zoneVal.minutes !== undefined) {
            const minutes = Number(zoneVal.minutes);
            if (!Number.isFinite(minutes) || minutes < 1) {
              return res.status(400).json({ error: `automation.zones["${zoneKey}"].minutes must be >= 1` });
            }
            zoneVal.minutes = minutes;
          }
        }
      }
    }

    config = deepMerge(config, body);
    writeConfig(config);
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message || 'internal error' });
  }
});

app.listen(PORT, () => {
  console.log(`Monoprice 10761 controller listening on port ${PORT}`);
  console.log(`Configured serial path: ${SERIAL_PATH}`);
});