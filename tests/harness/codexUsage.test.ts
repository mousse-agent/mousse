import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { USAGE_READ_MS, type Harness } from '../../src/mms/harness/gateway'
import { codexDriver } from '../../src/mms/harness/drivers/codex'
import type { CodexProviderService } from '../../src/mms/providers/codex/CodexProviderService'
import { usageWindows } from '../../src/mms/providers/codex/rateLimits'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { usageText } from '../../src/mms/providers/usageText'
import { CODEX_CAPABILITIES } from '../../src/mms/run/adapters/codex/CodexAdapter'
import type { ProviderAdapter } from '../../src/mms/run/adapters/ProviderAdapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { CHATGPT_USAGE_URL, type ProviderUsage } from '../../src/shared/providerAuth'
import { instanceEnv } from '../../src/mms/harness/env'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import type { DriverContext } from '../../src/mms/harness/driver'

/**
 * The usage reader (PR 3 §5): the user's own Codex reports its plan limits (`account/rateLimits/read`)
 * and the usage page shows them; a managed ChatGPT subscription has no meter, only a link. Usage
 * is read per profile, for the profile's own enabled and signed-in agents.
 */

const device = { kind: 'device' } as const
const window = (usedPercent: number, windowDurationMins: number | null, resetsAt: number | null) => ({ usedPercent, windowDurationMins, resetsAt })

describe('usageWindows', () => {
  it('names the 5-hour and weekly windows and reports what is left', () => {
    expect(usageWindows({ primary: window(30, 300, 1_900_000_000), secondary: window(12.5, 10_080, 1_900_100_000) })).toEqual([
      { id: 'five_hour', label: '5-hour limit', remainingPercent: 70, resetsAt: new Date(1_900_000_000_000).toISOString() },
      { id: 'seven_day', label: 'Weekly limit', remainingPercent: 87.5, resetsAt: new Date(1_900_100_000_000).toISOString() }
    ])
  })

  it('names other lengths by their duration, and keeps a window with no reset', () => {
    expect(usageWindows({ primary: window(0, 60, null), secondary: window(100, 2_880, 1_900_000_000) })).toEqual([
      { id: 'primary', label: '1-hour limit', remainingPercent: 100 },
      { id: 'secondary', label: '2-day limit', remainingPercent: 0, resetsAt: new Date(1_900_000_000_000).toISOString() }
    ])
    expect(usageWindows({ primary: window(5, null, null), secondary: null })).toEqual([{ id: 'primary', label: 'Usage limit', remainingPercent: 95 }])
  })

  it('clamps out-of-range numbers and skips windows that are missing or not numbers', () => {
    expect(usageWindows({ primary: window(140, 300, null), secondary: window(-5, 10_080, null) }).map((entry) => entry.remainingPercent)).toEqual([0, 100])
    expect(usageWindows({ primary: null, secondary: null })).toEqual([])
    expect(usageWindows(undefined)).toEqual([])
    expect(usageWindows({ primary: window(Number.NaN, 300, null), secondary: null })).toEqual([])
  })
})

describe("the user's own Codex reports its plan limits", () => {
  /** A Codex driver whose service answers `rateLimits` as scripted. */
  function runtime(read: CodexProviderService['rateLimits']) {
    const service = { rateLimits: read, configured: () => true } as unknown as CodexProviderService
    const driver = codexDriver({ builtIn: () => service })
    const home = mkdtempSync(join(tmpdir(), 'mousse-codex-usage-'))
    homes.push(home)
    const context: DriverContext = {
      instanceId: 'codex', builtIn: true, config: { home: 'default' },
      env: instanceEnv({ instanceId: 'codex', driver: 'codex', configRevision: 0, home: undefined, searchPath: [], base: {} }),
      profileHome: home, installationHome: home, stateDir: join(home, 'harness', 'codex'), questions: new UserQuestionService(), findBinary: () => undefined, changed: () => {}
    }
    return driver.create(context)
  }
  const homes: string[] = []
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })
  const signal = new AbortController().signal

  it('shows the windows Codex read now', async () => {
    const usage = await runtime(async () => ({ snapshot: { primary: window(20, 300, 1_900_000_000), secondary: null }, at: 1, live: true })).usage!(signal)
    expect(usage).toEqual({ status: 'available', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 80, resetsAt: new Date(1_900_000_000_000).toISOString() }] })
  })

  it('says so when the numbers are the last Codex reported, not read now', async () => {
    const usage = await runtime(async () => ({ snapshot: { primary: window(20, 300, null), secondary: null }, at: Date.UTC(2026, 9, 27), live: false })).usage!(signal)
    expect(usage).toMatchObject({ status: 'available', message: expect.stringContaining('last reported (2026-10-27T00:00:00.000Z)') })
  })

  it('a plan with no limits is unavailable, not an empty meter', async () => {
    expect(await runtime(async () => ({ snapshot: { primary: null, secondary: null }, at: 1, live: true })).usage!(signal)).toEqual({
      status: 'unavailable', windows: [], message: 'Codex reported no usage limits for this plan.'
    })
  })

  it('a read that fails is thrown for the gateway to report', async () => {
    await expect(runtime(async () => { throw new Error('Codex did not answer') }).usage!(signal)).rejects.toThrow('Codex did not answer')
  })
})

describe('the usage page of the gateway', () => {
  const adapter = (driver: ProviderAdapter['driver']): ProviderAdapter =>
    ({ driver, capabilities: CODEX_CAPABILITIES, startTurn: async () => { throw new Error('unused') }, interrupt: async () => 'not_active' }) as unknown as ProviderAdapter
  const available: ProviderUsage = { id: '', label: '', status: 'available', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 64 }] }
  const harnesses: Harness[] = []
  afterEach(() => {
    vi.useRealTimers()
    for (const harness of harnesses.splice(0)) harness.stop()
  })

  function profile(options: { codex?: () => Promise<Omit<ProviderUsage, 'id' | 'label'>>; configured?: boolean; entries?: Record<string, unknown> } = {}) {
    const stored: Record<string, unknown> = options.entries ?? { codex: { driver: 'codex', enabled: true }, claude: { driver: 'claude', enabled: true }, 'pi:openai': { driver: 'pi', enabled: true } }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: () => {} } })
    const harness = testHarness({
      instances,
      drivers: [
        adapterDriver(adapter('codex'), { runtime: { configured: () => options.configured ?? true, usage: options.codex ?? (async () => ({ status: 'available', windows: available.windows })) } }),
        adapterDriver(adapter('claude'), { runtime: { configured: () => true, usage: async () => { throw new Error('The usage endpoint answered 500') } } }),
        adapterDriver(adapter('pi'), { runtime: { configured: () => true } })
      ]
    })
    harnesses.push(harness)
    return harness
  }

  it("lists each enabled, signed-in agent's usage by instance, and reports one that fails without failing the rest", async () => {
    const usage = await profile().instances.usage(device)
    expect(usage).toEqual([
      { id: 'codex', label: 'Test codex', status: 'available', windows: available.windows },
      { id: 'claude', label: 'Test claude', status: 'error', windows: [], message: 'The usage endpoint answered 500' }
    ])
  })

  it('leaves out an agent that is not signed in, one that is turned off, and one a project turns off', async () => {
    expect(await profile({ configured: false }).instances.usage(device)).toEqual([expect.objectContaining({ id: 'claude' })])
    expect((await profile({ entries: { codex: { driver: 'codex', enabled: false }, claude: { driver: 'claude', enabled: true } } }).instances.usage(device)).map((entry) => entry.id)).toEqual(['claude'])
    const harness = profile()
    await harness.instances.setEnabled('codex', { kind: 'project', projectId: 'p1' }, false)
    expect((await harness.instances.usage({ kind: 'project', projectId: 'p1' })).map((entry) => entry.id)).toEqual(['claude'])
    expect((await harness.instances.usage(device)).map((entry) => entry.id)).toEqual(['codex', 'claude'])
  })

  it('shows a ChatGPT subscription as unavailable with its link, and the text form says the same', async () => {
    const usage = await profile({ codex: async () => ({ status: 'unavailable', windows: [], message: "ChatGPT shows this plan's usage on its own page.", manageUrl: CHATGPT_USAGE_URL }) }).instances.usage(device)
    expect(usage[0]).toMatchObject({ id: 'codex', status: 'unavailable', windows: [], manageUrl: CHATGPT_USAGE_URL })
    expect(usageText('ChatGPT subscription', usage[0]!)).toBe("ChatGPT shows this plan's usage on its own page.")
    expect(usageText('Codex', { status: 'available', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 64 }] })).toBe('Codex usage:\n- 5-hour limit: 36% used')
  })

  it('gives up on a read that never answers, and says so for that instance only', async () => {
    vi.useFakeTimers()
    const reading = profile({ codex: () => new Promise(() => {}) }).instances.usage(device)
    await vi.advanceTimersByTimeAsync(USAGE_READ_MS + 1)
    expect(await reading).toEqual([
      { id: 'codex', label: 'Test codex', status: 'error', windows: [], message: 'The usage did not arrive in time.' },
      expect.objectContaining({ id: 'claude', status: 'error' })
    ])
  })
})
