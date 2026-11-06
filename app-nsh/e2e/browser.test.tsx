// The in-app browser end to end: a page served by the Rust HTTP server, shown in the WebView the
// host keeps, and driven over the same `Page` the agent's tb-browser commands use. Needs WebKit:
// run with `nsh test --target macos e2e/browser.test.tsx`.
import { expect, open, test } from 'nsh/test'

const SHOTS = '.nsh/shots'

test('loads, evaluates, clicks and types in a branch browser', async () => {
  const app = await open('./BrowserHarness.tsx', { platform: 'macos', width: 800, height: 600, network: 'live' })
  const status = () => app.texts().find((text) => text.startsWith('server ')) ?? ''
  await app.waitUntil(() => status().includes('done') || status().includes('error'), { timeout: 40_000 })
  await app.screenshot(`${SHOTS}/e2e-browser.png`).catch(() => undefined)
  const line = status()
  // Headless runs have no WebKit; the real host (`--target macos`) is where the page is checked.
  if (line.includes('webview unavailable')) return
  expect(line).toContain('title Harness')
  expect(line).toContain('probe complete,Harness,true')
  expect(line).toContain('eval 42')
  // Clicks and typing need the app's `webview.input` capability, which only the app itself carries.
  if (line.includes('input true')) {
    expect(line).toContain('click clicked')
    expect(line).toContain('[log] pressed')
    expect(line).toContain('text typed')
  }
  expect(line).toContain('done')
})
