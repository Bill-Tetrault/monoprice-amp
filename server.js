#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const express = require('express');
const { SerialPort } = require('serialport');

const PORT = parseInt(process.env.PORT || '3000', 10);
const SERIAL_PATH = process.env.SERIAL_PATH || process.env.SERIALPATH || '/dev/ttyUSB0';
const CONFIG_PATH = process.env.CONFIG_PATH || process.env.CONFIGPATH || path.resolve('./config.json');
const TERMINATOR = Buffer.from([0x0d, 0x0a]);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DEFAULT_CONFIG = {
  title: 'Whole-Home Audio',
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
    '1': { name: 'Kitchen', icon: '🍽️', maxVolume: 38 },
    '2': { name: 'Laundry', icon: '🧺', maxVolume: 38 },
    '3': { name: 'Garage', icon: '🚗', maxVolume: 30 },
    '4': { name: 'Master Bedroom', icon: '🛏️', maxVolume: 38 },
    '5': { name: 'Bathroom', icon: '🛁', maxVolume: 38 },
    '6': { name: 'Patio', icon: '🌿', maxVolume: 30 }
  },
  automation: {
    enabled: true,
    defaultMinutes: 120,
    zones: {
      '1': { enabled: false, minutes: 120 },
      '2': { enabled: false, minutes: 120 },
      '3': { enabled: true, minutes: 120 },
      '4': { enabled: false, minutes: 120 },
      '5': { enabled: false, minutes: 120 },
      '6': { enabled: true, minutes: 120 }
    }
  }
};

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function deepMerge(target, src) {
  if (typeof src !== 'object' || src === null) return target;
  for (const key of Object.keys(src)) {
    const val = src[key];
    if (Array.isArray(val)) {
      target[key] = val.slice();
    } else if (typeof val === 'object' && val !== null) {
      if (typeof target[key] !== 'object' || target[key] === null || Array.isArray(target[key])) {
        target[key] = {};
      }
      deepMerge(target[key], val);
    } else {
      target[key] = val;
    }
  }
  return target;
}

function writeConfig(cfg) {
  const tmpPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmpPath, CONFIG_PATH);
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return deepMerge(deepClone(DEFAULT_CONFIG), parsed);
    }
  } catch (err) {
    console.error('Failed to read config, using defaults:', err.message);
  }
  try {
    writeConfig(DEFAULT_CONFIG);
  } catch (err) {
    console.error('Failed to seed config:', err.message);
  }
  return deepClone(DEFAULT_CONFIG);
}

let config = loadConfig();

const serialStatus = {
  online: false,
  path: SERIAL_PATH,
  lastError: null,
  openedAt: null,
  lastClosedAt: null,
  lastActivityAt: null
};

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
  console.log('[serial] open', SERIAL_PATH);
});

serial.on('close', () => {
  serialStatus.online = false;
  serialStatus.lastClosedAt = new Date().toISOString();
  console.log('[serial] closed');
});

serial.on('error', (err) => {
  serialStatus.online = false;
  serialStatus.lastError = err && err.message ? err.message : String(err);
  console.error('[serial] error', serialStatus.lastError);
});

serial.on('data', () => {
  serialStatus.lastActivityAt = new Date().toISOString();
});

let serialQueue = Promise.resolve();
const autoOffTimers = {};

function enqueueSerial(fn) {
  serialQueue = serialQueue.then(fn, fn);
  return serialQueue;
}

function ensureSerialOnline() {
  if (!serial.isOpen) {
    serialStatus.online = false;
    const err = new Error(`serial port offline (${SERIAL_PATH})`);
    err.statusCode = 503;
    throw err;
  }
}

function writeCommand(cmd) {
  return enqueueSerial(() => new Promise((resolve, reject) => {
    try {
      ensureSerialOnline();
      const payload = Buffer.concat([Buffer.from(cmd, 'ascii'), TERMINATOR]);
      serial.write(payload, (writeErr) => {
        if (writeErr) return reject(writeErr);
        serial.drain((drainErr) => {
          if (drainErr) return reject(drainErr);
          serialStatus.lastActivityAt = new Date().toISOString();
          resolve();
        });
      });
    } catch (err) {
      reject(err);
    }
  }));
}

function queryCommand(cmd) {
  return enqueueSerial(() => new Promise((resolve, reject) => {
    let buffer = '';
    let settleTimer = null;
    let timeoutTimer = null;
    let finished = false;

    function cleanup() {
      serial.off('data', onData);
      if (settleTimer) clearTimeout(settleTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }

    function finish(err, value) {
      if (finished) return;
      finished = true;
      cleanup();
      if (err) reject(err);
      else resolve(value);
    }

    function onData(chunk) {
      buffer += chunk.toString('ascii');
      serialStatus.lastActivityAt = new Date().toISOString();
      const idx = buffer.indexOf('#');
      if (idx !== -1) {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => finish(null, buffer.slice(0, idx)), 200);
      }
    }

    try {
      ensureSerialOnline();
      timeoutTimer = setTimeout(() => {
        const err = new Error(`query timeout waiting for amp response to ${cmd}`);
        err.statusCode = 504;
        finish(err);
      }, 2000);
      serial.on('data', onData);
      const payload = Buffer.concat([Buffer.from(cmd, 'ascii'), TERMINATOR]);
      serial.write(payload, (writeErr) => {
        if (writeErr) return finish(writeErr);
        serial.drain((drainErr) => {
          if (drainErr) return finish(drainErr);
        });
      });
    } catch (err) {
      finish(err);
    }
  }));
}

function zonePrefix(zone) {
  return `1${zone}`;
}

function parseZoneStatus(raw, zone) {
  if (!raw || raw[0] !== '>') throw new Error(`invalid status line: ${raw}`);
  const digits = raw.slice(1).replace(/[^0-9]/g, '');
  if (digits.length < 22) throw new Error(`status line too short: ${digits}`);
  const fields = [];
  for (let i = 0; i < 11; i += 1) fields.push(digits.slice(i * 2, i * 2 + 2));
  return {
    zone,
    zoneEcho: parseInt(fields[0], 10),
    power: fields[2] === '01',
    mute: fields[3] === '01',
    volume: parseInt(fields[5], 10),
    treble: parseInt(fields[6], 10),
    bass: parseInt(fields[7], 10),
    balance: parseInt(fields[8], 10),
    source: parseInt(fields[9], 10)
  };
}

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
  if (zoneCfg && typeof zoneCfg.maxVolume === 'number' && v > zoneCfg.maxVolume) v = zoneCfg.maxVolume;
  return Math.round(v);
}

function clampTone(value) {
  let v = Number(value);
  if (!Number.isFinite(v)) v = 0;
  if (v < 0) v = 0;
  if (v > 14) v = 14;
  return Math.round(v);
}

function clampBalance(value) {
  let v = Number(value);
  if (!Number.isFinite(v)) v = 10;
  if (v < 0) v = 0;
  if (v > 20) v = 20;
  return Math.round(v);
}

function getAutomationZone(zone) {
  if (!config.automation) config.automation = deepClone(DEFAULT_CONFIG.automation);
  if (!config.automation.zones) config.automation.zones = {};
  if (!config.automation.zones[String(zone)]) {
    config.automation.zones[String(zone)] = deepClone(DEFAULT_CONFIG.automation.zones[String(zone)] || { enabled: false, minutes: 120 });
  }
  return config.automation.zones[String(zone)];
}

function getAutoOffSettings(zone) {
  const globalAutomation = config.automation || DEFAULT_CONFIG.automation;
  const zoneAutomation = getAutomationZone(zone);
  const enabled = Boolean(globalAutomation.enabled && zoneAutomation.enabled);
  const minutes = Number(zoneAutomation.minutes ?? globalAutomation.defaultMinutes ?? 120);
  return { enabled, minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 120 };
}

function cancelAutoOff(zone) {
  const key = String(zone);
  if (autoOffTimers[key]) {
    clearTimeout(autoOffTimers[key]);
    autoOffTimers[key] = null;
  }
}

function scheduleAutoOff(zone) {
  const key = String(zone);
  const settings = getAutoOffSettings(zone);
  cancelAutoOff(zone);
  if (!settings.enabled) return;
  autoOffTimers[key] = setTimeout(async () => {
    try {
      const state = await getZoneState(zone);
      if (state.power) {
        await setZonePower(zone, false);
      }
    } catch (err) {
      console.error(`[autooff] zone ${zone} failed:`, err.message);
    } finally {
      autoOffTimers[key] = null;
    }
  }, settings.minutes * 60 * 1000);
}

async function getZoneState(zone) {
  const z = validateZone(zone);
  const raw = await queryCommand(`?${zonePrefix(z)}`);
  return parseZoneStatus(raw, z);
}

async function setZonePower(zone, on) {
  const z = validateZone(zone);
  await writeCommand(`${zonePrefix(z)}PR${on ? '01' : '00'}`);
  if (on) scheduleAutoOff(z);
  else cancelAutoOff(z);
  return { zone: z, power: !!on };
}

async function setZoneSource(zone, src) {
  const z = validateZone(zone);
  const s = validateSource(src);
  await writeCommand(`${zonePrefix(z)}CH${String(s).padStart(2, '0')}`);
  scheduleAutoOff(z);
  return { zone: z, source: s };
}

async function setZoneVolume(zone, vol) {
  const z = validateZone(zone);
  const v = clampVolume(z, vol);
  await writeCommand(`${zonePrefix(z)}VO${String(v).padStart(2, '0')}`);
  scheduleAutoOff(z);
  return { zone: z, volume: v };
}

async function setZoneMute(zone, mute) {
  const z = validateZone(zone);
  await writeCommand(`${zonePrefix(z)}MU${mute ? '01' : '00'}`);
  scheduleAutoOff(z);
  return { zone: z, mute: !!mute };
}

async function setZoneTreble(zone, treble) {
  const z = validateZone(zone);
  const t = clampTone(treble);
  await writeCommand(`${zonePrefix(z)}TR${String(t).padStart(2, '0')}`);
  scheduleAutoOff(z);
  return { zone: z, treble: t };
}

async function setZoneBass(zone, bass) {
  const z = validateZone(zone);
  const b = clampTone(bass);
  await writeCommand(`${zonePrefix(z)}BS${String(b).padStart(2, '0')}`);
  scheduleAutoOff(z);
  return { zone: z, bass: b };
}

async function setZoneBalance(zone, balance) {
  const z = validateZone(zone);
  const b = clampBalance(balance);
  await writeCommand(`${zonePrefix(z)}BL${String(b).padStart(2, '0')}`);
  scheduleAutoOff(z);
  return { zone: z, balance: b };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/serial-status', (_req, res) => {
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
    const { zone } = req.query;
    if (zone === undefined) return res.status(400).json({ error: 'zone must be 1-6' });
    const state = await getZoneState(zone);
    res.json(state);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'internal error' });
  }
});

app.post('/api/zone/:zone/power', async (req, res) => {
  try {
    if (typeof req.body.on !== 'boolean') return res.status(400).json({ error: 'on must be true or false' });
    const result = await setZonePower(req.params.zone, req.body.on);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'internal error' });
  }
});

app.post('/api/zone/:zone/source', async (req, res) => {
  try {
    const result = await setZoneSource(req.params.zone, req.body.source);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'internal error' });
  }
});

app.post('/api/zone/:zone/volume', async (req, res) => {
  try {
    const result = await setZoneVolume(req.params.zone, req.body.volume);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'internal error' });
  }
});

app.post('/api/zone/:zone/mute', async (req, res) => {
  try {
    if (typeof req.body.mute !== 'boolean') return res.status(400).json({ error: 'mute must be true or false' });
    const result = await setZoneMute(req.params.zone, req.body.mute);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'internal error' });
  }
});

app.post('/api/zone/:zone/treble', async (req, res) => {
  try {
    const result = await setZoneTreble(req.params.zone, req.body.treble);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'internal error' });
  }
});

app.post('/api/zone/:zone/bass', async (req, res) => {
  try {
    const result = await setZoneBass(req.params.zone, req.body.bass);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'internal error' });
  }
});

app.post('/api/zone/:zone/balance', async (req, res) => {
  try {
    const result = await setZoneBalance(req.params.zone, req.body.balance);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'internal error' });
  }
});

app.get('/api/config', (_req, res) => {
  res.json(config);
});

app.patch('/api/config', (req, res) => {
  try {
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return res.status(400).json({ error: 'body must be an object' });
    }

    const allowedTop = new Set(['title', 'theme', 'sourceNames', 'zones', 'automation']);
    for (const key of Object.keys(body)) {
      if (!allowedTop.has(key)) return res.status(400).json({ error: `unknown top-level key: ${key}` });
    }

    if (body.title !== undefined && typeof body.title !== 'string') {
      return res.status(400).json({ error: 'title must be a string' });
    }

    if (body.theme !== undefined && body.theme !== 'light' && body.theme !== 'dark') {
      return res.status(400).json({ error: 'theme must be light or dark' });
    }

    if (body.zones) {
      for (const [zoneKey, zoneVal] of Object.entries(body.zones)) {
        if (!['1', '2', '3', '4', '5', '6'].includes(zoneKey)) return res.status(400).json({ error: `zone must be 1-6, got ${zoneKey}` });
        if (typeof zoneVal !== 'object' || zoneVal === null || Array.isArray(zoneVal)) return res.status(400).json({ error: `zones.${zoneKey} must be an object` });
        if (zoneVal.name !== undefined && typeof zoneVal.name !== 'string') return res.status(400).json({ error: `zones.${zoneKey}.name must be a string` });
        if (zoneVal.icon !== undefined && typeof zoneVal.icon !== 'string') return res.status(400).json({ error: `zones.${zoneKey}.icon must be a string` });
        if (zoneVal.maxVolume !== undefined) {
          const mv = Number(zoneVal.maxVolume);
          if (!Number.isFinite(mv) || mv < 0 || mv > 38) return res.status(400).json({ error: `zones.${zoneKey}.maxVolume must be 0-38` });
          zoneVal.maxVolume = Math.round(mv);
        }
      }
    }

    if (body.sourceNames) {
      for (const [sourceKey, value] of Object.entries(body.sourceNames)) {
        if (!['1', '2', '3', '4', '5', '6'].includes(sourceKey)) return res.status(400).json({ error: `invalid source key ${sourceKey}` });
        if (typeof value !== 'string') return res.status(400).json({ error: `sourceNames.${sourceKey} must be a string` });
      }
    }

    if (body.automation !== undefined) {
      const a = body.automation;
      if (typeof a !== 'object' || a === null || Array.isArray(a)) return res.status(400).json({ error: 'automation must be an object' });
      if (a.enabled !== undefined && typeof a.enabled !== 'boolean') return res.status(400).json({ error: 'automation.enabled must be true or false' });
      if (a.defaultMinutes !== undefined) {
        const minutes = Number(a.defaultMinutes);
        if (!Number.isFinite(minutes) || minutes < 1) return res.status(400).json({ error: 'automation.defaultMinutes must be >= 1' });
        a.defaultMinutes = Math.round(minutes);
      }
      if (a.zones !== undefined) {
        for (const [zoneKey, zoneVal] of Object.entries(a.zones)) {
          if (!['1', '2', '3', '4', '5', '6'].includes(zoneKey)) return res.status(400).json({ error: `automation zone must be 1-6, got ${zoneKey}` });
          if (typeof zoneVal !== 'object' || zoneVal === null || Array.isArray(zoneVal)) return res.status(400).json({ error: `automation.zones.${zoneKey} must be an object` });
          if (zoneVal.enabled !== undefined && typeof zoneVal.enabled !== 'boolean') return res.status(400).json({ error: `automation.zones.${zoneKey}.enabled must be true or false` });
          if (zoneVal.minutes !== undefined) {
            const minutes = Number(zoneVal.minutes);
            if (!Number.isFinite(minutes) || minutes < 1) return res.status(400).json({ error: `automation.zones.${zoneKey}.minutes must be >= 1` });
            zoneVal.minutes = Math.round(minutes);
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