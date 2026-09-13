import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import { getBrowserToolDefinitions } from '../src/mms/orchestrator/browser/tools'
import { validateBrowserAction, validateBrowserWait } from '../src/shared/browser/validation'

const target = { kind: 'ref', ref: 'el_textbox_123' }
const envelope = { sessionId: 'session_1', tabId: 'tab_1', generation: 1, observationId: 'obs_1', controlLeaseId: 'lease_1' }
const actions = [
  { type: 'navigate', url: 'https://example.com/' },
  ...['back', 'forward', 'reload'].map((type) => ({ type })),
  ...['click', 'double-click', 'hover'].map((type) => ({ type, target, button: 'left' })),
  ...['fill', 'type'].map((type) => ({ type, target, text: 'hello' })),
  { type: 'key', key: 'Enter' }, { type: 'select', target, values: ['one'] },
  { type: 'check', target, checked: true }, { type: 'scroll', deltaX: 0, deltaY: 500 },
  { type: 'drag', from: target, to: { kind: 'ref', ref: 'el_destination' } },
  { type: 'upload', target, artifactIds: ['artifact_1'] }, { type: 'dialog', accept: true }
]
const conditions = [
  { type: 'url', equals: 'https://example.com/' }, { type: 'url', includes: '/done' },
  { type: 'text', text: 'Saved', present: true }, { type: 'element', ref: target.ref, state: 'visible' },
  { type: 'document-ready' }
]
const schema = (name: string, vision = false) => new Ajv().compile(getBrowserToolDefinitions({ vision }).find((tool) => tool.name === name)!.parameters)

describe('model-visible browser tool contract', () => {
  it.each(actions)('documents a runtime-valid $type action', (action) => {
    expect(schema('browser_act')({ ...envelope, action })).toBe(true)
    expect(validateBrowserAction(action)).toEqual(action)
  })

  it.each(conditions)('documents a runtime-valid $type wait condition', (condition) => {
    expect(schema('browser_wait')({ sessionId: 'session_1', tabId: 'tab_1', condition })).toBe(true)
    expect(schema('browser_act')({ ...envelope, action: actions[0], expected: condition })).toBe(true)
    expect(validateBrowserWait(condition)).toEqual(condition)
  })

  it('rejects guessed ref encodings and host-only upload fields', () => {
    const check = schema('browser_act')
    for (const invalid of [{ ref: target.ref }, { elementRef: target.ref }, { kind: 'semantic', ref: target.ref }, { ...target, selector: 'input' }]) {
      expect(check({ ...envelope, action: { type: 'fill', target: invalid, text: 'hello' } })).toBe(false)
    }
    expect(check({ ...envelope, action: { type: 'upload', target, artifactIds: ['artifact_1'], resolvedArtifacts: [] } })).toBe(false)
  })

  it('only advertises coordinates for vision bindings', () => {
    const action = { type: 'click', target: { kind: 'image-point', point: { x: 10, y: 20 } } }
    expect(schema('browser_act')({ ...envelope, action })).toBe(false)
    expect(schema('browser_act', true)({ ...envelope, action })).toBe(true)
    expect(validateBrowserAction(action)).toEqual(action)
  })
})
