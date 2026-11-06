import { type JSX, Text, View, cleanup, effect, resource, signal } from 'nsh'
import { getLocale, t } from '../../../shared/i18n'
import { assigneeGuess, isUserField, mapping } from '../../../shared/issues'
import type { AgentAccess, AgentEffort, AgentModel, PromptStage, ReviewEngine, TeableConfig } from '../../../shared/types'
import { agentAccessModes, agentEfforts, agentModelLabel, promptStages } from '../../../shared/types'
import { Button, Dialog, Group, Line, Segmented, TextInput, Toggle } from '../../components/kit'
import { api } from '../../lib/api'
import { cn } from '../../lib/utils'
import { issues } from '../../store/issues'
import { Choice, NumberInput } from '../autopilot/parts'
import { TablePicker } from './TablePicker'

/** `Choice` drops an empty value, so "none" travels as this and comes back as undefined. */
const NONE = '__none__'

/** Model choices: Claude's own login, its aliases, and every model the Magpie gateway routes. */
function ModelSelect(props: { value: AgentModel; onChange: (m: AgentModel) => void; magpie: string[] }) {
  const key = (m: AgentModel) => `${m.provider}:${m.model ?? ''}`
  const options = (): AgentModel[] => {
    const list: AgentModel[] = [
      { provider: 'claude' },
      ...['opus', 'sonnet', 'haiku'].map((model) => ({ provider: 'claude' as const, model })),
      ...props.magpie.map((model) => ({ provider: 'magpie' as const, model })),
    ]
    if (!list.some((option) => key(option) === key(props.value))) list.push({ ...props.value, effort: undefined })
    return list
  }
  const pick = (k: string) => {
    const option = options().find((o) => key(o) === k)
    if (option) props.onChange({ ...option, effort: props.value.effort })
  }
  return (
    <View class="flex-row gap-2">
      <Choice
        class="flex-1"
        value={key(props.value)}
        options={options().map((option) => ({
          value: key(option),
          label: agentModelLabel(option),
        }))}
        onChange={pick}
      />
      <Choice
        class="w-32 shrink-0"
        value={props.value.effort ?? NONE}
        options={[{ value: NONE, label: t('默认思考') }, ...agentEfforts.map((option) => ({ value: option.value as string, label: option.label }))]}
        onChange={(effort) =>
          props.onChange({
            ...props.value,
            effort: effort === NONE ? undefined : (effort as AgentEffort),
          })
        }
      />
    </View>
  )
}

type Tab = 'teable' | 'fix' | 'model' | 'review' | 'prompt'

const tabs = (): { value: Tab; label: string }[] => [
  { value: 'teable', label: 'Teable' },
  { value: 'fix', label: t('修复') },
  { value: 'model', label: t('模型') },
  { value: 'review', label: 'Review' },
  { value: 'prompt', label: 'Prompt' },
]

/** The Issue auto-fix settings, a tab per concern. Every pane stays made: a prompt being typed survives a look at another tab. */
export function IssueSettingsDialog() {
  const magpieKey = signal('')
  const tab = signal<Tab>('teable')
  const close = () => issues.set({ showSettings: false })
  const pane = (key: Tab, children: JSX.Element) => <View class={cn(tab() !== key && 'hidden')}>{children}</View>
  void issues.loadMagpieModels()
  const update = (patch: Partial<TeableConfig>) => void issues.updateConfig(patch)
  const guessed = () => {
    const config = issues.config()
    return config
      ? mapping(
          {
            ...config,
            titleField: undefined,
            bodyField: undefined,
            statusField: undefined,
            idField: undefined,
          },
          issues.fields(),
        )
      : null
  }
  const statusChoices = () => {
    const config = issues.config()
    return issues.fields().find((field) => field.name === (config?.statusField ?? guessed()?.status))?.choices ?? []
  }
  const fieldOptions = (noneLabel: string, fields = issues.fields()) => [
    { value: NONE, label: noneLabel },
    ...fields.map((field) => ({ value: field.name, label: field.name })),
  ]
  const fieldSelect = (config: TeableConfig, key: 'titleField' | 'bodyField' | 'statusField' | 'idField' | 'prField', guess?: string, none = t('自动')) => (
    <Choice
      value={config[key] ?? NONE}
      options={fieldOptions(guess ? t('{none}（{guess}）', { none, guess }) : none)}
      onChange={(value) => update({ [key]: value === NONE ? undefined : value })}
    />
  )
  return (
    <If when={issues.config()}>
      {(config) => (
        <Dialog
          title={t('Issue 自动修复')}
          onClose={close}
          width={600}
          toolbar={<Segmented<Tab> value={tab()} onChange={(next) => tab.set(next)} options={tabs()} />}
        >
          {pane(
            'teable',
            <>
              <Group title={t('Teable 表')}>
                <TablePicker value={config()} onPick={(pick) => update({ baseId: pick.baseId, tableId: pick.tableId, viewId: pick.viewId })} />
              </Group>

              <Group title={t('字段映射')}>
                <Line label={t('标题')}>{fieldSelect(config(), 'titleField', guessed()?.title)}</Line>
                <Line label={t('描述')}>{fieldSelect(config(), 'bodyField', guessed()?.body)}</Line>
                <Line label={t('状态')}>{fieldSelect(config(), 'statusField', guessed()?.status)}</Line>
                <Line label="Issue ID">{fieldSelect(config(), 'idField', guessed()?.id)}</Line>
                <Toggle
                  checked={config().onlyMine}
                  onChange={(onlyMine) => update({ onlyMine })}
                  label={t('只看分配给我的 issue（在 Teable 服务端筛选，别人的 issue 不会下载到本机）')}
                />
                <Line label={t('负责人（只看我的）')}>
                  <Choice
                    value={config().assigneeField ?? NONE}
                    options={fieldOptions(
                      t('自动（{guess}）', {
                        guess: assigneeGuess({ ...config(), assigneeField: undefined }, issues.fields()) ?? t('无'),
                      }),
                      issues.fields().filter(isUserField),
                    )}
                    onChange={(value) => update({ assigneeField: value === NONE ? undefined : value })}
                  />
                </Line>
                <Line label={t('回写 PR 链接到')}>{fieldSelect(config(), 'prField', undefined, t('不回写'))}</Line>
                <If when={statusChoices().length > 0}>
                  <Line label={t('提 PR 后状态改为')}>
                    <Choice
                      value={config().doneStatus ?? NONE}
                      options={[{ value: NONE, label: t('不修改') }, ...statusChoices().map((choice) => ({ value: choice, label: choice }))]}
                      onChange={(value) => update({ doneStatus: value === NONE ? undefined : value })}
                    />
                  </Line>
                </If>
              </Group>
            </>,
          )}

          {pane(
            'fix',
            <>
              <Group title={t('修复前验证')}>
                <Toggle
                  checked={config().triage}
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
                  checked={config().autoFix}
                  onChange={(autoFix) => update({ autoFix })}
                  label={t('自动模式：每 3 分钟读表，自动修复下面这些状态的 issue')}
                />
                <If when={statusChoices().length > 0} else={<Text class="pl-5 text-[12px] text-fg-3">{t('映射“状态”字段后可选择自动修复哪些状态')}</Text>}>
                  <View class="flex-row flex-wrap gap-x-4 gap-y-1 pl-5">
                    <Each of={statusChoices()} key={(choice) => choice}>
                      {(choice) => (
                        <Toggle
                          checked={config().fixStatuses.includes(choice())}
                          onChange={(on) =>
                            update({
                              fixStatuses: on ? [...config().fixStatuses, choice()] : config().fixStatuses.filter((s) => s !== choice()),
                            })
                          }
                          label={choice()}
                        />
                      )}
                    </Each>
                  </View>
                </If>
                <Line label={t('最多同时修复')}>
                  <NumberInput value={config().batchSize} min={1} onSave={(value) => update({ batchSize: Math.max(1, Math.min(10, value || 1)) })} />
                </Line>
                <Line label={t('分支前缀')}>
                  <TextInput value={config().branchPrefix} onChange={(e) => update({ branchPrefix: e.value })} placeholder={t('留空：分支名就是 issue id')} />
                </Line>
              </Group>
            </>,
          )}

          {pane(
            'model',
            <Group
              title={t('模型')}
              footer={issues.magpieError() ?? (issues.magpieModels().length ? t('Magpie 提供 {n} 个模型', { n: issues.magpieModels().length }) : undefined)}
            >
              <Line label={t('修复用')}>
                <ModelSelect value={config().fixModel} onChange={(fixModel) => update({ fixModel })} magpie={issues.magpieModels()} />
              </Line>
              <Line label={t('权限')}>
                <Choice
                  value={config().access}
                  options={agentAccessModes.map((mode) => ({
                    value: mode.value as string,
                    label: mode.label,
                  }))}
                  onChange={(access) => update({ access: access as AgentAccess })}
                />
              </Line>
              <Line label={t('Review 引擎')}>
                <Segmented<ReviewEngine>
                  value={config().reviewEngine}
                  onChange={(reviewEngine) => update({ reviewEngine })}
                  options={[
                    { value: 'codex', label: 'Codex CLI' },
                    { value: 'claude', label: 'Claude Code' },
                  ]}
                />
              </Line>
              <If
                when={config().reviewEngine === 'codex'}
                else={
                  <Line label={t('Review 用')}>
                    <ModelSelect value={config().reviewModel} onChange={(reviewModel) => update({ reviewModel })} magpie={issues.magpieModels()} />
                  </Line>
                }
              >
                <Line label={t('Codex 模型')}>
                  <Choice
                    value={config().codexModel || NONE}
                    options={[
                      { value: NONE, label: t('默认（~/.codex/config.toml）') },
                      ...issues
                        .magpieModels()
                        .filter((model) => model.startsWith('codex/') || model.includes('gpt'))
                        .map((model) => ({ value: model, label: model })),
                      ...(config().codexModel && !issues.magpieModels().includes(config().codexModel)
                        ? [{ value: config().codexModel, label: config().codexModel }]
                        : []),
                    ]}
                    onChange={(value) => update({ codexModel: value === NONE ? '' : value })}
                  />
                </Line>
              </If>
              <Line label={t('Magpie 地址')}>
                <TextInput value={config().magpieURL} onChange={(e) => update({ magpieURL: e.value })} />
              </Line>
              <Line label={t('Magpie key（可选）')}>
                <View class="flex-row gap-2">
                  <TextInput masked value={magpieKey()} onChange={(e) => magpieKey.set(e.value)} class="flex-1" />
                  <Button
                    onPress={async () => {
                      if (magpieKey()) await api.setMagpieKey(magpieKey())
                      await issues.loadMagpieModels()
                    }}
                  >
                    {t('刷新模型')}
                  </Button>
                </View>
              </Line>
            </Group>,
          )}

          {pane(
            'review',
            <>
              <Group title="Review">
                <Toggle checked={config().autoReview} onChange={(autoReview) => update({ autoReview })} label={t('提 PR 后自动 review')} />
                <Toggle
                  checked={config().sendReviewToAgent}
                  onChange={(sendReviewToAgent) => update({ sendReviewToAgent })}
                  label={t('把 review 结果发给该 issue 的 agent 继续修改')}
                />
                <Line label={t('最多 review → 修改轮数')}>
                  <NumberInput value={config().maxReviewRounds} min={1} onSave={(value) => update({ maxReviewRounds: Math.max(1, Math.min(5, value || 1)) })} />
                </Line>
              </Group>

              <Group title="CI">
                <Toggle
                  checked={config().autoFixCI}
                  onChange={(autoFixCI) => update({ autoFixCI })}
                  label={t('PR 的 CI 全部跑完后有失败，自动发给该 issue 的 agent 修')}
                />
                <Line label={t('每个 issue 最多自动发几轮')}>
                  <NumberInput value={config().maxCIRounds} min={1} onSave={(value) => update({ maxCIRounds: Math.max(1, Math.min(5, value || 1)) })} />
                </Line>
              </Group>
            </>,
          )}

          {pane('prompt', <PromptsGroup prompts={config().prompts} onChange={(prompts) => update({ prompts })} />)}
        </Dialog>
      )}
    </If>
  )
}

const stageLabel = (stage: PromptStage): string =>
  ({
    triage: t('修复前验证'),
    fix: t('修复'),
    review: 'Review',
    reviewFeedback: t('处理 Review 意见'),
  })[stage]

/**
 * Your own instructions per stage. The box shows the override or the default; only text that
 * differs from the default is stored, so clearing it or restoring the default drops the override.
 */
function PromptsGroup(props: { prompts: TeableConfig['prompts']; onChange: (prompts: TeableConfig['prompts']) => void }) {
  const defaults = resource(
    () => 'defaults',
    () => api.defaultPrompts(),
  )
  const stage = signal<PromptStage>('fix')
  /** What's being typed, until it is saved; null shows the stored text. */
  const draft = signal<string | null>(null)

  const save = (target: PromptStage, text: string) => {
    const all = defaults()
    if (!all) return
    const value = text.trim() && text.trim() !== all[target].trim() ? text : undefined
    if (value !== props.prompts?.[target]) props.onChange({ ...props.prompts, [target]: value })
  }
  // Debounced save while typing; blur and switching stage save at once.
  effect(() => {
    const text = draft()
    const target = stage()
    if (text === null) return
    const timer = setTimeout(() => save(target, text), 800)
    cleanup(() => clearTimeout(timer))
  })
  const flush = () => {
    if (draft() !== null) save(stage(), draft() as string)
  }
  const custom = (s: PromptStage) => !!props.prompts?.[s]

  return (
    <Group
      title={t('自定义 Prompt')}
      footer={
        <Text class="text-[11px] text-fg-3">
          {t('Issue 的字段、评论、附件和 worktree 信息总会自动附上，结尾的 TRIAGE / VERDICT 行也由 TeaBranch 追加。可用占位符：')}
          <Text class="font-mono text-[11px] text-fg-3">{' {key} {link} {branch} {base} {round} {language}'}</Text>
        </Text>
      }
    >
      <Segmented<PromptStage>
        value={stage()}
        onChange={(next) => {
          flush()
          draft.set(null)
          stage.set(next)
        }}
        options={promptStages.map((value) => ({
          value,
          label: (
            <View class="flex-row items-center gap-1">
              <Text class={cn('text-[12px]', stage() === value ? 'font-medium text-fg' : 'text-fg-2')}>{stageLabel(value)}</Text>
              <If when={custom(value)}>
                <View class="size-1.5 rounded-full bg-brand" tooltip={t('已自定义')} />
              </If>
            </View>
          ),
        }))}
      />
      <TextInput
        multiline
        value={draft() ?? props.prompts?.[stage()] ?? defaults()?.[stage()] ?? ''}
        onChange={(e) => draft.set(e.value)}
        onBlur={flush}
        readonly={!defaults()}
        autoCorrect={false}
        class="h-60 py-2 font-mono text-[11.5px] leading-relaxed"
      />
      <View class="flex-row items-center gap-2">
        <Text class="text-[11px] text-fg-3">{custom(stage()) ? t('已自定义') : t('使用默认')}</Text>
        <View class="flex-1" />
        <Button
          disabled={!custom(stage())}
          onPress={() => {
            draft.set(null)
            props.onChange({ ...props.prompts, [stage()]: undefined })
          }}
        >
          {t('恢复默认')}
        </Button>
      </View>
    </Group>
  )
}
