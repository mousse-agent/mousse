/**
 * `withGitCancellation`: the Git commands a piece of work runs end with its signal (a stopped turn's checkpoint), and
 * the run of each ends only once Git and what it started have exited, so the repository's lease is let go after them.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitWorkCancelled, runGitProcess, withGitCancellation } from '../src/mms/git/runGitProcess'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-git-cancel-')); dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'README'), 'x'); git('add', '.'); git('commit', '-qm', 'init')
  return dir
}

/** A Git command that runs for 30 seconds through a program Git starts (an alias), as a stuck command would. */
const SLOW = ['-c', 'alias.slow=!sleep 30', 'slow']

describe('withGitCancellation', () => {
  it('starts no Git once the work was stopped', async () => {
    const cwd = repo()
    const controller = new AbortController(); controller.abort()
    const ran = await withGitCancellation(controller.signal, async () => {
      expect(gitWorkCancelled()).toBe(true)
      return await runGitProcess(['rev-parse', 'HEAD'], { cwd, env: process.env })
    })
    expect(ran.error?.code).toBe('ABORT_ERR')
    expect(ran.status).toBeNull()
    // Outside the work nothing is cancelled.
    expect(gitWorkCancelled()).toBe(false)
    expect((await runGitProcess(['rev-parse', 'HEAD'], { cwd, env: process.env })).status).toBe(0)
  })

  it('stops a running command and what it started, and ends its run only once they exited', async () => {
    const cwd = repo()
    const index = join(cwd, 'private-index')
    const controller = new AbortController()
    const begun = Date.now()
    const running = withGitCancellation(controller.signal, () => runGitProcess(SLOW, { cwd, env: { ...process.env, GIT_INDEX_FILE: index } }))
    await new Promise((resolve) => setTimeout(resolve, 500))
    // As a command writing that private index would have left it when stopped.
    writeFileSync(`${index}.lock`, '')
    controller.abort()
    const ran = await running
    expect(ran.error?.code).toBe('ABORT_ERR')
    expect(Date.now() - begun).toBeLessThan(15_000)
    expect(existsSync(`${index}.lock`)).toBe(false)
  }, 30_000)

  it('lets a command that writes a ref finish', async () => {
    const cwd = repo()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
    const controller = new AbortController()
    const running = withGitCancellation(controller.signal, () => runGitProcess(['update-ref', 'refs/mousse/test/kept', head], { cwd, env: process.env }))
    controller.abort()
    const ran = await running
    expect(ran.error).toBeUndefined()
    expect(ran.status).toBe(0)
    expect(execFileSync('git', ['rev-parse', 'refs/mousse/test/kept'], { cwd, encoding: 'utf8' }).trim()).toBe(head)
  })
})
