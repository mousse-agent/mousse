/**
 * The ACP core's session lifecycle with an in-process agent (agent CLIs plan §3): steer restarts
 * the prompt, a native cancel that misses its deadline ends in a kill and a forgotten session, and
 * closing uses `session/close` only when the agent offers it.
 */
import { methods, PROTOCOL_VERSION, type AgentApp } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpSessions, type SavedAcpSession } from '../../src/mms/harness/acp/session'
import { NO_QUIRKS } from '../../src/mms/harness/acp/quirks'
import { interruptWithDeadline } from '../../src/mms/harness/supervise'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { inProcessAgent } from '../../src/mms/run/testkit/acpAgent'
import type { LlmModelOption } from '../../src/shared/settings'

const sessionsUnderTest: AcpSessions[] = []
afterEach(() => {
  for (const sessions of sessionsUnderTest.splice(0)) sessions.stop()
})

interface AgentScript {
  capabilities?: Record<string, unknown>
  /** Runs one prompt; resolves with its stop reason. */
  prompt?: (text: string, context: { notify: (text: string) => Promise<void>; cancelled: Promise<void> }) => Promise<string>
}

function scriptedAgent(script: AgentScript) {
  const calls: Array<{ method: string; params: unknown }> = []
  const cancels: string[] = []
  const agentApp = inProcessAgent((app: AgentApp) => {
    let cancel: (() => void) | undefined
    app
      .onRequest(methods.agent.initialize, (c) => {
        calls.push({ method: 'initialize', params: c.params })
        return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: script.capabilities ?? {}, authMethods: [] }
      })
      .onRequest(methods.agent.session.new, (c) => {
        calls.push({ method: 'session/new', params: c.params })
        return { sessionId: 'native-1', configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fast', options: [{ value: 'fast', name: 'Fast' }, { value: 'deep', name: 'Deep' }] }] }
      })
      .onRequest(methods.agent.session.setConfigOption, (c) => {
        calls.push({ method: 'session/set_config_option', params: c.params })
        return { configOptions: [] }
      })
      .onRequest(methods.agent.session.close, (c) => {
        calls.push({ method: 'session/close', params: c.params })
        return {}
      })
      .onRequest(methods.agent.session.prompt, async (c) => {
        const text = (c.params.prompt[0] as { text: string }).text
        calls.push({ method: 'session/prompt', params: c.params })
        const cancelled = new Promise<void>((resolve) => { cancel = resolve })
        const notify = (chunk: string) => c.client.notify(methods.client.session.update, { sessionId: c.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } } })
        const stopReason = await (script.prompt ?? (async (prompt, ctx) => { await ctx.notify(`echo: ${prompt}`); return 'end_turn' }))(text, { notify, cancelled })
        return { stopReason: stopReason as 'end_turn' }
      })
      .onNotification(methods.agent.session.cancel, (c) => {
        cancels.push(c.params.sessionId)
        cancel?.()
      })
  })
  return { ...agentApp, calls, cancels }
}

function core(connect: ReturnType<typeof scriptedAgent>['connect'], options: { closeSessions?: boolean } = {}) {
  const saved = new Map<string, SavedAcpSession>()
  let models: LlmModelOption[] = []
  const sessions = new AcpSessions({
    label: 'Fake agent',
    defaultInstanceId: 'acp:fake',
    questions: new UserQuestionService(),
    connect,
    quirks: NO_QUIRKS,
    ...(options.closeSessions ? { closeSessions: true } : {}),
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
  return { sessions, saved, models: () => models }
}

describe('ACP sessions', () => {
  it('lists the session’s models, sets the chosen one, and runs the agent default without setting one', async () => {
    const agent = scriptedAgent({})
    const { sessions, models } = core(agent.connect)
    expect(await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'deep', prompt: 'hi', onText: vi.fn() })).toBe('echo: hi')
    expect(models()).toEqual([{ id: 'fast', label: 'Fast' }, { id: 'deep', label: 'Deep' }])
    expect(agent.calls.find((call) => call.method === 'session/set_config_option')?.params).toMatchObject({ configId: 'model', value: 'deep' })
    expect(agent.calls.find((call) => call.method === 'initialize')?.params).toMatchObject({ clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
    agent.calls.length = 0
    sessions.commitConversation('t', 'h')
    await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'again', history: 'h', onText: vi.fn() })
    expect(agent.calls.map((call) => call.method)).toEqual(['session/prompt'])
  })

  it('restarts the prompt with the steer text after cancelling it', async () => {
    const agent = scriptedAgent({
      prompt: async (text, ctx) => {
        if (text === 'long task') {
          await ctx.notify('working')
          await ctx.cancelled
          return 'cancelled'
        }
        await ctx.notify(`then ${text}`)
        return 'end_turn'
      }
    })
    const { sessions } = core(agent.connect)
    let steer: string | undefined
    const onSteer = vi.fn()
    const text = sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'long task', onText: vi.fn(), onSteer, drainSteer: () => { const value = steer; steer = undefined; return value } })
    await vi.waitFor(() => expect(agent.calls.filter((call) => call.method === 'session/prompt')).toHaveLength(1))
    steer = 'focus on tests'
    expect(await text).toBe('working\n\nthen focus on tests')
    expect(onSteer).toHaveBeenCalledExactlyOnceWith('focus on tests')
    expect(agent.cancels).toEqual(['native-1'])
  })

  it('cancels natively, and when the cancel misses its deadline kills the process and forgets the session', async () => {
    const agent = scriptedAgent({ prompt: async () => new Promise<string>(() => {}) })
    const { sessions, saved } = core(agent.connect)
    let sessionId: string | undefined
    const turn = sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'stuck', onText: vi.fn(), onSession: (id) => { sessionId = id } })
    const failed = expect(turn).rejects.toThrow()
    await vi.waitFor(() => expect(agent.calls.some((call) => call.method === 'session/prompt')).toBe(true))
    expect(saved.has('t')).toBe(true)
    const result = await interruptWithDeadline({
      interrupt: () => sessions.interrupt(sessionId),
      terminate: () => sessions.terminate(sessionId),
      forgetConversation: (threadId) => sessions.forgetConversation(threadId)
    }, { provider: '', instanceId: 'acp:fake', sessionId }, { threadId: 't', deadlineMs: 50 })
    expect(result).toBe('interrupted')
    expect(agent.cancels).toEqual(['native-1'])
    expect(agent.connections[0].killed).toBe(true)
    expect(saved.has('t')).toBe(false)
    await failed
  })

  it('a cancel the agent honours ends the prompt without a kill', async () => {
    const agent = scriptedAgent({ prompt: async (_text, ctx) => { await ctx.cancelled; return 'cancelled' } })
    const { sessions } = core(agent.connect)
    let sessionId: string | undefined
    const turn = sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'stop me', onText: vi.fn(), onSession: (id) => { sessionId = id } })
    await vi.waitFor(() => expect(agent.calls.some((call) => call.method === 'session/prompt')).toBe(true))
    expect(await sessions.interrupt(sessionId)).toBe('interrupted')
    await turn
    expect(agent.connections[0].killed).toBe(false)
    expect(await sessions.interrupt(sessionId)).toBe('not_active')
  })

  it.each([
    ['offers it', { sessionCapabilities: { close: {} } }, ['session/close']],
    ['does not offer it', {}, []]
  ])('closes a session with session/close only when the agent %s, then ends the process', async (_name, capabilities, expected) => {
    const agent = scriptedAgent({ capabilities })
    const { sessions } = core(agent.connect, { closeSessions: true })
    await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'hi', onText: vi.fn() })
    sessions.closeIdle()
    await vi.waitFor(() => expect(agent.connections[0].killed).toBe(true))
    expect(agent.calls.filter((call) => call.method === 'session/close').map((call) => call.method)).toEqual(expected)
  })
})
