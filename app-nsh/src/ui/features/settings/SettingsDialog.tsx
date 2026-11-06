import { Text, View, resource, signal } from 'nsh'
import type { LanguagePref } from '../../../shared/i18n'
import { t } from '../../../shared/i18n'
import { applyLocale } from '../../../core/locale'
import { Button, Dialog, Group, Line, Segmented, TextInput } from '../../components/kit'
import { api } from '../../lib/api'
import { type Theme, app } from '../../store/app'
import { autopilot } from '../../store/autopilot'
import { issues } from '../../store/issues'
import { Choice, NumberInput } from '../autopilot/parts'

const custom = '__custom__'
/** `Choice` drops an empty value, so the system terminal (no app name) travels as this. */
const systemTerminal = '__system__'

/** The menu rebuilds itself from the locale listeners; the views are built again in the new language. */
async function changeLanguage(language: LanguagePref) {
  await app.updateSettings({ language })
  applyLocale(language)
  app.remountUi()
}

/**
 * The app's own settings — the look, the language, the repository, how terminals and agents are
 * started — reached from the gear beside the section switcher on every page, and ⌘,. Issue
 * auto-fix and autopilot keep their own pages; the last group leads there.
 */
export function SettingsDialog() {
  const close = () => app.set({ showSettings: false })
  const settings = () => app.settings()
  const presets = resource(() => api.terminalPresets())
  const agentCommand = signal(settings()?.agentCommand ?? '')
  const customApp = signal('')
  const chosen = signal<string | null>(null)
  const terminal = () => settings()?.terminalApp ?? ''
  const isPreset = () => (presets() ?? []).some((preset) => (preset.value ?? '') === terminal())
  const selection = () => chosen() ?? (presets()?.length ? (isPreset() ? terminal() || systemTerminal : custom) : '')
  const openIssueSettings = () => {
    close()
    issues.set({ showSettings: true })
  }
  const openAutopilot = () => {
    close()
    void autopilot.show('overview')
  }
  return (
    <Dialog title={t('设置')} onClose={close} width={560}>
      <Group title={t('外观')}>
        <Line label={t('主题')}>
          <Segmented<Theme>
            value={app.theme()}
            onChange={(theme) => app.setTheme(theme)}
            options={[
              { value: 'system', label: t('跟随系统') },
              { value: 'light', label: t('浅色') },
              { value: 'dark', label: t('深色') },
            ]}
          />
        </Line>
        <Line label={t('语言 / Language')}>
          <Segmented<LanguagePref>
            value={settings()?.language ?? 'system'}
            onChange={(language) => void changeLanguage(language)}
            options={[
              { value: 'system', label: t('跟随系统') },
              { value: 'zh', label: '中文' }, // i18n-ignore: each language names itself
              { value: 'en', label: 'English' },
            ]}
          />
        </Line>
      </Group>

      <Group title={t('仓库')} footer={t('每个分支的 dev server 从端口起点往上找空闲端口。')}>
        <Line label={t('路径')}>
          <View class="flex-row items-center gap-2">
            <Text class="min-w-0 flex-1 font-mono text-[12px] text-fg-2" style={{ numberOfLines: 1, userSelect: 'text' }}>
              {settings()?.projectPath ?? ''}
            </Text>
            <Button onPress={() => void app.chooseProject()}>{t('更换…')}</Button>
          </View>
        </Line>
        <Line label={t('端口起点')}>
          <NumberInput value={settings()?.basePort ?? 3001} min={1024} onSave={(basePort) => void app.updateSettings({ basePort })} />
        </Line>
      </Group>

      <Group title={t('终端')} footer={t('Otty 能直接在新标签里运行命令，也能告诉我们哪些 worktree 已经开着终端。')}>
        <Line label={t('终端应用')}>
          {/* Made once the presets are in: a select given its items later shows no title for its value. */}
          <If when={presets()}>
            {(presets) => (
              <Choice
                value={selection()}
                onChange={(value) => {
                  chosen.set(value)
                  if (value === custom) {
                    if (!isPreset() && terminal()) customApp.set(terminal())
                  } else void app.updateSettings({ terminalApp: value === systemTerminal ? undefined : value })
                }}
                options={[...presets().map((preset) => ({ value: preset.value ?? systemTerminal, label: preset.label })), { value: custom, label: t('自定义…') }]}
              />
            )}
          </If>
        </Line>
        <If when={selection() === custom}>
          <Line label={t('应用名')}>
            <View class="flex-row gap-2">
              <TextInput value={customApp()} onChange={(e) => customApp.set(e.value)} placeholder="WezTerm" class="flex-1" />
              <Button onPress={() => void app.updateSettings({ terminalApp: customApp().trim() || undefined })}>{t('保存')}</Button>
            </View>
          </Line>
        </If>
      </Group>

      <Group title="Agent" footer={t('“Agent” 按钮和 issue 自动修复都用它启动 Claude Code。写完整命令，别用 shell 别名。')}>
        <Line label={t('命令')}>
          <View class="flex-row gap-2">
            <TextInput value={agentCommand()} onChange={(e) => agentCommand.set(e.value)} class="flex-1 font-mono" />
            <Button disabled={agentCommand().trim() === settings()?.agentCommand} onPress={() => void app.updateSettings({ agentCommand: agentCommand().trim() })}>
              {t('保存')}
            </Button>
          </View>
        </Line>
      </Group>

      <Group title={t('更多')} footer={t('Issue 自动修复和托管各有自己的设置页。')}>
        <View class="flex-row flex-wrap gap-2">
          <Button onPress={openIssueSettings}>{t('Issue 设置…')}</Button>
          <Button onPress={openAutopilot}>{t('托管…')}</Button>
        </View>
      </Group>
    </Dialog>
  )
}
