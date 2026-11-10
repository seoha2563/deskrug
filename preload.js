const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('deskApi', {
  setShape: r => ipcRenderer.send('set-shape', r),
  savePos: (x, y) => ipcRenderer.send('save-pos', { x, y }),
  ready: () => ipcRenderer.send('renderer-ready'),
  onCommand: cb => ipcRenderer.on('cmd', (_e, msg) => cb(msg)),
  log: m => ipcRenderer.send('log', String(m)),
});
