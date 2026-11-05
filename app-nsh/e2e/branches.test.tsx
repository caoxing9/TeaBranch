// Drives the whole app headless, as a user would: the branches section, a branch opened, its
// detail with the log pane and the inspector. Run with `nsh test e2e/branches.test.tsx`.
import { expect, open, test } from 'nsh/test'

test('opens a branch and shows its detail', async () => {
  const app = await open('../App.tsx', { platform: 'macos', width: 1200, height: 832, network: 'live' })
  await app.waitFor('text:分支', { timeout: 20_000 })
  await app.press('text:分支')
  await app.waitFor('text:feat/super-agent', { timeout: 20_000 })
  // Headless runs have nothing to draw: the screenshots are for the real host only.
  await app.screenshot('.nsh/shots/e2e-branches-1.png').catch(() => undefined)
  await app.press('text:feat/super-agent')
  await app.waitFor('text:预览', { timeout: 10_000 })
  await app.wait(800)
  await app.screenshot('.nsh/shots/e2e-branches-2.png').catch(() => undefined)
  expect(app.texts()).toContain('Worktree'.toUpperCase())
})
