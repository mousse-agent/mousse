import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'

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
