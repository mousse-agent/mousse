/**
 * SPEC §16.1: handoffs are stored artifacts. Strategy decisions on the engine, then a real
 * orchestrator switching pi → Claude-shaped adapter: the `<handoff>` block reaches the prompt, the
 * marker links the artifact, a pending handoff blocks a second switch, and a throw marks it failed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import { PI_TEST_CAPABILITIES } from '../support/piStub'
import type { HandoffItem } from '../../src/mms/run/handoff/budget'
import type { ProviderRef } from '../../src/mms/run/types'
import { delegationFixture, type DelegationFixture } from './delegationFixture'
import { CLAUDE, PI, claudeAdapter, phase6Daemon, piAdapter, type Phase6Daemon } from './phase6Fixture'

describe('HandoffService strategies (SPEC §16.1)', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })

  /** A finished run on `threadId` whose attempt ran on `provider`. */
  const ranOn = async (threadId: string, provider: string) => {
    const sent = await fx!.engine.dispatch({ kind: 'send', threadId, clientRequestId: `send:${threadId}:${Math.random()}`, source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    fx!.engine.markStarting(sent.runId)
    fx!.engine.recordProviderRef(sent.runId, { provider, model: 'm' })
    fx!.engine.markRunning(sent.runId)
    return fx!.engine.markTerminal(sent.runId, 'completed')
  }
  const target = async (threadId: string) => {
    const sent = await fx!.engine.dispatch({ kind: 'send', threadId, clientRequestId: `target:${Math.random()}`, source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    fx!.engine.markStarting(sent.runId)
    return fx!.engine.markRunning(sent.runId)
  }
  const transcript = (items: HandoffItem[]) => fx!.engine.handoffs.setTranscriptSource(() => items)
  const items: HandoffItem[] = [
    { runOrdinal: 1, role: 'user', text: 'u1' }, { runOrdinal: 1, role: 'assistant', text: 'a1' },
    { runOrdinal: 2, role: 'user', text: 'u2' }, { runOrdinal: 2, role: 'assistant', text: 'a2' }
  ]
  const to: ProviderRef = { provider: 'claude-subscription', model: 'sonnet' }

  it('full_summary when the target provider never ran on the thread', async () => {
    fx = delegationFixture()
    await ranOn('t', 'openai')
    await ranOn('t', 'openai')
    const run = await target('t')
    transcript(items)
    const plan = fx.engine.handoffs.plan({ threadId: 't', targetRunId: run.runId, from: { provider: 'openai' }, to, caps: CLAUDE_SUBSCRIPTION_CAPABILITIES })
    expect(plan.strategy).toBe('full_summary')
    expect(plan.delivery).toBe('prompt_preamble')
    expect(plan.history.map((item) => item.text)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(plan.record).toMatchObject({ status: 'pending', coveredFromOrdinal: 1, coveredToOrdinal: 2, selectedItems: 4, omittedItems: 0, budgetTokens: 16_000 })
    expect(fx.engine.listEvents('t').filter((event) => event.type === 'handoff.status')).toHaveLength(1)
  })

  it('reads the thread owner\'s transcript before its write transaction opens (M2)', async () => {
    fx = delegationFixture()
    await ranOn('t', 'openai')
    const run = await target('t')
    const inTransaction: boolean[] = []
    fx.engine.handoffs.setTranscriptSource(() => {
      inTransaction.push(fx!.db.inTransaction)
      return items
    })
    const plan = fx.engine.handoffs.plan({ threadId: 't', targetRunId: run.runId, from: { provider: 'openai' }, to, caps: CLAUDE_SUBSCRIPTION_CAPABILITIES })
    expect(inTransaction).toEqual([false])
    expect(plan.record.status).toBe('pending')
  })

  it('delta (the runs since its last turn) when the target provider ran earlier on the thread', async () => {
    fx = delegationFixture()
    await ranOn('t', 'claude-subscription')
    await ranOn('t', 'openai')
    const run = await target('t')
    transcript(items)
    const plan = fx.engine.handoffs.plan({ threadId: 't', targetRunId: run.runId, from: { provider: 'openai' }, to, caps: PI_TEST_CAPABILITIES })
    expect(plan.strategy).toBe('delta')
    expect(plan.delivery).toBe('native_history')
    expect(plan.history.map((item) => item.text)).toEqual(['u2', 'a2'])
    expect(plan.record).toMatchObject({ coveredFromOrdinal: 2, coveredToOrdinal: 2 })
  })

  it('native_resume (nothing sent) for the same provider with a live native session', async () => {
    fx = delegationFixture()
    await ranOn('t', 'x')
    const run = await target('t')
    transcript(items)
    const plan = fx.engine.handoffs.plan({ threadId: 't', targetRunId: run.runId, from: { provider: 'x', sessionId: 's1' }, to: { provider: 'x' }, caps: PI_TEST_CAPABILITIES })
    expect(plan.strategy).toBe('native_resume')
    expect(plan.history).toEqual([])
    expect(plan.pointer).toBe('')
  })

  it('a budget hit compacts and omits with a pointer; delivered and failed are recorded once', async () => {
    fx = delegationFixture()
    await ranOn('t', 'openai')
    const run = await target('t')
    transcript([{ runOrdinal: 1, role: 'user', text: 'q'.repeat(3_000) }, { runOrdinal: 1, role: 'assistant', text: 'r'.repeat(3_000) }])
    // 2k window: reserve 16k leaves nothing; give the cap room through a bigger window instead.
    const plan = fx.engine.handoffs.plan({ threadId: 't', targetRunId: run.runId, from: null, to, caps: CLAUDE_SUBSCRIPTION_CAPABILITIES, cap: 1_000 })
    expect(plan.history.every((item) => item.compacted)).toBe(true)
    expect(plan.history).toHaveLength(2)
    const tight = fx.engine.handoffs.plan({ threadId: 't', targetRunId: run.runId, from: null, to, caps: CLAUDE_SUBSCRIPTION_CAPABILITIES, modelWindow: 16_100 })
    expect(tight.record.budgetTokens).toBe(100)
    expect(tight.omittedItems).toBe(2)
    expect(tight.pointer).toContain('thread_read')
    expect(fx.engine.handoffs.markDelivered(plan.handoffId)).toMatchObject({ status: 'delivered' })
    expect(fx.engine.handoffs.markFailed(plan.handoffId, 'late')).toMatchObject({ status: 'delivered' })
    expect(fx.engine.handoffs.markFailed(tight.handoffId, 'boom')).toMatchObject({ status: 'failed', deliveredAt: null })
  })

  it('a pending handoff whose turn already ended is failed instead of blocking', async () => {
    fx = delegationFixture()
    const run = await target('t')
    transcript(items)
    const plan = fx.engine.handoffs.plan({ threadId: 't', targetRunId: run.runId, from: null, to, caps: CLAUDE_SUBSCRIPTION_CAPABILITIES })
    expect(fx.engine.handoffs.pendingForThread('t')?.handoffId).toBe(plan.handoffId)
    fx.engine.markTerminal(run.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    expect(fx.engine.handoffs.pendingForThread('t')).toBeNull()
    expect(fx.engine.handoffs.get(plan.handoffId)!.status).toBe('failed')
  })
})

describe('provider switch through the orchestrator (SPEC §16.1)', () => {
  let home: string | undefined
  let previousHome: string | undefined
  let daemon: Phase6Daemon | undefined

  afterEach(async () => {
    await daemon?.stop().catch(() => undefined)
    daemon = undefined
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  const setup = (claudeScript: Parameters<typeof claudeAdapter>[0] = () => 'Claude here.') => {
    home = mkdtempSync(join(tmpdir(), 'mousse-handoff-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const pi = piAdapter((input) => `pi answered: ${input.prompt}`)
    const claude = claudeAdapter(claudeScript)
    daemon = phase6Daemon(home, [pi, claude])
    return { pi, claude, d: daemon }
  }

  it('delivers a full_summary <handoff> block in the prompt, links it from the marker and blocks a second switch while pending', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let blockedSwitch: unknown
    const { pi, claude, d } = setup(async () => {
      blockedSwitch = (() => {
        try {
          d.orch.setThreadModelOverride(thread.id, PI)
          return null
        } catch (error) {
          return error
        }
      })()
      await gate
      return 'Claude here.'
    })
    const thread = d.store.createThread('Switch')
    d.orch.setThreadModelOverride(thread.id, PI)
    await d.orch.send('First question', false, { threadId: thread.id, clientRequestId: 'send-1' })
    expect(pi.turns).toHaveLength(1)

    d.orch.setThreadModelOverride(thread.id, CLAUDE)
    const pending = d.orch.send('Second question', false, { threadId: thread.id, clientRequestId: 'send-2' })
    await new Promise<void>((resolve) => {
      const tick = () => (claude.turns.length ? resolve() : setTimeout(tick, 5))
      tick()
    })
    release()
    const response = await pending
    expect(response.message).toBe('Claude here.')

    const turn = claude.turns[0]
    expect(turn.nativeHistory).toBe('')
    expect(turn.prompt).toBe(
      '<handoff strategy="full_summary" covered="1" items="2/2">\n[user] First question\n[assistant] pi answered: First question\n</handoff>\n\nSecond question'
    )
    expect(blockedSwitch).toMatchObject({ code: 'handoff_pending' })

    const [handoff] = d.engine.handoffs.listForThread(thread.id)
    expect(handoff).toMatchObject({ strategy: 'full_summary', status: 'delivered', selectedItems: 2, omittedItems: 0, toRef: { provider: 'claude-subscription' }, fromRef: { provider: 'openai' } })
    const marker = d.orch.getMessages(thread.id).find((message) => message.kind === 'context_handoff')
    expect(marker?.contextHandoff).toMatchObject({ handoffId: handoff.handoffId, strategy: 'full_summary', selectedItems: 2, omittedItems: 0 })
    // Delivered: switching again is allowed.
    expect(() => d.orch.setThreadModelOverride(thread.id, PI)).not.toThrow()

    // Back on pi: Claude ran on run 2, so pi (last on run 1) gets the delta since then, as messages.
    await d.orch.send('Third question', false, { threadId: thread.id, clientRequestId: 'send-3' })
    const third = d.engine.handoffs.listForThread(thread.id)[1]
    expect(third).toMatchObject({ strategy: 'delta', coveredFromOrdinal: 2, coveredToOrdinal: 2, status: 'delivered' })
    const sent = pi.turns[1].messages
    expect(sent[0]).toMatchObject({ role: 'user' })
    expect(String(sent[0].content)).toContain('[Context handoff: strategy=delta, covered=2.]')
    expect(String(sent[0].content)).toContain('Second question')
    expect(sent.at(-1)).toMatchObject({ role: 'user', content: 'Third question' })
    // The canonical transcript keeps every turn: the delta prefix was not persisted over it.
    const canonical = d.orch.getNativeContext(thread.id).messages
    expect(canonical.filter((message) => message.role === 'user').map((message) => message.content)).toEqual(['First question', 'Second question', 'Third question'])
  }, 30_000)

  it('marks the handoff failed when the adapter throws', async () => {
    const { claude, d } = setup()
    const thread = d.store.createThread('Switch failure')
    d.orch.setThreadModelOverride(thread.id, PI)
    await d.orch.send('First', false, { threadId: thread.id, clientRequestId: 'f-1' })
    d.orch.setThreadModelOverride(thread.id, CLAUDE)
    claude.failNext = new Error('provider down')
    await d.orch.send('Second', false, { threadId: thread.id, clientRequestId: 'f-2' }).catch(() => undefined)
    const [handoff] = d.engine.handoffs.listForThread(thread.id)
    expect(handoff.status).toBe('failed')
    const failedEvent = d.engine.listEvents(thread.id).filter((event) => event.type === 'handoff.status').at(-1)!
    expect(failedEvent.payload).toMatchObject({ status: 'failed', error: expect.stringContaining('provider down') })
  }, 30_000)
})
