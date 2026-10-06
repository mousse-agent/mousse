import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { ModelUsage, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'
import { countLineEdits } from '../../../shared/lineEditStats'

export type ClaudeSubscriptionMetrics = {
  usage: AssistantMessage['usage'] | null
  realModelName?: string
  totalResponseTimeMs: number
  totalTokensUsed?: number
  tokensPerSecond?: number
  usageScope?: 'session-delta' | 'main-turn' | 'assistant'
  context?: {
    input: number
    cacheRead: number
    cacheWrite: number
    contextWindow?: number
    modelName?: string
  }
}
export type ClaudeUsageBaseline = {
  sessionId: string
  modelUsage: Record<string, ModelUsage>
  totalCost?: number
  /** Assistant-only usage already recorded since this cumulative snapshot. */
  precounted?: Pick<AssistantMessage['usage'], 'input' | 'output' | 'cacheRead' | 'cacheWrite'>
}
type NativeUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}
const number = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
const empty = (): AssistantMessage['usage'] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
})
function nativeUsage(value: NativeUsage): AssistantMessage['usage'] {
  const usage = empty()
  usage.input = number(value.input_tokens)
  usage.output = number(value.output_tokens)
  usage.cacheRead = number(value.cache_read_input_tokens)
  usage.cacheWrite = number(value.cache_creation_input_tokens)
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  return usage
}
function modelUsage(value: ModelUsage): AssistantMessage['usage'] {
  const usage = nativeUsage({
    input_tokens: value.inputTokens,
    output_tokens: value.outputTokens,
    cache_read_input_tokens: value.cacheReadInputTokens,
    cache_creation_input_tokens: value.cacheCreationInputTokens
  })
  usage.cost.total = number(value.costUSD)
  if (value.thinkingTokens !== undefined) usage.reasoning = number(value.thinkingTokens)
  return usage
}
function add(target: AssistantMessage['usage'], delta: AssistantMessage['usage']): void {
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const)
    target[key] += delta[key]
  target.cost.total += delta.cost.total
  if (delta.reasoning !== undefined) target.reasoning = (target.reasoning ?? 0) + delta.reasoning
}
function sum(models: Record<string, ModelUsage>): AssistantMessage['usage'] {
  const total = empty()
  for (const model of Object.values(models)) add(total, modelUsage(model))
  return total
}
/** Result modelUsage/cost are session-cumulative; never sum whole resumed snapshots. */
export class ClaudeMetricsCollector {
  private readonly startedAt = Date.now()
  private total = empty()
  private measured = false
  private scope: ClaudeSubscriptionMetrics['usageScope']
  private baseline?: ClaudeUsageBaseline
  private fresh = false
  private readonly results = new Set<string>()
  private readonly settledAssistantIds = new Set<string>()
  private readonly pendingAssistants = new Map<string, AssistantMessage['usage']>()
  private latestContext?: ClaudeSubscriptionMetrics['context']
  private realModelName?: string
  constructor(resume?: string, baseline?: ClaudeUsageBaseline) {
    this.beginQuery(resume, baseline)
  }
  beginQuery(resume?: string, baseline = this.baseline): void {
    this.flushAssistants()
    this.fresh = !resume
    this.baseline = resume && baseline?.sessionId === resume ? structuredClone(baseline) : undefined
  }
  observe(message: SDKMessage): void {
    if (message.type === 'assistant' && !message.parent_tool_use_id && message.message.usage) {
      const assistantId = message.message.id || message.uuid
      if (this.settledAssistantIds.has(assistantId)) return
      const usage = nativeUsage(message.message.usage)
      const modelName = message.message.model || undefined
      if (modelName) this.realModelName = modelName
      this.latestContext = {
        input: usage.input,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        modelName
      }
      this.pendingAssistants.set(message.message.id || message.uuid, usage)
      this.updateCapacity()
    }
    if (message.type !== 'result') return
    const uuid = (message as { uuid?: string }).uuid
    const signature = uuid
      ? `${message.session_id}:${uuid}`
      : JSON.stringify([
          message.session_id,
          message.modelUsage,
          message.usage,
          message.total_cost_usd
        ])
    if (this.results.has(signature)) return
    this.results.add(signature)
    const models = message.modelUsage
    const current = models && Object.keys(models).length ? sum(models) : undefined
    const previous = this.baseline?.sessionId === message.session_id ? this.baseline : undefined
    let remainingCredit: ClaudeUsageBaseline['precounted']
    if (message.is_error && (!current || current.totalTokens === 0) && this.pendingAssistants.size) {
      // A crash result can be zeroed even after an actual model response.
      this.flushAssistants()
      return
    }
    if (current && (this.fresh || previous)) {
      const prior = previous ? sum(previous.modelUsage) : empty()
      // /clear starts a new cumulative ledger. Zeroed startup failures do not erase a baseline.
      const reset =
        current.totalTokens > 0 &&
        Boolean(previous) &&
        Object.entries(previous!.modelUsage).some(([name, value]) => {
          const now = models[name]
          if (!now) return true
          const old = modelUsage(value),
            next = modelUsage(now)
          return ['input', 'output', 'cacheRead', 'cacheWrite'].some(
            (key) => next[key as 'input'] < old[key as 'input']
          )
        })
      const delta = empty()
      for (const [name, value] of Object.entries(models)) {
        const currentModel = modelUsage(value),
          previousModel =
            !reset && previous?.modelUsage[name] ? modelUsage(previous.modelUsage[name]) : empty()
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const)
          delta[key] += Math.max(0, currentModel[key] - previousModel[key])
      }
      if (!reset && previous?.precounted) {
        remainingCredit = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
          remainingCredit[key] = Math.max(0, previous.precounted[key] - delta[key])
          delta[key] = Math.max(0, delta[key] - previous.precounted[key])
        }
      }
      delta.totalTokens = delta.input + delta.output + delta.cacheRead + delta.cacheWrite
      const currentCost =
        typeof message.total_cost_usd === 'number'
          ? number(message.total_cost_usd)
          : current.cost.total
      const previousCost = previous?.totalCost ?? prior.cost.total
      delta.cost.total = Math.max(0, currentCost - (reset ? 0 : previousCost))
      if (current.reasoning !== undefined)
        delta.reasoning = Math.max(0, current.reasoning - (reset ? 0 : (prior.reasoning ?? 0)))
      add(this.total, delta)
      this.measured = true
      this.scope ??= 'session-delta'
    } else if (message.usage && typeof message.usage.input_tokens === 'number') {
      add(this.total, nativeUsage(message.usage))
      this.measured = true
      this.scope = 'main-turn'
    } else this.flushAssistants()
    for (const id of this.pendingAssistants.keys()) this.settledAssistantIds.add(id)
    this.pendingAssistants.clear()
    if (!current) {
      this.baseline = undefined
      this.fresh = false
    }
    if (current && (current.totalTokens > 0 || !previous)) {
      this.baseline = {
        sessionId: message.session_id,
        modelUsage: structuredClone(models),
        ...(typeof message.total_cost_usd === 'number'
          ? { totalCost: number(message.total_cost_usd) }
          : {}),
        ...(remainingCredit ? { precounted: remainingCredit } : {})
      }
      this.fresh = false
    }
    this.updateCapacity()
  }
  private updateCapacity(): void {
    const name = this.latestContext?.modelName
    if (!name || !this.baseline) return
    const model =
      this.baseline.modelUsage[name] ??
      Object.values(this.baseline.modelUsage).find((item) => item.canonicalModel === name)
    if (model && number(model.contextWindow) > 0)
      this.latestContext!.contextWindow = model.contextWindow
  }
  private flushAssistants(): void {
    if (!this.pendingAssistants.size) return
    for (const [id, usage] of this.pendingAssistants) {
      add(this.total, usage)
      this.settledAssistantIds.add(id)
      if (this.baseline) {
        this.baseline.precounted ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const)
          this.baseline.precounted[key] += usage[key]
      }
    }
    this.pendingAssistants.clear()
    this.measured = true
    this.scope = 'assistant'
  }
  snapshot(): ClaudeUsageBaseline | undefined {
    return this.baseline ? structuredClone(this.baseline) : undefined
  }
  report(): ClaudeSubscriptionMetrics {
    this.flushAssistants()
    const totalResponseTimeMs = Math.max(0, Date.now() - this.startedAt)
    return {
      usage: this.measured ? structuredClone(this.total) : null,
      realModelName: this.realModelName,
      totalResponseTimeMs,
      ...(this.measured
        ? {
            totalTokensUsed: this.total.totalTokens,
            tokensPerSecond:
              totalResponseTimeMs > 0
                ? (this.total.output * 1000) / totalResponseTimeMs
                : undefined,
            usageScope: this.scope
          }
        : {}),
      ...(this.latestContext ? { context: { ...this.latestContext } } : {})
    }
  }
}

const MAX_EDIT_BYTES = 2 * 1024 * 1024
async function boundedText(path: string): Promise<string | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_EDIT_BYTES) return undefined
    const buffer = Buffer.alloc(MAX_EDIT_BYTES + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_EDIT_BYTES || buffer.subarray(0, bytesRead).includes(0)) return undefined
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? '' : undefined
  } finally {
    await file?.close()
  }
}
/** Only successful official file tools count; shell effects are deliberately unmeasured. */
export class ClaudeNativeEditCounter {
  private before = new Map<string, { path: string; text: string }>()
  private completed = new Set<string>()
  constructor(
    private readonly cwd: string,
    private readonly onLineEdits?: (lines: number) => void
  ) {}
  async start(id: string, toolName: string, input: unknown): Promise<void> {
    if (
      !['Write', 'Edit', 'MultiEdit'].includes(toolName) ||
      this.before.size >= 16 ||
      this.before.has(id) ||
      this.completed.has(id) ||
      !input ||
      typeof input !== 'object'
    )
      return
    const filePath = (input as { file_path?: unknown }).file_path
    if (typeof filePath !== 'string') return
    const path = resolve(this.cwd, filePath),
      text = await boundedText(path)
    if (text !== undefined) this.before.set(id, { path, text })
  }
  async success(id: string, response?: unknown): Promise<void> {
    if (this.completed.has(id)) return
    this.completed.add(id)
    const before = this.before.get(id)
    this.before.delete(id)
    if (
      !before ||
      (response && typeof response === 'object' && (response as { is_error?: boolean }).is_error)
    )
      return
    const after = await boundedText(before.path)
    if (after === undefined) return
    const lines = countLineEdits(before.text, after)
    if (lines > 0) this.onLineEdits?.(lines)
  }
  failure(id: string): void {
    this.before.delete(id)
    this.completed.add(id)
  }
}
