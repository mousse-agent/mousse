import type { StatusEntry } from './workingTreeStatus'

/**
 * The arguments of the one `git status` the side card's status read runs: the branch with its upstream and how far the
 * two are apart, and every change, untracked files one by one. Settings a user's config could change are named, so the
 * answer is the same as the plumbing read's (`readWorkingTreeStatus`): renames in the index found, submodules' own
 * edits left out. Mousse's own commands run with optional locks off, so this never refreshes or writes the index.
 */
export const STATUS_ARGS = ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignore-submodules=dirty', '--renames', '--ahead-behind'] as const

export interface PorcelainStatus {
  /** The branch HEAD is on; null when detached. */
  branch: string | null
  /** HEAD has a commit. */
  born: boolean
  /** The branch's upstream; null without one, or when the upstream's branch is gone. */
  upstream: string | null
  ahead: number
  behind: number
  entries: StatusEntry[]
}

/** `.` is Git's "unchanged" in a porcelain v2 `XY`; the plumbing read writes it as ''. */
const side = (code: string): string => (code === '.' ? '' : code)

/** Splits `fields` space-separated fields off the front of a record; the rest is the path, which may hold spaces. */
function fieldsAndPath(record: string, fields: number): [string[], string] {
  const parts: string[] = []
  let at = 0
  for (let index = 0; index < fields; index++) {
    const next = record.indexOf(' ', at)
    if (next < 0) throw new Error(`Unexpected git status record: ${record.slice(0, 80)}`)
    parts.push(record.slice(at, next))
    at = next + 1
  }
  return [parts, record.slice(at)]
}

/** Reads `git status` output for {@link STATUS_ARGS}. A record it does not know throws rather than being dropped. */
export function parsePorcelainStatus(output: string): PorcelainStatus {
  const records = output.split('\0')
  const status: PorcelainStatus = { branch: null, born: true, upstream: null, ahead: 0, behind: 0, entries: [] }
  let upstream: string | null = null
  let counted = false
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!
    if (!record) continue
    if (record.startsWith('# ')) {
      const [name, ...rest] = record.slice(2).split(' ')
      const value = rest.join(' ')
      if (name === 'branch.oid') status.born = value !== '(initial)'
      else if (name === 'branch.head') status.branch = value === '(detached)' ? null : value
      else if (name === 'branch.upstream') upstream = value
      else if (name === 'branch.ab') {
        counted = true
        status.ahead = Number(/\+(\d+)/.exec(value)?.[1] ?? 0)
        status.behind = Number(/-(\d+)/.exec(value)?.[1] ?? 0)
      }
      continue
    }
    const kind = record[0]
    if (kind === '?' || kind === '!') {
      status.entries.push({ path: record.slice(2), index: kind, workdir: kind })
    } else if (kind === '1') {
      const [[, xy], path] = fieldsAndPath(record, 8)
      status.entries.push({ path, index: side(xy![0]!), workdir: side(xy![1]!) })
    } else if (kind === '2') {
      const [[, xy], path] = fieldsAndPath(record, 9)
      // With -z the old path is the next record.
      const from = records[++index] ?? ''
      status.entries.push({ path, index: side(xy![0]!), workdir: side(xy![1]!), ...(from ? { from } : {}) })
    } else if (kind === 'u') {
      const [[, xy], path] = fieldsAndPath(record, 10)
      status.entries.push({ path, index: xy![0]!, workdir: xy![1]! })
    } else {
      throw new Error(`Unexpected git status record: ${record.slice(0, 80)}`)
    }
  }
  // Git names an upstream whose branch is gone without counting it: that reads as no upstream, as `@{upstream}` does.
  status.upstream = status.branch && counted ? upstream : null
  if (!status.upstream) { status.ahead = 0; status.behind = 0 }
  return status
}
