/**
 * PR 2c review round 2.
 * - Credential retirement is serialized against starts and forks: a start or fork that comes
 *   while it cleans up waits, so the new credential's `auth.json`, branch and session survive it.
 * - What a credential change retires depends on what changed: an OAuth sign-in, sign-out or account
 *   change retires every process; a key or ambient change only idle ones; an unchanged credential
 *   (a re-verify, a cancelled prompt, a failed sign-in) nothing.
 * - A verified Bedrock or Vertex sign-in's `<authenticated>` marker is no key: the identity comes
 *   from the environment, and Pi is never handed it.
 * - A native fork whose first turn failed works on the resend: the orchestrator forks again and the
 *   new branch is resumed although the thread's history now holds the failed turn's message.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DriverContext } from '../../src/mms/harness/driver'
import { createRpcRuntime } from '../../src/mms/harness/drivers/pi/engines/rpc'
import { piCredentialSubject, piRpcProfileOptions, type PiProfileAuth } from '../../src/mms/harness/drivers/pi/profile'
import { PiRpcEngine } from '../../src/mms/harness/pi/engine'
import { piRuntimePaths } from '../../src/mms/harness/pi/launch'
import { writePiAuth, type PiOAuthSource } from '../../src/mms/harness/pi/oauthBroker'
import { CLAUDE, claudeAdapter, phase6Daemon, piAdapter, PI } from '../run/phase6Fixture'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean()
  vi.restoreAllMocks()
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-pi-retire-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const unused = () => { throw new Error('must not spawn or reach a provider') }
const grant = (id: string) => ({ access: `fake-${id}`, expires: Date.now() + 3_600_000, fields: {}, subject: `credential:${id}` })

/** An engine whose processes are never spawned (the launch input throws), over a fake vault. */
function fixture() {
  const dir = scratch()
  const home = join(dir, 'home')
  mkdirSync(home)
  let current = grant('A')
  const oauth: PiOAuthSource = { credential: async () => current, refresh: async () => current }
  const engine = new PiRpcEngine({ instanceId: 'pi:openrouter', provider: 'openrouter', label: 'OpenRouter', capabilities: {} as never, env: () => ({ home, env: {} }) as never, stateDir: dir, runtime: unused, catalog: unused, oauth })
  cleanups.push(() => engine.stop())
  const internals = engine as unknown as {
    bridge: { start(): Promise<void>; register(handlers: unknown): unknown }
    closing: Set<{ closed: Promise<unknown> }>
    threads: Map<string, unknown>
    start(thread: unknown): Promise<void>
    send(thread: unknown, command: { type: string }): Promise<unknown>
    processFor(...args: unknown[]): Promise<unknown>
    runTurn(...args: unknown[]): Promise<unknown>
  }
  return { dir, home, engine, internals, replace: (id: string) => { current = grant(id) } }
}

function session(dir: string, id: string, cwd: string): string {
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  const file = join(dir, 'sessions', `2026-10-27T00-00-00-000Z_${id}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ type: 'session', id, cwd })}\n`)
  return file
}

/** Holds the old processes' cleanup until `release`. */
function heldCleanup(internals: ReturnType<typeof fixture>['internals']) {
  let release!: () => void
  const old = { closed: new Promise<void>((resolve) => (release = resolve)) }
  internals.closing.add(old)
  return () => {
    release()
    internals.closing.delete(old)
  }
}

describe('credential retirement against starts and forks', () => {
  it('keeps the auth.json a start of the new credential writes while old processes still close', async () => {
    const s = fixture()
    const release = heldCleanup(s.internals)
    const retiring = s.engine.retireCredentials()
    s.replace('B')
    vi.spyOn(s.internals.bridge, 'start').mockResolvedValue(undefined)
    vi.spyOn(s.internals.bridge, 'register').mockReturnValue({ address: {}, close: () => {} })
    // The start waits for the retirement, then writes B's credential (and fails at the launch seam).
    const start = s.internals.start({ model: 'm', thinking: 'off', threadId: 'new', cancelled: false })
    release()
    await retiring
    await expect(start).rejects.toThrow('must not spawn')
    expect(JSON.parse(readFileSync(join(s.home, 'auth.json'), 'utf8')).openrouter.access).toBe('fake-B')
  })

  it('keeps a fork made while old processes still close, with its session', async () => {
    const s = fixture()
    const file = join(s.dir, 'threads.json')
    session(s.dir, 'parent', s.dir)
    const branchFile = session(s.dir, 'branch', s.dir)
    writeFileSync(file, JSON.stringify({ source: { sessionId: 'parent', turnLeaves: { sourceTurn: 'leaf' } } }))
    const release = heldCleanup(s.internals)
    const retiring = s.engine.retireCredentials()
    vi.spyOn(s.internals, 'start').mockResolvedValue(undefined)
    vi.spyOn(s.internals, 'send').mockImplementation(async (_thread, command) => (command.type === 'get_entries' ? { entries: [] } : command.type === 'clone' ? { cancelled: false } : { sessionId: 'branch' }))
    const forking = s.engine.forkSession({ provider: 'openrouter', sessionId: 'parent', nativeTurnId: 'sourceTurn', model: 'm' }, 1, { threadId: 'fork' })
    release()
    await retiring
    expect((await forking)?.sessionId).toBe('branch')
    expect(JSON.parse(readFileSync(file, 'utf8')).fork).toMatchObject({ sessionId: 'branch', pendingFork: true })
    expect(existsSync(branchFile)).toBe(true)
    // The fork's first turn resumes the branch, not an empty session.
    const processFor = vi.spyOn(s.internals, 'processFor').mockResolvedValue({ thread: {}, resumed: true })
    vi.spyOn(s.internals, 'runTurn').mockResolvedValue({ text: 'with parent context', aborted: false })
    const input = { threadId: 'fork', instanceId: 'pi:openrouter', llmProvider: 'openrouter', model: 'm', mode: 'agent', prompt: 'Continue', messages: [], nativeHistory: '', cwd: s.dir, signal: new AbortController().signal }
    await expect(s.engine.startTurn(input as never, { providerRef: () => {} } as never, {} as never, {} as never)).resolves.toMatchObject({ text: 'with parent context' })
    expect(processFor.mock.calls[0]?.[2]).toBe('branch')
  })
})

describe('what a credential change retires', () => {
  function runtimeWith(subjects: Array<string | undefined>, signIn = vi.fn(async () => ({ success: true }))) {
    const dir = scratch()
    const home = join(dir, 'home')
    mkdirSync(home)
    let index = 0
    const identity = () => subjects[Math.min(index++, subjects.length - 1)]
    const context = { instanceId: 'pi:openrouter', builtIn: true, config: { home: 'default', engine: 'rpc' }, env: { home, env: {} }, profileHome: dir, installationHome: dir, stateDir: dir, questions: {}, findBinary: () => undefined, changed: () => {} } as unknown as DriverContext
    const runtime = createRpcRuntime(context, 'openrouter', 'OpenRouter', () => ({ logout: async () => {}, runOAuthLogin: signIn, runApiKeyLogin: signIn }) as never, { runtime: unused, catalog: unused, identity })
    cleanups.push(() => runtime.stop())
    const retire = vi.spyOn(runtime.adapter as unknown as { retireCredentials(): Promise<void> }, 'retireCredentials').mockResolvedValue(undefined)
    const idle = vi.spyOn(runtime.adapter as unknown as { releaseIdle(): void }, 'releaseIdle')
    return { runtime, retire, idle, dir }
  }

  it('retires nothing for an unchanged credential (a re-verify, a cancelled prompt)', async () => {
    const s = runtimeWith(['ambient:x', 'ambient:x'])
    await s.runtime.identity!(new AbortController().signal)
    await s.runtime.credentialsChanged!()
    expect(s.retire).not.toHaveBeenCalled()
    expect(s.idle).not.toHaveBeenCalled()
  })

  it('lets running turns finish for a key change', async () => {
    const s = runtimeWith(['apikey:one', 'apikey:two'])
    await s.runtime.identity!(new AbortController().signal)
    await s.runtime.credentialsChanged!()
    expect(s.retire).not.toHaveBeenCalled()
    expect(s.idle).toHaveBeenCalledTimes(1)
  })

  it('retires every process for an OAuth sign-out or another account', async () => {
    const out = runtimeWith(['oauth:a', undefined])
    await out.runtime.signOut!()
    expect(out.retire).toHaveBeenCalledTimes(1)
    const other = runtimeWith(['oauth:a', 'oauth:b'])
    await other.runtime.signIn!({} as never, other.dir, 'oauth')
    expect(other.retire).toHaveBeenCalledTimes(1)
  })

  it('retires nothing for a sign-in that did not succeed', async () => {
    const s = runtimeWith(['oauth:a', 'oauth:b'], vi.fn(async () => ({ success: false })))
    await s.runtime.signIn!({} as never, s.dir, 'oauth')
    expect(s.retire).not.toHaveBeenCalled()
    expect(s.idle).not.toHaveBeenCalled()
  })
})

describe('a verified ambient sign-in', () => {
  it('names the environment’s account, not the stored marker, and hands Pi no key', () => {
    const marker = { type: 'api_key', key: '<authenticated>' }
    const one = piCredentialSubject('amazon-bedrock', marker, { AWS_PROFILE: 'one' })
    expect(one).toMatch(/^ambient:/)
    expect(piCredentialSubject('amazon-bedrock', marker, { AWS_PROFILE: 'two' })).not.toBe(one)
    const auth = { has: () => true, storedApiKey: () => '<authenticated>', models: { getModels: () => [] }, credentials: { get: () => marker } } as unknown as PiProfileAuth
    expect(piRpcProfileOptions({ auth: () => auth, runtime: piRuntimePaths(process.platform === 'win32' ? 'C:\\mousse' : '/mousse') })!.apiKey!('amazon-bedrock')).toBeUndefined()
  })
})

describe('a native fork whose first turn failed', () => {
  it('resumes the new branch on the resend, through the orchestrator', async () => {
    const s = fixture()
    const priorHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = s.dir
    cleanups.push(() => {
      if (priorHome === undefined) delete process.env.MOUSSE_HOME
      else process.env.MOUSSE_HOME = priorHome
    })
    session(s.dir, 'parent', s.dir)
    writeFileSync(join(s.dir, 'threads.json'), JSON.stringify({ source: { sessionId: 'parent', turnLeaves: { sourceTurn: 'leaf' } } }))
    vi.spyOn(s.internals, 'start').mockResolvedValue(undefined)
    let branches = 0
    vi.spyOn(s.internals, 'send').mockImplementation(async (_thread, command) => {
      if (command.type === 'get_entries') return { entries: [] }
      if (command.type === 'clone') return { cancelled: false }
      const id = `branch-${++branches}`
      session(s.dir, id, s.dir)
      return { sessionId: id }
    })
    const resumed: unknown[] = []
    vi.spyOn(s.internals, 'processFor').mockImplementation(async (...args: unknown[]) => {
      resumed.push(args[2])
      return { thread: {}, resumed: true }
    })
    vi.spyOn(s.internals, 'runTurn').mockResolvedValue({ text: 'fork reply', aborted: false, providerRef: { provider: 'openai', sessionId: 'branch-2' } })
    const adapter = piAdapter(() => 'parent answer', { fork: 'native', historyInjection: 'prompt', containment: 'weak' }, 'parent')
    const base = adapter.startTurn.bind(adapter)
    let sourceId = ''
    const received: Array<{ nativeHistory?: string }> = []
    adapter.startTurn = async (input, sink, ctl, host) => {
      if (input.threadId === sourceId) {
        const result = await base(input, sink, ctl, host)
        result.providerRef = { ...result.providerRef!, nativeTurnId: 'sourceTurn' }
        sink.providerRef(result.providerRef)
        return result
      }
      received.push(input)
      return s.engine.startTurn(input, sink, ctl, host)
    }
    adapter.forkSession = async (ref, ordinal, target) => {
      const branched = await s.engine.forkSession(ref, ordinal, target)
      // The first branch is lost before its turn (a cleanup, a crash): that turn fails.
      if (branches === 1) rmSync(join(s.dir, 'sessions', '2026-10-27T00-00-00-000Z_branch-1.jsonl'))
      return branched
    }
    const d = phase6Daemon(s.dir, [adapter])
    cleanups.push(() => d.stop())
    sourceId = d.store.createThread('Source').id
    d.orch.setThreadModelOverride(sourceId, PI)
    expect((await d.orch.send('Parent request', false, { threadId: sourceId, clientRequestId: 'parent' })).error).toBeUndefined()
    const fork = await d.engine.forkThread({ sourceThreadId: sourceId, clientRequestId: 'fork' })
    const first = await d.orch.send('Continue', false, { threadId: fork.threadId, clientRequestId: 'try-1' })
    expect(first.error?.code).toBe('binding_stale')
    expect(d.engine.transfers.get(fork.transferId)?.status).toBe('pending')
    // The resend forks again; the new branch is resumed although the history now holds the failed message.
    const second = await d.orch.send('Continue', false, { threadId: fork.threadId, clientRequestId: 'try-2' })
    expect(second.error).toBeUndefined()
    expect(branches).toBe(2)
    expect(received[1]?.nativeHistory).toContain('Continue')
    expect(resumed).toEqual(['branch-2'])
  })
})

describe('review round 3', () => {
  const turnInput = (threadId: string, nativeHistory = '', cwd?: string) => ({ runId: 'r', attemptId: 'a', threadId, instanceId: 'pi:openrouter', llmProvider: 'openrouter', model: 'm', mode: 'agent', prompt: 'hello', messages: [], nativeHistory, ...(cwd ? { cwd } : {}), signal: new AbortController().signal }) as never

  it('retires an OAuth turn when a turn’s identity read sees the change before the notification', async () => {
    const dir = scratch()
    const home = join(dir, 'home')
    mkdirSync(home)
    let subject = 'oauth:account-A'
    const context = { instanceId: 'pi:openrouter', builtIn: true, config: { home: 'default', engine: 'rpc' }, env: { home, env: {} }, profileHome: dir, installationHome: dir, stateDir: dir, questions: {}, findBinary: () => undefined, changed: () => {} } as unknown as DriverContext
    const runtime = createRpcRuntime(context, 'openrouter', 'OpenRouter', () => ({}) as never, { runtime: unused, catalog: unused, identity: () => subject, oauth: { credential: async () => undefined, refresh: async () => undefined } })
    cleanups.push(() => runtime.stop())
    const engine = runtime.adapter as unknown as { threads: Map<string, { cancelled?: boolean }> }
    await runtime.identity!(new AbortController().signal)
    const old = { threadId: 'old', turn: {}, cancelled: false }
    engine.threads.set('old', old)
    writePiAuth(home, 'openrouter', { type: 'oauth', access: 'fake-account-A', refresh: 'fake-handle', expires: Date.now() + 3_600_000 })
    // `providers.setApiKey` wrote the key and awaits a model refresh; a bind reads the identity meanwhile.
    subject = 'apikey:account-B'
    await runtime.identity!(new AbortController().signal)
    await runtime.credentialsChanged!()
    await vi.waitFor(() => expect(existsSync(join(home, 'auth.json'))).toBe(false))
    expect(old.cancelled).toBe(true)
    expect(engine.threads.has('old')).toBe(false)
  })

  it('lets a start that comes during a retirement wait for it instead of being killed by it', async () => {
    const s = fixture()
    vi.spyOn(s.internals.bridge, 'start').mockResolvedValue(undefined)
    vi.spyOn(s.internals.bridge, 'register').mockReturnValue({ address: {}, close: () => {} })
    const release = heldCleanup(s.internals)
    const retiring = s.engine.retireCredentials()
    const start = s.engine.startTurn(turnInput('new'), { providerRef: () => {} } as never, {} as never, {} as never)
    const outcome = start.then(() => 'resolved', (error: Error) => error.message)
    await Promise.resolve()
    release()
    await retiring
    // It reached the launch (the test seam throws there), not "is stopping".
    expect(await outcome).toContain('must not spawn')
  })

  it('drops a fork branch when the orchestrator hands the history over in the prompt', async () => {
    const s = fixture()
    session(s.dir, 'stale-branch', s.dir)
    writeFileSync(join(s.dir, 'threads.json'), JSON.stringify({ fork: { sessionId: 'stale-branch', historyFingerprint: createHashOf(''), pendingFork: true } }))
    const handOver = vi.spyOn(s.internals as unknown as { handOver(...args: unknown[]): Promise<unknown> }, 'handOver').mockResolvedValue({ thread: {}, resumed: false })
    const processFor = vi.spyOn(s.internals, 'processFor')
    vi.spyOn(s.internals, 'runTurn').mockResolvedValue({ text: 'handed over', aborted: false })
    // The re-fork did not happen, so the fork's plan is portable: the parent's history is in the prompt.
    await s.engine.startTurn({ ...(turnInput('fork', 'user: Continue', s.dir) as object), historyHandedOver: true } as never, { providerRef: () => {} } as never, {} as never, {} as never)
    expect(handOver).toHaveBeenCalledTimes(1)
    expect(processFor).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(s.dir, 'threads.json'), 'utf8')).fork).toBeUndefined()
  })

  it('stops idle processes for a key change, and a started process is no longer “starting”', async () => {
    const s = fixture()
    vi.spyOn(s.internals, 'start').mockResolvedValue(undefined)
    const started = await s.internals.processFor(turnInput('t1', '', s.dir), s.dir, undefined, { threadId: 't1', cancelled: false }) as { thread: { starting?: unknown; warm?: unknown } }
    expect(started.thread.starting).toBeUndefined()
    // Idle in its warm period, and one running a turn.
    started.thread.warm = setTimeout(() => {}, 60_000)
    const busy = { threadId: 'busy', turn: {}, cancelled: false }
    s.internals.threads.set('busy', busy)
    s.engine.releaseIdle()
    expect(s.internals.threads.has('t1')).toBe(false)
    expect(s.internals.threads.get('busy')).toBe(busy)
    s.internals.threads.delete('busy')
  })

  it('runs a retirement after a failed one, and retires processes even when the thread list cannot be written', async () => {
    const s = fixture()
    const internals = s.internals as unknown as { retire(): Promise<void>; save(...args: unknown[]): void }
    const retire = vi.spyOn(internals, 'retire').mockRejectedValueOnce(new Error('first failed'))
    const first = s.engine.retireCredentials()
    const second = s.engine.retireCredentials()
    await expect(first).rejects.toThrow('first failed')
    await second
    expect(retire).toHaveBeenCalledTimes(2)
    retire.mockRestore()
    writeFileSync(join(s.dir, 'threads.json'), JSON.stringify({ fork: { sessionId: 'b', pendingFork: true } }))
    writePiAuth(s.home, 'openrouter', { type: 'oauth', access: 'fake-A', refresh: 'h', expires: Date.now() + 3_600_000 })
    const old = { threadId: 'old', turn: {}, cancelled: false }
    s.internals.threads.set('old', old)
    vi.spyOn(internals, 'save').mockImplementation(() => { throw new Error('disk full') })
    await s.engine.retireCredentials()
    expect(old.cancelled).toBe(true)
    expect(existsSync(join(s.home, 'auth.json'))).toBe(false)
  })
})

function createHashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

describe('a re-forked branch the thread moved past', () => {
  it('is resumed with the delta of a turn on another provider (through the orchestrator)', async () => {
    const s = fixture()
    const priorHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = s.dir
    cleanups.push(() => {
      if (priorHome === undefined) delete process.env.MOUSSE_HOME
      else process.env.MOUSSE_HOME = priorHome
    })
    session(s.dir, 'parent', s.dir)
    writeFileSync(join(s.dir, 'threads.json'), JSON.stringify({ source: { sessionId: 'parent', turnLeaves: { sourceTurn: 'leaf' } } }))
    vi.spyOn(s.internals, 'start').mockResolvedValue(undefined)
    let branches = 0
    vi.spyOn(s.internals, 'send').mockImplementation(async (_thread, command) => {
      if (command.type === 'get_entries') return { entries: [] }
      if (command.type === 'clone') return { cancelled: false }
      const id = `branch-${++branches}`
      session(s.dir, id, s.dir)
      return { sessionId: id }
    })
    const processFor = vi.spyOn(s.internals, 'processFor').mockResolvedValue({ thread: {}, resumed: true })
    const handOver = vi.spyOn(s.internals as unknown as { handOver(...args: unknown[]): Promise<unknown> }, 'handOver').mockResolvedValue({ thread: {}, resumed: false })
    vi.spyOn(s.internals, 'runTurn').mockResolvedValue({ text: 'back on pi', aborted: false, providerRef: { provider: 'openai' } })
    const pi = piAdapter(() => 'parent answer', { fork: 'native', historyInjection: 'prompt', containment: 'weak' }, 'parent')
    const base = pi.startTurn.bind(pi)
    let sourceId = ''
    let forkTurns = 0
    pi.startTurn = async (input, sink, ctl, host) => {
      if (input.threadId === sourceId) {
        const result = await base(input, sink, ctl, host)
        result.providerRef = { ...result.providerRef!, nativeTurnId: 'sourceTurn' }
        sink.providerRef(result.providerRef)
        return result
      }
      forkTurns += 1
      // The resend after the failed first turn re-forks, then fails before the engine runs it.
      if (forkTurns === 2) throw Object.assign(new Error('rate limited'), { code: 'rate_limited' })
      return s.engine.startTurn(input, sink, ctl, host)
    }
    pi.forkSession = async (ref, ordinal, target) => {
      const branched = await s.engine.forkSession(ref, ordinal, target)
      if (branches === 1) rmSync(join(s.dir, 'sessions', '2026-10-27T00-00-00-000Z_branch-1.jsonl'))
      return branched
    }
    const claude = claudeAdapter(() => 'answer elsewhere')
    const d = phase6Daemon(s.dir, [pi, claude])
    cleanups.push(() => d.stop())
    sourceId = d.store.createThread('Source').id
    d.orch.setThreadModelOverride(sourceId, PI)
    expect((await d.orch.send('Parent request', false, { threadId: sourceId, clientRequestId: 'parent' })).error).toBeUndefined()
    const fork = await d.engine.forkThread({ sourceThreadId: sourceId, clientRequestId: 'fork' })
    expect((await d.orch.send('Continue', false, { threadId: fork.threadId, clientRequestId: 'try-1' })).error?.code).toBe('binding_stale')
    expect((await d.orch.send('Continue', false, { threadId: fork.threadId, clientRequestId: 'try-2' })).error).toBeTruthy()
    expect(branches).toBe(2)
    // A turn on another provider, then back to Pi's agent.
    d.orch.setThreadModelOverride(fork.threadId, CLAUDE)
    expect((await d.orch.send('Ask elsewhere', false, { threadId: fork.threadId, clientRequestId: 'claude' })).error).toBeUndefined()
    d.orch.setThreadModelOverride(fork.threadId, PI)
    expect((await d.orch.send('Back on pi', false, { threadId: fork.threadId, clientRequestId: 'back' })).error).toBeUndefined()
    // The switch back plans a delta (the Claude turn): Pi resumes the re-forked branch, which holds
    // the parent's history, and the delta in the prompt adds what ran elsewhere.
    const last = processFor.mock.calls.at(-1)!
    expect(last[2]).toBe('branch-2')
    expect((last[0] as { historyHandedOver?: boolean }).historyHandedOver).toBeUndefined()
    expect((last[0] as { prompt: string }).prompt).toContain('strategy="delta"')
    expect((last[0] as { prompt: string }).prompt).toContain('answer elsewhere')
    expect(handOver).not.toHaveBeenCalled()
  })

  it('resumes a re-forked branch whatever the failed or stopped turns left, unless the history was handed over', async () => {
    const s = fixture()
    session(s.dir, 'parent', s.dir)
    writeFileSync(join(s.dir, 'threads.json'), JSON.stringify({ source: { sessionId: 'parent', turnLeaves: { sourceTurn: 'leaf' } } }))
    vi.spyOn(s.internals, 'start').mockResolvedValue(undefined)
    let branches = 0
    vi.spyOn(s.internals, 'send').mockImplementation(async (_thread, command) => {
      if (command.type === 'get_entries') return { entries: [] }
      if (command.type === 'clone') return { cancelled: false }
      const id = `branch-${++branches}`
      session(s.dir, id, s.dir)
      return { sessionId: id }
    })
    const processFor = vi.spyOn(s.internals, 'processFor').mockResolvedValue({ thread: {}, resumed: true })
    const handOver = vi.spyOn(s.internals as unknown as { handOver(...args: unknown[]): Promise<unknown> }, 'handOver').mockResolvedValue({ thread: {}, resumed: false })
    vi.spyOn(s.internals, 'runTurn').mockResolvedValue({ text: 'ok', aborted: false })
    const ref = { provider: 'openrouter', sessionId: 'parent', nativeTurnId: 'sourceTurn', model: 'm' }
    const history = (roles: string[]) => JSON.stringify({ messages: roles.map((role) => ({ role, content: role })) })
    const run = (nativeHistory: string, historyHandedOver = false) => s.engine.startTurn({ threadId: 'fork', instanceId: 'pi:openrouter', llmProvider: 'openrouter', model: 'm', mode: 'agent', prompt: 'Continue', messages: [], nativeHistory, cwd: s.dir, signal: new AbortController().signal, ...(historyHandedOver ? { historyHandedOver } : {}) } as never, { providerRef: () => {} } as never, {} as never, {} as never)
    // The resend after a failed first turn: its message.
    await s.engine.forkSession(ref, 1, { threadId: 'fork' })
    await run(history(['user']))
    expect(processFor.mock.calls.at(-1)?.[2]).toBe('branch-1')
    // The resend after a stopped first turn: its message and the partial reply.
    await s.engine.forkSession(ref, 1, { threadId: 'fork' })
    await run(history(['user', 'assistant']))
    expect(processFor.mock.calls.at(-1)?.[2]).toBe('branch-2')
    expect(handOver).not.toHaveBeenCalled()
    // The history handed over in the prompt (a switch back, or a portable fork plan): dropped.
    await s.engine.forkSession(ref, 1, { threadId: 'fork' })
    await run(history(['user', 'assistant', 'user']), true)
    expect(handOver).toHaveBeenCalledTimes(1)
    expect(JSON.parse(readFileSync(join(s.dir, 'threads.json'), 'utf8')).fork?.sessionId).not.toBe('branch-3')
  })
})

describe('a stopped first fork turn', () => {
  it('keeps the parent context on the resend: the new branch is resumed, nothing is handed over (through the orchestrator)', async () => {
    const s = fixture()
    const priorHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = s.dir
    cleanups.push(() => {
      if (priorHome === undefined) delete process.env.MOUSSE_HOME
      else process.env.MOUSSE_HOME = priorHome
    })
    session(s.dir, 'parent', s.dir)
    writeFileSync(join(s.dir, 'threads.json'), JSON.stringify({ source: { sessionId: 'parent', turnLeaves: { sourceTurn: 'leaf' } } }))
    vi.spyOn(s.internals, 'start').mockResolvedValue(undefined)
    let branches = 0
    vi.spyOn(s.internals, 'send').mockImplementation(async (_thread, command) => {
      if (command.type === 'get_entries') return { entries: [] }
      if (command.type === 'clone') return { cancelled: false }
      const id = `branch-${++branches}`
      session(s.dir, id, s.dir)
      return { sessionId: id }
    })
    const resumed: unknown[] = []
    vi.spyOn(s.internals, 'processFor').mockImplementation(async (...args: unknown[]) => {
      resumed.push(args[2])
      return { thread: {}, resumed: true }
    })
    // The first fork turn stops after partial text; the resend completes.
    vi.spyOn(s.internals, 'runTurn')
      .mockResolvedValueOnce({ text: 'partial answer', aborted: true, providerRef: { provider: 'openai', sessionId: 'branch-1' } })
      .mockResolvedValue({ text: 'fork reply', aborted: false, providerRef: { provider: 'openai', sessionId: 'branch-2' } })
    const handOver = vi.spyOn(s.internals as unknown as { handOver(...args: unknown[]): Promise<unknown> }, 'handOver').mockResolvedValue({ thread: {}, resumed: false })
    const adapter = piAdapter(() => 'parent answer', { fork: 'native', historyInjection: 'prompt', containment: 'weak' }, 'parent')
    const base = adapter.startTurn.bind(adapter)
    let sourceId = ''
    const received: Array<{ nativeHistory?: string }> = []
    adapter.startTurn = async (input, sink, ctl, host) => {
      if (input.threadId === sourceId) {
        const result = await base(input, sink, ctl, host)
        result.providerRef = { ...result.providerRef!, nativeTurnId: 'sourceTurn' }
        sink.providerRef(result.providerRef)
        return result
      }
      received.push(input)
      return s.engine.startTurn(input, sink, ctl, host)
    }
    adapter.forkSession = (ref, ordinal, target) => s.engine.forkSession(ref, ordinal, target)
    const d = phase6Daemon(s.dir, [adapter])
    cleanups.push(() => d.stop())
    sourceId = d.store.createThread('Source').id
    d.orch.setThreadModelOverride(sourceId, PI)
    expect((await d.orch.send('Parent request', false, { threadId: sourceId, clientRequestId: 'parent' })).error).toBeUndefined()
    const fork = await d.engine.forkThread({ sourceThreadId: sourceId, clientRequestId: 'fork' })
    expect((await d.orch.send('Continue', false, { threadId: fork.threadId, clientRequestId: 'try-1' })).error).toBeUndefined()
    expect(d.engine.transfers.get(fork.transferId)?.status).toBe('pending')
    expect((await d.orch.send('Continue', false, { threadId: fork.threadId, clientRequestId: 'try-2' })).error).toBeUndefined()
    expect(branches).toBe(2)
    // The fork thread's history holds the partial reply; the new branch (the parent's context) is
    // resumed anyway, and only the fork's own history is never handed over in its place.
    expect(received[1]?.nativeHistory).toContain('partial answer')
    expect(resumed).toEqual(['branch-1', 'branch-2'])
    expect(handOver).not.toHaveBeenCalled()
  })
})

describe('the resend after a fork’s first turn (review round 4, through the orchestrator)', () => {
  for (const firstOutcome of ['stopped', 'failed', 'stale'] as const) {
    it(`first turn ${firstOutcome}`, async () => {
      const s = fixture()
      const priorHome = process.env.MOUSSE_HOME
      process.env.MOUSSE_HOME = s.dir
      cleanups.push(() => {
        if (priorHome === undefined) delete process.env.MOUSSE_HOME
        else process.env.MOUSSE_HOME = priorHome
      })
      session(s.dir, 'parent', s.dir)
      writeFileSync(join(s.dir, 'threads.json'), JSON.stringify({ source: { sessionId: 'parent', turnLeaves: { sourceTurn: 'leaf' } } }))
      vi.spyOn(s.internals, 'start').mockResolvedValue(undefined)
      let branches = 0
      vi.spyOn(s.internals, 'send').mockImplementation(async (_thread, command) => {
        if (command.type === 'get_entries') return { entries: [] }
        if (command.type === 'clone') return { cancelled: false }
        const id = `branch-${++branches}`
        session(s.dir, id, s.dir)
        return { sessionId: id }
      })
      const resumed: unknown[] = []
      vi.spyOn(s.internals, 'processFor').mockImplementation(async (...args: unknown[]) => {
        resumed.push(args[2])
        return { thread: {}, resumed: true }
      })
      const handOver = vi.spyOn(s.internals as unknown as { handOver(...args: unknown[]): Promise<unknown> }, 'handOver').mockResolvedValue({ thread: {}, resumed: false })
      let forkTurns = 0
      vi.spyOn(s.internals, 'runTurn').mockImplementation(async () => {
        forkTurns += 1
        if (forkTurns === 1 && firstOutcome !== 'stopped') throw Object.assign(new Error('rate limited'), { code: 'rate_limited' })
        return forkTurns === 1 ? { text: '', aborted: true, providerRef: { provider: 'openai' } } : { text: 'fork reply', aborted: false, providerRef: { provider: 'openai' } }
      })
      const adapter = piAdapter(() => 'parent answer', { fork: 'native', historyInjection: 'prompt', containment: 'weak' }, 'parent')
      const base = adapter.startTurn.bind(adapter)
      let sourceId = ''
      const received: Array<{ nativeHistory?: string; historyHandedOver?: boolean; handoffUnplanned?: boolean; prompt?: string }> = []
      adapter.startTurn = async (input, sink, ctl, host) => {
        if (input.threadId === sourceId) {
          const result = await base(input, sink, ctl, host)
          result.providerRef = { ...result.providerRef!, nativeTurnId: 'sourceTurn' }
          sink.providerRef(result.providerRef)
          return result
        }
        received.push(input)
        return s.engine.startTurn(input, sink, ctl, host)
      }
      adapter.forkSession = (ref, ordinal, target) => s.engine.forkSession(ref, ordinal, target)
      const d = phase6Daemon(s.dir, firstOutcome === 'stale' ? [adapter, claudeAdapter(() => 'answer elsewhere')] : [adapter])
      cleanups.push(() => d.stop())
      sourceId = d.store.createThread('Source').id
      d.orch.setThreadModelOverride(sourceId, PI)
      expect((await d.orch.send('Parent request', false, { threadId: sourceId, clientRequestId: 'parent' })).error).toBeUndefined()
      const fork = await d.engine.forkThread({ sourceThreadId: sourceId, clientRequestId: 'fork' })
      await d.orch.send('Continue', false, { threadId: fork.threadId, clientRequestId: 'try-1' })
      if (firstOutcome === 'stale') {
        // A turn on another provider, then back. The switch plans a delta (what ran elsewhere since Pi's
        // own session): Pi resumes the branch, which holds the parent's history, and gets the delta.
        d.orch.setThreadModelOverride(fork.threadId, CLAUDE)
        expect((await d.orch.send('Ask elsewhere', false, { threadId: fork.threadId, clientRequestId: 'claude' })).error).toBeUndefined()
        d.orch.setThreadModelOverride(fork.threadId, PI)
        expect((await d.orch.send('Back on pi', false, { threadId: fork.threadId, clientRequestId: 'back' })).error).toBeUndefined()
        expect(received[1]?.historyHandedOver).toBeUndefined()
        expect(received[1]?.prompt).toContain('strategy="delta"')
        expect(received[1]?.prompt).toContain('answer elsewhere')
        expect(resumed).toEqual(['branch-1', 'branch-1'])
      } else {
        // The resend forks again from the parent and resumes that branch; nothing is handed over.
        expect((await d.orch.send('Continue', false, { threadId: fork.threadId, clientRequestId: 'try-2' })).error).toBeUndefined()
        expect(branches).toBe(2)
        expect(resumed).toEqual(['branch-1', 'branch-2'])
        expect(received[1]?.historyHandedOver).toBeUndefined()
      }
      expect(handOver).not.toHaveBeenCalled()
    })
  }
})

describe('a switch back whose handoff cannot be planned', () => {
  it('does not resume a pending fork branch: the raw history is handed over (through the orchestrator)', async () => {
    const s = fixture()
    const priorHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = s.dir
    cleanups.push(() => {
      if (priorHome === undefined) delete process.env.MOUSSE_HOME
      else process.env.MOUSSE_HOME = priorHome
    })
    session(s.dir, 'parent', s.dir)
    writeFileSync(join(s.dir, 'threads.json'), JSON.stringify({ source: { sessionId: 'parent', turnLeaves: { sourceTurn: 'leaf' } } }))
    vi.spyOn(s.internals, 'start').mockResolvedValue(undefined)
    let branches = 0
    vi.spyOn(s.internals, 'send').mockImplementation(async (_thread, command) => {
      if (command.type === 'get_entries') return { entries: [] }
      if (command.type === 'clone') return { cancelled: false }
      const id = `branch-${++branches}`
      session(s.dir, id, s.dir)
      return { sessionId: id }
    })
    const resumed: unknown[] = []
    vi.spyOn(s.internals, 'processFor').mockImplementation(async (...args: unknown[]) => {
      resumed.push(args[2])
      return { thread: {}, resumed: true }
    })
    const handOver = vi.spyOn(s.internals as unknown as { handOver(...args: unknown[]): Promise<unknown> }, 'handOver').mockResolvedValue({ thread: {}, resumed: false })
    let forkTurns = 0
    vi.spyOn(s.internals, 'runTurn').mockImplementation(async () => {
      forkTurns += 1
      if (forkTurns === 1) throw Object.assign(new Error('rate limited'), { code: 'rate_limited' })
      return { text: 'back reply', aborted: false, providerRef: { provider: 'openai' } }
    })
    const adapter = piAdapter(() => 'parent answer', { fork: 'native', historyInjection: 'prompt', containment: 'weak' }, 'parent')
    const base = adapter.startTurn.bind(adapter)
    let sourceId = ''
    const received: Array<{ nativeHistory?: string; handoffUnplanned?: boolean }> = []
    adapter.startTurn = async (input, sink, ctl, host) => {
      if (input.threadId === sourceId) {
        const result = await base(input, sink, ctl, host)
        result.providerRef = { ...result.providerRef!, nativeTurnId: 'sourceTurn' }
        sink.providerRef(result.providerRef)
        return result
      }
      received.push(input)
      return s.engine.startTurn(input, sink, ctl, host)
    }
    adapter.forkSession = (ref, ordinal, target) => s.engine.forkSession(ref, ordinal, target)
    const d = phase6Daemon(s.dir, [adapter, claudeAdapter(() => 'answer elsewhere')])
    cleanups.push(() => d.stop())
    sourceId = d.store.createThread('Source').id
    d.orch.setThreadModelOverride(sourceId, PI)
    expect((await d.orch.send('Parent request', false, { threadId: sourceId, clientRequestId: 'parent' })).error).toBeUndefined()
    const fork = await d.engine.forkThread({ sourceThreadId: sourceId, clientRequestId: 'fork' })
    await d.orch.send('Continue', false, { threadId: fork.threadId, clientRequestId: 'try-1' })
    d.orch.setThreadModelOverride(fork.threadId, CLAUDE)
    expect((await d.orch.send('Ask elsewhere', false, { threadId: fork.threadId, clientRequestId: 'claude' })).error).toBeUndefined()
    d.orch.setThreadModelOverride(fork.threadId, PI)
    vi.spyOn(d.engine.handoffs, 'plan').mockImplementation(() => { throw new Error('handoff planner unavailable') })
    await d.orch.send('Back on pi', false, { threadId: fork.threadId, clientRequestId: 'back' })
    expect(received[1]?.handoffUnplanned).toBe(true)
    expect(received[1]?.nativeHistory).toContain('answer elsewhere')
    // The stale branch is dropped; the raw history (with the turn elsewhere) is handed over.
    expect(resumed).toEqual(['branch-1'])
    expect(handOver).toHaveBeenCalledTimes(1)
    expect(JSON.parse(readFileSync(join(s.dir, 'threads.json'), 'utf8'))[fork.threadId]?.sessionId).not.toBe('branch-1')
  })
})

describe('a fork whose handoff planning fails after its branch was made', () => {
  async function setup() {
    const s = fixture()
    const priorHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = s.dir
    cleanups.push(() => {
      if (priorHome === undefined) delete process.env.MOUSSE_HOME
      else process.env.MOUSSE_HOME = priorHome
    })
    session(s.dir, 'parent', s.dir)
    writeFileSync(join(s.dir, 'threads.json'), JSON.stringify({ source: { sessionId: 'parent', turnLeaves: { sourceTurn: 'leaf' } } }))
    vi.spyOn(s.internals, 'start').mockResolvedValue(undefined)
    let branches = 0
    vi.spyOn(s.internals, 'send').mockImplementation(async (_thread, command) => {
      if (command.type === 'get_entries') return { entries: [] }
      if (command.type === 'clone') return { cancelled: false }
      const id = `branch-${++branches}`
      session(s.dir, id, s.dir)
      return { sessionId: id }
    })
    const resumed: unknown[] = []
    vi.spyOn(s.internals, 'processFor').mockImplementation(async (...args: unknown[]) => {
      resumed.push(args[2])
      return { thread: {}, resumed: true }
    })
    const handOver = vi.spyOn(s.internals as unknown as { handOver(...args: unknown[]): Promise<unknown> }, 'handOver').mockResolvedValue({ thread: {}, resumed: false })
    vi.spyOn(s.internals, 'runTurn').mockResolvedValue({ text: 'fork reply', aborted: false, providerRef: { provider: 'openai' } })
    const adapter = piAdapter(() => 'parent answer', { fork: 'native', historyInjection: 'prompt', containment: 'weak' }, 'parent')
    const base = adapter.startTurn.bind(adapter)
    let sourceId = ''
    const received: Array<{ handoffUnplanned?: boolean }> = []
    adapter.startTurn = async (input, sink, ctl, host) => {
      if (input.threadId === sourceId) {
        const result = await base(input, sink, ctl, host)
        result.providerRef = { ...result.providerRef!, nativeTurnId: 'sourceTurn' }
        sink.providerRef(result.providerRef)
        return result
      }
      received.push(input)
      return s.engine.startTurn(input, sink, ctl, host)
    }
    const d = phase6Daemon(s.dir, [adapter])
    cleanups.push(() => d.stop())
    sourceId = d.store.createThread('Source').id
    d.orch.setThreadModelOverride(sourceId, PI)
    expect((await d.orch.send('Parent request', false, { threadId: sourceId, clientRequestId: 'parent' })).error).toBeUndefined()
    const fork = await d.engine.forkThread({ sourceThreadId: sourceId, clientRequestId: 'fork' })
    return { s, d, fork, adapter, resumed, handOver, received, branchCount: () => branches }
  }

  it('resumes the branch made for that turn (Sol round 6)', async () => {
    const t = await setup()
    t.adapter.forkSession = (ref, ordinal, target) => t.s.engine.forkSession(ref, ordinal, target)
    vi.spyOn(t.d.engine.handoffs, 'plan').mockImplementation(() => { throw new Error('handoff planner unavailable') })
    const result = await t.d.orch.send('Continue', false, { threadId: t.fork.threadId, clientRequestId: 'try-1' })
    expect(result.error).toBeUndefined()
    expect(t.branchCount()).toBe(1)
    expect(t.received[0]?.handoffUnplanned).toBeUndefined()
    expect(t.resumed).toEqual(['branch-1'])
    expect(t.handOver).not.toHaveBeenCalled()
  })

  it('fails the turn, rather than answer without the parent, when an untrusted branch leaves nothing to hand over', async () => {
    const t = await setup()
    // A branch from an earlier attempt is pending; this turn's re-fork does not happen, and planning fails.
    writeFileSync(join(t.s.dir, 'threads.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(t.s.dir, 'threads.json'), 'utf8')), [t.fork.threadId]: { sessionId: 'old-branch', historyFingerprint: 'x', pendingFork: true } }))
    session(t.s.dir, 'old-branch', t.s.dir)
    t.adapter.forkSession = async () => null
    vi.spyOn(t.d.engine.handoffs, 'plan').mockImplementation(() => { throw new Error('handoff planner unavailable') })
    const result = await t.d.orch.send('Continue', false, { threadId: t.fork.threadId, clientRequestId: 'try-1' })
    expect(t.received[0]?.handoffUnplanned).toBe(true)
    expect(result.error?.code).toBe('binding_stale')
    expect(t.resumed).toEqual([])
    expect(t.handOver).not.toHaveBeenCalled()
  })
})
