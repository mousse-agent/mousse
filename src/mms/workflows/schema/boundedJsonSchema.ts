import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js'
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
 * Ajv2020 validator for the v1 supported JSON Schema subset.
 *
 * Instance data is evaluated by pinned Ajv 8 (draft 2020-12). Schema documents
 * are first constrained: bounded depth/size, local $ref only, no remote loading,
 * and restricted keywords emit exact diagnostics. Arbitrary JSON Schema is not
 * claimed to be supported.
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

function createAjv(): Ajv2020 {
  return new Ajv2020({
    allErrors: true,
    strict: false,
    validateSchema: false,
    addUsedSchema: false,
    inlineRefs: true,
    loadSchema: undefined,
    validateFormats: false,
    unicodeRegExp: false,
    code: { source: false, optimize: false }
  })
}

export class WorkflowJsonSchemaValidator {
  private readonly ajv = createAjv()

  validateDocument(
    schema: unknown,
    path = '/inputSchema'
  ): BoundedSchemaDocumentResult {
    const diagnostics: WorkflowDiagnostic[] = []
    const normalized = this.normalizeDocument(schema, path, 0, diagnostics, new Set())
    if (!normalized || diagnostics.some((item) => item.severity === 'error')) {
      return { ok: false, schema: normalized, diagnostics }
    }
    try {
      this.ajv.compile(normalized)
    } catch (error) {
      diagnostics.push(
        diagnostic(
          'INVALID_SCHEMA',
          `Ajv2020 rejected schema at ${path}: ${error instanceof Error ? error.message : String(error)}`,
          { path }
        )
      )
    }
    return {
      ok: diagnostics.every((item) => item.severity !== 'error'),
      schema: normalized,
      diagnostics
    }
  }

  validateData(
    schema: BoundedJsonSchema,
    data: unknown,
    path = '/'
  ): BoundedSchemaDataResult {
    const document = this.validateDocument(schema, path)
    if (!document.ok || !document.schema) {
      return { ok: false, diagnostics: document.diagnostics }
    }
    const diagnostics: WorkflowDiagnostic[] = [...document.diagnostics]
    let validate
    try {
      validate = this.ajv.compile(document.schema)
    } catch (error) {
      diagnostics.push(
        diagnostic(
          'INVALID_SCHEMA',
          `Ajv2020 compile failed at ${path}: ${error instanceof Error ? error.message : String(error)}`,
          { path }
        )
      )
      return { ok: false, diagnostics }
    }
    const ok = validate(data)
    if (!ok && validate.errors) {
      for (const error of validate.errors) {
        diagnostics.push(mapAjvError(error, path))
      }
    }
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
        const remote = key === '$id' || key === '$schema' || key.includes('Ref') || key.includes('Anchor')
        diagnostics.push(
          diagnostic(
            remote ? 'REMOTE_SCHEMA_REF' : 'RESTRICTED_SCHEMA_KEYWORD',
            remote
              ? `Remote or identity keyword "${key}" is not allowed at ${path}`
              : `Restricted JSON Schema keyword "${key}" at ${path}`,
            { path }
          )
        )
      } else if (!BOUNDED_JSON_SCHEMA_ALLOWED_KEYS.has(key)) {
        diagnostics.push(
          diagnostic('RESTRICTED_SCHEMA_KEYWORD', `Unknown schema keyword "${key}" at ${path}`, { path })
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
      if (refStack.has(ref)) {
        diagnostics.push(diagnostic('SCHEMA_TOO_COMPLEX', `Recursive local $ref ${ref} at ${path}`, { path }))
        return undefined
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
        const nextStack = new Set(refStack)
        if (typeof ref === 'string') nextStack.add(ref)
        const child = this.normalizeDocument(
          defs[key],
          `${path}/${defsKey}/${key}`,
          depth + 1,
          diagnostics,
          nextStack
        )
        if (child) normalizedDefs[key] = child
      }
      if (defsKey === '$defs') out.$defs = normalizedDefs
      else out.definitions = normalizedDefs
    }

    if (typeof ref === 'string') {
      const resolvedName = LOCAL_DEF_REF.exec(ref)?.[1]
      const defs = out.$defs ?? out.definitions
      if (resolvedName && defs?.[resolvedName]?.$ref === ref) {
        diagnostics.push(diagnostic('SCHEMA_TOO_COMPLEX', `Recursive local $ref ${ref} at ${path}`, { path }))
      }
      out.$ref = ref
    }
    return out
  }
}

function mapAjvError(error: ErrorObject, fallbackPath: string): WorkflowDiagnostic {
  const instancePath = error.instancePath || fallbackPath
  return diagnostic('INVALID_SCHEMA', `Ajv2020: ${error.message ?? 'invalid'} at ${instancePath}`, {
    path: instancePath
  })
}

function isJsonScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
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
  diagnostics: WorkflowDiagnostic[]
): void {
  if (source[key] === undefined) return
  if (!isFiniteNumber(source[key])) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', `${key} must be a finite number at ${path}`, { path }))
    return
  }
  out[key] = source[key]
}

export const workflowJsonSchemaValidator = new WorkflowJsonSchemaValidator()

/** @deprecated Use WorkflowJsonSchemaValidator; kept for W01 call sites. */
export class BoundedJsonSchemaSubsetValidator extends WorkflowJsonSchemaValidator {}
export const boundedJsonSchemaSubsetValidator = workflowJsonSchemaValidator
