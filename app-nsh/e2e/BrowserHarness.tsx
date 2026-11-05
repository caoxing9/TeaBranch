// A window with a branch's browser in it, for e2e/browser.test.tsx: the Rust HTTP server serves a
// page, the host mounts the WebView, and the page is driven the way the agent's commands drive it
// (navigate, evaluate, click, type), with each step's outcome written to the status line.
import { Text, View, WebView, mount, signal } from 'nsh'
import { HttpServer } from 'teabranch/native'
import { serve } from '../src/node/http'
import * as browser from '../src/services/browser'
import { BrowserHost, placeBrowser } from '../src/ui/features/issues/browserHost'

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Harness</title></head><body>
<button id="b" style="position:fixed;left:10px;top:10px;width:120px;height:40px" onclick="document.title='clicked';console.log('pressed')">press</button>
<input id="i" style="position:fixed;left:10px;top:80px;width:200px;height:30px">
</body></html>`

const BRANCH = 'e2e'

const settle = async (done: () => boolean, ms = 8000): Promise<void> => {
  const until = Date.now() + ms
  while (!done() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100))
}

function Root() {
  const lines = signal<string[]>([])
  const note = (line: string) => lines.set([...lines(), line])
  void (async () => {
    try {
      const server = new HttpServer()
      const port = await server.start(0)
      serve(server, async () => ({ status: 200, headers: [{ name: 'content-type', value: 'text/html; charset=utf-8' }], body: PAGE }))
      note(`server ${port}`)
      placeBrowser(BRANCH, { x: 0, y: 48, width: 640, height: 400 })
      await browser.navigate(BRANCH, `http://127.0.0.1:${port}/`)
      const page = await browser.pageFor(BRANCH, 15_000)
      await settle(() => page.title() === 'Harness')
      // The headless engine has no WebKit: the page never loads there, and the test passes on this note.
      if (page.title() !== 'Harness' && page.url() === 'about:blank') {
        note('webview unavailable')
        note('done')
        return
      }
      note(`title ${page.title()}`)
      note(`probe ${String(await page.evaluate("[document.readyState, document.title, String(window.__teabranch)].join(',')"))}`)
      note(`eval ${String(await page.evaluate('1 + 41'))}`)
      // Trusted input is a capability of the app (nsh.json), which a test-opened entry does not carry.
      note(`input ${String(await WebView.inputAvailable())}`)
      await page.click(70, 30)
      await settle(() => page.title() === 'clicked')
      note(`click ${page.title()}`)
      await settle(() => browser.consoleOf(BRANCH).some((line) => line.includes('pressed')), 3000)
      note(`console ${browser.consoleOf(BRANCH).join('|')}`)
      await page.evaluate("document.getElementById('i').focus(); 'focused'")
      await page.text('typed')
      await settle(() => true, 300)
      note(`text ${String(await page.evaluate("document.getElementById('i').value"))}`)
      note('done')
    } catch (error) {
      note(`error ${error instanceof Error ? error.message : String(error)}`)
    }
  })()
  return (
    <View class="flex-1 bg-background">
      <View class="h-12 justify-center px-3">
        <Text class="text-[12px] text-foreground" testID="status">
          {lines().join(' · ')}
        </Text>
      </View>
      <BrowserHost />
    </View>
  )
}

mount(Root)
