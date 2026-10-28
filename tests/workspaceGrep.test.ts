import type { spawn as nodeSpawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { grepWorkspace, type GrepWorkspaceOptions } from '../src/mms/files/WorkspaceGrep'
import { buildWorkspaceIndex, type GitRoute, type WorkspaceIndexSnapshot } from '../src/mms/files/WorkspaceIndex'
import {
  WorkspaceIndexRegistry,
  setWorkspaceIndexRegistryForTests
} from '../src/mms/files/WorkspaceIndexRegistry'
import { dispatchMethod, type HandlerContext } from '../src/mms/protocol/handlers'
import type { FileGrepResponse } from '../src/shared/types'

const roots: string[] = []
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function tempDir(prefix = 'mousse-grep-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function put(root: string, files: Record<string, string | Buffer>): void {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
}

function repo(): string {
  const cwd = tempDir('mousse-grep-repo-')
  git(cwd, 'init', '-b', 'main')
  git(cwd, 'config', 'user.name', 'Grep fixture')
  git(cwd, 'config', 'user.email', 'grep-fixture@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false')
  git(cwd, 'config', 'core.hooksPath', join(cwd, '.no-hooks'))
  return cwd
}

const notARepo = async (): Promise<GitRoute> => ({ ok: false, reason: 'not-a-repo' })
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
const paths = (response: FileGrepResponse): string[] => response.matches.map((match) => match.path).sort()

let registry: WorkspaceIndexRegistry

beforeEach(() => {
  registry = new WorkspaceIndexRegistry({
    build: (root, options) => buildWorkspaceIndex(root, { ...options, detectGit: notARepo })
  })
})

afterEach(() => {
  registry.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function search(root: string, query: string, options: GrepWorkspaceOptions = {}): Promise<FileGrepResponse> {
  return grepWorkspace(root, query, { ...options, deps: { registry, ...options.deps } })
}

/** The same files for both routes: a Git repository and a plain folder. */
const ROUTES: Array<[string, (files: Record<string, string | Buffer>) => string]> = [
  ['git route', (files) => { const root = repo(); put(root, files); return root }],
  ['scan route', (files) => { const root = tempDir(); put(root, files); return root }]
]

describe.each(ROUTES)('grepWorkspace: %s', (name, makeRoot) => {
  const source = name === 'git route' ? 'git' : 'walk'

  it('finds fixed-string matches with line, column and source', async () => {
    const root = makeRoot({ 'src/a.ts': 'const one = 1\nconst needle = 2\n', 'b.txt': 'nothing\n' })
    const response = await search(root, 'needle')
    expect(response.source).toBe(source)
    expect(response.root).toBe(root)
    expect(response.matches).toEqual([
      { path: 'src/a.ts', line: 2, column: 7, matchLength: 6, text: 'const needle = 2', snippetStart: 0 }
    ])
    expect(response.filesWithMatches).toBe(1)
    expect(response.truncated).toBe(false)
    expect(response.timedOut).toBe(false)
    expect(response.indexing).toBe(false)
  })

  it('uses smart case when caseSensitive is omitted', async () => {
    const root = makeRoot({ 'a.txt': 'Foo\nfoo\n' })
    expect((await search(root, 'foo')).matches.map((match) => match.line)).toEqual([1, 2])
    expect((await search(root, 'Foo')).matches.map((match) => match.line)).toEqual([1])
    expect((await search(root, 'foo', { caseSensitive: true })).matches.map((match) => match.line)).toEqual([2])
    expect((await search(root, 'Foo', { caseSensitive: false })).matches.map((match) => match.line)).toEqual([1, 2])
  })

  it('matches whole words only on request', async () => {
    const root = makeRoot({ 'a.txt': 'foobar foo\nfoobar\nfoo_bar\n' })
    expect((await search(root, 'foo')).matches).toHaveLength(3)
    const whole = await search(root, 'foo', { wholeWord: true })
    expect(whole.matches.map((match) => [match.line, match.column])).toEqual([[1, 8]])
  })

  it('skips binary files', async () => {
    const root = makeRoot({ 'bin.dat': Buffer.concat([Buffer.from('a'), Buffer.from([0]), Buffer.from(' needle')]), 'ok.txt': 'needle\n' })
    expect(paths(await search(root, 'needle'))).toEqual(['ok.txt'])
  })

  it('returns paths with spaces, parentheses and # verbatim', async () => {
    const root = makeRoot({ 'my dir/a b#(1).txt': 'needle\n' })
    expect(paths(await search(root, 'needle'))).toEqual(['my dir/a b#(1).txt'])
  })

  it('searches a query that starts with a dash literally', async () => {
    const root = makeRoot({ 'a.txt': 'run -rf now\n', 'b.txt': 'run now\n' })
    const response = await search(root, '-rf')
    expect(paths(response)).toEqual(['a.txt'])
    expect(response.matches[0].column).toBe(5)
    const option = await search(root, '--no-index')
    expect(option.matches).toEqual([])
  })

  it('reports UTF-16 columns after accented letters and emoji', async () => {
    const line = 'é😀 ünï needle here'
    const root = makeRoot({ 'a.txt': `${line}\n` })
    const response = await search(root, 'needle')
    expect(response.matches).toHaveLength(1)
    expect(response.matches[0].column).toBe(line.indexOf('needle') + 1)
    expect(response.matches[0].matchLength).toBe(6)
  })

  it('cuts a long line to a snippet that still locates the match', async () => {
    const line = `${'a'.repeat(600)}needle${'b'.repeat(394)}`
    expect(line).toHaveLength(1000)
    const root = makeRoot({ 'long.txt': `${line}\n` })
    const [match] = (await search(root, 'needle')).matches
    expect(match.column).toBe(601)
    expect(match.snippetStart).toBeGreaterThan(0)
    expect(match.text.length).toBeLessThanOrEqual(400)
    const from = match.column - 1 - match.snippetStart
    expect(match.text.slice(from, from + (match.matchLength ?? 0))).toBe('needle')
  })

  it('caps matches per file and in total and says so', async () => {
    const root = makeRoot({
      'many.txt': Array.from({ length: 10 }, (_, i) => `needle ${i}`).join('\n'),
      'b.txt': 'needle\n',
      'c.txt': 'needle\n'
    })
    const perFile = await search(root, 'needle', { perFileLimit: 3 })
    expect(perFile.matches.filter((match) => match.path === 'many.txt')).toHaveLength(3)
    expect(perFile.truncated).toBe(true)

    const total = await search(root, 'needle', { limit: 2 })
    expect(total.matches).toHaveLength(2)
    expect(total.truncated).toBe(true)

    const exact = await search(makeRoot({ 'a.txt': 'needle\n', 'b.txt': 'needle\n' }), 'needle', { limit: 2 })
    expect(exact.matches).toHaveLength(2)
    expect(exact.truncated).toBe(false)
  })

  it('never reports a match for an empty query or one with a line break', async () => {
    const root = makeRoot({ 'a.txt': 'one\ntwo\n' })
    expect((await search(root, '')).matches).toEqual([])
    expect((await search(root, 'one\ntwo')).matches).toEqual([])
    expect((await search(root, 'one\0')).matches).toEqual([])
  })

  it('skips a matching line longer than maxRecordBytes and counts it', async () => {
    const root = makeRoot({ 'min.js': `${'a'.repeat(300)}needle${'b'.repeat(300)}\n`, 'ok.js': 'needle\n' })
    const response = await search(root, 'needle', { maxRecordBytes: 200 })
    expect(paths(response)).toEqual(['ok.js'])
    expect(response.skippedLongLines).toBe(1)
  })

  it('handles CRLF line endings', async () => {
    const root = makeRoot({ 'a.txt': 'first\r\nneedle here\r\n' })
    const [match] = (await search(root, 'needle')).matches
    expect(match).toMatchObject({ line: 2, column: 1, text: 'needle here' })
  })
})

describe('grepWorkspace: git route', () => {
  it('honours .gitignore and still searches untracked files', async () => {
    const root = repo()
    put(root, { '.gitignore': '*.log\nbuild/\n', 'tracked.txt': 'needle\n', 'ignored.log': 'needle\n', 'build/out.txt': 'needle\n' })
    git(root, 'add', 'tracked.txt', '.gitignore')
    put(root, { 'untracked.txt': 'needle\n' })
    expect(paths(await search(root, 'needle'))).toEqual(['tracked.txt', 'untracked.txt'])
  })

  it('drops a tracked file under a skipped directory name', async () => {
    const root = repo()
    put(root, { 'dist/x.js': 'needle\n', 'src/x.js': 'needle\n' })
    git(root, 'add', '-A')
    expect(paths(await search(root, 'needle'))).toEqual(['src/x.js'])
  })

  it('discards a 5 MB single-line file without returning it', async () => {
    const root = repo()
    put(root, { 'big.min.js': `${'a'.repeat(5 * 1024 * 1024)}needle\n`, 'ok.js': 'needle\n' })
    const response = await search(root, 'needle', { timeoutMs: 10_000 })
    expect(paths(response)).toEqual(['ok.js'])
    expect(response.skippedLongLines).toBe(1)
  })

  it('supports regular expressions and reports no match length for them', async () => {
    const root = repo()
    put(root, { 'a.txt': 'color colour\nnothing\n' })
    const response = await search(root, 'colou?r', { regex: true })
    expect(response.regexError).toBeUndefined()
    expect(response.matches).toHaveLength(1)
    expect(response.matches[0]).toMatchObject({ line: 1, column: 1, matchLength: null })
  })

  it('searches an invalid pattern literally and reports why', async () => {
    const root = repo()
    put(root, { 'a.txt': 'call a(b now\nnothing\n' })
    const response = await search(root, 'a(b', { regex: true })
    expect(response.regexError).toMatch(/\(/)
    expect(response.matches).toHaveLength(1)
    expect(response.matches[0]).toMatchObject({ line: 1, column: 6, matchLength: 3 })
  })

  it('resolves quickly on a few thousand files and never reports neither result nor timeout', async () => {
    const root = repo()
    put(root, Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`d${i % 20}/f${i}.txt`, `line needle ${i}\n`])))
    const started = Date.now()
    const response = await search(root, 'needle', { timeoutMs: 100, limit: 2000 })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(response.timedOut || response.matches.length === 2000).toBe(true)
  })

  it('reports why a repository was searched by scan when git is unusable', async () => {
    const root = repo()
    put(root, { 'a.txt': 'needle\n' })
    const response = await search(root, 'needle', { deps: { detectGit: async () => ({ ok: false, reason: 'git-missing' }) } })
    expect(response.source).toBe('walk')
    expect(response.fallbackReason).toBe('git-missing')
    expect(paths(response)).toEqual(['a.txt'])
  })
})

interface FakeChild extends EventEmitter {
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  kill: () => boolean
}

const record = (path: string, line: number, column: number, text: string | Buffer): Buffer =>
  Buffer.concat([Buffer.from(`${path}\0${line}\0${column}\0`), Buffer.from(text), Buffer.from('\n')])

function fakeGit(script: (child: FakeChild) => void): { spawn: typeof nodeSpawn; calls: string[][]; children: FakeChild[] } {
  const calls: string[][] = []
  const children: FakeChild[] = []
  const spawn = ((_command: string, args: string[]) => {
    calls.push(args)
    const child = new EventEmitter() as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killed = false
    child.kill = () => {
      child.killed = true
      setImmediate(() => child.emit('close', null))
      return true
    }
    children.push(child)
    setImmediate(() => script(child))
    return child
  }) as unknown as typeof nodeSpawn
  return { spawn, calls, children }
}

const gitRoute = (version: [number, number] = [2, 55]) => async (): Promise<GitRoute> => ({ ok: true, version })

describe('grepWorkspace: git arguments and output handling', () => {
  it('passes the query only as the value of -e, before --', async () => {
    const root = tempDir()
    const fake = fakeGit((child) => { child.stdout.end(); child.emit('close', 1) })
    await search(root, '--no-index', { deps: { spawn: fake.spawn, detectGit: gitRoute() } })
    // The settings that keep the repository's programs from running (`repoPrograms`) come first.
    const args = fake.calls[0].slice(fake.calls[0].indexOf('grep'))
    expect(fake.calls[0].slice(0, fake.calls[0].indexOf('grep'))).toContain('core.fsmonitor=false')
    expect(args.slice(0, 2)).toEqual(['grep', '-I'])
    expect(args[args.indexOf('-e') + 1]).toBe('--no-index')
    expect(args.at(-1)).toBe('--')
    expect(args.indexOf('-e')).toBeLessThan(args.indexOf('--'))
    expect(args.filter((arg) => arg === '--no-index')).toHaveLength(1)
    expect(args).toContain('-F')
    expect(args).not.toContain('-E')
  })

  it('passes -m on git 2.38 and later, and caps per file itself on older git', async () => {
    const root = tempDir()
    const script = (child: FakeChild): void => {
      for (let i = 1; i <= 6; i += 1) child.stdout.write(record('a.txt', i, 1, 'needle'))
      child.stdout.end()
      child.emit('close', 0)
    }
    const modern = fakeGit(script)
    const modernResponse = await search(root, 'needle', { perFileLimit: 3, deps: { spawn: modern.spawn, detectGit: gitRoute([2, 38]) } })
    expect(modern.calls[0].slice(modern.calls[0].indexOf('-m'), modern.calls[0].indexOf('-m') + 2)).toEqual(['-m', '4'])
    expect(modernResponse.matches).toHaveLength(3)
    expect(modernResponse.truncated).toBe(true)

    const older = fakeGit(script)
    const olderResponse = await search(root, 'needle', { perFileLimit: 3, deps: { spawn: older.spawn, detectGit: gitRoute([2, 30]) } })
    expect(older.calls[0]).not.toContain('-m')
    expect(olderResponse.matches).toHaveLength(3)
    expect(olderResponse.truncated).toBe(true)
  })

  it('parses records split at arbitrary byte boundaries', async () => {
    const root = tempDir()
    // "é" is 2 bytes and the emoji 4, so "needle" starts at byte column 8 and UTF-16 column 5.
    const bytes = Buffer.concat([record('é dir/a.txt', 3, 8, 'é😀 needle\r'), record('b.txt', 1, 1, 'needle')])
    const fake = fakeGit((child) => {
      for (const byte of bytes) child.stdout.write(Buffer.from([byte]))
      child.stdout.end()
      child.emit('close', 0)
    })
    const response = await search(root, 'needle', { deps: { spawn: fake.spawn, detectGit: gitRoute() } })
    expect(response.matches).toEqual([
      { path: 'é dir/a.txt', line: 3, column: 5, matchLength: 6, text: 'é😀 needle', snippetStart: 0 },
      { path: 'b.txt', line: 1, column: 1, matchLength: 6, text: 'needle', snippetStart: 0 }
    ])
  })

  it('never returns a path outside the root or under a skipped directory', async () => {
    const root = tempDir()
    const fake = fakeGit((child) => {
      for (const path of ['../escape.txt', 'a/../../escape.txt', '/etc/passwd', 'C:\\Windows\\win.ini', 'C:win.ini', '\\\\server\\share\\x', 'node_modules/pkg/i.js', 'dist/x.js', 'src/ok.ts']) {
        child.stdout.write(record(path, 1, 1, 'needle'))
      }
      child.stdout.end()
      child.emit('close', 0)
    })
    const response = await search(root, 'needle', { deps: { spawn: fake.spawn, detectGit: gitRoute() } })
    expect(paths(response)).toEqual(['src/ok.ts'])
  })

  it('stops the child when the limit is passed and when the budget ends', async () => {
    const root = tempDir()
    const limited = fakeGit((child) => {
      for (let i = 1; i <= 5; i += 1) child.stdout.write(record(`f${i}.txt`, 1, 1, 'needle'))
    })
    const limitedResponse = await search(root, 'needle', { limit: 2, deps: { spawn: limited.spawn, detectGit: gitRoute() } })
    expect(limitedResponse.matches).toHaveLength(2)
    expect(limitedResponse.truncated).toBe(true)
    expect(limited.children[0].killed).toBe(true)

    const hung = fakeGit((child) => { child.stdout.write(record('a.txt', 1, 1, 'needle')) })
    const started = Date.now()
    const hungResponse = await search(root, 'needle', { timeoutMs: 100, deps: { spawn: hung.spawn, detectGit: gitRoute() } })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(hungResponse.timedOut).toBe(true)
    expect(hungResponse.matches).toHaveLength(1)
    expect(hung.children[0].killed).toBe(true)
  })

  it('kills the child and rejects when the search is cancelled', async () => {
    const root = tempDir()
    const hung = fakeGit(() => undefined)
    const controller = new AbortController()
    const running = search(root, 'needle', { signal: controller.signal, timeoutMs: 10_000, deps: { spawn: hung.spawn, detectGit: gitRoute() } })
    await sleep(20)
    controller.abort()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(hung.children[0].killed).toBe(true)

    await expect(search(root, 'needle', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('surfaces a git failure that is not a bad pattern', async () => {
    const root = tempDir()
    const failing = fakeGit((child) => { child.stderr.write('fatal: something broke\n'); child.stdout.end(); child.emit('close', 128) })
    await expect(search(root, 'needle', { deps: { spawn: failing.spawn, detectGit: gitRoute() } })).rejects.toThrow('something broke')
  })
})

describe('grepWorkspace: scan route', () => {
  it('answers a regular expression literally and never builds a RegExp from the query', async () => {
    const root = tempDir()
    put(root, { 'a.txt': `${'a'.repeat(5000)}b\nliteral (a+)+$ here\n` })
    const started = Date.now()
    const evil = await search(root, '(a+)+$', { regex: true })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(evil.regexError).toBe('Regular expressions need a Git repository')
    expect(evil.matches).toHaveLength(1)
    expect(evil.matches[0]).toMatchObject({ line: 2, column: 9, matchLength: 6 })
    expect(evil.timedOut).toBe(false)

    const plain = await search(root, 'literal')
    expect(plain.regexError).toBeUndefined()
  })

  it('skips files over 1 MB', async () => {
    const root = tempDir()
    put(root, { 'big.txt': `${'a'.repeat(1024 * 1024 + 10)}needle\n`, 'ok.txt': 'needle\n' })
    expect(paths(await search(root, 'needle'))).toEqual(['ok.txt'])
  })

  it('does not search ignored-by-skip directories or follow links out of the root', async () => {
    const outside = tempDir('mousse-grep-outside-')
    put(outside, { 'secret.txt': 'needle\n' })
    const root = tempDir()
    put(root, { 'node_modules/p/i.js': 'needle\n', 'ok.txt': 'needle\n' })
    symlinkSync(outside, join(root, 'linkdir'), 'junction')
    expect(paths(await search(root, 'needle'))).toEqual(['ok.txt'])
  })

  it('checks the physical location again before reading an indexed path', async () => {
    const outside = tempDir('mousse-grep-outside-')
    put(outside, { 'secret.txt': 'needle\n' })
    const root = tempDir()
    put(root, { 'ok.txt': 'needle\n' })
    symlinkSync(outside, join(root, 'linkdir'), 'junction')
    const read: string[] = []
    const snapshot = {
      root, source: 'walk', files: ['linkdir/secret.txt', 'ok.txt'], folders: [], lowerFiles: [], lowerFolders: [],
      builtAt: Date.now(), truncated: false, complete: true
    } as WorkspaceIndexSnapshot
    const response = await search(root, 'needle', {
      deps: {
        registry: { getComplete: async () => ({ snapshot, indexing: false }) },
        readCapped: async (absolute) => { read.push(absolute); return Buffer.from('needle\n') }
      }
    })
    expect(paths(response)).toEqual(['ok.txt'])
    expect(read).toEqual([join(root, 'ok.txt')])
  })

  it('does not read a path that escapes the root even when the index lists it', async () => {
    const root = tempDir()
    const read: string[] = []
    const snapshot = {
      root, source: 'walk', files: ['../escape.txt', 'a/../../escape.txt', '/etc/hosts'], folders: [], lowerFiles: [], lowerFolders: [],
      builtAt: Date.now(), truncated: false, complete: true
    } as WorkspaceIndexSnapshot
    const response = await search(root, 'needle', {
      deps: {
        registry: { getComplete: async () => ({ snapshot, indexing: false }) },
        readCapped: async (absolute) => { read.push(absolute); return Buffer.from('needle\n') }
      }
    })
    expect(response.matches).toEqual([])
    expect(read).toEqual([])
  })

  it('reports indexing and a timeout when waiting for the index uses the whole budget', async () => {
    const root = tempDir()
    const started = Date.now()
    const waiting = await search(root, 'needle', {
      timeoutMs: 100,
      deps: { registry: { getComplete: async (_root, { deadline }) => { await sleep(deadline - Date.now() + 5); return { snapshot: null, indexing: true } } } }
    })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(waiting).toMatchObject({ indexing: true, timedOut: true, matches: [] })

    const partial = { root, source: 'walk', files: ['a.txt'], folders: [], lowerFiles: [], lowerFolders: [], builtAt: 0, truncated: false, complete: false } as WorkspaceIndexSnapshot
    let reads = 0
    const late = await search(root, 'needle', {
      timeoutMs: 100,
      deps: {
        registry: { getComplete: async (_root, { deadline }) => { await sleep(deadline - Date.now() + 5); return { snapshot: partial, indexing: true } } },
        readCapped: async () => { reads += 1; return Buffer.from('needle\n') }
      }
    })
    expect(late).toMatchObject({ indexing: true, timedOut: true, matches: [] })
    expect(reads).toBe(0)
  })

  it('stops scanning at the deadline and returns what it found', async () => {
    const root = tempDir()
    const files = Array.from({ length: 40 }, (_, i) => `f${i}.txt`)
    const snapshot = { root, source: 'walk', files, folders: [], lowerFiles: [], lowerFolders: [], builtAt: Date.now(), truncated: false, complete: true } as WorkspaceIndexSnapshot
    put(root, Object.fromEntries(files.map((file) => [file, 'needle\n'])))
    const response = await search(root, 'needle', {
      timeoutMs: 100,
      deps: {
        registry: { getComplete: async () => ({ snapshot, indexing: false }) },
        readCapped: async () => { await sleep(30); return Buffer.from('needle\n') }
      }
    })
    expect(response.timedOut).toBe(true)
    expect(response.matches.length).toBeGreaterThan(0)
    expect(response.matches.length).toBeLessThan(40)
  })

  it('returns indexing first and finds the match once the delayed index has finished', async () => {
    const root = tempDir()
    put(root, { 'a.txt': 'needle\n' })
    registry.dispose()
    registry = new WorkspaceIndexRegistry({
      build: async (buildRoot, options) => { await sleep(300); return buildWorkspaceIndex(buildRoot, { ...options, detectGit: notARepo }) }
    })
    const first = await search(root, 'needle', { timeoutMs: 100 })
    expect(first.indexing).toBe(true)
    expect(first.matches).toEqual([])

    const second = await search(root, 'needle', { timeoutMs: 5_000 })
    expect(second.indexing).toBe(false)
    expect(paths(second)).toEqual(['a.txt'])
  })

  it('rejects when cancelled while waiting for the index', async () => {
    const root = tempDir()
    const controller = new AbortController()
    const running = search(root, 'needle', {
      signal: controller.signal,
      timeoutMs: 10_000,
      deps: { detectGit: notARepo, registry: { getComplete: () => new Promise(() => undefined) } }
    })
    await sleep(10)
    controller.abort()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('flags a project larger than the index cap', async () => {
    const root = tempDir()
    put(root, { 'a.txt': 'needle\n', 'b.txt': 'needle\n', 'c.txt': 'needle\n' })
    registry.dispose()
    registry = new WorkspaceIndexRegistry({
      cap: 2,
      build: (buildRoot, options) => buildWorkspaceIndex(buildRoot, { ...options, detectGit: notARepo })
    })
    const response = await search(root, 'needle')
    expect(response.matches).toHaveLength(2)
    expect(response.truncated).toBe(true)
  })
})

describe('files.grep', () => {
  let installed: WorkspaceIndexRegistry

  beforeEach(() => {
    installed = new WorkspaceIndexRegistry()
    setWorkspaceIndexRegistryForTests(installed)
  })
  afterEach(() => {
    installed.dispose()
    setWorkspaceIndexRegistryForTests(null)
  })

  function context(projects: Record<string, string>): HandlerContext {
    return {
      mms: {
        projects: { getProject: (id: string) => (projects[id] ? { id, path: projects[id] } : undefined) },
        // No known threads: a named thread restores no worktree before the call checks its ids.
        threads: { getThread: () => undefined }
      },
      globalSequence: () => 0
    } as unknown as HandlerContext
  }

  it('returns matches for the project root', async () => {
    const root = repo()
    put(root, { 'src/a.ts': 'const needle = 1\n', 'b.ts': 'other\n' })
    const response = await dispatchMethod(context({ p1: root }), 'files.grep', { projectId: 'p1', query: 'needle' }) as FileGrepResponse
    expect(response.root).toBe(root)
    expect(response.source).toBe('git')
    expect(response.matches.map((match) => match.path)).toEqual(['src/a.ts'])
    expect(response.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('searches a plain folder through the shared index', async () => {
    const root = tempDir()
    put(root, { 'a.txt': 'needle\n' })
    const response = await dispatchMethod(context({ p1: root }), 'files.grep', { projectId: 'p1', query: 'needle', regex: true }) as FileGrepResponse
    expect(response.source).toBe('walk')
    expect(response.fallbackReason).toBe('not-a-repo')
    expect(response.regexError).toBe('Regular expressions need a Git repository')
    expect(paths(response)).toEqual(['a.txt'])
  })

  it('rejects an empty or over-long query, bad options and both ids together', async () => {
    const root = tempDir()
    const ctx = context({ p1: root })
    await expect(dispatchMethod(ctx, 'files.grep', { projectId: 'p1' })).rejects.toThrow(/non-empty/)
    await expect(dispatchMethod(ctx, 'files.grep', { projectId: 'p1', query: '' })).rejects.toThrow(/non-empty/)
    await expect(dispatchMethod(ctx, 'files.grep', { projectId: 'p1', query: 'x'.repeat(513) })).rejects.toThrow(/max length/)
    await expect(dispatchMethod(ctx, 'files.grep', { projectId: 'p1', query: 'x', limit: 2001 })).rejects.toThrow(/limit/)
    await expect(dispatchMethod(ctx, 'files.grep', { projectId: 'p1', query: 'x', timeoutMs: 99 })).rejects.toThrow(/timeoutMs/)
    await expect(dispatchMethod(ctx, 'files.grep', { projectId: 'p1', query: 'x', timeoutMs: 10_001 })).rejects.toThrow(/timeoutMs/)
    await expect(dispatchMethod(ctx, 'files.grep', { projectId: 'p1', query: 'x', regex: 'yes' })).rejects.toThrow(/regex/)
    await expect(dispatchMethod(ctx, 'files.grep', { projectId: 'p1', threadId: 't1', query: 'x' })).rejects.toThrow(/either threadId or projectId/)
    await expect(dispatchMethod(ctx, 'files.grep', { query: 'x' })).rejects.toThrow(/projectId or threadId/)
  })
})
