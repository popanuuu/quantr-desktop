// main.js — Electron main process
const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');

const APP_URL = 'https://usequantr.io';

// Domains allowed to navigate WITHIN the app window — everything else
// (footer links, external docs, etc.) opens in the user's normal browser
// instead of hijacking the app window. Stripe Checkout and Turnstile need
// to stay in-window since they're part of the actual sign-up/payment flow.
const ALLOWED_HOSTS = [
  'usequantr.io',
  'www.usequantr.io',
  'checkout.stripe.com',
  'billing.stripe.com',
  'js.stripe.com',
  'challenges.cloudflare.com',
];

function isAllowedHost(urlString) {
  try {
    const { hostname } = new URL(urlString);
    return ALLOWED_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'QUANTR',
    backgroundColor: '#0b0f1a', // matches the app's navy theme — no white flash on load
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The loaded page is the real, live website — it never needs (and
      // must never get) access to Node.js or the filesystem, even though
      // this is "our own" site. Treat it like any remote page, security-wise.
    },
  });

  // Remove the default File/Edit/View/Window/Help menu bar — this isn't a
  // general-purpose browser, it's a dedicated app window.
  Menu.setApplicationMenu(null);

  mainWindow.loadURL(APP_URL);

  // Keep in-app navigation (login, pricing, checkout, the viewer, Stripe,
  // Turnstile) inside the window; send anything else to the OS browser.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedHost(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedHost(url)) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // If the site can't be reached (offline, DNS issue, server down), show a
  // minimal retry screen instead of Electron's default blank error page.
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    if (errorCode === -3) return; // ERR_ABORTED — usually just a redirect, ignore
    mainWindow.loadURL(
      'data:text/html,' + encodeURIComponent(`
        <html>
        <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
          background:#0b0f1a;color:#f1f5f9;font-family:system-ui,sans-serif;flex-direction:column;gap:16px">
          <div style="font-size:18px;font-weight:700">Can't reach QUANTR</div>
          <div style="font-size:13px;color:#94a3b8">${errorDescription || 'Check your internet connection.'}</div>
          <button onclick="location.reload()" style="padding:10px 20px;background:#2456d6;color:#fff;
            border:none;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer">Retry</button>
        </body>
        </html>
      `)
    );
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
