import { randomBytes } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { SEMANTIC_BRANCH_KINDS, branchNameFromModel, withBranchPrefix } from '../../shared/mousseBranches'
import { normalizeBranchNamingSettings, type BranchNamingSettings } from '../../shared/settings'

/**
 * Naming a thread's worktree branch after its first message, in the background.
 *
 * The title model names the branch in the same request that names the thread, made when the first message is sent
 * (`OrchestratorService.nameThreadOnFirstSend`). When that answer is in by the time the worktree is made, the branch is
 * made on it (`readyBranchName`). Otherwise the worktree is made at once on `<prefix>/<random id>`
 * (`temporaryBranchName`); once it is ready, the profile's namer gives the answer (`requestBranchName`), waiting for it
 * if needed, and the workspace renames its branch to it. Nothing waits on that: the turn starts on the temporary name,
 * and every failure (no title model, a refusal, the timeout, an answer that names nothing usable, a name already taken)
 * leaves the temporary name as it is.
 */

/** How long the title model may take to name a branch before the temporary name is kept. */
export const BRANCH_NAMING_TIMEOUT_MS = 30_000

/** The most of the first message the title model sees. */
const NAMING_TEXT_MAX = 2_000

export interface BranchNamer {
  settings(): BranchNamingSettings
  /** The title model's answer to `prompt`, or undefined when there is no title model. Throws on a failed request. */
  ask(request: { threadId: string; system: string; prompt: string }, signal: AbortSignal): Promise<string | undefined>
  /** The title model's branch name for the thread's first message when it has already answered; never waits. */
  ready?(threadId: string): string | undefined
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
 * The branch name the title model already gave for the thread's first message (`BranchNamer.ready`), fitted to the
 * folder's naming settings. Undefined when it has not answered yet, named nothing usable, or there is no namer. Never
 * waits, so a worktree made now can take it instead of a temporary name.
 */
export function readyBranchName(threadDirectory: string, threadId: string): string | undefined {
  try {
    const answer = namerFor(threadDirectory)?.ready?.(threadId)
    if (!answer) return undefined
    const settings = branchNamingFor(threadDirectory)
    return branchNameFromModel(answer, settings.mode, settings.prefix)
  } catch {
    return undefined
  }
}

/**
 * Asks the thread's profile for a branch name for `text`, under {@link BRANCH_NAMING_TIMEOUT_MS}. Undefined when there is
 * no namer or title model, the request fails or takes too long, or the answer names nothing usable.
 */
export async function requestBranchName(threadDirectory: string, threadId: string, text: string, timeoutMs = BRANCH_NAMING_TIMEOUT_MS): Promise<string | undefined> {
  const namer = namerFor(threadDirectory)
  if (!namer || !text.trim()) return undefined
  const settings = branchNamingFor(threadDirectory)
  const { system, prompt } = branchNamingPrompt(text, settings)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const answer = await Promise.race([
      namer.ask({ threadId, system, prompt }, controller.signal),
      new Promise<undefined>((done) => { timer = setTimeout(() => { controller.abort(); done(undefined) }, timeoutMs) })
    ])
    return branchNameFromModel(answer, settings.mode, settings.prefix)
  } catch (error) {
    console.warn('[branches] the title model could not name the branch', { threadId, error: error instanceof Error ? error.message : String(error) })
    return undefined
  } finally {
    if (timer) clearTimeout(timer)
  }
}
