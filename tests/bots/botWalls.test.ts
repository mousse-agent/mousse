/**
 * PR 6 §5 and §5a, unit 6c-2: walls end the dispatch and ask the owner; answers continue it
 * behind the unknown-call gate; consults run one at a time per context thread; the startup pass
 * settles what a crash left; trashing a bot's thread ends its activation.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotEngine, type BotEngineHost } from '../../src/mms/bots/activation/BotEngine'
import { isBotWallAbort } from '../../src/mms/bots/activation/dispatcher'
import { BotDefinitionStore } from '../../src/mms/bots/definitions/BotDefinitionStore'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { botManifestDigest, compileBotThread } from '../../src/mms/bots/grants/compile'
import { BotStore } from '../../src/mms/bots/store/BotStore'
import { PI_NATIVE_TOOLS } from '../../src/mms/harness/pi/nativeTools'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectOutbox } from '../../src/mms/run/EffectOutbox'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { ToolInvocations } from '../../src/mms/run/ToolInvocations'
import { isIdempotentTool } from '../../src/mms/run/tools/idempotency'
import { isBotTurnPayload, type BotTurnPayload, type RunOutcome } from '../../src/mms/run/types'
import { foldersOf, type BotDefinition, type BotManifest } from '../../src/shared/bots/personal/definition'
import { permissionText, withPermission, type BotEscalationSummary } from '../../src/shared/bots/personal/escalation'
import { addedPermissions } from '../../src/shared/bots/personal/manifest'

let base: string
let profile: string
let root: string
let other: string
let clock: number
let store: BotStore
let runDb: ProfileDatabase
let runs: RunEngine
let outbox: EffectOutbox
let bots: BotEngine
let stopped: string[]
let trashed: string[]
let threadStates: Map<string, 'active' | 'trashed' | 'missing'>
let timers: Array<{ fn: () => void; ms: number; cleared: boolean }>
let host: BotEngineHost
let escalations: BotEscalationSummary[]

const T0 = Date.parse('2026-10-27T09:00:00.000Z')
const tick = () => new Promise((resolve) => setImmediate(resolve))

const manifest = (patch: Partial<BotManifest> = {}): BotManifest => ({
  tools: ['read', 'edit'],
  appTools: [],
  mcp: [],
  skills: [],
  // Read access: a write root inside the system temporary folder is refused, and these tests write their ledger rows directly.
  workspace: { roots: [root], access: 'read' },
  budget: { maxActiveMs: 10 * 60_000 },
  audience: 'owner',
  ...patch
})

const definition = (patch: Partial<BotDefinition> = {}): BotDefinition => ({
  id: 'site-editor',
  name: 'Site editor',
  role: 'You keep the site tidy.',
  main: { key: 'main', title: 'Main', agent: { instructions: 'Answer briefly.' }, selection: { instanceId: 'pi:openrouter', model: 'some/model' } },
  context: [{ key: 'docs', title: 'Docs expert', agent: { instructions: 'You know the docs.' }, selection: { instanceId: 'pi:openrouter', model: 'some/model' }, narrow: { tools: ['read'] } }],
  permissions: manifest(),
  triggers: { manual: true },
  ...patch
})

function makeEngine(): BotEngine {
  const engine = new BotEngine(host)
  engine.events.on('escalation', (summary: BotEscalationSummary) => escalations.push(summary))
  return engine
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-walls-')))
  profile = join(base, 'profile')
  root = join(base, 'site')
  other = join(base, 'other')
  for (const dir of [profile, root, other]) mkdirSync(dir, { recursive: true })
  clock = T0
  store = new BotStore({ profileHome: profile, clock: () => clock })
  runDb = new ProfileDatabase({ profileHome: profile, clock: () => clock })
  const runStore = new RunStore(runDb)
  const now = () => new Date(clock).toISOString()
  outbox = new EffectOutbox(runStore, { now })
  runs = new RunEngine({ store: runStore, outbox, tools: new ToolInvocations(runStore), now, pid: 1 })
  stopped = []
  trashed = []
  timers = []
  escalations = []
  threadStates = new Map()
  host = {
    profileHome: profile,
    store,
    definitions: new BotDefinitionStore(store.directory, (botId) => store.registry(botId)?.revision ?? null),
    threads: {
      ensureExecutionThread: (key) => ({ id: `thread:${key}` }),
      threadState: (threadId) => threadStates.get(threadId) ?? 'active'
    },
    trashThread: async (threadId) => {
      trashed.push(threadId)
      threadStates.set(threadId, 'trashed')
    },
    runs: () => runs,
    harness: {
      checkPolicy: () => ({ ok: true }),
      nativeToolNames: (_instanceId, tools) => ({ ok: true, names: tools.flatMap((tool) => [...(PI_NATIVE_TOOLS[tool] ?? [])]) })
    },
    notifyEffects: () => {},
    stopThread: (threadId) => { stopped.push(threadId) },
    clock: () => clock,
    monotonic: () => clock,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return { clear: () => { timer.cleared = true } }
    }
  }
  bots = makeEngine()
  const saved = bots.save(definition())
  bots.publish('site-editor', saved.draftHash)
  bots.approve('site-editor', botManifestDigest(bots.get('site-editor').published!.permissions))
})

afterEach(() => {
  bots.close()
  store.close()
  runDb.close()
  rmSync(base, { recursive: true, force: true })
})

const payloadOf = (runId: string): BotTurnPayload => {
  const effect = outbox.listForRun(runId).filter((entry) => entry.kind === 'turn.start').at(-1)!
  if (!isBotTurnPayload(effect.payload)) throw new Error('not a bot payload')
  return effect.payload
}

const start = (runId: string) => {
  runs.markStarting(runId)
  runs.markRunning(runId)
  return runs.getRun(runId)!.activeAttemptId!
}

const end = (runId: string, status: 'completed' | 'failed' | 'interrupted' | 'uncertain', outcome?: RunOutcome) => runs.markTerminal(runId, status, outcome)

async function running(input = 'Fix the footer', id = 'c1') {
  const activation = await bots.activate({ botId: 'site-editor', input, clientRequestId: id })
  const payload = payloadOf(store.dispatch(activation.id, 1)!.runId!)
  const prepared = bots.prepare(payload)
  if ('refused' in prepared) throw new Error(prepared.refused)
  start(payload.runId)
  return { activation, payload, prepared }
}

/** The walled run ends as the executor ends it, and is settled. */
async function endAtWall(payload: BotTurnPayload) {
  end(payload.runId, 'interrupted', { interruptedBy: 'bot_wall' })
  bots.settle(payload, {})
  await tick()
}

describe('walls', () => {
  it('a gate refusal is a wall: the owner is asked, the dispatch ends, and nothing more runs', async () => {
    const { activation, prepared } = await running()
    const wall = prepared.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: join(other, 'a.md') } })
    expect(wall).toEqual({ ok: false, wall: { kind: 'escalated', permission: `Read files in ${join(other, 'a.md')}` } })
    expect(isBotWallAbort(prepared.authority.time.signal.reason)).toBe(true)
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'waiting_grant', openEscalation: { kind: 'gate', status: 'open', permission: { path: join(other, 'a.md'), access: 'read' } } })
    expect(escalations).toHaveLength(1)
    // Every later call waits, and asks nobody again.
    expect(prepared.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: join(root, 'a.md') } })).toEqual({ ok: false, wall: { kind: 'waiting' } })
    expect(store.escalations({ activationId: activation.id })).toHaveLength(1)
    // The expiry is armed: 30 minutes.
    expect(timers.at(-1)!.ms).toBe(30 * 60_000)
  })

  it('escalate asks for a structured permission; a malformed one is refused without a wall', async () => {
    const { activation, prepared } = await running()
    expect(prepared.authority.escalate!({ permission: { shell: true }, reason: 'x' })).toContain('not one a bot can ask for')
    expect(bots.getActivation(activation.id).status).toBe('running')
    expect(prepared.authority.escalate!({ permission: { tool: 'web_fetch' }, reason: 'I need the changelog.', toolCallId: 'call-1' })).toBe('Paused: waiting for the owner to allow: Use the tool `web_fetch`. End your turn now.')
    expect(store.escalations({ activationId: activation.id })[0]).toMatchObject({ kind: 'escalate', toolCallId: 'call-1', reason: 'I need the changelog.' })
  })

  it('the sixth wall of an activation ends it blocked', async () => {
    const { activation } = await running()
    for (let index = 0; index < 5; index += 1) {
      store.insertEscalation({ id: `esc_${index}`, activationId: activation.id, dispatchN: 1, toolCallId: null, kind: 'gate', permission: { tool: 'write' }, reason: 'r', createdAt: 'x', expiresAt: 'y' })
      store.answerEscalation(`esc_${index}`, 'denied')
    }
    expect(bots.raiseWall(activation.id, { dispatchN: 1, kind: 'gate', permission: { tool: 'write' }, reason: 'again' })).toEqual({ kind: 'ended' })
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'blocked', endReason: 'asked_too_often' })
  })

  it('an unanswered wall expires and ends the activation blocked; nothing is auto-approved', async () => {
    const { activation, prepared, payload } = await running()
    prepared.authority.escalate!({ permission: { tool: 'web_fetch' }, reason: 'r' })
    await endAtWall(payload)
    timers.at(-1)!.fn()
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'blocked', endReason: 'escalation_expired' })
    const [escalation] = bots.listEscalations(activation.id)
    expect(escalation.status).toBe('expired')
    await expect(bots.respond({ escalationId: escalation.id, answer: 'allow_once' })).rejects.toMatchObject({ code: 'escalation_answered' })
    expect(store.dispatches(activation.id)).toHaveLength(1)
  })
})

describe('answers and continuations', () => {
  it('"Allow this time" continues the walled run with the permission for this activation only', async () => {
    const { activation, prepared, payload } = await running()
    prepared.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: other } })
    await endAtWall(payload)
    expect(runs.getRun(payload.runId)!.outcome).toMatchObject({ interruptedBy: 'bot_wall' })
    const [escalation] = bots.listEscalations(activation.id)
    const answered = await bots.respond({ escalationId: escalation.id, answer: 'allow_once' })
    expect(answered).toMatchObject({ escalation: { status: 'allowed_once' }, activation: { status: 'running' } })
    const next = store.dispatch(activation.id, 2)!
    expect(next).toMatchObject({ kind: 'continue', clientRequestId: `${activation.id}:d2` })
    expect(next.prompt.text).toContain(`The owner allowed: Read files in ${other}`)
    expect(runs.getRun(next.runId!)!.outcome?.continuationOf).toBe(payload.runId)
    const again = bots.prepare(payloadOf(next.runId!))
    if ('refused' in again) throw new Error(again.refused)
    expect(again.history).toBe('thread')
    expect(again.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: other } })).toEqual({ ok: true })
    // The grant itself is unchanged: a later activation does not get it.
    expect(store.activeGrant('site-editor')!.manifest.workspace!.roots).toEqual([root])
  })

  it('"Allow for this bot" publishes and approves a wider revision in one action', async () => {
    const { activation, prepared, payload } = await running()
    prepared.authority.escalate!({ permission: { tool: 'web_fetch' }, reason: 'docs' })
    await endAtWall(payload)
    await bots.respond({ escalationId: bots.listEscalations(activation.id)[0].id, answer: 'allow_bot' })
    const grant = store.activeGrant('site-editor')!
    expect(grant.manifest.tools).toContain('web_fetch')
    expect(bots.get('site-editor').published!.permissions.tools).toContain('web_fetch')
    expect(store.activation(activation.id)!.grantDigest).toBe(grant.digest)
    const next = bots.prepare(payloadOf(store.dispatch(activation.id, 2)!.runId!))
    if ('refused' in next) throw new Error(next.refused)
    expect(next.authority.check({ kind: 'builtin', tool: 'web_fetch', nativeName: 'web_fetch', args: {} })).toEqual({ ok: true })
  })

  it('"Deny" is recorded and the bot continues without it', async () => {
    const { activation, prepared, payload } = await running()
    prepared.authority.escalate!({ permission: { tool: 'web_fetch' }, reason: 'docs' })
    await endAtWall(payload)
    await bots.respond({ escalationId: bots.listEscalations(activation.id)[0].id, answer: 'deny' })
    expect(store.dispatch(activation.id, 2)!.prompt.text).toContain('The owner denied: Use the tool `web_fetch`')
    expect(store.overlays(activation.id)).toEqual([])
  })

  it('a budget wall is answered with more time for this activation', async () => {
    const { activation, payload } = await running()
    timers[0].fn()
    clock += 10 * 60_000
    await endAtWall(payload)
    await expect(bots.respond({ escalationId: bots.listEscalations(activation.id)[0].id, answer: 'allow_once' })).rejects.toMatchObject({ code: 'invalid_answer' })
    await bots.respond({ escalationId: bots.listEscalations(activation.id)[0].id, answer: 'allow_more', amount: 5 * 60_000 })
    const next = bots.prepare(payloadOf(store.dispatch(activation.id, 2)!.runId!))
    if ('refused' in next) throw new Error(next.refused)
    expect(next.policy.budget).toMatchObject({ maxWallMs: 5 * 60_000 })
  })

  it('an answer waits for the walled run to end before anything is sent', async () => {
    const { activation, prepared, payload } = await running()
    prepared.authority.escalate!({ permission: { tool: 'web_fetch' }, reason: 'docs' })
    await bots.respond({ escalationId: bots.listEscalations(activation.id)[0].id, answer: 'allow_once' })
    expect(store.dispatches(activation.id)).toHaveLength(1)
    await endAtWall(payload)
    expect(store.dispatches(activation.id)).toHaveLength(2)
  })

  it('a consult\'s Edit cut off by the wall pauses the activation; only the acknowledged Continue sends, and it lists the call', async () => {
    const { activation, prepared, payload } = await running()
    const asked = prepared.authority.consult!({ context: 'docs', question: 'What changed?' })
    await tick()
    const consult = store.dispatches(activation.id).find((dispatch) => dispatch.kind === 'consult')!
    expect(consult).toMatchObject({ mainN: 1, clientRequestId: `${activation.id}:c${consult.n}` })
    const attempt = start(consult.runId!)
    runs.tools.start({ invocationId: 'consult-edit', runId: consult.runId!, attemptId: attempt, tool: 'edit', argsDigest: 'd', now: 'n', idempotent: false })
    prepared.authority.escalate!({ permission: { tool: 'web_fetch' }, reason: 'docs' })
    expect(await asked).toContain('Paused: waiting for the owner')
    // Ending the main dispatch stops its consult.
    await endAtWall(payload)
    expect(stopped).toContain(consult.threadId)
    end(consult.runId!, 'interrupted', { interruptedBy: 'user' })
    bots.settleRun(consult.runId!)
    await tick()
    // Allow this time leaves it paused with the call, and sends nothing.
    await bots.respond({ escalationId: bots.listEscalations(activation.id)[0].id, answer: 'allow_once' })
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'paused', endReason: 'unknown_calls', unknownCalls: [{ invocationId: 'consult-edit', role: 'consult', acknowledged: false }] })
    expect(store.dispatches(activation.id).filter((dispatch) => dispatch.kind === 'continue')).toEqual([])
    await expect(bots.continueActivation(activation.id)).rejects.toMatchObject({ code: 'unknown_calls_not_acknowledged' })
    // Only the exact set shown is acknowledged: a different set is refused and nothing is sent.
    await expect(bots.continueActivation(activation.id, { acknowledge: { calls: ['something-else'] } })).rejects.toMatchObject({ code: 'unknown_calls_changed' })
    expect(store.unknownCalls(activation.id)[0].acknowledged).toBe(false)
    await bots.continueActivation(activation.id, { acknowledge: { calls: ['consult-edit'] } })
    const next = store.dispatches(activation.id).find((dispatch) => dispatch.kind === 'continue')!
    expect(next.prompt.text).toContain('The owner allowed: Use the tool `web_fetch`')
    expect(next.prompt.text).toContain('edit (consult run')
    expect(bots.getActivation(activation.id).status).toBe('running')
  })

  it('an uncertain main run pauses; Continue without the acknowledgement is refused, with it a continuation starts', async () => {
    const { activation, payload } = await running()
    end(payload.runId, 'uncertain', { uncertainReason: 'non_idempotent_tool_in_flight' })
    bots.settle(payload, {})
    await tick()
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'paused', endReason: 'uncertain', uncertain: true, uncertainRunId: payload.runId, canContinue: true })
    await expect(bots.continueActivation(activation.id)).rejects.toMatchObject({ code: 'uncertain_not_acknowledged' })
    await expect(bots.continueActivation(activation.id, { acknowledge: { calls: [] } })).rejects.toMatchObject({ code: 'unknown_calls_changed' })
    await bots.continueActivation(activation.id, { acknowledge: { calls: [], uncertainRunId: payload.runId } })
    const next = store.dispatch(activation.id, 2)!
    expect(runs.getRun(next.runId!)).toMatchObject({ status: 'queued' })
  })

  it('"Mark done" keeps the draft result of a completed run once its calls are checked', async () => {
    const { activation, payload } = await running()
    runs.tools.start({ invocationId: 'inv-edit', runId: payload.runId, attemptId: runs.getRun(payload.runId)!.activeAttemptId!, tool: 'edit', argsDigest: 'd', now: 'n', idempotent: false })
    end(payload.runId, 'completed')
    bots.settle(payload, { text: 'Footer fixed.' })
    await tick()
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'paused', result: 'Footer fixed.', canMarkDone: true })
    expect(() => bots.markDone(activation.id)).toThrow(expect.objectContaining({ code: 'unknown_calls_not_acknowledged' }))
    expect(bots.markDone(activation.id, { acknowledge: { calls: ['inv-edit'] } })).toMatchObject({ status: 'done', result: 'Footer fixed.' })
  })
})

describe('consults', () => {
  it('a consult runs on the context thread under the main dispatch\'s scopes and returns its answer', async () => {
    const { activation, prepared } = await running()
    expect(prepared.policy.tools?.allow).toEqual(expect.arrayContaining(['consult', 'escalate']))
    const asked = prepared.authority.consult!({ context: 'docs', question: 'What changed?' })
    await tick()
    const consult = store.dispatches(activation.id).find((dispatch) => dispatch.kind === 'consult')!
    expect(consult.threadId).toBe('thread:bot:site-editor:ctx:docs:1')
    expect(bots.roleOf(consult.threadId)).toBe('context')
    const payload = payloadOf(consult.runId!)
    const context = bots.prepare(payload)
    if ('refused' in context) throw new Error(context.refused)
    expect(context).toMatchObject({ history: 'thread', authority: { role: 'context' } })
    // Depth is 1: no consult from a context thread; it narrows to read.
    expect(context.authority.consult).toBeUndefined()
    expect(context.policy.tools?.allow).toEqual(['escalate', 'read'])
    expect(context.authority.counters).toBe(prepared.authority.counters)
    expect(context.authority.time.signal).toBe(prepared.authority.time.signal)
    start(payload.runId)
    end(payload.runId, 'completed')
    bots.settleRun(payload.runId)
    bots.settle(payload, { text: 'Only the footer.' })
    await expect(asked).resolves.toBe('Only the footer.')
    // A consult charges no time of its own.
    expect(store.dispatch(activation.id, consult.n)).toMatchObject({ deadlineMs: null, prepaidMs: null })
  })

  it('two consults of one context thread run one after the other; a waiting one sends nothing when the dispatch ends', async () => {
    const { activation, prepared, payload } = await running()
    const first = prepared.authority.consult!({ context: 'docs', question: 'one' })
    const second = prepared.authority.consult!({ context: 'docs', question: 'two' })
    await tick()
    await tick()
    const consults = () => store.dispatches(activation.id).filter((dispatch) => dispatch.kind === 'consult')
    expect(consults()).toHaveLength(1)
    const firstPayload = payloadOf(consults()[0].runId!)
    bots.prepare(firstPayload)
    start(firstPayload.runId)
    end(firstPayload.runId, 'completed')
    bots.settle(firstPayload, { text: 'A1' })
    await expect(first).resolves.toBe('A1')
    await tick()
    await tick()
    expect(consults()).toHaveLength(2)
    // A third waits behind the second; the main dispatch ends meanwhile.
    const third = prepared.authority.consult!({ context: 'docs', question: 'three' })
    end(payload.runId, 'completed')
    bots.settle(payload, { text: 'done' })
    await expect(third).resolves.toContain('ended')
    await second
    expect(consults()).toHaveLength(2)
  })

  it('a new consult is refused while earlier tool calls need checking', async () => {
    const { activation, prepared } = await running()
    const asked = prepared.authority.consult!({ context: 'docs', question: 'one' })
    await tick()
    const consult = store.dispatches(activation.id).find((dispatch) => dispatch.kind === 'consult')!
    const consultPayload = payloadOf(consult.runId!)
    bots.prepare(consultPayload)
    const attempt = start(consult.runId!)
    runs.tools.start({ invocationId: 'c-edit', runId: consult.runId!, attemptId: attempt, tool: 'edit', argsDigest: 'd', now: 'n', idempotent: false })
    end(consult.runId!, 'failed')
    bots.settle(consultPayload, {})
    await asked
    expect(await prepared.authority.consult!({ context: 'docs', question: 'two' })).toContain('earlier tool calls need checking')
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'paused', endReason: 'unknown_calls' })
  })

  it('consult and escalate are idempotent ledger names', () => {
    expect(isIdempotentTool('consult')).toBe(true)
    expect(isIdempotentTool('escalate')).toBe(true)
  })
})

describe('startup pass', () => {
  function supervised(activationId: string, n: number) {
    const dispatch = store.dispatch(activationId, n)!
    store.run('UPDATE bot_dispatches SET prepaid_ms = 15000, exit_at = ? WHERE activation_id = ? AND n = ?', clock, activationId, n)
    store.run('UPDATE bot_counters SET active_ms = active_ms - ? + 15000 WHERE activation_id = ?', dispatch.prepaidMs!, activationId)
  }

  async function crash() {
    bots.close()
    bots = makeEngine()
    await bots.reconcileOnStartup()
  }

  it('settles an open main dispatch at its full allowance without exit evidence, and keeps open reservations charged', async () => {
    const { activation, payload } = await running()
    store.run("INSERT INTO bot_spend_reservations(id, activation_id, run_id, input_bound, wire_cap, usd_micros, cost_limited, created_at) VALUES('r1', ?, ?, 100, 50, 7, 0, 'x')", activation.id, payload.runId)
    clock += 30_000
    end(payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    await crash()
    expect(store.dispatch(activation.id, 1)).toMatchObject({ settledBy: 'startup', usedMs: 10 * 60_000 })
    expect(store.get('SELECT committed_input, committed_output FROM bot_spend WHERE activation_id = ?', activation.id)).toEqual({ committed_input: 100, committed_output: 50 })
    // Row 10: no work time left, so a budget wall that says why, never an automatic restart.
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'waiting_grant', openEscalation: { kind: 'budget', reason: expect.stringContaining('Mousse stopped unexpectedly') } })
  })

  it('an interrupted run with time left continues once automatically; a second crash pauses it', async () => {
    const { activation, payload } = await running()
    clock += 30_000
    end(payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    // A supervisor that prepays in 15-second chunks, and confirmed the processes gone before the
    // crash: the measured window is charged (this build prepays the whole allowance instead).
    supervised(activation.id, 1)
    await crash()
    expect(store.counters(activation.id).activeMs).toBe(30_000)
    const next = store.dispatch(activation.id, 2)!
    expect(next.prompt.text).toContain('Mousse restarted')
    expect(store.activation(activation.id)!.autoRestarts).toBe(1)
    const again = payloadOf(next.runId!)
    bots.prepare(again)
    start(again.runId)
    clock += 30_000
    end(again.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    supervised(activation.id, 2)
    await crash()
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'paused', endReason: 'restarted_twice' })
  })

  it('a wall cut by a crash before the run interrupt keeps waiting and is never continued', async () => {
    const { activation, prepared, payload } = await running()
    prepared.authority.escalate!({ permission: { tool: 'web_fetch' }, reason: 'docs' })
    end(payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    await crash()
    expect(bots.getActivation(activation.id).status).toBe('waiting_grant')
    expect(store.dispatches(activation.id)).toHaveLength(1)
  })

  it('a crashed Edit is collected before and after reconciler rule 6, with the same pause', async () => {
    for (const ruleSix of [false, true]) {
      const { activation, payload } = await running('go', `c-${ruleSix}`)
      runs.tools.start({ invocationId: `edit-${ruleSix}`, runId: payload.runId, attemptId: runs.getRun(payload.runId)!.activeAttemptId!, tool: 'edit', argsDigest: 'd', now: 'n', idempotent: false })
      end(payload.runId, 'uncertain', { uncertainReason: 'non_idempotent_tool_in_flight' })
      if (ruleSix) runDb.statement("UPDATE tool_invocations SET status = 'outcome_unknown' WHERE invocation_id = ?").run(`edit-${ruleSix}`)
      await crash()
      expect(bots.getActivation(activation.id)).toMatchObject({ status: 'paused', endReason: 'unknown_calls', unknownCalls: [{ invocationId: `edit-${ruleSix}` }] })
      await bots.stop(activation.id)
    }
  })

  it('a dispatch whose run was never written is sent again with the same request id', async () => {
    const { activation, payload } = await running()
    end(payload.runId, 'completed')
    bots.settle(payload, { text: 'ok' })
    await tick()
    // A second activation whose dispatch intent was written, then the process died.
    const second = await bots.activate({ botId: 'site-editor', input: 'two', clientRequestId: 'c2' })
    expect(second.status).toBe('running')
    const dispatch = store.dispatch(second.id, 1)!
    runDb.statement('DELETE FROM effects WHERE run_id = ?').run(dispatch.runId!)
    runDb.statement('DELETE FROM receipts WHERE client_request_id = ?').run(dispatch.clientRequestId)
    runDb.statement('DELETE FROM runs WHERE run_id = ?').run(dispatch.runId!)
    store.run('UPDATE bot_dispatches SET run_id = NULL WHERE activation_id = ?', second.id)
    await crash()
    const resent = store.dispatch(second.id, 1)!
    expect(resent.runId).not.toBeNull()
    expect(runs.getRun(resent.runId!)).toMatchObject({ status: 'queued' })
    expect(activation.id).not.toBe(second.id)
  })

  it('a deleted bot left half-deleted is finished: its activations end and its home thread goes to the trash', async () => {
    const { activation } = await running()
    store.markDeleted('site-editor')
    await crash()
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'cancelled', endReason: 'bot_deleted' })
    expect(trashed).toEqual(['thread:bot:site-editor'])
  })

  it('a trashed context thread is forgotten; the next consult starts a new generation, and the activation still waits', async () => {
    const { activation, prepared, payload } = await running()
    const asked = prepared.authority.consult!({ context: 'docs', question: 'one' })
    await tick()
    const consult = store.dispatches(activation.id).find((dispatch) => dispatch.kind === 'consult')!
    prepared.authority.escalate!({ permission: { tool: 'web_fetch' }, reason: 'docs' })
    await asked
    end(payload.runId, 'interrupted', { interruptedBy: 'bot_wall' })
    end(consult.runId!, 'cancelled')
    threadStates.set(consult.threadId, 'trashed')
    await crash()
    expect(bots.roleOf(consult.threadId)).toBeUndefined()
    expect(store.contextGen('site-editor', 'docs')).toBe(2)
    expect(bots.getActivation(activation.id).status).toBe('waiting_grant')
  })
})

describe('trash and profile hooks', () => {
  it('trashing the activation thread while running or waiting ends it cancelled, with nothing sent later', async () => {
    const { activation, prepared } = await running()
    bots.beforeTrash([activation.threadId!])
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'cancelled', endReason: 'thread_trashed' })
    expect(stopped).toEqual([activation.threadId])
    expect(prepared.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: root } })).toEqual({ ok: false, wall: { kind: 'ended' } })

    const second = await bots.activate({ botId: 'site-editor', input: 'two', clientRequestId: 'c2' })
    const payload = payloadOf(store.dispatch(second.id, 1)!.runId!)
    const p2 = bots.prepare(payload)
    if ('refused' in p2) throw new Error(p2.refused)
    p2.authority.escalate!({ permission: { tool: 'web_fetch' }, reason: 'docs' })
    bots.afterTrash(['thread:bot:site-editor', second.threadId!])
    expect(bots.getActivation(second.id)).toMatchObject({ status: 'cancelled', endReason: 'thread_trashed' })
    expect(bots.listEscalations(second.id)[0].status).toBe('cancelled')
    await expect(bots.respond({ escalationId: bots.listEscalations(second.id)[0].id, answer: 'allow_once' })).rejects.toMatchObject({ code: 'escalation_answered' })
  })

  it('a bot whose home thread is in the trash cannot be activated', async () => {
    await running()
    threadStates.set('thread:bot:site-editor', 'trashed')
    await expect(bots.activate({ botId: 'site-editor', input: 'x', clientRequestId: 'c9' })).rejects.toMatchObject({ code: 'bot_home_trashed' })
  })

  it('profile removal lists the unfinished activations', async () => {
    await running()
    await bots.activate({ botId: 'site-editor', input: 'two', clientRequestId: 'c2' })
    expect(bots.ownedActivity()).toBe(2)
  })
})

describe('round 1: folder answers grant exactly what is shown', () => {
  const authorityFor = (granted: BotManifest) => {
    const compiled = compileBotThread({ grant: granted, digest: 'd', thread: {}, scratch: join(profile, 'bots', 'scratch', 'x'), profileHome: profile, temps: [], nativeNames: (tools) => ({ ok: true, names: [...tools] }), remaining: { deadlineMs: 60_000 } })
    if (!compiled.ok) throw new Error(compiled.error.message)
    return createBotAuthority({ activationId: 'a', role: 'activation', permissions: compiled.permissions, waiting: () => false, counters: { charge: () => ({ ok: true, count: 1 }) }, time: { deadline: () => 0, signal: new AbortController().signal }, spend: null })
  }
  const edit = (path: string) => ({ kind: 'builtin' as const, tool: 'edit' as const, nativeName: 'edit', args: { path: join(path, 'a.md') } })

  it('allowing writes to one folder leaves every other folder read-only, and the reverse', () => {
    const readOnly = manifest({ tools: ['read', 'edit'], workspace: { roots: [root], access: 'read' } })
    const wider = withPermission(readOnly, { path: other, access: 'write' })
    expect(foldersOf(wider.workspace)).toEqual([[other, 'write'], [root, 'read']].sort())
    expect(addedPermissions(wider, readOnly).map((line) => line.text)).toEqual([permissionText({ path: other, access: 'write' })])
    const authority = authorityFor(wider)
    expect(authority.check(edit(root))).toMatchObject({ ok: false, wall: { kind: 'path', access: 'write' } })
    expect(authority.check(edit(other))).toEqual({ ok: true })

    const writable = manifest({ tools: ['read', 'edit'], workspace: { roots: [root], access: 'write' } })
    const plusRead = withPermission(writable, { path: other, access: 'read' })
    expect(addedPermissions(plusRead, writable).map((line) => line.text)).toEqual([`Read files in ${other}`])
    const second = authorityFor(plusRead)
    expect(second.check(edit(other))).toMatchObject({ ok: false, wall: { kind: 'path' } })
    expect(second.check(edit(root))).toEqual({ ok: true })
  })

  it('a native name that stands for several tools walls only when all are refused, and once', async () => {
    const { activation, prepared } = await running()
    const call = (tool: 'edit' | 'read') => ({ kind: 'builtin' as const, tool, nativeName: 'Glob', args: { path: join(root, 'a.md') } })
    // `edit` in a read-only root is refused, `read` passes: allowed, nobody asked.
    expect(prepared.authority.checkAny!([call('edit'), call('read')])).toEqual({ ok: true })
    expect(store.escalations({ activationId: activation.id })).toEqual([])
    const outside = (tool: 'edit' | 'read') => ({ kind: 'builtin' as const, tool, nativeName: 'Glob', args: { path: join(other, 'a.md') } })
    expect(prepared.authority.checkAny!([outside('edit'), outside('read')])).toMatchObject({ ok: false, wall: { kind: 'escalated' } })
    expect(store.escalations({ activationId: activation.id })).toHaveLength(1)
  })

  it('a relative folder is never asked for or resolved against the working directory', async () => {
    const { activation, prepared } = await running()
    expect(prepared.authority.escalate!({ permission: { path: 'docs', access: 'read' }, reason: 'r' })).toContain('full path')
    // A relative path outside the scratch folder is refused without asking anybody.
    expect(prepared.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: '../../outside.md' } })).toMatchObject({ ok: false, wall: { kind: 'path', path: '../../outside.md' } })
    expect(store.escalations({ activationId: activation.id })).toEqual([])
    expect(bots.getActivation(activation.id).status).toBe('running')
  })
})

describe('round 1: startup recovery', () => {
  async function crash() {
    bots.close()
    bots = makeEngine()
    await bots.reconcileOnStartup()
  }

  /** The run DB lost what `sendWithStart` wrote for a dispatch (a crash before the send). */
  function unsend(activationId: string, n: number) {
    const dispatch = store.dispatch(activationId, n)!
    runDb.statement('DELETE FROM effects WHERE run_id = ?').run(dispatch.runId!)
    runDb.statement('DELETE FROM receipts WHERE client_request_id = ?').run(dispatch.clientRequestId)
    runDb.statement('DELETE FROM runs WHERE run_id = ?').run(dispatch.runId!)
    store.run('UPDATE bot_dispatches SET run_id = NULL WHERE activation_id = ? AND n = ?', activationId, n)
  }

  it('an answer given before a crash is applied at startup, once', async () => {
    const { activation, prepared, payload } = await running()
    prepared.authority.escalate!({ permission: { tool: 'web_fetch' }, reason: 'docs' })
    await bots.respond({ escalationId: bots.listEscalations(activation.id)[0].id, answer: 'allow_once' })
    // The walled run never reported its end: boot ended it. Its processes were confirmed gone, so
    // only the window is charged (a supervisor's 15-second prepay; this build prepays everything).
    end(payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    store.run('UPDATE bot_dispatches SET prepaid_ms = 15000, exit_at = ? WHERE activation_id = ? AND n = 1', clock, activation.id)
    store.run('UPDATE bot_counters SET active_ms = 15000 WHERE activation_id = ?', activation.id)
    await crash()
    expect(store.dispatches(activation.id).map((dispatch) => dispatch.kind)).toEqual(['start', 'continue'])
    expect(store.dispatch(activation.id, 2)!.prompt.text).toContain('The owner allowed: Use the tool `web_fetch`')
    expect(bots.getActivation(activation.id).status).toBe('running')
    await crash()
    expect(store.dispatches(activation.id)).toHaveLength(2)
  })

  it('a wait with neither an open wall nor an answer is handed to the owner', async () => {
    const { activation, prepared, payload } = await running()
    prepared.authority.escalate!({ permission: { tool: 'web_fetch' }, reason: 'docs' })
    store.run("UPDATE bot_escalations SET status = 'cancelled' WHERE activation_id = ?", activation.id)
    end(payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    await crash()
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'paused', endReason: 'wall_lost', canContinue: true })
  })

  it('an activation claimed from the queue before its first dispatch was written starts at startup', async () => {
    const first = await bots.activate({ botId: 'site-editor', input: 'one', clientRequestId: 'c1' })
    const second = await bots.activate({ botId: 'site-editor', input: 'two', clientRequestId: 'c2' })
    // The first ended; the pump claimed the second, then the process died.
    store.moveActivation(first.id, ['running'], 'cancelled', { endReason: 'stopped' })
    store.moveActivation(second.id, ['queued'], 'running')
    await crash()
    const dispatch = store.dispatch(second.id, 1)!
    expect(dispatch).toMatchObject({ kind: 'start', clientRequestId: `${second.id}:d1` })
    expect(runs.getRun(dispatch.runId!)).toMatchObject({ status: 'queued' })
  })

  it('a continuation the owner acknowledged is resent with that acknowledgement', async () => {
    const { activation, payload } = await running()
    end(payload.runId, 'uncertain', { uncertainReason: 'non_idempotent_tool_in_flight' })
    bots.settle(payload, {})
    await tick()
    await bots.continueActivation(activation.id, { acknowledge: { calls: [], uncertainRunId: payload.runId } })
    expect(store.dispatch(activation.id, 2)!.send).toEqual({ continuationOfRunId: payload.runId, acknowledgeUncertain: true })
    unsend(activation.id, 2)
    await crash()
    const resent = store.dispatch(activation.id, 2)!
    expect(runs.getRun(resent.runId!)).toMatchObject({ status: 'queued', outcome: { continuationOf: payload.runId } })
    expect(bots.getActivation(activation.id).status).toBe('running')
  })

  it('a restarted dispatch: the new intent comes first, and a crash before the old run is cancelled only resends it', async () => {
    const { activation, payload } = await running()
    // The old dispatch's time was settled; its run never left `queued`; the new intent was written; then the crash.
    runDb.statement("UPDATE runs SET status = 'queued', active_attempt_id = NULL WHERE run_id = ?").run(payload.runId)
    store.run("UPDATE bot_dispatches SET settled_by = 'startup' WHERE activation_id = ? AND n = 1", activation.id)
    store.insertDispatch({ activationId: activation.id, n: 2, kind: 'continue', clientRequestId: `${activation.id}:d2`, threadId: activation.threadId!, prompt: { text: 'Fix the footer' }, policyDigest: store.activation(activation.id)!.grantDigest })
    await crash()
    expect(runs.getRun(payload.runId)).toMatchObject({ status: 'cancelled' })
    expect(runs.getRun(store.dispatch(activation.id, 2)!.runId!)).toMatchObject({ status: 'queued' })
    expect(store.dispatches(activation.id)).toHaveLength(2)
  })

  it('a context thread trashed while the daemon runs is retired at once; the next consult starts a new one', async () => {
    const { activation, prepared } = await running()
    const asked = prepared.authority.consult!({ context: 'docs', question: 'one' })
    await tick()
    const consult = store.dispatches(activation.id).find((dispatch) => dispatch.kind === 'consult')!
    const consultPayload = payloadOf(consult.runId!)
    bots.prepare(consultPayload)
    start(consult.runId!)
    end(consult.runId!, 'completed')
    bots.settle(consultPayload, { text: 'A' })
    await asked
    bots.beforeTrash([consult.threadId])
    expect(store.contextGen('site-editor', 'docs')).toBe(2)
    expect(bots.roleOf(consult.threadId)).toBeUndefined()
    // Trashing a context thread ends the activation that uses it (plan §4).
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'cancelled', endReason: 'thread_trashed' })
    const next = await running('two', 'c2')
    void next.prepared.authority.consult!({ context: 'docs', question: 'two' })
    for (let index = 0; index < 5; index += 1) await tick()
    expect(store.dispatches(next.activation.id).find((dispatch) => dispatch.kind === 'consult')!.threadId).toBe('thread:bot:site-editor:ctx:docs:2')
  })

  it('an open spend reservation of an activation ended by the trash stays charged', async () => {
    const { activation, payload } = await running()
    store.run("INSERT INTO bot_spend_reservations(id, activation_id, run_id, input_bound, wire_cap, usd_micros, cost_limited, created_at) VALUES('r9', ?, ?, 40, 10, 3, 0, 'x')", activation.id, payload.runId)
    bots.beforeTrash([activation.threadId!])
    end(payload.runId, 'interrupted', { interruptedBy: 'user' })
    await crash()
    expect(bots.getActivation(activation.id).status).toBe('cancelled')
    expect(store.get('SELECT committed_input, committed_output FROM bot_spend WHERE activation_id = ?', activation.id)).toEqual({ committed_input: 40, committed_output: 10 })
  })
})

describe('round 1: trash and delete of a working bot', () => {
  it('before the trash, a running activation ends and its run has stopped', async () => {
    const { activation, payload } = await running()
    host.stopThread = (threadId) => {
      stopped.push(threadId)
      end(payload.runId, 'interrupted', { interruptedBy: 'user' })
    }
    await bots.quiesceForTrash([activation.threadId!])
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'cancelled', endReason: 'thread_trashed' })
    expect(runs.getRun(payload.runId)!.status).toBe('interrupted')
  })

  it('an ordinary thread\'s trash never reads bots.db, so an unreadable bots.db cannot block it', () => {
    store.close()
    expect(bots.beforeTrash(['person-thread'])).toEqual([])
    store = new BotStore({ profileHome: profile, clock: () => clock })
  })

  it('deleting a bot stops its runs, then trashes its home thread; a refused trash is reported and retried', async () => {
    const { activation, payload } = await running()
    host.stopThread = (threadId) => {
      stopped.push(threadId)
      end(payload.runId, 'interrupted', { interruptedBy: 'user' })
    }
    const statusAtTrash: string[] = []
    host.trashThread = async () => { throw new Error('busy') }
    await expect(bots.remove('site-editor')).rejects.toMatchObject({ code: 'bot_cleanup_failed' })
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'cancelled', endReason: 'bot_deleted' })
    host.trashThread = async (threadId) => {
      statusAtTrash.push(runs.getRun(payload.runId)!.status)
      trashed.push(threadId)
      threadStates.set(threadId, 'trashed')
    }
    await bots.finishDeletions()
    expect(trashed).toEqual(['thread:bot:site-editor'])
    expect(statusAtTrash).toEqual(['interrupted'])
    await bots.finishDeletions()
    expect(trashed).toHaveLength(1)
  })
})

describe('round 1: every way out of a wait starts the next activation', () => {
  it('expiry', async () => {
    const { prepared, payload } = await running()
    const next = await bots.activate({ botId: 'site-editor', input: 'two', clientRequestId: 'c2' })
    prepared.authority.escalate!({ permission: { tool: 'web_fetch' }, reason: 'r' })
    await endAtWall(payload)
    expect(bots.getActivation(next.id).status).toBe('queued')
    timers.at(-1)!.fn()
    await tick()
    expect(bots.getActivation(next.id).status).toBe('running')
  })

  it('the sixth wall', async () => {
    const { activation } = await running()
    const next = await bots.activate({ botId: 'site-editor', input: 'two', clientRequestId: 'c2' })
    for (let index = 0; index < 5; index += 1)
      store.insertEscalation({ id: `esc_${index}`, activationId: activation.id, dispatchN: 1, toolCallId: null, kind: 'gate', permission: { tool: 'write' }, reason: 'r', createdAt: 'x', expiresAt: 'y' })
    bots.raiseWall(activation.id, { dispatchN: 1, kind: 'gate', permission: { tool: 'write' }, reason: 'again' })
    await tick()
    expect(bots.getActivation(next.id).status).toBe('running')
  })
})

describe('round 1: smaller fixes', () => {
  it('a consult that cannot be sent fails alone: the main run goes on and the lane opens', async () => {
    const { activation, prepared } = await running()
    const send = runs.sendWithStart.bind(runs)
    let refuse = true
    runs.sendWithStart = async (command, payload) => {
      if (refuse && command.clientRequestId.includes(':c')) {
        refuse = false
        return { status: 'rejected', reason: 'test_refusal' } as never
      }
      return send(command, payload)
    }
    expect(await prepared.authority.consult!({ context: 'docs', question: 'one' })).toContain('could not be sent')
    expect(bots.getActivation(activation.id).status).toBe('running')
    expect(store.activation(activation.id)!.scratch).not.toBeNull()
    void prepared.authority.consult!({ context: 'docs', question: 'two' })
    await tick()
    await tick()
    expect(store.dispatches(activation.id).filter((dispatch) => dispatch.kind === 'consult' && dispatch.runId)).toHaveLength(1)
  })

  it('denying a limit ends the activation blocked instead of asking again', async () => {
    const { activation, payload } = await running()
    timers[0].fn()
    clock += 10 * 60_000
    await endAtWall(payload)
    await bots.respond({ escalationId: bots.listEscalations(activation.id)[0].id, answer: 'deny' })
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'blocked', endReason: 'budget_denied' })
    expect(store.escalations({ activationId: activation.id })).toHaveLength(1)
  })

  it('"Allow for this bot" keeps the owner\'s unpublished edits in the draft', async () => {
    const entry = bots.get('site-editor')
    bots.save({ ...entry.draft, name: 'Site editor (renamed)' }, entry.draftHash)
    const { activation, prepared, payload } = await running()
    prepared.authority.escalate!({ permission: { tool: 'web_fetch' }, reason: 'docs' })
    await endAtWall(payload)
    await bots.respond({ escalationId: bots.listEscalations(activation.id)[0].id, answer: 'allow_bot' })
    const after = bots.get('site-editor')
    expect(after.draft.name).toBe('Site editor (renamed)')
    expect(after.draft.permissions.tools).toContain('web_fetch')
    expect(after.published!.name).toBe('Site editor')
    expect(after.published!.permissions.tools).toContain('web_fetch')
  })

  it('approval checks every context thread\'s runtime too', () => {
    const entry = bots.get('site-editor')
    const saved = bots.save({ ...entry.draft, context: [{ ...entry.draft.context[0], selection: { instanceId: 'codex', model: 'gpt' } }] }, entry.draftHash)
    bots.publish('site-editor', saved.draftHash)
    host.harness.checkPolicy = (instanceId) => instanceId === 'codex'
      ? { ok: false, error: { code: 'policy_unenforceable', message: 'no', missing: ['toolControl'], reason: 'Codex can\'t limit tools to this list.' } }
      : { ok: true }
    expect(bots.approval('site-editor').threads.map((thread) => [thread.key, thread.ok])).toEqual([['main', true], ['docs', false]])
    expect(() => bots.approve('site-editor', bots.approval('site-editor').digest)).toThrow(expect.objectContaining({ code: 'policy_unenforceable' }))
  })

  it('a completed main run with an unknown consult call pauses instead of finishing', async () => {
    const { activation, prepared, payload } = await running()
    const asked = prepared.authority.consult!({ context: 'docs', question: 'one' })
    await tick()
    const consult = store.dispatches(activation.id).find((dispatch) => dispatch.kind === 'consult')!
    const consultPayload = payloadOf(consult.runId!)
    bots.prepare(consultPayload)
    const attempt = start(consult.runId!)
    runs.tools.start({ invocationId: 'c-write', runId: consult.runId!, attemptId: attempt, tool: 'write', argsDigest: 'd', now: 'n', idempotent: false })
    end(consult.runId!, 'interrupted', { interruptedBy: 'user' })
    bots.settle(consultPayload, {})
    await asked
    end(payload.runId, 'completed')
    bots.settle(payload, { text: 'All done.' })
    await tick()
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'paused', endReason: 'unknown_calls', result: 'All done.', unknownCalls: [{ invocationId: 'c-write', role: 'consult' }] })
  })

  it('a newly collected call is announced, so the list shown is the list acknowledged', async () => {
    const { activation, payload } = await running()
    const seen: string[] = []
    bots.events.on('changed', (event: { activationId?: string }) => { if (event.activationId) seen.push(event.activationId) })
    runs.tools.start({ invocationId: 'late-edit', runId: payload.runId, attemptId: runs.getRun(payload.runId)!.activeAttemptId!, tool: 'edit', argsDigest: 'd', now: 'n', idempotent: false })
    end(payload.runId, 'interrupted', { interruptedBy: 'provider' })
    bots.settle(payload, {})
    await tick()
    expect(seen).toContain(activation.id)
    expect(bots.getActivation(activation.id).unknownCalls.map((call) => call.invocationId)).toEqual(['late-edit'])
  })
})

describe('round 2', () => {
  it('a time wall before the first dispatch started resends that dispatch\'s prompt after the answer', async () => {
    const activation = await bots.activate({ botId: 'site-editor', input: 'Fix the footer', clientRequestId: 'c1' })
    store.run('UPDATE bot_counters SET active_ms = ? WHERE activation_id = ?', 10 * 60_000 - 5_000, activation.id)
    const payload = payloadOf(store.dispatch(activation.id, 1)!.runId!)
    expect(bots.prepare(payload)).toMatchObject({ code: 'active_time_exhausted' })
    runs.markTerminal(payload.runId, 'cancelled', { error: 'active_time_exhausted' })
    bots.settle(payload, {})
    await tick()
    await bots.respond({ escalationId: bots.listEscalations(activation.id)[0].id, answer: 'allow_more', amount: 5 * 60_000 })
    const next = store.dispatch(activation.id, 2)!
    expect(next.prompt.text).toContain('The owner allowed')
    expect(next.prompt.text).toContain('Fix the footer')
  })

  it('a stored grant and draft are in the one canonical form', () => {
    const entry = bots.get('site-editor')
    const saved = bots.save({ ...entry.draft, permissions: { ...entry.draft.permissions, workspace: { roots: [root, other], access: 'write', rootAccess: { [root]: 'read' } } } }, entry.draftHash)
    expect(saved.draft.permissions.workspace).toEqual({ roots: [root, other].sort(), access: 'read', rootAccess: { [other]: 'write' } })
  })

  it('a deleted bot\'s cleanup is done once: a home thread restored afterwards is left alone', async () => {
    const { payload } = await running()
    host.stopThread = () => { end(payload.runId, 'interrupted', { interruptedBy: 'user' }) }
    await bots.remove('site-editor')
    expect(trashed).toEqual(['thread:bot:site-editor'])
    // The owner restores the home thread; the next start leaves it.
    threadStates.set('thread:bot:site-editor', 'active')
    await bots.finishDeletions()
    expect(trashed).toEqual(['thread:bot:site-editor'])
  })
})
