import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { repoProgramEnv, withoutRepoProgramsAsync } from '../git/repoPrograms'
import { gitRunError, runGitProcess, type GitProcessObserver } from '../git/runGitProcess'

import { withCheckoutSlot } from './checkoutSlots'
export { CHECKOUTS_PER_DISK_DEFAULT, withCheckoutSlot } from './checkoutSlots'

/**
 * How Mousse writes the files of a new worktree (a thread's, a subagent's, a workflow agent's, a dispatched task's):
 *
 * - With Git's parallel checkout (`checkout.workers=0`, one worker per core), unless Git's config already sets
 *   `checkout.workers`: on Windows that halves `git worktree add` for a project of a few thousand files.
 * - Only the paths of the project's sparse-checkout pattern file, when its Git config names one
 *   (`git config mousse.sparseCheckout <file>`, relative to the project's top folder or absolute): `worktree add
 *   --no-checkout`, then `sparse-checkout set`, then the checkout. That needs Git's per-worktree settings
 *   (`extensions.worktreeConfig`), which Mousse never turns on by itself; without them, or without the file, the
 *   worktree is refused before anything is made.
 *
 * A copy-on-write clone of a cached checkout (#765) can replace the writing here; the plan stays the same.
 */
export const SPARSE_CHECKOUT_SETTING = 'mousse.sparseCheckout'

export interface WorktreeCheckoutPlan {
  /** Global `-c` options for the commands that write the worktree's files. */
  settings: readonly string[]
  /** Hash of the checkout and filter configuration used when preparing a draft. */
  configuration?: string
  /** The project's sparse-checkout patterns, when it names a file of them. */
  sparse?: { file: string; patterns: string; cone: boolean }
}

/** The sparse layout that determines which files a draft's checkout contains. */
export function checkoutLayoutKey(plan: WorktreeCheckoutPlan): string {
  return createHash('sha256').update(JSON.stringify([plan.configuration, plan.sparse?.cone, plan.sparse?.patterns])).digest('hex')
}

/** Runs one Git command; `input` is its standard input. Throws when Git fails. */
export type WorktreeGit = (cwd: string, args: string[], input?: string, observer?: GitProcessObserver) => Promise<unknown>

const CHECKOUT_CONFIGURATION = 'checkout\\.|filter\\.|lfs\\.|submodule\\.|extensions\\.|core\\.(autocrlf|eol|safecrlf|symlinks|ignorecase|precomposeunicode|protecthfs|protectntfs|checkroundtripencoding|attributesfile|sparsecheckout|sparsecheckoutcone)$|index\\.sparse$'

async function checkoutConfig(cwd: string, run: WorktreeGit, args: string[]): Promise<string> {
  try {
    return String(await run(cwd, args))
  } catch (error) {
    const { status } = error as { status?: unknown }
    // Older Git documents unknown `git var` names as usage errors.
    if (status !== 1 && !(args[0] === 'var' && status === 129)) throw error
    return ''
  }
}

/** Checkout config and attribute/sparse files outside HEAD that can change the bytes or layout written by Git. */
export async function checkoutInputsKey(cwd: string): Promise<string> {
  const config = (args: string[]) => checkoutConfig(cwd, worktreeGit, args)
  const [settings, locations, global, system, configured] = await Promise.all([
    config(['config', '-z', '--get-regexp', '^(' + CHECKOUT_CONFIGURATION + ')']),
    worktreeGit(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'info/attributes', '--git-path', 'info/sparse-checkout']),
    config(['var', 'GIT_ATTR_GLOBAL']),
    config(['var', 'GIT_ATTR_SYSTEM']),
    config(['config', '--path', '--get', 'core.attributesFile'])
  ])
  const files = String(locations).trimEnd().split(/\r?\n/)
  const home = process.env.HOME || homedir()
  files.push(global.trimEnd() || configured.trimEnd() || resolve(process.env.XDG_CONFIG_HOME || resolve(home, '.config'), 'git', 'attributes'))
  if (system.trimEnd()) files.push(system.trimEnd())
  const contents = await Promise.all(files.map(async (path) => {
    if (path === '/dev/null' || process.platform === 'win32' && /^nul:?$/i.test(path)) return [path, null]
    try {
      const file = resolve(cwd, path)
      if (!(await stat(file)).isFile()) throw new Error('The Git checkout settings refer to a non-file: ' + file)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(file)) hash.update(chunk)
      return [path, hash.digest('hex')]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return [path, null]
    }
  }))
  return createHash('sha256').update(JSON.stringify([settings, contents, process.env.GIT_ATTR_SOURCE, process.env.GIT_ATTR_NOSYSTEM])).digest('hex')
}

/** Git for these commands: the repository's own programs never run (`withoutRepoProgramsAsync`). */
export const worktreeGit: WorktreeGit = async (cwd, args, input, observer) => {
  const argv = await withoutRepoProgramsAsync(cwd, args, input === undefined ? undefined : { stdin: input })
  const ran = await runGitProcess(argv, { cwd, env: repoProgramEnv(), observer, ...(input === undefined ? {} : { input }) })
  if (ran.error || ran.status !== 0) throw gitRunError(argv, ran)
  return ran.stdout
}

/** Plain paths only (no pattern characters): Git's cone mode, which takes folders and is the faster one. */
const PATTERN_CHARACTERS = /[*?[\]\\!]/

/** The lines of a pattern file Git reads: blank lines and `#` comments left out. */
function patternLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
}

/**
 * The plan for a new worktree of the repository whose top folder is `top`, from one read of its Git config. Throws,
 * before anything is made, when the project names a pattern file that is missing or empty, or Git cannot keep the
 * sparse checkout to the new worktree alone. `sparse: false` leaves the pattern file out (a full checkout).
 */
export async function worktreeCheckoutPlan(top: string, run: WorktreeGit = worktreeGit, options: { sparse?: boolean; matchPreparation?: boolean } = {}): Promise<WorktreeCheckoutPlan> {
  const config = new Map<string, string>()
  const layout = 'checkout\\.workers|mousse\\.sparsecheckout|extensions\\.worktreeconfig'
  try {
    // `-z`: each entry is "key\nvalue\0", so a path with spaces or a newline reads whole.
    const keys = options.matchPreparation ? `^(${layout}$|${CHECKOUT_CONFIGURATION})` : `^(${layout})$`
    const out = String(await run(top, ['config', '-z', '--get-regexp', keys]))
    for (const entry of out.split('\0')) {
      const newline = entry.indexOf('\n')
      if (newline > 0) config.set(entry.slice(0, newline).toLowerCase(), entry.slice(newline + 1))
    }
  } catch (error) {
    // Exit status 1: none of the keys is set.
    if ((error as { status?: unknown }).status !== 1) throw error
  }
  const settings = config.has('checkout.workers') ? [] : ['-c', 'checkout.workers=0']
  const configuration = options.matchPreparation
    ? { configuration: createHash('sha256').update(JSON.stringify([...config].sort())).digest('hex') }
    : {}
  const named = config.get('mousse.sparsecheckout')?.trim()
  if (!named || options.sparse === false) return { settings, ...configuration }
  const file = isAbsolute(named) ? named : resolve(top, named)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    throw new Error(`The project's sparse-checkout pattern file ${file} (Git setting ${SPARSE_CHECKOUT_SETTING}) could not be read. No worktree was made.`)
  }
  const lines = patternLines(text)
  if (!lines.length) throw new Error(`The project's sparse-checkout pattern file ${file} names no paths. No worktree was made.`)
  if (!/^(true|yes|on|1)$/i.test(config.get('extensions.worktreeconfig') ?? '')) {
    throw new Error(`A sparse checkout needs Git's per-worktree settings, so it stays in the new worktree: run "git config extensions.worktreeConfig true" in ${top}, or remove ${SPARSE_CHECKOUT_SETTING}. No worktree was made.`)
  }
  const cone = !lines.some((line) => PATTERN_CHARACTERS.test(line))
  // Cone mode takes folders: a leading or trailing slash is dropped.
  const patterns = (cone ? lines.map((line) => line.replace(/^\/+|\/+$/g, '')).filter(Boolean) : lines).join('\n') + '\n'
  return { settings, ...configuration, sparse: { file, patterns, cone } }
}

/**
 * Registers a worktree with `git worktree add --no-checkout <add...>` from `cwd`: its branch, its folder and Git's
 * record of it, but none of its files. It is quick, so it is the only step that needs the repository's lease.
 * `afterAdd` runs once it is registered, before any file is written.
 */
export async function registerWorktree(input: {
  cwd: string
  add: readonly string[]
  prefix?: readonly string[]
  run?: WorktreeGit
  afterAdd?: () => Promise<void>
  observer?: GitProcessObserver
}): Promise<void> {
  const run = input.run ?? worktreeGit
  await run(input.cwd, [...(input.prefix ?? []), 'worktree', 'add', '--no-checkout', ...input.add], undefined, input.observer)
  await input.afterAdd?.()
}

/**
 * Writes the files of a worktree {@link registerWorktree} made, as `plan` says: the sparse-checkout patterns first when
 * the project names them, then the checkout of HEAD, in a slot of its physical disk ({@link withCheckoutSlot}). It needs no
 * repository lease: only this worktree's own index, settings and folder are written.
 */
export async function populateWorktree(input: {
  worktreePath: string
  plan: WorktreeCheckoutPlan
  prefix?: readonly string[]
  run?: WorktreeGit
  beforeCheckout?: () => Promise<void>
  beforeWorktreeFiles?: () => Promise<void>
  signal?: AbortSignal
  observer?: GitProcessObserver
}): Promise<void> {
  const run = input.run ?? worktreeGit
  const prefix = input.prefix ?? []
  const { settings, sparse } = input.plan
  await withCheckoutSlot(input.worktreePath, async () => {
    await input.beforeCheckout?.()
    if (sparse) await run(input.worktreePath, [...prefix, 'sparse-checkout', 'set', sparse.cone ? '--cone' : '--no-cone', '--stdin'], sparse.patterns, input.observer)
    await input.beforeWorktreeFiles?.()
    input.signal?.throwIfAborted()
    await run(input.worktreePath, [...prefix, ...settings, 'checkout', 'HEAD'], undefined, input.observer)
  }, input.signal)
}

/** Makes a worktree for callers that own both steps (agents, workflow agents and rebuilds). */
export async function addWorktree(input: {
  cwd: string
  worktreePath: string
  add: readonly string[]
  plan: WorktreeCheckoutPlan
  prefix?: readonly string[]
  run?: WorktreeGit
  afterAdd?: () => Promise<void>
}): Promise<void> {
  if (!input.plan.sparse) {
    const run = input.run ?? worktreeGit
    await run(input.cwd, [...(input.prefix ?? []), ...input.plan.settings, 'worktree', 'add', ...input.add])
    await input.afterAdd?.()
    return
  }
  await registerWorktree(input)
  await populateWorktree(input)
}
