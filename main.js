'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  nativeTheme,
  session,
  shell,
} = require('electron');
const path = require('node:path');

const APP_ID = 'com.mikedaniel.kanbanrepocards';
const APP_NAME = 'Kanban Repo Cards';
const isDev = !app.isPackaged;

// Keep test runs isolated from the real profile.
if (process.env.KANBAN_USERDATA) {
  app.setPath('userData', process.env.KANBAN_USERDATA);
}

app.setName(APP_NAME);
// Store builds must keep the package identity's AUMID; only standalone builds
// need an explicit one for taskbar/notification grouping.
if (!process.windowsStore) {
  app.setAppUserModelId(APP_ID);
}

let mainWindow = null;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(start);
}

function start() {
  // The app needs no device permissions at all.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function windowIcon() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, 'build', 'icon.ico');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    icon: windowIcon(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#080d18' : '#eef2f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Never open arbitrary pages inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      openExternal(url);
    }
  });
}

function openExternal(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    shell.openExternal(url.toString());
    return true;
  } catch {
    return false;
  }
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: `About ${APP_NAME}`,
    message: `${APP_NAME} ${app.getVersion()}`,
    detail: [
      'A four-account repository board with local notes and checklists.',
      '',
      `Electron ${process.versions.electron}`,
      `Chromium ${process.versions.chrome}`,
      `Node.js ${process.versions.node}`,
      '',
      process.windowsStore ? 'Microsoft Store build' : 'Standalone build',
      'All data is stored locally on this device.',
    ].join('\n'),
    buttons: ['OK'],
    defaultId: 0,
    noLink: true,
  });
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [{ label: 'Exit', accelerator: 'Alt+F4', click: () => app.quit() }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(isDev ? [{ role: 'toggleDevTools' }] : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [{ label: `About ${APP_NAME}`, click: showAbout }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('open-external', (_event, url) => ({ ok: openExternal(url) }));

ipcMain.handle('app-info', () => ({
  name: app.getName(),
  version: app.getVersion(),
  electron: process.versions.electron,
  store: Boolean(process.windowsStore),
}));

// GitHub API integration — fetch repos for a username.
const GITHUB_USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

ipcMain.handle(
  'github:fetch-repos',
  async (_event, username) => {
    const handle = typeof username === 'string' ? username.trim() : '';
    if (!GITHUB_USERNAME.test(handle)) {
      throw new Error('Enter a valid GitHub username.');
    }

    const token = process.env.GITHUB_TOKEN;
    const url = `https://api.github.com/users/${encodeURIComponent(handle)}/repos?per_page=100&sort=pushed`;
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Kanban-Repo-Cards',
    };
    if (token) {
      headers.Authorization = `token ${token}`;
    }

    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
    }
    return res.json();
  }
);

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
