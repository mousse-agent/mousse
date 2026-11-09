import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeSubscriptionProviderService } from '../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { claudeLimitWindows, parseClaudeSubscriptionUsage } from '../src/mms/harness/vendors/claude/usage'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'

const homes: string[] = []
const services: ClaudeSubscriptionProviderService[] = []
afterEach(() => {
  for (const service of services.splice(0)) service.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  vi.useRealTimers()
})
function fixture(query: (input: { options: Options; prompt: unknown }) => Query, extra: Partial<ConstructorParameters<typeof ClaudeSubscriptionProviderService>[2]> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'claude-usage-'))
  homes.push(home)
  const binary = join(home, 'claude')
  writeFileSync(binary, 'fixture')
  chmodSync(binary, 0o755)
  const directory = join(home, 'providers', 'claude-subscription')
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'settings.json'),
    // Models are already known, so the first sign-in check starts no model discovery.
    JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] })
  )
  const runAuth = async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })
  // No local proxy unless a test sets one: nothing reads the network.
  const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), { query, runAuth, launchConfig: () => ({ binaryPath: binary }), proxyUsage: async () => undefined, ...extra })
  services.push(service)
  return { home, service }
}
const sdkMethod = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'
const quota = {
  rate_limits_available: true,
  rate_limits: { five_hour: { utilization: 23, resets_at: '2026-10-07T20:00:00Z' } }
}
function fakeQuery(read = vi.fn(async () => quota)) {
  return { close: vi.fn(), [sdkMethod]: read } as unknown as Query
}

describe('model and surface weekly windows', () => {
  // The account usage shape (field names as the live endpoint sends them; values made up).
  const usage = (extra: Record<string, unknown> = {}) => ({
    five_hour: { utilization: 42, resets_at: '2026-11-09T10:00:00Z', limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
    seven_day: { utilization: 31, resets_at: '2026-11-12T09:00:00Z' },
    seven_day_oauth_apps: null, seven_day_opus: null, seven_day_sonnet: null, seven_day_cowork: null, seven_day_omelette: null,
    iguana_necktie: null, seven_day_breakdown: null, pace: null, indicator: null,
    extra_usage: { is_enabled: false, utilization: null },
    limits: [
      { kind: 'session', group: 'session', percent: 42, severity: 'normal', resets_at: '2026-11-09T10:00:00Z', scope: null, is_active: true },
      { kind: 'weekly_all', group: 'weekly', percent: 31, severity: 'normal', resets_at: '2026-11-12T09:00:00Z', scope: null, is_active: false }
    ],
    weekly_scoped_shares: [],
    ...extra
  })
  const fable = { kind: 'weekly_scoped', group: 'weekly', percent: 64, severity: 'normal', resets_at: '2026-11-12T09:00:00Z', scope: { model: { id: {}, display_name: 'Fable' }, surface: null }, is_active: false }

  it("shows the Fable weekly from the endpoint's limits list after the overall windows, and nothing for null keys", () => {
    expect(claudeLimitWindows(usage({ limits: [...usage().limits, fable] }))).toEqual([
      { id: 'five_hour', label: '5-hour limit', remainingPercent: 58, resetsAt: '2026-11-09T10:00:00Z' },
      { id: 'seven_day', label: 'Weekly limit', remainingPercent: 69, resetsAt: '2026-11-12T09:00:00Z' },
      { id: 'model_fable', label: 'Weekly · Fable', remainingPercent: 36, resetsAt: '2026-11-12T09:00:00Z' }
    ])
  })

  it('has no Fable row when the account has no Fable limit', () => {
    expect(claudeLimitWindows(usage()).map((window) => window.label)).toEqual(['5-hour limit', 'Weekly limit'])
  })

  it('names any seven_day_<model> key from the key itself, and the same model once', () => {
    const windows = claudeLimitWindows(usage({
      seven_day_opus: { utilization: 10 },
      seven_day_haiku_lite: { utilization: 20 },
      iguana_necktie: { utilization: 30 },
      limits: [fable],
      seven_day_breakdown: { utilization: 50 }
    }))
    expect(windows.map((window) => [window.id, window.label])).toEqual([
      ['five_hour', '5-hour limit'],
      ['seven_day', 'Weekly limit'],
      ['seven_day_opus', 'Weekly · Opus'],
      ['iguana_necktie', 'Weekly · Fable'],
      ['seven_day_haiku_lite', 'Weekly · Haiku Lite']
    ])
    // Fable once, though both the code-named key and the limits list carry it.
    expect(windows.filter((window) => window.label === 'Weekly · Fable')).toHaveLength(1)
  })

  it('the direct account path reads the same scoped windows', () => {
    expect(parseClaudeSubscriptionUsage({ rate_limits_available: true, rate_limits: usage({ seven_day_sonnet: { utilization: 5 } }) }).windows.map((window) => window.label))
      .toEqual(['5-hour limit', 'Weekly limit', 'Weekly · Sonnet'])
  })
})

describe('Claude subscription account quota', () => {
  it('maps official consumed percentages and reset times into remaining windows', () => {
    const parsed = parseClaudeSubscriptionUsage({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 0, resets_at: '2026-10-07T20:00:00Z' },
        seven_day: { utilization: 100 },
        seven_day_oauth_apps: { utilization: 30 },
        seven_day_opus: { utilization: 45 },
        seven_day_sonnet: { utilization: 65 },
        model_scoped: [{ display_name: 'Fable', utilization: 80 }],
        extra_usage: { is_enabled: true, utilization: 10 }
      }
    })
    expect(parsed.status).toBe('available')
    expect(parsed.windows.map((row) => row.remainingPercent)).toEqual([100, 0, 70, 55, 35, 20, 90])
    expect(parsed.windows[0].resetsAt).toBe('2026-10-07T20:00:00Z')
    expect(parsed.windows[5].label).toBe('Weekly · Fable')
  })
  it.each([
    undefined,
    {},
    { rate_limits_available: false, rate_limits: quota.rate_limits },
    { rate_limits_available: true, rate_limits: null }
  ])('keeps unavailable quotas honest: %j', (response) => {
    expect(parseClaudeSubscriptionUsage(response)).toMatchObject({
      status: 'unavailable',
      windows: []
    })
  })
  it('rejects malformed percentages, nullable windows, invalid dates and disabled extra usage', () => {
    const parsed = parseClaudeSubscriptionUsage({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: null },
        seven_day: { utilization: -1 },
        seven_day_opus: { utilization: 101 },
        seven_day_sonnet: { utilization: NaN },
        seven_day_oauth_apps: { utilization: 20, resets_at: 'bad date' },
        extra_usage: { is_enabled: false, utilization: 12 },
        model_scoped: [{ display_name: 'x', utilization: '25' }]
      }
    })
    expect(parsed.windows).toEqual([
      { id: 'seven_day_oauth_apps', label: 'Weekly · OAuth apps', remainingPercent: 80 }
    ])
  })
  it('bounds additional model windows', () => {
    const parsed = parseClaudeSubscriptionUsage({
      rate_limits_available: true,
      rate_limits: {
        model_scoped: Array.from({ length: 100 }, (_, i) => ({
          display_name: `Model ${i}`,
          utilization: 10
        }))
      }
    })
    expect(parsed.windows).toHaveLength(16)
  })
  it('uses an empty input stream with denied tools and skips transcript scanning', async () => {
    const read = vi.fn(async () => quota)
    const query = fakeQuery(read)
    let yielded = false
    let consumed: Promise<void> | undefined
    const { service, home } = fixture(({ prompt, options }) => {
      expect(options.tools).toEqual([])
      expect(options.mcpServers).toEqual({})
      expect(options.canUseTool).toBeTypeOf('function')
      consumed = (async () => {
        for await (const _ of prompt as AsyncIterable<unknown>) yielded = true
      })()
      return query
    })
    expect(await service.getUsage(home)).toMatchObject({ status: 'available' })
    await consumed
    expect(yielded).toBe(false)
    expect(read).toHaveBeenCalledWith({ skipBehaviors: true })
    expect(query.close).toHaveBeenCalledOnce()
    expect(service.configuredProvider()?.id).toBe('claude-subscription')
  })
  it('when Claude Code has no limits, those of the local proxy its base URL points at stand in, labelled', async () => {
    const query = { close: vi.fn() } as unknown as Query
    const proxyUsage = vi.fn(async () => ({ status: 'available' as const, windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 63 }], source: 'via local proxy' }))
    const { service, home } = fixture(() => query, {
      proxyUsage,
      // Claude's own settings folder is the fixture's: the user's real settings are not read.
      baseEnv: () => ({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317', CLIPROXY_MANAGEMENT_KEY: 'mgmt', CLAUDE_CONFIG_DIR: join(tmpdir(), 'no-claude-settings') })
    })
    expect(await service.getUsage(home)).toEqual({
      id: 'claude-subscription', label: 'Claude subscription', status: 'available', source: 'via local proxy',
      windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 63 }]
    })
    expect(proxyUsage).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'http://127.0.0.1:8317', managementKey: 'mgmt' }))
  })
  it('asks no proxy when Claude Code reports its own limits, or when no base URL is set', async () => {
    const proxyUsage = vi.fn(async () => undefined)
    const { service, home } = fixture(() => fakeQuery(), { proxyUsage, baseEnv: () => ({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317' }) })
    expect(await service.getUsage(home)).toMatchObject({ status: 'available' })
    const older = fixture(() => ({ close: vi.fn() }) as unknown as Query, { proxyUsage, baseEnv: () => ({ CLAUDE_CONFIG_DIR: join(tmpdir(), 'no-claude-settings') }) })
    expect(await older.service.getUsage(older.home)).toMatchObject({ status: 'unavailable', message: 'Claude account usage limits are unavailable.' })
    expect(proxyUsage).not.toHaveBeenCalled()
  })
  it('supports older SDKs without the experimental method', async () => {
    const query = { close: vi.fn() } as unknown as Query
    const { service, home } = fixture(() => query)
    expect(await service.getUsage(home)).toMatchObject({ status: 'unavailable', windows: [] })
    expect(query.close).toHaveBeenCalledOnce()
  })
  it('settles a stalled control request that ignores abort', async () => {
    vi.useFakeTimers()
    const query = fakeQuery(vi.fn(() => new Promise<never>(() => {})))
    const { service, home } = fixture(() => query)
    const result = service.getUsage(home)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await result).toMatchObject({
      status: 'error',
      message: expect.stringContaining('timed out')
    })
    expect(query.close).toHaveBeenCalledOnce()
  })
  it('settles stalled initialization and closes a late query', async () => {
    vi.useFakeTimers()
    let resolveQuery!: (query: Query) => void
    const { service, home } = fixture(
      () =>
        new Promise<Query>((resolve) => {
          resolveQuery = resolve
        }) as unknown as Query
    )
    const result = service.getUsage(home)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await result).toMatchObject({ status: 'error' })
    const query = fakeQuery()
    resolveQuery(query)
    await vi.advanceTimersByTimeAsync(0)
    expect(query.close).toHaveBeenCalledOnce()
  })
  it('cancels pending usage on service stop without waiting for SDK completion', async () => {
    const read = vi.fn(() => new Promise<never>(() => {}))
    const query = fakeQuery(read)
    const { service, home } = fixture(() => query)
    const result = service.getUsage(home)
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    service.stop()
    expect(await result).toMatchObject({
      status: 'error',
      message: expect.stringContaining('canceled')
    })
    expect(query.close).toHaveBeenCalledOnce()
  })
  it('does not launch a query for an already aborted request', async () => {
    const create = vi.fn(() => fakeQuery())
    const { service, home } = fixture(create)
    const controller = new AbortController()
    controller.abort()
    expect(await service.getUsage(home, controller.signal)).toMatchObject({ status: 'error' })
    expect(create).not.toHaveBeenCalled()
  })
  it('does not expose raw SDK error details', async () => {
    const query = fakeQuery(
      vi.fn(async () => {
        throw new Error('https://secret.example/?token=private')
      })
    )
    const { service, home } = fixture(() => query)
    expect(await service.getUsage(home)).toMatchObject({
      status: 'error',
      message: 'Unable to retrieve Claude account usage limits. Try refreshing.'
    })
  })
})
