import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readUsageLimit } from '../src/mms/orchestrator/providerErrors'
import { observeRateLimit, RejectedWindows, usageLimitFromResult, USAGE_LIMIT_HOLD_MS } from '../src/mms/harness/vendors/claude/usageLimit'

const NOW = Date.parse('2026-10-01T00:00:00Z')
const seconds = (offsetMs: number) => (NOW + offsetMs) / 1000
const HOUR = 3_600_000

const event = (info: Record<string, unknown>) => ({ type: 'rate_limit_event', rate_limit_info: info, uuid: 'u', session_id: 's' }) as unknown as SDKMessage
const rejected = (rateLimitType: string, resetsAt?: number, extra: Record<string, unknown> = {}) => event({ status: 'rejected', rateLimitType, ...(resetsAt === undefined ? {} : { resetsAt }), ...extra })
const errorResult = (extra: Record<string, unknown> = {}) =>
  ({ type: 'result', subtype: 'success', is_error: true, result: 'limit', api_error_status: null, session_id: 's', ...extra }) as unknown as SDKResultMessage
const failedResult = (extra: Record<string, unknown> = {}) =>
  ({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], session_id: 's', ...extra }) as unknown as SDKResultMessage

function seenFrom(...messages: SDKMessage[]): RejectedWindows {
  const seen = new RejectedWindows()
  for (const message of messages) observeRateLimit(message, seen, NOW)
  return seen
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe('Claude usage limit classification', () => {
  it('two rejected windows give the latest reset and its window', () => {
    const seen = seenFrom(rejected('five_hour', seconds(HOUR)), rejected('seven_day', seconds(30 * HOUR)))
    expect(readUsageLimit(usageLimitFromResult(errorResult(), seen, NOW))).toEqual({
      provider: 'claude',
      resetsAt: '2026-10-02T06:00:00.000Z',
      estimated: false,
      limitKind: 'seven_day'
    })
  })

  it('a later record of the same window replaces the earlier one', () => {
    const seen = seenFrom(rejected('five_hour', seconds(HOUR)), rejected('five_hour', seconds(2 * HOUR)))
    expect(readUsageLimit(usageLimitFromResult(errorResult(), seen, NOW))).toMatchObject({ resetsAt: '2026-10-01T02:00:00.000Z', estimated: false })
  })

  it('a window without a reset makes the whole reset an estimate', () => {
    const seen = seenFrom(rejected('five_hour', seconds(HOUR)), rejected('seven_day'))
    expect(readUsageLimit(usageLimitFromResult(errorResult(), seen, NOW))).toMatchObject({ estimated: true, limitKind: 'seven_day', resetsAt: '2026-10-01T05:00:00.000Z' })
  })

  it('a rejected window Claude can cover with extra usage is not a limit', () => {
    for (const covered of [{ overageStatus: 'allowed' }, { overageStatus: 'allowed_warning' }, { isUsingOverage: true }]) {
      const seen = seenFrom(rejected('five_hour', seconds(HOUR), covered))
      expect(seen.recorded).toBe(false)
      expect(usageLimitFromResult(errorResult(), seen, NOW)).toBeUndefined()
    }
    expect(seenFrom(rejected('five_hour', seconds(HOUR), { overageStatus: 'rejected' })).recorded).toBe(true)
  })

  it('an allowed or warning event records nothing', () => {
    expect(seenFrom(event({ status: 'allowed' }), event({ status: 'allowed_warning', rateLimitType: 'five_hour' })).recorded).toBe(false)
  })

  it('an assistant rate_limit error carries its window in api_error_params', () => {
    const assistant = {
      type: 'assistant',
      error: 'rate_limit',
      api_error_params: { rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_sonnet', resetsAt: seconds(5 * HOUR) } },
      message: { content: [] },
      session_id: 's'
    } as unknown as SDKMessage
    expect(readUsageLimit(usageLimitFromResult(errorResult(), seenFrom(assistant), NOW))).toEqual({
      provider: 'claude',
      resetsAt: '2026-10-01T05:00:00.000Z',
      estimated: false,
      limitKind: 'seven_day_sonnet'
    })
  })

  it('an assistant rate_limit error without a window is a limit with an estimated reset', () => {
    const assistant = { type: 'assistant', error: 'rate_limit', message: { content: [] }, session_id: 's' } as unknown as SDKMessage
    expect(readUsageLimit(usageLimitFromResult(errorResult(), seenFrom(assistant), NOW))).toMatchObject({ estimated: true })
  })

  it('an unrelated api error is not a limit even after a rejected window', () => {
    const seen = seenFrom(rejected('five_hour', seconds(HOUR)))
    expect(usageLimitFromResult(errorResult({ api_error_status: 503 }), seen, NOW)).toBeUndefined()
    expect(usageLimitFromResult(failedResult({ terminal_reason: 'prompt_too_long' }), seen, NOW)).toBeUndefined()
    expect(usageLimitFromResult(failedResult({ terminal_reason: 'blocking_limit' }), seen, NOW)).toBeDefined()
    expect(usageLimitFromResult(failedResult({ terminal_reason: 'api_error', api_error_status: 429 }), seen, NOW)).toBeDefined()
  })

  it('a successful result is not a limit even after a rejected window', () => {
    const seen = seenFrom(rejected('five_hour', seconds(HOUR)))
    expect(usageLimitFromResult({ type: 'result', subtype: 'success', is_error: false, result: 'ok' } as unknown as SDKResultMessage, seen, NOW)).toBeUndefined()
  })

  it('a failure with no rejected window is not a limit', () => {
    expect(usageLimitFromResult(errorResult(), new RejectedWindows(), NOW)).toBeUndefined()
  })

  it('reads the reset from a 429 rate_limit_error body', () => {
    const body = 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your limit (reset after 1h 2m 3s)"}}'
    const limit = readUsageLimit(usageLimitFromResult(errorResult({ result: body, api_error_status: 429 }), new RejectedWindows(), NOW))
    expect(limit).toEqual({ provider: 'claude', resetsAt: '2026-10-01T01:02:03.000Z', estimated: false })
    expect(readUsageLimit(usageLimitFromResult(failedResult({ errors: [body] }), new RejectedWindows(), NOW))?.resetsAt).toBe('2026-10-01T01:02:03.000Z')
    expect(usageLimitFromResult(errorResult({ result: 'rate_limit_error: slow down', api_error_status: 429 }), new RejectedWindows(), NOW)).toBeUndefined()
  })

  it('a turn Mousse ended after a hold is a limit whatever the result says', () => {
    const seen = seenFrom(rejected('five_hour', seconds(HOUR)))
    seen.hold = true
    for (const result of [errorResult({ api_error_status: 503 }), failedResult({ terminal_reason: 'aborted_streaming' }), { type: 'result', subtype: 'success', is_error: false, result: '' } as unknown as SDKResultMessage]) {
      expect(readUsageLimit(usageLimitFromResult(result, seen, NOW))).toMatchObject({ resetsAt: '2026-10-01T01:00:00.000Z', estimated: false, limitKind: 'five_hour' })
    }
  })
})

describe('the hold watchdog clock', () => {
  it('a rejection with nothing after it for the hold time is held', () => {
    const seen = new RejectedWindows()
    expect(seen.held(NOW + USAGE_LIMIT_HOLD_MS)).toBe(false)
    observeRateLimit(rejected('five_hour', seconds(HOUR)), seen, NOW)
    expect(seen.held(NOW + USAGE_LIMIT_HOLD_MS - 1)).toBe(false)
    expect(seen.held(NOW + USAGE_LIMIT_HOLD_MS)).toBe(true)
  })

  it.each([
    ['a stream frame', { type: 'stream_event', session_id: 's', event: {} }],
    ['an assistant message', { type: 'assistant', session_id: 's', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }],
    ['a tool result', { type: 'user', session_id: 's', message: { role: 'user', content: [] } }],
    ['tool progress', { type: 'tool_progress', session_id: 's', tool_use_id: 't', tool_name: 'Bash', elapsed_time_seconds: 3 }]
  ])('%s after the rejection means the turn went on: the wait stops and the windows are forgotten', (_name, frame) => {
    const seen = seenFrom(rejected('five_hour', seconds(HOUR)))
    observeRateLimit(frame as unknown as SDKMessage, seen, NOW + 20_000)
    expect(seen.recorded).toBe(false)
    expect(seen.held(NOW + 20_000 + 10 * USAGE_LIMIT_HOLD_MS)).toBe(false)
    // A failure that follows is not read as the limit.
    expect(usageLimitFromResult(errorResult(), seen, NOW + 21_000)).toBeUndefined()
  })

  it('a system frame or the result itself does not stop the wait', () => {
    const seen = seenFrom(rejected('five_hour', seconds(HOUR)))
    observeRateLimit({ type: 'system', subtype: 'status', session_id: 's' } as unknown as SDKMessage, seen, NOW + 20_000)
    observeRateLimit(errorResult(), seen, NOW + 21_000)
    expect(seen.held(NOW + USAGE_LIMIT_HOLD_MS)).toBe(true)
    expect(readUsageLimit(usageLimitFromResult(errorResult(), seen, NOW + 21_000))).toMatchObject({ limitKind: 'five_hour' })
  })

  it('a rejection that comes after progress starts the wait again', () => {
    const seen = seenFrom(rejected('five_hour', seconds(HOUR)))
    observeRateLimit({ type: 'stream_event', session_id: 's', event: {} } as unknown as SDKMessage, seen, NOW + 20_000)
    observeRateLimit(rejected('seven_day', seconds(2 * HOUR)), seen, NOW + 25_000)
    expect(seen.held(NOW + 25_000 + USAGE_LIMIT_HOLD_MS)).toBe(true)
    expect(readUsageLimit(usageLimitFromResult(errorResult(), seen, NOW + 26_000))).toMatchObject({ limitKind: 'seven_day' })
  })

  it('progress after Mousse ended the turn itself does not forget the limit', () => {
    const seen = seenFrom(rejected('five_hour', seconds(HOUR)))
    seen.hold = true
    observeRateLimit({ type: 'stream_event', session_id: 's', event: {} } as unknown as SDKMessage, seen, NOW + 40_000)
    expect(readUsageLimit(usageLimitFromResult(errorResult(), seen, NOW + 41_000))).toMatchObject({ limitKind: 'five_hour', estimated: false })
  })

  it('frames before any rejection never start it', () => {
    const seen = new RejectedWindows()
    observeRateLimit({ type: 'stream_event', session_id: 's', event: {} } as unknown as SDKMessage, seen, NOW)
    expect(seen.held(NOW + 10 * USAGE_LIMIT_HOLD_MS)).toBe(false)
  })
})
