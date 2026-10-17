const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  sources: () => ipcRenderer.invoke('sources'),
  get: () => ipcRenderer.invoke('get'),
  set: p => ipcRenderer.invoke('set', p),
  config: () => ipcRenderer.invoke('config'),
  pick: id => ipcRenderer.send('pick', id)
});
