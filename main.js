// main.js — Electron main process
const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
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

// The app was renamed QUANTR → USEQUANTR. Keep the old data folder so people
// stay signed in and keep their settings after the update.
app.setPath('userData', path.join(app.getPath('appData'), 'QUANTR'));
app.setAppUserModelId('io.usequantr.desktop');

let mainWindow = null;
let closeRequested = false; // the user pressed X / Alt+F4 (vs. navigating inside the app)
let forceClose = false;     // skip the unsaved-changes check (already handled)
let saving = false;

// Run a snippet in the page and in every iframe (the viewer may sit in one)
async function inAllFrames(code) {
  const out = [];
  if (!mainWindow) return out;
  for (const f of mainWindow.webContents.mainFrame.framesInSubtree) {
    try { out.push(await f.executeJavaScript(code, true)); } catch { /* frame gone / cross-origin */ }
  }
  return out;
}

// "Save" chosen: export every unsaved drawing as PDF, wait for the downloads,
// then close (if the user was closing) — or stay open if anything was cancelled.
async function saveThenClose(thenClose) {
  if (saving || !mainWindow) return;
  saving = true;
  const ses = mainWindow.webContents.session;
  const downloads = [];
  const onDownload = (_e, item) => {
    downloads.push(new Promise(res => item.once('done', (_ev, state) => res(state))));
  };
  ses.on('will-download', onDownload);
  try {
    const results = await inAllFrames('window.quantrSaveAll ? window.quantrSaveAll() : null');
    const r = results.find(x => x && typeof x === 'object') || { saved: 0, failed: 0 };
    // wait (max 8 s) for every export to hand its file to the download manager
    const t0 = Date.now();
    while (downloads.length < r.saved && Date.now() - t0 < 8000) await new Promise(res => setTimeout(res, 100));
    const states = await Promise.all(downloads); // includes the user's "Save as" dialogs
    const ok = r.failed === 0 && downloads.length >= r.saved && states.every(s => s === 'completed');
    if (!ok) {
      await inAllFrames('window.quantrMarkUnsaved && window.quantrMarkUnsaved()');
      dialog.showMessageBoxSync(mainWindow, {
        type: 'warning', buttons: ['OK'], title: 'USEQUANTR',
        message: 'Not everything was saved',
        detail: 'A save was cancelled or failed, so USEQUANTR stays open. Your markups are still there.',
      });
      return;
    }
    if (thenClose) { forceClose = true; mainWindow.close(); }
  } finally {
    ses.removeListener('will-download', onDownload);
    saving = false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'USEQUANTR',
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

  mainWindow.on('close', () => { closeRequested = true; setTimeout(() => { closeRequested = false; }, 1500); });

  // The page blocks unload when there are unsaved markups. Electron shows no
  // prompt for that on its own — the window just ignored X and looked frozen.
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    if (forceClose) { event.preventDefault(); return; }
    if (saving) return; // already saving — keep the window
    const closing = closeRequested;
    closeRequested = false;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Save', "Don't save", 'Cancel'],
      defaultId: 0, cancelId: 2, noLink: true,
      title: 'USEQUANTR',
      message: closing ? 'Save your changes before closing?' : 'Save your changes before leaving this page?',
      detail: 'You have markups or measurements that haven\'t been saved. Save exports each drawing as a PDF.',
    });
    if (choice === 1) { event.preventDefault(); return; }   // Don't save → close / leave
    if (choice === 0) saveThenClose(closing);              // Save → export, then close
    // Cancel → stay
  });

  // If the page really hangs (huge model/drawing), offer a way out instead of a dead window
  mainWindow.on('unresponsive', () => {
    const c = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning', buttons: ['Wait', 'Reload', 'Close USEQUANTR'], defaultId: 0, cancelId: 0, noLink: true,
      title: 'USEQUANTR', message: 'USEQUANTR is not responding',
      detail: 'A large drawing or model may still be loading. You can wait, reload the app, or close it. Reload and Close lose unsaved markups.',
    });
    if (c === 1) { mainWindow.webContents.forcefullyCrashRenderer(); mainWindow.webContents.reload(); }
    else if (c === 2) { forceClose = true; mainWindow.destroy(); }
  });

  // The page crashed (out of memory etc.) → reload instead of a blank window
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || !mainWindow || mainWindow.isDestroyed()) return;
    const c = dialog.showMessageBoxSync(mainWindow, {
      type: 'error', buttons: ['Reload', 'Close USEQUANTR'], defaultId: 0, cancelId: 0, noLink: true,
      title: 'USEQUANTR', message: 'USEQUANTR stopped unexpectedly', detail: 'Reason: ' + details.reason,
    });
    if (c === 0) mainWindow.webContents.reload(); else { forceClose = true; mainWindow.destroy(); }
  });

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
          <div style="font-size:18px;font-weight:700">Can't reach USEQUANTR</div>
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
