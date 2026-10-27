import { type ReactNode, useEffect, useState } from 'react'
import type { AgentAccess, AgentEffort, AgentModel, PromptStage, ReviewEngine, TeableConfig } from '@shared/types'
import { agentAccessModes, agentEfforts, agentModelLabel, promptStages } from '@shared/types'
import { getLocale, t } from '@shared/i18n'
import { Button, Dialog, inputClass, Segmented, Toggle } from '@/components/kit'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { assigneeGuess, isUserField, mapping } from '@/lib/issues'
import { useIssues } from '@/store/issues'
import { TablePicker } from './TablePicker'

function Group({ title, footer, children }: { title: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-fg-3 uppercase">{title}</h3>
      <div className="space-y-2.5 rounded-lg bg-fill p-3">{children}</div>
      {footer && <p className="mt-1.5 px-1 text-[11px] text-fg-3">{footer}</p>}
    </section>
  )
}

function Line({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-36 shrink-0 text-[12px] text-fg-2">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** Model choices: Claude's own login, its aliases, and every model the Magpie gateway routes. */
function ModelSelect({ value, onChange, magpie }: { value: AgentModel; onChange: (m: AgentModel) => void; magpie: string[] }) {
  const options: AgentModel[] = [
    { provider: 'claude' },
    ...['opus', 'sonnet', 'haiku'].map((model) => ({ provider: 'claude' as const, model })),
    ...magpie.map((model) => ({ provider: 'magpie' as const, model })),
  ]
  const key = (m: AgentModel) => `${m.provider}:${m.model ?? ''}`
  if (!options.some((option) => key(option) === key(value))) options.push({ ...value, effort: undefined })
  const pick = (k: string) => {
    const option = options.find((o) => key(o) === k)
    if (option) onChange({ ...option, effort: value.effort })
  }
  return (
    <div className="flex gap-2">
      <select value={key(value)} onChange={(e) => pick(e.target.value)} className={cn(inputClass, 'flex-1')}>
        {options.map((option) => (
          <option key={key(option)} value={key(option)}>
            {agentModelLabel(option)}
          </option>
        ))}
      </select>
      <select
        value={value.effort ?? ''}
        onChange={(e) => onChange({ ...value, effort: (e.target.value || undefined) as AgentEffort | undefined })}
        className={cn(inputClass, 'w-32 shrink-0')}
        title={t('思考等级')}
      >
        <option value="">{t('默认思考')}</option>
        {agentEfforts.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}

export function IssueSettingsDialog() {
  const state = useIssues()
  const config = state.config
  const [magpieKey, setMagpieKey] = useState('')
  const close = () => useIssues.setState({ showSettings: false })

  // oxlint-disable-next-line react-hooks/exhaustive-deps -- once, when the dialog opens
  useEffect(() => void state.loadMagpieModels(), [])
  if (!config) return null

  const update = (patch: Partial<TeableConfig>) => void state.updateConfig(patch)
  const guessed = mapping(
    { ...config, titleField: undefined, bodyField: undefined, statusField: undefined, idField: undefined },
    state.fields,
  )
  const statusChoices = state.fields.find((field) => field.name === (config.statusField ?? guessed.status))?.choices ?? []

  const fieldSelect = (key: 'titleField' | 'bodyField' | 'statusField' | 'idField' | 'prField', guess?: string, none = t('自动')) => (
    <select value={config[key] ?? ''} onChange={(e) => update({ [key]: e.target.value || undefined })} className={inputClass}>
      <option value="">{guess ? t('{none}（{guess}）', { none, guess }) : none}</option>
      {state.fields.map((field) => (
        <option key={field.id} value={field.name}>
          {field.name}
        </option>
      ))}
    </select>
  )

  return (
    <Dialog title={t('Issue 自动修复')} onClose={close} width={600}>
      <Group title={t('Teable 表')}>
        <TablePicker value={config} onPick={(pick) => update({ baseId: pick.baseId, tableId: pick.tableId, viewId: pick.viewId })} />
      </Group>

      <Group title={t('字段映射')}>
        <Line label={t('标题')}>{fieldSelect('titleField', guessed.title)}</Line>
        <Line label={t('描述')}>{fieldSelect('bodyField', guessed.body)}</Line>
        <Line label={t('状态')}>{fieldSelect('statusField', guessed.status)}</Line>
        <Line label="Issue ID">{fieldSelect('idField', guessed.id)}</Line>
        <Toggle
          checked={config.onlyMine}
          onChange={(onlyMine) => update({ onlyMine })}
          label={t('只看分配给我的 issue（在 Teable 服务端筛选，别人的 issue 不会下载到本机）')}
        />
        <Line label={t('负责人（只看我的）')}>
          <select
            value={config.assigneeField ?? ''}
            onChange={(e) => update({ assigneeField: e.target.value || undefined })}
            className={inputClass}
          >
            <option value="">
              {t('自动（{guess}）', { guess: assigneeGuess({ ...config, assigneeField: undefined }, state.fields) ?? t('无') })}
            </option>
            {state.fields.filter(isUserField).map((field) => (
              <option key={field.id} value={field.name}>
                {field.name}
              </option>
            ))}
          </select>
        </Line>
        <Line label={t('回写 PR 链接到')}>{fieldSelect('prField', undefined, t('不回写'))}</Line>
        {statusChoices.length > 0 && (
          <Line label={t('提 PR 后状态改为')}>
            <select
              value={config.doneStatus ?? ''}
              onChange={(e) => update({ doneStatus: e.target.value || undefined })}
              className={inputClass}
            >
              <option value="">{t('不修改')}</option>
              {statusChoices.map((choice) => (
                <option key={choice}>{choice}</option>
              ))}
            </select>
          </Line>
        )}
      </Group>

      <Group title={t('修复前验证')}>
        <Toggle
          checked={config.triage}
          onChange={(triage) => update({ triage })}
          label={t('先验证再修：查是否已被修复、本地复现、判断是不是 bug；只有确认是 bug 才自动修')}
        />
      </Group>

      <Group
        title={t('自动模式与限流')}
        footer={[
          t('所有待修复的 issue 进同一个队列，最多同时跑 N 个，跑完一个就补上下一个。'),
          t('Issue 内容来自共享表格，开启自动模式意味着能编辑这张表的人都能驱动本机 agent（默认带 {flag}）。', {
            flag: '--dangerously-skip-permissions',
          }),
        ].join(getLocale() === 'en' ? ' ' : '')}
      >
        <Toggle
          checked={config.autoFix}
          onChange={(autoFix) => update({ autoFix })}
          label={t('自动模式：每 3 分钟读表，自动修复下面这些状态的 issue')}
        />
        {statusChoices.length > 0 ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1 pl-5">
            {statusChoices.map((choice) => (
              <Toggle
                key={choice}
                checked={config.fixStatuses.includes(choice)}
                onChange={(on) =>
                  update({ fixStatuses: on ? [...config.fixStatuses, choice] : config.fixStatuses.filter((s) => s !== choice) })
                }
                label={choice}
              />
            ))}
          </div>
        ) : (
          <div className="pl-5 text-[12px] text-fg-3">{t('映射“状态”字段后可选择自动修复哪些状态')}</div>
        )}
        <Line label={t('最多同时修复')}>
          <input
            type="number"
            min={1}
            max={10}
            value={config.batchSize}
            onChange={(e) => update({ batchSize: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
            className={cn(inputClass, 'w-20')}
          />
        </Line>
        <Line label={t('分支前缀')}>
          <input
            value={config.branchPrefix}
            onChange={(e) => update({ branchPrefix: e.target.value })}
            placeholder={t('留空：分支名就是 issue id')}
            className={inputClass}
          />
        </Line>
      </Group>

      <Group
        title={t('模型')}
        footer={
          state.magpieError ?? (state.magpieModels.length ? t('Magpie 提供 {n} 个模型', { n: state.magpieModels.length }) : undefined)
        }
      >
        <Line label={t('修复用')}>
          <ModelSelect value={config.fixModel} onChange={(fixModel) => update({ fixModel })} magpie={state.magpieModels} />
        </Line>
        <Line label={t('权限')}>
          <select value={config.access} onChange={(e) => update({ access: e.target.value as AgentAccess })} className={inputClass}>
            {agentAccessModes.map((mode) => (
              <option key={mode.value} value={mode.value}>
                {mode.label}
              </option>
            ))}
          </select>
        </Line>
        <Line label={t('Review 引擎')}>
          <Segmented<ReviewEngine>
            value={config.reviewEngine}
            onChange={(reviewEngine) => update({ reviewEngine })}
            options={[
              { value: 'codex', label: 'Codex CLI' },
              { value: 'claude', label: 'Claude Code' },
            ]}
          />
        </Line>
        {config.reviewEngine === 'codex' ? (
          <Line label={t('Codex 模型')}>
            <select value={config.codexModel} onChange={(e) => update({ codexModel: e.target.value })} className={inputClass}>
              <option value="">{t('默认（~/.codex/config.toml）')}</option>
              {state.magpieModels
                .filter((model) => model.startsWith('codex/') || model.includes('gpt'))
                .map((model) => (
                  <option key={model}>{model}</option>
                ))}
              {config.codexModel && !state.magpieModels.includes(config.codexModel) && <option>{config.codexModel}</option>}
            </select>
          </Line>
        ) : (
          <Line label={t('Review 用')}>
            <ModelSelect value={config.reviewModel} onChange={(reviewModel) => update({ reviewModel })} magpie={state.magpieModels} />
          </Line>
        )}
        <Line label={t('Magpie 地址')}>
          <input value={config.magpieURL} onChange={(e) => update({ magpieURL: e.target.value })} className={inputClass} />
        </Line>
        <Line label={t('Magpie key（可选）')}>
          <div className="flex gap-2">
            <input type="password" value={magpieKey} onChange={(e) => setMagpieKey(e.target.value)} className={inputClass} />
            <Button
              onClick={async () => {
                if (magpieKey) await api.setMagpieKey(magpieKey)
                await state.loadMagpieModels()
              }}
            >
              {t('刷新模型')}
            </Button>
          </div>
        </Line>
      </Group>

      <Group title="Review">
        <Toggle checked={config.autoReview} onChange={(autoReview) => update({ autoReview })} label={t('提 PR 后自动 review')} />
        <Toggle
          checked={config.sendReviewToAgent}
          onChange={(sendReviewToAgent) => update({ sendReviewToAgent })}
          label={t('把 review 结果发给该 issue 的 agent 继续修改')}
        />
        <Line label={t('最多 review → 修改轮数')}>
          <input
            type="number"
            min={1}
            max={5}
            value={config.maxReviewRounds}
            onChange={(e) => update({ maxReviewRounds: Math.max(1, Math.min(5, Number(e.target.value) || 1)) })}
            className={cn(inputClass, 'w-20')}
          />
        </Line>
      </Group>

      <Group title="CI">
        <Toggle
          checked={config.autoFixCI}
          onChange={(autoFixCI) => update({ autoFixCI })}
          label={t('PR 的 CI 全部跑完后有失败，自动发给该 issue 的 agent 修')}
        />
        <Line label={t('每个 issue 最多自动发几轮')}>
          <input
            type="number"
            min={1}
            max={5}
            value={config.maxCIRounds}
            onChange={(e) => update({ maxCIRounds: Math.max(1, Math.min(5, Number(e.target.value) || 1)) })}
            className={cn(inputClass, 'w-20')}
          />
        </Line>
      </Group>

      <PromptsGroup prompts={config.prompts} onChange={(prompts) => update({ prompts })} />
    </Dialog>
  )
}

const stageLabel = (stage: PromptStage): string =>
  ({ triage: t('修复前验证'), fix: t('修复'), review: 'Review', reviewFeedback: t('处理 Review 意见') })[stage]

/**
 * Your own instructions per stage. The box shows the override or the default; only text that
 * differs from the default is stored, so clearing it or restoring the default drops the override.
 */
function PromptsGroup({ prompts, onChange }: { prompts: TeableConfig['prompts']; onChange: (prompts: TeableConfig['prompts']) => void }) {
  const [defaults, setDefaults] = useState<Record<PromptStage, string> | null>(null)
  const [stage, setStage] = useState<PromptStage>('fix')
  /** What's being typed, until it is saved; null shows the stored text. */
  const [draft, setDraft] = useState<string | null>(null)

  useEffect(() => void api.defaultPrompts().then(setDefaults), [])

  const save = (target: PromptStage, text: string) => {
    if (!defaults) return
    const value = text.trim() && text.trim() !== defaults[target].trim() ? text : undefined
    if (value !== prompts?.[target]) onChange({ ...prompts, [target]: value })
  }

  // Debounced save while typing; blur and switching stage save at once.
  useEffect(() => {
    if (draft === null) return
    const timer = setTimeout(() => save(stage, draft), 800)
    return () => clearTimeout(timer)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- save reads the latest props
  }, [draft, stage])

  const flush = () => {
    if (draft !== null) save(stage, draft)
  }
  const custom = (s: PromptStage) => !!prompts?.[s]

  return (
    <Group
      title={t('自定义 Prompt')}
      footer={
        <>
          {t('Issue 的字段、评论、附件和 worktree 信息总会自动附上，结尾的 TRIAGE / VERDICT 行也由 TeaBranch 追加。可用占位符：')}
          <span className="font-mono">{' {key} {link} {branch} {base} {round} {language}'}</span>
        </>
      }
    >
      <Segmented<PromptStage>
        value={stage}
        onChange={(next) => {
          flush()
          setDraft(null)
          setStage(next)
        }}
        options={promptStages.map((value) => ({
          value,
          label: (
            <span className="inline-flex items-center gap-1">
              {stageLabel(value)}
              {custom(value) && <span className="size-1.5 rounded-full bg-brand" title={t('已自定义')} />}
            </span>
          ),
        }))}
      />
      <textarea
        value={draft ?? prompts?.[stage] ?? defaults?.[stage] ?? ''}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={flush}
        disabled={!defaults}
        spellCheck={false}
        rows={10}
        className={cn(inputClass, 'h-auto resize-y py-2 font-mono text-[11.5px] leading-relaxed')}
      />
      <div className="flex items-center gap-2 text-[11px] text-fg-3">
        <span>{custom(stage) ? t('已自定义') : t('使用默认')}</span>
        <div className="flex-1" />
        <Button
          disabled={!custom(stage)}
          onClick={() => {
            setDraft(null)
            onChange({ ...prompts, [stage]: undefined })
          }}
        >
          {t('恢复默认')}
        </Button>
      </div>
    </Group>
  )
}
