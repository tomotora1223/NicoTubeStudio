const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nicotube', {
  getApiBase: () => ipcRenderer.invoke('get-api-base'),
  openYoutubeLogin: () => ipcRenderer.invoke('open-youtube-login'),
  clearYoutubeLogin: () => ipcRenderer.invoke('clear-youtube-login'),
  selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),
  selectCookiesFile: () => ipcRenderer.invoke('select-cookies-file'),
  showInFolder: (targetPath) => ipcRenderer.invoke('show-in-folder', targetPath),
  openPath: (targetPath) => ipcRenderer.invoke('open-path', targetPath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getAppUpdateStatus: () => ipcRenderer.invoke('get-app-update-status'),
  checkAppUpdate: (feedUrl) => ipcRenderer.invoke('check-app-update', feedUrl),
  installAppUpdate: () => ipcRenderer.invoke('install-app-update'),
  onAuthUpdated: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('auth-updated', handler)
    return () => ipcRenderer.removeListener('auth-updated', handler)
  },
  onAppUpdateStatus: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('app-update-status', handler)
    return () => ipcRenderer.removeListener('app-update-status', handler)
  },
})
