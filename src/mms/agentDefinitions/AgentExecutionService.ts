import Ajv from 'ajv'
import { AgentDefinitionError, isAgentDefinitionError } from '../../shared/agents/errors'
import type {
  AgentExecutionBindings,
  AgentExecutionBudget,
  AgentExecutionHistoryEntry,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentRuntimeEffectTracker,
  AgentRuntimeHostBindings,
  AgentRuntimeInput,
  AgentRuntimeResult
} from '../../shared/agents/execution'
import type { ResolvedAgentDefinition } from '../../shared/agents/types'
import {
  assertContextSnapshotMatchesRun,
  assertRequiredContextSources,
  buildNativeSystemPrompt,
  composeBoundedRuntimeContext
} from './runtimeContext'
import { emptyAttemptUsage } from './runtimeFallback'
import {
  assertRuntimeSettingsSupported,
  compileRuntimePolicy,
  pathInsideCanonicalRoots
} from './runtimePolicy'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
}

function assertRequestedBudget(requested: Partial<AgentExecutionBudget> | undefined): void {
  if (!requested) return
  const keys = [
    'maxTurns',
    'maxToolCalls',
    'maxElapsedMs',
    'maxInputTokens',
    'maxOutputTokens',
    'maxCostUsd'
  ] as const
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(requested, key)) continue
    const value = requested[key]
    if (value === undefined) continue
    if (!Number.isFinite(value) || value < 0) {
      throw new AgentDefinitionError(
        'INVALID_BUNDLE',
        `Requested budget ${key} must be a finite number ≥ 0.`,
        { pointer: `/budget/${key}`, details: { value } }
      )
    }
  }
}

function clampLimit(requested: number | undefined, definition: number): number {
  if (requested === undefined) return definition
  return Math.min(definition, requested)
}

function resolveBudget(
  settings: ResolvedAgentDefinition['settings'],
  requested: Partial<AgentExecutionBudget> | undefined
): AgentExecutionBudget {
  assertRequestedBudget(requested)
  const limits = settings.limits
  return {
    maxTurns: clampLimit(requested?.maxTurns, limits.maxTurns),
    maxToolCalls: clampLimit(requested?.maxToolCalls, limits.maxToolCalls),
    maxElapsedMs: clampLimit(requested?.maxElapsedMs, limits.maxElapsedMs),
    maxInputTokens: requested?.maxInputTokens === undefined
      ? limits.maxInputTokens
      : clampLimit(requested.maxInputTokens, limits.maxInputTokens ?? requested.maxInputTokens),
    maxOutputTokens: requested?.maxOutputTokens === undefined
      ? limits.maxOutputTokens
      : clampLimit(requested.maxOutputTokens, limits.maxOutputTokens ?? requested.maxOutputTokens),
    maxCostUsd: requested?.maxCostUsd === undefined
      ? limits.maxCostUsd
      : Math.min(limits.maxCostUsd ?? requested.maxCostUsd, requested.maxCostUsd)
  }
}

function extractHistory(error: unknown): AgentExecutionHistoryEntry[] | undefined {
  if (!error || typeof error !== 'object') return undefined
  const candidate = (error as { history?: unknown }).history
  return Array.isArray(candidate) ? candidate as AgentExecutionHistoryEntry[] : undefined
}

function validateStructuredOutput(
  settings: ResolvedAgentDefinition['settings'],
  text: string
): string | undefined {
  const output = settings.output
  if (output.format !== 'json' && output.format !== 'schema') return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return 'Agent output is not valid JSON.'
  }
  if (output.format !== 'schema' || !output.jsonSchema) return undefined
  try {
    // JSON Schema permits `required` names without a sibling `properties`
    // declaration (the names simply constrain instances accepted by another
    // schema keyword). Keep Ajv strict for keywords and types while accepting
    // this valid compact form used by workflow agent nodes.
    const validate = new Ajv({ allErrors: true, strict: true, strictRequired: false }).compile(output.jsonSchema)
    if (validate(value)) return undefined
    const detail = validate.errors?.map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('; ')
    return `Agent output does not match its JSON schema${detail ? `: ${detail}` : '.'}`
  } catch (error) {
    return `Agent output schema could not be evaluated: ${errorText(error)}`
  }
}

function historyWithDefaults(
  input: AgentRuntimeInput,
  result: AgentRuntimeResult,
  now: () => number
): AgentExecutionHistoryEntry[] {
  const at = new Date(now()).toISOString()
  const history = result.history?.length ? structuredClone(result.history) : []
  if (!history.some((entry) => entry.role === 'user' && entry.content === input.userMessage)) {
    history.unshift({ role: 'user', content: input.userMessage, at })
  }
  if (!history.some((entry) => entry.role === 'assistant') && result.text) {
    history.push({ role: 'assistant', content: result.text, at })
  }
  return history
}

function createEffectTracker(): AgentRuntimeEffectTracker {
  return { dispatched: false, attemptUsage: emptyAttemptUsage() }
}

function cliCapabilityDetails(error: unknown): { code: string; message: string; retryable: false; details: Record<string, unknown> } | undefined {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'CLI_CAPABILITY_UNSUPPORTED') return undefined
  const report = 'report' in error ? error.report : undefined
  return {
    code: 'CLI_CAPABILITY_UNSUPPORTED',
    message: error instanceof Error ? error.message : 'CLI runtime cannot enforce the resolved capabilities.',
    retryable: false,
    details: { report }
  }
}

export class AgentExecutionService {
  private readonly now: () => number
  private readonly id: () => string
  private readonly host: AgentRuntimeHostBindings | undefined

  constructor(private readonly bindings: AgentExecutionBindings) {
    this.now = bindings.now ?? Date.now
    this.id = bindings.id ?? (() => crypto.randomUUID())
    this.host = bindings.host
  }

  async run(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const resolved = request.resolved
    if (resolved.profileId !== request.profileId) {
      throw new AgentDefinitionError('PROFILE_MISMATCH', 'Resolved agent definition belongs to another profile.', {
        details: { expected: request.profileId, actual: resolved.profileId, definitionId: resolved.definitionId }
      })
    }
    if (!request.threadId.trim()) throw new AgentDefinitionError('INVALID_BUNDLE', 'threadId is required.')
    const userMessage = request.input ?? resolved.instructions.task
    if (!userMessage.trim()) throw new AgentDefinitionError('INVALID_BUNDLE', 'Agent execution input is required.')

    const host = request.host ?? this.host
    assertRuntimeSettingsSupported(resolved, host)
    assertContextSnapshotMatchesRun({
      profileId: request.profileId,
      threadId: request.threadId,
      definitionId: resolved.definitionId,
      memoryScope: resolved.settings.memory.scope,
      snapshot: request.context
    })
    assertRequiredContextSources(resolved, request.context)

    const runId = request.runId ?? this.id()
    const source = request.source ?? 'editor'
    const policy = compileRuntimePolicy({
      resolved,
      runId,
      threadId: request.threadId,
      source,
      projectPath: request.projectPath,
      host
    })
    const projectPath = request.projectPath?.trim()
      || policy.workspace.canonicalRoots[0]
    if (projectPath && policy.workspace.canonicalRoots.length > 0) {
      const inside = pathInsideCanonicalRoots(projectPath, policy.workspace.canonicalRoots)
      if (!inside.ok) {
        throw new AgentDefinitionError('PATH_ESCAPE', inside.reason, {
          details: { projectPath, roots: policy.workspace.canonicalRoots }
        })
      }
    }

    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort(request.signal?.reason)
    if (request.signal?.aborted) forwardAbort()
    else request.signal?.addEventListener('abort', forwardAbort, { once: true })
    const started = this.now()
    const budget = resolveBudget(resolved.settings, request.budget)
    const runtimeContext = composeBoundedRuntimeContext({ resolved, policy, snapshot: request.context })
    const input: AgentRuntimeInput = {
      runId,
      profileId: request.profileId,
      threadId: request.threadId,
      projectPath,
      runtimeKind: resolved.runtimeKind,
      model: structuredClone(resolved.model),
      systemPrompt: buildNativeSystemPrompt(resolved, policy, request.context, runtimeContext.systemAdditions),
      userMessage,
      grants: structuredClone(resolved.grants),
      budget,
      signal: controller.signal,
      policy,
      approveToolRequest: host?.approveToolRequest,
      effects: createEffectTracker(),
      conversation: runtimeContext.conversation,
      fallbacks: structuredClone(resolved.settings.fallbacks)
    }
    const runtime = resolved.runtimeKind === 'mousse'
      ? this.bindings.native
      : this.bindings.cli?.[resolved.runtimeKind]
    if (!runtime) {
      request.signal?.removeEventListener('abort', forwardAbort)
      throw new AgentDefinitionError('SETTINGS_UNSUPPORTED', `No execution adapter is registered for ${resolved.runtimeKind}.`, {
        details: { runtimeKind: resolved.runtimeKind }
      })
    }
    const deadline = budget.maxElapsedMs > 0
      ? setTimeout(
          () => controller.abort(new DOMException('Agent execution exceeded its time budget.', 'TimeoutError')),
          budget.maxElapsedMs
        )
      : undefined

    const base = {
      runId,
      profileId: request.profileId,
      threadId: request.threadId,
      definitionId: resolved.definitionId,
      definitionRevision: resolved.revision,
      runtimeKind: resolved.runtimeKind
    } as const
    try {
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const result = await runtime.run(input)
      const elapsedMs = Math.max(0, this.now() - started)
      if (controller.signal.aborted) {
        return {
          ...base,
          status: 'cancelled',
          text: result.text ?? '',
          history: historyWithDefaults(input, result, this.now),
          usage: { ...result.usage, elapsedMs },
          error: { code: 'ABORTED', message: 'Agent execution was cancelled.', retryable: false }
        }
      }
      if (result.limit) {
        return {
          ...base,
          status: 'failed',
          text: result.text,
          history: historyWithDefaults(input, result, this.now),
          usage: { ...result.usage, elapsedMs },
          error: {
            code: 'BUDGET_EXCEEDED',
            message: `Agent execution exceeded its ${result.limit.kind} limit (${result.limit.limit}).`,
            retryable: false,
            details: { limit: result.limit }
          }
        }
      }
      const outputError = validateStructuredOutput(resolved.settings, result.text)
      if (outputError) {
        return {
          ...base,
          status: 'failed',
          text: result.text,
          history: historyWithDefaults(input, result, this.now),
          usage: { ...result.usage, elapsedMs },
          error: { code: 'OUTPUT_INVALID', message: outputError, retryable: true }
        }
      }
      return {
        ...base,
        status: 'completed',
        text: result.text,
        history: historyWithDefaults(input, result, this.now),
        usage: { ...result.usage, elapsedMs }
      }
    } catch (error) {
      const elapsedMs = Math.max(0, this.now() - started)
      const cancelled = isAbort(error, controller.signal)
      const cliCapability = cliCapabilityDetails(error)
      if (!cancelled && cliCapability) {
        return {
          ...base,
          status: 'failed',
          text: '',
          history: historyWithDefaults(input, { text: '', history: extractHistory(error) }, this.now),
          usage: { elapsedMs },
          error: cliCapability
        }
      }
      if (!cancelled && isAgentDefinitionError(error)) {
        return {
          ...base,
          status: 'failed',
          text: '',
          history: historyWithDefaults(input, { text: '', history: extractHistory(error) }, this.now),
          usage: { elapsedMs },
          error: {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            details: error.details
          }
        }
      }
      return {
        ...base,
        status: cancelled ? 'cancelled' : 'failed',
        text: '',
        history: historyWithDefaults(input, { text: '', history: extractHistory(error) }, this.now),
        usage: { elapsedMs },
        error: {
          code: cancelled ? 'ABORTED' : 'RUNTIME_ERROR',
          message: errorText(error),
          retryable: !cancelled
        }
      }
    } finally {
      if (deadline) clearTimeout(deadline)
      request.signal?.removeEventListener('abort', forwardAbort)
    }
  }
}

export function createAgentExecutionService(bindings: AgentExecutionBindings): AgentExecutionService {
  return new AgentExecutionService(bindings)
}
