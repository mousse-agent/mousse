import { AppError } from '../../../shared/errors'
import { harnessAppError } from '../../../shared/harness/types'
import { extractLimitFromError } from '../../models/usageLimits'
import { sameIdentity, type OneShotIdentity, type OneShotPlan } from './admission'
import type { OneShotTransport, OneShotWireRequest } from './route'

/**
 * The runner: takes an admitted plan, checks just before sending that the entry is still the one admitted, sends the
 * request once through the route's transport, and holds it to its bounds. It never sends again. See
 * docs/plans/one-shots-every-provider.md §3.
 */

/** The first line of every prompt on a route whose agent can be offered tools at all. */
export const ONE_SHOT_INSTRUCTION = 'Use only the input below. Do not use tools, read or write files, run commands, or ask questions. Reply with only the requested text.'
/** Past this with no sign of life, the request ends. */
export const ONE_SHOT_INACTIVITY_MS = 60_000
/** An answer that streams more than this many characters ends the request. */
export const ONE_SHOT_STREAM_CAP = 128_000
/** A request with no budget of its own (a chosen model) ends past this. */
export const ONE_SHOT_DEADLINE_MS = 180_000
/** One Automatic candidate's longest wait. */
export const CANDIDATE_DEADLINE_MS = 15_000
/** Kept from the budget for the next candidate. */
export const NEXT_CANDIDATE_RESERVE_MS = 3_000

/** A candidate's deadline: the smaller of 15 s and what the pass has left minus 3 s for the next one. */
export function candidateDeadlineMs(budgetLeftMs: number): number {
  return Math.max(0, Math.min(CANDIDATE_DEADLINE_MS, budgetLeftMs - NEXT_CANDIDATE_RESERVE_MS))
}

/** Whether a failed request had left for the provider (`OneShotEvents.sending`), as the runner saw it. */
const sentOutcomes = new WeakMap<object, boolean>()

/**
 * Whether a single request that failed with `error` was sent: true or false when the runner ran it, undefined for a
 * failure from before it (resolution, admission).
 */
export function oneShotWasSent(error: unknown): boolean | undefined {
  return error && typeof error === 'object' ? sentOutcomes.get(error) : undefined
}

/** The key an executable's fingerprint is compared by. */
export function executableKey(fingerprint: { path: string; size: number; mtimeMs: number } | undefined): string | undefined {
  if (!fingerprint) return undefined
  const path = process.platform === 'win32' ? fingerprint.path.toLowerCase() : fingerprint.path
  return `${path}|${fingerprint.size}|${fingerprint.mtimeMs}`
}

/** Every way a single request ends without an answer. */
export type OneShotFailureKind =
  | 'tool_refused'
  | 'tool_detected'
  | 'rate_limited'
  | 'retry_detected'
  | 'unavailable'
  | 'empty'
  | 'too_long'
  | 'signed_out'
  | 'timeout'
  | 'not_admitted'
  | 'cancelled'

const NOT_ADMITTED_CODES = new Set(['unsupported', 'model_hidden', 'instance_disabled', 'instance_unknown', 'policy_unenforceable', 'binding_stale', 'provider_retired', 'known_broken', 'no_model_selected', 'not_eligible', 'wont_run'])

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

function detailOf(error: unknown, key: string): unknown {
  if (!(error instanceof AppError) || !error.details || typeof error.details !== 'object') return undefined
  return (error.details as Record<string, unknown>)[key]
}

/** Which row of the failure table an error is. Exhaustive: anything unknown is `unavailable`. */
export function classifyOneShotFailure(error: unknown): OneShotFailureKind {
  const name = (error as { name?: unknown } | undefined)?.name
  if (name === 'AbortError') return 'cancelled'
  const code = codeOf(error)
  if (code === 'aborted' || code === 'cancelled' || code === 'provider_cancelled') return 'cancelled'
  if (code === 'one_shot_tool_refused') return detailOf(error, 'reason') === 'tool_detected' ? 'tool_detected' : 'tool_refused'
  if (code === 'timeout' || code === 'provider_timeout' || name === 'TimeoutError') return 'timeout'
  if (extractLimitFromError(error)) return 'rate_limited'
  if (detailOf(error, 'retriesExhausted') === true) return 'retry_detected'
  if (code === 'signed_out' || code === 'auth_expired') return 'signed_out'
  if (detailOf(error, 'reason') === 'not_admitted' || (code && NOT_ADMITTED_CODES.has(code))) return 'not_admitted'
  if (detailOf(error, 'reason') === 'empty') return 'empty'
  if (detailOf(error, 'reason') === 'too_long') return 'too_long'
  return 'unavailable'
}

export interface RunPlanInput {
  plan: OneShotPlan
  transport: OneShotTransport
  /** The entry as it is now; undefined when it is gone. Read before the transport starts and again as it sends. */
  live(): OneShotIdentity | undefined
  /** The fingerprint of an executable as it is now (the program a transport is about to start). */
  fingerprint?(path: string): { path: string; size: number; mtimeMs: number } | undefined
  label: string
  system: string
  prompt: string
  /** The answer is cut to this many characters. */
  maxChars: number
  /** This request's longest wait (`candidateDeadlineMs` for an Automatic candidate). */
  deadlineMs?: number
  signal?: AbortSignal
}

/**
 * Sends the plan's request once. Ends it on the caller's signal, its deadline, {@link ONE_SHOT_INACTIVITY_MS} with no
 * sign of life, more than {@link ONE_SHOT_STREAM_CAP} characters, or the first tool the provider reports. An answer
 * with no text fails as `empty`. Failures are typed errors that {@link classifyOneShotFailure} reads.
 */
export async function runPlan(input: RunPlanInput): Promise<string> {
  const { plan, label } = input
  input.signal?.throwIfAborted()
  const stale = () => {
    const error = harnessAppError({ code: 'binding_stale', reason: 'not_admitted', message: `${label} changed since this request was admitted, so Mousse did not send it.`, instanceId: plan.instanceId })
    sentOutcomes.set(error, false)
    return error
  }
  const checkIdentity = () => {
    const now = input.live()
    if (!now || !sameIdentity(now, plan.identity)) throw stale()
  }
  checkIdentity()
  // The route says when its request leaves (`sending`).
  let sent = false
  const outcome = (error: unknown): unknown => {
    if (error && typeof error === 'object' && !sentOutcomes.has(error)) sentOutcomes.set(error, sent)
    return error
  }
  const ended = new AbortController()
  let failure: Error | undefined
  // Settles the request the moment the runner ends it: the transport's own teardown goes on without holding it.
  let settle!: (error: Error) => void
  const settled = new Promise<never>((_, reject) => { settle = reject })
  settled.catch(() => {})
  const end = (error: Error) => {
    failure ??= error
    ended.abort(error)
    settle(failure)
  }
  let idle: ReturnType<typeof setTimeout> | undefined
  const activity = () => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => end(harnessAppError({ code: 'timeout', message: `${label} sent nothing for ${ONE_SHOT_INACTIVITY_MS / 1000} seconds.`, instanceId: plan.instanceId })), ONE_SHOT_INACTIVITY_MS)
    idle.unref?.()
  }
  const deadlineMs = input.deadlineMs ?? ONE_SHOT_DEADLINE_MS
  const deadline = setTimeout(() => end(harnessAppError({ code: 'timeout', message: `${label} did not answer within ${Math.round(deadlineMs / 1000)} seconds.`, instanceId: plan.instanceId })), deadlineMs)
  deadline.unref?.()
  const signal = input.signal ? AbortSignal.any([input.signal, ended.signal]) : ended.signal
  let streamed = 0
  const tooLong = () => harnessAppError({ code: 'protocol', reason: 'too_long', message: `${label} wrote more than ${ONE_SHOT_STREAM_CAP.toLocaleString('en-US')} characters, so Mousse stopped it.`, instanceId: plan.instanceId })
  const offersTools = plan.route.facts.tools !== 'none_offered'
  const wire: OneShotWireRequest = {
    model: plan.model,
    ...(offersTools ? { instruction: ONE_SHOT_INSTRUCTION } : {}),
    system: input.system,
    prompt: input.prompt
  }
  activity()
  try {
    const sending = input.transport.send(wire, {
      activity: () => { if (!failure) activity() },
      text: (chunk) => {
        if (failure) return
        activity()
        streamed += chunk.length
        if (streamed > ONE_SHOT_STREAM_CAP) end(tooLong())
      },
      tool: (what) => end(harnessAppError({ code: 'one_shot_tool_refused', reason: 'tool_detected', message: `${label} tried to use a tool (${what}) in a request that runs none, so Mousse stopped it.`, instanceId: plan.instanceId })),
      launching: (executable) => {
        if (failure) throw failure
        const admitted = plan.identity.executable
        if (admitted && admitted !== executableKey(input.fingerprint?.(executable))) throw stale()
      },
      sending: () => {
        if (failure) throw failure
        checkIdentity()
        sent = true
      }
    }, signal)
    // Once the runner has ended the request, the transport's late answer or failure is its own to clean up.
    sending.catch(() => {})
    const text = await Promise.race([sending, settled])
    if (failure) throw failure
    input.signal?.throwIfAborted()
    if (text.length > ONE_SHOT_STREAM_CAP) throw tooLong()
    if (!text.trim()) throw harnessAppError({ code: 'protocol', reason: 'empty', message: `${label} answered with no text.`, instanceId: plan.instanceId })
    return text.slice(0, Math.max(0, input.maxChars))
  } catch (error) {
    // The runner's own ending outranks whatever the transport threw when it was stopped.
    if (failure) throw outcome(failure)
    throw outcome(error)
  } finally {
    clearTimeout(deadline)
    if (idle) clearTimeout(idle)
  }
}
