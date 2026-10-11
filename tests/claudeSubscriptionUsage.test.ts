import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeSubscriptionProviderService } from '../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import { parseClaudeSubscriptionUsage } from '../src/mms/providers/claudeSubscription/usage'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'

const homes: string[] = []
const services: ClaudeSubscriptionProviderService[] = []
afterEach(() => {
  for (const service of services.splice(0)) service.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  vi.useRealTimers()
})
function fixture(query: (input: { options: Options; prompt: unknown }) => Query) {
  const home = mkdtempSync(join(tmpdir(), 'claude-usage-'))
  homes.push(home)
  const binary = join(home, 'claude')
  writeFileSync(binary, 'fixture')
  chmodSync(binary, 0o755)
  const directory = join(home, 'providers', 'claude-subscription')
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'settings.json'),
    JSON.stringify({ signedIn: true, binaryPath: binary })
  )
  const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), { query })
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
    expect(parsed.windows[5].label).toBe('Weekly Fable limit')
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
      { id: 'seven_day_oauth_apps', label: 'Weekly OAuth apps limit', remainingPercent: 80 }
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
    const query = fakeQuery(vi.fn(() => new Promise<never>(() => {})))
    const { service, home } = fixture(() => query)
    const result = service.getUsage(home)
    await Promise.resolve()
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
