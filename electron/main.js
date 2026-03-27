const { app, BrowserWindow, ipcMain } = require('electron');
const https = require('https');
const http  = require('http');
const path  = require('path');
const { URL } = require('url');

// ── PUT YOUR BOT TOKEN HERE BEFORE BUILDING ──────────────────────────
const TG_TOKEN = 'YOUR_BOT_TOKEN_HERE';
// ── PUT YOUR SERVER URL AND SECRET HERE BEFORE BUILDING ──────────────
const SERVER_URL = 'https://your-app.railway.app'; // e.g. https://zynth.up.railway.app
const API_SECRET = 'zynth-dev-secret';             // must match server's API_SECRET env var
// ─────────────────────────────────────────────────────────────────────

let win;

function createWindow() {
  win = new BrowserWindow({
    width:  1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'ZYNTH',
    backgroundColor: '#02060f',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Telegram API ─────────────────────────────────────────────────────
function telegramRequest(token, method, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api.telegram.org',
      path:     `/bot${token}/${method}`,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ ok: false, description: 'Parse error' }); }
      });
    });
    req.on('error', err => reject(err));
    req.write(payload);
    req.end();
  });
}

// Send plain text — token comes from main.js, not from renderer
ipcMain.handle('tg-send', async (_e, { chatId, text }) => {
  if (!TG_TOKEN || TG_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    return { ok: false, description: 'Bot token not configured' };
  }
  try {
    return await telegramRequest(TG_TOKEN, 'sendMessage', {
      chat_id:    chatId,
      text:       text,
      parse_mode: 'HTML',
    });
  } catch (e) {
    return { ok: false, description: String(e) };
  }
});

// Get bot info — used to verify connection and show bot username
ipcMain.handle('tg-getme', async (_e) => {
  if (!TG_TOKEN || TG_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    return { ok: false, description: 'Bot token not configured in app' };
  }
  try {
    return await telegramRequest(TG_TOKEN, 'getMe', {});
  } catch (e) {
    return { ok: false, description: String(e) };
  }
});

// ── Server sync helpers ───────────────────────────────────────────────
function serverRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const base    = SERVER_URL.replace(/\/$/, '');
    const fullUrl = new URL(base + urlPath);
    const isHttps = fullUrl.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: fullUrl.hostname,
      port:     fullUrl.port || (isHttps ? 443 : 80),
      path:     fullUrl.pathname + fullUrl.search,
      method,
      headers: {
        'x-zynth-key': API_SECRET,
        ...(payload ? {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
        } : {}),
      },
    };
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ ok: false, error: 'Parse error' }); }
      });
    });
    req.on('error', err => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

// Sync local data to server
ipcMain.handle('sync-data', async (_e, { chatId, trades, expenses, settings }) => {
  if (!SERVER_URL || SERVER_URL === 'https://your-app.railway.app') {
    return { ok: false, error: 'Server URL not configured' };
  }
  try {
    return await serverRequest('POST', '/sync', { chatId, trades, expenses, settings });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// Restore data from server
ipcMain.handle('restore-data', async (_e, { chatId }) => {
  if (!SERVER_URL || SERVER_URL === 'https://your-app.railway.app') {
    return { ok: false, error: 'Server URL not configured' };
  }
  try {
    return await serverRequest('GET', `/data/${encodeURIComponent(chatId)}`, null);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});
