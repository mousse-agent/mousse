/**
 * Deleting a thread while its turn runs, through the real profile and protocol: the delete stops the turn (its queue
 * goes with the thread), leaves no provider turn running, and reports success. A delete that will be refused stops
 * nothing. A window's reads that arrive while the delete runs make it wait, not fail, and an unarchive meanwhile keeps
 * the thread.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../src/mms/harness/adapter'
import type { ProviderDriverKind, ProviderRef } from '../src/shared/providerInstances'
import { ERROR_INFO_CAPABILITY } from '../src/shared/errors'
import type { Thread } from '../src/shared/types'
import { testHarness } from '../src/mms/run/testkit/harness'
import { readDurableQueue } from '../src/mms/queue/durableQueue'
import { sharedThreadDbClient } from '../src/mms/data/threadDb/threadDbClient'
import type { MmsProfileServices } from '../src/mms/MmsProfileServices'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'
import { waitFor } from './run/phase6Fixture'
import { PI_TEST_CAPABILITIES } from './support/piStub'
import { archived } from './support/archived'

vi.setConfig({ testTimeout: 60_000 })

/** A provider whose turns stream until each is stopped, as long turns do. Each turn reports its thread as its session. */
class SlowAdapter implements ProviderAdapter {
  private readonly running = new Map<string, Set<() => void>>()
  constructor(readonly driver: ProviderDriverKind, readonly capabilities: ProviderCapabilities) {}
  configured(): boolean { return true }
  live(threadId?: string): number {
    if (threadId) return this.running.get(threadId)?.size ?? 0
    return [...this.running.values()].reduce((sum, set) => sum + set.size, 0)
  }
  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, _host: AdapterHost): Promise<TurnResult> {
    const providerRef: ProviderRef = { provider: input.llmProvider, model: input.model, sessionId: input.threadId }
    sink.providerRef(providerRef)
    const set = this.running.get(input.threadId) ?? new Set()
    this.running.set(input.threadId, set)
    let stop = () => {}
    const stopped = new Promise<void>((resolve) => { stop = resolve })
    set.add(stop)
    try {
      sink.text({ phase: 'delta', content: 'working', contentIndex: 0 })
      await stopped
      return { text: '', aborted: true, modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'scripted', nativeMessages: [], providerRef }
    } finally {
      set.delete(stop)
    }
  }
  /** Stops the turns of the thread `ref` names; without one, every turn (the end of a test). */
  async interrupt(ref?: ProviderRef): Promise<'interrupted' | 'not_active'> {
    const sets = ref?.sessionId ? [this.running.get(ref.sessionId) ?? new Set<() => void>()] : [...this.running.values()]
    const waiting = sets.flatMap((set) => [...set])
    for (const stop of waiting) stop()
    return waiting.length ? 'interrupted' : 'not_active'
  }
}

type Harness = Awaited<ReturnType<typeof lifecycleHarness>>

async function profile() {
  const f = await lifecycleHarness()
  const adapter = new SlowAdapter('pi', PI_TEST_CAPABILITIES)
  f.services.settings.set({ provider: { llmProvider: 'openai', model: 'deterministic' } })
  f.services.orchestrator.setHarness(testHarness({ profileHome: f.services.getProfileHomeDir(), adapters: [adapter] }))
  const sends: Promise<unknown>[] = []
  const pending = (threadId: string) => readDurableQueue(f.services.threads, threadId).filter((item) => item.state === 'pending').length
  /** Starts a long turn in `threadId`, and queues a second message behind it unless `queue` is false. */
  const run = async (threadId: string, queue = true) => {
    sends.push(f.rpc.request('orchestrator.send', { threadId, content: 'take your time' }).catch(() => undefined))
    await waitFor(() => adapter.live(threadId) === 1, 'the turn to reach the provider')
    if (!queue) return
    sends.push(f.rpc.request('orchestrator.send', { threadId, content: 'and then this' }).catch(() => undefined))
    await waitFor(() => pending(threadId) === 1, 'the queued message')
  }
  const thread = async (name: string) => (await f.rpc.request<{ thread: Thread }>('threads.create', { name })).thread
  const close = async () => {
    await adapter.interrupt()
    await Promise.all(sends)
    // The thread's last save sends its search index notice a second later. In tests the index runs in this process on
    // one shared engine that outlives the daemon, so it is closed here, or its file stays open and the folder cannot go.
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    await sharedThreadDbClient().call('closeEverything')
    await f.close()
  }
  return { f, adapter, run, pending, thread, close }
}

const stopsFor = (services: MmsProfileServices) => vi.spyOn(services as unknown as { stopRunsForDelete: (ids: readonly string[]) => Promise<void> }, 'stopRunsForDelete')

/** Puts a file only this thread has in its scratch folder: unpublished work only a person in the app may discard. */
function soleCopy(f: Harness, threadId: string): void {
  const path = f.services.threads.getThreadDir(threadId)
  mkdirSync(join(path, 'terminal-workspace'), { recursive: true })
  writeFileSync(join(path, 'terminal-workspace', 'sole-copy.txt'), 'retained output')
  writeFileSync(join(path, 'terminal-workspace.json'), JSON.stringify({ schemaVersion: 1, kind: 'task-terminal-scratch', threadId, workspaceRelativePath: 'terminal-workspace' }))
}

/** Nothing of `threadId` was touched: listed, active, its turn running and its queue as it was. */
function untouched(p: Awaited<ReturnType<typeof profile>>, threadId: string, queued = 1): void {
  expect(p.f.services.threads.getThread(threadId)).toBeDefined()
  expect(p.f.services.threads.lifecycleStore.get(threadId)?.state ?? 'active').toBe('active')
  expect(p.adapter.live(threadId)).toBe(1)
  expect(p.pending(threadId)).toBe(queued)
}

describe('deleting a thread while its turn runs', () => {
  for (const via of ['gui', 'cli'] as const) {
    it(`stops the turn and its queue once, deletes the thread, and reports success (${via})`, async () => {
      const p = await profile()
      try {
        const target = await p.thread('long turn')
        await p.run(target.id)
        const stops = stopsFor(p.f.services)
        const client = via === 'gui' ? p.f.rpc : await p.f.connect(p.f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
        // Archived while its turn still runs: the archive's own Stop has not ended it yet.
        archived(p.f.services.threads, target.id)
        const reply = await client.request<{ threads: Thread[]; lifecycle: { state: string } }>('threads.delete', { threadId: target.id })
        expect(reply.lifecycle.state).toBe('purged')
        expect(reply.threads.some((listed) => listed.id === target.id)).toBe(false)
        expect(p.f.services.threads.getThread(target.id)).toBeUndefined()
        // Nothing of it runs any more, and the queued message never became a turn.
        expect(p.adapter.live()).toBe(0)
        expect(p.f.services.orchestrator.isTurnActive(target.id)).toBe(false)
        expect(p.f.services.runEngine.getActiveRun(target.id)).toBeNull()
        // One Stop: before the delete was admitted, not again inside it.
        expect(stops).toHaveBeenCalledTimes(1)
        // A window asking for it hears it is gone for good, so it leaves it (`watchDeletedShownThread`).
        const asked = await client.request('threads.get', { threadId: target.id }).then(() => undefined, (error: { code?: string; details?: { deleting?: boolean } }) => error)
        expect(asked?.code).toBe('thread_not_found')
        expect(asked?.details?.deleting).toBeUndefined()
        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(p.adapter.live()).toBe(0)
      } finally {
        await p.close()
      }
    })
  }

  it('stops the turns of its subagent threads too, and deletes them with it', async () => {
    const p = await profile()
    try {
      const parent = await p.thread('parent')
      const child = p.f.services.threads.createThread('its subagent', undefined, undefined, { started: true, lineage: { parentThreadId: parent.id, rootThreadId: parent.id, relationship: 'subagent' } })
      await p.run(parent.id, false)
      await p.run(child.id, false)
      archived(p.f.services.threads, parent.id)
      const reply = await p.f.rpc.request<{ lifecycle: { state: string } }>('threads.delete', { threadId: parent.id })
      expect(reply.lifecycle.state).toBe('purged')
      expect(p.f.services.threads.getThread(child.id)).toBeUndefined()
      expect(p.adapter.live(child.id)).toBe(0)
      expect(p.adapter.live(parent.id)).toBe(0)
    } finally {
      await p.close()
    }
  })

  it('waits for a window\'s read that arrives while the delete runs, instead of failing with the thread half gone', async () => {
    const p = await profile()
    let release = () => {}
    let poll: Promise<unknown> | undefined
    try {
      const target = await p.thread('long turn')
      await p.run(target.id)
      await p.f.rpc.request('threads.settle', { threadId: target.id, settled: true })
      const peer = await p.f.connect(p.f.alice.id, ['browser.viewer.v1'])
      const browser = p.f.services.platform.browser, status = browser.accessStatus()
      const hold = new Promise<void>((resolve) => { release = resolve })
      vi.spyOn(browser, 'accessStatus').mockImplementation(() => hold.then(() => status) as never)
      // The window still shows the thread: a read of it arrives once the delete is under way, and answers soon after.
      const preview = p.f.services.lifecycle.cleanup.preview.bind(p.f.services.lifecycle.cleanup)
      let reads = 0
      vi.spyOn(p.f.services.lifecycle.cleanup, 'preview').mockImplementation(async (...args) => {
        if (reads++ === 0) {
          poll = peer.request('browser.access.status', { profileId: p.f.alice.id }).catch(() => undefined)
          await vi.waitFor(() => expect(p.f.services.getOwnedActivity()['rpc:browser.access.status']).toBe(1))
          setTimeout(() => release(), 300)
        }
        return preview(...args)
      })
      const reply = await p.f.rpc.request<{ lifecycle: { state: string } }>('threads.delete', { threadId: target.id })
      expect(reply.lifecycle.state).toBe('purged')
      expect(p.f.services.threads.getThread(target.id)).toBeUndefined()
    } finally {
      release()
      await poll
      vi.restoreAllMocks()
      await p.close()
    }
  })

  it('keeps a thread unarchived while the delete waited for a busy profile', async () => {
    const p = await profile()
    let release = () => {}
    let poll: Promise<unknown> | undefined
    try {
      const target = await p.thread('changed my mind')
      archived(p.f.services.threads, target.id)
      const peer = await p.f.connect(p.f.alice.id, ['browser.viewer.v1'])
      const browser = p.f.services.platform.browser, status = browser.accessStatus()
      const hold = new Promise<void>((resolve) => { release = resolve })
      vi.spyOn(browser, 'accessStatus').mockImplementation(() => hold.then(() => status) as never)
      // The first trash is refused while a read is in flight; while the delete waits to try again, the person
      // unarchives the thread, and only then does the read answer.
      const services = p.f.services as unknown as { trashThread: MmsProfileServices['trashThread'] }
      const trash = services.trashThread.bind(p.f.services)
      let tries = 0
      vi.spyOn(services, 'trashThread').mockImplementation(async (...args) => {
        if (tries++ === 0) {
          poll = peer.request('browser.access.status', { profileId: p.f.alice.id }).catch(() => undefined)
          await vi.waitFor(() => expect(p.f.services.getOwnedActivity()['rpc:browser.access.status']).toBe(1))
          setTimeout(() => { p.f.services.threads.setThreadSettled(target.id, false); release() }, 300)
        }
        return trash(...args)
      })
      await expect(p.f.rpc.request('threads.delete', { threadId: target.id })).rejects.toThrow('Archive the thread before deleting it')
      expect(tries).toBe(1)
      expect(p.f.services.threads.getThread(target.id)?.settledAt).toBeUndefined()
      expect(p.f.services.threads.lifecycleStore.get(target.id)?.state ?? 'active').toBe('active')
    } finally {
      release()
      await poll
      vi.restoreAllMocks()
      await p.close()
    }
  })
})

describe('a delete that will be refused stops nothing', () => {
  it('while another thread is running: the turn keeps running and its queue stays', async () => {
    const p = await profile()
    try {
      const target = await p.thread('to delete')
      const other = await p.thread('still working')
      await p.run(target.id)
      await p.run(other.id, false)
      archived(p.f.services.threads, target.id)
      const stops = stopsFor(p.f.services)
      await expect(p.f.rpc.request('threads.delete', { threadId: target.id })).rejects.toThrow(/profile execution is still active/)
      expect(stops).not.toHaveBeenCalled()
      untouched(p, target.id)
      expect(p.adapter.live(other.id)).toBe(1)
    } finally {
      await p.close()
    }
  })

  it('a thread the deleted one launched, still running: neither turn is stopped', async () => {
    const p = await profile()
    try {
      const creator = await p.thread('creator')
      const launched = p.f.services.threads.createThread('launched by it', undefined, undefined, { started: true, createdByThreadId: creator.id })
      await p.run(creator.id)
      await p.run(launched.id, false)
      archived(p.f.services.threads, creator.id)
      await expect(p.f.rpc.request('threads.delete', { threadId: creator.id })).rejects.toThrow(/profile execution is still active/)
      untouched(p, creator.id)
      expect(p.adapter.live(launched.id)).toBe(1)
      expect(p.f.services.threads.getThread(launched.id)).toBeDefined()
    } finally {
      await p.close()
    }
  })

  it('from the CLI, with unpublished work: the turn keeps running and its queue stays', async () => {
    const p = await profile()
    try {
      const target = await p.thread('has scratch output')
      await p.run(target.id)
      soleCopy(p.f, target.id)
      archived(p.f.services.threads, target.id)
      const stops = stopsFor(p.f.services)
      const cli = await p.f.connect(p.f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      await expect(cli.request('threads.delete', { threadId: target.id })).rejects.toThrow('The thread has unpublished work')
      expect(stops).not.toHaveBeenCalled()
      untouched(p, target.id)
    } finally {
      await p.close()
    }
  })
})
