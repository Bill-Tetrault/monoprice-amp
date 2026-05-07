'use strict';

/**
 * server.js – Monoprice 10761 Six-Zone Amplifier Web Controller
 *
 * RS-232 protocol notes (validated against real hardware):
 *   - Baud: 9600, 8-N-1, straight-through DB9 cable (NOT null-modem)
 *   - Every command terminated with CR+LF (0x0D 0x0A) – neither alone works
 *   - Zone prefix: controller-id (1) + single-digit zone (1-6) → "11".."16"
 *     NOTE: Do NOT use the two-digit zone format (11-16) from some manuals;
 *           it causes "Command Error." on this unit.
 *   - Query response: echo bytes + '#' + '>' + 22 ASCII digits
 *   - Set commands (power/source/volume) produce NO response – drain only
 */

const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const { SerialPort } = require('serialport');

// ─── Environment / defaults ────────────────────────────────────────────────
const PORT        = parseInt(process.env.PORT        || '3000', 10);
const SERIAL_PATH = process.env.SERIAL_PATH          || '/dev/ttyUSB0';
const CONFIG_PATH = process.env.CONFIG_PATH          || path.join(__dirname, 'config.json');

// ─── Config defaults ───────────────────────────────────────────────────────
const CONFIG_DEFAULTS = {
  theme: 'dark',
  sourceNames: {
    '1': 'Source 1', '2': 'Source 2', '3': 'Source 3',
    '4': 'Source 4', '5': 'Source 5', '6': 'Source 6'
  },
  zones: {
    '1': { name: 'Living Room', icon: '🛋️' },
    '2': { name: 'Kitchen',     icon: '🍳' },
    '3': { name: 'Master Bed',  icon: '🛏️' },
    '4': { name: 'Office',      icon: '💻' },
    '5': { name: 'Patio',       icon: '🌿' },
    '6': { name: 'Garage',      icon: '🏠' }
  }
};

// ─── Config I/O ────────────────────────────────────────────────────────────
let cfg = {};

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    cfg = JSON.parse(JSON.stringify(CONFIG_DEFAULTS));
    writeConfig();
    console.log(`[config] Created default config at ${CONFIG_PATH}`);
  } else {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      console.log(`[config] Loaded config from ${CONFIG_PATH}`);
    } catch (e) {
      console.error('[config] Parse error – using defaults:', e.message);
      cfg = JSON.parse(JSON.stringify(CONFIG_DEFAULTS));
    }
  }
}

function writeConfig() {
  // Atomic write: write to .tmp then rename to avoid partial reads
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
}

/** Deep-merge src into dst (mutates dst). Only merges plain objects. */
function deepMerge(dst, src) {
  for (const key of Object.keys(src)) {
    if (
      src[key] !== null &&
      typeof src[key] === 'object' &&
      !Array.isArray(src[key]) &&
      dst[key] !== null &&
      typeof dst[key] === 'object' &&
      !Array.isArray(dst[key])
    ) {
      deepMerge(dst[key], src[key]);
    } else {
      dst[key] = src[key];
    }
  }
  return dst;
}

// ─── Serial port ───────────────────────────────────────────────────────────
const serial = new SerialPort({
  path: SERIAL_PATH,
  baudRate: 9600,        // Confirmed baud rate
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  autoOpen: false
});

serial.open(err => {
  if (err) {
    // Allow server to start even without serial (useful for dev/testing)
    console.error(`[serial] Failed to open ${SERIAL_PATH}:`, err.message);
    console.warn('[serial] Running in offline mode – serial commands will fail');
  } else {
    console.log(`[serial] Opened ${SERIAL_PATH} @ 9600 8-N-1`);
  }
});

// ─── Serial promise queue ─────────────────────────────────────────────────
// Serialise all transactions so commands never overlap on the wire.
let serialQueue = Promise.resolve();

function enqueue(fn) {
  serialQueue = serialQueue.then(fn).catch(err => {
    console.error('[serial] Queue error:', err.message);
    throw err;
  });
  return serialQueue;
}

// CR+LF terminator required by the amp – neither CR alone nor LF alone works
const TERMINATOR = Buffer.from([0x0D, 0x0A]);

/**
 * writeCommand(cmd)
 * Send a set command (power/source/volume).  The amp sends NO response for
 * these – resolve as soon as drain() confirms the bytes are on the wire.
 */
function writeCommand(cmd) {
  return enqueue(() => new Promise((resolve, reject) => {
    if (!serial.isOpen) return reject(new Error('Serial port not open'));
    const buf = Buffer.concat([Buffer.from(cmd, 'ascii'), TERMINATOR]);
    console.log(`[serial] write: ${JSON.stringify(cmd)}`);
    serial.write(buf, err => {
      if (err) return reject(err);
      // drain() waits until all bytes have been transmitted
      serial.drain(drainErr => {
        if (drainErr) return reject(drainErr);
        resolve();
      });
    });
  }));
}

/**
 * queryCommand(cmd)
 * Send a query command and collect the amp's response.
 *
 * Response format: <echo bytes> + '#' + '>XXXXXXXXXXXXXXXXXXXXXX' (22 digits)
 * The response may arrive in multiple TCP/serial chunks, so we accumulate into
 * a string buffer and wait for the '>' marker, then apply a 200 ms settle
 * timer to ensure the full 22-digit payload has arrived before resolving.
 */
function queryCommand(cmd) {
  return enqueue(() => new Promise((resolve, reject) => {
    if (!serial.isOpen) return reject(new Error('Serial port not open'));

    let buf = '';
    let settleTimer = null;
    const SETTLE_MS = 200;  // wait 200 ms after '>' appears for full payload
    const TIMEOUT_MS = 3000;

    const onData = chunk => {
      buf += chunk.toString('ascii');
      console.log(`[serial] recv chunk: ${JSON.stringify(chunk.toString('ascii'))}`);

      const idx = buf.indexOf('>');
      if (idx !== -1) {
        // '>' found – reset settle timer on every new byte to handle chunking
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          serial.removeListener('data', onData);
          clearTimeout(timeout);
          const response = buf.substring(idx); // ">XXXXXX..."
          console.log(`[serial] response: ${JSON.stringify(response)}`);
          resolve(response);
        }, SETTLE_MS);
      }
    };

    const timeout = setTimeout(() => {
      serial.removeListener('data', onData);
      reject(new Error(`Query "${cmd}" timed out after ${TIMEOUT_MS} ms`));
    }, TIMEOUT_MS);

    // Attach listener directly to the SerialPort instance (raw Buffer mode –
    // no ReadlineParser or any other parser pipe, per protocol spec)
    serial.on('data', onData);

    const txBuf = Buffer.concat([Buffer.from(cmd, 'ascii'), TERMINATOR]);
    console.log(`[serial] query: ${JSON.stringify(cmd)}`);
    serial.write(txBuf, err => {
      if (err) {
        clearTimeout(timeout);
        serial.removeListener('data', onData);
        reject(err);
      }
    });
  }));
}

/**
 * parseZoneStatus(raw, zone)
 * Parse the '>XXXXXXXXXXXXXXXXXXXXXX' response (22 ASCII digits).
 *
 * Field layout (0-indexed pairs after '>'):
 *   0: ZZ  zone echo
 *   1: PA  public address flag
 *   2: PR  power  (00=off, 01=on)
 *   3: MU  mute   (00/01)
 *   4: DT  do-not-disturb
 *   5: VO  volume (00-38)
 *   6: TR  treble
 *   7: BS  bass
 *   8: BL  balance
 *   9: CH  source channel (01-06)
 *  10: LS  keypad lock flag
 */
function parseZoneStatus(raw, zone) {
  // Extract the segment starting at '>'
  const start = raw.indexOf('>');
  if (start === -1) throw new Error(`No '>' in response: ${JSON.stringify(raw)}`);

  const digits = raw.substring(start + 1).replace(/\D/g, ''); // strip non-digits

  if (digits.length < 22) {
    throw new Error(`Response too short (${digits.length} digits): ${JSON.stringify(raw)}`);
  }

  const field = (i) => parseInt(digits.substring(i * 2, i * 2 + 2), 10);

  return {
    zone:   zone,
    power:  field(2) === 1,     // PR field
    source: field(9),           // CH field (1-6)
    volume: field(5)            // VO field (0-38)
  };
}

// ─── High-level zone helpers ───────────────────────────────────────────────
// Zone prefix format: '1' (controller ID) + '<zone digit>' (1-6)
// → zone 1 = '11', zone 2 = '12', ..., zone 6 = '16'
// Do NOT use the two-digit zone format from older manuals (causes Command Error)

function zonePrefix(zone) {
  return `1${zone}`;
}

async function getZoneState(zone) {
  // Query format: ?1<Z>\r\n  e.g. ?11\r\n for zone 1
  const cmd = `?1${zone}`;
  const raw = await queryCommand(cmd);
  return parseZoneStatus(raw, zone);
}

async function setZonePower(zone, on) {
  // Power on: <1<Z>PR01\r\n  Power off: <1<Z>PR00\r\n
  const val = on ? '01' : '00';
  await writeCommand(`<${zonePrefix(zone)}PR${val}`);
  return { ok: true, zone, power: on };
}

async function setZoneSource(zone, src) {
  // Source format: <1<Z>CH0N\r\n  e.g. <11CH02\r\n  (source 2, zone 1)
  const val = String(src).padStart(2, '0');
  await writeCommand(`<${zonePrefix(zone)}CH${val}`);
  return { ok: true, zone, source: src };
}

async function setZoneVolume(zone, vol) {
  // Volume format: <1<Z>VO##\r\n  e.g. <11VO15\r\n  (vol 15, zone 1)
  const clamped = Math.max(0, Math.min(38, vol)); // clamp 0-38 server-side
  const val = String(clamped).padStart(2, '0');
  await writeCommand(`<${zonePrefix(zone)}VO${val}`);
  return { ok: true, zone, volume: clamped };
}

// ─── Express app ───────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Allowed top-level config keys (reject unknown keys to prevent config pollution)
const VALID_CONFIG_KEYS = new Set(['theme', 'sourceNames', 'zones']);

// ── Middleware: validate zone param ─────────────────────────────────────────
function validateZone(req, res, next) {
  const zone = parseInt(req.params.zone, 10);
  if (!zone || zone < 1 || zone > 6) {
    return res.status(400).json({ error: 'zone must be 1-6' });
  }
  req.zone = zone;
  next();
}

// ── GET /api/health ──────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, serialOpen: serial.isOpen });
});

// ── GET /api/state?zone=N ────────────────────────────────────────────────────
app.get('/api/state', async (req, res) => {
  const zone = parseInt(req.query.zone, 10);
  if (!zone || zone < 1 || zone > 6) {
    return res.status(400).json({ error: 'zone must be 1-6' });
  }
  try {
    const state = await getZoneState(zone);
    res.json(state);
  } catch (e) {
    console.error(`[api] getZoneState(${zone}) error:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── POST /api/zone/:zone/power ───────────────────────────────────────────────
app.post('/api/zone/:zone/power', validateZone, async (req, res) => {
  const { on } = req.body;
  if (typeof on !== 'boolean') {
    return res.status(400).json({ error: '"on" must be a boolean' });
  }
  try {
    const result = await setZonePower(req.zone, on);
    res.json(result);
  } catch (e) {
    console.error(`[api] setZonePower error:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── POST /api/zone/:zone/source ──────────────────────────────────────────────
app.post('/api/zone/:zone/source', validateZone, async (req, res) => {
  const source = parseInt(req.body.source, 10);
  if (!source || source < 1 || source > 6) {
    return res.status(400).json({ error: 'source must be 1-6' });
  }
  try {
    const result = await setZoneSource(req.zone, source);
    res.json(result);
  } catch (e) {
    console.error(`[api] setZoneSource error:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── POST /api/zone/:zone/volume ──────────────────────────────────────────────
app.post('/api/zone/:zone/volume', validateZone, async (req, res) => {
  const vol = parseInt(req.body.volume, 10);
  if (isNaN(vol)) {
    return res.status(400).json({ error: '"volume" must be a number 0-38' });
  }
  try {
    const result = await setZoneVolume(req.zone, vol); // clamping happens inside
    res.json(result);
  } catch (e) {
    console.error(`[api] setZoneVolume error:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /api/config ──────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json(cfg);
});

// ── PATCH /api/config ────────────────────────────────────────────────────────
app.patch('/api/config', (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return res.status(400).json({ error: 'Request body must be a JSON object' });
  }

  // Reject unknown top-level keys
  for (const key of Object.keys(body)) {
    if (!VALID_CONFIG_KEYS.has(key)) {
      return res.status(400).json({ error: `Unknown config key: "${key}"` });
    }
  }

  deepMerge(cfg, body);
  writeConfig();
  res.json(cfg);
});

// ─── Start server ──────────────────────────────────────────────────────────
loadConfig();
app.listen(PORT, () => {
  console.log(`[server] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[server] Serial device: ${SERIAL_PATH}`);
  console.log(`[server] Config file:   ${CONFIG_PATH}`);
});
