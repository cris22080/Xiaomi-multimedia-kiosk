# Cozy Desk

## Interfaccia e telecomando aggiornati

Il kiosk e il telecomando condividono il nuovo tema scuro. La Home dà più
spazio alla centralina Arduino; il telecomando dispone le sezioni su una,
due o tre colonne in base alla larghezza dello schermo.

Per F1Net: apri **TV & Live → Sport → F1Net**, quindi usa **Navigazione**.
Trascina sul touchpad per spostare il cursore, tocca per cliccare; restano
disponibili frecce, passo veloce, scorrimento, Indietro, Ricarica, Tab,
Invio ed Esc. **Chiudi player** torna alla Home. La pagina web è isolata
dalle funzioni del kiosk; nessuna modifica a IP, companion Spotify o Arduino.
La copertina automatica non copre più una sessione TV in corso.

Dopo aver copiato gli aggiornamenti sullo Xiaomi, riavvia Cozy Desk. Se lo
avvii dai sorgenti, usa `npm.cmd start`. Se usi una versione installata,
ricompila/reinstalla la versione ARM64. Ricarica anche la pagina del
telecomando (su PC: Ctrl+F5). Non servono nuove dipendenze.

Verifiche locali per lo sviluppo:

```powershell
npm.cmd test
npm.cmd run test:input
npm.cmd run test:ui
```

I test Electron usano pagine locali, profili temporanei e dati fittizi:
non avviano il kiosk reale, non cambiano la luminosità e non inviano
comandi ad Arduino. Gli screenshot di verifica sono salvati nella cartella
temporanea indicata dal test. La disponibilità della diretta F1Net e la
compatibilità del sito con lo Xiaomi richiedono una prova sul dispositivo.

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

## Building and packaging for Windows ARM64

Development and running:
- Use Node.js 18+ ARM64 on the target device to run the app during development.
  cd cozy-desk && npm install && npm start

Packaging (NSIS installer for ARM64):
- On an ARM64 Windows machine: run:
  npm install
  npm run package:win-arm64
  The produced installer will be placed in the `dist/` folder.

Notes on cross-building:
- electron-builder will download the ARM64 Electron runtime automatically when building for --arm64.
- Cross-building from a different host architecture (x64 or Linux) often requires Wine and extra tooling and is error-prone. Recommended approaches:
  1) Build on an ARM64 Windows machine (fastest), or
  2) Add a CI runner with Windows ARM64 (GitHub Actions or self-hosted) to produce artifacts.

If you want, a GitHub Actions workflow to build ARM64 installers can be added to this repo.

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
