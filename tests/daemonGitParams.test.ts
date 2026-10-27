import { describe, expect, it } from 'vitest'
import { daemonGitParams } from '../src/main/ipc/daemonGitParams'

describe('daemonGitParams', () => {
  it('names the thread when the folder is its own worktree, and never also the project', () => {
    expect(daemonGitParams({ projectId: 'p1', workspaceThreadId: 't1' }, { branch: 'dev' })).toEqual({ threadId: 't1', branch: 'dev' })
  })

  it('names the project for any other folder', () => {
    expect(daemonGitParams({ projectId: 'p1', workspaceThreadId: null }, { message: 'm' })).toEqual({ message: 'm', projectId: 'p1' })
  })

  it('ignores anything in the scope that is not a string id, and lets the daemon refuse the empty request', () => {
    const params = daemonGitParams({ projectId: 7, workspaceThreadId: { id: 't1' } } as never)
    expect(params.threadId).toBeUndefined()
    expect(params.projectId).toBeUndefined()
    expect(daemonGitParams(undefined).projectId).toBeUndefined()
  })

  it('does not let the arguments override the scope', () => {
    expect(daemonGitParams({ projectId: 'p1', workspaceThreadId: 't1' }, { threadId: 'other' }).threadId).toBe('t1')
    expect(daemonGitParams({ projectId: 'p1', workspaceThreadId: null }, { projectId: 'other' }).projectId).toBe('p1')
  })
})
