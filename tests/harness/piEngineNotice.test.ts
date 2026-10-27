/**
 * PR 2 §5 "Engine notice": the first RPC turn of each `pi:*` instance tells the thread, once, that
 * the provider now runs on Pi's agent and how to switch back; it is recorded in the instance's state
 * dir and not shown again, also after a restart.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DriverContext } from '../../src/mms/harness/driver'
import { ENGINE_NOTICE_FILE, createRpcRuntime } from '../../src/mms/harness/drivers/pi/engines/rpc'
import type { TurnInput } from '../../src/mms/run/adapters/ProviderAdapter'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const unused = () => { throw new Error('unused') }

function runtimeIn(stateDir: string) {
  const context = {
    instanceId: 'pi:openrouter',
    builtIn: true,
    config: { home: 'default', engine: 'rpc' },
    // No home: the engine refuses to start, after the notice decision (nothing is spawned).
    env: { instanceId: 'pi:openrouter', homeId: 'x', env: {} },
    profileHome: stateDir,
    installationHome: stateDir,
    stateDir,
    questions: {} as DriverContext['questions'],
    findBinary: () => undefined,
    changed: () => {}
  } as unknown as DriverContext
  const runtime = createRpcRuntime(context, 'openrouter', 'OpenRouter', () => undefined, { runtime: unused, catalog: unused })
  const notices: Array<{ threadId: string; text: string }> = []
  runtime.setLiveHost?.({ notice: (threadId, text) => notices.push({ threadId, text }) })
  const turn = async (threadId: string) => {
    const input = { threadId, instanceId: 'pi:openrouter', llmProvider: 'openrouter', model: 'm', mode: 'agent', prompt: 'hi', signal: new AbortController().signal } as unknown as TurnInput
    const sink = { providerRef: () => {} } as never
    await runtime.adapter.startTurn(input, sink, {} as never, {} as never).catch(() => undefined)
  }
  return { runtime, notices, turn }
}

describe('Pi engine notice', () => {
  it('shows once per instance and survives a restart', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'mousse-pi-notice-'))
    dirs.push(stateDir)
    const first = runtimeIn(stateDir)
    await first.turn('thread-a')
    await first.turn('thread-b')
    expect(first.notices).toEqual([{
      threadId: 'thread-a',
      text: "OpenRouter now runs on Pi's agent, so its tools and replies may differ slightly. To switch back: Providers → OpenRouter → Advanced → Engine: Legacy."
    }])
    expect(existsSync(join(stateDir, ENGINE_NOTICE_FILE))).toBe(true)
    await first.runtime.stop()
    const restarted = runtimeIn(stateDir)
    await restarted.turn('thread-c')
    expect(restarted.notices).toEqual([])
    await restarted.runtime.stop()
  })

  it('waits for a live host before it counts as shown', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'mousse-pi-notice-'))
    dirs.push(stateDir)
    const headless = runtimeIn(stateDir)
    headless.runtime.setLiveHost?.(null)
    await headless.turn('thread-a')
    expect(existsSync(join(stateDir, ENGINE_NOTICE_FILE))).toBe(false)
    await headless.runtime.stop()
  })
})
