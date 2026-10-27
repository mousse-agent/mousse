import { isNeutralTool } from '../../harness/tools'
import { foldersOf, workspaceOf, type BotManifest } from './definition'
import { isAbsolutePath } from './manifest'

/**
 * Walls and escalations of personal bots (PR 6 §5). A wall ends the dispatch and asks the owner:
 * the bot called `escalate`, a gate refused a call, or a limit ran out. Types and pure helpers,
 * browser-safe.
 */

/** The limits a budget wall can raise for one activation. */
export const BOT_BUDGET_WALL_KEYS = ['maxActiveMs', 'maxTurns', 'maxToolCalls', 'maxInputTokens', 'maxOutputTokens', 'maxUsd'] as const
export type BotBudgetWallKey = (typeof BOT_BUDGET_WALL_KEYS)[number]

/** What a wall asks the owner to allow. */
export type BotPermissionRequest =
  | { tool: string }
  | { path: string; access: 'read' | 'write' }
  | { skill: string }
  | { mcp: { serverId: string; tool: string } }
  | { budget: { key: BotBudgetWallKey; amount?: number } }

/** How the wall was reached: the bot asked (`escalate`), a gate refused a call, or a limit ran out. */
export type BotWallKind = 'escalate' | 'gate' | 'budget'

export type BotEscalationStatus = 'open' | 'allowed_bot' | 'allowed_once' | 'denied' | 'expired' | 'cancelled'

/** The owner's answer (`bots.escalations.respond`). `allow_more` answers a budget wall. */
export type BotEscalationAnswer = 'allow_bot' | 'allow_once' | 'deny' | 'allow_more'

export const BOT_ESCALATION_ANSWERS: readonly BotEscalationAnswer[] = ['allow_bot', 'allow_once', 'deny', 'allow_more']

/** One escalation, as the Bots-tab inbox lists it. */
export interface BotEscalationSummary {
  id: string
  activationId: string
  botId: string
  /** The main dispatch that hit the wall. */
  dispatchN: number
  kind: BotWallKind
  permission: BotPermissionRequest
  /** The permission in plain words ("Read files in ~/proj/site"). */
  permissionText: string
  /** Why the bot needs it (its own words for `escalate`; Mousse's for a gate or a limit). */
  reason: string
  status: BotEscalationStatus
  createdAt: string
  expiresAt: string
  answeredAt: string | null
  /** The amount a budget wall was answered with. */
  amount: number | null
}

/** How long an open escalation waits for the owner by default. */
export const BOT_ESCALATION_TTL_MS = 30 * 60_000
/** The waits a bot may choose (30 minutes, 4 hours, 24 hours). */
export const BOT_ESCALATION_TTLS_MS: readonly number[] = [30 * 60_000, 4 * 60 * 60_000, 24 * 60 * 60_000]
/** Walls one activation may hit; the next one ends it `blocked`. */
export const MAX_BOT_WALLS = 5

const BUDGET_WORDS: Record<BotBudgetWallKey, string> = {
  maxActiveMs: 'work time',
  maxTurns: 'model requests',
  maxToolCalls: 'tool calls',
  maxInputTokens: 'input tokens',
  maxOutputTokens: 'output tokens',
  maxUsd: 'spend'
}

/** A permission request in plain words. */
export function permissionText(permission: BotPermissionRequest): string {
  if ('tool' in permission) return `Use the tool \`${permission.tool}\``
  if ('path' in permission) return permission.access === 'write' ? `Read and edit files in ${permission.path}` : `Read files in ${permission.path}`
  if ('skill' in permission) return `Use the skill *${permission.skill}*`
  if ('mcp' in permission) return `Use the ${permission.mcp.serverId} tool \`${permission.mcp.tool}\``
  const { key, amount } = permission.budget
  if (amount === undefined) return `More ${BUDGET_WORDS[key]}`
  if (key === 'maxActiveMs') return `${Math.max(1, Math.round(amount / 60_000))} more minutes of work`
  if (key === 'maxUsd') return `$${amount} more spend`
  return `${amount} more ${BUDGET_WORDS[key]}`
}

/** Why a value is not a permission request, or undefined when it is one. */
export function permissionProblem(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'The permission is missing.'
  const entry = value as Record<string, unknown>
  const keys = Object.keys(entry)
  const text = (item: unknown) => typeof item === 'string' && item.length > 0 && item.length <= 1024
  if (keys.length === 1 && keys[0] === 'tool') return text(entry.tool) ? undefined : 'The tool name is invalid.'
  if (keys.length === 1 && keys[0] === 'skill') return text(entry.skill) ? undefined : 'The skill is invalid.'
  if (keys.length === 2 && 'path' in entry && 'access' in entry) {
    if (!text(entry.path) || (entry.access !== 'read' && entry.access !== 'write')) return 'The folder permission is invalid.'
    // Never resolved against the daemon's working directory: the owner is shown the exact folder.
    return isAbsolutePath(entry.path as string) ? undefined : 'The folder must be an absolute path.'
  }
  if (keys.length === 1 && keys[0] === 'mcp') {
    const mcp = entry.mcp as Record<string, unknown> | null
    return mcp && typeof mcp === 'object' && text(mcp.serverId) && text(mcp.tool) ? undefined : 'The MCP tool is invalid.'
  }
  if (keys.length === 1 && keys[0] === 'budget') {
    const budget = entry.budget as Record<string, unknown> | null
    if (!budget || typeof budget !== 'object' || !BOT_BUDGET_WALL_KEYS.includes(budget.key as BotBudgetWallKey)) return 'The limit is invalid.'
    if (budget.amount !== undefined && (typeof budget.amount !== 'number' || !Number.isFinite(budget.amount) || budget.amount <= 0)) return 'The amount is invalid.'
    return undefined
  }
  return 'The permission is not one a bot can ask for.'
}

/**
 * `manifest` with `permission` added ("Allow for this bot" and "Allow this time"). A path adds a
 * root (and write access when asked), a tool adds a built-in or an app tool, a budget raises the
 * limit by `amount`. The result is checked like any manifest before it is published.
 */
export function withPermission(manifest: BotManifest, permission: BotPermissionRequest, amount?: number): BotManifest {
  const next: BotManifest = {
    ...manifest,
    tools: [...manifest.tools],
    appTools: [...manifest.appTools],
    mcp: manifest.mcp.map((pair) => ({ ...pair })),
    skills: [...manifest.skills],
    workspace: manifest.workspace ? { roots: [...manifest.workspace.roots], access: manifest.workspace.access } : null,
    budget: { ...manifest.budget }
  }
  if ('tool' in permission) {
    if (isNeutralTool(permission.tool)) {
      if (!next.tools.includes(permission.tool)) next.tools.push(permission.tool)
    } else if (!next.appTools.includes(permission.tool)) next.appTools.push(permission.tool)
  } else if ('path' in permission) {
    // Only this folder is added or upgraded; every other folder keeps exactly its access.
    next.workspace = workspaceOf([...foldersOf(next.workspace), [permission.path, permission.access]])
  } else if ('skill' in permission) {
    if (!next.skills.includes(permission.skill)) next.skills.push(permission.skill)
  } else if ('mcp' in permission) {
    if (!next.mcp.some((pair) => pair.serverId === permission.mcp.serverId && pair.tool === permission.mcp.tool)) next.mcp.push({ ...permission.mcp })
  } else {
    const { key } = permission.budget
    const by = amount ?? permission.budget.amount
    const held = next.budget[key]
    // A limit the bot does not have is no limit: there is nothing to raise.
    if (by !== undefined && held !== undefined) next.budget[key] = held + by
  }
  return next
}
