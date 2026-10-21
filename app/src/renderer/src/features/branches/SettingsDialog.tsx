import { useEffect, useState } from 'react'
import type { TerminalPreset } from '@shared/types'
import { Button, Dialog, Field, inputClass, Segmented } from '@/components/kit'
import { api } from '@/lib/api'
import { type Theme, useApp } from '@/store/app'

const custom = '__custom__'

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
    <Dialog title="设置" onClose={close} width={480}>
      <Field label="终端" hint="Otty 能直接在新标签里运行命令，也能告诉我们哪些 worktree 已经开着终端。">
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
          <option value={custom}>自定义…</option>
        </select>
      </Field>
      {selection === custom && (
        <Field label="应用名">
          <div className="flex gap-2">
            <input value={customApp} onChange={(e) => setCustomApp(e.target.value)} placeholder="WezTerm" className={inputClass} />
            <Button onClick={() => void updateSettings({ terminalApp: customApp.trim() || undefined })}>保存</Button>
          </div>
        </Field>
      )}
      <Field label="Agent 命令" hint="“Agent” 按钮和 issue 自动修复都用它启动 Claude Code。写完整命令，别用 shell 别名。">
        <div className="flex gap-2">
          <input value={agentCommand} onChange={(e) => setAgentCommand(e.target.value)} className={`${inputClass} font-mono`} />
          <Button
            disabled={agentCommand.trim() === settings?.agentCommand}
            onClick={() => void updateSettings({ agentCommand: agentCommand.trim() })}
          >
            保存
          </Button>
        </div>
      </Field>
      <Field label="外观">
        <Segmented<Theme>
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'system', label: '跟随系统' },
            { value: 'light', label: '浅色' },
            { value: 'dark', label: '深色' },
          ]}
        />
      </Field>
      <Field label="仓库">
        <div className="selectable truncate font-mono text-[12px] text-fg-2">{settings?.projectPath}</div>
      </Field>
    </Dialog>
  )
}
