import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync, type BigIntStats } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { englishMessagesEnv } from './gitProcess'
import { GitPolicyError } from './gitPolicy'
import { READ_ONLY_GIT_ENV } from './readOnlyGit'
import { repoProgramEnv, repoProgramSettings, repoProgramSettingsAsync, withoutRepoPrograms, withoutRepoProgramsAsync } from './repoPrograms'

/**
 * One path's state as `git status --porcelain` would print it: a code for the index side and one for the
 * working tree side (`''` for no change), `??` for an untracked file, and the old name of a staged rename.
 * Paths are relative to the top of the repository and use `/`.
 */
export interface StatusEntry {
  path: string
  index: string
  workdir: string
  from?: string
}

/** Large enough for the status of a very big repository; a read past it fails instead of returning part of it. */
const MAX_OUTPUT = 256 * 1024 * 1024
/** Files hashed per `hash-object` run, well inside every platform's command-line limit. */
const HASH_BATCH = 200
/** `hash-object` runs at once: enough to use a few cores, few enough not to flood the machine with processes. */
const HASH_PARALLEL = 4

/** The environment of every plumbing read: no optional lock (the index is never refreshed and written back), no lazy fetch. */
function plumbingEnv(): NodeJS.ProcessEnv {
  return repoProgramEnv({ ...process.env, ...englishMessagesEnv(), ...READ_ONLY_GIT_ENV })
}

/**
 * A plumbing read from the top of the repository: no program the repository configures runs, no optional
 * lock is taken (so the index is never refreshed and written back), and a partial clone fetches nothing.
 */
async function plumbing(top: string, args: readonly string[]): Promise<string> {
  const argv = await withoutRepoProgramsAsync(top, args)
  return new Promise((resolvePromise, reject) => {
    execFile('git', argv, { cwd: top, env: plumbingEnv(), encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: MAX_OUTPUT }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(stderr.trim() || error.message), { cause: error }))
      else resolvePromise(stdout)
    })
  })
}

/** The same read, blocking: for callers that cannot wait (the checks before a checkpoint). */
function plumbingSync(top: string, args: readonly string[]): string {
  const result = spawnSync('git', withoutRepoPrograms(top, args), { cwd: top, env: plumbingEnv(), encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: MAX_OUTPUT })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed with exit code ${result.status}`)
  return result.stdout
}

interface RawRecord {
  srcMode: string
  dstMode: string
  srcSha: string
  dstSha: string
  status: string
  path: string
  from?: string
}

/** `diff-index`/`diff-files -z --raw`: `:srcmode dstmode srcsha dstsha STATUS NUL path NUL [path NUL]`. */
export function parseRawDiff(output: string): RawRecord[] {
  const fields = output.split('\0')
  const records: RawRecord[] = []
  for (let index = 0; index < fields.length; ) {
    const header = fields[index++]
    if (!header?.startsWith(':')) continue
    const [srcMode, dstMode, srcSha, dstSha, status] = header.slice(1).split(' ')
    if (!status) continue
    const letter = status[0]!
    if (letter === 'R' || letter === 'C') {
      const from = fields[index++] ?? ''
      const path = fields[index++] ?? ''
      records.push({ srcMode: srcMode!, dstMode: dstMode!, srcSha: srcSha!, dstSha: dstSha!, status: letter, path, from })
    } else {
      records.push({ srcMode: srcMode!, dstMode: dstMode!, srcSha: srcSha!, dstSha: dstSha!, status: letter, path: fields[index++] ?? '' })
    }
  }
  return records
}

/** The porcelain pair for a conflicted path, from the stages the index holds for it (1 base, 2 ours, 3 theirs). */
export function conflictPair(stages: ReadonlySet<number>): string {
  const base = stages.has(1)
  const ours = stages.has(2)
  const theirs = stages.has(3)
  if (base && ours && theirs) return 'UU'
  if (!base && ours && theirs) return 'AA'
  if (base && ours) return 'UD'
  if (base && theirs) return 'DU'
  if (ours) return 'AU'
  if (theirs) return 'UA'
  return 'DD'
}

const isZero = (sha: string): boolean => /^0+$/.test(sha)
const REGULAR = new Set(['100644', '100755'])
const LINK = '120000'

/** A Git read the status needs: `optional` ones yield '' instead of failing the whole read. */
interface GitRead { args: readonly string[]; optional?: boolean }
/**
 * The stat data of files (paths relative to the folder, or absolute), answered one line per path: its
 * {@link fileSignature}, or '' when it cannot be read.
 */
interface StatRead { stat: readonly string[] }
/** The `-c` settings Mousse's own Git commands run with in the folder, answered one per line. */
interface SettingsRead { programSettings: true }
type Read = GitRead | StatRead | SettingsRead
/** The reads of one step, run together; the step gets their output in the same order. */
type Step = Read[]

/** What a regular file's stat data says about its content: size, modification and change times in nanoseconds, and inode. '' for anything else. */
function fileSignature(stats: BigIntStats): string {
  return stats.isFile() ? `${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}:${stats.ino}` : ''
}

/**
 * Files whose content was hashed and found to be what the index holds, with the stat data they had then. Mousse never
 * refreshes the index, so a file whose times changed but whose content did not stays "modified" to `diff-files` for
 * good, and without this every status read hashed it again: thousands of files after a checkout by another tool. A
 * file is taken as unchanged without hashing only while its stat data is exactly what it was, against the same index
 * entry, which is how Git's own index decides it, and while nothing that decides how Git converts content changed
 * (its {@link conversionSteps} fingerprint).
 */
const verifiedUnchanged = new Map<string, { sha: string; signature: string; fingerprint: string }>()
/** Remembered files at most; past it the memory starts over. */
const VERIFIED_MAX = 200_000
/**
 * A file changed within this long of being hashed is not remembered: a write in the same timestamp tick as the hash
 * would leave its stat data as it was (Git calls this "racily clean").
 */
const RACY_MS = 2_000

function rememberUnchanged(path: string, sha: string, signature: string, fingerprint: string, hashedAt: number): void {
  if (!signature) return
  const [, mtimeNs, ctimeNs] = signature.split(':')
  const changedAt = Number(BigInt(mtimeNs!) > BigInt(ctimeNs!) ? BigInt(mtimeNs!) / 1_000_000n : BigInt(ctimeNs!) / 1_000_000n)
  if (changedAt > hashedAt - RACY_MS) return
  if (verifiedUnchanged.size >= VERIFIED_MAX) verifiedUnchanged.clear()
  verifiedUnchanged.set(path, { sha, signature, fingerprint })
}

/** The value of `key` (lower case, as `config --list` prints it) in a `git config --null --list` listing; the last one wins. */
function configValue(listing: string, key: string): string | null {
  let value: string | null = null
  for (const entry of listing.split('\0')) {
    const newline = entry.indexOf('\n')
    const name = newline < 0 ? entry : entry.slice(0, newline)
    if (name.toLowerCase() === key) value = newline < 0 ? 'true' : entry.slice(newline + 1)
  }
  return value
}

/** The user's own attributes file: `core.attributesFile`, else Git's default under the config home. */
function globalAttributesFile(listing: string): string {
  const configured = configValue(listing, 'core.attributesfile')
  const home = process.env.HOME || homedir()
  if (configured) return configured.startsWith('~/') ? join(home, configured.slice(2)) : configured
  return process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'git', 'attributes') : join(home, '.config', 'git', 'attributes')
}

/**
 * A fingerprint of everything that decides what `hash-object` makes of a file's content, read in `cwd`: every config
 * value Git sees (`core.autocrlf`, `core.eol`, `core.safecrlf`, `filter.*`, encodings, from every scope), the settings
 * Mousse adds to its own commands, the stat data of each `.gitattributes` in the tree, `info/attributes` and the user's
 * attributes file, and the index's (which `core.autocrlf` consults, and which every commit and stage rewrites). Null
 * when a read it needs failed: nothing is then taken from, or added to, the memory of unchanged files.
 */
function* conversionSteps(cwd: string): Generator<Step, string | null, string[]> {
  const [listing, paths, attributes, settings] = yield [
    { args: ['config', '--null', '--list'], optional: true },
    { args: ['rev-parse', '--git-path', 'info/attributes', '--git-path', 'index'], optional: true },
    { args: ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.gitattributes', '*/.gitattributes'], optional: true },
    { programSettings: true }
  ]
  const gitPaths = paths!.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!listing || gitPaths.length !== 2) return null
  const files = [...gitPaths, globalAttributesFile(listing!), ...attributes!.split('\0').filter(Boolean)]
  const [signatures] = yield [{ stat: files }]
  return createHash('sha256').update([listing, settings, files.join('\0'), signatures].join('\u0001')).digest('hex')
}

/** For tests: forget which files were found unchanged. */
export function clearVerifiedUnchanged(): void {
  verifiedUnchanged.clear()
}

/** A blob's object name, as Git computes it: for a link's target, which `hash-object <path>` would follow instead. */
function blobName(format: string, content: Buffer): string {
  return createHash(format === 'sha256' ? 'sha256' : 'sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
}

/**
 * What a link (or, where links are checked out as plain files, the file standing in for one) holds as Git
 * stores it: the target, not the content it points at. Null when it cannot be read.
 */
function linkContent(top: string, path: string): Buffer | null {
  try {
    const full = join(top, path)
    return lstatSync(full).isSymbolicLink() ? Buffer.from(readlinkSync(full)) : readFileSync(full)
  } catch {
    return null
  }
}

/**
 * The paths of `records` (a `--raw` diff against the working tree, paths relative to `cwd`) whose content did
 * not change: Git compared their stat data only and reported them as modified with no object name for the
 * working tree side. A file counts as unchanged when `hash-object` (line endings and filters applied as Git
 * would, nothing written) gives the object the other side has; a link, when its target does. A changed mode,
 * a deletion or a type change is never in the set.
 */
function* unchangedSteps(cwd: string, records: readonly RawRecord[], objectFormat: string): Generator<Step, Set<string>, string[]> {
  const unsure = records.filter((record) => record.status === 'M' && record.srcMode === record.dstMode && isZero(record.dstSha))
  const unchanged = new Set<string>()
  for (const record of unsure.filter((item) => item.srcMode === LINK)) {
    const content = linkContent(cwd, record.path)
    if (content && blobName(objectFormat, content) === record.srcSha) unchanged.add(record.path)
  }
  const files = unsure.filter((item) => REGULAR.has(item.srcMode))
  if (files.length === 0) return unchanged
  // Taken before the stat data is read, so a write after the read is never remembered as the state that was hashed.
  const hashedAt = Date.now()
  // Read before the files' stat data and the hashes, so a change to the settings after it is never remembered as theirs.
  const fingerprint = yield* conversionSteps(cwd)
  const [statOutput] = yield [{ stat: files.map((record) => record.path) }]
  const signatures = statOutput!.split('\n')
  const toHash: Array<{ record: RawRecord; path: string; signature: string }> = []
  files.forEach((record, index) => {
    const path = resolve(cwd, record.path)
    const signature = signatures[index] ?? ''
    const known = verifiedUnchanged.get(path)
    if (fingerprint !== null && signature && known?.sha === record.srcSha && known.signature === signature && known.fingerprint === fingerprint) unchanged.add(record.path)
    else toHash.push({ record, path, signature })
  })
  const batches: Array<typeof toHash> = []
  for (let start = 0; start < toHash.length; start += HASH_BATCH) batches.push(toHash.slice(start, start + HASH_BATCH))
  for (let start = 0; start < batches.length; start += HASH_PARALLEL) {
    const group = batches.slice(start, start + HASH_PARALLEL)
    // A file that went away meanwhile fails its batch; that batch's files then stay reported as changed.
    const outputs = yield group.map((batch) => ({ args: ['hash-object', '--', ...batch.map(({ record }) => record.path)], optional: true }))
    group.forEach((batch, batchIndex) => {
      const hashes = outputs[batchIndex]!.split(/\r?\n/)
      batch.forEach(({ record, path, signature }, index) => {
        if (hashes[index]?.trim() !== record.srcSha) return
        unchanged.add(record.path)
        if (fingerprint !== null) rememberUnchanged(path, record.srcSha, signature, fingerprint, hashedAt)
      })
    })
  }
  return unchanged
}

/**
 * The paths a `git diff --raw --no-abbrev -z` against the working tree (run in `cwd`, paths relative to it) reports as
 * modified although their content is unchanged. Mousse's own diffs run without refreshing the index
 * (`diff.autoRefreshIndex=false`), so a listing such as `--name-status` includes files whose stat data alone
 * changed; this tells them apart without writing anything.
 */
export async function unchangedWorktreePaths(cwd: string, raw: string): Promise<Set<string>> {
  const records = parseRawDiff(raw)
  if (!records.some((record) => record.status === 'M' && isZero(record.dstSha))) return new Set()
  const format = (await plumbing(cwd, ['rev-parse', '--show-object-format']).catch(() => '')).trim() || 'sha1'
  return drive(cwd, unchangedSteps(cwd, records, format))
}

/**
 * The status, as a sequence of steps a sync or an async driver runs: `diff-index --cached` for the index
 * against HEAD, `diff-files` for the working tree against the index, `ls-files --unmerged` for conflicts
 * and `ls-files --others` for untracked files. None of these writes the index.
 *
 * `diff-files` compares file times and sizes only, so a file or link whose times changed but whose content
 * did not (a `touch`, a checkout from another tool) is reported as changed. `git status` would refresh the
 * index to drop it; here the content is compared instead, and the entry dropped when it still matches:
 * a file is hashed by `hash-object` (line endings and filters applied as Git would, nothing written), a
 * link by its target.
 */
function* statusSteps(top: string): Generator<Step, StatusEntry[], string[]> {
  const [head, format] = yield [{ args: ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'], optional: true }, { args: ['rev-parse', '--show-object-format'], optional: true }]
  const objectFormat = format!.trim() || 'sha1'
  const base = head!.trim() || createHash(objectFormat === 'sha256' ? 'sha256' : 'sha1').update('tree 0\0').digest('hex')
  const options = ['-z', '--raw', '--ignore-submodules=dirty', '--ita-invisible-in-index']
  const [staged, unstaged, unmerged, untracked] = yield [
    { args: ['diff-index', '--cached', '-M', ...options, base, '--'] },
    { args: ['diff-files', ...options, '--'] },
    { args: ['ls-files', '-z', '--unmerged', '--'] },
    { args: ['ls-files', '-z', '--others', '--exclude-standard', '--'] }
  ]

  const stages = new Map<string, Set<number>>()
  for (const line of unmerged!.split('\0')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const stage = Number(line.slice(0, tab).split(' ')[2])
    const path = line.slice(tab + 1)
    if (!stages.has(path)) stages.set(path, new Set())
    stages.get(path)!.add(stage)
  }

  const entries = new Map<string, StatusEntry>()
  const entry = (path: string): StatusEntry => {
    let found = entries.get(path)
    if (!found) entries.set(path, found = { path, index: '', workdir: '' })
    return found
  }
  for (const [path, held] of stages) {
    const pair = conflictPair(held)
    Object.assign(entry(path), { index: pair[0], workdir: pair[1] })
  }
  for (const record of parseRawDiff(staged!)) {
    if (record.status === 'U' || stages.has(record.path)) continue
    const found = entry(record.path)
    found.index = record.status
    if (record.from !== undefined) found.from = record.from
  }

  const workdir = parseRawDiff(unstaged!).filter((record) => record.status !== 'U' && !stages.has(record.path))
  const unchanged = yield* unchangedSteps(top, workdir, objectFormat)
  for (const record of workdir) {
    if (unchanged.has(record.path)) continue
    entry(record.path).workdir = record.status
  }

  const tracked = [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const others = untracked!.split('\0').filter(Boolean).map((path) => ({ path, index: '?', workdir: '?' }))
  return [...tracked, ...others]
}

/** The working tree's status, read with plumbing so that reading it never writes the index ({@link statusSteps}). */
export async function readWorkingTreeStatus(top: string): Promise<StatusEntry[]> {
  return drive(top, statusSteps(top))
}

/** Runs the reads of `steps` in `cwd`, each step's reads together. */
async function drive<T>(cwd: string, steps: Generator<Step, T, string[]>): Promise<T> {
  let next = steps.next([])
  while (!next.done) {
    next = steps.next(await Promise.all(next.value.map((read) => 'stat' in read
      ? Promise.all(read.stat.map((path) => lstat(resolve(cwd, path), { bigint: true }).then(fileSignature, () => ''))).then((lines) => lines.join('\n'))
      : 'programSettings' in read
        ? repoProgramSettingsAsync(cwd).then((settings) => settings.join('\n'), () => '')
        : plumbing(cwd, read.args).catch((error: unknown) => {
          if (read.optional && !(error instanceof GitPolicyError)) return ''
          throw error
        }))))
  }
  return next.value
}

/** {@link fileSignature} of a path, blocking; '' when it cannot be read. */
function fileSignatureSync(path: string): string {
  try {
    return fileSignature(lstatSync(path, { bigint: true }))
  } catch {
    return ''
  }
}

/** {@link readWorkingTreeStatus}, blocking. */
export function readWorkingTreeStatusSync(top: string): StatusEntry[] {
  const steps = statusSteps(top)
  let next = steps.next([])
  while (!next.done) {
    next = steps.next(next.value.map((read) => {
      if ('stat' in read) return read.stat.map((path) => fileSignatureSync(resolve(top, path))).join('\n')
      if ('programSettings' in read) {
        try {
          return repoProgramSettings(top).join('\n')
        } catch {
          return ''
        }
      }
      try {
        return plumbingSync(top, read.args)
      } catch (error) {
        if (read.optional && !(error instanceof GitPolicyError)) return ''
        throw error
      }
    }))
  }
  return next.value
}
