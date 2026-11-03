import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { mousseCommitEnvNow } from '../actions/git'
import { LISTING_MAX_BUFFER } from '../git/runGitProcess'
import { gitSucceeds, lifecycleGitAsync, lifecycleReadAsync } from './lifecycleGit'

/**
 * Git's own data of a linked worktree, kept from its administration folder (`<common>/worktrees/<name>/`) when Mousse
 * deletes the worktree, so a rebuild brings back its configuration (`config.worktree`), its HEAD history (`logs/HEAD`),
 * its own refs (`refs/worktree/*`, `refs/bisect/*`) and anything else Git keeps there, files Git adds later included.
 *
 * Left out, because each describes the folder's registration or a moment and never holds data:
 * - `gitdir`: the path of the worktree's `.git` file, the trash folder at the time; `git worktree add` writes the new one.
 * - `locked`: a lock someone put on the worktree; a rebuilt worktree never comes back locked.
 * - `*.lock`: Git's lock file of a write that is in progress or was interrupted.
 * - sockets and pipes (a file system monitor's): they hold no bytes.
 */
const LEFT_OUT = new Set(['gitdir', 'locked'])
/**
 * Kept, but a rebuild leaves them as `git worktree add` and the checkout write them: `HEAD` (the manifest's HEAD and
 * branch set it), `commondir` (always the way back to the shared folder) and the index (retirement refuses staged
 * changes, so it is HEAD's tree; the checkout writes a fresh one, without stale file times or caches). Links are kept
 * and never replayed: where they point is a fact of the folder's old location.
 */
const NOT_REPLAYED = new Set(['HEAD', 'commondir', 'index'])
/** The kept reflog of HEAD: a rebuild puts it back in front of what the rebuild itself records. */
export const HEAD_REFLOG = 'logs/HEAD'
const LIMITS = { entries: 10_000, depth: 32, bytes: 512 * 1024 * 1024 }

export interface AdminFile { path: string; mode: '100644' | '100755' | '120000'; bytes: Buffer }

function leftOut(name: string, rel: string): boolean { return rel === name && LEFT_OUT.has(name) || name.endsWith('.lock') }

/** Every file and link of the administration folder a capture keeps, sorted by path, links not followed. */
export async function readAdminFilesAsync(adminDir: string): Promise<AdminFile[]> {
  const files: AdminFile[] = []
  let total = 0, seen = 0
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > LIMITS.depth) throw new Error('Git\'s data of this worktree is nested too deeply to keep')
    for (const name of (await readdir(dir)).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name
      if (++seen > LIMITS.entries) throw new Error('Git\'s data of this worktree has too many files to keep')
      if (leftOut(name, rel)) continue
      const path = join(dir, name)
      const stat = await lstat(path)
      if (stat.isDirectory()) { await walk(path, rel, depth + 1); continue }
      if (stat.isSymbolicLink()) { files.push({ path: rel, mode: '120000', bytes: Buffer.from(await readlink(path)) }); continue }
      if (!stat.isFile()) continue
      total += stat.size
      if (total > LIMITS.bytes) throw new Error('Git\'s data of this worktree is too large to keep')
      files.push({ path: rel, mode: stat.mode & 0o111 ? '100755' : '100644', bytes: await readFile(path) })
    }
  }
  await walk(adminDir, '', 0)
  return files
}

/** Whether a rebuild writes a kept file back. */
export function replayedAdminFile(path: string, mode: string): boolean {
  return mode !== '120000' && !NOT_REPLAYED.has(path) && !path.split('/').some((part) => part === '..' || part === '' || part.endsWith('.lock')) && !LEFT_OUT.has(path)
}

/**
 * What the kept files hold, to tell whether any changed since they were captured. The files Git itself rewrites on a
 * read (the index and its shared parts) and HEAD (compared on its own) are not part of it.
 */
export function adminDigest(files: readonly AdminFile[]): string {
  const rows = files.filter((file) => !NOT_REPLAYED.has(file.path) && !/^sharedindex\./.test(file.path)).map((file) => [file.path, file.mode, createHash('sha256').update(file.bytes).digest('hex')])
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

/** The id Git gives a blob of these bytes, to prove the stored blob is the bytes that were read. */
export function blobId(bytes: Buffer, objectFormat: string): string {
  return createHash(objectFormat === 'sha256' ? 'sha256' : 'sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex')
}

const OBJECT_ID = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/
const pseudoRef = (path: string): boolean => /^[A-Z][A-Z_]*HEAD$/.test(path) && path !== 'HEAD'

/**
 * The object ids the worktree's own history and refs name: both ids of every reflog entry (`logs/**`), and the id each
 * per-worktree ref (`refs/**`) and pseudo-ref (`ORIG_HEAD`, `FETCH_HEAD`, `MERGE_HEAD`, ...) holds.
 */
export function adminObjectIds(files: readonly AdminFile[]): string[] {
  const ids = new Set<string>()
  const add = (value: string | undefined): void => { if (value && OBJECT_ID.test(value) && !/^0+$/.test(value)) ids.add(value) }
  for (const file of files) {
    if (file.mode === '120000') continue
    const logs = file.path.startsWith('logs/')
    if (!logs && !file.path.startsWith('refs/') && !pseudoRef(file.path)) continue
    for (const line of file.bytes.toString('utf8').split('\n')) {
      const words = line.split(/[\s]+/)
      add(words[0])
      if (logs) add(words[1])
    }
  }
  return [...ids].sort()
}

/** What `storeAdmin` stored: the tree and commit of the kept files, the commits they name, and what the files hold. */
export interface StoredAdmin { tree: string; commit: string; previous?: string; digest: string; commits: string[] }

/**
 * Stores the files of a worktree's administration folder `adminDir` (see {@link readAdminFilesAsync}) as a tree, each
 * blob proven to be the bytes that were read, and a commit of it on top of `previous` (reused when its tree is the
 * same). `commit.parents`, given the commits the folder names, adds parents after `previous`. Returns those commits
 * (what the folder's reflogs and refs name) and what the files hold, to compare before a delete. Writes no ref.
 */
export async function storeAdmin(
  worktreePath: string,
  adminDir: string,
  commonDir: string,
  previous: string | undefined,
  commit: { message: string; env: NodeJS.ProcessEnv; parents?: (commits: readonly string[]) => Promise<readonly string[]> }
): Promise<StoredAdmin> {
  const files = await readAdminFilesAsync(adminDir)
  const format = await lifecycleReadAsync(commonDir, ['rev-parse', '--show-object-format'])
  const blobs = new Map<string, string>()
  const regular = files.filter((file) => file.mode !== '120000')
  if (regular.some((file) => /[\r\n]/.test(file.path))) throw new Error('A file name Git cannot be given on a line')
  // Git reads the files again: each blob it stores must be the bytes read above, or the folder changed meanwhile.
  const ids = regular.length ? (await lifecycleGitAsync(commonDir, ['hash-object', '-w', '--no-filters', '--stdin-paths'], regular.map((file) => join(adminDir, file.path)).join('\n') + '\n')).split('\n') : []
  for (const [index, file] of regular.entries()) blobs.set(file.path, ids[index]!)
  for (const file of files.filter((entry) => entry.mode === '120000')) blobs.set(file.path, await lifecycleGitAsync(commonDir, ['hash-object', '-w', '--stdin'], file.bytes.toString('utf8')))
  for (const file of files) if (blobs.get(file.path) !== blobId(file.bytes, format)) throw new Error('Its files changed while they were read')
  const tree = await writeAdminTree(commonDir, files, blobs)
  // The worktree's own refs as Git lists them too, so a ref store other than plain files is covered as well.
  const listed = (await lifecycleReadAsync(worktreePath, ['for-each-ref', '--format=%(objectname)', 'refs/worktree/', 'refs/bisect/', 'refs/rewritten/'])).split('\n')
  const named = [...new Set([...adminObjectIds(files), ...listed.filter((sha) => /^[a-f0-9]{40,64}$/.test(sha))])]
  const types = named.length ? (await lifecycleReadAsync(commonDir, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], named.join('\n') + '\n')).split('\n') : []
  const commits = types.map((line) => line.split(' ')).filter(([sha, type]) => type === 'commit' && named.includes(sha!)).map(([sha]) => sha!)
  const parents = [...(previous ? [previous] : []), ...(commit.parents ? await commit.parents(commits) : [])]
  const reuse = previous && parents.length === 1 && await lifecycleReadAsync(commonDir, ['rev-parse', `${previous}^{tree}`]).catch(() => undefined) === tree
  const sha = reuse ? previous : await lifecycleGitAsync(commonDir, ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', commit.message], undefined, undefined, commit.env)
  return { tree, commit: sha, ...(previous ? { previous } : {}), digest: adminDigest(files), commits }
}

/** A tree of the kept files, one `mktree` per folder. */
export async function writeAdminTree(commonDir: string, files: readonly AdminFile[], blobs: ReadonlyMap<string, string>): Promise<string> {
  const write = async (prefix: string): Promise<string> => {
    const rows: string[] = []
    const folders = new Set<string>()
    for (const file of files) {
      if (prefix && !file.path.startsWith(`${prefix}/`)) continue
      const rest = prefix ? file.path.slice(prefix.length + 1) : file.path
      const slash = rest.indexOf('/')
      if (slash < 0) rows.push(`${file.mode} blob ${blobs.get(file.path)!}\t${rest}`)
      else folders.add(rest.slice(0, slash))
    }
    for (const folder of folders) rows.push(`040000 tree ${await write(prefix ? `${prefix}/${folder}` : folder)}\t${folder}`)
    return lifecycleGitAsync(commonDir, ['mktree', '-z'], rows.map((row) => `${row}\0`).join(''))
  }
  return write('')
}

/** The independent tips of `commits`: none an ancestor of another, so together they hold every one of them. */
async function independentTips(commonDir: string, commits: readonly string[]): Promise<string[]> {
  if (commits.length <= 1) return [...commits]
  return (await lifecycleReadAsync(commonDir, ['merge-base', '--independent', ...commits])).split('\n').filter(Boolean)
}

/**
 * Of `commits`, the fewest that hold every one not already held by `pinned`: the independent tips of them (none an
 * ancestor of another), less those an existing pin contains. Pinning these keeps every commit in `commits`.
 */
export async function uncontainedTips(commonDir: string, commits: readonly string[], pinned: readonly string[]): Promise<string[]> {
  const held = new Set(pinned)
  const rest = commits.filter((sha) => !held.has(sha))
  if (!rest.length) return []
  const tips = await independentTips(commonDir, rest)
  const uncontained: string[] = []
  for (const tip of tips) {
    let contained = false
    for (const pin of held) if (await gitSucceeds(commonDir, ['merge-base', '--is-ancestor', tip, pin])) { contained = true; break }
    if (!contained) uncontained.push(tip)
  }
  return uncontained
}

/**
 * Of `commits`, the fewest that hold every one nothing else holds: the independent tips of those no ref reaches, less
 * `released` (refs about to go too) and Mousse's own refs (`refs/mousse/`), which all expire. HEAD counts only for the
 * repository's main folder: run in `commonDir`, so another worktree's HEAD, the one being removed included, holds nothing.
 */
export async function unheldTips(commonDir: string, commits: readonly string[], released: readonly string[]): Promise<string[]> {
  if (!commits.length) return []
  // Revisions read from stdin are always wanted, so `--not` applies to `--all` alone.
  const reached = await lifecycleReadAsync(commonDir, ['rev-list', '--single-worktree', '--not', '--exclude=refs/mousse/*', ...released.map((ref) => `--exclude=${ref}`), '--all', '--stdin'], commits.join('\n') + '\n', LISTING_MAX_BUFFER)
  const unheld = new Set(reached.split('\n'))
  return independentTips(commonDir, commits.filter((sha) => unheld.has(sha)))
}

/** The first line of the commit cleanup keeps a removed worktree's Git data in (`storeAdminBeforeRemoval`). */
export const CLEANUP_ADMIN_MESSAGE = "mousse: Git's own data of a worktree cleanup removed"

/** Whether the commit `ref` names is one cleanup kept a removed worktree's Git data in. */
export async function isCleanupAdminCapture(cwd: string, ref: string): Promise<boolean> {
  const commit = await lifecycleReadAsync(cwd, ['cat-file', 'commit', ref]).catch(() => '')
  return commit.slice(commit.indexOf('\n\n') + 2).split('\n')[0] === CLEANUP_ADMIN_MESSAGE
}

/** A linked worktree's administration folder, `<common>/worktrees/<name>`, and the shared folder; never anything else. */
export async function linkedAdminDir(worktreePath: string): Promise<{ adminDir: string; commonDir: string }> {
  const [gitDir, common] = (await lifecycleReadAsync(worktreePath, ['rev-parse', '--git-dir', '--git-common-dir'])).split('\n')
  if (!gitDir || !common) throw new Error('Git did not name the worktree\'s folders')
  const adminDir = await realpath(resolve(worktreePath, gitDir)), commonDir = await realpath(resolve(worktreePath, common))
  const same = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  if (!same(dirname(adminDir), join(commonDir, 'worktrees'))) throw new Error('The worktree has no administration folder of its own')
  return { adminDir, commonDir }
}

/**
 * Git's own data of a worktree that cleanup is about to remove (its settings, HEAD history and own refs), stored as
 * objects only, as one commit whose parents are the commits its HEAD and that data name that nothing else holds
 * (`unheldTips`; `released` names refs that go too, the worktree's branch). Kept by the caller
 * (`keepExistingCommit`), the commit holds both the files and those commits for the owner's Undo window. With every
 * commit held elsewhere it is a root commit; dispatch's repository identity leaves out `refs/mousse/` for that reason.
 */
export async function storeAdminBeforeRemoval(worktreePath: string, released: readonly string[]): Promise<StoredAdmin & { parents: string[] }> {
  const { adminDir, commonDir } = await linkedAdminDir(worktreePath)
  const head = await lifecycleReadAsync(worktreePath, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).catch(() => '')
  let parents: string[] = []
  const stored = await storeAdmin(worktreePath, adminDir, commonDir, undefined, {
    message: CLEANUP_ADMIN_MESSAGE,
    env: mousseCommitEnvNow(),
    parents: async (commits) => (parents = await unheldTips(commonDir, [...new Set([...commits, ...(head ? [head] : [])])], released))
  })
  return { ...stored, parents }
}
