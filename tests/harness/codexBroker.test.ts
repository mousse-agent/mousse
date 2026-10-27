import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isChatgptTokenArgv, runChatgptToken } from '../../src/cli/fastpath/chatgptToken'
import { ChatGptTokenBroker, writeWithDeadline, type ChatGptTokenBrokerOptions } from '../../src/mms/harness/codex/broker'
import { encodeTokenRequest, parseTokenRequest } from '../../src/mms/harness/codex/tokenProtocol'
import { chatgptTokenCommand } from '../../src/mms/run/mcp/attachment'

const repoRoot = resolve(__dirname, '..', '..')
const brokers: ChatGptTokenBroker[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(brokers.splice(0).map((broker) => broker.close()))
})

async function startBroker(options: ChatGptTokenBrokerOptions = {}): Promise<{ broker: ChatGptTokenBroker; endpoint: string }> {
  const broker = new ChatGptTokenBroker(options)
  brokers.push(broker)
  return { broker, endpoint: await broker.start() }
}

function capture(): { io: { stdout: Writable; stderr: Writable }; stdout: () => string; stderr: () => string } {
  const out: string[] = []
  const err: string[] = []
  const sink = (into: string[]) => new Writable({ write(chunk, _encoding, callback) { into.push(String(chunk)); callback() } })
  return { io: { stdout: sink(out), stderr: sink(err) }, stdout: () => out.join(''), stderr: () => err.join('') }
}

async function helper(endpoint: string, leaseId: string, waitMs?: number) {
  const output = capture()
  const code = await runChatgptToken(['engine', 'chatgpt-token', endpoint, leaseId], output.io, waitMs ? { waitMs } : {})
  return { code, stdout: output.stdout(), stderr: output.stderr() }
}

function lease(broker: ChatGptTokenBroker, access: (signal: AbortSignal) => Promise<string>, instanceId = 'codex:managed') {
  return broker.register({ profileId: 'default', instanceId, profileKey: 'key-1', credentialEpoch: 1, access })
}

/** A raw client: what it received, and when the broker closed it. */
function rawClient(endpoint: string): { socket: Socket; received: () => string; closed: Promise<void> } {
  const socket = connect(endpoint)
  let data = ''
  socket.on('data', (chunk) => (data += String(chunk)))
  socket.on('error', () => undefined)
  return { socket, received: () => data, closed: new Promise((done) => socket.once('close', () => done())) }
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

describe('ChatGPT token broker and helper', () => {
  it('hands the lease token to the helper, which prints only the token', async () => {
    const { broker, endpoint } = await startBroker()
    const seen: string[] = []
    const { leaseId } = lease(broker, async () => {
      seen.push('access')
      return 'eyJ.token-1'
    })
    const result = await helper(endpoint, leaseId)
    expect(result).toEqual({ code: 0, stdout: 'eyJ.token-1', stderr: '' })
    expect(seen).toEqual(['access'])
  })

  it('refuses an unknown lease, a released one and a revoked instance with one stderr line', async () => {
    const { broker, endpoint } = await startBroker()
    const unknown = await helper(endpoint, 'a'.repeat(32))
    expect(unknown.code).toBe(1)
    expect(unknown.stdout).toBe('')
    expect(unknown.stderr).toMatch(/^[^\n]+\n$/)

    const released = lease(broker, async () => 'token')
    released.release()
    expect((await helper(endpoint, released.leaseId)).code).toBe(1)

    const first = lease(broker, async () => 'token')
    const other = lease(broker, async () => 'other-token', 'codex:other')
    broker.revokeInstance('codex:managed')
    const revoked = await helper(endpoint, first.leaseId)
    expect(revoked.code).toBe(1)
    expect(revoked.stderr).toMatch(/no longer allowed/)
    expect((await helper(endpoint, other.leaseId)).stdout).toBe('other-token')
  })

  it('refuses a lease revoked while its token was being resolved', async () => {
    const { broker, endpoint } = await startBroker()
    let release!: () => void
    const { leaseId } = lease(broker, () => new Promise((done) => (release = () => done('late-token'))))
    const pending = helper(endpoint, leaseId)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    broker.revokeInstance('codex:managed')
    release()
    const result = await pending
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
  })

  it('gives an admitted request the resolution deadline, not the idle one', async () => {
    // The refresh takes ten times the idle deadline and still answers.
    const { broker, endpoint } = await startBroker({ idleMs: 100, resolveMs: 5_000 })
    const { leaseId } = lease(broker, async () => {
      await delay(1_000)
      return 'slow-token'
    })
    expect(await helper(endpoint, leaseId)).toEqual({ code: 0, stdout: 'slow-token', stderr: '' })
  })

  it('fails a request whose token is not resolved within the resolution deadline', async () => {
    const { broker, endpoint } = await startBroker({ resolveMs: 150 })
    let aborted = false
    const { leaseId } = lease(broker, (signal) => new Promise((_done, fail) => signal.addEventListener('abort', () => {
      aborted = true
      fail(signal.reason)
    })))
    const result = await helper(endpoint, leaseId)
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/in time/)
    expect(aborted).toBe(true)
  })

  it('passes a typed sign-in failure through and hides any other', async () => {
    const { broker, endpoint } = await startBroker()
    const typed = lease(broker, async () => {
      throw Object.assign(new Error('Sign in to ChatGPT again.'), { failure: 'auth_expired' })
    })
    expect((await helper(endpoint, typed.leaseId)).stderr).toBe('Sign in to ChatGPT again.\n')
    const untyped = lease(broker, async () => {
      throw new Error('upstream said refresh_token=secret')
    })
    const hidden = await helper(endpoint, untyped.leaseId)
    expect(hidden.code).toBe(1)
    expect(hidden.stderr).not.toMatch(/secret/)
  })

  it('drops an incomplete request at the idle deadline without writing anything', async () => {
    const { endpoint } = await startBroker({ idleMs: 150 })
    const client = rawClient(endpoint)
    client.socket.write('{"version":1,"lease')
    const started = Date.now()
    await client.closed
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
    expect(client.received()).toBe('')
  })

  it('answers a request with extra keys, or trailing bytes, with nothing usable', async () => {
    const { broker, endpoint } = await startBroker()
    const { leaseId } = lease(broker, async () => 'token')
    const extra = rawClient(endpoint)
    extra.socket.write(`${JSON.stringify({ version: 1, leaseId, more: true })}\n`)
    await extra.closed
    expect(extra.received()).toMatch(/^\{"error":/)
    const trailing = rawClient(endpoint)
    trailing.socket.write(`${encodeTokenRequest(leaseId)}x`)
    await trailing.closed
    expect(trailing.received()).toBe('')
  })

  it('drops a peer that stops reading at the deadline of the blocked write', async () => {
    vi.useFakeTimers()
    const stuck = new Writable({ highWaterMark: 1, write() { /* never completes */ } })
    const outcome = writeWithDeadline(stuck, '{"token":"x"}\n', 5_000)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(stuck.destroyed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toBe(false)
    expect(stuck.destroyed).toBe(true)
  })

  it('caps connections and admitted jobs', async () => {
    const { broker, endpoint } = await startBroker({ maxConnections: 2, maxJobs: 1, idleMs: 2_000 })
    const idle = [rawClient(endpoint), rawClient(endpoint)]
    await delay(100)
    const third = rawClient(endpoint)
    await third.closed
    expect(third.received()).toBe('')
    idle.forEach((client) => client.socket.destroy())
    await Promise.all(idle.map((client) => client.closed))
    await vi.waitFor(() => expect((broker as unknown as { sockets: Set<unknown> }).sockets.size).toBe(0))

    let release!: () => void
    const held = lease(broker, () => new Promise((done) => (release = () => done('held-token'))))
    const first = helper(endpoint, held.leaseId)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const second = await helper(endpoint, lease(broker, async () => 'other').leaseId)
    expect(second.code).toBe(1)
    expect(second.stderr).toMatch(/busy/)
    release()
    expect((await first).stdout).toBe('held-token')
  })

  it.skipIf(process.platform === 'win32')('makes a private socket folder and removes only its own', async () => {
    const root = mkdtempSync(join(tmpdir(), 'broker-root-'))
    chmodSync(root, 0o700)
    try {
      const { broker, endpoint } = await startBroker({ tempRoots: [root] })
      expect(statSync(dirname(endpoint)).mode & 0o777).toBe(0o700)
      expect(statSync(endpoint).mode & 0o777).toBe(0o600)
      await broker.close()
      expect(existsSync(dirname(endpoint))).toBe(false)

      chmodSync(root, 0o777)
      await expect(new ChatGptTokenBroker({ tempRoots: [root] }).start()).rejects.toThrow(/private temporary folder/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses a random named pipe on Windows', async () => {
    const broker = new ChatGptTokenBroker({ platform: 'win32' })
    const path = (broker as unknown as { endpointPath(): string }).endpointPath()
    expect(path).toMatch(/^\\\\\.\\pipe\\mousse-chatgpt-[0-9a-f-]{36}$/)
  })
})

describe('the token helper', () => {
  it('sends exactly the request the broker reads', async () => {
    const lines: string[] = []
    const server = createServer((socket) => {
      socket.once('data', (chunk) => {
        lines.push(String(chunk))
        socket.end('{"token":"t"}\n')
      })
    })
    const path = process.platform === 'win32' ? `\\\\.\\pipe\\mousse-test-${process.pid}-${Date.now()}` : join(mkdtempSync(join(tmpdir(), 'helper-')), 's')
    await new Promise<void>((done) => server.listen(path, done))
    try {
      const leaseId = 'b'.repeat(32)
      expect((await helper(path, leaseId)).stdout).toBe('t')
      expect(lines).toEqual([encodeTokenRequest(leaseId)])
      expect(parseTokenRequest(lines[0]!.trimEnd())).toEqual({ version: 1, leaseId })
    } finally {
      server.close()
    }
  })

  it('fails with one line when Mousse is not running or the arguments are wrong', async () => {
    const missing = await helper(process.platform === 'win32' ? '\\\\.\\pipe\\mousse-missing-pipe' : join(tmpdir(), 'mousse-missing.sock'), 'c'.repeat(32))
    expect(missing.code).toBe(1)
    expect(missing.stderr).toMatch(/^[^\n]+\n$/)
    const output = capture()
    expect(await runChatgptToken(['engine', 'chatgpt-token', 'x', 'not-a-lease'], output.io)).toBe(1)
    expect(output.stderr()).toMatch(/^Usage:/)
    expect(isChatgptTokenArgv(['engine', 'chatgpt-token'])).toBe(true)
    expect(isChatgptTokenArgv(['engine', 'mcp-stdio'])).toBe(false)
  })

  it('names the helper command for Codex', () => {
    expect(chatgptTokenCommand('ep', 'id', { command: 'mousse', args: ['--cli'], env: { MOUSSE_CLI: '1' } }))
      .toEqual({ command: 'mousse', args: ['--cli', 'engine', 'chatgpt-token', 'ep', 'id'], env: { MOUSSE_CLI: '1' } })
  })

  it('loads nothing from the app: its import graph holds only Node built-ins', () => {
    const entry = join(repoRoot, 'src/cli/fastpath/chatgptToken.ts')
    const options: ts.CompilerOptions = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true }
    const seen = new Set<string>()
    const external = new Set<string>()
    const queue = [entry]
    while (queue.length) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      for (const reference of ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles) {
        const resolved = ts.resolveModuleName(reference.fileName, file, options, ts.sys).resolvedModule
        if (resolved && !resolved.isExternalLibraryImport && !resolved.resolvedFileName.endsWith('.d.ts')) queue.push(resolve(resolved.resolvedFileName))
        else external.add(reference.fileName)
      }
    }
    expect([...seen].map((file) => file.slice(repoRoot.length + 1).split('\\').join('/'))).toEqual(['src/cli/fastpath/chatgptToken.ts'])
    for (const name of external) expect(name).toMatch(/^node:(net|fs)$/)
  })

  it('is dispatched by the CLI before the CLI main module loads', () => {
    const source = readFileSync(join(repoRoot, 'src/cli/index.ts'), 'utf8')
    expect(source).not.toMatch(/^import .*['"]\.\/runCliMain['"]/m)
    expect(source.indexOf('isChatgptTokenArgv(argv)')).toBeLessThan(source.indexOf("import('./runCliMain')"))
    const main = readFileSync(join(repoRoot, 'src/main/index.ts'), 'utf8')
    expect(main.indexOf('isChatgptTokenArgv(electronCliArgv())')).toBeLessThan(main.indexOf('configureElectronContext(app, isCliMode'))
  })
})

describe('the token helper delivers the whole token before it exits', () => {
  it('resolves only after the stream flushed the token, even when write() reports room', async () => {
    const { broker, endpoint } = await startBroker()
    const { leaseId } = lease(broker, async () => 'eyJ.flushed')
    let flush: (() => void) | undefined
    const written: string[] = []
    const slow = new Writable({
      write(chunk, _encoding, callback) {
        written.push(String(chunk))
        flush = callback
      }
    })
    let done = false
    const running = runChatgptToken(['engine', 'chatgpt-token', endpoint, leaseId], { stdout: slow, stderr: capture().io.stderr }).then((code) => {
      done = true
      return code
    })
    await vi.waitFor(() => expect(written).toEqual(['eyJ.flushed']))
    await delay(50)
    expect(done).toBe(false)
    flush!()
    expect(await running).toBe(0)
  })

  it('the standalone helper prints exactly the token over a pipe and exits 0; a bad lease exits 1 with one line', async () => {
    const { build } = await import('esbuild')
    const dir = mkdtempSync(join(tmpdir(), 'mousse-helper-'))
    try {
      const script = join(dir, 'chatgpt-token.mjs')
      await build({ entryPoints: [join(repoRoot, 'src/cli/fastpath/chatgptTokenMain.ts')], outfile: script, bundle: true, platform: 'node', format: 'esm', logLevel: 'error' })
      const { broker, endpoint } = await startBroker()
      const token = `eyJ.${'x'.repeat(48 * 1024)}`
      const { leaseId } = lease(broker, async () => token)
      const { spawn } = await import('node:child_process')
      const run = (id: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
        const child = spawn(process.execPath, [script, endpoint, id], { stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => (stdout += String(chunk)))
        child.stderr.on('data', (chunk) => (stderr += String(chunk)))
        child.on('close', (code) => done({ code, stdout, stderr }))
      })
      expect(await run(leaseId)).toEqual({ code: 0, stdout: token, stderr: '' })
      const refused = await run('0'.repeat(32))
      expect(refused.code).toBe(1)
      expect(refused.stdout).toBe('')
      expect(refused.stderr.trim().split('\n')).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
