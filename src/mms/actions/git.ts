import { execFileSync, spawnSync } from 'node:child_process'

export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

export function tryGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

export function requireClean(cwd: string, label: string): void {
  const status = git(cwd, ['status', '--porcelain=v2', '--untracked-files=all'])
  if (status) throw new Error(`${label} must be clean before this operation.`)
}

export function commitParents(cwd: string, sha: string): string[] {
  const line = git(cwd, ['rev-list', '--parents', '-n', '1', sha])
  return line.split(/\s+/).slice(1)
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
