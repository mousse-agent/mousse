import {
  USAGE_AGENT_LABELS, USAGE_HISTORY_RANGES,
  type UsageAgentId, type UsageCostBySpeed, type UsageHistoryAgent, type UsageProjectRow, type UsageSessionRow, type UsageHistoryModelRow, type UsageHistoryResponse, type UsageTokens
} from '../../shared/usageHistory'

/** A reply from another computer that is not a usage history: it is shown as unavailable, never drawn. */
export class UsageHistoryReplyError extends Error {
  override name = 'UsageHistoryReplyError'
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const isAgent = (value: unknown): value is UsageAgentId => typeof value === 'string' && Object.hasOwn(USAGE_AGENT_LABELS, value)
const amount = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new UsageHistoryReplyError('Bad number')
  return value
}
const numbers = (value: unknown, length: number): number[] => {
  if (!Array.isArray(value) || value.length !== length) throw new UsageHistoryReplyError('Bad series')
  return value.map(amount)
}
const text = (value: unknown, max = 256): string => {
  if (typeof value !== 'string' || value.length > max) throw new UsageHistoryReplyError('Bad text')
  return value
}
const tokens = (value: unknown): UsageTokens => {
  if (!isRecord(value)) throw new UsageHistoryReplyError('Bad tokens')
  return { input: amount(value.input), cacheRead: amount(value.cacheRead), cacheWrite: amount(value.cacheWrite), output: amount(value.output) }
}
const speeds = (value: unknown): UsageCostBySpeed => {
  if (!isRecord(value)) throw new UsageHistoryReplyError('Bad speeds')
  return { fast: amount(value.fast), standard: amount(value.standard), unknown: amount(value.unknown) }
}
const projectRows = (value: unknown): UsageProjectRow[] => list(value, 10_000).map((row) => {
  if (!isRecord(row)) throw new UsageHistoryReplyError('Bad project')
  return { name: text(row.name, 4096), tokens: amount(row.tokens), costUsd: amount(row.costUsd), sessions: amount(row.sessions) }
})
const sessionRows = (value: unknown): UsageSessionRow[] => list(value, 5).map((row) => {
  if (!isRecord(row) || !isAgent(row.agent)) throw new UsageHistoryReplyError('Bad session')
  return {
    agent: row.agent, session: text(row.session), model: text(row.model), project: text(row.project, 4096),
    tokens: amount(row.tokens), costUsd: amount(row.costUsd), firstAt: amount(row.firstAt), lastAt: amount(row.lastAt),
    ...(typeof row.threadId === 'string' ? { threadId: text(row.threadId), title: typeof row.title === 'string' ? row.title : '' } : {})
  }
})
const list = (value: unknown, max: number): unknown[] => {
  if (!Array.isArray(value) || value.length > max) throw new UsageHistoryReplyError('Bad list')
  return value
}

/** Checks another computer's reply field by field and keeps only what the page draws. */
/**
 * Checks a history field by field. Projects and sessions are read only from this computer's own reply (`local`);
 * another computer never sends them, and anything it sends there is dropped.
 */
export function parseUsageHistory(value: unknown, { local = false }: { local?: boolean } = {}): UsageHistoryResponse {
  if (!isRecord(value)) throw new UsageHistoryReplyError('Not an object')
  const range = USAGE_HISTORY_RANGES.find((candidate) => candidate === value.range)
  if (!range || (value.bucket !== 'hour' && value.bucket !== 'day')) throw new UsageHistoryReplyError('Bad range')
  const buckets = numbers(value.buckets, (value.buckets as unknown[] | undefined)?.length ?? -1)
  if (buckets.length > 400) throw new UsageHistoryReplyError('Too many buckets')
  const dayKeys = list(value.dayKeys, 400).map((key) => text(key, 10))
  const agents = list(value.agents, 64).map((row): UsageHistoryAgent => {
    if (!isRecord(row) || !isAgent(row.id)) throw new UsageHistoryReplyError('Bad agent')
    return {
      id: row.id, label: USAGE_AGENT_LABELS[row.id], sessions: amount(row.sessions), tokens: tokens(row.tokens),
      costUsd: amount(row.costUsd), unpricedTokens: amount(row.unpricedTokens),
      series: numbers(row.series, buckets.length), costSeries: numbers(row.costSeries, buckets.length)
    }
  })
  const models = list(value.models, 2000).map((row): UsageHistoryModelRow => {
    if (!isRecord(row) || !isAgent(row.agent)) throw new UsageHistoryReplyError('Bad model')
    return { model: text(row.model), agent: row.agent, tokens: amount(row.tokens), costUsd: amount(row.costUsd), priced: row.priced === true }
  })
  const days = list(value.days, 400).map((row) => {
    if (!isRecord(row)) throw new UsageHistoryReplyError('Bad day')
    return { day: text(row.day, 10), tokens: amount(row.tokens), costUsd: amount(row.costUsd), sessions: amount(row.sessions) }
  })
  const sources = list(value.sources, 64).map((row) => {
    if (!isRecord(row) || !isAgent(row.agent) || !['read', 'missing', 'partial'].includes(row.status as string)) throw new UsageHistoryReplyError('Bad source')
    return { agent: row.agent, path: '', status: row.status as 'read' | 'missing' | 'partial', files: amount(row.files), readFiles: amount(row.readFiles) }
  })
  return {
    range, bucket: value.bucket, buckets, dayKeys, agents, models, days, sources,
    totals: tokens(value.totals), costUsd: amount(value.costUsd), costByKind: tokens(value.costByKind),
    costUnsplitUsd: amount(value.costUnsplitUsd), costBySpeed: speeds(value.costBySpeed),
    projects: local ? projectRows(value.projects) : [], topSessions: local ? sessionRows(value.topSessions) : [],
    cacheSavingsUsd: amount(value.cacheSavingsUsd), sessions: amount(value.sessions),
    agentIds: list(value.agentIds, 64).filter(isAgent),
    readAt: text(value.readAt, 64), scanMs: amount(value.scanMs)
  }
}

const addTokens = (into: UsageTokens, from: UsageTokens) => {
  into.input += from.input; into.cacheRead += from.cacheRead; into.cacheWrite += from.cacheWrite; into.output += from.output
}

/**
 * Adds several computers' histories into one, on the first one's hours or days: a bucket another computer has
 * and the first doesn't (its clock passed the hour already) is left out. Each computer counted its own sessions.
 */
export function mergeHistories(parts: readonly UsageHistoryResponse[]): UsageHistoryResponse {
  const [first, ...rest] = parts
  if (!first) throw new Error('Nothing to merge')
  if (!rest.length) return first
  const slotOf = new Map((first.bucket === 'day' ? first.dayKeys : first.buckets).map((key, index) => [String(key), index]))
  const agents = new Map<UsageAgentId, UsageHistoryAgent>()
  const models = new Map<string, UsageHistoryModelRow>()
  const days = new Map<string, UsageHistoryResponse['days'][number]>()
  const totals: UsageTokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  const costByKind: UsageTokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  const costBySpeed: UsageCostBySpeed = { fast: 0, standard: 0, unknown: 0 }
  let costUsd = 0, costUnsplitUsd = 0, cacheSavingsUsd = 0, sessions = 0, scanMs = 0
  for (const part of parts) {
    const keys = part.bucket === 'day' ? part.dayKeys : part.buckets
    for (const agent of part.agents) {
      const row = agents.get(agent.id) ?? {
        ...agent, sessions: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, costUsd: 0, unpricedTokens: 0,
        series: first.buckets.map(() => 0), costSeries: first.buckets.map(() => 0)
      }
      row.sessions += agent.sessions
      addTokens(row.tokens, agent.tokens)
      row.costUsd += agent.costUsd
      row.unpricedTokens += agent.unpricedTokens
      keys.forEach((key, index) => {
        const slot = slotOf.get(String(key))
        if (slot === undefined) return
        row.series[slot]! += agent.series[index] ?? 0
        row.costSeries[slot]! += agent.costSeries[index] ?? 0
      })
      agents.set(agent.id, row)
    }
    for (const model of part.models) {
      const key = `${model.agent}\u0000${model.model}`
      const row = models.get(key) ?? { ...model, tokens: 0, costUsd: 0 }
      row.tokens += model.tokens
      row.costUsd += model.costUsd
      row.priced ||= model.priced
      models.set(key, row)
    }
    for (const day of part.days) {
      const row = days.get(day.day) ?? { day: day.day, tokens: 0, costUsd: 0, sessions: 0 }
      row.tokens += day.tokens
      row.costUsd += day.costUsd
      row.sessions += day.sessions
      days.set(day.day, row)
    }
    addTokens(totals, part.totals)
    addTokens(costByKind, part.costByKind)
    costUsd += part.costUsd
    costUnsplitUsd += part.costUnsplitUsd
    costBySpeed.fast += part.costBySpeed.fast
    costBySpeed.standard += part.costBySpeed.standard
    costBySpeed.unknown += part.costBySpeed.unknown
    cacheSavingsUsd += part.cacheSavingsUsd
    sessions += part.sessions
    scanMs = Math.max(scanMs, part.scanMs)
  }
  const label = (id: UsageAgentId) => USAGE_AGENT_LABELS[id]
  return {
    ...first,
    agents: [...agents.values()].sort((a, b) => sum(b.tokens) - sum(a.tokens) || a.label.localeCompare(b.label)),
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens),
    days: [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)),
    totals, costUsd, costByKind, costUnsplitUsd, costBySpeed, cacheSavingsUsd, sessions, scanMs,
    // Only this computer's part has them; summed by name all the same.
    projects: [...parts.flatMap((part) => part.projects).reduce((rows, row) => {
      const total = rows.get(row.name) ?? { name: row.name, tokens: 0, costUsd: 0, sessions: 0 }
      rows.set(row.name, { name: row.name, tokens: total.tokens + row.tokens, costUsd: total.costUsd + row.costUsd, sessions: total.sessions + row.sessions })
      return rows
    }, new Map<string, UsageProjectRow>()).values()].sort((a, b) => b.costUsd - a.costUsd),
    topSessions: parts.flatMap((part) => part.topSessions).sort((a, b) => b.costUsd - a.costUsd).slice(0, 5),
    agentIds: [...new Set(parts.flatMap((part) => part.agentIds))].sort((a, b) => label(a).localeCompare(label(b))),
    sources: parts.flatMap((part) => part.sources)
  }
}

const sum = (value: UsageTokens) => value.input + value.cacheRead + value.cacheWrite + value.output
