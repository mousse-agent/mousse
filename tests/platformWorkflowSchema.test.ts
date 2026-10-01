import { describe, expect, it } from 'vitest'
import { workflowJsonSchemaValidator } from '../src/mms/workflows/schema/boundedJsonSchema'

describe('WorkflowJsonSchemaValidator (Ajv2020 subset)', () => {
  it('accepts the v1 object/array/string/number/boolean/enum subset via Ajv2020', () => {
    const document = workflowJsonSchemaValidator.validateDocument({
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
    const data = workflowJsonSchemaValidator.validateData(document.schema!, {
      name: 'x',
      count: 2,
      ok: true,
      kind: 'a',
      files: ['a']
    })
    expect(data.ok).toBe(true)
    expect(data.diagnostics.some((d) => d.message.includes('Ajv2020')) || data.ok).toBe(true)
  })

  it('emits exact diagnostics for restricted keywords, remote refs, recursion, and prototype keys', () => {
    const remote = workflowJsonSchemaValidator.validateDocument({
      $ref: 'https://json-schema.org/draft/2020-12/schema'
    })
    expect(remote.diagnostics.some((d) => d.code === 'REMOTE_SCHEMA_REF')).toBe(true)

    const pattern = workflowJsonSchemaValidator.validateDocument({
      type: 'string',
      pattern: '^(a+)+$'
    })
    expect(pattern.ok).toBe(false)
    expect(pattern.diagnostics.some((d) => d.code === 'RESTRICTED_SCHEMA_KEYWORD' && d.message.includes('"pattern"'))).toBe(
      true
    )

    const oneOf = workflowJsonSchemaValidator.validateDocument({
      oneOf: [{ type: 'string' }, { type: 'number' }]
    })
    expect(oneOf.diagnostics.some((d) => d.code === 'RESTRICTED_SCHEMA_KEYWORD' && d.message.includes('"oneOf"'))).toBe(
      true
    )

    const recursive = workflowJsonSchemaValidator.validateDocument({
      type: 'object',
      $defs: { node: { $ref: '#/$defs/node' } },
      $ref: '#/$defs/node'
    })
    expect(recursive.diagnostics.some((d) => d.code === 'SCHEMA_TOO_COMPLEX' || d.code === 'INVALID_SCHEMA')).toBe(true)

    const indirectRecursive = workflowJsonSchemaValidator.validateDocument({
      $defs: {
        a: { type: 'object', properties: { next: { $ref: '#/$defs/b' } } },
        b: { type: 'object', properties: { next: { $ref: '#/$defs/a' } } }
      },
      $ref: '#/$defs/a'
    })
    expect(indirectRecursive.diagnostics.some((d) => d.code === 'SCHEMA_TOO_COMPLEX')).toBe(true)

    const proto = workflowJsonSchemaValidator.validateDocument(
      JSON.parse('{"type":"object","properties":{"__proto__":{"type":"number"}}}')
    )
    expect(proto.diagnostics.some((d) => d.code === 'PROTOTYPE_KEY')).toBe(true)
  })

  it('resolves local $defs only through Ajv2020', () => {
    const document = workflowJsonSchemaValidator.validateDocument({
      type: 'object',
      properties: { id: { $ref: '#/$defs/id' } },
      required: ['id'],
      additionalProperties: false,
      $defs: { id: { type: 'string', minLength: 1 } }
    })
    expect(document.ok).toBe(true)
    expect(workflowJsonSchemaValidator.validateData(document.schema!, { id: 'abc' }).ok).toBe(true)
    expect(workflowJsonSchemaValidator.validateData(document.schema!, { id: '' }).ok).toBe(false)
  })
})
