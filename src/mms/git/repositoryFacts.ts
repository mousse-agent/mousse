import { AsyncLocalStorage } from 'node:async_hooks'
import { resolve } from 'node:path'
import { step, type Steps } from '../actions/steps'
import { IN_PROGRESS_GIT_MARKERS } from './gitMarkers'
import { activeHiddenStore } from './hiddenStore'
import { repoProgramEnv, withoutRepoProgramsAsync } from './repoPrograms'
import { runGitProcess } from './runGitProcess'

/**
 * What a turn's start or end asks Git about its folder, asked once per boundary instead of once per caller.
 *
 * Starting a turn and recording its end each asked Git the same questions about the worktree a dozen times: where the
 * checkout's top is (six times), what HEAD is (three times), which branch, where the Git folder and Mousse's files in
 * it are, and whether a merge or rebase is in progress. Each answer is a Git process, about as costly as a real command
 * on Windows. Here they are asked in one process (two when the branch is needed), the first time a caller needs one of them while facts are open,
 * and every caller in the same window shares the answer.
 *
 * The answers hold only inside the window the turn opens (`openRepositoryFacts`) and closes: at the start, from
 * workspace verification to the start check; at the end, around the checkpoint. Both run under the thread's lease and
 * the thread's lease, and nothing of Mousse's moves HEAD or the branch inside them; the end opens its own window, so
 * HEAD and the branch the agent left are read again there. Whatever was read before the repository's lease is dropped
 * once it is held (`GitOperationCoordinator`), so what a snapshot records is read under that lease, however long the
 * wait for it was. Making or rebuilding the worktree in a window drops what it holds too (`forgetRepositoryFacts`). Nothing is kept from one window to the next, so a `.git` replaced between turns is
 * read anew. Folders recorded in a hidden store, and callers that cannot wait (synchronous steps), ask Git as before.
 */
export interface RepositoryFacts {
  /** The folder asked about, as given. */
  cwd: string
  /** `rev-parse --show-toplevel`. */
  top: string
  /** `rev-parse --absolute-git-dir`. */
  gitDir: string
  /** `rev-parse --git-common-dir`, as Git printed it (relative to `cwd` in a main checkout). */
  commonDirRaw: string
  /** `rev-parse --is-bare-repository`. */
  bare: string
  /** `rev-parse --is-inside-work-tree`. */
  inside: string
  /** `rev-parse --git-path mousse`, resolved against `cwd`. */
  mousseDir: string
  /** `rev-parse --git-path info/attributes`, resolved against `cwd`. */
  infoAttributes: string
  /** Each in-progress marker's path (`IN_PROGRESS_GIT_MARKERS`), resolved against `cwd`, in that order. */
  markers: string[]
  /** `rev-parse --verify -q HEAD^{commit}`; undefined while HEAD has no commit. */
  head?: string
  /** `symbolic-ref -q HEAD`, asked the first time it is needed: the full ref HEAD is on; undefined when detached. */
  headRef(): Promise<string | undefined>
}

interface Window { facts: Map<string, Promise<RepositoryFacts | null>> }
interface Holder { window?: Window }

const scope = new AsyncLocalStorage<Holder>()

/** Runs one turn so that it can open windows of shared facts (`openRepositoryFacts`); none is open at first. */
export function withRepositoryFactsScope<T>(work: () => Promise<T>): Promise<T> {
  return scope.run({}, work)
}

/** Opens a window: until `closeRepositoryFacts`, callers in this turn share one answer per folder. */
export function openRepositoryFacts(): void {
  const holder = scope.getStore()
  if (holder) holder.window = { facts: new Map() }
}

/** Closes the window: callers ask Git themselves again. */
export function closeRepositoryFacts(): void {
  const holder = scope.getStore()
  if (holder) holder.window = undefined
}

/** Drops every answer of the open window, which stays open: the worktree was made or rebuilt and is read again. */
export function forgetRepositoryFacts(): void {
  scope.getStore()?.window?.facts.clear()
}

const OPTIONS = [
  '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--is-bare-repository', '--is-inside-work-tree',
  '--git-path', 'mousse', '--git-path', 'info/attributes',
  ...IN_PROGRESS_GIT_MARKERS.flatMap((marker) => ['--git-path', marker])
]
/** The lines the options print, before HEAD's. */
const OPTION_LINES = 7 + IN_PROGRESS_GIT_MARKERS.length

/**
 * The facts for `cwd` in the open window, asked of Git the first time; undefined when no window is open, when `cwd` is
 * recorded in a hidden store, for a synchronous caller, or when Git could not answer (the caller then asks Git itself,
 * and gets Git's own error).
 */
export function* repositoryFactsStep(cwd: string): Steps<RepositoryFacts | undefined> {
  const window = scope.getStore()?.window
  if (!window || activeHiddenStore(cwd)) return undefined
  return yield* step(() => undefined, () => repositoryFacts(cwd))
}

/** {@link repositoryFactsStep} for a caller that can wait. */
export async function repositoryFacts(cwd: string): Promise<RepositoryFacts | undefined> {
  const window = scope.getStore()?.window
  if (!window || activeHiddenStore(cwd)) return undefined
  const key = resolve(cwd)
  let asked = window.facts.get(key)
  if (!asked) {
    asked = probe(key).catch(() => null)
    window.facts.set(key, asked)
  }
  return (await asked) ?? undefined
}

async function run(cwd: string, args: string[]): Promise<{ status: number | null; stdout: string }> {
  const argv = await withoutRepoProgramsAsync(cwd, args)
  const ran = await runGitProcess(argv, { cwd, env: repoProgramEnv() })
  if (ran.error) throw ran.error
  return { status: ran.status, stdout: ran.stdout }
}

async function probe(cwd: string): Promise<RepositoryFacts | null> {
  // One process for every path and HEAD: the options print first, one line each; `--verify -q` prints HEAD's commit
  // last, or nothing and status 1 while HEAD has none.
  const paths = await run(cwd, ['rev-parse', ...OPTIONS, '--verify', '-q', 'HEAD^{commit}'])
  const lines = paths.stdout.replace(/\r?\n$/, '').split(/\r?\n/)
  const born = paths.status === 0 && lines.length === OPTION_LINES + 1
  const unborn = paths.status === 1 && lines.length === OPTION_LINES
  if (!born && !unborn) return null
  const [top, gitDir, commonDirRaw, bare, inside, mousse, info, ...rest] = lines as [string, string, string, string, string, string, string, ...string[]]
  if (!top || !gitDir || !commonDirRaw) return null
  const markers = rest.slice(0, IN_PROGRESS_GIT_MARKERS.length).map((path) => resolve(cwd, path))
  // The branch HEAD is on, as a full ref, asked only when a caller needs it; status 1 when detached.
  let headRef: Promise<string | undefined> | undefined
  const readHeadRef = async (): Promise<string | undefined> => {
    // A failure reads as no branch, as the callers' own `tryGit` did.
    const ref = await run(cwd, ['symbolic-ref', '-q', 'HEAD']).catch(() => undefined)
    return ref?.status === 0 ? ref.stdout.trim() || undefined : undefined
  }
  return {
    cwd, top, gitDir, commonDirRaw, bare, inside,
    mousseDir: resolve(cwd, mousse), infoAttributes: resolve(cwd, info), markers,
    ...(born ? { head: lines[OPTION_LINES] } : {}),
    headRef: () => (headRef ??= readHeadRef())
  }
}

/** The branch name `git branch --show-current` prints for `headRef`: none when detached or not on a local branch. */
export function branchOfHeadRef(headRef: string | undefined): string | undefined {
  return headRef?.startsWith('refs/heads/') ? headRef.slice('refs/heads/'.length) : undefined
}
