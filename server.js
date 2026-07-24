"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const { SerialPort } = require("serialport");

const PORT = parseInt(process.env.PORT || "3000", 10);
const SERIAL_PATH = process.env.SERIAL_PATH || "/dev/ttyUSB0";
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, "config.json");
const DEBUG_SERIAL = process.env.DEBUG_SERIAL === "1";
const SERIAL_OPEN_TIMEOUT_MS = parseInt(process.env.SERIAL_OPEN_TIMEOUT_MS || "5000", 10);
const RECONCILE_INTERVAL_MS = parseInt(process.env.RECONCILE_INTERVAL_MS || "60000", 10);

let serialReadyResolve;
let serialReadyReject;
let serialOpenTimedOut = false;
const serialReady = new Promise((resolve, reject) => {
  serialReadyResolve = resolve;
  serialReadyReject = reject;
});

const serialOpenTimeout = setTimeout(() => {
  serialOpenTimedOut = true;
  serialReadyReject(new Error(`Serial port did not open within ${SERIAL_OPEN_TIMEOUT_MS} ms`));
}, SERIAL_OPEN_TIMEOUT_MS);

const CONFIG_DEFAULTS = {
  theme: "dark",
  sourceNames: {
    "1": "Source 1", "2": "Source 2", "3": "Source 3",
    "4": "Source 4", "5": "Source 5", "6": "Source 6"
  },
  zones: {
    "1": { name: "Living Room", icon: "🛋️" },
    "2": { name: "Kitchen", icon: "🍳" },
    "3": { name: "Master Bed", icon: "🛏️" },
    "4": { name: "Office", icon: "💻" },
    "5": { name: "Patio", icon: "🌿" },
    "6": { name: "Garage", icon: "🏠" }
  },
  automation: {
    enabled: true,
    defaultIdleMinutes: 120,
    zones: {
      "1": { enabled: false, idleMinutes: 120 },
      "2": { enabled: false, idleMinutes: 120 },
      "3": { enabled: false, idleMinutes: 120 },
      "4": { enabled: false, idleMinutes: 120 },
      "5": { enabled: false, idleMinutes: 120 },
      "6": { enabled: true, idleMinutes: 120 }
    }
  }
};

let cfg = {};
const zoneStateCache = {};

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }
function deepMerge(dst, src) {
  for (const key of Object.keys(src)) {
    if (src[key] && typeof src[key] === "object" && !Array.isArray(src[key]) && dst[key] && typeof dst[key] === "object" && !Array.isArray(dst[key])) deepMerge(dst[key], src[key]);
    else dst[key] = src[key];
  }
  return dst;
}
function clampVolume(v) { return Math.max(0, Math.min(38, parseInt(v, 10) || 0)); }
function clampIdleMinutes(v) { return Math.max(5, Math.min(720, parseInt(v, 10) || 120)); }
function validZone(zone) { return Number.isInteger(zone) && zone >= 1 && zone <= 6; }
function validSource(source) { return Number.isInteger(source) && source >= 1 && source <= 6; }

function ensureAutomationDefaults(config) {
  if (!config.automation || typeof config.automation !== "object") config.automation = deepClone(CONFIG_DEFAULTS.automation);
  if (typeof config.automation.enabled !== "boolean") config.automation.enabled = true;
  const d = parseInt(config.automation.defaultIdleMinutes, 10);
  config.automation.defaultIdleMinutes = Number.isFinite(d) ? clampIdleMinutes(d) : 120;
  if (!config.automation.zones || typeof config.automation.zones !== "object") config.automation.zones = {};
  for (let z = 1; z <= 6; z++) {
    const key = String(z);
    const existing = config.automation.zones[key] || {};
    const fallback = CONFIG_DEFAULTS.automation.zones[key];
    config.automation.zones[key] = {
      enabled: typeof existing.enabled === "boolean" ? existing.enabled : fallback.enabled,
      idleMinutes: clampIdleMinutes(parseInt(existing.idleMinutes, 10) || fallback.idleMinutes)
    };
  }
  return config;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    cfg = deepClone(CONFIG_DEFAULTS);
    writeConfig();
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    cfg = deepMerge(deepClone(CONFIG_DEFAULTS), raw);
    ensureAutomationDefaults(cfg);
  } catch (err) {
    console.error("[config] Failed to read config, using defaults:", err.message);
    cfg = deepClone(CONFIG_DEFAULTS);
  }
}

function writeConfig() {
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf8");
  fs.renameSync(tmp, CONFIG_PATH);
}

const serial = new SerialPort({ path: SERIAL_PATH, baudRate: 9600, dataBits: 8, stopBits: 1, parity: "none", autoOpen: false });
serial.open(err => {
  if (err) {
    clearTimeout(serialOpenTimeout);
    console.error(`[serial] Failed to open ${SERIAL_PATH}: ${err.message}`);
    serialReadyReject(err);
  } else {
    clearTimeout(serialOpenTimeout);
    console.log(`[serial] Opened ${SERIAL_PATH} @ 9600 8-N-1`);
    serialReadyResolve();
  }
});

function isSerialUnavailableError(err) {
  return err && (serialOpenTimedOut || /did not open within/i.test(err.message) || /Serial port not open/i.test(err.message));
}
async function waitForSerialReady() {
  return serialReady;
}

let serialQueue = Promise.resolve();
function enqueue(fn) {
  serialQueue = serialQueue.then(fn).catch(err => { console.error("[serial] Queue error:", err.message); throw err; });
  return serialQueue;
}

const TERMINATOR = Buffer.from([0x0D, 0x0A]);
function hexDump(buf) { return [...buf].map(b => b.toString(16).padStart(2, "0")).join(" "); }

function writeCommand(cmd) {
  return enqueue(async () => {
    await waitForSerialReady();
    return new Promise((resolve, reject) => {
      if (!serial.isOpen) return reject(new Error("Serial port not open"));
      const buf = Buffer.concat([Buffer.from(cmd, "ascii"), TERMINATOR]);
      if (DEBUG_SERIAL) console.log(`[serial] TX ${JSON.stringify(cmd)} [${hexDump(buf)}]`);
      serial.write(buf, err => {
        if (err) return reject(err);
        serial.drain(drainErr => {
          if (drainErr) return reject(drainErr);
          serial.flush(flushErr => {
            if (flushErr) console.warn("[serial] post-write flush warning:", flushErr.message);
            resolve();
          });
        });
      });
    });
  });
}

function queryCommand(cmd) {
  return enqueue(async () => {
    await waitForSerialReady();
    return new Promise((resolve, reject) => {
      if (!serial.isOpen) return reject(new Error("Serial port not open"));
      const SETTLE_MS = 200;
      const TIMEOUT_MS = 3000;
      let rxBuf = "";
      let settleTimer = null;
      function cleanup() { clearTimeout(timeout); if (settleTimer) clearTimeout(settleTimer); serial.removeAllListeners("data"); }
      const onData = chunk => {
        rxBuf += chunk.toString("ascii");
        if (DEBUG_SERIAL) {
          console.log(`[serial] RX hex ${hexDump(chunk)}`);
          console.log(`[serial] RX buf ${JSON.stringify(rxBuf)}`);
        }
        const idx = rxBuf.indexOf(">");
        if (idx !== -1) {
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = setTimeout(() => { const response = rxBuf.substring(idx); cleanup(); resolve(response); }, SETTLE_MS);
        }
      };
      const timeout = setTimeout(() => { console.error(`[serial] TIMEOUT cmd=${JSON.stringify(cmd)} rxBuf=${JSON.stringify(rxBuf)}`); cleanup(); reject(new Error(`Query ${JSON.stringify(cmd)} timed out after ${TIMEOUT_MS} ms`)); }, TIMEOUT_MS);
      serial.flush(flushErr => {
        if (flushErr) console.warn("[serial] pre-query flush warning:", flushErr.message);
        serial.on("data", onData);
        const txBuf = Buffer.concat([Buffer.from(cmd, "ascii"), TERMINATOR]);
        if (DEBUG_SERIAL) console.log(`[serial] TX ${JSON.stringify(cmd)} [${hexDump(txBuf)}]`);
        serial.write(txBuf, writeErr => { if (writeErr) { cleanup(); reject(writeErr); } });
      });
    });
  });
}

function parseZoneStatus(raw, zone) {
  const start = raw.indexOf(">");
  if (start === -1) throw new Error(`No '>' in response: ${JSON.stringify(raw)}`);
  const digits = raw.substring(start + 1).replace(/\D/g, "");
  if (digits.length < 22) throw new Error(`Response too short (${digits.length}/22): ${JSON.stringify(raw)}`);
  const field = idx => parseInt(digits.substring(idx * 2, idx * 2 + 2), 10);
  return { zone, power: field(2) === 1, source: field(9), volume: field(5) };
}

function zonePrefix(zone) { return `1${zone}`; }
async function getZoneState(zone) { const raw = await queryCommand(`?1${zone}`); const state = parseZoneStatus(raw, zone); zoneStateCache[zone] = state; return state; }
async function setZonePower(zone, on) { await writeCommand(`<${zonePrefix(zone)}PR${on ? "01" : "00"}`); zoneStateCache[zone] = { ...(zoneStateCache[zone] || {}), zone, power: on }; return { ok: true, zone, power: on }; }
async function setZoneSource(zone, src) { await writeCommand(`<${zonePrefix(zone)}CH${String(src).padStart(2, "0")}`); zoneStateCache[zone] = { ...(zoneStateCache[zone] || {}), zone, source: src }; return { ok: true, zone, source: src }; }
async function setZoneVolume(zone, vol) { const v = clampVolume(vol); await writeCommand(`<${zonePrefix(zone)}VO${String(v).padStart(2, "0")}`); zoneStateCache[zone] = { ...(zoneStateCache[zone] || {}), zone, volume: v }; return { ok: true, zone, volume: v }; }

const autoOffState = { lastActivity: {}, timers: {} };
function getZoneAutomation(zone) {
  const a = cfg.automation || {};
  const z = (a.zones || {})[String(zone)] || {};
  return { enabled: !!(a.enabled && z.enabled), idleMinutes: clampIdleMinutes(z.idleMinutes || a.defaultIdleMinutes || 120) };
}
function clearAutoOff(zone) { if (autoOffState.timers[zone]) { clearTimeout(autoOffState.timers[zone]); delete autoOffState.timers[zone]; } }
function cancelZoneAutomation(zone, reason) { clearAutoOff(zone); delete autoOffState.lastActivity[zone]; if (reason !== "startup-off") console.log(`[autooff] zone ${zone} timer cleared: ${reason}`); }
function getAutoOffRemainingMs(zone) { const rule = getZoneAutomation(zone); const last = autoOffState.lastActivity[zone]; if (!rule.enabled || !last) return null; return Math.max(0, last + rule.idleMinutes * 60 * 1000 - Date.now()); }
function getAutomationStatus(zone) { const rule = getZoneAutomation(zone); return { enabled: rule.enabled, idleMinutes: rule.idleMinutes, remainingMs: rule.enabled ? getAutoOffRemainingMs(zone) : null }; }
function scheduleAutoOff(zone, reason) {
  clearAutoOff(zone);
  const rule = getZoneAutomation(zone);
  if (!rule.enabled) return;
  autoOffState.timers[zone] = setTimeout(async () => {
    try {
      const state = await getZoneState(zone);
      if (state.power) {
        await setZonePower(zone, false);
        cancelZoneAutomation(zone, "expired");
        console.log(`[autooff] zone ${zone} powered off after ${rule.idleMinutes} min idle`);
      }
    } catch (err) {
      console.error(`[autooff] zone ${zone} failed: ${err.message}`);
      scheduleAutoOff(zone, "retry-after-error");
    }
  }, rule.idleMinutes * 60 * 1000);
  console.log(`[autooff] zone ${zone} timer set for ${rule.idleMinutes} min (${reason})`);
}
function markZoneActivity(zone, reason) { autoOffState.lastActivity[zone] = Date.now(); console.log(`[autooff] zone ${zone} activity: ${reason}`); scheduleAutoOff(zone, reason); }

async function reconcileZoneState(zone) {
  const state = await getZoneState(zone);
  const prev = zoneStateCache[zone] || {};
  zoneStateCache[zone] = state;
  const changed = prev.power !== state.power || prev.source !== state.source || prev.volume !== state.volume;
  if (!changed) return;
  console.log(`[reconcile] zone ${zone} changed externally: ${JSON.stringify(prev)} -> ${JSON.stringify(state)}`);
  if (state.power) markZoneActivity(zone, "reconcile-sync");
  else cancelZoneAutomation(zone, "reconcile-off");
}

async function bootstrapAutoOffFromAmp() {
  await waitForSerialReady();
  for (let i = 0; i < 6; i++) {
    const zone = i + 1;
    setTimeout(async () => {
      try {
        const state = await getZoneState(zone);
        if (state.power) markZoneActivity(zone, "startup-sync");
        else cancelZoneAutomation(zone, "startup-off");
      } catch (err) {
        console.warn(`[autooff] startup sync zone ${zone} skipped: ${err.message}`);
      }
    }, i * 250);
  }
}

function startReconciliationLoop() {
  setInterval(async () => {
    if (!serial.isOpen) return;
    for (let i = 0; i < 6; i++) {
      const zone = i + 1;
      setTimeout(() => {
        reconcileZoneState(zone).catch(err => console.warn(`[reconcile] zone ${zone} skipped: ${err.message}`));
      }, i * 250);
    }
  }, RECONCILE_INTERVAL_MS);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
const VALID_CONFIG_KEYS = new Set(["theme", "sourceNames", "zones", "automation"]);
function validateZoneParam(req, res, next) { const zone = parseInt(req.params.zone, 10); if (!validZone(zone)) return res.status(400).json({ error: "zone must be 1-6" }); req.zone = zone; next(); }

app.get("/api/health", (req, res) => {
  res.json({ ok: true, serialOpen: serial.isOpen, serialOpenTimedOut });
});

app.get("/api/state", async (req, res) => {
  const zone = parseInt(req.query.zone, 10);
  if (!validZone(zone)) return res.status(400).json({ error: "zone must be 1-6" });
  try {
    const state = await getZoneState(zone);
    res.json({ ...state, automation: getAutomationStatus(zone) });
  } catch (err) {
    console.error(`[api] getZoneState(${zone}): ${err.message}`);
    if (isSerialUnavailableError(err)) return res.status(503).json({ error: "Serial adapter not ready" });
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/zone/:zone/power", validateZoneParam, async (req, res) => {
  if (typeof req.body.on !== "boolean") return res.status(400).json({ error: '"on" must be a boolean' });
  try {
    const result = await setZonePower(req.zone, req.body.on);
    if (req.body.on) markZoneActivity(req.zone, "power-on"); else cancelZoneAutomation(req.zone, "power-off");
    res.json({ ...result, automation: getAutomationStatus(req.zone) });
  } catch (err) {
    console.error(`[api] setZonePower(${req.zone}): ${err.message}`);
    if (isSerialUnavailableError(err)) return res.status(503).json({ error: "Serial adapter not ready" });
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/zone/:zone/source", validateZoneParam, async (req, res) => {
  const source = parseInt(req.body.source, 10);
  if (!validSource(source)) return res.status(400).json({ error: "source must be 1-6" });
  try {
    const result = await setZoneSource(req.zone, source);
    markZoneActivity(req.zone, "source-change");
    res.json({ ...result, automation: getAutomationStatus(req.zone) });
  } catch (err) {
    console.error(`[api] setZoneSource(${req.zone}): ${err.message}`);
    if (isSerialUnavailableError(err)) return res.status(503).json({ error: "Serial adapter not ready" });
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/zone/:zone/volume", validateZoneParam, async (req, res) => {
  const volume = clampVolume(req.body.volume);
  const cached = zoneStateCache[req.zone];
  if (cached && cached.volume === volume) {
    return res.json({ ok: true, zone: req.zone, volume, skipped: true, automation: getAutomationStatus(req.zone) });
  }
  try {
    const result = await setZoneVolume(req.zone, volume);
    markZoneActivity(req.zone, "volume-change");
    res.json({ ...result, skipped: false, automation: getAutomationStatus(req.zone) });
  } catch (err) {
    console.error(`[api] setZoneVolume(${req.zone}): ${err.message}`);
    if (isSerialUnavailableError(err)) return res.status(503).json({ error: "Serial adapter not ready" });
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/config", (req, res) => res.json(cfg));
app.patch("/api/config", (req, res) => {
  const body = req.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return res.status(400).json({ error: "Request body must be a JSON object" });
  for (const key of Object.keys(body)) if (!VALID_CONFIG_KEYS.has(key)) return res.status(400).json({ error: `Unknown config key: ${JSON.stringify(key)}` });
  if (body.automation && typeof body.automation !== "object") return res.status(400).json({ error: "automation must be an object" });
  deepMerge(cfg, body);
  ensureAutomationDefaults(cfg);
  writeConfig();
  for (let zone = 1; zone <= 6; zone++) {
    const rule = getZoneAutomation(zone);
    if (!rule.enabled) clearAutoOff(zone);
    else if (autoOffState.lastActivity[zone]) scheduleAutoOff(zone, "config-change");
  }
  res.json(cfg);
});

loadConfig();
app.listen(PORT, () => {
  console.log(`[server] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[server] Serial: ${SERIAL_PATH}`);
  console.log(`[server] Config: ${CONFIG_PATH}`);
  bootstrapAutoOffFromAmp().catch(err => console.warn(`[autooff] bootstrap skipped: ${err.message}`));
  startReconciliationLoop();
});