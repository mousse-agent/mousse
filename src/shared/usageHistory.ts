/**
 * Usage history: tokens and cost over time, per coding agent, read on this computer from each agent
 * CLI's own local session logs (so it includes sessions that never ran through Mousse).
 */

export type UsageHistoryRange = '24h' | '7d' | '30d' | '90d'

export const USAGE_HISTORY_RANGES: readonly UsageHistoryRange[] = ['24h', '7d', '30d', '90d']

/** The agents whose local logs are read. */
export type UsageAgentId = 'claude-code' | 'codex' | 'grok' | 'pi' | 'opencode'

export const USAGE_AGENT_LABELS: Record<UsageAgentId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
  pi: 'Pi',
  opencode: 'OpenCode'
}

/** Token counts. The four kinds don't overlap: input is the uncached part. */
export interface UsageTokens {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

export interface UsageHistoryAgent {
  id: UsageAgentId
  label: string
  sessions: number
  tokens: UsageTokens
  costUsd: number
  /** Tokens from models with no known price: their cost is left out, never guessed. */
  unpricedTokens: number
  /** One value per bucket of the response, in tokens and in dollars. */
  series: number[]
  costSeries: number[]
}

export interface UsageHistoryModelRow {
  model: string
  agent: UsageAgentId
  tokens: number
  costUsd: number
  priced: boolean
}

export interface UsageHistoryDayRow {
  /** `YYYY-MM-DD` in the requested time zone. */
  day: string
  tokens: number
  costUsd: number
  sessions: number
}

export interface UsageHistorySource {
  agent: UsageAgentId
  /** Where its logs were looked for. */
  path: string
  status: 'read' | 'missing' | 'partial'
  files: number
  /** Files read this time (the rest came from the cache unchanged). */
  readFiles: number
}

export interface UsageHistoryRequest {
  range: UsageHistoryRange
  /** IANA zone the day buckets follow; the daemon's own zone when absent. */
  timeZone?: string
  /** Only this agent's usage; every agent's when absent. */
  agent?: UsageAgentId
}

export interface UsageHistoryResponse {
  range: UsageHistoryRange
  bucket: 'hour' | 'day'
  /** Bucket starts in ms since the epoch, oldest first. */
  buckets: number[]
  /** Day keys (`YYYY-MM-DD`) for day buckets; empty for hours. */
  dayKeys: string[]
  agents: UsageHistoryAgent[]
  models: UsageHistoryModelRow[]
  days: UsageHistoryDayRow[]
  totals: UsageTokens
  costUsd: number
  /** The cost split by token kind, in dollars, at list prices. */
  costByKind: UsageTokens
  /** Cost an agent reported for a model with no list price, so it can't be split by kind. */
  costUnsplitUsd: number
  /** Every agent with usage in the range, also when the response is for one agent only. */
  agentIds: UsageAgentId[]
  /** What cache reads saved against paying the full input price. */
  cacheSavingsUsd: number
  sessions: number
  sources: UsageHistorySource[]
  readAt: string
  scanMs: number
}
