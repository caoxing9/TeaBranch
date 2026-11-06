import { type JSX, Text, View, resource, signal } from 'nsh'
import type { LanguagePref } from '../../../shared/i18n'
import { t } from '../../../shared/i18n'
import type { AgentAccess, ModelScene, ReviewEngine } from '../../../shared/types'
import { agentAccessModes, modelScenes } from '../../../shared/types'
import { applyLocale } from '../../../core/locale'
import { Button, Segmented, TextInput } from '../../components/kit'
import { api } from '../../lib/api'
import { type SettingsPage, type Theme, app } from '../../store/app'
import { issues } from '../../store/issues'
import { Card, Choice, NumberInput, PageBody, PageHeader, Row } from '../autopilot/parts'
import { ModelPicker } from '../issues/AgentPickers'
import { NONE, SavedInput } from './fields'
import { IssueFixPage, IssuePromptPage, IssueReviewPage, IssueTeablePage } from './IssuePages'

/** The settings, a page per entry of the rail: the app's own, the models' rules, the Issue auto-fix. */
export function SettingsMain() {
  const page = () => app.settingsPage()
  return (
    <View class="min-h-0 flex-1">
      {(() => {
        const pages: Record<SettingsPage, () => JSX.Element> = {
          appearance: () => <AppearancePage />,
          repo: () => <RepoPage />,
          terminal: () => <TerminalPage />,
          models: () => <ModelsPage />,
          issueTeable: () => <IssueTeablePage />,
          issueFix: () => <IssueFixPage />,
          issueReview: () => <IssueReviewPage />,
          issuePrompt: () => <IssuePromptPage />,
        }
        return pages[page()]()
      })()}
    </View>
  )
}

// MARK: - General

/** The menu rebuilds itself from the locale listeners; the views are built again in the new language. */
async function changeLanguage(language: LanguagePref) {
  await app.updateSettings({ language })
  applyLocale(language)
  app.remountUi()
}

function AppearancePage() {
  return (
    <>
      <PageHeader title={t('外观')} />
      <PageBody>
        <Card>
          <Row label={t('主题')}>
            <Segmented<Theme>
              class="w-64"
              value={app.theme()}
              onChange={(theme) => app.setTheme(theme)}
              options={[
                { value: 'system', label: t('跟随系统') },
                { value: 'light', label: t('浅色') },
                { value: 'dark', label: t('深色') },
              ]}
            />
          </Row>
          <Row label={t('语言 / Language')}>
            <Segmented<LanguagePref>
              class="w-64"
              value={app.settings()?.language ?? 'system'}
              onChange={(language) => void changeLanguage(language)}
              options={[
                { value: 'system', label: t('跟随系统') },
                { value: 'zh', label: '中文' }, // i18n-ignore: each language names itself
                { value: 'en', label: 'English' },
              ]}
            />
          </Row>
        </Card>
      </PageBody>
    </>
  )
}

function RepoPage() {
  const settings = () => app.settings()
  return (
    <>
      <PageHeader title={t('仓库')} />
      <PageBody>
        <Card>
          <Row
            label={t('路径')}
            hint={
              <Text class="mt-0.5 font-mono text-[11.5px] text-fg-2" style={{ userSelect: 'text' }}>
                {settings()?.projectPath ?? ''}
              </Text>
            }
          >
            <Button onPress={() => void app.chooseProject()}>{t('更换…')}</Button>
          </Row>
          <Row label={t('端口起点')} hint={t('每个分支的 dev server 从端口起点往上找空闲端口。')}>
            <NumberInput value={settings()?.basePort ?? 3001} min={1024} onSave={(basePort) => void app.updateSettings({ basePort })} />
          </Row>
        </Card>
      </PageBody>
    </>
  )
}

const custom = '__custom__'
/** `Choice` drops an empty value, so the system terminal (no app name) travels as this. */
const systemTerminal = '__system__'

function TerminalPage() {
  const settings = () => app.settings()
  const presets = resource(() => api.terminalPresets())
  const chosen = signal<string | null>(null)
  const customApp = signal('')
  const terminal = () => settings()?.terminalApp ?? ''
  const isPreset = () => (presets() ?? []).some((preset) => (preset.value ?? '') === terminal())
  const selection = () => chosen() ?? (presets()?.length ? (isPreset() ? terminal() || systemTerminal : custom) : '')
  return (
    <>
      <PageHeader title={t('终端')} subtitle={t('Otty 能直接在新标签里运行命令，也能告诉我们哪些 worktree 已经开着终端。')} />
      <PageBody>
        <Card>
          <Row label={t('终端应用')}>
            {/* Made once the presets are in: a select given its items later shows no title for its value. */}
            <If when={presets()}>
              {(presets) => (
                <Choice
                  class="w-64"
                  value={selection()}
                  onChange={(value) => {
                    chosen.set(value)
                    if (value === custom) {
                      if (!isPreset() && terminal()) customApp.set(terminal())
                    } else void app.updateSettings({ terminalApp: value === systemTerminal ? undefined : value })
                  }}
                  options={[
                    ...presets().map((preset) => ({ value: preset.value ?? systemTerminal, label: preset.label })),
                    { value: custom, label: t('自定义…') },
                  ]}
                />
              )}
            </If>
          </Row>
          <If when={selection() === custom}>
            <Row label={t('应用名')}>
              <View class="flex-row gap-2">
                <TextInput value={customApp()} onChange={(e) => customApp.set(e.value)} placeholder="WezTerm" class="w-48" />
                <Button onPress={() => void app.updateSettings({ terminalApp: customApp().trim() || undefined })}>{t('保存')}</Button>
              </View>
            </Row>
          </If>
        </Card>
      </PageBody>
    </>
  )
}

// MARK: - Models

/** What each scene is, for the rules' rows. */
const sceneText = (): Record<ModelScene, { label: string; hint: string }> => ({
  fix: { label: t('修复 issue'), hint: t('自动修复，和你在 issue 里发给 agent 的消息') },
  triage: { label: t('修复前验证'), hint: t('修之前先判断是不是 bug、能不能复现') },
  review: { label: 'Review', hint: t('PR review：issue 自己的，和群里发来的') },
  reviewFeedback: { label: t('处理 Review 意见'), hint: t('把 review 结果交回 agent 修改') },
  chat: { label: t('对话'), hint: t('分支页和 Issues 页里新开的对话') },
  router: { label: 'Router', hint: t('飞书和 issue 评论里的回复、调度，还有进展检查') },
})

/**
 * Which model does what, the way a proxy's rules read: a rule per scene, and the fallback for
 * every scene without one. The review engine, the agents' permission mode, the Claude Code
 * command and the Magpie gateway live here too — they are about the models.
 */
function ModelsPage() {
  const rules = () => app.modelRules()
  const magpieKey = signal('')
  const agentCommand = () => app.settings()?.agentCommand ?? ''
  void issues.loadMagpieModels()
  const magpieNote = () => issues.magpieError() ?? (issues.magpieModels().length ? t('Magpie 提供 {n} 个模型', { n: issues.magpieModels().length }) : undefined)
  const rulePicker = (scene: ModelScene) => (
    <ModelPicker
      placement="down"
      scene={scene}
      inherit={t('跟随兜底')}
      model={rules().rules[scene]}
      onChange={(model) => void app.setModelRule(scene, model)}
    />
  )
  return (
    <>
      <PageHeader title={t('模型')} subtitle={t('像代理规则：有规则的场景用自己的模型，其余都走兜底。单个 issue 或对话里选的模型优先。')} />
      <PageBody>
        <Card title={t('兜底')}>
          <Row label={t('默认模型')} hint={t('没有单独规则的场景都用它')}>
            <ModelPicker placement="down" model={rules().fallback} onChange={(model) => void app.setModelFallback(model ?? { provider: 'claude' })} />
          </Row>
        </Card>
        <Card title={t('按场景')}>
          <Each of={modelScenes} key={(scene) => scene}>
            {(scene) => (
              <If
                when={scene() === 'review'}
                else={
                  <Row label={sceneText()[scene()].label} hint={sceneText()[scene()].hint}>
                    {rulePicker(scene())}
                  </Row>
                }
              >
                <If when={issues.config()}>
                  {(config) => (
                    <Row label="Review" hint={sceneText().review.hint}>
                      <View class="flex-row items-center gap-2">
                        <Segmented<ReviewEngine>
                          class="w-48"
                          value={config().reviewEngine}
                          onChange={(reviewEngine) => void issues.updateConfig({ reviewEngine })}
                          options={[
                            { value: 'codex', label: 'Codex CLI' },
                            { value: 'claude', label: 'Claude Code' },
                          ]}
                        />
                        <If when={config().reviewEngine === 'codex'} else={rulePicker('review')}>
                          <Choice
                            class="w-56"
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
                            onChange={(value) => void issues.updateConfig({ codexModel: value === NONE ? '' : value })}
                          />
                        </If>
                      </View>
                    </Row>
                  )}
                </If>
              </If>
            )}
          </Each>
        </Card>
        <If when={issues.config()}>
          {(config) => (
            <Card title={t('权限')}>
              <Row label={t('Agent 权限')} hint={t('修复 issue 和对话里 agent 的默认权限；每个 issue、每个对话可以单独改')}>
                <Choice
                  class="w-56"
                  value={config().access}
                  options={agentAccessModes.map((mode) => ({ value: mode.value as string, label: mode.label }))}
                  onChange={(access) => void issues.updateConfig({ access: access as AgentAccess })}
                />
              </Row>
            </Card>
          )}
        </If>
        <Card title="Claude Code">
          <Row label={t('命令')} hint={t('“Agent” 按钮和 issue 自动修复都用它启动 Claude Code。写完整命令，别用 shell 别名。')}>
            <SavedInput mono class="w-72" value={agentCommand()} onSave={(value) => void app.updateSettings({ agentCommand: value.trim() })} />
          </Row>
        </Card>
        <If when={issues.config()}>
          {(config) => (
            <Card title="Magpie" hint={magpieNote()}>
              <Row label={t('地址')} hint={t('本机的模型网关；它路由的模型都能在上面选')}>
                <SavedInput
                  mono
                  class="w-72"
                  value={config().magpieURL}
                  onSave={(magpieURL) => void issues.updateConfig({ magpieURL }).then(() => issues.loadMagpieModels())}
                />
              </Row>
              <Row label={t('Key（可选）')}>
                <View class="flex-row gap-2">
                  <TextInput masked value={magpieKey()} onChange={(e) => magpieKey.set(e.value)} class="w-56" />
                  <Button
                    onPress={async () => {
                      if (magpieKey()) await api.setMagpieKey(magpieKey())
                      await issues.loadMagpieModels()
                    }}
                  >
                    {t('刷新模型')}
                  </Button>
                </View>
              </Row>
            </Card>
          )}
        </If>
      </PageBody>
    </>
  )
}
