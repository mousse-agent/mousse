/**
 * The threads a piece of owned work belongs to: what a delete reads to tell another thread's work from work that touches
 * the deleted thread. A request is counted under its threads only when it names nothing beyond them.
 */
import { describe, expect, it } from 'vitest'
import { OwnedWorkBarrier } from '../src/mms/execution/OwnedWorkBarrier'
import { currentWorkScope, requestWorkScope, threadScope } from '../src/mms/execution/workScope'

describe('a request\'s scope', () => {
  it('is its threads when it names only threads', () => {
    expect(requestWorkScope({ threadId: 'a', content: 'hello', conversationBranchId: 'b1', images: [{ data: 'x', mimeType: 'image/png' }] })).toEqual({ threadIds: ['a'] })
    expect(requestWorkScope({ threadIds: ['a', 'b'], profileId: 'p' })).toEqual({ threadIds: ['a', 'b'] })
    // Every thread it names counts, at any depth.
    expect(requestWorkScope({ threadId: 'a', target: { parentThreadId: 'b' } })).toEqual({ threadIds: ['a', 'b'] })
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
    ]) expect(requestWorkScope(params)).toBeNull()
  })

  it('is the profile\'s when it names no thread, or one that is not a name', () => {
    expect(requestWorkScope(undefined)).toBeNull()
    expect(requestWorkScope({})).toBeNull()
    expect(requestWorkScope({ name: 'x' })).toBeNull()
    expect(requestWorkScope({ threadId: 42 })).toBeNull()
    expect(threadScope('__unbound__')).toBeNull()
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
