import type { AssistantMessage, Message } from '../../shared/transcript'
import { AgentDefinitionError } from '../../shared/agents/errors'
import { definitionAuthorityDigest, type DefinitionAuthority } from './definitionGate'
import type {
  AgentExecutionBudget,
  AgentExecutionHistoryEntry,
  AgentExecutionLimit,
  AgentExecutionSource,
  AgentRuntimeHostBindings,
  AgentRuntimeAttemptUsage,
  AgentRuntimeEffectTracker,
  AgentRuntimeInput,
  AgentRuntimePolicy,
  AgentRuntimePort,
  AgentRuntimeResult,
  AgentRuntimeToolApprovalCallback,
  AgentRuntimeUnsupportedSetting
} from '../../shared/agents/execution'
import type { AgentFallbackRetryCategory, AgentModelRef, EffectiveAgentGrants } from '../../shared/agents/types'
import { AppError } from '../../shared/errors'
import { isRetriesExhausted, type HarnessCaps, type RunPolicy } from '../../shared/harness/types'
import { RunCounters, RunSpend, type CounterScope, type SpendScope } from '../harness/budget'
import { userMessage } from '../orchestrator/nativeContext'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import {
  addAttemptUsage,
  classifyProviderFailure,
  emptyAttemptUsage,
  remainingBudget,
  errorText,
  isAbortError,
  orderedFallbackModels,
  waitBackoff
} from './runtimeFallback'
import { canonicalizeBuiltinToolName } from './runtimePolicy'

/**
 * A definition run on the harness gateway (PR 4 §6). Every stored `runtimeKind` comes here; the
 * instance is the model ref's. Each candidate (the primary, then the enabled fallbacks) is checked
 * against the definition's policy before it runs: a refused primary fails the run, a refused
 * fallback is skipped with a trace entry. Nothing is relaxed to pass admission.
 *
 * Retries: the runtime retries its own transient request failures (Pi's own retry), so a failure it
 * already retried (`retriesExhausted`, or a rate-limit, timeout or unavailable category) is never
 * retried on the same candidate; it may move to the next one. A different candidate is a different
 * model, not a repeat of the same request. Either happens only while no tool has started.
 */

/**
 * How a definition run holds its thread (PR 4 §6 "Lease"). `borrowed`: the host holds the thread's
 * execution lease for the whole run (an agent chat's backing thread); the turn checks that it is
 * live and this thread's, and never takes, stores or releases it. `own` (the default): the turn
 * takes the thread's lease itself, fails `operation_busy` when another holds it, and releases it.
 */
export type DefinitionLease = { kind: 'own' } | { kind: 'borrowed'; handle: ThreadLeaseHandle }

/** Host authority of a definition run beyond `AgentRuntimeHostBindings`; never from protocol input. */
export interface DefinitionHostBindings extends AgentRuntimeHostBindings {
  lease?: DefinitionLease
  /**
   * Runs a workspace mutation under the host's writer (a workflow node's mutation lease). Absent:
   * the lease's own writer. The runtime's writer episode takes it; it is never derived from the
   * execution thread.
   */
  writer?: <T>(run: () => Promise<T>) => Promise<T>
}

/** Who a definition turn runs for (`RunPolicy.origin`); workflow nodes are `workflow`. */
export type DefinitionOrigin = 'definition' | 'workflow'

export function definitionOrigin(source: AgentExecutionSource | undefined): DefinitionOrigin {
  return source === 'workflow' ? 'workflow' : 'definition'
}

/** What a candidate check needs: the model, and what the policy is built from. */
export interface DefinitionCheck {
  threadId: string
  origin: DefinitionOrigin
  /** The pinned definition the run executes (its authority's identity). */
  definition: { id: string; revision: string }
  ref: AgentModelRef
  grants: EffectiveAgentGrants
  budget: AgentExecutionBudget
}

/** One model turn of a definition run, on one candidate (`OrchestratorService.executeDefinitionTurn`). */
export interface DefinitionTurnRequest extends DefinitionCheck {
  /** The definition run's id. */
  runId: string
  /** The run's turn record number, from 1: every retry or fallback is a new record. */
  attempt: number
  projectPath?: string
  /** The definition's system prompt; it replaces the runtime's own instructions. */
  systemPrompt: string
  userMessage: string
  /** Prior turns only (bounded and attributed by `composeBoundedRuntimeContext`). */
  conversation: AgentExecutionHistoryEntry[]
  policy: AgentRuntimePolicy
  approve?: AgentRuntimeToolApprovalCallback
  /** One allowance for the whole definition run, shared by its records (retries and fallbacks). */
  counters: CounterScope
  spend: SpendScope
  signal: AbortSignal
  /** The first tool of the turn started: from then on there is no retry and no fallback. */
  onDispatched(): void
  /**
   * The run's effect tracker, and the definition's limits left for this record: a runtime that runs
   * the definition's loop itself (the legacy engine) holds the turn to them and reports its usage there.
   */
  effects: AgentRuntimeEffectTracker
  remaining: AgentExecutionBudget
}

export interface DefinitionTurnResult {
  text: string
  history: AgentExecutionHistoryEntry[]
  usage: { inputTokens: number; outputTokens: number; costUsd: number }
  limit?: AgentExecutionLimit
}

/** Why a candidate cannot run, before it runs (resolution or `gateway.check`). */
export interface DefinitionRefusal {
  code: string
  message: string
  missing?: Array<keyof HarnessCaps>
  reason?: string
}

export interface DefinitionTurnPort {
  checkDefinitionTurn(request: DefinitionCheck): DefinitionRefusal | undefined
  executeDefinitionTurn(request: DefinitionTurnRequest): Promise<DefinitionTurnResult>
}

/** The tool names a definition's effective grants allow (the exact allowlist of its turns). */
export function definitionToolNames(grants: EffectiveAgentGrants, extra: readonly string[] = []): string[] {
  return [...new Set([
    ...grants.builtinTools.map((grant) => canonicalizeBuiltinToolName(grant.id)),
    ...grants.mcpTools.map((grant) => grant.id),
    ...extra
  ])].sort()
}

/**
 * The policy of every turn of a definition run: the effective grants as an exact allowlist,
 * approvals as granted (the definition's own approval rules answer them), and the run's count and
 * spend limits. `maxElapsedMs` stays with `AgentExecutionService`, which aborts the run.
 */
export function definitionRunPolicy(request: Pick<DefinitionCheck, 'origin' | 'grants' | 'budget' | 'definition'>, toolNames: readonly string[] = []): RunPolicy {
  const { budget } = request
  return {
    mode: 'default',
    origin: request.origin,
    approvals: 'grants',
    tools: { allow: definitionToolNames(request.grants, toolNames) },
    // The definition's authority (grants, roots and rules) is registered with the turn's app tools;
    // the policy names it, so only an `exact` runtime admits the turn.
    authority: { kind: 'definition', digest: definitionAuthorityDigest({ policy: { definitionId: request.definition.id, definitionRevision: request.definition.revision }, grants: request.grants } as Pick<DefinitionAuthority, 'policy' | 'grants'>) },
    budget: {
      maxTurns: budget.maxTurns,
      maxToolCalls: budget.maxToolCalls,
      ...(budget.maxInputTokens !== undefined ? { maxInputTokens: budget.maxInputTokens } : {}),
      ...(budget.maxOutputTokens !== undefined ? { maxOutputTokens: budget.maxOutputTokens } : {}),
      ...(budget.maxCostUsd !== undefined ? { maxUsd: budget.maxCostUsd } : {})
    }
  }
}

/** The settings a refusal points at, for the editor (PR 4 §6 table). */
export function refusalPointers(refusal: DefinitionRefusal, budget: AgentExecutionBudget, at = '/settings/primaryModel/ref'): AgentRuntimeUnsupportedSetting[] {
  const reason = refusal.message
  const pointers: string[] = []
  for (const missing of refusal.missing ?? []) {
    if (missing === 'toolControl') pointers.push('/settings/tools/mode', '/settings/workspace/mode')
    else if (missing === 'budgets') pointers.push('/settings/limits/maxTurns', '/settings/limits/maxToolCalls')
    else if (missing === 'spendLimits') {
      if (budget.maxInputTokens !== undefined) pointers.push('/settings/limits/maxInputTokens')
      if (budget.maxOutputTokens !== undefined) pointers.push('/settings/limits/maxOutputTokens')
      if (budget.maxCostUsd !== undefined) pointers.push('/settings/limits/maxCostUsd')
    }
  }
  if (!pointers.length) pointers.push(at)
  return [...new Set(pointers)].map((pointer) => ({ pointer, reason }))
}

function refusalError(refusal: DefinitionRefusal, budget: AgentExecutionBudget, ref: AgentModelRef): AgentDefinitionError {
  const unsupported = refusalPointers(refusal, budget)
  return new AgentDefinitionError('SETTINGS_UNSUPPORTED', refusal.message, {
    pointer: unsupported[0]!.pointer,
    details: {
      code: refusal.code,
      ...(refusal.missing ? { missing: refusal.missing } : {}),
      ...(refusal.reason ? { reason: refusal.reason } : {}),
      model: { providerId: ref.providerId, modelId: ref.modelId, ...(ref.instanceId ? { instanceId: ref.instanceId } : {}) },
      pointers: unsupported.map((item) => item.pointer),
      reasons: Object.fromEntries(unsupported.map((item) => [item.pointer, item.reason]))
    }
  })
}

function historyAssistant(content: string, at: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    api: 'openai-completions',
    provider: 'history',
    model: 'history',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: Date.parse(at) || Date.now()
  }
}

/** A definition turn's messages: its bounded, attributed conversation, then the user message. */
export function definitionMessages(conversation: AgentExecutionHistoryEntry[] | undefined, user: string): Message[] {
  const messages: Message[] = []
  for (const entry of conversation ?? []) {
    if (entry.role === 'user') messages.push(userMessage(entry.content))
    else if (entry.role === 'assistant') messages.push(historyAssistant(entry.content, entry.at))
    else if (entry.role === 'tool') messages.push(userMessage(`Previous tool ${entry.name ?? 'result'}: ${entry.content}`))
  }
  messages.push(userMessage(user))
  return messages
}

/** The runtime already retried this failure itself: the same candidate is never tried again. */
const RUNTIME_RETRIED: ReadonlySet<AgentFallbackRetryCategory> = new Set(['rate_limit', 'timeout', 'unavailable'])

/** The failure's category; the runtime's own retries running out is an unavailable provider. */
function failureCategory(error: unknown): AgentFallbackRetryCategory | undefined {
  return isRetriesExhausted(error) ? 'unavailable' : classifyProviderFailure(error)
}

function runtimeRetried(error: unknown): boolean {
  if (isRetriesExhausted(error)) return true
  const category = classifyProviderFailure(error)
  return category !== undefined && RUNTIME_RETRIED.has(category)
}

/** Whether the failure allows another try (the same candidate, or the next): `canFallbackOrRetry`'s rules. */
function mayTryAgain(error: unknown, policy: AgentRuntimePolicy['fallbacks'], sameCandidate: boolean): boolean {
  const category = failureCategory(error)
  if (!category) return false
  if (policy.retryOn.length > 0) return policy.retryOn.includes(category)
  if (category === 'content_filter') return false
  return sameCandidate ? policy.retryCount > 0 : policy.enabled
}

/** A count or spend limit refused the next step: the run ends with that limit, not an error. */
function limitOf(error: unknown): AgentExecutionLimit | undefined {
  if (!(error instanceof AppError) || error.code !== 'budget_exhausted') return undefined
  const limit = (error.details as { limit?: AgentExecutionLimit } | undefined)?.limit
  return limit && typeof limit.kind === 'string' && typeof limit.limit === 'number' ? limit : undefined
}

/** A refusal because the instance cannot hold the definition (as opposed to the model being unreachable). */
function isPolicyRefusal(refusal: DefinitionRefusal): boolean {
  return refusal.code === 'policy_unenforceable' || Boolean(refusal.missing?.length)
}

/**
 * One record's usage, counted once: what a loop that runs under the definition's limits reported
 * (the legacy engine), else what the turn reported.
 */
function recordUsage(loop: AgentRuntimeAttemptUsage, turn: DefinitionTurnResult['usage']): AgentRuntimeAttemptUsage {
  if (loop.inputTokens || loop.outputTokens || loop.costUsd || loop.turns || loop.toolCalls) return loop
  return { inputTokens: turn.inputTokens, outputTokens: turn.outputTokens, costUsd: turn.costUsd, turns: 0, toolCalls: 0 }
}

/** A limit the earlier records already used up: the next record never starts. */
function exhaustedBefore(remaining: AgentExecutionBudget, original: AgentExecutionBudget, used: ReturnType<typeof emptyAttemptUsage>): AgentExecutionLimit | undefined {
  if (original.maxElapsedMs > 0 && remaining.maxElapsedMs <= 0) return { kind: 'elapsed_ms', limit: original.maxElapsedMs }
  if (remaining.maxTurns <= 0) return { kind: 'turns', limit: original.maxTurns, actual: used.turns }
  if (original.maxInputTokens !== undefined && remaining.maxInputTokens! <= 0) return { kind: 'input_tokens', limit: original.maxInputTokens, actual: used.inputTokens }
  if (original.maxOutputTokens !== undefined && remaining.maxOutputTokens! <= 0) return { kind: 'output_tokens', limit: original.maxOutputTokens, actual: used.outputTokens }
  if (original.maxCostUsd !== undefined && remaining.maxCostUsd! <= 0) return { kind: 'cost_usd', limit: original.maxCostUsd, actual: used.costUsd }
  return undefined
}

/** The definition runtime over the gateway's turn code (`DefinitionTurnPort`). */
export function createDefinitionRuntime(port: DefinitionTurnPort): AgentRuntimePort {
  return {
    async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
      const started = Date.now()
      const effects = input.effects ?? { dispatched: false, attemptUsage: emptyAttemptUsage() }
      effects.dispatched = false
      effects.attemptUsage = emptyAttemptUsage()
      const policy = input.policy
      if (!policy) throw new AgentDefinitionError('SETTINGS_UNSUPPORTED', 'A definition run needs its compiled runtime policy.')
      const fallbackPolicy = policy.fallbacks
      const candidates = orderedFallbackModels(input.model.primary, policy.fallbackModels, fallbackPolicy.enabled)
      const origin = definitionOrigin(policy.source)
      // One allowance for the run: retries and fallbacks are new turn records, never fresh counts.
      const counters = new RunCounters()
      const spend = new RunSpend()
      const trace: string[] = []
      // What every record used, failed ones included: the limits left and the usage reported.
      let used = emptyAttemptUsage()
      const result = (text: string, history: AgentExecutionHistoryEntry[], limit?: AgentExecutionLimit): AgentRuntimeResult => ({
        text,
        history,
        usage: {
          inputTokens: used.inputTokens,
          outputTokens: used.outputTokens,
          totalTokens: used.inputTokens + used.outputTokens,
          costUsd: used.costUsd,
          elapsedMs: Date.now() - started
        },
        ...(limit ? { limit } : {}),
        ...(trace.length ? { trace } : {})
      })
      let attempt = 0
      let lastError: unknown
      for (let index = 0; index < candidates.length; ) {
        if (input.signal.aborted) throw input.signal.reason ?? new DOMException('Aborted', 'AbortError')
        const ref = candidates[index]!.ref
        const check: DefinitionCheck = { threadId: input.threadId, origin, definition: { id: policy.definitionId, revision: policy.definitionRevision }, ref, grants: input.grants, budget: input.budget }
        const refusal = port.checkDefinitionTurn(check)
        if (refusal && isPolicyRefusal(refusal)) {
          // A primary that cannot hold the definition fails the run: there is no silent move to a fallback.
          if (index === 0) throw refusalError(refusal, input.budget, ref)
          trace.push(`Skipped fallback ${ref.instanceId ?? ref.providerId}/${ref.modelId}: ${refusal.message}`)
          index += 1
          continue
        }
        if (refusal) {
          // The model cannot be reached (its provider turned off or missing, the model hidden): like a
          // failed attempt before any tool, it moves to the next model when the fallback settings allow.
          const unavailable = new Error(refusal.message)
          lastError = refusalError(refusal, input.budget, ref)
          if (index + 1 < candidates.length && mayTryAgain(unavailable, fallbackPolicy, false)) {
            trace.push(`Moved from ${ref.instanceId ?? ref.providerId}/${ref.modelId}: ${refusal.message}`)
            index += 1
            continue
          }
          throw lastError
        }
        let sameCandidateRetries = 0
        for (;;) {
          attempt += 1
          const remaining = remainingBudget(input.budget, used, Date.now() - started)
          const exhausted = exhaustedBefore(remaining, input.budget, used)
          if (exhausted) return result('', [], exhausted)
          effects.attemptUsage = emptyAttemptUsage()
          try {
            const turn = await port.executeDefinitionTurn({
              ...check,
              runId: input.runId,
              attempt,
              ...(input.projectPath ? { projectPath: input.projectPath } : {}),
              systemPrompt: input.systemPrompt,
              userMessage: input.userMessage,
              conversation: input.conversation ?? [],
              policy,
              ...(input.approveToolRequest ? { approve: input.approveToolRequest } : {}),
              counters,
              spend,
              signal: input.signal,
              onDispatched: () => { effects.dispatched = true },
              effects,
              remaining
            })
            used = addAttemptUsage(used, recordUsage(effects.attemptUsage, turn.usage))
            return result(turn.text, turn.history, turn.limit)
          } catch (error) {
            used = addAttemptUsage(used, effects.attemptUsage)
            lastError = error
            const limit = limitOf(error)
            if (limit) return result('', [], limit)
            if (isAbortError(error, input.signal) || effects.dispatched) throw error
            const retrySame = !runtimeRetried(error) &&
              sameCandidateRetries < fallbackPolicy.retryCount &&
              mayTryAgain(error, fallbackPolicy, true)
            if (retrySame) {
              sameCandidateRetries += 1
              await waitBackoff(fallbackPolicy.backoffMs, input.signal)
              continue
            }
            const next = index + 1 < candidates.length && mayTryAgain(error, fallbackPolicy, false)
            if (!next) throw error
            trace.push(`Moved from ${ref.instanceId ?? ref.providerId}/${ref.modelId} after: ${errorText(error)}`)
            await waitBackoff(fallbackPolicy.backoffMs, input.signal)
            break
          }
        }
        index += 1
      }
      throw lastError instanceof Error ? lastError : new Error(errorText(lastError ?? 'No model could run this agent.'))
    }
  }
}
