import { useEffect, useState } from 'react'
import type { LanguagePref } from '@shared/i18n'
import { t } from '@shared/i18n'
import type { TerminalPreset } from '@shared/types'
import { Button, Dialog, Group, inputClass, Line, Segmented } from '@/components/kit'
import { NumberInput } from '@/features/autopilot/parts'
import { api } from '@/lib/api'
import { REOPEN_SETTINGS_KEY, type Theme, useApp } from '@/store/app'
import { useAutopilot } from '@/store/autopilot'
import { useIssues } from '@/store/issues'

const custom = '__custom__'

/** Main rebuilds its menu itself; the renderer reloads into the new language, with this dialog back open. */
async function changeLanguage(language: LanguagePref) {
  await api.updateSettings({ language })
  try {
    sessionStorage.setItem(REOPEN_SETTINGS_KEY, '1')
  } catch {
    // Then the dialog stays closed after the reload.
  }
  location.reload()
}

/**
 * The app's own settings — the look, the language, the repository, how terminals and agents are
 * started — reached from the gear beside the section switcher on every page, and ⌘,. Issue
 * auto-fix and autopilot keep their own pages; the last group leads there.
 */
export function SettingsDialog() {
  const close = () => useApp.setState({ showSettings: false })
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const chooseProject = useApp((s) => s.chooseProject)
  const theme = useApp((s) => s.theme)
  const setTheme = useApp((s) => s.setTheme)
  const [presets, setPresets] = useState<TerminalPreset[]>([])
  const [agentCommand, setAgentCommand] = useState(settings?.agentCommand ?? '')
  const [customApp, setCustomApp] = useState('')

  useEffect(() => void api.terminalPresets().then(setPresets), [])

  const terminal = settings?.terminalApp
  const isPreset = presets.some((preset) => (preset.value ?? '') === (terminal ?? ''))
  const [selection, setSelection] = useState<string>('')
  useEffect(() => {
    if (presets.length) setSelection(isPreset ? (terminal ?? '') : custom)
    if (!isPreset && terminal) setCustomApp(terminal)
  }, [presets, isPreset, terminal])

  const openIssueSettings = () => {
    close()
    useIssues.setState({ showSettings: true })
  }
  const openAutopilot = () => {
    close()
    void useAutopilot.getState().show('overview')
  }

  return (
    <Dialog title={t('设置')} onClose={close} width={560}>
      <Group title={t('外观')}>
        <Line label={t('主题')}>
          <Segmented<Theme>
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'system', label: t('跟随系统') },
              { value: 'light', label: t('浅色') },
              { value: 'dark', label: t('深色') },
            ]}
          />
        </Line>
        <Line label={t('语言 / Language')}>
          <Segmented<LanguagePref>
            value={settings?.language ?? 'system'}
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
          <div className="flex items-center gap-2">
            <span className="selectable min-w-0 flex-1 truncate font-mono text-[12px] text-fg-2" title={settings?.projectPath}>
              {settings?.projectPath}
            </span>
            <Button onClick={() => void chooseProject()}>{t('更换…')}</Button>
          </div>
        </Line>
        <Line label={t('端口起点')}>
          <NumberInput value={settings?.basePort ?? 3001} min={1024} onSave={(basePort) => void updateSettings({ basePort })} />
        </Line>
      </Group>

      <Group title={t('终端')} footer={t('Otty 能直接在新标签里运行命令，也能告诉我们哪些 worktree 已经开着终端。')}>
        <Line label={t('终端应用')}>
          <select
            value={selection}
            onChange={(event) => {
              setSelection(event.target.value)
              if (event.target.value !== custom) void updateSettings({ terminalApp: event.target.value || undefined })
            }}
            className={inputClass}
          >
            {presets.map((preset) => (
              <option key={preset.label} value={preset.value ?? ''}>
                {preset.label}
              </option>
            ))}
            <option value={custom}>{t('自定义…')}</option>
          </select>
        </Line>
        {selection === custom && (
          <Line label={t('应用名')}>
            <div className="flex gap-2">
              <input value={customApp} onChange={(e) => setCustomApp(e.target.value)} placeholder="WezTerm" className={inputClass} />
              <Button onClick={() => void updateSettings({ terminalApp: customApp.trim() || undefined })}>{t('保存')}</Button>
            </div>
          </Line>
        )}
      </Group>

      <Group title="Agent" footer={t('“Agent” 按钮和 issue 自动修复都用它启动 Claude Code。写完整命令，别用 shell 别名。')}>
        <Line label={t('命令')}>
          <div className="flex gap-2">
            <input value={agentCommand} onChange={(e) => setAgentCommand(e.target.value)} className={`${inputClass} font-mono`} />
            <Button
              disabled={agentCommand.trim() === settings?.agentCommand}
              onClick={() => void updateSettings({ agentCommand: agentCommand.trim() })}
            >
              {t('保存')}
            </Button>
          </div>
        </Line>
      </Group>

      <Group title={t('更多')} footer={t('Issue 自动修复和托管各有自己的设置页。')}>
        <div className="flex flex-wrap gap-2">
          <Button onClick={openIssueSettings}>{t('Issue 设置…')}</Button>
          <Button onClick={openAutopilot}>{t('托管…')}</Button>
        </div>
      </Group>
    </Dialog>
  )
}
