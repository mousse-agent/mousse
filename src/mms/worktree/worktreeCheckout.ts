import { readFile, realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, parse, resolve } from 'node:path'
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
export async function worktreeCheckoutPlan(top: string, run: WorktreeGit = worktreeGit, options: { sparse?: boolean; matchPreparation?: boolean } = {}): Promise<WorktreeCheckoutPlan> {
  const config = new Map<string, string>()
  const layout = 'checkout\\.workers|mousse\\.sparsecheckout|extensions\\.worktreeconfig'
  const affectsBytes = 'core\\.(autocrlf|eol|symlinks|sparsecheckout|sparsecheckoutcone)$|filter\\.|lfs\\.'
  try {
    // `-z`: each entry is "key\nvalue\0", so a path with spaces or a newline reads whole.
    const keys = options.matchPreparation ? `^(${layout}$|${affectsBytes})` : `^(${layout})$`
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
 * How many worktrees may write their files at once on one volume (`MOUSSE_CHECKOUTS_PER_DISK`, default 1). Each checkout
 * already writes with one worker per core, so two at once on one disk only slow each other down: on a hard disk the
 * second of two starts finished later than when they took turns. A start waits only for checkouts on the volume its own
 * worktree is on. Partitions of one physical disk count as separate volumes.
 */
export const CHECKOUTS_PER_DISK_DEFAULT = 1

function checkoutsPerDisk(): number {
  const named = Number(process.env.MOUSSE_CHECKOUTS_PER_DISK)
  return Number.isInteger(named) && named >= 1 && named <= 16 ? named : CHECKOUTS_PER_DISK_DEFAULT
}

/** The volume a path is on: its drive or share on Windows, the file system's top folder elsewhere. */
async function checkoutVolumeOf(path: string): Promise<string> {
  if (process.platform !== 'win32') return String((await stat(path)).dev)
  return parse(await realpath(path)).root.toLowerCase()
}

const checkoutQueues = new Map<string, { running: number; waiting: Array<() => void> }>()

/**
 * Runs `work` once fewer than `MOUSSE_CHECKOUTS_PER_DISK` checkouts run on the volume of `path`, first come first
 * served. `volumeOf` maps a path to its volume.
 */
export async function withCheckoutSlot<T>(path: string, work: () => Promise<T>): Promise<T> {
  const key = await checkoutVolumeOf(path)
  let queue = checkoutQueues.get(key)
  if (!queue) checkoutQueues.set(key, queue = { running: 0, waiting: [] })
  const slots = queue
  if (slots.running >= checkoutsPerDisk()) await new Promise<void>((resolve) => slots.waiting.push(resolve))
  else slots.running++
  try {
    return await work()
  } finally {
    // The slot passes straight to the next waiter, so a start that arrives meanwhile cannot take it out of turn.
    const next = slots.waiting.shift()
    if (next) next()
    else if (--slots.running === 0) checkoutQueues.delete(key)
  }
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
}): Promise<void> {
  const run = input.run ?? worktreeGit
  await run(input.cwd, [...(input.prefix ?? []), 'worktree', 'add', '--no-checkout', ...input.add])
  await input.afterAdd?.()
}

/**
 * Writes the files of a worktree {@link registerWorktree} made, as `plan` says: the sparse-checkout patterns first when
 * the project names them, then the checkout of HEAD, in a slot of its volume ({@link withCheckoutSlot}). It needs no
 * repository lease: only this worktree's own index, settings and folder are written.
 */
export async function populateWorktree(input: {
  worktreePath: string
  plan: WorktreeCheckoutPlan
  prefix?: readonly string[]
  run?: WorktreeGit
  beforeCheckout?: () => Promise<void>
}): Promise<void> {
  const run = input.run ?? worktreeGit
  const prefix = input.prefix ?? []
  const { settings, sparse } = input.plan
  await withCheckoutSlot(input.worktreePath, async () => {
    await input.beforeCheckout?.()
    if (sparse) await run(input.worktreePath, [...prefix, 'sparse-checkout', 'set', sparse.cone ? '--cone' : '--no-cone', '--stdin'], sparse.patterns)
    await run(input.worktreePath, [...prefix, ...settings, 'checkout', 'HEAD'])
  })
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
