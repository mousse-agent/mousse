import { execFile } from 'node:child_process'
import { englishMessagesEnv } from './gitProcess'
import { READ_ONLY_GIT_ENV } from './readOnlyGit'
import { repoProgramEnv, withoutRepoPrograms } from './repoPrograms'
import { emptyTreeSha } from './reviewDiff'

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

/**
 * A plumbing read from the top of the repository: no program the repository configures runs, no optional
 * lock is taken (so the index is never refreshed and written back), and a partial clone fetches nothing.
 */
function plumbing(top: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let argv: string[]
    try {
      argv = withoutRepoPrograms(top, args)
    } catch (error) {
      reject(error)
      return
    }
    execFile('git', argv, {
      cwd: top,
      env: repoProgramEnv({ ...process.env, ...englishMessagesEnv(), ...READ_ONLY_GIT_ENV }),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: MAX_OUTPUT
    }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(stderr.trim() || error.message), { cause: error }))
      else resolvePromise(stdout)
    })
  })
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

/**
 * The working tree's status, read with plumbing instead of `git status`: `diff-index --cached` for the
 * index against HEAD, `diff-files` for the working tree against the index, `ls-files --unmerged` for
 * conflicts and `ls-files --others` for untracked files. None of these writes the index.
 *
 * `diff-files` compares file times and sizes only, so a file whose times changed but whose content did
 * not (a `touch`, a checkout from another tool) is reported as changed. `git status` would refresh the
 * index to drop it; here the file is hashed instead and dropped when it still matches the index.
 */
export async function readWorkingTreeStatus(top: string): Promise<StatusEntry[]> {
  const head = (await plumbing(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}']).catch(() => '')).trim()
  const base = head || await emptyTreeSha(top)
  const options = ['-z', '--raw', '--ignore-submodules=dirty', '--ita-invisible-in-index']
  const [staged, unstaged, unmerged, untracked] = await Promise.all([
    plumbing(top, ['diff-index', '--cached', '-M', ...options, base, '--']),
    plumbing(top, ['diff-files', ...options, '--']),
    plumbing(top, ['ls-files', '-z', '--unmerged', '--']),
    plumbing(top, ['ls-files', '-z', '--others', '--exclude-standard', '--'])
  ])

  const stages = new Map<string, Set<number>>()
  for (const line of unmerged.split('\0')) {
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
  for (const record of parseRawDiff(staged)) {
    if (record.status === 'U' || stages.has(record.path)) continue
    const found = entry(record.path)
    found.index = record.status
    if (record.from !== undefined) found.from = record.from
  }

  const workdir = parseRawDiff(unstaged).filter((record) => record.status !== 'U' && !stages.has(record.path))
  // Only the time stamps differ, as far as `diff-files` can tell without reading the file.
  const unsure = workdir.filter((record) => record.status === 'M' && record.srcMode === record.dstMode && REGULAR.has(record.srcMode) && isZero(record.dstSha))
  const unchanged = new Set<string>()
  for (let start = 0; start < unsure.length; start += HASH_BATCH) {
    const batch = unsure.slice(start, start + HASH_BATCH)
    // Hashed as Git would store them (line endings, filters by path), without writing anything.
    // A file that went away meanwhile fails the batch; its files then stay reported as changed.
    const hashes = (await plumbing(top, ['hash-object', '--', ...batch.map((record) => record.path)]).catch(() => '')).split(/\r?\n/)
    batch.forEach((record, index) => {
      if (hashes[index]?.trim() === record.srcSha) unchanged.add(record.path)
    })
  }
  for (const record of workdir) {
    if (unchanged.has(record.path)) continue
    entry(record.path).workdir = record.status
  }

  const tracked = [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const others = untracked.split('\0').filter(Boolean).map((path) => ({ path, index: '?', workdir: '?' }))
  return [...tracked, ...others]
}
