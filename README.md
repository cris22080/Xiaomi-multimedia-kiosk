# Cozy Desk

App desktop per Windows ARM64 (Electron), **una sola finestra sempre in
primo piano** con tre "schermate" interne (non finestre separate):

- **Home** — orologio digitale, temperatura/umidità e interruttori letti
  dalla tua centralina ESP32 (`domotica_esp32.ino`)
- **Cozy View** — video/animazione a schermo intero
- **Spotify** — brano in riproduzione e playlist, lette dalle vere API
  Spotify (non più un iframe)

Resta sempre in sovraimpressione, senza bottoni di chiusura: l'unico modo
per chiuderla è il **telecomando web**, da telefono.

## Requisiti

- Windows 10/11 **ARM64** (Snapdragon, Surface Pro X, ecc.)
- [Node.js](https://nodejs.org) 18+ **build ARM64** (non x64)
- La tua ESP32 aggiornata con `arduino/domotica_esp32.ino` (vedi sotto)
- Un'app Spotify creata su https://developer.spotify.com/dashboard (gratis)

## 1. Firmware ESP32

Ho aggiunto al tuo sketch originale (`domotica_esp32.ino`) tre nuove rotte,
senza toccare nulla del resto (Tuya, display OLED, pagina web esistente
restano identici):

- `GET /api/data` → JSON con temperatura, umidità, stato di ventilatore/luci/
  lampada, ecc.
- `GET /api/toggleVentilatore`, `/api/toggleLuci`, `/api/toggleLampada` →
  accendono/spengono e rispondono in JSON (usate dall'app per i pulsanti)

Sono tutte con header CORS, così l'app Electron può chiamarle direttamente.
Carica lo sketch aggiornato sulla ESP32 come al solito da Arduino IDE.

## 2. App Spotify (per leggere brano/playlist)

1. Vai su https://developer.spotify.com/dashboard → **Create app**
2. Redirect URI: `http://127.0.0.1:4848/spotify/callback` (deve combaciare
   esattamente)
3. Copia il **Client ID** (non serve il Client Secret: l'app usa il flusso
   PKCE, pensato apposta per app desktop)

## 3. Configurazione

Apri `config.js`:

```js
arduino.baseUrl        // IP della tua ESP32, es. "http://192.168.1.50"
spotify.clientId        // il Client ID copiato sopra
screenSchedule.onFrom/onTo  // fascia oraria in cui lo schermo resta acceso
```

Metti i tuoi video nella cartella `cozy-media/` e aggiorna il percorso in
`renderer/index.html` (cerca `cozyVideo`).

## 4. Installazione e avvio

```bash
cd cozy-desk
npm install
npm start
```

Alla prima apertura della schermata **Spotify**, clicca "Connetti Spotify":
si apre il browser di sistema per il login, poi torna da solo all'app.

## Telecomando remoto

Da telefono (stessa rete WiFi):

```
http://<IP-DEL-PC>:4848
```

Pulsanti disponibili: attiva/disattiva Cozy View, spegni schermo, **chiudi
applicazione** (con conferma — è l'unico modo per chiuderla).

## Come funziona la navigazione a schermate

A differenza della prima versione, **non ci sono più finestre popup**: Home,
Cozy View e Spotify sono tutte `<div>` diverse dentro la stessa finestra,
mostrate/nascoste via JavaScript (`renderer/index.html`). Il video della
Cozy View si mette in pausa quando non è la schermata attiva, per non
consumare risorse inutilmente. Il polling di Spotify parte solo quando sei
sulla schermata Spotify, per lo stesso motivo.

## Nota su Windows ARM64

Nessun modulo nativo C++ nel progetto: funziona così com'è, basta installare
Node.js ARM64 (non x64) — vedi requisiti sopra. Per un installer `.exe`
nativo: `npm run build:win-arm64` (file in `dist/`).

## Modalità "cassa automatica" (kiosk) — limiti reali

Niente barra del titolo, niente X, `closable: false`, e sono bloccate le
combinazioni Alt+F4 / Ctrl+W / F11 / Esc. Ma un utente con permessi
amministrativi può comunque terminare il processo da Task Manager, e
Alt+Tab / tasto Windows non sono bloccabili da un'app normale. Per un vero
lockdown "da totem" serve **Windows Assigned Access / Kiosk mode** a
livello di account Windows (Impostazioni → Account → Accesso assegnato),
non è configurabile dal codice dell'app.

## Struttura del progetto

```
cozy-desk/
├── main.js                  # processo principale: 1 finestra, orchestrazione
├── config.js                # tutta la configurazione in un posto solo
├── modules/
│   ├── arduinoClient.js      # polling + toggle verso la ESP32
│   ├── spotify.js            # OAuth PKCE + lettura brano/playlist
│   ├── screenControl.js      # accensione/spegnimento monitor + scheduler
│   ├── network.js            # watchdog connettività
│   └── remoteServer.js       # telecomando web + callback OAuth Spotify
├── renderer/                 # SPA con le 3 schermate (Home/Cozy/Spotify)
├── remote/public/            # pagina web del telecomando
└── arduino/
    └── domotica_esp32.ino    # il tuo sketch, con le nuove rotte /api/*
```
