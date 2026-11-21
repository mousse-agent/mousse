import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { IN_PROGRESS_GIT_MARKERS } from './gitMarkers'

/**
 * Where a checkout's HEAD is, read from Git's own files instead of starting Git: a turn in a thread's own worktree
 * checks its worktree this way, so nothing waits for a Git process before the provider is called (each one costs
 * hundreds of milliseconds on Windows, and seconds on a hard disk that has to seek).
 *
 * Only the plain layout Git writes is read: a `.git` file (a linked worktree) or folder, its `HEAD`, the `commondir`
 * file, a loose ref or a `packed-refs` line. Anything else (the reftable format, a symbolic ref chain, a file that
 * cannot be read or does not look as Git writes it, configuration that can move the checkout elsewhere) answers
 * undefined, and the caller asks Git as before.
 */
export interface WorktreeHead {
  /** The commit HEAD is on; undefined while its branch has no commit yet. */
  head?: string
  /** The full ref HEAD is on (`refs/heads/main`); undefined when HEAD is detached. */
  headRef?: string
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
/** Refs each worktree keeps in its own Git folder; every other ref is in the shared one. */
const PER_WORKTREE = /^refs\/(?:bisect|worktree|rewritten)\//

async function text(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') } catch { return undefined }
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory() } catch { return false }
}

async function readPathPointer(path: string, prefix = ''): Promise<string | undefined> {
  const line = (await text(path))?.replace(/[\r\n]+$/, '')
  if (!line?.startsWith(prefix)) return undefined
  const pointer = line.slice(prefix.length)
  return pointer && pointer === pointer.trim() && !/[\r\n\0]/.test(pointer) ? pointer : undefined
}

function refName(ref: string): boolean {
  return ref.startsWith('refs/') && !ref.endsWith('.') && !ref.includes('..') && !ref.includes('@{') &&
    !/[ ~^:?*\[\\\x00-\x1f\x7f\uFFFD]/.test(ref) &&
    ref.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'))
}

/** Git writes one LF after a loose ref or HEAD. Extra bytes are left for Git to interpret. */
function gitLine(value: string | undefined): string | undefined {
  if (!value?.endsWith('\n')) return undefined
  const line = value.slice(0, -1)
  return /[\r\n]/.test(line) ? undefined : line
}

/** The value of `ref` as Git keeps it: its loose file, else its line in `packed-refs`; null when there is none. */
async function refValue(gitDir: string, common: string, ref: string): Promise<string | null | undefined> {
  if (!refName(ref)) return undefined
  try {
    const loose = join(PER_WORKTREE.test(ref) ? gitDir : common, ...ref.split('/'))
    if (!(await lstat(loose)).isFile()) return undefined
    const value = gitLine(await readFile(loose, 'utf8'))
    // A symbolic ref or anything unexpected is left to Git.
    return value && SHA.test(value) ? value : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
  }
  let packed: string
  try {
    const path = join(common, 'packed-refs')
    if (!(await lstat(path)).isFile()) return undefined
    packed = await readFile(path, 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined
  }
  const lines = packed.split('\n')
  if (lines.pop() !== '') return undefined
  if (lines[0]?.startsWith('# pack-refs with: ')) lines.shift()
  let value: string | null = null
  let canPeel = false
  for (const line of lines) {
    if (canPeel && line.startsWith('^') && SHA.test(line.slice(1))) {
      canPeel = false
      continue
    }
    const space = line.indexOf(' ')
    const oid = line.slice(0, space)
    const name = line.slice(space + 1)
    if (space < 0 || !SHA.test(oid) || !refName(name)) return undefined
    canPeel = true
    if (name !== ref) continue
    if (value !== null) return undefined
    value = oid
  }
  return value
}

/** Read only ordinary files-based repositories. Git validates more formats and extensions than this reader handles. */
async function configFingerprint(gitDir: string, common: string): Promise<string | undefined> {
  const overrides = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS']
  if (overrides.some((key) => process.env[key]) || Number(process.env.GIT_CONFIG_COUNT || 0) !== 0) return undefined
  if (await present(join(gitDir, 'config.worktree'))) return undefined
  const bytes = await readFile(join(common, 'config')).catch(() => undefined)
  if (!bytes) return undefined
  const config = bytes.toString('utf8')
  if (/\0|\\\r?\n/.test(config)) return undefined
  let section: string | undefined
  for (const raw of config.split(/\r?\n/)) {
    let line = raw.replace(/^[\t ]+|[\t ]+$/g, '')
    if (line.startsWith('[')) {
      const header = /^\[([a-z][a-z0-9-]*)(?:\.[a-z0-9.-]+|[\t ]+"(?:[^"\\]|\\["\\])*")?[\t ]*\]/i.exec(line)
      if (!header) return undefined
      section = header[1]!.toLowerCase()
      if (['extensions', 'include', 'includeif'].includes(section)) return undefined
      line = line.slice(header[0].length).replace(/^[\t ]+/, '')
    }
    if (!line || /^[#;]/.test(line)) continue
    const entry = /^([a-z][a-z0-9-]*)[\t ]*(?:=((?:"(?:[^"\\]|\\[ntb"\\])*"|\\[ntb"\\]|[^"\\#;])*))?(?:[#;].*)?$/i.exec(line)
    if (!section || !entry) return undefined
    if (section !== 'core') continue
    const key = entry[1]!.toLowerCase()
    const value = entry[2]?.replace(/^[\t ]+|[\t ]+$/g, '')
    if (key === 'worktree' || (key === 'bare' && value !== 'false')) return undefined
    if (key === 'repositoryformatversion' && value !== '0' && value !== '1') return undefined
  }
  return createHash('sha256').update(bytes).digest('hex')
}

function fileIdentity(entry: BigIntStats): string {
  return `${entry.dev}:${entry.ino}:${entry.birthtimeNs}`
}

/** Loose-object directories can be added by every snapshot. Replacing the store or changing its packs requires Git. */
async function objectStoreFingerprint(common: string): Promise<string | undefined> {
  const objects = join(common, 'objects')
  if (await present(join(objects, 'info', 'alternates'))) return undefined
  try {
    const [store, pack] = await Promise.all([
      lstat(objects, { bigint: true }),
      lstat(join(objects, 'pack'), { bigint: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return undefined
      })
    ])
    if (!store.isDirectory() || !store.ino || (pack && (!pack.isDirectory() || !pack.ino))) return undefined
    return pack ? `${fileIdentity(store)}:${fileIdentity(pack)}:${pack.mtimeNs}:${pack.ctimeNs}` : fileIdentity(store)
  } catch {
    return undefined
  }
}

/** Unreadable state is left to Git too. */
async function present(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

const samePath = (a: string, b: string): boolean => {
  const norm = (path: string) => resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b)
}

/**
 * HEAD of the checkout at `top` (its top folder), read from Git's files; undefined when Git must be asked. With
 * `linkedOnly`, only a linked worktree is read: its `.git` is a file, and the Git folder it names links back to it (Git's
 * own `gitdir` file there). A `.git` folder (someone ran `git init` in an emptied worktree) or a link elsewhere asks Git.
 */
export async function readWorktreeHead(top: string, options: { linkedOnly?: boolean } = {}): Promise<WorktreeHead | undefined> {
  return (await readCheckout(top, options))?.head
}

/**
 * The checkout and Git directory identities, with the repository config and object storage fingerprints.
 * These must still match when a turn starts without asking Git.
 */
export interface CheckoutIdentity {
  realPath: string
  gitDir: string
  gitDirId: string
  worktreeId: string
  commonDir: string
  commonDirId: string
  configHash: string
  objectStoreId: string
}

/**
 * A linked worktree's HEAD, its physical identity (`CheckoutIdentity`), and the value of each of `refs` (null when there
 * is none), read from Git's files; undefined when Git must be asked (`readWorktreeHead`).
 */
export async function readLinkedCheckout(top: string, refs: readonly string[] = []): Promise<{ head: WorktreeHead; identity: CheckoutIdentity; refs: Map<string, string | null> } | undefined> {
  const read = await readCheckout(top, { linkedOnly: true })
  if (!read || (await Promise.all(IN_PROGRESS_GIT_MARKERS.map((marker) => present(join(read.gitDir, marker))))).some(Boolean)) return undefined
  const values = new Map<string, string | null>()
  for (const ref of refs) {
    const value = await refValue(read.gitDir, read.common, ref)
    if (value === undefined) return undefined
    values.set(ref, value)
  }
  try {
    const [worktree, gitDirectory, commonDirectory, realPath] = await Promise.all([
      stat(top, { bigint: true }), stat(read.gitDir, { bigint: true }), stat(read.common, { bigint: true }), realpath(top)
    ])
    if (!worktree.ino || !gitDirectory.ino || !commonDirectory.ino) return undefined
    return {
      head: read.head, refs: values,
      identity: {
        realPath, gitDir: read.gitDir, commonDir: read.common,
        gitDirId: fileIdentity(gitDirectory), worktreeId: fileIdentity(worktree), commonDirId: fileIdentity(commonDirectory),
        configHash: read.configHash, objectStoreId: read.objectStoreId
      }
    }
  } catch {
    return undefined
  }
}

async function readCheckout(top: string, options: { linkedOnly?: boolean }): Promise<{ head: WorktreeHead; gitDir: string; common: string; configHash: string; objectStoreId: string } | undefined> {
  let gitDir: string, common: string
  try {
    const dotGit = join(top, '.git')
    const entry = await lstat(dotGit)
    if (entry.isDirectory() && !options.linkedOnly) {
      gitDir = common = await realpath(dotGit)
      if (await present(join(gitDir, 'commondir'))) return undefined
    } else if (entry.isFile()) {
      const pointer = await readPathPointer(dotGit, 'gitdir: ')
      if (!pointer) return undefined
      gitDir = await realpath(isAbsolute(pointer) ? pointer : resolve(top, pointer))
      const commonFile = join(gitDir, 'commondir')
      const backFile = join(gitDir, 'gitdir')
      if (!(await lstat(commonFile)).isFile() || !(await lstat(backFile)).isFile()) return undefined
      const commonPointer = await readPathPointer(commonFile)
      const back = await readPathPointer(backFile)
      if (!commonPointer || !back) return undefined
      common = await realpath(isAbsolute(commonPointer) ? commonPointer : resolve(gitDir, commonPointer))
      if (!samePath(dirname(gitDir), join(common, 'worktrees'))) return undefined
      const backlink = await realpath(isAbsolute(back) ? back : resolve(gitDir, back))
      if (!samePath(backlink, await realpath(dotGit))) return undefined
    } else {
      return undefined
    }
  } catch {
    return undefined
  }
  // The reftable format keeps refs in a binary table: only Git reads it.
  const [objectStoreId, refs, reftable, configHash] = await Promise.all([
    objectStoreFingerprint(common), isDirectory(join(common, 'refs')), present(join(common, 'reftable')), configFingerprint(gitDir, common)
  ])
  if (!objectStoreId || !refs || reftable || !configHash) return undefined
  const layout = { gitDir, common, configHash, objectStoreId }
  const headPath = join(gitDir, 'HEAD')
  if (!(await lstat(headPath).catch(() => undefined))?.isFile()) return undefined
  const head = gitLine(await text(headPath))
  if (!head) return undefined
  if (SHA.test(head)) return { ...layout, head: { head } }
  if (!head.startsWith('ref: ')) return undefined
  const ref = head.slice('ref: '.length)
  const value = await refValue(gitDir, common, ref)
  if (value === undefined) return undefined
  return { ...layout, head: value === null ? { headRef: ref } : { head: value, headRef: ref } }
}
