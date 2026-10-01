import type { BrowserModelAdapter, BrowserModelAction, BrowserModelCall, BrowserModelRequest, BrowserModelActionResult, BrowserModelContinuation, BrowserModelDecodeContext } from '../../../shared/browser/modelAdapters'
import { actionClick, BrowserModelAdapterError, boundedArray, dataUrl, numberValue, point, providerPoint, record, safety, stringValue } from './helpers'

const ADAPTER_REVISION = 'm03-openai-responses-computer-preview-v1'

export const openAiComputerCapability = {
  provider: 'openai' as const,
  model: 'computer-use-preview',
  endpoint: 'responses',
  tier: 'B3' as const,
  availability: 'experimental' as const,
  adapterRevision: ADAPTER_REVISION,
  browserRevision: 'managed-chromium-certified',
  testedAt: '2026-09-11',
  coordinateSystem: 'screenshot-pixels-top-left' as const,
  supportsImages: true,
  supportsSemanticRefs: false,
  supportsOrderedBatches: true,
  supportsSafetyDecisions: true,
  limitations: [
    'Provider-native coordinates are screenshot pixels and must be tied to the exact screenshot observation by the host.',
    'The generated computer_call is a request; the host must execute every action and return a fresh screenshot.',
    'This adapter has deterministic schema conformance only; no live provider qualification is claimed.'
  ] as const
}

export const openAiComputerAdapter: BrowserModelAdapter = {
  capability: openAiComputerCapability,
  buildRequest(input: BrowserModelRequest): unknown {
    const viewport = input.viewport ?? { width: 1280, height: 720 }
    return {
      model: input.model,
      input: input.prompt,
      tools: [{ type: 'computer-preview', environment: 'browser', display_width: viewport.width, display_height: viewport.height }],
      ...((input.previousResponseId ?? input.continuation?.responseId) ? { previous_response_id: input.previousResponseId ?? input.continuation?.responseId } : {})
    }
  },
  decodeResponse(response: unknown, context: BrowserModelDecodeContext = {}): BrowserModelCall | undefined {
    const envelope = record(response)
    const output = envelope.output
    if (!Array.isArray(output)) throw new BrowserModelAdapterError('invalid_response', 'OpenAI response.output must be an array')
    if (output.length > 64) throw new BrowserModelAdapterError('invalid_response', 'OpenAI response.output is too large')
    const items = output.filter((entry) => entry && typeof entry === 'object' && (entry as { type?: unknown }).type === 'computer_call')
    if (items.length === 0) return undefined
    if (items.length > 16) throw new BrowserModelAdapterError('invalid_response', 'OpenAI response contains too many computer calls')
    const providerCalls = [] as Array<{ callId: string; actionStart: number; actionCount: number }>
    const callIds = new Set<string>()
    const actions: BrowserModelAction[] = []
    const safetyDecisions = [] as NonNullable<ReturnType<typeof safety>>[]
    for (const item of items) {
      const computer = record(item)
      const callId = stringValue(computer.call_id, 'computer_call.call_id')
      if (callIds.has(callId)) throw new BrowserModelAdapterError('invalid_response', 'OpenAI computer call IDs must be unique')
      callIds.add(callId)
      const pending = computer.pending_safety_checks === undefined ? [] : boundedArray(computer.pending_safety_checks, 'OpenAI pending_safety_checks', 16).map((entry) => {
        const check = record(entry)
        const id = stringValue(check.id, 'OpenAI safety check id')
        const code = stringValue(check.code, 'OpenAI safety check code')
        const message = stringValue(check.message, 'OpenAI safety check message')
        return { decision: 'require_confirmation' as const, id, code, explanation: message }
      })
      safetyDecisions.push(...pending)
      const actionStart = actions.length
      actions.push(decodeAction(computer.action, pending[0], context, callId))
      providerCalls.push({ callId, actionStart, actionCount: 1 })
    }
    const responseId = typeof envelope.id === 'string' ? envelope.id : undefined
    return {
      provider: 'openai', callId: providerCalls[0].callId, actions, providerCalls, ...(responseId ? { responseId } : {}),
      continuation: { provider: 'openai', callId: providerCalls[0].callId, ...(responseId ? { responseId } : {}), providerCallIds: providerCalls.map((item) => item.callId) },
      safetyDecisions
    }
  },
  encodeResult(call: BrowserModelCall, result: BrowserModelActionResult, continuation?: BrowserModelContinuation): unknown {
    if (call.provider !== 'openai' || continuation && (continuation.provider !== 'openai' || continuation.callId !== call.callId)) throw new BrowserModelAdapterError('call_id_mismatch', 'OpenAI adapter received a different provider call')
    return encodeOpenAiResult(call.callId, call, result, continuation)
  },
  encodeResults(call, results, continuation): unknown {
    if (call.provider !== 'openai' || continuation && (continuation.provider !== 'openai' || continuation.callId !== call.callId)) throw new BrowserModelAdapterError('call_id_mismatch', 'OpenAI result does not match the computer call')
    const calls = call.providerCalls ?? [{ callId: call.callId, actionStart: 0, actionCount: call.actions.length }]
    if (results.length === 0) throw new BrowserModelAdapterError('invalid_result', 'Cannot encode an empty OpenAI result')
    if (results.length > calls.length) throw new BrowserModelAdapterError('invalid_result', 'Too many OpenAI results for computer calls')
    const encoded = results.map((result, index) => encodeOpenAiResult(calls[index].callId, call, result, continuation))
    return encoded.length === 1 ? encoded[0] : encoded
  }
}

function decodeAction(value: unknown, pendingSafety: ReturnType<typeof safety>, context: BrowserModelDecodeContext, providerCallId: string): BrowserModelAction {
  const item = record(value)
  const type = stringValue(item.type, 'computer action type')
  const inherited = pendingSafety
  if (type === 'click') {
    const button = item.button
    if (button === 'back' || button === 'forward') return { kind: 'action', providerCallId, action: { type: button }, safety: inherited }
    return { kind: 'action', providerCallId, action: actionClick(providerPoint(point({ x: numberValue(item.x, 'click.x'), y: numberValue(item.y, 'click.y') }), 'screenshot-pixels-top-left', context), mapButton(button)), safety: inherited }
  }
  if (type === 'double_click') return { kind: 'action', providerCallId, action: { type: 'double-click', target: { kind: 'image-point', point: providerPoint(point({ x: numberValue(item.x, 'double_click.x'), y: numberValue(item.y, 'double_click.y') }), 'screenshot-pixels-top-left', context) } }, safety: inherited }
  if (type === 'drag') {
    if (!Array.isArray(item.path) || item.path.length < 2) throw new BrowserModelAdapterError('invalid_response', 'OpenAI drag.path must contain two or more points')
    return { kind: 'action', providerCallId, action: { type: 'drag', from: { kind: 'image-point', point: providerPoint(point(item.path[0], 'drag.path[0]'), 'screenshot-pixels-top-left', context) }, to: { kind: 'image-point', point: providerPoint(point(item.path[item.path.length - 1], 'drag.path[-1]'), 'screenshot-pixels-top-left', context) } }, safety: inherited }
  }
  if (type === 'keypress') return { kind: 'keypress', providerCallId, keys: arrayStrings(item.keys, 'keypress.keys'), safety: inherited }
  if (type === 'move') return { kind: 'action', providerCallId, action: { type: 'hover', target: { kind: 'image-point', point: providerPoint(point({ x: numberValue(item.x, 'move.x'), y: numberValue(item.y, 'move.y') }), 'screenshot-pixels-top-left', context) } }, safety: inherited }
  if (type === 'scroll') return { kind: 'action', providerCallId, action: { type: 'scroll', target: { kind: 'image-point', point: providerPoint(point({ x: numberValue(item.x, 'scroll.x'), y: numberValue(item.y, 'scroll.y') }), 'screenshot-pixels-top-left', context) }, deltaX: numberValue(item.scroll_x, 'scroll.scroll_x'), deltaY: numberValue(item.scroll_y, 'scroll.scroll_y') }, safety: inherited }
  if (type === 'type') return { kind: 'keyboard-type', providerCallId, text: stringValue(item.text, 'type.text'), safety: inherited }
  if (type === 'wait') return { kind: 'wait', providerCallId, seconds: 1, safety: inherited }
  if (type === 'screenshot') return { kind: 'screenshot', providerCallId, safety: inherited }
  throw new BrowserModelAdapterError('unsupported_action', `OpenAI computer action ${type} is not supported by the common executor`)
}

function encodeOpenAiResult(callId: string, call: BrowserModelCall, result: BrowserModelActionResult, continuation?: BrowserModelContinuation): unknown {
  const acknowledged = continuation?.acknowledgedSafetyCheckIds ?? []
  const checks = call.safetyDecisions.filter((item) => item.id && acknowledged.includes(item.id)).map((item) => ({ id: item.id!, code: item.code ?? 'acknowledged', message: item.explanation ?? 'Acknowledged by Mousse policy and user approval' }))
  const image = result.screenshot?.dataUrl ? { image_url: result.screenshot.dataUrl, ...dataUrl(result.screenshot.dataUrl, 'OpenAI screenshot') } : undefined
  return {
    type: 'computer_call_output', call_id: callId,
    output: { type: 'computer_screenshot', ...(image ? { image_url: image.image_url } : {}) },
    ...(checks.length ? { acknowledged_safety_checks: checks } : {}),
    status: result.outcome === 'failed' || result.outcome === 'blocked' ? 'incomplete' : 'completed'
  }
}

function mapButton(value: unknown): 'left' | 'right' | 'middle' {
  if (value === 'left') return 'left'
  if (value === 'right') return 'right'
  if (value === 'wheel') return 'middle'
  throw new BrowserModelAdapterError('invalid_response', 'Invalid OpenAI click button')
}

function arrayStrings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32 || value.some((item) => typeof item !== 'string' || item.length > 64)) throw new BrowserModelAdapterError('invalid_response', `Invalid ${label}`)
  return value as string[]
}
