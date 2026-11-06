import { Text, View, signal } from 'nsh'
import { ResizablePanel, ResizablePanelGroup } from 'nsh/base'
import { t } from '../shared/i18n'
import { Icon } from './components/Icon'
import { Button, IconButton, TitleStrip } from './components/kit'
import { Lightbox } from './components/Lightbox'
import { AutopilotMain } from './features/autopilot/AutopilotPages'
import { AutopilotSidebar } from './features/autopilot/AutopilotSidebar'
import { BranchDetail } from './features/branches/BranchDetail'
import { BranchSidebar } from './features/branches/BranchSidebar'
import { CreateWorktreeDialog } from './features/branches/CreateWorktreeDialog'
import { DeleteDialog } from './features/branches/DeleteDialog'
import { SettingsDialog } from './features/settings/SettingsDialog'
import { BrowserHost } from './features/issues/browserHost'
import { IssueSettingsDialog } from './features/issues/IssueSettingsDialog'
import { IssueSidebar } from './features/issues/IssueSidebar'
import { IssuesMain } from './features/issues/IssuesMain'
import { pref, setPref } from './prefs'
import { app } from './store/app'
import { autopilot } from './store/autopilot'
import { chats } from './store/chats'
import { issues } from './store/issues'

const SIDEBAR_KEY = 'teabranch.sidebarWidth'
const SIDEBAR_MIN = 220
const SIDEBAR_MAX = 560

export function App() {
  void app.init()
  void issues.init()
  void autopilot.init()
  void chats.init()
  // A language change rebuilds every view: the strings are read as the views are made.
  return (
    <Each of={[app.epoch()]} key={(epoch) => String(epoch)}>
      {() => <Shell />}
    </Each>
  )
}

function Shell() {
  const sidebarWidth = signal(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, pref<number>(SIDEBAR_KEY, 290))))
  const section = () => (app.section() === 'queue' ? 'autopilot' : app.section())
  return (
    <If when={app.ready()}>
      <If when={app.settings()?.projectPath} else={<Onboarding />}>
        <ResizablePanelGroup
          axis="horizontal"
          class="flex-1 flex-row bg-bg"
          handleClass="w-[3px] hover:bg-brand/40 active:bg-brand/60"
          onResize={(e) => {
            const width = Math.round(e.sizes[0] ?? sidebarWidth())
            sidebarWidth.set(width)
            setPref(SIDEBAR_KEY, width)
          }}
        >
          <ResizablePanel size={sidebarWidth()} minSize={SIDEBAR_MIN} maxSize={SIDEBAR_MAX} fixed class="border-r border-sidebar-border bg-sidebar">
            <If when={section() === 'autopilot'} else={<If when={section() === 'branches'} else={<IssueSidebar />}>{() => <BranchSidebar />}</If>}>
              <AutopilotSidebar />
            </If>
          </ResizablePanel>
          <ResizablePanel class="relative min-w-0 flex-1 bg-bg">
            <If when={section() === 'autopilot'} else={<If when={section() === 'branches'} else={<IssuesMain />}>{() => <BranchDetail />}</If>}>
              <AutopilotMain />
            </If>
            <ErrorToast />
          </ResizablePanel>
        </ResizablePanelGroup>
        {/* The branches' browsers live at the root, laid over the panel that shows them. */}
        <BrowserHost />
        <Dialogs />
        <Lightbox />
      </If>
    </If>
  )
}

function Dialogs() {
  return (
    <>
      <If when={app.showCreate()}>
        <CreateWorktreeDialog />
      </If>
      <If when={app.showSettings()}>
        <SettingsDialog />
      </If>
      <If when={issues.showSettings()}>
        <IssueSettingsDialog />
      </If>
      <If when={app.pendingDelete()}>{(branch) => <DeleteDialog branch={branch()} />}</If>
    </>
  )
}

/** Transient problems float over the content instead of reshaping the layout. */
function ErrorToast() {
  const message = () => (app.section() !== 'branches' ? (issues.user() ? issues.error() : null) : app.error())
  const dismiss = () => (app.section() !== 'branches' ? issues.set({ error: null }) : app.set({ error: null }))
  return (
    <If when={message()}>
      <View class="absolute inset-x-0 bottom-4 items-center px-4">
        <View class="max-w-xl flex-row items-start gap-2.5 rounded-xl border border-err/30 bg-panel px-3.5 py-2.5 shadow-xl">
          <Icon name="alert-triangle" size={16} tint="err" class="mt-0.5" />
          <Text class="flex-1 text-[13px] text-fg" style={{ userSelect: 'text' }}>
            {message()}
          </Text>
          <IconButton label={t('关闭')} onPress={dismiss}>
            <Icon name="x" size={14} tint="fg-2" />
          </IconButton>
        </View>
      </View>
    </If>
  )
}

function Onboarding() {
  return (
    <View class="flex-1 bg-bg">
      <TitleStrip />
      <View class="flex-1 items-center justify-center gap-6">
        <Icon name="git-branch" size={48} tint="brand" />
        <View class="items-center">
          <Text class="text-[34px] font-bold tracking-tight text-fg">TeaBranch</Text>
          <Text class="mt-2 max-w-sm text-center text-[14px] text-fg-2">{t('并行运行每个分支——各有自己的 worktree、端口和数据库。')}</Text>
        </View>
        <Button tone="accent" class="h-9 px-5" onPress={() => void app.chooseProject()}>
          {t('选择仓库…')}
        </Button>
        <If when={app.error()}>
          <View class="rounded-md bg-err-soft px-3 py-2">
            <Text class="text-[13px] text-err">{app.error()}</Text>
          </View>
        </If>
      </View>
    </View>
  )
}
