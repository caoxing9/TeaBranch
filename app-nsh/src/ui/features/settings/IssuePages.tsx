import { Text, View, cleanup, effect, resource, signal } from 'nsh'
import { getLocale, t } from '../../../shared/i18n'
import { assigneeGuess, isUserField, mapping } from '../../../shared/issues'
import type { PromptStage, TeableConfig } from '../../../shared/types'
import { promptStages } from '../../../shared/types'
import { Button, Segmented, TextInput } from '../../components/kit'
import { api } from '../../lib/api'
import { cn } from '../../lib/utils'
import { issues } from '../../store/issues'
import { Card, Choice, NumberInput, PageBody, PageHeader, Row, StatusChips, SwitchRow } from '../autopilot/parts'
import { TablePicker } from '../issues/TablePicker'
import { NONE, SavedInput } from './fields'

/** The Issue auto-fix settings: the table, how fixes run, review and CI, the prompts. */

const update = (patch: Partial<TeableConfig>) => void issues.updateConfig(patch)

/** The field mapping with the guessed names, for the "auto (…)" labels. */
const guessed = () => {
  const config = issues.config()
  return config ? mapping({ ...config, titleField: undefined, bodyField: undefined, statusField: undefined, idField: undefined }, issues.fields()) : null
}

const statusChoices = () => {
  const config = issues.config()
  return issues.fields().find((field) => field.name === (config?.statusField ?? guessed()?.status))?.choices ?? []
}

export function IssueTeablePage() {
  const fieldOptions = (noneLabel: string, fields = issues.fields()) => [
    { value: NONE, label: noneLabel },
    ...fields.map((field) => ({ value: field.name, label: field.name })),
  ]
  const fieldSelect = (config: TeableConfig, key: 'titleField' | 'bodyField' | 'statusField' | 'idField' | 'prField', guess?: string, none = t('自动')) => (
    <Choice
      class="w-64"
      value={config[key] ?? NONE}
      options={fieldOptions(guess ? t('{none}（{guess}）', { none, guess }) : none)}
      onChange={(value) => update({ [key]: value === NONE ? undefined : value })}
    />
  )
  return (
    <If when={issues.config()}>
      {(config) => (
        <>
          <PageHeader title={t('Teable 表')} subtitle={t('读 issue 表，修完把 PR 链接写回去。')} />
          <PageBody>
            <Card title={t('表')}>
              <Row label={t('表或视图')} stacked>
                <TablePicker value={config()} onPick={(pick) => update({ baseId: pick.baseId, tableId: pick.tableId, viewId: pick.viewId })} />
              </Row>
            </Card>
            <Card title={t('字段映射')}>
              <Row label={t('标题')}>{fieldSelect(config(), 'titleField', guessed()?.title)}</Row>
              <Row label={t('描述')}>{fieldSelect(config(), 'bodyField', guessed()?.body)}</Row>
              <Row label={t('状态')}>{fieldSelect(config(), 'statusField', guessed()?.status)}</Row>
              <Row label="Issue ID">{fieldSelect(config(), 'idField', guessed()?.id)}</Row>
              <SwitchRow
                label={t('只看分配给我的 issue')}
                hint={t('在 Teable 服务端筛选，别人的 issue 不会下载到本机')}
                checked={config().onlyMine}
                onChange={(onlyMine) => update({ onlyMine })}
              />
              <Row label={t('负责人（只看我的）')}>
                <Choice
                  class="w-64"
                  value={config().assigneeField ?? NONE}
                  options={fieldOptions(
                    t('自动（{guess}）', { guess: assigneeGuess({ ...config(), assigneeField: undefined }, issues.fields()) ?? t('无') }),
                    issues.fields().filter(isUserField),
                  )}
                  onChange={(value) => update({ assigneeField: value === NONE ? undefined : value })}
                />
              </Row>
              <Row label={t('回写 PR 链接到')}>{fieldSelect(config(), 'prField', undefined, t('不回写'))}</Row>
              <If when={statusChoices().length > 0}>
                <Row label={t('提 PR 后状态改为')}>
                  <Choice
                    class="w-64"
                    value={config().doneStatus ?? NONE}
                    options={[{ value: NONE, label: t('不修改') }, ...statusChoices().map((choice) => ({ value: choice, label: choice }))]}
                    onChange={(value) => update({ doneStatus: value === NONE ? undefined : value })}
                  />
                </Row>
              </If>
            </Card>
          </PageBody>
        </>
      )}
    </If>
  )
}

export function IssueFixPage() {
  const autoHint = () =>
    [
      t('所有待修复的 issue 进同一个队列，最多同时跑 N 个，跑完一个就补上下一个。'),
      t('Issue 内容来自共享表格，开启自动模式意味着能编辑这张表的人都能驱动本机 agent（默认带 {flag}）。', { flag: '--dangerously-skip-permissions' }),
    ].join(getLocale() === 'en' ? ' ' : '')
  return (
    <If when={issues.config()}>
      {(config) => (
        <>
          <PageHeader title={t('修复')} />
          <PageBody>
            <Card title={t('修复前验证')}>
              <SwitchRow
                label={t('先验证再修')}
                hint={t('查是否已被修复、本地复现、判断是不是 bug；只有确认是 bug 才自动修')}
                checked={config().triage}
                onChange={(triage) => update({ triage })}
              />
            </Card>
            <Card title={t('自动模式与限流')} hint={autoHint()}>
              <SwitchRow
                label={t('自动模式')}
                hint={t('每 3 分钟读表，自动修复下面这些状态的 issue')}
                checked={config().autoFix}
                onChange={(autoFix) => update({ autoFix })}
              />
              <Row label={t('修复这些状态')} stacked>
                <StatusChips
                  choices={statusChoices()}
                  selected={config().fixStatuses}
                  onChange={(fixStatuses) => update({ fixStatuses })}
                  empty={t('映射“状态”字段后可选择自动修复哪些状态')}
                />
              </Row>
              <Row label={t('最多同时修复')}>
                <NumberInput value={config().batchSize} min={1} onSave={(value) => update({ batchSize: Math.max(1, Math.min(10, value || 1)) })} />
              </Row>
              <Row label={t('分支前缀')} hint={t('留空：分支名就是 issue id')}>
                <SavedInput mono class="w-48" value={config().branchPrefix} onSave={(branchPrefix) => update({ branchPrefix })} />
              </Row>
            </Card>
          </PageBody>
        </>
      )}
    </If>
  )
}

export function IssueReviewPage() {
  return (
    <If when={issues.config()}>
      {(config) => (
        <>
          <PageHeader title="Review" />
          <PageBody>
            <Card title="Review">
              <SwitchRow label={t('提 PR 后自动 review')} checked={config().autoReview} onChange={(autoReview) => update({ autoReview })} />
              <SwitchRow
                label={t('把 review 结果发给该 issue 的 agent 继续修改')}
                checked={config().sendReviewToAgent}
                onChange={(sendReviewToAgent) => update({ sendReviewToAgent })}
              />
              <Row label={t('最多 review → 修改轮数')}>
                <NumberInput value={config().maxReviewRounds} min={1} onSave={(value) => update({ maxReviewRounds: Math.max(1, Math.min(5, value || 1)) })} />
              </Row>
            </Card>
            <Card title="CI">
              <SwitchRow
                label={t('CI 失败自动发给 agent 修')}
                hint={t('PR 的 CI 全部跑完后有失败，自动发给该 issue 的 agent 修')}
                checked={config().autoFixCI}
                onChange={(autoFixCI) => update({ autoFixCI })}
              />
              <Row label={t('每个 issue 最多自动发几轮')}>
                <NumberInput value={config().maxCIRounds} min={1} onSave={(value) => update({ maxCIRounds: Math.max(1, Math.min(5, value || 1)) })} />
              </Row>
            </Card>
          </PageBody>
        </>
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
export function IssuePromptPage() {
  const prompts = () => issues.config()?.prompts
  const onChange = (next: TeableConfig['prompts']) => update({ prompts: next })
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
    if (value !== prompts()?.[target]) onChange({ ...prompts(), [target]: value })
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
  const custom = (s: PromptStage) => !!prompts()?.[s]

  return (
    <>
      <PageHeader
        title="Prompt"
        subtitle={
          <Text class="mt-1 max-w-2xl text-[12.5px] text-fg-2">
            {t('Issue 的字段、评论、附件和 worktree 信息总会自动附上，结尾的 TRIAGE / VERDICT 行也由 TeaBranch 追加。可用占位符：')}
            <Text class="font-mono text-[12px] text-fg-2">{' {key} {link} {branch} {base} {round} {language}'}</Text>
          </Text>
        }
      />
      <PageBody>
        <Card title={t('自定义 Prompt')}>
          <View class="gap-3 bg-card px-5 py-4">
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
              value={draft() ?? prompts()?.[stage()] ?? defaults()?.[stage()] ?? ''}
              onChange={(e) => draft.set(e.value)}
              onBlur={flush}
              readonly={!defaults()}
              autoCorrect={false}
              class="h-80 py-2 font-mono text-[11.5px] leading-relaxed"
            />
            <View class="flex-row items-center gap-2">
              <Text class="text-[11px] text-fg-3">{custom(stage()) ? t('已自定义') : t('使用默认')}</Text>
              <View class="flex-1" />
              <Button
                disabled={!custom(stage())}
                onPress={() => {
                  draft.set(null)
                  onChange({ ...prompts(), [stage()]: undefined })
                }}
              >
                {t('恢复默认')}
              </Button>
            </View>
          </View>
        </Card>
      </PageBody>
    </>
  )
}
