/**
 * `cursor:sdk`'s transport (`harness/cursor/oneShot.ts`) on the real host entry, started in its place by the real
 * driver, with a fake `@cursor/sdk` that scripts the run: the agent it asks for, the answer, a tool the run reports, a
 * refused key, a reply that is only a transport error, and an entry that changed before the request left.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cursorEntryEnv } from '../src/mms/harness/cursor/oneShot'
import { cursorDriver } from '../src/mms/harness/drivers/cursor'
import type { DriverContext, DriverRuntime } from '../src/mms/harness/driver'
import { instanceEnv } from '../src/mms/harness/env'
import { routeLabel } from '../src/mms/harness/oneShot/admission'
import { classifyOneShotFailure } from '../src/mms/harness/oneShot/runner'
import { InstanceVault } from '../src/mms/harness/vault'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { placesLeft, recordingEvents } from './harness/realOpencode'
import { cursorHostScript } from './harness/realCursor'

const FAKE_SDK = join(__dirname, 'harness', 'fakeCursorSdk.cjs')
let hostScript: string
beforeAll(async () => {
  hostScript = await cursorHostScript()
}, 60_000)

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function setup(key: string | null = 'entry-key') {
  const profile = mkdtempSync(join(tmpdir(), 'mousse-cursor-one-shot-'))
  const log = join(profile, 'sdk-calls.ndjson')
  const stateDir = join(profile, 'harness', 'cursor-work')
  if (key) new InstanceVault(join(stateDir, 'secrets.json')).set('apiKey', key)
  const context: DriverContext = {
    instanceId: 'cursor:work',
    builtIn: false,
    config: { home: 'default', displayName: 'Work' },
    env: instanceEnv({ instanceId: 'cursor:work', driver: 'cursor', configRevision: 0, searchPath: [], base: { ...process.env, CURSOR_API_KEY: 'ambient-key' } }),
    profileHome: profile,
    installationHome: profile,
    stateDir,
    questions: new UserQuestionService(),
    findBinary: () => undefined,
    changed: () => {}
  }
  const runtime: DriverRuntime = cursorDriver({ hostScript, hostEnv: { MOUSSE_CURSOR_SDK_MODULE: FAKE_SDK, MOUSSE_FAKE_CURSOR_LOG: log } }).create(context)
  cleanups.push(() => {
    runtime.stop()
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })
  const calls = (): Array<Record<string, unknown>> => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    } catch {
      return []
    }
  }
  /** One request whose whole text is `prompt` (the fake SDK scripts its run by it). */
  const send = (prompt: string, model = 'default', sending?: () => void) => {
    const { seen, events } = recordingEvents()
    const sent = runtime.oneShotTransport!({ model }).send({ model, system: '', prompt }, { ...events, sending: () => { sending?.(); events.sending() } }, AbortSignal.timeout(30_000))
    return { seen, sent }
  }
  return { profile, calls, send }
}

const failureOf = (sent: Promise<string>) => sent.then(() => undefined, (error: unknown) => error)

describe('cursor:sdk on a host of its own', () => {
  it('is held on every model', () => {
    const route = cursorDriver().oneShotRoute!({ config: { home: 'default' }, installedVersion: undefined, instanceId: 'cursor:work', model: 'gpt-5' })
    expect(route).toEqual({ route: { id: 'cursor:sdk', facts: { tools: 'none_offered', attempts: 'one', isolation: 'verified', launch: 'sealed_host', audience: 'any' } } })
    expect(routeLabel((route as { route: { facts: never } }).route)).toBe('held')
  })

  it('answers with the run’s text from one agent with no tool, no settings layer, no MCP server and no retry, in its place', async () => {
    const { profile, calls, send } = setup()
    const { seen, sent } = send('name this', 'gpt-5')
    await expect(sent).resolves.toBe('ok')
    expect(seen.sent).toBe(1)
    expect(seen.launched).toEqual([process.execPath])
    const create = calls().find((call) => call.call === 'create') as { ambientKey: unknown; options: { apiKey: string; model: unknown; tools: unknown; mcpServers?: unknown; local: Record<string, unknown> } }
    expect(create.ambientKey).toBeNull()
    expect(create.options).toMatchObject({ apiKey: 'entry-key', model: { id: 'gpt-5' }, tools: [], local: { store: 'jsonl', settingSources: [], enableAgentRetries: false, autoReview: false, customTools: false } })
    expect(create.options.mcpServers).toBeUndefined()
    // Its agent store is in its place, never the entry's.
    expect(relative(join(profile, 'one-shot'), String(create.options.local.storeDir))).not.toMatch(/^\.\./)
    expect(calls().find((call) => call.call === 'send')).toMatchObject({ text: 'name this', keys: ['onDelta'] })
    expect(placesLeft(profile)).toEqual([])
  }, 60_000)

  it('runs Auto when no model is named', async () => {
    const { calls, send } = setup()
    await expect(send('name this', '').sent).resolves.toBe('ok')
    expect(calls().find((call) => call.call === 'create')).toMatchObject({ options: { model: { id: 'default' } } })
  }, 60_000)

  it('reports a tool the run uses, for the runner to end the request', async () => {
    const { send } = setup()
    const { seen, sent } = send('hello')
    await failureOf(sent)
    expect(seen.tools).toEqual(['shell', 'shell'])
  }, 60_000)

  it('fails as signed out when Cursor refuses the key', async () => {
    const { send } = setup()
    expect(classifyOneShotFailure(await failureOf(send('revoked').sent))).toBe('signed_out')
  }, 60_000)

  it('fails when the reply is only a transport error', async () => {
    const { send } = setup()
    const { sent } = send('transport')
    await expect(sent).rejects.toThrow(/connection reset/)
    expect(classifyOneShotFailure(await failureOf(sent))).toBe('unavailable')
  }, 60_000)

  it('sends nothing when the entry changed before the request left, and leaves no place', async () => {
    const { profile, calls, send } = setup()
    const stale = Object.assign(new Error('changed'), { code: 'binding_stale' })
    const { seen, sent } = send('name this', 'default', () => { throw stale })
    expect(await failureOf(sent)).toBe(stale)
    expect(seen.sent).toBe(0)
    expect(calls().filter((call) => call.call === 'create' || call.call === 'send')).toEqual([])
    expect(placesLeft(profile)).toEqual([])
  }, 60_000)

  it('does not start without a key', async () => {
    const { profile, send } = setup(null)
    const { seen, sent } = send('name this')
    expect(classifyOneShotFailure(await failureOf(sent))).toBe('signed_out')
    expect(seen.launched).toEqual([])
    expect(placesLeft(profile)).toEqual([])
  })

  it('keeps none of the entry’s Cursor, host or Electron variables', () => {
    expect(cursorEntryEnv({ CURSOR_API_KEY: 'k', cursor_backend_url: 'u', MOUSSE_CURSOR_SDK_MODULE: 'm', ELECTRON_RUN_AS_NODE: '0', HTTPS_PROXY: 'p' })).toEqual({ HTTPS_PROXY: 'p' })
  })
})
