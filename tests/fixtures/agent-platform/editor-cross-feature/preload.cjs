const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('editorBridge', {
  config: JSON.parse(process.env.MOUSSE_EDITOR_CROSS_CONFIG_JSON),
  request: (method, params) => ipcRenderer.invoke('editor-cross:request', { method, params })
})
