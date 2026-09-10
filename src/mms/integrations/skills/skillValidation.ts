import Ajv, { type ErrorObject } from 'ajv'
import type { IntegrationDiagnostic } from '../../../shared/integrations'

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true })

const skillFrontmatterSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['name', 'description'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 64, pattern: NAME_PATTERN.source },
    description: { type: 'string', minLength: 1, maxLength: 1024 },
    license: { type: 'string', minLength: 1, maxLength: 256 },
    compatibility: {
      anyOf: [
        { type: 'string', minLength: 1, maxLength: 500 },
        { type: 'array', items: { type: 'string' } },
        { type: 'object' }
      ]
    },
    metadata: { type: 'object' },
    'allowed-tools': { type: 'string', maxLength: 2048 },
    'disable-model-invocation': { type: 'boolean' },
    paths: { type: 'array', items: { type: 'string' } }
  }
} as const

const validateFrontmatter = ajv.compile(skillFrontmatterSchema)

export function isValidSkillName(name: string): boolean {
  return NAME_PATTERN.test(name) && name.length <= 64
}

export function skillFrontmatterDiagnostics(
  attributes: Record<string, unknown>,
  path?: string
): IntegrationDiagnostic[] {
  const ok = validateFrontmatter(attributes)
  if (ok) return []
  return (validateFrontmatter.errors ?? []).map((error) => ({
    level: 'error' as const,
    path,
    message: formatAjvError(error)
  }))
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(String)
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function formatAjvError(error: ErrorObject): string {
  const instance = error.instancePath ? error.instancePath.replace(/^\//, '') : 'frontmatter'
  return `${instance} ${error.message ?? 'is invalid'}`.trim()
}
