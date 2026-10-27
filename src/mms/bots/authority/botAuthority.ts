import type { ActiveTimeScope, BotAuthority, BotThreadRole, NormalisedCall, WallReason } from '../../../shared/bots/personal/authority'
import type { CounterScope } from '../../../shared/harness/counters'
import type { SpendScope } from '../../../shared/harness/spend'
import type { NeutralTool } from '../../../shared/harness/tools'
import { assertInsideRoots } from '../../agents/WorkspaceAccessPolicy'
import type { BotPermissions } from '../grants/compile'

/**
 * A bot activation's authority over one turn (PR 6 §4), checked on every call by each check point:
 * Pi's `/pi/gate` for built-ins, the Mousse MCP registry for app and proxied MCP tools (and the
 * locked Claude gate, 6b). It asks nobody: a call outside the grant stops at a wall.
 */

/** The arguments that name a path, on every runtime (Pi's and Claude's built-ins). */
const PATH_ARGUMENTS = ['path', 'file_path', 'filePath', 'notebook_path', 'directory', 'dir', 'cwd'] as const

/** Built-ins that change files: they need write access, except inside the scratch folder. */
const WRITE_TOOLS: ReadonlySet<NeutralTool> = new Set<NeutralTool>(['edit', 'write'])
/** Built-ins that never touch the file system. */
const NETWORK_TOOLS: ReadonlySet<NeutralTool> = new Set<NeutralTool>(['web_fetch', 'web_search'])

export interface BotAuthorityInput {
  activationId: string
  role: BotThreadRole
  permissions: BotPermissions
  /** Whether the activation waits for its owner's answer (`waiting_grant`), read at call time. */
  waiting(): boolean
  /**
   * Read on every call: a wall when the grant was revoked or replaced, or the activation or its
   * dispatch ended, since the turn started. Absent: always live.
   */
  live?(): WallReason | undefined
  counters: CounterScope
  time: ActiveTimeScope
  spend: SpendScope | null
}

export function createBotAuthority(input: BotAuthorityInput): BotAuthority {
  const { permissions } = input
  const tools: ReadonlySet<NeutralTool> = new Set(permissions.tools)
  const appTools: ReadonlySet<string> = new Set(permissions.appTools)
  const skills: ReadonlySet<string> = new Set(permissions.skills)
  const mcp: ReadonlySet<`${string}::${string}`> = new Set(permissions.mcp)
  const workspace = permissions.workspace
  const authority: BotAuthority = {
    activationId: input.activationId,
    role: input.role,
    tools,
    appTools,
    skills,
    mcp,
    workspace: workspace ? { roots: [...workspace.roots], access: workspace.access, scratch: workspace.scratch } : null,
    waiting: input.waiting,
    counters: input.counters,
    time: input.time,
    spend: input.spend,
    check(call: NormalisedCall): { ok: true } | { ok: false; wall: WallReason } {
      const ended = input.live?.() ?? (input.time.signal.aborted ? { kind: 'ended' as const } : undefined)
      if (ended) return { ok: false, wall: ended }
      if (input.waiting()) return { ok: false, wall: { kind: 'waiting' } }
      switch (call.kind) {
        case 'skill':
          return skills.has(call.skill) ? { ok: true } : { ok: false, wall: { kind: 'skill', skill: call.skill } }
        case 'mcp':
          // Granted parts never hold `:`, so a call whose parts do can never match another pair.
          return !call.server.includes(':') && !call.tool.includes(':') && mcp.has(`${call.server}::${call.tool}`) ? { ok: true } : { ok: false, wall: { kind: 'mcp', server: call.server, tool: call.tool } }
        case 'app':
          return appTools.has(call.tool) ? { ok: true } : { ok: false, wall: { kind: 'tool', tool: call.tool } }
        case 'builtin':
          return checkBuiltin(call.tool, call.nativeName, call.args)
      }
    }
  }
  return authority

  function checkBuiltin(tool: NeutralTool, nativeName: string, args: Record<string, unknown>): { ok: true } | { ok: false; wall: WallReason } {
    if (!tools.has(tool)) return { ok: false, wall: { kind: 'tool', tool: nativeName } }
    if (NETWORK_TOOLS.has(tool)) return { ok: true }
    const writes = WRITE_TOOLS.has(tool)
    const access = writes ? 'write' : 'read'
    // Without file access the bot has no folder at all, not even its scratch folder.
    if (!workspace) return { ok: false, wall: { kind: 'path', tool: nativeName, path: String(firstPath(args) ?? '.'), access } }
    const scratch = workspace.scratch
    const paths = PATH_ARGUMENTS.map((key) => args[key]).filter((value): value is string => typeof value === 'string')
    // A file tool with no path argument works in its working directory: the scratch folder.
    if (!paths.length) return { ok: true }
    for (const raw of paths) {
      // A path the runtime itself expands is read only after this check: never inside a root.
      if (runtimeExpandedPath(raw)) return { ok: false, wall: { kind: 'path', tool: nativeName, path: raw, access } }
      try {
        assertInsideRoots([scratch], raw, scratch)
        continue
      } catch {
        // Not in scratch: it must be in a granted root, with write access for a write.
      }
      try {
        assertInsideRoots(workspace.roots, raw, scratch)
      } catch {
        return { ok: false, wall: { kind: 'path', tool: nativeName, path: raw, access } }
      }
      if (writes && workspace.access !== 'write') return { ok: false, wall: { kind: 'path', tool: nativeName, path: raw, access } }
    }
    return { ok: true }
  }
}

/**
 * Whether a runtime rewrites `raw` before it opens it, so the path checked here is not the one it
 * would use: a home folder (`~`, `~user`; Claude Code and Pi expand it), Pi's leading `@`, a
 * variable (`$HOME`, `${HOME}`, `%USERPROFILE%`), or on Windows Claude Code's `/c/...` drive form.
 * Such a path is refused rather than expanded here: the bot names its folders by their real paths.
 */
export function runtimeExpandedPath(raw: string, platform: NodeJS.Platform = process.platform): boolean {
  const trimmed = raw.trimStart()
  if (/^[~@]/.test(trimmed)) return true
  if (/\$(\{|[A-Za-z_])/.test(trimmed)) return true
  if (platform === 'win32' && (/%[^%\\/]+%/.test(trimmed) || /^\/[A-Za-z](\/|$)/.test(trimmed))) return true
  return false
}

function firstPath(args: Record<string, unknown>): unknown {
  for (const key of PATH_ARGUMENTS) if (typeof args[key] === 'string') return args[key]
  return undefined
}
