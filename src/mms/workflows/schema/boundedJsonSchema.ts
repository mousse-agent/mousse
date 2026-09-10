import {
  BOUNDED_JSON_SCHEMA_ALLOWED_KEYS,
  BOUNDED_JSON_SCHEMA_REJECTED_KEYS,
  BOUNDED_JSON_SCHEMA_TYPES,
  WORKFLOW_MAX_ARRAY_ITEMS,
  WORKFLOW_MAX_SCHEMA_DEFS,
  WORKFLOW_MAX_SCHEMA_DEPTH,
  WORKFLOW_MAX_SCHEMA_ENUM,
  WORKFLOW_MAX_SCHEMA_PROPERTIES,
  WORKFLOW_MAX_STRING_LENGTH,
  diagnostic,
  hasPrototypePollutingKey,
  isFiniteInteger,
  isFiniteNumber,
  isPlainObject,
  type BoundedJsonSchema,
  type BoundedJsonSchemaType,
  type WorkflowDiagnostic
} from '../../../shared/workflows'

/**
 * BoundedJsonSchemaSubsetValidator
 *
 * Validates workflow JSON Schema documents and instance data against the v1
 * allowed keyword set (objects/arrays/strings/numbers/booleans/enums/required/
 * bounded lengths/local $defs). It is intentionally not a JSON Schema
 * implementation and must not be described as ajv/draft-07/2020-12 compliant.
 *
 * Foundation (WG0) should pin `ajv` as a direct production dependency if full
 * JSON Schema evaluation is required. Transitive copies of ajv are not used.
 */
export interface BoundedSchemaDocumentResult {
  ok: boolean
  schema?: BoundedJsonSchema
  diagnostics: WorkflowDiagnostic[]
}

export interface BoundedSchemaDataResult {
  ok: boolean
  diagnostics: WorkflowDiagnostic[]
}

const LOCAL_DEF_REF = /^#\/(?:\$defs|definitions)\/([^/#]+)$/

export class BoundedJsonSchemaSubsetValidator {
  validateDocument(
    schema: unknown,
    path = '/inputSchema'
  ): BoundedSchemaDocumentResult {
    const diagnostics: WorkflowDiagnostic[] = []
    const normalized = this.normalizeDocument(schema, path, 0, diagnostics, new Set())
    return {
      ok: diagnostics.every((item) => item.severity !== 'error') && normalized !== undefined,
      schema: normalized,
      diagnostics
    }
  }

  validateData(
    schema: BoundedJsonSchema,
    data: unknown,
    path = '/'
  ): BoundedSchemaDataResult {
    const diagnostics: WorkflowDiagnostic[] = []
    this.match(schema, schema, data, path, diagnostics, new Set())
    return { ok: diagnostics.every((item) => item.severity !== 'error'), diagnostics }
  }

  private normalizeDocument(
    schema: unknown,
    path: string,
    depth: number,
    diagnostics: WorkflowDiagnostic[],
    refStack: Set<string>
  ): BoundedJsonSchema | undefined {
    if (depth > WORKFLOW_MAX_SCHEMA_DEPTH) {
      diagnostics.push(diagnostic('SCHEMA_TOO_COMPLEX', `Schema exceeds max depth at ${path}`, { path }))
      return undefined
    }
    if (!isPlainObject(schema)) {
      diagnostics.push(diagnostic('INVALID_SCHEMA', `Schema at ${path} must be an object`, { path }))
      return undefined
    }
    for (const key of Object.keys(schema)) {
      if (hasPrototypePollutingKey(key)) {
        diagnostics.push(diagnostic('PROTOTYPE_KEY', `Prototype key "${key}" at ${path}`, { path }))
        return undefined
      }
      if (BOUNDED_JSON_SCHEMA_REJECTED_KEYS.has(key)) {
        const code = key === '$id' || key.includes('Ref') || key === '$schema' ? 'REMOTE_SCHEMA_REF' : 'INVALID_SCHEMA'
        const message =
          key === 'pattern' || key === 'patternProperties'
            ? `Keyword "${key}" is rejected (ReDoS / unbounded patterns) at ${path}`
            : `Unsupported JSON Schema keyword "${key}" at ${path}`
        diagnostics.push(diagnostic(code, message, { path }))
      } else if (!BOUNDED_JSON_SCHEMA_ALLOWED_KEYS.has(key)) {
        diagnostics.push(
          diagnostic('INVALID_SCHEMA', `Unknown schema keyword "${key}" at ${path}`, { path })
        )
      }
    }

    const ref = schema.$ref
    if (ref !== undefined) {
      if (typeof ref !== 'string') {
        diagnostics.push(diagnostic('INVALID_SCHEMA', `$ref must be a string at ${path}`, { path }))
        return undefined
      }
      if (/^https?:/i.test(ref) || ref.startsWith('//') || !ref.startsWith('#/')) {
        diagnostics.push(
          diagnostic('REMOTE_SCHEMA_REF', `Remote or non-local $ref "${ref}" at ${path}`, { path })
        )
        return undefined
      }
      if (!LOCAL_DEF_REF.test(ref)) {
        diagnostics.push(
          diagnostic('INVALID_SCHEMA', `$ref must target #/$defs/Name or #/definitions/Name at ${path}`, {
            path
          })
        )
      }
    }

    const out: BoundedJsonSchema = {}
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type]
      for (const t of types) {
        if (!BOUNDED_JSON_SCHEMA_TYPES.includes(t as BoundedJsonSchemaType)) {
          diagnostics.push(diagnostic('INVALID_SCHEMA', `Unsupported type "${String(t)}" at ${path}`, { path }))
        }
      }
      out.type = schema.type as BoundedJsonSchema['type']
    }
    if (typeof schema.title === 'string') out.title = schema.title
    if (typeof schema.description === 'string') out.description = schema.description
    if (schema.const !== undefined) {
      if (!isJsonScalar(schema.const)) {
        diagnostics.push(diagnostic('INVALID_SCHEMA', `const must be a scalar at ${path}`, { path }))
      } else {
        out.const = schema.const
      }
    }
    if (schema.enum !== undefined) {
      if (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > WORKFLOW_MAX_SCHEMA_ENUM) {
        diagnostics.push(diagnostic('INVALID_SCHEMA', `enum is missing or too large at ${path}`, { path }))
      } else if (!schema.enum.every(isJsonScalar)) {
        diagnostics.push(diagnostic('INVALID_SCHEMA', `enum values must be scalars at ${path}`, { path }))
      } else {
        out.enum = schema.enum as BoundedJsonSchema['enum']
      }
    }
    copyBound(schema, out, 'minLength', path, diagnostics, 0, WORKFLOW_MAX_STRING_LENGTH)
    copyBound(schema, out, 'maxLength', path, diagnostics, 0, WORKFLOW_MAX_STRING_LENGTH)
    copyBound(schema, out, 'minItems', path, diagnostics, 0, WORKFLOW_MAX_ARRAY_ITEMS)
    copyBound(schema, out, 'maxItems', path, diagnostics, 0, WORKFLOW_MAX_ARRAY_ITEMS)
    copyNumber(schema, out, 'minimum', path, diagnostics)
    copyNumber(schema, out, 'maximum', path, diagnostics)
    copyNumber(schema, out, 'exclusiveMinimum', path, diagnostics)
    copyNumber(schema, out, 'exclusiveMaximum', path, diagnostics)

    if (schema.required !== undefined) {
      if (
        !Array.isArray(schema.required) ||
        !schema.required.every((item) => typeof item === 'string') ||
        schema.required.length > WORKFLOW_MAX_SCHEMA_PROPERTIES
      ) {
        diagnostics.push(diagnostic('INVALID_SCHEMA', `required must be a string[] at ${path}`, { path }))
      } else {
        out.required = schema.required as string[]
      }
    }

    if (schema.properties !== undefined) {
      if (!isPlainObject(schema.properties)) {
        diagnostics.push(diagnostic('INVALID_SCHEMA', `properties must be an object at ${path}`, { path }))
      } else {
        const keys = Object.keys(schema.properties)
        if (keys.length > WORKFLOW_MAX_SCHEMA_PROPERTIES) {
          diagnostics.push(diagnostic('SCHEMA_TOO_COMPLEX', `Too many properties at ${path}`, { path }))
        }
        const properties: Record<string, BoundedJsonSchema> = {}
        for (const key of keys) {
          if (hasPrototypePollutingKey(key)) {
            diagnostics.push(diagnostic('PROTOTYPE_KEY', `Prototype property name at ${path}`, { path }))
            continue
          }
          const child = this.normalizeDocument(
            schema.properties[key],
            `${path}/properties/${key}`,
            depth + 1,
            diagnostics,
            refStack
          )
          if (child) properties[key] = child
        }
        out.properties = properties
      }
    }

    if (schema.additionalProperties !== undefined) {
      if (typeof schema.additionalProperties === 'boolean') {
        out.additionalProperties = schema.additionalProperties
      } else {
        const child = this.normalizeDocument(
          schema.additionalProperties,
          `${path}/additionalProperties`,
          depth + 1,
          diagnostics,
          refStack
        )
        if (child) out.additionalProperties = child
      }
    }

    if (schema.items !== undefined) {
      const child = this.normalizeDocument(schema.items, `${path}/items`, depth + 1, diagnostics, refStack)
      if (child) out.items = child
    }

    for (const defsKey of ['$defs', 'definitions'] as const) {
      const defs = schema[defsKey]
      if (defs === undefined) continue
      if (!isPlainObject(defs)) {
        diagnostics.push(diagnostic('INVALID_SCHEMA', `${defsKey} must be an object at ${path}`, { path }))
        continue
      }
      const keys = Object.keys(defs)
      if (keys.length > WORKFLOW_MAX_SCHEMA_DEFS) {
        diagnostics.push(diagnostic('SCHEMA_TOO_COMPLEX', `Too many ${defsKey} at ${path}`, { path }))
      }
      const normalizedDefs: Record<string, BoundedJsonSchema> = {}
      for (const key of keys) {
        if (hasPrototypePollutingKey(key)) {
          diagnostics.push(diagnostic('PROTOTYPE_KEY', `Prototype $defs name at ${path}`, { path }))
          continue
        }
        const child = this.normalizeDocument(
          defs[key],
          `${path}/${defsKey}/${key}`,
          depth + 1,
          diagnostics,
          refStack
        )
        if (child) normalizedDefs[key] = child
      }
      if (defsKey === '$defs') out.$defs = normalizedDefs
      else out.definitions = normalizedDefs
    }

    if (typeof ref === 'string') out.$ref = ref
    return out
  }

  private match(
    root: BoundedJsonSchema,
    schema: BoundedJsonSchema,
    data: unknown,
    path: string,
    diagnostics: WorkflowDiagnostic[],
    refStack: Set<string>
  ): void {
    if (schema.$ref) {
      if (refStack.has(schema.$ref)) {
        diagnostics.push(
          diagnostic('SCHEMA_TOO_COMPLEX', `Recursive local $ref ${schema.$ref} at ${path}`, { path })
        )
        return
      }
      const resolved = resolveLocalRef(root, schema.$ref)
      if (!resolved) {
        diagnostics.push(diagnostic('INVALID_SCHEMA', `Unresolved $ref ${schema.$ref} at ${path}`, { path }))
        return
      }
      refStack.add(schema.$ref)
      this.match(root, resolved, data, path, diagnostics, refStack)
      refStack.delete(schema.$ref)
      return
    }

    if (schema.const !== undefined && data !== schema.const) {
      diagnostics.push(diagnostic('INVALID_SCHEMA', `Value at ${path} does not match const`, { path }))
    }
    if (schema.enum && !schema.enum.some((item) => Object.is(item, data))) {
      diagnostics.push(diagnostic('INVALID_SCHEMA', `Value at ${path} is not in enum`, { path }))
    }

    const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type]
    if (types.length > 0 && !types.some((t) => matchesType(t, data))) {
      diagnostics.push(
        diagnostic('INVALID_SCHEMA', `Value at ${path} does not match type ${types.join('|')}`, { path })
      )
      return
    }

    if (typeof data === 'string') {
      if (schema.minLength !== undefined && data.length < schema.minLength) {
        diagnostics.push(diagnostic('INVALID_SCHEMA', `String at ${path} is shorter than minLength`, { path }))
      }
      if (schema.maxLength !== undefined && data.length > schema.maxLength) {
        diagnostics.push(diagnostic('INVALID_SCHEMA', `String at ${path} exceeds maxLength`, { path }))
      }
    }

    if (typeof data === 'number') {
      if (schema.minimum !== undefined && data < schema.minimum) {
        diagnostics.push(diagnostic('INVALID_SCHEMA', `Number at ${path} is below minimum`, { path }))
      }
      if (schema.maximum !== undefined && data > schema.maximum) {
        diagnostics.push(diagnostic('INVALID_SCHEMA', `Number at ${path} is above maximum`, { path }))
      }
      if (schema.exclusiveMinimum !== undefined && data <= schema.exclusiveMinimum) {
        diagnostics.push(diagnostic('INVALID_SCHEMA', `Number at ${path} is not above exclusiveMinimum`, { path }))
      }
      if (schema.exclusiveMaximum !== undefined && data >= schema.exclusiveMaximum) {
        diagnostics.push(diagnostic('INVALID_SCHEMA', `Number at ${path} is not below exclusiveMaximum`, { path }))
      }
    }

    if (Array.isArray(data)) {
      if (schema.minItems !== undefined && data.length < schema.minItems) {
        diagnostics.push(diagnostic('INVALID_SCHEMA', `Array at ${path} is shorter than minItems`, { path }))
      }
      if (schema.maxItems !== undefined && data.length > schema.maxItems) {
        diagnostics.push(diagnostic('INVALID_SCHEMA', `Array at ${path} exceeds maxItems`, { path }))
      }
      if (data.length > WORKFLOW_MAX_ARRAY_ITEMS) {
        diagnostics.push(diagnostic('SCHEMA_TOO_COMPLEX', `Array at ${path} exceeds engine item bound`, { path }))
      }
      if (schema.items) {
        data.forEach((item, index) => {
          this.match(root, schema.items!, item, `${path}${path.endsWith('/') ? '' : '/'}${index}`, diagnostics, refStack)
        })
      }
    }

    if (isPlainObject(data)) {
      for (const key of Object.keys(data)) {
        if (hasPrototypePollutingKey(key)) {
          diagnostics.push(diagnostic('PROTOTYPE_KEY', `Prototype key in data at ${path}`, { path }))
        }
      }
      const required = schema.required ?? []
      for (const key of required) {
        if (!(key in data)) {
          diagnostics.push(diagnostic('INVALID_SCHEMA', `Missing required property ${key} at ${path}`, { path }))
        }
      }
      const properties = schema.properties ?? {}
      for (const [key, value] of Object.entries(data)) {
        if (properties[key]) {
          this.match(root, properties[key], value, joinPath(path, key), diagnostics, refStack)
        } else if (schema.additionalProperties === false) {
          diagnostics.push(
            diagnostic('INVALID_SCHEMA', `Additional property "${key}" is not allowed at ${path}`, { path })
          )
        } else if (isPlainObject(schema.additionalProperties)) {
          this.match(root, schema.additionalProperties, value, joinPath(path, key), diagnostics, refStack)
        }
      }
    }
  }
}

function joinPath(path: string, key: string): string {
  if (path === '/' || path === '') return `/${key}`
  return `${path}/${key}`
}

function isJsonScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
}

function matchesType(type: BoundedJsonSchemaType, data: unknown): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(data)
    case 'array':
      return Array.isArray(data)
    case 'string':
      return typeof data === 'string'
    case 'number':
      return typeof data === 'number' && Number.isFinite(data)
    case 'integer':
      return typeof data === 'number' && Number.isInteger(data)
    case 'boolean':
      return typeof data === 'boolean'
    case 'null':
      return data === null
    default:
      return false
  }
}

function copyBound(
  source: Record<string, unknown>,
  out: BoundedJsonSchema,
  key: 'minLength' | 'maxLength' | 'minItems' | 'maxItems',
  path: string,
  diagnostics: WorkflowDiagnostic[],
  min: number,
  max: number
): void {
  if (source[key] === undefined) return
  if (!isFiniteInteger(source[key]) || source[key] < min || source[key] > max) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', `${key} out of bounds at ${path}`, { path }))
    return
  }
  out[key] = source[key]
}

function copyNumber(
  source: Record<string, unknown>,
  out: BoundedJsonSchema,
  key: 'minimum' | 'maximum' | 'exclusiveMinimum' | 'exclusiveMaximum',
  path: string,
  diagnostics: WorkflowDiagnostic[],
): void {
  if (source[key] === undefined) return
  if (!isFiniteNumber(source[key])) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', `${key} must be a finite number at ${path}`, { path }))
    return
  }
  out[key] = source[key]
}

function resolveLocalRef(root: BoundedJsonSchema, ref: string): BoundedJsonSchema | undefined {
  const match = LOCAL_DEF_REF.exec(ref)
  if (!match) return undefined
  const name = match[1]!
  if (ref.startsWith('#/$defs/')) return root.$defs?.[name]
  return root.definitions?.[name]
}

export const boundedJsonSchemaSubsetValidator = new BoundedJsonSchemaSubsetValidator()
