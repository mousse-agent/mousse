/**
 * PR 6 §4 unit 6c-1: the bot engine. A bot asks up front for what its role needs, the owner
 * approves once, and it runs inside that grant without asking; a revision that asks for more
 * waits for the owner again. Manual activations run one dispatch each, written to `bots.db`
 * first and then atomically to the run database with an inert payload.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOT_JOURNAL_ERROR, BOT_OFFLINE_WATCH_MS, BOT_PERMISSION_REMOVED_TEXT, BotEngine, type BotEngineHost } from '../../src/mms/bots/activation/BotEngine'
import { BotDefinitionStore } from '../../src/mms/bots/definitions/BotDefinitionStore'
import { botFilesFolder, botManifestDigest } from '../../src/mms/bots/grants/compile'
import { BotStore } from '../../src/mms/bots/store/BotStore'
import { PI_NATIVE_TOOLS } from '../../src/mms/harness/pi/nativeTools'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectOutbox } from '../../src/mms/run/EffectOutbox'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { ToolInvocations } from '../../src/mms/run/ToolInvocations'
import { isBotTurnPayload, type BotTurnPayload } from '../../src/mms/run/types'
import type { BotDefinition, BotManifest } from '../../src/shared/bots/personal/definition'
import { BOT_TURN_WINDOW_MS } from '../../src/shared/bots/personal/definition'
import type { Enforceability, RunPolicy } from '../../src/shared/harness/types'
import { BOT_RUN_REPORT_LINE } from '../../src/mms/bots/memory/contextPack'
import { BOT_ITEM_TOOLS } from '../../src/shared/bots/personal/items'
import { BOT_MEMORY_TOOLS } from '../../src/shared/bots/personal/memory'
import { BOT_AUTOMATION_APP_TOOLS, BOT_PROFILER_TOOLS, BOT_QUICK_ACTION_TOOLS, BOT_SCHEDULE_ACT_TOOLS, BOT_SCHEDULE_READ_TOOLS, BOT_SUBAGENT_TOOLS, BOT_TASK_TOOLS, BOT_THEME_TOOLS } from '../../src/shared/bots/personal/manifest'

/** What every bot's work has with no grant: the automation tools, its owner's skills, the profiler, Mousse's look, scheduled jobs, secrets and quick actions. */
const EVERY_BOT_WORK = [...BOT_AUTOMATION_APP_TOOLS, 'skill_list', 'skill_load', ...BOT_PROFILER_TOOLS, ...BOT_THEME_TOOLS, ...BOT_SCHEDULE_READ_TOOLS, ...BOT_SCHEDULE_ACT_TOOLS, 'secret_fetch', 'secret_request', ...BOT_QUICK_ACTION_TOOLS]

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
  workspace: null,
  budget: { maxTurns: 30 },
  audience: 'owner',
  ...patch
})

const definition = (patch: Partial<BotManifest> = {}): BotDefinition => ({
  format: 2,
  id: 'site-editor',
  name: 'Site editor',
  description: 'Keeps the site tidy.',
  look: { colour: 'teal', accessory: 'cap' },
  owner: { kind: 'person', id: 'self' },
  placement: { kind: 'this_computer' },
  role: 'You keep the site tidy.',
  main: { key: 'main', title: 'Main', agent: { instructions: 'Answer briefly.' }, model: { mode: 'auto', depth: 'normal' } },
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
  // The bot's files folder: the one folder its file tools reach, beside its scratch.
  root = botFilesFolder(profile, 'site-editor')
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
    // The hidden model (WP3): every activation resolves to this Pi model.
    models: { resolve: async () => ({ selection: { instanceId: 'pi:openrouter', model: 'some/model' } }), markLimited: () => {} },
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
      'Read files in its files folder',
      'Search files in its files folder',
      'Up to 30 model requests (retries included) per run'
    ])
    expect(approve()).toMatchObject({ digest: botManifestDigest(manifest()) })
    expect(bots.list()[0]).toMatchObject({ grant: { digest: botManifestDigest(manifest()) }, needsApproval: [] })
  })

  it('approval checks what every runtime needs; which runtime holds the bot is decided at each dispatch (Bot Phase 1 §5.6)', async () => {
    publish()
    check = () => ({ ok: false, error: { code: 'policy_unenforceable', message: 'no', missing: ['toolControl'], reason: 'Codex can\'t limit tools to this list.' } })
    // The model is hidden and chosen per activation: approval names no runtime.
    expect(bots.approval('site-editor').threads).toEqual([{ key: 'main', instanceId: '', model: '', ok: true }])
    approve()
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'c1' })
    expect(bots.prepare(turnStart(store.dispatch(activation.id, 1)!.runId!))).toMatchObject({ code: 'policy_unenforceable', refused: 'Codex can\'t limit tools to this list.' })
    // Nobody waits on a run: it ends failed (and counts toward the failure pause).
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'failed', endReason: 'policy_unenforceable' })
    // Its error says the runtime's own reason, not only that it can't run here.
    expect(store.registry('site-editor')?.error?.error.text).toBe('I can\'t run on the providers set up here: Codex can\'t limit tools to this list.')
  })

  it('a narrower revision runs without asking; a wider one waits for the owner', async () => {
    publish()
    approve()
    publish({ tools: ['read'], budget: { maxTurns: 10 } })
    await expect(bots.activate({ botId: 'site-editor', input: 'a', clientRequestId: 'narrow' })).resolves.toMatchObject({ status: 'running' })
    publish({ tools: ['read', 'search', 'edit'] })
    await expect(bots.activate({ botId: 'site-editor', input: 'b', clientRequestId: 'wide' })).rejects.toMatchObject({
      code: 'bot_approval_required',
      details: { added: [{ kind: 'tool', text: 'Edit files in its files folder' }] }
    })
  })

  it('a dispatch reads its runtime\'s policy facts again first, so a runtime that only knows them after a reading can hold the bot (review r2)', async () => {
    publish()
    approve()
    // A runtime that can hold a bot only on a fresh reading (a locked Claude entry's policy).
    let fresh = false
    const refreshed: string[] = []
    engineHost.harness.refreshPolicyFacts = async (instanceId) => {
      refreshed.push(instanceId)
      fresh = true
    }
    check = () => (fresh ? { ok: true } : { ok: false, error: { code: 'policy_unenforceable', message: 'no', missing: ['toolControl'], reason: 'Not read yet.' } })
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'c1' })
    const payload = turnStart(store.dispatch(activation.id, 1)!.runId!)
    await bots.refresh(payload)
    expect(refreshed).toEqual(['pi:openrouter'])
    expect(bots.prepare(payload)).not.toHaveProperty('refused')
    // The runtime the bot last ran on is the one `refreshRuntimes` reads.
    await bots.refreshRuntimes('site-editor')
    expect(refreshed).toEqual(['pi:openrouter', 'pi:openrouter'])
  })

  it('a bot with MCP tools reads its servers while its runtime\'s policy facts are still being read', async () => {
    publish({ mcp: [{ serverId: 'github.abc123def0', tool: 'list_issues' }] })
    approve()
    const order: string[] = []
    let factsRead!: () => void
    engineHost.harness.refreshPolicyFacts = () => new Promise<void>((done) => { order.push('facts'); factsRead = done })
    engineHost.mcp = { warm: async () => { order.push('mcp') }, servers: () => [] }
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'c1' })
    const refreshed = bots.refresh(turnStart(store.dispatch(activation.id, 1)!.runId!))
    await new Promise((resolve) => setImmediate(resolve))
    expect(order).toEqual(['facts', 'mcp'])
    factsRead()
    await refreshed
  })

  it('"run commands" (shell) is approvable like any other tool', () => {
    publish({ tools: ['read', 'shell'] })
    expect(bots.approval('site-editor').threads[0]).toMatchObject({ ok: true })
    approve()
    expect(store.activeGrant('site-editor')!.manifest.tools).toContain('shell')
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
    expect(dispatch).toMatchObject({ kind: 'start', clientRequestId: `${activation.id}:d1`, policyDigest: botManifestDigest(manifest()), prompt: { text: `Fix the footer\n\n${BOT_RUN_REPORT_LINE}` } })
    expect(runs.getRun(dispatch.runId!)).toMatchObject({ status: 'queued', source: 'bot' })
    expect(turnStart(dispatch.runId!)).toEqual({ kind: 'bot', runId: dispatch.runId, threadId: activation.threadId, activationId: activation.id, dispatchN: 1 })
    expect(store.threadRole(activation.threadId!)).toBe('activation')
    expect(store.threadRole('thread:bot:site-editor')).toBe('home')
    expect(bots.roleOf(activation.threadId!)).toBe('activation')
    // The home thread runs the chat lane's turns as bot turns.
    expect(bots.roleOf('thread:bot:site-editor')).toBe('activation')
    expect(bots.ownerOf('thread:bot:site-editor')).toBe('Site editor')
    const again = await bots.activate({ botId: 'site-editor', input: 'Fix the footer', clientRequestId: 'c1' })
    expect(again.id).toBe(activation.id)
    expect(runs.listRuns(activation.threadId!)).toHaveLength(1)
  })

  it('prepare compiles the grant, binds as a bot and prepays its window of active time', async () => {
    const activation = await bots.activate({ botId: 'site-editor', input: '/deploy now', clientRequestId: 'c1' })
    const payload = turnStart(store.dispatch(activation.id, 1)!.runId!)
    const prepared = bots.prepare(payload)
    if ('refused' in prepared) throw new Error(prepared.refused)
    // A run's request ends with what its last message is for (bot-context.md §5.2).
    expect(prepared.prompt).toBe(` /deploy now\n\n${BOT_RUN_REPORT_LINE}`)
    expect(prepared.instructions).toBe('You keep the site tidy.\n\nAnswer briefly.')
    expect(prepared.policy).toMatchObject({ approvals: 'grants', approve: 'host', tools: { allow: ['escalate', 'find', 'grep', ...BOT_MEMORY_TOOLS, ...BOT_ITEM_TOOLS, ...BOT_TASK_TOOLS, 'mcp_servers', 'publish_applet', 'read', 'report_bug', 'running_list', 'show_card', ...BOT_SUBAGENT_TOOLS, 'tool_catalogue', 'model_list', 'remind', 'watch_start', ...EVERY_BOT_WORK].sort() }, budget: { maxTurns: 30, maxWallMs: BOT_TURN_WINDOW_MS }, authority: { kind: 'bot' } })
    expect(prepared.authority.spend).toBeNull()
    expect(existsSync(join(prepared.scratch, 'tmp'))).toBe(true)
    expect(store.counters(activation.id).activeMs).toBe(BOT_TURN_WINDOW_MS)
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

  it('refuses a dispatch whose grant changed under it, and ends the run failed', async () => {
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'c1' })
    // The grant row changes without the engine (another process): prepare still refuses.
    store.revoke('site-editor')
    const payload = turnStart(store.dispatch(activation.id, 1)!.runId!)
    expect(bots.prepare(payload)).toMatchObject({ code: 'bot_grant_revoked' })
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'failed', endReason: 'bot_grant_revoked' })
    expect(store.counters(activation.id).activeMs).toBe(0)
    expect(store.registry('site-editor')).toMatchObject({ failureStreak: 1 })
  })

  it('revoking the grant stops every running dispatch, and its authority refuses the next call', async () => {
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'c1' })
    // A second run of the bot runs beside it.
    const beside = await bots.activate({ botId: 'site-editor', input: 'later', clientRequestId: 'c2' })
    const prepared = bots.prepare(turnStart(store.dispatch(activation.id, 1)!.runId!))
    if ('refused' in prepared) throw new Error(prepared.refused)
    const call = { kind: 'builtin' as const, tool: 'read' as const, nativeName: 'read', args: { path: join(root, 'a.md') } }
    expect(prepared.authority.check(call)).toEqual({ ok: true })
    bots.revoke('site-editor')
    expect(prepared.authority.check(call)).toEqual({ ok: false, wall: { kind: 'revoked' } })
    expect(prepared.authority.time.signal.aborted).toBe(true)
    await new Promise((resolve) => setImmediate(resolve))
    expect([...stopped].sort()).toEqual([activation.threadId, beside.threadId].sort())
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'cancelled', endReason: 'grant_revoked' })
    expect(bots.getActivation(beside.id)).toMatchObject({ status: 'cancelled', endReason: 'grant_revoked' })
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

  it('Remove while a turn runs refuses only what it took away: a lower limit refuses nothing', async () => {
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'c1' })
    const prepared = bots.prepare(turnStart(store.dispatch(activation.id, 1)!.runId!))
    if ('refused' in prepared) throw new Error(prepared.refused)
    const read = { kind: 'builtin' as const, tool: 'read' as const, nativeName: 'read', args: { path: join(root, 'a.md') } }
    const search = { kind: 'builtin' as const, tool: 'search' as const, nativeName: 'grep', args: { path: root } }
    bots.narrowGrant('site-editor', (held) => ({ ...held, budget: { ...held.budget, maxTurns: 20 } }))
    expect(prepared.authority.check(read)).toEqual({ ok: true })
    expect(prepared.authority.check(search)).toEqual({ ok: true })
    bots.narrowGrant('site-editor', (held) => ({ ...held, tools: held.tools.filter((tool) => tool !== 'search') }))
    expect(prepared.authority.check(read)).toEqual({ ok: true })
    expect(prepared.authority.check(search)).toEqual({ ok: false, refused: { text: BOT_PERMISSION_REMOVED_TEXT, askId: '' } })
    expect(bots.getActivation(activation.id).status).toBe('running')
    expect(store.openAsks('site-editor')).toEqual([])
  })

  it('a narrower published revision is what runs: tools and limits', async () => {
    publish({ tools: ['read'], budget: { maxTurns: 5 } })
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'narrow' })
    expect(store.counters(activation.id).limits).toEqual({ maxTurns: 5 })
    const prepared = bots.prepare(turnStart(store.dispatch(activation.id, 1)!.runId!))
    if ('refused' in prepared) throw new Error(prepared.refused)
    // The memory tools and the listing of the owner's MCP servers are every bot's, beside its grant (Bot Phase 1 §5.10);
    // a run also splits its job among subagents, on models from model_list, and reads the rest of its tools from its catalogue.
    expect(prepared.policy).toMatchObject({ tools: { allow: ['escalate', ...BOT_MEMORY_TOOLS, ...BOT_ITEM_TOOLS, ...BOT_TASK_TOOLS, 'mcp_servers', 'publish_applet', 'read', 'report_bug', 'running_list', 'show_card', ...BOT_SUBAGENT_TOOLS, 'tool_catalogue', 'model_list', 'remind', 'watch_start', ...EVERY_BOT_WORK].sort() }, budget: { maxTurns: 5, maxWallMs: BOT_TURN_WINDOW_MS } })
    expect(store.counters(activation.id).activeMs).toBe(BOT_TURN_WINDOW_MS)
    // An ungranted tool in a run is refused and asked for once (Bot Phase 1 §5.4); the run goes on.
    expect(prepared.authority.check({ kind: 'builtin', tool: 'search', nativeName: 'grep', args: { path: root } })).toMatchObject({ ok: false, refused: { askId: expect.stringMatching(/^esc_/) } })
    // The tool the revision keeps still works in its files folder.
    expect(prepared.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: join(root, 'a.md') } })).toEqual({ ok: true })
    expect(bots.getActivation(activation.id).status).toBe('running')
  })

  it('the end of its window ends the turn with no ask and no failure; later calls are refused', async () => {
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'c1' })
    const prepared = bots.prepare(turnStart(store.dispatch(activation.id, 1)!.runId!))
    if ('refused' in prepared) throw new Error(prepared.refused)
    // Its window, and the look every live dispatch gets (`BOT_OFFLINE_WATCH_MS`).
    expect(timers.map((timer) => timer.ms)).toEqual([BOT_TURN_WINDOW_MS, BOT_OFFLINE_WATCH_MS])
    expect(prepared.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: join(root, 'a.md') } })).toEqual({ ok: true })
    timers[0].fn()
    await new Promise((resolve) => setImmediate(resolve))
    expect(prepared.authority.time.signal.aborted).toBe(true)
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'running' })
    expect(store.openAsks('site-editor')).toEqual([])
    expect(store.registry('site-editor')?.failureStreak ?? 0).toBe(0)
    expect(prepared.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: join(root, 'a.md') } })).toEqual({ ok: false, wall: { kind: 'ended' } })
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
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'done', counters: { activeMs: BOT_TURN_WINDOW_MS } })
  })

  it('refuses a dispatch the runtime cannot hold now, before any time is charged', async () => {
    const activation = await bots.activate({ botId: 'site-editor', input: 'go', clientRequestId: 'c1' })
    check = () => ({ ok: false, error: { code: 'policy_unenforceable', message: 'no', missing: ['budgets'], reason: 'This provider cannot count requests.' } })
    expect(bots.prepare(turnStart(store.dispatch(activation.id, 1)!.runId!))).toMatchObject({ code: 'policy_unenforceable' })
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'failed', counters: { activeMs: 0 } })
  })

  it('runs of a bot run at once, with no count; one ending leaves the others running', async () => {
    const first = await bots.activate({ botId: 'site-editor', input: 'one', clientRequestId: 'c1' })
    const others = []
    for (const id of ['c2', 'c3', 'c4', 'c5']) others.push(await bots.activate({ botId: 'site-editor', input: id, clientRequestId: id }))
    for (const other of others) expect(other).toMatchObject({ status: 'running', threadId: expect.any(String) })
    const payload = turnStart(store.dispatch(first.id, 1)!.runId!)
    bots.prepare(payload)
    finish(payload.runId, 'failed')
    bots.settle(payload, {})
    expect(bots.getActivation(first.id)).toMatchObject({ status: 'failed', endReason: 'failed' })
    for (const other of others) expect(bots.getActivation(other.id).status).toBe('running')
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
    // Nothing starts while the bot's journal cannot be written, so the second waits.
    store.setError('site-editor', { code: 'bot_journal_failed', error: BOT_JOURNAL_ERROR })
    const second = await bots.activate({ botId: 'site-editor', input: 'two', clientRequestId: 'c4' })
    expect(second.status).toBe('queued')
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

  it('past the waiting ceiling only the newest run is refused; what waits is kept and running ones are not counted', async () => {
    // Only a runaway reaches the ceiling (`MAX_QUEUED_ACTIVATIONS`); three stands in for it.
    engineHost.maxQueuedActivations = 3
    const running = await bots.activate({ botId: 'site-editor', input: 'running', clientRequestId: 'run' })
    // Nothing starts while the bot's journal cannot be written, so the rest wait.
    store.setError('site-editor', { code: 'bot_journal_failed', error: BOT_JOURNAL_ERROR })
    const waiting = []
    for (let index = 0; index < 4; index += 1) {
      clock += 1
      waiting.push(await bots.activate({ botId: 'site-editor', input: `q${index}`, clientRequestId: `q${index}` }))
    }
    expect(bots.getActivation(running.id).status).toBe('running')
    expect(waiting.map((row) => bots.getActivation(row.id).status)).toEqual(['queued', 'queued', 'queued', 'cancelled'])
    expect(bots.getActivation(waiting[3].id)).toMatchObject({ endReason: 'queue_full' })
  })

  it('deleting the bot cancels its activations, revokes its grant and archives its threads (Bot Phase 1 §5.3.3)', async () => {
    const running = await bots.activate({ botId: 'site-editor', input: 'one', clientRequestId: 'c1' })
    const archived: string[] = []
    const trashed: string[] = []
    engineHost.archiveThread = (threadId) => { archived.push(threadId) }
    engineHost.trashThread = async (threadId) => { trashed.push(threadId) }
    // Its run ends when its thread is stopped; only then are its threads archived.
    engineHost.stopThread = (threadId) => {
      stopped.push(threadId)
      runs.markTerminal(store.dispatch(running.id, 1)!.runId!, 'cancelled', { error: 'stopped' })
    }
    const { purgeAt } = await bots.remove('site-editor')
    expect(Date.parse(purgeAt)).toBe(clock + 30 * 24 * 60 * 60_000)
    expect(archived.sort()).toEqual([running.threadId, 'thread:bot:site-editor'].sort())
    expect(trashed).toEqual([])
    expect(bots.getActivation(running.id)).toMatchObject({ status: 'cancelled', endReason: 'bot_deleted' })
    expect(store.activeGrant('site-editor')).toBeUndefined()
    expect(bots.list()).toEqual([])
  })
})

describe('activation requests', () => {
  it('two deliveries of one request at the same time give one activation, and no error', async () => {
    publish()
    approve()
    const input = { botId: 'site-editor', input: 'Fix it', clientRequestId: 'c2' }
    // The second delivery reads no activation yet, then finds the first one's at its insert.
    const byKey = store.activationByKey.bind(store)
    let reads = 0
    vi.spyOn(store, 'activationByKey').mockImplementation((key) => (++reads === 1 ? undefined : byKey(key)))
    const [a, b] = await Promise.all([bots.activate(input), bots.activate(input)])
    expect(a.id).toBe(b.id)
    expect(store.listActivations('site-editor')).toHaveLength(1)
  })
})
