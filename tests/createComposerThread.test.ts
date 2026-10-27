import { describe, expect, it, vi } from 'vitest'
import type { Thread } from '../src/shared/types'
import {
  RemoteNotConnectedError,
  createComposerThread,
  prepareComposerThread,
  remoteThreadName,
  startRemoteComposerThread
} from '../src/renderer/lib/createComposerThread'
import type { Device } from '../src/renderer/lib/netDevices'

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

describe('composer thread on another computer', () => {
  const node = 'node-studio' as Device['node']
  const device = (patch: Partial<Device> = {}): Device => ({
    node, name: 'Studio', caps: ['read', 'write', 'chat'], keyEpoch: 1, expiresAt: 0,
    self: false, revoked: false, state: 'open', kind: 'computer', ...patch
  })
  const ref = { nodeId: node, entityId: 'remote-thread' }
  function setup(over: { devices?: Device[]; answers?: Record<string, unknown>; visible?: () => boolean; problem?: string } = {}) {
    const calls: Array<{ method: string; params: any }> = []
    const order: string[] = []
    const answers: Record<string, unknown> = {
      'bridge.hub.create': { thread: { id: 'remote-thread' } },
      'bridge.hub.setModel': { ok: true },
      ...over.answers
    }
    const request = vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      order.push(method)
      const answer = answers[method]
      if (answer instanceof Error) throw answer
      return answer
    })
    const open = vi.fn(() => { order.push('open') })
    const submit = vi.fn(async () => { order.push('submit') })
    const deps = {
      node,
      devices: async () => over.devices ?? [device()],
      projectId: 'project-there',
      worktreeEnabled: true,
      content: 'Fix the parser\nwith care',
      images: [] as Array<{ name: string; mimeType: string; data: string }>,
      imageProblem: () => over.problem ?? '',
      request: request as never,
      stillVisible: over.visible ?? (() => true),
      openRemoteThread: open,
      submit
    }
    return { deps, calls, order, open, submit, request }
  }

  it('creates the thread, opens it in the remote thread view, and sends the first message through it', async () => {
    const { deps, calls, order, open, submit } = setup()
    const started = await startRemoteComposerThread(deps)
    expect(calls.map((call) => call.method)).toEqual(['bridge.hub.create'])
    expect(calls[0].params).toEqual({
      target: node, name: 'Fix the parser', projectId: 'project-there', options: { worktreeEnabled: true }
    })
    // Opening attaches to the display; the message follows it.
    expect(order).toEqual(['bridge.hub.create', 'open', 'submit'])
    expect(open).toHaveBeenCalledWith({ ...ref, deviceName: 'Studio', title: 'Fix the parser' })
    expect(submit).toHaveBeenCalledWith(ref, { content: 'Fix the parser\nwith care', images: [] })
    expect(started).toMatchObject({ ref, deviceName: 'Studio' })
    await expect(started!.sent).resolves.toBeUndefined()
  })

  it('creates a project-less chat without a worktree, whatever the toggle says', async () => {
    const { deps, calls } = setup()
    await startRemoteComposerThread({ ...deps, projectId: undefined })
    expect(calls[0].params).toEqual({ target: node, name: 'Fix the parser', options: { worktreeEnabled: false } })
  })

  it('hands images to the view for staging and refuses the ones the target cannot take before creating anything', async () => {
    const image = { name: 'a.png', mimeType: 'image/png', data: 'QUJD' }
    const ok = setup()
    await startRemoteComposerThread({ ...ok.deps, images: [image] })
    expect(ok.submit).toHaveBeenCalledWith(ref, { content: 'Fix the parser\nwith care', images: [image] })
    const refused = setup({ problem: 'a.png is too large.' })
    await expect(startRemoteComposerThread({ ...refused.deps, images: [image] })).rejects.toThrow('a.png is too large.')
    expect(refused.calls).toEqual([])
    expect(refused.open).not.toHaveBeenCalled()
  })

  it('stamps the picked model on the new thread before the thread opens', async () => {
    const { deps, calls, order } = setup()
    await startRemoteComposerThread({ ...deps, model: { instanceId: 'codex', llmProvider: 'openai', model: 'gpt-x' } })
    expect(order).toEqual(['bridge.hub.create', 'bridge.hub.setModel', 'open', 'submit'])
    expect(calls[1].params).toEqual({ ref, model: { instanceId: 'codex', llmProvider: 'openai', model: 'gpt-x' } })
    const refused = setup({ answers: { 'bridge.hub.setModel': { ok: false, error: 'That model is not available.' } } })
    await expect(startRemoteComposerThread({ ...refused.deps, model: { instanceId: 'x', model: 'y' } })).rejects.toThrow('That model is not available.')
    expect(refused.open).not.toHaveBeenCalled()
    expect(refused.submit).not.toHaveBeenCalled()
  })

  it('passes a skill mode to the view and drops the built-in modes', async () => {
    const plain = setup()
    await startRemoteComposerThread({ ...plain.deps, mode: 'plan' })
    expect(plain.submit.mock.calls[0]).toEqual([ref, { content: 'Fix the parser\nwith care', images: [] }])
    const skill = setup()
    await startRemoteComposerThread({ ...skill.deps, mode: { type: 'skill', skillId: 's1' } as never })
    expect((skill.submit.mock.calls[0] as unknown[])[1]).toMatchObject({ mode: { type: 'skill', skillId: 's1' } })
  })

  it('refuses a computer that is not connected before touching it, and names it', async () => {
    for (const devices of [[device({ state: 'closed' })], [device({ kind: 'phone' })], [device({ revoked: true })], []]) {
      const { deps, calls, open, submit } = setup({ devices })
      const error = await startRemoteComposerThread(deps).catch((cause) => cause)
      expect(error).toBeInstanceOf(RemoteNotConnectedError)
      expect(calls).toEqual([])
      expect(open).not.toHaveBeenCalled()
      expect(submit).not.toHaveBeenCalled()
    }
    const { deps } = setup({ devices: [device({ state: 'closed' })] })
    await expect(startRemoteComposerThread(deps)).rejects.toThrow('Studio is not connected')
  })

  it('does nothing when the user moved on first, and does not open an abandoned thread', async () => {
    const early = setup({ visible: () => false })
    expect(await startRemoteComposerThread(early.deps)).toBeNull()
    expect(early.calls).toEqual([])
    let visible = true
    const mid = setup({ visible: () => visible })
    mid.request.mockImplementation(async (method: string) => {
      if (method === 'bridge.hub.create') { visible = false; return { thread: { id: 'remote-thread' } } }
      return {}
    })
    expect(await startRemoteComposerThread(mid.deps)).toBeNull()
    expect(mid.open).not.toHaveBeenCalled()
    expect(mid.submit).not.toHaveBeenCalled()
    expect(mid.request.mock.calls.map(([method]) => method)).toEqual(['bridge.hub.create'])
  })

  it('does not open or send when the thread cannot be created', async () => {
    const created = setup({ answers: { 'bridge.hub.create': {} } })
    await expect(startRemoteComposerThread(created.deps)).rejects.toThrow('Studio did not create the chat')
    const failed = setup({ answers: { 'bridge.hub.create': new Error('offline') } })
    await expect(startRemoteComposerThread(failed.deps)).rejects.toThrow('offline')
    expect(failed.open).not.toHaveBeenCalled()
    expect(failed.submit).not.toHaveBeenCalled()
  })

  it('names the thread after the first line, or a default', () => {
    expect(remoteThreadName('  Hello there\nmore')).toBe('Hello there')
    expect(remoteThreadName('x'.repeat(200))).toHaveLength(80)
    expect(remoteThreadName('   ')).toBe('New chat')
  })
})
