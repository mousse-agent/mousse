import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitService } from '../src/mms/git/GitService'
import { userAction } from '../src/mms/git/gitPolicy'

/**
 * The check before a switch or a pull in a repository of 20,000 files, each with an ignored log beside it. The listings
 * it reads (the changed paths, the ignored files on disk) print several MiB, well past the 1 MiB an ordinary Git
 * command may, so a check that kept the ordinary limit would fail every switch and pull here.
 */

const FILES = 20_000
const USER = userAction('button', 'Test action')
const path = (index: number) => `packages/module-${String(index % 200).padStart(3, '0')}/src/components/file-${String(index).padStart(5, '0')}.ts`
const log = (index: number) => path(index).replace(/\.ts$/, '.build-output.log')
const TRAP = log(0)
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).trim()
const gitIn = (cwd: string, input: string, ...args: string[]): string => execFileSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim()

let root: string
let cwd: string
/** A commit on `parent` whose every file holds `text`, written through a private index; the folder is not touched. */
function everyFile(parent: string, text: string, message: string): string {
  const blob = gitIn(cwd, text, 'hash-object', '-w', '--stdin')
  const index = join(root, `index-${message.replace(/\W/g, '-')}`)
  const env = { ...process.env, GIT_INDEX_FILE: index }
  execFileSync('git', ['read-tree', parent], { cwd, env })
  execFileSync('git', ['update-index', '--index-info'], { cwd, env, input: Array.from({ length: FILES }, (_, i) => `100644 ${blob}\t${path(i)}`).join('\n') + '\n' })
  const tree = execFileSync('git', ['write-tree'], { cwd, env, encoding: 'utf8' }).trim()
  return gitIn(cwd, message, 'commit-tree', tree, '-p', parent)
}
const timed = async <T>(work: () => Promise<T>): Promise<{ result: T; ms: number }> => {
  const start = performance.now()
  const result = await work()
  return { result, ms: Math.round(performance.now() - start) }
}
const refusal = (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected a refusal') }, (error: unknown) => error as Error & { code?: string })

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mousse-many-files-way-'))
  cwd = join(root, 'repo'); mkdirSync(cwd)
  git(cwd, 'init', '-q', '-b', 'main')
  git(cwd, 'config', 'user.name', 'Fixture'); git(cwd, 'config', 'user.email', 'fixture@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false'); git(cwd, 'config', 'core.hooksPath', join(root, 'no-hooks'))
  writeFileSync(join(cwd, '.gitignore'), '*.log\n'); git(cwd, 'add', '.gitignore'); git(cwd, 'commit', '-qm', 'ignore logs')
  const main = everyFile(git(cwd, 'rev-parse', 'HEAD'), 'export const version = 1\n', 'many files')
  git(cwd, 'update-ref', 'refs/heads/main', main); git(cwd, 'reset', '-q', '--hard', 'main')
  git(cwd, 'branch', 'feature', everyFile(main, 'export const version = 2\n', 'every file changed'))
  // `trap` also tracks one of the logs, which is ignored here.
  const trapBlob = gitIn(cwd, 'tracked log\n', 'hash-object', '-w', '--stdin')
  const index = join(root, 'index-trap'), env = { ...process.env, GIT_INDEX_FILE: index }
  execFileSync('git', ['read-tree', main], { cwd, env })
  execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${trapBlob},${TRAP}`], { cwd, env })
  const trapTree = execFileSync('git', ['write-tree'], { cwd, env, encoding: 'utf8' }).trim()
  git(cwd, 'branch', 'trap', gitIn(cwd, 'track a log', 'commit-tree', trapTree, '-p', main))
  for (let i = 0; i < FILES; i++) writeFileSync(join(cwd, log(i)), `local log ${i}\n`)
  const origin = join(root, 'origin.git')
  git(root, 'init', '--bare', '-q', origin)
  git(cwd, 'remote', 'add', 'origin', origin); git(cwd, 'push', '-q', '-u', 'origin', 'main')
}, 120_000)
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('switch and pull in a repository with many files', () => {
  it('the listings the check reads are larger than an ordinary Git command may print', () => {
    expect(Buffer.byteLength(git(cwd, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'))).toBeGreaterThan(1024 * 1024)
    expect(Buffer.byteLength(git(cwd, 'diff-tree', '-r', '-z', 'main', 'feature'))).toBeGreaterThan(1024 * 1024)
  })

  it('switches back and forth', async () => {
    const service = new GitService()
    const there = await timed(() => service.checkout(cwd, USER, 'feature'))
    expect(there.result).toEqual({})
    expect(readFileSync(join(cwd, path(12_345)), 'utf8')).toBe('export const version = 2\n')
    const back = await timed(() => service.checkout(cwd, USER, 'main'))
    expect(back.result).toEqual({})
    expect(readFileSync(join(cwd, log(12_345)), 'utf8')).toBe('local log 12345\n')
    console.info(`switch with ${FILES} files: ${there.ms} ms there, ${back.ms} ms back`)
    expect(Math.max(there.ms, back.ms)).toBeLessThan(30_000)
  }, 120_000)

  it('refuses a switch over the ignored log, naming it', async () => {
    const { result: error, ms } = await timed(() => refusal(new GitService().checkout(cwd, USER, 'trap')))
    expect(error.message).toBe(`Switching to trap would overwrite an ignored file: ${TRAP}. Move it aside, then try again. Nothing was changed.`)
    expect([git(cwd, 'branch', '--show-current'), readFileSync(join(cwd, TRAP), 'utf8')]).toEqual(['main', 'local log 0\n'])
    console.info(`refused switch with ${FILES} files: ${ms} ms`)
    expect(ms).toBeLessThan(30_000)
  }, 120_000)

  it('refuses a pull over the ignored log, then fast-forwards and rebases', async () => {
    const service = new GitService()
    git(cwd, 'push', '-q', '-f', 'origin', 'trap:main')
    const refused = await timed(() => refusal(service.pull(cwd, USER)))
    expect(refused.result.message).toBe(`Pulling origin/main would overwrite an ignored file: ${TRAP}. Move it aside, then try again. Nothing was changed.`)
    expect(readFileSync(join(cwd, TRAP), 'utf8')).toBe('local log 0\n')

    git(cwd, 'push', '-q', '-f', 'origin', 'feature:main')
    const forward = await timed(() => service.pull(cwd, USER))
    expect(forward.result).toEqual({ result: 'fast-forwarded' })
    expect(readFileSync(join(cwd, path(0)), 'utf8')).toBe('export const version = 2\n')

    git(cwd, 'push', '-q', 'origin', `${everyFile(git(cwd, 'rev-parse', 'feature'), 'export const version = 3\n', 'every file changed again')}:refs/heads/main`)
    writeFileSync(join(cwd, 'local.txt'), 'local\n'); git(cwd, 'add', 'local.txt'); git(cwd, 'commit', '-qm', 'local')
    const rebased = await timed(() => service.pull(cwd, USER, { strategy: 'rebase' }))
    expect(rebased.result).toEqual({ result: 'rebased' })
    expect([readFileSync(join(cwd, path(FILES - 1)), 'utf8'), readFileSync(join(cwd, 'local.txt'), 'utf8'), readFileSync(join(cwd, log(FILES - 1)), 'utf8')])
      .toEqual(['export const version = 3\n', 'local\n', `local log ${FILES - 1}\n`])
    console.info(`pull with ${FILES} files: refused in ${refused.ms} ms, fast-forward ${forward.ms} ms, rebase ${rebased.ms} ms`)
    expect(Math.max(refused.ms, forward.ms, rebased.ms)).toBeLessThan(30_000)
  }, 180_000)
})
