import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ERROR_INFO_CAPABILITY } from '../src/shared/errors'
import type { LifecyclePurgePreview, TrashRetentionPolicy } from '../src/shared/resourceLifecycle'
import { STORAGE_POLICY_DEFAULTS, summarizeCleanupReport, type StorageCleanupReport, type StoragePolicy, type StorageUsageSnapshot } from '../src/shared/storage'
import type { Thread } from '../src/shared/types'
import type { WorkflowRunView } from '../src/shared/workflowRunPlatform'
import { releaseExecutionLeaseHandle, tryAcquireExecutionLease } from '../src/mms/queue/ThreadExecutionLease'
import { lifecycleApprovalWorkflow, lifecycleHarness } from './fixtures/resource-lifecycle-harness'

describe('lifecycle public protocol acceptance', () => {
  it('threads.delete preserves opaque data, requires reviewed purge admission and restores the same identity', async () => {
    const method = 'threads.delete'
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

  it('threads.purge honours a sole-copy discard only from a gui client; a cli client is refused', async () => {
    const f = await lifecycleHarness()
    try {
      const gui = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY])
      const cli = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      const { thread } = await gui.request<{ thread: Thread }>('threads.create', { name: 'sole copy scratch' })
      const path = f.services.threads.getThreadDir(thread.id)
      mkdirSync(join(path, 'terminal-workspace'), { recursive: true })
      writeFileSync(join(path, 'terminal-workspace', 'sole-copy.txt'), 'retained output')
      writeFileSync(join(path, 'terminal-workspace.json'), JSON.stringify({ schemaVersion: 1, kind: 'task-terminal-scratch', threadId: thread.id, workspaceRelativePath: 'terminal-workspace' }))
      await gui.request('threads.trash', { threadId: thread.id })
      const { preview } = await cli.request<{ preview: LifecyclePurgePreview }>('threads.purge', { threadId: thread.id, preview: true })
      expect(preview.items.some((item) => item.discardRequired)).toBe(true)
      const request = { threadId: thread.id, operationId: 'human-gate', expectedGeneration: preview.generation, previewDigest: preview.digest, discard: true }
      await expect(cli.request('threads.purge', request)).rejects.toMatchObject({ code: 'resource_purge_discard_required', errorInfo: { category: 'denied' } })
      const kept = f.services.threads.lifecycleStore.require(thread.id)
      expect(kept.state).toBe('trashed')
      expect(readFileSync(join(kept.location, 'terminal-workspace', 'sole-copy.txt'), 'utf8')).toBe('retained output')
      await gui.request('threads.purge', request)
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('purged')
      expect(existsSync(kept.location)).toBe(false)
    } finally { await f.close() }
  })

  it('threads.configureTrash saves a validated policy for a gui client and refuses a cli client', async () => {
    const f = await lifecycleHarness()
    try {
      const gui = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY])
      const cli = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      const saved = await gui.request<{ policy: TrashRetentionPolicy }>('threads.configureTrash', { graceDays: 7, automaticPurge: true })
      expect(saved.policy).toEqual({ schemaVersion: 1, graceDays: 7, automaticPurge: true })
      // The refusal reaches the client as a generic handler error; what matters is that the policy stays as the human set it.
      await expect(cli.request('threads.configureTrash', { graceDays: 1, automaticPurge: false })).rejects.toMatchObject({ code: 'handler_error' })
      // Which policies are valid is decided in ResourcePurgeService.configure (resourceTrashPolicy.test.ts).
      await expect(gui.request('threads.configureTrash', { graceDays: 7 })).rejects.toThrow()
      await expect(gui.request('threads.configureTrash', { graceDays: 0, automaticPurge: true })).rejects.toThrow()
      const inventory = await cli.request<{ trashPolicy: TrashRetentionPolicy }>('threads.inventory', {})
      expect(inventory.trashPolicy).toEqual({ schemaVersion: 1, graceDays: 7, automaticPurge: true })
    } finally { await f.close() }
  })

  it('threads.trash cannot move data while a physical writer is admitted', async () => {
    const method = 'threads.trash'
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

  it('storage.policy reports the storage rules, the trash policy and whether the storage clock paused cleanup', async () => {
    const f = await lifecycleHarness()
    try {
      const cli = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      expect(await cli.request('storage.policy', {})).toEqual({
        trash: { schemaVersion: 1, graceDays: 30, automaticPurge: false }, trashSweepStatus: { suspended: false },
        policy: STORAGE_POLICY_DEFAULTS, clockSuspended: false
      })
    } finally { await f.close() }
  })

  it('storage.configure saves a validated policy for a gui client and refuses a cli client', async () => {
    const f = await lifecycleHarness()
    try {
      const gui = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY])
      const cli = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      const policy: StoragePolicy = { schemaVersion: 1, worktrees: { removeWithDeletedThreads: false, inactiveDays: 14, removeMerged: true }, browser: { captureDays: 30 } }
      expect((await gui.request<{ policy: StoragePolicy }>('storage.configure', { policy })).policy).toEqual(policy)
      await expect(cli.request('storage.configure', { policy: STORAGE_POLICY_DEFAULTS })).rejects.toMatchObject({ code: 'handler_error' })
      for (const bad of [{ ...policy, worktrees: { ...policy.worktrees, inactiveDays: 0 } }, { ...policy, worktrees: { ...policy.worktrees, inactiveDays: 4000 } }, { ...policy, worktrees: { inactiveDays: 14, removeMerged: true } }, { ...policy, browser: { captureDays: 'soon' } }]) {
        await expect(gui.request('storage.configure', { policy: bad })).rejects.toThrow()
      }
      expect((await cli.request<{ policy: StoragePolicy }>('storage.policy', {})).policy).toEqual(policy)
      expect(JSON.parse(readFileSync(join(f.services.threads.lifecycleStore.root, 'storage-policy.json'), 'utf8'))).toEqual(policy)
    } finally { await f.close() }
  })

  it('storage.cleanup.run is open to a cli client, always answers with a report, and storage.cleanup.lastReport returns it', async () => {
    const f = await lifecycleHarness()
    try {
      const cli = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      expect(await cli.request('storage.cleanup.lastReport', {})).toEqual({ report: null })
      const { report } = await cli.request<{ report: StorageCleanupReport }>('storage.cleanup.run', {})
      expect(report).toMatchObject({ trigger: 'manual', counts: { removed: 0, kept: 0, failed: 0 }, items: [], omittedCount: 0 })
      expect(summarizeCleanupReport(report)).toBe('Nothing needed cleanup.')
      expect(await cli.request('storage.cleanup.lastReport', {})).toEqual({ report })
    } finally { await f.close() }
  })

  it('storage.cleanup.plan is a dry run open to a cli client: it lists what a run would do and records nothing', async () => {
    const f = await lifecycleHarness()
    try {
      const gui = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY])
      const cli = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'plan me' })
      await f.rpc.request('threads.trash', { threadId: thread.id })
      await gui.request('threads.configureTrash', { graceDays: 1, automaticPurge: true })
      f.services.threads.lifecycleStore.update(thread.id, (record) => { record.trashedAt = new Date(Date.now() - 3 * 86_400_000).toISOString() })
      const { plan } = await cli.request<{ plan: Array<{ rule: string; threadId?: string; action: string }> }>('storage.cleanup.plan', {})
      expect(plan).toEqual([expect.objectContaining({ rule: 'trash', threadId: thread.id, action: 'remove' })])
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('trashed')
      expect(await cli.request('storage.cleanup.lastReport', {})).toEqual({ report: null })
    } finally { await f.close() }
  })

  it('storage.usage is open to a cli client, answers from the cache until asked to refresh, and names no path', async () => {
    const f = await lifecycleHarness()
    try {
      const cli = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'measured thread' })
      writeFileSync(join(f.services.threads.getThreadDir(thread.id), 'payload.bin'), Buffer.alloc(96 * 1024, 1))
      const first = await cli.request<StorageUsageSnapshot>('storage.usage', {})
      expect(first.entries.find((entry) => entry.kind === 'threads' && entry.threadId === thread.id)!.bytes).toBeGreaterThanOrEqual(96 * 1024)
      expect(first.names.threads[thread.id]).toBe('measured thread')
      // New data does not show until a refresh.
      writeFileSync(join(f.services.threads.getThreadDir(thread.id), 'more.bin'), Buffer.alloc(96 * 1024, 2))
      expect(await cli.request('storage.usage', {})).toEqual(first)
      const refreshed = await cli.request<StorageUsageSnapshot>('storage.usage', { refresh: true })
      expect(refreshed.measuredAt).not.toBe(first.measuredAt)
      expect(refreshed.entries.find((entry) => entry.threadId === thread.id)!.bytes).toBeGreaterThanOrEqual(192 * 1024)
      expect(JSON.stringify(refreshed)).not.toContain(f.services.threads.getThreadDir(thread.id).replaceAll('\\', '\\\\'))
      await expect(cli.request('storage.usage', { refresh: 'yes' })).rejects.toThrow()
    } finally { await f.close() }
  })

  it('a usage scan and a cleanup run overlap without failing, and the next scan shows the space the run freed', async () => {
    const f = await lifecycleHarness()
    try {
      const gui = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY])
      const cli = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'to be purged' })
      writeFileSync(join(f.services.threads.getThreadDir(thread.id), 'payload.bin'), Buffer.alloc(128 * 1024, 1))
      await f.rpc.request('threads.trash', { threadId: thread.id })
      await gui.request('threads.configureTrash', { graceDays: 1, automaticPurge: true })
      f.services.threads.lifecycleStore.update(thread.id, (record) => { record.trashedAt = new Date(Date.now() - 3 * 86_400_000).toISOString() })
      const unattributed = (usage: StorageUsageSnapshot): number => usage.entries.find((entry) => entry.kind === 'threads' && !entry.threadId)?.bytes ?? 0
      const before = await cli.request<StorageUsageSnapshot>('storage.usage', { refresh: true })
      expect(unattributed(before)).toBeGreaterThanOrEqual(128 * 1024)
      const [report, during] = await Promise.all([
        cli.request<{ report: StorageCleanupReport }>('storage.cleanup.run', {}),
        cli.request<StorageUsageSnapshot>('storage.usage', { refresh: true })
      ])
      expect(report.report.counts.removed).toBe(1)
      expect(during.entries.length).toBeGreaterThan(0)
      const after = await cli.request<StorageUsageSnapshot>('storage.usage', { refresh: true })
      expect(unattributed(after)).toBeLessThan(unattributed(before) - 100 * 1024)
    } finally { await f.close() }
  })

  it('trash and restore go ahead while a slow storage.usage request is still in flight', async () => {
    const f = await lifecycleHarness()
    let release: () => void = () => undefined
    try {
      const cli = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'trashed during a scan' })
      let entered: () => void = () => undefined
      const inFlight = new Promise<void>((resolve) => { entered = resolve })
      const held = new Promise<void>((resolve) => { release = resolve })
      vi.spyOn(f.services.storageUsage, 'measure').mockImplementation(async () => {
        entered()
        await held
        return { measuredAt: new Date().toISOString(), durationMs: 0, partial: true, entries: [], names: { projects: {}, threads: {} } }
      })
      const slow = cli.request('storage.usage', { refresh: true })
      await inFlight
      const began = Date.now()
      await f.rpc.request('threads.trash', { threadId: thread.id })
      await f.rpc.request('threads.restore', { threadId: thread.id })
      // Without the exemption each of these waits two seconds for the scan and then fails with "profile requests are still active".
      expect(Date.now() - began).toBeLessThan(1500)
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('active')
      release()
      await slow
    } finally { release(); await f.close() }
  })

  it('trash, restore and permanent delete each stop disk measurement first and let it carry on afterwards', async () => {
    const f = await lifecycleHarness()
    try {
      const gui = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY])
      const pause = vi.spyOn(f.services.storageUsage, 'pause')
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'moved and removed' })
      writeFileSync(join(f.services.threads.getThreadDir(thread.id), 'payload.bin'), Buffer.alloc(32 * 1024, 1))
      await f.rpc.request('threads.trash', { threadId: thread.id })
      const afterTrash = pause.mock.calls.length
      expect(afterTrash).toBeGreaterThanOrEqual(1)
      await f.rpc.request('threads.restore', { threadId: thread.id })
      expect(pause.mock.calls.length).toBeGreaterThan(afterTrash)
      await f.rpc.request('threads.trash', { threadId: thread.id })
      const { preview } = await gui.request<{ preview: LifecyclePurgePreview }>('threads.purge', { threadId: thread.id, preview: true })
      const beforePurge = pause.mock.calls.length
      await gui.request('threads.purge', { threadId: thread.id, operationId: 'remove-it', expectedGeneration: preview.generation, previewDigest: preview.digest })
      expect(pause.mock.calls.length).toBeGreaterThan(beforePurge)
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('purged')
      // Every pause was released: a scan still runs.
      const usage = await gui.request<StorageUsageSnapshot>('storage.usage', { refresh: true })
      expect(usage.entries.length).toBeGreaterThan(0)
    } finally { await f.close() }
  })

  it.runIf(process.platform === 'win32')('threads can be trashed while a scan is walking their folders', async () => {
    const f = await lifecycleHarness()
    try {
      const cli = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      const created: Thread[] = []
      for (let index = 0; index < 5; index++) {
        const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: `busy folder ${index}` })
        const folder = join(f.services.threads.getThreadDir(thread.id), 'many')
        mkdirSync(folder, { recursive: true })
        for (let file = 0; file < 1500; file++) writeFileSync(join(folder, `f${file}.txt`), 'x')
        created.push(thread)
      }
      // A scan walks the folders while each thread is moved; a walker's open handles make Windows refuse such a rename.
      const scanning = cli.request('storage.usage', { refresh: true })
      for (const thread of created) await f.rpc.request('threads.trash', { threadId: thread.id })
      await scanning
      for (const thread of created) expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('trashed')
    } finally { await f.close() }
  })

  it('a purge preview carries a reclaim estimate beside a preview whose digest is unchanged', async () => {
    const f = await lifecycleHarness()
    try {
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'preview with reclaim' })
      writeFileSync(join(f.services.threads.getThreadDir(thread.id), 'payload.bin'), Buffer.alloc(64 * 1024, 1))
      await f.rpc.request('threads.trash', { threadId: thread.id })
      const response = await f.rpc.request<{ preview: LifecyclePurgePreview; reclaim: { bytes: number; estimated: boolean; partial: boolean } }>('threads.purge', { threadId: thread.id, preview: true })
      expect(response.reclaim.bytes).toBeGreaterThanOrEqual(64 * 1024); expect(response.reclaim.partial).toBe(false)
      expect(response.preview).not.toHaveProperty('reclaim')
      expect((await f.services.lifecycle.cleanup.preview(thread.id)).digest).toBe(response.preview.digest)
    } finally { await f.close() }
  })
})
