import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { USAGE_READ_MS, type Harness } from '../../src/mms/harness/gateway'
import { codexDriver } from '../../src/mms/harness/drivers/codex'
import type { CodexProviderService } from '../../src/mms/harness/vendors/codex/CodexProviderService'
import { reportedUsageWindows, snapshotPlan, snapshotResets, trimResetCredits, usageWindows } from '../../src/mms/harness/vendors/codex/rateLimits'
import { managedCodexUsage, useUserCodexReset, userCodexLimits } from '../../src/mms/harness/vendors/codex/managedRuntime'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { usageText } from '../../src/mms/providers/usageText'
import { CODEX_CAPABILITIES } from '../../src/mms/harness/drivers/codex/adapter'
import type { ProviderAdapter } from '../../src/mms/harness/adapter'
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

describe('reset credits', () => {
  // `rateLimitResetCredits` as `account/rateLimits/read` sends it (values made up).
  const reply = (availableCount: number) => ({
    availableCount,
    credits: [
      { id: 'rc_1', resetType: 'weekly', status: 'available', grantedAt: 1_900_000_000, expiresAt: 1_900_432_000, title: 'Weekly limit reset', description: 'Resets your weekly limit.' },
      { id: 'rc_2', resetType: 'five_hour', status: 'available', grantedAt: 1_900_000_000, expiresAt: 1_900_086_400, title: '5-hour reset', description: '' }
    ]
  })

  it('keeps the count and, per credit, its id (to use it), type, status, title and expiry: no descriptions', () => {
    expect(trimResetCredits(reply(2))).toEqual({
      availableCount: 2,
      credits: [
        { id: 'rc_1', resetType: 'weekly', status: 'available', title: 'Weekly limit reset', expiresAt: 1_900_432_000 },
        { id: 'rc_2', resetType: 'five_hour', status: 'available', title: '5-hour reset', expiresAt: 1_900_086_400 }
      ]
    })
    expect(trimResetCredits({ availableCount: 0, credits: [] })).toEqual({ availableCount: 0 })
    for (const odd of [null, undefined, {}, { availableCount: -1 }, { availableCount: 1.5 }, { availableCount: '2' }, []]) expect(trimResetCredits(odd)).toBeUndefined()
  })

  it('reads as the page\'s resets, each expiry as a time', () => {
    const snapshot = { primary: null, secondary: null, rateLimitResetCredits: trimResetCredits(reply(2))! }
    expect(snapshotResets(snapshot)).toEqual({
      available: 2,
      credits: [
        { id: 'rc_1', title: 'Weekly limit reset', type: 'weekly', status: 'available', expiresAt: new Date(1_900_432_000_000).toISOString() },
        { id: 'rc_2', title: '5-hour reset', type: 'five_hour', status: 'available', expiresAt: new Date(1_900_086_400_000).toISOString() }
      ]
    })
    expect(snapshotResets({ primary: null, secondary: null })).toBeUndefined()
  })

  it('the ChatGPT card carries them, 0 included (the page hides 0)', () => {
    const snapshot = { primary: window(10, 300, null), secondary: null, rateLimitResetCredits: { availableCount: 0 } }
    expect(managedCodexUsage(true, { snapshot, at: 1 }, 2, { live: true })).toMatchObject({ resets: { available: 0 } })
  })
})

describe('snapshotPlan', () => {
  it('names the plan as ChatGPT does, and nothing for an unknown or odd value', () => {
    expect(['plus', 'pro', 'team', 'edu_plus'].map((planType) => snapshotPlan({ primary: null, secondary: null, planType }))).toEqual(['Plus', 'Pro', 'Team', 'Edu Plus'])
    expect(snapshotPlan({ primary: null, secondary: null, planType: 'unknown' })).toBeUndefined()
    expect(snapshotPlan({ primary: null, secondary: null, planType: '<b>x</b>' })).toBeUndefined()
    expect(snapshotPlan({ primary: null, secondary: null })).toBeUndefined()
  })
})

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

describe('a ChatGPT subscription shows the limits Codex reported on its last turn', () => {
  const now = Date.UTC(2026, 10, 8, 12)
  const seconds = (ms: number) => Math.floor(ms / 1000)
  // The snapshot a turn's `account/rateLimits/updated` carries: a 5-hour and a weekly window.
  const reported = { snapshot: { primary: window(42, 300, seconds(now + 3_600_000)), secondary: window(18, 10_080, seconds(now + 3 * 86_400_000)) }, at: now - 600_000 }

  it("shows both windows with what is left and when they reset, dated, beside ChatGPT's page", () => {
    expect(managedCodexUsage(true, reported, now)).toEqual({
      status: 'available',
      windows: [
        { id: 'five_hour', label: '5-hour limit', remainingPercent: 58, resetsAt: new Date(seconds(now + 3_600_000) * 1000).toISOString() },
        { id: 'seven_day', label: 'Weekly limit', remainingPercent: 82, resetsAt: new Date(seconds(now + 3 * 86_400_000) * 1000).toISOString() }
      ],
      readAt: new Date(now - 600_000).toISOString(),
      manageUrl: CHATGPT_USAGE_URL
    })
  })

  it('a window whose reset has passed since the snapshot reads as started over', () => {
    expect(reportedUsageWindows(reported.snapshot, now + 2 * 3_600_000)[0]).toEqual({ id: 'five_hour', label: '5-hour limit', remainingPercent: 100 })
    expect(reportedUsageWindows(reported.snapshot, now + 2 * 3_600_000)[1]).toMatchObject({ remainingPercent: 82 })
  })

  it('signed out, no turn yet, or a plan with no windows: one short line and the link', () => {
    expect(managedCodexUsage(false, reported, now)).toEqual({ status: 'unavailable', windows: [], message: 'Sign in with ChatGPT to see limits.', manageUrl: CHATGPT_USAGE_URL })
    expect(managedCodexUsage(true, undefined, now)).toEqual({ status: 'unavailable', windows: [], message: 'Limits show after the next turn.', manageUrl: CHATGPT_USAGE_URL })
    expect(managedCodexUsage(true, { snapshot: { primary: null, secondary: null }, at: now }, now)).toMatchObject({ status: 'unavailable', message: 'No limits reported for this plan.' })
  })
})

describe("using a limit reset through the user's own Codex CLI", () => {
  const cli = (subject: string | undefined) => ({
    status: vi.fn(async () => ({}) as never),
    account: () => (subject ? { subject } : undefined),
    rateLimits: vi.fn(),
    consumeResetCredit: vi.fn(async () => ({ outcome: 'reset' as const }))
  })

  it('only for the same ChatGPT account: another account\'s credit is never used', async () => {
    const same = cli('chatgpt:me@example.com')
    expect(await useUserCodexReset(same, 'Me@Example.com', 'rc_1')).toEqual({ outcome: 'reset' })
    // The sign-in is read afresh, not taken from a cached check.
    expect(same.status).toHaveBeenCalledWith({ force: true })
    expect(same.consumeResetCredit).toHaveBeenCalledWith('rc_1', undefined)
    const other = cli('chatgpt:other@example.com')
    await expect(useUserCodexReset(other, 'me@example.com', 'rc_1')).rejects.toThrow('another account')
    expect(other.consumeResetCredit).not.toHaveBeenCalled()
    await expect(useUserCodexReset(undefined, 'me@example.com', undefined)).rejects.toThrow()
    await expect(useUserCodexReset(cli(undefined), null, undefined)).rejects.toThrow()
  })
})

describe("the plan's limits read now through the user's own Codex CLI", () => {
  const snapshot = { primary: window(10, 300, null), secondary: null }
  const cli = (subject: string | undefined, read: () => Promise<{ snapshot: typeof snapshot; at: number; live: boolean }>) =>
    ({ status: async () => ({}) as never, account: () => (subject ? { subject } : undefined), rateLimits: read })

  it('only for the same ChatGPT account, only a live read, and never a failure', async () => {
    expect(await userCodexLimits(cli('chatgpt:me@example.com', async () => ({ snapshot, at: 5, live: true })), ' Me@Example.com ')).toEqual({ snapshot, at: 5 })
    expect(await userCodexLimits(cli('chatgpt:other@example.com', async () => ({ snapshot, at: 5, live: true })), 'me@example.com')).toBeUndefined()
    expect(await userCodexLimits(cli('chatgpt:me@example.com', async () => ({ snapshot, at: 5, live: false })), 'me@example.com')).toBeUndefined()
    expect(await userCodexLimits(cli('chatgpt:me@example.com', async () => { throw new Error('offline') }), 'me@example.com')).toBeUndefined()
    expect(await userCodexLimits(cli(undefined, async () => ({ snapshot, at: 5, live: true })), 'me@example.com')).toBeUndefined()
    expect(await userCodexLimits(cli('chatgpt:me@example.com', async () => ({ snapshot, at: 5, live: true })), null)).toBeUndefined()
    expect(await userCodexLimits(undefined, 'me@example.com')).toBeUndefined()
  })

  it('a reading made now is shown undated', () => {
    expect(managedCodexUsage(true, { snapshot, at: 1 }, 2, { live: true })).toEqual({ status: 'available', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 90 }], manageUrl: CHATGPT_USAGE_URL })
  })
})

describe("the user's own Codex reports its plan limits", () => {
  /** A Codex driver whose service answers `rateLimits` as scripted. */
  function runtime(read: CodexProviderService['rateLimits']) {
    const service = { rateLimits: read, configured: () => true, vendorMirror: () => ({}) } as unknown as CodexProviderService
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
    expect(usage).toMatchObject({ status: 'available', message: "Codex couldn't be reached.", readAt: '2026-10-27T00:00:00.000Z' })
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

  it('the usage page alone also lists a signed-out agent, marked and never asked', async () => {
    const read = vi.fn(async () => ({ status: 'available' as const, windows: available.windows }))
    const harness = profile({ configured: false, codex: read })
    expect((await harness.instances.usage(device)).map((entry) => entry.id)).toEqual(['claude'])
    expect(await harness.instances.usage(device, { includeSignedOut: true })).toEqual([
      { id: 'codex', label: 'Test codex', status: 'unavailable', windows: [], signedOut: true, message: 'Signed out' },
      expect.objectContaining({ id: 'claude' })
    ])
    expect(read).not.toHaveBeenCalled()
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
