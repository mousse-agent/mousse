import { isNeutralTool, type NeutralTool } from '../../harness/tools'
import type { BotBudget, BotManifest, BotPermissionLine } from './definition'

/**
 * A bot manifest's canonical form, the subset rule of approval, and the plain words the approval
 * dialog uses (PR 6 §4). Browser-safe: the digest itself is computed in the daemon.
 */

const BUDGET_KEYS = ['maxActiveMs', 'maxTurns', 'maxToolCalls', 'maxInputTokens', 'maxOutputTokens', 'maxUsd'] as const

const sorted = <T>(values: readonly T[], key: (value: T) => string): T[] => {
  const seen = new Map<string, T>()
  for (const value of values) seen.set(key(value), value)
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, value]) => value)
}

/**
 * The manifest with every list deduplicated and sorted and every absent limit dropped, so two
 * manifests that grant the same things have the same canonical JSON (and digest).
 */
export function canonicalManifest(manifest: BotManifest): BotManifest {
  const budget: BotBudget = { maxActiveMs: manifest.budget.maxActiveMs }
  for (const key of BUDGET_KEYS) if (manifest.budget[key] !== undefined) budget[key] = manifest.budget[key]
  return {
    tools: sorted(manifest.tools, (tool) => tool),
    appTools: sorted(manifest.appTools, (tool) => tool),
    mcp: sorted(manifest.mcp, (pair) => `${pair.serverId}::${pair.tool}`).map((pair) => ({ serverId: pair.serverId, tool: pair.tool })),
    skills: sorted(manifest.skills, (skill) => skill),
    workspace: manifest.workspace
      ? { roots: sorted(manifest.workspace.roots, (root) => root), access: manifest.workspace.access }
      : null,
    budget,
    audience: manifest.audience
  }
}

/** Why a manifest is malformed, or undefined when it is well formed. */
export function manifestProblem(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return 'The permissions are missing.'
  const manifest = value as Partial<BotManifest>
  const strings = (list: unknown) => Array.isArray(list) && list.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 256)
  if (!Array.isArray(manifest.tools) || !manifest.tools.every((tool) => typeof tool === 'string' && isNeutralTool(tool))) return 'A built-in tool is not one Mousse knows.'
  if (!strings(manifest.appTools)) return 'An app tool name is invalid.'
  if (!strings(manifest.skills)) return 'A skill id is invalid.'
  if (!Array.isArray(manifest.mcp) || !manifest.mcp.every((pair) => pair && typeof pair === 'object' && strings([pair.serverId, pair.tool]))) return 'An MCP tool is invalid.'
  if (manifest.workspace !== null) {
    const workspace = manifest.workspace
    if (!workspace || typeof workspace !== 'object' || !strings(workspace.roots) || workspace.roots.length === 0) return 'The bot needs at least one folder, or no file access.'
    if (workspace.access !== 'read' && workspace.access !== 'write') return 'Folder access must be read or write.'
    if (workspace.roots.some((root) => !isAbsolutePath(root))) return 'Folders must be absolute paths.'
  }
  const budget = manifest.budget
  if (!budget || typeof budget !== 'object') return 'The limits are missing.'
  for (const key of BUDGET_KEYS) {
    const limit = budget[key]
    if (limit === undefined && key !== 'maxActiveMs') continue
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return `The limit ${key} must be a positive number.`
  }
  if (manifest.audience !== 'owner') return 'Bots for other people are not available yet.'
  return undefined
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/**
 * Whether `wanted` asks for nothing beyond `granted`: every tool, app tool, MCP tool, skill and
 * root is granted, write access only where write was granted, and every limit is at most the
 * granted one (a limit the grant has and `wanted` drops is wider, so it is not a subset).
 */
export function manifestSubset(wanted: BotManifest, granted: BotManifest): boolean {
  return addedPermissions(wanted, granted).length === 0
}

/**
 * What `wanted` adds to `granted`, in plain words: the lines the approval dialog lists when a
 * revision asks for more than the active grant. Everything when nothing is granted yet.
 */
export function addedPermissions(wanted: BotManifest, granted: BotManifest | null): BotPermissionLine[] {
  if (!granted) return describeManifest(wanted)
  const lines: BotPermissionLine[] = []
  const tools = new Set(granted.tools)
  for (const tool of wanted.tools) if (!tools.has(tool)) lines.push(toolLine(tool, wanted.workspace))
  const appTools = new Set(granted.appTools)
  for (const tool of wanted.appTools) if (!appTools.has(tool)) lines.push({ kind: 'app_tool', text: `Use the Mousse tool \`${tool}\`` })
  const mcp = new Set(granted.mcp.map((pair) => `${pair.serverId}::${pair.tool}`))
  for (const pair of wanted.mcp) if (!mcp.has(`${pair.serverId}::${pair.tool}`)) lines.push(mcpLine(pair))
  const skills = new Set(granted.skills)
  for (const skill of wanted.skills) if (!skills.has(skill)) lines.push({ kind: 'skill', text: `Use the skill *${skill}*` })
  if (wanted.workspace) {
    const roots = new Set(granted.workspace?.roots ?? [])
    const writes = granted.workspace?.access === 'write'
    for (const root of wanted.workspace.roots) {
      if (!roots.has(root)) lines.push(workspaceLine(root, wanted.workspace.access))
      else if (wanted.workspace.access === 'write' && !writes) lines.push(workspaceLine(root, 'write'))
    }
  }
  for (const key of BUDGET_KEYS) {
    const limit = wanted.budget[key]
    const held = granted.budget[key]
    if (held === undefined) continue
    if (limit === undefined || limit > held) lines.push(budgetLine(key, limit))
  }
  return unique(lines)
}

/** Every permission of a manifest, in plain words. */
export function describeManifest(manifest: BotManifest): BotPermissionLine[] {
  const lines: BotPermissionLine[] = []
  if (manifest.workspace) for (const root of manifest.workspace.roots) lines.push(workspaceLine(root, manifest.workspace.access))
  for (const tool of manifest.tools) lines.push(toolLine(tool, manifest.workspace))
  for (const tool of manifest.appTools) lines.push({ kind: 'app_tool', text: `Use the Mousse tool \`${tool}\`` })
  for (const pair of manifest.mcp) lines.push(mcpLine(pair))
  for (const skill of manifest.skills) lines.push({ kind: 'skill', text: `Use the skill *${skill}*` })
  for (const key of BUDGET_KEYS) if (manifest.budget[key] !== undefined) lines.push(budgetLine(key, manifest.budget[key]))
  return unique(lines)
}

/** Each line once: a folder's access and a tool on it can say the same thing. */
function unique(lines: BotPermissionLine[]): BotPermissionLine[] {
  const seen = new Set<string>()
  return lines.filter((line) => !seen.has(line.text) && Boolean(seen.add(line.text)))
}

const TOOL_WORDS: Record<NeutralTool, string> = {
  read: 'Read files',
  list: 'List folders',
  search: 'Search files',
  edit: 'Edit files',
  write: 'Create and overwrite files',
  shell: 'Run shell commands in a sandbox',
  web_fetch: 'Fetch web pages',
  web_search: 'Search the web'
}

function toolLine(tool: NeutralTool, workspace: BotManifest['workspace']): BotPermissionLine {
  const where = workspace && tool !== 'web_fetch' && tool !== 'web_search' ? ` in ${workspace.roots.join(', ')}` : ''
  return { kind: 'tool', text: `${TOOL_WORDS[tool]}${where}` }
}

function workspaceLine(root: string, access: 'read' | 'write'): BotPermissionLine {
  return { kind: 'workspace', text: access === 'write' ? `Read and edit files in ${root}` : `Read files in ${root}` }
}

function mcpLine(pair: { serverId: string; tool: string }): BotPermissionLine {
  return { kind: 'mcp', text: `Use the ${pair.serverId} tool \`${pair.tool}\`` }
}

function budgetLine(key: (typeof BUDGET_KEYS)[number], limit: number | undefined): BotPermissionLine {
  if (limit === undefined) return { kind: 'budget', text: `No limit on ${BUDGET_WORDS[key]}` }
  if (key === 'maxActiveMs') {
    const minutes = Math.round(limit / 60_000)
    return { kind: 'budget', text: minutes >= 1 ? `Up to ${minutes} minute${minutes === 1 ? '' : 's'} of work per run` : `Up to ${Math.round(limit / 1000)} seconds of work per run` }
  }
  if (key === 'maxUsd') return { kind: 'budget', text: `Up to $${limit} per run` }
  return { kind: 'budget', text: `Up to ${limit} ${BUDGET_WORDS[key]} per run` }
}

const BUDGET_WORDS: Record<(typeof BUDGET_KEYS)[number], string> = {
  maxActiveMs: 'work time',
  maxTurns: 'model requests (retries included)',
  maxToolCalls: 'tool calls',
  maxInputTokens: 'input tokens',
  maxOutputTokens: 'output tokens',
  maxUsd: 'spend'
}

/**
 * One thread's permissions: the manifest, narrowed. `narrow` only removes: a tool, MCP tool,
 * skill or root it names that the manifest lacks is ignored, and write narrows to read only.
 */
export function narrowManifest(manifest: BotManifest, narrow: Partial<Pick<BotManifest, 'tools' | 'mcp' | 'skills' | 'workspace'>> | undefined): BotManifest {
  if (!narrow) return manifest
  const keep = <T>(values: readonly T[], allowed: readonly T[] | undefined, key: (value: T) => string): T[] => {
    if (!allowed) return [...values]
    const names = new Set(allowed.map(key))
    return values.filter((value) => names.has(key(value)))
  }
  let workspace = manifest.workspace
  if (narrow.workspace !== undefined) {
    if (narrow.workspace === null || !workspace) workspace = null
    else {
      const roots = keep(workspace.roots, narrow.workspace.roots, (root) => root)
      workspace = roots.length ? { roots, access: workspace.access === 'write' && narrow.workspace.access === 'write' ? 'write' : 'read' } : null
    }
  }
  return {
    ...manifest,
    tools: keep(manifest.tools, narrow.tools, (tool) => tool),
    mcp: keep(manifest.mcp, narrow.mcp, (pair) => `${pair.serverId}::${pair.tool}`),
    skills: keep(manifest.skills, narrow.skills, (skill) => skill),
    workspace
  }
}
