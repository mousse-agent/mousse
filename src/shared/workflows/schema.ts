/**
 * v1 workflow JSON Schema contract evaluated by Ajv2020.
 *
 * Supported keywords: type, properties, required, additionalProperties, items,
 * min/max length and items, minimum/maximum, enum, const, local $defs/$ref.
 * Restricted keywords (pattern, oneOf/anyOf/allOf, remote $ref, unevaluated*,
 * dynamic/recursive refs, format, etc.) produce exact RESTRICTED_SCHEMA_KEYWORD
 * or REMOTE_SCHEMA_REF diagnostics. This is not a claim that every JSON Schema
 * document is supported.
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
