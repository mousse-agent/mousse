import { createHash } from 'node:crypto'
import type { BrowserAction, BrowserObservation } from '../../../../src/shared/browser/types'
import { validateBrowserAction, validateBrowserWait } from '../../../../src/shared/browser/validation'
import type { CostRecord, DriverKind, EvaluationBudgets, ObservationMode } from './types'
import { UNAVAILABLE_COST } from './metrics'
import { PROMPT_ID } from './pin'

export const MAX_MODEL_SCREENSHOT_BYTES = 10 * 1024 * 1024

export interface ModelDriverRequest {
  taskId: string
  goal: string
  observation: BrowserObservation
  screenshot?: {
    mediaType: 'image/png'
    byteLength: number
    sha256: string
    bytesBase64: string
  }
  availableArtifacts?: Array<{
    artifactId: string
    displayName: string
    mediaType: string
    byteLength: number
  }>
  stepIndex: number
  promptId?: string
}

export function observationForModel(
  observation: BrowserObservation,
  mode: ObservationMode
): BrowserObservation {
  if (mode === 'hybrid') return observation
  if (mode === 'structured') return { ...observation, screenshot: undefined }
  if (!observation.screenshot) throw new Error('Screenshot-only model input requires a screenshot artifact')
  return {
    ...observation,
    url: '',
    title: '',
    tabs: [],
    elements: [],
    warnings: [],
    screenshot: observation.screenshot
  }
}

export type ModelDriverDecision =
  | { kind: 'act'; action: BrowserAction; expected?: { type: 'text'; text: string; present: boolean } }
  | { kind: 'stop'; reason: string }
  | { kind: 'unavailable'; reason: string }

export interface ModelDriver {
  readonly kind: DriverKind
  readonly modelId: string
  readonly revision: string
  readonly budgets: EvaluationBudgets
  decide(request: ModelDriverRequest): Promise<ModelDriverDecision>
  cost(): CostRecord
}

interface HttpModelDriverInput {
  endpoint: string
  modelId: string
  revision: string
  budgets: EvaluationBudgets
  promptId?: string
  fetchImpl?: typeof fetch
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} contains unsupported field ${key}`)
}

function parseDecision(value: unknown): ModelDriverDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Model response must be a JSON object')
  const body = value as Record<string, unknown>
  exactKeys(body, ['kind', 'action', 'expected', 'reason'], 'Model decision')
  if (body.kind === 'stop' || body.kind === 'unavailable') {
    if (typeof body.reason !== 'string' || !body.reason.trim()) throw new Error('Model stop/unavailable decision requires reason')
    exactKeys(body, ['kind', 'reason'], 'Model decision')
    return { kind: body.kind, reason: body.reason }
  }
  if (body.kind !== 'act' || !body.action || typeof body.action !== 'object' || Array.isArray(body.action)) throw new Error('Model decision kind must be act, stop, or unavailable')
  exactKeys(body, ['kind', 'action', 'expected'], 'Model decision')
  const action = validateBrowserAction(body.action)
  if (body.expected === undefined) return { kind: 'act', action }
  if (!body.expected || typeof body.expected !== 'object' || Array.isArray(body.expected)) throw new Error('Model expected state must be an object')
  const expected = validateBrowserWait(body.expected)
  if (expected.type !== 'text') throw new Error('Model expected state must be a text condition')
  return { kind: 'act', action, expected: { type: 'text', text: expected.text, present: expected.present } }
}

function validateScreenshot(request: ModelDriverRequest): void {
  const screenshot = request.screenshot
  if (Boolean(request.observation.screenshot) !== Boolean(screenshot)) throw new Error('Model screenshot bytes must accompany screenshot metadata')
  if (!screenshot) return
  if (screenshot.mediaType !== 'image/png' || !Number.isSafeInteger(screenshot.byteLength)
    || screenshot.byteLength < 33 || screenshot.byteLength > MAX_MODEL_SCREENSHOT_BYTES
    || !/^[a-f0-9]{64}$/.test(screenshot.sha256)
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(screenshot.bytesBase64)) throw new Error('Model screenshot payload is invalid or exceeds its byte bound')
  const bytes = Buffer.from(screenshot.bytesBase64, 'base64')
  if (bytes.byteLength !== screenshot.byteLength
    || createHash('sha256').update(bytes).digest('hex') !== screenshot.sha256
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('Model screenshot bytes do not match their PNG metadata')
  }
}

/**
 * Calls an injectable local/remote model endpoint. The endpoint returns a
 * strict JSON decision (or {decision,usage}); it never receives credentials
 * from this harness. This is the production-shaped path used by model runs,
 * while fixture-oracle runs remain explicitly separate.
 */
export function createHttpModelDriver(input: HttpModelDriverInput): ModelDriver {
  const fetchImpl = input.fetchImpl ?? fetch
  let calls = 0
  let tokenTotal = 0
  let imageTotal = 0
  let screenshotsSent = 0
  let usageComplete = true
  const startedAt = performance.now()
  return {
    kind: 'live-model',
    modelId: input.modelId,
    revision: input.revision,
    budgets: input.budgets,
    async decide(request) {
      validateScreenshot(request)
      if (calls >= input.budgets.maxActions || calls >= input.budgets.maxToolCalls) return { kind: 'stop', reason: 'model action budget exhausted' }
      if (request.screenshot && input.budgets.maxImages !== null && screenshotsSent >= input.budgets.maxImages) return { kind: 'stop', reason: 'model image budget exhausted' }
      const remainingMs = input.budgets.maxElapsedMs - (performance.now() - startedAt)
      if (remainingMs <= 0) return { kind: 'stop', reason: 'model elapsed-time budget exhausted' }
      calls += 1
      if (request.screenshot) screenshotsSent += 1
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.min(remainingMs, 120_000))
      try {
        const response = await fetchImpl(input.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            model: input.modelId,
            revision: input.revision,
            promptId: request.promptId ?? input.promptId ?? PROMPT_ID,
            budgets: input.budgets,
            taskId: request.taskId,
            goal: request.goal,
            stepIndex: request.stepIndex,
            observation: request.observation,
            ...(request.availableArtifacts?.length ? { availableArtifacts: request.availableArtifacts } : {}),
            ...(request.screenshot ? { screenshot: request.screenshot } : {})
          }),
          signal: controller.signal
        })
        if (!response.ok) throw new Error(`Model endpoint returned HTTP ${response.status}`)
        const envelope = await response.json() as unknown
        let decisionValue = envelope
        let usage: Record<string, unknown> | undefined
        if (envelope && typeof envelope === 'object' && !Array.isArray(envelope) && 'decision' in envelope) {
          const record = envelope as Record<string, unknown>
          exactKeys(record, ['decision', 'usage'], 'Model response')
          decisionValue = record.decision
          usage = record.usage as Record<string, unknown> | undefined
        }
        const decision = parseDecision(decisionValue)
        if (usage && typeof usage === 'object' && !Array.isArray(usage) && Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)) {
          exactKeys(usage, ['input_tokens', 'output_tokens', 'images'], 'Model usage')
          for (const [name, value] of Object.entries({
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            images: usage.images ?? 0
          })) {
            if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Model usage ${name} must be a non-negative integer`)
          }
          tokenTotal += Number(usage.input_tokens) + Number(usage.output_tokens)
          imageTotal += Number(usage.images ?? 0)
          if (input.budgets.maxTokens !== null && tokenTotal > input.budgets.maxTokens) {
            return { kind: 'stop', reason: 'model token budget exhausted' }
          }
          if (input.budgets.maxImages !== null && Math.max(imageTotal, screenshotsSent) > input.budgets.maxImages) {
            return { kind: 'stop', reason: 'model image budget exhausted' }
          }
        } else {
          usageComplete = false
          if (input.budgets.maxTokens !== null || input.budgets.maxImages !== null) {
            return { kind: 'stop', reason: 'model usage unavailable for bounded run' }
          }
        }
        if (performance.now() - startedAt > input.budgets.maxElapsedMs) {
          return { kind: 'stop', reason: 'model elapsed-time budget exhausted' }
        }
        return decision
      } finally {
        clearTimeout(timer)
      }
    },
    cost() {
      if (!calls || !usageComplete) return { ...UNAVAILABLE_COST, reason: 'Model endpoint did not provide complete token/image usage' }
      return { status: 'measured', tokens: tokenTotal, images: imageTotal, reason: 'Usage reported by injected model endpoint' }
    }
  }
}

export interface FixtureOracleStep {
  taskId: string
  steps: Array<(observation: BrowserObservation) => ModelDriverDecision>
}

/** Recorded policy. This is not a model and must never be labeled as live-model quality. */
export function createFixtureOracleDriver(input: {
  revision: string
  budgets: EvaluationBudgets
  policies: Map<string, Array<(observation: BrowserObservation) => ModelDriverDecision>>
}): ModelDriver {
  const counters = new Map<string, number>()
  return {
    kind: 'fixture-oracle',
    modelId: 'fixture-oracle',
    revision: input.revision,
    budgets: input.budgets,
    async decide(request) {
      const policy = input.policies.get(request.taskId)
      if (!policy) return { kind: 'unavailable', reason: `No fixture-oracle policy for ${request.taskId}` }
      const index = counters.get(request.taskId) ?? 0
      counters.set(request.taskId, index + 1)
      if (index >= policy.length) return { kind: 'stop', reason: 'fixture-oracle policy exhausted' }
      return policy[index](request.observation)
    },
    cost() {
      return {
        status: 'unavailable',
        tokens: null,
        images: null,
        reason: 'Fixture-oracle runs do not consume model tokens; cost is unknown, not zero'
      }
    }
  }
}

export function createLiveModelDriver(input: {
  modelId: string
  revision: string
  budgets: EvaluationBudgets
  acceptPaidCalls?: boolean
  endpoint?: string
}): ModelDriver {
  if (input.endpoint) return createHttpModelDriver({ endpoint: input.endpoint, modelId: input.modelId, revision: input.revision, budgets: input.budgets })
  return {
    kind: 'live-model',
    modelId: input.modelId,
    revision: input.revision,
    budgets: input.budgets,
    async decide() {
      return {
        kind: 'unavailable',
        reason: input.acceptPaidCalls
          ? `Live model ${input.modelId}@${input.revision} is wired as an interface only; this Q03 task does not place paid model calls`
          : 'Live-model mode refused: no credentials and no paid calls in Q03'
      }
    },
    cost() {
      return UNAVAILABLE_COST
    }
  }
}

export function assertDriverLabel(driver: ModelDriver, runKind: 'fixture-only' | 'live-model'): void {
  if (runKind === 'fixture-only' && driver.kind === 'live-model') {
    throw new Error('Fixture-only evaluation cannot use a live-model driver')
  }
  if (runKind === 'live-model' && driver.kind !== 'live-model') {
    throw new Error('Live-model evaluation cannot use a fixture-oracle driver')
  }
}
