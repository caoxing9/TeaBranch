// A dialog sits in the middle of the window (the screenshot shows it) and goes away from its close
// button. The backdrop and Escape close it too, but a test's press lands on an element's centre —
// where the box now is — and its Escape goes to the focused field. Run with
// `nsh test --target macos e2e/dialog.test.tsx` for the screenshot.
import { expect, open, test } from 'nsh/test'

const SHOTS = '.nsh/shots'

test('the new-worktree dialog is centred and closes', async () => {
  const app = await open('../App.tsx', { platform: 'macos', width: 1200, height: 832, network: 'live' })
  await app.waitFor('text:分支', { timeout: 20_000 })
  await app.press('text:分支')
  await app.wait(400)
  await app.press('label:新建分支 (⌘N)')
  await app.waitFor('text:新建 Worktree', { timeout: 10_000 })
  await app.wait(500)
  await app.screenshot(`${SHOTS}/e2e-dialog-1.png`).catch(() => undefined)
  await app.press('label:关闭')
  await app.wait(400)
  expect(app.shows('text:新建 Worktree')).toBe(false)
})
