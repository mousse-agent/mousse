/**
 * Independent final-review corrections: service cleanup, agent/task events,
 * projects/threads fan-out, daemon.shutdown, activity map, ALS isolation.
 */

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { requestDaemonShutdown } from '../src/cli/daemonShutdown'
import { readStopRequest } from '../src/cli/mmsRuntime'
import { resolveOwnerStatus } from '../src/mms/ownership/MmsOwnerLease'
import { runDaemonForeground } from '../src/cli/commands/service'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import type { ProtocolEvent } from '../src/mms/protocol/types'
import { bridgeProtocolEvent } from '../src/main/mms/protocolEventBridge'
import { PresentationState } from '../src/main/mms/PresentationState'
import { AgentRegistry } from '../src/mms/agents/AgentRegistry'
import { TaskQueue } from '../src/mms/tasks/TaskQueue'

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
    const onDisk = readStopRequest(home)
    expect(onDisk?.token).toBe(token)
  })

  it('dispatchMethod daemon.shutdown uses shared writer with context ownerToken', async () => {
    const mms = await MousseMainService.create({
      homeDir: home,
      headless: true,
      ownerKind: 'test'
    })
    await mms.start()
    const token = mms.getOwnerLease()!.owner.token
    const result = (await dispatchMethod(
      {
        mms,
        ownerToken: token,
        globalSequence: () => 0
      },
      'daemon.shutdown',
      { reason: 'dispatch-test' }
    )) as { accepted: boolean; reason: string }
    expect(result.accepted).toBe(true)
    expect(readStopRequest(home)?.token).toBe(token)
    await mms.stop()
  })
})

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
    expect(readStopRequest(home)?.token).toBe(ownerToken)
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
      event('agent.activated', 'selected', { agentId: 'a1' }),
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
      'agent:activated',
      'pty:activated'
    ])
  })
})

describe('Review: ALS-safe deferred agent status', () => {
  it('two concurrent registry deferred updates never cross', async () => {
    const a1 = new AgentRegistry()
    const a2 = new AgentRegistry()
    const t1 = new TaskQueue()
    const t2 = new TaskQueue()
    const agentA = a1.create({
      cliType: 'claude-code',
      worktreePath: '/tmp/a',
      branch: 'b',
      executionMode: 'interactive',
      status: 'starting',
      task: 'a'
    })
    const agentB = a2.create({
      cliType: 'codex',
      worktreePath: '/tmp/b',
      branch: 'b',
      executionMode: 'interactive',
      status: 'starting',
      task: 'b'
    })
    const taskA = t1.createTask({ description: 'ta' })
    const taskB = t2.createTask({ description: 'tb' })
    t1.linkAgent(taskA.id, agentA.id)
    t2.linkAgent(taskB.id, agentB.id)

    // Simulate deferred callbacks capturing their own registries (the fix).
    await Promise.all([
      new Promise<void>((resolve) => {
        setTimeout(() => {
          a1.updateStatus(agentA.id, 'running')
          t1.updateStatus(taskA.id, 'in_progress')
          resolve()
        }, 5)
      }),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          a2.updateStatus(agentB.id, 'failed')
          t2.updateStatus(taskB.id, 'failed')
          resolve()
        }, 5)
      })
    ])

    expect(a1.get(agentA.id)?.status).toBe('running')
    expect(a2.get(agentB.id)?.status).toBe('failed')
    expect(t1.list().find((t) => t.id === taskA.id)?.status).toBe('in_progress')
    expect(t2.list().find((t) => t.id === taskB.id)?.status).toBe('failed')
    // Cross-registry no-ops: wrong id on wrong registry
    expect(a1.get(agentB.id)).toBeUndefined()
    expect(a2.get(agentA.id)).toBeUndefined()
  })
})
