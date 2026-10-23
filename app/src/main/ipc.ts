import { clipboard, dialog, ipcMain, shell } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Api, Branch, DevCategory, TeableConfig, TeableUser } from '@shared/types'
import { IPC_INVOKE, isLive } from '@shared/types'
import { getLocale, t } from '@shared/i18n'
import { state } from './core/appState'
import { applyLocale } from './core/locale'
import * as envFile from './core/envFile'
import { emit, emitSoon } from './core/events'
import { TeaBranchError } from './core/log'
import { git as gitCommand, run } from './core/shell'
import { logs } from './core/logStore'
import { writeSecret } from './core/secrets'
import { loadCategories, loadTeableConfig, saveCategories, saveTeableConfig } from './core/settingsStore'
import { magpieModels } from './services/agentRunner'
import { chatAgent } from './services/chatAgent'
import { claudeCatalog } from './services/claudeCatalog'
import * as git from './services/git'
import { issueAgent } from './services/issueAgent'
import { saveUpload } from './services/issueContext'
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
  try {
    return await teable.me(loadTeableConfig(), token)
  } catch {
    // A token scoped to the table may not read the profile; reading the table is what matters.
    await teable.fields(loadTeableConfig(), token)
    return { id: 'token', name: t('已登录（令牌）') }
  }
}

/** `*.localhost` per branch, so each branch gets its own cookie jar. */
export function previewURL(branch: string, port: number): string {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return `http://${slug}.localhost:${port}`
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
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      message: t('选择要管理的 git 仓库'),
      buttonLabel: t('选择'),
    })
    const path = result.filePaths[0]
    if (result.canceled || !path) return null
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
  deleteBranch: async (branch) => {
    const repo = requireRepo()
    // Held across the whole delete, so `git worktree remove --force` never races a Start that is
    // still writing into the directory.
    await processManager.withBranchLock(branch, async () => {
      await processManager.stop(branch)
      await worktrees.remove(branch, repo)
      state.removeEnvironment(branch)
      logs.remove(branch)
    })
    emitSoon('branchesChanged')
  },
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
    if (port) await shell.openExternal(previewURL(branch, port))
  },
  revealInFinder: async (branch) => shell.showItemInFolder(await worktreeOf(branch)),
  revealAgentFiles: async (branch) => {
    const root = scratchRoot(await worktreeOf(branch))
    if (root) await shell.openPath(root)
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
  teableLoad: async () => {
    const config = loadTeableConfig()
    if (!config.tableId) return { fields: [], records: [] }
    const token = await teableToken()
    const fields = await teable.fields(config, token)
    // Filtered server-side: someone else's issues never reach this machine, so auto mode can't
    // pick one up either.
    let filter: unknown
    if (config.onlyMine) {
      const people = fields.filter(teable.isUserField)
      const assignee = config.assigneeField ? people.find((field) => field.name === config.assigneeField) : guessAssignee(people)
      if (!assignee) throw new TeaBranchError(t('“只看我的”需要一个人员字段 — 在 Issue 设置里选“负责人”字段'))
      filter = teable.mineFilter(assignee)
    }
    const peopleFields = fields.filter(teable.isUserField).map((field) => field.name)
    const attachmentFields = fields.filter(teable.isAttachmentField).map((field) => field.name)
    return { fields, records: await teable.records(config, token, filter, peopleFields, attachmentFields) }
  },
  openTokenPage: async () => shell.openExternal(teable.tokenPageURL(loadTeableConfig().baseURL)),
  openOAuthAppPage: async () => shell.openExternal(`${teable.apiBase(loadTeableConfig())}/setting/oauth-app`),
  teableDeviceStart: async () => {
    const clientId = teableAuth.clientIdFor(loadTeableConfig())
    if (!clientId) throw new TeaBranchError(t('这个 Teable 地址没有内置 OAuth 应用 — 在“其他登录方式”里填 Client ID，或用个人访问令牌'))
    const code = await teableAuth.startDeviceLogin(clientId, (error) => {
      if (!error) teableUser = null
      emit('teableSignedIn', { error })
    })
    // The approval page asks for the code; have it ready to paste.
    clipboard.writeText(code.userCode)
    await shell.openExternal(code.verificationUri)
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
  startNextBatch: async () => issueAgent.startNextBatch(),
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
  deleteChat: async (chatId) => chatAgent.delete(chatId),
  updateChat: async (chatId, patch) => chatAgent.update(chatId, patch),
  saveUpload: async (recordId, name, base64) => {
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length > 25 * 1024 * 1024) throw new TeaBranchError(t('附件超过 25MB'))
    return saveUpload(recordId, name, bytes)
  },
  pickUploads: async (recordId) => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], message: t('附加到这条消息') })
    if (result.canceled) return []
    return result.filePaths.map((path) => saveUpload(recordId, basename(path), readFileSync(path)))
  },
  review: (issue) => issueAgent.review(issue),
  sendLatestReview: (issue) => issueAgent.sendLatestReview(issue),
  postLatestReview: (recordId) => issueAgent.postLatestReview(recordId),
  cancelIssue: async (recordId) => issueAgent.cancel(recordId),
  resetIssue: async (recordId) => issueAgent.reset(recordId),
  resumeInTerminal: async (recordId) => {
    const target = issueAgent.resumeCommand(recordId)
    if (!target) throw new TeaBranchError(t('找不到这个 issue 的 worktree'))
    await terminal.open(target.cwd, state.settings.terminalApp, target.title, target.command)
  },
  magpieModels: async () => magpieModels(loadTeableConfig().magpieURL),
  setMagpieKey: async (key) => writeSecret('magpie.key', key || undefined),
  openExternal: async (url) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url)
  },
}

/** The person field that most sounds like an assignee. */
function guessAssignee<T extends { name: string; type: string }>(people: T[]): T | undefined {
  // Field names as people write them, matched against the table — not UI text.
  const names = ['负责人', '处理人', '指派', '经办人', '开发', 'assignee', 'owner', 'developer', 'dev'] // i18n-ignore
  for (const name of names) {
    const hit = people.find((field) => field.name.toLowerCase() === name)
    if (hit) return hit
  }
  for (const name of names) {
    const hit = people.find((field) => field.name.toLowerCase().includes(name))
    if (hit) return hit
  }
  return people.find((field) => field.type === 'user')
}

export function registerIpc(): void {
  ipcMain.handle(IPC_INVOKE, async (_event, method: keyof Api, args: unknown[]) => {
    const handler = handlers[method] as (...params: unknown[]) => Promise<unknown>
    if (!handler) throw new Error(`Unknown method ${String(method)}`)
    return handler(...args)
  })
}

export type { Branch }
