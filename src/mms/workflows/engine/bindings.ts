import {
  parseWorkflowBinding,
  parseWorkflowExpression,
  type CompiledNode
} from '../../../shared/workflows'
import {
  evaluateBinding,
  evaluateExpression,
  type BindingEvaluationContext
} from '../evaluator/evaluate'

export function nodeEvalContext(
  input: unknown,
  outputs: Record<string, unknown>,
  loop?: BindingEvaluationContext['loop']
): BindingEvaluationContext {
  return { input, nodes: outputs, loop }
}

export function evaluateNodeInputs(
  node: CompiledNode,
  ctx: BindingEvaluationContext
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, binding] of Object.entries(node.inputs ?? {})) {
    const result = evaluateBinding(binding, ctx)
    if (!result.ok) throw new Error(`${node.id} input ${key}: ${result.message}`)
    out[key] = result.value
  }
  return out
}

export function evaluateConfigBinding(raw: unknown, ctx: BindingEvaluationContext): unknown {
  const parsed = parseWorkflowBinding(raw)
  if (!parsed.ok) throw new Error(parsed.error)
  const result = evaluateBinding(parsed.binding, ctx)
  if (!result.ok) throw new Error(result.message)
  return result.value
}

export function evaluateConfigExpression(raw: unknown, ctx: BindingEvaluationContext): unknown {
  const parsed = parseWorkflowExpression(raw)
  if (!parsed.ok) throw new Error(parsed.error)
  const result = evaluateExpression(parsed.expression, ctx)
  if (!result.ok) throw new Error(result.message)
  return result.value
}

export function collectScopeOutputs(
  outputs: Record<string, unknown>,
  path: string
): Record<string, unknown> {
  const scope: Record<string, unknown> = {}
  const prefix = path ? `${path}/` : ''
  for (const [key, value] of Object.entries(outputs)) {
    if (prefix && key.startsWith(prefix)) {
      const rest = key.slice(prefix.length)
      if (!rest.includes('/')) scope[rest] = value
    } else if (!prefix && !key.includes('/')) {
      scope[key] = value
    }
  }
  if (path) {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    Object.assign(scope, collectScopeOutputs(outputs, parent))
  }
  return scope
}

export function instanceKey(path: string, nodeId: string): string {
  return path ? `${path}/${nodeId}` : nodeId
}
