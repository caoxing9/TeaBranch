import { Menu, Window } from 'nsh/desktop'
import { getLocale, t } from './shared/i18n'
import type { Events } from './shared/types'
import { emit } from './core/events'
import { log } from './core/log'
import { resolveUserPath } from './core/shell'
import { setCategory } from './api'
import { issueAgent, setOnBranchCreated } from './services/issueAgent'
import { chatAgent } from './services/chatAgent'
import { applyLocale, onLocaleChange } from './core/locale'
import { state } from './core/appState'
import * as ptyHost from './services/ptyHost'
import { cleanupAll, startReconcileLoop } from './services/processManager'
import { startBrowserBridge } from './services/browserBridge'
import * as autopilot from './services/autopilot'

/**
 * The app's life: what Electron's main process did at `whenReady` and `before-quit`, now called
 * by the UI's root when it mounts and when the window goes.
 */

let booted = false
let quitting = false

const sendMenu = (action: Events['menu']): void => {
  Window.orderFront()
  emit('menu', action)
}

/**
 * Labels are set on the role items too: the system names those after its own language, which
 * would disagree with a language picked in Settings. Rebuilt when the language changes.
 */
function buildMenu(): void {
  Menu.setApplicationMenu([
    {
      label: 'TeaBranch',
      submenu: [
        { role: 'about', label: t('关于 TeaBranch') },
        { type: 'separator' },
        { label: t('设置…'), shortcut: 'cmd+,', onSelect: () => sendMenu('settings') },
        { type: 'separator' },
        { role: 'hide', label: t('隐藏 TeaBranch') },
        { role: 'hideOthers', label: t('隐藏其他') },
        { role: 'showAll', label: t('全部显示') },
        { type: 'separator' },
        { role: 'quit', label: t('退出 TeaBranch') },
      ],
    },
    {
      // Not t('文件'): the issue views translate that key as “Files”.
      label: getLocale() === 'en' ? 'File' : '文件', // i18n-ignore
      submenu: [{ label: t('新建分支…'), shortcut: 'cmd+n', onSelect: () => sendMenu('newBranch') }],
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
        { role: 'selectAll', label: t('全选') },
      ],
    },
    {
      label: t('显示'),
      submenu: [
        { label: t('分支'), shortcut: 'cmd+1', onSelect: () => sendMenu('showBranches') },
        { label: 'Issues', shortcut: 'cmd+2', onSelect: () => sendMenu('showIssues') },
        { label: t('托管…'), shortcut: 'cmd+3', onSelect: () => sendMenu('autopilot') },
        { type: 'separator' },
        { label: t('终端'), shortcut: 'cmd+j', onSelect: () => sendMenu('toggleTerminal') },
        { label: t('新建终端'), shortcut: 'cmd+`', onSelect: () => sendMenu('newTerminal') },
      ],
    },
    {
      label: t('窗口'),
      submenu: [
        { role: 'minimize', label: t('最小化') },
        { role: 'zoom', label: t('缩放') },
        { role: 'toggleFullScreen', label: t('全屏') },
      ],
    },
  ])
}

/** Everything the services need before the first screen: once. */
export async function boot(): Promise<void> {
  if (booted) return
  booted = true
  Window.setTitle('TeaBranch')
  // Electron's hiddenInset: the app fills the window up to its top edge and the traffic lights sit
  // in the sidebar's title strip, which is why every page starts with one (TitleStrip).
  Window.setTitleBar({ style: 'hidden', height: 38 })
  await resolveUserPath()
  await startBrowserBridge()
  // A worktree an issue agent works in belongs in the "开发中" lane.
  setOnBranchCreated((branch) => {
    setCategory(branch, 'developing')
    emit('branchesChanged', undefined)
  })
  applyLocale(state.settings.language)
  onLocaleChange(buildMenu)
  buildMenu()
  startReconcileLoop()
  void autopilot.apply()
  log.info('ready')
}

/**
 * Quitting kills dev servers — including ones adopted as orphans, by port. That is what makes
 * force-quit recovery work, and why this app shouldn't run alongside hand-started servers on the
 * same ports.
 */
export async function shutdown(): Promise<void> {
  if (quitting) return
  quitting = true
  autopilot.stop()
  issueAgent.flush()
  chatAgent.flush()
  issueAgent.killAll()
  chatAgent.killAll()
  ptyHost.killAll()
  await cleanupAll()
}
