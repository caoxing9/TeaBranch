// The built-in terminal end to end: a login shell on the Rust pty, a command typed into the view,
// its output on screen. Run with `nsh test e2e/terminal.test.tsx` (also `--target macos`).
import { expect, open, test } from 'nsh/test'

test('runs a command in the built-in terminal', async () => {
  const app = await open('./TerminalHarness.tsx', { platform: 'macos', width: 800, height: 500 })
  await app.waitFor('id:terminal-input', { timeout: 15_000 })
  // The shell's prompt arrives once it has started.
  await app.waitUntil(() => app.texts().some((text) => /[%$#>] ?$/m.test(text.trimEnd())), { timeout: 20_000 })
  // The answer, not the command, is what proves the round trip: the typed line echoes back on its own.
  await app.type('id:terminal-input', 'echo $((40 + 2))-from-pty')
  await app.submit('id:terminal-input')
  await app.waitUntil(() => app.texts().some((text) => text.includes('42-from-pty')), { timeout: 20_000 })
  expect(app.value('id:terminal-input')).toBe('')
})
