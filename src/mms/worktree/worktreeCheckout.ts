import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { repoProgramEnv, withoutRepoProgramsAsync } from '../git/repoPrograms'
import { gitRunError, runGitProcess } from '../git/runGitProcess'

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
  /** The project's sparse-checkout patterns, when it names a file of them. */
  sparse?: { file: string; patterns: string; cone: boolean }
}

/** Runs one Git command; `input` is its standard input. Throws when Git fails. */
export type WorktreeGit = (cwd: string, args: string[], input?: string) => Promise<unknown>

/** Git for these commands: the repository's own programs never run (`withoutRepoProgramsAsync`). */
export const worktreeGit: WorktreeGit = async (cwd, args, input) => {
  const argv = await withoutRepoProgramsAsync(cwd, args, input === undefined ? undefined : { stdin: input })
  const ran = await runGitProcess(argv, { cwd, env: repoProgramEnv(), ...(input === undefined ? {} : { input }) })
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
export async function worktreeCheckoutPlan(top: string, run: WorktreeGit = worktreeGit, options: { sparse?: boolean } = {}): Promise<WorktreeCheckoutPlan> {
  const config = new Map<string, string>()
  try {
    // `-z`: each entry is "key\nvalue\0", so a path with spaces or a newline reads whole.
    const out = String(await run(top, ['config', '-z', '--get-regexp', '^(checkout\\.workers|mousse\\.sparsecheckout|extensions\\.worktreeconfig)$']))
    for (const entry of out.split('\0')) {
      const newline = entry.indexOf('\n')
      if (newline > 0) config.set(entry.slice(0, newline).toLowerCase(), entry.slice(newline + 1))
    }
  } catch (error) {
    // Exit status 1: none of the keys is set.
    if ((error as { status?: unknown }).status !== 1) throw error
  }
  const settings = config.has('checkout.workers') ? [] : ['-c', 'checkout.workers=0']
  const named = config.get('mousse.sparsecheckout')?.trim()
  if (!named || options.sparse === false) return { settings }
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
  return { settings, sparse: { file, patterns, cone } }
}

/**
 * `git worktree add <add...>` from `cwd`, writing the files as `plan` says. `prefix` goes before every command (a
 * pull request's safety settings, the long-paths setting). `afterAdd` runs once the worktree is registered: before
 * its files are written in a sparse checkout, right after them otherwise.
 */
export async function addWorktree(input: {
  cwd: string
  worktreePath: string
  add: readonly string[]
  plan: WorktreeCheckoutPlan
  prefix?: readonly string[]
  run?: WorktreeGit
  afterAdd?: () => void | Promise<void>
}): Promise<void> {
  const run = input.run ?? worktreeGit
  const prefix = input.prefix ?? []
  const { settings, sparse } = input.plan
  if (!sparse) {
    await run(input.cwd, [...prefix, ...settings, 'worktree', 'add', ...input.add])
    await input.afterAdd?.()
    return
  }
  await run(input.cwd, [...prefix, 'worktree', 'add', '--no-checkout', ...input.add])
  await input.afterAdd?.()
  await run(input.worktreePath, [...prefix, 'sparse-checkout', 'set', sparse.cone ? '--cone' : '--no-cone', '--stdin'], sparse.patterns)
  await run(input.worktreePath, [...prefix, ...settings, 'checkout', 'HEAD'])
}
