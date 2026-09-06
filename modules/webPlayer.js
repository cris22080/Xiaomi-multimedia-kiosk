const path = require('path');

const bounded = (value, min, max) => Math.max(min, Math.min(max, value));
const number = (value) => typeof value === 'number' && Number.isFinite(value);
const webURL = (value) => {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
};

// Web streams have their own Chromium surface. Remote input is sent to that
// surface (including its cross-origin frames), not to the kiosk behind it.
class WebPlayer {
  constructor({ window, WebContentsView, onStatus = () => {} }) {
    this.window = window;
    this.View = WebContentsView;
    this.onStatus = onStatus;
    this.view = null;
    this.screenOn = true;
    this.presentation = { visible: false, bounds: null };
    this.cursor = null;
    this.cursorTarget = null;
    this.inputQueue = Promise.resolve();
  }

  open(url) {
    if (!webURL(url)) throw new Error('Usa un indirizzo http o https.');
    this.close();
    const view = new this.View({ webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'web-player-preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, autoplayPolicy: 'no-user-gesture-required',
      partition: 'persist:cozy-web-player'
    } });
    this.view = view;
    view.setBackgroundColor('#10151b');
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    const wc = view.webContents;
    // Remote pages never receive the kiosk preload or access to device APIs.
    wc.session.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'fullscreen'));
    wc.session.setPermissionCheckHandler((_wc, permission) => permission === 'fullscreen');
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const checkNavigation = (event, nextURL) => {
      if (!webURL(nextURL || event.url)) event.preventDefault();
    };
    wc.on('will-navigate', checkNavigation);
    wc.on('will-redirect', checkNavigation);
    wc.on('will-prevent-unload', (event) => event.preventDefault());
    wc.on('before-input-event', (event, input) => {
      const key = String(input.key).toLowerCase();
      if ((input.alt && key === 'f4') || (input.control && key === 'w') || key === 'f11') event.preventDefault();
    });
    const status = (data) => { if (this.view === view) this.onStatus(data); };
    wc.on('did-start-loading', () => status({ loading: true }));
    wc.on('did-stop-loading', () => status({ loading: false }));
    wc.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) status({ loading: false, error: `Pagina non disponibile (${description}). Riprova con Ricarica.` });
    });
    wc.on('render-process-gone', () => status({ loading: false, error: 'Il player si è interrotto. Chiudi e riapri il canale.' }));
    wc.loadURL(url).catch((error) => status({ loading: false, error: error.message }));
    this.applyPresentation();
    return { ok: true };
  }

  close() {
    if (!this.view) return;
    const previous = this.view;
    this.view = null;
    this.cursor = null;
    this.cursorTarget = null;
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(previous);
    if (!previous.webContents.isDestroyed()) previous.webContents.close();
  }

  setPresentation(presentation = {}) {
    if (!presentation || typeof presentation !== 'object') return;
    const { visible, bounds } = presentation;
    if (bounds && ['x', 'y', 'width', 'height'].every((key) => number(bounds[key]))) {
      const size = this.window.getContentBounds();
      const x = bounded(Math.round(bounds.x), 0, size.width - 1);
      const y = bounded(Math.round(bounds.y), 0, size.height - 1);
      this.presentation.bounds = { x, y,
        width: bounded(Math.round(bounds.width), 1, size.width - x),
        height: bounded(Math.round(bounds.height), 1, size.height - y) };
    }
    this.presentation.visible = visible === true;
    this.applyPresentation();
  }

  setScreenOn(on) {
    this.screenOn = Boolean(on);
    this.applyPresentation();
  }

  applyPresentation() {
    if (!this.view) return;
    const { visible, bounds } = this.presentation;
    if (bounds) this.view.setBounds(bounds);
    this.view.setVisible(Boolean(this.screenOn && visible && bounds));
  }

  target() {
    if (!this.screenOn || this.window.isDestroyed()) return null;
    if (this.view) {
      if (!this.presentation.visible || !this.presentation.bounds || this.view.webContents.isDestroyed()) return null;
      return { wc: this.view.webContents, bounds: this.presentation.bounds };
    }
    return { wc: this.window.webContents, bounds: this.window.getContentBounds() };
  }

  focus(wc) {
    // Electron requires the containing window to be focused for sendInputEvent.
    this.window.focus();
    wc.focus();
  }

  dispatch(wc, events) {
    if (wc !== this.view?.webContents) {
      events.forEach((event) => wc.sendInputEvent(event));
      return;
    }
    // Chromium's browser-side input router performs hit testing across
    // out-of-process iframes. sendInputEvent alone can lose those mouse clicks.
    this.inputQueue = this.inputQueue.then(async () => {
      if (this.target()?.wc !== wc) return;
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
        for (const event of events) {
          if (event.type === 'keyDown' || event.type === 'keyUp') {
            const keys = { Tab: ['Tab',9], Enter: ['Enter',13], Escape: ['Escape',27], Space: [' ',32], Up: ['ArrowUp',38], Down: ['ArrowDown',40], Left: ['ArrowLeft',37], Right: ['ArrowRight',39] };
            const [key, code] = keys[event.keyCode];
            await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: event.type === 'keyDown' ? 'rawKeyDown' : 'keyUp', key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: code });
          } else {
            const types = { mouseMove: 'mouseMoved', mouseDown: 'mousePressed', mouseUp: 'mouseReleased', mouseWheel: 'mouseWheel' };
            const input = { type: types[event.type], x: event.x, y: event.y, button: event.button || 'none' };
            if (event.clickCount) input.clickCount = event.clickCount;
            if (event.type === 'mouseWheel') { input.deltaX = event.deltaX; input.deltaY = -event.deltaY; }
            await wc.debugger.sendCommand('Input.dispatchMouseEvent', input);
          }
        }
      } catch (error) {
        if (this.view?.webContents === wc && !wc.isDestroyed()) this.onStatus({ error: `Comando non riuscito: ${error.message}` });
      }
    });
    return this.inputQueue;
  }

  mouse(action) {
    if (!action || !['move', 'moveRelative', 'click', 'scroll'].includes(action.type)) return;
    const target = this.target();
    if (!target) return;
    const { wc, bounds } = target;
    if (this.cursorTarget !== wc || !this.cursor) {
      this.cursor = { x: Math.round(bounds.width / 2), y: Math.round(bounds.height / 2) };
      this.cursorTarget = wc;
    }
    const delta = (value, max) => number(value) ? bounded(value, -max, max) : 0;
    if (action.type === 'move' || action.type === 'moveRelative') {
      const relative = action.type === 'moveRelative';
      const step = relative ? 1 : (action.large === true ? 90 : 22);
      this.cursor.x += delta(action.dx, relative ? 300 : 1) * step;
      this.cursor.y += delta(action.dy, relative ? 300 : 1) * step;
    }
    this.cursor.x = bounded(Math.round(this.cursor.x), 0, bounds.width - 1);
    this.cursor.y = bounded(Math.round(this.cursor.y), 0, bounds.height - 1);
    this.focus(wc);
    // Move before every click/wheel, including the first tap after opening.
    const events = [{ type: 'mouseMove', ...this.cursor }];
    wc.send('remote:cursor', this.cursor);
    if (action.type === 'click') {
      const click = { ...this.cursor, button: 'left', clickCount: 1 };
      events.push({ type: 'mouseDown', ...click }, { type: 'mouseUp', ...click });
    } else if (action.type === 'scroll') {
      events.push({ type: 'mouseWheel', ...this.cursor,
        deltaX: 0, deltaY: delta(action.dy, 3) * 120, canScroll: true });
    }
    return this.dispatch(wc, events);
  }

  browser(action) {
    if (!action || !['back', 'reload', 'key'].includes(action.type)) return;
    const target = this.target();
    if (!target) return;
    const { wc } = target;
    if (action.type === 'back') {
      if (this.view && wc.canGoBack()) wc.goBack();
    } else if (action.type === 'reload') {
      if (this.view) wc.reload();
    } else if (['Tab', 'Enter', 'Escape', 'Space', 'Up', 'Down', 'Left', 'Right'].includes(action.key)) {
      this.focus(wc);
      return this.dispatch(wc, [{ type: 'keyDown', keyCode: action.key }, { type: 'keyUp', keyCode: action.key }]);
    }
  }
}

module.exports = { WebPlayer };
