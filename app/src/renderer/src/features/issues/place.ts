import type { Issue } from '@shared/types'
import { t } from '@shared/i18n'
import { useApp } from '@/store/app'
import { useChats } from '@/store/chats'
import { useIssues } from '@/store/issues'
import { currentGroup, useTabs } from '@/store/tabs'

export interface Place {
  cwd: string
  branch?: string
  /** Shown in tooltips: the branch, or where it fell back to. */
  label: string
}

/**
 * Where "here" is for a new chat or terminal: the chat in front's checkout, the selected issue's
 * worktree, or the main repository. `issue` is set (with `place` the main checkout) when the
 * selected issue has no worktree yet.
 */
export function useHere(): { place: Place | null; issue?: Issue; needsWorktree: boolean } {
  const settings = useApp((s) => s.settings)
  const branches = useApp((s) => s.branches)
  const activeChat = useTabs((s) => s.activeChat)
  const chats = useChats((s) => s.chats)
  const selection = useIssues((s) => s.selection)
  const issues = useIssues((s) => s.issues)
  const runs = useIssues((s) => s.runs)
  const config = useIssues((s) => s.config)

  const current = branches.find((branch) => branch.isCurrent)
  const main = settings?.projectPath ? { cwd: settings.projectPath, branch: current?.name, label: t('主仓库') } : null
  const chat = activeChat ? chats.find((candidate) => candidate.id === activeChat) : undefined
  if (chat) return { place: { cwd: chat.cwd, branch: chat.branch, label: chat.branch ?? chat.cwd }, needsWorktree: false }

  const group = currentGroup(selection)
  const issue = group ? issues.find((candidate) => candidate.id === group) : undefined
  if (!issue) return { place: main, needsWorktree: false }
  const name = runs[issue.id]?.branch ?? `${config?.branchPrefix ?? ''}${issue.key}`
  const worktree = branches.find((branch) => branch.name === name && branch.worktreePath)
  if (worktree) return { place: { cwd: worktree.worktreePath as string, branch: name, label: name }, issue, needsWorktree: false }
  return { place: main && { ...main, label: t('主仓库（{key} 还没有 worktree）', { key: issue.key }) }, issue, needsWorktree: true }
}
