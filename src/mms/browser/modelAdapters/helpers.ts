import type { BrowserAction, BrowserPoint } from '../../../shared/browser/types'
import type {
  BrowserModelAction,
  BrowserModelActionResult,
  BrowserModelCall,
  BrowserModelContinuation,
  BrowserModelExecutionResult,
  BrowserModelExecutor,
  BrowserModelSafetyDecision
} from '../../../shared/browser/modelAdapters'

export class BrowserModelAdapterError extends Error {
  readonly code: 'invalid_response' | 'unsupported_action' | 'call_id_mismatch' | 'invalid_coordinate' | 'invalid_result'
  constructor(code: BrowserModelAdapterError['code'], message: string) {
    super(message)
    this.name = 'BrowserModelAdapterError'
    this.code = code
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrowserModelAdapterError('invalid_response', 'Provider envelope must be an object')
  return value as Record<string, unknown>
}

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) throw new BrowserModelAdapterError('invalid_response', `Invalid ${label}`)
  return value
}

export function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new BrowserModelAdapterError('invalid_response', `Invalid ${label}`)
  return value
}

export function point(value: unknown, label = 'coordinate'): BrowserPoint {
  if (Array.isArray(value) && value.length === 2) return { x: numberValue(value[0], `${label}[0]`), y: numberValue(value[1], `${label}[1]`) }
  const item = record(value)
  return { x: numberValue(item.x, `${label}.x`), y: numberValue(item.y, `${label}.y`) }
}

export function normalizedPoint(x: unknown, y: unknown, viewport?: { width: number; height: number }): BrowserPoint {
  const nx = numberValue(x, 'x')
  const ny = numberValue(y, 'y')
  if (nx < 0 || nx > 1000 || ny < 0 || ny > 1000) throw new BrowserModelAdapterError('invalid_coordinate', 'Normalized coordinates must be between 0 and 1000')
  const width = viewport?.width ?? 1000
  const height = viewport?.height ?? 1000
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new BrowserModelAdapterError('invalid_coordinate', 'Viewport dimensions must be positive')
  return { x: Math.floor(nx / 1000 * width), y: Math.floor(ny / 1000 * height) }
}

export function safety(value: unknown): BrowserModelSafetyDecision | undefined {
  if (value === undefined) return undefined
  const item = record(value)
  const decision = item.decision
  if (decision !== 'allow' && decision !== 'require_confirmation' && decision !== 'block') throw new BrowserModelAdapterError('invalid_response', 'Invalid provider safety decision')
  return {
    decision,
    ...(typeof item.explanation === 'string' ? { explanation: item.explanation.slice(0, 4096) } : {}),
    ...(typeof item.id === 'string' ? { id: item.id } : {}),
    ...(typeof item.code === 'string' ? { code: item.code } : {})
  }
}

export function action(kind: BrowserModelAction['kind'], value: Omit<BrowserModelAction, 'kind'>): BrowserModelAction {
  return { kind, ...value } as BrowserModelAction
}

export function validateResult(result: BrowserModelActionResult): BrowserModelActionResult {
  if (!result || typeof result !== 'object') throw new BrowserModelAdapterError('invalid_result', 'Executor returned an invalid result')
  if (!['verified', 'unverified', 'blocked', 'failed', 'unknown-effect'].includes(result.outcome)) throw new BrowserModelAdapterError('invalid_result', 'Executor returned an invalid outcome')
  return result
}

export async function executeOrderedCall(
  call: BrowserModelCall,
  request: unknown,
  response: unknown,
  executor: BrowserModelExecutor,
  signal?: AbortSignal,
  encode?: (call: BrowserModelCall, result: BrowserModelActionResult, continuation?: BrowserModelContinuation) => unknown,
  continuation?: BrowserModelContinuation
): Promise<BrowserModelExecutionResult> {
  const results: BrowserModelActionResult[] = []
  let stoppedBecause: BrowserModelExecutionResult['stoppedBecause']
  for (const item of call.actions) {
    if (signal?.aborted) {
      stoppedBecause = 'cancelled'
      results.push({ outcome: 'unknown-effect', message: 'Browser model call cancelled before the next action' })
      break
    }
    const decision = item.safety
    if (decision?.decision === 'block' || decision?.decision === 'require_confirmation') {
      stoppedBecause = 'approval'
      results.push({ outcome: 'blocked', message: decision.explanation ?? 'Provider safety confirmation is required' })
      break
    }
    const result = validateResult(await executor(item, signal))
    results.push(result)
    if (result.outcome === 'failed') { stoppedBecause = 'failure'; break }
    if (result.outcome === 'unknown-effect') { stoppedBecause = 'unknown-effect'; break }
    if (result.outcome === 'blocked') { stoppedBecause = 'approval'; break }
  }
  const last = results.at(-1)
  return {
    call,
    results,
    request,
    response,
    stoppedBecause,
    ...(last && encode ? { encodedResult: encode(call, last, continuation) } : {})
  }
}

export function actionClick(pointValue: BrowserPoint, button: 'left' | 'right' | 'middle' = 'left'): BrowserAction {
  return { type: 'click', target: { kind: 'image-point', point: pointValue }, button }
}
