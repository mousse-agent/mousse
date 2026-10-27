import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import type { BotManifest, BotThreadSpec } from '../../../shared/bots/personal/definition'
import { BOT_APP_TOOLS, canonicalManifest, intersectManifest, narrowManifest } from '../../../shared/bots/personal/manifest'
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

/** The permissions one thread of an activation holds: the grant, narrowed by the thread. */
export interface BotPermissions {
  tools: NeutralTool[]
  appTools: string[]
  mcp: Array<`${string}::${string}`>
  skills: string[]
  workspace: { roots: string[]; access: 'read' | 'write'; scratch: string } | null
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
  // Shell needs a proven sandbox on this runtime and platform; no runtime has that evidence yet.
  if (manifest.tools.includes('shell'))
    return unenforceable('Shell commands need a proven sandbox, and this runtime has none here.', ['containment'])
  const scratch = real(input.scratch)
  const profile = real(input.profileHome)
  if (manifest.workspace) {
    const temps = (input.temps ?? systemTempDirs()).map(real)
    for (const root of manifest.workspace.roots.map(real)) {
      if (inside(root, scratch) || inside(scratch, root))
        return unenforceable(`The folder ${root} overlaps the bot's private scratch folder.`)
      if (inside(root, profile)) return unenforceable(`The folder ${root} contains Mousse's own data. Choose a folder inside it instead.`)
      if (inside(profile, root)) return unenforceable(`The folder ${root} is inside Mousse's own data.`)
      if (manifest.workspace.access === 'write' && temps.some((temp) => inside(temp, root)))
        return unenforceable(`The folder ${root} is inside a temporary folder. Move the folder out of the temporary folder.`)
    }
  }
  const native = input.nativeNames(manifest.tools)
  if (!native.ok) return native
  const { deadlineMs, ...counts } = input.remaining
  const budget: NonNullable<BindPolicy['budget']> = { maxWallMs: deadlineMs }
  for (const key of ['maxTurns', 'maxToolCalls', 'maxInputTokens', 'maxOutputTokens', 'maxUsd'] as const)
    if (counts[key] !== undefined) budget[key] = counts[key]
  const appTools = [...new Set(manifest.appTools)].sort()
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
      workspace: manifest.workspace ? { roots: [...manifest.workspace.roots], access: manifest.workspace.access, scratch } : null
    }
  }
}
