import { describe, expect, it } from 'vitest'
import { fuzzyMatchPath, lowerPath, rankFuzzyPaths } from '../src/shared/fuzzyPath'
import { searchWorkspacePaths } from '../src/mms/files/WorkspaceSearch'
import type { WorkspaceIndexSnapshot } from '../src/mms/files/WorkspaceIndex'

function match(query: string, path: string) {
  return fuzzyMatchPath(lowerPath(query), lowerPath(path), path)
}

function candidates(paths: string[]) {
  return { paths, lower: paths.map(lowerPath) }
}

async function rank(query: string, paths: string[], limit = 10) {
  const { results } = await rankFuzzyPaths(query, candidates(paths), { limit })
  return results.map((result) => paths[result.index])
}

function snapshot(files: string[], folders: string[] = []): WorkspaceIndexSnapshot {
  return {
    root: process.platform === 'win32' ? 'C:\\repo' : '/repo',
    source: 'git',
    files,
    folders,
    lowerFiles: files.map(lowerPath),
    lowerFolders: folders.map(lowerPath),
    builtAt: 0,
    truncated: false,
    complete: true
  }
}

describe('fuzzyMatchPath', () => {
  it('returns null when the query is not a subsequence', () => {
    expect(match('xyz', 'src/main.ts')).toBeNull()
    expect(match('tsm', 'src/main.ts')).toBeNull()
  })

  it('matches case-insensitively', () => {
    expect(match('READ', 'docs/readme.md')).not.toBeNull()
    expect(match('read', 'docs/README.md')).not.toBeNull()
  })

  it('maps positions to the original string', () => {
    const path = 'src/components/ChatComposer.tsx'
    const result = match('chatcomp', path)!
    expect(result.positions.map((at) => path[at].toLowerCase()).join('')).toBe('chatcomp')
    expect(result.positions[0]).toBe(path.indexOf('ChatComposer'))
  })

  it('keeps positions aligned for characters that lowercase to two units', () => {
    const path = 'İstanbul/Plan.md'
    expect(lowerPath(path)).toHaveLength(path.length)
    const result = match('plan', path)!
    expect(result.positions[0]).toBe(path.indexOf('Plan'))
  })

  it('ranks a basename hit above a directory hit', async () => {
    expect(await rank('main', ['main/foo/util.ts', 'src/main.ts'])).toEqual(['src/main.ts', 'main/foo/util.ts'])
  })

  it('rewards segment starts', async () => {
    expect(await rank('fb', ['src/foobar.ts', 'src/foo-bar.ts'])).toEqual(['src/foo-bar.ts', 'src/foobar.ts'])
  })

  it('rewards camelCase boundaries over mid-word letters', () => {
    const boundary = match('cc', 'src/ChatComposer.tsx')!
    const middle = match('cc', 'src/accuracy.tsx')!
    expect(boundary.score).toBeGreaterThan(middle.score)
  })

  it('rewards consecutive runs', () => {
    const run = match('abc', 'x/abc.ts')!
    const scattered = match('abc', 'x/a-b-c.ts')!
    expect(run.score).toBeGreaterThan(scattered.score)
  })

  it('lets shorter paths win ties', async () => {
    expect(await rank('util', ['src/lib/deep/util.ts', 'src/util.ts'])).toEqual(['src/util.ts', 'src/lib/deep/util.ts'])
  })
})

describe('rankFuzzyPaths', () => {
  it('lists the shallowest paths first for an empty query', async () => {
    const paths = ['a/b/c.ts', 'README.md', 'a/b.ts', 'package.json']
    expect(await rank('', paths)).toEqual(['README.md', 'package.json', 'a/b.ts', 'a/b/c.ts'])
  })

  it('keeps only `limit` results', async () => {
    const paths = Array.from({ length: 500 }, (_, i) => `src/file${i}.ts`)
    expect(await rank('file', paths, 7)).toHaveLength(7)
  })

  it('awaits yield every yieldEvery candidates', async () => {
    const paths = Array.from({ length: 95 }, (_, i) => `f${i}.ts`)
    let yields = 0
    const { complete } = await rankFuzzyPaths('f', candidates(paths), { limit: 5, yieldEvery: 10, yield: async () => { yields += 1 } })
    expect(complete).toBe(true)
    expect(yields).toBe(9)
  })

  it('stops at a deadline in the past and returns what it has', async () => {
    const paths = Array.from({ length: 100 }, (_, i) => `f${i}.ts`)
    const result = await rankFuzzyPaths('f', candidates(paths), { limit: 50, yieldEvery: 10, deadline: Date.now() - 1 })
    expect(result.complete).toBe(false)
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.results.length).toBeLessThan(100)
  })

  it.skipIf(process.env.CI)('ranks 100k synthetic paths in under 200 ms (timing guard; the PR states the hand-run number)', async () => {
    const paths = Array.from({ length: 100_000 }, (_, i) => `packages/pkg${i % 400}/src/module${i % 97}/component${i}.tsx`)
    const input = candidates(paths)
    const started = performance.now()
    const { complete, results } = await rankFuzzyPaths('modcomp', input, { limit: 50 })
    const elapsed = performance.now() - started
    expect(complete).toBe(true)
    expect(results.length).toBe(50)
    expect(elapsed).toBeLessThan(200)
  })
})

describe('searchWorkspacePaths ordering', () => {
  it('lists files before folders on equal scores', async () => {
    const result = await searchWorkspacePaths(snapshot(['docs'], ['docs']), 'docs', { limit: 5 })
    expect(result.results.map((entry) => entry.kind)).toEqual(['file', 'directory'])
  })

  it('puts folders first when the query ends with a slash', async () => {
    const result = await searchWorkspacePaths(
      snapshot(['src/index.ts', 'src/util/helpers.ts'], ['src', 'src/util']),
      'src/',
      { limit: 10 }
    )
    const kinds = result.results.map((entry) => entry.kind)
    expect(kinds[0]).toBe('directory')
    expect(kinds.lastIndexOf('directory')).toBeLessThan(kinds.indexOf('file'))
    expect(result.results[0].path).toBe('src')
  })
})
