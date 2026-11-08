import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { foldersOf, type BotManifest, type BotThreadSpec } from '../../../shared/bots/personal/definition'
import { BOT_APP_TOOLS, BOT_BROWSER_PERMISSION, BOT_BROWSER_TOOLS, canonicalManifest, intersectManifest, narrowManifest } from '../../../shared/bots/personal/manifest'
import { BOT_MEMORY_TOOLS } from '../../../shared/bots/personal/memory'
import type { NeutralTool } from '../../../shared/harness/tools'
import type { BindPolicy, HarnessCaps, HarnessError } from '../../../shared/harness/types'
import { stableStringify } from '../../run/json'

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
   * write, and Mousse's own data folder (`closed`) shut but for the files folder and scratch.
   */
  workspace: { roots: string[]; access: 'read' | 'write'; writeRoots?: string[]; scratch: string; files?: string; computer?: { closed: string } } | null
  /** "Use the browser": `appTools` holds the browser tools, on the bot's own browser. */
  browser?: true
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
   * `memory_*` tools (Bot Phase 1 §5.10), always on and never grantable, so a bot whose stored
   * grant predates them has them too.
   */
  botTools?: { escalate: boolean; consult: boolean; memory?: boolean }
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
  const manifest = narrowManifest(input.revision ? intersectManifest(input.revision, input.grant) : input.grant, input.thread.narrow)
  // Checked again here, so a grant stored before a tool was refused can never widen later.
  const refusedApp = manifest.appTools.find((tool) => !BOT_APP_TOOLS.has(tool))
  if (refusedApp !== undefined) return unenforceable(`The Mousse tool ${refusedApp} would reach other threads, act in your name or ask you.`)
  // The user's MCP tools do not reach Pi's RPC engine yet, so a grant naming one cannot be held as approved.
  if (manifest.mcp.length) return unenforceable('Your MCP tools are not available to bots yet.', ['mcp'])
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
  // Granted skills come with the skill tools that list and load them; the browser is its tools.
  const browser = manifest.appTools.includes(BOT_BROWSER_PERMISSION)
  const appTools = [...new Set([
    ...manifest.appTools.filter((tool) => tool !== BOT_BROWSER_PERMISSION),
    ...(browser ? BOT_BROWSER_TOOLS : []),
    ...(manifest.skills.length ? ['list_skills', 'load_skill'] : []),
    ...(input.botTools?.escalate ? ['escalate'] : []),
    ...(input.botTools?.consult ? ['consult'] : []),
    ...(input.botTools?.memory ? BOT_MEMORY_TOOLS : [])
  ])].sort()
  const mcp = [...new Set(manifest.mcp.map((pair) => `${pair.serverId}::${pair.tool}` as const))].sort()
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
      workspace: computer || files !== undefined
        ? {
            roots: computer ?? [],
            access: computer ? 'write' : 'read',
            writeRoots: computer ?? [],
            scratch,
            ...(files !== undefined ? { files } : {}),
            ...(computer ? { computer: { closed: real(mousseDataFolder(input.profileHome)) } } : {})
          }
        : null
    }
  }
}
