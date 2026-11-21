import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { canonicalPathAsync } from './canonicalPath'

/**
 * Git's list of a repository's worktrees (`git worktree list`), read from the files Git builds it from instead of by
 * running Git, so a question about one worktree costs that worktree and not every worktree of the repository.
 *
 * Git lists the main worktree, then each `<common>/worktrees/<id>` whose `gitdir` file reads as non-empty: its text with
 * trailing whitespace and a final `/.git` removed, made absolute against the registration's folder (and its links
 * resolved) when `worktree.useRelativePaths` wrote it relative. A registration is listed whether its folder is there or
 * not (prunable), and is locked while `<id>/locked` exists, its text being the reason. Git never registers one path
 * twice: `worktree add` and `worktree move` refuse a path already registered, and `add --force` drops the old
 * registration first. So the registration a worktree's own `.git` file names is the only one there can be for it.
 */
export interface ListedWorktree {
  /** The path as Git lists it. */
  path: string
  /** `<common>/worktrees/<id>`; unset for the main worktree. */
  adminDir?: string
  /** Why Git has it locked (empty for a lock without a reason); unset when it is not locked. */
  locked?: string
}

/** How two paths are compared, as the caller compared `git worktree list`'s paths before. */
export type SamePath = (listed: string, wanted: string) => boolean | Promise<boolean>

/**
 * Registrations, or Git's own list, read during one pass (a placement, a purge preview), so asking about several paths or
 * branches reads them once. Kept only while the `worktrees/` folder is the same folder with the same modification time,
 * which changes whenever Git adds, removes or prunes a registration. Drop it when the pass ends.
 */
export class WorktreeListPass {
  private readonly read = new Map<string, { key: string; value: Promise<unknown> }>()

  /**
   * `git worktree list --porcelain` for `commonDir` (`read` runs it), run once per pass while the `worktrees/` folder is
   * unchanged. For questions only the full list answers, such as which worktree has a branch checked out.
   */
  listing(commonDir: string, read: () => Promise<string>): Promise<string> { return this.once(`listing:${resolve(commonDir)}`, commonDir, read) }

  /** Every linked registration of `commonDir`, read once per pass while the `worktrees/` folder is unchanged. */
  registrations(commonDir: string, read: () => Promise<ListedWorktree[]>): Promise<ListedWorktree[]> { return this.once(`linked:${resolve(commonDir)}`, commonDir, read) }

  private async once<T>(slot: string, commonDir: string, read: () => Promise<T>): Promise<T> {
    const key = await worktreesKey(commonDir)
    const cached = this.read.get(slot)
    if (cached?.key === key) return cached.value as Promise<T>
    const value = read()
    this.read.set(slot, { key, value })
    // A failed read is not kept: the next question reads again, as it did before.
    value.catch(() => { if (this.read.get(slot)?.value === value) this.read.delete(slot) })
    return value
  }
}

/** The `worktrees/` folder's identity and modification time, which a pass keys what it read by. */
async function worktreesKey(commonDir: string): Promise<string> {
  const info = await stat(join(commonDir, 'worktrees')).catch(() => undefined)
  return info ? `${info.dev}:${info.ino}:${info.mtimeMs}` : 'none'
}

/** The main worktree's path as Git lists it: the common directory's real path, without a final `.git`. */
export async function mainWorktreePathAsync(commonDir: string): Promise<string> {
  const real = await canonicalPathAsync(commonDir)
  return basename(real) === '.git' ? dirname(real) : real
}

/** `<common>/worktrees/<id>` as Git lists it, or undefined when Git leaves it out of the list. */
export async function linkedWorktreeAsync(commonDir: string, id: string): Promise<ListedWorktree | undefined> {
  if (!id || id === '.' || id === '..' || /[\\/]/.test(id)) return undefined
  const adminDir = join(commonDir, 'worktrees', id)
  let text: string
  try { text = await readFile(join(adminDir, 'gitdir'), 'utf8') } catch { return undefined }
  let path = text.replace(/\s+$/, '')
  if (!path) return undefined
  if (path.endsWith('/.git')) path = path.slice(0, -'/.git'.length)
  if (!isAbsolute(path)) path = await canonicalPathAsync(resolve(adminDir, path))
  let locked: string | undefined
  try { locked = (await readFile(join(adminDir, 'locked'), 'utf8')).trim() } catch (error) {
    // Git stops listing when a lock it sees cannot be read; so does this.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { path, adminDir, ...(locked !== undefined ? { locked } : {}) }
}

/** Every linked worktree Git lists, read once per pass while the `worktrees/` folder is unchanged. */
async function linkedWorktreesAsync(commonDir: string, pass?: WorktreeListPass): Promise<ListedWorktree[]> {
  const root = join(commonDir, 'worktrees')
  const read = async (): Promise<ListedWorktree[]> => {
    let ids: string[]
    try { ids = await readdir(root) } catch { return [] }
    const listed: ListedWorktree[] = []
    for (const id of ids) { const entry = await linkedWorktreeAsync(commonDir, id); if (entry) listed.push(entry) }
    return listed
  }
  return pass ? pass.registrations(commonDir, read) : read()
}

/**
 * Fails as `git worktree list` run in `commonDir` fails when that is not a Git directory (moved, deleted, never one), so
 * a caller that stopped on that failure still stops instead of reading "not registered".
 */
async function assertGitDirectory(commonDir: string): Promise<void> {
  const [head, objects, refs] = await Promise.all(['HEAD', 'objects', 'refs'].map((name) => stat(join(commonDir, name)).catch(() => undefined)))
  if (!head?.isFile() || !objects?.isDirectory() || !refs?.isDirectory()) throw new Error(`${commonDir} is not a Git repository`)
}

/** The id of the registration the folder's own `.git` file names, when it is a linked worktree's file. */
async function pointedId(worktree: string): Promise<string | undefined> {
  try {
    const dotGit = join(worktree, '.git')
    const info = await lstat(dotGit)
    if (!info.isFile() || info.size > 4096) return undefined
    const line = (await readFile(dotGit, 'utf8')).split(/\r?\n/).find((entry) => entry.startsWith('gitdir:'))
    return line ? basename(resolve(worktree, line.slice('gitdir:'.length).trim())) : undefined
  } catch { return undefined }
}

/**
 * The worktree Git lists at `path` (`same` compares each listed path with it), read without Git. A worktree that is
 * there is found from its own `.git` file, reading one registration; only a path Git does not list (or whose `.git`
 * file is missing or names another registration) reads every registration, as Git itself does.
 */
export async function findListedWorktreeAsync(commonDir: string, path: string, same: SamePath, options: { main?: boolean; pass?: WorktreeListPass } = {}): Promise<ListedWorktree | undefined> {
  await assertGitDirectory(commonDir)
  if (options.main !== false) {
    const main = await mainWorktreePathAsync(commonDir)
    if (await same(main, path)) return { path: main }
  }
  const id = await pointedId(path)
  const pointed = id ? await linkedWorktreeAsync(commonDir, id) : undefined
  if (pointed && await same(pointed.path, path)) return pointed
  for (const entry of await linkedWorktreesAsync(commonDir, options.pass)) if (await same(entry.path, path)) return entry
  return undefined
}
