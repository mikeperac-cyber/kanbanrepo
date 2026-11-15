'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kanbanQuickAdd', {
  getColumns: () => ipcRenderer.invoke('quick-add:columns'),
  sendUrls: (urls, columnId) => ipcRenderer.invoke('quick-add:send', { urls, columnId }),
  close: () => ipcRenderer.invoke('quick-add:close'),
});
