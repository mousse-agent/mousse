// What a scheduled job may ask for: its model, mode and workspace, checked against the profile.
import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { findWorktreeOwner, validateScheduledJobOptions, type ScheduledJobOptionsDeps } from '../src/mms/scheduled/validateJobOptions'
import type { Thread } from '../src/shared/types'
import type { ThreadWorkspaceMetadata } from '../src/shared/workspace'

const thread = (id: string, extra: Partial<Thread> = {}): Thread => ({
  id, name: id, projectId: 'p1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', order: 0, ...extra
})
const workspace = (threadId: string, worktreePath: string, lifecycle: ThreadWorkspaceMetadata['lifecycle'] = 'ready'): ThreadWorkspaceMetadata =>
  ({ schemaVersion: 1, threadId, worktreePath, lifecycle }) as ThreadWorkspaceMetadata

const WORKTREE = resolve('repo-worktrees', 'threads', 'owner', 'main')

function deps(overrides: Partial<ScheduledJobOptionsDeps> = {}): ScheduledJobOptionsDeps {
  const threads = [thread('owner'), thread('other'), thread('standalone', { projectId: undefined })]
  const workspaces: Record<string, ThreadWorkspaceMetadata> = { owner: workspace('owner', WORKTREE), other: workspace('other', resolve('elsewhere')) }
  return {
    overrideFor: (input) => ({ instanceId: input.instanceId ?? 'pi-anthropic', llmProvider: 'anthropic', model: input.model }),
    resolveStored: () => ({}),
    getProject: (id) => (id === 'p1' ? { id, path: resolve('repo') } : undefined),
    getThread: (id) => threads.find((entry) => entry.id === id),
    listProjectThreads: (projectId) => threads.filter((entry) => entry.projectId === projectId),
    loadWorkspace: (id) => workspaces[id],
    isGitBacked: () => true,
    ...overrides
  }
}

describe('scheduled job selection', () => {
  it('stores the selection as the profile resolves it and resolves it for the schedule purpose in the job\'s scope', () => {
    const resolveStored = vi.fn(() => ({}))
    const checked = validateScheduledJobOptions(
      { projectId: 'p1', selection: { instanceId: 'codex', llmProvider: '', model: 'gpt-x' } },
      deps({ resolveStored, overrideFor: (input) => ({ instanceId: input.instanceId, llmProvider: 'codex', model: input.model }) })
    )
    expect(checked.selection).toEqual({ instanceId: 'codex', llmProvider: 'codex', model: 'gpt-x' })
    expect(resolveStored).toHaveBeenCalledWith(checked.selection, { purpose: 'schedule', scope: { kind: 'project', projectId: 'p1' } })
    validateScheduledJobOptions({ selection: { llmProvider: 'anthropic', model: 'm' } }, deps({ resolveStored }))
    expect(resolveStored).toHaveBeenLastCalledWith(expect.anything(), { purpose: 'schedule', scope: { kind: 'device' } })
  })

  it('takes the scope from the bound thread\'s project', () => {
    const resolveStored = vi.fn(() => ({}))
    validateScheduledJobOptions({ threadId: 'owner', selection: { llmProvider: 'anthropic', model: 'm' } }, deps({ resolveStored }))
    expect(resolveStored).toHaveBeenCalledWith(expect.anything(), { purpose: 'schedule', scope: { kind: 'project', projectId: 'p1' } })
  })

  it('refuses an unknown instance, a hidden model and an instance that approves tools itself', () => {
    const selection = { instanceId: 'gone', llmProvider: '', model: 'm' }
    expect(() => validateScheduledJobOptions({ selection }, deps({ overrideFor: () => { throw new Error('Unknown provider instance: gone') } }))).toThrow(/Unknown provider instance/)
    expect(() => validateScheduledJobOptions({ selection }, deps({ resolveStored: () => { throw new Error('model hidden') } }))).toThrow(/model hidden/)
    expect(() => validateScheduledJobOptions({ selection }, deps({ resolveStored: () => { throw new Error('approves tools itself') } }))).toThrow(/approves tools itself/)
    expect(() => validateScheduledJobOptions({ selection: { instanceId: 'x', llmProvider: '', model: ' ' } }, deps())).toThrow(/model is required/)
  })

  it('accepts only agent and plan modes', () => {
    expect(() => validateScheduledJobOptions({ mode: 'agent' }, deps())).not.toThrow()
    expect(() => validateScheduledJobOptions({ mode: 'plan' }, deps())).not.toThrow()
    expect(() => validateScheduledJobOptions({ mode: 'build' as never }, deps())).toThrow(/mode must be/)
  })
})

describe('scheduled job workspace', () => {
  it('accepts a job with no workspace, with or without a thread', () => {
    expect(validateScheduledJobOptions({}, deps())).toEqual({})
    expect(validateScheduledJobOptions({ threadId: 'owner' }, deps())).toEqual({})
  })

  it('needs a project for every named workspace', () => {
    expect(() => validateScheduledJobOptions({ workspace: { kind: 'project' } }, deps())).toThrow(/needs a project/)
    expect(() => validateScheduledJobOptions({ workspace: { kind: 'newWorktree' } }, deps())).toThrow(/needs a project/)
    expect(validateScheduledJobOptions({ projectId: 'p1', workspace: { kind: 'project' } }, deps())).toEqual({})
  })

  it('refuses a workspace on a job bound to a thread, except an existing worktree', () => {
    expect(() => validateScheduledJobOptions({ projectId: 'p1', threadId: 'owner', workspace: { kind: 'project' } }, deps())).toThrow(/bound to a thread/)
    expect(() => validateScheduledJobOptions({ projectId: 'p1', threadId: 'owner', workspace: { kind: 'newWorktree' } }, deps())).toThrow(/bound to a thread/)
  })

  it('needs a Git project for a new worktree and never provisions one for plan mode', () => {
    expect(validateScheduledJobOptions({ projectId: 'p1', workspace: { kind: 'newWorktree' } }, deps())).toEqual({})
    expect(() => validateScheduledJobOptions({ projectId: 'p1', workspace: { kind: 'newWorktree' } }, deps({ isGitBacked: () => false }))).toThrow(/Git repository/)
    expect(() => validateScheduledJobOptions({ projectId: 'p1', mode: 'plan', workspace: { kind: 'newWorktree' } }, deps())).toThrow(/plan-mode job never provisions/)
    expect(() => validateScheduledJobOptions({ projectId: 'missing', workspace: { kind: 'newWorktree' } }, deps())).toThrow(/Project not found/)
  })

  it('resolves an existing worktree to the thread that owns it', () => {
    expect(validateScheduledJobOptions({ projectId: 'p1', workspace: { kind: 'worktree', path: WORKTREE } }, deps())).toEqual({ threadId: 'owner' })
    // The job may already name the owner.
    expect(validateScheduledJobOptions({ projectId: 'p1', threadId: 'owner', workspace: { kind: 'worktree', path: WORKTREE } }, deps())).toEqual({ threadId: 'owner' })
    expect(() => validateScheduledJobOptions({ projectId: 'p1', threadId: 'other', workspace: { kind: 'worktree', path: WORKTREE } }, deps())).toThrow(/different thread/)
  })

  it('compares worktree paths by their canonical form', () => {
    const variant = process.platform === 'win32'
      ? WORKTREE.replace(/\\/g, '/').toUpperCase()
      : WORKTREE + '/../main/'
    expect(validateScheduledJobOptions({ projectId: 'p1', workspace: { kind: 'worktree', path: variant } }, deps())).toEqual({ threadId: 'owner' })
  })

  it('refuses a worktree no thread of the project owns, or one that is not ready', () => {
    expect(() => validateScheduledJobOptions({ projectId: 'p1', workspace: { kind: 'worktree', path: resolve('nowhere') } }, deps())).toThrow(/No thread in this project/)
    expect(() => validateScheduledJobOptions({ projectId: 'p1', workspace: { kind: 'worktree', path: WORKTREE } }, deps({ loadWorkspace: (id) => workspace(id, WORKTREE, 'missing') }))).toThrow(/No thread in this project/)
    expect(() => validateScheduledJobOptions({ projectId: 'p1', workspace: { kind: 'worktree', path: ' ' } }, deps())).toThrow(/path is required/)
    expect(() => validateScheduledJobOptions({ workspace: { kind: 'worktree', path: WORKTREE } }, deps())).toThrow(/needs a project/)
  })

  it('only finds an owner among the threads it is given, skipping settled and unreadable ones', () => {
    const load = (id: string): ThreadWorkspaceMetadata | undefined => {
      if (id === 'broken') throw new Error('unreadable workspace.json')
      return workspace(id, WORKTREE)
    }
    expect(findWorktreeOwner([thread('broken'), thread('settled', { settledAt: '2026-01-02T00:00:00.000Z' }), thread('live')], WORKTREE, load)?.id).toBe('live')
    expect(findWorktreeOwner([], WORKTREE, load)).toBeUndefined()
  })
})
