import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ActiveTimeScope, BotAllowedObserver, BotAuthority, BotCheck, BotThreadRole, NormalisedCall, WallReason } from '../../../shared/bots/personal/authority'
import { BOT_COMPUTER_OPEN, type BotComputerLimit } from '../../../shared/bots/personal/computerLimit'
import { BOT_BROWSER_PERMISSION, BOT_THREADS_PERMISSION, botGrantTool } from '../../../shared/bots/personal/manifest'
import type { CounterScope } from '../../../shared/harness/counters'
import type { SpendScope } from '../../../shared/harness/spend'
import type { NeutralTool } from '../../../shared/harness/tools'
import { assertInsideRoots } from '../../agents/WorkspaceAccessPolicy'
import { touchesGitMetadata } from '../../agents/gitMetadata'
import { localPathOf } from '../../data/closedPlaces'
import type { BotPermissions } from '../grants/compile'

/**
 * A bot activation's authority over one turn (PR 6 §4), checked on every call by each check point:
 * Pi's `/pi/gate` for built-ins, the Mousse MCP registry for app and proxied MCP tools, Claude Code's
 * grant gate (its hooks and `canUseTool`), and Codex's approval requests. It asks nobody: a call outside the grant stops at a wall. The bot's
 * files folder (Bot Phase 1 §5.10) counts as a granted writable root, and every allowed call is
 * reported to `onAllowed`, the source of activity chips (§5.8). What this computer lets bots do (`limit`, read on
 * every call) comes before the grant: a call it has switched off is refused (a `computer` wall), never asked about.
 */

/** The arguments that name a path, on every runtime (Pi's and Claude's built-ins). */
export const PATH_ARGUMENTS = ['path', 'file_path', 'filePath', 'notebook_path', 'directory', 'dir', 'cwd'] as const

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
  /** Told of every call the check allows, whatever the runtime (`BotActivitySink.observer`). Never fails a call. */
  onAllowed?: BotAllowedObserver
  /**
   * What this computer lets bots do now (Settings → What bots may do here), read on every call, so a switch turned off
   * refuses the next call of a turn already running. Absent: everything. Must not throw.
   */
  disabled?(call: NormalisedCall): string | undefined
  limit?(): BotComputerLimit
}

export function createBotAuthority(input: BotAuthorityInput): BotAuthority {
  const { permissions } = input
  const tools: ReadonlySet<NeutralTool> = new Set(permissions.tools)
  const appTools: ReadonlySet<string> = new Set(permissions.appTools)
  const skills: ReadonlySet<string> = new Set(permissions.skills)
  const mcp: ReadonlySet<`${string}::${string}`> = new Set(permissions.mcp)
  // Without per-folder access every root has the workspace's access. The files folder is one more
  // writable root, granted with the bot itself.
  const workspace = permissions.workspace ? workspaceWithFiles(permissions.workspace) : null
  const readOnlyRoots = workspace ? workspace.roots.filter((root) => !workspace.writeRoots.includes(root)) : []
  const authority: BotAuthority = {
    activationId: input.activationId,
    role: input.role,
    tools,
    appTools,
    skills,
    mcp,
    workspace: workspace ? {
      roots: [...workspace.roots], access: workspace.access, writeRoots: [...workspace.writeRoots], scratch: workspace.scratch,
      ...(permissions.workspace?.files !== undefined ? { files: permissions.workspace.files } : {})
    } : null,
    waiting: input.waiting,
    counters: input.counters,
    time: input.time,
    spend: input.spend,
    check(call: NormalisedCall): BotCheck {
      const decided = decide(call)
      if (decided.ok && input.onAllowed) {
        try {
          input.onAllowed(call)
        } catch {
          // Chips are a view of the calls; they never decide one.
        }
      }
      return decided
    }
  }
  return authority

  function decide(call: NormalisedCall): BotCheck {
    const disabled = input.disabled?.(call)
    if (disabled) return { ok: false, refused: { text: disabled, askId: '' } }
    const ended = input.live?.() ?? (input.time.signal.aborted ? { kind: 'ended' as const } : undefined)
    if (ended) return { ok: false, wall: ended }
    if (input.waiting()) return { ok: false, wall: { kind: 'waiting' } }
    const limit = input.limit?.() ?? BOT_COMPUTER_OPEN
    switch (call.kind) {
      case 'skill':
        return skills.has(call.skill) ? { ok: true } : { ok: false, wall: { kind: 'skill', skill: call.skill } }
      case 'mcp':
        // Granted parts never hold `:`, so a call whose parts do can never match another pair.
        return !call.server.includes(':') && !call.tool.includes(':') && mcp.has(`${call.server}::${call.tool}`)
          ? { ok: true }
          : { ok: false, wall: { kind: 'mcp', server: call.server, tool: call.tool, ...(call.serverName ? { serverName: call.serverName } : {}) } }
      case 'app':
        // The browser switched off on this computer: none of its tools runs, whatever the grant holds.
        if (!limit.browser && botGrantTool(call.tool) === BOT_BROWSER_PERMISSION) return { ok: false, wall: { kind: 'computer', tool: call.tool, off: 'browser' } }
        // The owner's threads switched off on this computer: no thread tool runs, whatever the grant or this turn holds.
        if (!limit.threads && botGrantTool(call.tool) === BOT_THREADS_PERMISSION) return { ok: false, wall: { kind: 'computer', tool: call.tool, off: 'threads' } }
        return appTools.has(call.tool) ? { ok: true } : { ok: false, wall: { kind: 'tool', tool: call.tool } }
      case 'builtin':
        return checkBuiltin(call.tool, call.nativeName, call.args, limit, call.own)
    }
  }

  function checkBuiltin(tool: NeutralTool, nativeName: string, args: Record<string, unknown>, limit: BotComputerLimit, own?: true): { ok: true } | { ok: false; wall: WallReason } {
    // This computer's switches come before the grant: what is off here is refused, and never asked for.
    if (tool === 'shell' && !limit.shell) return { ok: false, wall: { kind: 'computer', tool: nativeName, off: 'shell' } }
    if (!tools.has(tool)) return { ok: false, wall: { kind: 'tool', tool: nativeName } }
    // "Run commands" is granted as a whole: any command, wherever it says it runs. What a command
    // can reach is the runtime's sandbox, where it has one, not a path check here.
    if (tool === 'shell') return { ok: true }
    if (NETWORK_TOOLS.has(tool)) return { ok: true }
    // The runtime's own storage for this bot (Claude Code's saved tool output), which its gate
    // recognised: the runtime reading back what it wrote is never a question for the owner.
    if (own) return { ok: true }
    const writes = WRITE_TOOLS.has(tool)
    const access = writes ? 'write' : 'read'
    // A path the runtime itself expands is read only after this check, so it is never inside a
    // root. It is refused with how to write it, never asked about, in every branch below: no
    // permission would let the bot use it as written.
    const expanded = PATH_ARGUMENTS.map((key) => args[key]).find((value): value is string => typeof value === 'string' && runtimeExpandedPath(value))
    if (expanded !== undefined) return { ok: false, wall: pathFormWall(nativeName, expanded) }
    // A network path to this computer is checked as the local path it means; one that can't be turned into it is refused.
    const local = localArguments(args)
    if ('refused' in local) return { ok: false, wall: { kind: 'network_path', tool: nativeName, path: local.refused } }
    args = local.args
    // Without a workspace the bot has no folder at all, not even its scratch folder.
    if (!workspace) return { ok: false, wall: { kind: 'path', tool: nativeName, path: String(firstPath(args) ?? '.'), access } }
    const scratch = workspace.scratch
    const paths = PATH_ARGUMENTS.map((key) => args[key]).filter((value): value is string => typeof value === 'string')
    // A file tool with no path argument works in its working directory: the scratch folder.
    if (!paths.length) return { ok: true }
    for (const raw of paths) {
      // Git metadata is never a file tool's to change, in the scratch folder or a root (`agents/gitMetadata`).
      if (writes && touchesGitMetadata(raw, scratch)) return { ok: false, wall: { kind: 'path', tool: nativeName, path: raw, access } }
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
      // Write access is per folder: the path must sit inside a root granted for writing, and not
      // inside a read-only root (a write folder nested in a read folder stays read-only, as the
      // shell sandbox denies it too).
      if (writes) {
        try {
          assertInsideRoots(workspace.writeRoots, raw, scratch)
        } catch {
          return { ok: false, wall: { kind: 'path', tool: nativeName, path: raw, access } }
        }
        if (readOnlyRoots.length && insideAny(readOnlyRoots, raw, scratch)) return { ok: false, wall: { kind: 'path', tool: nativeName, path: raw, access } }
      }
    }
    return { ok: true }
  }
}

/**
 * A call's path arguments with every network path to this computer turned into the local path it means (Windows,
 * `localPathOf`), or the first that can't be turned into one with certainty. Elsewhere, as they are.
 */
function localArguments(args: Record<string, unknown>, platform: NodeJS.Platform = process.platform): { args: Record<string, unknown> } | { refused: string } {
  if (platform !== 'win32') return { args }
  let out = args
  for (const key of PATH_ARGUMENTS) {
    const value = args[key]
    if (typeof value !== 'string') continue
    const local = localPathOf(value)
    if (local.kind === 'refused') return { refused: value }
    if (local.kind === 'local') out = { ...out, [key]: local.path }
  }
  return { args: out }
}

/**
 * Whether a runtime rewrites `raw` before it opens it, so the path checked here is not the one it
 * would use: a home folder (`~`, `~user`; Claude Code and Pi expand it), Pi's leading `@`, a
 * variable (`$HOME`, `${HOME}`, `%USERPROFILE%`), or on Windows Claude Code's `/c/...` drive form.
 * Such a path is refused rather than expanded here: the bot names its folders by their real paths.
 *
 * So is any spelling a runtime or the file system reads differently from Node's `resolve`:
 * - whitespace around the path (Claude Code's resolver starts with JS `trim()`, so `' ../x'` or
 *   `'<root>\\.. '` would leave the folder that `resolve` keeps it in);
 * - a NUL or other control character;
 * - a segment ending in a space or a dot other than `.` and `..` themselves (`'.. '`, `'x.'`),
 *   which Windows drops when it opens the path.
 */
export function runtimeExpandedPath(raw: string, platform: NodeJS.Platform = process.platform): boolean {
  if (raw !== raw.trim()) return true
  if (/[\u0000-\u001f\u007f]/.test(raw)) return true
  if (raw.split(/[\\/]/).some((segment) => segment !== '.' && segment !== '..' && /[ .]$/.test(segment))) return true
  if (/^[~@]/.test(raw)) return true
  if (/\$(\{|[A-Za-z_])/.test(raw)) return true
  if (platform === 'win32') {
    const local = localPathOf(raw)
    const path = local.kind === 'local' ? local.path : raw.replace(/^\\\\[^\\]+\\[^\\]+/, '')
    if (/:/.test(path.replace(/^[A-Za-z]:/, ''))) return true
  }
  if (platform === 'win32' && (/%[^%\\/]+%/.test(raw) || /^\/[A-Za-z](\/|$)/.test(raw))) return true
  return false
}

/**
 * The refusal for a path a runtime would rewrite: it names the owner's home folder by its real
 * path, and for `~/…` or `$HOME/…` the full path the bot meant. A hint only: the full path is
 * checked like any other when the bot uses it.
 */
export function pathFormWall(tool: string, raw: string, home: string = homedir()): WallReason {
  const trimmed = raw.trim()
  if (!/^[~%]/.test(trimmed) && !trimmed.includes('$')) return { kind: 'path_form', tool, path: raw }
  const rest = /^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%)(?:[\\/]+(.*))?$/s.exec(trimmed)
  const full = rest ? (rest[1] ? join(home, rest[1]) : home) : undefined
  return { kind: 'path_form', tool, path: raw, home, ...(full !== undefined ? { full } : {}) }
}

/** The compiled workspace as the authority checks it: the files folder joins the roots, writable. */
function workspaceWithFiles(workspace: NonNullable<BotPermissions['workspace']>): { roots: string[]; access: 'read' | 'write'; writeRoots: string[]; scratch: string } {
  const writeRoots = workspace.writeRoots ?? (workspace.access === 'write' ? workspace.roots : [])
  const files = workspace.files
  return {
    roots: files !== undefined ? [...workspace.roots, files] : [...workspace.roots],
    access: workspace.access,
    writeRoots: files !== undefined ? [...writeRoots, files] : [...writeRoots],
    scratch: workspace.scratch
  }
}

function firstPath(args: Record<string, unknown>): unknown {
  for (const key of PATH_ARGUMENTS) if (typeof args[key] === 'string') return args[key]
  return undefined
}

function insideAny(roots: readonly string[], raw: string, scratch: string): boolean {
  try {
    assertInsideRoots(roots, raw, scratch)
    return true
  } catch {
    return false
  }
}
