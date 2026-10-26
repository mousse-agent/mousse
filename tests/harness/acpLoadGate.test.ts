/**
 * The `session/load` gate (agent CLIs plan §2): ready on the load's reply, or 2 s after the last
 * replayed update; replayed conversation is dropped, setup metadata kept, other sessions pass; an
 * agent that does neither runs into the gateway's 90 s deadline.
 */
import { methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoadGate } from '../../src/mms/harness/acp/loadGate'
import { NO_QUIRKS } from '../../src/mms/harness/acp/quirks'
import { AcpSessions, type SavedAcpSession } from '../../src/mms/harness/acp/session'
import { loadWithDeadline, SessionLoadTimeoutError } from '../../src/mms/harness/supervise'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { inProcessAgent } from '../../src/mms/run/testkit/acpAgent'

const message = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

describe('the load gate', () => {
  afterEach(() => vi.useRealTimers())

  it('times out on silence at the gateway deadline', async () => {
    vi.useFakeTimers()
    const gate = new LoadGate('s1')
    const onTimeout = vi.fn()
    const loading = expect(loadWithDeadline('s1', gate.ready, onTimeout)).rejects.toBeInstanceOf(SessionLoadTimeoutError)
    await vi.advanceTimersByTimeAsync(89_999)
    expect(gate.state).toBe('waiting')
    await vi.advanceTimersByTimeAsync(1)
    await loading
    expect(onTimeout).toHaveBeenCalledOnce()
  })

  it('waits for a first replay that comes after 5 s, then opens 2 s after the last update', async () => {
    vi.useFakeTimers()
    const gate = new LoadGate('s1')
    let ready = false
    void gate.ready.then(() => { ready = true })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(gate.update('s1', message('old answer'))).toBe('discard')
    expect(gate.state).toBe('replaying')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(gate.update('s1', message('older answer'))).toBe('discard')
    await vi.advanceTimersByTimeAsync(1_999)
    expect(ready).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(ready).toBe(true)
    // A reply after the gate opened changes nothing; updates pass from now on.
    gate.reply()
    expect(gate.update('s1', message('new answer'))).toBe('pass')
  })

  it('opens on a replay with no reply, keeping setup metadata', async () => {
    vi.useFakeTimers()
    const gate = new LoadGate('s1')
    expect(gate.update('s1', { sessionUpdate: 'current_mode_update', currentModeId: 'code' })).toBe('keep')
    expect(gate.state).toBe('waiting')
    expect(gate.update('s1', { sessionUpdate: 'tool_call', toolCallId: 'x' })).toBe('discard')
    expect(gate.update('s1', { sessionUpdate: 'config_option_update', configOptions: [] })).toBe('keep')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(gate.state).toBe('ready')
  })

  it('passes the updates of another session while one loads', () => {
    const gate = new LoadGate('s1')
    expect(gate.update('s2', message('elsewhere'))).toBe('pass')
    expect(gate.state).toBe('waiting')
    gate.reply()
    expect(gate.state).toBe('ready')
  })
})

describe('reopening a saved session', () => {
  it('loads it behind the gate: the replay is not shown again and the prompt goes to the loaded session', async () => {
    const calls: string[] = []
    const agent = inProcessAgent((app) => {
      app
        .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true }, authMethods: [] }))
        .onRequest(methods.agent.session.load, async (c) => {
          calls.push(`load ${c.params.sessionId}`)
          await c.client.notify(methods.client.session.update, { sessionId: c.params.sessionId, update: message('replayed answer') as never })
          return {}
        })
        .onRequest(methods.agent.session.new, () => {
          calls.push('new')
          return { sessionId: 'fresh' }
        })
        .onRequest(methods.agent.session.prompt, async (c) => {
          calls.push(`prompt ${c.params.sessionId}`)
          await c.client.notify(methods.client.session.update, { sessionId: c.params.sessionId, update: message('new answer') as never })
          return { stopReason: 'end_turn' }
        })
    })
    const saved = new Map<string, SavedAcpSession>([['t', { sessionId: 'old-session', cwd: process.cwd(), historyKey: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', instanceId: 'acp:fake' }]])
    const sessions = new AcpSessions({
      label: 'Fake agent', defaultInstanceId: 'acp:fake', questions: new UserQuestionService(), connect: agent.connect, quirks: NO_QUIRKS,
      store: { saved: (id) => saved.get(id), setSaved: (id, value) => (value ? saved.set(id, value) : saved.delete(id)), models: () => [], setModels: () => {} },
      launchGeneration: () => 0, signInGeneration: () => 0, markSignedOut: () => {}, signInRequiredMessage: 'Sign in'
    })
    try {
      const texts: string[] = []
      // An empty history hashes to the saved key: the session is reopened, not replaced.
      const text = await sessions.chat({ threadId: 't', instanceId: 'acp:fake', cwd: process.cwd(), model: 'default', prompt: 'next', onText: (value) => texts.push(value) })
      expect(text).toBe('new answer')
      expect(texts).toEqual(['new answer'])
      expect(calls).toEqual(['load old-session', 'prompt old-session'])
    } finally {
      sessions.stop()
    }
  })
})
