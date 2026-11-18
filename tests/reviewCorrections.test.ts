/**
 * Independent final-review corrections: service cleanup, agent/task events,
 * projects/threads fan-out, daemon.shutdown, activity map.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createConnection } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import {
  requestDaemonShutdown,
  sendDaemonStop,
  shutdownDaemonLifecycle,
  stopRunningDaemon,
  type DaemonLifecycleState
} from '../src/cli/daemonShutdown'
import { getMmsRuntimePath, readStopRequest } from '../src/cli/mmsRuntime'
import { resolveLocalEndpoint } from '../src/mms/protocol/endpoint'
import type { MousseMainService as MmsInstance } from '../src/cli/contract'
import { acquireMmsOwnerLease, getMmsOwnerPath, resolveOwnerStatus } from '../src/mms/ownership/MmsOwnerLease'
import { runDaemonForeground } from '../src/cli/commands/service'
import type { ProtocolEvent } from '../src/mms/protocol/types'
import { bridgeProtocolEvent } from '../src/main/mms/protocolEventBridge'
import { PresentationState } from '../src/main/mms/PresentationState'

describe('Review: daemon.shutdown shared implementation', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-shutdown-'))
    process.env.MOUSSE_HOME = home
  })

  afterEach(() => {
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    delete process.env.MOUSSE_HOME
  })

  it('requestDaemonShutdown writes owner-token-fenced stop request', () => {
    const token = 'fence-token-abc'
    const res = requestDaemonShutdown(home, token, 'unit')
    expect(res.accepted).toBe(true)
    expect(res.reason).toBe('unit')
    const onDisk = readStopRequest(home, token)
    expect(onDisk?.token).toBe(token)
  })

  it('a second shutdown waits until the first one has stopped the service', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let mmsStopped = false
    const state: DaemonLifecycleState = {
      homeDir: home,
      mms: {
        stop: async () => {
          await gate
          mmsStopped = true
        }
      } as unknown as MmsInstance,
      protocolServer: null,
      ownerToken: null,
      runtimeWritten: false,
      pollStop: null,
      shuttingDown: false
    }
    const first = shutdownDaemonLifecycle(state)
    let secondDone = false
    const second = shutdownDaemonLifecycle(state).then(() => {
      secondDone = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(secondDone).toBe(false)
    release()
    await Promise.all([first, second])
    expect(mmsStopped).toBe(true)
    expect(state.mms).toBeNull()
  })

  it("a drain that outlasts the stop's deadline is waited for, with the service kept, before teardown ends", async () => {
    let attempts = 0
    let finishDrain!: () => void
    const drain = new Promise<void>((resolve) => { finishDrain = resolve })
    const busy = Object.assign(new Error('Profile work is still draining'), { code: 'profile_busy' })
    const mms = {
      stop: async () => {
        attempts += 1
        // The installation's stop gives up waiting after its deadline; the drain itself goes on.
        if (attempts === 1) throw new AggregateError([busy], 'Failed to stop installation services')
        await drain
      }
    } as unknown as MmsInstance
    const state: DaemonLifecycleState = {
      homeDir: home,
      mms,
      protocolServer: null,
      ownerToken: null,
      runtimeWritten: false,
      pollStop: null,
      shuttingDown: false,
      drainWait: { retryDelayMs: 5, stuckAfterMs: 60_000 }
    }
    let done = false
    const teardown = shutdownDaemonLifecycle(state).then(() => { done = true })
    await vi.waitFor(() => expect(attempts).toBe(2))
    expect(done).toBe(false)
    expect(state.mms).toBe(mms)
    finishDrain()
    await teardown
    expect(state.mms).toBeNull()
  })

  it('a drain that never finishes is stuck: after the bounded wait the stop goes ahead, logged, and teardown ends', async () => {
    const busy = Object.assign(new Error('Profile work is still draining'), { code: 'profile_busy' })
    let attempts = 0
    const mms = {
      stop: async () => {
        attempts += 1
        throw new AggregateError([busy], 'Failed to stop installation services')
      }
    } as unknown as MmsInstance
    const state: DaemonLifecycleState = {
      homeDir: home,
      mms,
      protocolServer: null,
      ownerToken: null,
      runtimeWritten: false,
      pollStop: null,
      shuttingDown: false,
      drainWait: { retryDelayMs: 5, stuckAfterMs: 100 }
    }
    const logs: string[] = []
    await shutdownDaemonLifecycle(state, { onLog: (msg) => logs.push(msg) })
    expect(attempts).toBeGreaterThan(1)
    expect(state.mms).toBeNull()
    expect(logs.at(-1)).toMatch(/forcing the stop/)
  }, 10_000)

  it('a stop reaches a daemon whose lease is unreadable for a moment while it is rewritten', async () => {
    const lease = acquireMmsOwnerLease(home, { kind: 'daemon' })
    try {
      const path = getMmsOwnerPath(home)
      const contents = readFileSync(path, 'utf-8')
      // Mid-write: the file is there, its contents are not yet.
      writeFileSync(path, '')
      const sending = sendDaemonStop(home, { reason: 'unit', intervalMs: 20 })
      await new Promise((resolve) => setTimeout(resolve, 100))
      writeFileSync(path, contents)
      expect(await sending).toMatchObject({ kind: 'running', token: lease.owner.token })
      expect(readStopRequest(home, lease.owner.token)).not.toBeNull()
    } finally {
      lease.release()
    }
  })
})

/** Resolves true when something accepts connections at the endpoint. */
function endpointAccepts(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

describe('Review: service startup fault cleanup', () => {
  let home: string

  afterEach(() => {
    try {
      if (home) rmSync(home, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    delete process.env.MOUSSE_HOME
  })

  for (const failAfter of ['protocol-start', 'set-endpoint', 'runtime-publish'] as const) {
    it(`releases owner lease after ${failAfter} failure`, async () => {
      home = mkdtempSync(join(tmpdir(), `mousse-fault-${failAfter}-`))
      process.env.MOUSSE_HOME = home
      const state = await runDaemonForeground({
        homeDir: home,
        failAfter,
        skipSignals: true,
        onLog: () => undefined
      })
      expect(state.shuttingDown).toBe(true)
      expect(state.mms).toBeNull()
      expect(state.protocolServer).toBeNull()
      const owner = resolveOwnerStatus(home)
      // Owner lease released by mms.stop
      expect(owner.owned).toBe(false)
    }, 60_000)
  }

  it('a stop while the owner is still being created shuts the daemon down fully', async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-stop-early-'))
    process.env.MOUSSE_HOME = home
    const stop = new AbortController()
    const running = runDaemonForeground({
      homeDir: home,
      skipSignals: true,
      stopSignal: stop.signal,
      onLog: () => undefined
    })
    // Owner creation is still pending here.
    stop.abort()
    const state = await running
    try {
      expect(state.shuttingDown).toBe(true)
      expect(state.mms).toBeNull()
      expect(state.protocolServer).toBeNull()
      expect(state.pollStop).toBeNull()
      expect(existsSync(getMmsRuntimePath(home))).toBe(false)
      expect(resolveOwnerStatus(home).owned).toBe(false)
      expect(await endpointAccepts(resolveLocalEndpoint(home).path)).toBe(false)
    } finally {
      if (state.pollStop) clearInterval(state.pollStop)
      await state.protocolServer?.stop().catch(() => undefined)
      await state.mms?.stop().catch(() => undefined)
    }
  }, 60_000)

  it('service stop reaches a daemon that is still starting: it stops as soon as it holds the home and never starts', async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-stop-starting-'))
    process.env.MOUSSE_HOME = home
    // Holds the owner's creation after it took the home's lease, like a slow start does.
    let releaseCreation!: () => void
    const creationGate = new Promise<void>((resolve) => { releaseCreation = resolve })
    const initialize = MousseMainService.prototype.initialize
    vi.spyOn(MousseMainService.prototype, 'initialize').mockImplementation(async function (this: MousseMainService) {
      await creationGate
      return initialize.call(this)
    })
    const start = vi.spyOn(MousseMainService.prototype, 'start')
    const logs: string[] = []
    // Only for cleanup when the test fails.
    const cleanup = new AbortController()
    const running = runDaemonForeground({ homeDir: home, skipSignals: true, stopSignal: cleanup.signal, onLog: (msg) => logs.push(msg) })
    try {
      await vi.waitFor(() => expect(resolveOwnerStatus(home).owned).toBe(true), { timeout: 20_000 })
      // Before, this found no runtime record and answered `unreadable` without asking the daemon to stop.
      const stopped = stopRunningDaemon(home, { timeoutMs: 20_000, intervalMs: 20 })
      // Picked up while the owner is still being created, not once startup is over.
      await vi.waitFor(() => expect(logs.join('')).toContain('Shutting down MMS (stop-request)'), { timeout: 5_000 })
      releaseCreation()
      const state = await running
      expect((await stopped).kind).toBe('stopped')
      expect(start).not.toHaveBeenCalled()
      expect(state.mms).toBeNull()
      expect(existsSync(getMmsRuntimePath(home))).toBe(false)
      expect(resolveOwnerStatus(home).owned).toBe(false)
      expect(await endpointAccepts(resolveLocalEndpoint(home).path)).toBe(false)
    } finally {
      releaseCreation()
      vi.restoreAllMocks()
      cleanup.abort()
      const state = await running
      await state.mms?.stop().catch(() => undefined)
    }
  }, 60_000)
})

describe('Review: protocol live events and fan-out', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let ownerToken: string
  let endpoint: string

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-rev-'))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({
      homeDir: home,
      headless: true,
      ownerKind: 'test'
    })
    await mms.start()
    ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    endpoint = await server.start()
  })

  afterEach(async () => {
    await server.stop()
    await mms.stop()
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    delete process.env.MOUSSE_HOME
  })

  async function client(type: 'gui' | 'cli' = 'gui'): Promise<LocalMmsClient> {
    const c = new LocalMmsClient({
      homeDir: home,
      ownerToken,
      endpoint,
      clientType: type
    })
    await c.connect()
    await c.subscribe(0)
    return c
  }

  it('GUI-like client observes task create/update events with real payloads', async () => {
    const gui = await client('gui')
    const t = mms.threads.createThread('Agents')
    const seenTasks: unknown[][] = []
    const unsub = gui.onEvent((ev) => {
      if (ev.type === 'tasks.updated' && ev.threadId === t.id) {
        const tasks = (ev.data as { tasks?: unknown[] })?.tasks
        if (Array.isArray(tasks)) seenTasks.push(tasks)
      }
    })

    await gui.request('tasks.create', {
      threadId: t.id,
      description: 'live-task-1'
    })
    await vi.waitFor(() => {
      expect(seenTasks.some((list) => list.some((x) => (x as { description?: string }).description === 'live-task-1'))).toBe(
        true
      )
    })

    const created = seenTasks.flat().find((x) => (x as { description?: string }).description === 'live-task-1') as {
      id: string
    }
    await gui.request('tasks.update', {
      threadId: t.id,
      id: created.id,
      status: 'in_progress',
      progress: 40
    })
    await vi.waitFor(() => {
      const latest = seenTasks[seenTasks.length - 1] ?? []
      expect(
        latest.some(
          (x) =>
            (x as { id?: string; status?: string; progress?: number }).id === created.id &&
            (x as { status?: string }).status === 'in_progress'
        )
      ).toBe(true)
    })

    unsub()
    await gui.close()
  })

  it('CLI thread mutation is observed by already-connected GUI client', async () => {
    const gui = await client('gui')
    const cli = await client('cli')
    const seenNames: string[] = []
    const unsub = gui.onEvent((ev) => {
      if (ev.type === 'threads.updated') {
        const threads = (ev.data as { threads?: { name?: string }[] })?.threads
        if (Array.isArray(threads)) {
          for (const th of threads) {
            if (th.name) seenNames.push(th.name)
          }
        }
      }
    })

    await cli.request('threads.create', { name: 'from-cli-visible' })
    await vi.waitFor(() => {
      expect(seenNames).toContain('from-cli-visible')
    })

    unsub()
    await gui.close()
    await cli.close()
  })

  it('daemon-owned thread creation is observed by an already-connected GUI client', async () => {
    const gui = await client('gui')
    const seenNames: string[] = []
    const unsub = gui.onEvent((ev) => {
      if (ev.type !== 'threads.updated') return
      const threads = (ev.data as { threads?: { name?: string }[] })?.threads
      if (!Array.isArray(threads)) return
      for (const thread of threads) {
        if (thread.name) seenNames.push(thread.name)
      }
    })

    // ScheduledJobService uses the store directly.
    mms.threads.createThread('Scheduled: live thread')
    await vi.waitFor(() => {
      expect(seenNames).toContain('Scheduled: live thread')
    })

    unsub()
    await gui.close()
  })

  it('activity.snapshot bridge broadcasts full multi-thread map', () => {
    const presentation = new PresentationState()
    const broadcasts: Array<{ channel: string; data: unknown }> = []
    const broadcast = (channel: string, data: unknown): void => {
      broadcasts.push({ channel, data })
    }
    const event: ProtocolEvent = {
      kind: 'event',
      sequence: 1,
      type: 'activity.snapshot',
      data: {
        activity: { t1: 'processing', t2: 'idle' }
      },
      ts: new Date().toISOString()
    }
    expect(bridgeProtocolEvent(event, broadcast, presentation)).toBe(true)
    const act = broadcasts.find((b) => b.channel === 'threads:activity')
    expect(act?.data).toEqual({ t1: 'processing', t2: 'idle' })

    // Single-thread activity without map must not clobber
    broadcasts.length = 0
    const partial: ProtocolEvent = {
      kind: 'event',
      sequence: 2,
      type: 'activity',
      data: { state: 'processing' },
      threadId: 'only-one',
      ts: new Date().toISOString()
    }
    bridgeProtocolEvent(partial, broadcast, presentation)
    expect(broadcasts.find((b) => b.channel === 'threads:activity')).toBeUndefined()
  })

  it('daemon.shutdown over protocol writes fence before response completes', async () => {
    const c = await client()
    const res = await c.request<{ accepted: boolean }>('daemon.shutdown', {
      reason: 'protocol-test'
    })
    expect(res.accepted).toBe(true)
    expect(readStopRequest(home, ownerToken)?.token).toBe(ownerToken)
    await c.close()
  })
})

describe('Review: selected-thread agent activation bridge', () => {
  it('maps selected lifecycle events and ignores background registry replacement', () => {
    const presentation = new PresentationState()
    presentation.setActiveThreadId('selected')
    const seen: Array<{ channel: string; data: unknown }> = []
    const broadcast = (channel: string, data: unknown): void => {
      seen.push({ channel, data })
    }
    const event = (type: string, threadId: string, data: unknown): ProtocolEvent => ({
      kind: 'event',
      sequence: seen.length + 1,
      type,
      threadId,
      data,
      ts: new Date().toISOString()
    })

    bridgeProtocolEvent(
      event('agents.updated', 'background', { agents: [{ id: 'background-agent' }] }),
      broadcast,
      presentation
    )
    expect(seen).toEqual([])

    bridgeProtocolEvent(
      event('agent.spawned', 'selected', { agent: { id: 'a1' } }),
      broadcast,
      presentation
    )
    bridgeProtocolEvent(
      event('terminal.activated', 'selected', { ptyId: 'p1' }),
      broadcast,
      presentation
    )

    expect(seen.map((entry) => entry.channel)).toEqual([
      'agent:spawned',
      'pty:activated'
    ])
  })
})
