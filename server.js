const fs = require('fs');
const path = require('path');
const express = require('express');
const { SerialPort, ReadlineParser } = require('serialport');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 3000);
const SERIAL_PATH = process.env.SERIAL_PATH || '/dev/ttyUSB0';
const BAUD_RATE = Number(process.env.BAUD_RATE || 9600);
const CONTROLLER_ID = String(process.env.CONTROLLER_ID || '1');
const SERIAL_OPEN_TIMEOUT_MS = Number(process.env.SERIAL_OPEN_TIMEOUT_MS || 5000);
const RESPONSE_TIMEOUT_MS = Number(process.env.RESPONSE_TIMEOUT_MS || 2500);
const RECONCILE_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS || 60000);
const CONFIG_PATH = path.join(__dirname, 'config.json');
const ZONES = [1, 2, 3, 4, 5, 6];
const DEFAULT_ZONE_NAMES = {
  1: 'Kitchen',
  2: 'Living Room',
  3: 'Office',
  4: 'Primary Bedroom',
  5: 'Patio',
  6: 'Outdoors'
};
const DEFAULT_ZONE_ICONS = {
  1: '🍳',
  2: '🛋️',
  3: '💻',
  4: '🛏️',
  5: '🌿',
  6: '🌤️'
};

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return normalizeConfig(parsed);
  } catch {
    return normalizeConfig({});
  }
}

function normalizeConfig(input) {
  const cfg = input && typeof input === 'object' ? input : {};
  const zoneNames = {};
  const zoneIcons = {};
  const sourceNames = {};
  const autoOff = {};
  for (const zone of ZONES) {
    const key = String(zone);
    zoneNames[key] = cfg.zoneNames?.[key] || DEFAULT_ZONE_NAMES[zone];
    zoneIcons[key] = cfg.zoneIcons?.[key] || DEFAULT_ZONE_ICONS[zone];
    autoOff[key] = {
      enabled: zone === 6 ? true : Boolean(cfg.autoOff?.[key]?.enabled),
      minutes: zone === 6 ? Number(cfg.autoOff?.[key]?.minutes || 120) : Number(cfg.autoOff?.[key]?.minutes || 0)
    };
  }
  for (let i = 1; i <= 6; i++) sourceNames[String(i)] = cfg.sourceNames?.[String(i)] || `Source ${i}`;
  return {
    zoneNames,
    zoneIcons,
    sourceNames,
    theme: cfg.theme === 'light' ? 'light' : 'dark',
    autoOff,
    presets: cfg.presets && typeof cfg.presets === 'object' ? cfg.presets : {}
  };
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

let config = loadConfig();
const zoneState = new Map();
const zoneActivity = new Map();
let serialReady = false;
let pendingResolvers = [];

const port = new SerialPort({ path: SERIAL_PATH, baudRate: BAUD_RATE, autoOpen: false });
const parser = port.pipe(new ReadlineParser({ delimiter: '\r' }));
const responseQueue = [];

function resolveSerialReady(value) {
  serialReady = value;
  if (value) {
    const waiting = pendingResolvers;
    pendingResolvers = [];
    waiting.forEach(resolve => resolve(true));
  }
}

port.on('open', () => {
  console.log(`[server] Serial open on ${SERIAL_PATH}`);
  resolveSerialReady(true);
});

port.on('close', () => {
  console.warn('[server] Serial closed');
  serialReady = false;
});

port.on('error', err => {
  console.error('[server] Serial error:', err.message);
  serialReady = false;
});

parser.on('data', line => {
  const cleaned = String(line || '').trim();
  if (!cleaned || cleaned === '#') return;
  const pending = responseQueue.shift();
  if (pending) pending.resolve(cleaned);
});

function openSerial() {
  if (port.isOpen) return Promise.resolve();
  return new Promise((resolve, reject) => {
    port.open(err => (err ? reject(err) : resolve()));
  });
}

async function waitForSerialReady() {
  if (serialReady && port.isOpen) return true;
  try {
    if (!port.isOpen) await openSerial();
  } catch (err) {
    throw new Error(`Serial open failed: ${err.message}`);
  }
  if (serialReady && port.isOpen) return true;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Serial adapter not ready')), SERIAL_OPEN_TIMEOUT_MS);
    pendingResolvers.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function zoneId(zone) {
  return `${CONTROLLER_ID}${zone}`;
}

function writeCommand(cmd) {
  return new Promise((resolve, reject) => {
    port.write(cmd, err => {
      if (err) return reject(err);
      port.drain(drainErr => (drainErr ? reject(drainErr) : resolve()));
    });
  });
}

async function sendCommand(cmd, expectResponse = true) {
  await waitForSerialReady();
  if (!expectResponse) {
    await writeCommand(cmd);
    return null;
  }
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Serial timeout waiting for response to ${JSON.stringify(cmd.trim())}`)), RESPONSE_TIMEOUT_MS);
    responseQueue.push({
      resolve: value => {
        clearTimeout(timer);
        resolve(value);
      }
    });
    try {
      await writeCommand(cmd);
    } catch (err) {
      clearTimeout(timer);
      responseQueue.pop();
      reject(err);
    }
  });
}

function normalizeBool(v) {
  return v === true || v === '1' || v === 1 || v === 'on';
}

function parseZoneStatus(raw) {
  const zone = Number(raw.slice(1, 3).slice(1, 2));
  return {
    zone,
    power: /PR0?1/i.test(raw),
    mute: /MU0?1/i.test(raw),
    source: Number((raw.match(/CH0?(\d)/i) || [])[1] || 1),
    volume: Number((raw.match(/VO(\d{2})/i) || [])[1] || 10),
    treble: Number((raw.match(/TR(\d{2})/i) || [])[1] || 10),
    bass: Number((raw.match(/BS(\d{2})/i) || [])[1] || 10),
    balance: Number((raw.match(/BL(\d{2})/i) || [])[1] || 10)
  };
}

function touchZone(zone) {
  zoneActivity.set(String(zone), Date.now());
}

async function queryZone(zone) {
  const raw = await sendCommand(`?${zoneId(zone)}\r`, true);
  const parsed = parseZoneStatus(raw);
  zoneState.set(String(zone), parsed);
  if (parsed.power) touchZone(zone);
  return parsed;
}

async function setZone(zone, patch) {
  const current = zoneState.get(String(zone)) || await queryZone(zone);
  const commands = [];
  if (patch.power !== undefined) commands.push(`<${zoneId(zone)}PR${normalizeBool(patch.power) ? '01' : '00'}\r`);
  if (patch.mute !== undefined) commands.push(`<${zoneId(zone)}MU${normalizeBool(patch.mute) ? '01' : '00'}\r`);
  if (patch.source !== undefined) commands.push(`<${zoneId(zone)}CH0${Number(patch.source)}\r`);
  if (patch.volume !== undefined && Number(patch.volume) !== Number(current.volume)) commands.push(`<${zoneId(zone)}VO${String(Number(patch.volume)).padStart(2, '0')}\r`);
  if (patch.treble !== undefined) commands.push(`<${zoneId(zone)}TR${String(Number(patch.treble)).padStart(2, '0')}\r`);
  if (patch.bass !== undefined) commands.push(`<${zoneId(zone)}BS${String(Number(patch.bass)).padStart(2, '0')}\r`);
  if (patch.balance !== undefined) commands.push(`<${zoneId(zone)}BL${String(Number(patch.balance)).padStart(2, '0')}\r`);
  for (const cmd of commands) await sendCommand(cmd, false);
  touchZone(zone);
  return queryZone(zone);
}

async function reconcileZones() {
  if (!serialReady || !port.isOpen) return;
  for (const zone of ZONES) {
    try {
      const before = zoneState.get(String(zone));
      const after = await queryZone(zone);
      if (JSON.stringify(before) !== JSON.stringify(after) && after.power) touchZone(zone);
    } catch (err) {
      console.warn(`[server] reconcile zone ${zone} failed: ${err.message}`);
    }
  }
}

async function enforceAutoOff() {
  const now = Date.now();
  for (const zone of ZONES) {
    const key = String(zone);
    const rule = config.autoOff[key];
    const state = zoneState.get(key);
    if (!rule?.enabled || !rule?.minutes || !state?.power) continue;
    const last = zoneActivity.get(key) || now;
    if (now - last >= rule.minutes * 60000) {
      try {
        await setZone(zone, { power: false });
      } catch (err) {
        console.warn(`[server] auto-off zone ${zone} failed: ${err.message}`);
      }
    }
  }
}

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.put('/api/config', (req, res) => {
  config = normalizeConfig({ ...config, ...req.body });
  saveConfig();
  res.json(config);
});

app.get('/api/zones', async (req, res) => {
  try {
    const data = await Promise.all(ZONES.map(queryZone));
    res.json({ zones: data });
  } catch (err) {
    const status = /not ready/i.test(err.message) ? 503 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.get('/api/zones/:zone', async (req, res) => {
  try {
    const zone = Number(req.params.zone);
    res.json(await queryZone(zone));
  } catch (err) {
    const status = /not ready/i.test(err.message) ? 503 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.put('/api/zones/:zone', async (req, res) => {
  try {
    const zone = Number(req.params.zone);
    res.json(await setZone(zone, req.body || {}));
  } catch (err) {
    const status = /not ready/i.test(err.message) ? 503 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`[server] Listening on http://0.0.0.0:${PORT}`);
  try {
    await waitForSerialReady();
    await Promise.all(ZONES.map(queryZone));
  } catch (err) {
    console.warn('[server] startup sync skipped:', err.message);
  }
});

setInterval(() => { reconcileZones(); }, RECONCILE_INTERVAL_MS);
setInterval(() => { enforceAutoOff(); }, 30000);
