const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WebPlayer } = require('../modules/webPlayer');

class Contents extends EventEmitter {
  constructor(log = []) {
    super();
    this.log = log;
    this.events = [];
    this.messages = [];
    this.destroyed = false;
    this.protocolEvents = [];
    this.debugger = {
      isAttached: () => this.attached === true,
      attach: () => { this.attached = true; },
      sendCommand: async (method, input) => {
        this.protocolEvents.push({ method, input });
        const types = { mouseMoved: 'mouseMove', mousePressed: 'mouseDown', mouseReleased: 'mouseUp', mouseWheel: 'mouseWheel' };
        if (method === 'Input.dispatchKeyEvent') {
          this.sendInputEvent({ type: input.type === 'rawKeyDown' ? 'keyDown' : 'keyUp', keyCode: input.key });
        } else {
          const event = { type: types[input.type], x: input.x, y: input.y };
          if (input.button !== 'none') { event.button = input.button; event.clickCount = input.clickCount; }
          if (input.type === 'mouseWheel') { event.deltaX = input.deltaX; event.deltaY = -input.deltaY; event.canScroll = true; }
          this.sendInputEvent(event);
        }
      }
    };
    this.session = {
      setPermissionRequestHandler: (fn) => { this.requestPermission = fn; },
      setPermissionCheckHandler: (fn) => { this.checkPermission = fn; }
    };
  }
  loadURL(url) { this.url = url; return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  close() { this.destroyed = true; this.emit('destroyed'); }
  focus() { this.log.push('contents:focus'); }
  sendInputEvent(event) { this.log.push(event.type); this.events.push(event); }
  send(channel, data) { this.messages.push({ channel, data: { ...data } }); }
  setWindowOpenHandler(fn) { this.openWindow = fn; }
  canGoBack() { return this.hasHistory === true; }
  goBack() { this.wentBack = true; }
  reload() { this.reloaded = true; }
}

function setup() {
  const log = [];
  const views = [];
  const statuses = [];
  const children = [];
  const window = {
    webContents: new Contents(log),
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 25, y: 30, width: 1000, height: 600 }),
    focus: () => log.push('window:focus'),
    contentView: {
      addChildView: (view) => children.push(view),
      removeChildView: (view) => children.splice(children.indexOf(view), 1)
    }
  };
  class View {
    constructor(options) {
      this.options = options;
      this.webContents = new Contents(log);
      views.push(this);
    }
    setBackgroundColor(color) { this.color = color; }
    setBounds(bounds) { this.bounds = { ...bounds }; }
    setVisible(visible) { this.visible = visible; }
  }
  const player = new WebPlayer({ window, WebContentsView: View, onStatus: (data) => statuses.push(data) });
  const present = () => player.setPresentation({ visible: true, bounds: { x: 100, y: 70, width: 700, height: 450 } });
  return { player, window, views, children, statuses, log, present };
}

test('web page is isolated, hidden until presented, and uses a separate browser surface', async () => {
  const { player, views, children, present } = setup();
  assert.deepEqual(player.open('https://example.test/stream'), { ok: true });
  const view = views[0];
  assert.equal(children[0], view);
  assert.equal(view.visible, false);
  assert.equal(view.webContents.url, 'https://example.test/stream');
  const prefs = view.options.webPreferences;
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.webSecurity, true);
  assert.match(prefs.preload, /web-player-preload\.js$/);
  assert.deepEqual(view.webContents.openWindow({ url: 'https://example.test/ad' }), { action: 'deny' });
  assert.equal(view.webContents.checkPermission(null, 'media'), false);
  present();
  assert.equal(view.visible, true);
  assert.deepEqual(view.bounds, { x: 100, y: 70, width: 700, height: 450 });
});

test('only http/https entry points and navigation are allowed', async () => {
  const { player, views } = setup();
  for (const url of ['file:///C:/secrets.txt', 'javascript:alert(1)', 'data:text/html,a', 'not a url', null]) {
    assert.throws(() => player.open(url), /http/);
  }
  assert.equal(views.length, 0);
  player.open('https://example.test/');
  let prevented = 0;
  const event = { preventDefault: () => { prevented += 1; } };
  views[0].webContents.emit('will-navigate', event, 'file:///C:/secret');
  views[0].webContents.emit('will-redirect', event, 'https://example.test/live');
  assert.equal(prevented, 1);
});

test('native mouse coordinates are local to the embedded page, with focus before input', async () => {
  const { player, views, window, present, log } = setup();
  player.open('https://example.test/');
  present();
  await player.mouse({ type: 'moveRelative', dx: 15, dy: -20 });
  assert.deepEqual(views[0].webContents.events, [{ type: 'mouseMove', x: 365, y: 205 }]);
  assert.deepEqual(log.slice(0, 3), ['window:focus', 'contents:focus', 'mouseMove']);
  assert.equal(window.webContents.events.length, 0);
  assert.deepEqual(views[0].webContents.messages[0], { channel: 'remote:cursor', data: { x: 365, y: 205 } });
});

test('click moves first then sends a complete down/up pair even before any movement', async () => {
  const { player, views, present } = setup();
  player.open('https://example.test/');
  present();
  await player.mouse({ type: 'click' });
  assert.deepEqual(views[0].webContents.events, [
    { type: 'mouseMove', x: 350, y: 225 },
    { type: 'mouseDown', x: 350, y: 225, button: 'left', clickCount: 1 },
    { type: 'mouseUp', x: 350, y: 225, button: 'left', clickCount: 1 }
  ]);
});

test('direction pad, touchpad limits and wheel retain safe integer coordinates', async () => {
  const { player, views, present } = setup();
  player.open('https://example.test/');
  present();
  await player.mouse({ type: 'move', dx: 1, dy: -1 });
  assert.deepEqual(player.cursor, { x: 372, y: 203 });
  await player.mouse({ type: 'move', dx: 1, dy: 0, large: true });
  assert.deepEqual(player.cursor, { x: 462, y: 203 });
  await player.mouse({ type: 'moveRelative', dx: 100000, dy: -100000 });
  assert.deepEqual(player.cursor, { x: 699, y: 0 });
  await player.mouse({ type: 'scroll', dy: -1 });
  assert.deepEqual(views[0].webContents.events.at(-1), {
    type: 'mouseWheel', x: 699, y: 0, deltaX: 0, deltaY: -120, canScroll: true
  });
  await player.mouse({ type: 'moveRelative', dx: NaN, dy: 'wrong' });
  assert.deepEqual(player.cursor, { x: 699, y: 0 });
});

test('bounds are clipped to the content area and cursors are clipped after resize', async () => {
  const { player, views, present } = setup();
  player.open('https://example.test/');
  present();
  await player.mouse({ type: 'click' });
  player.setPresentation({ visible: true, bounds: { x: 850.7, y: -10, width: 5000, height: 120 } });
  assert.deepEqual(views[0].bounds, { x: 851, y: 0, width: 149, height: 120 });
  await player.mouse({ type: 'click' });
  assert.deepEqual(player.cursor, { x: 148, y: 119 });
});

test('screen off and hidden presentation reject inputs without waking or leaking to kiosk', async () => {
  const { player, views, window, log, present } = setup();
  player.open('https://example.test/');
  present();
  player.setScreenOn(false);
  await player.mouse({ type: 'click' });
  await player.browser({ type: 'reload' });
  assert.equal(views[0].visible, false);
  assert.equal(log.length, 0);
  assert.equal(views[0].webContents.reloaded, undefined);
  player.setScreenOn(true);
  assert.equal(views[0].visible, true);
  player.setPresentation({ visible: false });
  await player.mouse({ type: 'click' });
  assert.equal(log.length, 0);
  assert.equal(window.webContents.events.length, 0);
});

test('closing releases old contents, suppresses old status and resets cursor target', async () => {
  const { player, window, views, children, statuses, present } = setup();
  player.open('https://example.test/one');
  present();
  await player.mouse({ type: 'move', dx: 1, dy: 1 });
  const first = views[0];
  first.webContents.emit('did-start-loading');
  assert.deepEqual(statuses, [{ loading: true }]);
  player.open('https://example.test/two');
  assert.equal(first.webContents.destroyed, true);
  assert.equal(children.length, 1);
  first.webContents.emit('did-stop-loading');
  assert.equal(statuses.length, 1);
  assert.equal(player.cursor, null);
  player.close();
  player.close();
  assert.equal(children.length, 0);
  assert.equal(views[1].webContents.destroyed, true);
  await player.mouse({ type: 'click' });
  assert.deepEqual(window.webContents.events[0], { type: 'mouseMove', x: 500, y: 300 });
});

test('back and reload target only the active page; allowed keys use a complete pair', async () => {
  const { player, views, window, present } = setup();
  await player.browser({ type: 'reload' });
  assert.equal(window.webContents.reloaded, undefined);
  player.open('https://example.test/');
  present();
  const wc = views[0].webContents;
  await player.browser({ type: 'back' });
  assert.equal(wc.wentBack, undefined);
  wc.hasHistory = true;
  await player.browser({ type: 'back' });
  await player.browser({ type: 'reload' });
  assert.equal(wc.wentBack, true);
  assert.equal(wc.reloaded, true);
  await player.browser({ type: 'key', key: 'Enter' });
  assert.deepEqual(wc.events, [
    { type: 'keyDown', keyCode: 'Enter' },
    { type: 'keyUp', keyCode: 'Enter' }
  ]);
});

test('unknown actions and shortcuts are ignored; dead window never gets input', async () => {
  const { player, window, log } = setup();
  for (const action of [null, undefined, {}, 'click', { type: 'drag' }]) player.mouse(action);
  for (const action of [null, {}, { type: 'key', key: 'F4' }, { type: 'exec' }]) player.browser(action);
  assert.equal(log.length, 0);
  window.isDestroyed = () => true;
  await player.mouse({ type: 'click' });
  assert.equal(log.length, 0);
});

test('main-frame load failures are shown; cancelled and iframe errors are not', async () => {
  const { player, views, statuses } = setup();
  player.open('https://example.test/');
  const wc = views[0].webContents;
  wc.emit('did-fail-load', {}, -3, 'ABORTED', wc.url, true);
  wc.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', wc.url, false);
  assert.equal(statuses.length, 0);
  wc.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', wc.url, true);
  assert.equal(statuses.length, 1);
  assert.match(statuses[0].error, /NAME_NOT_RESOLVED/);
});
