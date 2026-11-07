import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import { foldersOf, type BotManifest, type BotThreadSpec } from '../../../shared/bots/personal/definition'
import { BOT_APP_TOOLS, canonicalManifest, intersectManifest, narrowManifest } from '../../../shared/bots/personal/manifest'
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
   * `writeRoots`: the roots the bot may change (per-folder access). `files`: the bot's files folder,
   * writable beside the roots like scratch; never one of `roots`, so it is never listed as a permission.
   */
  workspace: { roots: string[]; access: 'read' | 'write'; writeRoots?: string[]; scratch: string; files?: string } | null
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
  /** System temporary folders (default: `systemTempDirs()`). */
  temps?: readonly string[]
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
  const profile = real(input.profileHome)
  const files = input.filesFolder !== undefined ? real(input.filesFolder) : undefined
  if (files !== undefined) {
    // Only Mousse's own place for it: a files folder anywhere else would be a root nobody approved.
    const home = real(join(input.profileHome, 'bots', 'files'))
    if (files === home || !inside(home, files)) return unenforceable("The bot's files folder is not where Mousse keeps bots' files.")
    if (inside(files, scratch) || inside(scratch, files)) return unenforceable("The bot's files folder overlaps its private scratch folder.")
  }
  if (manifest.workspace) {
    const temps = (input.temps ?? systemTempDirs()).map(real)
    const writable = new Set(foldersOf(manifest.workspace).filter(([, access]) => access === 'write').map(([root]) => real(root)))
    for (const root of manifest.workspace.roots.map(real)) {
      if (inside(root, scratch) || inside(scratch, root))
        return unenforceable(`The folder ${root} overlaps the bot's private scratch folder.`)
      // The files folder itself, by exact path, is the one folder inside Mousse's data a bot may name.
      if (root === files) continue
      if (inside(root, profile)) return unenforceable(`The folder ${root} contains Mousse's own data. Choose a folder inside it instead.`)
      if (inside(profile, root)) return unenforceable(`The folder ${root} is inside Mousse's own data.`)
      if (writable.has(root) && temps.some((temp) => inside(temp, root)))
        return unenforceable(`The folder ${root} is inside a temporary folder. Move the folder out of the temporary folder.`)
    }
  }
  const native = input.nativeNames(manifest.tools)
  if (!native.ok) return native
  const { deadlineMs, ...counts } = input.remaining
  const budget: NonNullable<BindPolicy['budget']> = { maxWallMs: deadlineMs }
  for (const key of ['maxTurns', 'maxToolCalls', 'maxInputTokens', 'maxOutputTokens', 'maxUsd'] as const)
    if (counts[key] !== undefined) budget[key] = counts[key]
  // Granted skills come with the skill tools that list and load them.
  const appTools = [...new Set([
    ...manifest.appTools,
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
      workspace: manifest.workspace || files !== undefined
        ? {
            roots: manifest.workspace ? manifest.workspace.roots.filter((root) => real(root) !== files) : [],
            access: manifest.workspace?.access ?? 'read',
            writeRoots: foldersOf(manifest.workspace).filter(([root, access]) => access === 'write' && real(root) !== files).map(([root]) => root),
            scratch,
            ...(files !== undefined ? { files } : {})
          }
        : null
    }
  }
}
