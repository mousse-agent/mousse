import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runGit, type GitLine } from '../src/mms/git/gitProcess'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-gitproc-')); roots.push(dir)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  return dir
}

/** Runs a node script as a Git alias, so it is a real child of the git process that Git itself started through a shell. */
function aliasArgs(dir: string, script: string): string[] {
  const file = join(dir, 'script.cjs')
  writeFileSync(file, script)
  return ['-c', `alias.fake=!node "${file.replace(/\\/g, '/')}"`, 'fake']
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}
const waitDead = async (pid: number, ms = 5_000): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !alive(pid)
}

/** A script that starts a grandchild, records both pids and then hangs. */
const hangingTree = (pidFile: string) => `
const { spawn } = require('node:child_process')
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + ',' + child.pid)
console.error('started')
setInterval(() => {}, 1000)
`
const pids = (file: string) => readFileSync(file, 'utf8').split(',').map(Number)
const until = async (ready: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms
  while (!ready()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('runGit', () => {
  it('streams the lines of both streams as they arrive and keeps the whole output', async () => {
    const dir = folder()
    const lines: GitLine[] = []
    const run = await runGit(dir, aliasArgs(dir, `
      process.stdout.write('out one\\nout two\\n')
      process.stderr.write('progress 10%\\rprogress 50%\\rprogress 100%\\n')
      process.stdout.write('no newline at the end')
    `), { onLine: (line) => lines.push(line) })
    expect(run.ok).toBe(true)
    expect(lines.filter((line) => line.text.startsWith('out'))).toEqual([{ text: 'out one', transient: false }, { text: 'out two', transient: false }])
    expect(lines.filter((line) => line.text.startsWith('progress'))).toEqual([
      { text: 'progress 10%', transient: true },
      { text: 'progress 50%', transient: true },
      { text: 'progress 100%', transient: false }
    ])
    expect(lines.at(-1)).toEqual({ text: 'no newline at the end', transient: false })
    expect(run.output).toContain('out one\nout two\nno newline at the end')
    expect(run.output).toContain('progress 100%')
  })

  it('delivers a line while the process is still running', async () => {
    const dir = folder()
    const seen: string[] = []
    const sentinel = join(dir, 'go')
    const done = runGit(dir, aliasArgs(dir, `
      console.log('first line')
      const t = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(sentinel)})) { clearInterval(t); console.log('last line') } }, 25)
    `), { onLine: (line) => seen.push(line.text) })
    await until(() => seen.includes('first line'))
    expect(seen).toEqual(['first line'])
    writeFileSync(sentinel, '')
    const run = await done
    expect(seen).toEqual(['first line', 'last line'])
    expect(run.ok).toBe(true)
  }, 30_000)

  it('reports a failing exit without output as a failure', async () => {
    const dir = folder()
    const run = await runGit(dir, aliasArgs(dir, 'process.exit(3)'))
    expect(run).toMatchObject({ ok: false, code: 3, stalled: false, cancelled: false, exited: true })
  })

  it('keeps only the end of a very long output, and splits a line that never ends', async () => {
    const dir = folder()
    const lines: GitLine[] = []
    const run = await runGit(dir, aliasArgs(dir, `
      const chunk = 'x'.repeat(1024 * 1024)
      for (let i = 0; i < 3; i++) process.stderr.write(chunk)
      process.stderr.write('\\nthe verdict\\n')
    `), { onLine: (line) => lines.push(line) })
    expect(run.output.length).toBeLessThan(1024 * 1024 + 100)
    expect(run.output.trimEnd().endsWith('the verdict')).toBe(true)
    expect(Math.max(...lines.map((line) => line.text.length))).toBeLessThanOrEqual(4096)
  }, 30_000)

  it('does not start a process whose signal is already aborted', async () => {
    const dir = folder()
    const marker = join(dir, 'ran')
    const run = await runGit(dir, aliasArgs(dir, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`), { signal: AbortSignal.abort() })
    expect(run).toMatchObject({ ok: false, cancelled: true })
    expect(existsSync(marker)).toBe(false)
  })

  it('stops a silent process and everything it started, and says it went silent', async () => {
    const dir = folder()
    const pidFile = join(dir, 'pids')
    const run = await runGit(dir, aliasArgs(dir, hangingTree(pidFile)), { silenceMs: 1_500 })
    expect(run).toMatchObject({ ok: false, stalled: true, cancelled: false })
    const [parent, child] = pids(pidFile)
    expect(await waitDead(parent)).toBe(true)
    expect(await waitDead(child)).toBe(true)
  }, 30_000)

  it('cancels on abort: the whole process tree ends before the result settles', async () => {
    const dir = folder()
    const pidFile = join(dir, 'pids')
    const controller = new AbortController()
    const lines: string[] = []
    const result = runGit(dir, aliasArgs(dir, hangingTree(pidFile)), { signal: controller.signal, onLine: (line) => lines.push(line.text) })
    await until(() => lines.includes('started'))
    const [parent, child] = pids(pidFile)
    expect(alive(parent) && alive(child)).toBe(true)
    const startedAt = Date.now()
    controller.abort()
    const run = await result
    expect(run).toMatchObject({ ok: false, cancelled: true, stalled: false, exited: true })
    expect(Date.now() - startedAt).toBeLessThan(8_000)
    expect(await waitDead(parent)).toBe(true)
    expect(await waitDead(child)).toBe(true)
  }, 30_000)

  it('cancels a hook run by git commit and leaves no index lock', async () => {
    const dir = folder()
    execFileSync('git', ['config', 'user.email', 'a@example.invalid'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'A'], { cwd: dir })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
    const hooks = join(dir, '.hooks'); mkdirSync(hooks)
    const pidFile = join(dir, 'hook-pids')
    writeFileSync(join(hooks, 'pre-commit.cjs'), hangingTree(pidFile))
    writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\nexec node "${join(hooks, 'pre-commit.cjs').replace(/\\/g, '/')}"\n`, { mode: 0o755 })
    execFileSync('git', ['config', 'core.hooksPath', hooks], { cwd: dir })
    writeFileSync(join(dir, 'a.txt'), 'a\n'); execFileSync('git', ['add', 'a.txt'], { cwd: dir })

    const controller = new AbortController()
    const lines: string[] = []
    const result = runGit(dir, ['commit', '-m', 'never'], { signal: controller.signal, onLine: (line) => lines.push(line.text) })
    await until(() => lines.includes('started'))
    controller.abort()
    expect(await result).toMatchObject({ cancelled: true, exited: true })
    const [parent, child] = pids(pidFile)
    expect(await waitDead(parent)).toBe(true)
    expect(await waitDead(child)).toBe(true)
    expect(existsSync(join(dir, '.git', 'index.lock'))).toBe(false)
    expect(execFileSync('git', ['status', '--porcelain', '-uno'], { cwd: dir, encoding: 'utf8' })).toBe('A  a.txt\n')
    expect(() => execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dir, stdio: 'ignore' })).toThrow()
  }, 30_000)
})
