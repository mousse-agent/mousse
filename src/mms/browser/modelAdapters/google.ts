import type { BrowserModelAdapter, BrowserModelAction, BrowserModelCall, BrowserModelRequest, BrowserModelActionResult, BrowserModelContinuation } from '../../../shared/browser/modelAdapters'
import { actionClick, BrowserModelAdapterError, normalizedPoint, numberValue, point, record, safety, stringValue } from './helpers'

const ADAPTER_REVISION = 'm03-google-computer-use-interactions-v1'

export const googleComputerCapability = {
  provider: 'google' as const,
  model: 'gemini-3.8-flash',
  endpoint: 'interactions',
  tier: 'B3' as const,
  availability: 'experimental' as const,
  adapterRevision: ADAPTER_REVISION,
  browserRevision: 'managed-chromium-certified',
  testedAt: '2026-09-11',
  coordinateSystem: 'normalized-1000x1000' as const,
  supportsImages: true,
  supportsSemanticRefs: false,
  supportsOrderedBatches: true,
  supportsSafetyDecisions: true,
  limitations: [
    'Coordinates are normalized to a 1000 by 1000 viewport and are scaled only with the host supplied viewport.',
    'Gemini 3.x uses the Interactions API function_call/function_result loop; legacy 2.5 names are decoded for compatibility but not advertised as qualified.',
    'This adapter has deterministic schema conformance only; no live provider qualification is claimed.'
  ] as const
}

export const googleComputerAdapter: BrowserModelAdapter = {
  capability: googleComputerCapability,
  buildRequest(input: BrowserModelRequest): unknown {
    return {
      model: input.model,
      input: input.prompt,
      tools: [{ type: 'computer_use', environment: 'browser', ...(input.enablePromptInjectionDetection === undefined ? {} : { enable_prompt_injection_detection: input.enablePromptInjectionDetection }) }],
      ...(input.continuation?.responseId ? { previous_interaction_id: input.continuation.responseId } : {})
    }
  },
  decodeResponse(response: unknown, input): BrowserModelCall | undefined {
    const envelope = record(response)
    const steps = Array.isArray(envelope.steps) ? envelope.steps : Array.isArray(envelope.output) ? envelope.output : []
    const calls = steps.filter((entry) => entry && typeof entry === 'object' && (entry as { type?: unknown }).type === 'function_call')
    if (calls.length === 0) return undefined
    const actions = calls.map((entry) => decodeCall(entry, input?.viewport))
    const first = record(calls[0])
    const callId = typeof first.id === 'string' ? first.id : typeof first.call_id === 'string' ? first.call_id : `gemini-call-${String(envelope.id ?? 'unknown')}`
    return { provider: 'google', callId, actions, ...(typeof envelope.id === 'string' ? { responseId: envelope.id } : {}), continuation: { provider: 'google', callId, ...(typeof envelope.id === 'string' ? { responseId: envelope.id } : {}) }, safetyDecisions: actions.flatMap((item) => item.safety ? [item.safety] : []) }
  },
  encodeResult(call: BrowserModelCall, result: BrowserModelActionResult, continuation?: BrowserModelContinuation): unknown {
    if (call.provider !== 'google' || continuation?.callId && continuation.callId !== call.callId) throw new BrowserModelAdapterError('call_id_mismatch', 'Gemini function result does not match function call')
    const resultParts: Array<Record<string, unknown>> = [{ type: 'text', text: JSON.stringify({ outcome: result.outcome, ...(result.message ? { message: result.message } : {}), ...(result.evidence ?? {}) }) }]
    if (result.screenshot?.dataUrl) {
      const match = /^data:([^;]+);base64,(.+)$/.exec(result.screenshot.dataUrl)
      if (!match) throw new BrowserModelAdapterError('invalid_result', 'Gemini screenshots must be data URLs with base64 content')
      resultParts.push({ type: 'image', data: match[2], mime_type: match[1] })
    }
    if (result.safetyAcknowledgement) resultParts.push({ type: 'text', text: JSON.stringify({ safety_acknowledgement: true }) })
    return { type: 'function_result', name: 'computer_use', call_id: call.callId, result: resultParts }
  }
}

function decodeCall(value: unknown, viewport?: { width: number; height: number }): BrowserModelAction {
  const step = record(value)
  const name = stringValue(step.name, 'function_call.name')
  const args = record(step.arguments)
  const providerSafety = safety(args.safety_decision)
  const coordinates = (): { x: number; y: number } => normalizedPoint(args.x, args.y, viewport)
  if (name === 'open_web_browser' || name === 'open_app') return { kind: 'screenshot', safety: providerSafety }
  if (name === 'click' || name === 'click_at') return { kind: 'action', action: actionClick(coordinates()), intent: optionalString(args.intent), safety: providerSafety }
  if (name === 'double_click') return { kind: 'action', action: { type: 'double-click', target: { kind: 'image-point', point: coordinates() } }, intent: optionalString(args.intent), safety: providerSafety }
  if (name === 'right_click') return { kind: 'action', action: actionClick(coordinates(), 'right'), intent: optionalString(args.intent), safety: providerSafety }
  if (name === 'middle_click') return { kind: 'action', action: actionClick(coordinates(), 'middle'), intent: optionalString(args.intent), safety: providerSafety }
  if (name === 'move' || name === 'hover_at') return { kind: 'action', action: { type: 'hover', target: { kind: 'image-point', point: coordinates() } }, intent: optionalString(args.intent), safety: providerSafety }
  if (name === 'type' || name === 'type_text_at') return { kind: 'keyboard-type', text: stringValue(args.text, 'function_call.text'), ...(args.x !== undefined && args.y !== undefined ? { target: { kind: 'image-point' as const, point: coordinates() } } : {}), pressEnter: args.press_enter === true, intent: optionalString(args.intent), safety: providerSafety }
  if (name === 'key' || name === 'press_key') return { kind: 'keypress', keys: [stringValue(args.key ?? args.text, 'function_call.key')], intent: optionalString(args.intent), safety: providerSafety }
  if (name === 'scroll_document') return { kind: 'action', action: { type: 'scroll', deltaX: 0, deltaY: numberValue(args.amount ?? args.delta_y ?? 500, 'scroll amount') }, intent: optionalString(args.intent), safety: providerSafety }
  if (name === 'scroll_at') return { kind: 'action', action: { type: 'scroll', target: { kind: 'image-point', point: coordinates() }, deltaX: numberValue(args.delta_x ?? 0, 'scroll_at.delta_x'), deltaY: numberValue(args.delta_y ?? 0, 'scroll_at.delta_y') }, intent: optionalString(args.intent), safety: providerSafety }
  if (name === 'navigate') return { kind: 'action', action: { type: 'navigate', url: stringValue(args.url, 'navigate.url') }, intent: optionalString(args.intent), safety: providerSafety }
  if (name === 'go_back') return { kind: 'action', action: { type: 'back' }, intent: optionalString(args.intent), safety: providerSafety }
  if (name === 'go_forward') return { kind: 'action', action: { type: 'forward' }, intent: optionalString(args.intent), safety: providerSafety }
  if (name === 'wait' || name === 'wait_5_seconds') return { kind: 'wait', seconds: name === 'wait_5_seconds' ? 5 : optionalNumber(args.seconds) ?? 1, intent: optionalString(args.intent), safety: providerSafety }
  throw new BrowserModelAdapterError('unsupported_action', `Gemini computer action ${name} is not supported by the common executor`)
}

function optionalString(value: unknown): string | undefined { return typeof value === 'string' ? value.slice(0, 4096) : undefined }
function optionalNumber(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }
