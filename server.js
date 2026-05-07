'use strict';

/**
 * server.js – Monoprice 10761 Six-Zone Amplifier Web Controller
 * v1.1 – fixes query timeout caused by stale RX bytes and listener leaks
 *
 * RS-232 protocol (validated against real hardware):
 *   - Baud: 9600, 8-N-1, straight-through DB9 (NOT null-modem)
 *   - Terminator: CR+LF (0x0D 0x0A) – neither byte alone is accepted
 *   - Zone prefix: controller-id '1' + single zone digit '1'-'6' → "11".."16"
 *     WARNING: the two-digit zone format from some manuals causes "Command Error."
 *   - Query response: echo + '#' + '>' + 22 ASCII digits (may arrive in chunks)
 *   - Set commands (power/source/volume) produce NO response – drain only
 */

const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const { SerialPort } = require('serialport');

// ─── Environment ───────────────────────────────────────────────────────────
const PORT         = parseInt(process.env.PORT        || '3000', 10);
const SERIAL_PATH  = process.env.SERIAL_PATH          || '/dev/ttyUSB0';
const CONFIG_PATH  = process.env.CONFIG_PATH          || path.join(__dirname, 'config.json');
// Set DEBUG_SERIAL=1 to enable hex dumps of every TX/RX byte
const DEBUG_SERIAL = process.env.DEBUG_SERIAL === '1';

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
  // Atomic write: write to .tmp then rename – safe across power loss
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
}

function deepMerge(dst, src) {
  for (const key of Object.keys(src)) {
    // Prevent prototype pollution via special keys
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }

    if (
      src[key] !== null && typeof src[key] === 'object' && !Array.isArray(src[key]) &&
      dst[key] !== null && typeof dst[key] === 'object' && !Array.isArray(dst[key])
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
  baudRate: 9600,   // confirmed baud rate for Monoprice 10761
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  autoOpen: false
});

serial.open(err => {
  if (err) {
    console.error(`[serial] Failed to open ${SERIAL_PATH}:`, err.message);
    console.warn('[serial] Running in offline mode – amp commands will fail');
  } else {
    console.log(`[serial] Opened ${SERIAL_PATH} @ 9600 8-N-1`);
  }
});

// ─── Serial promise queue ──────────────────────────────────────────────────
// All transactions are serialized so commands never overlap on the wire.
let serialQueue = Promise.resolve();

function enqueue(fn) {
  serialQueue = serialQueue.then(fn).catch(err => {
    console.error('[serial] Queue error:', err.message);
    throw err;
  });
  return serialQueue;
}

// ─── Serial helpers ────────────────────────────────────────────────────────

function hexDump(buf) {
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join(' ');
}

// CR+LF terminator – 0x0D 0x0A – required by amp; neither byte alone works
const TERMINATOR = Buffer.from([0x0D, 0x0A]);

/**
 * writeCommand(cmd)
 * Send a set command (power / source / volume).
 * The amp produces NO response to these – resolve after drain() + flush().
 * The post-write flush clears any echo bytes the amp might send, preventing
 * them from contaminating the RX buffer of the next query command.
 */
function writeCommand(cmd) {
  return enqueue(() => new Promise((resolve, reject) => {
    if (!serial.isOpen) return reject(new Error('Serial port not open'));

    const buf = Buffer.concat([Buffer.from(cmd, 'ascii'), TERMINATOR]);
    if (DEBUG_SERIAL) console.log(`[serial] TX: ${JSON.stringify(cmd)} [${hexDump(buf)}]`);

    serial.write(buf, err => {
      if (err) return reject(err);
      serial.drain(drainErr => {
        if (drainErr) return reject(drainErr);
        // Flush any stray echo/noise bytes so they don't pollute the next query
        serial.flush(flushErr => {
          if (flushErr) console.warn('[serial] post-write flush warning:', flushErr.message);
          resolve();
        });
      });
    });
  }));
}

/**
 * queryCommand(cmd)
 * Send a query command and collect the amp's '>' response.
 *
 * Response format: <echo bytes> + '#' + '>XXXXXXXXXXXXXXXXXXXXXX' (22 digits)
 * Bytes may arrive in multiple chunks – accumulate into rxBuf, scan for '>',
 * then apply a 200 ms settle timer to wait for the full 22-digit payload.
 *
 * Timeout / leak prevention:
 *  - serial.flush() BEFORE attaching listener + sending TX clears stale bytes
 *    left in the OS RX buffer from previous exchanges or amp background noise
 *  - removeAllListeners('data') on exit prevents stale listeners from stealing
 *    bytes intended for subsequent queries (the #1 cause of cascading timeouts)
 */
function queryCommand(cmd) {
  return enqueue(() => new Promise((resolve, reject) => {
    if (!serial.isOpen) return reject(new Error('Serial port not open'));

    const SETTLE_MS  = 200;    // ms to wait after '>' for full payload to arrive
    const TIMEOUT_MS = 3000;

    let rxBuf       = '';
    let settleTimer  = null;

    function cleanup() {
      clearTimeout(timeout);
      if (settleTimer) clearTimeout(settleTimer);
      // Remove ALL data listeners – prevents stale listener accumulation
      // across timed-out queries (the primary cause of cascading timeouts)
      serial.removeAllListeners('data');
    }

    const onData = chunk => {
      rxBuf += chunk.toString('ascii');
      if (DEBUG_SERIAL) {
        console.log(`[serial] RX hex:  ${hexDump(chunk)}`);
        console.log(`[serial] RX buf:  ${JSON.stringify(rxBuf)}`);
      }

      const idx = rxBuf.indexOf('>');
      if (idx !== -1) {
        // Reset settle timer on every new chunk after '>' appears –
        // handles chunked TCP/serial delivery with no clean line terminator
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          const response = rxBuf.substring(idx);
          if (DEBUG_SERIAL) console.log(`[serial] RESPONSE: ${JSON.stringify(response)}`);
          cleanup();
          resolve(response);
        }, SETTLE_MS);
      }
    };

    const timeout = setTimeout(() => {
      // Log the raw buffer so you can see exactly what (if anything) arrived
      console.error(
        `[serial] TIMEOUT cmd=${JSON.stringify(cmd)} ` +
        `rxBuf=${JSON.stringify(rxBuf)} ` +
        `rxHex=[${hexDump(Buffer.from(rxBuf, 'ascii'))}]`
      );
      cleanup();
      reject(new Error(`Query "${cmd}" timed out after ${TIMEOUT_MS} ms`));
    }, TIMEOUT_MS);

    // ── Flush stale RX bytes BEFORE listening and sending ─────────────────
    // This is the critical fix: leftover bytes in the OS UART buffer from
    // a previous timeout or amp background traffic can contain a spurious '>'
    // that resolves the promise with garbage data – or, inversely, the buffer
    // offset can cause the real response to be missed entirely.
    serial.flush(flushErr => {
      if (flushErr) console.warn('[serial] pre-query flush warning:', flushErr.message);

      // Attach raw data listener directly (no ReadlineParser – raw Buffer mode)
      serial.on('data', onData);

      const txBuf = Buffer.concat([Buffer.from(cmd, 'ascii'), TERMINATOR]);
      if (DEBUG_SERIAL) console.log(`[serial] TX: ${JSON.stringify(cmd)} [${hexDump(txBuf)}]`);

      serial.write(txBuf, writeErr => {
        if (writeErr) {
          cleanup();
          reject(writeErr);
        }
      });
    });
  }));
}

/**
 * parseZoneStatus(raw, zone)
 * Parse the '>XXXXXXXXXXXXXXXXXXXXXX' response (22 ASCII digits after '>').
 *
 * Field layout (0-indexed 2-char pairs):
 *   0: ZZ  zone echo        5: VO  volume (00–38)   9: CH  source (01–06)
 *   1: PA  public address   6: TR  treble           10: LS  keypad flag
 *   2: PR  power (0/1)      7: BS  bass
 *   3: MU  mute             8: BL  balance
 *   4: DT  do-not-disturb
 */
function parseZoneStatus(raw, zone) {
  const start = raw.indexOf('>');
  if (start === -1) throw new Error(`No '>' in response: ${JSON.stringify(raw)}`);

  // Strip non-digit chars (handles trailing \r, spaces, or extra echo bytes)
  const digits = raw.substring(start + 1).replace(/\D/g, '');

  if (digits.length < 22) {
    throw new Error(`Response too short (${digits.length}/22 digits): ${JSON.stringify(raw)}`);
  }

  const field = i => parseInt(digits.substring(i * 2, i * 2 + 2), 10);

  return {
    zone,
    power:  field(2) === 1,  // PR field
    source: field(9),        // CH field (1–6)
    volume: field(5)         // VO field (0–38)
  };
}

// ─── Zone helpers ──────────────────────────────────────────────────────────
// Zone prefix: '1' (controller ID) + single zone digit (1–6)
// Correct: '11'..'16'   WRONG (causes "Command Error."): '11'-'16' without prefix

function zonePrefix(zone) { return `1${zone}`; }

async function getZoneState(zone) {
  const raw = await queryCommand(`?1${zone}`);
  return parseZoneStatus(raw, zone);
}

async function setZonePower(zone, on) {
  await writeCommand(`<${zonePrefix(zone)}PR${on ? '01' : '00'}`);
  return { ok: true, zone, power: on };
}

async function setZoneSource(zone, src) {
  await writeCommand(`<${zonePrefix(zone)}CH${String(src).padStart(2, '0')}`);
  return { ok: true, zone, source: src };
}

async function setZoneVolume(zone, vol) {
  const v = Math.max(0, Math.min(38, vol));  // clamp 0–38 server-side
  await writeCommand(`<${zonePrefix(zone)}VO${String(v).padStart(2, '0')}`);
  return { ok: true, zone, volume: v };
}

// ─── Express app ───────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const VALID_CONFIG_KEYS = new Set(['theme', 'sourceNames', 'zones']);

function validateZone(req, res, next) {
  const zone = parseInt(req.params.zone, 10);
  if (!zone || zone < 1 || zone > 6) {
    return res.status(400).json({ error: 'zone must be 1-6' });
  }
  req.zone = zone;
  next();
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, serialOpen: serial.isOpen });
});

app.get('/api/state', async (req, res) => {
  const zone = parseInt(req.query.zone, 10);
  if (!zone || zone < 1 || zone > 6) {
    return res.status(400).json({ error: 'zone must be 1-6' });
  }
  try {
    res.json(await getZoneState(zone));
  } catch (e) {
    console.error(`[api] getZoneState(${zone}):`, e.message);
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/zone/:zone/power', validateZone, async (req, res) => {
  if (typeof req.body.on !== 'boolean') {
    return res.status(400).json({ error: '"on" must be a boolean' });
  }
  try {
    res.json(await setZonePower(req.zone, req.body.on));
  } catch (e) {
    console.error(`[api] setZonePower(${req.zone}):`, e.message);
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/zone/:zone/source', validateZone, async (req, res) => {
  const source = parseInt(req.body.source, 10);
  if (!source || source < 1 || source > 6) {
    return res.status(400).json({ error: 'source must be 1-6' });
  }
  try {
    res.json(await setZoneSource(req.zone, source));
  } catch (e) {
    console.error(`[api] setZoneSource(${req.zone}):`, e.message);
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/zone/:zone/volume', validateZone, async (req, res) => {
  const vol = parseInt(req.body.volume, 10);
  if (isNaN(vol)) {
    return res.status(400).json({ error: '"volume" must be a number 0-38' });
  }
  try {
    res.json(await setZoneVolume(req.zone, vol));
  } catch (e) {
    console.error(`[api] setZoneVolume(${req.zone}):`, e.message);
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/config', (req, res) => res.json(cfg));

app.patch('/api/config', (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return res.status(400).json({ error: 'Request body must be a JSON object' });
  }
  for (const key of Object.keys(body)) {
    if (!VALID_CONFIG_KEYS.has(key)) {
      return res.status(400).json({ error: `Unknown config key: "${key}"` });
    }
  }
  deepMerge(cfg, body);
  writeConfig();
  res.json(cfg);
});

// ─── Start ─────────────────────────────────────────────────────────────────
loadConfig();
app.listen(PORT, () => {
  console.log(`[server] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[server] Serial: ${SERIAL_PATH}  Config: ${CONFIG_PATH}`);
  if (DEBUG_SERIAL) console.log('[server] DEBUG_SERIAL=1 – hex dumps enabled');
});
