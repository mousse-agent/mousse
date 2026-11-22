/**
 * The ACP core's session lifecycle with an in-process agent (agent CLIs plan §3): steer restarts
 * the prompt, a native cancel that misses its deadline ends in a kill and a forgotten session, and
 * closing uses `session/close` only when the agent offers it.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION, RequestError, type AgentApp } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpSessions, type SavedAcpSession } from '../../src/mms/harness/acp/session'
import { NO_QUIRKS } from '../../src/mms/harness/acp/quirks'
import { interruptWithDeadline } from '../../src/mms/harness/supervise'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { inProcessAgent } from '../../src/mms/run/testkit/acpAgent'
import type { LlmModelOption } from '../../src/shared/settings'
import type { HarnessCaps } from '../../src/shared/harness/types'
import type { AdapterHost, TurnInput, TurnSink } from '../../src/mms/harness/adapter'
import { AcpAdapter } from '../../src/mms/harness/drivers/acp/adapter'
import { GENERIC_ACP_CAPS } from '../../src/mms/harness/acp/presets/generic'
import { GROK_CAPS } from '../../src/mms/harness/acp/presets/grok'
import { holdControl } from '../support/steerHoldControl'

const sessionsUnderTest: AcpSessions[] = []
const tempDirs: string[] = []
afterEach(() => {
  for (const sessions of sessionsUnderTest.splice(0)) sessions.stop()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface AgentScript {
  capabilities?: Record<string, unknown>
  /** What `session/new` answers besides the session id (default: one `model` select, fast and deep). */
  session?: Record<string, unknown>
  /** Slash commands the agent advertises (`available_commands_update`) when it opens a session. */
  commands?: string[]
  /** Runs one prompt; resolves with its stop reason. `blocks` is the text of every block of the prompt. */
  prompt?: (text: string, context: { notify: (text: string) => Promise<void>; update: (update: Record<string, unknown>) => Promise<void>; cancelled: Promise<void>; blocks: string[]; askPermission: () => Promise<unknown> }) => Promise<string>
}

const DEFAULT_SESSION = { configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fast', options: [{ value: 'fast', name: 'Fast' }, { value: 'deep', name: 'Deep' }] }] }

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
      .onRequest(methods.agent.session.new, async (c) => {
        calls.push({ method: 'session/new', params: c.params })
        if (script.commands) await c.client.notify(methods.client.session.update, { sessionId: 'native-1', update: { sessionUpdate: 'available_commands_update', availableCommands: script.commands.map((name) => ({ name, description: name })) } })
        return { sessionId: 'native-1', ...(script.session ?? DEFAULT_SESSION) } as never
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
        const blocks = c.params.prompt.map((block) => (block as { text?: string }).text ?? '')
        const stopReason = await (script.prompt ?? (async (prompt, ctx) => { await ctx.notify(`echo: ${prompt}`); return 'end_turn' }))(text, {
          notify,
          update: (update) => c.client.notify(methods.client.session.update, { sessionId: c.params.sessionId, update } as never),
          cancelled,
          blocks,
          askPermission: () => c.client.request(methods.client.session.requestPermission, {
            sessionId: c.params.sessionId,
            toolCall: { toolCallId: 'tool-1', title: 'Run the tool' },
            options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }]
          })
        })
        // An empty reason stands for an agent that sends no `stopReason` at all.
        return (stopReason ? { stopReason: stopReason as 'end_turn' } : {}) as { stopReason: 'end_turn' }
      })
      .onNotification(methods.agent.session.cancel, (c) => {
        cancels.push(c.params.sessionId)
        cancel?.()
      })
  })
  return { ...agentApp, calls, cancels }
}

function core(connect: ReturnType<typeof scriptedAgent>['connect'], options: { closeSessions?: boolean; cancelDeadlineMs?: number; promptSilenceMs?: number; clientFs?: boolean } = {}) {
  const saved = new Map<string, SavedAcpSession>()
  let models: LlmModelOption[] = []
  const questions = new UserQuestionService()
  const sessions = new AcpSessions({
    label: 'Fake agent',
    defaultInstanceId: 'acp:fake',
    questions,
    connect,
    quirks: { ...NO_QUIRKS, ...(options.clientFs ? { clientFs: true } : {}) },
    ...(options.closeSessions ? { closeSessions: true } : {}),
    ...(options.cancelDeadlineMs !== undefined ? { cancelDeadlineMs: options.cancelDeadlineMs } : {}),
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
  return { sessions, saved, questions, models: () => models }
}

describe('ACP sessions', () => {
  it('passes the role and task from an agy 1.5.13 subagent launch to the transcript', async () => {
    const rawInput = { Prompt: 'Compute the arithmetic 23 + 19 and report the result back to me.', Role: 'Arithmetic Solver', TypeName: 'self' }
    const launch = { toolCallId: 'call_1071222551326134974', name: 'invoke_subagent', args: rawInput, kind: 'other', title: 'Run invoke_subagent', rawInput }
    const agent = scriptedAgent({
      prompt: async (_text, ctx) => {
        await ctx.update({ ...launch, sessionUpdate: 'tool_call', status: 'in_progress' })
        await ctx.update({ ...launch, sessionUpdate: 'tool_call_update', status: 'completed' })
        return 'end_turn'
      }
    })
    const { sessions } = core(agent.connect)
    const onTool = vi.fn()
    await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'Delegate 23 + 19', onText: vi.fn(), onTool })
    expect(onTool).toHaveBeenNthCalledWith(1, expect.objectContaining({
      phase: 'start', callId: launch.toolCallId, toolName: 'invoke_subagent',
      activity: { kind: 'subagent', description: rawInput.Role, agentType: rawInput.TypeName, prompt: rawInput.Prompt }
    }))
    expect(onTool).toHaveBeenNthCalledWith(2, expect.objectContaining({ phase: 'complete', callId: launch.toolCallId, status: 'completed' }))
  })

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

  it("restarts the prompt with the steer's images as well as its text", async () => {
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
    let steer: { text: string; token: string; images: Array<{ name: string; mimeType: string; data: string }> } | undefined
    const text = sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'long task', onText: vi.fn(), onSteer: vi.fn(), drainSteerEntry: () => { const value = steer; steer = undefined; return value } })
    await vi.waitFor(() => expect(agent.calls.filter((call) => call.method === 'session/prompt')).toHaveLength(1))
    steer = { text: 'match this', token: 'drain-1', images: [{ name: 'shot.png', mimeType: 'image/png', data: 'AAAA' }] }
    expect(await text).toBe('working\n\nthen match this')
    const prompts = agent.calls.filter((call) => call.method === 'session/prompt').map((call) => (call.params as { prompt: unknown[] }).prompt)
    expect(prompts[0]).not.toContainEqual(expect.objectContaining({ type: 'image' }))
    expect(prompts[1]).toEqual([{ type: 'text', text: 'match this' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }])
  })

  it('ends an agent that ignores the cancel a steer sends, and fails the turn without replaying it', async () => {
    const agent = scriptedAgent({ prompt: async (_text, ctx) => { await ctx.notify('working'); return new Promise<string>(() => {}) } })
    const { sessions, saved } = core(agent.connect, { cancelDeadlineMs: 50 })
    let steer: string | undefined
    const turn = sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'long task', onText: vi.fn(), drainSteer: () => { const value = steer; steer = undefined; return value } })
    const failed = expect(turn).rejects.toThrow('did not stop for the new guidance')
    await vi.waitFor(() => expect(agent.calls.filter((call) => call.method === 'session/prompt')).toHaveLength(1))
    steer = 'focus on tests'
    await failed
    expect(agent.cancels).toEqual(['native-1'])
    expect(agent.connections[0].killed).toBe(true)
    expect(saved.has('t')).toBe(false)
    // The steer text was never sent as a prompt.
    expect(agent.calls.filter((call) => call.method === 'session/prompt')).toHaveLength(1)
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

  describe('how a prompt ends (stopReason)', () => {
    const chat = (sessions: AcpSessions, onText = vi.fn()) => sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'work', onText })

    it.each(['end_turn', '', 'a_future_reason'])('a prompt that ends with %j is a finished turn', async (reason) => {
      const agent = scriptedAgent({ prompt: async (_text, ctx) => { await ctx.notify('done'); return reason } })
      const { sessions } = core(agent.connect)
      expect(await chat(sessions)).toBe('done')
    })

    it.each([
      ['refusal', 'acp_refusal', 'Fake agent refused this request.'],
      ['max_tokens', 'acp_incomplete_reply', 'Fake agent stopped before it finished (it reached its token limit).'],
      ['max_turn_requests', 'acp_incomplete_reply', 'Fake agent stopped before it finished (it reached its limit of model requests).']
    ])('%s fails the turn with a typed error and keeps what was written', async (reason, code, message) => {
      const agent = scriptedAgent({ prompt: async (_text, ctx) => { await ctx.notify('part'); return reason } })
      const { sessions, saved } = core(agent.connect)
      const onText = vi.fn()
      await expect(chat(sessions, onText)).rejects.toMatchObject({ code, message })
      expect(onText).toHaveBeenLastCalledWith('part')
      // A turn that did not finish is never resumable.
      expect(saved.get('t')?.historyKey).toBeUndefined()
    })

    it('a provider refusal the agent answers the prompt with shows its status and message, credentials removed', async () => {
      const agent = scriptedAgent({ prompt: async () => { throw RequestError.internalError(undefined, 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"model: claude-x not found for key sk-ant-api03-abcdefghijklmnop"}}') } })
      const { sessions } = core(agent.connect)
      const error = await chat(sessions).catch((caught: unknown) => caught)
      expect(error).toMatchObject({ code: 'provider_api_error', message: '400 · model: claude-x not found for key [redacted]', errorInfo: { category: 'invalid' } })
    })

    it('an agent error with its text in data shows that text; a sign-in error still asks for a sign-in', async () => {
      const agent = scriptedAgent({ prompt: async () => { throw RequestError.internalError({ details: '[API Error: got status: 429 Too Many Requests. {"error":{"message":"Resource has been exhausted (e.g. check quota)."}}]' }) } })
      const { sessions } = core(agent.connect)
      await expect(chat(sessions)).rejects.toMatchObject({ code: 'provider_api_error', message: '429 · Resource has been exhausted (e.g. check quota).' })
      const signIn = scriptedAgent({ prompt: async () => { throw RequestError.authRequired() } })
      const second = core(signIn.connect)
      await expect(chat(second.sessions)).rejects.not.toMatchObject({ code: 'provider_api_error' })
    })

    it('cancelled, when nobody asked for a cancel, ends the turn as interrupted, not as a reply', async () => {
      const agent = scriptedAgent({ prompt: async (_text, ctx) => { await ctx.notify('half'); return 'cancelled' } })
      const { sessions } = core(agent.connect)
      await expect(chat(sessions)).rejects.toMatchObject({ name: 'AbortError' })
    })

    it('cancelled after Mousse answered a permission request cancelled (dismissed) is a finished turn with the agent’s message', async () => {
      const agent = scriptedAgent({
        prompt: async (_text, ctx) => {
          await ctx.askPermission()
          await ctx.notify('Understood, I will not run it.')
          return 'cancelled'
        }
      })
      const { sessions } = core(agent.connect)
      const prompter = { choose: async () => undefined }
      expect(await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'run it', onText: vi.fn(), prompter })).toBe('Understood, I will not run it.')
    })

    it('cancelled after Mousse sent a cancel (a steer) is the steer restarting the prompt, not an interruption', async () => {
      const agent = scriptedAgent({
        prompt: async (text, ctx) => {
          if (text === 'work') { await ctx.cancelled; return 'cancelled' }
          await ctx.notify('steered')
          return 'end_turn'
        }
      })
      const { sessions } = core(agent.connect)
      let steer: string | undefined
      const turn = sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'work', onText: vi.fn(), drainSteer: () => { const value = steer; steer = undefined; return value } })
      await vi.waitFor(() => expect(agent.calls.some((call) => call.method === 'session/prompt')).toBe(true))
      steer = 'go left'
      expect(await turn).toBe('steered')
    })
  })

  describe('a prompt the agent never answers', () => {
    it('fails the turn with a retryable timeout, ends the process and forgets the session', async () => {
      const agent = scriptedAgent({ prompt: async () => new Promise<string>(() => {}) })
      const { sessions, saved } = core(agent.connect, { promptSilenceMs: 100 })
      const startedAt = Date.now()
      await expect(sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'hello?', onText: vi.fn() })).rejects.toMatchObject({
        code: 'timeout',
        errorInfo: { category: 'timeout', retryable: true },
        message: expect.stringContaining('Fake agent did not answer')
      })
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90)
      expect(agent.calls.filter((call) => call.method === 'session/prompt')).toHaveLength(1)
      expect(agent.connections[0].killed).toBe(true)
      expect(saved.get('t')?.historyKey).toBeUndefined()
    })

    it('counts any update as a sign of life, so a slow agent that keeps reporting is left alone', async () => {
      const agent = scriptedAgent({
        prompt: async (_text, ctx) => {
          for (let step = 0; step < 6; step += 1) {
            await new Promise((resolve) => setTimeout(resolve, 40))
            await ctx.notify(`step ${step} `)
          }
          return 'end_turn'
        }
      })
      const { sessions } = core(agent.connect, { promptSilenceMs: 120 })
      expect(await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'slow', onText: vi.fn() })).toContain('step 5')
      expect(agent.connections[0].killed).toBe(false)
    })

    it('does not count the time the agent waits for the user to answer a permission request', async () => {
      const agent = scriptedAgent({
        prompt: async (_text, ctx) => {
          await ctx.askPermission()
          await ctx.notify('allowed')
          return 'end_turn'
        }
      })
      const { sessions } = core(agent.connect, { promptSilenceMs: 100 })
      const prompter = { choose: async () => { await new Promise((resolve) => setTimeout(resolve, 350)); return 'allow' } }
      expect(await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'ask me', onText: vi.fn(), prompter })).toBe('allowed')
    })

    it('does not count the time one of Mousse’s own tools waits for the user (ask_user, plans, approvals), then counts again once it is answered', async () => {
      let release: (() => void) | undefined
      const agent = scriptedAgent({
        prompt: async () => {
          await new Promise<void>((resolve) => { release = resolve })
          // After the answer the agent goes quiet for good.
          return new Promise<string>(() => {})
        }
      })
      const { sessions, questions } = core(agent.connect, { promptSilenceMs: 100 })
      const turn = sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'plan it', onText: vi.fn() })
      const outcome = turn.then(() => 'finished', (error: { code?: string }) => error.code)
      await vi.waitFor(() => expect(release).toBeDefined())
      // The same call the Mousse MCP server makes for `ask_user`: through the thread's questions, not the ACP connection.
      const asked = questions.requestAnswers([{ id: 'q', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }], 't', { timeoutMs: 5_000 })
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(agent.connections[0].killed).toBe(false)
      const [pending] = questions.listPendingForThread('t')
      questions.submitAnswers(pending!.requestId, { q: 'a' })
      await asked
      const answeredAt = Date.now()
      expect(await outcome).toBe('timeout')
      expect(Date.now() - answeredAt).toBeGreaterThanOrEqual(80)
    })

    it('does not run while no prompt is in flight, and a Stop still ends the turn at once', async () => {
      const agent = scriptedAgent({ prompt: async () => new Promise<string>(() => {}) })
      const { sessions } = core(agent.connect, { promptSilenceMs: 5_000 })
      const stop = new AbortController()
      const turn = sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'hello?', onText: vi.fn(), signal: stop.signal })
      const failed = expect(turn).rejects.toBeDefined()
      await vi.waitFor(() => expect(agent.calls.some((call) => call.method === 'session/prompt')).toBe(true))
      stop.abort()
      await failed
      expect(agent.connections[0].killed).toBe(true)
    })
  })

  describe('model options', () => {
    it('lists the first `model` select, keeps its empty default value, and sets models through that select', async () => {
      const agent = scriptedAgent({
        session: {
          configOptions: [
            { id: 'mode_hint', name: 'Hint', category: 'other', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A' }] },
            { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: '', options: [{ value: '', name: 'Agent default' }, { value: 'fast', name: 'Fast' }, { value: 'deep', name: 'Deep' }] },
            { id: 'reasoning_model', name: 'Reasoning model', category: 'model', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }
          ]
        }
      })
      const { sessions, models } = core(agent.connect)
      await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'deep', prompt: 'hi', onText: vi.fn() })
      expect(models()).toEqual([{ id: '', label: 'Agent default' }, { id: 'fast', label: 'Fast' }, { id: 'deep', label: 'Deep' }])
      expect(agent.calls.filter((call) => call.method === 'session/set_config_option').map((call) => call.params)).toEqual([expect.objectContaining({ configId: 'model', value: 'deep' })])
    })

    it('falls back to a select named `model` when none has the model category, and to the agent default when there is none', async () => {
      const named = scriptedAgent({ session: { configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'fast', options: [{ value: 'fast', name: 'Fast' }] }] } })
      const first = core(named.connect)
      await first.sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'hi', onText: vi.fn() })
      expect(first.models()).toEqual([{ id: 'fast', label: 'Fast' }])
      const none = scriptedAgent({ session: { configOptions: [] } })
      const second = core(none.connect)
      await second.sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'hi', onText: vi.fn() })
      expect(second.models()).toEqual([])
      await expect(second.sessions.chat({ threadId: 'u', cwd: process.cwd(), model: 'deep', prompt: 'hi', onText: vi.fn() })).rejects.toThrow('offers no model choice')
    })
  })

  describe('slash commands', () => {
    const history = 'user: hello\nassistant: hi there'
    /** Answers "expanded" only when the agent could parse the command: block 0 is exactly the command and the history is block 1. */
    const discriminating = (command: string) => scriptedAgent({
      prompt: async (_text, ctx) => {
        const [first, second] = ctx.blocks
        await ctx.notify(first === command && second?.startsWith('Previous conversation') ? 'expanded' : 'literal')
        return 'end_turn'
      }
    })
    const promptBlocks = (agent: ReturnType<typeof scriptedAgent>) => agent.calls.filter((call) => call.method === 'session/prompt').map((call) => (call.params as { prompt: Array<{ text: string }> }).prompt.map((block) => block.text))

    it('sends the command alone as the first block, the handed-over history as the second, and drops the orchestration block', async () => {
      const agent = discriminating('/review src/main.ts')
      const { sessions } = core(agent.connect)
      const text = await sessions.chat({
        threadId: 't', cwd: process.cwd(), model: 'default', prompt: '/review src/main.ts', history, onText: vi.fn(),
        turnPreamble: 'Mousse tools: ask', orchestrationInstructions: 'You are the orchestrator'
      })
      expect(text).toBe('expanded')
      const [blocks] = promptBlocks(agent)
      expect(blocks).toHaveLength(2)
      expect(blocks[0]).toBe('/review src/main.ts')
      expect(blocks[1]).toBe(`Previous conversation (context only; do not repeat earlier actions):\n${history}\n\nCurrent request:\nMousse tools: ask\n\nCurrent request:\n`)
      expect(blocks.join('')).not.toContain('mousse_orchestration_instructions')
    })

    it('sends a command with nothing to add as a single block', async () => {
      const agent = scriptedAgent({})
      const { sessions } = core(agent.connect)
      await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: '  /compact  ', onText: vi.fn() })
      expect(promptBlocks(agent)).toEqual([['/compact']])
    })

    it('still gives the session instructions to the next turn that is not a command', async () => {
      const agent = scriptedAgent({})
      const { sessions } = core(agent.connect)
      const base = { threadId: 't', cwd: process.cwd(), model: 'default', onText: vi.fn(), orchestrationInstructions: 'You are the orchestrator' }
      await sessions.chat({ ...base, prompt: '/review' })
      sessions.commitConversation('t', '')
      await sessions.chat({ ...base, prompt: 'now explain' })
      const [first, second] = promptBlocks(agent)
      expect(first).toEqual(['/review'])
      expect(second).toHaveLength(1)
      expect(second[0]).toContain('<mousse_orchestration_instructions>')
      expect(second[0]).toContain('now explain')
    })

    it.each(['/tmp/x notes', '/etc/hosts', '/Users/me/app.ts', 'please run /review', '/ review', '/1st thing', '//comment'])('%j is text, not a command', async (prompt) => {
      const agent = scriptedAgent({})
      const { sessions } = core(agent.connect)
      await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt, history, onText: vi.fn(), orchestrationInstructions: 'RULES' })
      const [blocks] = promptBlocks(agent)
      expect(blocks).toHaveLength(1)
      expect(blocks[0]).toContain('Previous conversation')
      expect(blocks[0]).toContain('RULES')
      expect(blocks[0].endsWith(prompt)).toBe(true)
    })

    it.each(['/review', '/review src', '/review\nsrc', '/mcp:tool-name x', '/Plan'])('%j is a command', async (prompt) => {
      const agent = scriptedAgent({})
      const { sessions } = core(agent.connect)
      await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt, history, onText: vi.fn() })
      expect(promptBlocks(agent)[0][0]).toBe(prompt)
    })

    it('goes by the commands the agent advertised when it advertised any', async () => {
      const agent = scriptedAgent({ commands: ['review', 'compact'] })
      const { sessions } = core(agent.connect)
      const base = { cwd: process.cwd(), model: 'default', history, onText: vi.fn() }
      await sessions.chat({ ...base, threadId: 'a', prompt: '/review src' })
      await sessions.chat({ ...base, threadId: 'b', prompt: '/tmp is full, what can I delete?' })
      await sessions.chat({ ...base, threadId: 'c', prompt: '/home' })
      await sessions.chat({ ...base, threadId: 'd', prompt: '/unknown thing' })
      const [review, tmp, home, unknown] = promptBlocks(agent)
      expect(review[0]).toBe('/review src')
      expect(review).toHaveLength(2)
      for (const blocks of [tmp, home, unknown]) {
        expect(blocks).toHaveLength(1)
        expect(blocks[0]).toContain('Previous conversation')
      }
    })

    it('never treats a steer as a command: the restarted prompt is the steer text alone', async () => {
      const agent = scriptedAgent({
        prompt: async (text, ctx) => {
          if (text.endsWith('long task')) { await ctx.cancelled; return 'cancelled' }
          return 'end_turn'
        }
      })
      const { sessions } = core(agent.connect)
      let steer: string | undefined
      const turn = sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'long task', history, onText: vi.fn(), drainSteer: () => { const value = steer; steer = undefined; return value } })
      await vi.waitFor(() => expect(agent.calls.filter((call) => call.method === 'session/prompt')).toHaveLength(1))
      steer = '/clear please'
      await turn
      expect(promptBlocks(agent)[1]).toEqual(['/clear please'])
    })
  })

  describe('an agent that ignores a cancel sent soon after the prompt', () => {
    it('is ended at the cancel deadline, its session is forgotten, and the next turn starts a new session with the history', async () => {
      const promptedAt: number[] = []
      const agent = scriptedAgent({
        prompt: async (_text, ctx) => {
          promptedAt.push(Date.now())
          // The first prompt drops the cancel it gets within a second of starting and never ends.
          if (promptedAt.length === 1) return new Promise<string>(() => {})
          await ctx.notify('back')
          return 'end_turn'
        }
      })
      const { sessions, saved } = core(agent.connect)
      let sessionId: string | undefined
      const turn = sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'work', onText: vi.fn(), onSession: (id) => { sessionId = id } })
      const failed = expect(turn).rejects.toBeDefined()
      await vi.waitFor(() => expect(promptedAt).toHaveLength(1))
      const result = await interruptWithDeadline({
        interrupt: () => sessions.interrupt(sessionId),
        terminate: () => sessions.terminate(sessionId),
        forgetConversation: (threadId) => sessions.forgetConversation(threadId)
      }, { provider: '', instanceId: 'acp:fake', sessionId }, { threadId: 't', deadlineMs: 50 })
      expect(result).toBe('interrupted')
      expect(Date.now() - promptedAt[0]).toBeLessThan(1_000)
      await failed
      expect(agent.connections[0].killed).toBe(true)
      expect(saved.has('t')).toBe(false)
      // The next turn does not reopen the ended session: a new process, a new session, the history in the prompt.
      agent.calls.length = 0
      expect(await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'again', history: 'user: work', onText: vi.fn() })).toBe('back')
      expect(agent.connections).toHaveLength(2)
      expect(agent.calls.map((call) => call.method)).toEqual(['initialize', 'session/new', 'session/prompt'])
      expect((agent.calls[2].params as { prompt: Array<{ text: string }> }).prompt[0].text).toContain('Previous conversation')
    })
  })

  describe("the hold: a person's steer cuts in at once; an agent's steer waits for a running tool (docs/design/steer-and-interruptions.md §2.7)", () => {
    const STEER = 'Use pnpm, not npm'
    const gate = () => {
      let open!: () => void
      const opened = new Promise<void>((resolve) => { open = resolve })
      return { opened, open }
    }
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    const toolCall = (id: string, title = 'npm test') => ({ sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'execute', status: 'in_progress' })
    const toolDone = (id: string) => ({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' })

    /** A turn through the ACP adapter and the real session core, on the hold. */
    function holdTurn(agent: ReturnType<typeof scriptedAgent>, caps: HarnessCaps = GENERIC_ACP_CAPS, options: { signal?: AbortSignal } = {}) {
      const { sessions, questions } = core(agent.connect)
      // As in the orchestrator: a question pending in the thread means the turn waits for a person.
      const hold = holdControl(caps, { questions: { pending: () => questions.listPendingForThread('t').length > 0 } })
      const prompts = () => agent.calls.filter((call) => call.method === 'session/prompt').map((call) => (call.params as { prompt: Array<{ text: string }> }).prompt[0].text)
      // What the agent had been sent when each steer was saved as read.
      const promptsWhenAccepted: string[][] = []
      const sink = hold.wrap({
        text: () => {},
        thinking: () => {},
        tool: () => {},
        progress: () => {},
        providerRef: () => {},
        usage: () => {},
        steerAccepted: () => void promptsWhenAccepted.push(prompts())
      } as unknown as TurnSink)
      const adapter = new AcpAdapter(() => ({ chat: (input) => sessions.chat(input), commitConversation: () => {}, configured: () => true }), { driver: 'acp', label: 'Fake agent', capabilities: caps })
      const input = { threadId: 't', instanceId: 'acp:fake', llmProvider: '', model: 'default', mode: 'agent', prompt: 'work', cwd: process.cwd(), signal: options.signal ?? new AbortController().signal } as unknown as TurnInput
      const result = adapter.startTurn(input, sink, hold.ctl, { context: { nativeHistoryAfterTurn: (text: string) => text } } as unknown as AdapterHost)
      const events = () => hold.log.map(([event, detail]) => `${event}:${detail}`)
      return { hold, sink, result, prompts, promptsWhenAccepted, events, questions }
    }
    /** Each step happens, in this order (each found after the one before). */
    const order = (events: string[], ...steps: string[]) => {
      let from = 0
      for (const step of steps) {
        const at = events.indexOf(step, from)
        expect(at, `${step} after ${JSON.stringify(events.slice(0, from))} in ${JSON.stringify(events)}`).toBeGreaterThanOrEqual(0)
        from = at + 1
      }
    }

    it('strict boundary drain: an agent\'s steer held during a tool goes in as the next prompt when the prompt ends, and nothing is cancelled', async () => {
      const toolStarted = gate()
      const finishTool = gate()
      const endPrompt = gate()
      const agent = scriptedAgent({
        prompt: async (text, ctx) => {
          if (text !== 'work') {
            await ctx.notify(`then ${text}`)
            return 'end_turn'
          }
          await ctx.update(toolCall('call-1'))
          toolStarted.open()
          await finishTool.opened
          await ctx.update(toolDone('call-1'))
          await ctx.notify('All 12 passed.')
          await endPrompt.opened
          return 'end_turn'
        }
      })
      const turn = holdTurn(agent)
      await toolStarted.opened
      turn.hold.steer(STEER, { person: false })
      await vi.waitFor(() => expect(turn.hold.held()).toBe(true))
      finishTool.open()
      // The tool ended and the agent wrote: an agent whose gaps were never measured still holds (strict release).
      await vi.waitFor(() => expect(turn.events()).toContain('text:All 12 passed.'))
      await sleep(300)
      expect(turn.hold.held()).toBe(true)
      expect(turn.hold.drained()).toEqual([])
      endPrompt.open()
      expect((await turn.result).text).toBe('All 12 passed.\n\nthen Use pnpm, not npm')
      expect(agent.cancels).toEqual([])
      expect(turn.prompts()).toEqual(['work', STEER])
      order(turn.events(), 'tool:complete:call-1', 'boundary:', `drain:${STEER}`, 'providerTurn:', 'taken:drain-1', `accepted:${STEER}@drain-1`)
      expect(turn.events().filter((event) => event.startsWith('mayCut'))).toEqual([])
      // Read only once the prompt that carries it reached the agent.
      expect(turn.promptsWhenAccepted).toEqual([['work', STEER]])
    })

    it('a steer while the agent writes cuts at once, and is read only once the prompt that carries it reached the agent', async () => {
      const agent = scriptedAgent({
        prompt: async (text, ctx) => {
          if (text !== 'work') {
            await ctx.notify(`then ${text}`)
            return 'end_turn'
          }
          await ctx.notify('working')
          await ctx.cancelled
          return 'cancelled'
        }
      })
      const turn = holdTurn(agent)
      await vi.waitFor(() => expect(turn.events()).toContain('text:working'))
      turn.hold.steer(STEER)
      expect((await turn.result).text).toBe('working\n\nthen Use pnpm, not npm')
      expect(agent.cancels).toEqual(['native-1'])
      order(turn.events(), `drain:${STEER}`, 'mayCut:true', 'taken:drain-1', `accepted:${STEER}@drain-1`)
      expect(turn.promptsWhenAccepted).toEqual([['work', STEER]])
    })

    it('a tool that starts between the drain and the cancel keeps an agent\'s steer: it is handed back, held, and goes in at the boundary', async () => {
      const endPrompt = gate()
      const agent = scriptedAgent({
        prompt: async (text, ctx) => {
          if (text !== 'work') {
            await ctx.notify(`then ${text}`)
            return 'end_turn'
          }
          await ctx.notify('working')
          await endPrompt.opened
          return 'end_turn'
        }
      })
      const turn = holdTurn(agent)
      await vi.waitFor(() => expect(turn.events()).toContain('text:working'))
      // The tool's start arrives while the cut is on its way.
      turn.hold.beforeMayCut = () => turn.sink.tool({ kind: 'mcp_tool_call', phase: 'start', callId: 'late', title: 'npm test', summary: '', details: [] })
      turn.hold.steer(STEER, { person: false })
      await vi.waitFor(() => expect(turn.events()).toContain(`returned:${STEER}`))
      await vi.waitFor(() => expect(turn.hold.held()).toBe(true))
      turn.sink.tool({ kind: 'mcp_tool_result', phase: 'complete', callId: 'late', title: 'npm test', summary: '', details: [] })
      endPrompt.open()
      await turn.result
      expect(agent.cancels).toEqual([])
      order(turn.events(), 'mayCut:false', `returned:${STEER}`, 'boundary:', `drain:${STEER}`)
      expect(turn.events().filter((event) => event.startsWith('accepted:'))).toEqual([`accepted:${STEER}@drain-2`])
    })

    it('a person\'s steer during a tool cancels at once, holds nothing, and the turn goes on with it as the next prompt, once', async () => {
      const toolStarted = gate()
      const agent = scriptedAgent({
        prompt: async (text, ctx) => {
          if (text !== 'work') {
            await ctx.notify(`then ${text}`)
            return 'end_turn'
          }
          // The tool never ends by itself: only the cut ends the prompt.
          await ctx.update(toolCall('call-1', 'sleep 20'))
          toolStarted.open()
          await ctx.cancelled
          return 'cancelled'
        }
      })
      const turn = holdTurn(agent)
      await toolStarted.opened
      turn.hold.steer(STEER)
      expect((await turn.result).text).toBe('then Use pnpm, not npm')
      expect(turn.hold.held()).toBe(false)
      expect(agent.cancels).toEqual(['native-1'])
      expect(turn.prompts()).toEqual(['work', STEER])
      order(turn.events(), 'tool:start:call-1', `drain:${STEER}`, 'mayCut:true', 'taken:drain-1', `accepted:${STEER}@drain-1`)
      expect(turn.events().filter((event) => event.startsWith('accepted:'))).toEqual([`accepted:${STEER}@drain-1`])
    })

    it('a steer whose re-prompt fails is handed back, never read', async () => {
      const agent = scriptedAgent({
        prompt: async (text, ctx) => {
          if (text !== 'work') throw new Error('agent crashed')
          await ctx.notify('working')
          await ctx.cancelled
          return 'cancelled'
        }
      })
      const turn = holdTurn(agent)
      await vi.waitFor(() => expect(turn.events()).toContain('text:working'))
      turn.hold.steer(STEER)
      await expect(turn.result).rejects.toThrow()
      expect(turn.events().filter((event) => event.startsWith('returned:'))).toEqual([`returned:${STEER}`])
      expect(turn.events().filter((event) => event.startsWith('accepted:') || event.startsWith('taken:'))).toEqual([])
    })

    it('a call waiting for a person\'s permission does not hold: the steer cuts and answers it', async () => {
      const asking = gate()
      const agent = scriptedAgent({
        prompt: async (text, ctx) => {
          if (text !== 'work') {
            await ctx.notify(`then ${text}`)
            return 'end_turn'
          }
          await ctx.update(toolCall('tool-1', 'Run the tool'))
          asking.open()
          // The steer settles the ask as the person's answer.
          await ctx.askPermission().catch(() => undefined)
          return 'cancelled'
        }
      })
      const turn = holdTurn(agent)
      await asking.opened
      await vi.waitFor(() => expect(turn.events()).toContain('awaiting:tool-1:true'))
      turn.hold.steer(STEER)
      await turn.result
      expect(agent.cancels).toEqual(['native-1'])
      order(turn.events(), 'awaiting:tool-1:true', `drain:${STEER}`, 'awaiting:tool-1:false')
    })

    it('strict release: an agent\'s steer already held for a tool does not wait for a person\'s answer to the next call: it cuts and answers it', async () => {
      const toolStarted = gate()
      const finishTool = gate()
      const agent = scriptedAgent({
        prompt: async (text, ctx) => {
          if (text !== 'work') {
            await ctx.notify(`then ${text}`)
            return 'end_turn'
          }
          await ctx.update(toolCall('call-1'))
          toolStarted.open()
          await finishTool.opened
          await ctx.update(toolDone('call-1'))
          await ctx.update(toolCall('tool-1', 'Run the tool'))
          await ctx.askPermission().catch(() => undefined)
          return 'cancelled'
        }
      })
      const turn = holdTurn(agent)
      await toolStarted.opened
      turn.hold.steer(STEER, { person: false })
      await vi.waitFor(() => expect(turn.hold.held()).toBe(true))
      finishTool.open()
      await turn.result
      expect(agent.cancels).toEqual(['native-1'])
      order(turn.events(), 'tool:complete:call-1', 'awaiting:tool-1:true', `drain:${STEER}`, `accepted:${STEER}@drain-1`)
    })

    it('Grok, with its measured window: an agent\'s steer goes in about 100 ms after the tool\'s result when the agent shows nothing', async () => {
      const toolStarted = gate()
      const finishTool = gate()
      const agent = scriptedAgent({
        prompt: async (text, ctx) => {
          if (text !== 'work') {
            await ctx.notify(`then ${text}`)
            return 'end_turn'
          }
          await ctx.update(toolCall('call-1'))
          toolStarted.open()
          await finishTool.opened
          await ctx.update(toolDone('call-1'))
          await ctx.cancelled
          return 'cancelled'
        }
      })
      const turn = holdTurn(agent, GROK_CAPS)
      await toolStarted.opened
      turn.hold.steer(STEER, { person: false })
      await vi.waitFor(() => expect(turn.hold.held()).toBe(true))
      finishTool.open()
      await turn.result
      expect(agent.cancels).toEqual(['native-1'])
      expect(turn.hold.at('drain')! - turn.hold.at('tool', 'complete:call-1')!).toBeGreaterThanOrEqual(100 - 10)
      expect(turn.events().filter((event) => event.startsWith('accepted:'))).toEqual([`accepted:${STEER}@drain-1`])
    })

    it('Grok\'s subagent call is never waited on: a steer while only the subagent runs cuts', async () => {
      const subagentStarted = gate()
      const agent = scriptedAgent({
        prompt: async (text, ctx) => {
          if (text !== 'work') {
            await ctx.notify(`then ${text}`)
            return 'end_turn'
          }
          await ctx.update({ sessionUpdate: 'tool_call', toolCallId: 'sub-1', title: 'research', name: 'start_subagent', status: 'in_progress' })
          subagentStarted.open()
          await ctx.cancelled
          return 'cancelled'
        }
      })
      const turn = holdTurn(agent, GROK_CAPS)
      await subagentStarted.opened
      turn.hold.steer(STEER)
      await turn.result
      expect(agent.cancels).toEqual(['native-1'])
      expect(turn.events().filter((event) => event.startsWith('accepted:'))).toEqual([`accepted:${STEER}@drain-1`])
    })

    it('Grok: a subagent reporting progress does not keep an agent\'s steer held after the turn\'s own tool ends', async () => {
      const toolStarted = gate()
      const finishTool = gate()
      const agent = scriptedAgent({
        prompt: async (text, ctx) => {
          if (text !== 'work') {
            await ctx.notify(`then ${text}`)
            return 'end_turn'
          }
          await ctx.update({ sessionUpdate: 'tool_call', toolCallId: 'sub-1', title: 'research', name: 'start_subagent', status: 'in_progress' })
          await ctx.update(toolCall('call-1'))
          toolStarted.open()
          await finishTool.opened
          await ctx.update(toolDone('call-1'))
          // The subagent reports progress every 40 ms for a second, longer than Grok's 100 ms window many times over.
          let cancelled = false
          void ctx.cancelled.then(() => { cancelled = true })
          for (let tick = 0; tick < 25 && !cancelled; tick++) {
            await ctx.update({ sessionUpdate: 'tool_call_update', toolCallId: 'sub-1', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: `step ${tick}` } }] })
            await sleep(40)
          }
          await ctx.cancelled
          return 'cancelled'
        }
      })
      const turn = holdTurn(agent, GROK_CAPS)
      await toolStarted.opened
      turn.hold.steer(STEER, { person: false })
      await vi.waitFor(() => expect(turn.hold.held()).toBe(true))
      finishTool.open()
      await turn.result
      expect(agent.cancels).toEqual(['native-1'])
      // About Grok's window after the tool's result, never the subagent's second of progress.
      expect(turn.hold.at('drain')! - turn.hold.at('tool', 'complete:call-1')!).toBeLessThan(500)
      expect(turn.events().filter((event) => event.startsWith('accepted:'))).toEqual([`accepted:${STEER}@drain-1`])
    })

    describe.each([
      ['as Claude Code names MCP calls', 'mcp__mousse__ask_user'],
      ['as some agents title them', 'ask_user (mousse MCP Server)'],
      ['a relayed tool waiting for its approval, named with capitals', 'mousse-relay/github__createIssue']
    ])("Mousse's ask_user over MCP (%s): the steer cuts and answers it, on an agent whose window was never measured (strict)", (_name, title) => {
      const asks = (held: boolean) => {
        const toolStarted = gate()
        const finishTool = gate()
        const asking = gate()
        const agent = scriptedAgent({
          prompt: async (text, ctx) => {
            if (text !== 'work') {
              await ctx.notify(`then ${text}`)
              return 'end_turn'
            }
            if (held) {
              await ctx.update(toolCall('call-1'))
              toolStarted.open()
              await finishTool.opened
              await ctx.update(toolDone('call-1'))
            }
            await ctx.update({ sessionUpdate: 'tool_call', toolCallId: 'ask-1', title, kind: 'other', status: 'in_progress' })
            asking.open()
            await ctx.cancelled
            return 'cancelled'
          }
        })
        return { agent, toolStarted, finishTool, asking }
      }
      const ask = (questions: UserQuestionService) => {
        const answer = questions.requestAnswers([{ id: 'q', prompt: 'Which package manager?', options: [{ id: 'npm', label: 'npm' }, { id: 'skip', label: 'Skip' }] }], 't')
        answer.catch(() => undefined)
        return answer
      }

      it('an agent\'s steer held for a tool goes in once Mousse asks the person', async () => {
        const script = asks(true)
        const turn = holdTurn(script.agent)
        await script.toolStarted.opened
        turn.hold.steer(STEER, { person: false })
        await vi.waitFor(() => expect(turn.hold.held()).toBe(true))
        script.finishTool.open()
        await script.asking.opened
        const answer = ask(turn.questions)
        expect((await turn.result).text).toBe('then Use pnpm, not npm')
        expect(script.agent.cancels).toEqual(['native-1'])
        await expect(answer).resolves.toEqual({ q: 'skip' })
        expect(turn.events().filter((event) => event.startsWith('accepted:'))).toEqual([`accepted:${STEER}@drain-1`])
      })

      it('a steer while Mousse asks the person goes in at once', async () => {
        const script = asks(false)
        const turn = holdTurn(script.agent)
        await script.asking.opened
        await vi.waitFor(() => expect(turn.events()).toContain('tool:start:ask-1'))
        const answer = ask(turn.questions)
        turn.hold.steer(STEER)
        await turn.result
        expect(script.agent.cancels).toEqual(['native-1'])
        await expect(answer).resolves.toEqual({ q: 'skip' })
        // Not after the 1 s window an unmeasured agent waits after a tool.
        expect(turn.hold.at('drain')! - turn.hold.at('tool', 'start:ask-1')!).toBeLessThan(800)
      })
    })

    it.each(['mousse/docs', 'Mousse.md'])('a call titled %s is no Mousse question: it holds an agent\'s steer while a question is pending, like any call', async (title) => {
      const toolStarted = gate()
      const finishTool = gate()
      const agent = scriptedAgent({
        prompt: async (text, ctx) => {
          if (text !== 'work') {
            await ctx.notify(`then ${text}`)
            return 'end_turn'
          }
          await ctx.update(toolCall('docs-1', title))
          toolStarted.open()
          await finishTool.opened
          await ctx.update(toolDone('docs-1'))
          await ctx.notify('read it')
          return 'end_turn'
        }
      })
      const turn = holdTurn(agent)
      await toolStarted.opened
      const answer = turn.questions.requestAnswers([{ id: 'q', prompt: 'Which one?', options: [{ id: 'a', label: 'A' }] }], 't')
      answer.catch(() => undefined)
      turn.hold.steer(STEER, { person: false })
      await vi.waitFor(() => expect(turn.hold.held()).toBe(true))
      await sleep(300)
      expect(turn.hold.drained()).toEqual([])
      expect(turn.hold.heldSteer()).toMatchObject({ tools: 1 })
      turn.questions.dismissAllForThread('t')
      finishTool.open()
      await turn.result
      expect(agent.cancels).toEqual([])
      expect(turn.prompts()).toEqual(['work', STEER])
    })

    it('strict release with a tool the agent never reports complete: an agent\'s steer is never cut in, and stays for the follow-up', async () => {
      const toolStarted = gate()
      const endPrompt = gate()
      const agent = scriptedAgent({
        prompt: async (_text, ctx) => {
          await ctx.update(toolCall('call-1'))
          toolStarted.open()
          await ctx.notify('done, I think')
          await endPrompt.opened
          return 'end_turn'
        }
      })
      const turn = holdTurn(agent)
      await toolStarted.opened
      turn.hold.steer(STEER, { person: false })
      await vi.waitFor(() => expect(turn.hold.held()).toBe(true))
      endPrompt.open()
      expect((await turn.result).text).toBe('done, I think')
      expect(agent.cancels).toEqual([])
      expect(turn.prompts()).toEqual(['work'])
      // Never drained: the queue still has it, so it runs once as the next turn.
      expect(turn.hold.drained()).toEqual([])
      expect(turn.hold.pendingTexts()).toEqual([STEER])
      expect(turn.events()).toContain('tool:complete:call-1')
    })
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

  describe('requests from an idle agent outside a turn', () => {
    it('cancels unsolicited permission requests without asking, closes the idle process, forgets the session, and runs the next turn cleanly in Full access', async () => {
      let idleClient: { request: (method: string, params: unknown) => Promise<unknown> } | undefined
      let turn = 0
      let inTurnAnswer: unknown
      const agent = inProcessAgent((app: AgentApp) => {
        app
          .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }))
          .onRequest(methods.agent.session.new, () => ({ sessionId: `native-${turn + 1}`, ...DEFAULT_SESSION }) as never)
          .onRequest(methods.agent.session.prompt, async (c) => {
            turn += 1
            if (turn === 1) {
              idleClient = c.client as unknown as { request: (method: string, params: unknown) => Promise<unknown> }
              return { stopReason: 'end_turn' as const }
            }
            inTurnAnswer = await c.client.request(methods.client.session.requestPermission, {
              sessionId: c.params.sessionId,
              toolCall: { toolCallId: 'tool-turn-2', title: 'Run tests', kind: 'execute' },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
              ]
            })
            return { stopReason: 'end_turn' as const }
          })
      })
      const { sessions, saved, questions } = core(agent.connect)
      const pending = vi.fn()
      questions.on('pending', pending)

      await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', permissionMode: 'full', prompt: 'start background work', onText: vi.fn() })
      sessions.commitConversation('t', 'history-1')
      expect(saved.get('t')?.sessionId).toBe('native-1')

      // After Turn 1 completes, the idle process wakes up on its own and fires permission requests outside any turn.
      const outOfTurnExecute = await idleClient!.request(methods.client.session.requestPermission, {
        sessionId: 'native-1',
        toolCall: { toolCallId: 'rogue-1', title: 'Run git status', kind: 'execute' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
        ]
      })
      expect(outOfTurnExecute).toEqual({ outcome: { outcome: 'cancelled' } })
      expect(pending).not.toHaveBeenCalled()
      expect(questions.listPendingForThread('t')).toEqual([])
      expect(saved.get('t')).toBeUndefined()
      await vi.waitFor(() => expect(agent.connections[0].killed).toBe(true))

      // The next turn opens a clean process with Full access and auto-allows without prompting.
      await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', permissionMode: 'full', history: 'history-1', prompt: 'continue', onText: vi.fn() })
      expect(agent.connections).toHaveLength(2)
      expect(inTurnAnswer).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
      expect(pending).not.toHaveBeenCalled()
    })

    it('rejects client file reads and writes outside a turn without prompting or touching disk', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mousse-acp-idle-fs-'))
      tempDirs.push(dir)
      writeFileSync(join(dir, 'existing.txt'), 'secret-data', 'utf8')
      let idleClient: { request: (method: string, params: unknown) => Promise<unknown> } | undefined
      const agent = inProcessAgent((app: AgentApp) => {
        app
          .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }))
          .onRequest(methods.agent.session.new, () => ({ sessionId: 'native-fs', ...DEFAULT_SESSION }) as never)
          .onRequest(methods.agent.session.prompt, async (c) => {
            idleClient = c.client as unknown as { request: (method: string, params: unknown) => Promise<unknown> }
            return { stopReason: 'end_turn' as const }
          })
      })
      const { sessions, questions } = core(agent.connect, { clientFs: true })
      const pending = vi.fn()
      questions.on('pending', pending)

      await sessions.chat({ threadId: 't', cwd: dir, model: 'default', permissionMode: 'full', prompt: 'turn 1', onText: vi.fn() })
      await expect(idleClient!.request(methods.client.fs.readTextFile, { sessionId: 'native-fs', path: join(dir, 'existing.txt') })).rejects.toThrow(/outside a turn/i)
      await vi.waitFor(() => expect(agent.connections[0].killed).toBe(true))

      await sessions.chat({ threadId: 't', cwd: dir, model: 'default', permissionMode: 'full', prompt: 'turn 2', onText: vi.fn() })
      await expect(idleClient!.request(methods.client.fs.writeTextFile, { sessionId: 'native-fs', path: join(dir, 'rogue.txt'), content: 'bad' })).rejects.toThrow(/outside a turn/i)
      expect(existsSync(join(dir, 'rogue.txt'))).toBe(false)
      expect(pending).not.toHaveBeenCalled()
      expect(questions.listPendingForThread('t')).toEqual([])
      await vi.waitFor(() => expect(agent.connections[1].killed).toBe(true))
    })

    it('still reuses an idle session and auto-allows in-turn requests on a normal follow-up turn', async () => {
      let inTurnAnswer: unknown
      const agent = scriptedAgent({
        prompt: async (text, ctx) => {
          if (text === 'second') inTurnAnswer = await ctx.askPermission()
          return 'end_turn'
        }
      })
      const { sessions, questions } = core(agent.connect)
      const pending = vi.fn()
      questions.on('pending', pending)

      await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', permissionMode: 'full', prompt: 'first', onText: vi.fn() })
      sessions.commitConversation('t', 'h')
      await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', permissionMode: 'full', history: 'h', prompt: 'second', onText: vi.fn() })

      expect(agent.connections).toHaveLength(1)
      expect(agent.connections[0].killed).toBe(false)
      expect(inTurnAnswer).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
      expect(pending).not.toHaveBeenCalled()
    })
  })
})
