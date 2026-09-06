// Run with: node_modules/electron/dist/electron.exe tests/electron-smoke.js
// Isolated local fixtures only: no kiosk, hardware controls or user profile.
const { app, BrowserWindow, WebContentsView } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { WebPlayer } = require('../modules/webPlayer');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cozy-webplayer-smoke-'));
app.setPath('userData', path.join(temporary, 'profile'));
app.disableHardwareAcceleration();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const frameByURL = (frame, suffix) => frame.url.endsWith(suffix) ? frame : frame.frames.map((child) => frameByURL(child, suffix)).find(Boolean);
let mainWindow;
let player;
let firstServer;
let secondServer;
const deadline = setTimeout(() => finish(new Error('Smoke test timed out')), 20000);

function finish(error) {
  clearTimeout(deadline);
  if (player) player.close();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  firstServer?.close();
  secondServer?.close();
  if (error) console.error(error.stack || error);
  else console.log('PASS: focused WebContentsView receives click, wheel and key inputs through nested cross-origin frames; off/close lifecycle verified.');
  console.log(`Isolated test artifacts: ${temporary}`);
  app.exit(error ? 1 : 0);
}

app.whenReady().then(async () => {
  let firstOrigin;
  let secondOrigin;
  firstServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/button') {
      res.end(`<!doctype html><html><head><style>html,body{margin:0;background:#10151b;color:white;font:16px sans-serif}body{height:1800px}button{position:absolute;left:calc(50% - 100px);top:260px;width:200px;height:80px;background:#79dfc1;border:0;border-radius:16px;font:700 16px sans-serif}</style></head><body><button id="target">Remote input fixture</button><script>window.clicks=0;window.keys=[];target.onclick=()=>window.clicks++;document.addEventListener('keydown',e=>window.keys.push(e.key));</script></body></html>`);
    } else {
      res.end(`<!doctype html><html><body style="margin:0"><iframe src="${secondOrigin}/middle" style="position:absolute;inset:0;border:0;width:100%;height:100%"></iframe></body></html>`);
    }
  });
  secondServer = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><body style="margin:0"><iframe src="${firstOrigin}/button" style="position:absolute;inset:0;border:0;width:100%;height:100%"></iframe></body></html>`);
  });
  await listen(firstServer);
  await listen(secondServer);
  firstOrigin = `http://127.0.0.1:${firstServer.address().port}`;
  secondOrigin = `http://localhost:${secondServer.address().port}`;
  mainWindow = new BrowserWindow({ width: 940, height: 740, show: true, title: 'Cozy Desk – isolated input test',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await mainWindow.loadURL('data:text/html,<body style="margin:0;background:%231c242c;color:white;font:14px sans-serif">Cozy Desk · local input test</body>');
  player = new WebPlayer({ window: mainWindow, WebContentsView });
  player.setPresentation({ visible: true, bounds: { x: 40, y: 40, width: 800, height: 600 } });
  player.open(`${firstOrigin}/outer`);
  await new Promise((resolve, reject) => {
    player.view.webContents.once('did-finish-load', resolve);
    player.view.webContents.once('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) reject(new Error(description));
    });
  });
  await sleep(400);
  const leaf = frameByURL(player.view.webContents.mainFrame, '/button');
  assert.ok(leaf, 'Nested cross-origin fixture loaded');
  mainWindow.focus();
  player.view.webContents.focus();
  await sleep(350);
  console.log('Focus:', mainWindow.isFocused(), player.view.webContents.isFocused(), 'view', player.view.getBounds());
  await leaf.executeJavaScript("document.addEventListener('pointerdown',e=>window.lastPointer={x:e.clientX,y:e.clientY,target:e.target.tagName},true)");
  fs.writeFileSync(path.join(temporary, 'before-input.png'), (await player.view.webContents.capturePage()).toPNG());
  console.log('Fixture:', await leaf.executeJavaScript('JSON.stringify({width:innerWidth,height:innerHeight,button:target.getBoundingClientRect().toJSON(),focus:document.hasFocus()})'));
  player.mouse({ type: 'click' });
  await sleep(180);
  console.log('After click:', await leaf.executeJavaScript('JSON.stringify({clicks:window.clicks,pointer:window.lastPointer,focus:document.hasFocus()})'));
  assert.equal(await leaf.executeJavaScript('window.clicks'), 1, 'First centered click reaches nested frame button');
  player.browser({ type: 'key', key: 'Enter' });
  await sleep(120);
  assert.equal(await leaf.executeJavaScript("window.keys.includes('Enter')"), true, 'Keyboard goes to focused nested frame');
  player.mouse({ type: 'scroll', dy: -2 });
  await sleep(280);
  assert.ok(await leaf.executeJavaScript('window.scrollY > 0'), 'Wheel scrolls frame below virtual cursor');
  const clicksBeforeOff = await leaf.executeJavaScript('window.clicks');
  player.setScreenOn(false);
  player.mouse({ type: 'click' });
  player.browser({ type: 'key', key: 'Enter' });
  await sleep(120);
  assert.equal(await leaf.executeJavaScript('window.clicks'), clicksBeforeOff, 'Off state suppresses input');
  player.setScreenOn(true);
  fs.writeFileSync(path.join(temporary, 'nested-input.png'), (await mainWindow.webContents.capturePage()).toPNG());
  const oldContents = player.view.webContents;
  player.close();
  await sleep(120);
  assert.equal(oldContents.isDestroyed(), true, 'Closing releases native web contents');
  finish();
}).catch(finish);
