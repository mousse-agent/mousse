import type { BoundedJsonSchema } from './schema'
import { tokenizeWorkflowCommand } from './commandTokenizer'

/**
 * A workflow as an automation's Do: its input fields, read from its input schema, and the `/slug --input value` text
 * the scheduler runs. The daemon binds that text to the inputs the same way it binds a slash command typed in chat.
 */

export interface WorkflowInputField {
  key: string
  label: string
  type: 'string' | 'number' | 'integer' | 'boolean' | 'other'
  required: boolean
  description?: string
  options?: string[]
}

function local(schema: BoundedJsonSchema | undefined, root: BoundedJsonSchema): BoundedJsonSchema {
  const ref = schema?.$ref
  if (!ref) return schema ?? {}
  const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref)
  const target = match ? root[match[1] as '$defs' | 'definitions']?.[match[2]!] : undefined
  return target ?? {}
}

/** The fields a workflow asks for, in the order its schema lists them. A schema that is not an object has none. */
export function workflowInputFields(inputSchema: BoundedJsonSchema | undefined): WorkflowInputField[] {
  if (!inputSchema) return []
  const root = local(inputSchema, inputSchema)
  const required = new Set(root.required ?? [])
  return Object.entries(root.properties ?? {}).map(([key, raw]) => {
    const field = local(raw, inputSchema)
    const type = Array.isArray(field.type) ? field.type.find((entry) => entry !== 'null') : field.type
    const known = type === 'string' || type === 'number' || type === 'integer' || type === 'boolean' ? type : 'other'
    const options = field.enum?.filter((value): value is string => typeof value === 'string')
    return {
      key,
      label: field.title?.trim() || key,
      type: known,
      required: required.has(key),
      ...(field.description ? { description: field.description } : {}),
      ...(options?.length ? { options } : {})
    }
  })
}

/** A value as one command token: bare when it is plain, else double-quoted with `\` and `"` escaped. */
function token(value: string): string {
  if (value && /^[^\s"'\\]+$/.test(value) && !value.startsWith('--')) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** `/slug --key value …` for the inputs that have a value. A boolean is `--key` when true and left out when false. */
export function workflowCommandText(slug: string, values: Readonly<Record<string, string>>, fields: readonly WorkflowInputField[]): string {
  const parts = [`/${slug}`]
  for (const field of fields) {
    const value = values[field.key]?.trim() ?? ''
    if (field.type === 'boolean') {
      if (value === 'true') parts.push(`--${field.key}`)
      continue
    }
    if (value) parts.push(`--${field.key}`, token(value))
  }
  return parts.join(' ')
}

/** The slug and named values of `/slug --key value …`; null when the text is not one, or does not tokenize. */
export function parseWorkflowCommand(text: string): { slug: string; values: Record<string, string> } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  let tokens: ReturnType<typeof tokenizeWorkflowCommand>
  try {
    tokens = tokenizeWorkflowCommand(trimmed)
  } catch {
    return null
  }
  const slug = tokens[0]?.value.slice(1) ?? ''
  if (!slug) return null
  const values: Record<string, string> = {}
  for (let index = 1; index < tokens.length; index += 1) {
    const current = tokens[index]!
    if (current.quoted || !current.value.startsWith('--')) continue
    const [key, inline] = current.value.slice(2).split(/=(.*)/s)
    if (!key) continue
    if (inline !== undefined) { values[key] = inline; continue }
    const next = tokens[index + 1]
    if (next && (next.quoted || !next.value.startsWith('--'))) { values[key] = next.value; index += 1 }
    else values[key] = 'true'
  }
  return { slug, values }
}
