import { AlertTriangle, GitBranch } from 'lucide-react'
import { useEffect } from 'react'
import { Button, IconButton, TitleStrip } from '@/components/kit'
import { BranchDetail } from '@/features/branches/BranchDetail'
import { BranchSidebar } from '@/features/branches/BranchSidebar'
import { CreateWorktreeDialog } from '@/features/branches/CreateWorktreeDialog'
import { DeleteDialog } from '@/features/branches/DeleteDialog'
import { SettingsDialog } from '@/features/branches/SettingsDialog'
import { IssueSettingsDialog } from '@/features/issues/IssueSettingsDialog'
import { IssueSidebar } from '@/features/issues/IssueSidebar'
import { IssuesMain } from '@/features/issues/IssuesMain'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useApp } from '@/store/app'
import { useIssues } from '@/store/issues'

export function App() {
  const ready = useApp((s) => s.ready)
  const settings = useApp((s) => s.settings)
  const section = useApp((s) => s.section)
  const init = useApp((s) => s.init)
  const initIssues = useIssues((s) => s.init)

  useEffect(() => {
    void init()
    void initIssues()
  }, [init, initIssues])

  if (!ready) return null
  if (!settings?.projectPath) return <Onboarding />

  return (
    <TooltipProvider delay={400}>
    <div className="flex h-full">
      <aside className="flex w-[290px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar/80 text-sidebar-foreground">
        {section === 'branches' ? <BranchSidebar /> : <IssueSidebar />}
      </aside>
      <main className="selectable-area relative flex min-w-0 flex-1 flex-col bg-bg">
        {section === 'branches' ? <BranchDetail /> : <IssuesMain />}
        <ErrorToast />
      </main>
      <Dialogs />
    </div>
    </TooltipProvider>
  )
}

function Dialogs() {
  const showCreate = useApp((s) => s.showCreate)
  const showSettings = useApp((s) => s.showSettings)
  const pendingDelete = useApp((s) => s.pendingDelete)
  const showIssueSettings = useIssues((s) => s.showSettings)
  return (
    <>
      {showCreate && <CreateWorktreeDialog />}
      {showSettings && <SettingsDialog />}
      {pendingDelete && <DeleteDialog branch={pendingDelete} />}
      {showIssueSettings && <IssueSettingsDialog />}
    </>
  )
}

/** Transient problems float over the content instead of reshaping the layout. */
function ErrorToast() {
  const section = useApp((s) => s.section)
  const appError = useApp((s) => s.error)
  const issueError = useIssues((s) => s.error)
  const user = useIssues((s) => s.user)
  // Before sign-in the login view shows its own error inline.
  const message = section === 'issues' ? (user ? issueError : null) : appError
  if (!message) return null
  const dismiss = () => (section === 'issues' ? useIssues.setState({ error: null }) : useApp.setState({ error: null }))
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-xl items-start gap-2.5 rounded-xl border border-err/30 bg-panel/95 px-3.5 py-2.5 shadow-xl backdrop-blur-xl">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-err" />
        <div className="selectable flex-1 text-[13px] whitespace-pre-wrap">{message}</div>
        <IconButton label="关闭" onClick={dismiss} className="-my-1">
          ✕
        </IconButton>
      </div>
    </div>
  )
}

function Onboarding() {
  const chooseProject = useApp((s) => s.chooseProject)
  const error = useApp((s) => s.error)
  return (
    <div className="flex h-full flex-col bg-bg">
      <TitleStrip />
      <div className="flex flex-1 flex-col items-center justify-center gap-6">
      <GitBranch className="size-12 text-brand" strokeWidth={1.5} />
      <div className="text-center">
        <h1 className="text-[34px] font-bold tracking-tight">TeaBranch</h1>
        <p className="mt-2 max-w-sm text-[14px] text-fg-2">
          Run every branch in parallel — each with its own worktree, ports and database.
        </p>
      </div>
      <Button tone="accent" className="h-9 px-5" onClick={() => void chooseProject()}>
        Choose Repository…
      </Button>
      {error && <div className="rounded-md bg-err-soft px-3 py-2 text-[13px] text-err">{error}</div>}
      </div>
    </div>
  )
}

