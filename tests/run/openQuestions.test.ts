/**
 * Questions an agent asks without waiting (`question_ask` with `wait: false`, issue #1372), end to end: a real
 * `OrchestratorService`, Run Engine and effect worker, with a provider stand-in shaped like Claude Code (it steers by
 * restarting its reply, and takes steers while its turn runs). The question is asked through the `question_ask` tool's
 * own host call, answered the way every client answers (`settle`, or the protocol handler a linked phone and another
 * computer reach), and delivered by the reconciler, as in the app.
 *
 * What can happen to an open question, and what the agent must see each time:
 * | while                     | event                         | the agent gets                         | transcript          |
 * |---------------------------|-------------------------------|----------------------------------------|---------------------|
 * | its turn runs             | answered                      | a steer into that turn                 | the delivery        |
 * | its turn ended            | answered                      | a turn of its own                      | one answers row     |
 * | its turn ended            | answered by a linked device   | a turn of its own                      | one answers row     |
 * | two are open              | each answered                 | each answer names its own question     | a row each          |
 * | its turn runs             | an ordinary message is sent   | the message; the question stays open   | the message         |
 * | any                       | the person dismisses it       | told it was dismissed                  | a row (no answer)   |
 * | any                       | the agent withdraws it        | nothing; a later answer is refused     | nothing             |
 * | any                       | Stop                          | nothing; a later answer is refused     | a note              |
 * | a restart                 | answered after it             | a turn of its own                      | one answers row     |
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import type { AdapterHost, ProviderAdapter, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import { dispatchMethod, type HandlerContext } from '../../src/mms/protocol/handlers'
import { Reconciler } from '../../src/mms/run/Reconciler'
import type { ChatMessage, PendingUserQuestions } from '../../src/shared/types'
import { phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'

vi.setConfig({ testTimeout: 60_000 })

const MODEL = { llmProvider: 'claude-subscription', model: 'vendor-model' }
const BADGE: PendingUserQuestions['questions'] = [{ id: 'colour', prompt: 'Which colour for the badge?', options: [{ id: 'blue', label: 'Blue' }, { id: 'green', label: 'Green' }] }]
const ICON: PendingUserQuestions['questions'] = [{ id: 'icon', prompt: 'Which icon?', options: [{ id: 'star', label: 'Star' }, { id: 'dot', label: 'Dot' }] }]
const USER = { kind: 'user' as const, via: 'gui' as const }

/** A Claude-shaped provider: a turn whose prompt is held runs until released, taking steers as it goes. */
class SteeringAdapter implements ProviderAdapter {
  readonly driver = 'claude' as const
  readonly capabilities = CLAUDE_SUBSCRIPTION_CAPABILITIES
  readonly prompts: string[] = []
  readonly steers: string[] = []
  readonly holdPrompts = new Set<string>()
  private readonly releases = new Map<string, () => void>()

  configured(): boolean {
    return true
  }

  release(prompt: string): void {
    this.holdPrompts.delete(prompt)
    this.releases.get(prompt)?.()
  }

  async startTurn(input: TurnInput, sink: TurnSink, ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.prompts.push(input.prompt)
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    let aborted = false
    const take = (): void => {
      if (aborted) return
      const entry = ctl.drainSteerEntry ? ctl.drainSteerEntry() : undefined
      const text = entry ? entry.text : ctl.drainSteer()
      if (!text) return
      this.steers.push(text)
      ctl.steerTaken?.(entry?.token)
      sink.steerAccepted(text)
    }
    const held = [...this.holdPrompts].find((prompt) => input.prompt.includes(prompt))
    if (held) {
      await new Promise<void>((resolve) => {
        const timer = setInterval(take, 5)
        const done = (): void => {
          clearInterval(timer)
          this.releases.delete(held)
          resolve()
        }
        this.releases.set(held, done)
        const onAbort = (): void => {
          aborted = true
          done()
        }
        if (input.signal.aborted) onAbort()
        else input.signal.addEventListener('abort', onAbort, { once: true })
      })
    }
    take()
    const text = aborted ? '' : `reply ${this.prompts.length}`
    if (!aborted) {
      sink.text({ phase: 'complete', content: text, contentIndex: 0 })
      host.context.nativeHistoryAfterTurn(text)
    }
    return { text, aborted, modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'scripted', nativeMessages: [], providerRef }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

describe('a question asked without waiting (question_ask wait: false)', () => {
  let home: string | undefined
  let previousHome: string | undefined
  const daemons: Phase6Daemon[] = []

  afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => undefined)
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  const boot = (adapter: SteeringAdapter, pid: number) => {
    const d = phase6Daemon(home!, [adapter], { pid })
    daemons.push(d)
    // In the app an inbox write runs this pass at once; here each test runs it where the app would.
    const reconciler = new Reconciler({ store: d.engine.store, outbox: d.engine.outbox, tools: d.engine.tools, capabilitiesFor: (id) => d.orch.capabilitiesForThread(id) })
    return { d, deliver: () => reconciler.runOnce().wakes }
  }

  const world = () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-open-q-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    mkdirSync(join(home, 'project'))
    const adapter = new SteeringAdapter()
    const { d, deliver } = boot(adapter, 1)
    const project = d.projects.openProject(join(home, 'project'))
    const thread = d.store.createThread('Badge', project.id)
    d.orch.setThreadModelOverride(thread.id, MODEL)
    let sends = 0
    const send = (text: string) => d.orch.send(text, false, { threadId: thread.id, clientRequestId: `send-${++sends}`, awaitMode: 'ack' })
    /** `question_ask` with `wait: false`, through the host call the tool makes. */
    const ask = (questions = BADGE, runId: string | null = d.engine.getActiveRun(thread.id)?.runId ?? null) => d.orch.mcpToolHost().askWithoutWaiting!(thread.id, questions, runId)
    const messages = (daemon = d): ChatMessage[] => daemon.orch.getOrCreateSession(thread.id).messages
    /** The messages that deliver answers, as the transcript keeps them. */
    const answerRows = (daemon = d) => messages(daemon).filter((message) => message.subagentNotice?.some((item) => item.event === 'answer'))
    const idle = (daemon = d) => waitFor(() => !daemon.orch.isActiveTurnRunning(thread.id) && daemon.engine.getActiveRun(thread.id) === null, 'the thread to be idle')
    return { d, deliver, adapter, thread, send, ask, messages, answerRows, idle }
  }

  it('answered while the turn runs: the answer is steered into that turn, and shows as the answers row', async () => {
    const w = world()
    w.adapter.holdPrompts.add('build the badge')
    await w.send('build the badge')
    await waitFor(() => w.adapter.prompts.length === 1, 'the turn to start')
    const id = w.ask()

    // Shown to answer, but the thread does not wait on it: nothing that waits for the user sees it.
    expect(w.d.questions.listShownForThread(w.thread.id)).toEqual([expect.objectContaining({ requestId: id, wait: false })])
    expect(w.d.questions.listPendingForThread(w.thread.id)).toEqual([])

    expect(w.d.questions.settle(id, { colour: 'green' }, USER)).toEqual({ ok: true })
    expect(w.d.questions.listShownForThread(w.thread.id)).toEqual([])
    expect(w.deliver().steers).toHaveLength(1)
    await waitFor(() => w.adapter.steers.length === 1, 'the steer to be taken')
    // A Mousse notice about the question, with the person's choice as their own words.
    expect(w.adapter.steers[0]).toContain(`<mousse_notice kind="question_answered" ref="${id}">\nThe user answered your open question ${id}.`)
    expect(w.adapter.steers[0]).toContain('Question colour ("Which colour for the badge?"):\n\n<mousse_message from="user">\nChose "Green".\n</mousse_message>')

    w.adapter.release('build the badge')
    await w.idle()
    // One turn: the answer joined it, and no turn of its own started.
    expect(w.adapter.prompts).toHaveLength(1)
    expect(w.answerRows()).toHaveLength(1)
    expect(w.answerRows()[0]!.subagentNotice).toEqual([expect.objectContaining({ event: 'answer', requestId: id, answers: [{ prompt: 'Which colour for the badge?', chosen: ['Green'] }] })])
    // The answer is never also a plain message from the person.
    expect(w.messages().filter((message) => message.role === 'user' && !message.subagentNotice && message.content.includes('Green'))).toEqual([])
  })

  it('answered after the turn ended: a turn of its own carries the answer', async () => {
    const w = world()
    await w.send('build the badge')
    await w.idle()
    const id = w.ask(BADGE, w.d.engine.listRuns(w.thread.id)[0]!.runId)

    expect(w.d.questions.settle(id, { colour: 'blue' }, USER)).toEqual({ ok: true })
    expect(w.deliver().wakes).toHaveLength(1)
    await waitFor(() => w.adapter.prompts.length === 2, 'the answer turn')
    await w.idle()
    expect(w.adapter.prompts[1]).toContain(`<mousse_notice kind="question_answered" ref="${id}">`)
    expect(w.adapter.prompts[1]).toContain('<mousse_message from="user">\nChose "Blue".\n</mousse_message>')
    expect(w.answerRows()).toHaveLength(1)
    expect(w.answerRows()[0]!.subagentNotice![0]!.answers).toEqual([{ prompt: 'Which colour for the badge?', chosen: ['Blue'] }])
  })

  it('an answer from a linked phone (the protocol handler) starts the turn the same way, and adds no second row', async () => {
    const w = world()
    await w.send('build the badge')
    await w.idle()
    const id = w.ask()
    const phone = { mms: { questions: w.d.questions, orchestrator: w.d.orch, threads: w.d.store } } as unknown as HandlerContext

    await expect(dispatchMethod(phone, 'orchestrator.answerQuestions', { requestId: id, answers: { colour: 'Teal, with a white border' } })).resolves.toEqual({ ok: true })
    // A second answer (another device, late) learns the question was already answered.
    await expect(dispatchMethod(phone, 'orchestrator.answerQuestions', { requestId: id, answers: { colour: 'blue' } })).resolves.toMatchObject({ ok: false, reason: 'already_answered' })
    expect(w.d.engine.openQuestions.get(id)).toMatchObject({ status: 'answered', answeredBy: { kind: 'user', via: 'bridge' } })
    w.deliver()
    await waitFor(() => w.adapter.prompts.length === 2, 'the answer turn')
    await w.idle()
    expect(w.adapter.prompts[1]).toContain('<mousse_message from="user">\nTeal, with a white border\n</mousse_message>')
    // The answers row is recorded when the answer is given, once; the message that delivers it carries no second one.
    expect(w.messages().filter((message) => message.questionAnswers)).toEqual([expect.objectContaining({ questionAnswers: [{ prompt: 'Which colour for the badge?', chosen: [], reply: 'Teal, with a white border' }] })])
    expect(w.answerRows()).toHaveLength(1)
  })

  it('an answer with an image keeps it: the answers row shows the image, and the agent is told where it is saved', async () => {
    const w = world()
    await w.send('build the badge')
    await w.idle()
    const id = w.ask()
    const gui = { mms: { questions: w.d.questions, orchestrator: w.d.orch, threads: w.d.store }, connection: { id: 'gui-1', clientType: 'gui' } } as unknown as HandlerContext
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    await expect(dispatchMethod(gui, 'orchestrator.answerQuestions', { requestId: id, answers: { colour: 'like this one' }, attachments: { colour: [{ name: 'swatch.png', mimeType: 'image/png', data: png }] } })).resolves.toEqual({ ok: true })
    const rows = w.messages().filter((message) => message.questionAnswers)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.images).toEqual([expect.objectContaining({ name: 'swatch.png', data: png })])
    expect(rows[0]!.questionAnswers![0]!.images).toEqual([0])
    w.deliver()
    await waitFor(() => w.adapter.prompts.length === 2, 'the answer turn')
    await w.idle()
    // The saved path, on any platform, inside the person's words.
    expect(w.adapter.prompts[1]).toMatch(/<mousse_message from="user">\nlike this one\n\[Image attached: [^\]\n]+\.png\]\n<\/mousse_message>/)
  })

  it('several open at once: each answer reaches the agent tagged with its own question', async () => {
    const w = world()
    w.adapter.holdPrompts.add('build the badge')
    await w.send('build the badge')
    await waitFor(() => w.adapter.prompts.length === 1, 'the turn to start')
    const colour = w.ask(BADGE)
    const icon = w.ask(ICON)
    expect(w.d.questions.listShownForThread(w.thread.id).map((entry) => entry.requestId)).toEqual([colour, icon])

    w.d.questions.settle(icon, { icon: 'star' }, USER)
    w.deliver()
    await waitFor(() => w.adapter.steers.length === 1, 'the first answer')
    w.d.questions.settle(colour, { colour: 'blue' }, USER)
    w.deliver()
    await waitFor(() => w.adapter.steers.length === 2, 'the second answer')
    expect(w.adapter.steers[0]).toContain(`ref="${icon}"`)
    expect(w.adapter.steers[0]).toContain('"Star"')
    expect(w.adapter.steers[1]).toContain(`ref="${colour}"`)
    expect(w.adapter.steers[1]).toContain('"Blue"')
    w.adapter.release('build the badge')
    await w.idle()
  })

  it('an ordinary message does not close it, and is not taken as its answer', async () => {
    const w = world()
    w.adapter.holdPrompts.add('build the badge')
    await w.send('build the badge')
    await waitFor(() => w.adapter.prompts.length === 1, 'the turn to start')
    const id = w.ask()
    // Sent while the turn runs: it queues behind the turn as usual, and the open question is left alone.
    const sent = await w.send('also make it round')
    expect(sent.queued).toBe(true)
    w.adapter.release('build the badge')
    await waitFor(() => w.adapter.prompts.length === 2, 'the message to run')
    await w.idle()
    expect(w.adapter.prompts[1]).toBe('also make it round')
    expect(w.d.questions.listShownForThread(w.thread.id).map((entry) => entry.requestId)).toEqual([id])
    expect(w.d.engine.openQuestions.get(id)!.status).toBe('open')
  })

  it('dismissed by the person: the agent is told, as it would be of an answer', async () => {
    const w = world()
    await w.send('build the badge')
    await w.idle()
    const id = w.ask()
    expect(w.d.questions.dismiss(id, USER)).toBe(true)
    w.deliver()
    await waitFor(() => w.adapter.prompts.length === 2, 'the dismissal turn')
    await w.idle()
    expect(w.adapter.prompts[1]).toContain(`<mousse_notice kind="question_dismissed" ref="${id}">\nThe user dismissed your open question ${id} without answering it.`)
  })

  it('withdrawn by the agent: the card goes, nothing is delivered, and a late answer is refused', async () => {
    const w = world()
    await w.send('build the badge')
    await w.idle()
    const id = w.ask()
    const cleared: string[] = []
    w.d.questions.on('cleared', (event: { requestId: string }) => cleared.push(event.requestId))

    expect(w.d.orch.mcpToolHost().withdrawQuestion!(w.thread.id, id)).toBe(true)
    expect(cleared).toEqual([id])
    expect(w.d.questions.listShownForThread(w.thread.id)).toEqual([])
    expect(w.d.questions.settle(id, { colour: 'blue' }, USER)).toMatchObject({ ok: false, reason: 'cancelled', cancelReason: 'withdrawn' })
    // Only the thread that asked may withdraw it.
    const other = w.ask()
    expect(w.d.orch.mcpToolHost().withdrawQuestion!('another-thread', other)).toBe(false)
    expect(w.deliver()).toMatchObject({ wakes: [], steers: [] })
    expect(w.adapter.prompts).toHaveLength(1)
  })

  it('Stop closes it with a note in the thread, and a later answer is refused', async () => {
    const w = world()
    w.adapter.holdPrompts.add('build the badge')
    await w.send('build the badge')
    await waitFor(() => w.adapter.prompts.length === 1, 'the turn to start')
    const id = w.ask()
    await w.d.orch.stopThread(w.thread.id, 'user')
    await w.idle()

    expect(w.d.questions.listShownForThread(w.thread.id)).toEqual([])
    expect(w.d.engine.openQuestions.get(id)).toMatchObject({ status: 'closed', closeReason: 'stopped' })
    expect(w.messages().some((message) => message.content.includes('"Which colour for the badge?" was closed because the thread was stopped'))).toBe(true)
    expect(w.d.questions.settle(id, { colour: 'blue' }, USER)).toMatchObject({ ok: false, reason: 'cancelled', cancelReason: 'stopped' })
  })

  it('stays answerable after a restart, and its answer then starts a turn', async () => {
    const w = world()
    await w.send('build the badge')
    await w.idle()
    const id = w.ask()
    await daemons[0]!.shutdown()
    daemons.splice(0)

    const adapter = new SteeringAdapter()
    const { d, deliver } = boot(adapter, 2)
    d.orch.setThreadModelOverride(w.thread.id, MODEL)
    expect(d.questions.listShownForThread(w.thread.id)).toEqual([{ requestId: id, threadId: w.thread.id, questions: BADGE, wait: false }])
    expect(d.questions.getPending(id)).toMatchObject({ requestId: id, wait: false })

    expect(d.questions.settle(id, { colour: 'green' }, USER)).toEqual({ ok: true })
    expect(deliver().wakes).toHaveLength(1)
    await waitFor(() => adapter.prompts.length === 1, 'the answer turn after the restart')
    await w.idle(d)
    expect(adapter.prompts[0]).toContain(`<mousse_notice kind="question_answered" ref="${id}">\nThe user answered your open question ${id}.`)
    expect(w.answerRows(d)).toHaveLength(1)
  })
})
