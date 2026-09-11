import type { BrowserAction, BrowserObservation, BrowserTarget } from '../../../../../src/shared/browser/types'
import { elementImagePoint, findElement } from '../observations'
import type { ObservationMode } from '../types'
import type { BrowserGymObservation, ParsedBrowserGymCall } from './protocol'
import { BROWSERGYM_OBSERVATION_KEYS } from './protocol'
import { assertKnownAction } from './parse'

export type MappedBrowserGymOp =
  | { kind: 'act'; action: BrowserAction }
  | { kind: 'tabs'; operation: 'new' | 'close' | 'switch'; url?: string; index?: number }
  | { kind: 'stop'; text: string }
  | { kind: 'infeasible'; reason: string }
  | { kind: 'noop'; waitMs: number }
  | { kind: 'unsupported'; reason: string; name: string }

function bidTarget(observation: BrowserObservation, bid: unknown, mode: ObservationMode, role?: string): BrowserTarget {
  if (typeof bid !== 'string' || !bid) throw new Error('BrowserGym bid must be a string')
  const byRef = observation.elements.find((element) => element.ref === bid)
  if (byRef) {
    if (mode === 'screenshot') return { kind: 'image-point', point: elementImagePoint(observation, byRef) }
    return { kind: 'ref', ref: byRef.ref }
  }
  const named = findElement(observation, { name: bid, role })
  if (mode === 'screenshot') return { kind: 'image-point', point: elementImagePoint(observation, named) }
  return { kind: 'ref', ref: named.ref }
}

function button(value: unknown): 'left' | 'right' | 'middle' | undefined {
  if (value === undefined) return undefined
  if (value === 'left' || value === 'right' || value === 'middle') return value
  throw new Error(`Unsupported BrowserGym mouse button ${String(value)}`)
}

export function mapBrowserGymCall(call: ParsedBrowserGymCall, observation: BrowserObservation, mode: ObservationMode): MappedBrowserGymOp {
  assertKnownAction(call)
  const a = call.args
  const k = call.kwargs
  switch (call.name) {
    case 'click':
      if (k.modifiers && Array.isArray(k.modifiers) && k.modifiers.length) return { kind: 'unsupported', name: call.name, reason: 'Mousse click has no modifier keys' }
      return { kind: 'act', action: { type: 'click', target: bidTarget(observation, a[0], mode), ...(button(k.button ?? a[1]) ? { button: button(k.button ?? a[1]) } : {}) } }
    case 'dblclick':
      return { kind: 'act', action: { type: 'double-click', target: bidTarget(observation, a[0], mode), ...(button(k.button ?? a[1]) ? { button: button(k.button ?? a[1]) } : {}) } }
    case 'hover':
      return { kind: 'act', action: { type: 'hover', target: bidTarget(observation, a[0], mode) } }
    case 'fill':
      return { kind: 'act', action: { type: 'fill', target: bidTarget(observation, a[0], mode, 'textbox'), text: String(a[1] ?? '') } }
    case 'clear':
      return { kind: 'act', action: { type: 'fill', target: bidTarget(observation, a[0], mode), text: '' } }
    case 'select_option': {
      const options = a[1]
      const values = Array.isArray(options) ? options.map(String) : [String(options)]
      return { kind: 'act', action: { type: 'select', target: bidTarget(observation, a[0], mode), values } }
    }
    case 'check':
      return { kind: 'act', action: { type: 'check', target: bidTarget(observation, a[0], mode), checked: true } }
    case 'uncheck':
      return { kind: 'act', action: { type: 'check', target: bidTarget(observation, a[0], mode), checked: false } }
    case 'press':
      return { kind: 'act', action: { type: 'key', key: String(a[1] ?? k.key_comb ?? ''), target: bidTarget(observation, a[0], mode) } }
    case 'drag_and_drop':
      return { kind: 'act', action: { type: 'drag', from: bidTarget(observation, a[0], mode), to: bidTarget(observation, a[1], mode) } }
    case 'scroll':
      return { kind: 'act', action: { type: 'scroll', deltaX: Number(a[0] ?? 0), deltaY: Number(a[1] ?? 0) } }
    case 'mouse_click':
      return { kind: 'act', action: { type: 'click', target: { kind: 'image-point', point: { x: Number(a[0]), y: Number(a[1]) } }, ...(button(k.button ?? a[2]) ? { button: button(k.button ?? a[2]) } : {}) } }
    case 'mouse_dblclick':
      return { kind: 'act', action: { type: 'double-click', target: { kind: 'image-point', point: { x: Number(a[0]), y: Number(a[1]) } } } }
    case 'mouse_drag_and_drop':
      return { kind: 'act', action: { type: 'drag', from: { kind: 'image-point', point: { x: Number(a[0]), y: Number(a[1]) } }, to: { kind: 'image-point', point: { x: Number(a[2]), y: Number(a[3]) } } } }
    case 'keyboard_press':
      return { kind: 'act', action: { type: 'key', key: String(a[0]) } }
    case 'goto':
      return { kind: 'act', action: { type: 'navigate', url: String(a[0]) } }
    case 'go_back':
      return { kind: 'act', action: { type: 'back' } }
    case 'go_forward':
      return { kind: 'act', action: { type: 'forward' } }
    case 'new_tab':
      return { kind: 'tabs', operation: 'new', url: typeof a[0] === 'string' ? a[0] : undefined }
    case 'tab_close':
      return { kind: 'tabs', operation: 'close' }
    case 'tab_focus':
      return { kind: 'tabs', operation: 'switch', index: Number(a[0]) }
    case 'send_msg_to_user':
      return { kind: 'stop', text: String(a[0] ?? '') }
    case 'report_infeasible':
      return { kind: 'infeasible', reason: String(a[0] ?? '') }
    case 'noop':
      return { kind: 'noop', waitMs: Number(a[0] ?? k.wait_ms ?? 0) }
    case 'upload_file':
      return { kind: 'unsupported', name: call.name, reason: 'BrowserGym upload_file uses host filesystem paths; Mousse uploads require opaque artifact grants' }
    case 'focus':
    case 'scroll_at':
    case 'mouse_move':
    case 'mouse_up':
    case 'mouse_down':
    case 'keyboard_up':
    case 'keyboard_down':
    case 'keyboard_type':
    case 'keyboard_insert_text':
    case 'mouse_upload_file':
      return { kind: 'unsupported', name: call.name, reason: `No Mousse executor primitive for BrowserGym ${call.name}` }
    default:
      return { kind: 'unsupported', name: call.name, reason: `Unmapped BrowserGym action ${call.name}` }
  }
}

export function toBrowserGymObservation(input: {
  observation: BrowserObservation
  goal: string
  lastAction: string
  lastActionError: string
  startedAt: number
  chat?: BrowserGymObservation['chat_messages']
}): BrowserGymObservation {
  const extra: BrowserGymObservation['extra_element_properties'] = {}
  const nodes = input.observation.elements.map((element) => {
    extra[element.ref] = {
      visibility: 1,
      bbox: element.bounds ? [element.bounds.x, element.bounds.y, element.bounds.width, element.bounds.height] : null,
      clickable: !element.states.includes('disabled'),
      set_of_marks: null
    }
    return {
      role: { value: element.role ?? 'generic' },
      name: { value: element.name ?? element.text ?? '' },
      browsergym_id: element.ref,
      nodeId: element.ref
    }
  })
  return {
    chat_messages: input.chat ?? [{ role: 'user', message: input.goal }],
    goal: input.goal,
    goal_object: [{ type: 'text', text: input.goal }],
    open_pages_urls: input.observation.tabs.map((tab) => tab.url),
    open_pages_titles: input.observation.tabs.map((tab) => tab.title),
    active_page_index: [Math.max(0, input.observation.tabs.findIndex((tab) => tab.id === input.observation.tabId))],
    url: input.observation.url,
    screenshot: input.observation.screenshot
      ? { pixelWidth: input.observation.screenshot.pixelWidth, pixelHeight: input.observation.screenshot.pixelHeight, artifactId: input.observation.screenshot.artifactId }
      : { omitted: true, reason: 'structured observation; screenshot bytes are never copied into evaluation reports' },
    dom_object: { source: 'mousse-structured-observation', elementCount: input.observation.elements.length },
    axtree_object: { nodes },
    extra_element_properties: extra,
    focused_element_bid: input.observation.elements.find((element) => element.states.includes('focused'))?.ref ?? '',
    last_action: input.lastAction,
    last_action_error: input.lastActionError,
    elapsed_time: [(Date.now() - input.startedAt) / 1000]
  }
}

export function observationHasProtocolKeys(obs: BrowserGymObservation): boolean {
  return BROWSERGYM_OBSERVATION_KEYS.every((key) => key in obs)
}
