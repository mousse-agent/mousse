import { randomBytes } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import type { NamingOrigin } from '../harness/driver'
import { SEMANTIC_BRANCH_KINDS, branchNameFromModel, withBranchPrefix } from '../../shared/mousseBranches'
import { normalizeBranchNamingSettings, type BranchNamingSettings } from '../../shared/settings'

/**
 * Naming a thread's worktree branch after its first message, in the background.
 *
 * The worktree is made at once on `<prefix>/<random id>` (`temporaryBranchName`). Once it is ready, the profile's
 * namer gives the title model's name for it (`requestBranchName`): the answer to the request the first send made for the
 * thread's title and branch together (`OrchestratorService.nameThreadOnFirstSend`), or a request of its own. The
 * workspace renames its branch to it. Nothing waits on that: the turn starts on the temporary name, and every failure (no
 * title model, a refusal, the timeout, an answer that names nothing usable, a name already taken) leaves the temporary
 * name as it is.
 */

/** How long the title model may take to name a branch before the temporary name is kept. */
export const BRANCH_NAMING_TIMEOUT_MS = 30_000

/** The most of the first message the title model sees. */
const NAMING_TEXT_MAX = 2_000

export interface BranchNameRequest {
  threadId: string
  system: string
  prompt: string
  namingOrigin?: NamingOrigin
}

export interface BranchNamer {
  settings(): BranchNamingSettings
  /** The title model's answer to `prompt`, or undefined when there is no title model. Throws on a failed request. */
  ask(request: BranchNameRequest, signal: AbortSignal): Promise<string | undefined>
}

const namers = new Map<string, BranchNamer>()

/** The profile at `profileHome` names its threads' branches with `namer`. Returns the undo. */
export function registerBranchNamer(profileHome: string, namer: BranchNamer): () => void {
  const key = resolve(profileHome)
  namers.set(key, namer)
  return () => { if (namers.get(key) === namer) namers.delete(key) }
}

/** The namer of the profile `path` is in (its home or a thread folder inside it). */
function namerFor(path: string): BranchNamer | undefined {
  const absolute = resolve(path)
  let best: string | undefined
  for (const home of namers.keys()) {
    const child = relative(home, absolute)
    if ((child === '' || (!child.startsWith('..') && !isAbsolute(child))) && (!best || home.length > best.length)) best = home
  }
  return best ? namers.get(best) : undefined
}

/** The branch naming settings for a thread folder: its profile's, or the defaults. */
export function branchNamingFor(threadDirectory: string): BranchNamingSettings {
  try {
    return normalizeBranchNamingSettings(namerFor(threadDirectory)?.settings())
  } catch {
    return normalizeBranchNamingSettings()
  }
}

/** A new temporary branch name: the person's prefix and eight random hexadecimal digits. */
export function temporaryBranchName(prefix: string): string {
  return withBranchPrefix(prefix, randomBytes(4).toString('hex'))
}

/** How a branch name is written in the naming setting's mode: the rules every request for a branch name gives the model. */
export function branchNamingRules(settings: BranchNamingSettings): string[] {
  const rules = ['Use lowercase ASCII letters, digits and hyphens; three to six words at most; say what the work changes.']
  if (settings.mode === 'semantic') {
    rules.push(`Start with a kind and a slash, one of: ${SEMANTIC_BRANCH_KINDS.join(', ')}. For example: fix/login-button-on-safari.`)
  } else if (settings.mode === 'custom') {
    rules.push('Give the whole branch name, slashes allowed. Follow these instructions from the person:', settings.instructions.trim() || '(none)')
  } else {
    rules.push('Give only the part after the prefix, without slashes. For example: login-button-on-safari.')
  }
  return rules
}

/** The request the title model gets for a branch name alone. */
export function branchNamingPrompt(text: string, settings: BranchNamingSettings): { system: string; prompt: string } {
  const message = text.trim().slice(0, NAMING_TEXT_MAX)
  const system = ['You name Git branches for coding tasks. Reply with the branch name only: one line, no quotes, no explanation.', ...branchNamingRules(settings)]
  return { system: system.join('\n'), prompt: `The task:\n${message}` }
}

/**
 * Asks the thread's profile for a branch name for `text`, under {@link BRANCH_NAMING_TIMEOUT_MS}. Undefined when there is
 * no namer or title model, the request fails or takes too long, or the answer names nothing usable.
 */
export async function requestBranchName(threadDirectory: string, threadId: string, text: string, timeoutMs = BRANCH_NAMING_TIMEOUT_MS, cancellation?: AbortSignal, namingOrigin?: NamingOrigin): Promise<string | undefined> {
  const namer = namerFor(threadDirectory)
  if (!namer || !text.trim() || cancellation?.aborted) return undefined
  const settings = branchNamingFor(threadDirectory)
  const { system, prompt } = branchNamingPrompt(text, settings)
  const timeout = new AbortController()
  const signal = cancellation ? AbortSignal.any([cancellation, timeout.signal]) : timeout.signal
  let onAbort!: () => void
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  const timer = setTimeout(() => timeout.abort(), timeoutMs)
  try {
    const answer = await Promise.race([namer.ask({ threadId, system, prompt, ...(namingOrigin ? { namingOrigin } : {}) }, signal), aborted])
    return signal.aborted ? undefined : branchNameFromModel(answer, settings.mode, settings.prefix)
  } catch (error) {
    if (!signal.aborted) console.warn('[branches] the title model could not name the branch', { threadId, error: error instanceof Error ? error.message : String(error) })
    return undefined
  } finally {
    signal.removeEventListener('abort', onAbort)
    clearTimeout(timer)
  }
}
