// renderer/preload.js
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cozyDesk", {
  // Arduino
  onArduinoData: (cb) => ipcRenderer.on("arduino:data", (_e, data) => cb(data)),
  onArduinoError: (cb) => ipcRenderer.on("arduino:error", (_e, msg) => cb(msg)),
  toggleArduino: (target) => ipcRenderer.invoke("arduino:toggle", target),

  // Rete
  onNetworkStatus: (cb) => ipcRenderer.on("network:status", (_e, status) => cb(status)),

  // Navigazione (es. da remoto)
  onNavGoto: (cb) => ipcRenderer.on("nav:goto", (_e, view) => cb(view)),
  reportView: (view) => ipcRenderer.send('ui:view', view),
  onRemoteCursor: (cb) => ipcRenderer.on('remote:cursor', (_e, point) => cb(point)),

  // Schermo
  setScreenPower: (on) => ipcRenderer.send("ui:setScreenPower", on),
  onSoftScreenPower: (cb) => ipcRenderer.on("screen:softPower", (_e, on) => cb(Boolean(on))),
  // Request main process to put the app window into OS fullscreen (kiosk) or exit it
  setAppFullscreen: (on) => ipcRenderer.invoke("ui:setAppFullscreen", on),
  // Get a local cozy-media video file path (file://...) or null if none
  getLocalCozyVideo: () => ipcRenderer.invoke('cozy:getLocalVideo'),

  // Spotify
  spotifyIsAuthenticated: () => ipcRenderer.invoke("spotify:isAuthenticated"),
  spotifyLogin: () => ipcRenderer.send("spotify:login"),
  onSpotifyAuthenticated: (cb) => ipcRenderer.on("spotify:authenticated", () => cb()),
  onSpotifyNowPlaying: (cb) => ipcRenderer.on("spotify:nowPlaying", (_e, track) => cb(track)),
  onSpotifyError: (cb) => ipcRenderer.on("spotify:error", (_e, msg) => cb(msg)),
  getSpotifyPlaylists: () => ipcRenderer.invoke("spotify:getPlaylists"),
  getSpotifyPlaylistTracks: (id) => ipcRenderer.invoke("spotify:getPlaylistTracks", id),
  enteredSpotifyView: () => ipcRenderer.send("ui:enteredSpotifyView"),
  leftSpotifyView: () => ipcRenderer.send("ui:leftSpotifyView"),

  // IPTV
  getIPTVConfig: () => ipcRenderer.invoke("iptv:getConfig"),
  onIPTVPlay: (cb) => ipcRenderer.on("iptv:play", (_e, data) => cb(data)),
  reportChannel: (channel) => ipcRenderer.send('iptv:channel', channel),
  openWebPlayer: (url) => ipcRenderer.invoke('iptv:webOpen', url),
  closeWebPlayer: () => ipcRenderer.send('iptv:webClose'),
  presentWebPlayer: (presentation) => ipcRenderer.send('iptv:webPresent', presentation),
  webBrowserAction: (action) => ipcRenderer.send('iptv:webAction', action),
  onWebPlayerStatus: (cb) => ipcRenderer.on('iptv:webStatus', (_e, state) => cb(state)),

  // Sveglia
  onAlarmTrigger: (cb) => ipcRenderer.on("alarm:trigger", (_e, alarm) => cb(alarm)),
  onAlarmStop: (cb) => ipcRenderer.on("alarm:stop", () => cb()),
  stopAlarm: () => ipcRenderer.invoke("alarm:stop"),

  // Bluetooth
  getBluetoothDevices: () => ipcRenderer.invoke("bluetooth:getDevices"),
  connectBluetoothDevice: (instanceId) => ipcRenderer.invoke("bluetooth:connect", instanceId),
  disconnectBluetoothDevice: (instanceId) => ipcRenderer.invoke("bluetooth:disconnect", instanceId),
  removeBluetoothDevice: (instanceId) => ipcRenderer.invoke("bluetooth:remove", instanceId),

  // Volume Control
  setVolume: (level) => ipcRenderer.invoke("volume:set", level),
  getVolume: () => ipcRenderer.invoke("volume:get")
});
