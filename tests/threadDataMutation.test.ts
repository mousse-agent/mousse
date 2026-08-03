/**
 * Phase 4 correction: concurrent thread-data partial updates must not clobber each other.
 */

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import type { Agent, ChatMessage, Task } from '../src/shared/types'
import { withThreadDataMutationLock } from '../src/mms/queue/ThreadExecutionLease'

describe('ThreadDataStore.mutateThreadData atomicity', () => {
  let home: string
  let mms: MousseMainService
  let threadId: string

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-tdata-'))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({
      homeDir: home,
      headless: true,
      ownerKind: 'test'
    })
    await mms.start()
    threadId = mms.threads.createThread('Mut').id
  })

  afterEach(async () => {
    await mms.stop()
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    delete process.env.MOUSSE_HOME
  })

  const userMsg = (id: string, content: string): ChatMessage =>
    ({
      id,
      role: 'user',
      content,
      createdAt: new Date().toISOString()
    }) as ChatMessage

  const agent = (id: string): Agent =>
    ({
      id,
      cliType: 'claude-code',
      worktreePath: home,
      branch: 'b',
      executionMode: 'interactive',
      status: 'ready',
      task: 't',
      createdAt: new Date().toISOString()
    }) as Agent

  const task = (id: string, description: string): Task =>
    ({
      id,
      description,
      status: 'pending',
      createdAt: new Date().toISOString()
    }) as Task

  it('interleaved agents and transcript writes preserve both under mutation lock', () => {
    const store = mms.threads
    store.mutateThreadData(threadId, () => ({
      messages: [userMsg('m1', 'hello')]
    }))

    store.mutateThreadData(threadId, (cur) => ({
      agents: [agent('a1')],
      messages: cur.messages
    }))

    store.mutateThreadData(threadId, (cur) => ({
      messages: [...cur.messages, userMsg('m2', 'world')],
      agents: cur.agents
    }))

    store.mutateThreadData(threadId, (cur) => ({
      tasks: [task('task1', 'do it')],
      messages: cur.messages,
      agents: cur.agents
    }))

    const final = store.loadThreadData(threadId)
    expect(final.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(final.agents).toHaveLength(1)
    expect(final.agents[0].id).toBe('a1')
    expect(final.tasks).toHaveLength(1)
    expect(final.tasks[0].description).toBe('do it')
    expect(final.messageQueue).toEqual([])
  })

  it('forced interleaving: nested RMW under lock preserves transcript + agents + mousse sessions', () => {
    const store = mms.threads
    const threadDir = store.getThreadDir(threadId)

    // Outer mutation holds the lock and interleaves nested partial mutators
    // (same-process re-entrant lock) — models transcript vs agents/tasks vs mousse sessions.
    withThreadDataMutationLock(threadDir, () => {
      store.mutateThreadData(threadId, () => ({
        messages: [userMsg('m-outer', 'transcript')]
      }))
      store.mutateThreadData(threadId, () => ({
        agents: [agent('a-nested')]
      }))
      store.mutateThreadData(threadId, () => ({
        tasks: [task('t-nested', 'nested-task')]
      }))
      store.mutateThreadData(threadId, () => ({
        mousseAgentSessions: [
          {
            version: 1 as const,
            agentId: 'a-nested',
            worktreePath: home,
            task: 'nested',
            assignment: {},
            messages: [],
            history: [],
            runState: 'idle' as const,
            updatedAt: new Date().toISOString()
          }
        ]
      }))
    })

    const final = store.loadThreadData(threadId)
    expect(final.messages.map((m) => m.id)).toEqual(['m-outer'])
    expect(final.agents.map((a) => a.id)).toEqual(['a-nested'])
    expect(final.tasks.map((t) => t.id)).toEqual(['t-nested'])
    expect(final.mousseAgentSessions?.map((s) => s.agentId)).toEqual(['a-nested'])
  })

  it('legacy load-then-full-save clobbers concurrent agents; mutateThreadData does not', () => {
    const store = mms.threads
    store.mutateThreadData(threadId, () => ({
      messages: [userMsg('m1', 'seed')],
      agents: [agent('a-keep')]
    }))

    // Simulate the Phase-4 bug: load outside lock, concurrent agent mutate, then full save.
    const stale = store.loadThreadData(threadId)
    store.mutateThreadData(threadId, () => ({
      agents: [agent('a-new'), agent('a-keep')]
    }))
    // Full save with stale agents would wipe a-new — prove mutate path instead.
    store.mutateThreadData(threadId, (current) => ({
      messages: [
        ...current.messages,
        userMsg('m2', 'from-rmw')
      ]
      // agents intentionally omitted → preserved from current under lock
    }))

    const final = store.loadThreadData(threadId)
    expect(final.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(final.agents.map((a) => a.id).sort()).toEqual(['a-keep', 'a-new'])

    // Contrast: full saveThreadData with stale snapshot still can overwrite (documented).
    store.saveThreadData(threadId, {
      ...stale,
      messages: [...stale.messages, userMsg('m-stale', 'stale')]
    })
    const clobbered = store.loadThreadData(threadId)
    expect(clobbered.agents.map((a) => a.id)).toEqual(['a-keep'])
    expect(clobbered.messages.some((m) => m.id === 'm2')).toBe(false)
  })

  it('queue remains independent of thread-data mutation', () => {
    mms.threads.saveMessageQueue(threadId, [
      {
        id: 'q1',
        threadId,
        content: 'queued',
        enqueuedAt: new Date().toISOString(),
        order: 0,
        intent: 'normal',
        state: 'pending'
      }
    ])
    mms.threads.mutateThreadData(threadId, () => ({
      agents: [agent('a1')]
    }))
    const q = mms.threads.loadMessageQueue(threadId)
    expect(q).toHaveLength(1)
    expect(q[0].content).toBe('queued')
    const data = mms.threads.loadThreadData(threadId)
    expect(data.agents).toHaveLength(1)
    // queue on ThreadData view is load-time only; disk queue untouched
    expect(mms.threads.loadMessageQueue(threadId)[0].id).toBe('q1')
  })

  it('persistAgentsTasks merges with concurrent transcript mutate', () => {
    mms.threads.mutateThreadData(threadId, () => ({
      messages: [userMsg('m1', 'hello')]
    }))
    const rt = mms.threadRuntimes.getOrHydrate(threadId)
    rt.agents.create({
      cliType: 'claude-code',
      worktreePath: home,
      branch: 'main',
      executionMode: 'interactive',
      status: 'ready',
      task: 'work'
    })
    // persistAgentsTasks uses mutateThreadData
    mms.threadRuntimes.persistAgentsTasks(threadId)
    mms.threads.mutateThreadData(threadId, (cur) => ({
      messages: [...cur.messages, userMsg('m2', 'more')]
    }))
    mms.threadRuntimes.persistAgentsTasks(threadId)

    const final = mms.threads.loadThreadData(threadId)
    expect(final.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(final.agents.length).toBeGreaterThanOrEqual(1)
  })
})
