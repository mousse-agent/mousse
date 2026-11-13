import { isNeutralTool } from '../../harness/tools'
import { stableStringify } from '../../workflows/canonical'
import { foldersOf, workspaceOf, type BotManifest } from './definition'
import { BOT_BROWSER_PERMISSION, botGrantTool, isAbsolutePath } from './manifest'

/**
 * Walls and escalations of personal bots (PR 6 §5). A wall ends the dispatch and asks the owner:
 * the bot called `escalate`, a gate refused a call, or a limit ran out. Types and pure helpers,
 * browser-safe.
 */

/** The limits a budget wall can raise for one activation. */
export const BOT_BUDGET_WALL_KEYS = ['maxActiveMs', 'maxTurns', 'maxToolCalls', 'maxInputTokens', 'maxOutputTokens', 'maxUsd'] as const
export type BotBudgetWallKey = (typeof BOT_BUDGET_WALL_KEYS)[number]

/**
 * What a wall asks the owner to allow. A `path` request is file access as a whole, "use files on
 * this computer" (`filesAsk`): whichever folder it names, allowing it lets the bot read and change
 * files anywhere. Asks are written in the one form `filesAsk` returns; rows of older builds name
 * the folder that was asked about.
 */
export type BotPermissionRequest =
  | { tool: string }
  | { path: string; access: 'read' | 'write' }
  | { skill: string }
  | { mcp: BotMcpAsk }
  | { budget: { key: BotBudgetWallKey; amount?: number } }

/**
 * An ask for the owner's MCP tools: one ask per server (`serverId`: its installation and identity,
 * `<installation>.<identity>`, or the bare installation of a grant made before identities), never per tool. Mousse
 * writes it with the server's `name` and every tool a bot can be offered that the bot does not hold yet (`tools`);
 * Allow grants exactly those, each as its own pair in the grant, so a tool the server adds later is asked for again
 * (`added`: the bot already holds some of the server's tools). `changes` says what the tools' own annotations tell:
 * whether any of them can change things. A request naming one `tool` (the bot's, or an older build's row) is asked as
 * its server.
 */
export interface BotMcpAsk {
  serverId: string
  tool?: string
  name?: string
  tools?: string[]
  added?: true
  /** From the tools' read-only hints: `none` (every tool says it only reads), `some` (at least one says it can change things), `unknown`. */
  changes?: 'none' | 'some' | 'unknown'
  /** The server has not answered yet: its tools are filled in when it does; until then Allow grants nothing and is off. */
  loading?: true
  /** The server changed since the bot was allowed it (`replaces`, the id the grant holds): Allow replaces those pairs. */
  changed?: true
  replaces?: string
  /** How many of the server's tools a bot can't use (a name a grant can't hold, or a tool the relay leaves out). */
  unusable?: number
}

/**
 * An ask that grants nothing (Bot Phase 1 §5.11): `export_memory` ("Save my memory to a folder").
 * Allow opens a folder picker in the renderer, which calls `bots.memory.export`.
 */
export interface BotSpecialAsk {
  ask: 'export_memory'
}

/** What the bot may ask its owner for with `escalate`: a permission, or a special ask. */
export type BotAskRequest = BotPermissionRequest | BotSpecialAsk

export function isSpecialAsk(request: BotAskRequest): request is BotSpecialAsk {
  return 'ask' in request
}

/**
 * The fingerprint of an ask: the canonical JSON of what it asks for. There is at most one open ask
 * per bot and fingerprint, and a permission's fingerprint is its id in About → Can use. The owner's MCP tools are one
 * permission per server: whichever tools an ask lists, its fingerprint is its server's.
 */
export function askFingerprint(request: BotAskRequest): string {
  if ('mcp' in request) return stableStringify({ mcp: { serverId: request.mcp.serverId } })
  return stableStringify(request)
}

/** The tools an MCP ask grants: the ones it lists, or the one an older row names. */
export function mcpAskTools(ask: BotMcpAsk): string[] {
  return ask.tools ?? (ask.tool ? [ask.tool] : [])
}

/**
 * How an escalation waits (Bot Phase 1 §5.4). `wall`: a chat turn, the owner present; the dispatch
 * ends and the answer continues it. `ask`: an unattended run; the call is refused, the run carries
 * on without it, and the ask stays open for the owner. Neither expires.
 */
export type BotAskMode = 'wall' | 'ask'

/** After Not now on a run ask, no new ask for the same permission for this long. */
export const BOT_ASK_DENY_COOLDOWN_MS = 24 * 60 * 60_000

/** How the wall was reached: the bot asked (`escalate`), a gate refused a call, or a limit ran out. */
export type BotWallKind = 'escalate' | 'gate' | 'budget'

/** `withdrawn`: the v4 migration closed it (Bot Phase 1 §5.2), or the bot's grant moved past it. */
export type BotEscalationStatus = 'open' | 'allowed_bot' | 'allowed_once' | 'denied' | 'expired' | 'cancelled' | 'withdrawn'

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
  /** What is asked for: a permission, or an ask that grants nothing (`export_memory`). */
  permission: BotAskRequest
  /** The permission in plain words ("Read files in ~/proj/site"). */
  permissionText: string
  /** Why the bot needs it (its own words for `escalate`; Mousse's for a gate or a limit). */
  reason: string
  status: BotEscalationStatus
  createdAt: string
  /** Asks never expire (Bot Phase 1): null, except on an escalation an older build wrote. */
  expiresAt: string | null
  answeredAt: string | null
  /** The amount a budget wall was answered with. */
  amount: number | null
  /** Bot Phase 1 asks (`bots.db` v4). */
  mode?: BotAskMode
  fingerprint?: string
  /** Plain words for the card (`askText`). */
  title?: string
  note?: string
  /** The `bot_messages` row carrying the card. */
  messageId?: string
}

/** How long an open escalation waits for the owner by default. Bot Phase 1 asks don't expire. */
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

/**
 * `request` as the one permission it falls under: an ask for any browser tool (`browser_act`) is
 * "use the browser" (`{tool: 'browser'}`), so it has one card, one fingerprint and one grant.
 */
export function grantRequestOf<T extends BotAskRequest>(request: T): T {
  if (!('tool' in request) || typeof request.tool !== 'string') return request
  const tool = botGrantTool(request.tool)
  return (tool === request.tool ? request : { tool }) as T
}

/** The top of the file system `path` is on: `/`, a drive (`C:\\`) or a network share (`\\\\server\\share\\`). */
export function pathRoot(path: string): string {
  const drive = /^([A-Za-z]:)[\\/]/.exec(path)
  if (drive) return `${drive[1]!.toUpperCase()}\\`
  const share = /^\\\\([^\\/]+)[\\/]([^\\/]+)/.exec(path)
  if (share) return `\\\\${share[1]}\\${share[2]}\\`
  return '/'
}

/**
 * The one file ask (bot-architecture.md §3.7): "use files on this computer", for every folder,
 * read and write. Its folder is the top of the file system the computer starts from (`/`, or the
 * system drive on Windows), so every file ask has the same fingerprint, and an older build reading
 * the row sees a folder it can show.
 */
export function filesAsk(): { path: string; access: 'write' } {
  const scope = globalThis as { process?: { platform?: string; env?: Record<string, string | undefined> } }
  const windows = scope.process?.platform === 'win32'
  return { path: windows ? pathRoot(`${scope.process?.env?.SystemDrive ?? 'C:'}\\`) : '/', access: 'write' }
}

/** `request` as it is asked: any folder becomes the one file ask (`filesAsk`). */
export function filesAskOf<T extends BotAskRequest>(request: T): T {
  return ('path' in request ? filesAsk() : request) as T
}

/** A permission request in plain words. */
export function permissionText(permission: BotPermissionRequest): string {
  if ('tool' in permission && botGrantTool(permission.tool) === BOT_BROWSER_PERMISSION) return 'Use the browser'
  if ('tool' in permission) return `Use the tool \`${permission.tool}\``
  if ('path' in permission) return 'Use files on this computer'
  if ('skill' in permission) return `Use the skill *${permission.skill}*`
  if ('mcp' in permission) {
    if (permission.mcp.name) return permission.mcp.added ? `Use ${permission.mcp.name}'s new tools` : permission.mcp.changed ? `Use your ${permission.mcp.name} tools again` : `Use your ${permission.mcp.name} tools`
    return permission.mcp.tool ? `Use the MCP tool \`${permission.mcp.tool}\`` : 'Use the tools of an MCP server'
  }
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
    return isAbsolutePath(entry.path as string) ? undefined : 'The folder must be a full path, without . or .. parts.'
  }
  if (keys.length === 1 && keys[0] === 'mcp') {
    const mcp = entry.mcp as Record<string, unknown> | null
    if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) return 'The MCP server is invalid.'
    // The bot names the server as `mcp_servers` lists it (`server`: its name or id); Mousse writes `serverId`.
    if (!text(mcp.serverId) && !text(mcp.server)) return 'Name the MCP server, as mcp_servers lists it.'
    if (mcp.tool !== undefined && !text(mcp.tool)) return 'The MCP tool is invalid.'
    if (mcp.tools !== undefined && !(Array.isArray(mcp.tools) && mcp.tools.length <= 512 && mcp.tools.every(text))) return 'The MCP tools are invalid.'
    if (mcp.name !== undefined && !text(mcp.name)) return 'The MCP server name is invalid.'
    // Mousse's own fields: a bot's request never sets them (Mousse writes the ask from the servers as they are).
    if (mcp.loading !== undefined && mcp.loading !== true) return 'The MCP ask is invalid.'
    if (mcp.changed !== undefined && mcp.changed !== true) return 'The MCP ask is invalid.'
    if (mcp.replaces !== undefined && !text(mcp.replaces)) return 'The MCP ask is invalid.'
    if (mcp.unusable !== undefined && !(typeof mcp.unusable === 'number' && Number.isSafeInteger(mcp.unusable) && mcp.unusable >= 0)) return 'The MCP ask is invalid.'
    return undefined
  }
  if (keys.length === 1 && keys[0] === 'budget') {
    const budget = entry.budget as Record<string, unknown> | null
    if (!budget || typeof budget !== 'object' || !BOT_BUDGET_WALL_KEYS.includes(budget.key as BotBudgetWallKey)) return 'The limit is invalid.'
    if (budget.amount !== undefined && (typeof budget.amount !== 'number' || !Number.isFinite(budget.amount) || budget.amount <= 0)) return 'The amount is invalid.'
    return undefined
  }
  return 'The permission is not one a bot can ask for.'
}

/** Why a value is not something `escalate` may ask for, or undefined when it is one. */
export function askProblem(value: unknown): string | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && 'ask' in value)
    return (value as { ask: unknown }).ask === 'export_memory' ? undefined : 'The ask is not one a bot can make.'
  return permissionProblem(value)
}

/**
 * `manifest` with `permission` added ("Allow for this bot" and "Allow this time"). A path gives
 * file access as a whole (the workspace becomes the top of the file system, read and write), a
 * tool adds a built-in or an app tool, a budget raises the limit by `amount`. The result is
 * checked like any manifest before it is published.
 */
export function withPermission(manifest: BotManifest, permission: BotPermissionRequest, amount?: number): BotManifest {
  const next: BotManifest = {
    ...manifest,
    tools: [...manifest.tools],
    appTools: [...manifest.appTools],
    mcp: manifest.mcp.map((pair) => ({ ...pair })),
    skills: [...manifest.skills],
    workspace: manifest.workspace ? { ...manifest.workspace, roots: [...manifest.workspace.roots], ...(manifest.workspace.rootAccess ? { rootAccess: { ...manifest.workspace.rootAccess } } : {}) } : null,
    budget: { ...manifest.budget }
  }
  if ('tool' in permission) {
    // Any browser tool is the browser as a whole.
    const tool = botGrantTool(permission.tool)
    if (isNeutralTool(tool)) {
      if (!next.tools.includes(tool)) next.tools.push(tool)
    } else if (!next.appTools.includes(tool)) next.appTools.push(tool)
  } else if ('path' in permission) {
    // File access is one permission: whatever folder was asked about, every folder is allowed.
    next.workspace = { roots: [pathRoot(permission.path)], access: 'write' }
  } else if ('skill' in permission) {
    if (!next.skills.includes(permission.skill)) next.skills.push(permission.skill)
  } else if ('mcp' in permission) {
    // One ask per server, stored per tool: each tool the ask lists is its own pair, so a later tool is asked for again.
    // A server that changed since it was allowed: its old pairs go, so the grant holds only what the owner saw now.
    const serverId = permission.mcp.serverId
    const replaced = permission.mcp.replaces
    if (replaced && replaced !== serverId) next.mcp = next.mcp.filter((pair) => pair.serverId !== replaced)
    for (const tool of mcpAskTools(permission.mcp))
      if (!next.mcp.some((pair) => pair.serverId === serverId && pair.tool === tool)) next.mcp.push({ serverId, tool })
  } else {
    const { key } = permission.budget
    const by = amount ?? permission.budget.amount
    const held = next.budget[key]
    // A limit the bot does not have is no limit: there is nothing to raise.
    if (by !== undefined && held !== undefined) next.budget[key] = held + by
  }
  return next
}
