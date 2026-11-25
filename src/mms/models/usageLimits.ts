import { limitFamilyOf } from '../../shared/bots/personal/modelSlots'
import { AppError } from '../../shared/errors'
import { boundedResetIso } from '../orchestrator/providerErrors'
import { usageLimitOf } from '../run/pausePolicy'

/**
 * The usage limits a profile met, in memory, shared by every hidden model choice: bots' model (`BotModelChooser`) and
 * Automatic thread naming (`TitleModelCache`). A limit holds a whole entry (`markInstanceLimited`) or one model on it
 * (`markModelLimited`: an Antigravity model's own quota, Claude's weekly Opus window) until its reset; a reset that
 * passed is forgotten when it is next read. A restart forgets them all, and the next limited request marks them again.
 */

/**
 * How long a limit whose reset is only guessed holds. A naming request is small: a guess of five hours (the run pause's
 * estimate) would keep bots and naming off an entry that may be back in minutes.
 */
export const SHORT_LIMIT_COOLDOWN_MS = 2 * 60_000

/** A usage limit read from a failed request: until when, and whether it holds the whole entry or the model alone. */
export interface ExtractedLimit {
  until: string
  scope: 'instance' | 'model'
  /**
   * Too many requests just now, not a plan or quota limit: only the feature whose request met it waits (Automatic
   * naming's own cooldowns), never the profile's shared limits, so a busy moment does not pause bots.
   */
  transient?: true
}

const modelKey = (instanceId: string, model: string) => `${instanceId}\0${model}`

/** `nowMs` plus the short cooldown, as ISO. */
export function shortCooldown(nowMs: number): string {
  return new Date(nowMs + SHORT_LIMIT_COOLDOWN_MS).toISOString()
}

export class UsageLimitTracker {
  private readonly instances = new Map<string, string>()
  private readonly models = new Map<string, string>()

  /** The whole entry is at its limit until `until` (ISO). A later reset already held wins. */
  markInstanceLimited(instanceId: string, until: string): void {
    later(this.instances, instanceId, until)
  }

  /** One model on the entry is at its limit until `until` (ISO); its other models stay usable. */
  markModelLimited(instanceId: string, model: string, until: string): void {
    later(this.models, modelKey(instanceId, model), until)
  }

  /** The owner's Resume: the entry and each of its models are tried again. */
  clearInstance(instanceId: string): void {
    this.instances.delete(instanceId)
    const prefix = `${instanceId}\0`
    for (const key of [...this.models.keys()]) if (key.startsWith(prefix)) this.models.delete(key)
  }

  /**
   * Until when the entry, or `model` on it, is held now: the later of the entry's limit and the model's, or undefined
   * when neither holds. Resets that passed are forgotten.
   */
  limitUntil(instanceId: string, model?: string, now: Date = new Date()): string | undefined {
    const entry = unexpired(this.instances, instanceId, now)
    const own = model === undefined ? undefined : unexpired(this.models, modelKey(instanceId, model), now)
    if (!entry) return own
    if (!own) return entry
    return Date.parse(own) > Date.parse(entry) ? own : entry
  }

  isLimited(instanceId: string, model?: string, now: Date = new Date()): boolean {
    return Boolean(this.limitUntil(instanceId, model, now))
  }

  /** The entries held as a whole now, by reset (ISO); resets that passed are forgotten. */
  limitedInstances(now: Date = new Date()): ReadonlyMap<string, string> {
    for (const [instanceId, until] of [...this.instances]) if (Date.parse(until) <= now.getTime()) this.instances.delete(instanceId)
    return new Map(this.instances)
  }
}

function later(map: Map<string, string>, key: string, until: string): void {
  const at = Date.parse(until)
  if (Number.isNaN(at)) return
  const held = map.get(key)
  if (!held || at > Date.parse(held)) map.set(key, until)
}

function unexpired(map: Map<string, string>, key: string, now: Date): string | undefined {
  const until = map.get(key)
  if (until === undefined) return undefined
  if (Date.parse(until) > now.getTime()) return until
  map.delete(key)
  return undefined
}

/**
 * The usage limit a failed request stands for, or undefined when it is anything else.
 *
 * - A plan limit (`provider_usage_limit`, or `rate_limited` carrying one): until its reported reset, or the short
 *   cooldown when the reset is Mousse's guess. A window for one model family (`seven_day_opus`) holds that model alone.
 * - A gateway `rate_limited` (an Antigravity model's quota says `scope: 'model'`): until its `resetAt`, else the short
 *   cooldown. One for the whole entry with no reset is too many requests now (`transient`).
 * - A provider's `provider_rate_limited` (too many requests now): the whole entry, for the short cooldown (`transient`).
 */
export function extractLimitFromError(error: unknown, now: Date = new Date()): ExtractedLimit | undefined {
  const nowMs = now.getTime()
  const plan = usageLimitOf(error)
  if (plan) {
    const until = plan.estimated ? shortCooldown(nowMs) : (boundedResetIso(plan.resetsAt, nowMs) ?? shortCooldown(nowMs))
    return { until, scope: limitFamilyOf(plan.limitKind) ? 'model' : 'instance' }
  }
  if (!(error instanceof AppError)) return undefined
  if (error.code === 'rate_limited') {
    const details = error.details && typeof error.details === 'object' ? (error.details as Record<string, unknown>) : {}
    const resetAt = typeof details.resetAt === 'string' ? boundedResetIso(details.resetAt, nowMs) : undefined
    const scope = details.scope === 'model' ? 'model' : 'instance'
    if (!resetAt && scope === 'instance') return { until: shortCooldown(nowMs), scope, transient: true }
    return { until: resetAt ?? shortCooldown(nowMs), scope }
  }
  if (error.code === 'provider_rate_limited') return { until: shortCooldown(nowMs), scope: 'instance', transient: true }
  return undefined
}
