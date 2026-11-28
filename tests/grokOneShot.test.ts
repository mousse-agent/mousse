/**
 * Grok's two single-request routes, chosen by how the entry signs in:
 * - an xAI API key: `grok:direct`, one request with no tools to xAI's API in Mousse's process, held. Counted at a
 *   loopback stub on 429 and 503 (one request each), with a control showing the same transport retrying when retries
 *   are allowed; and the request carries Mousse's text alone, with the key as its credential.
 * - the account: `acp:grok`, `acpOneShot` on a Grok home of the request's own, best-effort. Its sealed launch is
 *   captured where the place starts it: the home's config denies every tool, the sign-in is the entry's own
 *   `auth.json` read in place (a replaced file is the one the next request names; no copy anywhere), and the person's
 *   home and Grok's other sources stay out.
 * No real sign-in: dummy keys, a made-up account file, and a stub on the loopback.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stream as responsesStream } from '@earendil-works/pi-ai/api/openai-responses'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { grokArgs } from '../src/mms/harness/acp/presets/grok'
import type { DriverContext, DriverRuntime } from '../src/mms/harness/driver'
import { grokDriver, type GrokDriverOptions } from '../src/mms/harness/drivers/grok'
import { instanceEnv } from '../src/mms/harness/env'
import { routeLabel } from '../src/mms/harness/oneShot/admission'
import type { OneShotEvents } from '../src/mms/harness/oneShot/route'
import { classifyOneShotFailure } from '../src/mms/harness/oneShot/runner'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'

const launched = vi.hoisted(() => [] as Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; config?: string }>)
vi.mock('../src/mms/harness/oneShot/places', async (original) => {
  const fs = await import('node:fs')
  return {
    ...(await original<typeof import('../src/mms/harness/oneShot/places')>()),
    // Records the sealed launch of a single request, with its Grok home's config as the process would read it (the
    // place is removed once the request fails), and stops it there: no Grok runs here.
    spawnInPlace: (_place: unknown, options: { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }) => {
      let config: string | undefined
      try { config = fs.readFileSync(`${options.env.GROK_HOME}/config.toml`, 'utf8') } catch { /* none */ }
      launched.push({ command: options.command, args: options.args, env: options.env, cwd: options.cwd, ...(config !== undefined ? { config } : {}) })
      throw new Error('not started in tests')
    }
  }
})

const dirs: string[] = []
const runtimes: DriverRuntime[] = []
const servers: Server[] = []
afterEach(() => {
  launched.length = 0
  for (const runtime of runtimes.splice(0)) runtime.stop()
  for (const server of servers.splice(0)) server.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

/** A Grok account sign-in Grok would read (made up: no real account). */
function accountFile(path: string, user = 'u-1'): void {
  writeFileSync(path, JSON.stringify({ 'https://auth.x.ai::client': { key: 'made-up', user_id: user, refresh_token: 'rt', expires_at: new Date(Date.now() + 3600e3).toISOString() } }))
}

/** A Grok entry on the person's own home (`GROK_HOME`), run as `binaryPath`, with `base` as Mousse's environment. */
function setup(options: { base?: NodeJS.ProcessEnv; account?: boolean; driver?: GrokDriverOptions; args?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mousse-grok-one-shot-'))
  dirs.push(root)
  const grokHome = join(root, 'person', '.grok')
  mkdirSync(grokHome, { recursive: true })
  if (options.account) accountFile(join(grokHome, 'auth.json'))
  const context: DriverContext = {
    instanceId: 'grok',
    builtIn: true,
    config: { home: 'default', binaryPath: process.execPath, ...(options.args ? { args: options.args } : {}) },
    env: instanceEnv({ instanceId: 'grok', driver: 'grok', configRevision: 0, searchPath: [], base: { PATH: process.env.PATH, GROK_HOME: grokHome, HOME: join(root, 'person'), USERPROFILE: join(root, 'person'), ...options.base } }),
    profileHome: join(root, 'profile'),
    installationHome: root,
    stateDir: join(root, 'state'),
    questions: new UserQuestionService(),
    findBinary: () => undefined,
    changed: () => {}
  }
  const driver = grokDriver({ systemDir: join(root, 'system'), ...options.driver })
  const runtime = driver.create(context)
  runtimes.push(runtime)
  return { driver, runtime, root, grokHome }
}

const events = (): OneShotEvents & { sent: number } => {
  const out = { sent: 0, activity: () => {}, text: () => {}, tool: () => {}, launching: () => {}, sending: () => { out.sent += 1 } }
  return out
}

/** xAI's Responses API on the loopback: answers `status`, or the text `answer`; counts the requests. */
async function startStub(status: number, answer = 'Login redirect fix') {
  const requests: Array<{ url: string; body: string; authorization?: string }> = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requests.push({ url: req.url ?? '', body, ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) })
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '0' })
        res.end(JSON.stringify({ error: { message: `stub ${status}` } }))
        return
      }
      const item = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] }
      const response = { id: 'resp_1', object: 'response', created_at: 0, status: 'completed', model: 'stub', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let sequence = 0
      const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`)
      event('response.created', { response: { ...response, status: 'in_progress', output: [] } })
      event('response.output_item.added', { output_index: 0, item: { ...item, content: [], status: 'in_progress' } })
      event('response.output_text.delta', { output_index: 0, item_id: 'msg_1', content_index: 0, delta: answer })
      event('response.output_text.done', { output_index: 0, item_id: 'msg_1', content_index: 0, text: answer })
      event('response.output_item.done', { output_index: 0, item })
      event('response.completed', { response })
      res.end()
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { base: `http://127.0.0.1:${address.port}/v1`, requests }
}

const WIRE = { model: 'grok-4.7', system: 'MOUSSE-SYSTEM name the chat', prompt: 'MOUSSE-PROMPT fix the login redirect' }

describe('the route follows how the entry signs in', () => {
  // Rows: the sign-in, the model, and the route or refusal.
  const rows: Array<{ name: string; setup: Parameters<typeof setup>[0]; model: string; route?: string; label?: string; refused?: RegExp }> = [
    { name: 'an xAI API key Mousse keeps', setup: { account: true }, model: 'grok-4.7', route: 'grok:direct', label: 'held' },
    { name: 'an xAI API key in the environment', setup: { base: { XAI_API_KEY: 'xai-dummy' } }, model: 'grok-4.7:high', route: 'grok:direct', label: 'held' },
    { name: "an API key on Grok's own default", setup: { base: { XAI_API_KEY: 'xai-dummy' } }, model: 'default', refused: /model you choose/ },
    { name: 'the Grok account', setup: { account: true }, model: 'grok-4.7', route: 'acp:grok', label: 'best_effort' },
    { name: "a sign-in Mousse cannot tell (another sign-in command)", setup: { account: true, base: { GROK_AUTH_PROVIDER_COMMAND: 'corp-token' } }, model: 'grok-4.7', refused: /cannot tell which account/ }
  ]
  for (const row of rows) {
    it(row.name, async () => {
      const { driver, runtime } = setup(row.setup)
      if (row.name === 'an xAI API key Mousse keeps') await runtime.adoptApiKey!('xai-dummy-kept')
      const decision = driver.oneShotRoute!({ config: {}, installedVersion: '9.9.9', instanceId: 'grok', model: row.model })
      if (row.refused) expect('refused' in decision && decision.refused).toMatch(row.refused)
      else {
        expect(decision).toMatchObject({ route: { id: row.route } })
        expect(routeLabel((decision as { route: Parameters<typeof routeLabel>[0] }).route)).toBe(row.label)
      }
    })
  }
})

describe('grok:direct', () => {
  it("sends Mousse's text alone, with no tool, the model and level chosen, and the key as its credential", async () => {
    const stub = await startStub(200)
    const { runtime } = setup({ base: { XAI_API_KEY: 'xai-dummy' }, driver: { direct: { baseUrl: stub.base } } })
    const seen = events()
    await expect(runtime.oneShotTransport!({ model: 'grok-4.7:high' }).send({ ...WIRE, model: 'grok-4.7:high' }, seen, new AbortController().signal)).resolves.toBe('Login redirect fix')
    expect(stub.requests).toHaveLength(1)
    const [request] = stub.requests
    expect(request!.url).toBe('/v1/responses')
    expect(request!.authorization).toBe('Bearer xai-dummy')
    const body = JSON.parse(request!.body) as { model: string; tools?: unknown[]; input: Array<{ role: string; content: unknown }>; reasoning?: { effort?: string } }
    expect(body.model).toBe('grok-4.7')
    expect(body.reasoning?.effort).toBe('high')
    expect(body.tools ?? []).toEqual([])
    // Two messages: Mousse's system text, then the prompt as written; nothing else of anyone's.
    expect(body.input).toHaveLength(2)
    expect(body.input[1]!.role).toBe('user')
    expect(JSON.stringify(body.input)).toContain('MOUSSE-SYSTEM')
    expect(JSON.stringify(body.input)).toContain('MOUSSE-PROMPT')
    expect(seen.sent).toBe(1)
  })

  // Rows: the stub's answer, what the runner reads it as. Each is sent once; the control below shows the same transport
  // sending it again when retries are allowed, so one request here is the route's doing.
  for (const [status, kind] of [[429, 'rate_limited'], [503, 'unavailable']] as const) {
    it(`sends a request answered ${status} once`, async () => {
      const stub = await startStub(status)
      const { runtime } = setup({ base: { XAI_API_KEY: 'xai-dummy' }, driver: { direct: { baseUrl: stub.base } } })
      const error = await runtime.oneShotTransport!({ model: 'grok-4.7' }).send(WIRE, events(), new AbortController().signal).then(() => undefined, (cause: unknown) => cause)
      expect(error).toBeDefined()
      expect(classifyOneShotFailure(error)).toBe(kind)
      expect(stub.requests.filter((request) => request.url === '/v1/responses')).toHaveLength(1)
    })

    it(`control: the same transport with retries allowed sends a request answered ${status} again`, async () => {
      const stub = await startStub(status)
      const retrying: typeof responsesStream = (model, context, options) => responsesStream(model, context, { ...options, maxRetries: 2 })
      const { runtime } = setup({ base: { XAI_API_KEY: 'xai-dummy' }, driver: { direct: { baseUrl: stub.base, stream: retrying } } })
      await runtime.oneShotTransport!({ model: 'grok-4.7' }).send(WIRE, events(), new AbortController().signal).catch(() => undefined)
      expect(stub.requests.filter((request) => request.url === '/v1/responses')).toHaveLength(3)
    })
  }

  it('refuses before sending when the key is gone', async () => {
    const { runtime } = setup({ base: {} })
    const seen = events()
    await expect(runtime.oneShotTransport!({ model: 'grok-4.7' }).send(WIRE, seen, new AbortController().signal)).rejects.toMatchObject({ code: 'signed_out' })
    expect(seen.sent).toBe(0)
  })
})

describe('acp:grok', () => {
  async function launch(runtime: DriverRuntime) {
    const failure = await runtime.oneShotTransport!({ model: 'grok-4.7' }).send(WIRE, events(), new AbortController().signal).then(() => undefined, (cause: unknown) => cause)
    if (!launched.length) throw failure
    expect(launched).toHaveLength(1)
    return launched.splice(0)[0]!
  }

  it("starts Grok on a home of the request's own that denies every tool, with the entry's own sign-in read in place", async () => {
    const { runtime, grokHome, root } = setup({ account: true, base: { MOUSSE_PERSON_SECRET: 'from-mousse' }, args: ['--dangerously-skip-permissions'] })
    const started = await launch(runtime)
    const home = started.env.GROK_HOME!
    expect(home.startsWith(join(root, 'profile'))).toBe(true)
    expect(started.config).toContain('rules = [ { action = "deny", tool = "any" } ]')
    expect(started.config).toContain('max_retries = 0')
    expect(started.env.GROK_AUTH_PATH).toBe(join(grokHome, 'auth.json'))
    // The person's home and Mousse's own variables stay out; every source Grok reads from other agents is off.
    expect(started.env.HOME!.startsWith(join(root, 'profile'))).toBe(true)
    expect(started.env.USERPROFILE!.startsWith(join(root, 'profile'))).toBe(true)
    expect(started.env.MOUSSE_PERSON_SECRET).toBeUndefined()
    expect(started.env.XAI_API_KEY).toBeUndefined()
    for (const agent of ['CLAUDE', 'CURSOR', 'CODEX']) for (const kind of ['SKILLS', 'RULES', 'AGENTS', 'MCPS', 'HOOKS']) expect(started.env[`GROK_${agent}_${kind}_ENABLED`]).toBe('0')
    expect(started.env.GROK_MEMORY).toBe('0')
    // The preset's arguments only: the entry's own are not passed on.
    expect(started.args).toEqual(grokArgs())
  })

  it('starts nothing for a sign-in Mousse cannot tell, even once admitted', async () => {
    const { runtime } = setup({ account: true, base: { GROK_AUTH_PROVIDER_COMMAND: 'corp-token' } })
    const seen = events()
    await expect(runtime.oneShotTransport!({ model: 'grok-4.7' }).send(WIRE, seen, new AbortController().signal)).rejects.toMatchObject({ code: 'unsupported', details: { reason: 'not_admitted' } })
    expect(launched).toEqual([])
    expect(seen.sent).toBe(0)
  })

  it('names the sign-in file as it is now: a replaced file is the next request’s, and no copy is kept anywhere', async () => {
    const { runtime, grokHome, root } = setup({ account: true })
    const first = await launch(runtime)
    // A sign-in elsewhere replaces the file in one step, as Grok's own refresh and Mousse's sign-in do.
    const next = join(grokHome, 'auth.json.next')
    accountFile(next, 'u-1')
    renameSync(next, join(grokHome, 'auth.json'))
    const second = await launch(runtime)
    expect(second.env.GROK_AUTH_PATH).toBe(first.env.GROK_AUTH_PATH)
    const found: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name))
        else if (entry.name === 'auth.json') found.push(join(dir, entry.name))
      }
    }
    walk(root)
    expect(found).toEqual([join(grokHome, 'auth.json')])
    expect(existsSync(join(root, 'state', 'one-shot'))).toBe(false)
  })
})
