const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const fs = require('fs')
const net = require('net')
const { spawn } = require('child_process')
const http = require('http')

// Improve Google Sign-In compatibility inside Electron BrowserWindow
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')

const ROOT_DIR = path.resolve(__dirname, '..')
const BACKEND_DIR = path.join(ROOT_DIR, 'backend')
const VENV_PYTHON = path.join(BACKEND_DIR, '.venv', 'Scripts', 'python.exe')
const isDev = process.argv.includes('--dev')

let mainWindow = null
let authWindow = null
let backendProcess = null
let apiPort = 18742

function findFreePort(startPort = 18742) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', () => resolve(findFreePort(startPort + 1)))
    srv.listen(startPort, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

function waitForBackend(port, retries = 45) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        if (res.statusCode === 200) {
          resolve(true)
        } else if (left > 0) {
          setTimeout(() => attempt(left - 1), 250)
        } else {
          reject(new Error('Backend health check failed'))
        }
      })
      req.on('error', () => {
        if (left > 0) {
          setTimeout(() => attempt(left - 1), 250)
        } else {
          reject(new Error('Backend failed to start'))
        }
      })
      req.end()
    }
    attempt(retries)
  })
}

async function startBackend() {
  apiPort = await findFreePort(18742)
  const env = {
    ...process.env,
    NICOTUBE_PORT: String(apiPort),
  }

  let cmd
  let args
  let cwd

  if (app.isPackaged) {
    const resDir = process.resourcesPath
    const bundledBin = path.join(resDir, 'bin')
    const userBin = path.join(app.getPath('userData'), 'backend_data', 'bin')
    cmd = path.join(resDir, 'backend', 'nicotube-backend.exe')
    args = []
    cwd = path.join(resDir, 'backend')
    env.NICOTUBE_DATA_DIR = path.join(app.getPath('userData'), 'backend_data')
    env.NICOTUBE_BUNDLED_BIN_DIR = bundledBin
    env.PATH = `${userBin}${path.delimiter}${bundledBin}${path.delimiter}${env.PATH || ''}`
  } else {
    const devBin = path.join(BACKEND_DIR, 'bin')
    cmd = VENV_PYTHON
    args = [path.join(BACKEND_DIR, 'run_backend.py')]
    cwd = BACKEND_DIR
    env.PATH = `${devBin}${path.delimiter}${env.PATH || ''}`
  }

  backendProcess = spawn(cmd, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  backendProcess.stdout.on('data', (d) => {
    if (process.env.DEBUG_BACKEND) process.stdout.write(`[py] ${d}`)
  })
  backendProcess.stderr.on('data', (d) => {
    if (process.env.DEBUG_BACKEND) process.stderr.write(`[py] ${d}`)
  })

  await waitForBackend(apiPort)
}

function stopBackend() {
  if (backendProcess && !backendProcess.killed) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(backendProcess.pid), '/f', '/t'], { windowsHide: true })
      } else {
        backendProcess.kill('SIGTERM')
      }
    } catch (_) {}
    backendProcess = null
  }
}

function cookiesToNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Exported by NicoTube Studio']
  for (const c of cookies) {
    const domain = c.domain || ''
    const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE'
    const cPath = c.path || '/'
    const secure = c.secure ? 'TRUE' : 'FALSE'
    const exp = c.expirationDate ? Math.floor(c.expirationDate) : Math.floor(Date.now() / 1000 + 86400 * 365)
    lines.push(`${domain}\t${includeSub}\t${cPath}\t${secure}\t${exp}\t${c.name}\t${c.value}`)
  }
  return lines.join('\n') + '\n'
}

async function syncAuthCookiesToBackend() {
  const ses = session.fromPartition('persist:yt_auth')
  const cookies = await ses.cookies.get({})
  const ytCookies = cookies.filter(
    (c) =>
      c.domain.includes('youtube.com') ||
      c.domain.includes('google.com') ||
      c.domain.includes('googleusercontent.com')
  )
  const netscapeText = cookiesToNetscape(ytCookies)

  await new Promise((resolve, reject) => {
    const body = JSON.stringify({ netscape_text: netscapeText, source: 'builtin_browser' })
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: apiPort,
        path: '/api/auth/cookies',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.on('data', () => {})
        res.on('end', resolve)
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })

  const hasAuth = ytCookies.some((c) => ['SAPISID', '__Secure-3PSID', 'LOGIN_INFO'].includes(c.name))
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('auth-updated', { hasAuth, count: ytCookies.length })
  }
  return { hasAuth, count: ytCookies.length }
}

function openYoutubeLoginWindow() {
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.focus()
    return
  }

  const ses = session.fromPartition('persist:yt_auth')
  const cleanUA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
  ses.setUserAgent(cleanUA)

  authWindow = new BrowserWindow({
    width: 980,
    height: 760,
    parent: mainWindow || undefined,
    title: 'Google / YouTube アカウントログイン — 完了後ウィンドウを閉じてください',
    backgroundColor: '#141415',
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:yt_auth',
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  authWindow.webContents.setUserAgent(cleanUA)
  authWindow.loadURL(
    'https://accounts.google.com/ServiceLogin?service=youtube&passive=true&continue=https%3A%2F%2Fwww.youtube.com%2F'
  )

  authWindow.webContents.on('did-navigate', async (_event, url) => {
    if (url.startsWith('https://www.youtube.com')) {
      try {
        const res = await syncAuthCookiesToBackend()
        if (res.hasAuth) {
          authWindow.setTitle('YouTubeログイン完了 — Cookieを保存しました (このウィンドウは閉じられます)')
        }
      } catch (_) {}
    }
  })

  authWindow.on('closed', async () => {
    try {
      await syncAuthCookiesToBackend()
    } catch (_) {}
    authWindow = null
  })
}

function createMainWindow() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(ROOT_DIR, 'build', 'icon.ico')
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#141415',
    title: 'NicoTube Studio',
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const devUrl = 'http://127.0.0.1:5173'
  if (isDev && !process.env.FORCE_PROD_UI) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(path.join(ROOT_DIR, 'dist-ui', 'index.html'))
  }
}

ipcMain.handle('get-api-base', () => `http://127.0.0.1:${apiPort}`)

ipcMain.handle('open-youtube-login', () => {
  openYoutubeLoginWindow()
  return true
})

ipcMain.handle('clear-youtube-login', async () => {
  const ses = session.fromPartition('persist:yt_auth')
  await ses.clearStorageData()
  return true
})

ipcMain.handle('select-output-dir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: '保存先フォルダを選択',
  })
  return res.canceled ? null : res.filePaths[0]
})

ipcMain.handle('select-cookies-file', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Cookies Text', extensions: ['txt'] }],
    title: 'cookies.txt を選択',
  })
  return res.canceled ? null : res.filePaths[0]
})

ipcMain.handle('show-in-folder', (_event, targetPath) => {
  if (targetPath) shell.showItemInFolder(targetPath)
})

ipcMain.handle('open-path', (_event, targetPath) => {
  if (targetPath) shell.openPath(targetPath)
})

ipcMain.handle('open-external', (_event, url) => {
  if (url) shell.openExternal(url)
})

ipcMain.handle('get-app-version', () => app.getVersion())

const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE)

let appUpdateState = {
  state: 'idle',
  version: app.getVersion(),
  message: isPortable ? 'ポータブル版（Setup版で自動更新可）' : '待機中',
  progress: 0,
}

function sendAppUpdateState(patch) {
  appUpdateState = { ...appUpdateState, ...patch }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-update-status', appUpdateState)
  }
}

function fetchBackendSettings() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${apiPort}/api/settings`, { timeout: 2000 }, (res) => {
      let raw = ''
      res.on('data', (chunk) => {
        raw += chunk
      })
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw))
        } catch (_) {
          resolve({})
        }
      })
    })
    req.on('error', () => resolve({}))
    req.on('timeout', () => {
      req.destroy()
      resolve({})
    })
  })
}

function parseUpdateFeed(rawUrl) {
  const value = String(rawUrl || '').trim().replace(/\/+$/, '')
  if (!value) return null
  const ghUrl = value.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i)
  if (ghUrl) {
    return { provider: 'github', owner: ghUrl[1], repo: ghUrl[2] }
  }
  const ghShort = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  if (ghShort) {
    return { provider: 'github', owner: ghShort[1], repo: ghShort[2] }
  }
  if (/^https?:\/\/.+/i.test(value)) {
    return value
  }
  return null
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = !isPortable
  autoUpdater.autoInstallOnAppQuit = !isPortable
  autoUpdater.allowDowngrade = false
  autoUpdater.autoRunAppAfterInstall = true

  autoUpdater.on('checking-for-update', () => {
    sendAppUpdateState({ state: 'checking', progress: 0, message: 'アプリの更新を確認中...' })
  })
  autoUpdater.on('update-available', (info) => {
    const ver = info?.version || app.getVersion()
    if (isPortable) {
      sendAppUpdateState({
        state: 'idle',
        version: ver,
        progress: 0,
        message: `v${ver} が公開されています（ポータブル版は手動差し替え）`,
      })
      return
    }
    sendAppUpdateState({
      state: 'downloading',
      version: ver,
      progress: 0,
      message: `v${ver} をダウンロード中...`,
    })
  })
  autoUpdater.on('update-not-available', () => {
    sendAppUpdateState({ state: 'latest', progress: 1, message: '最新バージョンです' })
  })
  autoUpdater.on('download-progress', (p) => {
    sendAppUpdateState({
      state: 'downloading',
      progress: (p?.percent || 0) / 100,
      message: `アップデートを取得中 (${Math.round(p?.percent || 0)}%)`,
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    sendAppUpdateState({
      state: 'ready',
      version: info?.version || app.getVersion(),
      progress: 1,
      message: `v${info?.version || ''} の準備完了（ウィザードなしで自動適用）`,
    })
  })
  autoUpdater.on('error', (err) => {
    const detail = String(err?.message || '').split('\n')[0].trim().slice(0, 80)
    sendAppUpdateState({
      state: 'error',
      progress: 0,
      message: detail ? `更新確認エラー: ${detail}` : '更新サーバー未設定またはオフライン',
    })
  })
}

async function checkForAppUpdates(overrideFeedUrl, { startup = false } = {}) {
  const settings = await fetchBackendSettings()
  if (startup && settings.auto_update_app === false) {
    sendAppUpdateState({ state: 'idle', message: '起動時の自動更新確認は無効です' })
    return appUpdateState
  }

  if (!app.isPackaged) {
    sendAppUpdateState({ state: 'latest', message: '開発モード (ローカルビルド)' })
    return appUpdateState
  }

  const rawFeed = typeof overrideFeedUrl === 'string' && overrideFeedUrl.trim()
    ? overrideFeedUrl
    : (settings.update_feed_url || '')
  const parsedFeed = parseUpdateFeed(rawFeed)
  const updateCfg = path.join(process.resourcesPath, 'app-update.yml')

  if (parsedFeed) {
    try {
      autoUpdater.setFeedURL(parsedFeed)
    } catch (err) {
      sendAppUpdateState({
        state: 'error',
        progress: 0,
        message: `更新先URLの形式が不正です: ${String(err?.message || err).slice(0, 60)}`,
      })
      return appUpdateState
    }
  } else if (!fs.existsSync(updateCfg)) {
    sendAppUpdateState({
      state: 'idle',
      progress: 0,
      message: '更新先URLまたはGitHubリポジトリを設定してください',
    })
    return appUpdateState
  }

  try {
    await autoUpdater.checkForUpdates()
  } catch (_) {}
  return appUpdateState
}

ipcMain.handle('get-app-update-status', () => appUpdateState)
ipcMain.handle('check-app-update', (_e, feedUrl) => checkForAppUpdates(feedUrl))
ipcMain.handle('install-app-update', () => {
  if (app.isPackaged && !isPortable) {
    stopBackend()
    setTimeout(() => {
      autoUpdater.quitAndInstall(true, true)
    }, 350)
  }
})

app.whenReady().then(async () => {
  setupAutoUpdater()
  try {
    await startBackend()
  } catch (err) {
    dialog.showErrorBox('起動エラー', `バックエンドエンジンの起動に失敗しました:\n${err.message}`)
  }
  createMainWindow()
  // Background auto-update check after UI loads
  setTimeout(() => {
    checkForAppUpdates(undefined, { startup: true }).catch(() => {})
  }, 4000)
})

app.on('window-all-closed', () => {
  stopBackend()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopBackend()
})
