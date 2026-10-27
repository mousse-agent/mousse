/**
 * xAI's ACP extensions on the session core (agent CLIs plan §1 Grok rows): a prompt ends at its
 * `prompt_complete` when that comes before (or instead of) the reply, Grok's questions reach the
 * thread, a plan-exit request never blocks a turn, and a stopped prompt's process is ended so the
 * next turn reopens the session on a new one (never "task already running").
 */
import { methods, PROTOCOL_VERSION, type AgentApp } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GROK_PRESET } from '../../src/mms/harness/acp/presets/grok'
import { AcpSessions, type SavedAcpSession } from '../../src/mms/harness/acp/session'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { inProcessAgent } from '../../src/mms/run/testkit/acpAgent'

const sessionsUnderTest: AcpSessions[] = []
afterEach(() => {
  for (const sessions of sessionsUnderTest.splice(0)) sessions.stop()
})

type Prompt = (c: { params: { sessionId: string; prompt: Array<{ text?: string }>; _meta?: Record<string, unknown> }; client: { request: (method: string, params: unknown) => Promise<unknown>; notify: (method: string, params: unknown) => Promise<void> } }, cancelled: Promise<void>) => Promise<{ stopReason: string }>

function grokAgent(prompt: Prompt) {
  const calls: Array<{ method: string; params: unknown }> = []
  const agent = inProcessAgent((app: AgentApp) => {
    let cancel: (() => void) | undefined
    app
      .onRequest(methods.agent.initialize, (c) => {
        calls.push({ method: 'initialize', params: c.params })
        return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false, sessionCapabilities: { resume: {} } }, authMethods: [] }
      })
      .onRequest(methods.agent.session.new, () => ({ sessionId: 'grok-1' }))
      .onRequest(methods.agent.session.resume, (c) => {
        calls.push({ method: 'session/resume', params: c.params })
        return {}
      })
      .onRequest(methods.agent.session.prompt, async (c) => {
        calls.push({ method: 'session/prompt', params: c.params })
        const cancelled = new Promise<void>((resolve) => { cancel = resolve })
        return (await prompt(c as never, cancelled)) as never
      })
      .onNotification(methods.agent.session.cancel, () => cancel?.())
  })
  return { ...agent, calls }
}

function core(connect: ReturnType<typeof grokAgent>['connect'], questions = new UserQuestionService(), options: { cancelDeadlineMs?: number } = {}) {
  const saved = new Map<string, SavedAcpSession>()
  const sessions = new AcpSessions({
    label: 'Grok',
    defaultInstanceId: 'grok:work',
    questions,
    connect,
    quirks: GROK_PRESET.quirks,
    classifyOption: GROK_PRESET.classifyOption!,
    initializeMeta: GROK_PRESET.initializeMeta!,
    store: {
      saved: (threadId) => saved.get(threadId),
      setSaved: (threadId, value) => (value ? saved.set(threadId, value) : saved.delete(threadId)),
      models: () => [],
      setModels: () => {}
    },
    launchGeneration: () => 0,
    signInGeneration: () => 0,
    markSignedOut: vi.fn(),
    signInRequiredMessage: 'Sign in first',
    ...options
  })
  sessionsUnderTest.push(sessions)
  return { sessions, saved, questions }
}

const text = (sessionId: string, value: string) => ({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } } })

describe('Grok sessions', () => {
  it('tells Grok it is an extension client and tags each prompt', async () => {
    const agent = grokAgent(async () => ({ stopReason: 'end_turn' }))
    const { sessions } = core(agent.connect)
    await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'hi', onText: vi.fn() })
    expect(agent.calls.find((call) => call.method === 'initialize')?.params).toMatchObject({ _meta: { clientType: 'extension' } })
    expect(agent.calls.find((call) => call.method === 'session/prompt')?.params).toMatchObject({ _meta: { promptId: expect.any(String) } })
  })

  it.each(['_x.ai/session/prompt_complete', 'x.ai/session/prompt_complete'])('ends the turn at %s when it comes before the reply', async (method) => {
    const agent = grokAgent(async (c) => {
      await c.client.notify(methods.client.session.update, text(c.params.sessionId, 'done'))
      await c.client.notify(method, { sessionId: c.params.sessionId, promptId: c.params._meta?.promptId, stopReason: 'end_turn' })
      // The reply never comes.
      return new Promise(() => {})
    })
    const { sessions } = core(agent.connect)
    expect(await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'hi', onText: vi.fn() })).toBe('done')
  })

  it('ends a later prompt at its own completion when an earlier prompt’s completion arrives late', async () => {
    const ids: string[] = []
    const agent = grokAgent(async (c) => {
      const id = String(c.params._meta?.promptId)
      ids.push(id)
      // The first prompt ends by its reply only; its completion arrives during the next prompt,
      // which then ends by its completion only.
      if (ids.length === 1) return { stopReason: 'end_turn' }
      await c.client.notify('_x.ai/session/prompt_complete', { sessionId: c.params.sessionId, promptId: ids[0], stopReason: 'end_turn' })
      await c.client.notify(methods.client.session.update, text(c.params.sessionId, 'second'))
      await c.client.notify('_x.ai/session/prompt_complete', { sessionId: c.params.sessionId, promptId: id, stopReason: 'end_turn' })
      return new Promise(() => {})
    })
    const { sessions } = core(agent.connect)
    await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'one', onText: vi.fn() })
    sessions.commitConversation('t', 'h')
    expect(await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'two', history: 'h', onText: vi.fn() })).toBe('second')
    expect(agent.connections).toHaveLength(1)
    // No waiter outlives its prompt.
    const live = (sessions as unknown as { sessions: Map<string, { promptWaiters?: Map<string, unknown> }> }).sessions.get('t')
    expect(live?.promptWaiters?.size ?? 0).toBe(0)
  })

  it('after a steer, sends the guidance only once the cancelled prompt reports its end', async () => {
    const order: string[] = []
    let first: string | undefined
    const agent = grokAgent(async (c, cancelled) => {
      const id = String(c.params._meta?.promptId)
      order.push(`prompt ${c.params.prompt[0]?.text}`)
      if (!first) {
        first = id
        await cancelled
        // The reply comes at once; the task itself ends a little later.
        setTimeout(() => {
          order.push('first complete')
          void c.client.notify('_x.ai/session/prompt_complete', { sessionId: c.params.sessionId, promptId: id, stopReason: 'cancelled' })
        }, 30)
        return { stopReason: 'cancelled' }
      }
      return { stopReason: 'end_turn' }
    })
    const { sessions } = core(agent.connect)
    let steer: string | undefined
    const turn = sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'long task', onText: vi.fn(), drainSteer: () => { const value = steer; steer = undefined; return value } })
    await vi.waitFor(() => expect(order).toEqual(['prompt long task']))
    steer = 'focus on tests'
    await turn
    expect(order).toEqual(['prompt long task', 'first complete', 'prompt focus on tests'])
  })

  it.each([
    [{ stopReason: 'refusal' }, /refused/],
    [{ stopReason: 'end_turn', error: { message: 'rate limit reached' } }, /rate limit reached/],
    [{ stopReason: 'end_turn', agentResult: { error: 'quota exceeded' } }, /quota exceeded/]
  ])('keeps a failure the completion reports (%o)', async (completion, message) => {
    const agent = grokAgent(async (c) => {
      await c.client.notify('_x.ai/session/prompt_complete', { sessionId: c.params.sessionId, promptId: c.params._meta?.promptId, ...completion })
      return new Promise(() => {})
    })
    const { sessions } = core(agent.connect)
    await expect(sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'hi', onText: vi.fn() })).rejects.toThrow(message)
  })

  describe.each([['the reply', false], ['the completion', true]])('a prompt that ends by %s with a limit or a cancel', (_name, byCompletion) => {
    const ending = (stopReason: string): Prompt => async (c) => {
      await c.client.notify(methods.client.session.update, text(c.params.sessionId, 'partial'))
      if (!byCompletion) return { stopReason }
      await c.client.notify('_x.ai/session/prompt_complete', { sessionId: c.params.sessionId, promptId: c.params._meta?.promptId, stopReason })
      return new Promise(() => {})
    }

    it.each([['max_tokens', 'acp_incomplete_reply'], ['max_turn_requests', 'acp_incomplete_reply']])('%s fails the turn', async (reason, code) => {
      const { sessions } = core(grokAgent(ending(reason)).connect)
      await expect(sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'hi', onText: vi.fn() })).rejects.toMatchObject({ code })
    })

    it('cancelled, when nobody asked for a cancel, interrupts the turn', async () => {
      const { sessions } = core(grokAgent(ending('cancelled')).connect)
      await expect(sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'hi', onText: vi.fn() })).rejects.toMatchObject({ name: 'AbortError' })
    })

    it('end_turn is still a finished turn', async () => {
      const { sessions } = core(grokAgent(ending('end_turn')).connect)
      expect(await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'hi', onText: vi.fn() })).toBe('partial')
    })
  })

  it('keeps a refusal the reply reports', async () => {
    const agent = grokAgent(async () => ({ stopReason: 'refusal' }))
    const { sessions } = core(agent.connect)
    await expect(sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'hi', onText: vi.fn() })).rejects.toThrow(/refused/)
  })

  it('ignores the completion of another prompt', async () => {
    let reply: (() => void) | undefined
    const agent = grokAgent(async (c) => {
      await c.client.notify('_x.ai/session/prompt_complete', { sessionId: c.params.sessionId, promptId: 'someone-else' })
      await c.client.notify(methods.client.session.update, text(c.params.sessionId, 'still going'))
      await new Promise<void>((resolve) => { reply = resolve })
      return { stopReason: 'end_turn' }
    })
    const { sessions } = core(agent.connect)
    let settled = false
    const turn = sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'hi', onText: vi.fn() }).finally(() => { settled = true })
    await vi.waitFor(() => expect(reply).toBeDefined())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    reply!()
    expect(await turn).toBe('still going')
  })

  it('asks Grok’s questions in the thread and answers with the labels picked', async () => {
    let answer: unknown
    const agent = grokAgent(async (c) => {
      answer = await c.client.request('_x.ai/ask_user_question', {
        method: 'x.ai/ask_user_question',
        params: { sessionId: c.params.sessionId, toolCallId: 'q1', questions: [{ question: 'Strict or loose?', multiSelect: null, options: [{ label: 'Strict' }, { label: 'Loose' }] }] }
      })
      return { stopReason: 'end_turn' }
    })
    const questions = new UserQuestionService()
    const { sessions } = core(agent.connect, questions)
    const turn = sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'hi', onText: vi.fn() })
    await vi.waitFor(() => expect(questions.listPendingForThread('t')).toHaveLength(1))
    const [pending] = questions.listPendingForThread('t')
    expect(pending!.questions[0]).toMatchObject({ prompt: 'Strict or loose?', options: [{ label: 'Strict' }, { label: 'Loose' }] })
    questions.submitAnswers(pending!.requestId, { [pending!.questions[0]!.id]: pending!.questions[0]!.options[0]!.id })
    await turn
    expect(answer).toEqual({ outcome: 'accepted', answers: { 'Strict or loose?': ['Strict'] } })
  })

  it('answers a plan-exit request as abandoned, so it never blocks the turn', async () => {
    let answer: unknown
    const agent = grokAgent(async (c) => {
      answer = await c.client.request('x.ai/exit_plan_mode', { sessionId: c.params.sessionId, plan: '1. do it' })
      return { stopReason: 'end_turn' }
    })
    const { sessions } = core(agent.connect)
    await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'hi', onText: vi.fn() })
    expect(answer).toEqual({ outcome: 'abandoned' })
  })

  it('ends the process after a stop, so the next turn reopens the session on a new one', async () => {
    let prompts = 0
    const agent = grokAgent(async (c, cancelled) => {
      if ((prompts += 1) > 1) return { stopReason: 'end_turn' }
      await c.client.notify(methods.client.session.update, text(c.params.sessionId, 'working'))
      await cancelled
      return { stopReason: 'cancelled' }
    })
    const { sessions } = core(agent.connect)
    let sessionId: string | undefined
    const turn = sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'long', history: '', onText: vi.fn(), onSession: (id) => { sessionId = id } })
    await vi.waitFor(() => expect(sessionId).toBe('grok-1'))
    await vi.waitFor(() => expect(agent.calls.filter((call) => call.method === 'session/prompt')).toHaveLength(1))
    expect(await sessions.interrupt('grok-1')).toBe('interrupted')
    await turn
    expect(agent.connections[0]!.killed).toBe(true)
    sessions.commitConversation('t', 'h')
    await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'again', history: 'h', onText: vi.fn() })
    expect(agent.connections).toHaveLength(2)
    expect(agent.calls.filter((call) => call.method === 'session/resume')).toHaveLength(1)
  })
})
