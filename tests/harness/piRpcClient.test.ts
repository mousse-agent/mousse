import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PiRpcClient, PiRpcError, readJsonLines, type PiRpcEvent, type PiRpcExit } from '../../src/mms/harness/pi/rpcClient'

/** A child double: what the client writes arrives on `sent`, and `reply` writes Pi's stdout. */
function fakeChild() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() })
  const sent: Array<Record<string, unknown>> = []
  readJsonLines(child.stdin, (line) => sent.push(JSON.parse(line)))
  return {
    child,
    sent,
    reply: (value: unknown) => child.stdout.write(`${JSON.stringify(value)}\n`),
    raw: (text: string | Buffer) => child.stdout.write(text),
    /** Pi's exit as Node reports it: `exit`, then `close` once stdout has ended. */
    exit: (code: number | null = 0, signal: NodeJS.Signals | null = null) => {
      child.emit('exit', code, signal)
      child.stdout.end()
      child.stdout.once('end', () => setImmediate(() => child.emit('close', code, signal)))
    }
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('Pi RPC client: framing', () => {
  it('splits records on LF only: U+2028 and U+2029 stay inside a string, a CR before the LF is dropped', async () => {
    const { child, raw } = fakeChild()
    const events: PiRpcEvent[] = []
    new PiRpcClient(child, { event: (event) => events.push(event) })
    const text = 'one two three'
    const line = Buffer.from(`${JSON.stringify({ type: 'message_update', text })}\r\n`)
    // Split inside a multi-byte character: the decoder must hold the partial bytes.
    const cut = line.indexOf(Buffer.from(' ')) + 1
    raw(line.subarray(0, cut))
    raw(line.subarray(cut))
    raw(`${JSON.stringify({ type: 'agent_end' })}\n${JSON.stringify({ type: 'agent_settled' })}\n`)
    await flush()
    expect(events).toEqual([{ type: 'message_update', text }, { type: 'agent_end' }, { type: 'agent_settled' }])
  })

  it('reports lines that are not JSON objects and responses Pi could not attach to a command', async () => {
    const { child, raw, reply } = fakeChild()
    const protocol: string[] = []
    const events: PiRpcEvent[] = []
    new PiRpcClient(child, { protocol: (text) => protocol.push(text), event: (event) => events.push(event) })
    raw('not json\n[1,2]\n{"no":"type"}\n\n')
    reply({ type: 'response', command: 'parse', success: false, error: 'Failed to parse command' })
    await flush()
    expect(protocol).toEqual(['not json', '[1,2]', '{"no":"type"}', '{"type":"response","command":"parse","success":false,"error":"Failed to parse command"}'])
    expect(events).toEqual([])
  })
})

describe('Pi RPC client: correlation', () => {
  it('sends each command with its own id and settles it by that id, in any order', async () => {
    const { child, sent, reply } = fakeChild()
    const client = new PiRpcClient(child)
    const state = client.send({ type: 'get_state' })
    const models = client.send({ type: 'get_available_models' })
    await flush()
    expect(sent.map((command) => command.type)).toEqual(['get_state', 'get_available_models'])
    const [stateId, modelsId] = sent.map((command) => command.id)
    expect(stateId).not.toBe(modelsId)
    reply({ id: modelsId, type: 'response', command: 'get_available_models', success: true, data: { models: [] } })
    reply({ id: stateId, type: 'response', command: 'get_state', success: true, data: { sessionId: 's1' } })
    await expect(models).resolves.toEqual({ models: [] })
    await expect(state).resolves.toEqual({ sessionId: 's1' })
  })

  it('rejects with Pi\'s message when it answers success: false', async () => {
    const { child, sent, reply } = fakeChild()
    const client = new PiRpcClient(child)
    const result = client.send({ type: 'switch_session', sessionPath: '/missing' })
    await flush()
    reply({ id: sent[0].id, type: 'response', command: 'switch_session', success: false, error: 'Session not found' })
    await expect(result).rejects.toMatchObject({ name: 'PiRpcError', code: 'rejected', command: 'switch_session', message: 'Session not found' })
  })

  it('passes events between responses to the event handler, never to a command', async () => {
    const { child, sent, reply } = fakeChild()
    const events: PiRpcEvent[] = []
    const client = new PiRpcClient(child, { event: (event) => events.push(event) })
    const prompt = client.send({ type: 'prompt', message: 'hi' })
    await flush()
    reply({ type: 'agent_start' })
    reply({ id: sent[0].id, type: 'response', command: 'prompt', success: true })
    reply({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 't', message: 'm' })
    await expect(prompt).resolves.toBeUndefined()
    expect(events.map((event) => event.type)).toEqual(['agent_start', 'extension_ui_request'])
    client.respond({ type: 'extension_ui_response', id: 'ui-1', cancelled: true })
    await flush()
    expect(sent.at(-1)).toEqual({ type: 'extension_ui_response', id: 'ui-1', cancelled: true })
  })
})

describe('Pi RPC client: abort', () => {
  it('rejects only that command as aborted, sends nothing more and drops its late response', async () => {
    const { child, sent, reply } = fakeChild()
    const events: PiRpcEvent[] = []
    const protocol: string[] = []
    const client = new PiRpcClient(child, { event: (event) => events.push(event), protocol: (text) => protocol.push(text) })
    const controller = new AbortController()
    const fork = client.send({ type: 'fork', entryId: 'e1' }, { signal: controller.signal })
    const state = client.send({ type: 'get_state' })
    await flush()
    controller.abort()
    await expect(fork).rejects.toMatchObject({ code: 'aborted', command: 'fork' })
    reply({ id: sent[0].id, type: 'response', command: 'fork', success: true, data: { text: '', cancelled: false } })
    reply({ id: sent[1].id, type: 'response', command: 'get_state', success: true, data: { sessionId: 's' } })
    await expect(state).resolves.toEqual({ sessionId: 's' })
    await flush()
    expect(sent.map((command) => command.type)).toEqual(['fork', 'get_state'])
    expect(events).toEqual([])
    expect(protocol).toEqual([])
  })

  it('does not write a command whose signal is already aborted', async () => {
    const { child, sent } = fakeChild()
    const client = new PiRpcClient(child)
    await expect(client.send({ type: 'get_state' }, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(PiRpcError)
    await flush()
    expect(sent).toEqual([])
  })
})

describe('Pi RPC client: exit', () => {
  it('reads every response already written, then rejects the rest as exited, and reports the exit once', async () => {
    const { child, sent, reply, exit } = fakeChild()
    const exits: PiRpcExit[] = []
    const client = new PiRpcClient(child, { exit: (info) => exits.push(info) })
    const answered = client.send({ type: 'get_state' })
    const unanswered = client.send({ type: 'get_messages' })
    await flush()
    reply({ id: sent[0].id, type: 'response', command: 'get_state', success: true, data: { sessionId: 's' } })
    exit(1)
    await expect(answered).resolves.toEqual({ sessionId: 's' })
    await expect(unanswered).rejects.toMatchObject({ code: 'exited', command: 'get_messages' })
    await expect(client.exited).resolves.toEqual({ code: 1, signal: null })
    // A later error and a second close change nothing.
    child.emit('error', new Error('late'))
    child.emit('close', 0, null)
    await flush()
    expect(exits).toEqual([{ code: 1, signal: null }])
    expect(client.closed).toBe(true)
    await expect(client.send({ type: 'get_state' })).rejects.toMatchObject({ code: 'exited' })
  })

  it('reports a process that could not start as its exit, once', async () => {
    const { child } = fakeChild()
    const exits: PiRpcExit[] = []
    const client = new PiRpcClient(child, { exit: (info) => exits.push(info) })
    const pending = client.send({ type: 'get_state' })
    child.emit('error', new Error('spawn node ENOENT'))
    child.emit('close', -4058, null)
    await expect(pending).rejects.toMatchObject({ code: 'exited' })
    expect(exits).toEqual([{ code: null, signal: null, error: 'spawn node ENOENT' }])
  })

  it('stays open when a running process emits an error (a failed kill); its real exit still ends it', async () => {
    const { child, exit } = fakeChild()
    Object.assign(child, { pid: 4321 })
    const exits: PiRpcExit[] = []
    const client = new PiRpcClient(child, { exit: (info) => exits.push(info) })
    const pending = client.send({ type: 'get_state' })
    let settled = false
    void pending.catch(() => {}).finally(() => { settled = true })
    child.emit('error', new Error('kill EPERM'))
    await flush()
    expect(settled).toBe(false)
    expect(client.closed).toBe(false)
    exit(0)
    await expect(pending).rejects.toMatchObject({ code: 'exited' })
    expect(exits).toEqual([{ code: 0, signal: null }])
  })

  it('rejects commands after its input has ended', async () => {
    const { child, sent } = fakeChild()
    const client = new PiRpcClient(child)
    client.end()
    await expect(client.send({ type: 'get_state' })).rejects.toMatchObject({ code: 'exited' })
    expect(sent).toEqual([])
  })
})

describe('Pi RPC client: no timers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts no timer for commands, aborts or exits: deadlines are the gateway\'s', async () => {
    const { child, sent, reply } = fakeChild()
    const client = new PiRpcClient(child)
    const controller = new AbortController()
    const aborted = client.send({ type: 'switch_session', sessionPath: 'x' }, { signal: controller.signal })
    const pending = client.send({ type: 'get_state' })
    expect(vi.getTimerCount()).toBe(0)
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ code: 'aborted' })
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    reply({ id: sent[1].id, type: 'response', command: 'get_state', success: true, data: {} })
    await expect(pending).resolves.toEqual({})
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
    await client.exited
    expect(vi.getTimerCount()).toBe(0)
  })
})
