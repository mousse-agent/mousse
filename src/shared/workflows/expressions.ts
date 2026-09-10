import { isJsonPointer } from './jsonPointer'
import { WORKFLOW_MAX_EXPRESSION_ARGS, WORKFLOW_MAX_EXPRESSION_DEPTH } from './limits'
import { isPlainObject } from './util'
import { parseWorkflowBinding, type WorkflowBinding } from './bindings'

export const EXPRESSION_OPS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'and',
  'or',
  'not',
  'add',
  'sub',
  'mul',
  'div',
  'mod',
  'coalesce',
  'concat',
  'includes',
  'startsWith',
  'endsWith',
  'length',
  'toLower',
  'toUpper',
  'trim',
  'get',
  'keys',
  'has',
  'map',
  'filter',
  'first',
  'last',
  'slice'
] as const

export type ExpressionOp = (typeof EXPRESSION_OPS)[number]

export interface ExpressionOpNode {
  op: ExpressionOp
  args: WorkflowExpression[]
}

export type WorkflowExpression = WorkflowBinding | ExpressionOpNode

export type ExpressionParseResult =
  | { ok: true; expression: WorkflowExpression }
  | { ok: false; error: string }

const OP_SET = new Set<string>(EXPRESSION_OPS)

const ARITY: Record<ExpressionOp, { min: number; max: number }> = {
  eq: { min: 2, max: 2 },
  neq: { min: 2, max: 2 },
  gt: { min: 2, max: 2 },
  gte: { min: 2, max: 2 },
  lt: { min: 2, max: 2 },
  lte: { min: 2, max: 2 },
  and: { min: 1, max: WORKFLOW_MAX_EXPRESSION_ARGS },
  or: { min: 1, max: WORKFLOW_MAX_EXPRESSION_ARGS },
  not: { min: 1, max: 1 },
  add: { min: 1, max: WORKFLOW_MAX_EXPRESSION_ARGS },
  sub: { min: 2, max: 2 },
  mul: { min: 1, max: WORKFLOW_MAX_EXPRESSION_ARGS },
  div: { min: 2, max: 2 },
  mod: { min: 2, max: 2 },
  coalesce: { min: 1, max: WORKFLOW_MAX_EXPRESSION_ARGS },
  concat: { min: 1, max: WORKFLOW_MAX_EXPRESSION_ARGS },
  includes: { min: 2, max: 2 },
  startsWith: { min: 2, max: 2 },
  endsWith: { min: 2, max: 2 },
  length: { min: 1, max: 1 },
  toLower: { min: 1, max: 1 },
  toUpper: { min: 1, max: 1 },
  trim: { min: 1, max: 1 },
  get: { min: 2, max: 2 },
  keys: { min: 1, max: 1 },
  has: { min: 2, max: 2 },
  map: { min: 2, max: 2 },
  filter: { min: 2, max: 2 },
  first: { min: 1, max: 1 },
  last: { min: 1, max: 1 },
  slice: { min: 2, max: 3 }
}

export function isExpressionOp(value: unknown): value is ExpressionOp {
  return typeof value === 'string' && OP_SET.has(value)
}

export function parseWorkflowExpression(
  value: unknown,
  depth = 0
): ExpressionParseResult {
  if (depth > WORKFLOW_MAX_EXPRESSION_DEPTH) {
    return { ok: false, error: 'Expression exceeds maximum nesting depth' }
  }
  if (isPlainObject(value) && 'op' in value) {
    if (!isExpressionOp(value.op)) {
      return { ok: false, error: `Unknown expression op "${String(value.op)}"` }
    }
    if (!Array.isArray(value.args)) {
      return { ok: false, error: `Expression op "${value.op}" requires args[]` }
    }
    const arity = ARITY[value.op]
    if (value.args.length < arity.min || value.args.length > arity.max) {
      return {
        ok: false,
        error: `Expression op "${value.op}" expects ${arity.min}..${arity.max} args`
      }
    }
    const args: WorkflowExpression[] = []
    for (let i = 0; i < value.args.length; i += 1) {
      const parsed = parseWorkflowExpression(value.args[i], depth + 1)
      if (!parsed.ok) return { ok: false, error: `args[${i}]: ${parsed.error}` }
      args.push(parsed.expression)
    }
    return { ok: true, expression: { op: value.op, args } }
  }
  const binding = parseWorkflowBinding(value, depth)
  if (!binding.ok) return { ok: false, error: binding.error }
  return { ok: true, expression: binding.binding }
}

export function expressionNodeRefs(expression: WorkflowExpression): string[] {
  if ('op' in expression) {
    return expression.args.flatMap(expressionNodeRefs)
  }
  if ('ref' in expression && expression.ref === 'node') return [expression.nodeId]
  if ('compose' in expression && expression.compose === 'object') {
    return Object.values(expression.fields).flatMap((field) =>
      expressionNodeRefs(field)
    )
  }
  if ('compose' in expression && expression.compose === 'array') {
    return expression.items.flatMap((item) => expressionNodeRefs(item))
  }
  return []
}

export function isJsonPointerExpr(value: unknown): boolean {
  return typeof value === 'string' && isJsonPointer(value)
}
