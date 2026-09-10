import {
  getJsonPointer,
  isJsonPointer,
  isPlainObject,
  listTemplatePlaceholders,
  parseWorkflowBinding,
  parseWorkflowExpression,
  WORKFLOW_MAX_ARRAY_ITEMS,
  WORKFLOW_MAX_EXPRESSION_DEPTH,
  type ExpressionOpNode,
  type WorkflowBinding,
  type WorkflowExpression
} from '../../../shared/workflows'

export interface BindingEvaluationContext {
  input?: unknown
  nodes?: Record<string, unknown>
  loop?: { item: unknown; index: number; previous?: unknown }
  /** Secret values are supplied only by a permitted runner. Missing secrets fail closed. */
  secrets?: Record<string, unknown>
}

export type EvaluationSuccess<T = unknown> = { ok: true; value: T }
export type EvaluationFailure = {
  ok: false
  code: 'EXPR_TYPE' | 'EXPR_MISSING' | 'EXPR_BOUND' | 'EXPR_SECRET' | 'EXPR_TEMPLATE'
  message: string
}
export type EvaluationResult<T = unknown> = EvaluationSuccess<T> | EvaluationFailure

export function evaluateBinding(
  binding: WorkflowBinding,
  context: BindingEvaluationContext,
  depth = 0
): EvaluationResult {
  if (depth > WORKFLOW_MAX_EXPRESSION_DEPTH) return fail('EXPR_BOUND', 'Binding evaluation exceeded depth')
  if ('literal' in binding) return ok(binding.literal)
  if ('compose' in binding && binding.compose === 'object') {
    const fields: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(binding.fields)) {
      const result = evaluateBinding(child, context, depth + 1)
      if (!result.ok) return result
      fields[key] = result.value
    }
    return ok(fields)
  }
  if ('compose' in binding && binding.compose === 'array') {
    const items: unknown[] = []
    for (const child of binding.items) {
      const result = evaluateBinding(child, context, depth + 1)
      if (!result.ok) return result
      items.push(result.value)
    }
    return ok(items)
  }
  if ('secretRef' in binding) {
    const id = typeof binding.secretRef === 'string' ? binding.secretRef : binding.secretRef.id
    if (!context.secrets || !(id in context.secrets)) {
      return fail('EXPR_SECRET', `Secret ${id} is not available in this evaluation context`)
    }
    return ok(context.secrets[id])
  }
  if ('template' in binding) return evaluateTemplate(binding.template, context)
  if ('ref' in binding) {
    if (binding.ref === 'input') return lookup(context.input, binding.pointer, 'input')
    if (binding.ref === 'node') {
      const doc = context.nodes?.[binding.nodeId]
      if (doc === undefined) return fail('EXPR_MISSING', `Node output ${binding.nodeId} is missing`)
      return lookup(doc, binding.pointer, `node ${binding.nodeId}`)
    }
    if (binding.ref === 'loop') {
      if (!context.loop) return fail('EXPR_MISSING', 'Loop state is not available')
      return lookup(context.loop, binding.pointer, 'loop')
    }
    if (binding.ref === 'item') {
      if (!context.loop) return fail('EXPR_MISSING', 'Item binding requires loop/map context')
      return lookup(context.loop.item, binding.pointer ?? '', 'item')
    }
    if (binding.ref === 'index') {
      if (!context.loop) return fail('EXPR_MISSING', 'Index binding requires loop/map context')
      return ok(context.loop.index)
    }
  }
  return fail('EXPR_TYPE', 'Unsupported binding')
}

export function evaluateExpression(
  expression: WorkflowExpression,
  context: BindingEvaluationContext,
  depth = 0
): EvaluationResult {
  if (depth > WORKFLOW_MAX_EXPRESSION_DEPTH) return fail('EXPR_BOUND', 'Expression exceeded depth')
  if (!('op' in expression)) return evaluateBinding(expression, context, depth)
  return evaluateOp(expression, context, depth)
}

function evaluateOp(
  node: ExpressionOpNode,
  context: BindingEvaluationContext,
  depth: number
): EvaluationResult {
  const arg = (index: number) => evaluateExpression(node.args[index]!, context, depth + 1)
  const args: unknown[] = []
  for (let i = 0; i < node.args.length; i += 1) {
    // map/filter predicate is evaluated per item, not now
    if ((node.op === 'map' || node.op === 'filter') && i === 1) continue
    const result = arg(i)
    if (!result.ok) return result
    args.push(result.value)
  }

  switch (node.op) {
    case 'eq':
      return ok(jsonEqual(args[0], args[1]))
    case 'neq':
      return ok(!jsonEqual(args[0], args[1]))
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return compare(node.op, args[0], args[1])
    case 'and':
      for (const value of args) {
        if (typeof value !== 'boolean') return fail('EXPR_TYPE', 'and requires booleans')
        if (!value) return ok(false)
      }
      return ok(true)
    case 'or':
      for (const value of args) {
        if (typeof value !== 'boolean') return fail('EXPR_TYPE', 'or requires booleans')
        if (value) return ok(true)
      }
      return ok(false)
    case 'not':
      if (typeof args[0] !== 'boolean') return fail('EXPR_TYPE', 'not requires a boolean')
      return ok(!args[0])
    case 'add':
    case 'mul':
      return reduceNumbers(node.op, args)
    case 'sub':
    case 'div':
    case 'mod':
      return binaryNumber(node.op, args[0], args[1])
    case 'coalesce': {
      for (const value of args) {
        if (value !== null && value !== undefined) return ok(value)
      }
      return ok(null)
    }
    case 'concat':
      if (!args.every((item) => typeof item === 'string')) return fail('EXPR_TYPE', 'concat requires strings')
      return ok((args as string[]).join(''))
    case 'includes':
      if (typeof args[0] === 'string' && typeof args[1] === 'string') return ok(args[0].includes(args[1]))
      if (Array.isArray(args[0])) return ok(args[0].some((item) => jsonEqual(item, args[1])))
      return fail('EXPR_TYPE', 'includes requires a string or array')
    case 'startsWith':
    case 'endsWith':
      if (typeof args[0] !== 'string' || typeof args[1] !== 'string') {
        return fail('EXPR_TYPE', `${node.op} requires strings`)
      }
      return ok(node.op === 'startsWith' ? args[0].startsWith(args[1]) : args[0].endsWith(args[1]))
    case 'length':
      if (typeof args[0] === 'string' || Array.isArray(args[0])) return ok(args[0].length)
      return fail('EXPR_TYPE', 'length requires a string or array')
    case 'toLower':
    case 'toUpper':
    case 'trim':
      if (typeof args[0] !== 'string') return fail('EXPR_TYPE', `${node.op} requires a string`)
      if (node.op === 'toLower') return ok(args[0].toLowerCase())
      if (node.op === 'toUpper') return ok(args[0].toUpperCase())
      return ok(args[0].trim())
    case 'get': {
      if (!isPlainObject(args[0]) && !Array.isArray(args[0])) return fail('EXPR_TYPE', 'get requires an object or array')
      if (typeof args[1] !== 'string') return fail('EXPR_TYPE', 'get key must be a string')
      if (isJsonPointer(args[1]) && args[1].startsWith('/')) return lookup(args[0], args[1], 'get')
      if (isPlainObject(args[0]) && args[1] in args[0]) return ok(args[0][args[1]])
      return fail('EXPR_MISSING', `Missing property ${args[1]}`)
    }
    case 'keys':
      if (!isPlainObject(args[0])) return fail('EXPR_TYPE', 'keys requires an object')
      return ok(Object.keys(args[0]))
    case 'has':
      if (!isPlainObject(args[0]) || typeof args[1] !== 'string') return fail('EXPR_TYPE', 'has requires an object and string')
      return ok(args[1] in args[0])
    case 'first':
    case 'last':
      if (!Array.isArray(args[0])) return fail('EXPR_TYPE', `${node.op} requires an array`)
      if (args[0].length === 0) return fail('EXPR_MISSING', `Cannot take ${node.op} of an empty array`)
      return ok(node.op === 'first' ? args[0][0] : args[0][args[0].length - 1])
    case 'slice': {
      if (!Array.isArray(args[0])) return fail('EXPR_TYPE', 'slice requires an array')
      if (typeof args[1] !== 'number' || !Number.isInteger(args[1])) return fail('EXPR_TYPE', 'slice start must be an integer')
      const end = args[2]
      if (end !== undefined && (typeof end !== 'number' || !Number.isInteger(end))) {
        return fail('EXPR_TYPE', 'slice end must be an integer')
      }
      return ok(args[0].slice(args[1], end as number | undefined))
    }
    case 'map':
    case 'filter':
      return evaluateCollection(node, args[0], context, depth)
    default:
      return fail('EXPR_TYPE', `Unsupported op ${(node as ExpressionOpNode).op}`)
  }
}

function evaluateCollection(
  node: ExpressionOpNode,
  source: unknown,
  context: BindingEvaluationContext,
  depth: number
): EvaluationResult {
  if (!Array.isArray(source)) return fail('EXPR_TYPE', `${node.op} requires an array`)
  if (source.length > WORKFLOW_MAX_ARRAY_ITEMS) return fail('EXPR_BOUND', 'Array exceeds bounded item count')
  const predicate = node.args[1]
  if (!predicate) return fail('EXPR_TYPE', `${node.op} requires a predicate/mapper expression`)
  const output: unknown[] = []
  for (let index = 0; index < source.length; index += 1) {
    const inner: BindingEvaluationContext = {
      ...context,
      loop: { item: source[index], index, previous: context.loop?.previous }
    }
    const result = evaluateExpression(predicate, inner, depth + 1)
    if (!result.ok) return result
    if (node.op === 'filter') {
      if (typeof result.value !== 'boolean') return fail('EXPR_TYPE', 'filter predicate must return a boolean')
      if (result.value) output.push(source[index])
    } else {
      output.push(result.value)
    }
  }
  return ok(output)
}

function evaluateTemplate(template: string, context: BindingEvaluationContext): EvaluationResult {
  const placeholders = listTemplatePlaceholders(template)
  let out = template
  for (const name of placeholders) {
    const value = resolvePlaceholder(name, context)
    if (!value.ok) return value
    if (typeof value.value !== 'string' && typeof value.value !== 'number' && typeof value.value !== 'boolean') {
      return fail('EXPR_TEMPLATE', `Template placeholder ${name} must be a scalar`)
    }
    out = out.replace(new RegExp(`\\{\\{\\s*${escapeRegExp(name)}\\s*\\}\\}`, 'g'), String(value.value))
  }
  return ok(out)
}

function resolvePlaceholder(name: string, context: BindingEvaluationContext): EvaluationResult {
  const parts = name.split('.')
  if (parts[0] === 'input') {
    const pointer = parts.length === 1 ? '' : '/' + parts.slice(1).join('/')
    return lookup(context.input, pointer, 'input')
  }
  if (parts[0] === 'node' && parts[1]) {
    const doc = context.nodes?.[parts[1]]
    if (doc === undefined) return fail('EXPR_MISSING', `Node ${parts[1]} is missing`)
    const pointer = parts.length === 2 ? '' : '/' + parts.slice(2).join('/')
    return lookup(doc, pointer, `node ${parts[1]}`)
  }
  if (parts[0] === 'loop') {
    if (!context.loop) return fail('EXPR_MISSING', 'Loop state is not available')
    const pointer = parts.length === 1 ? '' : '/' + parts.slice(1).join('/')
    return lookup(context.loop, pointer, 'loop')
  }
  return fail('EXPR_TEMPLATE', `Unknown template placeholder ${name}`)
}

function lookup(document: unknown, pointer: string, label: string): EvaluationResult {
  if (document === undefined) return fail('EXPR_MISSING', `${label} is missing`)
  const found = getJsonPointer(document, pointer)
  if (!found.ok) return fail('EXPR_MISSING', `${label}: ${found.error}`)
  return ok(found.value)
}

function compare(op: 'gt' | 'gte' | 'lt' | 'lte', a: unknown, b: unknown): EvaluationResult {
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) {
    return fail('EXPR_TYPE', `${op} requires finite numbers`)
  }
  switch (op) {
    case 'gt':
      return ok(a > b)
    case 'gte':
      return ok(a >= b)
    case 'lt':
      return ok(a < b)
    case 'lte':
      return ok(a <= b)
  }
}

function reduceNumbers(op: 'add' | 'mul', args: unknown[]): EvaluationResult {
  if (!args.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    return fail('EXPR_TYPE', `${op} requires finite numbers`)
  }
  const numbers = args as number[]
  if (op === 'add') return ok(numbers.reduce((sum, n) => sum + n, 0))
  return ok(numbers.reduce((prod, n) => prod * n, 1))
}

function binaryNumber(op: 'sub' | 'div' | 'mod', a: unknown, b: unknown): EvaluationResult {
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) {
    return fail('EXPR_TYPE', `${op} requires finite numbers`)
  }
  if ((op === 'div' || op === 'mod') && b === 0) return fail('EXPR_TYPE', 'Division by zero')
  if (op === 'sub') return ok(a - b)
  if (op === 'div') return ok(a / b)
  return ok(a % b)
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (typeof a !== 'object') return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function ok<T>(value: T): EvaluationSuccess<T> {
  return { ok: true, value }
}

function fail(code: EvaluationFailure['code'], message: string): EvaluationFailure {
  return { ok: false, code, message }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Parse a raw binding/expression JSON value and evaluate it. */
export function evaluateRawExpression(
  raw: unknown,
  context: BindingEvaluationContext
): EvaluationResult {
  if (isPlainObject(raw) && 'op' in raw) {
    const parsed = parseWorkflowExpression(raw)
    if (!parsed.ok) return fail('EXPR_TYPE', parsed.error)
    return evaluateExpression(parsed.expression, context)
  }
  const parsed = parseWorkflowBinding(raw)
  if (!parsed.ok) return fail('EXPR_TYPE', parsed.error)
  return evaluateBinding(parsed.binding, context)
}
