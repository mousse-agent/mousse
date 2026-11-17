/**
 * The threads a piece of owned work belongs to: what a delete reads to tell another thread's work from work that touches
 * the deleted thread. A request is counted under its threads only when it names nothing beyond them.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalPathAsync, canonicalPathSync, pathsOverlap } from '../src/mms/lifecycle/canonicalPath'
import { OwnedWorkBarrier } from '../src/mms/execution/OwnedWorkBarrier'
import { currentWorkScope, requestWorkScope, threadScope } from '../src/mms/execution/workScope'

/** The threads this computer knows in these cases. */
const known = new Set(['a', 'b'])
const isThread = (id: string): boolean => known.has(id)

describe('a request\'s scope', () => {
  it('is its threads when it names only threads', () => {
    expect(requestWorkScope({ threadId: 'a', content: 'hello', conversationBranchId: 'b1', images: [{ data: 'x', mimeType: 'image/png' }] }, isThread)).toEqual({ threadIds: ['a'] })
    expect(requestWorkScope({ threadIds: ['a', 'b'], profileId: 'p' }, isThread)).toEqual({ threadIds: ['a', 'b'] })
    // Every thread it names counts, at any depth.
    expect(requestWorkScope({ threadId: 'a', target: { parentThreadId: 'b' } }, isThread)).toEqual({ threadIds: ['a', 'b'] })
  })

  it('is the profile\'s when it names a project, a folder, a repository, a worktree or a file', () => {
    for (const params of [
      { threadId: 'a', path: '/x' },
      { threadId: 'a', projectId: 'p1' },
      { threadId: 'a', options: { cwd: '/x' } },
      { threadId: 'a', repositoryId: 'r' },
      { threadId: 'a', worktreePath: '/x' },
      { threadId: 'a', files: ['a.txt'] },
      { threadId: 'a', workTree: '/x' }
    ]) expect(requestWorkScope(params, isThread)).toBeNull()
  })

  it('is the profile\'s when it names no thread, or one that is not a name', () => {
    expect(requestWorkScope(undefined, isThread)).toBeNull()
    expect(requestWorkScope({}, isThread)).toBeNull()
    expect(requestWorkScope({ name: 'x' }, isThread)).toBeNull()
    expect(requestWorkScope({ threadId: 42 }, isThread)).toBeNull()
    expect(threadScope('__unbound__')).toBeNull()
  })

  it('is the profile\'s when it names an id that is not a thread of this computer, never the scope of the threads it does know', () => {
    const asked: string[] = []
    const lookup = (id: string): boolean => { asked.push(id); return isThread(id) }
    for (const params of [
      // A project terminal's requests, sent before it has a thread.
      { threadId: '__unbound__' },
      { threadIds: ['a', '__unbound__'] },
      // A chat's task id, and a thread of another computer.
      { taskId: 'rpc_9f2c41' },
      { threadId: 'thread-of-another-computer' },
      // Named together with a thread of this computer, it still reaches beyond that thread.
      { threadIds: ['a', 'rpc_9f2c41'] },
      { threadId: 'a', target: { parentThreadId: 'thread-of-another-computer' } }
    ]) expect(requestWorkScope(params, lookup)).toBeNull()
    // `__unbound__` is never a thread, whatever the lookup says.
    expect(asked).not.toContain('__unbound__')
    expect(requestWorkScope({ threadId: '__unbound__' }, () => true)).toBeNull()
  })
})

describe('owned work', () => {
  it('belongs to the work that started it unless it names its own threads', async () => {
    const barrier = new OwnedWorkBarrier()
    let release = () => {}
    const hold = new Promise<void>((resolve) => { release = resolve })
    const seen: unknown[] = []
    const outer = barrier.run('turn', async () => {
      seen.push(currentWorkScope())
      // A call the turn makes is the turn's thread's; one that names the profile is the profile's.
      const inner = barrier.run('mcp-call', () => hold)
      const shared = barrier.run('mcp-connect', () => hold, null)
      const other = barrier.run('send', () => hold, threadScope('b'))
      await Promise.all([inner, shared, other])
    }, threadScope('a'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toEqual([{ threadIds: ['a'] }])
    expect(barrier.entries().map((entry) => [entry.label, entry.scope])).toEqual([
      ['turn', { threadIds: ['a'] }], ['mcp-call', { threadIds: ['a'] }], ['mcp-connect', null], ['send', { threadIds: ['b'] }]
    ])
    // A wait can leave out work by its threads.
    const waited = barrier.waitForIdle(1_000, (_label, scope) => scope === null)
    release()
    await outer
    await waited
    expect(barrier.count).toBe(0)
    expect(currentWorkScope()).toBeNull()
  })
})

describe('the paths a delete compares', () => {
  it('resolve links through the nearest folder that exists, also for a path that is not there yet', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'work-scope-')))
    try {
      mkdirSync(join(root, 'real'))
      symlinkSync(join(root, 'real'), join(root, 'link'), 'dir')
      const missing = join(root, 'link', 'missing', 'deeper')
      expect(canonicalPathSync(missing)).toBe(join(root, 'real', 'missing', 'deeper'))
      expect(canonicalPathSync(missing)).toBe(await canonicalPathAsync(missing))
      expect(pathsOverlap(canonicalPathSync(missing), canonicalPathSync(join(root, 'real')))).toBe(true)
      // On macOS `/tmp` links to `/private/tmp`.
      if (process.platform === 'darwin') expect(canonicalPathSync(join('/tmp', `missing-${process.pid}`, 'child'))).toBe(join('/private/tmp', `missing-${process.pid}`, 'child'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
