/** The limits on jobs agents create, which a person sets on the Scheduled page (`scheduled.agentJobMaxActive` and its two siblings). */
export interface AgentJobLimits {
  /** Active jobs agents may have in a profile at once. */
  maxActive: number
  /** A job an agent creates or changes never runs more often than this. */
  minIntervalMinutes: number
  /** A job an agent creates ends after this many days unless a person extends it. */
  lifetimeDays: number
}

export type AgentJobLimitKey = keyof AgentJobLimits

export const AGENT_JOB_LIMIT_DEFAULTS: Readonly<AgentJobLimits> = { maxActive: 10, minIntervalMinutes: 15, lifetimeDays: 7 }

/** Whole numbers a person may choose, both ends included. */
export const AGENT_JOB_LIMIT_RANGES: Readonly<Record<AgentJobLimitKey, { readonly min: number; readonly max: number }>> = {
  maxActive: { min: 1, max: 100 },
  minIntervalMinutes: { min: 1, max: 1440 },
  lifetimeDays: { min: 1, max: 365 }
}

/** The `scheduled` setting that holds each limit. */
export const AGENT_JOB_LIMIT_SETTINGS: Readonly<Record<AgentJobLimitKey, 'agentJobMaxActive' | 'agentJobMinIntervalMinutes' | 'agentJobLifetimeDays'>> = {
  maxActive: 'agentJobMaxActive',
  minIntervalMinutes: 'agentJobMinIntervalMinutes',
  lifetimeDays: 'agentJobLifetimeDays'
}

export function isAgentJobLimit(key: AgentJobLimitKey, value: unknown): value is number {
  const range = AGENT_JOB_LIMIT_RANGES[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max
}

/** The saved value when it is a whole number in range, else the default (a hand-edited file never disables a limit). */
export function agentJobLimitOrDefault(key: AgentJobLimitKey, value: unknown): number {
  return isAgentJobLimit(key, value) ? value : AGENT_JOB_LIMIT_DEFAULTS[key]
}

const LIMIT_LABELS: Readonly<Record<AgentJobLimitKey, string>> = {
  maxActive: 'Active jobs agents may have',
  minIntervalMinutes: 'Shortest interval between runs (minutes)',
  lifetimeDays: 'Days a job an agent creates lasts'
}

/** What to tell a person whose value is refused: the setting and the range it takes. */
export function agentJobLimitProblem(key: AgentJobLimitKey): string {
  const { min, max } = AGENT_JOB_LIMIT_RANGES[key]
  return `${LIMIT_LABELS[key]} must be a whole number from ${min} to ${max}.`
}
