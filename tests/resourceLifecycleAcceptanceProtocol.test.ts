import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Thread } from '../src/shared/types'
import type { WorkflowRunView } from '../src/shared/workflowRunPlatform'
import { releaseExecutionLeaseHandle, tryAcquireExecutionLease } from '../src/mms/queue/ThreadExecutionLease'
import { lifecycleApprovalWorkflow, lifecycleHarness } from './fixtures/resource-lifecycle-harness'

describe('Phase 1 lifecycle public protocol acceptance', () => {
  it.each(['threads.delete', 'threads.trash'])('%s preserves opaque data, requires reviewed purge admission and restores the same identity', async (method) => {
    const f = await lifecycleHarness()
    try {
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'recoverable task' })
      const path = f.services.threads.getThreadDir(thread.id)
      const bytes = Buffer.from([0, 255, 17, 36, 10, 128])
      writeFileSync(join(path, 'sole-copy-unknown.bin'), bytes)
      await f.rpc.request(method, { threadId: thread.id })
      expect(existsSync(path)).toBe(false)
      await expect(f.rpc.request('threads.get', { threadId: thread.id })).rejects.toThrow()
      const trashed = f.services.threads.lifecycleStore.require(thread.id)
      await expect(f.rpc.request('threads.purge', { threadId: thread.id })).rejects.toThrow(/operationId/i)
      await expect(f.rpc.request('threads.purge', { threadId: thread.id, operationId: 'unreviewed-purge' })).rejects.toThrow(/preview|review/i)
      const after = f.services.threads.lifecycleStore.require(thread.id)
      expect(after.state).toBe('trashed')
      expect(after.generation).toBe(trashed.generation)
      expect(after.purge).toBeUndefined()
      expect(readFileSync(join(after.location, 'sole-copy-unknown.bin'))).toEqual(bytes)
      const restored = await f.rpc.request<{ thread: Thread }>('threads.restore', { threadId: thread.id })
      expect(restored.thread.id).toBe(thread.id)
      expect(readFileSync(join(path, 'sole-copy-unknown.bin'))).toEqual(bytes)
      expect(f.services.threadRuntimes.get(thread.id)?.activity ?? 'idle').toBe('idle')
      expect(f.services.threads.loadThreadData(thread.id).messages).toEqual([])
    } finally { await f.close() }
  })

  it.each(['threads.delete', 'threads.trash'])('%s cannot move data while a physical writer is admitted', async (method) => {
    const f = await lifecycleHarness()
    let lease: ReturnType<typeof tryAcquireExecutionLease> = null
    try {
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'live writer' })
      const path = f.services.threads.getThreadDir(thread.id)
      lease = tryAcquireExecutionLease(path, { source: 'resource-lifecycle-acceptance' })
      expect(lease).not.toBeNull()
      await expect(f.rpc.request(method, { threadId: thread.id })).rejects.toThrow(/active|busy|drain|lease|blocked/i)
      expect(existsSync(join(path, 'meta.json'))).toBe(true)
      releaseExecutionLeaseHandle(lease!); lease = null
    } finally { if (lease) releaseExecutionLeaseHandle(lease); await f.close() }
  })

  it('keeps another profile unable to trash, restore or purge the owner task', async () => {
    const f = await lifecycleHarness()
    try {
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'Alice bytes' })
      const path = f.services.threads.getThreadDir(thread.id)
      writeFileSync(join(path, 'owner.txt'), 'Alice sole copy')
      const bob = await f.connect(f.bob.id)
      for (const method of ['threads.delete', 'threads.trash', 'threads.restore', 'threads.purge']) {
        await bob.request(method, { threadId: thread.id }).catch(() => undefined)
        expect(readFileSync(join(path, 'owner.txt'), 'utf8')).toBe('Alice sole copy')
      }
      await f.rpc.request('threads.trash', { threadId: thread.id })
      await expect(bob.request('threads.restore', { threadId: thread.id })).rejects.toThrow()
      await f.rpc.request('threads.restore', { threadId: thread.id })
      expect(readFileSync(join(path, 'owner.txt'), 'utf8')).toBe('Alice sole copy')
      expect(f.bobServices.threads.listAllThreads()).toEqual([])
    } finally { await f.close() }
  })

  it('blocks both deletion routes while a durable workflow awaits approval', async () => {
    const f = await lifecycleHarness()
    let runId: string | undefined
    try {
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'workflow owner' })
      const path = f.services.threads.getThreadDir(thread.id)
      const draft = await f.rpc.request<{ id: string; semanticHash: string }>('workflows.create', { profileId: f.alice.id, bundle: lifecycleApprovalWorkflow() })
      await f.rpc.request('workflows.publish', { profileId: f.alice.id, id: draft.id, expectedDraftSemanticHash: draft.semanticHash })
      const run = await f.rpc.request<WorkflowRunView>('workflowRuns.start', {
        profileId: f.alice.id, threadId: thread.id, definitionId: draft.id, requestId: randomUUID(), input: {}
      })
      runId = run.runId
      await vi.waitFor(async () => expect((await f.rpc.request<WorkflowRunView>('workflowRuns.get', { profileId: f.alice.id, runId })).state).toBe('waiting-approval'))
      for (const method of ['threads.delete', 'threads.trash']) {
        await expect(f.rpc.request(method, { threadId: thread.id })).rejects.toThrow(/active|busy|drain|workflow|blocked/i)
        expect(existsSync(join(path, 'meta.json'))).toBe(true)
      }
    } finally {
      if (runId) await f.services.platform.workflowRuns.runtime.cancel(runId, { profileId: f.alice.id }, 'acceptance complete')
      await f.close()
    }
  })

  it('lets an admitted parent finish and persist after both lifecycle requests are rejected', async () => {
    const f = await lifecycleHarness()
    let release = () => {}
    let pending: Promise<unknown> | undefined
    try {
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'drain must not strand a writer' })
      const peer = await f.connect()
      const llm = (f.services.orchestrator as unknown as { llm: {
        getSelectedModelContextLimit(): { limit: number }; getContextInputs(): Promise<unknown>; chat(): Promise<unknown>
      } }).llm
      const contextInputs = { systemPromptText: '', mcpToolsText: '', otherToolsText: '', signature: 'resource-lifecycle-acceptance' }
      let entered = () => {}
      const started = new Promise<void>((resolve) => { entered = resolve })
      const hold = new Promise<void>((resolve) => { release = resolve })
      vi.spyOn(llm, 'getSelectedModelContextLimit').mockReturnValue({ limit: 100_000 })
      vi.spyOn(llm, 'getContextInputs').mockResolvedValue(contextInputs)
      vi.spyOn(llm, 'chat').mockImplementation(async () => {
        entered(); await hold
        return { text: 'durable result after refused deletion', contextInputs, toolEvents: [], nativeMessages: [],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          modelName: 'deterministic', totalResponseTimeMs: 1, totalTokensUsed: 2, tokensPerSecond: 2 }
      })
      pending = f.rpc.request('orchestrator.send', { threadId: thread.id, content: 'wait in provider seam' })
      await started
      for (const method of ['threads.delete', 'threads.trash']) {
        await expect(peer.request(method, { threadId: thread.id })).rejects.toThrow(/active|busy|drain|running|blocked/i)
      }
      release()
      await pending
      expect(f.services.threads.loadThreadData(thread.id).messages.some((message) => message.content === 'durable result after refused deletion')).toBe(true)
      await peer.request('threads.trash', { threadId: thread.id })
      await peer.request('threads.restore', { threadId: thread.id })
      expect(f.services.threads.loadThreadData(thread.id).messages.some((message) => message.content === 'durable result after refused deletion')).toBe(true)
      await peer.request('orchestrator.send', { threadId: thread.id, content: 'a genuinely new episode after restore' })
      const afterRestore = f.services.threads.loadThreadData(thread.id).messages
      expect(afterRestore.some((message) => message.role === 'user' && message.content === 'a genuinely new episode after restore')).toBe(true)
      expect(afterRestore.filter((message) => message.role === 'assistant' && message.content === 'durable result after refused deletion')).toHaveLength(2)
    } finally {
      release()
      await pending?.catch(() => undefined)
      await f.close()
    }
  })

  it('protects an owned live terminal process and admits trash only after its owner confirms termination', async () => {
    const f = await lifecycleHarness()
    let ptyId: string | undefined
    try {
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'owned process drain' })
      const path = f.services.threads.getThreadDir(thread.id)
      const created = await f.rpc.request<{ ptyId: string }>('pty.create', { threadId: thread.id, agentId: 'resource-lifecycle-shell', cwd: f.root })
      ptyId = created.ptyId
      expect(f.services.ptyManager.isAlive(ptyId)).toBe(true)
      for (const method of ['threads.delete', 'threads.trash']) {
        await expect(f.rpc.request(method, { threadId: thread.id })).rejects.toThrow(/active|busy|drain|PTY|blocked/i)
        expect(existsSync(join(path, 'meta.json'))).toBe(true)
        expect(f.services.ptyManager.isAlive(ptyId)).toBe(true)
      }
      await f.rpc.request('pty.kill', { ptyId })
      await vi.waitFor(() => expect(f.services.ptyManager.isAlive(ptyId!)).toBe(false))
      ptyId = undefined
      await f.rpc.request('threads.trash', { threadId: thread.id })
      expect(existsSync(path)).toBe(false)
      await f.rpc.request('threads.restore', { threadId: thread.id })
      const live = await f.rpc.request<{ ptys: unknown[] }>('pty.list', { threadId: thread.id })
      expect(live.ptys).toEqual([])
    } finally {
      if (ptyId) await f.rpc.request('pty.kill', { ptyId }).catch(() => undefined)
      await f.close()
    }
  })
})
