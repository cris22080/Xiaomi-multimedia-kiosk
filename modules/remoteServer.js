// modules/remoteServer.js
// Espone: (1) la pagina web del telecomando remoto, (2) la callback OAuth
// di Spotify (l'utente fa login nel browser di sistema, Spotify rimanda qui).

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const spotify = require("./spotify");


let io = null;
let iptvConfigRef = null;
let mainHandlers = null;

function start(port, handlers, config, companionConfig = {}) {
  mainHandlers = handlers;
  iptvConfigRef = config;
  const app = express();
  app.use(express.static(path.join(__dirname, "..", "remote", "public")));

  app.get("/spotify/callback", async (req, res) => {
    try {
      const { code, error } = req.query;
      if (error) throw new Error(error);
      await spotify.exchangeCode(code);
      handlers.onSpotifyAuthenticated();
      res.send("<html><body style='font-family:sans-serif;background:#111;color:#eee;text-align:center;padding-top:80px'><h2>Spotify connesso ✅</h2><p>Puoi chiudere questa scheda e tornare all'app.</p></body></html>");
    } catch (err) {
      res.status(500).send(`Errore login Spotify: ${err.message}`);
    }
  });

  app.get("/spotify/playlists", async (req, res) => {
    try {
      const playlists = await spotify.getPlaylists();
      res.json(playlists || []);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/iptv/config", (req, res) => {
    res.json(iptvConfigRef || {});
  });

  app.get("/state", (req, res) => {
    res.json(handlers.onGetState());
  });

  // Riceve il Now Playing dal companion installato su un altro PC Windows.
  app.post("/media-session", express.json({ limit: "5mb" }), (req, res) => {
    const expected = String(companionConfig.token || "");
    const supplied = String(req.get("x-cozy-token") || "");
    if (!expected || supplied !== expected) return res.status(401).json({ error: "Token non valido" });
    try {
      handlers.onRemoteMediaSession(req.body ?? null);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Serve an imported channels playlist if present at repo root
  app.get("/channels.m3u8", (req, res) => {
    const channelsPath = path.join(__dirname, "..", "channels.m3u8");
    const fs = require("fs");
    if (fs.existsSync(channelsPath)) {
      res.sendFile(channelsPath);
    } else {
      res.status(404).send("Not found");
    }
  });

 

  // Volume endpoints
  app.get("/volume/get", async (req, res) => {
    try {
      const result = await handlers.onGetVolume();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/volume/set", express.json(), async (req, res) => {
    try {
      const { level } = req.body;
      if (level === undefined) {
        return res.status(400).json({ error: 'level richiesto' });
      }
      const result = await handlers.onSetVolume(level);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Alarm endpoints: persistent scheduling is handled by the main process.
  app.get("/alarms", (req, res) => {
    try { res.json(handlers.onGetAlarms()); } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.post("/alarms", express.json(), (req, res) => {
    try { res.json(handlers.onSaveAlarm(req.body)); } catch (err) { res.status(400).json({ error: err.message }); }
  });
  app.delete("/alarms/:id", (req, res) => {
    try { res.json(handlers.onDeleteAlarm(req.params.id)); } catch (err) { res.status(400).json({ error: err.message }); }
  });
  app.post("/alarms/stop", (req, res) => {
    try { res.json(handlers.onStopAlarm()); } catch (err) { res.status(500).json({ error: err.message }); }
  });

  const server = http.createServer(app);
  io = new Server(server);

  io.on("connection", (socket) => {
    socket.emit("state", handlers.onGetState());

    socket.on("toggleCozy", (show) => handlers.onToggleCozy(show));
    socket.on("screenPower", (on) => handlers.onScreenPower(on));
    socket.on("requestState", () => socket.emit("state", handlers.onGetState()));
    socket.on("shutdownApp", () => handlers.onShutdownApp());
    
    // IPTV: send to main window to play channel
    socket.on("playIPTV", (data) => {
      handlers.onPlayIPTV(data);
    });

    socket.on("remoteMouse", (action) => {
      if (typeof handlers.onRemoteMouse === "function") handlers.onRemoteMouse(action || {});
    });
    
    // Remote command to close IPTV overlay (useful for kiosk without keyboard)
    socket.on("closeIPTV", () => {
      if (typeof handlers.onCloseIPTV === 'function') handlers.onCloseIPTV();
    });
    
    // Spotify: trigger view change to Spotify
    socket.on("spotifyPlaylist", (playlistId) => {
      handlers.onToggleCozy(false);
    });
  });

  server.listen(port, () => {
    console.log(`[remoteServer] telecomando disponibile su http://<IP-DEL-PC>:${port}`);
  });

  return server;
}

module.exports = { start };
