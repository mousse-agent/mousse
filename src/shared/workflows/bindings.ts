import { isJsonPointer } from './jsonPointer'
import { WORKFLOW_MAX_BINDING_DEPTH, WORKFLOW_MAX_ARRAY_ITEMS } from './limits'
import { isPlainObject } from './util'

export type BindingRefKind = 'input' | 'node' | 'loop' | 'item' | 'index'

export interface InputRefBinding {
  ref: 'input'
  pointer: string
}

export interface NodeRefBinding {
  ref: 'node'
  nodeId: string
  pointer: string
}

export interface LoopRefBinding {
  ref: 'loop'
  pointer: string
}

export interface ItemRefBinding {
  ref: 'item'
  pointer?: string
}

export interface IndexRefBinding {
  ref: 'index'
}

export interface LiteralBinding {
  literal: unknown
}

export interface SecretRefBinding {
  secretRef: string | { id: string; version?: string }
}

/** Display/template text. Supports `{{input.path}}` and `{{node.id.path}}` only — not JavaScript. */
export interface TemplateBinding {
  template: string
}

export interface ComposedObjectBinding {
  compose: 'object'
  fields: Record<string, WorkflowBinding>
}

export interface ComposedArrayBinding {
  compose: 'array'
  items: WorkflowBinding[]
}

export type WorkflowBinding =
  | InputRefBinding
  | NodeRefBinding
  | LoopRefBinding
  | ItemRefBinding
  | IndexRefBinding
  | LiteralBinding
  | SecretRefBinding
  | TemplateBinding
  | ComposedObjectBinding
  | ComposedArrayBinding

export type BindingParseResult =
  | { ok: true; binding: WorkflowBinding }
  | { ok: false; error: string }

const LEAF_KEYS = new Set(['ref', 'literal', 'secretRef', 'template', 'compose'])

export function isBindingLeafObject(value: Record<string, unknown>): boolean {
  return (
    'ref' in value ||
    'literal' in value ||
    'secretRef' in value ||
    'template' in value ||
    'compose' in value
  )
}

export function parseWorkflowBinding(
  value: unknown,
  depth = 0
): BindingParseResult {
  if (depth > WORKFLOW_MAX_BINDING_DEPTH) {
    return { ok: false, error: 'Binding exceeds maximum nesting depth' }
  }
  if (Array.isArray(value)) {
    if (value.length > WORKFLOW_MAX_ARRAY_ITEMS) {
      return { ok: false, error: 'Composed binding array is too large' }
    }
    const items: WorkflowBinding[] = []
    for (let i = 0; i < value.length; i += 1) {
      const parsed = parseWorkflowBinding(value[i], depth + 1)
      if (!parsed.ok) return { ok: false, error: `[${i}]: ${parsed.error}` }
      items.push(parsed.binding)
    }
    return { ok: true, binding: { compose: 'array', items } }
  }
  if (!isPlainObject(value)) {
    return { ok: false, error: 'Binding must be an object, array, or composed value' }
  }

  const keys = Object.keys(value)
  if (keys.some((key) => key === '__proto__' || key === 'prototype' || key === 'constructor')) {
    return { ok: false, error: 'Prototype-polluting keys are not allowed in bindings' }
  }

  if (!isBindingLeafObject(value)) {
    const fields: Record<string, WorkflowBinding> = {}
    for (const key of keys) {
      const parsed = parseWorkflowBinding(value[key], depth + 1)
      if (!parsed.ok) return { ok: false, error: `${key}: ${parsed.error}` }
      fields[key] = parsed.binding
    }
    return { ok: true, binding: { compose: 'object', fields } }
  }

  const discriminantCount = keys.filter((key) => LEAF_KEYS.has(key)).length
  if (discriminantCount !== 1) {
    return { ok: false, error: 'Binding must use exactly one of ref, literal, secretRef, template, compose' }
  }

  if ('literal' in value) {
    if (keys.length !== 1) {
      return { ok: false, error: 'literal binding may not include other fields' }
    }
    return { ok: true, binding: { literal: value.literal } }
  }

  if ('secretRef' in value) {
    const secret = value.secretRef
    if (typeof secret === 'string' && secret.length > 0 && secret.length <= 128) {
      return { ok: true, binding: { secretRef: secret } }
    }
    if (isPlainObject(secret) && typeof secret.id === 'string' && secret.id.length > 0) {
      const version = secret.version
      if (version !== undefined && typeof version !== 'string') {
        return { ok: false, error: 'secretRef.version must be a string' }
      }
      return {
        ok: true,
        binding: { secretRef: version ? { id: secret.id, version } : { id: secret.id } }
      }
    }
    return { ok: false, error: 'secretRef must be an id string or { id, version? }' }
  }

  if ('template' in value) {
    if (typeof value.template !== 'string' || value.template.length === 0) {
      return { ok: false, error: 'template binding requires a non-empty string' }
    }
    if (value.template.length > 8000) {
      return { ok: false, error: 'template binding is too long' }
    }
    return { ok: true, binding: { template: value.template } }
  }

  if ('compose' in value) {
    if (value.compose === 'object') {
      if (!isPlainObject(value.fields)) {
        return { ok: false, error: 'compose object requires fields' }
      }
      return parseWorkflowBinding(value.fields, depth + 1)
    }
    if (value.compose === 'array') {
      if (!Array.isArray(value.items)) {
        return { ok: false, error: 'compose array requires items' }
      }
      return parseWorkflowBinding(value.items, depth + 1)
    }
    return { ok: false, error: 'Unknown compose kind' }
  }

  const ref = value.ref
  if (ref === 'input') {
    if (typeof value.pointer !== 'string' || !isJsonPointer(value.pointer)) {
      return { ok: false, error: 'input binding requires a JSON pointer' }
    }
    return { ok: true, binding: { ref: 'input', pointer: value.pointer } }
  }
  if (ref === 'node') {
    if (typeof value.nodeId !== 'string' || value.nodeId.length === 0) {
      return { ok: false, error: 'node binding requires nodeId' }
    }
    if (typeof value.pointer !== 'string' || !isJsonPointer(value.pointer)) {
      return { ok: false, error: 'node binding requires a JSON pointer' }
    }
    return { ok: true, binding: { ref: 'node', nodeId: value.nodeId, pointer: value.pointer } }
  }
  if (ref === 'loop') {
    if (typeof value.pointer !== 'string' || !isJsonPointer(value.pointer)) {
      return { ok: false, error: 'loop binding requires a JSON pointer' }
    }
    return { ok: true, binding: { ref: 'loop', pointer: value.pointer } }
  }
  if (ref === 'item') {
    const pointer = value.pointer
    if (pointer !== undefined && (typeof pointer !== 'string' || !isJsonPointer(pointer))) {
      return { ok: false, error: 'item binding pointer must be a JSON pointer' }
    }
    return { ok: true, binding: { ref: 'item', pointer } }
  }
  if (ref === 'index') {
    return { ok: true, binding: { ref: 'index' } }
  }
  return { ok: false, error: `Unknown binding ref "${String(ref)}"` }
}

const TEMPLATE_PLACEHOLDER = /\{\{\s*([a-zA-Z][\w.-]*)\s*\}\}/g

export function listTemplatePlaceholders(template: string): string[] {
  const names: string[] = []
  for (const match of template.matchAll(TEMPLATE_PLACEHOLDER)) {
    names.push(match[1]!)
  }
  return names
}

export function bindingNodeRefs(binding: WorkflowBinding): string[] {
  if ('compose' in binding) {
    if (binding.compose === 'object') return Object.values(binding.fields).flatMap(bindingNodeRefs)
    return binding.items.flatMap(bindingNodeRefs)
  }
  if ('ref' in binding && binding.ref === 'node') return [binding.nodeId]
  if ('template' in binding) {
    return listTemplatePlaceholders(binding.template)
      .filter((name) => name.startsWith('node.'))
      .map((name) => name.split('.')[1]!)
      .filter(Boolean)
  }
  return []
}
