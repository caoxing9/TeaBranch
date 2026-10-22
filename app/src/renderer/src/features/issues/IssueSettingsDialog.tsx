import { type ReactNode, useEffect, useState } from 'react'
import type { AgentAccess, AgentEffort, AgentModel, ReviewEngine, TeableConfig } from '@shared/types'
import { agentAccessModes, agentEfforts, agentModelLabel } from '@shared/types'
import { Button, Dialog, inputClass, Segmented, Toggle } from '@/components/kit'
import { api } from '@/lib/api'
import { assigneeGuess, isUserField, mapping } from '@/lib/issues'
import { useIssues } from '@/store/issues'

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
      <select value={key(value)} onChange={(e) => pick(e.target.value)} className={inputClass}>
        {options.map((option) => (
          <option key={key(option)} value={key(option)}>
            {agentModelLabel(option)}
          </option>
        ))}
      </select>
      <select
        value={value.effort ?? ''}
        onChange={(e) => onChange({ ...value, effort: (e.target.value || undefined) as AgentEffort | undefined })}
        className={`${inputClass} w-32 shrink-0`}
        title="思考等级"
      >
        <option value="">默认思考</option>
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
  const [tableURL, setTableURL] = useState('')
  const [tableError, setTableError] = useState<string | null>(null)
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

  const fieldSelect = (key: 'titleField' | 'bodyField' | 'statusField' | 'idField' | 'prField', guess?: string, none = '自动') => (
    <select value={config[key] ?? ''} onChange={(e) => update({ [key]: e.target.value || undefined })} className={inputClass}>
      <option value="">{guess ? `${none}（${guess}）` : none}</option>
      {state.fields.map((field) => (
        <option key={field.id} value={field.name}>
          {field.name}
        </option>
      ))}
    </select>
  )

  return (
    <Dialog title="Issue 自动修复" onClose={close} width={600}>
      <Group title="Teable 表" footer={`当前：${config.baseId} / ${config.tableId} / ${config.viewId ?? '—'}`}>
        <div className="flex gap-2">
          <input
            value={tableURL}
            onChange={(e) => setTableURL(e.target.value)}
            placeholder="粘贴 Teable 视图链接切换表格"
            className={inputClass}
          />
          <Button
            onClick={async () => {
              const match = /\/base\/([^/]+)\/table\/([^/?]+)(?:\/([^/?]+))?/.exec(tableURL)
              if (!match) return setTableError('需要形如 …/base/bse…/table/tbl…/viw… 的链接')
              setTableError(null)
              update({ baseURL: new URL(tableURL).origin, baseId: match[1], tableId: match[2], viewId: match[3] })
              setTableURL('')
            }}
          >
            应用
          </Button>
        </div>
        {tableError && <div className="text-[12px] text-err">{tableError}</div>}
      </Group>

      <Group title="字段映射">
        <Line label="标题">{fieldSelect('titleField', guessed.title)}</Line>
        <Line label="描述">{fieldSelect('bodyField', guessed.body)}</Line>
        <Line label="状态">{fieldSelect('statusField', guessed.status)}</Line>
        <Line label="Issue ID">{fieldSelect('idField', guessed.id)}</Line>
        <Toggle
          checked={config.onlyMine}
          onChange={(onlyMine) => update({ onlyMine })}
          label="只看分配给我的 issue（在 Teable 服务端筛选，别人的 issue 不会下载到本机）"
        />
        <Line label="负责人（只看我的）">
          <select
            value={config.assigneeField ?? ''}
            onChange={(e) => update({ assigneeField: e.target.value || undefined })}
            className={inputClass}
          >
            <option value="">自动（{assigneeGuess({ ...config, assigneeField: undefined }, state.fields) ?? '无'}）</option>
            {state.fields.filter(isUserField).map((field) => (
              <option key={field.id} value={field.name}>
                {field.name}
              </option>
            ))}
          </select>
        </Line>
        <Line label="回写 PR 链接到">{fieldSelect('prField', undefined, '不回写')}</Line>
        {statusChoices.length > 0 && (
          <Line label="提 PR 后状态改为">
            <select
              value={config.doneStatus ?? ''}
              onChange={(e) => update({ doneStatus: e.target.value || undefined })}
              className={inputClass}
            >
              <option value="">不修改</option>
              {statusChoices.map((choice) => (
                <option key={choice}>{choice}</option>
              ))}
            </select>
          </Line>
        )}
      </Group>

      <Group title="修复前验证">
        <Toggle
          checked={config.triage}
          onChange={(triage) => update({ triage })}
          label="先验证再修：查是否已被修复、本地复现、判断是不是 bug；只有确认是 bug 才自动修"
        />
      </Group>

      <Group
        title="自动模式与限流"
        footer="所有待修复的 issue 进同一个队列，每次取一批同时跑；整批都走完才切下一批。Issue 内容来自共享表格，开启自动模式意味着能编辑这张表的人都能驱动本机 agent（默认带 --dangerously-skip-permissions）。"
      >
        <Toggle
          checked={config.autoFix}
          onChange={(autoFix) => update({ autoFix })}
          label="自动模式：每 3 分钟读表，自动修复下面这些状态的 issue"
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
          <div className="pl-5 text-[12px] text-fg-3">映射“状态”字段后可选择自动修复哪些状态</div>
        )}
        <Line label="每批同时修复">
          <input
            type="number"
            min={1}
            max={10}
            value={config.batchSize}
            onChange={(e) => update({ batchSize: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
            className={`${inputClass} w-20`}
          />
        </Line>
        <Toggle
          checked={config.autoNextBatch}
          onChange={(autoNextBatch) => update({ autoNextBatch })}
          label="一批全部完成后自动开始下一批"
        />
        <Line label="分支前缀">
          <input
            value={config.branchPrefix}
            onChange={(e) => update({ branchPrefix: e.target.value })}
            placeholder="留空：分支名就是 issue id"
            className={inputClass}
          />
        </Line>
      </Group>

      <Group
        title="模型"
        footer={state.magpieError ?? (state.magpieModels.length ? `Magpie 提供 ${state.magpieModels.length} 个模型` : undefined)}
      >
        <Line label="修复用">
          <ModelSelect value={config.fixModel} onChange={(fixModel) => update({ fixModel })} magpie={state.magpieModels} />
        </Line>
        <Line label="权限">
          <select value={config.access} onChange={(e) => update({ access: e.target.value as AgentAccess })} className={inputClass}>
            {agentAccessModes.map((mode) => (
              <option key={mode.value} value={mode.value}>
                {mode.label}
              </option>
            ))}
          </select>
        </Line>
        <Line label="Review 引擎">
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
          <Line label="Codex 模型">
            <select value={config.codexModel} onChange={(e) => update({ codexModel: e.target.value })} className={inputClass}>
              <option value="">默认（~/.codex/config.toml）</option>
              {state.magpieModels
                .filter((model) => model.startsWith('codex/') || model.includes('gpt'))
                .map((model) => (
                  <option key={model}>{model}</option>
                ))}
              {config.codexModel && !state.magpieModels.includes(config.codexModel) && <option>{config.codexModel}</option>}
            </select>
          </Line>
        ) : (
          <Line label="Review 用">
            <ModelSelect value={config.reviewModel} onChange={(reviewModel) => update({ reviewModel })} magpie={state.magpieModels} />
          </Line>
        )}
        <Line label="Magpie 地址">
          <input value={config.magpieURL} onChange={(e) => update({ magpieURL: e.target.value })} className={inputClass} />
        </Line>
        <Line label="Magpie key（可选）">
          <div className="flex gap-2">
            <input type="password" value={magpieKey} onChange={(e) => setMagpieKey(e.target.value)} className={inputClass} />
            <Button
              onClick={async () => {
                if (magpieKey) await api.setMagpieKey(magpieKey)
                await state.loadMagpieModels()
              }}
            >
              刷新模型
            </Button>
          </div>
        </Line>
      </Group>

      <Group title="Review">
        <Toggle checked={config.autoReview} onChange={(autoReview) => update({ autoReview })} label="提 PR 后自动 review" />
        <Toggle
          checked={config.sendReviewToAgent}
          onChange={(sendReviewToAgent) => update({ sendReviewToAgent })}
          label="把 review 结果发给该 issue 的 agent 继续修改"
        />
        <Line label="最多 review → 修改轮数">
          <input
            type="number"
            min={1}
            max={5}
            value={config.maxReviewRounds}
            onChange={(e) => update({ maxReviewRounds: Math.max(1, Math.min(5, Number(e.target.value) || 1)) })}
            className={`${inputClass} w-20`}
          />
        </Line>
      </Group>
    </Dialog>
  )
}
