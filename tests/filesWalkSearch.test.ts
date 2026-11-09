import { describe, expect, it } from 'vitest'
import { walkMatch, walkSearch, type WalkSearchProgress } from '../src/renderer/components/filesWalkSearch'
import type { FileEntry } from '../src/shared/types'

/** A folder tree as `files.list` answers it: entries named relative to the walked folder. */
function fakeDisk(tree: Record<string, string[]>) {
  const listed: string[] = []
  const list = async (dir: string): Promise<FileEntry[]> => {
    listed.push(dir)
    const names = tree[dir]
    if (!names) throw new Error(`ENOENT: ${dir}`)
    return names.map((name) => {
      const folder = name.endsWith('/')
      const clean = folder ? name.slice(0, -1) : name
      return { name: clean, path: dir ? `${dir}/${clean}` : clean, kind: folder ? 'directory' : 'file' }
    })
  }
  return { list, listed }
}

const run = (query: string, list: (dir: string) => Promise<FileEntry[]>, over: Partial<Parameters<typeof walkSearch>[0]> = {}) => {
  const reports: WalkSearchProgress[] = []
  const controller = new AbortController()
  const done = walkSearch({ query, list, signal: controller.signal, onProgress: (report) => reports.push(report), ...over })
  return { done, reports, controller }
}

describe('searching a folder without an index (a walk)', () => {
  it('finds files by name breadth first, best match first, skipping heavy and hidden folders', async () => {
    const disk = fakeDisk({
      '': ['docs/', 'node_modules/', '.git/', '.cache/', 'notes.md', 'old-notes.txt'],
      docs: ['deep/', 'Notes.md', 'meeting-notes.md'],
      'docs/deep': ['notes.md']
    })
    const { done } = run('notes', disk.list)
    const result = await done
    expect(result?.done).toBe(true)
    expect(result?.capped).toBe(false)
    expect(result?.results.map((r) => r.path)).toEqual(['notes.md', 'docs/Notes.md', 'docs/deep/notes.md', 'old-notes.txt', 'docs/meeting-notes.md'])
    expect(disk.listed).not.toContain('node_modules')
    expect(disk.listed).not.toContain('.git')
    expect(disk.listed).not.toContain('.cache')
  })

  it('stops at the entry cap and says there may be more', async () => {
    const disk = fakeDisk({ '': Array.from({ length: 50 }, (_, i) => `file${i}.ts`) })
    const result = await run('file', disk.list, { maxEntries: 10 }).done
    expect(result?.capped).toBe(true)
    expect(result?.results.length).toBeLessThanOrEqual(10)
  })

  it('stops at the depth limit', async () => {
    const disk = fakeDisk({ '': ['a/'], a: ['b/'], 'a/b': ['c/'], 'a/b/c': ['target.ts'] })
    const result = await run('target', disk.list, { maxDepth: 2 }).done
    expect(result?.results).toEqual([])
    expect(result?.capped).toBe(true)
    expect(disk.listed).not.toContain('a/b/c')
  })

  it('leaves out a folder that does not answer in time, and never hangs on it', async () => {
    const list = async (dir: string): Promise<FileEntry[]> => {
      if (dir === 'net') return new Promise(() => {})
      return dir === '' ? [{ name: 'net', path: 'net', kind: 'directory' }, { name: 'here.md', path: 'here.md', kind: 'file' }] : []
    }
    const result = await run('here', list, { folderTimeoutMs: 20 }).done
    expect(result?.results.map((r) => r.path)).toEqual(['here.md'])
    expect(result?.skipped).toBe(1)
  })

  it('fails when the folder itself cannot be read, with the daemon’s reason', async () => {
    const list = async (): Promise<FileEntry[]> => { throw new Error('The drive or folder at Z:\\ is not answering') }
    await expect(run('x', list).done).rejects.toThrow(/not answering/)
  })

  it('stops listing and reports nothing more once cancelled', async () => {
    let calls = 0
    const list = async (dir: string): Promise<FileEntry[]> => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return [{ name: `d${calls}`, path: `${dir ? `${dir}/` : ''}d${calls}`, kind: 'directory' }]
    }
    const { done, reports, controller } = run('zzz', list)
    await new Promise((resolve) => setTimeout(resolve, 12))
    controller.abort()
    expect(await done).toBeNull()
    const after = calls
    const reported = reports.length
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toBe(after)
    expect(reports.length).toBe(reported)
  })

  it('matches a loose spelling of the name, and folders only for a query with a slash', () => {
    expect(walkMatch('cmpsr', 'src/ChatComposer.tsx')?.positions).toEqual([4, 10, 11, 13, 15])
    expect(walkMatch('src', 'src/app.ts')).toBeNull()
    expect(walkMatch('src/app', 'src/app.ts')?.positions).toEqual([0, 1, 2, 3, 4, 5, 6])
  })
})
