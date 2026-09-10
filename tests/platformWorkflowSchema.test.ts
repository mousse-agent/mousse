import { describe, expect, it } from 'vitest'
import { boundedJsonSchemaSubsetValidator } from '../src/mms/workflows/schema/boundedJsonSchema'

describe('BoundedJsonSchemaSubsetValidator', () => {
  it('accepts the v1 object/array/string/number/boolean/enum subset', () => {
    const document = boundedJsonSchemaSubsetValidator.validateDocument({
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 32 },
        count: { type: 'integer', minimum: 0, maximum: 10 },
        ok: { type: 'boolean' },
        kind: { enum: ['a', 'b'] },
        files: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 }
      },
      required: ['name'],
      additionalProperties: false,
      $defs: {
        inner: { type: 'string' }
      }
    })
    expect(document.ok).toBe(true)
    const data = boundedJsonSchemaSubsetValidator.validateData(document.schema!, {
      name: 'x',
      count: 2,
      ok: true,
      kind: 'a',
      files: ['a']
    })
    expect(data.ok).toBe(true)
  })

  it('rejects remote refs, patterns, recursion, and prototype keys', () => {
    expect(
      boundedJsonSchemaSubsetValidator.validateDocument({
        $ref: 'https://json-schema.org/draft/2020-12/schema'
      }).diagnostics.some((d) => d.code === 'REMOTE_SCHEMA_REF')
    ).toBe(true)

    expect(
      boundedJsonSchemaSubsetValidator.validateDocument({
        type: 'string',
        pattern: '^(a+)+$'
      }).ok
    ).toBe(false)

    const recursive = boundedJsonSchemaSubsetValidator.validateDocument({
      type: 'object',
      $defs: { node: { $ref: '#/$defs/node' } },
      $ref: '#/$defs/node'
    })
    const matched = boundedJsonSchemaSubsetValidator.validateData(recursive.schema ?? { $ref: '#/$defs/node', $defs: { node: { $ref: '#/$defs/node' } } }, {})
    expect(matched.diagnostics.some((d) => d.code === 'SCHEMA_TOO_COMPLEX' || d.code === 'INVALID_SCHEMA')).toBe(true)

    const proto = boundedJsonSchemaSubsetValidator.validateDocument(
      JSON.parse('{"type":"object","properties":{"__proto__":{"type":"number"}}}')
    )
    expect(proto.diagnostics.some((d) => d.code === 'PROTOTYPE_KEY')).toBe(true)
  })

  it('resolves local $defs only', () => {
    const document = boundedJsonSchemaSubsetValidator.validateDocument({
      type: 'object',
      properties: { id: { $ref: '#/$defs/id' } },
      required: ['id'],
      additionalProperties: false,
      $defs: { id: { type: 'string', minLength: 1 } }
    })
    expect(document.ok).toBe(true)
    expect(boundedJsonSchemaSubsetValidator.validateData(document.schema!, { id: 'abc' }).ok).toBe(true)
    expect(boundedJsonSchemaSubsetValidator.validateData(document.schema!, { id: '' }).ok).toBe(false)
  })
})
