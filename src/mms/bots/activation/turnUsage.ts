import type { BotActivationRow, BotStore, BotTurnUsageRow } from '../store/BotStore'
import type { ProviderMetrics } from '../../harness/adapter'
import type { BotContextSummary, BotTurnUsageSummary } from '../../../shared/bots/personal/chat'

/**
 * What each main turn of a bot cost and carried (docs/plans/bot-context.md, phase 0). A measurement: a failure here is
 * logged and never touches the turn.
 */

/** What started a turn: the chat's start key (`chat`, `answer`, `botmsg`, `create`, ...), or a run's trigger kind. */
export function turnStartedBy(row: Pick<BotActivationRow, 'lane' | 'idempotencyKey' | 'trigger'>): string {
  if (row.lane === 'run') return row.trigger.kind
  const colon = row.idempotencyKey.indexOf(':')
  return colon > 0 ? row.idempotencyKey.slice(0, colon) : 'chat'
}

export interface TurnMeterInput {
  row: Pick<BotActivationRow, 'id' | 'botId' | 'lane' | 'idempotencyKey' | 'trigger' | 'selection'>
  n: number
  /** The turn began from a cleared (or new) context. */
  fresh: boolean
  /** The runtime context the turn runs in. */
  contextGen: string
  instructions?: string
  preamble?: string
  prompt: string
}

/** One usage report of a runtime, as its turn sink hands it on (`PreparedBotTurn.usage`). */
export interface ReportedUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUsd?: number
  requests?: number
}

/** What of a runtime's usage the activation's counts and spend take (`recordObservedUsage`): what it records none of. */
export interface UsageMirror {
  /** The runtime counted no model request itself (only Pi's budget does). */
  requests: boolean
  /** The runtime settled no reservation for its tokens and cost (only Pi, under a spend limit, does). */
  tokens: boolean
}

/**
 * Adds one usage report to the activation's counts and spend, as far as `mirror` says the runtime records none of it
 * itself. A report covers the requests it names (`requests`); one that names none (ACP's sum of a prompt) counts as
 * one, the least it covers.
 */
export function mirrorUsage(store: Pick<BotStore, 'recordObservedUsage'>, activationId: string, usage: ReportedUsage, mirror: UsageMirror): void {
  if (!mirror.requests && !mirror.tokens) return
  const { costUsd, requests } = usage
  store.recordObservedUsage(activationId, {
    requests: mirror.requests ? (requests !== undefined && Number.isFinite(requests) ? Math.max(0, Math.round(requests)) : 1) : 0,
    input: mirror.tokens ? usage.input + usage.cacheRead + usage.cacheWrite : 0,
    output: mirror.tokens ? usage.output : 0,
    ...(mirror.tokens && costUsd !== undefined && Number.isFinite(costUsd) && costUsd > 0 ? { usdMicros: Math.max(0, Math.round(costUsd * 1_000_000)) } : {})
  })
}

export interface TurnMeter {
  usage(usage: ReportedUsage): void
  metrics(metrics: ProviderMetrics): void
  compacted(): void
}

/**
 * Starts a turn's row and returns what the runtime's reports feed. `tools` measures the Mousse tools the turn's runtime
 * is offered; it is asked once, at the first report, when the turn is registered and its tools are known. `mirror`,
 * asked at each usage report, says what of it the activation's counters and spend take too (`mirrorUsage`).
 */
export function startTurnMeter(input: TurnMeterInput, deps: {
  store: BotStore
  now: () => number
  tools?: () => { count: number; chars: number } | undefined
  mirror?: () => UsageMirror
  warn?: (message: string, error: unknown) => void
}): TurnMeter {
  const { row, n } = input
  const warn = (message: string, error: unknown): void => {
    ;(deps.warn ?? ((text: string, cause: unknown) => console.warn(text, { activationId: row.id, error: cause instanceof Error ? cause.message : String(cause) })))(message, error)
  }
  const safely = (message: string, run: () => void): void => {
    try { run() } catch (error) { warn(message, error) }
  }
  safely('a bot turn\'s usage row could not be started', () => {
    const startedAt = deps.now()
    const last = deps.store.lastTurnUsage(row.botId, row.lane, { activationId: row.id, n })
    deps.store.startTurnUsage({
      activationId: row.id,
      dispatchN: n,
      botId: row.botId,
      lane: row.lane,
      startedBy: turnStartedBy(row),
      ...(row.selection?.instanceId ? { instanceId: row.selection.instanceId } : {}),
      ...(row.selection?.model ? { model: row.selection.model } : {}),
      contextGen: input.contextGen,
      freshContext: input.fresh,
      startedAt,
      ...(last?.lastRequestAt ? { gapMs: Math.max(0, startedAt - last.lastRequestAt) } : {}),
      systemChars: input.instructions?.length ?? 0,
      preambleChars: input.preamble?.length ?? 0,
      promptChars: input.prompt.length
    })
  })
  let toolsAsked = false
  const askTools = (): void => {
    if (toolsAsked || !deps.tools) return
    toolsAsked = true
    safely('a bot turn\'s tool list could not be measured', () => {
      const tools = deps.tools!()
      if (tools) deps.store.turnTools(row.id, n, tools.count, tools.chars)
    })
  }
  return {
    usage: (usage) => {
      askTools()
      const { input, output, cacheRead, cacheWrite } = usage
      safely('a bot turn\'s usage could not be recorded', () => deps.store.addTurnUsage(row.id, n, { input, output, cacheRead, cacheWrite, at: deps.now() }))
      if (deps.mirror) safely('a bot turn\'s usage could not be counted', () => mirrorUsage(deps.store, row.id, usage, deps.mirror!()))
    },
    metrics: (metrics) => {
      askTools()
      const context = metrics.context
      safely('a bot turn\'s context could not be recorded', () => deps.store.turnContext(row.id, n, {
        ...(context ? { lastPrompt: context.input + context.cacheRead + context.cacheWrite } : {}),
        ...(context?.contextWindow ? { contextWindow: context.contextWindow } : {}),
        ...(metrics.promptCache?.ttlMs ? { cacheTtlMs: metrics.promptCache.ttlMs } : {}),
        ...(metrics.promptCache?.at ? { at: metrics.promptCache.at } : {}),
        ...(metrics.realModelName ? { model: metrics.realModelName } : {}),
        ...(metrics.quota?.length ? { quota: metrics.quota } : {})
      }))
    },
    compacted: () => safely('a bot turn\'s compaction could not be recorded', () => deps.store.turnCompacted(row.id, n))
  }
}

/** How far back About's usage line looks. */
export const BOT_USAGE_WINDOW_MS = 7 * 24 * 60 * 60_000

/**
 * About's usage line: the bot's chat turns of the last week, how many input tokens a turn sent (fresh input, cache
 * reads and cache writes together) and what share of that was read from the cache. Undefined before any turn reported.
 */
export function turnUsageSummary(rows: readonly BotTurnUsageRow[]): BotTurnUsageSummary | undefined {
  if (!rows.length) return undefined
  let input = 0
  let cacheRead = 0
  let output = 0
  for (const row of rows) {
    input += row.input + row.cacheRead + row.cacheWrite
    cacheRead += row.cacheRead
    output += row.output
  }
  return {
    turns: rows.length,
    inputPerTurn: Math.round(input / rows.length),
    outputPerTurn: Math.round(output / rows.length),
    cachedShare: input > 0 ? cacheRead / input : 0
  }
}

/**
 * About's context and cache: what the bot's latest chat turn that reached its model measured. Undefined before one
 * did. The token count and window are the last request's; the split is the whole turn's input.
 */
export function botContextSummary(row: BotTurnUsageRow | undefined): BotContextSummary | undefined {
  if (!row?.lastRequestAt) return undefined
  return {
    ...(row.lastPrompt ? { used: row.lastPrompt } : {}),
    ...(row.contextWindow ? { window: row.contextWindow } : {}),
    ...(row.model ? { model: row.model } : {}),
    turn: { cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, fresh: row.input },
    lastRequestAt: row.lastRequestAt,
    ...(row.cacheTtlMs ? { cacheTtlMs: row.cacheTtlMs } : {})
  }
}
