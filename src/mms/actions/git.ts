import { createErrorProvider } from '../../shared/errors'
import { execFileSync, spawnSync } from 'node:child_process'

export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

export function tryGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env })
  return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

const gitOperationErrors = createErrorProvider({
  workspace_not_clean: { category: 'conflict', retryable: false, message: 'The workspace must be clean before this operation. Resolve pending changes or conflicts and retry.' }
})

export function requireClean(cwd: string, label: string): void {
  const status = git(cwd, ['status', '--porcelain=v2', '--untracked-files=all'])
  if (status) throw gitOperationErrors.create('workspace_not_clean', undefined, { label })
}

export function commitParents(cwd: string, sha: string): string[] {
  const line = git(cwd, ['rev-list', '--parents', '-n', '1', sha])
  return line.split(/\s+/).slice(1)
}

/** Child commits are contributions of their merge, never a second reversal unit. */
export function introducedCommits(cwd: string, start: string, end: string): string[] {
  if (start === end) return []
  if (!tryGit(cwd, ['merge-base', '--is-ancestor', start, end]).ok) {
    throw new Error('Workspace history diverged from the recorded change boundary.')
  }
  return git(cwd, ['rev-list', '--first-parent', '--reverse', `${start}..${end}`]).split(/\r?\n/).filter(Boolean)
}

export function changedPaths(cwd: string, start: string, end: string): Array<{ path: string; beforeHash?: string; afterHash?: string }> {
  if (start === end) return []
  const paths = git(cwd, ['diff', '--name-only', `${start}..${end}`]).split(/\r?\n/).filter(Boolean)
  const blob = (revision: string, path: string): string | undefined => {
    const result = tryGit(cwd, ['rev-parse', `${revision}:${path}`])
    return result.ok ? result.stdout : undefined
  }
  return paths.map((path) => ({ path, beforeHash: blob(start, path), afterHash: blob(end, path) }))
}

export const MOUSSE_COMMIT_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'Mousse',
  GIT_AUTHOR_EMAIL: 'mousse@local',
  GIT_COMMITTER_NAME: 'Mousse',
  GIT_COMMITTER_EMAIL: 'mousse@local'
}
