'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  dialog,
  ipcMain,
  nativeTheme,
  session,
  shell,
} = require('electron');
const path = require('node:path');
const fsPromises = require('node:fs/promises');
const fsSync = require('node:fs');

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
      // Debounced localStorage writes are delayed by Chromium's background
      // timer throttling when the window is hidden, which can postpone a
      // pending save for a long time. Nothing in this app benefits from
      // throttling, so turn it off for reliable persistence.
      backgroundThrottling: false,
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

function sendToWindow(channel) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel);
  }
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Export board (JSON)…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendToWindow('menu:export-board'),
        },
        {
          label: 'Import board (JSON)…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => sendToWindow('menu:import-board'),
        },
        { type: 'separator' },
        { label: 'Exit', accelerator: 'Alt+F4', click: () => app.quit() },
      ],
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

/* ---------- Board backup: export / import ---------- */

ipcMain.handle('board:export', async (_event, json) => {
  if (typeof json !== 'string' || !json) return { ok: false, cancelled: true };
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export board',
    defaultPath: `kanban-board-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'Board backup (JSON)', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
  try {
    await fsPromises.writeFile(result.filePath, json, 'utf8');
    return { ok: true, path: result.filePath };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('board:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import board',
    filters: [{ name: 'Board backup (JSON)', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, cancelled: true };
  try {
    const json = await fsPromises.readFile(result.filePaths[0], 'utf8');
    return { ok: true, json };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Native toast for due/overdue repos. Shown once per day from the renderer.
ipcMain.handle('notify-due', (_event, payload) => {
  if (!Notification.isSupported()) return false;
  const count = Number(payload?.count) || 0;
  if (count <= 0) return false;
  const items = Array.isArray(payload.items) ? payload.items.filter((item) => typeof item === 'string') : [];
  new Notification({
    title: count === 1 ? '1 repo is due' : `${count} repos are due or overdue`,
    body: items.slice(0, 5).join('\n') + (count > 5 ? `\n…and ${count - 5} more` : ''),
    silent: false,
  }).show();
  return true;
});

// GitHub API integration — fetch repos for a username.
const GITHUB_USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_MAX_PAGES = 10; // 10 × 100 = 1000 repos, enough for any account

/* ---------- GitHub OAuth device flow (private repo import) ----------
   The client secret never touches disk: device flow only needs the
   Client ID. The access token is stored in the userData folder, which
   lives outside the repository. */

const GH_TOKEN_FILE = () => path.join(app.getPath('userData'), 'gh-token.json');
const GH_DEVICE_SCOPE = 'repo read:user';

function readGhToken() {
  try {
    const raw = JSON.parse(fsSync.readFileSync(GH_TOKEN_FILE(), 'utf8'));
    return typeof raw.access_token === 'string' && raw.access_token ? raw : null;
  } catch {
    return null;
  }
}

function writeGhToken(data) {
  fsSync.writeFileSync(GH_TOKEN_FILE(), JSON.stringify(data), 'utf8');
}

ipcMain.handle('ghauth:get-config', () => {
  const token = readGhToken();
  return {
    clientId: process.env.GITHUB_CLIENT_ID ?? '',
    connected: Boolean(token),
    login: token?.login ?? '',
    tokenSource: process.env.GITHUB_CLIENT_ID ? 'env' : 'none',
  };
});

ipcMain.handle('ghauth:set-client-id', (_event, clientId) => {
  const clean = typeof clientId === 'string' ? clientId.trim() : '';
  if (!/^[A-Za-z0-9]{16,25}$/.test(clean)) {
    throw new Error('That does not look like a GitHub Client ID (expected ~20 characters).');
  }
  // Kept in userData next to the token; not committed with the repo.
  fsSync.writeFileSync(
    path.join(app.getPath('userData'), 'gh-client-id.txt'),
    clean,
    'utf8'
  );
  return { ok: true };
});

function readGhClientId() {
  try {
    const value = fsSync
      .readFileSync(path.join(app.getPath('userData'), 'gh-client-id.txt'), 'utf8')
      .trim();
    return /^[A-Za-z0-9]{16,25}$/.test(value) ? value : '';
  } catch {
    return '';
  }
}

ipcMain.handle('ghauth:start', async () => {
  const clientId = process.env.GITHUB_CLIENT_ID || readGhClientId();
  if (!clientId) {
    throw new Error('Set your GitHub OAuth Client ID first.');
  }
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      scope: GH_DEVICE_SCOPE,
    }),
  });
  if (!res.ok) {
    throw new Error(`GitHub device flow failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verifyUri: data.verification_uri,
    interval: Math.max(data.interval ?? 5, 3),
    expiresIn: data.expires_in ?? 900,
  };
});

ipcMain.handle('ghauth:poll', async (_event, deviceCode) => {
  const clientId = process.env.GITHUB_CLIENT_ID || readGhClientId();
  if (!clientId || typeof deviceCode !== 'string' || !deviceCode) {
    throw new Error('No device login in progress.');
  }
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  if (!res.ok) {
    throw new Error(`GitHub token poll failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (data.error === 'authorization_pending') return { status: 'pending' };
  if (data.error === 'slow_down') return { status: 'slow' };
  if (data.error === 'expired_token') return { status: 'expired' };
  if (data.error) {
    throw new Error(`GitHub auth error: ${data.error}`);
  }
  if (!data.access_token) {
    throw new Error('GitHub did not return an access token.');
  }

  // Identify the account so the UI can show who is connected.
  let login = '';
  try {
    const me = await fetch('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `token ${data.access_token}`,
        'User-Agent': 'Kanban-Repo-Cards',
      },
    });
    if (me.ok) login = (await me.json()).login ?? '';
  } catch {
    /* login label is optional */
  }

  writeGhToken({ access_token: data.access_token, login });
  return { status: 'ok', login };
});

ipcMain.handle('ghauth:signout', () => {
  try {
    fsSync.rmSync(GH_TOKEN_FILE());
  } catch {
    /* already gone */
  }
  return { ok: true };
});

ipcMain.handle(
  'github:fetch-repos',
  async (_event, username) => {
    const handle = typeof username === 'string' ? username.trim() : '';
    if (!GITHUB_USERNAME.test(handle)) {
      throw new Error('Enter a valid GitHub username.');
    }

    const token = process.env.GITHUB_TOKEN;
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Kanban-Repo-Cards',
    };
    if (token) {
      headers.Authorization = `token ${token}`;
    }

    // Page through the account so repos beyond the first 100 are included.
    const allRepos = [];
    for (let page = 1; page <= GITHUB_MAX_PAGES; page += 1) {
      const url = `https://api.github.com/users/${encodeURIComponent(handle)}/repos?per_page=100&sort=pushed&page=${page}`;
      const res = await fetch(url, { headers });
      if (res.status === 404) {
        throw new Error(`No GitHub account named "${handle}" was found — check the column's GitHub username.`);
      }
      if (!res.ok) {
        throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
      }
      const batch = await res.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      allRepos.push(...batch);
      if (batch.length < 100) break; // last page
    }
    return allRepos;
  }
);

// Authenticated variant: uses the device-flow token, so private repos of the
// connected account are included in the import.
ipcMain.handle('github:fetch-repos-auth', async (_event, username) => {
  const handle = typeof username === 'string' ? username.trim() : '';
  if (!GITHUB_USERNAME.test(handle)) {
    throw new Error('Enter a valid GitHub username.');
  }
  const token = readGhToken();
  if (!token) {
    throw new Error('Connect GitHub first to import private repos.');
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `token ${token.access_token}`,
    'User-Agent': 'Kanban-Repo-Cards',
  };

  const allRepos = [];
  for (let page = 1; page <= GITHUB_MAX_PAGES; page += 1) {
    const url = `https://api.github.com/user/repos?per_page=100&sort=pushed&type=owner&page=${page}&affiliation=owner`;
    const res = await fetch(url, { headers });
    if (res.status === 401) {
      throw new Error('Your GitHub connection expired — sign in again.');
    }
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    allRepos.push(...batch);
    if (batch.length < 100) break;
  }
  return allRepos.filter(
    (repo) => typeof repo?.html_url === 'string' && repo.html_url.toLowerCase().includes(`/${handle}/`)
  );
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
