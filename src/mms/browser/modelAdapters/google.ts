import type { BrowserModelAdapter, BrowserModelAction, BrowserModelCall, BrowserModelRequest, BrowserModelActionResult, BrowserModelContinuation, BrowserModelDecodeContext } from '../../../shared/browser/modelAdapters'
import { actionClick, BrowserModelAdapterError, boundedArray, dataUrl, numberValue, point, providerPoint, record, safety, stringValue } from './helpers'

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
  decodeResponse(response: unknown, input: BrowserModelDecodeContext = {}): BrowserModelCall | undefined {
    const envelope = record(response)
    const steps = Array.isArray(envelope.steps) ? envelope.steps : Array.isArray(envelope.output) ? envelope.output : []
    if (steps.length > 32) throw new BrowserModelAdapterError('invalid_response', 'Gemini response contains too many steps')
    const calls = steps.filter((entry) => entry && typeof entry === 'object' && (entry as { type?: unknown }).type === 'function_call')
    if (calls.length === 0) return undefined
    const actions: BrowserModelAction[] = []
    const providerCalls: Array<{ callId: string; name?: string; actionStart: number; actionCount: number }> = []
    for (const entry of calls) {
      const step = record(entry)
      const callId = typeof step.id === 'string' ? step.id : typeof step.call_id === 'string' ? step.call_id : undefined
      if (!callId) throw new BrowserModelAdapterError('invalid_response', 'Gemini function_call.id is required')
      const name = stringValue(step.name, 'function_call.name')
      const actionStart = actions.length
      actions.push({ ...decodeCall(entry, input), providerCallId: callId, providerName: name })
      providerCalls.push({ callId, name, actionStart, actionCount: 1 })
    }
    const callId = providerCalls[0].callId
    return { provider: 'google', callId, actions, providerCalls, ...(typeof envelope.id === 'string' ? { responseId: envelope.id } : {}), continuation: { provider: 'google', callId, providerCallIds: providerCalls.map((item) => item.callId), ...(typeof envelope.id === 'string' ? { responseId: envelope.id } : {}) }, safetyDecisions: actions.flatMap((item) => item.safety ? [item.safety] : []) }
  },
  encodeResult(call: BrowserModelCall, result: BrowserModelActionResult, continuation?: BrowserModelContinuation): unknown {
    if (call.provider !== 'google' || continuation?.callId && continuation.callId !== call.callId) throw new BrowserModelAdapterError('call_id_mismatch', 'Gemini function result does not match function call')
    return encodeGeminiResult(call.callId, call.providerCalls?.[0]?.name ?? 'computer_use', result)
  },
  encodeResults(call, results, continuation): unknown {
    if (call.provider !== 'google') throw new BrowserModelAdapterError('call_id_mismatch', 'Gemini result received a different provider call')
    const calls = call.providerCalls ?? [{ callId: call.callId, name: 'computer_use', actionStart: 0, actionCount: 1 }]
    if (results.length > calls.length) throw new BrowserModelAdapterError('invalid_result', 'Too many Gemini results for function calls')
    return results.map((result, index) => encodeGeminiResult(calls[index].callId, calls[index].name ?? 'computer_use', result))
  }
}

function encodeGeminiResult(callId: string, name: string, result: BrowserModelActionResult): unknown {
    const resultParts: Array<Record<string, unknown>> = [{ type: 'text', text: JSON.stringify({ outcome: result.outcome, ...(result.message ? { message: result.message } : {}), ...(result.evidence ?? {}) }) }]
    if (result.screenshot?.dataUrl) {
      const image = dataUrl(result.screenshot.dataUrl, 'Gemini screenshot')
      resultParts.push({ type: 'image', data: image.data, mime_type: image.mediaType })
    }
    if (result.safetyAcknowledgement) resultParts.push({ type: 'text', text: JSON.stringify({ safety_acknowledgement: true }) })
    return { type: 'function_result', name, call_id: callId, result: resultParts }
}

function decodeCall(value: unknown, context: BrowserModelDecodeContext): BrowserModelAction {
  const step = record(value)
  const name = stringValue(step.name, 'function_call.name')
  const args = record(step.arguments)
  const providerSafety = safety(args.safety_decision)
  const coordinates = (): { x: number; y: number } => providerPoint({ x: numberValue(args.x, 'x'), y: numberValue(args.y, 'y') }, 'normalized-1000x1000', context)
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
