import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** The stdout a GitService read keeps, lowered so a small repository's listing passes it. */
const cap = vi.hoisted(() => ({ bytes: Infinity }))
vi.mock('../src/mms/git/gitProcess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/mms/git/gitProcess')>()
  return {
    ...actual,
    runGit: (cwd: string, args: readonly string[], options: import('../src/mms/git/gitProcess').GitRunOptions = {}) =>
      actual.runGit(cwd, args, options.stdoutBytes === undefined ? options : { ...options, stdoutBytes: Math.min(options.stdoutBytes, cap.bytes) })
  }
})

const { GitService } = await import('../src/mms/git/GitService')

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A repository with 200 branches: `for-each-ref` lists about 3 KB of names. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-read-limit-')); roots.push(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-q', '--allow-empty', '-m', 'base')
  const head = git('rev-parse', 'HEAD')
  execFileSync('git', ['update-ref', '--stdin'], { cwd: dir, input: Array.from({ length: 200 }, (_, index) => `create refs/heads/branch-${String(index).padStart(4, '0')} ${head}\n`).join('') })
  return dir
}

const read = (service: InstanceType<typeof GitService>, cwd: string, args: string[]) =>
  (service as unknown as { read(cwd: string, args: readonly string[]): Promise<string | null> }).read(cwd, args)

describe('a GitService read', () => {
  it('returns the whole answer when it fits, and fails rather than returning part of one past its limit', async () => {
    const cwd = repo()
    const service = new GitService()
    const args = ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']
    cap.bytes = 64 * 1024
    expect((await read(service, cwd, args))?.split('\n')).toHaveLength(201)
    cap.bytes = 1024
    expect(await read(service, cwd, args)).toBeNull()
  })
})
