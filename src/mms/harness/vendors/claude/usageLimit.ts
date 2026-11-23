import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { boundedResetIso, usageLimitError } from '../../../orchestrator/providerErrors'
import type { AppError } from '../../../../shared/errors'
import type { PlanWindowUse } from '../../adapter'

/** How long a turn may sit after a rejected window with no frame and no result before Mousse ends it. */
export const USAGE_LIMIT_HOLD_MS = 30_000

interface RejectedWindow {
  limitKind?: string
  /** Epoch seconds, as Claude Code reports it. */
  resetsAt?: number
}

/**
 * The rejected plan windows one turn has seen. Claude Code reports a window as a `rate_limit_event`
 * (and on the assistant message that carries the failure) before the turn's result arrives, and may
 * repeat nothing afterwards, so the turn keeps what it saw.
 */
export class RejectedWindows {
  private readonly windows = new Map<string, RejectedWindow>()
  /** Every plan window a rate-limit event reported how much of it is used, the latest per window; never cleared. */
  private readonly used = new Map<string, PlanWindowUse>()
  /** An assistant message reported `rate_limit`, with or without a window. */
  private assistantError = false
  /** When the last frame arrived after a rejection; the hold watchdog measures from here. */
  private quietSince: number | undefined
  /** Mousse interrupted the turn itself because Claude Code held it after a rejection. */
  hold = false

  get recorded(): boolean {
    return this.windows.size > 0 || this.assistantError
  }

  /** A rate-limit event's report of how much of its window is used (`utilization`), whatever its status. */
  noteUse(info: unknown): void {
    const use = planWindowUse(info)
    if (use) this.used.set(use.kind, use)
  }

  /** The plan windows' use the frames reported (`ProviderMetrics.quota`). */
  planUse(): PlanWindowUse[] {
    return [...this.used.values()]
  }

  record(window: RejectedWindow, nowMs: number): void {
    this.windows.set(window.limitKind ?? 'unknown', window)
    this.quietSince = nowMs
  }

  recordAssistantError(nowMs: number): void {
    this.assistantError = true
    this.quietSince = nowMs
  }

  /**
   * The turn went on after a rejection (a model or tool frame): the rejection did not end it, so it
   * is forgotten. The hold clock stops, and a later, unrelated failure is not read as a limit. Once
   * Mousse has ended the turn itself the record stays, because the limit is why it ended.
   */
  progressed(): void {
    if (this.hold) return
    this.windows.clear()
    this.assistantError = false
    this.quietSince = undefined
  }

  /** A rejected window was seen and nothing has arrived since for `holdMs`. */
  held(nowMs: number, holdMs = USAGE_LIMIT_HOLD_MS): boolean {
    return this.recorded && this.quietSince !== undefined && nowMs - this.quietSince >= holdMs
  }

  /** The reset of the limit the windows stand for: the latest reported one; a window without one leaves it unknown (an estimate). */
  limit(): RejectedWindow {
    const windows = [...this.windows.values()]
    const unreported = windows.find((window) => window.resetsAt === undefined)
    if (unreported) return { limitKind: unreported.limitKind }
    return windows.reduce<RejectedWindow>((best, window) => (best.resetsAt === undefined || window.resetsAt! > best.resetsAt ? window : best), {})
  }
}

interface RateLimitInfo {
  status?: unknown
  resetsAt?: unknown
  rateLimitType?: unknown
  utilization?: unknown
  overageStatus?: unknown
  isUsingOverage?: unknown
  overageInUse?: unknown
}

/** How much of a window an event says is used: `utilization` is a fraction (0-1), or a percentage above 1. */
function planWindowUse(info: unknown): PlanWindowUse | undefined {
  if (!info || typeof info !== 'object') return undefined
  const { utilization, rateLimitType, resetsAt } = info as RateLimitInfo
  if (typeof utilization !== 'number' || !Number.isFinite(utilization) || utilization < 0) return undefined
  return {
    kind: typeof rateLimitType === 'string' ? rateLimitType : 'unknown',
    usedPercent: Math.min(100, Math.round((utilization <= 1 ? utilization * 100 : utilization) * 10) / 10),
    ...(typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? { resetsAt } : {})
  }
}

/** A rejected window that no overage can cover. */
function rejectedWindow(info: unknown): RejectedWindow | undefined {
  if (!info || typeof info !== 'object') return undefined
  const { status, resetsAt, rateLimitType, overageStatus, isUsingOverage, overageInUse } = info as RateLimitInfo
  if (status !== 'rejected') return undefined
  if (overageStatus === 'allowed' || overageStatus === 'allowed_warning' || isUsingOverage === true || overageInUse === true) return undefined
  return {
    ...(typeof rateLimitType === 'string' ? { limitKind: rateLimitType } : {}),
    ...(typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? { resetsAt } : {})
  }
}

/**
 * Feeds one frame of a turn to its record of rejected windows. A frame that shows the turn going on
 * after a rejection (text, a tool call or its progress) clears the record.
 */
export function observeRateLimit(message: SDKMessage, seen: RejectedWindows, nowMs = Date.now()): void {
  if (message.type === 'rate_limit_event') {
    seen.noteUse(message.rate_limit_info)
    const window = rejectedWindow(message.rate_limit_info)
    if (window) seen.record(window, nowMs)
    return
  }
  if (message.type === 'assistant' && message.error === 'rate_limit') {
    // The CLI suppresses repeated events, so the failure's own message names the window too.
    const params = (message as { api_error_params?: { rate_limit_info?: unknown } }).api_error_params
    const window = rejectedWindow(params?.rate_limit_info)
    if (window) seen.record(window, nowMs)
    else seen.recordAssistantError(nowMs)
    return
  }
  // A result is the end of the turn, not progress; every other frame of the model or its tools is.
  if (message.type === 'stream_event' || message.type === 'assistant' || message.type === 'user' || message.type === 'tool_progress') seen.progressed()
}

function limitError(resetsAt: string | undefined, limitKind: string | undefined): AppError {
  return usageLimitError({ provider: 'claude', ...(resetsAt ? { resetsAt } : {}), estimated: resetsAt === undefined, ...(limitKind ? { limitKind } : {}) })
}

/** The usage limit the windows a turn recorded stand for. */
export function usageLimitFromWindows(seen: RejectedWindows, nowMs = Date.now()): AppError {
  const { resetsAt, limitKind } = seen.limit()
  return limitError(boundedResetIso(resetsAt, nowMs), limitKind)
}

const RESET_AFTER = /\(reset after\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?\s*\)/i

/** The usage limit a result stands for, or undefined when the result is anything else. */
export function usageLimitFromResult(result: SDKResultMessage, seen: RejectedWindows, nowMs = Date.now()): AppError | undefined {
  // Mousse ended the turn itself; whatever the result says, the limit is why.
  if (seen.hold) return usageLimitFromWindows(seen, nowMs)
  if (result.subtype === 'success' && !result.is_error) return undefined
  const status = (result as { api_error_status?: number | null }).api_error_status
  const apiStatusOk = status === null || status === undefined || status === 429
  const terminal = result.terminal_reason
  if (seen.recorded && apiStatusOk && (terminal === undefined || terminal === 'api_error' || terminal === 'blocking_limit')) return usageLimitFromWindows(seen, nowMs)
  // A 429 whose body says when the limit resets, from a Claude Code that reported no window.
  const text = 'errors' in result ? result.errors.join('\n') : result.result
  const after = RESET_AFTER.exec(text)
  if (apiStatusOk && /rate_limit_error/.test(text) && after && (after[1] || after[2] || after[3])) {
    const seconds = Number(after[1] ?? 0) * 3600 + Number(after[2] ?? 0) * 60 + Number(after[3] ?? 0)
    return limitError(boundedResetIso(new Date(nowMs + seconds * 1000).toISOString(), nowMs), undefined)
  }
  return undefined
}
