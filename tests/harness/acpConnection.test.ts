/**
 * The ACP process boundary: `connectAcpProcess` over a fake child whose stdio are real streams.
 * An agent that closes its output but stays alive must end the connection, and the turn on it,
 * exactly like one that exits: nothing can answer a request any more.
 */
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeAcpConnection, connectAcpProcess, type AcpConnectionFactory } from '../../src/mms/harness/acp/connection'
import { NO_QUIRKS } from '../../src/mms/harness/acp/quirks'
import { AcpSessions, type SavedAcpSession } from '../../src/mms/harness/acp/session'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import type { LlmModelOption } from '../../src/shared/settings'

interface FakeChild {
  child: ChildProcessWithoutNullStreams
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
  /** Complete JSON-RPC messages Mousse wrote to the agent's stdin, in order. */
  received: Array<{ id?: number; method?: string; params?: Record<string, unknown> }>
  send(message: unknown): void
}

/** A child that never exits by itself: `exitCode` and `signalCode` stay null, `kill` only records the call. */
function fakeChild(): FakeChild {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const kill = vi.fn(() => true)
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 4242, exitCode: null, signalCode: null, kill }) as unknown as ChildProcessWithoutNullStreams
  const received: FakeChild['received'] = []
  let pending = ''
  stdin.setEncoding('utf8')
  stdin.on('data', (chunk: string) => {
    const lines = `${pending}${chunk}`.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) if (line.trim()) received.push(JSON.parse(line))
  })
  return { child, stdin, stdout, stderr, kill, received, send: (message) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...(message as object) })}\n`) }
}

const handlers = { requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }) }

const live: FakeChild[] = []
afterEach(() => {
  for (const fake of live.splice(0)) {
    fake.stdout.destroy()
    fake.stdin.destroy()
    fake.stderr.destroy()
  }
})

describe('connectAcpProcess', () => {
  it('rejects a pending request when the agent closes its output while the process stays alive', async () => {
    const fake = fakeChild()
    live.push(fake)
    const onExit = vi.fn()
    const active = connectAcpProcess(fake.child, handlers, { onExit })
    const pending = active.connection.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const rejected = expect(pending).rejects.toBeDefined()
    await vi.waitFor(() => expect(fake.received.map((message) => message.method)).toEqual(['initialize']))
    fake.stdout.end()
    await rejected
    expect(active.connection.signal.aborted).toBe(true)
    // The process never exited, so closing the connection still ends it; a later exit is reported once.
    expect(fake.child.exitCode).toBeNull()
    closeAcpConnection(active)
    expect(fake.kill).toHaveBeenCalledTimes(1)
    fake.child.emit('exit', 0, null)
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('answers requests normally while the output is open', async () => {
    const fake = fakeChild()
    live.push(fake)
    const active = connectAcpProcess(fake.child, handlers)
    const pending = active.connection.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await vi.waitFor(() => expect(fake.received).toHaveLength(1))
    fake.send({ id: fake.received[0].id, result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] } })
    await expect(pending).resolves.toMatchObject({ protocolVersion: PROTOCOL_VERSION })
    expect(active.connection.signal.aborted).toBe(false)
    expect(fake.kill).not.toHaveBeenCalled()
    closeAcpConnection(active)
    expect(fake.kill).toHaveBeenCalledTimes(1)
  })
})

describe('a turn on an agent that closes its output mid-reply', () => {
  const sessionsUnderTest: AcpSessions[] = []
  afterEach(() => {
    for (const sessions of sessionsUnderTest.splice(0)) sessions.stop()
  })

  /** Sessions over fake children; each child answers `initialize` and `session/new`, then runs `onPrompt`. */
  function sessionsOver(onPrompt: (fake: FakeChild, sessionId: string) => void) {
    const children: FakeChild[] = []
    const saved = new Map<string, SavedAcpSession>()
    let models: LlmModelOption[] = []
    const connect: AcpConnectionFactory = (request) => {
      const fake = fakeChild()
      live.push(fake)
      children.push(fake)
      let handled = 0
      fake.stdin.on('data', () => {
        for (; handled < fake.received.length; handled += 1) {
          const message = fake.received[handled]
          if (message.method === 'initialize') fake.send({ id: message.id, result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] } })
          else if (message.method === 'session/new') fake.send({ id: message.id, result: { sessionId: 'native-1' } })
          else if (message.method === 'session/prompt') onPrompt(fake, 'native-1')
        }
      })
      return connectAcpProcess(fake.child, request.handlers, { onExit: request.onExit })
    }
    const sessions = new AcpSessions({
      label: 'Fake agent',
      defaultInstanceId: 'acp:fake',
      questions: new UserQuestionService(),
      connect,
      quirks: NO_QUIRKS,
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
    return { sessions, children, saved }
  }

  it('fails the turn once, ends the process, and never sends the prompt again', async () => {
    const { sessions, children, saved } = sessionsOver((fake, sessionId) => {
      fake.send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } } } })
      fake.stdout.end()
    })
    const onText = vi.fn()
    await expect(sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'hello', onText })).rejects.toBeDefined()
    expect(onText).toHaveBeenLastCalledWith('partial')
    expect(children).toHaveLength(1)
    expect(children[0].received.filter((message) => message.method === 'session/prompt')).toHaveLength(1)
    expect(children[0].kill).toHaveBeenCalled()
    // The session is not resumable: the next turn starts a new process with the history handed over.
    expect(saved.get('t')?.historyKey).toBeUndefined()
  })
})
