/**
 * Antigravity's own steer (`AcpQuirks.nativeSteerFrom`): from agy 1.5.0 a steer goes into the running prompt as a
 * second `session/prompt`, with no cancel, through the ACP adapter, the real session core and the steer hold.
 *
 * The fake agent is hand-authored from a probe of agy 1.5.13 over ACP (two runs, model claude-sonnet-5-5):
 * - a prompt sent while one runs is folded into the running work: the running prompt answers `end_turn` about 30 ms
 *   after the second arrives, and the second answers when the work ends, having done the steer too;
 * - nothing echoes the steer (no `user_message_chunk`) and updates carry no prompt tag: what arrives after the first
 *   answer is the second prompt's;
 * - a second prompt that arrives while the first is already ending: the first answers at its own end and the second
 *   runs next.
 * Older runtimes (1.4) queued the second prompt until the first ended: Mousse cuts and restarts there. It proves
 * Mousse's side only; the real agent's side is the probe above.
 */
import { methods, PROTOCOL_VERSION, RequestError, type AgentApp } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpSessions, type SavedAcpSession } from '../../src/mms/harness/acp/session'
import { ANTIGRAVITY_QUIRKS } from '../../src/mms/harness/acp/presets/antigravity'
import { ANTIGRAVITY_CAPS } from '../../src/mms/harness/drivers/antigravity'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { inProcessAgent } from '../../src/mms/run/testkit/acpAgent'
import type { LlmModelOption } from '../../src/shared/settings'
import type { AdapterHost, TurnInput, TurnSink } from '../../src/mms/harness/adapter'
import { AcpAdapter } from '../../src/mms/harness/drivers/acp/adapter'
import { holdControl } from '../support/steerHoldControl'

const sessionsUnderTest: AcpSessions[] = []
afterEach(() => {
  for (const sessions of sessionsUnderTest.splice(0)) sessions.stop()
})

const STEER = 'Also print the date'
const SESSION = { configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fast', options: [{ value: 'fast', name: 'Fast' }] }] }
const toolCall = (id: string) => ({ sessionUpdate: 'tool_call', toolCallId: id, title: 'ping -n 4 127.0.0.1', kind: 'execute', status: 'in_progress' })
const toolDone = (id: string) => ({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' })

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => { open = resolve })
  return { opened, open }
}

interface Work {
  /** The first prompt's text. */
  text: string
  /** Prompts folded into this work so far (the steers). */
  steers: string[]
  update: (update: Record<string, unknown>) => Promise<void>
  notify: (text: string) => Promise<void>
  cancelled: Promise<void>
}

/** An agy-like agent of `version` (see the header); `work` runs a prompt's work, and its result is the stop reason. */
function agyAgent(options: { version: string; refuseSecond?: boolean; beforeAnswer?: Promise<void>; work: (work: Work) => Promise<string> }) {
  const prompts: Array<{ text: string; whileRunning: boolean }> = []
  const cancels: string[] = []
  /** `prompt-N:<stopReason>` as each prompt request is answered. */
  const answers: string[] = []
  const folds = Number(options.version.split('.')[0]) > 1 || Number(options.version.split('.')[1]) >= 5
  const agentApp = inProcessAgent((app: AgentApp) => {
    let running: { label: string; answer: (stopReason: string) => void; steers: string[]; ended: Promise<void>; cancel: () => void } | undefined
    // Work that ended and whose answer is on its way: a prompt arriving now runs once it is answered.
    let answering: Promise<void> | undefined
    app
      .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [], agentInfo: { name: 'agy', version: options.version } }) as never)
      .onRequest(methods.agent.session.new, () => ({ sessionId: 'native-1', ...SESSION }) as never)
      .onRequest(methods.agent.session.setConfigOption, () => ({ configOptions: [] }))
      .onRequest(methods.agent.session.prompt, async (c) => {
        const text = (c.params.prompt[0] as { text: string }).text
        const label = `prompt-${prompts.push({ text, whileRunning: Boolean(running) })}`
        if (running && folds) {
          if (options.refuseSecond) throw RequestError.invalidRequest(undefined, 'a prompt is already running')
          // Folded into the running work: the running prompt answers now, and this one carries the rest of it.
          const work = running
          work.steers.push(text)
          const previous = { label: work.label, answer: work.answer }
          const answered = new Promise<string>((resolve) => { work.answer = resolve; work.label = label })
          answers.push(`${previous.label}:end_turn`)
          previous.answer('end_turn')
          return { stopReason: (await answered) as 'end_turn' }
        }
        // 1.4 queued it until the running work ended.
        if (running) await running.ended
        if (answering) await answering
        let answer!: (stopReason: string) => void
        const answered = new Promise<string>((resolve) => { answer = resolve })
        let cancel!: () => void
        const cancelled = new Promise<void>((resolve) => { cancel = resolve })
        let end!: () => void
        const ended = new Promise<void>((resolve) => { end = resolve })
        const work = { label, answer, steers: [] as string[], ended, cancel }
        running = work
        void options.work({
          text,
          steers: work.steers,
          update: (update) => c.client.notify(methods.client.session.update, { sessionId: 'native-1', update } as never),
          notify: (chunk) => c.client.notify(methods.client.session.update, { sessionId: 'native-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } } }),
          cancelled
        }).then(async (reason) => {
          running = undefined
          end()
          answering = options.beforeAnswer?.then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
          await options.beforeAnswer
          answers.push(`${work.label}:${reason}`)
          work.answer(reason)
        })
        return { stopReason: (await answered) as 'end_turn' }
      })
      .onNotification(methods.agent.session.cancel, (c) => {
        cancels.push(c.params.sessionId)
        running?.cancel()
      })
  })
  return { ...agentApp, prompts, cancels, answers }
}

/** Runs the steers the work was given, as the agent does at its next step. */
async function doSteers(work: Work): Promise<void> {
  for (const steer of work.steers) await work.notify(`then ${steer}`)
}

/** A turn through the ACP adapter and the real session core, with Antigravity's quirks and caps, on the hold. */
function agyTurn(agent: ReturnType<typeof agyAgent>, options: { promptSilenceMs?: number } = {}) {
  const saved = new Map<string, SavedAcpSession>()
  let models: LlmModelOption[] = []
  const questions = new UserQuestionService()
  const sessions = new AcpSessions({
    label: 'Antigravity',
    defaultInstanceId: 'antigravity',
    questions,
    connect: agent.connect,
    quirks: ANTIGRAVITY_QUIRKS,
    ...(options.promptSilenceMs !== undefined ? { promptSilenceMs: options.promptSilenceMs } : {}),
    store: {
      saved: (threadId) => saved.get(threadId),
      setSaved: (threadId, value) => (value ? saved.set(threadId, value) : saved.delete(threadId)),
      models: () => models,
      setModels: (next) => { models = next }
    },
    launchGeneration: () => 0,
    signInGeneration: () => 0,
    markSignedOut: vi.fn(),
    signInRequiredMessage: 'Sign in first'
  })
  sessionsUnderTest.push(sessions)
  const hold = holdControl(ANTIGRAVITY_CAPS)
  const sink = hold.wrap({ text: () => {}, thinking: () => {}, tool: () => {}, progress: () => {}, providerRef: () => {}, usage: () => {}, steerAccepted: () => {} } as unknown as TurnSink)
  const adapter = new AcpAdapter(() => ({ chat: (input) => sessions.chat(input), commitConversation: () => {}, configured: () => true }), { driver: 'antigravity', label: 'Antigravity', capabilities: ANTIGRAVITY_CAPS })
  const input = { threadId: 't', instanceId: 'antigravity', llmProvider: '', model: 'fast', mode: 'agent', prompt: 'work', cwd: process.cwd(), signal: new AbortController().signal } as unknown as TurnInput
  let settled = false
  const result = adapter.startTurn(input, sink, hold.ctl, { context: { nativeHistoryAfterTurn: (text: string) => text } } as unknown as AdapterHost)
  void result.then(() => { settled = true }, () => { settled = true })
  const events = () => hold.log.map(([event, detail]) => `${event}:${detail}`)
  return { hold, sessions, result, events, settled: () => settled }
}

/** Each step happens, in this order (each found after the one before). */
function order(events: string[], ...steps: string[]) {
  let from = 0
  for (const step of steps) {
    const at = events.indexOf(step, from)
    expect(at, `${step} after ${JSON.stringify(events.slice(0, from))} in ${JSON.stringify(events)}`).toBeGreaterThanOrEqual(0)
    from = at + 1
  }
}

/** A prompt that runs one tool until `finish` opens (or a cancel), then does the steers it was given. */
function toolWork(started: ReturnType<typeof gate>, finish: ReturnType<typeof gate>) {
  return async (work: Work): Promise<string> => {
    if (work.text !== 'work') {
      await work.notify(`then ${work.text}`)
      return 'end_turn'
    }
    await work.update(toolCall('call-1'))
    started.open()
    const cut = await Promise.race([finish.opened.then(() => false), work.cancelled.then(() => true)])
    if (cut) return 'cancelled'
    await work.update(toolDone('call-1'))
    await doSteers(work)
    await work.notify('\n\nAll done.')
    return 'end_turn'
  }
}

describe("Antigravity's own steer: a second prompt into the running one (agy 1.5.0 and newer)", () => {
  it("a person's steer during a running tool goes in at once with no cancel; the tool finishes and the turn ends when the work ends", async () => {
    const started = gate()
    const finish = gate()
    const agent = agyAgent({ version: '1.5.13', work: toolWork(started, finish) })
    const turn = agyTurn(agent)
    await started.opened
    turn.hold.steer(STEER)
    // Sent while the first prompt runs, and nothing waits for the tool.
    await vi.waitFor(() => expect(agent.prompts).toEqual([{ text: 'work', whileRunning: false }, { text: STEER, whileRunning: true }]))
    expect(turn.hold.held()).toBe(false)
    await vi.waitFor(() => expect(agent.answers).toContain('prompt-1:end_turn'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    // The first prompt's answer is not the turn's end: the work goes on under the steer's prompt.
    expect(turn.settled()).toBe(false)
    finish.open()
    expect((await turn.result).text).toBe(`then ${STEER}\n\nAll done.`)
    expect(agent.cancels).toEqual([])
    expect(agent.answers).toEqual(['prompt-1:end_turn', 'prompt-2:end_turn'])
    // Read once the agent took it in and worked on, before what it then wrote; never checked for a cut.
    order(turn.events(), 'tool:start:call-1', `drain:${STEER}`, 'taken:drain-1', `accepted:${STEER}@drain-1`, 'tool:complete:call-1', `text:then ${STEER}`)
    expect(turn.events().filter((event) => event.startsWith('accepted:'))).toEqual([`accepted:${STEER}@drain-1`])
    expect(turn.events().filter((event) => event.startsWith('mayCut') || event.startsWith('returned'))).toEqual([])
  })

  it('a steer that arrives as the prompt ends runs next, with no cancel, and is read once', async () => {
    const answer = gate()
    const wrote = gate()
    const agent = agyAgent({
      version: '1.5.13',
      beforeAnswer: answer.opened,
      work: async (work) => {
        if (work.text !== 'work') {
          await work.notify(`then ${work.text}`)
          return 'end_turn'
        }
        await work.notify('Ran it.')
        wrote.open()
        return 'end_turn'
      }
    })
    const turn = agyTurn(agent)
    // The work is over, and its answer is on its way when the steer goes out.
    await wrote.opened
    await vi.waitFor(() => expect(turn.events()).toContain('text:Ran it.'))
    turn.hold.steer(STEER)
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(2))
    answer.open()
    expect((await turn.result).text).toBe(`Ran it.\n\nthen ${STEER}`)
    expect(agent.prompts[1]).toEqual({ text: STEER, whileRunning: false })
    expect(agent.cancels).toEqual([])
    expect(agent.answers).toEqual(['prompt-1:end_turn', 'prompt-2:end_turn'])
    order(turn.events(), 'text:Ran it.', `drain:${STEER}`, 'taken:drain-1', `accepted:${STEER}@drain-1`, `text:then ${STEER}`)
    expect(turn.events().filter((event) => event.startsWith('accepted:'))).toHaveLength(1)
  })

  it('a second prompt the agent refuses hands the steer back, and it is cut in instead', async () => {
    const started = gate()
    const finish = gate()
    const agent = agyAgent({ version: '1.5.13', refuseSecond: true, work: toolWork(started, finish) })
    const turn = agyTurn(agent)
    await started.opened
    turn.hold.steer(STEER)
    expect((await turn.result).text).toBe(`then ${STEER}`)
    expect(agent.cancels).toEqual(['native-1'])
    order(turn.events(), `drain:${STEER}`, `returned:${STEER}`, `drain:${STEER}`, 'mayCut:true', `accepted:${STEER}@drain-2`)
    expect(turn.events().filter((event) => event.startsWith('accepted:'))).toEqual([`accepted:${STEER}@drain-2`])
  })

  it("Stop while the steer's prompt runs cancels the work, and waits for that prompt's end", async () => {
    const started = gate()
    const finish = gate()
    const agent = agyAgent({ version: '1.5.13', work: toolWork(started, finish) })
    const turn = agyTurn(agent)
    await started.opened
    turn.hold.steer(STEER)
    await vi.waitFor(() => expect(agent.answers).toContain('prompt-1:end_turn'))
    expect(await turn.sessions.interrupt('native-1')).toBe('interrupted')
    // The steer's prompt ended with the cancel before the stop reported back.
    expect(agent.answers).toEqual(['prompt-1:end_turn', 'prompt-2:cancelled'])
    await turn.result
    expect(agent.cancels).toEqual(['native-1'])
    expect(agent.connections[0].killed).toBe(false)
  })

  it("a steer's prompt that goes silent fails the turn on the silence watchdog", async () => {
    const started = gate()
    const agent = agyAgent({ version: '1.5.13', work: toolWork(started, gate()) })
    const turn = agyTurn(agent, { promptSilenceMs: 300 })
    await started.opened
    turn.hold.steer(STEER)
    await expect(turn.result).rejects.toThrow('did not answer')
    expect(agent.answers).toEqual(['prompt-1:end_turn'])
    expect(agent.connections[0].killed).toBe(true)
  })
})

describe('an older Antigravity (1.4) keeps cut-and-restart', () => {
  it("a person's steer during a tool cancels it and goes in as the next prompt", async () => {
    const started = gate()
    const agent = agyAgent({ version: '1.4.2', work: toolWork(started, gate()) })
    const turn = agyTurn(agent)
    await started.opened
    turn.hold.steer(STEER)
    expect((await turn.result).text).toBe(`then ${STEER}`)
    expect(agent.cancels).toEqual(['native-1'])
    expect(agent.prompts).toEqual([{ text: 'work', whileRunning: false }, { text: STEER, whileRunning: false }])
    order(turn.events(), `drain:${STEER}`, 'mayCut:true', 'taken:drain-1', `accepted:${STEER}@drain-1`)
  })

})
