import { useEffect, useState } from 'react'
import type { LanguagePref } from '@shared/i18n'
import { t } from '@shared/i18n'
import type { TerminalPreset } from '@shared/types'
import { Button, Dialog, Field, inputClass, Segmented } from '@/components/kit'
import { api } from '@/lib/api'
import { type Theme, useApp } from '@/store/app'

const custom = '__custom__'

/** Main rebuilds its menu itself; the renderer simply reloads into the new language. */
async function changeLanguage(language: LanguagePref) {
  await api.updateSettings({ language })
  location.reload()
}

export function SettingsDialog() {
  const close = () => useApp.setState({ showSettings: false })
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
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

  return (
    <Dialog title={t('设置')} onClose={close} width={480}>
      <Field label={t('终端')} hint={t('Otty 能直接在新标签里运行命令，也能告诉我们哪些 worktree 已经开着终端。')}>
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
      </Field>
      {selection === custom && (
        <Field label={t('应用名')}>
          <div className="flex gap-2">
            <input value={customApp} onChange={(e) => setCustomApp(e.target.value)} placeholder="WezTerm" className={inputClass} />
            <Button onClick={() => void updateSettings({ terminalApp: customApp.trim() || undefined })}>{t('保存')}</Button>
          </div>
        </Field>
      )}
      <Field label={t('Agent 命令')} hint={t('“Agent” 按钮和 issue 自动修复都用它启动 Claude Code。写完整命令，别用 shell 别名。')}>
        <div className="flex gap-2">
          <input value={agentCommand} onChange={(e) => setAgentCommand(e.target.value)} className={`${inputClass} font-mono`} />
          <Button
            disabled={agentCommand.trim() === settings?.agentCommand}
            onClick={() => void updateSettings({ agentCommand: agentCommand.trim() })}
          >
            {t('保存')}
          </Button>
        </div>
      </Field>
      <Field label={t('外观')}>
        <Segmented<Theme>
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'system', label: t('跟随系统') },
            { value: 'light', label: t('浅色') },
            { value: 'dark', label: t('深色') },
          ]}
        />
      </Field>
      <Field label={t('语言 / Language')}>
        <Segmented<LanguagePref>
          value={settings?.language ?? 'system'}
          onChange={(language) => void changeLanguage(language)}
          options={[
            { value: 'system', label: t('跟随系统') },
            { value: 'zh', label: '中文' }, // i18n-ignore: each language names itself
            { value: 'en', label: 'English' },
          ]}
        />
      </Field>
      <Field label={t('仓库')}>
        <div className="selectable truncate font-mono text-[12px] text-fg-2">{settings?.projectPath}</div>
      </Field>
    </Dialog>
  )
}
