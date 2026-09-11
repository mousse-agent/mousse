import { mkdtemp } from 'node:fs/promises'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { BrowserObservation, BrowserSessionRecord, BrowserTab } from '../src/shared/browser/types'
import { BrowserBroker } from '../src/mms/browser/BrowserBroker'
import { createAllowHttpPolicy } from '../src/mms/browser/defaultPorts'
import { BrowserBrokerAdmissionError } from '../src/mms/browser/brokerLifecycle'
import { encodeWorkerFrame, WorkerFrameDecoder } from '../src/browser-worker/ipc/framing'
import { runBrowserWorkerHost } from '../src/browser-worker/ipc/host'
import { injectOwnedStopFailureForTests, isProcessAlive } from '../src/browser-worker/lifecycle/process'
import { captureOwnedProcessTree, DETACHED_GRANDCHILD_LIMIT, windowsTaskkillArgs } from '../src/browser-worker/lifecycle/ownedTree'
import { workspaceLockPath } from '../src/browser-worker/lifecycle/paths'
import { readWorkspaceLock } from '../src/browser-worker/lifecycle/lock'
import { ensureManagedChrome, startFixtureSite, workerRequest } from './fixtures/browser/harness'
import {
  createDrainBroker,
  makeManagedBrowserTempRoot,
  processRecordPathFor,
  readOwnedChromeRecord,
  removeOwnedTempRoot
} from './fixtures/agent-platform/managed-browser-drain/ownedTemp'

const chrome = await ensureManagedChrome()
const tempRoots: string[] = []
const brokers: Array<{ beginShutdown(): void; shutdown(options?: { timeoutMs?: number }): Promise<void> }> = []

function trackRoot(root: string): string {
  tempRoots.push(root)
  return root
}

async function waitMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function actParams(session: BrowserSessionRecord, observation: BrowserObservation, action: Record<string, unknown>, requestId: string) {
  return {
    requestId,
    sessionId: session.id,
    tabId: observation.tabId,
    generation: session.generation,
    observationId: observation.observationId,
    controlLeaseId: session.controlLeaseId,
    timeoutMs: 10_000,
    action
  }
}

function named(observation: BrowserObservation, name: string) {
  const match = observation.elements.find((element) => (element.name ?? '').includes(name) || (element.text ?? '').includes(name))
  if (!match) throw new Error(`missing ${name}: ${observation.elements.map((el) => `${el.role}:${el.name}`).join(' | ')}`)
  return match
}

async function waitForFrameCount(frames: unknown[], count: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (frames.length < count && Date.now() < deadline) await waitMs(20)
  if (frames.length < count) throw new Error(`timed out waiting for ${count} worker frames, got ${frames.length}`)
}

afterEach(async () => {
  injectOwnedStopFailureForTests(null)
  for (const broker of brokers.splice(0)) {
    try { broker.beginShutdown() } catch { /* already stopped */ }
    try { await broker.shutdown({ timeoutMs: 30_000 }) } catch { /* timeout retains ownership for diagnosis */ }
  }
  for (const root of tempRoots.splice(0)) {
    try { removeOwnedTempRoot(root) } catch { /* containment helper throws if the path is not owned */ }
  }
})

describe('managed browser process identity', () => {
  it('builds taskkill arguments from the exact recorded pid and never from a process name', () => {
    const term = windowsTaskkillArgs(4242, 'term')
    const force = windowsTaskkillArgs(4242, 'kill')
    expect(term).toEqual(['/PID', '4242', '/T'])
    expect(force).toEqual(['/PID', '4242', '/T', '/F'])
    expect(term.join(' ')).not.toMatch(/\/IM/i)
    expect(force.some((part) => part.includes('chrome'))).toBe(false)
  })

  it('records the detached-grandchild limit for parent identity loss', () => {
    expect(DETACHED_GRANDCHILD_LIMIT).toMatch(/detached grandchild/i)
  })
})

describe('browser worker host admission', () => {
  it('rejects a second init and duplicate request ids without replacing the manager', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const root = trackRoot(makeManagedBrowserTempRoot())
    const host = runBrowserWorkerHost(input, output)
    const frames: unknown[] = []
    const decoder = new WorkerFrameDecoder()
    output.on('data', (chunk: Buffer) => {
      decoder.push(chunk)
      frames.push(...decoder.shiftAll())
    })
    input.write(encodeWorkerFrame({
      kind: 'init', version: 1, id: 'init_1',
      profileRoot: join(root, 'profiles'),
      browserRoot: join(root, 'browser'),
      artifactRoot: join(root, 'artifacts')
    }))
    await waitForFrameCount(frames, 1)
    input.write(encodeWorkerFrame({
      kind: 'init', version: 1, id: 'init_2',
      profileRoot: join(root, 'profiles'),
      browserRoot: join(root, 'browser'),
      artifactRoot: join(root, 'artifacts')
    }))
    await waitForFrameCount(frames, 2)
    input.write(Buffer.concat([
      encodeWorkerFrame({
        version: 1, id: 'dup', profileId: 'profile_dup', method: 'session.open', params: { url: 'http://127.0.0.1:1/' }
      }),
      encodeWorkerFrame({
        version: 1, id: 'dup', profileId: 'profile_dup', method: 'session.open', params: { url: 'http://127.0.0.1:1/' }
      })
    ]))
    await waitForFrameCount(frames, 3)
    input.write(encodeWorkerFrame({ kind: 'shutdown', version: 1, id: 'shutdown_1' }))
    input.end()
    await host
    await waitForFrameCount(frames, 4)
    const kinds = frames.map((frame) => (frame as { kind?: string; id?: string; error?: { message?: string } }))
    expect(kinds.some((frame) => frame.kind === 'init_ok' && frame.id === 'init_1')).toBe(true)
    expect(kinds.some((frame) => frame.kind === 'init_err' && frame.id === 'init_2' && /already initialized/i.test(frame.error?.message ?? ''))).toBe(true)
    const dupFrames = kinds.filter((frame) => frame.id === 'dup')
    expect(dupFrames).toHaveLength(1)
    expect((dupFrames[0] as { ok?: boolean }).ok).toBe(false)
    expect(kinds.filter((frame) => frame.kind === 'shutdown_ok')).toHaveLength(1)
  })

  it('awaits an in-flight handler when stdin ends during shutdown', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const root = trackRoot(makeManagedBrowserTempRoot())
    const host = runBrowserWorkerHost(input, output)
    const frames: unknown[] = []
    const decoder = new WorkerFrameDecoder()
    output.on('data', (chunk: Buffer) => {
      decoder.push(chunk)
      frames.push(...decoder.shiftAll())
    })
    input.write(encodeWorkerFrame({
      kind: 'init', version: 1, id: 'init_end',
      profileRoot: join(root, 'profiles'),
      browserRoot: join(root, 'browser'),
      artifactRoot: join(root, 'artifacts')
    }))
    await waitForFrameCount(frames, 1)
    input.write(encodeWorkerFrame({
      version: 1, id: 'open_end', profileId: 'profile_end', method: 'session.open', params: { url: 'http://127.0.0.1:1/' }
    }))
    input.write(encodeWorkerFrame({ kind: 'shutdown', version: 1, id: 'shutdown_end' }))
    input.end()
    await host
  })
})

describe('browser broker admission without chrome', () => {
  it('rejects start and call after permanent shutdown and joins repeated close', async () => {
    const root = trackRoot(makeManagedBrowserTempRoot())
    mkdirSync(join(root, 'profiles'), { recursive: true })
    mkdirSync(join(root, 'browser'), { recursive: true })
    mkdirSync(join(root, 'artifacts'), { recursive: true })
    const broker = new BrowserBroker({
      profileRoot: join(root, 'profiles'),
      browserRoot: join(root, 'browser'),
      artifactRoot: join(root, 'artifacts'),
      policy: createAllowHttpPolicy(),
      transport: 'in-process'
    })
    brokers.push(broker)
    const first = broker.shutdown({ timeoutMs: 5_000 })
    const second = broker.close()
    expect(second).toBe(first)
    await first
    await second
    expect(broker.getActiveCount()).toBe(0)
    await expect(broker.start()).rejects.toBeInstanceOf(BrowserBrokerAdmissionError)
    await expect(broker.call(workerRequest('profile_closed', 'session.open', { url: 'http://127.0.0.1:1/' }))).rejects.toBeInstanceOf(BrowserBrokerAdmissionError)
  })
})

describe.skipIf(!chrome.ok)('managed Chromium drain', () => {
  let origin = ''
  let closeSite: () => Promise<void> = async () => undefined
  let submitCount = () => 0

  beforeAll(async () => {
    const site = await startFixtureSite()
    origin = site.origin
    closeSite = site.close
    submitCount = site.submitCount
  }, 120_000)

  afterAll(async () => {
    await closeSite()
  })

  it('closes owned Chrome descendants and reports a zero active count', async () => {
    const root = trackRoot(makeManagedBrowserTempRoot())
    const { broker, browserRoot } = createDrainBroker(root)
    brokers.push(broker)
    await broker.start()
    expect(broker.getActiveCount()).toBeGreaterThan(0)
    const opened = await broker.call(workerRequest('profile_tree', 'session.open', { url: `${origin}/form.html` }))
    expect(opened.ok, JSON.stringify(opened)).toBe(true)
    const session = (opened.result as { session: BrowserSessionRecord }).session
    const recordPath = processRecordPathFor(browserRoot, 'profile_tree', { ephemeralId: session.id })
    const record = readOwnedChromeRecord(recordPath)
    expect(isProcessAlive(record.pid)).toBe(true)
    let tree = await captureOwnedProcessTree(record.pid, { parentHandleAlive: true })
    if (tree.descendants.length === 0) {
      await waitMs(500)
      tree = await captureOwnedProcessTree(record.pid, { parentHandleAlive: true })
    }
    const descendantPids = [record.pid, ...tree.descendants.map((item) => item.pid), ...(record.descendants ?? []).map((item) => item.pid)]
    expect(descendantPids.some((pid) => pid === record.pid)).toBe(true)
    await broker.shutdown({ timeoutMs: 20_000 })
    expect(broker.getActiveCount()).toBe(0)
    for (const pid of new Set(descendantPids)) {
      expect(isProcessAlive(pid), `owned chrome pid ${pid} still alive`).toBe(false)
    }
  }, 120_000)

  it('preserves a dispatched act result across caller timeout and posts only once', async () => {
    const root = trackRoot(makeManagedBrowserTempRoot())
    const { broker } = createDrainBroker(root)
    brokers.push(broker)
    const previous = process.env.MOUSSE_BROWSER_TEST_DELAY_RESPONSE_MS
    process.env.MOUSSE_BROWSER_TEST_DELAY_RESPONSE_MS = '4000'
    await broker.start()
    const opened = await broker.call(workerRequest('profile_once', 'session.open', { url: `${origin}/submit-once.html` }))
    expect(opened.ok, JSON.stringify(opened)).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const before = submitCount()
    const pending = broker.call(workerRequest('profile_once', 'act', actParams(payload.session, payload.observation, {
      type: 'click', target: { kind: 'ref', ref: named(payload.observation, 'Submit once').ref }
    }, 'submit_timeout')), { timeoutMs: 2_000 })
    const postedDeadline = Date.now() + 10_000
    while (submitCount() < before + 1 && Date.now() < postedDeadline) await waitMs(50)
    expect(submitCount()).toBe(before + 1)
    const caller = await pending.catch((error: Error & { code?: string }) => error)
    expect((caller as Error & { code?: string }).code).toBe('timeout')
    expect(broker.getActiveCount()).toBeGreaterThan(0)
    const drainDeadline = Date.now() + 8_000
    while (broker.getActiveCount() > 1 && Date.now() < drainDeadline) await waitMs(50)
    await waitMs(400)
    expect(submitCount()).toBe(before + 1)
    if (previous === undefined) delete process.env.MOUSSE_BROWSER_TEST_DELAY_RESPONSE_MS
    else process.env.MOUSSE_BROWSER_TEST_DELAY_RESPONSE_MS = previous
    await broker.shutdown({ timeoutMs: 20_000 })
  }, 120_000)

  it('does not insert a session or tab that finishes after shutdown began', async () => {
    const root = trackRoot(makeManagedBrowserTempRoot())
    const { broker, browserRoot } = createDrainBroker(root)
    brokers.push(broker)
    process.env.MOUSSE_BROWSER_TEST_DELAY_TAB_ENABLE_MS = '1500'
    await broker.start()
    const opened = broker.call(workerRequest('profile_late', 'session.open', { url: `${origin}/form.html` }))
    await waitMs(50)
    broker.beginShutdown()
    const openedResult = await opened.catch((error: Error & { code?: string }) => error)
    if ('ok' in (openedResult as object)) {
      expect((openedResult as { ok: boolean }).ok).toBe(false)
    } else {
      expect(['cancelled', 'admission_closed']).toContain((openedResult as Error & { code?: string }).code)
    }
    await broker.shutdown({ timeoutMs: 20_000 })
    expect(broker.getActiveCount()).toBe(0)
    const lateEphemeral = join(browserRoot, 'user-data', 'profile_late', 'ephemeral')
    const leftoverSessions = existsSync(lateEphemeral)
      ? readdirSync(lateEphemeral).filter((name) => name.startsWith('sess_'))
      : []
    expect(leftoverSessions).toEqual([])
    expect(existsSync(join(browserRoot, 'locks', 'workspace', 'profile_late'))).toBe(false)

    const secondRoot = trackRoot(makeManagedBrowserTempRoot())
    const second = createDrainBroker(secondRoot)
    brokers.push(second.broker)
    await second.broker.start()
    const live = await second.broker.call(workerRequest('profile_tab', 'session.open', { url: `${origin}/form.html` }))
    expect(live.ok).toBe(true)
    const session = (live.result as { session: BrowserSessionRecord }).session
    const before = await second.broker.call(workerRequest('profile_tab', 'tabs.list', { sessionId: session.id }))
    const beforeTabs = (before.result as { tabs: BrowserTab[] }).tabs
    const created = second.broker.call(workerRequest('profile_tab', 'tabs.new', { sessionId: session.id, url: `${origin}/nav-b.html` }))
    await waitMs(50)
    const closer = second.broker.call(workerRequest('profile_tab', 'session.close', { sessionId: session.id }))
    const createdResult = await created.catch((error: Error & { code?: string }) => error)
    await closer
    if ('ok' in (createdResult as object)) {
      expect((createdResult as { ok: boolean }).ok).toBe(false)
    } else {
      expect(['cancelled', 'session_closed', 'worker_disconnected']).toContain((createdResult as Error & { code?: string }).code)
    }
    expect(beforeTabs).toHaveLength(1)
    delete process.env.MOUSSE_BROWSER_TEST_DELAY_TAB_ENABLE_MS
    await second.broker.shutdown({ timeoutMs: 20_000 })
  }, 180_000)

  it('retains the workspace lock when stop fails and retry blocks a new writer until close finishes', async () => {
    const root = trackRoot(makeManagedBrowserTempRoot())
    const { broker, browserRoot } = createDrainBroker(root)
    brokers.push(broker)
    await broker.start()
    const opened = await broker.call(workerRequest('profile_lock_fail', 'session.open', {
      persistent: true, workspaceId: 'ws_stop_fail', url: `${origin}/form.html`
    }))
    expect(opened.ok, JSON.stringify(opened)).toBe(true)
    const session = (opened.result as { session: BrowserSessionRecord }).session
    const lockPath = workspaceLockPath(browserRoot, 'profile_lock_fail', 'ws_stop_fail')
    expect(readWorkspaceLock(lockPath)?.sessionId).toBe(session.id)
    injectOwnedStopFailureForTests(new Error('injected stop failure'))
    const failed = await broker.call(workerRequest('profile_lock_fail', 'session.close', { sessionId: session.id }))
    expect(failed.ok).toBe(false)
    expect(readWorkspaceLock(lockPath)?.sessionId).toBe(session.id)
    const blocked = await broker.call(workerRequest('profile_lock_fail', 'session.open', {
      persistent: true, workspaceId: 'ws_stop_fail', url: `${origin}/form.html`
    }))
    expect(blocked.ok).toBe(false)
    expect(blocked.error?.code).toBe('policy_denied')
    injectOwnedStopFailureForTests(null)
    const retried = await broker.call(workerRequest('profile_lock_fail', 'session.close', { sessionId: session.id }))
    expect(retried.ok, JSON.stringify(retried)).toBe(true)
    expect(readWorkspaceLock(lockPath)).toBeNull()
    const next = await broker.call(workerRequest('profile_lock_fail', 'session.open', {
      persistent: true, workspaceId: 'ws_stop_fail', url: `${origin}/nav-a.html`
    }))
    expect(next.ok, JSON.stringify(next)).toBe(true)
    await broker.shutdown({ timeoutMs: 20_000 })
  }, 180_000)

  it('resets the decoder after a partial frame and a replacement worker', async () => {
    const siteOrigin = origin
    const esbuild = await import('esbuild')
    const outfile = join(await mkdtemp(join(tmpdir(), 'mousse-drain-worker-')), 'worker.mjs')
    await esbuild.build({
      entryPoints: [join(process.cwd(), 'src/browser-worker/index.ts')],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      logLevel: 'silent'
    })
    const root = trackRoot(makeManagedBrowserTempRoot())
    const { broker } = createDrainBroker(root, { transport: 'child-process', workerModulePath: outfile })
    brokers.push(broker)
    await broker.start()
    const child = (broker as unknown as { child?: { stdin?: { write: (chunk: Buffer) => boolean }; kill: () => boolean } }).child
    expect(child).toBeTruthy()
    child?.stdin?.write(Buffer.from([0x00, 0x01]))
    child?.kill()
    const deadline = Date.now() + 10_000
    while ((broker as unknown as { child?: unknown }).child && Date.now() < deadline) await waitMs(50)
    const opened = await broker.call(workerRequest('profile_partial', 'session.open', { url: `${siteOrigin}/form.html` }))
    expect(opened.ok, JSON.stringify(opened)).toBe(true)
    await broker.shutdown({ timeoutMs: 20_000 })
  }, 180_000)

  it('awaits deferred OOPIF enable work on session close', async () => {
    process.env.MOUSSE_BROWSER_TEST_DELAY_OOPIF_ENABLE_MS = '800'
    const root = trackRoot(makeManagedBrowserTempRoot())
    const { broker } = createDrainBroker(root)
    brokers.push(broker)
    await broker.start()
    const opened = await broker.call(workerRequest('profile_oopif', 'session.open', { url: `${origin}/form.html` }))
    expect(opened.ok).toBe(true)
    const session = (opened.result as { session: BrowserSessionRecord }).session
    const closed = await broker.call(workerRequest('profile_oopif', 'session.close', { sessionId: session.id }))
    expect(closed.ok, JSON.stringify(closed)).toBe(true)
    delete process.env.MOUSSE_BROWSER_TEST_DELAY_OOPIF_ENABLE_MS
    await broker.shutdown({ timeoutMs: 20_000 })
  }, 120_000)
})

if (!chrome.ok) {
  describe('managed Chromium drain blocker', () => {
    it('records the exact Chrome launch blocker without claiming drain qualification', () => {
      expect(chrome.ok).toBe(false)
      expect((chrome as { message: string }).message.length).toBeGreaterThan(0)
    })
  })
}

