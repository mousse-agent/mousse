import { describe, expect, it } from 'vitest'
import { lowerPath } from '../src/shared/fuzzyPath'
import type { WorkspaceIndexSnapshot } from '../src/mms/files/WorkspaceIndex'
import { searchWorkspacePaths } from '../src/mms/files/WorkspaceSearch'

const ROOT = process.platform === 'win32' ? 'C:\\repo' : '/repo'

function snapshot(files: string[], folders: string[] = []): WorkspaceIndexSnapshot {
  return {
    root: ROOT,
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

describe('searchWorkspacePaths', () => {
  it('honours limit and kinds', async () => {
    const files = Array.from({ length: 30 }, (_, i) => `src/part${i}.ts`)
    const folders = ['src/parts', 'src/partial']
    const input = snapshot(files, folders)

    const limited = await searchWorkspacePaths(input, 'part', { limit: 5 })
    expect(limited.results).toHaveLength(5)

    const onlyFolders = await searchWorkspacePaths(input, 'part', { limit: 50, kinds: ['directory'] })
    expect(onlyFolders.results.map((entry) => entry.path).sort()).toEqual(['src/partial', 'src/parts'])
    expect(onlyFolders.results.every((entry) => entry.kind === 'directory')).toBe(true)

    const onlyFiles = await searchWorkspacePaths(input, 'part', { limit: 50, kinds: ['file'] })
    expect(onlyFiles.results).toHaveLength(30)
    expect(onlyFiles.results.every((entry) => entry.kind === 'file')).toBe(true)
  })

  it('drops a path that escapes the root', async () => {
    const result = await searchWorkspacePaths(snapshot(['../escape/secret.txt', 'a/../../secret-outside.txt', 'src/secret.txt']), 'secret', { limit: 10 })
    expect(result.results.map((entry) => entry.path)).toEqual(['src/secret.txt'])
  })

  it('reports positions into the returned path', async () => {
    const result = await searchWorkspacePaths(snapshot(['src/components/ChatComposer.tsx']), 'cc', { limit: 5 })
    const [hit] = result.results
    expect(hit.positions.map((at) => hit.path[at].toLowerCase()).join('')).toBe('cc')
  })

  it('does not starve the event loop while ranking 200,000 paths', async () => {
    const files = Array.from({ length: 200_000 }, (_, i) => `packages/pkg${i % 500}/src/module${i % 211}/component${i}.tsx`)
    const input = snapshot(files)
    let last = performance.now()
    let largestGap = 0
    const timer = setInterval(() => {
      const now = performance.now()
      largestGap = Math.max(largestGap, now - last)
      last = now
    }, 10)
    try {
      last = performance.now()
      const result = await searchWorkspacePaths(input, 'modcomp', { limit: 50, budgetMs: 10_000 })
      expect(result.complete).toBe(true)
      expect(result.results).toHaveLength(50)
    } finally {
      clearInterval(timer)
    }
    expect(largestGap).toBeLessThan(50)
  })
})
