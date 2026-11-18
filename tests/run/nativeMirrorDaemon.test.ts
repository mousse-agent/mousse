/**
 * A native helper's mirror thread through the real profile and protocol (docs/plans/tool-api.md §2.7): nothing sent to
 * it reaches the helper, and a Stop of it stops that helper alone where the runtime can, else is refused naming the
 * run that hosts it. The hosting thread is never stopped from its mirror.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Thread, ThreadNativeHelper } from '../../src/shared/types'
import { sharedThreadDbClient } from '../../src/mms/data/threadDb/threadDbClient'
import { lifecycleHarness } from '../fixtures/resource-lifecycle-harness'

vi.setConfig({ testTimeout: 60_000 })

describe("a native helper's mirror thread", () => {
  let f: Awaited<ReturnType<typeof lifecycleHarness>> | undefined
  afterEach(async () => {
    await sharedThreadDbClient().call('closeEverything')
    await f?.close()
    f = undefined
  })

  const setup = async (native: Partial<ThreadNativeHelper> = {}) => {
    f = await lifecycleHarness()
    const host = (await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'Fix login' })).thread
    const services = f.services
    const mirrorOf = (patch: Partial<ThreadNativeHelper>) => {
      const helper: ThreadNativeHelper = { runtime: 'codex', instanceId: 'codex-main', sessionEpoch: 'codex:h:1', agentId: 'thr_1', hostRunId: 'run-9', state: 'running', ...patch }
      return services.threads.createThread('Check the tests', undefined, undefined, {
        id: `native-000000000000-${helper.agentId}`,
        started: true,
        lineage: { parentThreadId: host.id, rootThreadId: host.id, relationship: 'native' },
        ownerThreadId: host.id,
        native: helper
      })
    }
    const mirror = mirrorOf(native)
    const stopHelper = vi.fn(async (): Promise<'stopped' | 'not_active' | 'unsupported'> => 'stopped')
    ;(f.services.orchestrator as unknown as { harness: { stopNativeHelper?: unknown } }).harness.stopNativeHelper = stopHelper
    const stopHost = vi.spyOn(f.services.orchestrator as unknown as { stopCompaction: (id: string) => unknown }, 'stopCompaction')
    return { f, host, mirror, mirrorOf, stopHelper, stopHost }
  }

  it('refuses a message with runtime_owned, naming the helper', async () => {
    const { f, mirror, mirrorOf } = await setup()
    await expect(f.rpc.request('orchestrator.send', { threadId: mirror.id, content: 'hello' })).rejects.toMatchObject({ code: 'runtime_owned', message: expect.stringContaining('thr_1') })
    const claude = mirrorOf({ runtime: 'claude', agentId: 'toolu_A', sendTo: 'agent-7' })
    await expect(f.rpc.request('orchestrator.send', { threadId: claude.id, content: 'hello' })).rejects.toMatchObject({ code: 'runtime_owned', message: expect.stringContaining('SendMessage with agent agent-7') })
  })

  it("a person's Stop stops that one helper through the runtime, never the hosting thread", async () => {
    const { f, host, mirror, stopHelper, stopHost } = await setup()
    await expect(f.rpc.request('orchestrator.abort', { threadId: mirror.id })).resolves.toEqual({ ok: true })
    expect(stopHelper).toHaveBeenCalledWith('codex-main', host.id, 'thr_1')
    expect(stopHost).not.toHaveBeenCalled()
  })

  it('a Stop the runtime cannot carry out is refused, naming the run that hosts the helper', async () => {
    const { f, host, mirror, stopHelper } = await setup({ runtime: 'claude', agentId: 'toolu_A' })
    stopHelper.mockResolvedValue('unsupported')
    const outcome = await f.services.orchestrator.stopThread(mirror.id, 'agent')
    expect(outcome).toMatchObject({ ok: false, status: 'rejected', reason: expect.stringMatching(/^runtime_owned: .*Stop the run of "Fix login" \(thread .*run run-9\)/) })
    expect(outcome.reason).toContain(host.id)
  })
})
