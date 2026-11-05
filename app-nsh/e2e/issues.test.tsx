// Drives the Issues section as a user would: switch to it and, signed out, meet the Teable
// login. Run with `nsh test --target macos e2e/issues.test.tsx` (screenshots need a real host).
import { expect, open, test } from 'nsh/test'

const SHOTS = '.nsh/shots'

test('switches to issues and shows the Teable login', async () => {
  const app = await open('../App.tsx', { platform: 'macos', width: 1200, height: 832, network: 'live' })
  await app.waitFor('text:Issues', { timeout: 20_000 })
  await app.press('text:Issues')
  await app.waitFor('text:登录 Teable', { timeout: 20_000 })
  await app.wait(600)
  // Headless runs have nothing to draw: the screenshot is for the real host only.
  await app.screenshot(`${SHOTS}/e2e-issues-1.png`).catch(() => undefined)
  // teable.ai has a built-in OAuth app: one click signs in, the other ways in wait behind a disclosure.
  expect(app.texts()).toContain('用 Teable 登录')
  expect(app.texts().some((text) => text.includes('Teable 地址'))).toBe(false)
  await app.press('text:▸ 其他登录方式')
  await app.waitFor('text:或个人访问令牌', { timeout: 5_000 })
  expect(app.texts().some((text) => text.includes('Teable 地址'))).toBe(true)
})
