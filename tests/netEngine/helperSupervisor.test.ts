/**
 * The helper's life (design §1): started, said hello to, started again after it exits (0.5 s doubling, from the
 * first again after a minute up, "keeps stopping" after three quick exits), waited for while another helper still
 * holds the endpoint, shut down with a kill after the grace, and turned off when it speaks another major version.
 * The launches are fake; `helperProcess.test.ts` runs the real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppChannel } from '../../src/mms/netEngine/helper/appChannel'
import { EngineHelper } from '../../src/mms/netEngine/helper/connections'
import type { LaunchedHelper } from '../../src/mms/netEngine/helper/process'
import { HELPER_TEXT, HelperNotInBuild, HelperSupervisor } from '../../src/mms/netEngine/helper/supervisor'
import { FakeNetwork, type FakeHelper } from './fakeHelper'

interface Run {
  fake: FakeHelper
  launched: LaunchedHelper
  /** The exit it reports; a kill ends it too. */
  exit(stderr?: string): void
}

function harness(
  options: {
    proto?: number
    /** The build the helper says it is in hello, and the one the app was packaged with. */
    build?: string
    expectedBuild?: string
    ignoreShutdown?: boolean
    failLaunch?: () => Error | undefined
    /** What a helper says on its way out as soon as it starts, before any hello. */
    exitAtStart?: () => string | undefined
    /** The profile the helper's endpoint belongs to (the app says `mine`). */
    endpointProfile?: () => string
  } = {}
) {
  const network = new FakeNetwork()
  const runs: Run[] = []
  const mismatch = vi.fn()
  const wrongProfile = vi.fn()
  const supervisor = new HelperSupervisor({
    launch: async () => {
      const failure = options.failLaunch?.()
      if (failure) throw failure
      const fake = network.helper('endpoint-a', options.endpointProfile?.())
      let exit!: (value: { code: number; signal: null; stderr: string }) => void
      const exited = new Promise<{ code: number; signal: null; stderr: string }>((resolve) => (exit = resolve))
      let said = ''
      fake.pipe.onClose(() => exit({ code: 1, signal: null, stderr: said }))
      if (options.ignoreShutdown) fake.ignoreShutdown = true
      const launched: LaunchedHelper = {
        pipe: options.ignoreShutdown ? { ...fake.pipe, close: () => undefined } : fake.pipe,
        exited,
        kill: () => fake.kill()
      }
      const run: Run = {
        fake,
        launched,
        exit: (stderr = '') => {
          said = stderr
          fake.kill()
        }
      }
      runs.push(run)
      const last = options.exitAtStart?.()
      if (last) run.exit(last)
      return launched
    },
    use: async (pipe) => {
      const helper = new EngineHelper(new AppChannel(pipe), {
        peers: { byIdentity: () => undefined },
        attach: async () => undefined,
        name: () => 'Desk',
        profile: () => 'mine'
      })
      await helper.hello()
      if (options.proto !== undefined) helper.info.proto = [options.proto, 0]
      if (options.build !== undefined) helper.info.build = options.build
      return helper
    },
    expectedBuild: () => options.expectedBuild,
    mismatch,
    wrongProfile
  })
  return { supervisor, runs, mismatch, wrongProfile }
}

/** Lets the in-memory pipes and promises settle without moving the clock. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0)
}

describe('the helper supervisor', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }))
  afterEach(() => vi.useRealTimers())

  it('starts the helper again after it exits, waiting 0.5 s and then twice as long each time', async () => {
    const { supervisor, runs } = harness()
    supervisor.start()
    await settle()
    expect(supervisor.status()).toMatchObject({ state: 'running', generation: 1 })
    const waits: number[] = []
    for (let i = 0; i < 4; i++) {
      runs.at(-1)!.exit()
      await settle()
      const status = supervisor.status()
      expect(status.state).toBe('restarting')
      waits.push((status as { inMs: number }).inMs)
      await vi.advanceTimersByTimeAsync((status as { inMs: number }).inMs)
      await settle()
      expect(supervisor.status().state).toBe('running')
    }
    expect(waits).toEqual([500, 1000, 2000, 4000])
    expect(runs).toHaveLength(5)
    // The fourth exit in a row, each quick, says the helper keeps stopping (three is the limit).
    runs.at(-1)!.exit()
    await settle()
    expect(supervisor.status()).toMatchObject({ state: 'restarting', text: HELPER_TEXT.keepsStopping })
    await supervisor.stop()
  })

  it('starts the waits from the first again after a minute up', async () => {
    const { supervisor, runs } = harness()
    supervisor.start()
    await settle()
    runs.at(-1)!.exit()
    await settle()
    await vi.advanceTimersByTimeAsync(500)
    await settle()
    await vi.advanceTimersByTimeAsync(60_000)
    runs.at(-1)!.exit()
    await settle()
    expect(supervisor.status()).toMatchObject({ state: 'restarting', inMs: 500 })
    expect(supervisor.status()).not.toHaveProperty('text')
    await supervisor.stop()
  })

  it('caps the wait at 5 minutes and keeps trying every 5 minutes', async () => {
    let failing = true
    const { supervisor } = harness({ failLaunch: () => (failing ? new Error('keystore locked') : undefined) })
    supervisor.start()
    const waits: number[] = []
    for (let i = 0; i < 13; i++) {
      await settle()
      const status = supervisor.status() as { inMs: number }
      waits.push(status.inMs)
      await vi.advanceTimersByTimeAsync(status.inMs)
    }
    expect(waits).toEqual([...Array.from({ length: 10 }, (_, i) => 500 * 2 ** i), 300_000, 300_000, 300_000])
    failing = false
    await vi.advanceTimersByTimeAsync(300_000)
    await settle()
    expect(supervisor.status().state).toBe('running')
    await supervisor.stop()
  })

  it('waits for another helper to let go of the endpoint, then says one is still running', async () => {
    const held = 'error: local state: another process is already running this endpoint'
    let holding = true
    const { supervisor } = harness({ exitAtStart: () => (holding ? held : undefined) })
    supervisor.start()
    const waits: string[] = []
    for (let i = 0; i < 12; i++) {
      await settle()
      const status = supervisor.status() as { inMs: number; text?: string }
      waits.push(status.text ?? `${status.inMs}`)
      await vi.advanceTimersByTimeAsync(status.inMs)
      await settle()
    }
    // Every half second for 5 s, then the status says so and the waits grow as after any exit.
    expect(waits.slice(0, 10)).toEqual(Array(10).fill('500'))
    expect(waits[10]).toBe(HELPER_TEXT.anotherRunning)
    holding = false
    await vi.advanceTimersByTimeAsync(300_000)
    await settle()
    expect(supervisor.status().state).toBe('running')
    await supervisor.stop()
  })

  it('shuts the helper down, and kills it when it does not exit within the grace', async () => {
    const { supervisor, runs } = harness({ ignoreShutdown: true })
    supervisor.start()
    await settle()
    const stopped = supervisor.stop()
    await vi.advanceTimersByTimeAsync(2_900)
    expect(runs[0]!.fake.alive).toBe(true)
    await vi.advanceTimersByTimeAsync(200)
    await stopped
    expect(runs[0]!.fake.alive).toBe(false)
    expect(supervisor.status()).toEqual({ state: 'off' })
    // Nothing starts it again.
    await vi.advanceTimersByTimeAsync(600_000)
    expect(runs).toHaveLength(1)
  })

  it('turns networking off when the helper speaks another major version', async () => {
    const { supervisor, mismatch, runs } = harness({ proto: 2 })
    supervisor.start()
    await settle()
    expect(supervisor.status()).toEqual({ state: 'mismatch', text: HELPER_TEXT.mismatch })
    expect(mismatch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(runs).toHaveLength(1)
  })

  // The packaged helper against the engine commit the app was packaged with (`stale-helper` in phase1b.desktop-builds).
  it.each([
    ['the pinned commit', '8ceac9c57b6b0c9c8df03d756332b064088f12a0+release', 'running'],
    ['the pinned commit, abbreviated', '8ceac9c+release', 'running'],
    ['another commit', '0000000+release', 'mismatch'],
    ['the pinned commit with changes', '8ceac9c57b6b0c9c8df03d756332b064088f12a0-dirty+release', 'mismatch'],
    ['a debug build', '8ceac9c57b6b0c9c8df03d756332b064088f12a0+debug', 'mismatch'],
    ['no build', undefined, 'mismatch']
  ])('an installed app runs its helper only when it is %s', async (_name, build, state) => {
    const { supervisor, mismatch } = harness({
      build: build ?? '',
      expectedBuild: '8ceac9c57b6b0c9c8df03d756332b064088f12a0'
    })
    supervisor.start()
    await settle()
    expect(supervisor.status().state).toBe(state)
    expect(mismatch).toHaveBeenCalledTimes(state === 'mismatch' ? 1 : 0)
    await supervisor.stop()
  })

  it('sets an endpoint of another profile aside once its helper exits, and starts again', async () => {
    let profile = 'theirs'
    const { supervisor, wrongProfile, runs } = harness({ endpointProfile: () => profile })
    wrongProfile.mockImplementation(() => {
      expect(runs[0]!.fake.alive).toBe(false)
      profile = 'mine'
    })
    supervisor.start()
    await settle()
    expect(wrongProfile).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    await settle()
    expect(supervisor.status().state).toBe('running')
    expect(runs).toHaveLength(2)
    await supervisor.stop()
  })

  it('says "Not in this build" when there is no helper', async () => {
    const { supervisor } = harness({ failLaunch: () => new HelperNotInBuild() })
    supervisor.start()
    await settle()
    expect(supervisor.status()).toEqual({ state: 'not_in_build', text: 'Not in this build' })
  })
})
