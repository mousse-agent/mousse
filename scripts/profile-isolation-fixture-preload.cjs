const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('fixturePlatform', {
  request: async () => {
    const response = await ipcRenderer.invoke('fixture:platform-request')
    if (response?.ok) return response.value
    throw { name: 'PlatformRequestError', code: response?.error?.code || 'platform_invalid_response', message: response?.error?.message || 'Platform request failed', details: response?.error?.details }
  }
})
