import { describe, expect, it, vi } from 'vitest'
import type { Thread } from '../src/shared/types'
import { createComposerThread, prepareComposerThread } from '../src/renderer/lib/createComposerThread'

describe('blank composer thread creation', () => {
  const thread = { id: 'created-thread' } as Thread
  it('creates and activates the exact thread before selecting it for the send', async () => {
    const calls: string[] = []
    const id = await createComposerThread({
      create: async () => { calls.push('create'); return thread },
      stillVisible: () => true,
      activate: (created) => { calls.push(`activate:${created.id}`) },
      select: async (selected) => { calls.push(`select:${selected}`) }
    })
    expect(id).toBe(thread.id)
    expect(calls).toEqual(['create', 'activate:created-thread', 'select:created-thread'])
  })

  it('does not activate or send after the user navigates while creation is pending', async () => {
    const activate = vi.fn()
    const select = vi.fn()
    const id = await createComposerThread({ create: async () => thread, stillVisible: () => false, activate, select })
    expect(id).toBeNull()
    expect(activate).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
  })

  it('does not send if selection completes after another navigation', async () => {
    let visible = true
    const id = await createComposerThread({
      create: async () => thread,
      stillVisible: () => visible,
      activate: vi.fn(),
      select: async () => { visible = false }
    })
    expect(id).toBeNull()
  })

  it('propagates creation failure without changing selection', async () => {
    const activate = vi.fn()
    const select = vi.fn()
    await expect(createComposerThread({
      create: async () => { throw new Error('Disk full') },
      stillVisible: () => true, activate, select
    })).rejects.toThrow('Disk full')
    expect(activate).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
  })
})

describe('blank composer workspace selection', () => {
  function setup(thread?: Thread) {
    return {
      thread,
      workspace: { projectId: 'project-a', worktreeEnabled: true },
      create: vi.fn(async (projectId, opts) => ({ id: 'created', projectId, ...opts } as Thread)),
      setWorktreeEnabled: vi.fn(async (id, enabled) => ({ ...thread, id, worktreeEnabled: enabled } as Thread)),
      update: vi.fn(), activate: vi.fn(), select: vi.fn(async () => {}), stillVisible: () => true
    }
  }

  it('passes the chosen project and worktree into creation before selection', async () => {
    const deps = setup()
    expect(await prepareComposerThread(deps)).toBe('created')
    expect(deps.create).toHaveBeenCalledWith('project-a', { worktreeEnabled: true })
    expect(deps.activate).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-a', worktreeEnabled: true }))
    expect(deps.select).toHaveBeenCalledWith('created')
  })

  it('creates a draft in the chosen project instead of sending to the original project', async () => {
    const deps = setup({ id: 'old', projectId: 'project-b' } as Thread)
    expect(await prepareComposerThread(deps)).toBe('created')
    expect(deps.setWorktreeEnabled).not.toHaveBeenCalled()
  })

  it('updates the existing project draft and waits for its worktree flag', async () => {
    const deps = setup({ id: 'draft', projectId: 'project-a' } as Thread)
    expect(await prepareComposerThread(deps)).toBe('draft')
    expect(deps.setWorktreeEnabled).toHaveBeenCalledWith('draft', true)
    expect(deps.update).toHaveBeenCalledWith(expect.objectContaining({ worktreeEnabled: true }))
    expect(deps.create).not.toHaveBeenCalled()
  })

  it('does not enable an isolated worktree without a project', async () => {
    const deps = { ...setup(), workspace: { projectId: undefined, worktreeEnabled: true } }
    await prepareComposerThread(deps)
    expect(deps.create).toHaveBeenCalledWith(undefined, { worktreeEnabled: false })
  })

  it('leaves an already configured project draft unchanged', async () => {
    const deps = setup({ id: 'draft', projectId: 'project-a', worktreeEnabled: true } as Thread)
    expect(await prepareComposerThread(deps)).toBe('draft')
    expect(deps.create).not.toHaveBeenCalled()
    expect(deps.setWorktreeEnabled).not.toHaveBeenCalled()
  })

  it('does not send or update another view after navigation during the worktree request', async () => {
    const deps = setup({ id: 'draft', projectId: 'project-a' } as Thread)
    deps.stillVisible = () => false
    expect(await prepareComposerThread(deps)).toBeNull()
    expect(deps.update).not.toHaveBeenCalled()
  })

  it('keeps the draft recoverable when the worktree request fails', async () => {
    const deps = setup({ id: 'draft', projectId: 'project-a' } as Thread)
    deps.setWorktreeEnabled.mockRejectedValue(new Error('Workspace is locked'))
    await expect(prepareComposerThread(deps)).rejects.toThrow('Workspace is locked')
    expect(deps.create).not.toHaveBeenCalled()
    expect(deps.activate).not.toHaveBeenCalled()
  })
})
