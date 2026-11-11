/**
 * Deleting a thread while its turn runs, through the real profile and protocol: the delete stops the turn (its queue
 * goes with the thread), leaves no provider turn running, and reports success. A window's reads that arrive while
 * the delete runs make it wait, not fail.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../src/mms/harness/adapter'
import type { ProviderDriverKind } from '../src/shared/providerInstances'
import { ERROR_INFO_CAPABILITY } from '../src/shared/errors'
import type { Thread } from '../src/shared/types'
import { testHarness } from '../src/mms/run/testkit/harness'
import { readDurableQueue } from '../src/mms/queue/durableQueue'
import { sharedThreadDbClient } from '../src/mms/data/threadDb/threadDbClient'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'
import { waitFor } from './run/phase6Fixture'
import { PI_TEST_CAPABILITIES } from './support/piStub'
import { archived } from './support/archived'

vi.setConfig({ testTimeout: 60_000 })

/** A provider whose turn streams until it is stopped, as a long turn does. */
class SlowAdapter implements ProviderAdapter {
  live = 0
  private readonly stops = new Set<() => void>()
  constructor(readonly driver: ProviderDriverKind, readonly capabilities: ProviderCapabilities) {}
  configured(): boolean { return true }
  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, _host: AdapterHost): Promise<TurnResult> {
    this.live += 1
    const providerRef = { provider: input.llmProvider, model: input.model }
    sink.providerRef(providerRef)
    try {
      sink.text({ phase: 'delta', content: 'working', contentIndex: 0 })
      await new Promise<void>((resolve) => { this.stops.add(resolve) })
      return { text: '', aborted: true, modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'scripted', nativeMessages: [], providerRef }
    } finally {
      this.live -= 1
    }
  }
  async interrupt(): Promise<'interrupted' | 'not_active'> {
    const waiting = [...this.stops]
    this.stops.clear()
    for (const resolve of waiting) resolve()
    return waiting.length ? 'interrupted' : 'not_active'
  }
}

async function runningThread() {
  const f = await lifecycleHarness()
  const adapter = new SlowAdapter('pi', PI_TEST_CAPABILITIES)
  f.services.settings.set({ provider: { llmProvider: 'openai', model: 'deterministic' } })
  f.services.orchestrator.setHarness(testHarness({ profileHome: f.services.getProfileHomeDir(), adapters: [adapter] }))
  const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'long turn' })
  const sent = f.rpc.request('orchestrator.send', { threadId: thread.id, content: 'take your time' }).catch(() => undefined)
  await waitFor(() => adapter.live === 1, 'the turn to reach the provider')
  // A message sent meanwhile waits in the queue behind the running turn.
  const queued = f.rpc.request('orchestrator.send', { threadId: thread.id, content: 'and then this' }).catch(() => undefined)
  await waitFor(() => readDurableQueue(f.services.threads, thread.id).some((item) => item.state === 'pending'), 'the queued message')
  const close = async () => {
    await adapter.interrupt()
    await Promise.all([sent, queued])
    // The thread's last save sends its search index notice a second later. In tests the index runs in this process on
    // one shared engine that outlives the daemon, so it is closed here, or its file stays open and the folder cannot go.
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    await sharedThreadDbClient().call('closeEverything')
    await f.close()
  }
  return { f, adapter, thread, close }
}

describe('deleting a thread while its turn runs', () => {
  for (const via of ['gui', 'cli'] as const) {
    it(`stops the turn and its queue, deletes the thread, and reports success (${via})`, async () => {
      const { f, adapter, thread, close } = await runningThread()
      try {
        const client = via === 'gui' ? f.rpc : await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
        // Archived while its turn still runs: the archive's own Stop has not ended it yet.
        archived(f.services.threads, thread.id)
        expect(f.services.orchestrator.isTurnActive(thread.id)).toBe(true)
        const reply = await client.request<{ threads: Thread[]; lifecycle: { state: string } }>('threads.delete', { threadId: thread.id })
        expect(reply.lifecycle.state).toBe('purged')
        expect(reply.threads.some((listed) => listed.id === thread.id)).toBe(false)
        expect(f.services.threads.getThread(thread.id)).toBeUndefined()
        // Nothing of it runs any more, and the queued message never became a turn.
        expect(adapter.live).toBe(0)
        expect(f.services.orchestrator.isTurnActive(thread.id)).toBe(false)
        expect(f.services.runEngine.getActiveRun(thread.id)).toBeNull()
        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(adapter.live).toBe(0)
      } finally {
        await close()
      }
    })
  }

  it('waits for a window\'s read that arrives while the delete runs, instead of failing with the thread half gone', async () => {
    const { f, thread, close } = await runningThread()
    let release = () => {}
    let poll: Promise<unknown> | undefined
    try {
      await f.rpc.request('threads.settle', { threadId: thread.id, settled: true })
      const peer = await f.connect(f.alice.id, ['browser.viewer.v1'])
      const browser = f.services.platform.browser, status = browser.accessStatus()
      const hold = new Promise<void>((resolve) => { release = resolve })
      vi.spyOn(browser, 'accessStatus').mockImplementation(() => hold.then(() => status) as never)
      // The window still shows the thread: a read of it arrives once the delete is under way, and answers soon after.
      const preview = f.services.lifecycle.cleanup.preview.bind(f.services.lifecycle.cleanup)
      let reads = 0
      vi.spyOn(f.services.lifecycle.cleanup, 'preview').mockImplementation(async (...args) => {
        if (reads++ === 0) {
          poll = peer.request('browser.access.status', { profileId: f.alice.id }).catch(() => undefined)
          await vi.waitFor(() => expect(f.services.getOwnedActivity()['rpc:browser.access.status']).toBe(1))
          setTimeout(() => release(), 300)
        }
        return preview(...args)
      })
      const reply = await f.rpc.request<{ lifecycle: { state: string } }>('threads.delete', { threadId: thread.id })
      expect(reply.lifecycle.state).toBe('purged')
      expect(f.services.threads.getThread(thread.id)).toBeUndefined()
      expect(f.services.threads.lifecycleStore.get(thread.id)?.state).toBe('purged')
    } finally {
      release()
      await poll
      vi.restoreAllMocks()
      await close()
    }
  })
})
