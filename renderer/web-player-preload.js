// Isolated preload: no API is exposed to the remote website.
const { ipcRenderer } = require('electron');
let cursor;
let hideTimer;
ipcRenderer.on('remote:cursor', (_event, position) => {
  if (!document.documentElement) return;
  if (!cursor) {
    cursor = document.createElement('div');
    cursor.setAttribute('aria-hidden', 'true');
    cursor.style.cssText = 'position:fixed;width:22px;height:22px;border:2px solid #fff;border-radius:50%;background:#79dfc166;box-shadow:0 0 0 2px #10151b,0 2px 12px #0009;pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);';
  }
  // Keep the indicator above normal embedded players. It never intercepts input.
  const root = document.fullscreenElement && !['IFRAME','VIDEO'].includes(document.fullscreenElement.tagName)
    ? document.fullscreenElement : document.documentElement;
  if (cursor.parentNode !== root) root.appendChild(cursor);
  cursor.style.left = `${position.x}px`;
  cursor.style.top = `${position.y}px`;
  cursor.style.display = 'block';
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { cursor.style.display = 'none'; }, 3500);
});
