import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { actionOf } from '../../shared/permissionKeys'
import { stableStringify } from './json'

/**
 * The fingerprint of an approval request: what a one-shot grant after a restart is matched against
 * (SPEC §17.5). An answer given after a restart authorizes the same action once, in the run it
 * started, and nothing else, so the fingerprint covers everything that changes what the action does.
 *
 * `action` is the whole tool input minus a short list of presentation-only fields (known only for the
 * shell tools, where `description` is a label), with explicit
 * defaults filled in for optional fields that change the mutation: an omitted and an explicit default
 * match, any other difference does not. A field nobody listed is part of the hash, so a newly added
 * field is never silently dropped from the comparison. An input that does not have the shape the
 * tool declares gets no fingerprint at all, and with it no grant: the agent asks again.
 */

export interface FingerprintInput {
  instanceId: string
  cwd?: string
  /** `src/shared/permissionKeys.ts` */
  permissionKey: string
  toolName: string
  /** The call's input as the provider made it. */
  input: unknown
}

interface Canonicalizer {
  /** Fields that must be present with the given primitive type, or the input has no valid shape. */
  required?: Record<string, 'string' | 'number' | 'boolean' | 'array'>
  /** Presentation-only fields: they do not change what the action does. */
  drop?: string[]
  /** Optional fields that change the mutation, with the value the tool uses when they are omitted. */
  defaults?: Record<string, unknown>
  /** An array of sub-inputs (`MultiEdit.edits`) canonicalized the same way. */
  each?: { key: string; required: Record<string, 'string' | 'number' | 'boolean' | 'array'>; defaults?: Record<string, unknown> }
}

const SHELL: Canonicalizer = { required: { command: 'string' }, drop: ['description'] }

/** Claude's built-in tools whose inputs are known; anything else uses `GENERIC`. */
const CLAUDE_TOOLS: Record<string, Canonicalizer> = {
  Bash: SHELL,
  PowerShell: SHELL,
  Edit: { required: { file_path: 'string', old_string: 'string', new_string: 'string' }, defaults: { replace_all: false } },
  MultiEdit: { required: { file_path: 'string', edits: 'array' }, each: { key: 'edits', required: { old_string: 'string', new_string: 'string' }, defaults: { replace_all: false } } },
  Write: { required: { file_path: 'string', content: 'string' } },
  NotebookEdit: { required: { notebook_path: 'string', new_source: 'string' }, defaults: { edit_mode: 'replace' } }
}

/**
 * Any other tool: the whole input. Nothing is dropped, because only a tool's own schema says which
 * field is a label: for a ticket tool, `description` is the content being changed.
 */
const GENERIC: Canonicalizer = {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasShape(input: Record<string, unknown>, required: Record<string, string> | undefined): boolean {
  for (const [key, type] of Object.entries(required ?? {})) {
    const value = input[key]
    if (type === 'array' ? !Array.isArray(value) : typeof value !== type) return false
  }
  return true
}

function canonicalize(input: Record<string, unknown>, canon: Canonicalizer): Record<string, unknown> | null {
  if (!hasShape(input, canon.required)) return null
  const out: Record<string, unknown> = { ...(canon.defaults ?? {}) }
  for (const [key, value] of Object.entries(input)) if (!canon.drop?.includes(key)) out[key] = value
  if (canon.each) {
    const items = out[canon.each.key]
    if (!Array.isArray(items)) return null
    const each: Record<string, unknown>[] = []
    for (const item of items) {
      if (!isRecord(item) || !hasShape(item, canon.each.required)) return null
      each.push({ ...(canon.each.defaults ?? {}), ...item })
    }
    out[canon.each.key] = each
  }
  return out
}

/** The canonical action of a call, or null when the call cannot be fingerprinted. */
export function canonicalAction(permissionKey: string, toolName: string, input: unknown): unknown | null {
  // A Mousse tool acts on state that changes between the question and its continuation (an integration
  // merges whatever the delegation holds then), so no argument list describes what was approved.
  if (permissionKey.startsWith('mousse:')) return null
  // ACP: the agent's own description of the call, as given. A request without one, or with an empty one (`{}`, a
  // string, a list), describes nothing and has no fingerprint.
  if (permissionKey.startsWith('acp:')) return isRecord(input) && Object.keys(input).length > 0 ? input : null
  if (!isRecord(input)) return null
  const canon = permissionKey.startsWith('claude:') ? CLAUDE_TOOLS[toolName] ?? GENERIC : GENERIC
  return canonicalize(input, canon)
}

/** The SHA-256 of the canonical action and where it runs, or null when there is no stable action. */
export function approvalFingerprint(input: FingerprintInput): string | null {
  // A command or an edit is relative to the directory it runs in: without it the action is not identified.
  if (actionOf(input.permissionKey) !== 'tool' && !input.cwd) return null
  const action = canonicalAction(input.permissionKey, input.toolName, input.input)
  if (action === null) return null
  const text = stableStringify({
    instanceId: input.instanceId,
    cwd: input.cwd ?? null,
    permissionKey: input.permissionKey,
    toolName: input.toolName,
    action
  })
  return createHash('sha256').update(text).digest('hex')
}

/**
 * The directory a command a provider asks about will start in, as an exact path, or undefined when that cannot be
 * said. The provider starts it where it proposed, so a path with dot segments (which `resolve` would collapse into
 * another folder, e.g. through a link) is not pinned down; a relative one is under the turn's directory, which must
 * itself be a plain absolute path.
 */
export function exactDirectory(turnCwd: string | undefined, named: string | null | undefined): string | undefined {
  const raw = named && named.trim() ? named : turnCwd
  const dotted = (path: string): boolean => path.split(/[\\/]+/).some((segment) => segment === '.' || segment === '..')
  if (!raw || dotted(raw)) return undefined
  if (isAbsolute(raw)) return raw
  if (!turnCwd || !isAbsolute(turnCwd) || dotted(turnCwd)) return undefined
  return join(turnCwd, raw)
}
