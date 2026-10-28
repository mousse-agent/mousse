import { realpath } from 'node:fs/promises'
import type { MmsProfileServices } from '../../MmsProfileServices'
import { git } from '../dispatch/git'
import { portableRepositoryAt } from '../dispatch/repository'

/** What makes a folder the same repository on another computer, found from the repository's top folder. */
export interface RepositoryIdentity {
  /** The top folder of the repository, as a real path. */
  root: string
  roots: string[]
  remotes: string[]
}

/** Two paths name the same folder: Windows ignores case and takes either separator. */
export function sameFolder(a: string, b: string): boolean {
  if (process.platform !== 'win32') return a === b
  const norm = (path: string): string => path.replaceAll('/', '\\').toLowerCase()
  return norm(a) === norm(b)
}

/** A repository's top folder and root commits hardly ever change: they are read again after this long. */
const IDENTITY_TTL_MS = 30 * 60_000
/** A repository that could not be read is asked about again after a minute, not on every call. */
const FAILURE_TTL_MS = 60_000
/** A repository whose history takes longer than this to read is treated as unreadable for now. */
const SCAN_BUDGET_MS = 45_000

interface Timing {
  now(): number
}

/**
 * The Git identity of folders, keyed on the repository's top folder.
 *
 * - A folder inside a repository (a project that is a subfolder) and a folder reached through a link,
 *   junction or `subst` drive both resolve to the same top folder, so they share one identity.
 * - Repositories are read one at a time and a repository is read once while its answer is fresh, so
 *   several callers asking at once (a match, the project list, a window) share one scan per repository.
 * - A repository that is slow to read gives up after a budget and is tried again a minute later; the
 *   scan that was running keeps its slot only until then.
 */
export class RepositoryIdentities {
  private readonly folders = new Map<string, { at: number; root: string | null }>()
  private readonly repositories = new Map<
    string,
    { at: number; identity: RepositoryIdentity | null }
  >()
  private readonly pending = new Map<string, Promise<RepositoryIdentity | null>>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly options: {
      timing?: Timing
      budgetMs?: number
      /** Tests replace the reading of a repository. */
      read?: (root: string, signal?: AbortSignal) => Promise<{ roots: string[]; remotes: string[] }>
    } = {}
  ) {}

  private now(): number {
    return (this.options.timing ?? Date).now()
  }

  /** The identity of the repository `path` is in, or null: not a repository, not readable, or too slow. */
  async of(path: string): Promise<RepositoryIdentity | null> {
    const root = await this.rootOf(path)
    return root ? this.identityOf(root) : null
  }

  /** The top folder of the repository `path` is in, as a real path. */
  async rootOf(path: string): Promise<string | null> {
    const held = this.folders.get(path)
    if (held && this.now() - held.at < (held.root ? IDENTITY_TTL_MS : FAILURE_TTL_MS))
      return held.root
    let root: string | null = null
    try {
      const real = await realpath(path)
      // The call is stopped when the budget is up, so a slow folder does not go on after it was given up on.
      root = await realpath(
        await git(
          real,
          ['rev-parse', '--show-toplevel'],
          AbortSignal.timeout(this.options.budgetMs ?? SCAN_BUDGET_MS)
        )
      )
    } catch {
      // Not a repository, or not readable: it has no identity.
    }
    this.folders.set(path, { at: this.now(), root })
    this.prune()
    return root
  }

  /** Whether `path` is the top folder of its repository, `root`. Case and separators do not matter on Windows. */
  async isTop(path: string, root: string): Promise<boolean> {
    try {
      return sameFolder(await realpath(path), root)
    } catch {
      return false
    }
  }

  private identityOf(root: string): Promise<RepositoryIdentity | null> {
    const held = this.repositories.get(root)
    if (held && this.now() - held.at < (held.identity ? IDENTITY_TTL_MS : FAILURE_TTL_MS))
      return Promise.resolve(held.identity)
    const running = this.pending.get(root)
    if (running) return running
    const read = this.options.read ?? portableRepositoryAt
    const scan = new Promise<RepositoryIdentity | null>((resolve) => {
      // One repository at a time: the queue is the "one scan in flight" for this computer.
      const run = async (): Promise<void> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const stop = new AbortController()
        try {
          const found = await Promise.race([
            read(root, stop.signal).then((value) => ({
              root,
              roots: [...value.roots],
              remotes: [...value.remotes]
            })),
            new Promise<null>((done) => {
              timer = setTimeout(() => {
                // The Git calls end with the budget: the next repository does not wait behind them.
                stop.abort()
                done(null)
              }, this.options.budgetMs ?? SCAN_BUDGET_MS)
              timer.unref?.()
            })
          ])
          resolve(found)
        } catch {
          resolve(null)
        } finally {
          if (timer) clearTimeout(timer)
        }
      }
      this.queue = this.queue.then(run, run)
    }).then((identity) => {
      this.repositories.set(root, { at: this.now(), identity })
      this.pending.delete(root)
      this.prune()
      return identity
    })
    this.pending.set(root, scan)
    return scan
  }

  private prune(): void {
    const now = this.now()
    for (const [key, held] of this.folders)
      if (now - held.at >= IDENTITY_TTL_MS) this.folders.delete(key)
    for (const [key, held] of this.repositories)
      if (now - held.at >= IDENTITY_TTL_MS) this.repositories.delete(key)
  }
}

const shared = new WeakMap<object, RepositoryIdentities>()

/** The identities of the profile's folders: one reader per profile, so every caller shares its scans and answers. */
export function repositoryIdentitiesFor(
  services: Pick<MmsProfileServices, 'projects'>
): RepositoryIdentities {
  let held = shared.get(services)
  if (!held) shared.set(services, (held = new RepositoryIdentities()))
  return held
}
