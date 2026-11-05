import { Clipboard, openUrl } from 'nsh'
import { Desktop, Dialog } from 'teabranch/native'
import { existsSync, mkdirSync, readFileBase64Sync, renameSync, rmSync } from './node/fs'
import { basename, join } from 'path'
import { DRAFT_UPLOADS } from './shared/attachments'
import type { Api, Branch, DevCategory, TeableConfig, TeableUser } from './shared/types'
import { APP_THREAD, isLive } from './shared/types'
import { getLocale, t } from './shared/i18n'
import { state } from './core/appState'
import { applyLocale } from './core/locale'
import * as envFile from './core/envFile'
import { emit, emitSoon } from './core/events'
import { TeaBranchError } from './core/log'
import { git as gitCommand, run } from './core/shell'
import { logs } from './core/logStore'
import { readSecret, writeSecret } from './core/secrets'
import {
  loadAutopilotConfig,
  loadCategories,
  loadTeableConfig,
  saveAutopilotConfig,
  saveCategories,
  saveTeableConfig,
} from './core/settingsStore'
import { magpieModels } from './services/agentRunner'
import { chatAgent } from './services/chatAgent'
import { claudeCatalog } from './services/claudeCatalog'
import * as git from './services/git'
import * as autopilot from './services/autopilot'
import * as autopilotHub from './services/autopilotHub'
import * as feishu from './services/feishu'
import { issueAgent } from './services/issueAgent'
import { resetRouter } from './services/router'
import * as issueSource from './services/issueSource'
import { readUpload, saveUpload, uploadsDir } from './services/issueContext'
import { defaultPrompts } from './services/prompts'
import * as ngrok from './services/ngrok'
import * as processManager from './services/processManager'
import * as processStats from './services/processStats'
import * as ptyHost from './services/ptyHost'
import { scratchRoot } from './services/scratch'
import * as teable from './services/teable'
import * as teableAuth from './services/teableAuth'
import * as terminal from './services/terminal'
import * as worktrees from './services/worktree'
import { removeWorktree } from './services/worktreeCleanup'
import * as browser from './services/browser'

let categories = loadCategories()
let teableUser: TeableUser | null = null

async function gitIn(cwd: string, args: string[]): Promise<string> {
  const result = await gitCommand(args, cwd)
  return result.ok ? result.stdout : ''
}

function requireRepo(): string {
  if (!state.projectPath) throw new TeaBranchError(t('没有设置仓库路径'))
  return state.projectPath
}

async function worktreeOf(branch: string): Promise<string> {
  return state.environment(branch)?.worktreePath ?? git.worktreePath(branch, requireRepo())
}

async function teableToken(): Promise<string> {
  const token = await teableAuth.accessToken()
  if (!token) throw new TeaBranchError(t('未登录 Teable'))
  return token
}

async function loadUser(token: string): Promise<TeableUser> {
  const config = loadTeableConfig()
  try {
    return await teable.me(config, token)
  } catch (error) {
    // A token scoped to the table may not read the profile; reading the table is what matters —
    // when there is one yet. Before that, the profile's error is the one worth showing.
    if (!config.tableId) throw error
    await teable.fields(config, token)
    return { id: 'token', name: t('已登录（令牌）') }
  }
}

export const setCategory = (branch: string, category: DevCategory): void => {
  categories = { ...categories, [branch]: category }
  saveCategories(categories)
}

/** Every handler, keyed by the `Api` method it implements — the compiler checks the contract. */
const handlers: Api = {
  // App
  getSettings: async () => state.settings,
  locale: async () => getLocale(),
  defaultPrompts: async () => defaultPrompts(),
  chooseProject: async () => {
    const [path] = await Dialog.pickPaths(true, false, t('选择要管理的 git 仓库'))
    if (!path) return null
    if (!existsSync(join(path, '.git'))) throw new TeaBranchError(t('不是 git 仓库'))
    state.clearEnvironments()
    const settings = state.updateSettings({ projectPath: path })
    emitSoon('branchesChanged')
    return settings
  },
  updateSettings: async (patch) => {
    const settings = state.updateSettings(patch)
    if ('language' in patch) applyLocale(settings.language)
    return settings
  },
  terminalPresets: async () => terminal.presets,
  canRunAgent: async () => terminal.canRunCommands(state.settings.terminalApp),

  // Branches
  listBranches: async () => (state.projectPath ? git.branches(state.projectPath, state.environmentsByBranch()) : []),
  getCategories: async () => categories,
  setCategory: async (branch, category) => setCategory(branch, category),
  startBranch: (branch) => processManager.start(branch),
  stopBranch: (branch) => processManager.stop(branch),
  restartBranch: (branch) =>
    processManager.withBranchLock(branch, async () => {
      await processManager.stop(branch)
      await processManager.start(branch)
    }),
  deleteBranch: async (branch) => removeWorktree(branch, requireRepo()),
  createWorktree: async (branch, dbMode) => {
    const repo = requireRepo()
    await processManager.withBranchLock(branch, () =>
      worktrees.create(branch, repo, dbMode, (progress) => emit('worktreeProgress', { branch, progress })),
    )
    emitSoon('branchesChanged')
  },
  worktreeDbInfo: async () => git.worktreeDbInfo(requireRepo()),
  openTerminal: async (branch) => terminal.open(await worktreeOf(branch), state.settings.terminalApp, branch),
  openAgent: async (branch) => {
    const command = state.settings.agentCommand.trim()
    if (!command) throw new TeaBranchError(t('没有配置 agent 命令 — 在设置里填一个。'))
    await terminal.open(await worktreeOf(branch), state.settings.terminalApp, branch, command)
  },
  openEditor: async (branch) => terminal.openInVSCode(await worktreeOf(branch)),
  openPreview: async (branch) => {
    const port = state.environment(branch)?.port
    if (port) await openUrl(browser.previewURL(branch, port))
  },
  browserState: async (branch) => browser.browserState(branch),
  showBrowser: async (branch, bounds) => browser.show(branch, bounds),
  hideBrowser: async (branch) => browser.hide(branch),
  browserNavigate: (branch, address) => browser.navigate(branch, address),
  browserBack: async (branch) => browser.goBack(branch),
  browserForward: async (branch) => browser.goForward(branch),
  browserReload: async (branch) => browser.reload(branch),
  browserDevTools: async (branch) => browser.openDevTools(branch),
  revealInFinder: async (branch) => Desktop.revealPath(await worktreeOf(branch)),
  revealAgentFiles: async (branch) => {
    const root = scratchRoot(await worktreeOf(branch))
    if (root) await Desktop.openPath(root)
    return !!root
  },
  branchesWithTerminal: async () => {
    if (!terminal.isOtty(state.settings.terminalApp) || !state.projectPath) return []
    const entries = await git.worktrees(state.projectPath)
    const open = await terminal.ottyOpenWorktrees(entries.map((entry) => entry.path))
    return entries.filter((entry) => open.has(entry.path)).map((entry) => entry.branch)
  },
  usage: async () => {
    const targets = state
      .allEnvironments()
      .filter((environment) => isLive(environment.status))
      .map((environment) => ({
        branch: environment.branchName,
        pgids: state.pidsByLabel(environment.branchName),
        ports: [environment.port, environment.backendPort, environment.socketPort].filter((p): p is number => !!p),
      }))
    return processStats.sample(targets)
  },
  logs: async (branch) => logs.snapshot(branch),
  clearLogs: async (branch) => logs.clear(branch),
  envEntries: async (branch) => {
    const path = await worktreeOf(branch)
    return envFile.entries(path).map((entry) => ({ ...entry, managed: envFile.managedKeys.includes(entry.key) }))
  },
  writeEnvEntries: async (branch, entries) => envFile.writeEntries(entries, await worktreeOf(branch)),
  ngrok: async () => state.ngrokTunnel ?? null,
  branchChanges: async (branch) => {
    const cwd = await worktreeOf(branch)
    const base = `origin/${worktrees.baseBranch}`
    const [numstat, log, status] = await Promise.all([
      gitIn(cwd, ['diff', '--numstat', `${base}...HEAD`]),
      gitIn(cwd, ['log', '--format=%h%x09%s', `${base}..HEAD`, '-n', '50']),
      gitIn(cwd, ['status', '--porcelain']),
    ])
    return {
      base,
      files: numstat
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [added, removed, ...path] = line.split('\t')
          // Binary files report "-" for both counts.
          return { path: path.join('\t'), added: Number(added) || 0, removed: Number(removed) || 0 }
        }),
      commits: log
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, ...subject] = line.split('\t')
          return { hash, subject: subject.join('\t') }
        }),
      dirty: status
        .split('\n')
        .filter(Boolean)
        .map((line) => line.slice(3)),
    }
  },
  openFileInEditor: async (branch, path) => {
    const cwd = await worktreeOf(branch)
    const result = await run('code', ['-g', join(cwd, path)])
    if (!result.ok) throw new TeaBranchError(t('打开 VS Code 失败：装了 `code` 命令吗？'))
  },
  toggleNgrok: async (branch) => {
    if (state.ngrokTunnel?.branchName === branch) {
      ngrok.stop()
      return null
    }
    return ngrok.start(branch)
  },

  // Issues
  teableConfig: async () => loadTeableConfig(),
  updateTeableConfig: async (patch) => {
    const next: TeableConfig = { ...loadTeableConfig(), ...patch }
    saveTeableConfig(next)
    if ('batchSize' in patch) issueAgent.concurrencyChanged()
    return next
  },
  teableSignIn: async (token, baseURL) => {
    const config = baseURL ? { ...loadTeableConfig(), baseURL } : loadTeableConfig()
    if (baseURL) saveTeableConfig(config)
    const user = await loadUser(token.trim())
    teableAuth.savePersonalToken(token.trim())
    teableUser = user
    return user
  },
  teableSignOut: async () => {
    teableAuth.signOut()
    teableUser = null
  },
  teableSession: async () => {
    if (teableUser) return teableUser
    const token = await teableAuth.accessToken()
    if (!token) return null
    teableUser = await loadUser(token).catch(() => ({ id: 'token', name: t('已登录') }))
    return teableUser
  },
  teableBrowse: async (level, parentId) => teable.browse(loadTeableConfig(), await teableToken(), level, parentId),
  teableLoad: async () => issueSource.loadTable(),
  openTokenPage: async () => void (await openUrl(teable.tokenPageURL(loadTeableConfig().baseURL))),
  openOAuthAppPage: async () => void (await openUrl(`${teable.apiBase(loadTeableConfig())}/setting/oauth-app`)),
  teableDeviceStart: async () => {
    const clientId = teableAuth.clientIdFor(loadTeableConfig())
    if (!clientId) throw new TeaBranchError(t('这个 Teable 地址没有内置 OAuth 应用 — 在“其他登录方式”里填 Client ID，或用个人访问令牌'))
    const code = await teableAuth.startDeviceLogin(clientId, (error) => {
      if (!error) teableUser = null
      emit('teableSignedIn', { error })
    })
    // The approval page asks for the code; have it ready to paste.
    await Clipboard.writeText(code.userCode)
    await openUrl(code.verificationUri)
    return code
  },
  teableDeviceCancel: async () => teableAuth.cancelDeviceLogin(),
  teableOAuthReady: async () => !!teableAuth.clientIdFor(loadTeableConfig()),
  issueRuns: async () => issueAgent.allRuns(),
  queueState: async () => issueAgent.queueState(),
  transcript: async (recordId) => issueAgent.transcript(recordId),
  issueComments: async (recordId) => teable.comments(loadTeableConfig(), await teableToken(), recordId),
  enqueueFix: async (issues) => {
    requireRepo()
    for (const issue of issues) issueAgent.enqueueFix(issue)
  },
  fixNow: async (issue) => {
    requireRepo()
    issueAgent.fixNow(issue)
  },
  restoreQueue: async (issues) => issueAgent.restoreQueue(issues),
  sendToAgent: (issue, message, attachments, steer) => issueAgent.say(issue, message, attachments, steer),
  steerIssueMessage: (issue, queuedId) => issueAgent.steer(issue, queuedId),
  unqueueIssueMessage: async (recordId, queuedId) => issueAgent.unqueue(recordId, queuedId),
  setIssueModel: async (recordId, model) => issueAgent.setModel(recordId, model),
  setIssueAccess: async (recordId, access) => issueAgent.setAccess(recordId, access),
  setIssueShelf: async (recordId, shelf) => issueAgent.setShelf(recordId, shelf),
  claudeCatalog: async () => claudeCatalog(state.settings.agentCommand),
  listChats: async () => chatAgent.list(),
  createChat: async (workspace) => chatAgent.create(workspace),
  terminalOpen: async (id, cwd, cols, rows) => ptyHost.open(id, cwd, cols, rows),
  terminalWrite: async (id, data) => ptyHost.write(id, data),
  terminalResize: async (id, cols, rows) => ptyHost.resize(id, cols, rows),
  terminalKill: async (id) => ptyHost.kill(id),
  fixAnyway: async (issue) => issueAgent.fixAnyway(issue),
  createIssueChat: async (issue) => {
    const workspace = await issueAgent.issueWorktree(issue, (branch, progress) => emit('worktreeProgress', { branch, progress }))
    emitSoon('branchesChanged')
    return chatAgent.create({ ...workspace, issueId: issue.id })
  },
  chatTranscript: async (chatId) => chatAgent.transcript(chatId),
  sendChat: async (chatId, message, attachments, steer) => chatAgent.say(chatId, message, attachments, steer),
  steerChatMessage: async (chatId, queuedId) => chatAgent.steer(chatId, queuedId),
  unqueueChatMessage: async (chatId, queuedId) => chatAgent.unqueue(chatId, queuedId),
  cancelChat: async (chatId) => chatAgent.cancel(chatId),
  stopChatBackground: async (chatId, taskId) => chatAgent.stopBackground(chatId, taskId),
  deleteChat: async (chatId) => chatAgent.delete(chatId),
  updateChat: async (chatId, patch) => chatAgent.update(chatId, patch),
  saveUpload: async (recordId, name, base64) => {
    // base64 is 4/3 of the bytes.
    if (base64.length > (25 * 1024 * 1024 * 4) / 3) throw new TeaBranchError(t('附件超过 25MB'))
    return saveUpload(recordId, name, base64)
  },
  pickUploads: async (recordId) => {
    const paths = await Dialog.pickPaths(false, true, t('附加到这条消息'))
    return paths.map((path) => saveUpload(recordId, basename(path), readFileBase64Sync(path)))
  },
  readUpload: async (path) => readUpload(path),
  review: (issue) => issueAgent.review(issue),
  sendLatestReview: (issue) => issueAgent.sendLatestReview(issue),
  postLatestReview: (recordId) => issueAgent.postLatestReview(recordId),
  cancelIssue: async (recordId) => issueAgent.cancel(recordId),
  stopIssueBackground: async (recordId, taskId) => issueAgent.stopBackground(recordId, taskId),
  prDetails: (recordId) => issueAgent.prDetails(recordId),
  prAction: (recordId, action) => issueAgent.prAction(recordId, action),
  refreshChecks: (recordId) => issueAgent.refreshChecks(recordId),
  sendCIFailures: (issue) => issueAgent.sendCIFailures(issue),
  pauseIssue: async (recordId) => issueAgent.pause(recordId),
  resumeIssue: async (recordId) => issueAgent.resume(recordId),
  pauseQueue: async () => issueAgent.pauseAll(),
  resumeQueue: async () => issueAgent.resumeAll(),
  cancelQueue: async () => issueAgent.cancelAll(),
  reorderQueue: async (ids) => issueAgent.reorder(ids),
  resetIssue: async (recordId) => issueAgent.reset(recordId),
  resumeInTerminal: async (recordId) => {
    const target = issueAgent.resumeCommand(recordId)
    if (!target) throw new TeaBranchError(t('找不到这个 issue 的 worktree'))
    await terminal.open(target.cwd, state.settings.terminalApp, target.title, target.command)
  },
  magpieModels: async () => magpieModels(loadTeableConfig().magpieURL),
  setMagpieKey: async (key) => writeSecret('magpie.key', key || undefined),
  openExternal: async (url) => {
    if (/^https?:\/\//.test(url)) await openUrl(url)
  },
  autopilotConfig: async () => loadAutopilotConfig(),
  updateAutopilotConfig: async (patch) => {
    const before = loadAutopilotConfig()
    const next = { ...before, ...patch }
    saveAutopilotConfig(next)
    const keys = ['feishuAppId', 'feishuDomain', 'feishuIdentity', 'pollSeconds'] as const
    const reconnect = keys.some((key) => before[key] !== next[key])
    await autopilot.apply()
    if (reconnect && before.enabled && next.enabled) await autopilot.reconnectFeishu()
    return next
  },
  autopilotStatus: async () => autopilot.status(),
  hasFeishuSecret: async () => !!readSecret('feishu.secret'),
  setFeishuSecret: async (secret) => {
    writeSecret('feishu.secret', secret.trim() || undefined)
    await autopilot.reconnectFeishu()
  },
  authorizeFeishuUser: async () => {
    const { name } = await feishu.authorizeUser(loadAutopilotConfig(), (url) => void openUrl(url))
    await autopilot.reconnectFeishu()
    return name
  },
  signOutFeishuUser: async () => {
    feishu.signOutUser()
    await autopilot.reconnectFeishu()
  },
  feishuUserInfo: async () => ({ name: feishu.authorizedUser()?.name, redirectURL: feishu.REDIRECT_URL, scopes: feishu.USER_SCOPES }),
  autopilotActivity: async () => autopilotHub.activityList().slice(-300),
  resetRouter: async () => {
    // Started here, so its status — the handover, then the fresh session — reaches the window.
    await autopilot.ensureRouter()
    await resetRouter()
  },
  routerMemory: async () => autopilotHub.routerMemory(),
  setRouterMemory: async (text) => autopilotHub.setRouterMemory(text),
  probe: async (text, attachments = []) => {
    requireRepo()
    // It reports back into the app's chat, like anything else started there.
    const issue = issueAgent.probe(text, { images: attachments, threads: [APP_THREAD] })
    autopilotHub.link(APP_THREAD, issue.id)
    // The probe copied them into its own folder; the drafts are done with.
    const drafts = uploadsDir(DRAFT_UPLOADS)
    for (const path of attachments) if (path.startsWith(drafts)) rmSync(path, { force: true })
    autopilotHub.record({
      source: 'me',
      thread: APP_THREAD,
      text,
      outcome: 'action',
      detail: t('开始探查 {key}', { key: issue.key }),
      recordId: issue.id,
    })
    return { id: issue.id, key: issue.key }
  },
  askRouter: async (text, attachments = []) => {
    requireRepo()
    // Drafts move under the app's own folder and stay: the chat shows them, a task copies them.
    const drafts = uploadsDir(DRAFT_UPLOADS)
    const dir = uploadsDir('app')
    mkdirSync(dir, { recursive: true })
    const files = attachments.map((path) => {
      if (!path.startsWith(drafts) || !existsSync(path)) return path
      const target = join(dir, basename(path))
      renameSync(path, target)
      return target
    })
    await autopilot.ask(text, files)
  },
  routerChat: async () => autopilotHub.appThreadActivity(),
  cleanupIssue: async (recordId) => {
    await issueAgent.cleanup(recordId, true)
  },
}

/** What the UI calls: the same `Api` the renderer had over IPC, now plain calls in one realm. */
export const api: Api = handlers

export type { Branch }
