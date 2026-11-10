import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Counts the `hash-object` runs the status read makes, without changing what they do.
const hashRuns = vi.hoisted(() => ({ count: 0 }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFile = ((...args: Parameters<typeof actual.execFile>) => {
    const argv = args[1]
    if (Array.isArray(argv) && argv.includes('hash-object')) hashRuns.count += 1
    return (actual.execFile as (...values: unknown[]) => unknown)(...args)
  }) as typeof actual.execFile
  return { ...actual, execFile }
})

const { GitService } = await import('../src/mms/git/GitService')
const { clearVerifiedUnchanged, readWorkingTreeStatus } = await import('../src/mms/git/workingTreeStatus')

const roots: string[] = []
const OLD = new Date('2020-01-01')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** A repository with `count` committed files whose times were then moved, so only their content says they are unchanged. */
function touchedRepository(count: number, text = (index: number) => `line ${index}\n`): string {
  const cwd = mkdtempSync(join(tmpdir(), 'mousse-status-memory-'))
  roots.push(cwd)
  git(cwd, 'init', '-q', '-b', 'main')
  git(cwd, 'config', 'user.name', 'Status fixture')
  git(cwd, 'config', 'user.email', 'status@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false')
  // Git for Windows turns it on for the whole system; the files are committed exactly as written.
  git(cwd, 'config', 'core.autocrlf', 'false')
  for (let index = 0; index < count; index++) writeFileSync(join(cwd, `file-${index}.txt`), text(index))
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-qm', 'base')
  for (let index = 0; index < count; index++) utimesSync(join(cwd, `file-${index}.txt`), OLD, OLD)
  return cwd
}

beforeEach(() => {
  clearVerifiedUnchanged()
  hashRuns.count = 0
})

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('The status read remembers files it proved unchanged', () => {
  it('hashes a touched file once, then takes it as unchanged while its stat data stays the same', async () => {
    const cwd = touchedRepository(3)
    // Moving the times changed the files' change time just now; a minute later they are no longer racily clean.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 })
    expect(await readWorkingTreeStatus(cwd)).toEqual([])
    expect(hashRuns.count).toBe(1)
    expect(await readWorkingTreeStatus(cwd)).toEqual([])
    expect(hashRuns.count).toBe(1)
  })

  it('hashes again, and reports the change, once a remembered file is rewritten with the same size and old times', async () => {
    const cwd = touchedRepository(2)
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 })
    await readWorkingTreeStatus(cwd)
    // Same length, other content, and the old modification time put back: only the change time and the content differ.
    writeFileSync(join(cwd, 'file-0.txt'), 'line X\n')
    utimesSync(join(cwd, 'file-0.txt'), OLD, OLD)
    expect(await readWorkingTreeStatus(cwd)).toEqual([{ path: 'file-0.txt', index: '', workdir: 'M' }])
  })
})

describe('What the status read remembers ends when Git would convert content differently', () => {
  /** A file committed with CRLF line endings, its times moved, read once so it is remembered as unchanged. */
  async function rememberedCrlf(): Promise<string> {
    const cwd = touchedRepository(1, () => 'one\r\ntwo\r\n')
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 })
    expect(await readWorkingTreeStatus(cwd)).toEqual([])
    expect(await readWorkingTreeStatus(cwd)).toEqual([])
    expect(hashRuns.count).toBe(1)
    return cwd
  }

  /** The status read with nothing remembered, which a remembered read must agree with. */
  async function fresh(cwd: string) {
    clearVerifiedUnchanged()
    return readWorkingTreeStatus(cwd)
  }

  it('reads the file again when core.autocrlf changes', async () => {
    const cwd = await rememberedCrlf()
    git(cwd, 'config', 'core.autocrlf', 'true')
    const read = await readWorkingTreeStatus(cwd)
    expect(hashRuns.count).toBe(2)
    expect(read).toEqual([{ path: 'file-0.txt', index: '', workdir: 'M' }])
    expect(read).toEqual(await fresh(cwd))
  })

  it('reads the file again when a .gitattributes file appears or changes', async () => {
    const cwd = await rememberedCrlf()
    writeFileSync(join(cwd, '.gitattributes'), '*.md text\n')
    utimesSync(join(cwd, '.gitattributes'), OLD, OLD)
    await readWorkingTreeStatus(cwd)
    expect(hashRuns.count).toBe(2)
    // The same size and the old times, other content: the change time still tells.
    writeFileSync(join(cwd, '.gitattributes'), '*.txt text\n')
    utimesSync(join(cwd, '.gitattributes'), OLD, OLD)
    const read = await readWorkingTreeStatus(cwd)
    expect(hashRuns.count).toBe(3)
    expect(read.find((entry) => entry.path === 'file-0.txt')).toEqual({ path: 'file-0.txt', index: '', workdir: 'M' })
    expect(read).toEqual(await fresh(cwd))
  })

  it('reads the file again when a filter is set up', async () => {
    const cwd = await rememberedCrlf()
    git(cwd, 'config', 'filter.lower.clean', 'tr A-Z a-z')
    expect(await readWorkingTreeStatus(cwd)).toEqual(await fresh(cwd))
    expect(hashRuns.count).toBe(3)
  })
})

describe('Diff counts with many touched files', () => {
  it('count only the real edits, the same as Git does', async () => {
    const cwd = touchedRepository(80)
    writeFileSync(join(cwd, 'file-7.txt'), 'line 7\nmore\n')
    utimesSync(join(cwd, 'file-7.txt'), OLD, OLD)
    const service = new GitService()
    expect(await service.getDiffStats(cwd)).toEqual({ additions: 1, deletions: 0, filesChanged: 1 })
    const status = await service.getStatus(cwd)
    expect(status.changes).toEqual([expect.objectContaining({ path: 'file-7.txt', status: 'modified', staged: false })])
  })
})
