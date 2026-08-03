// main.js — processo principale Electron
// Architettura: UNA sola finestra, sempre in primo piano, che al suo interno
// mostra "schermate" diverse (Home, Cozy View, Spotify) gestite lato
// renderer. Nessuna finestra popup separata.

const { app, BrowserWindow, ipcMain, screen, Menu, shell } = require("electron");
const path = require("path");

const config = require("./config");
const arduinoClient = require("./modules/arduinoClient");
const screenControl = require("./modules/screenControl");
const network = require("./modules/network");
const remoteServer = require("./modules/remoteServer");
const spotify = require("./modules/spotify");

let mainWindow = null;
let allowQuit = false; // true solo dopo il comando remoto di chiusura
let spotifyPollTimer = null;

Menu.setApplicationMenu(null);

function createMainWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    alwaysOnTop: true,
    frame: false,
    closable: false,
    minimizable: false,
    fullscreenable: false,
    fullscreen: true,
    kiosk: true,
    backgroundColor: "#111318",
    webPreferences: {
      preload: path.join(__dirname, "renderer", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.on("close", (e) => {
    if (!allowQuit) e.preventDefault();
  });

  mainWindow.webContents.on("before-input-event", (e, input) => {
    const k = input.key.toLowerCase();
    const isBlocked =
      (input.alt && k === "f4") ||
      (input.control && k === "w") ||
      (input.alt && k === "f9") ||
      k === "f11" ||
      k === "escape";
    if (isBlocked) e.preventDefault();
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function shutdownFromRemote() {
  allowQuit = true;
  app.quit();
}

// --- Polling Spotify: parte solo quando l'utente è sulla schermata Spotify,
// per non consumare rate-limit/rete quando non serve.
function startSpotifyPolling() {
  stopSpotifyPolling();
  if (!spotify.isAuthenticated()) return;

  async function tick() {
    try {
      const track = await spotify.getCurrentlyPlaying();
      mainWindow.webContents.send("spotify:nowPlaying", track);
    } catch (err) {
      mainWindow.webContents.send("spotify:error", err.message);
    }
  }
  tick();
  spotifyPollTimer = setInterval(tick, 5000);
}

function stopSpotifyPolling() {
  if (spotifyPollTimer) clearInterval(spotifyPollTimer);
  spotifyPollTimer = null;
}

app.whenReady().then(() => {
  createMainWindow();

  // --- Arduino: polling dati via WiFi/HTTP ---
  arduinoClient.start(config.arduino, (data, err) => {
    if (err) {
      mainWindow.webContents.send("arduino:error", err.message);
      return;
    }
    mainWindow.webContents.send("arduino:data", data);
  });

  // --- Accensione/spegnimento schermo su orario ---
  screenControl.startScheduler(config.screenSchedule);

  // --- Watchdog di rete: riconnessione automatica ---
  network.startWatchdog((status) => {
    mainWindow.webContents.send("network:status", status);
    if (status.online) {
      arduinoClient.resume();
    } else {
      arduinoClient.pause();
    }
  });

  // --- Server web: telecomando remoto + callback OAuth Spotify ---
  remoteServer.start(config.remote.port, {
    onToggleCozy: (show) => {
      // When asked to show cozy remotely, ensure OS fullscreen; hiding will only navigate home but keep kiosk fullscreen
      if (mainWindow && show) mainWindow.setFullScreen(true);
      mainWindow.webContents.send("nav:goto", show ? "cozy" : "home");
    },
    onScreenPower: (on) => screenControl.setScreenPower(on),
    onShutdownApp: () => shutdownFromRemote(),
    onSpotifyAuthenticated: () => {
      mainWindow.webContents.send("spotify:authenticated");
      startSpotifyPolling();
    },
    onPlayIPTV: (data) => {
      if (mainWindow) mainWindow.setFullScreen(true);
      mainWindow.webContents.send("nav:goto", "iptv");
      mainWindow.webContents.send("iptv:play", data);
    },
    // Remote request to close IPTV overlay and return to home (kiosk remains fullscreen)
    onCloseIPTV: () => {
      if (mainWindow) mainWindow.webContents.send("nav:goto", "home");
    },
    onGetState: () => ({
      online: network.isOnline(),
      spotifyConnected: spotify.isAuthenticated()
    })
  }, config.iptv);

  // --- IPC dal renderer ---
  ipcMain.on("ui:setScreenPower", (_e, on) => screenControl.setScreenPower(on));
  // Allow renderer to request OS-level fullscreen on the BrowserWindow (kiosk) — returns new state
  ipcMain.handle("ui:setAppFullscreen", (_e, on) => {
    try {
      mainWindow.setFullScreen(Boolean(on));
      return { ok: true, fullscreen: mainWindow.isFullScreen() };
    } catch (err) {
      return { ok: false, error: err && err.message };
    }
  });

  // Provide the renderer with a local cozy-media video path (first matching file)
  const fs = require('fs');
  ipcMain.handle('cozy:getLocalVideo', async () => {
    try {
      const mediaDir = path.join(__dirname, 'cozy-media');
      if (!fs.existsSync(mediaDir)) return null;
      const files = fs.readdirSync(mediaDir).filter(f => /\.(mp4|webm|mkv|mov)$/i.test(f));
      if (!files || files.length === 0) return null;
      // Prefer a recommended filename if present
      const preferred = files.find(f => /^cozy\.(mp4|webm|mkv|mov)$/i.test(f));
      const chosen = preferred || files.sort().reverse()[0]; // pick newest by name fallback
      return `file://${path.join(mediaDir, chosen).replace(/\\/g, '/')}`;
    } catch (err) {
      return null;
    }
  });

  ipcMain.handle("arduino:toggle", async (_e, target) => {
    return arduinoClient.toggle(target);
  });

  ipcMain.handle("spotify:isAuthenticated", () => spotify.isAuthenticated());

  ipcMain.on("spotify:login", () => {
    const url = spotify.buildAuthUrl(config.spotify);
    shell.openExternal(url); // login nel browser di sistema, non dentro l'app
  });

  ipcMain.handle("spotify:getPlaylists", () => spotify.getPlaylists());
  ipcMain.handle("spotify:getPlaylistTracks", (_e, id) => spotify.getPlaylistTracks(id));

  ipcMain.on("ui:enteredSpotifyView", () => startSpotifyPolling());
  ipcMain.on("ui:leftSpotifyView", () => stopSpotifyPolling());

  ipcMain.handle("iptv:getConfig", () => config.iptv);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (allowQuit) app.quit();
});
