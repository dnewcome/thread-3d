const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('artnet', {
  // Read model file from main process (avoids file:// fetch restrictions)
  readModelFile: () => ipcRenderer.invoke('read-model-file'),

  onLEDUpdate: (callback) => {
    ipcRenderer.on('led-update', (_event, colorsBuffer) => {
      callback(new Float32Array(colorsBuffer));
    });
  },
});
