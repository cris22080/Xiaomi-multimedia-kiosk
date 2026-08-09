// modules/network.js
// Controlla periodicamente la connettività (es. verso 1.1.1.1) e notifica
// quando si va offline/online. Non serve "riconnettere" il WiFi manualmente:
// Windows lo fa da solo, qui ci limitiamo a rilevare il ritorno della rete
// e a far ripartire i moduli che dipendono da essa (es. polling Arduino).

const dns = require("dns");

let online = true;
let watchdogTimer = null;
let hasChecked = false;

function checkOnce() {
  return new Promise((resolve) => {
    dns.resolve4("one.one.one.one", (err, addresses) => {
      resolve(!err && Array.isArray(addresses) && addresses.length > 0);
    });
  });
}

function startWatchdog(onChange, intervalMs = 10000) {
  async function tick() {
    const nowOnline = await checkOnce();
    if (!hasChecked || nowOnline !== online) {
      online = nowOnline;
      hasChecked = true;
      onChange({ online, timestamp: Date.now() });
    }
    watchdogTimer = setTimeout(tick, intervalMs);
  }
  // Run immediately on start to get initial network state
  tick();
}

function stopWatchdog() {
  if (watchdogTimer) clearTimeout(watchdogTimer);
}

function isOnline() {
  return online;
}

module.exports = { startWatchdog, stopWatchdog, isOnline };
