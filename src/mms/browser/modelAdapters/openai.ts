import type { BrowserModelAdapter, BrowserModelAction, BrowserModelCall, BrowserModelRequest, BrowserModelActionResult, BrowserModelContinuation } from '../../../shared/browser/modelAdapters'
import { actionClick, BrowserModelAdapterError, normalizedPoint, numberValue, point, record, safety, stringValue } from './helpers'

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
      ...(input.previousResponseId ? { previous_response_id: input.previousResponseId } : {})
    }
  },
  decodeResponse(response: unknown): BrowserModelCall | undefined {
    const envelope = record(response)
    const output = envelope.output
    if (!Array.isArray(output)) throw new BrowserModelAdapterError('invalid_response', 'OpenAI response.output must be an array')
    const item = output.find((entry) => entry && typeof entry === 'object' && (entry as { type?: unknown }).type === 'computer_call')
    if (!item) return undefined
    const computer = record(item)
    const callId = stringValue(computer.call_id, 'computer_call.call_id')
    if (!Array.isArray(computer.actions)) throw new BrowserModelAdapterError('invalid_response', 'OpenAI computer_call.actions must be an array')
    const pending = Array.isArray(computer.pending_safety_checks) ? computer.pending_safety_checks.map((entry) => {
      const check = record(entry)
      return { decision: 'require_confirmation' as const, id: typeof check.id === 'string' ? check.id : undefined, code: typeof check.code === 'string' ? check.code : undefined, explanation: typeof check.message === 'string' ? check.message : 'OpenAI safety confirmation is required' }
    }) : []
    const actions = computer.actions.map((entry) => decodeAction(entry, pending[0]))
    const responseId = typeof envelope.id === 'string' ? envelope.id : undefined
    return {
      provider: 'openai', callId, actions, ...(responseId ? { responseId } : {}),
      continuation: { provider: 'openai', callId, ...(responseId ? { responseId } : {}), ...(pending.length ? { acknowledgedSafetyCheckIds: pending.flatMap((item) => item.id ? [item.id] : []) } : {}) },
      safetyDecisions: pending
    }
  },
  encodeResult(call: BrowserModelCall, result: BrowserModelActionResult, continuation?: BrowserModelContinuation): unknown {
    if (call.provider !== 'openai') throw new BrowserModelAdapterError('call_id_mismatch', 'OpenAI adapter received a different provider call')
    const acknowledged = continuation?.acknowledgedSafetyCheckIds ?? []
    return {
      type: 'computer_call_output',
      call_id: call.callId,
      output: {
        type: 'computer_screenshot',
        ...(result.screenshot?.dataUrl ? { image_url: result.screenshot.dataUrl } : {})
      },
      ...(acknowledged.length ? { acknowledged_safety_checks: acknowledged.map((id) => ({ id, code: 'acknowledged', message: 'Acknowledged by Mousse policy and user approval' })) } : {}),
      status: result.outcome === 'failed' || result.outcome === 'blocked' ? 'incomplete' : 'completed'
    }
  }
}

function decodeAction(value: unknown, pendingSafety?: ReturnType<typeof safety>): BrowserModelAction {
  const item = record(value)
  const type = stringValue(item.type, 'computer action type')
  const inherited = pendingSafety
  if (type === 'click') return { kind: 'action', action: actionClick(point({ x: numberValue(item.x, 'click.x'), y: numberValue(item.y, 'click.y') }), mapButton(item.button)), safety: inherited }
  if (type === 'double_click') return { kind: 'action', action: { type: 'double-click', target: { kind: 'image-point', point: point({ x: numberValue(item.x, 'double_click.x'), y: numberValue(item.y, 'double_click.y') }) } }, safety: inherited }
  if (type === 'drag') {
    if (!Array.isArray(item.path) || item.path.length < 2) throw new BrowserModelAdapterError('invalid_response', 'OpenAI drag.path must contain two or more points')
    return { kind: 'action', action: { type: 'drag', from: { kind: 'image-point', point: point(item.path[0], 'drag.path[0]') }, to: { kind: 'image-point', point: point(item.path[item.path.length - 1], 'drag.path[-1]') } }, safety: inherited }
  }
  if (type === 'keypress') return { kind: 'keypress', keys: arrayStrings(item.keys, 'keypress.keys'), safety: inherited }
  if (type === 'move') return { kind: 'action', action: { type: 'hover', target: { kind: 'image-point', point: point({ x: numberValue(item.x, 'move.x'), y: numberValue(item.y, 'move.y') }) } }, safety: inherited }
  if (type === 'scroll') return { kind: 'action', action: { type: 'scroll', target: { kind: 'image-point', point: point({ x: numberValue(item.x, 'scroll.x'), y: numberValue(item.y, 'scroll.y') }) }, deltaX: numberValue(item.scroll_x, 'scroll.scroll_x'), deltaY: numberValue(item.scroll_y, 'scroll.scroll_y') }, safety: inherited }
  if (type === 'type') return { kind: 'keyboard-type', text: stringValue(item.text, 'type.text'), safety: inherited }
  if (type === 'wait') return { kind: 'wait', seconds: 1, safety: inherited }
  if (type === 'screenshot') return { kind: 'screenshot', safety: inherited }
  throw new BrowserModelAdapterError('unsupported_action', `OpenAI computer action ${type} is not supported by the common executor`)
}

function mapButton(value: unknown): 'left' | 'right' | 'middle' {
  if (value === 'right') return 'right'
  if (value === 'wheel') return 'middle'
  return 'left'
}

function arrayStrings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32 || value.some((item) => typeof item !== 'string' || item.length > 64)) throw new BrowserModelAdapterError('invalid_response', `Invalid ${label}`)
  return value as string[]
}
