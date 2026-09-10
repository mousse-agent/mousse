/**
 * Bounded JSON Schema subset used by workflow input/output/node schemas.
 *
 * This is NOT full JSON Schema. Remote $ref, $dynamicRef, pattern, oneOf/anyOf/allOf,
 * unevaluated*, recursive schemas, and expensive keywords are rejected. Pin `ajv`
 * as a direct dependency (see handoff) before claiming draft-07/2020-12 compliance.
 */
export type BoundedJsonSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null'

export interface BoundedJsonSchema {
  type?: BoundedJsonSchemaType | BoundedJsonSchemaType[]
  title?: string
  description?: string
  properties?: Record<string, BoundedJsonSchema>
  required?: string[]
  additionalProperties?: boolean | BoundedJsonSchema
  items?: BoundedJsonSchema
  minItems?: number
  maxItems?: number
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  enum?: Array<string | number | boolean | null>
  const?: string | number | boolean | null
  $defs?: Record<string, BoundedJsonSchema>
  definitions?: Record<string, BoundedJsonSchema>
  $ref?: string
}

export const BOUNDED_JSON_SCHEMA_TYPES: readonly BoundedJsonSchemaType[] = [
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null'
]

export const BOUNDED_JSON_SCHEMA_ALLOWED_KEYS = new Set([
  'type',
  'title',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'enum',
  'const',
  '$defs',
  'definitions',
  '$ref'
])

export const BOUNDED_JSON_SCHEMA_REJECTED_KEYS = new Set([
  'pattern',
  'patternProperties',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'dependentRequired',
  'unevaluatedProperties',
  'unevaluatedItems',
  'prefixItems',
  'contains',
  'propertyNames',
  'format',
  '$id',
  '$schema',
  '$anchor',
  '$dynamicRef',
  '$dynamicAnchor',
  '$recursiveRef',
  '$recursiveAnchor',
  '$comment',
  'contentMediaType',
  'contentEncoding',
  'contentSchema',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'multipleOf'
])
