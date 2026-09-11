import type { BrowserModelAdapter, BrowserModelAction, BrowserModelCall, BrowserModelRequest, BrowserModelActionResult, BrowserModelContinuation, BrowserModelDecodeContext } from '../../../shared/browser/modelAdapters'
import { BrowserModelAdapterError, actionClick, boundedArray, dataUrl, numberValue, point, providerPoint, record, stringValue } from './helpers'

const ADAPTER_REVISION = 'm03-anthropic-computer-20251124-v1'

export const anthropicComputerCapability = {
  provider: 'anthropic' as const,
  model: 'claude-sonnet-4-6',
  endpoint: 'messages.beta',
  tier: 'B3' as const,
  availability: 'experimental' as const,
  adapterRevision: ADAPTER_REVISION,
  browserRevision: 'managed-chromium-certified',
  testedAt: '2026-09-11',
  coordinateSystem: 'viewport-pixels-top-left' as const,
  supportsImages: true,
  supportsSemanticRefs: false,
  supportsOrderedBatches: false,
  supportsSafetyDecisions: false,
  limitations: [
    'The installed SDK exposes computer_20251124 through its beta messages types; this adapter emits that versioned tool shape.',
    'Anthropic coordinates are viewport pixels. The host must map them to the exact observation viewport and apply policy.',
    'Anthropic computer tool calls are executed one tool_use at a time; no live provider qualification is claimed.'
  ] as const
}

export const anthropicComputerAdapter: BrowserModelAdapter = {
  capability: anthropicComputerCapability,
  buildRequest(input: BrowserModelRequest): unknown {
    const viewport = input.viewport ?? { width: 1280, height: 720 }
    return {
      model: input.model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: input.prompt }],
      tools: [{ type: 'computer_20251124', name: 'computer', display_width_px: viewport.width, display_height_px: viewport.height }]
    }
  },
  decodeResponse(response: unknown, context: BrowserModelDecodeContext = {}): BrowserModelCall | undefined {
    const envelope = record(response)
    if (!Array.isArray(envelope.content)) throw new BrowserModelAdapterError('invalid_response', 'Anthropic response.content must be an array')
    const toolUses = boundedArray(envelope.content, 'Anthropic response.content', 64).filter((entry) => entry && typeof entry === 'object' && (entry as { type?: unknown }).type === 'tool_use')
    if (toolUses.length === 0) return undefined
    const actions: BrowserModelAction[] = []
    const providerCalls: Array<{ callId: string; name?: string; actionStart: number; actionCount: number }> = []
    for (const toolUse of toolUses) {
      const block = record(toolUse)
      if (block.name !== 'computer') throw new BrowserModelAdapterError('unsupported_action', 'Anthropic response requested a non-computer tool')
      const callId = stringValue(block.id, 'tool_use.id')
      const actionStart = actions.length
      actions.push({ ...decodeInput(record(block.input), context), providerCallId: callId, providerName: 'computer' })
      providerCalls.push({ callId, name: 'computer', actionStart, actionCount: 1 })
    }
    return { provider: 'anthropic', callId: providerCalls[0].callId, actions, providerCalls, continuation: { provider: 'anthropic', callId: providerCalls[0].callId, providerCallIds: providerCalls.map((item) => item.callId) }, safetyDecisions: [] }
  },
  encodeResult(call: BrowserModelCall, result: BrowserModelActionResult, continuation?: BrowserModelContinuation): unknown {
    if (call.provider !== 'anthropic' || continuation?.callId && continuation.callId !== call.callId) throw new BrowserModelAdapterError('call_id_mismatch', 'Anthropic tool result does not match tool_use')
    const content = result.screenshot?.dataUrl ? [imageBlock(result.screenshot.dataUrl)] : [{ type: 'text', text: result.message ?? result.outcome }]
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: call.callId, content, ...(result.outcome === 'failed' || result.outcome === 'blocked' ? { is_error: true } : {}) }]
    }
  },
  encodeResults(call, results, continuation): unknown {
    const calls = call.providerCalls ?? [{ callId: call.callId, name: 'computer', actionStart: 0, actionCount: 1 }]
    if (results.length > calls.length) throw new BrowserModelAdapterError('invalid_result', 'Too many Anthropic results for tool uses')
    const toolResults = results.map((result, index) => {
      const item = calls[index]
      const content = result.screenshot?.dataUrl ? [imageBlock(result.screenshot.dataUrl)] : [{ type: 'text', text: result.message ?? result.outcome }]
      return { type: 'tool_result', tool_use_id: item.callId, content, ...(result.outcome === 'failed' || result.outcome === 'blocked' ? { is_error: true } : {}) }
    })
    return { role: 'user', content: toolResults }
  }
}

function decodeInput(input: Record<string, unknown>, context: BrowserModelDecodeContext): BrowserModelAction {
  const action = stringValue(input.action, 'computer.action')
  if (action === 'screenshot') return { kind: 'screenshot' }
  if (action === 'left_click' || action === 'right_click' || action === 'middle_click' || action === 'double_click') {
    const coordinate = providerPoint(point(input.coordinate, 'computer.coordinate'), 'viewport-pixels-top-left', context)
    const button = action === 'right_click' ? 'right' : action === 'middle_click' ? 'middle' : 'left'
    return { kind: 'action', action: action === 'double_click' ? { type: 'double-click', target: { kind: 'image-point', point: coordinate } } : actionClick(coordinate, button) }
  }
  if (action === 'type') {
    const text = stringValue(input.text, 'computer.text')
    const target = input.coordinate === undefined ? undefined : { kind: 'image-point' as const, point: providerPoint(point(input.coordinate, 'computer.coordinate'), 'viewport-pixels-top-left', context) }
    return { kind: 'keyboard-type', text, ...(target ? { target } : {}) }
  }
  if (action === 'key') return { kind: 'keypress', keys: [stringValue(input.text, 'computer.text')] }
  if (action === 'mouse_move') return { kind: 'action', action: { type: 'hover', target: { kind: 'image-point', point: providerPoint(point(input.coordinate, 'computer.coordinate'), 'viewport-pixels-top-left', context) } } }
  if (action === 'left_click_drag') return { kind: 'action', action: { type: 'drag', from: { kind: 'image-point', point: providerPoint(point(input.start_coordinate, 'computer.start_coordinate'), 'viewport-pixels-top-left', context) }, to: { kind: 'image-point', point: providerPoint(point(input.coordinate, 'computer.coordinate'), 'viewport-pixels-top-left', context) } } }
  if (action === 'scroll') {
    const direction = stringValue(input.scroll_direction, 'computer.scroll_direction')
    const amount = input.scroll_amount === undefined ? 500 : numberValue(input.scroll_amount, 'computer.scroll_amount')
    const delta = direction === 'up' ? -amount : direction === 'down' ? amount : 0
    const horizontal = direction === 'left' ? -amount : direction === 'right' ? amount : 0
    return { kind: 'action', action: { type: 'scroll', deltaX: horizontal, deltaY: delta } }
  }
  if (action === 'wait') return { kind: 'wait', seconds: 1 }
  if (action === 'zoom') return { kind: 'screenshot', intent: 'Zoom was requested; host must provide a bounded crop or reject it.' }
  throw new BrowserModelAdapterError('unsupported_action', `Anthropic computer action ${action} is not supported by the common executor`)
}

function imageBlock(dataUrl: string): { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } {
  const image = dataUrlValue(dataUrl)
  return { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } }
}

function dataUrlValue(value: string): { mediaType: string; data: string } { return dataUrl(value, 'Anthropic screenshot') }
