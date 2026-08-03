// config.js
// Configurazione centrale. Modifica questi valori in base al tuo setup.

module.exports = {
  // Web server esposto dalla tua centralina ESP32 (vedi domotica_esp32.ino)
  arduino: {
    baseUrl: "http://192.168.1.82", // <-- metti l'IP reale della tua ESP32
    dataEndpoint: "/api/data",
    toggleEndpoints: {
      ventilatore: "/api/toggleVentilatore",
      luci: "/api/toggleLuci",
      lampada: "/api/toggleLampada",
      automatismi: "/api/toggleAutomatismi"
    },
    pollIntervalMs: 2000,    // Ridotto da 4000 a 2000: aggiornamenti ogni 2 secondi
    timeoutMs: 1500          // Ridotto timeout proporzionalmente
  },

  // Fasce orarie in cui lo schermo deve essere ACCESO (24h). Fuori da queste
  // fasce lo schermo viene spento (ma il PC resta acceso e attivo).
  screenSchedule: {
    enabled: true,
    onFrom: "07:00",
    onTo: "23:30"
  },

  // Server per il telecomando remoto + callback OAuth Spotify
  remote: {
    port: 4848
  },

  // App Spotify (creala gratis su https://developer.spotify.com/dashboard)
  // Redirect URI da registrare nel dashboard Spotify: deve combaciare
  // ESATTAMENTE con quello qui sotto.
  spotify: {
    clientId: "INSERISCI_IL_TUO_CLIENT_ID",
    redirectUri: "http://127.0.0.1:4848/spotify/callback",
    scopes: [
      "user-read-currently-playing",
      "user-read-playback-state",
      "playlist-read-private",
      "playlist-read-collaborative"
    ]
  },

  // Cartella dove mettere i video/animazioni per la cozy view
  cozy: {
    mediaFolder: "./cozy-media"
  },

  // IPTV - Canali organizzati per categoria
  // Ogni link può contenere una playlist M3U con multipli canali
  iptv: {
    enabled: true,
    categories: [
      {
        name: "TG",
        icon: "📰",
        channels: [
          { name: "TG1", url: "http://..." },
          { name: "TG2", url: "http://..." },
          { name: "TG3", url: "http://..." }
        ]
      },
      {
        name: "Sport",
        icon: "⚽",
        channels: [
          { name: "Sky Sport", url: "http://163.172.42.177:25461/live/13/13/1448.ts" },
          { name: "DAZN", url: "http://..." },
          { name: "Eurosport", url: "http://..." }
        ]
      },
      {
        name: "Musica",
        icon: "🎵",
        channels: [
          { name: "MTV", url: "http://..." },
          { name: "Radio Italia", url: "http://..." }
        ]
      },
      {
        name: "Film",
        icon: "🎬",
        channels: [
          { name: "Cinema Premium", url: "http://..." },
          { name: "Fox Movies", url: "http://..." }
        ]
      }
    ]
  }
};
