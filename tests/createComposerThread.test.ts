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
  function setup(over: { devices?: Device[]; answers?: Record<string, unknown>; visible?: () => boolean } = {}) {
    const calls: Array<{ method: string; params: any }> = []
    const answers: Record<string, unknown> = {
      'bridge.hub.create': { thread: { id: 'remote-thread' } },
      'bridge.hub.setModel': { ok: true },
      'bridge.hub.attach': { ref: { nodeId: node, entityId: 'remote-thread' } },
      'bridge.hub.stageAttachment': { ok: true },
      'bridge.hub.send': { text: 'done' },
      ...over.answers
    }
    const request = vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      const answer = answers[method]
      if (answer instanceof Error) throw answer
      return answer
    })
    const open = vi.fn()
    const deps = {
      node,
      devices: async () => over.devices ?? [device()],
      projectId: 'project-there',
      worktreeEnabled: true,
      content: 'Fix the parser\nwith care',
      images: [] as Array<{ name: string; mimeType: string; data: string }>,
      request: request as never,
      stillVisible: over.visible ?? (() => true),
      openRemoteThread: open,
      uploadId: (() => { let n = 0; return () => `upload-${++n}-padding` })()
    }
    return { deps, calls, open, request }
  }

  it('creates the thread, attaches to it, then sends, and opens the remote thread', async () => {
    const { deps, calls, open } = setup()
    const started = await startRemoteComposerThread(deps)
    expect(calls.map((call) => call.method)).toEqual(['bridge.hub.create', 'bridge.hub.attach', 'bridge.hub.send'])
    expect(calls[0].params).toEqual({
      target: node, name: 'Fix the parser', projectId: 'project-there', options: { worktreeEnabled: true }
    })
    const ref = { nodeId: node, entityId: 'remote-thread' }
    expect(calls[1].params).toEqual({ ref })
    expect(calls[2].params).toMatchObject({ ref, content: 'Fix the parser\nwith care' })
    // A turn can last hours, so the send asks for the longest deadline the hub allows.
    expect(calls[2].params.options.deadlineMs).toBe(86_400_000)
    expect(started).toMatchObject({ ref, deviceName: 'Studio' })
    expect(open).toHaveBeenCalledWith({ ...ref, deviceName: 'Studio', title: 'Fix the parser' })
    await expect(started!.sent).resolves.toBeUndefined()
  })

  it('creates a project-less chat without a worktree, whatever the toggle says', async () => {
    const { deps, calls } = setup()
    await startRemoteComposerThread({ ...deps, projectId: undefined })
    expect(calls[0].params).toEqual({ target: node, name: 'Fix the parser', options: { worktreeEnabled: false } })
  })

  it('stages each image in slices before the thread is created and names them in the send', async () => {
    const { deps, calls } = setup()
    const big = 'A'.repeat(48 * 1024 * 2 + 10)
    await startRemoteComposerThread({
      ...deps,
      images: [{ name: 'a.png', mimeType: 'image/png', data: big }, { name: 'b.png', mimeType: 'image/png', data: 'QUJD' }],
      mode: 'plan'
    })
    expect(calls.map((call) => call.method)).toEqual([
      'bridge.hub.stageAttachment', 'bridge.hub.stageAttachment', 'bridge.hub.stageAttachment', 'bridge.hub.stageAttachment',
      'bridge.hub.create', 'bridge.hub.attach', 'bridge.hub.send'
    ])
    expect(calls.slice(0, 3).map((call) => [call.params.upload, call.params.index, call.params.total, call.params.data.length]))
      .toEqual([['upload-1-padding', 0, 3, 49152], ['upload-1-padding', 1, 3, 49152], ['upload-1-padding', 2, 3, 10]])
    expect(calls[3].params).toMatchObject({ upload: 'upload-2-padding', index: 0, total: 1, name: 'b.png', mimeType: 'image/png', data: 'QUJD' })
    expect(calls[6].params).toMatchObject({ mode: 'plan', attachments: ['upload-1-padding', 'upload-2-padding'] })
  })

  it('stops before creating anything when the target refuses an image', async () => {
    const { deps, calls, open } = setup({ answers: { 'bridge.hub.stageAttachment': { ok: false, error: 'The image is too large.' } } })
    await expect(startRemoteComposerThread({ ...deps, images: [{ name: 'a.png', mimeType: 'image/png', data: 'QUJD' }] }))
      .rejects.toThrow('The image is too large.')
    expect(calls.map((call) => call.method)).toEqual(['bridge.hub.stageAttachment'])
    expect(open).not.toHaveBeenCalled()
  })

  it('stamps the picked model on the new thread before attaching, from the target\'s own list', async () => {
    const { deps, calls } = setup()
    await startRemoteComposerThread({ ...deps, model: { instanceId: 'codex', llmProvider: 'openai', model: 'gpt-x' } })
    expect(calls.map((call) => call.method)).toEqual(['bridge.hub.create', 'bridge.hub.setModel', 'bridge.hub.attach', 'bridge.hub.send'])
    expect(calls[1].params).toEqual({
      ref: { nodeId: node, entityId: 'remote-thread' },
      model: { instanceId: 'codex', llmProvider: 'openai', model: 'gpt-x' }
    })
    const refused = setup({ answers: { 'bridge.hub.setModel': { ok: false, error: 'That model is not available.' } } })
    await expect(startRemoteComposerThread({ ...refused.deps, model: { instanceId: 'x', model: 'y' } })).rejects.toThrow('That model is not available.')
    expect(refused.calls.map((call) => call.method)).toEqual(['bridge.hub.create', 'bridge.hub.setModel'])
    expect(refused.open).not.toHaveBeenCalled()
  })

  it('refuses too many or too large images before staging anything', async () => {
    const many = setup()
    const image = { name: 'a.png', mimeType: 'image/png', data: 'QUJD' }
    await expect(startRemoteComposerThread({ ...many.deps, images: Array.from({ length: 17 }, () => image) })).rejects.toThrow('Attach up to 16 images')
    const large = setup()
    await expect(startRemoteComposerThread({ ...large.deps, images: [{ ...image, data: 'A'.repeat(3 * 1024 * 1024 + 4) }] })).rejects.toThrow('too large')
    expect(many.calls).toEqual([])
    expect(large.calls).toEqual([])
  })

  it('passes only modes the target knows, and skill modes as they are', async () => {
    const plain = setup()
    await startRemoteComposerThread({ ...plain.deps, mode: 'unknown-mode' })
    expect(plain.calls[2].params).not.toHaveProperty('mode')
    const skill = setup()
    await startRemoteComposerThread({ ...skill.deps, mode: { type: 'skill', skillId: 's1' } })
    expect(skill.calls[2].params.mode).toEqual({ type: 'skill', skillId: 's1' })
  })

  it('refuses a computer that is not connected before touching it, and names it', async () => {
    for (const devices of [[device({ state: 'closed' })], [device({ kind: 'phone' })], [device({ revoked: true })], []]) {
      const { deps, calls, open } = setup({ devices })
      const error = await startRemoteComposerThread(deps).catch((cause) => cause)
      expect(error).toBeInstanceOf(RemoteNotConnectedError)
      expect(calls).toEqual([])
      expect(open).not.toHaveBeenCalled()
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
    expect(mid.request.mock.calls.map(([method]) => method)).toEqual(['bridge.hub.create'])
  })

  it('does not send when the thread cannot be created or attached', async () => {
    const created = setup({ answers: { 'bridge.hub.create': {} } })
    await expect(startRemoteComposerThread(created.deps)).rejects.toThrow('Studio did not create the chat')
    const attached = setup({ answers: { 'bridge.hub.attach': new Error('offline') } })
    await expect(startRemoteComposerThread(attached.deps)).rejects.toThrow('offline')
    expect(attached.calls.map((call) => call.method)).toEqual(['bridge.hub.create', 'bridge.hub.attach'])
    expect(attached.open).not.toHaveBeenCalled()
  })

  it('reports the target\'s refusal of the first message through the send result', async () => {
    const { deps } = setup({ answers: { 'bridge.hub.send': { text: '', error: 'That skill is not available.' } } })
    const started = await startRemoteComposerThread(deps)
    await expect(started!.sent).resolves.toBe('That skill is not available.')
  })

  it('names the thread after the first line, or a default', () => {
    expect(remoteThreadName('  Hello there\nmore')).toBe('Hello there')
    expect(remoteThreadName('x'.repeat(200))).toHaveLength(80)
    expect(remoteThreadName('   ')).toBe('New chat')
  })
})
