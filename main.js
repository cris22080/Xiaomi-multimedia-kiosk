// main.js — processo principale Electron
// Architettura: UNA sola finestra, sempre in primo piano, che al suo interno
// mostra "schermate" diverse (Home, Cozy View, Spotify) gestite lato
// renderer. Nessuna finestra popup separata.

const { app, BrowserWindow, ipcMain, screen, Menu, shell, powerSaveBlocker } = require("electron");
const path = require("path");

const config = require("./config");
const arduinoClient = require("./modules/arduinoClient");
const screenControl = require("./modules/screenControl");
const network = require("./modules/network");
const remoteServer = require("./modules/remoteServer");
const spotify = require("./modules/spotify");
const windowsVolume = require("./modules/windowsVolume");

const alarmManager = require("./modules/alarmManager");

let mainWindow = null;
let allowQuit = false; // true solo dopo il comando remoto di chiusura
let spotifyPollTimer = null;
let remoteCursor = { x: 0, y: 0 };
let softScreenOn = true;
let suspensionBlockerId = null;

Menu.setApplicationMenu(null);

function createMainWindow() {
  // Use the full display bounds (includes taskbar area) so the window can cover the Windows taskbar.
  const { width, height, x, y } = screen.getPrimaryDisplay().bounds;

  mainWindow = new BrowserWindow({
    x: x || 0,
    y: y || 0,
    width: width,
    height: height,
    alwaysOnTop: true,
    frame: false,
    closable: false,
    minimizable: false,
    // Allow fullscreening so the window can truly occupy the entire screen
    fullscreenable: true,
    fullscreen: true,
    kiosk: true,
    backgroundColor: "#111318",
    webPreferences: {
      preload: path.join(__dirname, "renderer", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: "no-user-gesture-required"
    }
  });

  // Ensure window stays on top and is visible on all workspaces
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

  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.send("screen:softPower", softScreenOn);
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
  // Mantiene processo, rete e telecomando attivi anche quando il pannello viene
  // spento tramite SC_MONITORPOWER (importante sui dispositivi Modern Standby).
  suspensionBlockerId = powerSaveBlocker.start("prevent-app-suspension");
  console.log(`[power] blocco sospensione attivo: ${powerSaveBlocker.isStarted(suspensionBlockerId)}`);
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
  screenControl.startScheduler(config.screenSchedule, (on) => {
    softScreenOn = on;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("screen:softPower", on);
  });

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
    onScreenPower: (on) => {
      softScreenOn = Boolean(on);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("screen:softPower", Boolean(on));
      return screenControl.setScreenPower(Boolean(on));
    },
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
    onRemoteMouse: (action) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const bounds = mainWindow.getContentBounds();
      if (!remoteCursor.x && !remoteCursor.y) {
        remoteCursor = { x: Math.round(bounds.width / 2), y: Math.round(bounds.height / 2) };
      }
      const step = action && action.large ? 90 : 35;
      if (action && action.type === "move") {
        remoteCursor.x = Math.max(0, Math.min(bounds.width - 1, remoteCursor.x + (Number(action.dx) || 0) * step));
        remoteCursor.y = Math.max(0, Math.min(bounds.height - 1, remoteCursor.y + (Number(action.dy) || 0) * step));
        mainWindow.webContents.sendInputEvent({ type: "mouseMove", x: remoteCursor.x, y: remoteCursor.y });
      } else if (action && action.type === "click") {
        mainWindow.webContents.sendInputEvent({ type: "mouseDown", x: remoteCursor.x, y: remoteCursor.y, button: "left", clickCount: 1 });
        mainWindow.webContents.sendInputEvent({ type: "mouseUp", x: remoteCursor.x, y: remoteCursor.y, button: "left", clickCount: 1 });
      } else if (action && action.type === "scroll") {
        mainWindow.webContents.sendInputEvent({ type: "mouseWheel", x: remoteCursor.x, y: remoteCursor.y, deltaX: 0, deltaY: (Number(action.dy) || 0) * 120 });
      }
    },
    // Remote request to close IPTV overlay and return to home (kiosk remains fullscreen)
    onCloseIPTV: () => {
      if (mainWindow) mainWindow.webContents.send("nav:goto", "home");
    },
    onGetState: () => ({
      online: network.isOnline(),
      spotifyConnected: spotify.isAuthenticated(),
      activeAlarm: alarmManager.getActive()
    }),
    onGetAlarms: () => ({ alarms: alarmManager.list(), motifs: alarmManager.motifs }),
    onSaveAlarm: (alarm) => ({ alarms: alarmManager.save(alarm), motifs: alarmManager.motifs }),
    onDeleteAlarm: (id) => ({ alarms: alarmManager.remove(id), motifs: alarmManager.motifs }),
    onStopAlarm: () => {
      alarmManager.stop();
      mainWindow.webContents.send("alarm:stop");
      return { success: true };
    },
    // Volume handlers for remote
    onGetVolume: async () => {
      return windowsVolume.get();
      const { exec } = require('child_process');
      const util = require('util');
      const execPromise = util.promisify(exec);
      
      const command = `powershell -Command "
        Add-Type -TypeDefinition @'
        using System;
        using System.Runtime.InteropServices;
        [Guid(\"5CDF2C82-841E-4546-9722-0CF74078229A\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioEndpointVolume {
          int GetMasterVolumeLevelScalar(out float pfLevel);
          int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
        }
        [Guid(\"D666063F-1587-4E43-81F1-B948E807363F\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDevice {
          int Activate(ref Guid iid, int dwClsCtx, int pActivationParams, out IAudioEndpointVolume ppInterface);
        }
        [Guid(\"A95664D2-9614-4F35-A746-DE8DB63617E6\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDeviceEnumerator {
          int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
        }
        [ComImport, Guid(\"BCDE0395-E52F-467C-8E3D-C4579291692E\")] class MMDeviceEnumerator { }
        '@
        \$enumerator = New-Object MMDeviceEnumerator
        \$device = \$null
        \$enumerator.GetDefaultAudioEndpoint(0, 1, [ref]\$device)
        \$endpointVolume = \$null
        \$guid = [Guid]\"5CDF2C82-841E-4546-9722-0CF74078229A\"
        \$device.Activate([ref]\$guid, 7, 0, [ref]\$endpointVolume)
        \$level = 0.0
        \$endpointVolume.GetMasterVolumeLevelScalar([ref]\$level)
        [int](\$level * 100)
      "`;
      
      try {
        const { stdout } = await execPromise(command);
        const volume = parseInt(stdout.trim());
        return { success: true, volume: isNaN(volume) ? 100 : volume };
      } catch (error) {
        console.error('[Volume] Errore lettura volume:', error.message);
        return { success: false, error: error.message, volume: 100 };
      }
    },
    onSetVolume: async (level) => {
      return windowsVolume.set(level);
      const { exec } = require('child_process');
      const util = require('util');
      const execPromise = util.promisify(exec);
      
      // Clamp volume between 0 and 100
      const volume = Math.max(0, Math.min(100, Math.round(level)));
      
      const command = `powershell -Command "
        Add-Type -TypeDefinition @'
        using System;
        using System.Runtime.InteropServices;
        [Guid(\"5CDF2C82-841E-4546-9722-0CF74078229A\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioEndpointVolume {
          int GetMasterVolumeLevelScalar(out float pfLevel);
          int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
        }
        [Guid(\"D666063F-1587-4E43-81F1-B948E807363F\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDevice {
          int Activate(ref Guid iid, int dwClsCtx, int pActivationParams, out IAudioEndpointVolume ppInterface);
        }
        [Guid(\"A95664D2-9614-4F35-A746-DE8DB63617E6\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDeviceEnumerator {
          int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
        }
        [ComImport, Guid(\"BCDE0395-E52F-467C-8E3D-C4579291692E\")] class MMDeviceEnumerator { }
        '@
        \$enumerator = New-Object MMDeviceEnumerator
        \$device = \$null
        \$enumerator.GetDefaultAudioEndpoint(0, 1, [ref]\$device)
        \$endpointVolume = \$null
        \$guid = [Guid]\"5CDF2C82-841E-4546-9722-0CF74078229A\"
        \$device.Activate([ref]\$guid, 7, 0, [ref]\$endpointVolume)
        \$endpointVolume.SetMasterVolumeLevelScalar(${volume / 100}, [Guid]::Empty)
      "`;
      
      try {
        await execPromise(command);
        return { success: true, volume };
      } catch (error) {
        console.error('[Volume] Errore impostazione volume:', error.message);
        return { success: false, error: error.message };
      }
    }
  }, config.iptv);

  alarmManager.start((alarm) => {
    softScreenOn = true;
    screenControl.setScreenPower(true);
    if (mainWindow) {
      mainWindow.webContents.send("screen:softPower", true);
      mainWindow.setFullScreen(true);
      mainWindow.webContents.send("alarm:trigger", alarm);
    }
  });

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
  ipcMain.handle("alarm:stop", () => {
    alarmManager.stop();
    return { success: true };
  });

  // --- Bluetooth IPC ---
 
  // --- Volume Control IPC ---
  ipcMain.handle("volume:set", async (_e, level) => {
    return windowsVolume.set(level);
    try {
      // Use Windows Audio Session API via PowerShell
      const { exec } = require('child_process');
      const util = require('util');
      const execPromise = util.promisify(exec);
      
      // Clamp volume between 0 and 100
      const volume = Math.max(0, Math.min(100, Math.round(level)));
      
      // Use nircmd or PowerShell to set system volume
      // PowerShell approach using AudioEndpointVolume
      const command = `powershell -Command "
        Add-Type -TypeDefinition @'
        using System;
        using System.Runtime.InteropServices;
        [Guid(\"5CDF2C82-841E-4546-9722-0CF74078229A\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioEndpointVolume {
          int GetMasterVolumeLevelScalar(out float pfLevel);
          int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
        }
        [Guid(\"D666063F-1587-4E43-81F1-B948E807363F\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDevice {
          int Activate(ref Guid iid, int dwClsCtx, int pActivationParams, out IAudioEndpointVolume ppInterface);
        }
        [Guid(\"A95664D2-9614-4F35-A746-DE8DB63617E6\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDeviceEnumerator {
          int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
        }
        [ComImport, Guid(\"BCDE0395-E52F-467C-8E3D-C4579291692E\")] class MMDeviceEnumerator { }
        '@
        \$enumerator = New-Object MMDeviceEnumerator
        \$device = \$null
        \$enumerator.GetDefaultAudioEndpoint(0, 1, [ref]\$device)
        \$endpointVolume = \$null
        \$guid = [Guid]\"5CDF2C82-841E-4546-9722-0CF74078229A\"
        \$device.Activate([ref]\$guid, 7, 0, [ref]\$endpointVolume)
        \$endpointVolume.SetMasterVolumeLevelScalar(${volume / 100}, [Guid]::Empty)
      "`;
      
      await execPromise(command);
      return { success: true, volume };
    } catch (error) {
      console.error('[Volume] Errore impostazione volume:', error.message);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("volume:get", async () => {
    return windowsVolume.get();
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execPromise = util.promisify(exec);
      
      const command = `powershell -Command "
        Add-Type -TypeDefinition @'
        using System;
        using System.Runtime.InteropServices;
        [Guid(\"5CDF2C82-841E-4546-9722-0CF74078229A\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioEndpointVolume {
          int GetMasterVolumeLevelScalar(out float pfLevel);
          int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
        }
        [Guid(\"D666063F-1587-4E43-81F1-B948E807363F\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDevice {
          int Activate(ref Guid iid, int dwClsCtx, int pActivationParams, out IAudioEndpointVolume ppInterface);
        }
        [Guid(\"A95664D2-9614-4F35-A746-DE8DB63617E6\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDeviceEnumerator {
          int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
        }
        [ComImport, Guid(\"BCDE0395-E52F-467C-8E3D-C4579291692E\")] class MMDeviceEnumerator { }
        '@
        \$enumerator = New-Object MMDeviceEnumerator
        \$device = \$null
        \$enumerator.GetDefaultAudioEndpoint(0, 1, [ref]\$device)
        \$endpointVolume = \$null
        \$guid = [Guid]\"5CDF2C82-841E-4546-9722-0CF74078229A\"
        \$device.Activate([ref]\$guid, 7, 0, [ref]\$endpointVolume)
        \$level = 0.0
        \$endpointVolume.GetMasterVolumeLevelScalar([ref]\$level)
        [int](\$level * 100)
      "`;
      
      const { stdout } = await execPromise(command);
      const volume = parseInt(stdout.trim());
      return { success: true, volume: isNaN(volume) ? 100 : volume };
    } catch (error) {
      console.error('[Volume] Errore lettura volume:', error.message);
      return { success: false, error: error.message, volume: 100 };
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (allowQuit) app.quit();
});
