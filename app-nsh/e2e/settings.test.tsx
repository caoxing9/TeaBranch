// The global settings, from the gear beside the section switcher on any page: the look, the
// language, the repository, terminal and agent, and the way on to the Issue settings. Run with
// `nsh test --target macos e2e/settings.test.tsx` for the screenshots.
import { expect, open, test } from 'nsh/test'

const SHOTS = '.nsh/shots'

test('opens the settings from the gear and leads on to the Issue settings', async () => {
  const app = await open('../App.tsx', { platform: 'macos', width: 1200, height: 832, network: 'live' })
  await app.waitFor('text:分支', { timeout: 20_000 })
  // From the branches page: the gear is the same on every page.
  await app.press('text:分支')
  await app.wait(400)
  await app.screenshot(`${SHOTS}/e2e-settings-0.png`).catch(() => undefined)
  await app.press('label:设置')
  await app.waitFor('text:端口起点', { timeout: 10_000 })
  await app.wait(600)
  await app.screenshot(`${SHOTS}/e2e-settings-1.png`).catch(() => undefined)
  for (const text of ['主题', '语言 / Language', '路径', '终端应用', '命令', 'Issue 设置…']) expect(app.texts()).toContain(text)
  expect(app.texts().some((text) => text.endsWith('/TeaBranch'))).toBe(true)
  // The terminal select names its choice (the presets arrive after the dialog is made).
  expect(app.texts().some((text) => /^(Otty|System Default \(Terminal\)|Warp|iTerm|Ghostty|Kero|Alacritty|Kitty|Hyper)$/.test(text))).toBe(true)
  await app.press('text:深色')
  await app.wait(400)
  await app.screenshot(`${SHOTS}/e2e-settings-2.png`).catch(() => undefined)
  await app.press('text:跟随系统 >> nth=0')
  await app.press('text:Issue 设置…')
  await app.waitFor('text:字段映射', { timeout: 10_000 })
  expect(app.shows('text:端口起点')).toBe(false)
  await app.wait(600)
  await app.screenshot(`${SHOTS}/e2e-settings-3.png`).catch(() => undefined)
  // The Issue settings are tabs; the Prompt pane holds the per-stage editor.
  await app.press('text:Prompt')
  await app.waitFor('text:恢复默认', { timeout: 10_000 })
  await app.wait(600)
  await app.screenshot(`${SHOTS}/e2e-settings-4.png`).catch(() => undefined)
})
