// main.js — processo principale Electron
// Architettura: UNA sola finestra, sempre in primo piano, che al suo interno
// mostra "schermate" diverse (Home, Cozy View, Spotify) gestite lato
// renderer. Nessuna finestra popup separata.

const { app, BrowserWindow, WebContentsView, ipcMain, screen, Menu, shell, powerSaveBlocker } = require("electron");
const path = require("path");

const config = require("./config");
const arduinoClient = require("./modules/arduinoClient");
const screenControl = require("./modules/screenControl");
const network = require("./modules/network");
const remoteServer = require("./modules/remoteServer");
const spotify = require("./modules/spotify");
const windowsMediaSession = require("./modules/windowsMediaSession");
const windowsVolume = require("./modules/windowsVolume");
const { WebPlayer } = require("./modules/webPlayer");

const alarmManager = require("./modules/alarmManager");

let mainWindow = null;
let allowQuit = false; // true solo dopo il comando remoto di chiusura
let spotifyPollTimer = null;
let webPlayer = null;
let activeView = 'home';
let playingChannel = null;
let softScreenOn = true;
let suspensionBlockerId = null;
let remoteMediaTimeout = null;
let remoteMediaHideTimeout = null;
let lastRemoteMediaHeartbeat = 0;

function remoteMediaIsActive() {
  // Il companion invia un heartbeat ogni ~3 secondi, anche quando Spotify è
  // fermo. Finché è raggiungibile, è l'unica sorgente autorevole.
  return Date.now() - lastRemoteMediaHeartbeat < 10000;
}

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
  webPlayer = new WebPlayer({ window: mainWindow, WebContentsView,
    onStatus: (state) => mainWindow.webContents.send('iptv:webStatus', state) });
  mainWindow.on('closed', () => { webPlayer.close(); });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function setActiveView(view) {
  if (!['home', 'cozy', 'iptv', 'spotify', 'alarm'].includes(view)) return;
  activeView = view;
  if (view !== 'iptv') {
    webPlayer?.close();
    playingChannel = null;
  }
  remoteServer.broadcastState();
}

function syncScreen(on) {
  softScreenOn = Boolean(on);
  webPlayer?.setScreenOn(softScreenOn);
  remoteServer.broadcastState();
}

function shutdownFromRemote() {
  allowQuit = true;
  app.quit();
}

// --- Polling Spotify globale: serve anche fuori dalla schermata Spotify per
// mostrare automaticamente il Now Playing sul dispositivo configurato.
function startSpotifyPolling() {
  stopSpotifyPolling();
  // Il monitor locale non richiede Premium ed è la fonte primaria sul kiosk.
  if (config.windowsMedia?.enabled) return;
  if (!spotify.isAuthenticated()) return;

  async function tick() {
    try {
      const track = await spotify.getCurrentlyPlaying();
      const wantedDevice = String(config.spotify.targetDeviceName || "").trim().toLowerCase();
      const activeDevice = String(track?.device?.name || "").toLowerCase();
      const deviceMatches = !wantedDevice || activeDevice.includes(wantedDevice);
      const payload = track ? {
        ...track,
        autoDisplay: Boolean(config.spotify.autoNowPlaying && deviceMatches && track.isPlaying),
        deviceMatches
      } : null;
      mainWindow.webContents.send("spotify:nowPlaying", payload);
    } catch (err) {
      mainWindow.webContents.send("spotify:error", err.message);
    }
  }
  tick();
  const interval = Math.max(3000, Number(config.spotify.pollingIntervalMs) || 5000);
  spotifyPollTimer = setInterval(tick, interval);
}

function stopSpotifyPolling() {
  if (spotifyPollTimer) clearInterval(spotifyPollTimer);
  spotifyPollTimer = null;
}

app.whenReady().then(() => {
  spotify.configure(config.spotify);
  // Mantiene processo, rete e display logicamente attivi. La luminosità viene
  // portata a zero da screenControl senza attivare Modern Standby sullo Xiaomi.
  suspensionBlockerId = powerSaveBlocker.start("prevent-display-sleep");
  console.log(`[power] blocco sospensione attivo: ${powerSaveBlocker.isStarted(suspensionBlockerId)}`);
  createMainWindow();
  startSpotifyPolling();
  windowsMediaSession.start(config.windowsMedia, (track) => {
    // Evita l'alternanza: lo Xiaomi spesso non ha una sessione Spotify locale
    // e invierebbe null tra due aggiornamenti validi ricevuti dal PC companion.
    if (remoteMediaIsActive()) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("spotify:nowPlaying", track);
    }
  }, (message) => console.warn(`[media-session] ${message}`));

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
    syncScreen(on);
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
      setActiveView(show ? 'cozy' : 'home');
      mainWindow.webContents.send("nav:goto", show ? "cozy" : "home");
    },
    onScreenPower: (on) => {
      syncScreen(on);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("screen:softPower", Boolean(on));
      return screenControl.setManualScreenPower(Boolean(on));
    },
    onShutdownApp: () => shutdownFromRemote(),
    onSpotifyAuthenticated: () => {
      mainWindow.webContents.send("spotify:authenticated");
      startSpotifyPolling();
    },
    onRemoteMediaSession: (track) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      lastRemoteMediaHeartbeat = Date.now();
      const payload = track && typeof track === "object"
        ? { ...track, autoDisplay: Boolean(track.isPlaying), deviceMatches: true, remoteSession: true }
        : null;

      if (payload?.isPlaying) {
        // Un dato valido vince subito e annulla un'eventuale chiusura in
        // attesa. Serve a mascherare letture WinRT vuote intermittenti.
        if (remoteMediaHideTimeout) clearTimeout(remoteMediaHideTimeout);
        remoteMediaHideTimeout = null;
        mainWindow.webContents.send("spotify:nowPlaying", payload);
      } else if (!remoteMediaHideTimeout) {
        // Pausa/null devono persistere: una singola lettura mancante non deve
        // far lampeggiare la vista tra due heartbeat validi del companion.
        remoteMediaHideTimeout = setTimeout(() => {
          remoteMediaHideTimeout = null;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("spotify:nowPlaying", payload);
          }
        }, 8000);
      }

      if (remoteMediaTimeout) clearTimeout(remoteMediaTimeout);
      // Se il PC companion si spegne o esce dalla rete, non lascia la
      // copertina bloccata indefinitamente sul kiosk.
      remoteMediaTimeout = setTimeout(() => {
        lastRemoteMediaHeartbeat = 0;
        if (remoteMediaHideTimeout) clearTimeout(remoteMediaHideTimeout);
        remoteMediaHideTimeout = null;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("spotify:nowPlaying", null);
      }, 12000);
    },
    onPlayIPTV: (data) => {
      if (!data || typeof data.url !== 'string' || !/^https?:\/\//i.test(data.url)) return;
      setActiveView('iptv');
      playingChannel = { name: String(data.name || 'IPTV'), url: data.url, type: data.type === 'web' ? 'web' : 'hls' };
      if (mainWindow) mainWindow.setFullScreen(true);
      mainWindow.webContents.send("nav:goto", "iptv");
      mainWindow.webContents.send("iptv:play", data);
    },
    onRemoteMouse: (action) => {
      webPlayer?.mouse(action);
    },
    onRemoteBrowser: (action) => webPlayer?.browser(action),
    // Remote request to close IPTV overlay and return to home (kiosk remains fullscreen)
    onCloseIPTV: () => {
      setActiveView('home');
      if (mainWindow) mainWindow.webContents.send("nav:goto", "home");
    },
    onGetState: () => ({
      online: network.isOnline(),
      spotifyConnected: spotify.isAuthenticated(),
      screenOn: softScreenOn,
      cozyActive: activeView === 'cozy',
      playingChannel,
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
  }, config.iptv, { token: config.remote.mediaCompanionToken });

  alarmManager.start((alarm) => {
    syncScreen(true);
    setActiveView('alarm');
    screenControl.setScreenPower(true);
    if (mainWindow) {
      mainWindow.webContents.send("screen:softPower", true);
      mainWindow.setFullScreen(true);
      mainWindow.webContents.send("alarm:trigger", alarm);
    }
  });

  // --- IPC dal renderer ---
  ipcMain.on("ui:setScreenPower", (_e, on) => {
    syncScreen(on);
    mainWindow.webContents.send('screen:softPower', Boolean(on));
    screenControl.setManualScreenPower(on);
  });

  const isKiosk = (event) => event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame;
  ipcMain.on('ui:view', (event, view) => { if (isKiosk(event)) setActiveView(view); });
  ipcMain.on('iptv:channel', (event, channel) => {
    if (!isKiosk(event)) return;
    playingChannel = channel && typeof channel.url === 'string'
      ? { name: String(channel.name || 'IPTV'), url: channel.url, type: channel.type === 'web' ? 'web' : 'hls' } : null;
    remoteServer.broadcastState();
  });
  ipcMain.handle('iptv:webOpen', (event, url) => {
    if (!isKiosk(event) || activeView !== 'iptv') return { ok: false, error: 'Player non attivo.' };
    try { return webPlayer.open(url); } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.on('iptv:webClose', (event) => { if (isKiosk(event)) webPlayer.close(); });
  ipcMain.on('iptv:webPresent', (event, presentation) => {
    if (isKiosk(event) && presentation && typeof presentation === 'object') webPlayer.setPresentation(presentation);
  });
  ipcMain.on('iptv:webAction', (event, action) => { if (isKiosk(event)) webPlayer.browser(action); });
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

  // Conservati per compatibilità con il renderer: il polling ora resta
  // attivo in background per il Now Playing automatico.
  ipcMain.on("ui:enteredSpotifyView", () => {
    if (!spotifyPollTimer) startSpotifyPolling();
  });
  ipcMain.on("ui:leftSpotifyView", () => {});

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

app.on("will-quit", () => {
  webPlayer?.close();
  if (remoteMediaTimeout) clearTimeout(remoteMediaTimeout);
  if (remoteMediaHideTimeout) clearTimeout(remoteMediaHideTimeout);
  stopSpotifyPolling();
  windowsMediaSession.stop();
});
