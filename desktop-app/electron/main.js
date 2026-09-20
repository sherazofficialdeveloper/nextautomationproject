'use strict';

// NETX desktop — Electron main process.
// Owns window lifecycle. Security posture:
// - contextIsolation: enabled
// - nodeIntegration: disabled
// - sandbox: enabled
// - renderer talks to this process only through the preload bridge (IPC)
// - no backend/database secrets are ever loaded here or in the renderer

const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const crypto = require('node:crypto');

const isDev = !app.isPackaged;

// Cross-platform CLI options (work from npm scripts on Windows/macOS/Linux):
//   --dev-server=http://localhost:5173  -> load the Vite dev server (HMR)
//   --smoke                             -> automated startup verification, then quit
const cliArgs = process.argv.slice(app.isPackaged ? 1 : 2);
const SMOKE_MODE = cliArgs.includes('--smoke');
const devServerArg = cliArgs.find((arg) => arg.startsWith('--dev-server='));
const DEV_SERVER_URL = devServerArg ? devServerArg.slice('--dev-server='.length) : null;

let mainWindow = null;
let accountWindow = null;
let currentAccountSession = null;
let ticketWindow = null;
let currentTicketSession = null;
let searchTrainWindow = null;
let currentSearchParams = null;
let openTicketsWindow = null;
let currentOpenTicketsSession = null;
let ticketWebSelectWindow = null;
let currentSelectedTicketData = null;
let bankWindow = null;
let currentBankSession = null;
let bookingHistoryWindow = null;
let currentBookingHistorySession = null;
let proxySettingWindow = null;
let currentProxySettingSession = null;
let backupRestoreWindow = null;
let currentBackupRestoreSession = null;
let browserCheckWindow = null;
let currentBrowserCheckSession = null;
let cookieDeleteWindow = null;
let currentCookieDeleteSession = null;
let versionCheckWindow = null;
let currentVersionCheckSession = null;


function createWindow() {
  const win = new BrowserWindow({
    width: 460,
    height: 540,
    minWidth: 460,
    minHeight: 540,
    maxWidth: 460,
    maxHeight: 540,
    center: true,
    title: 'NETX',
    backgroundColor: '#eaf7f1',
    show: false, // shown on ready-to-show to avoid a blank flash
    autoHideMenuBar: true,
    frame: false,
    minimizable: false,
    maximizable: false,
    resizable: false,
    fullscreenable: false,
    closable: true,
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // No application menu for a production desktop product.
  Menu.setApplicationMenu(null);

  // Renderer hardening: no popups, no arbitrary navigation.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const isFileTarget = url.startsWith('file://');
    const isDevServerTarget = Boolean(DEV_SERVER_URL) && url.startsWith(DEV_SERVER_URL);
    const loadsFromDevServer = Boolean(DEV_SERVER_URL);
    const allowed = loadsFromDevServer ? isDevServerTarget : isFileTarget;
    if (!allowed) event.preventDefault();
  });

  // Devtools only in development (F12).
  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }

  win.once('ready-to-show', () => {
    win.show();
    if (SMOKE_MODE) console.log('[smoke] window ready-to-show');
  });

  if (DEV_SERVER_URL) {
    win.loadURL(DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  return win;
}

function createAccountWindow(session) {
  if (accountWindow && !accountWindow.isDestroyed()) {
    accountWindow.focus();
    return accountWindow;
  }

  currentAccountSession = session || null;

  const win = new BrowserWindow({
    width: 520,
    height: 640,
    minWidth: 520,
    minHeight: 640,
    maxWidth: 520,
    maxHeight: 640,
    center: true,
    title: 'NETX — Account Management',
    backgroundColor: '#ffffff',
    show: false,
    autoHideMenuBar: true,
    frame: false,
    minimizable: false,
    maximizable: false,
    resizable: false,
    fullscreenable: false,
    closable: true,
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const isFileTarget = url.startsWith('file://');
    const isDevServerTarget = Boolean(DEV_SERVER_URL) && url.startsWith(DEV_SERVER_URL);
    const allowed = DEV_SERVER_URL ? isDevServerTarget : isFileTarget;
    if (!allowed) event.preventDefault();
  });

  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }

  win.once('ready-to-show', () => {
    win.show();
    if (SMOKE_MODE) console.log('[smoke] account window ready-to-show');
  });

  win.on('closed', () => {
    accountWindow = null;
  });

  if (DEV_SERVER_URL) {
    win.loadURL(`${DEV_SERVER_URL}#accounts`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: 'accounts' });
  }

  accountWindow = win;
  return accountWindow;
}

function createBankWindow(session) {
  if (bankWindow && !bankWindow.isDestroyed()) {
    bankWindow.focus();
    return bankWindow;
  }

  currentBankSession = session || null;

  const win = new BrowserWindow({
    width: 755,
    height: 425,
    useContentSize: true,
    minWidth: 740,
    minHeight: 410,
    center: true,
    title: 'Bank',
    backgroundColor: '#ffffff',
    show: false,
    autoHideMenuBar: true,
    frame: false,
    minimizable: false,
    maximizable: false,
    resizable: true,
    fullscreenable: false,
    closable: true,
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const isFileTarget = url.startsWith('file://');
    const isDevServerTarget = Boolean(DEV_SERVER_URL) && url.startsWith(DEV_SERVER_URL);
    const allowed = DEV_SERVER_URL ? isDevServerTarget : isFileTarget;
    if (!allowed) event.preventDefault();
  });

  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }

  win.once('ready-to-show', () => {
    win.show();
    if (SMOKE_MODE) console.log('[smoke] bank window ready-to-show');
  });

  win.on('closed', () => {
    bankWindow = null;
  });

  if (DEV_SERVER_URL) {
    win.loadURL(`${DEV_SERVER_URL}#bank`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: 'bank' });
  }

  bankWindow = win;
  return bankWindow;
}

function createTicketWindow(session) {
  if (ticketWindow && !ticketWindow.isDestroyed()) {
    currentTicketSession = session || null;
    ticketWindow.focus();
    ticketWindow.webContents.send('app:ticket-session-updated', session);
    return ticketWindow;
  }

  currentTicketSession = session || null;

  const win = new BrowserWindow({
    width: 750,
    height: 495,
    useContentSize: true,
    minWidth: 740,
    minHeight: 480,
    center: true,
    title: 'New Ticket',
    backgroundColor: '#ffffff',
    show: false,
    autoHideMenuBar: true,
    frame: false,
    minimizable: false,
    maximizable: false,
    resizable: true,
    fullscreenable: false,
    closable: true,
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const isFileTarget = url.startsWith('file://');
    const isDevServerTarget = Boolean(DEV_SERVER_URL) && url.startsWith(DEV_SERVER_URL);
    const allowed = DEV_SERVER_URL ? isDevServerTarget : isFileTarget;
    if (!allowed) event.preventDefault();
  });

  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }

  win.once('ready-to-show', () => {
    win.show();
    if (SMOKE_MODE) console.log('[smoke] ticket window ready-to-show');
  });

  win.on('closed', () => {
    ticketWindow = null;
    if (searchTrainWindow && !searchTrainWindow.isDestroyed()) {
      searchTrainWindow.close();
    }
  });

  if (DEV_SERVER_URL) {
    win.loadURL(`${DEV_SERVER_URL}#ticket`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: 'ticket' });
  }

  ticketWindow = win;
  return ticketWindow;
}

function createSearchTrainWindow(params) {
  if (searchTrainWindow && !searchTrainWindow.isDestroyed()) {
    currentSearchParams = params || null;
    searchTrainWindow.focus();
    searchTrainWindow.webContents.send('app:search-params-updated', params);
    return searchTrainWindow;
  }

  currentSearchParams = params || null;

  const win = new BrowserWindow({
    width: 580,
    height: 485,
    useContentSize: true,
    minWidth: 560,
    minHeight: 460,
    center: true,
    title: 'Search Train & Availability',
    backgroundColor: '#ffffff',
    show: false,
    autoHideMenuBar: true,
    frame: false,
    minimizable: false,
    maximizable: false,
    resizable: true,
    fullscreenable: false,
    closable: true,
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const isFileTarget = url.startsWith('file://');
    const isDevServerTarget = Boolean(DEV_SERVER_URL) && url.startsWith(DEV_SERVER_URL);
    const allowed = DEV_SERVER_URL ? isDevServerTarget : isFileTarget;
    if (!allowed) event.preventDefault();
  });

  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }

  win.once('ready-to-show', () => {
    win.show();
    if (SMOKE_MODE) console.log('[smoke] search train window ready-to-show');
  });

  win.on('closed', () => {
    searchTrainWindow = null;
  });

  if (DEV_SERVER_URL) {
    win.loadURL(`${DEV_SERVER_URL}#search-train`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: 'search-train' });
  }

  searchTrainWindow = win;
  return searchTrainWindow;
}

function createOpenTicketsWindow(session) {
  if (openTicketsWindow && !openTicketsWindow.isDestroyed()) {
    openTicketsWindow.focus();
    return openTicketsWindow;
  }

  currentOpenTicketsSession = session || null;

  const win = new BrowserWindow({
    width: 780,
    height: 440,
    useContentSize: true,
    minWidth: 700,
    minHeight: 380,
    center: true,
    title: 'Total Ticket',
    backgroundColor: '#ffffff',
    show: false,
    autoHideMenuBar: true,
    frame: false,
    minimizable: false,
    maximizable: false,
    resizable: true,
    fullscreenable: false,
    closable: true,
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const isFileTarget = url.startsWith('file://');
    const isDevServerTarget = Boolean(DEV_SERVER_URL) && url.startsWith(DEV_SERVER_URL);
    const allowed = DEV_SERVER_URL ? isDevServerTarget : isFileTarget;
    if (!allowed) event.preventDefault();
  });

  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }

  win.once('ready-to-show', () => {
    win.show();
    if (SMOKE_MODE) console.log('[smoke] open tickets window ready-to-show');
  });

  win.on('closed', () => {
    openTicketsWindow = null;
  });

  if (DEV_SERVER_URL) {
    win.loadURL(`${DEV_SERVER_URL}#open-tickets`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: 'open-tickets' });
  }

  openTicketsWindow = win;
  return openTicketsWindow;
}

function createTicketWebSelectWindow(ticketData) {
  currentSelectedTicketData = ticketData || null;

  if (ticketData?.session) {
    currentTicketSession = ticketData.session;
  } else if (ticketData?.token) {
    currentTicketSession = { token: ticketData.token };
  } else if (!currentTicketSession && currentOpenTicketsSession) {
    currentTicketSession = currentOpenTicketsSession;
  }

  if (ticketWebSelectWindow && !ticketWebSelectWindow.isDestroyed()) {
    ticketWebSelectWindow.focus();
    ticketWebSelectWindow.webContents.send('app:selected-ticket-updated', currentSelectedTicketData);
    return ticketWebSelectWindow;
  }

  const win = new BrowserWindow({
    width: 440,
    height: 420,
    useContentSize: true,
    minWidth: 400,
    minHeight: 380,
    center: true,
    title: ticketData?.ticketName || 'Ticket Web Selector',
    backgroundColor: '#ffffff',
    show: false,
    autoHideMenuBar: true,
    frame: false,
    alwaysOnTop: true,
    minimizable: false,
    maximizable: false,
    resizable: false,
    fullscreenable: false,
    closable: true,
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const isFileTarget = url.startsWith('file://');
    const isDevServerTarget = Boolean(DEV_SERVER_URL) && url.startsWith(DEV_SERVER_URL);
    const allowed = DEV_SERVER_URL ? isDevServerTarget : isFileTarget;
    if (!allowed) event.preventDefault();
  });

  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }

  win.once('ready-to-show', () => {
    win.show();
    if (SMOKE_MODE) console.log('[smoke] ticket web select window ready-to-show');
  });

  win.on('closed', () => {
    ticketWebSelectWindow = null;
  });

  if (DEV_SERVER_URL) {
    win.loadURL(`${DEV_SERVER_URL}#ticket-web-select`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: 'ticket-web-select' });
  }

  ticketWebSelectWindow = win;
  return ticketWebSelectWindow;
}

function createBookingHistoryWindow(session) {
  if (bookingHistoryWindow && !bookingHistoryWindow.isDestroyed()) {
    bookingHistoryWindow.focus();
    return bookingHistoryWindow;
  }

  currentBookingHistorySession = session || null;

  const win = new BrowserWindow({
    width: 880,
    height: 460,
    minWidth: 880,
    minHeight: 460,
    center: true,
    title: 'HiSTORY',
    backgroundColor: '#0b1a2d',
    show: false,
    autoHideMenuBar: true,
    frame: false,
    minimizable: false,
    maximizable: false,
    resizable: true,
    fullscreenable: false,
    closable: true,
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const isFileTarget = url.startsWith('file://');
    const isDevServerTarget = Boolean(DEV_SERVER_URL) && url.startsWith(DEV_SERVER_URL);
    const allowed = DEV_SERVER_URL ? isDevServerTarget : isFileTarget;
    if (!allowed) event.preventDefault();
  });

  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }

  win.once('ready-to-show', () => {
    win.show();
    if (SMOKE_MODE) console.log('[smoke] booking history window ready-to-show');
  });

  win.on('closed', () => {
    bookingHistoryWindow = null;
  });

  if (DEV_SERVER_URL) {
    win.loadURL(`${DEV_SERVER_URL}#booking-history`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: 'booking-history' });
  }

  bookingHistoryWindow = win;
  return bookingHistoryWindow;
}

function createProxySettingWindow(session) {
  if (proxySettingWindow && !proxySettingWindow.isDestroyed()) {
    proxySettingWindow.focus();
    return proxySettingWindow;
  }

  currentProxySettingSession = session || null;

  const win = new BrowserWindow({
    width: 450,
    height: 410,
    minWidth: 450,
    minHeight: 410,
    maxWidth: 450,
    maxHeight: 410,
    center: true,
    title: 'Proxy IP Setting',
    backgroundColor: '#ffffff',
    show: false,
    autoHideMenuBar: true,
    frame: false,
    minimizable: false,
    maximizable: false,
    resizable: false,
    fullscreenable: false,
    closable: true,
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const isFileTarget = url.startsWith('file://');
    const isDevServerTarget = Boolean(DEV_SERVER_URL) && url.startsWith(DEV_SERVER_URL);
    const allowed = DEV_SERVER_URL ? isDevServerTarget : isFileTarget;
    if (!allowed) event.preventDefault();
  });

  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }

  win.once('ready-to-show', () => {
    win.show();
    if (SMOKE_MODE) console.log('[smoke] proxy setting window ready-to-show');
  });

  win.on('closed', () => {
    proxySettingWindow = null;
  });

  if (DEV_SERVER_URL) {
    win.loadURL(`${DEV_SERVER_URL}#proxy-setting`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: 'proxy-setting' });
  }

  proxySettingWindow = win;
  return proxySettingWindow;
}

function createBackupRestoreWindow(session) {
  if (backupRestoreWindow && !backupRestoreWindow.isDestroyed()) {
    backupRestoreWindow.focus();
    return backupRestoreWindow;
  }

  currentBackupRestoreSession = session || null;

  const win = new BrowserWindow({
    width: 550,
    height: 290,
    minWidth: 550,
    minHeight: 290,
    maxWidth: 550,
    maxHeight: 290,
    center: true,
    title: 'BACKUP & RESTORE',
    backgroundColor: '#00bcd4',
    show: false,
    autoHideMenuBar: true,
    frame: false,
    minimizable: false,
    maximizable: false,
    resizable: false,
    fullscreenable: false,
    closable: true,
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const isFileTarget = url.startsWith('file://');
    const isDevServerTarget = Boolean(DEV_SERVER_URL) && url.startsWith(DEV_SERVER_URL);
    const allowed = DEV_SERVER_URL ? isDevServerTarget : isFileTarget;
    if (!allowed) event.preventDefault();
  });

  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }

  win.once('ready-to-show', () => {
    win.show();
    if (SMOKE_MODE) console.log('[smoke] backup restore window ready-to-show');
  });

  win.on('closed', () => {
    backupRestoreWindow = null;
  });

  if (DEV_SERVER_URL) {
    win.loadURL(`${DEV_SERVER_URL}#backup-restore`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: 'backup-restore' });
  }

  backupRestoreWindow = win;
  return backupRestoreWindow;
}

function createBrowserCheckWindow(session) {
  if (browserCheckWindow && !browserCheckWindow.isDestroyed()) {
    browserCheckWindow.focus();
    return browserCheckWindow;
  }

  currentBrowserCheckSession = session || null;

  const win = new BrowserWindow({
    width: 540,
    height: 420,
    minWidth: 540,
    minHeight: 420,
    maxWidth: 540,
    maxHeight: 420,
    center: true,
    title: 'Web Login Settings',
    backgroundColor: '#ffffff',
    show: false,
    autoHideMenuBar: true,
    frame: false,
    minimizable: false,
    maximizable: false,
    resizable: false,
    fullscreenable: false,
    closable: true,
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const isFileTarget = url.startsWith('file://');
    const isDevServerTarget = Boolean(DEV_SERVER_URL) && url.startsWith(DEV_SERVER_URL);
    const allowed = DEV_SERVER_URL ? isDevServerTarget : isFileTarget;
    if (!allowed) event.preventDefault();
  });

  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }

  win.once('ready-to-show', () => {
    win.show();
    if (SMOKE_MODE) console.log('[smoke] browser check window ready-to-show');
  });

  win.on('closed', () => {
    browserCheckWindow = null;
  });

  if (DEV_SERVER_URL) {
    win.loadURL(`${DEV_SERVER_URL}#browser-check`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: 'browser-check' });
  }

  browserCheckWindow = win;
  return browserCheckWindow;
}

function createCookieDeleteWindow(session) {
  if (cookieDeleteWindow && !cookieDeleteWindow.isDestroyed()) {
    cookieDeleteWindow.focus();
    return cookieDeleteWindow;
  }

  currentCookieDeleteSession = session || null;

  const win = new BrowserWindow({
    width: 460,
    height: 270,
    minWidth: 460,
    minHeight: 270,
    maxWidth: 460,
    maxHeight: 270,
    center: true,
    title: 'Cookie Delete',
    backgroundColor: '#ffffff',
    show: false,
    autoHideMenuBar: true,
    frame: false,
    minimizable: false,
    maximizable: false,
    resizable: false,
    fullscreenable: false,
    closable: true,
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const isFileTarget = url.startsWith('file://');
    const isDevServerTarget = Boolean(DEV_SERVER_URL) && url.startsWith(DEV_SERVER_URL);
    const allowed = DEV_SERVER_URL ? isDevServerTarget : isFileTarget;
    if (!allowed) event.preventDefault();
  });

  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }

  win.once('ready-to-show', () => {
    win.show();
    if (SMOKE_MODE) console.log('[smoke] cookie delete window ready-to-show');
  });

  win.on('closed', () => {
    cookieDeleteWindow = null;
  });

  if (DEV_SERVER_URL) {
    win.loadURL(`${DEV_SERVER_URL}#cookie-delete`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: 'cookie-delete' });
  }

  cookieDeleteWindow = win;
  return cookieDeleteWindow;
}

function createVersionCheckWindow(session) {
  if (versionCheckWindow && !versionCheckWindow.isDestroyed()) {
    currentVersionCheckSession = session || currentVersionCheckSession;
    if (currentVersionCheckSession) {
      versionCheckWindow.webContents.send('app:version-check-session-updated', currentVersionCheckSession);
    }
    versionCheckWindow.focus();
    return versionCheckWindow;
  }

  currentVersionCheckSession = session || null;

  const win = new BrowserWindow({
    width: 320,
    height: 250,
    minWidth: 300,
    minHeight: 220,
    maxWidth: 360,
    maxHeight: 280,
    center: true,
    title: 'Software Version Check',
    backgroundColor: '#f2f2f2',
    show: false,
    autoHideMenuBar: true,
    frame: false,
    minimizable: false,
    maximizable: false,
    resizable: false,
    fullscreenable: false,
    closable: true,
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const isFileTarget = url.startsWith('file://');
    const isDevServerTarget = Boolean(DEV_SERVER_URL) && url.startsWith(DEV_SERVER_URL);
    const allowed = DEV_SERVER_URL ? isDevServerTarget : isFileTarget;
    if (!allowed) event.preventDefault();
  });

  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }

  win.once('ready-to-show', () => {
    win.show();
    if (SMOKE_MODE) console.log('[smoke] version check window ready-to-show');
  });

  win.on('closed', () => {
    versionCheckWindow = null;
  });

  if (DEV_SERVER_URL) {
    win.loadURL(`${DEV_SERVER_URL}#version-check`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: 'version-check' });
  }

  versionCheckWindow = win;
  return versionCheckWindow;
}

// Context-isolated IPC surface. Only explicit, narrow handlers belong here.
ipcMain.handle('app:get-version', () => app.getVersion());

ipcMain.handle('app:close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  } else {
    app.quit();
  }
});

ipcMain.handle('app:set-window-size', (event, { width, height }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setResizable(true);
    mainWindow.setMinimumSize(width, height);
    mainWindow.setMaximumSize(width, height);
    mainWindow.setSize(width, height);
    mainWindow.center();
    mainWindow.setResizable(false);
  }
});

ipcMain.handle('app:open-account-window', (event, session) => {
  createAccountWindow(session);
  return { ok: true };
});

ipcMain.handle('app:get-account-session', () => {
  return currentAccountSession;
});

ipcMain.handle('app:open-bank-window', (event, session) => {
  createBankWindow(session);
  return { ok: true };
});

ipcMain.handle('app:get-bank-session', () => {
  return currentBankSession;
});

ipcMain.handle('app:notify-banks-changed', () => {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) {
      w.webContents.send('app:on-banks-changed');
    }
  });
  return { ok: true };
});

ipcMain.handle('app:open-ticket-window', (event, session) => {
  createTicketWindow(session);
  return { ok: true };
});

ipcMain.handle('app:get-ticket-session', () => {
  return currentTicketSession;
});

ipcMain.handle('app:open-open-tickets-window', (event, session) => {
  createOpenTicketsWindow(session);
  return { ok: true };
});

ipcMain.handle('app:get-open-tickets-session', () => {
  return currentOpenTicketsSession;
});

ipcMain.handle('app:open-ticket-web-select-window', (event, ticketData) => {
  createTicketWebSelectWindow(ticketData);
  return { ok: true };
});

ipcMain.handle('app:get-selected-ticket', () => {
  return currentSelectedTicketData;
});

ipcMain.handle('app:open-search-train-window', (event, params) => {
  createSearchTrainWindow(params);
  return { ok: true };
});

ipcMain.handle('app:get-search-params', () => {
  return currentSearchParams;
});

ipcMain.handle('app:select-train', (event, train) => {
  if (ticketWindow && !ticketWindow.isDestroyed()) {
    ticketWindow.webContents.send('app:on-train-selected', train);
  }
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win.close();
  }
  return { ok: true };
});

ipcMain.handle('app:open-booking-history-window', (event, session) => {
  createBookingHistoryWindow(session);
  return { ok: true };
});

ipcMain.handle('app:get-booking-history-session', () => {
  return currentBookingHistorySession;
});

ipcMain.handle('app:open-proxy-setting-window', (event, session) => {
  createProxySettingWindow(session);
  return { ok: true };
});

ipcMain.handle('app:get-proxy-setting-session', () => {
  return currentProxySettingSession;
});

// Backup & Restore Window & IPC
ipcMain.handle('app:open-backup-restore-window', (event, session) => {
  createBackupRestoreWindow(session);
  return { ok: true };
});

ipcMain.handle('app:get-backup-restore-session', () => {
  return currentBackupRestoreSession;
});

ipcMain.handle('app:browse-backup-file', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select NETX Backup File',
    filters: [
      { name: 'NETX Backup (*.netxbak, *.bak, *.json)', extensions: ['netxbak', 'bak', 'json'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const filePath = result.filePaths[0];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return { canceled: false, filePath, package: parsed };
  } catch (err) {
    return { canceled: false, filePath, error: 'Could not parse backup file. Must be valid JSON.' };
  }
});

ipcMain.handle('app:browse-save-backup-path', async (event, defaultName) => {
  const result = await dialog.showSaveDialog({
    title: 'Save NETX Backup File',
    defaultPath: defaultName || `NETX_BACKUP_${new Date().toISOString().slice(0, 10)}.netxbak`,
    filters: [
      { name: 'NETX Backup (*.netxbak)', extensions: ['netxbak'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle('app:save-backup-file', async (event, { filePath, content }) => {
  try {
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    fs.writeFileSync(filePath, text, 'utf8');
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Browser Check Window & IPC
const BROWSER_EXECUTABLE_CANDIDATES = {
  chrome: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
  ],
  edge: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
  ],
  brave: [
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') : null,
  ],
  opera: [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Opera', 'launcher.exe') : null,
    'C:\\Program Files\\Opera\\launcher.exe',
    'C:\\Program Files (x86)\\Opera\\launcher.exe',
  ],
  comet: [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Comet', 'Application', 'comet.exe') : null,
    'C:\\Program Files\\Comet\\comet.exe',
    'C:\\Program Files (x86)\\Comet\\comet.exe',
  ],
};

function checkIrctcConnectivity() {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const req = https.request(
      {
        hostname: 'www.irctc.co.in',
        port: 443,
        path: '/nget/train-search',
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeout: 5000,
      },
      (res) => {
        const latencyMs = Date.now() - startTime;
        const code = res.statusCode || 200;
        let bodyChunks = '';
        res.on('data', (chunk) => {
          if (bodyChunks.length < 2048) {
            bodyChunks += chunk.toString();
          }
        });
        res.on('end', () => {
          const lowerBody = bodyChunks.toLowerCase();
          const headersStr = JSON.stringify(res.headers).toLowerCase();
          const isChallenge =
            lowerBody.includes('cf-chl') ||
            lowerBody.includes('akamai') ||
            lowerBody.includes('captcha') ||
            headersStr.includes('cf-chl') ||
            headersStr.includes('akamai');

          if (code === 403 || code === 429) {
            resolve({
              blocked: true,
              challenge: isChallenge,
              statusCode: code,
              latencyMs,
              message: `IP Blocked (HTTP ${code})`,
            });
          } else if (isChallenge) {
            resolve({
              blocked: true,
              challenge: true,
              statusCode: code,
              latencyMs,
              message: 'Access blocked / challenge detected (Manual verification required)',
            });
          } else {
            resolve({
              blocked: false,
              challenge: false,
              statusCode: code,
              latencyMs,
              message: `IP Allowed (${latencyMs}ms)`,
            });
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({
        blocked: false,
        timeout: true,
        statusCode: null,
        latencyMs: 5000,
        message: 'Connection Timeout',
      });
    });

    req.on('error', (err) => {
      resolve({
        blocked: false,
        error: true,
        statusCode: null,
        latencyMs: Date.now() - startTime,
        message: `Network Failure (${err.code || 'Error'})`,
      });
    });

    req.end();
  });
}

ipcMain.handle('app:open-browser-check-window', (event, session) => {
  createBrowserCheckWindow(session);
  return { ok: true };
});

ipcMain.handle('app:get-browser-check-session', () => {
  return currentBrowserCheckSession;
});

ipcMain.handle('app:open-cookie-delete-window', (event, session) => {
  createCookieDeleteWindow(session);
  return { ok: true };
});

ipcMain.handle('app:get-cookie-delete-session', () => {
  return currentCookieDeleteSession;
});

ipcMain.handle('app:open-version-check-window', (event, session) => {
  createVersionCheckWindow(session);
  return { ok: true };
});

ipcMain.handle('app:get-version-check-session', () => {
  return currentVersionCheckSession;
});

ipcMain.handle('app:check-browser-ip-block', async (event, browserKey) => {
  const normalizedKey = String(browserKey || '').toLowerCase().trim();
  const candidates = BROWSER_EXECUTABLE_CANDIDATES[normalizedKey] || [];
  let installedPath = null;
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      installedPath = p;
      break;
    }
  }

  const conn = await checkIrctcConnectivity();

  return {
    ok: true,
    browserKey: normalizedKey,
    installed: Boolean(installedPath),
    installedPath,
    blocked: conn.blocked,
    challenge: Boolean(conn.challenge),
    latencyMs: conn.latencyMs,
    message: conn.message,
  };
});

ipcMain.handle('app:launch-browser-executable', async (event, browserKey) => {
  const normalizedKey = String(browserKey || '').toLowerCase().trim();
  const candidates = BROWSER_EXECUTABLE_CANDIDATES[normalizedKey] || [];
  let installedPath = null;
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      installedPath = p;
      break;
    }
  }
  if (!installedPath) {
    return { ok: false, error: `${browserKey} is not installed or cannot be launched for automation.` };
  }
  // Host browser executable exists. Do NOT spawn visible window; automation is driven in background via backend Patchright Core.
  return { ok: true, browserKey: normalizedKey, installedPath };
});

ipcMain.handle('app:get-apk-token', async () => {
  // Honest check: No external APK service is provisioned; do not fabricate fake tokens.
  return {
    ok: false,
    error: 'APK token service is not configured.',
  };
});

ipcMain.handle('app:clear-cookies', async () => {
  try {
    const { session } = require('electron');
    if (session && session.defaultSession) {
      await session.defaultSession.clearStorageData({
        storages: ['cookies', 'localstorage', 'sessionstorage', 'caches', 'indexdb', 'websql'],
      });
      await session.defaultSession.clearCache();
    }
    return { ok: true, message: 'Cookies and cached storage cleared successfully.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('app:check-software-version', async () => {
  return {
    ok: true,
    version: app.getVersion(),
    latestVersion: 'Unable to check (remote source not configured)',
    status: 'Running installed version',
    channel: 'Production / Stable',
  };
});

ipcMain.handle('app:get-window-count', () => {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length;
});

ipcMain.handle('app:close-current-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win.close();
  }
  return { ok: true };
});


app.whenReady().then(() => {
  mainWindow = createWindow();

  if (SMOKE_MODE) attachSmokeChecks(mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// Automated startup verification (--smoke). Used by CI/dev only; never runs in
// normal usage. Verifies that the window opens, the React login screen mounts,
// the preload bridge works, and basic login validation triggers.
// ---------------------------------------------------------------------------
function attachSmokeChecks(win) {
  win.webContents.on('console-message', (event, levelOrParams, message) => {
    const text =
      levelOrParams && typeof levelOrParams === 'object' && levelOrParams.message
        ? levelOrParams.message
        : message;
    console.log('[renderer]', text);
  });

  const runChecks = async () => {
    try {
      const size = win.getSize();
      const windowProps = {
        width: size[0],
        height: size[1],
        minimizable: win.isMinimizable(),
        maximizable: win.isMaximizable(),
        resizable: win.isResizable(),
        closable: win.isClosable(),
      };
      console.log('[smoke] windowProps:', JSON.stringify(windowProps));

      const dom = await win.webContents.executeJavaScript(
        `(() => ({
          title: document.title,
          hasForm: Boolean(document.querySelector('form')),
          hasIdentifier: Boolean(document.querySelector('#identifier') || document.querySelector('#username')),
          hasPassword: Boolean(document.querySelector('#password')),
          passwordMasked: document.querySelector('#password')
            ? document.querySelector('#password').type === 'password'
            : false,
          hasLoginButton: Boolean(document.querySelector('button[type="submit"]')),
          version: (document.querySelector('[data-testid="app-version"]') || {}).textContent || null,
        }))()`
      );
      console.log('[smoke] dom:', JSON.stringify(dom));

      // 1. Validation check (empty submit)
      // 1. Validation check (empty submit)
      const emptyValidation = await win.webContents.executeJavaScript(
        `(() => {
          const form = document.querySelector('form');
          if (!form) return Promise.resolve({ ok: false, reason: 'no form' });
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          return new Promise((resolve) => {
            setTimeout(() => {
              const errors = Array.from(
                document.querySelectorAll('.field-error')
              ).map((el) => el.textContent.trim());
              resolve({ ok: errors.length >= 1, errors });
            }, 150);
          });
        })()`
      );
      console.log('[smoke] emptyValidation:', JSON.stringify(emptyValidation));

      // 2. Real Backend Login Flow with Username Only
      const loginResult = await win.webContents.executeJavaScript(
        `(() => {
          const idInput = document.querySelector('#identifier') || document.querySelector('#username');
          const form = document.querySelector('form');
          if (!idInput || !form) return Promise.resolve({ ok: false, reason: 'missing inputs' });

          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeInputValueSetter.call(idInput, 'Rai Sheraz');
          idInput.dispatchEvent(new Event('input', { bubbles: true }));

          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

          return new Promise((resolve) => {
            let attempts = 0;
            const checkNextScreen = setInterval(() => {
              attempts++;
              const dashboard = document.querySelector('.dashboard-screen');
              const actionCards = Array.from(document.querySelectorAll('.action-card .action-label')).map((el) => el.textContent.trim());
              const placeholder = document.querySelector('.placeholder-screen');
              const footer = document.querySelector('.dashboard-footer');
              const closeBtn = document.querySelector('.dashboard-card .window-close-btn');

              if (dashboard && actionCards.length >= 4) {
                clearInterval(checkNextScreen);
                const hasVerticalScroll = document.documentElement.scrollHeight > document.documentElement.clientHeight;
                const hasHorizontalScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth;

                resolve({
                  ok: true,
                  renderedDashboard: true,
                  cards: actionCards,
                  hasFooter: Boolean(footer),
                  placeholderPresent: Boolean(placeholder),
                  loginFormGone: !Boolean(document.querySelector('form')),
                  closeBtnPresent: Boolean(document.querySelector('.window-close-btn')),
                  closeBtnPresent: Boolean(closeBtn),
                  hasVerticalScroll,
                  hasHorizontalScroll,
                });
              } else if (attempts > 30) {
                clearInterval(checkNextScreen);
                const alert = document.querySelector('.login-alert');
                resolve({
                  ok: false,
                  reason: 'timeout waiting for dashboard screen',
                  alert: alert ? alert.textContent.trim() : null,
                  placeholderPresent: Boolean(placeholder),
                });
              }
            }, 100);
          });
        })()`
      );
      console.log('[smoke] loginResult:', JSON.stringify(loginResult));

      // 3. Test clicking "ID" button to open the separate child Account Window
      // 4. Test clicking "ID" button to open the separate child IRCTC Account Window
      const accountWindowTrigger = await win.webContents.executeJavaScript(
        `(() => {
          const idBtn = Array.from(document.querySelectorAll('.action-card')).find(el => el.textContent.includes('ID'));
          if (!idBtn) return { ok: false, reason: 'ID button not found' };
          idBtn.click();
          return { ok: true, clicked: true };
        })()`
      );
      console.log('[smoke] accountWindowTrigger:', JSON.stringify(accountWindowTrigger));

      await new Promise((resolve) => setTimeout(resolve, 800));

      if (accountWindow && !accountWindow.isDestroyed()) {
        const accSize = accountWindow.getSize();
        console.log('[smoke] accountWindowProps:', JSON.stringify({
          width: accSize[0],
          height: accSize[1],
          minimizable: accountWindow.isMinimizable(),
          maximizable: accountWindow.isMaximizable(),
          resizable: accountWindow.isResizable(),
          closable: accountWindow.isClosable(),
          movable: accountWindow.isMovable(),
        }));

        const accDom = await accountWindow.webContents.executeJavaScript(
          `(async () => {
            const userInput = document.querySelector('#acc-irctc-userid');
            const passInput = document.querySelector('#acc-password');
            const userLabel = document.querySelector('label[for="acc-irctc-userid"]');
            const passLabel = document.querySelector('label[for="acc-password"]');
            const toggleBtn = document.querySelector('.account-form .pw-toggle-btn') || document.querySelector('.account-form .btn-toggle-pw');
            const totalBadge = document.querySelector('[data-testid="total-accounts-count"]');

            const hasSvgIcon = Boolean(toggleBtn && toggleBtn.querySelector('svg'));
            let toggleWorks = false;
            if (passInput && toggleBtn) {
              const t1 = passInput.type;
              toggleBtn.click();
              await new Promise((r) => setTimeout(r, 60));
              const t2 = passInput.type;
              toggleBtn.click();
              await new Promise((r) => setTimeout(r, 60));
              const t3 = passInput.type;
              toggleWorks = t1 === 'password' && t2 === 'text' && t3 === 'password';
            }

            const hasHorizontalScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth;

            return {
              title: document.title,
              hasForm: Boolean(document.querySelector('.account-form')),
              userLabel: userLabel ? userLabel.textContent.trim() : null,
              userPlaceholder: userInput ? userInput.placeholder : null,
              passLabel: passLabel ? passLabel.textContent.trim() : null,
              passPlaceholder: passInput ? passInput.placeholder : null,
              hasSvgIcon,
              toggleWorks,
              totalText: totalBadge ? totalBadge.textContent.trim() : null,
              hasSaveBtn: Boolean(document.querySelector('.btn-save')),
              hasHorizontalScroll,
            };
          })()`
        );
        console.log('[smoke] accountWindowDom:', JSON.stringify(accDom));

        // 5. Test adding an account, verifying visible plaintext password and Serial Number
        const accountCrudTest = await accountWindow.webContents.executeJavaScript(
          `(() => {
            const userInput = document.querySelector('#acc-irctc-userid');
            const passInput = document.querySelector('#acc-password');
            const form = document.querySelector('.account-form');
            if (!userInput || !passInput || !form) {
              return Promise.resolve({ ok: false, reason: 'form elements not found' });
            }

            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(userInput, 'test_irctc_user_smoke');
            userInput.dispatchEvent(new Event('input', { bubbles: true }));

            nativeSetter.call(passInput, 'SmokeTargetPass123!');
            passInput.dispatchEvent(new Event('input', { bubbles: true }));

            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

            return new Promise((resolve) => {
              let attempts = 0;
              const pollSaved = setInterval(async () => {
                attempts++;
                const rows = Array.from(document.querySelectorAll('.accounts-table tbody tr'));
                const row = rows.find((r) => r.querySelector('.account-username')?.textContent.includes('test_irctc_user_smoke'));
                const snCell = row ? row.querySelector('td.col-sn') : null;
                const visiblePw = row ? row.querySelector('.account-password-visible') : null;
                const editBtn = row ? row.querySelector('.btn-edit') : null;
                const delBtn = row ? row.querySelector('.btn-delete') : null;
                const totalBadge = document.querySelector('[data-testid="total-accounts-count"]');

                if (row && visiblePw && editBtn && delBtn && snCell) {
                  clearInterval(pollSaved);
                  const passwordVisible = Boolean(visiblePw.textContent.trim()) && visiblePw.textContent.trim() !== '••••••••';
                  const snCorrect = Boolean(snCell.textContent.trim());
                  const savedUser = row.querySelector('.account-username')?.textContent.trim();
                  const totalAfterSave = totalBadge?.textContent.trim();

                  // 2. Test Edit Flow: click Edit, verify password input gets populated
                  editBtn.click();
                  await new Promise((r) => setTimeout(r, 150));

                  const editHeading = document.querySelector('.account-form-heading')?.textContent.trim();
                  const populatedPw = passInput.value;
                  nativeSetter.call(userInput, 'test_irctc_user_smoke_updated');
                  userInput.dispatchEvent(new Event('input', { bubbles: true }));

                  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                  await new Promise((r) => setTimeout(r, 400));

                  const updatedUser = document.querySelector('.account-username')?.textContent.trim();

                  // 3. Test Delete Flow: click Delete, click Confirm Delete
                  const deleteBtnNow = document.querySelector('.btn-delete');
                  deleteBtnNow.click();
                  await new Promise((r) => setTimeout(r, 150));

                  const confirmBtn = document.querySelector('.btn-confirm-del');
                  if (confirmBtn) confirmBtn.click();

                  await new Promise((r) => setTimeout(r, 400));
                  const totalAfterDelete = document.querySelector('[data-testid="total-accounts-count"]')?.textContent.trim();

                  resolve({
                    ok: true,
                    savedUser,
                    passwordVisible,
                    snCorrect,
                    populatedPwMatches: Boolean(populatedPw) && populatedPw.length > 0,
                    totalAfterSave,
                    editHeading,
                    updatedUser,
                    totalAfterDelete,
                  });
                } else if (attempts > 30) {
                  clearInterval(pollSaved);
                  const alert = document.querySelector('.accounts-alert');
                  resolve({
                    ok: false,
                    reason: 'timeout waiting for target account row',
                    alert: alert ? alert.textContent.trim() : null,
                  });
                }
              }, 100);
            });
          })()`
        );
        console.log('[smoke] accountCrudTest:', JSON.stringify(accountCrudTest));

        if (accountWindow && !accountWindow.isDestroyed()) {
          accountWindow.close();
        }

        // 5B. Test clicking "Bank" action card on Dashboard to open Bank Window
        const bankWindowTrigger = await win.webContents.executeJavaScript(
          `(() => {
            const bankBtn = Array.from(document.querySelectorAll('.action-card')).find(el => el.textContent.includes('Bank'));
            if (!bankBtn) return { ok: false, reason: 'Bank button not found' };
            bankBtn.click();
            return { ok: true, clicked: true };
          })()`
        );
        console.log('[smoke] bankWindowTrigger:', JSON.stringify(bankWindowTrigger));

        await new Promise((resolve) => setTimeout(resolve, 800));

        if (bankWindow && !bankWindow.isDestroyed()) {
          const bankSize = bankWindow.getSize();
          console.log('[smoke] bankWindowProps:', JSON.stringify({
            width: bankSize[0],
            height: bankSize[1],
            resizable: bankWindow.isResizable(),
            closable: bankWindow.isClosable(),
          }));

          const bankDom = await bankWindow.webContents.executeJavaScript(
            `(() => {
              const title = document.querySelector('.bank-win-title')?.textContent.trim();
              const tabBank = Boolean(document.querySelector('[data-testid="tab-bank"]'));
              const tabDebit = Boolean(document.querySelector('[data-testid="tab-debit-card"]'));
              const tabCredit = Boolean(document.querySelector('[data-testid="tab-credit-card"]'));
              const selectBank = Boolean(document.querySelector('[data-testid="select-bank-name"]'));
              const inputUsername = Boolean(document.querySelector('[data-testid="input-bank-username"]'));
              const inputPassword = Boolean(document.querySelector('[data-testid="input-bank-password"]'));
              const inputNameToSave = Boolean(document.querySelector('[data-testid="input-bank-nametosave"]'));
              const saveBtn = Boolean(document.querySelector('[data-testid="btn-save-bank"]'));
              const listbox = Boolean(document.querySelector('[data-testid="bank-listbox"]'));
              const editBtn = Boolean(document.querySelector('[data-testid="btn-bank-edit"]'));
              const delBtn = Boolean(document.querySelector('[data-testid="btn-bank-delete"]'));
              const delAllBtn = Boolean(document.querySelector('[data-testid="btn-bank-delete-all"]'));

              return {
                ok: title === 'Bank' && tabBank && tabDebit && tabCredit && selectBank && saveBtn && listbox && editBtn && delBtn && delAllBtn,
                title,
                tabBank,
                tabDebit,
                tabCredit,
                selectBank,
                inputUsername,
                inputPassword,
                inputNameToSave,
                saveBtn,
                listbox,
                editBtn,
                delBtn,
                delAllBtn,
              };
            })()`
          );
          console.log('[smoke] bankDom:', JSON.stringify(bankDom));

          // Test adding a Bank item (e.g. PayTM-QR / paytm@qr)
          const bankCrudTest = await bankWindow.webContents.executeJavaScript(
            `(() => {
              const sel = document.querySelector('[data-testid="select-bank-name"]');
              const uInput = document.querySelector('[data-testid="input-bank-username"]');
              const pInput = document.querySelector('[data-testid="input-bank-password"]');
              const nInput = document.querySelector('[data-testid="input-bank-nametosave"]');
              const saveBtn = document.querySelector('[data-testid="btn-save-bank"]');
              if (!sel || !nInput || !saveBtn) return Promise.resolve({ ok: false, reason: 'bank form elements not found' });

              sel.value = 'PayTM-QR';
              sel.dispatchEvent(new Event('change', { bubbles: true }));

              const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              if (uInput) {
                nativeSetter.call(uInput, 'paytm_user');
                uInput.dispatchEvent(new Event('input', { bubbles: true }));
              }
              if (pInput) {
                nativeSetter.call(pInput, 'paytm_pass');
                pInput.dispatchEvent(new Event('input', { bubbles: true }));
              }
              nativeSetter.call(nInput, 'paytm@qr');
              nInput.dispatchEvent(new Event('input', { bubbles: true }));

              saveBtn.click();

              return new Promise((resolve) => {
                let attempts = 0;
                const pollSaved = setInterval(() => {
                  attempts++;
                  const items = Array.from(document.querySelectorAll('.bank-list-item'));
                  const item = items.find((el) => el.textContent.includes('PayTM-QR_paytm@qr'));
                  if (item) {
                    clearInterval(pollSaved);
                    resolve({ ok: true, savedText: item.textContent.trim() });
                  } else if (attempts > 30) {
                    clearInterval(pollSaved);
                    resolve({ ok: false, reason: 'timeout waiting for bank list item' });
                  }
                }, 100);
              });
            })()`
          );
          console.log('[smoke] bankCrudTest:', JSON.stringify(bankCrudTest));

          // Capture screenshot of Bank tab
          try {
            const imgBank = await bankWindow.webContents.capturePage();
            fs.writeFileSync('C:/Users/Smart/.gemini/antigravity/brain/2a03772e-fcab-490a-985a-d9b6300b97b7/screen_bank_tab.png', imgBank.toPNG());
          } catch (e) {
            console.log('[smoke] failed to capture screen_bank_tab:', e.message);
          }

          // Test tab switching to Debit Card
          const debitTabTest = await bankWindow.webContents.executeJavaScript(
            `(async () => {
              const tabDebit = document.querySelector('[data-testid="tab-debit-card"]');
              if (!tabDebit) return { ok: false };
              tabDebit.click();
              await new Promise(r => setTimeout(r, 300));
              const cardForm = Boolean(document.querySelector('[data-testid="btn-save-debit"]'));
              const debitBankSelect = Boolean(document.querySelector('[data-testid="select-debit-bank"]'));
              return { ok: cardForm && debitBankSelect };
            })()`
          );
          console.log('[smoke] debitTabTest:', JSON.stringify(debitTabTest));

          // Fill and save a Debit Card
          const debitCrudTest = await bankWindow.webContents.executeJavaScript(
            `(() => {
              const bSel = document.querySelector('[data-testid="select-debit-bank"]');
              const cNo = document.querySelector('[data-testid="input-debit-cardno"]');
              const nCard = document.querySelector('[data-testid="input-debit-nameoncard"]');
              const nToSave = document.querySelector('[data-testid="input-debit-nametosave"]');
              const saveBtn = document.querySelector('[data-testid="btn-save-debit"]');
              if (!bSel || !cNo || !nToSave || !saveBtn) return Promise.resolve({ ok: false, reason: 'debit elements not found' });

              bSel.value = 'HDFC';
              bSel.dispatchEvent(new Event('change', { bubbles: true }));

              const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              nativeSetter.call(cNo, '4532111122223333');
              cNo.dispatchEvent(new Event('input', { bubbles: true }));

              if (nCard) {
                nativeSetter.call(nCard, 'JOHN DOE');
                nCard.dispatchEvent(new Event('input', { bubbles: true }));
              }

              nativeSetter.call(nToSave, 'hdfc_debit');
              nToSave.dispatchEvent(new Event('input', { bubbles: true }));

              saveBtn.click();

              return new Promise((resolve) => {
                let attempts = 0;
                const pollSaved = setInterval(() => {
                  attempts++;
                  const items = Array.from(document.querySelectorAll('.bank-list-item'));
                  const item = items.find((el) => el.textContent.includes('HDFC_hdfc_debit'));
                  if (item) {
                    clearInterval(pollSaved);
                    resolve({ ok: true, savedText: item.textContent.trim() });
                  } else if (attempts > 30) {
                    clearInterval(pollSaved);
                    resolve({ ok: false, reason: 'timeout waiting for debit list item' });
                  }
                }, 100);
              });
            })()`
          );
          console.log('[smoke] debitCrudTest:', JSON.stringify(debitCrudTest));

          // Capture screenshot of Debit Card tab
          try {
            const imgDebit = await bankWindow.webContents.capturePage();
            fs.writeFileSync('C:/Users/Smart/.gemini/antigravity/brain/2a03772e-fcab-490a-985a-d9b6300b97b7/screen_debit_tab.png', imgDebit.toPNG());
          } catch (e) {
            console.log('[smoke] failed to capture screen_debit_tab:', e.message);
          }

          // Test tab switching to Credit Card
          const creditTabTest = await bankWindow.webContents.executeJavaScript(
            `(async () => {
              const tabCredit = document.querySelector('[data-testid="tab-credit-card"]');
              if (!tabCredit) return { ok: false };
              tabCredit.click();
              await new Promise(r => setTimeout(r, 300));
              const cardForm = Boolean(document.querySelector('[data-testid="btn-save-credit"]'));
              const creditBankSelect = Boolean(document.querySelector('[data-testid="select-credit-bank"]'));
              return { ok: cardForm && creditBankSelect };
            })()`
          );
          console.log('[smoke] creditTabTest:', JSON.stringify(creditTabTest));

          // Fill and save a Credit Card
          const creditCrudTest = await bankWindow.webContents.executeJavaScript(
            `(() => {
              const bSel = document.querySelector('[data-testid="select-credit-bank"]');
              const cNo = document.querySelector('[data-testid="input-credit-cardno"]');
              const nToSave = document.querySelector('[data-testid="input-credit-nametosave"]');
              const saveBtn = document.querySelector('[data-testid="btn-save-credit"]');
              if (!bSel || !cNo || !nToSave || !saveBtn) return Promise.resolve({ ok: false, reason: 'credit elements not found' });

              bSel.value = 'SBI';
              bSel.dispatchEvent(new Event('change', { bubbles: true }));

              const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              nativeSetter.call(cNo, '5412750012345678');
              cNo.dispatchEvent(new Event('input', { bubbles: true }));

              nativeSetter.call(nToSave, 'sbi_credit');
              nToSave.dispatchEvent(new Event('input', { bubbles: true }));

              saveBtn.click();

              return new Promise((resolve) => {
                let attempts = 0;
                const pollSaved = setInterval(() => {
                  attempts++;
                  const items = Array.from(document.querySelectorAll('.bank-list-item'));
                  const item = items.find((el) => el.textContent.includes('SBI_sbi_credit'));
                  if (item) {
                    clearInterval(pollSaved);
                    resolve({ ok: true, savedText: item.textContent.trim() });
                  } else if (attempts > 30) {
                    clearInterval(pollSaved);
                    resolve({ ok: false, reason: 'timeout waiting for credit list item' });
                  }
                }, 100);
              });
            })()`
          );
          console.log('[smoke] creditCrudTest:', JSON.stringify(creditCrudTest));

          // Capture screenshot of Credit Card tab
          try {
            const imgCredit = await bankWindow.webContents.capturePage();
            fs.writeFileSync('C:/Users/Smart/.gemini/antigravity/brain/2a03772e-fcab-490a-985a-d9b6300b97b7/screen_credit_tab.png', imgCredit.toPNG());
          } catch (e) {
            console.log('[smoke] failed to capture screen_credit_tab:', e.message);
          }

          bankWindow.close();
        }

        // 6. Test clicking "Ticket" action card on Dashboard to toggle Ticket Options Dropdown (media_1789479298773.png)
        const ticketDropdownCheck = await win.webContents.executeJavaScript(
          `(async () => {
            const ticketBtn = document.querySelector('[data-testid="ticket-module-button"]') || Array.from(document.querySelectorAll('.action-card')).find(el => el.textContent.includes('Ticket'));
            if (!ticketBtn) return { ok: false, reason: 'Ticket card not found' };
            ticketBtn.click();
            await new Promise((r) => setTimeout(r, 150));

            const menu = document.querySelector('[data-testid="ticket-options-menu"]');
            const newTicketOpt = document.querySelector('[data-testid="btn-new-ticket-option"]');
            const openTicketsOpt = document.querySelector('[data-testid="btn-open-tickets-option"]');

            return {
              ok: Boolean(menu && newTicketOpt && openTicketsOpt),
              menuPresent: Boolean(menu),
              newTicketText: newTicketOpt ? newTicketOpt.textContent.trim() : null,
              openTicketsText: openTicketsOpt ? openTicketsOpt.textContent.trim() : null,
            };
          })()`
        );
        console.log('[smoke] ticketDropdownCheck:', JSON.stringify(ticketDropdownCheck));


        // Click "New Ticket" option in the dropdown to open the existing New Ticket window
        await win.webContents.executeJavaScript(
          `document.querySelector('[data-testid="btn-new-ticket-option"]')?.click()`
        );

        await new Promise((resolve) => setTimeout(resolve, 800));

        // Verify Ticket is an independent BrowserWindow (Window count === 2)
        const windowCountAfterTicket = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length;
        console.log('[smoke] windowCountAfterTicket:', windowCountAfterTicket);


        if (ticketWindow && !ticketWindow.isDestroyed()) {
          const ticketSize = ticketWindow.getSize();
          console.log('[smoke] ticketWindowProps:', JSON.stringify({
            width: ticketSize[0],
            height: ticketSize[1],
            resizable: ticketWindow.isResizable(),
            closable: ticketWindow.isClosable(),
          }));

          const ticketDom = await ticketWindow.webContents.executeJavaScript(
            `(() => {
              const title = (document.querySelector('.nt-title-text') || document.querySelector('.ticket-header-title'))?.textContent.trim();
              const hasDashboardBackBtn = Boolean(document.querySelector('.btn-header-back'));
              const accountSelect = Boolean(document.querySelector('.nt-acc-select') || document.querySelector('#irctc-account-select'));
              const fromInput = (document.querySelector('#from-input') || document.querySelector('#from-station-input'))?.value;
              const toInput = (document.querySelector('#to-input') || document.querySelector('#to-station-input'))?.value;
              const dateInput = Boolean(document.querySelector('#date-input') || document.querySelector('#journey-date-input'));
              const searchBtn = Boolean(document.querySelector('.btn-search-trains') || document.querySelector('.nt-btn-find'));
              const passengerRows = (document.querySelectorAll('.nt-passenger-table tbody tr').length || document.querySelectorAll('.passenger-table tbody tr').length);
              const mobileInput = Boolean(document.querySelector('input[type="tel"]'));
              const saveBtn = Boolean(document.querySelector('.nt-btn-save') || document.querySelector('.btn-save-large'));
              const closeBtn = Boolean(document.querySelector('.nt-title-close') || document.querySelector('.btn-window-close-red'));
              const hasHorizontalScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth;
              const hasVerticalScroll = document.documentElement.scrollHeight > document.documentElement.clientHeight;
              const quotaRadioCount = document.querySelectorAll('input[name="quota-radio-group"]').length;
              const classOptions = Array.from(document.querySelectorAll('#class-select option')).map(o => o.value);
              const seniorHeaderExists = Boolean(document.querySelector('.th-senior'));
              const childHeaderExists = Boolean(document.querySelector('.th-child'));
              const bedHeaderExists = Boolean(document.querySelector('.th-bed'));
              const priorBankOptions = Array.from(document.querySelectorAll('[data-testid="select-prior-bank"] option')).map(o => o.value);
              const backupBankOptions = Array.from(document.querySelectorAll('[data-testid="select-backup-bank"] option')).map(o => o.value);

              return {
                ok: title === 'New Ticket' && !hasDashboardBackBtn && passengerRows === 6 && saveBtn && closeBtn && !hasHorizontalScroll && !hasVerticalScroll && quotaRadioCount === 4 && !seniorHeaderExists && childHeaderExists && bedHeaderExists && priorBankOptions.includes('HBL') && backupBankOptions.includes('HBL'),
                title,
                hasDashboardBackBtn,
                priorBankOptions,
                backupBankOptions,
                accountSelect,
                fromInput,
                toInput,
                dateInput,
                searchBtn,
                passengerRows,
                quotaRadioCount,
                classOptions,
                seniorHeaderExists,
                childHeaderExists,
                bedHeaderExists,
                mobileInput,
                saveBtn,
                closeBtn,
                hasHorizontalScroll,
                hasVerticalScroll,
                scrollWidth: document.documentElement.scrollWidth,
                clientWidth: document.documentElement.clientWidth,
                scrollHeight: document.documentElement.scrollHeight,
                clientHeight: document.documentElement.clientHeight,
              };
            })()`
          );
          console.log('[smoke] ticketDom:', JSON.stringify(ticketDom));

          // Verify that clicking Save triggers validation alert and content still fits without scrollbar
          await ticketWindow.webContents.executeJavaScript(
            `document.querySelector('.nt-btn-save')?.click()`
          );
          await new Promise((resolve) => setTimeout(resolve, 300));
          const alertTest = await ticketWindow.webContents.executeJavaScript(
            `(() => {
              return {
                alertPresent: Boolean(document.querySelector('.nt-alert')),
                alertText: document.querySelector('.nt-alert')?.textContent.trim(),
                hasVerticalScroll: document.documentElement.scrollHeight > document.documentElement.clientHeight,
                scrollHeight: document.documentElement.scrollHeight,
                clientHeight: document.documentElement.clientHeight,
              };
            })()`
          );
          console.log('[smoke] alertTest:', JSON.stringify(alertTest));

          // 7. Test clicking "Search Trains" inside Ticket window to open Window 3 (Search Train Window)
          const searchTrainTrigger = await ticketWindow.webContents.executeJavaScript(
            `(() => {
              const select = document.querySelector('#irctc-account-select');
              const searchBtn = document.querySelector('.btn-search-trains') || document.querySelector('.nt-btn-find') || document.querySelector('.nt-link-availability');
              if (!searchBtn) return { ok: false, reason: 'Search button not found' };
              searchBtn.click();
              return { ok: true, clicked: true, accountValue: select ? select.value : null };
            })()`
          );
          console.log('[smoke] searchTrainTrigger:', JSON.stringify(searchTrainTrigger));

          await new Promise((resolve) => setTimeout(resolve, 1200));

          const windowCountAfterSearch = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length;
          console.log('[smoke] windowCountAfterSearch (expect 3):', windowCountAfterSearch);

          if (searchTrainWindow && !searchTrainWindow.isDestroyed()) {
            const searchSize = searchTrainWindow.getSize();
            console.log('[smoke] searchTrainWindowProps:', JSON.stringify({
              width: searchSize[0],
              height: searchSize[1],
              resizable: searchTrainWindow.isResizable(),
              closable: searchTrainWindow.isClosable(),
            }));

            const searchDom = await searchTrainWindow.webContents.executeJavaScript(
              `(() => {
                const title = (document.querySelector('.st-header-title') || document.querySelector('.ticket-header-title'))?.textContent.trim();
                const route = (document.querySelector('.st-params-bar') || document.querySelector('.search-params-bar'))?.textContent.trim();
                const pillGroups = document.querySelectorAll('.st-pill-group');
                const quotaPills = pillGroups[0] ? Array.from(pillGroups[0].querySelectorAll('.st-pill-btn')).map(b => b.textContent.trim()) : [];
                const classPills = pillGroups[1] ? Array.from(pillGroups[1].querySelectorAll('.st-pill-btn')).map(b => b.textContent.trim()) : [];
                const trainsTable = Boolean(document.querySelector('.st-trains-table') || document.querySelector('.trains-table'));
                const closeBtn = Boolean(document.querySelector('.btn-window-close-red'));
                const hasHorizontalScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth;

                return {
                  ok: (title?.includes('Search Train') || title?.includes('Availability')) && quotaPills.length === 4 && classPills.length === 8 && trainsTable && closeBtn && !hasHorizontalScroll,
                  title,
                  route,
                  quotaPills,
                  classPills,
                  trainsTable,
                  closeBtn,
                  hasHorizontalScroll,
                };
              })()`
            );
            console.log('[smoke] searchTrainDom:', JSON.stringify(searchDom));

            // Test train selection IPC from searchTrainWindow to ticketWindow
            const selectTrainTest = await searchTrainWindow.webContents.executeJavaScript(
              `(() => {
                const sampleTrain = {
                  trainNumber: '12301',
                  trainName: 'HOWRAH RAJDHANI',
                  selectedClass: '3A',
                  quota: 'General',
                  departureTime: '16:55',
                  arrivalTime: '10:00',
                  duration: '17h 05m',
                };
                window.netx.app.selectTrain(sampleTrain);
                return { ok: true, sent: true };
              })()`
            );
            console.log('[smoke] selectTrainTest:', JSON.stringify(selectTrainTest));

            await new Promise((resolve) => setTimeout(resolve, 500));

            const windowCountAfterSelect = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length;
            console.log('[smoke] windowCountAfterSelect (expect 2):', windowCountAfterSelect);

            // Verify Section 2 in ticketWindow is auto-filled
            const autofillCheck = await ticketWindow.webContents.executeJavaScript(
              `(() => {
                const trainNo = (document.querySelector('#trainno-input') || document.querySelector('#selected-train-number'))?.value;
                const trainTag = document.querySelector('.nt-train-name-tag')?.textContent || '';
                const inputs = Array.from(document.querySelectorAll('.field-input-autofill')).map(el => el.value);
                return {
                  ok: trainNo === '12301' || inputs.includes('12301'),
                  trainNo,
                  trainTag,
                  inputs,
                };
              })()`
            );
            console.log('[smoke] autofillCheck in ticketWindow:', JSON.stringify(autofillCheck));

            // Close ticketWindow
            ticketWindow.close();
            await new Promise((resolve) => setTimeout(resolve, 400));

            const windowCountAfterTicketClose = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length;
            console.log('[smoke] windowCountAfterTicketClose (expect 1):', windowCountAfterTicketClose);

            // Verify mainWindow is still alive and on Dashboard
            const mainStillOnDashboard = await win.webContents.executeJavaScript(
              `Boolean(document.querySelector('.dashboard-screen'))`
            );
            console.log('[smoke] mainStillOnDashboard (expect true):', mainStillOnDashboard);

            // 8. Test clicking "Ticket" -> "Open Tickets" option in the dropdown to open Open Tickets Window (media_1789479275721.png)
            const openTicketsOptionTrigger = await win.webContents.executeJavaScript(
              `(async () => {
                const ticketBtn = document.querySelector('[data-testid="ticket-module-button"]') || Array.from(document.querySelectorAll('.action-card')).find(el => el.textContent.includes('Ticket'));
                if (!ticketBtn) return { ok: false, reason: 'Ticket button not found' };
                ticketBtn.click();
                await new Promise((r) => setTimeout(r, 150));
                const openOpt = document.querySelector('[data-testid="btn-open-tickets-option"]');
                if (!openOpt) return { ok: false, reason: 'Open Tickets option not found' };
                openOpt.click();
                return { ok: true, clicked: true };
              })()`
            );
            console.log('[smoke] openTicketsOptionTrigger:', JSON.stringify(openTicketsOptionTrigger));


            await new Promise((resolve) => setTimeout(resolve, 800));

            if (openTicketsWindow && !openTicketsWindow.isDestroyed()) {
              const otSize = openTicketsWindow.getSize();
              console.log('[smoke] openTicketsWindowProps:', JSON.stringify({
                width: otSize[0],
                height: otSize[1],
                resizable: openTicketsWindow.isResizable(),
                closable: openTicketsWindow.isClosable(),
              }));

              const otDom = await openTicketsWindow.webContents.executeJavaScript(
                `(() => {
                  const title = document.querySelector('.open-tickets-title-text')?.textContent.trim();
                  const closeBtn = Boolean(document.querySelector('.open-tickets-close'));
                  const table = Boolean(document.querySelector('.open-tickets-table'));
                  const deleteBtn = Boolean(document.querySelector('[data-testid="btn-delete-all-tickets"]'));
                  const openAllBtn = Boolean(document.querySelector('[data-testid="btn-open-all-tickets"]'));
                  const headers = Array.from(document.querySelectorAll('.open-tickets-table th')).map(th => th.textContent.trim());

                  return {
                    ok: Boolean(title && title.includes('Total Ticket') && closeBtn && (table || document.querySelector('.open-tickets-status-msg'))),
                    title,
                    closeBtn,
                    table,
                    headers,
                    hasDeleteAll: deleteBtn,
                    hasOpenAll: openAllBtn,
                  };
                })()`
              );
              console.log('[smoke] openTicketsDom:', JSON.stringify(otDom));

              // 9. Test opening Ticket Quick Launch / Web Selector Window (media_1789479275721.png)
              createTicketWebSelectWindow({
                id: 999,
                ticketName: 'NDLS_CSMT',
                trainNumber: '12138',
                selectedClass: '3A',
                quota: 'TQ',
                journeyDate: '2026-07-24',
              });

              await new Promise((resolve) => setTimeout(resolve, 800));

              if (ticketWebSelectWindow && !ticketWebSelectWindow.isDestroyed()) {
                const twsSize = ticketWebSelectWindow.getSize();
                console.log('[smoke] ticketWebSelectWindowProps:', JSON.stringify({
                  width: twsSize[0],
                  height: twsSize[1],
                  alwaysOnTop: ticketWebSelectWindow.isAlwaysOnTop(),
                  resizable: ticketWebSelectWindow.isResizable(),
                }));

                const twsDom = await ticketWebSelectWindow.webContents.executeJavaScript(
                  `(() => {
                    const title = document.querySelector('[data-testid="tws-ticket-title"]')?.textContent.trim();
                    const statusStrip = document.querySelector('[data-testid="tws-status-strip"]')?.textContent.trim();
                    const infoLine = document.querySelector('[data-testid="tws-info-line"]')?.textContent.trim();
                    const btnWeb1 = Boolean(document.querySelector('[data-testid="btn-web-1"]'));
                    const btnWeb2 = Boolean(document.querySelector('[data-testid="btn-web-2"]'));
                    const btnWeb3 = Boolean(document.querySelector('[data-testid="btn-web-3"]'));
                    const btnApp = Boolean(document.querySelector('[data-testid="btn-app"]'));
                    const closeBtn = Boolean(document.querySelector('.tws-close'));

                    return {
                      ok: title === 'NDLS_CSMT' && Boolean(statusStrip && statusStrip.includes('Ready')) && btnWeb1 && btnWeb2 && btnWeb3 && btnApp && closeBtn,
                      title,
                      statusStrip,
                      infoLine,
                      btnWeb1,
                      btnWeb2,
                      btnWeb3,
                      btnApp,
                      closeBtn,
                    };
                  })()`
                );
                console.log('[smoke] ticketWebSelectDom:', JSON.stringify(twsDom));

                ticketWebSelectWindow.close();
              } else {
                console.log('[smoke] ticketWebSelectWindow not detected');
              }

              openTicketsWindow.close();
            } else {
              console.log('[smoke] openTicketsWindow not detected');
            }
          } else {
            console.log('[smoke] searchTrainWindow not detected');
          }

        } else {
          console.log('[smoke] ticketWindow not detected');
        }

        // =====================================================================
        // 10. Test Tools Module (Tools dropdown, Booking History, Proxy Setting)
        // =====================================================================
        console.log('[smoke] Starting Tools module checks...');

        // 10a. Verify Dashboard 4 cards
        const dashCards = await win.webContents.executeJavaScript(
          `(() => {
            const cards = Array.from(document.querySelectorAll('.action-card .action-label')).map(el => el.textContent.trim());
            return cards;
          })()`
        );
        console.log('[smoke] dashboardActionCards:', JSON.stringify(dashCards));

        // Click "Tool" action card on Dashboard to open Tools Dropdown
        await win.webContents.executeJavaScript(
          `document.querySelector('[data-testid="tool-module-button"]')?.click()`
        );

        await new Promise((resolve) => setTimeout(resolve, 500));

        const toolMenuCheck = await win.webContents.executeJavaScript(
          `(() => {
            const menu = document.querySelector('[data-testid="tools-options-menu"]');
            const items = Array.from(document.querySelectorAll('.tool-dropdown-menu .ticket-dropdown-item')).map(el => el.textContent.trim());
            return {
              hasMenu: Boolean(menu),
              itemCount: items.length,
              items,
            };
          })()`
        );
        console.log('[smoke] toolMenuCheck:', JSON.stringify(toolMenuCheck));

        try {
          const imgDash = await win.webContents.capturePage();
          fs.writeFileSync('C:/Users/Smart/.gemini/antigravity/brain/2a03772e-fcab-490a-985a-d9b6300b97b7/screen_dashboard_tools.png', imgDash.toPNG());
          console.log('[smoke] Saved screen_dashboard_tools.png');
        } catch (e) {
          console.log('[smoke] Failed to save screen_dashboard_tools.png:', e.message);
        }

        // 10b. Click "Booking History" from Tools dropdown
        await win.webContents.executeJavaScript(
          `document.querySelector('[data-testid="btn-booking-history-option"]')?.click()`
        );

        await new Promise((resolve) => setTimeout(resolve, 1000));

        if (bookingHistoryWindow && !bookingHistoryWindow.isDestroyed()) {
          const bhSize = bookingHistoryWindow.getSize();
          console.log('[smoke] bookingHistoryWindowProps:', JSON.stringify({
            width: bhSize[0],
            height: bhSize[1],
            title: bookingHistoryWindow.getTitle(),
          }));

          const bhDom = await bookingHistoryWindow.webContents.executeJavaScript(
            `(() => {
              const table = document.querySelector('[data-testid="history-table"]');
              const licenseModal = document.querySelector('[data-testid="license-modal"]');
              const retentionSelect = document.querySelector('[data-testid="select-retention-days"]');
              const saveBtn = document.querySelector('[data-testid="btn-save-retention"]');
              const clearBtn = document.querySelector('[data-testid="btn-clear-history"]');

              return {
                ok: Boolean(table && !licenseModal && retentionSelect && saveBtn && clearBtn),
                hasTable: Boolean(table),
                hasLicenseModal: Boolean(licenseModal),
                hasRetention: Boolean(retentionSelect),
                hasSaveBtn: Boolean(saveBtn),
                hasClearBtn: Boolean(clearBtn),
              };
            })()`
          );
          console.log('[smoke] bookingHistoryDom (clean table, no modal):', JSON.stringify(bhDom));

          try {
            const imgBh = await bookingHistoryWindow.webContents.capturePage();
            fs.writeFileSync('C:/Users/Smart/.gemini/antigravity/brain/2a03772e-fcab-490a-985a-d9b6300b97b7/screen_booking_history_table.png', imgBh.toPNG());
            console.log('[smoke] Saved screen_booking_history_table.png');
          } catch (e) {
            console.log('[smoke] Failed to save screen_booking_history_table.png:', e.message);
          }

          bookingHistoryWindow.close();
        } else {
          console.log('[smoke] bookingHistoryWindow not detected');
        }

        await new Promise((resolve) => setTimeout(resolve, 600));

        // 10c. Click "Tool" -> "Add Proxy IP"
        await win.webContents.executeJavaScript(
          `document.querySelector('[data-testid="tool-module-button"]')?.click()`
        );
        await new Promise((resolve) => setTimeout(resolve, 400));

        await win.webContents.executeJavaScript(
          `document.querySelector('[data-testid="btn-add-proxy-option"]')?.click()`
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));

        if (proxySettingWindow && !proxySettingWindow.isDestroyed()) {
          const psSize = proxySettingWindow.getSize();
          console.log('[smoke] proxySettingWindowProps:', JSON.stringify({
            width: psSize[0],
            height: psSize[1],
            title: proxySettingWindow.getTitle(),
          }));

          const psDom = await proxySettingWindow.webContents.executeJavaScript(
            `(() => {
              const ipInput = document.querySelector('[data-testid="input-proxy-ip"]');
              const portInput = document.querySelector('[data-testid="input-proxy-port"]');
              const checkIrctc = document.querySelector('[data-testid="checkbox-check-irctc"]');
              const saveBtn = document.querySelector('[data-testid="btn-save-proxy"]');
              const proxyDropdown = document.querySelector('[data-testid="select-proxy-dropdown"]');
              const checkBtn = document.querySelector('[data-testid="btn-check-proxy"]');
              const deleteBtn = document.querySelector('[data-testid="btn-delete-proxy"]');
              const deleteAllBtn = document.querySelector('[data-testid="btn-delete-all-proxies"]');
              const limitInput = document.querySelector('[data-testid="input-proxy-pair-limit"]');
              const saveLimitBtn = document.querySelector('[data-testid="btn-save-proxy-limit"]');

              return {
                ok: Boolean(ipInput && portInput && saveBtn && limitInput && saveLimitBtn && !checkIrctc && !checkBtn),
                hasIpInput: Boolean(ipInput),
                hasPortInput: Boolean(portInput),
                checkIrctcRemoved: !checkIrctc,
                hasSaveBtn: Boolean(saveBtn),
                hasProxyDropdown: Boolean(proxyDropdown),
                checkBtnRemoved: !checkBtn,
                hasDeleteBtn: Boolean(deleteBtn),
                hasDeleteAllBtn: Boolean(deleteAllBtn),
                hasLimitInput: Boolean(limitInput),
                hasSaveLimitBtn: Boolean(saveLimitBtn),
              };
            })()`
          );
          console.log('[smoke] proxySettingDom:', JSON.stringify(psDom));

          // Fill and save test proxy
          await proxySettingWindow.webContents.executeJavaScript(
            `(() => {
              const ipInput = document.querySelector('[data-testid="input-proxy-ip"]');
              const portInput = document.querySelector('[data-testid="input-proxy-port"]');
              if (ipInput && portInput) {
                const nativeIp = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeIp.call(ipInput, '192.168.1.100');
                ipInput.dispatchEvent(new Event('input', { bubbles: true }));

                const nativePort = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativePort.call(portInput, '8080');
                portInput.dispatchEvent(new Event('input', { bubbles: true }));

                document.querySelector('[data-testid="btn-save-proxy"]')?.click();
              }
            })()`
          );
          await new Promise((resolve) => setTimeout(resolve, 800));

          try {
            const imgPs = await proxySettingWindow.webContents.capturePage();
            fs.writeFileSync('C:/Users/Smart/.gemini/antigravity/brain/2a03772e-fcab-490a-985a-d9b6300b97b7/screen_proxy_setting.png', imgPs.toPNG());
            console.log('[smoke] Saved screen_proxy_setting.png');
          } catch (e) {
            console.log('[smoke] Failed to save screen_proxy_setting.png:', e.message);
          }

          proxySettingWindow.close();
        } else {
          console.log('[smoke] proxySettingWindow not detected');
        }

        await new Promise((resolve) => setTimeout(resolve, 600));

        // 10d. Click "Tool" -> "Backup & Restore"
        await win.webContents.executeJavaScript(
          `document.querySelector('[data-testid="tool-module-button"]')?.click()`
        );
        await new Promise((resolve) => setTimeout(resolve, 400));

        await win.webContents.executeJavaScript(
          `document.querySelector('[data-testid="btn-backup-restore-option"]')?.click()`
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));

        if (backupRestoreWindow && !backupRestoreWindow.isDestroyed()) {
          const bakSize = backupRestoreWindow.getSize();
          console.log('[smoke] backupRestoreWindowProps:', JSON.stringify({
            width: bakSize[0],
            height: bakSize[1],
            title: backupRestoreWindow.getTitle(),
          }));

          // Backup Tab Check
          const bakDom = await backupRestoreWindow.webContents.executeJavaScript(
            `(() => {
              const tabBak = document.querySelector('[data-testid="tab-backup"]');
              const tabRes = document.querySelector('[data-testid="tab-restore"]');
              const tabDel = document.querySelector('[data-testid="tab-delete"]');
              const chkAll = document.querySelector('[data-testid="chk-all-backup"]');
              const inputPwd = document.querySelector('[data-testid="input-backup-password"]');
              const inputConf = document.querySelector('[data-testid="input-confirm-password"]');
              const btnBak = document.querySelector('[data-testid="btn-do-backup"]');

              return {
                ok: Boolean(tabBak && tabRes && tabDel && chkAll && inputPwd && inputConf && btnBak),
                hasTabBak: Boolean(tabBak),
                hasTabRes: Boolean(tabRes),
                hasTabDel: Boolean(tabDel),
                chkAllChecked: chkAll ? chkAll.checked : false,
                hasInputPwd: Boolean(inputPwd),
                hasInputConf: Boolean(inputConf),
                hasBtnBak: Boolean(btnBak),
              };
            })()`
          );
          console.log('[smoke] backupTabDom:', JSON.stringify(bakDom));

          try {
            const imgBak = await backupRestoreWindow.webContents.capturePage();
            fs.writeFileSync('C:/Users/Smart/.gemini/antigravity/brain/2a03772e-fcab-490a-985a-d9b6300b97b7/screen_backup_tab.png', imgBak.toPNG());
            console.log('[smoke] Saved screen_backup_tab.png');
          } catch (e) {
            console.log('[smoke] Failed to save screen_backup_tab.png:', e.message);
          }

          // Click Restore Tab
          await backupRestoreWindow.webContents.executeJavaScript(
            `document.querySelector('[data-testid="tab-restore"]')?.click()`
          );
          await new Promise((resolve) => setTimeout(resolve, 500));

          try {
            const imgRes = await backupRestoreWindow.webContents.capturePage();
            fs.writeFileSync('C:/Users/Smart/.gemini/antigravity/brain/2a03772e-fcab-490a-985a-d9b6300b97b7/screen_restore_tab.png', imgRes.toPNG());
            console.log('[smoke] Saved screen_restore_tab.png');
          } catch (e) {
            console.log('[smoke] Failed to save screen_restore_tab.png:', e.message);
          }

          // Click Delete Tab
          await backupRestoreWindow.webContents.executeJavaScript(
            `document.querySelector('[data-testid="tab-delete"]')?.click()`
          );
          await new Promise((resolve) => setTimeout(resolve, 500));

          try {
            const imgDel = await backupRestoreWindow.webContents.capturePage();
            fs.writeFileSync('C:/Users/Smart/.gemini/antigravity/brain/2a03772e-fcab-490a-985a-d9b6300b97b7/screen_delete_tab.png', imgDel.toPNG());
            console.log('[smoke] Saved screen_delete_tab.png');
          } catch (e) {
            console.log('[smoke] Failed to save screen_delete_tab.png:', e.message);
          }

          backupRestoreWindow.close();
        } else {
          console.log('[smoke] backupRestoreWindow not detected');
        }

        await new Promise((resolve) => setTimeout(resolve, 600));

        // 10e. Verify "Tool" Menu options (Browser Check removed)
        await win.webContents.executeJavaScript(
          `document.querySelector('[data-testid="tool-module-button"]')?.click()`
        );
        await new Promise((resolve) => setTimeout(resolve, 400));

        const toolsDom = await win.webContents.executeJavaScript(
          `(() => {
            const history = document.querySelector('[data-testid="btn-history-option"]');
            const proxy = document.querySelector('[data-testid="btn-add-proxy-option"]');
            const cookie = document.querySelector('[data-testid="btn-cookie-delete-option"]');
            const version = document.querySelector('[data-testid="btn-version-check-option"]');
            const backup = document.querySelector('[data-testid="btn-backup-restore-option"]');
            const browserCheck = document.querySelector('[data-testid="btn-browser-check-option"]');

            return {
              ok: Boolean(history && proxy && cookie && version && backup && !browserCheck),
              browserCheckRemoved: !browserCheck,
              hasHistory: Boolean(history),
              hasProxy: Boolean(proxy),
              hasCookie: Boolean(cookie),
              hasVersion: Boolean(version),
              hasBackup: Boolean(backup),
            };
          })()`
        );
        console.log('[smoke] toolsDom:', JSON.stringify(toolsDom));

        try {
          const imgTools = await win.webContents.capturePage();
          fs.writeFileSync('C:/Users/Smart/.gemini/antigravity/brain/2a03772e-fcab-490a-985a-d9b6300b97b7/screen_dashboard_tools.png', imgTools.toPNG());
          console.log('[smoke] Saved screen_dashboard_tools.png');
        } catch (e) {
          console.log('[smoke] Failed to save screen_dashboard_tools.png:', e.message);
        }

        // Close dropdown
        await win.webContents.executeJavaScript(
          `document.querySelector('[data-testid="tool-module-button"]')?.click()`
        );
        await new Promise((resolve) => setTimeout(resolve, 400));

        // 10e2. Test Open Ticket Detail Screen (media_1789660957910.png)
        createTicketWebSelectWindow({
          id: 1,
          ticketName: 'NDLS_CSMT',
          fromStation: 'NDLS',
          toStation: 'CSMT',
          trainNumber: '12138',
          selectedClass: '3A',
          quota: 'Tatkal',
          journeyDate: '2026-07-24',
          slotSelection: 'S1',
          irctcUserId: 'Rafe2957',
          paymentMethod: 'SBI - UPI QR',
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));

        if (ticketWebSelectWindow && !ticketWebSelectWindow.isDestroyed()) {
          const twsSize = ticketWebSelectWindow.getSize();
          console.log('[smoke] ticketWebSelectWindowProps:', JSON.stringify({
            width: twsSize[0],
            height: twsSize[1],
            title: ticketWebSelectWindow.getTitle(),
          }));

          const twsDom = await ticketWebSelectWindow.webContents.executeJavaScript(
            `(() => {
              const title = document.querySelector('[data-testid="tws-ticket-title"]');
              const timer = document.querySelector('[data-testid="tws-booking-timer"]');
              const fromInput = document.querySelector('[data-testid="field-from-station"]');
              const toInput = document.querySelector('[data-testid="field-to-station"]');
              const trainInput = document.querySelector('[data-testid="field-train-number"]');
              const classInput = document.querySelector('[data-testid="field-class"]');
              const quotaInput = document.querySelector('[data-testid="field-quota"]');
              const dateInput = document.querySelector('[data-testid="field-journey-date"]');
              const slotInput = document.querySelector('[data-testid="field-slot"]');
              const irctcIdInput = document.querySelector('[data-testid="field-irctc-id"]');
              const paymentInput = document.querySelector('[data-testid="field-payment-method"]');
              const loginBtn = document.querySelector('[data-testid="btn-login-web"]');

              return {
                ok: Boolean(title && timer && fromInput && toInput && trainInput && classInput && quotaInput && dateInput && slotInput && irctcIdInput && paymentInput && loginBtn),
                titleText: title ? title.textContent.trim() : null,
                timerText: timer ? timer.textContent.trim() : null,
                fromVal: fromInput ? fromInput.value : null,
                fromDisabled: fromInput ? fromInput.disabled : false,
                toVal: toInput ? toInput.value : null,
                toDisabled: toInput ? toInput.disabled : false,
                trainVal: trainInput ? trainInput.value : null,
                classVal: classInput ? classInput.value : null,
                quotaVal: quotaInput ? quotaInput.value : null,
                dateVal: dateInput ? dateInput.value : null,
                slotVal: slotInput ? slotInput.value : null,
                irctcIdVal: irctcIdInput ? irctcIdInput.value : null,
                paymentVal: paymentInput ? paymentInput.value : null,
                hasLoginBtn: Boolean(loginBtn),
              };
            })()`
          );
          console.log('[smoke] twsDom:', JSON.stringify(twsDom));

          try {
            const imgTws = await ticketWebSelectWindow.webContents.capturePage();
            fs.writeFileSync('C:/Users/Smart/.gemini/antigravity/brain/2a03772e-fcab-490a-985a-d9b6300b97b7/screen_open_ticket.png', imgTws.toPNG());
            console.log('[smoke] Saved screen_open_ticket.png');
          } catch (e) {
            console.log('[smoke] Failed to save screen_open_ticket.png:', e.message);
          }

          // Click "Login (Web)" -> Opens Browser Selection Modal
          await ticketWebSelectWindow.webContents.executeJavaScript(
            `document.querySelector('[data-testid="btn-login-web"]')?.click()`
          );
          await new Promise((resolve) => setTimeout(resolve, 500));

          const modalDom = await ticketWebSelectWindow.webContents.executeJavaScript(
            `(() => {
              const modal = document.querySelector('[data-testid="browser-selection-modal"]');
              const chrome = document.querySelector('[data-testid="btn-select-browser-chrome"]');
              const edge = document.querySelector('[data-testid="btn-select-browser-edge"]');
              const brave = document.querySelector('[data-testid="btn-select-browser-brave"]');
              const opera = document.querySelector('[data-testid="btn-select-browser-opera"]');
              const comet = document.querySelector('[data-testid="btn-select-browser-comet"]');

              return {
                ok: Boolean(modal && chrome && edge && brave && opera && comet),
                hasModal: Boolean(modal),
                hasChrome: Boolean(chrome),
                hasEdge: Boolean(edge),
                hasBrave: Boolean(brave),
                hasOpera: Boolean(opera),
                hasComet: Boolean(comet),
              };
            })()`
          );
          console.log('[smoke] browserModalDom:', JSON.stringify(modalDom));

          try {
            const imgModal = await ticketWebSelectWindow.webContents.capturePage();
            fs.writeFileSync('C:/Users/Smart/.gemini/antigravity/brain/2a03772e-fcab-490a-985a-d9b6300b97b7/screen_open_ticket_browser_modal.png', imgModal.toPNG());
            console.log('[smoke] Saved screen_open_ticket_browser_modal.png');
          } catch (e) {
            console.log('[smoke] Failed to save screen_open_ticket_browser_modal.png:', e.message);
          }

          // Select Chrome -> launches browser, closes modal, transitions to Start Booking
          await ticketWebSelectWindow.webContents.executeJavaScript(
            `document.querySelector('[data-testid="btn-select-browser-chrome"]')?.click()`
          );
          await new Promise((resolve) => setTimeout(resolve, 600));

          // Start Booking
          await ticketWebSelectWindow.webContents.executeJavaScript(
            `document.querySelector('[data-testid="btn-toggle-booking"]')?.click()`
          );
          // Let timer tick for 1.2s
          await new Promise((resolve) => setTimeout(resolve, 1200));

          // Stop Booking
          await ticketWebSelectWindow.webContents.executeJavaScript(
            `document.querySelector('[data-testid="btn-toggle-booking"]')?.click()`
          );
          await new Promise((resolve) => setTimeout(resolve, 500));

          try {
            const imgStopped = await ticketWebSelectWindow.webContents.capturePage();
            fs.writeFileSync('C:/Users/Smart/.gemini/antigravity/brain/2a03772e-fcab-490a-985a-d9b6300b97b7/screen_open_ticket_booking_stopped.png', imgStopped.toPNG());
            console.log('[smoke] Saved screen_open_ticket_booking_stopped.png');
          } catch (e) {
            console.log('[smoke] Failed to save screen_open_ticket_booking_stopped.png:', e.message);
          }

          ticketWebSelectWindow.close();
        } else {
          console.log('[smoke] ticketWebSelectWindow not detected');
        }

        await new Promise((resolve) => setTimeout(resolve, 600));

        // 10f. Click "Tool" -> "Cookie Delete"
        await win.webContents.executeJavaScript(
          `document.querySelector('[data-testid="tool-module-button"]')?.click()`
        );
        await new Promise((resolve) => setTimeout(resolve, 400));

        await win.webContents.executeJavaScript(
          `document.querySelector('[data-testid="btn-cookie-delete-option"]')?.click()`
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));

        if (cookieDeleteWindow && !cookieDeleteWindow.isDestroyed()) {
          const cdSize = cookieDeleteWindow.getSize();
          console.log('[smoke] cookieDeleteWindowProps:', JSON.stringify({
            width: cdSize[0],
            height: cdSize[1],
            title: cookieDeleteWindow.getTitle(),
          }));

          const cdDom = await cookieDeleteWindow.webContents.executeJavaScript(
            `(() => {
              const btnClear = document.querySelector('[data-testid="btn-execute-cookie-delete"]');
              const btnClose = document.querySelector('[data-testid="btn-close-cookie-window"]');
              return {
                ok: Boolean(btnClear && btnClose),
                hasBtnClear: Boolean(btnClear),
                hasBtnClose: Boolean(btnClose),
              };
            })()`
          );
          console.log('[smoke] cookieDeleteDom:', JSON.stringify(cdDom));

          // Click Execute Clear Cookies
          await cookieDeleteWindow.webContents.executeJavaScript(
            `document.querySelector('[data-testid="btn-execute-cookie-delete"]')?.click()`
          );
          await new Promise((resolve) => setTimeout(resolve, 800));

          try {
            const imgCd = await cookieDeleteWindow.webContents.capturePage();
            fs.writeFileSync('C:/Users/Smart/.gemini/antigravity/brain/2a03772e-fcab-490a-985a-d9b6300b97b7/screen_cookie_delete.png', imgCd.toPNG());
            console.log('[smoke] Saved screen_cookie_delete.png');
          } catch (e) {
            console.log('[smoke] Failed to save screen_cookie_delete.png:', e.message);
          }

          cookieDeleteWindow.close();
        } else {
          console.log('[smoke] cookieDeleteWindow not detected');
        }

        await new Promise((resolve) => setTimeout(resolve, 600));

        // 10g. Click "Tool" -> "Software Version Check"
        await win.webContents.executeJavaScript(
          `document.querySelector('[data-testid="tool-module-button"]')?.click()`
        );
        await new Promise((resolve) => setTimeout(resolve, 400));

        await win.webContents.executeJavaScript(
          `document.querySelector('[data-testid="btn-version-check-option"]')?.click()`
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));

        if (versionCheckWindow && !versionCheckWindow.isDestroyed()) {
          const vcSize = versionCheckWindow.getSize();
          console.log('[smoke] versionCheckWindowProps:', JSON.stringify({
            width: vcSize[0],
            height: vcSize[1],
            title: versionCheckWindow.getTitle(),
          }));

          const vcDom = await versionCheckWindow.webContents.executeJavaScript(
            `(() => {
              const btnUpdate = document.querySelector('[data-testid="btn-check-version-update"]');
              const btnClose = document.querySelector('[data-testid="btn-close-version-window"]');
              return {
                ok: Boolean(btnUpdate && btnClose),
                hasBtnUpdate: Boolean(btnUpdate),
                hasBtnClose: Boolean(btnClose),
              };
            })()`
          );
          console.log('[smoke] versionCheckDom:', JSON.stringify(vcDom));

          // Click Check For Updates
          await versionCheckWindow.webContents.executeJavaScript(
            `document.querySelector('[data-testid="btn-check-version-update"]')?.click()`
          );
          await new Promise((resolve) => setTimeout(resolve, 800));

          try {
            const imgVc = await versionCheckWindow.webContents.capturePage();
            fs.writeFileSync('C:/Users/Smart/.gemini/antigravity/brain/2a03772e-fcab-490a-985a-d9b6300b97b7/screen_software_version.png', imgVc.toPNG());
            console.log('[smoke] Saved screen_software_version.png');
          } catch (e) {
            console.log('[smoke] Failed to save screen_software_version.png:', e.message);
          }

          versionCheckWindow.close();
        } else {
          console.log('[smoke] versionCheckWindow not detected');
        }

      } else {
        console.log('[smoke] accountWindow not detected');
      }
    } catch (error) {
      console.log('[smoke] check error:', error && error.message);
    } finally {
      setTimeout(() => app.exit(0), 500);
    }
  };

  setTimeout(runChecks, 1500);
}

