import { join } from 'node:path'
import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from 'electron'
import type { Events } from '@shared/types'
import { emit, setEventTarget } from './core/events'
import { log } from './core/log'
import { resolveUserPath } from './core/shell'
import { registerIpc, setCategory } from './ipc'
import { issueAgent, setOnBranchCreated } from './services/issueAgent'
import { chatAgent } from './services/chatAgent'
import { trayActivity } from './core/trayAnimation'
import * as ptyHost from './services/ptyHost'
import { cleanupAll, startReconcileLoop } from './services/processManager'

let window: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    show: false,
    title: 'TeaBranch',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  setEventTarget(window)

  window.once('ready-to-show', () => window?.show())
  // Development only: the renderer's console and load failures, in the terminal that started us.
  if (!app.isPackaged) {
    window.webContents.on('console-message', (event) => log.info(`renderer ${event.level}: ${event.message}`))
    window.webContents.on('preload-error', (_event, path, error) => log.warn(`preload ${path}: ${String(error)}`))
    window.webContents.on('did-fail-load', (_event, code, description) => log.warn(`load failed ${code}: ${description}`))
  }
  // Closing hides: dev servers keep running, and the window comes back from the dock or tray.
  window.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    window?.hide()
  })
  // Links open in the browser, never inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

function showWindow(): void {
  if (!window) createWindow()
  window?.show()
  window?.focus()
}

const sendMenu = (action: Events['menu']): void => {
  showWindow()
  emit('menu', action)
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: 'Settings…', accelerator: 'Cmd+,', click: () => sendMenu('settings') },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'File',
        submenu: [{ label: 'New Branch…', accelerator: 'Cmd+N', click: () => sendMenu('newBranch') }],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { label: 'Branches', accelerator: 'Cmd+1', click: () => sendMenu('showBranches') },
          { label: 'Issues', accelerator: 'Cmd+2', click: () => sendMenu('showIssues') },
          { type: 'separator' },
          { label: 'Terminal', accelerator: 'Cmd+J', click: () => sendMenu('toggleTerminal') },
          { label: 'New Terminal', accelerator: 'Cmd+`', click: () => sendMenu('newTerminal') },
          { type: 'separator' },
          { role: 'reload' },
          { role: 'toggleDevTools' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  )
}

function buildTray(): void {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'trayTemplate@2x.png')
    : join(__dirname, '../../resources/trayTemplate@2x.png')
  const image = nativeImage.createFromPath(iconPath)
  image.setTemplateImage(true)
  tray = new Tray(image)
  tray.setToolTip('TeaBranch')
  // Animate while any agent works; a once-a-second check is plenty for "started" and "stopped".
  const activity = trayActivity(tray, image)
  setInterval(() => activity(issueAgent.runningCount() + chatAgent.runningCount()), 1000)
  tray.on('click', () => (window?.isVisible() ? window.hide() : showWindow()))
  tray.on('right-click', () =>
    tray?.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show TeaBranch', click: showWindow },
        { type: 'separator' },
        { label: 'Quit TeaBranch', click: () => app.quit() },
      ]),
    ),
  )
}

void app.whenReady().then(async () => {
  await resolveUserPath()
  registerIpc()
  // A worktree an issue agent works in belongs in the "开发中" lane.
  setOnBranchCreated((branch) => {
    setCategory(branch, 'developing')
    emit('branchesChanged', undefined)
  })
  // Packaged, the bundle's icon.icns shows in the Dock; running from source it would be Electron's.
  if (!app.isPackaged) app.dock?.setIcon(join(__dirname, '../../resources/icon.png'))
  buildMenu()
  buildTray()
  createWindow()
  startReconcileLoop()
  log.info('ready')
})

app.on('activate', showWindow)

/**
 * Quitting kills dev servers — including ones adopted as orphans, by port. That is what makes
 * force-quit recovery work, and why this app shouldn't run alongside hand-started servers on the
 * same ports.
 */
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  issueAgent.flush()
  chatAgent.flush()
  ptyHost.killAll()
  void cleanupAll().finally(() => app.exit(0))
})
