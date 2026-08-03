// modules/arduinoClient.js
// Polling periodico verso il web server esposto dall'Arduino (WiFi/HTTP).
// Gestisce timeout e retry con backoff esponenziale se l'Arduino non risponde.

const fetch = require("node-fetch");

let timer = null;
let paused = false;
let currentBackoffMs = null;
let cfgRef = null;
let onUpdateRef = null;

function start(cfg, onUpdate) {
  cfgRef = cfg;
  onUpdateRef = onUpdate;
  const { baseUrl, dataEndpoint, pollIntervalMs, timeoutMs } = cfg;
  currentBackoffMs = pollIntervalMs;

  async function poll() {
    if (paused) return;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(baseUrl + dataEndpoint, { signal: controller.signal });
      clearTimeout(t);

      if (!res.ok) throw new Error(`Arduino HTTP ${res.status}`);
      const data = await res.json();

      currentBackoffMs = pollIntervalMs; // reset backoff dopo un successo
      onUpdate(data, null);
    } catch (err) {
      clearTimeout(t);
      // Only pass error on first few attempts, then silently retry with backoff
      if (currentBackoffMs === pollIntervalMs) {
        console.log(`[arduinoClient] fetch error: ${err.message}`);
      }
      onUpdate(null, err);
      // backoff esponenziale, max 60s, per non martellare l'Arduino/la rete
      currentBackoffMs = Math.min(currentBackoffMs * 2, 60000);
    } finally {
      timer = setTimeout(poll, currentBackoffMs);
    }
  }

  poll();
}

// target: "ventilatore" | "luci" | "lampada" (chiavi di cfg.toggleEndpoints)
async function toggle(target) {
  if (!cfgRef || !cfgRef.toggleEndpoints[target]) {
    throw new Error(`Endpoint di toggle sconosciuto: ${target}`);
  }
  const url = cfgRef.baseUrl + cfgRef.toggleEndpoints[target];
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), cfgRef.timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`Arduino HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function pause() {
  paused = true;
  if (timer) clearTimeout(timer);
}

function resume() {
  if (!paused) return;
  paused = false;
  // Reset backoff to normal polling interval
  currentBackoffMs = cfgRef ? cfgRef.pollIntervalMs : 4000;
  // Clear any pending timer and immediately restart polling
  if (timer) clearTimeout(timer);
  
  async function poll() {
    if (paused) return;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), cfgRef.timeoutMs);

    try {
      const res = await fetch(cfgRef.baseUrl + cfgRef.dataEndpoint, { signal: controller.signal });
      clearTimeout(t);

      if (!res.ok) throw new Error(`Arduino HTTP ${res.status}`);
      const data = await res.json();

      currentBackoffMs = cfgRef.pollIntervalMs;
      onUpdateRef(data, null);
    } catch (err) {
      clearTimeout(t);
      onUpdateRef(null, err);
      currentBackoffMs = Math.min(currentBackoffMs * 2, 60000);
    } finally {
      timer = setTimeout(poll, currentBackoffMs);
    }
  }
  
  poll();
}

function stop() {
  paused = true;
  if (timer) clearTimeout(timer);
}

module.exports = { start, pause, resume, stop, toggle };
