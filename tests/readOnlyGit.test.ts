import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const spawned: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv | undefined }> = []
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: ((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    spawned.push({ args, env: options.env })
    return (actual.spawnSync as (...parameters: unknown[]) => unknown)(command, args, options)
  }) as typeof actual.spawnSync }
})

const { readOnlyGit, runReadOnlyGit } = await import('../src/mms/git/readOnlyGit')
const { lifecycleGit } = await import('../src/mms/lifecycle/WorktreeRetirementService')

const roots: string[] = []
afterEach(() => { spawned.length = 0; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'mousse-readonly-git-')); roots.push(root); mkdirSync(join(root, 'r'))
  const cwd = join(root, 'r'); lifecycleGit(cwd, ['init', '-q']); writeFileSync(join(cwd, 'a.txt'), 'a')
  return cwd
}

describe('read-only Git for background checks', () => {
  it('asks Git not to take optional locks, so a commit from another terminal is never refused by a background status', () => {
    const cwd = repo()
    expect(readOnlyGit(cwd, ['status', '--porcelain', '--untracked-files=all'])).toBe('?? a.txt')
    const status = spawned.find((entry) => entry.args.includes('status'))
    expect(status?.env?.GIT_OPTIONAL_LOCKS).toBe('0')
    expect(status?.env?.PATH ?? status?.env?.Path).toBeDefined() // the rest of the environment is kept
  })

  it('returns a non-zero exit instead of throwing, and readOnlyGit throws with Git\'s message', () => {
    const cwd = repo()
    expect(runReadOnlyGit(cwd, ['rev-parse', '--verify', '--quiet', 'refs/heads/absent']).status).toBe(1)
    expect(() => readOnlyGit(cwd, ['rev-parse', '--verify', 'refs/heads/absent'])).toThrow(/fatal|Needed a single revision/i)
  })
})
