import { describe, expect, it } from 'vitest'
import { parseWorkflowExpression } from '../src/shared/workflows'
import { evaluateExpression, evaluateRawExpression } from '../src/mms/workflows/evaluator/evaluate'

describe('bounded expression evaluator', () => {
  it('evaluates comparisons, boolean, arithmetic, coalesce, strings, objects, and arrays', () => {
    const ctx = {
      input: { topic: 'Hello', n: 3, items: [1, 2, 3] },
      nodes: { collect: { count: 2, text: 'abc' } }
    }

    expect(evalOp({ op: 'gt', args: [{ ref: 'node', nodeId: 'collect', pointer: '/count' }, { literal: 0 }] }, ctx)).toBe(
      true
    )
    expect(evalOp({ op: 'and', args: [{ literal: true }, { literal: true }] }, ctx)).toBe(true)
    expect(evalOp({ op: 'or', args: [{ literal: false }, { literal: true }] }, ctx)).toBe(true)
    expect(evalOp({ op: 'not', args: [{ literal: false }] }, ctx)).toBe(true)
    expect(evalOp({ op: 'add', args: [{ literal: 1 }, { literal: 2 }, { literal: 3 }] }, ctx)).toBe(6)
    expect(evalOp({ op: 'sub', args: [{ literal: 5 }, { literal: 2 }] }, ctx)).toBe(3)
    expect(evalOp({ op: 'mul', args: [{ literal: 2 }, { literal: 4 }] }, ctx)).toBe(8)
    expect(evalOp({ op: 'div', args: [{ literal: 8 }, { literal: 2 }] }, ctx)).toBe(4)
    expect(evalOp({ op: 'mod', args: [{ literal: 7 }, { literal: 4 }] }, ctx)).toBe(3)
    expect(evalOp({ op: 'coalesce', args: [{ literal: null }, { literal: 'x' }] }, ctx)).toBe('x')
    expect(evalOp({ op: 'concat', args: [{ literal: 'a' }, { literal: 'b' }] }, ctx)).toBe('ab')
    expect(evalOp({ op: 'includes', args: [{ literal: 'abcd' }, { literal: 'bc' }] }, ctx)).toBe(true)
    expect(evalOp({ op: 'startsWith', args: [{ literal: 'abcd' }, { literal: 'ab' }] }, ctx)).toBe(true)
    expect(evalOp({ op: 'endsWith', args: [{ literal: 'abcd' }, { literal: 'cd' }] }, ctx)).toBe(true)
    expect(evalOp({ op: 'length', args: [{ ref: 'input', pointer: '/topic' }] }, ctx)).toBe(5)
    expect(evalOp({ op: 'toLower', args: [{ literal: 'Ab' }] }, ctx)).toBe('ab')
    expect(evalOp({ op: 'toUpper', args: [{ literal: 'Ab' }] }, ctx)).toBe('AB')
    expect(evalOp({ op: 'trim', args: [{ literal: '  z  ' }] }, ctx)).toBe('z')
    expect(evalOp({ op: 'get', args: [{ ref: 'input', pointer: '' }, { literal: 'topic' }] }, ctx)).toBe('Hello')
    expect(evalOp({ op: 'has', args: [{ ref: 'input', pointer: '' }, { literal: 'n' }] }, ctx)).toBe(true)
    expect(evalOp({ op: 'keys', args: [{ ref: 'input', pointer: '' }] }, ctx)).toEqual(
      expect.arrayContaining(['topic', 'n', 'items'])
    )
    expect(evalOp({ op: 'first', args: [{ ref: 'input', pointer: '/items' }] }, ctx)).toBe(1)
    expect(evalOp({ op: 'last', args: [{ ref: 'input', pointer: '/items' }] }, ctx)).toBe(3)
    expect(evalOp({ op: 'slice', args: [{ ref: 'input', pointer: '/items' }, { literal: 1 }, { literal: 2 }] }, ctx)).toEqual(
      [2]
    )
    expect(
      evalOp(
        {
          op: 'map',
          args: [
            { ref: 'input', pointer: '/items' },
            { op: 'add', args: [{ ref: 'item' }, { literal: 1 }] }
          ]
        },
        ctx
      )
    ).toEqual([2, 3, 4])
    expect(
      evalOp(
        {
          op: 'filter',
          args: [
            { ref: 'input', pointer: '/items' },
            { op: 'gt', args: [{ ref: 'item' }, { literal: 1 }] }
          ]
        },
        ctx
      )
    ).toEqual([2, 3])
  })

  it('does not coerce missing values or type mismatches to empty strings', () => {
    const missing = evaluateRawExpression({ ref: 'input', pointer: '/nope' }, { input: {} })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('EXPR_MISSING')

    const mismatch = evaluateRawExpression({ op: 'gt', args: [{ literal: 'a' }, { literal: 1 }] }, {})
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) expect(mismatch.code).toBe('EXPR_TYPE')
  })

  it('evaluates display templates without JavaScript', () => {
    const result = evaluateRawExpression(
      { template: 'Topic {{input.topic}} count {{node.collect.count}}' },
      { input: { topic: 'Files' }, nodes: { collect: { count: 2 } } }
    )
    expect(result).toEqual({ ok: true, value: 'Topic Files count 2' })
  })

  it('does not evaluate secret bindings without an explicit secret context', () => {
    const result = evaluateRawExpression({ secretRef: 'token' }, { input: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('EXPR_SECRET')
  })
})

function evalOp(raw: unknown, ctx: { input?: unknown; nodes?: Record<string, unknown> }): unknown {
  const parsed = parseWorkflowExpression(raw)
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) return parsed
  const result = evaluateExpression(parsed.expression, ctx)
  expect(result.ok, !result.ok ? result.message : '').toBe(true)
  return result.ok ? result.value : result
}
