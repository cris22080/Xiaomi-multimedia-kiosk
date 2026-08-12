const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");

let processRef = null;

function start(options, onUpdate, onError = () => {}) {
  stop();
  if (process.platform !== "win32" || options?.enabled === false) return;

  const script = path.join(__dirname, "windowsMediaSession.ps1");
  const interval = Math.max(1000, Number(options?.pollingIntervalMs) || 3000);
  processRef = spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", script,
    "-PollMilliseconds", String(interval)
  ], { windowsHide: true });

  readline.createInterface({ input: processRef.stdout }).on("line", (line) => {
    try {
      const data = JSON.parse(line);
      // Se è attiva un'altra app multimediale, la mostriamo solo quando
      // esplicitamente consentito; Spotify viene sempre riconosciuto.
      const isSpotify = /spotify/i.test(data?.source || "");
      if (data && !isSpotify && options?.spotifyOnly !== false) onUpdate(null);
      else onUpdate(data);
    } catch (error) {
      onError(`Sessione multimediale non leggibile: ${error.message}`);
    }
  });

  let lastError = "";
  processRef.stderr.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (message && message !== lastError) {
      lastError = message;
      onError(message);
    }
  });
  processRef.on("error", (error) => onError(error.message));
  processRef.on("exit", () => { processRef = null; });
}

function stop() {
  if (processRef && !processRef.killed) processRef.kill();
  processRef = null;
}

module.exports = { start, stop };
