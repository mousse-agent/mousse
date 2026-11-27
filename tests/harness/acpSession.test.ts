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
import { AcpSessions, readAcpPromptUsage, type AcpTurnUsage, type SavedAcpSession } from '../../src/mms/harness/acp/session'
import { mergeModelOptions, modelOptions } from '../../src/mms/harness/acp/models'
import { NO_QUIRKS } from '../../src/mms/harness/acp/quirks'
import { interruptWithDeadline } from '../../src/mms/harness/supervise'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { inProcessAgent } from '../../src/mms/run/testkit/acpAgent'
import type { LlmModelOption } from '../../src/shared/settings'
import type { HarnessCaps } from '../../src/shared/harness/types'
import type { AdapterHost, TurnInput, TurnSink } from '../../src/mms/harness/adapter'
import type { ContinuationInfo, ProviderTaskEnd } from '../../src/mms/harness/driver'
import { AcpAdapter } from '../../src/mms/harness/drivers/acp/adapter'
import { BACKGROUND_SUMMARY } from '../../src/shared/agentActivity'
import { GENERIC_ACP_CAPS } from '../../src/mms/harness/acp/presets/generic'
import { GROK_CAPS } from '../../src/mms/harness/acp/presets/grok'
import { holdControl } from '../support/steerHoldControl'
import { transcriptSink } from '../support/transcriptSink'

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
  /** Runs one prompt; resolves with its stop reason or full prompt response. `blocks` is the text of every block of the prompt. */
  prompt?: (text: string, context: { notify: (text: string) => Promise<void>; update: (update: Record<string, unknown>) => Promise<void>; cancelled: Promise<void>; blocks: string[]; askPermission: () => Promise<unknown> }) => Promise<string | { stopReason?: string; usage?: Record<string, unknown> }>
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
        const result = await (script.prompt ?? (async (prompt, ctx) => { await ctx.notify(`echo: ${prompt}`); return 'end_turn' }))(text, {
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
        if (typeof result === 'object') return result as { stopReason: 'end_turn' }
        // An empty reason stands for an agent that sends no `stopReason` at all.
        return (result ? { stopReason: result as 'end_turn' } : {}) as { stopReason: 'end_turn' }
      })
      .onNotification(methods.agent.session.cancel, (c) => {
        cancels.push(c.params.sessionId)
        cancel?.()
      })
  })
  return { ...agentApp, calls, cancels }
}

function core(connect: ReturnType<typeof scriptedAgent>['connect'], options: { closeSessions?: boolean; cancelDeadlineMs?: number; promptSilenceMs?: number; clientFs?: boolean; formElicitation?: boolean; backgroundWork?: boolean; continuationSettleMs?: number; continuationQuietMs?: number; wakeGraceMs?: number; idleCloseMs?: number; delegateIdleCloseMs?: number; maxIdleSessions?: number } = {}) {
  const saved = new Map<string, SavedAcpSession>()
  let models: LlmModelOption[] = []
  const questions = new UserQuestionService()
  const sessions = new AcpSessions({
    label: 'Fake agent',
    defaultInstanceId: 'acp:fake',
    questions,
    connect,
    quirks: { ...NO_QUIRKS, ...(options.clientFs ? { clientFs: true } : {}), ...(options.backgroundWork ? { backgroundWork: true } : {}) },
    ...(options.formElicitation ? { formElicitation: true } : {}),
    ...(options.closeSessions ? { closeSessions: true } : {}),
    ...(options.cancelDeadlineMs !== undefined ? { cancelDeadlineMs: options.cancelDeadlineMs } : {}),
    ...(options.promptSilenceMs !== undefined ? { promptSilenceMs: options.promptSilenceMs } : {}),
    ...(options.continuationSettleMs !== undefined ? { continuationSettleMs: options.continuationSettleMs } : {}),
    ...(options.continuationQuietMs !== undefined ? { continuationQuietMs: options.continuationQuietMs } : {}),
    ...(options.wakeGraceMs !== undefined ? { wakeGraceMs: options.wakeGraceMs } : {}),
    ...(options.idleCloseMs !== undefined ? { idleCloseMs: options.idleCloseMs } : {}),
    ...(options.delegateIdleCloseMs !== undefined ? { delegateIdleCloseMs: options.delegateIdleCloseMs } : {}),
    ...(options.maxIdleSessions !== undefined ? { maxIdleSessions: options.maxIdleSessions } : {}),
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

  it('records Antigravity mcp_mousse_delegate_task and mcp_mousse_thread_send tool calls with their subagent ids', async () => {
    const delegateIn = { title: 'GitHub researcher', prompt: 'Research GitHub', workspace: 'shared' }
    const delegateOut = { delegationId: 'd-gh', childThreadId: 't-gh', title: 'GitHub researcher' }
    const sendOut = { delegationId: 'd-gh-2', threadId: 't-gh', title: 'GitHub researcher', subagent: true }
    const agent = scriptedAgent({
      prompt: async (_text, ctx) => {
        await ctx.update({ sessionUpdate: 'tool_call', toolCallId: 'c-del', name: 'mcp_mousse_delegate_task', title: 'Run mcp_mousse_delegate_task', rawInput: delegateIn, status: 'in_progress' })
        await ctx.update({ sessionUpdate: 'tool_call_update', toolCallId: 'c-del', status: 'completed', rawOutput: { content: [{ type: 'text', text: JSON.stringify(delegateOut) }] } })
        await ctx.update({ sessionUpdate: 'tool_call', toolCallId: 'c-send', name: 'mcp_mousse_thread_send', title: 'Run mcp_mousse_thread_send', rawInput: { threadId: 't-gh', message: 'follow up' }, status: 'in_progress' })
        await ctx.update({ sessionUpdate: 'tool_call_update', toolCallId: 'c-send', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: JSON.stringify(sendOut) } }] })
        return 'end_turn'
      }
    })
    const { sessions } = core(agent.connect)
    const onTool = vi.fn()
    await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'Start researcher', onText: vi.fn(), onTool })
    expect(onTool).toHaveBeenNthCalledWith(1, expect.objectContaining({
      phase: 'start',
      callId: 'c-del',
      toolName: 'mcp_mousse_delegate_task',
      record: { input: { recordVersion: 1, title: 'GitHub researcher' }, failed: false }
    }))
    expect(onTool).toHaveBeenNthCalledWith(2, expect.objectContaining({
      phase: 'complete',
      callId: 'c-del',
      toolName: 'mcp_mousse_delegate_task',
      status: 'completed',
      record: { input: { recordVersion: 1, title: 'GitHub researcher' }, response: JSON.stringify(delegateOut), failed: false }
    }))
    expect(onTool).toHaveBeenNthCalledWith(4, expect.objectContaining({
      phase: 'complete',
      callId: 'c-send',
      toolName: 'mcp_mousse_thread_send',
      status: 'completed',
      activity: { output: JSON.stringify(sendOut) }
    }))
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

  describe('PromptResponse.usage reporting', () => {
    it.each([
      [
        'agy 1.5.13 payload with cached read and thought tokens',
        { stopReason: 'end_turn', usage: { inputTokens: 2145, outputTokens: 20, cachedReadTokens: 8752, cachedWriteTokens: 0, thoughtTokens: 18, totalTokens: 10917 } },
        { input: 2145, output: 20, cacheRead: 8752, cacheWrite: 0, reasoning: 18, totalTokens: 10917, hasOutput: true }
      ],
      [
        'payload without totalTokens sums reported token fields',
        { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 25, cachedReadTokens: 50 } },
        { input: 100, output: 25, cacheRead: 50, cacheWrite: 0, totalTokens: 175, hasOutput: true }
      ],
      [
        'payload with only totalTokens marks output unavailable so speed stays unset',
        { stopReason: 'end_turn', usage: { totalTokens: 500 } },
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 500, hasOutput: false }
      ],
      ['response without usage', { stopReason: 'end_turn' }, undefined],
      ['null usage', { stopReason: 'end_turn', usage: null }, undefined],
      ['empty or negative usage fields', { stopReason: 'end_turn', usage: { inputTokens: -1, outputTokens: Number.NaN } }, undefined]
    ])('readAcpPromptUsage handles %s', (_label, outcome, expected) => {
      expect(readAcpPromptUsage(outcome)).toEqual(expected)
    })

    it('sums PromptResponse.usage across multiple prompts in one steered turn', async () => {
      let promptCount = 0
      const agent = scriptedAgent({
        prompt: async (prompt, ctx) => {
          promptCount += 1
          await ctx.notify(`reply ${promptCount}: ${prompt}`)
          if (promptCount === 1) {
            return {
              stopReason: 'end_turn',
              usage: { inputTokens: 10801, outputTokens: 20, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 18, totalTokens: 10821 }
            }
          }
          return {
            stopReason: 'end_turn',
            usage: { inputTokens: 2145, outputTokens: 30, cachedReadTokens: 8752, cachedWriteTokens: 0, thoughtTokens: 12, totalTokens: 10927 }
          }
        }
      })
      const { sessions } = core(agent.connect)
      let drained = false
      const reported: AcpTurnUsage[] = []
      await sessions.chat({
        threadId: 't',
        cwd: process.cwd(),
        model: 'default',
        prompt: 'first',
        onText: vi.fn(),
        onBoundary: () => {
          // Make the boundary steer available right after the first prompt finishes.
        },
        drainSteer: () => {
          if (promptCount === 1 && !drained) {
            drained = true
            return 'follow-up'
          }
          return undefined
        },
        onUsage: (usage) => reported.push(usage)
      })
      expect(promptCount).toBe(2)
      expect(reported).toEqual([
        { input: 12946, output: 50, cacheRead: 8752, cacheWrite: 0, reasoning: 30, totalTokens: 21748, hasOutput: true }
      ])
    })
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

  describe('Antigravity background work and reactive continuations', () => {
    it('tracks a backgrounded run_command after end_turn, updates its row on completion, runs the reactive wakeup under the continuation turn permissionMode, and clears backgroundWork', async () => {
      let agentClient: {
        notify: (method: string, params: unknown) => Promise<void>
        request: (method: string, params: unknown) => Promise<unknown>
      } | undefined
      const agent = inProcessAgent((app: AgentApp) => {
        app
          .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }))
          .onRequest(methods.agent.session.new, () => ({ sessionId: 'agy-bg-1', ...DEFAULT_SESSION }) as never)
          .onRequest(methods.agent.session.prompt, async (c) => {
            agentClient = c.client as unknown as typeof agentClient
            await c.client.notify(methods.client.session.update, {
              sessionId: 'agy-bg-1',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'cmd-1',
                name: 'run_command',
                title: 'Run verify',
                status: 'in_progress',
                rawInput: { CommandLine: 'node scripts/verify.mjs', WaitMsBeforeAsync: 500 }
              }
            } as never)
            await c.client.notify(methods.client.session.update, {
              sessionId: 'agy-bg-1',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Verification is running in the background...' } }
            })
            await c.client.notify(methods.client.session.update, {
              sessionId: 'agy-bg-1',
              update: { sessionUpdate: 'usage_update', size: 100000, used: 1000 } as never
            })
            return { stopReason: 'end_turn' as const }
          })
      })
      const formReceived = vi.fn()
      const { sessions, questions } = core((launch) => {
        const elicit = launch.handlers.createElicitation!
        return agent.connect({
          ...launch,
          handlers: {
            ...launch.handlers,
            createElicitation: (request) => {
              const reply = elicit(request)
              formReceived()
              return reply
            }
          }
        })
      }, { backgroundWork: true, formElicitation: true, continuationSettleMs: 30, wakeGraceMs: 500 })
      const bgStates: Array<[string, boolean]> = []
      const endedTasks: Array<[string, ProviderTaskEnd]> = []
      const continuations: Array<[string, ContinuationInfo]> = []
      sessions.setLiveHost({
        backgroundWork: (threadId, active) => bgStates.push([threadId, active]),
        taskEnded: (threadId, info) => endedTasks.push([threadId, info]),
        continuationStarted: (threadId, info) => continuations.push([threadId, info])
      })

      const turn1Tools: Array<Record<string, unknown>> = []
      const turn1Text = await sessions.chat({
        threadId: 't-bg',
        cwd: process.cwd(),
        model: 'default',
        permissionMode: 'full',
        prompt: 'run verify',
        onText: vi.fn(),
        onTool: (e) => turn1Tools.push(e as unknown as Record<string, unknown>)
      })
      sessions.commitConversation('t-bg', 'h-1')
      expect(turn1Text).toBe('Verification is running in the background...')
      expect(turn1Tools).toEqual([
        expect.objectContaining({ phase: 'start', callId: 'cmd-1', toolName: 'run_command', activity: { kind: 'command', command: 'node scripts/verify.mjs' } }),
        expect.objectContaining({ phase: 'complete', callId: 'cmd-1', toolName: 'run_command', status: 'background' })
      ])
      expect(bgStates).toEqual([['t-bg', true]])

      // Background command finishes out-of-turn: taskEnded updates the row while backgroundWork stays true during grace.
      await agentClient!.notify(methods.client.session.update, {
        sessionId: 'agy-bg-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'cmd-1',
          status: 'completed',
          rawOutput: { output: 'All 42 checks passed' }
        }
      })
      await vi.waitFor(() => expect(endedTasks).toHaveLength(1))
      expect(endedTasks[0]).toEqual(['t-bg', expect.objectContaining({ toolUseId: 'cmd-1', taskId: 'cmd-1', status: 'completed', summary: 'All 42 checks passed' })])
      expect(bgStates).toEqual([['t-bg', true]])

      // Reactive wakeup arrives: thought + follow-up tool + permission request BEFORE chat({ continuation: true }) attaches!
      await agentClient!.notify(methods.client.session.update, {
        sessionId: 'agy-bg-1',
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Verify passed, opening PR.' } }
      })
      await vi.waitFor(() => expect(continuations).toHaveLength(1))
      const contId = continuations[0]![1].id
      expect(sessions.hasContinuation('t-bg', contId)).toBe(true)
      expect(sessions.inFlightContinuation('t-bg')).toEqual({ id: contId, discarded: false })

      await agentClient!.notify(methods.client.session.update, {
        sessionId: 'agy-bg-1',
        update: { sessionUpdate: 'tool_call', toolCallId: 'pr-1', name: 'run_command', title: 'gh pr create', status: 'in_progress', rawInput: { CommandLine: 'gh pr create' } }
      })
      const permPromise = agentClient!.request(methods.client.session.requestPermission, {
        sessionId: 'agy-bg-1',
        toolCall: { toolCallId: 'pr-1', title: 'gh pr create', kind: 'execute' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
      })

      const formReply = agentClient!.request(methods.client.elicitation.create, {
        sessionId: 'agy-bg-1',
        mode: 'form',
        message: 'Which branch should this go to?',
        requestedSchema: {
          type: 'object',
          properties: { branch: { type: 'string', title: 'Base branch', enum: ['main', 'release'] } }
        }
      })
      await vi.waitFor(() => expect(formReceived).toHaveBeenCalledOnce())
      expect(sessions.hasContinuation('t-bg', contId)).toBe(true)
      expect(questions.listPendingForThread('t-bg')).toEqual([])

      // Now attach the continuation turn (with a different historyKey, since OrchestratorService inserts a notice).
      const contTools: Array<Record<string, unknown>> = []
      let contThinking = ''
      const contPromise = sessions.chat({
        threadId: 't-bg',
        cwd: process.cwd(),
        model: 'default',
        permissionMode: 'full',
        history: 'h-1-plus-notice',
        continuation: true,
        continuationId: contId,
        prompt: 'A background task finished.',
        onText: vi.fn(),
        onThinking: (t) => { contThinking = t },
        onTool: (e) => contTools.push(e as unknown as Record<string, unknown>)
      })

      // Permission request waited for continuation attach and auto-allowed under permissionMode: 'full'.
      await expect(permPromise).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
      await vi.waitFor(() => expect(questions.listPendingForThread('t-bg')).toHaveLength(1))
      const [form] = questions.listPendingForThread('t-bg')
      expect(form!.questions[0]?.prompt).toBe('Base branch')
      questions.submitAnswers(form!.requestId, { q0: 'option-0' })
      await expect(formReply).resolves.toEqual({ action: 'accept', content: { branch: 'main' } })

      const followUp = JSON.stringify({ delegationId: 'd-next', threadId: 't-child', title: 'Reviewer', subagent: true })
      await agentClient!.notify(methods.client.session.update, {
        sessionId: 'agy-bg-1',
        update: { sessionUpdate: 'tool_call', toolCallId: 'follow-up', name: 'mcp_mousse_thread_send', title: 'Follow up with reviewer', status: 'in_progress' }
      })
      await agentClient!.notify(methods.client.session.update, {
        sessionId: 'agy-bg-1',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'follow-up', status: 'completed', rawOutput: { content: [{ type: 'text', text: followUp }] } }
      })

      // Complete the follow-up tool and emit final reply + usage_update.
      await agentClient!.notify(methods.client.session.update, {
        sessionId: 'agy-bg-1',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'pr-1', status: 'completed', rawOutput: 'https://github.com/org/repo/pull/99' }
      })
      await agentClient!.notify(methods.client.session.update, {
        sessionId: 'agy-bg-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PR #99 created.' } }
      })
      await agentClient!.notify(methods.client.session.update, {
        sessionId: 'agy-bg-1',
        update: { sessionUpdate: 'usage_update', size: 100000, used: 2000 } as never
      })

      const contText = await contPromise
      expect(contText).toBe('PR #99 created.')
      expect(contThinking).toBe('Verify passed, opening PR.')
      expect(contTools).toEqual([
        expect.objectContaining({ phase: 'start', callId: 'pr-1', toolName: 'run_command' }),
        expect.objectContaining({ phase: 'start', callId: 'follow-up', toolName: 'mcp_mousse_thread_send' }),
        expect.objectContaining({ phase: 'complete', callId: 'follow-up', status: 'completed', activity: { output: followUp } }),
        expect.objectContaining({ phase: 'complete', callId: 'pr-1', status: 'completed' })
      ])
      expect(bgStates).toEqual([['t-bg', true], ['t-bg', false]])
      expect(sessions.inFlightContinuation('t-bg')).toBeUndefined()
      expect(agent.connections).toHaveLength(1)
    })

    it('closes a daemon run_command (IsDaemon: true) as background without holding backgroundWork', async () => {
      const agent = scriptedAgent({
        prompt: async (_text, ctx) => {
          await ctx.update({
            sessionUpdate: 'tool_call',
            toolCallId: 'daemon-1',
            name: 'run_command',
            title: 'Dev server',
            status: 'in_progress',
            rawInput: { CommandLine: 'npm run dev', IsDaemon: true, WaitMsBeforeAsync: 500 }
          })
          await ctx.notify('Dev server started.')
          return 'end_turn'
        }
      })
      const { sessions } = core(agent.connect, { backgroundWork: true })
      const bgStates: Array<[string, boolean]> = []
      sessions.setLiveHost({ backgroundWork: (threadId, active) => bgStates.push([threadId, active]) })
      const tools: Array<Record<string, unknown>> = []
      await sessions.chat({ threadId: 't-daemon', cwd: process.cwd(), model: 'default', prompt: 'start dev', onText: vi.fn(), onTool: (e) => tools.push(e as unknown as Record<string, unknown>) })
      expect(tools[1]).toMatchObject({ phase: 'complete', callId: 'daemon-1', status: 'background' })
      expect(bgStates).toEqual([])
    })

    it('tracks a slow invoke_subagent as background work until reactive wakeup settles it, while a fast in-turn invoke_subagent does not hold backgroundWork', async () => {
      let agentClient: { notify: (method: string, params: unknown) => Promise<void> } | undefined
      const agent = inProcessAgent((app: AgentApp) => {
        app
          .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }))
          .onRequest(methods.agent.session.new, () => ({ sessionId: 'agy-sub-1', ...DEFAULT_SESSION }) as never)
          .onRequest(methods.agent.session.prompt, async (c) => {
            agentClient = c.client as unknown as typeof agentClient
            const promptText = (c.params.prompt[0] as { text: string }).text
            const slow = promptText.includes('slow')
            const callId = slow ? 'sub-slow' : 'sub-fast'
            await c.client.notify(methods.client.session.update, {
              sessionId: 'agy-sub-1',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: callId,
                name: 'invoke_subagent',
                title: 'Run invoke_subagent',
                status: 'in_progress',
                rawInput: { Role: slow ? 'Slow Researcher' : 'Fast Solver', TypeName: 'research', Prompt: 'Check files' }
              }
            } as never)
            await c.client.notify(methods.client.session.update, {
              sessionId: 'agy-sub-1',
              update: { sessionUpdate: 'tool_call_update', toolCallId: callId, status: 'completed' }
            })
            await c.client.notify(methods.client.session.update, {
              sessionId: 'agy-sub-1',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Launched subagent.' } }
            })
            await c.client.notify(methods.client.session.update, {
              sessionId: 'agy-sub-1',
              update: { sessionUpdate: 'usage_update', size: 100000, used: 500 } as never
            })
            if (!slow) {
              // Fast subagent wakes up and reports before session/prompt returns.
              await c.client.notify(methods.client.session.update, {
                sessionId: 'agy-sub-1',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Answer is 42.' } }
              })
              await c.client.notify(methods.client.session.update, {
                sessionId: 'agy-sub-1',
                update: { sessionUpdate: 'usage_update', size: 100000, used: 900 } as never
              })
            }
            return { stopReason: 'end_turn' as const }
          })
      })
      const { sessions } = core(agent.connect, { backgroundWork: true, continuationSettleMs: 30 })
      const bgStates: Array<[string, boolean]> = []
      const endedTasks: Array<[string, ProviderTaskEnd]> = []
      const continuations: Array<[string, ContinuationInfo]> = []
      sessions.setLiveHost({
        backgroundWork: (threadId, active) => bgStates.push([threadId, active]),
        taskEnded: (threadId, info) => endedTasks.push([threadId, info]),
        continuationStarted: (threadId, info) => continuations.push([threadId, info])
      })

      // 1) Fast subagent completes in-turn: does NOT set backgroundWork(true), immediately settles taskEnded.
      await sessions.chat({ threadId: 't-sub', cwd: process.cwd(), model: 'default', prompt: 'fast subagent', onText: vi.fn() })
      sessions.commitConversation('t-sub', 'h-fast')
      expect(bgStates).toEqual([])
      expect(endedTasks).toEqual([['t-sub', expect.objectContaining({ toolUseId: 'sub-fast', status: 'completed' })]])

      // 2) Slow subagent is still running at end_turn: emits status: 'background' & background: true, sets backgroundWork(true).
      const slowTools: Array<Record<string, unknown>> = []
      await sessions.chat({
        threadId: 't-sub',
        cwd: process.cwd(),
        model: 'default',
        history: 'h-fast',
        prompt: 'slow subagent',
        onText: vi.fn(),
        onTool: (e) => slowTools.push(e as unknown as Record<string, unknown>)
      })
      expect(slowTools).toEqual([
        expect.objectContaining({ phase: 'start', callId: 'sub-slow', activity: expect.objectContaining({ kind: 'subagent', description: 'Slow Researcher', background: true }) }),
        expect.objectContaining({ phase: 'complete', callId: 'sub-slow', status: 'background' })
      ])
      expect(bgStates).toEqual([['t-sub', true]])

      // Reactive wakeup arrives when slow subagent finishes.
      await agentClient!.notify(methods.client.session.update, {
        sessionId: 'agy-sub-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Slow Researcher finished.' } }
      })
      await agentClient!.notify(methods.client.session.update, {
        sessionId: 'agy-sub-1',
        update: { sessionUpdate: 'usage_update', size: 100000, used: 1200 } as never
      })
      await vi.waitFor(() => expect(continuations).toHaveLength(1))
      const contId = continuations[0]![1].id
      const reply = await sessions.chat({
        threadId: 't-sub',
        cwd: process.cwd(),
        model: 'default',
        continuation: true,
        continuationId: contId,
        prompt: 'A background task finished.',
        onText: vi.fn()
      })
      expect(reply).toBe('Slow Researcher finished.')
      expect(endedTasks).toHaveLength(2)
      expect(endedTasks[1]).toEqual(['t-sub', expect.objectContaining({ toolUseId: 'sub-slow', status: 'completed' })])
      expect(bgStates).toEqual([['t-sub', true], ['t-sub', false]])
    })

    it('stopThread kills a process waiting on background work, marks pending tasks stopped, and clears backgroundWork', async () => {
      const agent = scriptedAgent({
        prompt: async (_text, ctx) => {
          await ctx.update({
            sessionUpdate: 'tool_call',
            toolCallId: 'cmd-stop',
            name: 'run_command',
            title: 'Long build',
            status: 'in_progress',
            rawInput: { CommandLine: 'npm run build' }
          })
          await ctx.notify('Building in background.')
          return 'end_turn'
        }
      })
      const { sessions } = core(agent.connect, { backgroundWork: true })
      const bgStates: Array<[string, boolean]> = []
      const endedTasks: Array<[string, ProviderTaskEnd]> = []
      sessions.setLiveHost({
        backgroundWork: (threadId, active) => bgStates.push([threadId, active]),
        taskEnded: (threadId, info) => endedTasks.push([threadId, info])
      })

      await sessions.chat({ threadId: 't-stop', cwd: process.cwd(), model: 'default', prompt: 'build', onText: vi.fn() })
      expect(bgStates).toEqual([['t-stop', true]])
      expect(sessions.stopThread('t-stop')).toBe('stopped')
      expect(endedTasks).toEqual([['t-stop', expect.objectContaining({ toolUseId: 'cmd-stop', status: 'stopped' })]])
      expect(bgStates).toEqual([['t-stop', true], ['t-stop', false]])
      expect(agent.connections[0].killed).toBe(true)
      expect(sessions.stopThread('t-stop')).toBe('not_active')
    })

    it('records bounded subagent call metadata for Antigravity mcp_mousse_delegate_task calls and keeps drained_turn settled for native background tools', async () => {
      const agent = scriptedAgent({
        prompt: async (_text, ctx) => {
          await ctx.update({
            sessionUpdate: 'tool_call',
            toolCallId: 'mcp-1',
            name: 'mcp_mousse_delegate_task',
            title: 'mcp_mousse_delegate_task',
            status: 'in_progress',
            rawInput: { title: 'API reviewer', prompt: 'SECRET PROMPT' }
          })
          await ctx.update({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'mcp-1',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: JSON.stringify({ delegationId: 'd-1', childThreadId: 'child-1', title: 'API reviewer', status: 'started' }) } }]
          })
          await ctx.update({
            sessionUpdate: 'tool_call',
            toolCallId: 'bg-cmd',
            name: 'run_command',
            title: 'Verify',
            status: 'in_progress',
            rawInput: { CommandLine: 'npm test' }
          })
          await ctx.notify('Delegated and running tests.')
          return 'end_turn'
        }
      })
      const { sessions } = core(agent.connect, { backgroundWork: true })
      const adapter = new AcpAdapter(
        () => ({
          chat: (i) => sessions.chat(i),
          commitConversation: (t, h) => sessions.commitConversation(t, h),
          configured: () => true,
          stopThread: (t) => sessions.stopThread(t)
        }),
        { driver: 'antigravity', label: 'Antigravity', capabilities: GENERIC_ACP_CAPS }
      )
      const toolEvents: Array<Record<string, unknown>> = []
      const sink: TurnSink = {
        providerRef: vi.fn(),
        progress: vi.fn(),
        text: vi.fn(),
        thinking: vi.fn(),
        tool: (e) => toolEvents.push(e as unknown as Record<string, unknown>),
        usage: vi.fn(),
        providerMetrics: vi.fn(),
        steerAccepted: vi.fn()
      }
      const host: AdapterHost = {
        context: {
          prepareNativeContext: () => undefined,
          nativeHistoryAfterTurn: (t) => t
        }
      } as unknown as AdapterHost
      const result = await adapter.startTurn(
        {
          runId: 'r1',
          attemptId: 'a1',
          threadId: 't-mcp',
          cwd: process.cwd(),
          instanceId: 'antigravity',
          model: 'default',
          llmProvider: 'antigravity',
          modelPinned: true,
          mode: 'agent',
          permissionMode: 'full',
          prompt: 'go',
          messages: [],
          signal: new AbortController().signal
        } as TurnInput,
        sink,
        { heartbeat: vi.fn(), drainSteer: () => undefined } as never,
        host
      )
      expect(result.drain).toEqual({ toolCalls: 2, toolsSettled: true })
      const mcpStart = toolEvents.find((e) => e.callId === 'mcp-1' && e.phase === 'start')
      const mcpEnd = toolEvents.find((e) => e.callId === 'mcp-1' && e.phase === 'complete')
      expect(mcpStart?.input).toEqual({ recordVersion: 1, title: 'API reviewer' })
      expect(JSON.parse(String(mcpEnd?.response))).toEqual({ delegationId: 'd-1', childThreadId: 'child-1', title: 'API reviewer', status: 'started' })
      const bgEnd = toolEvents.find((e) => e.callId === 'bg-cmd' && e.phase === 'complete')
      expect(bgEnd?.activity).toMatchObject({ status: 'done', summary: BACKGROUND_SUMMARY })
    })
  })
})

/**
 * What the agent wrote reaches the saved rows exactly: an empty chunk does not split a thought, a blank line or
 * indentation the agent wrote after a tool call stays, and the blank line Mousse puts between a steer's prompts is
 * the only thing a continuation row drops.
 */
describe('ACP rows keep the agent\'s words', () => {
  const gate = () => {
    let open!: () => void
    const opened = new Promise<void>((resolve) => { open = resolve })
    return { opened, open }
  }
  const thought = (text: string) => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } })
  const toolCall = (id: string) => ({ sessionUpdate: 'tool_call', toolCallId: id, title: 'npm test', kind: 'execute', status: 'in_progress' })
  const toolDone = (id: string) => ({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' })

  /** A turn through the real session core and the ACP adapter, its events saved as the thread saves them. */
  function savedTurn(agent: ReturnType<typeof scriptedAgent>) {
    const { sessions, questions } = core(agent.connect)
    const hold = holdControl(GENERIC_ACP_CAPS, { questions: { pending: () => questions.listPendingForThread('t').length > 0 } })
    const transcript = transcriptSink()
    const adapter = new AcpAdapter(() => ({ chat: (input) => sessions.chat(input), commitConversation: () => {}, configured: () => true }), { driver: 'acp', label: 'Fake agent', capabilities: GENERIC_ACP_CAPS })
    const input = { threadId: 't', instanceId: 'acp:fake', llmProvider: '', model: 'default', mode: 'agent', prompt: 'work', cwd: process.cwd(), signal: new AbortController().signal } as unknown as TurnInput
    const result = adapter.startTurn(input, hold.wrap(transcript.sink), hold.ctl, { context: { nativeHistoryAfterTurn: (text: string) => text } } as unknown as AdapterHost)
    return { hold, result, rows: transcript.rows }
  }

  it('an empty message chunk in the middle of a thought leaves it one row', async () => {
    const agent = scriptedAgent({
      prompt: async (_text, ctx) => {
        await ctx.update(thought('Check the fil'))
        await ctx.notify('')
        await ctx.update(thought('e.'))
        await ctx.notify('Done.')
        return 'end_turn'
      }
    })
    const turn = savedTurn(agent)
    await turn.result
    expect(turn.rows()).toEqual([{ kind: 'thinking', content: 'Check the file.' }, { kind: 'text', content: 'Done.' }])
  })

  it('a blank line and indentation the agent wrote after a tool call stay on the thought and the note after it', async () => {
    const agent = scriptedAgent({
      prompt: async (_text, ctx) => {
        await ctx.update(thought('Plan'))
        await ctx.update(toolCall('call-1'))
        await ctx.update(toolDone('call-1'))
        await ctx.update(thought('\n\n    next'))
        await ctx.notify('old')
        await ctx.update(toolCall('call-2'))
        await ctx.update(toolDone('call-2'))
        await ctx.notify('\n\n    next')
        await ctx.update(toolCall('call-3'))
        await ctx.update(toolDone('call-3'))
        await ctx.notify('Done.')
        return 'end_turn'
      }
    })
    const turn = savedTurn(agent)
    expect((await turn.result).text).toBe('old\n\n    nextDone.')
    expect(turn.rows()).toEqual([
      { kind: 'thinking', content: 'Plan' },
      { kind: 'tool', content: 'npm test' },
      { kind: 'thinking', content: '\n\n    next' },
      { kind: 'text', content: 'old' },
      { kind: 'tool', content: 'npm test' },
      { kind: 'text', content: '\n\n    next' },
      { kind: 'tool', content: 'npm test' },
      { kind: 'text', content: 'Done.' }
    ])
  })

  // A person's steer with its drain token (`drainSteerEntry`) cuts the prompt; the next prompt carries it, and Mousse
  // puts a blank line into the reply's text between the two prompts' words.
  it.each([
    ['while the reply row is still open', false],
    ['after a tool call, with a lone space written after it', true]
  ])('a steer %s: the continuation row is the agent\'s words exactly', async (_name, afterTool) => {
    const steerable = gate()
    const agent = scriptedAgent({
      prompt: async (text, ctx) => {
        if (text !== 'work') {
          await ctx.notify('    next')
          return 'end_turn'
        }
        await ctx.notify('old')
        if (afterTool) {
          await ctx.update(toolCall('call-1'))
          await ctx.update(toolDone('call-1'))
          await ctx.notify(' ')
        }
        steerable.open()
        await ctx.cancelled
        return 'cancelled'
      }
    })
    const turn = savedTurn(agent)
    await steerable.opened
    turn.hold.steer('Use pnpm')
    const result = await turn.result
    expect(result.text).toBe(afterTool ? 'old \n\n    next' : 'old\n\n    next')
    expect(turn.hold.log.filter(([event]) => event === 'accepted').map(([, detail]) => detail)).toEqual(['Use pnpm@drain-1'])
    expect(turn.rows()).toEqual([
      { kind: 'text', content: 'old' },
      ...(afterTool ? [{ kind: 'tool', content: 'npm test' }] : []),
      { kind: 'text', content: '    next' }
    ])
  })
})

describe('ACP thought_level reasoning options', () => {
  // Shape recorded from live agy 1.5.16: base models in configOptions[model], active model's
  // thought_level select, and per-level variants in models.availableModels.
  const AGY_MODEL_OPTIONS = [
    { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
    { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
    { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
    { value: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
    { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }
  ]
  const AGY_THOUGHT_NEON = {
    id: 'thought_level',
    name: 'Thinking Level',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
      { value: 'xhigh', name: 'Extra' }
    ]
  }
  const AGY_THOUGHT_THREE = (currentValue: string) => ({
    id: 'thought_level',
    name: 'Thinking Level',
    category: 'thought_level',
    type: 'select',
    currentValue,
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' }
    ]
  })
  const AGY_SESSION = {
    configOptions: [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-4-neon', options: AGY_MODEL_OPTIONS },
      AGY_THOUGHT_NEON
    ],
    models: {
      currentModelId: 'gemini-4-neon-high',
      availableModels: [
        { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
        { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
        { modelId: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Medium)' },
        { modelId: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
        { modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
        { modelId: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
        { modelId: 'gemini-4-argon-low', name: 'Gemini 4 Argon (Low)' },
        { modelId: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
        { modelId: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 (Medium)' },
        { modelId: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
        { modelId: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
        { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }
      ]
    }
  }

  it('extracts per-model efforts, defaultEffort, and thinkingOff from agy session/new and preserves them across config_option_update', () => {
    const listed = modelOptions(AGY_SESSION as never)
    expect(listed).toEqual([
      { id: 'gemini-4-neon', label: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', thinkingOff: false },
      { id: 'gemini-4-argon', label: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', thinkingOff: false },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', thinkingOff: false },
      { id: 'gemini-pro-orchestrator-neon', label: 'Orchestrator (Neon)' },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }
    ])

    // When agy starts at xhigh on Neon, 3-level models clamp defaultEffort to high (matching agy's switch behavior).
    const xhighSession = {
      ...AGY_SESSION,
      configOptions: [AGY_SESSION.configOptions[0], { ...AGY_THOUGHT_NEON, currentValue: 'xhigh' }]
    }
    const clamped = modelOptions(xhighSession as never)
    expect(clamped.find((m) => m.id === 'gemini-4-neon')?.defaultEffort).toBe('xhigh')
    expect(clamped.find((m) => m.id === 'claude-opus-5-5')?.defaultEffort).toBe('high')

    // A mid-session config_option_update after setting claude-opus-5-5 to low must keep other models'
    // efforts and must not replace claude-opus-5-5's defaultEffort with low.
    const updateOpts = [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'claude-opus-5-5', options: AGY_MODEL_OPTIONS },
      AGY_THOUGHT_THREE('low')
    ]
    const merged = mergeModelOptions(listed, modelOptions({ configOptions: updateOpts } as never), updateOpts)
    expect(merged.find((m) => m.id === 'gemini-4-neon')?.efforts).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(merged.find((m) => m.id === 'claude-opus-5-5')).toMatchObject({
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      thinkingOff: false
    })
  })

  it('sends model and thought_level config options on turns, resets stale levels on reused sessions, and handles legacy and no-thinking models', async () => {
    const calls: Array<{ configId: string; value: string }> = []
    let activeModel = 'gemini-4-neon'
    let activeThought: string | undefined = 'high'
    const currentConfigOptions = () => {
      const thought = activeModel === 'gemini-4-neon'
        ? { ...AGY_THOUGHT_NEON, currentValue: activeThought ?? 'high' }
        : activeModel === 'claude-opus-5-5' || activeModel === 'gemini-4-argon'
          ? AGY_THOUGHT_THREE(activeThought === 'xhigh' ? 'high' : (activeThought ?? 'high'))
          : undefined
      return [
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: activeModel, options: AGY_MODEL_OPTIONS },
        ...(thought ? [thought] : [])
      ]
    }
    const agent = inProcessAgent((app: AgentApp) => {
      app
        .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }))
        .onRequest(methods.agent.session.new, () => ({ sessionId: 'ses-1', ...AGY_SESSION }) as never)
        .onRequest(methods.agent.session.setConfigOption, async (c) => {
          const { configId, value } = c.params as { configId: string; value: string }
          calls.push({ configId, value })
          if (configId === 'model') {
            activeModel = value
            if (value === 'gpt-oss-120b-medium' || value === 'gemini-pro-orchestrator-neon') activeThought = undefined
            else activeThought ??= 'medium'
          } else if (configId === 'thought_level') {
            activeThought = value
          }
          const configOptions = currentConfigOptions()
          await c.client.notify(methods.client.session.update, {
            sessionId: c.params.sessionId,
            update: { sessionUpdate: 'config_option_update', configOptions }
          } as never)
          return { configOptions } as never
        })
        .onRequest(methods.agent.session.prompt, async (c) => {
          await c.client.notify(methods.client.session.update, {
            sessionId: c.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${activeModel}@${activeThought ?? 'none'}` } }
          })
          return { stopReason: 'end_turn' as const }
        })
    })
    const saved = new Map<string, SavedAcpSession>()
    let models: LlmModelOption[] = []
    const sessions = new AcpSessions({
      label: 'Antigravity',
      defaultInstanceId: 'antigravity',
      questions: new UserQuestionService(),
      connect: agent.connect,
      quirks: { modelConfigId: 'model' },
      store: {
        saved: (id) => saved.get(id),
        setSaved: (id, value) => (value ? saved.set(id, value) : saved.delete(id)),
        models: () => models,
        setModels: (next) => { models = next }
      },
      launchGeneration: () => 0,
      signInGeneration: () => 0,
      markSignedOut: vi.fn(),
      signInRequiredMessage: 'Sign in first'
    })
    sessionsUnderTest.push(sessions)

    // 1. Explicit reasoning level: sets model, then thought_level; config_option_update keeps all models' efforts.
    expect(await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'gemini-4-neon:low', prompt: '1', onText: vi.fn() })).toBe('gemini-4-neon@low')
    expect(calls.splice(0)).toEqual([
      { configId: 'model', value: 'gemini-4-neon' },
      { configId: 'thought_level', value: 'low' }
    ])
    expect(models.find((m) => m.id === 'claude-opus-5-5')?.efforts).toEqual(['low', 'medium', 'high'])
    sessions.commitConversation('t', 'h1')

    // 2. Reused session switching to a bare model (defaultEffort: high): resets thought_level instead of leaking low.
    expect(await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'claude-opus-5-5', prompt: '2', history: 'h1', onText: vi.fn() })).toBe('claude-opus-5-5@high')
    expect(calls.splice(0)).toEqual([
      { configId: 'model', value: 'claude-opus-5-5' },
      { configId: 'thought_level', value: 'high' }
    ])
    sessions.commitConversation('t', 'h2')

    // 3. Unsupported level (xhigh on 3-level Claude Opus 5.5): sets model only, never sends an invalid thought_level.
    expect(await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'claude-opus-5-5:xhigh', prompt: '3', history: 'h2', onText: vi.fn() })).toBe('claude-opus-5-5@high')
    expect(calls.splice(0)).toEqual([{ configId: 'model', value: 'claude-opus-5-5' }])
    sessions.commitConversation('t', 'h3')

    // 4. Model without thought_level: sets model only, never sends thought_level.
    expect(await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'gpt-oss-120b-medium', prompt: '4', history: 'h3', onText: vi.fn() })).toBe('gpt-oss-120b-medium@none')
    expect(calls.splice(0)).toEqual([{ configId: 'model', value: 'gpt-oss-120b-medium' }])
    sessions.commitConversation('t', 'h4')

    // 5. Legacy saved model id (`gemini-4-neon-xhigh`) maps onto base model + thought_level on native agy.
    expect(await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'gemini-4-neon-xhigh', prompt: '5', history: 'h4', onText: vi.fn() })).toBe('gemini-4-neon@xhigh')
    expect(calls.splice(0)).toEqual([
      { configId: 'model', value: 'gemini-4-neon' },
      { configId: 'thought_level', value: 'xhigh' }
    ])

    // 6. One-shot requests also apply the chosen reasoning level.
    expect(await sessions.oneShot({ cwd: process.cwd(), model: 'gemini-4-neon:low', system: 'Title', prompt: 'hi', signal: new AbortController().signal, onActivity: vi.fn() })).toBe('gemini-4-neon@low')
    expect(calls.splice(0)).toEqual([
      { configId: 'model', value: 'gemini-4-neon' },
      { configId: 'thought_level', value: 'low' }
    ])
  })
})

describe('an idle thread’s agent process', () => {
  const IDLE_MS = 80

  /**
   * An agent that can reopen its saved session (`session/load`). `prompt` runs each prompt; the default answers at once.
   * The rest of the calls are recorded, per process.
   */
  function loadingAgent(prompt?: (text: string, client: { notify: (method: string, params: unknown) => Promise<void> }) => Promise<void>) {
    const calls: string[] = []
    const agent = inProcessAgent((app: AgentApp) => {
      app
        .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true }, authMethods: [] }))
        .onRequest(methods.agent.session.new, () => { calls.push('session/new'); return { sessionId: 'native-1', ...DEFAULT_SESSION } as never })
        .onRequest(methods.agent.session.load, (c) => { calls.push(`session/load ${c.params.sessionId}`); return DEFAULT_SESSION as never })
        .onRequest(methods.agent.session.prompt, async (c) => {
          const text = (c.params.prompt[0] as { text: string }).text
          calls.push(`session/prompt ${text}`)
          await prompt?.(text, c.client as never)
          return { stopReason: 'end_turn' as const }
        })
    })
    return { ...agent, calls }
  }

  const turn = (sessions: AcpSessions, prompt: string, history?: string) =>
    sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', permissionMode: 'full', prompt, onText: vi.fn(), ...(history !== undefined ? { history } : {}) })

  it('closes once it has been idle, and the next turn reopens the same session on a new process', async () => {
    const agent = loadingAgent()
    const { sessions, saved } = core(agent.connect, { idleCloseMs: IDLE_MS })

    await turn(sessions, 'first')
    sessions.commitConversation('t', 'h1')
    expect(agent.connections[0].killed).toBe(false)

    await vi.waitFor(() => expect(agent.connections[0].killed).toBe(true))
    expect(saved.get('t')?.sessionId).toBe('native-1')

    await turn(sessions, 'second', 'h1')
    expect(agent.connections).toHaveLength(2)
    expect(agent.calls).toEqual(['session/new', 'session/prompt first', 'session/load native-1', 'session/prompt second'])
  })

  it('a turn started before the idle window ends keeps the process, and the window counts from that turn’s end', async () => {
    let release!: () => void
    const agent = loadingAgent(async (text) => { if (text === 'long') await new Promise<void>((resolve) => { release = resolve }) })
    const { sessions } = core(agent.connect, { idleCloseMs: IDLE_MS })

    await turn(sessions, 'first')
    sessions.commitConversation('t', 'h1')
    const running = turn(sessions, 'long', 'h1')
    await vi.waitFor(() => expect(agent.calls).toContain('session/prompt long'))
    await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 3))
    expect(agent.connections[0].killed).toBe(false)

    release()
    await running
    expect(agent.connections).toHaveLength(1)
    await vi.waitFor(() => expect(agent.connections[0].killed).toBe(true))
  })

  it('stays open while background work runs, and closes an idle window after that work ends', async () => {
    let client!: { notify: (method: string, params: unknown) => Promise<void> }
    const agent = loadingAgent(async (_text, agentClient) => {
      client = agentClient
      await agentClient.notify(methods.client.session.update, {
        sessionId: 'native-1',
        update: { sessionUpdate: 'tool_call', toolCallId: 'cmd-1', name: 'run_command', title: 'Run verify', status: 'in_progress', rawInput: { CommandLine: 'node scripts/verify.mjs', WaitMsBeforeAsync: 500 } }
      })
    })
    const { sessions } = core(agent.connect, { idleCloseMs: IDLE_MS, backgroundWork: true, wakeGraceMs: 20 })
    const background: boolean[] = []
    sessions.setLiveHost({ backgroundWork: (_threadId, active) => background.push(active) })

    await turn(sessions, 'run verify')
    expect(background).toEqual([true])
    await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 3))
    expect(agent.connections[0].killed).toBe(false)

    await client.notify(methods.client.session.update, { sessionId: 'native-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'cmd-1', status: 'completed' } })
    await vi.waitFor(() => expect(background).toEqual([true, false]))
    expect(agent.connections[0].killed).toBe(false)
    await vi.waitFor(() => expect(agent.connections[0].killed).toBe(true))
  })

  it('bounds idle processes per instance, evicting delegated children first while preserving saved sessions for resume', async () => {
    let nextSession = 0
    const calls: string[] = []
    const agent = inProcessAgent((app: AgentApp) => {
      app
        .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true }, authMethods: [] }))
        .onRequest(methods.agent.session.new, () => {
          const sessionId = `native-${++nextSession}`
          calls.push(`new:${sessionId}`)
          return { sessionId, ...DEFAULT_SESSION } as never
        })
        .onRequest(methods.agent.session.load, (c) => {
          calls.push(`load:${c.params.sessionId}`)
          return DEFAULT_SESSION as never
        })
        .onRequest(methods.agent.session.prompt, () => ({ stopReason: 'end_turn' as const }))
    })
    const { sessions, saved } = core(agent.connect, { idleCloseMs: 60_000, delegateIdleCloseMs: 60_000, maxIdleSessions: 2 })
    const run = (threadId: string, opts: { delegated?: true; history?: string } = {}) =>
      sessions.chat({ threadId, cwd: process.cwd(), model: 'default', permissionMode: 'full', prompt: 'hi', onText: vi.fn(), ...opts })

    // Two interactive threads fill the cap of 2.
    await run('i1')
    sessions.commitConversation('i1', 'h-i1')
    await run('i2')
    sessions.commitConversation('i2', 'h-i2')
    expect(agent.connections.map((c) => c.killed)).toEqual([false, false])

    // A delegated child finishes while 2 interactive threads are idle: the delegated child is evicted first,
    // and its subsequent commitConversation still fingerprints the saved session so a follow-up resumes it.
    await run('child', { delegated: true })
    sessions.commitConversation('child', 'h-child')
    expect(agent.connections[0].killed).toBe(false)
    expect(agent.connections[1].killed).toBe(false)
    expect(agent.connections[2].killed).toBe(true)
    expect(saved.get('child')?.historyKey).toBeTruthy()

    // A third interactive thread evicts the oldest interactive one (i1).
    await run('i3')
    sessions.commitConversation('i3', 'h-i3')
    expect(agent.connections[0].killed).toBe(true)
    expect(agent.connections[1].killed).toBe(false)
    expect(agent.connections[3].killed).toBe(false)

    // Resuming the evicted delegated child reopens its saved session instead of creating a new one.
    await run('child', { delegated: true, history: 'h-child' })
    expect(calls).toContain('load:native-3')
  })

  it('closes an idle delegated child after the shorter delegate grace while an interactive thread stays open', async () => {
    let nextSession = 0
    const agent = inProcessAgent((app: AgentApp) => {
      app
        .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true }, authMethods: [] }))
        .onRequest(methods.agent.session.new, () => ({ sessionId: `native-${++nextSession}`, ...DEFAULT_SESSION } as never))
        .onRequest(methods.agent.session.prompt, () => ({ stopReason: 'end_turn' as const }))
    })
    const { sessions } = core(agent.connect, { idleCloseMs: 60_000, delegateIdleCloseMs: 40, maxIdleSessions: 4 })

    await sessions.chat({ threadId: 'interactive', cwd: process.cwd(), model: 'default', permissionMode: 'full', prompt: 'hi', onText: vi.fn() })
    await sessions.chat({ threadId: 'child', cwd: process.cwd(), model: 'default', permissionMode: 'full', prompt: 'hi', onText: vi.fn(), delegated: true })
    await vi.waitFor(() => expect(agent.connections[1].killed).toBe(true))
    expect(agent.connections[0].killed).toBe(false)
  })

  it('AcpAdapter forwards child turns as delegated so they use the shorter idle grace', async () => {
    const received: Array<{ threadId: string; delegated?: true }> = []
    const adapter = new AcpAdapter(
      () => ({
        chat: async (input) => {
          received.push({ threadId: input.threadId, ...(input.delegated ? { delegated: input.delegated } : {}) })
          return 'ok'
        },
        commitConversation: vi.fn(),
        configured: () => true
      }),
      { driver: 'acp', label: 'Fake agent', capabilities: {} as never }
    )
    const noop = () => {}
    const sink = { text: noop, thinking: noop, tool: noop, progress: noop, usage: noop, providerRef: noop, steerAccepted: noop, providerMetrics: noop, nativeMessages: noop, compaction: noop, retry: noop, lineEdits: noop } as never
    const ctl = { drainSteer: () => undefined, heartbeat: noop } as never
    const host = { tools: {}, context: { nativeHistoryAfterTurn: (t: string) => t, recoverOverflow: () => null, prepareNativeContext: () => null } } as never
    const base = { runId: 'r1', attemptId: 'a1', cwd: process.cwd(), instanceId: 'acp:fake', model: 'default', llmProvider: 'acp', modelPinned: true, mode: 'agent', prompt: 'hi', messages: [], signal: new AbortController().signal } as never
    await adapter.startTurn({ ...base, threadId: 'interactive' }, sink, ctl, host)
    await adapter.startTurn({ ...base, threadId: 'child', child: { readOnly: false } }, sink, ctl, host)
    expect(received).toEqual([{ threadId: 'interactive' }, { threadId: 'child', delegated: true }])
  })
})
