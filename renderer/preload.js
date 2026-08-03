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

  // Schermo
  setScreenPower: (on) => ipcRenderer.send("ui:setScreenPower", on),
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
  onIPTVPlay: (cb) => ipcRenderer.on("iptv:play", (_e, data) => cb(data))
});
