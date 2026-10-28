import { join } from 'node:path'
import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from 'electron'
import { getLocale, t } from '@shared/i18n'
import type { Events } from '@shared/types'
import { emit, setEventTarget } from './core/events'
import { log } from './core/log'
import { resolveUserPath } from './core/shell'
import { registerIpc, setCategory } from './ipc'
import { issueAgent, setOnBranchCreated } from './services/issueAgent'
import { chatAgent } from './services/chatAgent'
import { trayActivity } from './core/trayAnimation'
import { applyLocale, onLocaleChange } from './core/locale'
import { state } from './core/appState'
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

/**
 * Labels are set on the role items too: Electron names those after the system language, which
 * would disagree with a language picked in Settings. Rebuilt when the language changes.
 */
function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about', label: t('关于 TeaBranch') },
          { type: 'separator' },
          { label: t('设置…'), accelerator: 'Cmd+,', click: () => sendMenu('settings') },
          { type: 'separator' },
          { role: 'hide', label: t('隐藏 TeaBranch') },
          { role: 'hideOthers', label: t('隐藏其他') },
          { role: 'unhide', label: t('全部显示') },
          { type: 'separator' },
          { role: 'quit', label: t('退出 TeaBranch') },
        ],
      },
      {
        // Not t('文件'): the issue views translate that key as “Files”.
        label: getLocale() === 'en' ? 'File' : '文件', // i18n-ignore
        submenu: [{ label: t('新建分支…'), accelerator: 'Cmd+N', click: () => sendMenu('newBranch') }],
      },
      {
        label: t('编辑'),
        submenu: [
          { role: 'undo', label: t('撤销') },
          { role: 'redo', label: t('重做') },
          { type: 'separator' },
          { role: 'cut', label: t('剪切') },
          { role: 'copy', label: t('拷贝') },
          { role: 'paste', label: t('粘贴') },
          { role: 'pasteAndMatchStyle', label: t('粘贴并匹配样式') },
          { role: 'delete', label: t('删除') },
          { role: 'selectAll', label: t('全选') },
        ],
      },
      {
        label: t('显示'),
        submenu: [
          { label: t('分支'), accelerator: 'Cmd+1', click: () => sendMenu('showBranches') },
          { label: 'Issues', accelerator: 'Cmd+2', click: () => sendMenu('showIssues') },
          { type: 'separator' },
          { label: t('终端'), accelerator: 'Cmd+J', click: () => sendMenu('toggleTerminal') },
          { label: t('新建终端'), accelerator: 'Cmd+`', click: () => sendMenu('newTerminal') },
          { type: 'separator' },
          { role: 'reload', label: t('重新载入') },
          { role: 'toggleDevTools', label: t('开发者工具') },
        ],
      },
      {
        role: 'windowMenu',
        label: t('窗口'),
        submenu: [
          { role: 'minimize', label: t('最小化') },
          { role: 'zoom', label: t('缩放') },
          { type: 'separator' },
          { role: 'front', label: t('前置全部窗口') },
        ],
      },
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
        { label: t('显示 TeaBranch'), click: showWindow },
        { type: 'separator' },
        { label: t('退出 TeaBranch'), click: () => app.quit() },
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
  applyLocale(state.settings.language)
  onLocaleChange(buildMenu)
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
  issueAgent.killAll()
  chatAgent.killAll()
  ptyHost.killAll()
  void cleanupAll().finally(() => app.exit(0))
})
