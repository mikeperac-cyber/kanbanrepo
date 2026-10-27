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
});
