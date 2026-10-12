import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodexAppServerClient,
  CodexAppServerExitedError,
  CodexRpcError,
  CodexRpcTimeoutError,
  codexConfigArgs,
  tomlValue,
  type CodexProcess
} from '../src/mms/providers/codex/CodexAppServerClient'

class FakeProcess extends EventEmitter implements CodexProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly written: unknown[] = []
  readonly kills: Array<NodeJS.Signals | undefined> = []

  constructor() {
    super()
    let pending = ''
    this.stdin.on('data', (chunk: Buffer) => {
      pending += chunk.toString()
      let end: number
      while ((end = pending.indexOf('\n')) !== -1) {
        this.written.push(JSON.parse(pending.slice(0, end)))
        pending = pending.slice(end + 1)
      }
    })
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal)
    return true
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }

  send(text: string): void {
    this.stdout.write(text)
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

afterEach(() => {
  vi.useRealTimers()
})

describe('CodexAppServerClient', () => {
  it('frames requests as JSON lines without a jsonrpc member and matches responses split across chunks', async () => {
    const process = new FakeProcess()
    const client = new CodexAppServerClient(process)
    const first = client.request('account/read', { refreshToken: false })
    const second = client.request('model/list', {})
    client.notify('initialized')
    await tick()
    expect(process.written).toEqual([
      { id: 1, method: 'account/read', params: { refreshToken: false } },
      { id: 2, method: 'model/list', params: {} },
      { method: 'initialized' }
    ])
    // Two responses in one chunk, the second split across chunks, answered out of order.
    process.send('{"id":2,"result":{"data":[],"nextCursor":null}}\n{"id":1,"res')
    process.send('ult":{"account":null,"requiresOpenaiAuth":true}}\n')
    await expect(second).resolves.toEqual({ data: [], nextCursor: null })
    await expect(first).resolves.toEqual({ account: null, requiresOpenaiAuth: true })
  })

  it('skips malformed lines and stray responses, and delivers notifications', async () => {
    const process = new FakeProcess()
    const client = new CodexAppServerClient(process)
    const seen: unknown[] = []
    client.onNotification((notification) => seen.push(notification))
    const pending = client.request('account/read', {})
    process.send('not json\n[1,2]\n{"id":99,"result":{}}\n{"no":"method"}\n')
    process.send('{"method":"turn/started","params":{"threadId":"t"}}\n{"id":1,"result":{"account":null,"requiresOpenaiAuth":false}}\n')
    await expect(pending).resolves.toMatchObject({ requiresOpenaiAuth: false })
    expect(seen).toEqual([{ method: 'turn/started', params: { threadId: 't' } }])
    expect(client.malformedLines).toBe(3)
    expect(client.signal.aborted).toBe(false)
  })

  it('rejects an error response with the server code', async () => {
    const process = new FakeProcess()
    const client = new CodexAppServerClient(process)
    const pending = client.request('thread/resume', { threadId: 'gone' })
    process.send('{"id":1,"error":{"code":-32600,"message":"no rollout found for thread id gone"}}\n')
    const error = await pending.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CodexRpcError)
    expect(error).toMatchObject({ method: 'thread/resume', code: -32600, message: 'no rollout found for thread id gone' })
  })

  it('times out a request without ending the process; a late answer is ignored', async () => {
    vi.useFakeTimers()
    const process = new FakeProcess()
    const client = new CodexAppServerClient(process, { defaultTimeoutMs: 1_000 })
    const slow = client.request('model/list', {})
    const quick = client.request('account/read', {}, { timeoutMs: 0 })
    vi.advanceTimersByTime(1_000)
    await expect(slow).rejects.toBeInstanceOf(CodexRpcTimeoutError)
    vi.useRealTimers()
    process.send('{"id":1,"result":{"data":[],"nextCursor":null}}\n{"id":2,"result":{"account":null,"requiresOpenaiAuth":true}}\n')
    await expect(quick).resolves.toMatchObject({ requiresOpenaiAuth: true })
    expect(client.signal.aborted).toBe(false)
    expect(process.kills).toEqual([])
  })

  it('rejects pending and later requests once the process exits, naming the exit and stderr', async () => {
    const process = new FakeProcess()
    const client = new CodexAppServerClient(process)
    const pending = client.request('turn/start', { threadId: 't', input: [] })
    process.stderr.write('panic: boom\n')
    await tick()
    process.exit(101)
    const error = await pending.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CodexAppServerExitedError)
    expect(error).toMatchObject({ message: 'Codex app-server exited with code 101: panic: boom', exitCode: 101 })
    expect(client.signal.aborted).toBe(true)
    expect(client.signal.reason).toBe(error)
    await expect(client.request('account/read', {})).rejects.toBe(error)
    expect(() => client.notify('initialized')).not.toThrow()
  })

  it('treats a closed stdout as the end of the process', async () => {
    const process = new FakeProcess()
    const client = new CodexAppServerClient(process)
    const pending = client.request('account/read', {})
    process.stdout.end()
    await expect(pending).rejects.toThrow('Codex app-server closed its output')
  })

  it('answers server requests from the handler, with errors, and refuses them without one', async () => {
    const process = new FakeProcess()
    const client = new CodexAppServerClient(process)
    process.send('{"id":"a","method":"item/tool/requestUserInput","params":{}}\n')
    await tick()
    client.setServerRequestHandler(async (request) => {
      if (request.method === 'boom') throw new CodexRpcError('boom', -32601, 'unsupported')
      if (request.method === 'fail') throw new Error('handler failed')
      return { decision: 'accept', echo: request.params }
    })
    process.send('{"id":7,"method":"item/commandExecution/requestApproval","params":{"x":1}}\n{"id":8,"method":"boom"}\n{"id":9,"method":"fail"}\n')
    await tick()
    await tick()
    expect(process.written).toEqual([
      { id: 'a', error: { code: -32601, message: 'Unsupported request item/tool/requestUserInput' } },
      { id: 7, result: { decision: 'accept', echo: { x: 1 } } },
      { id: 8, error: { code: -32601, message: 'unsupported' } },
      { id: 9, error: { code: -32603, message: 'handler failed' } }
    ])
  })

  it('aborts a request through its signal and kills the process on close', async () => {
    vi.useFakeTimers()
    const process = new FakeProcess()
    const client = new CodexAppServerClient(process)
    const controller = new AbortController()
    const pending = client.request('turn/interrupt', { threadId: 't', turnId: 'u' }, { signal: controller.signal })
    controller.abort(new Error('stop'))
    await expect(pending).rejects.toThrow('stop')
    client.close()
    expect(client.signal.aborted).toBe(true)
    expect(process.kills).toEqual([undefined])
    vi.advanceTimersByTime(3_000)
    expect(process.kills).toEqual([undefined, 'SIGKILL'])
  })
})

describe('codex config overrides', () => {
  it('renders TOML values for -c arguments', () => {
    expect(tomlValue('a "b"')).toBe('"a \\"b\\""')
    expect(tomlValue(3600)).toBe('3600')
    expect(tomlValue(true)).toBe('true')
    expect(tomlValue(['x', 1])).toBe('["x", 1]')
    expect(tomlValue({ Authorization: 'Bearer t', 'x.y': 1 })).toBe('{ Authorization = "Bearer t", "x.y" = 1 }')
    expect(codexConfigArgs({ 'mcp_servers.mousse.url': 'http://127.0.0.1:1/mcp', 'mcp_servers.mousse.tool_timeout_sec': 60 })).toEqual([
      '-c',
      'mcp_servers.mousse.url="http://127.0.0.1:1/mcp"',
      '-c',
      'mcp_servers.mousse.tool_timeout_sec=60'
    ])
  })
})
