/**
 * PR 6 §4 unit 6c-1: the bot engine. A bot asks up front for what its role needs, the owner
 * approves once, and it runs inside that grant without asking; a revision that asks for more
 * waits for the owner again. Manual activations run one dispatch each, written to `bots.db`
 * first and then atomically to the run database with an inert payload.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotEngine, type BotEngineHost } from '../../src/mms/bots/activation/BotEngine'
import { BotDefinitionStore } from '../../src/mms/bots/definitions/BotDefinitionStore'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import { BotStore } from '../../src/mms/bots/store/BotStore'
import { PI_NATIVE_TOOLS } from '../../src/mms/harness/pi/nativeTools'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectOutbox } from '../../src/mms/run/EffectOutbox'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { ToolInvocations } from '../../src/mms/run/ToolInvocations'
import { isBotTurnPayload, type BotTurnPayload } from '../../src/mms/run/types'
import type { BotDefinition, BotManifest } from '../../src/shared/bots/personal/definition'
import type { Enforceability, RunPolicy } from '../../src/shared/harness/types'

let base: string
let profile: string
let root: string
let clock: number
let store: BotStore
let runDb: ProfileDatabase
let runs: RunEngine
let outbox: EffectOutbox
let bots: BotEngine
let check: (instanceId: string, policy: RunPolicy) => Enforceability
let checked: RunPolicy[]
let stopped: string[]
let timers: Array<{ fn: () => void; ms: number }>
let engineHost: BotEngineHost

const T0 = Date.parse('2026-10-27T09:00:00.000Z')

const manifest = (patch: Partial<BotManifest> = {}): BotManifest => ({
  tools: ['read', 'search'],
  appTools: [],
  mcp: [],
  skills: [],
  workspace: { roots: [root], access: 'read' },
  budget: { maxActiveMs: 10 * 60_000, maxTurns: 30 },
  audience: 'owner',
  ...patch
})

const definition = (patch: Partial<BotManifest> = {}): BotDefinition => ({
  id: 'site-editor',
  name: 'Site editor',
  role: 'You keep the site tidy.',
  main: { key: 'main', title: 'Main', agent: { instructions: 'Answer briefly.' }, selection: { instanceId: 'pi:openrouter', model: 'some/model' } },
  context: [],
  permissions: manifest(patch),
  triggers: { manual: true }
})

const publish = (patch: Partial<BotManifest> = {}) => {
  const saved = bots.save(definition(patch), bots.list().find((bot) => bot.id === 'site-editor')?.draftHash)
  return bots.publish('site-editor', saved.draftHash)
}

const approve = () => bots.approve('site-editor', botManifestDigest(bots.get('site-editor').published!.permissions))

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-engine-')))
  profile = join(base, 'profile')
  root = join(base, 'site')
  mkdirSync(profile, { recursive: true })
  mkdirSync(root, { recursive: true })
  clock = T0
  store = new BotStore({ profileHome: profile, clock: () => clock })
  runDb = new ProfileDatabase({ profileHome: profile, clock: () => clock })
  const runStore = new RunStore(runDb)
  const now = () => new Date(clock).toISOString()
  outbox = new EffectOutbox(runStore, { now })
  runs = new RunEngine({ store: runStore, outbox, tools: new ToolInvocations(runStore), now, pid: 1 })
  checked = []
  stopped = []
  timers = []
  check = () => ({ ok: true })
  const host: BotEngineHost = {
    profileHome: profile,
    store,
    definitions: new BotDefinitionStore(store.directory, (botId) => store.registry(botId)?.revision ?? null),
    threads: { ensureExecutionThread: (key) => ({ id: `thread:${key}` }) },
    runs: () => runs,
    harness: {
      checkPolicy: (instanceId, policy) => {
        checked.push(policy)
        return check(instanceId, policy)
      },
      nativeToolNames: (_instanceId, tools) => ({ ok: true, names: tools.flatMap((tool) => [...(PI_NATIVE_TOOLS[tool] ?? [])]) })
    },
    notifyEffects: () => {},
    stopThread: (threadId) => { stopped.push(threadId) },
    clock: () => clock,
    monotonic: () => clock,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms })
      return { clear: () => {} }
    }
  }
  engineHost = host
  bots = new BotEngine(host)
})

afterEach(() => {
  bots.close()
  store.close()
  runDb.close()
  rmSync(base, { recursive: true, force: true })
})

const turnStart = (runId: string): BotTurnPayload => {
  const effect = outbox.listForRun(runId).find((entry) => entry.kind === 'turn.start')!
  if (!isBotTurnPayload(effect.payload)) throw new Error('not a bot payload')
  return effect.payload
}

const finish = (runId: string, status: 'completed' | 'failed' | 'interrupted' = 'completed') => {
  runs.markStarting(runId)
  runs.markRunning(runId)
  runs.markTerminal(runId, status)
}

describe('approval', () => {
  it('nothing runs before the owner approves, and an approval names the exact permissions', async () => {
    publish()
    await expect(bots.activate({ botId: 'site-editor', input: 'Fix the footer', clientRequestId: 'c1' })).rejects.toMatchObject({ code: 'bot_approval_required' })
    expect(() => bots.approve('site-editor', '0'.repeat(64))).toThrow(expect.objectContaining({ code: 'bot_grant_changed' }))
    expect(bots.approval('site-editor').added.map((line) => line.text)).toEqual([
      `Read files in ${root}`,
      `Search files in ${root}`,
      'Up to 10 minutes of work per run',
      'Up to 30 model requests (retries included) per run'
    ])
    expect(approve()).toMatchObject({ digest: botManifestDigest(manifest()) })
    expect(bots.list()[0]).toMatchObject({ grant: { digest: botManifestDigest(manifest()) }, needsApproval: [] })
  })

  it('approval is refused while a thread\'s runtime cannot hold the grant', () => {
    publish()
    check = () => ({ ok: false, error: { code: 'policy_unenforceable', message: 'no', missing: ['toolControl'], reason: 'Codex can\'t limit tools to this list.' } })
    expect(bots.approval('site-editor').threads).toEqual([{ key: 'main', instanceId: 'pi:openrouter', model: 'some/model', ok: false, reason: 'Codex can\'t limit tools to this list.' }])
    expect(() => approve()).toThrow(expect.objectContaining({ code: 'policy_unenforceable' }))
    expect(store.activeGrant('site-editor')).toBeUndefined()
  })

  it('a narrower revision runs without asking; a wider one waits for the owner', async () => {
    publish()
    approve()
    publish({ tools: ['read'], budget: { maxActiveMs: 5 * 60_000, maxTurns: 10 } })
    await expect(bots.activate({ botId: 'site-editor', input: 'a', clientRequestId: 'narrow' })).resolves.toMatchObject({ status: 'running' })
    publish({ tools: ['read', 'search', 'edit'] })
    await expect(bots.activate({ botId: 'site-editor', input: 'b', clientRequestId: 'wide' })).rejects.toMatchObject({
      code: 'bot_approval_required',
      details: { added: [{ kind: 'tool', text: 'Edit files (no folder allows it)' }] }
    })
  })

  it('approval and dispatch read the runtime\'s policy facts again first, so a runtime that only knows them after a reading can hold the bot (review r2)', async () => {
    publish()
    // A runtime that can hold a bot only on a fresh reading (a locked Claude entry's policy).
    let fresh = false
    const refreshed: string[] = []
    engineHost.harness.refreshPolicyFacts = async (instanceId) => {
      refreshed.push(instanceId)
      fresh = true
    }
    check = () => (fresh ? { ok: true } : { ok: false, error: { code: 'policy_unenforceable', message: 'no', missing: ['toolControl'], reason: 'Not read yet.' } })
    expect(() => approve()).toThrow(expect.objectContaining({ code: 'policy_unenforceable' }))
    await bots.refreshRuntimes('site-editor')
    expect(refreshed).toEqual(['pi:openrouter'])
    expect(approve()).toMatchObject({ digest: botManifestDigest(manifest()) })
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'c1' })
    const payload = turnStart(store.dispatch(activation.id, 1)!.runId!)
    fresh = false
    expect(bots.prepare(payload)).toMatchObject({ code: 'policy_unenforceable' })
    await bots.refresh(payload)
    expect(refreshed).toEqual(['pi:openrouter', 'pi:openrouter'])
  })

  it('shell is never approvable on this build', () => {
    publish({ tools: ['read', 'shell'] })
    expect(bots.approval('site-editor').threads[0]).toMatchObject({ ok: false, reason: expect.stringContaining('sandbox') })
    expect(() => approve()).toThrow(expect.objectContaining({ code: 'policy_unenforceable' }))
  })
})

describe('activation and dispatch', () => {
  beforeEach(() => {
    publish()
    approve()
  })

  it('writes the dispatch first, then one run with an inert payload; a repeat returns the same activation', async () => {
    const activation = await bots.activate({ botId: 'site-editor', input: 'Fix the footer', clientRequestId: 'c1' })
    expect(activation).toMatchObject({ status: 'running', threadId: 'thread:bot:site-editor:act:' + activation.id, trigger: { kind: 'manual', input: 'Fix the footer' } })
    const dispatch = store.dispatch(activation.id, 1)!
    expect(dispatch).toMatchObject({ kind: 'start', clientRequestId: `${activation.id}:d1`, policyDigest: botManifestDigest(manifest()), prompt: { text: 'Fix the footer' } })
    expect(runs.getRun(dispatch.runId!)).toMatchObject({ status: 'queued', source: 'bot' })
    expect(turnStart(dispatch.runId!)).toEqual({ kind: 'bot', runId: dispatch.runId, threadId: activation.threadId, activationId: activation.id, dispatchN: 1 })
    expect(store.threadRole(activation.threadId!)).toBe('activation')
    expect(store.threadRole('thread:bot:site-editor')).toBe('home')
    expect(bots.roleOf(activation.threadId!)).toBe('activation')
    expect(bots.roleOf('thread:bot:site-editor')).toBeUndefined()
    expect(bots.ownerOf('thread:bot:site-editor')).toBe('Site editor')
    const again = await bots.activate({ botId: 'site-editor', input: 'Fix the footer', clientRequestId: 'c1' })
    expect(again.id).toBe(activation.id)
    expect(runs.listRuns(activation.threadId!)).toHaveLength(1)
  })

  it('prepare compiles the grant, binds as a bot and prepays the remaining active time', async () => {
    const activation = await bots.activate({ botId: 'site-editor', input: '/deploy now', clientRequestId: 'c1' })
    const payload = turnStart(store.dispatch(activation.id, 1)!.runId!)
    const prepared = bots.prepare(payload)
    if ('refused' in prepared) throw new Error(prepared.refused)
    expect(prepared.prompt).toBe(' /deploy now')
    expect(prepared.instructions).toBe('You keep the site tidy.\n\nAnswer briefly.')
    expect(prepared.policy).toMatchObject({ approvals: 'grants', approve: 'host', tools: { allow: ['escalate', 'find', 'grep', 'read'] }, budget: { maxTurns: 30, maxWallMs: 10 * 60_000 }, authority: { kind: 'bot' } })
    expect(prepared.authority.spend).toBeNull()
    expect(existsSync(join(prepared.scratch, 'tmp'))).toBe(true)
    expect(store.counters(activation.id).activeMs).toBe(10 * 60_000)
    expect(checked.at(-1)).toMatchObject({ origin: 'bot', mode: 'default' })
    // A second claim of the same turn.start is refused: the dispatch already started.
    expect(bots.prepare(payload)).toMatchObject({ code: 'bot_dispatch_started' })
  })

  it('a completed run ends the activation done, refunds unused time, and removes the scratch folder', async () => {
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'c1' })
    const payload = turnStart(store.dispatch(activation.id, 1)!.runId!)
    const prepared = bots.prepare(payload)
    if ('refused' in prepared) throw new Error(prepared.refused)
    clock += 42_000
    finish(payload.runId)
    bots.settle(payload, { text: 'Footer fixed.' })
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'done', result: 'Footer fixed.', counters: { activeMs: 42_000 } })
    expect(store.dispatch(activation.id, 1)).toMatchObject({ usedMs: 42_000, prepaidMs: 42_000, settledBy: 'run', outcome: 'completed' })
    expect(existsSync(prepared.scratch)).toBe(false)
    // Settling twice changes nothing.
    clock += 60_000
    bots.settle(payload, { text: 'again' })
    expect(bots.getActivation(activation.id)).toMatchObject({ result: 'Footer fixed.', counters: { activeMs: 42_000 } })
  })

  it('a run that has not ended is not settled', async () => {
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'c1' })
    const payload = turnStart(store.dispatch(activation.id, 1)!.runId!)
    bots.prepare(payload)
    bots.settle(payload, {})
    expect(bots.getActivation(activation.id).status).toBe('running')
  })

  it('refuses a dispatch whose grant changed under it, and blocks the activation', async () => {
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'c1' })
    // The grant row changes without the engine (another process): prepare still refuses.
    store.revoke('site-editor')
    const payload = turnStart(store.dispatch(activation.id, 1)!.runId!)
    expect(bots.prepare(payload)).toMatchObject({ code: 'bot_grant_revoked' })
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'blocked', endReason: 'bot_grant_revoked' })
    expect(store.counters(activation.id).activeMs).toBe(0)
  })

  it('revoking the grant stops a running dispatch, and its authority refuses the next call', async () => {
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'c1' })
    const queued = await bots.activate({ botId: 'site-editor', input: 'later', clientRequestId: 'c2' })
    const prepared = bots.prepare(turnStart(store.dispatch(activation.id, 1)!.runId!))
    if ('refused' in prepared) throw new Error(prepared.refused)
    const call = { kind: 'builtin' as const, tool: 'read' as const, nativeName: 'read', args: { path: join(root, 'a.md') } }
    expect(prepared.authority.check(call)).toEqual({ ok: true })
    bots.revoke('site-editor')
    expect(prepared.authority.check(call)).toEqual({ ok: false, wall: { kind: 'revoked' } })
    expect(prepared.authority.time.signal.aborted).toBe(true)
    await new Promise((resolve) => setImmediate(resolve))
    expect(stopped).toEqual([activation.threadId])
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'cancelled', endReason: 'grant_revoked' })
    expect(bots.getActivation(queued.id)).toMatchObject({ status: 'cancelled', endReason: 'grant_revoked' })
  })

  it('approving a replacement grant ends the dispatch running under the old one', async () => {
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'c1' })
    const prepared = bots.prepare(turnStart(store.dispatch(activation.id, 1)!.runId!))
    if ('refused' in prepared) throw new Error(prepared.refused)
    publish({ tools: ['read'] })
    approve()
    expect(prepared.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: join(root, 'a.md') } })).toEqual({ ok: false, wall: { kind: 'revoked' } })
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'cancelled', endReason: 'grant_replaced' })
  })

  it('a narrower published revision is what runs: tools, folders, access, limits and work time', async () => {
    const wide = manifest({ tools: ['read', 'search'], workspace: { roots: [root, join(base, 'docs')], access: 'read' }, budget: { maxActiveMs: 10 * 60_000, maxTurns: 30 } })
    mkdirSync(join(base, 'docs'))
    bots.save({ ...definition(), permissions: wide }, bots.get('site-editor').draftHash)
    bots.publish('site-editor', bots.get('site-editor').draftHash)
    approve()
    publish({ tools: ['read'], workspace: { roots: [root], access: 'read' }, budget: { maxActiveMs: 2 * 60_000, maxTurns: 5 } })
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'narrow' })
    expect(store.counters(activation.id).limits).toEqual({ maxTurns: 5 })
    const prepared = bots.prepare(turnStart(store.dispatch(activation.id, 1)!.runId!))
    if ('refused' in prepared) throw new Error(prepared.refused)
    expect(prepared.policy).toMatchObject({ tools: { allow: ['escalate', 'read'] }, budget: { maxTurns: 5, maxWallMs: 2 * 60_000 } })
    expect(store.counters(activation.id).activeMs).toBe(2 * 60_000)
    // An ungranted tool is a wall (6c-2): the owner is asked, and every later call waits.
    expect(prepared.authority.check({ kind: 'builtin', tool: 'search', nativeName: 'grep', args: { path: root } })).toMatchObject({ ok: false, wall: { kind: 'escalated', permission: 'Use the tool `search`' } })
    expect(prepared.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: join(base, 'docs', 'a.md') } })).toMatchObject({ ok: false, wall: { kind: 'waiting' } })
  })

  it('the deadline ends the dispatch at a budget wall; later calls are refused', async () => {
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'c1' })
    const prepared = bots.prepare(turnStart(store.dispatch(activation.id, 1)!.runId!))
    if ('refused' in prepared) throw new Error(prepared.refused)
    expect(timers.map((timer) => timer.ms)).toEqual([10 * 60_000])
    timers[0].fn()
    await new Promise((resolve) => setImmediate(resolve))
    expect(prepared.authority.time.signal.aborted).toBe(true)
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'waiting_grant', openEscalation: { kind: 'budget', permission: { budget: { key: 'maxActiveMs' } } } })
    expect(prepared.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: join(root, 'a.md') } })).toEqual({ ok: false, wall: { kind: 'waiting' } })
  })

  it('the run\'s terminal event settles the dispatch on any path; the final message lands afterwards', async () => {
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'c1' })
    const payload = turnStart(store.dispatch(activation.id, 1)!.runId!)
    bots.prepare(payload)
    clock += 5_000
    finish(payload.runId)
    bots.settleRun(payload.runId)
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'done', result: '', counters: { activeMs: 5_000 } })
    bots.settle(payload, { text: 'Done.' })
    expect(bots.getActivation(activation.id).result).toBe('Done.')
    // Settlement is not evidence that the processes are gone.
    expect(store.get('SELECT exit_at FROM bot_dispatches WHERE activation_id = ?', activation.id)).toEqual({ exit_at: null })
  })

  it('a dispatch settled by a process that did not run it refunds nothing', async () => {
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'c1' })
    const payload = turnStart(store.dispatch(activation.id, 1)!.runId!)
    bots.prepare(payload)
    clock += 5_000
    finish(payload.runId)
    new BotEngine(engineHost).settleRun(payload.runId)
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'done', counters: { activeMs: 10 * 60_000 } })
  })

  it('refuses a dispatch the runtime cannot hold now, before any time is charged', async () => {
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'c1' })
    check = () => ({ ok: false, error: { code: 'policy_unenforceable', message: 'no', missing: ['budgets'], reason: 'This provider cannot count requests.' } })
    expect(bots.prepare(turnStart(store.dispatch(activation.id, 1)!.runId!))).toMatchObject({ code: 'policy_unenforceable' })
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'blocked', counters: { activeMs: 0 } })
  })

  it('with less than one 15-second slice of work time left, nothing is dispatched', async () => {
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'c1' })
    store.run('UPDATE bot_counters SET active_ms = ? WHERE activation_id = ?', 10 * 60_000 - 14_000, activation.id)
    expect(bots.prepare(turnStart(store.dispatch(activation.id, 1)!.runId!))).toMatchObject({ code: 'active_time_exhausted' })
    // A budget wall: the owner may allow more time.
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'waiting_grant', openEscalation: { kind: 'budget', permission: { budget: { key: 'maxActiveMs' } } } })
  })

  it('one activation runs at a time; the next starts when it ends', async () => {
    const first = await bots.activate({ botId: 'site-editor', input: 'one', clientRequestId: 'c1' })
    const second = await bots.activate({ botId: 'site-editor', input: 'two', clientRequestId: 'c2' })
    expect(second).toMatchObject({ status: 'queued', threadId: null })
    const payload = turnStart(store.dispatch(first.id, 1)!.runId!)
    bots.prepare(payload)
    finish(payload.runId, 'failed')
    bots.settle(payload, {})
    expect(bots.getActivation(first.id)).toMatchObject({ status: 'failed', endReason: 'failed' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(bots.getActivation(second.id).status).toBe('running')
  })

  it('a tool call cut off without an outcome pauses the activation until the owner checks it', async () => {
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'c1' })
    const payload = turnStart(store.dispatch(activation.id, 1)!.runId!)
    bots.prepare(payload)
    runs.markStarting(payload.runId)
    runs.markRunning(payload.runId)
    const attemptId = runs.getRun(payload.runId)!.activeAttemptId!
    const now = new Date(clock).toISOString()
    runs.tools.start({ invocationId: 'inv-edit', runId: payload.runId, attemptId, tool: 'edit', argsDigest: 'd', now })
    runs.tools.start({ invocationId: 'inv-read', runId: payload.runId, attemptId, tool: 'read_file', argsDigest: 'd', now })
    runs.markTerminal(payload.runId, 'interrupted')
    bots.settle(payload, {})
    expect(bots.getActivation(activation.id)).toMatchObject({
      status: 'paused',
      endReason: 'unknown_calls',
      unknownCalls: [{ runId: payload.runId, invocationId: 'inv-edit', tool: 'edit', role: 'main', acknowledged: false }]
    })
  })

  it('stopping a queued activation ends it; stopping a running one stops its thread', async () => {
    const first = await bots.activate({ botId: 'site-editor', input: 'one', clientRequestId: 'c1' })
    const second = await bots.activate({ botId: 'site-editor', input: 'two', clientRequestId: 'c2' })
    await expect(bots.stop(second.id)).resolves.toMatchObject({ status: 'cancelled', endReason: 'stopped' })
    await expect(bots.stop(first.id)).resolves.toMatchObject({ status: 'cancelled', endReason: 'stopped' })
    expect(stopped).toEqual([first.threadId])
    // The run's end still settles the time, and the activation stays stopped.
    const payload = turnStart(store.dispatch(first.id, 1)!.runId!)
    expect(bots.prepare(payload)).toMatchObject({ code: 'bot_activation_not_running' })
  })

  it('when bots.db cannot be read, a known bot thread stays read-only and other threads are left alone', async () => {
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'c1' })
    const reader = new BotEngine(engineHost)
    store.close()
    // The name is in bots.db too; the id still names the bot in the refusal.
    expect(reader.ownerOf(activation.threadId!)).toBe('site-editor')
    expect(reader.roleOf(activation.threadId!)).toBe('activation')
    expect(reader.ownerOf('person-thread')).toBeUndefined()
    expect(reader.roleOf('person-thread')).toBeUndefined()
    store = new BotStore({ profileHome: profile, clock: () => clock })
  })

  it('keeps at most 20 waiting activations; the oldest is dropped', async () => {
    await bots.activate({ botId: 'site-editor', input: 'running', clientRequestId: 'run' })
    const waiting = []
    for (let index = 0; index < 21; index += 1) {
      clock += 1
      waiting.push(await bots.activate({ botId: 'site-editor', input: `q${index}`, clientRequestId: `q${index}` }))
    }
    expect(bots.getActivation(waiting[0].id)).toMatchObject({ status: 'cancelled', endReason: 'queue_full' })
    expect(bots.listActivations('site-editor').filter((row) => row.status === 'queued')).toHaveLength(20)
  })

  it('deleting the bot cancels its activations, revokes its grant and trashes its home thread', async () => {
    const running = await bots.activate({ botId: 'site-editor', input: 'one', clientRequestId: 'c1' })
    const trashed: string[] = []
    engineHost.trashThread = async (threadId) => { trashed.push(threadId) }
    // Its run ends when its thread is stopped; only then does the home thread move.
    engineHost.stopThread = (threadId) => {
      stopped.push(threadId)
      runs.markTerminal(store.dispatch(running.id, 1)!.runId!, 'cancelled', { error: 'stopped' })
    }
    await bots.remove('site-editor')
    expect(trashed).toEqual(['thread:bot:site-editor'])
    expect(bots.getActivation(running.id)).toMatchObject({ status: 'cancelled', endReason: 'bot_deleted' })
    expect(store.activeGrant('site-editor')).toBeUndefined()
    expect(bots.list()).toEqual([])
  })
})
