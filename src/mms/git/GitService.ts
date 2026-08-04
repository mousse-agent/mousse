import { existsSync } from 'node:fs'
import simpleGit, { type SimpleGit, type StatusResult } from 'simple-git'
import type {
  GitBranchInfo,
  GitCommit,
  GitDiffStats,
  GitFileChange,
  GitStatusSnapshot
} from '../../shared/types'

function mapStatus(entry: StatusResult['files'][number]): GitFileChange | null {
  const path = entry.path.replace(/\\/g, '/')
  const index = entry.index.trim()
  const workdir = entry.working_dir.trim()

  if (index === '?' && workdir === '?') {
    return { path, status: 'untracked', staged: false }
  }
  if (index === '!' || workdir === '!') {
    return { path, status: 'ignored', staged: false }
  }
  if (index === 'U' || workdir === 'U') {
    return { path, status: 'conflicted', staged: index !== ' ' }
  }

  const staged = index !== ' ' && index !== '?'
  const code = staged ? index : workdir

  const statusMap: Record<string, GitFileChange['status']> = {
    M: 'modified',
    A: 'added',
    D: 'deleted',
    R: 'renamed',
    C: 'copied',
    '?': 'untracked'
  }

  const status = statusMap[code]
  if (!status) return null

  return {
    path,
    status,
    staged,
    originalPath: entry.from ? entry.from.replace(/\\/g, '/') : undefined
  }
}

export class GitService {
  private gitFor(cwd: string): SimpleGit {
    return simpleGit(cwd)
  }

  async isRepo(cwd: string): Promise<boolean> {
    return existsSync(cwd) && this.gitFor(cwd).checkIsRepo().catch(() => false)
  }

  async getStatus(cwd: string): Promise<GitStatusSnapshot> {
    const isRepo = await this.isRepo(cwd)
    if (!isRepo) {
      return { isRepo: false, branch: null, ahead: 0, behind: 0, changes: [] }
    }

    const git = this.gitFor(cwd)
    const status = await git.status()
    const branch = status.current ?? null
    const changes = status.files
      .map(mapStatus)
      .filter((entry): entry is GitFileChange => entry !== null)

    let ahead = 0
    let behind = 0
    if (branch) {
      try {
        const summary = await git.raw(['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`])
        const [behindStr, aheadStr] = summary.trim().split(/\s+/)
        behind = Number(behindStr) || 0
        ahead = Number(aheadStr) || 0
      } catch {
        /* no upstream */
      }
    }

    return { isRepo: true, branch, ahead, behind, changes }
  }

  async getDiff(cwd: string, filePath: string, staged: boolean): Promise<string> {
    if (!await this.isRepo(cwd)) return ''
    const git = this.gitFor(cwd)
    if (staged) {
      return git.diff(['--cached', '--', filePath])
    }

    const status = await git.status()
    const normalized = filePath.replace(/\\/g, '/')
    const entry = status.files.find((file) => file.path.replace(/\\/g, '/') === normalized)
    if (entry?.index === '?' && entry.working_dir === '?') {
      const nullPath = process.platform === 'win32' ? 'NUL' : '/dev/null'
      return git.diff(['--no-index', nullPath, filePath]).catch(() => '')
    }

    return git.diff(['--', filePath])
  }

  async getLog(cwd: string, limit = 30): Promise<GitCommit[]> {
    if (!await this.isRepo(cwd)) return []
    const git = this.gitFor(cwd)
    const log = await git.log({ maxCount: limit })

    // Commits reachable from HEAD but not the upstream are local/un-pushed.
    const unpushed = new Set<string>()
    let hasUpstream = false
    try {
      const status = await git.status()
      const branch = status.current
      if (branch) {
        const raw = await git.raw(['rev-list', `origin/${branch}..HEAD`])
        hasUpstream = true
        for (const line of raw.split('\n')) {
          const hash = line.trim()
          if (hash) unpushed.add(hash)
        }
      }
    } catch {
      /* no upstream / remote — treat commits as local */
    }

    return log.all.map((entry) => ({
      hash: entry.hash,
      shortHash: entry.hash.slice(0, 7),
      message: entry.message,
      author: entry.author_name,
      date: entry.date,
      pushed: hasUpstream && !unpushed.has(entry.hash)
    }))
  }

  async getBranches(cwd: string): Promise<GitBranchInfo> {
    const isRepo = await this.isRepo(cwd)
    if (!isRepo) return { current: null, branches: [] }

    const git = this.gitFor(cwd)
    const summary = await git.branchLocal()
    return {
      current: summary.current ?? null,
      branches: summary.all.filter((name) => !name.startsWith('mousse/agent-'))
    }
  }

  async getDiffStats(cwd: string): Promise<GitDiffStats> {
    const isRepo = await this.isRepo(cwd)
    if (!isRepo) return { additions: 0, deletions: 0, filesChanged: 0 }

    const git = this.gitFor(cwd)
    const parseNumstat = (output: string): GitDiffStats => {
      let additions = 0
      let deletions = 0
      let filesChanged = 0
      for (const line of output.trim().split('\n')) {
        if (!line.trim()) continue
        const [addStr, delStr] = line.split('\t')
        if (addStr === '-' || delStr === undefined) continue
        additions += Number(addStr) || 0
        deletions += Number(delStr) || 0
        filesChanged++
      }
      return { additions, deletions, filesChanged }
    }

    const [unstaged, staged] = await Promise.all([
      git.diff(['--numstat']).catch(() => ''),
      git.diff(['--cached', '--numstat']).catch(() => '')
    ])

    const unstagedStats = parseNumstat(unstaged)
    const stagedStats = parseNumstat(staged)
    return {
      additions: unstagedStats.additions + stagedStats.additions,
      deletions: unstagedStats.deletions + stagedStats.deletions,
      filesChanged: unstagedStats.filesChanged + stagedStats.filesChanged
    }
  }

  async checkout(cwd: string, branch: string): Promise<void> {
    const git = this.gitFor(cwd)
    await git.checkout(branch)
  }

  async commit(cwd: string, message: string): Promise<void> {
    const git = this.gitFor(cwd)
    await git.add(['-A'])
    await git.commit(message)
  }

  async push(cwd: string): Promise<void> {
    const git = this.gitFor(cwd)
    const status = await git.status()
    const branch = status.current
    if (!branch) throw new Error('No branch checked out')
    try {
      await git.push(['-u', 'origin', branch])
    } catch {
      await git.push()
    }
  }
}
