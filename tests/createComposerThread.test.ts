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
      create: vi.fn(async (projectId: string | undefined, opts: { worktreeEnabled: boolean }) => ({ id: 'created', projectId, ...opts } as Thread)),
      setWorktreeEnabled: vi.fn(async (id: string, enabled: boolean) => ({ ...thread, id, worktreeEnabled: enabled } as Thread)),
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
    let visible = true
    deps.stillVisible = () => visible
    deps.setWorktreeEnabled.mockImplementation(async (id, enabled) => {
      visible = false
      return { ...deps.thread, id, worktreeEnabled: enabled } as Thread
    })
    expect(await prepareComposerThread(deps)).toBeNull()
    expect(deps.setWorktreeEnabled).toHaveBeenCalledWith('draft', true)
    expect(deps.update).not.toHaveBeenCalled()
  })

  it('does not start a workspace mutation once the original composer is no longer visible', async () => {
    const deps = setup()
    deps.stillVisible = () => false
    expect(await prepareComposerThread(deps)).toBeNull()
    expect(deps.create).not.toHaveBeenCalled()
    expect(deps.setWorktreeEnabled).not.toHaveBeenCalled()
  })

  it('propagates project-draft creation failure without changing the current draft', async () => {
    const deps = setup({ id: 'old', projectId: 'project-b' } as Thread)
    deps.create.mockRejectedValue(new Error('Disk full'))
    await expect(prepareComposerThread(deps)).rejects.toThrow('Disk full')
    expect(deps.activate).not.toHaveBeenCalled()
    expect(deps.select).not.toHaveBeenCalled()
    expect(deps.update).not.toHaveBeenCalled()
  })

  it('keeps the newly activated project draft available when selection fails', async () => {
    const deps = setup({ id: 'old', projectId: 'project-b' } as Thread)
    deps.select.mockRejectedValue(new Error('Selection unavailable'))
    await expect(prepareComposerThread(deps)).rejects.toThrow('Selection unavailable')
    expect(deps.activate).toHaveBeenCalledWith(expect.objectContaining({ id: 'created', projectId: 'project-a' }))
  })

  it('keeps the draft recoverable when the worktree request fails', async () => {
    const deps = setup({ id: 'draft', projectId: 'project-a' } as Thread)
    deps.setWorktreeEnabled.mockRejectedValue(new Error('Workspace is locked'))
    await expect(prepareComposerThread(deps)).rejects.toThrow('Workspace is locked')
    expect(deps.create).not.toHaveBeenCalled()
    expect(deps.activate).not.toHaveBeenCalled()
  })
})

describe('blank composer thread on another computer', () => {
  const node = 'nod_studio000000000000000000' as never
  const remoteProject = `${node}:project-there`
  function setup(thread?: Thread, workspace: { projectId?: string; worktreeEnabled: boolean; node?: typeof node } = { projectId: remoteProject, worktreeEnabled: true, node }) {
    return {
      thread,
      workspace,
      create: vi.fn(async (projectId: string | undefined, opts: { worktreeEnabled: boolean; node?: string }) => ({ id: `${opts.node ?? ''}:created`, projectId, node: opts.node, ...opts } as Thread)),
      setWorktreeEnabled: vi.fn(async (id: string, enabled: boolean) => ({ ...thread, id, worktreeEnabled: enabled } as Thread)),
      update: vi.fn(), activate: vi.fn(), select: vi.fn(async () => {}), stillVisible: () => true
    }
  }

  it('creates the chat on the picked computer, in its project, and then selects it like any thread', async () => {
    const deps = setup({ id: 'local-draft' } as Thread)
    expect(await prepareComposerThread(deps)).toBe(`${node}:created`)
    expect(deps.create).toHaveBeenCalledWith(remoteProject, { worktreeEnabled: true, node })
    expect(deps.activate).toHaveBeenCalledWith(expect.objectContaining({ node }))
    expect(deps.select).toHaveBeenCalledWith(`${node}:created`)
  })

  it('creates a chat without a project on that computer', async () => {
    const deps = setup(undefined, { worktreeEnabled: true, node })
    await prepareComposerThread(deps)
    expect(deps.create).toHaveBeenCalledWith(undefined, { worktreeEnabled: false, node })
  })

  it('does not send a local empty thread to the other computer, nor the other way round', async () => {
    const local = setup({ id: 'local-draft', projectId: remoteProject } as Thread)
    await prepareComposerThread(local)
    expect(local.create).toHaveBeenCalled()
    const back = setup({ id: `${node}:draft`, node, projectId: 'project-a' } as Thread, { projectId: 'project-a', worktreeEnabled: false })
    await prepareComposerThread(back)
    expect(back.create).toHaveBeenCalledWith('project-a', { worktreeEnabled: false })
  })

  it('reuses an empty chat that is already on the picked computer and in its project', async () => {
    const deps = setup({ id: `${node}:draft`, node, projectId: remoteProject, worktreeEnabled: true } as Thread)
    expect(await prepareComposerThread(deps)).toBe(`${node}:draft`)
    expect(deps.create).not.toHaveBeenCalled()
    expect(deps.setWorktreeEnabled).not.toHaveBeenCalled()
  })

  it('keeps the old chat when the computer refuses the new one', async () => {
    const deps = setup({ id: 'local-draft' } as Thread)
    deps.create.mockRejectedValue(Object.assign(new Error('Studio is offline.'), { code: 'computer_offline' }))
    await expect(prepareComposerThread(deps)).rejects.toThrow('Studio is offline.')
    expect(deps.activate).not.toHaveBeenCalled()
    expect(deps.select).not.toHaveBeenCalled()
  })
})
