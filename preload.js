'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /** Open an http(s) link in the user's default browser. Returns { ok }. */
  openExternal: (url) => ipcRenderer.invoke('open-external', String(url)),
  /** Name, version and Store/standalone information for the current build. */
  appInfo: () => ipcRenderer.invoke('app-info'),
  /** Import public GitHub repos for the selected account when the user asks. */
  fetchGithubRepos: (username) =>
    ipcRenderer.invoke('github:fetch-repos', String(username)),
  /** Write a board backup JSON string to a user-chosen file. */
  exportBoard: (json) => ipcRenderer.invoke('board:export', String(json)),
  /** Ask the user for a board backup file; resolves { ok, json }. */
  importBoard: () => ipcRenderer.invoke('board:import'),
  /** File-menu triggers: export/import board backup. */
  onMenuExport: (callback) => ipcRenderer.on('menu:export-board', () => callback()),
  onMenuImport: (callback) => ipcRenderer.on('menu:import-board', () => callback()),
  /** Show a native Windows toast for due/overdue repos. */
  notifyDue: (payload) => ipcRenderer.invoke('notify-due', payload),
});
