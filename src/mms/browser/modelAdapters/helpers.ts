import type { BrowserAction, BrowserPoint } from '../../../shared/browser/types'
import type { BrowserModelDecodeContext } from '../../../shared/browser/modelAdapters'
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

export function providerPoint(pointValue: BrowserPoint, coordinateSystem: 'screenshot-pixels-top-left' | 'viewport-pixels-top-left' | 'normalized-1000x1000', context: BrowserModelDecodeContext): BrowserPoint {
  const observation = context.observation
  if (!observation?.screenshot) throw new BrowserModelAdapterError('invalid_coordinate', 'Coordinate action requires the exact screenshot observation used for decoding')
  if (![observation.screenshot.pixelWidth, observation.screenshot.pixelHeight, observation.screenshot.cssToImageScaleX, observation.screenshot.cssToImageScaleY, observation.viewport.cssWidth, observation.viewport.cssHeight].every((value) => Number.isFinite(value) && value > 0)) throw new BrowserModelAdapterError('invalid_coordinate', 'Observation geometry is invalid')
  const css = coordinateSystem === 'screenshot-pixels-top-left'
    ? { x: pointValue.x / observation.screenshot.cssToImageScaleX + (observation.screenshot.cropOriginCss?.x ?? 0), y: pointValue.y / observation.screenshot.cssToImageScaleY + (observation.screenshot.cropOriginCss?.y ?? 0) }
    : coordinateSystem === 'viewport-pixels-top-left'
      ? pointValue
      : { x: pointValue.x / 1000 * observation.viewport.cssWidth, y: pointValue.y / 1000 * observation.viewport.cssHeight }
  const image = coordinateSystem === 'screenshot-pixels-top-left'
    ? pointValue
    : { x: Math.floor((css.x - (observation.screenshot.cropOriginCss?.x ?? 0)) * observation.screenshot.cssToImageScaleX), y: Math.floor((css.y - (observation.screenshot.cropOriginCss?.y ?? 0)) * observation.screenshot.cssToImageScaleY) }
  if (image.x < 0 || image.y < 0 || image.x >= observation.screenshot.pixelWidth || image.y >= observation.screenshot.pixelHeight) throw new BrowserModelAdapterError('invalid_coordinate', 'Provider coordinate is outside the exact screenshot bounds')
  return image
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

export function boundedArray(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new BrowserModelAdapterError('invalid_response', `${label} must be an array of at most ${max} items`)
  return value
}

export function dataUrl(value: string, label: string): { mediaType: string; data: string } {
  const match = /^data:([^;,]{1,128});base64,([A-Za-z0-9+/=]{1,16777216})$/.exec(value)
  if (!match) throw new BrowserModelAdapterError('invalid_result', `${label} must be a bounded base64 image data URL`)
  const mediaType = match[1].toLowerCase()
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mediaType)) throw new BrowserModelAdapterError('invalid_result', `${label} must use a supported raster image type`)
  return { mediaType, data: match[2] }
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
  continuation?: BrowserModelContinuation,
  encodeMany?: (call: BrowserModelCall, results: readonly BrowserModelActionResult[], continuation?: BrowserModelContinuation) => unknown
): Promise<BrowserModelExecutionResult> {
  const results: BrowserModelActionResult[] = []
  let stoppedBecause: BrowserModelExecutionResult['stoppedBecause']
  for (const item of call.actions) {
    if (signal?.aborted) {
      stoppedBecause = 'cancelled'
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
    ...(last && (encodeMany || encode) ? { encodedResult: encodeMany ? encodeMany(call, results, continuation) : encode!(call, last, continuation) } : {})
  }
}

export function actionClick(pointValue: BrowserPoint, button: 'left' | 'right' | 'middle' = 'left'): BrowserAction {
  return { type: 'click', target: { kind: 'image-point', point: pointValue }, button }
}
