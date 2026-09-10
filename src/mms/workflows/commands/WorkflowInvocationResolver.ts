import {
  isPlainObject, isReservedWorkflowSlug, WORKFLOW_SLUG_PATTERN,
  type BoundedJsonSchema, type WorkflowManifest
} from '../../../shared/workflows'
import { tokenizeWorkflowCommand, type WorkflowCommandToken } from '../../../shared/workflows/commandTokenizer'
import { workflowJsonSchemaValidator } from '../schema/boundedJsonSchema'
import type { WorkflowRegistry, WorkflowRecordSnapshot } from '../registry/WorkflowRegistry'

export class WorkflowInvocationError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) { super(message); this.name = 'WorkflowInvocationError' }
}
export type WorkflowInvocation =
  | { kind: 'text'; text: string }
  | { kind: 'builtin'; name: string; original: string }
  | { kind: 'skill'; name: string; arguments: string; original: string }
  | { kind: 'unknown'; name: string; original: string }
  | { kind: 'ambiguous'; name: string; choices: string[]; original: string }
  | { kind: 'workflow'; profileId: string; definitionId: string; revisionId: string; input: Record<string, unknown>; record: WorkflowRecordSnapshot; original: string }

const unsafeKey = (key: string): boolean => ['__proto__', 'constructor', 'prototype'].includes(key)
function safeJson(text: string): unknown {
  let value: unknown
  try { value = JSON.parse(text) }
  catch { throw new WorkflowInvocationError('invalid_arguments', 'Expected valid JSON for this argument') }
  const walk = (item: unknown, depth = 0): void => {
    if (depth > 24) throw new WorkflowInvocationError('invalid_arguments', 'JSON argument is too deeply nested')
    if (typeof item === 'number' && !Number.isFinite(item)) throw new WorkflowInvocationError('invalid_arguments', 'Numeric arguments must be finite')
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      if (unsafeKey(key)) throw new WorkflowInvocationError('invalid_arguments', 'Reserved JSON property')
      walk(child, depth + 1)
    }
  }
  walk(value)
  return value
}
function dereference(schema: BoundedJsonSchema, root: BoundedJsonSchema): BoundedJsonSchema {
  const visited = new Set<string>()
  while (schema.$ref) {
    const match = /^#\/(\$defs|definitions)\/([^/#]+)$/.exec(schema.$ref)
    if (!match || visited.has(schema.$ref)) throw new WorkflowInvocationError('invalid_schema', 'Argument schema has an unsupported reference')
    visited.add(schema.$ref)
    const key = match[2].replace(/~1/g, '/').replace(/~0/g, '~')
    const definitions = match[1] === '$defs' ? root.$defs : root.definitions
    if (unsafeKey(key) || !definitions || !Object.hasOwn(definitions, key)) throw new WorkflowInvocationError('invalid_schema', 'Argument schema reference is missing')
    schema = definitions[key]
  }
  return schema
}
function parseValue(raw: string, schema: BoundedJsonSchema, root: BoundedJsonSchema): unknown {
  const resolved = dereference(schema, root)
  if (resolved.type === 'string') return raw
  return safeJson(raw)
}
function restArgument(manifest: WorkflowManifest): string | undefined {
  const mousse = manifest.extensions?.mousse
  if (!isPlainObject(mousse) || !isPlainObject(mousse.command)) return undefined
  const key = mousse.command.restArgument
  if (key === undefined) return undefined
  const properties = dereference(manifest.inputSchema, manifest.inputSchema).properties ?? {}
  if (typeof key !== 'string' || unsafeKey(key) || !Object.hasOwn(properties, key) || dereference(properties[key], manifest.inputSchema).type !== 'string') throw new WorkflowInvocationError('invalid_schema', 'Rest argument must name a declared string input')
  return key
}

export function bindWorkflowArguments(tokens: WorkflowCommandToken[], manifest: WorkflowManifest): Record<string, unknown> {
  const root = manifest.inputSchema
  const schema = dereference(root, root)
  if (schema.type !== 'object') throw new WorkflowInvocationError('invalid_schema', 'Named command arguments require an object input schema')
  const properties = schema.properties ?? {}
  const result: Record<string, unknown> = Object.create(null)
  const rest: string[] = []
  let remaining = false
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (!remaining && !token.quoted && token.value === '--') { remaining = true; continue }
    if (remaining || token.quoted || !token.value.startsWith('--')) { rest.push(token.value); continue }
    const match = /^--([^=]+)(?:=(.*))?$/s.exec(token.value)
    if (!match || unsafeKey(match[1]) || !Object.hasOwn(properties, match[1])) throw new WorkflowInvocationError('invalid_arguments', 'Unknown workflow input: ' + token.value.split('=')[0], { inputSchema: root })
    const key = match[1], field = dereference(properties[key], root)
    let raw = match[2]
    if (raw === undefined) {
      const next = tokens[index + 1]
      if (field.type === 'boolean' && (!next || (!next.quoted && next.value.startsWith('--')))) raw = 'true'
      else if (!next || (!next.quoted && next.value.startsWith('--'))) throw new WorkflowInvocationError('invalid_arguments', 'Missing value for --' + key)
      else { raw = next.value; index++ }
    }
    if (field.type === 'array') {
      const value = raw.trimStart().startsWith('[') ? safeJson(raw) : [parseValue(raw, field.items ?? {}, root)]
      if (!Array.isArray(value)) throw new WorkflowInvocationError('invalid_arguments', '--' + key + ' requires an array')
      result[key] = [...(result[key] as unknown[] | undefined ?? []), ...value]
    } else {
      if (Object.hasOwn(result, key)) throw new WorkflowInvocationError('invalid_arguments', 'Input --' + key + ' was supplied more than once')
      result[key] = parseValue(raw, field, root)
    }
  }
  if (rest.length) {
    const key = restArgument(manifest)
    if (!key) throw new WorkflowInvocationError('invalid_arguments', 'This workflow requires named arguments; choose inputs from its form', { inputSchema: root, input: result })
    if (Object.hasOwn(result, key)) throw new WorkflowInvocationError('invalid_arguments', 'Rest input was also supplied by name')
    result[key] = rest.join(' ')
  }
  const checked = workflowJsonSchemaValidator.validateData(root, result)
  if (!checked.ok) throw new WorkflowInvocationError('invalid_arguments', checked.diagnostics[0]?.message ?? 'Workflow inputs are invalid', { inputSchema: root, input: result, diagnostics: checked.diagnostics })
  return { ...result }
}

/** Shared authoritative resolver for GUI, CLI, and admitted automation ingress. No effects are started here. */
export class WorkflowInvocationResolver {
  constructor(private readonly registry: WorkflowRegistry, private readonly visibleSkillNames: () => Promise<ReadonlySet<string>> = async () => new Set()) {}

  async resolve(text: string, owner: { profileId: string }): Promise<WorkflowInvocation> {
    if (owner.profileId !== this.registry.profileId) throw new WorkflowInvocationError('profile_mismatch', 'Workflow catalog belongs to another profile')
    if (!text.startsWith('/')) return { kind: 'text', text }
    if (text.startsWith('//')) return { kind: 'text', text: text.slice(1) }
    const prefix = /^\/([^\s]+)(?:\s|$)/.exec(text)
    if (!prefix) return { kind: 'text', text }
    let name = prefix[1]
    const explicit = name === 'workflow'
    // Built-ins retain their existing parser and syntax, even if their arguments use unmatched quotes.
    if (!explicit && name !== 'skill' && isReservedWorkflowSlug(name)) return { kind: 'builtin', name, original: text }
    const tokens = tokenizeWorkflowCommand(text.slice(prefix[0].length))
    if (explicit || name === 'skill') {
      const named = tokens.shift()
      if (!named || !WORKFLOW_SLUG_PATTERN.test(named.value)) throw new WorkflowInvocationError('invalid_invocation', 'A valid workflow or skill name is required')
      if (name === 'skill') return { kind: 'skill', name: named.value, arguments: text.slice(prefix[0].length + named.end).trimStart(), original: text }
      name = named.value
    }
    if (!WORKFLOW_SLUG_PATTERN.test(name)) return { kind: 'unknown', name, original: text }
    const skillNames = await this.visibleSkillNames()
    const matches = this.registry.list().filter((entry) => entry.source === 'profile' && entry.slug === name && entry.enabled && !entry.archived)
    if (!explicit && skillNames.has(name)) {
      if (matches.length) return { kind: 'ambiguous', name, choices: ['/workflow ' + name, '/skill ' + name], original: text }
      return { kind: 'skill', name, arguments: text.slice(prefix[0].length), original: text }
    }
    if (matches.length !== 1) return matches.length ? { kind: 'ambiguous', name, choices: matches.map((entry) => entry.id), original: text } : { kind: 'unknown', name, original: text }
    let revisionId = matches[0].headRevisionId
    if (explicit) {
      let versionChosen = false
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index]
        if (token.value === '--') break
        if (token.quoted || !(token.value === '--version' || token.value.startsWith('--version='))) continue
        const value = token.value.startsWith('--version=') ? token.value.slice('--version='.length) : tokens[index + 1]?.value
        if (!value || !/^[a-f0-9]{64}$/.test(value)) throw new WorkflowInvocationError('invalid_invocation', 'Version must be a published revision hash')
        if (versionChosen) throw new WorkflowInvocationError('invalid_invocation', 'Choose only one workflow version')
        versionChosen = true
        revisionId = value
        tokens.splice(index, token.value.includes('=') ? 1 : 2)
        index--
      }
    }
    if (!revisionId) throw new WorkflowInvocationError('unpublished_workflow', 'Publish this workflow before invoking its slash command')
    const record = this.registry.getRevision(matches[0].id, revisionId)
    if (!record) throw new WorkflowInvocationError('stale_revision', 'Published workflow revision is unavailable')
    if (!record.compiled.runnable) throw new WorkflowInvocationError('invalid_workflow', 'Workflow revision cannot run', { diagnostics: record.compiled.diagnostics })
    return { kind: 'workflow', profileId: owner.profileId, definitionId: record.definitionId, revisionId, input: bindWorkflowArguments(tokens, record.bundle.manifest), record, original: text }
  }
}
