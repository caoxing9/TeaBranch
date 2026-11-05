import { randomBytes } from 'crypto'
import { chmodSync, mkdirSync, writeFileSync } from '../node/fs'
import { type HttpRequest, type HttpResponse, HttpServer } from 'teabranch/native'
import { serve } from '../node/http'
import { join } from 'path'
import { log } from '../core/log'
import { configDirectory } from '../core/settingsStore'
import { userPATH } from '../core/shell'
import { type Owner, runCommand } from './browserCommands'

/**
 * How an agent reaches its branch's browser: `tb-browser` in its PATH posts to a server on
 * loopback, with a token that names the branch. A token reaches only its own branch's browser,
 * and nothing else in the app.
 */

const binDirectory = join(configDirectory, 'bin')

/** POSIX sh and curl: nothing to install, and every argument goes through urlencoded, intact. */
const CLI = `#!/bin/sh
# Written by TeaBranch: drives this branch's browser in the app. \`tb-browser help\` lists commands.
if [ -z "$TEABRANCH_BROWSER" ] || [ -z "$TEABRANCH_BROWSER_TOKEN" ]; then
  echo "tb-browser: only works inside an agent TeaBranch started" >&2
  exit 2
fi
name=$1
[ $# -gt 0 ] && shift
for arg do
  shift
  set -- "$@" --data-urlencode "arg=$arg"
done
exec curl -sS --fail-with-body --max-time 900 \\
  -H "Authorization: Bearer $TEABRANCH_BROWSER_TOKEN" \\
  --data-urlencode "command=$name" "$@" "$TEABRANCH_BROWSER/run"
`

let server: HttpServer | null = null
let address = ''
const owners = new Map<string, Owner>()
/** One token per owner key, so a resumed agent doesn't grow the table. */
const tokens = new Map<string, string>()

export async function startBrowserBridge(): Promise<void> {
  mkdirSync(binDirectory, { recursive: true })
  writeFileSync(join(binDirectory, 'tb-browser'), CLI)
  chmodSync(join(binDirectory, 'tb-browser'), 0o755)

  const reply = (status: number, text: string): HttpResponse => ({
    status,
    headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
    body: text.endsWith('\n') ? text : `${text}\n`,
  })
  const onRequest = async (request: HttpRequest): Promise<HttpResponse> => {
    const authorization = request.headers.find((h) => h.name.toLowerCase() === 'authorization')?.value ?? ''
    const token = /^Bearer (.+)$/.exec(authorization)?.[1]
    const owner = token ? owners.get(token) : undefined
    if (request.method !== 'POST' || request.url !== '/run' || !owner) return reply(403, 'tb-browser: not allowed')
    if (request.body.length > 1_000_000) return reply(413, 'tb-browser: too much')
    const form = new URLSearchParams(request.body)
    const command = form.get('command') ?? ''
    try {
      return reply(200, await runCommand(owner, command, form.getAll('arg')))
    } catch (error) {
      return reply(400, `tb-browser ${command}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  server = new HttpServer()
  const port = await server.start(0)
  serve(server, onRequest)
  address = `http://127.0.0.1:${port}`
  log.info(`browser bridge on ${address}`)
}

/**
 * The env that gives an agent `tb-browser` for `owner.branch`. Empty until the bridge listens —
 * the agent then just runs without a browser.
 */
export function browserEnvironment(key: string, owner: Owner): Record<string, string> {
  if (!address) return {}
  let token = tokens.get(key)
  if (!token) {
    token = randomBytes(24).toString('hex')
    tokens.set(key, token)
  }
  owners.set(token, owner)
  mkdirSync(owner.dir, { recursive: true })
  return {
    TEABRANCH_BROWSER: address,
    TEABRANCH_BROWSER_TOKEN: token,
    PATH: `${binDirectory}:${userPATH()}`,
  }
}
