// The settings as a section of the window: the gear opens them with their own sidebar, each
// entry is a page, and the gear leads back out. Run with `nsh test --target macos e2e/settings.test.tsx`
// for the screenshots.
import { expect, open, test } from 'nsh/test'

const SHOTS = '.nsh/shots'

test('opens the settings from the gear and walks their pages', async () => {
  const app = await open('../App.tsx', { platform: 'macos', width: 1200, height: 832, network: 'live' })
  await app.waitFor('text:分支', { timeout: 20_000 })
  // From the branches page: the gear is the same on every page.
  await app.press('text:分支')
  await app.wait(400)
  await app.press('label:设置')
  await app.waitFor('text:主题', { timeout: 10_000 })
  await app.wait(600)
  await app.screenshot(`${SHOTS}/e2e-settings-1.png`).catch(() => undefined)
  for (const text of ['通用', '外观', '仓库', '终端', '模型', 'Teable 表', '修复', 'Prompt', '托管', '语言 / Language']) expect(app.texts()).toContain(text)
  await app.press('text:深色')
  await app.wait(300)
  await app.press('text:跟随系统 >> nth=0')

  await app.press('text:仓库')
  await app.waitFor('text:端口起点', { timeout: 10_000 })
  expect(app.texts().some((text) => text.endsWith('/TeaBranch'))).toBe(true)

  await app.press('text:终端 >> nth=0')
  await app.waitFor('text:终端应用', { timeout: 10_000 })
  // The terminal select names its choice (the presets arrive after the page is made).
  await app.waitUntil(() => app.texts().some((text) => /^(Otty|System Default \(Terminal\)|Warp|iTerm|Ghostty|Kero|Alacritty|Kitty|Hyper)$/.test(text)), {
    timeout: 10_000,
  })

  await app.press('text:模型 >> nth=0')
  await app.waitFor('text:兜底', { timeout: 10_000 })
  for (const text of ['默认模型', '按场景', '修复 issue', '修复前验证', 'Review', '处理 Review 意见', '对话', 'Router', 'Claude Code', 'Magpie'])
    expect(app.texts()).toContain(text)
  // Scenes without a rule say so; the router has one by default.
  expect(app.texts().filter((text) => text.startsWith('跟随兜底')).length).toBeGreaterThanOrEqual(4)
  await app.wait(600)
  await app.screenshot(`${SHOTS}/e2e-settings-2.png`).catch(() => undefined)

  await app.press('text:Teable 表 >> nth=0')
  await app.waitFor('text:字段映射', { timeout: 10_000 })
  await app.press('text:修复 >> nth=0')
  await app.waitFor('text:自动模式与限流', { timeout: 10_000 })
  expect(app.texts()).toContain('先验证再修')
  await app.press('text:Review >> nth=0')
  await app.waitFor('text:提 PR 后自动 review', { timeout: 10_000 })
  await app.wait(400)
  await app.screenshot(`${SHOTS}/e2e-settings-3.png`).catch(() => undefined)
  await app.press('text:Prompt >> nth=0')
  await app.waitFor('text:恢复默认', { timeout: 10_000 })
  await app.wait(600)
  await app.screenshot(`${SHOTS}/e2e-settings-4.png`).catch(() => undefined)

  // The gear again: back to the branches.
  await app.press('label:设置')
  await app.wait(400)
  expect(app.shows('text:恢复默认')).toBe(false)
  expect(app.texts()).toContain('分支')
})
