import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { foldersOf, type BotManifest, type BotThreadSpec } from '../../../shared/bots/personal/definition'
import { BOT_APP_TOOLS, BOT_APPLET_TOOL, BOT_BROWSER_PERMISSION, BOT_IMAGE_TOOL, BOT_BROWSER_TOOLS, BOT_MCP_LIST_TOOL, BOT_THREAD_ACT_TOOLS, BOT_THREAD_READ_TOOLS, BOT_THREADS_PERMISSION, BOT_WORK_ONLY_TOOLS, BOT_WORK_TOOLS, canonicalManifest, intersectManifest, narrowManifest, BOT_SUBAGENT_APP_TOOLS, BOT_SUBAGENT_TOOLS } from '../../../shared/bots/personal/manifest'
import { BOT_MEMORY_TOOLS } from '../../../shared/bots/personal/memory'
import { withinComputerLimit, type BotComputerLimit } from '../../../shared/bots/personal/computerLimit'
import type { NeutralTool } from '../../../shared/harness/tools'
import type { BindPolicy, HarnessCaps, HarnessError } from '../../../shared/harness/types'
import { stableStringify } from '../../run/json'
import { botClosedPlaces, ClosedPlacesUnknown } from '../../data/closedPlaces'

/**
 * A bot thread's grant, compiled for one dispatch (PR 6 §4). Pure: the caller supplies the native
 * tool names (`Harness.nativeToolNames`), what is left of the activation's allowance and the
 * scratch folder. The output is the binding's policy and the authority's own permissions; the
 * policy names the authority only by kind and digest.
 */

/** SHA-256 (hex) of a manifest's canonical JSON. A grant is approved by this digest. */
export function botManifestDigest(manifest: BotManifest): string {
  return createHash('sha256').update(stableStringify(canonicalManifest(manifest))).digest('hex')
}

/**
 * A bot's files folder (Bot Phase 1 §5.10): `<profileHome>/bots/files/<botId>/`, for the documents
 * and deliverables it makes. Created with the bot; no prompt reads it back, and memory lives in
 * `bots.db`, not here.
 */
export function botFilesFolder(profileHome: string, botId: string): string {
  return join(profileHome, 'bots', 'files', botId)
}

/** The permissions one thread of an activation holds: the grant, narrowed by the thread. */
export interface BotPermissions {
  tools: NeutralTool[]
  appTools: string[]
  mcp: Array<`${string}::${string}`>
  skills: string[]
  /**
   * `writeRoots`: the roots the bot may change. `files`: the bot's files folder, writable beside the
   * roots like scratch; never one of `roots`, so it is never listed as a permission. `computer`: file
   * access (bot-architecture.md §3.7), with the tops of the file system as the roots, read and
   * write, and Mousse's own data folder (`closed`) shut but for the files folder and scratch, and the places
   * `botClosedPlaces` lists outside it (`outside`).
   */
  workspace: { roots: string[]; access: 'read' | 'write'; writeRoots?: string[]; scratch: string; files?: string; computer?: { closed: string; outside?: string[] } } | null
  /** "Use the browser": `appTools` holds the browser tools, on the bot's own browser. */
  browser?: true
  /** "Use your threads": `appTools` holds the thread tools of this turn, to read (`read`) or also to start, message and stop (`all`). */
  threads?: 'read' | 'all'
}

export interface CompileInput {
  /** The active grant (what the owner approved). */
  grant: BotManifest
  /**
   * The published revision's own permissions, when the dispatch runs one: what runs is the
   * revision held inside the grant, so a narrower revision really narrows. Absent: the grant.
   */
  revision?: BotManifest
  /** The grant's digest (`botManifestDigest`). */
  digest: string
  thread: Pick<BotThreadSpec, 'narrow'>
  scratch: string
  profileHome: string
  /** The runtime's names for the thread's built-ins; a refusal is passed through. */
  nativeNames(tools: readonly NeutralTool[]): { ok: true; names: string[] } | { ok: false; error: HarnessError & { code: 'policy_unenforceable' } }
  /** What is left of the activation's counts and spend, and the dispatch's active-time deadline. */
  remaining: { maxTurns?: number; maxToolCalls?: number; maxInputTokens?: number; maxOutputTokens?: number; maxUsd?: number; deadlineMs: number }
  /** The tops of the file system file access opens (default: `computerRoots()`). */
  computer?: readonly string[]
  /**
   * The bot's files folder (`botFilesFolder`): an implicit writable root, like scratch, allowed
   * although it sits inside the profile home. Absent: none (bots made before Bot Phase 1's files folder).
   */
  filesFolder?: string
  /**
   * The bot tools the thread gets beside its grant (6c-2): `escalate` on every bot thread, and
   * `consult` on the activation thread of a bot with context threads. `memory`: the five
   * `memory_*` tools (Bot Phase 1 §5.10) and the listing of the owner's MCP servers (`mcp_servers`), always on and
   * never grantable, so a bot whose stored grant predates them has them too. `frontDesk`: a chat turn
   * (docs/plans/bot-always-free.md): it gets the work and reminder tools (`BOT_WORK_TOOLS`), and not what can take long
   * (`BOT_WORK_ONLY_TOOLS`, the browser, the owner's MCP tools), which its work runs with instead. The grant and its
   * digest stay the same: only what this turn is offered narrows.
   */
  botTools?: {
    escalate: boolean
    consult: boolean
    memory?: boolean
    frontDesk?: boolean
    /**
     * What "use your threads" gives this turn, when the grant holds it: `read` (list, search, read, wait: work, a
     * reminder's work, a schedule, a chat turn the owner's message did not start), or `all`, which adds starting,
     * messaging and stopping, only for a chat turn the owner's own message started. Absent: nothing (a consult).
     */
    threads?: 'read' | 'all'
    /** `make_image` (#1088): the owner picked a model in Runs on's Images row. Chat and work alike; never a consult or a subagent. */
    images?: boolean
    /** `publish_applet` (`BOT_APPLET_TOOL`): a main turn, chat or work, publishes applets; they need no permission. Never a consult. */
    applets?: boolean
    /**
     * A run's main turn: it may split its job among subagents (`BOT_SUBAGENT_TOOLS`), and lists the models they may run on
     * (`work_models`). Never the chat, a consult or a subagent.
     */
    subagents?: boolean
    /**
     * This turn is one of a run's subagents: it holds what its work holds of the built-ins, files, MCP tools and skills,
     * and of the app tools only the web and the browser (`subagentManifest`). Every other bot tool is left out whatever
     * the rest of `botTools` says: no asks, memory, schedules, reminders, pictures, work, threads or subagents of its own.
     */
    subagent?: true
  }
  /**
   * What this computer lets bots do (Settings → What bots may do here): what it has switched off is taken out of the
   * thread's permissions before anything is compiled, whatever the grant holds. Absent: everything.
   */
  limit?: BotComputerLimit
}

export type CompileResult =
  | { ok: true; policy: BindPolicy; permissions: BotPermissions }
  | { ok: false; error: HarnessError & { code: 'policy_unenforceable' } }

const unenforceable = (reason: string, missing: Array<keyof HarnessCaps> = ['toolControl']): CompileResult => ({
  ok: false,
  error: { code: 'policy_unenforceable', message: `This bot's permissions cannot be enforced here. ${reason}`, missing, reason }
})

function inside(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

function real(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/** The tops of this computer's file system: `/`, or every drive on Windows. */
export function computerRoots(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return ['/']
  const drives = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter) => `${letter}:\\`).filter((drive) => existsSync(drive))
  return drives.length ? drives : [parse(resolve('/')).root]
}

/**
 * Mousse's own data, closed to every bot whatever it may use: the Mousse home holding the profile
 * (`<home>/profiles/<id>`: the sign-ins, keys and data of every profile), or the profile alone
 * when it is not laid out so.
 */
export function mousseDataFolder(profileHome: string): string {
  const profiles = dirname(profileHome)
  return basename(profiles) === 'profiles' ? dirname(profiles) : profileHome
}

/**
 * What file access leaves closed: the Mousse home `closed`, and every place `botClosedPlaces` lists outside it, with the
 * homes the profile's own CLI entries are set to use. Undefined when those entries can't be read.
 */
function closedTo(closed: string, profileHome: string): { closed: string; outside: string[] } | undefined {
  try {
    return { closed, outside: botClosedPlaces({ mousseHome: closed, profileHome }) }
  } catch (error) {
    if (error instanceof ClosedPlacesUnknown) return undefined
    throw error
  }
}

/**
 * Every entry inside `folder` that is not one of `keep` and does not lead to one: at each folder on
 * the way down to them, every other entry; `folder` itself when none of `keep` is inside it. With
 * file access, a sandbox closes these (Claude Code's `denyWrite` over Mousse's data) or opens them
 * (Codex's writable roots beside it). Read when the turn starts: an entry made later in a folder
 * on the way is not among them.
 */
export function entriesBeside(folder: string, keep: readonly string[]): string[] {
  const within = (path: string, parent: string) => path.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
  if (!keep.some((path) => within(path, folder))) return [folder]
  const beside: string[] = []
  const walk = (at: string): void => {
    let names: string[]
    try {
      names = readdirSync(at)
    } catch {
      return
    }
    for (const name of names) {
      const entry = join(at, name)
      if (keep.includes(entry)) continue
      if (keep.some((path) => within(path, entry))) walk(entry)
      else beside.push(entry)
    }
  }
  walk(folder)
  return beside
}

/** The real paths of the system temporary folders, deduplicated. */
export function systemTempDirs(): string[] {
  const candidates = [tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp', '/private/tmp', '/var/tmp'])]
  return [...new Set(candidates.map(real))]
}

export function compileBotThread(input: CompileInput): CompileResult {
  const narrowed = narrowManifest(input.revision ? intersectManifest(input.revision, input.grant) : input.grant, input.thread.narrow)
  // This computer's ceiling, before the tools, the sandbox's folders and the browser are compiled from it.
  const held = input.limit ? withinComputerLimit(narrowed, input.limit) : narrowed
  // A subagent is the work, never more: what the work holds, less what is the bot's alone, and none of the bot's tools.
  const subagent = input.botTools?.subagent === true
  const own = subagent ? undefined : input.botTools
  const manifest = subagent ? subagentManifest(held) : own?.frontDesk ? frontDeskManifest(held) : held
  // Checked again here, so a grant stored before a tool was refused can never widen later.
  const refusedApp = manifest.appTools.find((tool) => !BOT_APP_TOOLS.has(tool))
  if (refusedApp !== undefined) return unenforceable(`The Mousse tool ${refusedApp} would reach other threads, act in your name or ask you.`)
  // The owner's MCP tools (granted per server, stored per tool) reach every runtime through Mousse, which checks each
  // call against these pairs before the server sees it: the MCP relay on Claude Code and Codex, the user MCP proxy on
  // Pi. Each turn is offered only the granted tools of servers set up now (`BotMcp.offered`); a chat turn none.
  // `shell` ("run commands") is one permission, granted as a whole: each runtime runs its commands
  // from the bot's files folder, in its own sandbox where it has one (bot-architecture.md §3.5).
  const scratch = real(input.scratch)
  const files = input.filesFolder !== undefined ? real(input.filesFolder) : undefined
  if (files !== undefined) {
    // Only Mousse's own place for it: a files folder anywhere else would be a root nobody approved.
    const home = real(join(input.profileHome, 'bots', 'files'))
    if (files === home || !inside(home, files)) return unenforceable("The bot's files folder is not where Mousse keeps bots' files.")
    if (inside(files, scratch) || inside(scratch, files)) return unenforceable("The bot's files folder overlaps its private scratch folder.")
  }
  // File access is one permission (§3.7): any workspace opens every folder, read and write. The
  // folders an older build's grant names are not checked or kept: they no longer narrow anything.
  const computer = manifest.workspace ? (input.computer ?? computerRoots()).map(real) : undefined
  const native = input.nativeNames(manifest.tools)
  if (!native.ok) return native
  const { deadlineMs, ...counts } = input.remaining
  const budget: NonNullable<BindPolicy['budget']> = { maxWallMs: deadlineMs }
  for (const key of ['maxTurns', 'maxToolCalls', 'maxInputTokens', 'maxOutputTokens', 'maxUsd'] as const)
    if (counts[key] !== undefined) budget[key] = counts[key]
  // Granted skills come with the skill tools that list and load them; the browser is its tools, and the owner's threads
  // are the thread tools this turn may use (none unless the caller says which).
  const browser = manifest.appTools.includes(BOT_BROWSER_PERMISSION)
  const threads = manifest.appTools.includes(BOT_THREADS_PERMISSION) ? own?.threads : undefined
  const appTools = [...new Set([
    ...manifest.appTools.filter((tool) => tool !== BOT_BROWSER_PERMISSION && tool !== BOT_THREADS_PERMISSION),
    ...(browser ? BOT_BROWSER_TOOLS : []),
    ...(threads ? BOT_THREAD_READ_TOOLS : []),
    ...(threads === 'all' ? BOT_THREAD_ACT_TOOLS : []),
    ...(manifest.skills.length ? ['list_skills', 'load_skill'] : []),
    ...(own?.escalate ? ['escalate'] : []),
    ...(own?.consult ? ['consult'] : []),
    // Always on, like memory: the listing of the owner's MCP servers, so the bot can ask for the right one.
    ...(own?.memory ? [...BOT_MEMORY_TOOLS, BOT_MCP_LIST_TOOL] : []),
    ...(own?.frontDesk ? BOT_WORK_TOOLS : []),
    ...(own?.images ? [BOT_IMAGE_TOOL] : []),
    ...(own?.applets ? [BOT_APPLET_TOOL] : []),
    // A run's main turn splits its job among subagents, on models from the same list the chat picks work's from.
    ...(own?.subagents && !own.frontDesk ? [...BOT_SUBAGENT_TOOLS, 'work_models'] : [])
  ])].sort()
  const mcp = [...new Set(manifest.mcp.map((pair) => `${pair.serverId}::${pair.tool}` as const))].sort()
  const closed = computer ? closedTo(real(mousseDataFolder(input.profileHome)), input.profileHome) : undefined
  if (computer && !closed) return unenforceable('Mousse couldn\'t read this profile\'s provider settings, so it can\'t tell which sign-ins to keep closed to this bot.', ['containment'])
  return {
    ok: true,
    policy: {
      // Built-ins by their runtime names, app tools by theirs, user MCP tools server-qualified.
      tools: { allow: [...new Set([...native.names, ...appTools, ...manifest.mcp.map((pair) => `mcp__${pair.serverId}__${pair.tool}`)])].sort() },
      approvals: 'grants',
      approve: 'host',
      budget,
      authority: { kind: 'bot', digest: input.digest }
    },
    permissions: {
      tools: [...new Set(manifest.tools)].sort(),
      appTools,
      mcp,
      skills: [...new Set(manifest.skills)].sort(),
      ...(browser ? { browser: true as const } : {}),
      ...(threads ? { threads } : {}),
      workspace: computer || files !== undefined
        ? {
            roots: computer ?? [],
            access: computer ? 'write' : 'read',
            writeRoots: computer ?? [],
            scratch,
            ...(files !== undefined ? { files } : {}),
            ...(closed ? { computer: closed } : {})
          }
        : null
    }
  }
}

const SUBAGENT_APP: ReadonlySet<string> = new Set(BOT_SUBAGENT_APP_TOOLS)

/**
 * What a run's subagent holds of what its work holds: the built-ins, file access, the owner's MCP tools and skills as
 * they are, and of the Mousse app tools only the web and the browser (`BOT_SUBAGENT_APP_TOOLS`, an allowlist, so an app
 * tool a later build makes grantable never reaches a subagent by itself). The limits stay the work's: its subagents
 * draw on the same counts, spend and time.
 */
export function subagentManifest(manifest: BotManifest): BotManifest {
  return { ...manifest, appTools: manifest.appTools.filter((tool) => SUBAGENT_APP.has(tool)) }
}

const WORK_ONLY: ReadonlySet<string> = new Set(BOT_WORK_ONLY_TOOLS)

/**
 * What a chat turn is offered of a grant: everything but what can take long, which its work does (`BOT_WORK_ONLY_TOOLS`,
 * the browser, and the owner's MCP tools).
 */
export function frontDeskManifest(manifest: BotManifest): BotManifest {
  return {
    ...manifest,
    tools: manifest.tools.filter((tool) => !WORK_ONLY.has(tool)),
    appTools: manifest.appTools.filter((tool) => !WORK_ONLY.has(tool) && tool !== BOT_BROWSER_PERMISSION),
    mcp: []
  }
}
